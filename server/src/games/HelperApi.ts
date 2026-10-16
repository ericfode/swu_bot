/**
 * The helper API (bot/arena/HELPER.md) on GAMES_HELPER_LISTEN:GAMES_HELPER_PORT (Fly's private address, reached
 * through `fly proxy` and by the window's swarm relay, never a public port), wire-compatible with CoordWeb.HelperAPI:
 * an Elixir helper still running the previous image, and the window that relays browser tabs, both talk to it.
 *
 * Every request carries `authorization: Bearer <token>`, whose sha256 must be in GAMES_HELPER_TOKENS (401 otherwise,
 * before anything else is looked at), and `x-helper-build`, which must be this machine's build (409 otherwise, naming
 * the image to run: that answer is what makes an old helper exit 3 and pull this one). While the machine stops,
 * everything is 503. Routes, all under /v1:
 * - POST hello {build, cards, slots}: the timing to follow, or 409 when the build or the cards differ
 * - POST claim {slot}: waits up to claimMs for a seed: 200 {lease, job, bundles, deadlineMs}, or 204
 * - GET bundle/<hex>: a bundle named by a lease this helper holds now (else 404)
 * - POST lease/<id>/heartbeat: 200 {continue: true} while this helper holds it, else 410
 * - POST lease/<id>/result {results, replays} or {failed}: 200, or 410 as for a heartbeat
 * - GET swarm/<file>: a file of the browser swarm built with this image
 * - GET swarm/lineup.json: the latest round's versions whose tar is in the bundles folder, in roster order:
 *   200 {round, bots: [{bundle, bytes, name}]}, or {round: null, bots: []} before the first round
 * - GET swarm/bot/<hex>: the tar of a version in that lineup, for a person playing it in their tab (else 404)
 * The swarm routes are the ones without the build header (the window learns the build from swarm/manifest.json, and
 * relays them with the swarm's own token) and the ones still served while the machine stops.
 *
 * Answers keep the Elixir server's bytes where it costs nothing: JSON keys in the order Jason wrote them (sorted),
 * `application/json; charset=utf-8`, files with no charset, Plug's cache-control. A job goes out with its keys in the
 * order the round built it: play-seed compares deck lists by their JSON text. Tokens and paths are never logged;
 * helper names and lease ids may be.
 */
import { constants } from "node:fs"
import { open, type FileHandle } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { createServer as createNetServer, isIPv6 } from "node:net"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import type { GamesConfig } from "./Config.ts"
import type { LeaseBoardImpl, LeaseOutcome } from "./Leases.ts"
import { firstChars, tarSize } from "./Leases.ts"
import * as Log from "./Log.ts"
import type { Secrets } from "./Secrets.ts"

/** The latest round's versions, in roster order, each with its bundle's sha256 (RoundSpec bots and bundles). */
export interface Lineup {
  readonly round: number
  readonly bots: ReadonlyArray<{ readonly name: string; readonly bundle: string }>
}

export interface HelperApiOptions {
  readonly config: GamesConfig
  readonly secrets: Secrets
  readonly board: LeaseBoardImpl
  readonly isStopping: () => boolean
  /** the latest round in games.db, null before the first (without it: no round, so swarm/bot/<hex> is always 404) */
  readonly lineup?: () => Promise<Lineup | null>
}

export interface Listening {
  readonly host: string
  readonly port: number
  readonly close: () => Promise<void>
}

/** The helper node is on only with a helper port and at least one usable entry in GAMES_HELPER_TOKENS. */
export const helperNodeOn = (c: GamesConfig, secrets: Secrets) => c.helperPort !== null && secrets.helpers.length > 0

const SMALL = 4_096
const RESULT_LIMIT = 40_000_000
const LEASE_ID = /^[A-Za-z0-9_-]{1,64}$/
const SLOT = /^[A-Za-z0-9_-]{1,32}$/
const HEX64 = /^[0-9a-f]{64}$/
const FAILED_CHARS = 300
/** bodies are read in chunks of this size, each within the read time (Plug's read_length and read_timeout) */
const READ_CHUNK = 1_000_000
const READ_MS = 15_000
/** a result comes over someone's home connection */
const RESULT_READ_MS = 60_000
/** how long a stop waits for open requests before cutting them (Bandit's shutdown_timeout) */
const CLOSE_MS = 1_000
/** on every answer Plug sends */
const CACHE_CONTROL = "max-age=0, private, must-revalidate"
const JSON_TYPE = "application/json; charset=utf-8"

/** The browser swarm's files (bot/swarm, built into the image), only these names: the window's list is the same. */
const SWARM_FILES: Readonly<Record<string, string>> = {
  "manifest.json": "application/json",
  "engine.json": "application/json",
  "python-lib.json": "application/json",
  "python.wasm": "application/wasm",
  "referee-worker.js": "text/javascript",
  "bot-worker.js": "text/javascript",
  "executor-worker.js": "text/javascript",
  "play-worker.js": "text/javascript",
  // the JEPA bot's models (bot/swarm/pack.js MODELS), which a tab fetches only to play that bot
  "tx-t10.safetensors": "application/octet-stream",
  "tx-t10-e.safetensors": "application/octet-stream"
}

type Req = IncomingMessage
type Res = ServerResponse

const plain = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)

/** The values a header came with, every line of it (Node keeps only the first of a repeated authorization). */
const headerValues = (req: Req, name: string): Array<string> => {
  const out: Array<string> = []
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]!.toLowerCase() === name) out.push(req.rawHeaders[i + 1]!)
  }
  return out
}

/** Plug's path_info: the path split on "/", empty segments dropped, nothing decoded. */
export const pathInfo = (url: string | undefined): Array<string> => {
  let p = (url ?? "/").split("?")[0]!
  const absolute = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(p)
  if (absolute) p = p.slice(absolute[0].length)
  return p.split("/").filter((s) => s !== "")
}

// --- answers

const answer = (req: Req, res: Res, status: number, type: string | null, body: string | Buffer) => {
  const headers: Record<string, string | number> = { "cache-control": CACHE_CONTROL }
  if (type) headers["content-type"] = type
  if (status !== 204) headers["content-length"] = Buffer.byteLength(body)
  // a body left unread is not read just to keep the connection
  if (!req.complete) headers.connection = "close"
  res.writeHead(status, headers)
  res.end(status === 204 ? undefined : body)
}

const json = (req: Req, res: Res, status: number, body: unknown) => answer(req, res, status, JSON_TYPE, JSON.stringify(body))

/** The window's error shape, {"error":{"code":...,"message":...}}, with no message key when there is none. */
const fail = (req: Req, res: Res, status: number, code: string, message?: string) =>
  json(req, res, status, { error: message === undefined ? { code } : { code, message } })

const gone = (req: Req, res: Res) => fail(req, res, 410, "gone")

/** A file: 200 with its type and bytes when it is a regular file, else notFound(). */
const sendFile = async (req: Req, res: Res, file: string, type: string, follow: boolean, notFound: () => void) => {
  let fh: FileHandle
  try {
    // never blocks on a FIFO; a link is not followed where the folder's files never are links
    fh = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | (follow ? 0 : constants.O_NOFOLLOW))
  } catch {
    return notFound()
  }
  try {
    const st = await fh.stat()
    if (!st.isFile()) {
      await fh.close()
      return notFound()
    }
    const headers: Record<string, string | number> = { "cache-control": CACHE_CONTROL, "content-type": type, "content-length": st.size }
    if (!req.complete) headers.connection = "close"
    res.writeHead(200, headers)
    await pipeline(fh.createReadStream(), res)
  } catch {
    // the helper went away while the file was sent: nothing to answer
    res.destroy()
    await fh.close().catch(() => {})
  }
}

// --- bodies

type Read = { readonly kind: "ok"; readonly body: Buffer } | { readonly kind: "too_large" } | { readonly kind: "error" }

/**
 * The whole body when it is at most `limit` bytes. A declared length over the limit is refused before reading; one
 * byte over is enough to know. Each 1 MB must come within `chunkMs`.
 */
const readLimited = (req: Req, limit: number, chunkMs = READ_MS): Promise<Read> => {
  const declared = req.headers["content-length"]
  if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > limit) return Promise.resolve({ kind: "too_large" })
  return new Promise((resolve) => {
    const chunks: Array<Buffer> = []
    let size = 0
    let next = READ_CHUNK
    let timer = setTimeout(() => end({ kind: "error" }), chunkMs)
    const end = (r: Read) => {
      clearTimeout(timer)
      req.off("data", onData)
      req.off("end", onEnd)
      req.off("error", onError)
      req.off("close", onClose)
      resolve(r)
    }
    const onData = (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) return end({ kind: "too_large" })
      chunks.push(chunk)
      if (size >= next) {
        next = (Math.floor(size / READ_CHUNK) + 1) * READ_CHUNK
        clearTimeout(timer)
        timer = setTimeout(() => end({ kind: "error" }), chunkMs)
      }
    }
    const onEnd = () => end({ kind: "ok", body: Buffer.concat(chunks, size) })
    const onError = () => end({ kind: "error" })
    const onClose = () => {
      if (!req.complete) end({ kind: "error" })
    }
    req.on("data", onData)
    req.on("end", onEnd)
    req.on("error", onError)
    req.on("close", onClose)
  })
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/**
 * The body as JSON, as Jason decoded it: valid UTF-8 (a BOM is not whitespace), and numbers written with a fraction
 * or an exponent are floats, never integers (`floats` gets the holder objects and keys of those).
 */
const parseJson = (body: Buffer, floats?: WeakMap<object, Set<string>>): unknown => {
  const text = utf8.decode(body)
  if (!floats) return JSON.parse(text)
  return JSON.parse(text, function(this: object, key: string, value: unknown, context?: { source?: string }) {
    if (typeof value === "number" && context?.source !== undefined && /[.eE]/.test(context.source)) {
      const keys = floats.get(this) ?? new Set<string>()
      keys.add(key)
      floats.set(this, keys)
    }
    return value
  } as (key: string, value: unknown) => unknown)
}

/** A JSON object of at most `limit` bytes, or null with a 400 or 413 answered. */
const readJson = async (req: Req, res: Res, limit: number, chunkMs?: number, floats?: WeakMap<object, Set<string>>) => {
  const r = await readLimited(req, limit, chunkMs)
  if (r.kind === "too_large") {
    fail(req, res, 413, "too_large", `request body over ${limit} bytes`)
    return null
  }
  if (r.kind === "error") {
    fail(req, res, 400, "bad_request", "could not read the request body")
    return null
  }
  let doc: unknown
  try {
    doc = parseJson(r.body, floats)
  } catch {
    doc = null
  }
  if (!plain(doc)) {
    fail(req, res, 400, "bad_request", "the body is not a JSON object")
    return null
  }
  return doc
}

/**
 * A result's shape, the only check the machine makes (the round checks the games): a list of {id, result} and a map of
 * replay texts, or a failure reason (cut to 300 characters). The rest is kept as it came.
 */
export const outcomeOf = (body: Record<string, unknown>): LeaseOutcome | null => {
  if (typeof body.failed === "string") return { failed: firstChars(body.failed, FAILED_CHARS) }
  if (!Array.isArray(body.results)) return null
  const replays = Object.hasOwn(body, "replays") ? body.replays : {}
  const entries = body.results.every((e) => plain(e) && typeof e.id === "string" && plain(e.result))
  if (!entries || !plain(replays) || !Object.values(replays).every((v) => typeof v === "string")) return null
  return { results: body.results, replays: replays as Record<string, string> }
}

// --- the API

const buildMatches = (c: GamesConfig, build: unknown) => typeof build === "string" && c.build !== "unknown" && build === c.build

const wrongBuild = (o: HelperApiOptions, req: Req, res: Res) => {
  const c = o.config
  json(req, res, 409, {
    error: {
      code: "build",
      message: `the games machine runs build ${c.build}`,
      want: { build: c.build, cards: c.cards, image: `${c.helperImage}:${c.build}` }
    }
  })
}

/** The helper's name: exactly one `authorization: Bearer <token>` whose token is known. */
const authorize = (o: HelperApiOptions, req: Req): string | null => {
  const values = headerValues(req, "authorization")
  if (values.length !== 1 || !values[0]!.startsWith("Bearer ")) return null
  return o.secrets.helperName(values[0]!.slice("Bearer ".length))
}

const hello = async (o: HelperApiOptions, req: Req, res: Res, name: string) => {
  const floats = new WeakMap<object, Set<string>>()
  const body = await readJson(req, res, SMALL, undefined, floats)
  if (!body) return
  const { build, cards, slots } = body
  if (typeof build !== "string" || typeof cards !== "string" || !Number.isInteger(slots) || floats.get(body)?.has("slots")) {
    return fail(req, res, 400, "bad_request", "hello needs build, cards and slots")
  }
  // cards nobody could read never match, as an unknown build never does
  if (!buildMatches(o.config, build) || cards !== o.config.cards || cards === "unknown") return wrongBuild(o, req, res)
  o.board.hello(name)
  Log.info(`helper ${name} said hello (${Math.min(Math.max(slots as number, 0), 99)} slots)`)
  const t = o.config.timing
  json(req, res, 200, { claimMs: t.claimMs, heartbeatMs: t.heartbeatMs, leaseLostMs: t.leaseLostMs, name, ok: true })
}

const claim = async (o: HelperApiOptions, req: Req, res: Res, name: string) => {
  const body = await readJson(req, res, SMALL)
  if (!body) return
  const slot = body.slot
  if (typeof slot !== "string" || !SLOT.test(slot)) return fail(req, res, 400, "bad_request", "claim needs a slot id")
  // the claim stands while its request does: a helper that goes away no longer waits, and a lease offered to it is lost
  const away = new AbortController()
  res.on("close", () => {
    if (!res.writableFinished) away.abort()
  })
  if (!res.socket || res.socket.destroyed) away.abort()
  const got = await o.board.awaitClaim(name, slot, o.config.timing.claimMs, away.signal)
  if (got === "none") return answer(req, res, 204, null, "")
  if (got === "stopping") return fail(req, res, 503, "stopping")
  // when the answer cannot be sent, the lease goes back at once instead of waiting for a heartbeat that never comes
  const sent = await new Promise<boolean>((resolve) => {
    if (away.signal.aborted || !res.socket || res.socket.destroyed) return resolve(false)
    res.once("finish", () => resolve(true))
    res.once("close", () => resolve(res.writableFinished))
    try {
      json(req, res, 200, {
        bundles: got.bundles.map((b) => ({ bytes: b.bytes, id: b.id })),
        deadlineMs: got.deadlineMs,
        job: got.job,
        lease: got.lease
      })
    } catch {
      resolve(false)
    }
  })
  if (sent) o.board.claimSent(got.lease)
  else o.board.claimDropped(got.lease)
}

const bundle = async (o: HelperApiOptions, req: Req, res: Res, name: string, hex: string) => {
  const notFound = () => fail(req, res, 404, "not_found")
  const file = HEX64.test(hex) ? o.board.bundleFile(name, hex) : null
  if (!file) return notFound()
  await sendFile(req, res, file, "application/x-tar", false, notFound)
}

const heartbeat = async (o: HelperApiOptions, req: Req, res: Res, name: string, id: string) => {
  const r = await readLimited(req, SMALL)
  if (r.kind === "too_large") return fail(req, res, 413, "too_large", `request body over ${SMALL} bytes`)
  if (r.kind === "error") return fail(req, res, 400, "bad_request", "could not read the request body")
  if (LEASE_ID.test(id) && o.board.heartbeat(id, name)) return json(req, res, 200, { continue: true })
  gone(req, res)
}

/**
 * A lease this helper does not hold is answered before its (up to 40 MB) body is read. The check is a heartbeat, so a
 * slow upload gets a full leaseLostMs before the sweep could take the lease back.
 */
const result = async (o: HelperApiOptions, req: Req, res: Res, name: string, id: string) => {
  if (!LEASE_ID.test(id) || !o.board.heartbeat(id, name)) return gone(req, res)
  const body = await readJson(req, res, RESULT_LIMIT, RESULT_READ_MS)
  if (!body) return
  const outcome = outcomeOf(body)
  if (!outcome) return fail(req, res, 400, "bad_request", "a result is {results, replays} or {failed}")
  if (o.board.result(id, name, outcome)) return json(req, res, 200, { ok: true })
  gone(req, res)
}

const swarmFile = async (o: HelperApiOptions, req: Req, res: Res, file: string) => {
  const type = Object.hasOwn(SWARM_FILES, file) ? SWARM_FILES[file]! : null
  if (!type) return fail(req, res, 404, "not_found")
  await sendFile(req, res, path.join(o.config.paths.swarm, file), type, true, () =>
    fail(req, res, 404, "not_found", "this image has no swarm files"))
}

/**
 * The latest round's versions whose tar is a regular file in the bundles folder (as an offer checks), in roster order,
 * with each tar's size. Read on every request: one row of games.db and a stat per version.
 */
const tableLineup = async (o: HelperApiOptions) => {
  const lineup = o.lineup ? await o.lineup() : null
  if (!lineup) return { bots: [], round: null }
  const bots: Array<{ bundle: string; bytes: number; name: string }> = []
  for (const b of lineup.bots) {
    const bytes = tarSize(o.config.paths.bundles, b.bundle)
    if (bytes !== null) bots.push({ bundle: b.bundle, bytes, name: b.name })
  }
  return { bots, round: lineup.round }
}

/** swarm/lineup.json, its keys sorted as every other answer's */
const swarmLineup = async (o: HelperApiOptions, req: Req, res: Res) => json(req, res, 200, await tableLineup(o))

/** swarm/bot/<hex>: the canonical tar of a version in the lineup, for a person's tab to play it */
const swarmBot = async (o: HelperApiOptions, req: Req, res: Res, hex: string) => {
  const notFound = () => fail(req, res, 404, "not_found")
  if (!HEX64.test(hex)) return notFound()
  const { bots } = await tableLineup(o)
  if (!bots.some((b) => b.bundle === hex)) return notFound()
  await sendFile(req, res, path.join(o.config.paths.bundles, `${hex}.tar`), "application/x-tar", false, notFound)
}

const handle = async (o: HelperApiOptions, req: Req, res: Res) => {
  // let the parser finish the bytes that came with the headers first: a small body is then complete, and an answer
  // given before reading it does not need to close the connection
  await Promise.resolve()
  const name = authorize(o, req)
  if (name === null) return fail(req, res, 401, "unauthorized", "a helper token is needed")
  const p = pathInfo(req.url)
  const m = req.method
  if (m === "GET" && p[0] === "v1" && p[1] === "swarm") {
    if (p.length === 3 && p[2] === "lineup.json") return swarmLineup(o, req, res)
    if (p.length === 3) return swarmFile(o, req, res, p[2]!)
    if (p.length === 4 && p[2] === "bot") return swarmBot(o, req, res, p[3]!)
  }
  const builds = headerValues(req, "x-helper-build")
  if (builds.length !== 1 || !buildMatches(o.config, builds[0])) return wrongBuild(o, req, res)
  if (o.isStopping()) return fail(req, res, 503, "stopping")
  if (p[0] === "v1") {
    if (m === "POST" && p.length === 2 && p[1] === "hello") return hello(o, req, res, name)
    if (m === "POST" && p.length === 2 && p[1] === "claim") return claim(o, req, res, name)
    if (m === "GET" && p.length === 3 && p[1] === "bundle") return bundle(o, req, res, name, p[2]!)
    if (m === "POST" && p.length === 4 && p[1] === "lease" && p[3] === "heartbeat") return heartbeat(o, req, res, name, p[2]!)
    if (m === "POST" && p.length === 4 && p[1] === "lease" && p[3] === "result") return result(o, req, res, name, p[2]!)
  }
  fail(req, res, 404, "not_found")
}

/** True when this process can listen on that IPv6 address (Coord.Config ipv6_available?). */
const bindable = (host: string) =>
  new Promise<boolean>((resolve) => {
    const probe = createNetServer()
    probe.once("error", () => resolve(false))
    probe.listen({ host, port: 0, exclusive: true }, () => probe.close(() => resolve(true)))
  })

const allZero = (ip: string) => {
  try {
    return new URL(`http://[${ip}]/`).hostname === "[::]"
  } catch {
    return false
  }
}

/**
 * The address to listen on: GAMES_HELPER_LISTEN (else Fly's private address). When that IPv6 address cannot be used,
 * :: becomes 0.0.0.0 and any other address 127.0.0.1, never a wider one.
 */
export const listenAddress = async (listen: string): Promise<string> => {
  if (!isIPv6(listen) || (await bindable(listen))) return listen
  const fallback = allZero(listen) ? "0.0.0.0" : "127.0.0.1"
  Log.warn(`no IPv6 here: listening on ${fallback} instead of ${listen}`)
  return fallback
}

const closeServer = (server: Server) =>
  new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeIdleConnections()
    // a claim still waiting sees the stop flag within a second and answers 503; anything later is cut
    setTimeout(() => server.closeAllConnections(), CLOSE_MS).unref()
  })

export const startHelperApi = async (o: HelperApiOptions): Promise<Listening> => {
  const port = o.config.helperPort
  if (port === null) throw new Error("the helper node is off: GAMES_HELPER_PORT is not set")
  const host = await listenAddress(o.config.helperListen)
  const server = createServer((req, res) => {
    handle(o, req, res).catch((e: unknown) => {
      // no crash report prints the request (its path, its authorization header)
      Log.error(`helper API: ${e instanceof Error ? e.name : typeof e} raised`)
      if (!res.headersSent) fail(req, res, 500, "internal", "the games machine could not answer")
      else res.destroy()
    })
  })
  // a result may take minutes to upload: its body times out per MB instead (readLimited)
  server.requestTimeout = 0
  // an idle kept-alive connection stays open as long as Bandit kept it (60 s), so a helper's pool, which retries
  // nothing, does not send on a connection this side just closed
  server.keepAliveTimeout = 60_000
  server.headersTimeout = 65_000
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen({ host, port }, () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return { host: address.address, port: address.port, close: () => closeServer(server) }
}
