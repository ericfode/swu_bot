'use strict';
// The limits tools/bin/perch puts on perch, and the usage ledger tools/perch/jev-cache.mjs writes.
// Kept apart from both so the tests can call them directly.
const fs = require('node:fs');
const path = require('node:path');

// Commands that send questions to Jev.
const ASKS_JEV = new Set(['scan', 'coverage', 'check']);
// perch's flags that take no value (its `switches`), plus ours. Every other flag takes the next
// argument unless written --flag=value.
const SWITCHES = new Set(['--force', '--all', '--json', '--verbose', '--closed', '--types', '--wait', '--help', '--version', '--full', '-h', '-v']);

function parseArgs(args) {
  const positionals = [];
  const flags = {};
  let commandAt = -1;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      if (commandAt < 0) commandAt = i;
      positionals.push(arg);
    } else if (arg.includes('=')) {
      flags[arg.slice(0, arg.indexOf('='))] = arg.slice(arg.indexOf('=') + 1);
    } else if (SWITCHES.has(arg)) {
      flags[arg] = true;
    } else {
      flags[arg] = args[++i];
    }
  }
  return { positionals, flags, commandAt };
}

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/**
 * What tools/bin/perch should run for these arguments: { command, asksJev, args, env, since?, error? }.
 * `error` means refuse with that message and exit 2. `since` is a ref the caller must check exists.
 */
function plan(args, { repo, cwd = process.cwd() }) {
  const { positionals, flags, commandAt } = parseArgs(args);
  const command = positionals[0];
  const help = Boolean(flags['--help'] || flags['-h'] || flags['--version'] || flags['-v']);
  const out = { command, asksJev: ASKS_JEV.has(command) && !help, args: [...args], env: {} };
  if (!out.asksJev) return out;
  if (flags['--force']) out.env.PERCH_CACHE_READ = '0';
  if (command !== 'scan' && command !== 'coverage') return out;

  // perch drops "." from --paths, and an empty list means every path.
  const paths = typeof flags['--paths'] === 'string'
    ? flags['--paths'].split(',').map((p) => p.trim().replace(/^(\.\/)+|\/+$/g, '')).filter((p) => p && p !== '.')
    : [];
  const root = real(repo);
  const target = positionals[1] && real(path.resolve(cwd, positionals[1]));
  const narrowTarget = target && target !== root && !root.startsWith(target + path.sep);
  // coverage reads every path whatever --since says; --since only trims its report.
  const since = command === 'scan' && typeof flags['--since'] === 'string' ? flags['--since'] : null;
  if (!narrowTarget && !paths.length && !since && !flags['--full']) {
    out.error = `perch: \`perch ${command}\` with no scope asks Jev about every method in the repo. ` +
      (command === 'scan' ? 'Use `npm run lint` (code changed since origin/main), name' : 'Name') + ' a path or --paths, or add --full.';
    return out;
  }
  if (since) out.since = since;
  // perch does not know --full. Its own --parallel default is 32.
  const parallel = '--parallel' in flags ? [] : ['--parallel', '8'];
  out.args = args.flatMap((arg, i) => (arg === '--full' ? [] : i === commandAt ? [arg, ...parallel] : [arg]));
  return out;
}

/** The run records for one UTC day (YYYY-MM-DD) in the ledger, leaving out the file named `skip`. */
function readDay(dir, date, skip) {
  let names = [];
  try {
    names = fs.readdirSync(path.join(dir, date));
  } catch {
    return [];
  }
  const runs = [];
  for (const name of names) {
    if (name === skip || !name.endsWith('.json')) continue;
    try {
      runs.push(JSON.parse(fs.readFileSync(path.join(dir, date, name), 'utf8')));
    } catch {}
  }
  return runs;
}

/**
 * Takes `file` as a lock for this process: { held: true, release } or { held: false, holder, file }.
 * A lock whose process is gone is taken over.
 */
function holdLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written whole under a temporary name, then linked into place: link fails if the lock exists,
  // and a reader never sees an empty lock file.
  const mine = `${file}.${process.pid}`;
  fs.writeFileSync(mine, String(process.pid));
  try {
    fs.linkSync(mine, file);
  } catch (error) {
    if (error.code !== 'EEXIST') {
      fs.rmSync(mine, { force: true });
      throw error;
    }
    // A lock released since the failed link reads as no holder and is taken over below.
    const holder = Number(readOr(file, '0'));
    let alive = false;
    try {
      alive = holder > 0 && process.kill(holder, 0);
    } catch (probe) {
      alive = probe.code === 'EPERM';
    }
    if (alive) {
      fs.rmSync(mine, { force: true });
      return { held: false, holder, file };
    }
    fs.renameSync(mine, file);
  }
  fs.rmSync(mine, { force: true });
  const release = () => {
    try {
      if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.rmSync(file);
    } catch {}
  };
  return { held: true, release };
}

function readOr(file, fallback) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

module.exports = { parseArgs, plan, readDay, holdLock };
