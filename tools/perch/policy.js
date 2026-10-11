'use strict';
// The limits tools/bin/perch puts on perch, the snapshots it runs perch in, and the usage ledger
// tools/perch/jev-cache.mjs writes. Kept apart from both so the tests can call them directly.
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

/** True when these perch arguments send questions to Jev. */
function asksJev(args) {
  const { positionals, flags } = parseArgs(args);
  return ASKS_JEV.has(positionals[0]) && !(flags['--help'] || flags['-h'] || flags['--version'] || flags['-v']);
}

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
  const out = { command, asksJev: asksJev(args), args: [...args], env: {} };
  if (!out.asksJev) return out;
  if (flags['--force']) out.env.PERCH_CACHE_READ = '0';
  const root = real(repo);
  const relative = (p) => path.posix.normalize(path.relative(root, real(path.resolve(cwd, p))).split(path.sep).join('/'));

  if (command === 'check') {
    // perch check <path | path::method | issue-id>. perch reads the path from the repo root, so the
    // path that passed the check is the one it gets. An issue id names no path; perch looks it up in
    // the snapshot's own findings, which only cover files in scope.
    const target = String(positionals[1] ?? '');
    const [file, ...method] = target.split('::');
    if (!/[/.]/.test(file)) return out;
    const rel = relative(file);
    if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) return { ...out, error: `perch: ${file} is outside this repo.` };
    if (scope && !inScope(rel, scope)) return { ...out, error: outside(file) };
    out.args[args.indexOf(target)] = [rel, ...method].join('::');
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
  // --since is resolved here, against this repo's history: the snapshot perch runs in has none.
  const since = typeof flags['--since'] === 'string' ? flags['--since'] : null;
  const narrow = named.filter((p) => p !== '');
  if (!since && !narrow.length && !flags['--full']) {
    out.error = `perch: \`perch ${command}\` with no scope asks Jev about every method in scope. ` +
      (command === 'scan' ? 'Use `npm run lint` (code changed since origin/main), or name' : 'Name') + ' a path, --paths or --since, or add --full.';
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
  files = files.filter((f) => SOURCE.test(f) && (!scope || inScope(f, scope)) && handWrittenFile(path.join(root, f)));
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

const MAX_BYTES = 256 << 10;

/** False for built bundles: over 256 KB or minified (long lines). */
const handWritten = (bytes) => bytes.length <= MAX_BYTES && bytes.length / (count(bytes, 10) + 1) < 300;

function count(bytes, byte) {
  let n = 0;
  for (let at = bytes.indexOf(byte); at !== -1; at = bytes.indexOf(byte, at + 1)) n++;
  return n;
}

/** handWritten for a file on disk. A missing file passes. */
function handWrittenFile(file) {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) return true;
  return stat.size <= MAX_BYTES && handWritten(fs.readFileSync(file));
}

/** The contents of a hand-written source file, or null for anything else. */
function readSource(file) {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > MAX_BYTES) return null;
  const bytes = fs.readFileSync(file);
  return handWritten(bytes) ? bytes : null;
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
 * A lock whose process is gone is taken over. With `waitMs`, a held lock is tried again until then.
 */
function holdLock(file, waitMs = 0) {
  const until = Date.now() + waitMs;
  for (;;) {
    const lock = tryLock(file);
    if (lock.held || Date.now() >= until) return lock;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
}

function tryLock(file) {
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
 * Makes `dir` a git repo whose HEAD holds exactly `files` (a Map of relative path to contents). perch
 * runs there, so it sees these files and nothing else: no bot code and no tests, not even as the
 * callers and callees it shows Jev next to each method. perch keeps its findings in dir/.perch, which
 * the snapshot's git ignores; `perchFiles` (a Map of path under .perch to contents) are written there,
 * and .perch/rules is rebuilt from them.
 */
function snapshot(dir, files, perchFiles = new Map()) {
  const git = (...argv) => spawnSync('git', ['-C', dir, ...argv], { encoding: 'utf8' });
  const must = (...argv) => {
    const result = git(...argv);
    if (result.status !== 0) throw new Error(`git ${argv.join(' ')} in ${dir}: ${result.stderr}`);
    return result.stdout;
  };
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(dir, { recursive: true });
    must('init', '-q');
    must('config', 'user.name', 'perch snapshot');
    must('config', 'user.email', 'perch@localhost');
  }
  const exclude = path.join(dir, '.git', 'info', 'exclude');
  if (!readOr(exclude, '').split('\n').includes('/.perch/')) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, '\n/.perch/\n');
  }
  const tracked = must('ls-files', '-z').split('\0').filter(Boolean);
  // Snapshots made before .perch/ was ignored still track perch's closed.jsonl.
  if (tracked.some((file) => file.startsWith('.perch/'))) must('rm', '-r', '-q', '--cached', '.perch');
  for (const file of tracked) if (!file.startsWith('.perch/') && !files.has(file)) fs.rmSync(path.join(dir, file), { force: true });
  for (const [file, bytes] of files) writeIfChanged(path.join(dir, file), bytes);
  must('add', '-A');
  if (git('diff', '--cached', '--quiet').status !== 0 || git('rev-parse', '-q', '--verify', 'HEAD').status !== 0) {
    must('commit', '-q', '--allow-empty', '--no-verify', '--no-gpg-sign', '-m', 'perch snapshot');
  }
  fs.rmSync(path.join(dir, '.perch', 'rules'), { recursive: true, force: true });
  for (const [file, bytes] of perchFiles) writeIfChanged(path.join(dir, '.perch', file), bytes);
}

/** The repo's source files in `scope`, as committed at HEAD, plus perch.yaml, closed issues and rules. */
function snapshotRepo(repo, scope, dir) {
  const listed = spawnSync('git', ['-C', repo, 'ls-tree', '-r', '-z', '--name-only', 'HEAD'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (listed.status !== 0) throw new Error(`git ls-tree in ${repo}: ${listed.stderr}`);
  const names = listed.stdout.split('\0').filter((f) => f === 'perch.yaml' || (SOURCE.test(f) && inScope(f, scope)));
  const files = new Map([...readAtHead(repo, names)].filter(([file, bytes]) => file === 'perch.yaml' || handWritten(bytes)));
  const perchFiles = new Map([['closed.jsonl', readBytes(path.join(repo, '.perch', 'closed.jsonl'))]]);
  const rules = path.join(repo, '.perch', 'rules');
  for (const name of readdirOr(rules)) {
    const bytes = readBytes(path.join(rules, name), null);
    if (bytes) perchFiles.set(path.posix.join('rules', String(name).split(path.sep).join('/')), bytes);
  }
  snapshot(dir, files, perchFiles);
}

/** The source files in the shared project folder that `scope` covers, plus the closed issues at `closures`. */
function snapshotShared(scope, dir, closures) {
  // Walk each include glob from its longest path without a wildcard.
  const tops = new Set(scope.include.map((glob) => glob.split('/').filter((part, i, all) => all.slice(0, i + 1).every((p) => !/[*?]/.test(p))).join('/')));
  const files = new Map();
  for (const top of tops) {
    const at = path.join(scope.root, top);
    // A glob that names one file walks just that file.
    const names = fs.statSync(at, { throwIfNoEntry: false })?.isFile() ? [''] : readdirOr(at);
    for (const name of names) {
      const file = path.posix.join(top, String(name).split(path.sep).join('/'));
      if (!SOURCE.test(file) || !inScope(file, scope)) continue;
      const bytes = readSource(path.join(scope.root, file));
      if (bytes) files.set(file, bytes);
    }
  }
  snapshot(dir, files, new Map([['closed.jsonl', readBytes(closures)]]));
}

/** Contents of `files` at HEAD in `repo`, read with one git process. */
function readAtHead(repo, files) {
  const out = spawnSync('git', ['-C', repo, 'cat-file', '--batch'], { input: files.map((f) => `HEAD:${f}\n`).join(''), maxBuffer: 1 << 30 });
  if (out.status !== 0) throw new Error(`git cat-file in ${repo}: ${out.stderr}`);
  const found = new Map();
  let at = 0;
  for (const file of files) {
    const end = out.stdout.indexOf(10, at);
    const header = /^\S+ (\w+) (\d+)$/.exec(out.stdout.toString('utf8', at, end)); // "<sha> <type> <size>", or "... missing"
    at = end + 1;
    if (!header) continue;
    if (header[1] === 'blob') found.set(file, out.stdout.subarray(at, at + Number(header[2])));
    at += Number(header[2]) + 1;
  }
  return found;
}

/**
 * Appends to `to` the lines perch added to `from` during a run, where `before` is what `from` held
 * when the run started. perch only appends closed issues, and so does this: a whole-file copy back
 * would drop issues that another checkout closed in the meantime.
 */
function appendNew(from, before, to) {
  const now = readBytes(from);
  if (now.equals(before)) return;
  if (now.length > before.length && now.subarray(0, before.length).equals(before)) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.appendFileSync(to, now.subarray(before.length));
  } else {
    console.error(`perch: ${from} was rewritten instead of added to, so its changes were not copied to ${to}.`);
  }
}

function readBytes(file, fallback = Buffer.alloc(0)) {
  try {
    return fs.readFileSync(file);
  } catch {
    return fallback;
  }
}

function readdirOr(dir) {
  try {
    return fs.readdirSync(dir, { recursive: true });
  } catch {
    return [];
  }
}

function writeIfChanged(file, bytes) {
  if (readBytes(file, null)?.equals(bytes)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

module.exports = { parseArgs, plan, asksJev, inScope, readDay, holdLock, snapshotRepo, snapshotShared, appendNew, readBytes };
