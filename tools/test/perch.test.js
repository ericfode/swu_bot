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

const preload = path.join(__dirname, '../perch/jev-cache.mjs');
const wrapper = path.join(__dirname, '../bin/perch');

/** A stand-in for Jev that counts POSTs and refuses any request whose body mentions "refuse". */
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

/** Runs one process with the preload that POSTs each body in turn and returns the statuses and replies. */
async function run(url, dir, bodies, extra = {}) {
  const script = `
    const out = [];
    for (const body of ${JSON.stringify(bodies)}) {
      const r = await fetch(${JSON.stringify(url)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      out.push({ status: r.status, text: await r.text() });
    }
    console.log(JSON.stringify(out));`;
  const env = { PATH: process.env.PATH, PERCH_BASE_URL: url, PERCH_CACHE_DIR: path.join(dir, 'cache'), PERCH_USAGE_DIR: path.join(dir, 'usage'), CLAUDE_CODE_SESSION_ID: 'test', ...extra };
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, '--input-type=module', '-e', script], { env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.strictEqual(code, 0, stderr);
  return { replies: JSON.parse(stdout), stderr };
}

const scratch = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('the same request is answered from the cache, with usage zeroed', async (t) => {
  const jev = await fakeJev(t);
  const dir = scratch(t);
  const first = await run(jev.url, dir, ['{"m":1}']);
  const second = await run(jev.url, dir, ['{"m":1}', '{"m":2}']);
  assert.strictEqual(jev.seen.length, 2, 'only {"m":2} is new');
  const [fresh, cached] = [JSON.parse(first.replies[0].text), JSON.parse(second.replies[0].text)];
  assert.deepStrictEqual(cached.answers, fresh.answers);
  assert.deepStrictEqual(cached.usage, { input_tokens: 0, output_tokens: 0 });
  assert.strictEqual(cached.charge, undefined);
  assert.match(second.stderr, /jev: 1 cached, 1 asked/);
});

test('PERCH_CACHE_READ=0 asks again; refusals and other requests are never cached', async (t) => {
  const jev = await fakeJev(t);
  const dir = scratch(t);
  await run(jev.url, dir, ['{"m":1}', '{"refuse":1}']);
  await run(jev.url, dir, ['{"m":1}'], { PERCH_CACHE_READ: '0' });
  await run(jev.url, dir, ['{"refuse":1}']);
  assert.strictEqual(jev.seen.length, 4);
  const other = await run(jev.url.replace('systemone', 'other'), dir, ['{"m":1}'], { PERCH_BASE_URL: jev.url });
  assert.strictEqual(other.replies[0].status, 200);
  assert.strictEqual(jev.seen.length, 5, 'a POST to another URL passes through');
  assert.strictEqual(other.stderr, '');
});

test('the run budget and the daily budget answer 402 instead of asking', async (t) => {
  const jev = await fakeJev(t);
  const dir = scratch(t);
  const capped = await run(jev.url, dir, ['{"m":1}', '{"m":2}', '{"m":3}'], { PERCH_RUN_REQUESTS: '2' });
  assert.deepStrictEqual(capped.replies.map((r) => r.status), [200, 200, 402]);
  assert.match(capped.replies[2].text, /PERCH_RUN_REQUESTS/);
  const daily = await run(jev.url, dir, ['{"m":1}', '{"m":4}'], { PERCH_DAILY_REQUESTS: '2' });
  assert.deepStrictEqual(daily.replies.map((r) => r.status), [200, 402], 'cached answers stay free over budget');
  assert.strictEqual(jev.seen.length, 2);

  const { spentOn } = await import(pathToFileURL(preload).href);
  const day = fs.readdirSync(path.join(dir, 'usage'))[0];
  assert.strictEqual(spentOn(path.join(dir, 'usage'), day), 2);
  const ledger = fs.readFileSync(path.join(dir, 'usage', day, 'test.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(ledger.map((l) => [l.hits, l.asked, l.refused]), [[0, 2, 1], [1, 0, 1]]);
  assert.strictEqual(ledger[0].input_tokens, 20);
});

test('the wrapper refuses an unscoped scan and honors the off switch', (t) => {
  const dir = scratch(t);
  const env = { ...process.env, PERCH_JEV_DIR: dir };
  delete env.PERCH_DISABLED;
  const perch = (args, extra = {}) => spawnSync(process.execPath, [wrapper, ...args], { env: { ...env, ...extra }, encoding: 'utf8' });

  const bare = perch(['scan']);
  assert.strictEqual(bare.status, 2);
  assert.match(bare.stderr, /npm run lint/);
  assert.strictEqual(perch(['coverage', '--json']).status, 2);
  assert.strictEqual(perch(['scan', '--since', 'no-such-ref-here']).status, 2);

  assert.strictEqual(perch(['scan', '--full'], { PERCH_DISABLED: '1' }).status, 0);
  fs.writeFileSync(path.join(dir, 'DISABLED'), '');
  const off = perch(['scan', '--full']);
  assert.strictEqual(off.status, 0);
  assert.match(off.stderr, /turned off/);

  const usage = perch(['usage', '2']);
  assert.strictEqual(usage.status, 0);
  assert.strictEqual(usage.stdout.trim().split('\n').length, 3);
});
