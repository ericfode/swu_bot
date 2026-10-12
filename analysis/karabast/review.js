#!/usr/bin/env node
'use strict';
/**
 * Strategy review of the live Karabast bot: compare the bots that played (c-clock, c-clock2, ...) on the games
 * games.js wrote, with the facts losses.js reads per game.
 *
 *   node analysis/karabast/review.js --games <games.js out dir> [--since <ISO time>] [--json review.json]
 *
 * Per bot: wins and losses (all games, and games that reached round 2) with a 95% range; the same split by 6-hour
 * block of the UTC day, since opponents change with the time of day and a bot that played only in the afternoon
 * is not comparable with one that played all night; then the play facts (Pilot deploys, duplicate uniques, leader
 * defeats, base hits, the opponent's removal and healing, the race at the start of round 5) and the opponents'
 * leaders it met most.
 */
const fs = require('fs');
const path = require('path');
const { gameFacts } = require('./losses');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

function wilson(k, n, z = 1.96) {
    if (!n) {
        return [0, 0];
    }
    const p = k / n;
    const d = 1 + (z * z) / n;
    const c = (p + (z * z) / (2 * n)) / d;
    const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
    return [c - h, c + h];
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r1 = (x) => (x === null ? null : Math.round(x * 10) / 10);

function record(rows) {
    const w = rows.filter((r) => r.result === 'win').length;
    const [lo, hi] = wilson(w, rows.length);
    return { games: rows.length, won: w, lost: rows.length - w, rate: rows.length ? w / rows.length : null, lo, hi };
}

function review(index, dir) {
    const out = { at: new Date().toISOString(), bots: {} };
    const bots = [...new Set(index.map((r) => r.bot))];
    for (const bot of bots) {
        const rows = index.filter((r) => r.bot === bot);
        const played = rows.filter((r) => ['p1', 'p2'].includes(r.ours) && r.round >= 2);
        const facts = played.map((row) => {
            const events = fs.readFileSync(path.join(dir, 'games', `${row.id}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
            return gameFacts(row, events);
        });
        const blocks = {};
        for (const r of played) {
            const h = new Date(r.at).getUTCHours();
            const k = `${String(h - (h % 6)).padStart(2, '0')}-${String(h - (h % 6) + 6).padStart(2, '0')}`;
            (blocks[k] ??= []).push(r);
        }
        const deploys = facts.flatMap((f) => f.deploys);
        const defeats = facts.flatMap((f) => f.leaderDefeats);
        const lost = facts.filter((f) => !f.won);
        const at5 = (set) => set.map((f) => f.rounds.find((x) => x.r === 5)).filter(Boolean);
        const opp = {};
        for (const f of facts) {
            const leader = (f.oppDeck ?? '?').split(' / ')[0];
            opp[leader] ??= { games: 0, won: 0 };
            opp[leader].games++;
            opp[leader].won += f.won ? 1 : 0;
        }
        const endRounds = {};
        for (const f of lost) {
            endRounds[f.round] = (endRounds[f.round] ?? 0) + 1;
        }
        out.bots[bot] = {
            first: rows[0]?.at ?? null, last: rows[rows.length - 1]?.at ?? null,
            all: record(rows), round2: record(played),
            blocks: Object.fromEntries(Object.entries(blocks).sort().map(([k, v]) => [k, record(v)])),
            deploys: deploys.length, pilotDeploys: deploys.filter((d) => d.pilot).length,
            leaderDefeated: defeats.length, leaderDefeatedSameRound: defeats.filter((d) => d.after === 0).length,
            dupUnique: facts.reduce((a, f) => a + f.dupUnique.length, 0),
            lossRounds: endRounds,
            lostGames: {
                oppRemoval: r1(mean(lost.map((f) => f.oppRemoval))), oppHealed: r1(mean(lost.map((f) => f.healed.opp))),
                ourHit: r1(mean(lost.flatMap((f) => f.baseHits.me))), theirHit: r1(mean(lost.flatMap((f) => f.baseHits.opp))),
                round5: at5(lost).length ? {
                    games: at5(lost).length, taken: r1(mean(at5(lost).map((x) => x.me.baseD))), dealt: r1(mean(at5(lost).map((x) => x.opp.baseD))),
                    power: r1(mean(at5(lost).map((x) => x.me.power))), oppPower: r1(mean(at5(lost).map((x) => x.opp.power))),
                    hand: r1(mean(at5(lost).map((x) => x.me.hand))), oppHand: r1(mean(at5(lost).map((x) => x.opp.hand)))
                } : null
            },
            oppLeaders: Object.entries(opp).sort((a, b) => b[1].games - a[1].games).slice(0, 8).map(([leader, v]) => ({ leader, ...v }))
        };
    }
    return out;
}

function text(rv) {
    const pct = (x) => (x === null ? '-' : `${(100 * x).toFixed(0)}%`);
    const rec = (r) => `${r.won}-${r.lost} ${pct(r.rate)} [${pct(r.lo)}, ${pct(r.hi)}]`;
    const lines = [];
    for (const [bot, b] of Object.entries(rv.bots)) {
        lines.push(`${bot}: ${b.first?.slice(0, 16)} to ${b.last?.slice(0, 16)} UTC`);
        lines.push(`  all games ${rec(b.all)}; reached round 2 ${rec(b.round2)}`);
        lines.push(`  by UTC block (round 2+): ${Object.entries(b.blocks).map(([k, r]) => `${k} ${r.won}-${r.lost}`).join(', ')}`);
        lines.push(`  leader deploys ${b.deploys} (Pilot ${b.pilotDeploys}), defeated again ${b.leaderDefeated} (same round ${b.leaderDefeatedSameRound}); duplicate uniques ${b.dupUnique}`);
        lines.push(`  loss round: ${JSON.stringify(b.lossRounds)}`);
        const L = b.lostGames;
        lines.push(`  lost games: their removal ${L.oppRemoval}, they healed ${L.oppHealed}, base hit us ${L.ourHit} them ${L.theirHit}`);
        if (L.round5) {
            lines.push(`  lost games at round 5 start (${L.round5.games}): base damage taken ${L.round5.taken} dealt ${L.round5.dealt}, power ${L.round5.power} v ${L.round5.oppPower}, hand ${L.round5.hand} v ${L.round5.oppHand}`);
        }
        lines.push(`  opponents' leaders: ${b.oppLeaders.map((o) => `${o.leader} ${o.won}/${o.games}`).join('; ')}`);
    }
    return lines.join('\n');
}

function main() {
    const dir = arg('games');
    if (!dir) {
        throw new Error('usage: review.js --games <games.js out dir> [--since <ISO time>] [--json review.json]');
    }
    const since = arg('since');
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).filter((r) => !since || String(r.at) >= since);
    const rv = review(index, dir);
    const json = arg('json');
    if (json) {
        fs.writeFileSync(json, JSON.stringify(rv, null, 1) + '\n');
    }
    console.log(text(rv));
}

if (require.main === module) {
    main();
}

module.exports = { review, text };
