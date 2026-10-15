import assert from "node:assert/strict"
import { mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { Effect, Fiber } from "effect"
import { readConfig } from "../../src/games/Config.ts"
import { childEnv, makeProc } from "../../src/games/Proc.ts"
import { parseHelperTokens, takeSecrets } from "../../src/games/Secrets.ts"
import { Store } from "../../src/games/Store.ts"
import { createHash } from "node:crypto"

const data = () => mkdtempSync(path.join(tmpdir(), "games-test-"))
const config = (dir: string) => readConfig({ GAMES_DATA: dir, GAMES_APP: path.resolve(import.meta.dirname, "..", "..", "..") })

test("config: defaults as the coordinator had them, and bad values stop the boot", () => {
  const c = config(data())
  assert.equal(c.port, 8080)
  assert.equal(c.idleMs, 600_000)
  assert.equal(c.replayHours, 24)
  assert.equal(c.roundCapMs, 6 * 3_600_000)
  assert.equal(c.helperPort, null)
  assert.ok(c.hide.includes("/.fly") && c.hide.includes(c.paths.server) && c.hide.includes(c.paths.secret))
  assert.throws(() => readConfig({ GAMES_ROUND_HOURS: "0" }))
  assert.throws(() => readConfig({ GAMES_LISTEN: "nowhere" }))
  assert.throws(() => readConfig({ COORD_ROLE: "helper", GAMES_HELPER_URL: "http://x/y" }))
  assert.equal(readConfig({ GAMES_ROUND_HOURS: "0.5" }).roundCapMs, 1_800_000)
})

test("secrets: taken out of the environment; helper tokens match by hash, at least 32 bytes, constant time", () => {
  const token = "t".repeat(40)
  const hash = createHash("sha256").update(token).digest("hex")
  const env: NodeJS.ProcessEnv = { SWU_WINDOW_TOKEN: "w", GAMES_HELPER_TOKENS: `eric:${hash}, bad:zz,machine:${hash}`, FLY_API_TOKEN: "f", KEEP: "1" }
  const warned: Array<string> = []
  const s = takeSecrets(env, (m) => warned.push(m))
  assert.deepEqual(Object.keys(env), ["KEEP"])
  assert.equal(s.windowToken(), "w")
  assert.equal(s.helperName(token), "eric")
  assert.equal(s.helperName("short"), null)
  assert.equal(s.helperName("u".repeat(40)), null)
  assert.deepEqual(s.helpers, ["eric"])
  assert.equal(warned.length, 2)
  assert.ok(warned.every((w) => !w.includes(hash)))
  assert.equal(parseHelperTokens(undefined).length, 0)
})

test("proc: a child gets exactly its environment, its stdout is kept, and a timeout stops its whole group", async () => {
  const c = config(data())
  const proc = makeProc(c)
  const env = childEnv(c, c.paths.home, { X: "1" })
  assert.throws(() => childEnv(c, "/", { ARENA_PUSH_TOKEN: "x" }))
  assert.throws(() => childEnv(c, "/", { SWU_WINDOW: "https://swu-arena.fly.dev" }))
  assert.doesNotThrow(() => childEnv(c, "/", { SWU_WINDOW: "http://127.0.0.1:8081/p/abcdef" }))
  const r = await Effect.runPromise(proc.run({
    kind: "plan", argv: [process.execPath, "-e", "console.log(JSON.stringify(Object.keys(process.env).sort()))"],
    env, as: "arena", isolate: false, stdout: "capture"
  }))
  assert.equal(r.kind, "exit")
  assert.deepEqual(JSON.parse(r.stdout), ["HOME", "LANG", "PATH", "TZ", "X"])

  const t0 = Date.now()
  // the child starts a grandchild that would outlive it; the timeout stops both
  const slow = await Effect.runPromise(proc.run({
    kind: "warm",
    argv: ["/bin/sh", "-c", "sleep 30 & sleep 30; echo late"],
    env, as: "arena", isolate: false, stdout: "capture", timeoutMs: 300, graceMs: 200
  }))
  assert.equal(slow.kind, "timeout")
  assert.ok(Date.now() - t0 < 5000)
  assert.equal(readdirSync(c.paths.procs).length, 0)
})

test("proc: a child that cannot start fails alone, and the server goes on", async () => {
  const c = config(data())
  const proc = makeProc(c)
  // a folder that is not there: Node reports the failed spawn as an 'error' event a tick later, which must not go uncaught
  const r = await Effect.runPromise(proc.run({
    kind: "plan", argv: ["/bin/true"], env: childEnv(c, c.paths.home), as: "root", isolate: false, cwd: "/no/such/folder", stdout: "capture"
  }))
  assert.equal(r.kind, "stopped")
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(proc.running(), [])
})

test("proc: interrupting a run stops the child; once stopping, only pushes start", async () => {
  const c = config(data())
  const proc = makeProc(c)
  const env = childEnv(c, c.paths.home)
  await Effect.runPromise(Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(proc.run({ kind: "play", argv: ["/bin/sh", "-c", "sleep 30"], env, as: "arena", isolate: false, stdout: "capture", graceMs: 200 }))
    yield* Effect.sleep(200)
    assert.deepEqual(proc.running(), ["play"])
    yield* Fiber.interrupt(fiber)
    assert.deepEqual(proc.running(), [])
  }))
  proc.setStopping()
  const refused = await Effect.runPromise(proc.run({ kind: "plan", argv: ["/bin/true"], env, as: "arena", isolate: false, stdout: "capture" }))
  assert.equal(refused.kind, "stopped")
  const push = await Effect.runPromise(proc.run({ kind: "push", argv: ["/bin/true"], env, as: "arena", isolate: false, stdout: "capture" }))
  assert.equal(push.kind, "exit")
})

test("store: a round and its games survive a reopen; finished games keep host, result and key", async () => {
  const dir = data()
  const file = path.join(dir, "server", "games.db")
  const spec = { round: 3, bots: ["a-v1", "b-v1"], gamesPerPair: 2, capMs: 45000, decks: null, bundles: {}, botInfo: {} }
  await Effect.runPromise(Effect.gen(function*() {
    const store = yield* Store
    yield* store.createRound({ k: 3, arena: "open", spec, firstSeed: 9, keyId: "abc", workers: 2, state: "playing", boot: "b1", attempts: 1, why: "changed", createdAt: "2026-10-15T00:00:00.000Z", endedAt: null }, [
      { id: "a-v1-vs-b-v1-9", ord: 0, seed: 9, p1: "a-v1", p2: "b-v1", decks: [0, 1], state: "todo", host: null, result: null, key: null, endedAt: null },
      { id: "b-v1-vs-a-v1-9", ord: 1, seed: 9, p1: "b-v1", p2: "a-v1", decks: [0, 1], state: "todo", host: null, result: null, key: null, endedAt: null }
    ])
    yield* store.finishGame(3, "b-v1-vs-a-v1-9", "eric", { outcome: "won", winner: "b-v1", winnerSeat: "p1", round: 4, steps: 80, ms: 10 }, "2026-10-15T00:01:00.000Z")
    yield* store.setKey(3, ["a-v1-vs-b-v1-9", "b-v1-vs-a-v1-9"], "k".repeat(64))
    yield* store.set("round_end", "123")
  }).pipe(Effect.provide(Store.layerFile(file))))
  await Effect.runPromise(Effect.gen(function*() {
    const store = yield* Store
    const r = yield* store.round(3)
    assert.equal(r?.spec.capMs, 45000)
    assert.equal((yield* store.lastRound)?.k, 3)
    const games = yield* store.games(3)
    assert.deepEqual(games.map((g) => [g.id, g.state, g.host, g.key?.length]), [["a-v1-vs-b-v1-9", "todo", null, 64], ["b-v1-vs-a-v1-9", "done", "eric", 64]])
    assert.deepEqual(games[0]!.decks, [0, 1])
    assert.equal(games[1]!.result?.winner, "b-v1")
    assert.equal(yield* store.get("round_end"), "123")
    assert.equal(yield* store.get("nothing"), null)
  }).pipe(Effect.provide(Store.layerFile(file))))
})
