'use strict';

/**
 * Do stronger bots agree more with humans? Bot skill from a gauntlet on the real decks, joined with each bot's
 * agreement with humans from compare.js.
 *
 *   node analysis/realdeck/skill.js --gauntlet <run dir>[,<run dir>...] --compare <compare.json> [--out skill.json]
 *
 * A gauntlet run is one `node bot/ladder.js --decks <file> --bots a,b,c --vs <ref> --key K --seed 1` directory
 * (index.json, ladder.json with config.format 'gauntlet'). Every challenger plays the one reference bot on the same
 * seeds; with the same --key and --seed (also across runs) the deals are the same, so challengers can be compared
 * game for game. All runs must share the reference bot, and each challenger plays in one run only (one copy: no
 * `bot#1`, `bot#2`). Play whole passes (--games a multiple of 2P, P = n(n−1)/2 deck pairs: 702 for 27 decks), so every
 * deck sits on the challenger's side as often as on the reference's; otherwise deck luck is left in the skill and the
 * reference's 50% is not on the same deals (a warning says so).
 *
 * Skill: the challenger's score against the reference in decided games (a draw counts half), a Wilson 95% CI, and the
 * same as an Elo difference. An ERROR game a bot caused (`by` set: it threw, made an illegal move or timed out) is a
 * loss for that bot, as in bot/ladder-report.js. Games that end in an engine ERROR (`by` null), STEP_CAP, STUCK or
 * anything else are counted, by outcome, and left out. Games still running are ignored. The reference itself is 50% by
 * definition.
 *
 * Paired: for every two challengers, the seeds both played with the same decks from the same seats and the same game
 * key (or none on both) with all four games decided. Per seed d = (A's score − B's score) / 2 over its two games; the
 * mean d with a normal 95% CI (clamped to ±1), and how many seeds each side did better. A is the challenger with the
 * higher win rate. Seeds whose deals differ are counted as `mismatched` (different --key, --seed or deck file), never
 * paired.
 *
 * Agreement, per bot, from compare.js (`--out` of compare.js, with every bot's mirror run in it; the run with the most
 * decided games when a bot has several):
 *  - deck r: bot deck strength vs human BT strength (Pearson, Fisher CI, permutation p, disattenuated r);
 *  - favourite share: deck pairs where bot and humans pick the same favourite, with its deck-label permutation p;
 *  - style: pooled win rate vs other styles of aggro decks (hyperaggro, softaggro) minus control decks (softcontrol,
 *    hardcontrol), beside the same gap in the human field rates; `excess` is the bot gap minus the human gap and
 *    `styleDistance` its size. Pooled from compare.js's style rows, so a hyperaggro vs softaggro game sits in the aggro
 *    pool as a win and a loss;
 *  - r with the reference: the bot's deck strengths vs the reference bot's own (compare.js betweenRuns).
 * compare.js leaves out decks with too many incomplete games per run; when the bots' left-out decks differ, their
 * measures are not on the same decks and a warning says so.
 *
 * Trend: Spearman of skill against each agreement measure, over the bots that have both (the reference included at
 * 50%, except for its r with itself), with an exact two-sided permutation p-value for up to 8 bots. A handful of bots:
 * a description, not a test of a law.
 */

const fs = require('fs');
const path = require('path');
const { weightedCorr, ranks } = require('../swustats/compare');
const { readRun, wilson } = require('./compare');

const AGGRO = ['hyperaggro', 'softaggro'];
const CONTROL = ['softcontrol', 'hardcontrol'];
const EXACT_MAX = 8; // 8! = 40,320 orderings
const Z95 = 1.959964;
const MEASURES = [
    ['deckR', 'deck r vs human BT', 'higher = closer to humans'],
    ['deckRDisattenuated', 'deck r, disattenuated', 'higher = closer to humans'],
    ['favouriteShare', 'same favourite as humans', 'higher = closer to humans'],
    ['styleDistance', 'distance of the aggro-minus-control gap from the human gap', 'lower = closer to humans'],
    ['withReference', 'deck r with the reference bot', 'lower = further from the reference']
];

function parseArgs(argv) {
    const a = { gauntlet: [], compare: null, out: null };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const value = () => {
            if (i + 1 >= argv.length) {
                throw new Error(`${k} needs a value`);
            }
            return argv[++i];
        };
        if (k === '--gauntlet') {
            a.gauntlet.push(...value().split(',').filter(Boolean));
        } else if (k === '--compare') {
            a.compare = value();
        } else if (k === '--out') {
            a.out = value();
        } else {
            throw new Error(`unknown option ${k}`);
        }
    }
    return a;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** 'heuristic#2' -> 'heuristic' */
const base = (name) => String(name).replace(/#.*$/, '');

/** A gauntlet run directory: readRun plus its reference bot (ladder.json config.vs) and challengers. */
function readGauntlet(dir) {
    const run = readRun(dir);
    let config = null;
    try {
        config = readJson(path.join(dir, 'ladder.json')).config;
    } catch {
        config = null;
    }
    if (config?.format !== 'gauntlet' || !Array.isArray(config.vs) || !config.vs.length) {
        throw new Error(`${dir}: not a gauntlet run (ladder.json needs config.format 'gauntlet' and config.vs)`);
    }
    return {
        ...run, vs: config.vs, challengers: run.entries.filter((b) => !config.vs.includes(b)), firstSeed: config.firstSeed ?? null,
        gamesPerPair: config.gamesPerPair ?? null, decks: Array.isArray(config.decks?.names) ? config.decks.names.length : null
    };
}

/**
 * Tally each challenger against the reference. runs: from readGauntlet (or the same shape: {id, vs, games}). Returns
 * {reference, tallies: Map(bot -> tally), skipped, warnings}; a tally keeps its games by seed and seat for pairing.
 */
function gauntletTallies(runs) {
    for (const run of runs) {
        if (!Array.isArray(run.vs) || run.vs.length !== 1) {
            throw new Error(`${run.id}: a gauntlet run needs exactly one reference bot (--vs), found ${JSON.stringify(run.vs)}`);
        }
    }
    const refs = [...new Set(runs.map((r) => base(r.vs[0])))];
    if (refs.length !== 1) {
        throw new Error(`gauntlet runs must share one reference bot, found: ${refs.join(', ') || 'none'}`);
    }
    const tallies = new Map();
    const warnings = [];
    let skipped = 0;
    let duplicates = 0;
    for (const run of runs) {
        const ref = run.vs[0];
        for (const g of run.games) {
            if (g.outcome === 'running') {
                continue;
            }
            const seat = g.p2 === ref && g.p1 !== ref ? 'p1' : g.p1 === ref && g.p2 !== ref ? 'p2' : null;
            if (!seat) {
                skipped++;
                continue;
            }
            const bot = base(g[seat]);
            let t = tallies.get(bot);
            if (!t) {
                t = {
                    bot, entry: g[seat], run: run.id, games: 0, decided: 0, score: 0, draws: 0, incomplete: 0, incompleteOutcomes: {},
                    bySeat: { p1: { decided: 0, score: 0 }, p2: { decided: 0, score: 0 } }, seeds: new Map()
                };
                tallies.set(bot, t);
            } else if (t.run !== run.id) {
                throw new Error(`${bot} plays in two gauntlet runs (${t.run}, ${run.id}): give each challenger once`);
            } else if (t.entry !== g[seat]) {
                throw new Error(`${t.entry} and ${g[seat]} are copies of one bot (${bot}): enter one copy per gauntlet`);
            }
            const s = g.winnerSeat;
            const forfeit = g.outcome === 'ERROR' && (g.by === 'p1' || g.by === 'p2');
            const decided = forfeit || ((g.outcome ?? 'won') === 'won' && (s === 'p1' || s === 'p2' || s === 'draw'));
            const y = !decided ? null : forfeit ? (g.by === seat ? 0 : 1) : s === 'draw' ? 0.5 : s === seat ? 1 : 0;
            const rec = t.seeds.get(g.seed) ?? {};
            if (rec[seat]) {
                duplicates++;
                continue;
            }
            rec[seat] = { y, decks: g.decks ?? null, key: g.key ?? null };
            t.seeds.set(g.seed, rec);
            t.games++;
            if (y === null) {
                const o = String(g.outcome ?? 'unknown');
                t.incomplete++;
                t.incompleteOutcomes[o] = (t.incompleteOutcomes[o] ?? 0) + 1;
                continue;
            }
            t.decided++;
            t.score += y;
            t.draws += y === 0.5 ? 1 : 0;
            t.bySeat[seat].decided++;
            t.bySeat[seat].score += y;
        }
    }
    if (skipped) {
        warnings.push(`${skipped} games skipped (no reference bot on exactly one seat)`);
    }
    if (duplicates) {
        warnings.push(`${duplicates} games skipped (a second game for the same challenger, seed and seat)`);
    }
    return { reference: refs[0], tallies, skipped, warnings };
}

/** Elo difference for a score rate; null at 0, 1 or without a rate. */
const elo = (p) => (p === null || p === undefined || p <= 0 || p >= 1 ? null : 400 * Math.log10(p / (1 - p)));

/** A tally as a skill row: rates, Wilson CI and Elo (with the Elo of the CI bounds). */
function skillOf(t) {
    const rate = t.decided ? t.score / t.decided : null;
    const ci = wilson(t.score, t.decided);
    const seat = (x) => ({ decided: x.decided, winRate: x.decided ? x.score / x.decided : null });
    return {
        run: t.run, games: t.games, decided: t.decided, draws: t.draws, incomplete: t.incomplete, incompleteOutcomes: t.incompleteOutcomes,
        score: t.score, winRate: rate, ci, elo: elo(rate), eloCI: ci ? [elo(ci[0]), elo(ci[1])] : null,
        bySeat: { p1: seat(t.bySeat.p1), p2: seat(t.bySeat.p2) }
    };
}

const sameDecks = (x, y) => !!x && !!y && x.p1 === y.p1 && x.p2 === y.p2;

/** Paired score difference of challengers A and B over the seeds both played with the same deals (see the header). */
function pairedDifference(A, B) {
    const ds = [];
    let mismatched = 0;
    let incomplete = 0;
    let partial = 0;
    for (const [seed, a] of A.seeds) {
        const b = B.seeds.get(seed);
        if (!b) {
            continue;
        }
        if (!a.p1 || !a.p2 || !b.p1 || !b.p2) {
            partial++;
            continue;
        }
        const keysDiffer = ['p1', 'p2'].some((s) => a[s].key !== b[s].key);
        if (!sameDecks(a.p1.decks, b.p1.decks) || !sameDecks(a.p2.decks, b.p2.decks) || keysDiffer) {
            mismatched++;
            continue;
        }
        if ([a.p1.y, a.p2.y, b.p1.y, b.p2.y].includes(null)) {
            incomplete++;
            continue;
        }
        ds.push((a.p1.y + a.p2.y - b.p1.y - b.p2.y) / 2);
    }
    const n = ds.length;
    const mean = n ? ds.reduce((s, d) => s + d, 0) / n : null;
    const sd = n > 1 ? Math.sqrt(ds.reduce((s, d) => s + (d - mean) ** 2, 0) / (n - 1)) : null;
    const se = sd === null ? null : sd / Math.sqrt(n);
    return {
        a: A.bot, b: B.bot, seeds: n, mismatched, incomplete, partial, meanDiff: mean, se,
        ci: se === null ? null : [Math.max(-1, mean - Z95 * se), Math.min(1, mean + Z95 * se)],
        aBetter: ds.filter((d) => d > 0).length, bBetter: ds.filter((d) => d < 0).length, even: ds.filter((d) => d === 0).length
    };
}

/** Aggro-minus-control gap from one compare.js style block (agreement.style[run]), bot side and human side. */
function styleGap(style) {
    const pool = (names) => {
        let games = 0;
        let score = 0;
        let hs = 0;
        let hn = 0;
        for (const s of names) {
            const v = style?.[s];
            if (!v) {
                continue;
            }
            const o = v.vsOtherStyles;
            if (o?.games && typeof o.winRate === 'number') {
                games += o.games;
                score += o.games * o.winRate;
            }
            if (typeof v.human?.meanGameWinPct === 'number' && v.human.n) {
                hs += v.human.n * v.human.meanGameWinPct;
                hn += v.human.n;
            }
        }
        return { games, winRate: games ? score / games : null, human: hn ? hs / hn : null, humanDecks: hn };
    };
    const a = pool(AGGRO);
    const c = pool(CONTROL);
    const botGap = a.winRate !== null && c.winRate !== null ? a.winRate - c.winRate : null;
    const humanGap = a.human !== null && c.human !== null ? a.human - c.human : null;
    return { aggro: a, control: c, botGap, humanGap, excess: botGap !== null && humanGap !== null ? botGap - humanGap : null };
}

/** The mirror run of each bot in a compare.js result: the one with the most decided games, and the others' ids. */
function mirrorRuns(cmp) {
    const out = new Map();
    for (const r of cmp?.runs ?? []) {
        if (!r.mirror) {
            continue;
        }
        const cur = out.get(r.bot);
        if (!cur) {
            out.set(r.bot, { run: r, others: [] });
        } else if ((r.decided ?? 0) > (cur.run.decided ?? 0)) {
            cur.others.push(cur.run.id);
            cur.run = r;
        } else {
            cur.others.push(r.id);
        }
    }
    return out;
}

/** One bot's agreement with humans from compare.js; refRun: the reference bot's run id (null when it has none). */
function agreementOf(cmp, pick, refRun) {
    const id = pick.run.id;
    const deck = cmp.agreement?.deck?.[id];
    const pair = cmp.agreement?.pair?.[id];
    const between = refRun && refRun !== id
        ? (cmp.agreement?.betweenRuns ?? []).find((b) => (b.a === id && b.b === refRun) || (b.a === refRun && b.b === id)) ?? null
        : null;
    const style = styleGap(cmp.agreement?.style?.[id]);
    return {
        run: id, otherRuns: pick.others, decided: pick.run.decided ?? null, incomplete: pick.run.incomplete ?? null,
        leftOut: (pick.run.leftOut ?? []).map((x) => x.deck),
        deckR: deck?.bt?.strength?.pearson ?? null, deckRCI: deck?.bt?.strength?.pearsonCI95 ?? null,
        deckRho: deck?.bt?.strength?.spearman ?? null, deckP: deck?.bt?.strength?.permutationP?.pearson ?? null,
        deckRDisattenuated: deck?.bt?.disattenuated?.value ?? null, deckN: deck?.bt?.n ?? null,
        botReliability: cmp.agreement?.splitHalf?.[id]?.spearmanBrown ?? null,
        favouriteShare: pair?.favourite?.share ?? null, favouriteN: pair?.favourite?.n ?? null,
        favouriteP: pair?.permutationP?.favouriteShare ?? null, pairR: pair?.pearsonWeighted ?? null,
        style, styleExcess: style.excess, styleDistance: style.excess === null ? null : Math.abs(style.excess),
        withReference: between ? between.pearson : null, withReferenceCI: between ? between.pearsonCI95 : null
    };
}

/** Calls f with every ordering of a (Heap's algorithm; the array passed is reused). */
function permutations(a, f) {
    const x = [...a];
    const c = new Array(x.length).fill(0);
    f(x);
    for (let i = 1; i < x.length;) {
        if (c[i] < i) {
            const j = i % 2 ? c[i] : 0;
            [x[j], x[i]] = [x[i], x[j]];
            f(x);
            c[i]++;
            i = 1;
        } else {
            c[i] = 0;
            i++;
        }
    }
}

/** Tie-aware Spearman rho with an exact two-sided permutation p (share of orderings with |rho| at least as large). */
function spearmanExact(xs, ys) {
    const n = xs.length;
    const rx = ranks(xs);
    const ry = ranks(ys);
    const rho = weightedCorr(rx, ry);
    if (rho === null || n > EXACT_MAX) {
        return { n, rho, p: null };
    }
    let k = 0;
    let N = 0;
    permutations(ry, (perm) => {
        N++;
        const r = weightedCorr(rx, perm);
        if (r !== null && Math.abs(r) >= Math.abs(rho) - 1e-12) {
            k++;
        }
    });
    return { n, rho, p: k / N };
}

/**
 * The whole join. gauntlets: from readGauntlet; cmp: a parsed compare.js result (or null). Pure apart from `now`.
 */
function skillVsAgreement(gauntlets, cmp, { now = new Date() } = {}) {
    const { reference, tallies, warnings } = gauntletTallies(gauntlets);
    const mirrors = mirrorRuns(cmp);
    const refRun = mirrors.get(reference)?.run.id ?? null;
    if (cmp && !refRun) {
        warnings.push(`compare.js result has no mirror run of the reference bot ${reference}`);
    }
    const names = [...new Set([reference, ...tallies.keys(), ...mirrors.keys()])];
    const bots = names.map((bot) => {
        const isRef = bot === reference;
        const t = tallies.get(bot);
        const pick = mirrors.get(bot);
        return {
            bot, reference: isRef,
            skill: isRef ? { winRate: 0.5, elo: 0, reference: true } : t ? skillOf(t) : null,
            agreement: pick ? agreementOf(cmp, pick, refRun) : null
        };
    });
    if (tallies.has(reference)) {
        warnings.push(`the reference bot ${reference} also plays as a challenger; its row is the reference`);
    }
    for (const g of gauntlets) {
        const P = g.decks ? (g.decks * (g.decks - 1)) / 2 : null;
        if (!P) {
            warnings.push(`${g.id}: no deck list in ladder.json, so not a real-deck gauntlet`);
        } else if (g.gamesPerPair && (g.gamesPerPair / 2) % P !== 0) {
            warnings.push(`${g.id}: ${g.gamesPerPair / 2} seeds per challenger is not a whole number of passes over the ${P} deck pairs, ` +
                `so decks do not sit on both sides equally often and the reference's 50% is not on the same deals (--games ${2 * P} plays one pass)`);
        }
    }
    const leftSets = bots.filter((b) => b.agreement).map((b) => [b.bot, [...b.agreement.leftOut].sort().join(', ')]);
    if (new Set(leftSets.map(([, l]) => l)).size > 1) {
        warnings.push(`agreement measures use different deck sets (decks compare.js left out: ${leftSets.map(([b, l]) => `${b}: ${l || 'none'}`).join('; ')})`);
    }
    bots.sort((p, q) => (q.skill?.winRate ?? -1) - (p.skill?.winRate ?? -1) || p.bot.localeCompare(q.bot));
    const rate = (t) => (t.decided ? t.score / t.decided : -1);
    const challengers = [...tallies.values()].filter((t) => t.bot !== reference).sort((p, q) => rate(q) - rate(p) || p.bot.localeCompare(q.bot));
    const paired = [];
    for (let i = 0; i < challengers.length; i++) {
        for (let j = i + 1; j < challengers.length; j++) {
            paired.push(pairedDifference(challengers[i], challengers[j]));
        }
    }
    const trend = {};
    for (const [key, label, reading] of MEASURES) {
        const use = bots.filter((b) => typeof b.skill?.winRate === 'number' && typeof b.agreement?.[key] === 'number' && !(key === 'withReference' && b.reference));
        trend[key] = { label, reading, bots: use.map((b) => b.bot), ...spearmanExact(use.map((b) => b.skill.winRate), use.map((b) => b.agreement[key])) };
    }
    return {
        credit: cmp?.credit ?? [],
        generatedAt: now.toISOString(),
        reference,
        gauntlets: gauntlets.map((g) => ({ id: g.id, dir: g.dir ?? null, status: g.status ?? null, vs: g.vs, challengers: g.challengers ?? null, games: g.games.length })),
        compare: cmp ? { generatedAt: cmp.generatedAt ?? null, runs: (cmp.runs ?? []).map((r) => ({ id: r.id, bot: r.bot, mirror: r.mirror, decided: r.decided })) } : null,
        humanReliability: cmp?.humanModel?.reliability ?? null,
        bots, paired, trend, warnings
    };
}

const f2 = (x, d = 2) => (x === null || x === undefined ? '-' : (x >= 0 ? '+' : '') + x.toFixed(d));
const pc = (x) => (x === null || x === undefined ? '-' : (100 * x).toFixed(1));
const pv = (x) => (x === null || x === undefined ? '-' : x < 0.001 ? '<0.001' : x.toFixed(3));
const el = (x) => (x === null || x === undefined ? '-' : (x >= 0 ? '+' : '') + Math.round(x));

/** A short plain-text summary of skillVsAgreement's result. */
function summaryText(r) {
    const L = [];
    L.push(`skill vs ${r.reference} on the real decks (gauntlets: ${r.gauntlets.map((g) => `${g.id}${g.status ? ` ${g.status}` : ''}`).join(', ')})`);
    for (const w of r.warnings) {
        L.push(`warning: ${w}`);
    }
    L.push(`${'bot'.padEnd(28)} decided  win% vs ref [95% CI]     Elo   | deck r vs humans (disatt.)  same fav.  style gap bot/human  r with ref`);
    for (const b of r.bots) {
        const s = b.skill;
        const a = b.agreement;
        const sk = !s ? `${'-'.padStart(7)}  ${'-'.padEnd(24)} ${'-'.padStart(5)}`
            : s.reference ? `${'ref'.padStart(7)}  ${'50.0'.padEnd(24)} ${'0'.padStart(5)}`
                : `${String(s.decided).padStart(7)}  ${`${pc(s.winRate)} [${s.ci ? `${pc(s.ci[0])}, ${pc(s.ci[1])}` : '-'}]`.padEnd(24)} ${el(s.elo).padStart(5)}`;
        const ag = !a ? 'no mirror run'
            : `${`${f2(a.deckR)} (${f2(a.deckRDisattenuated)})`.padEnd(27)} ${(a.favouriteShare === null ? '-' : `${pc(a.favouriteShare)}%`).padEnd(10)} ${`${f2(a.style.botGap)} / ${f2(a.style.humanGap)}`.padEnd(20)} ${b.reference ? 'ref' : f2(a.withReference)}`;
        L.push(`${b.bot.padEnd(28)} ${sk} | ${ag}`);
    }
    if (r.paired.length) {
        L.push('');
        L.push('paired, same deals (score difference per seed, A minus B):');
        for (const p of r.paired) {
            L.push(`  ${p.a} - ${p.b}: ${p.meanDiff === null ? '-' : `${f2(100 * p.meanDiff, 1)} points${p.ci ? ` [${f2(100 * p.ci[0], 1)}, ${f2(100 * p.ci[1], 1)}]` : ''}`} over ${p.seeds} seeds ` +
                `(A better ${p.aBetter}, B better ${p.bBetter}, even ${p.even}${p.mismatched ? `; ${p.mismatched} seeds with other deals` : ''}${p.incomplete ? `; ${p.incomplete} with an incomplete game` : ''})`);
        }
    }
    L.push('');
    L.push(`trend over bots (Spearman of skill vs the measure, exact two-sided p; descriptive)${r.humanReliability !== null ? `; human deck reliability ${r.humanReliability.toFixed(2)}` : ''}:`);
    for (const t of Object.values(r.trend)) {
        L.push(`  ${t.label} (${t.reading}): rho=${f2(t.rho)} p=${pv(t.p)} n=${t.n}`);
    }
    if (r.credit.length) {
        L.push('');
        L.push(`Credit: ${r.credit.join('; ')}`);
    }
    return L.join('\n');
}

const USAGE = 'usage: node analysis/realdeck/skill.js --gauntlet <run dir>[,<run dir>...] --compare <compare.json> [--out skill.json]';

function main() {
    let args;
    try {
        args = parseArgs(process.argv.slice(2));
    } catch (e) {
        console.error(`${e.message}\n${USAGE}`);
        process.exit(2);
    }
    if (!args.gauntlet.length || !args.compare) {
        console.error(USAGE);
        process.exit(2);
    }
    const r = skillVsAgreement(args.gauntlet.map(readGauntlet), readJson(args.compare));
    console.log(summaryText(r));
    if (args.out) {
        fs.writeFileSync(args.out, JSON.stringify(r, null, 1));
        console.log(`wrote ${args.out}`);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    MEASURES, parseArgs, readGauntlet, gauntletTallies, elo, skillOf, pairedDifference, styleGap, mirrorRuns, agreementOf,
    permutations, spearmanExact, skillVsAgreement, summaryText
};
