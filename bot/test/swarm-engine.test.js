'use strict';
// The browser swarm's runtime must play the same game as Node: a pack of this checkout (bot/swarm/pack.js), the engine
// loaded from it in memory (bot/swarm/engine.js), heuristic vs rush on a keyed deal, replay compared line by line.
// Needs the engine build and card data (forceteki/build, forceteki/test/json); skipped without them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const built = fs.existsSync(path.join(ROOT, 'forceteki', 'build', 'server', 'game', 'core', 'Game.js')) && fs.existsSync(path.join(ROOT, 'forceteki', 'test', 'json'));

async function play(req) {
    const { Env } = req('bot/env.js');
    const { playGame } = req('bot/match.js');
    const players = req('bot/players/index.js');
    const { snapshot } = req('bot/recorder.js');
    const lines = [];
    const r = await playGame(new Env(), { seed: 11, bots: [players.makeBot('heuristic', []), players.makeBot('rush', [])], key: 'a'.repeat(64), maxSteps: 3000, record: true, snapshot, onEvent: (e) => lines.push(JSON.stringify(e)) });
    return { r, lines };
}

test('a game under the swarm runtime is the same game as in Node', { skip: !built && 'no engine build here', timeout: 300000 }, async () => {
    const { pack, filesOf } = require('../swarm/pack');
    const { createEngineRuntime } = require('../swarm/engine');
    const { createRefereeHost } = require('../swarm/referee-host');
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-pack-'));
    try {
        pack({ root: ROOT, out });
        const native = await play((p) => require(path.join(ROOT, p)));
        const files = filesOf(JSON.parse(fs.readFileSync(path.join(out, 'engine.json'), 'utf8')));
        const rt = createEngineRuntime({ files });
        const swarm = await play((p) => rt.require(`/app/${p}`));
        assert.strictEqual(swarm.r.outcome, native.r.outcome);
        assert.strictEqual(swarm.lines.length, native.lines.length);
        swarm.lines.forEach((l, i) => assert.strictEqual(l, native.lines[i], `replay line ${i}`));

        // a seed of deck lists (rated rounds deal the tournament lists by seat): the swarm's referee plays the lists
        // the job gives, the same game as Node plays on them
        const { normalizeDeck } = require('../decklists');
        const lists = JSON.parse(fs.readFileSync(path.join(ROOT, 'bot', 'decks', 'ash-meta-2026-09.json'), 'utf8')).map(normalizeDeck);
        const job = {
            v: 1, seed: 11, key: 'b'.repeat(64), maxSteps: 3000, capMs: 60000, hangMs: 150000, gameMs: 840000, decks: [lists[2], lists[7]],
            games: [{ id: 'rush-vs-heuristic-11', p1: 'rush', p2: 'heuristic', decks: [0, 1] }], bots: { heuristic: { kind: 'resident' }, rush: { kind: 'resident' } }
        };
        const host = createRefereeHost({ files: filesOf(JSON.parse(fs.readFileSync(path.join(out, 'engine.json'), 'utf8'))), makeWorker: () => assert.fail('no bot program here') });
        host.prepare(job);
        const { result, replay } = await host.play(job, job.games[0].id);
        const head = JSON.parse(replay.split('\n')[0]);
        assert.deepStrictEqual(head.decks, { p1: lists[2], p2: lists[7] });
        const { Env } = require('../env');
        const { playGame } = require('../match');
        const players = require('../players');
        const { snapshot } = require('../recorder');
        const lines = [];
        const r = await playGame(new Env(), { seed: 11, bots: [players.makeBot('rush', []), players.makeBot('heuristic', [])], decks: { p1: structuredClone(lists[2]), p2: structuredClone(lists[7]) }, key: job.key, maxSteps: 3000, record: true, snapshot, onEvent: (e) => lines.push(JSON.stringify(e)) });
        assert.deepStrictEqual([result.outcome, result.steps, result.winnerSeat], [r.outcome, r.steps, r.winner]);
        assert.deepStrictEqual(replay.trim().split('\n').slice(0, -1), lines.slice(0, -1), 'the same game, board by board');
        host.close();
    } finally {
        fs.rmSync(out, { recursive: true, force: true });
    }
});
