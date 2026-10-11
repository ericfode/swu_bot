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
const { plan, readDay, holdLock } = require('../perch/policy');

const preload = path.join(__dirname, '../perch/jev-cache.mjs');
const wrapper = path.join(__dirname, '../bin/perch');
const repo = path.resolve(__dirname, '../..');

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

test('plan refuses unscoped scans and keeps help, other commands and scoped runs as they are', () => {
  const p = (...args) => plan(args, { repo, cwd: repo });
  for (const args of [['scan'], ['scan', '.'], ['scan', repo], ['scan', '--paths', '.'], ['scan', '--paths=./'], ['coverage', '--since', 'origin/main'], ['--json', 'scan']]) {
    assert.match(p(...args).error || '', /no scope/, args.join(' '));
  }
  assert.deepStrictEqual(p('scan', '--since', 'origin/main'), { command: 'scan', asksJev: true, args: ['scan', '--parallel', '8', '--since', 'origin/main'], env: {}, since: 'origin/main' });
  assert.deepStrictEqual(p('--since=origin/main', 'scan').since, 'origin/main');
  assert.deepStrictEqual(p('scan', '--full', '--json').args, ['scan', '--parallel', '8', '--json']);
  assert.deepStrictEqual(p('scan', 'bot', '--parallel=2').args, ['scan', 'bot', '--parallel=2']);
  assert.deepStrictEqual(p('scan', '--', 'bot').args, ['scan', '--parallel', '8', '--', 'bot']);
  assert.deepStrictEqual(p('scan', '--min', '70', 'bot').error, undefined);
  assert.deepStrictEqual(p('coverage', '--paths', 'bot').error, undefined);
  assert.deepStrictEqual(p('check', 'bot/env.js', '--force'), { command: 'check', asksJev: true, args: ['check', 'bot/env.js', '--force'], env: { PERCH_CACHE_READ: '0' } });
  assert.strictEqual(p('--rules', 'defect', 'check', 'x').command, 'check');
  for (const args of [['scan', '--help'], ['scan', '-h'], ['scan', '--version'], ['issues'], ['close', 'abc', '--reason', 'scan']]) {
    assert.strictEqual(p(...args).asksJev, false, args.join(' '));
    assert.deepStrictEqual(p(...args).args, args);
  }
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
