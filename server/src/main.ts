/**
 * node src/main.ts: the arena server on HOST:PORT (default 127.0.0.1:8787), its record in ARENA_DATA (default ./data).
 */
import { createServer } from "node:http"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Config, Layer } from "effect"
import { HttpRouter } from "effect/http"
import * as Db from "./Db.ts"
import { GamePlayer } from "./Player.ts"
import { Replays } from "./Replays.ts"
import { makeApp } from "./Server.ts"
import { TraceChecker } from "./Traces.ts"

const HttpLive = HttpRouter.serve(makeApp(Db.layer, Replays.layer, GamePlayer.layerNode, TraceChecker.layerNode)).pipe(
  Layer.provide(NodeHttpServer.layerConfig(createServer, {
    port: Config.Port("PORT").pipe(Config.withDefault(8787)),
    host: Config.String("HOST").pipe(Config.withDefault("127.0.0.1"))
  }))
)

Layer.launch(HttpLive).pipe(NodeRuntime.runMain)
