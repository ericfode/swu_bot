'use strict';
// Simulations on the Rust engine, for a bot that asks for them in hello ("simEngine": "rust", spec/protocol.md#sim).
// The real game always runs on forceteki. A decision gets Rust simulations only when the Rust pool knows every card in
// the game; otherwise the referee serves forceteki simulations as usual. Positions come from the Rust state, in the
// protocol's shapes (rust-view.js). The Rust engine is Kessel (github.com/ericfode/kessel) as WebAssembly for Node,
// vendored in vendor/kessel at a pinned commit; the card pool it may play is pool.json here (the Kessel pool).
// holocron's bots/omni/rs/stress.js checks the Rust engine and these views against forceteki.
const path = require('path');
const { fullState } = require('./state');

const OPS = new Set(['begin', 'act', 'end']);
const NEVER = new Promise(() => undefined);
const firstLine = (e) => String(e?.message ?? e).split('\n')[0];

let engine = null;
/** { simulator, views } once per process, or null when the Rust engine cannot be loaded here (said once). */
function rustEngine() {
    engine ??= (async () => {
        try {
            const { createSimulator } = require('../../vendor/kessel/js/node');
            const { loadPool } = require('./pool');
            const { RustViews } = require('./rust-view');
            const pool = loadPool(process.env.SWU_RUST_POOL || path.join(__dirname, 'pool.json'));
            return { simulator: await createSimulator({ poolPath: pool.provenance.path }), views: new RustViews(pool) };
        } catch (e) {
            console.error(`Rust simulations are not available (${firstLine(e)}); bots that asked for them get forceteki ones`);
            return null;
        }
    })();
    return engine;
}

function shuffle(list, rng) {
    for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
}

/**
 * protocol.js determinize() on a full state instead of the engine: `you`'s deck order, and the opponent's hand,
 * face-down resources and deck from one shuffle of all three. Zone sizes and the number of exhausted resources stay.
 * (The Rust pool has no card that steals a resource, so every opponent resource is the opponent's own.)
 */
function determinizeState(state, you, rng) {
    const s = structuredClone(state);
    const me = s.players[you];
    const opp = s.players[you === 'p1' ? 'p2' : 'p1'];
    shuffle(me.deck, rng);
    const exhausted = opp.resources.filter((r) => r.exhausted).length;
    const resources = opp.resources.length;
    const hand = opp.hand.length;
    const unseen = shuffle([...opp.hand, ...opp.resources.map(({ exhausted: _, ...c }) => c), ...opp.deck], rng);
    opp.resources = unseen.splice(0, resources).map((c, k) => ({ ...c, exhausted: k < exhausted }));
    opp.hand = unseen.splice(0, hand);
    opp.deck = unseen;
    return s;
}

/**
 * The `sim` requests of one decision on the Rust engine, with the same contract as protocol.js simulator(): `deals`
 * is the seat's random stream per deal, `ms` the decision's time (null: none). The clock starts once the engine and
 * this position are loaded, as the bot's does. Resolves to null when Rust cannot play this game.
 */
async function rustSimulator(eg, pid, deals, ms) {
    const rust = await rustEngine();
    if (!rust) return null;
    const you = eg.seatOf(pid);
    const opp = you === 'p1' ? 'p2' : 'p1';
    let start;
    try {
        start = fullState(eg, pid);
        rust.simulator.loadState(start).free();
    } catch {
        return null; // a card outside the Rust pool, or an effect its state cannot express
    }
    const deadline = ms === null ? null : Date.now() + ms;
    let game = null,
        done = false,
        actor = null,
        acts = null,
        fresh = 0;
    // Rust refuses to list the actions of the seat that is not to move, where forceteki lists none
    const choices = (seat) => {
        try {
            return game.legalActions(seat);
        } catch (e) {
            if (/^actor mismatch/.test(firstLine(e))) return [];
            throw e;
        }
    };
    const left = () => (deadline === null ? null : Math.max(0, deadline - Date.now()));
    const close = () => {
        game?.free();
        game = null;
    };

    const position = (op) => {
        if (game.over) {
            acts = null;
            return { t: 'simulated', op, ms: left(), over: { winner: game.winner } };
        }
        // when both seats have a prompt (regroup resources), yours comes first
        actor = you;
        acts = choices(you);
        if (!acts.length) {
            actor = opp;
            acts = choices(opp);
        }
        if (!acts.length) {
            throw new Error('neither player can act');
        }
        const snap = game.snapshot();
        return {
            t: 'simulated', op, ms: left(), actor, prompt: rust.views.prompt(game, actor, acts), state: rust.views.view(snap, you),
            actions: rust.views.actions(snap, acts)
        };
    };

    const step = (req) => {
        if (req.op === 'end') {
            close();
            return { t: 'simulated', op: 'end', ms: left() };
        }
        if (req.op === 'begin') {
            if (req.deal !== undefined && !(Number.isSafeInteger(req.deal) && req.deal >= 0)) {
                throw new Error(`bad deal ${JSON.stringify(req.deal)}`);
            }
            close();
            // a deal without a number is one never used before in this decision
            game = rust.simulator.loadState(determinizeState(start, you, deals(req.deal ?? `new${fresh++}`)));
            return position('begin');
        }
        if (req.op !== 'act') {
            throw new Error(`unknown op ${JSON.stringify(req.op)}`);
        }
        if (!game) {
            throw new Error('no open simulation (send begin first)');
        }
        const a = Number.isInteger(req.i) ? acts?.[req.i] : undefined;
        if (!a) {
            throw new Error(acts ? `no action ${JSON.stringify(req.i)}` : 'the simulated game is over');
        }
        game.apply(actor, a.key);
        return position('act');
    };

    return {
        engine: 'rust',
        handle(req) {
            if (done || (deadline !== null && Date.now() > deadline)) {
                return NEVER;
            }
            try {
                return Promise.resolve(step(req ?? {}));
            } catch (e) {
                close();
                return Promise.resolve({ t: 'simulated', op: OPS.has(req?.op) ? req.op : null, ms: left(), error: firstLine(e) });
            }
        },
        finish() {
            done = true;
            close();
        }
    };
}

module.exports = { rustSimulator, determinizeState, rustEngine };
