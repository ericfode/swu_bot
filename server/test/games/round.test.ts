import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"
import { after, test } from "node:test"
import { Effect, Fiber } from "effect"
import { readConfig, TIMING } from "../../src/games/Config.ts"
import type { GamesConfig } from "../../src/games/Config.ts"
import { bindComparison, bundlesForSeats, bundlesOfJob } from "../../src/games/Comparison.ts"
import { PlayFailed } from "../../src/games/Executor.ts"
import type { GamesctlService } from "../../src/games/Gamesctl.ts"
import { loadArenaJs } from "../../src/games/Js.ts"
import type { LaneDeps, LaneResult } from "../../src/games/Lane.ts"
import { makeLane } from "../../src/games/Lane.ts"
import * as Log from "../../src/games/Log.ts"
import { makeProc } from "../../src/games/Proc.ts"
import { playRound } from "../../src/games/Round.ts"
import type { RoundDeps } from "../../src/games/Round.ts"
import { buildSchedule, keyId, roundSeed, runKey } from "../../src/games/Schedule.ts"
import { Store } from "../../src/games/Store.ts"
import type { StoreService } from "../../src/games/Store.ts"
import type { LeaseBoard, PlaySeedJob, Played, RoundSpec, ScheduledGame } from "../../src/games/Types.ts"
import { limitsFor } from "../../src/games/Types.ts"

const repo = path.resolve(import.meta.dirname, "..", "..", "..")
const js = loadArenaJs(repo)
const require = createRequire(path.join(repo, "bot", "package.json"))
const { normalizeDeck } = require(path.join(repo, "bot", "decklists.js"))
const { checkJob } = require(path.join(repo, "bot", "arena", "play-seed.js"))
const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex")

// as root, games run as the bots' user inside isolate.sh, which puts the job's own folder in place of /tmp
const root = mkdtempSync(path.join(process.getuid?.() === 0 && existsSync("/var/tmp") ? "/var/tmp" : tmpdir(), "games-round-"))
chmodSync(root, 0o755)
after(() => rmSync(root, { recursive: true, force: true }))
const lines: Array<string> = []
Log.setSink((l) => lines.push(l))

const SECRET = "5".repeat(64)
const DECK_FILE = path.join(repo, "bot", "decks", "ash-meta-2026-09.json")
const SKIP = ["lando-calrissian_law_blue"]
const lists = JSON.parse(readFileSync(DECK_FILE, "utf8")).map(normalizeDeck).filter((l: any) => !SKIP.includes(l.metadata.name))
const DECKS = { file: "ash-meta-2026-09.json", sha256: sha(readFileSync(DECK_FILE)), names: lists.map((l: any) => l.metadata.name), deal: "seat" as const, skipped: SKIP, lists }
const BOTS = ["a-v1", "b-v2", "c-v1"]
const specOf = (bots = BOTS, change: Partial<RoundSpec> = {}): RoundSpec => ({
  round: 0, bots, gamesPerPair: 2, capMs: 20000, decks: DECKS,
  bundles: Object.fromEntries(bots.map((b) => [b, sha(b)])),
  botInfo: Object.fromEntries(bots.map((b) => [b, { kind: "arena", lang: "wasm" }])),
  ...change
})

const configIn = (dir: string): GamesConfig => readConfig({ GAMES_DATA: dir, GAMES_APP: repo }, { ...TIMING, laneTickMs: 20, publishMs: 100 })
const newData = () => {
  const dir = mkdtempSync(path.join(root, "data-"))
  chmodSync(dir, 0o755)
  return configIn(dir)
}

const fakeGamesctl = (spec: () => RoundSpec) => {
  const calls = { round: 0, publish: 0 }
  const no = Effect.die(new Error("not in this test"))
  const gamesctl: GamesctlService = {
    setup: no, warm: no, plan: () => no, decks: () => no, intake: () => no, push: () => no,
    round: (k) => Effect.sync(() => {
      calls.round++
      return { ...spec(), round: k }
    }),
    publish: () => Effect.sync(() => {
      calls.publish++
    })
  }
  return { gamesctl, calls }
}

const line = (o: unknown) => `${JSON.stringify(o)}\n`
/** A game as play-seed reports it (p1 wins), its replay naming the job's deck lists. */
const playedGame = (job: PlaySeedJob, i: number, ms: number) => {
  const g = job.games[i]!
  const deckOf = (n: 0 | 1) => (g.decks && job.decks ? job.decks[g.decks[n]] : undefined)
  return {
    result: {
      seed: job.seed, steps: 10 + i, outcome: "won" as const, winner: g.p1, winnerSeat: "p1" as const, round: 3, ms, ...(job.key ? { key: job.key } : {}),
      by: null, faultKind: null, botStats: [null, null], timing: { p1: { n: 1, ms: 1, p50: 1, p95: 1, max: 1 }, p2: { n: 1, ms: 1, p50: 1, p95: 1, max: 1 } },
      think: { p1: 1, p2: 2 }
    },
    replay: line({
      t: "header", v: 1, seed: job.seed, engine: null,
      players: [{ id: "p1", bot: g.p1, deck: deckOf(0)?.metadata.name }, { id: "p2", bot: g.p2, deck: deckOf(1)?.metadata.name }],
      ...(g.decks ? { decks: { p1: deckOf(0), p2: deckOf(1) } } : {})
    }) + line({ t: "step", n: 0, label: "Game start" }) +
      line({ t: "end", winner: "p1", round: 3, steps: 10 + i, outcome: "won", error: null, by: null, faultKind: null })
  }
}
const playedJob = (job: PlaySeedJob, ms = 5): Played => ({
  results: job.games.map((g, i) => ({ id: g.id, result: playedGame(job, i, ms).result })),
  replays: Object.fromEntries(job.games.map((g, i) => [g.id, playedGame(job, i, ms).replay]))
})

/** A fake executor: plays at once (or as `act` says), keeping every job it was given. */
const fakePlay = (act: (job: PlaySeedJob, n: number) => Effect.Effect<Played, PlayFailed> = (job) => Effect.succeed(playedJob(job))) => {
  const jobs: Array<PlaySeedJob> = []
  const play = (job: PlaySeedJob) => Effect.suspend(() => {
    jobs.push(job)
    return act(job, jobs.length)
  })
  return { jobs, play }
}

const withStore = <A>(c: GamesConfig, f: (store: StoreService) => Effect.Effect<A>) =>
  Effect.runPromise(Effect.gen(function*() {
    return yield* f(yield* Store)
  }).pipe(Effect.provide(Store.layerFile(c.paths.db))))

const deps = (c: GamesConfig, store: StoreService, o: {
  gamesctl: GamesctlService
  play?: RoundDeps["play"]
  board?: LeaseBoard | null
  workers?: number
}): RoundDeps => ({
  config: c, store, proc: makeProc(c), gamesctl: o.gamesctl, js, board: o.board ?? null, secret: SECRET, boot: "b1",
  settings: () => ({ gamesPerPair: 2, thinkCapSec: 20, workers: o.workers ?? 2, roundGapMin: 0 }),
  ...(o.play ? { play: o.play } : {})
})

const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8"))
const endOf = (f: string) => JSON.parse(readFileSync(f, "utf8").trimEnd().split("\n").at(-1)!)

test("v2 round: starts clean, propagates strict policy, preserves negotiation evidence and refuses legacy resume", async () => {
  const legacy = newData()
  const c = readConfig({ GAMES_DATA: legacy.data, GAMES_APP: repo, ARENA_ID: "v2", GAMES_BUILD: "a".repeat(40), GAMES_CARDS: "b".repeat(64) }, { ...TIMING, laneTickMs: 20, publishMs: 100 })
  const spec = specOf(["a-v1", "b-v1"], { requiredProtocol: 2, context: c.context!, decks: null })
  const { gamesctl } = fakeGamesctl(() => spec)
  const strictPlay = fakePlay((job) => {
    assert.equal(job.requiredProtocol, 2)
    const played = playedJob(job)
    const protocols = { p1: 2, p2: 2 }
    const protocolPlayed = {
      results: played.results.map((e) => ({ ...e, result: { ...e.result, requiredProtocol: 2 as const, protocols } })),
      replays: Object.fromEntries(Object.entries(played.replays).map(([id, text]) => [id, text.trimEnd().split("\n").map((l) => {
        const e = JSON.parse(l)
        return JSON.stringify(e.t === "end" ? { ...e, requiredProtocol: 2, protocols } : e)
      }).join("\n") + "\n"]))
    }
    const bound = protocolPlayed.results.map((e) => ({ id: e.id, ...bindComparison(e.result, protocolPlayed.replays[e.id], c.context!, bundlesForSeats(bundlesOfJob(job), job.games.find((g) => g.id === e.id)!)) }))
    return Effect.succeed({ results: bound.map((e) => ({ id: e.id, result: e.result })), replays: Object.fromEntries(bound.flatMap((e) => e.replay === null ? [] : [[e.id, e.replay]])) })
  })
  const dir = path.join(c.paths.results, "arena-v2-r0")
  mkdirSync(dir, { recursive: true })
  // Even a finished legacy-looking result file in the new folder is never imported.
  writeFileSync(path.join(dir, "ladder.json"), JSON.stringify({ config: {}, games: [{ id: "legacy", outcome: "won" }] }))
  assert.deepEqual(await withStore(c, (store) => playRound(deps(c, store, { gamesctl, play: strictPlay.play }), 0, "changed", false)), { kind: "done" })
  const ladder = readJson(path.join(dir, "ladder.json"))
  assert.equal(ladder.config.arena, "v2")
  assert.equal(ladder.config.requiredProtocol, 2)
  assert.equal(strictPlay.jobs.flatMap((j) => j.games).length, 2)
  assert.ok(ladder.games.every((g: any) => g.requiredProtocol === 2 && g.protocols.p1 === 2 && g.protocols.p2 === 2))
  assert.equal((await withStore(c, (store) => store.round(0)))?.arena, "v2")
  for (const g of ladder.games) {
    const f = path.join(dir, "games", `${g.id}.jsonl`)
    writeFileSync(`${f}.gz`, gzipSync(readFileSync(f)))
    rmSync(f)
  }
  const noPlay = fakePlay(() => Effect.die(new Error("verified games should resume")))
  assert.deepEqual(await withStore(c, (store) => playRound(deps(c, store, { gamesctl, play: noPlay.play }), 0, "resume", true)), { kind: "done" })
  assert.equal(noPlay.jobs.length, 0)
  // Corrupting a seat's persisted replay evidence invalidates the resume, even when its result claims v2.
  const replay = path.join(dir, "games", `${ladder.games[0].id}.jsonl`)
  const validReplay = gunzipSync(readFileSync(path.join(dir, "games", `${ladder.games[0].id}.jsonl.gz`))).toString("utf8")
  writeFileSync(replay, validReplay.replace('"protocols":{"p1":2,"p2":2}', '"protocols":{"p1":1,"p2":2}'))
  const before = strictPlay.jobs.length
  const refused = await withStore(c, (store) => playRound(deps(c, store, { gamesctl, play: strictPlay.play }), 0, "resume", true))
  assert.ok(refused.kind === "failed" && /evidence/.test(refused.why))
  assert.equal(strictPlay.jobs.length, before)
})

test("v2 round: missing required policy or successful seat negotiation evidence fails closed", async () => {
  const legacy = newData()
  const c = readConfig({ GAMES_DATA: legacy.data, GAMES_APP: repo, ARENA_ID: "v2", GAMES_BUILD: "a".repeat(40), GAMES_CARDS: "b".repeat(64) }, { ...TIMING, laneTickMs: 20, publishMs: 100 })
  const play = fakePlay()
  const old = fakeGamesctl(() => specOf(["a-v1", "b-v1"], { decks: null }))
  const refused = await withStore(c, (store) => playRound(deps(c, store, { gamesctl: old.gamesctl, play: play.play }), 0, "changed", false))
  assert.equal(refused.kind, "failed")
  assert.equal(play.jobs.length, 0)
  const strict = fakeGamesctl(() => specOf(["a-v1", "b-v1"], { requiredProtocol: 2, context: c.context!, decks: null }))
  const missing = await withStore(c, (store) => playRound(deps(c, store, { gamesctl: strict.gamesctl, play: play.play }), 0, "changed", false))
  assert.equal(missing.kind, "failed")
  assert.ok(missing.kind === "failed" && /requiredProtocol/.test(missing.why))
})

test("v2 reserved round: stale image/card context or changed bundle digest never dispatches or mutates its reservation", async () => {
  const legacy = newData()
  const c = readConfig({ GAMES_DATA: legacy.data, GAMES_APP: repo, ARENA_ID: "v2", GAMES_BUILD: "a".repeat(40), GAMES_CARDS: "b".repeat(64) })
  const spec = specOf(["a-v1", "b-v1"], { requiredProtocol: 2, context: c.context!, decks: null })
  const row = { k: 0, arena: "v2", spec, firstSeed: roundSeed(SECRET, 0, "v2"), keyId: keyId(runKey(SECRET, 0, "v2")), workers: 1,
    state: "playing" as const, boot: "reserved", attempts: 0, why: "changed", createdAt: "2026-10-17T00:00:00Z", endedAt: null }
  await withStore(c, (store) => store.createRound(row, []))
  const play = fakePlay(() => Effect.die(new Error("a stale reservation must not play")))
  const { gamesctl, calls } = fakeGamesctl(() => spec)
  for (const overrides of [{ GAMES_BUILD: "c".repeat(40), GAMES_CARDS: c.cards }, { GAMES_BUILD: c.build, GAMES_CARDS: "d".repeat(64) }]) {
    const changed = readConfig({ GAMES_DATA: c.data, GAMES_APP: repo, ARENA_ID: "v2", ...overrides })
    const outcome = await withStore(c, (store) => playRound(deps(changed, store, { gamesctl, play: play.play }), 0, "resume", true))
    assert.ok(outcome.kind === "failed" && /context/.test(outcome.why))
  }
  assert.equal(calls.round, 0, "context is checked before the Node round has side effects")
  const replacement = fakeGamesctl(() => ({ ...spec, bundles: { ...spec.bundles, "a-v1": "e".repeat(64) } }))
  const outcome = await withStore(c, (store) => playRound(deps(c, store, { gamesctl: replacement.gamesctl, play: play.play }), 0, "resume", true))
  assert.ok(outcome.kind === "failed" && /bundle digest/.test(outcome.why))
  assert.equal(play.jobs.length, 0)
  assert.deepEqual(await withStore(c, (store) => store.round(0)), row)
})

test("round: schedule, entries and config as ladder.js made them for a lineup of deck lists; keys out once done", async () => {
  const c = newData()
  const { gamesctl, calls } = fakeGamesctl(() => specOf())
  const { jobs, play } = fakePlay()
  const outcome = await withStore(c, (store) => playRound(deps(c, store, { gamesctl, play }), 4, "changed", false))
  assert.deepEqual(outcome, { kind: "done" })
  const first = roundSeed(SECRET, 4)
  const key = runKey(SECRET, 4)
  // ladder.js: roundRobin of the lineup, the lists dealt by seat, ids <p1>-vs-<p2>-<seed>
  const want = js.dealDecks(js.roundRobin(BOTS, 2, first), lists.length, first, { by: "seat" }).map((s) => ({ ...s, id: `${s.p1}-vs-${s.p2}-${s.seed}` }))
  const dir = path.join(c.paths.results, "arena-r4")
  const index = readJson(path.join(dir, "index.json"))
  const ladder = readJson(path.join(dir, "ladder.json"))
  assert.deepEqual(Object.keys(index), ["id", "createdAt", "engine", "bots", "gamesPerPairing", "games"])
  assert.equal(index.id, "arena-r4")
  assert.equal(index.engine, null)
  assert.deepEqual(index.bots, BOTS)
  assert.equal(index.gamesPerPairing, 2)
  assert.deepEqual(index.games.map((g: any) => g.id), want.map((g) => g.id))
  assert.deepEqual(index.games.map((g: any) => [g.decks.p1, g.decks.p2]), want.map((g) => [lists[g.decks[0]].metadata.name, lists[g.decks[1]].metadata.name]))
  assert.deepEqual(Object.keys(index.games[0]), ["id", "seed", "p1", "p2", "winner", "winnerSeat", "outcome", "rounds", "steps", "ms", "error", "by", "faultKind", "host", "decks", "timing", "key"])
  assert.deepEqual(Object.keys(ladder.games[0]), ["id", "seed", "p1", "p2", "winner", "winnerSeat", "outcome", "rounds", "steps", "ms", "error", "by", "faultKind", "host", "decks", "timing", "think", "botStats", "key"])
  // ladder.js main's config, field by field, in its order
  assert.equal(JSON.stringify(ladder.config), JSON.stringify({
    bots: BOTS, gamesPerPair: 2, firstSeed: first, maxSteps: 6000, workers: 2, capMs: 20000, hangMs: 70000, harness: null, engineDiff: null,
    programs: null, keyId: keyId(key), record: true,
    decks: { file: "ash-meta-2026-09.json", sha256: DECKS.sha256, names: DECKS.names, deal: "seat", skipped: SKIP }, key
  }))
  assert.equal(ladder.schema, "swu-ladder/1")
  assert.equal(ladder.status, "done")
  assert.equal(ladder.progress.scheduled, 6)
  assert.equal(ladder.progress.finished, 6)
  assert.ok(!("remote" in ladder), "no helper node: no remote")
  // each job is one seed's games with that seed's game key, and play-seed takes it as it is
  const bundles = mkdtempSync(path.join(root, "bundles-"))
  for (const b of BOTS) writeFileSync(path.join(bundles, `${sha(b)}.tar`), "")
  assert.equal(jobs.length, 3)
  for (const job of jobs) {
    assert.equal(job.key, js.gameKey(key, job.seed))
    assert.deepEqual([job.capMs, job.hangMs, job.gameMs, job.maxSteps], [20000, 70000, 680000, 6000])
    assert.doesNotThrow(() => checkJob(JSON.parse(JSON.stringify(job)), bundles))
  }
  for (const g of index.games) {
    assert.equal(g.key, js.gameKey(key, g.seed))
    assert.equal(endOf(path.join(dir, "games", `${g.id}.jsonl`)).key, g.key)
  }
  assert.ok(!existsSync(path.join(dir, "referee.lock")))
  assert.ok(calls.publish >= 2, "published at the start and at the end")
  const row = await withStore(c, (store) => store.round(4))
  assert.equal(row?.state, "done")
  assert.equal(row?.keyId, keyId(key))
})

test("round: a stopped round keeps its finished games, and goes on from them; other rules start it over", async () => {
  const c = newData()
  const { gamesctl } = fakeGamesctl(() => specOf())
  // the second job meets a machine that stops
  const cut = fakePlay((job, n) => (n === 2 ? Effect.fail(new PlayFailed(job.seed, "shutdown", true)) : Effect.succeed(playedJob(job, 5))))
  const first = await withStore(c, (store) => playRound(deps(c, store, { gamesctl, play: cut.play }), 5, "changed", false))
  assert.deepEqual(first, { kind: "stopped" })
  const dir = path.join(c.paths.results, "arena-r5")
  assert.ok(!existsSync(path.join(dir, "referee.lock")), "the lock goes")
  const index = readJson(path.join(dir, "index.json"))
  const done = index.games.filter((g: any) => g.outcome !== "running")
  assert.equal(done.length, 2)
  assert.ok(done.every((g: any) => g.key), "the first seed is whole: its key is out")
  const row = await withStore(c, (store) => store.round(5))
  assert.equal(row?.state, "playing")

  const rest = fakePlay((job) => Effect.succeed(playedJob(job, 6)))
  const second = await withStore(c, (store) => playRound(deps(c, store, { gamesctl, play: rest.play }), 5, "resume", true))
  assert.deepEqual(second, { kind: "done" })
  assert.equal(rest.jobs.flatMap((j) => j.games).length, 4, "only the games not played yet")
  const after1 = readJson(path.join(dir, "ladder.json"))
  assert.equal(after1.games.length, 6)
  assert.deepEqual(after1.games.filter((g: any) => g.ms === 5).map((g: any) => g.id).sort(), done.map((g: any) => g.id).sort())
  assert.ok(lines.some((l) => /arena-r5: resuming, 2 games already played/.test(l)))

  // the time limit changed since: the round starts over, every game again
  const { gamesctl: other } = fakeGamesctl(() => specOf(BOTS, { capMs: 30000 }))
  const again = fakePlay((job) => Effect.succeed(playedJob(job, 7)))
  const third = await withStore(c, (store) => playRound(deps(c, store, { gamesctl: other, play: again.play }), 5, "resume", true))
  assert.deepEqual(third, { kind: "done" })
  assert.equal(again.jobs.flatMap((j) => j.games).length, 6)
  const after2 = readJson(path.join(dir, "ladder.json"))
  assert.deepEqual([after2.config.capMs, after2.config.hangMs], [30000, 90000])
  assert.ok(after2.games.every((g: any) => g.ms === 7))
  const row2 = await withStore(c, (store) => store.round(5))
  assert.equal(row2?.spec.capMs, 30000)
})

test("round: a ladder.json the old coordinator's ladder left keeps its finished games when it is the same round", async () => {
  const c = newData()
  const k = 6
  const spec = specOf()
  const first = roundSeed(SECRET, k)
  const key = runKey(SECRET, k)
  const games = buildSchedule(js, spec, first)
  const dir = path.join(c.paths.results, `arena-r${k}`)
  mkdirSync(path.join(dir, "games"), { recursive: true })
  const names = (g: ScheduledGame) => ({ p1: lists[g.decks![0]].metadata.name, p2: lists[g.decks![1]].metadata.name })
  const entry = (g: ScheduledGame, change: Record<string, unknown>) => ({
    id: g.id, seed: g.seed, p1: g.p1, p2: g.p2, winner: g.p2, winnerSeat: "p2", outcome: "won", rounds: 6, steps: 77, ms: 900, error: null,
    by: null, faultKind: null, host: null, decks: names(g), timing: null, think: { p1: 3, p2: 4 }, botStats: [null, null], ...change
  })
  const ladderConfig = {
    bots: BOTS, gamesPerPair: 2, firstSeed: first, maxSteps: 6000, workers: 3, capMs: 20000, hangMs: 70000, harness: null, engineDiff: null,
    programs: null, keyId: keyId(key), record: true, decks: { file: "ash-meta-2026-09.json", sha256: DECKS.sha256, names: DECKS.names, deal: "seat", skipped: SKIP }
  }
  const [a1, a2, b1, b2] = games as [ScheduledGame, ScheduledGame, ScheduledGame, ScheduledGame]
  const gk = (g: ScheduledGame) => js.gameKey(key, g.seed)
  writeFileSync(path.join(dir, "ladder.json"), JSON.stringify({
    schema: "swu-ladder/1", id: `arena-r${k}`, status: "running", createdAt: "2026-10-14T10:00:00.000Z", updatedAt: "2026-10-14T10:30:00.000Z",
    engine: null, config: ladderConfig,
    games: [entry(a1, { key: gk(a1) }), entry(a2, { key: gk(a2) }), entry(b1, { host: "eric" }), entry(b2, { outcome: "running", winner: null, winnerSeat: null })]
  }))
  const oldReplay = (g: ScheduledGame, withKey: boolean) =>
    line({ t: "header", v: 1, seed: g.seed, players: [{ id: "p1", bot: g.p1 }, { id: "p2", bot: g.p2 }] }) +
    line({ t: "end", winner: "p2", round: 6, steps: 77, outcome: "won", error: null, by: null, faultKind: null, ...(withKey ? { key: gk(g) } : {}) })
  for (const [g, withKey] of [[a1, true], [a2, true], [b1, false]] as const) writeFileSync(path.join(dir, "games", `${g.id}.jsonl`), oldReplay(g, withKey))

  const { gamesctl } = fakeGamesctl(() => spec)
  const { jobs, play } = fakePlay()
  const outcome = await withStore(c, (store) => playRound(deps(c, store, { gamesctl, play }), k, "resume", true))
  assert.deepEqual(outcome, { kind: "done" })
  assert.deepEqual(jobs.flatMap((j) => j.games.map((g) => g.id)), [b2.id, ...games.slice(4).map((g) => g.id)])
  const index = readJson(path.join(dir, "index.json"))
  assert.equal(index.createdAt, "2026-10-14T10:00:00.000Z")
  // the kept games first, in the old ladder's order, as they were
  assert.deepEqual(index.games.slice(0, 3).map((g: any) => [g.id, g.steps, g.host]), [[a1.id, 77, null], [a2.id, 77, null], [b1.id, 77, "eric"]])
  // b1's seed is whole now: its key went out into its old replay too
  assert.equal(endOf(path.join(dir, "games", `${b1.id}.jsonl`)).key, gk(b1))
  assert.ok(index.games.every((g: any) => g.key === gk(g)))

  // another round's ladder.json (another key) is not taken: every game plays
  const c2 = newData()
  const dir2 = path.join(c2.paths.results, `arena-r${k}`)
  mkdirSync(dir2, { recursive: true })
  writeFileSync(path.join(dir2, "ladder.json"), JSON.stringify({ config: { ...ladderConfig, keyId: "000000000000" }, games: [entry(a1, {})] }))
  const all = fakePlay()
  assert.deepEqual(await withStore(c2, (store) => playRound(deps(c2, store, { gamesctl, play: all.play }), k, "resume", true)), { kind: "done" })
  assert.equal(all.jobs.flatMap((j) => j.games).length, 6)
})

test("round: a seed's key goes into its entries and replays only once every game of the seed has ended", async () => {
  const c = newData()
  const { gamesctl } = fakeGamesctl(() => specOf(["a-v1", "b-v2"]))
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  let waiting = false
  const { play } = fakePlay((job, n) =>
    n === 1 ? Effect.succeed(playedJob(job)) : Effect.promise(async () => {
      waiting = true
      await gate
      return playedJob(job)
    }))
  const dir = path.join(c.paths.results, "arena-r8")
  const outcome = await withStore(c, (store) =>
    Effect.gen(function*() {
      // one game at a time: the seed's two games go in two jobs
      const fiber = yield* Effect.forkChild(playRound(deps(c, store, { gamesctl, play, workers: 1 }), 8, "changed", false))
      for (let i = 0; i < 500 && !waiting; i++) yield* Effect.sleep(10)
      assert.ok(waiting)
      const index = readJson(path.join(dir, "index.json"))
      const [g1, g2] = index.games
      assert.equal(g1.outcome, "won")
      assert.ok(!("key" in g1), "no key while its twin plays")
      assert.equal(g2.outcome, "running")
      assert.ok(!("key" in endOf(path.join(dir, "games", `${g1.id}.jsonl`))))
      assert.ok(existsSync(path.join(dir, "referee.lock")), "the lock is there while it plays")
      release()
      return yield* Fiber.join(fiber)
    }))
  assert.deepEqual(outcome, { kind: "done" })
  const index = readJson(path.join(dir, "index.json"))
  assert.ok(index.games.every((g: any) => g.key && endOf(path.join(dir, "games", `${g.id}.jsonl`)).key === g.key))
})

test("round: interrupted, the files stay whole, the lock goes and the row stays playing", async () => {
  const c = newData()
  const { gamesctl } = fakeGamesctl(() => specOf())
  const { play } = fakePlay((job, n) => (n === 1 ? Effect.succeed(playedJob(job)) : Effect.never))
  const dir = path.join(c.paths.results, "arena-r9")
  await withStore(c, (store) =>
    Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(playRound(deps(c, store, { gamesctl, play }), 9, "changed", false))
      for (let i = 0; i < 500 && !existsSync(path.join(dir, "index.json")); i++) yield* Effect.sleep(10)
      yield* Effect.sleep(100)
      yield* Fiber.interrupt(fiber)
      assert.equal((yield* store.round(9))?.state, "playing")
      assert.equal((yield* store.games(9)).filter((g) => g.state === "done").length, 2)
    }))
  assert.ok(!existsSync(path.join(dir, "referee.lock")))
  assert.equal(readJson(path.join(dir, "ladder.json")).status, "running")
})

test("round: a job that fails is played again once; failing twice fails the round", async () => {
  const c = newData()
  const { gamesctl } = fakeGamesctl(() => specOf(["a-v1", "b-v2"]))
  const once = fakePlay((job, n) => (n === 1 ? Effect.fail(new PlayFailed(job.seed, "play-seed exited 1")) : Effect.succeed(playedJob(job))))
  assert.deepEqual(await withStore(c, (store) => playRound(deps(c, store, { gamesctl, play: once.play }), 1, "changed", false)), { kind: "done" })
  assert.equal(once.jobs.length, 2)
  const c2 = newData()
  const twice = fakePlay((job) => Effect.fail(new PlayFailed(job.seed, "play-seed exited 1")))
  const out = await withStore(c2, (store) => playRound(deps(c2, store, { gamesctl, play: twice.play }), 1, "changed", false))
  assert.equal(out.kind, "failed")
  assert.match((out as { why: string }).why, /failed twice \(play-seed exited 1\)/)
})

// ---------------------------------------------------------------------------------------------------------------------
// The lane with a fake lease board (remote-lane.test.js's cases, the relay now in this process)

interface FakeLease { state: "running" | "done" | "lost"; host: string; ageMs: number; job: PlaySeedJob; results?: unknown; replays?: unknown; reason?: string }
const fakeBoard = (o: { missing?: ReadonlyArray<string> } = {}) => {
  let waiting = 0
  let n = 0
  const leases = new Map<string, FakeLease>()
  const offers: Array<{ job: PlaySeedJob; bundles: ReadonlyArray<string> }> = []
  const revoked: Array<string> = []
  const board: LeaseBoard = {
    status: () => ({ waiting, hosts: n || waiting ? ["eric"] : [] }),
    offer: (job, bundles) => {
      const missing = bundles.filter((b) => o.missing?.includes(b))
      if (missing.length) return { kind: "missing", missing }
      if (waiting <= 0) return { kind: "none" }
      waiting--
      const id = `L${++n}`
      offers.push({ job, bundles })
      leases.set(id, { state: "running", host: "eric", ageMs: 0, job })
      return { kind: "leased", lease: id, host: "eric" }
    },
    lease: (id) => {
      const l = leases.get(id)
      if (!l) return { state: "unknown" }
      if (l.state === "running") return { state: "running", host: l.host, ageMs: l.ageMs }
      leases.delete(id)
      return l.state === "done"
        ? { state: "done", host: l.host, results: l.results, replays: l.replays }
        : { state: "lost", host: l.host, reason: l.reason ?? "" }
    },
    revoke: (id) => {
      revoked.push(id)
      leases.delete(id)
    },
    reset: () => leases.clear()
  }
  const finish = (id: string, change: (p: Played) => unknown = (p) => p) => {
    const l = leases.get(id)!
    const p = change(playedJob(l.job, 1000)) as Played
    Object.assign(l, { state: "done", results: p.results, replays: p.replays })
  }
  return { board, offers, revoked, leases, claim: (k = 1) => (waiting += k), finish }
}

const LIMITS = limitsFor(60000)
const RUN = "r".repeat(32)
const laneFor = (o: {
  bots?: ReadonlyArray<string>
  decks?: boolean
  board?: LeaseBoard | null
  workers?: number
  play?: LaneDeps["play"]
}) => {
  const bots = o.bots ?? ["a-v1", "b-v1", "c-v1"]
  const spec = specOf([...bots], o.decks ? {} : { decks: null })
  const schedule = buildSchedule(js, spec, 100)
  const started: Array<string> = []
  const results: Array<{ x: LaneResult; host: string | null }> = []
  const logs: Array<string> = []
  const deps: LaneDeps = {
    js, spec, runKey: RUN, limits: LIMITS, board: o.board ?? null, tickMs: 10, workers: () => o.workers ?? 1,
    play: o.play ?? ((job) => Effect.succeed(playedJob(job))),
    tag: (seed) => `t-${seed}`,
    onStart: (games) => Effect.sync(() => started.push(...games.map((g) => g.id))),
    onResults: (done, host) => Effect.sync(() => results.push(...done.map((x) => ({ x, host })))),
    log: (m) => logs.push(m)
  }
  return { schedule, lane: makeLane(deps, schedule), started, results, logs }
}
/** Local games that wait until `open()`: helpers get a chance at the queue while the slot here is busy. */
const gated = () => {
  let open: () => void = () => {}
  const gate = new Promise<void>((r) => (open = r))
  return { open: () => open(), play: (job: PlaySeedJob) => Effect.promise(() => gate.then(() => playedJob(job, 2000))) }
}
const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 5))
  assert.ok(cond(), what)
}

test("lane: an accepted offer goes out whole with the seed's game key and deck lists; its done lease is checked and recorded", async () => {
  const fb = fakeBoard()
  fb.claim()
  const local = gated()
  const { lane, results, started, schedule } = laneFor({ board: fb.board, decks: true, play: local.play })
  const running = Effect.runPromise(lane.run)
  await until(() => fb.offers.length === 1, "offered")
  const { job, bundles } = fb.offers[0]!
  // the first look comes before anything plays here: the lowest seed goes out
  assert.equal(job.seed, 100)
  assert.equal(job.key, js.gameKey(RUN, 100))
  assert.deepEqual(job.games.map((g) => g.id), schedule.slice(0, 2).map((g) => g.id))
  assert.deepEqual(job.decks!.map((d) => d.metadata.name), [...new Set(schedule.slice(0, 2).flatMap((g) => g.decks!))].map((i) => lists[i].metadata.name))
  assert.deepEqual([...bundles].sort(), [sha("a-v1"), sha("b-v1")].sort())
  assert.ok(started.includes(schedule[0]!.id))
  fb.finish("L1")
  local.open()
  assert.deepEqual(await running, { kind: "done" })
  assert.deepEqual(results.filter((r) => r.host === "eric").map((r) => r.x.game.id), schedule.slice(0, 2).map((g) => g.id))
  assert.equal(results.length, 6)
  const stats = lane.stats()!
  assert.deepEqual([stats.lane, stats.hosts, stats.leased, stats.played, stats.lost, stats.relayErrors, stats.stopped], [true, ["eric"], 1, 2, 0, [], null])
  assert.ok(stats.claimLooks >= 1 && stats.looks >= stats.claimLooks)
})

test("lane: with no helper waiting everything plays here; the stats say so", async () => {
  const fb = fakeBoard()
  const { lane, results } = laneFor({ board: fb.board, workers: 2 })
  assert.deepEqual(await Effect.runPromise(lane.run), { kind: "done" })
  assert.ok(results.every((r) => r.host === null))
  const s = lane.stats()!
  assert.deepEqual([s.hosts, s.claimLooks, s.leased, s.played], [[], 0, 0, 0])
  assert.ok(s.looks >= 1)
  assert.equal(laneFor({}).lane.stats(), null, "no board: no stats")
})

test("lane: a lost lease plays here and its seed never goes out again; an unknown one too", async () => {
  const fb = fakeBoard()
  fb.claim()
  const local = gated()
  const { lane, logs, results } = laneFor({ board: fb.board, play: local.play })
  const running = Effect.runPromise(lane.run)
  await until(() => fb.offers.length === 1, "offered")
  Object.assign(fb.leases.get("L1")!, { state: "lost", reason: "no heartbeat" })
  await until(() => logs.some((l) => /lease L1 \(seed 100, eric\) lost: no heartbeat; playing it here/.test(l)), "lost")
  // a new claim: seed 100 is not offered again, another is
  fb.claim()
  await until(() => fb.offers.length === 2, "offered again")
  assert.notEqual(fb.offers[1]!.job.seed, 100)
  fb.leases.delete("L2")
  await until(() => logs.some((l) => /lease L2 .* lost: the lease board does not know it/.test(l)), "unknown")
  local.open()
  assert.deepEqual(await Effect.runPromise(Effect.promise(() => running)), { kind: "done" })
  assert.ok(results.every((r) => r.host === null))
  assert.equal(lane.stats()!.lost, 2)
  assert.match(lane.stats()!.lastLost!, /^eric: the lease board does not know it/)
})

test("lane: an invalid result loses the whole lease; nothing of it is recorded", async () => {
  const fb = fakeBoard()
  fb.claim()
  const local = gated()
  const { lane, logs, results } = laneFor({ board: fb.board, play: local.play })
  const running = Effect.runPromise(lane.run)
  await until(() => fb.offers.length === 1, "offered")
  fb.finish("L1", (p) => ({ ...p, results: p.results.map((e, i) => (i === 1 ? { ...e, result: { ...e.result, winner: "a-v1" } } : e)) }))
  local.open()
  assert.deepEqual(await running, { kind: "done" })
  assert.ok(logs.some((l) => /lost: invalid result: b-v1-vs-a-v1-100: winner "a-v1"/.test(l)), logs.join("\n"))
  assert.ok(results.every((r) => r.host === null), "the seed played here")
})

test("lane: a lease running long once nothing is left here is taken back: 2 x the median game here + 60 s", async () => {
  const fb = fakeBoard()
  fb.claim()
  const { lane, logs, results } = laneFor({ board: fb.board, bots: ["a-v1", "b-v1"], workers: 2 })
  const running = Effect.runPromise(lane.run)
  await until(() => fb.offers.length === 1, "offered")
  // nothing ended here yet: 2 x 10 min + 60 s
  fb.leases.get("L1")!.ageMs = 1_200_000
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(fb.revoked.length, 0)
  fb.leases.get("L1")!.ageMs = 1_261_000
  assert.deepEqual(await running, { kind: "done" })
  assert.deepEqual(fb.revoked, ["L1"])
  assert.ok(logs.some((l) => /taken back after 1261 s, nothing else left to play/.test(l)))
  assert.equal(results.length, 2)
  assert.ok(results.every((r) => r.host === null))
})

test("lane: a version whose tar is missing plays here; seat twins and the fewest helper games decide what goes out", async () => {
  // c-v1's tar is gone: seeds with c-v1 never go out
  const fb = fakeBoard({ missing: [sha("c-v1")] })
  fb.claim(3)
  const local = gated()
  const { lane, logs, started, schedule } = laneFor({ board: fb.board, bots: ["a-v1", "b-v1", "c-v1", "d-v1"], play: local.play })
  const running = Effect.runPromise(lane.run)
  try {
    await until(() => fb.offers.length === 3, "offered")
    await new Promise((r) => setTimeout(r, 50))
    // seeds: 100 a-b, 101 a-c, 102 a-d, 103 b-c, 104 b-d, 105 c-d. 100 goes first (no helper games yet, lowest seed);
    // next the fewest helper games: 105 (c-d, none), refused for c-v1's tar, which ends that look; the slot here takes
    // 101's first game, so 101 no longer goes out whole; then 102 (a-d: 2) before 104 (b-d: 2, a higher seed), and
    // after it 104 (4) as the one seed left without c-v1
    assert.deepEqual(fb.offers.map((x) => x.job.seed), [100, 102, 104])
    assert.ok(fb.offers.every((x) => !x.job.games.some((g) => g.p1 === "c-v1" || g.p2 === "c-v1")))
    assert.equal(logs.filter((l) => /c-v1: its bundle is not in the bundles folder; its games play here/.test(l)).length, 1)
    assert.ok(started.includes(schedule.find((g) => g.seed === 101)!.id), "101 plays here")
    for (const id of ["L1", "L2", "L3"]) fb.finish(id)
  } finally {
    local.open()
  }
  assert.deepEqual(await running, { kind: "done" })
  assert.equal(lane.stats()!.played, 6)
})

test("lane: a seed one of whose games plays here does not go out", async () => {
  const fb = fakeBoard()
  const local = gated()
  // one slot: the head game of seed 100 plays here alone; its twin waits in the queue
  const { lane } = laneFor({ board: fb.board, bots: ["a-v1", "b-v1"], play: (job) => (job.games.length === 1 ? local.play(job) : Effect.succeed(playedJob(job))), workers: 1 })
  const sched = laneFor({ bots: ["a-v1", "b-v1"] }).schedule
  assert.equal(sched.length, 2)
  // split the seed by hand: a lane whose slot takes one game (workers 1 takes up to 1 game)
  const running = Effect.runPromise(lane.run)
  await new Promise((r) => setTimeout(r, 30))
  fb.claim()
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(fb.offers.length, 0, "its twin plays here: the seed stays")
  local.open()
  assert.deepEqual(await running, { kind: "done" })
})

test("lane: a long error is cut to 500 characters", async () => {
  const fb = fakeBoard()
  fb.claim()
  const local = gated()
  const { lane, results } = laneFor({ board: fb.board, bots: ["a-v1", "b-v1"], play: local.play })
  const running = Effect.runPromise(lane.run)
  await until(() => fb.offers.length === 1, "offered")
  fb.finish("L1", (p) => ({ ...p, results: p.results.map((e) => ({ ...e, result: { ...e.result, error: "x".repeat(900) } })) }))
  local.open()
  await running
  assert.ok(results.every((r) => r.x.result.error!.length === 500))
})

// ---------------------------------------------------------------------------------------------------------------------
// One real round: two WebAssembly versions (node-random, under two names), the tournament lists by seat, through
// play-seed, then the trace check on its replays.

const ENGINE = existsSync(path.join(repo, "forceteki", "build", "server")) && existsSync(path.join(repo, "forceteki", "test", "json"))
const NODE_RANDOM = path.join(repo, "build", "compiled", "node-random")
const WASMTIME = spawnSync("python3", ["-I", "-c", "import wasmtime"], { stdio: "ignore" }).status === 0
const real = ENGINE && WASMTIME && existsSync(path.join(NODE_RANDOM, "arena.json"))

test("round: a real round plays end to end through play-seed, and its replays pass the trace check", { skip: !real && "needs the engine, card data, wasmtime and build/compiled/node-random", timeout: 240_000 }, async () => {
  const c = newData()
  const tar = execFileSync("python3", [path.join(repo, "bot", "compiled", "bundle.py"), "tar", NODE_RANDOM], { maxBuffer: 80 << 20 })
  const hex = sha(tar)
  mkdirSync(c.paths.bundles, { recursive: true })
  writeFileSync(path.join(c.paths.bundles, `${hex}.tar`), tar)
  // as gamesctl setup leaves them: both this user's (root's on the machine) and only it writes them
  for (const d of [c.paths.home, c.paths.wasmCache]) {
    mkdirSync(d, { recursive: true })
    chmodSync(d, 0o755)
  }
  // and as gamesctl round does, the lineup is compiled into the cache first; the games (as the bots' user when this
  // runs as root) only read it
  const { SWU_WINDOW: _w, ARENA_PUSH_TOKEN: _p, SWU_WINDOW_TOKEN: _t, NODE_ENV: _n, ...env } = process.env
  const warm = spawnSync(process.execPath, [path.join(repo, "bot", "arena", "play-seed.js"), "--warm", "--bundles", c.paths.bundles, hex], { env: { ...env, SWU_WASM_CACHE: c.paths.wasmCache }, encoding: "utf8", timeout: 120_000 })
  assert.equal(warm.status, 0, warm.stderr)
  assert.deepEqual(JSON.parse(warm.stdout.trim().split("\n").pop()!).warmed, [hex])
  const bots = ["alpha-v1", "beta-v1"]
  const spec = specOf(bots, { bundles: { "alpha-v1": hex, "beta-v1": hex } })
  const { gamesctl } = fakeGamesctl(() => spec)
  const outcome = await withStore(c, (store) => playRound(deps(c, store, { gamesctl }), 2, "changed", false))
  assert.deepEqual(outcome, { kind: "done" }, lines.slice(-20).join(""))
  const dir = path.join(c.paths.results, "arena-r2")
  const index = readJson(path.join(dir, "index.json"))
  assert.equal(index.games.length, 2)
  for (const g of index.games) {
    assert.ok(["won", "STEP_CAP", "STUCK", "ERROR"].includes(g.outcome))
    assert.equal(g.key, js.gameKey(runKey(SECRET, 2), g.seed))
    const end = endOf(path.join(dir, "games", `${g.id}.jsonl`))
    assert.equal(end.key, g.key)
    assert.equal(end.outcome, g.outcome)
  }
  const cached = readdirSync(c.paths.wasmCache)
  assert.equal(cached.length, 1, `the games used what was compiled before them: ${cached}`)
  assert.equal(statSync(path.join(c.paths.wasmCache, cached[0]!)).uid, process.getuid?.())
  assert.deepEqual(readdirSync(c.paths.home), [], "the games left nothing in their HOME")
  const trace = spawnSync(process.execPath, [path.join(repo, "bot", "trace.js"), "check", path.join(dir, "games")], { cwd: repo, env, encoding: "utf8", timeout: 180_000 })
  assert.equal(trace.status, 0, `${trace.stdout}\n${trace.stderr}`)
  const left = existsSync(c.paths.work) ? readdirSync(c.paths.work).filter((f) => f.startsWith("r2-")) : []
  assert.deepEqual(left, [], "no job folder is left behind")
})
