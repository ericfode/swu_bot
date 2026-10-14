'use strict';
// node bot/jepa/rank_data.js --out data/rank/v1 --workers 4 [--teachers c-clock,rust-search] [--p 0.12] [--max N] <run dir>...
//
// Training data for ranking moves with the value head. The planner (jepa_bot.py --score plan) plays each candidate
// move with its follow-up choices on the referee's copy until the move has settled, and keeps the move whose settled
// position the value head likes best. A value head trained on who won learns who is ahead, which is not the same
// thing as which of these positions is best. Here recorded games of strong bots (the teachers) are played again on
// the engine, and at a sampled action window of a teacher every candidate line is played the way the planner plays
// it, on a copy of the game (bot/protocol.js Shadow): the move, then each of its first follow-up options, then the
// rest of the move with random non-Cancel choices for both seats, until the game ends, someone is in an action window
// or the action phase is over. The teacher's own line is the real continuation of the recorded game up to the same
// point (mainPath is the teacher's choices at the root and its first follow-up prompt, so the alt line with the same
// path is the teacher's move played on by random choices). bot/jepa/rank_train.py then trains the value head to put
// the teacher's position first.
//
// Output: <out>/shard-<k>.jsonl.gz, one gzip member per game:
//   {"t":"game","seed","bots":[p1,p2],"src","decks"}
//   {"t":"w","you","root":{prompt,state,actions},"main":i,"mainPath":[i,j?],"teacher":leaf,"alts":[{"path":[i,j?],"leaf":leaf}]}
//   {"t":"end","winner","round"}
// A leaf is {"over": winner} when the game ended, else {"mine": true, prompt, state, actions} when the mover is back
// in its action window, else {"mine": false, state}; states are from the mover's seat. "noop": true marks a leaf
// equal to the root (the move changed nothing), which the planner scores 0 without asking the value head.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { fork } = require('child_process');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

/** Game files under each argument: a run folder (its games/), a games folder, or one file. */
function gameFiles(inputs, max) {
    const files = [];
    for (const p of inputs) {
        const dir = fs.existsSync(path.join(p, 'games')) ? path.join(p, 'games') : p;
        const found = fs.statSync(dir).isDirectory()
            ? fs.readdirSync(dir).filter((f) => /\.jsonl(\.gz)?$/.test(f)).sort().map((f) => path.join(dir, f))
            : [dir];
        files.push(...(max ? found.slice(0, max) : found));
    }
    return files;
}

function readGame(file) {
    let text = fs.readFileSync(file);
    if (file.endsWith('.gz')) {
        text = zlib.gunzipSync(text);
    }
    const out = { header: null, steps: [], end: null };
    for (const l of text.toString('utf8').split('\n')) {
        if (!l.trim()) {
            continue;
        }
        const o = JSON.parse(l);
        if (o.t === 'header') {
            out.header = o;
        } else if (o.t === 'step' && o.n > 0) {
            out.steps.push(o);
        } else if (o.t === 'end') {
            out.end = o;
        }
    }
    return out;
}

async function worker(files, file, cfg) {
    const { Env, seededRng } = require('../env');
    const { gameStreams } = require('../rng');
    const { view, promptView, actionView, actionKey } = require('../view');
    const { Shadow } = require('../protocol');
    const env = new Env();
    fs.writeFileSync(file, '');
    const tally = { games: 0, windows: 0, lines: 0, skipped: {}, drift: 0, lost: 0, failed: 0 };
    const skip = (why) => (tally.skipped[why] = (tally.skipped[why] ?? 0) + 1);

    const toAct = (eg) => {
        for (const pid of eg.ids) {
            const actions = eg.legalActions(pid);
            if (actions.length) {
                return { pid, actions };
            }
        }
        return null;
    };
    const settled = (eg, who) => eg.over || eg.phase !== 'action' || eg.isActionWindow(who.pid);
    const isCancel = (a) => a.kind === 'button' && /^cancel$/i.test(String(a.label ?? ''));
    const pick = (actions, rng) => {
        const ok = actions.map((_, i) => i).filter((i) => !isCancel(actions[i]));
        const from = ok.length ? ok : actions.map((_, i) => i);
        return from[Math.floor(rng() * from.length)];
    };
    const leafOf = (eg, pid, rootState) => {
        if (eg.over) {
            return { over: eg.winner };
        }
        const seat = eg.seatOf(pid);
        const state = view(eg, seat);
        if (eg.isActionWindow(pid)) {
            const actions = eg.legalActions(pid);
            const leaf = { mine: true, prompt: promptView(eg, pid), state, actions: actions.map((a, i) => actionView(eg, a, i, pid)) };
            if (JSON.stringify(state) === rootState) {
                leaf.noop = true;
            }
            return leaf;
        }
        return { mine: false, state };
    };

    /**
     * Play one line on the copy from the window: `path` gives the mover's choices at the root and at its first
     * follow-up prompt; everything after is random non-Cancel for both seats. Returns
     * { leaf } at the settled position, or { follow: options } when the line reaches the first follow-up prompt
     * and path has no choice for it yet.
     */
    const playLine = (eg, pid, rootActions, linePath, rng, rootState) => {
        const root = eg.refetch(pid, rootActions[linePath[0]]);
        if (!root) {
            throw new Error('root move vanished after rollback');
        }
        eg.apply(pid, root, rng);
        let follow = 0;
        for (let step = 0; step < cfg.maxSteps; step++) {
            const who = eg.over ? null : toAct(eg);
            if (eg.over || settled(eg, who)) {
                return { leaf: leafOf(eg, pid, rootState) };
            }
            if (!who) {
                throw new Error('nobody can act');
            }
            let j;
            if (who.actions.length === 1) {
                j = 0;
            } else if (who.pid === pid && follow === 0) {
                follow++;
                if (linePath.length < 2) {
                    return { follow: who.actions.map((a) => actionKey(eg, a)) };
                }
                j = linePath[1];
                if (j >= who.actions.length) {
                    throw new Error('follow-up option vanished');
                }
            } else {
                j = pick(who.actions, rng);
            }
            eg.apply(who.pid, who.actions[j], rng);
        }
        throw new Error('line did not settle');
    };

    for (const f of files) {
        let g;
        try {
            g = readGame(f);
        } catch {
            skip('unreadable');
            continue;
        }
        const { header, steps, end } = g;
        if (!header?.decks?.p1 || !header?.decks?.p2) {
            skip('no decks');
            continue;
        }
        if (end?.outcome !== 'won' || !['p1', 'p2'].includes(end.winner)) {
            skip('no winner');
            continue;
        }
        const bots = header.players.map((p) => p.bot);
        const teacherSeats = ['p1', 'p2'].filter((s, k) => cfg.teachers.has(String(bots[k]).split('#')[0]));
        if (!teacherSeats.length) {
            skip('no teacher');
            continue;
        }
        const src = path.basename(path.dirname(path.dirname(f))) + '/' + path.basename(f).replace(/\.jsonl(\.gz)?$/, '');
        const lines = [JSON.stringify({ t: 'game', seed: header.seed, bots, src, decks: header.decks })];
        const rng = seededRng(`rank:${src}`);
        const setup = { seed: gameStreams(header.seed, end.key ?? null).engine, deck1: header.decks.p1, deck2: header.decks.p2 };
        const real = env.newGame(setup);
        const shadow = new Shadow(env, setup);
        let pending = null;
        let windows = 0;
        let ok = true;
        try {
            await real.start();
            for (let k = 0; k < steps.length; k++) {
                const s = steps[k];
                const pid = real.pidOf(s.pid);
                const actions = real.legalActions(pid);
                const a = actions[s.action.i];
                if (actions.length !== s.legal || a?.label !== s.action.label) {
                    ok = false;
                    break;
                }
                if (pending && settled(real, { pid })) {
                    pending.rec.teacher = leafOf(real, pending.pid, pending.rootState);
                    lines.push(JSON.stringify(pending.rec));
                    windows++;
                    pending = null;
                } else if (pending?.follow && pid === pending.pid && actions.length > 1) {
                    // the teacher's first follow-up choice: its alt line with the same path is the teacher's line
                    pending.rec.mainPath.push(s.action.i);
                    pending.follow = false;
                }
                if (!pending && actions.length > 1 && teacherSeats.includes(s.pid) && real.isActionWindow(pid) && rng() < cfg.p) {
                    const eg = await shadow.sync(real, pid);
                    if (!eg) {
                        tally.lost++;
                    } else {
                        const rootActions = eg.legalActions(pid);
                        const rootState = JSON.stringify(view(eg, s.pid));
                        const rec = { t: 'w', you: s.pid, root: { prompt: promptView(eg, pid), state: JSON.parse(rootState), actions: rootActions.map((x, i) => actionView(eg, x, i, pid)) }, main: s.action.i, alts: [] };
                        const mark = eg.mark(pid);
                        let roots = rootActions.map((_, i) => i);
                        if (roots.length > cfg.roots) {
                            roots = roots.filter((i) => i !== s.action.i).sort(() => rng() - 0.5).slice(0, cfg.roots - 1).concat([s.action.i]).sort((x, y) => x - y);
                        }
                        const queue = roots.map((i) => [i]);
                        let n = 0;
                        while (queue.length && n < cfg.lines) {
                            const linePath = queue.shift();
                            n++;
                            const lrng = seededRng(`rank:${src}:${k}:${linePath.join('.')}`);
                            try {
                                const r = playLine(eg, pid, rootActions, linePath, lrng, rootState);
                                if (r.follow) {
                                    // the first follow-up prompt: each option (up to cfg.follow) becomes a line of its own
                                    let opts = r.follow.map((_, j) => j);
                                    if (opts.length > cfg.follow) {
                                        opts = opts.sort(() => rng() - 0.5).slice(0, cfg.follow).sort((x, y) => x - y);
                                    }
                                    queue.unshift(...opts.map((j) => [linePath[0], j]));
                                    n--;
                                } else {
                                    rec.alts.push({ path: linePath, leaf: r.leaf });
                                }
                            } catch {
                                tally.failed++;
                            }
                            eg.restore(pid, mark);
                        }
                        tally.lines += rec.alts.length;
                        if (rec.alts.length >= 2) {
                            rec.mainPath = [s.action.i];
                            pending = { rec, pid, rootState, follow: true };
                        }
                    }
                }
                shadow.record({ pid, i: s.action.i, legal: actions.length, key: actionKey(real, a), split: s.action.split });
                real.apply(pid, s.action.split ? { ...a, split: s.action.split.map((e) => ({ id: real.uuidOf(e.id), amount: e.amount })) } : a);
            }
            if (ok && pending && real.over) {
                pending.rec.teacher = { over: real.winner };
                lines.push(JSON.stringify(pending.rec));
                windows++;
            }
        } catch {
            ok = false;
        }
        if (!ok) {
            tally.drift++;
        }
        lines.push(JSON.stringify({ t: 'end', winner: end.winner, round: end.round }));
        if (windows) {
            fs.appendFileSync(file, zlib.gzipSync(`${lines.join('\n')}\n`));
            tally.games++;
            tally.windows += windows;
        }
        process.send?.({ done: 1, windows });
    }
    process.send?.({ tally });
}

async function main() {
    const cfg = {
        teachers: new Set(arg('teachers', 'c-clock,rust-search').split(',')),
        p: Number(arg('p', 0.12)),
        roots: Number(arg('roots', 16)),
        follow: Number(arg('follow', 4)),
        lines: Number(arg('lines', 40)),
        maxSteps: Number(arg('max-steps', 60)),
    };
    if (process.argv.includes('--worker')) {
        const files = await new Promise((resolve) => process.once('message', (m) => resolve(m.files)));
        const c = JSON.parse(arg('cfg'));
        await worker(files, arg('file'), { ...c, teachers: new Set(c.teachers) });
        process.exit(0);
    }
    const out = path.resolve(arg('out', 'data/rank/v1'));
    const workers = Number(arg('workers', 4));
    const max = Number(arg('max', 0));
    const inputs = process.argv.slice(2).filter((x, i, all) => !x.startsWith('--') && !(all[i - 1] ?? '').startsWith('--'));
    const files = gameFiles(inputs, max);
    fs.mkdirSync(out, { recursive: true });
    for (const f of fs.readdirSync(out)) {
        if (/^shard-\d+\.jsonl\.gz$/.test(f)) {
            fs.unlinkSync(path.join(out, f));
        }
    }
    const t0 = Date.now();
    let done = 0;
    let windows = 0;
    const total = { games: 0, windows: 0, lines: 0, skipped: {}, drift: 0, lost: 0, failed: 0 };
    const procs = [];
    const passCfg = JSON.stringify({ ...cfg, teachers: [...cfg.teachers] });
    for (let k = 0; k < workers; k++) {
        const mine = files.filter((_, i) => i % workers === k);
        if (!mine.length) {
            break;
        }
        const p = fork(__filename, ['--worker', '--file', path.join(out, `shard-${k}.jsonl.gz`), '--cfg', passCfg], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        p.send({ files: mine });
        p.on('message', (m) => {
            if (m.done) {
                done += m.done;
                windows += m.windows;
                if (done % 50 === 0) {
                    const s = (Date.now() - t0) / 1000;
                    console.log(`${done}/${files.length} games, ${windows} windows, ${(windows / s).toFixed(2)} windows/s`);
                }
            }
            if (m.tally) {
                for (const key of ['games', 'windows', 'lines', 'drift', 'lost', 'failed']) {
                    total[key] += m.tally[key];
                }
                for (const [k2, v] of Object.entries(m.tally.skipped)) {
                    total.skipped[k2] = (total.skipped[k2] ?? 0) + v;
                }
            }
        });
        procs.push(new Promise((res, rej) => p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`worker ${k} exited with code ${code}`))))));
    }
    await Promise.all(procs);
    console.log(`wrote ${out} in ${((Date.now() - t0) / 1000).toFixed(0)}s from ${files.length} files: ${JSON.stringify(total)}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
