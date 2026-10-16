'use strict';
// The bot dev harness (bot/dev.js): how it reads a bot folder, the deal and the jobs it builds, real runs of small
// Python bots through the arena's checker and play-seed.js (recorded, reported, played again the same), the faults it
// reports, the intake's refusals, the transcript tap, the viewer, and that it never sends anything anywhere. Each part
// skips when its piece is missing: the built engine and card data, wasmtime for Python, CPython for WASI, Javy.
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

/** Runs bot/dev.js; resolves to {code, out, err}. Async, so a server in this process can answer while it runs. */
function runDev(args, { env = BASE_ENV, cwd = tmp } = {}) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [DEV, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (err += d));
        child.on('close', (code) => resolve({ code, out, err }));
    });
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
    const o = dev.parseArgs(['mybot', '--games', '3', '--vs', 'heuristic, ../v1', '--cap-sec=30']);
    assert.deepStrictEqual([o.games, o.vs, o.capSec, o.seed, o.entry], [4, ['heuristic', '../v1'], 30, 1, null], 'games made even');
    assert.strictEqual(dev.parseArgs(['--view', 'r']).port, 0);
    for (const bad of [['a', '--cap-sec', '5'], ['a', '--games', '-2'], ['a', '--bogus', '1'], [], ['a', 'b'], ['a', '--seed']]) {
        assert.throws(() => dev.parseArgs(bad), (e) => e.constructor.name === 'Usage', bad.join(' '));
    }
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
});

test('usage: an --out the bot would be packed with, an opponent the arena does not play, a missing folder (exit 2)', async () => {
    const bot = folder('usage-bot', { 'bot.py': PY_BOT });
    const cases = [
        [[bot, '--out', path.join(bot, 'runs')], /inside .*usage-bot, so the arena would get it with the bot: put it under a dot folder/],
        [[bot, '--vs', 'aggro'], /--vs aggro: the opponents are heuristic, rush, random, or a bot folder/],
        [[bot, '--vs', 'rush,rush'], /names rush twice/],
        [[path.join(tmp, 'no-such-bot')], /no such file or folder/],
        [[bot, '--owner', 'Not A Login'], /--owner/]
    ];
    for (const [args, want] of cases) {
        const r = await runDev(args);
        assert.strictEqual(r.code, 2, `${args.join(' ')}: ${r.out}${r.err}`);
        assert.match(r.out, want);
    }
    assert.ok(!fs.existsSync(path.join(bot, 'runs')) && !fs.existsSync(path.join(bot, '.runs')), 'no run folder');
});

test('a builder\'s bot is held to arena_submit\'s limits (exit 3); a house submission is only warned', async () => {
    const big = folder('big-bot', { 'bot.py': PY_BOT, 'weights.bin': Buffer.alloc(3.1e6, 1) });
    const r = await runDev([big, '--owner', 'ana', '--games', '0', '--out', path.join(tmp, 'big-run')]);
    assert.strictEqual(r.code, 3, r.out + r.err);
    assert.match(r.out, /^big_bot-v1 \(.*big-bot\): arena_submit would refuse it:\nfiles: at most 3 MB in all\n$/);
    assert.ok(!fs.existsSync(path.join(tmp, 'big-run')));
    const { submitFiles } = require('../arena/window');
    const { houseDoc } = require('../arena/ops/house-submit');
    assert.throws(() => submitFiles(houseDoc('big_bot', big, { note: 'n', entry: 'bot.py' })), /at most 3 MB/);
    fs.writeFileSync(path.join(big, 'weights.bin'), Buffer.alloc(2e6, 1));
    assert.doesNotThrow(() => submitFiles(houseDoc('big_bot', big, { note: 'n', entry: 'bot.py' })));
});

test('a missing sandbox stops the harness with exit 2 and says npm run setup', { skip: fs.existsSync(path.join(ROOT, 'build', 'compiled', 'venv')) && 'the sandbox\'s virtualenv comes first on PATH' }, async () => {
    const bin = folder('fake-bin', { python3: '#!/bin/sh\nexit 1\n' });
    fs.chmodSync(path.join(bin, 'python3'), 0o755);
    const bot = folder('nosandbox-bot', { 'bot.py': PY_BOT });
    const r = await runDev([bot, '--out', path.join(tmp, 'nosandbox-run')], { env: { ...BASE_ENV, PATH: `${bin}${path.delimiter}${BASE_ENV.PATH}` } });
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
    const r = await runDev([bot, '--vs', 'rush', '--games', '2', '--seed', '3', '--out', out1], { env: hostile });
    server.close();
    assert.strictEqual(r.code, 0, r.out + r.err);
    assert.strictEqual(requests, 0, 'nothing reached the window');
    const mods = readJson(loaded).map((f) => path.relative(ROOT, f));
    assert.ok(mods.includes('bot/dev.js') && !mods.some((f) => /^bot\/(arena\/push|ladder)\.js$/.test(f)), 'neither arena/push.js nor ladder.js loads');

    // the report
    assert.match(r.out, /cards_bot-v1: python, 1 file/);
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
    assert.ok(fs.existsSync(path.join(out1, 'check', 'cards_bot', 'bundle', 'arena.json')), 'the arena.json the arena would build');
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
    const again = await runDev([bot, '--vs', 'rush', '--games', '2', '--seed', '3', '--out', out2]);
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

test('a bot\'s faults are its losses, reported with the game, the step and its last lines (exit 1)', { skip: NEEDS_PLAY, timeout: 600000 }, async () => {
    const cases = {
        garbage: { code: faultyBot(5, 'sys.stderr.write("about to answer garbage\\n")\nprint("this is not json", flush=True)\ncontinue'), args: [] },
        quits: { code: faultyBot(4, 'sys.stderr.write("leaving\\n")\nsys.exit(3)'), args: [] },
        slow: { code: faultyBot(3, 'time.sleep(12)'), args: ['--cap-sec', '10'] }
    };
    const runs = await Promise.all(Object.entries(cases).map(async ([name, c]) => {
        const bot = folder(`fault-${name}`, { 'bot.py': c.code });
        const out = path.join(tmp, `fault-${name}-run`);
        return [name, out, await runDev([bot, '--vs', 'rush', '--games', '2', '--jobs', '1', '--out', out, ...c.args])];
    }));
    for (const [name, out, r] of runs) {
        assert.strictEqual(r.code, 1, `${name}: ${r.out}${r.err}`);
        const doc = readJson(path.join(out, 'run.json'));
        const mine = doc.failures.filter((f) => f.bot === `fault_${name}-v1`);
        assert.strictEqual(mine.length, 2, `${name}: both games lost by its fault\n${r.out}`);
        assert.match(r.out, new RegExp(`exit 1: fault_${name}-v1 lost 2 games by its own fault`));
        assert.match(r.out, new RegExp(`fault_${name}-v1-vs-rush-1: fault_${name}-v1 \\(p1, deck [a-z0-9_-]+ vs [a-z0-9_-]+\\) lost by \\w+ at step \\d+, round \\d+`));
        for (const f of mine) {
            assert.ok(f.files.some((x) => x.endsWith('.in.jsonl')) && f.files.some((x) => x.startsWith('games/')), `${name}: ${f.files}`);
        }
        const f = mine[0];
        if (name === 'garbage') {
            assert.strictEqual(f.faultKind, 'error');
            assert.match(f.error, /reply is not JSON: this is not json/);
            assert.deepStrictEqual(f.exchanges.at(-1).reply, 'this is not json');
            assert.strictEqual(JSON.parse(f.exchanges.at(-1).sent).seq, 5, 'its fifth decision');
            assert.match(r.out, /referee: decide 5, [\d.]+ s left, "[^"]*", \d+ actions\n {2}bot: {5}this is not json/);
            assert.match(r.out, /stderr \(last 1 lines\):\n {4}about to answer garbage/);
            assert.match(r.out, /again: {2}\S*python3 -I \S*bot\/compiled\/run\.py \S+check\/fault_garbage\/bundle < \S+\.in\.jsonl/);
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
        }
    }
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
    const runs = await Promise.all(cases.map(([name, dir]) => runDev([dir, '--games', '2', '--out', path.join(tmp, `${name}-run`)])));
    for (const [k, [name, , check]] of cases.entries()) {
        const r = runs[k];
        assert.strictEqual(r.code, 3, `${name}: ${r.out}${r.err}`);
        check(r.out);
        assert.ok(!fs.existsSync(path.join(tmp, `${name}-run`, 'games')), `${name}: no games`);
        assert.strictEqual(readJson(path.join(tmp, `${name}-run`, 'run.json')).status, 'refused');
    }
});
