// Trusted controller/process fixtures and inert bundles only; no submitted bot executes.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { Effect } from "effect"
import { readConfig, TIMING } from "../../src/games/Config.ts"
import { bindComparison, bundlesForSeats } from "../../src/games/Comparison.ts"
import { makeGamesctl } from "../../src/games/Gamesctl.ts"
import { loadArenaJs } from "../../src/games/Js.ts"
import type { ProcService, RunOptions } from "../../src/games/Proc.ts"
import { playRound } from "../../src/games/Round.ts"
import { buildSchedule, choosePlacementSeed, keyId, roundSeed, runKey } from "../../src/games/Schedule.ts"
import { Store } from "../../src/games/Store.ts"
import type { StoreService } from "../../src/games/Store.ts"
import type { PlaySeedJob, Played, RoundSpec } from "../../src/games/Types.ts"

const root = mkdtempSync(path.join(tmpdir(), "v2-resume-context-"))
after(() => rmSync(root, { recursive: true, force: true }))
const repo = path.resolve(import.meta.dirname, "..", "..", "..")
const js = loadArenaJs(repo)
const { bundleDigest } = createRequire(import.meta.url)("../../../bot/arena/compatibility.js")
const secret = "6".repeat(64)
const imageIdentity = (name: string, fallback: string) => existsSync(path.join(repo, name)) ? readFileSync(path.join(repo, name), "utf8").trim() : fallback
const build = imageIdentity("BUILD_SHA", "a".repeat(40)), cards = imageIdentity("CARDS_SHA", "b".repeat(64))
assert.match(build, /^[0-9a-f]{40}$/)
assert.match(cards, /^[0-9a-f]{64}$/)
const withStore = <A>(db: string, f: (store: StoreService) => Effect.Effect<A>) => Effect.runPromise(
  Effect.gen(function*() { return yield* f(yield* Store) }).pipe(Effect.provide(Store.layerFile(db)))
)

function fixture() {
  const dir = mkdtempSync(path.join(root, "case-"))
  const config = readConfig({ GAMES_DATA: dir, GAMES_APP: repo, ARENA_ID: "v2", GAMES_BUILD: build, GAMES_CARDS: cards,
    GAMES_PLACEMENT_MODE: "immediate" }, { ...TIMING, laneTickMs: 1, publishMs: 60000 })
  const bots = ["new-v1", "house-v1"]
  const folders = Object.fromEntries(bots.map((name) => {
    const folder = path.join(dir, name)
    mkdirSync(folder)
    writeFileSync(path.join(folder, "arena.json"), JSON.stringify({ schema: "swu-arena-bot/1", protocol: 2,
      kind: "wasm", platform: "wasm32-wasip1", runtime: "wasi-p1", run: { cmd: "./bot.wasm" } }))
    writeFileSync(path.join(folder, "bot.wasm"), Buffer.from("0061736d0100000001040160000003020100070a01065f737461727400000a040102000b", "hex"))
    writeFileSync(path.join(folder, "fixture.txt"), `inert trusted fixture ${name}`)
    return [name, folder]
  }))
  const actualBundles = () => Object.fromEntries(bots.map((name) => [name, bundleDigest(folders[name])]))
  mkdirSync(config.paths.bundles, { recursive: true })
  for (const name of bots) {
    const packed = spawnSync('python3', ['-I', path.join(repo, 'bot/compiled/bundle.py'), 'tar', folders[name]!])
    assert.equal(packed.status, 0)
    writeFileSync(path.join(config.paths.bundles, `${actualBundles()[name]}.tar`), packed.stdout)
  }
  const baseSeed = roundSeed(secret, 2, "v2")
  const spec: RoundSpec = { round: 2, requiredProtocol: 2, context: config.context!, bots, bundles: actualBundles(), decks: null,
    botInfo: {}, gamesPerPair: 2, capMs: 20000,
    placement: { version: bots[0]!, ref: "window:fixture", adaptive: true, excludedSeeds: [baseSeed] } }
  const firstSeed = choosePlacementSeed(baseSeed, [baseSeed])
  const row = { k: 2, arena: "v2", spec, firstSeed, keyId: keyId(runKey(secret, 2, "v2")), workers: 1,
    state: "playing" as const, boot: "original", attempts: 1, why: "placement", createdAt: "2026-10-17T00:00:00Z", endedAt: null }
  const schedule = buildSchedule(js, spec, firstSeed)
  let verifications = 0
  const proc = { isStopping: () => false, run: (options: RunOptions) => Effect.sync(() => {
    if (options.argv.includes("verify-round")) {
      verifications++
      assert.equal(options.as, "root")
      assert.equal(options.isolate, true)
      assert.equal(options.env.ARENA_ID, "v2")
      assert.equal(options.argv[options.argv.indexOf("--bots") + 1], bots.join(","))
      return { kind: "exit" as const, code: 0, stdout: JSON.stringify({ round: 2, bots, requiredProtocol: 2,
        context: config.context, bundles: actualBundles() }) }
    }
    assert.ok(options.argv.includes("publish"), "a resume never selects or reserves a new lineup")
    return { kind: "exit" as const, code: 0, stdout: JSON.stringify({ ok: true }) }
  }) } as unknown as ProcService
  const gamesctl = makeGamesctl(config, proc, "resume")
  const jobs: Array<PlaySeedJob> = []
  const play = (job: PlaySeedJob) => Effect.sync((): Played => {
    jobs.push(job)
    assert.equal(job.seed, firstSeed)
    assert.deepEqual(job.context, spec.context)
    const results = job.games.map((game) => {
      const result = { seed: job.seed, outcome: "won" as const, winner: game.p1, winnerSeat: "p1" as const,
        by: null, faultKind: null, round: 1, steps: 1, ms: 1, requiredProtocol: 2 as const, protocols: { p1: 2, p2: 2 } }
      const replay = JSON.stringify({ t: "end", ...result }) + "\n"
      return { id: game.id, ...bindComparison(result, replay, spec.context!, bundlesForSeats(spec.bundles, game)) }
    })
    return { results: results.map(({ id, result }) => ({ id, result })), replays: Object.fromEntries(results.map(({ id, replay }) => [id, replay!])) }
  })
  const initialize = () => withStore(config.paths.db, (store) => store.createRound(row, schedule.map((game, ord) => ({
    ...game, ord, decks: null, state: "todo", host: null, result: null, key: null, endedAt: null
  }))))
  const run = (current = config) => withStore(config.paths.db, (store) => playRound({ config: current, store, proc, gamesctl, js,
    board: null, secret, boot: "resume", settings: () => ({ gamesPerPair: 10, thinkCapSec: 30, workers: 1, roundGapMin: 0 }), play }, 2, "resume", true))
  return { config, spec, row, folders, jobs, initialize, run, verifications: () => verifications }
}

test("stored adaptive v2 placement verifies final canonical bundles before mutating or dispatching", async () => {
  const f = fixture()
  await f.initialize()
  const before = await withStore(f.config.paths.db, (store) => store.games(2))
  writeFileSync(path.join(f.folders["new-v1"]!, "fixture.txt"), "changed inert execution bytes")
  const result = await f.run()
  assert.ok(result.kind === "failed" && /bundle digest/.test(result.why))
  assert.equal(f.verifications(), 1)
  assert.equal(f.jobs.length, 0)
  assert.deepEqual(await withStore(f.config.paths.db, (store) => store.round(2)), f.row)
  assert.deepEqual(await withStore(f.config.paths.db, (store) => store.games(2)), before)
})

test("stale image context refuses the stored placement before any Node verification or DB mutation", async () => {
  const f = fixture()
  await f.initialize()
  const changedImage = mkdtempSync(path.join(root, "changed-image-"))
  writeFileSync(path.join(changedImage, "BUILD_SHA"), build === "c".repeat(40) ? "e".repeat(40) : "c".repeat(40))
  writeFileSync(path.join(changedImage, "CARDS_SHA"), cards)
  const changed = readConfig({ GAMES_DATA: f.config.data, GAMES_APP: changedImage, ARENA_ID: "v2" })
  const result = await f.run(changed)
  assert.ok(result.kind === "failed" && /context/.test(result.why))
  assert.equal(f.verifications(), 0)
  assert.equal(f.jobs.length, 0)
  assert.deepEqual(await withStore(f.config.paths.db, (store) => store.round(2)), f.row)
})

test("matching adaptive placement resumes its frozen seed and preserves comparison evidence", async () => {
  const f = fixture()
  await f.initialize()
  assert.deepEqual(await f.run(), { kind: "done" })
  assert.equal(f.verifications(), 1)
  const doc = JSON.parse(readFileSync(path.join(f.config.paths.results, "arena-v2-r2", "ladder.json"), "utf8"))
  assert.deepEqual(doc.config.placement, f.spec.placement)
  assert.deepEqual(doc.config.context, f.spec.context)
  assert.deepEqual(doc.config.bundles, f.spec.bundles)
  assert.equal(doc.config.capMs, f.spec.capMs, "changed live settings never replace the frozen placement rules")
  assert.equal(f.jobs.length, 2)
  assert.ok(doc.games.every((g: any) => g.protocols.p1 === 2 && g.protocols.p2 === 2 && g.context.engineRevision === f.spec.context!.engineRevision))
  assert.deepEqual(await f.run(), { kind: "done" })
  assert.equal(f.verifications(), 2, "even a completed placement rehashes immutable versions before republishing")
  assert.equal(f.jobs.length, 2, "finished games are preserved")
})
