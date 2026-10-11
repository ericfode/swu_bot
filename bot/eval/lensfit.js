#!/usr/bin/env node
'use strict';
/**
 * Held-out fit of a lens file's score -> P(p1 wins) map, scored next to the bench evaluators on the same positions.
 *
 *   node bot/eval/lensfit.js --lens /mnt/project-files/dashboard/lens --replays /mnt/project-files/results \
 *       [--field edge] [--k 0.08] [--json out.json]
 *
 * Reads <lens>/<gameId>.json (swu-lens/1, steps[].<field> = score from p1's side) and finds the replay
 * <replays>/<tid>/games/<gameId>.jsonl with the same seed. Splits by game id hash into 5 folds (fold 0 = the bench's
 * 20% test split), so no game is in both train and test. Reports Brier / log loss of: the hand curve
 * 1/(1+exp(-k*score)), a fitted scale, a fitted scale + bias, and every bench evaluator on the same steps.
 */
const fs = require('fs');
const path = require('path');
const { readJsonl } = require('./data');
const { loadEvaluator, EVALUATORS } = require('./evaluators');
const { terminal } = require('./features');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const clip = (p) => Math.min(1 - 1e-6, Math.max(1e-6, p));

function fold(id, k = 5) {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) {
        h = Math.imul(h ^ id.charCodeAt(i), 16777619);
    }
    return Math.floor((((h >>> 0) % 1000) / 1000) * k);
}

/** Newton on the log loss of sigmoid(a*x + b); bias optional. */
function fitLogistic(xs, ys, bias) {
    let a = 0.05,
        b = 0;
    for (let it = 0; it < 100; it++) {
        let ga = 0,
            gb = 0,
            haa = 1e-9,
            hab = 0,
            hbb = 1e-9;
        xs.forEach((x, i) => {
            const p = sigmoid(a * x + b);
            const w = p * (1 - p);
            ga += (p - ys[i]) * x;
            gb += p - ys[i];
            haa += w * x * x;
            hab += w * x;
            hbb += w;
        });
        let da, db;
        if (bias) {
            const det = haa * hbb - hab * hab;
            da = (hbb * ga - hab * gb) / det;
            db = (haa * gb - hab * ga) / det;
        } else {
            da = ga / haa;
            db = 0;
        }
        a -= da;
        b -= db;
        if (Math.abs(da) + Math.abs(db) < 1e-9) {
            break;
        }
    }
    return { a, b };
}

function score(ps, ys) {
    let br = 0,
        ll = 0;
    ps.forEach((p, i) => {
        br += (p - ys[i]) ** 2;
        ll -= ys[i] ? Math.log(clip(p)) : Math.log(clip(1 - p));
    });
    return { brier: +(br / ps.length).toFixed(4), logloss: +(ll / ps.length).toFixed(4) };
}

function indexReplays(root) {
    const out = new Map();
    for (const t of fs.readdirSync(root)) {
        const g = path.join(root, t, 'games');
        if (!fs.existsSync(g)) {
            continue;
        }
        for (const f of fs.readdirSync(g)) {
            if (f.endsWith('.jsonl')) {
                const id = f.slice(0, -6);
                out.set(id, [...(out.get(id) ?? []), path.join(g, f)]);
            }
        }
    }
    return out;
}

function firstLine(file) {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return JSON.parse(buf.slice(0, n).toString().split('\n')[0]);
}

function main() {
    const lensDir = arg('lens', '/mnt/project-files/dashboard/lens');
    const field = arg('field', 'edge');
    const k = Number(arg('k', '0.08'));
    const replays = indexReplays(arg('replays', '/mnt/project-files/results'));
    const evs = EVALUATORS.map((n) => loadEvaluator(n));
    const rows = [];
    let skipped = 0;
    for (const f of fs.readdirSync(lensDir).filter((f) => f.endsWith('.json'))) {
        const lens = JSON.parse(fs.readFileSync(path.join(lensDir, f), 'utf8'));
        if (!lens.steps || !lens.gameId) {
            continue;
        }
        const file = (replays.get(lens.gameId) ?? []).find((r) => firstLine(r).seed === lens.seed);
        if (!file) {
            skipped++;
            continue;
        }
        const lines = readJsonl(file);
        const end = lines.find((l) => l.t === 'end');
        if (!end || end.outcome !== 'won') {
            skipped++;
            continue;
        }
        const states = new Map(lines.filter((l) => l.t === 'step').map((l) => [l.n, l.state]));
        for (const s of lens.steps) {
            const st = states.get(s.n);
            // decided boards (a base at 0) are left out: the bench evaluators read them as 0/1 for free
            if (typeof s[field] !== 'number' || !st || terminal(st, 'p1') !== null) {
                continue;
            }
            rows.push({ id: lens.gameId, fold: fold(lens.gameId), x: s[field], y: end.winner === 'p1' ? 1 : 0, state: st, round: st.round });
        }
    }
    const games = new Set(rows.map((r) => r.id)).size;
    console.log(`${rows.length} positions from ${games} games (${skipped} lens files skipped)`);

    // pooled out-of-fold predictions: each fold is predicted by a fit on the other four
    const methods = { hand: [], scale: [], 'scale+bias': [] };
    const fits = [];
    for (let fo = 0; fo < 5; fo++) {
        const tr = rows.filter((r) => r.fold !== fo);
        const te = rows.filter((r) => r.fold === fo);
        if (!te.length) {
            continue;
        }
        const s1 = fitLogistic(tr.map((r) => r.x), tr.map((r) => r.y), false);
        const s2 = fitLogistic(tr.map((r) => r.x), tr.map((r) => r.y), true);
        fits.push({ fold: fo, scale: +s1.a.toFixed(4), scaleBias: [+s2.a.toFixed(4), +s2.b.toFixed(3)] });
        for (const r of te) {
            methods.hand.push([sigmoid(k * r.x), r.y, r.fold]);
            methods.scale.push([sigmoid(s1.a * r.x), r.y, r.fold]);
            methods['scale+bias'].push([sigmoid(s2.a * r.x + s2.b), r.y, r.fold]);
        }
    }
    for (const ev of evs) {
        for (const view of ['subjective', 'objective']) {
            methods[`${ev.name} (${view})`] = rows.map((r) => [ev.predict(r.state, 'p1', { view }), r.y, r.fold]);
        }
    }
    const report = (sel) => Object.fromEntries(Object.entries(methods).map(([m, v]) => {
        const s = v.filter(sel);
        return [m, score(s.map((q) => q[0]), s.map((q) => q[1]))];
    }));
    const all = report(() => true);
    const fold0 = report((q) => q[2] === 0);
    const full = { scale: fitLogistic(rows.map((r) => r.x), rows.map((r) => r.y), false), bias: fitLogistic(rows.map((r) => r.x), rows.map((r) => r.y), true) };
    const out = { lensDir, field, handK: k, positions: rows.length, games, folds: fits, fullData: { scale: full.scale.a, scaleBias: [full.bias.a, full.bias.b] }, outOfFold: all, benchTestFold: fold0 };
    const w = Math.max(...Object.keys(all).map((m) => m.length));
    console.log(`${'method'.padEnd(w)}  5-fold Brier  logloss   fold-0 Brier`);
    for (const m of Object.keys(all).sort((a, b) => all[a].brier - all[b].brier)) {
        console.log(`${m.padEnd(w)}  ${all[m].brier.toFixed(4)}        ${all[m].logloss.toFixed(4)}    ${fold0[m].brier.toFixed(4)}`);
    }
    console.log('fits per fold', JSON.stringify(fits), 'all data', JSON.stringify(out.fullData));
    if (arg('json', null)) {
        fs.writeFileSync(arg('json'), JSON.stringify(out, null, 1));
    }
}

if (require.main === module) {
    main();
}
module.exports = { fitLogistic, fold };
