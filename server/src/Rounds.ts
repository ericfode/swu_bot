/**
 * A rated round as a durable workflow. The round's whole plan comes from its payload (the lineup, the first seed and
 * the settings frozen when it started), so replaying the workflow after a restart makes the same jobs in the same
 * order. Each job is an activity: its games, their replays and their rows are stored before the activity's result is,
 * so a job that finished before a crash is not played again. The last activity rates the round.
 */
import { Context, Effect, Exit, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Activity, Workflow, WorkflowEngine } from "effect/workflow"
import { NotFound, PlayerFailed, RoundExists, RoundId } from "./Domain.ts"
import type { Round, RoundRequest } from "./Domain.ts"
import { Games, newGame } from "./Games.ts"
import { GamePlayer, MAX_JOB_GAMES } from "./Player.ts"
import type { Job } from "./Player.ts"
import { Ratings } from "./Ratings.ts"
import { ArenaRecord, roundOf } from "./Record.ts"
import { Replays } from "./Replays.ts"
import { Settings } from "./Settings.ts"

/** What a round plays: the request plus where it belongs and the settings it started with. */
export const RoundPayload = Schema.Struct({
  id: RoundId,
  arena: Schema.String,
  season: Schema.Int,
  bots: Schema.Array(Schema.String),
  firstSeed: Schema.Int,
  gamesPerPair: Schema.Int,
  thinkCapSec: Schema.Int,
  workers: Schema.Int
})
export type RoundPayload = typeof RoundPayload.Type

export const PlayRound = Workflow.make("PlayRound", {
  payload: RoundPayload,
  success: Schema.Int,
  error: PlayerFailed,
  idempotencyKey: (round) => round.id
})

/**
 * Every pair plays gamesPerPair games, half in each seat: seed firstSeed + k gives each pair one game each way. A
 * seed's games are cut into jobs of `workers` games (at most 8), so the machine plays `workers` games at once.
 */
export const planJobs = (round: Pick<RoundPayload, "id" | "bots" | "firstSeed" | "gamesPerPair" | "thinkCapSec" | "workers">): ReadonlyArray<Job> => {
  const size = Math.max(1, Math.min(round.workers, MAX_JOB_GAMES))
  const jobs: Array<Job> = []
  for (let k = 0; k < round.gamesPerPair / 2; k++) {
    const seed = round.firstSeed + k
    const games = round.bots.flatMap((a, i) =>
      round.bots.slice(i + 1).flatMap((b) => [
        { id: `${round.id}-s${seed}-${a}-${b}`, p1: a, p2: b },
        { id: `${round.id}-s${seed}-${b}-${a}`, p1: b, p2: a }
      ])
    )
    for (let at = 0; at < games.length; at += size) {
      jobs.push({ round: round.id, seed, thinkCapSec: round.thinkCapSec, games: games.slice(at, at + size) })
    }
  }
  return jobs
}

export const PlayRoundLive = PlayRound.toLayer(Effect.fn(function*(round) {
  const player = yield* GamePlayer
  const games = yield* Games
  const replays = yield* Replays
  const ratings = yield* Ratings
  const sql = yield* SqlClient.SqlClient
  const jobs = planJobs(round)
  for (const [i, job] of jobs.entries()) {
    yield* Activity.make({
      name: `job-${i}`,
      success: Schema.Int,
      error: PlayerFailed,
      execute: Effect.gen(function*() {
        const played = yield* player.play(job)
        const at = { arena: round.arena, season: round.season, round: round.id, recordedAt: new Date().toISOString() }
        const rows = yield* Effect.forEach(played, (p) =>
          Effect.gen(function*() {
            const stored = p.replay === null ? null : yield* replays.put(round.id, p.id, p.replay)
            return yield* Effect.try({
              try: () => newGame(at, { id: p.id, seed: job.seed, p1: p.p1, p2: p.p2 }, p.result, stored),
              catch: (e) => new PlayerFailed({ seed: job.seed, message: String(e) })
            })
          }))
        yield* games.record(rows)
        return rows.length
      })
    })
  }
  return yield* Activity.make({
    name: "rate",
    success: Schema.Int,
    execute: Effect.gen(function*() {
      yield* ratings.rate(round.id)
      yield* sql`UPDATE rounds SET state = 'done', ended_at = ${new Date().toISOString()} WHERE id = ${round.id}`.pipe(
        Effect.orDie
      )
      return (yield* games.countInRound(round.id)).played
    })
  })
}))

export class Rounds extends Context.Service<Rounds, {
  readonly start: (request: RoundRequest) => Effect.Effect<Round, RoundExists | NotFound>
  /** A round's state; one whose workflow failed reads failed, with the reason. */
  readonly status: (id: string) => Effect.Effect<Round, NotFound>
}>()("arena/Rounds") {
  static readonly layer = Layer.effect(
    Rounds,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const settings = yield* Settings
      const record = yield* ArenaRecord
      // the workflow engine is needed by execute and poll
      const context = yield* Effect.context<WorkflowEngine.WorkflowEngine>()

      const status = Effect.fn("Rounds.status")(function*(id: string) {
        const row = yield* record.round(id)
        if (row.state !== "running" || row.executionId === null) return roundOf(row)
        const result = yield* PlayRound.poll(row.executionId).pipe(Effect.provide(context))
        if (Option.isNone(result) || result.value._tag === "Suspended") return roundOf(row)
        const exit = result.value.exit
        // done, but read before the last activity's update landed
        if (Exit.isSuccess(exit)) return roundOf(yield* record.round(id))
        return roundOf(row, "failed", String(exit.cause))
      })

      const start = Effect.fn("Rounds.start")(function*(request: RoundRequest) {
        const arena = yield* record.arena(request.arena ?? "open")
        for (const bot of request.bots) yield* record.version(bot)
        const s = yield* settings.effective
        const payload: RoundPayload = {
          id: request.id,
          arena: arena.id,
          season: arena.season,
          bots: request.bots,
          firstSeed: request.firstSeed,
          gamesPerPair: s.gamesPerPair,
          thinkCapSec: s.thinkCapSec,
          workers: s.workers
        }
        const gamesPlanned = planJobs(payload).reduce((n, job) => n + job.games.length, 0)
        const executionId = yield* PlayRound.executionId(payload)
        const [{ next }] = yield* sql<{ next: number }>`
          SELECT coalesce(max(number) + 1, 0) AS next FROM rounds WHERE arena = ${arena.id} AND season = ${arena.season}`
          .pipe(Effect.orDie)
        const inserted = yield* sql<{ id: string }>`
          INSERT INTO rounds ${sql.insert({
            id: request.id,
            arena: arena.id,
            season: arena.season,
            number: next,
            lineup: JSON.stringify(request.bots),
            firstSeed: request.firstSeed,
            gamesPerPair: s.gamesPerPair,
            capMs: s.thinkCapSec * 1000,
            keyId: null,
            runKey: null,
            state: "running",
            gamesPlanned,
            startedAt: new Date().toISOString(),
            endedAt: null,
            error: null,
            executionId
          })} ON CONFLICT (id) DO NOTHING RETURNING id`.pipe(Effect.orDie)
        if (inserted.length === 0) return yield* new RoundExists({ id: request.id })
        yield* PlayRound.execute(payload, { discard: true }).pipe(Effect.provide(context))
        return yield* status(request.id).pipe(Effect.orDie)
      })

      return Rounds.of({ start, status })
    })
  )
}
