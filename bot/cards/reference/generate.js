'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const lib = require('./library');
const { sha256 } = require('../inventory');
const repo = path.resolve(__dirname, '../../..');
function treeHash(directory) {
    const hash = require('node:crypto').createHash('sha256');
    function visit(dir) { for (const name of fs.readdirSync(dir).sort()) { const file = path.join(dir, name), stat = fs.statSync(file);
        if (stat.isDirectory()) visit(file); else { hash.update(path.relative(directory, file) + '\0'); hash.update(fs.readFileSync(file)); } } }
    visit(directory); return hash.digest('hex');
}
function sourceIdentity() {
    const engine = path.join(repo, 'forceteki');
    const actualRoot = path.dirname(fs.realpathSync(path.join(engine, 'server')));
    let engineRevision = null;
    // A source archive can have no Git metadata. Never mistake the containing project's HEAD for the engine revision.
    try { if (fs.realpathSync(execFileSync('git', ['-C', actualRoot, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim()) === actualRoot)
        engineRevision = execFileSync('git', ['-C', actualRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
    let expectedEngineRevision = null;
    try { expectedEngineRevision = execFileSync('git', ['-C', repo, 'ls-tree', 'HEAD', 'forceteki'], { encoding: 'utf8' }).match(/commit ([a-f0-9]+)/)?.[1] ?? null; } catch {}
    const sources = {};
    // Capture helper code as well as the selected scenario. Recorder and chooser changes affect reference games.
    for (const file of ['bot/env.js', 'bot/view.js', 'bot/omni/rs/state.js', 'bot/omni/rs/pool.js', 'bot/cards/reference/generate.js']) sources[file] = sha256(fs.readFileSync(path.join(repo, file)));
    return { engineRevision, expectedEngineRevision, engineSourceSha256: treeHash(path.join(engine, 'server')), engineBuildSha256: treeHash(path.join(engine, 'build/server')),
        cardDataSha256: treeHash(path.join(engine, 'test/json')), scenarioLibrarySha256: treeHash(path.join(__dirname, 'scenarios')),
        playerCodeSha256: treeHash(path.join(repo, 'bot/players')), pipelineCodeSha256: treeHash(path.join(repo, 'bot/cards/pipeline')), sources };
}
async function generate(options) {
    assert.ok(options.out, 'generate needs --out NEW_DIRECTORY');
    const out = path.resolve(options.out);
    assert.ok(!fs.existsSync(out), 'Use a fresh output directory');
    assert.ok(options.entries?.length || options.case || options.card || options.behavior, 'Select --case, --card, or --behavior');
    const index = lib.registry();
    // Reading the index never loads the engine; only generation/indexing require its build.
    for (const [file, expected] of Object.entries(index.sources)) assert.equal(sha256(fs.readFileSync(path.resolve(__dirname, file))), expected, 'Stale reference index; run index first');
    const entries = options.entries ?? lib.selectCases(options, index);
    const cataloguePath = options.catalogue ?? path.join(repo, 'bot/card-compiler/generated/catalog.json'), catalogue = lib.read(cataloguePath);
    for (const entry of entries.filter(c => c.kind === 'play')) {
        const card = catalogue.cards.find(c => c.setCode === entry.focusCardIds[0]);
        assert.ok(card, 'Unknown card: ' + entry.focusCardIds[0]);
        assert.ok(!card.card.types.some(t => ['base', 'leader'].includes(t)), `${entry.id}: leaders and bases require a dedicated setup case`);
    }
    let poolBytes = fs.readFileSync(options.pool ?? path.join(repo, 'bot/card-compiler/generated/runtime-pool.json'));
    if (options.engineOnly) {
        const pool = JSON.parse(poolBytes), definitions = new Map(catalogue.cards.map(c => [c.setCode, c]));
        for (const code of new Set(entries.flatMap(c => [...c.setupCardIds, ...c.focusCardIds]))) {
            if (code.startsWith('TOKEN_') || pool.cards.some(c => c.setCode === code)) continue;
            const def = definitions.get(code); assert.ok(def, 'Unknown scenario card: ' + code); pool.cards.push({ setCode: code, ...def.card });
        }
        pool.cards.sort((a, b) => a.setCode.localeCompare(b.setCode)); poolBytes = Buffer.from(JSON.stringify(pool, null, 2) + '\n');
    }
    const engineBuild = options.preparedEngine ? verifyPreparedEngine(options.preparedEngine) : prepareEngine();
    const poolSha256 = sha256(poolBytes), provenance = sourceIdentity();
    provenance.buildVerification = engineBuild;
    provenance.sourceCatalogueSha256 = sha256(fs.readFileSync(cataloguePath));
    provenance.nodeVersion = process.version;
    for (const dir of ['pools', 'traces']) fs.mkdirSync(path.join(out, dir), { recursive: true });
    fs.writeFileSync(lib.artifact(out, 'pool', poolSha256), poolBytes);
    const { Env } = require('../../env'), { loadPool } = require('../../omni/rs/pool');
    const pool = loadPool(lib.artifact(out, 'pool', poolSha256)), env = new Env(), recordings = [];
    for (const code of new Set(entries.flatMap(entry => [...entry.focusCardIds, ...entry.setupCardIds]))) {
        const definition = catalogue.cards.find(c => c.setCode === code);
        if (definition) assert.ok(env.isImplemented(definition.card), `The reference engine does not implement ${code}`);
    }
    for (const entry of entries) {
        const suite = require(path.resolve(__dirname, entry.source.module));
        const scenario = entry.kind === 'probe' ? entry : entry.kind === 'play' ? suite.create(entry.focusCardIds[0]) : suite.scenarios.find(s => s.name === entry.source.scenario);
        assert.ok(scenario, 'Missing scenario ' + entry.id);
        const seed = options.seed === undefined ? parseInt(sha256(entry.id).slice(0, 8), 16) % 1000000 + 1 : Number(options.seed);
        assert.ok(Number.isSafeInteger(seed) && seed >= 0, 'Seed must be a nonnegative integer');
        const { records, witness } = await suite.fixture(env, pool, { ...scenario }, seed);
        suite.assertRecording?.(scenario, { records, witness });
        assert.equal(records[0].pool.sha256, poolSha256);
        assert.equal(records.at(-1).type, 'result', 'Reference must reach a terminal result');
        // Metadata is attached before serialization; content-addressed recordings are never rewritten.
        records[0].referenceCase = { id: entry.id, kind: entry.kind, focusCardIds: entry.focusCardIds, assertionStages: entry.assertionStages };
        if (entry.kind === 'probe') records[0].referenceCase.definitionSha256 = sha256(Buffer.from(JSON.stringify(entry)));
        if (entry.kind === 'diagnostic') records[0].diagnostic = { evidenceStatus: 'Synthetic engine registration, not a printed-card witness',
            definition: entry.source, setup: entry.setup, sourceSha256: index.sources[entry.source.module],
            registrationCode: scenario.beforeApply?.toString() ?? scenario.beforeWindow?.toString() ?? null };
        const decisions = records.filter(r => r.type === 'decision').length, windows = records.filter(r => r.type === 'state').length;
        assert.ok(decisions && windows, 'Empty reference recording');
        const bytes = zlib.gzipSync(records.map(r => JSON.stringify(r)).join('\n') + '\n'), traceSha256 = sha256(bytes);
        fs.writeFileSync(lib.artifact(out, 'trace', traceSha256), bytes);
        recordings.push({ ...(entry.kind === 'probe' ? { caseDefinition: entry } : {}), caseId: entry.id, traceSha256, poolSha256, seed, decisions, windows, witness, provenance,
            runtimeConformance: 'unassessed', engineOnly: !!options.engineOnly });
        console.error(`${entry.id}: ${decisions} decisions, ${windows} windows; engine assertions passed`);
    }
    assert.deepEqual(sourceIdentity(), Object.fromEntries(Object.entries(provenance).filter(([key]) => !['sourceCatalogueSha256', 'nodeVersion', 'buildVerification'].includes(key))), 'Reference source changed during generation');
    assert.equal(sha256(fs.readFileSync(cataloguePath)), provenance.sourceCatalogueSha256, 'Catalogue changed during generation');
    lib.writeManifest(out, { schema: 'swu-reference-corpus/v1', recordings });
    return { directory: out, ...lib.verify(out), runtimeConformance: 'unassessed' };
}

function verifyPreparedEngine(receipt) {
    const engine = path.dirname(fs.realpathSync(path.join(repo, 'forceteki/server'))), buildRoot = fs.realpathSync(path.join(repo, 'forceteki/build'));
    assert.equal(path.dirname(buildRoot), engine, 'Engine source and build must share one checkout');
    const inputs = { sourceSha256: treeHash(path.join(engine, 'server')), scriptsSha256: treeHash(path.join(engine, 'scripts')), config: Object.fromEntries(fs.readdirSync(engine).filter(f => /^(?:tsconfig.*\.json|package(?:-lock)?\.json)$/.test(f)).sort().map(f => [f, sha256(fs.readFileSync(path.join(engine, f)))])) };
    assert.deepEqual(inputs, receipt.inputs, 'Prepared engine source changed');
    assert.equal(treeHash(path.join(buildRoot, 'server')), receipt.buildSha256, 'Prepared engine build changed');
    return receipt;
}
function prepareEngine() {
    const engine = path.dirname(fs.realpathSync(path.join(repo, 'forceteki/server')));
    const buildRoot = fs.realpathSync(path.join(repo, 'forceteki/build'));
    assert.equal(path.dirname(buildRoot), engine, 'Engine source and build must share one checkout');
    const inputs = () => ({ sourceSha256: treeHash(path.join(engine, 'server')), scriptsSha256: treeHash(path.join(engine, 'scripts')),
        config: Object.fromEntries(fs.readdirSync(engine).filter(f => /^(?:tsconfig.*\.json|package(?:-lock)?\.json)$/.test(f)).sort().map(f => [f, sha256(fs.readFileSync(path.join(engine, f)))])) });
    const before = inputs(), receiptFile = path.join(buildRoot, '.swu-reference-build.json');
    if (fs.existsSync(receiptFile)) {
        const old = lib.read(receiptFile);
        if (JSON.stringify(old.inputs) === JSON.stringify(before) && old.buildSha256 === treeHash(path.join(buildRoot, 'server'))) return old;
    }
    console.error('Building the reference engine to bind executable output to its source snapshot…');
    // Generated files only. A clean output prevents removed classes from surviving a previous build.
    fs.rmSync(path.join(buildRoot, 'server'), { recursive: true, force: true });
    execFileSync('npm', ['run', 'build'], { cwd: engine, stdio: ['ignore', 'ignore', 'inherit'] });
    assert.deepEqual(inputs(), before, 'Engine source changed during build');
    const receipt = { inputs: before, buildSha256: treeHash(path.join(buildRoot, 'server')), command: 'npm run build' };
    fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n');
    return receipt;
}
module.exports = { generate, sourceIdentity, treeHash, prepareEngine, verifyPreparedEngine };
