'use strict';
/**
 * Fit every candidate evaluator on recorded positions and write bot/eval/models/<name>.json.
 *
 *   node bot/eval/fit.js --data <dir>[,<dir>...] [--out bot/eval/models] [--only linear,mlp] [--hidden 8] [--l2 1e-3] [--epochs 30]
 *                        [--drop deckLow,...] [--suffix -g4]
 *
 * Training rows: the train split (by game) of every decided checkpoint, seen subjectively by each player in turn,
 * labelled with whether that player won. Hand-made evaluators get only their logistic scale fitted.
 */
const fs = require('fs');
const path = require('path');
const { loadPositions } = require('./data');
const { frameFeatures, SIDE_KEYS } = require('./features');
const { HAND, MODELS, linearLogit, mlpLogit, sigmoid } = require('./evaluators');
const { seededRng } = require('../env');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

const logloss = (p, y) => -(y * Math.log(Math.max(p, 1e-9)) + (1 - y) * Math.log(Math.max(1 - p, 1e-9)));

/** Two subjective frames (one per judge) per position. */
function frames(positions, withDecks) {
    const rows = [];
    for (const p of positions) {
        for (const judge of ['p1', 'p2']) {
            if (p.hidden?.includes(judge)) {
                continue;
            }
            const fr = frameFeatures(p.state, judge, { view: 'subjective', decks: withDecks ? p.decks : null, toAct: p.toAct });
            rows.push({ fr, y: p.winner === judge ? 1 : 0, id: p.id, source: p.source });
        }
    }
    return rows;
}

function stds(rows) {
    return SIDE_KEYS.map((k) => {
        let s = 0,
            s2 = 0,
            n = 0;
        for (const r of rows) {
            for (const v of [r.fr.me[k], r.fr.opp[k]]) {
                s += v;
                s2 += v * v;
                n++;
            }
        }
        const m = s / n;
        return Math.max(1e-3, Math.sqrt(Math.max(0, s2 / n - m * m)));
    });
}

function meanLoss(rows, logit) {
    let l = 0,
        b = 0;
    for (const r of rows) {
        const p = sigmoid(logit(r.fr));
        l += logloss(p, r.y);
        b += (p - r.y) ** 2;
    }
    return { logloss: l / rows.length, brier: b / rows.length };
}

/** 1-D logistic fit of the scale on a raw score (Newton on the log loss). */
function fitScale(rows, raw) {
    const xs = rows.map((r) => raw(r.fr));
    let s = 0.1;
    for (let it = 0; it < 50; it++) {
        let g = 0,
            h = 0;
        xs.forEach((x, i) => {
            const p = sigmoid(s * x);
            g += (p - rows[i].y) * x;
            h += p * (1 - p) * x * x;
        });
        const step = g / (h + 1e-9);
        s -= step;
        if (Math.abs(step) < 1e-7) {
            break;
        }
    }
    return s;
}

/** Adam over a flat parameter list. */
function adam(params, lr) {
    const m = params.map(() => 0),
        v = params.map(() => 0);
    let t = 0;
    return (grad) => {
        t++;
        for (let i = 0; i < params.length; i++) {
            m[i] = 0.9 * m[i] + 0.1 * grad[i];
            v[i] = 0.999 * v[i] + 0.001 * grad[i] * grad[i];
            params[i] -= (lr * (m[i] / (1 - 0.9 ** t))) / (Math.sqrt(v[i] / (1 - 0.999 ** t)) + 1e-8);
        }
    };
}

/** drop: feature names to leave out (their weight stays 0), for ablations. */
function fitLinear(rows, std, { l2 = 1e-4, iters = 600, drop = [] } = {}) {
    const n = SIDE_KEYS.length;
    const keep = SIDE_KEYS.map((k) => (drop.includes(k) ? 0 : 1));
    const X = rows.map((r) => [...SIDE_KEYS.map((k, i) => (keep[i] * (r.fr.me[k] - r.fr.opp[k])) / std[i]), drop.includes('toAct') ? 0 : r.fr.g.toAct]);
    const w = new Array(n + 1).fill(0);
    const step = adam(w, 0.05);
    for (let it = 0; it < iters; it++) {
        const g = new Array(n + 1).fill(0);
        for (let j = 0; j < X.length; j++) {
            const x = X[j];
            let z = 0;
            for (let i = 0; i <= n; i++) {
                z += w[i] * x[i];
            }
            const d = sigmoid(z) - rows[j].y;
            for (let i = 0; i <= n; i++) {
                g[i] += d * x[i];
            }
        }
        for (let i = 0; i <= n; i++) {
            g[i] = g[i] / X.length + l2 * w[i];
        }
        step(g);
    }
    return { kind: 'linear', std, w: w.slice(0, n), wToAct: w[n], names: SIDE_KEYS };
}

/**
 * Antisymmetric one-hidden-layer net, logit = g(me, opp) - g(opp, me), trained with Adam on the log loss.
 * drop: feature names the net never sees (inputs zeroed in training, their weights zeroed after).
 */
function fitMlp(rows, val, std, { hidden = 16, epochs = 30, lr = 0.003, batch = 256, l2 = 1e-4, seed = 'mlp', drop = [] } = {}) {
    const n = SIDE_KEYS.length;
    const inp = 2 * n + 2;
    const rng = seededRng(seed);
    const gauss = () => Math.sqrt(-2 * Math.log(rng() + 1e-12)) * Math.cos(2 * Math.PI * rng());
    const m = {
        kind: 'mlp', hidden, std, names: SIDE_KEYS,
        W1: Array.from({ length: hidden }, () => Array.from({ length: inp }, () => gauss() / Math.sqrt(inp))),
        b1: Array.from({ length: hidden }, () => 0.1 * gauss()),
        W2: Array.from({ length: hidden }, () => gauss() / Math.sqrt(hidden)),
        b2: 0
    };
    const keep = SIDE_KEYS.map((k) => (drop.includes(k) ? 0 : 1));
    const enc = (a, b, round, toAct) => {
        const x = new Float64Array(inp);
        for (let i = 0; i < n; i++) {
            x[i] = (keep[i] * a[i]) / std[i];
            x[n + i] = (keep[i] * b[i]) / std[i];
        }
        x[2 * n] = round / 10;
        x[2 * n + 1] = toAct;
        return x;
    };
    const data = rows.map((r) => {
        const me = SIDE_KEYS.map((k) => r.fr.me[k]);
        const opp = SIDE_KEYS.map((k) => r.fr.opp[k]);
        return { x: enc(me, opp, r.fr.g.round, r.fr.g.toAct), xs: enc(opp, me, r.fr.g.round, -r.fr.g.toAct), y: r.y };
    });
    // flat parameter view for Adam: W1 rows, b1, W2
    const flat = [...m.W1.flat(), ...m.b1, ...m.W2];
    const step = adam(flat, lr);
    const unflat = () => {
        let k = 0;
        for (let h = 0; h < hidden; h++) {
            for (let i = 0; i < inp; i++) {
                m.W1[h][i] = flat[k++];
            }
        }
        for (let h = 0; h < hidden; h++) {
            m.b1[h] = flat[k++];
        }
        for (let h = 0; h < hidden; h++) {
            m.W2[h] = flat[k++];
        }
    };
    const order = data.map((_, i) => i);
    let best = { loss: Infinity, flat: flat.slice(), epoch: 0 };
    const t = new Float64Array(hidden),
        ts = new Float64Array(hidden);
    for (let ep = 0; ep < epochs; ep++) {
        for (let i = order.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [order[i], order[j]] = [order[j], order[i]];
        }
        for (let s0 = 0; s0 < order.length; s0 += batch) {
            const grad = new Float64Array(flat.length);
            const end = Math.min(order.length, s0 + batch);
            for (let q = s0; q < end; q++) {
                const d = data[order[q]];
                let z = 0;
                for (let h = 0; h < hidden; h++) {
                    let a = m.b1[h],
                        as = m.b1[h];
                    const row = m.W1[h];
                    for (let i = 0; i < inp; i++) {
                        a += row[i] * d.x[i];
                        as += row[i] * d.xs[i];
                    }
                    t[h] = Math.tanh(a);
                    ts[h] = Math.tanh(as);
                    z += m.W2[h] * (t[h] - ts[h]);
                }
                const e = sigmoid(z) - d.y;
                const w2off = hidden * inp + hidden;
                for (let h = 0; h < hidden; h++) {
                    grad[w2off + h] += e * (t[h] - ts[h]);
                    const ga = e * m.W2[h] * (1 - t[h] * t[h]);
                    const gs = e * m.W2[h] * (1 - ts[h] * ts[h]);
                    grad[hidden * inp + h] += ga - gs;
                    const off = h * inp;
                    for (let i = 0; i < inp; i++) {
                        grad[off + i] += ga * d.x[i] - gs * d.xs[i];
                    }
                }
            }
            const k = end - s0;
            for (let i = 0; i < grad.length; i++) {
                grad[i] = grad[i] / k + l2 * flat[i];
            }
            step(grad);
            unflat();
        }
        const vl = meanLoss(val, (fr) => mlpLogit(m, fr)).logloss;
        if (vl < best.loss) {
            best = { loss: vl, flat: flat.slice(), epoch: ep };
        }
        console.log(`  mlp epoch ${ep}: val logloss ${vl.toFixed(4)}`);
        if (ep - best.epoch >= 4) {
            break;
        }
    }
    best.flat.forEach((x, i) => {
        flat[i] = x;
    });
    unflat();
    for (const row of m.W1) {
        keep.forEach((k, i) => {
            if (!k) {
                row[i] = 0;
                row[n + i] = 0;
            }
        });
    }
    m.epochs = best.epoch + 1;
    return m;
}

function main() {
    const dirs = arg('data', '').split(',').filter(Boolean);
    const out = path.resolve(arg('out', MODELS));
    const only = arg('only', null)?.split(',');
    // features the fitted models leave out (weight 0), and a suffix for the model file names
    const drop = arg('drop', '').split(',').filter(Boolean);
    const unknown = drop.filter((k) => !SIDE_KEYS.includes(k));
    if (unknown.length) {
        console.error(`unknown feature(s) in --drop: ${unknown.join(', ')}`);
        process.exit(2);
    }
    const tag = arg('suffix', '');
    const want = (n) => !only || only.includes(n);
    fs.mkdirSync(out, { recursive: true });
    const positions = loadPositions(dirs);
    const train = positions.filter((p) => !p.test);
    console.log(`${positions.length} positions from ${new Set(positions.map((p) => p.id)).size} games; ${train.length} for training`);
    const meta = { ...(drop.length ? { dropped: drop } : {}), trainedOn: dirs.map((d) => path.basename(d)), trainPositions: train.length, trainGames: new Set(train.map((p) => p.id)).size, fittedAt: new Date().toISOString() };
    const save = (name, model, rows) => {
        const fit = meanLoss(rows, (fr) => (model.kind === 'hand' ? model.scale * HAND[model.base](fr) : model.kind === 'linear' ? linearLogit(model, fr) : mlpLogit(model, fr)));
        Object.assign(model, meta, { trainLogloss: Number(fit.logloss.toFixed(4)), trainBrier: Number(fit.brier.toFixed(4)) });
        fs.writeFileSync(path.join(out, `${name}${tag}.json`), JSON.stringify(model, null, 1));
        console.log(`${name}${tag}: train brier ${fit.brier.toFixed(4)} logloss ${fit.logloss.toFixed(4)}`);
    };

    for (const withDecks of [false, true]) {
        const rows = frames(train, withDecks);
        if (!rows.length) {
            console.error('no training rows: every position is in the test split or has both hands hidden');
            process.exit(2);
        }
        const suffix = withDecks ? '-deck' : '';
        if (!withDecks) {
            for (const name of Object.keys(HAND)) {
                if (want(name)) {
                    save(name, { kind: 'hand', base: name, scale: fitScale(rows, HAND[name]) }, rows);
                }
            }
        }
        const std = stds(rows);
        if (want(`linear${suffix}`)) {
            save(`linear${suffix}`, { ...fitLinear(rows, std, { drop }), decks: withDecks }, rows);
        }
        if (want(`mlp${suffix}`)) {
            // hold out 10% of training games for early stopping
            const valIds = new Set([...new Set(rows.map((r) => r.id))].filter((id, i) => i % 10 === 0));
            const tr = rows.filter((r) => !valIds.has(r.id));
            const va = rows.filter((r) => valIds.has(r.id));
            const model = fitMlp(tr, va, std, { hidden: Number(arg('hidden', 8)), epochs: Number(arg('epochs', 30)), l2: Number(arg('l2', 1e-3)), drop });
            save(`mlp${suffix}`, { ...model, decks: withDecks }, rows);
        }
    }
}

if (require.main === module) {
    main();
}

module.exports = { frames, stds, fitLinear, fitMlp, fitScale, meanLoss };
