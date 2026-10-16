/**
 * The games machine: boot, the parts in their order, and the stop (Coord.Application, Coord.Boot, Coord.Shutdown).
 *
 * Boot: the volume check (GAMES_REQUIRE_MOUNT=1), the server's own folder (root 0700, hidden from every child), the
 * server's OOM score, the secrets out of the environment, a boot id, games.db, the child groups an earlier run left
 * behind, then in order: the window proxy, the pusher (idle until setup pokes it), the settings poll, the lease board
 * and the helper API (only with GAMES_HELPER_PORT and at least one helper token), the scheduler (setup, warm, ticks),
 * the compactor (gzips older rounds' replays), and last the wake and health endpoint. A problem before the parts run is
 * fatal (exit 1).
 *
 * Stop (SIGTERM, an idle stop, a failed setup), within Fly's 30 s: the wake endpoint closes; a compaction pass stops
 * after the replay it is gzipping; from then on only pushes
 * may start; every child group but a push gets TERM and KILL 8 s later, and the round, an intake pass and a plan are
 * interrupted (a round cut so is not an attempt: the next boot resumes it at once); the helpers' leases are forgotten
 * and the helper API closes (a waiting claim answers 503); the settings poll stops; the pusher stops its push and
 * makes one last full push, so the window sees the cut round's last state; the proxy closes, then games.db.
 */
import { randomBytes } from "node:crypto"
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { makeCompactor } from "./Compact.ts"
import type { Compactor } from "./Compact.ts"
import type { GamesConfig } from "./Config.ts"
import { makeGamesctl } from "./Gamesctl.ts"
import { startHelperApi } from "./HelperApi.ts"
import type { Lineup, Listening } from "./HelperApi.ts"
import type { ArenaJs } from "./Js.ts"
import { loadArenaJs } from "./Js.ts"
import { makeLeaseBoard } from "./Leases.ts"
import type { LeaseBoardImpl } from "./Leases.ts"
import * as Log from "./Log.ts"
import { startOpsHttp } from "./OpsHttp.ts"
import type { OpsHttp } from "./OpsHttp.ts"
import { makeProc } from "./Proc.ts"
import type { ProcService } from "./Proc.ts"
import { makePusher } from "./Pusher.ts"
import type { Pusher } from "./Pusher.ts"
import { playRound } from "./Round.ts"
import type { RoundDeps, RoundOutcome } from "./Round.ts"
import { makeScheduler } from "./Scheduler.ts"
import type { Scheduler } from "./Scheduler.ts"
import { takeSecrets } from "./Secrets.ts"
import type { Secrets } from "./Secrets.ts"
import { makeSettings } from "./Settings.ts"
import type { SettingsService } from "./Settings.ts"
import { Store } from "./Store.ts"
import type { StoreService } from "./Store.ts"
import type { PlanWhy } from "./Types.ts"
import { startWindowProxy } from "./WindowProxy.ts"
import type { WindowProxy } from "./WindowProxy.ts"

/** A problem at boot: the machine does not start (exit 1). */
export class BootFailed extends Error {}

/** Whether `p` is on another file system than / (a Fly volume is). */
export const mountpoint = (p: string): boolean => {
  try {
    return statSync(p).dev !== statSync("/").dev
  } catch {
    return false
  }
}

const HEX64 = /^[0-9a-f]{64}$/

/** The round-seed secret (gamesctl setup makes it). Never logged, never handed to a child. */
export const readSecret = (c: GamesConfig): string => {
  let text: string
  try {
    text = readFileSync(path.join(c.paths.secret, "arena-secret"), "utf8").trim()
  } catch {
    throw new Error("the round-seed secret cannot be read")
  }
  if (!HEX64.test(text)) throw new Error("the round-seed secret is not 64 hex characters")
  return text
}

// the children start with choom -n 300, so the kernel's OOM killer picks a game or a check before the server
const protectFromOom = () => {
  try {
    writeFileSync("/proc/self/oom_score_adj", "-500")
  } catch (e) {
    Log.info(`could not lower the server's OOM score (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`)
  }
}

/**
 * The first boot after the cut: the intake's state file keeps the results the window did not take (`unsent`), so the
 * old coordinator's is carried over once (its boot id differs, so every submission is read again anyway).
 */
const carryIntakeState = (c: GamesConfig) => {
  const mine = path.join(c.paths.server, "intake.json")
  const old = path.join(c.paths.oldCoord, "intake.json")
  try {
    if (!existsSync(mine) && existsSync(old)) copyFileSync(old, mine)
  } catch (e) {
    Log.warn(`could not carry the old intake state over (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`)
  }
}

export interface MachineOptions {
  readonly config: GamesConfig
  /** the environment the secrets are taken out of (default process.env) */
  readonly env?: NodeJS.ProcessEnv
  /**
   * the real machine: no start without SWU_WINDOW and SWU_WINDOW_TOKEN (default: NODE_ENV=production or
   * GAMES_REQUIRE_MOUNT=1)
   */
  readonly production?: boolean
  /** plays a round (default Round.playRound; tests pass their own) */
  readonly play?: (deps: RoundDeps, k: number, why: PlanWhy, resume: boolean) => Effect.Effect<RoundOutcome>
  /** the wait before a failed round's second attempt (default 30 s) */
  readonly retryMs?: number
}

export interface Machine {
  readonly boot: string
  readonly ports: { readonly ops: number; readonly proxy: number; readonly helper: number | null }
  readonly scheduler: Scheduler
  /** resolves with the exit code once the machine has stopped */
  readonly done: Promise<number>
  /** the orderly stop (SIGTERM: 0); a second call gets the first one's code */
  readonly stop: (code?: number) => Promise<number>
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect.pipe(Effect.provide(Log.layer)))

const within = <A>(p: Promise<A>, ms: number) =>
  Promise.race([p, new Promise<void>((r) => setTimeout(r, ms).unref())])

/**
 * The latest round's lineup for the window's pages that play arena bots in a person's tab (helper API
 * swarm/lineup.json): its versions in roster order, each with the bundle the round wrote; a version without one is left
 * out. Null before the first round.
 */
export const lineupOf = async (store: StoreService): Promise<Lineup | null> => {
  const row = await run(store.lastRound)
  if (!row) return null
  const bundles = row.spec.bundles ?? {}
  const bots: Array<{ name: string; bundle: string }> = []
  for (const name of row.spec.bots ?? []) {
    const bundle = Object.hasOwn(bundles, name) ? bundles[name] : undefined
    if (typeof bundle === "string") bots.push({ name, bundle })
  }
  return { round: row.k, bots }
}

/** Boots the machine; throws BootFailed when it cannot start. */
export const startMachine = async (o: MachineOptions): Promise<Machine> => {
  const c = o.config
  const env = o.env ?? process.env
  const production = o.production ?? (env.NODE_ENV === "production" || c.requireMount)

  if (c.requireMount && !mountpoint(c.data)) throw new BootFailed(`${c.data} is not a mounted volume (GAMES_REQUIRE_MOUNT=1)`)
  try {
    mkdirSync(c.paths.server, { recursive: true })
    chmodSync(c.paths.server, 0o700)
    mkdirSync(c.paths.procs, { recursive: true })
  } catch (e) {
    throw new BootFailed(`cannot make ${c.paths.server} (${(e as Error).message})`)
  }
  protectFromOom()
  const secrets: Secrets = takeSecrets(env, Log.warn)
  if (production && !c.window) throw new BootFailed("SWU_WINDOW is not set")
  if (production && !secrets.windowToken()) throw new BootFailed("SWU_WINDOW_TOKEN is not set")
  const boot = randomBytes(12).toString("base64url")
  carryIntakeState(c)

  let stopping = false
  let rt: ManagedRuntime.ManagedRuntime<Store, unknown> | null = null
  let proxy: WindowProxy | null = null
  let pusher: Pusher | null = null
  let settings: SettingsService | null = null
  let board: LeaseBoardImpl | null = null
  let helperApi: Listening | null = null
  let scheduler: Scheduler | null = null
  let ops: OpsHttp | null = null
  let proc: ProcService | null = null
  let compactor: Compactor | null = null

  const teardown = async () => {
    const step = async (what: string, f: () => Promise<unknown> | unknown, ms: number) => {
      try {
        await within(Promise.resolve().then(f), ms)
      } catch (e) {
        Log.error(`stopping: ${what}: ${(e as Error).message}`)
      }
    }
    await step("the wake endpoint", () => ops?.close(), 1_500)
    await step("the compactor", () => compactor?.stop(), 5_000)
    proc?.setStopping()
    // TERM to every child group but a push, KILL 8 s later; the steps waiting on them are interrupted
    const kill = proc ? run(proc.stopAll(["push"], 8_000)) : Promise.resolve(0)
    await step("the round", () => Promise.all([scheduler?.stop(), kill]), 12_000)
    await step("the lease board", () => {
      board?.reset()
      board?.close()
    }, 1_000)
    await step("the helper API", () => helperApi?.close(), 1_500)
    settings?.close()
    await step("the last push", () => pusher?.stop(), 12_000)
    await step("the window proxy", () => proxy?.close(), 1_500)
    await step("games.db", () => rt?.dispose(), 3_000)
  }

  try {
    const storeRt = ManagedRuntime.make(Store.layerFile(c.paths.db).pipe(Layer.provide(Log.layer)))
    rt = storeRt
    const store: StoreService = await storeRt.runPromise(Effect.service(Store))
    const p = makeProc(c)
    proc = p
    p.reapStale()
    const gamesctl = makeGamesctl(c, p, boot)
    const px = await startWindowProxy({ window: c.window, token: secrets.windowToken, nonces: secrets.nonces, port: c.proxyPort })
    proxy = px
    pusher = makePusher({
      config: c,
      gamesctl,
      proc: p,
      url: () => px.push,
      playing: () => scheduler?.playing() ?? false,
      isStopping: () => stopping
    })
    const s = makeSettings({ config: c, token: secrets.windowToken })
    settings = s
    s.start()
    if (c.helperPort !== null) {
      if (secrets.helpers.length > 0) {
        board = makeLeaseBoard({ bundles: c.paths.bundles, timing: c.timing, isStopping: () => stopping })
        helperApi = await startHelperApi({ config: c, secrets, board, isStopping: () => stopping, lineup: () => lineupOf(store) })
      } else {
        Log.info("helper node off: GAMES_HELPER_PORT is set but GAMES_HELPER_TOKENS has no usable entry")
      }
    }
    // the arena's JavaScript loads when the first round starts: it is not needed before, and a broken checkout then
    // fails that round (and says why) instead of the boot
    let js: ArenaJs | null = null
    const play = (k: number, why: PlanWhy, resume: boolean): Effect.Effect<RoundOutcome> => {
      let deps: RoundDeps
      try {
        js ??= loadArenaJs(c.app)
        deps = { config: c, store, proc: p, gamesctl, js, board, secret: readSecret(c), boot, settings: s.current }
      } catch (e) {
        return Effect.succeed({ kind: "failed", why: (e as Error).message })
      }
      return (o.play ?? playRound)(deps, k, why, resume)
    }
    const pu = pusher
    compactor = makeCompactor({
      config: c,
      token: secrets.windowToken,
      store,
      busy: () => scheduler?.snapshot().round != null,
      isStopping: () => stopping
    })
    const cp = compactor
    scheduler = makeScheduler({
      config: c,
      gamesctl,
      proc: p,
      store,
      settings: s.current,
      pusher: pu,
      intakeUrl: () => px.intake,
      boot,
      play,
      board,
      stop: (code) => void stop(code),
      compactor: cp,
      ...(o.retryMs === undefined ? {} : { retryMs: o.retryMs })
    })
    const sch = scheduler
    ops = await startOpsHttp({ host: c.listen, port: c.port, onWake: () => sch.wake() })
  } catch (e) {
    stopping = true
    await teardown()
    throw e instanceof BootFailed ? e : new BootFailed((e as Error).message)
  }

  let resolveDone: (code: number) => void = () => {}
  const done = new Promise<number>((r) => (resolveDone = r))
  let stopped: Promise<number> | null = null
  const stop = (code = 0): Promise<number> => {
    stopped ??= (async () => {
      stopping = true
      await teardown()
      resolveDone(code)
      return code
    })()
    return stopped
  }

  Log.info(`games machine up (build ${c.build}, cards ${c.cards}${board ? ", helper node on" : ""})`)
  void scheduler.start()
  return {
    boot,
    ports: { ops: ops.port, proxy: proxy.port, helper: helperApi?.port ?? null },
    scheduler,
    done,
    stop
  }
}
