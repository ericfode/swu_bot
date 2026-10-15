/**
 * Eric's arena settings, from the window's admin page (`GET /api/arena-settings`, read with the window token), as
 * Coord.Settings kept them:
 *
 * | Setting | What it changes | Without it |
 * |---|---|---|
 * | gamesPerPair | games each pair plays in a new round (even, 2 to 10) | GAMES_GAMES |
 * | thinkCapSec | each bot's thinking time per game in a new round (10 to 600 s) | GAMES_THINK_CAP_SEC |
 * | workers | games played at once (1 to 16) | GAMES_WORKERS |
 * | roundGapMin | minutes from one round's end to the next round's start (0 to 240) | 0 |
 *
 * It reads them at start and every settingsMs (a minute) and keeps the last answer in `<data>/server/settings.json`,
 * so a boot that cannot reach the window plays by the last settings it had. The first boot after the cut reads the old
 * coordinator's file (`<data>/coord/settings.json`). A value missing or out of range falls back to the default; a
 * setting removed on the window goes back to its default at the next good read. `current()` never blocks.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { GamesConfig } from "./Config.ts"
import * as Log from "./Log.ts"
import type { WindowSettings } from "./Types.ts"
import { request } from "./WindowProxy.ts"

/** a read of the window gives up after this long (Req receive_timeout) */
const READ_MS = 15_000

type Name = keyof WindowSettings

const FIELDS: ReadonlyArray<{ readonly name: Name; readonly ok: (n: number) => boolean }> = [
  { name: "gamesPerPair", ok: (n) => n >= 2 && n <= 10 && n % 2 === 0 },
  { name: "thinkCapSec", ok: (n) => n >= 10 && n <= 600 },
  { name: "workers", ok: (n) => n >= 1 && n <= 16 },
  { name: "roundGapMin", ok: (n) => n >= 0 && n <= 240 }
]

/** The valid settings in the window's map; anything else (a wrong type, out of range, unknown) is dropped. */
export const parseSettings = (x: unknown): Partial<WindowSettings> => {
  const out: { -readonly [K in Name]?: number } = {}
  if (!x || typeof x !== "object" || Array.isArray(x)) return out
  for (const f of FIELDS) {
    const v = (x as Record<string, unknown>)[f.name]
    if (typeof v === "number" && Number.isSafeInteger(v) && f.ok(v)) out[f.name] = v
  }
  return out
}

const same = (a: Partial<WindowSettings>, b: Partial<WindowSettings>) => FIELDS.every((f) => a[f.name] === b[f.name])

/** The settings as the window names them, in the window's order (for the file). */
const toJson = (s: Partial<WindowSettings>) => JSON.stringify(Object.fromEntries(FIELDS.filter((f) => s[f.name] !== undefined).map((f) => [f.name, s[f.name]])))

export interface SettingsOptions {
  readonly config: GamesConfig
  readonly token: () => string | null
  /** default `<data>/server/settings.json` */
  readonly file?: string
  /** the old coordinator's file, read when `file` does not exist yet */
  readonly oldFile?: string
}

export interface SettingsService {
  /** the settings in force, the machine's defaults filled in */
  readonly current: () => WindowSettings
  /** first read at once, then every settingsMs */
  readonly start: () => void
  /** one read of the window now (the timer's work; tests call it) */
  readonly read: () => Promise<void>
  readonly close: () => void
}

const load = (file: string): Partial<WindowSettings> | null => {
  try {
    return parseSettings(JSON.parse(readFileSync(file, "utf8")))
  } catch {
    return null
  }
}

export const makeSettings = (o: SettingsOptions): SettingsService => {
  const c = o.config
  const file = o.file ?? path.join(c.paths.server, "settings.json")
  const oldFile = o.oldFile ?? path.join(c.paths.oldCoord, "settings.json")
  const defaults: WindowSettings = { gamesPerPair: c.games, thinkCapSec: c.thinkCapSec, workers: c.workers, roundGapMin: 0 }
  let failed: string | null = null
  let timer: NodeJS.Timeout | null = null
  let reading = false
  let closed = false

  const keep = (s: Partial<WindowSettings>) => {
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, toJson(s))
      renameSync(tmp, file)
    } catch (e) {
      Log.warn(`arena settings: could not keep them on the volume (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`)
    }
  }

  // the file first, so a boot that cannot reach the window plays by the last settings; on the first boot after the
  // cut that is the old coordinator's, copied at once so it outlives /data/coord
  let settings: Partial<WindowSettings> = (() => {
    const mine = load(file)
    if (mine) return mine
    const old = load(oldFile)
    if (old) keep(old)
    return old ?? {}
  })()

  const current = (): WindowSettings => ({ ...defaults, ...settings })

  const describe = (s: Partial<WindowSettings>) => {
    const x = { ...defaults, ...s }
    return `${x.gamesPerPair} games per pair, ${x.thinkCapSec} s to think per game, ${x.workers} at once, ${x.roundGapMin} min between rounds`
  }

  const fetchSettings = async (): Promise<{ ok: true; map: unknown } | { ok: false; why: string }> => {
    if (!c.window) return { ok: false, why: "no window address (SWU_WINDOW)" }
    const token = o.token()
    let answer
    try {
      answer = await request(c.window, "/api/arena-settings", {
        method: "GET",
        headers: token ? { authorization: `Bearer ${token}` } : {},
        timeoutMs: READ_MS,
        maxBytes: 1 << 20
      })
    } catch (e) {
      return { ok: false, why: `the window did not answer (${(e as Error).message})` }
    }
    if (answer.status === 200) {
      try {
        const doc = JSON.parse(answer.body.toString("utf8"))
        const map = doc?.result?.settings
        if (map && typeof map === "object" && !Array.isArray(map)) return { ok: true, map }
      } catch {
        // as any other answer without settings
      }
    }
    return { ok: false, why: `the window answered ${answer.status}` }
  }

  const read = async () => {
    if (reading || closed) return
    reading = true
    try {
      const r = await fetchSettings()
      if (closed) return
      if (r.ok) {
        if (failed) Log.info("arena settings: the window answers again")
        failed = null
        const next = parseSettings(r.map)
        if (!same(next, settings)) {
          settings = next
          Log.info(`arena settings: ${describe(next)}`)
          keep(next)
        }
      } else {
        // once per kind of failure: the window may be down for a while, and this asks every minute
        if (r.why !== failed) Log.warn(`arena settings: ${r.why}; keeping ${describe(settings)}`)
        failed = r.why
      }
    } finally {
      reading = false
    }
  }

  const loop = () => {
    if (closed) return
    // the next read is set before this one starts, so the cadence holds whatever the window's speed
    timer = setTimeout(loop, c.timing.settingsMs)
    timer.unref()
    void read()
  }

  return {
    current,
    start: loop,
    read,
    close: () => {
      closed = true
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}
