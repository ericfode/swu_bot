/**
 * The one-time import: today's arena, read from the window's documents and replays, into the record. It reads the
 * rounds arena-r<K> (runs/ and ladders/), the roster, every competitor's versions, the submissions and each game's
 * replay, and nothing else: research runs, the Karabast feed, people's names and the admin documents stay behind.
 *
 * Today's rounds become the open arena's season 1. The bots built into the games image that rounds 0 to 14 played
 * (c-clock-wasm, heuristic, ...) become version 0 of the resident each one turned into (c_clock, heuristic, ...), under
 * their old names, so every game names a version and the ratings keep their anchors.
 *
 * Everything is written in one transaction, and the import then rates every round and compares the result with the
 * window's own standings (each round's ratings and records, and the all-round ratings). Any difference undoes the
 * whole import. Running it again changes nothing that is already there.
 */
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { gunzipSync } from "node:zlib"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { ArenaRules } from "./Domain.ts"
import { Games, newGame, RawGame } from "./Games.ts"
import type { NewGame } from "./Games.ts"
import { Ratings } from "./Ratings.ts"
import { Replays } from "./Replays.ts"
import type { Stored } from "./Replays.ts"

export class ImportFailed extends Schema.TaggedError<ImportFailed>()("ImportFailed", {
  message: Schema.String
}) {}

/** Where the import reads from: the live window over HTTP, or a copy of its volume (WINDOW_HOME). */
export interface Source {
  readonly name: string
  /** A document, or null when there is none. */
  readonly doc: (ns: string, id: string) => Effect.Effect<unknown, ImportFailed>
  readonly list: (ns: string) => Effect.Effect<ReadonlyArray<string>, ImportFailed>
  /** A replay's text, or null when there is none. */
  readonly replay: (run: string, game: string) => Effect.Effect<Uint8Array | null, ImportFailed>
}

/** The window's API with a project token (GET only): /api/docs/<ns>[/<id>] and /api/replays/<run>/<game>. */
export const windowSource = (base: string, token: string): Source => {
  const get = (p: string) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(new URL(p, base), { headers: { authorization: `Bearer ${token}` } })
        if (response.status === 404) return null
        if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`)
        return new Uint8Array(await response.arrayBuffer())
      },
      catch: (e) => new ImportFailed({ message: `GET ${p}: ${e instanceof Error ? e.message : String(e)}` })
    })
  const json = (p: string) =>
    Effect.map(get(p), (bytes) => bytes === null ? null : (JSON.parse(new TextDecoder().decode(bytes)) as { result: unknown }).result)
  return {
    name: base,
    doc: (ns, id) => json(`/api/docs/${ns}/${encodeURIComponent(id)}`),
    list: (ns) =>
      Effect.map(json(`/api/docs/${ns}`), (r) => (Array.isArray(r) ? r.map((d: { id: string }) => d.id) : [])),
    replay: (run, game) => get(`/api/replays/${encodeURIComponent(run)}/${encodeURIComponent(game)}`)
  }
}

/** A copy of the window's volume: docs/<ns>/<id>.json and replays/<run>/<game>.jsonl.gz. */
export const folderSource = (home: string): Source => {
  const read = (file: string) =>
    Effect.try({
      try: () => {
        try {
          return readFileSync(file)
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
          throw e
        }
      },
      catch: (e) => new ImportFailed({ message: `${file}: ${String(e)}` })
    })
  return {
    name: home,
    doc: (ns, id) =>
      Effect.flatMap(read(path.join(home, "docs", ns, `${id}.json`)), (buf) =>
        Effect.try({
          try: () => (buf === null ? null : JSON.parse(buf.toString("utf8"))),
          catch: (e) => new ImportFailed({ message: `docs/${ns}/${id}.json: ${String(e)}` })
        })),
    list: (ns) =>
      Effect.try({
        try: () => {
          try {
            return readdirSync(path.join(home, "docs", ns)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort()
          } catch {
            return []
          }
        },
        catch: (e) => new ImportFailed({ message: String(e) })
      }),
    replay: (run, game) =>
      Effect.map(read(path.join(home, "replays", run, `${game}.jsonl.gz`)), (gz) =>
        gz === null ? null : new Uint8Array(gunzipSync(gz)))
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The window's documents, as far as the import reads them
// ---------------------------------------------------------------------------------------------------------------------

const NullStr = Schema.NullOr(Schema.String)
const optional = Schema.optional

const WStandings = Schema.Struct({
  startedAt: Schema.String,
  global: Schema.Record(Schema.String, Schema.Number),
  rounds: Schema.Array(Schema.Struct({
    round: Schema.Int,
    ladderId: Schema.String,
    status: Schema.String,
    bots: Schema.Array(Schema.Struct({
      name: Schema.String,
      btElo: Schema.NullOr(Schema.Number),
      wins: Schema.Int,
      losses: Schema.Int,
      draws: Schema.Int,
      unfinished: Schema.Int,
      forfeits: Schema.Int
    }))
  }))
})

const WAgent = Schema.Struct({
  name: Schema.String,
  title: optional(NullStr),
  philosophy: optional(NullStr),
  owner: Schema.String,
  resident: optional(Schema.Boolean),
  registeredAt: Schema.String,
  withdrawn: optional(Schema.Array(Schema.Int)),
  benchedAt: optional(Schema.String)
})
type WAgent = typeof WAgent.Type
const WRoster = Schema.Struct({
  agents: Schema.Array(WAgent),
  bench: optional(Schema.NullOr(Schema.Array(WAgent)))
})

const WVersions = Schema.Array(Schema.Struct({
  v: optional(Schema.Int),
  version: optional(Schema.Int),
  name: Schema.String,
  note: optional(NullStr),
  bot: Schema.Struct({ kind: Schema.String }),
  files: optional(Schema.Array(Schema.String)),
  ref: optional(NullStr),
  submittedAt: optional(NullStr)
}))

const WSubmission = Schema.Struct({
  id: Schema.String,
  owner: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  note: optional(NullStr),
  state: Schema.Literals(["pending", "checking", "accepted", "rejected"]),
  submittedAt: Schema.String,
  fileNames: optional(Schema.Array(Schema.String)),
  version: optional(NullStr),
  error: optional(NullStr),
  checkedAt: optional(NullStr)
})

const WRun = Schema.Struct({
  id: Schema.String,
  games: Schema.Array(Schema.Struct({
    ...RawGame.fields,
    id: Schema.String,
    seed: Schema.Int,
    p1: Schema.String,
    p2: Schema.String
  }))
})

const WLadder = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  config: Schema.Struct({
    bots: Schema.Array(Schema.String),
    gamesPerPair: Schema.Int,
    firstSeed: Schema.Int,
    maxSteps: Schema.Int,
    capMs: Schema.Int,
    hangMs: Schema.Int,
    keyId: optional(NullStr),
    key: optional(NullStr)
  }),
  progress: Schema.Struct({ scheduled: Schema.Int }),
  games: Schema.Array(Schema.Struct({ id: Schema.String, think: optional(RawGame.fields.think) }))
})

// ---------------------------------------------------------------------------------------------------------------------
// The import
// ---------------------------------------------------------------------------------------------------------------------

export interface ImportOptions {
  /** Fetch and store every game's replay (default true). */
  readonly replays?: boolean
  /** Logins that are admins; everyone else who owns a competitor or sent a submission is a friend. */
  readonly admins?: ReadonlyArray<string>
  /** Replays fetched at once. */
  readonly concurrency?: number
}

export interface ImportReport {
  readonly source: string
  readonly rounds: number
  readonly games: number
  readonly rated: number
  readonly replays: { readonly stored: number; readonly kept: number; readonly missing: number }
  readonly people: number
  readonly competitors: number
  readonly versions: number
  readonly builtins: ReadonlyArray<string>
  readonly submissions: number
  readonly notes: ReadonlyArray<string>
  readonly check: { readonly compared: number; readonly mismatches: ReadonlyArray<string> }
}

const ARENA = "open"
const SEASON = 1
const ROUND_ID = /^arena-r(\d+)$/

/** The resident a bot built into the games image became (bot/arena/home.js residentName). */
const residentOf = (bot: string) => bot.replace(/-wasm$/, "").replace(/-/g, "_")

const loginOf = (owner: string): string | null => {
  if (owner === "arena" || owner === "@arena") return null
  const m = /^(?:github:)?([A-Za-z0-9][A-Za-z0-9-]{0,38})$/.exec(owner)
  if (!m) throw new Error(`unknown owner ${JSON.stringify(owner)}`)
  return m[1].toLowerCase()
}

const rulesText = (r: ArenaRules) =>
  `${r.gamesPerPair} games per pair, ${r.capMs / 1000} s to think per game, ${r.hangMs / 1000} s per decision, ${r.maxSteps} decisions`

export const importWindow = Effect.fn("importWindow")(function*(source: Source, options: ImportOptions = {}) {
  const sql = yield* SqlClient.SqlClient
  const games = yield* Games
  const ratings = yield* Ratings
  const replays = yield* Replays
  const notes: Array<string> = []
  const fail = (message: string) => Effect.fail(new ImportFailed({ message }))
  const decode = <S extends Schema.Top>(schema: S, what: string) => (value: unknown) =>
    value === null
      ? fail(`${what} is missing`)
      : Schema.decodeUnknownEffect(schema)(value).pipe(
        Effect.mapError((e) => new ImportFailed({ message: `${what}: ${e.message}` }))
      ) as Effect.Effect<S["Type"], ImportFailed>
  const attempt = <A>(f: () => A) =>
    Effect.try({ try: f, catch: (e) => new ImportFailed({ message: e instanceof Error ? e.message : String(e) }) })

  // ---- read
  const standings = yield* Effect.flatMap(source.doc("arena", "standings"), decode(WStandings, "arena/standings"))
  const roster = yield* Effect.flatMap(source.doc("arena", "roster"), decode(WRoster, "arena/roster"))

  const rounds: Array<{ number: number; ladder: typeof WLadder.Type; run: typeof WRun.Type }> = []
  for (const sr of [...standings.rounds].sort((a, b) => a.round - b.round)) {
    const m = ROUND_ID.exec(sr.ladderId)
    if (!m || Number(m[1]) !== sr.round) {
      notes.push(`left out ${sr.ladderId}: not a round of today's arena`)
      continue
    }
    const ladder = yield* Effect.flatMap(source.doc("ladders", sr.ladderId), decode(WLadder, `ladders/${sr.ladderId}`))
    const run = yield* Effect.flatMap(source.doc("runs", sr.ladderId), decode(WRun, `runs/${sr.ladderId}`))
    if (ladder.status !== "done" || sr.status !== "done" || run.games.some((g) => g.outcome === "running")) {
      notes.push(`left out ${sr.ladderId}: still playing`)
      continue
    }
    rounds.push({ number: sr.round, ladder, run })
  }
  if (rounds.length === 0) return yield* fail("the window has no finished arena round")

  // competitors: the roster's builders and residents (the bench too)
  const agents: Array<WAgent> = [...roster.agents, ...(roster.bench ?? [])]
  const competitors = yield* attempt(() =>
    agents.map((a) => ({
      name: a.name,
      title: a.title ?? a.name,
      owner: loginOf(a.owner),
      house: a.resident === true || loginOf(a.owner) === null ? 1 : 0,
      about: a.philosophy ?? null,
      registeredAt: a.registeredAt,
      benchedAt: a.benchedAt ?? null
    }))
  )
  const competitorNames = new Set(competitors.map((c) => c.name))
  for (const id of yield* source.list("arena")) {
    const m = /^versions-(.+)$/.exec(id)
    if (m && !competitorNames.has(m[1])) notes.push(`left out arena/${id}: ${m[1]} is not in the roster`)
  }

  // submissions of roster competitors
  const submissions: Array<{ id: string; competitor: string; by: string | null; submittedAt: string; [k: string]: unknown }> = []
  for (const id of yield* source.list("submissions")) {
    const s = yield* Effect.flatMap(source.doc("submissions", id), decode(WSubmission, `submissions/${id}`))
    if (!competitorNames.has(s.name)) {
      notes.push(`left out submissions/${id}: ${s.name} is not in the roster`)
      continue
    }
    submissions.push({
      id: s.id,
      competitor: s.name,
      by: yield* attempt(() => loginOf(s.owner)),
      kind: s.kind,
      note: s.note ?? null,
      files: JSON.stringify(s.fileNames ?? []),
      state: s.state,
      error: s.error ?? null,
      version: s.version ?? null,
      submittedAt: s.submittedAt,
      checkedAt: s.checkedAt ?? null
    })
  }
  const submissionIds = new Set(submissions.map((s) => s.id))

  // versions: each competitor's list, then the built-in bots the old rounds played
  const versions: Array<{
    id: string
    competitor: string
    number: number
    kind: "bot"
    format: "wasm" | "js" | "builtin"
    sha256: null
    note: string | null
    files: string
    submission: string | null
    submittedAt: string | null
    withdrawn: 0 | 1
  }> = []
  for (const a of agents) {
    const list = yield* Effect.flatMap(source.doc("arena", `versions-${a.name}`), (doc) =>
      doc === null ? Effect.succeed([]) : decode(WVersions, `arena/versions-${a.name}`)(doc))
    for (const [i, v] of list.entries()) {
      const number = v.v ?? v.version ?? i
      if (v.name !== `${a.name}-v${number}`) return yield* fail(`arena/versions-${a.name}: ${v.name} is not version ${number}`)
      if (v.bot.kind !== "wasm" && v.bot.kind !== "js") return yield* fail(`${v.name}: unknown kind ${v.bot.kind}`)
      const ref = /^window:(.+)$/.exec(v.ref ?? "")?.[1] ?? null
      if (ref !== null && !submissionIds.has(ref)) notes.push(`${v.name}: its submission ${ref} is not on the window`)
      versions.push({
        id: v.name,
        competitor: a.name,
        number,
        kind: "bot",
        format: v.bot.kind,
        sha256: null,
        note: v.note ?? null,
        files: JSON.stringify(v.files ?? []),
        submission: ref !== null && submissionIds.has(ref) ? ref : null,
        submittedAt: v.submittedAt ?? null,
        withdrawn: (a.withdrawn ?? []).includes(number) ? 1 : 0
      })
    }
  }
  const versionIds = new Set(versions.map((v) => v.id))
  const builtins: Array<string> = []
  for (const r of rounds) {
    for (const bot of [...r.ladder.config.bots, ...r.run.games.flatMap((g) => [g.p1, g.p2])]) {
      if (versionIds.has(bot)) continue
      const resident = competitors.find((c) => c.name === residentOf(bot) && c.house === 1)
      if (!resident) return yield* fail(`${r.ladder.id} plays ${bot}, which is neither a version nor a built-in bot of a resident`)
      if (versions.some((v) => v.competitor === resident.name && v.number === 0)) {
        return yield* fail(`${bot} would be ${resident.name}'s version 0, which exists`)
      }
      const played = rounds.filter((x) => x.ladder.config.bots.includes(bot)).map((x) => x.number)
      versions.push({
        id: bot,
        competitor: resident.name,
        number: 0,
        kind: "bot",
        format: "builtin",
        sha256: null,
        note: `Built into the games image; played rounds ${played[0]} to ${played[played.length - 1]} before ${resident.name} became a submitted entry`,
        files: "[]",
        submission: null,
        submittedAt: null,
        withdrawn: 0
      })
      versionIds.add(bot)
      builtins.push(bot)
    }
  }

  // people: everyone who owns a competitor or sent a submission, and the admins
  const admins = new Set((options.admins ?? ["ericfode"]).map((l) => l.toLowerCase()))
  const seen = new Map<string, string>()
  const saw = (login: string | null, at: string) => {
    if (login !== null && (!seen.has(login) || at < seen.get(login)!)) seen.set(login, at)
  }
  competitors.forEach((c) => saw(c.owner, c.registeredAt))
  submissions.forEach((s) => saw(s.by, s.submittedAt))
  admins.forEach((l) => saw(l, standings.startedAt))
  const people = [...seen].map(([login, at]) => ({
    login,
    githubId: null,
    role: admins.has(login) ? "admin" : "friend",
    invitedBy: null,
    createdAt: at
  }))

  // the season: today's rules are the newest round's; the note says how earlier rounds differed
  const rulesOf = (r: (typeof rounds)[number]): ArenaRules => ({
    gamesPerPair: r.ladder.config.gamesPerPair,
    capMs: r.ladder.config.capMs,
    hangMs: r.ladder.config.hangMs,
    maxSteps: r.ladder.config.maxSteps
  })
  const rules = rulesOf(rounds[rounds.length - 1])
  const spans: Array<{ from: number; to: number; text: string }> = []
  for (const r of rounds) {
    const text = rulesText(rulesOf(r))
    const last = spans[spans.length - 1]
    if (last && last.text === text) last.to = r.number
    else spans.push({ from: r.number, to: r.number, text })
  }
  const seasonNote = `Imported from the arena window: rounds ${rounds[0].number} to ${rounds[rounds.length - 1].number}` +
    (spans.length > 1 ? `, played under changing rules: ${spans.map((s) => `rounds ${s.from}-${s.to}: ${s.text}`).join("; ")}` : "")

  // games, and their replays (fetched before the transaction; each file is written whole)
  const wanted = rounds.flatMap((r) => r.run.games.map((g) => ({ r, g })))
  const stats = { stored: 0, kept: 0, missing: 0 }
  const storedOf = new Map<string, Stored | null>()
  if (options.replays ?? true) {
    yield* Effect.forEach(wanted, ({ r, g }) =>
      Effect.gen(function*() {
        const rel = `${r.ladder.id}/${g.id}.jsonl.gz`
        const kept = yield* replays.get(rel)
        if (kept !== null) {
          const text = gunzipSync(kept)
          storedOf.set(g.id, { path: rel, bytes: text.length, sha256: createHash("sha256").update(text).digest("hex") })
          stats.kept++
          return
        }
        const text = yield* source.replay(r.ladder.id, g.id)
        if (text === null) {
          stats.missing++
          storedOf.set(g.id, null)
          return
        }
        storedOf.set(g.id, yield* replays.put(r.ladder.id, g.id, text))
        stats.stored++
      }), { concurrency: options.concurrency ?? 6, discard: true })
  }
  const rows: Array<NewGame> = []
  for (const { r, g } of wanted) {
    const think = r.ladder.games.find((x) => x.id === g.id)?.think ?? null
    const at = { arena: ARENA, season: SEASON, round: r.ladder.id, recordedAt: r.ladder.updatedAt }
    rows.push(yield* attempt(() => newGame(at, g, { ...g, think }, storedOf.get(g.id) ?? null)))
  }

  // ---- write, rate and check, all or nothing
  const upsert = (table: string, key: string, list: ReadonlyArray<object>, update: ReadonlyArray<string>) =>
    Effect.forEach(chunks(list, 100), (part) =>
      sql`INSERT INTO ${sql(table)} ${sql.insert(part as Array<Record<string, unknown>>)}
          ON CONFLICT (${sql.literal(key)}) ${
        sql.literal(update.length ? `DO UPDATE SET ${update.map((c) => `${c} = excluded.${c}`).join(", ")}` : "DO NOTHING")
      }`, { discard: true })

  const check = yield* sql.withTransaction(Effect.gen(function*() {
    yield* upsert("people", "login", people, [])
    yield* upsert("competitors", "name", competitors, ["title", "about", "benched_at"])
    yield* upsert("submissions", "id", submissions, ["state", "error", "version", "checked_at"])
    yield* upsert("versions", "id", versions, ["note", "files", "submission", "submitted_at", "withdrawn"])
    yield* sql`UPDATE arenas SET rules = ${JSON.stringify(rules)}, season = max(season, ${SEASON}) WHERE id = ${ARENA}`
    yield* upsert("seasons", "arena, number", [{
      arena: ARENA,
      number: SEASON,
      rules: JSON.stringify(rules),
      startedAt: standings.startedAt,
      endedAt: null,
      note: seasonNote
    }], ["rules", "started_at", "note"])
    yield* upsert("rounds", "id", rounds.map((r) => ({
      id: r.ladder.id,
      arena: ARENA,
      season: SEASON,
      number: r.number,
      lineup: JSON.stringify(r.ladder.config.bots),
      firstSeed: r.ladder.config.firstSeed,
      gamesPerPair: r.ladder.config.gamesPerPair,
      capMs: r.ladder.config.capMs,
      keyId: r.ladder.config.keyId ?? null,
      runKey: r.ladder.config.key ?? null,
      state: "done",
      gamesPlanned: r.ladder.progress.scheduled,
      startedAt: r.ladder.createdAt,
      endedAt: r.ladder.updatedAt,
      error: null,
      executionId: null
    })), ["lineup", "first_seed", "games_per_pair", "cap_ms", "key_id", "run_key", "state", "games_planned", "started_at", "ended_at"])
    yield* games.record(rows)
    for (const r of rounds) yield* ratings.rate(r.ladder.id)
    return yield* compare(standings, rounds.map((r) => r.ladder.id), notes.some((n) => n.endsWith("still playing")))
  }).pipe(Effect.mapError((e) => e._tag === "ImportFailed" ? e : new ImportFailed({ message: String(e) }))))

  const report: ImportReport = {
    source: source.name,
    rounds: rounds.length,
    games: rows.length,
    rated: rows.filter((g) => g.end.score !== null).length,
    replays: stats,
    people: people.length,
    competitors: competitors.length,
    versions: versions.length,
    builtins,
    submissions: submissions.length,
    notes,
    check
  }
  return report
})

const chunks = <A>(list: ReadonlyArray<A>, size: number) => {
  const out: Array<ReadonlyArray<A>> = []
  for (let at = 0; at < list.length; at += size) out.push(list.slice(at, at + size))
  return out
}

const StoredRating = Schema.Struct({
  round: Schema.String,
  scope: Schema.String,
  version: Schema.String,
  rating: Schema.Number,
  wins: Schema.Int,
  losses: Schema.Int,
  draws: Schema.Int,
  unrated: Schema.Int,
  forfeits: Schema.Int
})

/**
 * Compares the ratings the record computed with the window's standings: every round's rating and record of every
 * version, and the all-round rating after the last round. Fails (undoing the import) on any difference.
 */
const compare = Effect.fn("compare")(function*(
  standings: typeof WStandings.Type,
  imported: ReadonlyArray<string>,
  partial: boolean
) {
  const sql = yield* SqlClient.SqlClient
  const stored = yield* Effect.flatMap(
    sql`SELECT round, scope, version, rating, wins, losses, draws, unrated, forfeits FROM ratings
        WHERE ${sql.in("round", imported)}`,
    Schema.decodeUnknownEffect(Schema.Array(StoredRating))
  ).pipe(Effect.orDie)
  const mine = new Map(stored.map((r) => [`${r.round}|${r.scope}|${r.version}`, r]))
  const mismatches: Array<string> = []
  let compared = 0
  for (const sr of standings.rounds.filter((x) => imported.includes(x.ladderId))) {
    for (const b of sr.bots) {
      const r = mine.get(`${sr.ladderId}|round|${b.name}`)
      const theirs = [b.btElo, b.wins, b.losses, b.draws, b.unfinished, b.forfeits]
      const ours = r ? [Math.round(r.rating), r.wins, r.losses, r.draws, r.unrated, r.forfeits] : null
      compared++
      if (b.btElo === null && r === undefined) continue
      if (ours === null || ours.some((x, i) => x !== theirs[i])) {
        mismatches.push(`${sr.ladderId} ${b.name}: window ${theirs.join("/")}, record ${ours?.join("/") ?? "none"}`)
      }
    }
  }
  if (!partial) {
    const last = imported[imported.length - 1]
    const season = stored.filter((r) => r.round === last && r.scope === "season")
    for (const [name, elo] of Object.entries(standings.global)) {
      const r = season.find((x) => x.version === name)
      compared++
      if (!r || Math.round(r.rating) !== elo) mismatches.push(`all rounds ${name}: window ${elo}, record ${r ? Math.round(r.rating) : "none"}`)
    }
    for (const r of season) {
      if (!(r.version in standings.global)) mismatches.push(`all rounds ${r.version}: not rated on the window`)
    }
  }
  if (mismatches.length) {
    return yield* new ImportFailed({
      message: `the record's ratings differ from the window's standings in ${mismatches.length} places: ${mismatches.slice(0, 20).join("; ")}`
    })
  }
  return { compared, mismatches }
})
