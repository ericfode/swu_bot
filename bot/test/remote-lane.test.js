'use strict';
// The ladder's remote lane (bot/remote-lane.js) against a fake relay: an in-memory one through the injected request,
// and once a real HTTP server on loopback. The local runPool is a fake that plays instantly; the clock is fake too,
// so the 3-minute and take-back limits pass in a few hundred ticks. No engine or card data needed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { remoteLane, relayBase, checkDone, request } = require('../remote-lane');
const { gameKey } = require('../rng');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-lane-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const NONCE = 'n0nce_n0nce-n0nce_n0nce-n0nce_n0nce-n0nce';
const BASE = `http://127.0.0.1:8082/r/${NONCE}`;
const RUN_KEY = 'run-key';
const keyOf = (seed) => gameKey(RUN_KEY, seed);
const LIMITS = { maxSteps: 6000, capMs: 60000, hangMs: 150000, gameMs: 840000 };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** A round robin's queue (the seat-swapped pair on each seed), as ladder.js builds it. */
function schedule(pairs, firstSeed = 1) {
    const q = [];
    let seed = firstSeed;
    for (const [a, b] of pairs) {
        q.push({ seed, p1: a, p2: b, id: `${a}-vs-${b}-${seed}` }, { seed, p1: b, p2: a, id: `${b}-vs-${a}-${seed}` });
        seed++;
    }
    return q;
}

/** A finished game's result and replay as play-seed.js sends them (p1 wins). */
function played(game, seed, { key = keyOf(seed), ms = 1000 } = {}) {
    const result = {
        seed, steps: 40, outcome: 'won', winner: game.p1, winnerSeat: 'p1', round: 5, ms, key, by: null, faultKind: null,
        botStats: [null, null], timing: { p1: { n: 20, ms: 100, p50: 1, p95: 9, max: 10 }, p2: { n: 20, ms: 60, p50: 1, p95: 5, max: 6 } }, think: { p1: 90, p2: 50 }
    };
    const replay = [
        { t: 'header', v: 1, seed, engine: null, players: [{ id: 'p1', bot: game.p1 }, { id: 'p2', bot: game.p2 }] },
        { t: 'step', n: 0, label: 'Game start' },
        { t: 'end', winner: 'p1', round: 5, steps: 40, outcome: 'won', error: null, by: null, faultKind: null }
    ].map((e) => JSON.stringify(e)).join('\n') + '\n';
    return { result, replay };
}

/** The done answer for a lease whose job is `job`. */
function doneAnswer(job, change = (x) => x) {
    const results = [];
    const replays = {};
    for (const g of job.games) {
        const p = played(g, job.seed, { key: job.key });
        results.push({ id: g.id, result: p.result });
        replays[g.id] = p.replay;
    }
    return change({ state: 'done', host: 'eric', results, replays });
}

/**
 * The relay's side of section 2, in memory. `waiting` is what status reports; `claims` is how many offers it takes
 * (defaults to waiting). Leases answer `running` until finish() or lose() is called.
 */
function fakeRelay() {
    const r = { waiting: 0, claims: null, hosts: ['eric'], leases: new Map(), bundles: new Map(), offers: [], calls: [], deleted: [], down: false, next: 1 };
    const json = (status, doc) => ({ status, body: Buffer.from(JSON.stringify(doc)) });
    r.request = async (method, url, body) => {
        assert.ok(url.startsWith(BASE), 'every call goes to the base URL');
        const suffix = url.slice(BASE.length);
        r.calls.push(`${method} ${suffix}`);
        if (r.down) {
            throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8082'), { code: 'ECONNREFUSED' });
        }
        if (method === 'GET' && suffix === '/status') {
            return json(200, { waiting: r.waiting, hosts: r.hosts });
        }
        let m = /^\/bundle\/([0-9a-f]{64})$/.exec(suffix);
        if (method === 'PUT' && m) {
            if (sha(body) !== m[1]) {
                return json(400, { error: { code: 'hash' } });
            }
            if (r.putStatus) {
                return json(r.putStatus, { error: { code: 'refused' } });
            }
            r.bundles.set(m[1], body);
            return { status: 204, body: Buffer.alloc(0) };
        }
        if (method === 'POST' && suffix === '/offer') {
            const o = JSON.parse(String(body));
            const missing = o.bundles.filter((h) => !r.bundles.has(h));
            if (missing.length) {
                return json(409, { error: { code: 'bundle', missing } });
            }
            const claims = r.claims ?? r.waiting;
            if (claims <= 0) {
                return { status: 204, body: Buffer.alloc(0) };
            }
            r.waiting = Math.max(0, r.waiting - 1);
            if (r.claims !== null) {
                r.claims--;
            }
            const id = `L${r.next++}`;
            r.leases.set(id, { state: 'running', host: 'eric', ageMs: 0, job: o.job });
            r.offers.push({ id, ...o });
            return json(200, { lease: id, host: 'eric' });
        }
        m = /^\/lease\/([A-Za-z0-9_-]+)$/.exec(suffix);
        if (m && method === 'GET') {
            const l = r.leases.get(m[1]);
            if (!l) {
                return { status: 404, body: Buffer.alloc(0) };
            }
            if (l.state === 'running') {
                return json(200, { state: 'running', host: l.host, ageMs: l.ageMs });
            }
            r.leases.delete(m[1]); // forgotten once read
            return json(200, l.answer);
        }
        if (m && method === 'DELETE') {
            r.leases.delete(m[1]);
            r.deleted.push(m[1]);
            return { status: 204, body: Buffer.alloc(0) };
        }
        return json(404, { error: { code: 'not_found' } });
    };
    r.finish = (id, change) => Object.assign(r.leases.get(id), { state: 'done', answer: doneAnswer(r.leases.get(id).job, change) });
    r.lose = (id, reason) => Object.assign(r.leases.get(id), { state: 'lost', answer: { state: 'lost', host: 'eric', reason } });
    return r;
}

/**
 * A lane on `queue` with a fake ladder (records onStart / onResult, sets replayFile as ladder.js does), a fake pool
 * that plays every game here at once, and a fake clock. `each(tick)` runs before every tick after the first.
 */
function setup(queue, relay, { each = () => {}, residents = ['heuristic', 'rush'], versionsDir = path.join(tmp, 'none'), tarOf, localMs = 1000, hold = false } = {}) {
    const dir = fs.mkdtempSync(path.join(tmp, 'games-'));
    const ladder = { started: [], results: [], logs: [], pools: 0, grows: 0, poolOrder: null, callTimes: [] };
    let clock = 0;
    let ticks = 0;
    const lane = remoteLane({
        base: BASE, queue, keyOf, limits: LIMITS, residents, versionsDir, tarOf,
        request: (...a) => {
            ladder.callTimes.push(clock);
            return relay.request(...a);
        },
        // `hold`: the games here wait for ladder.release(), so the lane keeps a queue over several ticks
        runPool: (q, { onStart, onResult }) => Object.assign(new Promise((resolve) => {
            ladder.pools++;
            ladder.poolOrder ??= q.map((x) => x.id);
            const playAll = async () => {
                while (q.length) {
                    const job = q.shift();
                    onStart(job);
                    await new Promise(setImmediate);
                    onResult({ job, result: { ...played(job, job.seed).result, ms: localMs } });
                }
                resolve();
            };
            if (hold) {
                ladder.release = playAll;
            } else {
                playAll();
            }
        }), { grow: () => ladder.grows++ }),
        onStart: (job) => {
            ladder.started.push(job.id);
            job.replayFile = path.join(dir, `${job.id}.jsonl`);
        },
        onResult: ({ job, result, host }) => ladder.results.push({ id: job.id, host, result }),
        now: () => clock,
        sleep: async (ms) => {
            clock += ms;
            await new Promise(setImmediate);
            each(++ticks, clock);
        },
        log: (msg) => ladder.logs.push(msg)
    });
    return { lane, ladder, dir, clock: () => clock };
}

const hostOf = (ladder) => Object.fromEntries(ladder.results.map((r) => [r.id, r.host]));

test('relayBase takes only a loopback relay address with a nonce', () => {
    assert.strictEqual(relayBase(BASE), BASE);
    for (const bad of [null, '', 'http://localhost:8082/r/' + NONCE, 'https://127.0.0.1:8082/r/' + NONCE, 'http://127.0.0.1:8082/r/short', `http://127.0.0.1:99999/r/${NONCE}`,
        `http://127.0.0.1:8082/r/${NONCE}/`, `http://127.0.0.1:8082/x/${NONCE}`, `http://10.0.0.1:8082/r/${NONCE}`]) {
        assert.strictEqual(relayBase(bad), null, String(bad));
    }
});

test('ladder.js reads ARENA_REMOTE and removes it before it requires anything', () => {
    // a source check: loading ladder.js starts a ladder
    const src = fs.readFileSync(path.join(__dirname, '..', 'ladder.js'), 'utf8');
    const del = src.indexOf('delete process.env.ARENA_REMOTE');
    assert.ok(del > 0 && del < src.indexOf('require('), 'deleted before the first require');
    assert.ok(src.indexOf('process.env.ARENA_REMOTE') < del);
});

test('an accepted offer goes to the helper whole; its done lease is checked, written and recorded with the host', async () => {
    const queue = schedule([['heuristic', 'rush'], ['heuristic', 'rush']]);
    const relay = fakeRelay();
    relay.waiting = 1;
    const { lane, ladder, dir } = setup(queue, relay, { each: (t) => t === 1 && relay.finish('L1') });
    await lane.run();
    assert.strictEqual(relay.offers.length, 1);
    const { job, bundles } = relay.offers[0];
    assert.deepStrictEqual(job, {
        v: 1, seed: 1, key: keyOf(1), ...LIMITS, gameMs: Math.round(LIMITS.gameMs),
        games: [{ id: 'heuristic-vs-rush-1', p1: 'heuristic', p2: 'rush' }, { id: 'rush-vs-heuristic-1', p1: 'rush', p2: 'heuristic' }],
        bots: { heuristic: { kind: 'resident' }, rush: { kind: 'resident' } }
    });
    assert.deepStrictEqual(bundles, []);
    assert.deepStrictEqual(hostOf(ladder), { 'heuristic-vs-rush-1': 'eric', 'rush-vs-heuristic-1': 'eric', 'heuristic-vs-rush-2': null, 'rush-vs-heuristic-2': null });
    // onStart once per game: the helper's games when the offer was taken, the others when a worker here took them
    assert.deepStrictEqual([...ladder.started].sort(), ['heuristic-vs-rush-1', 'heuristic-vs-rush-2', 'rush-vs-heuristic-1', 'rush-vs-heuristic-2']);
    assert.deepStrictEqual(ladder.started.slice(0, 2), ['heuristic-vs-rush-1', 'rush-vs-heuristic-1']);
    const r = ladder.results.find((x) => x.id === 'heuristic-vs-rush-1').result;
    assert.strictEqual(r.key, keyOf(1));
    assert.strictEqual(r.winner, 'heuristic');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'heuristic-vs-rush-1.jsonl'), 'utf8'), played({ p1: 'heuristic', p2: 'rush' }, 1).replay);
    assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temporary files left');
    assert.ok(!relay.calls.includes('DELETE /lease/L1'));
    assert.ok(ladder.logs.some((l) => /seed 1 .*-> eric, lease L1/.test(l)));
    // what the round report says about the lane (ladder.json remote)
    const st = lane.stats;
    // the one claim was taken at the first look; the later looks found none
    assert.ok(st.looks >= 2 && st.claimLooks === 1, `a claim waited at ${st.claimLooks} of ${st.looks} looks`);
    assert.deepStrictEqual({ ...st, looks: 0, claimLooks: 0 }, {
        lane: true, hosts: ['eric'], looks: 0, claimLooks: 0, leased: 1, played: 2, lost: 0, lastLost: null, relayErrors: [], stopped: null
    });
});

test('the lane\'s stats say when no helper said hello and no claim waited', async () => {
    const relay = fakeRelay();
    relay.hosts = [];
    const { lane } = setup(schedule([['heuristic', 'rush']]), relay);
    await lane.run();
    assert.deepStrictEqual(lane.stats, { lane: true, hosts: [], looks: 1, claimLooks: 0, leased: 0, played: 0, lost: 0, lastLost: null, relayErrors: [], stopped: null });
});

test('a 204 puts the seed back at the front of the queue, in order, and it plays here', async () => {
    // seed 1 cannot go out (random), so the seed offered, 2, was not at the front
    const queue = schedule([['random', 'rush'], ['heuristic', 'rush']]);
    const relay = fakeRelay();
    relay.waiting = 1;
    relay.claims = 0; // the claim went away between status and offer
    const { lane, ladder } = setup(queue, relay);
    await lane.run();
    assert.deepStrictEqual(relay.offers, []);
    assert.ok(relay.calls.includes('POST /offer'));
    assert.deepStrictEqual(ladder.poolOrder, ['heuristic-vs-rush-2', 'rush-vs-heuristic-2', 'random-vs-rush-1', 'rush-vs-random-1']);
    assert.strictEqual(ladder.results.length, 4);
    assert.ok(ladder.results.every((r) => r.host === null));
});

test('a lost lease plays here, and its seed is not offered again', async () => {
    const queue = schedule([['heuristic', 'rush']]);
    const relay = fakeRelay();
    relay.waiting = 5; // helpers keep waiting
    const { lane, ladder } = setup(queue, relay, { each: (t) => t === 1 && relay.lose('L1', 'no heartbeat') });
    await lane.run();
    assert.strictEqual(relay.offers.length, 1, 'offered once');
    assert.deepStrictEqual(hostOf(ladder), { 'heuristic-vs-rush-1': null, 'rush-vs-heuristic-1': null });
    // started for the helper, then again here: ladder.js's onStart resets the entry
    assert.deepStrictEqual(ladder.started, ['heuristic-vs-rush-1', 'rush-vs-heuristic-1', 'heuristic-vs-rush-1', 'rush-vs-heuristic-1']);
    assert.ok(ladder.logs.some((l) => /lease L1 .* lost: no heartbeat/.test(l)));
    assert.deepStrictEqual([lane.stats.leased, lane.stats.played, lane.stats.lost, lane.stats.lastLost], [1, 0, 1, 'eric: no heartbeat']);
});

test('games that come back while the pool here runs get its workers back (grow), not just the busy ones', async () => {
    const queue = schedule([['heuristic', 'rush'], ['rush', 'heuristic']]);
    const relay = fakeRelay();
    relay.waiting = 1;
    const { lane, ladder } = setup(queue, relay, {
        hold: true,
        each: (t) => {
            if (t === 1) {
                relay.lose('L1', 'no heartbeat');
            }
            if (t === 3) {
                ladder.release();
            }
        }
    });
    await lane.run();
    assert.deepStrictEqual(relay.offers.map((o) => o.job.seed), [1]);
    assert.strictEqual(ladder.pools, 1, 'one pool here, started with seed 2');
    assert.strictEqual(ladder.grows, 1, 'seed 1 came back while it ran');
    assert.strictEqual(ladder.results.length, 4);
    assert.ok(ladder.results.every((r) => r.host === null));
});

test('a lease the relay no longer knows (404) plays here', async () => {
    const queue = schedule([['heuristic', 'rush']]);
    const relay = fakeRelay();
    relay.waiting = 1;
    const { lane, ladder } = setup(queue, relay, { each: (t) => t === 1 && relay.leases.delete('L1') });
    await lane.run();
    assert.deepStrictEqual(Object.values(hostOf(ladder)), [null, null]);
    assert.ok(ladder.logs.some((l) => /lost: the relay does not know it/.test(l)));
});

test('an invalid result loses the whole lease: nothing of it is recorded or written', async () => {
    const queue = schedule([['heuristic', 'rush']]);
    const relay = fakeRelay();
    relay.waiting = 1;
    // the second game says p1 won but names the wrong winner
    const { lane, ladder, dir } = setup(queue, relay, { each: (t) => t === 1 && relay.finish('L1', (a) => (a.results[1].result.winner = 'heuristic', a)) });
    await lane.run();
    assert.deepStrictEqual(Object.values(hostOf(ladder)), [null, null]);
    assert.strictEqual(ladder.results.length, 2, 'one result per game: the local ones');
    assert.ok(ladder.logs.some((l) => /lost: invalid result: rush-vs-heuristic-1: winner "heuristic"/.test(l)), ladder.logs.join('\n'));
    assert.deepStrictEqual(fs.readdirSync(dir), [], 'no replay from the helper');
});

test('a slow lease is taken back once the queue is empty: 2 x the median local game + 60 s', async () => {
    const queue = schedule([['heuristic', 'rush'], ['heuristic', 'rush']]);
    const relay = fakeRelay();
    relay.waiting = 1;
    // local games take 1 s, so the limit is 62 s of lease age
    const { lane, ladder } = setup(queue, relay, {
        each: (t) => {
            const l = relay.leases.get('L1');
            if (l) {
                l.ageMs = t * 2000;
            }
        }
    });
    await lane.run();
    assert.deepStrictEqual(relay.deleted, ['L1']);
    assert.deepStrictEqual(Object.values(hostOf(ladder)), [null, null, null, null]);
    const back = ladder.logs.find((l) => /taken back after/.test(l));
    assert.ok(back, ladder.logs.join('\n'));
    assert.strictEqual(Number(/after (\d+) s/.exec(back)[1]), 64, 'the first sweep past 62 s');
});

test('with the relay unreachable for 3 minutes, every open lease comes back and the lane stops', async () => {
    const queue = schedule([['heuristic', 'rush'], ['heuristic', 'rush'], ['heuristic', 'rush']]);
    const relay = fakeRelay();
    relay.waiting = 2;
    let downAt = null;
    const s = setup(queue, relay, {
        each: (t, now) => {
            if (t === 1) {
                relay.down = true;
                downAt = now;
            }
        }
    });
    await s.lane.run();
    assert.strictEqual(relay.offers.length, 2);
    assert.deepStrictEqual(Object.values(hostOf(s.ladder)), [null, null, null, null, null, null]);
    assert.strictEqual(s.ladder.logs.filter((l) => /relay error \(ECONNREFUSED\)/.test(l)).length, 1, 'logged once');
    assert.ok(s.ladder.logs.some((l) => /the lane stops/.test(l)));
    const lastCall = Math.max(...s.ladder.callTimes);
    assert.ok(lastCall - downAt >= 180000 && lastCall - downAt < 184000, `gave up ${lastCall - downAt} ms after the relay went down`);
    assert.ok(!s.ladder.logs.some((l) => /lost: no answer about it/.test(l)), 'the lane\'s own limit, not a lease\'s');
    // the error's kind, never its message (which names the relay's address)
    assert.deepStrictEqual(s.lane.stats.relayErrors, ['ECONNREFUSED']);
    assert.match(s.lane.stats.stopped, /^the relay has failed for 18\d s$/);
    assert.strictEqual(s.lane.stats.lost, 0, 'leases the lane gave back are not counted as lost');
});

test('only seeds whose bots can all run on a helper go out; a version goes with its bundle put first', async () => {
    const versions = path.join(tmp, 'versions');
    const mk = (name, sub, bundle = true) => {
        fs.mkdirSync(path.join(versions, name, ...(bundle ? ['bundle'] : [])), { recursive: true });
        if (sub) {
            fs.writeFileSync(path.join(versions, name, 'SUBMISSION.json'), JSON.stringify(sub));
        }
    };
    mk('wasmy-v1', { bot: { kind: 'wasm' } });
    mk('stdy-v1', { bot: { kind: 'stdio', cmd: './x' } });
    mk('jsy-v1', null, false);
    fs.writeFileSync(path.join(versions, 'jsy-v1', 'bot.js'), 'module.exports = {};');
    const queue = schedule([['random', 'rush'], ['stdy-v1', 'rush'], ['jsy-v1', 'heuristic'], ['heuristic#2', 'rush'], ['wasmy-v1', 'rush']]);
    const relay = fakeRelay();
    relay.waiting = 5;
    const tar = Buffer.from('a canonical tar');
    const packed = [];
    const { lane, ladder } = setup(queue, relay, {
        versionsDir: versions,
        tarOf: async (folder) => {
            packed.push(folder);
            return tar;
        },
        each: (t) => t === 1 && relay.finish('L1')
    });
    await lane.run();
    assert.deepStrictEqual(relay.offers.map((o) => o.job.seed), [5], 'only the WebAssembly version and rush');
    assert.deepStrictEqual(relay.offers[0].job.bots, { 'wasmy-v1': { kind: 'wasm', bundle: sha(tar) }, rush: { kind: 'resident' } });
    assert.deepStrictEqual(relay.offers[0].bundles, [sha(tar)]);
    assert.deepStrictEqual(packed, [path.join(versions, 'wasmy-v1', 'bundle')], 'packed once, and not kept in memory after');
    assert.ok(relay.calls.indexOf(`PUT /bundle/${sha(tar)}`) < relay.calls.indexOf('POST /offer'));
    assert.strictEqual(ladder.results.filter((r) => r.host === 'eric').length, 2);
    assert.strictEqual(ladder.results.length, 10);
});

test('seat twins stay together: a seed one of whose games already plays here does not go out', async () => {
    const queue = schedule([['heuristic', 'rush'], ['heuristic', 'rush'], ['heuristic', 'rush']]);
    const relay = fakeRelay();
    relay.waiting = 3;
    const { lane, ladder } = setup(queue, relay, { each: (t) => t === 1 && [...relay.leases.keys()].forEach((id) => relay.finish(id)) });
    queue.shift(); // a worker here took the first game of seed 1
    const taken = { seed: 1, p1: 'heuristic', p2: 'rush', id: 'heuristic-vs-rush-1' };
    await lane.run();
    assert.deepStrictEqual(relay.offers.map((o) => o.job.seed), [2, 3]);
    for (const o of relay.offers) {
        assert.deepStrictEqual(o.job.games.map((g) => g.id), [`heuristic-vs-rush-${o.job.seed}`, `rush-vs-heuristic-${o.job.seed}`]);
    }
    assert.strictEqual(hostOf(ladder)['rush-vs-heuristic-1'], null, 'its twin plays here');
    assert.ok(!ladder.results.some((r) => r.id === taken.id), 'the game the worker took is not the lane\'s');
});

test('helper games are spread over the bots: the seed with the fewest helper games so far goes first', async () => {
    const queue = schedule([['a-v1', 'heuristic'], ['a-v1', 'heuristic'], ['a-v1', 'rush'], ['a-v1', 'rush'], ['heuristic', 'rush'], ['heuristic', 'rush']]);
    const relay = fakeRelay();
    relay.waiting = 3;
    const { lane } = setup(queue, relay, { residents: ['heuristic', 'rush', 'a-v1'], each: (t) => t === 1 && [...relay.leases.keys()].forEach((id) => relay.finish(id)) });
    await lane.run();
    // seed 1 (a, heuristic); then a has 2, heuristic 2, rush 0: seeds 3 (a, rush) and 5 (heuristic, rush) tie at 2, the
    // lower goes; then 5 (heuristic 2 + rush 2 = 4) beats 2 (a 4 + heuristic 2) and 4 (a 4 + rush 2)
    assert.deepStrictEqual(relay.offers.map((o) => o.job.seed), [1, 3, 5]);
});

test('checkDone wants one well-formed result per game, nothing else, and replays that match them', () => {
    const games = schedule([['heuristic', 'rush']], 7);
    const job = { seed: 7, key: keyOf(7), games };
    const ctx = { seed: 7, key: keyOf(7) };
    const answer = (change) => {
        const a = doneAnswer(job);
        change(a);
        return a;
    };
    assert.strictEqual(checkDone(games, answer(() => {}), ctx), null);
    assert.strictEqual(checkDone(games, answer((a) => delete a.replays[games[0].id]), ctx), null, 'a replay may be missing');
    assert.strictEqual(checkDone(games, answer((a) => delete a.results[0].result.key), ctx), null, 'a game lost at load carries no key');
    const bad = {
        'a game has no result': (a) => a.results.pop(),
        'not a game of this seed': (a) => a.results.push({ id: 'x-vs-y-7', result: a.results[0].result }),
        'two results for': (a) => (a.results[1] = { ...a.results[0] }),
        'outcome': (a) => (a.results[0].result.outcome = 'WON'),
        'by "p3"': (a) => (a.results[0].result.by = 'p3'),
        'faultKind null with by "p1"': (a) => Object.assign(a.results[0].result, { outcome: 'ERROR', by: 'p1', winner: 'rush', winnerSeat: 'p2' }),
        'faultKind "time" with by null': (a) => (a.results[0].result.faultKind = 'time'),
        'winnerSeat': (a) => (a.results[0].result.winnerSeat = 'p3'),
        'winner "rush"': (a) => (a.results[0].result.winner = 'rush'),
        'counts': (a) => (a.results[0].result.steps = -1),
        'counts ': (a) => (a.results[0].result.round = 1.5),
        'another game key': (a) => (a.results[0].result.key = keyOf(8)),
        'error is not text': (a) => (a.results[0].result.error = { x: 1 }),
        'timing is not an object': (a) => (a.results[0].result.timing = 'fast'),
        'think is not': (a) => (a.results[0].result.think = { p1: 'x', p2: 1 }),
        'botStats is not a pair': (a) => (a.results[0].result.botStats = [1]),
        'versions is not an object': (a) => (a.results[0].result.versions = 'v1'),
        'over 256 KB': (a) => (a.results[0].result.error = 'x'.repeat(300 << 10)),
        'seed': (a) => (a.results[0].result.seed = 8),
        'a replay for': (a) => (a.replays['x-vs-y-7'] = a.replays[games[0].id]),
        'replay line 2 is not JSON': (a) => (a.replays[games[0].id] = a.replays[games[0].id].replace('{"t":"step"', '{"t":step')),
        'header is not this game': (a) => (a.replays[games[0].id] = a.replays[games[0].id].replace('"bot":"heuristic"', '"bot":"rush"')),
        'header is not this game\'s': (a) => (a.replays[games[0].id] = a.replays[games[0].id].replace('"seed":7', '"seed":8')),
        'ends otherwise': (a) => (a.replays[games[0].id] = a.replays[games[0].id].replace('"winner":"p1"', '"winner":"p2"')),
        'names another game key': (a) => (a.replays[games[0].id] = a.replays[games[0].id].replace('"faultKind":null}', `"faultKind":null,"key":"${keyOf(8)}"}`)),
        'not text': (a) => (a.replays[games[0].id] = 5),
        'results is not a list': (a) => (a.results = {}),
        'replays is not an object': (a) => (a.replays = [])
    };
    for (const [why, change] of Object.entries(bad)) {
        const got = checkDone(games, answer(change), ctx);
        assert.ok(got?.includes(why.trim()), `${why}: got ${got}`);
    }
});

test('a 409 means the relay forgot the bundle: the lane packs and puts it again', async () => {
    const versions = path.join(tmp, 'again-versions');
    fs.mkdirSync(path.join(versions, 'webby-v1', 'bundle'), { recursive: true });
    fs.writeFileSync(path.join(versions, 'webby-v1', 'SUBMISSION.json'), JSON.stringify({ bot: { kind: 'wasm' } }));
    const queue = schedule([['webby-v1', 'rush'], ['webby-v1', 'rush']]);
    const relay = fakeRelay();
    relay.waiting = 1;
    const packed = [];
    const { lane, ladder } = setup(queue, relay, {
        hold: true,
        versionsDir: versions,
        tarOf: async (folder) => {
            packed.push(folder);
            return Buffer.from('a canonical tar');
        },
        each: (t) => {
            relay.waiting = 1; // one helper slot, free again
            if (t === 1) {
                relay.bundles.clear(); // the round ended on the machine, or the relay restarted
                relay.finish('L1');
            }
            if (t === 3) {
                relay.finish('L2');
            }
            if (t === 4) {
                ladder.release();
            }
        }
    });
    await lane.run();
    assert.deepStrictEqual(relay.offers.map((o) => o.job.seed), [1, 2]);
    assert.strictEqual(relay.calls.filter((c) => c === 'POST /offer').length, 3, 'the offer that got the 409, then the one that worked');
    assert.strictEqual(packed.length, 2, 'packed again for the second put');
    assert.strictEqual(relay.calls.filter((c) => c.startsWith('PUT /bundle/')).length, 2);
    assert.strictEqual(ladder.results.filter((r) => r.host === 'eric').length, 4);
});

test('a bundle that cannot be packed is tried once, and that version\'s games stay here', async () => {
    const versions = path.join(tmp, 'broken-versions');
    fs.mkdirSync(path.join(versions, 'broken-v1', 'bundle'), { recursive: true });
    fs.writeFileSync(path.join(versions, 'broken-v1', 'SUBMISSION.json'), JSON.stringify({ bot: { kind: 'wasm' } }));
    const queue = schedule([['broken-v1', 'rush'], ['broken-v1', 'rush']]);
    const relay = fakeRelay();
    relay.waiting = 2;
    const packed = [];
    const { lane, ladder } = setup(queue, relay, {
        versionsDir: versions,
        tarOf: async (folder) => {
            packed.push(folder);
            throw new Error('error: only regular files and folders are allowed');
        }
    });
    await lane.run();
    assert.deepStrictEqual(relay.offers, []);
    assert.strictEqual(packed.length, 1, 'tried once, then left alone');
    assert.ok(ladder.logs.some((l) => /broken-v1: its bundle cannot be packed \(error: only regular files/.test(l)), ladder.logs.join('\n'));
    assert.strictEqual(ladder.results.length, 4);
    assert.ok(ladder.results.every((r) => r.host === null));
});

for (const [status, why] of [[507, 'the round\'s bundles are at their limit'], [500, 'HTTP 500']]) {
    test(`a bundle the relay refuses (${status}) is put once; that version's games stay here and other seeds still go out`, async () => {
        const versions = path.join(tmp, `refused-versions-${status}`);
        fs.mkdirSync(path.join(versions, 'big-v1', 'bundle'), { recursive: true });
        fs.writeFileSync(path.join(versions, 'big-v1', 'SUBMISSION.json'), JSON.stringify({ bot: { kind: 'wasm' } }));
        const queue = schedule([['big-v1', 'rush'], ['heuristic', 'rush']]);
        const relay = fakeRelay();
        relay.waiting = 2;
        relay.putStatus = status;
        const { lane, ladder } = setup(queue, relay, {
            versionsDir: versions,
            tarOf: async () => Buffer.from('a big tar'),
            each: () => relay.leases.get('L1')?.state === 'running' && relay.finish('L1')
        });
        await lane.run();
        assert.deepStrictEqual(relay.offers.map((o) => o.job.seed), [2], 'only the seed without the version');
        assert.strictEqual(relay.calls.filter((c) => c.startsWith('PUT /bundle/')).length, 1, 'put once');
        assert.ok(ladder.logs.includes(`big-v1: the relay refused its bundle (${why}); its games play here`), ladder.logs.join('\n'));
        assert.strictEqual(ladder.results.filter((r) => r.host === 'eric').length, 2);
        assert.strictEqual(ladder.results.length, 4);
    });
}

test('a long error is cut to 500 characters before it is recorded', async () => {
    const queue = schedule([['heuristic', 'rush']]);
    const relay = fakeRelay();
    relay.waiting = 1;
    const { lane, ladder } = setup(queue, relay, { each: (t) => t === 1 && relay.finish('L1', (a) => (a.results[0].result.error = 'e'.repeat(2000), a)) });
    await lane.run();
    assert.strictEqual(ladder.results.find((r) => r.id === 'heuristic-vs-rush-1').result.error.length, 500);
    assert.strictEqual(ladder.results.find((r) => r.host === 'eric').host, 'eric');
});

test('over a real loopback HTTP relay: bundle, offer, done lease', async () => {
    // the in-memory relay behind a real server, so the lane's own HTTP client is what talks to it
    const relay = fakeRelay();
    relay.waiting = 1;
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
            const url = `http://127.0.0.1:8082${req.url}`; // the fake checks the base, which names port 8082
            const a = await relay.request(req.method, url, Buffer.concat(chunks));
            res.writeHead(a.status, { 'content-type': 'application/json' });
            res.end(a.body);
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}/r/${NONCE}`;
    try {
        const versions = path.join(tmp, 'http-versions');
        fs.mkdirSync(path.join(versions, 'webby-v2', 'bundle'), { recursive: true });
        fs.writeFileSync(path.join(versions, 'webby-v2', 'SUBMISSION.json'), JSON.stringify({ bot: { kind: 'wasm' } }));
        const tar = crypto.randomBytes(200000);
        const queue = schedule([['webby-v2', 'rush']]);
        const done = [];
        let started = 0;
        const lane = remoteLane({
            base, queue, keyOf, limits: LIMITS, residents: ['heuristic', 'rush'], versionsDir: versions, tarOf: async () => tar,
            request: (method, url, body, opts) => request(method, url, body, opts).then((r) => {
                if (method === 'GET' && /\/lease\//.test(url) && relay.leases.get('L1')?.state === 'running') {
                    relay.finish('L1');
                }
                return r;
            }),
            runPool: async () => assert.fail('nothing plays here'),
            onStart: () => started++,
            onResult: (x) => done.push(x),
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms / 100)),
            log: () => {}
        });
        await lane.run();
        assert.strictEqual(started, 2);
        assert.deepStrictEqual(done.map((x) => [x.job.id, x.host]), [['webby-v2-vs-rush-1', 'eric'], ['rush-vs-webby-v2-1', 'eric']]);
        assert.ok(relay.bundles.get(sha(tar)).equals(tar), 'the bundle arrived whole');
        await assert.rejects(request('GET', `http://127.0.0.1:1/r/${NONCE}/status`), (e) => e.code === 'ECONNREFUSED' && !e.message.includes(NONCE));
    } finally {
        server.close();
    }
});
