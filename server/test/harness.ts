/**
 * Runs the whole arena (SQLite, workflows, routes) on a real HTTP server on a free port, with a game player the test
 * supplies, and gives typed clients for the admin and reader tokens.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer, ManagedRuntime } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http"
import { HttpApiClient, HttpApiMiddleware } from "effect/http-api"
import { ArenaApi, Authorization } from "../src/Api.ts"
import * as Db from "../src/Db.ts"
import { SqlClient } from "effect/sql"
import { GamePlayer } from "../src/Player.ts"
import type { Job } from "../src/Player.ts"
import { Replays } from "../src/Replays.ts"
import { makeApp, makeRecord } from "../src/Server.ts"
import { TraceChecker } from "../src/Traces.ts"
import type { TraceLine } from "../src/Traces.ts"

export const ADMIN = "test-admin-token"
export const READER = "test-read-token"
process.env.ARENA_ADMIN_TOKEN = ADMIN
process.env.ARENA_READ_TOKEN = READER

/** A fresh data folder: arena.db and replays/. */
export const tempData = () => mkdtempSync(path.join(tmpdir(), "arena-test-"))

/** The record's services on a data folder, without the HTTP server (what the import runs on). */
export const recordAt = (dir: string) =>
  ManagedRuntime.make(makeRecord(Db.layerFile(path.join(dir, "arena.db")), Replays.layerAt(path.join(dir, "replays"))))

/** A player that never runs the engine: p1 wins every game. `hold` can stop a job forever (a crash stand-in). */
export const fakePlayer = (log: Array<string>, hold: (job: Job) => boolean = () => false) =>
  Layer.succeed(GamePlayer, GamePlayer.of({
    play: (job) =>
      Effect.suspend(() => {
        log.push(job.games.map((g) => g.id).join(","))
        if (hold(job)) return Effect.never
        return Effect.succeed(job.games.map((g) => ({
          ...g,
          result: {
            outcome: "won",
            winner: g.p1,
            winnerSeat: "p1",
            round: 5,
            steps: 100,
            ms: 10,
            timing: { p1: { n: 50, ms: 120, p95: 4, max: 9 }, p2: { n: 50, ms: 80, p95: 3, max: 5 } },
            think: { p1: 130, p2: 90 }
          },
          replay: new TextEncoder().encode(`{"t":"header","game":"${g.id}"}\n`)
        })))
      })
  }))

/** A trace checker that never runs the engine: `verdict` says how each replay file comes out (default: the same). */
export const fakeChecker = (
  log: Array<ReadonlyArray<string>> = [],
  verdict: (file: string) => Partial<TraceLine> = () => ({})
) =>
  Layer.succeed(TraceChecker, TraceChecker.of({
    build: "test-build",
    check: (files) =>
      Effect.sync(() => {
        log.push(files)
        return files.map((file) => ({ file, ok: true, steps: 100, ms: 5, ...verdict(file) }))
      })
  }))

export const startArena = (dir: string, player: Layer.Layer<GamePlayer>, checker: Layer.Layer<TraceChecker> = fakeChecker()) =>
  ManagedRuntime.make(
    HttpRouter.serve(
      makeApp(Db.layerFile(path.join(dir, "arena.db")), Replays.layerAt(path.join(dir, "replays")), player, checker),
      { disableLogger: true, disableListenLog: true }
    ).pipe(Layer.provideMerge(NodeHttpServer.layerTest))
  )

/** Adds competitors with one version each (named <competitor>-v1), so a round can field them. */
export const addVersions = (names: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    for (const name of names) {
      yield* sql`INSERT INTO competitors ${sql.insert({ name, title: name, owner: null, house: 1, about: null, registeredAt: "2026-10-14T00:00:00Z", benchedAt: null })}`
      yield* sql`INSERT INTO versions ${sql.insert({ id: `${name}-v1`, competitor: name, number: 1, kind: "bot", format: "wasm", sha256: null, note: null, files: "[]", submission: null, submittedAt: null, withdrawn: 0 })}`
    }
  }).pipe(Effect.orDie)

const bearer = (token: string) =>
  HttpApiMiddleware.layerClient(Authorization, ({ next, request }) => next(HttpClientRequest.bearerToken(request, token)))

/** The generated client, as the holder of `token`. */
export const client = (token: string) => HttpApiClient.make(ArenaApi).pipe(Effect.provide(bearer(token)))

/** One JSON-RPC call to /mcp (initialize first: the server keeps a session). */
export const mcpSession = (token: string) =>
  Effect.gen(function*() {
    const http = yield* HttpClient.HttpClient
    let session = ""
    let id = 0
    const call = (method: string, params?: unknown) =>
      Effect.gen(function*() {
        const request = HttpClientRequest.post("/mcp").pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
          HttpClientRequest.setHeader("mcp-protocol-version", "2025-06-18"),
          session ? HttpClientRequest.setHeader("mcp-session-id", session) : (r) => r,
          HttpClientRequest.bodyJsonUnsafe(params === undefined && method.startsWith("notifications/")
            ? { jsonrpc: "2.0", method }
            : { jsonrpc: "2.0", id: ++id, method, params })
        )
        const response = yield* http.execute(request)
        session = response.headers["mcp-session-id"] ?? session
        const text = yield* response.text
        const json = (() => {
          try {
            return JSON.parse(text)
          } catch {
            return null
          }
        })()
        return { status: response.status, body: json, text }
      })
    const init = yield* call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "arena-test", version: "1" }
    })
    if (init.status !== 200) return { init, call }
    yield* call("notifications/initialized")
    return { init, call }
  })

/** Polls a round until it leaves "running" (or fails the test after `seconds`). */
export const waitForRound = (id: string, seconds = 20) =>
  Effect.gen(function*() {
    const api = yield* client(READER)
    for (let i = 0; i < seconds * 10; i++) {
      const status = yield* api.rounds.status({ params: { id } })
      if (status.state !== "running") return status
      yield* Effect.sleep("100 millis")
    }
    return yield* Effect.die(new Error(`round ${id} still running after ${seconds} s`))
  })
