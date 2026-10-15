import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { loadArenaJs } from "../../src/games/Js.ts"
import { buildSchedule, bySeed, evenGames, jobFor, keyId, roundSeed, runKey } from "../../src/games/Schedule.ts"
import { limitsFor } from "../../src/games/Types.ts"

const app = path.resolve(import.meta.dirname, "..", "..", "..")
const js = loadArenaJs(app)
const require = createRequire(path.join(app, "bot", "package.json"))
const hex = (s: string) => createHash("sha256").update(s).digest("hex")

test("schedule: seeds and keys as referee.js makes them, games as ladder.js lists them", () => {
  const secret = "s".repeat(64)
  assert.equal(roundSeed(secret, 7), parseInt(hex(`${secret}:watch:7`).slice(0, 8), 16))
  assert.equal(runKey(secret, 7), hex(`${secret}:key:watch:7`).slice(0, 32))
  assert.equal(keyId("k"), hex("k").slice(0, 12))
  assert.equal(evenGames(3), 4)
  const games = buildSchedule(js, { bots: ["a-v1", "b-v2", "c-v1"], gamesPerPair: 2, decks: null }, 100)
  assert.deepEqual(games.slice(0, 3).map((g) => g.id), ["a-v1-vs-b-v2-100", "b-v2-vs-a-v1-100", "a-v1-vs-c-v1-101"])
  assert.equal(games.length, 6)
  assert.ok(games.every((g) => !("decks" in g)))
  assert.deepEqual([...bySeed(games).keys()], [100, 101, 102])
})

test("schedule: a job for some games of a seed passes play-seed's own check, deck lists remapped as the lane does", () => {
  const { checkJob } = require(path.join(app, "bot", "arena", "play-seed.js"))
  const bundles = mkdtempSync(path.join(tmpdir(), "games-bundles-"))
  const bundleOf = { "a-v1": hex("a"), "b-v2": hex("b") }
  for (const h of Object.values(bundleOf)) writeFileSync(path.join(bundles, `${h}.tar`), "")
  const deck = (name: string) => ({ metadata: { name }, leader: { id: "SOR_005", count: 1 }, base: { id: "SOR_022", count: 1 }, deck: [], sideboard: [] })
  const { normalizeDeck } = require(path.join(app, "bot", "decklists.js"))
  const lists = ["d0", "d1", "d2", "d3"].map((n) => normalizeDeck(deck(n)))
  const spec = { bots: ["a-v1", "b-v2"], gamesPerPair: 4, bundles: bundleOf, decks: { file: "x.json", sha256: hex("x"), names: lists.map((l) => l.metadata.name), deal: "seat" as const, skipped: [], lists } }
  const games = buildSchedule(js, spec, 5)
  assert.ok(games.every((g) => g.decks && g.decks.length === 2))
  const seed = games[2]!.seed
  const ofSeed = bySeed(games).get(seed)!
  const run = "r".repeat(32)
  const job = jobFor(js, spec, run, ofSeed, limitsFor(45000))
  assert.equal(job.key, js.gameKey(run, seed))
  assert.equal(job.gameMs, 4 * 45000 + 600000)
  const used = [...new Set(ofSeed.flatMap((g) => g.decks!))]
  assert.deepEqual(job.decks!.map((d) => d.metadata.name), used.map((i) => lists[i]!.metadata.name))
  for (const [n, g] of job.games.entries()) {
    assert.deepEqual(g.decks!.map((i) => job.decks![i]!.metadata.name), ofSeed[n]!.decks!.map((i) => lists[i]!.metadata.name))
  }
  assert.doesNotThrow(() => checkJob(JSON.parse(JSON.stringify(job)), bundles))
  const plain = jobFor(js, { bundles: bundleOf, decks: null }, null, buildSchedule(js, { bots: spec.bots, gamesPerPair: 2, decks: null }, 9).slice(0, 1), limitsFor(45000))
  assert.equal(plain.key, null)
  assert.ok(!("decks" in plain) && !("decks" in plain.games[0]!))
  assert.doesNotThrow(() => checkJob(JSON.parse(JSON.stringify(plain)), bundles))
  assert.throws(() => jobFor(js, spec, run, [games[0]!, games[2]!], limitsFor(45000)))
})
