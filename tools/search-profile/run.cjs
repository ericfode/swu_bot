'use strict';

// Profiles isolated, reproducible search decisions. No production or engine code is changed.
// See README.md in this directory for interpretation and reproducibility limits.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const inspector = require('node:inspector');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const nativeJSON = { parse: JSON.parse, stringify: JSON.stringify };
const now = () => process.hrtime.bigint();
const elapsed = (start) => Number(now() - start) / 1e6;

// Nested synchronous spans: self time partitions the measured work; inclusive time does not.
class Meter {
    constructor() { this.active = false; this.rows = {}; this.stack = []; this.wire = 0; this.bytes = { sent: 0, received: 0 }; }
    reset() { this.rows = {}; this.stack = []; this.bytes = { sent: 0, received: 0 }; }
    span(label, fn) {
        if (!this.active) return fn();
        const frame = { start: now(), children: 0 };
        this.stack.push(frame);
        try { return fn(); } finally {
            const ms = elapsed(frame.start);
            this.stack.pop();
            if (this.stack.length) this.stack[this.stack.length - 1].children += ms;
            const row = this.rows[label] ??= { calls: 0, inclusiveMs: 0, selfMs: 0 };
            row.calls++;
            row.inclusiveMs += ms;
            row.selfMs += ms - frame.children;
        }
    }
    wrap(object, method, label) {
        const original = object[method];
        assert.equal(typeof original, 'function', method);
        const meter = this;
        object[method] = function (...args) { return meter.span(label, () => original.apply(this, args)); };
    }
}
const meter = new Meter();

// JSON only counts as wire encoding while StdioClient writes or consumes a reply.
for (const method of ['parse', 'stringify']) {
    JSON[method] = function (...args) {
        if (!meter.active) return nativeJSON[method](...args);
        const wire = meter.wire > 0;
        const result = meter.span(`json.${wire ? 'wire' : 'internal'}.${method}`, () => nativeJSON[method](...args));
        if (wire) meter.bytes[method === 'stringify' ? 'sent' : 'received'] += Buffer.byteLength(method === 'stringify' ? result : args[0]) + 1;
        return result;
    };
}

// Wrap exports BEFORE protocol/ISMCTS destructure them.
const { Env, EnvGame } = require('../../bot/env');
const views = require('../../bot/view');
const { Game } = require('../../forceteki/build/server/game/core/Game');
const { GameStateManager } = require('../../forceteki/build/server/game/core/snapshot/GameStateManager');
for (const method of ['apply', 'mark', 'restore', 'legalActions']) meter.wrap(EnvGame.prototype, method, `engine.${method}`);
meter.wrap(Game.prototype, 'captureGameState', 'engine.diagnosticCapture');
meter.wrap(Game.prototype, 'postRollbackOperations', 'engine.resumeAfterRestore');
meter.wrap(GameStateManager.prototype, 'buildGameStateForSnapshot', 'engine.snapshotBuild');
meter.wrap(GameStateManager.prototype, 'rollbackToSnapshot', 'engine.stateRestore');
for (const method of ['view', 'promptView', 'actionView']) meter.wrap(views, method, `view.${method}`);
const heuristic = require('../../bot/players/heuristic');
for (const method of ['evaluate', 'defaultChoose', 'fingerprint']) meter.wrap(heuristic, method, `policy.${method}`);
const belief = require('../../bot/players/belief');
meter.wrap(belief, 'determinize', 'policy.determinize');
meter.wrap(belief.BeliefModel.prototype, 'observe', 'policy.observe');
const { IsmctsBot } = require('../../bot/players/ismcts');
for (const method of ['select', 'leafValue', 'report']) meter.wrap(IsmctsBot.prototype, method, `policy.${method}`);
const { createRushBot } = require('../../bot/players/rush');
const { gameStreams, seededRng } = require('../../bot/rng');
const { Shadow, ClientSeat, NativeSeat } = require('../../bot/protocol');
const { StdioClient } = require('../../bot/stdio');
const { create: createSearch } = require('../../bot/examples/search-bot');

const originalRequest = StdioClient.prototype.request;
StdioClient.prototype.request = function (message) {
    meter.wire++;
    let result;
    try { result = originalRequest.call(this, message); } finally { meter.wire--; }
    const waiter = this.waiter;
    if (waiter) this.waiter = (line) => {
        meter.wire++;
        try { return waiter(line); } finally { meter.wire--; }
    };
    return result;
};

function argsOf(argv) {
    const opts = { out: path.join(ROOT, 'results/search-profile'), seed: 1, rounds: [2, 3, 4], repeats: 5, warmups: 1,
        modes: ['js-inprocess', 'js-stdio', 'rust-stdio', 'ismcts'], cpu: false };
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        if (flag === '--cpu') { opts.cpu = true; continue; }
        const value = argv[++i];
        if (value === undefined) throw new Error(`missing value for ${flag}`);
        if (flag === '--out') opts.out = path.resolve(value);
        else if (['--seed', '--repeats', '--warmups'].includes(flag)) opts[flag.slice(2)] = Number(value);
        else if (flag === '--rounds') opts.rounds = value.split(',').map(Number);
        else if (flag === '--modes') opts.modes = value.split(',');
        else throw new Error(`unknown flag ${flag}`);
    }
    assert(opts.repeats > 0 && Number.isInteger(opts.repeats));
    assert(opts.warmups >= 0 && Number.isInteger(opts.warmups));
    for (const mode of opts.modes) assert(['js-inprocess', 'js-stdio', 'rust-stdio', 'ismcts'].includes(mode), mode);
    return opts;
}

function normalize(value) {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter((k) => k !== 'ms').map((k) => [k, normalize(value[k])]));
    return value;
}
const digest = (value) => crypto.createHash('sha256').update(nativeJSON.stringify(normalize(value))).digest('hex');
const write = (file, value) => fs.writeFileSync(file, nativeJSON.stringify(value, null, 2) + '\n');
const status = (value) => process.stderr.write(value + '\n');

async function fixtures(env, opts) {
    const streams = gameStreams(opts.seed);
    const rng = streams.match;
    const setup = { seed: streams.engine, deck1: env.randomDeck(rng), deck2: env.randomDeck(rng) };
    const game = env.newGame(setup);
    await game.start();
    const bots = [createRushBot('fixture-p1'), createRushBot('fixture-p2')];
    const moves = [], found = [];
    const targets = [...opts.rounds];
    for (let step = 0; step < 1500 && !game.over && targets.length; step++) {
        const order = rng() < 0.5 ? game.ids : [...game.ids].reverse();
        let actions;
        const pid = order.find((id) => (actions = game.legalActions(id)).length);
        assert(pid, 'fixture game stuck');
        if (game.round >= targets[0] && game.isActionWindow(pid) && actions.length >= 3) {
            const state = views.view(game, game.seatOf(pid));
            const fixture = { id: `seed${opts.seed}-round${targets.shift()}`, seed: opts.seed, setup, pid, seat: game.seatOf(pid), moves: [...moves],
                round: game.round, actions: actions.map((a, i) => views.actionView(game, a, i, pid)), state };
            found.push(fixture);
            status(`fixture ${fixture.id}: ${moves.length} setup moves, ${actions.length} root actions, ${Object.values(state.players).reduce((n, p) => n + p.ground.length + p.space.length, 0)} units`);
        }
        const action = bots[game.ids.indexOf(pid)].choose({ game, pid, actions, rng });
        const i = actions.indexOf(action);
        assert(i >= 0);
        const move = { pid, i, legal: actions.length, key: views.actionKey(game, action) };
        const split = game.apply(pid, action, rng)?.map((x) => ({ id: game.cardId(x.id), amount: x.amount }));
        moves.push({ ...move, ...(split ? { split } : {}) });
    }
    assert.equal(targets.length, 0, `could not prepare rounds ${targets}`);
    return found;
}

async function replay(env, fixture) {
    const game = env.newGame(fixture.setup);
    await game.start();
    for (const move of fixture.moves) {
        const actions = game.legalActions(move.pid);
        const action = actions[move.i];
        assert.equal(actions.length, move.legal);
        assert.equal(views.actionKey(game, action), move.key);
        game.apply(move.pid, move.split ? { ...action, split: move.split.map((x) => ({ id: game.uuidOf(x.id), amount: x.amount })) } : action);
    }
    assert.equal(digest(views.view(game, fixture.seat)), digest(fixture.state));
    assert.equal(digest(game.legalActions(fixture.pid).map((a, i) => views.actionView(game, a, i, fixture.pid))), digest(fixture.actions));
    return game;
}

const clients = new Map();
function getClient(mode) {
    if (mode === 'js-inprocess') return createSearch('profile-search');
    if (!clients.has(mode)) {
        const options = mode === 'js-stdio'
            ? { cmd: process.execPath, args: [path.join(ROOT, 'bot/examples/search-bot.js'), 'profile-search'] }
            : { cmd: path.join(ROOT, 'target/release/swu-bot-rs'), args: ['search'] };
        clients.set(mode, new StdioClient('profile-search', { ...options, cwd: ROOT }));
    }
    return clients.get(mode);
}

function setupOf(fixture) {
    const streams = gameStreams(fixture.seed);
    return { players: [{ id: 'p1', name: 'p1', bot: 'profile-search' }, { id: 'p2', name: 'p2', bot: 'fixture' }],
        decks: { p1: fixture.setup.deck1, p2: fixture.setup.deck2 }, botSeed: streams.botSeed(fixture.seat),
        deals: (deal) => streams.sim(fixture.seat, deal), limits: { decide: null } };
}

async function cpuStart(enabled) {
    if (!enabled) return null;
    const session = new inspector.Session();
    session.connect();
    const post = (method, params) => new Promise((resolve, reject) => session.post(method, params, (err, result) => err ? reject(err) : resolve(result)));
    await post('Profiler.enable');
    await post('Profiler.setSamplingInterval', { interval: 500 });
    await post('Profiler.start');
    return async () => {
        const { profile } = await post('Profiler.stop');
        session.disconnect();
        return profile;
    };
}

async function sample(env, game, fixture, mode, { instrument = true, cpu = false } = {}) {
    const shadow = new Shadow(env, fixture.setup);
    fixture.moves.forEach((m) => shadow.record(m));
    const prepStart = now();
    assert(await shadow.sync(game, fixture.pid), 'shadow failed to match fixture');
    const prepareMs = elapsed(prepStart);
    const transcript = [];
    const simCounts = {};
    const simErrors = [];
    let rootMessage, reply, searchMs = 0, simulationMs = 0, profile;
    const bot = mode === 'ismcts' ? new IsmctsBot('profile-ismcts') : getClient(mode);
    const original = mode === 'ismcts' ? bot.choose : bot.decide;
    const method = mode === 'ismcts' ? 'choose' : 'decide';
    const seat = mode === 'ismcts' ? new NativeSeat(bot, fixture.seat) : new ClientSeat(bot, fixture.seat, setupOf(fixture));
    seat.shadow = shadow;
    await seat.hello(); // process startup/card loading and bot reset excluded
    bot.child?.ref(); // null decision budgets have no referee timer to keep Node alive
    const measure = async (fn) => {
        const stop = await cpuStart(cpu);
        meter.reset();
        meter.active = instrument;
        const start = now();
        try { return await fn(); } finally {
            searchMs = elapsed(start);
            meter.active = false;
            if (stop) profile = await stop();
        }
    };
    if (mode === 'ismcts') {
        bot.choose = (args) => measure(() => original.call(bot, args));
    } else {
        bot.decide = (message, sim) => {
            rootMessage = message;
            return measure(async () => {
                reply = await original.call(bot, message, async (request) => {
                    const t = now();
                    const response = await sim(request);
                    simulationMs += elapsed(t);
                    transcript.push({ request, response });
                    simCounts[request.op] = (simCounts[request.op] ?? 0) + 1;
                    if (response.error) simErrors.push(response.error);
                    return response;
                });
                return reply;
            });
        };
    }
    const actions = game.legalActions(fixture.pid);
    const before = digest(views.snapshot(game));
    global.gc?.();
    const start = now();
    let chosen;
    try { chosen = await seat.decide(game, fixture.pid, actions, seededRng(`profile:${fixture.seed}:${fixture.seat}`)); }
    finally { bot[method] = original; meter.active = false; }
    const decisionMs = elapsed(start);
    assert.equal(digest(views.snapshot(game)), before, 'search changed the real root');
    const stats = structuredClone(bot.stats ?? null);
    const rows = structuredClone(meter.rows);
    const bytes = { ...meter.bytes };
    const summary = { fixture: fixture.id, mode, instrument, cpu, prepareMs, decisionMs, searchMs,
        simulationMs: mode === 'ismcts' ? null : simulationMs,
        botAndTransportMs: mode === 'ismcts' ? null : searchMs - simulationMs,
        rows, bytes, simCounts, simErrors, stats, nativeSearch: structuredClone(bot.last ?? null),
        chosen: { i: actions.findIndex((a) => views.actionKey(game, a) === views.actionKey(game, chosen)), label: chosen.label },
        traceHash: mode === 'ismcts' ? null : digest(transcript), requestHash: mode === 'ismcts' ? null : digest(transcript.map((x) => x.request)) };
    return { summary, tape: { rootMessage, reply, transcript }, profile };
}

// Replay exactly the recorded simulator replies, removing all live engine work. This measures
// bot + JSON + pipe + scheduling together, NOT the pipe alone. Assertions prove identical work.
async function replayTape(fixture, mode, tape) {
    const bot = getClient(mode);
    const seat = new ClientSeat(bot, fixture.seat, setupOf(fixture));
    await seat.hello();
    bot.child?.ref();
    let at = 0;
    const requests = [];
    const t = now();
    const reply = await bot.decide(tape.rootMessage, async (request) => {
        requests.push(request);
        const recorded = tape.transcript[at++];
        assert(recorded, 'tape exhausted: live and replay searches did different work');
        return recorded.response;
    });
    const ms = elapsed(t);
    assert.equal(at, tape.transcript.length, 'tape length changed');
    assert.equal(digest(requests), digest(tape.transcript.map((x) => x.request)), 'tape request path changed');
    assert.equal(digest(reply), digest(tape.reply), 'tape decision changed');
    return ms;
}

const median = (values) => { const sorted = [...values].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
function aggregate(samples) {
    const groups = new Map();
    for (const sample of samples) {
        if (sample.cpu) continue;
        const key = `${sample.fixture}/${sample.mode}/${sample.instrument ? 'instrumented' : 'baseline'}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(sample);
    }
    return [...groups.entries()].map(([group, values]) => ({ group, n: values.length,
        searchMedianMs: median(values.map((x) => x.searchMs)), searchMinMs: Math.min(...values.map((x) => x.searchMs)), searchMaxMs: Math.max(...values.map((x) => x.searchMs)),
        decisionMedianMs: median(values.map((x) => x.decisionMs)),
        simulationMedianMs: values[0].simulationMs === null ? null : median(values.map((x) => x.simulationMs)),
        botAndTransportMedianMs: values[0].botAndTransportMs === null ? null : median(values.map((x) => x.botAndTransportMs)),
        requestHashes: [...new Set(values.map((x) => x.requestHash))], traceHashes: [...new Set(values.map((x) => x.traceHash))],
        choices: [...new Set(values.map((x) => x.chosen.i))], simCounts: values.map((x) => x.simCounts),
        errors: values.flatMap((x) => x.simErrors),
        rows: Object.fromEntries([...new Set(values.flatMap((x) => Object.keys(x.rows)))].map((label) => [label, {
            calls: median(values.map((x) => x.rows[label]?.calls ?? 0)),
            inclusiveMs: median(values.map((x) => x.rows[label]?.inclusiveMs ?? 0)),
            selfMs: median(values.map((x) => x.rows[label]?.selfMs ?? 0))
        }])) }));
}

async function main() {
    const opts = argsOf(process.argv.slice(2));
    fs.mkdirSync(opts.out, { recursive: true });
    const meta = { at: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
        cpu: os.cpus()[0]?.model, cores: os.cpus().length, gcBeforeSamples: !!global.gc,
        git: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
        engine: execFileSync('git', ['-C', 'forceteki', 'rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(), opts };
    const env = new Env();
    const positions = await fixtures(env, opts);
    write(path.join(opts.out, 'fixtures.json'), positions);
    const samples = [], tapes = {}, tapeResults = [];
    const save = () => write(path.join(opts.out, 'profile.json'), { meta, samples, aggregates: aggregate(samples), tapeResults });
    for (const fixture of positions) {
        const game = await replay(env, fixture);
        for (let n = 0; n < opts.warmups; n++) for (const mode of opts.modes) await sample(env, game, fixture, mode, { instrument: false });
        for (let repeat = 0; repeat < opts.repeats; repeat++) {
            const order = repeat % 2 ? [...opts.modes].reverse() : opts.modes;
            for (const mode of order) {
                // Alternate detailed attribution and a control without active instrumentation.
                for (const instrument of repeat % 2 ? [false, true] : [true, false]) {
                    const result = await sample(env, game, fixture, mode, { instrument });
                    result.summary.repeat = repeat;
                    samples.push(result.summary);
                    tapes[`${fixture.id}/${mode}`] = result.tape;
                    status(`${fixture.id} ${mode} ${instrument ? 'spans' : 'baseline'} #${repeat + 1}: ${result.summary.searchMs.toFixed(1)} ms, ${result.summary.simCounts.act ?? result.summary.stats?.playouts ?? 0} ${mode === 'ismcts' ? 'playouts' : 'sim acts'}, ${result.summary.simErrors.length} sim errors`);
                    save();
                }
            }
        }
        for (const mode of opts.modes.filter((m) => m !== 'ismcts')) {
            const tape = tapes[`${fixture.id}/${mode}`];
            write(path.join(opts.out, `${fixture.id}-${mode}-tape.json`), tape);
            try {
                await replayTape(fixture, mode, tape); // warm
                const times = [];
                for (let i = 0; i < 7; i++) times.push(await replayTape(fixture, mode, tape));
                tapeResults.push({ fixture: fixture.id, mode, calls: tape.transcript.length, medianMs: median(times), times });
                status(`${fixture.id} ${mode} engine-free tape: ${median(times).toFixed(2)} ms for ${tape.transcript.length} simulator replies`);
            } catch (e) {
                if (mode !== 'rust-stdio') throw e;
                // Rust has its own deadline: a faster engine-free run may do more work than the live run.
                tapeResults.push({ fixture: fixture.id, mode, unavailable: String(e.message) });
                await getClient(mode).close();
                clients.delete(mode);
                status(`${fixture.id} ${mode} tape work differed; live results retained`);
            }
        }
        if (opts.cpu) for (const mode of opts.modes.filter((m) => m !== 'js-stdio')) {
            const result = await sample(env, game, fixture, mode, { instrument: false, cpu: true });
            samples.push(result.summary);
            const stem = `${fixture.id}-${mode}`;
            write(path.join(opts.out, `${stem}.cpuprofile`), result.profile);
            write(path.join(opts.out, `${stem}-cpu-summary.json`), require('./cpu-summary.cjs').summarize(result.profile, { excludeInspector: true }));
        }
        save();
    }
    const protocolSamples = samples.filter((x) => !x.cpu && (x.mode === 'js-inprocess' || x.mode === 'js-stdio'));
    for (const fixture of positions) {
        const matching = protocolSamples.filter((x) => x.fixture === fixture.id);
        assert(new Set(matching.map((x) => x.requestHash)).size <= 1, `${fixture.id}: JS transports performed different searches`);
        assert(new Set(matching.map((x) => x.traceHash)).size <= 1, `${fixture.id}: JS transports received different simulated states`);
    }
    save();
    status(`Saved ${opts.out}/profile.json; available JS traces and real root preservation verified.`);
}

async function closeClients() {
    meter.active = false;
    await Promise.all([...clients.values()].map((client) => client.close()));
    clients.clear();
}

module.exports = { Env, fixtures, replay, sample, aggregate, median, digest, write, status, closeClients };

if (require.main === module) {
    main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(closeClients);
}
