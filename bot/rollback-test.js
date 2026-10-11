'use strict';
// node bot/rollback-test.js -> checks the rollback properties the heuristic bot relies on.
const path = require('path');
const { Env, seededRng } = require('./env');
const { snapshot } = require('./recorder');
const { SnapshotType } = require(path.join(__dirname, '..', 'forceteki', 'build/server', 'game/core/Constants.js'));

const key = (eg, pid) => JSON.stringify([snapshot(eg), eg.legalActions(pid).map((a) => [a.kind, a.label, a.cardUuid, a.arg])]);
// prompt uuids change across a rollback (stale action objects are rejected), so actions are re-found by identity
const same = (x, y) => x.kind === y.kind && x.label === y.label && x.cardUuid === y.cardUuid && x.arg === y.arg;
const refetch = (eg, pid, a) => eg.legalActions(pid).find((x) => same(x, a));
const isWindow = (eg, pid) => eg.phase === 'action' && eg.promptSignature(pid).startsWith('actionWindow');
const restore = (eg, pid, id) => eg.game.rollbackToSnapshotInternal({ type: SnapshotType.Manual, playerId: eg.player(pid).id, snapshotId: id });
const results = {};

async function newGame(env, seed) {
    const rng = seededRng('bot' + seed);
    const eg = env.newGame({ seed, deck1: env.randomDeck(rng), deck2: env.randomDeck(rng), undo: true });
    await eg.start();
    return { eg, rng };
}

// 1+2: one snapshot, many rollbacks; prompt uuids and card uuids survive; heap stays bounded
async function repeated(env) {
    const { eg, rng } = await newGame(env, 2);
    let checks = 0, bad = 0, steps = 0;
    const heap0 = process.memoryUsage().heapUsed;
    while (!eg.over && steps < 500) {
        const pid = eg.ids.find((id) => eg.legalActions(id).length);
        const acts = eg.legalActions(pid);
        if (isWindow(eg, pid) && acts.length > 1) {
            const before = key(eg, pid);
            const id = eg.game.takeManualSnapshot(eg.player(pid));
            for (let i = 0; i < 6; i++) {
                const fresh = refetch(eg, pid, acts[i % acts.length]);
                if (!fresh) {
                    bad++;
                    break;
                }
                eg.apply(pid, fresh, rng);
                restore(eg, pid, id);
                if ((i === 1 || i === 5) && (checks++, key(eg, pid) !== before)) {
                    bad++;
                }
            }
        }
        const a2 = eg.legalActions(pid);
        eg.apply(pid, a2[Math.floor(rng() * a2.length)], rng);
        steps++;
    }
    results.repeated = { steps, checks, bad, heapMB: Math.round((process.memoryUsage().heapUsed - heap0) / 1e6) };
}

// 3a: a playout that ends the game must roll back to a live game
async function gameEnd(env) {
    const { eg, rng } = await newGame(env, 3);
    let last = null, steps = 0;
    while (!eg.over && steps < 2000) {
        const pid = eg.ids.find((id) => eg.legalActions(id).length);
        if (isWindow(eg, pid)) {
            last = { pid, id: eg.game.takeManualSnapshot(eg.player(pid)), key: key(eg, pid) };
        }
        const a = eg.legalActions(pid);
        eg.apply(pid, a[Math.floor(rng() * a.length)], rng);
        steps++;
    }
    const wasOver = eg.over;
    const ok = restore(eg, last.pid, last.id);
    results.gameEnd = { wasOver, rolledBack: ok, overAfter: eg.over, winnersAfter: eg.winners.length, stateRestored: key(eg, last.pid) === last.key };
}

// 3b: a playout that throws (seed 8, TakeCover) must roll back cleanly
async function throwing(env) {
    const { eg, rng } = await newGame(env, 8);
    let last = null, threw = null, steps = 0;
    // same actor order and choice as bot/match.js, so seed 8 reaches the TakeCover error
    while (!eg.over && steps < 500 && !threw) {
        const order = rng() < 0.5 ? eg.ids : [...eg.ids].reverse();
        const pid = order.find((id) => eg.legalActions(id).length);
        if (isWindow(eg, pid)) {
            last = { pid, id: eg.game.takeManualSnapshot(eg.player(pid)), key: key(eg, pid) };
        }
        const a = eg.legalActions(pid);
        try {
            eg.apply(pid, a[Math.floor(rng() * a.length)], rng);
        } catch (e) {
            threw = String(e.message).slice(0, 80);
        }
        steps++;
    }
    eg.sink.error = null;
    let ok = false, same = false, resumed = false;
    try {
        ok = restore(eg, last.pid, last.id);
        same = key(eg, last.pid) === last.key;
        const a = eg.legalActions(last.pid);
        eg.apply(last.pid, a[0], rng);
        resumed = true;
    } catch (e) {
        results.throwingRestoreError = String(e.message).slice(0, 100);
    }
    results.throwing = { threw, rolledBack: ok, stateRestored: same, canContinue: resumed };
}

(async () => {
    const env = new Env();
    await repeated(env);
    await gameEnd(env);
    await throwing(env);
    console.log(JSON.stringify(results, null, 1));
})().catch((e) => {
    console.error(e); process.exit(1);
});
