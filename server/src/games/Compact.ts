/**
 * Keeps the volume from filling up. Each round leaves its raw replays in results/arena-r<K>/games/<id>.jsonl (about
 * 160 MB for a round of 630 games, on a 3 GB volume); the window keeps its own gzipped copy of every replay it was
 * pushed. So the replays of older rounds are gzipped in place, as <id>.jsonl.gz (about a 25th of the size), once the
 * window holds the same replay. Nothing is deleted that is not kept gzipped next to it.
 *
 * A round is compacted only when all of these hold:
 * - it is not one of the two newest round folders: `gamesctl push` sends those two, and only the newest is ever played
 *   or resumed again;
 * - its folder has no referee.lock, its ladder.json says done, and games.db, when it has the round, says done;
 * - the window's copy has the same size (`GET /api/replays/<run>?sizes=1`, the uncompressed text): a replay the window
 *   lacks or holds at another size stays as it is, and the log names how many.
 *
 * Each replay is read without following a link (a regular file of at most 64 MB), gzipped, unzipped again and compared
 * with what was read, written to <id>.jsonl.gz.<hex>.tmp (0644, root), fsynced and renamed over <id>.jsonl.gz; then
 * the .jsonl is removed. A pass stops between two replays when a round is queued or plays, or when the machine stops,
 * and the next pass goes on from there: a .tmp left in a round it compacts is removed, and a replay found both plain
 * and gzipped is gzipped again. Passes run once a boot after warm and after each round that finished; one at a time.
 * The gzip runs on libuv's thread pool, so the server keeps answering while a pass runs.
 *
 * Readers of a compacted round: the replay check (Replay.ts) and bot/trace.js read <id>.jsonl.gz as well; push.js and
 * the window's put_run read only .jsonl, which is why only replays the window already holds are compacted.
 */
import { constants, closeSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs"
import { open } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import path from "node:path"
import { promisify } from "node:util"
import { gunzip, gzip } from "node:zlib"
import { Effect } from "effect"
import type { GamesConfig } from "./Config.ts"
import * as Log from "./Log.ts"
import type { StoreService } from "./Store.ts"
import { request } from "./WindowProxy.ts"

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

/** The largest replay compacted (Replay.ts reads no larger one); a larger file stays as it is. */
export const MAX_REPLAY_BYTES = 64 << 20
const ROUND = /^arena-r(\d+)$/
const SIZES_MS = 30_000

/** The round folders a pass may compact: arena-r<K> by K, without the `keep` newest. */
export const candidates = (names: ReadonlyArray<string>, keep: number): Array<{ readonly k: number; readonly run: string }> => {
  const rounds = names.flatMap((n) => {
    const m = ROUND.exec(n)
    return m && String(Number(m[1])) === m[1] ? [{ k: Number(m[1]), run: n }] : []
  }).sort((a, b) => a.k - b.k)
  return rounds.slice(0, Math.max(0, rounds.length - keep))
}

/** The window's answer to `GET /api/replays/<run>?sizes=1`: each replay's size, or null when it is not that list. */
export const parseSizes = (body: string): Map<string, number> | null => {
  let doc: unknown
  try {
    doc = JSON.parse(body)
  } catch {
    return null
  }
  const list = (doc as { result?: unknown } | null)?.result
  if (!Array.isArray(list)) return null
  const out = new Map<string, number>()
  for (const x of list) {
    if (x && typeof x === "object" && typeof (x as { id?: unknown }).id === "string" && Number.isSafeInteger((x as { size?: unknown }).size)) {
      out.set((x as { id: string }).id, (x as { size: number }).size)
    }
  }
  return out
}

export interface RoundReport {
  readonly run: string
  /** replays gzipped by this pass */
  readonly gzipped: number
  /** bytes before and after */
  readonly from: number
  readonly to: number
  /** replays left plain: the window lacks them or holds another size, or they are not ones this pass reads */
  readonly kept: number
  /** stale .tmp files removed */
  readonly cleaned: number
  /** why the round was not compacted, when it was not */
  readonly skipped: string | null
}

export interface PassReport {
  readonly rounds: ReadonlyArray<RoundReport>
  /** the pass stopped early (a round started, or the machine stops) */
  readonly cut: boolean
}

export interface CompactorOptions {
  readonly config: GamesConfig
  /** the window token (the window answers sizes to it) */
  readonly token: () => string | null
  readonly store: Pick<StoreService, "round">
  /** a round is queued or plays: a pass stops between two replays */
  readonly busy: () => boolean
  readonly isStopping: () => boolean
  /** the window's replay sizes for a run (default: GET /api/replays/<run>?sizes=1 with the token); null: no answer */
  readonly windowSizes?: (run: string) => Promise<Map<string, number> | null>
  /** the newest round folders never compacted (default 2) */
  readonly keep?: number
}

export interface Compactor {
  /** a pass soon, unless one runs (then one more after it) */
  readonly poke: () => void
  /** a pass runs now */
  readonly running: () => boolean
  /** one pass, now; resolves with what it did (a pass already running is waited for first) */
  readonly pass: () => Promise<PassReport>
  /** no more passes; resolves when the one running stopped between two replays */
  readonly stop: () => Promise<void>
}

const errno = (e: unknown) => (e as NodeJS.ErrnoException).code ?? (e as Error).message

/** A regular file read without following a link, or null (gone, a link, another kind of file, too large). */
const readRegular = (file: string): Buffer | null => {
  let fd: number
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > MAX_REPLAY_BYTES) return null
    const buf = readFileSync(fd)
    return buf.length === st.size ? buf : null
  } finally {
    closeSync(fd)
  }
}

/** gzips one replay in place: <id>.jsonl -> <id>.jsonl.gz (atomic), then removes the .jsonl. Returns the gzip's size. */
export const gzipReplay = async (file: string, text: Buffer): Promise<number> => {
  const gz = await gzipAsync(text, { level: 9 })
  const back = await gunzipAsync(gz, { maxOutputLength: MAX_REPLAY_BYTES })
  if (!back.equals(text)) throw new Error("the gzip did not unzip to the same bytes")
  const target = `${file}.gz`
  const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`
  const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
  try {
    await fh.writeFile(gz)
    await fh.chmod(0o644)
    await fh.sync()
  } catch (e) {
    await fh.close().catch(() => {})
    try {
      unlinkSync(tmp)
    } catch {
      // already gone
    }
    throw e
  }
  await fh.close()
  renameSync(tmp, target)
  unlinkSync(file)
  return gz.length
}

const defaultSizes = (c: GamesConfig, token: () => string | null) => async (run: string): Promise<Map<string, number> | null> => {
  if (!c.window) return null
  const t = token()
  try {
    const answer = await request(c.window, `/api/replays/${encodeURIComponent(run)}?sizes=1`, {
      method: "GET",
      headers: t ? { authorization: `Bearer ${t}` } : {},
      timeoutMs: SIZES_MS,
      maxBytes: 16 << 20
    })
    return answer.status === 200 ? parseSizes(answer.body.toString("utf8")) : null
  } catch {
    return null
  }
}

const readJson = (file: string): unknown => {
  const buf = readRegular(file)
  if (!buf) return null
  try {
    return JSON.parse(buf.toString("utf8"))
  } catch {
    return null
  }
}

export const makeCompactor = (o: CompactorOptions): Compactor => {
  const c = o.config
  const keep = o.keep ?? 2
  const windowSizes = o.windowSizes ?? defaultSizes(c, o.token)
  let current: Promise<PassReport> | null = null
  let again = false
  let stopped = false
  let warnedWindow = false
  // the rounds whose plain replays were named once this boot (each pass would name them again)
  const named = new Set<string>()

  const halt = () => stopped || o.isStopping() || o.busy()

  /** Why round k may not be compacted, or null. */
  const notDone = async (k: number, dir: string): Promise<string | null> => {
    if (lstatSync(path.join(dir, "referee.lock"), { throwIfNoEntry: false })) return "it holds referee.lock"
    const ladder = readJson(path.join(dir, "ladder.json")) as { status?: unknown } | null
    if (!ladder || ladder.status !== "done") return "its ladder.json does not say done"
    try {
      const row = await Effect.runPromise(o.store.round(k).pipe(Effect.provide(Log.layer)))
      if (row && row.state !== "done") return `games.db says it is ${row.state}`
    } catch (e) {
      return `games.db cannot say (${(e as Error).message})`
    }
    return null
  }

  const compactRound = async (k: number, run: string): Promise<RoundReport> => {
    const dir = path.join(c.paths.results, run)
    const games = path.join(dir, "games")
    const report = { run, gzipped: 0, from: 0, to: 0, kept: 0, cleaned: 0, skipped: null as string | null }
    const st = lstatSync(games, { throwIfNoEntry: false })
    if (!st || !st.isDirectory()) return { ...report, skipped: "it has no games folder" }
    const names = readdirSync(games)
    const plain = names.filter((n) => n.endsWith(".jsonl"))
    const stale = names.filter((n) => n.endsWith(".tmp"))
    if (plain.length === 0 && stale.length === 0) return report
    const why = await notDone(k, dir)
    if (why) return { ...report, skipped: why }
    for (const n of stale) {
      const f = path.join(games, n)
      if (lstatSync(f, { throwIfNoEntry: false })?.isFile()) {
        try {
          unlinkSync(f)
          report.cleaned++
        } catch (e) {
          Log.warn(`compact: could not remove ${f} (${errno(e)})`)
        }
      }
    }
    if (plain.length === 0) return report
    const sizes = await windowSizes(run)
    if (sizes === null) {
      if (!warnedWindow) Log.warn(`compact: the window did not say which replays of ${run} it holds; old rounds stay as they are`)
      warnedWindow = true
      return { ...report, kept: plain.length, skipped: "the window did not answer" }
    }
    for (const n of plain) {
      if (halt()) break
      const file = path.join(games, n)
      const text = readRegular(file)
      if (text === null || sizes.get(n.slice(0, -".jsonl".length)) !== text.length) {
        report.kept++
        continue
      }
      try {
        report.to += await gzipReplay(file, text)
        report.from += text.length
        report.gzipped++
      } catch (e) {
        report.kept++
        Log.warn(`compact: could not gzip ${file} (${errno(e)})`)
      }
    }
    return report
  }

  const runPass = async (): Promise<PassReport> => {
    const rounds: Array<RoundReport> = []
    let names: Array<string>
    try {
      names = readdirSync(c.paths.results)
    } catch {
      return { rounds, cut: false }
    }
    for (const { k, run } of candidates(names, keep)) {
      if (halt()) return { rounds, cut: true }
      let r: RoundReport
      try {
        r = await compactRound(k, run)
      } catch (e) {
        Log.warn(`compact: ${run}: ${errno(e)}`)
        continue
      }
      rounds.push(r)
      const kept = r.kept > 0 && r.skipped === null && !named.has(run)
      if (kept) named.add(run)
      if (r.gzipped > 0 || r.cleaned > 0) {
        const mb = (b: number) => (b / 1e6).toFixed(1)
        Log.info(`compact: ${run}: gzipped ${r.gzipped} replays, ${mb(r.from)} MB to ${mb(r.to)} MB${r.kept ? `; ${r.kept} kept plain (the window lacks them or holds another size)` : ""}${r.cleaned ? `; removed ${r.cleaned} stale .tmp` : ""}`)
      } else if (kept) {
        Log.info(`compact: ${run}: ${r.kept} replays kept plain (the window lacks them or holds another size)`)
      }
    }
    return { rounds, cut: halt() }
  }

  const pass = (): Promise<PassReport> => {
    if (current) return current.then(() => pass(), () => pass())
    const p = runPass().finally(() => {
      current = null
      const more = again && !stopped && !o.isStopping()
      again = false
      if (more) poke()
    })
    current = p
    return p
  }

  function poke() {
    if (stopped || o.isStopping()) return
    if (current) {
      again = true
      return
    }
    pass().catch((e) => Log.warn(`compact: ${(e as Error).message}`))
  }

  const stop = async () => {
    stopped = true
    again = false
    await current?.catch(() => {})
  }

  return { poke, running: () => current !== null, pass, stop }
}
