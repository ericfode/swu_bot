/**
 * The games role's settings, read once from the environment at boot (the Elixir coordinator's config/runtime.exs and
 * config.exs, same names and defaults). A value that does not parse stops the boot (exit 1), as it did there.
 */
import { existsSync, readFileSync } from "node:fs"
import { isIP } from "node:net"
import path from "node:path"

export type Role = "games" | "helper"

export interface GamesConfig {
  readonly role: Role
  /** the volume (GAMES_DATA) */
  readonly data: string
  /** the repo checkout with bot/ and forceteki/ (GAMES_APP) */
  readonly app: string
  /** the node binary children run */
  readonly node: string
  readonly paths: {
    /** the server's own folder (root 0700, hidden from every child): games.db, procs/, settings.json, round_end */
    readonly server: string
    readonly procs: string
    readonly db: string
    readonly secret: string
    readonly arena: string
    readonly results: string
    readonly bundles: string
    readonly work: string
    readonly tmp: string
    readonly home: string
    readonly wasmCache: string
    /** the Elixir coordinator's folder: still hidden from children, read once for its settings and round end */
    readonly oldCoord: string
    /** where the image keeps the browser swarm's files (helper API GET /v1/swarm/<file>) */
    readonly swarm: string
  }
  /** what no child may see (isolate.sh --hide) */
  readonly hide: ReadonlyArray<string>
  readonly port: number
  readonly listen: string
  readonly proxyPort: number
  readonly idleMs: number
  readonly replayHours: number
  readonly roundCapMs: number
  /** defaults that Eric's arena settings override */
  readonly games: number
  readonly workers: number
  readonly thinkCapSec: number
  readonly requireMount: boolean
  /** the window's address, trailing slash trimmed; null only off the machine (tests, rehearsals) */
  readonly window: string | null
  readonly cardJson: string | null
  readonly helperPort: number | null
  readonly helperListen: string
  readonly helperImage: string
  readonly build: string
  readonly cards: string
  /** helper role only */
  readonly helperUrl: string | null
  readonly helperSlots: number
  readonly arenaUser: string
  /** fixed timings (config.exs), here so tests can shorten them */
  readonly timing: Timing
}

export interface Timing {
  readonly tickMs: number
  readonly roundTickMs: number
  readonly settleMs: number
  readonly settingsMs: number
  readonly heartbeatMs: number
  readonly leaseLostMs: number
  readonly leaseAckMs: number
  readonly claimMs: number
  readonly sweepMs: number
  readonly leaseKeepMs: number
  readonly bundlesLimit: number
  readonly helloRetryMs: number
  readonly claimBackoffMs: ReadonlyArray<number>
  /** a round's lane looks at claims and leases this often (remote-lane.js TICK_MS) */
  readonly laneTickMs: number
  /** the round files and publish while a round plays (referee.js: 30 s) */
  readonly publishMs: number
}

export const TIMING: Timing = {
  tickMs: 20_000,
  roundTickMs: 3_000,
  settleMs: 90_000,
  settingsMs: 60_000,
  heartbeatMs: 30_000,
  leaseLostMs: 90_000,
  leaseAckMs: 15_000,
  claimMs: 25_000,
  sweepMs: 5_000,
  leaseKeepMs: 30 * 60_000,
  bundlesLimit: 512 * 1024 * 1024,
  helloRetryMs: 30_000,
  claimBackoffMs: [5_000, 10_000, 20_000, 40_000, 60_000],
  laneTickMs: 2_000,
  publishMs: 30_000
}

export class ConfigError extends Error {}

const BUILD_ID = /^[\w.-]{1,128}$/

/** `GAMES_BUILD` when set, else the image's file (BUILD_SHA, CARDS_SHA) when it holds a usable id, else "unknown". */
const identity = (value: string | undefined, file: string): string => {
  if (value) {
    if (!BUILD_ID.test(value)) throw new ConfigError(`${file} override is not an id`)
    return value
  }
  try {
    const text = readFileSync(file, "utf8").trim()
    return BUILD_ID.test(text) ? text : "unknown"
  } catch {
    return "unknown"
  }
}

const int = (env: NodeJS.ProcessEnv, name: string, dflt: number): number => {
  const v = env[name]
  if (v === undefined || v === "") return dflt
  if (!/^-?\d+$/.test(v)) throw new ConfigError(`${name} must be a whole number`)
  return Number(v)
}

/** which node children run: this process's own binary (the image has one node) */
const nodeBinary = () => process.execPath

export const readConfig = (env: NodeJS.ProcessEnv = process.env, timing: Timing = TIMING): GamesConfig => {
  const role: Role = env.COORD_ROLE === "helper" ? "helper" : "games"
  const data = path.resolve(env.GAMES_DATA || "/data")
  const app = path.resolve(env.GAMES_APP || "/app")
  const server = path.join(data, "server")
  const roundHours = env.GAMES_ROUND_HOURS === undefined || env.GAMES_ROUND_HOURS === "" ? 6 : Number(env.GAMES_ROUND_HOURS)
  if (!Number.isFinite(roundHours) || roundHours <= 0) throw new ConfigError("GAMES_ROUND_HOURS must be a number above 0")
  const listen = env.GAMES_LISTEN || "::"
  if (!isIP(listen)) throw new ConfigError("GAMES_LISTEN must be an IP address")
  const window = (env.SWU_WINDOW || "").replace(/\/+$/, "") || null
  const helperPort = env.GAMES_HELPER_PORT ? int(env, "GAMES_HELPER_PORT", 0) : null
  if (helperPort !== null && (helperPort < 1 || helperPort > 65535)) throw new ConfigError("GAMES_HELPER_PORT is not a port")
  const helperListen = env.GAMES_HELPER_LISTEN || env.FLY_PRIVATE_IP || "::"
  if (!isIP(helperListen)) throw new ConfigError("GAMES_HELPER_LISTEN must be an IP address")
  let helperUrl: string | null = null
  let helperSlots = 1
  if (role === "helper") {
    helperUrl = (env.GAMES_HELPER_URL || "").replace(/\/+$/, "")
    if (!/^https?:\/\/[^/]+$/.test(helperUrl)) throw new ConfigError("GAMES_HELPER_URL must be http(s)://host[:port]")
    helperSlots = int(env, "GAMES_HELPER_SLOTS", 1)
    if (helperSlots < 1 || helperSlots > 16) throw new ConfigError("GAMES_HELPER_SLOTS must be 1 to 16")
  }
  const hideExtra = (env.GAMES_HIDE || "").split(":").filter(Boolean)
  return {
    role,
    data,
    app,
    node: nodeBinary(),
    paths: {
      server,
      procs: path.join(server, "procs"),
      db: path.join(server, "games.db"),
      secret: path.join(data, "secret"),
      arena: path.join(data, "arena"),
      results: path.join(data, "results"),
      bundles: path.join(data, "bundles"),
      work: path.join(data, "work"),
      tmp: path.join(data, "tmp"),
      home: path.join(data, "home"),
      wasmCache: path.join(data, "wasm-cache"),
      oldCoord: path.join(data, "coord"),
      swarm: path.join(app, "build", "swarm")
    },
    hide: ["/.fly", path.join(data, "secret"), server, path.join(data, "coord"), ...hideExtra],
    port: int(env, "PORT", 8080),
    listen,
    proxyPort: int(env, "GAMES_PROXY_PORT", 8081),
    idleMs: int(env, "GAMES_IDLE_MIN", 10) * 60_000,
    replayHours: int(env, "GAMES_REPLAY_HOURS", 24),
    roundCapMs: Math.round(roundHours * 3_600_000),
    games: int(env, "GAMES_GAMES", 2),
    workers: int(env, "GAMES_WORKERS", 2),
    thinkCapSec: int(env, "GAMES_THINK_CAP_SEC", 60),
    requireMount: env.GAMES_REQUIRE_MOUNT === "1",
    window,
    cardJson: env.SWU_CARD_JSON || null,
    helperPort,
    helperListen,
    helperImage: env.GAMES_HELPER_IMAGE || "registry.fly.io/swu-arena-games",
    build: identity(env.GAMES_BUILD, path.join(app, "BUILD_SHA")),
    cards: identity(env.GAMES_CARDS, path.join(app, "CARDS_SHA")),
    helperUrl,
    helperSlots,
    arenaUser: env.ARENA_USER || "arena",
    timing
  }
}

/** The game player and the gamesctl entry point in the checkout. */
export const scripts = (c: GamesConfig) => ({
  gamesctl: path.join(c.app, "bot", "arena", "gamesctl.js"),
  playSeed: path.join(c.app, "bot", "arena", "play-seed.js"),
  isolate: path.join(c.app, "bot", "arena", "ops", "isolate.sh")
})

/** True when the image has the swarm's files (helper API answers 404 for all of them otherwise). */
export const hasSwarm = (c: GamesConfig) => existsSync(path.join(c.paths.swarm, "manifest.json"))
