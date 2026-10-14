'use strict';
// node bot/jepa/from_replays.js --out data/traj/realdeck --workers 4 [--max N] <run dir or game file>...
//
// Training games for the JEPA (and any reader of "swu-traj/1") from recorded replays. A replay holds each decision's
// chosen action and an omniscient board, while a bot sees one seat's view with the prompt and the legal actions. So
// every game is played again on the engine from its header (decks, seed, the game's key in its `end` line), and at
// each recorded decision with more than one legal action the acting seat's `decide` body is written, as
// bot/learn/collect.js writes it for live games. A game whose replay drifts from the recording (another legal
// action count or label) is dropped from that step on, and so are games without a winner or without deck lists
// (imported human games cannot be played again).
//
// Output: <out>/shard-<k>.jsonl.gz, one gzip member per game:
//   {"t":"game","seed","bots":[p1,p2],"src"}  {"t":"d","seq","you","prompt","state","actions","i"}...  {"t":"end","seed","winner","outcome"}
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
    const lines = text.toString('utf8').split('\n').filter((l) => l.trim());
    const out = { header: null, steps: [], end: null };
    for (const l of lines) {
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

async function worker(files, file) {
    const { Env } = require('../env');
    const { gameStreams } = require('../rng');
    const { view, promptView, actionView } = require('../view');
    const env = new Env();
    fs.writeFileSync(file, '');
    const tally = { games: 0, decisions: 0, skipped: {}, drift: 0 };
    const skip = (why) => (tally.skipped[why] = (tally.skipped[why] ?? 0) + 1);
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
        const lines = [];
        const write = (o) => lines.push(JSON.stringify(o));
        const src = path.basename(path.dirname(path.dirname(f))) + '/' + path.basename(f).replace(/\.jsonl(\.gz)?$/, '');
        write({ t: 'game', seed: header.seed, bots: header.players.map((p) => p.bot), src });
        let seq = 0;
        let ok = true;
        try {
            const eg = env.newGame({ seed: gameStreams(header.seed, end.key ?? null).engine, deck1: header.decks.p1, deck2: header.decks.p2 });
            await eg.start();
            for (const s of steps) {
                const pid = eg.pidOf(s.pid);
                const actions = eg.legalActions(pid);
                const a = actions[s.action.i];
                if (actions.length !== s.legal || a?.label !== s.action.label) {
                    ok = false;
                    break;
                }
                if (actions.length > 1) {
                    seq++;
                    write({ t: 'd', seq, you: s.pid, prompt: promptView(eg, pid), state: view(eg, s.pid), actions: actions.map((x, i) => actionView(eg, x, i, pid)), i: s.action.i });
                }
                eg.apply(pid, s.action.split ? { ...a, split: s.action.split.map((e) => ({ id: eg.uuidOf(e.id), amount: e.amount })) } : a);
            }
        } catch {
            ok = false;
        }
        if (!ok) {
            // the decisions before the drift are still right, but a game cut short teaches the wrong horizon targets
            tally.drift++;
            continue;
        }
        write({ t: 'end', seed: header.seed, winner: end.winner, outcome: 'won', round: end.round, steps: end.steps });
        fs.appendFileSync(file, zlib.gzipSync(`${lines.join('\n')}\n`));
        tally.games++;
        tally.decisions += seq;
        process.send?.({ done: 1 });
    }
    process.send?.({ tally });
}

async function main() {
    if (process.argv.includes('--worker')) {
        const files = await new Promise((resolve) => process.once('message', (m) => resolve(m.files)));
        await worker(files, arg('file'));
        process.exit(0);
    }
    const out = path.resolve(arg('out', 'data/traj/replays'));
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
    const total = { games: 0, decisions: 0, skipped: {}, drift: 0 };
    const procs = [];
    for (let k = 0; k < workers; k++) {
        const mine = files.filter((_, i) => i % workers === k);
        if (!mine.length) {
            break;
        }
        const p = fork(__filename, ['--worker', '--file', path.join(out, `shard-${k}.jsonl.gz`)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        p.send({ files: mine });
        p.on('message', (m) => {
            if (m.done) {
                done += m.done;
                if (done % 250 === 0) {
                    console.log(`${done}/${files.length} games, ${(done / ((Date.now() - t0) / 1000)).toFixed(1)} games/s`);
                }
            }
            if (m.tally) {
                total.games += m.tally.games;
                total.decisions += m.tally.decisions;
                total.drift += m.tally.drift;
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
