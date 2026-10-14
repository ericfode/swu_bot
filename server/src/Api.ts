/**
 * The arena's HTTP API (export API v1), defined apart from its handlers so a typed client (Holocron, the app, tests)
 * can import it without the server. The OpenAPI document and the docs page are generated from it.
 */
import { Context, Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, HttpApiSecurity, OpenApi } from "effect/http-api"
import {
  Arena,
  ArenaId,
  BadInput,
  Competitor,
  ExportQuery,
  Forbidden,
  Game,
  GameId,
  GamesPage,
  GamesQuery,
  NotFound,
  Round,
  RoundExists,
  RoundId,
  RoundRequest,
  RoundsQuery,
  SettingsDoc,
  SettingsPatch,
  Standings,
  StandingsQuery,
  StatsQuery,
  TracesPage,
  TracesQuery,
  Unauthorized,
  Version,
  VersionId,
  VersionsQuery,
  VersionStats
} from "./Domain.ts"

export interface Caller {
  readonly login: string
  readonly role: "admin" | "reader"
}

export class CurrentCaller extends Context.Service<CurrentCaller, Caller>()("arena/CurrentCaller") {}

/** A bearer token names the caller. Two tokens from the environment for now; sign-in (stage 6) replaces them. */
export class Authorization extends HttpApiMiddleware.Service<Authorization, {
  provides: CurrentCaller
  requires: never
}>()("arena/Authorization", {
  requiredForClient: true,
  security: { bearer: HttpApiSecurity.bearer },
  error: Unauthorized
}) {}

/** Turns a request that fails its schema into a 400 that says why (Effect's default is an empty 400). */
export class InputErrors extends HttpApiMiddleware.Service<InputErrors>()("arena/InputErrors", {
  error: BadInput
}) {}

/** JSON lines; a replay is sent gzipped (Content-Encoding) to clients that accept it. */
export const JsonLines = HttpApiSchema.StreamUint8Array({ contentType: "application/x-ndjson" })

export class SettingsApi extends HttpApiGroup.make("settings")
  .add(
    HttpApiEndpoint.get("get", "/", { success: SettingsDoc, error: Forbidden }),
    HttpApiEndpoint.post("update", "/", { payload: SettingsPatch, success: SettingsDoc, error: Forbidden })
  )
  .middleware(Authorization)
  .prefix("/api/v1/settings")
  .annotateMerge(OpenApi.annotations({ title: "Settings", description: "Eric's machine settings (admin only)" }))
{}

export class ArenasApi extends HttpApiGroup.make("arenas")
  .add(
    HttpApiEndpoint.get("list", "/", { success: Schema.Array(Arena) }),
    HttpApiEndpoint.get("get", "/:id", { params: { id: ArenaId }, success: Arena, error: NotFound }),
    HttpApiEndpoint.get("standings", "/:id/standings", {
      params: { id: ArenaId },
      query: StandingsQuery,
      success: Standings,
      error: NotFound
    })
  )
  .middleware(Authorization)
  .prefix("/api/v1/arenas")
  .annotateMerge(OpenApi.annotations({
    title: "Arenas",
    description: "Arenas, their rules and seasons, and the ratings and records after each round"
  }))
{}

export class CompetitorsApi extends HttpApiGroup.make("competitors")
  .add(HttpApiEndpoint.get("list", "/", { success: Schema.Array(Competitor) }))
  .middleware(Authorization)
  .prefix("/api/v1/competitors")
  .annotateMerge(OpenApi.annotations({ title: "Competitors", description: "Builders' entries and the arena's own" }))
{}

export class VersionsApi extends HttpApiGroup.make("versions")
  .add(
    HttpApiEndpoint.get("list", "/", { query: VersionsQuery, success: Schema.Array(Version) }),
    HttpApiEndpoint.get("get", "/:id", { params: { id: VersionId }, success: Version, error: NotFound }),
    HttpApiEndpoint.get("stats", "/:id/stats", {
      params: { id: VersionId },
      query: StatsQuery,
      success: VersionStats,
      error: NotFound
    })
  )
  .middleware(Authorization)
  .prefix("/api/v1/versions")
  .annotateMerge(OpenApi.annotations({
    title: "Versions",
    description: "Every version of every competitor; a version's record, head-to-heads, time used and spots"
  }))
{}

export class RoundsApi extends HttpApiGroup.make("rounds")
  .add(
    HttpApiEndpoint.get("list", "/", { query: RoundsQuery, success: Schema.Array(Round) }),
    HttpApiEndpoint.post("start", "/", { payload: RoundRequest, success: Round, error: [Forbidden, RoundExists, NotFound] }),
    HttpApiEndpoint.get("status", "/:id", { params: { id: RoundId }, success: Round, error: NotFound })
  )
  .middleware(Authorization)
  .prefix("/api/v1/rounds")
  .annotateMerge(OpenApi.annotations({ title: "Rounds", description: "The rounds played, and starting one (admin)" }))
{}

export class GamesApi extends HttpApiGroup.make("games")
  .add(
    HttpApiEndpoint.get("list", "/", { query: GamesQuery, success: GamesPage }),
    HttpApiEndpoint.get("get", "/:id", { params: { id: GameId }, success: Game, error: NotFound }),
    HttpApiEndpoint.get("replay", "/:id/replay", { params: { id: GameId }, success: JsonLines, error: NotFound })
      .annotateMerge(OpenApi.annotations({
        description: "The game's replay, its trace: a header line, a line per decision with the board after it, an end line"
      }))
  )
  .middleware(Authorization)
  .prefix("/api/v1/games")
  .annotateMerge(OpenApi.annotations({ title: "Games", description: "Finished games, newest first, a page at a time" }))
{}

export class ExportApi extends HttpApiGroup.make("export")
  .add(
    HttpApiEndpoint.get("games", "/games.jsonl", { query: ExportQuery, success: JsonLines })
      .annotateMerge(OpenApi.annotations({
        description: "Every matching game, oldest first, one JSON line each. Pass after=<the last seq you have> to resume."
      }))
  )
  .middleware(Authorization)
  .prefix("/api/v1/export")
  .annotateMerge(OpenApi.annotations({ title: "Export", description: "Bulk export for the lab's own analysis" }))
{}

export class TracesApi extends HttpApiGroup.make("traces")
  .add(HttpApiEndpoint.get("list", "/", { query: TracesQuery, success: TracesPage }))
  .middleware(Authorization)
  .prefix("/api/v1/traces")
  .annotateMerge(OpenApi.annotations({
    title: "Trace checks",
    description: "Games played again from their replays every night: did every move and board come out the same"
  }))
{}

export class SystemApi extends HttpApiGroup.make("system", { topLevel: true })
  .add(HttpApiEndpoint.get("health", "/api/v1/health", { success: HttpApiSchema.NoContent }))
{}

export class ArenaApi extends HttpApi.make("arena")
  .add(SettingsApi)
  .add(ArenasApi)
  .add(CompetitorsApi)
  .add(VersionsApi)
  .add(RoundsApi)
  .add(GamesApi)
  .add(ExportApi)
  .add(TracesApi)
  .add(SystemApi)
  .middleware(InputErrors)
  // unknown fields are refused, every problem is reported; headers keep the default (they carry transport headers)
  .annotate(HttpApi.ParseOptions, { onExcessProperty: "error", errors: "all" })
  .annotate(HttpApi.HeadersParseOptions, {})
  .annotateMerge(OpenApi.annotations({ title: "SWU Arena", version: "1.0.0" }))
{}
