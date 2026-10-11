'use strict';
/**
 * Training data generator. Plays games and records, for every decision: state / prompt / action features,
 * the action played, the teacher's choice (when asked), the next state, and finally the game result.
 *
 *   node bot/learned/gen.js --out data/learned/run1/w0 --games 50 --seed 1000 [--teacher 0.35] [--follow 0.85] [--student models/learned/current.json] [--temp 1]
 *
 * Teacher = the heuristic bot (bot/players/heuristic.js). Its one-ply engine search is slow (1-3 s), so only a
 * fraction (--teacher) of action windows get a search label; every other prompt gets its cheap rule-based label.
 * Behaviour: play the teacher's label with probability --follow, otherwise the student model (if given) or random.
 *
 * Files in --out (appended, so a worker can be restarted with a new seed):
 *   S.f32  N x S   state features of the deciding seat      Sn.f32 N x S  same seat, right after the action
 *   P.f32  N x P   prompt features                          A.f32  M x A  features of every legal action, in order
 *   meta.i32 N x 8 [game, seat(0|1), teacher idx or -1, played idx, #actions, isWindow, outcome(+1|-1|0|-9), step]
 *   games.jsonl    one line per game
 */
const fs = require('fs');
const path = require('path');
const { Env, seededRng } = require('../env');
const { HeuristicBot } = require('../players/heuristic');
const { featurize, loadModel, softmax } = require('./bots');
const F = require('./features');
const { observe } = require('./observe');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

const same = (a, b) => a.kind === b.kind && a.label === b.label && a.cardUuid === b.cardUuid && a.arg === b.arg;

async function playOne(env, seed, opts, gameNo) {
    const rng = seededRng('gen' + seed);
    const eg = env.newGame({ seed, deck1: env.randomDeck(rng), deck2: env.randomDeck(rng), undo: true });
    await eg.start();
    const teachers = { [eg.ids[0]]: new HeuristicBot('teacher'), [eg.ids[1]]: new HeuristicBot('teacher') };
    const recs = [];
    let steps = 0, outcome = 'STEP_CAP', error = null, labels = 0;
    try {
        while (!eg.over && steps < opts.maxSteps) {
            const pid = eg.ids.find((id) => eg.legalActions(id).length);
            if (!pid) {
                outcome = 'STUCK';
                break;
            }
            let actions = eg.legalActions(pid);
            const f = featurize(eg, pid, actions);
            const isWindow = eg.isActionWindow(pid);
            const teacher = teachers[pid];
            let label = -1;
            if (!isWindow || rng() < opts.teacherFrac) {
                const t = teacher.choose({ game: eg, pid, actions, rng });
                if (isWindow) {
                    // the search rolled the engine back, which renews prompt uuids: use the live actions from here on
                    const live = eg.legalActions(pid);
                    if (live.length !== actions.length || live.some((a, i) => !same(a, actions[i]))) {
                        throw new Error('legal actions changed across the teacher search');
                    }
                    actions = live;
                    labels++;
                }
                label = actions.findIndex((a) => same(a, t));
            } else {
                teacher.plan = [];
            }
            let played;
            if (label >= 0 && rng() < opts.follow) {
                played = label;
            } else if (opts.student) {
                const z = opts.student.encode(f.s);
                const pr = softmax(opts.student.logits(z, f.p, f.A).map((l) => l / opts.temp));
                let r = rng(), k = 0;
                while (k < pr.length - 1 && (r -= pr[k]) > 0) {
                    k++;
                }
                played = k;
            } else {
                played = Math.floor(rng() * actions.length);
            }
            if (played !== label) {
                teacher.plan = [];
            }
            eg.apply(pid, actions[played], rng);
            steps++;
            const sn = F.state(observe(eg, pid));
            recs.push({ seat: eg.ids.indexOf(pid), label, played, isWindow, f, sn, step: steps });
        }
        if (eg.over) {
            outcome = 'won';
        }
    } catch (e) {
        outcome = 'ERROR';
        error = String((e && e.message) || e).split('\n')[0].slice(0, 200);
    }
    let winner = null;
    if (eg.over) {
        winner = eg.winners.length === 1 ? eg.names.indexOf(eg.winners[0]) : 'draw';
    }
    const res = (seat) => (winner === null ? -9 : winner === 'draw' ? 0 : winner === seat ? 1 : -1);
    return { recs, res, info: { game: gameNo, seed, steps, outcome, error, winner: winner === null ? null : winner === 'draw' ? 'draw' : `p${winner + 1}`, round: eg.round, windowLabels: labels } };
}

function write(out, { recs, res, info }) {
    const N = recs.length;
    const M = recs.reduce((t, r) => t + r.f.A.length, 0);
    const S = new Float32Array(N * F.S), Sn = new Float32Array(N * F.S), P = new Float32Array(N * F.P), A = new Float32Array(M * F.A);
    const meta = new Int32Array(N * 8);
    let m = 0;
    recs.forEach((r, i) => {
        S.set(r.f.s, i * F.S);
        Sn.set(r.sn, i * F.S);
        P.set(r.f.p, i * F.P);
        for (const a of r.f.A) {
            A.set(a, m * F.A);
            m++;
        }
        meta.set([info.game, r.seat, r.label, r.played, r.f.A.length, r.isWindow ? 1 : 0, res(r.seat), r.step], i * 8);
    });
    const app = (name, arr) => fs.appendFileSync(path.join(out, name), Buffer.from(arr.buffer));
    app('S.f32', S);
    app('Sn.f32', Sn);
    app('P.f32', P);
    app('A.f32', A);
    app('meta.i32', meta);
    fs.appendFileSync(path.join(out, 'games.jsonl'), JSON.stringify({ ...info, decisions: N }) + '\n');
}

async function main() {
    const out = path.resolve(arg('out', 'data/learned/run/w0'));
    fs.mkdirSync(out, { recursive: true });
    const meta = path.join(out, 'features.json');
    if (!fs.existsSync(meta)) {
        fs.writeFileSync(meta, JSON.stringify({ version: F.VERSION, S: F.S, P: F.P, A: F.A }));
    }
    const studentFile = arg('student', null);
    const opts = {
        teacherFrac: Number(arg('teacher', 0.35)), follow: Number(arg('follow', 0.85)), maxSteps: Number(arg('maxSteps', 3000)),
        student: studentFile ? loadModel(path.resolve(studentFile)) : null, temp: Number(arg('temp', 1))
    };
    const games = Number(arg('games', 10));
    const seed0 = Number(arg('seed', 1));
    const env = new Env();
    const done = fs.existsSync(path.join(out, 'games.jsonl')) ? fs.readFileSync(path.join(out, 'games.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length : 0;
    for (let k = 0; k < games; k++) {
        const t0 = Date.now();
        const r = await playOne(env, seed0 + k, opts, done + k);
        write(out, r);
        console.log(`${path.basename(out)} game ${done + k} seed ${seed0 + k}: ${r.info.outcome} ${r.info.winner ?? ''} ${r.info.steps} steps, ${r.info.windowLabels} window labels, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
}
main().catch((e) => {
    console.error(e); process.exit(1);
});
