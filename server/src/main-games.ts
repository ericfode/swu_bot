/**
 * The games machine's server (it replaces the Elixir coordinator, `/app/coord/bin/coord start`):
 *
 *   node src/main-games.ts [start]    the role COORD_ROLE names: games (the default: rounds, intake, pushes, the
 *                                     helper API) or helper (plays leased seeds for the games machine)
 *   node src/main-games.ts replay ... the done-check: plays a recorded round again from its seeds and compares
 *
 * Exit codes: 0 stopped (SIGTERM, idle), 1 a fatal problem (bad settings, no volume, no token, setup failed),
 * 2 usage; the helper also 3 when the machine runs another build. Logs are `HH:MM:SS.mmm [level] message` lines.
 */
import { Effect } from "effect"
import { readConfig } from "./games/Config.ts"
import { runHelper } from "./games/Helper.ts"
import * as Log from "./games/Log.ts"
import { startMachine } from "./games/Machine.ts"
import { makeProc } from "./games/Proc.ts"
import { runReplay } from "./games/Replay.ts"
import { takeSecrets } from "./games/Secrets.ts"

const USAGE = "usage: node src/main-games.ts [start]\n" +
  "       node src/main-games.ts replay --results <arena-rK folder> --bundles <dir> --names <file> --out <dir> [--only a,b] [--decks-dir <dir>]\n"

/** after a crash the orderly stop gets this long before the process ends anyway (Fly kills at 30 s) */
const CRASH_STOP_MS = 25_000

const main = async (argv: ReadonlyArray<string>): Promise<number> => {
  const [command = "start", ...rest] = argv
  if (command === "replay") return Effect.runPromise(runReplay(rest).pipe(Effect.provide(Log.layer)))
  if (command !== "start" || rest.length > 0) {
    process.stderr.write(USAGE)
    return 2
  }

  let c
  try {
    c = readConfig(process.env)
  } catch (e) {
    Log.error((e as Error).message)
    return 1
  }

  if (c.role === "helper") {
    const secrets = takeSecrets(process.env, Log.warn)
    const proc = makeProc(c)
    const stop = new AbortController()
    // the signal's name is the reason: runHelper logs "SIGTERM received - shutting down", which helper-tui.js reads
    process.once("SIGTERM", () => stop.abort("SIGTERM"))
    process.once("SIGINT", () => stop.abort("SIGINT"))
    return runHelper(c, secrets, proc, { signal: stop.signal })
  }

  let machine
  try {
    machine = await startMachine({ config: c })
  } catch (e) {
    Log.error((e as Error).message)
    return 1
  }
  const m = machine
  // Fly stops the machine with SIGTERM (a deploy, `fly machine stop`): an orderly stop, exit 0
  process.on("SIGTERM", () => void m.stop(0))
  process.on("SIGINT", () => void m.stop(0))
  const crashed = (e: unknown) => {
    Log.error(`crashed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
    setTimeout(() => process.exit(1), CRASH_STOP_MS).unref()
    void m.stop(1)
  }
  process.on("uncaughtException", crashed)
  process.on("unhandledRejection", crashed)
  return m.done
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    Log.error(`crashed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
    process.exit(1)
  }
)
