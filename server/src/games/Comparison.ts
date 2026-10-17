/** Trusted comparison boundaries, shared with hosted admission's identity contract. */
import { createRequire } from "node:module"
import type { GameResult, PlaySeedJob, RoundSpec } from "./Types.ts"

export interface ComparisonContext {
  readonly schema: 1
  readonly arenaId: "v2"
  readonly protocol: 2
  readonly engineRevision: string
  readonly runnerRevision: string
}

const identity = createRequire(import.meta.url)("../../../bot/arena/identity.js") as {
  contextFor: (o: { arenaId: string; build: string; cards: string }) => ComparisonContext | null
  contextProblem: (actual: unknown, expected: unknown) => string | null
}
export const contextFor = identity.contextFor
export const contextProblem = identity.contextProblem
const plain = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)
const HEX = /^[0-9a-f]{64}$/

export const bundleMapProblem = (actual: unknown, expected: Readonly<Record<string, string>>): string | null => {
  if (!plain(actual)) return "no verified bundle digests"
  const names = Object.keys(expected).sort()
  if (names.some((n) => !HEX.test(expected[n]!))) return "the current bundle digests are unavailable"
  if (JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(names)) return "the bundle names differ"
  const name = names.find((n) => actual[n] !== expected[n])
  return name ? `the bundle digest differs for ${name}` : null
}

/** Use before dispatch and before resuming a stored/reserved placement, without mutating it on failure. */
export const roundContextProblem = (spec: Pick<RoundSpec, "bots" | "bundles" | "requiredProtocol" | "context">, expected: ComparisonContext | null, bundles?: Readonly<Record<string, string>>): string | null => {
  if (spec.requiredProtocol !== 2) return "the v2 arena requires explicit protocol 2"
  const why = contextProblem(spec.context, expected)
  if (why) return why
  if (!Array.isArray(spec.bots) || !plain(spec.bundles)) return "no frozen round lineup and bundle digests"
  const wanted = Object.fromEntries(spec.bots.map((n) => [n, spec.bundles[n]!]))
  return bundleMapProblem(spec.bundles, wanted) ?? (bundles ? bundleMapProblem(spec.bundles, bundles) : null)
}

export const bundlesForSeats = (bundles: Readonly<Record<string, string>>, seats: { readonly p1: string; readonly p2: string }): Record<string, string> =>
  Object.fromEntries([...new Set([seats.p1, seats.p2])].map((name) => [name, bundles[name]!]))

export const bundlesOfJob = (job: Pick<PlaySeedJob, "bots">): Record<string, string> =>
  Object.fromEntries(Object.entries(job.bots).map(([name, bot]) => [name, bot.kind === "wasm" ? bot.bundle : ""]))

/** Helpers independently validate the frozen job against their own image before fetching or running bots. */
export const jobContextProblem = (job: unknown, expected: ComparisonContext | null): string | null => {
  if (!plain(job) || job.requiredProtocol !== 2) return "the v2 job requires explicit protocol 2"
  const why = contextProblem(job.context, expected)
  if (why) return why
  if (!plain(job.bots) || !Object.keys(job.bots).length) return "the v2 job has no frozen bundles"
  if (Object.values(job.bots).some((bot) => !plain(bot) || bot.kind !== "wasm" || typeof bot.bundle !== "string" || !HEX.test(bot.bundle))) return "the v2 job has invalid frozen bundle digests"
  return null
}

export const comparisonResultProblem = (result: unknown, expected: ComparisonContext | null, bundles: Readonly<Record<string, string>>): string | null => {
  if (!plain(result)) return "no comparison result"
  return contextProblem(result.context, expected) ?? bundleMapProblem(result.bundles, bundles)
}

/** The trusted executor binds image/digest provenance; the submitted bot never attests these fields. */
export const bindComparison = (result: GameResult, replay: string | null | undefined, context: ComparisonContext, bundles: Readonly<Record<string, string>>) => {
  let text = replay ?? null
  if (text !== null) {
    const lines = text.trimEnd().split("\n")
    const end = JSON.parse(lines.at(-1)!)
    if (end?.t !== "end") throw new Error("missing replay end for comparison evidence")
    lines[lines.length - 1] = JSON.stringify({ ...end, context, bundles })
    text = lines.join("\n") + "\n"
  }
  return { result: { ...result, context, bundles }, replay: text }
}

export const comparisonReplayProblem = (text: string | null | undefined, result: unknown, expected: ComparisonContext | null, bundles: Readonly<Record<string, string>>): string | null => {
  if (text == null) return plain(result) && result.outcome === "ERROR" ? null : "missing comparison replay"
  let end: unknown
  try { end = JSON.parse(text.trimEnd().split("\n").at(-1)!) } catch { return "invalid comparison replay end" }
  if (!plain(end) || end.t !== "end") return "missing comparison replay end"
  return comparisonResultProblem(end, expected, bundles)
}

