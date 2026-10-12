'use strict';
// The games machine's decisions (bot/arena/games.js): when to play a round. No engine or card data needed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'games-test-'));
process.env.ARENA_HOME = path.join(tmp, 'arena');
process.env.ARENA_RESULTS = path.join(tmp, 'results');
process.env.GAMES_DATA = tmp;
const home = require('../arena/home');
const { roundToPlay, botEnv } = require('../arena/games');

const HOUR = 3600000;
const writeJson = (file, doc) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(doc));
};
const version = (name, v) => writeJson(path.join(home.VERSIONS, `${name}-v${v}`, 'SUBMISSION.json'), { bot: { kind: 'wasm' }, submittedAt: new Date().toISOString() });
const standings = (rounds, updatedAt = new Date().toISOString()) => writeJson(path.join(home.HOME, 'standings.json'), { rounds, updatedAt });
const played = (round, names, status = 'done') => ({ round, status, bots: names.map((name) => ({ name })) });

test('games: a round when a version comes in, after it settles; again when the lineup changes or the last round is a day old', () => {
    writeJson(path.join(home.HOME, 'roster.json'), { thinkCapMs: 60000, baselines: ['heuristic', 'rush'], agents: [] });
    const now = Date.now();
    const opts = { replayMs: 24 * HOUR, settledSince: 0 };
    assert.strictEqual(roundToPlay(opts), null, 'no competitor: no round');

    home.updateRoster((r) => ({ ...r, agents: [{ name: 'kim_b', owner: 'github:kim-b' }] }));
    version('kim_b', 1);
    assert.strictEqual(roundToPlay({ ...opts, settledSince: now }), null, 'a version that just came in settles first');
    assert.deepStrictEqual(roundToPlay(opts), [], 'then the next round');

    standings([played(0, ['kim_b-v1', 'heuristic', 'rush'], 'running')]);
    assert.deepStrictEqual(roundToPlay(opts), ['--round', '0'], 'a round a stop cut short is finished');

    standings([played(0, ['kim_b-v1', 'heuristic', 'rush'])]);
    assert.strictEqual(roundToPlay(opts), null, 'same lineup, rated recently: nothing to do');
    standings([played(0, ['kim_b-v1', 'heuristic', 'rush'])], new Date(now - 25 * HOUR).toISOString());
    assert.deepStrictEqual(roundToPlay(opts), [], 'a day later the lineup plays again');

    standings([played(0, ['kim_b-v1', 'heuristic', 'rush'])]);
    version('kim_b', 2);
    assert.deepStrictEqual(roundToPlay(opts), [], 'a new version');
    standings([played(1, ['kim_b-v2', 'heuristic', 'rush'])]);
    home.updateRoster((r) => ({ ...r, agents: [...r.agents, { name: 'lee', owner: 'github:lee' }] }));
    version('lee', 1);
    assert.deepStrictEqual(roundToPlay(opts), [], 'a new competitor');
    standings([played(2, ['kim_b-v2', 'lee-v1', 'heuristic', 'rush'])]);
    home.updateRoster((r) => ({ ...r, agents: r.agents.map((a) => (a.name === 'lee' ? { ...a, withdrawn: [1] } : a)) }));
    assert.deepStrictEqual(roundToPlay(opts), [], 'a withdrawn version leaves the lineup');
});

test('games: the referee gets the arena folders and the secret path, and no token', () => {
    process.env.SWU_WINDOW_TOKEN = 'leak';
    const env = botEnv();
    assert.deepStrictEqual(Object.keys(env).filter((k) => /TOKEN|PROXY|FLY/i.test(k)), []);
    assert.strictEqual(env.ARENA_HOME, process.env.ARENA_HOME);
    assert.strictEqual(env.ARENA_SECRET_FILE, path.join(tmp, 'secret', 'arena-secret'));
    assert.strictEqual(env.ARENA_BOT_USER, 'arena');
    delete process.env.SWU_WINDOW_TOKEN;
});
