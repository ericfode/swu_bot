'use strict';
// The games machine's decisions (bot/arena/gamesctl.js planRound): when to play a round. No engine or card data needed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesctl-plan-test-'));
process.env.ARENA_HOME = path.join(tmp, 'arena');
process.env.ARENA_RESULTS = path.join(tmp, 'results');
process.env.GAMES_DATA = tmp;
const home = require('../arena/home');
const { planRound, botEnv } = require('../arena/gamesctl');

const HOUR = 3600000;
const writeJson = (file, doc) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(doc));
};
const version = (name, v) => writeJson(path.join(home.VERSIONS, `${name}-v${v}`, 'SUBMISSION.json'), { bot: { kind: 'wasm' }, submittedAt: new Date().toISOString() });
const standings = (rounds, updatedAt = new Date().toISOString()) => writeJson(path.join(home.HOME, 'standings.json'), { rounds, updatedAt });
const played = (round, names, status = 'done') => ({ round, status, bots: names.map((name) => ({ name })) });

test('gamesctl plan: a round when a version comes in, after it settles; again when the lineup changes or the last round is a day old', () => {
    writeJson(path.join(home.HOME, 'roster.json'), { thinkCapMs: 60000, baselines: ['heuristic', 'rush'], agents: [] });
    const now = Date.now();
    const opts = { replayMs: 24 * HOUR, settledSince: 0 };
    assert.deepStrictEqual(planRound(opts), { round: null, why: 'no-competitor' }, 'no competitor: no round');

    home.updateRoster((r) => ({ ...r, agents: [{ name: 'kim_b', owner: 'github:kim-b' }] }));
    version('kim_b', 1);
    assert.deepStrictEqual(planRound({ ...opts, settledSince: now }), { round: null, why: 'settling' }, 'a version that just came in settles first');
    assert.deepStrictEqual(planRound(opts), { round: 0, resume: false, why: 'changed' }, 'then the next round');

    standings([played(0, ['kim_b-v1', 'heuristic', 'rush'], 'running')]);
    assert.deepStrictEqual(planRound(opts), { round: 0, resume: true, why: 'resume' }, 'a round a stop cut short is finished');

    standings([played(0, ['kim_b-v1', 'heuristic', 'rush'])]);
    assert.deepStrictEqual(planRound(opts), { round: null, why: 'same' }, 'same lineup, rated recently: nothing to do');
    standings([played(0, ['kim_b-v1', 'heuristic', 'rush'])], new Date(now - 25 * HOUR).toISOString());
    assert.deepStrictEqual(planRound(opts), { round: 1, resume: false, why: 'stale' }, 'a day later the lineup plays again');

    standings([played(0, ['kim_b-v1', 'heuristic', 'rush'])]);
    version('kim_b', 2);
    assert.deepStrictEqual(planRound(opts), { round: 1, resume: false, why: 'changed' }, 'a new version');
    standings([played(1, ['kim_b-v2', 'heuristic', 'rush'])]);
    home.updateRoster((r) => ({ ...r, agents: [...r.agents, { name: 'lee', owner: 'github:lee' }] }));
    version('lee', 1);
    assert.deepStrictEqual(planRound(opts), { round: 2, resume: false, why: 'changed' }, 'a new competitor');
    standings([played(2, ['kim_b-v2', 'lee-v1', 'heuristic', 'rush'])]);
    home.updateRoster((r) => ({ ...r, agents: r.agents.map((a) => (a.name === 'lee' ? { ...a, withdrawn: [1] } : a)) }));
    assert.deepStrictEqual(planRound(opts), { round: 3, resume: false, why: 'changed' }, 'a withdrawn version leaves the lineup');
});

test('gamesctl warm: only the lineup\'s WebAssembly versions are compiled; the image has no bots of its own', () => {
    const { commands } = require('../arena/gamesctl');
    assert.deepStrictEqual(commands.warm(), { ok: true, warmed: [], failed: [] }, 'versions with no bundle: nothing to compile');
    // the lineup is kim_b-v2, heuristic and rush: kim_b-v2 gets a bundle (a broken one, which run.py refuses)
    writeJson(path.join(home.VERSIONS, 'kim_b-v2', 'bundle', 'arena.json'), {});
    writeJson(path.join(home.VERSIONS, 'lee-v1', 'bundle', 'arena.json'), {});
    const w = commands.warm();
    assert.deepStrictEqual([w.ok, w.warmed, w.failed.map((f) => f.name)], [true, [], ['kim_b-v2']], 'lee-v1 is withdrawn: not in the lineup');
    assert.strictEqual(typeof w.failed[0].error, 'string');
});

test('gamesctl setup: no baselines, whatever the roster had; it names the resident entries', () => {
    const { commands } = require('../arena/gamesctl');
    home.updateRoster((r) => ({ ...r, baselines: ['heuristic', 'c-clock-wasm'], agents: [...r.agents, { name: 'heuristic', owner: 'arena', resident: true }] }));
    const s = commands.setup();
    assert.deepStrictEqual([s.ok, s.residents], [true, ['heuristic']]);
    assert.deepStrictEqual(home.roster().baselines, []);
    assert.deepStrictEqual(home.roster().agents.map((a) => a.name), ['kim_b', 'lee', 'heuristic'], 'the competitors stay');
});

test('gamesctl: the referee gets the arena folders and the secret path, and no token', () => {
    process.env.SWU_WINDOW_TOKEN = 'leak';
    const env = botEnv();
    assert.deepStrictEqual(Object.keys(env).filter((k) => /TOKEN|PROXY|FLY/i.test(k)), []);
    assert.strictEqual(env.ARENA_HOME, process.env.ARENA_HOME);
    assert.strictEqual(env.ARENA_SECRET_FILE, path.join(tmp, 'secret', 'arena-secret'));
    assert.strictEqual(env.ARENA_BOT_USER, 'arena');
    delete process.env.SWU_WINDOW_TOKEN;
});
