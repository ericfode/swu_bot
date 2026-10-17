'use strict';
// Compatibility is an observed checker handshake bound to the immutable bundle
// and checker build. A manifest declaration or the old `checked` flag is not proof.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const SCHEMA = 'swu-arena-compatibility/1';
const SHA256 = /^[0-9a-f]{64}$/;
const BUILD = /^[0-9a-f]{40}$/;
const toolEnv = () => Object.fromEntries(['PATH', 'HOME', 'LANG', 'TZ'].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));

/** The image's immutable build identity, or the checkout revision for local tests. */
function currentCheckerBuild() {
    let build;
    try {
        build = fs.readFileSync(path.join(ROOT, 'BUILD_SHA'), 'utf8').trim();
    } catch {
        const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, env: toolEnv(), encoding: 'utf8', timeout: 5000 });
        build = r.status === 0 ? r.stdout.trim() : null;
    }
    return BUILD.test(build ?? '') ? build : null;
}

/** No code is run: hash the same canonical tar the isolated checker leaves. */
function bundleDigest(folder) {
    const r = spawnSync('python3', ['-I', path.join(ROOT, 'bot', 'compiled', 'bundle.py'), 'tar', folder], {
        env: toolEnv(), timeout: 60000, maxBuffer: (68 << 20)
    });
    if (r.status !== 0) {
        throw Object.assign(new Error(`cannot identify the checked bundle: ${String(r.stderr ?? r.error?.message ?? '').trim().slice(-1000)}`), { code: 'bad_bot' });
    }
    return crypto.createHash('sha256').update(r.stdout).digest('hex');
}

/** Pure, fail-closed status for admission, provisioning and status readers. */
function compatibilityStatus(evidence, { bundleSha256, checkerBuild, context } = {}) {
    const no = (reason) => ({ compatible: false, reason });
    if (!evidence || evidence.schema !== SCHEMA) {
        return no('no verified protocol v2 handshake');
    }
    if (evidence.negotiatedProtocol !== 2) {
        return no('the checker did not observe an explicit ready.v of 2');
    }
    if (!SHA256.test(bundleSha256 ?? '')) {
        return no('the immutable bundle digest has not been verified');
    }
    if (evidence.bundleSha256 !== bundleSha256) {
        return no('the bundle differs from the one that passed the protocol v2 check');
    }
    if (!BUILD.test(evidence.checkerBuild ?? '')) {
        return no('the checker build identity is unavailable');
    }
    if (checkerBuild !== undefined && (!BUILD.test(checkerBuild ?? '') || evidence.checkerBuild !== checkerBuild)) {
        return no('the protocol v2 check belongs to another checker build');
    }
    if (typeof evidence.checkedAt !== 'string' || !Number.isFinite(Date.parse(evidence.checkedAt))) {
        return no('the protocol v2 check has no valid completion time');
    }
    if (context !== undefined) {
        const problem = require('./identity').contextProblem(evidence.context, context);
        if (problem) return no(problem);
    }
    return { compatible: true, reason: 'verified protocol v2 handshake', verification: evidence };
}

function verification(handshake, bundleSha256, checkerBuild, context) {
    const evidence = { schema: SCHEMA, negotiatedProtocol: handshake?.negotiatedProtocol, bundleSha256, checkerBuild, checkedAt: new Date().toISOString(), ...(context !== undefined ? { context: JSON.parse(JSON.stringify(context)) } : {}) };
    const status = compatibilityStatus(evidence, { bundleSha256, checkerBuild, ...(context !== undefined ? { context } : {}) });
    if (!status.compatible) {
        throw Object.assign(new Error(status.reason), { code: 'bad_bot' });
    }
    return evidence;
}

module.exports = { currentCheckerBuild, bundleDigest, compatibilityStatus, verification, SCHEMA };
