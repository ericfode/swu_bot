/**
 * The helper role (COORD_ROLE=helper): the games image run in Docker on a trusted computer (Eric's Mac, helper.sh),
 * which plays whole seeds for the games machine's rounds (bot/arena/HELPER.md). It reaches the machine through `fly
 * proxy` at GAMES_HELPER_URL with its own token (GAMES_HELPER_TOKEN) and listens on nothing. Coord.Helper, its Client,
 * Slot and Play in TypeScript, on the same wire (map-helper-lease.md §7, §13):
 *
 * - boot: the token kept, stale child groups reaped, `<data>/helper` wiped (0711 when the plays run as the bots' user,
 *   who must reach their own folder in it), the bots' HOME and wasm cache theirs;
 * - `play-seed.js --warm` (as the bots' user; a failure is only logged), then hello: 200 starts GAMES_HELPER_SLOTS
 *   slots, 409 (another build) stops with 3, 401 (unknown token) with 1, no answer says hello again every 30 s;
 * - a slot claims (a long poll), plays the lease's seed with play-seed.js in `<data>/helper/<slot>/<lease>/`
 *   (job.json, out/; the layout helper-tui.js reads), heartbeats meanwhile (the first at once: the machine's ack),
 *   posts the results and replays, removes the folder and claims again. A seed is never played twice here.
 * - stopping (SIGTERM: docker stop, Ctrl-C in the live view) gives every seed in play back at once.
 *
 * Bundles (canonical tars, named by their sha256) are fetched once into `<data>/bundles`, which keeps them across
 * leases and restarts up to timing.bundlesLimit, the least recently used going first. The log lines are the Elixir
 * helper's, word for word: helper-tui.js parses them.
 */
import { execFileSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { readFile } from "node:fs/promises"
import http from "node:http"
import https from "node:https"
import path from "node:path"
import { Effect, Exit, Fiber } from "effect"
import type { GamesConfig } from "./Config.ts"
import { scripts } from "./Config.ts"
import { removeTree } from "./Executor.ts"
import * as Log from "./Log.ts"
import type { ProcService, Result, RunOptions } from "./Proc.ts"
import { childEnv } from "./Proc.ts"
import type { Secrets } from "./Secrets.ts"

/** [wall-clock ms, monotonic ms] */
export type Tick = readonly [number, number]

export interface HelperOptions {
  /** aborted on SIGTERM/SIGINT: slots hand their seeds back, then runHelper resolves 0. A reason of "SIGTERM" or
   * "SIGINT" is logged as the BEAM logged it ("SIGTERM received - shutting down"; the live view reads it). */
  readonly signal: AbortSignal
  /** the clocks the suspend check compares (tests move the wall clock) */
  readonly clock?: () => Tick
}

// limits and times of today's helper (client.ex, slot.ex, play.ex, helper.ex)
const BUNDLE_LIMIT = 64_000_000
const REPLAY_LIMIT = 32_000_000
const BODY_LIMIT = 40_000_000
const MAX_STDOUT = 8_000_000
const GRACE_MS = 5_000
const SLEPT_MS = 20_000
const POST_TRIES = 3
const POST_GAP_MS = 5_000
const POST_MS = 120_000
const GIVE_BACK_MS = 3_000
const RESTART_MS = 5_000
const SLOT_STOP_MS = 8_000
const WARM_MS = 15 * 60_000
const CONNECT_MS = 10_000
const HELLO_MS = 15_000
const BUNDLE_MS = 120_000
const HEARTBEAT_MS = 15_000
const SMALL_ANSWER = 1 << 20

const LEASE_ID = /^[A-Za-z0-9_-]{1,64}$/
const HEX = /^[0-9a-f]{64}$/

const WRONG_TOKEN = "the games machine does not know this helper's token (stopping with 1)"

class SetupError extends Error {}

const plain = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)

/** how Elixir's inspect/1 shows a value that is not a string (nil for none) */
const shown = (v: unknown): string => (v === undefined || v === null ? "nil" : typeof v === "string" ? v : JSON.stringify(v) ?? String(v))

/** a value from the machine, safe to log (helper.ex printable/1) */
const printable = (v: unknown) => shown(v).replace(/[^\w.:/@-]/g, "?").slice(0, 200)

/** a value from a game, safe to log (slot.ex printable/1) */
const printableGame = (v: unknown) => shown(v).replace(/[^\w .:-]/g, "?").slice(0, 80)

const wrongBuild = (want: Record<string, unknown>) =>
  `the games machine runs build ${printable(want.build)}: pull ${printable(want.image)} and start it (stopping with 3)`

const errorCode = (e: unknown) => {
  const code = (e as NodeJS.ErrnoException)?.code
  return typeof code === "string" ? code.toLowerCase() : String((e as Error)?.message ?? e).slice(0, 100)
}

const monotonic = () => performance.now()
const defaultClock = (): Tick => [Date.now(), performance.now()]

/**
 * Whether the computer slept between two ticks: the wall clock and the monotonic clock (which stands still while the
 * computer sleeps) moved apart by more than `limit` ms, either way.
 */
export const slept = (prev: Tick, now: Tick, limit = SLEPT_MS) => Math.abs(now[0] - prev[0] - (now[1] - prev[1])) > limit

/** resolves after `ms`, or at once when `signal` aborts */
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })

// --- the helper's requests (client.ex)

type Common =
  | { readonly kind: "unauthorized" }
  | { readonly kind: "build"; readonly want: Record<string, unknown> }
  | { readonly kind: "error"; readonly why: string }

interface HelloTiming {
  readonly name: string
  readonly heartbeatMs: number
  readonly leaseLostMs: number
  readonly claimMs: number
}

interface Lease {
  readonly id: string
  readonly job: Record<string, unknown>
  readonly bundles: ReadonlyArray<string>
  readonly deadlineMs: number
}

type Sent = { readonly status: number; readonly body: Buffer; readonly over: boolean } | { readonly error: string }

/** Mint's words for a failed connection (the Elixir helper logged these), never the address or a header */
const failure = (e: unknown): string => {
  const err = e as NodeJS.ErrnoException
  if (err?.message === "socket hang up") return "socket closed"
  switch (err?.code) {
    case "ECONNREFUSED": return "connection refused"
    case "ECONNRESET": return "connection reset by peer"
    case "ETIMEDOUT": return "timeout"
    case "ENOTFOUND": return "non-existing domain"
    case "EAI_AGAIN": return "temporary failure in name resolution"
    case "EHOSTUNREACH": return "host is unreachable"
    case "ENETUNREACH": return "network is unreachable"
    case "EPIPE": return "broken pipe"
    case "ABORT_ERR": return "the helper is stopping"
    default: return typeof err?.code === "string" ? err.code.toLowerCase().slice(0, 200) : "the request failed"
  }
}

const timeoutError = () => Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })
const abortError = () => Object.assign(new Error("aborted"), { code: "ABORT_ERR" })

interface Client {
  readonly hello: (slots: number, signal: AbortSignal) => Promise<{ readonly kind: "ok"; readonly timing: HelloTiming } | Common>
  readonly claim: (slot: string, claimMs: number, signal: AbortSignal) => Promise<{ readonly kind: "lease"; readonly lease: Lease } | { readonly kind: "none" } | Common>
  readonly bundle: (hex: string, signal: AbortSignal) => Promise<{ readonly kind: "ok"; readonly body: Buffer } | Common>
  readonly heartbeat: (id: string, signal: AbortSignal) => Promise<{ readonly kind: "ok" | "gone" } | Common>
  readonly result: (id: string, json: string, timeoutMs: number, signal: AbortSignal) => Promise<{ readonly kind: "ok" | "gone" } | Common>
}

const makeClient = (c: GamesConfig, token: string): Client => {
  const base = new URL(c.helperUrl ?? "http://127.0.0.1:1")
  const lib = base.protocol === "https:" ? https : http

  /**
   * One request on its own connection (no pool: a long poll and the machine's restarts leave no stale socket behind).
   * The token goes only in the authorization header, and nothing about the request reaches a log.
   */
  const send = (o: {
    readonly method: "GET" | "POST"
    readonly path: string
    readonly body?: string
    readonly json?: boolean
    readonly timeoutMs: number
    readonly maxBytes: number
    readonly signal: AbortSignal
  }) =>
    new Promise<Sent>((resolve) => {
      if (o.signal.aborted) return resolve({ error: "the helper is stopping" })
      const body = o.method === "POST" ? Buffer.from(o.body ?? "") : null
      let settled = false
      const done = (r: Sent) => {
        if (settled) return
        settled = true
        clearTimeout(connectTimer)
        o.signal.removeEventListener("abort", onAbort)
        resolve(r)
      }
      const req = lib.request({
        protocol: base.protocol,
        hostname: base.hostname.replace(/^\[(.*)\]$/, "$1"),
        port: base.port || undefined,
        path: o.path,
        method: o.method,
        agent: false,
        headers: {
          ...(body ? { "content-length": String(body.length) } : {}),
          ...(o.json ? { "content-type": "application/json" } : {}),
          // last, so nothing above can drop or repeat them
          authorization: `Bearer ${token}`,
          "x-helper-build": c.build
        }
      })
      const connectTimer = setTimeout(() => req.destroy(timeoutError()), CONNECT_MS)
      req.on("socket", (socket) => socket.once("connect", () => clearTimeout(connectTimer)))
      // no byte for timeoutMs (a long poll's whole wait, or a stall in a body) ends it, as Req's receive_timeout did
      req.setTimeout(o.timeoutMs, () => req.destroy(timeoutError()))
      const onAbort = () => req.destroy(abortError())
      o.signal.addEventListener("abort", onAbort, { once: true })
      req.on("error", (e) => done({ error: o.signal.aborted ? "the helper is stopping" : failure(e) }))
      req.on("response", (res) => {
        clearTimeout(connectTimer)
        const chunks: Array<Buffer> = []
        let size = 0
        res.on("data", (chunk: Buffer) => {
          size += chunk.length
          if (size > o.maxBytes) {
            // cut off instead of held
            done({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), over: true })
            res.destroy()
          } else {
            chunks.push(chunk)
          }
        })
        res.on("end", () => done({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), over: false }))
        res.on("error", (e) => done({ error: o.signal.aborted ? "the helper is stopping" : failure(e) }))
        res.on("aborted", () => done({ error: "socket closed" }))
      })
      req.end(body ?? undefined)
    })

  const decode = (body: Buffer): unknown => {
    try {
      return JSON.parse(body.toString("utf8"))
    } catch {
      return undefined
    }
  }

  const common = (r: Sent): Common => {
    if ("error" in r) return { kind: "error", why: r.error }
    if (r.status === 401) return { kind: "unauthorized" }
    if (r.status === 409) {
      const doc = decode(r.body)
      if (plain(doc) && plain(doc.error) && doc.error.code === "build" && plain(doc.error.want)) return { kind: "build", want: doc.error.want }
      return { kind: "error", why: "HTTP 409" }
    }
    if (r.status === 503) return { kind: "error", why: "the games machine is stopping" }
    return { kind: "error", why: `HTTP ${r.status}` }
  }

  // a time the machine gives: 1 s to 10 min (what the Elixir helper accepted)
  const ms = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1_000 && n <= 600_000

  const hello: Client["hello"] = async (slots, signal) => {
    const r = await send({
      method: "POST", path: "/v1/hello", body: JSON.stringify({ build: c.build, cards: c.cards, slots }), json: true,
      timeoutMs: HELLO_MS, maxBytes: SMALL_ANSWER, signal
    })
    if ("error" in r || r.status !== 200) return common(r)
    const doc = decode(r.body)
    if (plain(doc) && doc.ok === true && typeof doc.name === "string" && ms(doc.heartbeatMs) && ms(doc.leaseLostMs) && ms(doc.claimMs)) {
      return { kind: "ok", timing: { name: doc.name, heartbeatMs: doc.heartbeatMs, leaseLostMs: doc.leaseLostMs, claimMs: doc.claimMs } }
    }
    return { kind: "error", why: "hello's answer is not the one expected" }
  }

  const claim: Client["claim"] = async (slot, claimMs, signal) => {
    const r = await send({
      method: "POST", path: "/v1/claim", body: JSON.stringify({ slot }), json: true,
      timeoutMs: claimMs + 10_000, maxBytes: 2 * SMALL_ANSWER, signal
    })
    if ("error" in r) return common(r)
    if (r.status === 204) return { kind: "none" }
    if (r.status !== 200) return common(r)
    const doc = decode(r.body)
    const notLease = { kind: "error", why: "the claim's answer is not a lease" } as const
    if (
      !plain(doc) || typeof doc.lease !== "string" || !LEASE_ID.test(doc.lease) || !plain(doc.job) ||
      !Array.isArray(doc.bundles) || typeof doc.deadlineMs !== "number" || !Number.isInteger(doc.deadlineMs) || doc.deadlineMs <= 0
    ) return notLease
    // every entry an {id: <hex>}: a bare string is refused, as the Elixir helper refused it
    const hexes = doc.bundles.map((b: unknown) => (plain(b) && typeof b.id === "string" && HEX.test(b.id) ? b.id : null))
    if (hexes.some((h) => h === null)) return notLease
    return { kind: "lease", lease: { id: doc.lease, job: doc.job, bundles: [...new Set(hexes as Array<string>)], deadlineMs: doc.deadlineMs } }
  }

  const bundle: Client["bundle"] = async (hex, signal) => {
    const r = await send({ method: "GET", path: `/v1/bundle/${hex}`, timeoutMs: BUNDLE_MS, maxBytes: BUNDLE_LIMIT, signal })
    if ("error" in r || r.status !== 200) return common(r)
    if (r.over) return { kind: "error", why: `bundle over ${BUNDLE_LIMIT} bytes` }
    if (createHash("sha256").update(r.body).digest("hex") !== hex) return { kind: "error", why: "bundle's sha256 is not its id" }
    return { kind: "ok", body: r.body }
  }

  const leasePost = async (id: string, what: string, body: string, json: boolean, timeoutMs: number, signal: AbortSignal) => {
    const r = await send({ method: "POST", path: `/v1/lease/${id}/${what}`, body, json, timeoutMs, maxBytes: SMALL_ANSWER, signal })
    if (!("error" in r) && r.status === 200) return { kind: "ok" } as const
    if (!("error" in r) && r.status === 410) return { kind: "gone" } as const
    return common(r)
  }

  return {
    hello,
    claim,
    bundle,
    // an empty body and no content-type, as the Elixir helper sent it
    heartbeat: (id, signal) => leasePost(id, "heartbeat", "", false, HEARTBEAT_MS, signal),
    result: (id, json, timeoutMs, signal) => leasePost(id, "result", json, true, timeoutMs, signal)
  }
}

const describe = (a: Common | { readonly kind: string }) =>
  a.kind === "error" ? (a as { why: string }).why : a.kind === "unauthorized" ? "unauthorized" : a.kind === "build" ? "another build" : a.kind

// --- the bundles a lease needs, fetched once

interface BundleCache {
  /** null when every tar is in the folder (held until release), else why not */
  readonly get: (hexes: ReadonlyArray<string>, signal: AbortSignal) => Promise<string | null>
  readonly release: (hexes: ReadonlyArray<string>) => void
}

/**
 * `<hex>.tar` files in `dir` (root's, readable: play-seed reads them as the bots' user), each checked against its
 * name when fetched and once per boot before its first use. Over `limit` bytes, the least recently used tars that no
 * lease holds go.
 */
const makeBundleCache = (dir: string, limit: number, client: Client): BundleCache => {
  // the tars in the folder: size, when last used, and whether their bytes were checked this boot
  const entries = new Map<string, { size: number; used: number; checked: boolean }>()
  // how many leases hold each tar now (held tars are never pushed out)
  const holds = new Map<string, number>()
  const fetching = new Map<string, Promise<string | null>>()
  let clock = 0
  const file = (hex: string) => path.join(dir, `${hex}.tar`)

  mkdirSync(dir, { recursive: true, mode: 0o755 })
  chmodSync(dir, 0o755)
  for (const f of readdirSync(dir)) {
    const m = /^([0-9a-f]{64})\.tar$/.exec(f)
    try {
      const st = lstatSync(path.join(dir, f))
      if (m && st.isFile()) entries.set(m[1]!, { size: st.size, used: clock++, checked: false })
      // a download a stopped helper left half done, or something that is not a tar
      else rmSync(path.join(dir, f), { recursive: true, force: true })
    } catch {
      // gone meanwhile
    }
  }

  const forget = (hex: string) => {
    entries.delete(hex)
    rmSync(file(hex), { force: true })
  }

  const prune = () => {
    let total = 0
    for (const e of entries.values()) total += e.size
    while (total > limit) {
      let oldest: string | null = null
      for (const [hex, e] of entries) {
        if (!holds.get(hex) && (oldest === null || e.used < entries.get(oldest)!.used)) oldest = hex
      }
      if (oldest === null) return
      total -= entries.get(oldest)!.size
      forget(oldest)
    }
  }

  const fetchOne = async (hex: string, signal: AbortSignal): Promise<string | null> => {
    const a = await client.bundle(hex, signal)
    if (a.kind !== "ok") return a.kind === "build" ? "the games machine runs another build" : describe(a)
    const tmp = path.join(dir, `.${hex}.${randomBytes(6).toString("hex")}.tmp`)
    try {
      writeFileSync(tmp, a.body, { mode: 0o644, flag: "wx" })
      renameSync(tmp, file(hex))
    } catch (e) {
      rmSync(tmp, { force: true })
      return `could not keep it (${errorCode(e)})`
    }
    entries.set(hex, { size: a.body.length, used: clock++, checked: true })
    prune()
    return null
  }

  /** whether the tar is here with the bytes its name says (one kept from an earlier boot is read once) */
  const check = async (hex: string) => {
    const e = entries.get(hex)
    if (!e) return false
    if (e.checked) return true
    try {
      if (!lstatSync(file(hex)).isFile()) throw new Error("not a file")
      const bytes = await readFile(file(hex))
      if (createHash("sha256").update(bytes).digest("hex") !== hex) throw new Error("changed")
      e.checked = true
      return true
    } catch {
      forget(hex)
      return false
    }
  }

  const one = async (hex: string, signal: AbortSignal): Promise<string | null> => {
    for (let tries = 0; tries < 2; tries++) {
      const running = fetching.get(hex)
      if (running) {
        // another lease fetches it; when that one fails (its lease taken back, say), this lease tries itself once
        const why = await running
        if (why !== null && tries > 0) return why
        continue
      }
      if (await check(hex)) {
        entries.get(hex)!.used = clock++
        return null
      }
      const p = fetchOne(hex, signal).finally(() => fetching.delete(hex))
      fetching.set(hex, p)
      return await p
    }
    return (await check(hex)) ? null : "could not fetch it"
  }

  return {
    get: async (hexes, signal) => {
      // held first, so no other lease's download pushes them out meanwhile
      for (const hex of hexes) holds.set(hex, (holds.get(hex) ?? 0) + 1)
      for (const hex of hexes) {
        const why = await one(hex, signal)
        if (why !== null) return `bundle ${hex.slice(0, 12)}: ${why}`
      }
      return null
    },
    release: (hexes) => {
      for (const hex of hexes) {
        const n = (holds.get(hex) ?? 0) - 1
        if (n > 0) holds.set(hex, n)
        else holds.delete(hex)
      }
      prune()
    }
  }
}

// --- one lease's play (play.ex)

type PlayOutcome =
  | { readonly ok: true; readonly json: string; readonly results: ReadonlyArray<{ readonly id: string; readonly result: Record<string, unknown> }> }
  | { readonly ok: false; readonly why: string }

const NOT_A_FILE = "a replay path is not a file in out/"

/** a replay, opened without following a link: a regular file right in `outDir`, the bots' when `owner` is given */
const readReplay = (p: unknown, outDir: string, room: number, owner: number | null): { readonly bytes: Buffer } | { readonly why: string } => {
  if (typeof p !== "string" || path.dirname(path.resolve(p)) !== outDir) return { why: NOT_A_FILE }
  let fd: number
  try {
    fd = openSync(path.resolve(p), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return { why: NOT_A_FILE }
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || (owner !== null && st.uid !== owner)) return { why: NOT_A_FILE }
    if (st.size > REPLAY_LIMIT) return { why: `a replay is over ${REPLAY_LIMIT} bytes` }
    if (st.size > room) return { why: `the replays are over ${BODY_LIMIT} bytes` }
    const buf = Buffer.alloc(st.size)
    let n = 0
    while (n < st.size) {
      const k = readSync(fd, buf, n, st.size - n, n)
      if (k === 0) break
      n += k
    }
    return { bytes: buf.subarray(0, n) }
  } catch (e) {
    return { why: `could not read a replay (${errorCode(e)})` }
  } finally {
    closeSync(fd)
  }
}

/**
 * The body to post from play-seed's last stdout line (`{"ok":true,"results":[{id,result}],"replays":{id:path}}`) and
 * its replay files: each a regular file right in `outDir`, at most 32 MB, all together and the whole body at most
 * 40 MB, UTF-8 text. `owner`: the uid the replays must belong to (the bots' user's), or null for anyone.
 */
export const resultBody = (stdout: string, outDir: string, owner: number | null = null): PlayOutcome => {
  const other = { ok: false, why: "play-seed printed something other than ok and its results" } as const
  const line = stdout.split("\n").filter((l) => l.trim() !== "").at(-1)
  if (line === undefined) return other
  let doc: unknown
  try {
    doc = JSON.parse(line)
  } catch {
    return other
  }
  if (!plain(doc) || doc.ok !== true || !Array.isArray(doc.results) || !plain(doc.replays)) return other
  const results = doc.results as Array<unknown>
  if (!results.every((r) => plain(r) && typeof r.id === "string" && plain(r.result))) {
    return { ok: false, why: "play-seed's results are malformed" }
  }
  const dir = path.resolve(outDir)
  const names = Object.keys(doc.replays).sort()
  const texts: Record<string, string> = {}
  let isDir = false
  try {
    isDir = lstatSync(dir).isDirectory()
  } catch {
    isDir = false
  }
  if (!isDir && names.length) return { ok: false, why: "no replay folder" }
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
  let total = 0
  for (const id of names) {
    const r = readReplay(doc.replays[id], dir, BODY_LIMIT - total, owner)
    if ("why" in r) return { ok: false, why: r.why }
    try {
      texts[id] = utf8.decode(r.bytes)
    } catch {
      return { ok: false, why: "a replay is not UTF-8 text" }
    }
    total += r.bytes.length
  }
  const json = JSON.stringify({ results, replays: texts })
  if (Buffer.byteLength(json) > BODY_LIMIT) return { ok: false, why: `the result is over ${BODY_LIMIT} bytes` }
  return { ok: true, json, results: results as Array<{ id: string; result: Record<string, unknown> }> }
}

// --- the helper

interface Ids {
  readonly uid: number
  readonly gid: number
}

interface Ctx {
  readonly c: GamesConfig
  readonly proc: ProcService
  readonly client: Client
  readonly cache: BundleCache
  /** the bots' user when the plays run as them (this process is root), else null */
  readonly ids: Ids | null
  readonly helperDir: string
  /** aborted when the helper stops (a signal, 409, 401) */
  readonly stopping: AbortSignal
  /** aborted SLOT_STOP_MS after that: a result being posted gets that long to arrive */
  readonly hard: AbortSignal
  readonly stop: (code: number, message: string | null) => void
  readonly clock: () => Tick
}

const playOptions = (h: Ctx, kind: "warm" | "play", args: ReadonlyArray<string>, timeoutMs: number): RunOptions => ({
  kind,
  argv: [h.c.node, scripts(h.c).playSeed, ...args],
  // built from nothing: no token, no address of the machine, no NODE_ENV (the engine's default, as on the machine)
  env: childEnv(h.c, h.c.paths.home, { SWU_WASM_CACHE: h.c.paths.wasmCache }),
  as: "arena",
  // plain setpriv: isolate.sh needs namespaces a Docker container does not grant; Docker is the helper's boundary
  isolate: false,
  timeoutMs,
  graceMs: GRACE_MS,
  stdout: "capture",
  maxStdout: MAX_STDOUT
})

/** proc.run in its own fiber: its result (null when interrupted) and a stop that waits until the child is gone */
const runChild = (proc: ProcService, o: RunOptions) => {
  const fiber = Effect.runFork(proc.run(o))
  const result = Effect.runPromise(Fiber.await(fiber)).then((exit) => (Exit.isSuccess(exit) ? exit.value : null))
  return { result, stop: () => Effect.runPromise(Fiber.interrupt(fiber)) }
}

const playFailed = (r: Result | null, timeoutMs: number): string => {
  if (r === null) return "play-seed was stopped (interrupted)"
  switch (r.kind) {
    case "exit": return `play-seed exited with ${r.code}`
    case "timeout": return `play-seed ran past ${Math.floor(timeoutMs / 1000)} s`
    case "stopped": return `play-seed was stopped (${r.reason.slice(0, 100)})`
    case "failed": return `play-seed ${r.reason.slice(0, 100)}`
  }
}

/** Plays a lease in `dir`: started at once; `done` is its outcome, `stop` ends it and waits until it is gone. */
const startPlay = (h: Ctx, slot: string, lease: Lease, dir: string, timeoutMs: number) => {
  const ctl = new AbortController()
  let child: ReturnType<typeof runChild> | null = null
  const done = (async (): Promise<PlayOutcome> => {
    try {
      // a fresh folder; job.json goes in while it is still root's (written once, never through a link), then the
      // folder becomes the bots' (play-seed writes out/ and arena/ in it)
      try {
        removeTree(dir)
        mkdirSync(dir, { recursive: true })
        chmodSync(dir, 0o700)
      } catch (e) {
        return { ok: false, why: `could not make the work folder (${errorCode(e)})` }
      }
      const job = path.join(dir, "job.json")
      try {
        writeFileSync(job, JSON.stringify(lease.job), { mode: 0o644, flag: "wx" })
      } catch (e) {
        return { ok: false, why: `could not write job.json (${errorCode(e)})` }
      }
      try {
        if (h.ids) chownSync(dir, h.ids.uid, h.ids.gid)
      } catch (e) {
        return { ok: false, why: `could not make the work folder (${errorCode(e)})` }
      }
      // a lease taken back stops waiting for its bundles at once; their download goes on for the cache
      const stopped = new Promise<string>((resolve) => ctl.signal.addEventListener("abort", () => resolve("stopped"), { once: true }))
      const getting = h.cache.get(lease.bundles, h.stopping)
      getting.catch(() => {})
      const why = await Promise.race([getting, stopped])
      if (ctl.signal.aborted) return { ok: false, why: "play-seed was stopped (interrupted)" }
      if (why !== null) return { ok: false, why }
      child = runChild(h.proc, playOptions(h, "play", ["--job", job, "--bundles", h.c.paths.bundles, "--work", dir], timeoutMs))
      const r = await child.result
      if (r === null || r.kind !== "exit" || r.code !== 0) return { ok: false, why: playFailed(r, timeoutMs) }
      // the folder is root's again before anything in it is read: nothing the bots' user still runs can swap a file
      // or a folder in it for a link from here on
      try {
        if (h.ids) {
          chownSync(dir, 0, 0)
          chmodSync(dir, 0o700)
        }
      } catch (e) {
        return { ok: false, why: `could not read the work folder (${errorCode(e)})` }
      }
      return resultBody(r.stdout, path.join(dir, "out"), h.ids?.uid ?? null)
    } catch (e) {
      Log.error(`slot ${slot}: the play task crashed (${String((e as Error)?.message ?? e).slice(0, 200)})`)
      return { ok: false, why: "the helper crashed while playing" }
    } finally {
      h.cache.release(lease.bundles)
    }
  })()
  let outcome: PlayOutcome | null = null
  void done.then((o) => (outcome = o))
  const stop = async () => {
    ctl.abort()
    if (child) await child.stop()
    await done
  }
  return { done, stop, finished: () => outcome }
}

const failedJson = (why: string) => JSON.stringify({ failed: why.slice(0, 300) })

/**
 * Posts a lease's result (or failure): tried again, 5 s apart, only while no answer comes; a 410 is fine (the machine
 * took the lease back meanwhile). Returns the note the log line ends with.
 */
const post = async (h: Ctx, id: string, json: string, tries: number, timeoutMs: number, signal: AbortSignal): Promise<string> => {
  for (let left = tries; ; left--) {
    const a = await h.client.result(id, json, timeoutMs, signal)
    if (a.kind === "ok") return ""
    if (a.kind === "gone") return " (the games machine no longer wanted it)"
    if (a.kind !== "error" || left <= 1 || h.stopping.aborted) return ` (not sent: ${describe(a)})`
    await sleep(POST_GAP_MS, h.stopping)
    if (h.stopping.aborted) return ` (not sent: ${describe(a)})`
  }
}

// one game per entry: its id, outcome and winning seat ("won p1", "STEP_CAP")
const outcomes = (results: ReadonlyArray<{ readonly id: string; readonly result: Record<string, unknown> }>) =>
  results.map(({ id, result }) => {
    const seat = typeof result.winnerSeat === "string" ? ` ${result.winnerSeat}` : ""
    return `${printableGame(id)} ${printableGame(result.outcome)}${printableGame(seat)}`
  }).join(", ")

const seedOf = (lease: Lease) => (typeof lease.job.seed === "number" && Number.isInteger(lease.job.seed) ? String(lease.job.seed) : "?")

/** One lease, from its claim's answer to its end (slot.ex): play, heartbeats, the result, the folder removed. */
const runLease = async (h: Ctx, slot: string, timing: HelloTiming, lease: Lease) => {
  const dir = path.join(h.helperDir, slot, lease.id)
  const started = monotonic()
  const secs = () => Math.floor((monotonic() - started) / 1000)
  // a minute before the machine's deadline, so the failure reaches it first
  const timeoutMs = Math.max(lease.deadlineMs - 60_000, 60_000)
  const play = startPlay(h, slot, lease, dir, timeoutMs)
  let tick = h.clock()
  // the first heartbeat at once: the machine's sign that the claim's answer got here
  let delay = 0

  const finish = async (why: string) => {
    const note = await post(h, lease.id, failedJson(why), POST_TRIES, POST_MS, h.hard)
    Log.info(`lease ${lease.id} (seed ${seedOf(lease)}): failed (${why}); ${secs()} s${note}`)
  }

  const played = async (o: PlayOutcome) => {
    if (!o.ok) return finish(o.why)
    // a game's watchdog counts wall-clock time: a sleep since the last heartbeat may have forfeited a bot
    if (slept(tick, h.clock())) {
      Log.warn(`lease ${lease.id}: the computer slept during the play; the seed goes back to the games machine`)
      return finish("the computer slept")
    }
    const note = await post(h, lease.id, o.json, POST_TRIES, POST_MS, h.hard)
    Log.info(`lease ${lease.id} (seed ${seedOf(lease)}): ${outcomes(o.results)}; ${secs()} s${note}`)
  }

  try {
    for (;;) {
      const wake = new AbortController()
      const next = await Promise.race([
        play.done.then((o) => ({ kind: "played", o }) as const),
        sleep(delay, AbortSignal.any([h.stopping, wake.signal])).then(() => ({ kind: h.stopping.aborted ? "stop" : "beat" }) as const)
      ])
      wake.abort()
      if (next.kind === "played") return await played(next.o)
      if (next.kind === "stop") {
        const o = play.finished()
        if (o) return await played(o)
        // the helper stops (docker stop, another build): the machine gets the seed back at once, not after a missed
        // heartbeat; the give-back has 3 s and goes while the play stops
        const neverAborts = new AbortController().signal
        await Promise.all([post(h, lease.id, failedJson("the helper stopped"), 1, GIVE_BACK_MS, neverAborts), play.stop()])
        return
      }
      const now = h.clock()
      if (slept(tick, now)) {
        Log.warn(`lease ${lease.id}: the computer slept; the seed goes back to the games machine`)
        await play.stop()
        return await finish("the computer slept")
      }
      const a = await h.client.heartbeat(lease.id, h.stopping)
      if (a.kind === "gone") {
        Log.info(`lease ${lease.id}: the games machine took it back (410); stopping its play`)
        await play.stop()
        return
      }
      if (a.kind === "build") h.stop(3, wrongBuild(a.want))
      else if (a.kind === "unauthorized") h.stop(1, WRONG_TOKEN)
      // ok, or no answer: playing on, the machine decides
      tick = now
      delay = timing.heartbeatMs
    }
  } finally {
    // whatever ended the lease, its play is gone before its folder goes (a no-op when it ended by itself)
    await play.stop()
    removeTree(dir)
  }
}

/**
 * One slot: claim, play the lease, claim again (slot.ex). 204 claims again at once; no answer backs off 5, 10, 20, 40,
 * then 60 s, logged once per reason; 409 stops the helper with 3, 401 with 1.
 */
const runSlot = async (h: Ctx, slot: string, timing: HelloTiming) => {
  let backoff = 0
  let failing: string | null = null
  const answered = () => {
    if (failing === null) return
    Log.info(`slot ${slot}: the games machine answers again`)
    backoff = 0
    failing = null
  }
  while (!h.stopping.aborted) {
    let a: Awaited<ReturnType<Client["claim"]>>
    try {
      a = await h.client.claim(slot, timing.claimMs, h.stopping)
    } catch {
      a = { kind: "error", why: "the claim crashed" }
    }
    if (h.stopping.aborted && a.kind !== "lease") return
    switch (a.kind) {
      case "lease":
        answered()
        await runLease(h, slot, timing, a.lease)
        break
      case "none":
        answered()
        break
      case "build":
        return h.stop(3, wrongBuild(a.want))
      case "unauthorized":
        return h.stop(1, WRONG_TOKEN)
      case "error": {
        const delays = h.c.timing.claimBackoffMs
        const wait = delays[Math.min(backoff, delays.length - 1)] ?? 60_000
        if (failing !== a.why) Log.warn(`slot ${slot}: no claim (${a.why}); trying again, the next in ${Math.floor(wait / 1000)} s`)
        backoff++
        failing = a.why
        await sleep(wait, h.stopping)
      }
    }
  }
}

/** a slot that ends by surprise is started again 5 s later, unless the helper stops */
const keepSlot = async (h: Ctx, slot: string, timing: HelloTiming) => {
  while (!h.stopping.aborted) {
    try {
      await runSlot(h, slot, timing)
      return
    } catch (e) {
      Log.error(`slot ${slot} ended (${String((e as Error)?.message ?? e).slice(0, 200)}); starting it again in 5 s`)
      await sleep(RESTART_MS, h.stopping)
    }
  }
}

/** play-seed.js --warm compiles the resident bundles the image builds, if any; a failure is only logged */
const warm = async (h: Ctx) => {
  const child = runChild(h.proc, playOptions(h, "warm", ["--warm"], WARM_MS))
  const stopIt = () => void child.stop()
  h.stopping.addEventListener("abort", stopIt, { once: true })
  const r = await child.result
  h.stopping.removeEventListener("abort", stopIt)
  if (h.stopping.aborted) return
  if (r === null || r.kind !== "exit" || r.code !== 0) return Log.warn(`play-seed --warm failed (${playFailed(r, WARM_MS)})`)
  let doc: unknown
  try {
    doc = JSON.parse(r.stdout.split("\n").filter((l) => l.trim() !== "").at(-1) ?? "")
  } catch {
    doc = null
  }
  if (!plain(doc) || doc.ok !== true) return Log.warn("play-seed --warm failed (warm printed something other than ok)")
  const names = (list: unknown) =>
    Array.isArray(list)
      ? list.flatMap((x) => (typeof x === "string" ? [x] : plain(x) && typeof x.name === "string" ? [x.name] : []))
      : []
  const failed = names(doc.failed)
  if (failed.length) Log.warn(`could not warm ${failed.join(", ")}`)
  else Log.info(`warmed ${names(doc.warmed).length} resident bundles`)
}

/** hello until the machine answers: its timing, or null when the helper stops (a signal, 409, 401) */
const hello = async (h: Ctx): Promise<HelloTiming | null> => {
  let failing: string | null = null
  while (!h.stopping.aborted) {
    const a = await h.client.hello(h.c.helperSlots, h.stopping)
    if (h.stopping.aborted) return null
    switch (a.kind) {
      case "ok":
        Log.info(`the games machine knows this helper as ${printable(a.timing.name)}; ${h.c.helperSlots} slots claim seeds`)
        return a.timing
      case "build":
        h.stop(3, wrongBuild(a.want))
        return null
      case "unauthorized":
        h.stop(1, WRONG_TOKEN)
        return null
      case "error": {
        const retry = h.c.timing.helloRetryMs
        if (failing !== a.why) Log.warn(`hello: no answer from the games machine (${a.why}); trying every ${Math.floor(retry / 1000)} s`)
        failing = a.why
        await sleep(retry, h.stopping)
      }
    }
  }
  return null
}

const botIds = (user: string): Ids => {
  try {
    const id = (flag: string) => Number(execFileSync("id", [flag, user], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim())
    const ids = { uid: id("-u"), gid: id("-g") }
    if (!Number.isInteger(ids.uid) || !Number.isInteger(ids.gid)) throw new Error("no ids")
    return ids
  } catch {
    throw new SetupError(`no user ${user}: the plays could not run as the bots' user`)
  }
}

/**
 * Before anything plays (Coord.Helper.prepare!): the server's folder for the pidfiles (0700) and the groups a crashed
 * run left reaped, `<data>/helper` wiped (0711 when the plays run as the bots' user, who must reach their own folder in
 * it, else 0700), and the bots' HOME and wasm cache made theirs.
 */
const prepare = (c: GamesConfig, proc: ProcService): { readonly ids: Ids | null; readonly helperDir: string } => {
  mkdirSync(c.paths.server, { recursive: true, mode: 0o700 })
  chmodSync(c.paths.server, 0o700)
  mkdirSync(c.paths.procs, { recursive: true, mode: 0o700 })
  proc.reapStale()
  const ids = process.getuid?.() === 0 ? botIds(c.arenaUser) : null
  // the plays of a run that crashed are gone (reaped), and so are their work folders
  const helperDir = path.join(c.data, "helper")
  removeTree(helperDir)
  mkdirSync(helperDir, { recursive: true })
  chmodSync(helperDir, ids ? 0o711 : 0o700)
  for (const dir of [c.paths.home, c.paths.wasmCache]) {
    mkdirSync(dir, { recursive: true })
    if (ids) chownSync(dir, ids.uid, ids.gid)
  }
  return { ids, helperDir }
}

/** Runs the helper until it stops; resolves its exit code: 0 stopped, 1 refused (401) or broken setup, 3 another build (409). */
export const runHelper = async (c: GamesConfig, secrets: Secrets, proc: ProcService, opts: HelperOptions): Promise<number> => {
  const stopper = new AbortController()
  const hardStopper = new AbortController()
  let code: number | null = null
  let hardTimer: NodeJS.Timeout | null = null
  let lateTimer: NodeJS.Timeout | null = null
  const stop = (exit: number, message: string | null) => {
    if (message !== null) Log.error(message)
    if (code === null) code = exit
    if (!stopper.signal.aborted) {
      stopper.abort()
      hardTimer = setTimeout(() => hardStopper.abort(), SLOT_STOP_MS)
    }
  }
  const onSignal = () => {
    const why = opts.signal.reason
    if (typeof why === "string" && /^SIG[A-Z]+$/.test(why)) Log.info(`${why} received - shutting down`)
    stop(0, null)
  }
  if (opts.signal.aborted) onSignal()
  else opts.signal.addEventListener("abort", onSignal, { once: true })

  try {
    const token = secrets.helperToken()
    if (!token) throw new SetupError("GAMES_HELPER_TOKEN is not set")
    if (!c.helperUrl) throw new SetupError("GAMES_HELPER_URL is not set")
    let setup: ReturnType<typeof prepare>
    let cache: BundleCache
    const client = makeClient(c, token)
    try {
      setup = prepare(c, proc)
      cache = makeBundleCache(c.paths.bundles, c.timing.bundlesLimit, client)
    } catch (e) {
      throw e instanceof SetupError ? e : new SetupError(`the helper's folders could not be made (${errorCode(e)})`)
    }
    const h: Ctx = {
      c, proc, client, cache, ids: setup.ids, helperDir: setup.helperDir,
      stopping: stopper.signal, hard: hardStopper.signal, stop, clock: opts.clock ?? defaultClock
    }
    if (!stopper.signal.aborted) await warm(h)
    const timing = await hello(h)
    if (timing) {
      const slots = Array.from({ length: c.helperSlots }, (_, i) => keepSlot(h, String(i + 1), timing))
      // once stopping, the slots get a little longer than their own limits (give-back 3 s, a play's grace, a result
      // being posted) before what is left of their plays is stopped below
      const late = new Promise<void>((resolve) => {
        const wait = () => (lateTimer = setTimeout(resolve, SLOT_STOP_MS + GRACE_MS + 2_000))
        if (stopper.signal.aborted) wait()
        else stopper.signal.addEventListener("abort", wait, { once: true })
      })
      await Promise.race([Promise.all(slots), late])
    }
  } catch (e) {
    if (!(e instanceof SetupError)) throw e
    Log.error(e.message)
    code ??= 1
  } finally {
    opts.signal.removeEventListener("abort", onSignal)
    if (hardTimer) clearTimeout(hardTimer)
    if (lateTimer) clearTimeout(lateTimer)
    await Effect.runPromise(proc.stopAll([], 1_000))
  }
  return code ?? 0
}
