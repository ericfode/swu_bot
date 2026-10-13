'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { digest, validateReview } = require('./coverage');
const reference = require('../reference/library');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const read = p => JSON.parse(fs.readFileSync(p));
const check = (v, message) => { if (!v) throw new Error(message); };
function relative(p) {
    check(typeof p === 'string' && p && !path.isAbsolute(p) && !p.split('/').some(x => x === '..' || x === '.'), 'Expected repository-relative path');
    return p;
}
function commit(repo, ref) {
    check(typeof ref === 'string' && /^[0-9a-f]{40}$/.test(ref), 'Use an exact full commit SHA');
    return execFileSync('git', ['-C', repo, 'rev-parse', '--verify', ref + '^{commit}'], { encoding: 'utf8' }).trim();
}
function blob(repo, sha, file) {
    return execFileSync('git', ['-C', repo, 'show', sha + ':' + relative(file)], { maxBuffer: 64 * 1024 * 1024 });
}
function ids(bytes) {
    const rows = JSON.parse(bytes).runtimeAdmittedCards;
    check(Array.isArray(rows) && rows.every(r => typeof r.setCode === 'string'), 'Invalid admission report');
    const result = rows.map(r => r.setCode).sort();
    check(new Set(result).size === result.length, 'Duplicate admitted card');
    return result;
}
function write(file, value) {
    const temporary = file + '.' + crypto.randomUUID();
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(temporary, file);
}
function locked(out, fn) {
    const lock = path.join(out, '.checkpoint-lock');
    fs.mkdirSync(lock); // Never steal stale owners.
    try { return fn(); } finally { fs.rmdirSync(lock); }
}
function init(out, { repositoryRoot, baselineCommit, admissionPath }) {
    const repo = fs.realpathSync(repositoryRoot);
    out = path.resolve(out);
    check(out !== repo && !out.startsWith(repo + path.sep), 'Keep cadence artifacts outside repository');
    const sha = commit(repo, baselineCommit), bytes = blob(repo, sha, admissionPath);
    const baseline = { repositoryRoot: repo, baselineCommit: sha, admissionPath: relative(admissionPath), admissionSha256: hash(bytes), admissionIds: ids(bytes) };
    fs.mkdirSync(out, { recursive: true });
    return locked(out, () => {
        const file = path.join(out, 'checkpoint.json');
        const baselineFile = path.join(out, 'baseline.json');
        if (fs.existsSync(baselineFile)) check(digest(read(baselineFile)) === digest(baseline), 'Immutable baseline changed');
        else fs.writeFileSync(baselineFile, JSON.stringify(baseline, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
        if (fs.existsSync(file)) {
            const state = read(file);
            check(digest(state.baseline) === digest(baseline), 'Cadence baseline changed');
            return state;
        }
        const state = { schema: 'swu-card-rebuild-cadence/v1', interval: 200, baseline, completedCardIds: [], runs: [], jobs: [] };
        write(file, state);
        return state;
    });
}
function status(out) {
    const state = read(path.join(out, 'checkpoint.json'));
    check(digest(read(path.join(out, 'baseline.json'))) === digest(state.baseline), 'Immutable baseline changed');
    const derived = state.runs.flatMap(r => r.newlyCompletedCardIds).sort();
    check(new Set(derived).size === derived.length && derived.every(id => /^[A-Z][A-Z0-9]{2,3}_\d{3}$/.test(id)), 'Invalid completed card identities');
    check(digest(derived) === digest(state.completedCardIds), 'Completed card ledger differs from reviewed runs');
    for (const run of state.runs) for (const item of run.evidence)
        check(hash(fs.readFileSync(path.join(out, item.path))) === item.sha256, 'Immutable cadence evidence changed');
    for (const job of state.jobs) check(digest(read(job.path)) === job.sha256, 'Immutable full-check job changed');
    return state;
}
function recordReviewedRun(out, { pipelineDirectory, beforeCommit, integrationCommit, admissionPath, reviewPath }) {
    return locked(out, () => {
        const file = path.join(out, 'checkpoint.json'), state = status(out), repo = state.baseline.repositoryRoot;
        check(state.schema === 'swu-card-rebuild-cadence/v1' && state.interval === 200, 'Invalid cadence state');
        const baselineBytes = blob(repo, state.baseline.baselineCommit, state.baseline.admissionPath);
        check(hash(baselineBytes) === state.baseline.admissionSha256 && digest(ids(baselineBytes)) === digest(state.baseline.admissionIds), 'Initial baseline changed');
        check(!admissionPath || admissionPath === state.baseline.admissionPath, 'Admission path changed');
        const before = commit(repo, beforeCommit), after = commit(repo, integrationCommit);
        execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', state.baseline.baselineCommit, before]);
        execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', before, after]);
        const beforeBytes = blob(repo, before, state.baseline.admissionPath), afterBytes = blob(repo, after, state.baseline.admissionPath);
        const packet = read(path.join(pipelineDirectory, 'review/packet.json'));
        const reviewBytes = fs.readFileSync(reviewPath || path.join(pipelineDirectory, 'review/result.json'));
        const review = validateReview(JSON.parse(reviewBytes), packet);
        check(review.reviewer.model === 'gpt-6.1-sol' && ['high','xhigh','max','ultra'].includes(review.reviewer.effort), 'Requires independent HIGH review');
        check(review.cards.every(c => c.verdict !== 'incomplete' && !c.findings.some(f => f.kind === 'bug' || f.kind === 'question')), 'Review is not accepted');
        const report = read(path.join(pipelineDirectory, 'report.json'));
        check(report.schema === 'swu-card-pipeline-run/v1' && !report.failure && report.comparisons.length > 0 && report.comparisons.every(c => c.matched === true || c.status === 'matched'), 'Pipeline comparisons not accepted');
        check(report.review?.packetSha256 === digest(packet), 'Report packet binding changed');
        const catalogueBytes = blob(repo, after, 'bot/card-compiler/generated/catalog.json');
        check(report.catalogueSha256 === hash(catalogueBytes) && packet.catalogueSha256 === hash(catalogueBytes), 'Committed catalogue differs');
        const admission = JSON.parse(afterBytes), catalogue = JSON.parse(catalogueBytes);
        check(admission.schema === 'omni-rs-catalogue-report-v1' && digest(read(path.join(pipelineDirectory, 'admission.json'))) === digest(admission), 'Committed admission differs from pipeline');
        check(digest(packet.comparisons) === digest(report.comparisons), 'Packet comparisons changed');
        check(report.plansSha256 === digest(packet.cards.map(c => c.probes)), 'Plan binding changed');
        check(digest(report.coverage) === digest(packet.cards.map(c => c.coverage)), 'Coverage binding changed');
        check(digest(report.mutations) === digest(packet.mutations), 'Mutation binding changed');
        for (const card of packet.cards) {
            const entry = catalogue.cards.find(e => e.setCode === card.cardId);
            check(entry && digest(card.printedCard) === digest(entry.card) && digest(card.configuration) === digest(entry.abilities) && card.sourceHash === entry.sourceHash && card.sourcePath === entry.sourcePath && digest(card.attachCondition) === digest(entry.attachCondition ?? null) && digest(card.intrinsicKeywordValues) === digest(entry.keywordValues ?? {}), 'Card catalogue binding changed');
        }
        const checkReceipts = ['auto','interpreter'].map(backend => ({ backend, receipt: read(path.join(pipelineDirectory, 'check-' + backend + '.json')) }));
        for (const { backend, receipt } of checkReceipts) {
            check(receipt.schema === 'swu-reference-check/v1' && receipt.identities.catalogueSha256 === hash(catalogueBytes), 'Backend catalogue changed');
            check(/^[a-f0-9]{64}$/.test(receipt.identities.nativeSha256), 'Missing native binary identity');
            if (backend === 'auto') check(receipt.identities.wasmPackage && ['omni_wasm.js','omni_wasm_bg.wasm'].every(k => /^[a-f0-9]{64}$/.test(receipt.identities.wasmPackage[k])), 'Missing Wasm package identity');
            const expected = receipt.results.map(r => ({ ...r, runtime: (r.runtime === 'native' ? 'native' : 'wasm') + '-' + backend, identities: receipt.identities }));
            const actual = report.comparisons.filter(r => r.runtime.endsWith('-' + backend));
            check(actual.length === expected.length, 'Backend receipt count differs');
            for (const result of actual) {
                const rows = expected.filter(r => r.caseId === result.caseId && r.traceSha256 === result.traceSha256 && r.runtime === result.runtime);
                check(rows.length === 1 && Object.entries(rows[0]).every(([key,value]) => digest(result[key]) === digest(value)), 'Backend receipt changed');
            }
            const dispatch = path.join(pipelineDirectory, 'dispatch-' + backend);
            check(digest(fs.readdirSync(dispatch).sort().map(f => read(path.join(dispatch,f)))) === digest(packet.rules.execution[backend]), 'Rule execution binding changed');
        }
        const corpusDirectory = path.join(pipelineDirectory, 'reference');
        reference.verify(corpusDirectory);
        const recordings = reference.corpus(corpusDirectory).recordings;
        const planned = new Map(packet.cards.flatMap(c => c.probes.cases).map(c => [c.id, c]));
        check(recordings.length === planned.size && new Set(recordings.map(r => r.caseId)).size === planned.size, 'Reference case inventory differs');
        check(report.comparisons.length === recordings.length * 3, 'Comparison count differs');
        for (const row of recordings) {
            check(digest(row.caseDefinition) === digest(planned.get(row.caseId)), 'Reference construction differs');
            check(row.engineOnly === false && row.provenance.sourceCatalogueSha256 === hash(catalogueBytes), 'Reference source provenance differs');
            for (const runtime of ['native-auto','native-interpreter','wasm-auto']) {
                const rows = report.comparisons.filter(c => c.caseId === row.caseId && c.runtime === runtime);
                check(rows.length === 1 && rows[0].matched === true, 'Missing exact backend comparison');
                for (const key of ['traceSha256','poolSha256','decisions','windows']) check(rows[0][key] === row[key], 'Reference comparison differs: ' + key);
            }
        }
        for (const card of review.cards.filter(c => ids(afterBytes).includes(c.cardId) && !ids(beforeBytes).includes(c.cardId) && !state.baseline.admissionIds.includes(c.cardId) && /^[A-Z][A-Z0-9]{2,3}_\d{3}$/.test(c.cardId))) {
            const rows = report.coverage.filter(c => c.cardId === card.cardId);
            check(rows.length === 1 && rows[0].obligations.some(o => o.status === 'matched'), 'No actual constructed card witness: ' + card.cardId);
            const caseIds = new Set(report.comparisons.filter(c => packet.cards.find(p => p.cardId === card.cardId).probes.cases.some(p => p.id === c.caseId)).map(c => c.caseId));
            check(caseIds.size > 0, 'No source case comparison');
            for (const id of caseIds) for (const backend of ['native-auto', 'native-interpreter', 'wasm-auto'])
                check(report.comparisons.some(c => c.caseId === id && c.runtime === backend && c.matched === true), 'Incomplete three-backend comparisons');
        }
        check(packet.implementation.length > 0, 'Missing implementation inventory');
        for (const item of packet.implementation) check(hash(blob(repo, after, item.path)) === item.sha256, 'Integration implementation differs: ' + item.path);
        const baseline = new Set(state.baseline.admissionIds), prior = new Set(ids(beforeBytes)), done = new Set(state.completedCardIds), selected = new Set(review.cards.map(c => c.cardId));
        const newly = ids(afterBytes).filter(id => !prior.has(id) && !baseline.has(id) && !done.has(id) && selected.has(id) && /^[A-Z][A-Z0-9]{2,3}_\d{3}$/.test(id));
        const identity = digest({ before, after, packet: digest(packet), review: hash(reviewBytes) });
        if (state.runs.some(r => r.id === identity)) return state;
        const evidenceDir = path.join(out, 'evidence', identity);
        fs.mkdirSync(evidenceDir, { recursive: true });
        const evidence = [];
        for (const [name, bytes] of [['packet.json', Buffer.from(JSON.stringify(packet))], ['review.json', reviewBytes], ['report.json', Buffer.from(JSON.stringify(report))], ...checkReceipts.map(({backend,receipt}) => ['check-' + backend + '.json', Buffer.from(JSON.stringify(receipt))]), ['before-admission.json', beforeBytes], ['after-admission.json', afterBytes], ['pipeline-admission.json', fs.readFileSync(path.join(pipelineDirectory, 'admission.json'))]]) {
            const destination = path.join(evidenceDir, name);
            if (fs.existsSync(destination)) check(hash(fs.readFileSync(destination)) === hash(bytes), 'Cadence evidence changed');
            else fs.writeFileSync(destination, bytes, { flag: 'wx' });
            evidence.push({ path: path.relative(out, destination), sha256: hash(bytes) });
        }
        const corpusFiles = ['manifest.json', ...recordings.map(r => 'traces/' + r.traceSha256 + '.jsonl.gz'), ...recordings.map(r => 'pools/' + r.poolSha256 + '.json')];
        for (const name of new Set(corpusFiles)) {
            const bytes = fs.readFileSync(path.join(corpusDirectory, name));
            const destination = path.join(evidenceDir, 'reference', name);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            if (fs.existsSync(destination)) check(hash(fs.readFileSync(destination)) === hash(bytes), 'Copied reference evidence changed');
            else fs.writeFileSync(destination, bytes, { flag: 'wx' });
            evidence.push({ path: path.relative(out, destination), sha256: hash(bytes) });
        }
        const time = execFileSync('git', ['-C', repo, 'show', '-s', '--format=%cI', after], { encoding: 'utf8' }).trim(), oldCount = done.size;
        newly.forEach(id => done.add(id));
        state.completedCardIds = [...done].sort();
        state.runs.push({ id: identity, evidence, beforeCommit: before, integrationCommit: after, beforeAdmissionSha256: hash(beforeBytes), afterAdmissionSha256: hash(afterBytes), packetSha256: digest(packet), reviewSha256: hash(reviewBytes), recordedAt: time, newlyCompletedCardIds: newly });
        for (let n = Math.floor(oldCount / 200) + 1; n <= Math.floor(done.size / 200); n++) {
            const job = { schema: 'swu-card-full-check-job/v1', id: 'full-rebuild-' + n * 200, state: 'pending', boundary: n * 200, snapshotCommit: after, createdAt: time, runs: state.runs.map(r => ({ ...r })), newCardIds: state.completedCardIds, instructions: 'Use a dedicated background Codex agent. Check out this exact commit in an isolated clean directory; perform full clean builds and full corpus checks. Record immutable logs and failures; enqueue separate fix tasks. Do not mutate canonical files, import corpus, or push. This job does not block card authors.' };
            const jobFile = path.join(out, job.id + '.json');
            if (fs.existsSync(jobFile)) check(digest(read(jobFile)) === digest(job), 'Existing full-check job differs');
            else write(jobFile, job);
            state.jobs.push({ id: job.id, state: 'pending', path: jobFile, sha256: digest(job), snapshotCommit: after });
        }
        write(file, state);
        return state;
    });
}
module.exports = { init, status, recordReviewedRun };
