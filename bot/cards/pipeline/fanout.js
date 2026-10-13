'use strict';

// One coordinator owns the ledger; children only write their fresh attempt directory.
// Passing comparisons remain review-pending. This module never imports or publishes.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { digest, coverage, validateReview } = require('./coverage');
const { sha256 } = require('../inventory');
const reference = require('../reference/library');
const repo = path.resolve(__dirname, '../../..');
const schema = 'swu-card-fanout/v1';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hashFile = file => sha256(fs.readFileSync(file));
const now = () => new Date().toISOString();

function writeNew(file, value) {
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
function save(file, value) {
    const temporary = file + '.' + crypto.randomUUID() + '.tmp';
    writeNew(temporary, value);
    fs.renameSync(temporary, file);
}
function beneath(root, relative) {
    assert.equal(typeof relative, 'string');
    assert.ok(relative && !path.isAbsolute(relative), 'Artifact path must be relative');
    const file = path.resolve(root, relative);
    assert.ok(file.startsWith(path.resolve(root) + path.sep), 'Artifact escaped its run');
    if (fs.existsSync(file)) {
        assert.ok(fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep), 'Artifact symlink escaped its run');
    }
    return file;
}
function acquire(directory, recover = false) {
    const file = path.join(directory, 'coordinator.lock');
    const guard = path.join(directory, 'coordinator-acquire.lock');
    const token = crypto.randomUUID();
    try { fs.mkdirSync(guard); }
    catch (error) {
        if (error.code === 'EEXIST') throw new Error('Coordinator ownership is being changed; retry after its acquisition finishes');
        throw error;
    }
    try {
        if (fs.existsSync(file) && recover) {
            const owner = read(file);
            assert.equal(owner.host, os.hostname(), 'Cannot recover a coordinator on another host');
            assert.ok(Number.isSafeInteger(owner.pid) && owner.pid > 0, 'Invalid coordinator PID');
            let dead = false;
            try { process.kill(owner.pid, 0); }
            catch (error) { if (error.code === 'ESRCH') dead = true; else throw error; }
            assert.ok(dead, 'Coordinator is still alive; do not steal its lock');
            assert.equal(read(file).token, owner.token, 'Coordinator changed during recovery');
            fs.unlinkSync(file);
        }
        try { writeNew(file, { token, pid: process.pid, host: os.hostname(), startedAt: now() }); }
        catch (error) {
            if (error.code === 'EEXIST') throw new Error('Another coordinator owns this run; use --recover only after it has stopped');
            throw error;
        }
    } finally { fs.rmdirSync(guard); }
    return () => { if (fs.existsSync(file) && read(file).token === token) fs.unlinkSync(file); };
}
function validateCards(cardIds) {
    assert.ok(Array.isArray(cardIds) && cardIds.length, 'Select at least one card');
    assert.equal(new Set(cardIds).size, cardIds.length, 'Duplicate selected card');
    for (const id of cardIds) assert.match(id, /^[A-Z][A-Z0-9]{2,3}_\d{3}$/, 'Use a printed card ID');
    return [...cardIds].sort();
}
function preparedLocation(directory, manifest) {
    if (manifest.externalPrepared === true) {
        assert.ok(path.isAbsolute(manifest.prepared), 'External prepared directory must be absolute');
        return manifest.prepared;
    }
    return beneath(directory, manifest.prepared);
}
function executionOptions(options) {
    const jobs = Number(options.jobs ?? 20);
    assert.ok(Number.isSafeInteger(jobs) && jobs >= 1 && jobs <= 20, '--jobs must be an integer from 1 to 20');
    const timeoutMs = Number(options.timeoutMs ?? 30 * 60 * 1000);
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 4 * 60 * 60 * 1000, '--timeout-ms must be between 1 and 14400000');
    return { jobs, timeoutMs };
}

// Revalidate completed children instead of trusting a mutable status flag or exit code.
function verifyResult(directory, cardId, prepared) {
    const report = read(path.join(directory, 'report.json'));
    const packet = read(path.join(directory, 'review/packet.json'));
    assert.equal(report.schema, 'swu-card-pipeline-run/v1');
    assert.equal(report.stage, 'review-pending', 'Child did not finish the pipeline');
    assert.equal(report.failure, null, 'Child contains a failure');
    assert.equal(report.preparedManifestSha256, prepared.manifestSha256, 'Child used another prepared build');
    assert.equal(packet.preparedManifestSha256, prepared.manifestSha256, 'Child packet used another prepared build');
    const catalogueSha256 = prepared.catalogueSha256 ?? hashFile(prepared.cataloguePath);
    assert.equal(report.catalogueSha256, catalogueSha256, 'Child catalogue differs from prepared build');
    assert.equal(packet.catalogueSha256, catalogueSha256);
    assert.equal(packet.canonicalCatalogueSha256, digest(prepared.catalogue));
    assert.equal(report.review.packetSha256, digest(packet), 'Child packet binding changed');
    assert.deepEqual(packet.cards.map(c => c.cardId), [cardId], 'Child must contain exactly its selected card');
    const plans = packet.cards.map(c => c.probes);
    assert.equal(report.plansSha256, digest(plans), 'Child plans differ from its packet');
    assert.deepEqual(report.comparisons, packet.comparisons);
    assert.deepEqual(report.mutations, packet.mutations);
    assert.deepEqual(report.coverage, packet.cards.map(c => c.coverage));
    assert.deepEqual(packet.implementation.map(({ path, sha256 }) => ({ path, sha256 })), prepared.implementationBefore,
        'Child implementation inventory differs from prepared build');
    const inputs = new Map(prepared.catalogue.inputs.map(f => [f.file, f.sha256]));
    for (const item of [...packet.engine.files, ...packet.implementation]) {
        assert.equal(hashFile(beneath(path.join(directory, 'review'), item.artifact)), item.sha256, 'Child review artifact changed');
        if (item.path.startsWith('forceteki/')) assert.equal(inputs.get(item.path.slice('forceteki/'.length)), item.sha256, 'Child engine source differs');
    }
    const entry = prepared.catalogue.cards.find(c => c.setCode === cardId);
    assert.ok(entry, 'Unknown prepared card');
    const card = packet.cards[0];
    assert.deepEqual(card.printedCard, entry.card);
    assert.deepEqual(card.configuration, entry.abilities);
    assert.equal(card.sourceHash, entry.sourceHash);
    const corpus = path.join(directory, 'reference');
    let recordings = [];
    if (plans[0].cases.length) {
        reference.verify(corpus);
        recordings = reference.corpus(corpus).recordings;
        assert.equal(recordings.length, plans[0].cases.length, 'Missing or duplicate oracle case');
        assert.equal(new Set(recordings.map(r => r.caseId)).size, recordings.length);
        const planned = new Map(plans[0].cases.map(c => [c.id, c]));
        const nativeHash = hashFile(prepared.native);
        const wasmHashes = Object.fromEntries(fs.readdirSync(prepared.wasmPackage).filter(f => /\.(wasm|js)$/.test(f)).sort()
            .map(f => [f, hashFile(path.join(prepared.wasmPackage, f))]));
        assert.equal(report.comparisons.length, recordings.length * 3, 'Every case needs all three backend comparisons');
        for (const row of recordings) {
            assert.deepEqual(row.caseDefinition, planned.get(row.caseId), 'Recorded construction differs from plan');
            assert.equal(row.provenance.sourceCatalogueSha256, catalogueSha256);
            for (const [key, value] of Object.entries(prepared.sourceIdentity))
                assert.deepEqual(row.provenance[key], value, 'Recorded engine/helper inputs differ from prepared build: ' + key);
            assert.equal(row.engineOnly, false, 'Engine-only observations are not differential acceptance');
            for (const runtime of ['native-auto', 'native-interpreter', 'wasm-auto']) {
                const matches = report.comparisons.filter(c => c.caseId === row.caseId && c.runtime === runtime);
                assert.equal(matches.length, 1, 'Missing or duplicate backend comparison');
                const result = matches[0];
                assert.equal(result.matched, true);
                assert.equal(result.traceSha256, row.traceSha256);
                assert.equal(result.poolSha256, row.poolSha256);
                assert.equal(result.catalogueSha256, catalogueSha256);
                assert.equal(result.decisions, row.decisions);
                assert.equal(result.windows, row.windows);
                if (runtime.startsWith('native-')) assert.equal(result.identities.nativeSha256, nativeHash);
                else assert.deepEqual(result.identities.wasmPackage, wasmHashes);
            }
        }
    } else {
        assert.equal(report.comparisons.length, 0);
        assert.ok(!fs.existsSync(corpus), 'Unexpected corpus for an unconstructed card');
    }
    const observations = recordings.map(r => ({ ...r, coverageObligationIds: r.witness.coverageObligationIds ?? [] }));
    assert.deepEqual(report.coverage, coverage(plans, observations, report.comparisons), 'Reported coverage is not reproducible');
    let reviewStatus = 'pending';
    const reviewedFile = path.join(directory, 'reviewed-report.json');
    if (fs.existsSync(reviewedFile)) {
        const reviewed = read(reviewedFile);
        const review = validateReview(read(path.join(directory, 'review/result.json')), packet);
        assert.deepEqual(reviewed.review, review);
        assert.deepEqual(reviewed.comparisons, report.comparisons);
        const expected = review.cards.some(c => c.verdict === 'incomplete') ? 'review-incomplete'
            : review.cards.some(c => c.findings.some(f => f.kind === 'bug')) ? 'review-findings' : 'reviewed-with-coverage-gaps';
        assert.equal(reviewed.stage, expected);
        reviewStatus = expected;
    }
    const admitted = prepared.admission.runtimeAdmittedCards.some(c => c.setCode === cardId);
    return {
        status: recordings.length ? 'review-pending' : 'needs-work',
        runtimeAdmitted: admitted,
        recordings: recordings.length,
        comparisons: report.comparisons.length,
        decisionsPerBackend: recordings.reduce((sum, r) => sum + r.decisions, 0),
        windowsPerBackend: recordings.reduce((sum, r) => sum + r.windows, 0),
        coverage: report.coverage[0].totals,
        uncovered: plans[0].uncovered,
        reviewStatus,
        packetSha256: digest(packet),
        reportSha256: hashFile(path.join(directory, 'report.json')),
        note: 'Pipeline agreement is separate from semantic review and newly implemented card coverage.',
    };
}

function runChild({ cardId, directory, prepared, mutations, timeoutMs, signal }, dependencies = {}) {
    return new Promise((resolve, reject) => {
        const args = [path.join(__dirname, 'cli.js'), 'run', '--card', cardId, '--prepared', prepared, '--out', directory];
        if (!mutations) args.push('--no-mutations');
        const log = fs.openSync(directory + '.log', 'wx');
        let child;
        try {
            child = (dependencies.spawn ?? spawn)(process.execPath, args, { cwd: repo, stdio: ['ignore', log, log], detached: process.platform !== 'win32' });
        } catch (error) { fs.closeSync(log); reject(error); return; }
        fs.closeSync(log);
        let timedOut = false;
        let cancelled = false;
        let forceTimer;
        function kill(sig) {
            try { if (process.platform === 'win32') child.kill(sig); else process.kill(-child.pid, sig); }
            catch (error) { if (error.code !== 'ESRCH') reject(error); }
        }
        function stop(timeout) {
            timedOut ||= timeout;
            cancelled ||= !timeout;
            kill('SIGTERM');
            forceTimer ??= setTimeout(() => kill('SIGKILL'), 2000);
        }
        const timer = setTimeout(() => stop(true), timeoutMs);
        const abort = () => stop(false);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        const cleanup = () => { clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort', abort); };
        child.once('error', error => { cleanup(); reject(error); });
        child.once('close', (exitCode, exitSignal) => {
            // The CLI can exit on TERM before a descendant does. Finish killing the
            // process group before cancelling escalation and releasing the worker.
            if (timedOut || cancelled) kill('SIGKILL');
            cleanup(); resolve({ exitCode, signal: exitSignal, timedOut, cancelled });
        });
    });
}

function summarize(directory, manifest, state) {
    const jobs = state.jobs.map(job => ({ cardId: job.cardId, status: job.status, attempts: job.attempts.length,
        directory: job.attempts.at(-1)?.directory ?? null, summary: job.summary ?? null, error: job.error ?? null }));
    return { schema, directory, cards: jobs.length, preparedManifestSha256: manifest.preparedManifestSha256,
        startedAt: state.startedAt, updatedAt: state.updatedAt, finishedAt: state.finishedAt ?? null,
        elapsedSeconds: (Date.parse(state.finishedAt ?? state.updatedAt) - Date.parse(state.startedAt)) / 1000,
        maxConcurrentChildren: state.maxConcurrentChildren, requestedConcurrency: state.requestedConcurrency,
        counts: Object.fromEntries(['pending', 'running', 'review-pending', 'needs-work', 'failed'].map(s => [s, jobs.filter(j => j.status === s).length])),
        sourceConverted: manifest.baseline.sourceConverted, runtimeAdmitted: manifest.baseline.runtimeAdmitted,
        pipelineComparedCardIds: jobs.filter(j => j.summary?.comparisons > 0).map(j => j.cardId),
        independentlyReviewedCardIds: jobs.filter(j => j.summary?.reviewStatus === 'reviewed-with-coverage-gaps').map(j => j.cardId),
        newCardCompletions: null,
        throughputNote: 'Elapsed time measures this validation run. Existing admissions and replay comparisons are not newly completed card implementations.',
        jobs };
}

async function fanout(options, dependencies = {}) {
    const execution = executionOptions(options);
    assert.ok(!!options.out !== !!options.run, 'Use --out NEW_DIRECTORY or --run EXISTING_DIRECTORY');
    const directory = path.resolve(options.run ?? options.out);
    const loadPrepared = dependencies.loadPrepared ?? require('./prepared').loadPrepared;
    const prepare = dependencies.prepare ?? require('./prepared').prepare;
    const verify = dependencies.verifyResult ?? verifyResult;
    const launch = dependencies.runChild ?? runChild;
    const saveState = dependencies.saveState ?? save;
    if (!options.run) {
        assert.ok(!fs.existsSync(directory), 'Use a fresh fanout output directory');
        validateCards(options.cards);
        fs.mkdirSync(directory, { recursive: true });
    }
    const release = acquire(directory, options.recover === true);
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    const manifestFile = path.join(directory, 'manifest.json');
    const stateFile = path.join(directory, 'state.json');
    let state;
    try {
        let manifest;
        if (options.run) {
            manifest = read(manifestFile);
            assert.equal(manifest.schema, schema);
            assert.deepEqual(validateCards(manifest.cards), manifest.cards, 'Manifest card set is not canonical');
            if (options.cards?.length) assert.deepEqual(validateCards(options.cards), manifest.cards, 'Resume selected another card set');
            assert.ok(options.mutations === undefined || options.mutations === manifest.mutations, 'Resume changed mutation policy');
            state = read(stateFile);
            assert.equal(state.manifestSha256, digest(manifest), 'Fanout state refers to another manifest');
            assert.deepEqual(state.jobs.map(j => j.cardId), manifest.cards);
        } else {
            const cards = validateCards(options.cards);
            const preparedDirectory = options.prepared ? path.resolve(options.prepared) : path.join(directory, 'prepared');
            if (!options.prepared) await prepare({ out: preparedDirectory });
            const prepared = loadPrepared(preparedDirectory);
            for (const id of cards) assert.ok(prepared.catalogue.cards.some(c => c.setCode === id), 'Unknown card ' + id);
            manifest = { schema, cards, prepared: options.prepared ? preparedDirectory : 'prepared', externalPrepared: !!options.prepared, preparedManifestSha256: prepared.manifestSha256,
                mutations: options.mutations !== false, createdAt: now(),
                baseline: { sourceConverted: prepared.admission.irConvertedCount, runtimeAdmitted: prepared.admission.runtimeAdmittedCount } };
            writeNew(manifestFile, manifest);
            state = { schema, manifestSha256: digest(manifest), startedAt: now(), updatedAt: now(),
                requestedConcurrency: execution.jobs, maxConcurrentChildren: 0,
                jobs: cards.map(cardId => ({ cardId, status: 'pending', attempts: [] })) };
            writeNew(stateFile, state);
        }
        const preparedPath = preparedLocation(directory, manifest);
        const prepared = loadPrepared(preparedPath);
        assert.equal(prepared.manifestSha256, manifest.preparedManifestSha256, 'Prepared manifest changed');
        for (const id of manifest.cards) assert.ok(prepared.catalogue.cards.some(c => c.setCode === id), 'Unknown prepared card ' + id);
        for (const job of state.jobs) {
            if (['review-pending', 'needs-work'].includes(job.status)) {
                job.summary = verify(beneath(directory, job.attempts.at(-1).directory), job.cardId, prepared);
                job.status = job.summary.status;
            } else if (job.status === 'running') {
                const attempt = job.attempts.at(-1);
                attempt.status = 'interrupted'; attempt.finishedAt = now();
                job.status = 'pending';
            }
        }
        state.requestedConcurrency = execution.jobs;
        delete state.finishedAt;
        state.updatedAt = now(); saveState(stateFile, state);
        const pending = state.jobs.filter(j => !['review-pending', 'needs-work'].includes(j.status));
        let cursor = 0, active = 0;
        async function worker() {
            while (!controller.signal.aborted) {
                const job = pending[cursor++];
                if (!job) return;
                const parent = path.join(directory, 'cards', job.cardId);
                fs.mkdirSync(parent, { recursive: true });
                let number = job.attempts.length + 1;
                while (fs.existsSync(path.join(parent, 'attempt-' + number)) || fs.existsSync(path.join(parent, 'attempt-' + number + '.log'))) number++;
                const attemptDirectory = path.join(parent, 'attempt-' + number);
                const attempt = { number, directory: path.relative(directory, attemptDirectory), startedAt: now(), status: 'running' };
                job.attempts.push(attempt); job.status = 'running'; delete job.error; delete job.summary;
                active++; state.maxConcurrentChildren = Math.max(state.maxConcurrentChildren, active); state.updatedAt = now(); saveState(stateFile, state);
                console.error(`[${job.cardId}] started attempt ${number} (${active}/${execution.jobs} children)`);
                try {
                    const result = await launch({ cardId: job.cardId, directory: attemptDirectory, prepared: preparedPath,
                        mutations: manifest.mutations, timeoutMs: execution.timeoutMs, signal: controller.signal });
                    Object.assign(attempt, result);
                    assert.ok(!result.timedOut && !result.cancelled, result.timedOut ? 'Card attempt timed out' : 'Card attempt cancelled');
                    assert.equal(result.exitCode, 0, result.timedOut ? 'Card attempt timed out' : result.cancelled ? 'Card attempt cancelled' : 'Card child exited unsuccessfully; inspect its log/report');
                    job.summary = verify(attemptDirectory, job.cardId, prepared);
                    job.status = job.summary.status;
                    attempt.status = job.status;
                } catch (error) {
                    job.status = 'failed'; job.error = error.message;
                    attempt.status = 'failed'; attempt.error = error.message;
                } finally {
                    active--; attempt.finishedAt = now(); state.updatedAt = now(); saveState(stateFile, state);
                    console.error(`[${job.cardId}] ${job.status}`);
                }
            }
        }
        const outcomes = await Promise.allSettled(Array.from({ length: Math.min(execution.jobs, pending.length) }, async () => {
            try { await worker(); }
            catch (error) { controller.abort(); throw error; }
        }));
        const failure = outcomes.find(outcome => outcome.status === 'rejected');
        if (failure) throw failure.reason;
        // Recheck the shared inputs once all child processes have stopped.
        assert.equal(loadPrepared(preparedPath).manifestSha256, manifest.preparedManifestSha256, 'Prepared inputs drifted during fanout');
        state.finishedAt = now(); state.updatedAt = state.finishedAt; saveState(stateFile, state);
        const summary = summarize(directory, manifest, state);
        save(path.join(directory, 'summary.json'), summary);
        if (controller.signal.aborted) throw new Error('Fanout interrupted; completed evidence retained, resume with --run ' + directory);
        return summary;
    } finally {
        process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
        release();
    }
}

function status(options, dependencies = {}) {
    assert.ok(options.run, 'status needs --run DIRECTORY');
    const directory = path.resolve(options.run), manifest = read(path.join(directory, 'manifest.json'));
    assert.equal(manifest.schema, schema);
    assert.deepEqual(validateCards(manifest.cards), manifest.cards, 'Manifest card set is not canonical');
    const state = read(path.join(directory, 'state.json'));
    assert.equal(state.manifestSha256, digest(manifest));
    assert.deepEqual(state.jobs.map(j => j.cardId), manifest.cards);
    const loadPrepared = dependencies.loadPrepared ?? require('./prepared').loadPrepared;
    const prepared = loadPrepared(preparedLocation(directory, manifest));
    assert.equal(prepared.manifestSha256, manifest.preparedManifestSha256);
    for (const job of state.jobs.filter(j => ['review-pending', 'needs-work'].includes(j.status)))
        job.summary = (dependencies.verifyResult ?? verifyResult)(beneath(directory, job.attempts.at(-1).directory), job.cardId, prepared);
    return summarize(directory, manifest, state);
}
module.exports = { fanout, status, verifyResult, runChild, executionOptions, validateCards, acquire };
