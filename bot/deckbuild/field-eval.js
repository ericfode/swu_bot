'use strict';

/**
 * Score candidate decks against a field: every candidate plays every field deck on one seed, both seats, with one
 * pilot bot in both seats (play.js). The check for any deck builder.
 *
 *   node bot/deckbuild/field-eval.js --candidates a.json[,b.json] --out DIR [--field bot/decks/ash-meta-2026-09.json]
 *        [--pilot c-clock] [--seed 50000000] [--workers 4] [--key K] [--group-by prefix]
 *
 * Candidates sharing a leader and base with a field deck use the same seeds against each field deck, so builders
 * can be compared pair by pair. Writes results.jsonl, candidates.json and summary.json (per candidate and per
 * group = the part of the name before the first ':').
 */
const fs = require('fs');
const path = require('path');
const { pairJobs, playDecks, scoreA } = require('./play');

const arg = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i > 0 ? process.argv[i + 1] : d;
};

function summarize(results) {
    const per = {},
        group = {};
    for (const r of results) {
        const s = scoreA(r);
        if (s === null) {
            continue;
        }
        const g = r.deck.split(':')[0];
        for (const [m, k] of [[per, r.deck], [group, g]]) {
            const e = (m[k] ??= { n: 0, sum: 0 });
            e.n++;
            e.sum += s;
        }
    }
    const fin = (m) => Object.fromEntries(Object.entries(m).map(([k, e]) => {
        const p = e.sum / e.n;
        const se = Math.sqrt((p * (1 - p)) / e.n);
        return [k, { games: e.n, score: +p.toFixed(4), ci95: [+(p - 1.96 * se).toFixed(4), +(p + 1.96 * se).toFixed(4)] }];
    }));
    return { groups: fin(group), decks: fin(per), errors: results.filter((r) => scoreA(r) === null).length, games: results.length };
}

async function main() {
    const pilot = arg('pilot', 'c-clock');
    const out = arg('out');
    const key = arg('key', 'deckbuild-eval');
    const seed0 = Number(arg('seed', 50000000));
    const field = JSON.parse(fs.readFileSync(arg('field', path.join(__dirname, '../decks/ash-meta-2026-09.json')), 'utf8'));
    const cands = arg('candidates').split(',').flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
    const lb = (d) => `${d.leader.id}/${d.base.id}`;
    const jobs = [];
    cands.forEach((c, ci) => {
        // seeds by (target, field deck), so candidates for the same target are paired. The target is the field deck
        // named after the first ':' of the candidate's name (builders and make-starts.js name them so), else the
        // field deck with the same leader and base ids
        const target = c.metadata.name.split(':').slice(1).join(':');
        let t = field.findIndex((f) => f.metadata.name === target);
        if (t < 0) {
            t = field.findIndex((f) => lb(f) === lb(c));
        }
        field.forEach((f, j) => {
            const seed = seed0 + (t >= 0 ? t : 1000 + ci) * field.length + j;
            jobs.push(...pairJobs([[c, f, { deck: c.metadata.name, field: f.metadata.name }]], { firstSeed: seed, pilot })
                .map((x) => ({ ...x, id: `${c.metadata.name}|${f.metadata.name}|${x.aSeat}` })));
        });
    });
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'candidates.json'), JSON.stringify(cands));
    const file = path.join(out, 'results.jsonl');
    fs.writeFileSync(file, '');
    console.log(`field-eval: ${cands.length} candidates x ${field.length} field decks x 2 seats = ${jobs.length} games, pilot ${pilot}`);
    const results = await playDecks(jobs, { workers: Number(arg('workers', 4)), key, out: file });
    const summary = { pilot, key, seed: seed0, ...summarize(results) };
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 1));
    console.log(JSON.stringify(summary.groups, null, 1));
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}

module.exports = { summarize };
