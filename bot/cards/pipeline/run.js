'use strict';
const fs = require('node:fs'),
    path = require('node:path'),
    assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { compileCatalog } = require('../../card-compiler/build');
const { planCardProbes } = require('./probes');
const { coverage, digest, validateReview } = require('./coverage');
const { createPacket, implementationSnapshot } = require('./review');
const { mutants } = require('./mutations');
const reference = require('../reference/library');
const { sha256 } = require('../inventory');
const repo = path.resolve(__dirname, '../../..');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
function command(executable, args, env) {
    const r = spawnSync(executable, args, {
        cwd: repo,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: env ?? process.env,
    });
    if (r.error) throw r.error;
    assert.equal(r.status, 0, `${executable} ${args.join(' ')}\n${r.stderr || r.stdout}`);
    return r.stdout;
}
function planCards(catalogue, cardIds) {
    assert.ok(cardIds?.length, 'Select at least one --card SET_NNN');
    assert.equal(new Set(cardIds).size, cardIds.length, 'Duplicate selected card');
    return [...cardIds].sort().map((id) => {
        const entry = catalogue.cards.find((e) => e.setCode === id);
        assert.ok(entry, 'Unknown card ' + id);
        const plan = planCardProbes(entry, { catalogue });
        for (const c of plan.cases) c.source = { module: '../pipeline/probe-fixture.js', scenario: c.name };
        return plan;
    });
}
function mutationChecks({ catalogue, plans, corpus, native, out }) {
    const manifest = reference.corpus(corpus),
        results = [];
    fs.mkdirSync(out, { recursive: true });
    for (const plan of plans) {
        const traces = manifest.recordings.filter((r) => r.caseDefinition?.focusCardIds.includes(plan.cardId));
        if (!traces.length) continue;
        for (const mutant of mutants(catalogue.cards.find((c) => c.setCode === plan.cardId))) {
            const altered = {
                ...catalogue,
                cards: catalogue.cards.map((c) => (c.setCode === plan.cardId ? mutant.entry : c)),
            };
            const file = path.join(out, digest(mutant) + '.json');
            write(file, altered);
            const admitted = JSON.parse(command(native, ['catalogue', file]));
            const rejection = admitted.runtimeRejectedCards.find((c) => c.setCode === plan.cardId);
            if (rejection) {
                results.push({
                    id: mutant.id,
                    cardId: plan.cardId,
                    status: 'invalid-mutant',
                    reason: rejection.reason,
                });
                continue;
            }
            let detected = null;
            for (const poolHash of new Set(traces.map((r) => r.poolSha256))) {
                const group = traces.filter((r) => r.poolSha256 === poolHash);
                const r = spawnSync(
                    native,
                    [
                        'check',
                        ...group.map((r) => reference.checkedArtifact(corpus, 'trace', r.traceSha256)),
                        '--pool',
                        reference.checkedArtifact(corpus, 'pool', poolHash),
                        '--catalogue',
                        file,
                        '--backend',
                        'interpreter',
                    ],
                    { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
                );
                if (r.error) throw r.error;
                if (r.status !== 0) {
                    detected = {
                        exitCode: r.status,
                        detail: r.stderr.trim(),
                        traceSha256: group.map((r) => r.traceSha256),
                    };
                    break;
                }
            }
            results.push({
                id: mutant.id,
                cardId: plan.cardId,
                path: mutant.path,
                status: detected ? 'detected' : 'survived',
                evidence: detected,
                catalogueSha256: sha256(fs.readFileSync(file)),
            });
        }
    }
    return results;
}
async function run(options) {
    assert.ok(options.out, 'run needs --out NEW_DIRECTORY');
    const out = path.resolve(options.out);
    assert.ok(!fs.existsSync(out), 'Use a fresh output directory');
    const prepared = options.prepared ? require('./prepared').loadPrepared(options.prepared) : null;
    const implementationBefore = prepared?.implementationBefore ?? implementationSnapshot(),
        catalogue = prepared?.catalogue ?? compileCatalog(),
        plans = planCards(catalogue, options.cards);
    fs.mkdirSync(out, { recursive: true });
    const catalogFile = path.join(out, 'catalog.json'),
        poolFile = path.join(out, 'pool.json');
    write(catalogFile, catalogue);
    write(path.join(out, 'plan.json'), plans);
    let observations = [],
        comparisons = [],
        rules = null,
        mutationResults = [],
        failure = null;
    const native = prepared?.native ?? path.join(repo, 'target/release/omni-rs');
    try {
        if (!prepared) {
            const env = { ...process.env, SWU_RULES_CATALOGUE: catalogFile };
            console.error('Compiling generated card programs for native and Wasm…');
            command('cargo', ['build', '--locked', '--release', '-p', 'omni-rs'], env);
            command(process.execPath, ['bot/omni-wasm/build.js', '--target', 'node'], env);
        }
        if (prepared) write(poolFile, prepared.pool);
        const admission = prepared?.admission ?? JSON.parse(command(native, ['catalogue', catalogFile, '--out-pool', poolFile]));
        write(path.join(out, 'admission.json'), admission);
        const allowed = new Set(admission.runtimeAdmittedCards.map((c) => c.setCode));
        for (const p of plans)
            if (!allowed.has(p.cardId)) {
                const id = p.cardId + ':runtime:admission',
                    reason =
                        admission.runtimeRejectedCards.find((c) => c.setCode === p.cardId)?.reason ??
                        'Runtime rejected card';
                p.uncovered.push({ id, path: 'runtime', reason });
                p.obligations.push({ id, path: 'runtime', dimension: 'admission' });
                p.cases = [];
            }
        // The authoritative run plan includes runtime rejections, not only source conversion.
        write(path.join(out, 'executable-plan.json'), plans);
        rules = prepared?.rules ?? JSON.parse(command(native, ['rules', '--catalogue', catalogFile, '--pool', poolFile]));
        for (const p of plans)
            for (const [side, ids] of Object.entries(rules.cards[p.cardId] ?? {})) {
                for (const [i, index] of ids.entries()) {
                    const program = rules.programs[index];
                    if (program.backend === 'aot') continue;
                    const id = p.cardId + ':abilities.' + side + '.' + i + ':aot-lowering';
                    p.obligations.push({ id, path: 'abilities.' + side + '.' + i, dimension: 'aot-lowering' });
                    p.uncovered.push({ id, path: 'abilities.' + side + '.' + i, reason: program.fallbackReason });
                }
            }
        const entries = plans.flatMap((p) => p.cases);
        if (entries.length) {
            const corpus = path.join(out, 'reference');
            await require('../reference/generate').generate({
                out: corpus,
                entries,
                pool: poolFile,
                catalogue: catalogFile,
                preparedEngine: prepared?.engineBuild,
            });
            const rows = reference.corpus(corpus).recordings;
            observations = rows.map((r) => ({ ...r, coverageObligationIds: r.witness.coverageObligationIds ?? [] }));
            for (const backend of ['auto', 'interpreter']) {
                const receipt = path.join(out, 'check-' + backend + '.json'),
                    dispatchDir = path.join(out, 'dispatch-' + backend);
                fs.mkdirSync(dispatchDir);
                await require('../reference/check').check({
                    corpus,
                    catalogue: catalogFile,
                    native,
                    wasmPackage: prepared?.wasmPackage,
                    backend,
                    runtime: backend === 'auto' ? 'both' : 'native',
                    receipt,
                    dispatchDir,
                });
                const checked = reference.read(receipt);
                for (const result of checked.results) {
                    const oracle = rows.find((r) => r.caseId === result.caseId && r.traceSha256 === result.traceSha256);
                    comparisons.push({
                        ...result,
                        runtime: (result.runtime === 'native' ? 'native' : 'wasm') + '-' + backend,
                        poolSha256: oracle.poolSha256,
                        catalogueSha256: checked.identities.catalogueSha256,
                        identities: checked.identities,
                    });
                }
            }
            rules = {
                availability: rules,
                execution: Object.fromEntries(
                    ['auto', 'interpreter'].map((backend) => [
                        backend,
                        fs
                            .readdirSync(path.join(out, 'dispatch-' + backend))
                            .sort()
                            .map((file) => reference.read(path.join(out, 'dispatch-' + backend, file))),
                    ]),
                ),
            };
            if (options.mutations !== false)
                mutationResults = mutationChecks({ catalogue, plans, corpus, native, out: path.join(out, 'mutants') });
        }
    } catch (error) {
        failure = { message: error.message, stack: error.stack };
    }
    for (const m of mutationResults.filter((m) => m.status !== 'detected')) {
        const p = plans.find((p) => p.cardId === m.cardId),
            id = m.id + ':sensitivity';
        p.obligations.push({ id, path: m.path ?? 'mutation', dimension: 'test-sensitivity' });
        p.uncovered.push({
            id,
            path: m.path ?? 'mutation',
            reason:
                m.status === 'survived'
                    ? 'A deliberately wrong configuration passed every generated reference'
                    : 'Mutation was rejected by admission; sensitivity unassessed',
        });
    }
    const report = {
        schema: 'swu-card-pipeline-run/v1',
        catalogueSha256: sha256(fs.readFileSync(catalogFile)),
        plansSha256: digest(plans),
        stage: failure ? 'failed' : 'review-pending',
        failure,
        coverage: coverage(plans, observations, comparisons),
        comparisons,
        mutations: mutationResults,
        review: { status: 'pending' },
    };
    if (prepared) {
        try { assert.equal(require('./prepared').loadPrepared(options.prepared).manifestSha256, prepared.manifestSha256, 'Prepared manifest changed during run'); }
        catch (error) { failure = { message: error.message, stack: error.stack }; report.stage = 'failed'; report.failure = failure; }
        report.preparedManifestSha256 = prepared.manifestSha256;
    }
    const reviewDir = path.join(out, 'review');
    fs.mkdirSync(reviewDir);
    let packet;
    try {
        packet = createPacket({
            catalogue,
            catalogueSha256: report.catalogueSha256,
            implementationBefore,
            preparedManifestSha256: prepared?.manifestSha256,
            plans,
            coverage: report.coverage,
            comparisons,
            mutations: mutationResults,
            rules,
            out: reviewDir,
        });
    } catch (error) {
        report.stage = 'failed';
        report.packetError = { message: error.message };
        write(path.join(out, 'report.json'), report);
        throw new Error(error.message + '\nPartial report: ' + out);
    }
    report.review.packetSha256 = digest(packet);
    write(path.join(out, 'report.json'), report);
    if (failure) throw new Error(failure.message + '\nPartial report and review packet: ' + out);
    return {
        directory: out,
        stage: report.stage,
        cards: plans.length,
        probes: observations.length,
        comparisons: comparisons.length,
        mutations: mutationResults.map((m) => ({ id: m.id, status: m.status })),
        coverage: report.coverage.map((c) => ({ cardId: c.cardId, totals: c.totals })),
        reviewPacket: path.join(reviewDir, 'packet.json'),
        packetSha256: digest(packet),
    };
}
function recordReview(options) {
    assert.ok(options.run && options.file, 'review needs --run RUN_DIRECTORY --file REVIEW_JSON');
    const run = path.resolve(options.run),
        packet = reference.read(path.join(run, 'review/packet.json'));
    for (const source of [...packet.engine.files, ...packet.implementation])
        assert.equal(
            sha256(fs.readFileSync(path.join(run, 'review', source.artifact))),
            source.sha256,
            'Review source artifact changed',
        );
    const review = validateReview(reference.read(options.file), packet);
    const report = reference.read(path.join(run, 'report.json'));
    assert.equal(report.review.packetSha256, digest(packet), 'Run report differs from reviewed packet');
    write(path.join(run, 'review/result.json'), review);
    const status = report.failure
        ? 'failed'
        : review.cards.some((c) => c.verdict === 'incomplete')
        ? 'review-incomplete'
        : review.cards.some((c) => c.findings.some((f) => f.kind === 'bug'))
        ? 'review-findings'
        : 'reviewed-with-coverage-gaps';
    write(path.join(run, 'reviewed-report.json'), {
        ...report,
        stage: status,
        review,
        coverage: report.coverage.map((c) => ({ ...c, review: review.cards.find((r) => r.cardId === c.cardId) })),
    });
    return { directory: run, stage: status, reviewedCards: review.cards.length };
}
module.exports = { planCards, run, recordReview, mutationChecks, prepare: (options) => require('./prepared').prepare(options), loadPrepared: (file) => require('./prepared').loadPrepared(file) };
