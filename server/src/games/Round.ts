/**
 * One rated round, from its rules to its result files: what referee.js runRound and ladder.js did, now in the server.
 * - The rules and the lineup come from `gamesctl round` (the roster, the versions, the deck lists, each version's tar in
 *   the bundles folder); the first seed and the run key from the round-seed secret (referee.js roundSeed, roundKey),
 *   which no child sees. The schedule is ratings.js roundRobin dealt by decklists.js by seat (Schedule.ts).
 * - Every game and its result is in games.db as it ends. Round K again resumes it: its finished games are kept when its
 *   bots, games per pair, time limit, deck lists, first seed and key are the same, else it starts over (ladder.js
 *   --resume). A round with no row whose ladder.json the old coordinator's ladder left (a round cut by the switch to this
 *   server) keeps that ladder's finished games under the same test.
 * - The games play in the Lane (here, and on helpers); their entries and replays go to the round's folder (Results.ts),
 *   each seed's key once every game of it has ended; `gamesctl publish` turns the folder into standings, the round's
 *   report and the panels at the start, every 30 s and at the end; referee.lock says a round plays.
 * - Interrupted (the machine stops, the round ran past its cap), the children stop, the row stays playing, the files
 *   stay whole and the lock goes. The scheduler owns attempts, retries and holds.
 */
import path from "node:path"
import { Cause, Effect, Fiber } from "effect"
import type { GamesConfig } from "./Config.ts"
import type { PlayFailed, PlayOptions } from "./Executor.ts"
import { clearWork, playLocal } from "./Executor.ts"
import type { GamesctlService } from "./Gamesctl.ts"
import type { ArenaJs } from "./Js.ts"
import type { LaneResult } from "./Lane.ts"
import { makeLane } from "./Lane.ts"
import * as Log from "./Log.ts"
import type { ProcService } from "./Proc.ts"
import { deckRule, ladderConfig, ladderId, openRoundFiles, readRegular, resultOfEntry } from "./Results.ts"
import { buildSchedule, evenGames, keyId, roundSeed, runKey } from "./Schedule.ts"
import type { GameRow, RoundRow, StoreService } from "./Store.ts"
import type { GameResult, Host, LeaseBoard, PlanWhy, PlaySeedJob, Played, RoundSpec, ScheduledGame, WindowSettings } from "./Types.ts"
import { ARENA, limitsFor } from "./Types.ts"

export interface RoundDeps {
  readonly config: GamesConfig
  readonly store: StoreService
  readonly proc: ProcService
  readonly gamesctl: GamesctlService
  readonly js: ArenaJs
  /** null when the helper node is off */
  readonly board: LeaseBoard | null
  /** the round-seed secret (64 hex) */
  readonly secret: string
  readonly boot: string
  /** Eric's settings now: games at once is read at every dispatch, games per pair and the time limit when a round starts */
  readonly settings: () => WindowSettings
  /** called whenever the round's files changed (the pusher's round pass can follow) */
  readonly onFiles?: () => void
  /** plays a job here (default Executor.playLocal); tests put a fake one here */
  readonly play?: (job: PlaySeedJob, tag: string, opts: PlayOptions) => Effect.Effect<Played, PlayFailed>
}

export type RoundOutcome =
  | { readonly kind: "done" }
  | { readonly kind: "failed"; readonly why: string }
  | { readonly kind: "stopped" }

const STOPPED: RoundOutcome = { kind: "stopped" }
const OUTCOMES = ["won", "ERROR", "STEP_CAP", "STUCK"]
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const plain = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x)
const count = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 0

/** A stored round plays on with its finished games when it is the same round: same lineup, rules, decks, seeds and key. */
const sameRound = (row: RoundRow, spec: RoundSpec, firstSeed: number, kid: string) =>
  same(row.spec.bots, spec.bots) && evenGames(row.spec.gamesPerPair) === spec.gamesPerPair && row.spec.capMs === spec.capMs &&
  same(deckRule(row.spec.decks), deckRule(spec.decks)) && row.firstSeed === firstSeed && row.keyId === kid

/** What is wrong with a game entry of an old ladder.json, read as a result, or null (remote-lane.js badResult, in short). */
const badEntry = (g: ScheduledGame, r: GameResult): string | null => {
  if (!OUTCOMES.includes(r.outcome)) return "outcome"
  if (!count(r.round) || !count(r.steps) || !(typeof r.ms === "number" && Number.isFinite(r.ms))) return "counts"
  const winner = ({ p1: g.p1, p2: g.p2, draw: "draw" } as Record<string, string>)[String(r.winnerSeat)] ?? null
  if ((r.winner ?? null) !== winner) return "winner"
  if ((r.faultKind !== null) !== (r.by !== null && r.outcome === "ERROR")) return "fault"
  return null
}

interface Imported {
  readonly createdAt: string
  readonly games: ReadonlyArray<{
    readonly game: ScheduledGame
    readonly result: GameResult
    readonly host: Host
    readonly key: string | null
    readonly endedAt: string
    /** its place in the old ladder.json's list, which is the order the games started */
    readonly started: number
  }>
}

/**
 * The finished games of round K's ladder.json from the old coordinator's ladder, when it played the same round (its
 * bots, games per pair, seeds, step cap, time limits, key and deck lists; ladder.js readPrevious), else null. A game
 * whose key was not out yet gets its seed's game key, as ladder.js --resume held it.
 */
const importLadder = (file: string, k: number, config: Record<string, unknown>, key: string, schedule: ReadonlyArray<ScheduledGame>, js: ArenaJs): Imported | null => {
  const text = readRegular(file)
  if (text === null) return null
  let doc: any
  try {
    doc = JSON.parse(text)
  } catch {
    Log.warn(`round ${k}: ${file} is not readable JSON; the round starts over`)
    return null
  }
  const c = plain(doc?.config) ? doc.config : {}
  if (!same(c.bots, config.bots) || c.gamesPerPair !== config.gamesPerPair || c.firstSeed !== config.firstSeed || c.maxSteps !== config.maxSteps ||
    (c.capMs ?? null) !== (config.capMs ?? null) || c.hangMs !== config.hangMs || c.keyId !== config.keyId || c.record !== true ||
    !same(c.decks ?? null, config.decks ?? null)) {
    Log.info(`round ${k}: the ladder.json there is of other bots, seeds, limits, key or deck lists; the round starts over`)
    return null
  }
  const byId = new Map(schedule.map((g) => [g.id, g]))
  const kept: Array<Imported["games"][number]> = []
  const list = (Array.isArray(doc.games) ? doc.games : []).filter((e: unknown) => plain(e) && typeof e.id === "string" && e.outcome !== "running" && byId.has(e.id))
  // ladder.json lists games as they started: their order (sequential Elo, eloHistory) is kept through the end times
  const base = (Date.parse(String(doc.updatedAt ?? doc.createdAt)) || Date.now()) - list.length
  for (const [i, e] of list.entries()) {
    const g = byId.get(e.id)!
    if (kept.some((x) => x.game.id === g.id)) continue
    const r = resultOfEntry(e)
    const why = badEntry(g, r)
    if (why) {
      Log.warn(`round ${k}: ${g.id} in the old ladder.json is not a result (${why}); it plays again`)
      continue
    }
    kept.push({
      game: g,
      result: r.key ? r : { ...r, key: js.gameKey(key, g.seed) },
      host: typeof e.host === "string" ? e.host : null,
      key: typeof e.key === "string" ? e.key : null,
      endedAt: new Date(base + i).toISOString(),
      started: i
    })
  }
  return { createdAt: typeof doc.createdAt === "string" ? doc.createdAt : new Date().toISOString(), games: kept }
}

const describe = (cause: Cause.Cause<unknown>) => String(Cause.squash(cause)).split("\n")[0]!.slice(0, 300)

/** Plays round k (resuming its finished games) until every game has a result, or it fails or is interrupted. */
export const playRound = (deps: RoundDeps, k: number, why: PlanWhy, resume: boolean): Effect.Effect<RoundOutcome> =>
  Effect.gen(function*() {
    const c = deps.config
    const { store } = deps
    const s = deps.settings()
    const asked = yield* Effect.result(deps.gamesctl.round(k, s.gamesPerPair, Math.round(s.thinkCapSec * 1000)))
    if (asked._tag === "Failure") {
      deps.board?.reset()
      if (asked.failure.stopped) return STOPPED
      const failed = asked.failure.why ?? String(asked.failure.message)
      Log.warn(`round ${k}: gamesctl round failed (${failed})`)
      return { kind: "failed", why: `gamesctl round: ${failed}` } as const
    }
    const spec: RoundSpec = { ...asked.success, gamesPerPair: evenGames(asked.success.gamesPerPair) }
    const firstSeed = roundSeed(deps.secret, k)
    const key = runKey(deps.secret, k)
    const kid = keyId(key)
    const limits = limitsFor(spec.capMs)
    const workers = Math.max(1, Math.floor(s.workers) || 1)
    const schedule = buildSchedule(deps.js, spec, firstSeed)
    const config = ladderConfig({ spec, firstSeed, workers, limits, keyId: kid })
    const id = ladderId(k)
    const fresh = (createdAt: string): RoundRow => ({
      k, arena: ARENA, spec, firstSeed, keyId: kid, workers, state: "playing", boot: deps.boot, attempts: 0, why, createdAt, endedAt: null
    })
    const todoRows = (): Array<GameRow> =>
      schedule.map((g, ord) => ({
        id: g.id, ord, seed: g.seed, p1: g.p1, p2: g.p2, decks: g.decks ?? null, state: "todo", host: null, result: null, key: null, endedAt: null
      }))

    // the round's row and games: the same round goes on, another starts over, an old coordinator's ladder is taken in
    const row = yield* store.round(k)
    let createdAt: string
    if (row && sameRound(row, spec, firstSeed, kid)) {
      createdAt = row.createdAt
      yield* store.updateRound(k, { state: "playing", boot: deps.boot, workers })
    } else if (row) {
      Log.info(`round ${k}: its bots, games per pair, time limit, deck lists or seeds changed since it started; it starts over`)
      createdAt = new Date().toISOString()
      yield* store.replaceRound(fresh(createdAt), todoRows())
    } else {
      const old = importLadder(path.join(c.paths.results, id, "ladder.json"), k, config, key, schedule, deps.js)
      createdAt = old?.createdAt ?? new Date().toISOString()
      const kept = new Map((old?.games ?? []).map((x) => [x.game.id, x]))
      yield* store.createRound(fresh(createdAt), todoRows().map((g) => {
        const x = kept.get(g.id)
        return x ? { ...g, state: "done" as const, host: x.host, result: x.result, key: x.key, endedAt: x.endedAt, started: x.started } : g
      }))
      if (kept.size) Log.info(`${id}: ${kept.size} games the old coordinator's ladder finished are kept`)
    }

    const files = openRoundFiles({
      results: c.paths.results, k, createdAt, config, botInfo: spec.botInfo, scheduled: schedule.length,
      deckNames: spec.decks?.names ?? null, summarize: deps.js.summarize
    })
    let filesTold = 0
    const save = () => {
      const doc = files.write()
      filesTold = Date.now()
      deps.onFiles?.()
      return doc
    }

    // what was played before: entries in the order the games started (ladder.js keeps that order through a resume), and
    // the seeds' keys
    const byId = new Map(schedule.map((g) => [g.id, g]))
    const stored = (yield* store.games(k))
      .filter((r) => r.state === "done" && r.result !== null && byId.has(r.id))
      .sort((a, b) => (a.started ?? Infinity) - (b.started ?? Infinity) || (a.endedAt ?? "").localeCompare(b.endedAt ?? "") || a.ord - b.ord)
    for (const r of stored) {
      const g = byId.get(r.id)!
      files.start(g)
      files.finish(g, r.result!, r.host)
      if (r.key) files.entryKey(r.id, r.key)
    }
    const doneIds = new Set(stored.map((r) => r.id))
    const todo = schedule.filter((g) => !doneIds.has(g.id))
    const unplayed = new Map<number, number>()
    for (const g of todo) unplayed.set(g.seed, (unplayed.get(g.seed) ?? 0) + 1)
    // seed -> its ended games' keys, held until every game of the seed has ended (ladder.js hold/publish)
    const held = new Map<number, Array<{ id: string; key: string }>>()
    const hold = (seed: number, gid: string, gkey: string) => held.set(seed, [...(held.get(seed) ?? []), { id: gid, key: gkey }])
    for (const r of stored) if (!r.key && r.result!.key) hold(r.seed, r.id, r.result!.key)

    /** A whole seed's key out: replays first (a cut before the store has it does it again), then the store, then entries. */
    const publishKey = (seed: number) =>
      Effect.gen(function*() {
        const list = held.get(seed) ?? []
        held.delete(seed)
        for (const h of list) files.replayKey(h.id, h.key)
        for (const gkey of new Set(list.map((h) => h.key))) {
          yield* store.setKey(k, list.filter((h) => h.key === gkey).map((h) => h.id), gkey)
        }
        for (const h of list) files.entryKey(h.id, h.key)
      })
    for (const seed of [...held.keys()]) if (!unplayed.get(seed)) yield* publishKey(seed)

    let finished = stored.length
    /** Games played: replays, then the store, then entries; a seed whose last game this was gets its key out. */
    const record = (done: ReadonlyArray<LaneResult>, host: Host) =>
      Effect.gen(function*() {
        for (const x of done) files.replay(x.game.id, x.replay)
        const endedAt = new Date().toISOString()
        for (const x of done) yield* store.finishGame(k, x.game.id, host, x.result, endedAt)
        const whole: Array<number> = []
        for (const x of done) {
          files.finish(x.game, x.result, host)
          if (x.result.key) hold(x.game.seed, x.game.id, x.result.key)
          const left = (unplayed.get(x.game.seed) ?? 1) - 1
          unplayed.set(x.game.seed, left)
          if (left === 0) whole.push(x.game.seed)
        }
        let doc = save()
        for (const seed of whole) yield* publishKey(seed)
        if (whole.length) doc = save()
        const top = (Array.isArray(doc.bots) ? doc.bots : []).slice(0, 3).map((b: any) => `${b.name} ${b.btElo}`).join(", ")
        for (const x of done) {
          const r = x.result
          finished++
          const fault = r.by ? ` (${r.by} ${r.faultKind})` : ""
          Log.info(`${id} [${finished}/${schedule.length}] ${x.game.id}${host ? ` @${host}` : ""}: ${r.outcome}${fault} ${r.winner ?? ""} R${r.round} ${r.steps} steps ${r.ms}ms${r.error ? ` ${r.error}` : ""} | ${top}`)
        }
      })

    // a game playing here can be watched as it plays: its replay's lines go to the round's folder as they come
    let linesWarned = false
    const onLines = (gid: string, from: number, text: string) => {
      try {
        files.lines(gid, from, text)
      } catch (e) {
        if (!linesWarned) {
          linesWarned = true
          Log.warn(`${id}: a replay could not follow its game (${String((e as Error)?.message ?? e).split("\n")[0]})`)
        }
      }
      if (Date.now() - filesTold >= 1000) {
        filesTold = Date.now()
        deps.onFiles?.()
      }
    }
    const play = deps.play ?? ((job: PlaySeedJob, tag: string, opts: PlayOptions) => playLocal(c, deps.proc, job, tag, opts))
    let jobs = 0
    // a game that plays again after a failure keeps the place it took when it first started in this run, as files.start
    // keeps its entry in place; a game cut by an earlier stop starts again after the kept ones, as ladder.js --resume did
    const startedHere = new Set<string>()
    const lane = makeLane({
      js: deps.js,
      spec,
      runKey: key,
      limits,
      board: deps.board,
      tickMs: c.timing.laneTickMs,
      workers: () => deps.settings().workers,
      play: (job, tag) => play(job, tag, { onLines }),
      tag: (seed) => `r${k}-${seed}-${++jobs}`,
      onStart: (games) =>
        Effect.gen(function*() {
          for (const g of games) files.start(g)
          const fresh = games.filter((g) => !startedHere.has(g.id))
          for (const g of fresh) startedHere.add(g.id)
          yield* store.startGames(k, fresh.map((g) => g.id))
          save()
        }),
      onResults: record,
      isStopping: deps.proc.isStopping,
      log: (m) => Log.info(`${id}: ${m}`)
    }, todo)
    files.remote(lane.stats)

    // job folders an earlier run left (only one round plays at a time, and its jobs are named r<K>-...)
    clearWork(c, /^r\d+-\d+-\d+$/)
    Log.info(`round ${k}: ${spec.bots.join(", ")}${resume ? " (resumed)" : ""}`)
    if (stored.length) Log.info(`${id}: resuming, ${stored.length} games already played`)
    Log.info(`${id}: ${todo.length} of ${schedule.length} games to play, ${spec.bots.length} bots, ${spec.decks ? `${spec.decks.lists.length} decks, ` : ""}${workers} at once -> ${files.dir}`)

    const touchLock = Effect.sync(() => {
      try {
        files.touchLock()
      } catch (e) {
        Log.warn(`${id}: could not touch referee.lock (${String((e as Error)?.message ?? e).split("\n")[0]})`)
      }
    })
    const lockLoop = Effect.forever(Effect.sleep(c.timing.publishMs).pipe(Effect.andThen(touchLock)))
    const publishLoop = Effect.gen(function*() {
      for (;;) {
        const r = yield* Effect.result(deps.gamesctl.publish(k))
        if (r._tag === "Failure") {
          if (r.failure.stopped) return
          Log.warn(`round ${k}: publishing failed (${r.failure.why ?? r.failure.message}); trying again in ${Math.round(c.timing.publishMs / 1000)} s`)
        }
        yield* Effect.sleep(c.timing.publishMs)
      }
    })

    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        files.lock()
        save()
      }),
      () =>
        Effect.gen(function*() {
          const loops = [yield* Effect.forkChild(lockLoop), yield* Effect.forkChild(publishLoop)]
          const end = yield* lane.run.pipe(Effect.ensuring(Fiber.interruptAll(loops)))
          if (end.kind === "stopped") {
            Log.info(`round ${k} stopped (${end.why})`)
            return STOPPED
          }
          if (end.kind === "failed") {
            Log.warn(`round ${k} failed: ${end.why}`)
            return { kind: "failed", why: end.why } as const
          }
          yield* store.updateRound(k, { state: "done", endedAt: new Date().toISOString() })
          files.done(key)
          const doc = save()
          const pub = yield* Effect.result(deps.gamesctl.publish(k))
          if (pub._tag === "Failure") {
            if (pub.failure.stopped) return STOPPED
            const failed = pub.failure.why ?? String(pub.failure.message)
            Log.warn(`round ${k}: gamesctl publish failed (${failed})`)
            return { kind: "failed", why: `gamesctl publish: ${failed}` } as const
          }
          Log.info(`round ${k} done: ${doc.progress?.finished ?? "?"} games, ${doc.progress?.rated ?? "?"} rated`)
          return { kind: "done" } as const
        }),
      () =>
        Effect.sync(() => {
          for (const f of [() => files.unlock(), () => save()]) {
            try {
              f()
            } catch (e) {
              Log.warn(`${id}: ${String((e as Error)?.message ?? e).split("\n")[0]}`)
            }
          }
          deps.board?.reset()
        })
    )
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.sync((): RoundOutcome => {
          const why = describe(cause)
          Log.error(`round ${k} failed: ${why}`)
          deps.board?.reset()
          return { kind: "failed", why }
        })
    )
  )
