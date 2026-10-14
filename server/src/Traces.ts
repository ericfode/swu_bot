/**
 * Trace checks (stage 3 of the spec): every night the server plays its newest games again from their replays with
 * `node bot/trace.js check`, move by move, and keeps the verdict. A game is a function of its decks, seed, key and
 * chosen actions, so one whose moves or boards come out differently points at the engine, the referee or the recorder.
 * Each game is checked once, by the build that is live after it was played. The checker yields to rounds: it runs at
 * the lowest CPU priority and stops for the night when a round starts, since bots are timed.
 */
import { execFile, execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { setPriority } from "node:os"
import path from "node:path"
import { Config, Context, Cron, Effect, Layer, Schema } from "effect"
import { ClusterCron } from "effect/cluster"
import { SqlClient } from "effect/sql"
import { TraceCheck, TracesFailed, TracesPage } from "./Domain.ts"
import type { TracesQuery } from "./Domain.ts"
import { Replays } from "./Replays.ts"

/** What bot/trace.js check prints for each replay. */
export const TraceLine = Schema.Struct({
  file: Schema.String,
  ok: Schema.Boolean,
  steps: Schema.Int,
  ms: Schema.Number,
  diff: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String)
})
export type TraceLine = typeof TraceLine.Type
const decodeLine = Schema.decodeUnknownEffect(Schema.fromJsonString(TraceLine))

/** Games one checker process plays again (the engine takes ~7 s to load, then ~0.5 s a game). */
export const BATCH = 100
/** Games checked a night: a few days of rounds. */
export const NIGHTLY = 1000

export class TraceChecker extends Context.Service<TraceChecker, {
  /** The build that plays the games again, kept with each verdict. */
  readonly build: string | null
  /** A verdict for each replay file (absolute paths). */
  readonly check: (files: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<TraceLine>, TracesFailed>
}>()("arena/TraceChecker") {
  /**
   * bot/trace.js from ARENA_ROOT (default: the repo this server sits in), which needs the engine built there. The build
   * is ARENA_ROOT/BUILD_SHA (the games image writes it), else the checkout's commit.
   */
  static readonly layerNode = Layer.effect(
    TraceChecker,
    Effect.gen(function*() {
      const root = yield* Config.String("ARENA_ROOT").pipe(
        Config.withDefault(path.resolve(import.meta.dirname, "..", ".."))
      )
      const script = path.join(root, "bot", "trace.js")
      const build = buildAt(root)

      const run = (files: ReadonlyArray<string>) =>
        Effect.callback<string, TracesFailed>((resume, signal) => {
          const child = execFile(
            process.execPath,
            [script, "check", ...files],
            { cwd: root, signal, maxBuffer: 64 << 20 },
            (err, stdout, stderr) => {
              // exit 1: some game came out differently, and its line says how
              if (err && err.code !== 1) {
                const why = String(stderr).trim().split("\n").at(-1) || err.message
                resume(Effect.fail(new TracesFailed({ message: why })))
              } else {
                resume(Effect.succeed(stdout))
              }
            }
          )
          try {
            if (child.pid !== undefined) setPriority(child.pid, 19)
          } catch {
            // a platform that does not allow it plays at normal priority
          }
        })

      const check = Effect.fn("TraceChecker.check")(function*(files: ReadonlyArray<string>) {
        const out = yield* run(files)
        return yield* Effect.forEach(
          out.split("\n").filter((l) => l.trim().length > 0),
          (line) =>
            decodeLine(line).pipe(
              Effect.mapError((e) => new TracesFailed({ message: `unexpected output: ${e.message}` }))
            )
        )
      })

      return TraceChecker.of({ build, check })
    })
  )
}

const buildAt = (root: string): string | null => {
  try {
    return readFileSync(path.join(root, "BUILD_SHA"), "utf8").trim() || null
  } catch {
    try {
      return execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim() || null
    } catch {
      return null
    }
  }
}

/** What one run of the checker did. */
export interface TraceRun {
  readonly checked: number
  readonly differ: ReadonlyArray<{ readonly game: string; readonly diff: string }>
  /** Batches the checker could not finish; their games are tried again the next night. */
  readonly failed: ReadonlyArray<string>
  /** Why it stopped before `limit` games, if it did. */
  readonly stopped: string | null
  readonly ms: number
}

const CheckRow = Schema.Struct({
  game: Schema.String,
  round: Schema.String,
  ok: Schema.Number,
  steps: Schema.Int,
  diff: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String),
  build: Schema.NullOr(Schema.String),
  checkedAt: Schema.String
})
const decodeChecks = Schema.decodeUnknownEffect(Schema.Array(CheckRow))

export class Traces extends Context.Service<Traces, {
  /** Plays again up to `limit` of the newest games that have a replay and were never checked, newest first. */
  readonly checkNewest: (limit: number) => Effect.Effect<TraceRun>
  /** The verdicts so far, newest games first. */
  readonly list: (query: TracesQuery) => Effect.Effect<TracesPage>
}>()("arena/Traces") {
  static readonly layer = Layer.effect(
    Traces,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const replays = yield* Replays
      const checker = yield* TraceChecker

      const roundRunning = sql<{ n: number }>`SELECT count(*) AS n FROM rounds WHERE state = 'running'`.pipe(
        Effect.map((r) => (r[0]?.n ?? 0) > 0),
        Effect.orDie
      )

      const checkNewest = Effect.fn("Traces.checkNewest")(function*(limit: number) {
        const t0 = Date.now()
        const todo = yield* sql<{ id: string; replay: string }>`
          SELECT g.id, g.replay FROM games g LEFT JOIN traces t ON t.game = g.id
          WHERE g.replay IS NOT NULL AND t.game IS NULL
          ORDER BY g.seq DESC LIMIT ${limit}`.pipe(Effect.orDie)
        const files = todo.flatMap((g) => {
          const file = replays.pathOf(g.replay)
          return file === null ? [] : [{ game: g.id, file }]
        })
        let checked = 0
        const differ: Array<{ game: string; diff: string }> = []
        const failed: Array<string> = []
        let stopped: string | null = null
        for (let at = 0; at < files.length; at += BATCH) {
          if (yield* roundRunning) {
            stopped = "a round is playing"
            break
          }
          const batch = files.slice(at, at + BATCH)
          const gameOf = new Map(batch.map((b) => [b.file, b.game]))
          const lines = yield* checker.check(batch.map((b) => b.file)).pipe(
            Effect.catchTag("TracesFailed", (e) =>
              Effect.as(Effect.logWarning(`trace check of ${batch[0].game} and ${batch.length - 1} more: ${e.message}`), null))
          )
          if (lines === null) {
            failed.push(...batch.map((b) => b.game))
            continue
          }
          const checkedAt = new Date().toISOString()
          const rows = lines.flatMap((l) => {
            const game = gameOf.get(l.file)
            if (game === undefined) return []
            if (!l.ok) differ.push({ game, diff: l.diff ?? "" })
            return [{
              game,
              ok: l.ok ? 1 : 0,
              steps: l.steps,
              diff: l.diff ?? null,
              note: l.note ?? null,
              build: checker.build,
              ms: Math.round(l.ms),
              checkedAt
            }]
          })
          if (rows.length) {
            yield* sql`INSERT INTO traces ${sql.insert(rows)}
                       ON CONFLICT (game) DO UPDATE SET ok = excluded.ok, steps = excluded.steps, diff = excluded.diff,
                         note = excluded.note, build = excluded.build, ms = excluded.ms, checked_at = excluded.checked_at`
              .pipe(Effect.orDie)
          }
          checked += rows.length
        }
        return { checked, differ, failed, stopped, ms: Date.now() - t0 }
      })

      const list = Effect.fn("Traces.list")(function*(q: TracesQuery) {
        const [counts] = yield* sql<{ checked: number; differ: number; unchecked: number }>`
          SELECT
            (SELECT count(*) FROM traces) AS checked,
            (SELECT count(*) FROM traces WHERE ok = 0) AS differ,
            (SELECT count(*) FROM games g LEFT JOIN traces t ON t.game = g.id
              WHERE g.replay IS NOT NULL AND t.game IS NULL) AS unchecked`.pipe(Effect.orDie)
        const rows = yield* sql`
          SELECT t.game, g.round, t.ok, t.steps, t.diff, t.note, t.build, t.checked_at
          FROM traces t JOIN games g ON g.id = t.game
          ${q.differs === undefined ? sql`` : sql`WHERE t.ok = ${q.differs ? 0 : 1}`}
          ORDER BY g.seq DESC LIMIT ${q.limit ?? 100}`.pipe(Effect.flatMap(decodeChecks), Effect.orDie)
        return new TracesPage({
          ...counts,
          checks: rows.map((r) => new TraceCheck({ ...r, ok: r.ok === 1 }))
        })
      })

      return Traces.of({ checkNewest, list })
    })
  )
}

/** Every night at 04:00 UTC: the newest games not checked yet. */
export const NightlyTraces = ClusterCron.make({
  name: "traces",
  cron: Cron.parseUnsafe("0 4 * * *"),
  execute: Effect.gen(function*() {
    const traces = yield* Traces
    const run = yield* traces.checkNewest(NIGHTLY)
    const differ = run.differ.map((d) => `${d.game} (${d.diff})`).join("; ")
    yield* Effect.logInfo(
      `trace checks: ${run.checked} games in ${Math.round(run.ms / 1000)} s, ${run.differ.length} came out differently` +
        (differ ? `: ${differ}` : "") + (run.failed.length ? `, ${run.failed.length} not checked` : "") +
        (run.stopped ? `; stopped: ${run.stopped}` : "")
    )
  })
})
