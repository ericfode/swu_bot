'use strict';
// One-ply search through simulations (spec/protocol.md#sim): at each action window, try every action on a private
// copy of the game, play on until my next action window (the opponent passes when it can), score the board, keep the
// best. Runs in process or as a program, like random-bot.js:  node bot/examples/search-bot.js
const { seededRng } = require('../rng');
const { serve } = require('../stdio');

const sum = (units) => units.reduce((v, u) => v + u.p + u.h - u.d, 0);

/** Board score from `you`'s side: base damage dealt minus taken, units on board, cards in hand. */
function score(state, you) {
    const me = state.players[you];
    const opp = state.players[you === 'p1' ? 'p2' : 'p1'];
    return 3 * (opp.base.d - me.base.d) + sum([...me.ground, ...me.space]) - sum([...opp.ground, ...opp.space]) + me.handCount - opp.handCount;
}

function create(name = 'js-search', { width = 16, horizon = 40 } = {}) {
    let rng = seededRng(name);
    const pick = (r, you) => {
        const pass = r.actions.find((a) => a.kind === 'button' && /^pass$/i.test(a.label));
        return r.actor !== you && pass ? pass.i : Math.floor(rng() * r.actions.length);
    };
    return {
        name,
        hello(msg) {
            rng = seededRng(msg.seed);
            return { t: 'ready', v: 2, name, sim: true };
        },
        async decide(msg, sim) {
            if (!msg.sim) {
                return { t: 'act', i: Math.floor(rng() * msg.actions.length) };
            }
            let best = null;
            for (const a of msg.actions.slice(0, width)) {
                await sim({ t: 'sim', op: 'begin' });
                let r = await sim({ t: 'sim', op: 'act', i: a.i });
                for (let k = 0; k < horizon && !r.error && !r.over && !(r.actor === msg.you && r.prompt.actionWindow); k++) {
                    r = await sim({ t: 'sim', op: 'act', i: pick(r, msg.you) });
                }
                // an error reply has already ended the simulation
                const s = r.error ? -Infinity : r.over ? (r.over.winner === msg.you ? 1e6 : -1e6) : score(r.state, msg.you);
                if (!r.error) {
                    await sim({ t: 'sim', op: 'end' });
                }
                if (best === null || s > best.s) {
                    best = { i: a.i, s };
                }
            }
            return { t: 'act', i: best.i };
        }
    };
}

module.exports = { create, score };
if (require.main === module) {
    serve(create(process.argv[2]));
}
