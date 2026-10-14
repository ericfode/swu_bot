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
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-pack-'));
    try {
        pack({ root: ROOT, out });
        const native = await play((p) => require(path.join(ROOT, p)));
        const rt = createEngineRuntime({ files: filesOf(JSON.parse(fs.readFileSync(path.join(out, 'engine.json'), 'utf8'))) });
        const swarm = await play((p) => rt.require(`/app/${p}`));
        assert.strictEqual(swarm.r.outcome, native.r.outcome);
        assert.strictEqual(swarm.lines.length, native.lines.length);
        swarm.lines.forEach((l, i) => assert.strictEqual(l, native.lines[i], `replay line ${i}`));
    } finally {
        fs.rmSync(out, { recursive: true, force: true });
    }
});
