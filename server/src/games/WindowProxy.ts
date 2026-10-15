/**
 * The only way a child reaches the window (CoordWeb.WindowProxy): a signing proxy on 127.0.0.1:GAMES_PROXY_PORT.
 *
 * `gamesctl push` gets SWU_WINDOW=http://127.0.0.1:<port>/p/<push nonce> and `gamesctl intake` .../i/<intake nonce>;
 * both nonces are new at every boot. A request must carry its role's nonce and be on that role's allow-list; it then
 * goes to the window with `authorization: Bearer <token>` in place of whatever came in, and the window's status, body
 * and content-type come back unchanged (push.js reads its 409 conflict and size answers from them). So the token never
 * leaves this process, and each child can do only what its role needs: the window token could read every
 * submission's source. Paths are never logged.
 *
 * `request` is also the settings poll's client: plain node:http(s), no redirects, no retries, no compression asked for
 * and no environment proxy, as the coordinator's Req calls were.
 */
import http from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import https from "node:https"
import { sameSecret } from "./Secrets.ts"
import * as Log from "./Log.ts"

// the window's own limits (window.js MAX_DOC, MAX_APPEND, MAX_REPLAY)
export const DOC_LIMIT = 16_000_000
export const APPEND_LIMIT = 8_000_000
export const REPLAY_LIMIT = 32_000_000

const PUSH_COLLECTIONS = ["arena", "runs", "ladders", "panels", "experiments"]
const RUN = /^arena-[\w-]+$/

/** the window's answer to a proxied request may wait this long between packets (Req receive_timeout) */
const UPSTREAM_MS = 60_000
/** a request body may pause this long between chunks (Plug's read timeout) */
const BODY_IDLE_MS = 15_000
/** open requests get this long once the proxy closes (a push killed mid-request may hold one for 60 s) */
const CLOSE_MS = 1_000
/** what the proxy keeps of an answer: a submission document is at most 16 MB */
const MAX_ANSWER = 40_000_000

export type Role = "push" | "intake"

export interface Answer {
  readonly status: number
  readonly contentType: string | null
  readonly body: Buffer
}

/**
 * One HTTP request, its whole answer kept: no redirect followed, no retry, no accept-encoding, no proxy from the
 * environment. `path` is appended to the base address as it is (still percent-encoded).
 */
export const request = (base: string, path: string, o: {
  readonly method: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: Buffer | null
  readonly timeoutMs: number
  readonly maxBytes?: number
}): Promise<Answer> =>
  new Promise((resolve, reject) => {
    let u: URL
    try {
      u = new URL(base)
    } catch {
      reject(new Error("the window's address is not a URL"))
      return
    }
    const mod = u.protocol === "https:" ? https : u.protocol === "http:" ? http : null
    if (!mod) {
      reject(new Error("the window's address is not http(s)"))
      return
    }
    const headers: Record<string, string> = { ...o.headers }
    if (o.body) headers["content-length"] = String(o.body.length)
    const max = o.maxBytes ?? MAX_ANSWER
    let settled = false
    const fail = (e: Error) => {
      if (settled) return
      settled = true
      reject(e)
    }
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname.replace(/^\[|\]$/g, ""),
      port: u.port || undefined,
      path: `${u.pathname.replace(/\/+$/, "")}${path}`,
      method: o.method,
      headers,
      agent: false
    }, (res) => {
      const chunks: Array<Buffer> = []
      let size = 0
      res.on("data", (chunk: Buffer) => {
        size += chunk.length
        if (size > max) {
          req.destroy(new Error(`its answer is over ${max} bytes`))
          return
        }
        chunks.push(chunk)
      })
      res.on("end", () => {
        if (settled) return
        settled = true
        const type = res.headers["content-type"]
        resolve({ status: res.statusCode ?? 0, contentType: typeof type === "string" ? type : null, body: Buffer.concat(chunks) })
      })
      res.on("error", fail)
      res.on("close", () => fail(new Error("the answer was cut off")))
    })
    req.setTimeout(o.timeoutMs, () => req.destroy(new Error(`no answer within ${o.timeoutMs} ms`)))
    req.on("error", fail)
    req.end(o.body ?? undefined)
  })

/** An answer in the window's error shape, `{"error":{"code":..,"message":..}}` (CoordWeb.Body.error). */
export const sendError = (res: ServerResponse, status: number, code: string, message: string, close = false) => {
  const body = JSON.stringify({ error: { code, message } })
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...(close ? { connection: "close" } : {})
  })
  res.end(body)
}

/**
 * Each segment is checked decoded (so %2e%2e and %2f are caught) and forwarded as it came, still encoded. A "." (or
 * "%2e") is refused too: the window's URL parser drops it, so the path checked would not be the path served.
 */
const decodeSegment = (raw: string): string | null => {
  let s: string
  try {
    s = decodeURIComponent(raw)
  } catch {
    return null
  }
  if (s === "" || s === "." || s.includes("/") || s.includes("..") || s.includes("\\") || /[\x00-\x1f]/.test(s)) return null
  return s
}

export interface Target {
  readonly role: Role
  /** the path after the nonce, as it came (still encoded) */
  readonly rest: ReadonlyArray<string>
  /** the same, decoded and checked */
  readonly segments: ReadonlyArray<string>
  readonly query: string
}

/** The role, path and query of a request target, or null when it is not through the proxy (403). */
export const parseTarget = (url: string, nonces: { readonly push: string; readonly intake: string }): Target | null => {
  const q = url.indexOf("?")
  const rawPath = q < 0 ? url : url.slice(0, q)
  const query = q < 0 ? "" : url.slice(q + 1)
  // as Plug's path_info: empty segments do not count
  const parts = rawPath.split("/").filter((s) => s !== "")
  const role: Role | null = parts[0] === "p" ? "push" : parts[0] === "i" ? "intake" : null
  const nonce = parts[1]
  if (role === null || nonce === undefined || !sameSecret(nonce, nonces[role])) return null
  if (rawPath.includes("..")) return null
  const rest = parts.slice(2)
  const segments: Array<string> = []
  for (const raw of rest) {
    const s = decodeSegment(raw)
    if (s === null) return null
    segments.push(s)
  }
  return { role, rest, segments, query }
}

/** The body limit of an allowed request, or null when the role may not make it. */
export const allow = (role: Role, method: string, s: ReadonlyArray<string>, query: string): number | null => {
  const api = (second: string) => s[0] === "api" && s[1] === second
  if (role === "push") {
    // what push.js needs: the arena's documents, and the arena's runs' replays
    if (method === "PUT" && s.length === 4 && api("docs") && PUSH_COLLECTIONS.includes(s[2]!) && query === "") return DOC_LIMIT
    if (method === "GET" && s.length === 3 && api("replays") && RUN.test(s[2]!) && query === "sizes=1") return 0
    if (method === "POST" && s.length === 4 && api("replays") && RUN.test(s[2]!) && /^at=\d+$/.test(query)) return APPEND_LIMIT
    if (method === "PUT" && s.length === 4 && api("replays") && RUN.test(s[2]!) && query === "") return REPLAY_LIMIT
    return null
  }
  // what intake.js needs: the submissions, and nothing else
  if (s.length >= 3 && s.length <= 4 && api("docs") && s[2] === "submissions" && query === "") {
    if (method === "GET") return 0
    if (method === "PUT" && s.length === 4) return DOC_LIMIT
  }
  return null
}

type Body = { readonly kind: "ok"; readonly body: Buffer } | { readonly kind: "too_large" } | { readonly kind: "error" }

/** The whole body if it is at most `limit` bytes; a declared length over the limit is refused before reading. */
export const readBody = (req: IncomingMessage, limit: number, idleMs = BODY_IDLE_MS): Promise<Body> =>
  new Promise((resolve) => {
    const declared = req.headers["content-length"]
    if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > limit) {
      resolve({ kind: "too_large" })
      return
    }
    const chunks: Array<Buffer> = []
    let size = 0
    let done = false
    let timer: NodeJS.Timeout | null = null
    const finish = (b: Body) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      req.removeListener("data", onData)
      resolve(b)
    }
    const idle = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => finish({ kind: "error" }), idleMs)
    }
    const onData = (chunk: Buffer) => {
      size += chunk.length
      // one byte over the limit is enough to know the body is too large
      if (size > limit) {
        finish({ kind: "too_large" })
        return
      }
      chunks.push(chunk)
      idle()
    }
    req.on("data", onData)
    req.on("end", () => finish({ kind: "ok", body: Buffer.concat(chunks) }))
    req.on("error", () => finish({ kind: "error" }))
    req.on("close", () => {
      if (!req.complete) finish({ kind: "error" })
    })
    idle()
  })

export interface ProxyOptions {
  /** the window's address (no trailing slash); null off the machine: every forward answers 502 */
  readonly window: string | null
  readonly token: () => string | null
  readonly nonces: { readonly push: string; readonly intake: string }
  readonly port: number
  readonly host?: string
  readonly upstreamMs?: number
}

export interface WindowProxy {
  readonly port: number
  /** SWU_WINDOW for gamesctl push */
  readonly push: string
  /** SWU_WINDOW for gamesctl intake */
  readonly intake: string
  readonly close: () => Promise<void>
}

const forward = async (o: ProxyOptions, req: IncomingMessage, res: ServerResponse, t: Target, body: Buffer) => {
  const method = req.method ?? "GET"
  const headers: Record<string, string> = {}
  const type = req.headers["content-type"]
  if (typeof type === "string") headers["content-type"] = type
  const token = o.token()
  if (token) headers.authorization = `Bearer ${token}`
  let answer: Answer
  try {
    if (!o.window) throw new Error("no window address (SWU_WINDOW)")
    answer = await request(o.window, `/${t.rest.join("/")}${t.query ? `?${t.query}` : ""}`, {
      method,
      headers,
      body: method === "GET" ? null : body,
      timeoutMs: o.upstreamMs ?? UPSTREAM_MS
    })
  } catch (e) {
    Log.warn(`window proxy: the window did not answer (${(e as Error).message})`)
    sendError(res, 502, "unavailable", "the window did not answer")
    return
  }
  res.writeHead(answer.status, {
    ...(answer.contentType ? { "content-type": answer.contentType } : {}),
    "content-length": answer.body.length
  })
  res.end(answer.body)
}

/** Starts the proxy on 127.0.0.1 (loopback only: children reach it, nothing else does). */
export const startWindowProxy = (o: ProxyOptions): Promise<WindowProxy> => {
  const server = http.createServer((req, res) => {
    const t = parseTarget(req.url ?? "", o.nonces)
    const limit = t === null ? null : allow(t.role, req.method ?? "", t.segments, t.query)
    if (t === null || limit === null) {
      sendError(res, 403, "forbidden", "not through the games proxy")
      return
    }
    void readBody(req, limit).then((b) => {
      if (b.kind === "too_large") sendError(res, 413, "too_large", `request body over ${limit} bytes`, true)
      else if (b.kind === "error") sendError(res, 400, "bad_request", "could not read the request body", true)
      else return forward(o, req, res, t, b.body)
    }).catch((e) => {
      Log.error(`window proxy: ${(e as Error).message}`)
      if (!res.headersSent) sendError(res, 500, "internal", "internal error")
      else res.destroy()
    })
  })
  const host = o.host ?? "127.0.0.1"
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(o.port, host, () => {
      server.removeListener("error", reject)
      server.on("error", (e) => Log.error(`window proxy: ${e.message}`))
      const port = (server.address() as { port: number }).port
      const close = () =>
        new Promise<void>((done) => {
          const timer = setTimeout(() => server.closeAllConnections(), CLOSE_MS)
          server.close(() => {
            clearTimeout(timer)
            done()
          })
          server.closeIdleConnections()
        })
      resolve({
        port,
        push: `http://${host}:${port}/p/${o.nonces.push}`,
        intake: `http://${host}:${port}/i/${o.nonces.intake}`,
        close
      })
    })
  })
}
