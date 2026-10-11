'use strict';

/**
 * Experiment 1: can our bots tell a good deck from a bad one?
 *
 * For each of the 27 real tournament decks (bot/decks/ash-meta-2026-09.json) we make other decks with the SAME leader
 * and base: `random` (aspect-legal random cards, two of them) and `stat` (decks.js statDeck). Every candidate plays every
 * real deck of the field on the same seed (both seats), with one pilot bot in both seats. If the real decks score well
 * above the random ones, deck quality is visible to the pilot and a deck builder can be measured with it.
 *
 *   node bot/deckbuild/exp-visible.js [--pilot c-clock] [--workers 4] [--out DIR] [--key K] [--only real,random,stat]
 */
const fs = require('fs');
const path = require('path');
const { Env } = require('../env');
const { CardPool } = require('./cards');
const { fromList, toList, randomDeck, statDeck } = require('./decks');
const { pairJobs, playDecks, scoreA } = require('./play');
const { seededRng } = require('../rng');

const arg = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i > 0 ? process.argv[i + 1] : d;
};

function summarize(results) {
    const by = new Map();
    for (const r of results) {
        const s = scoreA(r);
        if (s === null) {
            continue;
        }
        const k = r.kind;
        if (!by.has(k)) {
            by.set(k, []);
        }
        by.get(k).push(s);
    }
    const rows = {};
    for (const [k, xs] of by) {
        const m = xs.reduce((a, b) => a + b, 0) / xs.length;
        const se = Math.sqrt((m * (1 - m)) / xs.length);
        rows[k] = { games: xs.length, score: +m.toFixed(4), ci95: [+(m - 1.96 * se).toFixed(4), +(m + 1.96 * se).toFixed(4)] };
    }
    // paired: the same field deck and seed, real vs each other kind, per leader deck
    const cell = new Map();
    for (const r of results) {
        const s = scoreA(r);
        if (s === null) {
            continue;
        }
        const k = `${r.deck}|${r.field}`;
        if (!cell.has(k)) {
            cell.set(k, {});
        }
        const c = cell.get(k);
        (c[r.kind] ??= []).push(s);
    }
    const paired = {};
    for (const kind of Object.keys(rows).filter((k) => k !== 'real')) {
        const diffs = [];
        for (const c of cell.values()) {
            if (c.real && c[kind]) {
                const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
                diffs.push(mean(c.real) - mean(c[kind]));
            }
        }
        const m = diffs.reduce((a, b) => a + b, 0) / diffs.length;
        const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - m) ** 2, 0) / (diffs.length - 1));
        paired[`real-minus-${kind}`] = { cells: diffs.length, diff: +m.toFixed(4), ci95: [+(m - 1.96 * sd / Math.sqrt(diffs.length)).toFixed(4), +(m + 1.96 * sd / Math.sqrt(diffs.length)).toFixed(4)] };
    }
    // per leader deck: real vs random
    const perDeck = {};
    for (const r of results) {
        const s = scoreA(r);
        if (s === null) {
            continue;
        }
        const d = (perDeck[r.deck] ??= {});
        (d[r.kind] ??= [0, 0]);
        d[r.kind][0] += s;
        d[r.kind][1]++;
    }
    for (const d of Object.values(perDeck)) {
        for (const k of Object.keys(d)) {
            d[k] = +(d[k][0] / d[k][1]).toFixed(3);
        }
    }
    const errors = results.filter((r) => scoreA(r) === null).length;
    return { rows, paired, perDeck, errors, games: results.length };
}

async function main() {
    const pilot = arg('pilot', 'c-clock');
    const workers = Number(arg('workers', 4));
    const key = arg('key', 'deckbuild-exp1');
    const only = new Set(arg('only', 'real,random,stat').split(','));
    const out = arg('out', path.join(fs.existsSync('/mnt/project-files') ? '/mnt/project-files/deckbuild' : 'replays/deckbuild', `exp1-${pilot}`));
    const env = new Env();
    const pool = new CardPool(env);
    const real = require('../decks/ash-meta-2026-09.json').map((l) => fromList(l, pool));
    const rng = seededRng('exp1-decks');
    const cands = [];
    for (const d of real) {
        const lb = { leader: d.leader, base: d.base };
        if (only.has('real')) {
            cands.push({ kind: 'real', deck: d.name, list: toList(d) });
        }
        for (let k = 0; k < 2; k++) {
            const r = randomDeck(pool, lb.leader, lb.base, rng, { name: `random${k}:${d.name}` });
            if (only.has('random')) {
                cands.push({ kind: 'random', deck: d.name, list: toList(r) });
            }
        }
        if (only.has('stat')) {
            cands.push({ kind: 'stat', deck: d.name, list: toList(statDeck(pool, lb.leader, lb.base, { name: `stat:${d.name}` })) });
        }
    }
    const field = real.map((d) => ({ name: d.name, list: toList(d) }));
    // the same seed for every candidate against field deck j from leader deck i: candidates are paired
    const jobs = [];
    real.forEach((d, i) => {
        field.forEach((f, j) => {
            const seed = 1 + i * field.length + j;
            for (const c of cands.filter((x) => x.deck === d.name)) {
                const [a, b] = pairJobs([[c.list, f.list, { kind: c.kind, deck: c.deck, field: f.name }]], { firstSeed: seed, pilot });
                jobs.push({ ...a, id: `${c.list.metadata.name}|${f.name}|a` }, { ...b, id: `${c.list.metadata.name}|${f.name}|b` });
            }
        });
    });
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'candidates.json'), JSON.stringify(cands.map((c) => c.list)));
    const file = path.join(out, 'results.jsonl');
    fs.writeFileSync(file, '');
    console.log(`exp1: ${cands.length} candidates x ${field.length} field decks x 2 seats = ${jobs.length} games, pilot ${pilot} -> ${out}`);
    const results = await playDecks(jobs, { workers, key, out: file });
    const summary = { experiment: 'exp1-visible', pilot, key, field: 'bot/decks/ash-meta-2026-09.json', ...summarize(results) };
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 1));
    console.log(JSON.stringify({ rows: summary.rows, paired: summary.paired, errors: summary.errors }, null, 1));
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}

module.exports = { summarize };
