'use strict';
// The bot dev harness (bot/dev.js): how it reads a bot folder, arena_submit's rules, run folders, the deal and the jobs
// it builds, real runs of small Python bots through the arena's checker and play-seed.js (recorded, reported, played
// again the same), the faults it reports (alike whatever their messages say, once per kind, stopping early, sent to the
// bot again), games the bot never finishes, the intake's refusals, JavaScript errors named by file and line, the
// transcript tap, the viewer, Ctrl-C and SIGKILL, and that it never sends anything anywhere. Each part skips when its piece is missing: the built engine and card data, wasmtime for Python,
// CPython for WASI, Javy, /proc (Linux) for the process checks.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const dev = require('../dev');

const ROOT = path.join(__dirname, '..', '..');
const DEV = path.join(ROOT, 'bot', 'dev.js');
const TOOLS = path.join(ROOT, 'build', 'compiled', '.tools');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ENGINE = fs.existsSync(path.join(ROOT, 'forceteki', 'build', 'server')) && fs.existsSync(path.join(ROOT, 'forceteki', 'test', 'json'));
// the python3 the harness's children run (the sandbox's virtualenv first)
const WASMTIME = spawnSync('python3', ['-I', '-c', 'import wasmtime'], { stdio: 'ignore', env: { PATH: dev.childEnv(tmp).PATH } }).status === 0;
const PYWASI = fs.existsSync(path.join(TOOLS, 'python-3.14.7', 'python.wasm'));
const JAVY = fs.existsSync(path.join(TOOLS, 'javy-8.0.0', 'javy'));
const PLAYS = ENGINE && WASMTIME && PYWASI;
const NEEDS_PLAY = !PLAYS && 'needs the engine and card data, wasmtime for Python and CPython for WASI (npm run setup)';

// nothing a test runs may reach a window
const { SWU_WINDOW, ARENA_PUSH_TOKEN, SWU_WINDOW_TOKEN, NODE_ENV, SWU_EXTERNAL_BOTS, ...BASE_ENV } = process.env;

/** A bot folder in the scratch folder with these files. */
function folder(name, files) {
    const d = path.join(tmp, name);
    for (const [p, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(d, p)), { recursive: true });
        fs.writeFileSync(path.join(d, p), body);
    }
    return d;
}

/** Runs bot/dev.js; resolves to {code, signal, out, err}. Async, so a server in this process can answer while it runs. */
function runDev(args, { env = BASE_ENV, cwd = tmp, started = null } = {}) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [DEV, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        started?.(child);
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (err += d));
        child.on('close', (code, signal) => resolve({ code, signal, out, err }));
    });
}

/**
 * The processes started for a run, as {pid, cmd}: those with the run's arena folder as ARENA_HOME (the harness's
 * children) and every process in their process groups (the bots in the sandbox, whose environment is built from
 * nothing); Linux.
 */
function runProcesses(run) {
    const mark = `ARENA_HOME=${path.join(run, 'arena')}\0`;
    const read = (pid, f) => {
        try {
            return fs.readFileSync(`/proc/${pid}/${f}`, 'latin1');
        } catch {
            return null; // gone, or not ours
        }
    };
    const all = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map((pid) => {
        const stat = read(pid, 'stat');
        // pid (comm) state ppid pgrp ...: the command may hold spaces and parentheses
        const pgrp = stat ? Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]) : null;
        return { pid: Number(pid), pgrp, cmd: (read(pid, 'cmdline') ?? '').split('\0').join(' ') };
    });
    const leaders = new Set(all.filter((p) => read(p.pid, 'environ')?.includes(mark)).map((p) => p.pid));
    return all.filter((p) => leaders.has(p.pid) || leaders.has(p.pgrp));
}
const PROC = fs.existsSync('/proc/self/environ');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits until check() is true, for up to ms; gives its last value. */
async function until(check, ms) {
    const end = Date.now() + ms;
    let v = check();
    while (!v && Date.now() < end) {
        await pause(200);
        v = check();
    }
    return v;
}

// A Python bot that reads the card data in hello.cards, logs one line to stderr, and plays at random from hello.seed
const PY_BOT = `import json, random, sys
rng = random.Random(0)
for line in sys.stdin:
    msg = json.loads(line)
    t = msg["t"]
    if t == "hello":
        rng.seed(msg["seed"])
        cards = msg.get("cards") or []
        sys.stderr.write("cards: %d, a %s\\n" % (len(cards), cards[0]["title"] if cards else None))
        reply = {"t": "ready", "v": 2}
    elif t == "decide":
        reply = {"t": "act", "i": rng.choice(msg["actions"])["i"]}
    elif t == "over":
        reply = {"t": "ok"}
    else:
        continue
    print(json.dumps(reply), flush=True)
`;

// Python lines for faultyBot: an act that names no action, `past` beyond the last
const BAD_INDEX = (past) => `print(json.dumps({"t": "act", "i": len(json.loads(line)["actions"]) + ${past}}), flush=True)\ncontinue`;

/** A Python bot that plays the first action, and at its decision `at` does `what` (Python lines, before it answers). */
const faultyBot = (at, what) => `import json, sys, time
n = 0
for line in sys.stdin:
    t = json.loads(line)["t"]
    if t == "hello":
        n = 0
        print(json.dumps({"t": "ready", "v": 2}), flush=True)
    elif t == "decide":
        n += 1
        if n == ${at}:
${what.split('\n').map((l) => `            ${l}`).join('\n')}
        print(json.dumps({"t": "act", "i": 0}), flush=True)
    elif t == "over":
        print(json.dumps({"t": "ok"}), flush=True)
`;

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const lines = (f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim());
// what a run's result says about the game, less the clocks
const played = (r) => ({ outcome: r.outcome, winner: r.winner, winnerSeat: r.winnerSeat, by: r.by, faultKind: r.faultKind, steps: r.steps, round: r.round, key: r.key, error: r.error ?? null });

test('parseArgs and the folder: what arena_submit takes, and the names versions play as', () => {
    const o = dev.parseArgs(['mybot', '--owner', 'Ana-B', '--games', '3', '--vs', 'heuristic, ../v1', '--cap-sec=30']);
    assert.deepStrictEqual([o.games, o.vs, o.capSec, o.seed, o.entry, o.owner, o.house, o.all, o.again], [4, ['heuristic', '../v1'], 30, null, null, 'ana-b', false, false, null], 'games made even; a random seed');
    assert.deepStrictEqual([dev.parseArgs(['mybot', '--house', '--seed', '7', '--all']).seed, dev.parseArgs(['mybot', '--house', '--all']).all], [7, true]);
    assert.strictEqual(dev.parseArgs(['--view', 'r']).port, 0);
    const bad = [['a', '--house', '--cap-sec', '5'], ['a', '--house', '--games', '-2'], ['a', '--house', '--bogus', '1'], ['--house'], ['a', 'b', '--house'], ['a', '--house', '--seed'],
        ['a'], ['a', '--owner', 'ana', '--house'], ['a', '--owner', 'not a login'], ['a', '--house=1'], ['a', '--house', '--again', 'f.in.jsonl', '--games', '2']];
    for (const args of bad) {
        assert.throws(() => dev.parseArgs(args), (e) => e.constructor.name === 'Usage', args.join(' '));
    }
    assert.throws(() => dev.parseArgs(['a']), /say whose bot it is: --owner <your GitHub login>/);
    assert.strictEqual(dev.nameOf('/x/My-Bot.v2'), 'my_bot_v2');
    assert.strictEqual(dev.nameOf('/x/2fast'), 'bot_2fast');

    const { houseDoc } = require('../arena/ops/house-submit');
    const py = folder('kinds-py', { 'bot.py': 'x', 'lib/util.py': 'y', '.runs/r/run.json': '{}', '.secret': 'k', '__pycache__/bot.pyc': 'z' });
    // a folder with bot.py and no bot.js is a Python bot, as arena_submit takes kind python with no entry
    const pyBot = dev.withDefaultEntry(dev.botAt(py));
    assert.deepStrictEqual(pyBot, { folder: py, entry: 'bot.py' });
    const pyDoc = houseDoc('kinds_py', pyBot.folder, { note: 'n', entry: pyBot.entry });
    assert.deepStrictEqual([pyDoc.kind, Object.keys(pyDoc.files)], ['python', ['bot.py', 'lib/util.py']], 'no runs, dot files or __pycache__');
    // a file path names its folder and the entry
    const js = folder('kinds-js', { 'main.js': 'x', 'bot.js': 'y' });
    assert.deepStrictEqual(dev.botAt(path.join(js, 'main.js')), { folder: js, entry: 'main.js' });
    assert.strictEqual(houseDoc('k', js, { note: 'n' }).kind, 'js', 'bot.js by default');
    assert.strictEqual(houseDoc('k', path.join(tmp, 'kinds-py'), { note: 'n', entry: 'lib/util.py' }).kind, 'python');
    const wasm = folder('kinds-wasm', { 'arena.json': '{}', 'bot.wasm': Buffer.from([0, 97, 115, 109]) });
    assert.deepStrictEqual(dev.withDefaultEntry(dev.botAt(wasm)), { folder: wasm, entry: null });
    assert.deepStrictEqual(houseDoc('k', wasm, { note: 'n' }).base64, ['bot.wasm']);
    // no entry to be found: the intake's words, for either language
    const none = folder('kinds-none', { 'main.py': 'x' });
    assert.match(dev.withDefaultEntry(dev.botAt(none)).refused, /^no bot\.js or bot\.py: .*--entry FILE here, entry in arena_submit/);
    assert.strictEqual(dev.withDefaultEntry(dev.botAt(none, 'run.py')).refused, 'no run.py: a Python bot\'s files must include it (or name another entry)');
    assert.strictEqual(dev.withDefaultEntry(dev.botAt(none, 'main.py')).refused, undefined);
});

test('pasted commands, read ends of files, run folders, the card data id and Javy\'s platforms', () => {
    assert.deepStrictEqual(['a/b-c.in.jsonl', 'my bot/x', "it's", ''].map(dev.sh), ['a/b-c.in.jsonl', "'my bot/x'", "'it'\\''s'", "''"]);
    const r = spawnSync('bash', ['-c', `printf '%s|' ${['my bot/x', "it's", 'a b'].map(dev.sh).join(' ')}`], { encoding: 'utf8' });
    assert.strictEqual(r.stdout, "my bot/x|it's|a b|", 'bash reads each back as it was');

    // the end of a big file, read from its end
    const big = path.join(tmp, 'big.stderr');
    fs.writeFileSync(big, `${'x'.repeat(200)}\n`.repeat(50000) + 'Traceback\n  line 3\nValueError: no\n');
    assert.deepStrictEqual(dev.tailOf(big, 2), ['  line 3', 'ValueError: no']);
    assert.deepStrictEqual(dev.tailOf(path.join(tmp, 'nothing'), 2), []);

    // the transcript tap keeps the head and the tail of a flood of stderr
    const { openTap } = require('../stdio');
    const tap = openTap(path.join(tmp, 'flood'), { head: 10, tail: 8 });
    for (const chunk of ['0123456', '789abcdef', 'ghijklmnop', 'qrstuvwxyz\n']) {
        tap.write('err', chunk);
    }
    tap.close();
    assert.strictEqual(fs.readFileSync(path.join(tmp, 'flood.stderr'), 'utf8'), '0123456789\n[19 bytes of stderr left out]\ntuvwxyz\n');

    // two runs never share a folder; --out must be an empty folder (or none yet)
    const planned = path.join(tmp, 'claims', 'r');
    const a = dev.claimRun(planned, false);
    const b = dev.claimRun(planned, false);
    assert.deepStrictEqual([a.run, b.run], [planned, `${planned}-2`]);
    assert.ok(fs.existsSync(path.join(planned, 'run.json')));
    b.release();
    assert.ok(!fs.existsSync(`${planned}-2`), 'release() takes back a folder it made');
    fs.writeFileSync(path.join(tmp, 'claims', 'afile'), 'x');
    fs.mkdirSync(path.join(tmp, 'claims', 'empty'));
    const usageOf = (f) => assert.throws(f, (e) => e.constructor.name === 'Usage');
    usageOf(() => dev.claimRun(path.join(tmp, 'claims', 'afile'), true));
    usageOf(() => dev.claimRun(planned, true));
    assert.strictEqual(dev.claimRun(path.join(tmp, 'claims', 'empty'), true).run, path.join(tmp, 'claims', 'empty'));
    usageOf(() => dev.claimRun(path.join(tmp, 'claims', 'empty'), true));
    dev.claimRun(path.join(tmp, 'claims', 'new', '.runs', 'r'), false).release();
    assert.ok(!fs.existsSync(path.join(tmp, 'claims', 'new')), 'and the folders made for it');

    // the card data's id is the games image's CARDS_SHA (Dockerfile.games)
    if (ENGINE) {
        const sh = spawnSync('sh', ['-c', 'cd "$1" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d" " -f1', 'sh', path.join(ROOT, 'forceteki', 'test', 'json')], { encoding: 'utf8' });
        if (sh.status === 0 && /^[0-9a-f]{64}$/.test(sh.stdout.trim())) {
            assert.strictEqual(dev.cardsSha(), sh.stdout.trim());
        }
    }

    // Javy: setup installs it only where toolchain.json pins it, and the harness says so elsewhere
    for (const key of ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64']) {
        assert.strictEqual(dev.javyUnpinned(key), null, key);
    }
    assert.match(dev.javyUnpinned('win32-x64'), /^Javy 8\.0\.0 is not pinned for win32-x64 yet .*cannot pack JavaScript bots; Python bots and bundles work$/);
});

test('usage: an --out the bot would be packed with, an opponent the arena does not play, a missing folder (exit 2)', async () => {
    const bot = folder('usage-bot', { 'bot.py': PY_BOT });
    const cases = [
        [[bot, '--house', '--out', path.join(bot, 'runs')], /inside .*usage-bot, so the arena would get it with the bot: put it under a dot folder/],
        [[bot, '--house', '--vs', 'aggro'], /--vs aggro: the opponents are heuristic, rush, random, or a bot folder/],
        [[bot, '--house', '--vs', 'rush,rush'], /names rush twice/],
        [[path.join(tmp, 'no-such-bot'), '--house'], /no such file or folder/],
        [[bot, '--owner', 'Not A Login'], /--owner/],
        [[bot], /say whose bot it is/],
        [[bot, '--house', '--out', path.join(tmp, 'usage-file')], /usage-file is not a folder: give another --out/],
        [[bot, '--house', '--again', path.join(tmp, 'no-such.in.jsonl')], /--again .*no-such\.in\.jsonl: no transcript of a whole game there/],
        // the end of a transcript, as a run keeps it of a game with no result: it does not start with hello
        [[bot, '--house', '--again', path.join(tmp, 'usage-end.in.jsonl')], /--again .*usage-end\.in\.jsonl: no transcript of a whole game there \(.*which starts with hello\)/]
    ];
    fs.writeFileSync(path.join(tmp, 'usage-file'), 'x');
    fs.writeFileSync(path.join(tmp, 'usage-end.in.jsonl'), '{"t":"decide","seq":5980}\n');
    for (const [args, want] of cases) {
        const r = await runDev(args);
        assert.strictEqual(r.code, 2, `${args.join(' ')}: ${r.out}${r.err}`);
        assert.match(r.out, want);
    }
    assert.ok(!fs.existsSync(path.join(bot, 'runs')) && !fs.existsSync(path.join(bot, '.runs')), 'no run folder');
});

test('a builder\'s bot is held to arena_submit\'s rules before anything runs: its files, its name, its entry (exit 3)', async () => {
    const big = folder('big-bot', { 'bot.py': PY_BOT, 'weights.bin': Buffer.alloc(3.1e6, 1) });
    const bigRun = path.join(tmp, 'big-run');
    const r = await runDev([big, '--owner', 'ana', '--games', '0', '--out', bigRun]);
    assert.strictEqual(r.code, 3, r.out + r.err);
    assert.match(r.out, /^ana-v1 \(.*big-bot\): arena_submit would refuse it:\nfiles: at most 3 MB in all\n$/);
    assert.ok(!fs.existsSync(bigRun), 'nothing ran: no run folder');
    const { submitFiles } = require('../arena/window');
    const { houseDoc } = require('../arena/ops/house-submit');
    assert.throws(() => submitFiles(houseDoc('big_bot', big, { note: 'n', entry: 'bot.py' })), /at most 3 MB/);
    fs.writeFileSync(path.join(big, 'weights.bin'), Buffer.alloc(2e6, 1));
    assert.doesNotThrow(() => submitFiles(houseDoc('big_bot', big, { note: 'n', entry: 'bot.py' })));

    // arena_submit's name rule: the builder name (the default), or it with _ and a suffix; the window's words
    const bot = folder('names-bot', { 'bot.py': PY_BOT });
    const { notYours } = require('../arena/api');
    for (const [args, want] of [
        [['--owner', 'ana', '--name', 'bob'], `bob (${path.relative(tmp, bot)}): arena_submit would refuse it:\n${notYours('ana', 'bob')}\n`],
        [['--owner', 'ana', '--name', 'Ana'], `Ana (${path.relative(tmp, bot)}): arena_submit would refuse it:\nname: 1-32 characters, lowercase letters, digits and _, starting with a letter\n`],
        [['--owner', 'ana', '--entry', 'main.py'], `ana-v1 (${path.relative(tmp, bot)}): the arena would refuse it:\nno main.py: a Python bot's files must include it (or name another entry)\n`]
    ]) {
        const n = await runDev([bot, ...args, '--games', '0']);
        assert.strictEqual(n.code, 3, n.out + n.err);
        assert.strictEqual(n.out, want);
    }
    // an arena folder in the caller's environment (a project's shared one) that holds ana-v1: the run reads its own,
    // so the bot keeps its name (and its bundle id)
    const shared = folder('shared-arena', { 'versions/ana-v1/SUBMISSION.json': '{"bot":{"kind":"wasm"}}', 'versions/ana-v1/bundle/arena.json': '{}' });
    const own = await runDev([bot, '--owner', 'ana', '--entry', 'main.py', '--games', '0'], { env: { ...BASE_ENV, ARENA_HOME: shared } });
    assert.strictEqual(own.code, 3, own.out + own.err);
    assert.match(own.out, /^ana-v1 \(/);
    assert.match(notYours('ana', 'bob'), /^"bob" is not yours: use your builder name ana \(whoami\), or it with _ and a suffix, e.g\. ana_fast$/);
    const none = await runDev([folder('no-entry', { 'main.py': PY_BOT }), '--owner', 'ana', '--games', '0']);
    assert.strictEqual(none.code, 3);
    assert.match(none.out, /^ana-v1 \(no-entry\): the arena would refuse it:\nno bot\.js or bot\.py: /);
    assert.ok(!fs.existsSync(path.join(bot, '.runs')), 'nothing ran: no run folder, and no .runs');
});

test('a missing sandbox stops the harness with exit 2 and says npm run setup', { skip: fs.existsSync(path.join(ROOT, 'build', 'compiled', 'venv')) && 'the sandbox\'s virtualenv comes first on PATH' }, async () => {
    const bin = folder('fake-bin', { python3: '#!/bin/sh\nexit 1\n' });
    fs.chmodSync(path.join(bin, 'python3'), 0o755);
    const bot = folder('nosandbox-bot', { 'bot.py': PY_BOT });
    const r = await runDev([bot, '--house', '--out', path.join(tmp, 'nosandbox-run')], { env: { ...BASE_ENV, PATH: `${bin}${path.delimiter}${BASE_ENV.PATH}` } });
    assert.strictEqual(r.code, 2, r.out + r.err);
    assert.match(r.out, /the sandbox is not set up \(no .*wasmtime for Python\): npm run setup/);
});

test('build.py picks the Javy release for each platform, and says what to pin for one it has none for', () => {
    const script = 'import sys, json; sys.path.insert(0, sys.argv[1]); import build\n'
        + 'out = {}\n'
        + 'for s, m in [("Linux", "x86_64"), ("Linux", "aarch64"), ("Darwin", "arm64"), ("Darwin", "x86_64"), ("Windows", "AMD64")]:\n'
        + '    key = build.javy_platform(s, m)\n'
        + '    try:\n'
        + '        out[key] = build.javy_asset(s, m)["url"]\n'
        + '    except build.NotPinned as e:\n'
        + '        out[key] = "not pinned: " + str(e)\n'
        + 'print(json.dumps(out))\n';
    const r = spawnSync('python3', ['-I', '-c', script, path.join(ROOT, 'bot', 'compiled')], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const got = JSON.parse(r.stdout);
    assert.deepStrictEqual(Object.keys(got), ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64', 'windows-x64']);
    assert.match(got['linux-x64'], /javy-x86_64-linux-v8\.0\.0\.gz$/);
    const pinned = require('../compiled/toolchain.json').javy.platforms;
    for (const [k, v] of Object.entries(got)) {
        if (pinned[k]?.sha256) {
            assert.strictEqual(v, pinned[k].url, k);
        } else {
            assert.match(v, new RegExp(`^not pinned: Javy 8\\.0\\.0 is not pinned for ${k} yet: put .* in bot/compiled/toolchain\\.json javy\\.platforms\\.${k}`), k);
        }
    }
});

test('faults are alike by kind, exception class and the bot\'s own deepest line, whatever their messages say', () => {
    const dir = path.join(tmp, 'fault-keys');
    fs.mkdirSync(dir);
    let n = 0;
    const key = (error, stderr, more = {}) => {
        const g = { id: `g${++n}`, p1: 'me-v1', p2: 'rush' };
        fs.writeFileSync(path.join(dir, `${g.id}.p1.stderr`), stderr);
        return dev.faultKey(g, 'p1', { by: 'p1', faultKind: 'error', outcome: 'ERROR', error, ...more }, dir);
    };
    // Python: the last frame in /bot/ (a library's frames below it do not count), the class on the last line
    const py = (label, line = 40) => 'hello as p1: 170 cards indexed\nTraceback (most recent call last):\n  File "/bot/bot.py", line 62, in <module>\n'
        + `    best = max(fresh, key=score)\n  File "/bot/lib/score.py", line ${line}, in score\n    return int(lookup(action["label"]))\n`
        + '  File "/usr/local/lib/python3.14/x.py", line 9, in lookup\n    y()\n'
        + `ValueError: invalid literal for int() with base 10: '${label}'\n`;
    const a = key('p1 me-v1: exited (code 1)', py('allegiant-general-pryde#ruthless-and-loyal'));
    assert.strictEqual(a, 'me-v1\nerror\nexited\nValueError at lib/score.py:40');
    assert.strictEqual(key('p2 me-v1: exited (code 1)', py('advantage')), a, 'another label: the same fault');
    assert.notStrictEqual(key('p1 me-v1: exited (code 1)', py('advantage', 41)), a, 'another line: another fault');
    // JavaScript, as serve() writes it: the first frame outside stdio.js; callers' columns do not count
    const js = (prop, col) => `hello as p1: 155 names\nTypeError: cannot read property '${prop}' of undefined\n    at cost (cards.js:20:34)\n`
        + `    at decide (bot.js:26:${col})\n    at answer (stdio.js:50:45)\n    at serve (stdio.js:92:34)\n`;
    const b = key('p1 me-v1: error: cannot read property \'n\' of undefined (at cards.js:20:34)', js('n', 79));
    assert.strictEqual(b, 'me-v1\nerror\nerror\nTypeError at cards.js:20');
    assert.strictEqual(key('p1 me-v1: error: cannot read property \'cost\' of undefined (at cards.js:20:34)', js('cost', 96)), b);
    assert.strictEqual(key('p1 me-v1: error: bad', 'RangeError: bad\n    at next (stdio.js:40:1)\n    at pick (lib/pick.js:3:9)\n'), 'me-v1\nerror\nerror\nRangeError at lib/pick.js:3');
    // the last stack counts, not one the bot logged before
    assert.strictEqual(key('p1 me-v1: error: x', `Error: handled\n    at old (lib/old.js:7:1)\nlater\n${js('n', 79).split('\n').slice(1).join('\n')}`), b);
    // no stack: the referee's words, less the data after them
    assert.strictEqual(key('p1 me-v1: reply is not JSON: this is not json', ''), key('p1 me-v1: reply is not JSON: {"t": act', 'about to answer\n'));
    assert.notStrictEqual(key('p1 me-v1: reply is not JSON: x', ''), key('p1 me-v1: expected {"t":"act","i":0..4}, got {"t":"ok"}', ''));
    // time: never the stderr, which may hold an old traceback
    const time = { faultKind: 'time' };
    assert.strictEqual(key('p1 me-v1: TIME_FORFEIT me-v1 thought 10003 ms (cap 10000)', py('a'), time), key('p1 me-v1: TIME_FORFEIT me-v1 thought 10012 ms (cap 10000)', '', time));
    // a game with no result, from the bot's seat
    const g = { id: 'g0', p1: 'rush', p2: 'me-v1' };
    assert.strictEqual(dev.faultKey(g, 'p2', { by: null, outcome: 'STEP_CAP', error: null }, dir), 'me-v1\nSTEP_CAP\n\n');
});

test('the deal: the round\'s lists by seat, the same seeds for every opponent, jobs play-seed takes and that repeat', { skip: !ENGINE && 'needs the engine\'s card data' }, () => {
    const { roundDeckLists, ROUND_DECKS } = require('../arena/referee');
    const { normalizeDeck } = require('../decklists');
    const { gameKey } = require('../rng');
    const { roundLimits } = require('../game-pool');
    const decks = roundDeckLists();
    const file = readJson(ROUND_DECKS.file);
    assert.deepStrictEqual(decks.names, file.map((d) => normalizeDeck(d).metadata.name).filter((n) => !ROUND_DECKS.skip.includes(n)));
    assert.deepStrictEqual(decks.skipped, ['lando-calrissian_law_blue']);

    const bundles = path.join(tmp, 'deal-bundles');
    fs.mkdirSync(bundles, { recursive: true });
    const hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
    const bots = { 'me-v1': { kind: 'wasm', bundle: hex('me') }, 'old-v1': { kind: 'wasm', bundle: hex('old') }, heuristic: { kind: 'resident' } };
    for (const b of Object.values(bots).filter((x) => x.bundle)) {
        fs.writeFileSync(path.join(bundles, `${b.bundle}.tar`), '');
    }
    const runKey = 'k'.repeat(32);
    const games = dev.schedule('me-v1', ['heuristic', 'old-v1'], 4, 7, decks.lists.length);
    const build = () => dev.jobsFor(games, 'me-v1', { runKey, limits: roundLimits(60000), bots, lists: decks.lists, bundles });
    const jobs = build();
    assert.strictEqual(JSON.stringify(build()), JSON.stringify(jobs), 'the same seed gives the same jobs');
    assert.deepStrictEqual(jobs.map((j) => [j.seed, j.games.map((g) => g.id)]), [
        [7, ['heuristic-vs-me-v1-7', 'me-v1-vs-heuristic-7']], [7, ['old-v1-vs-me-v1-7', 'me-v1-vs-old-v1-7']],
        [8, ['heuristic-vs-me-v1-8', 'me-v1-vs-heuristic-8']], [8, ['old-v1-vs-me-v1-8', 'me-v1-vs-old-v1-8']]
    ], 'one job per seed and opponent; every opponent plays the same seeds, each from both seats');
    for (const j of jobs) {
        assert.strictEqual(j.key, gameKey(runKey, j.seed), 'the seed\'s game key, never the run key');
        assert.deepStrictEqual([j.capMs, j.hangMs, j.gameMs, j.maxSteps], [60000, 150000, 840000, 6000]);
        assert.deepStrictEqual(j.games.map((g) => g.decks), [[0, 1], [0, 1]], 'each deck stays with its seat, so each bot plays both');
        assert.strictEqual(j.decks.length, 2);
        assert.deepStrictEqual(Object.keys(j.bots).sort(), [...new Set(j.games.flatMap((g) => [g.p1, g.p2]))].sort());
    }
    // the deck pair a seed plays is the same whoever the opponent is: results against each compare directly
    assert.deepStrictEqual(jobs[0].decks, jobs[1].decks);
    assert.notDeepStrictEqual(jobs[0].decks, jobs[2].decks);
});

// filled by the run below, read by the tests after it
let RUN = null;

test('a Python bot that reads hello.cards plays through the harness: recorded, reported, never sent anywhere, and the same again', { skip: NEEDS_PLAY, timeout: 600000 }, async () => {
    const bot = folder('cards-bot', { 'bot.py': PY_BOT });
    // a window that counts what reaches it, with a token in the caller's environment and NODE_ENV=production
    let requests = 0;
    const server = http.createServer((req, res) => {
        requests++;
        res.end('{}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const hook = path.join(tmp, 'loaded-hook.js');
    const loaded = path.join(tmp, 'loaded.json');
    fs.writeFileSync(hook, `process.on('exit', () => require('fs').writeFileSync(${JSON.stringify(loaded)}, JSON.stringify(Object.keys(require.cache))));\n`);
    const hostile = {
        ...BASE_ENV, SWU_WINDOW: `http://127.0.0.1:${server.address().port}`, ARENA_PUSH_TOKEN: 'push-token', SWU_WINDOW_TOKEN: 'window-token', NODE_ENV: 'production',
        NODE_OPTIONS: `--require ${hook}`
    };
    const out1 = path.join(tmp, 'cards-run-1');
    // a builder's bot: @cards-bot's builder name is cards_bot
    const r = await runDev([bot, '--owner', 'cards-bot', '--vs', 'rush', '--games', '2', '--seed', '3', '--out', out1], { env: hostile });
    server.close();
    assert.strictEqual(r.code, 0, r.out + r.err);
    assert.strictEqual(requests, 0, 'nothing reached the window');
    const mods = readJson(loaded).map((f) => path.relative(ROOT, f));
    assert.ok(mods.includes('bot/dev.js') && !mods.some((f) => /^bot\/(arena\/push|ladder)\.js$/.test(f)), 'neither arena/push.js nor ladder.js loads');

    // the report
    assert.match(r.out, /cards_bot-v1: python, 1 file \(.*\) from \S*cards-bot, as @cards-bot's arena_submit sends it/);
    assert.match(r.out, /card data [0-9a-f]{64} \(the games machine's CARDS_SHA when they match\)/);
    assert.match(r.out, /packed and start-checked by the arena's checker in [\d.]+ s: bundle [0-9a-f]{64}/);
    assert.match(r.out, /\[2\/2\] cards_bot-v1-vs-rush-3: /);
    assert.match(r.out, /cards_bot-v1 vs\s+games\s+W-L-D\s+bot faults\s+no result\s+think mean\/max \(cap 60 s\)/);
    assert.match(r.out, /\nrush\s+2\s+\d-\d-\d\s+0\s+/);
    assert.match(r.out, /node \S*bot\/dev\.js --view /);

    // the files
    const doc = readJson(path.join(out1, 'run.json'));
    assert.deepStrictEqual([doc.schema, doc.status, doc.bot.kind, doc.bot.entry, doc.games.length, doc.seeds.first, doc.limits.capMs], ['swu-dev-run/1', 'done', 'python', 'bot.py', 2, 3, 60000]);
    assert.deepStrictEqual(doc.games.map((g) => g.id), ['rush-vs-cards_bot-v1-3', 'cards_bot-v1-vs-rush-3']);
    assert.ok(fs.existsSync(path.join(out1, 'bundles', `${doc.bot.bundle}.tar`)));
    // the arena.json the arena builds for @cards-bot's submission: a Python bot's bundle id is the arena's
    const manifest = readJson(path.join(out1, 'check', 'cards_bot', 'bundle', 'arena.json'));
    assert.deepStrictEqual([manifest.name, manifest.build.source], ['cards_bot', 'submitted by github:cards-bot']);
    assert.strictEqual(doc.versions.cards, dev.cardsSha());
    assert.strictEqual(doc.seeds.random, false);
    const index = readJson(path.join(out1, 'index.json'));
    assert.deepStrictEqual(index.games.map((g) => g.id), doc.games.map((g) => g.id));
    const ladder = readJson(path.join(out1, 'ladder.json'));
    assert.deepStrictEqual([ladder.schema, ladder.config.format, ladder.config.vs, ladder.progress.finished], ['swu-ladder/1', 'gauntlet', ['cards_bot-v1'], 2]);
    for (const g of doc.games) {
        const end = JSON.parse(lines(path.join(out1, 'games', `${g.id}.jsonl`)).at(-1));
        assert.strictEqual(end.t, 'end');
        assert.match(end.key, /^[0-9a-f]{64}$/, 'the game key on the end line');
        assert.strictEqual(end.key, g.result.key);
        const seat = g.p1 === 'cards_bot-v1' ? 'p1' : 'p2';
        const prefix = path.join(out1, 'bots', `${g.id}.${seat}`);
        assert.match(fs.readFileSync(`${prefix}.stderr`, 'utf8'), /^cards: \d{2,}, a /, 'the bot read hello.cards; its stderr is kept');
        assert.ok(readJson(`${prefix}.host.json`).replies > 0, 'the sandbox\'s stats');
        if (g.result.winner !== 'cards_bot-v1') {
            const sent = lines(`${prefix}.in.jsonl`);
            const got = lines(`${prefix}.out.jsonl`);
            assert.strictEqual(got.length, sent.length, 'line k of .out answers line k of .in');
            assert.strictEqual(JSON.parse(sent[0]).t, 'hello');
            assert.ok(JSON.parse(sent[0]).cards.length > 10);
            assert.deepStrictEqual(JSON.parse(got[0]), { t: 'ready', v: 2 });
        } else {
            assert.ok(!fs.existsSync(`${prefix}.in.jsonl`), 'a won game keeps no protocol lines');
        }
        assert.ok(!fs.readdirSync(path.join(out1, 'bots')).some((f) => f.includes('.p') && !f.includes(`.${seat}.`) && f.startsWith(g.id)), 'rush is in process: no files');
    }
    const trace = spawnSync(process.execPath, [path.join(ROOT, 'bot', 'trace.js'), 'check', path.join(out1, 'games')], { encoding: 'utf8', env: BASE_ENV, timeout: 300000 });
    assert.strictEqual(trace.status, 0, trace.stdout + trace.stderr);

    // again, from a plain environment: the same games
    const out2 = path.join(tmp, 'cards-run-2');
    const again = await runDev([bot, '--owner', 'cards-bot', '--vs', 'rush', '--games', '2', '--seed', '3', '--out', out2]);
    assert.strictEqual(again.code, 0, again.out + again.err);
    const doc2 = readJson(path.join(out2, 'run.json'));
    assert.strictEqual(doc2.bot.bundle, doc.bot.bundle, 'a Python bot packs to the same bundle');
    assert.deepStrictEqual(doc2.games.map((g) => played(g.result)), doc.games.map((g) => played(g.result)));
    for (const g of doc.games) {
        assert.ok(fs.readFileSync(path.join(out2, 'games', `${g.id}.jsonl`)).equals(fs.readFileSync(path.join(out1, 'games', `${g.id}.jsonl`))), `${g.id}: the same replay`);
    }
    RUN = { dir: out1, doc };
});

test('play-seed writes no transcript unless asked, and plays the same games either way', { skip: NEEDS_PLAY, timeout: 300000 }, async (t) => {
    if (!RUN) {
        return t.skip('needs the run above');
    }
    const { seedJob } = require('../arena/play-seed');
    const { roundLimits } = require('../game-pool');
    const { gameKey } = require('../rng');
    const decks = require('../arena/referee').roundDeckLists();
    const games = dev.schedule('cards_bot-v1', ['rush'], 2, 3, decks.lists.length);
    const job = seedJob(3, games, { key: gameKey(crypto.createHash('sha256').update('swu-dev:3').digest('hex').slice(0, 32), 3), limits: roundLimits(60000),
        bots: { 'cards_bot-v1': { kind: 'wasm', bundle: RUN.doc.bot.bundle }, rush: { kind: 'resident' } }, decks: decks.lists });
    const play = (name, extra) => {
        const work = path.join(tmp, name);
        fs.mkdirSync(work, { recursive: true });
        fs.writeFileSync(path.join(work, 'job.json'), JSON.stringify(job));
        const r = spawnSync(process.execPath, [path.join(ROOT, 'bot', 'arena', 'play-seed.js'), '--job', path.join(work, 'job.json'), '--bundles', path.join(RUN.dir, 'bundles'), '--work', work],
            { encoding: 'utf8', timeout: 300000, env: { ...dev.childEnv(work), ...extra } });
        assert.strictEqual(r.status, 0, r.stderr);
        return { work, doc: JSON.parse(r.stdout.trim().split('\n').pop()) };
    };
    const logs = path.join(tmp, 'tap-logs');
    fs.mkdirSync(logs);
    const off = play('tap-off', {});
    const on = play('tap-on', { SWU_BOT_LOG: logs });
    const files = (d) => fs.readdirSync(d, { recursive: true }).map(String);
    assert.ok(!files(off.work).some((f) => /\.(in|out)\.jsonl$|\.stderr$|\.host\.json$/.test(f)), 'no transcript without SWU_BOT_LOG');
    assert.ok(files(logs).some((f) => f.endsWith('.in.jsonl')), 'with it, the bot\'s transcript');
    assert.deepStrictEqual(on.doc.results.map((x) => played(x.result)), off.doc.results.map((x) => played(x.result)));
    assert.deepStrictEqual(off.doc.results.map((x) => played(x.result)), RUN.doc.games.map((g) => played(g.result)), 'and the harness played these games');
    for (const g of job.games) {
        assert.ok(fs.readFileSync(on.doc.replays[g.id]).equals(fs.readFileSync(off.doc.replays[g.id])), g.id);
    }
});

test('--view serves the run\'s index, replays and the viewer kit on 127.0.0.1 only, and nothing else', { skip: NEEDS_PLAY, timeout: 60000 }, async (t) => {
    if (!RUN) {
        return t.skip('needs the run above');
    }
    const child = spawn(process.execPath, [DEV, '--view', RUN.dir, '--port', '0'], { env: BASE_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill('SIGKILL'));
    const base = await new Promise((resolve, reject) => {
        let out = '';
        child.stdout.on('data', (d) => {
            out += d;
            const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out);
            if (m) {
                resolve(m[0]);
            }
        });
        child.on('exit', (code) => reject(new Error(`exited ${code}: ${out}`)));
    });
    const get = async (p, init) => {
        const r = await fetch(new URL(p, base), init);
        return { status: r.status, type: r.headers.get('content-type'), text: await r.text() };
    };
    const page = await get('/');
    assert.strictEqual(page.status, 200);
    assert.match(page.text, /<script src="\/kit\.js"><\/script>/);
    assert.match(page.text, /SWUViewer\.mount\(/);
    assert.deepStrictEqual(JSON.parse((await get('/index.json')).text).games.map((g) => g.id), RUN.doc.games.map((g) => g.id));
    const kit = await get('/kit.js');
    assert.strictEqual(kit.status, 200);
    assert.ok(kit.text.length > 100000 && kit.text.includes('SWUViewer'));
    const id = RUN.doc.games[0].id;
    const replay = await get(`/games/${id}.jsonl`);
    assert.strictEqual(replay.status, 200);
    assert.strictEqual(replay.text, fs.readFileSync(path.join(RUN.dir, 'games', `${id}.jsonl`), 'utf8'));
    for (const p of ['/games/..%2Frun.jsonl', '/games/%2e%2e%2findex.jsonl', '/games/nope.jsonl', '/run.json', '/games/../run.json', '/bots/']) {
        assert.strictEqual((await get(p)).status, 404, p);
    }
    assert.strictEqual((await get('/', { method: 'POST' })).status, 405);
});

test('a bot\'s faults are its losses, reported once per kind with the game, the step, its last lines and how to send it the game again (exit 1)', { skip: NEEDS_PLAY, timeout: 600000 }, async () => {
    const cases = {
        garbage: { code: faultyBot(5, 'sys.stderr.write("about to answer garbage\\n")\nprint("this is not json", flush=True)\ncontinue'), args: [] },
        quits: { code: faultyBot(4, 'sys.stderr.write("leaving\\n")\nsys.exit(3)'), args: [] },
        index: { code: faultyBot(3, BAD_INDEX(0)), args: [] },
        slow: { code: faultyBot(3, 'time.sleep(12)'), args: ['--cap-sec', '10'] }
    };
    const runs = await Promise.all(Object.entries(cases).map(async ([name, c]) => {
        // a folder whose name has a space: the printed commands still paste
        const bot = folder(`fault ${name}`, { 'bot.py': c.code });
        const out = path.join(tmp, `fault-${name}-run`);
        return [name, bot, out, await runDev([bot, '--owner', `fault-${name}`, '--vs', 'rush', '--games', '2', '--jobs', '1', '--out', out, ...c.args])];
    }));
    for (const [name, bot, out, r] of runs) {
        assert.strictEqual(r.code, 1, `${name}: ${r.out}${r.err}`);
        const doc = readJson(path.join(out, 'run.json'));
        assert.strictEqual(doc.seeds.random, true, 'no --seed: a random one');
        assert.match(r.out, new RegExp(`seeds (\\d+)-\\1 \\(random: --seed \\1 deals these games again\\)`));
        const mine = doc.failures.filter((f) => f.bot === `fault_${name}-v1`);
        assert.strictEqual(mine.length, 2, `${name}: both games lost by its fault\n${r.out}`);
        assert.strictEqual(mine[1].like, mine[0].game, `${name}: the same fault`);
        const s = doc.seeds.first;
        assert.match(r.out, new RegExp(`exit 1: fault_${name}-v1 lost 2 games by its own fault`));
        assert.match(r.out, /Games lost by a fault \(2, 1 kind\)/);
        assert.match(r.out, new RegExp(`rush-vs-fault_${name}-v1-${s}: fault_${name}-v1 \\(p2, deck [a-z0-9_-]+ vs [a-z0-9_-]+\\) lost by \\w+ at step \\d+, round \\d+`));
        assert.match(r.out, new RegExp(`\\n  and 1 more game like it: fault_${name}-v1-vs-rush-${s}\\n`));
        assert.ok(!r.out.includes(`\nfault_${name}-v1-vs-rush-${s}: `), 'a fault like the first is not reported again');
        for (const f of mine) {
            assert.ok(f.files.some((x) => x.endsWith('.in.jsonl')) && f.files.some((x) => x.startsWith('games/')), `${name}: ${f.files}`);
        }
        const f = mine[0];
        // the printed command sends the game to the folder again, pasted as it is
        const again = /\n {2}again: {2}(.+)\n/.exec(r.out)?.[1];
        assert.ok(again?.includes(`'${path.basename(bot)}' --owner fault-${name} --again `), `${name}: ${again}`);
        if (name === 'garbage') {
            assert.strictEqual(f.faultKind, 'error');
            assert.match(f.error, /reply is not JSON: this is not json/);
            assert.deepStrictEqual(f.exchanges.at(-1).reply, 'this is not json');
            assert.strictEqual(JSON.parse(f.exchanges.at(-1).sent).seq, 5, 'its fifth decision');
            assert.match(r.out, /referee: decide 5, [\d.]+ s left, "[^"]*", \d+ actions\n {2}bot: {5}this is not json/);
            assert.match(r.out, /stderr \(last 1 lines\):\n {4}about to answer garbage/);
            // sent again to the bot as it is: the same replies, the garbage included (exit 1); fixed: exit 0
            const same = spawnSync('bash', ['-c', again], { cwd: tmp, encoding: 'utf8', env: BASE_ENV, timeout: 120000 });
            assert.strictEqual(same.status, 1, same.stdout + same.stderr);
            assert.match(same.stdout, /every reply is the one recorded in the run\n {2}reply \d+ loses the game: this is not json/);
            fs.writeFileSync(path.join(bot, 'bot.py'), faultyBot(5, 'sys.stderr.write("fixed\\n")'));
            const fixed = spawnSync('bash', ['-c', again], { cwd: tmp, encoding: 'utf8', env: BASE_ENV, timeout: 120000 });
            assert.strictEqual(fixed.status, 0, fixed.stdout + fixed.stderr);
            assert.match(fixed.stdout, /the first \d+ replies are the ones recorded in the run\n {2}message \d+: decide 5, .*\n {4}was: this is not json\n {4}now: \{"t": "act", "i": 0\}/);
            assert.match(fixed.stdout, /stderr \(last 1 lines\):\n {4}fixed/);
        } else if (name === 'index') {
            assert.match(f.error, /expected \{"t":"act","i":0\.\.(\d+)\}, got \{"t":"act","i":(\d+)\}/);
            // the same replies: the bad one is found, and the game would go the same way (exit 1)
            const same = spawnSync('bash', ['-c', again], { cwd: tmp, encoding: 'utf8', env: BASE_ENV, timeout: 120000 });
            assert.strictEqual(same.status, 1, same.stdout + same.stderr);
            assert.match(same.stdout, /every reply is the one recorded in the run\n {2}reply 4 loses the game: \{"t": "act", "i": \d+\}/);
            assert.match(same.stdout, /the game was lost by error after these same replies, so it would go the same way again/);
            // another reply, still out of range: the reply loses the game (exit 1)
            fs.writeFileSync(path.join(bot, 'bot.py'), faultyBot(3, BAD_INDEX(1)));
            const other = spawnSync('bash', ['-c', again], { cwd: tmp, encoding: 'utf8', env: BASE_ENV, timeout: 120000 });
            assert.strictEqual(other.status, 1, other.stdout + other.stderr);
            assert.match(other.stdout, /the first 3 replies are the ones recorded in the run\n/);
            assert.match(other.stdout, /reply 4 loses the game: \{"t": "act", "i": \d+\}/);
            assert.ok(!other.stdout.includes('so it would go the same way again'), other.stdout);
        } else if (name === 'quits') {
            assert.strictEqual(f.faultKind, 'error');
            assert.match(f.error, /exited \(code 3/);
            assert.strictEqual(f.exchanges.at(-1).reply, null);
            assert.match(r.out, /bot: {5}\(no reply\)/);
            assert.deepStrictEqual(f.stderr, ['leaving']);
        } else {
            assert.strictEqual(f.faultKind, 'time');
            assert.ok(f.think >= 10000, `think ${f.think}`);
            assert.match(r.out, /lost by time at step \d+, round \d+, after 10\.\d s of its 10 s/);
            assert.match(r.out, /warning: in 2 games fault_slow-v1 used more than half its thinking time/);
            // its replies come late, but come: again cannot judge time, and says so (exit 1)
            const late = spawnSync('bash', ['-c', again], { cwd: tmp, encoding: 'utf8', env: BASE_ENV, timeout: 180000 });
            assert.strictEqual(late.status, 1, late.stdout + late.stderr);
            // the command that plays the run again: its limits and seed, and no --out
            const rerun = new RegExp(`the game was lost by time, and --again sends its messages with no clock, so it cannot say whether the bot is in time now: play the run again for that: (.+)\n`).exec(late.stdout)?.[1];
            assert.ok(rerun?.endsWith(` '${bot}' --owner fault-slow --vs rush --games 2 --jobs 1 --cap-sec 10 --seed ${s}`), rerun);
        }
    }
});

test('a bot that keeps losing the same way stops the run early, unless --all', { skip: NEEDS_PLAY, timeout: 600000 }, async () => {
    // its message changes every game (and is no number): the faults are still alike
    const bot = folder('early-bot', { 'bot.py': faultyBot(1, 'import hashlib\nraise RuntimeError("boom " + hashlib.sha256(line.encode()).hexdigest()[:12])') });
    const args = [bot, '--owner', 'early', '--vs', 'rush,heuristic', '--games', '4', '--seed', '11', '--jobs', '1'];
    const [stopped, all] = await Promise.all([runDev([...args, '--out', path.join(tmp, 'early-run')]), runDev([...args, '--all', '--out', path.join(tmp, 'early-all-run')])]);
    assert.strictEqual(stopped.code, 1, stopped.out);
    const doc = readJson(path.join(tmp, 'early-run', 'run.json'));
    assert.strictEqual(doc.status, 'halted');
    assert.strictEqual(doc.games.length, 2 * dev.SAME_FAULT - 2, 'two jobs of two games: the second brings it to SAME_FAULT');
    assert.match(stopped.out, /stopped early: 4 games of early-v1 went wrong the same way \(.*\)\. Fix that, or give --all to play every game anyway\./);
    assert.match(stopped.out, /exit 1: early-v1 lost 4 games by its own fault; 4 games not played \(stopped early\)/);
    assert.match(stopped.out, /RuntimeError: boom [0-9a-f]{12}/);
    const messages = new Set(readJson(path.join(tmp, 'early-run', 'run.json')).failures.map((f) => f.stderr.at(-1)));
    assert.strictEqual(messages.size, 4, 'four messages, one kind');
    assert.strictEqual(all.code, 1, all.out);
    assert.strictEqual(readJson(path.join(tmp, 'early-all-run', 'run.json')).games.length, 8);
    assert.match(all.out, /Games lost by a fault \(8, 1 kind\)/);
});

// A Python bot that never finishes a game: it clicks the first card it can, so it takes back its own choice forever
const LOOP_BOT = `import json, sys
for line in sys.stdin:
    msg = json.loads(line)
    t = msg["t"]
    if t == "hello":
        reply = {"t": "ready", "v": 2}
    elif t == "decide":
        cards = [a for a in msg["actions"] if a["kind"] == "card"]
        reply = {"t": "act", "i": (cards or msg["actions"])[0]["i"]}
    elif t == "over":
        reply = {"t": "ok"}
    else:
        continue
    print(json.dumps(reply), flush=True)
`;

test('a game the bot never finishes is a failure: shown like a fault, one whole transcript kept, the rest their ends (exit 1)', { skip: NEEDS_PLAY, timeout: 600000 }, async () => {
    const bot = folder('loop-bot', { 'bot.py': LOOP_BOT });
    const out = path.join(tmp, 'loop-run');
    const r = await runDev([bot, '--owner', 'loop', '--vs', 'rush', '--games', '2', '--seed', '5', '--out', out]);
    assert.strictEqual(r.code, 1, r.out + r.err);
    assert.match(r.out, /\nGames with no result \(2, 1 kind\)\n/);
    assert.match(r.out, /: no result \(STEP_CAP\) at step 6000, round 0, loop-v1 as p\d, deck \S+ vs \S+: 6000 decisions and no end/);
    assert.match(r.out, /referee: decide \d+, [\d.]+ s left, "[^"]*", \d+ actions\n {2}bot: {5}\{"t": "act", "i": \d+\}\n/);
    assert.match(r.out, /\n {2}and 1 more game like it: /);
    assert.match(r.out, /\nexit 1: 2 games with no result\n/);
    const doc = readJson(path.join(out, 'run.json'));
    const [first, second] = doc.failures;
    assert.deepStrictEqual([first.outcome, first.bot, first.transcript, second.like, second.transcript], ['STEP_CAP', 'loop-v1', undefined, first.game, 'end']);
    const transcript = (f, ext) => lines(path.join(out, 'bots', `${f.game}.${f.seat}.${ext}`));
    assert.strictEqual(JSON.parse(transcript(first, 'in.jsonl')[0]).t, 'hello', 'the game shown keeps its whole transcript');
    assert.ok(transcript(first, 'in.jsonl').length > 1000);
    assert.deepStrictEqual([transcript(second, 'in.jsonl').length, transcript(second, 'out.jsonl').length], [20, 20], 'the other only its end');
    const again = /\n {2}again: {2}(.+)\n/.exec(r.out)?.[1];
    assert.ok(again?.endsWith(`${first.game}.${first.seat}.in.jsonl`), again);
    // sent again to the bot as it is: every reply is a legal one, and the same, so the game would again have no result
    const same = spawnSync('bash', ['-c', again], { cwd: tmp, encoding: 'utf8', env: BASE_ENV, timeout: 180000 });
    assert.strictEqual(same.status, 1, same.stdout + same.stderr);
    assert.match(same.stdout, /every reply is the one recorded in the run\n/);
    assert.match(same.stdout, /the game ended with no result \(STEP_CAP\) after these same replies, so it would go the same way again/);
    assert.ok(!same.stdout.includes('loses the game'), same.stdout);
});

test('JavaScript: an error names the bot\'s own file and line, and a stdio.js of its own is replaced', { skip: (!PLAYS || !JAVY) && 'needs the engine, the sandbox and Javy', timeout: 600000 }, async () => {
    const serveBot = "const { serve } = require('./stdio');\nconst { pick } = require('./pick');\nlet n = 0;\nserve({\n    hello() { n = 0; return { t: 'ready', v: 2 }; },\n    decide(msg) { n++; return { t: 'act', i: pick(msg.actions, n) }; }\n});\n";
    const syntax = folder('js-syntax', { 'bot.js': serveBot, 'pick.js': 'function pick(actions) {\n    return actions[0].i +;\n}\nmodule.exports = { pick };\n' });
    const thrown = folder('js-throws', {
        'bot.js': serveBot, 'stdio.js': 'module.exports = {};\n',
        'pick.js': '// picks the first action\nfunction pick(actions, n) {\n    if (n === 3) {\n        throw new Error(`no pick at ${n}`);\n    }\n    return actions[0].i;\n}\nmodule.exports = { pick };\n'
    });
    const [a, b] = await Promise.all([runDev([syntax, '--house', '--games', '0']), runDev([thrown, '--house', '--vs', 'rush', '--games', '2', '--seed', '2'])]);
    assert.strictEqual(a.code, 3, a.out);
    assert.match(a.out, /Javy could not compile it:\n.*unexpected token.*\n\s*at pick\.js:2:\d+/);
    assert.strictEqual(b.code, 1, b.out);
    assert.match(b.out, /warning: the arena replaces stdio\.js with its own serve\(\); a helper of yours there needs another name/);
    assert.match(b.out, /packed and start-checked .*: bundle [0-9a-f]{64} \(this build: Javy's differ by a few bytes each time; the script it compiled is [0-9a-f]{64}\)/);
    assert.match(b.out, /error: no pick at 3 \(at pick\.js:4:\d+\)/);
    assert.match(b.out, /stderr \(last \d+ lines\):\n {4}Error: no pick at 3\n\s+at pick \(pick\.js:4:\d+\)\n\s+at decide \(bot\.js:6:\d+\)/);
});

test('Ctrl-C stops the check or every game and leaves a stopped run; after a SIGKILL the games stop by themselves', { skip: (!NEEDS_PLAY && !PROC) ? 'needs /proc' : NEEDS_PLAY, timeout: 300000 }, async () => {
    // one bot answers hello after 20 s (the check's limit is 30 s), one takes 40 s at decision 2: each is still busy
    // when the signal comes
    const slowHello = folder('slow-hello-bot', { 'bot.py': `import time\ntime.sleep(20)\n${PY_BOT}` });
    const slowGame = folder('slow-game-bot', { 'bot.py': faultyBot(2, 'time.sleep(40)') });
    const checking = (cmds) => cmds.some((c) => c.includes('intake.js') && c.includes('--check')) && cmds.some((c) => c.includes('run.py'));
    const playing = (cmds) => cmds.some((c) => c.includes('play-seed.js') && c.includes('--job')) && cmds.some((c) => c.includes('run.py'));
    const play = async (name, bot, busy, signal) => {
        const run = path.join(tmp, name);
        let child = null;
        const done = runDev([bot, '--house', '--vs', 'rush', '--games', '2', '--jobs', '1', '--out', run], { started: (c) => (child = c) });
        assert.ok(await until(() => busy(runProcesses(run).map((p) => p.cmd)), 120000), `${name}: never busy`);
        child.kill(signal);
        const r = await done;
        // the check has no watch of its own on the harness (only play-seed does): only the harness's own kill ends it
        const left = await until(() => !runProcesses(run).length, 15000);
        return { run, r, left };
    };
    const [check, game, kill] = await Promise.all([
        play('signal-check', slowHello, checking, 'SIGINT'), play('signal-game', slowGame, playing, 'SIGINT'), play('signal-kill', slowGame, playing, 'SIGKILL')
    ]);
    for (const [x, want] of [[check, /stopped \(SIGINT\) while checking/], [game, /stopped \(SIGINT\) after 0 of 2 games/]]) {
        assert.strictEqual(x.r.code, 130, x.r.out + x.r.err);
        assert.ok(x.left, `nothing of the run is left running: ${JSON.stringify(runProcesses(x.run))}`);
        assert.strictEqual(readJson(path.join(x.run, 'run.json')).status, 'stopped');
        assert.match(x.r.out, want);
    }
    assert.strictEqual(kill.r.signal, 'SIGKILL');
    assert.ok(kill.left, `play-seed and the bots stop once the harness is gone: ${JSON.stringify(runProcesses(kill.run))}`);
});

test('a bot the intake refuses: its words, word for word, and no games (exit 3)', { skip: (!WASMTIME || !ENGINE) && 'needs wasmtime for Python and the engine\'s card data', timeout: 300000 }, async () => {
    // a WebAssembly program that never writes anything, as a bundle; and the same asking for the card data as files
    const wat = '(module (memory (export "memory") 1) (func (export "_start") (loop $l (br $l))))';
    const bundle = (name, cards) => {
        const d = path.join(tmp, name);
        fs.mkdirSync(d, { recursive: true });
        const make = 'import sys, json, hashlib, wasmtime\nb = wasmtime.wat2wasm(sys.stdin.read())\nopen(sys.argv[1] + "/bot.wasm", "wb").write(b)\n'
            + 'm = {"schema": "swu-arena-bot/1", "name": "x", "lang": "wat", "protocol": 2, "kind": "wasm", "platform": "wasm32-wasip1",'
            + ' "runtime": "wasi-p1", "run": {"cmd": "./bot.wasm", "args": [], "env": {}}, "entry_sha256": hashlib.sha256(b).hexdigest(),'
            + ' "resources": {"memory_mb": 64}, "network": "none"}\n'
            + (cards ? 'm["cards"] = {"use": "mount", "layout": "dir", "env": {"SWU_CARD_JSON": "/cards"}}\n' : '')
            + 'json.dump(m, open(sys.argv[1] + "/arena.json", "w"))\n';
        const r = spawnSync('python3', ['-c', make, d], { input: wat, encoding: 'utf8', env: { PATH: dev.childEnv(tmp).PATH } });
        assert.strictEqual(r.status, 0, r.stderr);
        return d;
    };
    const { NO_CARD_FILES } = require('../arena/api');
    const cases = [
        ['mounts', bundle('mounts', true), (out) => assert.ok(/mounts-v1 \(\S*mounts\): the arena would refuse it:\n/.test(out) && out.includes(`the arena would refuse it:\n${NO_CARD_FILES}\n`), out)],
        ['silent', bundle('silent', false), (out) => assert.match(out, /silent-v1 \(.*\): the arena would refuse it:\nsilent-v1 failed the start check \(start the bundle in the sandbox, send hello, expect ready\): exit code 1\nno reply to hello within 30000 ms/)],
        ...(JAVY && PYWASI ? [['broken', folder('broken', { 'bot.js': 'const { serve } = require(\'./stdio\');\nserve({ decide(msg) { return { t: \'act\', i: 0 } }\n' }),
            (out) => assert.match(out, /broken-v1 \(.*\): the arena would refuse it:\nJavy could not compile it:\n/)]] : [])
    ];
    const runs = await Promise.all(cases.map(([name, dir]) => runDev([dir, '--house', '--games', '2', '--out', path.join(tmp, `${name}-run`)])));
    for (const [k, [name, , check]] of cases.entries()) {
        const r = runs[k];
        assert.strictEqual(r.code, 3, `${name}: ${r.out}${r.err}`);
        check(r.out);
        assert.ok(!fs.existsSync(path.join(tmp, `${name}-run`, 'games')), `${name}: no games`);
        assert.strictEqual(readJson(path.join(tmp, `${name}-run`, 'run.json')).status, 'refused');
    }
});
