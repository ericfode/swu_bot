'use strict';
// Scheduler planning over checked-version metadata only. Bundles deliberately contain no executable workload;
// reserve receives a fake spec builder, and nothing here invokes the checker, bundle tools, engine or game runner.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesctl-placement-'));
Object.assign(process.env, { ARENA_HOME: path.join(tmp, 'arena'), ARENA_RESULTS: path.join(tmp, 'results'), GAMES_DATA: tmp });
const home = require('../arena/home');
const placement = require('../arena/placement');
const { planRound, commands } = require('../arena/gamesctl');
const HOUR = 3600000;
const OWN = ['res_heuristic-v1', 'res_rush-v1'];
const opts = () => ({ replayMs: 24 * HOUR, settledSince: 0 });

function version(name, n, ref = `window:${name}.${n}`) {
    const v = `${name}-v${n}`;
    home.writeJson(path.join(home.VERSIONS, v, 'SUBMISSION.json'), { name: v, agent: name, version: n,
        ref, checked: true, bot: { kind: 'wasm' }, submittedAt: '2026-01-01T00:00:00.000Z' });
    home.writeJson(path.join(home.VERSIONS, v, 'bundle', 'arena.json'), {});
    return v;
}

function builder(name) {
    home.updateRoster((r) => ({ ...r, agents: [...r.agents, { name, owner: `github:${name}` }] }));
    return version(name, 1);
}

function standings(rounds, updatedAt = new Date().toISOString()) {
    rounds = rounds.map((rd) => ({ ladderId: `arena-r${rd.round}`, ...rd }));
    for (const rd of rounds) {
        const file = path.join(home.RESULTS, rd.ladderId, 'ladder.json');
        if (!fs.existsSync(file)) home.writeJson(file, { config: { bots: rd.bots.map((b) => b.name) }, games: [] });
    }
    home.writeJson(path.join(home.HOME, 'standings.json'), { rounds, updatedAt });
}

const played = (round, bots, extra = {}) => ({ round, status: 'done', bots: bots.map((name) => ({ name })),
    updatedAt: new Date().toISOString(), ...extra });
const enqueue = (v) => placement.enqueue({ version: v, ref: `window:${v.replace('-v', '.')}` });

function complete(round, v) {
    const spec = placement.reserve(round, (job) => ({ round, bots: [job.version, ...job.opponents], gamesPerPair: 2 }));
    assert.equal(spec.placement.version, v);
    const rd = played(round, spec.bots, { placement: spec.placement, ladderId: `arena-r${round}` });
    home.writeJson(path.join(home.RESULTS, rd.ladderId, 'ladder.json'), { config: { bots: spec.bots }, games:
        [spec.bots, [...spec.bots].reverse()].map(([p1, p2], i) => ({ id: `${round}-${i}`, p1, p2, seed: round,
            outcome: 'won', winnerSeat: 'draw' })) });
    const file = path.join(home.HOME, 'standings.json');
    const prior = fs.existsSync(file) ? home.readJson(file).rounds : [];
    standings([...prior, rd]);
    placement.update(round, { state: 'complete', finished: 2, rated: 2 });
    return rd;
}

test.beforeEach(() => {
    fs.rmSync(home.HOME, { recursive: true, force: true });
    fs.rmSync(home.RESULTS, { recursive: true, force: true });
    process.env.GAMES_PLACEMENT_MODE = 'immediate';
    home.writeJson(home.ROSTER, { thinkCapMs: 60000, baselines: [], agents: [
        { name: 'res_heuristic', owner: 'arena', resident: true }, { name: 'res_rush', owner: 'arena', resident: true }
    ] });
    version('res_heuristic', 1);
    version('res_rush', 1);
});
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('immediate planning retains v1 and v2 requests, skips settling and rotates numbered adaptive steps', () => {
    builder('kim');
    enqueue('kim-v1');
    version('kim', 2);
    enqueue('kim-v2');
    assert.deepEqual(placement.statuses().map((r) => r.version), ['kim-v1', 'kim-v2']);
    assert.deepEqual(planRound({ ...opts(), settledSince: Date.now() }), { round: 0, resume: false, why: 'placement' });
    const first = complete(0, 'kim-v1');
    standings([first]);
    assert.deepEqual(planRound({ ...opts(), settledSince: Date.now() }), { round: 1, resume: false, why: 'placement' });
    const second = complete(1, 'kim-v2');
    standings([first, second]);
    assert.deepEqual(placement.statuses().map((r) => [r.version, r.round, r.state, r.rounds.map((ep) => ep.round)]), [
        ['kim-v1', null, 'queued', [0]], ['kim-v2', null, 'queued', [1]]
    ]);
    assert.deepEqual(planRound(opts()), { round: 2, resume: false, why: 'placement' }, 'more useful evidence is another adaptive step');
    assert.equal(placement.next().version, 'kim-v1', 'least recently dispatched target gets the next seed');
});

test('placement-only planning during intake starts admitted jobs and never an ordinary changed-lineup round', () => {
    builder('kim');
    assert.deepEqual(planRound({ ...opts(), placementOnly: true }), { round: null, why: 'same' });
    assert.deepEqual(planRound(opts()), { round: null, why: 'same' }, 'immediate mode does not automatically play an ordinary batch');
    enqueue('kim-v1');
    assert.deepEqual(planRound({ ...opts(), settledSince: Date.now(), placementOnly: true }), { round: 0, resume: false, why: 'placement' });
});

test('a published subset keeps ordinary cadence and uses the newest overall round number', () => {
    process.env.GAMES_PLACEMENT_MODE = 'cycle';
    const builders = ['kim', 'lee', 'nia', 'obi', 'rey'].map(builder);
    const all = [...OWN, ...builders];
    const ordinary = played(7, all);
    const subset = played(8, ['kim-v1', OWN[0]], { placement: { version: 'kim-v1', ref: 'window:kim.1' } });
    standings([ordinary, subset]);
    assert.deepEqual(planRound(opts()), { round: null, why: 'same' }, 'the latest placement is not treated as the ordinary lineup');

    // Placement publication updates the overall document, but must not postpone an old ordinary round's replay.
    standings([{ ...ordinary, updatedAt: new Date(Date.now() - 25 * HOUR).toISOString() }, subset]);
    assert.deepEqual(planRound(opts()), { round: 9, resume: false, why: 'stale' });
});

test('legacy ordinary rounds use their own ladder clock despite a fresh placement publication', () => {
    process.env.GAMES_PLACEMENT_MODE = 'cycle';
    builder('kim');
    const { updatedAt, ...ordinary } = played(3, [...OWN, 'kim-v1']);
    const recent = played(4, ['kim-v1', OWN[0]], { placement: { version: 'kim-v1', ref: 'window:kim.1' } });
    const file = path.join(home.RESULTS, 'arena-r3', 'ladder.json');
    const old = new Date(Date.now() - 25 * HOUR).toISOString();
    home.writeJson(file, { updatedAt: old });
    standings([ordinary, recent]);
    assert.deepEqual(planRound(opts()), { round: 5, resume: false, why: 'stale' }, 'fresh standings.updatedAt does not slide the ordinary replay clock');
    home.writeJson(file, { createdAt: old });
    assert.deepEqual(planRound(opts()), { round: 5, resume: false, why: 'stale' }, 'legacy ladders with only createdAt still retain their clock');
});

test('immediate mode stays idle after placements; cycle mode retains periodic ordinary replay', () => {
    builder('kim');
    const first = played(0, ['kim-v1', ...OWN], { placement: { version: 'kim-v1', ref: 'window:kim.1' },
        updatedAt: new Date(Date.now() - 25 * HOUR).toISOString() });
    const recent = played(1, ['kim-v1', OWN[0]], { placement: { version: 'kim-v1', ref: 'window:kim.other' } });
    standings([first, recent]);
    assert.deepEqual(planRound(opts()), { round: null, why: 'same' });
    process.env.GAMES_PLACEMENT_MODE = 'cycle';
    const plan = planRound(opts());
    assert.equal(plan.round, 2, 'a recent placement does not indefinitely defer periodic full rounds');
    assert.equal(plan.resume, false);
});

test('an unfinished published round is resumed before any newly queued placement', () => {
    builder('kim');
    enqueue('kim-v1');
    standings([played(4, [...OWN, 'kim-v1'], { status: 'running' })]);
    assert.deepEqual(planRound({ ...opts(), placementOnly: true }), { round: 4, resume: true, why: 'resume' });
    assert.equal(placement.statuses()[0].round, null, 'planning does not reserve a conflicting round');
});

test('cycle mode preserves settling, changed-lineup and stale replay behavior and leaves unstarted placements queued', () => {
    builder('kim');
    enqueue('kim-v1');
    process.env.GAMES_PLACEMENT_MODE = 'cycle';
    assert.deepEqual(planRound({ ...opts(), settledSince: Date.now() }), { round: null, why: 'settling' });
    assert.deepEqual(planRound(opts()), { round: 0, resume: false, why: 'changed' });
    const initial = played(0, [...OWN, 'kim-v1']);
    standings([initial]);
    assert.deepEqual(planRound(opts()), { round: null, why: 'same' });
    standings([{ ...initial, updatedAt: new Date(Date.now() - 25 * HOUR).toISOString() }]);
    assert.deepEqual(planRound(opts()), { round: 1, resume: false, why: 'stale' });
    standings([initial]);
    version('kim', 2);
    assert.deepEqual(planRound(opts()), { round: 1, resume: false, why: 'changed' });
    assert.deepEqual(placement.statuses().map((r) => [r.version, r.round, r.state]), [['kim-v1', null, 'queued']]);
});

test('a stale placement plan skips safely instead of preparing an ordinary batch', () => {
    assert.deepEqual(commands.round({ arena: 'open', round: '99', placement: '1' }), { round: 99, placementSkipped: true });
});
