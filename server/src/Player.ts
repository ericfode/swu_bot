/**
 * The game player (Eric's pick 1A): Node plays the games, this server does the rest. One job is a seed's share of a
 * round, at most 8 games, played by `node bot/arena/play-seed.js` in its own process. Its one line of output is
 * checked against a schema before any of it becomes a game record.
 */
import { execFile } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Config, Context, Effect, Layer, Schema } from "effect"
import { PlayerFailed } from "./Domain.ts"
import { RawGame } from "./Games.ts"

export const MAX_JOB_GAMES = 8 // play-seed.js MAX_GAMES

export const JobGame = Schema.Struct({ id: Schema.String, p1: Schema.String, p2: Schema.String })

/** One process's worth of games: all on one seed. */
export const Job = Schema.Struct({
  round: Schema.String,
  seed: Schema.Int,
  thinkCapSec: Schema.Int,
  games: Schema.Array(JobGame)
})
export type Job = typeof Job.Type

/** What play-seed.js prints: {ok, results: [{id, result}], replays: {<id>: <path>}}. */
const SeedOutput = Schema.Struct({
  ok: Schema.Literal(true),
  results: Schema.Array(Schema.Struct({ id: Schema.String, result: RawGame })),
  replays: Schema.optional(Schema.Record(Schema.String, Schema.String))
})
const decodeOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(SeedOutput))

/** A game the player played: its result as the referee reports it, and its replay's text when it has one. */
export interface Played {
  readonly id: string
  readonly p1: string
  readonly p2: string
  readonly result: RawGame
  readonly replay: Uint8Array | null
}

export class GamePlayer extends Context.Service<GamePlayer, {
  readonly play: (job: Job) => Effect.Effect<ReadonlyArray<Played>, PlayerFailed>
}>()("arena/GamePlayer") {
  /**
   * Plays jobs with play-seed.js from ARENA_ROOT (default: the repo this server sits in), which needs the engine built
   * there. Interrupting a job kills its process.
   */
  static readonly layerNode = Layer.effect(
    GamePlayer,
    Effect.gen(function*() {
      const root = yield* Config.String("ARENA_ROOT").pipe(
        Config.withDefault(path.resolve(import.meta.dirname, "..", ".."))
      )
      const script = path.join(root, "bot", "arena", "play-seed.js")

      // plays the job in a fresh folder, and reads what it needs from its output before the folder is removed
      const run = <A>(job: Job, use: (stdout: string) => Effect.Effect<A, PlayerFailed>) =>
        Effect.acquireUseRelease(
          Effect.sync(() => mkdtempSync(path.join(tmpdir(), "arena-job-"))),
          (dir) =>
            Effect.callback<string, PlayerFailed>((resume, signal) => {
              const doc = {
                v: 1,
                seed: job.seed,
                key: null,
                maxSteps: 6000,
                capMs: job.thinkCapSec * 1000,
                hangMs: 60000,
                gameMs: 0,
                games: job.games,
                bots: Object.fromEntries(job.games.flatMap((g) => [g.p1, g.p2]).map((b) => [b, { kind: "resident" }]))
              }
              writeFileSync(path.join(dir, "job.json"), JSON.stringify(doc))
              execFile(
                process.execPath,
                [script, "--job", path.join(dir, "job.json"), "--bundles", dir, "--work", dir],
                { cwd: root, signal, maxBuffer: 16 << 20 },
                (err, stdout, stderr) => {
                  if (err) {
                    const why = String(stderr).trim().split("\n").at(-1) || err.message
                    resume(Effect.fail(new PlayerFailed({ seed: job.seed, message: why })))
                  } else {
                    resume(Effect.succeed(stdout))
                  }
                }
              )
            }).pipe(Effect.flatMap(use)),
          (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))
        )

      const play = Effect.fn("GamePlayer.play")(function*(job: Job) {
        yield* Effect.logInfo(`playing ${job.round} seed ${job.seed}: ${job.games.map((g) => g.id).join(", ")}`)
        return yield* run(job, (out) =>
          Effect.gen(function*() {
            const doc = yield* decodeOutput(out.trim()).pipe(
              Effect.mapError((e) => new PlayerFailed({ seed: job.seed, message: `unexpected output: ${e.message}` }))
            )
            return yield* playedOf(job, doc.results, (id) => {
              const file = doc.replays?.[id]
              return file === undefined ? null : new Uint8Array(readFileSync(path.resolve(root, file)))
            })
          }))
      })

      return GamePlayer.of({ play })
    })
  )
}

/** The job's games, each with its result; a game the player did not report fails the job. */
export const playedOf = (
  job: Job,
  results: ReadonlyArray<{ readonly id: string; readonly result: RawGame }>,
  replayOf: (id: string) => Uint8Array | null
): Effect.Effect<ReadonlyArray<Played>, PlayerFailed> =>
  Effect.forEach(job.games, (g) => {
    const result = results.find((x) => x.id === g.id)?.result
    if (!result) return Effect.fail(new PlayerFailed({ seed: job.seed, message: `no result for ${g.id}` }))
    return Effect.try({
      try: () => ({ ...g, result, replay: replayOf(g.id) }),
      catch: (e) => new PlayerFailed({ seed: job.seed, message: `no replay for ${g.id}: ${String(e)}` })
    })
  })
