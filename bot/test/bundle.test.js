'use strict';
// bot/compiled/bundle.py tar and unpack: the canonical tar a version's bundle travels in to a helper, and the checks
// unpack makes before it writes anything. Runs python3; no wasmtime or card data needed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const BUNDLE = path.join(ROOT, 'bot', 'compiled', 'bundle.py');
const NODE_RANDOM = path.join(ROOT, 'build', 'compiled', 'node-random');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const py = (...args) => spawnSync('python3', [BUNDLE, ...args], { maxBuffer: 80 << 20 });
let n = 0;
const fresh = () => path.join(tmp, `out-${++n}`);

test('bundle manifest requires protocol to be exactly the integer 2', () => {
    const dir = fresh();
    fs.mkdirSync(dir);
    // Validation reads this placeholder; it is never executed.
    fs.writeFileSync(path.join(dir, 'bot.wasm'), 'trusted nonexecuted fixture');
    const manifest = { schema: 'swu-arena-bot/1', kind: 'wasm', platform: 'wasm32-wasip1', runtime: 'wasi-p1', run: { cmd: './bot.wasm' } };
    for (const protocol of [undefined, 1, 3, '2', true, null, 2.5]) {
        fs.writeFileSync(path.join(dir, 'arena.json'), JSON.stringify({ ...manifest, protocol }));
        const r = py(dir);
        assert.strictEqual(r.status, 2, String(r.stderr));
        assert.match(String(r.stderr), protocol === undefined ? /missing 'protocol'/ : /protocol must be the integer 2/);
    }
    fs.writeFileSync(path.join(dir, 'arena.json'), JSON.stringify({ ...manifest, protocol: 2 }));
    assert.strictEqual(py(dir).status, 0);
});

// writes a tar from a list of entries ({name, type: file|dir|symlink|hardlink, data, mode, mtime, pax}) in the given format
const MAKE = `
import io, json, sys, tarfile
spec = json.loads(sys.argv[2])
fmt = {"ustar": tarfile.USTAR_FORMAT, "gnu": tarfile.GNU_FORMAT, "pax": tarfile.PAX_FORMAT}[spec["format"]]
with tarfile.open(sys.argv[1], "w", format=fmt) as tar:
    for e in spec["entries"]:
        info = tarfile.TarInfo(e["name"])
        info.mtime = e.get("mtime", 0)
        info.mode = e.get("mode", 0o755 if e["type"] == "dir" else 0o644)
        info.pax_headers = e.get("pax", {})
        data = e.get("data", "").encode()
        if e["type"] == "dir":
            info.type = tarfile.DIRTYPE
        elif e["type"] == "symlink":
            info.type = tarfile.SYMTYPE
            info.linkname = e["link"]
        elif e["type"] == "hardlink":
            info.type = tarfile.LNKTYPE
            info.linkname = e["link"]
        else:
            info.size = len(data)
        tar.addfile(info, io.BytesIO(data) if info.type == tarfile.REGTYPE else None)
`;

/** A crafted tar file: its path and sha256. */
function craft(entries, format = 'ustar') {
    const file = path.join(tmp, `crafted-${++n}.tar`);
    const r = spawnSync('python3', ['-c', MAKE, file, JSON.stringify({ format, entries })]);
    assert.strictEqual(r.status, 0, String(r.stderr));
    return { file, hex: sha(fs.readFileSync(file)) };
}

/** Unpacks a crafted tar under its own (right) hash: { code, err, dest }. */
function unpack({ file, hex }, dest = fresh()) {
    const r = py('unpack', file, dest, hex);
    return { code: r.status, err: String(r.stderr).trim(), dest };
}

test('tar and unpack round-trip a real bundle, and the old command line still prints its id', { skip: !fs.existsSync(NODE_RANDOM) && 'no build/compiled/node-random' }, () => {
    const tar = py('tar', NODE_RANDOM);
    assert.strictEqual(tar.status, 0, String(tar.stderr));
    const file = path.join(tmp, 'node-random.tar');
    fs.writeFileSync(file, tar.stdout);
    const hex = sha(tar.stdout);
    const ids = py(NODE_RANDOM);
    assert.strictEqual(ids.status, 0);
    assert.match(String(ids.stdout), new RegExp(`node-random +sha256:${hex}  tar ${tar.stdout.length} B`));

    const dest = fresh();
    const r = py('unpack', file, dest, hex);
    assert.strictEqual(r.status, 0, String(r.stderr));
    for (const f of fs.readdirSync(NODE_RANDOM)) {
        assert.ok(fs.readFileSync(path.join(dest, f)).equals(fs.readFileSync(path.join(NODE_RANDOM, f))), f);
        assert.strictEqual(fs.statSync(path.join(dest, f)).mode & 0o777, 0o644);
    }
    assert.strictEqual(fs.statSync(dest).mode & 0o777, 0o755);
    assert.ok(py('tar', dest).stdout.equals(tar.stdout), 'the folder packs to the same tar');

    // dest must not exist yet; the tar must hash to the id it is unpacked as
    const again = py('unpack', file, dest, hex);
    assert.strictEqual(again.status, 2);
    assert.match(String(again.stderr), /already exists/);
    const wrong = py('unpack', file, fresh(), 'ab'.repeat(32));
    assert.strictEqual(wrong.status, 2);
    assert.match(String(wrong.stderr), /sha256 is not/);
});

test('a canonical tar of nested folders and an executable round-trips', () => {
    const src = path.join(tmp, 'nested');
    fs.mkdirSync(path.join(src, 'lib', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(src, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(src, 'lib', 'deep', 'x.txt'), 'x');
    fs.writeFileSync(path.join(src, 'lib-a.txt'), 'sorted between lib and lib/');
    const tar = py('tar', src).stdout;
    const file = path.join(tmp, 'nested.tar');
    fs.writeFileSync(file, tar);
    const r = unpack({ file, hex: sha(tar) });
    assert.strictEqual(r.code, 0, r.err);
    assert.strictEqual(fs.statSync(path.join(r.dest, 'run.sh')).mode & 0o777, 0o755);
    assert.strictEqual(fs.readFileSync(path.join(r.dest, 'lib', 'deep', 'x.txt'), 'utf8'), 'x');
    assert.ok(py('tar', r.dest).stdout.equals(tar));
});

test('tar refuses what is not a folder of plain files and folders', () => {
    assert.strictEqual(py('tar', path.join(tmp, 'missing')).status, 2);
    const src = path.join(tmp, 'linked');
    fs.mkdirSync(src);
    fs.symlinkSync('/etc/passwd', path.join(src, 'pw'));
    const r = py('tar', src);
    assert.strictEqual(r.status, 2);
    assert.match(String(r.stderr), /only regular files and folders/);
});

test('unpack refuses links, names that leave the folder, duplicates and anything but ustar files and folders', () => {
    const cases = {
        'a symlink': [[{ name: 'pw', type: 'symlink', link: '/etc/passwd' }], /only regular files and folders/],
        'a hard link': [[{ name: 'a', type: 'file', data: 'x' }, { name: 'b', type: 'hardlink', link: 'a' }], /only regular files and folders/],
        'a .. name': [[{ name: '../evil', type: 'file', data: 'x' }], /'\.\.' path segment/],
        'a .. inside a name': [[{ name: 'a', type: 'dir' }, { name: 'a/../../evil', type: 'file', data: 'x' }], /'\.\.' path segment/],
        'an absolute name': [[{ name: '/tmp/evil', type: 'file', data: 'x' }], /path segment|stay inside/],
        'a . segment': [[{ name: './x', type: 'file', data: 'x' }], /'\.' or/],
        'a duplicate name': [[{ name: 'x', type: 'file', data: 'one' }, { name: 'x', type: 'file', data: 'two' }], /appears twice/],
        'a file whose folder is not listed before it': [[{ name: 'lib/x', type: 'file', data: 'x' }], /its folder is not in the tar before it/],
        'a file mode other than 644 or 755': [[{ name: 'x', type: 'file', data: 'x', mode: 0o4755 }], /file mode 4755/],
        'a folder mode other than 755': [[{ name: 'd', type: 'dir', mode: 0o777 }], /folder mode 777/]
    };
    for (const [why, [entries, msg]] of Object.entries(cases)) {
        const r = unpack(craft(entries));
        assert.strictEqual(r.code, 2, `${why}: ${r.err}`);
        assert.match(r.err, msg, why);
        assert.ok(!fs.existsSync(r.dest), `${why}: nothing is made`);
    }
    // a GNU header, and pax records (a pax tar without any is plain ustar)
    for (const [format, entry] of [['gnu', {}], ['pax', { pax: { comment: 'x' } }]]) {
        const r = unpack(craft([{ name: 'x', type: 'file', data: 'x', ...entry }], format));
        assert.strictEqual(r.code, 2, format);
        assert.match(r.err, /only ustar entries/, format);
    }
    assert.ok(!fs.existsSync('/tmp/evil'));
});

test('unpack removes what it made when the folder does not pack back to the same tar', () => {
    // entries out of order, a nonzero mtime: each unpacks cleanly but is not the canonical tar of the result
    for (const entries of [[{ name: 'b', type: 'file', data: 'b' }, { name: 'a', type: 'file', data: 'a' }], [{ name: 'a', type: 'file', data: 'a', mtime: 5 }]]) {
        const r = unpack(craft(entries));
        assert.strictEqual(r.code, 2, r.err);
        assert.match(r.err, /does not pack back/);
        assert.ok(!fs.existsSync(r.dest));
    }
    const ok = unpack(craft([{ name: 'a', type: 'file', data: 'a' }, { name: 'b', type: 'file', data: 'b' }]));
    assert.strictEqual(ok.code, 0, ok.err);
});
