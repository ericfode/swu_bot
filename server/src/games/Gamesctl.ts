/**
 * The Node side of the games machine (bot/arena/gamesctl.js), run as child processes. Each command prints one JSON line
 * on stdout; this checks it before anything uses it. Commands that run as the bots' user (plan, push) are untrusted:
 * their words are checked like a stranger's. The window's documents stay Node's until stage 6 replaces them
 * with the record.
 */
import path from "node:path"
import { Context, Effect, Layer } from "effect"
import type { GamesConfig } from "./Config.ts"
import { scripts } from "./Config.ts"
import type { ComparisonContext } from "./Comparison.ts"
import { bundleMapProblem, contextProblem } from "./Comparison.ts"
import type { Kind, ProcService, Result, RunOptions } from "./Proc.ts"
import { childEnv, lastLine } from "./Proc.ts"
import { validPlacementSeeds } from "./Schedule.ts"
import type { DeckList, Plan, PlanWhy, RoundDecks, RoundSpec } from "./Types.ts"

export class GamesctlFailed extends Error {
  readonly command: string
  readonly why: string
  /** the machine is stopping (or a stop reached the child): not a failure of the command */
  readonly stopped: boolean
  /** a placement selection became unnecessary before reservation: ask for a fresh plan, without an attempt */
  readonly replan: boolean
  constructor(command: string, why: string, stopped = false, replan = false) {
    super(`gamesctl ${command} failed (${why})`)
    this.command = command
    this.why = why
    this.stopped = stopped
    this.replan = replan
  }
}

const WHYS: ReadonlyArray<PlanWhy> = ["changed", "stale", "resume", "placement", "same", "settling", "no-competitor", "no-opponent"]
const VERSION = /^[a-z][a-z0-9_]*-v\d+$/
const HEX64 = /^[0-9a-f]{64}$/
const plain = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)
const count = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0

/** The answer's JSON, or why there is none. */
const answer = (command: string, r: Result): unknown => {
  if (r.kind === "timeout") throw new GamesctlFailed(command, "took too long")
  if (r.kind === "stopped") throw new GamesctlFailed(command, r.reason, true)
  if (r.kind === "failed") throw new GamesctlFailed(command, r.reason)
  if (r.code === 143) throw new GamesctlFailed(command, "stopped", true)
  if (r.code !== 0) throw new GamesctlFailed(command, `exit ${r.code}`)
  try {
    return JSON.parse(lastLine(r.stdout))
  } catch {
    throw new GamesctlFailed(command, "it printed no JSON line")
  }
}

/** plan's answer, checked: it runs as the bots' user. */
export const checkPlan = (doc: unknown): Plan => {
  if (!plain(doc)) throw new GamesctlFailed("plan", "plan printed something other than a round")
  const why = (WHYS as ReadonlyArray<unknown>).includes(doc.why) ? (doc.why as PlanWhy) : "?"
  if (doc.round === null) return { round: null, why }
  if (count(doc.round) && doc.round <= 1_000_000 && typeof doc.resume === "boolean") {
    return { round: doc.round, resume: doc.resume, why }
  }
  throw new GamesctlFailed("plan", "plan printed something other than a round")
}

export const checkDecks = (d: unknown): RoundDecks | null => {
  if (d === null) return null
  if (!plain(d) || typeof d.file !== "string" || typeof d.sha256 !== "string" || !HEX64.test(d.sha256) ||
    !Array.isArray(d.names) || !d.names.every((n) => typeof n === "string") || d.deal !== "seat" ||
    !Array.isArray(d.skipped) || !Array.isArray(d.lists) || d.lists.length !== d.names.length || d.lists.length < 2 ||
    !d.lists.every((l, i) => plain(l) && plain(l.metadata) && l.metadata.name === (d.names as Array<string>)[i])) {
    throw new GamesctlFailed("round", "its deck lists are not what a round deals")
  }
  const listCount = d.lists.length
  if (d.choices !== undefined && (!plain(d.choices) || !Object.values(d.choices).every((i) => count(i) && i < listCount) ||
    !count(d.poolSize) || d.poolSize < 2 || d.poolSize > d.lists.length)) throw new GamesctlFailed("round", "invalid selected deck indices or default pool")
  return {
    file: d.file, sha256: d.sha256, names: d.names as Array<string>, deal: "seat",
    skipped: (d.skipped as Array<unknown>).map(String), lists: d.lists as Array<DeckList>,
    ...(d.choices !== undefined ? { choices: d.choices as Record<string, number>, poolSize: d.poolSize as number } : {})
  }
}

/** round's answer, checked (it runs as root, but its parts become a schedule and jobs). */
export const checkRound = (k: number, doc: unknown, requiredProtocol?: 2, context?: ComparisonContext | null): RoundSpec => {
  const no = (why: string): never => {
    throw new GamesctlFailed("round", why)
  }
  if (!plain(doc) || doc.round !== k) return no(`it did not answer for round ${k}`)
  if (doc.placementSkipped === true) throw new GamesctlFailed("round", "placement no longer needs a reserved round", false, true)
  if (doc.requiredProtocol !== undefined && doc.requiredProtocol !== 2) return no("requiredProtocol must be 2")
  if (requiredProtocol === 2 && doc.requiredProtocol !== 2) return no("the v2 arena requires explicit protocol 2")
  if (requiredProtocol === 2) {
    const why = contextProblem(doc.context, context)
    if (why) return no(why)
  }
  if (!Array.isArray(doc.bots) || doc.bots.length < 2 || !doc.bots.every((b) => typeof b === "string" && VERSION.test(b)) ||
    new Set(doc.bots).size !== doc.bots.length) return no("its lineup is not two or more versions")
  if (!count(doc.gamesPerPair) || doc.gamesPerPair < 1 || doc.gamesPerPair > 100) return no("games per pair out of range")
  if (!count(doc.capMs) || doc.capMs < 1000) return no("time limit out of range")
  if (!plain(doc.bundles) || !(doc.bots as Array<string>).every((b) => HEX64.test(String((doc.bundles as any)[b])))) {
    return no("a version has no bundle")
  }
  if (!plain(doc.botInfo)) return no("no botInfo")
  let placement: RoundSpec["placement"]
  if (doc.placement !== undefined) {
    const p = doc.placement
    if (!plain(p) || typeof p.version !== "string" || !doc.bots.includes(p.version) ||
      typeof p.ref !== "string" || !p.ref.startsWith("window:") || p.ref.length <= 7 || p.ref.length > 300 ||
      doc.bots.length > 5 || doc.gamesPerPair > 10 || doc.gamesPerPair % 2 !== 0) return no("invalid bounded placement")
    if (p.adaptive !== undefined || p.excludedSeeds !== undefined) {
      if (p.adaptive !== true || doc.bots.length !== 2 || doc.gamesPerPair !== 2 || !validPlacementSeeds(p.excludedSeeds)) {
        return no("invalid adaptive placement")
      }
      placement = { version: p.version, ref: p.ref, adaptive: true, excludedSeeds: [...p.excludedSeeds] }
    } else placement = { version: p.version, ref: p.ref }
  }
  const decks = checkDecks(doc.decks ?? null)
  if (decks?.choices && Object.keys(decks.choices).some((n) => !(doc.bots as Array<string>).includes(n))) return no("a deck choice names a version outside this round")
  return {
    ...(doc.requiredProtocol === 2 ? { requiredProtocol: 2 as const } : {}),
    ...(doc.context ? { context: doc.context as unknown as ComparisonContext } : {}),
    round: k,
    bots: doc.bots as Array<string>,
    gamesPerPair: doc.gamesPerPair,
    capMs: doc.capMs,
    decks,
    bundles: Object.fromEntries((doc.bots as Array<string>).map((b) => [b, String((doc.bundles as any)[b])])),
    botInfo: doc.botInfo as Record<string, Record<string, unknown>>,
    ...(placement ? { placement } : {})
  }
}

export interface IntakeAnswer {
  /** submissions still open, or null when unknown (window down, toolchain missing, a failed pass) */
  readonly open: number | null
  readonly accepted: number
  readonly error: string | null
}

export interface GamesctlService {
  readonly setup: Effect.Effect<{ readonly residents: ReadonlyArray<string>; readonly toolchain: string | null }, GamesctlFailed>
  readonly warm: Effect.Effect<{ readonly warmed: number; readonly failed: ReadonlyArray<string> }, GamesctlFailed>
  readonly plan: (settledSince: number, placementOnly?: boolean) => Effect.Effect<Plan, GamesctlFailed>
  readonly round: (k: number, games: number, capMs: number, placement?: boolean) => Effect.Effect<RoundSpec, GamesctlFailed>
  /** Rehash frozen versions through the trusted Node controller, without selecting or reserving a new placement. */
  readonly verifyRound?: (spec: RoundSpec) => Effect.Effect<void, GamesctlFailed>
  readonly publish: (k: number) => Effect.Effect<void, GamesctlFailed>
  /** Durable placement failures use a root-only metadata command, independent of referee publication. */
  readonly placementState?: (k: number, state: "running" | "retrying" | "held", error?: string) => Effect.Effect<void, GamesctlFailed>
  readonly decks: (file: string, skip: ReadonlyArray<string>) => Effect.Effect<RoundDecks, GamesctlFailed>
  readonly intake: (proxy: string) => Effect.Effect<IntakeAnswer, GamesctlFailed>
  readonly push: (proxy: string, only: "round" | null) => Effect.Effect<boolean, GamesctlFailed>
}

export const makeGamesctl = (c: GamesConfig, proc: ProcService, boot: string): GamesctlService => {
  const script = scripts(c).gamesctl
  // what gamesctl needs to find the volume, and to hide the server's own folder from the intake's checkers
  const base = {
    NODE_ENV: "production",
    GAMES_DATA: c.data,
    ARENA_ID: c.arena,
    GAMES_BUILD: c.build,
    GAMES_CARDS: c.cards,
    GAMES_PLACEMENT_MODE: c.placementMode,
    ARENA_USER: c.arenaUser,
    GAMES_HIDE: c.hide.filter((h) => h !== path.join(c.data, "secret")).join(":")
  }
  const run = (kind: Kind, args: ReadonlyArray<string>, o: {
    as: "root" | "arena"
    isolate: boolean
    home: string
    timeoutMs: number
    graceMs?: number
    env?: Record<string, string>
  }) => {
    const opts: RunOptions = {
      kind,
      argv: [c.node, script, ...args],
      env: childEnv(c, o.home, { ...base, ...o.env }),
      as: o.as,
      isolate: o.isolate,
      // the intake's job folders: only the intake (and its checker, in its own) works there
      ...(o.isolate ? { hide: [c.paths.intake] } : {}),
      timeoutMs: o.timeoutMs,
      graceMs: o.graceMs ?? 5000,
      stdout: "capture"
    }
    return proc.run(opts).pipe(Effect.flatMap((r) => Effect.try({ try: () => answer(String(args[0]), r), catch: (e) => e as GamesctlFailed })))
  }
  const rootHome = "/root"

  const setup = run("setup", ["setup"], { as: "root", isolate: false, home: rootHome, timeoutMs: 5 * 60_000 }).pipe(
    Effect.flatMap((doc) =>
      plain(doc) && doc.ok === true
        ? Effect.succeed({
          residents: Array.isArray(doc.residents) ? doc.residents.map(String) : [],
          toolchain: typeof doc.toolchain === "string" ? doc.toolchain : null
        })
        : Effect.fail(new GamesctlFailed("setup", "no ok"))
    )
  )

  // as root: only root writes the wasm cache, which the games (as the bots' user) read; compiling runs no bot code
  const warm = run("warm", ["warm"], { as: "root", isolate: true, home: rootHome, timeoutMs: 15 * 60_000, env: { SWU_WASM_CACHE: c.paths.wasmCache } }).pipe(
    Effect.map((doc) => ({
      warmed: plain(doc) && Array.isArray(doc.warmed) ? doc.warmed.length : 0,
      failed: plain(doc) && Array.isArray(doc.failed) ? doc.failed.map((f) => String(plain(f) ? f.name : f)).slice(0, 50) : []
    }))
  )

  const plan = (settledSince: number, placementOnly = false) =>
    run("plan", ["plan", "--arena", c.arena, "--settled-since", String(Math.max(0, Math.floor(settledSince))), "--replay-hours", String(c.replayHours), ...(placementOnly ? ["--placement-only", "1"] : [])], {
      as: "arena", isolate: true, home: c.paths.home, timeoutMs: 30_000
    }).pipe(Effect.flatMap((doc) => Effect.try({ try: () => checkPlan(doc), catch: (e) => e as GamesctlFailed })))

  const round = (k: number, games: number, capMs: number, placement = false) =>
    run("round", ["round", "--arena", c.arena, "--round", String(k), "--games", String(games), "--cap-ms", String(capMs), ...(placement ? ["--placement", "1"] : [])], {
      as: "root", isolate: true, home: rootHome, timeoutMs: 10 * 60_000, env: { GAMES_BUNDLES: c.paths.bundles }
    }).pipe(Effect.flatMap((doc) => Effect.try({ try: () => checkRound(k, doc, c.arena === "v2" ? 2 : undefined, c.context), catch: (e) => e as GamesctlFailed })))

  const publish = (k: number) =>
    run("publish", ["publish", "--arena", c.arena, "--round", String(k)], { as: "root", isolate: true, home: rootHome, timeoutMs: 2 * 60_000 }).pipe(
      Effect.flatMap((doc) => (plain(doc) && doc.ok === true ? Effect.void : Effect.fail(new GamesctlFailed("publish", "no ok"))))
    )

  const verifyRound: NonNullable<GamesctlService["verifyRound"]> = (spec) =>
    run("round", ["verify-round", "--arena", c.arena, "--round", String(spec.round), "--bots", spec.bots.join(",")], {
      as: "root", isolate: true, home: rootHome, timeoutMs: 10 * 60_000, env: { GAMES_BUNDLES: c.paths.bundles }
    }).pipe(Effect.flatMap((doc) => Effect.try({
      try: () => {
        if (!plain(doc) || doc.round !== spec.round || JSON.stringify(doc.bots) !== JSON.stringify(spec.bots)) {
          throw new GamesctlFailed("verify-round", "the verified lineup differs from the frozen round")
        }
        if (c.arena === "v2" && doc.requiredProtocol !== 2) throw new GamesctlFailed("verify-round", "the v2 arena requires explicit protocol 2")
        const why = (c.arena === "v2" ? contextProblem(doc.context, c.context) : null) ?? bundleMapProblem(doc.bundles, spec.bundles)
        if (why) throw new GamesctlFailed("verify-round", why)
      },
      catch: (e) => e as GamesctlFailed
    })))

  const placementState: NonNullable<GamesctlService["placementState"]> = (k, state, error) =>
    run("publish", ["placement-state", "--arena", c.arena, "--round", String(k), "--placement-state", state,
      ...(error ? ["--placement-error", error.slice(0, 300)] : [])], {
      as: "root", isolate: true, home: rootHome, timeoutMs: 2 * 60_000
    }).pipe(Effect.asVoid)

  const decks = (file: string, skip: ReadonlyArray<string>) =>
    run("decks", ["decks", "--file", file, ...(skip.length ? ["--skip", skip.join(",")] : [])], {
      as: "root", isolate: true, home: rootHome, timeoutMs: 5 * 60_000
    }).pipe(Effect.flatMap((doc) => Effect.try({
      try: () => {
        const d = checkDecks(plain(doc) ? { ...doc, deal: "seat" } : doc)
        if (!d) throw new GamesctlFailed("decks", "no deck lists")
        return d
      },
      catch: (e) => e as GamesctlFailed
    })))

  const intake = (proxy: string) =>
    run("intake", ["intake", "--state", path.join(c.paths.server, "intake.json"), "--boot", boot], {
      as: "root", isolate: false, home: rootHome, timeoutMs: 65 * 60_000, graceMs: 8000, env: { SWU_WINDOW: proxy }
    }).pipe(Effect.map((doc): IntakeAnswer => ({
      open: plain(doc) && count(doc.open) ? doc.open : null,
      accepted: plain(doc) && count(doc.accepted) ? doc.accepted : 0,
      error: plain(doc) && typeof doc.error === "string" ? doc.error.slice(0, 300) : null
    })))

  const push = (proxy: string, only: "round" | null) =>
    run("push", ["push", "--arena", c.arena, "--state", path.join(c.paths.tmp, "push", "state.json"), "--boot", boot, ...(only ? ["--only", only] : [])], {
      as: "arena", isolate: true, home: c.paths.home, timeoutMs: 2 * 60_000, graceMs: 2000, env: { SWU_WINDOW: proxy }
    }).pipe(Effect.map((doc) => plain(doc) && doc.ok === true))

  return { setup, warm, plan, round, verifyRound, publish, placementState, decks, intake, push }
}

export class Gamesctl extends Context.Service<Gamesctl, GamesctlService>()("games/Gamesctl") {
  static readonly layer = (c: GamesConfig, proc: ProcService, boot: string) => Layer.succeed(Gamesctl, makeGamesctl(c, proc, boot))
}
