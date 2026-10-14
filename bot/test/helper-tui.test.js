'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tui = require('../arena/ops/helper-tui');

const strip = (s) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

// a step line as bot/view.js snapshots it (trimmed)
const STEP = {
    t: 'step', n: 100, pid: 'p2', action: { kind: 'option', label: '#3' },
    state: {
        round: 6, phase: 'action', players: {
            p1: { base: { n: 'Colossus', hp: 35, d: 12 }, leader: { n: 'IG-88', dep: 0 }, res: { ready: 3, total: 7 }, handCount: 4, deck: 35,
                ground: [{ p: 4, h: 4, d: 0, x: 1 }, { p: 2, h: 2, d: 0 }], space: [] },
            p2: { base: { n: 'Stygeon Spire', hp: 27, d: 0 }, leader: { n: 'General Grievous' }, res: { ready: 0, total: 5 }, handCount: 7, deck: 34,
                ground: [], space: [{ p: 3, h: 3, d: 1 }] },
        },
    },
};

test('clean keeps names printable, one cell per character', () => {
    assert.strictEqual(tui.clean('ok-bot_v2'), 'ok-bot_v2');
    assert.strictEqual(tui.clean('evil\u001b[2J\u001b]0;title\u0007name'), 'evil0;titlename');
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(tui.clean('a\u0000b\u009bc\r\nd‮e')));
    assert.strictEqual(tui.clean('漢字🙂'), '???');
    assert.strictEqual(tui.clean('x'.repeat(50), 10).length, 10);
});

test('helper and coordinator lines become events', () => {
    const seed = tui.parseLine('02:45:16.068 [info] lease 7Ctl (seed 3250146062): rust-greedy2-wasm-vs-node-search-wasm-3250146062 won p1, node-search-wasm-vs-rust-greedy2-wasm-3250146062 ERROR p2; 33 s');
    assert.strictEqual(seed.kind, 'seed');
    assert.strictEqual(seed.secs, 33);
    assert.deepStrictEqual(seed.games.map((g) => [g.p1, g.p2, g.outcome, g.winner]), [
        ['rust-greedy2-wasm', 'node-search-wasm', 'won', 'rust-greedy2-wasm'],
        ['node-search-wasm', 'rust-greedy2-wasm', 'ERROR', 'rust-greedy2-wasm'],
    ]);
    const failed = tui.parseLine('03:00:00.000 [info] lease abc (seed 12): failed (the computer slept); 40 s');
    assert.deepStrictEqual([failed.kind, failed.seed, failed.why], ['failed', '12', 'the computer slept']);
    const hello = tui.parseLine('02:44:41.464 [info] the games machine knows this helper as eric; 3 slots claim seeds');
    assert.deepStrictEqual([hello.kind, hello.name, hello.slots], ['hello', 'eric', 3]);
    assert.strictEqual(tui.parseLine('03:28:13.148 [warning] hello: no answer from the games machine (connection refused); trying every 30 s').kind, 'nomachine');
    assert.strictEqual(tui.parseLine('playing with 5 slots; Ctrl-C stops').slots, 5);
    assert.strictEqual(tui.parseLine('built swu-helper:b273229411d25afcdf97977fa4d3048979815ca6').sha, 'b273229');
    assert.strictEqual(tui.parseLine('helper.sh: Docker is not running').kind, 'fatal');
    assert.strictEqual(tui.parseLine('#14 2.162 Compiling 1 file (.ex)').kind, 'buildlog');
    assert.strictEqual(tui.parseLine('Rust simulations are not available (Wasm package is not built.)').kind, 'norust');
    assert.strictEqual(tui.parseLine('something else').kind, 'log');
    assert.deepStrictEqual(tui.gameOutcome('a-v1-vs-b-wasm-7 STEP_CAP'), { id: 'a-v1-vs-b-wasm-7', p1: 'a-v1', p2: 'b-wasm', outcome: 'STEP_CAP', seat: null, winner: null });
});

test('docker stats lines give cores and memory', () => {
    const s = tui.parseStats('\u001b[H{"CPUPerc":"283.41%","MemUsage":"1.25GiB / 7.746GiB","Name":"swu-helper"}\u001b[K');
    assert.ok(Math.abs(s.cores - 2.8341) < 1e-9);
    assert.strictEqual(s.mem, 1.25 * 1024 ** 3);
    assert.ok(Math.abs(s.limit - 7.746 * 1024 ** 3) < 1);
    assert.strictEqual(tui.bytes('970.9MiB'), 970.9 * 1024 ** 2);
    assert.strictEqual(tui.parseStats('not json'), null);
});

test('a replay step or end line is summarized for the view', () => {
    const s = tui.summarizeStep(STEP);
    assert.deepStrictEqual([s.n, s.actor, s.round, s.label], [100, 'p2', 6, '#3']);
    assert.deepStrictEqual([s.p1.hp, s.p1.d, s.p1.hand, s.p1.ready, s.p1.total], [35, 12, 4, 3, 7]);
    assert.deepStrictEqual(s.p1.ground, [[4, 4, 0, 1], [2, 2, 0, 0]]);
    assert.deepStrictEqual(s.p2.space, [[3, 3, 1, 0]]);
    assert.deepStrictEqual(tui.summarizeStep({ t: 'end', winner: 'p2', round: 11, steps: 342, outcome: 'won' }).end, { winner: 'p2', outcome: 'won', round: 11, steps: 342 });
    assert.strictEqual(tui.summarizeStep({ t: 'header' }), null);
    assert.strictEqual(tui.summarizeStep('x'), null);
});

test('the frame is exactly the terminal, and data cannot write escapes into it', () => {
    const st = tui.newState('run');
    for (const line of ['playing with 5 slots', '02:44:41.464 [info] the games machine knows this helper as eric; 5 slots claim seeds',
        '02:45:16.068 [info] lease L1 (seed 9): x-v1-vs-heuristic-9 won p1, heuristic-vs-x-v1-9 won p2; 33 s']) {
        tui.apply(st, tui.parseLine(line));
    }
    tui.applyStats(st, { cores: 4.5, mem: 1.3e9, limit: 8.3e9 });
    tui.applyLive(st, {
        t: Date.now(), rust: false, slots: [{
            slot: 1, lease: 'L2', seed: 10, since: Date.now() - 5000, games: [
                { id: 'x-v1-vs-heuristic-10', bots: ['x-v1\u001b[31m', 'heuristic'], size: 10, mtime: 1, last: tui.summarizeStep(STEP) },
                { id: 'heuristic-vs-x-v1-10', bots: ['heuristic', 'x-v1'], size: 10, mtime: 1, last: { end: { winner: 'p1', outcome: 'won', round: 9, steps: 220 } } },
            ],
        }, { slot: 2, lease: 'L3', seed: 11, since: null, games: [{ id: 'a-vs-b-11', bots: ['a', 'b'], size: 0, mtime: null, last: null }] }],
    });
    for (const [W, H] of [[40, 12], [80, 24], [110, 34], [160, 50]]) {
        for (const help of [false, true]) {
            st.help = help;
            const lines = tui.frame(st, W, H);
            assert.strictEqual(lines.length, H);
            for (const l of lines) {
                assert.strictEqual(strip(l).length, W, `a line of ${strip(l).length} cells at ${W}x${H}: ${strip(l)}`);
                assert.ok(!/\u001b\[31m/.test(l), 'an escape from the data reached the frame');
            }
        }
    }
    st.help = false;
    const text = tui.frame(st, 110, 34).map(strip).join('\n');
    assert.match(text, /PLAYING/);
    assert.match(text, /x-v1 +2 – 0 +heuristic/);
    assert.match(text, /heuristic wins/);
    assert.match(text, /4\.5\/\d+ cores/);
});

test('the reader reads lease folders, and only regular files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-tui-'));
    try {
        const lease = path.join(root, '3', 'LEASE');
        fs.mkdirSync(path.join(lease, 'out'), { recursive: true });
        fs.writeFileSync(path.join(lease, 'job.json'), JSON.stringify({ seed: 77, games: [{ id: 'a-vs-b-77', p1: 'a', p2: 'b' }, { id: 'b-vs-a-77', p1: 'b', p2: 'a' }] }));
        const header = { t: 'header', players: [{ id: 'p1', bot: 'a' }, { id: 'p2', bot: 'b' }] };
        fs.writeFileSync(path.join(lease, 'out', 'a-vs-b-77.jsonl'), `${JSON.stringify(header)}\n${JSON.stringify(STEP)}\n{"t":"step","n":10`);
        fs.symlinkSync('/etc/hosts', path.join(lease, 'out', 'b-vs-a-77.jsonl'));
        const child = spawn(process.execPath, ['-e', tui.readerSource(root)], { stdio: ['pipe', 'pipe', 'inherit'] });
        const line = await new Promise((resolve, reject) => {
            let buf = '';
            child.stdout.on('data', (d) => {
                buf += d;
                if (buf.includes('\n')) {
                    resolve(buf.split('\n')[0]);
                }
            });
            child.on('error', reject);
        });
        child.stdin.end(); // the reader ends with its stdin
        const exited = await new Promise((resolve) => child.on('exit', resolve));
        assert.strictEqual(exited, 0);
        const live = JSON.parse(line);
        assert.strictEqual(live.slots.length, 1);
        const [sl] = live.slots;
        assert.deepStrictEqual([sl.slot, sl.lease, sl.seed], [3, 'LEASE', 77]);
        assert.deepStrictEqual(sl.games[0].bots, ['a', 'b']);
        assert.strictEqual(sl.games[0].last.n, 100, 'the last whole line, not the one being written');
        assert.deepStrictEqual([sl.games[1].size, sl.games[1].last], [0, null], 'a symlink is not read');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
