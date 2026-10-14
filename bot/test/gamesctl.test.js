'use strict';
// What the Elixir coordinator asks Node to do (bot/arena/gamesctl.js): one JSON line on stdout, the exit codes, and
// the state that push and intake keep between passes. No engine or card data needed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const CTL = path.join(__dirname, '..', 'arena', 'gamesctl.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesctl-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const data = path.join(tmp, 'data');
const writeJson = (file, doc) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(doc));
};

/** Runs gamesctl with a plain environment (GAMES_DATA in the scratch folder); resolves {code, out, err, json}. */
function ctl(args, env = {}) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [CTL, ...args], {
            env: { PATH: process.env.PATH, HOME: tmp, LANG: 'C.UTF-8', GAMES_DATA: data, ...env }, stdio: ['ignore', 'pipe', 'pipe']
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (err += d));
        child.on('close', (code) => {
            let json = null;
            try {
                json = JSON.parse(out);
            } catch {}
            resolve({ code, out, err, json });
        });
    });
}

/** A window that answers every call with {result} and records what it was asked. */
async function fakeWindow(answer = () => null) {
    const calls = [];
    const srv = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', () => {
            calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ result: answer(req.method, req.url, body) }));
        });
    }).listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    return { calls, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

const home = path.join(data, 'arena');
const standings = (rounds) => writeJson(path.join(home, 'standings.json'), { rounds, updatedAt: new Date().toISOString() });

test('gamesctl: a usage error exits 2, and every answer is one JSON line even when the planner logs', async () => {
    assert.strictEqual((await ctl([])).code, 2);
    assert.strictEqual((await ctl(['plan', '--arena', 'nosims', '--settled-since', '0'])).code, 2, 'only the Open arena so far');
    assert.strictEqual((await ctl(['plan', '--arena', 'open'])).code, 2, '--settled-since is needed');

    writeJson(path.join(home, 'roster.json'), { thinkCapMs: 60000, baselines: ['heuristic', 'rush'], agents: [{ name: 'kim_b', owner: 'github:kim-b' }] });
    let r = await ctl(['plan', '--arena', 'open', '--settled-since', '0']);
    assert.strictEqual(r.code, 0, r.err);
    assert.deepStrictEqual(r.json, { round: null, why: 'no-competitor' }, 'kim_b has no version yet');

    // a version that cannot be loaded makes lineup() log; stdout still holds only the answer
    for (const v of [1, 2]) {
        writeJson(path.join(home, 'versions', `kim_b-v${v}`, 'SUBMISSION.json'), { bot: { kind: 'wasm' }, submittedAt: new Date().toISOString() });
    }
    fs.mkdirSync(path.join(home, 'versions', 'kim_b-v1', 'bot'), { recursive: true });
    r = await ctl(['plan', '--arena', 'open', '--settled-since', '0']);
    assert.strictEqual(r.code, 0, r.err);
    assert.strictEqual(r.out.split('\n').filter(Boolean).length, 1, r.out);
});

test('gamesctl plan: the next round by number once a new version settles; a round cut short is finished', async () => {
    const roster = { thinkCapMs: 60000, baselines: ['heuristic'], agents: [{ name: 'lee', owner: 'github:lee' }] };
    writeJson(path.join(home, 'roster.json'), roster);
    fs.rmSync(path.join(home, 'versions'), { recursive: true, force: true });
    // a JS version (bot.js) is one the registry can load
    writeJson(path.join(home, 'versions', 'lee-v1', 'SUBMISSION.json'), { submittedAt: new Date().toISOString() });
    fs.writeFileSync(path.join(home, 'versions', 'lee-v1', 'bot.js'), 'module.exports = {};');
    standings([{ round: 3, status: 'done', bots: [{ name: 'heuristic' }] }]);
    const now = Date.now();
    let r = await ctl(['plan', '--arena', 'open', '--settled-since', String(now)]);
    assert.deepStrictEqual(r.json, { round: null, why: 'settling' }, r.err);
    r = await ctl(['plan', '--arena', 'open', '--settled-since', String(now - 120000)]);
    assert.deepStrictEqual(r.json, { round: 4, resume: false, why: 'changed' }, r.err);
    standings([{ round: 4, status: 'running', bots: [{ name: 'lee-v1' }, { name: 'heuristic' }] }]);
    r = await ctl(['plan', '--arena', 'open', '--settled-since', String(now)]);
    assert.deepStrictEqual(r.json, { round: 4, resume: true, why: 'resume' });
});

test('gamesctl referee-cmd: an explicit round, the minimal environment, and the stale lock gone', async () => {
    const lock = path.join(data, 'results', 'arena-r7', 'referee.lock');
    writeJson(lock, { pid: 1, host: 'gone' });
    const r = await ctl(['referee-cmd', '--arena', 'open', '--round', '7', '--games', '2', '--workers', '2'],
        { SWU_WINDOW: 'http://127.0.0.1:1/p/nonce', SWU_WINDOW_TOKEN: 'leak', HTTPS_PROXY: 'http://proxy', FLY_API_TOKEN: 'leak' });
    assert.strictEqual(r.code, 0, r.err);
    const { cmd, env, cwd } = r.json;
    assert.deepStrictEqual(cmd.slice(cmd.indexOf('--round'), cmd.indexOf('--round') + 2), ['--round', '7']);
    assert.ok(cmd.some((a) => a.endsWith(path.join('arena', 'referee.js'))));
    if (process.getuid?.() === 0) {
        assert.ok(cmd[1].endsWith('isolate.sh') && cmd.includes('--hide'), cmd.join(' '));
    }
    assert.deepStrictEqual(Object.keys(env).filter((k) => /TOKEN|PROXY|FLY|SWU_WINDOW/i.test(k)), []);
    assert.strictEqual(env.ARENA_HOME, home);
    assert.strictEqual(cwd, path.join(__dirname, '..', '..'));
    assert.strictEqual(fs.existsSync(lock), false);
    assert.strictEqual((await ctl(['referee-cmd', '--arena', 'open', '--round', 'x'])).code, 2);

    // a ladder folder that is a link (the results folder is the bots' user's): nothing is removed through it
    const elsewhere = path.join(tmp, 'elsewhere');
    writeJson(path.join(elsewhere, 'referee.lock'), { pid: 1 });
    fs.symlinkSync(elsewhere, path.join(data, 'results', 'arena-r8'));
    assert.strictEqual((await ctl(['referee-cmd', '--arena', 'open', '--round', '8'])).code, 0);
    assert.ok(fs.existsSync(path.join(elsewhere, 'referee.lock')));
});

test('gamesctl referee-cmd: a new round takes the games and time limit it is given, a round cut short keeps its own', async () => {
    const roster = () => JSON.parse(fs.readFileSync(path.join(home, 'roster.json'), 'utf8'));
    const games = (cmd) => cmd[cmd.indexOf('--games') + 1];
    const standings = path.join(home, 'standings.json');
    const before = fs.existsSync(standings) ? fs.readFileSync(standings) : null;
    try {
        writeJson(standings, { rounds: [{ round: 11, status: 'done', gamesPerPair: 2 }] });
        let r = await ctl(['referee-cmd', '--arena', 'open', '--round', '12', '--games', '4', '--workers', '3', '--cap-ms', '90000']);
        assert.strictEqual(r.code, 0, r.err);
        assert.strictEqual(games(r.json.cmd), '4');
        assert.strictEqual(r.json.cmd[r.json.cmd.indexOf('--workers') + 1], '3');
        assert.strictEqual(roster().thinkCapMs, 90000, 'the new round plays by the new limit');

        // round 12 started with 4 games per pair and a stop cut it short: it keeps 4 and the limit it started with
        writeJson(standings, { rounds: [{ round: 11, status: 'done', gamesPerPair: 2 }, { round: 12, status: 'running', gamesPerPair: 4 }] });
        r = await ctl(['referee-cmd', '--arena', 'open', '--round', '12', '--games', '2', '--cap-ms', '60000']);
        assert.strictEqual(r.code, 0, r.err);
        assert.strictEqual(games(r.json.cmd), '4');
        assert.strictEqual(roster().thinkCapMs, 90000);

        // without --cap-ms the roster's limit stays; a limit under a second is refused
        r = await ctl(['referee-cmd', '--arena', 'open', '--round', '13']);
        assert.strictEqual(r.code, 0, r.err);
        assert.strictEqual(roster().thinkCapMs, 90000);
        assert.strictEqual((await ctl(['referee-cmd', '--arena', 'open', '--round', '13', '--cap-ms', '5'])).code, 2);
        assert.strictEqual((await ctl(['referee-cmd', '--arena', 'open', '--round', '13', '--cap-ms', 'x'])).code, 2);
    } finally {
        if (before) {
            fs.writeFileSync(standings, before);
        } else {
            fs.rmSync(standings, { force: true });
        }
    }
});

test('gamesctl push: what was sent is not sent again in the same boot; a new boot sends everything', async () => {
    const w = await fakeWindow();
    try {
        writeJson(path.join(home, 'roster.json'), { thinkCapMs: 60000, baselines: ['heuristic'], agents: [] });
        standings([{ round: 0, status: 'done', ladderId: 'arena-r0', bots: [] }]);
        fs.mkdirSync(path.join(home, 'rounds'), { recursive: true });
        fs.writeFileSync(path.join(home, 'rounds', 'r0.md'), '# Round 0');
        // a report that is a link (to a secret, another process's environment) is never sent
        fs.symlinkSync('/proc/self/environ', path.join(home, 'rounds', 'r9.md'));
        const run = path.join(data, 'results', 'arena-r0');
        writeJson(path.join(run, 'index.json'), { games: [{ id: 'g1', outcome: 'p1' }] });
        writeJson(path.join(run, 'ladder.json'), { status: 'done' });
        fs.mkdirSync(path.join(run, 'games'), { recursive: true });
        fs.writeFileSync(path.join(run, 'games', 'g1.jsonl'), '{"t":"header"}\n');
        fs.symlinkSync('/proc/self/environ', path.join(run, 'games', 'g2.jsonl'));
        const state = path.join(tmp, 'push-state.json');
        const env = { SWU_WINDOW: `${w.url}/p/nonce` };
        const push = (boot) => ctl(['push', '--arena', 'open', '--state', state, '--boot', boot], env);

        let r = await push('b1');
        assert.deepStrictEqual(r.json, { ok: true }, r.err);
        const puts = (from) => w.calls.slice(from).filter((c) => c.method === 'PUT').map((c) => c.url);
        const first = puts(0);
        assert.ok(first.includes('/p/nonce/api/docs/arena/standings'), first.join(' '));
        assert.ok(first.includes('/p/nonce/api/docs/arena/report-0'));
        assert.ok(first.includes('/p/nonce/api/replays/arena-r0/g1'));
        assert.ok(!first.some((u) => /report-9|g2/.test(u)), 'links are skipped');
        assert.ok(!w.calls.some((c) => /environ|PATH=/.test(c.body)));

        let n = w.calls.length;
        r = await push('b1');
        assert.deepStrictEqual(r.json, { ok: true });
        assert.deepStrictEqual(puts(n), [], 'nothing changed, nothing sent');

        n = w.calls.length;
        r = await push('b2');
        assert.ok(puts(n).includes('/p/nonce/api/docs/arena/standings'), 'a new boot sends everything again');
    } finally {
        await w.close();
    }
});

test('gamesctl intake: a window that does not answer is an unknown open count, not a failure', async () => {
    const r = await ctl(['intake', '--state', path.join(tmp, 'intake-state.json'), '--boot', 'b1'], { SWU_WINDOW: 'http://127.0.0.1:9/i/nonce' });
    assert.strictEqual(r.code, 0, r.err);
    assert.strictEqual(r.json.open, null);
    assert.strictEqual(r.json.accepted, 0);
    assert.ok(r.json.error);
});

test('gamesctl intake: results the window did not take are kept across boots; what was finished is read again', async () => {
    const { readState } = require('../arena/gamesctl');
    const file = path.join(tmp, 'intake-carry.json');
    writeJson(file, { boot: 'b1', finished: ['a.1'], unsent: [['a.2', { state: 'accepted' }]] });
    assert.deepStrictEqual(readState(file, 'b1').finished, ['a.1']);
    const next = readState(file, 'b2');
    assert.strictEqual(next.finished, undefined);
    assert.deepStrictEqual(next.carry.unsent, [['a.2', { state: 'accepted' }]]);
    fs.writeFileSync(file, 'torn');
    assert.deepStrictEqual(readState(file, 'b1'), {});
});
