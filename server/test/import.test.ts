import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { test } from "node:test"
import { gunzipSync, gzipSync } from "node:zlib"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { folderSource, importWindow, windowSource } from "../src/Import.ts"
import { NO_REPLAY, ROUND0, ROUND1, writeFixture } from "./fixture.ts"
import { recordAt, tempData } from "./harness.ts"

const query = (q: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.unsafe<Record<string, unknown>>(q)
  }).pipe(Effect.orDie)

test("import: today's rounds, versions and replays go into the record, and its ratings match the standings", async () => {
  const home = tempData()
  writeFixture(home)
  const data = tempData()
  const record = recordAt(data)
  try {
    const report = await record.runPromise(importWindow(folderSource(home)))
    assert.equal(report.rounds, 2)
    assert.equal(report.games, 12)
    assert.equal(report.rated, 10)
    assert.deepEqual(report.replays, { stored: 11, kept: 0, missing: 1 })
    assert.deepEqual(report.builtins, ["c-clock-wasm", "rush"])
    assert.equal(report.competitors, 3)
    assert.equal(report.versions, 7) // 3 of alice_bot's, a resident version each, two built-in bots
    assert.equal(report.submissions, 5)
    assert.equal(report.people, 2) // alice (a builder) and ericfode (the admin)
    assert.deepEqual(report.notes, [
      "left out arena/versions-old_bot: old_bot is not in the roster",
      "left out submissions/bob.x1: bob_bot is not in the roster"
    ])
    assert.deepEqual(report.check, { compared: 12, mismatches: [] })

    const rows = await record.runPromise(Effect.all({
      people: query("SELECT login, role FROM people ORDER BY login"),
      builtin: query("SELECT id, competitor, number, format FROM versions WHERE format = 'builtin' ORDER BY id"),
      games: query("SELECT id, outcome, score, fault_seat, winner, host, p1_think_ms, p1_decisions, replay FROM games ORDER BY seq"),
      season: query("SELECT note, started_at, rules FROM seasons")
    }))
    assert.deepEqual(rows.people, [{ login: "alice", role: "friend" }, { login: "ericfode", role: "admin" }])
    assert.deepEqual(rows.builtin, [
      { id: "c-clock-wasm", competitor: "c_clock", number: 0, format: "builtin" },
      { id: "rush", competitor: "rush", number: 0, format: "builtin" }
    ])
    assert.deepEqual(rows.games.map((g) => g.id), [...ROUND0, ...ROUND1].map((g) => g.id))
    assert.deepEqual(rows.games.map((g) => g.outcome), ["won", "forfeit", "won", "draw", "won", "error", "won", "won", "won", "step_cap", "won", "won"])
    assert.deepEqual(rows.games[1], {
      id: ROUND0[1].id,
      outcome: "forfeit",
      score: 1,
      faultSeat: "p2",
      winner: "c-clock-wasm",
      host: null,
      p1ThinkMs: 101,
      p1Decisions: 60,
      replay: `arena-r0/${ROUND0[1].id}.jsonl.gz`
    })
    assert.equal(rows.games[2].host, "eric")
    assert.equal(rows.games[11].replay, null)
    assert.match(String(rows.season[0].note), /rounds 0-0: 2 games per pair, 60 s.*rounds 1-1: 2 games per pair, 45 s/)
    assert.equal(rows.season[0].startedAt, "2026-10-13T08:30:00.000Z")
    const stored = readdirSync(path.join(data, "replays", "arena-r1")).sort()
    assert.equal(stored.length, 5)
    assert.ok(!stored.includes(`${NO_REPLAY}.jsonl.gz`))

    // a second import adds nothing and keeps the replays it has
    const again = await record.runPromise(importWindow(folderSource(home)))
    assert.deepEqual(again.replays, { stored: 0, kept: 11, missing: 1 })
    const count = await record.runPromise(query("SELECT count(*) AS n, max(seq) AS top FROM games"))
    assert.deepEqual(count, [{ n: 12, top: 12 }])
  } finally {
    await record.dispose()
  }
})

test("import: a standings number the record cannot reproduce undoes the whole import", async () => {
  const home = tempData()
  writeFixture(home, { tamper: true })
  const record = recordAt(tempData())
  try {
    const failed = await record.runPromise(importWindow(folderSource(home), { replays: false }).pipe(Effect.flip))
    assert.equal(failed._tag, "ImportFailed")
    assert.match(failed.message, /arena-r0 rush: window 1465\/1\/1\/1\/1\/0, record 1464\/1\/1\/1\/1\/0/)
    const left = await record.runPromise(Effect.all([
      query("SELECT count(*) AS n FROM games"),
      query("SELECT count(*) AS n FROM versions"),
      query("SELECT count(*) AS n FROM ratings")
    ]))
    assert.deepEqual(left, [[{ n: 0 }], [{ n: 0 }], [{ n: 0 }]])
  } finally {
    await record.dispose()
  }
})

test("import: reads the live window's API the same way, with a token", async () => {
  const home = tempData()
  writeFixture(home)
  const seen: Array<string> = []
  const window = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    if (req.headers.authorization !== "Bearer project-token") return void res.writeHead(401).end()
    const parts = (req.url ?? "").split("/").filter(Boolean).map(decodeURIComponent)
    try {
      if (parts[1] === "docs" && parts.length === 3) {
        const ids = readdirSync(path.join(home, "docs", parts[2])).map((f) => ({ id: f.replace(/\.json$/, "") }))
        return void res.writeHead(200).end(JSON.stringify({ result: ids }))
      }
      if (parts[1] === "docs" && parts.length === 4) {
        const doc = readFileSync(path.join(home, "docs", parts[2], `${parts[3]}.json`), "utf8")
        return void res.writeHead(200).end(`{"result":${doc}}`)
      }
      if (parts[1] === "replays" && parts.length === 4) {
        const text = gunzipSync(readFileSync(path.join(home, "replays", parts[2], `${parts[3]}.jsonl.gz`)))
        // like the window, gzipped on the wire when the client accepts it
        if (/gzip/.test(String(req.headers["accept-encoding"]))) {
          return void res.writeHead(200, { "content-encoding": "gzip" }).end(gzipSync(text))
        }
        return void res.writeHead(200).end(text)
      }
    } catch {
      return void res.writeHead(404).end("{}")
    }
    res.writeHead(404).end("{}")
  })
  await new Promise<void>((resolve) => window.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${(window.address() as AddressInfo).port}`
  const record = recordAt(tempData())
  try {
    const report = await record.runPromise(importWindow(windowSource(base, "project-token"), { concurrency: 3 }))
    assert.equal(report.games, 12)
    assert.deepEqual(report.replays, { stored: 11, kept: 0, missing: 1 })
    assert.deepEqual(report.check.mismatches, [])
    assert.ok(seen.every((line) => line.startsWith("GET ")), "the import only reads")
    const stranger = await record.runPromise(importWindow(windowSource(base, "wrong")).pipe(Effect.flip))
    assert.match(stranger.message, /GET \/api\/docs\/arena\/standings: 401/)
  } finally {
    await record.dispose()
    window.close()
  }
})
