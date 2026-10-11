'use strict';
// The limits tools/bin/perch puts on perch, and the usage ledger tools/perch/jev-cache.mjs writes.
// Kept apart from both so the tests can call them directly.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Commands that send questions to Jev.
const ASKS_JEV = new Set(['scan', 'coverage', 'check']);
// perch's flags that take no value (its `switches`), plus ours. Every other flag takes the next
// argument unless written --flag=value.
const SWITCHES = new Set(['--force', '--all', '--json', '--verbose', '--closed', '--types', '--wait', '--help', '--version', '--full', '-h', '-v']);

/** Positionals, flag values, and each flag's own arguments as written (to pass them on). */
function parseArgs(args) {
  const positionals = [];
  const flags = {};
  const written = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg);
    } else if (arg.includes('=')) {
      const name = arg.slice(0, arg.indexOf('='));
      flags[name] = arg.slice(arg.indexOf('=') + 1);
      written.push({ name, raw: [arg] });
    } else if (SWITCHES.has(arg)) {
      flags[arg] = true;
      written.push({ name: arg, raw: [arg] });
    } else {
      flags[arg] = args[i + 1];
      written.push({ name: arg, raw: args.slice(i, i + 2) });
      i++;
    }
  }
  return { positionals, flags, written };
}

const globs = new Map();
function globRegex(glob) {
  if (!globs.has(glob)) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
      if (glob.startsWith('**/', i)) {
        re += '(?:.*/)?';
        i += 2;
      } else if (glob.startsWith('**', i)) {
        re += '.*';
        i += 1;
      } else if (glob[i] === '*') re += '[^/]*';
      else if (glob[i] === '?') re += '[^/]';
      else re += glob[i].replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    globs.set(glob, new RegExp(`^${re}$`));
  }
  return globs.get(glob);
}

/** True when a repo-relative path is in a { include, exclude } scope. */
const inScope = (file, scope) =>
  scope.include.some((glob) => globRegex(glob).test(file)) && !scope.exclude.some((glob) => globRegex(glob).test(file));

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

const runGit = (repo) => (argv) => spawnSync('git', ['-C', repo, ...argv], { encoding: 'utf8', maxBuffer: 64 << 20 });

/**
 * What tools/bin/perch should run for these arguments.
 * Returns { command, asksJev, args, env } and, to stop instead, `error` (exit 2) or `nothing` (exit 0).
 * scan and coverage get an explicit --paths list: the files they would read (all files at HEAD, or
 * those changed since --since), narrowed to a named path or --paths, then to `scope`.
 */
function plan(args, { repo, scope, cwd = process.cwd(), git = runGit(repo) }) {
  const { positionals, flags, written } = parseArgs(args);
  const command = positionals[0];
  const help = Boolean(flags['--help'] || flags['-h'] || flags['--version'] || flags['-v']);
  const out = { command, asksJev: ASKS_JEV.has(command) && !help, args: [...args], env: {} };
  if (!out.asksJev) return out;
  if (flags['--force']) out.env.PERCH_CACHE_READ = '0';
  const root = real(repo);
  const relative = (p) => path.posix.normalize(path.relative(root, real(path.resolve(cwd, p))).split(path.sep).join('/'));

  if (command === 'check') {
    // perch check <path | path::method | issue-id>; an issue id names no path.
    const file = String(positionals[1] ?? '').split('::')[0];
    if (scope && /[/.]/.test(file) && !inScope(relative(file), scope)) out.error = outside(file);
    return out;
  }
  if (command !== 'scan' && command !== 'coverage') return out;

  // Paths the caller narrowed to, repo-relative; '' is the whole repo (perch drops "." from --paths,
  // and an empty list means every path).
  const named = [
    ...(positionals[1] === undefined ? [] : [relative(positionals[1])]),
    ...String(flags['--paths'] ?? '').split(',').filter((p) => p.trim()).map((p) => path.posix.normalize(p.trim())),
  ].map((p) => p.replace(/\/+$/, '')).map((p) => (p === '.' ? '' : p));
  const escaped = named.find((p) => p === '..' || p.startsWith('../') || path.isAbsolute(p));
  if (escaped !== undefined) return { ...out, error: `perch: ${escaped} is outside this repo.` };
  // coverage reads every path whatever --since says; --since only trims its report.
  const since = command === 'scan' && typeof flags['--since'] === 'string' ? flags['--since'] : null;
  const narrow = named.filter((p) => p !== '');
  if (!since && !narrow.length && !flags['--full']) {
    out.error = `perch: \`perch ${command}\` with no scope asks Jev about every method in scope. ` +
      (command === 'scan' ? 'Use `npm run lint` (code changed since origin/main), name' : 'Name') + ' a path or --paths, or add --full.';
    return out;
  }

  let listed;
  if (since) {
    const base = git(['merge-base', since, 'HEAD']);
    if (base.status !== 0) return { ...out, error: `perch: ${since} is not a commit in this checkout. Run \`git fetch origin main\` first.` };
    listed = git(['diff', '--name-only', '--diff-filter=d', base.stdout.trim(), 'HEAD']);
  } else {
    listed = git(['ls-tree', '-r', '--name-only', 'HEAD']);
  }
  if (listed.status !== 0) return { ...out, error: `perch: git could not list the files to read: ${String(listed.stderr).trim()}` };
  let files = listed.stdout.split('\n').filter(Boolean);
  if (narrow.length) files = files.filter((f) => narrow.some((p) => f === p || f.startsWith(p + '/')));
  files = files.filter((f) => SOURCE.test(f) && (!scope || inScope(f, scope)) && handWritten(path.join(root, f)));
  if (!files.length) {
    out.nothing = (since ? `perch: no code in Perch's scope changed since ${since}.` : "perch: nothing in Perch's scope there.") +
      ' Bot code is out of scope (tools/perch/scope.js).';
    return out;
  }
  // Pass every other flag on. perch does not know --full, and its own --parallel default is 32.
  const dropped = new Set(['--full', '--paths', ...(since ? ['--since'] : [])]);
  const kept = written.filter((w) => !dropped.has(w.name)).flatMap((w) => w.raw);
  const parallel = '--parallel' in flags ? [] : ['--parallel', '8'];
  out.args = [command, ...kept, ...parallel, '--paths', files.join(',')];
  out.files = files;
  return out;
}

// Source files; data, docs, lockfiles and art stay out.
const SOURCE = /\.(?:[cm]?js|jsx|tsx?|py|rs|go|sh|c|h|cc|cpp|hs|clj|lisp)$/;

/** False for built bundles: files over 256 KB or minified (long lines). A missing file passes. */
function handWritten(file) {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) return true;
  return stat.size <= 256 << 10 && stat.size / fs.readFileSync(file, 'utf8').split('\n').length < 300;
}

const outside = (file) => `perch: ${file} is outside Perch's scope: bot code is not linted (tools/perch/scope.js).`;

/**
 * The run records for one UTC day (YYYY-MM-DD) in the ledger, leaving out the file named `skip`.
 * `known` (a Map) keeps finished runs between calls, so a long day only re-reads the live ones.
 */
function readDay(dir, date, skip, known = new Map()) {
  let names = [];
  try {
    names = fs.readdirSync(path.join(dir, date));
  } catch {
    return [];
  }
  const runs = [];
  for (const name of names) {
    if (name === skip || !name.endsWith('.json')) continue;
    if (known.has(name)) {
      runs.push(known.get(name));
      continue;
    }
    try {
      const run = JSON.parse(fs.readFileSync(path.join(dir, date, name), 'utf8'));
      if (run.exit !== null && run.exit !== undefined) known.set(name, run);
      runs.push(run);
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
    for (let attempt = 0; ; attempt++) {
      try {
        fs.linkSync(mine, file);
        break;
      } catch (error) {
        if (error.code !== 'EEXIST' || attempt >= 3) throw error;
      }
      const holder = Number(readOr(file, '0'));
      if (alive(holder)) return { held: false, holder, file };
      // Move the dead lock aside and link again. When two runs race here, only one rename finds
      // the file and only one link succeeds.
      const aside = `${file}.dead.${process.pid}`;
      try {
        fs.renameSync(file, aside);
      } catch {
        continue;
      }
      const moved = Number(readOr(aside, '0'));
      if (moved !== holder && alive(moved)) {
        // Another run took the lock between the read and the rename: put it back.
        try {
          fs.linkSync(aside, file);
        } catch {}
        fs.rmSync(aside, { force: true });
        return { held: false, holder: moved, file };
      }
      fs.rmSync(aside, { force: true });
    }
  } finally {
    fs.rmSync(mine, { force: true });
  }
  const release = () => {
    try {
      if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.rmSync(file);
    } catch {}
  };
  return { held: true, release };
}

function alive(pid) {
  try {
    return pid > 0 && process.kill(pid, 0);
  } catch (probe) {
    return probe.code === 'EPERM';
  }
}

function readOr(file, fallback) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

/**
 * Copies the source files in the shared project folder that `scope` covers into a git repo at
 * `dir` and commits them, so perch can read them at HEAD. Closed issues live at `closures`.
 */
function snapshotShared(scope, dir, closures) {
  const git = (...argv) => spawnSync('git', ['-C', dir, ...argv], { encoding: 'utf8' });
  const must = (...argv) => {
    const result = git(...argv);
    if (result.status !== 0) throw new Error(`git ${argv.join(' ')} in ${dir}: ${result.stderr}`);
    return result.stdout;
  };
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(dir, { recursive: true });
    must('init', '-q');
    must('config', 'user.name', 'perch shared snapshot');
    must('config', 'user.email', 'perch@localhost');
  }
  const tops = new Set(scope.include.map((glob) => glob.split('/').filter((part, i, all) => all.slice(0, i + 1).every((p) => !/[*?]/.test(p))).join('/')));
  const wanted = new Map();
  for (const top of tops) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(scope.root, top), { recursive: true });
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.posix.join(top, String(name).split(path.sep).join('/'));
      if (!SOURCE.test(file) || !inScope(file, scope)) continue;
      const stat = fs.statSync(path.join(scope.root, file), { throwIfNoEntry: false });
      if (stat?.isFile() && handWritten(path.join(scope.root, file))) wanted.set(file, path.join(scope.root, file));
    }
  }
  for (const file of must('ls-files').split('\n').filter(Boolean)) if (!wanted.has(file)) fs.rmSync(path.join(dir, file), { force: true });
  for (const [file, from] of wanted) copyIfChanged(from, path.join(dir, file));
  must('add', '-A');
  if (git('diff', '--cached', '--quiet').status !== 0 || git('rev-parse', '-q', '--verify', 'HEAD').status !== 0) {
    must('commit', '-q', '--allow-empty', '-m', `snapshot of ${scope.root}`);
  }
  copyIfChanged(closures, path.join(dir, '.perch', 'closed.jsonl'));
}

function copyIfChanged(from, to) {
  let bytes;
  try {
    bytes = fs.readFileSync(from);
  } catch {
    return;
  }
  try {
    if (fs.readFileSync(to).equals(bytes)) return;
  } catch {}
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, bytes);
}

module.exports = { parseArgs, plan, inScope, readDay, holdLock, snapshotShared, copyIfChanged };
