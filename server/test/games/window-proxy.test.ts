import assert from "node:assert/strict"
import http from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { after, before, beforeEach, test } from "node:test"
import { setSink } from "../../src/games/Log.ts"
import { allow, parseTarget, request, startWindowProxy } from "../../src/games/WindowProxy.ts"
import type { WindowProxy } from "../../src/games/WindowProxy.ts"

const TOKEN = "the-window-token"
const nonces = { push: "push-nonce-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", intake: "intake-nonce-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" }

interface Seen {
  readonly method: string
  readonly url: string
  readonly auth: string | undefined
  readonly contentType: string | undefined
  readonly arena: string | string[] | undefined
  readonly cookie: string | undefined
  readonly body: Buffer
}

// the window: it records what it saw and answers with `answer`
let seen: Array<Seen> = []
let answer: (req: IncomingMessage, res: ServerResponse) => void
const plainAnswer = (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify({ result: "ok" }))
}
const window = http.createServer((req, res) => {
  const chunks: Array<Buffer> = []
  req.on("data", (c: Buffer) => chunks.push(c))
  req.on("end", () => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, contentType: req.headers["content-type"],
      arena: req.headers["x-swu-arena"], cookie: req.headers.cookie, body: Buffer.concat(chunks) })
    answer(req, res)
  })
})
let windowUrl = ""
let proxy: WindowProxy
let v2Proxy: WindowProxy
const logs: Array<string> = []

before(async () => {
  setSink((l) => logs.push(l))
  await new Promise<void>((r) => window.listen(0, "127.0.0.1", r))
  windowUrl = `http://127.0.0.1:${(window.address() as { port: number }).port}`
  proxy = await startWindowProxy({ window: windowUrl, token: () => TOKEN, nonces, port: 0 })
  v2Proxy = await startWindowProxy({ window: windowUrl, arena: "v2", token: () => TOKEN, nonces, port: 0 })
})

after(async () => {
  await proxy.close()
  await v2Proxy.close()
  await new Promise((r) => window.close(r))
})

beforeEach(() => {
  seen = []
  answer = plainAnswer
})

const base = () => `http://127.0.0.1:${proxy.port}`
const push = (p: string) => `/p/${nonces.push}${p}`
const intake = (p: string) => `/i/${nonces.intake}${p}`

const call = (method: string, path: string, body: string | Buffer | null = null, headers: Record<string, string> = {}) =>
  request(base(), path, { method, headers, body: body === null ? null : Buffer.from(body), timeoutMs: 10_000, maxBytes: 64 << 20 })

const forwarded = async (method: string, path: string, body: string | null = null) => {
  const before = seen.length
  const r = await call(method, path, body)
  return r.status === 200 && seen.length === before + 1
}

const refused = async (method: string, path: string, body: string | null = null) => {
  const before = seen.length
  const r = await call(method, path, body)
  return r.status === 403 && seen.length === before && JSON.parse(r.body.toString()).error.code === "forbidden"
}

test("push may write the arena's documents and its runs' replays", async () => {
  for (const collection of ["arena", "runs", "ladders", "panels", "experiments"]) {
    assert.ok(await forwarded("PUT", push(`/api/docs/${collection}/report-3`), "{\"a\":1}"), collection)
  }
  assert.ok(await forwarded("GET", push("/api/replays/arena-r4?sizes=1")))
  assert.ok(await forwarded("POST", push("/api/replays/arena-r4/g001?at=120"), "line\n"))
  assert.ok(await forwarded("PUT", push("/api/replays/arena-r4/g001"), "line\n"))
})

test("push may do nothing else", async () => {
  assert.ok(await refused("PUT", push("/api/docs/submissions/s1"), "{}"))
  assert.ok(await refused("GET", push("/api/docs/submissions")))
  assert.ok(await refused("PUT", push("/api/docs/admin/invites"), "{}"))
  assert.ok(await refused("GET", push("/api/docs/arena/standings")))
  assert.ok(await refused("DELETE", push("/api/docs/arena/standings")))
  assert.ok(await refused("PUT", push("/api/docs/arena/standings/more"), "{}"))
  assert.ok(await refused("PUT", push("/api/docs/arena/standings?x=1"), "{}"))
  assert.ok(await refused("GET", push("/api/replays/arena-r4")))
  assert.ok(await refused("GET", push("/api/replays/arena-r4?sizes=1&x=2")))
  assert.ok(await refused("POST", push("/api/replays/arena-r4/g001"), "x\n"))
  assert.ok(await refused("POST", push("/api/replays/arena-r4/g001?at=x"), "x\n"))
  assert.ok(await refused("PUT", push("/api/replays/arena-r4/g001?at=1"), "x\n"))
  assert.ok(await refused("DELETE", push("/api/replays/arena-r4/g001")))
})

test("a replay outside the arena's runs is refused", async () => {
  assert.ok(await refused("PUT", push("/api/replays/ladder-7/g001"), "x\n"))
  assert.ok(await refused("GET", push("/api/replays/other?sizes=1")))
  assert.ok(await refused("POST", push("/api/replays/arena-/g001?at=0"), "x\n"))
  assert.ok(await refused("POST", push("/api/replays/arena-r4!/g001?at=0"), "x\n"))
})

test("intake may read and write submissions, and nothing else", async () => {
  assert.ok(await forwarded("GET", intake("/api/docs/submissions")))
  assert.ok(await forwarded("GET", intake("/api/docs/submissions/s-1")))
  assert.ok(await forwarded("PUT", intake("/api/docs/submissions/s-1"), "{}"))
  assert.ok(await refused("POST", intake("/api/docs/submissions"), "{}"))
  assert.ok(await refused("PUT", intake("/api/docs/submissions"), "{}"))
  assert.ok(await refused("DELETE", intake("/api/docs/submissions/s-1")))
  assert.ok(await refused("PUT", intake("/api/docs/arena/standings"), "{}"))
  assert.ok(await refused("GET", intake("/api/replays/arena-r4?sizes=1")))
  assert.ok(await refused("GET", intake("/api/docs/submissions?all=1")))
})

test("a wrong or missing nonce is refused", async () => {
  assert.ok(await refused("PUT", `/p/${nonces.intake}/api/docs/arena/x`, "{}"))
  assert.ok(await refused("GET", `/i/${nonces.push}/api/docs/submissions`))
  assert.ok(await refused("PUT", "/p/not-the-nonce/api/docs/arena/x", "{}"))
  assert.ok(await refused("PUT", "/p//api/docs/arena/x", "{}"))
  assert.ok(await refused("PUT", "/api/docs/arena/x", "{}"))
  assert.ok(await refused("GET", "/"))
  assert.ok(await refused("GET", `/x/${nonces.push}/api/docs/arena/x`))
})

test(".. and encoded slashes are refused", async () => {
  assert.ok(await refused("PUT", push("/api/docs/arena/../submissions"), "{}"))
  assert.ok(await refused("PUT", push("/api/docs/arena/%2e%2e"), "{}"))
  assert.ok(await refused("PUT", push("/api/docs/arena/..%2F..%2Fadmin"), "{}"))
  assert.ok(await refused("PUT", push("/api/docs/arena/a%2Fb"), "{}"))
  assert.ok(await refused("GET", intake("/api/docs/submissions/%2E%2E")))
  assert.ok(await refused("GET", intake("/api/docs/submissions/a..b")))
  assert.ok(await refused("GET", intake("/api/docs/submissions/a%5Cb")))
  assert.ok(await refused("GET", intake("/api/docs/submissions/a%0Ab")))
  assert.ok(await refused("GET", intake("/api/docs/submissions/%E0%A4%A")))
})

test("a . segment, plain or encoded, is refused (the window's URL parser would drop it)", async () => {
  assert.equal(parseTarget(push("/api/docs/arena/."), nonces), null)
  assert.ok(await refused("PUT", push("/api/docs/arena/."), "{}"))
  assert.ok(await refused("POST", push("/api/replays/arena-r4/.?at=0"), "x\n"))
  assert.ok(await refused("PUT", intake("/api/docs/submissions/%2e"), "{}"))
  assert.ok(await refused("PUT", push("/api/replays/arena-r4/%2E"), "x\n"))
})

test("the allow-list, as a table", () => {
  assert.equal(allow("push", "PUT", ["api", "docs", "runs", "arena-r3"], ""), 16_000_000)
  assert.equal(allow("push", "POST", ["api", "replays", "arena-r3", "g"], "at=0"), 8_000_000)
  assert.equal(allow("push", "PUT", ["api", "replays", "arena-r3", "g"], ""), 32_000_000)
  assert.equal(allow("push", "GET", ["api", "replays", "arena-r3"], "sizes=1"), 0)
  assert.equal(allow("intake", "PUT", ["api", "docs", "submissions", "s"], ""), 16_000_000)
  assert.equal(allow("intake", "GET", ["api", "docs", "submissions"], ""), 0)
  assert.equal(allow("intake", "PUT", ["api", "docs", "runs", "arena-r3"], ""), null)
  assert.equal(allow("push", "PUT", ["api", "docs", "submissions", "s"], ""), null)
})

test("the token replaces whatever authorization came in, and the path goes on as it came", async () => {
  const r = await call("PUT", intake("/api/docs/submissions/a%20b"), "{}", { authorization: "Bearer evil", "content-type": "application/json" })
  assert.equal(r.status, 200)
  const s = seen.at(-1)!
  assert.equal(s.auth, `Bearer ${TOKEN}`)
  assert.equal(s.method, "PUT")
  assert.equal(s.url, "/api/docs/submissions/a%20b")
  assert.equal(s.body.toString(), "{}")
  assert.equal(s.contentType, "application/json")
})

test("the default legacy proxy injects open instead of trusting a child's arena header", async () => {
  for (const headers of [{}, { "x-swu-arena": "v2" }]) {
    const r = await call("PUT", push("/api/docs/arena/status"), "{}", headers)
    assert.equal(r.status, 200)
    assert.equal(seen.at(-1)!.arena, "open")
  }
})

test("the configured v2 proxy scopes push and intake with trusted headers and preserves upstream responses", async () => {
  answer = (req, res) => {
    const accepted = req.headers["x-swu-arena"] === "v2" && req.headers.authorization === `Bearer ${TOKEN}`
    res.writeHead(accepted ? 200 : 409, { "content-type": "application/json" })
    res.end(JSON.stringify(accepted ? { result: "v2 scoped" } : { error: { code: "conflict", message: "v2 scope required" } }))
  }
  for (const [method, route, body] of [
    ["PUT", push("/api/docs/arena/status"), "{\"arenaId\":\"v2\"}"],
    ["GET", push("/api/replays/arena-v2-r4?sizes=1"), null],
    ["GET", intake("/api/docs/submissions"), null],
    ["PUT", intake("/api/docs/submissions/scope-fixture"), "{\"state\":\"accepted\"}"]
  ] as const) {
    for (const arena of [undefined, "open", "v2", "untrusted"]) {
      const r = await request(`http://127.0.0.1:${v2Proxy.port}`, route, {
        method, body: body === null ? null : Buffer.from(body), timeoutMs: 10_000,
        headers: { ...(arena === undefined ? {} : { "x-swu-arena": arena }), authorization: "Bearer child-supplied",
          "content-type": "application/json", cookie: "synthetic=child-cookie" }
      })
      assert.equal(r.status, 200, `${method} ${route}`)
      assert.equal(r.contentType, "application/json")
      assert.deepEqual(JSON.parse(r.body.toString()), { result: "v2 scoped" })
      const upstream = seen.at(-1)!
      assert.equal(upstream.arena, "v2")
      assert.equal(upstream.auth, `Bearer ${TOKEN}`)
      assert.equal(upstream.cookie, undefined, "child credentials remain outside the upstream header allow-list")
      assert.equal(upstream.body.toString(), body ?? "")
    }
  }
})

test("configured v2 scope does not expand either role's paths or accepted nonces", async () => {
  for (const route of [push("/api/docs/submissions"), intake("/api/docs/arena/status"), "/p/wrong-nonce/api/replays/arena-v2-r4?sizes=1"]) {
    const before = seen.length
    const r = await request(`http://127.0.0.1:${v2Proxy.port}`, route, { method: "GET", body: null,
      headers: { "x-swu-arena": "v2" }, timeoutMs: 10_000 })
    assert.equal(r.status, 403)
    assert.equal(seen.length, before, "a forbidden request never reaches the window")
  }
})

test("the query goes on unchanged, and a GET carries no body", async () => {
  await call("POST", push("/api/replays/arena-r4/g001?at=120"), "x\n")
  assert.equal(seen.at(-1)!.url, "/api/replays/arena-r4/g001?at=120")
  await call("GET", push("/api/replays/arena-r4?sizes=1"))
  assert.equal(seen.at(-1)!.url, "/api/replays/arena-r4?sizes=1")
  assert.equal(seen.at(-1)!.body.length, 0)
})

test("the window's status and body come back byte for byte (push.js reads 409 conflicts)", async () => {
  const body = "{\"error\":{\"code\":\"conflict\",\"message\":\"at 5, have 9\",\"size\":9}}"
  answer = (_req, res) => {
    res.writeHead(409, { "content-type": "application/json; charset=utf-8" })
    res.end(body)
  }
  const r = await call("POST", push("/api/replays/arena-r4/g001?at=5"), "x\n")
  assert.equal(r.status, 409)
  assert.equal(r.body.toString(), body)
  assert.match(r.contentType ?? "", /application\/json/)
})

test("bodies over the limits get 413 and never reach the window", async () => {
  const before = seen.length
  assert.equal((await call("POST", push("/api/replays/arena-r4/g001?at=0"), Buffer.alloc(8_000_001, "x"))).status, 413)
  assert.equal((await call("PUT", push("/api/replays/arena-r4/g001"), Buffer.alloc(32_000_001, "x"))).status, 413)
  assert.equal((await call("PUT", push("/api/docs/arena/big"), Buffer.alloc(16_000_001, "x"))).status, 413)
  assert.equal((await call("GET", push("/api/replays/arena-r4?sizes=1"), "x")).status, 413)
  assert.equal(seen.length, before)

  // a declared length over the limit is refused before reading
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request(`${base()}${push("/api/replays/arena-r4/g001?at=0")}`, { method: "POST", headers: { "content-length": "8000001" } }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on("error", reject)
    req.write("x")
  })
  assert.equal(status, 413)
  assert.equal(seen.length, before)

  // exactly at the limit is fine
  assert.ok(await forwarded("POST", push("/api/replays/arena-r4/g001?at=0"), "x".repeat(8_000_000)))
})

test("a window that does not answer gives 502, and the path is not logged", async () => {
  const closed = http.createServer()
  await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r))
  const port = (closed.address() as { port: number }).port
  await new Promise((r) => closed.close(r))
  const down = await startWindowProxy({ window: `http://127.0.0.1:${port}`, token: () => TOKEN, nonces, port: 0 })
  try {
    logs.length = 0
    const r = await request(`http://127.0.0.1:${down.port}`, intake("/api/docs/submissions"), { method: "GET", timeoutMs: 5000 })
    assert.equal(r.status, 502)
    assert.equal(JSON.parse(r.body.toString()).error.code, "unavailable")
    assert.ok(logs.some((l) => l.includes("[warning] window proxy: the window did not answer")))
    assert.ok(logs.every((l) => !l.includes("submissions") && !l.includes(nonces.intake)))
  } finally {
    await down.close()
  }
})

test("served on 127.0.0.1, with the children's addresses", () => {
  assert.equal(proxy.push, `http://127.0.0.1:${proxy.port}/p/${nonces.push}`)
  assert.equal(proxy.intake, `http://127.0.0.1:${proxy.port}/i/${nonces.intake}`)
})
