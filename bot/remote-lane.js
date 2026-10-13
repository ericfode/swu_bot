'use strict';
/**
 * The ladder's remote lane: hands whole seeds to helper computers through the games machine's relay, and records what
 * comes back through the ladder's own onStart and onResult (ladder.js). The machine (coord/, Coord.Remote) gives the
 * referee the relay's address as ARENA_REMOTE, http://127.0.0.1:<port>/r/<nonce>; a helper claims a seed there, plays
 * it with bot/arena/play-seed.js and sends the results back. The ladder stays the owner of the round: it decides which
 * seeds go out, checks every result that comes back, and plays any seed a helper loses, here.
 *
 *   remoteLane({ base, queue, keyOf, limits, runPool, onStart, onResult, ... }).run() -> Promise, resolved once every
 *   game in the queue has a result
 *
 * runPool plays the queue here as before (game-pool.js consumes it with shift); every 2 s the lane
 *   - asks the relay how many helper claims wait (GET status) and, for each, takes an offerable seed out of the queue
 *     and offers it (POST offer). A seed is offerable when all of its games are still in the queue and every bot in
 *     them can run on a helper: heuristic, rush, a WebAssembly resident (play-seed.js RESIDENTS) or a version
 *     <agent>-v<N> of kind 'wasm' with a bundle/ folder, whose canonical tar (bot/compiled/bundle.py tar) is put to
 *     the relay before its first offer. The seed whose bots have had the fewest helper games goes first (then the
 *     lowest seed), so no bot plays much more on helpers than another. The seat-swapped games of a seed always go
 *     together: they share the seed's game key, which the helper gets (never the run key).
 *   - asks after every open lease (GET lease/<id>). A done lease is checked whole (checkDone): its replays are written
 *     where the ladder keeps them and its results go to onResult with the helper's name as host. A lost, unknown or
 *     invalid one puts its games back at the front of the queue, to be played here.
 *   - takes back a lease that runs long once nothing is left in the queue: 2 x the median local game (10 min before
 *     any) + 60 s.
 * The relay unreachable or failing for 3 minutes ends the lane: every open lease's games come back to the queue.
 * Nothing in here ever logs the relay's address (it holds the nonce).
 *
 * Every outside piece can be swapped for tests: request (HTTP), tarOf (the python call), runPool, now and sleep (the
 * clock), versionsDir and residents (which bots may go out), log.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');

const TICK_MS = 2000;
const UNREACHABLE_MS = 3 * 60000;
const TAKE_BACK_DEFAULT_MS = 10 * 60000; // the "median local game" before any finished here
const TAKE_BACK_SLACK_MS = 60000;
const REQUEST_MS = 30000;
// a done lease (the helper may post 40 MB of results and replays) with room for JSON escapes
const MAX_ANSWER_BYTES = 96 << 20;
const MAX_RESULT_BYTES = 256 << 10;
const MAX_REPLAY_BYTES = 32 << 20;
const MAX_ERROR_CHARS = 500;
const VERSION = /^[a-z][a-z0-9_]*-v\d+$/; // registry.js
const LEASE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HOST = /^[a-z][a-z0-9_-]{0,31}$/;
const OUTCOMES = ['won', 'ERROR', 'STEP_CAP', 'STUCK'];
const FAULTS = [null, 'load', 'error', 'time', 'hang'];

/** The relay's base URL when ARENA_REMOTE is one (http://127.0.0.1:<port>/r/<nonce>), else null. */
function relayBase(value) {
    const m = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/r\/[A-Za-z0-9_-]{16,128}$/.exec(String(value ?? ''));
    return m && Number(m[1]) >= 1 && Number(m[1]) <= 65535 ? m[0] : null;
}

/**
 * One call to the relay over plain HTTP on loopback (no proxy, no keep-alive): { status, body: Buffer }. Rejects on a
 * network error, a timeout or an answer over MAX_ANSWER_BYTES. Error messages never carry the URL.
 */
function request(method, url, body = null, { contentType = 'application/json', timeoutMs = REQUEST_MS } = {}) {
    return new Promise((resolve, reject) => {
        const headers = body ? { 'content-type': contentType, 'content-length': body.length } : {};
        const req = http.request(url, { method, headers, agent: false, timeout: timeoutMs }, (res) => {
            const chunks = [];
            let size = 0;
            res.on('data', (c) => {
                size += c.length;
                if (size > MAX_ANSWER_BYTES) {
                    req.destroy(new Error('answer too large'));
                } else {
                    chunks.push(c);
                }
            });
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
            res.on('error', reject);
            res.on('close', () => reject(new Error('connection closed')));
        });
        req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
        req.on('error', reject);
        req.end(body ?? undefined);
    });
}

/** A version's bundle/ folder as its canonical tar (bot/compiled/bundle.py tar). */
function tarOf(folder) {
    return new Promise((resolve, reject) => {
        execFile('python3', [path.join(__dirname, 'compiled', 'bundle.py'), 'tar', folder], { encoding: 'buffer', maxBuffer: 80 << 20, timeout: 120000 }, (e, out, err) => {
            if (e) {
                reject(new Error(String(err ?? '').trim().split('\n').pop() || e.message));
            } else {
                resolve(out);
            }
        });
    });
}

const plain = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const count = (x) => Number.isSafeInteger(x) && x >= 0;
const quote = (x) => String(JSON.stringify(x) ?? 'undefined').slice(0, 80);
const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * What is wrong with one game's result from a helper, or null. `game` is the queue item ({id, p1, p2}), key the game
 * key the helper was given.
 */
function badResult(game, r, { seed, key }) {
    if (!plain(r)) {
        return 'the result is not an object';
    }
    if (Buffer.byteLength(JSON.stringify(r)) > MAX_RESULT_BYTES) {
        return 'the result is over 256 KB';
    }
    if (!OUTCOMES.includes(r.outcome)) {
        return `outcome ${quote(r.outcome)}`;
    }
    // absent reads as null, as ladder.js reads it
    const by = r.by ?? null;
    const faultKind = r.faultKind ?? null;
    const winnerSeat = r.winnerSeat ?? null;
    if (![null, 'p1', 'p2'].includes(by)) {
        return `by ${quote(by)}`;
    }
    if (!FAULTS.includes(faultKind) || (faultKind !== null) !== (by !== null && r.outcome === 'ERROR')) {
        return `faultKind ${quote(faultKind)} with by ${quote(by)} and outcome ${r.outcome}`;
    }
    if (![null, 'p1', 'p2', 'draw'].includes(winnerSeat)) {
        return `winnerSeat ${quote(winnerSeat)}`;
    }
    const winner = { p1: game.p1, p2: game.p2, draw: 'draw' }[winnerSeat] ?? null;
    if ((r.winner ?? null) !== winner) {
        return `winner ${quote(r.winner)} is not who ${winnerSeat ?? 'no seat'} gives`;
    }
    if (!count(r.round) || !count(r.steps) || !(typeof r.ms === 'number' && Number.isFinite(r.ms) && r.ms >= 0)) {
        return 'round, steps and ms must be counts';
    }
    if (r.seed !== undefined && r.seed !== seed) {
        return `seed ${quote(r.seed)}`;
    }
    if (r.error != null && typeof r.error !== 'string') {
        return 'error is not text';
    }
    if (r.key != null && r.key !== key) {
        return 'another game key';
    }
    if (r.timing != null && !plain(r.timing)) {
        return 'timing is not an object';
    }
    if (r.think != null && !(plain(r.think) && Object.keys(r.think).sort().join() === 'p1,p2' && [r.think.p1, r.think.p2].every((x) => typeof x === 'number' && Number.isFinite(x)))) {
        return 'think is not {p1, p2} of numbers';
    }
    if (r.botStats != null && !(Array.isArray(r.botStats) && r.botStats.length === 2)) {
        return 'botStats is not a pair';
    }
    if (r.versions !== undefined && !plain(r.versions)) {
        return 'versions is not an object';
    }
    return null;
}

/** What is wrong with one game's replay (JSON Lines text, header ... end) from a helper, or null. Absent is fine. */
function badReplay(game, r, text, { seed, key }) {
    if (text === undefined) {
        return null;
    }
    if (typeof text !== 'string') {
        return 'the replay is not text';
    }
    if (Buffer.byteLength(text) > MAX_REPLAY_BYTES) {
        return 'the replay is over 32 MB';
    }
    const lines = text.split('\n');
    if (lines.at(-1) === '') {
        lines.pop();
    }
    const parsed = [];
    for (const [i, line] of lines.entries()) {
        try {
            parsed.push(JSON.parse(line));
        } catch {
            return `replay line ${i + 1} is not JSON`;
        }
    }
    const head = parsed[0];
    const end = parsed.at(-1);
    if (parsed.length < 2 || head?.t !== 'header' || head.seed !== seed || head.players?.[0]?.bot !== game.p1 || head.players?.[1]?.bot !== game.p2) {
        return 'the replay header is not this game\'s';
    }
    if (end?.t !== 'end' || end.winner !== (r.winnerSeat ?? null) || end.outcome !== r.outcome || (end.by ?? null) !== (r.by ?? null) || (end.faultKind ?? null) !== (r.faultKind ?? null)) {
        return 'the replay ends otherwise than the result says';
    }
    if (end.key != null && end.key !== key) {
        return 'the replay names another game key';
    }
    return null;
}

/**
 * Checks a done lease ({results: [{id, result}], replays: {id: text}}) against the games it was given: null when it
 * can be recorded, else what is wrong. Every game needs exactly one result and nothing else may come back.
 */
function checkDone(games, answer, ctx) {
    if (!Array.isArray(answer.results)) {
        return 'results is not a list';
    }
    const replays = answer.replays ?? {};
    if (!plain(replays)) {
        return 'replays is not an object';
    }
    const byId = new Map(games.map((g) => [g.id, g]));
    const got = new Map();
    for (const e of answer.results) {
        if (!plain(e) || typeof e.id !== 'string' || !byId.has(e.id)) {
            return `a result for ${quote(e?.id)}, not a game of this seed`;
        }
        if (got.has(e.id)) {
            return `two results for ${quote(e.id)}`;
        }
        got.set(e.id, e.result);
    }
    if (got.size !== byId.size) {
        return 'a game has no result';
    }
    for (const id of Object.keys(replays)) {
        if (!byId.has(id)) {
            return `a replay for ${quote(id)}, not a game of this seed`;
        }
    }
    for (const g of games) {
        const r = got.get(g.id);
        const why = badResult(g, r, ctx) ?? badReplay(g, r, Object.hasOwn(replays, g.id) ? replays[g.id] : undefined, ctx);
        if (why) {
            return `${g.id}: ${why}`;
        }
    }
    return null;
}

/** The fields ladder.js reads, from a checked result (error cut to 500 characters). */
function cleanResult(r) {
    return {
        seed: r.seed, outcome: r.outcome, by: r.by ?? null, faultKind: r.faultKind ?? null, winner: r.winner ?? null, winnerSeat: r.winnerSeat ?? null,
        round: r.round, steps: r.steps, ms: r.ms, error: r.error == null ? null : r.error.slice(0, MAX_ERROR_CHARS), timing: r.timing ?? null,
        think: r.think ?? null, botStats: r.botStats ?? null, ...(r.key ? { key: r.key } : {}), ...(r.versions ? { versions: r.versions } : {})
    };
}

/** Replaces file with text in one step (a temporary file made with O_EXCL, then renamed). */
function writeAtomic(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
        fs.writeFileSync(tmp, text, { flag: 'wx' });
        fs.renameSync(tmp, file);
    } catch (e) {
        fs.rmSync(tmp, { force: true });
        throw e;
    }
}

function remoteLane({
    base, queue, keyOf, limits, runPool, onStart, onResult,
    versionsDir = null, residents = null, request: send = request, tarOf: pack = tarOf,
    now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log = (msg) => console.log(`remote: ${msg}`)
}) {
    const { maxSteps, capMs, hangMs, gameMs } = limits;
    const allowed = residents ?? (() => {
        const ps = require('./arena/play-seed');
        return [...ps.IN_PROCESS, ...ps.residentsHere()];
    })();
    const versions = () => versionsDir ?? require('./arena/home').VERSIONS;
    // seed -> its games in the queue when the lane started (a resumed round has some seeds with fewer)
    const seeds = new Map();
    for (const q of queue) {
        seeds.set(q.seed, [...(seeds.get(q.seed) ?? []), q]);
    }
    const local = new Set(); // seeds whose lease was lost or taken back: they play here
    const leases = new Map(); // lease id -> { id, host, seed, games, heardAt (the relay's last answer about it) }
    const helperGames = new Map(); // bot -> its games on helpers (out now or recorded)
    const capable = new Map(); // bot -> it may go to a helper
    const bundles = new Map(); // version -> { hex, put } of the bundle this run sent
    const localMs = [];
    const logged = new Set();
    const hosts = new Set();
    let downSince = null; // when the relay stopped answering (or answered with an error), null while it answers
    let on = true;
    let pool = null;
    let poolError = null;
    let growPool = () => {};
    let played = 0;

    const call = async (method, suffix, body = null, contentType) => {
        const res = await send(method, `${base}${suffix}`, body, contentType ? { contentType } : {});
        return { status: res.status, body: res.body, json: () => JSON.parse(String(res.body)) };
    };
    // a failed relay call: logged once per kind; the lane gives up after UNREACHABLE_MS of nothing but failures
    const failed = (kind) => {
        if (!logged.has(kind)) {
            logged.add(kind);
            log(`relay error (${kind}); games keep playing here`);
        }
        downSince ??= now();
    };
    const answered = () => {
        downSince = null;
    };
    const errorKind = (e) => e?.code ?? String(e?.message ?? e).split('\n')[0].slice(0, 80);

    function isCapable(name) {
        if (!capable.has(name)) {
            let ok = allowed.includes(name);
            if (!ok && VERSION.test(name)) {
                const dir = path.join(versions(), name);
                let sub = null;
                try {
                    sub = JSON.parse(fs.readFileSync(path.join(dir, 'SUBMISSION.json'), 'utf8'));
                } catch {
                    // no submission record: not a WebAssembly version
                }
                ok = sub?.bot?.kind === 'wasm' && !!fs.lstatSync(path.join(dir, 'bundle'), { throwIfNoEntry: false })?.isDirectory();
            }
            capable.set(name, ok);
        }
        return capable.get(name);
    }

    const namesOf = (games) => [...new Set(games.flatMap((g) => [g.p1, g.p2]))];

    /** The offerable seed whose bots had the fewest helper games (then the lowest seed), or null. */
    function pick() {
        const waiting = new Set(queue);
        let best = null;
        for (const [seed, games] of seeds) {
            if (local.has(seed) || !games.every((g) => waiting.has(g)) || !namesOf(games).every(isCapable)) {
                continue;
            }
            const load = namesOf(games).reduce((s, n) => s + (helperGames.get(n) ?? 0), 0);
            if (!best || load < best.load || (load === best.load && seed < best.seed)) {
                best = { seed, load };
            }
        }
        return best?.seed ?? null;
    }

    /**
     * Puts a version's bundle to the relay once per run; false when it cannot go now (or ever: then it plays here).
     * The tar is packed again when it is needed again (the relay forgets the bundles at the end of a round), so no
     * bundle stays in memory between offers.
     */
    async function putBundle(name) {
        const b = bundles.get(name);
        if (b?.put) {
            return true;
        }
        let tar;
        try {
            tar = await pack(path.join(versions(), name, 'bundle'));
        } catch (e) {
            log(`${name}: its bundle cannot be packed (${errorKind(e)}); its games play here`);
            capable.set(name, false);
            return false;
        }
        const hex = crypto.createHash('sha256').update(tar).digest('hex');
        bundles.set(name, { hex, put: false });
        let res;
        try {
            res = await call('PUT', `/bundle/${hex}`, tar, 'application/x-tar');
        } catch (e) {
            failed(errorKind(e));
            return false;
        }
        if (res.status === 204) {
            answered();
            bundles.get(name).put = true;
            return true;
        }
        // any other answer (400 its hash, 507 the round's bundles at their limit, 500 the store failed): put again, it
        // would fail again every tick and hold up every other offer, so this version's games play here
        answered();
        const why = { 400: 'its hash', 507: 'the round\'s bundles are at their limit' }[res.status] ?? `HTTP ${res.status}`;
        log(`${name}: the relay refused its bundle (${why}); its games play here`);
        capable.set(name, false);
        return false;
    }

    const putBack = (games) => {
        // at the front, in their order: the next free worker here takes them, and the pool here gets back the workers
        // that left when the queue ran dry (game-pool.js grow), so a round's tail does not play them one at a time
        queue.unshift(...games.filter((g) => !queue.includes(g)));
        if (pool) {
            growPool();
        }
    };
    const countHelper = (games, d) => {
        for (const g of games) {
            for (const n of [g.p1, g.p2]) {
                helperGames.set(n, (helperGames.get(n) ?? 0) + d);
            }
        }
    };

    /** Offers one seed: 'leased', 'none' (no claim waits any more) or 'error'. */
    async function offer(seed) {
        const games = seeds.get(seed);
        const names = namesOf(games);
        const bots = {};
        for (const n of names) {
            if (allowed.includes(n)) {
                bots[n] = { kind: 'resident' };
            } else if (await putBundle(n)) {
                bots[n] = { kind: 'wasm', bundle: bundles.get(n).hex };
            } else {
                return 'error';
            }
        }
        // the bundle puts above awaited: the games must still all be here
        if (!games.every((g) => queue.includes(g))) {
            return 'none';
        }
        for (const g of games) {
            queue.splice(queue.indexOf(g), 1);
        }
        // gameMs is whole milliseconds on the wire (the relay takes an integer), which a fractional --cap-ms could make it not
        const job = { v: 1, seed, key: keyOf(seed), maxSteps, capMs, hangMs, gameMs: Math.round(gameMs), games: games.map((g) => ({ id: g.id, p1: g.p1, p2: g.p2 })), bots };
        const hexes = Object.values(bots).filter((b) => b.bundle).map((b) => b.bundle);
        let res;
        try {
            res = await call('POST', '/offer', Buffer.from(JSON.stringify({ job, bundles: hexes })));
        } catch (e) {
            putBack(games);
            failed(errorKind(e));
            return 'error';
        }
        if (res.status === 200) {
            answered();
            let a = null;
            try {
                a = res.json();
            } catch {
                // checked below
            }
            if (!plain(a) || typeof a.lease !== 'string' || !LEASE_ID.test(a.lease) || typeof a.host !== 'string' || !HOST.test(a.host) || leases.has(a.lease)) {
                log(`seed ${seed}: the relay's answer to an offer makes no sense; it plays here`);
                local.add(seed);
                putBack(games);
                return 'error';
            }
            leases.set(a.lease, { id: a.lease, host: a.host, seed, games, heardAt: now() });
            countHelper(games, 1);
            log(`seed ${seed} (${games.map((g) => g.id).join(', ')}) -> ${a.host}, lease ${a.lease}`);
            for (const g of games) {
                onStart(g);
            }
            return 'leased';
        }
        putBack(games);
        if (res.status === 204) {
            answered();
            return 'none';
        }
        if (res.status === 409) {
            // the relay lost a bundle (it forgets them at the end of a round): put them again next time
            answered();
            for (const n of names) {
                if (bundles.has(n)) {
                    bundles.get(n).put = false;
                }
            }
            return 'error';
        }
        failed(`HTTP ${res.status}`);
        return 'error';
    }

    /** A lease whose games play here after all. */
    function lose(lease, why) {
        leases.delete(lease.id);
        countHelper(lease.games, -1);
        local.add(lease.seed);
        putBack(lease.games);
        log(`lease ${lease.id} (seed ${lease.seed}, ${lease.host}) lost: ${why}; playing it here`);
    }

    /** A done lease: its replays and results, unless anything in them is off (then it is lost). */
    function record(lease, answer) {
        const why = checkDone(lease.games, answer, { seed: lease.seed, key: keyOf(lease.seed) });
        if (why) {
            lose(lease, `invalid result: ${why}`);
            return;
        }
        leases.delete(lease.id);
        const results = new Map(answer.results.map((e) => [e.id, e.result]));
        const replays = answer.replays ?? {};
        // every replay first: the last result publishes the seed's key into them (ladder.js)
        for (const g of lease.games) {
            if (g.replayFile) {
                if (Object.hasOwn(replays, g.id)) {
                    writeAtomic(g.replayFile, replays[g.id]);
                } else {
                    fs.rmSync(g.replayFile, { force: true });
                }
            }
        }
        for (const g of lease.games) {
            played++;
            onResult({ job: g, result: cleanResult(results.get(g.id)), host: lease.host });
        }
    }

    async function sweep() {
        for (const lease of [...leases.values()]) {
            let res;
            try {
                res = await call('GET', `/lease/${lease.id}`);
            } catch (e) {
                failed(errorKind(e)); // the relay unreachable: the lane's own 3 minutes decide
                continue;
            }
            if (res.status !== 200 && res.status !== 404) {
                failed(`HTTP ${res.status}`);
                // a relay that answers everything but this lease would otherwise keep it open for good
                if (now() - lease.heardAt >= UNREACHABLE_MS) {
                    lose(lease, `no answer about it for ${Math.round((now() - lease.heardAt) / 1000)} s`);
                }
                continue;
            }
            answered();
            lease.heardAt = now();
            if (res.status === 404) {
                lose(lease, 'the relay does not know it');
                continue;
            }
            let a = null;
            try {
                a = res.json();
            } catch {
                // checked below
            }
            if (a?.state === 'running') {
                const limit = 2 * (localMs.length ? median(localMs) : TAKE_BACK_DEFAULT_MS) + TAKE_BACK_SLACK_MS;
                if (!queue.length && Number(a.ageMs) > limit) {
                    await call('DELETE', `/lease/${lease.id}`).catch((e) => failed(errorKind(e)));
                    lose(lease, `taken back after ${Math.round(Number(a.ageMs) / 1000)} s, nothing else left to play`);
                }
            } else if (a?.state === 'done') {
                record(lease, a);
            } else if (a?.state === 'lost') {
                lose(lease, String(a.reason ?? 'no reason given').slice(0, 300));
            } else {
                lose(lease, 'the relay\'s answer makes no sense');
            }
        }
    }

    async function offerSeeds() {
        let res;
        try {
            res = await call('GET', '/status');
        } catch (e) {
            failed(errorKind(e));
            return;
        }
        if (res.status !== 200) {
            failed(`HTTP ${res.status}`);
            return;
        }
        answered();
        let st = null;
        try {
            st = res.json();
        } catch {
            return;
        }
        const named = (Array.isArray(st?.hosts) ? st.hosts : []).filter((h) => typeof h === 'string' && HOST.test(h) && !hosts.has(h));
        if (named.length) {
            named.forEach((h) => hosts.add(h));
            log(`helpers this boot: ${[...hosts].join(', ')}`);
        }
        let waiting = Number.isSafeInteger(st?.waiting) ? st.waiting : 0;
        while (waiting > 0 && on) {
            const seed = pick();
            if (seed === null || (await offer(seed)) !== 'leased') {
                return;
            }
            waiting--;
        }
    }

    /** Ends the lane: every open lease's games play here. */
    function giveUp(why) {
        on = false;
        log(`${why}; the lane stops and ${leases.size ? `the games of its ${leases.size} open lease${leases.size === 1 ? '' : 's'} play` : 'everything plays'} here`);
        for (const lease of [...leases.values()]) {
            leases.delete(lease.id);
            countHelper(lease.games, -1);
            local.add(lease.seed);
            putBack(lease.games);
        }
    }

    function startPool() {
        const started = runPool(queue, {
            onStart,
            onResult: (x) => {
                localMs.push(x.result.ms);
                onResult({ ...x, host: null });
            }
        });
        growPool = typeof started.grow === 'function' ? () => started.grow() : () => {};
        const p = started.then(() => {
            pool = null;
            growPool = () => {};
        }, (e) => {
            pool = null;
            growPool = () => {};
            poolError = e;
        });
        pool = p;
        return p;
    }

    async function run() {
        let ended = null;
        for (;;) {
            if (on && (queue.length || leases.size)) {
                await offerSeeds();
                await sweep();
                if (on && downSince !== null && now() - downSince >= UNREACHABLE_MS) {
                    giveUp(`the relay has failed for ${Math.round((now() - downSince) / 1000)} s`);
                }
            }
            if (poolError) {
                throw poolError;
            }
            if (queue.length && !pool) {
                ended = startPool();
            }
            if (!queue.length && !pool && !leases.size) {
                break;
            }
            // the next tick, or sooner when the pool here ends
            await Promise.race([sleep(TICK_MS), ...(pool ? [ended] : [])]);
        }
        if (played) {
            log(`${played} games played on helpers`);
        }
    }

    return { run, get open() {
        return leases.size;
    } };
}

module.exports = { remoteLane, relayBase, request, tarOf, checkDone, badResult, badReplay, TICK_MS, UNREACHABLE_MS };
