/**
 * The dispatcher of one round: what ladder.js's worker pool and its remote lane (bot/remote-lane.js) did inside the
 * ladder. A queue holds the round's games still to play, in schedule order.
 * - Here: up to W games at once (Eric's "games at once", read at every dispatch). A free slot takes the game at the
 *   head of the queue and up to `free` games of its seed in all into one play-seed job (a seed's games share one deal
 *   and one key). A failed job's games go back to the front once; the same games failing again fail the round.
 * - On helpers, through the lease board, under remote-lane.js's rules: every tick, for each claim waiting, the
 *   offerable seed whose bots have had the fewest helper games (then the lowest seed) goes out whole. A seed is
 *   offerable while every game it had in the queue when the lane started is still queued (seat twins travel together),
 *   it was never lost, and each of its bots has its tar in the bundles folder. A done lease is checked whole
 *   (remote-lane.js checkDone) and recorded with the helper's name; a lost, unknown or invalid one, or one taken back
 *   (nothing left in the queue and running longer than 2 x the median game here, 10 min before any ended, + 60 s), plays
 *   here, and its seed never goes out again.
 * The lease board lives in this process, so the relay's failure modes (unreachable, 3 minutes, re-puts) are gone; the
 * stats keep their shape for the round report's Helpers line (relayErrors stays empty, stopped null).
 */
import { Cause, Effect, Fiber } from "effect"
import type { PlayFailed } from "./Executor.ts"
import { MAX_JOB_GAMES } from "./Executor.ts"
import type { ArenaJs } from "./Js.ts"
import { cleanResult } from "./Js.ts"
import * as Log from "./Log.ts"
import { bundlesForSeats, comparisonReplayProblem, comparisonResultProblem } from "./Comparison.ts"
import { protocolReplayError, protocolResultError } from "./Protocol.ts"
import { bySeed, jobFor } from "./Schedule.ts"
import type { GameResult, Host, LeaseBoard, Limits, PlaySeedJob, Played, RemoteStats, RoundSpec, ScheduledGame } from "./Types.ts"

/** remote-lane.js: the "median local game" before any finished here, and the slack on top of twice the median */
const TAKE_BACK_DEFAULT_MS = 10 * 60_000
const TAKE_BACK_SLACK_MS = 60_000
const HOST = /^[a-z][a-z0-9_-]{0,31}$/

export interface LaneResult {
  readonly game: ScheduledGame
  readonly result: GameResult
  /** the replay's text, or null when the game has none (a bot failed to load) */
  readonly replay: string | null
}

export type LaneEnd =
  | { readonly kind: "done" }
  | { readonly kind: "failed"; readonly why: string }
  | { readonly kind: "stopped"; readonly why: string }

export interface LaneDeps {
  readonly js: ArenaJs
  readonly spec: Pick<RoundSpec, "bundles" | "decks" | "requiredProtocol" | "context">
  /** the round's run key (helpers and jobs get each seed's game key from it, never the key itself) */
  readonly runKey: string | null
  readonly limits: Limits
  /** null when the helper node is off: everything plays here, and ladder.json has no `remote` */
  readonly board: LeaseBoard | null
  readonly tickMs: number
  /** games at once here, read at every dispatch */
  readonly workers: () => number
  readonly play: (job: PlaySeedJob, tag: string) => Effect.Effect<Played, PlayFailed>
  /** a job's work folder name, new for each job */
  readonly tag: (seed: number) => string
  /** games about to play (here, or on the helper that leased them) */
  readonly onStart: (games: ReadonlyArray<ScheduledGame>) => Effect.Effect<void>
  /** games played: host null here, else the helper's name */
  readonly onResults: (done: ReadonlyArray<LaneResult>, host: Host) => Effect.Effect<void>
  readonly isStopping?: () => boolean
  readonly log?: (message: string) => void
}

export interface Lane {
  /** plays every game given, or ends early: failed (a job failed twice, a result could not be recorded) or stopped */
  readonly run: Effect.Effect<LaneEnd>
  /** ladder.json `remote` (remote-lane.js stats), or null with no board */
  readonly stats: () => RemoteStats | null
}

interface Lease {
  readonly id: string
  readonly host: string
  readonly seed: number
  readonly games: ReadonlyArray<ScheduledGame>
}

const median = (xs: ReadonlyArray<number>) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2
}

const namesOf = (games: ReadonlyArray<ScheduledGame>) => [...new Set(games.flatMap((g) => [g.p1, g.p2]))]

export const makeLane = (deps: LaneDeps, todo: ReadonlyArray<ScheduledGame>): Lane => {
  const log = deps.log ?? ((m: string) => Log.info(m))
  const board = deps.board
  const queue: Array<ScheduledGame> = [...todo]
  // seed -> its games in the queue when the lane started (a resumed round has seeds with fewer)
  const seeds = bySeed(todo)
  const local = new Set<number>() // seeds lost or taken back: they play here
  const leases = new Map<string, Lease>()
  const helperGames = new Map<string, number>() // bot -> its games on helpers (out now or recorded)
  const incapable = new Set<string>() // versions whose tar is not in the bundles folder
  const localMs: Array<number> = []
  const failedOnce = new Set<string>()
  const hosts = new Set<string>()
  const seen = { looks: 0, claimLooks: 0, leased: 0, lost: 0, lastLost: null as string | null }
  let played = 0
  let inflight = 0 // games playing here
  let end: LaneEnd | null = null
  const running = new Set<Fiber.Fiber<void>>()

  // the main loop sleeps until its next tick or until a job here ends; a wake while it is not asleep is kept for it
  let waker: (() => void) | null = null
  let pending = false
  const poke = () => {
    if (waker) {
      const w = waker
      waker = null
      w()
    } else {
      pending = true
    }
  }
  const sleep = (ms: number) =>
    Effect.callback<void>((resume) => {
      if (pending) {
        pending = false
        resume(Effect.void)
        return
      }
      const timer = setTimeout(() => {
        waker = null
        resume(Effect.void)
      }, ms)
      waker = () => {
        clearTimeout(timer)
        resume(Effect.void)
      }
      return Effect.sync(() => {
        clearTimeout(timer)
        waker = null
      })
    })

  const capable = (name: string) => !incapable.has(name) && typeof deps.spec.bundles[name] === "string"
  const keyOf = (seed: number) => (deps.runKey === null ? null : deps.js.gameKey(deps.runKey, seed))
  const countHelper = (games: ReadonlyArray<ScheduledGame>, d: number) => {
    for (const g of games) for (const n of [g.p1, g.p2]) helperGames.set(n, (helperGames.get(n) ?? 0) + d)
  }
  // at the front, in their order: the next free slot here takes them
  const putBack = (games: ReadonlyArray<ScheduledGame>) => {
    queue.unshift(...games.filter((g) => !queue.includes(g)))
    poke()
  }

  /** The offerable seed whose bots had the fewest helper games (then the lowest seed), or null. */
  const pick = (): number | null => {
    const waiting = new Set(queue)
    let best: { seed: number; load: number } | null = null
    for (const [seed, games] of seeds) {
      if (local.has(seed) || !games.every((g) => waiting.has(g)) || !namesOf(games).every(capable)) continue
      const load = namesOf(games).reduce((s, n) => s + (helperGames.get(n) ?? 0), 0)
      if (!best || load < best.load || (load === best.load && seed < best.seed)) best = { seed, load }
    }
    return best?.seed ?? null
  }

  /** Offers one seed to the oldest waiting claim: leased, none (no claim waits any more) or error. */
  const offer = (b: LeaseBoard, seed: number) =>
    Effect.gen(function*() {
      const games = seeds.get(seed)!
      const job = jobFor(deps.js, deps.spec, deps.runKey, games, deps.limits)
      const tars = [...new Set(Object.values(job.bots).flatMap((x) => (x.kind === "wasm" ? [x.bundle] : [])))]
      const a = b.offer(job, tars)
      if (a.kind === "none") return "none" as const
      if (a.kind === "missing") {
        // the round wrote every tar before it started: one gone stays gone, so that version's games play here
        for (const n of namesOf(games)) {
          const hex = deps.spec.bundles[n]
          if (hex && a.missing.includes(hex) && !incapable.has(n)) {
            incapable.add(n)
            log(`${n}: its bundle is not in the bundles folder; its games play here`)
          }
        }
        return "error" as const
      }
      if (leases.has(a.lease)) {
        log(`seed ${seed}: the lease board gave a lease already open; it plays here`)
        local.add(seed)
        return "error" as const
      }
      for (const g of games) queue.splice(queue.indexOf(g), 1)
      leases.set(a.lease, { id: a.lease, host: a.host, seed, games })
      seen.leased++
      countHelper(games, 1)
      log(`seed ${seed} (${games.map((g) => g.id).join(", ")}) -> ${a.host}, lease ${a.lease}`)
      yield* deps.onStart(games)
      return "leased" as const
    })

  /** A lease whose games play here after all. */
  const lose = (lease: Lease, why: string) => {
    leases.delete(lease.id)
    countHelper(lease.games, -1)
    local.add(lease.seed)
    putBack(lease.games)
    seen.lost++
    seen.lastLost = `${lease.host}: ${why.slice(0, 200)}`
    log(`lease ${lease.id} (seed ${lease.seed}, ${lease.host}) lost: ${why}; playing it here`)
  }

  /** A done lease: its replays and results, unless anything in them is off (then it is lost, nothing of it kept). */
  const record = (lease: Lease, answer: { readonly results: unknown; readonly replays: unknown }) =>
    Effect.gen(function*() {
      const ans = { results: answer.results, replays: answer.replays }
      const why = deps.js.checkDone(lease.games, ans, { seed: lease.seed, key: keyOf(lease.seed), decks: deps.spec.decks?.lists ?? null })
      if (why) {
        lose(lease, `invalid result: ${why}`)
        return
      }
      const results = new Map((ans.results as Array<{ id: string; result: Record<string, any> }>).map((e) => [e.id, e.result]))
      const replays = (ans.replays ?? {}) as Record<string, string>
      for (const g of lease.games) {
        const r = results.get(g.id)
        const why = protocolResultError(r, deps.spec.requiredProtocol) ?? protocolReplayError(replays[g.id], r, deps.spec.requiredProtocol) ??
          (deps.spec.requiredProtocol === 2 ? comparisonResultProblem(r, deps.spec.context ?? null, bundlesForSeats(deps.spec.bundles, g)) ?? comparisonReplayProblem(replays[g.id], r, deps.spec.context ?? null, bundlesForSeats(deps.spec.bundles, g)) : null)
        if (why) {
          lose(lease, `invalid result: ${why}`)
          return
        }
      }
      leases.delete(lease.id)
      played += lease.games.length
      yield* deps.onResults(lease.games.map((g) => ({
        game: g,
        result: cleanResult(results.get(g.id)!),
        replay: Object.hasOwn(replays, g.id) ? replays[g.id]! : null
      })), lease.host)
    })

  const offerSeeds = (b: LeaseBoard) =>
    Effect.gen(function*() {
      const st = b.status()
      const named = st.hosts.filter((h) => HOST.test(h) && !hosts.has(h))
      if (named.length) {
        named.forEach((h) => hosts.add(h))
        log(`helpers this boot: ${[...hosts].join(", ")}`)
      }
      let waiting = Number.isSafeInteger(st.waiting) ? st.waiting : 0
      seen.looks++
      if (waiting > 0) seen.claimLooks++
      while (waiting > 0 && end === null) {
        const seed = pick()
        if (seed === null || (yield* offer(b, seed)) !== "leased") return
        waiting--
      }
    })

  const sweep = (b: LeaseBoard) =>
    Effect.gen(function*() {
      for (const lease of [...leases.values()]) {
        if (!leases.has(lease.id) || end !== null) continue
        const l = b.lease(lease.id)
        if (l.state === "unknown") {
          lose(lease, "the lease board does not know it")
        } else if (l.state === "running") {
          const limit = 2 * (localMs.length ? median(localMs) : TAKE_BACK_DEFAULT_MS) + TAKE_BACK_SLACK_MS
          if (!queue.length && l.ageMs > limit) {
            b.revoke(lease.id)
            lose(lease, `taken back after ${Math.round(l.ageMs / 1000)} s, nothing else left to play`)
          }
        } else if (l.state === "done") {
          yield* record(lease, l)
        } else {
          lose(lease, String(l.reason ?? "no reason given").slice(0, 300))
        }
      }
    })

  /** One job here: its games' results recorded, or (failed) put back once. Never fails; interruption stops the child. */
  const job = (games: ReadonlyArray<ScheduledGame>): Effect.Effect<void> => {
    const seed = games[0]!.seed
    return Effect.suspend(() => deps.play(jobFor(deps.js, deps.spec, deps.runKey, games, deps.limits), deps.tag(seed))).pipe(
      Effect.matchEffect({
        onSuccess: (p) =>
          Effect.gen(function*() {
            const byId = new Map(p.results.map((e) => [e.id, e.result]))
            for (const g of games) {
              const r = byId.get(g.id)
              const why = protocolResultError(r, deps.spec.requiredProtocol) ?? protocolReplayError(p.replays[g.id], r, deps.spec.requiredProtocol) ??
                (deps.spec.requiredProtocol === 2 ? comparisonResultProblem(r, deps.spec.context ?? null, bundlesForSeats(deps.spec.bundles, g)) ?? comparisonReplayProblem(p.replays[g.id], r, deps.spec.context ?? null, bundlesForSeats(deps.spec.bundles, g)) : null)
              if (why) {
                end ??= { kind: "failed", why: `${g.id}: ${why}` }
                return
              }
            }
            for (const g of games) localMs.push(byId.get(g.id)!.ms)
            yield* deps.onResults(games.map((g) => ({ game: g, result: byId.get(g.id)!, replay: p.replays[g.id] ?? null })), null)
          }),
        onFailure: (e) =>
          Effect.sync(() => {
            if (e.stopped) {
              end ??= { kind: "stopped", why: e.why }
              return
            }
            const again = games.filter((g) => failedOnce.has(g.id))
            if (again.length) {
              end ??= { kind: "failed", why: `${again.map((g) => g.id).join(", ")} failed twice (${e.why})` }
              return
            }
            for (const g of games) failedOnce.add(g.id)
            Log.warn(`seed ${seed}: ${e.why}; its games play again`)
            putBack(games)
          })
      }),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.sync(() => {
            end ??= { kind: "failed", why: `seed ${seed}: ${String(Cause.squash(cause)).split("\n")[0]!.slice(0, 300)}` }
          })
      ),
      Effect.ensuring(Effect.sync(() => {
        inflight -= games.length
        poke()
      }))
    )
  }

  const dispatch = Effect.gen(function*() {
    while (end === null && queue.length) {
      const w = Math.max(1, Math.floor(Number(deps.workers())) || 1)
      const free = w - inflight
      if (free <= 0) return
      const seed = queue[0]!.seed
      const games = queue.filter((g) => g.seed === seed).slice(0, Math.min(free, MAX_JOB_GAMES))
      for (const g of games) queue.splice(queue.indexOf(g), 1)
      inflight += games.length
      yield* deps.onStart(games)
      const fiber = yield* Effect.forkChild(job(games))
      running.add(fiber)
      fiber.addObserver(() => running.delete(fiber))
      if (fiber.pollUnsafe()) running.delete(fiber)
    }
  })

  const stopJobs = Effect.suspend(() => (running.size ? Fiber.interruptAll([...running]) : Effect.void))

  const run = Effect.gen(function*() {
    let nextTick = 0
    for (;;) {
      pending = false
      if (end === null && deps.isStopping?.()) end = { kind: "stopped", why: "the machine is stopping" }
      if (end !== null) break
      if (board && Date.now() >= nextTick) {
        if (queue.length || leases.size) {
          yield* offerSeeds(board)
          yield* sweep(board)
        }
        nextTick = Date.now() + deps.tickMs
      }
      if (end !== null) break
      yield* dispatch
      if (!queue.length && inflight === 0 && leases.size === 0) break
      yield* sleep(board ? Math.max(1, nextTick - Date.now()) : deps.tickMs)
    }
    yield* stopJobs
    if (played) log(`${played} games played on helpers`)
    return end ?? ({ kind: "done" } as const)
  }).pipe(Effect.onInterrupt(() => stopJobs))

  const stats = (): RemoteStats | null =>
    board
      ? {
        lane: true,
        hosts: [...hosts].sort(),
        looks: seen.looks,
        claimLooks: seen.claimLooks,
        leased: seen.leased,
        played,
        lost: seen.lost,
        lastLost: seen.lastLost,
        relayErrors: [],
        stopped: null
      }
      : null

  return { run, stats }
}
