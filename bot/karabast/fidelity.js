#!/usr/bin/env node
'use strict';
/**
 * Does a bot on Karabast see what it sees in our own games? Plays random games in process (bot/env.js) and, at every
 * decision of seat p1, compares the `decide` message the referee would send (bot/view.js) with the one observe.js
 * builds from the Karabast frame of the same engine state (Game.getState, the object the Karabast server sends).
 * Needs the engine build (forceteki/build) and card json.
 *
 *   node bot/karabast/fidelity.js [--games 20] [--seed 1] [--decks bot/decks/ash-meta-2026-09.json] [--examples 3]
 *
 * Prints how many decisions matched, and for each field that differed how often and a few examples. Known gaps are
 * left out of the comparison: player `name` (seat labels here), `passed` (not in a frame), and the order of upgrades
 * and selected cards (a frame has no attach or selection order). Actions are compared as a set; a different order is
 * counted separately.
 */
const { Env, seededRng } = require('../env');
const { view, promptView, actionView } = require('../view');
const { Observer } = require('./observe');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

/** Paths where `a` and `b` differ, as "path: a vs b". */
function diff(a, b, at = '', out = []) {
    if (JSON.stringify(a) === JSON.stringify(b)) {
        return out;
    }
    const obj = (x) => x !== null && typeof x === 'object';
    if (obj(a) && obj(b) && Array.isArray(a) === Array.isArray(b)) {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const k of keys) {
            diff(a[k], b[k], at ? `${at}.${k}` : k, out);
        }
        return out;
    }
    out.push([at, JSON.stringify(a)?.slice(0, 80), JSON.stringify(b)?.slice(0, 80)]);
    return out;
}

/** Field paths with array indices folded, so one kind of mismatch counts once per decision. */
const fold = (p) => p.replace(/\.\d+(?=\.|$)/g, '[]');

function normalize(msg) {
    const m = JSON.parse(JSON.stringify(msg));
    const byCard = (x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1);
    for (const side of Object.values(m.state?.players ?? {})) {
        delete side.name;
        delete side.passed;
        // a frame lists upgrades in arena order, not in the order they were attached; the order means nothing
        for (const u of [...side.ground, ...side.space]) {
            u.u?.sort(byCard);
        }
    }
    if (m.prompt) {
        // a frame numbers selected cards only when the prompt keeps the order
        m.prompt.selected.sort();
    }
    const key = (a) => JSON.stringify({ ...a, i: undefined });
    m.actions = m.actions.map((a) => ({ ...a, i: undefined })).sort((x, y) => (key(x) < key(y) ? -1 : 1));
    return m;
}

async function main() {
    const games = Number(arg('games', 20));
    const seed0 = Number(arg('seed', 1));
    const show = Number(arg('examples', 3));
    const decks = arg('decks') ? require(require('path').resolve(arg('decks'))) : null;
    const env = new Env();
    const fields = new Map(); // folded path -> { n, examples }
    let decisions = 0;
    let exact = 0;
    let reordered = 0;
    let errors = 0;
    for (let g = 0; g < games; g++) {
        const seed = seed0 + g;
        const rng = seededRng(`fidelity-${seed}`);
        const pick = () => (decks ? decks[Math.floor(rng() * decks.length)] : env.randomDeck(rng));
        const eg = env.newGame({ seed, deck1: pick(), deck2: pick() });
        try {
            await eg.start();
            const me = eg.ids.find((id) => eg.seatOf(id) === 'p1');
            const obs = new Observer(me);
            obs.id = (uuid) => eg.cardId(uuid); // the referee's ids, so the two messages can be compared
            let steps = 0;
            while (!eg.over && steps++ < 3000) {
                const frame = eg.game.getState(me);
                obs.absorb(frame);
                const pid = eg.ids.find((id) => eg.legalActions(id).length);
                if (!pid) {
                    break;
                }
                const acts = eg.legalActions(pid);
                if (pid === me) {
                    decisions++;
                    const want = { prompt: promptView(eg, me), state: view(eg, 'p1'), actions: acts.map((a, i) => actionView(eg, a, i, me)) };
                    const d = obs.decision(frame);
                    const got = d ? { prompt: d.prompt, state: d.state, actions: d.actions } : { prompt: null, state: null, actions: [] };
                    const found = diff(normalize(want), normalize(got));
                    if (!found.length) {
                        exact++;
                        if (JSON.stringify(want.actions.map((a) => a.label)) !== JSON.stringify(got.actions.map((a) => a.label))) {
                            reordered++;
                        }
                    }
                    for (const p of new Set(found.map(([path]) => fold(path)))) {
                        const f = fields.get(p) ?? { n: 0, examples: [] };
                        f.n++;
                        if (f.examples.length < show) {
                            const ex = found.find(([path]) => fold(path) === p);
                            f.examples.push(`seed ${seed} round ${eg.round}: ${ex[0]} referee ${ex[1]} / karabast ${ex[2]}`);
                        }
                        fields.set(p, f);
                    }
                }
                eg.apply(pid, acts[Math.floor(rng() * acts.length)], rng);
            }
        } catch (e) {
            errors++;
            console.error(`seed ${seed}: ${String(e.message).split('\n')[0]}`);
        }
    }
    console.log(`${games} games, ${decisions} decisions of p1: ${exact} identical (${(100 * exact / Math.max(1, decisions)).toFixed(1)}%), ` +
        `${reordered} of those with the actions in another order; ${errors} games stopped by an engine error`);
    for (const [p, f] of [...fields].sort((a, b) => b[1].n - a[1].n)) {
        console.log(`${String(f.n).padStart(6)}  ${p}`);
        f.examples.forEach((x) => console.log(`          ${x}`));
    }
}

main().then(() => process.exit(0), (e) => {
    console.error(e);
    process.exit(1);
});
