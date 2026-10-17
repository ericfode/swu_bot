// @ts-nocheck -- portable JavaScript boundary fixture retained as supplied.
// Run with Node 22: SWU_BOUNDARY_REPO=/absolute/swu_bot node --test resume-context.test.mjs
// All games and archives here are inert local fixtures. No submitted code or real engine is loaded.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const repo = path.resolve(process.env.SWU_BOUNDARY_REPO || path.join(import.meta.dirname, '..', '..', '..'));
process.env.ARENA_ID = 'v2';
delete process.env.SWU_WINDOW;
const require = createRequire(path.join(repo, 'server', 'package.json'));
const { Effect } = require('effect');
const identity = require(path.join(repo, 'bot', 'arena', 'identity.js'));
for (const api of ['contextFor', 'comparisonContext', 'contextMatches', 'contextProblem']) {
    assert.equal(typeof identity[api], 'function', `identity.${api} must be present; do not silently omit the boundary`);
}
// Respect real image IDs when running inside an image; source checkouts use explicit absent-file fixture IDs.
const imageIdentity = (name, fallback) => existsSync(path.join(repo, name)) ? readFileSync(path.join(repo, name), 'utf8').trim() : fallback;
const BUILD = imageIdentity('BUILD_SHA', 'c'.repeat(40)), CARDS = imageIdentity('CARDS_SHA', 'd'.repeat(64));
assert.match(BUILD, /^[0-9a-f]{40}$/, 'the current build identity must be valid');
assert.match(CARDS, /^[0-9a-f]{64}$/, 'the current card identity must be valid');
const CURRENT = identity.contextFor({ arenaId: 'v2', build: BUILD, cards: CARDS });
assert.ok(CURRENT && CURRENT.arenaId === 'v2' && CURRENT.protocol === 2);
const originalComparisonContext = identity.comparisonContext;
identity.comparisonContext = () => structuredClone(CURRENT);
after(() => { identity.comparisonContext = originalComparisonContext; });
const load = (file) => import(pathToFileURL(path.join(repo, 'server', 'src', 'games', `${file}.ts`)).href);
const [{ readConfig, TIMING }, { GamesctlFailed }, { loadArenaJs }, { playRound }, scheduleApi, { Store }, { ladderConfig }] =
    await Promise.all(['Config', 'Gamesctl', 'Js', 'Round', 'Schedule', 'Store', 'Results'].map(load));
const { buildSchedule, jobFor, keyId, roundSeed, runKey } = scheduleApi;
const { limitsFor } = await load('Types');
const js = loadArenaJs(repo);
const root = mkdtempSync(path.join(tmpdir(), 'arena-v2-resume-context-'));
after(() => rmSync(root, { recursive: true, force: true }));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SECRET = '6'.repeat(64), K = 17;
const BOTS = ['new-v1', 'anchor-v1'];
const canonicalArchives = new Map();
/** Valid inert wasm with an empty _start export. Packaging only validates/reads it; nothing executes it. */
const canonicalArchive = (label) => {
    if (canonicalArchives.has(label)) return canonicalArchives.get(label);
    const folder = mkdtempSync(path.join(root, 'bundle-'));
    writeFileSync(path.join(folder, 'bot.wasm'), Buffer.from('0061736d0100000001040160000003020100070a01065f737461727400000a040102000b', 'hex'));
    writeFileSync(path.join(folder, 'arena.json'), JSON.stringify({ schema: 'swu-arena-bot/1', protocol: 2,
        kind: 'wasm', platform: 'wasm32-wasip1', runtime: 'wasi-p1', run: { cmd: './bot.wasm' } }));
    writeFileSync(path.join(folder, 'fixture.txt'), label);
    const tool = path.join(repo, 'bot', 'compiled', 'bundle.py');
    const options = { env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }, timeout: 10000, maxBuffer: 1 << 20 };
    const validation = spawnSync('python3', ['-I', tool, folder], options);
    assert.equal(validation.status, 0, `canonical fixture manifest validation: ${validation.stderr}`);
    const packed = spawnSync('python3', ['-I', tool, 'tar', folder], options);
    assert.equal(packed.status, 0, `canonical fixture packaging: ${packed.stderr}`);
    canonicalArchives.set(label, packed.stdout);
    return packed.stdout;
};
const MUTATIONS = ['createRound', 'replaceRound', 'updateRound', 'startGames', 'finishGame', 'setKey', 'set'];
const withStore = (c, f) => Effect.runPromise(Effect.gen(function* () {
    return yield* f(yield* Store);
}).pipe(Effect.provide(Store.layerFile(c.paths.db))));
const readState = (store) => Effect.gen(function* () {
    return { row: yield* store.round(K), games: yield* store.games(K) };
});
const tree = (dir) => {
    const out = {};
    const walk = (folder) => {
        if (!existsSync(folder)) return;
        for (const name of readdirSync(folder).sort()) {
            const file = path.join(folder, name), stat = lstatSync(file);
            assert.ok(!stat.isSymbolicLink(), 'the fixture contains no links');
            if (stat.isDirectory()) walk(file);
            else out[path.relative(dir, file)] = readFileSync(file).toString('base64');
        }
    };
    walk(dir);
    return out;
};
const resultOf = (game, key, { context, bundles, protocols = { p1: 2, p2: 2 } }) => ({
    seed: game.seed, outcome: 'won', winner: game.p1, winnerSeat: 'p1', round: 3, steps: 12, ms: 1,
    by: null, faultKind: null, key, requiredProtocol: 2, protocols, context: structuredClone(context), bundles: { ...bundles }
});
const replayOf = (game, result) => [
    { t: 'header', v: 1, seed: game.seed, requiredProtocol: 2, context: result.context, bundles: result.bundles,
        players: [{ id: 'p1', bot: game.p1 }, { id: 'p2', bot: game.p2 }] },
    { t: 'end', outcome: result.outcome, winner: result.winnerSeat, round: result.round, steps: result.steps,
        by: null, faultKind: null, requiredProtocol: result.requiredProtocol, protocols: result.protocols, context: result.context, bundles: result.bundles }
].map((line) => JSON.stringify(line)).join('\n') + '\n';

/** One durable ordinary or placement pair, cut after its first inert fake result. */
const fixture = async ({ context = CURRENT, specProtocol = 2, protocols = { p1: 2, p2: 2 }, gzip = false, rowArena = 'v2', placement = true, decks = null, reserved = true } = {}) => {
    const c = readConfig({ GAMES_DATA: mkdtempSync(path.join(root, 'case-')), GAMES_APP: repo, ARENA_ID: 'v2',
        GAMES_PLACEMENT_MODE: 'immediate', GAMES_BUILD: BUILD, GAMES_CARDS: CARDS },
    { ...TIMING, laneTickMs: 1, publishMs: 60000 });
    mkdirSync(c.paths.bundles, { recursive: true });
    const bundles = Object.fromEntries(BOTS.map((bot) => {
        const bytes = canonicalArchive(`inert fixture for ${bot}`), digest = sha(bytes);
        writeFileSync(path.join(c.paths.bundles, `${digest}.tar`), bytes);
        return [bot, digest];
    }));
    const spec = { round: K, arena: 'v2', requiredProtocol: specProtocol, context: structuredClone(context),
        ...(placement ? { placement: { version: BOTS[0], ref: 'window:context-fixture', adaptive: true, excludedSeeds: [] } } : {}),
        bots: [...BOTS], gamesPerPair: 2, capMs: 1000, decks, bundles, botInfo: {} };
    if (specProtocol === undefined) delete spec.requiredProtocol;
    const firstSeed = roundSeed(SECRET, K, 'v2'), key = runKey(SECRET, K, 'v2');
    const games = buildSchedule(js, spec, firstSeed), finished = games[0];
    assert.equal(games.length, 2, 'the integrated adaptive schedule must be one mirrored pair');
    const result = resultOf(finished, js.gameKey(key, firstSeed), { context, bundles, protocols });
    if (protocols === undefined) delete result.protocols;
    const row = { k: K, arena: rowArena, spec, firstSeed, keyId: keyId(key), workers: 1, state: 'playing',
        boot: 'earlier-boot', attempts: 0, why: placement ? 'placement' : 'changed', createdAt: '2026-10-17T00:00:00.000Z', endedAt: null };
    if (reserved) await withStore(c, (store) => store.createRound(row, games.map((game, ord) => ({
        ...game, ord, decks: game.decks ?? null, host: null, state: ord === 0 ? 'done' : 'todo',
        result: ord === 0 ? result : null, key: null, endedAt: ord === 0 ? '2026-10-17T00:00:01.000Z' : null, started: ord === 0 ? 0 : null
    }))));
    const id = `arena-v2-r${K}`, dir = path.join(c.paths.results, id);
    mkdirSync(path.join(dir, 'games'), { recursive: true });
    const config = { ...ladderConfig({ spec, arena: 'v2', firstSeed, workers: 1,
        limits: { maxSteps: 6000, capMs: 1000, hangMs: 32000, gameMs: 604000 }, keyId: row.keyId }),
    arena: 'v2', requiredProtocol: specProtocol, context: structuredClone(context), bundles: { ...bundles }, placement: spec.placement };
    if (specProtocol === undefined) delete config.requiredProtocol;
    const entry = { ...finished, ...result, rounds: result.round, host: null };
    const ladder = { schema: 'swu-ladder/1', id, createdAt: row.createdAt, status: 'running', engine: null, config,
        games: [entry], progress: { scheduled: 2, finished: 1, rated: 1, outcomes: { won: 1 } } };
    const ladderFile = path.join(dir, 'ladder.json');
    if (reserved) writeFileSync(ladderFile, JSON.stringify(ladder));
    const replay = replayOf(finished, result), replayFile = path.join(dir, 'games', `${finished.id}.jsonl${gzip ? '.gz' : ''}`);
    if (reserved) writeFileSync(replayFile, gzip ? gzipSync(replay) : replay);
    return { c, spec, row, games, finished, result, dir, ladder, ladderFile, replayFile, firstSeed, key };
};

const resume = async (f, { currentSpec = f.spec, settings = {}, verifyError = null, secret = SECRET } = {}) => {
    const calls = { round: 0, roundArgs: [], verify: 0, publish: 0, play: [], mutations: [], events: [] };
    const no = Effect.die(new Error('unexpected root child or executor command'));
    const gamesctl = { setup: no, warm: no, plan: () => no, decks: () => no, intake: () => no, push: () => no,
        // Metadata-only root verifier; actual immutable-folder transport has its own fixtures.
        verifyRound: (spec) => Effect.try({ try: () => {
            calls.verify++;
            calls.events.push('verify');
            assert.deepEqual(spec, f.spec, 'verification receives the original frozen spec');
            if (verifyError) throw new Error(verifyError);
            for (const [name, digest] of Object.entries(spec.bundles)) {
                if (sha(readFileSync(path.join(f.c.paths.bundles, `${digest}.tar`))) !== digest) throw new Error(`${name}: frozen bundle digest differs`);
            }
        }, catch: (error) => new GamesctlFailed('verify-round', String(error.message)) }),
        round: (...args) => Effect.sync(() => { calls.round++; calls.roundArgs.push(args); calls.events.push('round'); return structuredClone(currentSpec); }),
        publish: () => Effect.sync(() => { calls.publish++; }) };
    const beforeFiles = tree(f.c.paths.results), beforeBundles = tree(f.c.paths.bundles);
    return withStore(f.c, (store) => Effect.gen(function* () {
        const before = yield* readState(store);
        const watched = { ...store };
        for (const name of MUTATIONS) watched[name] = (...args) => Effect.suspend(() => {
            calls.mutations.push(name);
            calls.events.push(`mutation:${name}`);
            return store[name](...args);
        });
        const outcome = yield* playRound({ config: f.c, store: watched, gamesctl, js, board: null, secret, boot: 'new-boot',
            proc: { run: () => no, isStopping: () => false, running: () => [] },
            settings: () => ({ gamesPerPair: 2, thinkCapSec: 1, workers: 1, roundGapMin: 0, ...settings }),
            play: (job) => Effect.sync(() => {
                calls.play.push(structuredClone(job));
                const evidence = { context: CURRENT, bundles: Object.fromEntries([...new Set(job.games.flatMap((game) => [game.p1, game.p2]))]
                    .map((name) => [name, job.bots[name].bundle])) };
                return { results: job.games.map((game) => ({ id: game.id, result: resultOf({ ...game, seed: job.seed }, job.key, evidence) })),
                    replays: Object.fromEntries(job.games.map((game) => [game.id, replayOf({ ...game, seed: job.seed }, resultOf({ ...game, seed: job.seed }, job.key, evidence))])) };
            }) }, K, 'resume', true);
        return { outcome, calls, before, after: yield* readState(store), beforeFiles, afterFiles: tree(f.c.paths.results),
            beforeBundles, afterBundles: tree(f.c.paths.bundles) };
    }));
};

const refusedWithoutMutation = async (f, message, options = {}) => {
    const r = await resume(f, options);
    assert.equal(r.calls.play.length, 0, `${message}: refused before any fake runner dispatch`);
    assert.equal(r.calls.publish, 0, `${message}: refused before publication`);
    assert.deepEqual(r.calls.mutations, [], `${message}: no DB reset, row update, result write, or attempt change`);
    assert.deepEqual(r.after, r.before, `${message}: durable round and game rows remain unchanged`);
    assert.deepEqual(r.afterFiles, r.beforeFiles, `${message}: existing result/replay files remain unchanged`);
    assert.deepEqual(r.afterBundles, r.beforeBundles, `${message}: canonical archives remain unchanged`);
    assert.equal(r.outcome.kind, 'failed', `${message}: explicit failure is exposed`);
    assert.match(r.outcome.why, /context|protocol|bundle|digest|arena|engine|scope|seed|key|rules|verification|admission|capMs/i, `${message}: actionable boundary error`);
    return r;
};

test('stored placement fast resume rejects an old engine comparison context without touching state', async () => {
    const f = await fixture({ context: { ...CURRENT, engineRevision: 'old-engine-fixture' } });
    await refusedWithoutMutation(f, 'old engine context');
});

test('stored placement fast resume rejects a historical arena row without resetting it into v2', async () => {
    await refusedWithoutMutation(await fixture({ rowArena: 'open' }), 'historical arena');
});

for (const [label, change] of [
    ['missing required protocol', { specProtocol: undefined }],
    ['v1 required protocol', { specProtocol: 1 }],
    ['missing finished-seat negotiation', { protocols: undefined }],
    ['v1 finished-seat negotiation', { protocols: { p1: 1, p2: 2 } }]
]) test(`stored placement fast resume rejects ${label} before DB mutation`, async () => {
    // Object defaults apply only to omitted properties; explicitly remove the missing fields after fixture setup.
    const f = await fixture(change);
    if (label === 'missing required protocol' || label === 'missing finished-seat negotiation') {
        await withStore(f.c, (store) => Effect.gen(function* () {
            const state = yield* readState(store);
            if (label === 'missing required protocol') {
                delete state.row.spec.requiredProtocol;
                delete f.spec.requiredProtocol;
                delete f.ladder.config.requiredProtocol;
            } else {
                delete state.games[0].result.protocols;
                delete f.ladder.games[0].protocols;
            }
            yield* store.replaceRound(state.row, state.games);
        }));
        writeFileSync(f.ladderFile, JSON.stringify(f.ladder));
    }
    await refusedWithoutMutation(f, label);
});

test('stored placement fast resume rejects bytes that no longer hash to the frozen bundle digest', async () => {
    const f = await fixture();
    writeFileSync(path.join(f.c.paths.bundles, `${f.spec.bundles[BOTS[0]]}.tar`), canonicalArchive('changed inert fixture'));
    await refusedWithoutMutation(f, 'changed canonical archive');
});

test('stored placement fast resume rejects a different valid bundle digest in the saved ladder config', async () => {
    const f = await fixture(), bytes = canonicalArchive('another valid inert fixture'), digest = sha(bytes);
    writeFileSync(path.join(f.c.paths.bundles, `${digest}.tar`), bytes);
    f.ladder.config.bundles[BOTS[0]] = digest;
    writeFileSync(f.ladderFile, JSON.stringify(f.ladder));
    await refusedWithoutMutation(f, 'changed per-version digest');
});

for (const gzip of [false, true]) test(`matching v2 context resumes only the unfinished seat (${gzip ? 'gzip' : 'plain'} replay evidence)`, async () => {
    const f = await fixture({ gzip }), r = await resume(f);
    assert.deepEqual(r.outcome, { kind: 'done' });
    assert.equal(r.calls.verify, 1, 'stored placement verifies immutable metadata before execution');
    assert.equal(r.calls.mutations.includes('replaceRound'), false, 'valid evidence never resets the durable round');
    assert.equal(r.calls.play.length, 1);
    assert.equal(r.calls.play[0].requiredProtocol, 2);
    assert.equal(r.calls.play[0].seed, f.firstSeed);
    assert.deepEqual(r.calls.play[0].games.map((game) => game.id), [f.games[1].id]);
    assert.deepEqual(r.after.games.find((game) => game.id === f.finished.id).result, r.before.games.find((game) => game.id === f.finished.id).result,
        'the completed seat keeps its actual stored result');
    assert.equal(r.after.row.state, 'done');
    assert.equal(r.after.games.filter((game) => game.state === 'done').length, 2);
    const completed = JSON.parse(readFileSync(f.ladderFile, 'utf8'));
    assert.deepEqual(completed.config.context, CURRENT);
    assert.deepEqual(completed.config.bundles, f.spec.bundles);
    assert.equal(completed.progress.scheduled, 2);
    assert.equal(completed.progress.finished, 2);
    assert.equal(completed.progress.rated, 2);
    assert.equal(completed.progress.outcomes.won, 2);
});

// Ordinary rounds must freeze the same reservation evidence as placements when later submissions arrive.
const frozenDecks = {
    file: 'fixture-decks.json', sha256: 'e'.repeat(64), names: ['Frozen A', 'Frozen B'], deal: 'seat', skipped: [],
    lists: [{ metadata: { name: 'Frozen A' }, fixture: 'original A' }, { metadata: { name: 'Frozen B' }, fixture: 'original B' }]
};
const changedCurrentSpec = (f) => {
    const name = 'later-v1', bytes = canonicalArchive('newly admitted inert competitor'), digest = sha(bytes);
    writeFileSync(path.join(f.c.paths.bundles, `${digest}.tar`), bytes);
    return { ...structuredClone(f.spec), bots: [...f.spec.bots, name], bundles: { ...f.spec.bundles, [name]: digest },
        gamesPerPair: 4, capMs: 5000,
        decks: { ...structuredClone(frozenDecks), file: 'new-decks.json', sha256: 'f'.repeat(64), names: ['Later A', 'Later B'],
            lists: [{ metadata: { name: 'Later A' }, fixture: 'changed A' }, { metadata: { name: 'Later B' }, fixture: 'changed B' }] } };
};

for (const gzip of [false, true]) test(`ordinary v2 resume freezes the lineup, rules and unfinished job after roster growth (${gzip ? 'gzip' : 'plain'} evidence)`, async () => {
    const f = await fixture({ placement: false, gzip, decks: structuredClone(frozenDecks) });
    assert.equal(Object.hasOwn(f.spec, 'placement'), false, 'this is an ordinary round reservation');
    const currentSpec = changedCurrentSpec(f);
    const originalReplay = readFileSync(f.replayFile);
    const r = await resume(f, { currentSpec, settings: { gamesPerPair: 4, thinkCapSec: 5, workers: 2 } });
    assert.deepEqual(r.outcome, { kind: 'done' });
    assert.equal(r.calls.round, 0, 'a stored ordinary v2 round never asks for the current roster or rules');
    assert.equal(r.calls.verify, 1, 'current admissions and canonical bundles are verified for the frozen names');
    assert.equal(r.calls.events[0], 'verify', 'verification precedes durable mutation');
    assert.equal(r.calls.mutations.includes('replaceRound'), false);
    assert.equal(r.calls.play.length, 1, 'only the unfinished mirrored seat is dispatched');
    const expectedJob = jobFor(js, f.spec, f.key, [f.games[1]], limitsFor(f.spec.capMs));
    assert.deepEqual(r.calls.play[0], expectedJob, 'seed/key, original deck bodies, limits, policy, context and exact bundles remain frozen');
    assert.deepEqual(r.after.row.spec, r.before.row.spec);
    assert.equal(r.after.row.firstSeed, r.before.row.firstSeed);
    assert.equal(r.after.row.keyId, r.before.row.keyId);
    assert.equal(r.after.row.workers, 2, 'runtime concurrency remains adjustable');
    const finishedBefore = r.before.games.find(g => g.id === f.finished.id), finishedAfter = r.after.games.find(g => g.id === f.finished.id);
    for (const field of ['result', 'endedAt', 'started', 'seed', 'p1', 'p2', 'decks']) assert.deepEqual(finishedAfter[field], finishedBefore[field], `finished ${field} is retained`);
    if (gzip) assert.deepEqual(readFileSync(f.replayFile), originalReplay, 'archived gzip replay bytes remain intact');
    else {
        const oldLines = originalReplay.toString('utf8').trimEnd().split('\n').map(JSON.parse);
        const newLines = readFileSync(f.replayFile, 'utf8').trimEnd().split('\n').map(JSON.parse);
        const releasedKey = newLines.at(-1).key;
        delete newLines.at(-1).key;
        assert.deepEqual(newLines, oldLines, 'the completed replay evidence is unchanged apart from normal seed-key publication');
        assert.equal(releasedKey, js.gameKey(f.key, f.firstSeed));
    }
    const completed = JSON.parse(readFileSync(f.ladderFile, 'utf8'));
    for (const field of ['bots', 'bundles', 'context', 'requiredProtocol', 'gamesPerPair', 'capMs', 'maxSteps', 'hangMs', 'decks', 'keyId', 'firstSeed']) {
        assert.deepEqual(completed.config[field], f.ladder.config[field], `published ${field} retains the frozen reservation`);
    }
    assert.equal(completed.progress.rated, 2);
    assert.ok(completed.games.every(g => g.protocols.p1 === 2 && g.protocols.p2 === 2 && g.context.engineRevision === CURRENT.engineRevision));
});

for (const [label, mutate, options, expectedVerify] of [
    ['changed canonical archive', f => writeFileSync(path.join(f.c.paths.bundles, `${f.spec.bundles[BOTS[0]]}.tar`), canonicalArchive('tampered ordinary archive')), {}, 0],
    ['current admission verification refused', () => {}, { verifyError: 'current admission verification refused for frozen version' }, 1],
    ['different round-seed secret', () => {}, { secret: '7'.repeat(64) }, 1],
    ['changed frozen ladder cap', f => { f.ladder.config.capMs = 9000; writeFileSync(f.ladderFile, JSON.stringify(f.ladder)); }, {}, 0]
]) test(`ordinary v2 resume refuses ${label} before mutation or dispatch`, async () => {
    const f = await fixture({ placement: false });
    mutate(f);
    const r = await refusedWithoutMutation(f, label, options);
    assert.equal(r.calls.round, 0, 'refusal does not regenerate or reserve a new current lineup');
    assert.equal(r.calls.verify, expectedVerify);
});

for (const field of ['firstSeed', 'keyId']) test(`ordinary v2 resume refuses a changed durable ${field} instead of replacing the round`, async () => {
    const f = await fixture({ placement: false });
    await withStore(f.c, store => Effect.gen(function* () {
        const { row, games } = yield* readState(store);
        yield* store.replaceRound({ ...row, [field]: field === 'firstSeed' ? (row.firstSeed + 1) >>> 0 : 'unrelated-key' }, games);
    }));
    const r = await refusedWithoutMutation(f, `changed durable ${field}`);
    assert.equal(r.calls.round, 0);
});

test('a new ordinary v2 round still selects the current expanded lineup and live rules', async () => {
    const f = await fixture({ placement: false, reserved: false });
    const currentSpec = changedCurrentSpec(f);
    const r = await resume(f, { currentSpec, settings: { gamesPerPair: 4, thinkCapSec: 5 } });
    assert.deepEqual(r.outcome, { kind: 'done' });
    assert.equal(r.before.row, null);
    assert.equal(r.calls.round, 1, 'new reservations ask Node for the current lineup');
    assert.deepEqual(r.calls.roundArgs[0], [K, 4, 5000, false]);
    assert.equal(r.calls.verify, 0, 'there is no prior frozen reservation to verify');
    assert.deepEqual(r.after.row.spec, currentSpec);
    const scheduled = buildSchedule(js, currentSpec, f.firstSeed);
    assert.deepEqual(r.after.games.map(g => g.id), scheduled.map(g => g.id));
    assert.ok(r.calls.play.some(job => Object.hasOwn(job.bots, 'later-v1')));
    assert.ok(r.calls.play.every(job => job.capMs === 5000 && job.context.engineRevision === CURRENT.engineRevision));
});
