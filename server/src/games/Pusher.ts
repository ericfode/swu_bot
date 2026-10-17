/**
 * Sends the arena's state, standings and round replays to the window (`gamesctl push`, through the proxy's push
 * nonce) every 20 s and when poked, from the first poke on: the scheduler pokes it once setup is done (Coord.Pusher).
 *
 * While a round plays it also sends the playing round's index and replays every 3 s (`gamesctl push --only round`,
 * roundTickMs), so viewers follow each game move by move. A poke is a full push, and so is any push 20 s or more after
 * the last full one. A round push is skipped when the round's folder (its index and each replay's size and time) is as
 * the last push that worked left it: a push costs CPU, and the bots' thinking time is wall-clock. Never two pushes at
 * once (they would write the same state file). Once the machine stops, `stop` makes one last full push of at most 7 s,
 * after the round has stopped, so the window sees a cut round's last state.
 */
import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { Cause, Effect, Exit } from "effect"
import type { Exit as ExitT } from "effect"
import type { GamesConfig } from "./Config.ts"
import type { GamesctlFailed, GamesctlService } from "./Gamesctl.ts"
import * as Log from "./Log.ts"
import type { Kind, ProcService } from "./Proc.ts"

/** every kind but push: `stopAll` with these kept stops the pushes only */
const ALL_BUT_PUSH: ReadonlyArray<Kind> = ["setup", "warm", "plan", "round", "publish", "intake", "play", "decks"]

/**
 * The newest round's folder as it stands: a digest of its index and each replay's size and time, or null when there
 * is no round folder. (ladder.json is not in it, as before: the next full push, at most 20 s later, sends it.)
 */
export const roundMark = (results: string, arena = "open"): string | null => {
  let newest: { k: number; dir: string } | null = null
  try {
    for (const name of readdirSync(results)) {
      const m = (arena === "open" ? /^arena-r(\d+)$/ : /^arena-v2-r(\d+)$/).exec(name)
      if (m && (newest === null || Number(m[1]) > newest.k)) newest = { k: Number(m[1]), dir: path.join(results, name) }
    }
  } catch {
    return null
  }
  if (newest === null) return null
  let games: Array<string> = []
  try {
    games = readdirSync(path.join(newest.dir, "games")).filter((f) => f.endsWith(".jsonl")).sort()
  } catch {
    // no games yet
  }
  const files = [path.join(newest.dir, "index.json"), ...games.map((g) => path.join(newest!.dir, "games", g))]
  const parts = files.map((f) => {
    try {
      const st = statSync(f)
      return [f, st.size, st.mtimeMs]
    } catch {
      return [f, null]
    }
  })
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex")
}

export interface PusherOptions {
  readonly config: GamesConfig
  readonly gamesctl: Pick<GamesctlService, "push">
  readonly proc: Pick<ProcService, "stopAll">
  /** the proxy's push address (SWU_WINDOW for the child) */
  readonly url: () => string
  /** a round is playing now */
  readonly playing: () => boolean
  /** the machine is stopping: failures are not reported any more */
  readonly isStopping: () => boolean
  /** the last push's time limit and its grace (Coord.Pusher: 6 s and 1 s) */
  readonly lastPushMs?: number
  readonly lastGraceMs?: number
  readonly now?: () => number
}

export interface Pusher {
  /** push now (or right after the push in progress); the first poke starts the pushes */
  readonly poke: () => void
  /** the push in progress stops, then one last full push (only when pushes ever started) */
  readonly stop: () => Promise<void>
  readonly started: () => boolean
}

const run = <A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(Log.layer)), { signal })

const describe = (exit: ExitT.Exit<boolean, GamesctlFailed>): string | null => {
  if (Exit.isSuccess(exit)) return exit.value ? null : "the window refused it (see gamesctl's log)"
  if (Cause.hasInterruptsOnly(exit.cause)) return "stopped"
  const e = Cause.squash(exit.cause)
  if (e && typeof e === "object" && "why" in e && typeof (e as GamesctlFailed).why === "string") return (e as GamesctlFailed).why
  return `crashed: ${e instanceof Error ? e.message : String(e)}`
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref())

export const makePusher = (o: PusherOptions): Pusher => {
  const c = o.config
  const now = o.now ?? (() => performance.now())
  let started = false
  let stopping = false
  let task: { readonly abort: AbortController; readonly done: Promise<void> } | null = null
  let again = false
  let timer: NodeJS.Timeout | null = null
  let failing = false
  let fullAt: number | null = null
  let poked = false
  let mark: string | null = null
  let sentMark: string | null = null

  const arm = (ms: number) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      pushNow()
    }, ms)
    timer.unref()
  }

  // gamesctl logs why a push failed; this only says when pushing starts or stops failing, not every 20 s
  const report = (why: string | null) => {
    if (why === null) {
      if (failing) Log.info("push works again")
      failing = false
      return
    }
    if (!failing && !o.isStopping()) Log.warn(`push failed: ${why}`)
    failing = true
  }

  const start = (only: "round" | null) => {
    const abort = new AbortController()
    // the push child's state file lives here (and isolate.sh's /tmp for the push is the same folder)
    try {
      mkdirSync(path.join(c.paths.tmp, "push"), { recursive: true })
    } catch {
      // gamesctl says what is wrong
    }
    const pushed = mark
    const done = run(o.gamesctl.push(o.url(), only), abort.signal).then((exit) => {
      task = null
      if (stopping) return
      const why = describe(exit)
      sentMark = why === null ? pushed : null
      report(why)
      afterPush()
    })
    task = { abort, done }
  }

  const pushNow = () => {
    if (stopping) return
    if (task) {
      again = true
      return
    }
    if (timer) clearTimeout(timer)
    timer = null
    const t = now()
    const playing = o.playing()
    const full = poked || fullAt === null || t - fullAt >= c.timing.tickMs || !playing
    const m = playing ? roundMark(c.paths.results, c.arena) : null
    if (full) {
      fullAt = t
      mark = m
      again = false
      poked = false
      start(null)
    } else if (m !== null && m === sentMark) {
      arm(c.timing.roundTickMs)
    } else {
      mark = m
      again = false
      start("round")
    }
  }

  const afterPush = () => {
    if (again) pushNow()
    else arm(o.playing() ? c.timing.roundTickMs : c.timing.tickMs)
  }

  const stop = async () => {
    if (stopping) return
    stopping = true
    if (timer) clearTimeout(timer)
    timer = null
    if (!started) return
    if (task) {
      // TERM now and KILL after half a second (the push's own grace is longer), then let its run end
      const going = task
      void run(o.proc.stopAll(ALL_BUT_PUSH, 500))
      going.abort.abort()
      await Promise.race([going.done, sleep(3_000)])
    }
    Log.info("last push")
    try {
      mkdirSync(path.join(c.paths.tmp, "push"), { recursive: true })
    } catch {
      // gamesctl says what is wrong
    }
    const limit = setTimeout(() => void run(o.proc.stopAll(ALL_BUT_PUSH, o.lastGraceMs ?? 1_000)), o.lastPushMs ?? 6_000)
    try {
      await run(o.gamesctl.push(o.url(), null))
    } finally {
      clearTimeout(limit)
    }
  }

  return {
    poke: () => {
      if (stopping) return
      started = true
      poked = true
      pushNow()
    },
    stop,
    started: () => started
  }
}
