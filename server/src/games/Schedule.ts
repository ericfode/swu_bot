/**
 * A round's seeds, keys, schedule and play-seed jobs: what referee.js, ladder.js and remote-lane.js computed, here once
 * for the round, the local executor, the lease lane and the replay check. The pairing and the deal are the arena's own
 * JavaScript (Js.ts), so a schedule here is the schedule every round so far played.
 */
import { createHash } from "node:crypto"
import type { ArenaJs } from "./Js.ts"
import type { BotRef, Limits, PlaySeedJob, RoundSpec, ScheduledGame } from "./Types.ts"
import { MAX_PLACEMENT_EXCLUDED_SEEDS } from "./Types.ts"

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")

/** referee.js roundSeed(secret, 'watch', k): round k's first seed */
export const roundSeed = (secret: string, k: number): number => parseInt(sha256(`${secret}:watch:${k}`).slice(0, 8), 16)

const uint32 = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 0xffffffff

/** The attempted seeds of this immutable pair, canonicalized by the root metadata reader. */
export const validPlacementSeeds = (seeds: unknown): seeds is ReadonlyArray<number> => {
  if (!Array.isArray(seeds) || seeds.length > MAX_PLACEMENT_EXCLUDED_SEEDS) return false
  for (let i = 0; i < seeds.length; i++) if (!uint32(seeds[i]) || (i > 0 && seeds[i - 1] >= seeds[i])) return false
  return true
}

/** Pick a fresh seed deterministically; the exclusion bound guarantees the uint32 space cannot be exhausted. */
export const choosePlacementSeed = (firstSeed: number, excludedSeeds: ReadonlyArray<number>): number => {
  if (!uint32(firstSeed) || !validPlacementSeeds(excludedSeeds)) throw new Error("invalid adaptive placement seeds")
  const excluded = new Set(excludedSeeds)
  let seed = firstSeed
  while (excluded.has(seed)) seed = (seed + 1) >>> 0
  return seed
}

/** referee.js roundKey(secret, 'watch', k): round k's run key, the secret every game's deal comes from */
export const runKey = (secret: string, k: number): string => sha256(`${secret}:key:watch:${k}`).slice(0, 32)

/** ladder.js keyId: names a run key without giving it away */
export const keyId = (key: string): string => sha256(key).slice(0, 12)

/** ladder.js game ids */
export const gameId = (g: { readonly seed: number; readonly p1: string; readonly p2: string }) => `${g.p1}-vs-${g.p2}-${g.seed}`

/** ladder.js config.gamesPerPair: games per pair made even (roundRobin plays each seed in both seats) */
export const evenGames = (perPair: number) => perPair + (perPair % 2)

/**
 * The round's games in ladder.js order: roundRobin of the lineup from firstSeed, then the deck lists dealt by seat
 * (`--deal seat`) when the round has them.
 */
export const buildSchedule = (js: ArenaJs, spec: Pick<RoundSpec, "bots" | "gamesPerPair" | "decks" | "placement">, firstSeed: number): ReadonlyArray<ScheduledGame> => {
  const plain = js.roundRobin(spec.bots, spec.gamesPerPair, firstSeed)
  const dealt = spec.decks ? js.dealDecks(plain, spec.decks.lists.length, firstSeed, { by: "seat" }) : plain
  return dealt.filter((g) => !spec.placement || g.p1 === spec.placement.version || g.p2 === spec.placement.version)
    .map((s: { seed: number; p1: string; p2: string; decks?: [number, number] }) => ({
    id: gameId(s),
    seed: s.seed,
    p1: s.p1,
    p2: s.p2,
    ...(s.decks ? { decks: [s.decks[0], s.decks[1]] as const } : {})
  }))
}

/** Every seed's games, in schedule order. */
export const bySeed = (games: ReadonlyArray<ScheduledGame>): Map<number, Array<ScheduledGame>> => {
  const out = new Map<number, Array<ScheduledGame>>()
  for (const g of games) {
    const list = out.get(g.seed)
    if (list) list.push(g)
    else out.set(g.seed, [g])
  }
  return out
}

/**
 * A play-seed job for some games of one seed, exactly as remote-lane.js offer builds it: the seed's game key (never
 * the run key), whole-millisecond gameMs, each bot as a WebAssembly version with its tar, and, in a round of deck lists,
 * only the lists these games use (in first-use order) with the games' indices pointing into them.
 */
export const jobFor = (
  js: ArenaJs,
  spec: Pick<RoundSpec, "bundles" | "decks">,
  key: string | null,
  games: ReadonlyArray<ScheduledGame>,
  limits: Limits
): PlaySeedJob => {
  if (games.length === 0) throw new Error("a job needs at least one game")
  const seed = games[0]!.seed
  if (games.some((g) => g.seed !== seed)) throw new Error("a job plays the games of one seed")
  const bots: Record<string, BotRef> = {}
  for (const g of games) {
    for (const n of [g.p1, g.p2]) {
      const hex = spec.bundles[n]
      if (!hex) throw new Error(`${n} has no bundle`)
      bots[n] = { kind: "wasm", bundle: hex }
    }
  }
  const base = {
    v: 1 as const,
    seed,
    key: key === null ? null : js.gameKey(key, seed),
    maxSteps: limits.maxSteps,
    capMs: limits.capMs,
    hangMs: limits.hangMs,
    gameMs: Math.round(limits.gameMs)
  }
  if (!spec.decks || !games.some((g) => g.decks)) {
    return { ...base, games: games.map((g) => ({ id: g.id, p1: g.p1, p2: g.p2 })), bots }
  }
  const lists = spec.decks.lists
  const used = [...new Set(games.flatMap((g) => g.decks ?? []))]
  return {
    ...base,
    games: games.map((g) => ({ id: g.id, p1: g.p1, p2: g.p2, decks: [used.indexOf(g.decks![0]), used.indexOf(g.decks![1])] as const })),
    bots,
    decks: used.map((i) => lists[i]!)
  }
}
