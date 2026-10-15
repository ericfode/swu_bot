/**
 * STUB (part C replaces this file): the helper role (COORD_ROLE=helper), Coord.Helper in TypeScript.
 */
import type { GamesConfig } from "./Config.ts"
import type { ProcService } from "./Proc.ts"
import type { Secrets } from "./Secrets.ts"

export interface HelperOptions {
  /** aborted on SIGTERM/SIGINT: slots hand their seeds back, then runHelper resolves 0 */
  readonly signal: AbortSignal
}

/** Runs the helper until it stops; resolves its exit code: 0 stopped, 1 refused (401) or broken setup, 3 another build (409). */
export const runHelper = (_c: GamesConfig, _secrets: Secrets, _proc: ProcService, _opts: HelperOptions): Promise<number> => {
  throw new Error("not built yet (part C)")
}
