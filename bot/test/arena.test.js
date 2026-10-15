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

const { ROUND_DECKS, cappedScore, scoreRound, globalElo, lineup, roundSeed, loadSecret, report, helpersLine } = require('../arena/referee');
const dash = require('../arena/dash');
const { HOME, writeJson, readJson } = require('../arena/home');

const t = (p1, p2) => ({ p1: { ms: p1, n: 10, p95: 1 }, p2: { ms: p2, n: 10, p95: 1 } });
const dashFile = (...p) => readJson(path.join(process.env.ARENA_DASH, ...p), null);
const ladderOf = (bots, games, status = 'running') => ({ id: 'arena-r1', status, config: { bots, firstSeed: 77, gamesPerPair: 2 }, progress: { scheduled: 4 }, games });

// a minimal bot program (spec/protocol.md): ready to hello, the first action to decide, ok to over
const PY_BOT = 'import json, sys\nfor line in sys.stdin:\n    t = json.loads(line)["t"]\n    print(json.dumps({"hello": {"t": "ready", "v": 2}, "over": {"t": "ok"}}.get(t, {"t": "act", "i": 0})), flush=True)\n';

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

test('scoreRound says where the games ran, and the report names the hosts once a helper played', () => {
    setRoster(['x']);
    const g = (id, host, ms) => ({ id, p1: 'x-v0', p2: 'rush', outcome: 'won', winner: 'x-v0', winnerSeat: 'p1', timing: t(ms, ms), rounds: 5, ...(host === undefined ? {} : { host }) });
    // an entry from before hosts were recorded counts as the machine's
    const games = [g('g1', null, 400), g('g2', undefined, 420), g('g3', 'eric', 380), { id: 'g4', p1: 'rush', p2: 'x-v0', outcome: 'running', host: null }];
    const rd = scoreRound(4, ladderOf(['x-v0', 'rush'], games));
    assert.deepStrictEqual(rd.hosts, { machine: { games: 2, decisions: 40, thinkMs: 1640 }, eric: { games: 1, decisions: 20, thinkMs: 760 } });
    const md = report(rd, {});
    assert.match(md, /\nWhere games ran: machine 2 games \(41 ms\/decision\), eric 1 game \(38 ms\/decision\)\.\n/);
    assert.ok(md.indexOf('Where games ran') > md.indexOf('| x-v0 |') && md.indexOf('Where games ran') < md.indexOf('## x'), 'under the table');
    // all on the machine: no line
    const here = scoreRound(4, ladderOf(['x-v0', 'rush'], [g('g1', null, 400)]));
    assert.deepStrictEqual(here.hosts, { machine: { games: 1, decisions: 20, thinkMs: 800 } });
    assert.ok(!report(here, {}).includes('Where games ran'));
});

test('the report says what the helper lane did, so a round with no helper games shows why', () => {
    setRoster(['x']);
    const g = { id: 'g1', p1: 'x-v0', p2: 'rush', outcome: 'won', winner: 'x-v0', winnerSeat: 'p1', timing: t(400, 400), rounds: 5, host: null };
    const lane = { lane: true, hosts: ['eric'], looks: 360, claimLooks: 0, leased: 0, played: 0, lost: 0, lastLost: null, relayErrors: [], stopped: null };
    const rd = scoreRound(4, { ...ladderOf(['x-v0', 'rush'], [g]), remote: lane });
    assert.deepStrictEqual(rd.remote, lane);
    const md = report(rd, {});
    assert.match(md, /\nHelpers: eric said hello; a claim waited at 0 of 360 looks; 0 seeds went out, 0 games came back\.\n/);
    assert.ok(md.indexOf('Helpers:') > md.indexOf('| x-v0 |') && md.indexOf('Helpers:') < md.indexOf('## x'), 'under the table');
    assert.strictEqual(helpersLine({ ...lane, hosts: [], looks: 1 }), 'Helpers: no helper said hello to the games machine; a claim waited at 0 of 1 look; 0 seeds went out, 0 games came back.');
    assert.strictEqual(helpersLine({ ...lane, claimLooks: 12, leased: 3, played: 4, lost: 1, lastLost: 'eric: no heartbeat', relayErrors: ['ECONNREFUSED'], stopped: 'the relay has failed for 180 s' }),
        'Helpers: eric said hello; a claim waited at 12 of 360 looks; 3 seeds went out, 4 games came back; 1 lost (last: eric: no heartbeat); relay errors: ECONNREFUSED; the lane stopped: the relay has failed for 180 s.');
    assert.strictEqual(helpersLine({ lane: false, why: 'ARENA_REMOTE is not a relay address' }), 'Helpers: none this round (ARENA_REMOTE is not a relay address).');
    // the helper node off (no ARENA_REMOTE): no line, and older ladders have no remote at all
    assert.strictEqual(scoreRound(4, ladderOf(['x-v0', 'rush'], [g])).remote, null);
    assert.ok(!report(scoreRound(4, ladderOf(['x-v0', 'rush'], [g])), {}).includes('Helpers:'));
});

test('a round says which deck lists it dealt, and its report tells the competitors', () => {
    setRoster(['x']);
    const g = { id: 'g1', p1: 'x-v0', p2: 'rush', outcome: 'won', winner: 'x-v0', winnerSeat: 'p1', timing: t(400, 400), rounds: 5, host: null, decks: { p1: 'a', p2: 'b' } };
    const lad = ladderOf(['x-v0', 'rush'], [g]);
    lad.config.decks = { file: 'ash-meta-2026-09.json', sha256: 'f'.repeat(64), names: Array.from({ length: 26 }, (_, i) => `d${i}`), deal: 'seat', skipped: ['lando-calrissian_law_blue'] };
    const rd = scoreRound(4, lad);
    assert.deepStrictEqual(rd.decks, { file: 'ash-meta-2026-09.json', sha256: 'f'.repeat(64), lists: 26, deal: 'seat' });
    assert.match(report(rd, {}), /each from both seats\)\. Decks: 26 tournament lists \(`ash-meta-2026-09\.json`\), each seed's two decks played by both bots\. Status/);
    // rounds before the switch dealt random decks
    const old = scoreRound(4, ladderOf(['x-v0', 'rush'], [g]));
    assert.strictEqual(old.decks, undefined);
    assert.match(report(old, {}), /Decks: random\. Status/);
});

test('the round\'s deck lists pass the deck checks, and the lists it leaves out are in the file', { skip: !fs.existsSync(path.join(__dirname, '..', '..', 'forceteki', 'build', 'server')) && 'engine not built' }, () => {
    const { loadDecks } = require('../decklists');
    const { decks } = loadDecks(ROUND_DECKS.file, new (require('../env').Env)());
    const names = decks.map((d) => d.metadata.name);
    assert.ok(ROUND_DECKS.skip.every((n) => names.includes(n)), ROUND_DECKS.skip.join(', '));
    assert.ok(names.length - ROUND_DECKS.skip.length >= 2);
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

test('a competitor benched while its round runs still owns the games of that round', () => {
    writeJson(path.join(HOME, 'roster.json'), { thinkCapMs: 60000, baselines: ['rush'], agents: [], bench: [{ name: 'gone', title: 'gone' }] });
    const rd = scoreRound(1, ladderOf(['gone-v0', 'rush'], [{ id: 'g1', p1: 'gone-v0', p2: 'rush', outcome: 'won', winner: 'gone-v0', winnerSeat: 'p1', timing: t(5, 5), rounds: 5 }]));
    assert.strictEqual(rd.bots.find((b) => b.name === 'gone-v0').agent, 'gone');
    assert.strictEqual(rd.leader, 'gone-v0');
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

test('dashboard: a competitor that sat out the latest round shows the round its stats come from', () => {
    setRoster(['sat', 'on']);
    const win = (id, w, l) => ({ id, p1: w, p2: l, outcome: 'won', winner: w, winnerSeat: 'p1', timing: t(5, 5), rounds: 5 });
    const r1 = scoreRound(1, ladderOf(['sat-v0', 'on-v0', 'rush'], [win('g1', 'sat-v0', 'rush'), win('g2', 'sat-v0', 'on-v0'), win('g3', 'rush', 'on-v0')], 'done'));
    const r2 = scoreRound(2, ladderOf(['on-v0', 'rush'], [win('g4', 'on-v0', 'rush')], 'done'));
    dash.publishStandings({ status: 'running', rounds: [r1, r2], global: globalElo([r1, r2]), tournament: { id: 't', plannedRounds: 3, rounds: [1, 2] } });
    const items = (n) => Object.fromEntries(dashFile('panels', `arena-${n}.json`).widgets[0].items.map((i) => [i.label, i.value]));
    assert.strictEqual(items('sat')['rank in round 1'], '1 / 3');
    assert.strictEqual(items('on')['rank in round 2'], '1 / 2');
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

test('a stdio submission freezes its folder: cmd is a file in it or a program on PATH, and later edits do not reach it', () => {
    setRoster([]);
    const { api } = require('../arena/api');
    api.register({ name: 'pyb', start: 'rush' });
    const live = path.join(HOME, 'agents', 'pyb');
    fs.writeFileSync(path.join(live, 'bot.py'), `${PY_BOT}# v1\n`);
    const v = api.submit({ name: 'pyb', note: 'stdio', bot: { kind: 'stdio', cmd: 'python3', args: ['bot.py'] } }).version;
    fs.writeFileSync(path.join(live, 'bot.py'), `${PY_BOT}# v2\n`);
    assert.strictEqual(fs.readFileSync(path.join(HOME, 'versions', v, 'bot.py'), 'utf8'), `${PY_BOT}# v1\n`);
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
    // with the card data: the version folder has none
    assert.strictEqual(prog.opts.env.SWU_CARD_JSON, require('../arena/registry').CARD_JSON);
});

test('a bot program must start and answer hello with ready, or the submit fails and no version is made', () => {
    setRoster([]);
    const { api } = require('../arena/api');
    api.register({ name: 'mute', start: 'rush' });
    const live = path.join(HOME, 'agents', 'mute');
    const before = require('../arena/home').versionsOf('mute');
    fs.writeFileSync(path.join(live, 'bot.py'), 'import sys\nprint("hi")\n');
    assert.throws(() => api.submit({ name: 'mute', note: 'not json', bot: { kind: 'stdio', cmd: 'python3', args: ['bot.py'] } }),
        (e) => e.code === 'bad_bot' && /failed the start check/.test(e.message) && /not JSON/.test(e.message));
    fs.writeFileSync(path.join(live, 'bot.py'), 'import sys\nsys.exit(3)\n');
    assert.throws(() => api.submit({ name: 'mute', note: 'exits', bot: { kind: 'stdio', cmd: 'python3', args: ['bot.py'] } }), (e) => e.code === 'bad_bot' && /exited \(code 3/.test(e.message));
    // a file without its exec bit (a synced arena folder keeps none) cannot start: the error says how to run it instead
    fs.writeFileSync(path.join(live, 'run.sh'), `#!/bin/sh\nexec python3 -c '${PY_BOT.replace(/'/g, "'\\''")}'\n`, { mode: 0o644 });
    assert.throws(() => api.submit({ name: 'mute', note: 'no x bit', bot: { kind: 'stdio', cmd: './run.sh' } }),
        (e) => e.code === 'bad_bot' && /EACCES/.test(e.message) && /"cmd": "sh", "args": \["\.\/run\.sh"\]/.test(e.message));
    assert.deepStrictEqual(require('../arena/home').versionsOf('mute'), before);
    const v = api.submit({ name: 'mute', note: 'through sh', bot: { kind: 'stdio', cmd: 'sh', args: ['run.sh'] } }).version;
    assert.strictEqual(readJson(path.join(HOME, 'versions', v, 'SUBMISSION.json'), {}).checked, true);
});

test('the load check runs submitted code without the arena secrets or the egress proxy', () => {
    setRoster([]);
    const { api } = require('../arena/api');
    api.register({ name: 'nosy', start: 'rush' });
    fs.writeFileSync(path.join(HOME, 'agents', 'nosy', 'bot.js'),
        "const leak = ['HTTPS_PROXY', 'https_proxy', 'ARENA_ADMIN_TOKEN'].filter((k) => process.env[k]);\nif (leak.length) throw new Error('saw ' + leak.join(' '));\nexports.createBot = (name) => ({ name, choose: () => 0 });\n");
    const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy, ARENA_ADMIN_TOKEN: process.env.ARENA_ADMIN_TOKEN };
    Object.assign(process.env, { HTTPS_PROXY: 'http://proxy.invalid:1', https_proxy: 'http://proxy.invalid:1', ARENA_ADMIN_TOKEN: 'x' });
    try {
        assert.ok(api.submit({ name: 'nosy', note: 'env' }).version);
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) {
                delete process.env[k];
            } else {
                process.env[k] = v;
            }
        }
    }
});

test('withdraw benches a competitor or stops rating one version; rejoin undoes either', () => {
    setRoster([]);
    const { api } = require('../arena/api');
    api.register({ name: 'wd', start: 'rush' });
    api.submit({ name: 'wd', note: 'v1' });
    api.submit({ name: 'wd', note: 'v2, broken' });
    assert.ok(lineup().includes('wd-v2'));
    assert.deepStrictEqual(api.withdraw({ name: 'wd', version: 2 }), { name: 'wd', withdrawn: 'wd-v2', rated: 'wd-v1' });
    assert.ok(lineup().includes('wd-v1') && !lineup().includes('wd-v2'));
    assert.throws(() => api.withdraw({ name: 'wd', version: 9 }), (e) => e.code === 'not_found');
    assert.throws(() => api.rejoin({ name: 'wd', version: 9 }), (e) => e.code === 'not_found');
    api.rejoin({ name: 'wd', version: '2' }); // query strings and shells send numbers as text
    assert.ok(lineup().includes('wd-v2'));
    assert.strictEqual(api.withdraw({ name: 'wd' }).benched, true);
    const r = readJson(path.join(HOME, 'roster.json'), {});
    assert.deepStrictEqual([r.agents.map((a) => a.name), r.bench.map((a) => a.name)], [[], ['wd']]);
    assert.ok(!lineup().some((b) => b.startsWith('wd-')));
    assert.strictEqual(api.status().competitors.find((c) => c.name === 'wd')?.benched, true, 'status still lists it, marked benched');
    assert.ok(api.panel({ name: 'wd' }) && api.panels().panels.length >= 1, 'its panel stays readable');
    assert.deepStrictEqual(api.versions({ name: 'wd' }).map((v) => v.name), ['wd-v0', 'wd-v1', 'wd-v2'], 'its versions stay readable');
    api.register({ name: 'wo', start: 'rush' });
    // a version withdrawn and rejoined while benched applies once the competitor rejoins
    assert.strictEqual(api.withdraw({ name: 'wd', version: 1 }).withdrawn, 'wd-v1');
    assert.strictEqual(api.rejoin({ name: 'wd', version: 1 }).benched, true);
    api.withdraw({ name: 'wd', version: 2 });
    api.rejoin({ name: 'wd' });
    assert.ok(lineup().includes('wd-v1') && !lineup().includes('wd-v2'));
    api.rejoin({ name: 'wd', version: 2 });
    const back = readJson(path.join(HOME, 'roster.json'), {});
    assert.deepStrictEqual([back.agents.map((a) => a.name), back.bench.length, 'benchedAt' in back.agents[1]], [['wo', 'wd'], 0, false]);
    assert.ok(lineup().includes('wd-v2'));
    // a benched competitor may still submit (a builder's later versions from the window): the version sits out with it
    api.withdraw({ name: 'wd' });
    const sub = api.submit({ name: 'wd', note: 'while benched' });
    assert.ok(!lineup().some((b) => b.startsWith('wd-')), `${sub.version} is not rated while wd is benched`);
    api.rejoin({ name: 'wd' });
    assert.ok(lineup().includes(sub.version));
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
    api.register({ name: 'pan', start: 'rush' });
    dash.updatePanel('pan', { now: 'Tuning' });
    const dashPanel = path.join(process.env.ARENA_DASH, 'panels', 'arena-pan.json');
    fs.rmSync(dashPanel, { force: true });
    assert.strictEqual(api.panel({ name: 'pan' }).now, 'Tuning');
});

test('referee lock: pids decide inside one PID namespace, the heartbeat across namespaces (isolate.sh gives the referee its own)', () => {
    const { takeLock, releaseLock } = require('../arena/referee');
    const dir = fs.mkdtempSync(path.join(tmp, 'lock-'));
    const file = path.join(dir, 'referee.lock');
    const ns = fs.readlinkSync('/proc/self/ns/pid');
    const dead = 2 ** 22 + 7; // above pid_max on Linux, so never a live process
    writeJson(file, { pid: dead, host: os.hostname(), pidns: ns });
    takeLock(dir); // a dead holder in this namespace: taken at once
    assert.strictEqual(readJson(file, {}).pid, process.pid);
    releaseLock();
    writeJson(file, { pid: dead, host: os.hostname(), pidns: 'pid:[1]' });
    assert.throws(() => takeLock(dir), /is running the ladder/, 'another namespace with a fresh heartbeat may still be running');
    const old = (Date.now() - 80000) / 1000;
    fs.utimesSync(file, old, old);
    takeLock(dir);
    assert.strictEqual(readJson(file, {}).pidns, ns);
    releaseLock();
    assert.ok(!fs.existsSync(file));
});

test('isolate.sh: the command sees only its own processes, hidden paths are empty, /tmp is its own, and --user cannot undo it', { skip: process.getuid?.() !== 0 && 'needs root (unshare)' }, () => {
    const { spawnSync } = require('child_process');
    const secret = path.join(tmp, 'secret.txt');
    fs.writeFileSync(secret, 'the round seeds');
    const script = `echo "procs $(ls /proc | grep -c '^[0-9]')"; echo "file [$(cat ${secret})]"; cat /proc/${process.pid}/environ 2>/dev/null | tr '\\0' '\\n' | grep -c ISO_PARENT_SECRET; exit 4`;
    const r = spawnSync('bash', [path.join(__dirname, '..', 'arena', 'ops', 'isolate.sh'), '--hide', secret, '--', 'sh', '-c', script],
        { env: { ...process.env, ISO_PARENT_SECRET: 'x' }, encoding: 'utf8', timeout: 20000 });
    if (/unshare failed|Operation not permitted/.test(r.stderr)) {
        return; // a container without namespaces: nothing to check here
    }
    assert.strictEqual(r.status, 4, r.stderr);
    assert.ok(Number(/procs (\d+)/.exec(r.stdout)[1]) < 10, r.stdout);
    assert.match(r.stdout, /file \[\]/);
    assert.match(r.stdout, /^0$/m, 'the test process\'s environment is out of reach');
    assert.strictEqual(fs.readFileSync(secret, 'utf8'), 'the round seeds', 'hidden, not changed');
    // --tmp: a folder of its own in place of /tmp, where nothing of the real /tmp shows
    const own = path.join(tmp, 'own-tmp');
    const marker = `/tmp/isolate-outside-${process.pid}`;
    fs.writeFileSync(marker, 'x');
    try {
        const t = spawnSync('bash', [path.join(__dirname, '..', 'arena', 'ops', 'isolate.sh'), '--tmp', own, '--', 'sh', '-c', `[ -e ${marker} ] && echo seen; echo made > /tmp/inside`],
            { encoding: 'utf8', timeout: 20000 });
        assert.strictEqual(t.status, 0, t.stderr);
        assert.doesNotMatch(t.stdout, /seen/);
        assert.strictEqual(fs.readFileSync(path.join(own, 'inside'), 'utf8'), 'made\n');
    } finally {
        fs.rmSync(marker, { force: true });
    }
    // --user: the command runs as that user without capabilities, so it cannot undo the hiding
    const u = spawnSync('bash', [path.join(__dirname, '..', 'arena', 'ops', 'isolate.sh'), '--user', 'nobody', '--hide', secret, '--', 'sh', '-c',
        `id -u; umount ${secret} 2>/dev/null && echo unmounted; umount -l /proc 2>/dev/null && echo proc-unmounted; grep CapEff /proc/self/status`],
        { encoding: 'utf8', timeout: 20000 });
    assert.strictEqual(u.status, 0, u.stderr);
    assert.match(u.stdout, /^65534$/m);
    assert.doesNotMatch(u.stdout, /unmounted/);
    assert.match(u.stdout, /CapEff:\s+0+$/m);
});

test('referee: bot code (the ladder) runs as ARENA_BOT_USER, cannot read the round-seed secret and does not get its path', { skip: process.getuid?.() !== 0 && 'needs root (setpriv)' }, async () => {
    const { spawnBots, giveToBots } = require('../arena/referee');
    // a folder the bot user can reach (the test's own is closed to it), holding a root-only secret
    const open = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-bot-user-'));
    fs.chmodSync(open, 0o755);
    const secret = path.join(open, 'secret');
    fs.writeFileSync(secret, 'the round seeds', { mode: 0o600 });
    const dir = path.join(open, 'ladder');
    fs.mkdirSync(dir);
    const saved = { user: process.env.ARENA_BOT_USER, file: process.env.ARENA_SECRET_FILE };
    process.env.ARENA_BOT_USER = 'nobody';
    process.env.ARENA_SECRET_FILE = secret;
    try {
        giveToBots(dir);
        assert.strictEqual(fs.statSync(dir).uid, 65534);
        const script = `const fs = require('fs'); let read = 'refused'; try { read = fs.readFileSync(${JSON.stringify(secret)}, 'utf8'); } catch {}
            fs.writeFileSync(${JSON.stringify(path.join(dir, 'out.json'))}, JSON.stringify({ uid: process.getuid(), read, path: process.env.ARENA_SECRET_FILE ?? null,
                cap: /CapEff:\\s+(\\w+)/.exec(fs.readFileSync('/proc/self/status', 'utf8'))[1] }));`;
        const child = spawnBots(['-e', script], { stdio: 'ignore', cwd: open });
        const code = await new Promise((resolve) => child.on('exit', resolve));
        assert.strictEqual(code, 0);
        const out = readJson(path.join(dir, 'out.json'), {});
        assert.deepStrictEqual([out.uid, out.read, out.path, /^0+$/.test(out.cap)], [65534, 'refused', null, true]);
    } finally {
        fs.rmSync(open, { recursive: true, force: true });
        for (const [k, v] of [['ARENA_BOT_USER', saved.user], ['ARENA_SECRET_FILE', saved.file]]) {
            if (v === undefined) {
                delete process.env[k];
            } else {
                process.env[k] = v;
            }
        }
    }
});

test('register on a hosted arena: only the admin token keeps a harness\'s command', () => {
    const { spawnSync } = require('child_process');
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
    assert.deepStrictEqual(agents.find((a) => a.name === 'adm').harness, { kind: 'script', cmd: 'node x.js' }, 'the admin\'s harness is kept as given');
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

test('round ladder ids: arena-r<K>, or the ladder standings name; games follows them', async () => {
    const { ladderIdOf } = require('../arena/referee');
    assert.strictEqual(ladderIdOf(3), 'arena-r3');
    const { RESULTS } = require('../arena/home');
    const { call } = require('../arena/api');
    const index = (id) => {
        fs.mkdirSync(path.join(RESULTS, id, 'games'), { recursive: true });
        writeJson(path.join(RESULTS, id, 'index.json'), { games: [{ id: `${id}-g1` }] });
        fs.writeFileSync(path.join(RESULTS, id, 'games', `${id}-g1.jsonl`), `{"id":"${id}"}\n`);
    };
    index('arena-r41');
    index('arena-r42');
    index('arena-tx-r41');
    const before = readJson(path.join(HOME, 'standings.json'), null);
    try {
        // a round of an old clocked tournament: standings name its ladder
        writeJson(path.join(HOME, 'standings.json'), { rounds: [{ round: 41, ladderId: 'arena-tx-r41', bots: [] }], global: {} });
        assert.strictEqual((await call('games', { round: 41 })).result.replayBase, 'replays/arena-tx-r41/games/', 'published rounds: standings name the ladder');
        assert.strictEqual((await call('games', { round: 42 })).result.replayBase, 'replays/arena-r42/games/', 'a round not published yet is arena-r<K>');
        // a ladder id that is not an arena folder name is ignored
        writeJson(path.join(HOME, 'standings.json'), { rounds: [{ round: 41, ladderId: '../arena-tx-r41', bots: [] }], global: {} });
        assert.strictEqual((await call('games', { round: 41 })).result.replayBase, 'replays/arena-r41/games/');
    } finally {
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

test('a holdout tournament\'s extra ladder does not count as a planned round', () => {
    const { clock, TOURNAMENT } = require('../arena/api');
    const now = new Date().toISOString();
    const work = (n) => ({ n, ladder: `arena-tz-r${n}`, workStart: now, workEnd: now, ladderStart: now, ladderEnd: now, bots: ['rush'] });
    writeJson(TOURNAMENT(), { id: 'arena-tz', state: 'running', plannedRounds: 3, rounds: [work(1), work(2), work(3), { ...work(4), kind: 'holdout', ladderEnd: undefined }],
                              rules: { holdout: { fraction: 0.3, train: 'rules/arena-tz/train.json', holdout: 'rules/arena-tz/holdout.json', counts: { train: 1400, holdout: 599 } } } });
    try {
        const c = clock();
        assert.strictEqual(c.roundIndex, 3, 'three of three work rounds');
        assert.strictEqual(c.plannedRounds, 3);
        assert.strictEqual(c.holdout, true);
        assert.strictEqual(c.phase, 'ladder');
        assert.strictEqual(c.tournament.rules.holdout.holdoutCards, 599);
        assert.strictEqual(c.tournament.rules.holdout.trainPool, path.join(HOME, 'rules/arena-tz/train.json'));
    } finally {
        fs.rmSync(TOURNAMENT(), { force: true });
    }
});

test('on the hosted arena the clock follows the round whose ladder a live referee holds', () => {
    const { clock } = require('../arena/api');
    const { RESULTS } = require('../arena/home');
    const file = path.join(HOME, 'standings.json');
    const before = readJson(file, null);
    const lock = (id, ageMs) => {
        fs.mkdirSync(path.join(RESULTS, id), { recursive: true });
        const f = path.join(RESULTS, id, 'referee.lock');
        fs.writeFileSync(f, '{}');
        const at = new Date(Date.now() - ageMs);
        fs.utimesSync(f, at, at);
    };
    const pick = (c) => ({ round: c.round, phase: c.phase, tournament: c.tournament });
    try {
        fs.rmSync(file, { force: true });
        assert.deepStrictEqual(pick(clock()), { round: null, phase: 'idle', tournament: null }, 'before the first round');
        lock('arena-r0', 5000);
        assert.deepStrictEqual(pick(clock()), { round: 0, phase: 'ladder', tournament: null }, 'round 0 started, not in standings yet');
        writeJson(file, { rounds: [{ round: 0, status: 'running', ladderId: 'arena-r0' }] });
        assert.deepStrictEqual(pick(clock()), { round: 0, phase: 'ladder', tournament: null });
        lock('arena-r0', 10 * 60000);
        assert.deepStrictEqual(pick(clock()), { round: 0, phase: 'idle', tournament: null }, 'a stopped machine left the lock behind');
        writeJson(file, { rounds: [{ round: 0, status: 'done', ladderId: 'arena-r0' }] });
        fs.rmSync(path.join(RESULTS, 'arena-r0', 'referee.lock'));
        assert.deepStrictEqual(pick(clock()), { round: 0, phase: 'idle', tournament: null }, 'between rounds: the newest round');
        lock('arena-r1', 1000);
        assert.deepStrictEqual(pick(clock()), { round: 1, phase: 'ladder', tournament: null });
    } finally {
        fs.rmSync(path.join(RESULTS, 'arena-r0'), { recursive: true, force: true });
        fs.rmSync(path.join(RESULTS, 'arena-r1'), { recursive: true, force: true });
        if (before) {
            writeJson(file, before);
        } else {
            fs.rmSync(file, { force: true });
        }
    }
});

test('readers get every panel and a round\'s ladder from the API, not from the arena\'s files', async () => {
    const { RESULTS } = require('../arena/home');
    const { call } = require('../arena/api');
    setRoster(['pa', 'pb']);
    const win = (id, w, l) => ({ id, p1: w, p2: l, outcome: 'won', winner: w, winnerSeat: 'p1', timing: t(5, 5), rounds: 5 });
    const rd = { ...scoreRound(7, ladderOf(['pa-v0', 'pb-v0', 'rush'], [win('g1', 'pa-v0', 'pb-v0'), win('g2', 'pa-v0', 'rush')], 'done')), ladderId: 'arena-tp-r7' };
    const before = readJson(path.join(HOME, 'standings.json'), null);
    writeJson(path.join(HOME, 'standings.json'), { status: 'running', rounds: [rd], global: globalElo([rd]) });
    try {
        dash.publishStandings({ status: 'running', rounds: [rd], global: globalElo([rd]) });
        dash.updatePanel('pa', { now: 'thinking' });
        const p = (await call('panels')).result;
        assert.deepStrictEqual(p.leaderboard, dashFile('panels', 'arena-leaderboard.json'), 'the dashboard file is a copy of what the API serves');
        assert.deepStrictEqual(p.experiment, dashFile('experiments', 'arena.json'));
        assert.deepStrictEqual(p.panels.map((x) => x.id), ['arena-pa', 'arena-pb']);
        assert.deepStrictEqual(p.panels[0], dashFile('panels', 'arena-pa.json'));
        assert.strictEqual(p.panels[0].now, 'thinking');
        assert.ok(fs.existsSync(path.join(HOME, 'panels', 'leaderboard.json')) && fs.existsSync(path.join(HOME, 'panels', 'experiment.json')));

        // a round's ladder: found through the ladder id the standings name
        assert.strictEqual((await call('ladder', { round: 7 })).error.code, 'not_found');
        writeJson(path.join(RESULTS, 'arena-tp-r7', 'ladder.json'), { schema: 'swu-ladder/1', id: 'arena-tp-r7', games: [{ id: 'g1' }] });
        const l = (await call('ladder')).result;
        assert.deepStrictEqual([l.round, l.ladderId, l.ladder.schema, l.ladder.games.length], [7, 'arena-tp-r7', 'swu-ladder/1', 1]);
        assert.strictEqual((await call('ladder', { round: -1 })).error.code, 'bad_request');
    } finally {
        if (before) {
            writeJson(path.join(HOME, 'standings.json'), before);
        } else {
            fs.rmSync(path.join(HOME, 'standings.json'), { force: true });
        }
    }
});

// the intake of bots people submit on the window (intake.js): its checker as a plain child process here, since the
// scratch arena lives under /tmp, which isolate.sh would replace
process.env.ARENA_INTAKE_NO_ISOLATE = '1';
process.env.ARENA_INTAKE_WORK = path.join(tmp, 'intake-work');
const wasmReady = (() => {
    const { spawnSync } = require('child_process');
    const rt = path.join(__dirname, '..', '..', 'build', 'compiled', '.tools', 'python-3.14.7', 'python.wasm');
    return fs.existsSync(rt) && spawnSync('python3', ['-c', 'import wasmtime'], { stdio: 'ignore' }).status === 0;
})();

test('a submitted wasm bundle is held to the host memory cap: its own memory_mb counts up to 1024, and it gets one memory', { skip: require('child_process').spawnSync('python3', ['-c', 'import wasmtime'], { stdio: 'ignore' }).status !== 0 && 'needs wasmtime' }, () => {
    const { spawnSync } = require('child_process');
    // a WASI program that grows its last memory by 20000 pages (1.25 GiB) and prints whether that worked
    const program = (memories) => `(module
  (import "wasi_snapshot_preview1" "fd_write" (func $w (param i32 i32 i32 i32) (result i32)))
  (memory $m0 1) ${memories > 1 ? '(memory $m1 1)' : ''}
  (export "memory" (memory $m0))
  (data (memory $m0) (i32.const 16) "grew\\n")
  (data (memory $m0) (i32.const 32) "fail\\n")
  (func (export "_start") (local $p i32)
    (local.set $p (i32.const 16))
    (if (i32.eq (memory.grow ${memories > 1 ? '$m1' : '$m0'} (i32.const 20000)) (i32.const -1)) (then (local.set $p (i32.const 32))))
    (i32.store $m0 (i32.const 0) (local.get $p))
    (i32.store $m0 (i32.const 4) (i32.const 5))
    (drop (call $w (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 8)))))`;
    const run = (memories) => {
        const dir = fs.mkdtempSync(path.join(tmp, 'memhog-'));
        const make = 'import sys, json, hashlib, wasmtime\nb = wasmtime.wat2wasm(sys.stdin.read())\nopen(sys.argv[1] + "/bot.wasm", "wb").write(b)\n' +
            'json.dump({"schema": "swu-arena-bot/1", "name": "memhog", "lang": "wat", "protocol": 2, "kind": "wasm", "platform": "wasm32-wasip1", "runtime": "wasi-p1",' +
            ' "run": {"cmd": "./bot.wasm", "args": [], "env": {}}, "entry_sha256": hashlib.sha256(b).hexdigest(), "resources": {"memory_mb": 4096},' +
            ' "cards": {"use": "none"}, "network": "none"}, open(sys.argv[1] + "/arena.json", "w"))';
        assert.strictEqual(spawnSync('python3', ['-c', make, dir], { input: program(memories) }).status, 0);
        const runPy = path.join(__dirname, '..', 'compiled', 'run.py');
        return spawnSync('python3', [runPy, dir], { encoding: 'utf8', env: { ...process.env, SWU_WASM_CACHE: path.join(dir, 'cache') }, timeout: 60000 });
    };
    assert.strictEqual(run(1).stdout, 'fail\n', 'asking for 4096 MB in arena.json gives 1024 at most');
    assert.match(run(2).stderr, /memory count too high/);
});

/** A window that holds submissions in memory, with the two calls the intake makes (push.js request and putDoc). */
function fakeWindow(docs) {
    const reads = [];
    return {
        docs, reads,
        request: async (method, p) => {
            reads.push(p);
            const id = decodeURIComponent(p.split('/')[4] ?? '');
            return id ? structuredClone(docs[id] ?? null) : Object.keys(docs).map((k) => ({ id: k }));
        },
        putDoc: async (ns, id, doc) => {
            docs[id] = structuredClone(doc);
        }
    };
}

test('intake: a submission that cannot be packed or names someone else\'s competitor is rejected, with the reason, and its files dropped', async () => {
    const { intakeOnce } = require('../arena/intake');
    const roster = readJson(path.join(HOME, 'roster.json'), { baselines: ['rush'], agents: [] });
    writeJson(path.join(HOME, 'roster.json'), { ...roster, agents: [...roster.agents, { name: 'kim_b_taken', title: 'taken', owner: 'github:someone' }] });
    const base = { owner: 'kim-b', note: 'try', state: 'pending', submittedAt: '2026-10-12T06:00:00Z' };
    const w = fakeWindow({
        'kim-b.1': { ...base, name: 'kim_b', kind: 'python', files: { 'main.py': 'print(1)' } },
        'kim-b.2': { ...base, name: 'kim_b', kind: 'js', files: { 'bot.js': "require('../../../etc/hostname')" } },
        'kim-b.3': { ...base, name: 'kim_b_taken', kind: 'js', files: { 'bot.js': '' } },
        'kim-b.4': { ...base, name: 'kim_b', kind: 'js', files: {}, state: 'accepted', version: 'kim_b-v1' },
        'kim-b.5': { ...base, name: 'pal', kind: 'js', files: { 'bot.js': '' } }
    });
    const finished = new Set();
    // with no toolchain yet, nothing is checked and nothing is rejected
    assert.strictEqual(await intakeOnce({ window: w, finished, missing: () => 'no Javy' }), 0);
    assert.deepStrictEqual(Object.values(w.docs).map((d) => d.state), ['pending', 'pending', 'pending', 'accepted', 'pending']);
    const ready = () => null; // these fail before any tool runs
    assert.strictEqual(await intakeOnce({ window: w, finished, missing: ready }), 4);
    assert.deepStrictEqual(Object.values(w.docs).map((d) => d.state), ['rejected', 'rejected', 'rejected', 'accepted', 'rejected']);
    assert.match(w.docs['kim-b.1'].error, /no bot\.py/);
    assert.match(w.docs['kim-b.2'].error, /cannot find '\.\.\/\.\.\/\.\.\/etc\/hostname' in the bot's folder/);
    assert.match(w.docs['kim-b.3'].error, /belongs to another competitor/);
    assert.match(w.docs['kim-b.5'].error, /"pal" is not yours: use your builder name kim_b/);
    assert.deepStrictEqual([w.docs['kim-b.1'].files, w.docs['kim-b.1'].fileNames], [undefined, ['main.py']]);
    assert.ok(!readJson(path.join(HOME, 'roster.json')).agents.some((a) => a.name === 'kim_b'), 'no competitor made for a bot that never started');
    w.reads.length = 0;
    assert.strictEqual(await intakeOnce({ window: w, finished, missing: ready }), 0);
    assert.deepStrictEqual(w.reads, ['/api/docs/submissions'], 'a later pass reads only the list');
});

test('intake: a Python bot becomes a sandboxed WebAssembly version of the builder\'s competitor', { skip: !wasmReady && 'needs wasmtime and the CPython for WASI (bot/compiled/README.md)' }, async () => {
    const { intakeOnce } = require('../arena/intake');
    const { describeArenaBot, makeArenaBot } = require('../arena/registry');
    const base = { owner: 'pal', name: 'pal', kind: 'python', state: 'pending', submittedAt: '2026-10-12T06:00:00Z' };
    const w = fakeWindow({
        'pal.1': { ...base, note: 'first', files: { 'bot.py': PY_BOT } },
        'pal.2': { ...base, note: 'reads a file it may not', files: { 'bot.py': `open('${HOME}/roster.json').read()\n${PY_BOT}` } },
        'pal.3': { ...base, note: 'second', files: { 'bot.py': `# v2\n${PY_BOT}` } }
    });
    assert.strictEqual(await intakeOnce({ window: w }), 3);
    assert.deepStrictEqual(Object.values(w.docs).map((d) => [d.state, d.version ?? null, d.benched ?? null]), [['accepted', 'pal-v1', false], ['rejected', null, null], ['accepted', 'pal-v2', false]]);
    assert.match(w.docs['pal.2'].error, /failed the start check[\s\S]*No such file or directory/);
    const r = readJson(path.join(HOME, 'roster.json'));
    assert.deepStrictEqual(r.agents.filter((a) => a.name === 'pal').map((a) => [a.owner, a.harness]), [['github:pal', { kind: 'builder', selfRun: true }]]);
    assert.deepStrictEqual(fs.readdirSync(path.join(HOME, 'versions', 'pal-v2', 'bundle')).sort(), ['arena.json', 'bot.py']);
    assert.strictEqual(describeArenaBot('pal-v2').lang, 'wasm');
    const bot = makeArenaBot('pal-v2');
    const awake = setTimeout(() => {}, 60000); // a bot program never keeps node running by itself (stdio.js)
    try {
        const ready = await bot.hello({ t: 'hello', v: 2, bot: 'pal-v2', you: 'p1', seed: 1, ms: 30000 });
        assert.strictEqual(ready.t, 'ready');
    } finally {
        clearTimeout(awake);
        await bot.close();
    }
});

test('intake: one version per submission, even when the window misses the result or the check runs again; a JS bot may bring Node\'s stdio.js or live in a folder', { skip: !(wasmReady && fs.existsSync(path.join(__dirname, '..', '..', 'build', 'compiled', '.tools', 'javy-8.0.0', 'javy'))) && 'needs wasmtime, the CPython for WASI and Javy (bot/compiled/README.md)' }, async () => {
    const { intakeOnce } = require('../arena/intake');
    const { versionsOf } = require('../arena/home');
    const base = { owner: 'ros', name: 'ros', state: 'pending', submittedAt: '2026-10-12T06:00:00Z' };
    const w = fakeWindow({ 'ros.1': { ...base, kind: 'python', note: 'first', files: { 'bot.py': PY_BOT } } });
    let down = true;
    const put = w.putDoc;
    w.putDoc = async (ns, id, doc) => {
        if (down && doc.state !== 'checking') {
            throw new Error('502 from the window');
        }
        return put(ns, id, doc);
    };
    const unsent = new Map();
    await assert.rejects(intakeOnce({ window: w, unsent }), /502/);
    assert.deepStrictEqual([w.docs['ros.1'].state, versionsOf('ros')], ['checking', [0, 1]]);
    down = false;
    await intakeOnce({ window: w, unsent });
    assert.deepStrictEqual([w.docs['ros.1'].state, w.docs['ros.1'].version, versionsOf('ros')], ['accepted', 'ros-v1', [0, 1]], 'sent again, not entered again');

    // an intake that died after the entry leaves the doc 'checking'; checked again, it gets the same version
    w.docs['ros.1'] = { ...w.docs['ros.1'], state: 'checking', checkingAt: '2026-10-12T06:00:00Z', version: undefined };
    assert.strictEqual(await intakeOnce({ window: w }), 1);
    assert.deepStrictEqual([w.docs['ros.1'].state, w.docs['ros.1'].version, versionsOf('ros')], ['accepted', 'ros-v1', [0, 1]]);

    const js = "const { serve } = require('./stdio');\nserve({ decide: (m) => ({ t: 'act', i: 0 }) });\n";
    w.docs['ros.2'] = { ...base, kind: 'js', note: 'tested at home with stdio.js', files: { 'bot.js': js, 'stdio.js': fs.readFileSync(path.join(__dirname, '..', 'stdio.js'), 'utf8') } };
    w.docs['ros.3'] = { ...base, kind: 'js', note: 'in a folder', entry: 'src/main.js', files: { 'src/main.js': js } };
    assert.strictEqual(await intakeOnce({ window: w }), 2);
    assert.deepStrictEqual(['ros.2', 'ros.3'].map((id) => [w.docs[id].state, w.docs[id].version ?? w.docs[id].error]), [['accepted', 'ros-v2'], ['accepted', 'ros-v3']]);
});

/** A job folder as a check leaves it (work/home/bundle.tar), with a bundle whose bot.wasm is no program at all. */
function leftByCheck(name, { tar = null } = {}) {
    const { spawnSync } = require('child_process');
    const work = fs.mkdtempSync(path.join(tmp, 'left-'));
    const bundle = path.join(work, 'src');
    fs.mkdirSync(bundle);
    fs.writeFileSync(path.join(bundle, 'bot.wasm'), 'not a program');
    const m = { schema: 'swu-arena-bot/1', name, lang: 'wat', protocol: 2, kind: 'wasm', platform: 'wasm32-wasip1', runtime: 'wasi-p1',
        run: { cmd: './bot.wasm', args: [], env: {} }, resources: { memory_mb: 64 }, cards: { use: 'none' }, network: 'none' };
    fs.writeFileSync(path.join(bundle, 'arena.json'), JSON.stringify(m));
    fs.mkdirSync(path.join(work, 'home'));
    const out = path.join(work, 'home', 'bundle.tar');
    if (tar) {
        fs.writeFileSync(out, tar);
    } else {
        const r = spawnSync('python3', [path.join(__dirname, '..', 'compiled', 'bundle.py'), 'tar', bundle]);
        assert.strictEqual(r.status, 0, String(r.stderr));
        fs.writeFileSync(out, r.stdout);
    }
    return { work, tar: out };
}
// the hash the checker prints for the tar it left
const shaOf = (file) => require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('intake enter: root enters what the check left without running it, with the name, owner and note of the window\'s submission', () => {
    const { enter } = require('../arena/intake');
    const { versionsOf } = require('../arena/home');
    const sub = { id: 'lee.1', owner: 'lee', name: 'lee', kind: 'wasm', note: 'first', files: {} };
    // bot.wasm here would fail any start check: entering it shows nothing ran it; its manifest names someone else
    const { work, tar } = leftByCheck('mallory');
    assert.deepStrictEqual(enter(sub, work, shaOf(tar)), { ok: true, name: 'lee', version: 'lee-v1', benched: false });
    assert.deepStrictEqual(versionsOf('lee'), [0, 1]);
    assert.deepStrictEqual(versionsOf('mallory'), []);
    assert.ok(!readJson(path.join(HOME, 'roster.json')).agents.some((a) => a.name === 'mallory'));
    const meta = readJson(path.join(HOME, 'versions', 'lee-v1', 'SUBMISSION.json'));
    assert.deepStrictEqual([meta.note, meta.ref, meta.bot.kind], ['first', 'window:lee.1', 'wasm']);
    assert.strictEqual(fs.readFileSync(path.join(HOME, 'versions', 'lee-v1', 'bundle', 'bot.wasm'), 'utf8'), 'not a program');
    assert.strictEqual(readJson(path.join(HOME, 'roster.json')).agents.find((a) => a.name === 'lee').owner, 'github:lee');
    // the same submission again: its version, not a new one
    const again = leftByCheck('lee');
    assert.strictEqual(enter(sub, again.work, shaOf(again.tar)).version, 'lee-v1');
    assert.deepStrictEqual(versionsOf('lee'), [0, 1]);
});

test('intake enter: a bundle.tar that is a link, has another name, changed after its check, or is not a canonical tar is not entered', () => {
    const { enter } = require('../arena/intake');
    const { versionsOf } = require('../arena/home');
    const before = versionsOf('lee');
    const sub = (n) => ({ id: `lee.${n}`, owner: 'lee', name: 'lee', kind: 'wasm', note: 'n', files: {} });
    const victim = path.join(tmp, 'victim.tar');
    const real = leftByCheck('lee');
    fs.copyFileSync(real.tar, victim);
    const linked = leftByCheck('lee');
    fs.rmSync(linked.tar);
    fs.symlinkSync(victim, linked.tar);
    assert.throws(() => enter(sub(2), linked.work, shaOf(victim)), /the check left no bundle/);
    const twice = leftByCheck('lee');
    fs.linkSync(twice.tar, path.join(twice.work, 'other-name'));
    assert.throws(() => enter(sub(3), twice.work, shaOf(twice.tar)), /the check left no bundle/);
    // another bundle in place of the one the checker said it left
    const swapped = leftByCheck('lee');
    const checked = shaOf(swapped.tar);
    fs.writeFileSync(swapped.tar, fs.readFileSync(leftByCheck('other').tar));
    assert.throws(() => enter(sub(5), swapped.work, checked), /the bundle changed after its check/);
    assert.throws(() => enter(sub(6), leftByCheck('lee').work, undefined), /the bundle changed after its check/, 'a checker that printed no hash');
    const gnu = leftByCheck('lee');
    require('child_process').execFileSync('tar', ['-cf', gnu.tar, '-C', path.join(gnu.work, 'src'), '.']);
    assert.throws(() => enter(sub(4), gnu.work, shaOf(gnu.tar)), /the bundle did not unpack/);
    assert.deepStrictEqual(versionsOf('lee'), before, 'nothing entered');
});

test('intake: a check an earlier intake left running is killed before the next one starts; a pid that is another process\'s now is left alone', { skip: !fs.existsSync('/proc/self/stat') && 'needs /proc' }, async () => {
    const { checkIsolated } = require('../arena/intake');
    const { spawn } = require('child_process');
    const pidFile = `${process.env.ARENA_INTAKE_WORK}.checker.pid`;
    const startOf = (pid) => {
        const t = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        return t.slice(t.lastIndexOf(')') + 2).split(' ')[19];
    };
    const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    // a process group of its own, as a check is
    const group = () => spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    const ended = (c) => new Promise((resolve) => (c.exitCode !== null || c.signalCode !== null ? resolve() : c.on('exit', resolve)));
    setRoster([]);
    // refused by its checker at once: what counts here is what happens before the check starts
    const job = (n) => ({ id: `orphan.${n}`, owner: 'orphan', name: 'orphan', kind: 'wasm', note: 'n', files: { 'arena.json': '{}' } });
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    const other = group();
    try {
        fs.writeFileSync(pidFile, `${other.pid} 1 ${boot}`); // the pid, but another start time
        assert.strictEqual((await checkIsolated(job(1))).ok, false);
        assert.ok(other.exitCode === null && other.signalCode === null, 'a process that only has the pid is left alone');
        const orphan = group();
        fs.writeFileSync(pidFile, `${orphan.pid} ${startOf(orphan.pid)} ${boot}`);
        assert.strictEqual((await checkIsolated(job(2))).ok, false);
        await ended(orphan);
        assert.strictEqual(orphan.signalCode, 'SIGKILL');
        assert.ok(!fs.existsSync(pidFile));
    } finally {
        other.kill('SIGKILL');
    }
});

test('api submit: checked skips the load and start checks for the caller that made them; no client can ask for that', async () => {
    const { api, call } = require('../arena/api');
    setRoster(['chk']);
    const files = { 'arena.json': JSON.stringify({ schema: 'swu-arena-bot/1', run: { cmd: './bot.wasm' } }), 'bot.wasm': { base64: Buffer.from('nope').toString('base64') } };
    const r = await call('submit', { name: 'chk', note: 'n', bot: { kind: 'wasm', files }, checked: true });
    assert.strictEqual(r.error?.code, 'bad_bot', 'call() runs the check whatever the arguments say');
    assert.strictEqual(api.submit({ name: 'chk', note: 'n', bot: { kind: 'wasm', files } }, { checked: true }).version, 'chk-v0');
});

test('intake: a check that ends with no result is the arena\'s fault: the submission waits and is tried again, three times at most', async () => {
    const { intakeOnce } = require('../arena/intake');
    const base = { owner: 'kim-b', name: 'kim_b', kind: 'js', note: 'try', state: 'pending', submittedAt: '2026-10-12T06:00:00Z', files: { 'bot.js': '' } };
    const w = fakeWindow({ 'kim-b.1': { ...base }, 'kim-b.2': { ...base } });
    let calls = 0;
    const flaky = async (job) => (calls++, job.id === 'kim-b.2' && job.tries ? { ok: true, version: 'kim_b-v1', benched: false } : { ok: false, retry: true, error: 'the arena could not check it' });
    const opts = { window: w, missing: () => null, checker: flaky };
    assert.strictEqual(await intakeOnce(opts), 0);
    assert.deepStrictEqual(Object.values(w.docs).map((d) => [d.state, d.tries, !!d.files]), [['pending', 1, true], ['pending', 1, true]], 'files kept for the next try');
    assert.ok(Date.parse(w.docs['kim-b.1'].retryAt) > Date.now());
    assert.strictEqual(await intakeOnce(opts), 0);
    assert.strictEqual(calls, 2, 'not before retryAt');
    const due = () => Object.values(w.docs).forEach((d) => d.retryAt && (d.retryAt = '2026-10-12T00:00:00Z'));
    due();
    assert.strictEqual(await intakeOnce(opts), 1);
    assert.deepStrictEqual([w.docs['kim-b.1'].state, w.docs['kim-b.1'].tries, w.docs['kim-b.2'].state], ['pending', 2, 'accepted']);
    due();
    assert.strictEqual(await intakeOnce(opts), 1);
    assert.strictEqual(w.docs['kim-b.1'].state, 'rejected');
    assert.match(w.docs['kim-b.1'].error, /could not check it \(tried 3 times; submit it again later\)/);
});

