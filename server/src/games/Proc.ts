/**
 * The one place the games role starts operating-system processes (Coord.Proc). Each child:
 * - gets exactly the environment it is given (built from nothing: no token, no proxy, no Fly variable can leak);
 * - runs in its own process group, so stopping it stops everything it started (TERM, then KILL after a grace);
 * - when this process is root, runs as the bots' user and/or inside isolate.sh's namespaces, as asked;
 * - goes first to the kernel's OOM killer (choom -n 300; the server itself takes -500);
 * - leaves a pidfile, so a server that died without stopping it can stop its group at the next start.
 * Its stderr goes straight to this process's stderr (the machine's log). Its stdout is kept (one JSON line for gamesctl
 * and play-seed) or logged line by line.
 */
import { spawn, execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Context, Effect, Layer } from "effect"
import type { GamesConfig } from "./Config.ts"
import { scripts } from "./Config.ts"
import * as Log from "./Log.ts"

export type Kind = "setup" | "warm" | "plan" | "round" | "publish" | "intake" | "push" | "play" | "decks"

export interface RunOptions {
  readonly kind: Kind
  /** argv[0] is a path or a name looked up in the child's PATH */
  readonly argv: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  /** arena: the bots' user (no capabilities, no way to gain any) */
  readonly as: "root" | "arena"
  /** inside isolate.sh's PID and mount namespaces, with the hidden paths covered and its own /tmp */
  readonly isolate: boolean
  /** isolate.sh --tmp (default <data>/tmp/<kind>) */
  readonly tmp?: string
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly graceMs?: number
  readonly stdout: "capture" | "log"
  readonly maxStdout?: number
}

export type Result =
  | { readonly kind: "exit"; readonly code: number; readonly stdout: string }
  | { readonly kind: "timeout"; readonly stdout: string }
  | { readonly kind: "stopped"; readonly reason: string; readonly stdout: string }

export const lastLine = (stdout: string) => stdout.trim().split("\n").at(-1) ?? ""

/** Names a child's environment must never carry (a proxied window address is allowed: it holds no token). */
const FORBIDDEN = /TOKEN|PROXY|FLY|COOKIE|RELEASE|SECRET/i

const BASE_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

/**
 * A child's environment: PATH (node's folder first), LANG, TZ, HOME, and `extra`. No NODE_ENV unless given: with
 * NODE_ENV=production the engine words its prompts differently (replays would differ from every round so far) and
 * logs every rollback a searching bot makes.
 */
export const childEnv = (c: GamesConfig, home: string, extra: Readonly<Record<string, string>> = {}) => {
  const nodeDir = path.dirname(c.node)
  const env: Record<string, string> = {
    PATH: BASE_PATH.split(":").includes(nodeDir) ? BASE_PATH : `${nodeDir}:${BASE_PATH}`,
    LANG: "C.UTF-8",
    TZ: "UTC",
    HOME: home,
    ...(c.cardJson ? { SWU_CARD_JSON: c.cardJson } : {}),
    ...extra
  }
  for (const k of Object.keys(env)) {
    if (k === "SWU_WINDOW" ? !/^http:\/\/127\.0\.0\.1:\d+\/[pi]\/[A-Za-z0-9_-]+$/.test(env[k]!) : FORBIDDEN.test(k)) {
      throw new Error(`a child's environment may not carry ${k}`)
    }
  }
  return env
}

interface Child {
  readonly kind: Kind
  readonly pgid: number
  readonly stop: (reason: string) => void
  readonly exited: Promise<void>
}

const isRoot = () => process.getuid?.() === 0

const findExe = (name: string, envPath: string) => {
  if (name.includes("/")) return existsSync(name) ? name : null
  for (const dir of envPath.split(":")) {
    const f = path.join(dir, name)
    if (existsSync(f)) return f
  }
  return null
}

/** field 22 of /proc/<pid>/stat: the process's start time in ticks since boot (read after the last ")") */
const startTime = (pid: number): string | null => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null
  } catch {
    return null
  }
}

const kernelBoot = (): string | null => {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
  } catch {
    return null
  }
}

const signalGroup = (pgid: number, signal: NodeJS.Signals) => {
  // never this process's own group or init's
  if (pgid <= 1 || pgid === process.pid) return
  try {
    process.kill(-pgid, signal)
  } catch {
    // gone already
  }
}

export interface ProcService {
  readonly run: (opts: RunOptions) => Effect.Effect<Result>
  /** from now on only push children start; the others are refused (stopped "stopping") */
  readonly setStopping: () => void
  readonly isStopping: () => boolean
  /** the kinds running now, one entry per child */
  readonly running: () => ReadonlyArray<Kind>
  /** TERM every child group but `keep`'s, KILL after `graceMs`; resolves when they are gone or the grace is over */
  readonly stopAll: (keep: ReadonlyArray<Kind>, graceMs: number) => Effect.Effect<number>
  /** KILL groups an earlier server left running (same kernel, same start time), then forget every pidfile */
  readonly reapStale: () => void
}

export const makeProc = (c: GamesConfig): ProcService => {
  const children = new Set<Child>()
  let stopping = false
  const root = isRoot()
  const choom = root ? findExe("choom", BASE_PATH) : null
  const ids = (() => {
    if (!root) return null
    try {
      const id = (flag: string) => Number(execFileSync("id", [flag, c.arenaUser], { encoding: "utf8" }).trim())
      return { uid: id("-u"), gid: id("-g") }
    } catch {
      return null
    }
  })()
  const boot = kernelBoot()

  const wrap = (o: RunOptions): Array<string> => {
    if (!root) return [...o.argv]
    if (o.isolate) {
      const tmp = o.tmp ?? path.join(c.paths.tmp, o.kind)
      return [
        "bash", scripts(c).isolate,
        ...(o.as === "arena" ? ["--user", c.arenaUser] : []),
        "--tmp", tmp,
        ...c.hide.flatMap((h) => ["--hide", h]),
        "--", ...o.argv
      ]
    }
    if (o.as === "arena") {
      if (!ids) throw new Error(`no user ${c.arenaUser} to run ${o.kind} as`)
      return [
        "setpriv", `--reuid=${ids.uid}`, `--regid=${ids.gid}`, "--clear-groups",
        "--inh-caps=-all", "--bounding-set=-all", "--no-new-privs", "--", ...o.argv
      ]
    }
    return [...o.argv]
  }

  const pidfile = (pgid: number) => path.join(c.paths.procs, `${pgid}.json`)

  const start = (o: RunOptions, done: (r: Result) => void): Child | null => {
    if (stopping && o.kind !== "push") {
      done({ kind: "stopped", reason: "stopping", stdout: "" })
      return null
    }
    let argv: Array<string>
    try {
      argv = [...(choom ? [choom, "-n", "300", "--"] : []), ...wrap(o)]
    } catch (e) {
      Log.error(`[${o.kind}] could not start: ${(e as Error).message}`)
      done({ kind: "stopped", reason: `could not start (${(e as Error).message})`, stdout: "" })
      return null
    }
    const exe = findExe(argv[0]!, o.env.PATH ?? BASE_PATH)
    if (!exe) {
      Log.error(`[${o.kind}] could not start ${argv[0]}: not found`)
      done({ kind: "stopped", reason: `could not start ${argv[0]}`, stdout: "" })
      return null
    }
    const proc = spawn(exe, argv.slice(1), {
      cwd: o.cwd ?? c.app,
      env: { ...o.env },
      detached: true,
      stdio: ["ignore", "pipe", "inherit"]
    })
    const pgid = proc.pid
    if (pgid === undefined) {
      done({ kind: "stopped", reason: "could not start", stdout: "" })
      return null
    }
    try {
      mkdirSync(c.paths.procs, { recursive: true })
      writeFileSync(pidfile(pgid), JSON.stringify({ kind: o.kind, pgid, start: startTime(pgid), kernel_boot: boot }))
    } catch {
      Log.warn(`[${o.kind}] no pidfile for group ${pgid}`)
    }
    const max = o.maxStdout ?? 1 << 20
    let out = ""
    let partial = ""
    proc.stdout!.setEncoding("utf8")
    proc.stdout!.on("data", (chunk: string) => {
      if (o.stdout === "capture") {
        if (out.length < max) out += chunk.slice(0, max - out.length)
      } else {
        partial += chunk
        const lines = partial.split("\n")
        partial = lines.pop() ?? ""
        if (partial.length > 65536) {
          lines.push(partial)
          partial = ""
        }
        for (const l of lines) if (l) Log.info(`[${o.kind}] ${l}`)
      }
    })
    let reason: string | null = null
    let killTimer: NodeJS.Timeout | null = null
    const stop = (why: string) => {
      if (reason !== null) return
      reason = why
      signalGroup(pgid, "SIGTERM")
      killTimer = setTimeout(() => signalGroup(pgid, "SIGKILL"), o.graceMs ?? 5000)
    }
    const timer = o.timeoutMs === undefined ? null : setTimeout(() => {
      Log.warn(`[${o.kind}] still running after ${o.timeoutMs} ms: stopping its group`)
      stop("timeout")
    }, o.timeoutMs)
    let resolveExit: () => void = () => {}
    const exited = new Promise<void>((r) => (resolveExit = r))
    let finished = false
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return
      finished = true
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      // whatever it left running in its group goes with it
      signalGroup(pgid, "SIGKILL")
      rmSync(pidfile(pgid), { force: true })
      children.delete(child)
      if (o.stdout === "log" && partial) Log.info(`[${o.kind}] ${partial}`)
      const r: Result = reason === "timeout"
        ? { kind: "timeout", stdout: out }
        : reason !== null
        ? { kind: "stopped", reason, stdout: out }
        : code === null
        ? { kind: "stopped", reason: `killed by ${signal}`, stdout: out }
        : { kind: "exit", code, stdout: out }
      resolveExit()
      done(r)
    }
    proc.on("error", (e) => {
      Log.error(`[${o.kind}] could not start ${argv[0]}: ${e.message}`)
      finish(null, null)
    })
    // 'close' comes once the process ended and its stdout closed, with the last line read; a grandchild that left the
    // group could hold stdout open, so 2 s after 'exit' it finishes anyway
    proc.on("close", (code, signal) => finish(code, signal))
    proc.on("exit", (code, signal) => {
      setTimeout(() => finish(code, signal), 2000).unref()
    })
    const child: Child = { kind: o.kind, pgid, stop, exited }
    children.add(child)
    return child
  }

  const run = (o: RunOptions) =>
    Effect.callback<Result>((resume) => {
      const child = start(o, (r) => resume(Effect.succeed(r)))
      if (!child) return
      // interrupted: stop the group and wait until it is gone
      return Effect.promise(() => {
        child.stop("interrupted")
        return child.exited
      })
    })

  const stopAll = (keep: ReadonlyArray<Kind>, graceMs: number) =>
    Effect.promise(async () => {
      const going = [...children].filter((ch) => !keep.includes(ch.kind))
      if (going.length) Log.info(`stopping ${going.length} child group${going.length === 1 ? "" : "s"}`)
      for (const ch of going) ch.stop("shutdown")
      await Promise.race([
        Promise.all(going.map((ch) => ch.exited)),
        new Promise((r) => setTimeout(r, graceMs + 2000).unref())
      ])
      return going.length
    })

  const reapStale = () => {
    if (!existsSync(c.paths.procs)) return
    for (const f of readdirSync(c.paths.procs)) {
      const file = path.join(c.paths.procs, f)
      try {
        const p = JSON.parse(readFileSync(file, "utf8")) as { kind?: string; pgid?: number; start?: string; kernel_boot?: string }
        if (typeof p.pgid === "number" && p.kernel_boot === boot && p.start && startTime(p.pgid) === p.start) {
          Log.warn(`killing the ${p.kind} group ${p.pgid}, left over from an earlier run`)
          signalGroup(p.pgid, "SIGKILL")
        }
      } catch {
        // unreadable: forget it
      }
      rmSync(file, { force: true })
    }
  }

  return {
    run,
    setStopping: () => {
      stopping = true
    },
    isStopping: () => stopping,
    running: () => [...children].map((ch) => ch.kind),
    stopAll,
    reapStale
  }
}

export class Proc extends Context.Service<Proc, ProcService>()("games/Proc") {
  static readonly layer = (c: GamesConfig) => Layer.sync(Proc, () => makeProc(c))
}
