'use strict';
// Small checks for the parts the mock-LLM test does not reach: subsampling, answer files, parsing, privacy.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadGame, checkpoints } = require('../lib/game');
const { AnswerFileEvaluator } = require('../lib/llm');
const { renderLog } = require('../lib/render');
const { args, clamp01 } = require('../analyze');
const { gameFitness } = require('../fitness');

(async () => {
    const game = loadGame(path.join(__dirname, '../fixtures/fixture-game.jsonl'));

    // subsampled checkpoints cover every turn since the previous kept one
    const all = checkpoints(game);
    const few = checkpoints(game, { max: 10 });
    assert.strictEqual(few.length, 10);
    assert.strictEqual(few[0].step, all[0].step);
    assert.strictEqual(few[9].step, all[all.length - 1].step);
    assert.strictEqual(few.reduce((n, c) => n + c.actions.length, 0), all.reduce((n, c) => n + c.actions.length, 0));
    for (let j = 1; j < few.length; j++) {
        const prev = all.findIndex((c) => c.step === few[j - 1].step);
        assert.strictEqual(few[j].fromStep, all[prev + 1].fromStep);
    }
    assert(few.slice(1).some((c) => c.actor === null), 'merged spans with both players have no actor');

    // fitness: ownerless movement is reported, not silently dropped
    const a = {
        game: { id: 'g', winner: 'p1', players: [{ id: 'p1', bot: 'a' }, { id: 'p2', bot: 'b' }] },
        checkpoints: [0.5, 0.6, 0.4, 0.9].map((p, i) => ({ i, step: i, actions: [], actor: [null, 'p1', null, 'p2'][i], views: { objective: { p1: p } } }))
    };
    const fit = gameFitness(a);
    assert.strictEqual(fit.seats.p1.turns, 1);
    assert(Math.abs(fit.unattributed - 0.2 / 0.8) < 1e-9);

    // answer files: the same request id in two games
    const f = path.join(os.tmpdir(), `answers-${process.pid}.jsonl`);
    fs.writeFileSync(f, [{ game: 'g1', id: 'cp0-objective', output: { p_win: 0.1 } }, { game: 'g2', id: 'cp0-objective', output: { p_win: 0.9 } }, { id: 'omniscient', output: { evals: [] } }].map((x) => JSON.stringify(x)).join('\n'));
    const ev = new AnswerFileEvaluator([f]);
    const req = [{ id: 'cp0-objective' }, { id: 'omniscient' }];
    assert.strictEqual((await ev.run(req, 'g1')).get('cp0-objective').output.p_win, 0.1);
    assert.strictEqual((await ev.run(req, 'g2')).get('cp0-objective').output.p_win, 0.9);
    assert((await ev.run(req, 'g2')).get('omniscient').output, 'answers without a game apply to any game');
    fs.unlinkSync(f);

    // probabilities: missing or junk becomes null, not NaN
    assert.strictEqual(clamp01(undefined), null);
    assert.strictEqual(clamp01('x'), null);
    assert.strictEqual(clamp01(1.4), 1);
    assert.strictEqual(clamp01(0), 0);

    // flags without a value do not swallow the next path
    assert.deepStrictEqual(args(['--batch', 'replays/demo', '--model', 'm']), { _: ['replays/demo'], batch: true, model: 'm' });

    // subjective logs hide the opponent's picks from hidden zones
    const step = (n, pid, prompt, kind, label, title = '') => ({ n, pid, prompt, title, action: { kind, label }, state: { round: 1, phase: 'action' } });
    const steps = [{}, step(1, 'p2', 'displayCards|single|disp', 'displayCard', 'secret-card'), step(2, 'p2', '-|single', 'card', 'other-secret', 'Choose a card (because you are choosing from a hidden zone)'), step(3, 'p2', 'actionWindow|-', 'card', 'public-unit')];
    const log = renderLog(steps, 3, { pov: 'p1' });
    assert(!/secret/.test(log) && /public unit/.test(log), log);
    assert(/secret card/.test(renderLog(steps, 3, { pov: 'p2' })));

    console.log('ok: subsampling, fitness, answer files, parsing, privacy');
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
