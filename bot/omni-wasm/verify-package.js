'use strict';
// Verify only the packaged runtime in an isolated directory, with no repository imports.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

// This function is serialized into the isolated directory and run in a new Node process.
async function verifyPackage() {
    const fs = require('node:fs');
    const assert = require('node:assert/strict');
    const { createSimulator } = require('@swu-bot/omni-wasm');
    const manifest = require('@swu-bot/omni-wasm/package.json');
    assert.deepEqual(manifest.dependencies ?? {}, {});
    const state = JSON.parse(fs.readFileSync('position.json', 'utf8'));
    const node = await createSimulator();
    const game = node.loadState(state);
    assert.deepEqual(game.snapshot(), state);
    const proof = game.prove({ depth: 3, nodes: 10000 });
    assert.equal(proof.result, 'p2');
    assert.equal(proof.complete, true);
    assert.deepEqual(game.snapshot(), state);
    const clone = game.clone();
    clone.apply(clone.legalActions()[0]);
    assert.deepEqual(game.snapshot(), state);
    clone.free();
    game.free();
    node.free();

    const browser = await import('@swu-bot/omni-wasm/browser');
    const wasm = { module_or_path: fs.readFileSync(require.resolve('@swu-bot/omni-wasm/wasm')) };
    const web = await browser.createSimulator({ poolJson: fs.readFileSync(require.resolve('@swu-bot/omni-wasm/pool.json'), 'utf8'), wasm });
    const webGame = web.loadState(state);
    assert.deepEqual(webGame.snapshot(), state);
    const webProof = webGame.prove({ depth: 3, nodes: 10000 });
    assert.equal(webProof.result, proof.result);
    assert.equal(webProof.complete, proof.complete);
    webGame.free();
    web.free();

    const catalogueJson = fs.readFileSync('catalog.json', 'utf8');
    const poolJson = fs.readFileSync('expanded-pool.json', 'utf8');
    const expandedState = JSON.parse(fs.readFileSync('expanded-position.json', 'utf8'));
    const expandedNode = await createSimulator({ cataloguePath: 'catalog.json', poolPath: 'expanded-pool.json' });
    const expandedWeb = await browser.createSimulator({ catalogueJson, poolJson });
    assert.equal(expandedWeb.poolHash, expandedNode.poolHash);
    const expandedGame = expandedNode.loadState(expandedState);
    const expandedWebGame = expandedWeb.loadState(expandedState);
    assert.deepEqual(expandedGame.snapshot(), expandedState);
    assert.deepEqual(expandedWebGame.snapshot(), expandedState);
    const expandedProof = expandedGame.prove({ depth: 2, nodes: 5000 });
    const expandedWebProof = expandedWebGame.prove({ depth: 2, nodes: 5000 });
    for (const field of ['result', 'complete', 'nodes', 'decisions']) assert.equal(expandedWebProof[field], expandedProof[field]);
    const allAdmitted = await createSimulator({ catalogueJson });
    assert.ok(allAdmitted.poolHash);
    allAdmitted.free();
    const { WasmGame } = await import('@swu-bot/omni-wasm/adapter');
    const draw = new WasmGame({ winner: () => 'draw' }, { names: ['Alice', 'Bob'] });
    assert.deepEqual(draw.winners, ['Alice', 'Bob']);
    console.log(JSON.stringify({ isolatedPackage: true, dependencies: [], nodeProof: proof, webProof, expandedPoolHash: expandedNode.poolHash, expandedProof, expandedWebProof, catalogueOnlyLoaded: true, drawNames: draw.winners }, null, 2));
    expandedGame.free();
    expandedWebGame.free();
    expandedNode.free();
    expandedWeb.free();
}

function lastState(file) {
    return zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').trim().split('\n').map(JSON.parse).filter(row => row.type === 'state').at(-1).state;
}

function main() {
    const root = path.resolve(__dirname, '../..');
    const receipt = JSON.parse(fs.readFileSync(path.join(__dirname, 'pkg/distribution/receipt.json'), 'utf8'));
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(receipt.tarball)).digest('hex'), receipt.sha256, 'Tarball differs from its receipt');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-wasm-package-'));
    try {
        const unpack = spawnSync('tar', ['-xzf', receipt.tarball, '-C', temp], { encoding: 'utf8' });
        if (unpack.status !== 0) throw new Error(unpack.stderr || 'Cannot unpack local tarball');
        const scope = path.join(temp, 'node_modules/@swu-bot');
        fs.mkdirSync(scope, { recursive: true });
        fs.renameSync(path.join(temp, 'package'), path.join(scope, 'omni-wasm'));
        fs.writeFileSync(path.join(temp, 'position.json'), JSON.stringify(lastState(path.join(root, 'bot/omni-rs/tests/fixtures/heuristic-vs-heuristic-1.jsonl.gz'))));
        fs.writeFileSync(path.join(temp, 'expanded-position.json'), JSON.stringify(lastState(path.join(root, 'bot/omni-rs/tests/compiled-fixtures/effect-interactions-4001.jsonl.gz'))));
        fs.copyFileSync(path.join(root, 'bot/card-compiler/generated/catalog.json'), path.join(temp, 'catalog.json'));
        fs.copyFileSync(path.join(root, 'bot/omni-rs/tests/compiled-fixtures/pool.json'), path.join(temp, 'expanded-pool.json'));
        fs.writeFileSync(path.join(temp, 'verify.cjs'), `(${verifyPackage.toString()})().catch(error => { console.error(error); process.exitCode = 1; });\n`);
        const check = spawnSync(process.execPath, ['verify.cjs'], { cwd: temp, encoding: 'utf8' });
        if (check.stdout) process.stdout.write(check.stdout);
        if (check.status !== 0) throw new Error(check.stderr || `Package verification exited ${check.status}`);
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.stack || error); process.exitCode = 1; } }
module.exports = { main };
