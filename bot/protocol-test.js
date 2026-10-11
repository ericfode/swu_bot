'use strict';
// node bot/protocol-test.js  -> conformance checks for the bot protocol (spec/protocol.md) and replay format on real
// games. Needs the engine build and card data. Prints one line per check; exits 1 if any fails.
const crypto = require('crypto');
const path = require('path');
const { Env, seededRng } = require('./env');
const { playGame } = require('./match');
const { snapshot } = require('./view');
const { StdioClient, answer } = require('./stdio');
const { createRandomBot } = require('./players/random');
const randomBot = require('./examples/random-bot');
const searchBot = require('./examples/search-bot');

const hash = (r) => crypto.createHash('sha1').update(r.events.map((e) => JSON.stringify(e)).join('\n')).digest('hex');
// engine rollbacks do not rewind the id counter, so cards created later (tokens) get other ids; play is the same
const canon = (xs) => {
    const ids = new Map();
    return xs.map((x) => JSON.stringify(x).replace(/"Card_\d+"/g, (id) => (ids.has(id) || ids.set(id, `"#${ids.size}"`), ids.get(id))));
};
const sameUpToIds = (a, b) => a.length === b.length && canon(a).every((x, i) => x === canon(b)[i]);
const pickRandom = (m, rng) => ({ t: 'act', i: Math.floor(rng() * m.actions.length) });
const program = (name, file, opts = {}) => new StdioClient(name, { cmd: process.execPath, args: [path.join(__dirname, 'examples', file), name], ...opts });
const inline = (name, src, opts = {}) => new StdioClient(name, { cmd: process.execPath, args: ['-e', src], ...opts });

/** Wraps a client and keeps every message it is sent. */
function tap(client) {
    const seen = [];
    const pass = (msg, sim) => (seen.push(msg), answer(client, msg, sim));
    return { name: client.name, hello: pass, decide: pass, over: pass, seen };
}

/** A legal split that fills targets in order (null when none fits). */
function greedySplit(d) {
    let left = d.amount;
    const out = [];
    for (const t of d.targets.slice(0, d.maxTargets ?? d.targets.length)) {
        const give = t.cap === null ? left : Math.min(left, t.cap);
        if (give > 0) {
            out.push({ id: t.id, amount: give });
            left -= give;
        }
    }
    return left && !d.canDistributeLess ? null : out;
}

const results = [];
async function check(name, fn) {
    try {
        const why = await fn();
        results.push(!why);
        console.log(`${why ? 'FAIL' : 'ok  '} ${name}${why ? `: ${why}` : ''}`);
    } catch (e) {
        results.push(false);
        console.log(`FAIL ${name}: threw ${e.stack}`);
    }
}

(async () => {
    const env = new Env();
    const play = (seed, bots, opts) => playGame(env, { seed, bots, record: true, ...opts });

    await check('a seed replays identically', async () => {
        const [a, b] = [await play(2, [searchBot.create(), createRandomBot('r')]), await play(2, [searchBot.create(), createRandomBot('r')])];
        return a.outcome !== 'won' ? `outcome ${a.outcome} ${a.error}` : hash(a) !== hash(b) && 'different events';
    });

    await check('a secret key hides the seed and keeps games reproducible', async () => {
        const seen = [];
        const spy = (tag) => ({ name: 'spy', hello: (m) => (seen.push([tag, m.seed]), { t: 'ready', v: 2 }), decide: (m) => ({ t: 'act', i: 0 }) });
        const keyed = () => play(5, [spy('k'), createRandomBot('r')], { key: 'secret', maxSteps: 300 });
        const [a, b, plain] = [await keyed(), await keyed(), await play(5, [spy('p'), createRandomBot('r')], { maxSteps: 300 })];
        return hash(a) !== hash(b) ? 'keyed games differ'
            : seen[0][1] !== seen[1][1] || seen[0][1] === seen[2][1] ? `seeds ${seen.map((x) => x[1])}`
                : JSON.stringify(a.events[0].decks) === JSON.stringify(plain.events[0].decks) && 'same decks with and without a key';
    });

    await check('a decision has one time budget, sims included', async () => {
        const slow = {
            name: 'slow', hello: () => ({ t: 'ready', v: 2, sim: true }),
            async decide(m, sim) {
                let r;
                do {
                    r = await sim({ t: 'sim', op: 'begin' });
                } while (!r.error); // sims answer 'out of time' once the budget is spent
                return { t: 'act', i: 0 };
            }
        };
        const r = await play(5, [slow, createRandomBot('r')], { limits: { decide: 50 } });
        return !/^p1 slow: no reply to 'decide' within 50 ms/.test(r.error ?? '') && `${r.outcome} ${r.error}`;
    });

    await check('stdio and in-process clients play the same game', async () => {
        for (const [file, make] of [['random-bot.js', randomBot.create], ['search-bot.js', searchBot.create]]) {
            const name = `parity-${file}`;
            const local = await play(3, [make(name), createRandomBot('r')]);
            const remote = program(name, file);
            const piped = await play(3, [remote, createRandomBot('r')]);
            remote.close();
            if (piped.outcome !== 'won' || hash(local) !== hash(piped)) {
                return `${file}: ${piped.outcome} ${piped.error ?? 'different events'}`;
            }
        }
    });

    let searched = null;
    await check('simulations leave no trace in the real game', async () => {
        searched = await play(4, [searchBot.create(), createRandomBot('r')]);
        const picks = searched.events.filter((e) => e.pid === 'p1').map((e) => e.action.i);
        const replayed = await play(4, [{ name: 'js-search', decide: (m) => ({ t: 'act', i: picks[m.seq - 1] }) }, createRandomBot('r')]);
        return searched.timing.p1.n < 50 ? 'too few decisions' : !sameUpToIds(searched.events, replayed.events) && 'different events';
    });

    await check('a numbered deal repeats its cards and outcomes, a new deal does not', async () => {
        let runs = null;
        const dealer = {
            name: 'dealer', hello: () => ({ t: 'ready', v: 2, sim: true }),
            async decide(m, sim) {
                const run = async (deal) => {
                    const states = [];
                    // pass to the next round: its draws show the dealt deck order
                    for (let r = await sim({ t: 'sim', op: 'begin', deal }), k = 0; r.actions && k < 80; k++) {
                        states.push(r.state);
                        r = await sim({ t: 'sim', op: 'act', i: (r.actions.find((a) => /^pass$/i.test(a.label)) ?? r.actions[0]).i });
                    }
                    return canon(states).join('\n');
                };
                runs ??= m.sim ? [await run(3), await run(3), await run(), await run()] : null;
                return { t: 'act', i: 0 };
            }
        };
        await play(6, [dealer, createRandomBot('r')], { maxSteps: 40 });
        const [a, b, c, d] = runs ?? [];
        return !runs ? 'no simulation ran' : a !== b ? 'deal 3 differs from itself' : (c === d || c === a) && 'new deals repeat';
    });

    await check('a replay re-simulates from its header and steps', async () => {
        const [header, ...steps] = searched.events;
        const eg = env.newGame({ seed: header.seed, deck1: header.decks.p1, deck2: header.decks.p2 });
        await eg.start();
        const recorded = steps.filter((e) => e.t === 'step');
        const boards = [];
        for (const s of recorded) {
            if (s.n > 0) {
                const pid = eg.pidOf(s.pid);
                const actions = eg.legalActions(pid);
                const a = actions[s.action.i];
                if (actions.length !== s.legal || a?.label !== s.action.label) {
                    return `step ${s.n}: action ${s.action.i} is ${a?.label}, recorded ${s.action.label}`;
                }
                eg.apply(pid, s.action.split ? { ...a, split: s.action.split } : a);
            }
            boards.push(snapshot(eg));
        }
        return !sameUpToIds(boards, recorded.map((s) => s.state)) && 'boards differ';
    });

    await check('v1 bots get v1 messages and may send distribution', async () => {
        const rng = seededRng('v1');
        const v1 = tap({
            name: 'v1', hello: () => ({ t: 'ready', name: 'v1' }),
            decide: (m) => {
                const d = m.actions[0].kind === 'distribute' ? greedySplit(m.actions[0].distribute) : null;
                return d ? { t: 'act', i: 0, distribution: d } : pickRandom(m, rng);
            }
        });
        const r = await play(6, [v1, createRandomBot('r')]);
        const hello = v1.seen[0];
        if (r.outcome !== 'won' || hello.v !== 1 || !hello.versions.includes(2)) {
            return `${r.outcome} ${r.error ?? ''} hello v${hello.v}`;
        }
        return v1.seen.some((m) => m.t === 'over' || m.sim) ? 'v1 bot got over or simulations' : false;
    });

    await check('splits are checked and recorded', async () => {
        const make = (bad, rng = seededRng('splitter')) => ({
            name: 'splitter', decide: (m) => {
                const k = m.actions.findIndex((a) => a.kind === 'distribute' && greedySplit(a.distribute));
                if (k < 0) {
                    return pickRandom(m, rng);
                }
                const split = greedySplit(m.actions[k].distribute);
                return { t: 'act', i: k, split: bad ? [...split, { id: 'Card_none', amount: 1 }] : split };
            }
        });
        for (let seed = 1; seed < 40; seed++) {
            const r = await play(seed, [make(false), createRandomBot('r')]);
            const mine = r.events.filter((e) => e.pid === 'p1' && e.action.kind === 'distribute');
            if (mine.length) {
                const bad = await play(seed, [make(true), createRandomBot('r')]);
                return !mine.every((e) => e.action.split) ? 'split not recorded'
                    : !/^p1 splitter: bad split/.test(bad.error ?? '') && `illegal split gave ${bad.outcome} ${bad.error}`;
            }
        }
        return 'no seed had a distribute decision';
    });

    await check('sim mistakes are answered, not fatal', async () => {
        const errors = [];
        const rng = seededRng('clumsy');
        const client = {
            name: 'clumsy', hello: () => ({ t: 'ready', v: 2, sim: true }),
            async decide(m, sim) {
                if (m.sim && errors.length < 5) {
                    for (const req of [{ op: 'act', i: 0 }, { op: 'begin' }, { op: 'begin', deal: -1 }, { op: 'begin' }, { op: 'act', i: 1e6 }, { op: 'end' }, { op: 'nope' }]) {
                        const r = await sim({ t: 'sim', ...req });
                        if (r.error) {
                            errors.push(r.error);
                        }
                    }
                }
                return pickRandom(m, rng);
            }
        };
        const r = await play(7, [client, createRandomBot('r')]);
        return r.outcome !== 'won' ? `${r.outcome} ${r.error}` : errors.length < 5 && `only ${errors.length} errors`;
    });

    await check('bot failures end the game, name the bot, and spare the opponent', async () => {
        const reader = "require('readline').createInterface({input: process.stdin}).on('line', (l) => { const m = JSON.parse(l); ";
        const cases = [
            [{ name: 'liar', decide: () => ({ t: 'act', i: 1e6 }) }, /^p1 liar: expected \{"t":"act"/],
            [{ name: 'quitter', decide: () => ({ t: 'error', error: 'boom' }) }, /^p1 quitter: error: boom/],
            [inline('mute', `${reader}if (m.t === 'hello') console.log(JSON.stringify({ t: 'ready', v: 2 })); });`, { timeoutMs: 300 }), /^p1 mute: no reply to 'decide' within 300 ms/],
            [inline('chatty', `${reader}process.stdout.write(JSON.stringify({ t: 'ready', v: 2 }) + '\\n{}\\n'); });`), /^p1 chatty: wrote a line nobody asked for/],
            [inline('crash', `${reader}if (m.t === 'hello') console.log(JSON.stringify({ t: 'ready', v: 2 })); else process.exit(3); });`), /^p1 crash: exited \(code 3\)/]
        ];
        for (const [bot, want] of cases) {
            const opp = tap(randomBot.create('witness'));
            const r = await play(8, [bot, opp]);
            bot.close?.();
            const over = opp.seen.find((m) => m.t === 'over');
            if (r.outcome !== 'ERROR' || !want.test(r.error) || over?.outcome !== 'ERROR') {
                return `${bot.name}: ${r.outcome} ${r.error} (opponent over: ${over?.outcome})`;
            }
        }
    });

    process.exit(results.every(Boolean) ? 0 : 1);
})();
