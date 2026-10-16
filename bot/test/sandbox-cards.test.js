'use strict';
// No card files for bots: the sandbox (bot/compiled/run.py) mounts none, even for a bundle whose arena.json asks for
// them, a bundle answers a hello that carries the card data, and the intake refuses a bundle that asks for the files.
// The run.py tests need wasmtime for Python; the hello test also build/compiled/node-random and the engine's card data.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const RUN_PY = path.join(ROOT, 'bot', 'compiled', 'run.py');
const NODE_RANDOM = path.join(ROOT, 'build', 'compiled', 'node-random');
const WASMTIME = spawnSync('python3', ['-I', '-c', 'import wasmtime'], { stdio: 'ignore' }).status === 0;
const ENGINE = fs.existsSync(path.join(ROOT, 'forceteki', 'build', 'server')) && fs.existsSync(path.join(ROOT, 'forceteki', 'test', 'json'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-cards-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A WASI program that writes the name of every folder it was given (fd_prestat_dir_name of fds 3 to 15), one per line,
// then how many environment variables it has, as one digit
const PROBE = `(module
  (import "wasi_snapshot_preview1" "fd_write" (func $w (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_prestat_get" (func $pg (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_prestat_dir_name" (func $pn (param i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "environ_sizes_get" (func $es (param i32 i32) (result i32)))
  (memory (export "memory") 1)
  (func $line (param $p i32) (param $n i32)
    (i32.store8 (i32.add (local.get $p) (local.get $n)) (i32.const 10))
    (i32.store (i32.const 16) (local.get $p))
    (i32.store (i32.const 20) (i32.add (local.get $n) (i32.const 1)))
    (drop (call $w (i32.const 1) (i32.const 16) (i32.const 1) (i32.const 24))))
  (func (export "_start") (local $fd i32) (local $n i32)
    (local.set $fd (i32.const 3))
    (block $done (loop $next
      (br_if $done (i32.ge_u (local.get $fd) (i32.const 16)))
      (if (i32.eqz (call $pg (local.get $fd) (i32.const 0)))
        (then
          (local.set $n (i32.load (i32.const 4)))
          (drop (call $pn (local.get $fd) (i32.const 256) (local.get $n)))
          (call $line (i32.const 256) (local.get $n))))
      (local.set $fd (i32.add (local.get $fd) (i32.const 1)))
      (br $next)))
    (drop (call $es (i32.const 32) (i32.const 36)))
    (i32.store8 (i32.const 512) (i32.add (i32.const 48) (i32.load (i32.const 32))))
    (call $line (i32.const 512) (i32.const 1))))`;

/** The probe as a bundle whose arena.json asks for the card data the way bundles once did. */
function probeBundle() {
    const dir = fs.mkdtempSync(path.join(tmp, 'probe-'));
    const make = 'import sys, json, hashlib, wasmtime\nb = wasmtime.wat2wasm(sys.stdin.read())\nopen(sys.argv[1] + "/bot.wasm", "wb").write(b)\n'
        + 'json.dump({"schema": "swu-arena-bot/1", "name": "probe", "lang": "wat", "protocol": 2, "kind": "wasm", "platform": "wasm32-wasip1",'
        + ' "runtime": "wasi-p1", "run": {"cmd": "./bot.wasm", "args": [], "env": {}}, "entry_sha256": hashlib.sha256(b).hexdigest(),'
        + ' "resources": {"memory_mb": 64}, "cards": {"use": "mount", "layout": "dir", "env": {"SWU_CARD_JSON": "/cards"}}, "network": "none"},'
        + ' open(sys.argv[1] + "/arena.json", "w"))';
    const r = spawnSync('python3', ['-c', make, dir], { input: PROBE, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    return dir;
}

test('run.py gives a bundle only /bot and no card data, even when its arena.json asks for the cards', { skip: !WASMTIME && 'needs wasmtime for Python' }, () => {
    const r = spawnSync('python3', ['-I', RUN_PY, probeBundle()], {
        encoding: 'utf8', timeout: 60000,
        env: { PATH: process.env.PATH, SWU_WASM_CACHE: path.join(tmp, 'cache'), SWU_CARD_JSON: path.join(ROOT, 'forceteki', 'test', 'json') }
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, '/bot\n0\n', 'one folder, /bot, and no environment variables (no SWU_CARD_JSON)');
});

test('a bundle under run.py answers a hello that carries the card data', { skip: (!WASMTIME || !ENGINE || !fs.existsSync(path.join(NODE_RANDOM, 'arena.json'))) && 'needs wasmtime, the engine\'s card data and build/compiled/node-random' }, async () => {
    const { gameCards, cardGetter } = require('../game-cards');
    const lists = require('../decks/ash-meta-2026-09.json');
    const cards = gameCards(cardGetter(), [lists[0], lists[1]]);
    const hello = { t: 'hello', protocol: 'swu-bot-stdio', v: 1, versions: [1, 2], bot: 'node-random', you: 'p1', seed: 7,
        players: [{ id: 'p1', name: 'p1', bot: 'node-random' }, { id: 'p2', name: 'p2', bot: 'heuristic' }], deck: lists[0], opponent: lists[1], ms: 30000, cards };
    const line = `${JSON.stringify(hello)}\n`;
    assert.ok(line.length > 20000, `a ${line.length} B hello`);
    const p = spawn('python3', ['-I', RUN_PY, '--quiet', NODE_RANDOM], { env: { PATH: process.env.PATH, SWU_WASM_CACHE: path.join(tmp, 'cache') }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const reply = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no reply: ${out}`)), 60000);
        p.stdout.on('data', (d) => {
            out += d;
            if (out.includes('\n')) {
                clearTimeout(timer);
                resolve(JSON.parse(out.slice(0, out.indexOf('\n'))));
            }
        });
    });
    p.stdin.write(line);
    try {
        assert.deepStrictEqual(await reply, { t: 'ready', v: 2, name: 'node-random' });
    } finally {
        p.stdin.end();
        await new Promise((r) => (p.exitCode !== null ? r() : p.on('exit', r)));
    }
});

test('the intake refuses a submitted bundle that asks for the card data as files, and takes it without', () => {
    const { pack } = require('../arena/intake');
    const manifest = { schema: 'swu-arena-bot/1', name: 'old', lang: 'wat', protocol: 2, kind: 'wasm', platform: 'wasm32-wasip1', runtime: 'wasi-p1',
        run: { cmd: './bot.wasm', args: [], env: {} }, resources: { memory_mb: 64 }, network: 'none' };
    const job = (m) => ({ kind: 'wasm', name: 'old', owner: 'kim', files: { 'arena.json': JSON.stringify(m), 'bot.wasm': 'not checked here' } });
    const mount = { ...manifest, cards: { use: 'mount', layout: 'dir', env: { SWU_CARD_JSON: '/cards' } } };
    assert.throws(() => pack(job(mount), fs.mkdtempSync(path.join(tmp, 'job-'))), (e) => /cards\.use "mount"/.test(e.message) && /hello\.cards/.test(e.message));
    for (const m of [manifest, { ...manifest, cards: { use: 'none' } }]) {
        const folder = pack(job(m), fs.mkdtempSync(path.join(tmp, 'job-')));
        assert.ok(fs.existsSync(path.join(folder, 'arena.json')));
    }
});
