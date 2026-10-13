#!/usr/bin/env node
'use strict';
/**
 * A paired test on one deck: each --bots entry holds --deck against the reference bot holding every deck of the deck
 * file, on the same seeds and seats, so two bots compare game for game on the deck a live bot actually plays.
 *
 *   node analysis/karabast/deck-test.js --deck luke-skywalker_jtl_data-vault --bots c-clock,c-clock2 [--ref c-clock]
 *        [--seeds 6] [--decks bot/decks/ash-meta-2026-09.json] [--shard i/n] --out <file.jsonl>
 *   node analysis/karabast/deck-test.js --summary <file.jsonl>...
 *
 * Games: every deck of the file (the mirror too) x --seeds x both seats, for each bot: 27 x 6 x 2 = 324 per bot by
 * default. --shard i/n plays every n-th game from i, for parallel processes; --summary joins the shards and prints
 * each bot's win rate and each bot minus the first one, paired by (opponent deck, seed, seat), with a 95% CI.
 * The standard test (analysis/realdeck/bot-test.js) stays the bar for a new bot; this one only zooms in on one deck.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

function wilson(k, n, z = 1.96) {
    const p = k / n;
    const d = 1 + (z * z) / n;
    const c = (p + (z * z) / (2 * n)) / d;
    const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
    return [c - h, c + h];
}

function summarize(rows) {
    const out = [];
    const bots = [...new Set(rows.map((r) => r.bot))];
    const by = new Map(bots.map((b) => [b, new Map()]));
    for (const r of rows) {
        by.get(r.bot).set(`${r.opp}|${r.seed}|${r.seat}`, r);
    }
    const pct = (x) => (100 * x).toFixed(1);
    for (const b of bots) {
        const dec = [...by.get(b).values()].filter((r) => r.win !== null);
        const w = dec.reduce((a, r) => a + r.win, 0);
        const [lo, hi] = wilson(w, dec.length);
        out.push(`${b.padEnd(16)} ${String(dec.length).padStart(4)} decided  win ${pct(w / dec.length)}% [${pct(lo)}, ${pct(hi)}]  incomplete ${by.get(b).size - dec.length}`);
    }
    const [first, ...rest] = bots;
    for (const b of rest) {
        const d = [];
        for (const [k, r] of by.get(b)) {
            const a = by.get(first).get(k);
            if (a && a.win !== null && r.win !== null) {
                d.push(r.win - a.win);
            }
        }
        const m = d.reduce((x, y) => x + y, 0) / d.length;
        const se = Math.sqrt(d.reduce((x, y) => x + (y - m) ** 2, 0) / (d.length - 1) / d.length);
        out.push(`${b} - ${first}: ${m >= 0 ? '+' : ''}${pct(m)} points [${pct(m - 1.96 * se)}, ${pct(m + 1.96 * se)}] over ${d.length} paired games (${b} better ${d.filter((x) => x > 0).length}, ${first} better ${d.filter((x) => x < 0).length})`);
    }
    return out.join('\n');
}

async function run() {
    const { Env } = require('../../bot/env');
    const { playGame } = require('../../bot/match');
    const { StdioClient } = require('../../bot/stdio');
    const { loadDecks } = require('../../bot/decklists');
    const deckName = arg('deck');
    const bots = (arg('bots') ?? '').split(',').filter(Boolean);
    const refName = arg('ref', 'c-clock');
    const seeds = Number(arg('seeds', 6));
    const deckFile = arg('decks', path.join(ROOT, 'bot', 'decks', 'ash-meta-2026-09.json'));
    const [si, sn] = arg('shard', '0/1').split('/').map(Number);
    const outFile = arg('out');
    if (!deckName || !bots.length || !outFile) {
        throw new Error('usage: deck-test.js --deck <name> --bots a,b [--ref c-clock] [--seeds 6] [--shard i/n] --out <file.jsonl>');
    }
    const programs = JSON.parse(fs.readFileSync(path.join(ROOT, 'bot', 'external-bots.json'), 'utf8'));
    for (const b of [...bots, refName]) {
        if (!programs[b]) {
            throw new Error(`unknown bot program ${b} (bot/external-bots.json)`);
        }
    }
    const env = new Env();
    const { decks } = loadDecks(deckFile, env);
    const mine = decks.find((d) => d.metadata.name === deckName);
    if (!mine) {
        throw new Error(`no deck named ${deckName} in ${deckFile}`);
    }
    const client = (name, tag) => new StdioClient(`${name}#${tag}`, { ...programs[name], stderr: 'ignore' });
    const ref = client(refName, 'ref');
    const test = Object.fromEntries(bots.map((b) => [b, client(b, 'test')]));
    const sink = fs.createWriteStream(outFile);
    // bot programs do not hold the event loop open between replies
    const keep = setInterval(() => undefined, 1000);
    try {
        let job = 0;
        for (const [di, opp] of decks.entries()) {
            for (let s = 1; s <= seeds; s++) {
                for (const seat of ['p1', 'p2']) {
                    if (job++ % sn !== si) {
                        continue;
                    }
                    const seed = 1000 + s * 7 + di * 101;
                    for (const b of bots) {
                        const pair = seat === 'p1' ? [test[b], ref] : [ref, test[b]];
                        const dk = seat === 'p1' ? { p1: structuredClone(mine), p2: structuredClone(opp) } : { p1: structuredClone(opp), p2: structuredClone(mine) };
                        let r;
                        try {
                            r = await playGame(env, { seed, bots: pair, decks: dk, key: `deck-test-${deckName}` });
                        } catch (e) {
                            r = { outcome: 'ERROR', error: String(e.message).slice(0, 200), winner: null, round: 0, steps: 0 };
                        }
                        const decided = r.outcome !== 'ERROR' && r.winner;
                        sink.write(`${JSON.stringify({ bot: b, deck: deckName, opp: opp.metadata.name, seed, seat, outcome: r.outcome, win: decided ? (r.winner === seat ? 1 : 0) : null, round: r.round, steps: r.steps, error: r.error ?? null })}\n`);
                    }
                }
            }
        }
    } finally {
        clearInterval(keep);
        await new Promise((resolve) => sink.end(resolve));
        for (const c of [ref, ...Object.values(test)]) {
            await c.close();
        }
    }
    if (sn === 1) {
        console.log(summarize(fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))));
    }
}

function main() {
    const i = process.argv.indexOf('--summary');
    if (i > 0) {
        const rows = process.argv.slice(i + 1).flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
        console.log(summarize(rows));
        return;
    }
    run().catch((e) => {
        console.error(e.message);
        process.exit(1);
    });
}

if (require.main === module) {
    main();
}

module.exports = { summarize };
