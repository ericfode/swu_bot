/**
 * The helper role against a games machine of its own: a fake machine (node:http on 127.0.0.1:0, the helper API's
 * routes) and a fake play-seed.js in a temp app folder (GAMES_APP) whose behaviour a mode file sets. The cases are
 * coord/test/coord/helper_test.exs's; the log lines are checked with helper-tui.js's own parser. One real seed (a
 * WebAssembly version against rush, through the real play-seed.js) runs when the engine, its card data and wasmtime
 * are here.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import type { Timing } from "../../src/games/Config.ts"
import { TIMING, readConfig } from "../../src/games/Config.ts"
import type { Tick } from "../../src/games/Helper.ts"
import { resultBody, runHelper, slept } from "../../src/games/Helper.ts"
import * as Log from "../../src/games/Log.ts"
import { makeProc } from "../../src/games/Proc.ts"
import { takeSecrets } from "../../src/games/Secrets.ts"

const REPO = path.resolve(import.meta.dirname, "..", "..", "..")
const requireRepo = createRequire(path.join(REPO, "bot", "package.json"))
const tui = requireRepo(path.join(REPO, "bot", "arena", "ops", "helper-tui.js"))

const ROOT = process.getuid?.() === 0
// as root the plays run as the bots' user: arena where it exists (the image, this machine), else nobody
const BOTS_USER = !ROOT || spawnSync("id", ["-u", "arena"], { stdio: "ignore" }).status === 0 ? "arena" : "nobody"
const TOKEN = "a-helper-token-for-these-tests-only-0123456789"
const TIMES: Timing = { ...TIMING, helloRetryMs: 100, claimBackoffMs: [50, 100] }
const scratch: Array<string> = []
after(() => {
  Log.setSink((line) => process.stdout.write(line))
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

/** a folder the bots' user can reach (the plays run as that user when the tests run as root) */
const folder = (prefix: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  chmodSync(dir, 0o755)
  scratch.push(dir)
  return dir
}

const eventually = async <A>(f: () => A | null | undefined | false, ms = 10_000, what = "a condition"): Promise<A> => {
  const end = Date.now() + ms
  for (;;) {
    const v = f()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

// --- the fake play-seed.js: records what it was given, then answers as mode.json says

const FAKE_PLAY_SEED = `'use strict'
const fs = require('fs')
const path = require('path')
const app = path.join(__dirname, '..', '..')
const ev = (x) => fs.appendFileSync(path.join(app, 'events', 'log'), JSON.stringify(x) + '\\n')
const mode = JSON.parse(fs.readFileSync(path.join(app, 'mode.json'), 'utf8'))
const args = process.argv.slice(2)
const arg = (k) => args[args.indexOf(k) + 1]
process.on('SIGTERM', () => { ev({ term: args[0] === '--warm' ? 'warm' : 'play' }); process.exit(143) })
if (args[0] === '--warm') {
  ev({ start: args, uid: process.getuid() })
  if (mode.warm === 'fail') process.exit(1)
  console.log(JSON.stringify({ ok: true, warmed: ['c-clock-wasm'], failed: mode.warm === 'some' ? [{ name: 'py-clock-wasm', error: 'x' }] : [] }))
} else {
  const job = JSON.parse(fs.readFileSync(arg('--job'), 'utf8'))
  const bundles = fs.readdirSync(arg('--bundles')).filter((f) => f.endsWith('.tar')).sort()
  ev({ start: args, env: process.env, job, bundles, uid: process.getuid() })
  setTimeout(() => {
    if (mode.play === 'exit') process.exit(mode.code)
    if (mode.play === 'print') return console.log(mode.text)
    const out = path.join(arg('--work'), 'out')
    fs.mkdirSync(out, { recursive: true })
    const replays = {}
    const results = job.games.map((g) => {
      replays[g.id] = path.join(out, g.id + '.jsonl')
      fs.writeFileSync(replays[g.id], JSON.stringify({ t: 'header', game: g.id }) + '\\n' + JSON.stringify({ t: 'end', game: g.id }) + '\\n')
      return { id: g.id, result: { outcome: 'won', winner: g.p1, winnerSeat: 'p1', round: 3, steps: 40, ms: 5 } }
    })
    console.error('a log line from the engine')
    console.log('a stray line before the answer')
    console.log(JSON.stringify({ ok: true, results, replays }))
  }, (mode.sleep ?? 0) * 1000)
}
`

interface Mode {
  readonly play?: "ok" | "exit" | "print"
  readonly code?: number
  readonly text?: string
  readonly sleep?: number
  readonly warm?: "ok" | "fail" | "some"
}

const fakeApp = (mode: Mode = {}) => {
  const app = folder("helper-app-")
  mkdirSync(path.join(app, "bot", "arena"), { recursive: true })
  writeFileSync(path.join(app, "bot", "arena", "play-seed.js"), FAKE_PLAY_SEED)
  mkdirSync(path.join(app, "events"))
  chmodSync(path.join(app, "events"), 0o777)
  writeFileSync(path.join(app, "mode.json"), JSON.stringify(mode))
  return app
}

type Event = { start?: Array<string>; env?: Record<string, string>; job?: any; bundles?: Array<string>; uid?: number; term?: string }
const events = (app: string): Array<Event> => {
  try {
    return readFileSync(path.join(app, "events", "log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}
const plays = (app: string) => events(app).filter((e) => e.start && e.start[0] !== "--warm")

// --- the fake games machine: the helper API's routes, one name, leases the test offers

interface Offer {
  readonly lease: string
  readonly job: Record<string, unknown>
  readonly bundles: ReadonlyArray<{ readonly id: string; readonly bytes: number }>
  readonly deadlineMs: number
}

const fakeMachine = async (o: { heartbeatMs?: number | undefined } = {}) => {
  const m = {
    token: TOKEN,
    build: "build-1",
    claimFails: false,
    hellos: 0,
    claims: 0,
    bundleGets: 0,
    bundles: new Map<string, Buffer>(),
    queue: [] as Array<Offer>,
    waiting: [] as Array<(offer: Offer) => void>,
    leases: new Map<string, { gone: boolean; beats: number; result: any }>()
  }
  const server = http.createServer((req, res) => {
    const chunks: Array<Buffer> = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8")
      const json = (status: number, doc?: unknown) => {
        if (res.writableEnded || res.destroyed) return
        res.writeHead(status, doc === undefined ? {} : { "content-type": "application/json; charset=utf-8" })
        res.end(doc === undefined ? undefined : JSON.stringify(doc))
      }
      if (req.headers.authorization !== `Bearer ${m.token}`) return json(401, { error: { code: "unauthorized", message: "a helper token is needed" } })
      if (req.headers["x-helper-build"] !== m.build) {
        const want = { build: m.build, cards: "cards-1", image: `registry.fly.io/swu-arena-games:${m.build}` }
        return json(409, { error: { code: "build", message: `the games machine runs build ${m.build}`, want } })
      }
      const url = req.url ?? ""
      if (req.method === "POST" && url === "/v1/hello") {
        m.hellos++
        const doc = JSON.parse(body)
        assert.deepEqual(doc, { build: "build-1", cards: "cards-1", slots: doc.slots })
        return json(200, { ok: true, name: "eric", heartbeatMs: o.heartbeatMs ?? 1000, leaseLostMs: 90000, claimMs: 1000 })
      }
      if (req.method === "POST" && url === "/v1/claim") {
        m.claims++
        assert.match(JSON.parse(body).slot, /^\d+$/)
        if (m.claimFails) return req.socket.destroy()
        const ready = m.queue.shift()
        if (ready) return json(200, ready)
        // the long poll: an offer, or 204 after a while
        let answered = false
        const answer = (offer: Offer | null) => {
          if (answered) return
          answered = true
          clearTimeout(timer)
          m.waiting = m.waiting.filter((w) => w !== answer)
          if (offer) json(200, offer)
          else json(204)
        }
        const timer = setTimeout(() => answer(null), 300)
        m.waiting.push(answer)
        res.on("close", () => {
          if (!answered) {
            answered = true
            clearTimeout(timer)
            m.waiting = m.waiting.filter((w) => w !== answer)
          }
        })
        return
      }
      const bundle = /^\/v1\/bundle\/([0-9a-f]{64})$/.exec(url)
      if (req.method === "GET" && bundle) {
        m.bundleGets++
        const tar = m.bundles.get(bundle[1]!)
        if (!tar) return json(404, { error: { code: "not_found" } })
        res.writeHead(200, { "content-type": "application/x-tar" })
        return res.end(tar)
      }
      const lease = /^\/v1\/lease\/([A-Za-z0-9_-]+)\/(heartbeat|result)$/.exec(url)
      if (req.method === "POST" && lease) {
        const l = m.leases.get(lease[1]!)
        if (!l || l.gone || l.result) return json(410, { error: { code: "gone" } })
        if (lease[2] === "heartbeat") {
          assert.equal(body, "")
          assert.equal(req.headers["content-type"], undefined)
          l.beats++
          return json(200, { continue: true })
        }
        assert.equal(req.headers["content-type"], "application/json")
        l.result = JSON.parse(body)
        return json(200, { ok: true })
      }
      json(404, { error: { code: "not_found" } })
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url,
    m,
    /** a lease for the oldest waiting claim, or the next claim */
    offer: (job: Record<string, unknown>, bundles: ReadonlyArray<string> = []) => {
      const id = randomBytes(12).toString("base64url")
      const offer = {
        lease: id, job, bundles: bundles.map((h) => ({ id: h, bytes: m.bundles.get(h)?.length ?? 0 })),
        deadlineMs: (typeof job.gameMs === "number" && job.gameMs > 0 ? job.gameMs : 1_800_000) + 300_000
      }
      m.leases.set(id, { gone: false, beats: 0, result: null })
      const w = m.waiting.shift()
      if (w) w(offer)
      else m.queue.push(offer)
      return id
    },
    /** the lease once it has a result */
    ended: (id: string, ms = 10_000) => eventually(() => m.leases.get(id)?.result, ms, `lease ${id}'s result`),
    close: () => {
      server.closeAllConnections()
      return new Promise<void>((r) => server.close(() => r()))
    }
  }
}

type Machine = Awaited<ReturnType<typeof fakeMachine>>

const job = (seed = 4321, change: Record<string, unknown> = {}) => ({
  v: 1, seed, key: null, maxSteps: 6000, capMs: 20000, hangMs: 70000, gameMs: 120000,
  games: [{ id: `x-v1-vs-y-v1-${seed}`, p1: "x-v1", p2: "y-v1" }, { id: `y-v1-vs-x-v1-${seed}`, p1: "y-v1", p2: "x-v1" }],
  bots: { "x-v1": { kind: "resident" }, "y-v1": { kind: "resident" } },
  ...change
})

/** a helper on the fake machine; stop() aborts its signal and waits for its exit code */
const start = async (o: {
  mode?: Mode
  slots?: number
  token?: string
  machine?: Machine
  heartbeatMs?: number
  app?: string
  data?: string
  url?: string
  timing?: Timing
} = {}) => {
  const data = o.data ?? folder("helper-data-")
  const app = o.app ?? fakeApp(o.mode)
  const machine = o.machine ?? (await fakeMachine({ heartbeatMs: o.heartbeatMs }))
  const c = readConfig({
    COORD_ROLE: "helper", GAMES_HELPER_URL: o.url ?? machine.url, GAMES_DATA: data, GAMES_APP: app,
    GAMES_BUILD: "build-1", GAMES_CARDS: "cards-1", GAMES_HELPER_SLOTS: String(o.slots ?? 1), ARENA_USER: BOTS_USER
  }, o.timing ?? TIMES)
  const secrets = takeSecrets({ GAMES_HELPER_TOKEN: o.token ?? TOKEN })
  const lines: Array<string> = []
  // HELPER_TEST_LOG=1 shows the helper's lines as they come
  Log.setSink((line) => lines.push(line) && process.env.HELPER_TEST_LOG && process.stderr.write(line))
  const ac = new AbortController()
  let skew = 0
  const clock = (): Tick => [Date.now() + skew, performance.now()]
  const exit = runHelper(c, secrets, makeProc(c), { signal: ac.signal, clock })
  const log = () => lines.join("")
  return {
    data, app, machine, c, exit, lines, log,
    /** the wall clock jumps ahead of the monotonic one, as after a sleep */
    sleepComputer: (ms: number) => (skew += ms),
    workDir: (lease: string, slot = "1") => path.join(data, "helper", slot, lease),
    waiting: (n = 1) => eventually(() => machine.m.waiting.length >= n, 10_000, "a waiting claim"),
    stop: async (reason = "SIGTERM") => {
      ac.abort(reason)
      const code = await exit
      await machine.close()
      return code
    }
  }
}

/** the helper's log lines as helper-tui.js reads them */
const parsed = (lines: ReadonlyArray<string>) => lines.map((l) => tui.parseLine(l.trimEnd()))

// --- the unit parts

test("slept: the wall clock and the monotonic clock moved apart by more than 20 s, either way", () => {
  assert.equal(slept([0, 0], [30_000, 30_000]), false)
  assert.equal(slept([1_000, 5], [21_000, 5]), false)
  assert.equal(slept([1_000, 5], [21_001, 5]), true)
  assert.equal(slept([0, 0], [90_000, 30_000]), true)
  assert.equal(slept([0, 0], [0, 25_000]), true)
  assert.equal(slept([0, 0], [30_000, 30_000], 0), false)
})

test("resultBody: reads the replays named in play-seed's last line", () => {
  const dir = folder("result-body-")
  const out = path.join(dir, "out")
  mkdirSync(out)
  writeFileSync(path.join(out, "a.jsonl"), "{\"t\":\"header\"}\n")
  const line = (replays: Record<string, unknown>) => JSON.stringify({ ok: true, results: [{ id: "a", result: {} }], replays })
  const r = resultBody(`a log line\n${line({ a: `${out}/a.jsonl` })}\n\n`, out)
  assert.ok(r.ok)
  assert.deepEqual(JSON.parse(r.json), { results: [{ id: "a", result: {} }], replays: { a: "{\"t\":\"header\"}\n" } })
  assert.equal(r.results[0]!.id, "a")
  assert.ok(resultBody(line({}), path.join(dir, "no-such-folder")).ok, "no replays need no folder")
  assert.deepEqual(resultBody(line({ a: `${out}/a.jsonl` }), path.join(dir, "no-such-folder")), { ok: false, why: "no replay folder" })
  // a replay of someone else's (the bots' user owns every replay a play writes)
  assert.deepEqual(resultBody(line({ a: `${out}/a.jsonl` }), out, 12345), { ok: false, why: "a replay path is not a file in out/" })
})

test("resultBody: only regular files right in out/, within the limits, as UTF-8 text", () => {
  const dir = folder("result-body-")
  const out = path.join(dir, "out")
  mkdirSync(path.join(out, "sub"), { recursive: true })
  writeFileSync(path.join(dir, "secret"), "x")
  symlinkSync(path.join(dir, "secret"), path.join(out, "link.jsonl"))
  writeFileSync(path.join(out, "sub", "b.jsonl"), "x")
  const line = (replays: Record<string, unknown>) => JSON.stringify({ ok: true, results: [{ id: "a", result: {} }], replays })
  for (const p of [`${dir}/secret`, `${out}/link.jsonl`, `${out}/sub/b.jsonl`, `${out}/../secret`, `${out}/missing.jsonl`, "relative.jsonl", `${out}/sub`, 7]) {
    assert.deepEqual(resultBody(line({ a: p }), out), { ok: false, why: "a replay path is not a file in out/" }, String(p))
  }
  const big = openSync(path.join(out, "big.jsonl"), "w")
  ftruncateSync(big, 32_000_001)
  closeSync(big)
  assert.deepEqual(resultBody(line({ a: `${out}/big.jsonl` }), out), { ok: false, why: "a replay is over 32000000 bytes" })
  const three = openSync(path.join(out, "c.jsonl"), "w")
  ftruncateSync(three, 15_000_000)
  closeSync(three)
  assert.deepEqual(resultBody(line({ a: `${out}/c.jsonl`, b: `${out}/c.jsonl`, c: `${out}/c.jsonl` }), out), { ok: false, why: "the replays are over 40000000 bytes" })
  writeFileSync(path.join(out, "bad.jsonl"), Buffer.from([0x7b, 0xff, 0xfe, 0x7d]))
  assert.deepEqual(resultBody(line({ a: `${out}/bad.jsonl` }), out), { ok: false, why: "a replay is not UTF-8 text" })
})

test("resultBody: anything but ok and its results fails", () => {
  const out = folder("result-body-")
  for (const bad of ["", "not json", "{\"ok\":false}", "{\"ok\":true,\"results\":{},\"replays\":{}}", "{\"ok\":true,\"results\":[]}", "[1]"]) {
    assert.deepEqual(resultBody(bad, out), { ok: false, why: "play-seed printed something other than ok and its results" }, bad)
  }
  for (const bad of ["{\"ok\":true,\"results\":[{\"id\":1,\"result\":{}}],\"replays\":{}}", "{\"ok\":true,\"results\":[{\"id\":\"a\",\"result\":[]}],\"replays\":{}}", "{\"ok\":true,\"results\":[{\"id\":\"a\"}],\"replays\":{}}"]) {
    assert.deepEqual(resultBody(bad, out), { ok: false, why: "play-seed's results are malformed" }, bad)
  }
})

// --- a slot

test("a slot plays a lease: its bundle (fetched once), job.json and play-seed.js; then posts the results and replays", async () => {
  const h = await start()
  const tar = Buffer.from("a canonical tar")
  const hex = createHash("sha256").update(tar).digest("hex")
  h.machine.m.bundles.set(hex, tar)
  await h.waiting()
  const id = h.machine.offer(job(4321), [hex])
  const result = await h.machine.ended(id)
  assert.deepEqual(result.results.map((r: any) => [r.id, r.result.winnerSeat]), [["x-v1-vs-y-v1-4321", "p1"], ["y-v1-vs-x-v1-4321", "p1"]])
  assert.deepEqual(result.replays, {
    "x-v1-vs-y-v1-4321": "{\"t\":\"header\",\"game\":\"x-v1-vs-y-v1-4321\"}\n{\"t\":\"end\",\"game\":\"x-v1-vs-y-v1-4321\"}\n",
    "y-v1-vs-x-v1-4321": "{\"t\":\"header\",\"game\":\"y-v1-vs-x-v1-4321\"}\n{\"t\":\"end\",\"game\":\"y-v1-vs-x-v1-4321\"}\n"
  })
  assert.ok(h.machine.m.leases.get(id)!.beats >= 1, "the first heartbeat goes at once")
  // the folder goes, and the slot claims the next seed
  await eventually(() => !existsSync(h.workDir(id)), 5_000, "the work folder to go")
  await h.waiting()

  const dir = h.workDir(id)
  const [play] = plays(h.app)
  assert.deepEqual(play!.start, ["--job", `${dir}/job.json`, "--bundles", h.c.paths.bundles, "--work", dir])
  assert.deepEqual(play!.job, job(4321))
  assert.deepEqual(play!.bundles, [`${hex}.tar`])
  // the play's environment is built from nothing: no token, no address of the machine, no NODE_ENV
  assert.deepEqual(Object.keys(play!.env!).sort(), ["HOME", "LANG", "PATH", "SWU_WASM_CACHE", "TZ"])
  assert.equal(play!.env!.HOME, h.c.paths.home)
  assert.equal(play!.env!.SWU_WASM_CACHE, h.c.paths.wasmCache)
  assert.ok(Object.values(play!.env!).every((v) => !v.includes(TOKEN) && !v.includes(h.machine.url)))
  if (ROOT) assert.equal(play!.uid, Number(spawnSync("id", ["-u", h.c.arenaUser], { encoding: "utf8" }).stdout.trim()), "plays run as the bots' user")
  // the tar stays, readable, for the next lease that needs it
  assert.equal(statSync(path.join(h.c.paths.bundles, `${hex}.tar`)).mode & 0o777, 0o644)

  const second = h.machine.offer(job(4322), [hex])
  await h.machine.ended(second)
  assert.equal(h.machine.m.bundleGets, 1, "a bundle is fetched once")
  assert.equal(await h.stop(), 0)

  const events = parsed(h.lines)
  const hello = events.find((e: any) => e.kind === "hello")
  assert.deepEqual([hello.name, hello.slots], ["eric", 1])
  const seeds = events.filter((e: any) => e.kind === "seed")
  assert.deepEqual(seeds.map((e: any) => [e.lease, e.seed, e.note]), [[id, "4321", ""], [second, "4322", ""]])
  assert.deepEqual(seeds[0].games.map((g: any) => [g.p1, g.p2, g.outcome, g.winner]), [["x-v1", "y-v1", "won", "x-v1"], ["y-v1", "x-v1", "won", "y-v1"]])
  assert.ok(h.log().includes(`lease ${id} (seed 4321): x-v1-vs-y-v1-4321 won p1, y-v1-vs-x-v1-4321 won p1; `))
  assert.ok(events.some((e: any) => e.kind === "stopping"), "SIGTERM received is logged")
  assert.ok(h.lines.every((l) => /^\d\d:\d\d:\d\d\.\d{3} \[(info|warning|error)\] /.test(l)))
  assert.ok(!h.log().includes(TOKEN))
})

test("a play that fails is posted as failed, so the machine plays the seed itself", async () => {
  const h = await start({ mode: { play: "exit", code: 1 } })
  await h.waiting()
  const id = h.machine.offer(job())
  assert.deepEqual(await h.machine.ended(id), { failed: "play-seed exited with 1" })
  await eventually(() => !existsSync(h.workDir(id)), 5_000, "the work folder to go")
  assert.equal(await h.stop(), 0)
  const failed = parsed(h.lines).find((e: any) => e.kind === "failed")
  assert.deepEqual([failed.lease, failed.seed, failed.why], [id, "4321", "play-seed exited with 1"])
})

test("a play that prints something other than its results fails the lease", async () => {
  const text = JSON.stringify({ ok: true, results: [{ id: "a", result: {} }], replays: { a: "/etc/passwd" } })
  const h = await start({ mode: { play: "print", text } })
  await h.waiting()
  // it made no out/ folder, and names a file elsewhere
  assert.deepEqual(await h.machine.ended(h.machine.offer(job())), { failed: "no replay folder" })
  assert.equal(await h.stop(), 0)
})

test("a bundle whose bytes are not its id fails the lease before anything plays", async () => {
  const h = await start()
  const hex = createHash("sha256").update("the real tar").digest("hex")
  h.machine.m.bundles.set(hex, Buffer.from("something else"))
  await h.waiting()
  const answer = await h.machine.ended(h.machine.offer(job(), [hex]))
  assert.equal(answer.failed, `bundle ${hex.slice(0, 12)}: bundle's sha256 is not its id`)
  assert.equal(plays(h.app).length, 0)
  assert.ok(!existsSync(path.join(h.c.paths.bundles, `${hex}.tar`)))
  // and one the machine does not have
  const missing = "ab".repeat(32)
  assert.equal((await h.machine.ended(h.machine.offer(job(), [missing]))).failed, `bundle ${missing.slice(0, 12)}: HTTP 404`)
  assert.equal(await h.stop(), 0)
})

test("a heartbeat answered 410 stops the play and drops the lease; the work folder is laid out as the live view reads it", async () => {
  const h = await start({ mode: { sleep: 30 } })
  await h.waiting()
  const id = h.machine.offer(job())
  await eventually(() => plays(h.app).length === 1, 10_000, "the play to start")
  const dir = h.workDir(id)
  assert.equal(statSync(path.join(dir, "job.json")).mode & 0o777, 0o644)
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "job.json"), "utf8")), job())
  assert.equal(lstatSync(dir).mode & 0o777, 0o700)
  if (ROOT) {
    assert.equal(statSync(path.join(h.data, "helper")).mode & 0o777, 0o711)
    assert.equal(statSync(dir).uid, plays(h.app)[0]!.uid, "the lease's folder is the bots' user's")
    assert.equal(statSync(path.join(dir, "job.json")).uid, 0)
  }

  h.machine.m.leases.get(id)!.gone = true
  await eventually(() => events(h.app).some((e) => e.term === "play"), 10_000, "the play to be stopped")
  await eventually(() => !existsSync(dir), 5_000, "the work folder to go")
  await h.waiting()
  assert.equal(h.machine.m.leases.get(id)!.result, null, "nothing is posted for a lease taken back")
  assert.equal(await h.stop(), 0)
  assert.ok(parsed(h.lines).some((e: any) => e.kind === "takenBack"))
  assert.ok(h.log().includes(`lease ${id}: the games machine took it back (410); stopping its play`))
})

test("heartbeats keep the lease while the play runs", async () => {
  const h = await start({ mode: { sleep: 2.5 } })
  await h.waiting()
  const id = h.machine.offer(job())
  await h.machine.ended(id)
  assert.ok(h.machine.m.leases.get(id)!.beats >= 3, `beats ${h.machine.m.leases.get(id)!.beats}`)
  assert.equal(await h.stop(), 0)
})

test("after the computer slept the play stops and the lease fails", async () => {
  const h = await start({ mode: { sleep: 30 } })
  await h.waiting()
  const id = h.machine.offer(job())
  await eventually(() => plays(h.app).length === 1, 10_000, "the play to start")
  h.sleepComputer(60_000)
  assert.deepEqual(await h.machine.ended(id), { failed: "the computer slept" })
  assert.ok(events(h.app).some((e) => e.term === "play"))
  await eventually(() => !existsSync(h.workDir(id)), 5_000, "the work folder to go")
  assert.equal(await h.stop(), 0)
  assert.ok(h.log().includes(`lease ${id}: the computer slept; the seed goes back to the games machine`))
  assert.ok(parsed(h.lines).some((e: any) => e.kind === "slept"))
})

test("the first heartbeat goes as soon as the lease arrives; a sleep found only when the play ends fails it", async () => {
  const h = await start({ mode: { sleep: 1.5 }, heartbeatMs: 60_000 })
  await h.waiting()
  const id = h.machine.offer(job())
  await eventually(() => h.machine.m.leases.get(id)!.beats === 1, 5_000, "the first heartbeat")
  h.sleepComputer(60_000)
  assert.deepEqual(await h.machine.ended(id), { failed: "the computer slept" })
  assert.equal(await h.stop(), 0)
  assert.ok(h.log().includes(`lease ${id}: the computer slept during the play; the seed goes back to the games machine`))
})

test("a helper that stops gives its seed back at once, and its play stops", async () => {
  const h = await start({ mode: { sleep: 30 } })
  await h.waiting()
  const id = h.machine.offer(job())
  await eventually(() => plays(h.app).length === 1, 10_000, "the play to start")
  const t0 = Date.now()
  const done = h.exit
  const machine = h.machine
  const code = await h.stop("SIGTERM")
  assert.equal(code, 0)
  assert.ok(Date.now() - t0 < 9_000)
  assert.deepEqual(machine.m.leases.get(id)!.result, { failed: "the helper stopped" })
  assert.ok(events(h.app).some((e) => e.term === "play"))
  assert.ok(!existsSync(h.workDir(id)))
  assert.equal(await done, 0)
  assert.ok(parsed(h.lines).some((e: any) => e.kind === "stopping"))
})

test("hello answered 409 stops the helper with 3, naming the image; 401 with 1", async () => {
  const machine = await fakeMachine()
  machine.m.build = "build-9"
  const h = await start({ machine })
  assert.equal(await h.exit, 3)
  assert.ok(h.log().includes("[error] the games machine runs build build-9: pull registry.fly.io/swu-arena-games:build-9 and start it (stopping with 3)"))
  assert.equal(machine.m.claims, 0)
  assert.equal(await h.stop(), 3)

  const h2 = await start({ token: "not-a-token-the-machine-knows-0123456789" })
  assert.equal(await h2.exit, 1)
  assert.ok(h2.log().includes("[error] the games machine does not know this helper's token (stopping with 1)"))
  assert.equal(await h2.stop(), 1)
})

test("a claim answered 409 stops the helper with 3; 401 with 1", async () => {
  const h = await start({ slots: 2 })
  await h.waiting(2)
  h.machine.m.build = "build-2"
  assert.equal(await h.exit, 3)
  assert.ok(h.log().includes("pull registry.fly.io/swu-arena-games:build-2 and start it (stopping with 3)"))
  assert.equal(await h.stop(), 3)

  const h2 = await start()
  await h2.waiting()
  h2.machine.m.token = "another-token-from-now-on"
  assert.equal(await h2.exit, 1)
  assert.equal(await h2.stop(), 1)
})

test("a 409 on a heartbeat stops the helper with 3, and the seed in play goes back", async () => {
  const h = await start({ mode: { sleep: 30 } })
  await h.waiting()
  const id = h.machine.offer(job())
  await eventually(() => plays(h.app).length === 1, 10_000, "the play to start")
  h.machine.m.build = "build-3"
  assert.equal(await h.exit, 3)
  assert.ok(events(h.app).some((e) => e.term === "play"))
  // the give-back met the other build too: the machine forgets the lease at its restart anyway
  assert.equal(h.machine.m.leases.get(id)!.result, null)
  assert.equal(await h.stop(), 3)
})

test("no answer: the claim is tried again, backing off, logged once; the machine's answer is noted", async () => {
  const h = await start()
  await h.waiting()
  h.machine.m.claimFails = true
  const before = h.machine.m.claims
  await eventually(() => h.machine.m.claims >= before + 4, 10_000, "claims again")
  h.machine.m.claimFails = false
  await eventually(() => h.log().includes("slot 1: the games machine answers again"), 10_000, "the answer")
  assert.equal(await h.stop(), 0)
  assert.equal(h.log().split("slot 1: no claim (socket closed); trying again, the next in 0 s").length, 2)
  const kinds = parsed(h.lines).map((e: any) => e.kind)
  assert.ok(kinds.includes("nomachine") && kinds.includes("machine"))
})

test("with no answer it says hello again every helloRetryMs, logging it once, and never stops by itself", async () => {
  // a port nothing listens on
  const closed = await fakeMachine()
  await closed.close()
  const h = await start({ url: closed.url })
  await eventually(() => h.log().includes("hello: no answer"), 5_000, "the first hello")
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(await h.stop(), 0)
  assert.equal(h.log().split("hello: no answer from the games machine (connection refused); trying every 0 s").length, 2)
  assert.ok(parsed(h.lines).some((e: any) => e.kind === "nomachine"))
})

test("it warms first, then says hello and its slots claim; a failed warm is only logged", async () => {
  const h = await start({ slots: 2 })
  await h.waiting(2)
  assert.deepEqual(events(h.app)[0]!.start, ["--warm"])
  assert.ok(h.log().includes("[info] warmed 1 resident bundles"))
  assert.equal(await h.stop(), 0)

  const h2 = await start({ mode: { warm: "fail" } })
  await h2.waiting()
  assert.ok(h2.log().includes("[warning] play-seed --warm failed (play-seed exited with 1)"))
  assert.equal(await h2.stop(), 0)

  const h3 = await start({ mode: { warm: "some" } })
  await h3.waiting()
  assert.ok(h3.log().includes("[warning] could not warm py-clock-wasm"))
  assert.equal(await h3.stop(), 0)
})

test("boot: old work folders go, the bots' folders are theirs; without a token it stops with 1", async () => {
  const data = folder("helper-data-")
  mkdirSync(path.join(data, "helper", "1", "old-lease"), { recursive: true })
  mkdirSync(path.join(data, "bundles"))
  writeFileSync(path.join(data, "bundles", ".abc.tmp"), "half a download")
  const app = fakeApp()
  const machine = await fakeMachine()
  const c = readConfig({
    COORD_ROLE: "helper", GAMES_HELPER_URL: machine.url, GAMES_DATA: data, GAMES_APP: app,
    GAMES_BUILD: "build-1", GAMES_CARDS: "cards-1", ARENA_USER: BOTS_USER
  }, TIMES)
  const lines: Array<string> = []
  Log.setSink((line) => lines.push(line))
  const ac = new AbortController()
  const exit = runHelper(c, takeSecrets({ GAMES_HELPER_TOKEN: TOKEN }), makeProc(c), { signal: ac.signal })
  await eventually(() => machine.m.waiting.length === 1, 10_000, "a claim")
  assert.deepEqual(readdirSync(path.join(data, "helper")), [])
  assert.equal(statSync(path.join(data, "helper")).mode & 0o777, ROOT ? 0o711 : 0o700)
  assert.equal(statSync(c.paths.server).mode & 0o777, 0o700)
  assert.deepEqual(readdirSync(path.join(data, "bundles")), [])
  assert.equal(statSync(path.join(data, "bundles")).mode & 0o777, 0o755)
  if (ROOT) {
    const uid = Number(spawnSync("id", ["-u", c.arenaUser], { encoding: "utf8" }).stdout.trim())
    assert.equal(statSync(c.paths.home).uid, uid)
    assert.equal(statSync(c.paths.wasmCache).uid, uid)
  }
  ac.abort("SIGTERM")
  assert.equal(await exit, 0)

  const env: NodeJS.ProcessEnv = { SWU_WINDOW_TOKEN: "not-for-helpers" }
  const none = await runHelper(c, takeSecrets(env), makeProc(c), { signal: new AbortController().signal })
  assert.equal(none, 1)
  assert.ok(lines.join("").includes("[error] GAMES_HELPER_TOKEN is not set"))
  assert.equal(env.SWU_WINDOW_TOKEN, undefined)
  await machine.close()
})

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex")

test("bundles kept from an earlier boot are checked once before use; a changed one is fetched again", async () => {
  const tar = Buffer.from("a tar from yesterday")
  const hex = sha256(tar)
  const h = await start()
  h.machine.m.bundles.set(hex, tar)
  await h.waiting()
  await h.machine.ended(h.machine.offer(job(1), [hex]))
  assert.equal(await h.stop(), 0)

  // the next boot, on the same volume: that tar as it was, and another with the right name but other bytes (what a
  // disk error could leave)
  const other = Buffer.from("another tar")
  const otherHex = sha256(other)
  writeFileSync(path.join(h.c.paths.bundles, `${otherHex}.tar`), "not the tar")
  const machine = await fakeMachine()
  machine.m.bundles.set(hex, tar)
  machine.m.bundles.set(otherHex, other)
  const h2 = await start({ machine, data: h.data, app: h.app })
  await h2.waiting()
  assert.ok(!("failed" in (await machine.ended(machine.offer(job(2), [hex, otherHex])))))
  assert.equal(machine.m.bundleGets, 1, "only the changed one is fetched")
  assert.deepEqual(readFileSync(path.join(h.c.paths.bundles, `${otherHex}.tar`)), other)
  assert.equal(await h2.stop(), 0)
})

test("over timing.bundlesLimit the least recently used tars no lease holds go", async () => {
  const tars = ["a".repeat(20), "b".repeat(20), "c".repeat(20)].map((s) => Buffer.from(s))
  const [a, b, c] = tars.map(sha256) as [string, string, string]
  const h = await start({ timing: { ...TIMES, bundlesLimit: 45 } })
  tars.forEach((t, i) => h.machine.m.bundles.set([a, b, c][i]!, t))
  const kept = () => readdirSync(h.c.paths.bundles).sort()
  await h.waiting()
  await h.machine.ended(h.machine.offer(job(1), [a]))
  await h.machine.ended(h.machine.offer(job(2), [b]))
  assert.deepEqual(kept(), [`${a}.tar`, `${b}.tar`].sort())
  // a lease that needs b and c: a, the least recently used and held by none, goes
  await h.machine.ended(h.machine.offer(job(3), [b, c]))
  await eventually(() => kept().length === 2, 5_000, "the cache to shrink")
  assert.deepEqual(kept(), [`${b}.tar`, `${c}.tar`].sort())
  assert.equal(await h.stop(), 0)
})

const ENGINE = existsSync(path.join(REPO, "forceteki", "build", "server")) && existsSync(path.join(REPO, "forceteki", "test", "json"))
const WASM = existsSync(path.join(REPO, "build", "compiled", "node-random", "arena.json")) &&
  spawnSync("python3", ["-c", "import wasmtime"], { stdio: "ignore" }).status === 0

test("a real seed: a WebAssembly version against rush through play-seed.js, as the machine checks it", {
  skip: ENGINE && WASM ? false : "needs the built engine, its card data, wasmtime and build/compiled/node-random",
  timeout: 150_000
}, async () => {
  const r = spawnSync("python3", [path.join(REPO, "bot", "compiled", "bundle.py"), "tar", path.join(REPO, "build", "compiled", "node-random")], { maxBuffer: 80 << 20 })
  assert.equal(r.status, 0, String(r.stderr))
  const hex = sha256(r.stdout)
  const machine = await fakeMachine()
  machine.m.bundles.set(hex, r.stdout)
  const h = await start({ machine, app: REPO })
  await h.waiting()
  const { gameKey } = requireRepo(path.join(REPO, "bot", "rng.js"))
  const { checkDone } = requireRepo(path.join(REPO, "bot", "remote-lane.js"))
  const key = gameKey("helper-test-run-key", 11)
  const games = [{ id: "kim-v1-vs-rush-11", p1: "kim-v1", p2: "rush" }, { id: "rush-vs-kim-v1-11", p1: "rush", p2: "kim-v1" }]
  const real = {
    v: 1, seed: 11, key, maxSteps: 6000, capMs: 20000, hangMs: 70000, gameMs: 680000, games,
    bots: { "kim-v1": { kind: "wasm", bundle: hex }, rush: { kind: "resident" } }
  }
  const answer = await machine.ended(machine.offer(real, [hex]), 140_000)
  assert.ok(!("failed" in answer), answer.failed)
  // the lane's own check of a helper's answer: both games, results and replays that fit the job and its key
  assert.equal(checkDone(games, answer, { seed: 11, key, decks: null }), null)
  assert.equal(await h.stop(), 0)
})
