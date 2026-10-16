'use strict';
// bot/compiled/run.py's cache of compiled code, which wasmtime loads as trusted machine code: used only in a folder of
// root's or this user's that nobody else can write, an entry only when it is a plain file of the folder's owner; a cache
// it cannot write is no error. And play-seed.js --warm --bundles, which compiles versions' tars into it as root before
// their games. Needs wasmtime; the root case also needs a user named arena.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');

const COMPILED = path.join(__dirname, '..', 'compiled');
const PLAY_SEED = path.join(__dirname, '..', 'arena', 'play-seed.js');
const WASMTIME = spawnSync('python3', ['-I', '-c', 'import wasmtime'], { stdio: 'ignore' }).status === 0;
const skip = !WASMTIME && 'needs wasmtime for Python';
const ROOT_USER = process.getuid?.() === 0;
const BOTS_USER = (() => {
    try {
        return ['-u', '-g'].map((f) => Number(execFileSync('id', [f, 'arena'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })));
    } catch {
        return null;
    }
})();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wasm-cache-test-'));
// the bots' user reads the bundles and caches in here in the root case
fs.chmodSync(tmp, 0o755);
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// a WASI program that writes "hi" and ends
const HI = `(module
  (import "wasi_snapshot_preview1" "fd_write" (func $w (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 16) "hi\\n")
  (func (export "_start")
    (i32.store (i32.const 0) (i32.const 16))
    (i32.store (i32.const 4) (i32.const 3))
    (drop (call $w (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 8)))))`;

/** A bundle folder (readable by everyone) holding that program. */
function bundle(name = 'hi') {
    const dir = fs.mkdtempSync(path.join(tmp, `${name}-`));
    fs.chmodSync(dir, 0o755);
    const make = 'import sys, json, hashlib, wasmtime\nb = wasmtime.wat2wasm(sys.stdin.read())\nopen(sys.argv[1] + "/bot.wasm", "wb").write(b)\n'
        + 'json.dump({"schema": "swu-arena-bot/1", "name": sys.argv[2], "lang": "wat", "protocol": 2, "kind": "wasm", "platform": "wasm32-wasip1",'
        + ' "runtime": "wasi-p1", "run": {"cmd": "./bot.wasm", "args": [], "env": {}}, "entry_sha256": hashlib.sha256(b).hexdigest(),'
        + ' "resources": {"memory_mb": 64}, "cards": {"use": "none"}, "network": "none"}, open(sys.argv[1] + "/arena.json", "w"))';
    const r = spawnSync('python3', ['-c', make, dir, name], { input: HI, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    for (const f of fs.readdirSync(dir)) {
        fs.chmodSync(path.join(dir, f), 0o644);
    }
    return dir;
}

/** run.py on a bundle with this cache, as root's caller or (as: [uid, gid]) as another user. */
function runPy(dir, cache, { warm = false, as = null } = {}) {
    const argv = ['python3', '-I', path.join(COMPILED, 'run.py'), ...(warm ? ['--warm'] : []), dir];
    const cmd = as ? ['setpriv', `--reuid=${as[0]}`, `--regid=${as[1]}`, '--clear-groups', '--', ...argv] : argv;
    return spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8', env: { PATH: process.env.PATH, LANG: 'C.UTF-8', SWU_WASM_CACHE: cache }, timeout: 60000 });
}

const entries = (cache) => fs.readdirSync(cache).sort();
const modeOf = (p) => fs.lstatSync(p).mode & 0o7777;

test('run.py: compiles into its own cache and reads it back; an entry others could have written is compiled again, never loaded', { skip }, () => {
    const dir = bundle();
    const cache = path.join(tmp, 'own-cache');
    let r = runPy(dir, cache, { warm: true });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /hi: compiled in/);
    assert.strictEqual(modeOf(cache), 0o755, 'a new cache folder only its owner writes');
    const [entry] = entries(cache);
    assert.match(entry, /^[0-9a-f]{64}\.cwasm$/);
    const file = path.join(cache, entry);
    assert.strictEqual(modeOf(file), 0o644);
    r = runPy(dir, cache, { warm: true });
    assert.match(r.stderr, /hi: cached in/);
    r = runPy(dir, cache);
    assert.deepStrictEqual([r.status, r.stdout], [0, 'hi\n'], r.stderr);

    // writable by the group: not loaded, compiled and replaced by a file only its owner writes
    fs.chmodSync(file, 0o664);
    r = runPy(dir, cache, { warm: true });
    assert.match(r.stderr, /hi: compiled in/);
    assert.strictEqual(modeOf(file), 0o644);

    // a link in its place is not followed: replaced, and what it pointed at stays as it was
    const elsewhere = path.join(tmp, 'elsewhere.cwasm');
    fs.copyFileSync(file, elsewhere);
    const before = fs.readFileSync(elsewhere);
    fs.rmSync(file);
    fs.symlinkSync(elsewhere, file);
    r = runPy(dir, cache, { warm: true });
    assert.match(r.stderr, /hi: compiled in/);
    assert.ok(fs.lstatSync(file).isFile(), 'a plain file again');
    assert.ok(fs.readFileSync(elsewhere).equals(before));
    assert.deepStrictEqual(entries(cache), [entry], 'no file left half written');
});

test('run.py: a cache folder others can write in, or a link to one, is not used: the bot runs from memory, and warm fails', { skip }, () => {
    const dir = bundle();
    for (const make of [
        (c) => { fs.mkdirSync(c); fs.chmodSync(c, 0o777); },
        (c) => { const real = `${c}-real`; fs.mkdirSync(real); fs.symlinkSync(real, c); }
    ]) {
        const cache = path.join(tmp, `open-cache-${crypto.randomBytes(4).toString('hex')}`);
        make(cache);
        let r = runPy(dir, cache);
        assert.deepStrictEqual([r.status, r.stdout], [0, 'hi\n'], r.stderr);
        assert.deepStrictEqual(entries(cache), [], 'nothing written');
        r = runPy(dir, cache, { warm: true });
        assert.strictEqual(r.status, 2);
        assert.match(r.stderr, /hi: could not keep the compiled code/);
    }
});

test('run.py as the bots\' user: it loads what root compiled into root\'s cache, never writes there, and never loads an entry of its own there', { skip: skip || (!(ROOT_USER && BOTS_USER) && 'needs root and a user arena') }, () => {
    const dir = bundle();
    const cache = path.join(tmp, 'root-cache');
    let r = runPy(dir, cache, { warm: true });
    assert.strictEqual(r.status, 0, r.stderr);
    const [entry] = entries(cache);
    const file = path.join(cache, entry);
    assert.deepStrictEqual([fs.lstatSync(cache).uid, fs.lstatSync(file).uid], [0, 0]);
    r = runPy(dir, cache, { warm: true, as: BOTS_USER });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /hi: cached in/, 'root\'s entry is loaded');
    r = runPy(dir, cache, { as: BOTS_USER });
    assert.deepStrictEqual([r.status, r.stdout], [0, 'hi\n'], r.stderr);

    // an entry of the bots' user in root's folder (how it got there does not matter) is not loaded: compiled again in
    // memory, and left as it is (the bots' user cannot replace it, and a warm by it fails)
    fs.chownSync(file, BOTS_USER[0], BOTS_USER[1]);
    const before = fs.readFileSync(file);
    r = runPy(dir, cache, { warm: true, as: BOTS_USER });
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /could not keep the compiled code/);
    r = runPy(dir, cache, { as: BOTS_USER });
    assert.deepStrictEqual([r.status, r.stdout], [0, 'hi\n'], r.stderr);
    assert.deepStrictEqual([entries(cache), fs.lstatSync(file).uid], [[entry], BOTS_USER[0]]);
    assert.ok(fs.readFileSync(file).equals(before));
    // root's next warm compiles it again and the entry is root's
    r = runPy(dir, cache, { warm: true });
    assert.match(r.stderr, /hi: compiled in/);
    assert.strictEqual(fs.lstatSync(file).uid, 0);

    // a cache folder the bots' user cannot make: no cache, the bot runs
    const parent = fs.mkdtempSync(path.join(tmp, 'roots-'));
    fs.chmodSync(parent, 0o755);
    r = runPy(dir, path.join(parent, 'cache'), { as: BOTS_USER });
    assert.deepStrictEqual([r.status, r.stdout, fs.readdirSync(parent)], [0, 'hi\n', []], r.stderr);
});

test('play-seed --warm --bundles: each tar checked against its sha256, compiled into the cache, named by its sha256', { skip }, () => {
    const dir = bundle();
    const tar = execFileSync('python3', ['-I', path.join(COMPILED, 'bundle.py'), 'tar', dir]);
    const hex = crypto.createHash('sha256').update(tar).digest('hex');
    const bundles = fs.mkdtempSync(path.join(tmp, 'bundles-'));
    fs.writeFileSync(path.join(bundles, `${hex}.tar`), tar);
    // a tar under another bundle's name does not pass its check
    const liar = 'f'.repeat(64);
    fs.writeFileSync(path.join(bundles, `${liar}.tar`), tar);
    const missing = 'e'.repeat(64);
    const cache = path.join(tmp, 'seed-cache');
    const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', SWU_WASM_CACHE: cache, TMPDIR: tmp };
    const run = (...args) => spawnSync(process.execPath, [PLAY_SEED, ...args], { encoding: 'utf8', env, timeout: 120000 });
    let r = run('--warm', '--bundles', bundles, hex, liar, missing, hex);
    assert.strictEqual(r.status, 0, r.stderr);
    const doc = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.deepStrictEqual([doc.ok, doc.warmed, doc.failed.map((f) => f.name)], [true, [hex], [liar, missing]]);
    assert.strictEqual(entries(cache).length, 1);
    assert.deepStrictEqual(fs.readdirSync(tmp).filter((f) => f.startsWith('warm-')), [], 'its unpacked bundles are gone');
    for (const bad of [['--warm', '--bundles', bundles, 'nothex'], ['--warm', '--bundles'], ['--bundles', bundles, hex, '--warm']]) {
        r = run(...bad);
        assert.strictEqual(r.status, 2, `${bad.join(' ')}: ${r.stderr}`);
    }
});
