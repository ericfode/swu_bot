'use strict';
// node bot/determinize-check.js [seed] -> determinization keeps zone sizes and ready counts, games keep running, rollback restores exactly
const { Env, seededRng } = require('./env');
const { snapshot } = require('./recorder');
const { BeliefModel, determinize } = require('./players/belief');

const key = (eg, pid) => JSON.stringify([snapshot(eg), eg.legalActions(pid).map((a) => [a.kind, a.label, a.cardUuid, a.arg]),
    eg.ids.map((id) => [eg.player(id).hand.map((c) => c.uuid), eg.player(id).drawDeck.map((c) => c.uuid), eg.player(id).resources.map((c) => c.uuid + c.exhausted)])]);

(async () => {
    const env = new Env();
    let checks = 0, bad = 0, moved = 0, playErr = 0;
    for (const seed of [1, 2, 3, 4]) {
        const rng = seededRng('bot' + seed);
        const eg = env.newGame({ seed, deck1: env.randomDeck(rng), deck2: env.randomDeck(rng), undo: true });
        await eg.start();
        const belief = new BeliefModel(2);
        const prng = seededRng('det' + seed);
        let steps = 0;
        while (!eg.over && steps < 800) {
            const pid = eg.ids.find((id) => eg.legalActions(id).length);
            const acts = eg.legalActions(pid);
            if (eg.isActionWindow(pid) && steps % 3 === 0) {
                belief.observe(eg, pid);
                const before = key(eg, pid);
                const opp = eg.player(pid).opponent;
                const sizes = [opp.hand.length, opp.resources.length, opp.drawDeck.length, opp.readyResourceCount, eg.player(pid).drawDeck.length];
                const id = eg.mark(pid);
                for (let i = 0; i < 3; i++) {
                    moved += determinize(eg, pid, belief, prng);
                    const after = [opp.hand.length, opp.resources.length, opp.drawDeck.length, opp.readyResourceCount, eg.player(pid).drawDeck.length];
                    if (after.join() !== sizes.join()) { bad++; console.log('size mismatch', sizes, after); }
                    try {
                        for (let k = 0; k < 6 && !eg.over; k++) {
                            const p2 = eg.ids.find((x) => eg.legalActions(x).length);
                            if (!p2) break;
                            const a2 = eg.legalActions(p2);
                            eg.apply(p2, a2[Math.floor(prng() * a2.length)], prng);
                        }
                    } catch (e) { playErr++; }
                    eg.restore(pid, id);
                    checks++;
                    if (key(eg, pid) !== before) { bad++; console.log('restore mismatch at step', steps); }
                }
            }
            const live = eg.legalActions(pid);
            eg.apply(pid, live[Math.floor(rng() * live.length)], rng);
            steps++;
        }
        console.log('seed', seed, 'steps', steps, 'evidence names', belief.evidence.size, 'obs', belief.observations);
    }
    console.log({ checks, bad, moved, playErr });
    process.exit(bad ? 1 : 0);
})();
