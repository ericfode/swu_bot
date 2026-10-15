import assert from "node:assert/strict"
import http from "node:http"
import { after, before, test } from "node:test"
import { setSink } from "../../src/games/Log.ts"
import { listen, startOpsHttp } from "../../src/games/OpsHttp.ts"
import type { OpsHttp } from "../../src/games/OpsHttp.ts"
import { request } from "../../src/games/WindowProxy.ts"

let wakes = 0
let ops: OpsHttp
const logs: Array<string> = []

before(async () => {
  setSink((l) => logs.push(l))
  ops = await startOpsHttp({ host: "127.0.0.1", port: 0, onWake: () => wakes++ })
})
after(() => ops.close())

const call = (method: string, p: string, body: string | null = null) =>
  request(`http://127.0.0.1:${ops.port}`, p, { method, body: body === null ? null : Buffer.from(body), timeoutMs: 5000 })

test("POST /wake answers 202 and wakes the scheduler; its body is never read", async () => {
  const before = wakes
  const r = await call("POST", "/wake", "anything at all")
  assert.equal(r.status, 202)
  assert.deepEqual(JSON.parse(r.body.toString()), { ok: true })
  assert.match(r.contentType ?? "", /^application\/json/)
  assert.equal(wakes, before + 1)
  assert.equal((await call("POST", "/wake")).status, 202)
  assert.equal(wakes, before + 2)
})

test("GET /healthz answers 200 and says nothing about the arena", async () => {
  const r = await call("GET", "/healthz")
  assert.equal(r.status, 200)
  assert.deepEqual(JSON.parse(r.body.toString()), { ok: true })
  assert.equal((await call("GET", "/healthz?x=1")).status, 200)
})

test("anything else is a JSON 404 that says nothing about the arena, and wakes nothing", async () => {
  const before = wakes
  for (const [method, p] of [["GET", "/"], ["GET", "/wake"], ["POST", "/healthz"], ["GET", "/api/docs/arena"], ["PUT", "/x/y"], ["POST", "/wake/now"]] as const) {
    const r = await call(method, p)
    assert.equal(r.status, 404, `${method} ${p}`)
    assert.deepEqual(JSON.parse(r.body.toString()), { error: "not found" })
  }
  assert.equal(wakes, before)
  assert.equal(logs.length, 0, "no request logging")
})

test("an IPv6 address this host cannot use falls back with a warning; other errors stay errors", async () => {
  const server = http.createServer()
  // a documentation address no host has: EADDRNOTAVAIL
  const at = await listen(server, "2001:db8::1", 0, "127.0.0.1")
  assert.equal(at.host, "127.0.0.1")
  assert.ok(logs.some((l) => l.includes("[warning] no IPv6 here: listening on 127.0.0.1 instead of 2001:db8::1")))
  const busy = http.createServer()
  await assert.rejects(listen(busy, "127.0.0.1", at.port, "127.0.0.1"))
  await new Promise((r) => server.close(r))
})
