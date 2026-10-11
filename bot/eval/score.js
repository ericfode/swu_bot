'use strict';
/**
 * Score evaluators by how well they predict the winner on held-out games.
 *
 *   node bot/eval/score.js --data <dir>[,<dir>...] [--evals base,material,...] [--json out.json]
 *                          [--llm analysis.claude.json --replay game.jsonl]
 *
 * Views (all reported as P(judge wins), scored against the result):
 *   subjective  each player judges with its own hand visible and the opponent's hand as a count
 *   objective   both hands visible
 * Metrics: Brier (mean squared error of P, 0.25 = coin flip), log loss, accuracy of the favourite.
 * Split by data source (one per dataset dir) and by round. --llm also scores the evaluators on the checkpoints of
 * an analysis/analyze.js file and puts the LLM's own views beside them on the same positions.
 */
const fs = require('fs');
const path = require('path');
const { loadPositions, readJsonl } = require('./data');
const { loadEvaluator, EVALUATORS } = require('./evaluators');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

const ROUND_BUCKETS = [[1, 3], [4, 6], [7, 9], [10, 99]];
const bucketOf = (r) => ROUND_BUCKETS.find(([a, b]) => r >= a && r <= b) ?? ROUND_BUCKETS[0];

class Acc {
    constructor() {
        this.n = 0;
        this.brier = 0;
        this.ll = 0;
        this.hit = 0;
    }

    add(p, y) {
        const q = Math.min(1 - 1e-6, Math.max(1e-6, p));
        this.n++;
        this.brier += (p - y) ** 2;
        this.ll += -(y * Math.log(q) + (1 - y) * Math.log(1 - q));
        this.hit += (p > 0.5 ? 1 : p < 0.5 ? 0 : 0.5) === y ? 1 : p === 0.5 ? 0.5 : 0;
    }

    out() {
        return this.n ? { n: this.n, brier: +(this.brier / this.n).toFixed(4), logloss: +(this.ll / this.n).toFixed(4), acc: +(this.hit / this.n).toFixed(4) } : null;
    }
}

function scorePositions(ev, positions) {
    const res = { subjective: {}, objective: {} };
    const get = (view, key) => (res[view][key] ??= new Acc());
    const cal = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
    for (const pos of positions) {
        const b = bucketOf(pos.round);
        const rk = `R${b[0]}-${b[1] === 99 ? '' : b[1]}`;
        for (const judge of ['p1', 'p2']) {
            if (pos.hidden?.includes(judge)) {
                continue;
            }
            const p = ev.predict(pos.state, judge, { view: 'subjective', decks: pos.decks, toAct: pos.toAct });
            const y = pos.winner === judge ? 1 : 0;
            for (const key of ['all', `src:${pos.source}`, `round:${rk}`]) {
                get('subjective', key).add(p, y);
            }
            const c = cal[Math.min(9, Math.floor(p * 10))];
            c.n++;
            c.p += p;
            c.y += y;
        }
        if (pos.hidden?.length) {
            continue;
        }
        const p = ev.predict(pos.state, 'p1', { view: 'objective', decks: pos.decks, toAct: pos.toAct });
        const y = pos.winner === 'p1' ? 1 : 0;
        for (const key of ['all', `src:${pos.source}`, `round:${rk}`]) {
            get('objective', key).add(p, y);
        }
    }
    const flat = (view) => Object.fromEntries(Object.entries(res[view]).map(([k, a]) => [k, a.out()]));
    return {
        subjective: flat('subjective'),
        objective: flat('objective'),
        calibration: cal.filter((c) => c.n).map((c) => ({ n: c.n, p: +(c.p / c.n).toFixed(3), y: +(c.y / c.n).toFixed(3) }))
    };
}

/** Same checkpoints as an analysis/analyze.js file: our evaluators beside the LLM's views. */
function scoreLlm(evs, analysisFile, replayFile) {
    const a = JSON.parse(fs.readFileSync(analysisFile, 'utf8'));
    const steps = readJsonl(replayFile).filter((e) => e.t === 'step');
    const byN = new Map(steps.map((s, i) => [s.n, { state: s.state, next: steps[i + 1]?.pid ?? null }]));
    const y = a.game.winner === 'p1' ? 1 : 0;
    // decklists: regenerate from the seed exactly as bot/match.js draws them
    let decks = null;
    if (evs.some((e) => e.decks)) {
        const { Env, seededRng } = require('../env');
        const env = new Env();
        const rng = seededRng('bot' + a.game.seed);
        const flat = (d) => d.deck.flatMap((c) => Array(c.count).fill(c.id));
        decks = { p1: flat(env.randomDeck(rng)), p2: flat(env.randomDeck(rng)) };
    }
    const rows = {};
    const add = (name, view, p) => ((rows[name] ??= {})[view] ??= new Acc()).add(p, y);
    for (const cp of a.checkpoints) {
        const s = byN.get(cp.step);
        if (!s) {
            continue;
        }
        for (const [view, key] of [['subjective_p1', 'subjective_p1'], ['subjective_p2', 'subjective_p2'], ['objective', 'objective'], ['omniscient', 'omniscient']]) {
            const v = cp.views?.[key]?.p1;
            if (v != null) {
                add('llm', view, v);
            }
        }
        for (const ev of evs) {
            const o = { decks, toAct: s.next };
            add(ev.name, 'subjective_p1', ev.predict(s.state, 'p1', { ...o, view: 'subjective' }));
            add(ev.name, 'subjective_p2', 1 - ev.predict(s.state, 'p2', { ...o, view: 'subjective' }));
            add(ev.name, 'objective', ev.predict(s.state, 'p1', { ...o, view: 'objective' }));
        }
    }
    const omni = a.omniscient?.evals;
    if (omni) {
        for (const e of omni) {
            add('llm', 'omniscient', e.p1);
        }
    }
    return {
        game: a.game.id, checkpoints: a.checkpoints.length, winner: a.game.winner,
        rows: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([vk, acc]) => [vk, acc.out()]))]))
    };
}

function main() {
    const dirs = arg('data', '').split(',').filter(Boolean);
    const names = arg('evals', EVALUATORS.join(',')).split(',');
    const evs = names.map((n) => loadEvaluator(n));
    const report = { createdAt: new Date().toISOString(), data: dirs.map((d) => path.basename(d)), evaluators: {} };
    if (dirs.length) {
        const test = loadPositions(dirs).filter((p) => p.test);
        report.testPositions = test.length;
        report.testGames = new Set(test.map((p) => p.id)).size;
        console.log(`test split: ${report.testPositions} positions from ${report.testGames} games`);
        const coin = new Acc();
        test.forEach(() => {
            coin.add(0.5, 1);
        });
        for (const ev of evs) {
            const r = scorePositions(ev, test);
            report.evaluators[ev.name] = { kind: ev.kind, decks: ev.decks, ...r };
            const s = r.subjective,
                o = r.objective;
            const src = Object.keys(s).filter((k) => k.startsWith('src:')).map((k) => `${k.slice(4)} ${s[k].brier.toFixed(3)}`).join('  ');
            console.log(`${ev.name.padEnd(16)} subjective brier ${s.all.brier.toFixed(4)} ll ${s.all.logloss.toFixed(4)} acc ${s.all.acc.toFixed(3)} | objective ${o.all.brier.toFixed(4)} | ${src}`);
        }
    }
    if (arg('llm', null)) {
        report.llm = scoreLlm(evs, arg('llm'), arg('replay'));
        console.log(`\nLLM game ${report.llm.game} (${report.llm.checkpoints} checkpoints, winner ${report.llm.winner}): brier by view`);
        for (const [name, v] of Object.entries(report.llm.rows)) {
            console.log(`${name.padEnd(16)} ${Object.entries(v).map(([k, x]) => `${k} ${x.brier.toFixed(3)}`).join('  ')}`);
        }
    }
    if (arg('json', null)) {
        fs.writeFileSync(arg('json'), JSON.stringify(report, null, 1));
    }
}

main();
