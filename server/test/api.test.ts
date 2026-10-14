import assert from "node:assert/strict"
import { test } from "node:test"
import { gunzipSync } from "node:zlib"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { folderSource, importWindow } from "../src/Import.ts"
import { EXPECTED, NO_REPLAY, ROUND0, ROUND1, replayText, writeFixture } from "./fixture.ts"
import { READER, client, fakePlayer, mcpSession, recordAt, startArena, tempData } from "./harness.ts"

/** An arena whose record holds the fixture's two imported rounds. */
const importedArena = async () => {
  const home = tempData()
  writeFixture(home)
  const data = tempData()
  const record = recordAt(data)
  await record.runPromise(importWindow(folderSource(home)))
  await record.dispose()
  return startArena(data, fakePlayer([]))
}

const get = (url: string, headers: Record<string, string> = {}) =>
  Effect.gen(function*() {
    const http = yield* HttpClient.HttpClient
    let request = HttpClientRequest.get(url).pipe(HttpClientRequest.bearerToken(READER))
    for (const [k, v] of Object.entries(headers)) request = HttpClientRequest.setHeader(request, k, v)
    return yield* http.execute(request)
  })

test("export API: arenas, standings, competitors, versions and a version's stats", async () => {
  const arena = await importedArena()
  try {
    await arena.runPromise(Effect.gen(function*() {
      const api = yield* client(READER)
      const [open] = yield* api.arenas.list()
      assert.deepEqual([open.id, open.season, open.rules], ["open", 1, { gamesPerPair: 2, capMs: 45000, hangMs: 150000, maxSteps: 6000 }])
      assert.match(open.seasons[0].note ?? "", /changing rules/)

      const standings = yield* api.arenas.standings({ params: { id: "open" }, query: {} })
      assert.deepEqual(standings.rounds.map((r) => r.round), ["arena-r0", "arena-r1"])
      const ratings = (rows: ReadonlyArray<{ version: string; rating: number }>) =>
        Object.fromEntries(rows.map((r) => [r.version, r.rating]))
      assert.deepEqual(ratings(standings.rounds[0].thisRound), EXPECTED.r0)
      assert.deepEqual(ratings(standings.rounds[1].thisRound), EXPECTED.r1)
      assert.deepEqual(ratings(standings.rounds[1].season), EXPECTED.global)
      // best first, the house's versions marked as anchors
      const r0 = standings.rounds[0].thisRound
      assert.deepEqual(r0.map((r) => [r.version, r.anchor]), [["c-clock-wasm", true], ["rush", true], ["alice_bot-v1", false]])
      assert.deepEqual(r0[2].record, { games: 4, wins: 1, losses: 2, draws: 1, unrated: 0, forfeits: 1 })
      assert.equal((yield* api.arenas.standings({ params: { id: "nowhere" }, query: {} }).pipe(Effect.flip))._tag, "NotFound")

      const competitors = yield* api.competitors.list()
      assert.deepEqual(competitors.map((c) => [c.name, c.owner, c.house]), [["alice_bot", "alice", false], ["c_clock", null, true], ["rush", null, true]])
      const versions = yield* api.versions.list({ query: { competitor: "c_clock" } })
      assert.deepEqual(versions.map((v) => [v.id, v.number, v.format]), [["c-clock-wasm", 0, "builtin"], ["c_clock-v1", 1, "wasm"]])
      const v1 = yield* api.versions.get({ params: { id: "alice_bot-v1" } })
      assert.deepEqual([v1.submission, v1.files], ["alice.x1", ["arena.json", "bot.wasm"]])

      const stats = yield* api.versions.stats({ params: { id: "alice_bot-v1" }, query: {} })
      assert.deepEqual(stats.record, { games: 4, wins: 1, losses: 2, draws: 1, unrated: 0, forfeits: 1 })
      assert.deepEqual(stats.headToHead.map((h) => [h.opponent, h.record.wins, h.record.losses, h.record.draws]), [
        ["c-clock-wasm", 1, 1, 0],
        ["rush", 0, 1, 1]
      ])
      // seat p1 in two games (60 decisions each), p2 in two (40 each)
      assert.deepEqual([stats.time.games, stats.time.decisions, stats.time.decideMs, stats.time.msPerDecision], [4, 200, 500, 2.5])
      assert.equal(stats.rating?.rating, EXPECTED.global["alice_bot-v1"])
      assert.deepEqual(stats.spots, [])
      assert.equal((yield* api.versions.stats({ params: { id: "nobody-v9" }, query: {} }).pipe(Effect.flip))._tag, "NotFound")

      // the OpenAPI document lists every path of export API v1
      const openapi = (yield* (yield* get("/api/v1/openapi.json")).json) as { paths: Record<string, unknown> }
      for (const p of ["/api/v1/arenas", "/api/v1/arenas/{id}/standings", "/api/v1/games", "/api/v1/games/{id}/replay", "/api/v1/versions/{id}/stats", "/api/v1/export/games.jsonl"]) {
        assert.ok(p in openapi.paths, p)
      }

      const rounds = yield* api.rounds.list({ query: { arena: "open", season: 1 } })
      assert.deepEqual(rounds.map((r) => [r.id, r.number, r.state, r.gamesPlayed, r.rated, r.runKey]), [
        ["arena-r0", 0, "done", 6, 5, "runkey1"],
        ["arena-r1", 1, "done", 6, 5, "runkey2"]
      ])
    }))
  } finally {
    await arena.dispose()
  }
})

test("export API: games a page at a time, one game, its replay, and the bulk export", async () => {
  const arena = await importedArena()
  const all = [...ROUND0, ...ROUND1].map((g) => g.id)
  try {
    await arena.runPromise(Effect.gen(function*() {
      const api = yield* client(READER)
      const first = yield* api.games.list({ query: { limit: 5 } })
      assert.deepEqual(first.games.map((g) => g.id), all.slice(-5).reverse())
      assert.equal(first.next, 8)
      const second = yield* api.games.list({ query: { limit: 5, before: first.next! } })
      const third = yield* api.games.list({ query: { limit: 5, before: second.next! } })
      assert.deepEqual([...first.games, ...second.games, ...third.games].map((g) => g.id), [...all].reverse())
      assert.equal(third.next, null)
      const mine = yield* api.games.list({ query: { round: "arena-r0", version: "rush" } })
      assert.equal(mine.games.length, 4)

      const game = yield* api.games.get({ params: { id: ROUND0[1].id } })
      assert.deepEqual([game.outcome, game.faultSeat, game.faultKind, game.score, game.dealKey], ["forfeit", "p2", "time", 1, "r0-key-100"])
      assert.deepEqual(game.time.p2, { thinkMs: 201, decisions: 40, decideMs: 100, p95Ms: 4, maxMs: 9 })
      assert.equal((yield* api.games.get({ params: { id: "no-such-game" } }).pipe(Effect.flip))._tag, "NotFound")

      // numbers in the query string are read and checked like any other input
      const raw = yield* get("/api/v1/games?limit=2&season=1&arena=open")
      assert.equal(raw.status, 200)
      assert.equal(((yield* raw.json) as { games: Array<unknown> }).games.length, 2)
      const bad = yield* get("/api/v1/games?limit=0")
      assert.equal(bad.status, 400)
      assert.match(((yield* bad.json) as { message: string }).message, /between 1 and 500/)

      // the replay: gzipped to a client that accepts it, plain text otherwise
      const zipped = yield* get(`/api/v1/games/${ROUND0[0].id}/replay`, { "accept-encoding": "gzip" })
      assert.equal(zipped.headers["content-encoding"], "gzip")
      const bytes = new Uint8Array(yield* zipped.arrayBuffer)
      const text = bytes[0] === 0x1f ? gunzipSync(bytes).toString("utf8") : new TextDecoder().decode(bytes)
      assert.equal(text, replayText(ROUND0[0].id))
      const plain = yield* get(`/api/v1/games/${ROUND0[0].id}/replay`, { "accept-encoding": "identity" })
      assert.equal(yield* plain.text, replayText(ROUND0[0].id))
      assert.equal((yield* get(`/api/v1/games/${NO_REPLAY}/replay`)).status, 404)

      // the bulk export, oldest first, resumable after the last seq read
      const lines = (yield* (yield* get("/api/v1/export/games.jsonl")).text).trim().split("\n").map((l) => JSON.parse(l))
      assert.deepEqual(lines.map((g) => g.id), all)
      assert.deepEqual(lines.map((g) => g.seq), all.map((_, i) => i + 1))
      const rest = (yield* (yield* get("/api/v1/export/games.jsonl?after=10")).text).trim().split("\n")
      assert.deepEqual(rest.map((l) => JSON.parse(l).id), all.slice(10))
    }))
  } finally {
    await arena.dispose()
  }
})

test("MCP: the export API's reads as tools, giving the same records", async () => {
  const arena = await importedArena()
  try {
    await arena.runPromise(Effect.gen(function*() {
      const api = yield* client(READER)
      const mcp = yield* mcpSession(READER)
      const tools = yield* mcp.call("tools/list", {})
      assert.deepEqual(tools.body.result.tools.map((t: { name: string }) => t.name).sort(), [
        "arena_arenas",
        "arena_competitors",
        "arena_game",
        "arena_games",
        "arena_replay",
        "arena_round",
        "arena_rounds",
        "arena_standings",
        "arena_version_stats",
        "arena_versions"
      ])
      const call = (name: string, args: object) =>
        Effect.map(mcp.call("tools/call", { name, arguments: args }), (r) => {
          assert.equal(r.body.result?.isError, false, JSON.stringify(r.body))
          return JSON.parse(r.body.result.content[0].text)
        })
      const same = (a: unknown, b: unknown) => assert.deepEqual(a, JSON.parse(JSON.stringify(b)))
      same(yield* call("arena_standings", { arena: "open" }), yield* api.arenas.standings({ params: { id: "open" }, query: {} }))
      same(
        yield* call("arena_version_stats", { version: "rush" }),
        yield* api.versions.stats({ params: { id: "rush" }, query: {} })
      )
      same(yield* call("arena_games", { limit: 3, round: "arena-r1" }), yield* api.games.list({ query: { limit: 3, round: "arena-r1" } }))
      const replay = yield* call("arena_replay", { id: ROUND0[0].id, from: 1, limit: 5 })
      assert.deepEqual([replay.lines, replay.from, replay.steps.map((s: { t: string }) => s.t)], [3, 1, ["step", "end"]])
      const missing = yield* mcp.call("tools/call", { name: "arena_game", arguments: { id: "no-such-game" } })
      assert.equal(missing.body.result.isError, true)
    }))
  } finally {
    await arena.dispose()
  }
})
