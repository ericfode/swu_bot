/**
 * The MCP server at /mcp: the export API's reads as tools, with the same schemas, so an agent and an HTTP client get
 * the same records and the same refusals. Calls need a bearer token, like the API.
 */
import { gunzipSync } from "node:zlib"
import { Effect, Layer, Schema } from "effect"
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import {
  Arena,
  ArenaId,
  Competitor,
  Count,
  Game,
  GameId,
  GamesPage,
  GamesQuery,
  NotFound,
  Round,
  RoundId,
  RoundsQuery,
  SeasonParam,
  Standings,
  TracesPage,
  TracesQuery,
  Version,
  VersionId,
  VersionsQuery,
  VersionStats
} from "./Domain.ts"
import { Games } from "./Games.ts"
import { tokenCaller } from "./Http.ts"
import { ArenaRecord, roundOf } from "./Record.ts"
import { Rounds } from "./Rounds.ts"
import { Traces } from "./Traces.ts"

/** Marks a tool as a read: nothing changes, the same call gives the same answer, and it stays inside the arena. */
const read = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false) as T

export const ArenaArenas = read(Tool.make("arena_arenas", {
  description: "The arenas, their rules and their seasons.",
  success: Schema.Array(Arena)
}))

export const ArenaStandings = read(Tool.make("arena_standings", {
  description:
    "An arena's ratings and records after each round of a season (default: the current one): on that round alone and on the season so far, best first.",
  parameters: Schema.Struct({ arena: ArenaId, season: Schema.optionalKey(SeasonParam) }),
  success: Standings,
  failure: NotFound
}))

export const ArenaCompetitors = read(Tool.make("arena_competitors", {
  description: "Every competitor: builders' entries and the arena's own bots.",
  success: Schema.Array(Competitor)
}))

export const ArenaVersions = read(Tool.make("arena_versions", {
  description: "Every version, or one competitor's.",
  parameters: VersionsQuery,
  success: Schema.Array(Version)
}))

export const ArenaVersionStats = read(Tool.make("arena_version_stats", {
  description: "A version's record, head-to-heads, time used and Atlas spots in an arena's season (default: open, the current season).",
  parameters: Schema.Struct({
    version: VersionId,
    arena: Schema.optionalKey(ArenaId),
    season: Schema.optionalKey(SeasonParam)
  }),
  success: VersionStats,
  failure: NotFound
}))

export const ArenaRounds = read(Tool.make("arena_rounds", {
  description: "The rounds played, oldest first; filter by arena and season.",
  parameters: RoundsQuery,
  success: Schema.Array(Round)
}))

export const ArenaRound = read(Tool.make("arena_round", {
  description: "One round: its lineup, rules, state (running, done, failed) and games played so far.",
  parameters: Schema.Struct({ id: RoundId }),
  success: Round,
  failure: NotFound
}))

export const ArenaGames = read(Tool.make("arena_games", {
  description:
    "Finished games, newest first, a page at a time (default 100, at most 500). Filter by arena, season, round, version or time; pass the page's next as before for the next page.",
  parameters: GamesQuery,
  success: GamesPage
}))

export const ArenaGame = read(Tool.make("arena_game", {
  description: "One game.",
  parameters: Schema.Struct({ id: GameId }),
  success: Game,
  failure: NotFound
}))

export const ArenaReplay = read(Tool.make("arena_replay", {
  description:
    "Lines of a game's replay (its trace): line 0 is the header, then one line per decision with the board after it, and an end line. Returns `limit` lines from line `from` (default 0 and 50, at most 500) and how many there are.",
  parameters: Schema.Struct({
    id: GameId,
    from: Schema.optionalKey(Count),
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })))
  }),
  success: Schema.Struct({ lines: Count, from: Count, steps: Schema.Array(Schema.Unknown) }),
  failure: NotFound
}))

export const ArenaTraces = read(Tool.make("arena_traces", {
  description:
    "Trace checks: each night the arena plays its newest games again from their replays. Gives how many were checked and how many came out differently, then the verdicts, newest games first (default 100, at most 500); differs: true gives only the games that came out differently.",
  parameters: TracesQuery,
  success: TracesPage
}))

export const ArenaToolkit = Toolkit.make(
  ArenaArenas,
  ArenaStandings,
  ArenaCompetitors,
  ArenaVersions,
  ArenaVersionStats,
  ArenaRounds,
  ArenaRound,
  ArenaGames,
  ArenaGame,
  ArenaReplay,
  ArenaTraces
)

export const ArenaToolkitLive = ArenaToolkit.toLayer(Effect.gen(function*() {
  const games = yield* Games
  const rounds = yield* Rounds
  const record = yield* ArenaRecord
  const traces = yield* Traces
  return ArenaToolkit.of({
    arena_arenas: () => record.arenas,
    arena_standings: ({ arena, season }) => record.standings(arena, season),
    arena_competitors: () => record.competitors,
    arena_versions: (query) => record.versions(query.competitor),
    arena_version_stats: ({ version, arena, season }) => record.versionStats(version, arena, season),
    arena_rounds: (query) => Effect.map(record.rounds(query.arena, query.season), (rows) => rows.map((r) => roundOf(r))),
    arena_round: ({ id }) => rounds.status(id),
    arena_games: (query) => games.list(query),
    arena_game: ({ id }) => games.get(id),
    arena_replay: ({ id, from = 0, limit = 50 }) =>
      Effect.map(games.replay(id), (gz) => {
        const lines = new TextDecoder().decode(gunzipSync(gz)).split("\n").filter((l) => l.length > 0)
        return { lines: lines.length, from, steps: lines.slice(from, from + limit).map((l) => JSON.parse(l) as unknown) }
      }),
    arena_traces: (query) => traces.list(query)
  })
}))

/** 401 for a request to /mcp without a known bearer token. */
const McpAuth = HttpRouter.middleware(Effect.gen(function*() {
  const callerOf = yield* tokenCaller
  return (httpEffect) =>
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const header = request.headers["authorization"] ?? ""
      const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : ""
      if (callerOf(token) === null) {
        return HttpServerResponse.text("missing or unknown bearer token", { status: 401 })
      }
      return yield* httpEffect
    })
}))

export const McpLive = Layer.mergeAll(McpServer.toolkit(ArenaToolkit)).pipe(
  Layer.provide(ArenaToolkitLive),
  Layer.provideMerge(McpServer.layerHttp({
    name: "swu-arena",
    version: "1.0.0",
    path: "/mcp",
    protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18]
  })),
  Layer.provide(McpAuth.layer)
)
