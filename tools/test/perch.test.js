'use strict';
// node --test tools/test/   (no network: a local server stands in for Jev)
const test = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { plan, inScope, readDay, holdLock, snapshotRepo, snapshotShared, appendNew, gitEnv } = require('../perch/policy');
const scopes = require('../perch/scope');

const preload = path.join(__dirname, '../perch/jev-cache.mjs');
const wrapper = path.join(__dirname, '../bin/perch');
const repo = path.resolve(__dirname, '../..');
// Run from a git hook, git's own variables would point every git call below at this repo.
const clean = gitEnv();
for (const name of Object.keys(process.env)) if (!(name in clean)) delete process.env[name];

/** A request body like perch's: one method's state and the questions about it. */
const ask = (state, ...questions) => JSON.stringify({ model: 'jev-test', state, questions: Object.fromEntries(questions.map((q) => [q, { type: 'noul' }])) });

/** A stand-in for Jev. It answers question "q" only, and refuses when the state mentions "refuse". */
async function fakeJev(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push(body);
      const type = body.includes('refuse') ? 'refusal' : 'noul';
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'jev-test', answers: { q: { type, noul: 0.3 } }, usage: { input_tokens: 10, output_tokens: 2 }, charge: { totalNanos: 5 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}/v1/systemone`, seen };
}

const scratch = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** Starts one process with the preload that POSTs each body in turn, then waits if `hold` is set. */
function start(url, dir, bodies, extra = {}, hold = false) {
  const script = `
    const out = [];
    for (const body of ${JSON.stringify(bodies)}) {
      const r = await fetch(${JSON.stringify(url)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      out.push({ status: r.status, text: await r.text() });
    }
    console.log(JSON.stringify(out));
    ${hold ? 'setInterval(() => {}, 1000);' : ''}`;
  const env = { PATH: process.env.PATH, PERCH_BASE_URL: url, PERCH_CACHE_DIR: path.join(dir, 'cache'), PERCH_USAGE_DIR: path.join(dir, 'usage'), CLAUDE_CODE_SESSION_ID: 'test', ...extra };
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, '--input-type=module', '-e', script], { env });
  child.out = '';
  child.err = '';
  child.stdout.on('data', (chunk) => (child.out += chunk));
  child.stderr.on('data', (chunk) => (child.err += chunk));
  child.done = new Promise((resolve) => child.on('close', resolve));
  return child;
}

async function run(url, dir, bodies, extra) {
  const child = start(url, dir, bodies, extra);
  assert.strictEqual(await child.done, 0, child.err);
  return { replies: JSON.parse(child.out), stderr: child.err };
}

const ledger = (dir) => {
  const day = fs.readdirSync(path.join(dir, 'usage'))[0];
  return readDay(path.join(dir, 'usage'), day).sort((a, b) => a.started.localeCompare(b.started) || a.pid - b.pid);
};

test('the same request is answered from the cache, with usage zeroed', async (t) => {
  const jev = await fakeJev(t);
  const dir = scratch(t);
  const first = await run(jev.url, dir, [ask(1, 'q')]);
  const second = await run(jev.url, dir, [ask(1, 'q'), ask(2, 'q')]);
  assert.strictEqual(jev.seen.length, 2, 'only state 2 is new');
  const [fresh, cached] = [JSON.parse(first.replies[0].text), JSON.parse(second.replies[0].text)];
  assert.deepStrictEqual(cached.answers, fresh.answers);
  assert.deepStrictEqual(cached.usage, { input_tokens: 0, output_tokens: 0 });
  assert.strictEqual(cached.charge, undefined);
  assert.match(second.stderr, /jev: 1 cached, 1 asked/);
});

test('--force asks again; refusals, missing answers and other requests are never cached', async (t) => {
  const jev = await fakeJev(t);
  const dir = scratch(t);
  await run(jev.url, dir, [ask(1, 'q'), ask('refuse', 'q'), ask(3, 'q', 'r')]);
  await run(jev.url, dir, [ask(1, 'q')], { PERCH_CACHE_READ: '0' });
  await run(jev.url, dir, [ask('refuse', 'q'), ask(3, 'q', 'r')]);
  assert.strictEqual(jev.seen.length, 6);
  const other = await run(jev.url.replace('systemone', 'other'), dir, [ask(1, 'q')], { PERCH_BASE_URL: jev.url });
  assert.strictEqual(other.replies[0].status, 200);
  assert.strictEqual(jev.seen.length, 7, 'a POST to another URL passes through');
  assert.strictEqual(other.stderr, '');
});

test('over budget, new requests get 409 and cached ones are still answered', async (t) => {
  const jev = await fakeJev(t);
  const dir = scratch(t);
  const capped = await run(jev.url, dir, [ask(1, 'q'), ask(2, 'q'), ask(3, 'q')], { PERCH_RUN_REQUESTS: '2' });
  assert.deepStrictEqual(capped.replies.map((r) => r.status), [200, 200, 409]);
  assert.match(capped.replies[2].text, /PERCH_RUN_REQUESTS/);
  const daily = await run(jev.url, dir, [ask(4, 'q'), ask(1, 'q')], { PERCH_DAILY_REQUESTS: '2' });
  assert.deepStrictEqual(daily.replies.map((r) => r.status), [409, 200]);
  assert.strictEqual(jev.seen.length, 2);
  assert.deepStrictEqual(ledger(dir).map((r) => [r.hits, r.asked, r.refused, r.exit]), [[0, 2, 1, 0], [1, 0, 1, 0]]);
  assert.strictEqual(ledger(dir)[0].input_tokens, 20);
});

test('a run still going counts toward the daily budget, and a killed run keeps its ledger', async (t) => {
  const jev = await fakeJev(t);
  const dir = scratch(t);
  const first = start(jev.url, dir, [ask(1, 'q')], {}, true);
  while (!first.out) await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await run(jev.url, dir, [ask(2, 'q')], { PERCH_DAILY_REQUESTS: '1' });
  assert.deepStrictEqual(second.replies.map((r) => r.status), [409]);
  first.kill('SIGTERM');
  assert.strictEqual(await first.done, 143);
  assert.deepStrictEqual(ledger(dir).map((r) => [r.asked, r.exit]), [[1, 143], [0, 0]]);
});

test('plan lists the in-scope files for scan and coverage, and keeps other commands as they are', () => {
  // A fake git: HEAD holds these files; since "base" only bot/env.js and bot/players/rush.js changed.
  const tree = ['bot/env.js', 'bot/players/index.js', 'bot/players/rush.js', 'bot/rust/src/main.rs', 'viewer/src/api.ts', 'README.md'];
  const git = (argv) => {
    if (argv[0] === 'merge-base') return argv[1] === 'base' ? { status: 0, stdout: 'abc\n' } : { status: 128, stdout: '' };
    if (argv[0] === 'diff') return { status: 0, stdout: 'bot/env.js\nbot/players/rush.js\n' };
    return { status: 0, stdout: tree.join('\n') + '\n' };
  };
  const scope = { include: ['bot/*.js', 'bot/players/index.js', 'viewer/**'], exclude: [] };
  const p = (...args) => plan(args, { repo, scope, cwd: repo, git });

  for (const args of [['scan'], ['scan', '.'], ['scan', repo], ['scan', '--paths', '.'], ['scan', '--paths=./'], ['scan', '--paths', 'bot/..'], ['--json', 'scan']]) {
    assert.match(p(...args).error || '', /no scope/, args.join(' '));
  }
  assert.match(p('scan', '--since', 'nope').error, /not a commit/);
  assert.match(p('scan', '..').error, /outside this repo/);
  assert.deepStrictEqual(p('scan', '--since', 'base').args, ['scan', '--parallel', '8', '--paths', 'bot/env.js']);
  assert.deepStrictEqual(p('--since=base', '--json', 'scan').args, ['scan', '--json', '--parallel', '8', '--paths', 'bot/env.js']);
  assert.deepStrictEqual(p('scan', '--full', '--min', '70').args, ['scan', '--min', '70', '--parallel', '8', '--paths', 'bot/env.js,bot/players/index.js,viewer/src/api.ts']);
  assert.deepStrictEqual(p('scan', 'bot', '--parallel=2').args, ['scan', '--parallel=2', '--paths', 'bot/env.js,bot/players/index.js']);
  assert.match(p('coverage', '--paths', 'viewer').error, /coverage needs tests/);
  assert.match(p('scan', 'bot/rust').nothing, /out of scope/);
  assert.match(p('check', 'bot/players/rush.js::RushBot.choose').error, /outside Perch's scope/);
  assert.deepStrictEqual(p('check', 'bot/env.js', '--force'), { command: 'check', asksJev: true, args: ['check', 'bot/env.js', '--force'], env: { PERCH_CACHE_READ: '0' } });
  assert.strictEqual(p('check', '66f80128').error, undefined, 'an issue id names no path');
  // perch reads a check path from the repo root, so the path checked here is the one passed on.
  const from = (dir, ...args) => plan(args, { repo, scope, cwd: path.join(repo, dir), git });
  assert.deepStrictEqual(from('viewer', 'check', 'bot/players/rush.js::RushBot.choose').args, ['check', 'viewer/bot/players/rush.js::RushBot.choose']);
  assert.deepStrictEqual(from('bot', 'check', 'env.js::EnvGame.start').args, ['check', 'bot/env.js::EnvGame.start']);
  assert.match(from('bot', 'check', 'players/rush.js').error, /outside Perch's scope/);
  assert.match(from('bot', 'check', '../../x.js').error, /outside this repo/);
  for (const args of [['scan', '--help'], ['scan', '-h'], ['scan', '--version'], ['issues'], ['close', 'abc', '--reason', 'scan']]) {
    assert.strictEqual(p(...args).asksJev, false, args.join(' '));
    assert.deepStrictEqual(p(...args).args, args);
  }
});

test('the repo scope reads the shared core and leaves the bots out', () => {
  for (const file of ['bot/env.js', 'bot/match.js', 'bot/ladder.js', 'bot/players/index.js', 'bot/players/external.js', 'spec/schemas/x.json', 'viewer/src/core/api.ts', 'studio/src/main.tsx', 'analysis/lib/llm.js', 'meta/analyze.js', 'importer/import.js', 'tools/bin/perch', 'bot/arena/referee.js', 'bot/arena/web/strategy-diagram.js', 'bot/eval/curves.js', 'bot/info/dial.js', 'bot/omni/lens.js', 'bot/learn/eval.js']) {
    assert.ok(inScope(file, scopes.repo), file);
  }
  for (const file of ['bot/players/heuristic.js', 'bot/players/rush.js', 'bot/rust/src/main.rs', 'bot/haskell/src/Main.hs', 'bot/examples/random_bot.py', 'bot/test/bots.test.js', 'bot/test/ratings.test.js', 'analysis/test/units.test.js', 'forceteki/server/game/Game.ts', 'README.md',
    'bot/arena/starters/rush.js', 'bot/arena/optimizer.js', 'bot/eval/bot.js', 'bot/omni/search.js', 'bot/learn/panel.js', 'bot/learned/arena.js', 'bot/jev/look.js', 'bot/ismcts-panel.js', 'bot/determinism-check.js']) {
    assert.ok(!inScope(file, scopes.repo), file);
  }
});

const lsTree = (dir) => spawnSync('git', ['-C', dir, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' }).stdout.trim().split('\n');
const commits = (dir) => Number(spawnSync('git', ['-C', dir, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).stdout);
const writer = (root) => (file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};

test('the shared snapshot holds the in-scope source files and nothing of perch\'s own', (t) => {
  const root = scratch(t);
  const dir = path.join(scratch(t), 'snap');
  const write = writer(root);
  write('dashboard/build.mjs', 'export const a = 1;\n');
  write('dashboard/data.json', '{}');
  write('arena/agents/x/bot.js', 'module.exports = 1;\n');
  write('arena/strategy/diagram.js', 'module.exports = 2;\n');
  write('bend/score.js', 'module.exports = 3;\n');
  write('dashboard/bundle.js', `var a=${'x'.repeat(5000)};\n`); // minified: one long line
  const scope = { root, include: ['dashboard/**', 'arena/**', 'bend/score.js'], exclude: ['arena/agents/**'] };
  const closures = path.join(root, 'closed.jsonl');
  snapshotShared(scope, dir, closures);
  assert.deepStrictEqual(lsTree(dir), ['arena/strategy/diagram.js', 'bend/score.js', 'dashboard/build.mjs']);
  fs.rmSync(path.join(root, 'arena/strategy/diagram.js'));
  write('closed.jsonl', '{"id":"x"}\n');
  snapshotShared(scope, dir, closures);
  assert.deepStrictEqual(lsTree(dir), ['bend/score.js', 'dashboard/build.mjs']);
  assert.strictEqual(fs.readFileSync(path.join(dir, '.perch/closed.jsonl'), 'utf8'), '{"id":"x"}\n');
  // perch's findings and closed issues stay out of the snapshot's commits, so an unchanged folder
  // makes no new commit.
  const count = commits(dir);
  writer(dir)('.perch/scan.jsonl', '{}\n');
  writer(dir)('.perch/.gitignore', '/*\n!closed.jsonl\n'); // as perch writes it
  snapshotShared(scope, dir, closures);
  assert.strictEqual(commits(dir), count);
});

test('the repo snapshot holds only in-scope code at HEAD, so bot code never reaches perch', (t) => {
  const root = scratch(t);
  const dir = path.join(scratch(t), 'snap');
  const write = writer(root);
  const git = (...argv) => assert.strictEqual(spawnSync('git', ['-C', root, ...argv]).status, 0, argv.join(' '));
  git('init', '-q');
  write('bot/match.js', "const { choose } = require('./players/rush');\nmodule.exports = (s) => choose(s);\n");
  write('bot/players/rush.js', 'exports.choose = (s) => s[0];\n');
  write('bot/test/match.test.js', "require('../match');\n");
  write('perch.yaml', 'rules: []\n');
  write('.perch/closed.jsonl', '{"id":"a"}\n');
  write('.perch/rules/r.md', 'rule\n');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'one');
  write('bot/ratings.js', 'module.exports = 1;\n'); // not committed
  const scope = { include: ['bot/*.js'], exclude: ['**/test/**'] };
  snapshotRepo(root, scope, dir);
  assert.deepStrictEqual(lsTree(dir), ['bot/match.js', 'perch.yaml']);
  assert.strictEqual(fs.readFileSync(path.join(dir, '.perch/closed.jsonl'), 'utf8'), '{"id":"a"}\n');
  assert.strictEqual(fs.readFileSync(path.join(dir, '.perch/rules/r.md'), 'utf8'), 'rule\n');
  // For check, uncommitted in-scope changes are laid over HEAD, and the next snapshot drops them.
  write('bot/match.js', 'module.exports = 2;\n');
  snapshotRepo(root, scope, dir, { workingTree: true });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'bot/match.js'), 'utf8'), 'module.exports = 2;\n');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'bot/ratings.js'), 'utf8'), 'module.exports = 1;\n');
  assert.deepStrictEqual(lsTree(dir), ['bot/match.js', 'perch.yaml'], 'not committed');
  snapshotRepo(root, scope, dir);
  assert.match(fs.readFileSync(path.join(dir, 'bot/match.js'), 'utf8'), /choose/);
  assert.strictEqual(fs.existsSync(path.join(dir, 'bot/ratings.js')), false);
});

test('the repo snapshot never writes to the repo it sits in', (t) => {
  const root = scratch(t);
  const write = writer(root);
  const git = (...argv) => spawnSync('git', ['-C', root, ...argv], { encoding: 'utf8' });
  git('init', '-q');
  write('bot/match.js', 'module.exports = 1;\n');
  write('bot/players/rush.js', 'module.exports = 2;\n');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'one');
  const head = git('rev-parse', 'HEAD').stdout;
  const index = fs.readFileSync(path.join(root, '.git/index'));
  const dir = path.join(root, '.perch/core');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true }); // a half-made snapshot, as an interrupted git init leaves it
  // As in a hook during `git commit -a`, which points git at this repo's index.
  process.env.GIT_INDEX_FILE = path.join(root, '.git/index');
  try {
    snapshotRepo(root, { include: ['bot/*.js'], exclude: [] }, dir);
  } finally {
    delete process.env.GIT_INDEX_FILE;
  }
  assert.strictEqual(git('rev-parse', 'HEAD').stdout, head);
  assert.ok(fs.readFileSync(path.join(root, '.git/index')).equals(index), "the repo's index is untouched");
  assert.deepStrictEqual(lsTree(dir), ['bot/match.js']);
});

test('end to end, Jev sees no out-of-scope code, not even as a callee', async (t) => {
  // A small repo with its own copy of tools/ and a stand-in for Jev that records each request.
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push(body);
      res.statusCode = 400;
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const root = scratch(t);
  const write = writer(root);
  fs.cpSync(path.join(repo, 'tools/bin'), path.join(root, 'tools/bin'), { recursive: true });
  fs.cpSync(path.join(repo, 'tools/perch'), path.join(root, 'tools/perch'), { recursive: true });
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'));
  write('tools/perch/scope.js', "module.exports = { repo: { include: ['bot/*.js'], exclude: [] }, shared: { root: '/nonexistent', include: [], exclude: [] } };\n");
  write('bot/match.js', "const { secretMove } = require('./players/rush');\nfunction play(state) {\n  if (!state) return null;\n  return secretMove(state.cards);\n}\nmodule.exports = { play };\n");
  write('bot/players/rush.js', 'function secretMove(cards) {\n  return cards.sort()[0];\n}\nmodule.exports = { secretMove };\n');
  write('.gitignore', 'node_modules\n.perch/*\n!.perch/closed.jsonl\n');
  const git = (...argv) => assert.strictEqual(spawnSync('git', ['-C', root, ...argv]).status, 0, argv.join(' '));
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'one');
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, PERCH_BASE_URL: `http://127.0.0.1:${server.address().port}/v1/systemone`, PERCH_API_KEY: 'x', PERCH_JEV_DIR: scratch(t) };
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'tools/bin/perch'), ...args], { cwd: root, env });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('close', (status) => resolve({ status, out }));
  });
  const scan = await run(['scan', '--full']);
  assert.ok(seen.length > 0, scan.out);
  assert.ok(seen.some((body) => body.includes('play')), 'asked about bot/match.js');
  for (const body of seen) assert.ok(!body.includes('cards.sort()') && !body.includes('bot/players/rush.js'), 'no bot code in a request');
  assert.deepStrictEqual(lsTree(path.join(root, '.perch/core')), ['bot/match.js']);

  // check asks about work in progress.
  write('bot/match.js', fs.readFileSync(path.join(root, 'bot/match.js'), 'utf8').replace('return null', 'return UNCOMMITTED_FIX'));
  seen.length = 0;
  const check = await run(['check', 'bot/match.js::play']);
  assert.ok(seen.some((body) => body.includes('UNCOMMITTED_FIX')), check.out);
  // coverage needs tests, which are out of scope; rules edit this repo's own perch.yaml.
  assert.strictEqual((await run(['coverage', 'bot'])).status, 2);
  const rules = await run(['rules', 'add', 'no-sort', '--where', 'bot/**', '--ensure', 'does not sort in place']);
  assert.strictEqual(rules.status, 0, rules.out);
  assert.match(fs.readFileSync(path.join(root, 'perch.yaml'), 'utf8'), /no-sort/);
  assert.strictEqual((await run(['shared', 'rules', 'list'])).status, 2);
});

test('closed issues are added to the shared list, never copied over it', (t) => {
  const dir = scratch(t);
  const local = path.join(dir, 'local.jsonl');
  const shared = path.join(dir, 'shared', 'closed.jsonl');
  fs.writeFileSync(local, 'a\n');
  const before = fs.readFileSync(local);
  writer(dir)('shared/closed.jsonl', 'a\nb\n'); // closed in another checkout meanwhile
  appendNew(local, before, shared); // this run closed nothing
  fs.appendFileSync(local, 'c\n');
  appendNew(local, before, shared);
  assert.strictEqual(fs.readFileSync(shared, 'utf8'), 'a\nb\nc\n');
});

test('the lock admits one holder and is taken over from a dead one', (t) => {
  const file = path.join(scratch(t), 'wrapper.lock');
  const lock = holdLock(file);
  assert.strictEqual(lock.held, true);
  fs.writeFileSync(file, String(process.ppid)); // a live process that is not this one
  assert.deepStrictEqual(holdLock(file), { held: false, holder: process.ppid, file });
  fs.writeFileSync(file, '999999999');
  const again = holdLock(file);
  assert.strictEqual(again.held, true);
  again.release();
  assert.strictEqual(fs.existsSync(file), false);
  holdLock(file);
  fs.writeFileSync(file, String(process.ppid));
  const started = Date.now();
  assert.strictEqual(holdLock(file, 300).held, false);
  assert.ok(Date.now() - started >= 300, 'waited for the holder');
});

test('the wrapper refuses an unscoped scan, checks --since and honors the off switch', (t) => {
  const dir = scratch(t);
  const env = { ...process.env, PERCH_JEV_DIR: dir };
  delete env.PERCH_DISABLED;
  const perch = (args, extra = {}) => spawnSync(process.execPath, [wrapper, ...args], { cwd: repo, env: { ...env, ...extra }, encoding: 'utf8' });

  const bare = perch(['scan']);
  assert.strictEqual(bare.status, 2);
  assert.match(bare.stderr, /npm run lint/);
  assert.match(perch(['scan', '--since', 'no-such-ref-here']).stderr, /not a commit/);

  assert.strictEqual(perch(['scan', '--full'], { PERCH_DISABLED: '1' }).status, 0);
  fs.writeFileSync(path.join(dir, 'DISABLED'), '');
  const off = perch(['scan', '--full']);
  assert.strictEqual(off.status, 0);
  assert.match(off.stderr, /turned off/);

  const usage = perch(['usage', '2']);
  assert.strictEqual(usage.status, 0);
  assert.strictEqual(usage.stdout.trim().split('\n').length, 3);
});
