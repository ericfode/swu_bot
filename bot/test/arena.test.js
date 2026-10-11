'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// a scratch arena, results folder, dashboard and secret: nothing here touches the project's shared folders
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-test-'));
process.env.ARENA_HOME = path.join(tmp, 'arena');
process.env.ARENA_RESULTS = path.join(tmp, 'results');
process.env.ARENA_DASH = path.join(tmp, 'dash');
process.env.ARENA_SECRET_FILE = path.join(tmp, 'secret');
fs.mkdirSync(process.env.ARENA_DASH, { recursive: true });
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { cappedScore, scoreRound, globalElo, lineup, roundSeed, loadSecret } = require('../arena/referee');
const dash = require('../arena/dash');
const { HOME, writeJson, readJson } = require('../arena/home');

const t = (p1, p2) => ({ p1: { ms: p1, n: 10, p95: 1 }, p2: { ms: p2, n: 10, p95: 1 } });
const dashFile = (...p) => readJson(path.join(process.env.ARENA_DASH, ...p), null);
const ladderOf = (bots, games, status = 'running') => ({ id: 'arena-r1', status, config: { bots, firstSeed: 77, gamesPerPair: 2 }, progress: { scheduled: 4 }, games });

function setRoster(agents, baselines = ['rush', 'heuristic']) {
    writeJson(path.join(HOME, 'roster.json'), { thinkCapMs: 60000, baselines, agents: agents.map((name) => ({ name, title: name, start: 'rush', philosophy: `${name}'s prompt` })) });
}

test('the seat that broke the game loses whatever else the record says; the rest scores only when played out', () => {
    const g = { p1: 'a-v1', p2: 'rush', timing: t(5, 5) };
    assert.deepStrictEqual(cappedScore({ ...g, outcome: 'ERROR', by: 'p1', faultKind: 'time', winner: 'rush', winnerSeat: 'p2' }), { score: 0, forfeit: [true, false] });
    assert.deepStrictEqual(cappedScore({ ...g, outcome: 'ERROR', by: 'p2', faultKind: 'hang', winner: 'a-v1', winnerSeat: 'p1' }), { score: 1, forfeit: [false, true] });
    assert.strictEqual(cappedScore({ ...g, outcome: 'ERROR', by: 'p2', faultKind: 'load' }).score, 1);
    assert.strictEqual(cappedScore({ ...g, outcome: 'won', winner: 'a-v1', winnerSeat: 'p1', by: null }).score, 1);
    assert.strictEqual(cappedScore({ ...g, outcome: 'won', winner: 'rush', winnerSeat: 'p2', by: null }).score, 0);
    assert.strictEqual(cappedScore({ ...g, outcome: 'won', winner: 'draw', winnerSeat: 'draw' }).score, 0.5);
    assert.strictEqual(cappedScore({ ...g, outcome: 'won', winner: 'a-v1' }).score, 1, 'records without winnerSeat');
    // both seats at fault, or an engine error: unrated, nobody forfeits
    assert.deepStrictEqual(cappedScore({ ...g, outcome: 'ERROR', by: null, error: 'engine' }), { score: null, forfeit: [false, false] });
});

test('the cap comes from by, not from timing or error text', () => {
    const g = { p1: 'a', p2: 'b', timing: t(10 * 60000, 5) };
    assert.strictEqual(cappedScore({ ...g, outcome: 'won', winner: 'a', winnerSeat: 'p1', by: null }).score, 1);
    assert.strictEqual(cappedScore({ ...g, outcome: 'ERROR', error: 'TIME_FORFEIT a thought 70000 ms (cap 60000)', by: null }).score, null);
});

test('scoreRound counts results, forfeits, lost games and pins the baselines to 1500', () => {
    setRoster(['x']);
    const games = [
        { id: 'g1', p1: 'x-v0', p2: 'rush', outcome: 'won', winner: 'x-v0', winnerSeat: 'p1', timing: t(5, 5), rounds: 5 },
        { id: 'g2', p1: 'rush', p2: 'x-v0', outcome: 'won', winner: 'rush', winnerSeat: 'p1', timing: t(5, 5), rounds: 6 },
        { id: 'g3', p1: 'x-v0', p2: 'heuristic', outcome: 'won', winner: 'x-v0', winnerSeat: 'p1', timing: t(5, 5), rounds: 7 },
        { id: 'g4', p1: 'heuristic', p2: 'x-v0', outcome: 'ERROR', by: 'p2', faultKind: 'time', winner: 'heuristic', winnerSeat: 'p1', timing: t(5, 5), rounds: 3 },
        { id: 'g5', p1: 'rush', p2: 'heuristic', outcome: 'running' }
    ];
    const rd = scoreRound(3, ladderOf(['x-v0', 'rush', 'heuristic'], games));
    const x = rd.bots.find((b) => b.name === 'x-v0');
    assert.strictEqual(x.wins, 2);
    assert.strictEqual(x.losses, 2);
    assert.strictEqual(x.forfeits, 1);
    assert.deepStrictEqual(x.lost.map((l) => [l.id, l.forfeit, l.faultKind]), [['g2', false, null], ['g4', true, 'time']]);
    assert.strictEqual(rd.games, 4);
    assert.strictEqual(rd.leader, 'x-v0');
    const bl = rd.bots.filter((b) => b.name !== 'x-v0');
    assert.ok(Math.abs((bl[0].btElo + bl[1].btElo) / 2 - 1500) <= 1);
});

test('a round without rated games has no Elo, ranks or leader', () => {
    setRoster(['x']);
    const rd = scoreRound(1, ladderOf(['x-v0', 'rush'], [{ id: 'g1', p1: 'x-v0', p2: 'rush', outcome: 'running' }, { id: 'g2', p1: 'rush', p2: 'x-v0', outcome: 'ERROR', by: null }]));
    assert.strictEqual(rd.leader, null);
    assert.strictEqual(rd.rated, 0);
    assert.ok(rd.bots.every((b) => b.btElo === null && b.rank === null));
    assert.deepStrictEqual(globalElo([rd]), {});
});

test('round seeds: stable for the same secret, tournament and round; different otherwise', () => {
    const s = 'ab'.repeat(32);
    const k1 = roundSeed(s, 'arena-t1', 1);
    assert.strictEqual(roundSeed(s, 'arena-t1', 1), k1);
    assert.ok(Number.isInteger(k1) && k1 >= 0 && k1 < 2 ** 32);
    assert.notStrictEqual(roundSeed(s, 'arena-t1', 2), k1);
    assert.notStrictEqual(roundSeed(s, 'arena-t2', 1), k1);
    assert.notStrictEqual(roundSeed('cd'.repeat(32), 'arena-t1', 1), k1);
    const secret = loadSecret();
    assert.match(secret, /^[0-9a-f]{64}$/);
    assert.strictEqual(loadSecret(), secret, 'created once, then reused');
    assert.strictEqual(fs.statSync(process.env.ARENA_SECRET_FILE).mode & 0o077, 0, 'only the owner can read it');
});

test('lineup takes the newest version submitted by the cutoff', () => {
    setRoster(['a', 'b']);
    const version = (name, submittedAt, code = true) => {
        writeJson(path.join(HOME, 'versions', name, 'SUBMISSION.json'), { name, note: 'n', ...(submittedAt ? { submittedAt } : {}) });
        if (code) {
            fs.writeFileSync(path.join(HOME, 'versions', name, 'bot.js'), 'module.exports = {};\n');
        }
    };
    version('a-v0', '2026-10-11T10:00:00.000Z');
    version('a-v1', '2026-10-11T10:45:00.000Z');
    version('a-v2', '2026-10-11T11:00:00.000Z');
    version('b-v0', null); // older submissions have no submittedAt: they always count
    version('b-v1', '2026-10-11T11:30:00.000Z');
    assert.deepStrictEqual(lineup('2026-10-11T10:45:00.000Z'), ['a-v1', 'b-v0', 'rush', 'heuristic']);
    assert.deepStrictEqual(lineup('2026-10-11T09:00:00.000Z'), ['b-v0', 'rush', 'heuristic']);
    assert.deepStrictEqual(lineup(), ['a-v2', 'b-v1', 'rush', 'heuristic']);
    version('a-v3', '2026-10-11T11:40:00.000Z', false); // no bot.js: the newest version that loads plays instead
    assert.deepStrictEqual(lineup(), ['a-v2', 'b-v1', 'rush', 'heuristic']);
});

test('dashboard: a round without games shows "no games yet", not an invented Elo or leader', () => {
    setRoster(['nog']);
    const rd = scoreRound(1, ladderOf(['nog-v0', 'rush'], [{ id: 'g1', p1: 'nog-v0', p2: 'rush', outcome: 'running' }]));
    dash.publishStandings({ status: 'running', rounds: [rd], global: globalElo([rd]), tournament: { id: 't', plannedRounds: 3, rounds: [1] } });
    const lb = dashFile('panels', 'arena-leaderboard.json');
    assert.deepStrictEqual(lb.bots, [], 'the leaderboard is a summary panel');
    assert.match(lb.now, /no games yet/);
    assert.ok(lb.widgets[0].rows.every((row) => row[0] === '-' && row[3] === 'no games yet'));
    const ex = dashFile('experiments', 'arena.json');
    assert.strictEqual(ex.metrics[0].value, 'no games yet');
    assert.deepStrictEqual(ex.progress, { done: 0, total: 3, unit: 'rounds' });
    assert.deepStrictEqual(ex.chart.series, [{ name: 'nog', points: [] }]);
    const items = Object.fromEntries(dashFile('panels', 'arena-nog.json').widgets[0].items.map((i) => [i.label, i.value]));
    assert.strictEqual(items['Elo (all rounds)'], 'no games yet');
    assert.strictEqual(items['rank in round 1'], 'no games yet');
});

test('dashboard: progress counts planned rounds, series are best first, and done is done', () => {
    setRoster(['lo', 'hi']);
    const win = (id, w, l) => ({ id, p1: w, p2: l, outcome: 'won', winner: w, winnerSeat: 'p1', timing: t(5, 5), rounds: 5 });
    const rd = scoreRound(1, ladderOf(['lo-v0', 'hi-v0', 'rush'], [win('g1', 'hi-v0', 'rush'), win('g2', 'hi-v0', 'lo-v0'), win('g3', 'rush', 'lo-v0')], 'done'));
    dash.publishStandings({ status: 'done', rounds: [rd], global: globalElo([rd]), tournament: { id: 't', plannedRounds: 2, rounds: [1] } });
    const ex = dashFile('experiments', 'arena.json');
    assert.strictEqual(ex.status, 'done');
    assert.deepStrictEqual(ex.progress, { done: 1, total: 2, unit: 'rounds' });
    assert.deepStrictEqual(ex.chart.series.map((s) => s.name), ['hi', 'lo']);
    assert.strictEqual(ex.metrics[0].value, 'hi-v0');
    assert.strictEqual(dashFile('panels', 'arena-leaderboard.json').status, 'done');
    assert.strictEqual(dashFile('panels', 'arena-lo.json').status, 'done');
});

test('dashboard: say and the referee write separate halves, so neither loses the other\'s update', () => {
    setRoster(['half']);
    const diagram = { type: 'strategy', title: 'd', nodes: [{ id: 'n', label: 'n', kind: 'input' }], edges: [], highlight: [], steps: [] };
    dash.updatePanel('half', { now: 'tuning', thought: 'first', diagram, plan: [null, '', '  ', 'a', { text: 'b', state: 'doing' }, { text: 7, state: 'bogus' }, { state: 'done' }, ...Array(20).fill('more')] });
    const rd = scoreRound(1, ladderOf(['half-v0', 'rush'], [{ id: 'g1', p1: 'half-v0', p2: 'rush', outcome: 'won', winner: 'half-v0', winnerSeat: 'p1', timing: t(5, 5), rounds: 4 }], 'done'));
    dash.publishStandings({ status: 'running', rounds: [rd], global: globalElo([rd]) });
    let p = dashFile('panels', 'arena-half.json');
    assert.strictEqual(p.now, 'tuning');
    assert.strictEqual(p.thoughts[0].text, 'first');
    assert.deepStrictEqual(p.widgets.map((w) => w.type), ['strategy', 'stats', 'line', 'line', 'table', 'text']);
    assert.strictEqual(p.plan.length, 12);
    assert.deepStrictEqual(p.plan.slice(0, 3), [{ text: 'a', state: 'todo' }, { text: 'b', state: 'doing' }, { text: '7', state: 'todo' }]);
    assert.ok(p.plan.every((x) => typeof x.text === 'string' && x.text));
    dash.updatePanel('half', { thought: 'second' });
    p = dashFile('panels', 'arena-half.json');
    assert.deepStrictEqual(p.bots, ['half-v0'], 'the referee\'s fields survive a later say');
    assert.deepStrictEqual(p.thoughts.map((x) => x.text), ['first', 'second']);
    assert.strictEqual(p.widgets[0].type, 'strategy');
    assert.ok(fs.existsSync(path.join(HOME, 'panels', 'half.say.json')) && fs.existsSync(path.join(HOME, 'panels', 'half.rated.json')));
});

test('eval reads results from by and winnerSeat', () => {
    const { resultFor } = require('../arena/eval');
    assert.strictEqual(resultFor({ outcome: 'ERROR', by: 'p1', winnerSeat: 'p2' }, 'p1'), 'loss');
    assert.strictEqual(resultFor({ outcome: 'ERROR', by: 'p1', winnerSeat: 'p2' }, 'p2'), 'win');
    assert.strictEqual(resultFor({ outcome: 'won', winner: 'me', winnerSeat: 'p2', by: null }, 'p2'), 'win');
    assert.strictEqual(resultFor({ outcome: 'won', winner: 'draw', winnerSeat: 'draw' }, 'p1'), 'draw');
    assert.strictEqual(resultFor({ outcome: 'ERROR', by: null, error: 'TIME_FORFEIT me' }, 'p1'), 'ERROR');
});

test('a stdio submission freezes its folder: cmd is a file in it or a program on PATH, and later edits do not reach it', () => {
    setRoster([]);
    const { api } = require('../arena/api');
    api.register({ name: 'pyb', start: 'rush' });
    const live = path.join(HOME, 'agents', 'pyb');
    fs.writeFileSync(path.join(live, 'bot.py'), 'print("v1")\n');
    const v = api.submit({ name: 'pyb', note: 'stdio', bot: { kind: 'stdio', cmd: 'python3', args: ['bot.py'] } }).version;
    fs.writeFileSync(path.join(live, 'bot.py'), 'print("v2")\n');
    assert.strictEqual(fs.readFileSync(path.join(HOME, 'versions', v, 'bot.py'), 'utf8'), 'print("v1")\n');
    const { resolveArena } = require('../arena/registry');
    assert.strictEqual(resolveArena(v).dir, path.join(HOME, 'versions', v));
    for (const bot of [{ kind: 'stdio', cmd: '/usr/bin/python3' }, { kind: 'stdio', cmd: '../x' }, { kind: 'stdio', cmd: './missing' }, { kind: 'stdio', cmd: 'python3', cwd: '/tmp' },
        { kind: 'stdio', cmd: 'python3', args: [path.join(live, 'bot.py')] }, { kind: 'stdio', cmd: 'python3', args: ['--model=../x'] }]) {
        assert.throws(() => api.submit({ name: 'pyb', note: 'bad', bot }), (e) => e.code === 'bad_request', JSON.stringify(bot));
    }
    // it plays as a protocol v2 client (bot/stdio.js), started in its version folder
    const { makeArenaBot } = require('../arena/registry');
    const { StdioClient } = require('../stdio');
    const prog = makeArenaBot(v);
    assert.ok(prog instanceof StdioClient);
    assert.deepStrictEqual([prog.name, prog.opts.cmd, prog.opts.args, prog.opts.cwd], [v, 'python3', ['bot.py'], path.join(HOME, 'versions', v)]);
});

test('an in-process protocol client passes the load check and plays as one', () => {
    setRoster([]);
    const { api } = require('../arena/api');
    api.register({ name: 'clie', start: 'rush' });
    fs.writeFileSync(path.join(HOME, 'agents', 'clie', 'bot.js'), "exports.createBot = (name) => ({ name, decide: () => ({ t: 'act', i: 0 }) });\n");
    const v = api.submit({ name: 'clie', note: 'client' }).version;
    const bot = require('../arena/registry').makeArenaBot(v);
    assert.strictEqual(typeof bot.decide, 'function');
    assert.strictEqual(bot.name, v);
    fs.writeFileSync(path.join(HOME, 'agents', 'clie', 'bot.js'), 'exports.createBot = (name) => ({ name });\n');
    assert.throws(() => api.submit({ name: 'clie', note: 'neither' }), (e) => e.code === 'bad_bot' && /choose\(\) method .* decide\(\) method/.test(e.message));
});

test('mirror makes a live folder a copy of a version: stale files go, .git and node_modules stay, symlinks are replaced', () => {
    const { mirror } = require('../arena/home');
    const d = fs.mkdtempSync(path.join(tmp, 'mirror-'));
    const put = (f, text) => {
        fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
        fs.writeFileSync(path.join(d, f), text);
    };
    put('src/bot.js', 'B');
    put('src/foo.txt', 'old');
    put('src/sub/x.txt', 'x');
    put('src/link.txt', 'mine');
    put('src/SUBMISSION.json', '{}');
    put('dst/foo.txt', 'newer, from another submit');
    put('dst/extra.txt', 'not in the version');
    put('dst/sub', 'a file where the version has a folder');
    put('dst/.git/HEAD', 'ref');
    put('dst/node_modules/m.js', 'm');
    put('outside.txt', 'untouched');
    fs.symlinkSync(path.join(d, 'outside.txt'), path.join(d, 'dst/link.txt'));
    mirror(path.join(d, 'src'), path.join(d, 'dst'));
    const files = (dir) => fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort();
    assert.deepStrictEqual(files(path.join(d, 'dst')), ['.git/HEAD', 'bot.js', 'foo.txt', 'link.txt', 'node_modules/m.js', 'sub/x.txt']);
    assert.strictEqual(fs.readFileSync(path.join(d, 'dst/foo.txt'), 'utf8'), 'old');
    assert.ok(!fs.lstatSync(path.join(d, 'dst/link.txt')).isSymbolicLink());
    assert.strictEqual(fs.readFileSync(path.join(d, 'outside.txt'), 'utf8'), 'untouched');
});

test('an upload leaves the live folder a copy of the version it made', () => {
    setRoster([]);
    const { api } = require('../arena/api');
    api.register({ name: 'upl', start: 'rush' });
    const live = path.join(HOME, 'agents', 'upl');
    const bot = fs.readFileSync(path.join(live, 'bot.js'), 'utf8');
    // another submit wrote the live folder after this one copied it (simulated: the live folder changes under the copy)
    const { copyBot } = require('../arena/home');
    const home = require('../arena/home');
    home.copyBot = (src, dst) => {
        copyBot(src, dst);
        fs.writeFileSync(path.join(src, 'foo.txt'), 'written by the other submit');
    };
    let v;
    try {
        v = api.submit({ name: 'upl', note: 'upload', bot: { kind: 'js', files: { 'bot.js': bot, 'bar.txt': 'mine' } } }).version;
    } finally {
        home.copyBot = copyBot;
    }
    const files = (dir) => fs.readdirSync(dir).filter((f) => f !== 'SUBMISSION.json').sort();
    assert.deepStrictEqual(files(live), files(path.join(HOME, 'versions', v)));
    assert.ok(!fs.existsSync(path.join(live, 'foo.txt')));
    assert.strictEqual(fs.readFileSync(path.join(live, 'bar.txt'), 'utf8'), 'mine');
});

test('registrations in a row all stay in the roster (roster updates are serialized)', () => {
    setRoster([]);
    const { api } = require('../arena/api');
    for (const n of ['ra', 'rb', 'rc']) {
        api.register({ name: n, start: 'rush' });
    }
    assert.deepStrictEqual(readJson(path.join(HOME, 'roster.json'), null).agents.map((a) => a.name), ['ra', 'rb', 'rc']);
    assert.ok(!fs.existsSync(path.join(HOME, 'roster.json.lock')), 'the lock is released');
});

test('a registration whose first submit fails is undone, so the name can be registered again', () => {
    setRoster([]);
    const { api } = require('../arena/api');
    const submit = api.submit;
    api.submit = () => {
        throw new Error('load check failed');
    };
    try {
        assert.throws(() => api.register({ name: 'oops', start: 'rush' }), /load check failed/);
    } finally {
        api.submit = submit;
    }
    assert.deepStrictEqual(readJson(path.join(HOME, 'roster.json'), null).agents, []);
    assert.ok(!fs.existsSync(path.join(HOME, 'agents', 'oops')));
    assert.ok(api.register({ name: 'oops', start: 'rush' }).token);
});

test('panel is composed from the arena\'s own halves, with or without the dashboard folder', () => {
    setRoster([]);
    const { api } = require('../arena/api');
    const { token } = api.register({ name: 'pan', start: 'rush' });
    api.say({ name: 'pan', now: 'Tuning', token });
    const dashPanel = path.join(process.env.ARENA_DASH, 'panels', 'arena-pan.json');
    fs.rmSync(dashPanel, { force: true });
    assert.strictEqual(api.panel({ name: 'pan' }).now, 'Tuning');
});

test('runner: a harness is stopped at its deadline with everything it started, in any process group', async () => {
    const { runUntil, tagged } = require('../arena/runner');
    const tag = `test-${process.pid}`;
    const out = path.join(tmp, 'harness.log');
    const t0 = Date.now();
    const res = await runUntil('bash', ['-c', 'setsid sleep 913 & sleep 914 & sleep 915'], { cwd: tmp, env: { ...process.env, ARENA_RUN: tag }, out, stopAt: Date.now() + 1500, tag });
    assert.strictEqual(res.stopped, true);
    assert.ok(Date.now() - t0 < 5000, 'stopped at the deadline');
    await new Promise((r) => setTimeout(r, 300));
    assert.deepStrictEqual(tagged(tag), [], 'nothing it started is left, the setsid child included');
});

test('runner: the usage brake holds while a window is over its limit, until that window resets', () => {
    const { lastLimits, noteLimits, braked } = require('../arena/runner');
    const soon = Math.floor(Date.now() / 1000) + 3600;
    const event = (u5, u7, status = 'allowed') => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status, unifiedWindows: { five_hour: { utilization: u5, resetsAt: soon }, seven_day: { utilization: u7, resetsAt: soon } } } });
    assert.strictEqual(lastLimits('{"type":"system"}\n'), null);
    noteLimits(lastLimits(`${event(0.9, 0.5)}\n{"type":"assistant"}\n${event(0.2, 0.5)}\n`));
    assert.strictEqual(braked(), null, 'the newest event counts');
    noteLimits(lastLimits(`${event(0.85, 0.5)}\n`));
    assert.match(braked(), /five_hour usage 85%/);
    assert.strictEqual(braked(soon * 1000 + 1), null, 'over once the window resets');
    noteLimits(lastLimits(`${event(0.1, 0.96)}\n`));
    assert.match(braked(), /seven_day/);
    noteLimits(lastLimits(`${event(0.1, 0.1, 'rejected')}\n`));
    assert.match(braked(), /over its limit/);
    noteLimits(lastLimits(`${event(0.1, 0.1)}\n`));
    assert.strictEqual(braked(), null);
});

test('runner: the usage brake stops Claude sessions only, and the runner starts only harnesses it knows', () => {
    const { noteLimits, running, runnable } = require('../arena/runner');
    const stopped = [];
    running.set('a-r1', { stop: () => stopped.push('a-r1'), claude: true });
    running.set('opt-r1', { stop: () => stopped.push('opt-r1'), claude: false });
    try {
        noteLimits({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.99, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } });
        assert.deepStrictEqual(stopped, ['a-r1']);
    } finally {
        running.clear();
        noteLimits({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0 }, seven_day: { utilization: 0 } } });
    }
    assert.ok(runnable({ kind: 'claude-code', model: 'opus' }));
    assert.ok(runnable({ kind: 'script', cmd: 'node bot/arena/optimizer.js' }));
    assert.ok(runnable({ kind: 'command', cmd: ['prog', '{prompt_file}'] }));
    for (const h of [{ kind: 'script' }, { kind: 'command', cmd: [] }, { kind: 'codex' }, { kind: 'Claude Code' }, null]) {
        assert.ok(!runnable(h), JSON.stringify(h));
    }
});

test('runner: a session that follows another with the same tag is not stopped by the first one\'s cleanup', async () => {
    const { runUntil } = require('../arena/runner');
    const tag = `test-next-${process.pid}`;
    const opts = { cwd: tmp, env: { ...process.env, ARENA_RUN: tag }, out: path.join(tmp, 'next.log'), stopAt: Date.now() + 60000, tag };
    const first = await runUntil('bash', ['-c', 'sleep 30 & exit 0'], opts);
    assert.strictEqual(first.code, 0);
    const second = await runUntil('bash', ['-c', 'sleep 6'], opts);
    assert.deepStrictEqual([second.code, second.stopped], [0, false], 'the second session ran to its end');
});

test('optimizer: against a remote arena it goes on from the genome it last submitted (--state)', () => {
    const { spawnSync } = require('child_process');
    const state = path.join(tmp, 'opt-state.json');
    const read = () => spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(require("./bot/arena/optimizer").latestGenome()))', '--', '--state', state],
        { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, ARENA_URL: 'http://127.0.0.1:9' }, encoding: 'utf8' });
    assert.strictEqual(read().stdout.trim(), 'null', 'nothing submitted yet');
    const g = require('../arena/optimizer').genomeFrom('tempo');
    g['weights.power'] = 2.5;
    fs.writeFileSync(state, JSON.stringify({ version: 'opt-v3', genome: g }));
    assert.deepStrictEqual(JSON.parse(read().stdout), g);
    fs.writeFileSync(state, JSON.stringify({ genome: { a: 1 } }));
    assert.strictEqual(read().stdout.trim(), 'null', 'a broken state file is ignored');
});

test('register on a hosted arena: only the admin token keeps a harness the runner starts', () => {
    const { spawnSync } = require('child_process');
    const { runnable } = require('../arena/runner');
    const home = path.join(tmp, 'hosted');
    fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(home, 'roster.json'), JSON.stringify({ thinkCapMs: 60000, baselines: ['rush'], agents: [] }));
    const reg = (args) => JSON.parse(spawnSync(process.execPath, ['-e', `require('./bot/arena/api').call('register', ${JSON.stringify(args)}).then((o) => console.log(JSON.stringify(o)))`], {
        cwd: path.join(__dirname, '..', '..'), encoding: 'utf8',
        env: { ...process.env, ARENA_HOME: home, ARENA_AUTH: '1', ARENA_ADMIN_TOKEN: 'adm1n', ARENA_DASH: path.join(tmp, 'dash') }
    }).stdout);
    assert.ok(reg({ name: 'pub', start: 'rush', harness: { kind: 'command', cmd: ['sh', '-c', 'touch /tmp/pwned'], model: 'x' } }).result);
    assert.ok(reg({ name: 'adm', start: 'rush', harness: { kind: 'script', cmd: 'node x.js' }, token: 'adm1n' }).result);
    const agents = JSON.parse(fs.readFileSync(path.join(home, 'roster.json'), 'utf8')).agents;
    const pub = agents.find((a) => a.name === 'pub').harness;
    assert.deepStrictEqual(pub, { kind: 'command', model: 'x', selfRun: true }, 'the command is dropped');
    assert.ok(!runnable(pub));
    assert.ok(runnable(agents.find((a) => a.name === 'adm').harness), 'the admin may register one the runner starts');
});

test('server: a queued eval\'s lost-game replay is served, and eval_result names its URL', async () => {
    const http = require('http');
    const { handler } = require('../arena/server');
    const { RESULTS } = require('../arena/home');
    const dir = path.join(RESULTS, 'arena-evals', 'me-v1-abc');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'me-v1-vs-rush-20001-s1.jsonl'), '{"t":"header"}\n');
    writeJson(path.join(HOME, 'queue', 'me-v1-abc.json'), { id: 'me-v1-abc', state: 'done', summary: { losses: [{ id: 'g', replay: path.join(dir, 'me-v1-vs-rush-20001-s1.jsonl') }] } });
    const out = await require('../arena/api').call('eval_result', { id: 'me-v1-abc' });
    const url = out.result.summary.losses[0].replayUrl;
    assert.strictEqual(url, 'replays/arena-evals/me-v1-abc/me-v1-vs-rush-20001-s1.jsonl');
    const srv = http.createServer(handler).listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    try {
        assert.strictEqual(await (await fetch(`${base}/${url}`)).text(), '{"t":"header"}\n');
        assert.strictEqual((await fetch(`${base}/replays/arena-evals/..%2F..%2Fsecret/x.jsonl`)).status, 404);
    } finally {
        srv.close();
    }
});

test('server: / is the app when its build exists, /arena is always the arena UI', async () => {
    const http = require('http');
    const { handler } = require('../arena/server');
    const app = path.join(HOME, 'public.html');
    fs.writeFileSync(app, '<!doctype html><title>SWU Arena app</title>');
    const before = process.env.ARENA_APP;
    const srv = http.createServer(handler).listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const ui = fs.readFileSync(path.join(__dirname, '..', 'arena', 'web', 'index.html'), 'utf8');
    try {
        process.env.ARENA_APP = app;
        assert.match(await (await fetch(`${base}/`)).text(), /SWU Arena app/);
        assert.strictEqual(await (await fetch(`${base}/arena`)).text(), ui);
        assert.ok((await (await fetch(`${base}/api/status`)).json()).result, '/api is unchanged');
        process.env.ARENA_APP = '';
        assert.strictEqual(await (await fetch(`${base}/`)).text(), ui, 'no app build: / stays the arena UI');
        process.env.ARENA_APP = path.join(HOME, 'missing.html');
        assert.strictEqual(await (await fetch(`${base}/`)).text(), ui);
    } finally {
        srv.close();
        if (before === undefined) {
            delete process.env.ARENA_APP;
        } else {
            process.env.ARENA_APP = before;
        }
    }
});

test('server: gzip only when Accept-Encoding allows it', () => {
    const { acceptsGzip } = require('../arena/server');
    for (const h of ['gzip', 'deflate, gzip', 'GZIP;Q=0.5', 'br, *', 'gzip;q=1, *;q=0']) {
        assert.strictEqual(acceptsGzip(h), true, h);
    }
    for (const h of [undefined, '', 'identity', 'gzip;q=0', 'deflate, gzip;q=0', '*;q=0', 'gzip;q=0, *', 'gzip;q=0.000']) {
        assert.strictEqual(acceptsGzip(h), false, String(h));
    }
});

test('tournament rounds get ladder ids scoped to the tournament; games and the server follow them', async () => {
    const { ladderIdOf } = require('../arena/referee');
    assert.strictEqual(ladderIdOf(3), 'arena-r3', 'outside a tournament');
    assert.strictEqual(ladderIdOf(1, { id: 'arena-t202610130610' }), 'arena-t202610130610-r1');
    assert.strictEqual(ladderIdOf(2, { id: 'holdout' }), 'arena-holdout-r2', 'every arena run keeps the arena- prefix');
    const { RESULTS } = require('../arena/home');
    const { call, TOURNAMENT } = require('../arena/api');
    const index = (id) => {
        fs.mkdirSync(path.join(RESULTS, id, 'games'), { recursive: true });
        writeJson(path.join(RESULTS, id, 'index.json'), { games: [{ id: `${id}-g1` }] });
        fs.writeFileSync(path.join(RESULTS, id, 'games', `${id}-g1.jsonl`), `{"id":"${id}"}\n`);
    };
    index('arena-r41');
    index('arena-tx-r41');
    index('arena-tx-r42');
    const before = readJson(path.join(HOME, 'standings.json'), null);
    writeJson(path.join(HOME, 'standings.json'), { rounds: [{ round: 41, ladderId: 'arena-tx-r41', bots: [] }], global: {} });
    writeJson(TOURNAMENT(), { id: 'arena-tx', state: 'running', rounds: [{ n: 41, ladder: 'arena-tx-r41' }, { n: 42, ladder: 'arena-tx-r42' }] });
    const http = require('http');
    const { handler } = require('../arena/server');
    const srv = http.createServer(handler).listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    try {
        const g41 = (await call('games', { round: 41 })).result;
        assert.strictEqual(g41.replayBase, 'replays/arena-tx-r41/games/', 'published rounds: standings name the ladder');
        const g42 = (await call('games', { round: 42 })).result;
        assert.strictEqual(g42.replayBase, 'replays/arena-tx-r42/games/', 'a round not published yet: tournament.json names it');
        assert.strictEqual(await (await fetch(`${base}/${g42.replayBase}${g42.games[0].id}.jsonl`)).text(), '{"id":"arena-tx-r42"}\n');
        assert.strictEqual((await fetch(`${base}/replays/arena-r41/index.json`)).status, 200, 'arena-r<K> is still served');
        // a ladder id that is not an arena folder name is ignored
        writeJson(path.join(HOME, 'standings.json'), { rounds: [{ round: 41, ladderId: '../arena-tx-r41', bots: [] }], global: {} });
        writeJson(TOURNAMENT(), { id: 'arena-tx', state: 'running', rounds: [] });
        assert.strictEqual((await call('games', { round: 41 })).result.replayBase, 'replays/arena-r41/games/');
        assert.strictEqual((await fetch(`${base}/replays/..%2Fsecret-r1/index.json`)).status, 404);
    } finally {
        srv.close();
        fs.rmSync(TOURNAMENT(), { force: true });
        if (before) {
            writeJson(path.join(HOME, 'standings.json'), before);
        } else {
            fs.rmSync(path.join(HOME, 'standings.json'), { force: true });
        }
    }
});

test('holdout split: seeded, per stratum, disjoint, every base in both pools', () => {
    const { splitPool, writePools, loadPool } = require('../cardpool');
    const card = (setCode, types, aspects, unique = false) => ({ id: `id-${setCode}`, setCode, internalName: `c-${setCode}`, types, aspects, unique });
    const index = { leaders: [], bases: [], pool: [] };
    for (let i = 0; i < 10; i++) {
        index.leaders.push(card(`L${i}`, ['leader'], i % 2 ? ['aggression', 'villainy'] : ['vigilance', 'heroism'], true));
        index.pool.push(card(`U${i}`, ['unit'], ['aggression']), card(`E${i}`, ['event'], ['vigilance']), card(`N${i}`, ['upgrade'], []));
    }
    index.bases.push(card('B1', ['base'], ['aggression']), card('B2', ['base'], ['vigilance']));
    const a = splitPool(index, { fraction: 0.3, seed: 's1' });
    assert.deepStrictEqual(splitPool(index, { fraction: 0.3, seed: 's1' }), a, 'the same seed gives the same split');
    assert.notDeepStrictEqual(splitPool(index, { fraction: 0.3, seed: 's2' }).holdout, a.holdout, 'another seed gives another split');
    const codes = (cards, pred = () => true) => cards.filter(pred).map((c) => c.setCode);
    const notBase = (c) => !c.types.includes('base');
    const held = new Set(codes(a.holdout, notBase));
    assert.ok(codes(a.train, notBase).every((c) => !held.has(c)), 'leaders and main cards are in one pool only');
    assert.strictEqual(codes(a.train, notBase).length + held.size, 40, 'and every one is in a pool');
    assert.deepStrictEqual(codes(a.holdout, (c) => !notBase(c)), ['B1', 'B2']);
    assert.deepStrictEqual(codes(a.train, (c) => !notBase(c)), ['B1', 'B2']);
    // each stratum (5 leaders or 10 main cards of one type and aspect set) loses round(0.3 x size)
    for (const prefix of ['U', 'E', 'N']) {
        assert.strictEqual([...held].filter((c) => c.startsWith(prefix)).length, 3, prefix);
    }
    assert.strictEqual([...held].filter((c) => c.startsWith('L')).length, 4, 'two leader strata of 5: 2 each');
    assert.throws(() => splitPool(index, { fraction: 1, seed: 's' }), /between 0 and 1/);
    assert.throws(() => splitPool(index, { fraction: 0.3 }), /seed/);
    const dir = path.join(tmp, 'pools');
    const files = writePools(dir, a, { fraction: 0.3 });
    const train = loadPool(files.train.path);
    assert.strictEqual(train.kind, 'train');
    assert.strictEqual(train.provenance.sha256, files.train.sha256);
    assert.deepStrictEqual(files.holdout.counts, { leaders: 4, bases: 2, main: 9 });
    fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ schema: 'swu-arena-pool/1', kind: 'train', cards: [a.train[0], a.train[0]] }));
    assert.throws(() => loadPool(path.join(dir, 'bad.json')), /repeated/);
    fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify({ schema: 'omni-rs-pool-v1', cards: [] }));
    assert.throws(() => loadPool(path.join(dir, 'other.json')), /not an arena card pool/);
});

test('a held-out round is compared with the last training round and stays out of the all-round Elo', () => {
    const { rankCorrelation, report } = require('../arena/referee');
    assert.strictEqual(rankCorrelation({ a: 1, b: 2, c: 3 }, { a: 1, b: 2, c: 3 }), 1);
    assert.strictEqual(rankCorrelation({ a: 1, b: 2, c: 3 }, { a: 3, b: 2, c: 1 }), -1);
    assert.strictEqual(rankCorrelation({ a: 1, b: 2 }, { a: 2, b: 1 }), null, 'fewer than 3 bots');
    assert.strictEqual(rankCorrelation({ a: 1, b: 2, c: 3, d: 4 }, { a: 1, b: 2, c: 3 }), 1, 'only the bots both rounds rated');
    setRoster(['x']);
    const game = (id, p1, p2, winner) => ({ id, p1, p2, outcome: 'won', winner, winnerSeat: winner === p1 ? 'p1' : 'p2', by: null, timing: t(5, 5) });
    const ladder = (id, kind, games) => ({ ...ladderOf(['x-v1', 'rush', 'heuristic'], games, 'done'), id, config: { bots: ['x-v1', 'rush', 'heuristic'], firstSeed: 9, gamesPerPair: 2, pool: { kind, cards: kind === 'holdout' ? 600 : 1400 } } });
    const train = scoreRound(3, ladder('arena-tx-r3', 'train', [game('g1', 'x-v1', 'rush', 'x-v1'), game('g2', 'x-v1', 'heuristic', 'x-v1'), game('g3', 'rush', 'heuristic', 'heuristic')]));
    const held = scoreRound(4, ladder('arena-tx-r4', 'holdout', [game('h1', 'x-v1', 'rush', 'rush'), game('h2', 'x-v1', 'heuristic', 'heuristic'), game('h3', 'rush', 'heuristic', 'rush')]));
    assert.strictEqual(train.pool, 'train');
    assert.strictEqual(held.pool, 'holdout');
    assert.deepStrictEqual(globalElo([train, held]), globalElo([train]), 'held-out games are not in the all-round Elo');
    const md = report(held, globalElo([train]), train);
    assert.match(md, /results \(held-out cards\)/);
    assert.match(md, /dealt only from the held-out pool \(600 cards/);
    assert.match(md, /## Held-out cards vs training cards/);
    assert.match(md, /Spearman rank correlation: -1/, 'x-v1 went from first to last');
    assert.match(report(train, globalElo([train])), /this tournament's training pool \(1400 cards/);
    const { rulesText } = require('../arena/runner');
    assert.strictEqual(rulesText(null), '');
    assert.match(rulesText({ holdout: { fraction: 0.3, trainPool: '/a/train.json', trainCards: 1400, holdoutCards: 600 } }), /30% of the leaders and main-deck cards are held out.*1400 training cards.*600 held-out cards/s);
});
