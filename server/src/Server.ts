/**
 * Puts the arena together: SQLite underneath, the services, the durable round workflow, the nightly trace checks, and
 * the routes (API, OpenAPI, docs page, MCP). The database, the game player and the trace checker are parameters, so
 * tests run the same stack on a temp file with fakes.
 */
import { NodeCrypto } from "@effect/platform-node"
import { Layer } from "effect"
import { ClusterWorkflowEngine, SingleRunner } from "effect/cluster"
import { HttpApiBuilder, HttpApiScalar } from "effect/http-api"
import type { SqlClient } from "effect/sql"
import { ArenaApi } from "./Api.ts"
import { Games } from "./Games.ts"
import { ApiHandlers } from "./Http.ts"
import { McpLive } from "./Mcp.ts"
import type { GamePlayer } from "./Player.ts"
import { Ratings } from "./Ratings.ts"
import { ArenaRecord } from "./Record.ts"
import { Replays } from "./Replays.ts"
import { PlayRoundLive, Rounds } from "./Rounds.ts"
import { Settings } from "./Settings.ts"
import type { TraceChecker } from "./Traces.ts"
import { NightlyTraces, Traces } from "./Traces.ts"

/**
 * Workflows run on Effect's cluster in single-process mode: their messages and activity results live in the same
 * SQLite file, so a round that was running when the process stopped carries on when it starts again (checked by
 * killing the server with SIGKILL mid-round: the restarted process replays only the unfinished job, within a second
 * of starting). Runner records stay in memory, which relies on one process per database file (one games machine, one
 * volume).
 */
const WorkflowEngineLive = ClusterWorkflowEngine.layer.pipe(
  Layer.provideMerge(SingleRunner.layer({ runnerStorage: "memory" })),
  Layer.provide(NodeCrypto.layer)
)

/** The record's services over `db` and `replays`; the import uses these alone. */
export const makeRecord = <E, E2>(db: Layer.Layer<SqlClient.SqlClient, E>, replays: Layer.Layer<Replays, E2>) =>
  Layer.mergeAll(Settings.layer, Games.layer, Ratings.layer, ArenaRecord.layer).pipe(
    Layer.provideMerge(replays),
    Layer.provideMerge(db)
  )

/** The record's services and the trace checks over `db` and `replays`; the traces command uses these alone. */
export const makeTraces = <E, E2, E3>(
  db: Layer.Layer<SqlClient.SqlClient, E>,
  replays: Layer.Layer<Replays, E2>,
  checker: Layer.Layer<TraceChecker, E3>
) => Traces.layer.pipe(Layer.provideMerge(makeRecord(db, replays)), Layer.provideMerge(checker))

export const makeServices = <E, E2, E3, E4>(
  db: Layer.Layer<SqlClient.SqlClient, E>,
  replays: Layer.Layer<Replays, E2>,
  player: Layer.Layer<GamePlayer, E3>,
  checker: Layer.Layer<TraceChecker, E4>
) => {
  const core = Layer.mergeAll(makeTraces(db, replays, checker), WorkflowEngineLive.pipe(Layer.provideMerge(db)))
  return Layer.mergeAll(Rounds.layer, PlayRoundLive, NightlyTraces).pipe(
    Layer.provideMerge(core),
    Layer.provideMerge(player)
  )
}

export const Routes = Layer.mergeAll(
  HttpApiBuilder.layer(ArenaApi, { openapiPath: "/api/v1/openapi.json" }).pipe(
    Layer.provide(ApiHandlers)
  ),
  HttpApiScalar.layer(ArenaApi, { path: "/api/v1/docs" }),
  McpLive
)

export const makeApp = <E, E2, E3, E4>(
  db: Layer.Layer<SqlClient.SqlClient, E>,
  replays: Layer.Layer<Replays, E2>,
  player: Layer.Layer<GamePlayer, E3>,
  checker: Layer.Layer<TraceChecker, E4>
) => Routes.pipe(Layer.provideMerge(makeServices(db, replays, player, checker)))
