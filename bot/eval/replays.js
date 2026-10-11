#!/usr/bin/env node
'use strict';
/**
 * Turn recorded replays (tournament.js / arena.js / ladder format) into a position dataset that fit.js and score.js
 * read, so games recorded by other bots can be used for fitting and scoring.
 *
 *   node bot/eval/replays.js --from /mnt/project-files/results/omni-ref-1,... --out data/omni [--every 2]
 *
 * Writes <out>/positions/0.jsonl ({id, winner, outcome, n, round, toAct, state, hidden?}) and <out>/decks/0.jsonl. Positions
 * are the action-window checkpoints arena.js records (see replayPositions). Decklists are redrawn from the seed the way
 * match.js draws them and checked (see deckLists). Draws, errors and decided boards are skipped. A game id already seen
 * gets the source's position in --from and its folder name as a prefix; the same game recorded twice is kept once.
 */
const fs = require('fs');
const path = require('path');
const { readJsonl } = require('./data');
const { terminal } = require('./features');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

let envCache = null;
const env = () => (envCache ??= new (require('../env').Env)());

let revCache;
/** Full commit of the forceteki checkout the decks are redrawn with (null when git cannot tell). */
function engineRev() {
    if (revCache === undefined) {
        try {
            revCache = require('child_process').execFileSync('git', ['-C', path.join(__dirname, '..', '..', 'forceteki'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        } catch {
            revCache = null;
        }
    }
    return revCache;
}

const flat = (x) => x.deck.flatMap((c) => Array(c.count).fill(c.id));

/**
 * Both decklists as set codes. A header with `decks` (spec/replay-format.md), or an imported game's
 * `source.decklists` with both full lists, gives them exactly. Older replays only name
 * the decks, so they are redrawn from the seed the way match.js draws them; that depends on the engine's card pool and
 * env.js's deck builder, so a redraw is trusted only when the header names this engine commit, the deck names match,
 * and at every step the cards in each player's hand and discard pile (owner's real deck cards only, no tokens) fit
 * inside that player's redrawn list, counting copies. Otherwise null.
 */
function deckLists(seed, header, lines = []) {
    if (header?.t !== 'header') {
        return null;
    }
    if (header.decks?.p1?.deck && header.decks?.p2?.deck) {
        return { p1: flat(header.decks.p1), p2: flat(header.decks.p2) };
    }
    // imported human games (importer/karabast.js) keep lobby lists here; often only the recorder's own list is full
    const lobby = header.source?.decklists;
    if (lobby?.p1?.cards && lobby?.p2?.cards) {
        return { p1: flat({ deck: lobby.p1.cards }), p2: flat({ deck: lobby.p2.cards }) };
    }
    if (header.source) {
        return null; // an imported game: no seed to redraw from
    }
    const rev = engineRev();
    if (!header.engine || !rev || !rev.startsWith(header.engine)) {
        return null;
    }
    const { seededRng } = require('../env');
    const rng = seededRng('bot' + seed);
    const d = [env().randomDeck(rng), env().randomDeck(rng)];
    if (d.some((x, i) => x.metadata.name !== header.players?.[i]?.deck)) {
        return null;
    }
    const decks = { p1: flat(d[0]), p2: flat(d[1]) };
    for (const pid of ['p1', 'p2']) {
        const copies = new Map();
        for (const c of decks[pid]) {
            copies.set(c, (copies.get(c) ?? 0) + 1);
        }
        for (const l of lines) {
            const ps = l.t === 'step' ? l.state?.players?.[pid] : null;
            const seen = new Map();
            for (const c of ps ? [...(ps.hand ?? []), ...(ps.discard ?? [])] : []) {
                if (c.s && (seen.set(c.s, (seen.get(c.s) ?? 0) + 1).get(c.s) > (copies.get(c.s) ?? 0))) {
                    return null;
                }
            }
        }
    }
    return decks;
}

/**
 * Positions of one replay file, sampled like arena.js: the board right before an action-window decision (the next step's
 * prompt starts with `actionWindow`, in the action phase), every `every`-th such checkpoint, with that step's actor.
 * States inside a follow-up prompt (select, distribute, ...) are not checkpoints.
 */
function replayPositions(file, id, every = 1) {
    const lines = readJsonl(file);
    const end = lines.find((l) => l.t === 'end');
    if (!end || end.outcome !== 'won' || (end.winner !== 'p1' && end.winner !== 'p2')) {
        return null;
    }
    const steps = lines.filter((l) => l.t === 'step');
    // seats whose hand was never captured (one-seat imports): their hands are placeholders, so fit.js and score.js
    // skip those judges and the objective view
    const hidden = lines[0]?.source?.hiddenHands ?? [];
    const out = [];
    let seen = 0;
    for (let i = 0; i + 1 < steps.length; i++) {
        const prev = steps[i],
            e = steps[i + 1];
        if (e.prompt?.startsWith('actionWindow') && prev.state?.phase === 'action' && seen++ % every === 0 && terminal(prev.state, 'p1') === null) {
            out.push({ id, winner: end.winner, outcome: end.outcome, n: prev.n, round: prev.state.round, toAct: e.pid, state: prev.state, ...(hidden.length ? { hidden } : {}) });
        }
    }
    // the same game recorded twice (a folder listed twice, or a copied replay) has the same content digest
    const key = require('crypto').createHash('sha1').update(fs.readFileSync(file)).digest('hex');
    return { positions: out, decks: deckLists(lines[0]?.seed, lines[0], lines), key };
}

function main() {
    const from = [...new Set(arg('from', '').split(',').filter(Boolean).map((d) => path.resolve(d)))];
    const out = arg('out', null);
    const every = Number(arg('every', '2'));
    if (!from.length || !out || !Number.isInteger(every) || every < 1) {
        console.error('usage: node bot/eval/replays.js --from <tournament dir>[,...] --out <dataset dir> [--every N, a positive integer: keep every N-th action-window checkpoint]');
        process.exit(2);
    }
    for (const d of ['positions', 'decks']) {
        fs.rmSync(path.join(out, d), { recursive: true, force: true });
        fs.mkdirSync(path.join(out, d), { recursive: true });
    }
    const pos = fs.createWriteStream(path.join(out, 'positions', '0.jsonl'));
    const dk = fs.createWriteStream(path.join(out, 'decks', '0.jsonl'));
    const seen = new Set();
    const gameKeys = new Set();
    let games = 0,
        dupes = 0,
        n = 0,
        withDecks = 0;
    for (const [ti, t] of from.entries()) {
        const g = path.join(t, 'games');
        if (!fs.existsSync(g)) {
            console.error(`skipping ${t}: no games/ folder`);
            continue;
        }
        for (const f of fs.readdirSync(g).filter((f) => f.endsWith('.jsonl')).sort()) {
            // a game id seen before (same file name in another source) gets the source's index as a prefix
            let id = f.slice(0, -6);
            if (seen.has(id)) {
                id = `${ti}:${path.basename(t)}/${id}`;
            }
            seen.add(id);
            let r = null;
            try {
                r = replayPositions(path.join(g, f), id, every);
            } catch {
                // a replay still being written ends in a partial line; it has no result yet anyway
            }
            if (!r || !r.positions.length) {
                continue;
            }
            if (gameKeys.has(r.key)) {
                dupes++;
                continue;
            }
            gameKeys.add(r.key);
            games++;
            n += r.positions.length;
            for (const p of r.positions) {
                pos.write(`${JSON.stringify(p)}\n`);
            }
            if (r.decks) {
                withDecks++;
                dk.write(`${JSON.stringify({ id, ...r.decks })}\n`);
            }
        }
    }
    pos.end();
    dk.end();
    console.log(`${n} positions from ${games} games (${withDecks} with decklists; ${dupes} duplicate games skipped) -> ${out}`);
}

if (require.main === module) {
    main();
}
module.exports = { replayPositions, deckLists, engineRev };
