/**
 * Finished games: written once by the round that played them (or by the import), read by the export API and the MCP
 * tools. A game's row keeps both seats' time used flat, and the API nests it (Game.time).
 */
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql"
import type { Statement } from "effect/sql"
import { Game, GamesPage, NotFound, Outcome, Seat } from "./Domain.ts"
import type { ExportQuery, GamesQuery, SeatTime } from "./Domain.ts"
import { scoreOf } from "./Ratings.ts"
import type { Scored } from "./Ratings.ts"
import type { Stored } from "./Replays.ts"
import { Replays } from "./Replays.ts"

/** A game to record. */
export interface NewGame {
  readonly id: string
  readonly arena: string
  readonly season: number
  readonly round: string
  readonly seed: number
  readonly dealKey: string | null
  readonly p1: string
  readonly p2: string
  readonly end: Scored
  readonly gameRounds: number
  readonly steps: number
  readonly ms: number
  readonly time: { readonly p1: SeatTime; readonly p2: SeatTime }
  readonly host: string | null
  readonly replay: Stored | null
  readonly recordedAt: string
}

/** One seat's timing as the referee measures it: decisions, total ms, p95 and max per decision. */
const RawTiming = Schema.Struct({
  n: Schema.Number,
  ms: Schema.Number,
  p95: Schema.Number,
  max: Schema.Number
})

/**
 * A game as today's referee reports it: a row of runs/<round>.games[] (with its ladder's `think`), or a result printed
 * by play-seed.js. Fields the record does not keep are ignored.
 */
export const RawGame = Schema.Struct({
  outcome: Schema.String,
  winner: Schema.optional(Schema.NullOr(Schema.String)),
  winnerSeat: Schema.optional(Schema.NullOr(Schema.String)),
  by: Schema.optional(Schema.NullOr(Schema.String)),
  faultKind: Schema.optional(Schema.NullOr(Schema.String)),
  error: Schema.optional(Schema.NullOr(Schema.String)),
  rounds: Schema.optional(Schema.Int),
  round: Schema.optional(Schema.Int),
  steps: Schema.Int,
  ms: Schema.Number,
  key: Schema.optional(Schema.NullOr(Schema.String)),
  host: Schema.optional(Schema.NullOr(Schema.String)),
  timing: Schema.optional(Schema.NullOr(Schema.Struct({ p1: Schema.NullOr(RawTiming), p2: Schema.NullOr(RawTiming) }))),
  think: Schema.optional(Schema.NullOr(Schema.Struct({ p1: Schema.NullOr(Schema.Number), p2: Schema.NullOr(Schema.Number) })))
})
export type RawGame = typeof RawGame.Type

const seatTime = (t: typeof RawTiming.Type | null | undefined, think: number | null | undefined): SeatTime => ({
  thinkMs: think ?? null,
  decisions: t ? t.n : null,
  decideMs: t ? t.ms : null,
  p95Ms: t ? t.p95 : null,
  maxMs: t ? t.max : null
})

/** The game to record for `raw`, played in round `at.round` as `game`. Throws on a game that has not ended. */
export const newGame = (
  at: { readonly arena: string; readonly season: number; readonly round: string; readonly recordedAt: string },
  game: { readonly id: string; readonly seed: number; readonly p1: string; readonly p2: string },
  raw: RawGame,
  replay: Stored | null
): NewGame => ({
  ...at,
  ...game,
  dealKey: raw.key ?? null,
  end: scoreOf(game.p1, game.p2, raw),
  gameRounds: raw.rounds ?? raw.round ?? 0,
  steps: raw.steps,
  ms: raw.ms,
  time: { p1: seatTime(raw.timing?.p1, raw.think?.p1), p2: seatTime(raw.timing?.p2, raw.think?.p2) },
  host: raw.host ?? null,
  replay
})

const NullNum = Schema.NullOr(Schema.Number)

const GameRow = Schema.Struct({
  seq: Schema.Int,
  id: Schema.String,
  arena: Schema.String,
  season: Schema.Int,
  round: Schema.String,
  seed: Schema.Int,
  dealKey: Schema.NullOr(Schema.String),
  p1: Schema.String,
  p2: Schema.String,
  outcome: Outcome,
  winner: Schema.NullOr(Schema.String),
  winnerSeat: Schema.NullOr(Seat),
  score: NullNum,
  faultSeat: Schema.NullOr(Seat),
  faultKind: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  gameRounds: Schema.Int,
  steps: Schema.Int,
  ms: Schema.Int,
  p1ThinkMs: NullNum,
  p2ThinkMs: NullNum,
  p1Decisions: Schema.NullOr(Schema.Int),
  p2Decisions: Schema.NullOr(Schema.Int),
  p1DecideMs: NullNum,
  p2DecideMs: NullNum,
  p1P95Ms: NullNum,
  p2P95Ms: NullNum,
  p1MaxMs: NullNum,
  p2MaxMs: NullNum,
  host: Schema.NullOr(Schema.String),
  replay: Schema.NullOr(Schema.String),
  recordedAt: Schema.String
})
type GameRow = typeof GameRow.Type

export const GAME_COLUMNS = Object.keys(GameRow.fields).map((k) => k.replace(/([A-Z])/g, "_$1").toLowerCase()).join(", ")

const gameOf = (r: GameRow) =>
  new Game({
    seq: r.seq,
    id: r.id,
    arena: r.arena,
    season: r.season,
    round: r.round,
    seed: r.seed,
    dealKey: r.dealKey,
    p1: r.p1,
    p2: r.p2,
    outcome: r.outcome,
    winner: r.winner,
    winnerSeat: r.winnerSeat,
    score: r.score,
    faultSeat: r.faultSeat,
    faultKind: r.faultKind,
    error: r.error,
    gameRounds: r.gameRounds,
    steps: r.steps,
    ms: r.ms,
    time: {
      p1: { thinkMs: r.p1ThinkMs, decisions: r.p1Decisions, decideMs: r.p1DecideMs, p95Ms: r.p1P95Ms, maxMs: r.p1MaxMs },
      p2: { thinkMs: r.p2ThinkMs, decisions: r.p2Decisions, decideMs: r.p2DecideMs, p95Ms: r.p2P95Ms, maxMs: r.p2MaxMs }
    },
    host: r.host,
    replay: r.replay !== null,
    recordedAt: r.recordedAt
  })

/** The row a new game is inserted as. */
const rowOf = (g: NewGame) => ({
  id: g.id,
  arena: g.arena,
  season: g.season,
  round: g.round,
  seed: g.seed,
  dealKey: g.dealKey,
  p1: g.p1,
  p2: g.p2,
  outcome: g.end.outcome,
  winner: g.end.winner,
  winnerSeat: g.end.winnerSeat,
  score: g.end.score,
  faultSeat: g.end.faultSeat,
  faultKind: g.end.faultKind,
  error: g.end.error,
  gameRounds: g.gameRounds,
  steps: g.steps,
  ms: Math.round(g.ms),
  p1ThinkMs: g.time.p1.thinkMs,
  p2ThinkMs: g.time.p2.thinkMs,
  p1Decisions: g.time.p1.decisions,
  p2Decisions: g.time.p2.decisions,
  p1DecideMs: g.time.p1.decideMs,
  p2DecideMs: g.time.p2.decideMs,
  p1P95Ms: g.time.p1.p95Ms,
  p2P95Ms: g.time.p2.p95Ms,
  p1MaxMs: g.time.p1.maxMs,
  p2MaxMs: g.time.p2.maxMs,
  host: g.host,
  replay: g.replay?.path ?? null,
  replayBytes: g.replay?.bytes ?? null,
  replaySha256: g.replay?.sha256 ?? null,
  recordedAt: g.recordedAt
})

const PAGE = 500

export class Games extends Context.Service<Games, {
  /** Newest first, a page at a time. */
  readonly list: (query: GamesQuery) => Effect.Effect<GamesPage>
  readonly get: (id: string) => Effect.Effect<Game, NotFound>
  /** The gzipped replay, or NotFound. */
  readonly replay: (id: string) => Effect.Effect<Uint8Array, NotFound>
  /** Every matching game, oldest first, as JSON lines. */
  readonly exportLines: (query: ExportQuery) => Stream.Stream<string>
  /**
   * Writes games; a game already recorded keeps its row (only a missing replay is filled in), so a replayed job or a
   * second import changes nothing.
   */
  readonly record: (games: ReadonlyArray<NewGame>) => Effect.Effect<void>
  readonly countInRound: (round: string) => Effect.Effect<{ readonly played: number; readonly rated: number }>
}>()("arena/Games") {
  static readonly layer = Layer.effect(
    Games,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const replays = yield* Replays

      const filters = (q: { readonly arena?: string; readonly season?: number; readonly since?: string }) => [
        ...(q.arena === undefined ? [] : [sql`arena = ${q.arena}`]),
        ...(q.season === undefined ? [] : [sql`season = ${q.season}`]),
        ...(q.since === undefined ? [] : [sql`recorded_at >= ${q.since}`])
      ]
      const where = (parts: ReadonlyArray<Statement.Fragment>) => parts.length ? sql`WHERE ${sql.and(parts)}` : sql``

      const decodeRows = Schema.decodeUnknownEffect(Schema.Array(GameRow))
      const page = (where: Statement.Fragment, limit: number, order: "ASC" | "DESC") =>
        sql`SELECT ${sql.literal(GAME_COLUMNS)} FROM games ${where} ORDER BY seq ${sql.literal(order)} LIMIT ${limit}`.pipe(
          Effect.flatMap(decodeRows),
          Effect.orDie
        )

      const list = Effect.fn("Games.list")(function*(q: GamesQuery) {
        const limit = q.limit ?? 100
        const rows = yield* page(where([
          ...filters(q),
          ...(q.round === undefined ? [] : [sql`round = ${q.round}`]),
          ...(q.version === undefined ? [] : [sql`(p1 = ${q.version} OR p2 = ${q.version})`]),
          ...(q.before === undefined ? [] : [sql`seq < ${q.before}`])
        ]), limit + 1, "DESC")
        const games = rows.slice(0, limit).map(gameOf)
        return new GamesPage({ games, next: rows.length > limit ? games[games.length - 1].seq : null })
      })

      const findRow = (id: string) =>
        page(where([sql`id = ${id}`]), 1, "ASC").pipe(
          Effect.flatMap((rows) => rows.length ? Effect.succeed(rows[0]) : Effect.fail(new NotFound({ what: "game", id })))
        )

      const get = (id: string) => Effect.map(findRow(id), gameOf)

      const replay = Effect.fn("Games.replay")(function*(id: string) {
        const row = yield* findRow(id)
        const gz = row.replay === null ? null : yield* replays.get(row.replay)
        if (gz === null) return yield* new NotFound({ what: "replay", id })
        return gz
      })

      const encode = Schema.encodeSync(Game)
      const exportLines = (q: ExportQuery) =>
        Stream.paginate(q.after ?? 0, (after: number) =>
          page(where([...filters(q), sql`seq > ${after}`]), PAGE, "ASC").pipe(
            Effect.map((rows) =>
              [
                rows.map((r) => `${JSON.stringify(encode(gameOf(r)))}\n`),
                rows.length === PAGE ? Option.some(rows[rows.length - 1].seq) : Option.none()
              ] as const
            )
          ))

      const record = Effect.fn("Games.record")(function*(games: ReadonlyArray<NewGame>) {
        const rows = games.map(rowOf)
        for (let at = 0; at < rows.length; at += 200) {
          yield* sql`INSERT INTO games ${sql.insert(rows.slice(at, at + 200))}
                     ON CONFLICT (id) DO UPDATE SET
                       replay = coalesce(games.replay, excluded.replay),
                       replay_bytes = coalesce(games.replay_bytes, excluded.replay_bytes),
                       replay_sha256 = coalesce(games.replay_sha256, excluded.replay_sha256)`
        }
      }, Effect.orDie)

      const countInRound = (round: string) =>
        sql<{ played: number; rated: number }>`
          SELECT count(*) AS played, count(score) AS rated FROM games WHERE round = ${round}`.pipe(
          Effect.map((r) => ({ played: r[0]?.played ?? 0, rated: r[0]?.rated ?? 0 })),
          Effect.orDie
        )

      return Games.of({ list, get, replay, exportLines, record, countInRound })
    })
  )
}
