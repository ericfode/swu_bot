import assert from "node:assert/strict"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import http from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, beforeEach, test } from "node:test"
import { createHash } from "node:crypto"
import { Effect, Layer, ManagedRuntime } from "effect"
import { readConfig, TIMING } from "../../src/games/Config.ts"
import { layer as logLayer, setSink } from "../../src/games/Log.ts"
import { BootFailed, lineupOf, mountpoint, startMachine } from "../../src/games/Machine.ts"
import type { RoundDeps, RoundOutcome } from "../../src/games/Round.ts"
import { Store } from "../../src/games/Store.ts"
import type { RoundRow } from "../../src/games/Store.ts"
import { request } from "../../src/games/WindowProxy.ts"

const TOKEN = "the-window-token-0123456789abcdef"
const REPO = path.resolve(import.meta.dirname, "..", "..", "..")

/**
 * A checkout whose bot/arena/gamesctl.js stands in for the real one: it logs what it was asked to $GAMES_DATA/fake.log
 * (its argv, the names in its environment, and TERM), talks to the window through the proxy for intake and push, and
 * answers each command as gamesctl would. $GAMES_DATA/fake/<command>.{json,exit,sleep} change an answer.
 */
const FAKE_GAMESCTL = `
const fs = require("fs"), path = require("path"), http = require("http")
const [cmd, ...args] = process.argv.slice(2)
const data = process.env.GAMES_DATA
const log = (l) => fs.appendFileSync(path.join(data, "fake.log"), l + "\\n")
const ctl = (ext) => { try { return fs.readFileSync(path.join(data, "fake", cmd + "." + ext), "utf8") } catch { return null } }
log("start " + cmd + " " + args.join(" "))
log("env " + cmd + " " + Object.keys(process.env).sort().join(","))
if (process.env.SWU_WINDOW) log("window " + cmd + " " + process.env.SWU_WINDOW)
process.on("SIGTERM", () => { log("term " + cmd); process.exit(143) })
const call = (method, p, body) => new Promise((resolve) => {
  const req = http.request(process.env.SWU_WINDOW + p, { method, headers: { authorization: "Bearer added-by-the-proxy" } }, (res) => {
    res.resume()
    res.on("end", () => resolve(res.statusCode))
  })
  req.on("error", () => resolve(0))
  req.end(body)
})
const answers = {
  setup: async () => {
    fs.mkdirSync(path.join(data, "secret"), { recursive: true })
    fs.writeFileSync(path.join(data, "secret", "arena-secret"), "ab".repeat(32))
    return { ok: true, residents: ["house"], toolchain: null }
  },
  warm: async () => ({ ok: true, warmed: [], failed: [] }),
  plan: async () => ({ round: null, why: "same" }),
  intake: async () => {
    const s = await call("GET", "/api/docs/submissions")
    log("intake saw " + s)
    return { open: s === 200 ? 0 : null, accepted: 0, done: 0 }
  },
  push: async () => {
    const s = await call("PUT", "/api/docs/arena/status", "{}")
    log("push saw " + s)
    return { ok: s === 200 }
  }
}
;(async () => {
  const sleep = ctl("sleep")
  if (sleep) await new Promise((r) => setTimeout(r, Number(sleep)))
  const out = ctl("json") ?? JSON.stringify(await answers[cmd]())
  const code = Number(ctl("exit") ?? 0)
  console.log(out)
  log("end " + cmd + " " + code)
  process.exit(code)
})()
`

// isolate.sh puts its own folder in place of /tmp, so as root the test's folders live outside it, where an isolated
// child can still see them
const BASE = process.getuid?.() === 0 ? "/var/tmp" : tmpdir()
const made: Array<string> = []
const scratch = (name: string) => {
  const dir = mkdtempSync(path.join(BASE, name))
  made.push(dir)
  return dir
}
// /var/tmp outlives a reboot: leave nothing there
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

const fakeApp = () => {
  const app = scratch("games-app-")
  mkdirSync(path.join(app, "bot", "arena", "ops"), { recursive: true })
  writeFileSync(path.join(app, "bot", "arena", "gamesctl.js"), FAKE_GAMESCTL)
  // as root, children run through isolate.sh as they would on the machine
  copyFileSync(path.join(REPO, "bot", "arena", "ops", "isolate.sh"), path.join(app, "bot", "arena", "ops", "isolate.sh"))
  // the arena's own JavaScript that a round loads (Js.ts): the real files, so the load itself is tested too
  for (const f of ["ratings.js", "decklists.js", "rng.js", "ladder-report.js", "remote-lane.js"]) {
    copyFileSync(path.join(REPO, "bot", f), path.join(app, "bot", f))
  }
  copyFileSync(path.join(REPO, "bot", "arena", "deck-choice.js"), path.join(app, "bot", "arena", "deck-choice.js"))
  return app
}

// the window: settings, the intake's submissions and the pushes' documents; it records who asked what
let seen: Array<{ method: string; url: string; auth: string | undefined }> = []
const window = http.createServer((req, res) => {
  req.resume()
  req.on("end", () => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization })
    const body = req.url === "/api/arena-settings"
      ? { result: { settings: { workers: 3 }, updatedAt: null, by: null } }
      : req.method === "GET" ? { result: [] } : { result: { ok: true, version: 1 } }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  })
})
let windowUrl = ""
let logs: Array<string> = []

before(async () => {
  await new Promise<void>((r) => window.listen(0, "127.0.0.1", r))
  windowUrl = `http://127.0.0.1:${(window.address() as { port: number }).port}`
})
after(() => new Promise((r) => window.close(r)))
beforeEach(() => {
  seen = []
  logs = []
  setSink((l) => logs.push(l))
})

const machineConfig = (data: string, env: Record<string, string> = {}) =>
  readConfig({
    GAMES_DATA: data,
    GAMES_APP: fakeApp(),
    PORT: "0",
    GAMES_LISTEN: "127.0.0.1",
    GAMES_PROXY_PORT: "0",
    SWU_WINDOW: windowUrl,
    // as root here, the children run as root through isolate.sh (no capabilities), so they can read the test's
    // folders; elsewhere nothing is wrapped
    ARENA_USER: "root",
    ...env
  }, { ...TIMING, tickMs: 300, roundTickMs: 100, settleMs: 0 })

const fakeLog = (data: string) => {
  try {
    return readFileSync(path.join(data, "fake.log"), "utf8").split("\n").filter(Boolean)
  } catch {
    return []
  }
}

const eventually = async (f: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms
  while (!f()) {
    if (Date.now() > end) throw new Error("not in time")
    await new Promise((r) => setTimeout(r, 25))
  }
}

test("boot, setup, warm, intake and pushes through the proxy with the token; idle, a last push, exit 0", { timeout: 60_000 }, async (t) => {
  const data = scratch("games-machine-")
  mkdirSync(path.join(data, "coord"), { recursive: true })
  writeFileSync(path.join(data, "coord", "intake.json"), JSON.stringify({ boot: "old", finished: [], unsent: [["s1", { state: "accepted" }]] }))
  const env: NodeJS.ProcessEnv = { SWU_WINDOW_TOKEN: TOKEN, ARENA_PUSH_TOKEN: "p", KEEP: "1" }
  const m = await startMachine({ config: machineConfig(data, { GAMES_IDLE_MIN: "0" }), env, production: false })
  // a failed assertion must not leave the machine running (its servers would keep the test process alive)
  t.after(() => m.stop(1))
  assert.deepEqual(Object.keys(env), ["KEEP"], "the secrets are out of the environment")
  assert.equal(m.boot.length, 16)

  const health = await request(`http://127.0.0.1:${m.ports.ops}`, "/healthz", { method: "GET", timeoutMs: 5000 })
  assert.equal(health.status, 200)

  assert.equal(await m.done, 0)
  const events = fakeLog(data)
  const starts = events.filter((e) => e.startsWith("start ")).map((e) => e.split(" ")[1])
  assert.equal(starts[0], "setup")
  assert.ok(starts.indexOf("warm") < starts.indexOf("plan"), "warm before the first plan")
  for (const cmd of ["setup", "warm", "intake", "plan", "push"]) assert.ok(starts.includes(cmd), cmd)
  assert.ok(starts.filter((s) => s === "push").length >= 2, "the first push and the last one")
  assert.ok(events.includes("intake saw 200") && events.includes("push saw 200"))
  assert.ok(events.includes(`start plan --arena open --settled-since 0 --replay-hours 24`))
  // the children never held the token; the window got it from the proxy only
  const envLines = events.filter((e) => e.startsWith("env "))
  assert.ok(envLines.length > 0 && envLines.every((e) => !/TOKEN|FLY|COOKIE/.test(e)))
  assert.ok(events.some((e) => /^window push http:\/\/127\.0\.0\.1:\d+\/p\/[\w-]{43}$/.test(e)))
  assert.ok(events.some((e) => /^window intake http:\/\/127\.0\.0\.1:\d+\/i\/[\w-]{43}$/.test(e)))
  const fromChildren = seen.filter((s) => s.url !== "/api/arena-settings")
  assert.ok(fromChildren.length >= 3)
  assert.ok(seen.every((s) => s.auth === `Bearer ${TOKEN}`))
  assert.ok(seen.some((s) => s.method === "GET" && s.url === "/api/arena-settings"))

  assert.ok(logs.some((l) => l.includes("[info] set up; residents house")))
  assert.ok(logs.some((l) => l.includes("[info] idle for 0 minutes")))
  assert.ok(logs.findIndex((l) => l.includes("idle for")) < logs.findIndex((l) => l.includes("[info] last push")))
  assert.ok(logs.some((l) => l.includes("arena settings: 2 games per pair, 60 s to think per game, 3 at once")))
  assert.ok(logs.every((l) => !l.includes(TOKEN)))
  // the server's own folder: root's alone, with the store, the settings and the old intake state carried over
  assert.equal(statSync(path.join(data, "server")).mode & 0o777, 0o700)
  assert.ok(existsSync(path.join(data, "server", "games.db")))
  assert.ok(existsSync(path.join(data, "server", "settings.json")))
  assert.match(readFileSync(path.join(data, "server", "intake.json"), "utf8"), /unsent/)
})

test("a stop mid-round: the round is interrupted, not counted, and the last push comes after it; exit 0", { timeout: 60_000 }, async (t) => {
  const data = scratch("games-machine-")
  mkdirSync(path.join(data, "fake"), { recursive: true })
  writeFileSync(path.join(data, "fake", "plan.json"), JSON.stringify({ round: 3, resume: false, why: "changed" }))
  let deps: RoundDeps | null = null
  let interrupted = false
  const play = (d: RoundDeps, k: number): Effect.Effect<RoundOutcome> =>
    Effect.callback<RoundOutcome>(() => {
      deps = d
      assert.equal(k, 3)
      return Effect.sync(() => {
        interrupted = true
      })
    })
  const m = await startMachine({ config: machineConfig(data), env: { SWU_WINDOW_TOKEN: TOKEN }, production: false, play })
  t.after(() => m.stop(1))
  await eventually(() => deps !== null)
  const d = deps as unknown as RoundDeps
  assert.equal(d.secret, "ab".repeat(32))
  assert.equal(d.boot, m.boot)
  assert.equal(d.board, null)
  assert.equal(d.settings().workers, 3)
  assert.ok(m.scheduler.playing())

  // while it plays, the round goes to the window every round tick
  await eventually(() => fakeLog(data).some((e) => e.startsWith("start push") && e.endsWith("--only round")))

  // a wake runs an intake pass at once, even during a round
  const intakes = () => fakeLog(data).filter((e) => e.startsWith("start intake")).length
  const before = intakes()
  const wake = await request(`http://127.0.0.1:${m.ports.ops}`, "/wake", { method: "POST", timeoutMs: 5000 })
  assert.equal(wake.status, 202)
  await eventually(() => intakes() === before + 1)

  assert.equal(await m.stop(0), 0)
  assert.equal(await m.done, 0)
  assert.ok(interrupted)
  const ended = logs.findIndex((l) => l.includes("[info] round 3 ended: stopped (shutdown)"))
  const last = logs.findIndex((l) => l.includes("[info] last push"))
  assert.ok(ended >= 0 && last > ended, "the last push comes after the round stopped")
  assert.equal(fakeLog(data).filter((e) => e.startsWith("start push")).at(-1)?.endsWith("--only round"), false)
  // a second stop is the first one
  assert.equal(await m.stop(1), 0)
  // the wake endpoint is gone
  await assert.rejects(request(`http://127.0.0.1:${m.ports.ops}`, "/healthz", { method: "GET", timeoutMs: 2000 }))
})

test("a failed setup stops the machine with 1", { timeout: 60_000 }, async (t) => {
  const data = scratch("games-machine-")
  mkdirSync(path.join(data, "fake"), { recursive: true })
  writeFileSync(path.join(data, "fake", "setup.exit"), "1")
  const m = await startMachine({ config: machineConfig(data), env: { SWU_WINDOW_TOKEN: TOKEN }, production: false })
  t.after(() => m.stop(1))
  assert.equal(await m.done, 1)
  assert.ok(logs.some((l) => l.includes("[error] gamesctl setup failed (exit 1): stopping")))
  // setup never finished, so no push was ever made, and none is made at the stop
  assert.ok(!fakeLog(data).some((e) => e.startsWith("start push")))
})

test("boot refusals: no volume with GAMES_REQUIRE_MOUNT=1, no window or token on the real machine", async () => {
  assert.equal(mountpoint("/"), false)
  assert.equal(mountpoint("/proc"), true)
  assert.equal(mountpoint("/no/such/folder"), false)
  await assert.rejects(startMachine({ config: readConfig({ GAMES_DATA: "/", GAMES_REQUIRE_MOUNT: "1" }), env: {} }), (e: unknown) =>
    e instanceof BootFailed && /is not a mounted volume \(GAMES_REQUIRE_MOUNT=1\)/.test(e.message))
  const data = scratch("games-machine-")
  await assert.rejects(startMachine({ config: machineConfig(data), env: {}, production: true }), (e: unknown) =>
    e instanceof BootFailed && e.message === "SWU_WINDOW_TOKEN is not set")
  await assert.rejects(startMachine({ config: readConfig({ GAMES_DATA: data }), env: { SWU_WINDOW_TOKEN: TOKEN }, production: true }), (e: unknown) =>
    e instanceof BootFailed && e.message === "SWU_WINDOW is not set")
})

test("the helper API's tables lineup is the latest round in games.db: its versions with a bundle, in roster order", { timeout: 60_000 }, async (t) => {
  const data = scratch("games-machine-")
  const sha256 = (x: string) => createHash("sha256").update(x).digest("hex")
  const swarmToken = "the-swarm-token-0123456789abcdef0123"
  const config = { ...machineConfig(data, { GAMES_HELPER_PORT: "8090", GAMES_HELPER_LISTEN: "127.0.0.1" }), helperPort: 0 }
  const a = sha256("tar a")
  const b = sha256("tar b")
  mkdirSync(config.paths.bundles, { recursive: true })
  writeFileSync(path.join(config.paths.bundles, `${a}.tar`), "tar a")
  writeFileSync(path.join(config.paths.bundles, `${b}.tar`), "tar b!")
  const round = (k: number, bots: Array<string>, bundles: Record<string, string>): RoundRow => ({
    k, arena: "open", spec: { round: k, bots, gamesPerPair: 2, capMs: 45000, decks: null, bundles, botInfo: {} },
    firstSeed: 9, keyId: "abc", workers: 2, state: "done", boot: "b0", attempts: 1, why: "changed", createdAt: "2026-10-15T00:00:00.000Z", endedAt: null
  })
  const rt = ManagedRuntime.make(Store.layerFile(config.paths.db).pipe(Layer.provide(logLayer)))
  const store = await rt.runPromise(Effect.service(Store))
  assert.equal(await lineupOf(store), null)
  await rt.runPromise(store.createRound(round(3, ["a-v1"], { "a-v1": a }), []))
  // a resident without a bundle is left out
  await rt.runPromise(store.createRound(round(4, ["b-v1", "heuristic", "a-v2"], { "a-v2": a, "b-v1": b }), []))
  assert.deepEqual(await lineupOf(store), { round: 4, capMs: 45000, bots: [{ name: "b-v1", bundle: b }, { name: "a-v2", bundle: a }] })
  await rt.dispose()

  const env = { SWU_WINDOW_TOKEN: TOKEN, GAMES_HELPER_TOKENS: `swarm:${sha256(swarmToken)}` }
  const m = await startMachine({ config, env, production: false })
  t.after(() => m.stop(1))
  assert.ok(m.ports.helper)
  const helper = `http://127.0.0.1:${m.ports.helper}`
  const headers = { authorization: `Bearer ${swarmToken}` }
  const lineup = await request(helper, "/v1/swarm/lineup.json", { method: "GET", headers, timeoutMs: 5000 })
  assert.equal(lineup.status, 200)
  assert.equal(lineup.body.toString("utf8"), `{"bots":[{"bundle":"${b}","bytes":6,"name":"b-v1"},{"bundle":"${a}","bytes":5,"name":"a-v2"}],"capMs":45000,"round":4}`)
  const tar = await request(helper, `/v1/swarm/bot/${b}`, { method: "GET", headers, timeoutMs: 5000 })
  assert.equal(tar.status, 200)
  assert.equal(tar.contentType, "application/x-tar")
  assert.equal(tar.body.toString("utf8"), "tar b!")
  assert.equal((await request(helper, `/v1/swarm/bot/${sha256("other")}`, { method: "GET", headers, timeoutMs: 5000 })).status, 404)
  assert.equal(await m.stop(0), 0)
})
