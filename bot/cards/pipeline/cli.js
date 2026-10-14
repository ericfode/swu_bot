#!/usr/bin/env node
'use strict';
const { compileCatalog } = require('../../card-compiler/build');
const { planCards, run, recordReview } = require('./run');
const { coverage, digest } = require('./coverage');
function options(args) {
    const o = { cards: [] };
    const lists = { '--card': 'cards', '--cards': 'cards', '--paths': 'paths', '--evidence': 'evidencePaths' };
    const values = { '--out': 'out', '--run': 'run', '--file': 'file', '--prepared': 'prepared',
        '--jobs': 'jobs', '--timeout-ms': 'timeoutMs', '--limit': 'limit', '--worker': 'workerId',
        '--job': 'jobId', '--token': 'token', '--reason': 'reason', '--result': 'resultPath', '--patch': 'patchPath',
        '--baseline-commit': 'baselineCommit', '--before-commit': 'beforeCommit', '--integration-commit': 'integrationCommit',
        '--pipeline': 'pipelineDirectory', '--admission': 'admissionPath' };
    for (let i = 0; i < args.length; i++) {
        const flag = args[i];
        if (flag === '--no-mutations') o.mutations = false;
        else if (flag === '--remaining') o.remaining = true;
        else if (flag === '--recover') o.recover = true;
        else if (flag === '--blocked') o.blocked = true;
        else if (flag === '--resume-blocked') o.resumeBlocked = true;
        else if (lists[flag] || values[flag]) {
            const value = args[++i];
            if (!value || value.startsWith('--')) throw new Error('Missing ' + flag + ' value');
            if (lists[flag]) (o[lists[flag]] ??= []).push(...value.split(','));
            else o[values[flag]] = value;
        } else throw new Error('Unknown option ' + flag);
    }
    return o;
}
function workBaseline() {
    const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process');
    const { sha256 } = require('../inventory');
    const repositoryRoot = path.resolve(__dirname, '../../..');
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
    const names = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean);
    const inventory = {};
    for (const name of [...new Set(names)].sort()) {
        if (/(^|\/)(?:\.env(?:\..*)?|node_modules|target|\.git)(?:\/|$)/.test(name)) continue;
        const file = path.join(repositoryRoot, name);
        if (fs.existsSync(file) && fs.lstatSync(file).isFile()) inventory[name] = sha256(fs.readFileSync(file));
    }
    return { repositoryRoot, revision, implementationHash: digest(inventory), inventory };
}
async function work(action, o) {
    const assert = require('node:assert/strict');
    const queue = require('./work-queue');
    if (action === 'init') {
        assert.ok(o.out && !o.run, 'work init needs --out NEW_DIRECTORY');
        const catalogue = compileCatalog();
        let cards = o.cards;
        if (o.remaining) {
            assert.equal(cards.length, 0, 'Use --remaining or --cards, not both');
            const admission = require('../../card-compiler/generated/runtime-admission.json');
            const admitted = new Set(admission.runtimeAdmittedCards.map(c => c.setCode));
            const limit = Number(o.limit ?? 20);
            assert.ok(Number.isSafeInteger(limit) && limit >= 1 && limit <= 20, '--limit must be 1 through 20');
            cards = catalogue.cards.filter(c => c.status === 'supported' && !admitted.has(c.setCode)).map(c => c.setCode).sort().slice(0, limit);
        }
        assert.ok(cards.length && cards.length <= 20, 'Select between 1 and 20 independent card jobs');
        const plans = planCards(catalogue, cards);
        return queue.init(o.out, { catalogue, cardIds: cards, baseline: workBaseline(), plans });
    }
    assert.ok(o.run, 'work command needs --run QUEUE_DIRECTORY');
    if (action === 'status') return queue.status(o.run);
    if (action === 'claim') return queue.claim(o.run, { jobId: o.jobId, workerId: o.workerId, paths: o.paths ?? [], resumeBlocked: o.resumeBlocked });
    if (action === 'release') return queue.release(o.run, { jobId: o.jobId, workerId: o.workerId, token: o.token, reason: o.reason, blocked: o.blocked });
    if (action === 'submit') return queue.submit(o.run, { jobId: o.jobId, workerId: o.workerId, token: o.token,
        resultPath: o.resultPath, patchPath: o.patchPath, evidencePaths: o.evidencePaths ?? [] });
    throw new Error('Usage: cards:pipeline work init|status|claim|release|submit');
}
async function checkpoints(action, o) {
    const assert = require('node:assert/strict'), path = require('node:path');
    const cadence = require('./checkpoints');
    const repositoryRoot = path.resolve(__dirname, '../../..');
    const admissionPath = o.admissionPath ?? 'bot/card-compiler/generated/runtime-admission.json';
    if (action === 'init') {
        assert.ok(o.out && !o.run && o.baselineCommit, 'checkpoints init needs --out NEW_DIRECTORY and --baseline-commit COMMIT');
        return cadence.init(o.out, { repositoryRoot, baselineCommit: o.baselineCommit, admissionPath });
    }
    assert.ok(o.run, 'checkpoints command needs --run CHECKPOINT_DIRECTORY');
    if (action === 'status') return cadence.status(o.run);
    if (action === 'record') {
        assert.ok(o.pipelineDirectory && o.beforeCommit && o.integrationCommit, 'checkpoints record needs --pipeline RUN_DIRECTORY, --before-commit COMMIT and --integration-commit COMMIT');
        return cadence.recordReviewedRun(o.run, { pipelineDirectory: o.pipelineDirectory, beforeCommit: o.beforeCommit,
            integrationCommit: o.integrationCommit, admissionPath, reviewPath: o.file });
    }
    throw new Error('Usage: cards:pipeline checkpoints init|record|status');
}
async function main(args) {
    const [cmd, ...rest] = args;
    if (cmd === 'work') return work(rest[0], options(rest.slice(1)));
    if (cmd === 'checkpoints') return checkpoints(rest[0], options(rest.slice(1)));
    const o = options(rest);
    if (cmd === 'plan') {
        const catalogue = compileCatalog(), plans = planCards(catalogue, o.cards);
        return { plans, coverage: coverage(plans) };
    }
    if (cmd === 'prepare') {
        const p = await require('./prepared').prepare(o);
        return { directory: p.directory, manifestPath: p.manifestPath, manifestSha256: p.manifestSha256, catalogueSha256: p.catalogueSha256, sourceConverted: p.admission.irConvertedCount, runtimeAdmitted: p.admission.runtimeAdmittedCount };
    }
    if (cmd === 'run') return run(o);
    if (cmd === 'review') return recordReview(o);
    if (cmd === 'fanout') return require('./fanout').fanout(o);
    if (cmd === 'fanout-status') return require('./fanout').status(o);
    throw new Error('Usage: cards:pipeline plan|prepare|run|review|fanout|fanout-status|work|checkpoints; see bot/cards/PIPELINE.md');
}
if (require.main === module)
    main(process.argv.slice(2))
        .then(r => {
            console.log(JSON.stringify(r, null, 2));
            if (r?.schema === 'swu-card-fanout/v1' && (r.counts.failed || r.counts.pending || r.counts.running)) process.exitCode = 1;
        })
        .catch(e => { console.error(e.stack ?? e); process.exitCode = 1; });
module.exports = { options, main, work, workBaseline, checkpoints };
