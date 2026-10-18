/**
 * The done-check of stage 5 ("the new games role replays a past round from its seeds and gets the same results"):
 * plays a recorded round again with the games role's own executor and compares every game with what the round
 * recorded.
 *
 *   node src/main-games.ts replay --results <arena-rK folder> --bundles <dir of tars> --names <name->sha256 json>
 *       --out <dir> [--only a,b] [--decks-dir <dir>] [--jobs N]
 *
 * The round is rebuilt from its ladder.json config, which ladder.js and the games role write alike: the lineup in
 * order, games per pair, first seed, step cap, time cap and watchdog, the deck lists (the named file, loaded with
 * decklists.js loadDecks and the engine's check in this process, from bot/decks or --decks-dir, refused when its
 * sha256 is not the round's) and the run key. The key is in the config only once a round is done; a round without it
 * cannot be dealt again and is refused. Each seed's games become one play-seed job (Schedule.ts jobFor: the seed's game
 * key, each version's canonical tar named in --names, which must be in --bundles with that sha256), played by
 * Executor.ts playLocal as a round plays them. --only keeps the games between the versions it names, or the games it
 * names by id: only bots that play the same moves from the same seed and key can come out the same (map-helper-lease
 * 13 F: no clock bots, no time or hang forfeits).
 *
 * Each game is compared with its recorded entry (outcome, winner, winnerSeat, by, faultKind, rounds, steps, key, the
 * decks dealt) and its recorded replay, byte for byte once both have the game key on the end line (ladder.js
 * addReplayKey) and the header's engine revision is left out (a ladder in a git checkout names it, play-seed never
 * does). Not compared: ms, timing, think, botStats, host. The games as played here go to <out>/games/<id>.jsonl (key
 * on the end line) and <out>/results.json; the summary to <out>/summary.json and, as one JSON line, to stdout:
 *   {ok, games, same, different: [{id, field, want, got}], missing: [ids]}
 * games counts the games played here, same those that came out the same, missing the games the round has no finished
 * entry for (not played). The log goes to stderr. Exit 0 only when every game played came out the same and none was
 * missing; 1 otherwise; 2 for a refused command line or round ({ok: false, error} on stdout).
 */
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { gunzipSync } from "node:zlib"
import { Cause, Effect, Option } from "effect"
import { readConfig } from "./Config.ts"
import { checkDecks as checkRoundDecks } from "./Gamesctl.ts"
import type { ComparisonContext } from "./Comparison.ts"
import { bundleMapProblem, contextProblem } from "./Comparison.ts"
import { playLocal, warmBundles } from "./Executor.ts"
import type { PlayFailed } from "./Executor.ts"
import type { ArenaJs } from "./Js.ts"
import { loadArenaJs } from "./Js.ts"
import * as Log from "./Log.ts"
import { makeProc } from "./Proc.ts"
import { buildSchedule, bySeed, jobFor, validPlacementSeeds } from "./Schedule.ts"
import type { DeckList, Limits, Played, PlaySeedJob, RoundDecks, RoundSpec, ScheduledGame } from "./Types.ts"

/** The repo this server sits in: the default checkout to play with (the image's /app, or a local clone). */
const REPO = path.resolve(import.meta.dirname, "..", "..", "..")
const HEX64 = /^[0-9a-f]{64}$/
const VERSION = /^[a-z][a-z0-9_]*-v\d+$/
/** a recorded replay larger than this is not read (the biggest real ones are a few MB) */
const MAX_REPLAY_BYTES = 64 << 20

export const USAGE = "usage: replay --results <arena-rK folder> --bundles <dir of tars> --names <file.json> --out <dir> [--only a,b] [--decks-dir <dir>] [--jobs N]"

/** A command line or a round this check does not take: exit 2. */
export class Refused extends Error {}

const plain = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x)
const count = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0
const positive = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex")

export interface ReplayArgs {
  readonly results: string
  readonly bundles: string
  readonly names: string
  readonly out: string
  readonly only: ReadonlyArray<string> | null
  readonly decksDir: string | null
  readonly jobs: number
}

/** The command line (a leading `replay` word is skipped), or Refused. */
export const parseReplayArgs = (argv: ReadonlyArray<string>): ReplayArgs => {
  const args = argv[0] === "replay" ? argv.slice(1) : [...argv]
  let values: Record<string, string | undefined>
  try {
    values = parseArgs({
      args,
      options: {
        results: { type: "string" },
        bundles: { type: "string" },
        names: { type: "string" },
        out: { type: "string" },
        only: { type: "string" },
        "decks-dir": { type: "string" },
        jobs: { type: "string" }
      },
      strict: true,
      allowPositionals: false
    }).values as Record<string, string | undefined>
  } catch (e) {
    throw new Refused(`${(e as Error).message.split("\n")[0]}; ${USAGE}`)
  }
  const { results, bundles, names, out } = values
  if (!results || !bundles || !names || !out) throw new Refused(USAGE)
  const jobs = values.jobs === undefined ? 1 : Number(values.jobs)
  if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 16) throw new Refused("--jobs is 1 to 16 (seeds played at once)")
  const only = values.only === undefined ? null : values.only.split(",").map((s) => s.trim()).filter(Boolean)
  if (only && only.length === 0) throw new Refused("--only names versions or game ids")
  const r = {
    results: path.resolve(results),
    bundles: path.resolve(bundles),
    names: path.resolve(names),
    out: path.resolve(out),
    only,
    decksDir: values["decks-dir"] ? path.resolve(values["decks-dir"]) : null,
    jobs
  }
  const rel = path.relative(r.results, r.out)
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) throw new Refused("--out must be outside the round's folder (its replays are what this compares with)")
  return r
}

/** What ladder.json's config says about how the round was played (ladder.js config; the games role writes the same). */
export interface RecordedRound {
  readonly arena: string
  readonly requiredProtocol?: 2
  readonly context?: ComparisonContext
  readonly bundles?: Readonly<Record<string, string>>
  readonly id: string
  readonly engine: string | null
  readonly bots: ReadonlyArray<string>
  readonly gamesPerPair: number
  readonly placement?: RoundSpec["placement"]
  readonly firstSeed: number
  readonly maxSteps: number
  readonly capMs: number
  readonly hangMs: number
  readonly key: string
  readonly decks: { readonly file: string; readonly sha256: string; readonly names: ReadonlyArray<string>; readonly skipped: ReadonlyArray<string>;
    readonly choices?: Readonly<Record<string, number>>; readonly poolSize?: number; readonly lists?: ReadonlyArray<DeckList> } | null
  /** the round's game entries by id (ladder.json games) */
  readonly games: ReadonlyMap<string, Record<string, any>>
}

/** A round's ladder.json, checked: every field the schedule and the jobs are made from, or Refused. */
export const readRound = (doc: unknown): RecordedRound => {
  const no = (why: string): never => {
    throw new Refused(`the round's ladder.json: ${why}`)
  }
  if (!plain(doc) || !plain(doc.config)) return no("no config")
  const c = doc.config
  if (c.requiredProtocol !== undefined && c.requiredProtocol !== 2) no("requiredProtocol must be 2")
  if (c.arena === "v2" && c.requiredProtocol !== 2) no("the v2 arena requires explicit protocol 2")
  if (!Array.isArray(c.bots) || c.bots.length < 2 || !c.bots.every((b: unknown) => typeof b === "string" && b.length > 0) || new Set(c.bots).size !== c.bots.length) {
    return no("its bots are not two or more names")
  }
  if (c.requiredProtocol === 2) {
    const why = contextProblem(c.context, c.context)
    if (why) no(why)
    if (!plain(c.bundles)) no("no frozen bundle digests")
    const bundles = Object.fromEntries(c.bots.map((name: string) => [name, c.bundles[name]]))
    const wrong = bundleMapProblem(c.bundles, bundles)
    if (wrong) no(wrong)
  }
  if (c.format !== undefined || c.vs !== undefined) no("a gauntlet, not a round robin")
  if (c.pool !== undefined && c.pool !== null) no("played from a card pool, which the arena never deals")
  if (!count(c.gamesPerPair) || c.gamesPerPair < 2 || c.gamesPerPair % 2 !== 0) no("games per pair is not an even number")
  let placement: RoundSpec["placement"]
  if (c.placement !== undefined) {
    const p = c.placement
    if (!plain(p) || typeof p.version !== "string" || !VERSION.test(p.version) || !c.bots.includes(p.version) ||
      typeof p.ref !== "string" || !p.ref.startsWith("window:") || p.ref.length <= 7 || p.ref.length > 300 ||
      c.bots.length > 5 || c.gamesPerPair > 10) no("invalid bounded placement")
    if (p.adaptive !== undefined || p.excludedSeeds !== undefined) {
      if (p.adaptive !== true || c.bots.length !== 2 || c.gamesPerPair !== 2 || !validPlacementSeeds(p.excludedSeeds)) no("invalid adaptive placement")
      placement = { version: p.version, ref: p.ref, adaptive: true, excludedSeeds: [...p.excludedSeeds] }
    } else placement = { version: p.version, ref: p.ref }
  }
  if (!count(c.firstSeed)) no("no first seed")
  if (placement?.adaptive && (c.firstSeed > 0xffffffff || placement.excludedSeeds.includes(c.firstSeed))) no("invalid adaptive first seed")
  if (!count(c.maxSteps) || c.maxSteps < 1) no("no step cap")
  if (!positive(c.capMs)) no("no time cap (every arena round has one)")
  if (!positive(c.hangMs)) no("no watchdog limit")
  if (typeof c.key !== "string" || c.key.length === 0) {
    no("no run key (it is written once the round is done, and a round dealt from the seed alone has none), so its games cannot be dealt again")
  }
  let decks: RecordedRound["decks"] = null
  if (c.decks !== undefined && c.decks !== null) {
    const d = c.decks
    if (!plain(d) || typeof d.file !== "string" || path.basename(d.file) !== d.file || d.file.startsWith(".") || !/\.json$/.test(d.file)) {
      no("its deck file is not a file name")
    }
    if (typeof d.sha256 !== "string" || !HEX64.test(d.sha256)) no("its deck file has no sha256")
    if (!Array.isArray(d.names) || d.names.length < 2 || !d.names.every((n: unknown) => typeof n === "string")) no("its deck names are not a list")
    if (d.deal !== "seat") no(`its decks were dealt by ${JSON.stringify(d.deal ?? "bot")}; the arena deals by seat`)
    const skipped = d.skipped ?? []
    if (!Array.isArray(skipped) || !skipped.every((n: unknown) => typeof n === "string")) no("its skipped decks are not a list")
    decks = { file: d.file, sha256: d.sha256, names: d.names, skipped }
    if (d.choices !== undefined) {
      let frozen: RoundDecks | null
      try { frozen = checkRoundDecks({ ...d, skipped }) } catch { return no("invalid frozen deck choices") }
      if (!frozen?.choices || Object.keys(frozen.choices).some((n) => !c.bots.includes(n))) return no("a deck choice names another version")
      decks = { ...decks, choices: frozen.choices, poolSize: frozen.poolSize!, lists: frozen.lists }
    }
  }
  const games = new Map<string, Record<string, any>>()
  for (const g of Array.isArray(doc.games) ? doc.games : []) {
    if (plain(g) && typeof g.id === "string") games.set(g.id, g)
  }
  return {
    arena: typeof c.arena === "string" ? c.arena : "open",
    ...(c.requiredProtocol === 2 ? { requiredProtocol: 2 as const } : {}),
    ...(c.requiredProtocol === 2 ? { context: c.context as ComparisonContext, bundles: c.bundles as Record<string, string> } : {}),
    id: typeof doc.id === "string" ? doc.id : "?",
    engine: typeof doc.engine === "string" ? doc.engine : null,
    bots: c.bots,
    gamesPerPair: c.gamesPerPair,
    ...(placement ? { placement } : {}),
    firstSeed: c.firstSeed,
    maxSteps: c.maxSteps,
    capMs: c.capMs,
    hangMs: c.hangMs,
    key: c.key,
    decks,
    games
  }
}

/** The round's deck lists from its file, checked against the round: the same bytes (sha256), the same lists left out. */
export const roundDecks = (
  recorded: NonNullable<RecordedRound["decks"]>,
  loaded: { readonly decks: ReadonlyArray<DeckList>; readonly sha256: string }
): RoundDecks => {
  if (loaded.sha256 !== recorded.sha256) {
    throw new Refused(`${recorded.file} is not the file the round dealt (sha256 ${loaded.sha256.slice(0, 12)}, the round's ${recorded.sha256.slice(0, 12)})`)
  }
  const all = loaded.decks.map((d) => d.metadata.name)
  const unknown = recorded.skipped.filter((n) => !all.includes(n))
  if (unknown.length) throw new Refused(`${recorded.file} has no list ${unknown.join(", ")} to leave out`)
  const lists = loaded.decks.filter((d) => !recorded.skipped.includes(d.metadata.name))
  const defaultNames = recorded.choices ? recorded.names.slice(0, recorded.poolSize) : recorded.names
  if (JSON.stringify(lists.map((d) => d.metadata.name)) !== JSON.stringify(defaultNames)) {
    throw new Refused(`${recorded.file} less the skipped lists is not the round's ${recorded.names.length} lists`)
  }
  if (recorded.choices && (!recorded.lists || JSON.stringify(recorded.lists.slice(0, recorded.poolSize)) !== JSON.stringify(lists))) {
    throw new Refused("the recorded default deck pool differs from its validated catalog")
  }
  return { file: recorded.file, sha256: recorded.sha256, names: recorded.names, deal: "seat", skipped: recorded.skipped,
    lists: recorded.lists ?? lists, ...(recorded.choices ? { choices: recorded.choices, poolSize: recorded.poolSize } : {}) }
}

/** The versions' tars: the names file, every lineup version in it, each tar in the folder with that sha256. */
export const readNames = (text: string, bots: ReadonlyArray<string>, bundles: string, frozen?: Readonly<Record<string, string>>): Record<string, string> => {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    throw new Refused("--names is not a JSON object of version name -> sha256")
  }
  if (!plain(doc)) throw new Refused("--names is not a JSON object of version name -> sha256")
  const out: Record<string, string> = {}
  for (const b of bots) {
    const hex = doc[b]
    if (!VERSION.test(b)) throw new Refused(`${b} is not a version (<agent>-v<N>), and the games role plays versions alone: leave its games out with --only`)
    if (typeof hex !== "string" || !HEX64.test(hex)) throw new Refused(`--names has no sha256 for ${b}`)
    if (frozen && hex !== frozen[b]) throw new Refused(`${b}: --names differs from the round's original bundle digest`)
    const tar = path.join(bundles, `${hex}.tar`)
    if (!lstatSync(tar, { throwIfNoEntry: false })?.isFile()) throw new Refused(`${b}: no ${hex}.tar in ${bundles}`)
    if (sha256(readFileSync(tar)) !== hex) throw new Refused(`${b}: ${hex}.tar does not hash to its name`)
    out[b] = hex
  }
  return out
}

/** The games --only keeps: those between two of the versions it names, and those it names by id. */
export const selectGames = (games: ReadonlyArray<ScheduledGame>, bots: ReadonlyArray<string>, only: ReadonlyArray<string> | null) => {
  if (!only) return games
  const ids = new Set(games.map((g) => g.id))
  const unknown = only.filter((x) => !bots.includes(x) && !ids.has(x))
  if (unknown.length) throw new Refused(`--only: ${unknown.join(", ")} is neither a version of the round nor one of its games`)
  const keep = new Set(only)
  const chosen = games.filter((g) => keep.has(g.id) || (keep.has(g.p1) && keep.has(g.p2)))
  if (chosen.length === 0) throw new Refused("--only leaves no game to play (it keeps the games between two of the versions it names)")
  return chosen
}

/** ladder.js addReplayKey on a replay's text: the game key on its end line, when the end line has none. */
export const withKey = (text: string, key: string | null): string => {
  if (!key) return text
  const i = text.lastIndexOf("\n", text.length - 2) + 1
  let end: unknown
  try {
    end = JSON.parse(text.slice(i))
  } catch {
    return text
  }
  return plain(end) && end.t === "end" && !end.key ? `${text.slice(0, i)}${JSON.stringify({ ...end, key })}\n` : text
}

/** A replay's lines as compared: the key on the end line, the header's engine revision left out. */
export const replayLines = (text: string, key: string | null): Array<string> => {
  const lines = withKey(text, key).split("\n")
  if (lines.at(-1) === "") lines.pop()
  if (lines.length) {
    try {
      const head = JSON.parse(lines[0]!)
      if (plain(head) && head.t === "header") {
        lines[0] = JSON.stringify({ ...head, ...("engine" in head ? { engine: null } : {}), ...("engineRev" in head ? { engineRev: null } : {}) })
      }
    } catch {
      // not JSON: compared as it is
    }
  }
  return lines
}

const show = (v: unknown) => (v === undefined ? "nothing" : JSON.stringify(v).slice(0, 200))

/** The first place two JSON values differ: its path and both values, or null when they are equal. */
const firstDifference = (want: unknown, got: unknown, at: string): { at: string; want: unknown; got: unknown } | null => {
  if (Object.is(want, got)) return null
  if (!want || !got || typeof want !== "object" || typeof got !== "object" || Array.isArray(want) !== Array.isArray(got)) return { at, want, got }
  if (Array.isArray(want) && Array.isArray(got) && want.length !== got.length) return { at: `${at}.length`, want: want.length, got: got.length }
  for (const k of new Set([...Object.keys(want), ...Object.keys(got)])) {
    const d = firstDifference((want as any)[k], (got as any)[k], Array.isArray(want) ? `${at}[${k}]` : at ? `${at}.${k}` : k)
    if (d) return d
  }
  return null
}

export interface Difference {
  readonly id: string
  readonly field: string
  readonly want: unknown
  readonly got: unknown
}

/** Where two replays' lines first differ, as one difference, or null when they are the same. */
export const compareReplays = (id: string, want: ReadonlyArray<string>, got: ReadonlyArray<string>): Difference | null => {
  const n = Math.max(want.length, got.length)
  for (let i = 0; i < n; i++) {
    const a = want[i]
    const b = got[i]
    if (a === b) continue
    if (a === undefined || b === undefined) {
      return { id, field: "replay", want: `${want.length} lines`, got: `${got.length} lines` }
    }
    let pa: unknown
    let pb: unknown
    try {
      pa = JSON.parse(a)
      pb = JSON.parse(b)
    } catch {
      return { id, field: "replay", want: `line ${i + 1}: ${a.slice(0, 200)}`, got: `line ${i + 1}: ${b.slice(0, 200)}` }
    }
    const where = plain(pa) && pa.t === "step" ? `line ${i + 1} (step ${pa.n})` : `line ${i + 1}`
    const d = firstDifference(pa, pb, "")
    if (!d) {
      // the same values written another way (key order)
      return { id, field: "replay", want: `${where}: ${a.slice(0, 200)}`, got: `${where}: ${b.slice(0, 200)}` }
    }
    return { id, field: "replay", want: `${where} ${d.at || "(line)"}: ${show(d.want)}`, got: `${where} ${d.at || "(line)"}: ${show(d.got)}` }
  }
  return null
}

/** The recorded entry's fields and the result's (ladder.js onResult: the entry's rounds is the result's round). */
const FIELDS: ReadonlyArray<readonly [entry: string, result: string]> = [
  ["outcome", "outcome"],
  ["winner", "winner"],
  ["winnerSeat", "winnerSeat"],
  ["by", "by"],
  ["faultKind", "faultKind"],
  ["rounds", "round"],
  ["steps", "steps"],
  ["key", "key"],
  ["requiredProtocol", "requiredProtocol"],
  ["protocols", "protocols"],
  ["context", "context"],
  ["bundles", "bundles"]
]
const OBSERVATION_FIELDS = ["protocols", "context", "bundles"] as const

/** A game played here against its recorded entry and replay; [] when it came out the same. */
export const compareGame = (
  id: string,
  entry: Record<string, any>,
  result: Record<string, any>,
  recorded: string | null,
  played: string | null,
  key: string | null
): Array<Difference> => {
  const out: Array<Difference> = []
  const legacy = entry.requiredProtocol === undefined && result.requiredProtocol === undefined
  for (const [e, r] of FIELDS) {
    // Old recordings predate these observations. Compare every field they did record;
    // a v2 execution or recording always compares all evidence.
    if (legacy && OBSERVATION_FIELDS.some((field) => field === e) && !Object.hasOwn(entry, e)) continue
    const want = entry[e] ?? null
    const got = result[r] ?? null
    if (JSON.stringify(want) !== JSON.stringify(got)) out.push({ id, field: e, want, got })
  }
  if ((recorded === null) !== (played === null)) {
    out.push({ id, field: "replay", want: recorded === null ? "no replay" : "a replay", got: played === null ? "no replay" : "a replay" })
  } else if (recorded !== null && played !== null) {
    const want = replayLines(recorded, key)
    const got = replayLines(played, key)
    if (legacy && want.length && got.length) {
      try {
        const oldEnd = JSON.parse(want.at(-1)!)
        const newEnd = JSON.parse(got.at(-1)!)
        if (plain(oldEnd) && plain(newEnd) && oldEnd.t === "end" && newEnd.t === "end"
            && oldEnd.requiredProtocol === undefined && newEnd.requiredProtocol === undefined) {
          for (const field of OBSERVATION_FIELDS) if (!Object.hasOwn(oldEnd, field)) delete newEnd[field]
          got[got.length - 1] = JSON.stringify(newEnd)
        }
      } catch {
        // Malformed replay lines remain differences, as before.
      }
    }
    const d = compareReplays(id, want, got)
    if (d) out.push(d)
  }
  return out
}

/** The decks a scheduled game is dealt, by name, as ladder.js onStart puts them in its entry. */
const deckNames = (g: ScheduledGame, decks: RoundDecks | null) =>
  g.decks && decks ? { p1: decks.lists[g.decks[0]]!.metadata.name, p2: decks.lists[g.decks[1]]!.metadata.name } : null

export interface Summary {
  readonly ok: boolean
  readonly games: number
  readonly same: number
  readonly different: ReadonlyArray<Difference>
  readonly missing: ReadonlyArray<string>
}

export interface ReplayOptions {
  /** plays one job (default: Executor.ts playLocal with this process's config, its bundles folder the --bundles one) */
  readonly play?: (job: PlaySeedJob, tag: string) => Effect.Effect<Played, PlayFailed>
  /** reads and checks a deck file (default: decklists.js loadDecks with the engine's card data, in this process) */
  readonly loadDecks?: (file: string) => { readonly decks: ReadonlyArray<DeckList>; readonly sha256: string }
  /** the environment the games role's config is read from (default process.env; GAMES_APP defaults to this checkout) */
  readonly env?: NodeJS.ProcessEnv
  /** where the summary line goes (default stdout, which then carries nothing else) */
  readonly print?: (line: string) => void
  /** progress lines (default the log, on stderr) */
  readonly note?: (line: string) => void
}

const firstLine = (s: string) => s.split("\n")[0]!.slice(0, 300)

/** Why a play failed: PlayFailed's reason, or the first line of anything else that went wrong. */
const whyOf = (cause: Cause.Cause<PlayFailed>): string => {
  const e = Cause.findErrorOption(cause)
  return Option.isSome(e) ? e.value.why : firstLine(Cause.pretty(cause))
}

const writeAtomic = (file: string, text: string) => {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

/** Whether the round has a replay of the game (a game whose bot failed to load has none), checked before any play. */
const hasRecorded = (file: string): boolean => {
  const st = lstatSync(file, { throwIfNoEntry: false })
  if (!st) return false
  if (!st.isFile() || st.size > MAX_REPLAY_BYTES) throw new Refused(`${file} is not a replay this check reads`)
  return true
}

/**
 * The round's replay of a game: games/<id>.jsonl, or games/<id>.jsonl.gz once the games machine gzipped an older
 * round (Compact.ts); null when it has neither.
 */
const recordedFile = (games: string, id: string): string | null => {
  const plain = path.join(games, `${id}.jsonl`)
  if (hasRecorded(plain)) return plain
  const gz = `${plain}.gz`
  return hasRecorded(gz) ? gz : null
}

/** Reads a replay recordedFile named; a plain one the games machine gzipped since then is read from its .gz. */
const readRecorded = (file: string): string => {
  if (file.endsWith(".gz")) return gunzipSync(readFileSync(file), { maxOutputLength: MAX_REPLAY_BYTES }).toString("utf8")
  try {
    return readFileSync(file, "utf8")
  } catch (e) {
    // Compact.ts writes <id>.jsonl.gz before it removes <id>.jsonl
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
    return readRecorded(`${file}.gz`)
  }
}

interface Prepared {
  readonly round: RecordedRound
  readonly schedule: ReadonlyArray<ScheduledGame>
  readonly decks: RoundDecks | null
  readonly jobs: ReadonlyArray<{ readonly job: PlaySeedJob; readonly games: ReadonlyArray<ScheduledGame> }>
  readonly missing: ReadonlyArray<string>
  /** the recorded replay of each game to play, or null */
  readonly replays: ReadonlyMap<string, string | null>
}

/** Everything checked and every job made before any game plays: a refusal never comes after games were played. */
const prepare = (args: ReplayArgs, js: ArenaJs, app: string, loadDecks: NonNullable<ReplayOptions["loadDecks"]>, context: ComparisonContext | null, arena: string): Prepared => {
  let doc: unknown
  try {
    doc = JSON.parse(readFileSync(path.join(args.results, "ladder.json"), "utf8"))
  } catch (e) {
    throw new Refused(`cannot read ${path.join(args.results, "ladder.json")} (${firstLine((e as Error).message)})`)
  }
  const round = readRound(doc)
  // The selected execution boundary is trusted; a legacy recording cannot opt out by omitting its policy.
  if (arena === "v2" && (round.arena !== "v2" || round.requiredProtocol !== 2)) {
    throw new Refused("v2 replay requires a v2 arena recording with explicit protocol 2 and verified comparison context")
  }
  if (round.requiredProtocol === 2) {
    const why = contextProblem(round.context, context)
    if (why) throw new Refused(why)
  }
  let decks: RoundDecks | null = null
  if (round.decks) {
    const file = path.join(args.decksDir ?? path.join(app, "bot", "decks"), round.decks.file)
    let loaded: { decks: ReadonlyArray<DeckList>; sha256: string }
    try {
      loaded = loadDecks(file)
    } catch (e) {
      throw new Refused(`cannot load the round's deck lists from ${file} (${firstLine((e as Error).message)})`)
    }
    decks = roundDecks(round.decks, loaded)
  }
  const schedule = buildSchedule(js, { bots: round.bots, gamesPerPair: round.gamesPerPair, decks,
    ...(round.placement ? { placement: round.placement } : {}) }, round.firstSeed)
  const chosen = selectGames(schedule, round.bots, args.only)
  // only the games the round finished can be compared; the others are named, not played
  const finished = (g: ScheduledGame) => {
    const e = round.games.get(g.id)
    return !!e && typeof e.outcome === "string" && e.outcome !== "running"
  }
  const missing = chosen.filter((g) => !finished(g)).map((g) => g.id)
  const toPlay = chosen.filter(finished)
  const names = new Set(toPlay.flatMap((g) => [g.p1, g.p2]))
  let text: string
  try {
    text = readFileSync(args.names, "utf8")
  } catch (e) {
    throw new Refused(`cannot read ${args.names} (${firstLine((e as Error).message)})`)
  }
  const bundles = readNames(text, round.bots.filter((b) => names.has(b)), args.bundles, round.bundles)
  const limits: Limits = {
    maxSteps: round.maxSteps,
    capMs: round.capMs,
    hangMs: round.hangMs,
    // game-pool.js DEFAULT_GAME_MS, as the round's ladder ran it
    gameMs: 4 * round.capMs + 600000
  }
  const jobs = [...bySeed(toPlay).values()].map((games) => ({ job: jobFor(js, { bundles, decks, ...(round.requiredProtocol === 2 ? { requiredProtocol: 2 as const } : {}), ...(round.context ? { context: round.context } : {}) }, round.key, games, limits), games }))
  const replays = new Map(toPlay.map((g) => [g.id, recordedFile(path.join(args.results, "games"), g.id)] as const))
  return { round, schedule, decks, jobs, missing, replays }
}

/** One job's games against the round's record: their differences, and the results as played here. */
const compareJob = (args: ReplayArgs, p: Prepared, job: PlaySeedJob, games: ReadonlyArray<ScheduledGame>, played: Played) => {
  const out: Array<Difference> = []
  const results: Array<readonly [string, unknown]> = []
  for (const g of games) {
    const entry = p.round.games.get(g.id)!
    const dealt = deckNames(g, p.decks)
    if (JSON.stringify(entry.decks ?? null) !== JSON.stringify(dealt)) out.push({ id: g.id, field: "decks", want: entry.decks ?? null, got: dealt })
    const r = played.results.find((x) => x.id === g.id)?.result
    if (!r) {
      out.push({ id: g.id, field: "result", want: "a result", got: "none" })
      continue
    }
    results.push([g.id, r])
    // as the round's files would hold it: the seed is whole, so its key goes on the end line
    const text = typeof played.replays[g.id] === "string" ? withKey(played.replays[g.id]!, job.key) : null
    if (text !== null) writeAtomic(path.join(args.out, "games", `${g.id}.jsonl`), text)
    const file = p.replays.get(g.id) ?? null
    out.push(...compareGame(g.id, entry, r as Record<string, any>, file === null ? null : readRecorded(file), text, job.key))
  }
  return { out, results }
}

/** Plays the jobs and compares their games; the summary. */
const check = (
  args: ReplayArgs,
  p: Prepared,
  play: NonNullable<ReplayOptions["play"]>,
  note: (line: string) => void
): Effect.Effect<Summary> =>
  Effect.gen(function*() {
    mkdirSync(path.join(args.out, "games"), { recursive: true })
    const tagBase = `replay-${process.pid}`
    const perJob = yield* Effect.forEach(p.jobs, ({ job, games }) =>
      play(job, `${tagBase}-${job.seed}`).pipe(
        Effect.map((played) => ({ played, why: null as string | null })),
        // a job that could not play: its games differ by that; an interrupt still stops the whole check
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause as Cause.Cause<never>) : Effect.succeed({ played: null, why: whyOf(cause) })
        ),
        Effect.map(({ played, why }) => {
          if (!played) {
            note(`seed ${job.seed}: not played (${why})`)
            return { out: games.map((g): Difference => ({ id: g.id, field: "play", want: "a result", got: why })), results: [] }
          }
          const r = compareJob(args, p, job, games, played)
          const bad = new Set(r.out.map((d) => d.id)).size
          note(`seed ${job.seed}: ${games.length} game${games.length === 1 ? "" : "s"}, ${bad ? `${bad} different` : "the same"}`)
          return r
        })
      ), { concurrency: args.jobs })
    const different = perJob.flatMap((r) => r.out)
    const games = p.jobs.reduce((n, j) => n + j.games.length, 0)
    const same = games - new Set(different.map((d) => d.id)).size
    const summary: Summary = { ok: games > 0 && same === games && p.missing.length === 0, games, same, different, missing: p.missing }
    writeAtomic(path.join(args.out, "results.json"), `${JSON.stringify(Object.fromEntries(perJob.flatMap((r) => r.results)))}\n`)
    writeAtomic(path.join(args.out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`)
    return summary
  })

/** decklists.js loadDecks with the engine's card data (bot/env.js Env), in this process: the check ladder.js makes. */
const engineDecks = (app: string) => (file: string) => {
  const require = createRequire(path.join(app, "bot", "package.json"))
  const { loadDecks } = require(path.join(app, "bot", "decklists.js"))
  const { Env } = require(path.join(app, "bot", "env.js"))
  return loadDecks(file, new Env()) as { decks: ReadonlyArray<DeckList>; sha256: string }
}

/**
 * `node src/main-games.ts replay ...`; resolves the process's exit code (0 when every compared game came out the same).
 * Without options it plays through Executor.ts on this machine's config and keeps stdout for the summary line alone.
 */
export const runReplay = (argv: ReadonlyArray<string>, opts: ReplayOptions = {}): Effect.Effect<number> => {
  const cli = opts.print === undefined
  // stdout carries the summary line and nothing else: the engine and the log write to stderr meanwhile
  const realWrite = process.stdout.write.bind(process.stdout)
  const print = opts.print ?? ((line: string) => {
    realWrite(`${line}\n`)
  })
  const note = opts.note ?? ((line: string) => Log.info(`replay: ${line}`))
  const begin = Effect.sync(() => {
    if (!cli) return
    Log.setSink((line) => process.stderr.write(line))
    process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write
  })
  const end = Effect.sync(() => {
    if (cli) process.stdout.write = realWrite as typeof process.stdout.write
  })
  const refuse = (e: unknown) => {
    const why = e instanceof Refused ? e.message : `${firstLine(String((e as Error)?.message ?? e))}`
    process.stderr.write(`replay: ${why}\n`)
    return why
  }
  const body = Effect.gen(function*() {
    let args: ReplayArgs
    let prepared: Prepared
    let play: NonNullable<ReplayOptions["play"]>
    let warm: Effect.Effect<void> = Effect.void
    try {
      args = parseReplayArgs(argv)
      const env = opts.env ?? process.env
      const config = readConfig({ ...env, GAMES_APP: env.GAMES_APP || REPO })
      const js = loadArenaJs(config.app)
      prepared = prepare(args, js, config.app, opts.loadDecks ?? engineDecks(config.app), config.context, config.arena)
      if (opts.play) {
        play = opts.play
      } else {
        // the round's own executor, with the tars from --bundles; work folders, wasm cache and the bots' user as the
        // games role has them (GAMES_DATA)
        const c = { ...config, paths: { ...config.paths, bundles: args.bundles } }
        const proc = makeProc(c)
        play = (job, tag) => playLocal(c, proc, job, tag)
        // compiled as root first, as a round compiles its lineup: the games, as the bots' user, only read the cache
        const hexes = new Set(prepared.jobs.flatMap(({ job }) => Object.values(job.bots).flatMap((b) => (b.kind === "wasm" ? [b.bundle] : []))))
        warm = warmBundles(c, proc, [...hexes])
      }
    } catch (e) {
      const why = refuse(e)
      yield* end
      print(JSON.stringify({ ok: false, error: why }))
      return 2
    }
    const p = prepared
    yield* warm
    note(`${p.round.id}: ${p.jobs.length} seed${p.jobs.length === 1 ? "" : "s"}, ${p.jobs.reduce((n, j) => n + j.games.length, 0)} of ${p.schedule.length} games to play again${p.missing.length ? `, ${p.missing.length} not finished in the round` : ""}`)
    const summary = yield* check(args, p, play, note).pipe(
      // something broke while comparing or writing (not a game that came out differently): no verdict
      Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.succeed(firstLine(Cause.pretty(cause)))))
    )
    yield* end
    if (typeof summary === "string") {
      process.stderr.write(`replay: ${summary}\n`)
      print(JSON.stringify({ ok: false, error: summary }))
      return 1
    }
    print(JSON.stringify(summary))
    return summary.ok ? 0 : 1
  })
  return begin.pipe(Effect.andThen(body), Effect.ensuring(end))
}
