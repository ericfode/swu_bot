import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { test } from "node:test"
import { checkDecks, checkRound } from "../../src/games/Gamesctl.ts"
import { loadArenaJs } from "../../src/games/Js.ts"
import { readRound, roundDecks } from "../../src/games/Replay.ts"
import { deckRule, ladderConfig } from "../../src/games/Results.ts"
import { buildSchedule, jobFor } from "../../src/games/Schedule.ts"
import { limitsFor, type RoundSpec } from "../../src/games/Types.ts"

const app = path.resolve(import.meta.dirname, "../../..")
const require = createRequire(import.meta.url)
const choices = require(path.join(app, "bot/arena/deck-choice.js"))
const js = loadArenaJs(app)
const lists = ["default0", "default1", "chosen"].map((name, i) => ({ metadata: { name }, leader: { id: `SOR_00${5 + i}`, count: 1 }, base: { id: "SOR_029", count: 1 }, deck: [] }))
const spec: RoundSpec = { round: 2, bots: ["a-v1", "b-v1"], gamesPerPair: 2, capMs: 45000,
  bundles: { "a-v1": "a".repeat(64), "b-v1": "b".repeat(64) }, botInfo: {},
  decks: { file: "deck.json", sha256: "c".repeat(64), names: lists.map((d) => d.metadata.name), deal: "seat", skipped: [], lists, poolSize: 2, choices: { "a-v1": 2 } } }

test("selected deck survives schedule, remapped jobs, publication and frozen replay config", () => {
  const validated = checkRound(2, spec)
  const games = buildSchedule(js, validated, 17)
  assert.equal(games.length, 2)
  const job = jobFor(js, validated, "k".repeat(32), games, limitsFor(45000))
  for (const g of job.games) {
    const seat = g.p1 === "a-v1" ? 0 : 1
    assert.deepEqual(job.decks![g.decks![seat]], lists[2])
  }
  const frozen = { schema: choices.SCHEMA, sha256: choices.digest(lists[2]), list: lists[2] }
  const { checkChosenDecks } = require(path.join(app, "bot/arena/play-seed.js"))
  assert.doesNotThrow(() => checkChosenDecks(job, { "a-v1": frozen }))
  const config = { ...ladderConfig({ spec: validated, arena: "open", firstSeed: 17, workers: 1, limits: limitsFor(45000), keyId: null }), key: "k".repeat(32) }
  const recorded = readRound({ config, games: [] })
  assert.deepEqual(recorded.decks?.choices, spec.decks!.choices)
  assert.deepEqual(recorded.decks?.lists, lists)
  assert.equal(recorded.decks?.poolSize, 2)
  const loaded = { decks: lists.slice(0, 2), sha256: spec.decks!.sha256 }
  assert.deepEqual(roundDecks(recorded.decks!, loaded), spec.decks)
  assert.throws(() => roundDecks(recorded.decks!, { ...loaded, decks: [{ ...lists[0]!, base: { id: "SOR_030" } }, lists[1]!] }), /default deck pool differs/)
  assert.notDeepEqual(deckRule({ ...spec.decks!, choices: { "a-v1": 0 } }), deckRule(spec.decks), "a changed choice cannot match a stored round")
})

test("invalid or foreign selected indices fail closed and default metadata stays unchanged", () => {
  for (const patch of [{ choices: { "a-v1": -1 } }, { choices: { "a-v1": 3 } }, { poolSize: 0 }, { poolSize: 4 }]) {
    assert.throws(() => checkDecks({ ...spec.decks, ...patch }), /selected deck/)
  }
  assert.throws(() => checkRound(2, { ...spec, decks: { ...spec.decks, choices: { "foreign-v1": 0 } } }), /outside this round/)
  const { choices: _choices, poolSize: _poolSize, ...plain } = spec.decks!
  assert.deepEqual(deckRule(plain), { file: plain.file, sha256: plain.sha256, names: plain.names, deal: "seat" })
  assert.ok(!Object.hasOwn(checkRound(2, { ...spec, decks: plain }).decks!, "choices"))
})
