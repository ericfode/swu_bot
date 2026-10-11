'use strict';

/**
 * Summarize an inspector Profiler.stop().profile without external dependencies.
 * Usage: const { summarize } = require('./cpu-summary.cjs'); summarize(profile);
 * Pass { excludeInspector: true } to omit stacks containing node:inspector.
 *
 * CPU profiles contain samples, not exact timings. Attribute each preceding
 * timeDelta to its sample, in microseconds. Do not invent time for a missing
 * delta, an unknown node, or the unsampled tail of the recording.
 */
function summarize(profile, { excludeInspector = false } = {}) {
    if (!profile || !Array.isArray(profile.nodes) || !Array.isArray(profile.samples) || !Array.isArray(profile.timeDeltas)) {
        throw new TypeError('expected an inspector CPU profile with nodes, samples and timeDeltas');
    }

    const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
    const parents = new Map();
    for (const node of profile.nodes) {
        for (const child of node.children ?? []) {
            parents.set(child, node.id);
        }
    }

    const frames = new Map();
    const frameOf = (id) => {
        if (frames.has(id)) {
            return frames.get(id);
        }
        const call = nodes.get(id)?.callFrame ?? {};
        const frame = {
            name: call.functionName || '(anonymous)',
            url: call.url || '',
            line: Number.isInteger(call.lineNumber) && call.lineNumber >= 0 ? call.lineNumber + 1 : null
        };
        frame.key = JSON.stringify([frame.name, frame.url, frame.line]);
        frames.set(id, frame);
        return frame;
    };

    const self = new Map();
    const inclusive = new Map();
    const add = (table, frame, us) => {
        if (frame.name === '(root)') {
            return;
        }
        const entry = table.get(frame.key);
        if (entry) {
            entry.us += us;
        } else {
            table.set(frame.key, { name: frame.name, url: frame.url, line: frame.line, us });
        }
    };

    let sampledUs = 0;
    let includedUs = 0;
    let excludedInspectorUs = 0;
    let includedSampleCount = 0;
    let excludedInspectorSamples = 0;
    let unknownUs = 0;
    let gcUs = 0;
    let idleUs = 0;
    let missingDeltaSamples = 0;
    for (let i = 0; i < profile.samples.length; i++) {
        const us = profile.timeDeltas[i];
        if (!Number.isFinite(us) || us < 0) {
            missingDeltaSamples++;
            continue;
        }
        sampledUs += us;
        const id = profile.samples[i];
        if (!nodes.has(id)) {
            unknownUs += us;
            includedUs += us;
            includedSampleCount++;
            continue;
        }

        // A recursive function can occur more than once on one sampled stack.
        // Charge it once inclusively; also tolerate cycles in malformed input.
        const visitedNodes = new Set();
        const stack = new Map();
        for (let at = id; nodes.has(at) && !visitedNodes.has(at); at = parents.get(at)) {
            visitedNodes.add(at);
            const frame = frameOf(at);
            stack.set(frame.key, frame);
        }
        if (excludeInspector && [...stack.values()].some((frame) => frame.url === 'node:inspector')) {
            excludedInspectorUs += us;
            excludedInspectorSamples++;
            continue;
        }
        includedUs += us;
        includedSampleCount++;
        const leaf = frameOf(id);
        add(self, leaf, us);
        if (leaf.name === '(garbage collector)') {
            gcUs += us;
        }
        if (leaf.name === '(idle)') {
            idleUs += us;
        }

        for (const frame of stack.values()) {
            add(inclusive, frame, us);
        }
    }

    const percent = (us) => includedUs ? us / includedUs * 100 : 0;
    const timing = (us) => ({ ms: us / 1000, percent: percent(us) });
    const top = (table) => [...table.values()]
        .sort((a, b) => b.us - a.us || a.name.localeCompare(b.name) || a.url.localeCompare(b.url) || (a.line ?? -1) - (b.line ?? -1))
        .slice(0, 30)
        .map(({ name, url, line, us }) => ({ name, url, line, ...timing(us) }));
    const durationUs = Number.isFinite(profile.startTime) && Number.isFinite(profile.endTime)
        ? Math.max(0, profile.endTime - profile.startTime) : null;

    return {
        note: 'Approximate sampled wall time; percentages use includedSampleMs, after optional inspector filtering. sampledMs and unaccountedMs describe the original recording. Inclusive rows overlap. Lines are 1-based; native frames have no line. Each table shows at most 30 frames.',
        durationMs: durationUs === null ? null : durationUs / 1000,
        sampledMs: sampledUs / 1000,
        sampleCount: profile.samples.length,
        includedSampleMs: includedUs / 1000,
        includedSampleCount,
        excludedInspectorMs: excludedInspectorUs / 1000,
        excludedInspectorSamples,
        unaccountedMs: durationUs === null ? null : Math.max(0, durationUs - sampledUs) / 1000,
        unknownSampleMs: unknownUs / 1000,
        missingDeltaSamples,
        gc: timing(gcUs),
        idle: timing(idleUs),
        self: top(self),
        inclusive: top(inclusive)
    };
}

module.exports = { summarize };
