#!/usr/bin/env node
'use strict';
// Rebuilds a vendored dependency from its own repository at one commit and writes its VERSION.json (vendor/README.md):
//
//   node vendor/refresh.js kessel <kessel clone> <commit>       # vendor/kessel: the JS adapter and the Node package
//   node vendor/refresh.js holotable <holotable clone> <commit> # vendor/holotable: the viewer kit
//   node vendor/refresh.js jepa <holocron clone> <commit>       # vendor/jepa: the JEPA bot in JavaScript and its models
//
// The commit is exported with git archive into a temporary folder and built there, so the clone is never touched.
// Kessel needs cargo, rustup and the wasm32-unknown-unknown target; its build.js installs the wasm-bindgen it pins
// (or set WASM_BINDGEN to that version). Holotable needs npm and the registry; the JEPA bot builds nothing. Run from
// anywhere; Node 22.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const notices = require('./notices');

const VENDOR = __dirname;
const ROOT = path.join(VENDOR, '..');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const TARGETS = {
    kessel: {
        repo: 'https://github.com/ericfode/kessel',
        build(src) {
            // drop the temporary folder's and cargo's paths from panic messages, so the same commit builds the same bytes
            const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), '.cargo');
            const rustflags = `--remap-path-prefix=${src}=/kessel --remap-path-prefix=${cargoHome}=/cargo`;
            run(process.execPath, ['crates/kessel-wasm/build.js', '--target', 'node', '--install-tools'], { cwd: src, env: { ...process.env, RUSTFLAGS: rustflags } });
            const built = JSON.parse(fs.readFileSync(path.join(src, 'crates/kessel-wasm/pkg/build.json'), 'utf8'));
            const files = { 'js/node.js': 'crates/kessel-wasm/js/node.js', 'js/adapter.mjs': 'crates/kessel-wasm/js/adapter.mjs' };
            for (const f of fs.readdirSync(path.join(src, 'crates/kessel-wasm/pkg/node'))) {
                files[`pkg/node/${f}`] = `crates/kessel-wasm/pkg/node/${f}`;
            }
            return {
                files,
                about: {
                    rustc: built.rustc, wasmBindgen: built.wasmBindgen, profile: built.profile,
                    built: "RUSTFLAGS='--remap-path-prefix=<src>=/kessel --remap-path-prefix=<cargo home>=/cargo' node crates/kessel-wasm/build.js --target node --install-tools"
                }
            };
        }
    },
    holotable: {
        repo: 'https://github.com/ericfode/holotable',
        build(src) {
            run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: src });
            // the Strategy Atlas kit stays in this repo (meta/atlas-kit.js); the viewer kit bundles it
            run('npm', ['run', 'build:kit'], { cwd: src, env: { ...process.env, ATLAS_KIT: path.join(ROOT, 'meta', 'atlas-kit.js') } });
            return { files: { 'swu-viewer-kit.js': 'dist-kit/swu-viewer-kit.js' }, about: { built: 'npm ci && ATLAS_KIT=<swu_bot>/meta/atlas-kit.js npm run build:kit', atlasKitSha256: sha256(path.join(ROOT, 'meta', 'atlas-kit.js')) } };
        }
    },
    jepa: {
        repo: 'https://github.com/ericfode/holocron',
        build() {
            // jepa-tx-gate (holocron bots/external-bots.json): the player and its two models, nothing to build
            const files = { 'jepa.js': 'bots/jepa/js/jepa.js' };
            for (const m of ['tx-t10.safetensors', 'tx-t10-e.safetensors']) {
                files[m] = `bots/jepa/models/${m}`;
            }
            return { files, about: { bot: 'jepa-tx-gate', built: 'copied as they are' } };
        }
    }
};

function main([name, clone, commit]) {
    const target = TARGETS[name];
    if (!target || !clone || !commit) {
        throw new Error('usage: node vendor/refresh.js kessel|holotable|jepa <clone> <commit>');
    }
    const full = execFileSync('git', ['-C', clone, 'rev-parse', '--verify', `${commit}^{commit}`], { encoding: 'utf8' }).trim();
    const src = fs.mkdtempSync(path.join(os.tmpdir(), `vendor-${name}-`));
    try {
        execFileSync('sh', ['-c', 'git -C "$1" archive "$2" | tar -x -C "$3"', 'sh', clone, full, src]);
        const { files, about } = target.build(src);
        const notice = notices.render(name, target.repo, full, notices.list(name, src, ROOT));
        const out = path.join(VENDOR, name);
        fs.rmSync(out, { recursive: true, force: true });
        const version = { name, repo: target.repo, commit: full, ...about, files: {} };
        for (const [to, from] of Object.entries(files).sort()) {
            fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true });
            fs.copyFileSync(path.join(src, from), path.join(out, to));
            version.files[to] = { from, bytes: fs.statSync(path.join(out, to)).size, sha256: sha256(path.join(out, to)) };
        }
        fs.writeFileSync(path.join(out, 'VERSION.json'), `${JSON.stringify(version, null, 2)}\n`);
        // outside vendor/<name>/, so a change to the notices alone deploys nothing
        fs.mkdirSync(path.join(VENDOR, 'notices'), { recursive: true });
        fs.writeFileSync(path.join(VENDOR, 'notices', `${name}.md`), notice);
        console.log(`vendor/${name}: ${Object.keys(files).length} files from ${name} ${full.slice(0, 7)}`);
    } finally {
        fs.rmSync(src, { recursive: true, force: true });
    }
}

try {
    main(process.argv.slice(2));
} catch (e) {
    console.error(e.message);
    process.exit(1);
}
