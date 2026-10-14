/**
 * The arena's records, written once. These schemas check HTTP requests and responses, describe the OpenAPI document
 * and the MCP tools, and decode the rows read back from SQLite, so a field means the same thing everywhere.
 */
import { Schema } from "effect"

// ---------------------------------------------------------------------------------------------------------------------
// Settings: Eric's arena knobs (bot/arena/window.js SETTINGS). A setting left out uses the games machine's default.
// ---------------------------------------------------------------------------------------------------------------------

export const GamesPerPair = Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 10 }), Schema.isMultipleOf(2))
  .annotate({ description: "Games each pair plays in a round, half in each seat: an even number from 2 to 10" })
export const ThinkCapSec = Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 600 }))
  .annotate({ description: "Thinking time per bot per game, in seconds (10 to 600); past it, that bot loses the game" })
export const Workers = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 }))
  .annotate({ description: "Games the games machine plays at once (1 to 16)" })
export const RoundGapMin = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 240 }))
  .annotate({ description: "Minutes from one round's end to the next round's start (0 to 240)" })

export const ArenaSettings = Schema.Struct({
  gamesPerPair: Schema.optionalKey(GamesPerPair),
  thinkCapSec: Schema.optionalKey(ThinkCapSec),
  workers: Schema.optionalKey(Workers),
  roundGapMin: Schema.optionalKey(RoundGapMin)
}).annotate({ identifier: "ArenaSettings" })
export type ArenaSettings = typeof ArenaSettings.Type

/** What the games machine uses for a setting nobody set. */
export const DEFAULT_SETTINGS = { gamesPerPair: 4, thinkCapSec: 60, workers: 2, roundGapMin: 0 } as const

export const SettingsDoc = Schema.Struct({
  settings: ArenaSettings,
  updatedAt: Schema.NullOr(Schema.String),
  by: Schema.NullOr(Schema.String)
}).annotate({ identifier: "SettingsDoc" })
export type SettingsDoc = typeof SettingsDoc.Type

/** A change to some settings; null puts one back to the default. */
export const SettingsPatch = Schema.Struct({
  set: Schema.Struct({
    gamesPerPair: Schema.optionalKey(Schema.NullOr(GamesPerPair)),
    thinkCapSec: Schema.optionalKey(Schema.NullOr(ThinkCapSec)),
    workers: Schema.optionalKey(Schema.NullOr(Workers)),
    roundGapMin: Schema.optionalKey(Schema.NullOr(RoundGapMin))
  }).check(Schema.isMinProperties(1))
}).annotate({ identifier: "SettingsPatch" })
export type SettingsPatch = typeof SettingsPatch.Type

// ---------------------------------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------------------------------

export const ArenaId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/))
  .annotate({ description: "An arena's id, such as open" })
export const CompetitorName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,31}$/))
  .annotate({ description: "A competitor's name, such as ericfode_opus" })
export const VersionId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_.#-]{0,63}$/))
  .annotate({ description: "A version's id: <competitor>-v<N>, such as ericfode_opus-v7, or a built-in bot's old name" })
export const RoundId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/))
  .annotate({ description: "A round's id, such as arena-r15" })
export const GameId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._#@+-]{0,159}$/))
  .annotate({ description: "A game's id" })
export const Seed = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const Seat = Schema.Literals(["p1", "p2"])
export type Seat = typeof Seat.Type
export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const Season = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({ description: "A season number" })

/** Query parameters (HttpApi reads them from text, so "12" checks as 12; MCP tools take them as numbers). */
export const SeasonParam = Season.annotate({ description: "A season number (default: the arena's current season)" })
export const SeqParam = Count
export const LimitParam = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))
  .annotate({ description: "At most this many games, 1 to 500 (default 100)" })

// ---------------------------------------------------------------------------------------------------------------------
// Arenas and seasons
// ---------------------------------------------------------------------------------------------------------------------

/** An arena's rules as today's referee plays them. The Arena rules stage adds decks, opponents' lists and the rest. */
export const ArenaRules = Schema.Struct({
  gamesPerPair: Count.annotate({ description: "Games each pair plays in a round, half in each seat" }),
  capMs: Count.annotate({ description: "Thinking time per bot per game, ms; past it, that bot loses the game" }),
  hangMs: Count.annotate({ description: "Longest a bot may take on one decision before it loses the game, ms" }),
  maxSteps: Count.annotate({ description: "Decisions after which a game stops unrated" })
}).annotate({ identifier: "ArenaRules" })
export type ArenaRules = typeof ArenaRules.Type

export class SeasonInfo extends Schema.Class<SeasonInfo>("Season")({
  arena: ArenaId,
  number: Season,
  rules: ArenaRules.annotate({ description: "The rules frozen when the season started" }),
  startedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String)
}) {}

export class Arena extends Schema.Class<Arena>("Arena")({
  id: ArenaId,
  title: Schema.String,
  season: Season.annotate({ description: "The season being played" }),
  rules: ArenaRules,
  seasons: Schema.Array(SeasonInfo)
}) {}

// ---------------------------------------------------------------------------------------------------------------------
// Competitors and versions
// ---------------------------------------------------------------------------------------------------------------------

export class Competitor extends Schema.Class<Competitor>("Competitor")({
  name: CompetitorName,
  title: Schema.String,
  owner: Schema.NullOr(Schema.String).annotate({ description: "The builder's GitHub login; null for the arena's own" }),
  house: Schema.Boolean.annotate({ description: "One of the arena's own bots (a resident), which anchor the ratings" }),
  about: Schema.NullOr(Schema.String),
  registeredAt: Schema.String,
  benchedAt: Schema.NullOr(Schema.String)
}) {}

export const VersionFormat = Schema.Literals(["wasm", "js", "builtin"])
  .annotate({ description: "wasm: a submitted bundle; js: a builder's starter, never played; builtin: a bot built into the games image (rounds 0 to 14)" })

export class Version extends Schema.Class<Version>("Version")({
  id: VersionId,
  competitor: CompetitorName,
  number: Count,
  kind: Schema.Literals(["bot", "evaluator"]),
  format: VersionFormat,
  sha256: Schema.NullOr(Schema.String).annotate({ description: "The bundle's sha256 (its canonical tar); null for versions imported from the old arena" }),
  note: Schema.NullOr(Schema.String),
  files: Schema.Array(Schema.String),
  submission: Schema.NullOr(Schema.String).annotate({ description: "The submission it came from" }),
  submittedAt: Schema.NullOr(Schema.String),
  withdrawn: Schema.Boolean
}) {}

export const VersionsQuery = Schema.Struct({
  competitor: Schema.optionalKey(CompetitorName)
}).annotate({ identifier: "VersionsQuery" })

// ---------------------------------------------------------------------------------------------------------------------
// Rounds and games
// ---------------------------------------------------------------------------------------------------------------------

export const RoundState = Schema.Literals(["running", "done", "failed"])

export class Round extends Schema.Class<Round>("Round")({
  id: RoundId,
  arena: ArenaId,
  season: Season,
  number: Count,
  lineup: Schema.Array(VersionId),
  firstSeed: Seed,
  gamesPerPair: Count,
  capMs: Count,
  keyId: Schema.NullOr(Schema.String).annotate({ description: "Names the round's run key before it is published" }),
  runKey: Schema.NullOr(Schema.String).annotate({ description: "Every game's deal comes from it; published when the round is done" }),
  state: RoundState,
  gamesPlanned: Count,
  gamesPlayed: Count,
  rated: Count,
  startedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String)
}) {}

export const RoundsQuery = Schema.Struct({
  arena: Schema.optionalKey(ArenaId),
  season: Schema.optionalKey(SeasonParam)
}).annotate({ identifier: "RoundsQuery" })

/** A round to play: every pair of `bots` (version ids), in both seats, on seeds firstSeed, firstSeed + 1, ... */
export const RoundRequest = Schema.Struct({
  id: RoundId,
  arena: Schema.optionalKey(ArenaId.annotate({ description: "Default open" })),
  bots: Schema.Array(VersionId).check(Schema.isMinLength(2), Schema.isMaxLength(16), Schema.isUnique()),
  firstSeed: Seed
}).annotate({ identifier: "RoundRequest" })
export type RoundRequest = typeof RoundRequest.Type

export const Outcome = Schema.Literals(["won", "draw", "forfeit", "error", "step_cap", "stuck", "abandoned"])
  .annotate({
    description:
      "won or draw: played out. forfeit: a bot failed (see faultSeat) and lost. error: the referee failed, step_cap: too many decisions, stuck: nobody could move, abandoned: never finished; none of those is rated"
  })
export type Outcome = typeof Outcome.Type

/** One seat's time in a game. */
export const SeatTime = Schema.Struct({
  thinkMs: Schema.NullOr(Schema.Number).annotate({ description: "Thinking time the cap applies to, ms" }),
  decisions: Schema.NullOr(Count),
  decideMs: Schema.NullOr(Schema.Number).annotate({ description: "Sum of the referee's timing of each decision, ms" }),
  p95Ms: Schema.NullOr(Schema.Number),
  maxMs: Schema.NullOr(Schema.Number)
}).annotate({ identifier: "SeatTime" })
export type SeatTime = typeof SeatTime.Type

/** One finished game, as the export API, the MCP tools and the games table all see it. */
export class Game extends Schema.Class<Game>("Game")({
  seq: Count.annotate({ description: "The order the record took games in; the export's cursor" }),
  id: GameId,
  arena: ArenaId,
  season: Season,
  round: RoundId,
  seed: Seed,
  dealKey: Schema.NullOr(Schema.String).annotate({ description: "The game key both seats' games of a seed are dealt from" }),
  p1: VersionId,
  p2: VersionId,
  outcome: Outcome,
  winner: Schema.NullOr(VersionId),
  winnerSeat: Schema.NullOr(Seat),
  score: Schema.NullOr(Schema.Number).annotate({ description: "p1's score: 1 a win, 0.5 a draw, 0 a loss; null when unrated" }),
  faultSeat: Schema.NullOr(Seat).annotate({ description: "The seat whose bot failed (a forfeit)" }),
  faultKind: Schema.NullOr(Schema.String).annotate({ description: "load, error, time or hang" }),
  error: Schema.NullOr(Schema.String),
  gameRounds: Count.annotate({ description: "Game rounds played" }),
  steps: Count,
  ms: Count.annotate({ description: "Wall time, ms" }),
  time: Schema.Struct({ p1: SeatTime, p2: SeatTime }),
  host: Schema.NullOr(Schema.String).annotate({ description: "Where it was played: null for the games machine, else a helper" }),
  replay: Schema.Boolean.annotate({ description: "Whether GET /api/v1/games/{id}/replay has its replay" }),
  recordedAt: Schema.String
}) {}

/** Which games to read: newest first, at most `limit` (default 100), before seq `before` (the previous page's next). */
export const GamesQuery = Schema.Struct({
  arena: Schema.optionalKey(ArenaId),
  season: Schema.optionalKey(SeasonParam),
  round: Schema.optionalKey(RoundId),
  version: Schema.optionalKey(VersionId.annotate({ description: "Only games this version played, in either seat" })),
  since: Schema.optionalKey(Schema.String.annotate({ description: "Only games recorded at or after this ISO time" })),
  before: Schema.optionalKey(SeqParam.annotate({ description: "Only games with a smaller seq: the previous page's next" })),
  limit: Schema.optionalKey(LimitParam)
}).annotate({ identifier: "GamesQuery" })
export type GamesQuery = typeof GamesQuery.Type

export class GamesPage extends Schema.Class<GamesPage>("GamesPage")({
  games: Schema.Array(Game),
  next: Schema.NullOr(Count).annotate({ description: "Pass as before= for the next page; null on the last page" })
}) {}

/** The bulk export: every matching game, oldest first, after seq `after`. */
export const ExportQuery = Schema.Struct({
  arena: Schema.optionalKey(ArenaId),
  season: Schema.optionalKey(SeasonParam),
  after: Schema.optionalKey(SeqParam.annotate({ description: "Only games with a larger seq: the last seq you have" })),
  since: Schema.optionalKey(Schema.String.annotate({ description: "Only games recorded at or after this ISO time" }))
}).annotate({ identifier: "ExportQuery" })
export type ExportQuery = typeof ExportQuery.Type

// ---------------------------------------------------------------------------------------------------------------------
// Trace checks: games played again from their replays (Traces.ts)
// ---------------------------------------------------------------------------------------------------------------------

export class TraceCheck extends Schema.Class<TraceCheck>("TraceCheck")({
  game: GameId,
  round: RoundId,
  ok: Schema.Boolean.annotate({ description: "Every recorded move was legal again and every board came out the same" }),
  steps: Count.annotate({ description: "Steps played again before the end or the first difference" }),
  diff: Schema.NullOr(Schema.String).annotate({ description: "The first step that came out differently, and how" }),
  note: Schema.NullOr(Schema.String).annotate({ description: "How a game that ended in an engine error was checked" }),
  build: Schema.NullOr(Schema.String).annotate({ description: "The arena build that played it again" }),
  checkedAt: Schema.String
}) {}

export const TracesQuery = Schema.Struct({
  differs: Schema.optionalKey(Schema.Boolean.annotate({ description: "Only games that came out differently" })),
  limit: Schema.optionalKey(LimitParam)
}).annotate({ identifier: "TracesQuery" })
export type TracesQuery = typeof TracesQuery.Type

export class TracesPage extends Schema.Class<TracesPage>("TracesPage")({
  checked: Count.annotate({ description: "Games played again so far" }),
  differ: Count.annotate({ description: "Of those, games that came out differently" }),
  unchecked: Count.annotate({ description: "Games with a replay not played again yet" }),
  checks: Schema.Array(TraceCheck).annotate({ description: "Newest games first" })
}) {}

// ---------------------------------------------------------------------------------------------------------------------
// Standings and stats
// ---------------------------------------------------------------------------------------------------------------------

export const Tally = Schema.Struct({
  games: Count,
  wins: Count,
  losses: Count,
  draws: Count,
  unrated: Count.annotate({ description: "Games that ended without a rated result" }),
  forfeits: Count.annotate({ description: "Games this version lost by failing" })
}).annotate({ identifier: "Tally" })
export type Tally = typeof Tally.Type

export class Rating extends Schema.Class<Rating>("Rating")({
  version: VersionId,
  competitor: CompetitorName,
  rating: Schema.Int.annotate({ description: "Bradley-Terry on the Elo scale; the anchors' mean is 1500" }),
  se: Schema.Int.annotate({ description: "Standard error of the rating" }),
  anchor: Schema.Boolean,
  record: Tally
}) {}

export class RoundStanding extends Schema.Class<RoundStanding>("RoundStanding")({
  round: RoundId,
  number: Count,
  endedAt: Schema.NullOr(Schema.String),
  thisRound: Schema.Array(Rating).annotate({ description: "Rated on this round's games alone, best first" }),
  season: Schema.Array(Rating).annotate({ description: "Rated on every game of the season up to this round, best first" })
}) {}

export class Standings extends Schema.Class<Standings>("Standings")({
  arena: ArenaId,
  season: Season,
  rounds: Schema.Array(RoundStanding).annotate({ description: "Oldest first" })
}) {}

export const StandingsQuery = Schema.Struct({
  season: Schema.optionalKey(SeasonParam)
}).annotate({ identifier: "StandingsQuery" })

export const StatsQuery = Schema.Struct({
  arena: Schema.optionalKey(ArenaId.annotate({ description: "Default open" })),
  season: Schema.optionalKey(SeasonParam)
}).annotate({ identifier: "StatsQuery" })

export const Spot = Schema.Literals([
  "base_behind",
  "board_behind",
  "low_base",
  "cards_behind",
  "close_mid",
  "long_game",
  "base_ahead",
  "board_ahead",
  "kill_range"
])

export class VersionStats extends Schema.Class<VersionStats>("VersionStats")({
  version: VersionId,
  arena: ArenaId,
  season: Season,
  record: Tally,
  rating: Schema.NullOr(Rating).annotate({ description: "The season rating after the last round it played" }),
  headToHead: Schema.Array(Schema.Struct({ opponent: VersionId, record: Tally })),
  time: Schema.Struct({
    games: Count,
    decisions: Count,
    decideMs: Schema.Number,
    msPerDecision: Schema.NullOr(Schema.Number),
    p95Ms: Schema.NullOr(Schema.Number).annotate({ description: "The highest per-game p95 decision time" }),
    thinkMs: Schema.Number.annotate({ description: "Thinking time the cap applies to, summed over games" }),
    maxGameThinkMs: Schema.NullOr(Schema.Number).annotate({ description: "The most thinking time it used in one game" })
  }),
  spots: Schema.Array(Schema.Struct({
    spot: Spot,
    edge: Schema.Number,
    n: Count,
    se: Schema.NullOr(Schema.Number)
  })).annotate({ description: "The Atlas's game situations, once the Atlas reads arena games (empty until then)" })
}) {}

// ---------------------------------------------------------------------------------------------------------------------
// Errors (each carries its HTTP status)
// ---------------------------------------------------------------------------------------------------------------------

/** A request that does not fit its schema: which part, and why. */
export class BadInput extends Schema.TaggedError<BadInput>()("BadInput", {
  part: Schema.String,
  message: Schema.String
}, { httpApiStatus: 400 }) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
  message: Schema.String
}, { httpApiStatus: 401 }) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
  message: Schema.String
}, { httpApiStatus: 403 }) {}

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  what: Schema.String,
  id: Schema.String
}, { httpApiStatus: 404 }) {}

export class RoundExists extends Schema.TaggedError<RoundExists>()("RoundExists", {
  id: RoundId
}, { httpApiStatus: 409 }) {}

/** The game player could not play a seed (it crashed, refused the job, or printed something that is not a result). */
export class PlayerFailed extends Schema.TaggedError<PlayerFailed>()("PlayerFailed", {
  seed: Seed,
  message: Schema.String
}) {}

/** bot/trace.js could not check a batch of replays (it crashed, or printed something that is not a verdict). */
export class TracesFailed extends Schema.TaggedError<TracesFailed>()("TracesFailed", {
  message: Schema.String
}) {}
