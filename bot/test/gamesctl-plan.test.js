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
// a WebAssembly version, as the games machine plays them: SUBMISSION.json bot.kind wasm and a bundle/ with its
// arena.json (a broken one here, which run.py refuses: nothing in these tests plays it)
const version = (name, v) => {
    writeJson(path.join(home.VERSIONS, `${name}-v${v}`, 'SUBMISSION.json'), { name: `${name}-v${v}`, bot: { kind: 'wasm' }, submittedAt: new Date().toISOString() });
    writeJson(path.join(home.VERSIONS, `${name}-v${v}`, 'bundle', 'arena.json'), {});
};
// the starter v0 that api.register makes for a builder: a JS one, which the games machine never plays
const starter = (name) => {
    writeJson(path.join(home.VERSIONS, `${name}-v0`, 'SUBMISSION.json'), { name: `${name}-v0`, bot: { kind: 'js' }, submittedAt: new Date().toISOString() });
    fs.writeFileSync(path.join(home.VERSIONS, `${name}-v0`, 'bot.js'), 'module.exports = { createBot: () => ({ choose: () => 0 }) };');
};
const builder = (name) => {
    home.updateRoster((r) => ({ ...r, agents: [...r.agents, { name, owner: `github:${name}` }] }));
    starter(name);
};
const standings = (rounds, updatedAt = new Date().toISOString()) => writeJson(path.join(home.HOME, 'standings.json'), { rounds, updatedAt });
const played = (round, names, status = 'done') => ({ round, status, bots: names.map((name) => ({ name })) });
// the arena's own bots: resident entries with WebAssembly versions of their own (setup leaves no baselines)
const OWN = ['res_heuristic-v1', 'res_rush-v1'];

test('gamesctl plan: a round when a version comes in, after it settles; again when the lineup changes or the last round is a day old', () => {
    writeJson(path.join(home.HOME, 'roster.json'), {
        thinkCapMs: 60000, baselines: [], agents: [{ name: 'res_heuristic', owner: 'arena', resident: true }, { name: 'res_rush', owner: 'arena', resident: true }]
    });
    version('res_heuristic', 1);
    version('res_rush', 1);
    const now = Date.now();
    const opts = { replayMs: 24 * HOUR, settledSince: 0 };
    assert.deepStrictEqual(planRound(opts), { round: null, why: 'no-competitor' }, 'the arena\'s own bots alone: no round');

    builder('kim_b');
    assert.deepStrictEqual(planRound(opts), { round: null, why: 'no-competitor' }, 'a starter v0 plays nowhere here: still no competitor');
    version('kim_b', 1);
    assert.deepStrictEqual(planRound({ ...opts, settledSince: now }), { round: null, why: 'settling' }, 'a version that just came in settles first');
    assert.deepStrictEqual(planRound(opts), { round: 0, resume: false, why: 'changed' }, 'then the next round');

    standings([played(0, [...OWN, 'kim_b-v1'], 'running')]);
    assert.deepStrictEqual(planRound(opts), { round: 0, resume: true, why: 'resume' }, 'a round a stop cut short is finished');

    standings([played(0, [...OWN, 'kim_b-v1'])]);
    assert.deepStrictEqual(planRound(opts), { round: null, why: 'same' }, 'same lineup, rated recently: nothing to do');
    standings([played(0, [...OWN, 'kim_b-v1'])], new Date(now - 25 * HOUR).toISOString());
    assert.deepStrictEqual(planRound(opts), { round: 1, resume: false, why: 'stale' }, 'a day later the lineup plays again');

    standings([played(0, [...OWN, 'kim_b-v1'])]);
    version('kim_b', 2);
    assert.deepStrictEqual(planRound(opts), { round: 1, resume: false, why: 'changed' }, 'a new version');
    standings([played(1, [...OWN, 'kim_b-v2'])]);
    builder('lee');
    version('lee', 1);
    assert.deepStrictEqual(planRound(opts), { round: 2, resume: false, why: 'changed' }, 'a new competitor');
    standings([played(2, [...OWN, 'kim_b-v2', 'lee-v1'])]);
    home.updateRoster((r) => ({ ...r, agents: r.agents.map((a) => (a.name === 'lee' ? { ...a, withdrawn: [1] } : a)) }));
    assert.deepStrictEqual(planRound(opts), { round: 3, resume: false, why: 'changed' }, 'a withdrawn version leaves the lineup');
    // lee's starter v0 does not take its place: once that round is played, the lineup is the same
    standings([played(3, [...OWN, 'kim_b-v2'])]);
    assert.deepStrictEqual(planRound(opts), { round: null, why: 'same' }, 'lee fields nothing');
});

test('gamesctl warm: only the lineup\'s WebAssembly versions are compiled; the image has no bots of its own', () => {
    const { commands } = require('../arena/gamesctl');
    // every WebAssembly version has a bundle (a broken one, which run.py refuses), and the roster names bots built into the image
    home.updateRoster((r) => ({ ...r, baselines: ['heuristic', 'rush'] }));
    const w = commands.warm();
    // not kim_b-v1 (older), lee-v1 (withdrawn), the starters v0 (JS) or the baselines
    assert.deepStrictEqual([w.ok, w.warmed, w.failed.map((f) => f.name)], [true, [], [...OWN, 'kim_b-v2']], 'the lineup\'s versions only');
    assert.strictEqual(typeof w.failed[0].error, 'string');
    home.updateRoster((r) => ({ ...r, baselines: [] }));
});

test('gamesctl round: a version that is not a WebAssembly one stops the round before anything is written (a backstop: the lineup fields none)', () => {
    const referee = require('../arena/referee');
    const { commands } = require('../arena/gamesctl');
    const lineup = referee.lineup;
    // as if the lineup had fielded lee's JS starter v0 and a bot built into the image
    referee.lineup = () => [...OWN, 'lee-v0', 'heuristic'];
    try {
        const before = fs.readFileSync(home.ROSTER, 'utf8');
        assert.throws(() => commands.round({ arena: 'open', round: '4', 'cap-ms': '30000' }), /round 4: lee-v0, heuristic are not WebAssembly versions/);
        assert.strictEqual(fs.readFileSync(home.ROSTER, 'utf8'), before, 'the roster keeps its time limit');
        const bundles = path.join(tmp, 'bundles');
        assert.ok(!fs.existsSync(bundles) || !fs.readdirSync(bundles).length, 'no tar written');
    } finally {
        referee.lineup = lineup;
    }
});

test('gamesctl setup: no baselines, whatever the roster had; it names the resident entries', () => {
    const { commands } = require('../arena/gamesctl');
    // an older roster's: c-clock-wasm built into the image, and c_clock, the resident entry that replaces it
    home.updateRoster((r) => ({ ...r, baselines: ['heuristic', 'c-clock-wasm'], agents: [...r.agents, { name: 'c_clock', owner: 'arena', resident: true }] }));
    const s = commands.setup();
    assert.deepStrictEqual([s.ok, s.residents], [true, ['res_heuristic', 'res_rush', 'c_clock']]);
    assert.deepStrictEqual(home.roster().baselines, []);
    assert.deepStrictEqual(home.roster().agents.map((a) => a.name), ['res_heuristic', 'res_rush', 'kim_b', 'lee', 'c_clock'], 'the competitors stay');
});

test('gamesctl: the bot tools it starts (warm\'s run.py) get the arena folders, and no token or secret', () => {
    process.env.SWU_WINDOW_TOKEN = 'leak';
    process.env.ARENA_SECRET_FILE = path.join(tmp, 'secret', 'arena-secret');
    const env = botEnv();
    assert.deepStrictEqual(Object.keys(env).filter((k) => /TOKEN|PROXY|FLY|SECRET/i.test(k)), []);
    assert.strictEqual(env.ARENA_HOME, process.env.ARENA_HOME);
    assert.strictEqual(env.HOME, path.join(tmp, 'home'));
    assert.strictEqual(env.ARENA_BOT_USER, undefined);
    delete process.env.SWU_WINDOW_TOKEN;
    delete process.env.ARENA_SECRET_FILE;
});
