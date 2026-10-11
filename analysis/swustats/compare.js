'use strict';

/**
 * Do leaders that win for humans (SWU Stats) also win in our bot ladder?
 *
 *   node analysis/swustats/compare.js --human <dir with human-summary.json> --results <results dir> [--out compare.json] [--permute 300]
 *
 * One logistic model over every decided ladder game:
 *   P(p1 wins) = σ(bot1 − bot2 + leader1 − leader2 + base1 − base2 ± first)
 * Leader and base effects get ridge shrinkage (σ = 0.5 logit), since each has only tens of games. A second fit swaps
 * the free leader/base effects for one coefficient κ on the human strength (centred logit of the SWU Stats win rate).
 * --permute N shuffles the human values across leaders N times: the share of shuffles with a κ at least as large is
 * the honest p-value (the model's own error bar ignores that games share a leader).
 */

const fs = require('fs');
const path = require('path');
const { CREDIT } = require('./fetch');

const MIN_HUMAN_PLAYS = 200;
const SHRINK = 4; // 1/σ² with σ = 0.5 logit
const LOOSE = 0.01;

function parseArgs(argv) {
    const a = { human: null, results: null, out: null, permute: 0 };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--human') {
            a.human = argv[++i];
        } else if (k === '--results') {
            a.results = argv[++i];
        } else if (k === '--out') {
            a.out = argv[++i];
        } else if (k === '--permute') {
            a.permute = Number(argv[++i]);
        }
    }
    return a;
}

/** One row per bot ladder game: bots, leader/base per seat, who had the initiative, winner. Reads only file ends. */
function readLadderGames(root) {
    const rows = [];
    for (const run of fs.readdirSync(root).filter((r) => !r.startsWith('_')).sort()) {
        const dir = path.join(root, run, 'games');
        if (!fs.existsSync(dir)) {
            continue;
        }
        for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl')).sort()) {
            const row = readGame(path.join(dir, f));
            if (row) {
                rows.push({ run, game: f.replace(/\.jsonl$/, ''), ...row });
            }
        }
    }
    return rows;
}

function readGame(file) {
    const fd = fs.openSync(file, 'r');
    try {
        const size = fs.fstatSync(fd).size;
        const head = Buffer.alloc(Math.min(size, 64 * 1024));
        fs.readSync(fd, head, 0, head.length, 0);
        const lines = head.toString('utf8').split('\n');
        const h = JSON.parse(lines[0]);
        if (h.t !== 'header' || h.source) {
            return null; // imported human games are not ladder games
        }
        let s0 = null;
        let first = null;
        for (const l of lines.slice(1)) {
            let e;
            try {
                e = JSON.parse(l);
            } catch {
                break; // the 64 KB cut ends mid-line
            }
            if (e.t === 'step') {
                s0 = s0 ?? e.state;
                if (e.state?.initiative) {
                    first = e.state.initiative;
                    break;
                }
            }
        }
        const tail = Buffer.alloc(Math.min(size, 16 * 1024));
        fs.readSync(fd, tail, 0, tail.length, size - tail.length);
        const end = JSON.parse(tail.toString('utf8').trim().split('\n').pop());
        if (end.t !== 'end' || !s0) {
            return null;
        }
        const seat = (id) => ({ bot: h.players.find((x) => x.id === id)?.bot ?? null, leader: s0.players?.[id]?.leader?.s ?? null, base: s0.players?.[id]?.base?.s ?? null });
        return { p1: seat('p1'), p2: seat('p2'), first, winner: end.winner ?? null, error: end.error ?? null };
    } catch {
        return null;
    } finally {
        fs.closeSync(fd);
    }
}

const logit = (p) => Math.log(p / (1 - p));

/** Human strength per id: centred logit of the (smoothed) win rate, for ids with enough plays. */
function humanStrength(rows) {
    const m = new Map();
    let sw = 0;
    let s = 0;
    for (const r of rows) {
        if (r.plays >= MIN_HUMAN_PLAYS) {
            const v = logit((r.wins + 0.5) / (r.plays + 1));
            m.set(r.id, { v, plays: r.plays, winRate: r.wins / r.plays, name: r.name ?? null });
            sw += r.plays;
            s += r.plays * v;
        }
    }
    for (const x of m.values()) {
        x.v -= s / sw;
    }
    return m;
}

function solve(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
        let p = c;
        for (let r = c + 1; r < n; r++) {
            if (Math.abs(M[r][c]) > Math.abs(M[p][c])) {
                p = r;
            }
        }
        [M[c], M[p]] = [M[p], M[c]];
        for (let r = c + 1; r < n; r++) {
            const f = M[r][c] / M[c][c];
            if (f) {
                for (let k = c; k <= n; k++) {
                    M[r][k] -= f * M[c][k];
                }
            }
        }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
        let s = M[r][n];
        for (let k = r + 1; k < n; k++) {
            s -= M[r][k] * x[k];
        }
        x[r] = s / M[r][r];
    }
    return x;
}

/** Ridge logistic regression by Newton's method. rows: [{x: [[j, value]...], y}]; returns weights and standard errors. */
function fitLogistic(rows, dim, penalty) {
    const w = new Array(dim).fill(0);
    for (let it = 0; it < 60; it++) {
        const g = new Array(dim).fill(0);
        const H = Array.from({ length: dim }, () => new Array(dim).fill(0));
        for (const r of rows) {
            let z = 0;
            for (const [j, v] of r.x) {
                z += w[j] * v;
            }
            const p = 1 / (1 + Math.exp(-z));
            for (const [j, v] of r.x) {
                g[j] += (r.y - p) * v;
                for (const [k, u] of r.x) {
                    H[j][k] += p * (1 - p) * v * u;
                }
            }
        }
        for (let j = 0; j < dim; j++) {
            g[j] -= penalty[j] * w[j];
            H[j][j] += penalty[j];
        }
        const step = solve(H, g);
        step.forEach((d, j) => (w[j] += d));
        if (Math.max(...step.map(Math.abs)) < 1e-9) {
            const se = w.map((_, j) => Math.sqrt(solve(H, w.map((__, k) => (k === j ? 1 : 0)))[j]));
            return { w, se };
        }
    }
    throw new Error('the model did not converge');
}

/**
 * games: rows from readLadderGames; human: {leader: Map, base: Map} from humanStrength, or null for free effects.
 * Returns { index (name -> column), fit }.
 */
function fitModel(games, human) {
    const index = new Map();
    const kinds = [];
    const col = (kind, key) => {
        const k = `${kind}:${key}`;
        if (!index.has(k)) {
            index.set(k, index.size);
            kinds.push(kind);
        }
        return index.get(k);
    };
    col('first', 'first');
    const rows = games.map((g) => {
        const x = new Map();
        const add = (j, v) => x.set(j, (x.get(j) ?? 0) + v);
        add(col('bot', g.p1.bot), 1);
        add(col('bot', g.p2.bot), -1);
        if (g.first) {
            add(0, g.first === 'p1' ? 1 : -1);
        }
        for (const kind of ['leader', 'base']) {
            if (human) {
                const hv = (k) => human[kind].get(k)?.v ?? 0;
                add(col('kappa', kind), hv(g.p1[kind]) - hv(g.p2[kind]));
            } else {
                add(col(kind, g.p1[kind]), 1);
                add(col(kind, g.p2[kind]), -1);
            }
        }
        return { x: [...x].filter(([, v]) => v !== 0), y: g.winner === 'p1' ? 1 : 0 };
    });
    const penalty = kinds.map((k) => (k === 'leader' || k === 'base' ? SHRINK : LOOSE));
    return { index, fit: fitLogistic(rows, index.size, penalty) };
}

function weightedCorr(xs, ys, ws = xs.map(() => 1)) {
    const W = ws.reduce((a, b) => a + b, 0);
    const mx = xs.reduce((a, x, i) => a + ws[i] * x, 0) / W;
    const my = ys.reduce((a, y, i) => a + ws[i] * y, 0) / W;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    xs.forEach((x, i) => {
        sxy += ws[i] * (x - mx) * (ys[i] - my);
        sxx += ws[i] * (x - mx) ** 2;
        syy += ws[i] * (ys[i] - my) ** 2;
    });
    return sxy / Math.sqrt(sxx * syy);
}
const ranks = (a) => {
    const r = new Array(a.length);
    a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]).forEach(([, i], k) => (r[i] = k));
    return r;
};

/** Deterministic shuffle (the permutation test must give the same answer on every run). */
function shuffled(a, seed) {
    const out = [...a];
    let s = seed;
    const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let j = out.length - 1; j > 0; j--) {
        const k = Math.floor(rnd() * (j + 1));
        [out[j], out[k]] = [out[k], out[j]];
    }
    return out;
}

function compare(allGames, summary, { permute = 0 } = {}) {
    const games = allGames.filter((g) => !g.error && (g.winner === 'p1' || g.winner === 'p2') && g.p1.leader && g.p2.leader && g.p1.bot && g.p2.bot);
    const human = { leader: humanStrength(summary.leaders), base: humanStrength(summary.bases) };
    const free = fitModel(games, null);
    const tied = fitModel(games, human);
    const at = (m, key) => ({ est: m.fit.w[m.index.get(key)], se: m.fit.se[m.index.get(key)] });

    const effects = (kind) => [...free.index].filter(([k]) => k.startsWith(`${kind}:`)).map(([k, j]) => {
        const id = k.slice(kind.length + 1);
        const seats = games.flatMap((g) => ['p1', 'p2'].filter((s) => g[s][kind] === id).map((s) => g.winner === s));
        const h = human[kind].get(id);
        return { id, name: h?.name ?? null, bot: free.fit.w[j], botSe: free.fit.se[j], games: seats.length, botWins: seats.filter(Boolean).length, human: h?.v ?? null, humanWinRate: h?.winRate ?? null, humanPlays: h?.plays ?? 0 };
    });
    const agreement = (list) => {
        const both = list.filter((e) => e.human !== null && e.games >= 10);
        return { n: both.length, spearman: weightedCorr(ranks(both.map((e) => e.human)), ranks(both.map((e) => e.bot))), pearsonWeighted: weightedCorr(both.map((e) => e.human), both.map((e) => e.bot), both.map((e) => 1 / e.botSe ** 2)) };
    };

    const kappa = { leader: at(tied, 'kappa:leader'), base: at(tied, 'kappa:base') };
    if (permute > 0) {
        const keys = [...human.leader.keys()];
        const vals = keys.map((k) => human.leader.get(k).v);
        let atLeast = 0;
        for (let i = 0; i < permute; i++) {
            const sh = shuffled(vals, 12345 + i);
            const leader = new Map(keys.map((k, j) => [k, { ...human.leader.get(k), v: sh[j] }]));
            const m = fitModel(games, { leader, base: human.base });
            if (m.fit.w[m.index.get('kappa:leader')] >= kappa.leader.est) {
                atLeast++;
            }
        }
        kappa.leader.permutationP = (atLeast + 1) / (permute + 1);
        kappa.leader.permutations = permute;
    }
    const withFirst = games.filter((g) => g.first);
    const leaders = effects('leader');
    const bases = effects('base');
    return {
        credit: summary.credit ?? CREDIT, humanSource: summary.source, humanFetchedAt: summary.fetchedAt,
        games: { decided: games.length, runs: new Set(games.map((g) => g.run)).size, bots: new Set(games.flatMap((g) => [g.p1.bot, g.p2.bot])).size },
        firstPlayer: { botsRaw: withFirst.filter((g) => g.winner === g.first).length / withFirst.length, botsModel: at(free, 'first:first'), humans: summary.totals.firstPlayerWinRate },
        kappa,
        leaders: { agreement: agreement(leaders), list: leaders },
        bases: { agreement: agreement(bases), list: bases }
    };
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.human || !args.results) {
        console.error('usage: node analysis/swustats/compare.js --human <dir with human-summary.json> --results <results dir> [--out file] [--permute N]');
        process.exit(2);
    }
    const summary = JSON.parse(fs.readFileSync(path.join(args.human, 'human-summary.json'), 'utf8'));
    const r = compare(readLadderGames(args.results), summary, { permute: args.permute });
    const out = args.out ?? path.join(args.human, 'compare.json');
    fs.writeFileSync(out, JSON.stringify(r, null, 1));
    console.log(JSON.stringify({ games: r.games, firstPlayer: r.firstPlayer, kappa: r.kappa, leaders: r.leaders.agreement, bases: r.bases.agreement }, null, 1));
    console.log(`wrote ${out}. Credit: ${r.credit}`);
}

if (require.main === module) {
    main();
}

module.exports = { compare, fitModel, fitLogistic, humanStrength, readLadderGames, weightedCorr };
