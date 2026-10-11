'use strict';

// Builds both loader formats from the same Rust binary. No npm packages, service
// credentials, global CLI replacement, or JavaScript game implementation needed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '../..');
const bindgenVersion = '0.2.129';
const target = 'wasm32-unknown-unknown';
const localTools = path.join(root, 'target', 'wasm-tools');
const localBindgen = path.join(localTools, 'bin', process.platform === 'win32' ? 'wasm-bindgen.exe' : 'wasm-bindgen');

function run(command, args, capture = false) {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
    if (result.error || result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`);
    }
    return result.stdout ?? '';
}

function version(command) {
    const result = spawnSync(command, ['--version'], { cwd: root, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
}

function main(args) {
    let format = 'all', debug = false, install = false;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--target') format = args[++i];
        else if (args[i] === '--debug') debug = true;
        else if (args[i] === '--install-tools') install = true;
        else throw new Error(`Unknown option ${args[i]}; use [--target node|web|all] [--debug] [--install-tools]`);
    }
    if (!['node', 'web', 'all'].includes(format)) throw new Error('--target must be node, web, or all');
    const installedTargets = run('rustup', ['target', 'list', '--installed'], true).split(/\s+/);
    if (!installedTargets.includes(target)) {
        if (!install) throw new Error(`Missing Rust target ${target}; rerun with --install-tools or run rustup target add ${target}`);
        run('rustup', ['target', 'add', target]);
    }

    let bindgen = process.env.WASM_BINDGEN || (fs.existsSync(localBindgen) ? localBindgen : 'wasm-bindgen');
    if (version(bindgen) !== `wasm-bindgen ${bindgenVersion}`) {
        if (!install) throw new Error(`Need wasm-bindgen ${bindgenVersion}; rerun with --install-tools to install it locally in target/wasm-tools`);
        run('cargo', ['install', 'wasm-bindgen-cli', '--version', bindgenVersion, '--locked', '--root', localTools]);
        bindgen = localBindgen;
    }

    const cargoArgs = ['rustc', '--locked', '-p', 'omni-wasm', '--lib', '--target', target];
    if (!debug) cargoArgs.push('--release');
    // Fixed-size states are copied through recursive prompt trees. A 16 MiB Wasm
    // stack accommodates ordinary proof depths without changing the shared rules.
    cargoArgs.push('--', '-C', 'link-arg=-zstack-size=16777216');
    run('cargo', cargoArgs);
    const metadata = JSON.parse(run('cargo', ['metadata', '--no-deps', '--format-version', '1', '--locked'], true));
    const profile = debug ? 'debug' : 'release';
    const wasm = path.join(metadata.target_directory, target, profile, 'omni_wasm.wasm');
    const output = path.join(__dirname, 'pkg');
    fs.mkdirSync(output, { recursive: true });
    const builds = [];
    for (const kind of format === 'all' ? ['node', 'web'] : [format]) {
        const destination = path.join(output, kind);
        fs.mkdirSync(destination, { recursive: true });
        run(bindgen, [wasm, '--out-dir', destination, '--out-name', 'omni_wasm', '--target', kind === 'node' ? 'nodejs' : 'web', '--typescript']);
        fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify({
            name: `@swu-bot/omni-wasm-${kind}`, version: '0.1.0', private: true,
            type: kind === 'node' ? 'commonjs' : 'module', main: './omni_wasm.js',
            types: './omni_wasm.d.ts', files: ['*.js', '*.wasm', '*.ts']
        }, null, 2) + '\n');
        const artifact = fs.readFileSync(path.join(destination, 'omni_wasm_bg.wasm'));
        builds.push({ target: kind, bytes: artifact.length, sha256: crypto.createHash('sha256').update(artifact).digest('hex') });
        console.log(`Built ${path.relative(root, destination)} (${artifact.length.toLocaleString()} bytes Wasm)`);
    }
    fs.writeFileSync(path.join(output, 'build.json'), JSON.stringify({ schema: 'omni-wasm-build-v1',
        rustc: run('rustc', ['--version'], true).trim(), wasmBindgen: bindgenVersion, profile,
        stackBytes: 16 * 1024 * 1024, artifacts: builds }, null, 2) + '\n');
}

try { main(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
