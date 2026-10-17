/**
 * The arena's pure JavaScript the games role calls in this process, so pairing, deals, game keys, the ladder summary
 * and the checks on a helper's games stay the very code every round so far used. None of these modules does I/O when
 * loaded or called (bot/ladder.js is not among them: loading it starts a ladder).
 */
import { createRequire } from "node:module"
import path from "node:path"
import type { DeckList, GameResult, RemoteStats } from "./Types.ts"

export interface ArenaJs {
  /** ratings.js: every pair a<b in order, perPair games (made even), seat-swapped on consecutive seeds */
  readonly roundRobin: (names: ReadonlyArray<string>, perPair: number, firstSeed: number) => Array<{ seed: number; p1: string; p2: string }>
  /** decklists.js: adds decks [i, j] to each game */
  readonly dealDecks: (
    schedule: ReadonlyArray<{ seed: number; p1: string; p2: string }>,
    nDecks: number,
    firstSeed: number,
    opts: { by: "bot" | "seat" }
  ) => Array<{ seed: number; p1: string; p2: string; decks: [number, number] }>
  /** rng.js: the seed's game key from the run key */
  readonly gameKey: (key: string, seed: number) => string
  /** ladder-report.js: the swu-ladder/1 document */
  readonly summarize: (doc: {
    id: string
    createdAt: string
    status: string
    engine: string | null
    config: Record<string, unknown>
    botInfo: Record<string, unknown>
    games: ReadonlyArray<Record<string, unknown>>
    scheduled: number
  }) => Record<string, unknown>
  /** remote-lane.js: null, or what is wrong with a helper's answer for a seed's games */
  readonly checkDone: (
    games: ReadonlyArray<{ id: string; p1: string; p2: string; decks?: readonly [number, number] }>,
    answer: unknown,
    opts: { seed: number; key: string | null; decks: ReadonlyArray<DeckList> | null }
  ) => string | null
}

export const loadArenaJs = (app: string): ArenaJs => {
  const require = createRequire(path.join(app, "bot", "package.json"))
  const ratings = require(path.join(app, "bot", "ratings.js"))
  const decklists = require(path.join(app, "bot", "decklists.js"))
  const rng = require(path.join(app, "bot", "rng.js"))
  const report = require(path.join(app, "bot", "ladder-report.js"))
  const lane = require(path.join(app, "bot", "remote-lane.js"))
  return {
    roundRobin: ratings.roundRobin,
    dealDecks: decklists.dealDecks,
    gameKey: rng.gameKey,
    summarize: report.summarize,
    checkDone: lane.checkDone
  }
}

/** remote-lane.js cleanResult (not exported there): the fields of a helper's result that the round keeps. */
export const cleanResult = (r: Record<string, any>): GameResult => ({
  seed: r.seed, outcome: r.outcome, by: r.by ?? null, faultKind: r.faultKind ?? null, winner: r.winner ?? null, winnerSeat: r.winnerSeat ?? null,
  round: r.round, steps: r.steps, ms: r.ms, error: r.error == null ? null : String(r.error).slice(0, 500), timing: r.timing ?? null,
  think: r.think ?? null, botStats: r.botStats ?? null, ...(r.key ? { key: r.key } : {}), ...(r.versions ? { versions: r.versions } : {}),
  ...(r.requiredProtocol === 2 ? { requiredProtocol: 2 as const } : {}), ...(r.protocols ? { protocols: r.protocols } : {}),
  ...(r.context ? { context: r.context } : {}), ...(r.bundles ? { bundles: r.bundles } : {})
})

export type { RemoteStats }
