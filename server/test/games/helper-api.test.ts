/**
 * The helper API (HelperApi.ts) on a real listener on 127.0.0.1, ported from coord/test/coord_web/helper_api_test.exs:
 * tokens, builds (an old helper's 409 and 401), claims, bundles, leases, limits, stopping, the swarm's files, and the
 * tables' lineup and bots. Helper tokens are fakes made for these tests.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import http from "node:http"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import type { Timing } from "../../src/games/Config.ts"
import { readConfig, TIMING } from "../../src/games/Config.ts"
import type { Lineup, Listening } from "../../src/games/HelperApi.ts"
import { helperNodeOn, listenAddress, pathInfo, startHelperApi } from "../../src/games/HelperApi.ts"
import type { LeaseBoardImpl } from "../../src/games/Leases.ts"
import { makeLeaseBoard } from "../../src/games/Leases.ts"
import { setSink } from "../../src/games/Log.ts"
import { takeSecrets } from "../../src/games/Secrets.ts"
import type { PlaySeedJob } from "../../src/games/Types.ts"

const TOKENS: Record<string, string> = {
  eric: "eric-helper-token-0123456789abcdef0123",
  bob: "bob-helper-token-4567456789abcdef01234"
}
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")
const helperTokens = () => Object.entries(TOKENS).map(([n, t]) => `${n}:${sha256(t)}`).join(",")

const job = (seed = 1234): PlaySeedJob => ({
  v: 1,
  seed,
  key: sha256(`k-${seed}`),
  maxSteps: 6000,
  capMs: 60_000,
  hangMs: 150_000,
  gameMs: 840_000,
  games: [
    { id: `a-v2-vs-heuristic-${seed}`, p1: "a-v2", p2: "heuristic" },
    { id: `heuristic-vs-a-v2-${seed}`, p1: "heuristic", p2: "a-v2" }
  ],
  bots: { "a-v2": { kind: "wasm", bundle: sha256("tar body") }, heuristic: { kind: "resident" } }
})

interface Machine {
  readonly dir: string
  readonly bundles: string
  readonly board: LeaseBoardImpl
  readonly api: Listening
  stopping: boolean
  clock: number
}

interface SetupOptions {
  readonly env?: Record<string, string>
  readonly timing?: Partial<Timing>
  readonly tokens?: string
  /** a fake lease clock (else the real one) */
  readonly fakeClock?: boolean
  /** an app folder made by the test (else one with the swarm's manifest) */
  readonly app?: string
  readonly board?: (b: LeaseBoardImpl) => LeaseBoardImpl
  /** the latest round's lineup (else none given: the API's own default) */
  readonly lineup?: () => Promise<Lineup | null>
}

let lines: Array<string> = []
const allLines: Array<string> = []
let machines: Array<Machine> = []

beforeEach(() => {
  lines = []
  setSink((l) => {
    lines.push(l)
    allLines.push(l)
  })
})

afterEach(async () => {
  for (const m of machines) {
    m.board.close()
    await m.api.close()
  }
  machines = []
  setSink((l) => process.stdout.write(l))
})

const setup = async (o: SetupOptions = {}): Promise<Machine> => {
  const dir = mkdtempSync(path.join(tmpdir(), "games-helper-api-"))
  let app = o.app
  if (!app) {
    app = path.join(dir, "app")
    mkdirSync(path.join(app, "build", "swarm"), { recursive: true })
    writeFileSync(path.join(app, "build", "swarm", "manifest.json"), `{"build":"build-1","cards":"cards-1"}`)
  }
  const bundles = path.join(dir, "bundles")
  mkdirSync(bundles)
  const timing: Timing = { ...TIMING, claimMs: 2_000, ...o.timing }
  const env = { GAMES_DATA: dir, GAMES_APP: app, GAMES_BUILD: "build-1", GAMES_CARDS: "cards-1", GAMES_HELPER_PORT: "8090", ...o.env }
  for (const [k, v] of Object.entries(env)) if (v === "") delete (env as Record<string, string>)[k]
  const config = { ...readConfig(env, timing), helperPort: 0, helperListen: "127.0.0.1" }
  const secrets = takeSecrets({ GAMES_HELPER_TOKENS: o.tokens ?? helperTokens() })
  const m = { dir, bundles, stopping: false, clock: 1_000_000 } as Machine
  const real = makeLeaseBoard({
    bundles, timing, isStopping: () => m.stopping, ...(o.fakeClock ? { now: () => m.clock } : {})
  })
  const board = o.board ? o.board(real) : real
  const api = await startHelperApi({ config, secrets, board, isStopping: () => m.stopping, ...(o.lineup ? { lineup: o.lineup } : {}) })
  Object.assign(m, { board, api })
  machines.push(m)
  return m
}

interface Answer {
  readonly status: number
  readonly headers: http.IncomingHttpHeaders
  readonly text: string
  readonly bytes: Buffer
  readonly json: () => any
}

interface CallOptions {
  readonly body?: string | Buffer
  /** whose token (null: none) */
  readonly as?: string | null
  /** the x-helper-build header (null: none) */
  readonly build?: string | null
  readonly headers?: Record<string, string | Array<string>>
}

const call = (m: Machine, method: string, p: string, o: CallOptions = {}) =>
  new Promise<Answer>((resolve, reject) => {
    const headers: Record<string, string | Array<string>> = {}
    const as = o.as === undefined ? "eric" : o.as
    if (as !== null) headers.authorization = `Bearer ${TOKENS[as]}`
    const build = o.build === undefined ? "build-1" : o.build
    if (build !== null) headers["x-helper-build"] = build
    Object.assign(headers, o.headers)
    const req = http.request({ host: "127.0.0.1", port: m.api.port, method, path: p, headers, agent: false }, (res) => {
      const chunks: Array<Buffer> = []
      res.on("data", (c: Buffer) => chunks.push(c))
      res.on("end", () => {
        const bytes = Buffer.concat(chunks)
        const text = bytes.toString("utf8")
        resolve({ status: res.statusCode!, headers: res.headers, text, bytes, json: () => JSON.parse(text) })
      })
    })
    req.on("error", reject)
    req.end(o.body)
  })

/** a request written by hand on its own socket: the socket, and the answer's status line once the server closes */
const raw = (m: Machine, head: string, body = "") => {
  const socket = net.connect(m.api.port, "127.0.0.1")
  const answer = new Promise<string>((resolve) => {
    const chunks: Array<Buffer> = []
    socket.on("data", (c: Buffer) => chunks.push(c))
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")))
    socket.on("error", () => {})
  })
  socket.write(`${head}\r\n\r\n${body}`)
  return { socket, answer }
}

const rawHead = (method: string, p: string, extra: Array<string> = []) =>
  [`${method} ${p} HTTP/1.1`, "host: 127.0.0.1", `authorization: Bearer ${TOKENS.eric}`, "x-helper-build: build-1", ...extra].join("\r\n")

const eventually = async (f: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms
  while (!f()) {
    if (Date.now() > end) throw new Error("condition not met in time")
    await new Promise((r) => setTimeout(r, 10))
  }
}

const helloBody = (build = "build-1", cards = "cards-1") => JSON.stringify({ build, cards, slots: 2 })

/** a claim waiting on its own connection */
const claimAsync = async (m: Machine, as = "eric") => {
  const before = m.board.status().waiting
  const answer = call(m, "POST", "/v1/claim", { body: `{"slot":"1"}`, as })
  await eventually(() => m.board.status().waiting === before + 1)
  // wrapped: an async function returning the promise itself would wait for the answer
  return { answer }
}

/** a lease eric holds, its claim answered */
const lease = async (m: Machine, j = job(), bundles: Array<string> = []) => {
  const pending = await claimAsync(m)
  const offered = m.board.offer(j, bundles)
  assert.equal(offered.kind, "leased")
  const got = await pending.answer
  assert.equal(got.status, 200)
  assert.ok(offered.kind === "leased" && got.json().lease === offered.lease)
  await eventually(() => m.board.lease(offered.lease).state === "running")
  return offered.lease
}

const JSON_TYPE = "application/json; charset=utf-8"

test("the swarm's files: a helper token reads a listed file without the build header, even while stopping", async () => {
  const m = await setup()
  const a = await call(m, "GET", "/v1/swarm/manifest.json", { build: null })
  assert.equal(a.status, 200)
  assert.deepEqual(a.json(), { build: "build-1", cards: "cards-1" })
  assert.equal(a.headers["content-type"], "application/json")
  m.stopping = true
  assert.equal((await call(m, "GET", "/v1/swarm/manifest.json", { build: "other" })).status, 200)
})

test("the swarm's files: other names, missing files and no token are refused", async () => {
  const m = await setup()
  assert.equal((await call(m, "GET", "/v1/swarm/env", { build: null })).status, 404)
  assert.equal((await call(m, "GET", "/v1/swarm/..%2Fsecret", { build: null })).status, 404)
  assert.equal((await call(m, "GET", "/v1/swarm/constructor", { build: null })).status, 404)
  const missing = await call(m, "GET", "/v1/swarm/engine.json", { build: null })
  assert.equal(missing.status, 404)
  assert.deepEqual(missing.json(), { error: { code: "not_found", message: "this image has no swarm files" } })
  assert.equal((await call(m, "GET", "/v1/swarm/manifest.json", { as: null, build: null })).status, 401)
  // only GET reads them: anything else goes on to the build check and the routes
  assert.equal((await call(m, "POST", "/v1/swarm/manifest.json")).status, 404)
})

test("the swarm's files: the JEPA bot's models are two of them", async () => {
  const m = await setup()
  writeFileSync(path.join(m.dir, "app", "build", "swarm", "tx-t10.safetensors"), "model")
  const a = await call(m, "GET", "/v1/swarm/tx-t10.safetensors", { build: null })
  assert.equal(a.status, 200)
  assert.equal(a.text, "model")
  assert.equal(a.headers["content-type"], "application/octet-stream")
  assert.equal((await call(m, "GET", "/v1/swarm/tx-t10-e.safetensors", { build: null })).status, 404)
})

/** a lineup of four versions in roster order: b's tar is missing, c's is a link, a's and d's are there */
const tablesSetup = async () => {
  const hex = { a: sha256("tar a"), b: sha256("tar b"), c: sha256("tar c"), d: sha256("tar d"), other: sha256("other") }
  const m = await setup({
    lineup: async () => ({
      round: 7,
      capMs: 45000,
      bots: [{ name: "b-v1", bundle: hex.b }, { name: "a-v2", bundle: hex.a }, { name: "c-v1", bundle: hex.c }, { name: "d-v3", bundle: hex.d }]
    })
  })
  writeFileSync(path.join(m.bundles, `${hex.a}.tar`), "tar a")
  writeFileSync(path.join(m.bundles, `${hex.d}.tar`), "tar d body")
  writeFileSync(path.join(m.dir, "elsewhere.tar"), "tar c")
  symlinkSync(path.join(m.dir, "elsewhere.tar"), path.join(m.bundles, `${hex.c}.tar`))
  // a tar that is there but names no version of the lineup
  writeFileSync(path.join(m.bundles, `${hex.other}.tar`), "other")
  return { m, hex }
}

test("the tables' lineup: the latest round's versions whose tar is a regular file, in roster order, without the build header", async () => {
  const { m, hex } = await tablesSetup()
  const a = await call(m, "GET", "/v1/swarm/lineup.json", { build: null })
  assert.equal(a.status, 200)
  assert.equal(a.headers["content-type"], JSON_TYPE)
  assert.deepEqual(a.json(), { round: 7, capMs: 45000, bots: [{ bundle: hex.a, bytes: 5, name: "a-v2" }, { bundle: hex.d, bytes: 10, name: "d-v3" }] })
  // keys sorted, as every other answer's
  assert.equal(a.text, `{"bots":[{"bundle":"${hex.a}","bytes":5,"name":"a-v2"},{"bundle":"${hex.d}","bytes":10,"name":"d-v3"}],"capMs":45000,"round":7}`)
  // a tar written later is in the next answer
  writeFileSync(path.join(m.bundles, `${hex.b}.tar`), "tar b")
  assert.deepEqual((await call(m, "GET", "/v1/swarm/lineup.json", { build: null })).json().bots.map((b: any) => b.name), ["b-v1", "a-v2", "d-v3"])
  // any build header, or none, and still while the machine stops; never without a token
  assert.equal((await call(m, "GET", "/v1/swarm/lineup.json", { build: "other" })).status, 200)
  m.stopping = true
  assert.equal((await call(m, "GET", "/v1/swarm/lineup.json", { build: null })).status, 200)
  const nobody = await call(m, "GET", "/v1/swarm/lineup.json", { as: null, build: null })
  assert.equal(nobody.status, 401)
  assert.deepEqual(nobody.json(), { error: { code: "unauthorized", message: "a helper token is needed" } })
})

test("the tables' lineup before the first round, or with no lineup given, is empty", async () => {
  const none = await setup({ lineup: async () => null })
  const a = await call(none, "GET", "/v1/swarm/lineup.json", { build: null })
  assert.equal(a.status, 200)
  assert.equal(a.text, `{"bots":[],"capMs":null,"round":null}`)
  const bare = await setup()
  assert.equal((await call(bare, "GET", "/v1/swarm/lineup.json", { build: null })).text, `{"bots":[],"capMs":null,"round":null}`)
  const hex = sha256("tar a")
  writeFileSync(path.join(bare.bundles, `${hex}.tar`), "tar a")
  assert.equal((await call(bare, "GET", `/v1/swarm/bot/${hex}`, { build: null })).status, 404)
})

test("the tables' bots: the tar of a version in the lineup, without the build header; nothing else", async () => {
  const { m, hex } = await tablesSetup()
  const a = await call(m, "GET", `/v1/swarm/bot/${hex.a}`, { build: null })
  assert.equal(a.status, 200)
  assert.equal(a.text, "tar a")
  assert.equal(a.headers["content-type"], "application/x-tar")
  assert.equal(a.headers["content-length"], "5")
  assert.equal((await call(m, "GET", `/v1/swarm/bot/${hex.d}`, { build: "other" })).text, "tar d body")

  // in the lineup but its tar is missing or a link; a tar of no version in the lineup; not a sha256
  for (const p of [`/v1/swarm/bot/${hex.b}`, `/v1/swarm/bot/${hex.c}`, `/v1/swarm/bot/${hex.other}`, `/v1/swarm/bot/${hex.a.toUpperCase()}`,
    `/v1/swarm/bot/${hex.a}.tar`, `/v1/swarm/bot/${hex.a.slice(1)}`, "/v1/swarm/bot/..%2F..%2Fetc", "/v1/swarm/bot/constructor"]) {
    const no = await call(m, "GET", p, { build: null })
    assert.equal(no.status, 404, p)
    assert.deepEqual(no.json(), { error: { code: "not_found" } })
  }

  // still while the machine stops; never without a token; only GET
  m.stopping = true
  assert.equal((await call(m, "GET", `/v1/swarm/bot/${hex.a}`, { build: null })).status, 200)
  m.stopping = false
  assert.equal((await call(m, "GET", `/v1/swarm/bot/${hex.a}`, { as: null, build: null })).status, 401)
  assert.equal((await call(m, "POST", `/v1/swarm/bot/${hex.a}`)).status, 404)
})

test("a token whose sha256 is listed gets in, by its name", async () => {
  const m = await setup()
  const a = await call(m, "POST", "/v1/hello", { body: helloBody() })
  assert.equal(a.status, 200)
  assert.equal(a.headers["content-type"], JSON_TYPE)
  assert.deepEqual(a.json(), { ok: true, name: "eric", heartbeatMs: 30_000, leaseLostMs: 90_000, claimMs: 2_000 })
  // the bytes the Elixir machine sent (Jason writes small maps' keys sorted)
  assert.equal(a.text, `{"claimMs":2000,"heartbeatMs":30000,"leaseLostMs":90000,"name":"eric","ok":true}`)
  assert.equal((await call(m, "POST", "/v1/hello", { body: helloBody(), as: "bob" })).json().name, "bob")
  assert.deepEqual(m.board.status().hosts, ["bob", "eric"])
  assert.ok(lines.some((l) => l.trimEnd().endsWith("[info] helper eric said hello (2 slots)")))
  const many = await call(m, "POST", "/v1/hello", { body: JSON.stringify({ build: "build-1", cards: "cards-1", slots: 500 }) })
  assert.equal(many.status, 200)
  assert.ok(lines.some((l) => l.trimEnd().endsWith("helper eric said hello (99 slots)")))
})

test("a bad, missing or malformed authorization is 401, before anything else is looked at", async () => {
  const m = await setup()
  const tries = [
    call(m, "POST", "/v1/hello", { body: helloBody(), as: null }),
    call(m, "POST", "/v1/hello", { body: helloBody(), as: null, headers: { authorization: "Bearer not-a-token" } }),
    call(m, "POST", "/v1/hello", { body: helloBody(), as: null, headers: { authorization: "Bearer " } }),
    call(m, "POST", "/v1/hello", { body: helloBody(), as: null, headers: { authorization: TOKENS.eric! } }),
    call(m, "POST", "/v1/hello", { body: helloBody(), as: null, headers: { authorization: `bearer ${TOKENS.eric}` } }),
    call(m, "POST", "/v1/hello", { body: helloBody(), as: null, headers: { authorization: `Bearer ${sha256(TOKENS.eric!)}` } }),
    // two authorization lines, even two good ones (Node would keep only the first)
    call(m, "POST", "/v1/hello", { body: helloBody(), as: null, headers: { authorization: [`Bearer ${TOKENS.eric}`, `Bearer ${TOKENS.eric}`] } }),
    call(m, "GET", "/v1/nowhere", { as: null, build: "other" }),
    call(m, "GET", "/", { as: null })
  ]
  for (const a of await Promise.all(tries)) {
    assert.equal(a.status, 401)
    assert.deepEqual(a.json(), { error: { code: "unauthorized", message: "a helper token is needed" } })
  }
  assert.deepEqual(m.board.status().hosts, [])
})

test("a malformed GAMES_HELPER_TOKENS entry lets nobody in by it; the others still work", async () => {
  const carl = "carl-token-0123456789abcdef0123456789"
  const m = await setup({ tokens: `eric:${sha256(TOKENS.eric!)},carl:${sha256(carl).toUpperCase()}` })
  const a = await call(m, "POST", "/v1/hello", { body: helloBody(), as: null, headers: { authorization: `Bearer ${carl}` } })
  assert.equal(a.status, 401)
  assert.equal((await call(m, "POST", "/v1/hello", { body: helloBody() })).status, 200)
})

test("another build in the header is 409, naming the build, the cards and the image to run", async () => {
  const m = await setup()
  const a = await call(m, "POST", "/v1/claim", { body: `{"slot":"1"}`, build: "build-0" })
  assert.equal(a.status, 409)
  assert.deepEqual(a.json(), {
    error: {
      code: "build",
      message: "the games machine runs build build-1",
      want: { build: "build-1", cards: "cards-1", image: "registry.fly.io/swu-arena-games:build-1" }
    }
  })
  assert.equal(a.text, `{"error":{"code":"build","message":"the games machine runs build build-1","want":{"build":"build-1","cards":"cards-1","image":"registry.fly.io/swu-arena-games:build-1"}}}`)
  assert.equal((await call(m, "POST", "/v1/claim", { body: `{"slot":"1"}`, build: null })).status, 409)
  assert.equal((await call(m, "POST", "/v1/claim", { body: `{"slot":"1"}`, build: null, headers: { "x-helper-build": ["build-1", "build-1"] } })).status, 409)
  assert.equal(m.board.status().waiting, 0)
})

test("an old helper of another build gets 409 on hello, claim and heartbeat, and 401 for a token nobody knows", async () => {
  const m = await setup({ env: { GAMES_HELPER_IMAGE: "registry.fly.io/swu-arena-games" } })
  const id = await lease(m)
  const old = { build: "0123456789abcdef0123456789abcdef01234567" }
  for (const a of [
    await call(m, "POST", "/v1/hello", { ...old, body: helloBody(old.build) }),
    await call(m, "POST", "/v1/claim", { ...old, body: `{"slot":"1"}` }),
    await call(m, "POST", `/v1/lease/${id}/heartbeat`, { ...old, body: "" })
  ]) {
    assert.equal(a.status, 409)
    assert.equal(a.json().error.code, "build")
    assert.equal(a.json().error.want.image, "registry.fly.io/swu-arena-games:build-1")
  }
  const stranger = await call(m, "POST", "/v1/hello", { ...old, as: null, headers: { authorization: `Bearer ${"s".repeat(40)}` }, body: helloBody(old.build) })
  assert.equal(stranger.status, 401)
})

test("hello checks the build and the cards in its body too, and adds no host when they differ", async () => {
  const m = await setup()
  assert.equal((await call(m, "POST", "/v1/hello", { body: helloBody("build-0") })).status, 409)
  const cards = await call(m, "POST", "/v1/hello", { body: helloBody("build-1", "cards-0") })
  assert.equal(cards.status, 409)
  assert.equal(cards.json().error.want.cards, "cards-1")
  assert.deepEqual(m.board.status().hosts, [])
})

test("an unknown build never matches, not even another unknown one; nor do unknown cards", async () => {
  const app = mkdtempSync(path.join(tmpdir(), "games-app-"))
  const m = await setup({ app, env: { GAMES_BUILD: "", GAMES_CARDS: "" } })
  assert.equal((await call(m, "POST", "/v1/hello", { body: helloBody("unknown", "unknown"), build: "unknown" })).status, 409)

  const app2 = mkdtempSync(path.join(tmpdir(), "games-app-"))
  writeFileSync(path.join(app2, "BUILD_SHA"), "abc123\n")
  const n = await setup({ app: app2, env: { GAMES_BUILD: "", GAMES_CARDS: "" } })
  assert.equal((await call(n, "POST", "/v1/hello", { body: helloBody("abc123", "unknown"), build: "abc123" })).status, 409)
})

test("the build and the cards are read from BUILD_SHA and CARDS_SHA when GAMES_BUILD and GAMES_CARDS are unset", async () => {
  const app = mkdtempSync(path.join(tmpdir(), "games-app-"))
  writeFileSync(path.join(app, "BUILD_SHA"), "abc123\n")
  writeFileSync(path.join(app, "CARDS_SHA"), "f00d\n")
  const m = await setup({ app, env: { GAMES_BUILD: "", GAMES_CARDS: "" } })
  assert.equal((await call(m, "POST", "/v1/hello", { body: helloBody("abc123", "f00d"), build: "abc123" })).status, 200)
})

test("a waiting claim gets the offer at once: the lease, the job, its bundles and the deadline", async () => {
  const m = await setup()
  const hex = sha256("tar")
  writeFileSync(path.join(m.bundles, `${hex}.tar`), "tar")
  const pending = await claimAsync(m)
  assert.equal(m.board.status().waiting, 1)
  const j = job(77)
  const offered = m.board.offer(j, [hex])
  assert.ok(offered.kind === "leased" && offered.host === "eric")
  const a = await pending.answer
  assert.equal(a.status, 200)
  assert.equal(a.headers["content-type"], JSON_TYPE)
  assert.deepEqual(a.json(), { lease: offered.lease, job: j, bundles: [{ id: hex, bytes: 3 }], deadlineMs: 840_000 + 300_000 })
  // the envelope in Jason's order, the job in the round's (play-seed compares deck lists by their JSON text)
  assert.ok(a.text.startsWith(`{"bundles":[{"bytes":3,"id":"${hex}"}],"deadlineMs":1140000,"job":${JSON.stringify(j)},"lease":`))
  assert.equal(m.board.status().waiting, 0)
  await eventually(() => m.board.lease(offered.lease).state === "running")
})

test("a claim that waits claimMs for nothing gets 204, and no longer waits", async () => {
  const m = await setup({ timing: { claimMs: 300 } })
  const t0 = Date.now()
  const a = await call(m, "POST", "/v1/claim", { body: `{"slot":"s-1"}` })
  assert.equal(a.status, 204)
  assert.equal(a.text, "")
  assert.equal(a.headers["content-type"], undefined)
  assert.ok(Date.now() - t0 >= 295)
  assert.equal(m.board.status().waiting, 0)
})

test("offers go to the claim that waited longest", async () => {
  const m = await setup()
  const first = await claimAsync(m, "bob")
  const second = await claimAsync(m, "eric")
  assert.ok(m.board.offer(job(1), []).kind === "leased")
  assert.ok(m.board.offer(job(2), []).kind === "leased")
  assert.equal((await first.answer).json().job.seed, 1)
  assert.equal((await second.answer).json().job.seed, 2)
})

test("a claim needs a slot id of at most 32 characters", async () => {
  const m = await setup()
  for (const body of [`{}`, `{"slot":""}`, `{"slot":"a/b"}`, `{"slot":"${"s".repeat(33)}"}`, `{"slot":1}`, "[1]"]) {
    const a = await call(m, "POST", "/v1/claim", { body })
    assert.equal(a.status, 400, body)
    assert.equal(a.json().error.code, "bad_request")
  }
  assert.deepEqual((await call(m, "POST", "/v1/claim", { body: `{}` })).json(), { error: { code: "bad_request", message: "claim needs a slot id" } })
})

test("a helper that goes away while its claim waits no longer waits", async () => {
  const m = await setup()
  const body = `{"slot":"1"}`
  const r = raw(m, rawHead("POST", "/v1/claim", [`content-length: ${body.length}`]), body)
  await eventually(() => m.board.status().waiting === 1)
  r.socket.destroy()
  await eventually(() => m.board.status().waiting === 0)
  assert.deepEqual(m.board.offer(job(), []), { kind: "none" })
})

test("a claim whose answer cannot be sent gives the lease back (claim dropped)", async () => {
  const m = await setup({ timing: { leaseAckMs: 200, sweepMs: 50 } })
  const body = `{"slot":"1"}`
  const r = raw(m, rawHead("POST", "/v1/claim", [`content-length: ${body.length}`]), body)
  await eventually(() => m.board.status().waiting === 1)
  // the helper is gone before the machine sees it: the offer still goes to its claim
  r.socket.resetAndDestroy()
  const offered = m.board.offer(job(), [])
  assert.equal(offered.kind, "leased")
  assert.ok(offered.kind === "leased")
  let state: ReturnType<LeaseBoardImpl["lease"]> = { state: "unknown" }
  await eventually(() => {
    state = m.board.lease(offered.lease)
    return state.state !== "running"
  })
  assert.deepEqual(state, { state: "lost", host: "eric", reason: "claim dropped" })
})

test("a helper gets a bundle only while it holds a lease that names it", async () => {
  const m = await setup()
  const hex = sha256("tar body")
  const other = sha256("other")
  writeFileSync(path.join(m.bundles, `${hex}.tar`), "tar body")
  writeFileSync(path.join(m.bundles, `${other}.tar`), "other")
  assert.equal((await call(m, "GET", `/v1/bundle/${hex}`)).status, 404)

  const id = await lease(m, job(), [hex])
  const a = await call(m, "GET", `/v1/bundle/${hex}`)
  assert.equal(a.status, 200)
  assert.equal(a.text, "tar body")
  assert.equal(a.headers["content-type"], "application/x-tar")
  assert.equal(a.headers["content-length"], "8")

  assert.equal((await call(m, "GET", `/v1/bundle/${hex}`, { as: "bob" })).status, 404)
  assert.equal((await call(m, "GET", `/v1/bundle/${other}`)).status, 404)
  const dots = await call(m, "GET", "/v1/bundle/../../etc")
  assert.equal(dots.status, 404)
  assert.deepEqual(dots.json(), { error: { code: "not_found" } })
  assert.equal((await call(m, "GET", `/v1/bundle/${hex.toUpperCase()}`)).status, 404)

  assert.equal((await call(m, "POST", `/v1/lease/${id}/result`, { body: `{"failed":"x"}` })).status, 200)
  assert.equal((await call(m, "GET", `/v1/bundle/${hex}`)).status, 404)
})

test("heartbeats and results go on while the lease is held; a result is stored as it came, read once", async () => {
  const m = await setup()
  const id = await lease(m)
  const beat = await call(m, "POST", `/v1/lease/${id}/heartbeat`)
  assert.equal(beat.status, 200)
  assert.equal(beat.text, `{"continue":true}`)
  // the window sends {} as a heartbeat's body
  assert.equal((await call(m, "POST", `/v1/lease/${id}/heartbeat`, { body: "{}" })).status, 200)

  const results = [{ id: "a", result: { outcome: "won", ms: 1.5 } }, { id: "b", result: { x: 1 } }]
  const replays = { a: "{\"t\":\"header\"}\n" }
  const a = await call(m, "POST", `/v1/lease/${id}/result`, { body: JSON.stringify({ results, replays }) })
  assert.equal(a.status, 200)
  assert.equal(a.text, `{"ok":true}`)

  // done: a second result or a heartbeat is 410
  assert.equal((await call(m, "POST", `/v1/lease/${id}/heartbeat`)).status, 410)
  assert.equal((await call(m, "POST", `/v1/lease/${id}/result`, { body: `{"failed":"again"}` })).status, 410)

  // the round reads it once
  assert.deepEqual(m.board.lease(id), { state: "done", host: "eric", results, replays })
  assert.deepEqual(m.board.lease(id), { state: "unknown" })
})

test("a result without replays has none", async () => {
  const m = await setup()
  const id = await lease(m)
  assert.equal((await call(m, "POST", `/v1/lease/${id}/result`, { body: `{"results":[]}` })).status, 200)
  assert.deepEqual(m.board.lease(id), { state: "done", host: "eric", results: [], replays: {} })
})

test("a heartbeat or result for another helper's lease, or an unknown one, is 410", async () => {
  const m = await setup()
  const id = await lease(m)
  const bob = await call(m, "POST", `/v1/lease/${id}/heartbeat`, { as: "bob" })
  assert.equal(bob.status, 410)
  assert.deepEqual(bob.json(), { error: { code: "gone" } })
  assert.equal((await call(m, "POST", `/v1/lease/${id}/result`, { body: `{"failed":"x"}`, as: "bob" })).status, 410)
  assert.equal((await call(m, "POST", "/v1/lease/unknown/heartbeat")).status, 410)
  assert.equal((await call(m, "POST", "/v1/lease/b%2Fad/heartbeat")).status, 410)
  assert.equal((await call(m, "POST", `/v1/lease/${"x".repeat(65)}/result`, { body: `{"failed":"x"}` })).status, 410)
  assert.equal(m.board.lease(id).state, "running")
})

test("a revoked lease is 410 for its heartbeat and its result, and unknown to the round", async () => {
  const m = await setup()
  const id = await lease(m)
  m.board.revoke(id)
  assert.equal((await call(m, "POST", `/v1/lease/${id}/heartbeat`)).status, 410)
  assert.equal((await call(m, "POST", `/v1/lease/${id}/result`, { body: `{"results":[],"replays":{}}` })).status, 410)
  assert.deepEqual(m.board.lease(id), { state: "unknown" })
})

test("a failed lease is lost with its reason, cut to 300 characters, read once", async () => {
  const m = await setup()
  const id = await lease(m)
  assert.equal((await call(m, "POST", `/v1/lease/${id}/result`, { body: JSON.stringify({ failed: "r".repeat(400) }) })).status, 200)
  assert.deepEqual(m.board.lease(id), { state: "lost", host: "eric", reason: "r".repeat(300) })
  assert.deepEqual(m.board.lease(id), { state: "unknown" })
})

test("a result counts as a heartbeat when it arrives, so a slow upload keeps its lease", async () => {
  const m = await setup({ fakeClock: true })
  const id = await lease(m)
  m.clock += 80_000
  assert.equal((await call(m, "POST", `/v1/lease/${id}/result`, { body: "not json" })).status, 400)
  m.clock += 60_000
  m.board.sweep()
  assert.equal(m.board.lease(id).state, "running")
  m.clock += 30_001
  m.board.sweep()
  assert.deepEqual(m.board.lease(id), { state: "lost", host: "eric", reason: "no heartbeat" })
})

test("a result that is neither {results, replays} nor {failed} is 400 and changes nothing", async () => {
  const m = await setup()
  const id = await lease(m)
  for (const bad of [
    `{}`,
    `{"results":{}}`,
    `{"results":[{"id":1,"result":{}}]}`,
    `{"results":[{"id":"a"}]}`,
    `{"results":[{"id":"a","result":[]}]}`,
    `{"results":[],"replays":{"a":1}}`,
    `{"results":[],"replays":null}`,
    `{"results":[],"replays":[]}`,
    `{"failed":1}`,
    `[]`,
    "not json"
  ]) {
    const a = await call(m, "POST", `/v1/lease/${id}/result`, { body: bad })
    assert.equal(a.status, 400, bad)
  }
  const shape = await call(m, "POST", `/v1/lease/${id}/result`, { body: `{}` })
  assert.deepEqual(shape.json(), { error: { code: "bad_request", message: "a result is {results, replays} or {failed}" } })
  // JSON must be UTF-8, as Jason read it
  const latin = Buffer.concat([Buffer.from(`{"failed":"`), Buffer.from([0xe9]), Buffer.from(`"}`)])
  const notUtf8 = await call(m, "POST", `/v1/lease/${id}/result`, { body: latin })
  assert.equal(notUtf8.status, 400)
  assert.deepEqual(notUtf8.json(), { error: { code: "bad_request", message: "the body is not a JSON object" } })
  assert.equal(m.board.lease(id).state, "running")
})

test("bodies over a route's limit are 413", async () => {
  const m = await setup()
  const big = JSON.stringify({ build: "build-1", cards: "c".repeat(5_000), slots: 1 })
  const hello = await call(m, "POST", "/v1/hello", { body: big })
  assert.equal(hello.status, 413)
  assert.deepEqual(hello.json(), { error: { code: "too_large", message: "request body over 4096 bytes" } })
  assert.equal((await call(m, "POST", "/v1/claim", { body: " ".repeat(4_097) })).status, 413)
  const id = await lease(m)
  assert.equal((await call(m, "POST", `/v1/lease/${id}/heartbeat`, { body: "x".repeat(4_097) })).status, 413)

  // a declared length over the limit is refused before reading
  const declared = raw(m, rawHead("POST", `/v1/lease/${id}/result`, ["content-length: 40000001"]), "{}")
  const answer = await declared.answer
  assert.match(answer, /^HTTP\/1\.1 413 /)
  assert.ok(answer.includes(`{"error":{"code":"too_large","message":"request body over 40000000 bytes"}}`))

  const over = `{"failed":"${"x".repeat(40_000_001 - 13)}"}`
  assert.equal(Buffer.byteLength(over), 40_000_001)
  assert.equal((await call(m, "POST", `/v1/lease/${id}/result`, { body: over })).status, 413)
  assert.equal(m.board.lease(id).state, "running")
})

test("while the machine stops everything is 503, and a waiting claim gives up within a second", async () => {
  const m = await setup({ timing: { claimMs: 10_000 } })
  const pending = await claimAsync(m)
  const t0 = Date.now()
  m.stopping = true
  const a = await pending.answer
  assert.ok(Date.now() - t0 < 1_500)
  assert.equal(a.status, 503)
  assert.equal(a.text, `{"error":{"code":"stopping"}}`)
  assert.equal(m.board.status().waiting, 0)
  assert.equal((await call(m, "POST", "/v1/hello", { body: helloBody() })).status, 503)
  assert.equal((await call(m, "POST", "/v1/claim", { body: `{"slot":"1"}` })).status, 503)
  // the token and the build are still checked first
  assert.equal((await call(m, "POST", "/v1/claim", { body: `{"slot":"1"}`, as: null })).status, 401)
  assert.equal((await call(m, "POST", "/v1/claim", { body: `{"slot":"1"}`, build: "build-0" })).status, 409)
})

test("unknown routes are 404, bad JSON and a bad hello are 400", async () => {
  const m = await setup()
  for (const [method, p] of [["GET", "/v1/hello"], ["POST", "/v2/hello"], ["GET", "/"], ["POST", "/v1/%68ello"], ["POST", "/v1/lease/x/beat"]] as const) {
    const a = await call(m, method, p, method === "POST" ? { body: helloBody() } : {})
    assert.equal(a.status, 404, p)
    assert.deepEqual(a.json(), { error: { code: "not_found" } })
  }
  // empty segments and a query are not part of the route (Plug's path_info)
  assert.equal((await call(m, "POST", "//v1//hello?x=1", { body: helloBody() })).status, 200)
  assert.equal((await call(m, "POST", "/v1/hello", { body: "not json" })).status, 400)
  for (const body of [`{"build":"build-1"}`, `{"build":"build-1","cards":"cards-1","slots":2.0}`, `{"build":"build-1","cards":"cards-1","slots":2e0}`, `{"build":"build-1","cards":"cards-1","slots":"2"}`, `{"build":1,"cards":"cards-1","slots":2}`]) {
    const a = await call(m, "POST", "/v1/hello", { body })
    assert.equal(a.status, 400, body)
    assert.deepEqual(a.json(), { error: { code: "bad_request", message: "hello needs build, cards and slots" } })
  }
  assert.deepEqual(m.board.status().hosts, ["eric"])
})

test("anything that throws is a 500 that names no path and no token", async () => {
  const m = await setup({
    board: (b) => ({ ...b, heartbeat: () => {
      throw new TypeError("boom")
    } })
  })
  const a = await call(m, "POST", "/v1/lease/abc/heartbeat")
  assert.equal(a.status, 500)
  assert.deepEqual(a.json(), { error: { code: "internal", message: "the games machine could not answer" } })
  const line = lines.find((l) => l.includes("helper API:"))
  assert.equal(line?.trimEnd().slice(13), "[error] helper API: TypeError raised")
})

test("the listener: its own address, IPv6 falls back only to a narrower one, off without a port", async () => {
  assert.equal(await listenAddress("127.0.0.1"), "127.0.0.1")
  // an IPv6 address this machine does not have
  assert.equal(await listenAddress("fd00::dead:beef"), "127.0.0.1")
  assert.ok(lines.some((l) => l.includes("no IPv6 here: listening on 127.0.0.1 instead of fd00::dead:beef")))
  assert.ok(["::", "0.0.0.0"].includes(await listenAddress("::")))
  const m = await setup()
  assert.equal(m.api.host, "127.0.0.1")
  assert.ok(m.api.port > 0)
  const c = { ...readConfig({ GAMES_DATA: m.dir }), helperPort: null }
  const s = takeSecrets({ GAMES_HELPER_TOKENS: helperTokens() })
  await assert.rejects(startHelperApi({ config: c, secrets: s, board: m.board, isStopping: () => false }))
  assert.equal(helperNodeOn(c, s), false)
  assert.equal(helperNodeOn({ ...c, helperPort: 8090 }, s), true)
  assert.equal(helperNodeOn({ ...c, helperPort: 8090 }, takeSecrets({ GAMES_HELPER_TOKENS: "bad entry" })), false)
})

test("Plug's path_info: split on slashes, empty segments dropped, nothing decoded", () => {
  assert.deepEqual(pathInfo("/v1/lease/b%2Fad/heartbeat"), ["v1", "lease", "b%2Fad", "heartbeat"])
  assert.deepEqual(pathInfo("//v1//hello/?a=/b"), ["v1", "hello"])
  assert.deepEqual(pathInfo("http://machine:8090/v1/claim"), ["v1", "claim"])
  assert.deepEqual(pathInfo(undefined), [])
})

test("no log line holds a token or a request's path", () => {
  // runs last: every line the tests above caught
  assert.ok(allLines.length > 10)
  for (const l of allLines) {
    for (const t of Object.values(TOKENS)) assert.ok(!l.includes(t))
    assert.ok(!l.includes("/v1/"))
  }
})
