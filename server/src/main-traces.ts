/**
 * node src/main-traces.ts [--limit 1000]: plays the newest unchecked games in the record in ARENA_DATA (default ./data)
 * again from their replays, as the server does every night, and prints what came out differently. Needs the engine
 * built in ARENA_ROOT (default: this checkout). Exit 1 when a game came out differently.
 */
import { parseArgs } from "node:util"
import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import * as Db from "./Db.ts"
import { Replays } from "./Replays.ts"
import { makeTraces } from "./Server.ts"
import { NIGHTLY, TraceChecker, Traces } from "./Traces.ts"

const { values } = parseArgs({ options: { limit: { type: "string", default: String(NIGHTLY) } } })

const program = Effect.gen(function*() {
  const traces = yield* Traces
  const run = yield* traces.checkNewest(Math.max(1, Number(values.limit) || NIGHTLY))
  console.log(JSON.stringify(run, null, 2))
  if (run.differ.length > 0) process.exitCode = 1
}).pipe(Effect.provide(makeTraces(Db.layer, Replays.layer, TraceChecker.layerNode)))

NodeRuntime.runMain(program)
