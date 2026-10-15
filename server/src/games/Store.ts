/**
 * The games machine's own SQLite file (`/data/server/games.db`): its rounds and every game of them, the durable state
 * a restart resumes from (what Oban's jobs and ladder.js --resume were), and a few values the scheduler keeps across
 * boots. The round's result files for the window are written from it (Round.ts); stage 6 sends the same rows to the
 * website's record.
 */
import { mkdirSync } from "node:fs"
import path from "node:path"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { Context, Effect, Layer, String as Str } from "effect"
import { SqlClient } from "effect/sql"
import type { GameResult, Host, RoundSpec } from "./Types.ts"

const migrations = SqliteMigrator.fromRecord({
  "0001_games": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    // state: playing (this boot or an earlier one: a restart resumes it), done, held (failed twice or ran past the cap
    // at boot `boot`: it waits for the next boot)
    yield* sql`
      CREATE TABLE rounds (
        k INTEGER PRIMARY KEY,
        arena TEXT NOT NULL,
        spec TEXT NOT NULL,
        first_seed INTEGER NOT NULL,
        key_id TEXT,
        workers INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('playing', 'done', 'held')),
        boot TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        why TEXT,
        created_at TEXT NOT NULL,
        ended_at TEXT
      )`
    // a game is todo until its result is in; ord is its place in the schedule
    yield* sql`
      CREATE TABLE round_games (
        k INTEGER NOT NULL REFERENCES rounds (k),
        id TEXT NOT NULL,
        ord INTEGER NOT NULL,
        seed INTEGER NOT NULL,
        p1 TEXT NOT NULL,
        p2 TEXT NOT NULL,
        decks TEXT,
        state TEXT NOT NULL CHECK (state IN ('todo', 'done')),
        host TEXT,
        result TEXT,
        key TEXT,
        ended_at TEXT,
        PRIMARY KEY (k, id)
      )`
    yield* sql`
      CREATE TABLE kv (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
  })
})

export interface RoundRow {
  readonly k: number
  readonly arena: string
  readonly spec: RoundSpec
  readonly firstSeed: number
  readonly keyId: string | null
  readonly workers: number
  readonly state: "playing" | "done" | "held"
  readonly boot: string
  readonly attempts: number
  readonly why: string | null
  readonly createdAt: string
  readonly endedAt: string | null
}

export interface GameRow {
  readonly id: string
  readonly ord: number
  readonly seed: number
  readonly p1: string
  readonly p2: string
  readonly decks: readonly [number, number] | null
  readonly state: "todo" | "done"
  readonly host: Host
  readonly result: GameResult | null
  readonly key: string | null
  readonly endedAt: string | null
}

const rowOfRound = (r: any): RoundRow => ({ ...r, spec: JSON.parse(r.spec) })
const rowOfGame = (r: any): GameRow => ({
  id: r.id, ord: r.ord, seed: r.seed, p1: r.p1, p2: r.p2,
  decks: r.decks === null ? null : JSON.parse(r.decks),
  state: r.state, host: r.host ?? null,
  result: r.result === null ? null : JSON.parse(r.result),
  key: r.key ?? null, endedAt: r.endedAt ?? null
})

export interface StoreService {
  readonly round: (k: number) => Effect.Effect<RoundRow | null>
  readonly lastRound: Effect.Effect<RoundRow | null>
  /** a new round with its whole schedule, all todo (games already done can be passed done: an import) */
  readonly createRound: (row: RoundRow, games: ReadonlyArray<GameRow>) => Effect.Effect<void>
  readonly updateRound: (k: number, set: Partial<Pick<RoundRow, "state" | "boot" | "attempts" | "why" | "endedAt" | "workers">>) => Effect.Effect<void>
  readonly games: (k: number) => Effect.Effect<ReadonlyArray<GameRow>>
  readonly finishGame: (k: number, id: string, host: Host, result: GameResult, endedAt: string) => Effect.Effect<void>
  readonly setKey: (k: number, ids: ReadonlyArray<string>, key: string) => Effect.Effect<void>
  readonly get: (name: string) => Effect.Effect<string | null>
  readonly set: (name: string, value: string) => Effect.Effect<void>
}

export class Store extends Context.Service<Store, StoreService>()("games/Store") {
  static readonly make = Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const orDie = <A, E>(e: Effect.Effect<A, E>) => Effect.orDie(e)

    const round = (k: number) =>
      orDie(sql`SELECT * FROM rounds WHERE k = ${k}`).pipe(Effect.map((rows) => (rows[0] ? rowOfRound(rows[0]) : null)))

    const lastRound = orDie(sql`SELECT * FROM rounds ORDER BY k DESC LIMIT 1`).pipe(
      Effect.map((rows) => (rows[0] ? rowOfRound(rows[0]) : null))
    )

    const createRound = (row: RoundRow, games: ReadonlyArray<GameRow>) =>
      orDie(sql.withTransaction(Effect.gen(function*() {
        yield* sql`INSERT INTO rounds ${sql.insert({ ...row, spec: JSON.stringify(row.spec) })}`
        for (const g of games) {
          yield* sql`INSERT INTO round_games ${sql.insert({
            k: row.k, id: g.id, ord: g.ord, seed: g.seed, p1: g.p1, p2: g.p2,
            decks: g.decks === null ? null : JSON.stringify(g.decks),
            state: g.state, host: g.host, result: g.result === null ? null : JSON.stringify(g.result),
            key: g.key, endedAt: g.endedAt
          })}`
        }
      })))

    const updateRound = (k: number, set: Partial<Pick<RoundRow, "state" | "boot" | "attempts" | "why" | "endedAt" | "workers">>) =>
      Object.keys(set).length ? orDie(sql`UPDATE rounds SET ${sql.update(set)} WHERE k = ${k}`).pipe(Effect.asVoid) : Effect.void

    const games = (k: number) =>
      orDie(sql`SELECT * FROM round_games WHERE k = ${k} ORDER BY ord`).pipe(Effect.map((rows) => rows.map(rowOfGame)))

    const finishGame = (k: number, id: string, host: Host, result: GameResult, endedAt: string) =>
      orDie(sql`UPDATE round_games SET state = 'done', host = ${host}, result = ${JSON.stringify(result)}, ended_at = ${endedAt}
                WHERE k = ${k} AND id = ${id}`).pipe(Effect.asVoid)

    const setKey = (k: number, ids: ReadonlyArray<string>, key: string) =>
      ids.length ? orDie(sql`UPDATE round_games SET key = ${key} WHERE k = ${k} AND ${sql.in("id", ids)}`).pipe(Effect.asVoid) : Effect.void

    const get = (name: string) =>
      orDie(sql`SELECT value FROM kv WHERE name = ${name}`).pipe(Effect.map((rows) => (rows[0] ? String((rows[0] as any).value) : null)))

    const set = (name: string, value: string) =>
      orDie(sql`INSERT INTO kv (name, value, updated_at) VALUES (${name}, ${value}, ${new Date().toISOString()})
                ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).pipe(Effect.asVoid)

    return Store.of({ round, lastRound, createRound, updateRound, games, finishGame, setKey, get, set })
  })

  /** The store on `filename` (its folder made), migrated. */
  static readonly layerFile = (filename: string) => {
    mkdirSync(path.dirname(filename), { recursive: true })
    return Layer.effect(Store, Store.make).pipe(
      Layer.provide(SqliteMigrator.layer({ loader: migrations })),
      Layer.provide(SqliteClient.layer({
        filename,
        transformQueryNames: Str.camelToSnake,
        transformResultNames: Str.snakeToCamel
      }))
    )
  }
}
