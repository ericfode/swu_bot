/**
 * A round's result files, `<results>/arena-r<K>/`, as ladder.js wrote them, so the window, the app, push.js and
 * referee.js publish read them as before (ladder.js is the spec; field order follows it):
 *   index.json        {id, createdAt, engine, bots, gamesPerPairing, games}: each game as it starts and ends, no think
 *                     or botStats (tournament.js's index, Holotable's TournamentIndex)
 *   ladder.json       ladder-report.js summarize(...) of the same games with think and botStats, plus `remote` (helpers)
 *   games/<id>.jsonl  each game's replay; while a game plays here its lines come in as play-seed writes them (once
 *                     the round is two rounds old and the window holds it, Compact.ts gzips it to <id>.jsonl.gz)
 *   referee.lock      {pid, host, pidns, startedAt}, touched while the round plays (api.js tells the window's phase by
 *                     its age)
 * A seed's key goes into its games' entries and replays' end lines only once every game of the seed has ended (the
 * seat-swapped games share one deal: an early key would give away the hidden cards of the game still playing).
 * Every file is replaced in one step (a temporary file, then rename). The folder is root's and the files world-readable:
 * the bots' user's push reads them, and nothing here writes through a link someone else could have put there.
 */
import { randomBytes } from "node:crypto"
import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync,
  renameSync, rmSync, utimesSync, writeSync
} from "node:fs"
import { hostname } from "node:os"
import path from "node:path"
import type { ArenaJs } from "./Js.ts"
import type { GameResult, Host, Limits, RemoteStats, RoundSpec, ScheduledGame } from "./Types.ts"

/** ladder.js ids of the arena's rounds (referee.js ladderIdOf) */
export const ladderId = (k: number) => `arena-r${k}`

/** The largest ladder.json or index.json read back (an old round's, to import it). */
const MAX_DOC_BYTES = 64 << 20

/** Replaces `file` with `text` in one step: a new temporary file (never through a link), world-readable, renamed. */
export const writeAtomic = (file: string, text: string | Uint8Array) => {
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`
  let fd: number | null = null
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
    fchmodSync(fd, 0o644)
    const buf = typeof text === "string" ? Buffer.from(text, "utf8") : text
    let at = 0
    while (at < buf.length) at += writeSync(fd, buf, at, buf.length - at)
    closeSync(fd)
    fd = null
    renameSync(tmp, file)
  } catch (e) {
    if (fd !== null) closeSync(fd)
    rmSync(tmp, { force: true })
    throw e
  }
}

/** A file's text when it is a regular file reached without a link at its last step (and not a FIFO); else null. */
export const readRegular = (file: string, max = MAX_DOC_BYTES): string | null => {
  let fd: number
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > max) return null
    return readFileSync(fd, "utf8")
  } finally {
    closeSync(fd)
  }
}

/** A folder made if missing, refused when something else (a link) is there, root's mode 0755. */
const folder = (dir: string) => {
  mkdirSync(dir, { recursive: true, mode: 0o755 })
  if (!lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a folder (a link?): the round does not write through it`)
  try {
    chmodSync(dir, 0o755)
  } catch {
    // not ours to change (a test's folder): it stays as it is
  }
}

/** The PID namespace this process is in: pids in the lock mean something only inside one. */
const pidns = (() => {
  try {
    return readlinkSync("/proc/self/ns/pid")
  } catch {
    return null
  }
})()

/** ladder.js config.decks for a round's lists: the file, its sha256, the lists dealt, by seat, and those left out. */
export const deckRule = (decks: RoundSpec["decks"]) =>
  decks
    ? { file: decks.file, sha256: decks.sha256, names: [...decks.names], deal: "seat", ...(decks.skipped.length ? { skipped: [...decks.skipped] } : {}) }
    : null

/**
 * ladder.js config (bot/ladder.js main): what the round plays by. harness, engineDiff and programs are what ladder.js
 * reads from git, null on the image (no .git) as in every hosted round so far. `key` joins once the round is done.
 */
export const ladderConfig = (o: {
  readonly spec: Pick<RoundSpec, "bots" | "gamesPerPair" | "decks" | "placement">
  readonly firstSeed: number
  readonly workers: number
  readonly limits: Limits
  readonly keyId: string | null
}): Record<string, unknown> => {
  const decks = deckRule(o.spec.decks)
  return {
    bots: [...o.spec.bots],
    gamesPerPair: o.spec.gamesPerPair,
    firstSeed: o.firstSeed,
    maxSteps: o.limits.maxSteps,
    workers: o.workers,
    capMs: o.limits.capMs,
    hangMs: o.limits.hangMs,
    harness: null,
    engineDiff: null,
    programs: null,
    keyId: o.keyId,
    record: true,
    ...(o.spec.placement ? { placement: o.spec.placement } : {}),
    ...(decks ? { decks } : {})
  }
}

/** A game's entry when it starts (ladder.js onStart): a game that starts again (a lost lease) starts over. */
const startEntry = (g: ScheduledGame, deckNames: ReadonlyArray<string> | null): Record<string, unknown> => ({
  id: g.id, seed: g.seed, p1: g.p1, p2: g.p2, winner: null, winnerSeat: null, outcome: "running", rounds: 0, steps: 0, ms: 0, error: null,
  by: null, faultKind: null, host: null,
  ...(g.decks && deckNames ? { decks: { p1: deckNames[g.decks[0]], p2: deckNames[g.decks[1]] } } : {})
})

/** What a result adds to both entries (ladder.js onResult). */
const doneFields = (r: GameResult, host: Host): Record<string, unknown> => ({
  winner: r.winner ?? null, winnerSeat: r.winnerSeat ?? null, outcome: r.outcome, rounds: r.round, steps: r.steps, ms: r.ms, error: r.error ?? null,
  by: r.by ?? null, faultKind: r.faultKind ?? null, timing: r.timing ?? null, host, ...(r.versions ? { versions: r.versions } : {})
})

/** The end line of a replay with the game's key on it (ladder.js addReplayKey); null when it has none to take one. */
export const withReplayKey = (text: string, key: string): string | null => {
  const i = text.lastIndexOf("\n", text.length - 2) + 1
  let end: any
  try {
    end = JSON.parse(text.slice(i))
  } catch {
    return null
  }
  if (end?.t !== "end" || end.key) return null
  return `${text.slice(0, i)}${JSON.stringify({ ...end, key })}\n`
}

export interface RoundFilesOptions {
  readonly results: string
  readonly k: number
  readonly createdAt: string
  readonly config: Record<string, unknown>
  readonly botInfo: Readonly<Record<string, Record<string, unknown>>>
  readonly scheduled: number
  /** the round's deck list names (entries name each game's two), or null for random decks */
  readonly deckNames: ReadonlyArray<string> | null
  readonly summarize: ArenaJs["summarize"]
}

export interface RoundFiles {
  readonly dir: string
  readonly id: string
  /** games started (entries running, host null even when a helper plays them, as ladder.js had it) */
  readonly start: (g: ScheduledGame) => void
  readonly finish: (g: ScheduledGame, r: GameResult, host: Host) => void
  /** the seed's key into a game's entries (once every game of its seed has ended) */
  readonly entryKey: (id: string, key: string) => void
  /** the key onto the end line of a game's replay, when it has one without a key */
  readonly replayKey: (id: string, key: string) => void
  /** a finished game's replay, whole (null: it has none, any earlier one goes) */
  readonly replay: (id: string, text: string | null) => void
  /** lines of a game playing here, at byte `from` of its replay (0 starts it anew) */
  readonly lines: (id: string, from: number, text: string) => void
  /** what ladder.json says about helpers, read at every write (null: no `remote`, the helper node is off) */
  readonly remote: (stats: () => RemoteStats | null) => void
  /** the round is done: status done and the run key in its config */
  readonly done: (key: string | null) => void
  /** index.json and ladder.json written anew; the ladder document */
  readonly write: () => Record<string, any>
  readonly lock: () => void
  readonly touchLock: () => void
  readonly unlock: () => void
}

export const openRoundFiles = (o: RoundFilesOptions): RoundFiles => {
  const id = ladderId(o.k)
  const dir = path.join(o.results, id)
  const gamesDir = path.join(dir, "games")
  const lockFile = path.join(dir, "referee.lock")
  folder(o.results)
  folder(dir)
  folder(gamesDir)
  const config = { ...o.config }
  let status = "running"
  let remote: () => RemoteStats | null = () => null
  // the ladder's games (with think and botStats) and the index's, in the order they started (ladder.js pushes at start)
  const games: Array<Record<string, unknown>> = []
  const index: Array<Record<string, unknown>> = []
  const at = (list: Array<Record<string, unknown>>, gid: string) => list.find((e) => e.id === gid)
  const replayFile = (gid: string) => {
    // ids are play-seed GAME_IDs (no slash, no leading dot); checked again, as a name that leaves the folder is never written
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.#-]{0,199}$/.test(gid)) throw new Error(`${JSON.stringify(gid)} is not a game id`)
    return path.join(gamesDir, `${gid}.jsonl`)
  }

  const start = (g: ScheduledGame) => {
    const entry = startEntry(g, o.deckNames)
    const i = games.findIndex((e) => e.id === g.id)
    if (i < 0) {
      games.push(entry)
      index.push({ ...entry })
    } else {
      games[i] = entry
      index[index.findIndex((e) => e.id === g.id)] = { ...entry }
    }
  }

  const finish = (g: ScheduledGame, r: GameResult, host: Host) => {
    if (!at(games, g.id)) start(g)
    const done = doneFields(r, host)
    Object.assign(at(games, g.id)!, done, { think: r.think ?? null, botStats: r.botStats })
    Object.assign(at(index, g.id)!, done)
  }

  const entryKey = (gid: string, key: string) => {
    for (const list of [games, index]) {
      const e = at(list, gid)
      if (e) e.key = key
    }
  }

  const replayKey = (gid: string, key: string) => {
    const file = replayFile(gid)
    const text = readRegular(file)
    const keyed = text === null ? null : withReplayKey(text, key)
    if (keyed !== null) writeAtomic(file, keyed)
  }

  const replay = (gid: string, text: string | null) => {
    if (text === null) rmSync(replayFile(gid), { force: true })
    else writeAtomic(replayFile(gid), text)
    // a gzipped copy (Compact.ts) of an earlier play would disagree with this one; only old rounds are gzipped, so
    // this is a guard
    rmSync(`${replayFile(gid)}.gz`, { force: true })
  }

  const lines = (gid: string, from: number, text: string) => {
    const file = replayFile(gid)
    if (from === 0) {
      writeAtomic(file, text)
      return
    }
    let fd: number
    try {
      fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    } catch {
      return
    }
    try {
      const st = fstatSync(fd)
      // only right after what came before (else the game's end writes it whole anyway)
      if (!st.isFile() || st.size !== from) return
      const buf = Buffer.from(text, "utf8")
      let w = 0
      while (w < buf.length) w += writeSync(fd, buf, w, buf.length - w)
    } finally {
      closeSync(fd)
    }
  }

  const write = () => {
    const doc = o.summarize({ id, createdAt: o.createdAt, status, engine: null, config, botInfo: { ...o.botInfo }, games, scheduled: o.scheduled })
    const stats = remote()
    if (stats) doc.remote = stats
    writeAtomic(path.join(dir, "ladder.json"), JSON.stringify(doc))
    writeAtomic(path.join(dir, "index.json"), JSON.stringify({ id, createdAt: o.createdAt, engine: null, bots: config.bots, gamesPerPairing: config.gamesPerPair, games: index }))
    return doc as Record<string, any>
  }

  const lock = () => {
    writeAtomic(lockFile, JSON.stringify({ pid: process.pid, host: hostname(), pidns, startedAt: new Date().toISOString() }))
  }
  const touchLock = () => {
    const now = new Date()
    try {
      if (lstatSync(lockFile).isFile()) {
        utimesSync(lockFile, now, now)
        return
      }
    } catch {
      // gone: made again below
    }
    lock()
  }
  const unlock = () => rmSync(lockFile, { force: true })

  return {
    dir,
    id,
    start,
    finish,
    entryKey,
    replayKey,
    replay,
    lines,
    remote: (f) => {
      remote = f
    },
    done: (key) => {
      status = "done"
      if (key) config.key = key
    },
    write,
    lock,
    touchLock,
    unlock
  }
}

/** What a game entry of an old ladder.json holds, as a result (the round imports the games a cut ladder finished). */
export const resultOfEntry = (e: Record<string, any>): GameResult => ({
  seed: e.seed, outcome: e.outcome, by: e.by ?? null, faultKind: e.faultKind ?? null, winner: e.winner ?? null, winnerSeat: e.winnerSeat ?? null,
  round: e.rounds, steps: e.steps, ms: e.ms, error: e.error ?? null, timing: e.timing ?? null, think: e.think ?? null, botStats: e.botStats ?? null,
  ...(e.key ? { key: e.key } : {}), ...(e.versions ? { versions: e.versions } : {})
})
