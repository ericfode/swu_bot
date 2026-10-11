// Loaded into perch with `node --import` by tools/bin/perch (see CLAUDE.md, "Linting").
// It wraps fetch for the POSTs perch sends to Jev (PERCH_BASE_URL) and adds what perch lacks
// when it talks to Jev directly instead of Perch Cloud:
// - Cache. The key is a hash of the request body: the model name, the method's source, its callers
//   and callees, and the questions. Unchanged code gets the stored answer, so it costs nothing and
//   gets the same verdict every run (fresh Jev answers move by up to ±0.06 between runs).
// - Budget. At most PERCH_RUN_REQUESTS new requests per run and PERCH_DAILY_REQUESTS per UTC day
//   across every session that shares PERCH_USAGE_DIR. A request over budget gets HTTP 409, which
//   perch reports as a failed method and moves on, so cached answers are still used.
// - Ledger. Each run keeps one JSON file in <PERCH_USAGE_DIR>/<YYYY-MM-DD>/, rewritten every few
//   seconds while it asks Jev, so runs that overlap see each other's requests.
// PERCH_CACHE_READ=0 (tools/bin/perch sets it for --force) asks Jev again and replaces the entry.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import policy from './policy.js';

const env = process.env;
const target = env.PERCH_BASE_URL;
const cacheDir = env.PERCH_CACHE_DIR;
const usageDir = env.PERCH_USAGE_DIR;
const readCache = env.PERCH_CACHE_READ !== '0';
// A limit of 0 means cached answers only.
const number = (name, fallback) => (env[name] && Number(env[name]) >= 0 ? Number(env[name]) : fallback);
const maxAgeMs = number('PERCH_CACHE_DAYS', 30) * 86400e3;
const runLimit = number('PERCH_RUN_REQUESTS', 250);
const dayLimit = number('PERCH_DAILY_REQUESTS', 1000);
const SYNC_MS = 2000;

const started = new Date();
const day = started.toISOString().slice(0, 10);
const session = env.CLAUDE_CODE_REMOTE_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || 'local';
const runFile = `${session}.${process.pid}.${started.getTime()}.json`;
const stats = { hits: 0, asked: 0, refused: 0, input_tokens: 0, output_tokens: 0 };
let others = 0; // requests other runs recorded today, refreshed every SYNC_MS
let synced = 0;
let warned = false;
const realFetch = globalThis.fetch;

if (target && realFetch) {
  globalThis.fetch = function fetch(url, init) {
    if (String(url) !== target || init?.method !== 'POST' || typeof init.body !== 'string') return realFetch(url, init);
    return askJev(url, init);
  };
  process.on('exit', (code) => finish(code));
  // Exit normally on these so the ledger keeps the requests already made (SIGTERM is the timeout).
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]]) process.once(signal, () => process.exit(code));
}

async function askJev(url, init) {
  const key = createHash('sha256').update(String(url)).update('\0').update(init.body).digest('hex');
  const file = cacheDir && path.join(cacheDir, key.slice(0, 2), `${key}.json`);
  let asked = {};
  try {
    asked = JSON.parse(init.body).questions ?? {};
  } catch {}
  if (file && readCache) {
    const saved = await load(file, asked);
    if (saved) {
      stats.hits++;
      return new Response(saved, { status: 200, headers: { 'content-type': 'application/json' } });
    }
  }
  sync();
  const why = stats.asked >= runLimit
    ? `this run already asked Jev ${runLimit} times (PERCH_RUN_REQUESTS)`
    : others + stats.asked >= dayLimit
      ? `the project asked Jev ${others + stats.asked} times today, UTC (PERCH_DAILY_REQUESTS=${dayLimit})`
      : null;
  if (why) {
    if (++stats.refused === 1) console.error(`perch budget: ${why}. Methods without a cached answer are skipped.`);
    return new Response(`swu_bot perch budget: ${why}`, { status: 409 });
  }
  stats.asked++;
  sync(stats.asked === 1);
  const response = await realFetch(url, init);
  if (response.status !== 200) return response;
  const text = await response.text();
  try {
    const body = JSON.parse(text);
    stats.input_tokens += body.usage?.input_tokens || 0;
    stats.output_tokens += body.usage?.output_tokens || 0;
    if (file && complete(body, asked)) await save(file, JSON.stringify({ v: 1, at: new Date().toISOString(), response: body }));
  } catch {}
  return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** True when every question asked has an answer that is not a refusal. */
function complete(body, asked) {
  const answers = body?.answers;
  if (!answers || typeof answers !== 'object') return false;
  const byName = Array.isArray(answers) ? Object.fromEntries(answers.map((answer) => [answer?.name, answer])) : answers;
  const ids = Object.keys(asked);
  return ids.length > 0 && ids.every((id) => byName[id] && typeof byName[id] === 'object' && byName[id].type !== 'refusal');
}

/** The stored response as fresh JSON text with usage zeroed, or null for a miss, a stale entry or a bad file. */
async function load(file, asked) {
  try {
    const entry = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    if (entry.v !== 1 || !complete(entry.response, asked) || !(Date.now() - Date.parse(entry.at) < maxAgeMs)) return null;
    const { charge, ...response } = entry.response;
    return JSON.stringify({ ...response, usage: { input_tokens: 0, output_tokens: 0 } });
  } catch {
    return null;
  }
}

// A cache that cannot be written only costs a future request, so errors are ignored.
async function save(file, text) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(tmp, text);
    await fs.promises.rename(tmp, file);
  } catch {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
  }
}

/** Re-reads what other runs spent today and rewrites this run's ledger file, at most every SYNC_MS. */
function sync(now = false, exit = null) {
  if (!usageDir || (!now && Date.now() - synced < SYNC_MS)) return;
  synced = Date.now();
  others = policy.readDay(usageDir, day, runFile).reduce((total, run) => total + (run.asked || 0), 0);
  const record = { v: 1, started: started.toISOString(), updated: new Date().toISOString(), session, pid: process.pid, args: process.argv.slice(2), ...stats, exit };
  const file = path.join(usageDir, day, runFile);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(record) + '\n');
    fs.renameSync(`${file}.tmp`, file);
  } catch (error) {
    if (!warned) console.error(`jev: could not write the usage ledger, so the daily budget cannot count this run (${error.message})`);
    warned = true;
  }
}

function finish(code) {
  if (!stats.hits && !stats.asked && !stats.refused) return;
  sync(true, code);
  const today = stats.asked || stats.refused ? `; ${others + stats.asked} of ${dayLimit} asked today` : '';
  console.error(`jev: ${stats.hits} cached, ${stats.asked} asked${stats.refused ? `, ${stats.refused} refused` : ''}${today}`);
}
