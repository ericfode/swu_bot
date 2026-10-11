'use strict';
// node bot/debug-seed.js <seed> [maxSteps]  -- replays a seed exactly like random-run and dumps context on error
const { Env, seededRng } = require('./env');

(async () => {
    const seed = Number(process.argv[2]); const maxSteps = Number(process.argv[3] ?? 6000);
    const env = new Env(); env.index();
    // replay RNG consumption exactly as random-run does (n=1 run per seed gives the same stream)
    const rng = seededRng('bot' + seed);
    const eg = env.newGame({ seed, deck1: env.randomDeck(rng), deck2: env.randomDeck(rng) });
    await eg.start();
    let last = null,
        lastPid = null,
        steps = 0;
    const hist = [];
    try {
        while (!eg.over && steps < maxSteps) {
            const order = rng() < 0.5 ? eg.ids : [...eg.ids].reverse();
            let acted = false;
            for (const pid of order) {
                const acts = eg.legalActions(pid);
                if (!acts.length) {
                    continue;
                }
                const a = acts[Math.floor(rng() * acts.length)];
                last = a; lastPid = pid;
                hist.push(`${pid} ${eg.promptSignature(pid)} :: ${eg.player(pid).currentPrompt().menuTitle} -> ${a.kind} ${a.label}`);
                eg.apply(pid, a, rng); acted = true; steps++; break;
            }
            if (!acted) {
                break;
            }
        }
        console.log('finished without error', eg.over, eg.winners, steps);
    } catch (e) {
        console.log('ERROR:', String(e.message).split('\n')[0]);
        console.log('stack:', String(e.stack).split('\n')
            .slice(1, 7)
            .join('\n'));
        console.log('last action:', JSON.stringify(last), 'by', lastPid);
        console.log('recent history:\n' + hist.slice(-8).join('\n'));
        for (const pid of eg.ids) {
            const p = eg.player(pid).currentPrompt();
            console.log(pid, 'prompt now:', JSON.stringify({ t: p.menuTitle, type: p.promptType, mode: p.selectCardMode, buttons: p.buttons }));
        }
    }
})();
