import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { Effect } from "effect"
import { readConfig } from "../../src/games/Config.ts"
import { contextFor } from "../../src/games/Comparison.ts"
import { candidates } from "../../src/games/Compact.ts"
import { checkRound, makeGamesctl } from "../../src/games/Gamesctl.ts"
import { cleanResult, loadArenaJs } from "../../src/games/Js.ts"
import type { ProcService, RunOptions } from "../../src/games/Proc.ts"
import { protocolReplayError, protocolResultError } from "../../src/games/Protocol.ts"
import { roundMark } from "../../src/games/Pusher.ts"
import { compareGame } from "../../src/games/Replay.ts"
import { ladderConfig, ladderId, openRoundFiles, resultOfEntry } from "../../src/games/Results.ts"
import { buildSchedule, jobFor, roundSeed, runKey } from "../../src/games/Schedule.ts"
import { Store } from "../../src/games/Store.ts"
import type { RoundSpec } from "../../src/games/Types.ts"
import { limitsFor } from "../../src/games/Types.ts"

const root = mkdtempSync(path.join(tmpdir(), "arena-v2-"))
after(() => rmSync(root, { recursive: true, force: true }))
const app = path.resolve(import.meta.dirname, "..", "..", "..")
const js = loadArenaJs(app)
const build = "a".repeat(40), cards = "b".repeat(64)
const context = contextFor({ arenaId: "v2", build, cards })!
const spec: RoundSpec = { round: 0, requiredProtocol: 2, context, bots: ["a-v1", "b-v1"], gamesPerPair: 2, capMs: 1000, decks: null,
  bundles: { "a-v1": "a".repeat(64), "b-v1": "b".repeat(64) }, botInfo: {} }

test("v2 identity isolates mutable state while preserving the mount and content-addressed stores", () => {
  const legacy = readConfig({ GAMES_DATA: root })
  const c = readConfig({ GAMES_DATA: root, ARENA_ID: "v2" })
  assert.equal(c.data, root)
  assert.equal(c.arena, "v2")
  assert.equal(c.stateRoot, path.join(root, "arenas", "v2"))
  for (const k of ["server", "procs", "db", "arena", "results", "intake", "dash", "work", "tmp", "home", "oldCoord"] as const) {
    assert.ok(c.paths[k].startsWith(c.stateRoot + path.sep), k)
    assert.notEqual(c.paths[k], legacy.paths[k], k)
  }
  for (const k of ["secret", "bundles", "wasmCache"] as const) assert.equal(c.paths[k], legacy.paths[k])
  assert.equal(legacy.stateRoot, root)
  assert.equal(legacy.arena, "open")
  assert.ok(c.hide.includes(legacy.paths.server) && c.hide.includes(legacy.paths.arena))
  for (const id of ["../open", "v1", "v2/other", "V2"]) assert.throws(() => readConfig({ ARENA_ID: id }), /ARENA_ID/)
})

test("v2 gamesctl children get the same identity and checker build and refuse undeclared protocol policy", async () => {
  const c = readConfig({ GAMES_DATA: root, GAMES_APP: app, ARENA_ID: "v2", GAMES_BUILD: build, GAMES_CARDS: cards })
  const calls: Array<RunOptions> = []
  const proc = { run: (o: RunOptions) => {
    calls.push(o)
    const doc = o.argv.includes("round") ? spec : { round: null, why: "no-competitor" }
    return Effect.succeed({ kind: "exit" as const, code: 0, stdout: JSON.stringify(doc) })
  } } as unknown as ProcService
  const ctl = makeGamesctl(c, proc, "boot")
  await Effect.runPromise(ctl.plan(0))
  const got = await Effect.runPromise(ctl.round(0, 2, 1000))
  assert.equal(got.requiredProtocol, 2)
  for (const call of calls) {
    assert.equal(call.env.ARENA_ID, "v2")
    assert.equal(call.env.GAMES_BUILD, build)
    assert.equal(call.env.GAMES_CARDS, cards)
    if (call.argv.includes("--arena")) assert.equal(call.argv[call.argv.indexOf("--arena") + 1], "v2")
  }
  assert.throws(() => checkRound(0, { ...spec, requiredProtocol: undefined }, 2), /explicit protocol 2/)
  assert.throws(() => checkRound(0, { ...spec, requiredProtocol: 1 }), /requiredProtocol/)
})

test("v2 jobs carry strict policy and derive different seed/key identity from legacy", () => {
  const secret = "fixture-secret"
  assert.notEqual(roundSeed(secret, 0, "v2"), roundSeed(secret, 0))
  assert.notEqual(runKey(secret, 0, "v2"), runKey(secret, 0))
  const games = buildSchedule(js, spec, 1)
  const job = jobFor(js, spec, null, games, limitsFor(1000))
  assert.equal(job.v, 1, "the job envelope version is independent of bot protocol")
  assert.equal(job.requiredProtocol, 2)
  assert.deepEqual(job.context, context)
  assert.equal(ladderId(0), "arena-r0")
  assert.equal(ladderId(0, "v2"), "arena-v2-r0")
})

test("v2 result evidence rejects v1/missing versions and preserves partial protocol rejection errors", () => {
  const accepted = { requiredProtocol: 2, protocols: { p1: 2, p2: 2 }, outcome: "won" }
  assert.equal(protocolResultError(accepted, 2), null)
  for (const protocols of [undefined, {}, { p1: 2 }, { p1: 1, p2: 2 }, { p1: 2, p2: 2, extra: 2 }]) {
    assert.ok(protocolResultError({ ...accepted, protocols }, 2))
  }
  assert.ok(protocolResultError({ protocols: accepted.protocols, outcome: "won" }, 2))
  for (const protocols of [{}, { p1: 2 }]) assert.equal(protocolResultError({ ...accepted, outcome: "ERROR", protocols }, 2), null)
  const replay = (protocols: unknown) => JSON.stringify({ t: "end", ...accepted, protocols }) + "\n"
  assert.equal(protocolReplayError(replay({ p2: 2, p1: 2 }), accepted, 2), null)
  assert.ok(protocolReplayError(replay({ p1: 1, p2: 2 }), accepted, 2))
  assert.ok(protocolReplayError(undefined, accepted, 2))
  assert.equal(protocolReplayError(undefined, { requiredProtocol: 2, protocols: {}, outcome: "ERROR" }, 2), null)
})

test("v2 result files and sanitization retain policy and per-seat evidence with unique clean namespace", () => {
  const results = path.join(root, "results")
  mkdirSync(path.join(results, "arena-r0"), { recursive: true })
  writeFileSync(path.join(results, "arena-r0", "index.json"), "legacy")
  const config = ladderConfig({ spec, arena: "v2", firstSeed: 1, workers: 1, limits: limitsFor(1000), keyId: null })
  const files = openRoundFiles({ results, arena: "v2", k: 0, createdAt: "2026-10-17T00:00:00Z", config, botInfo: {}, scheduled: 1, deckNames: null, summarize: js.summarize })
  const g = { id: "a-v1-vs-b-v1-1", seed: 1, p1: "a-v1", p2: "b-v1" }
  const result = { requiredProtocol: 2 as const, protocols: { p1: 2, p2: 2 }, context, bundles: spec.bundles, outcome: "won" as const, winner: "a-v1", winnerSeat: "p1" as const, round: 1, steps: 2, ms: 3 }
  files.start(g)
  const running = files.write().games[0]
  assert.equal(running.outcome, "running")
  assert.equal(running.requiredProtocol, 2)
  assert.deepEqual(running.context, context)
  assert.deepEqual(running.bundles, spec.bundles)
  assert.equal(running.protocols, undefined, "dispatch provenance never invents an accepted seat handshake")
  files.finish(g, result, null)
  const ladder = files.write()
  const index = JSON.parse(readFileSync(path.join(files.dir, "index.json"), "utf8"))
  assert.equal(index.arena, "v2")
  assert.equal(index.requiredProtocol, 2)
  assert.equal(ladder.config.arena, "v2")
  assert.equal(ladder.config.requiredProtocol, 2)
  assert.deepEqual(ladder.config.context, context)
  assert.deepEqual(ladder.config.bundles, spec.bundles)
  assert.deepEqual(index.games[0].protocols, result.protocols)
  assert.deepEqual(resultOfEntry(ladder.games[0]).protocols, result.protocols)
  assert.deepEqual(cleanResult(result).protocols, result.protocols)
  assert.equal(cleanResult(result).requiredProtocol, 2)
  assert.equal(readFileSync(path.join(results, "arena-r0", "index.json"), "utf8"), "legacy")
  assert.deepEqual(candidates(["arena-r0", "arena-v2-r0", "arena-v2-r1"], 0, "v2").map((r) => r.run), ["arena-v2-r0", "arena-v2-r1"])
  assert.ok(roundMark(results, "v2"))
  const diff = compareGame(g.id, { ...index.games[0], protocols: { p1: 2, p2: 1 } }, result, null, null, null)
  assert.ok(diff.some((d) => d.field === "protocols"))
})

test("v2 database starts empty and cannot import the old arena's rankings or scheduler state", async () => {
  const legacy = readConfig({ GAMES_DATA: path.join(root, "db-case") })
  const fresh = readConfig({ GAMES_DATA: legacy.data, ARENA_ID: "v2" })
  await Effect.runPromise(Effect.gen(function*() {
    const store = yield* Store
    yield* store.createRound({ k: 0, arena: "open", spec: { ...spec }, firstSeed: 1, keyId: null, workers: 1, state: "done", boot: "old", attempts: 0, why: "changed", createdAt: "2026-10-16T00:00:00Z", endedAt: null }, [])
    yield* store.set("round_end", "old")
  }).pipe(Effect.provide(Store.layerFile(legacy.paths.db))))
  await Effect.runPromise(Effect.gen(function*() {
    const store = yield* Store
    assert.equal(yield* store.lastRound, null)
    assert.equal(yield* store.get("round_end"), null)
  }).pipe(Effect.provide(Store.layerFile(fresh.paths.db))))
  await Effect.runPromise(Effect.gen(function*() {
    assert.equal((yield* (yield* Store).lastRound)?.arena, "open")
  }).pipe(Effect.provide(Store.layerFile(legacy.paths.db))))
})
