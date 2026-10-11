#!/usr/bin/env node
'use strict';
/**
 * Turn recorded replays (tournament.js / arena.js / ladder format) into a position dataset that fit.js and score.js
 * read, so games recorded by other bots can be used for fitting and scoring.
 *
 *   node bot/eval/replays.js --from /mnt/project-files/results/omni-ref-1,... --out data/omni [--every 2]
 *
 * Writes <out>/positions/0.jsonl ({id, winner, outcome, n, round, toAct, state}) and <out>/decks/0.jsonl. Replay step
 * n's state is the board after step n's move, so its next actor is step n+1's pid (the same rule as arena.js). Decklists
 * are redrawn from the seed the way match.js draws them and kept only when the deck names match the replay header.
 * Draws, errors and decided boards are skipped. Game ids are prefixed with the tournament id when two tournaments
 * use the same game id.
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

/** Both decklists as set codes, redrawn from the seed; null when the names do not match the header. */
function deckLists(seed, header) {
    const { seededRng } = require('../env');
    const rng = seededRng('bot' + seed);
    const d = [env().randomDeck(rng), env().randomDeck(rng)];
    if (header?.t !== 'header' || d.some((x, i) => x.metadata.name !== header.players?.[i]?.deck)) {
        return null;
    }
    const flat = (x) => x.deck.flatMap((c) => Array(c.count).fill(c.id));
    return { p1: flat(d[0]), p2: flat(d[1]) };
}

/** Positions of one replay file: every `every`-th undecided step with a known next actor. */
function replayPositions(file, id, every = 1) {
    const lines = readJsonl(file);
    const end = lines.find((l) => l.t === 'end');
    if (!end || end.outcome !== 'won' || (end.winner !== 'p1' && end.winner !== 'p2')) {
        return null;
    }
    const steps = lines.filter((l) => l.t === 'step');
    const out = [];
    for (let i = 0; i + 1 < steps.length; i += every) {
        const s = steps[i];
        if (!s.state || s.state.phase === 'setup' || terminal(s.state, 'p1') !== null) {
            continue;
        }
        out.push({ id, winner: end.winner, outcome: end.outcome, n: s.n, round: s.state.round, toAct: steps[i + 1].pid ?? null, state: s.state });
    }
    return { positions: out, decks: deckLists(lines[0]?.seed, lines[0]) };
}

function main() {
    const from = arg('from', '').split(',').filter(Boolean);
    const out = arg('out', null);
    const every = Number(arg('every', '2'));
    if (!from.length || !out) {
        console.error('usage: node bot/eval/replays.js --from <tournament dir>[,...] --out <dataset dir> [--every N]');
        process.exit(2);
    }
    for (const d of ['positions', 'decks']) {
        fs.rmSync(path.join(out, d), { recursive: true, force: true });
        fs.mkdirSync(path.join(out, d), { recursive: true });
    }
    const pos = fs.createWriteStream(path.join(out, 'positions', '0.jsonl'));
    const dk = fs.createWriteStream(path.join(out, 'decks', '0.jsonl'));
    const seen = new Set();
    let games = 0,
        n = 0,
        withDecks = 0;
    for (const t of from) {
        const g = path.join(t, 'games');
        for (const f of fs.readdirSync(g).filter((f) => f.endsWith('.jsonl')).sort()) {
            let id = f.slice(0, -6);
            if (seen.has(id)) {
                id = `${path.basename(t)}/${id}`;
            }
            seen.add(id);
            const r = replayPositions(path.join(g, f), id, every);
            if (!r || !r.positions.length) {
                continue;
            }
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
    console.log(`${n} positions from ${games} games (${withDecks} with decklists) -> ${out}`);
}

if (require.main === module) {
    main();
}
module.exports = { replayPositions, deckLists };
