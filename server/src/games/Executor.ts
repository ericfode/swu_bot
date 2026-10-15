/**
 * STUB (part D replaces this file): plays one job here with play-seed.js, as the bots' user, in a work folder whose
 * output the server reads without following links.
 */
import type { Effect } from "effect"
import type { GamesConfig } from "./Config.ts"
import type { ProcService } from "./Proc.ts"
import type { PlaySeedJob, Played } from "./Types.ts"

export class PlayFailed extends Error {
  readonly seed: number
  readonly why: string
  readonly stopped: boolean
  constructor(seed: number, why: string, stopped = false) {
    super(`seed ${seed}: ${why}`)
    this.seed = seed
    this.why = why
    this.stopped = stopped
  }
}

export declare const playLocal: (c: GamesConfig, proc: ProcService, job: PlaySeedJob, tag: string) => Effect.Effect<Played, PlayFailed>
