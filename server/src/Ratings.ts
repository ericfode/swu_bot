/**
 * Ratings, computed in one place: Bradley-Terry on the Elo scale, with a standard error per version, the same math
 * as today's referee (bot/ratings.js bradleyTerry, bot/arena/referee.js anchoredBT and globalElo) so the record
 * reproduces today's standings exactly. After each round the arena stores two ratings per version: on that round's
 * games alone, and on every game of the season so far.
 */
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"

/** A rated game: a against b, a's score 1, 0.5 or 0. */
export interface Result {
  readonly a: string
  readonly b: string
  readonly score: number
}

export interface Fitted {
  readonly rating: number
  readonly se: number
}

const SCALE = 400 / Math.LN10

/**
 * Bradley-Terry by the MM algorithm (Hunter 2004), as bot/ratings.js: `prior` virtual draws per version against a
 * fixed opponent of strength 1, at most 500 iterations or until no strength moves by 1e-10. Ratings are on the Elo
 * scale with their geometric mean at 1500, then shifted so the mean of `anchors` (those among `names`) is 1500.
 * The standard error is the Fisher information's, as the app's model computes it.
 */
export const fit = (
  names: ReadonlyArray<string>,
  results: ReadonlyArray<Result>,
  anchors: ReadonlyArray<string>,
  { prior = 1, iters = 500 } = {}
): Map<string, Fitted> => {
  const n = names.length
  const idx = new Map(names.map((x, i) => [x, i]))
  const wins: Array<number> = new Array(n).fill(prior / 2)
  const games: Array<Array<number>> = Array.from({ length: n }, () => new Array(n).fill(0))
  for (const g of results) {
    const i = idx.get(g.a)
    const j = idx.get(g.b)
    if (i === undefined || j === undefined) throw new Error(`a result names ${g.a} or ${g.b}, which is not rated`)
    wins[i] += g.score
    wins[j] += 1 - g.score
    games[i][j]++
    games[j][i]++
  }
  let gamma: Array<number> = new Array(n).fill(1)
  for (let it = 0; it < iters; it++) {
    const next = gamma.map((gi, i) => {
      let denom = prior / (gi + 1)
      for (let j = 0; j < n; j++) {
        if (games[i][j]) denom += games[i][j] / (gi + gamma[j])
      }
      return denom > 0 ? wins[i] / denom : gi
    })
    const delta = next.reduce((m, x, i) => Math.max(m, Math.abs(x - gamma[i])), 0)
    gamma = next
    if (delta < 1e-10) break
  }
  const geo = Math.exp(gamma.reduce((s, x) => s + Math.log(x), 0) / n)
  const elo = gamma.map((g) => 1500 + 400 * Math.log10(g / geo))
  const pinned = anchors.filter((a) => idx.has(a)).map((a) => elo[idx.get(a)!])
  const shift = pinned.length ? 1500 - pinned.reduce((s, x) => s + x, 0) / pinned.length : 0
  return new Map(names.map((name, i) => {
    let info = prior * gamma[i] / (gamma[i] + 1) ** 2
    for (let j = 0; j < n; j++) {
      if (games[i][j]) info += games[i][j] * gamma[i] * gamma[j] / (gamma[i] + gamma[j]) ** 2
    }
    return [name, { rating: elo[i] + shift, se: SCALE / Math.sqrt(info || 1e-9) }]
  }))
}

// ---------------------------------------------------------------------------------------------------------------------
// Scoring a game
// ---------------------------------------------------------------------------------------------------------------------

/** A game's end as the referee reports it (runs/<round>.games[], play-seed.js results). */
export interface RawEnd {
  readonly outcome: string
  readonly winner?: string | null | undefined
  readonly winnerSeat?: string | null | undefined
  readonly by?: string | null | undefined
  readonly faultKind?: string | null | undefined
  readonly error?: string | null | undefined
}

export interface Scored {
  readonly outcome: "won" | "draw" | "forfeit" | "error" | "step_cap" | "stuck" | "abandoned"
  readonly winner: string | null
  readonly winnerSeat: "p1" | "p2" | null
  readonly score: number | null
  readonly faultSeat: "p1" | "p2" | null
  readonly faultKind: string | null
  readonly error: string | null
}

/**
 * The referee's rule (bot/arena/referee.js cappedScore): a game a bot broke is that seat's loss; otherwise only a game
 * played out counts, a draw as half. Anything else is kept as a game but not rated. Throws on a game that has not
 * ended or names no winner, so nothing is guessed.
 */
export const scoreOf = (p1: string, p2: string, end: RawEnd): Scored => {
  const error = end.error ?? null
  const base = { winner: null, winnerSeat: null, score: null, faultSeat: null, faultKind: null, error }
  if (end.outcome === "ERROR" && (end.by === "p1" || end.by === "p2")) {
    const faultSeat = end.by
    const winnerSeat = faultSeat === "p1" ? "p2" : "p1"
    return {
      ...base,
      outcome: "forfeit",
      faultSeat,
      faultKind: end.faultKind ?? null,
      winnerSeat,
      winner: winnerSeat === "p1" ? p1 : p2,
      score: faultSeat === "p1" ? 0 : 1
    }
  }
  if (end.outcome === "won" || end.outcome === "draw") {
    const seat = end.winnerSeat ??
      (end.winner === "draw" ? "draw" : end.winner === p1 ? "p1" : end.winner === p2 ? "p2" : null)
    if (seat === "draw" || (end.outcome === "draw" && seat === null)) return { ...base, outcome: "draw", score: 0.5 }
    if (seat === "p1" || seat === "p2") {
      return { ...base, outcome: "won", winnerSeat: seat, winner: seat === "p1" ? p1 : p2, score: seat === "p1" ? 1 : 0 }
    }
    throw new Error(`a game between ${p1} and ${p2} says it was won but names no winner`)
  }
  const unrated = { ERROR: "error", STEP_CAP: "step_cap", STUCK: "stuck", abandoned: "abandoned" } as const
  const outcome = unrated[end.outcome as keyof typeof unrated]
  if (outcome === undefined) throw new Error(`a game between ${p1} and ${p2} has not ended (${end.outcome})`)
  return { ...base, outcome }
}

// ---------------------------------------------------------------------------------------------------------------------
// The ratings after a round
// ---------------------------------------------------------------------------------------------------------------------

interface Tally {
  games: number
  wins: number
  losses: number
  draws: number
  unrated: number
  forfeits: number
}

const emptyTally = (): Tally => ({ games: 0, wins: 0, losses: 0, draws: 0, unrated: 0, forfeits: 0 })

const PlayedGame = Schema.Struct({
  round: Schema.String,
  p1: Schema.String,
  p2: Schema.String,
  score: Schema.NullOr(Schema.Number),
  faultSeat: Schema.NullOr(Schema.String)
})
type PlayedGame = typeof PlayedGame.Type

/** Each version's tally over `games`. */
const tallies = (games: ReadonlyArray<PlayedGame>) => {
  const out = new Map<string, Tally>()
  for (const g of games) {
    for (const [seat, v] of [["p1", g.p1], ["p2", g.p2]] as const) {
      const t = out.get(v) ?? emptyTally()
      out.set(v, t)
      t.games++
      if (g.faultSeat === seat) t.forfeits++
      const mine = g.score === null ? null : seat === "p1" ? g.score : 1 - g.score
      if (mine === null) t.unrated++
      else if (mine === 0.5) t.draws++
      else if (mine === 1) t.wins++
      else t.losses++
    }
  }
  return out
}

const RoundInfo = Schema.Struct({
  id: Schema.String,
  arena: Schema.String,
  season: Schema.Int,
  number: Schema.Int,
  lineup: Schema.fromJsonString(Schema.Array(Schema.String))
})

const VersionInfo = Schema.Struct({
  id: Schema.String,
  format: Schema.String,
  house: Schema.Number
})

export class Ratings extends Context.Service<Ratings, {
  /**
   * Rates a finished round: its own games (anchored on the house versions in its lineup) and the season up to it
   * (anchored on the bots built into the games image that ever played this season, else the anchors of the season's
   * first round, as referee.js allRoundAnchors). Replaces any ratings the round had.
   */
  readonly rate: (round: string) => Effect.Effect<void>
}>()("arena/Ratings") {
  static readonly layer = Layer.effect(
    Ratings,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const findRound = SqlSchema.findOne({
        Request: Schema.String,
        Result: RoundInfo,
        execute: (id) => sql`SELECT id, arena, season, number, lineup FROM rounds WHERE id = ${id}`
      })
      const seasonRounds = SqlSchema.findAll({
        Request: Schema.Struct({ arena: Schema.String, season: Schema.Int, upTo: Schema.Int }),
        Result: RoundInfo,
        execute: (q) =>
          sql`SELECT id, arena, season, number, lineup FROM rounds
              WHERE arena = ${q.arena} AND season = ${q.season} AND number <= ${q.upTo} ORDER BY number`
      })
      const playedIn = SqlSchema.findAll({
        Request: Schema.Array(Schema.String),
        Result: PlayedGame,
        execute: (rounds) =>
          sql`SELECT g.round, g.p1, g.p2, g.score, g.fault_seat FROM games g JOIN rounds r ON r.id = g.round
              WHERE ${sql.in("g.round", rounds)} ORDER BY r.number, g.seq`
      })
      const versions = SqlSchema.findAll({
        Request: Schema.Array(Schema.String),
        Result: VersionInfo,
        execute: (ids) =>
          sql`SELECT v.id, v.format, c.house FROM versions v JOIN competitors c ON c.name = v.competitor
              WHERE ${sql.in("v.id", ids)}`
      })

      const rows = (round: string, scope: "round" | "season", games: ReadonlyArray<PlayedGame>, names: ReadonlyArray<string>, anchors: ReadonlyArray<string>) => {
        const results = games.filter((g) => g.score !== null).map((g) => ({ a: g.p1, b: g.p2, score: g.score! }))
        if (results.length === 0) return []
        const fitted = fit(names, results, anchors)
        const tally = tallies(games)
        return names.map((version) => ({
          round,
          scope,
          version,
          rating: fitted.get(version)!.rating,
          se: fitted.get(version)!.se,
          anchor: anchors.includes(version) ? 1 : 0,
          ...(tally.get(version) ?? emptyTally())
        }))
      }

      const rate = Effect.fn("Ratings.rate")(function*(id: string) {
        const round = yield* findRound(id)
        const rounds = yield* seasonRounds({ arena: round.arena, season: round.season, upTo: round.number })
        const games = yield* playedIn(rounds.map((r) => r.id))
        const lineups = [...new Set(rounds.flatMap((r) => r.lineup))]
        const info = new Map((yield* versions(lineups)).map((v) => [v.id, v]))
        const house = (lineup: ReadonlyArray<string>) => lineup.filter((v) => info.get(v)?.house === 1)

        // this round alone: its whole lineup, the house versions in it pinned at 1500
        const own = games.filter((g) => g.round === id)
        const roundRows = rows(id, "round", own, round.lineup, house(round.lineup))

        // the season so far: every version with a rated game, in the order they first got one (as globalElo)
        const rated = games.filter((g) => g.score !== null)
        const names = [...new Set(rated.flatMap((g) => [g.p1, g.p2]))]
        const builtin = lineups.filter((v) => info.get(v)?.format === "builtin")
        const anchors = builtin.length ? builtin : house(rounds[0]?.lineup ?? [])
        const seasonRows = rows(id, "season", games, names, anchors)

        yield* sql.withTransaction(Effect.gen(function*() {
          yield* sql`DELETE FROM ratings WHERE round = ${id}`
          const all = [...roundRows, ...seasonRows]
          for (let at = 0; at < all.length; at += 200) {
            yield* sql`INSERT INTO ratings ${sql.insert(all.slice(at, at + 200))}`
          }
        }))
      }, Effect.orDie)

      return Ratings.of({ rate })
    })
  )
}
