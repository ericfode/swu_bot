// A resumed round lists its kept games in the order they started, as ladder.js did through --resume: ladder.json's
// sequential Elo and eloHistory read that order. (Found in review: games that end out of order came back by end time.)
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { Effect } from "effect"
import { readConfig, TIMING } from "../../src/games/Config.ts"
import { PlayFailed } from "../../src/games/Executor.ts"
import type { GamesctlService } from "../../src/games/Gamesctl.ts"
import { loadArenaJs } from "../../src/games/Js.ts"
import * as Log from "../../src/games/Log.ts"
import { makeProc } from "../../src/games/Proc.ts"
import { playRound } from "../../src/games/Round.ts"
import type { RoundDeps } from "../../src/games/Round.ts"
import { Store } from "../../src/games/Store.ts"
import type { StoreService } from "../../src/games/Store.ts"
import type { PlaySeedJob, Played } from "../../src/games/Types.ts"

const repo = path.resolve(import.meta.dirname, "..", "..", "..")
const js = loadArenaJs(repo)
const require = createRequire(path.join(repo, "bot", "package.json"))
const { normalizeDeck } = require(path.join(repo, "bot", "decklists.js"))
const sha = (b: string) => createHash("sha256").update(b).digest("hex")
const root = mkdtempSync(path.join(process.getuid?.() === 0 && existsSync("/var/tmp") ? "/var/tmp" : tmpdir(), "games-order-"))
chmodSync(root, 0o755)
after(() => rmSync(root, { recursive: true, force: true }))
Log.setSink(() => {})

const DECK_FILE = path.join(repo, "bot", "decks", "ash-meta-2026-09.json")
const lists = JSON.parse(readFileSync(DECK_FILE, "utf8")).map(normalizeDeck)
const BOTS = ["a-v1", "b-v2", "c-v1"]
const spec = (k: number) => ({
  round: k, bots: BOTS, gamesPerPair: 2, capMs: 20000,
  decks: { file: "ash-meta-2026-09.json", sha256: sha(readFileSync(DECK_FILE, "utf8")), names: lists.map((l: any) => l.metadata.name), deal: "seat" as const, skipped: [], lists },
  bundles: Object.fromEntries(BOTS.map((b) => [b, sha(b)])),
  botInfo: Object.fromEntries(BOTS.map((b) => [b, { kind: "arena", lang: "wasm" }]))
})
const no = Effect.die(new Error("not in this test"))
const gamesctl = {
  setup: no, warm: no, plan: () => no, decks: () => no, intake: () => no, push: () => no,
  round: (k: number) => Effect.sync(() => spec(k)), publish: () => Effect.void
} as unknown as GamesctlService
const line = (o: unknown) => `${JSON.stringify(o)}\n`
// winners vary by seed and seat, so the sequential Elo depends on the order
const played = (job: PlaySeedJob): Played => ({
  results: job.games.map((g, i) => {
    const p1wins = (job.seed + i) % 2 === 0
    return {
      id: g.id,
      result: {
        seed: job.seed, steps: 10, outcome: "won", winner: p1wins ? g.p1 : g.p2, winnerSeat: p1wins ? "p1" : "p2", round: 3, ms: 5,
        key: job.key, by: null, faultKind: null, botStats: [null, null], timing: null, think: { p1: 1, p2: 2 }
      }
    }
  }),
  replays: Object.fromEntries(job.games.map((g) => [
    g.id,
    line({ t: "header", v: 1, seed: job.seed, engine: null, players: [{ id: "p1", bot: g.p1 }, { id: "p2", bot: g.p2 }] }) +
    line({ t: "end", winner: "p1", round: 3, steps: 10, outcome: "won", error: null, by: null, faultKind: null })
  ]))
})
const data = mkdtempSync(path.join(root, "data-"))
chmodSync(data, 0o755)
const c = readConfig({ GAMES_DATA: data, GAMES_APP: repo }, { ...TIMING, laneTickMs: 20, publishMs: 100 })
const withStore = <A>(f: (store: StoreService) => Effect.Effect<A>) =>
  Effect.runPromise(Effect.gen(function*() {
    return yield* f(yield* Store)
  }).pipe(Effect.provide(Store.layerFile(c.paths.db))))
const deps = (store: StoreService, play: NonNullable<RoundDeps["play"]>): RoundDeps => ({
  config: c, store, proc: makeProc(c), gamesctl, js, board: null, secret: "5".repeat(64), boot: "b1",
  settings: () => ({ gamesPerPair: 2, thinkCapSec: 20, workers: 3, roundGapMin: 0 }), play
})

test("round: a resumed round keeps its finished games in the order they started", async () => {
  const ladder = () => JSON.parse(readFileSync(path.join(c.paths.results, "arena-r3", "ladder.json"), "utf8"))
  let n = 0
  // job 1 (a seed's two games) is slow, job 2 (the next seed's first game) ends first, later jobs meet a stop
  const cut = (job: PlaySeedJob) =>
    Effect.suspend(() => {
      n++
      if (n === 1) return Effect.sleep(300).pipe(Effect.as(played(job)))
      if (n === 2) return Effect.succeed(played(job))
      return Effect.sleep(900).pipe(Effect.andThen(Effect.fail(new PlayFailed(job.seed, "shutdown", true))))
    })
  assert.deepEqual(await withStore((store) => playRound(deps(store, cut), 3, "changed", false)), { kind: "stopped" })
  const kept = ladder().games.filter((g: any) => g.outcome !== "running").map((g: any) => g.id)
  assert.equal(kept.length, 3)
  const ended = (await withStore((store) => store.games(3))).filter((g) => g.state === "done")
  // the seed of job 2 ended before job 1's: by end time it would come first
  assert.notDeepEqual([...ended].sort((a, b) => a.endedAt!.localeCompare(b.endedAt!)).map((g) => g.id), kept)

  const rest = (job: PlaySeedJob) => Effect.succeed(played(job))
  assert.deepEqual(await withStore((store) => playRound(deps(store, rest), 3, "resume", true)), { kind: "done" })
  const after = ladder()
  assert.equal(after.games.length, 6)
  assert.deepEqual(after.games.slice(0, 3).map((g: any) => g.id), kept)
})

test("round: a game that played again after a failure keeps its first place when the round resumes", async () => {
  const ladder = () => JSON.parse(readFileSync(path.join(c.paths.results, "arena-r4", "ladder.json"), "utf8"))
  const calls = new Map<number, number>()
  let first: number | null = null
  let second: number | null = null
  // the first seed fails once and plays again after the second seed's first game ended; the rest meet a stop
  const retried = (job: PlaySeedJob) =>
    Effect.suspend(() => {
      const n = (calls.get(job.seed) ?? 0) + 1
      calls.set(job.seed, n)
      first ??= job.seed
      if (job.seed === first) {
        return n === 1 ? Effect.sleep(200).pipe(Effect.andThen(Effect.fail(new PlayFailed(job.seed, "the bot crashed")))) : Effect.succeed(played(job))
      }
      if (second === null) {
        second = job.seed
        return Effect.succeed(played(job))
      }
      return Effect.sleep(900).pipe(Effect.andThen(Effect.fail(new PlayFailed(job.seed, "shutdown", true))))
    })
  assert.deepEqual(await withStore((store) => playRound(deps(store, retried), 4, "changed", false)), { kind: "stopped" })
  const kept = ladder().games.filter((g: any) => g.outcome !== "running").map((g: any) => g.id)
  assert.equal(kept.length, 3)
  assert.equal(calls.get(first!), 2, "the first seed played twice")

  const rest = (job: PlaySeedJob) => Effect.succeed(played(job))
  assert.deepEqual(await withStore((store) => playRound(deps(store, rest), 4, "resume", true)), { kind: "done" })
  assert.deepEqual(ladder().games.slice(0, 3).map((g: any) => g.id), kept)
})
