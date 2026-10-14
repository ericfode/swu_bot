/**
 * The handlers behind Api.ts. Each one is a few lines: the schemas already checked the input, and the services do the
 * work.
 */
import { gunzipSync } from "node:zlib"
import { Config, Effect, Layer, Option, Redacted, Stream } from "effect"
import { HttpServerResponse } from "effect/http"
import { HttpApiBuilder, HttpApiMiddleware } from "effect/http-api"
import { ArenaApi, Authorization, CurrentCaller, InputErrors } from "./Api.ts"
import type { Caller } from "./Api.ts"
import { BadInput, Forbidden, Unauthorized } from "./Domain.ts"
import { Games } from "./Games.ts"
import { ArenaRecord, roundOf } from "./Record.ts"
import { Rounds } from "./Rounds.ts"
import { Settings } from "./Settings.ts"
import { Traces } from "./Traces.ts"

/** Matches a bearer token to a caller: ARENA_ADMIN_TOKEN is Eric, ARENA_READ_TOKEN a reader (Holocron, say). */
export const tokenCaller = Effect.gen(function*() {
  const admin = yield* Config.Redacted("ARENA_ADMIN_TOKEN").pipe(Config.option)
  const reader = yield* Config.Redacted("ARENA_READ_TOKEN").pipe(Config.option)
  return (token: string): Caller | null => {
    if (Option.isSome(admin) && token === Redacted.value(admin.value)) return { login: "admin token", role: "admin" }
    if (Option.isSome(reader) && token === Redacted.value(reader.value)) return { login: "read token", role: "reader" }
    return null
  }
})

export const AuthorizationLive = Layer.effect(
  Authorization,
  Effect.gen(function*() {
    const callerOf = yield* tokenCaller
    return Authorization.of({
      bearer: Effect.fn(function*(httpEffect, { credential }) {
        const caller = callerOf(Redacted.value(credential))
        if (caller === null) return yield* new Unauthorized({ message: "missing or unknown bearer token" })
        return yield* Effect.provideService(httpEffect, CurrentCaller, caller)
      })
    })
  })
)

export const InputErrorsLive = HttpApiMiddleware.layerSchemaErrorTransform(
  InputErrors,
  (error) => Effect.fail(new BadInput({ part: error.kind, message: error.cause.message }))
)

const adminOnly = Effect.gen(function*() {
  const caller = yield* CurrentCaller
  if (caller.role !== "admin") return yield* new Forbidden({ message: "only an admin does this" })
  return caller
})

const SettingsHandlers = HttpApiBuilder.group(ArenaApi, "settings", Effect.fn(function*(handlers) {
  const settings = yield* Settings
  return handlers.handleAll({
    get: () => Effect.andThen(adminOnly, settings.get),
    update: ({ payload }) => Effect.flatMap(adminOnly, (caller) => settings.update(payload, caller.login))
  })
}))

const ArenasHandlers = HttpApiBuilder.group(ArenaApi, "arenas", Effect.fn(function*(handlers) {
  const record = yield* ArenaRecord
  return handlers.handleAll({
    list: () => record.arenas,
    get: ({ params }) => record.arena(params.id),
    standings: ({ params, query }) => record.standings(params.id, query.season)
  })
}))

const CompetitorsHandlers = HttpApiBuilder.group(ArenaApi, "competitors", Effect.fn(function*(handlers) {
  const record = yield* ArenaRecord
  return handlers.handleAll({ list: () => record.competitors })
}))

const VersionsHandlers = HttpApiBuilder.group(ArenaApi, "versions", Effect.fn(function*(handlers) {
  const record = yield* ArenaRecord
  return handlers.handleAll({
    list: ({ query }) => record.versions(query.competitor),
    get: ({ params }) => record.version(params.id),
    stats: ({ params, query }) => record.versionStats(params.id, query.arena, query.season)
  })
}))

const RoundsHandlers = HttpApiBuilder.group(ArenaApi, "rounds", Effect.fn(function*(handlers) {
  const rounds = yield* Rounds
  const record = yield* ArenaRecord
  return handlers.handleAll({
    list: ({ query }) => Effect.map(record.rounds(query.arena, query.season), (rows) => rows.map((r) => roundOf(r))),
    start: ({ payload }) => Effect.andThen(adminOnly, rounds.start(payload)),
    status: ({ params }) => rounds.status(params.id)
  })
}))

/** A replay goes out as stored (gzipped) to a client that accepts gzip, else as plain text. */
const replayResponse = (gz: Uint8Array, acceptEncoding: string | undefined) =>
  /\bgzip\b/.test(acceptEncoding ?? "")
    ? HttpServerResponse.uint8Array(gz, { contentType: "application/x-ndjson", headers: { "content-encoding": "gzip" } })
    : HttpServerResponse.uint8Array(gunzipSync(gz), { contentType: "application/x-ndjson" })

const GamesHandlers = HttpApiBuilder.group(ArenaApi, "games", Effect.fn(function*(handlers) {
  const games = yield* Games
  return handlers.handleAll({
    list: ({ query }) => games.list(query),
    get: ({ params }) => games.get(params.id),
    replay: ({ params, request }) =>
      Effect.map(games.replay(params.id), (gz) => replayResponse(gz, request.headers["accept-encoding"]))
  })
}))

const ExportHandlers = HttpApiBuilder.group(ArenaApi, "export", Effect.fn(function*(handlers) {
  const games = yield* Games
  return handlers.handleAll({
    games: ({ query }) => Effect.succeed(Stream.encodeText(games.exportLines(query)))
  })
}))

const TracesHandlers = HttpApiBuilder.group(ArenaApi, "traces", Effect.fn(function*(handlers) {
  const traces = yield* Traces
  return handlers.handleAll({ list: ({ query }) => traces.list(query) })
}))

const SystemHandlers = HttpApiBuilder.group(ArenaApi, "system", (handlers) =>
  Effect.succeed(handlers.handleAll({ health: () => Effect.void })))

/** Every group's handlers; they need the services and the Authorization middleware. */
export const ApiHandlers = Layer.mergeAll(
  SettingsHandlers,
  ArenasHandlers,
  CompetitorsHandlers,
  VersionsHandlers,
  RoundsHandlers,
  GamesHandlers,
  ExportHandlers,
  TracesHandlers,
  SystemHandlers
).pipe(
  Layer.provide([AuthorizationLive, InputErrorsLive])
)
