// Adapted from the placement task's portable boundary fixtures. No submitted bot executes.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { Effect } from "effect"
import type { ComparisonContext } from "../../src/games/Comparison.ts"
import { contextFor } from "../../src/games/Comparison.ts"
import { loadArenaJs } from "../../src/games/Js.ts"
import { ladderConfig } from "../../src/games/Results.ts"
import { compareGame, readRound, runReplay } from "../../src/games/Replay.ts"
import { buildSchedule } from "../../src/games/Schedule.ts"

const repo = path.resolve(import.meta.dirname, "..", "..", "..")
const imageIdentity = (name: string, fallback: string) => existsSync(path.join(repo, name)) ? readFileSync(path.join(repo, name), "utf8").trim() : fallback
const build = imageIdentity("BUILD_SHA", "b".repeat(40)), cards = imageIdentity("CARDS_SHA", "c".repeat(64))
assert.match(build, /^[0-9a-f]{40}$/)
assert.match(cards, /^[0-9a-f]{64}$/)
const context = contextFor({ arenaId: "v2", build, cards })!
const root = mkdtempSync(path.join(tmpdir(), "v2-replay-context-"))
after(() => rmSync(root, { recursive: true, force: true }))
const js = loadArenaJs(repo)
const bots = ["alice-v1", "house-v1"]
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const limits = { maxSteps: 100, capMs: 20000, hangMs: 30000, gameMs: 680000 }

test("legacy replay compares recorded evidence without requiring newly added observations", () => {
  const entry = { outcome: "won", winner: "alice-v1", winnerSeat: "p1", by: null, faultKind: null, rounds: 1, steps: 2 }
  const result = { ...entry, round: 1 }
  const end = { t: "end", outcome: "won", winner: "p1", by: null, faultKind: null, round: 1, steps: 2 }
  const text = (value: unknown) => JSON.stringify(value) + "\n"
  for (const protocols of [{}, { p1: 1, p2: 1 }]) {
    const observations = { protocols, context, bundles: { "alice-v1": "a".repeat(64) } }
    assert.deepEqual(compareGame("legacy", entry, { ...result, ...observations }, text(end), text({ ...end, ...observations }), null), [])
  }
  for (const field of ["protocols", "context", "bundles"] as const) {
    const differences = compareGame("legacy", { ...entry, [field]: { recorded: true } }, { ...result, [field]: { changed: true } },
      text({ ...end, [field]: { recorded: true } }), text({ ...end, [field]: { changed: true } }), null)
    assert.ok(differences.some((d) => d.field === field), field)
    assert.ok(differences.some((d) => d.field === "replay"), field)
  }
  const strict = { requiredProtocol: 2, protocols: { p1: 2, p2: 2 }, context, bundles: { "alice-v1": "a".repeat(64) } }
  const differences = compareGame("v2", { ...entry, requiredProtocol: 2 }, { ...result, ...strict },
    text({ ...end, requiredProtocol: 2 }), text({ ...end, ...strict }), null)
  for (const field of ["protocols", "context", "bundles", "replay"]) assert.ok(differences.some((d) => d.field === field), field)
  assert.ok(compareGame("v2", entry, { ...result, ...strict }, text(end), text({ ...end, ...strict }), null).some((d) => d.field === "requiredProtocol"))
})

function fixture(adaptive = false) {
  const dir = mkdtempSync(path.join(root, "case-"))
  const results = path.join(dir, "recorded"), bundlesDir = path.join(dir, "bundles")
  mkdirSync(path.join(results, "games"), { recursive: true })
  mkdirSync(bundlesDir)
  const tar = (label: string) => {
    const folder = mkdtempSync(path.join(dir, "inert-bundle-"))
    writeFileSync(path.join(folder, "bot.wasm"), Buffer.from("0061736d0100000001040160000003020100070a01065f737461727400000a040102000b", "hex"))
    writeFileSync(path.join(folder, "fixture.txt"), label)
    writeFileSync(path.join(folder, "arena.json"), JSON.stringify({ schema: "swu-arena-bot/1", protocol: 2,
      kind: "wasm", platform: "wasm32-wasip1", runtime: "wasi-p1", run: { cmd: "./bot.wasm" } }))
    const packed = spawnSync("python3", ["-I", path.join(repo, "bot/compiled/bundle.py"), "tar", folder], { maxBuffer: 1 << 20 })
    assert.equal(packed.status, 0, String(packed.stderr))
    const digest = sha(packed.stdout)
    writeFileSync(path.join(bundlesDir, `${digest}.tar`), packed.stdout)
    return digest
  }
  const bundles = Object.fromEntries(bots.map((bot) => [bot, tar(bot)]))
  const placement = adaptive ? { version: bots[0]!, ref: "window:adaptive-context", adaptive: true as const, excludedSeeds: [40, 41] } : undefined
  const spec = { requiredProtocol: 2 as const, context, round: 0, bots, gamesPerPair: 2, capMs: 20000, decks: null, bundles, botInfo: {}, ...(placement ? { placement } : {}) }
  const config: Record<string, any> = { arena: "v2", requiredProtocol: 2, context: structuredClone(context), bundles: { ...bundles },
    ...(placement ? { placement } : {}), bots, gamesPerPair: 2, firstSeed: 42, maxSteps: 100, capMs: 20000, hangMs: 30000, record: true, key: "a".repeat(32), keyId: "a".repeat(12) }
  const games = buildSchedule(js, spec, 42).map((g) => ({ ...g, outcome: "won", winner: "draw", winnerSeat: "draw", rounds: 1, steps: 1, ms: 1,
    by: null, faultKind: null, key: js.gameKey(config.key, g.seed), requiredProtocol: 2, protocols: { p1: 2, p2: 2 }, context: structuredClone(context), bundles: { ...bundles } }))
  const replay = (g: { seed: number; p1: string; p2: string }, key: string | null) => [
    { t: "header", v: 1, seed: g.seed, requiredProtocol: 2, players: [{ id: "p1", bot: g.p1 }, { id: "p2", bot: g.p2 }] },
    { t: "end", winner: "draw", outcome: "won", round: 1, steps: 1, by: null, faultKind: null, key,
      requiredProtocol: 2, protocols: { p1: 2, p2: 2 }, context: structuredClone(context), bundles: { ...bundles } }
  ].map((line) => JSON.stringify(line)).join("\n") + "\n"
  for (const g of games) writeFileSync(path.join(results, "games", `${g.id}.jsonl`), replay(g, g.key))
  const doc = { id: "arena-v2-r0", status: "done", config, games }
  const names = path.join(dir, "names.json")
  writeFileSync(names, JSON.stringify(bundles))
  const write = () => writeFileSync(path.join(results, "ladder.json"), JSON.stringify(doc))
  write()
  return { dir, results, bundlesDir, bundles, spec, doc, names, write, tar, replay }
}

test("round publication and recorded replay preserve exact arena context and final bundle identities", () => {
  const f = fixture(true)
  const config = ladderConfig({ spec: f.spec, arena: "v2", firstSeed: 42, workers: 1, limits, keyId: "a".repeat(12) })
  assert.deepEqual(config.placement, f.spec.placement)
  assert.deepEqual(config.context, context)
  assert.deepEqual(config.bundles, f.bundles)
  const recorded = readRound({ ...f.doc, config: { ...config, key: "a".repeat(32) } })
  assert.equal(recorded.arena, "v2")
  assert.equal(recorded.requiredProtocol, 2)
  assert.deepEqual(recorded.placement, f.spec.placement)
  assert.deepEqual(recorded.context, context)
  assert.deepEqual(recorded.bundles, f.bundles)
})

async function refusedBeforePlay(f: ReturnType<typeof fixture>) {
  f.write()
  const original = readFileSync(path.join(f.results, "ladder.json")), out = path.join(f.dir, "out")
  let plays = 0
  const printed: Array<Record<string, any>> = []
  const code = await Effect.runPromise(runReplay(["--results", f.results, "--bundles", f.bundlesDir, "--names", f.names, "--out", out], {
    env: { ARENA_ID: "v2", GAMES_APP: repo, GAMES_DATA: path.join(f.dir, "data"), GAMES_BUILD: build, GAMES_CARDS: cards },
    print: (line) => printed.push(JSON.parse(line)), note: () => {},
    play: () => Effect.sync(() => { plays++; throw new Error("a refused replay must not call even a fake game runner") }),
    loadDecks: () => assert.fail("these metadata-only fixtures never load engine card data")
  }))
  assert.equal(code, 2, JSON.stringify(printed))
  assert.equal(plays, 0)
  assert.equal(printed.at(-1)?.ok, false)
  assert.deepEqual(readFileSync(path.join(f.results, "ladder.json")), original)
  assert.equal(existsSync(path.join(out, "games")), false)
}

test("selected v2 replay refuses legacy arena with omitted policy before dispatch", async () => {
  const f = fixture()
  f.doc.id = "arena-r0"
  f.doc.config.arena = "open"
  delete f.doc.config.requiredProtocol
  delete f.doc.config.context
  await refusedBeforePlay(f)
})

test("selected v2 replay requires the v2 arena identity independently of explicit v2 policy", async () => {
  const f = fixture()
  f.doc.config.arena = "open"
  await refusedBeforePlay(f)
})

for (const [name, changed] of [
  ["old image/engine", contextFor({ arenaId: "v2", build: build === "a".repeat(40) ? "d".repeat(40) : "a".repeat(40), cards })],
  ["changed card catalog", contextFor({ arenaId: "v2", build, cards: cards === "a".repeat(64) ? "d".repeat(64) : "a".repeat(64) })]
] as const) test(`v2 replay refuses ${name} context before execution`, async () => {
  const f = fixture()
  f.doc.config.context = changed as ComparisonContext
  await refusedBeforePlay(f)
})

test("v2 replay refuses different valid tar bytes than the recorded final bundle", async () => {
  const f = fixture(), changed = f.tar("changed-version")
  writeFileSync(f.names, JSON.stringify({ ...f.bundles, [bots[0]!]: changed }))
  await refusedBeforePlay(f)
})

test("matching adaptive placement context and original final bundles replay through the fake runner", async () => {
  const f = fixture(true), out = path.join(f.dir, "out")
  let plays = 0
  const printed: Array<Record<string, any>> = []
  const code = await Effect.runPromise(runReplay(["--results", f.results, "--bundles", f.bundlesDir, "--names", f.names, "--out", out], {
    env: { ARENA_ID: "v2", GAMES_APP: repo, GAMES_DATA: path.join(f.dir, "data"), GAMES_BUILD: build, GAMES_CARDS: cards },
    print: (line) => printed.push(JSON.parse(line)), note: () => {},
    play: (job) => Effect.sync(() => {
      plays++
      return { results: job.games.map((g) => ({ id: g.id, result: { seed: job.seed, outcome: "won" as const, winner: "draw",
        winnerSeat: "draw" as const, round: 1, steps: 1, ms: 1, by: null, faultKind: null, ...(job.key ? { key: job.key } : {}),
        requiredProtocol: 2 as const, protocols: { p1: 2, p2: 2 }, context: structuredClone(context), bundles: { ...f.bundles } } })),
      replays: Object.fromEntries(job.games.map((g) => [g.id, f.replay({ ...g, seed: job.seed }, job.key)])) }
    }), loadDecks: () => assert.fail("no engine/card data needed by this fixture")
  }))
  assert.equal(code, 0, JSON.stringify(printed))
  assert.equal(plays, 1)
  assert.deepEqual(printed.at(-1), { ok: true, games: 2, same: 2, different: [], missing: [] })
})
