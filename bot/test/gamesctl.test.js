'use strict';
// What the games server asks Node to do (bot/arena/gamesctl.js): one JSON line on stdout, the exit codes, what a round
// is (its rules, lineup, deck lists and bundles), publishing, the folders setup owns, and the state that push and
// intake keep between passes. The round and decks tests need the engine's card data (they skip without it).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const CTL = path.join(__dirname, '..', 'arena', 'gamesctl.js');
const DECKS = path.join(ROOT, 'bot', 'decks', 'ash-meta-2026-09.json');
const NODE_RANDOM = path.join(ROOT, 'build', 'compiled', 'node-random');
const ENGINE = fs.existsSync(path.join(ROOT, 'forceteki', 'build', 'server')) && fs.existsSync(path.join(ROOT, 'forceteki', 'test', 'json'));
const BUNDLE = fs.existsSync(path.join(NODE_RANDOM, 'arena.json'));
const WASMTIME = spawnSync('python3', ['-I', '-c', 'import wasmtime'], { stdio: 'ignore' }).status === 0;
const ROUNDS = !(ENGINE && BUNDLE) && 'needs the engine, its card data and build/compiled/node-random';
// the server's own check of a round's answer (server/src/games/Gamesctl.ts), when the server's packages are installed
const SERVER = fs.existsSync(path.join(ROOT, 'server', 'node_modules', 'effect'));
const ROOT_USER = process.getuid?.() === 0;
const BOTS_USER = (() => {
    try {
        return ['-u', '-g'].map((f) => Number(execFileSync('id', [f, 'arena'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })));
    } catch {
        return null;
    }
})();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesctl-test-'));
// as root, gamesctl packs bundles (and the setup test runs) as the bots' user, who must reach the volumes in here
fs.chmodSync(tmp, 0o755);
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const data = path.join(tmp, 'data');
const writeJson = (file, doc) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(doc));
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const modeOf = (p) => fs.lstatSync(p).mode & 0o7777;

/** Runs gamesctl with a plain environment (GAMES_DATA in the scratch folder); resolves {code, out, err, json}. */
function ctl(args, env = {}, { as = null } = {}) {
    return new Promise((resolve) => {
        const argv = [process.execPath, CTL, ...args];
        const [cmd, ...rest] = as ? ['setpriv', `--reuid=${as[0]}`, `--regid=${as[1]}`, '--clear-groups', '--', ...argv] : argv;
        const child = spawn(cmd, rest, {
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

/**
 * Version `name` (<agent>-v<N>) in the arena folder `arena`: a WebAssembly one, the only kind the games machine plays
 * (SUBMISSION.json bot.kind wasm, and bundle/ with its arena.json: node-random's bundle, or with `stub` an arena.json
 * alone, which plan reads and nothing plays), or with `js` a JS one such as the starter v0 api.register makes.
 */
function addVersion(arena, name, { js = false, stub = false } = {}) {
    const dir = path.join(arena, 'versions', name);
    writeJson(path.join(dir, 'SUBMISSION.json'), { name, bot: { kind: js ? 'js' : 'wasm' }, submittedAt: new Date().toISOString() });
    if (js) {
        fs.writeFileSync(path.join(dir, 'bot.js'), 'module.exports = { createBot: () => ({ choose: () => 0 }) };');
    } else if (stub) {
        writeJson(path.join(dir, 'bundle', 'arena.json'), {});
    } else {
        fs.cpSync(NODE_RANDOM, path.join(dir, 'bundle'), { recursive: true });
    }
}

/**
 * A games volume of its own: a roster of `agents` (a builder, or a resident when the name starts with res), each with
 * version v1, a WebAssembly one (node-random's bundle); a builder also has the JS starter v0 that api.register makes,
 * which the games machine never plays. No baselines (setup). Returns the volume's folder.
 */
function volume(agents) {
    const vol = fs.mkdtempSync(path.join(tmp, 'vol-'));
    fs.chmodSync(vol, 0o755);
    const arena = path.join(vol, 'arena');
    writeJson(path.join(arena, 'roster.json'), {
        thinkCapMs: 60000, baselines: [],
        agents: agents.map((name) => (name.startsWith('res') ? { name, owner: 'arena', resident: true } : { name, owner: `github:${name}` }))
    });
    for (const name of agents) {
        if (!name.startsWith('res')) {
            addVersion(arena, `${name}-v0`, { js: true });
        }
        addVersion(arena, `${name}-v1`);
    }
    return vol;
}
const rosterOf = (vol) => readJson(path.join(vol, 'arena', 'roster.json'));
/** The canonical tar of a version's bundle, as remote-lane.js tarOf packs it. */
const tarOf = (vol, name) => spawnSync('python3', [path.join(ROOT, 'bot', 'compiled', 'bundle.py'), 'tar', path.join(vol, 'arena', 'versions', name, 'bundle')], { maxBuffer: 80 << 20 }).stdout;

test('gamesctl: a usage error exits 2, and every answer is one JSON line even when the planner logs', async () => {
    assert.strictEqual((await ctl([])).code, 2);
    assert.strictEqual((await ctl(['toString'])).code, 2, 'only its own commands');
    assert.strictEqual((await ctl(['referee-cmd', '--arena', 'open', '--round', '1'])).code, 2, 'the server plays rounds now: no referee command');
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
    const roster = { thinkCapMs: 60000, baselines: [], agents: [{ name: 'res_rush', owner: 'arena', resident: true }, { name: 'lee', owner: 'github:lee' }] };
    writeJson(path.join(home, 'roster.json'), roster);
    fs.rmSync(path.join(home, 'versions'), { recursive: true, force: true });
    // round 3 played the resident alone; lee's WebAssembly v1 comes in (its starter v0, a JS one, plays nowhere here)
    addVersion(home, 'res_rush-v1', { stub: true });
    addVersion(home, 'lee-v0', { js: true });
    addVersion(home, 'lee-v1', { stub: true });
    standings([{ round: 3, status: 'done', bots: [{ name: 'res_rush-v1' }] }]);
    const now = Date.now();
    let r = await ctl(['plan', '--arena', 'open', '--settled-since', String(now)]);
    assert.deepStrictEqual(r.json, { round: null, why: 'settling' }, r.err);
    r = await ctl(['plan', '--arena', 'open', '--settled-since', String(now - 120000)]);
    assert.deepStrictEqual(r.json, { round: 4, resume: false, why: 'changed' }, r.err);
    standings([{ round: 4, status: 'running', bots: [{ name: 'res_rush-v1' }, { name: 'lee-v1' }] }]);
    r = await ctl(['plan', '--arena', 'open', '--settled-since', String(now)]);
    assert.deepStrictEqual(r.json, { round: 4, resume: true, why: 'resume' });
});

test('gamesctl round: bad arguments exit 2 before anything is read or written', async () => {
    const roster = path.join(home, 'roster.json');
    const before = fs.readFileSync(roster, 'utf8');
    for (const args of [
        ['--arena', 'open'], ['--arena', 'open', '--round', 'x'], ['--arena', 'open', '--round', '-1'], ['--arena', 'nosims', '--round', '1'],
        ['--arena', 'open', '--round', '1', '--cap-ms', '5'], ['--arena', 'open', '--round', '1', '--cap-ms', 'x'],
        ['--arena', 'open', '--round', '1', '--cap-ms', '1e9'], ['--arena', 'open', '--round', '1', '--games', '0'],
        ['--arena', 'open', '--round', '1', '--games', 'x'], ['--arena', 'open', '--round', '1', '--games', '101'], ['--arena', 'open', '--round', '1', 'x']
    ]) {
        const r = await ctl(['round', ...args]);
        assert.strictEqual(r.code, 2, `${args.join(' ')}: ${r.err}`);
        assert.strictEqual(r.out, '');
    }
    assert.strictEqual(fs.readFileSync(roster, 'utf8'), before);
});

test('gamesctl round: the lineup, its deck lists, each version\'s tar and description, and a stale lock gone', { skip: ROUNDS }, async () => {
    const vol = volume(['kim', 'res_clock']);
    const lock = path.join(vol, 'results', 'arena-r7', 'referee.lock');
    writeJson(lock, { pid: 1, host: 'gone' });
    const r = await ctl(['round', '--arena', 'open', '--round', '7', '--games', '2', '--cap-ms', '20000'],
        { GAMES_DATA: vol, NODE_ENV: 'production', SWU_WINDOW_TOKEN: 'leak', ARENA_ADMIN_TOKEN: 'leak' });
    assert.strictEqual(r.code, 0, r.err);
    assert.strictEqual(r.out.split('\n').filter(Boolean).length, 1, 'one line');
    assert.ok(!r.out.includes('leak'));
    const a = r.json;
    assert.deepStrictEqual(Object.keys(a), ['round', 'bots', 'gamesPerPair', 'capMs', 'decks', 'bundles', 'botInfo']);
    assert.deepStrictEqual([a.round, a.bots, a.gamesPerPair, a.capMs], [7, ['kim-v1', 'res_clock-v1'], 2, 20000], 'roster order');
    assert.strictEqual(fs.existsSync(lock), false, 'the stale lock is gone');

    // the deck lists: ROUND_DECKS less the skipped list, each as play-seed.js takes it in a job
    const { normalizeDeck } = require('../decklists');
    const file = JSON.parse(fs.readFileSync(DECKS, 'utf8'));
    assert.deepStrictEqual(Object.keys(a.decks), ['file', 'sha256', 'names', 'deal', 'skipped', 'lists']);
    assert.deepStrictEqual([a.decks.file, a.decks.sha256, a.decks.deal, a.decks.skipped], ['ash-meta-2026-09.json', sha256(fs.readFileSync(DECKS)), 'seat', ['lando-calrissian_law_blue']]);
    assert.strictEqual(a.decks.lists.length, file.length - 1);
    assert.deepStrictEqual(a.decks.names, a.decks.lists.map((d) => d.metadata.name));
    assert.ok(!a.decks.names.includes('lando-calrissian_law_blue'));
    assert.ok(a.decks.lists.every((d) => JSON.stringify(normalizeDeck(d)) === JSON.stringify(d)), 'normalizeDeck form (play-seed.js isDeck)');

    // each version's canonical tar, named by its sha256, readable by everyone
    const hex = sha256(tarOf(vol, 'kim-v1'));
    assert.deepStrictEqual(a.bundles, { 'kim-v1': hex, 'res_clock-v1': hex }, 'the same bundle twice: one tar');
    const tar = path.join(vol, 'bundles', `${hex}.tar`);
    assert.strictEqual(sha256(fs.readFileSync(tar)), hex);
    assert.strictEqual(modeOf(tar), 0o644);
    assert.deepStrictEqual(fs.readdirSync(path.join(vol, 'bundles')), [`${hex}.tar`], 'no temporary file left');
    if (WASMTIME) {
        // and compiled into the cache before the answer, so no game pays for it (one module: the same bundle twice)
        assert.match(fs.readdirSync(path.join(vol, 'wasm-cache')).join(' '), /^[0-9a-f]{64}\.cwasm$/);
    }

    // as ladder.js puts them in ladder.json's bots rows (describeBot less the name)
    assert.deepStrictEqual(a.botInfo, {
        'kim-v1': { kind: 'arena', profile: 'kim', depth: null, lang: 'wasm', version: 1 },
        'res_clock-v1': { kind: 'arena', profile: 'res_clock', depth: null, lang: 'wasm', version: 1 }
    });

    if (SERVER) {
        // the server's own check of the answer takes it as it is
        const { checkRound } = await import(path.join(ROOT, 'server', 'src', 'games', 'Gamesctl.ts'));
        const spec = checkRound(7, a);
        assert.deepStrictEqual([spec.bots, spec.capMs, spec.decks.lists.length, spec.bundles], [a.bots, 20000, a.decks.lists.length, a.bundles]);
    }

    // a round folder that is a link (once the bots' user's): nothing is removed through it
    const elsewhere = path.join(vol, 'elsewhere');
    writeJson(path.join(elsewhere, 'referee.lock'), { pid: 1 });
    fs.symlinkSync(elsewhere, path.join(vol, 'results', 'arena-r8'));
    assert.strictEqual((await ctl(['round', '--arena', 'open', '--round', '8'], { GAMES_DATA: vol })).code, 0);
    assert.ok(fs.existsSync(path.join(elsewhere, 'referee.lock')));
});

test('gamesctl round: each tar is written once, a damaged one again, and GAMES_BUNDLES says where', { skip: ROUNDS }, async () => {
    const vol = volume(['kim', 'res_clock']);
    const round = (env = {}) => ctl(['round', '--arena', 'open', '--round', '0'], { GAMES_DATA: vol, ...env });
    let r = await round();
    assert.strictEqual(r.code, 0, r.err);
    const hex = r.json.bundles['kim-v1'];
    const tar = path.join(vol, 'bundles', `${hex}.tar`);
    const first = fs.statSync(tar);

    r = await round();
    assert.strictEqual(r.code, 0, r.err);
    const again = fs.statSync(tar);
    assert.deepStrictEqual([again.ino, again.mtimeMs], [first.ino, first.mtimeMs], 'a tar already there is not written again');

    // a tar that does not hold those bytes (a torn write, a hand edit) is written again
    fs.writeFileSync(tar, 'not a tar');
    r = await round();
    assert.strictEqual(r.code, 0, r.err);
    assert.strictEqual(sha256(fs.readFileSync(tar)), hex);
    fs.chmodSync(tar, 0o600);
    assert.strictEqual((await round()).code, 0);
    assert.strictEqual(modeOf(tar), 0o644, 'play-seed.js reads it as the bots\' user');

    const other = path.join(tmp, 'other-bundles');
    r = await round({ GAMES_BUNDLES: other });
    assert.strictEqual(r.code, 0, r.err);
    assert.strictEqual(sha256(fs.readFileSync(path.join(other, `${hex}.tar`))), hex);

    // a bundle that does not pack (a link in it) stops the round
    fs.symlinkSync('/etc/hostname', path.join(vol, 'arena', 'versions', 'kim-v1', 'bundle', 'host'));
    r = await round();
    assert.strictEqual(r.code, 1);
    assert.match(r.err, /kim-v1: its bundle cannot be packed/);
});

test('gamesctl round: as root, a bundle is packed as the bots\' user packed it for every round so far', { skip: (ROUNDS || !(ROOT_USER && BOTS_USER)) && 'needs root, a user arena, the engine and node-random' }, async () => {
    const vol = volume(['kim', 'res_clock']);
    // root may execute a 0744 file of root's, the bots' user may not: the tar's mode for it (bundle.py) says which
    const script = path.join(vol, 'arena', 'versions', 'kim-v1', 'bundle', 'run.sh');
    fs.writeFileSync(script, '#!/bin/sh\n');
    fs.chmodSync(script, 0o744);
    const asBots = spawnSync('setpriv', [`--reuid=${BOTS_USER[0]}`, `--regid=${BOTS_USER[1]}`, '--clear-groups', '--', 'python3', path.join(ROOT, 'bot', 'compiled', 'bundle.py'), 'tar',
        path.join(vol, 'arena', 'versions', 'kim-v1', 'bundle')], { maxBuffer: 80 << 20 }).stdout;
    const r = await ctl(['round', '--arena', 'open', '--round', '0'], { GAMES_DATA: vol });
    assert.strictEqual(r.code, 0, r.err);
    assert.strictEqual(r.json.bundles['kim-v1'], sha256(asBots));
    assert.notStrictEqual(r.json.bundles['kim-v1'], sha256(tarOf(vol, 'kim-v1')), 'root would read the execute bit otherwise');
});

test('gamesctl round: a new round takes the games and time limit it is given, a round cut short keeps its own', { skip: ROUNDS }, async () => {
    const vol = volume(['kim', 'res_clock']);
    const st = path.join(vol, 'arena', 'standings.json');
    const round = (...args) => ctl(['round', '--arena', 'open', ...args], { GAMES_DATA: vol });
    writeJson(st, { rounds: [{ round: 11, status: 'done', gamesPerPair: 2 }] });
    let r = await round('--round', '12', '--games', '3', '--cap-ms', '90000');
    assert.strictEqual(r.code, 0, r.err);
    assert.deepStrictEqual([r.json.gamesPerPair, r.json.capMs], [4, 90000], 'games per pair rounded up to even, both seats');
    assert.strictEqual(rosterOf(vol).thinkCapMs, 90000, 'the new round plays by the new limit');

    // round 12 started with 4 games per pair and a stop cut it short: it keeps 4 and the limit it started with
    writeJson(st, { rounds: [{ round: 11, status: 'done', gamesPerPair: 2 }, { round: 12, status: 'running', gamesPerPair: 4 }] });
    r = await round('--round', '12', '--games', '2', '--cap-ms', '60000');
    assert.strictEqual(r.code, 0, r.err);
    assert.deepStrictEqual([r.json.gamesPerPair, r.json.capMs], [4, 90000]);
    assert.strictEqual(rosterOf(vol).thinkCapMs, 90000);
    // its ladder.json says which limit it started with, whatever the roster says now
    writeJson(path.join(vol, 'results', 'arena-r12', 'ladder.json'), { config: { capMs: 75000, gamesPerPair: 4 } });
    r = await round('--round', '12', '--games', '2', '--cap-ms', '60000');
    assert.deepStrictEqual([r.code, r.json?.gamesPerPair, r.json?.capMs], [0, 4, 75000], r.err);
    assert.strictEqual(rosterOf(vol).thinkCapMs, 90000);

    // without --cap-ms the roster's limit stays, and is the round's
    writeJson(st, { rounds: [{ round: 12, status: 'done', gamesPerPair: 4 }] });
    r = await round('--round', '13');
    assert.deepStrictEqual([r.code, r.json?.gamesPerPair, r.json?.capMs], [0, 2, 90000], r.err);
    assert.strictEqual(rosterOf(vol).thinkCapMs, 90000);
});

test('gamesctl round: each agent fields its newest WebAssembly version or nothing, at plan and round alike; a built-in baseline never plays', { skip: ROUNDS }, async () => {
    // lee has its JS starter v0 and a WebAssembly v1 (a bundle of its own); the roster still names bots built into the
    // image, as an older one did
    const vol = volume(['kim', 'lee', 'res_clock']);
    fs.writeFileSync(path.join(vol, 'arena', 'versions', 'lee-v1', 'bundle', 'NOTES.md'), 'lee\n');
    const roster = path.join(vol, 'arena', 'roster.json');
    writeJson(roster, { ...rosterOf(vol), baselines: ['heuristic', 'rush'] });
    const env = { GAMES_DATA: vol };
    const plan = () => ctl(['plan', '--arena', 'open', '--settled-since', '0'], env);
    const round = (k) => ctl(['round', '--arena', 'open', '--round', String(k)], env);
    const played = (k, bots) => writeJson(path.join(vol, 'arena', 'standings.json'), { rounds: [{ round: k, status: 'done', bots: bots.map((name) => ({ name })) }], updatedAt: new Date().toISOString() });
    const tars = () => fs.readdirSync(path.join(vol, 'bundles')).sort();

    let r = await plan();
    assert.deepStrictEqual(r.json, { round: 0, resume: false, why: 'changed' }, r.err);
    r = await round(0);
    assert.strictEqual(r.code, 0, r.err);
    assert.deepStrictEqual(r.json.bots, ['kim-v1', 'lee-v1', 'res_clock-v1'], 'lee fields v1, not its starter; no baseline');
    const lee = r.json.bundles['lee-v1'];
    assert.notStrictEqual(lee, r.json.bundles['kim-v1']);
    assert.deepStrictEqual(tars(), [`${lee}.tar`, `${r.json.bundles['kim-v1']}.tar`].sort());
    played(0, r.json.bots);
    assert.deepStrictEqual((await plan()).json, { round: null, why: 'same' });

    // lee withdraws v1: its v0 is a JS one, so lee fields nothing (never its starter, which no round here could play)
    writeJson(roster, { ...rosterOf(vol), agents: rosterOf(vol).agents.map((a) => (a.name === 'lee' ? { ...a, withdrawn: [1] } : a)) });
    r = await plan();
    assert.deepStrictEqual(r.json, { round: 1, resume: false, why: 'changed' }, `${r.err}: one change`);
    fs.rmSync(path.join(vol, 'bundles'), { recursive: true });
    r = await round(1);
    assert.strictEqual(r.code, 0, r.err);
    assert.deepStrictEqual([r.json.round, r.json.bots], [1, ['kim-v1', 'res_clock-v1']], 'the round plays without lee');
    assert.deepStrictEqual([Object.keys(r.json.bundles), Object.keys(r.json.botInfo)], [['kim-v1', 'res_clock-v1'], ['kim-v1', 'res_clock-v1']]);
    assert.deepStrictEqual(tars(), [`${r.json.bundles['kim-v1']}.tar`], 'nothing written for lee');
    played(1, r.json.bots);
    assert.deepStrictEqual((await plan()).json, { round: null, why: 'same' }, 'then the same lineup at every look');
    assert.deepStrictEqual(rosterOf(vol).baselines, ['heuristic', 'rush'], 'the roster still names them; they are only not fielded');
});

test('gamesctl publish: standings, the report and the panels from the ladder.json the server wrote', async () => {
    const vol = fs.mkdtempSync(path.join(tmp, 'pub-'));
    writeJson(path.join(vol, 'arena', 'roster.json'), { thinkCapMs: 20000, baselines: [], agents: [{ name: 'kim', owner: 'github:kim' }, { name: 'res_clock', owner: 'arena', resident: true }] });
    const publish = (k) => ctl(['publish', '--arena', 'open', '--round', String(k)], { GAMES_DATA: vol });
    assert.deepStrictEqual((await publish(5)).json, { ok: true, status: null }, 'no ladder.json yet: nothing to publish');
    assert.strictEqual(fs.existsSync(path.join(vol, 'arena', 'standings.json')), false);

    const { summarize } = require('../ladder-report');
    const bots = ['kim-v1', 'res_clock-v1'];
    const config = { bots, gamesPerPair: 2, firstSeed: 100, maxSteps: 6000, workers: 2, capMs: 20000, hangMs: 70000, harness: null, engineDiff: null, programs: null,
                     keyId: 'abcdef012345', record: true, decks: { file: 'ash-meta-2026-09.json', sha256: 'a'.repeat(64), names: ['x', 'y'], deal: 'seat', skipped: [] } };
    const game = (p1, p2, winnerSeat) => ({ id: `${p1}-vs-${p2}-100`, seed: 100, p1, p2, winner: winnerSeat === 'p1' ? p1 : p2, winnerSeat, outcome: 'won', rounds: 6, steps: 300, ms: 900,
                                             error: null, by: null, faultKind: null, host: null, timing: { p1: { n: 10, ms: 50, p50: 5, p95: 9, max: 9 }, p2: { n: 10, ms: 40, p50: 4, p95: 8, max: 8 } } });
    const games = [game('kim-v1', 'res_clock-v1', 'p1'), game('res_clock-v1', 'kim-v1', 'p2')];
    const botInfo = Object.fromEntries(bots.map((b) => [b, { kind: 'arena', profile: b.split('-')[0], depth: null, lang: 'wasm', version: 1 }]));
    const ladder = summarize({ id: 'arena-r5', createdAt: new Date().toISOString(), status: 'done', engine: null, config, botInfo, games, scheduled: 2 });
    writeJson(path.join(vol, 'results', 'arena-r5', 'ladder.json'), ladder);

    const r = await publish(5);
    assert.deepStrictEqual(r.json, { ok: true, status: 'done' }, r.err);
    const st = readJson(path.join(vol, 'arena', 'standings.json'));
    const rd = st.rounds.find((x) => x.round === 5);
    assert.deepStrictEqual([rd.status, rd.games, rd.scheduled, rd.leader, rd.ladderId], ['done', 2, 2, 'kim-v1', 'arena-r5']);
    assert.deepStrictEqual(rd.decks, { file: 'ash-meta-2026-09.json', sha256: 'a'.repeat(64), lists: 2, deal: 'seat' });
    assert.match(fs.readFileSync(path.join(vol, 'arena', 'rounds', 'r5.md'), 'utf8'), /^# Arena round 5 results\n/);
    assert.ok(fs.existsSync(path.join(vol, 'arena', 'panels', 'leaderboard.json')), 'the panels');

    // still running: published as running
    writeJson(path.join(vol, 'results', 'arena-r5', 'ladder.json'), { ...ladder, status: 'running' });
    assert.deepStrictEqual((await publish(5)).json, { ok: true, status: 'running' });

    // a ladder.json or a round folder that is a link is not read
    fs.rmSync(path.join(vol, 'results', 'arena-r5', 'ladder.json'));
    fs.symlinkSync(path.join(tmp, 'nowhere.json'), path.join(vol, 'results', 'arena-r5', 'ladder.json'));
    assert.strictEqual((await publish(5)).code, 1);
    fs.symlinkSync(path.join(vol, 'results', 'arena-r5'), path.join(vol, 'results', 'arena-r6'));
    assert.strictEqual((await publish(6)).code, 1);
    assert.strictEqual((await ctl(['publish', '--arena', 'open', '--round', 'x'], { GAMES_DATA: vol })).code, 2);
});

test('gamesctl decks: a deck file of bot/decks as a round loads it; never a path', { skip: !ENGINE && 'needs the engine and its card data' }, async () => {
    let r = await ctl(['decks', '--file', 'ash-meta-2026-09.json', '--skip', 'lando-calrissian_law_blue']);
    assert.strictEqual(r.code, 0, r.err);
    assert.deepStrictEqual(Object.keys(r.json), ['file', 'sha256', 'names', 'skipped', 'lists']);
    assert.deepStrictEqual([r.json.file, r.json.sha256, r.json.skipped], ['ash-meta-2026-09.json', sha256(fs.readFileSync(DECKS)), ['lando-calrissian_law_blue']]);
    const all = JSON.parse(fs.readFileSync(DECKS, 'utf8'));
    assert.strictEqual(r.json.lists.length, all.length - 1);
    assert.deepStrictEqual(r.json.names, r.json.lists.map((d) => d.metadata.name));

    r = await ctl(['decks', '--file', 'ash-meta-2026-09.json']);
    assert.deepStrictEqual([r.code, r.json?.lists.length, r.json?.skipped], [0, all.length, []], r.err);
    assert.strictEqual((await ctl(['decks', '--file', 'ash-meta-2026-09.json', '--skip', 'no-such-deck'])).code, 1, 'a list to skip that is not there');

    for (const file of ['../decks/ash-meta-2026-09.json', DECKS, 'README.md', 'nope.json', '.ash.json', '']) {
        assert.strictEqual((await ctl(['decks', '--file', file])).code, 2, file);
    }
    assert.strictEqual((await ctl(['decks'])).code, 2);
});

test('gamesctl setup: the mode chmod a+rX gives in a folder only root writes', () => {
    const { readableMode } = require('../arena/gamesctl');
    for (const [mode, dir, want] of [
        [0o700, true, 0o755], [0o777, true, 0o755], [0o2775, true, 0o755], [0o755, true, 0o755],
        [0o600, false, 0o644], [0o640, false, 0o644], [0o644, false, 0o644], [0o666, false, 0o644], [0o000, false, 0o444],
        [0o700, false, 0o755], [0o744, false, 0o755], [0o100, false, 0o555], [0o4755, false, 0o755], [0o2711, false, 0o755]
    ]) {
        assert.strictEqual(readableMode(mode, dir).toString(8), want.toString(8), `${mode.toString(8)} ${dir ? 'folder' : 'file'}`);
    }
});

/** A volume with a round the bots' user's ladder wrote (closed modes), a game job a stop left, and a link out. */
function oldVolume(owner) {
    const vol = fs.mkdtempSync(path.join(tmp, 'setup-'));
    fs.chmodSync(vol, 0o755);
    const run = path.join(vol, 'results', 'arena-r1');
    writeJson(path.join(run, 'ladder.json'), { status: 'done' });
    writeJson(path.join(run, 'games', 'g1.jsonl'), { t: 'header' });
    fs.chmodSync(path.join(run, 'ladder.json'), 0o640);
    fs.chmodSync(path.join(run, 'games', 'g1.jsonl'), 0o600);
    fs.chmodSync(path.join(run, 'games'), 0o700);
    fs.chmodSync(run, 0o700);
    const outside = path.join(tmp, `outside-${path.basename(vol)}`);
    fs.writeFileSync(outside, 'secret', { mode: 0o600 });
    fs.chmodSync(outside, 0o600);
    fs.symlinkSync(outside, path.join(run, 'games', 'g2.jsonl'));
    writeJson(path.join(vol, 'work', 'job-1', 'out', 'g.jsonl'), {});
    writeJson(path.join(vol, 'arena', 'roster.json'), { thinkCapMs: 60000, baselines: [], agents: [] });
    if (owner) {
        execFileSync('chown', ['-R', '-h', `${owner[0]}:${owner[1]}`, vol]);
    }
    return { vol, run, outside };
}

test('gamesctl setup: as another user than root it changes no owner; results are made readable by everyone', { skip: ROOT_USER && !BOTS_USER && 'running as root with no user arena to run it as' }, async () => {
    // as root here, run it as the bots' user instead (setpriv), in a volume that user owns
    const as = ROOT_USER ? BOTS_USER : null;
    const { vol, run, outside } = oldVolume(as);
    const r = await ctl(['setup'], { GAMES_DATA: vol, HOME: vol }, { as });
    assert.strictEqual(r.code, 0, r.err);
    assert.strictEqual(r.json.ok, true);
    const me = as ? as[0] : process.getuid();
    for (const p of [vol, path.join(vol, 'results'), run, path.join(run, 'games', 'g1.jsonl'), path.join(vol, 'arena', 'roster.json')]) {
        assert.strictEqual(fs.lstatSync(p).uid, me, `${p}: no owner changed`);
    }
    assert.deepStrictEqual([modeOf(run), modeOf(path.join(run, 'games')), modeOf(path.join(run, 'games', 'g1.jsonl')), modeOf(path.join(run, 'ladder.json'))],
        [0o755, 0o755, 0o644, 0o644]);
    assert.strictEqual(modeOf(outside), 0o600, 'a link is never followed');
    assert.deepStrictEqual(['bundles', 'work', 'server', 'secret', 'intake'].map((d) => modeOf(path.join(vol, d)).toString(8)), ['755', '755', '700', '700', '711']);
    assert.deepStrictEqual(fs.readdirSync(path.join(vol, 'work')), [], 'game jobs a stop left are gone');
    assert.match(fs.readFileSync(path.join(vol, 'secret', 'arena-secret'), 'utf8'), /^[0-9a-f]{64}$/);
});

test('gamesctl setup: as root, results become root\'s once and readable by everyone, arena/ and dash/ root\'s on every start; the bots\' HOME and the wasm cache root\'s and emptied', { skip: !(ROOT_USER && BOTS_USER) && 'needs root and a user arena' }, async () => {
    const { vol, run, outside } = oldVolume(BOTS_USER);
    for (const d of ['home', 'wasm-cache', 'dash']) {
        fs.mkdirSync(path.join(vol, d));
    }
    // what the bots' user left in its HOME and cache under an older image: a .pth file Python would run, compiled code
    const pth = path.join(vol, 'home', '.local', 'lib', 'python3.12', 'site-packages', 'x.pth');
    fs.mkdirSync(path.dirname(pth), { recursive: true });
    fs.writeFileSync(pth, 'import os');
    const cwasm = (c) => path.join(vol, 'wasm-cache', `${c.repeat(64)}.cwasm`);
    fs.writeFileSync(cwasm('a'), 'machine code');
    execFileSync('chown', ['-R', '-h', `${BOTS_USER[0]}:${BOTS_USER[1]}`, path.join(vol, 'home'), path.join(vol, 'wasm-cache')]);
    let r = await ctl(['setup'], { GAMES_DATA: vol, HOME: vol });
    assert.strictEqual(r.code, 0, r.err);
    const owner = (p) => fs.lstatSync(path.join(vol, p)).uid;
    for (const p of ['results', 'results/arena-r1', 'results/arena-r1/games', 'results/arena-r1/games/g1.jsonl', 'results/arena-r1/ladder.json', 'results/arena-r1/games/g2.jsonl']) {
        assert.strictEqual(owner(p), 0, `${p} is root's`);
    }
    assert.deepStrictEqual([modeOf(run), modeOf(path.join(run, 'games', 'g1.jsonl')), modeOf(path.join(run, 'ladder.json'))], [0o755, 0o644, 0o644]);
    assert.deepStrictEqual([fs.statSync(outside).uid, modeOf(outside)], [0, 0o600], 'nothing through a link');
    // the bots' HOME and the cache are root's and empty; arena/ and dash/ are root's (the intake enters versions as
    // root), and readable by everyone (plan and push read them as the bots' user)
    for (const p of ['home', 'wasm-cache']) {
        assert.deepStrictEqual([owner(p), modeOf(path.join(vol, p)), fs.readdirSync(path.join(vol, p))], [0, 0o755, []], `${p}: root's and emptied`);
    }
    assert.match(r.err, /wasm-cache was not root's: emptied/);
    for (const p of ['arena', 'arena/roster.json', 'dash']) {
        assert.strictEqual(owner(p), 0, `${p} is root's`);
    }
    assert.deepStrictEqual([modeOf(path.join(vol, 'arena')), modeOf(path.join(vol, 'arena', 'roster.json')), modeOf(path.join(vol, 'dash'))], [0o755, 0o644, 0o755]);
    for (const [p, mode] of [['bundles', 0o755], ['work', 0o755], ['server', 0o700], ['secret', 0o700], ['intake', 0o711], ['tmp/referee', null]]) {
        assert.strictEqual(owner(p), 0, `${p} is root's`);
        if (mode !== null) {
            assert.strictEqual(modeOf(path.join(vol, p)), mode, p);
        }
    }
    assert.deepStrictEqual([owner('secret/arena-secret'), modeOf(path.join(vol, 'secret', 'arena-secret'))], [0, 0o600]);

    // the flip happens once (when results/ is not root's): later setups only keep everything readable
    const g = path.join(run, 'games', 'g1.jsonl');
    fs.chownSync(g, BOTS_USER[0], BOTS_USER[1]);
    fs.chmodSync(g, 0o600);
    // and what root compiled stays in the cache, while the HOME is emptied on every start
    fs.writeFileSync(cwasm('b'), 'root\'s machine code', { mode: 0o644 });
    fs.mkdirSync(path.join(vol, 'home', '.node_modules'));
    r = await ctl(['setup'], { GAMES_DATA: vol, HOME: vol });
    assert.strictEqual(r.code, 0, r.err);
    assert.deepStrictEqual([fs.statSync(g).uid, modeOf(g)], [BOTS_USER[0], 0o644]);
    assert.deepStrictEqual([fs.readdirSync(path.join(vol, 'wasm-cache')), fs.readdirSync(path.join(vol, 'home'))], [[path.basename(cwasm('b'))], []]);
    // a cache an older image gave back to the bots' user is emptied again
    execFileSync('chown', ['-R', '-h', `${BOTS_USER[0]}:${BOTS_USER[1]}`, path.join(vol, 'wasm-cache')]);
    r = await ctl(['setup'], { GAMES_DATA: vol, HOME: vol });
    assert.strictEqual(r.code, 0, r.err);
    assert.deepStrictEqual([owner('wasm-cache'), fs.readdirSync(path.join(vol, 'wasm-cache'))], [0, []]);

    // arena/ is root's again on every start, whoever owned it since (an older image gives it back to the bots' user)
    execFileSync('chown', ['-R', '-h', `${BOTS_USER[0]}:${BOTS_USER[1]}`, path.join(vol, 'arena')]);
    r = await ctl(['setup'], { GAMES_DATA: vol, HOME: vol });
    assert.strictEqual(r.code, 0, r.err);
    assert.deepStrictEqual([owner('arena'), owner('arena/roster.json')], [0, 0]);

    // a link in place of one of its folders stops setup
    fs.rmSync(path.join(vol, 'work'), { recursive: true });
    fs.symlinkSync(tmp, path.join(vol, 'work'));
    r = await ctl(['setup'], { GAMES_DATA: vol, HOME: vol });
    assert.strictEqual(r.code, 1);
    assert.match(r.err, /is not a folder/);
});

test('gamesctl setup: what the bots\' user planted in arena/ and dash/ while it owned them goes before root reads or writes there', { skip: !(ROOT_USER && BOTS_USER) && 'needs root and a user arena' }, async () => {
    const { vol } = oldVolume(BOTS_USER);
    const arena = path.join(vol, 'arena');
    const as = (p) => execFileSync('chown', ['-h', `${BOTS_USER[0]}:${BOTS_USER[1]}`, p]);
    for (const d of ['home', 'wasm-cache', 'dash/panels', 'arena/versions/kim-v1/bundle']) {
        fs.mkdirSync(path.join(vol, d), { recursive: true });
    }
    // a file only root reads, owned by a third user: a chown or chmod through a link would show on it
    const nobody = Number(execFileSync('id', ['-u', 'nobody'], { encoding: 'utf8' }));
    const target = path.join(tmp, `target-${path.basename(vol)}`);
    fs.writeFileSync(target, '{"leak":"0123456789abcdef"}', { mode: 0o600 });
    fs.chownSync(target, nobody, nobody);
    const targetDir = fs.mkdtempSync(path.join(tmp, 'target-dir-'));
    fs.chmodSync(targetDir, 0o700);
    // roster.json as a link to it, a pipe where standings.json goes, rounds/ as a link to a folder, a version's file
    // that is also a file elsewhere on the volume, an extended attribute, a setuid file, a FIFO and a socket-like leftover
    fs.rmSync(path.join(arena, 'roster.json'));
    fs.symlinkSync(target, path.join(arena, 'roster.json'));
    execFileSync('mkfifo', [path.join(arena, 'standings.json')]);
    fs.symlinkSync(targetDir, path.join(arena, 'rounds'));
    const wasm = path.join(arena, 'versions', 'kim-v1', 'bundle', 'bot.wasm');
    fs.writeFileSync(wasm, 'the bot');
    fs.mkdirSync(path.join(vol, 'bundles'));
    fs.linkSync(wasm, path.join(vol, 'bundles', 'bot.wasm'));
    fs.writeFileSync(path.join(arena, 'versions', 'kim-v1', 'bundle', 'arena.json'), '{}');
    execFileSync('python3', ['-c', 'import os, sys; os.setxattr(sys.argv[1], "user.planted", b"1")', path.join(arena, 'versions', 'kim-v1', 'bundle', 'arena.json')]);
    fs.writeFileSync(path.join(arena, 'run.sh'), 'x');
    fs.chmodSync(path.join(arena, 'run.sh'), 0o4755);
    fs.symlinkSync(target, path.join(vol, 'dash', 'panels', 'arena-kim.json'));
    for (const p of [arena, ...['roster.json', 'standings.json', 'rounds', 'versions', 'versions/kim-v1', 'versions/kim-v1/bundle', 'versions/kim-v1/bundle/bot.wasm',
        'versions/kim-v1/bundle/arena.json', 'run.sh'].map((x) => path.join(arena, x)), path.join(vol, 'dash'), path.join(vol, 'dash', 'panels'),
    path.join(vol, 'dash', 'panels', 'arena-kim.json'), path.join(vol, 'home')]) {
        as(p);
    }
    const r = await ctl(['setup'], { GAMES_DATA: vol, HOME: vol });
    assert.strictEqual(r.code, 0, r.err);
    assert.ok(!`${r.out}${r.err}`.includes('0123456789'), 'nothing of the link\'s target is read');
    assert.deepStrictEqual([fs.statSync(target).uid, modeOf(target), fs.readFileSync(target, 'utf8')], [nobody, 0o600, '{"leak":"0123456789abcdef"}'], 'nothing through a link');
    assert.deepStrictEqual([fs.statSync(targetDir).uid, fs.readdirSync(targetDir)], [0, []]);
    for (const p of ['standings.json', 'rounds']) {
        assert.ok(!fs.existsSync(path.join(arena, p)) || fs.lstatSync(path.join(arena, p)).isFile(), `${p}: the planted one is gone`);
    }
    // roster.json is a plain root file again (setup made a fresh one)
    const roster = fs.lstatSync(path.join(arena, 'roster.json'));
    assert.ok(roster.isFile() && roster.uid === 0, 'roster.json is root\'s own file');
    assert.ok(!fs.existsSync(path.join(vol, 'dash', 'panels', 'arena-kim.json')));
    // nothing of the arena's makes hard links: the name in arena/ goes (a copy could be made to fill the volume), the
    // other one stays the bots' user's
    assert.ok(!fs.existsSync(wasm), 'a version\'s file with another name is removed');
    const other = fs.lstatSync(path.join(vol, 'bundles', 'bot.wasm'));
    assert.deepStrictEqual([other.uid, other.nlink, fs.readFileSync(path.join(vol, 'bundles', 'bot.wasm'), 'utf8')], [BOTS_USER[0], 1, 'the bot']);
    const attrs = execFileSync('python3', ['-c', 'import os, sys; print(os.listxattr(sys.argv[1]))', path.join(arena, 'versions', 'kim-v1', 'bundle', 'arena.json')], { encoding: 'utf8' });
    assert.strictEqual(attrs.trim(), '[]');
    assert.strictEqual(modeOf(path.join(arena, 'run.sh')), 0o755, 'no setuid');
    for (const p of ['versions', 'versions/kim-v1', 'versions/kim-v1/bundle']) {
        assert.deepStrictEqual([fs.lstatSync(path.join(arena, p)).uid, modeOf(path.join(arena, p))], [0, 0o755], p);
    }
    assert.match(r.err + r.out, /"roster\.json" removed/);
    assert.match(r.err + r.out, /"versions\/kim-v1\/bundle\/bot\.wasm" removed/);
});

test('own-tree.py: a tree deeper than it walks goes, and its summary stays short whatever the names', { skip: !ROOT_USER && 'needs root' }, () => {
    const own = path.join(__dirname, '..', 'arena', 'ops', 'own-tree.py');
    // 160 folders, each named with 255 bytes that are not UTF-8 (each one 6 characters in JSON), then 100 more in the last
    const plant = (top) => execFileSync('python3', ['-c', `import os, sys
os.chdir(sys.argv[1])
for i in range(160):
    os.mkdir(b"\\xff" * 255)
    os.chdir(b"\\xff" * 255)
for i in range(100):
    os.mkdir(b"\\xff" * 250 + b"%05d" % i)`, top]);
    const run = (...args) => require('child_process').spawnSync('python3', ['-I', own, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
    const top = fs.mkdtempSync(path.join(tmp, 'deep-'));
    plant(top);
    const rooted = run('root', top);
    assert.strictEqual(rooted.status, 0, rooted.stderr);
    assert.ok(rooted.stdout.length < 512 * 1024, `${rooted.stdout.length} bytes`);
    const removed = JSON.parse(rooted.stdout).removed;
    assert.strictEqual(removed.length, 100, 'the folders past the depth it walks');
    assert.ok(removed.every((p) => p.length <= 160 && p.includes('/.../')));
    assert.strictEqual(run('give', '1:1', top).status, 2, 'root is its one mode');
    const depth = Number(execFileSync('python3', ['-c', 'import os, sys\nos.chdir(sys.argv[1])\nn = 0\nwhile os.listdir("."):\n    os.chdir(os.listdir(".")[0]); n += 1\nprint(n)', top], { encoding: 'utf8' }));
    assert.strictEqual(depth, 160, 'what it walks stays');
    execFileSync('rm', ['-rf', top]);
});

test('gamesctl warm, plan and push write nothing into arena/, results/ or dash/', { skip: !BUNDLE && 'no build/compiled/node-random' }, async () => {
    const vol = volume(['kim', 'res_clock']);
    const run = path.join(vol, 'results', 'arena-r0');
    writeJson(path.join(vol, 'arena', 'standings.json'), { rounds: [{ round: 0, status: 'done', ladderId: 'arena-r0', bots: [{ name: 'kim-v1' }, { name: 'res_clock-v1' }] }], updatedAt: new Date().toISOString() });
    writeJson(path.join(run, 'index.json'), { games: [{ id: 'g1', outcome: 'won' }] });
    writeJson(path.join(run, 'ladder.json'), { status: 'done' });
    writeJson(path.join(run, 'games', 'g1.jsonl'), { t: 'header' });
    writeJson(path.join(vol, 'dash', 'panels', 'arena-leaderboard.json'), {});
    const snapshot = () => ['arena', 'results', 'dash'].flatMap((top) => {
        const out = [];
        const walk = (p) => {
            const st = fs.lstatSync(p);
            out.push([path.relative(vol, p), st.mode, st.size, st.mtimeMs, st.uid]);
            if (st.isDirectory()) {
                fs.readdirSync(p).sort().forEach((f) => walk(path.join(p, f)));
            }
        };
        walk(path.join(vol, top));
        return out;
    });
    const before = snapshot();
    const w = await fakeWindow();
    try {
        const env = { GAMES_DATA: vol, HOME: path.join(vol, 'home') };
        const runs = [
            await ctl(['warm'], env),
            await ctl(['plan', '--arena', 'open', '--settled-since', '0'], env),
            await ctl(['push', '--arena', 'open', '--state', path.join(vol, 'tmp', 'push', 'state.json'), '--boot', 'b1'], { ...env, SWU_WINDOW: `${w.url}/p/nonce` })
        ];
        for (const r of runs) {
            assert.strictEqual(r.code, 0, r.err);
        }
        assert.deepStrictEqual(runs[2].json, { ok: true });
        assert.ok(w.calls.length > 0, 'push sent something');
    } finally {
        await w.close();
    }
    assert.deepStrictEqual(snapshot(), before);
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
