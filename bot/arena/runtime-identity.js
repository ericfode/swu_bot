'use strict';
// A controller release may retain an engine identity only on the exact pinned runtime and reviewed source transition.
// No environment alias, mutable-volume file, historical record rewrite or arbitrary context allowlist is accepted.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const HASH = /^[0-9a-f]{64}$/;
const BUILD = /^[0-9a-f]{40}$/;
const canonical = (x) => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object'
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canonical(x[k])])) : x;
const hash = (x) => crypto.createHash('sha256').update(Buffer.isBuffer(x) || typeof x === 'string' ? x : JSON.stringify(canonical(x))).digest('hex');
const policyOf = () => require('./compatible-runtime.json');
const text = (root, file) => fs.readFileSync(path.join(root, file), 'utf8').trim();
const ignored = (p) => p === 'bot/arena/compatible-runtime.json' || p.startsWith('bot/test/') || p.endsWith('.md')
    || p.split('/').some((x) => ['.git', '__pycache__', 'node_modules'].includes(x));
const ROOTS = ['package.json', 'server/package.json', 'server/package-lock.json', 'server/src', 'bot', 'vendor/kessel', 'vendor/jepa'];
function sourceFiles(root) {
    const found = {};
    const walk = (rel) => {
        if (ignored(rel)) return;
        const file = path.join(root, rel), st = fs.lstatSync(file);
        if (st.isSymbolicLink()) throw new Error(`runtime source must not be a symlink: ${rel}`);
        if (st.isDirectory()) { for (const n of fs.readdirSync(file).sort()) walk(`${rel}/${n}`); }
        else if (st.isFile()) found[rel] = { sha256: hash(fs.readFileSync(file)), executable: !!(st.mode & 0o111) };
        else throw new Error(`runtime source is not a regular file: ${rel}`);
    };
    for (const rel of ROOTS) walk(rel);
    return canonical(found);
}
function checkPolicy(p) {
    if (p?.schema !== 'swu-compatible-runtime/1' || !BUILD.test(p.baseBuild ?? '') || !HASH.test(p.cards ?? '')
        || !HASH.test(p.baseSourceSha256 ?? '') || !BUILD.test(p.engineRef ?? '')
        || !/^registry\.fly\.io\/swu-arena-games@sha256:[0-9a-f]{64}$/.test(p.baseImage ?? '')
        || !Array.isArray(p.requiredCore) || !p.requiredCore.length || !p.changes || typeof p.changes !== 'object') throw new Error('invalid immutable runtime transition');
    for (const [name, change] of Object.entries(p.changes)) {
        if (!/^(bot|server\/src)\/[a-zA-Z0-9_./-]+$/.test(name) || name.split('/').includes('..')
            || !(change.before === null || HASH.test(change.before ?? '')) || !HASH.test(change.after ?? '')) throw new Error('invalid reviewed controller file');
    }
    if (p.requiredCore.some((n) => p.changes[n])) throw new Error('a required execution component cannot be a controller exception');
    return p;
}
function capture(root, policy = policyOf()) {
    const p = checkPolicy(policy);
    if (text(root, 'BUILD_SHA') !== p.baseBuild || text(root, 'CARDS_SHA') !== p.cards) throw new Error('the base image build/cards do not match the reviewed runtime');
    const files = sourceFiles(root);
    if (hash(files) !== p.baseSourceSha256) throw new Error('the pinned base source differs from the historical source fingerprint');
    if (p.requiredCore.some((n) => !files[n])) throw new Error('the pinned image lacks a required execution component');
    return { schema: 'swu-runtime-baseline/1', baseBuild: p.baseBuild, cards: p.cards, policySha256: hash(p), files };
}
function seal(root, source, baseline, { build, engineRef, policy = policyOf() }) {
    const p = checkPolicy(policy);
    if (!BUILD.test(build ?? '') || build === p.baseBuild || engineRef !== p.engineRef) throw new Error('a new controller build and the unchanged engine pin are required');
    if (baseline?.schema !== 'swu-runtime-baseline/1' || baseline.baseBuild !== p.baseBuild || baseline.cards !== p.cards
        || baseline.policySha256 !== hash(p) || hash(baseline.files) !== p.baseSourceSha256) throw new Error('the captured immutable runtime baseline differs');
    if (text(root, 'CARDS_SHA') !== p.cards) throw new Error('card data identity changed');
    const current = sourceFiles(root), requested = sourceFiles(source);
    if (hash(current) !== hash(requested)) throw new Error('the overlay differs from the checked source (including removed files)');
    const changed = Object.keys({ ...baseline.files, ...current }).filter((n) => JSON.stringify(baseline.files[n]) !== JSON.stringify(current[n]));
    if (JSON.stringify(changed.sort()) !== JSON.stringify(Object.keys(p.changes).sort())) throw new Error('an unreviewed runtime component changed');
    for (const [n, c] of Object.entries(p.changes)) {
        if ((baseline.files[n]?.sha256 ?? null) !== c.before || current[n]?.sha256 !== c.after) throw new Error(`controller transition differs: ${n}`);
        if (baseline.files[n] && baseline.files[n].executable !== current[n].executable) throw new Error(`controller execution mode changed: ${n}`);
    }
    const core = (files) => Object.fromEntries(Object.entries(files).filter(([n]) => !p.changes[n]));
    if (hash(core(current)) !== hash(core(baseline.files))) throw new Error('execution components changed');
    const proof = { schema: 'swu-runtime-identity/1', controllerBuild: build, engineBuild: p.baseBuild, cards: p.cards,
        baseImage: p.baseImage, engineRef, policySha256: hash(p), sourceSha256: hash(current), coreSha256: hash(core(current)) };
    fs.writeFileSync(path.join(root, 'ENGINE_IDENTITY.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
    fs.writeFileSync(path.join(root, 'BUILD_SHA'), build + '\n');
    return proof;
}
function engineBuild(root, build, cards, { full = false, policy = policyOf() } = {}) {
    const p = checkPolicy(policy);
    const proof = JSON.parse(fs.readFileSync(path.join(root, 'ENGINE_IDENTITY.json'), 'utf8'));
    if (proof.schema !== 'swu-runtime-identity/1' || proof.controllerBuild !== build || !BUILD.test(build ?? '')
        || proof.engineBuild !== p.baseBuild || cards !== p.cards || proof.cards !== cards || proof.baseImage !== p.baseImage
        || proof.engineRef !== p.engineRef || proof.policySha256 !== hash(p) || !HASH.test(proof.sourceSha256 ?? '')
        || !HASH.test(proof.coreSha256 ?? '')) throw new Error('immutable engine lineage does not match the actual image/build/cards');
    // Controller source is small; validate it on every context read. The complete preserved core is checked at build
    // and before the container starts, and stays in the immutable image rather than on the mounted data volume.
    for (const [n, c] of Object.entries(p.changes)) if (hash(fs.readFileSync(path.join(root, n))) !== c.after) throw new Error(`controller source differs: ${n}`);
    if (full) {
        const files = sourceFiles(root);
        const core = Object.fromEntries(Object.entries(files).filter(([n]) => !p.changes[n]));
        if (hash(files) !== proof.sourceSha256 || hash(core) !== proof.coreSha256) throw new Error('the preserved execution source differs');
    }
    return proof.engineBuild;
}
module.exports = { sourceFiles, capture, seal, engineBuild, hash, canonical, ignored, ROOTS };
if (require.main === module) {
    const [op, root = '/app', ...args] = process.argv.slice(2);
    const flag = (name) => { const i = args.indexOf(name); if (i < 0 || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${name} is required`); return args[i + 1]; };
    try {
        let out;
        if (op === 'capture') {
            out = capture(root); fs.writeFileSync(flag('--out'), JSON.stringify(out));
        } else if (op === 'seal') {
            out = seal(root, flag('--source'), JSON.parse(fs.readFileSync(flag('--baseline'), 'utf8')), { build: flag('--build'), engineRef: flag('--engine-ref') });
        } else if (op === 'verify') {
            out = { engineBuild: engineBuild(root, text(root, 'BUILD_SHA'), text(root, 'CARDS_SHA'), { full: true }) };
        } else throw new Error('usage: runtime-identity.js capture|seal|verify <image root>');
        console.log(JSON.stringify(op === 'capture' ? { captured: true, files: Object.keys(out.files).length } : out));
    } catch (e) { console.error(`runtime identity: ${e.message}`); process.exitCode = 1; }
}
