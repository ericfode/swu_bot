/**
 * The helper-lease board: Coord.Remote in this process. Helpers (the games image run on someone's computer, and the
 * window's swarm relay for browser tabs) ask for work through the helper API (HelperApi.ts); the round offers them
 * whole seeds here. The board holds the claims waiting for work, the leases handed out, and their clocks. It checks
 * no game: the round picks what to offer and checks what comes back.
 *
 * A claim is a long poll: the API's request waits until an offer comes or its time passes. An offer goes to the claim
 * that has waited longest and becomes a lease, which is
 * - offered while the claim's answer is being sent: lost ("claim dropped") when that fails or the request goes away;
 * - running once it is sent: lost ("claim dropped") when its first heartbeat, which a helper sends as soon as the lease
 *   arrives, is not in within leaseAckMs (an answer written to a helper that already went away still looks sent);
 *   after that, lost after leaseLostMs without a heartbeat ("no heartbeat"), or past its deadline (the job's gameMs,
 *   30 min when it has none, plus 5 min: "deadline");
 * - done or lost: kept until the round reads it (once), at most leaseKeepMs.
 * A revoked lease is forgotten at once, and so is every lease when a round ends (reset): the helper's next heartbeat
 * or result gets 410. Nothing here touches the scheduler's idle clock, so a helper never keeps the machine up.
 *
 * Bundles are the canonical tars the round already wrote to the bundles folder (`<sha256>.tar`, root's): an offer
 * naming one that is not there answers missing, and a helper may read one only while it holds a lease naming it.
 */
import { randomBytes } from "node:crypto"
import { lstatSync } from "node:fs"
import path from "node:path"
import type { Timing } from "./Config.ts"
import * as Log from "./Log.ts"
import type { LeaseBoard, PlaySeedJob } from "./Types.ts"

export type ClaimAnswer =
  | { readonly lease: string; readonly job: PlaySeedJob; readonly bundles: ReadonlyArray<{ readonly id: string; readonly bytes: number }>; readonly deadlineMs: number }
  | "none"
  | "stopping"

export type LeaseOutcome =
  | { readonly results: ReadonlyArray<unknown>; readonly replays: Readonly<Record<string, string>> }
  | { readonly failed: string }

export interface LeaseBoardImpl extends LeaseBoard {
  /** a helper said hello: its name joins the hosts */
  readonly hello: (name: string) => void
  /** the long poll: an offer, "none" after `ms`, or "stopping" once the machine stops */
  readonly awaitClaim: (name: string, slot: string, ms: number, signal: AbortSignal) => Promise<ClaimAnswer>
  /** the claim's answer was written: the lease runs */
  readonly claimSent: (id: string) => void
  /** writing the claim's answer failed: the lease is lost ("claim dropped") */
  readonly claimDropped: (id: string) => void
  /** true when `name` holds lease `id` (offered or running); counts as a heartbeat */
  readonly heartbeat: (id: string, name: string) => boolean
  /** the holder's result; false when it no longer holds the lease */
  readonly result: (id: string, name: string, outcome: LeaseOutcome) => boolean
  /** the tar of bundle `hex` when `name` holds a lease that needs it, else null */
  readonly bundleFile: (name: string, hex: string) => string | null
  /** the lease clocks (the board runs it every sweepMs itself; tests call it) */
  readonly sweep: () => void
  readonly close: () => void
}

export interface LeaseBoardOptions {
  /** the folder of canonical tars, `<sha256>.tar` */
  readonly bundles: string
  readonly timing: Timing
  readonly isStopping: () => boolean
  readonly now?: () => number
}

const HEX64 = /^[0-9a-f]{64}$/
/** a job without a game time limit still gets a deadline */
const NO_GAME_CAP_MS = 30 * 60_000
const DEADLINE_MARGIN_MS = 5 * 60_000
/** a waiting claim looks at the stop flag this often, so it never holds up the machine's stop */
const STOP_LOOK_MS = 1_000

/** How long a lease of this job may run after the claim's answer: gameMs (30 min when 0 or none) + 5 min. */
export const deadlineMs = (job: { readonly gameMs?: unknown }): number =>
  (Number.isSafeInteger(job.gameMs) && (job.gameMs as number) > 0 ? (job.gameMs as number) : NO_GAME_CAP_MS) + DEADLINE_MARGIN_MS

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" })

/** The first n characters as a reader counts them (grapheme clusters), as Elixir's String.slice cut reasons. */
export const firstChars = (s: string, n: number): string => {
  // a string of at most n code units has at most n graphemes
  if (s.length <= n) return s
  let out = ""
  let i = 0
  for (const { segment } of segmenter.segment(s)) {
    if (i++ === n) break
    out += segment
  }
  return out
}

type State = "offered" | "running" | "done" | "lost"

interface Lease {
  readonly id: string
  readonly host: string
  /** kept as Coord.Remote kept it; nothing reads it */
  readonly slot: string
  job: PlaySeedJob | null
  readonly bundles: ReadonlyArray<string>
  state: State
  /** while offered: stops watching the claim's request (Coord.Remote's monitor on the claim's process) */
  unwatch: (() => void) | null
  readonly offeredAt: number
  beatAt: number
  acked: boolean
  readonly deadlineMs: number
  deadlineAt: number
  endedAt: number
  results: ReadonlyArray<unknown> | null
  replays: Readonly<Record<string, string>> | null
  reason: string | null
}

interface Claim {
  readonly name: string
  readonly slot: string
  readonly signal: AbortSignal
  /** answers the claim's request (once) */
  readonly give: (answer: ClaimAnswer) => void
}

const live = (l: Lease) => l.state === "offered" || l.state === "running"

const seedOf = (job: PlaySeedJob): number | "?" => (Number.isSafeInteger(job.seed) ? job.seed : "?")

export const makeLeaseBoard = (opts: LeaseBoardOptions): LeaseBoardImpl => {
  const now = opts.now ?? (() => Math.floor(performance.now()))
  const t = opts.timing
  let waiting: Array<Claim> = []
  const leases = new Map<string, Lease>()
  const hosts = new Set<string>()
  let closed = false

  const tarOf = (hex: string) => path.join(opts.bundles, `${hex}.tar`)

  /** a regular file (not a link) of that name in the bundles folder */
  const hasTar = (hex: string) => {
    if (!HEX64.test(hex)) return false
    try {
      return lstatSync(tarOf(hex)).isFile()
    } catch {
      return false
    }
  }

  const sizeOf = (hex: string) => {
    try {
      return lstatSync(tarOf(hex)).size
    } catch {
      return 0
    }
  }

  const holds = (l: Lease | undefined, name: string): l is Lease => !!l && live(l) && l.host === name

  const unwatch = (l: Lease) => {
    l.unwatch?.()
    l.unwatch = null
  }

  const forget = (id: string) => {
    const l = leases.get(id)
    if (l) unwatch(l)
    leases.delete(id)
  }

  const lose = (l: Lease, reason: string) => {
    unwatch(l)
    Log.info(`lease ${l.id} of ${l.host} lost (${firstChars(reason, 100)})`)
    l.state = "lost"
    l.reason = reason
    l.endedAt = now()
    l.job = null
  }

  const dropClaim = (l: Lease) => {
    if (l.state === "offered") lose(l, "claim dropped")
  }

  const sweep = () => {
    const at = now()
    for (const [id, l] of leases) {
      if (l.state === "running" && !l.acked && at - l.beatAt > t.leaseAckMs) lose(l, "claim dropped")
      else if (live(l) && at - l.beatAt > t.leaseLostMs) lose(l, "no heartbeat")
      else if (live(l) && at > l.deadlineAt) lose(l, "deadline")
      else if (!live(l) && at - l.endedAt > t.leaseKeepMs) forget(id)
    }
  }

  const timer = setInterval(sweep, t.sweepMs)
  // the board never keeps this process alive by itself: the listeners and the scheduler do
  timer.unref()

  const awaitClaim = (name: string, slot: string, ms: number, signal: AbortSignal): Promise<ClaimAnswer> =>
    new Promise((resolve) => {
      if (closed || signal.aborted) return resolve(opts.isStopping() ? "stopping" : "none")
      if (opts.isStopping()) return resolve("stopping")
      hosts.add(name)
      const give = (answer: ClaimAnswer) => {
        clearTimeout(deadline)
        clearInterval(look)
        signal.removeEventListener("abort", gone)
        resolve(answer)
      }
      const claim: Claim = { name, slot, signal, give }
      const leave = (answer: ClaimAnswer) => {
        const i = waiting.indexOf(claim)
        if (i < 0) return
        waiting.splice(i, 1)
        give(answer)
      }
      // the helper went away while waiting: nobody reads the answer
      const gone = () => leave("none")
      const deadline = setTimeout(() => leave(opts.isStopping() ? "stopping" : "none"), ms)
      const look = setInterval(() => {
        if (opts.isStopping()) leave("stopping")
      }, STOP_LOOK_MS)
      signal.addEventListener("abort", gone, { once: true })
      waiting.push(claim)
    })

  const offer: LeaseBoardImpl["offer"] = (job, bundles) => {
    const names = [...new Set(bundles)]
    const missing = names.filter((hex) => !hasTar(hex))
    if (missing.length > 0) return { kind: "missing", missing }
    if (closed || waiting.length === 0 || opts.isStopping()) return { kind: "none" }
    const claim = waiting.shift()!
    const at = now()
    const dl = deadlineMs(job)
    const lease: Lease = {
      id: randomBytes(12).toString("base64url"),
      host: claim.name,
      slot: claim.slot,
      job,
      bundles: names,
      state: "offered",
      unwatch: null,
      offeredAt: at,
      beatAt: at,
      acked: false,
      deadlineMs: dl,
      deadlineAt: at + dl,
      endedAt: 0,
      results: null,
      replays: null,
      reason: null
    }
    leases.set(lease.id, lease)
    const dropped = () => dropClaim(lease)
    claim.signal.addEventListener("abort", dropped, { once: true })
    lease.unwatch = () => claim.signal.removeEventListener("abort", dropped)
    claim.give({ lease: lease.id, job, bundles: names.map((id) => ({ id, bytes: sizeOf(id) })), deadlineMs: dl })
    Log.info(`lease ${lease.id} (seed ${seedOf(job)}) goes to ${claim.name}`)
    return { kind: "leased", lease: lease.id, host: claim.name }
  }

  return {
    hello: (name) => {
      hosts.add(name)
    },
    awaitClaim,
    status: () => ({ waiting: waiting.length, hosts: [...hosts].sort() }),
    offer,
    claimSent: (id) => {
      const l = leases.get(id)
      if (!l || l.state !== "offered") return
      unwatch(l)
      const at = now()
      l.state = "running"
      l.beatAt = at
      l.deadlineAt = at + l.deadlineMs
    },
    claimDropped: (id) => {
      const l = leases.get(id)
      if (l) dropClaim(l)
    },
    heartbeat: (id, name) => {
      const l = leases.get(id)
      if (!holds(l, name)) return false
      l.beatAt = now()
      l.acked = true
      return true
    },
    result: (id, name, outcome) => {
      const l = leases.get(id)
      if (!holds(l, name)) return false
      if ("failed" in outcome) {
        lose(l, outcome.failed)
        return true
      }
      unwatch(l)
      Log.info(`lease ${l.id} done by ${l.host}`)
      l.state = "done"
      l.results = outcome.results
      l.replays = outcome.replays
      l.endedAt = now()
      l.job = null
      return true
    },
    bundleFile: (name, hex) => {
      if (!HEX64.test(hex)) return null
      for (const l of leases.values()) {
        if (holds(l, name) && l.bundles.includes(hex)) return tarOf(hex)
      }
      return null
    },
    lease: (id) => {
      const l = leases.get(id)
      if (!l) return { state: "unknown" }
      if (live(l)) return { state: "running", host: l.host, ageMs: now() - l.offeredAt }
      forget(id)
      return l.state === "done"
        ? { state: "done", host: l.host, results: l.results, replays: l.replays }
        : { state: "lost", host: l.host, reason: l.reason ?? "" }
    },
    revoke: (id) => {
      if (leases.has(id)) Log.info(`lease ${id} taken back`)
      forget(id)
    },
    reset: () => {
      if (leases.size > 0) Log.info(`the round ended: ${leases.size} leases forgotten`)
      for (const id of [...leases.keys()]) forget(id)
    },
    sweep,
    close: () => {
      closed = true
      clearInterval(timer)
      const answer = opts.isStopping() ? "stopping" : "none"
      const left = waiting
      waiting = []
      for (const c of left) c.give(answer)
    }
  }
}
