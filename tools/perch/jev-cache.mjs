// Loaded into perch with `node --import` by tools/bin/perch (see CLAUDE.md, "Linting").
// It wraps fetch for the POSTs perch sends to Jev (PERCH_BASE_URL) and adds what perch lacks
// when it talks to Jev directly instead of Perch Cloud:
// - Cache. The key is a hash of the request body: the method's source, its callers and callees,
//   and the questions. Unchanged code gets the stored answer, so it costs nothing and gets the
//   same verdict every run (fresh Jev answers move by up to ±0.06 between runs).
// - Budget. At most PERCH_RUN_REQUESTS new requests per run and PERCH_DAILY_REQUESTS per UTC day
//   across every session that shares PERCH_USAGE_DIR. Over budget, perch gets HTTP 402 and stops.
// - Ledger. One JSON line per run in <PERCH_USAGE_DIR>/<YYYY-MM-DD>/<session>.jsonl, which the
//   daily budget and `npm run perch -- usage` read back.
// PERCH_CACHE_READ=0 (tools/bin/perch sets it for --force) asks Jev again and replaces the entry.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
const session = env.CLAUDE_CODE_REMOTE_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || `local-${process.pid}`;
const day = new Date().toISOString().slice(0, 10);

/** Jev requests already recorded in one day's ledger directory. */
export function spentOn(dir, date) {
  let total = 0;
  let names = [];
  try {
    names = fs.readdirSync(path.join(dir, date));
  } catch {
    return 0;
  }
  for (const name of names) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, date, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      try {
        total += JSON.parse(line).asked || 0;
      } catch {}
    }
  }
  return total;
}

const stats = { hits: 0, asked: 0, refused: 0, input_tokens: 0, output_tokens: 0 };
let spentBefore = null; // read on the first request, so perch's other commands never touch the ledger
const realFetch = globalThis.fetch;

if (target && realFetch) {
  globalThis.fetch = function fetch(url, init) {
    if (String(url) !== target || init?.method !== 'POST' || typeof init.body !== 'string') return realFetch(url, init);
    return askJev(url, init);
  };
  process.on('exit', (code) => finish(code));
  // A timeout in tools/bin/perch sends SIGTERM; exit normally so the ledger line is still written.
  process.once('SIGTERM', () => process.exit(143));
}

async function askJev(url, init) {
  const key = createHash('sha256').update(String(url)).update('\0').update(init.body).digest('hex');
  const file = cacheDir && path.join(cacheDir, key.slice(0, 2), `${key}.json`);
  if (file && readCache) {
    const saved = await load(file);
    if (saved) {
      stats.hits++;
      return new Response(saved, { status: 200, headers: { 'content-type': 'application/json' } });
    }
  }
  spentBefore ??= usageDir ? spentOn(usageDir, day) : 0;
  const why = stats.asked >= runLimit
    ? `this run already asked Jev ${runLimit} times (PERCH_RUN_REQUESTS)`
    : spentBefore + stats.asked >= dayLimit
      ? `the project asked Jev ${spentBefore + stats.asked} times today, UTC (PERCH_DAILY_REQUESTS=${dayLimit})`
      : null;
  if (why) {
    if (++stats.refused === 1) console.error(`perch budget: stopped because ${why}. Cached answers are still free.`);
    return new Response(`swu_bot perch budget: ${why}`, { status: 402 });
  }
  stats.asked++;
  const response = await realFetch(url, init);
  if (response.status !== 200) return response;
  const text = await response.text();
  try {
    const body = JSON.parse(text);
    stats.input_tokens += body.usage?.input_tokens || 0;
    stats.output_tokens += body.usage?.output_tokens || 0;
    if (file && cacheable(body)) await save(file, JSON.stringify({ v: 1, at: new Date().toISOString(), response: body }));
  } catch {}
  return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function cacheable(body) {
  const answers = body?.answers;
  return answers && typeof answers === 'object' && !Object.values(answers).some((answer) => answer?.type === 'refusal');
}

/** The stored response as fresh JSON text with usage zeroed, or null for a miss, a stale entry or a bad file. */
async function load(file) {
  try {
    const entry = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    if (entry.v !== 1 || !cacheable(entry.response) || !(Date.now() - Date.parse(entry.at) < maxAgeMs)) return null;
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

function finish(code) {
  if (!stats.hits && !stats.asked && !stats.refused) return;
  const today = (spentBefore ?? 0) + stats.asked;
  const tail = stats.asked || stats.refused ? `; ${today} of ${dayLimit} asked today` : '';
  console.error(`jev: ${stats.hits} cached, ${stats.asked} asked${stats.refused ? `, ${stats.refused} refused` : ''}${tail}`);
  if (!usageDir) return;
  const line = { at: new Date().toISOString(), session, args: process.argv.slice(2), ...stats, exit: code };
  try {
    fs.mkdirSync(path.join(usageDir, day), { recursive: true });
    fs.appendFileSync(path.join(usageDir, day, `${session}.jsonl`), JSON.stringify(line) + '\n');
  } catch (error) {
    console.error(`jev: could not write the usage ledger (${error.message})`);
  }
}
