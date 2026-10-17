/**
 * Decides when things happen (Coord.Scheduler, its Policy and the two Oban workers it fed); gamesctl and the round
 * decide what.
 *
 * Phases: setup (`gamesctl setup`; a failure stops the machine with 1), warming (`gamesctl warm`; failures are only
 * logged), then ready. Ticks start when setup is done and come every 20 s, or at once on a wake or a round's end. A
 * tick
 *   1. queues an intake pass on every third tick (tick 0 is the first) and after a wake (one pass runs at a time, and
 *      at most one waits behind it; a pass runs during a round too),
 *   2. when ready, with no intake pass or round unfinished and no plan running, runs `gamesctl plan` and queues the
 *      round it names; a new round first waits out Eric's wait between rounds after the last round that finished
 *      (its end is kept in games.db, so a new boot keeps the wait), and the machine stays awake while it waits,
 *   3. stops the machine with 0 when it is idle (`idle`); when a plan runs, that check waits for its answer, so a
 *      round about to be queued never meets an idle stop.
 *
 * Once warm is done, and after each round that finished, the compactor gzips older rounds' replays (Compact.ts); the
 * machine does not idle out while it runs.
 *
 * Rounds keep Oban's rules: a round is queued once per boot (whatever became of it); a failed round is tried once
 * more 30 s later; two failures, or a round that runs past GAMES_ROUND_HOURS, hold it until the next boot (plan keeps
 * naming it, this warns once, and the machine may idle). A round cut by a stop is not an attempt: the next boot
 * resumes it at once. A placement selection cancelled before reservation releases its unused round number and plans
 * again without recording an attempt.
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { Cause, Effect, Exit } from "effect"
import type { Exit as ExitT } from "effect"
import type { GamesConfig } from "./Config.ts"
import type { GamesctlFailed, GamesctlService, IntakeAnswer } from "./Gamesctl.ts"
import * as Log from "./Log.ts"
import type { ProcService } from "./Proc.ts"
import type { RoundOutcome } from "./Round.ts"
import type { StoreService } from "./Store.ts"
import type { LeaseBoard, Plan, PlanWhy, WindowSettings } from "./Types.ts"
import { ARENA } from "./Types.ts"

export type Phase = "setup" | "warming" | "ready"
export type Job = "intake" | "round"

// ---- the rules, as pure functions over plain values (Coord.Scheduler.Policy); times are monotonic ms

/** An intake pass is due once setup is done: on every third tick (tick 0 comes right after setup) and after a wake. */
export const intakeDue = (phase: Phase, s: { readonly ticks: number; readonly woken: boolean }) =>
  phase !== "setup" && (s.ticks % 3 === 0 || s.woken)

/** plan runs when ready, with no intake pass or round unfinished and no plan still running. */
export const planDue = (f: { readonly phase: Phase; readonly incomplete: ReadonlyArray<Job>; readonly planning: boolean }) =>
  f.phase === "ready" && f.incomplete.length === 0 && !f.planning

export interface IdleFacts {
  readonly phase: Phase
  readonly incomplete: ReadonlyArray<Job>
  readonly planning: boolean
  /** the kinds of the children running now */
  readonly children: ReadonlyArray<string>
  readonly busyAt: number
  /** when the last version was accepted this boot, or null */
  readonly settledAt: number | null
  readonly idleMs: number
  readonly settleMs: number
  /** the compactor runs a pass */
  readonly compacting?: boolean
}

/**
 * The machine may stop: ready, nothing unfinished, no plan waiting for its answer, no child running but a push, no
 * compaction pass, no wake, open submission or round end for idleMs, and no version accepted for settleMs. Helpers
 * never keep it up.
 */
export const idle = (f: IdleFacts, now: number) =>
  f.phase === "ready" && f.incomplete.length === 0 && !f.planning && f.children.every((k) => k === "push") &&
  !f.compacting && now - f.busyAt > f.idleMs && (f.settledAt === null || now - f.settledAt > f.settleMs)

/**
 * How long a new round still waits after the last round's end (wall ms; null when none finished) for Eric's wait
 * between rounds: 0 when it may start, and never more than the wait itself (a clock set back).
 */
export const roundWait = (endedAt: number | null, gapMs: number, now: number) =>
  endedAt === null ? 0 : Math.max(0, Math.min(gapMs, endedAt + gapMs - now))

/** What an intake pass changes: busy when submissions are still open (an unknown count keeps nothing up), settled when one was accepted. */
export const afterIntake = (open: number | null, accepted: number) => ({
  busy: typeof open === "number" && open > 0,
  settled: accepted > 0
})

// ---- the scheduler

export interface SchedulerOptions {
  readonly config: GamesConfig
  readonly gamesctl: Pick<GamesctlService, "setup" | "warm" | "plan" | "intake" | "placementState">
  readonly proc: Pick<ProcService, "running">
  readonly store: Pick<StoreService, "get" | "set" | "updateRound">
  /** Eric's settings now (the wait between rounds is read at every plan answer) */
  readonly settings: () => WindowSettings
  readonly pusher: { readonly poke: () => void }
  /** the proxy's intake address (SWU_WINDOW for the child) */
  readonly intakeUrl: () => string
  readonly boot: string
  /** plays round k: Round.playRound with this boot's deps */
  readonly play: (k: number, why: PlanWhy, resume: boolean) => Effect.Effect<RoundOutcome>
  /** the lease board: every lease is forgotten after each attempt, whatever its end (Coord.Remote.reset) */
  readonly board: Pick<LeaseBoard, "reset"> | null
  /** stops the machine with this exit code (the machine's orderly stop) */
  readonly stop: (code: number) => void
  /** gzips older rounds' replays: poked once warm is done and after each round that finished (Compact.ts) */
  readonly compactor?: { readonly poke: () => void; readonly running: () => boolean }
  /** the wait before a failed round's second attempt (Oban backoff: 30 s) */
  readonly retryMs?: number
  readonly now?: () => number
  readonly wall?: () => number
}

export interface Snapshot {
  readonly phase: Phase
  readonly ticks: number
  readonly woken: boolean
  readonly busyAt: number
  readonly settledAt: number | null
  readonly settledWall: number
  readonly roundEnd: number | null
  readonly waiting: number | null
  readonly lastRan: number | null
  readonly planning: boolean
  readonly stopped: boolean
  readonly incomplete: ReadonlyArray<Job>
  readonly warned: ReadonlyArray<number>
  /** the round job: its number, attempts made and whether it plays now */
  readonly round: { readonly k: number; readonly attempts: number; readonly playing: boolean } | null
}

export interface Scheduler {
  /** reads the last round's end, then runs setup */
  readonly start: () => Promise<void>
  /** POST /wake: the idle clock starts again and an intake pass runs at once */
  readonly wake: () => void
  readonly tick: () => void
  /** a round plays now (the pusher sends it every 3 s) */
  readonly playing: () => boolean
  readonly snapshot: () => Snapshot
  /** no more ticks, and every step in flight is interrupted; resolves when they all ended */
  readonly stop: () => Promise<void>
}

const run = <A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(Log.layer)), { signal })

/** Why a step failed, in words (a gamesctl failure says its own why). */
const failure = (cause: Cause.Cause<unknown>): string => {
  if (Cause.hasInterruptsOnly(cause)) return "stopped"
  const e = Cause.squash(cause)
  if (e && typeof e === "object" && "why" in e && typeof (e as GamesctlFailed).why === "string") return (e as GamesctlFailed).why
  return `crashed: ${e instanceof Error ? e.message : String(e)}`
}

const wholeMs = (text: string): number | null => (/^-?\d+$/.test(text.trim()) ? Number(text.trim()) : null)

interface RoundJob {
  readonly k: number
  readonly why: PlanWhy
  readonly resume: boolean
  attempts: number
  abort: AbortController | null
  retry: NodeJS.Timeout | null
  done: Promise<void> | null
}

export const makeScheduler = (o: SchedulerOptions): Scheduler => {
  const c = o.config
  const now = o.now ?? (() => performance.now())
  const wall = o.wall ?? (() => Date.now())
  const retryMs = o.retryMs ?? 30_000

  let phase: Phase = "setup"
  let ticks = 0
  let woken = false
  // the idle clock starts at boot; settledAt is when the last version came in (null: none this boot)
  let busyAt = now()
  let settledAt: number | null = null
  let settledWall = 0
  let timer: NodeJS.Timeout | null = null
  let stopped = false
  let stopping = false
  const warned = new Set<number>()
  // when the last round that finished ended (wall clock), the round now waiting out the wait after it, and the last
  // round this boot played (one that failed is not queued again, so it never waits)
  let roundEnd: number | null = null
  let waiting: number | null = null
  let lastRan: number | null = null

  // setup or warm in flight, and the plan
  let step: { readonly abort: AbortController; readonly done: Promise<void> } | null = null
  let plan: { readonly abort: AbortController; readonly done: Promise<void> } | null = null
  // the intake queue: one pass runs, at most one waits
  let intake: { readonly abort: AbortController; readonly done: Promise<void> } | null = null
  let intakeWaiting = false
  // the rounds queue: one round at a time; `queued` is every round queued at this boot, whatever became of it
  let job: RoundJob | null = null
  const queued = new Set<number>()

  const incomplete = (): Array<Job> => [
    ...(intake !== null || intakeWaiting ? ["intake" as const] : []),
    ...(job !== null ? ["round" as const] : [])
  ]

  const store = <A>(what: string, effect: Effect.Effect<A>) =>
    run(effect).then((exit) => {
      if (Exit.isFailure(exit)) Log.warn(`${what} (${failure(exit.cause)})`)
    })

  // ---- round end, kept across boots

  const readRoundEnd = async (): Promise<number | null> => {
    const exit = await run(o.store.get("round_end"))
    const kept = Exit.isSuccess(exit) && exit.value !== null ? wholeMs(exit.value) : null
    if (kept !== null) return kept
    // the first boot after the cut: the old coordinator's, kept here from now on
    try {
      const old = wholeMs(readFileSync(path.join(c.paths.oldCoord, "round_end"), "utf8"))
      if (old !== null) await store("could not keep the round's end", o.store.set("round_end", String(old)))
      return old
    } catch {
      return null
    }
  }

  const keepRoundEnd = () => {
    const ms = Math.round(wall())
    // a failed write only shortens the wait after the next boot
    void store("could not keep the round's end on the volume", o.store.set("round_end", String(ms)))
    return ms
  }

  // ---- the tick

  const maybeStop = (inc?: ReadonlyArray<Job>) => {
    if (stopped || stopping) return
    const facts: IdleFacts = {
      phase,
      incomplete: inc ?? incomplete(),
      planning: plan !== null,
      children: o.proc.running(),
      busyAt,
      settledAt,
      idleMs: c.idleMs,
      settleMs: c.timing.settleMs,
      compacting: o.compactor?.running() ?? false
    }
    const t = now()
    if (idle(facts, t)) {
      Log.info(`idle for ${Math.floor((t - busyAt) / 60_000)} minutes`)
      stopped = true
      o.stop(0)
    }
  }

  const tick = () => {
    if (phase === "setup") return
    if (timer) clearTimeout(timer)
    timer = null
    if (stopped || stopping) return
    if (intakeDue(phase, { ticks, woken })) {
      queueIntake()
      woken = false
    }
    const inc = incomplete()
    // The intake can be checking another submission for minutes. Accepted placement intents are already durable,
    // so look for those while it continues; ordinary cycle plans still wait for the pass to finish.
    const forPlan = c.placementMode === "immediate" ? inc.filter((kind) => kind !== "intake") : inc
    if (planDue({ phase, incomplete: forPlan, planning: plan !== null })) startPlan()
    if (plan === null) maybeStop(inc)
    if (!stopped) {
      timer = setTimeout(() => {
        timer = null
        tick()
      }, c.timing.tickMs)
      timer.unref()
    }
    ticks += 1
  }

  // ---- setup and warm

  const startSetup = () => {
    phase = "setup"
    const abort = new AbortController()
    step = {
      abort,
      done: run(o.gamesctl.setup, abort.signal).then((exit) => {
        step = null
        if (stopping) return
        if (Exit.isFailure(exit)) {
          Log.error(`gamesctl setup failed (${failure(exit.cause)}): stopping`)
          stopped = true
          o.stop(1)
          return
        }
        Log.info(`set up; residents ${exit.value.residents.join(", ")}`)
        if (exit.value.toolchain !== null) Log.warn(`toolchain: ${exit.value.toolchain}`)
        o.pusher.poke()
        startWarm()
        tick()
      })
    }
  }

  const startWarm = () => {
    phase = "warming"
    const abort = new AbortController()
    step = {
      abort,
      done: run(o.gamesctl.warm, abort.signal).then((exit) => {
        step = null
        if (Exit.isSuccess(exit)) {
          if (exit.value.failed.length === 0) Log.info(`warmed ${exit.value.warmed} bundles`)
          else Log.warn(`could not warm ${exit.value.failed.join(", ")}`)
        } else if (!stopping) {
          Log.warn(`gamesctl warm failed (${failure(exit.cause)})`)
        }
        // no tick here: the first plan comes with the next tick, as it always did
        phase = "ready"
        if (!stopping) o.compactor?.poke()
      })
    }
  }

  // ---- intake passes

  const queueIntake = () => {
    if (intakeWaiting) return
    if (intake !== null) intakeWaiting = true
    else startIntake()
  }

  const intakeDone = (open: number | null, accepted: number) => {
    if (stopping) return
    const change = afterIntake(open, accepted)
    if (change.busy) busyAt = now()
    if (change.settled) {
      o.pusher.poke()
      settledAt = now()
      settledWall = Math.round(wall())
    }
  }

  const startIntake = () => {
    if (stopping) return
    const abort = new AbortController()
    intake = {
      abort,
      done: run(o.gamesctl.intake(o.intakeUrl()), abort.signal).then((exit: ExitT.Exit<IntakeAnswer, GamesctlFailed>) => {
        intake = null
        if (Exit.isSuccess(exit)) {
          if (exit.value.error !== null) Log.warn(`intake: ${exit.value.error}`)
          intakeDone(exit.value.open, exit.value.accepted)
        } else {
          if (!stopping) Log.warn(`intake: ${failure(exit.cause)}`)
          intakeDone(null, 0)
        }
        // the pass waiting behind this one starts now; while stopping it does nothing (the next boot runs one at once)
        if (intakeWaiting && !stopping) {
          intakeWaiting = false
          startIntake()
        }
        if (!stopping && c.placementMode === "immediate" && phase === "ready" && job === null && plan === null) startPlan()
      })
    }
  }

  // ---- plan

  const startPlan = () => {
    const abort = new AbortController()
    const since = settledWall
    plan = {
      abort,
      done: run(o.gamesctl.plan(since, intake !== null || intakeWaiting), abort.signal).then((exit) => {
        plan = null
        if (stopping || stopped) return
        if (Exit.isFailure(exit)) {
          Log.warn(`gamesctl plan failed (${failure(exit.cause)})`)
          maybeStop()
          return
        }
        planned(exit.value)
      })
    }
  }

  const planned = (p: Plan) => {
    // no round to play: this tick's idle check, which waited for the answer
    if (p.round === null) {
      maybeStop()
      return
    }
    const k = p.round
    const wait = p.resume || p.why === "placement" || k === lastRan ? 0 : roundWait(roundEnd, o.settings().roundGapMin * 60_000, wall())
    if (wait > 0) {
      // a round that waits keeps the machine awake: nothing else would wake it when the wait is over
      if (waiting !== k) Log.info(`round ${k} waits ${Math.ceil(wait / 60_000)} min (the wait between rounds)`)
      waiting = k
      busyAt = now()
      return
    }
    waiting = null
    queueRound(k, p.why, p.resume)
    // after the queueing: a round queued now is unfinished, so the machine stays up; a round that already ran at
    // this boot is not queued again, and must not keep the machine up for ever, since only the next boot plays it
    maybeStop()
  }

  // ---- rounds

  const queueRound = (k: number, why: PlanWhy, resume: boolean) => {
    if (queued.has(k)) {
      if (!warned.has(k)) {
        Log.warn(`round ${k} of ${ARENA} already ran at this boot; it waits for the next boot`)
        warned.add(k)
      }
      return
    }
    queued.add(k)
    Log.info(`round ${k} of ${ARENA} queued (${why})`)
    job = { k, why, resume, attempts: 0, abort: null, retry: null, done: null }
    attempt(job)
  }

  const capHours = () => Math.round((c.roundCapMs / 3_600_000) * 100) / 100

  const attempt = (j: RoundJob) => {
    if (stopping) return
    j.attempts += 1
    const abort = new AbortController()
    j.abort = abort
    j.done = run(o.play(j.k, j.why, j.resume).pipe(Effect.timeout(c.roundCapMs)), abort.signal).then((exit) => ended(j, exit))
  }

  const hold = (j: RoundJob, why: string) => {
    Log.warn(`round ${j.k} waits for the next boot (${why})`)
    void store(`could not mark round ${j.k} held`, o.store.updateRound(j.k, { state: "held", boot: o.boot, attempts: j.attempts }))
    placementState(j.k, "held", why)
  }

  const placementState = (k: number, state: "running" | "retrying" | "held", error?: string) => {
    const effect = o.gamesctl.placementState?.(k, state, error)
    if (effect) void run(effect).then((exit) => {
      if (Exit.isFailure(exit)) Log.warn(`could not publish placement state for round ${k} (${failure(exit.cause)})`)
      o.pusher.poke()
    })
  }

  const ended = (j: RoundJob, exit: ExitT.Exit<RoundOutcome, Cause.TimeoutError>) => {
    j.abort = null
    // whatever the round's end, the helpers' leases are forgotten: a helper still playing a seed of it gets 410
    try {
      o.board?.reset()
    } catch (e) {
      Log.warn(`could not reset the lease board (${(e as Error).message})`)
    }
    if (stopping) {
      // not an attempt: the next boot resumes it
      Log.info(`round ${j.k} ended: stopped (shutdown)`)
      job = null
      return
    }
    if (Exit.isSuccess(exit) && exit.value.kind === "replan") {
      Log.info(`round ${j.k}: placement selection changed before reservation; planning again`)
      queued.delete(j.k)
      warned.delete(j.k)
      job = null
      o.pusher.poke()
      tick()
      return
    }
    let kind: "done" | "cap" | "failed"
    let what: string
    if (Exit.isSuccess(exit)) {
      const r = exit.value
      kind = r.kind === "done" ? "done" : "failed"
      what = r.kind === "done" ? "done" : r.kind === "failed" ? `failed (${r.why})` : "stopped"
    } else if (Cause.isTimeoutError(Cause.squash(exit.cause))) {
      kind = "cap"
      what = "past the round cap"
    } else {
      kind = "failed"
      what = failure(exit.cause)
    }
    Log.info(`round ${j.k} ended: ${what}`)
    o.pusher.poke()
    // only a round that finished starts the wait between rounds
    if (kind === "done") roundEnd = keepRoundEnd()
    busyAt = now()
    lastRan = j.k
    if (kind === "done") {
      job = null
      void store(`could not count round ${j.k}'s attempts`, o.store.updateRound(j.k, { attempts: j.attempts }))
      o.compactor?.poke()
    } else if (kind === "cap") {
      job = null
      hold(j, `it ran past ${capHours()} h`)
    } else if (j.attempts < 2) {
      placementState(j.k, "retrying", what)
      void store(`could not count round ${j.k}'s attempts`, o.store.updateRound(j.k, { attempts: j.attempts }))
      j.retry = setTimeout(() => {
        j.retry = null
        placementState(j.k, "running")
        attempt(j)
      }, retryMs)
      j.retry.unref()
    } else {
      job = null
      hold(j, `it failed twice: ${what}`)
    }
    tick()
  }

  // ---- the outside

  const start = async () => {
    roundEnd = await readRoundEnd()
    if (!stopping) startSetup()
  }

  const wake = () => {
    if (stopping) return
    busyAt = now()
    woken = true
    tick()
  }

  const stop = async () => {
    if (stopping) return
    stopping = true
    if (timer) clearTimeout(timer)
    timer = null
    if (job?.retry) clearTimeout(job.retry)
    const going = [step, plan, intake].filter((s) => s !== null)
    for (const s of going) s.abort.abort()
    job?.abort?.abort()
    await Promise.all([...going.map((s) => s.done), job?.done ?? Promise.resolve()])
  }

  const snapshot = (): Snapshot => ({
    phase, ticks, woken, busyAt, settledAt, settledWall, roundEnd, waiting, lastRan,
    planning: plan !== null,
    stopped,
    incomplete: incomplete(),
    warned: [...warned],
    round: job === null ? null : { k: job.k, attempts: job.attempts, playing: job.abort !== null }
  })

  return { start, wake, tick, playing: () => job?.abort != null, snapshot, stop }
}
