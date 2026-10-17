'use strict';
/**
 * Read-only discovery of bundles already available to this person through the arena's latest-round lineup.
 * Only current lineup entries are inspected; no private submission/source history is traversed, no archive is
 * extracted, and no downloaded code is started. Compatibility evidence must belong to that exact bundle/context.
 * `allowed(who)` must enforce the configured tables-bot access, including OAuth identities, before any relay read.
 */
const crypto = require('crypto');
const TOOLCHAIN = require('../compiled/toolchain.json');
const { compatibilityStatus } = require('./compatibility');
const { contextMatches } = require('./identity');

const HEX = /^[0-9a-f]{64}$/;
const VERSION = /^[a-z][a-z0-9_]{0,31}-v\d+$/;
const MAX_BYTES = 64 << 20;
const MAX_TAR_BYTES = MAX_BYTES + (4 << 20);
const MAX_MANIFEST_BYTES = 64 << 10;
const RUNTIMES = new Set(['wasi-p1', ...Object.keys(TOOLCHAIN.runtimes)]);
const USTAR = Buffer.from([117, 115, 116, 97, 114, 0, 48, 48]);
const FORBIDDEN_ENV = ['LD_', 'PYTHONHASHSEED', 'SWU_ARENA_', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'];
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const safePath = (name) => typeof name === 'string' && name.length > 0 && !name.includes('\\') && !name.includes('\0')
    && !name.startsWith('/') && !name.split('/').some((p) => !p || p === '.' || p === '..' || p.startsWith('.git'));

/** Read plain ustar members in memory. Extraction still belongs to bundle.py unpack, which checks canonical form. */
function members(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1024 || bytes.length > MAX_TAR_BYTES || bytes.length % 512) return null;
    const out = new Map();
    const folders = new Set(['']);
    const dec = new TextDecoder('utf-8', { fatal: true });
    const field = (h, start, length) => dec.decode(h.subarray(start, start + length)).split('\0', 1)[0];
    const octal = (s) => /^[0-7]+$/.test(s.trim()) ? Number.parseInt(s.trim(), 8) : NaN;
    let total = 0;
    let previous = null;
    try {
        for (let off = 0, count = 0; off + 512 <= bytes.length;) {
            const h = bytes.subarray(off, off + 512);
            if (h.every((x) => x === 0)) {
                return bytes.length - off >= 1024 && bytes.subarray(off).every((x) => x === 0) ? out : null;
            }
            if (++count > 2000 || !h.subarray(257, 265).equals(USTAR)) return null;
            const checksum = octal(field(h, 148, 8));
            const sum = h.reduce((n, value, i) => n + (i >= 148 && i < 156 ? 32 : value), 0);
            if (checksum !== sum) return null;
            const type = h[156];
            if (type !== 48 && type !== 53) return null;
            const prefix = field(h, 345, 155);
            const rawName = `${prefix ? `${prefix}/` : ''}${field(h, 0, 100)}`;
            const name = type === 53 ? rawName.replace(/\/$/, '') : rawName;
            const size = octal(field(h, 124, 12));
            const mode = octal(field(h, 100, 8));
            if (!safePath(name) || Buffer.byteLength(name) > 255 || out.has(name) || folders.has(name)
                || !folders.has(name.slice(0, Math.max(0, name.lastIndexOf('/'))))
                || previous !== null && Buffer.compare(Buffer.from(previous), Buffer.from(name)) >= 0
                || octal(field(h, 108, 8)) !== 0 || octal(field(h, 116, 8)) !== 0 || octal(field(h, 136, 12)) !== 0
                || field(h, 157, 100) || field(h, 265, 32) || field(h, 297, 32)
                || !Number.isSafeInteger(size) || size < 0 || (type === 53 ? size !== 0 || mode !== 0o755 : mode !== 0o644 && mode !== 0o755)) return null;
            previous = name;
            off += 512;
            const padded = Math.ceil(size / 512) * 512;
            if (off + padded > bytes.length || !bytes.subarray(off + size, off + padded).every((x) => x === 0)) return null;
            if (type === 53) {
                folders.add(name);
            } else {
                total += size;
                if (total > MAX_BYTES || (name === 'arena.json' && size > MAX_MANIFEST_BYTES)) return null;
                out.set(name, bytes.subarray(off, off + size));
            }
            off += padded;
        }
    } catch {
        return null;
    }
    return null;
}

/** Static compatibility only: a manifest claim does not execute or recheck the bot's ready handshake. */
function compatible(bytes, hex) {
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_TAR_BYTES || sha256(bytes) !== hex) return null;
    const files = members(bytes);
    if (!files?.has('arena.json')) return null;
    let m;
    try { m = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(files.get('arena.json'))); } catch { return null; }
    if (!object(m) || m.schema !== 'swu-arena-bot/1' || m.protocol !== 2 || m.kind !== 'wasm' || m.platform !== 'wasm32-wasip1'
        || !RUNTIMES.has(m.runtime) || (m.network !== undefined && m.network !== 'none') || m.cards?.use === 'mount' || !object(m.run)
        || typeof m.run.cmd !== 'string' || (m.run.args !== undefined && (!Array.isArray(m.run.args) || !m.run.args.every((a) => typeof a === 'string')))
        || (m.run.env !== undefined && (!object(m.run.env) || Object.entries(m.run.env).some(([k, v]) => typeof v !== 'string' || FORBIDDEN_ENV.some((p) => k.startsWith(p)))))) return null;
    // Interpreter runtimes execute args[0]; keep bundle.entry_file() and run.py in agreement.
    if (m.runtime !== 'wasi-p1' && (m.run.cmd.startsWith('./') || !m.run.args?.length)) return null;
    let entry = m.run.cmd.startsWith('./') ? m.run.cmd.slice(2) : m.run.args?.[0];
    if (entry?.startsWith('./')) entry = entry.slice(2);
    if (!safePath(entry) || !files.has(entry)) return null;
    if (m.runtime === 'wasi-p1' && !files.get(entry).subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))) return null;
    if (m.entry_sha256 !== undefined && (typeof m.entry_sha256 !== 'string' || !HEX.test(m.entry_sha256) || sha256(files.get(entry)) !== m.entry_sha256)) return null;
    return m;
}

function contextOf(value) {
    if (!contextMatches(value, value)) return null;
    return { schema: 1, arenaId: value.arenaId, protocol: 2, engineRevision: value.engineRevision, runnerRevision: value.runnerRevision };
}

function createOpponents({ swarm, allowed = () => false, compatibility = () => null, context = () => null } = {}) {
    const authorize = async (who) => {
        if (!await allowed(who)) fail('forbidden', 'opponent downloads require access to the arena tables');
    };
    const lineup = async () => {
        let data;
        try { data = await swarm?.lineup?.(); } catch { /* do not expose the helper's error or credentials */ }
        if (!object(data) || !Array.isArray(data.bots)) fail('unavailable', 'the latest arena lineup is unavailable; try again later');
        return data;
    };
    const activeContext = async () => {
        let value;
        try { value = contextOf(await context()); } catch { /* no active trusted context */ }
        if (!value) fail('unavailable', 'the arena has no verified protocol v2 context');
        return value;
    };
    const eligible = (b) => object(b) && typeof b.name === 'string' && VERSION.test(b.name)
        && typeof b.bundle === 'string' && HEX.test(b.bundle)
        && (b.bytes === undefined || b.bytes === null || Number.isSafeInteger(b.bytes) && b.bytes > 0 && b.bytes <= MAX_TAR_BYTES);
    const roundOf = (data) => Number.isSafeInteger(data.round) && data.round >= 0 ? data.round : null;
    const inspect = async (data, b, active) => {
        let observed;
        try { observed = await compatibility(b.name); } catch { return null; }
        const checkedContext = contextOf(observed?.context);
        if (!checkedContext || !contextMatches(checkedContext, active)) return null;
        const status = compatibilityStatus(observed, { bundleSha256: b.bundle, context: active });
        if (!status.compatible) return null;
        const checked = { schema: observed.schema, negotiatedProtocol: observed.negotiatedProtocol, bundleSha256: observed.bundleSha256,
            checkerBuild: observed.checkerBuild, checkedAt: new Date(observed.checkedAt).toISOString(), context: checkedContext };
        let tar;
        try { tar = await swarm?.readBot?.(b.bundle); } catch { return null; }
        if (!Buffer.isBuffer(tar) || (Number.isSafeInteger(b.bytes) && b.bytes !== tar.length)) return null;
        const m = compatible(tar, b.bundle);
        if (!m) return null;
        const provenance = { source: 'latest_round', round: roundOf(data) };
        if (typeof m.build?.commit === 'string' && /^[0-9a-f]{7,64}$/.test(m.build.commit)) provenance.commit = m.build.commit;
        if (typeof m.build?.toolchain === 'string' && /^[A-Za-z][A-Za-z0-9_.+-]{0,39}(?: [0-9][A-Za-z0-9_.+-]{0,38})?$/.test(m.build.toolchain)) provenance.toolchain = m.build.toolchain;
        return { descriptor: { name: b.name, sha256: b.bundle, bytes: tar.length, protocol: 2, runtime: m.runtime, context: active, compatibility: checked,
            url: `/api/opponents/${b.bundle}.tar`, provenance }, tar };
    };
    async function find(who, options = {}) {
        await authorize(who);
        if (!object(options)) fail('bad_request', 'provide the opponent sha256 from arena_opponents');
        const { name, sha256: hex } = options;
        if (typeof hex !== 'string' || !HEX.test(hex) || (name !== undefined && (typeof name !== 'string' || !VERSION.test(name)))) {
            fail('bad_request', 'provide a lowercase sha256 from arena_opponents, with an optional exact version name');
        }
        const active = await activeContext();
        const data = await lineup();
        const b = data.bots.find((x) => eligible(x) && x.bundle === hex && (name === undefined || x.name === name));
        if (!b) fail('not_found', 'not an eligible opponent in the latest arena lineup');
        const found = await inspect(data, b, active);
        if (!found) fail('unavailable', 'this opponent bundle is unavailable or incompatible; refresh arena_opponents');
        return found;
    }
    async function list(who) {
        await authorize(who);
        const active = await activeContext();
        const data = await lineup();
        const opponents = [];
        for (const b of data.bots) {
            if (!eligible(b)) continue;
            const found = await inspect(data, b, active).catch(() => null);
            if (found) opponents.push(found.descriptor);
        }
        return { context: active, round: roundOf(data), capMs: Number.isSafeInteger(data.capMs) && data.capMs >= 1000 ? data.capMs : null,
            at: typeof data.at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(data.at) ? data.at : null, opponents };
    }
    return { list, get: async (who, options) => (await find(who, options)).descriptor,
        bytes: async (who, hex) => (await find(who, { sha256: hex })).tar };
}

module.exports = { createOpponents };
