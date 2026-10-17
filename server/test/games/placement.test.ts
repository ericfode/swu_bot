import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { Effect } from "effect"
import { readConfig, TIMING } from "../../src/games/Config.ts"
import type { GamesConfig } from "../../src/games/Config.ts"
import { PlayFailed } from "../../src/games/Executor.ts"
import { checkPlan, checkRound, GamesctlFailed } from "../../src/games/Gamesctl.ts"
import type { GamesctlService } from "../../src/games/Gamesctl.ts"
import { loadArenaJs } from "../../src/games/Js.ts"
import { makeProc } from "../../src/games/Proc.ts"
import { playRound } from "../../src/games/Round.ts"
import type { RoundDeps } from "../../src/games/Round.ts"
import { buildSchedule, keyId, roundSeed, runKey } from "../../src/games/Schedule.ts"
import { Store } from "../../src/games/Store.ts"
import type { StoreService } from "../../src/games/Store.ts"
import type { PlaySeedJob, Played, RoundSpec } from "../../src/games/Types.ts"

const repo = path.resolve(import.meta.dirname, "..", "..", "..")
const js = loadArenaJs(repo)
const root = mkdtempSync(path.join(tmpdir(), "games-placement-"))
after(() => rmSync(root, { recursive: true, force: true }))
const secret = "6".repeat(64)
const sha = (s: string) => createHash("sha256").update(s).digest("hex")
const bots = ["a-v1", "new-v1", "b-v1", "c-v1", "d-v1"]
const placement = { version: "new-v1", ref: "window:s1" }
const decks = ["deck-a", "deck-b", "deck-c"].map((name) => ({ metadata: { name } }))
const specOf = (change: Partial<RoundSpec> = {}): RoundSpec => ({
  round: 1, bots, gamesPerPair: 4, capMs: 20000, placement,
  decks: { file: "test.json", sha256: sha("test decks"), names: decks.map((d) => d.metadata.name), deal: "seat", skipped: [], lists: decks },
  bundles: Object.fromEntries(bots.map((b) => [b, sha(b)])),
  botInfo: Object.fromEntries(bots.map((b) => [b, { kind: "arena", lang: "wasm" }])),
  ...change
})
const newData = (): GamesConfig => readConfig({
  GAMES_DATA: mkdtempSync(path.join(root, "data-")), GAMES_APP: repo, GAMES_PLACEMENT_MODE: "immediate"
}, { ...TIMING, laneTickMs: 1, publishMs: 60000 })
const readLadder = (c: GamesConfig, k: number) => JSON.parse(readFileSync(path.join(c.paths.results, `arena-r${k}`, "ladder.json"), "utf8"))
const withStore = <A>(c: GamesConfig, f: (store: StoreService) => Effect.Effect<A>) => Effect.runPromise(
  Effect.gen(function*() { return yield* f(yield* Store) }).pipe(Effect.provide(Store.layerFile(c.paths.db)))
)

/** Pure fixture results: this test never starts the submitted bundle or a real game. */
const played = (job: PlaySeedJob, ms = 1, outcome: "won" | "STEP_CAP" = "won"): Played => ({
  results: job.games.map((g) => ({
    id: g.id,
    result: {
      seed: job.seed, outcome, winner: outcome === "won" ? g.p1 : null, winnerSeat: outcome === "won" ? "p1" as const : null,
      round: 3, steps: 12, ms, key: job.key, by: null, faultKind: null
    }
  })),
  replays: Object.fromEntries(job.games.map((g) => [g.id, [
    { t: "header", v: 1, seed: job.seed, players: [{ id: "p1", bot: g.p1 }, { id: "p2", bot: g.p2 }] },
    { t: "end", winner: outcome === "won" ? "p1" : null, round: 3, steps: 12, outcome, error: null, by: null, faultKind: null }
  ].map((v) => `${JSON.stringify(v)}\n`).join("")]))
})
const fakeGamesctl = (spec: (placementRequested?: boolean) => RoundSpec) => {
  const calls = { round: 0, publish: 0, placement: [] as Array<boolean | undefined> }
  const no = Effect.die(new Error("unexpected gamesctl command"))
  const gamesctl: GamesctlService = {
    setup: no, warm: no, plan: () => no, decks: () => no, intake: () => no, push: () => no,
    round: (k, _games, _capMs, placementRequested) => Effect.sync(() => {
      calls.round++
      calls.placement.push(placementRequested)
      return { ...spec(placementRequested), round: k }
    }),
    publish: () => Effect.sync(() => { calls.publish++ })
  }
  return { gamesctl, calls }
}
const deps = (config: GamesConfig, store: StoreService, gamesctl: GamesctlService, play: NonNullable<RoundDeps["play"]>, workers = 2): RoundDeps => ({
  config, store, gamesctl, play, proc: makeProc(config), js, board: null, secret, boot: "placement-test",
  settings: () => ({ gamesPerPair: 4, thinkCapSec: 20, workers, roundGapMin: 240 })
})

test("placement mode is opt in and rejects unknown mode names", () => {
  assert.equal(readConfig({}).placementMode, "cycle")
  assert.equal(readConfig({ GAMES_PLACEMENT_MODE: "immediate" }).placementMode, "immediate")
  assert.throws(() => readConfig({ GAMES_PLACEMENT_MODE: "instant" }), /GAMES_PLACEMENT_MODE/)
  assert.deepEqual(checkPlan({ round: 1, resume: false, why: "placement" }), { round: 1, resume: false, why: "placement" })
})

test("placement round validation bounds untrusted schedules to one admitted version and four opponents", () => {
  assert.deepEqual(checkRound(1, specOf()).placement, placement)
  const invalid: Array<Record<string, unknown>> = [
    { placement: null },
    { placement: {} },
    { placement: { version: "missing-v1", ref: placement.ref } },
    { placement: { version: "../new-v1", ref: placement.ref } },
    { placement: { version: placement.version, ref: "" } },
    { placement: { version: placement.version, ref: 1 } },
    { placement: { version: placement.version, ref: "submission-1" } },
    { placement: { version: placement.version, ref: `window:${"x".repeat(300)}` } },
    { gamesPerPair: 3 },
    { gamesPerPair: 11 },
    { gamesPerPair: 100 },
    { bots: [...bots, "e-v1"], bundles: { ...specOf().bundles, "e-v1": sha("e-v1") } }
  ]
  for (const change of invalid) assert.throws(() => checkRound(1, { ...specOf(), ...change }), GamesctlFailed, JSON.stringify(change))
  const { placement: _placement, ...ordinary } = specOf({ gamesPerPair: 100 })
  assert.equal(checkRound(1, ordinary).gamesPerPair, 100, "ordinary round limits are unchanged")
})

test("placement filters the existing dealt schedule, with both seats and a maximum of forty games", () => {
  const spec = specOf({ gamesPerPair: 10 })
  const first = 1234
  const { placement: _placement, ...ordinary } = spec
  const full = buildSchedule(js, ordinary, first)
  const games = buildSchedule(js, spec, first)
  assert.equal(full.length, 100)
  assert.equal(games.length, 40)
  assert.deepEqual(games, full.filter((g) => g.p1 === placement.version || g.p2 === placement.version))
  assert.equal(new Set(games.map((g) => g.id)).size, games.length)
  for (const opponent of bots.filter((b) => b !== placement.version)) {
    assert.equal(games.filter((g) => g.p1 === placement.version && g.p2 === opponent).length, 5)
    assert.equal(games.filter((g) => g.p2 === placement.version && g.p1 === opponent).length, 5)
  }
})

test("placement completes through the normal worker limit and publishes its exact progress", async () => {
  const c = newData()
  const { gamesctl, calls } = fakeGamesctl(() => specOf())
  const jobs: Array<PlaySeedJob> = []
  let active = 0
  let maximum = 0
  const play: NonNullable<RoundDeps["play"]> = (job) => Effect.gen(function*() {
    jobs.push(job)
    active += job.games.length
    maximum = Math.max(maximum, active)
    yield* Effect.sleep(1)
    active -= job.games.length
    return played(job)
  })
  const result = await withStore(c, (store) => playRound(deps(c, store, gamesctl, play), 1, "placement", false))
  assert.deepEqual(result, { kind: "done" })
  assert.deepEqual(calls.placement, [true], "a fresh placement explicitly requests the queued placement spec")
  const expected = buildSchedule(js, specOf(), roundSeed(secret, 1))
  assert.deepEqual(jobs.flatMap((j) => j.games.map((g) => g.id)).sort(), expected.map((g) => g.id).sort())
  assert.ok(maximum > 0 && maximum <= 2, `only configured worker slots may run: ${maximum}`)
  const ladder = readLadder(c, 1)
  assert.equal(ladder.status, "done")
  assert.deepEqual(ladder.config.placement, placement)
  assert.deepEqual(ladder.progress, { scheduled: 16, finished: 16, rated: 16, outcomes: { won: 16 } })
  assert.equal(ladder.games.length, 16)
  assert.equal(new Set(ladder.games.map((g: any) => g.id)).size, 16)
  assert.ok(calls.publish >= 2)
  assert.equal((await withStore(c, (store) => store.round(1)))?.state, "done")
})

test("an ordinary round stored before its result files exist resumes without taking a queued placement", async () => {
  const c = newData()
  const k = 4
  const { placement: _placement, ...ordinary } = specOf({ round: k })
  const firstSeed = roundSeed(secret, k)
  const schedule = buildSchedule(js, ordinary, firstSeed)
  await withStore(c, (store) => store.createRound({
    k, arena: "open", spec: ordinary, firstSeed, keyId: keyId(runKey(secret, k)), workers: 2,
    state: "playing", boot: "earlier-boot", attempts: 0, why: "changed", createdAt: "2026-10-17T00:00:00.000Z", endedAt: null
  }, schedule.map((g, ord) => ({
    id: g.id, ord, seed: g.seed, p1: g.p1, p2: g.p2, decks: g.decks ?? null,
    state: "todo", host: null, result: null, key: null, endedAt: null
  }))))
  assert.equal(existsSync(path.join(c.paths.results, `arena-r${k}`)), false, "only the durable ordinary round exists")
  const { gamesctl, calls } = fakeGamesctl((placementRequested) => placementRequested ? specOf() : ordinary)
  const jobs: Array<PlaySeedJob> = []
  const play: NonNullable<RoundDeps["play"]> = (job) => Effect.sync(() => { jobs.push(job); return played(job) })
  assert.deepEqual(await withStore(c, (store) => playRound(deps(c, store, gamesctl, play), k, "resume", true)), { kind: "done" })
  assert.deepEqual(calls.placement, [false], "ordinary DB-only resume must decline the queued placement")
  assert.deepEqual((await withStore(c, (store) => store.round(k)))?.spec, ordinary)
  const ladder = readLadder(c, k)
  assert.equal(ladder.config.placement, undefined)
  assert.equal(ladder.progress.scheduled, 40)
  assert.deepEqual(jobs.flatMap((j) => j.games.map((g) => g.id)).sort(), schedule.map((g) => g.id).sort())
})

test("interrupted placement resumes its frozen spec and never replays finished games after another submission", async () => {
  const c = newData()
  let spec = specOf()
  const { gamesctl, calls } = fakeGamesctl(() => spec)
  const firstJobs: Array<PlaySeedJob> = []
  const cut: NonNullable<RoundDeps["play"]> = (job) => Effect.suspend(() => {
    firstJobs.push(job)
    return firstJobs.length === 2 ? Effect.fail(new PlayFailed(job.seed, "shutdown", true)) : Effect.succeed(played(job, 5))
  })
  assert.deepEqual(await withStore(c, (store) => playRound(deps(c, store, gamesctl, cut, 1), 2, "placement", false)), { kind: "stopped" })
  const before = readLadder(c, 2)
  const finished = before.games.filter((g: any) => g.outcome !== "running")
  assert.equal(finished.length, 1)
  assert.equal(before.progress.scheduled, 16)

  // Another accepted version and changed live settings must not replace the saved placement job.
  spec = specOf({ bots: ["new-v2", "a-v1"], gamesPerPair: 10, capMs: 30000, placement: { version: "new-v2", ref: "window:s2" }, bundles: { "new-v2": sha("new-v2"), "a-v1": sha("a-v1") } })
  const rest: Array<PlaySeedJob> = []
  const resume: NonNullable<RoundDeps["play"]> = (job) => Effect.sync(() => { rest.push(job); return played(job, 6) })
  assert.deepEqual(await withStore(c, (store) => playRound(deps(c, store, gamesctl, resume, 1), 2, "resume", true)), { kind: "done" })
  assert.equal(calls.round, 1, "retry uses the stored placement, without asking for the current lineup")
  assert.equal(rest.flatMap((j) => j.games).length, 15)
  assert.ok(rest.every((j) => j.capMs === 20000 && !j.bots["new-v2"]))
  assert.ok(rest.flatMap((j) => j.games).every((g) => !finished.some((f: any) => f.id === g.id)))
  const after = readLadder(c, 2)
  assert.deepEqual(after.config.placement, placement)
  assert.deepEqual(after.config.bots, bots)
  assert.equal(after.progress.finished, 16)
  assert.deepEqual(after.games.filter((g: any) => g.ms === 5).map((g: any) => g.id), finished.map((g: any) => g.id))

  const repeated: Array<PlaySeedJob> = []
  const noReplay: NonNullable<RoundDeps["play"]> = (job) => Effect.sync(() => { repeated.push(job); return played(job) })
  assert.deepEqual(await withStore(c, (store) => playRound(deps(c, store, gamesctl, noReplay), 2, "resume", true)), { kind: "done" })
  assert.equal(repeated.length, 0, "a completed placement retry creates no duplicate jobs")
})

test("unrated placement outcomes finish the battle set without inventing wins or rating changes", async () => {
  const c = newData()
  const { gamesctl } = fakeGamesctl(() => specOf())
  const play: NonNullable<RoundDeps["play"]> = (job) => Effect.succeed(played(job, 1, "STEP_CAP"))
  assert.deepEqual(await withStore(c, (store) => playRound(deps(c, store, gamesctl, play), 3, "placement", false)), { kind: "done" })
  const ladder = readLadder(c, 3)
  assert.deepEqual(ladder.progress, { scheduled: 16, finished: 16, rated: 0, outcomes: { STEP_CAP: 16 } })
  assert.deepEqual(ladder.eloHistory, [])
  for (const bot of ladder.bots) {
    assert.equal(bot.wins + bot.losses + bot.draws, 0)
    assert.equal(bot.winRate, null)
    assert.equal(bot.elo, 1500)
    assert.equal(bot.btElo, 1500)
  }
})
