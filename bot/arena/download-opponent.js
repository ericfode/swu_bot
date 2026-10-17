#!/usr/bin/env node
'use strict';
// Downloads data only. Bundle validation reuses bundle.py; no Wasmtime, intake start-check or runner is loaded.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const BUNDLE = path.join(__dirname, '..', 'compiled', 'bundle.py');
const TOOLCHAIN = require('../compiled/toolchain.json');
const MAX_BYTES = 68 << 20; // bundle.py unpack: 64 MiB files + 4 MiB headers
const HEX = /^[0-9a-f]{64}$/;
const NAME = /^[a-z][a-z0-9_]{0,31}-v\d+$/;
const USAGE = 'node bot/arena/download-opponent.js --arena https://swu-arena.fly.dev --name <catalog-name> --sha256 <catalog-hash> --out ../opponents\nUses the existing ARENA_TOKEN OAuth token from the environment. Downloads, verifies and unpacks only; never runs a bot.';
const need = (ok, message) => { if (!ok) throw new Error(message); };

function arenaUrl(value) {
    const u = new URL(value);
    need(!u.username && !u.password && !u.search && !u.hash && u.pathname === '/', 'arena must be an origin without credentials, path, query or fragment');
    need(u.protocol === 'https:' || u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname), 'use HTTPS (HTTP only for loopback tests)');
    return u.origin;
}

async function bounded(response, max) {
    need(response.ok, `download refused (HTTP ${response.status}); check existing sign-in and current catalog`);
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > max)) {
        await response.body?.cancel();
        throw new Error('download exceeds the size limit');
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body ?? []) {
        bytes += chunk.length;
        need(bytes <= max, 'download exceeds the size limit');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

function manifestCheck(m) {
    need(m?.schema === 'swu-arena-bot/1' && m.protocol === 2 && m.kind === 'wasm' && m.platform === 'wasm32-wasip1', 'download is not a protocol 2 WASI bundle');
    need(m.runtime === 'wasi-p1' || Object.hasOwn(TOOLCHAIN.runtimes, m.runtime), 'bundle runtime is unsupported by this checkout');
    need((m.network ?? 'none') === 'none' && m.cards?.use !== 'mount', 'bundle requests unavailable network or mounted cards');
}

function python(args) {
    // Data validators receive no arena/service credentials or Python import hooks.
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'TMPDIR', 'LANG'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
    const r = spawnSync('python3', ['-I', BUNDLE, ...args], { encoding: 'utf8', env, timeout: 60000, maxBuffer: 1 << 20 });
    need(r.status === 0, `bundle validation failed: ${(r.stderr || r.error?.message || 'python3 unavailable').slice(0, 2000).trim()}`);
}

async function downloadOpponent({ arena, name, sha256, out, token = process.env.ARENA_TOKEN, fetchImpl = globalThis.fetch }) {
    const origin = arenaUrl(arena);
    need(NAME.test(name) && HEX.test(sha256), 'name and sha256 must exactly match an arena_opponents entry');
    need(typeof out === 'string' && out.length > 0, 'out: a local opponents directory');
    need(typeof token === 'string' && token.length > 0 && !/[\r\n]/.test(token), 'connect normally and supply your existing OAuth token as ARENA_TOKEN');
    const headers = { authorization: `Bearer ${token}` };
    const request = (url) => fetchImpl(url, { headers, redirect: 'error', signal: AbortSignal.timeout(120000) });
    const query = new URLSearchParams({ name, sha256 });
    const reply = JSON.parse((await bounded(await request(`${origin}/api/opponents?${query}`), 256 << 10)).toString('utf8'));
    const d = reply.result;
    need(d?.name === name && d.sha256 === sha256 && d.protocol === 2 && Number.isSafeInteger(d.bytes) && d.bytes > 0 && d.bytes <= MAX_BYTES, 'catalog descriptor changed or is incompatible; refresh arena_opponents');
    const expected = `/api/opponents/${sha256}.tar`;
    need(d.url === expected, 'catalog download URL is not the expected same-origin bundle path');
    const data = await bounded(await request(`${origin}${expected}`), MAX_BYTES);
    need(data.length === d.bytes && crypto.createHash('sha256').update(data).digest('hex') === sha256, 'download size or SHA256 mismatch; discard and refresh the catalog');

    // Server-controlled paths are never used as filesystem paths. Work happens inside one user-selected root.
    const root = path.resolve(out);
    need(!fs.lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink(), 'out must not be a symlink');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const realRoot = fs.realpathSync(root);
    const final = path.join(realRoot, `${name}-${sha256}`);
    need(!fs.existsSync(final), 'that exact opponent already exists; use its saved bundle or a new output directory');
    const temp = fs.mkdtempSync(path.join(realRoot, '.download-'));
    const folder = path.join(temp, name);
    let madeFinal = false;
    try {
        const tar = path.join(temp, 'bundle.tar');
        fs.writeFileSync(tar, data, { flag: 'wx', mode: 0o600 });
        python(['unpack', tar, folder, sha256]);
        python([folder]);
        manifestCheck(JSON.parse(fs.readFileSync(path.join(folder, 'arena.json'), 'utf8')));
        const provenance = { origin, name, sha256, bytes: data.length, protocol: 2, downloadedAt: new Date().toISOString(), provenance: d.provenance ?? null,
            compatibility: d.compatibility ?? null, context: d.context ?? null, executed: false };
        fs.writeFileSync(path.join(temp, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        fs.mkdirSync(final, { mode: 0o700 }); // exclusive: never replace an existing download
        madeFinal = true;
        fs.renameSync(folder, path.join(final, name));
        fs.renameSync(path.join(temp, 'provenance.json'), path.join(final, 'provenance.json'));
        return { ...provenance, folder: path.join(final, name), record: path.join(final, 'provenance.json') };
    } catch (e) {
        if (madeFinal) fs.rmSync(final, { recursive: true, force: true });
        throw e;
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
}

function parseArgs(argv) {
    if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return null;
    const out = {};
    for (let i = 0; i < argv.length; i += 2) {
        const k = argv[i]?.slice(2);
        need(argv[i]?.startsWith('--') && ['arena', 'name', 'sha256', 'out'].includes(k) && !Object.hasOwn(out, k) && argv[i + 1] && !argv[i + 1].startsWith('--'), USAGE);
        out[k] = argv[i + 1];
    }
    need(['arena', 'name', 'sha256', 'out'].every((k) => out[k]), USAGE);
    return out;
}

if (require.main === module) {
    Promise.resolve().then(() => {
        const args = parseArgs(process.argv.slice(2));
        return args ? downloadOpponent(args).then((r) => console.log(JSON.stringify(r, null, 2))) : console.log(USAGE);
    }).catch((e) => { console.error(e.message); process.exitCode = 1; });
}

module.exports = { downloadOpponent, parseArgs, arenaUrl, manifestCheck, MAX_BYTES };
