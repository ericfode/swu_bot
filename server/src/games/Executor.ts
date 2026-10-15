/**
 * Plays one job here: `node bot/arena/play-seed.js` as the bots' user, inside isolate.sh, in a work folder of its own,
 * `<work>/<tag>/`. The folder is root's; in it `job.json` is root's and read-only to the child, and `out/` (the replays
 * the child writes) and `arena/` (the versions it unpacks) are the bots' user's. The server reads back only
 * `out/<game id>.jsonl`: opened without following a link and without blocking on a FIFO, checked to be one regular
 * file of the bots' user under the size cap, read as text, copied. The folder goes when the job ends, however it ends.
 * Nothing else the child can write outlives it: its HOME (`<data>/home`) and the wasm cache are root's, and the cache
 * holds only what root compiled (warmBundles, gamesctl warm and round).
 *
 * No NODE_ENV for the child: the engine words its prompts by it (bot/env.js makes an unset one 'test'), so a replay
 * matches the rounds played so far only under 'test' (and production logs every rollback a searching bot makes).
 */
import { execFileSync, spawnSync } from "node:child_process"
import {
  chmodSync, chownSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, writeFileSync
} from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import type { GamesConfig } from "./Config.ts"
import { scripts } from "./Config.ts"
import * as Log from "./Log.ts"
import type { ProcService, Result, RunOptions } from "./Proc.ts"
import { childEnv, lastLine } from "./Proc.ts"
import type { GameResult, PlaySeedJob, Played } from "./Types.ts"

export class PlayFailed extends Error {
  readonly seed: number
  readonly why: string
  readonly stopped: boolean
  constructor(seed: number, why: string, stopped = false) {
    super(`seed ${seed}: ${why}`)
    this.seed = seed
    this.why = why
    this.stopped = stopped
  }
}

/**
 * A replay the server takes, at most (remote-lane.js MAX_REPLAY_BYTES, what a helper may send: the longest game so far
 * is ~14 MB of text, and the window takes up to 32 MB). A longer one is left out, its game kept.
 */
export const MAX_REPLAY_BYTES = 32 << 20
/** play-seed's answer line: results with their botStats and timing, no replay text */
const MAX_ANSWER_BYTES = 16 << 20
/** play-seed.js MAX_GAMES */
export const MAX_JOB_GAMES = 8
/** the time past a job's own game limit that unpacking, loading the engine and writing out may take */
const SLACK_MS = 120_000

const OUTCOMES = ["won", "ERROR", "STEP_CAP", "STUCK"]

export interface PlayOptions {
  /**
   * The replays as they grow, so a game can be watched while it plays (the window's live board): `text` is whole new
   * lines, to go at byte `from` of the game's replay (from 0 means a new file). Called from a timer; must not throw.
   */
  readonly onLines?: (id: string, from: number, text: string) => void
  /** how often the replays are read for onLines (default 2 s) */
  readonly everyMs?: number
}

/** A job's folder. Tags are file names: the round's are `r<K>-<seed>-<n>`. */
export const workDir = (c: GamesConfig, tag: string) => path.join(c.paths.work, tag)

const isRoot = () => process.getuid?.() === 0

const users = new Map<string, { uid: number; gid: number } | null>()
/** The bots' user's ids, when this process is root (null otherwise: then the folders stay this process's own). */
const arenaIds = (c: GamesConfig) => {
  if (!isRoot()) return null
  if (!users.has(c.arenaUser)) {
    try {
      const id = (flag: string) => Number(execFileSync("id", [flag, c.arenaUser], { encoding: "utf8", timeout: 5000 }).trim())
      users.set(c.arenaUser, { uid: id("-u"), gid: id("-g") })
    } catch {
      users.set(c.arenaUser, null)
    }
  }
  const ids = users.get(c.arenaUser)
  if (!ids) throw new Error(`no user ${c.arenaUser} to play as`)
  return ids
}

const plain = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x)
const count = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 0
const message = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 300)

/**
 * A file the child wrote, opened for reading: regular, not a link at its last step (O_NOFOLLOW), not a FIFO that
 * would block the open (O_NONBLOCK), one name only (a hard link could name a file the child may not read), and the
 * bots' user's when this process is root. null when there is no such file; throws when something else is there.
 */
const openChildFile = (file: string, owner: number | null): { fd: number; size: number } | null => {
  let fd: number
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
    throw new Error(`${path.basename(file)} is not a file the server reads (${(e as NodeJS.ErrnoException).code ?? "?"})`)
  }
  const st = fstatSync(fd)
  if (!st.isFile() || st.nlink !== 1 || (owner !== null && st.uid !== owner)) {
    closeSync(fd)
    throw new Error(`${path.basename(file)} is not a plain file of the bots' user`)
  }
  return { fd, size: st.size }
}

/** Bytes [from, to) of an open file. */
const readRange = (fd: number, from: number, to: number) => {
  const buf = Buffer.alloc(Math.max(0, to - from))
  let at = 0
  while (at < buf.length) {
    const n = readSync(fd, buf, at, buf.length - at, from + at)
    if (n === 0) break
    at += n
  }
  return buf.subarray(0, at)
}

/**
 * Removes a folder the bots' user can write into (home.js removeTree). GNU rm walks it with fts and never follows a
 * link it meets inside; Node's rmSync resolves each path again, so a bots' process could swap a subfolder for a link
 * between two steps and have root remove what the link points at (games.db, the round-seed secret).
 */
export const removeTree = (dir: string) => {
  spawnSync("rm", ["-rf", "--", dir], { stdio: "ignore" })
  if (existsSync(dir)) Log.warn(`could not remove ${dir}; the next round's start or setup clears it`)
}

/** The folder, the job file and the child's two folders, each with its owner and mode. */
const prepare = (c: GamesConfig, dir: string, job: PlaySeedJob) => {
  const ids = arenaIds(c)
  removeTree(dir)
  mkdirSync(c.paths.work, { recursive: true })
  mkdirSync(dir, { mode: 0o755 })
  chmodSync(dir, 0o755)
  const jobFile = path.join(dir, "job.json")
  writeFileSync(jobFile, JSON.stringify(job), { mode: 0o644, flag: "wx" })
  chmodSync(jobFile, 0o644)
  for (const sub of ["out", "arena"]) {
    const p = path.join(dir, sub)
    mkdirSync(p, { mode: 0o700 })
    chmodSync(p, 0o700)
    if (ids) chownSync(p, ids.uid, ids.gid)
  }
  return jobFile
}

/** What is wrong with one game's result as play-seed printed it, or null (the fields the round and its files read). */
const badResult = (r: unknown): string | null => {
  if (!plain(r)) return "not an object"
  if (!OUTCOMES.includes(r.outcome)) return `outcome ${JSON.stringify(r.outcome)?.slice(0, 40)}`
  if (!count(r.round) || !count(r.steps) || !(typeof r.ms === "number" && Number.isFinite(r.ms) && r.ms >= 0)) {
    return "round, steps and ms must be counts"
  }
  return null
}

/** Reads the replays of the job's games as they grow, every `everyMs`, and hands whole new lines to onLines. */
const watchReplays = (out: string, ids: ReadonlyArray<string>, owner: number | null, onLines: NonNullable<PlayOptions["onLines"]>, everyMs: number) => {
  const sent = new Map<string, number>()
  let warned = false
  const pass = () => {
    for (const id of ids) {
      try {
        const f = openChildFile(path.join(out, `${id}.jsonl`), owner)
        if (!f) continue
        try {
          let from = sent.get(id) ?? 0
          // rewritten (a fresh start of the game): from the top again
          if (f.size < from) from = 0
          if (f.size <= from || f.size > MAX_REPLAY_BYTES) continue
          const buf = readRange(f.fd, from, f.size)
          const end = buf.lastIndexOf(10) + 1
          if (end === 0) continue
          onLines(id, from, buf.subarray(0, end).toString("utf8"))
          sent.set(id, from + end)
        } finally {
          closeSync(f.fd)
        }
      } catch (e) {
        if (!warned) {
          warned = true
          Log.warn(`could not follow the replays of a job (${message(e)})`)
        }
      }
    }
  }
  const timer = setInterval(pass, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}

/** play-seed's answer, checked, with every replay read. Throws PlayFailed. */
const readAnswer = (job: PlaySeedJob, out: string, owner: number | null, r: Result, stopping: boolean): Played => {
  const fail = (why: string, stopped = stopping): never => {
    throw new PlayFailed(job.seed, why, stopped)
  }
  if (r.kind === "stopped") fail(r.reason, true)
  if (r.kind === "failed") fail(r.reason)
  if (r.kind === "timeout") fail("it ran past its time")
  if (r.kind === "exit" && r.code !== 0) fail(`play-seed exited ${r.code}`, stopping || r.code === 143)
  let doc: unknown
  try {
    doc = JSON.parse(lastLine(r.stdout))
  } catch {
    return fail("play-seed printed no JSON line")
  }
  if (!plain(doc) || doc.ok !== true || !Array.isArray(doc.results)) return fail("its answer is not {ok, results, replays}")
  const want = new Set(job.games.map((g) => g.id))
  const got = new Map<string, GameResult>()
  for (const e of doc.results as Array<unknown>) {
    if (!plain(e) || typeof e.id !== "string" || !want.has(e.id) || got.has(e.id)) return fail("its answer has a result for no game of the job, or two for one")
    const why = badResult(e.result)
    if (why) return fail(`${e.id}: its result is off (${why})`)
    got.set(e.id, e.result as GameResult)
  }
  const missing = job.games.filter((g) => !got.has(g.id)).map((g) => g.id)
  if (missing.length) fail(`no result for ${missing.join(", ")}`)
  const replays: Record<string, string> = {}
  for (const g of job.games) {
    let f: { fd: number; size: number } | null
    try {
      f = openChildFile(path.join(out, `${g.id}.jsonl`), owner)
    } catch (e) {
      return fail(message(e))
    }
    // a game whose bot failed to load has none
    if (!f) continue
    try {
      if (f.size > MAX_REPLAY_BYTES) {
        Log.warn(`${g.id}: its replay is over ${MAX_REPLAY_BYTES} bytes; the game is kept without it`)
        continue
      }
      replays[g.id] = readRange(f.fd, 0, f.size).toString("utf8")
    } finally {
      closeSync(f.fd)
    }
  }
  return { results: job.games.map((g) => ({ id: g.id, result: got.get(g.id)! })), replays }
}

/**
 * Plays `job` here and gives its results and replays, or fails with PlayFailed (stopped when the machine is stopping
 * or the run was stopped). Interrupted, it stops the child's whole group and removes the folder.
 */
export const playLocal = (c: GamesConfig, proc: ProcService, job: PlaySeedJob, tag: string, opts: PlayOptions = {}): Effect.Effect<Played, PlayFailed> => {
  const dir = workDir(c, tag)
  const out = path.join(dir, "out")
  return Effect.acquireUseRelease(
    Effect.try({
      try: () => prepare(c, dir, job),
      catch: (e) => new PlayFailed(job.seed, `its work folder could not be made (${message(e)})`)
    }),
    (jobFile) => {
      const owner = arenaIds(c)?.uid ?? null
      const stopWatch = opts.onLines
        ? watchReplays(out, job.games.map((g) => g.id), owner, opts.onLines, opts.everyMs ?? 2000)
        : () => {}
      return proc.run({
        kind: "play",
        argv: [c.node, scripts(c).playSeed, "--job", jobFile, "--bundles", c.paths.bundles, "--work", dir],
        env: childEnv(c, c.paths.home, { SWU_WASM_CACHE: c.paths.wasmCache }),
        as: "arena",
        isolate: true,
        // its own /tmp, gone with the folder
        tmp: path.join(dir, "tmp"),
        // play-seed keeps its own arena home in the work folder: the real one, the window's panels, the intake's checks
        // and other rounds' results are none of a game's business
        hide: [c.paths.arena, path.join(c.data, "dash"), path.join(c.data, "intake"), c.paths.results],
        ...(job.gameMs > 0 ? { timeoutMs: job.gameMs + SLACK_MS } : {}),
        stdout: "capture",
        maxStdout: MAX_ANSWER_BYTES
      }).pipe(
        Effect.ensuring(Effect.sync(stopWatch)),
        Effect.flatMap((r) =>
          Effect.try({
            try: () => readAnswer(job, out, owner, r, proc.isStopping()),
            catch: (e) => (e instanceof PlayFailed ? e : new PlayFailed(job.seed, message(e)))
          })
        )
      )
    },
    () => Effect.sync(() => removeTree(dir))
  )
}

/** play-seed.js --warm --bundles: per bundle, at most its own 2 minutes, and the start */
const warmMs = (n: number) => 60_000 + n * 120_000

/**
 * How to compile bundles (canonical tars `<c.paths.bundles>/<hex>.tar`) into the wasm cache before games that play them:
 * `play-seed.js --warm --bundles` as root, which unpacks each where only root reaches and compiles it (run.py --warm runs
 * nothing of the bot). No bot's clock pays for it, and the games, as the bots' user, only read the code root compiled.
 */
export const warmOptions = (c: GamesConfig, hexes: ReadonlyArray<string>, isolate: boolean): RunOptions => ({
  kind: "warm",
  argv: [c.node, scripts(c).playSeed, "--warm", "--bundles", c.paths.bundles, ...hexes],
  env: childEnv(c, c.paths.home, { SWU_WASM_CACHE: c.paths.wasmCache }),
  as: "root",
  isolate,
  timeoutMs: warmMs(hexes.length),
  stdout: "capture"
})

/** The bundles of `hexes` that a warm (warmOptions) did not compile: their games compile them, or fail as they would. */
export const notWarmed = (r: Result | null, hexes: ReadonlyArray<string>): ReadonlyArray<string> => {
  let doc: unknown = null
  try {
    doc = r?.kind === "exit" && r.code === 0 ? JSON.parse(lastLine(r.stdout)) : null
  } catch {}
  const warmed = new Set(plain(doc) && doc.ok === true && Array.isArray(doc.warmed) ? doc.warmed.filter((x): x is string => typeof x === "string") : [])
  return hexes.filter((x) => !warmed.has(x))
}

/** Compiles the bundles of `hexes` as warmOptions says, in isolate.sh; logs those it could not. */
export const warmBundles = (c: GamesConfig, proc: ProcService, hexes: ReadonlyArray<string>): Effect.Effect<void> => {
  if (hexes.length === 0) return Effect.void
  return proc.run(warmOptions(c, hexes, true)).pipe(
    Effect.map((r) => notWarmed(r, hexes)),
    Effect.flatMap((left) => Effect.sync(() => {
      if (left.length) Log.warn(`could not compile ${left.map((x) => x.slice(0, 12)).join(", ")} before their games`)
    }))
  )
}

/** Removes the job folders under <work> whose names `which` matches (left by an earlier run that did not finish). */
export const clearWork = (c: GamesConfig, which: RegExp) => {
  let names: Array<string>
  try {
    names = readdirSync(c.paths.work)
  } catch {
    return 0
  }
  let n = 0
  for (const name of names) {
    if (!which.test(name)) continue
    const p = path.join(c.paths.work, name)
    // rm does not follow links: a link left here goes, not what it points at
    if (lstatSync(p, { throwIfNoEntry: false })) {
      removeTree(p)
      n++
    }
  }
  return n
}
