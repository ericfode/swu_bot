/**
 * The arena's one record: a SQLite file (node:sqlite, WAL), with replays as gzipped files in a folder beside it
 * (Replays.ts). Column names are snake_case in SQL and camelCase in TypeScript, so a row decodes straight into the
 * schemas in Domain.ts. Migrations run once each, in order, at startup.
 */
import { mkdirSync } from "node:fs"
import path from "node:path"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { Config, Effect, Layer, Option, String as Str } from "effect"
import { SqlClient } from "effect/sql"

/** Today's rules of the open arena (the newest rounds' ladder config), until the Arena rules stage replaces them. */
export const OPEN_RULES = { gamesPerPair: 6, capMs: 45000, hangMs: 120000, maxSteps: 6000 }

const migrations = SqliteMigrator.fromRecord({
  "0001_record": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    // people who can sign in; GitHub ids are filled in when they next sign in
    yield* sql`
      CREATE TABLE people (
        login TEXT PRIMARY KEY,
        github_id INTEGER UNIQUE,
        role TEXT NOT NULL CHECK (role IN ('admin', 'friend')),
        invited_by TEXT REFERENCES people (login),
        created_at TEXT NOT NULL
      )`
    // a builder's entry, or one of the arena's own (house) bots
    yield* sql`
      CREATE TABLE competitors (
        name TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        owner TEXT REFERENCES people (login),
        house INTEGER NOT NULL CHECK (house IN (0, 1)),
        about TEXT,
        registered_at TEXT NOT NULL,
        benched_at TEXT,
        CHECK (house = 1 OR owner IS NOT NULL)
      )`
    // what people (and the house) sent in, with the intake's verdict
    yield* sql`
      CREATE TABLE submissions (
        id TEXT PRIMARY KEY,
        competitor TEXT NOT NULL REFERENCES competitors (name),
        by TEXT REFERENCES people (login),
        kind TEXT NOT NULL,
        note TEXT,
        files TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'checking', 'accepted', 'rejected')),
        error TEXT,
        version TEXT,
        submitted_at TEXT NOT NULL,
        checked_at TEXT
      )`
    yield* sql`
      CREATE TABLE versions (
        id TEXT PRIMARY KEY,
        competitor TEXT NOT NULL REFERENCES competitors (name),
        number INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('bot', 'evaluator')),
        format TEXT NOT NULL CHECK (format IN ('wasm', 'js', 'builtin')),
        sha256 TEXT,
        note TEXT,
        files TEXT NOT NULL,
        submission TEXT REFERENCES submissions (id),
        submitted_at TEXT,
        withdrawn INTEGER NOT NULL DEFAULT 0 CHECK (withdrawn IN (0, 1)),
        UNIQUE (competitor, number)
      )`
    yield* sql`
      CREATE TABLE arenas (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        season INTEGER NOT NULL,
        rules TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`
    yield* sql`
      CREATE TABLE seasons (
        arena TEXT NOT NULL REFERENCES arenas (id),
        number INTEGER NOT NULL,
        rules TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        note TEXT,
        PRIMARY KEY (arena, number)
      )`
    yield* sql`
      CREATE TABLE rounds (
        id TEXT PRIMARY KEY,
        arena TEXT NOT NULL,
        season INTEGER NOT NULL,
        number INTEGER NOT NULL,
        lineup TEXT NOT NULL,
        first_seed INTEGER NOT NULL,
        games_per_pair INTEGER NOT NULL,
        cap_ms INTEGER NOT NULL,
        key_id TEXT,
        run_key TEXT,
        state TEXT NOT NULL CHECK (state IN ('running', 'done', 'failed')),
        games_planned INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        error TEXT,
        execution_id TEXT,
        UNIQUE (arena, season, number),
        FOREIGN KEY (arena, season) REFERENCES seasons (arena, number)
      )`
    // seq is the order the record took games in: the export API pages and resumes on it
    yield* sql`
      CREATE TABLE games (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        arena TEXT NOT NULL,
        season INTEGER NOT NULL,
        round TEXT NOT NULL REFERENCES rounds (id),
        seed INTEGER NOT NULL,
        deal_key TEXT,
        p1 TEXT NOT NULL REFERENCES versions (id),
        p2 TEXT NOT NULL REFERENCES versions (id),
        outcome TEXT NOT NULL CHECK (outcome IN ('won', 'draw', 'forfeit', 'error', 'step_cap', 'stuck', 'abandoned')),
        winner TEXT REFERENCES versions (id),
        winner_seat TEXT CHECK (winner_seat IN ('p1', 'p2')),
        score REAL CHECK (score IN (0, 0.5, 1)),
        fault_seat TEXT CHECK (fault_seat IN ('p1', 'p2')),
        fault_kind TEXT,
        error TEXT,
        game_rounds INTEGER NOT NULL,
        steps INTEGER NOT NULL,
        ms INTEGER NOT NULL,
        p1_think_ms REAL,
        p2_think_ms REAL,
        p1_decisions INTEGER,
        p2_decisions INTEGER,
        p1_decide_ms REAL,
        p2_decide_ms REAL,
        p1_p95_ms REAL,
        p2_p95_ms REAL,
        p1_max_ms REAL,
        p2_max_ms REAL,
        host TEXT,
        replay TEXT,
        replay_bytes INTEGER,
        replay_sha256 TEXT,
        recorded_at TEXT NOT NULL
      )`
    yield* sql`CREATE INDEX games_round ON games (round)`
    yield* sql`CREATE INDEX games_season ON games (arena, season, seq)`
    yield* sql`CREATE INDEX games_p1 ON games (p1, seq)`
    yield* sql`CREATE INDEX games_p2 ON games (p2, seq)`
    yield* sql`CREATE INDEX games_recorded ON games (recorded_at)`
    // a version's rating after a round: on that round's games alone (scope round) or on the season so far (scope season)
    yield* sql`
      CREATE TABLE ratings (
        round TEXT NOT NULL REFERENCES rounds (id),
        scope TEXT NOT NULL CHECK (scope IN ('round', 'season')),
        version TEXT NOT NULL REFERENCES versions (id),
        rating REAL NOT NULL,
        se REAL NOT NULL,
        anchor INTEGER NOT NULL CHECK (anchor IN (0, 1)),
        games INTEGER NOT NULL,
        wins INTEGER NOT NULL,
        losses INTEGER NOT NULL,
        draws INTEGER NOT NULL,
        unrated INTEGER NOT NULL,
        forfeits INTEGER NOT NULL,
        PRIMARY KEY (round, scope, version)
      )`
    // a version's edge in one of the Atlas's game situations
    yield* sql`
      CREATE TABLE spots (
        arena TEXT NOT NULL,
        season INTEGER NOT NULL,
        version TEXT NOT NULL REFERENCES versions (id),
        spot TEXT NOT NULL,
        edge REAL NOT NULL,
        n INTEGER NOT NULL,
        se REAL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (arena, season, version, spot)
      )`
    // machine settings, a row per setting ever set; value NULL = back to the games machine's default
    yield* sql`
      CREATE TABLE settings (
        name TEXT PRIMARY KEY,
        value INTEGER,
        updated_at TEXT NOT NULL,
        by TEXT NOT NULL
      )`
    // the one arena today, in its first season; the import fills in when that season started
    const now = new Date().toISOString()
    const rules = JSON.stringify(OPEN_RULES)
    yield* sql`INSERT INTO arenas ${sql.insert({ id: "open", title: "Open", season: 1, rules, createdAt: now })}`
    yield* sql`INSERT INTO seasons ${sql.insert({ arena: "open", number: 1, rules, startedAt: now, endedAt: null, note: null })}`
  })
})

/** The SQL client on `filename`, migrated, with foreign keys enforced. */
export const layerFile = (filename: string) =>
  SqliteMigrator.layer({ loader: migrations }).pipe(
    Layer.provideMerge(Layer.effectDiscard(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`PRAGMA foreign_keys = ON`
    }))),
    Layer.provideMerge(SqliteClient.layer({
      filename,
      transformQueryNames: Str.camelToSnake,
      transformResultNames: Str.snakeToCamel
    }))
  )

/** Where the record lives: ARENA_DATA (default ./data) holds arena.db (or ARENA_DB) and the replays folder. */
export const dataDir = Config.String("ARENA_DATA").pipe(Config.withDefault("data"))

export const layer = Layer.unwrap(Effect.gen(function*() {
  const dir = yield* dataDir
  mkdirSync(dir, { recursive: true })
  const file = yield* Config.String("ARENA_DB").pipe(Config.option)
  return layerFile(Option.getOrElse(file, () => path.join(dir, "arena.db")))
}))
