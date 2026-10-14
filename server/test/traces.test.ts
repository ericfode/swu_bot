import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { gunzipSync, gzipSync } from "node:zlib"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { folderSource, importWindow } from "../src/Import.ts"
import { TraceChecker, Traces } from "../src/Traces.ts"
import { NO_REPLAY, writeFixture } from "./fixture.ts"
import { READER, client, fakeChecker, fakePlayer, mcpSession, recordAt, startArena, tempData } from "./harness.ts"

const REPO = path.resolve(import.meta.dirname, "..", "..")
const ENGINE = existsSync(path.join(REPO, "forceteki", "build", "server")) && existsSync(path.join(REPO, "forceteki", "test", "json", "Card"))
const TRACES = path.join(REPO, "bot", "test", "traces")

test("trace checks: the newest unchecked games are played again once each, and the API and MCP give the verdicts", async () => {
  const home = tempData()
  writeFixture(home)
  const data = tempData()
  const record = recordAt(data)
  await record.runPromise(importWindow(folderSource(home)))
  await record.dispose()
  const batches: Array<ReadonlyArray<string>> = []
  const DIFF = "step 3: state.players.p1.base.d: want 2, got 3"
  let differs = ""
  const arena = startArena(data, fakePlayer([]), fakeChecker(batches, (file) => (file.endsWith(`/${differs}.jsonl.gz`) ? { ok: false, diff: DIFF } : {})))
  try {
    await arena.runPromise(Effect.gen(function*() {
      const traces = yield* Traces
      const sql = yield* SqlClient.SqlClient
      const api = yield* client(READER)
      const newest = (yield* api.games.list({ query: { limit: 20 } })).games.filter((g) => g.replay).map((g) => g.id)
      assert.equal(newest.length, 11, "every fixture game but one has a replay")
      assert.ok(!newest.includes(NO_REPLAY))
      differs = newest[1]

      const first = yield* traces.checkNewest(5)
      assert.deepEqual([first.checked, first.differ, first.failed, first.stopped], [5, [{ game: differs, diff: DIFF }], [], null])
      assert.deepEqual(batches[0].map((f) => path.basename(f, ".jsonl.gz")), newest.slice(0, 5))
      assert.ok(batches[0].every((f) => path.isAbsolute(f) && existsSync(f)), "the checker gets each replay's file")
      assert.equal((yield* traces.checkNewest(100)).checked, 6)
      assert.deepEqual(batches[1].map((f) => path.basename(f, ".jsonl.gz")), newest.slice(5))
      // each game is checked once
      assert.deepEqual([(yield* traces.checkNewest(100)).checked, batches.length], [0, 2])

      // the checker yields to a round: bots are timed
      yield* sql`DELETE FROM traces WHERE game = ${newest[0]}`
      yield* sql`UPDATE rounds SET state = 'running' WHERE id = 'arena-r1'`
      const held = yield* traces.checkNewest(100)
      assert.deepEqual([held.checked, held.stopped, batches.length], [0, "a round is playing", 2])
      yield* sql`UPDATE rounds SET state = 'done' WHERE id = 'arena-r1'`
      assert.equal((yield* traces.checkNewest(100)).checked, 1)

      const page = yield* api.traces.list({ query: {} })
      assert.deepEqual([page.checked, page.differ, page.unchecked], [11, 1, 0])
      assert.deepEqual(page.checks.map((c) => c.game), newest)
      assert.deepEqual(
        { ...page.checks[1] },
        { game: differs, round: page.checks[1].round, ok: false, steps: 100, diff: DIFF, note: null, build: "test-build", checkedAt: page.checks[1].checkedAt }
      )
      // query parameters arrive as text
      const http = yield* HttpClient.HttpClient
      const raw = yield* http.execute(HttpClientRequest.get("/api/v1/traces?differs=true&limit=5").pipe(HttpClientRequest.bearerToken(READER)))
      const onlyDiffer = (yield* raw.json) as { checks: Array<{ game: string }> }
      assert.deepEqual(onlyDiffer.checks.map((c) => c.game), [differs])

      const mcp = yield* mcpSession(READER)
      const viaMcp = yield* mcp.call("tools/call", { name: "arena_traces", arguments: { differs: true } })
      assert.deepEqual(JSON.parse(viaMcp.body.result.content[0].text), JSON.parse(JSON.stringify(yield* api.traces.list({ query: { differs: true } }))))
    }))
  } finally {
    await arena.dispose()
  }
})

test("trace checks: bot/trace.js plays recorded games again and names the first difference", { skip: !ENGINE && "engine or card data not built" }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "arena-traces-"))
  const same = path.join(TRACES, "c_clock-v1-vs-rush-v1-3381370119.jsonl.gz")
  const tampered = path.join(dir, "tampered.jsonl.gz")
  const lines = gunzipSync(readFileSync(same)).toString("utf8").trim().split("\n").map((l) => JSON.parse(l))
  lines.find((e) => e.n === 30).state.players.p1.base.d += 1
  writeFileSync(tampered, gzipSync(lines.map((l) => JSON.stringify(l)).join("\n") + "\n"))
  const verdicts = await Effect.runPromise(Effect.gen(function*() {
    const checker = yield* TraceChecker
    return yield* checker.check([same, tampered])
  }).pipe(Effect.provide(Layer.fresh(TraceChecker.layerNode))))
  assert.deepEqual(verdicts.map((v) => [path.basename(v.file), v.ok]), [["c_clock-v1-vs-rush-v1-3381370119.jsonl.gz", true], ["tampered.jsonl.gz", false]])
  assert.equal(verdicts[0].steps, lines.at(-1).steps)
  assert.match(verdicts[1].diff ?? "", /^step 30: state\.players\.p1\.base\.d: want \d+, got \d+$/)
})
