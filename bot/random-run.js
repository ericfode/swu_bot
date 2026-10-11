'use strict';
// node bot/random-run.js [numGames] [startSeed] [maxSteps]
const { Env, seededRng } = require('./env');

async function main() {
    const n = Number(process.argv[2] ?? 3);
    const startSeed = Number(process.argv[3] ?? 1);
    const maxSteps = Number(process.argv[4] ?? 3000);
    const t0 = Date.now();
    const env = new Env();
    env.index();
    console.log(`init ${Date.now() - t0}ms; leaders/bases/pool = ${env.index().leaders.length}/${env.index().bases.length}/${env.index().pool.length}`);

    const sigs = new Map();
    const results = [];
    for (let i = 0; i < n; i++) {
        const seed = startSeed + i;
        const rng = seededRng('bot' + seed);
        const tg = Date.now();
        const eg = env.newGame({ seed, deck1: env.randomDeck(rng), deck2: env.randomDeck(rng) });
        const r = { seed, steps: 0, outcome: '?', ms: 0 };
        try {
            await eg.start();
            while (!eg.over && r.steps < maxSteps) {
                const order = rng() < 0.5 ? eg.ids : [...eg.ids].reverse();
                let acted = false;
                for (const pid of order) {
                    const acts = eg.legalActions(pid);
                    if (!acts.length) {
                        continue;
                    }
                    const sig = eg.promptSignature(pid);
                    sigs.set(sig, (sigs.get(sig) ?? 0) + 1);
                    eg.apply(pid, acts[Math.floor(rng() * acts.length)], rng);
                    acted = true; r.steps++;
                    break;
                }
                if (!acted) {
                    r.outcome = 'STUCK'; r.detail = eg.ids.map((p) => eg.player(p).currentPrompt().menuTitle).join(' || '); break;
                }
            }
            if (r.outcome === '?') {
                r.outcome = eg.over ? `won:${eg.winners.join(',')}` : 'STEP_CAP';
            }
            r.round = eg.round;
        } catch (e) {
            r.outcome = 'ERROR'; r.detail = String(e && e.message || e).split('\n')[0].slice(0, 200);
        }
        r.ms = Date.now() - tg;
        results.push(r);
        console.log(JSON.stringify(r));
    }
    const total = results.reduce((a, r) => a + r.ms, 0);
    console.log(`\n${n} games in ${total}ms (${(n / (total / 1000)).toFixed(2)} games/s)`);
    console.log('prompt signatures:', JSON.stringify([...sigs.entries()].sort((a, b) => b[1] - a[1]), null, 0));
}
main().catch((e) => {
    console.error('FATAL', e); process.exit(1);
});
