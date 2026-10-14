import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect } from "effect"
import { planJobs } from "../src/Rounds.ts"
import { ADMIN, READER, addVersions, client, fakePlayer, mcpSession, startArena, tempData, waitForRound } from "./harness.ts"

test("plan: every pair plays gamesPerPair games, half in each seat, in jobs of `workers` games", () => {
  const jobs = planJobs({ id: "r1", bots: ["a", "b", "c"], firstSeed: 10, gamesPerPair: 4, thinkCapSec: 60, workers: 4 })
  const games = jobs.flatMap((j) => j.games.map((g) => ({ ...g, seed: j.seed })))
  assert.equal(games.length, 3 * 4)
  assert.deepEqual([...new Set(jobs.map((j) => j.seed))], [10, 11])
  assert.ok(jobs.every((j) => j.games.length <= 4))
  for (const [x, y] of [["a", "b"], ["a", "c"], ["b", "c"]]) {
    assert.equal(games.filter((g) => g.p1 === x && g.p2 === y).length, 2)
    assert.equal(games.filter((g) => g.p1 === y && g.p2 === x).length, 2)
  }
  assert.equal(new Set(games.map((g) => g.id)).size, games.length)
})

test("rounds: a round plays every planned game, keeps the replays, rates the round, and the API and MCP agree", async () => {
  const played: Array<string> = []
  const arena = startArena(tempData(), fakePlayer(played))
  try {
    await arena.runPromise(Effect.gen(function*() {
      yield* addVersions(["alpha", "beta", "gamma"])
      const admin = yield* client(ADMIN)
      yield* admin.settings.update({ payload: { set: { gamesPerPair: 2, workers: 2 } } })
      const bots = ["alpha-v1", "beta-v1", "gamma-v1"]
      const started = yield* admin.rounds.start({ payload: { id: "r1", bots, firstSeed: 1 } })
      assert.equal(started.gamesPlanned, 6)
      assert.deepEqual([started.arena, started.season, started.number], ["open", 1, 0])
      assert.equal((yield* admin.rounds.start({ payload: { id: "r1", bots: ["alpha-v1", "beta-v1"], firstSeed: 1 } })
        .pipe(Effect.flip))._tag, "RoundExists")
      assert.equal((yield* admin.rounds.start({ payload: { id: "r2", bots: ["alpha-v1", "nobody-v1"], firstSeed: 1 } })
        .pipe(Effect.flip))._tag, "NotFound")

      const done = yield* waitForRound("r1")
      assert.equal(done.state, "done")
      assert.equal(done.gamesPlayed, 6)
      assert.equal(done.rated, 6)
      assert.ok(done.endedAt)
      assert.equal(played.length, 3) // 6 games in jobs of 2

      // the fake player lets p1 win, so everyone goes 2-2 and rates the same
      const reader = yield* client(READER)
      const standings = yield* reader.arenas.standings({ params: { id: "open" }, query: {} })
      assert.deepEqual(standings.rounds.map((r) => r.round), ["r1"])
      assert.deepEqual(standings.rounds[0].thisRound.map((r) => [r.version, r.rating, r.record.wins, r.record.losses]).sort(), [
        ["alpha-v1", 1500, 2, 2],
        ["beta-v1", 1500, 2, 2],
        ["gamma-v1", 1500, 2, 2]
      ])

      const page = yield* reader.games.list({ query: { round: "r1", version: "alpha-v1" } })
      assert.equal(page.games.length, 4)
      assert.ok(page.games.every((g) => g.replay && g.time.p1.thinkMs === 130 && g.score === 1))

      const mcp = yield* mcpSession(READER)
      assert.equal(mcp.init.status, 200)
      const viaMcp = yield* mcp.call("tools/call", { name: "arena_games", arguments: { round: "r1", version: "alpha-v1" } })
      assert.equal(viaMcp.body.result.isError, false)
      assert.deepEqual(JSON.parse(viaMcp.body.result.content[0].text), JSON.parse(JSON.stringify(page)))
      const round = yield* mcp.call("tools/call", { name: "arena_round", arguments: { id: "r1" } })
      assert.equal(JSON.parse(round.body.result.content[0].text).state, "done")
      const missing = yield* mcp.call("tools/call", { name: "arena_round", arguments: { id: "nope" } })
      assert.equal(missing.body.result.isError, true)
    }))
  } finally {
    await arena.dispose()
  }
})

test("mcp: refused without a known token", async () => {
  const arena = startArena(tempData(), fakePlayer([]))
  try {
    const mcp = await arena.runPromise(mcpSession("not-a-token"))
    assert.equal(mcp.init.status, 401)
  } finally {
    await arena.dispose()
  }
})

test("rounds: a round cut off mid-way carries on after a restart, without replaying finished jobs", async () => {
  const file = tempData()
  const before: Array<string> = []
  // the first process stops for good on seed 2's job, like a machine that dies mid-round
  const first = startArena(file, fakePlayer(before, (job) => job.seed === 2))
  try {
    await first.runPromise(Effect.gen(function*() {
      yield* addVersions(["alpha", "beta"])
      const admin = yield* client(ADMIN)
      yield* admin.settings.update({ payload: { set: { gamesPerPair: 4, workers: 2 } } })
      yield* admin.rounds.start({ payload: { id: "r9", bots: ["alpha-v1", "beta-v1"], firstSeed: 1 } })
      for (let i = 0; i < 100 && before.length < 2; i++) yield* Effect.sleep("50 millis")
    }))
    assert.deepEqual(before, ["r9-s1-alpha-v1-beta-v1,r9-s1-beta-v1-alpha-v1", "r9-s2-alpha-v1-beta-v1,r9-s2-beta-v1-alpha-v1"])
  } finally {
    await first.dispose()
  }

  const after: Array<string> = []
  const second = startArena(file, fakePlayer(after))
  try {
    const done = await second.runPromise(waitForRound("r9", 30))
    assert.equal(done.state, "done")
    assert.equal(done.gamesPlayed, 4)
    assert.deepEqual(after, ["r9-s2-alpha-v1-beta-v1,r9-s2-beta-v1-alpha-v1"]) // seed 1's job was not played again
  } finally {
    await second.dispose()
  }
})
