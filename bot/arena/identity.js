'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

/** Logical arenas share infrastructure, never their roster, results or controller database. */
function arenaId(value = process.env.ARENA_ID || 'open') {
    if (!['open', 'v2'].includes(value)) {
        throw new Error('ARENA_ID must be open (historical arena) or v2');
    }
    return value;
}
const id = arenaId();
const stateRoot = (data, selected = id) => arenaId(selected) === 'open' ? path.resolve(data) : path.join(path.resolve(data), 'arenas', selected);
const ladderId = (round, selected = id) => {
    if (!Number.isSafeInteger(round) || round < 0) throw new Error('round must be a nonnegative integer');
    return arenaId(selected) === 'open' ? `arena-r${round}` : `arena-${selected}-r${round}`;
};
const requiredProtocol = id === 'v2' ? 2 : null;
const RUNNER_REVISION = 'swu-arena-v2/1';

/** Conservative comparison boundary: a different games build OR card catalog never borrows old results. */
function contextFor({ arenaId: selected = id, build, cards }) {
    arenaId(selected);
    if (selected === 'open' || !/^[0-9a-f]{40}$/.test(build ?? '') || !/^[0-9a-f]{64}$/.test(cards ?? '')) return null;
    return { schema: 1, arenaId: selected, protocol: 2,
        engineRevision: crypto.createHash('sha256').update(`${build}:${cards}`).digest('hex'), runnerRevision: RUNNER_REVISION };
}
function comparisonContext() {
    const root = path.join(__dirname, '..', '..');
    try {
        const readIdentity = (file, override) => {
            let actual;
            try { actual = fs.readFileSync(path.join(root, file), 'utf8').trim(); }
            catch (e) { if (e.code !== 'ENOENT') throw e; return override; }
            if (override && actual !== override) throw new Error(`${file} override conflicts with the immutable image`);
            return actual;
        };
        return contextFor({ build: readIdentity('BUILD_SHA', process.env.GAMES_BUILD), cards: readIdentity('CARDS_SHA', process.env.GAMES_CARDS) });
    } catch { return null; }
}
/** actual first, trusted expected second. Unknown or mixed context always fails closed. */
function contextProblem(actual, expected) {
    const fields = ['schema', 'arenaId', 'protocol', 'engineRevision', 'runnerRevision'];
    const valid = (v) => v && v.schema === 1 && v.arenaId === 'v2' && v.protocol === 2
        && /^[0-9a-f]{64}$/.test(v.engineRevision ?? '')
        && typeof v.runnerRevision === 'string' && v.runnerRevision.length > 0;
    if (!valid(expected)) return 'the current arena comparison context is unavailable';
    if (!valid(actual)) return 'no verified v2 arena comparison context';
    const field = fields.find((key) => actual[key] !== expected[key]);
    return field ? `the arena comparison context differs at ${field}` : null;
}
const contextMatches = (actual, expected) => contextProblem(actual, expected) === null;
function bundleProblem(actual, expected) {
    if (!expected || !Object.keys(expected).length || Object.values(expected).some((s) => !/^[0-9a-f]{64}$/.test(s ?? ''))) return 'the expected bundle digests are unavailable';
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return 'no verified execution bundle digests';
    const names = Object.keys(expected).sort();
    if (JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(names)) return 'the execution bundle names differ';
    const name = names.find((n) => actual[n] !== expected[n]);
    return name ? `the execution bundle differs for ${name}` : null;
}
/** A round declaration never substitutes for evidence from the individual executed game. */
function observationProblem(game, config) {
    if (config?.requiredProtocol !== 2) return 'the round did not require protocol v2';
    if (game?.requiredProtocol !== 2 || game.protocols?.p1 !== 2 || game.protocols?.p2 !== 2) return 'both seats did not explicitly negotiate protocol v2';
    const why = contextProblem(game.context, config.context);
    if (why) return why;
    const bundles = Object.fromEntries([...new Set([game.p1, game.p2])].map((n) => [n, config.bundles?.[n]]));
    return bundleProblem(game.bundles, bundles);
}
module.exports = { id, arenaId, stateRoot, ladderId, requiredProtocol, contextFor, comparisonContext, contextProblem, contextMatches,
    bundleProblem, observationProblem, RUNNER_REVISION };
