/**
 * The one-time import of today's arena into the record in ARENA_DATA (default ./data):
 *
 *   node src/main-import.ts --window https://swu-arena.fly.dev   # GET only, with ARENA_IMPORT_TOKEN or ARENA_PUSH_TOKEN
 *   node src/main-import.ts --home /data/window                  # a copy of the window's volume
 *     [--no-replays] [--admins ericfode] [--concurrency 6]
 *
 * Prints what it imported. It fails, and leaves the record as it was, when the ratings it computes differ from the
 * window's standings. Running it again adds only what is new. Behind an HTTPS proxy, set NODE_USE_ENV_PROXY=1.
 */
import { parseArgs } from "node:util"
import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import * as Db from "./Db.ts"
import { folderSource, ImportFailed, importWindow, windowSource } from "./Import.ts"
import { Replays } from "./Replays.ts"
import { makeRecord } from "./Server.ts"

const { values } = parseArgs({
  options: {
    window: { type: "string" },
    home: { type: "string" },
    "no-replays": { type: "boolean", default: false },
    admins: { type: "string", default: "ericfode" },
    concurrency: { type: "string", default: "6" }
  }
})

const program = Effect.gen(function*() {
  const token = process.env.ARENA_IMPORT_TOKEN ?? process.env.ARENA_PUSH_TOKEN
  const source = values.window !== undefined
    ? token
      ? windowSource(values.window, token)
      : yield* new ImportFailed({ message: "--window needs a project token in ARENA_IMPORT_TOKEN or ARENA_PUSH_TOKEN" })
    : values.home !== undefined
    ? folderSource(values.home)
    : yield* new ImportFailed({ message: "say where to read from: --window <url> or --home <dir>" })
  const report = yield* importWindow(source, {
    replays: !values["no-replays"],
    admins: values.admins.split(",").filter(Boolean),
    concurrency: Math.max(1, Number(values.concurrency) || 6)
  })
  console.log(JSON.stringify(report, null, 2))
}).pipe(Effect.provide(makeRecord(Db.layer, Replays.layer)))

NodeRuntime.runMain(program)
