import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { Effect } from "effect"
import { bindComparison, bundleMapProblem, bundlesOfJob, comparisonReplayProblem, comparisonResultProblem, contextFor, contextProblem, jobContextProblem, roundContextProblem } from "../../src/games/Comparison.ts"
import { readConfig } from "../../src/games/Config.ts"
import { playLocal } from "../../src/games/Executor.ts"
import { resultBody } from "../../src/games/Helper.ts"
import type { ProcService } from "../../src/games/Proc.ts"
import { readNames, readRound } from "../../src/games/Replay.ts"
import type { PlaySeedJob, RoundSpec } from "../../src/games/Types.ts"

const root = mkdtempSync(path.join(tmpdir(), "comparison-context-"))
after(() => rmSync(root, { recursive: true, force: true }))
const build = "a".repeat(40), cards = "b".repeat(64)
const context = contextFor({ arenaId: "v2", build, cards })!
const bundles = { "a-v1": "a".repeat(64), "b-v1": "b".repeat(64) }
const spec: RoundSpec = { requiredProtocol: 2, context, round: 0, bots: Object.keys(bundles), bundles, gamesPerPair: 2, capMs: 1000, decks: null, botInfo: {} }
const job: PlaySeedJob = { v: 1, requiredProtocol: 2, context, seed: 1, key: null, maxSteps: 10, capMs: 1000, hangMs: 2000, gameMs: 3000,
  games: [{ id: "g", p1: "a-v1", p2: "b-v1" }], bots: { "a-v1": { kind: "wasm", bundle: bundles["a-v1"] }, "b-v1": { kind: "wasm", bundle: bundles["b-v1"] } } }

test("comparison context binds arena/protocol/build/cards/runner and unknown identity fails closed", () => {
  assert.deepEqual(readConfig({ ARENA_ID: "v2", GAMES_BUILD: build, GAMES_CARDS: cards }).context, context)
  assert.equal(contextFor({ arenaId: "v2", build: "unknown", cards }), null)
  assert.equal(readConfig({ ARENA_ID: "v2" }).context, null)
  assert.equal(contextProblem(context, context), null)
  for (const current of [null, contextFor({ arenaId: "v2", build: "c".repeat(40), cards }), contextFor({ arenaId: "v2", build, cards: "d".repeat(64) }), { ...context, runnerRevision: "next" }]) {
    assert.ok(contextProblem(context, current))
    assert.ok(roundContextProblem(spec, current))
    assert.ok(jobContextProblem(job, current))
  }
  assert.ok(roundContextProblem(spec, context, { ...bundles, "a-v1": "c".repeat(64) }))
  assert.ok(bundleMapProblem({ ...bundles, extra: "e".repeat(64) }, bundles))
})

test("v2 config cannot override an immutable image identity to resume another context", () => {
  const app = path.join(root, "image")
  mkdirSync(app)
  const env = { ARENA_ID: "v2", GAMES_APP: app, GAMES_BUILD: build, GAMES_CARDS: cards }
  assert.deepEqual(readConfig(env).context, context, "source fixtures can identify an image without identity files")
  writeFileSync(path.join(app, "BUILD_SHA"), build + "\n")
  writeFileSync(path.join(app, "CARDS_SHA"), cards + "\n")
  assert.deepEqual(readConfig({ ARENA_ID: "v2", GAMES_APP: app }).context, context)
  assert.deepEqual(readConfig(env).context, context, "matching explicit identities remain valid")
  assert.throws(() => readConfig({ ...env, GAMES_BUILD: "c".repeat(40) }), /BUILD_SHA.*conflicts with the immutable image identity/)
  assert.throws(() => readConfig({ ...env, GAMES_CARDS: "d".repeat(64) }), /CARDS_SHA.*conflicts with the immutable image identity/)
  assert.equal(readConfig({ ...env, ARENA_ID: "open", GAMES_BUILD: "c".repeat(40) }).build, "c".repeat(40), "legacy override behavior is preserved")
  writeFileSync(path.join(app, "CARDS_SHA"), "unusable image identity\n")
  assert.equal(readConfig({ ARENA_ID: "v2", GAMES_APP: app }).context, null, "an invalid image identity fails closed")
  assert.throws(() => readConfig(env), /CARDS_SHA.*conflicts with the immutable image identity/)
})

test("local executor refuses changed comparison context before preparing or dispatching a job", async () => {
  const c = readConfig({ GAMES_DATA: root, ARENA_ID: "v2", GAMES_BUILD: "c".repeat(40), GAMES_CARDS: cards })
  let called = false
  const proc = { run: () => { called = true; throw new Error("must not run") } } as unknown as ProcService
  const outcome = await Effect.runPromise(Effect.result(playLocal(c, proc, job, "stale")))
  assert.equal(outcome._tag, "Failure")
  assert.equal(called, false)
  assert.equal(existsSync(path.join(c.paths.work, "stale")), false)
})

test("trusted helper ingestion binds context/digests and helper result validation rejects substitutions", () => {
  const out = path.join(root, "out")
  mkdirSync(out)
  const result = { outcome: "won" as const, winner: "a-v1", winnerSeat: "p1" as const, requiredProtocol: 2 as const, protocols: { p1: 2, p2: 2 }, round: 1, steps: 2, ms: 3 }
  const file = path.join(out, "g.jsonl")
  writeFileSync(file, JSON.stringify({ t: "end", ...result }) + "\n")
  const outcome = resultBody(JSON.stringify({ ok: true, results: [{ id: "g", result }], replays: { g: file } }), out, null, job)
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  const accepted = JSON.parse(outcome.json)
  assert.equal(comparisonResultProblem(accepted.results[0].result, context, bundles), null)
  assert.equal(comparisonReplayProblem(accepted.replays.g, accepted.results[0].result, context, bundles), null)
  assert.ok(comparisonResultProblem({ ...accepted.results[0].result, context: { ...context, engineRevision: "old" } }, context, bundles))
  assert.ok(comparisonResultProblem({ ...accepted.results[0].result, bundles: { ...bundles, "a-v1": "c".repeat(64) } }, context, bundles))
  const bound = bindComparison(result, null, context, bundlesOfJob(job))
  assert.deepEqual(bound.result.bundles, bundles)
})

test("replay requires original frozen bundle digests even when a replacement tar hashes correctly", () => {
  const dir = path.join(root, "tars")
  mkdirSync(dir)
  const replacement = Buffer.from("a different trusted fixture")
  const digest = createHash("sha256").update(replacement).digest("hex")
  writeFileSync(path.join(dir, `${digest}.tar`), replacement)
  assert.throws(() => readNames(JSON.stringify({ "a-v1": digest }), ["a-v1"], dir, bundles), /original bundle digest/)
  const config = { arena: "v2", requiredProtocol: 2, context, bundles, bots: Object.keys(bundles), gamesPerPair: 2, firstSeed: 1, maxSteps: 10, capMs: 1000, hangMs: 2000, key: "key" }
  assert.deepEqual(readRound({ config }).context, context)
  assert.throws(() => readRound({ config: { ...config, context: null } }), /context/)
  assert.throws(() => readRound({ config: { ...config, bundles: {} } }), /bundle/)
})
