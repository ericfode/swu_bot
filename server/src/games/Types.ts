/**
 * Shapes the games role passes between its parts. Everything that crosses a process boundary (a child's answer, a
 * helper's request) is checked where it comes in; these types describe it once checked.
 */

/** The arena's one rated arena so far (gamesctl.js ARENAS). */
export const ARENA = "open"

/** Eric's arena settings, as the window gives them (`GET /api/arena-settings`), ranges checked. */
export interface WindowSettings {
  /** games per pair in a new round, even, 2..10 */
  readonly gamesPerPair: number
  /** thinking time per bot per game, seconds, 10..600 */
  readonly thinkCapSec: number
  /** games at once on the games machine, 1..16 */
  readonly workers: number
  /** minutes between the end of one round and the start of the next, 0..240 */
  readonly roundGapMin: number
}

export const DEFAULT_WINDOW_SETTINGS: WindowSettings = { gamesPerPair: 2, thinkCapSec: 60, workers: 2, roundGapMin: 0 }

/** Why `gamesctl plan` names a round, or none. */
export type PlanWhy = "changed" | "stale" | "resume" | "placement" | "same" | "settling" | "no-competitor" | "no-opponent" | "?"

export type Plan =
  | { readonly round: number; readonly resume: boolean; readonly why: PlanWhy }
  | { readonly round: null; readonly why: PlanWhy }

/** A deck list in decklists.js normalizeDeck form. Opaque here: only Node reads inside it. */
export type DeckList = { readonly metadata: { readonly name: string } } & Record<string, unknown>

/** The deck lists a round deals (referee.js ROUND_DECKS, ladder.js config.decks), with the lists themselves. */
export interface RoundDecks {
  readonly file: string
  readonly sha256: string
  readonly names: ReadonlyArray<string>
  readonly deal: "seat"
  readonly skipped: ReadonlyArray<string>
  readonly lists: ReadonlyArray<DeckList>
}

/**
 * What `gamesctl round` answers: round K's rules and lineup, as the Node side knows them (roster, versions, decks).
 * Seeds and keys are not in it: they come from the round-seed secret, which only the server reads.
 */
export interface RoundSpec {
  readonly round: number
  /** A bounded placement plays only pairs involving this accepted immutable version. */
  readonly placement?: { readonly version: string; readonly ref: string }
  /** the lineup's versions, in roster order (roundRobin pairs them in this order) */
  readonly bots: ReadonlyArray<string>
  readonly gamesPerPair: number
  /** thinking time per bot per game, ms */
  readonly capMs: number
  readonly decks: RoundDecks | null
  /** each version's canonical tar (bot/compiled/bundle.py tar), by sha256, in the bundles folder */
  readonly bundles: Readonly<Record<string, string>>
  /** registry.js describeBot of each version, less its name (ladder.json bots rows) */
  readonly botInfo: Readonly<Record<string, Record<string, unknown>>>
}

/** A game of a round's schedule: ratings.js roundRobin, decklists.js dealDecks by seat, ladder.js ids. */
export interface ScheduledGame {
  readonly id: string
  readonly seed: number
  readonly p1: string
  readonly p2: string
  /** indices into the round's deck lists, p1's first */
  readonly decks?: readonly [number, number]
}

/** A round's limits (ladder.js and game-pool.js defaults for a capped round). */
export interface Limits {
  readonly maxSteps: number
  readonly capMs: number
  readonly hangMs: number
  readonly gameMs: number
}

export const limitsFor = (capMs: number): Limits => ({
  maxSteps: 6000,
  capMs,
  // the watchdog waits 30 s past the wall cap (guard.js: 2 x cap), so a call the guard allows is never taken for a hang
  hangMs: 2 * capMs + 30000,
  // game-pool.js DEFAULT_GAME_MS
  gameMs: 4 * capMs + 600000
})

export type BotRef = { readonly kind: "wasm"; readonly bundle: string } | { readonly kind: "resident" }

/** A job for `node bot/arena/play-seed.js`: some games of one seed (its header has the exact shape it checks). */
export interface PlaySeedJob {
  readonly v: 1
  readonly seed: number
  /** the seed's game key (rng.js gameKey of the run key), never the run key */
  readonly key: string | null
  readonly maxSteps: number
  readonly capMs: number | null
  readonly hangMs: number
  readonly gameMs: number
  readonly games: ReadonlyArray<{ readonly id: string; readonly p1: string; readonly p2: string; readonly decks?: readonly [number, number] }>
  readonly bots: Readonly<Record<string, BotRef>>
  /** the deck lists the games play (indices in games[].decks point here); all or none */
  readonly decks?: ReadonlyArray<DeckList>
}

/**
 * One game's result as game-pool.js reports it (play-seed.js results[].result), after remote-lane.js cleanResult's
 * fields. Kept as the referee gives it: the result files and the record take it field by field.
 */
export interface GameResult {
  readonly outcome: "won" | "ERROR" | "STEP_CAP" | "STUCK"
  readonly winner?: string | null
  readonly winnerSeat?: "p1" | "p2" | "draw" | null
  readonly by?: "p1" | "p2" | null
  readonly faultKind?: "load" | "error" | "time" | "hang" | null
  readonly round: number
  readonly steps: number
  readonly ms: number
  readonly error?: string | null
  readonly timing?: Record<string, unknown> | null
  readonly think?: { readonly p1: number; readonly p2: number } | null
  readonly botStats?: ReadonlyArray<unknown> | null
  readonly key?: string | null
  readonly versions?: Record<string, unknown>
  readonly seed?: number
}

/** A job's games once played: results by game id, and the replays' text by game id (a game may have none). */
export interface Played {
  readonly results: ReadonlyArray<{ readonly id: string; readonly result: GameResult }>
  readonly replays: Readonly<Record<string, string>>
}

/** Where a game ran: null for the games machine, else the helper's name (`swarm` for browser tabs). */
export type Host = string | null

/**
 * The helper-lease board as the round sees it (Coord.Remote's side of the old relay, in process). The round decides
 * what to offer and checks what comes back; the board keeps claims, leases and their clocks.
 */
export interface LeaseBoard {
  /** claims waiting now, and every helper name that said hello or claimed since this boot */
  readonly status: () => { readonly waiting: number; readonly hosts: ReadonlyArray<string> }
  /**
   * Hands `job` to the oldest waiting claim. `bundles` are the sha256 names of the tars it needs, which must be in the
   * bundles folder. none: no claim waits (or the machine is stopping); missing: these tars are not there.
   */
  readonly offer: (job: PlaySeedJob, bundles: ReadonlyArray<string>) =>
    | { readonly kind: "leased"; readonly lease: string; readonly host: string }
    | { readonly kind: "none" }
    | { readonly kind: "missing"; readonly missing: ReadonlyArray<string> }
  /** A lease's state. done and lost are forgotten once read. */
  readonly lease: (id: string) =>
    | { readonly state: "running"; readonly host: string; readonly ageMs: number }
    | { readonly state: "done"; readonly host: string; readonly results: unknown; readonly replays: unknown }
    | { readonly state: "lost"; readonly host: string; readonly reason: string }
    | { readonly state: "unknown" }
  /** Takes a lease back: forgotten at once, the helper's next heartbeat or result gets 410. */
  readonly revoke: (id: string) => void
  /** The round ended: every lease forgotten (claims keep waiting). */
  readonly reset: () => void
}

/** What a round's ladder.json says about helpers (remote-lane.js stats; referee.js helpersLine reads it). */
export interface RemoteStats {
  readonly lane: true
  readonly hosts: ReadonlyArray<string>
  readonly looks: number
  readonly claimLooks: number
  readonly leased: number
  readonly played: number
  readonly lost: number
  readonly lastLost: string | null
  readonly relayErrors: ReadonlyArray<string>
  readonly stopped: string | null
}
