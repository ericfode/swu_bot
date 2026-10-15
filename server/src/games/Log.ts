/**
 * Log lines in the Elixir coordinator's format, `HH:MM:SS.mmm [level] message` (UTC), on stdout. The helper's live view
 * (bot/arena/ops/helper-tui.js) parses these lines from the container's log, so their shape is part of the helper's
 * contract. Children's stderr is not here: it goes to the same log raw (Proc.ts).
 */
import { Cause, Logger } from "effect"

export type Level = "debug" | "info" | "warning" | "error"

let sink: (line: string) => void = (line) => process.stdout.write(line)

/** Tests catch the lines here. */
export const setSink = (f: (line: string) => void) => {
  sink = f
}

export const stamp = (d: Date = new Date()) => d.toISOString().slice(11, 23)

export const log = (level: Level, message: string) => {
  // one message, one line: a newline inside would start a line the live view reads as another message
  sink(`${stamp()} [${level}] ${message.replace(/\r?\n/g, " | ")}\n`)
}

export const info = (message: string) => log("info", message)
export const warn = (message: string) => log("warning", message)
export const error = (message: string) => log("error", message)

const LEVELS: Record<string, Level> = { Trace: "debug", Debug: "debug", Info: "info", Warn: "warning", Warning: "warning", Error: "error", Fatal: "error" }

/** Effect's log calls (Effect.logInfo, ...) in the same format. */
export const logger = Logger.make<unknown, void>(({ message, logLevel, cause }) => {
  const parts = (Array.isArray(message) ? message : [message]).map((m) => (typeof m === "string" ? m : JSON.stringify(m)))
  const why = cause.reasons.length ? ` (${Cause.pretty(cause).split("\n")[0]})` : ""
  log(LEVELS[logLevel] ?? "info", `${parts.join(" ")}${why}`)
})

export const layer = Logger.layer([logger])
