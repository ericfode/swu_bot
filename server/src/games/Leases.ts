/**
 * STUB (part B replaces this file): the helper-lease board, Coord.Remote in process.
 */
import type { Timing } from "./Config.ts"
import type { LeaseBoard, PlaySeedJob } from "./Types.ts"

export type ClaimAnswer =
  | { readonly lease: string; readonly job: PlaySeedJob; readonly bundles: ReadonlyArray<{ readonly id: string; readonly bytes: number }>; readonly deadlineMs: number }
  | "none"
  | "stopping"

export type LeaseOutcome =
  | { readonly results: ReadonlyArray<unknown>; readonly replays: Readonly<Record<string, string>> }
  | { readonly failed: string }

export interface LeaseBoardImpl extends LeaseBoard {
  /** a helper said hello: its name joins the hosts */
  readonly hello: (name: string) => void
  /** the long poll: an offer, "none" after `ms`, or "stopping" once the machine stops */
  readonly awaitClaim: (name: string, slot: string, ms: number, signal: AbortSignal) => Promise<ClaimAnswer>
  /** the claim's answer was written: the lease runs */
  readonly claimSent: (id: string) => void
  /** writing the claim's answer failed: the lease is lost ("claim dropped") */
  readonly claimDropped: (id: string) => void
  /** true when `name` holds lease `id` (offered or running); counts as a heartbeat */
  readonly heartbeat: (id: string, name: string) => boolean
  /** the holder's result; false when it no longer holds the lease */
  readonly result: (id: string, name: string, outcome: LeaseOutcome) => boolean
  /** the tar of bundle `hex` when `name` holds a lease that needs it, else null */
  readonly bundleFile: (name: string, hex: string) => string | null
  /** the lease clocks (the board runs it every sweepMs itself; tests call it) */
  readonly sweep: () => void
  readonly close: () => void
}

export interface LeaseBoardOptions {
  /** the folder of canonical tars, `<sha256>.tar` */
  readonly bundles: string
  readonly timing: Timing
  readonly isStopping: () => boolean
  readonly now?: () => number
}

export const makeLeaseBoard = (_opts: LeaseBoardOptions): LeaseBoardImpl => {
  throw new Error("not built yet (part B)")
}
