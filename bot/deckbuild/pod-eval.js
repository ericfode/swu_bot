'use strict';

/**
 * Play the decks of each draft pod (draft.py output) against each other: every pair in a pod on one seed, both seats,
 * one pilot bot in both seats. Scores drafters by how their decks do against the other decks of the same pod.
 *
 *   node bot/deckbuild/pod-eval.js --pods pods.json --out DIR [--pilot c-clock] [--workers 4] [--key K] [--seed 70000000]
 *
 * Writes results.jsonl, candidates.json (every deck, for deck_jepa.py) and summary.json (score per drafter).
 */
const fs = require('fs');
const path = require('path');
const { pairJobs, playDecks, scoreA } = require('./play');

const arg = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i > 0 ? process.argv[i + 1] : d;
};

function summarize(results) {
    const by = {};
    for (const r of results) {
        const s = scoreA(r);
        if (s === null) {
            continue;
        }
        // both decks of the game score: A gets s, B gets 1 - s
        for (const [who, v] of [[r.drafterA, s], [r.drafterB, 1 - s]]) {
            const e = (by[who] ??= { n: 0, sum: 0 });
            e.n++;
            e.sum += v;
        }
    }
    const out = {};
    for (const [k, e] of Object.entries(by)) {
        const p = e.sum / e.n;
        const se = Math.sqrt((p * (1 - p)) / e.n);
        out[k] = { games: e.n, score: +p.toFixed(4), ci95: [+(p - 1.96 * se).toFixed(4), +(p + 1.96 * se).toFixed(4)] };
    }
    return { drafters: out, errors: results.filter((r) => scoreA(r) === null).length, games: results.length };
}

async function main() {
    const doc = JSON.parse(fs.readFileSync(arg('pods'), 'utf8'));
    const out = arg('out');
    const pilot = arg('pilot', 'c-clock');
    const seed0 = Number(arg('seed', 70000000));
    const jobs = [];
    const decks = [];
    let seed = seed0;
    for (const pod of doc.pods) {
        const ps = pod.players;
        ps.forEach((p) => decks.push({ ...p.deck, kind: p.drafter }));
        for (let i = 0; i < ps.length; i++) {
            for (let j = i + 1; j < ps.length; j++) {
                const a = ps[i],
                    b = ps[j];
                jobs.push(...pairJobs([[a.deck, b.deck, { deck: a.deck.metadata.name, field: b.deck.metadata.name, drafterA: a.drafter, drafterB: b.drafter }]],
                    { firstSeed: seed++, pilot }).map((x) => ({ ...x, id: `${a.deck.metadata.name}|${b.deck.metadata.name}|${x.aSeat}` })));
            }
        }
    }
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'candidates.json'), JSON.stringify(decks));
    const file = path.join(out, 'results.jsonl');
    fs.writeFileSync(file, '');
    console.log(`pod-eval: ${doc.pods.length} pods, ${jobs.length} games, pilot ${pilot}`);
    const results = await playDecks(jobs, { workers: Number(arg('workers', 4)), key: arg('key', 'deckbuild-draft'), out: file });
    const summary = { set: doc.set, builder: doc.builder, model: doc.model, pilot, ...summarize(results) };
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 1));
    console.log(JSON.stringify(summary.drafters, null, 1));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
