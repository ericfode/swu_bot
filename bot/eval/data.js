'use strict';

/**
 * Load evaluator training/test data written by bot/eval/arena.js (--record positions|full).
 *
 * A dataset dir holds positions/<shard>.jsonl (one checkpoint per line: id, winner, toAct, state) and
 * decks/<shard>.jsonl (both decklists per game). Each decided checkpoint gives two rows, one per judge,
 * labelled 1 when the judge went on to win.
 */

const fs = require('fs');
const path = require('path');

function readJsonl(file) {
    if (!fs.existsSync(file)) {
        return [];
    }
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function readDir(dir, sub) {
    const d = path.join(dir, sub);
    if (!fs.existsSync(d)) {
        return [];
    }
    return fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')).sort().flatMap((f) => readJsonl(path.join(d, f)));
}

/** Stable split by game id: about `testShare` of games go to test. */
function isTest(id, testShare = 0.2) {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) {
        h = Math.imul(h ^ id.charCodeAt(i), 16777619);
    }
    return ((h >>> 0) % 1000) / 1000 < testShare;
}

/**
 * Positions from one or more dataset dirs, each tagged with its source name (the dir's basename).
 * Returns [{ source, id, n, round, toAct, winner, state, decks, test }] for decided games only.
 */
function loadPositions(dirs, { testShare = 0.2 } = {}) {
    const out = [];
    for (const dir of dirs) {
        const source = path.basename(dir);
        const decks = new Map(readDir(dir, 'decks').map((d) => [d.id, { p1: d.p1, p2: d.p2 }]));
        for (const p of readDir(dir, 'positions')) {
            if (p.outcome !== 'won' || (p.winner !== 'p1' && p.winner !== 'p2')) {
                continue;
            }
            out.push({ source, id: p.id, n: p.n, round: p.round, toAct: p.toAct, winner: p.winner, state: p.state, decks: decks.get(p.id) ?? null, test: isTest(p.id, testShare) });
        }
    }
    return out;
}

module.exports = { loadPositions, readJsonl, isTest };
