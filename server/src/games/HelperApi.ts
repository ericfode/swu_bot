/**
 * STUB (part B replaces this file): the helper API on GAMES_HELPER_LISTEN:GAMES_HELPER_PORT, wire-compatible with
 * CoordWeb.HelperAPI.
 */
import type { GamesConfig } from "./Config.ts"
import type { LeaseBoardImpl } from "./Leases.ts"
import type { Secrets } from "./Secrets.ts"

export interface HelperApiOptions {
  readonly config: GamesConfig
  readonly secrets: Secrets
  readonly board: LeaseBoardImpl
  readonly isStopping: () => boolean
}

export interface Listening {
  readonly host: string
  readonly port: number
  readonly close: () => Promise<void>
}

export const startHelperApi = (_opts: HelperApiOptions): Promise<Listening> => {
  throw new Error("not built yet (part B)")
}
