'use strict';

/**
 * Candidate position evaluators. Each one maps a position, seen by one player, to P(that player wins).
 *
 *   const ev = loadEvaluator('linear');
 *   ev.predict(state, 'p1', { view: 'subjective', decks, toAct })   // 0..1
 *
 * Kinds:
 *   base            remaining base HP difference only (the floor any evaluator should beat)
 *   material        the weights of bot/players/heuristic.js (as shipped, including its low-base term)
 *   material-fixed  same, but a low base counts against you (the shipped term adds value as your base drops)
 *   race            damage race: rounds each side needs to kill the other's base, compared as a log ratio
 *   linear          logistic regression on feature differences, fitted on game outcomes (fit.js)
 *   mlp             tiny antisymmetric neural net, logit = g(me, opp) - g(opp, me), fitted on game outcomes
 * Hand-made kinds have one fitted number, the logistic scale, so their P(win) is calibrated like the others.
 * Fitted model files live in bot/eval/models/<name>.json; `decks: true` in a model file means it was fitted
 * with known decklists, and it should be given `decks` when predicting.
 */

const fs = require('fs');
const path = require('path');
const { frameFeatures, vector, terminal, SIDE_KEYS } = require('./features');

const MODELS = path.join(__dirname, 'models');
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

// ---------- hand-made value functions (return a raw score for the judge; scale turns it into a logit) ----------

function materialSide(f, fixedBase) {
    const hp = f.baseHp;
    const low = hp <= 12 ? ((12 - hp) ** 2) / 6 : 0;
    const base = (hp * 0.9 + (fixedBase ? -low : low)) * 1.5;
    const exhausted = 0.15 * (1.3 * (f.power - f.readyPower));
    const units = 1.3 * f.power + 0.9 * f.hp + 0.25 * f.boardCost + 2.2 * f.shields + 0.6 * f.upgrades + 1.0 * f.sentinel - exhausted;
    return base + units + 1.8 * f.hand + 1.4 * f.resources + 2.5 * f.initiative;
}

function raceRate(a, b) {
    // damage per round a side can push at the other base: board power, a ready leader, and cards it can still cast,
    // minus a share of the enemy board that will trade with it instead
    const rate = a.power + 2 * a.leaderReady + 1.2 * a.handPlayable;
    return Math.max(0.5, rate - 0.3 * b.power - 0.5 * b.sentinel);
}

function raceScore(fr) {
    const tMe = Math.max(0.2, fr.opp.baseHp / raceRate(fr.me, fr.opp));
    const tOpp = Math.max(0.2, fr.me.baseHp / raceRate(fr.opp, fr.me));
    return Math.log(tOpp / tMe) + 0.15 * (fr.me.initiative - fr.opp.initiative) + 0.1 * fr.g.toAct;
}

const HAND = {
    // simplest baseline: remaining base HP difference
    base: (fr) => fr.me.baseHp - fr.opp.baseHp,
    material: (fr) => materialSide(fr.me, false) - materialSide(fr.opp, false),
    'material-fixed': (fr) => materialSide(fr.me, true) - materialSide(fr.opp, true),
    race: raceScore
};

// ---------- fitted models ----------

/** Antisymmetric input pair for one frame: (me, opp, globals) and the swapped (opp, me, -globals). */
function sidesVector(fr) {
    const me = SIDE_KEYS.map((k) => fr.me[k]);
    const opp = SIDE_KEYS.map((k) => fr.opp[k]);
    return { me, opp, round: fr.g.round, toAct: fr.g.toAct };
}

function linearLogit(m, fr) {
    const x = vector(fr);
    const n = SIDE_KEYS.length;
    let z = 0;
    for (let i = 0; i < n; i++) {
        z += m.w[i] * (x[i] - x[n + i]) / m.std[i];
    }
    return z + m.wToAct * fr.g.toAct;
}

/** g(a, b, round, toAct): one tanh hidden layer. */
function mlpG(m, a, b, round, toAct) {
    const n = a.length;
    const x = new Array(2 * n + 2);
    for (let i = 0; i < n; i++) {
        x[i] = a[i] / m.std[i];
        x[n + i] = b[i] / m.std[i];
    }
    x[2 * n] = round / 10;
    x[2 * n + 1] = toAct;
    let out = m.b2;
    for (let h = 0; h < m.hidden; h++) {
        let s = m.b1[h];
        const row = m.W1[h];
        for (let i = 0; i < x.length; i++) {
            s += row[i] * x[i];
        }
        out += m.W2[h] * Math.tanh(s);
    }
    return out;
}

function mlpLogit(m, fr) {
    const v = sidesVector(fr);
    return mlpG(m, v.me, v.opp, v.round, v.toAct) - mlpG(m, v.opp, v.me, v.round, -v.toAct);
}

// ---------- loading ----------

function readModel(name) {
    const file = path.join(MODELS, `${name}.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

/**
 * name: material | material-fixed | race | linear | linear-deck | mlp | mlp-deck | any model file name.
 * Returns { name, kind, decks, logit(fr), predict(state, judge, opts), frame(state, judge, opts) }.
 */
function loadEvaluator(name, model = readModel(name)) {
    let kind, logit;
    if (HAND[name] || HAND[model?.base]) {
        const raw = HAND[name] ?? HAND[model.base];
        const scale = model?.scale ?? 0.1;
        kind = 'hand';
        logit = (fr) => scale * raw(fr);
    } else if (model?.kind === 'linear') {
        kind = 'linear';
        logit = (fr) => linearLogit(model, fr);
    } else if (model?.kind === 'mlp') {
        kind = 'mlp';
        logit = (fr) => mlpLogit(model, fr);
    } else {
        throw new Error(`unknown evaluator ${name} (no model file in ${MODELS})`);
    }
    const decks = !!model?.decks;
    const ev = {
        name,
        kind,
        decks,
        model,
        logit,
        frame: (state, judge, opts = {}) => frameFeatures(state, judge, { ...opts, decks: decks ? opts.decks : null }),
        /** P(judge wins). Decided positions return 0/1 straight from the snapshot. */
        predict(state, judge, opts = {}) {
            const t = terminal(state, judge);
            if (t !== null) {
                return t;
            }
            return sigmoid(logit(ev.frame(state, judge, opts)));
        }
    };
    return ev;
}

const EVALUATORS = ['base', 'material', 'material-fixed', 'race', 'linear', 'linear-deck', 'mlp', 'mlp-deck'];

module.exports = { loadEvaluator, HAND, EVALUATORS, linearLogit, mlpLogit, mlpG, sidesVector, sigmoid, MODELS };
