'use strict';
// Real-deck comparison: the deck model recovers known strengths, agreement shows up when the truth agrees (and not
// when it is shuffled), and the edge cases (draws, ERROR games, decks with no games, thin cells) count the right way.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const rd = require('../realdeck/compare');

const close = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);
const sigma = (z) => 1 / (1 + Math.exp(-z));

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

// human archetypes and cells; thin cells hold the wrong answer on purpose, so including them would show
const archetypes = {};
const cells = {};
names.forEach((n, i) => {
    archetypes[n] = { fieldDecks: 20, gameWinPct: Number(sigma(h[i]).toFixed(4)), key: n, label: `Deck ${i}` };
    cells[n] = {};
});
let thinCells = 0;
for (let i = 0; i < K; i++) {
    for (let j = i + 1; j < K; j++) {
        const w = Math.round(30 * sigma(1.5 * (h[i] - h[j])));
        const thin = (i + j) % 3 === 0;
        thinCells += thin ? 1 : 0;
        const pct = thin ? 1 - w / 30 : w / 30;
        cells[names[i]][names[j]] = { games: [w, 30 - w, 0], gameWinPct: pct, thin };
        cells[names[j]][names[i]] = { games: [30 - w, w, 0], gameWinPct: 1 - pct, thin };
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
 * A mirror run as ladder.js writes it: seed s plays one deck pair, twice with seats swapped; every second pass swaps
 * which bot entry gets which deck. bot[i] is the true bot-side strength of deck i.
 */
function synthRun(id, bot, { passes = 40, seat = 0.15, seed = 1 } = {}) {
    const rnd = rng(seed);
    const pairs = [];
    for (let i = 0; i < K; i++) {
        for (let j = i + 1; j < K; j++) {
            pairs.push([i, j]);
        }
    }
    const games = [];
    let s = 1;
    for (let pass = 0; pass < passes; pass++) {
        for (const [i, j] of pairs) {
            const [x, y] = pass % 2 ? [j, i] : [i, j]; // deck of entry #a, deck of entry #b
            for (const [p1, p2, d1, d2] of [['sim#a', 'sim#b', x, y], ['sim#b', 'sim#a', y, x]]) {
                const p1Wins = rnd() < sigma(bot[d1] - bot[d2] + seat);
                games.push({ id: `${p1}-vs-${p2}-${s}`, seed: s, p1, p2, winner: p1Wins ? p1 : p2, winnerSeat: p1Wins ? 'p1' : 'p2', outcome: 'won', error: null, decks: { p1: names[d1], p2: names[d2] } });
            }
            s++;
        }
    }
    return { id, dir: null, entries: ['sim#a', 'sim#b'], ...rd.botName(['sim#a', 'sim#b']), status: 'done', deckNames: names, games };
}

// truth that agrees with humans (bot = 1.5 × human logit + noise) and truth that is a shuffle of it
const noise = rng(99);
const agreeing = h.map((v) => 1.5 * v + 0.1 * normal(noise));
const shuffledTruth = rd.shuffled(agreeing, 4242);
const runA = synthRun('agree', agreeing, { seed: 1 });

// 1. model: strengths and the seat term come back within a few SEs; SEs are sane
{
    const sorted = rd.sortGames(runA.games, new Map(names.map((n, i) => [n, i])));
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
const runS = synthRun('shuffled', shuffledTruth, { seed: 3 });
const res = rd.compareRuns([runA, runB, runS], deckFile, human, online, { permute: 500, now: new Date('2026-10-11T00:00:00Z') });
{
    assert.deepStrictEqual(res.runs.map((r) => r.id), ['agree', 'agree#2', 'shuffled']);
    assert.deepStrictEqual(res.credit, [rd.CREDIT_DECKS, rd.CREDIT_ONLINE]);
    assert.strictEqual(res.generatedAt, '2026-10-11T00:00:00.000Z');
    assert.strictEqual(res.runs[0].bot, 'sim');
    const good = res.agreement.deck.agree;
    assert.strictEqual(good.n, K);
    assert(good.strength.pearson > 0.9, `agreeing pearson ${good.strength.pearson}`);
    assert(good.strength.spearman > 0.9, `agreeing spearman ${good.strength.spearman}`);
    assert(good.strength.pearsonCI95[0] < good.strength.pearson && good.strength.pearson < good.strength.pearsonCI95[1]);
    assert(good.strength.pearsonCI95[0] > 0.5, 'CI clear of zero');
    assert.strictEqual(good.strength.permutationP.pearson, 1 / 501, 'no shuffle beats the true order');
    assert(good.winRate.pearson > 0.9);
    close(good.strength.slopeBotPerHuman, 1.5, 0.3, 'bot logit per human logit');
    const bad = res.agreement.deck.shuffled;
    assert(Math.abs(bad.strength.pearson) < 0.5, `shuffled pearson ${bad.strength.pearson}`);
    assert(bad.strength.permutationP.pearson > 0.05, `shuffled p ${bad.strength.permutationP.pearson}`);

    // pairs: only non-thin cells, the favourite mostly agrees for the agreeing run
    const pair = res.agreement.pair.agree;
    assert.strictEqual(pair.n, 66 - thinCells);
    assert.strictEqual(pair.left.thin, thinCells);
    assert(pair.list.every((p) => !cells[p.a][p.b].thin));
    assert(pair.pearsonWeighted > 0.7, `pair pearson ${pair.pearsonWeighted}`);
    assert(pair.favourite.share > 0.75 && pair.favourite.signTestP < 0.01);
    assert(res.agreement.pair.shuffled.pearsonWeighted < pair.pearsonWeighted);

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

    // reliability: halves agree, Spearman-Brown above the half correlation; the two agreeing runs agree, the shuffled does not
    const sh = res.agreement.splitHalf.agree;
    assert.strictEqual(sh.n, K);
    assert.deepStrictEqual(sh.games, [2640, 2640]);
    assert(sh.r > 0.8 && sh.spearmanBrown > sh.r);
    const between = (a, b) => res.agreement.betweenRuns.find((x) => x.a === a && x.b === b);
    assert.strictEqual(res.agreement.betweenRuns.length, 3);
    assert(between('agree', 'agree#2').pearson > 0.9);
    assert(Math.abs(between('agree', 'shuffled').pearson) < 0.6);

    // styles exist in the fixed order with human means
    assert.deepStrictEqual(Object.keys(res.agreement.style.agree), rd.STYLES);
    const hyper = res.agreement.style.agree.hyperaggro;
    assert.deepStrictEqual(hyper.decks, ['deck-0', 'deck-5', 'deck-10']);
    close(hyper.human.meanGameWinPct, (archetypes['deck-0'].gameWinPct + archetypes['deck-5'].gameWinPct + archetypes['deck-10'].gameWinPct) / 3, 1e-12, 'style human mean');

    // summary text mentions every block
    const text = rd.summaryText(res);
    for (const s of ['deck vs human archetype', 'pair vs human cell', 'leader vs online', 'split-half', 'between runs agree vs agree#2', 'Credit: Tournament deck lists']) {
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
    const r = rd.compareRuns([run], deckFile, human, null, { permute: 10, minGames: 1 });
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
    assert.deepStrictEqual([d2.games, d2.winRate, d2.ci, d2.strength, d2.se, d2.incomplete], [0, null, null, null, null, 3]);
    assert.deepStrictEqual(d2.incompleteOutcomes, { ERROR: 2, STEP_CAP: 1 });
    assert.strictEqual(at('deck-3').strength, null, 'a deck against itself is skipped');
    assert.strictEqual(r.agreement.deck.edge.n, 2);
    assert.strictEqual(r.agreement.deck.edge.strength.pearson, null, 'two points give no correlation');
    assert(r.agreement.deck.edge.left.includes('deck-2'));
    assert.strictEqual(r.agreement.splitHalf.edge.n, 0);
    // style: deck-0 (hyperaggro) and deck-1 (softaggro) only
    assert.strictEqual(r.agreement.style.edge.hyperaggro.games, 2);
    close(r.agreement.style.edge.hyperaggro.winRate, 0.75, 1e-12, 'style pooled rate');
    assert.strictEqual(r.agreement.style.edge.midrange.games, 0);
    assert.strictEqual(r.agreement.style.edge.midrange.winRate, null);
    // an empty run fits nothing and does not throw
    const empty = rd.compareRuns([{ id: 'empty', ...rd.botName(['e#a']), games: [] }], deckFile, human, online, { permute: 10 });
    assert.strictEqual(empty.runs[0].p1WinRate, null);
    assert.strictEqual(empty.runs[0].seat.logit, null);
    assert.strictEqual(empty.agreement.leader.empty.n, 0);
}

// 4. pair-level filters: thin cells, cells with no game rate and near-50% rates
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
    assert.deepStrictEqual(p.left, { thin: 1, noHuman: 1 });
    assert.deepStrictEqual(p.list.map((x) => [x.a, x.b, x.bot]), [['a', 'b', 0.8], ['a', 'c', 0.7], ['b', 'c', 0.5]]);
    assert.deepStrictEqual(p.list.map((x) => x.humanGames), [30, 30, 20]);
    // b-c is a coin flip for the bot: left out of the favourite count; a-b agrees, a-c disagrees
    assert.deepStrictEqual([p.favourite.n, p.favourite.agree, p.favourite.share], [2, 1, 0.5]);
    assert.deepStrictEqual(p.botGamesPerPair, { min: 10, median: 10, max: 10 });
    const q = rd.pairAgreement(meta, decided, cellsP, { near: 0.25 });
    assert.strictEqual(q.favourite.n, 0, 'a wider dead zone drops every pair');
    assert.strictEqual(q.favourite.share, null);
}

// 5. small helpers
{
    assert.strictEqual(rd.wilson(0, 0), null);
    const w = rd.wilson(5, 10);
    close(w[0], 0.2366, 1e-4, 'wilson low');
    close(w[1], 0.7634, 1e-4, 'wilson high');
    close(rd.wilson(5.5, 10)[0], rd.wilson(5.5, 10)[0], 0, 'fractional score is fine');
    assert.strictEqual(rd.fisherCI(0.5, 3), null);
    assert.strictEqual(rd.fisherCI(null, 30), null);
    const f = rd.fisherCI(0.5, 28);
    close(f[0], 0.155, 0.01, 'fisher low');
    close(f[1], 0.738, 0.01, 'fisher high');
    assert.strictEqual(rd.signTestP(0, 0), null);
    assert.strictEqual(rd.signTestP(0, 4), 1);
    close(rd.signTestP(3, 4), 5 / 16, 1e-12, 'sign test');
    close(rd.signTestP(4, 4), 1 / 16, 1e-12, 'sign test top');
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
        { runs: ['x', 'y', 'z'], decks: 'd', human: 'h', online: null, out: null, permute: 50, minGames: 4 });
    assert.throws(() => rd.parseArgs(['--bogus']), /unknown option/);
    assert.throws(() => rd.parseArgs(['--runs']), /needs a value/);
}

// 6. the command line, on a run directory written like ladder.js writes it (no tags in the run name, file outputs)
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'realdeck-'));
    try {
        const run = path.join(dir, 'run1');
        fs.mkdirSync(run);
        const games = runA.games.slice(0, 600).concat([{ id: 'x', seed: 999, p1: 'sim#a', p2: 'sim#b', winner: null, winnerSeat: null, outcome: 'running', decks: { p1: 'deck-0', p2: 'deck-1' } }]);
        fs.writeFileSync(path.join(run, 'index.json'), JSON.stringify({ id: 'run1', bots: ['sim#a', 'sim#b'], games }));
        fs.writeFileSync(path.join(run, 'ladder.json'), JSON.stringify({ status: 'running', config: { bots: ['sim#a', 'sim#b'], decks: { names } } }));
        const files = { decks: path.join(dir, 'decks.json'), human: path.join(dir, 'decks.human.json'), online: path.join(dir, 'online'), out: path.join(dir, 'out.json') };
        fs.writeFileSync(files.decks, JSON.stringify(deckFile));
        fs.writeFileSync(files.human, JSON.stringify(human));
        fs.mkdirSync(files.online);
        fs.writeFileSync(path.join(files.online, 'human-summary.json'), JSON.stringify(online));
        const script = path.join(__dirname, '..', 'realdeck', 'compare.js');
        const stdout = execFileSync(process.execPath, [script, '--runs', run, '--decks', files.decks, '--human', files.human, '--online', files.online, '--out', files.out, '--permute', '20'], { encoding: 'utf8' });
        assert.match(stdout, /run run1 \(sim, running\): 600 finished, 600 decided, 0 incomplete, 1 running/);
        assert.match(stdout, /Online leader win rates: SWU Stats \(swustats\.net\)/);
        const out = JSON.parse(fs.readFileSync(files.out, 'utf8'));
        assert.deepStrictEqual(Object.keys(out), ['credit', 'generatedAt', 'options', 'humanSource', 'onlineSource', 'runs', 'decks', 'agreement']);
        assert.deepStrictEqual(Object.keys(out.agreement), ['deck', 'pair', 'leader', 'style', 'splitHalf', 'betweenRuns']);
        assert.strictEqual(out.runs[0].bot, 'sim');
        assert.deepStrictEqual(out.runs[0].warnings, []);
        assert.strictEqual(out.decks[0].label, 'Deck 0');
        assert.deepStrictEqual(Object.keys(out.decks[0].runs.run1).slice(0, 7), ['games', 'wins', 'draws', 'losses', 'winRate', 'ci', 'strength']);
        assert.throws(() => execFileSync(process.execPath, [script, '--decks', files.decks], { stdio: 'pipe' }), /usage/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

console.log('ok: realdeck model, agreement, edge cases, pair filters, helpers, cli');
