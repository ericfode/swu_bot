'use strict';

/**
 * Training data for deck models: many decks, each played against a sample of the field with one pilot in both seats.
 *
 *   node bot/deckbuild/gen-data.js --decks 600 --opps 8 --out /mnt/project-files/deckbuild/data/gen1 [--seed 1]
 *        [--pilot c-clock] [--workers 4] [--key K] [--parents file.json] [--kinds random,mut,stat,statmut]
 *
 * Decks use the leader and base of a real tournament deck (the field, bot/decks/ash-meta-2026-09.json), in turn:
 *   random    aspect-legal random cards
 *   mut       the real deck with k copies swapped for random aspect-legal cards, k in {2, 5, 10, 20}: card value by
 *             intervention (what a swap does near a deck that works)
 *   stat      decks.js statDeck, then k in {0, 5, 15} random swaps
 *   parent    a deck from --parents (e.g. builder output) with k in {0, 3, 8} swaps
 * Each deck plays `opps` field decks drawn at random, one seed each, both seats.
 * Writes decks.jsonl ({name, kind, parent, k, leader, base, cards}) and results.jsonl (play.js rows; `deck` = the
 * new deck, `field` = the field deck). Appends, so a run can be continued with a new --seed.
 */
const fs = require('fs');
const path = require('path');
const { Env } = require('../env');
const { CardPool } = require('./cards');
const { fromList, toList, randomDeck, statDeck, mutate } = require('./decks');
const { pairJobs, playDecks } = require('./play');
const { seededRng } = require('../rng');

const arg = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i > 0 ? process.argv[i + 1] : d;
};

async function main() {
    const n = Number(arg('decks', 300));
    const opps = Number(arg('opps', 8));
    const seed0 = Number(arg('seed', 1));
    const pilot = arg('pilot', 'c-clock');
    const workers = Number(arg('workers', 4));
    const key = arg('key', 'deckbuild-gen');
    const out = arg('out', '/mnt/project-files/deckbuild/data/gen1');
    const kinds = arg('kinds', 'random,mut,stat').split(',');
    const env = new Env();
    const pool = new CardPool(env);
    const field = require('../decks/ash-meta-2026-09.json').map((l) => fromList(l, pool));
    const parents = arg('parents', null) ? JSON.parse(fs.readFileSync(arg('parents'), 'utf8')).map((l) => fromList(l, pool)) : [];
    const rng = seededRng(`gen:${key}:${seed0}`);
    const pick = (a) => a[Math.floor(rng() * a.length)];
    fs.mkdirSync(out, { recursive: true });
    const decks = [];
    for (let i = 0; i < n; i++) {
        const kind = parents.length && kinds.includes('parent') && rng() < 0.5 ? 'parent' : pick(kinds.filter((k) => k !== 'parent'));
        const real = field[i % field.length];
        const name = `s${seed0}-${i}`;
        let d,
            parent = null,
            k = 0;
        if (kind === 'random') {
            d = randomDeck(pool, real.leader, real.base, rng);
        } else if (kind === 'mut') {
            k = pick([2, 5, 10, 20]);
            parent = real.name;
            d = mutate(pool, real, rng, k);
        } else if (kind === 'stat') {
            k = pick([0, 5, 15]);
            parent = `stat:${real.name}`;
            d = mutate(pool, statDeck(pool, real.leader, real.base), rng, k);
        } else {
            const p = pick(parents);
            k = pick([0, 3, 8]);
            parent = p.name;
            d = mutate(pool, p, rng, k);
        }
        decks.push({ ...d, name: `${name}:${kind}`, kind, parent, k });
    }
    const pairs = [];
    for (const d of decks) {
        const order = [...field];
        for (let i = order.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [order[i], order[j]] = [order[j], order[i]];
        }
        order.length = Math.min(opps, order.length);
        for (const f of order) {
            pairs.push([toList(d), toList(f), { deck: d.name, field: f.name, kind: d.kind }]);
        }
    }
    const jobs = pairJobs(pairs, { firstSeed: seed0 * 1000000, pilot });
    fs.appendFileSync(path.join(out, 'decks.jsonl'), decks.map((d) => JSON.stringify(d)).join('\n') + '\n');
    console.log(`gen: ${decks.length} decks x ${opps} opponents x 2 seats = ${jobs.length} games, pilot ${pilot} -> ${out}`);
    await playDecks(jobs, { workers, key, out: path.join(out, 'results.jsonl') });
    fs.writeFileSync(path.join(out, 'config.json'), JSON.stringify({ pilot, key, field: 'bot/decks/ash-meta-2026-09.json', opps, kinds, lastSeed: seed0 }, null, 1));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
