/**
 * Reads of the record that are not single games: arenas and seasons, competitors and versions, rounds, standings and
 * a version's stats. The export API and the MCP tools both call these.
 */
import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import {
  Arena,
  ArenaRules,
  Competitor,
  NotFound,
  Rating,
  Round,
  RoundStanding,
  SeasonInfo,
  Standings,
  Version,
  VersionFormat,
  VersionStats
} from "./Domain.ts"
import type { Tally } from "./Domain.ts"

const Bool = Schema.BooleanFromBit

const ArenaRow = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  season: Schema.Int,
  rules: Schema.fromJsonString(ArenaRules)
})
const SeasonRow = Schema.Struct({
  arena: Schema.String,
  number: Schema.Int,
  rules: Schema.fromJsonString(ArenaRules),
  startedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String)
})
const CompetitorRow = Schema.Struct({
  name: Schema.String,
  title: Schema.String,
  owner: Schema.NullOr(Schema.String),
  house: Bool,
  about: Schema.NullOr(Schema.String),
  registeredAt: Schema.String,
  benchedAt: Schema.NullOr(Schema.String)
})
const VersionRow = Schema.Struct({
  id: Schema.String,
  competitor: Schema.String,
  number: Schema.Int,
  kind: Schema.Literals(["bot", "evaluator"]),
  format: VersionFormat,
  sha256: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String),
  files: Schema.fromJsonString(Schema.Array(Schema.String)),
  submission: Schema.NullOr(Schema.String),
  submittedAt: Schema.NullOr(Schema.String),
  withdrawn: Bool
})
export const RoundRow = Schema.Struct({
  id: Schema.String,
  arena: Schema.String,
  season: Schema.Int,
  number: Schema.Int,
  lineup: Schema.fromJsonString(Schema.Array(Schema.String)),
  firstSeed: Schema.Int,
  gamesPerPair: Schema.Int,
  capMs: Schema.Int,
  keyId: Schema.NullOr(Schema.String),
  runKey: Schema.NullOr(Schema.String),
  state: Schema.Literals(["running", "done", "failed"]),
  gamesPlanned: Schema.Int,
  gamesPlayed: Schema.Int,
  rated: Schema.Int,
  startedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  executionId: Schema.NullOr(Schema.String)
})
export type RoundRow = typeof RoundRow.Type
const RatingRow = Schema.Struct({
  round: Schema.String,
  scope: Schema.Literals(["round", "season"]),
  version: Schema.String,
  competitor: Schema.String,
  rating: Schema.Number,
  se: Schema.Number,
  anchor: Bool,
  games: Schema.Int,
  wins: Schema.Int,
  losses: Schema.Int,
  draws: Schema.Int,
  unrated: Schema.Int,
  forfeits: Schema.Int
})
type RatingRow = typeof RatingRow.Type
const SeatGame = Schema.Struct({
  p1: Schema.String,
  p2: Schema.String,
  score: Schema.NullOr(Schema.Number),
  faultSeat: Schema.NullOr(Schema.String),
  p1ThinkMs: Schema.NullOr(Schema.Number),
  p2ThinkMs: Schema.NullOr(Schema.Number),
  p1Decisions: Schema.NullOr(Schema.Int),
  p2Decisions: Schema.NullOr(Schema.Int),
  p1DecideMs: Schema.NullOr(Schema.Number),
  p2DecideMs: Schema.NullOr(Schema.Number),
  p1P95Ms: Schema.NullOr(Schema.Number),
  p2P95Ms: Schema.NullOr(Schema.Number)
})
const SpotRow = Schema.Struct({
  spot: Schema.Literals([
    "base_behind",
    "board_behind",
    "low_base",
    "cards_behind",
    "close_mid",
    "long_game",
    "base_ahead",
    "board_ahead",
    "kill_range"
  ]),
  edge: Schema.Number,
  n: Schema.Int,
  se: Schema.NullOr(Schema.Number)
})

const ROUND_COLUMNS = `r.id, r.arena, r.season, r.number, r.lineup, r.first_seed, r.games_per_pair, r.cap_ms, r.key_id,
  r.run_key, r.state, r.games_planned, r.started_at, r.ended_at, r.error, r.execution_id,
  (SELECT count(*) FROM games g WHERE g.round = r.id) AS games_played,
  (SELECT count(g.score) FROM games g WHERE g.round = r.id) AS rated`

export const roundOf = (r: RoundRow, state = r.state, error = r.error) =>
  new Round({
    id: r.id,
    arena: r.arena,
    season: r.season,
    number: r.number,
    lineup: r.lineup,
    firstSeed: r.firstSeed,
    gamesPerPair: r.gamesPerPair,
    capMs: r.capMs,
    keyId: r.keyId,
    runKey: r.runKey,
    state,
    gamesPlanned: r.gamesPlanned,
    gamesPlayed: r.gamesPlayed,
    rated: r.rated,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    error
  })

const ratingOf = (r: RatingRow) =>
  new Rating({
    version: r.version,
    competitor: r.competitor,
    rating: Math.round(r.rating),
    se: Math.round(r.se),
    anchor: r.anchor,
    record: { games: r.games, wins: r.wins, losses: r.losses, draws: r.draws, unrated: r.unrated, forfeits: r.forfeits }
  })

const emptyTally = () => ({ games: 0, wins: 0, losses: 0, draws: 0, unrated: 0, forfeits: 0 })

export class ArenaRecord extends Context.Service<ArenaRecord, {
  readonly arenas: Effect.Effect<ReadonlyArray<Arena>>
  readonly arena: (id: string) => Effect.Effect<Arena, NotFound>
  readonly standings: (arena: string, season?: number) => Effect.Effect<Standings, NotFound>
  readonly competitors: Effect.Effect<ReadonlyArray<Competitor>>
  readonly versions: (competitor?: string) => Effect.Effect<ReadonlyArray<Version>>
  readonly version: (id: string) => Effect.Effect<Version, NotFound>
  readonly versionStats: (id: string, arena?: string, season?: number) => Effect.Effect<VersionStats, NotFound>
  readonly rounds: (arena?: string, season?: number) => Effect.Effect<ReadonlyArray<RoundRow>>
  readonly round: (id: string) => Effect.Effect<RoundRow, NotFound>
}>()("arena/ArenaRecord") {
  static readonly layer = Layer.effect(
    ArenaRecord,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const orDie = Effect.orDie

      const arenaRows = SqlSchema.findAll({
        Request: Schema.NullOr(Schema.String),
        Result: ArenaRow,
        execute: (id) => sql`SELECT id, title, season, rules FROM arenas ${id === null ? sql`` : sql`WHERE id = ${id}`} ORDER BY id`
      })
      const seasonRows = SqlSchema.findAll({
        Request: Schema.Void,
        Result: SeasonRow,
        execute: () => sql`SELECT arena, number, rules, started_at, ended_at, note FROM seasons ORDER BY arena, number`
      })
      const arenasOf = Effect.fn(function*(id: string | null) {
        const rows = yield* arenaRows(id)
        const seasons = yield* seasonRows(undefined)
        return rows.map((a) =>
          new Arena({ ...a, seasons: seasons.filter((s) => s.arena === a.id).map((s) => new SeasonInfo(s)) })
        )
      })
      const arenas = arenasOf(null).pipe(orDie)
      const arena = (id: string) =>
        arenasOf(id).pipe(
          orDie,
          Effect.flatMap((all) => all.length ? Effect.succeed(all[0]) : Effect.fail(new NotFound({ what: "arena", id })))
        )

      const roundRows = SqlSchema.findAll({
        Request: Schema.Struct({ arena: Schema.NullOr(Schema.String), season: Schema.NullOr(Schema.Int) }),
        Result: RoundRow,
        execute: (q) =>
          sql`SELECT ${sql.literal(ROUND_COLUMNS)} FROM rounds r
              WHERE ${sql.and([
            q.arena === null ? sql`1 = 1` : sql`r.arena = ${q.arena}`,
            q.season === null ? sql`1 = 1` : sql`r.season = ${q.season}`
          ])}
              ORDER BY r.arena, r.season, r.number`
      })
      const roundRow = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: RoundRow,
        execute: (id) => sql`SELECT ${sql.literal(ROUND_COLUMNS)} FROM rounds r WHERE r.id = ${id}`
      })
      const rounds = (arena?: string, season?: number) => roundRows({ arena: arena ?? null, season: season ?? null }).pipe(orDie)
      const round = (id: string) =>
        roundRow(id).pipe(
          orDie,
          Effect.flatMap(Option.match({
            onNone: () => Effect.fail(new NotFound({ what: "round", id })),
            onSome: Effect.succeed
          }))
        )

      const ratingRows = SqlSchema.findAll({
        Request: Schema.Struct({ arena: Schema.String, season: Schema.Int }),
        Result: RatingRow,
        execute: (q) =>
          sql`SELECT t.round, t.scope, t.version, v.competitor, t.rating, t.se, t.anchor, t.games, t.wins, t.losses,
                     t.draws, t.unrated, t.forfeits
              FROM ratings t JOIN rounds r ON r.id = t.round JOIN versions v ON v.id = t.version
              WHERE r.arena = ${q.arena} AND r.season = ${q.season}
              ORDER BY r.number, t.scope, t.rating DESC, t.version`
      })

      const standings = Effect.fn("ArenaRecord.standings")(function*(id: string, season?: number) {
        const a = yield* arena(id)
        const s = season ?? a.season
        const done = (yield* rounds(id, s)).filter((r) => r.state === "done")
        const ratings = yield* ratingRows({ arena: id, season: s }).pipe(orDie)
        return new Standings({
          arena: id,
          season: s,
          rounds: done.map((r) =>
            new RoundStanding({
              round: r.id,
              number: r.number,
              endedAt: r.endedAt,
              thisRound: ratings.filter((x) => x.round === r.id && x.scope === "round").map(ratingOf),
              season: ratings.filter((x) => x.round === r.id && x.scope === "season").map(ratingOf)
            })
          )
        })
      })

      const competitorRows = SqlSchema.findAll({
        Request: Schema.Void,
        Result: CompetitorRow,
        execute: () =>
          sql`SELECT name, title, owner, house, about, registered_at, benched_at FROM competitors ORDER BY house, name`
      })
      const competitors = competitorRows(undefined).pipe(orDie, Effect.map((rows) => rows.map((r) => new Competitor(r))))

      const VERSION_COLUMNS = "id, competitor, number, kind, format, sha256, note, files, submission, submitted_at, withdrawn"
      const versionRows = SqlSchema.findAll({
        Request: Schema.NullOr(Schema.String),
        Result: VersionRow,
        execute: (competitor) =>
          sql`SELECT ${sql.literal(VERSION_COLUMNS)} FROM versions
              ${competitor === null ? sql`` : sql`WHERE competitor = ${competitor}`} ORDER BY competitor, number`
      })
      const versionRow = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: VersionRow,
        execute: (id) => sql`SELECT ${sql.literal(VERSION_COLUMNS)} FROM versions WHERE id = ${id}`
      })
      const versions = (competitor?: string) =>
        versionRows(competitor ?? null).pipe(orDie, Effect.map((rows) => rows.map((r) => new Version(r))))
      const version = (id: string) =>
        versionRow(id).pipe(
          orDie,
          Effect.flatMap(Option.match({
            onNone: () => Effect.fail(new NotFound({ what: "version", id })),
            onSome: (r) => Effect.succeed(new Version(r))
          }))
        )

      const gamesOf = SqlSchema.findAll({
        Request: Schema.Struct({ version: Schema.String, arena: Schema.String, season: Schema.Int }),
        Result: SeatGame,
        execute: (q) =>
          sql`SELECT p1, p2, score, fault_seat, p1_think_ms, p2_think_ms, p1_decisions, p2_decisions, p1_decide_ms,
                     p2_decide_ms, p1_p95_ms, p2_p95_ms
              FROM games WHERE arena = ${q.arena} AND season = ${q.season} AND (p1 = ${q.version} OR p2 = ${q.version})
              ORDER BY seq`
      })
      const latestRating = SqlSchema.findOneOption({
        Request: Schema.Struct({ version: Schema.String, arena: Schema.String, season: Schema.Int }),
        Result: RatingRow,
        execute: (q) =>
          sql`SELECT t.round, t.scope, t.version, v.competitor, t.rating, t.se, t.anchor, t.games, t.wins, t.losses,
                     t.draws, t.unrated, t.forfeits
              FROM ratings t JOIN rounds r ON r.id = t.round JOIN versions v ON v.id = t.version
              WHERE t.version = ${q.version} AND t.scope = 'season' AND r.arena = ${q.arena} AND r.season = ${q.season}
                AND EXISTS (SELECT 1 FROM games g WHERE g.round = t.round AND (g.p1 = t.version OR g.p2 = t.version))
              ORDER BY r.number DESC LIMIT 1`
      })
      const spotsOf = SqlSchema.findAll({
        Request: Schema.Struct({ version: Schema.String, arena: Schema.String, season: Schema.Int }),
        Result: SpotRow,
        execute: (q) =>
          sql`SELECT spot, edge, n, se FROM spots
              WHERE version = ${q.version} AND arena = ${q.arena} AND season = ${q.season} ORDER BY spot`
      })

      const versionStats = Effect.fn("ArenaRecord.versionStats")(function*(id: string, arenaId = "open", season?: number) {
        yield* version(id)
        const a = yield* arena(arenaId)
        const q = { version: id, arena: arenaId, season: season ?? a.season }
        const games = yield* gamesOf(q).pipe(orDie)
        const record: Tally = emptyTally()
        const vs = new Map<string, ReturnType<typeof emptyTally>>()
        const time = { games: 0, decisions: 0, decideMs: 0, p95: null as number | null, thinkMs: 0, maxThink: null as number | null }
        for (const g of games) {
          const seat = g.p1 === id ? "p1" : "p2"
          const opponent = seat === "p1" ? g.p2 : g.p1
          const h = vs.get(opponent) ?? emptyTally()
          vs.set(opponent, h)
          const mine = g.score === null ? null : seat === "p1" ? g.score : 1 - g.score
          for (const t of [record, h] as Array<ReturnType<typeof emptyTally>>) {
            t.games++
            if (g.faultSeat === seat) t.forfeits++
            if (mine === null) t.unrated++
            else if (mine === 0.5) t.draws++
            else if (mine === 1) t.wins++
            else t.losses++
          }
          const decisions = seat === "p1" ? g.p1Decisions : g.p2Decisions
          const decideMs = seat === "p1" ? g.p1DecideMs : g.p2DecideMs
          const p95 = seat === "p1" ? g.p1P95Ms : g.p2P95Ms
          const think = seat === "p1" ? g.p1ThinkMs : g.p2ThinkMs
          time.games++
          time.decisions += decisions ?? 0
          time.decideMs += decideMs ?? 0
          if (p95 !== null) time.p95 = Math.max(time.p95 ?? 0, p95)
          if (think !== null) {
            time.thinkMs += think
            time.maxThink = Math.max(time.maxThink ?? 0, think)
          }
        }
        const rating = yield* latestRating(q).pipe(orDie)
        return new VersionStats({
          version: id,
          arena: arenaId,
          season: q.season,
          record,
          rating: Option.match(rating, { onNone: () => null, onSome: ratingOf }),
          headToHead: [...vs].map(([opponent, record]) => ({ opponent, record }))
            .sort((x, y) => y.record.games - x.record.games || x.opponent.localeCompare(y.opponent)),
          time: {
            games: time.games,
            decisions: time.decisions,
            decideMs: Math.round(time.decideMs),
            msPerDecision: time.decisions ? Math.round((time.decideMs / time.decisions) * 10) / 10 : null,
            p95Ms: time.p95,
            thinkMs: Math.round(time.thinkMs),
            maxGameThinkMs: time.maxThink
          },
          spots: yield* spotsOf(q).pipe(orDie)
        })
      })

      return ArenaRecord.of({ arenas, arena, standings, competitors, versions, version, versionStats, rounds, round })
    })
  )
}
