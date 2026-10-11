'use strict';
// Real-deck comparison: the deck model recovers known strengths, agreement shows up when the truth agrees (and not
// when it is shuffled), and the edge cases (draws, ERROR games, decks with no games, thin cells, decks with too many
// incomplete games) count the right way.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const rd = require('../realdeck/compare');

const close = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);
const sigma = (z) => 1 / (1 + Math.exp(-z));
const pearson = (xs, ys) => {
    const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
    const my = ys.reduce((s, y) => s + y, 0) / ys.length;
    const sxy = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
    return sxy / Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0) * ys.reduce((s, y) => s + (y - my) ** 2, 0));
};

/** Small deterministic generator for the synthetic games (mulberry32). */
function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function normal(rnd) {
    return Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
}

// 12 decks; the human logit of deck i is h[i], evenly spread over ±0.5
const K = 12;
const names = Array.from({ length: K }, (_, i) => `deck-${i}`);
const h = names.map((_, i) => -0.5 + i / (K - 1));
const leaderOf = (i) => (i === K - 1 ? 'LX' : `L${i % 5}`);
const deckFile = names.map((name, i) => ({ metadata: { name, style: rd.STYLES[i % 5] }, leader: { id: leaderOf(i), count: 1 }, base: { id: 'B', count: 1 }, deck: [] }));

// human archetypes and cells: 30 games per normal cell; thin cells have 4 games that hold the wrong answer on purpose,
// so using them for the pair correlation would show (the BT model uses them, but 4 games weigh little)
const archetypes = {};
const cells = {};
names.forEach((n, i) => {
    archetypes[n] = { fieldDecks: 20, gameWinPct: Number(sigma(h[i]).toFixed(4)), key: n, label: `Deck ${i}` };
    cells[n] = {};
});
let thinCells = 0;
for (let i = 0; i < K; i++) {
    for (let j = i + 1; j < K; j++) {
        const thin = (i + j) % 3 === 0;
        const n = thin ? 4 : 30;
        const right = Math.round(n * sigma(1.5 * (h[i] - h[j])));
        const w = thin ? n - right : right;
        thinCells += thin ? 1 : 0;
        cells[names[i]][names[j]] = { games: [w, n - w, 0], gameWinPct: w / n, thin };
        cells[names[j]][names[i]] = { games: [n - w, w, 0], gameWinPct: 1 - w / n, thin };
    }
}
const human = { source: { decks: 100, events: 3 }, archetypes, cells };
// online: leaders L0..L4 follow the mean human logit of their decks; LX has too few plays to count
const online = {
    leaders: [0, 1, 2, 3, 4].map((l) => {
        const own = names.map((_, i) => i).filter((i) => leaderOf(i) === `L${l}`);
        const v = own.reduce((s, i) => s + h[i], 0) / own.length;
        return { id: `L${l}`, name: `Leader ${l}`, wins: Math.round(1000 * sigma(v)), plays: 1000 };
    }).concat([{ id: 'LX', name: 'Rare', wins: 140, plays: 150 }])
};

/**
 * A mirror run shaped like ladder.js output: seed s plays one deck pair, twice with seats swapped; every second pass
 * swaps which bot entry gets which deck. The pairs come in file order, not ladder.js's round-robin order; compare.js
 * reads the deck names from each game and does not depend on the order. bot[i] is the true bot-side strength of deck i.
 */
function synthRun(id, bot, { passes = 40, seat = 0.15, seed = 1, name = 'sim' } = {}) {
    const rnd = rng(seed);
    const pairs = [];
    for (let i = 0; i < K; i++) {
        for (let j = i + 1; j < K; j++) {
            pairs.push([i, j]);
        }
    }
    const [ea, eb] = [`${name}#a`, `${name}#b`];
    const games = [];
    let s = 1;
    for (let pass = 0; pass < passes; pass++) {
        for (const [i, j] of pairs) {
            const [x, y] = pass % 2 ? [j, i] : [i, j]; // deck of entry #a, deck of entry #b
            for (const [p1, p2, d1, d2] of [[ea, eb, x, y], [eb, ea, y, x]]) {
                const p1Wins = rnd() < sigma(bot[d1] - bot[d2] + seat);
                games.push({ id: `${p1}-vs-${p2}-${s}`, seed: s, p1, p2, winner: p1Wins ? p1 : p2, winnerSeat: p1Wins ? 'p1' : 'p2', outcome: 'won', error: null, decks: { p1: names[d1], p2: names[d2] } });
            }
            s++;
        }
    }
    return { id, dir: null, entries: [ea, eb], ...rd.botName([ea, eb]), status: 'done', deckNames: names, games };
}

// truth that agrees with humans (bot = 1.5 × human logit + noise) and truth that is a shuffle of it
const noise = rng(99);
const agreeing = h.map((v) => 1.5 * v + 0.1 * normal(noise));
const shuffledTruth = rd.shuffled(agreeing, 4242);
const runA = synthRun('agree', agreeing, { seed: 1 });
const deckIndex = new Map(names.map((n, i) => [n, i]));

// 1. model: strengths and the seat term come back within a few SEs; SEs are sane
{
    const sorted = rd.sortGames(runA.games, deckIndex);
    assert.strictEqual(sorted.decided.length, 40 * 66 * 2);
    const fit = rd.fitStrengths(sorted.decided, K);
    const mean = agreeing.reduce((s, v) => s + v, 0) / K;
    fit.strength.forEach((s, i) => {
        assert(fit.se[i] > 0.05 && fit.se[i] < 0.2, `se of deck ${i} is ${fit.se[i]}`);
        close(s, agreeing[i] - mean, 3.5 * fit.se[i], `deck ${i} strength`);
    });
    close(fit.strength.reduce((s, v) => s + v, 0), 0, 1e-9, 'strengths are centred');
    close(fit.seat, 0.15, 3.5 * fit.seatSe, 'seat term');
}

// 2. agreement: strong and significant when the truth agrees, nothing when it is shuffled
const runB = synthRun('agree', agreeing, { seed: 2 }); // same id on purpose: the second becomes 'agree#2'
const runS = synthRun('shuffled', shuffledTruth, { seed: 3, name: 'other' });
const res = rd.compareRuns([runA, runB, runS], deckFile, human, online, { permute: 500, now: new Date('2026-10-11T00:00:00Z') });
{
    assert.deepStrictEqual(res.runs.map((r) => r.id), ['agree', 'agree#2', 'shuffled']);
    assert.deepStrictEqual(res.runs.map((r) => r.bot), ['sim', 'sim', 'other']);
    assert.deepStrictEqual(res.credit, [rd.CREDIT_DECKS, rd.CREDIT_ONLINE]);
    assert.strictEqual(res.generatedAt, '2026-10-11T00:00:00.000Z');
    assert.deepStrictEqual(res.runs[0].leftOut, [], 'no deck has incomplete games');

    // the human BT model: every cell (thin ones too) once per pair, and it finds the human order
    const hm = res.humanModel;
    assert.deepStrictEqual([hm.pairs, hm.thinPairs, hm.games, hm.drawnGames, hm.draws], [66, thinCells, (66 - thinCells) * 30 + thinCells * 4, 0, 'count half']);
    assert(hm.reliability > 0.8 && hm.reliability < 1, `human reliability ${hm.reliability}`);
    assert(pearson(res.decks.map((d) => d.humanBT.strength), h) > 0.95, 'human BT follows the human truth');
    assert.strictEqual(res.decks[0].humanBT.games, 11 * 30 - ([3, 6, 9].length) * 26, 'deck-0 games: 30 per normal cell, 4 per thin cell');

    // deck agreement, like for like (human BT) and against the field rate
    const good = res.agreement.deck.agree;
    assert.strictEqual(good.bt.n, K);
    assert(good.bt.strength.pearson > 0.9, `agreeing BT pearson ${good.bt.strength.pearson}`);
    assert.strictEqual(good.bt.strength.permutationP.pearson, 1 / 501, 'no shuffle beats the true order');
    assert(good.bt.reliability.bot > 0.9 && good.bt.reliability.human > 0.8);
    assert(good.bt.reliability.botSplitHalf > 0.9);
    const da = good.bt.disattenuated;
    close(da.raw, good.bt.strength.pearson / Math.sqrt(good.bt.reliability.bot * good.bt.reliability.human), 1e-12, 'disattenuated r');
    assert(da.value >= good.bt.strength.pearson && da.value <= 1);
    assert.strictEqual(good.field.n, K);
    assert(good.field.strength.pearson > 0.9, `agreeing pearson ${good.field.strength.pearson}`);
    assert(good.field.strength.spearman > 0.9, `agreeing spearman ${good.field.strength.spearman}`);
    assert(good.field.strength.pearsonCI95[0] < good.field.strength.pearson && good.field.strength.pearson < good.field.strength.pearsonCI95[1]);
    assert(good.field.strength.pearsonCI95[0] > 0.5, 'CI clear of zero');
    assert.strictEqual(good.field.strength.permutationP.pearson, 1 / 501);
    assert(good.field.winRate.pearson > 0.9);
    close(good.field.strength.slopeBotPerHuman, 1.5, 0.3, 'bot logit per human logit');
    assert.strictEqual(good.withLeft.n, K);
    close(good.withLeft.bt, good.bt.strength.pearson, 1e-12, 'nothing left out: the check is the same r');
    assert.deepStrictEqual(good.left, []);
    const bad = res.agreement.deck.shuffled;
    assert(Math.abs(bad.field.strength.pearson) < 0.5, `shuffled pearson ${bad.field.strength.pearson}`);
    assert(bad.field.strength.permutationP.pearson > 0.05, `shuffled p ${bad.field.strength.permutationP.pearson}`);
    assert(Math.abs(bad.bt.strength.pearson) < 0.5 && bad.bt.strength.permutationP.pearson > 0.05);

    // pairs: only non-thin cells; the favourite mostly agrees for the agreeing run, and the deck-label permutation
    // test finds it; for the shuffled run it does not
    const pair = res.agreement.pair.agree;
    assert.strictEqual(pair.n, 66 - thinCells);
    assert.strictEqual(pair.left.thin, thinCells);
    assert(pair.list.every((p) => !cells[p.a][p.b].thin));
    assert(pair.pearsonWeighted > 0.7, `pair pearson ${pair.pearsonWeighted}`);
    assert(pair.favourite.share > 0.75 && pair.favourite.signTestP < 0.01);
    assert.strictEqual(pair.permutationP.shuffles, 500);
    assert(pair.permutationP.pearsonWeighted < 0.01, `pair permutation p ${pair.permutationP.pearsonWeighted}`);
    assert(pair.permutationP.favouriteShare < 0.05, `favourite permutation p ${pair.permutationP.favouriteShare}`);
    const pairS = res.agreement.pair.shuffled;
    assert(pairS.pearsonWeighted < pair.pearsonWeighted);
    assert(pairS.permutationP.pearsonWeighted > 0.05, `shuffled pair permutation p ${pairS.permutationP.pearsonWeighted}`);

    // leaders: decks pooled by leader, LX (150 plays) left out
    const lead = res.agreement.leader.agree;
    assert.strictEqual(lead.n, 5);
    assert(lead.pearson > 0.8, `leader pearson ${lead.pearson}`);
    const l0 = lead.list.find((l) => l.id === 'L0');
    assert.deepStrictEqual(l0.decks, ['deck-0', 'deck-5', 'deck-10']);
    const dk = (n) => res.decks.find((d) => d.name === n).runs.agree;
    const pooled = ['deck-0', 'deck-5', 'deck-10'].reduce((s, n) => s + dk(n).games * dk(n).strength, 0) / ['deck-0', 'deck-5', 'deck-10'].reduce((s, n) => s + dk(n).games, 0);
    close(l0.strength, pooled, 1e-12, 'games-weighted leader strength');
    assert.strictEqual(lead.list.find((l) => l.id === 'LX').online, null);
    assert.deepStrictEqual(res.decks[11].online, { winRate: 140 / 150, plays: 150 });

    // reliability: halves agree, Spearman-Brown above the half correlation; the two agreeing runs agree, the shuffled
    // does not, and a run with another bot is 'bot vs bot'
    const sh = res.agreement.splitHalf.agree;
    assert.strictEqual(sh.n, K);
    assert.deepStrictEqual(sh.games, [2640, 2640]);
    assert(sh.r > 0.8 && sh.spearmanBrown > sh.r);
    const between = (a, b) => res.agreement.betweenRuns.find((x) => x.a === a && x.b === b);
    assert.strictEqual(res.agreement.betweenRuns.length, 3);
    assert(between('agree', 'agree#2').pearson > 0.9);
    assert.strictEqual(between('agree', 'agree#2').kind, 'run vs run (same bot)');
    assert(Math.abs(between('agree', 'shuffled').pearson) < 0.6);
    assert.strictEqual(between('agree', 'shuffled').kind, 'bot vs bot');
    assert.deepStrictEqual(between('agree', 'shuffled').bots, ['sim', 'other']);

    // styles exist in the fixed order with human means; only the rate against other styles gets a CI
    assert.deepStrictEqual(Object.keys(res.agreement.style.agree), rd.STYLES);
    const hyper = res.agreement.style.agree.hyperaggro;
    assert.deepStrictEqual(hyper.decks, ['deck-0', 'deck-5', 'deck-10']);
    close(hyper.human.meanGameWinPct, (archetypes['deck-0'].gameWinPct + archetypes['deck-5'].gameWinPct + archetypes['deck-10'].gameWinPct) / 3, 1e-12, 'style human mean');
    assert.strictEqual(hyper.vsOtherStyles.ci.length, 2);
    assert.deepStrictEqual(Object.keys(hyper.allGamesInclSameStyle), ['games', 'winRate']);
    // 3 hyperaggro decks, 11 opponents each; same-style pairs (3 of them) add both decks' games to the pool
    assert.strictEqual(hyper.allGamesInclSameStyle.games, 3 * 11 * 80);
    assert.strictEqual(hyper.vsOtherStyles.games, 3 * 9 * 80);

    // summary text mentions every block
    const text = rd.summaryText(res);
    for (const s of ['human BT strengths: 66 deck pairs', 'deck vs human BT, same deck pool', 'deck vs human field rate', 'pair vs human cell', 'deck-label p=', 'unweighted r=',
        'leader vs online', 'split-half', 'run vs run, same bot sim: agree vs agree#2', 'bot vs bot agreement, agree (sim) vs shuffled (other)',
        'left out of every correlation: none', 'vs other styles', 'Credit: Tournament deck lists and match results']) {
        assert(text.includes(s), `summary has "${s}"`);
    }
}

// 3. edge cases: draws count half, ERROR / STEP_CAP / bot-caused ERROR are incomplete, running and unknown decks are ignored,
// a deck with no decided games has no rate and no strength and stays out of every correlation
{
    const g = (p1Deck, p2Deck, winnerSeat, outcome = 'won', extra = {}) => ({ seed: 1, p1: 'e#a', p2: 'e#b', winnerSeat, outcome, decks: { p1: p1Deck, p2: p2Deck }, error: null, ...extra });
    const games = [
        g('deck-0', 'deck-1', 'p1'),
        g('deck-1', 'deck-0', 'draw'),
        g('deck-0', 'deck-2', null, 'ERROR', { error: "Cannot read properties of undefined (reading 'card')" }),
        g('deck-2', 'deck-0', null, 'STEP_CAP'),
        g('deck-2', 'deck-1', 'p2', 'ERROR', { by: 'p1', error: 'bot broke' }),
        g('deck-0', 'deck-1', null, 'running'),
        g('deck-0', 'not-a-deck', 'p1'),
        g('deck-3', 'deck-3', 'p1')
    ];
    const run = { id: 'edge', entries: ['e#a', 'e#b'], ...rd.botName(['e#a', 'e#b']), games };
    // maxIncomplete 1 keeps every deck in; the default would leave all three out (checked below)
    const r = rd.compareRuns([run], deckFile, human, null, { permute: 10, minGames: 1, maxIncomplete: 1 });
    assert.deepStrictEqual(r.credit, [rd.CREDIT_DECKS], 'no online credit without --online');
    assert.deepStrictEqual(r.agreement.leader, {});
    const run0 = r.runs[0];
    assert.deepStrictEqual([run0.games, run0.decided, run0.draws, run0.incomplete, run0.running, run0.skipped], [5, 2, 1, 3, 1, 2]);
    close(run0.p1WinRate, 0.75, 1e-12, 'p1 rate with a draw');
    assert.strictEqual(run0.errors[0].count, 1);
    const at = (n) => r.decks.find((d) => d.name === n).runs.edge;
    assert.deepStrictEqual([at('deck-0').games, at('deck-0').wins, at('deck-0').draws, at('deck-0').losses], [2, 1, 1, 0]);
    close(at('deck-0').winRate, 0.75, 1e-12, 'draw counts half');
    close(at('deck-1').winRate, 0.25, 1e-12, 'draw counts half (other side)');
    assert(at('deck-0').strength > 0 && at('deck-1').strength < 0);
    close(at('deck-0').strength, -at('deck-1').strength, 1e-9, 'two decks: centred strengths mirror');
    const d2 = at('deck-2');
    assert.deepStrictEqual([d2.games, d2.winRate, d2.ci, d2.strength, d2.se, d2.incomplete, d2.incompleteShare, d2.leftOut], [0, null, null, null, null, 3, 1, null]);
    assert.deepStrictEqual(d2.incompleteOutcomes, { ERROR: 2, STEP_CAP: 1 });
    assert.strictEqual(at('deck-3').strength, null, 'a deck against itself is skipped');
    assert.strictEqual(r.agreement.deck.edge.bt.n, 2);
    assert.strictEqual(r.agreement.deck.edge.field.n, 2);
    assert.strictEqual(r.agreement.deck.edge.field.strength.pearson, null, 'two points give no correlation');
    assert.deepStrictEqual(r.agreement.deck.edge.bt.disattenuated.value, null);
    assert.deepStrictEqual(r.agreement.deck.edge.left.find((x) => x.deck === 'deck-2'), { deck: 'deck-2', reason: 'fewer than 1 decided games' });
    assert.strictEqual(r.agreement.splitHalf.edge.n, 0);
    // style: deck-0 (hyperaggro) and deck-1 (softaggro) only
    assert.strictEqual(r.agreement.style.edge.hyperaggro.allGamesInclSameStyle.games, 2);
    close(r.agreement.style.edge.hyperaggro.allGamesInclSameStyle.winRate, 0.75, 1e-12, 'style pooled rate');
    close(r.agreement.style.edge.hyperaggro.vsOtherStyles.winRate, 0.75, 1e-12, 'style rate against other styles');
    assert.strictEqual(r.agreement.style.edge.midrange.allGamesInclSameStyle.games, 0);
    assert.strictEqual(r.agreement.style.edge.midrange.vsOtherStyles.winRate, null);
    // with the default limit, decks 0, 1 and 2 have too many incomplete games
    const strict = rd.compareRuns([run], deckFile, human, null, { permute: 10, minGames: 1 });
    assert.deepStrictEqual(strict.runs[0].leftOut.map((x) => x.deck), ['deck-0', 'deck-1', 'deck-2']);
    assert.strictEqual(strict.runs[0].leftOut[1].reason, '1 of 3 finished games incomplete, 33.3% > 10%');
    // an empty run fits nothing and does not throw
    const empty = rd.compareRuns([{ id: 'empty', ...rd.botName(['e#a']), games: [] }], deckFile, human, online, { permute: 10 });
    assert.strictEqual(empty.runs[0].p1WinRate, null);
    assert.strictEqual(empty.runs[0].seat.logit, null);
    assert.strictEqual(empty.agreement.leader.empty.n, 0);
}

// 4. a deck with too many incomplete games leaves every correlation but stays in the model and the table
{
    let k = 0;
    const games = runA.games.map((g) => {
        const has3 = g.decks.p1 === 'deck-3' || g.decks.p2 === 'deck-3';
        return has3 && k++ % 3 === 0 ? { ...g, winner: null, winnerSeat: null, outcome: 'ERROR', error: "Cannot read properties of undefined (reading 'card')" } : g;
    });
    const run = { ...runA, id: 'buggy', games };
    const r = rd.compareRuns([run], deckFile, human, online, { permute: 50 });
    const reason = r.runs[0].leftOut[0]?.reason;
    assert.deepStrictEqual(r.runs[0].leftOut.map((x) => x.deck), ['deck-3']);
    assert.match(reason, /^294 of 880 finished games incomplete, 33\.4% > 10%$/);
    const d3 = r.decks[3].runs.buggy;
    assert.strictEqual(d3.leftOut, reason);
    assert(d3.strength !== null && d3.games === 880 - 294, 'still fitted and in the table');
    close(d3.incompleteShare, 294 / 880, 1e-12, 'incomplete share');
    const deck = r.agreement.deck.buggy;
    assert.deepStrictEqual([deck.bt.n, deck.field.n, deck.withLeft.n], [K - 1, K - 1, K]);
    assert.deepStrictEqual(deck.left, [{ deck: 'deck-3', reason }]);
    const pair = r.agreement.pair.buggy;
    assert.strictEqual(pair.left.deck, 11);
    assert(pair.list.every((p) => p.a !== 'deck-3' && p.b !== 'deck-3'));
    assert.deepStrictEqual(r.agreement.leader.buggy.list.find((l) => l.id === 'L3').decks, ['deck-8']);
    assert.deepStrictEqual(r.agreement.leader.buggy.left, [{ deck: 'deck-3', reason }]);
    assert.deepStrictEqual(r.agreement.style.buggy.softcontrol.leftOut, ['deck-3']);
    assert.deepStrictEqual(r.agreement.style.buggy.softcontrol.decks, ['deck-8']);
    assert.strictEqual(r.agreement.splitHalf.buggy.n, K - 1);
    const text = rd.summaryText(r);
    assert(text.includes(`left out of every correlation: deck-3 (${reason})`));
    assert(text.includes('check, left-out decks put back (n=12)'));
    assert.match(text, /\n {2}deck-3 +softcontrol .* left out\n/);
    // a looser limit keeps it
    assert.deepStrictEqual(rd.compareRuns([run], deckFile, human, null, { permute: 0, maxIncomplete: 0.5 }).runs[0].leftOut, []);
    // the limit is a share of finished games, and exactly at the limit is still in
    const t = (games, incomplete) => ({ games, incomplete });
    assert.deepStrictEqual([...rd.leftDecks([t(90, 10), t(89, 11), t(0, 0)]).keys()], [1]);
}

// 5. pair-level filters: thin cells, cells with no game rate and near-50% rates
{
    const meta = ['a', 'b', 'c', 'd'].map((name) => ({ name }));
    const decided = [];
    const add = (a, b, wins, n) => {
        for (let k = 0; k < n; k++) {
            decided.push({ a, b, y: k < wins ? 1 : 0, seed: k });
        }
    };
    add(0, 1, 8, 10); // a over b 80%
    add(2, 0, 3, 10); // c over a 30%, so a over c 70%
    add(1, 2, 5, 10); // b over c 50%: no favourite
    add(0, 3, 9, 10); // a over d: thin cell
    add(1, 3, 9, 10); // b over d: no game rate (all draws)
    const cellsP = {
        a: { b: { games: [20, 10, 0], gameWinPct: 2 / 3, thin: false }, c: { games: [10, 20, 0], gameWinPct: 1 / 3, thin: false }, d: { games: [9, 1, 0], gameWinPct: 0.9, thin: true } },
        b: { c: { games: [12, 8, 0], gameWinPct: 0.6, thin: false }, d: { games: [0, 0, 3], gameWinPct: null, thin: true } }
    };
    const p = rd.pairAgreement(meta, decided, cellsP);
    assert.strictEqual(p.pairsPlayed, 5);
    assert.strictEqual(p.n, 3);
    assert.deepStrictEqual(p.left, { thin: 1, noHuman: 1, deck: 0 });
    assert.deepStrictEqual(p.list.map((x) => [x.a, x.b, x.bot]), [['a', 'b', 0.8], ['a', 'c', 0.7], ['b', 'c', 0.5]]);
    assert.deepStrictEqual(p.list.map((x) => x.humanGames), [30, 30, 20]);
    // b-c is a coin flip for the bot: left out of the favourite count; a-b agrees, a-c disagrees
    assert.deepStrictEqual([p.favourite.n, p.favourite.agree, p.favourite.share], [2, 1, 0.5]);
    assert.deepStrictEqual(p.botGamesPerPair, { min: 10, median: 10, max: 10 });
    assert.strictEqual(p.permutationP, undefined, 'no permutation test without permute');
    const q = rd.pairAgreement(meta, decided, cellsP, { near: 0.25 });
    assert.strictEqual(q.favourite.n, 0, 'a wider dead zone drops every pair');
    assert.strictEqual(q.favourite.share, null);
    // deck-label permutation: p in [1/(N+1), 1], the same on every call; a left-out deck takes its pairs along
    const pp = rd.pairAgreement(meta, decided, cellsP, { permute: 99 });
    assert(pp.permutationP.pearsonWeighted >= 1 / 100 && pp.permutationP.pearsonWeighted <= 1);
    assert(pp.permutationP.favouriteShare >= 1 / 100 && pp.permutationP.favouriteShare <= 1);
    assert.deepStrictEqual(rd.pairAgreement(meta, decided, cellsP, { permute: 99 }).permutationP, pp.permutationP);
    const pl = rd.pairAgreement(meta, decided, cellsP, { left: new Map([[2, 'buggy']]) });
    assert.deepStrictEqual([pl.n, pl.left.deck], [1, 2]);
}

// 6. split-half: within each deck pair, seeds of even rank go to half A and odd rank to half B. Both games of a seed
// share a half and every pair is split, with an even number of pairs (12 decks: 66) and an odd one (6 decks: 15).
{
    const check = (decided, nPairs, seedsPerPair) => {
        const [A, B] = rd.splitHalves(decided);
        assert.strictEqual(A.length + B.length, decided.length);
        const key = (g) => `${Math.min(g.a, g.b)}|${Math.max(g.a, g.b)}`;
        const pairsIn = (half) => new Set(half.map(key));
        assert.strictEqual(pairsIn(A).size, nPairs, 'every pair in half A');
        assert.strictEqual(pairsIn(B).size, nPairs, 'every pair in half B');
        const seedsA = new Set(A.map((g) => g.seed));
        assert(B.every((g) => !seedsA.has(g.seed)), 'no seed is split');
        assert.strictEqual(A.length, Math.ceil(seedsPerPair / 2) * 2 * nPairs);
    };
    const even = rd.sortGames(runA.games, deckIndex).decided;
    // with an even pair count every seed of a pair has the same parity, so a parity split would not split any pair
    const parity = new Map();
    assert(even.every((g) => {
        const k = `${Math.min(g.a, g.b)}|${Math.max(g.a, g.b)}`;
        parity.set(k, parity.get(k) ?? g.seed % 2);
        return parity.get(k) === g.seed % 2;
    }));
    check(even, 66, 40);
    // 6 decks, 15 pairs, 3 passes: seed s plays pair (s - 1) mod 15, two games per seed
    const pairs6 = [];
    for (let i = 0; i < 6; i++) {
        for (let j = i + 1; j < 6; j++) {
            pairs6.push([i, j]);
        }
    }
    const odd = [];
    for (let s = 1; s <= 45; s++) {
        const [i, j] = pairs6[(s - 1) % 15];
        odd.push({ a: i, b: j, y: 1, seed: s }, { a: j, b: i, y: 0, seed: s });
    }
    check(odd, 15, 3);
    // games without a seed are dropped
    assert.strictEqual(rd.splitHalves([{ a: 0, b: 1, y: 1 }]).flat().length, 0);
}

// 7. small helpers
{
    assert.strictEqual(rd.wilson(0, 0), null);
    const w = rd.wilson(5, 10);
    close(w[0], 0.2366, 1e-4, 'wilson low');
    close(w[1], 0.7634, 1e-4, 'wilson high');
    // by hand, p = 0.55, z² = 3.84146: centre (0.55 + 0.19207) / 1.38415 = 0.53613, half width
    // 1.95996 · sqrt(0.02475 + 0.00960) / 1.38415 = 0.26245
    const wf = rd.wilson(5.5, 10);
    close(wf[0], 0.27367, 1e-4, 'wilson low, fractional score');
    close(wf[1], 0.79858, 1e-4, 'wilson high, fractional score');
    assert.strictEqual(rd.fisherCI(0.5, 3), null);
    assert.strictEqual(rd.fisherCI(null, 30), null);
    const f = rd.fisherCI(0.5, 28);
    close(f[0], 0.155, 0.01, 'fisher low');
    close(f[1], 0.738, 0.01, 'fisher high');
    assert.strictEqual(rd.signTestP(0, 0), null);
    assert.strictEqual(rd.signTestP(0, 4), 1);
    close(rd.signTestP(3, 4), 5 / 16, 1e-12, 'sign test');
    close(rd.signTestP(4, 4), 1 / 16, 1e-12, 'sign test top');
    // large n: 0.5 ** n underflows past n = 1074, the log-space sum does not
    assert.strictEqual(rd.signTestP(0, 2000), 1);
    close(rd.signTestP(1000, 2000), 0.5 + 0.5 * 0.0178390, 1e-6, 'P(X >= n/2), n = 2000');
    close(rd.signTestP(760, 1500) + rd.signTestP(741, 1500), 1, 1e-9, 'P(X >= k) + P(X <= k - 1) = 1');
    const tail = rd.signTestP(1200, 2000);
    assert(tail > 0 && tail < 1e-15, `far tail ${tail}`);
    assert.strictEqual(rd.signTestP(2001, 2000), 0);
    // reliability and disattenuation
    assert.strictEqual(rd.reliability([1, -1], [0, 0]), null);
    assert.strictEqual(rd.reliability([1, -1, 0], [0, 0, 0]), 1);
    close(rd.reliability([1, -1, 0, null], [Math.SQRT1_2, Math.SQRT1_2, Math.SQRT1_2, 1]), 0.5, 1e-12, 'variance 1, error variance 0.5');
    close(rd.disattenuate(0.5, 0.81, 0.64).value, 0.5 / 0.72, 1e-12, 'r / sqrt(relA relB)');
    assert.deepStrictEqual(rd.disattenuate(0.6, 0.25, 1), { value: 1, raw: 1.2, note: 'above 1 in size, clamped: the reliabilities are estimates' });
    assert.strictEqual(rd.disattenuate(0.5, 0, 1).value, null);
    assert.strictEqual(rd.disattenuate(null, 1, 1).value, null);
    // human BT: draws count half (6-2-2 is 70%, so the two centred strengths are ±logit(0.7)/2), thin cells count,
    // and a deck with no cell gets null
    const bt = rd.humanBradleyTerry([{ name: 'a' }, { name: 'b' }, { name: 'c' }], { a: { b: { games: [6, 2, 2], thin: true } }, b: { a: { games: [2, 6, 2], thin: true } } }, { ridge: 1e-9 });
    close(bt.strength[0], Math.log(0.7 / 0.3) / 2, 1e-6, 'BT with a draw counted half');
    close(bt.strength[1], -bt.strength[0], 1e-9, 'BT strengths are centred');
    assert.strictEqual(bt.strength[2], null);
    assert.deepStrictEqual([bt.summary.pairs, bt.summary.thinPairs, bt.summary.games, bt.summary.drawnGames], [1, 1, 10, 2]);
    assert.deepStrictEqual(bt.games, [10, 10, 0]);
    // deck lists are read as bot/decklists.js reads them: padded ids, the same default name, unique names
    assert.deepStrictEqual(rd.deckMeta([{ metadata: { style: 'midrange' }, leader: { id: 'LAW_8' }, base: { id: 'ASH_19' }, deck: [{ id: 'LAW_3', count: 3 }] }]),
        [{ name: 'LAW_008 / ASH_019', leader: 'LAW_008', base: 'ASH_019', style: 'midrange' }]);
    assert.throws(() => rd.deckMeta([deckFile[0], deckFile[0]]), /used twice/);
    assert.throws(() => rd.deckMeta([{ metadata: { name: 'x' }, deck: [] }]), /needs leader\.id/);
    const a = [1, 2, 3, 4, 5, 6, 7];
    assert.deepStrictEqual(rd.shuffled(a, 5), rd.shuffled(a, 5), 'shuffle is deterministic');
    assert.deepStrictEqual([...rd.shuffled(a, 5)].sort(), a, 'shuffle is a permutation');
    assert.notDeepStrictEqual(rd.shuffled(a, 5), rd.shuffled(a, 6));
    // permutation p: never below 1/(N+1); ties among values are fine (tie-aware Spearman)
    const ag = rd.agreement([1, 2, 3, 4, 5], [1, 2, 3, 4, 5], { permute: 99 });
    assert.strictEqual(ag.pearson, 1);
    assert(ag.permutationP.pearson >= 1 / 100 && ag.permutationP.pearson < 0.1);
    assert.strictEqual(rd.agreement([1, 1, 2, 2], [3, 4, 5, 6]).spearman !== null, true);
    assert.deepStrictEqual(rd.botName(['c-clock#a', 'c-clock#b']), { bot: 'c-clock', mirror: true });
    assert.deepStrictEqual(rd.botName(['a#1', 'b']), { bot: 'a vs b', mirror: false });
    assert.deepStrictEqual(rd.parseArgs(['--runs', 'x,y', '--runs', 'z', '--decks', 'd', '--human', 'h', '--permute', '50', '--min-games', '4']),
        { runs: ['x', 'y', 'z'], decks: 'd', human: 'h', online: null, out: null, permute: 50, minGames: 4, maxIncomplete: rd.MAX_INCOMPLETE });
    assert.strictEqual(rd.parseArgs(['--max-incomplete', '0.25']).maxIncomplete, 0.25);
    assert.throws(() => rd.parseArgs(['--max-incomplete', 'lots']), /share between 0 and 1/);
    assert.throws(() => rd.parseArgs(['--bogus']), /unknown option/);
    assert.throws(() => rd.parseArgs(['--runs']), /needs a value/);
    // a deck file hash that differs from the run's gives a warning
    const runH = (sha) => ({ ...runA, decksSha256: sha });
    const warn = (sha) => rd.compareRuns([runH(sha)], deckFile, human, null, { permute: 0, deckSha256: 'aaaa1111bbbb2222' }).runs[0].warnings;
    assert.deepStrictEqual(warn('aaaa1111bbbb2222'), []);
    assert.deepStrictEqual(warn(null), [], 'no hash in ladder.json: nothing to check');
    assert.deepStrictEqual(warn('cccc3333dddd4444'), ['--decks differs from the deck file the run was made with (sha256 aaaa1111bbbb vs cccc3333dddd)']);
}

// 8. the command line, on run directories written like ladder.js writes them (no tags in the run name, file outputs)
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'realdeck-'));
    try {
        const files = { decks: path.join(dir, 'decks.json'), human: path.join(dir, 'decks.human.json'), online: path.join(dir, 'online'), out: path.join(dir, 'out.json') };
        const deckText = JSON.stringify(deckFile, null, 3) + '\n'; // the hash is of these bytes, not of a re-serialised copy
        fs.writeFileSync(files.decks, deckText);
        const sha = crypto.createHash('sha256').update(deckText).digest('hex');
        assert.strictEqual(rd.readDeckFile(files.decks).sha256, sha);
        assert.deepStrictEqual(rd.readDeckFile(files.decks).raw, deckFile);
        const writeRun = (id, decksSha256) => {
            const run = path.join(dir, id);
            fs.mkdirSync(run);
            const games = runA.games.slice(0, 600).concat([{ id: 'x', seed: 999, p1: 'sim#a', p2: 'sim#b', winner: null, winnerSeat: null, outcome: 'running', decks: { p1: 'deck-0', p2: 'deck-1' } }]);
            fs.writeFileSync(path.join(run, 'index.json'), JSON.stringify({ id, bots: ['sim#a', 'sim#b'], games }));
            fs.writeFileSync(path.join(run, 'ladder.json'), JSON.stringify({ status: 'running', config: { bots: ['sim#a', 'sim#b'], decks: { names, sha256: decksSha256 } } }));
            return run;
        };
        const runs = [writeRun('run1', sha), writeRun('run2', 'f'.repeat(64))];
        fs.writeFileSync(files.human, JSON.stringify(human));
        fs.mkdirSync(files.online);
        fs.writeFileSync(path.join(files.online, 'human-summary.json'), JSON.stringify(online));
        const script = path.join(__dirname, '..', 'realdeck', 'compare.js');
        const stdout = execFileSync(process.execPath, [script, '--runs', runs.join(','), '--decks', files.decks, '--human', files.human, '--online', files.online, '--out', files.out,
            '--permute', '20', '--max-incomplete', '0.2'], { encoding: 'utf8' });
        assert.match(stdout, /run run1 \(sim, running\): 600 finished, 600 decided, 0 incomplete, 1 running/);
        assert.match(stdout, /Online leader win rates: SWU Stats \(swustats\.net\)/);
        assert.match(stdout, /warning: --decks differs from the deck file the run was made with/);
        assert.match(stdout, /run vs run, same bot sim: run1 vs run2/);
        const out = JSON.parse(fs.readFileSync(files.out, 'utf8'));
        assert.deepStrictEqual(Object.keys(out), ['credit', 'generatedAt', 'options', 'deckFile', 'humanSource', 'onlineSource', 'humanModel', 'runs', 'decks', 'agreement']);
        assert.deepStrictEqual(Object.keys(out.agreement), ['deck', 'pair', 'leader', 'style', 'splitHalf', 'betweenRuns']);
        assert.deepStrictEqual(out.deckFile, { decks: K, sha256: sha });
        assert.strictEqual(out.options.maxIncomplete, 0.2);
        assert.strictEqual(out.runs[0].bot, 'sim');
        assert.deepStrictEqual(out.runs[0].warnings, []);
        assert.strictEqual(out.runs[1].warnings.length, 1);
        assert.strictEqual(out.decks[0].label, 'Deck 0');
        assert.deepStrictEqual(Object.keys(out.decks[0].humanBT), ['strength', 'se', 'games']);
        assert.deepStrictEqual(Object.keys(out.decks[0].runs.run1).slice(0, 7), ['games', 'wins', 'draws', 'losses', 'winRate', 'ci', 'strength']);
        assert.throws(() => execFileSync(process.execPath, [script, '--decks', files.decks], { stdio: 'pipe' }), /usage/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

console.log('ok: realdeck model, agreement, human BT, incomplete decks, pair filters, split-half, helpers, cli');
