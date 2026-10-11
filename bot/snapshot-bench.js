'use strict';
// node bot/snapshot-bench.js [seed] -> times takeManualSnapshot / rollback and checks rollback restores state + legal actions.
const path = require('path');
const { Env, seededRng } = require('./env');
const { snapshot } = require('./recorder');
const { SnapshotType } = require(path.join(__dirname, '..', 'forceteki', 'build/server', 'game/core/Constants.js'));

(async () => {
    const seed = Number(process.argv[2] ?? 2);
    const env = new Env();
    const rng = seededRng('bot' + seed);
    const eg = env.newGame({ seed, deck1: env.randomDeck(rng), deck2: env.randomDeck(rng), undo: true });
    await eg.start();
    const g = eg.game;
    let steps = 0, snapMs = 0, snapN = 0, rbMs = 0, rbN = 0, mismatches = 0, replayDiffs = 0, replayChecks = 0;
    while (!eg.over && steps < 600) {
        const pid = eg.ids.find((id) => eg.legalActions(id).length);
        const acts = eg.legalActions(pid);
        const before = JSON.stringify(snapshot(eg));
        const beforeActs = JSON.stringify(acts.map((a) => [a.kind, a.label]));
        const player = eg.player(pid);
        let t = process.hrtime.bigint();
        const id = eg.phase === 'action' && eg.promptSignature(pid).startsWith('actionWindow') ? g.takeManualSnapshot(player) : -1;
        if (id === -1) { eg.apply(pid, acts[Math.floor(rng() * acts.length)], rng); steps++; continue; }
        snapMs += Number(process.hrtime.bigint() - t) / 1e6; snapN++;
        const a = acts[Math.floor(rng() * acts.length)];
        eg.apply(pid, a, rng);
        const afterFirst = JSON.stringify(snapshot(eg));
        t = process.hrtime.bigint();
        const ok = g.rollbackToSnapshotInternal({ type: SnapshotType.Manual, playerId: player.id, snapshotId: id });
        rbMs += Number(process.hrtime.bigint() - t) / 1e6; rbN++;
        const restored = JSON.stringify(snapshot(eg));
        const restoredActs = JSON.stringify(eg.legalActions(pid).map((x) => [x.kind, x.label]));
        if (!ok || restored !== before || restoredActs !== beforeActs) {
            mismatches++;
            if (mismatches <= 3) console.log('MISMATCH at step', steps, { ok, stateSame: restored === before, actsSame: restoredActs === beforeActs, label: a.label });
        }
        // is the engine RNG restored? re-apply the same action and compare
        const redo = eg.legalActions(pid).find((x) => x.kind === a.kind && x.label === a.label);
        if (redo) {
            eg.apply(pid, redo, rng);
            replayChecks++;
            if (JSON.stringify(snapshot(eg)) !== afterFirst) {
                replayDiffs++;
            }
        }
        steps++;
    }
    console.log(JSON.stringify({ steps, over: eg.over, snapshot_ms_avg: +(snapMs / snapN).toFixed(3), rollback_ms_avg: +(rbMs / rbN).toFixed(3), mismatches, replayChecks, replayDiffs }));
})().catch((e) => {
    console.error(e); process.exit(1);
});
