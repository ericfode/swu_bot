/**
 * STUB (part D replaces this file): one rated round, from its rules to its result files.
 */
import type { Effect } from "effect"
import type { GamesConfig } from "./Config.ts"
import type { GamesctlService } from "./Gamesctl.ts"
import type { ArenaJs } from "./Js.ts"
import type { ProcService } from "./Proc.ts"
import type { StoreService } from "./Store.ts"
import type { LeaseBoard, PlanWhy, WindowSettings } from "./Types.ts"

export interface RoundDeps {
  readonly config: GamesConfig
  readonly store: StoreService
  readonly proc: ProcService
  readonly gamesctl: GamesctlService
  readonly js: ArenaJs
  /** null when the helper node is off */
  readonly board: LeaseBoard | null
  /** the round-seed secret (64 hex) */
  readonly secret: string
  readonly boot: string
  /** Eric's settings now: games at once is read at every dispatch, games per pair and the time limit when a round starts */
  readonly settings: () => WindowSettings
  /** called whenever the round's files changed (the pusher's round pass can follow) */
  readonly onFiles?: () => void
}

export type RoundOutcome =
  | { readonly kind: "done" }
  | { readonly kind: "failed"; readonly why: string }
  | { readonly kind: "stopped" }

/** Plays round k (resuming its finished games) until every game has a result, or it fails or is interrupted. */
export declare const playRound: (deps: RoundDeps, k: number, why: PlanWhy, resume: boolean) => Effect.Effect<RoundOutcome>

/** referee.js roundSeed(secret, 'watch', k) */
export declare const roundSeed: (secret: string, k: number) => number
/** referee.js roundKey(secret, 'watch', k) */
export declare const runKey: (secret: string, k: number) => string
