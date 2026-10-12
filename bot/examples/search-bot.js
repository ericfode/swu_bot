'use strict';
// One-ply search through simulations (spec/protocol.md#sim): at each action window, try up to `width` actions on a
// private copy of the game, all on the same deal of the hidden cards, play on until my next action window (the opponent
// passes when it can), score the board, keep the best. Runs in process or as a program, like random-bot.js:  node bot/examples/search-bot.js
// The engine offers choices that change nothing (click a card, then Cancel its menu), and a search that scores them
// above passing would take them forever, so the bot never makes the same choice twice in the same situation.
const { createHash } = require('crypto');
const { seededRng } = require('../rng');
const { serve } = require('../stdio');

const sum = (units) => units.reduce((v, u) => v + u.p + u.h - u.d, 0);

/** Board score from `you`'s side: base damage dealt minus taken, units on board, cards in hand. */
function score(state, you) {
    const me = state.players[you];
    const opp = state.players[you === 'p1' ? 'p2' : 'p1'];
    return 3 * (opp.base.d - me.base.d) + sum([...me.ground, ...me.space]) - sum([...opp.ground, ...opp.space]) + me.handCount - opp.handCount;
}

function create(name = 'js-search', { width = 16, horizon = 40, simEngine = null } = {}) {
    let rng = null; // seeded at hello
    let tried = new Map(); // situation -> the choices already made in it this game
    const pick = (r, you) => {
        const pass = r.actions.find((a) => a.kind === 'button' && /^pass$/i.test(a.label));
        return r.actor !== you && pass ? pass.i : Math.floor(rng() * r.actions.length);
    };

    async function search(msg, sim, candidates) {
        let best = null;
        for (const a of candidates) {
            await sim({ t: 'sim', op: 'begin', deal: 0 });
            let r = await sim({ t: 'sim', op: 'act', i: a.i });
            for (let k = 0; k < horizon && !r.error && !r.over && !(r.actor === msg.you && r.prompt.actionWindow); k++) {
                r = await sim({ t: 'sim', op: 'act', i: pick(r, msg.you) });
            }
            const s = r.error ? -Infinity : r.over ? (r.over.winner === msg.you ? 1e6 : -1e6) : score(r.state, msg.you);
            await sim({ t: 'sim', op: 'end' }); // after an error there is nothing to end, which is fine
            if (best === null || s > best.s) {
                best = { i: a.i, s };
            }
        }
        return best.i;
    }

    return {
        name,
        hello(msg) {
            rng = seededRng(msg.seed);
            tried = new Map();
            // simEngine 'rust': simulate on the Rust engine when it knows every card in the game (spec/protocol.md#sim)
            return { t: 'ready', v: 2, name, sim: true, ...(simEngine ? { simEngine } : {}) };
        },
        async decide(msg, sim) {
            const here = createHash('sha1').update(JSON.stringify([msg.state, msg.prompt, msg.actions])).digest('hex');
            const done = tried.get(here) ?? new Set();
            tried.set(here, done);
            const fresh = msg.actions.filter((a) => !done.has(a.i));
            const options = fresh.length ? fresh : msg.actions;
            const i = msg.sim ? await search(msg, sim, options.slice(0, width)) : options[Math.floor(rng() * options.length)].i;
            done.add(i);
            return { t: 'act', i };
        }
    };
}

module.exports = { create };
if (require.main === module) {
    const at = process.argv.indexOf('--sim-engine');
    serve(create(process.argv[2], { simEngine: at > 0 ? process.argv[at + 1] : null }));
}
