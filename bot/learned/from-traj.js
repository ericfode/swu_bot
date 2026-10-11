'use strict';
/**
 * Convert "swu-traj/1" trajectories (/mnt/project-files/learn/README.md: gzipped JSONL of stdio `decide` messages
 * plus the chosen index) into gen.js training arrays, so train.py can learn from games other threads collected.
 *
 *   node bot/learned/from-traj.js --in /mnt/project-files/learn/traj/random-v1-sample --out data/learned/traj-random/w0 [--labels played|none]
 *
 * The played action becomes the policy label only with --labels played (use it for games by bots worth copying).
 * swu-traj has no "state after the action", so these rows are marked (step = -1) and left out of dynamics training.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const F = require('./features');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

function* shardLines(file) {
    // shards are concatenated gzip members; gunzipSync reads all members
    const text = zlib.gunzipSync(fs.readFileSync(file), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('utf8');
    for (const line of text.split('\n')) {
        if (line.trim()) {
            try {
                yield JSON.parse(line);
            } catch {
                return; // a shard still being written can end mid-line
            }
        }
    }
}

function main() {
    const inDir = arg('in');
    const out = path.resolve(arg('out', 'data/learned/traj/w0'));
    const useLabels = arg('labels', 'none') === 'played';
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'features.json'), JSON.stringify({ version: F.VERSION, S: F.S, P: F.P, A: F.A, source: inDir }));
    for (const f of ['S.f32', 'Sn.f32', 'P.f32', 'A.f32', 'meta.i32', 'games.jsonl']) {
        fs.rmSync(path.join(out, f), { force: true });
    }
    const files = fs.statSync(inDir).isDirectory() ? fs.readdirSync(inDir).filter((f) => f.endsWith('.gz')).map((f) => path.join(inDir, f)) : [inDir];
    let game = 0, rows = 0, kept = 0;
    let recs = [];
    const flush = (end) => {
        const res = (seat) => (!end || end.winner == null ? -9 : end.winner === 'draw' ? 0 : end.winner === seat ? 1 : -1);
        if (end && end.winner != null && recs.length) {
            const N = recs.length, M = recs.reduce((t, r) => t + r.A.length, 0);
            const S = new Float32Array(N * F.S), P = new Float32Array(N * F.P), A = new Float32Array(M * F.A), meta = new Int32Array(N * 8);
            let m = 0;
            recs.forEach((r, i) => {
                S.set(r.s, i * F.S);
                P.set(r.p, i * F.P);
                r.A.forEach((a) => A.set(a, (m++) * F.A));
                meta.set([game, r.you === 'p1' ? 0 : 1, useLabels ? r.i : -1, r.i, r.A.length, r.window ? 1 : 0, res(r.you), -1], i * 8);
            });
            for (const [name, arr] of [['S.f32', S], ['Sn.f32', S], ['P.f32', P], ['A.f32', A], ['meta.i32', meta]]) {
                fs.appendFileSync(path.join(out, name), Buffer.from(arr.buffer));
            }
            fs.appendFileSync(path.join(out, 'games.jsonl'), JSON.stringify({ game, seed: end.seed, winner: end.winner, outcome: end.outcome, decisions: N }) + '\n');
            game++;
            kept += N;
        }
        recs = [];
    };
    for (const file of files) {
        for (const ln of shardLines(file)) {
            if (ln.t === 'game') {
                recs = [];
            } else if (ln.t === 'd') {
                rows++;
                const obs = { ...ln.state, you: ln.you };
                const title = `${ln.prompt.title ?? ''} ${ln.prompt.promptTitle ?? ''}`.trim();
                recs.push({ you: ln.you, i: ln.i, window: !!ln.prompt.actionWindow, s: F.state(obs), p: F.prompt(ln.prompt.signature, title), A: ln.actions.map((a) => F.action(a, obs)) });
            } else if (ln.t === 'end') {
                flush(ln);
            }
        }
    }
    console.log(`${files.length} shard(s): ${rows} decisions read, ${kept} kept from ${game} finished games -> ${out}`);
}

main();
