'use strict';
// Skill vs agreement: gauntlet tallies (draws, incomplete, running and stray games), paired differences only on the
// same deals, the style gap, the exact Spearman test, and the join with a compare.js result.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const sk = require('../realdeck/skill');
const { wilson } = require('../realdeck/compare');

const close = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

/** Two games of one seed, like ladder.js gauntlet() writes them: the challenger at p1, then at p2. */
function seedGames(bot, ref, seed, [y1, y2], decks = { p1: `d${seed % 5}`, p2: `d${(seed + 2) % 5}` }, extra = {}) {
    const game = (p1, p2, y, d) => {
        const challengerSeat = p1 === bot ? 'p1' : 'p2';
        const other = challengerSeat === 'p1' ? 'p2' : 'p1';
        const winnerSeat = y === null ? null : y === 0.5 ? 'draw' : y === 1 ? challengerSeat : other;
        return {
            id: `${p1}-vs-${p2}-${seed}`, seed, p1, p2, winnerSeat, outcome: y === null ? 'ERROR' : 'won', decks: d,
            key: `k${seed}`, ...extra
        };
    };
    return [game(bot, ref, y1, decks), game(ref, bot, y2, { p1: decks.p2, p2: decks.p1 })];
}

// 1. tallies and skill rows: draws count half, ERROR games are incomplete, running and ref-less games are left out
{
    const games = [
        ...seedGames('heuristic', 'c-clock', 1, [1, 1]),
        ...seedGames('heuristic', 'c-clock', 2, [1, 0.5]),
        ...seedGames('heuristic', 'c-clock', 3, [0, null]),
        { seed: 4, p1: 'heuristic', p2: 'c-clock', outcome: 'running' },
        { seed: 5, p1: 'heuristic', p2: 'rust-search', winnerSeat: 'p1', outcome: 'won' },
        ...seedGames('rust-search#2', 'c-clock', 1, [0, 0])
    ];
    const g = sk.gauntletTallies([{ id: 'g1', vs: ['c-clock'], games }]);
    assert.strictEqual(g.reference, 'c-clock');
    assert.deepStrictEqual([...g.tallies.keys()], ['heuristic', 'rust-search']);
    assert.strictEqual(g.skipped, 1);
    assert.deepStrictEqual(g.warnings, ['1 games skipped (no reference bot on exactly one seat)']);
    const h = sk.skillOf(g.tallies.get('heuristic'));
    assert.strictEqual(h.games, 6);
    assert.strictEqual(h.decided, 5);
    assert.strictEqual(h.incomplete, 1);
    assert.deepStrictEqual(h.incompleteOutcomes, { ERROR: 1 });
    assert.strictEqual(h.draws, 1);
    assert.strictEqual(h.score, 3.5);
    assert.strictEqual(h.winRate, 0.7);
    assert.deepStrictEqual(h.ci, wilson(3.5, 5));
    close(h.elo, 400 * Math.log10(0.7 / 0.3), 1e-9, 'elo');
    assert.deepStrictEqual(h.bySeat, { p1: { decided: 3, winRate: 2 / 3 }, p2: { decided: 2, winRate: 0.75 } });
    const r = sk.skillOf(g.tallies.get('rust-search'));
    assert.strictEqual(r.winRate, 0);
    assert.strictEqual(r.elo, null, 'no Elo at 0%');
    assert.strictEqual(sk.elo(0.5), 0);
    assert.strictEqual(sk.elo(1), null);

    // a repeated game for the same seed and seat is skipped with a warning, not counted twice
    const dup = sk.gauntletTallies([{ id: 'g1', vs: ['c-clock'], games: [...seedGames('heuristic', 'c-clock', 1, [1, 1]), seedGames('heuristic', 'c-clock', 1, [0, 0])[0]] }]);
    assert.strictEqual(dup.tallies.get('heuristic').games, 2);
    assert.match(dup.warnings[0], /1 games skipped \(a second game/);

    // an ERROR game a bot caused (`by` set) is a loss for that bot; an engine ERROR (`by` null) stays incomplete
    const forfeits = sk.gauntletTallies([{ id: 'g1', vs: ['c-clock'], games: [
        { seed: 1, p1: 'ismcts', p2: 'c-clock', outcome: 'ERROR', by: 'p1', winner: 'c-clock', winnerSeat: 'p2' },
        { seed: 1, p1: 'c-clock', p2: 'ismcts', outcome: 'won', winnerSeat: 'p2' },
        { seed: 2, p1: 'ismcts', p2: 'c-clock', outcome: 'ERROR', by: 'p2', winner: 'ismcts', winnerSeat: 'p1' },
        { seed: 2, p1: 'c-clock', p2: 'ismcts', outcome: 'ERROR', by: null, winnerSeat: null }
    ] }]);
    const f = sk.skillOf(forfeits.tallies.get('ismcts'));
    assert.deepStrictEqual([f.decided, f.score, f.incomplete], [3, 2, 1]);
    assert.deepStrictEqual(f.incompleteOutcomes, { ERROR: 1 });

    // one reference per analysis, one run per challenger, one copy of a bot
    assert.throws(() => sk.gauntletTallies([{ id: 'a', vs: ['c-clock'], games: [] }, { id: 'b', vs: ['heuristic'], games: [] }]), /share one reference/);
    assert.throws(() => sk.gauntletTallies([{ id: 'a', vs: ['c-clock', 'heuristic'], games: [] }]), /exactly one reference/);
    assert.throws(() => sk.gauntletTallies([
        { id: 'a', vs: ['c-clock'], games: seedGames('heuristic', 'c-clock', 1, [1, 1]) },
        { id: 'b', vs: ['c-clock'], games: seedGames('heuristic', 'c-clock', 2, [1, 1]) }
    ]), /plays in two gauntlet runs/);
    assert.throws(() => sk.gauntletTallies([{ id: 'a', vs: ['c-clock'], games: [...seedGames('x#1', 'c-clock', 1, [1, 1]), ...seedGames('x#2', 'c-clock', 1, [1, 1])] }]),
        /x#1 and x#2 are copies of one bot \(x\)/);
}

// 2. paired difference: only seeds with the same decks, seats and keys, and four decided games
{
    const a = [];
    const b = [];
    for (let s = 1; s <= 40; s++) {
        a.push(...seedGames('A', 'ref', s, [1, 1]));
        b.push(...seedGames('B', 'ref', s, s % 2 ? [1, 0] : [0, 0]));
    }
    a.push(...seedGames('A', 'ref', 41, [1, 1], { p1: 'd0', p2: 'd1' }));
    b.push(...seedGames('B', 'ref', 41, [0, 0], { p1: 'd2', p2: 'd1' })); // other decks
    a.push(...seedGames('A', 'ref', 42, [1, 1]));
    b.push(...seedGames('B', 'ref', 42, [0, 0], undefined, { key: 'other' })); // other game key
    a.push(...seedGames('A', 'ref', 43, [1, null]));
    b.push(...seedGames('B', 'ref', 43, [0, 0]));
    a.push(seedGames('A', 'ref', 44, [1, 1])[0]); // only one seat played so far
    b.push(...seedGames('B', 'ref', 44, [0, 0]));
    a.push(...seedGames('A', 'ref', 45, [1, 1]));
    b.push(...seedGames('B', 'ref', 45, [0, 0], undefined, { key: null })); // a run without --key does not pair with one
    const g = sk.gauntletTallies([{ id: 'g', vs: ['ref'], games: [...a, ...b] }]);
    const p = sk.pairedDifference(g.tallies.get('A'), g.tallies.get('B'));
    assert.strictEqual(p.seeds, 40);
    assert.strictEqual(p.mismatched, 3);
    assert.strictEqual(p.incomplete, 1);
    assert.strictEqual(p.partial, 1);
    close(p.meanDiff, 0.75, 1e-12, 'mean difference'); // A scores 1 a seed; B 0.5 on odd seeds and 0 on even ones
    close(p.se, Math.sqrt(0.25 * 0.25 * 40 / 39) / Math.sqrt(40), 1e-12, 'se');
    assert(p.ci[0] < 0.75 && p.ci[1] > 0.75);
    assert.deepStrictEqual([p.aBetter, p.bBetter, p.even], [40, 0, 0]);
    const q = sk.pairedDifference(g.tallies.get('B'), g.tallies.get('A'));
    close(q.meanDiff, -0.75, 1e-12, 'reversed');
    const none = sk.pairedDifference(g.tallies.get('A'), { bot: 'C', seeds: new Map() });
    assert.strictEqual(none.seeds, 0);
    assert.strictEqual(none.meanDiff, null);
    assert.strictEqual(none.ci, null);
}

// 3. style gap: aggro and control pools weighted by games (bot) and by decks (human)
{
    const row = (games, winRate, human, n) => ({ vsOtherStyles: { games, winRate }, human: { meanGameWinPct: human, n } });
    const st = sk.styleGap({
        hyperaggro: row(100, 0.7, 0.52, 1), softaggro: row(300, 0.6, 0.5, 3), midrange: row(200, 0.5, 0.5, 2),
        softcontrol: row(200, 0.4, 0.51, 2), hardcontrol: row(200, 0.3, 0.49, 2)
    });
    close(st.aggro.winRate, 0.625, 1e-12, 'aggro pool');
    close(st.control.winRate, 0.35, 1e-12, 'control pool');
    close(st.aggro.human, 0.505, 1e-12, 'human aggro');
    close(st.control.human, 0.5, 1e-12, 'human control');
    close(st.botGap, 0.275, 1e-12, 'bot gap');
    close(st.humanGap, 0.005, 1e-12, 'human gap');
    close(st.excess, 0.27, 1e-12, 'excess');
    const empty = sk.styleGap(undefined);
    assert.strictEqual(empty.botGap, null);
    assert.strictEqual(empty.excess, null);
}

// 4. exact Spearman: every ordering once, the p of a perfect order, ties, and no exact p past 8 bots
{
    let count = 0;
    const seen = new Set();
    sk.permutations([1, 2, 3, 4, 5], (x) => {
        count++;
        seen.add(x.join(','));
    });
    assert.strictEqual(count, 120);
    assert.strictEqual(seen.size, 120);
    const up = sk.spearmanExact([1, 2, 3, 4, 5], [10, 20, 30, 40, 50]);
    assert.strictEqual(up.rho, 1);
    close(up.p, 2 / 120, 1e-12, 'perfect order, two-sided');
    const down = sk.spearmanExact([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]);
    close(down.rho, -1, 1e-12, 'reversed');
    close(down.p, 2 / 120, 1e-12, 'reversed p');
    const tied = sk.spearmanExact([1, 2, 3, 4], [1, 1, 2, 2]);
    assert(tied.rho > 0.8 && tied.rho < 1);
    assert(tied.p > 2 / 24);
    const many = sk.spearmanExact([1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.strictEqual(many.rho, 1);
    assert.strictEqual(many.p, null);
    assert.strictEqual(sk.spearmanExact([1, 2], [1, 2]).rho, null);
}

// 5. the join: mirror pick, the reference at 50%, its r with itself out of the trend, bots without a mirror run
const cmpFixture = () => {
    const run = (id, bot, decided) => ({ id, bot, mirror: true, decided, incomplete: 0, leftOut: [] });
    const deck = (r, dis) => ({ bt: { n: 26, strength: { pearson: r, pearsonCI95: [r - 0.3, r + 0.3], spearman: r, permutationP: { pearson: 0.5 } }, disattenuated: { value: dis } } });
    const style = (a, c) => ({
        softaggro: { vsOtherStyles: { games: 100, winRate: a }, human: { meanGameWinPct: 0.5, n: 1 } },
        hardcontrol: { vsOtherStyles: { games: 100, winRate: c }, human: { meanGameWinPct: 0.5, n: 1 } }
    });
    return {
        credit: ['deck credit'], generatedAt: '2026-10-11T00:00:00.000Z', humanModel: { reliability: 0.61 },
        runs: [run('ccl', 'c-clock', 7000), run('ccl-small', 'c-clock', 700), run('heu', 'heuristic', 700), run('rs', 'rust-search', 700),
            { id: 'mixed', bot: 'heuristic vs c-clock', mirror: false, decided: 50 }],
        agreement: {
            deck: { ccl: deck(-0.05, -0.06), heu: deck(0.2, 0.3), rs: deck(0.4, 0.55), 'ccl-small': deck(0, 0) },
            pair: { ccl: { favourite: { share: 0.53, n: 100 }, pearsonWeighted: -0.1, permutationP: { favouriteShare: 0.3 } }, heu: { favourite: { share: 0.6, n: 100 } } },
            style: { ccl: style(0.7, 0.3), heu: style(0.6, 0.4), rs: style(0.55, 0.45) },
            splitHalf: { ccl: { spearmanBrown: 0.98 } },
            betweenRuns: [{ a: 'ccl', b: 'heu', pearson: 0.6, pearsonCI95: [0.3, 0.8] }, { a: 'rs', b: 'ccl', pearson: 0.4 }, { a: 'heu', b: 'rs', pearson: 0.9 }]
        }
    };
};
{
    const games = [];
    for (let s = 1; s <= 10; s++) {
        games.push(...seedGames('heuristic', 'c-clock', s, s <= 6 ? [1, 1] : [0, 0]));
        games.push(...seedGames('rust-search', 'c-clock', s, s <= 8 ? [1, 1] : [0, 0]));
        games.push(...seedGames('random', 'c-clock', s, [0, 0]));
    }
    const gl = { id: 'gl', vs: ['c-clock'], challengers: ['heuristic', 'rust-search', 'random'], games, decks: 5, gamesPerPair: 20 };
    const r = sk.skillVsAgreement([gl], cmpFixture(), { now: new Date('2026-10-11T12:00:00Z') });
    assert.strictEqual(r.reference, 'c-clock');
    assert.deepStrictEqual(r.bots.map((b) => b.bot), ['rust-search', 'heuristic', 'c-clock', 'random']);
    const by = Object.fromEntries(r.bots.map((b) => [b.bot, b]));
    assert.deepStrictEqual(by['c-clock'].skill, { winRate: 0.5, elo: 0, reference: true });
    assert.strictEqual(by['c-clock'].agreement.run, 'ccl', 'the bigger mirror run');
    assert.deepStrictEqual(by['c-clock'].agreement.otherRuns, ['ccl-small']);
    assert.strictEqual(by['c-clock'].agreement.withReference, null);
    assert.strictEqual(by.heuristic.agreement.withReference, 0.6);
    assert.strictEqual(by['rust-search'].agreement.withReference, 0.4, 'found with the run ids either way round');
    assert.strictEqual(by['rust-search'].skill.winRate, 0.8);
    assert.strictEqual(by.random.agreement, null);
    close(by.heuristic.agreement.styleExcess, 0.2, 1e-12, 'style excess');
    close(by.heuristic.agreement.styleDistance, 0.2, 1e-12, 'style distance');
    assert.strictEqual(r.paired.length, 3);
    assert.deepStrictEqual(r.trend.deckR.bots, ['rust-search', 'heuristic', 'c-clock']);
    assert.strictEqual(r.trend.deckR.rho, 1);
    close(r.trend.deckR.p, 2 / 6, 1e-12, 'three bots in perfect order');
    assert.deepStrictEqual(r.trend.withReference.bots, ['rust-search', 'heuristic']);
    assert.strictEqual(r.trend.withReference.rho, null, 'two points have no Spearman');
    assert.strictEqual(r.trend.styleDistance.rho, -1);
    assert.deepStrictEqual(r.credit, ['deck credit']);
    assert.strictEqual(r.humanReliability, 0.61);
    assert.strictEqual(r.generatedAt, '2026-10-11T12:00:00.000Z');
    assert.deepStrictEqual(r.warnings, []);
    const text = sk.summaryText(r);
    assert.match(text, /^skill vs c-clock on the real decks \(gauntlets: gl\)/);
    assert.match(text, /rust-search\s+20\s+80\.0 \[/);
    assert.match(text, /random .*\| no mirror run/);
    assert.match(text, /rust-search - heuristic: \+20\.0 points/);
    assert.match(text, /rust-search - random: \+80\.0 points \[\+53\.9, \+100\.0\]/, 'CI clamped to 100 points');
    assert.deepStrictEqual(r.paired.map((p) => [p.a, p.b]), [['rust-search', 'heuristic'], ['rust-search', 'random'], ['heuristic', 'random']]);
    assert.match(text, /Credit: deck credit/);

    const noRef = cmpFixture();
    noRef.runs = noRef.runs.filter((x) => x.bot !== 'c-clock');
    const r2 = sk.skillVsAgreement([gl], noRef);
    assert.match(r2.warnings[0], /no mirror run of the reference bot c-clock/);
    assert.strictEqual(r2.bots.find((b) => b.bot === 'heuristic').agreement.withReference, null);

    // warnings: a part pass, a gauntlet without decks, and bots whose left-out decks differ
    // seeds 1-10 put each of the 5 decks twice on each side; seeds 1-7 do not
    assert.deepStrictEqual(sk.deckBalance(sk.gauntletTallies([gl]).tallies.get('heuristic')), { decided: 20, full: 10, half: 0, off: 0, max: 0 });
    const part = sk.skillVsAgreement([{ ...gl, status: 'running', games: games.filter((x) => x.seed <= 7) }], cmpFixture());
    assert.match(part.warnings.join('\n'), /heuristic \(gl, still running\): over its 14 decided games \(0 incomplete left out, 7 seeds with both games decided\), 4 decks are not on its side as often as on the reference's \(off by up to 2 games\)/);
    // a game dropped as incomplete unbalances its decks too
    const crashed = games.map((x) => (x.seed === 4 && x.p1 === 'heuristic' ? { ...x, outcome: 'ERROR', winnerSeat: null } : x));
    assert.deepStrictEqual(sk.deckBalance(sk.gauntletTallies([{ ...gl, games: crashed }]).tallies.get('heuristic')), { decided: 19, full: 9, half: 1, off: 2, max: 1 });
    assert.match(sk.skillVsAgreement([{ ...gl, games: crashed }], cmpFixture()).warnings.join('\n'), /heuristic \(gl\): over its 19 decided games \(1 incomplete left out, 9 seeds with both games decided, 1 with one\)/);
    assert.strictEqual(part.warnings.length, 3, 'one per challenger');
    // the same count of seeds can still be unbalanced when they finish out of order: seed 11 done before seed 10
    const shifted = games.filter((x) => x.seed !== 10 || x.p1 === 'random' || x.p2 === 'random' || x.p1 === 'rust-search' || x.p2 === 'rust-search')
        .concat(seedGames('heuristic', 'c-clock', 11, [1, 1]));
    const r6 = sk.skillVsAgreement([{ ...gl, games: shifted }], cmpFixture());
    assert.deepStrictEqual(r6.warnings.map((w) => w.split(':')[0]), ['heuristic (gl)']);
    assert.match(r6.warnings[0], /over its 20 decided games \(0 incomplete left out, 10 seeds with both games decided\), 4 decks are not on its side as often/);
    const oneGame = sk.skillVsAgreement([{ ...gl, games: games.filter((x) => !(x.seed === 3 && x.p1 === 'c-clock' && x.p2 === 'random')) }], cmpFixture());
    assert.deepStrictEqual(oneGame.warnings.map((w) => w.split(':')[0]), ['random (gl)'], 'a seed with one game left unbalances only that bot');
    assert.match(oneGame.warnings[0], /over its 19 decided games \(0 incomplete left out, 9 seeds with both games decided, 1 with one\), 2 decks/);
    assert.throws(() => sk.skillVsAgreement([gl, { ...gl, challengers: [], games: [] }], cmpFixture()), /run ids must be unique.*found twice: gl/);
    const plain = sk.skillVsAgreement([{ ...gl, decks: null }], cmpFixture());
    assert.match(plain.warnings.join('\n'), /gl: no deck list in ladder.json/);
    const left = cmpFixture();
    for (const id of ['ccl', 'heu', 'rs']) {
        left.agreement.deck[id].left = [{ deck: 'no-human-data', reason: 'no human BT strength' }];
    }
    assert.deepStrictEqual(sk.skillVsAgreement([gl], left).warnings, [], 'a deck every bot leaves out is no difference');
    left.agreement.deck.heu.left.push({ deck: 'lando', reason: 'fewer than 10 decided games' });
    const r3 = sk.skillVsAgreement([gl], left);
    assert.match(r3.warnings.join('\n'), /different deck sets \(decks outside a bot's deck correlation that other bots keep: heuristic: lando\)/);
    assert.deepStrictEqual(r3.bots.find((b) => b.bot === 'heuristic').agreement.leftOut, ['no-human-data', 'lando']);

    // deck files: a gauntlet from another file gets a warning and never pairs with one from this file
    const sha = (c) => c.repeat(64);
    const withFile = cmpFixture();
    withFile.deckFile = { decks: 5, sha256: sha('a') };
    const split = [
        { ...gl, id: 'g-a', decksSha256: sha('a'), games: games.filter((x) => x.p1 !== 'random' && x.p2 !== 'random') },
        { ...gl, id: 'g-b', decksSha256: sha('b'), games: games.filter((x) => x.p1 === 'random' || x.p2 === 'random') }
    ];
    const r4 = sk.skillVsAgreement(split, withFile);
    assert.match(r4.warnings.join('\n'), /deck files differ \(sha256 compare.json aaaaaaaaaaaa, g-a aaaaaaaaaaaa, g-b bbbbbbbbbbbb\)/);
    const cross = r4.paired.find((p) => p.b === 'random' && p.a === 'heuristic');
    assert.deepStrictEqual([cross.seeds, cross.mismatched], [0, 10]);
    assert.strictEqual(r4.paired.find((p) => p.a === 'rust-search' && p.b === 'heuristic').seeds, 10, 'same file still pairs');
    // a mirror run made from another deck file is caught too
    const mirrorFile = cmpFixture();
    mirrorFile.deckFile = { decks: 5, sha256: sha('a') };
    mirrorFile.runs.find((x) => x.id === 'heu').decksSha256 = sha('c');
    const r5 = sk.skillVsAgreement([{ ...gl, decksSha256: sha('a') }], mirrorFile);
    assert.match(r5.warnings.join('\n'), /deck files differ \(sha256 compare.json aaaaaaaaaaaa, mirror heu cccccccccccc, gl aaaaaaaaaaaa\)/);
}

// 5b. deck-type rows: the challenger's score by the style of the deck it holds, from the styles option or cmp.decks
{
    const styleOf = new Map([['d0', 'hyperaggro'], ['d1', 'hardcontrol'], ['d2', 'midrange'], ['d3', 'hyperaggro']]);
    const games = [
        ...seedGames('heuristic', 'c-clock', 1, [1, 0], { p1: 'd0', p2: 'd1' }),
        ...seedGames('heuristic', 'c-clock', 2, [0.5, null], { p1: 'd3', p2: 'd2' }),
        ...seedGames('heuristic', 'c-clock', 3, [1, 1], { p1: 'd1', p2: 'd0' }),
        ...seedGames('heuristic', 'c-clock', 4, [0, 0], { p1: 'd4', p2: 'd2' })
    ];
    const t = sk.gauntletTallies([{ id: 'g', vs: ['c-clock'], games }]).tallies.get('heuristic');
    const row = sk.styleRow(t, styleOf);
    assert.deepStrictEqual(Object.keys(row), ['hyperaggro', 'hardcontrol', 'unknown'], 'STYLES order, then the rest');
    // a bot keeps its deck in both games of a seed: d0 twice, d3 once (a draw; the incomplete game is out)
    assert.deepStrictEqual([row.hyperaggro.decided, row.hyperaggro.score, row.hyperaggro.winRate], [3, 1.5, 0.5]);
    assert.deepStrictEqual(row.hyperaggro.ci, wilson(1.5, 3));
    assert.deepStrictEqual([row.hardcontrol.decided, row.hardcontrol.score, row.unknown.decided, row.unknown.score], [2, 2, 2, 0]);
    const gl = { id: 'g', vs: ['c-clock'], challengers: ['heuristic'], games, decks: 5 };
    assert.strictEqual(Object.values(row).reduce((a, x) => a + x.decided, 0), sk.skillOf(t).decided, 'every decided game in one row');
    const fromCmp = sk.skillVsAgreement([gl], { ...cmpFixture(), decks: [...styleOf].map(([name, style]) => ({ name, style })) });
    assert.deepStrictEqual(fromCmp.bots.find((b) => b.bot === 'heuristic').skill.byStyle, row);
    const given = sk.skillVsAgreement([gl], null, { styles: { d0: 'midrange' } });
    assert.deepStrictEqual(Object.keys(given.bots.find((b) => b.bot === 'heuristic').skill.byStyle), ['midrange', 'unknown']);
    assert.strictEqual(sk.skillVsAgreement([gl], cmpFixture()).bots.find((b) => b.bot === 'heuristic').skill.byStyle, null, 'no styles, no row');
    assert.match(sk.summaryText(fromCmp), /by deck type: win% vs c-clock[^\n]*\n[^\n]*\n\s+hyperaggro\s+hardcontrol\s+unknown\nheuristic\s+50\.0 \(3\)\s+100\.0 \(2\)\s+0\.0 \(2\)$/m);
    assert.deepStrictEqual([row.hyperaggro.expected, row.hyperaggro.edge, row.hyperaggro.expectedGames], [null, null, 0], 'no reference model, no expectation');

    // what the reference scores with the same decks: its mirror's deck model, σ(s[held] − s[opp] ± seat)
    const sig = (x) => 1 / (1 + Math.exp(-x));
    const strengths = { d0: 1, d1: -1, d2: 0, d3: 0.5 };
    const model = { ...cmpFixture(), decks: [...styleOf].map(([name, style]) => ({ name, style, runs: name in strengths ? { ccl: { strength: strengths[name] } } : {} })) };
    const m = sk.referenceModel(model, 'ccl');
    close(m('d0', 'd1', 'p1'), sig(2), 1e-12, 'no seat term in the run: none');
    assert.strictEqual(m('d4', 'd0', 'p1'), null, 'a deck without a strength');
    model.runs.find((r) => r.id === 'ccl').seat = { logit: 0.3 };
    const ms = sk.referenceModel(model, 'ccl');
    close(ms('d0', 'd1', 'p1'), sig(2.3), 1e-12, 'seat term for p1');
    close(ms('d0', 'd1', 'p2'), sig(1.7), 1e-12, 'and against p2');
    assert.strictEqual(sk.referenceModel(model, 'nope'), null);
    model.runs.find((r) => r.id === 'ccl').seat = { logit: 0 };
    const byE = sk.skillVsAgreement([gl], model).bots.find((b) => b.bot === 'heuristic').skill.byStyle;
    // hyperaggro: d0 vs d1 twice (1, 0) and d3 vs d2 once (a draw); hardcontrol: d1 vs d0 twice (1, 1); d4 has no strength
    close(byE.hyperaggro.expected, (2 * sig(2) + sig(0.5)) / 3, 1e-12, 'expected hyperaggro');
    close(byE.hyperaggro.edge, (1.5 - 2 * sig(2) - sig(0.5)) / 3, 1e-12, 'edge hyperaggro');
    close(byE.hardcontrol.edge, 1 - sig(-2), 1e-12, 'edge hardcontrol');
    assert.deepStrictEqual([byE.unknown.expected, byE.unknown.edge, byE.unknown.expectedGames, byE.unknown.decided], [null, null, 0, 2]);
    assert.match(sk.summaryText(sk.skillVsAgreement([gl], model)), /heuristic\s+50\.0 \(3\) -29\s+100\.0 \(2\) \+88\s+0\.0 \(2\)$/m);
}

// 6. the command line, on a run directory written like ladder.js writes a gauntlet
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'realdeck-skill-'));
    try {
        const games = [];
        for (let s = 1; s <= 6; s++) {
            games.push(...seedGames('heuristic', 'c-clock', s, [1, s % 2]));
        }
        const run = path.join(dir, 'g1');
        fs.mkdirSync(run);
        fs.writeFileSync(path.join(run, 'index.json'), JSON.stringify({ id: 'g1', bots: ['heuristic', 'c-clock'], games }));
        fs.writeFileSync(path.join(run, 'ladder.json'), JSON.stringify({ status: 'done', config: { bots: ['heuristic', 'c-clock'], format: 'gauntlet', vs: ['c-clock'], firstSeed: 1 } }));
        const plain = path.join(dir, 'mirror');
        fs.mkdirSync(plain);
        fs.writeFileSync(path.join(plain, 'index.json'), JSON.stringify({ id: 'mirror', bots: ['x#a', 'x#b'], games: [] }));
        fs.writeFileSync(path.join(plain, 'ladder.json'), JSON.stringify({ status: 'done', config: { bots: ['x#a', 'x#b'] } }));
        const cmp = path.join(dir, 'compare.json');
        fs.writeFileSync(cmp, JSON.stringify(cmpFixture()));
        const out = path.join(dir, 'skill.json');
        const g = sk.readGauntlet(run);
        assert.deepStrictEqual(g.challengers, ['heuristic']);
        assert.deepStrictEqual(g.vs, ['c-clock']);
        assert.strictEqual(g.status, 'done');
        assert.throws(() => sk.readGauntlet(plain), /not a gauntlet run/);
        const script = path.join(__dirname, '..', 'realdeck', 'skill.js');
        const stdout = execFileSync(process.execPath, [script, '--gauntlet', run, '--compare', cmp, '--out', out], { encoding: 'utf8' });
        assert.match(stdout, /gauntlets: g1 done/);
        assert.match(stdout, /warning: g1: no deck list in ladder.json/);
        assert.match(stdout, /heuristic\s+12\s+75\.0/);
        const json = JSON.parse(fs.readFileSync(out, 'utf8'));
        assert.deepStrictEqual(Object.keys(json), ['credit', 'generatedAt', 'reference', 'gauntlets', 'compare', 'humanReliability', 'bots', 'paired', 'trend', 'warnings']);
        assert.deepStrictEqual(Object.keys(json.trend), sk.MEASURES.map((m) => m[0]));
        assert.strictEqual(json.gauntlets[0].games, 12);
        assert.throws(() => execFileSync(process.execPath, [script, '--gauntlet', run], { stdio: 'pipe' }), /usage/);
        assert.throws(() => sk.parseArgs(['--compare']), /needs a value/);
        assert.throws(() => sk.parseArgs(['--what', 'x']), /unknown option/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

console.log('ok: realdeck skill tallies, paired differences, style gap, exact Spearman, join, deck-type rows, cli');
