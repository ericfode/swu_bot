/**
 * The wake and health endpoint on GAMES_LISTEN:PORT (8080), reached over Fly's private network only (flycast):
 *
 * - `POST /wake` (any body, never read; no auth): 202 `{"ok":true}`, and the scheduler wakes: the idle clock starts
 *   again, an intake pass runs now and a plan follows. The window sends it for each submission and every 6 hours.
 * - `GET /healthz`: 200 `{"ok":true}`, Fly's check; it says nothing about the arena.
 * - anything else: 404 `{"error":"not found"}`.
 *
 * No sessions, no request logging, nothing about the arena (CoordWeb.Endpoint, Router, OpsController).
 */
import http from "node:http"
import type { Server, ServerResponse } from "node:http"
import { isIPv6 } from "node:net"
import * as Log from "./Log.ts"

const CLOSE_MS = 1_000

const json = (res: ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) })
  res.end(text)
}

/**
 * Listens on `host`, or, when it is an IPv6 address this host cannot use (a machine without IPv6), on `fallback`
 * with a warning (Coord.Config.listen_ip).
 */
export const listen = (server: Server, host: string, port: number, fallback: string): Promise<{ host: string; port: number }> => {
  const attempt = (h: string) =>
    new Promise<number>((resolve, reject) => {
      const onError = (e: Error) => {
        server.removeListener("listening", onListening)
        reject(e)
      }
      const onListening = () => {
        server.removeListener("error", onError)
        resolve((server.address() as { port: number }).port)
      }
      server.once("error", onError)
      server.once("listening", onListening)
      server.listen(port, h)
    })
  return attempt(host).then(
    (p) => ({ host, port: p }),
    (e: NodeJS.ErrnoException) => {
      if (!isIPv6(host) || (e.code !== "EAFNOSUPPORT" && e.code !== "EADDRNOTAVAIL")) throw e
      Log.warn(`no IPv6 here: listening on ${fallback} instead of ${host}`)
      return attempt(fallback).then((p) => ({ host: fallback, port: p }))
    }
  )
}

export interface OpsHttp {
  readonly port: number
  /** stops taking requests; open ones get a second */
  readonly close: () => Promise<void>
}

export const startOpsHttp = async (o: { readonly host: string; readonly port: number; readonly onWake: () => void }): Promise<OpsHttp> => {
  const server = http.createServer((req, res) => {
    const q = (req.url ?? "").indexOf("?")
    // as Phoenix's router: the path's segments, the query ignored
    const segments = (q < 0 ? req.url ?? "" : (req.url ?? "").slice(0, q)).split("/").filter((s) => s !== "")
    const only = segments.length === 1 ? segments[0] : null
    if (req.method === "POST" && only === "wake") {
      json(res, 202, { ok: true })
      o.onWake()
    } else if ((req.method === "GET" || req.method === "HEAD") && only === "healthz") {
      json(res, 200, { ok: true })
    } else {
      json(res, 404, { error: "not found" })
    }
  })
  server.on("clientError", (_e, socket) => socket.destroy())
  const at = await listen(server, o.host, o.port, "0.0.0.0")
  server.on("error", (e) => Log.error(`wake endpoint: ${e.message}`))
  return {
    port: at.port,
    close: () =>
      new Promise<void>((done) => {
        const timer = setTimeout(() => server.closeAllConnections(), CLOSE_MS)
        server.close(() => {
          clearTimeout(timer)
          done()
        })
        server.closeIdleConnections()
      })
  }
}
