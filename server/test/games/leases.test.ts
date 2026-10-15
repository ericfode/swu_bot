/**
 * The lease board (Leases.ts), ported from coord/test/coord/remote_test.exs and the board's side of
 * coord/test/coord_web/helper_api_test.exs: claims, offers, lease clocks on a fake clock, read-once results, revoke,
 * reset, bundles, stopping.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { TIMING } from "../../src/games/Config.ts"
import type { Timing } from "../../src/games/Config.ts"
import type { ClaimAnswer, LeaseBoardImpl } from "../../src/games/Leases.ts"
import { deadlineMs, firstChars, makeLeaseBoard } from "../../src/games/Leases.ts"
import { setSink } from "../../src/games/Log.ts"
import type { PlaySeedJob } from "../../src/games/Types.ts"

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")

/** a seed's job as a round offers it (coord_case.ex remote_job) */
const job = (seed = 1234, extra: Partial<PlaySeedJob> = {}): PlaySeedJob => ({
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
  bots: { "a-v2": { kind: "wasm", bundle: sha256("tar") }, heuristic: { kind: "resident" } },
  ...extra
})

let lines: Array<string> = []
let clock = 0
let stopping = false
let board: LeaseBoardImpl
let bundles = ""

const makeBoard = (timing: Partial<Timing> = {}, fake = true) =>
  makeLeaseBoard({ bundles, timing: { ...TIMING, ...timing }, isStopping: () => stopping, ...(fake ? { now: () => clock } : {}) })

beforeEach(() => {
  lines = []
  setSink((l) => lines.push(l))
  clock = 1_000_000
  stopping = false
  bundles = mkdtempSync(path.join(tmpdir(), "games-bundles-"))
  writeFileSync(path.join(bundles, `${sha256("tar")}.tar`), "tar")
  board = makeBoard()
})

afterEach(() => {
  board.close()
  setSink((l) => process.stdout.write(l))
})

/** a claim waiting as the API's request would (its own abort signal) */
const claim = (name = "eric", ms = 5_000) => {
  const away = new AbortController()
  const answer = board.awaitClaim(name, "1", ms, away.signal)
  return { answer, away }
}

const leaseOf = async (a: Promise<ClaimAnswer>) => {
  const got = await a
  assert.ok(typeof got === "object", `expected a lease, got ${String(got)}`)
  return got
}

/** a lease given to eric, its claim's answer sent */
const running = async (j = job(), b: Array<string> = []) => {
  const { answer } = claim()
  const offered = board.offer(j, b)
  assert.equal(offered.kind, "leased")
  const got = await leaseOf(answer)
  board.claimSent(got.lease)
  return got.lease
}

const logged = (re: RegExp) => lines.some((l) => re.test(l.trimEnd()))

test("claims wait in order: an offer goes to the one that waited longest, with the job, its bundles and the deadline", async () => {
  const hex = sha256("tar")
  const first = claim("bob")
  const second = claim("eric")
  assert.deepEqual(board.status(), { waiting: 2, hosts: ["bob", "eric"] })

  const j = job(77)
  const offered = board.offer(j, [hex, hex])
  assert.equal(offered.kind, "leased")
  assert.ok(offered.kind === "leased" && offered.host === "bob" && /^[A-Za-z0-9_-]{16}$/.test(offered.lease))
  const got = await leaseOf(first.answer)
  assert.deepEqual(got, { lease: offered.lease, job: j, bundles: [{ id: hex, bytes: 3 }], deadlineMs: 840_000 + 300_000 })
  // the job goes out as the round built it, not a copy with its keys moved
  assert.equal(got.job, j)
  assert.ok(logged(new RegExp(`\\[info\\] lease ${offered.lease} \\(seed 77\\) goes to bob$`)))

  const again = board.offer(job(2), [])
  assert.ok(again.kind === "leased" && again.host === "eric")
  assert.equal((await leaseOf(second.answer)).job.seed, 2)
  assert.equal(board.status().waiting, 0)

  clock += 1234
  assert.deepEqual(board.lease(offered.lease), { state: "running", host: "bob", ageMs: 1234 })
})

test("an offer with nobody waiting is none; one naming a tar not in the folder is missing", async () => {
  assert.deepEqual(board.offer(job(), []), { kind: "none" })
  const never = sha256("never put")
  const linked = sha256("linked")
  symlinkSync(path.join(bundles, `${sha256("tar")}.tar`), path.join(bundles, `${linked}.tar`))
  assert.deepEqual(board.offer(job(), [never, sha256("tar"), never, linked, "../x"]), { kind: "missing", missing: [never, linked, "../x"] })
  // a waiting claim is not used up by an offer that could not go
  const c = claim()
  assert.equal(board.offer(job(), [never]).kind, "missing")
  assert.equal(board.status().waiting, 1)
  c.away.abort()
  assert.equal(await c.answer, "none")
})

test("a claim that waits its time for nothing gets none, and no longer waits", async () => {
  const t0 = Date.now()
  const { answer } = claim("eric", 100)
  assert.equal(board.status().waiting, 1)
  assert.equal(await answer, "none")
  assert.ok(Date.now() - t0 >= 95)
  assert.deepEqual(board.status(), { waiting: 0, hosts: ["eric"] })
})

test("a helper that goes away while it waits no longer waits; one that goes away after the offer loses the lease", async () => {
  const c = claim()
  c.away.abort()
  assert.equal(await c.answer, "none")
  assert.equal(board.status().waiting, 0)
  assert.deepEqual(board.offer(job(), []), { kind: "none" })

  const d = claim()
  const offered = board.offer(job(), [])
  assert.equal(offered.kind, "leased")
  const id = (await leaseOf(d.answer)).lease
  d.away.abort()
  assert.deepEqual(board.lease(id), { state: "lost", host: "eric", reason: "claim dropped" })

  // an answer that could not be written gives the lease back at once; one that was written keeps it
  const e = claim()
  board.offer(job(), [])
  const dropped = (await leaseOf(e.answer)).lease
  board.claimDropped(dropped)
  assert.deepEqual(board.lease(dropped), { state: "lost", host: "eric", reason: "claim dropped" })
  const sent = await running()
  board.claimDropped(sent)
  assert.equal(board.lease(sent).state, "running")
})

test("no offer goes out while the machine stops, and a waiting claim answers stopping within a second", async () => {
  const c = claim("eric", 5_000)
  stopping = true
  assert.deepEqual(board.offer(job(), []), { kind: "none" })
  const t0 = Date.now()
  assert.equal(await c.answer, "stopping")
  assert.ok(Date.now() - t0 < 1_500)
  assert.equal(board.status().waiting, 0)
  assert.equal(await claim().answer, "stopping")
})

test("the sweep: a lease never acknowledged, without a heartbeat or past its deadline is lost", async () => {
  board.close()
  board = makeBoard({ leaseAckMs: 15_000, leaseLostMs: 90_000 })
  const acked = await running()
  const silent = await running(job(2))
  clock += 1_000
  assert.ok(board.heartbeat(acked, "eric"))
  clock += 14_000
  board.sweep()
  assert.equal(board.lease(silent).state, "running")
  clock += 1
  board.sweep()
  assert.deepEqual(board.lease(silent), { state: "lost", host: "eric", reason: "claim dropped" })
  assert.ok(logged(new RegExp(`lease ${silent} of eric lost \\(claim dropped\\)`)))

  // 90 s without a heartbeat is still fine, a millisecond more is not
  clock += 75_999
  board.sweep()
  assert.equal(board.lease(acked).state, "running")
  clock += 1
  board.sweep()
  assert.deepEqual(board.lease(acked), { state: "lost", host: "eric", reason: "no heartbeat" })
  assert.equal(board.heartbeat(acked, "eric"), false)

  // an offered lease whose answer never went out is lost the same way
  const c = claim()
  board.offer(job(3), [])
  const offered = (await leaseOf(c.answer)).lease
  clock += 90_001
  board.sweep()
  assert.deepEqual(board.lease(offered), { state: "lost", host: "eric", reason: "no heartbeat" })

  // the deadline: gameMs + 5 min after the claim's answer (30 min + 5 when the job has none)
  assert.equal(deadlineMs({ gameMs: 1_000 }), 301_000)
  assert.equal(deadlineMs({ gameMs: 0 }), 35 * 60_000)
  assert.equal(deadlineMs({}), 35 * 60_000)
  assert.equal(deadlineMs({ gameMs: 1.5 }), 35 * 60_000)
  const quick = await running(job(4, { gameMs: 1_000 }))
  for (let i = 0; i < 4; i++) {
    clock += 75_000
    assert.ok(board.heartbeat(quick, "eric"))
    board.sweep()
  }
  assert.equal(board.lease(quick).state, "running")
  clock += 1_001
  assert.ok(board.heartbeat(quick, "eric"))
  board.sweep()
  assert.deepEqual(board.lease(quick), { state: "lost", host: "eric", reason: "deadline" })
})

test("done and lost leases nobody reads are forgotten after leaseKeepMs", async () => {
  board.close()
  board = makeBoard({ leaseKeepMs: 1_000 })
  const kept = await running()
  const dropped = await running(job(2))
  assert.ok(board.result(kept, "eric", { failed: "x" }))
  assert.ok(board.result(dropped, "eric", { results: [], replays: {} }))
  clock += 1_000
  board.sweep()
  assert.deepEqual(board.lease(kept), { state: "lost", host: "eric", reason: "x" })
  clock += 1
  board.sweep()
  assert.deepEqual(board.lease(dropped), { state: "unknown" })
})

test("heartbeats and results by the holder only; a result is kept as it came and read once", async () => {
  const id = await running(job(), [sha256("tar")])
  assert.equal(board.heartbeat(id, "bob"), false)
  assert.equal(board.result(id, "bob", { failed: "x" }), false)
  assert.equal(board.heartbeat("unknown", "eric"), false)
  assert.ok(board.heartbeat(id, "eric"))

  const results = [{ id: "a", result: { outcome: "won" } }, { id: "b", result: { x: 1 } }]
  const replays = { a: "{\"t\":\"header\"}\n" }
  assert.ok(board.result(id, "eric", { results, replays }))
  assert.ok(logged(new RegExp(`\\[info\\] lease ${id} done by eric$`)))
  assert.equal(board.heartbeat(id, "eric"), false)
  assert.equal(board.result(id, "eric", { failed: "again" }), false)
  const read = board.lease(id)
  assert.deepEqual(read, { state: "done", host: "eric", results, replays })
  assert.ok(read.state === "done" && read.results === results)
  assert.deepEqual(board.lease(id), { state: "unknown" })

  const failed = await running(job(2))
  assert.ok(board.result(failed, "eric", { failed: "r".repeat(300) }))
  // the log cuts the reason to 100 characters; the board keeps it whole
  assert.ok(logged(new RegExp(`lease ${failed} of eric lost \\(${"r".repeat(100)}\\)$`)))
  assert.deepEqual(board.lease(failed), { state: "lost", host: "eric", reason: "r".repeat(300) })
  assert.deepEqual(board.lease(failed), { state: "unknown" })
})

test("a revoked lease is forgotten at once: no heartbeat, no result, unknown to the round", async () => {
  const id = await running()
  board.revoke(id)
  assert.ok(logged(new RegExp(`lease ${id} taken back$`)))
  assert.equal(board.heartbeat(id, "eric"), false)
  assert.equal(board.result(id, "eric", { results: [], replays: {} }), false)
  assert.deepEqual(board.lease(id), { state: "unknown" })
  const n = lines.length
  board.revoke(id)
  assert.equal(lines.length, n)
})

test("reset forgets every lease; waiting claims stay", async () => {
  const hex = sha256("tar")
  const id = await running(job(), [hex])
  const offered = claim("bob")
  board.offer(job(2), [])
  const unsent = (await leaseOf(offered.answer)).lease
  const waiting = claim("bob", 300)
  board.reset()
  assert.ok(logged(/\[info\] the round ended: 2 leases forgotten$/))
  assert.deepEqual(board.lease(id), { state: "unknown" })
  assert.deepEqual(board.lease(unsent), { state: "unknown" })
  assert.equal(board.heartbeat(id, "eric"), false)
  assert.equal(board.bundleFile("eric", hex), null)
  assert.deepEqual(board.status(), { waiting: 1, hosts: ["bob", "eric"] })
  assert.equal(await waiting.answer, "none")
  // the tars stay: the round wrote them, and the next round may use them again
  assert.deepEqual(board.offer(job(3), [hex]), { kind: "none" })
  // a reset with nothing to forget says nothing
  board.reset()
  assert.equal(lines.filter((l) => l.includes("the round ended")).length, 1)
})

test("a helper gets a bundle's file only while it holds a lease that names it", async () => {
  const hex = sha256("tar")
  writeFileSync(path.join(bundles, `${sha256("other")}.tar`), "other")
  assert.equal(board.bundleFile("eric", hex), null)
  const id = await running(job(), [hex])
  assert.equal(board.bundleFile("eric", hex), path.join(bundles, `${hex}.tar`))
  assert.equal(board.bundleFile("bob", hex), null)
  assert.equal(board.bundleFile("eric", sha256("other")), null)
  assert.equal(board.bundleFile("eric", "../../etc"), null)
  assert.ok(board.result(id, "eric", { failed: "x" }))
  assert.equal(board.bundleFile("eric", hex), null)
})

test("hosts are every name that said hello or claimed since the board started", async () => {
  board.hello("eric")
  board.hello("eric")
  const c = claim("swarm")
  assert.deepEqual(board.status(), { waiting: 1, hosts: ["eric", "swarm"] })
  c.away.abort()
  await c.answer
  board.reset()
  assert.deepEqual(board.status().hosts, ["eric", "swarm"])
})

test("the board sweeps on its own timer, and close stops it and answers the claims still waiting", async () => {
  board.close()
  board = makeBoard({ sweepMs: 20, leaseAckMs: 50 }, false)
  const id = await running()
  await new Promise((r) => setTimeout(r, 200))
  assert.deepEqual(board.lease(id), { state: "lost", host: "eric", reason: "claim dropped" })
  const c = claim()
  board.close()
  assert.equal(await c.answer, "none")
  assert.equal(await claim().answer, "none")
  assert.deepEqual(board.offer(job(), []), { kind: "none" })
})

test("reasons are cut by characters as a reader counts them", () => {
  assert.equal(firstChars("short", 300), "short")
  assert.equal(firstChars("r".repeat(400), 300), "r".repeat(300))
  assert.equal(firstChars("a\u{1F44D}\u{1F3FD}bc", 2), "a\u{1F44D}\u{1F3FD}")
  assert.equal(firstChars("ééé", 2), "éé")
})
