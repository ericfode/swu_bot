import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { beforeEach, describe, test } from "node:test"
import { Effect } from "effect"
import { readConfig, TIMING } from "../../src/games/Config.ts"
import { GamesctlFailed } from "../../src/games/Gamesctl.ts"
import type { IntakeAnswer } from "../../src/games/Gamesctl.ts"
import { setSink } from "../../src/games/Log.ts"
import type { RoundOutcome } from "../../src/games/Round.ts"
import { afterIntake, idle, intakeDue, makeScheduler, planDue, roundWait } from "../../src/games/Scheduler.ts"
import type { IdleFacts } from "../../src/games/Scheduler.ts"
import type { Plan, WindowSettings } from "../../src/games/Types.ts"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const eventually = async (f: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!f()) {
    if (Date.now() > end) throw new Error("not in time")
    await sleep(10)
  }
}

let logs: Array<string> = []
beforeEach(() => {
  logs = []
  setSink((l) => logs.push(l))
})

// ---- the rules (coord/test/coord/scheduler/policy_test.exs)

describe("policy", () => {
  test("an intake pass is due at tick 0, every third tick and after a wake", () => {
    const due = [...Array(10).keys()].filter((t) => intakeDue("ready", { ticks: t, woken: false }))
    assert.deepEqual(due, [0, 3, 6, 9])
    assert.ok(intakeDue("ready", { ticks: 1, woken: true }))
    assert.ok(intakeDue("ready", { ticks: 2, woken: true }))
  })

  test("while warming too, but never before setup is done", () => {
    assert.ok(intakeDue("warming", { ticks: 0, woken: false }))
    assert.ok(!intakeDue("setup", { ticks: 0, woken: false }))
    assert.ok(!intakeDue("setup", { ticks: 1, woken: true }))
  })

  test("a new round waits out the gap after the last round's end; with no round finished, none", () => {
    assert.equal(roundWait(null, 600_000, 5_000), 0)
    assert.equal(roundWait(1_000, 600_000, 1_000), 600_000)
    assert.equal(roundWait(1_000, 600_000, 500_000), 101_000)
    assert.equal(roundWait(1_000, 600_000, 601_000), 0)
    assert.equal(roundWait(1_000, 0, 1_000), 0)
    // a clock set back never makes the wait longer than the wait itself
    assert.equal(roundWait(900_000, 600_000, 1_000), 600_000)
  })

  test("plan only when ready, with nothing unfinished and no plan running", () => {
    assert.ok(planDue({ phase: "ready", incomplete: [], planning: false }))
    assert.ok(!planDue({ phase: "ready", incomplete: ["intake"], planning: false }))
    assert.ok(!planDue({ phase: "ready", incomplete: ["round"], planning: false }))
    assert.ok(!planDue({ phase: "ready", incomplete: ["intake", "round"], planning: false }))
    assert.ok(!planDue({ phase: "ready", incomplete: [], planning: true }))
    assert.ok(!planDue({ phase: "warming", incomplete: [], planning: false }))
    assert.ok(!planDue({ phase: "setup", incomplete: [], planning: false }))
  })

  const M10 = 600_000
  const base: IdleFacts = { phase: "ready", incomplete: [], planning: false, children: [], busyAt: 0, settledAt: null, idleMs: M10, settleMs: 90_000 }

  test("idle after idleMs with nothing going on", () => {
    assert.ok(idle(base, M10 + 1))
    assert.ok(!idle(base, M10))
    assert.ok(!idle(base, 1_000))
  })

  test("a push may be running, nothing else", () => {
    const now = M10 + 1
    assert.ok(idle({ ...base, children: ["push"] }, now))
    assert.ok(!idle({ ...base, children: ["push", "plan"] }, now))
    assert.ok(!idle({ ...base, children: ["play"] }, now))
    assert.ok(!idle({ ...base, children: ["intake"] }, now))
    assert.ok(!idle({ ...base, children: ["warm"] }, now))
  })

  test("not with a job unfinished or a plan waiting for its answer, nor before the machine is ready", () => {
    const now = M10 + 1
    assert.ok(!idle({ ...base, incomplete: ["round"] }, now))
    assert.ok(!idle({ ...base, incomplete: ["intake"] }, now))
    assert.ok(!idle({ ...base, planning: true }, now))
    assert.ok(!idle({ ...base, phase: "warming" }, now))
    assert.ok(!idle({ ...base, phase: "setup" }, now))
  })

  test("not within 90 s of an accepted version, so its round can start", () => {
    const now = M10 + 1
    assert.ok(!idle({ ...base, settledAt: now - 90_000 }, now))
    assert.ok(idle({ ...base, settledAt: now - 90_001 }, now))
  })

  test("open submissions keep the machine busy; an unknown count does not; an accepted version settles", () => {
    assert.ok(afterIntake(2, 0).busy)
    assert.ok(!afterIntake(0, 0).busy)
    assert.ok(!afterIntake(null, 0).busy)
    assert.ok(afterIntake(0, 1).settled)
    assert.ok(!afterIntake(1, 0).settled)
    assert.ok(!afterIntake(null, 0).settled)
    // after a pass with an unknown count, an otherwise idle machine is still idle
    const change = afterIntake(null, 0)
    assert.ok(idle(change.busy ? { ...base, busyAt: M10 } : base, M10 + 1))
  })
})

// ---- the scheduler (coord/test/coord/scheduler_test.exs, workers/round_test.exs, workers/intake_test.exs)

type Answer<A> = A | GamesctlFailed

interface Harness {
  readonly s: ReturnType<typeof makeScheduler>
  readonly events: Array<string>
  readonly kv: Map<string, string>
  readonly updates: Array<{ k: number; set: Record<string, unknown> }>
  readonly stops: Array<number>
  readonly clock: { mono: number; wall: number }
  readonly plays: Array<string>
  readonly control: {
    setup: Answer<{ residents: Array<string>; toolchain: string | null }>
    warm: Answer<{ warmed: number; failed: Array<string> }>
    plan: Answer<Plan>
    planMs: number
    intake: Answer<IntakeAnswer>
    intakeMs: number
    play: RoundOutcome | "block" | "die"
    playMs: number
  }
  pokes: number
  resets: number
  settings: WindowSettings
  running: Array<string>
}

const harness = (o: { env?: Record<string, string>; timing?: Partial<typeof TIMING>; retryMs?: number; data?: string } = {}): Harness => {
  const data = o.data ?? mkdtempSync(path.join(tmpdir(), "games-scheduler-"))
  const config = readConfig({ GAMES_DATA: data, ...o.env }, { ...TIMING, tickMs: 60_000, ...o.timing })
  const events: Array<string> = []
  const kv = new Map<string, string>()
  const updates: Array<{ k: number; set: Record<string, unknown> }> = []
  const stops: Array<number> = []
  const plays: Array<string> = []
  const clock = { mono: 10_000_000, wall: 1_760_000_000_000 }
  const control: Harness["control"] = {
    setup: { residents: ["house"], toolchain: null },
    warm: { warmed: 2, failed: [] },
    plan: { round: null, why: "same" },
    planMs: 0,
    intake: { open: 0, accepted: 0, error: null },
    intakeMs: 0,
    play: { kind: "done" },
    playMs: 0
  }
  // a step that takes `ms`, answers what `control` says when it ends, and ends at once when interrupted
  const step = <A>(name: string, ms: () => number, answer: () => Answer<A> | "block" | "die") =>
    Effect.callback<A, GamesctlFailed>((resume) => {
      events.push(`start ${name}`)
      const a = answer()
      const timer = a === "block" ? undefined : setTimeout(() => {
        events.push(`end ${name}`)
        if (a === "die") resume(Effect.die(new Error("it broke")))
        else resume(a instanceof GamesctlFailed ? Effect.fail(a) : Effect.succeed(a as A))
      }, ms())
      return Effect.sync(() => {
        clearTimeout(timer)
        events.push(`term ${name}`)
      })
    })
  const h: Harness = {
    events, kv, updates, stops, clock, plays, control,
    pokes: 0,
    resets: 0,
    settings: { gamesPerPair: 2, thinkCapSec: 60, workers: 2, roundGapMin: 0 },
    running: [],
    s: undefined as unknown as Harness["s"]
  }
  ;(h as { s: Harness["s"] }).s = makeScheduler({
    config,
    gamesctl: {
      setup: step("setup", () => 0, () => control.setup),
      warm: step("warm", () => 0, () => control.warm),
      plan: (since) => step<Plan>(`plan --settled-since ${since}`, () => control.planMs, () => control.plan),
      intake: (url) => step<IntakeAnswer>(`intake ${url}`, () => control.intakeMs, () => control.intake)
    },
    proc: { running: () => h.running as any },
    store: {
      get: (n) => Effect.sync(() => kv.get(n) ?? null),
      set: (n, v) => Effect.sync(() => void kv.set(n, v)),
      updateRound: (k, set) => Effect.sync(() => void updates.push({ k, set: { ...set } }))
    },
    settings: () => h.settings,
    pusher: { poke: () => void h.pokes++ },
    intakeUrl: () => "http://127.0.0.1:8081/i/nonce",
    boot: "this-boot",
    play: (k, why, resume) => {
      plays.push(`${k} ${why} ${resume}`)
      return step<RoundOutcome>(`play ${k}`, () => control.playMs, () => control.play).pipe(Effect.orDie)
    },
    board: { reset: () => void h.resets++ },
    stop: (code) => void stops.push(code),
    retryMs: o.retryMs ?? 100,
    now: () => clock.mono,
    wall: () => clock.wall
  })
  return h
}

const ready = async (h: Harness) => {
  await h.s.start()
  await eventually(() => h.s.snapshot().phase === "ready")
}

/** lets the intake pass of tick 0 end, so plans may run */
const settle = async (h: Harness) => eventually(() => h.s.snapshot().incomplete.length === 0 && !h.s.snapshot().planning)

/** ticks (as the 20 s timer would) until `f` holds: a tick that queues an intake pass does not plan */
const tickUntil = async (h: Harness, f: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!f()) {
    if (Date.now() > end) throw new Error("not in time")
    // a plan or an intake pass in flight ends first (a round may go on: it is what some tests wait for)
    await eventually(() => f() || (!h.s.snapshot().planning && !h.s.snapshot().incomplete.includes("intake")))
    if (f()) return
    h.s.tick()
    await sleep(15)
  }
}

const plansStarted = (h: Harness) => h.events.filter((e) => e.startsWith("start plan")).length

test("at boot: setup, then an intake pass at once (tick 0), then warm", async () => {
  const h = harness()
  await ready(h)
  const starts = h.events.filter((e) => e.startsWith("start ")).map((e) => e.split(" ")[1])
  assert.deepEqual(starts.filter((s) => s === "setup" || s === "warm"), ["setup", "warm"])
  assert.ok(h.events.includes("start intake http://127.0.0.1:8081/i/nonce"))
  assert.equal(h.pokes, 1, "setup's end makes the first push")
  assert.ok(logs.some((l) => l.includes("[info] set up; residents house")))
  assert.ok(logs.some((l) => l.includes("[info] warmed 2 bundles")))
  await h.s.stop()
})

test("a failed setup stops the machine with 1, and no intake runs", async () => {
  const h = harness()
  h.control.setup = new GamesctlFailed("setup", "exit 1")
  await h.s.start()
  await eventually(() => h.stops.length === 1)
  assert.deepEqual(h.stops, [1])
  assert.ok(logs.some((l) => l.includes("[error] gamesctl setup failed (exit 1): stopping")))
  await sleep(50)
  assert.ok(!h.events.some((e) => e.startsWith("start intake")))
  await h.s.stop()
})

test("a failed warm is only logged", async () => {
  const h = harness()
  h.control.warm = new GamesctlFailed("warm", "exit 1")
  await ready(h)
  assert.ok(logs.some((l) => l.includes("[warning] gamesctl warm failed (exit 1)")))
  assert.deepEqual(h.stops, [])
  h.control.warm = { warmed: 1, failed: ["a-v1", "b-v2"] }
  const h2 = harness()
  h2.control.warm = { warmed: 1, failed: ["a-v1", "b-v2"] }
  await ready(h2)
  assert.ok(logs.some((l) => l.includes("[warning] could not warm a-v1, b-v2")))
  await h.s.stop()
  await h2.s.stop()
})

test("no plan while an intake pass is unfinished; then the planned round is queued", async () => {
  const h = harness()
  h.control.intakeMs = 300
  h.control.plan = { round: 4, resume: false, why: "changed" }
  h.control.play = "block"
  await ready(h)
  h.s.tick()
  assert.equal(plansStarted(h), 0)
  await settle(h)
  await tickUntil(h, () => h.plays.length === 1)
  assert.deepEqual(h.plays, ["4 changed false"])
  assert.ok(h.events.includes("start plan --settled-since 0"))
  assert.ok(logs.some((l) => l.includes("[info] round 4 of open queued (changed)")))
  assert.ok(h.s.playing())
  await h.s.stop()
})

test("a new round waits out the wait between rounds, keeping the machine awake; a round cut short does not wait", async () => {
  const h = harness()
  h.settings = { ...h.settings, roundGapMin: 1 }
  h.control.plan = { round: 4, resume: false, why: "changed" }
  await ready(h)
  await settle(h)
  // round 3 ended just now (an earlier boot kept it); the machine was last busy an hour ago
  // a finished round sets the round's end
  h.control.play = { kind: "done" }
  h.control.plan = { round: 3, resume: true, why: "resume" }
  await tickUntil(h, () => h.plays.length === 1 && h.s.snapshot().round === null)
  assert.equal(h.s.snapshot().roundEnd, h.clock.wall)
  assert.equal(h.kv.get("round_end"), String(h.clock.wall))

  // its end plans at once (round 3 again, which already ran)
  await settle(h)
  h.clock.mono += 3_600_000
  const busy = h.s.snapshot().busyAt
  h.control.plan = { round: 4, resume: false, why: "changed" }
  await tickUntil(h, () => h.s.snapshot().waiting === 4)
  assert.equal(h.plays.length, 1)
  assert.ok(h.s.snapshot().busyAt > busy, "a waiting round keeps the machine awake")
  assert.ok(logs.some((l) => l.includes("[info] round 4 waits 1 min (the wait between rounds)")))
  // it is said once, not at every tick
  h.s.tick()
  await settle(h)
  assert.equal(logs.filter((l) => l.includes("round 4 waits")).length, 1)

  // the minute is over
  h.clock.wall += 61_000
  h.control.play = "block"
  await tickUntil(h, () => h.plays.length === 2)
  assert.equal(h.plays[1], "4 changed false")
  assert.equal(h.s.snapshot().waiting, null)
  await h.s.stop()

  // a round a stop cut short goes on at once
  const r = harness()
  r.settings = { ...r.settings, roundGapMin: 1 }
  r.kv.set("round_end", String(r.clock.wall))
  r.control.plan = { round: 5, resume: true, why: "resume" }
  r.control.play = "block"
  await ready(r)
  await settle(r)
  await tickUntil(r, () => r.plays.length === 1)
  assert.deepEqual(r.plays, ["5 resume true"])
  await r.s.stop()
})

test("the wait counts from the last round that finished, at an earlier boot too; a failed round does not move it", async () => {
  const h = harness({ retryMs: 50 })
  h.settings = { ...h.settings, roundGapMin: 1 }
  // an earlier boot's round ended just now
  h.kv.set("round_end", String(h.clock.wall))
  h.control.plan = { round: 4, resume: false, why: "changed" }
  await ready(h)
  await settle(h)
  await tickUntil(h, () => h.s.snapshot().waiting === 4)
  assert.equal(h.plays.length, 0)

  // the wait is over; the round fails twice: no new end is kept
  const ended = h.kv.get("round_end")
  h.clock.wall += 61_000
  h.control.play = { kind: "failed", why: "gamesctl round failed (exit 1)" }
  await tickUntil(h, () => h.plays.length === 2 && h.s.snapshot().round === null)
  assert.equal(h.kv.get("round_end"), ended)
  assert.equal(h.s.snapshot().lastRan, 4)

  // the next boot finishes it: its end is kept
  const n = harness()
  n.kv.set("round_end", ended!)
  n.control.plan = { round: 4, resume: true, why: "resume" }
  n.clock.wall = h.clock.wall + 5_000
  await ready(n)
  await settle(n)
  await tickUntil(n, () => n.plays.length === 1 && n.s.snapshot().round === null)
  assert.equal(n.kv.get("round_end"), String(n.clock.wall))
  await h.s.stop()
  await n.s.stop()
})

test("the first boot after the cut reads the old coordinator's round end, and keeps it", async () => {
  const data = mkdtempSync(path.join(tmpdir(), "games-scheduler-"))
  mkdirSync(path.join(data, "coord"), { recursive: true })
  writeFileSync(path.join(data, "coord", "round_end"), "1759999999000\n")
  const h = harness({ data })
  await ready(h)
  assert.equal(h.s.snapshot().roundEnd, 1759999999000)
  assert.equal(h.kv.get("round_end"), "1759999999000")
  await h.s.stop()
})

test("no plan while a round is unfinished", async () => {
  const h = harness()
  h.control.plan = { round: 3, resume: false, why: "changed" }
  h.control.play = "block"
  await ready(h)
  await settle(h)
  await tickUntil(h, () => h.plays.length === 1)
  const plans = plansStarted(h)
  h.s.tick()
  h.s.tick()
  await sleep(50)
  assert.equal(plansStarted(h), plans)
  await h.s.stop()
})

test("a round that already ran at this boot is not queued again, and the warning comes once", async () => {
  const h = harness()
  h.control.plan = { round: 4, resume: true, why: "resume" }
  await ready(h)
  await settle(h)
  await tickUntil(h, () => h.plays.length === 1 && h.s.snapshot().round === null)
  await settle(h)
  await tickUntil(h, () => h.s.snapshot().warned.length === 1)
  await settle(h)
  h.s.tick()
  await settle(h)
  assert.equal(h.plays.length, 1)
  assert.equal(logs.filter((l) => l.includes("[warning] round 4 of open already ran at this boot; it waits for the next boot")).length, 1)
  await h.s.stop()
})

test("an untrusted plan answer is not a round", async () => {
  const h = harness()
  h.control.plan = new GamesctlFailed("plan", "plan printed something other than a round")
  await ready(h)
  await tickUntil(h, () => logs.some((l) => l.includes("[warning] gamesctl plan failed (plan printed something other than a round)")))
  await settle(h)
  assert.equal(h.plays.length, 0)
  await h.s.stop()
})

test("a wake queues an intake pass on a tick that is not a third one, and restarts the idle clock", async () => {
  const h = harness()
  await ready(h)
  await settle(h)
  assert.notEqual(h.s.snapshot().ticks % 3, 0)
  const passes = h.events.filter((e) => e.startsWith("start intake")).length
  h.clock.mono += 1000
  h.s.wake()
  assert.equal(h.s.snapshot().busyAt, h.clock.mono)
  await eventually(() => h.events.filter((e) => e.startsWith("start intake")).length === passes + 1)
  await h.s.stop()
})

test("at most one intake pass waits behind the running one", async () => {
  const h = harness()
  h.control.intakeMs = 200
  await ready(h)
  h.s.wake()
  h.s.wake()
  h.s.wake()
  await settle(h)
  assert.equal(h.events.filter((e) => e.startsWith("start intake")).length, 2)
  await h.s.stop()
})

test("an intake pass's counts: open keeps the machine busy; an accepted version starts the settle clock, which plan receives", async () => {
  const h = harness()
  h.control.intake = { open: 2, accepted: 1, error: "no Javy" }
  await ready(h)
  await settle(h)
  assert.equal(h.s.snapshot().settledWall, h.clock.wall)
  assert.equal(h.s.snapshot().settledAt, h.clock.mono)
  assert.equal(h.pokes, 2, "setup's push and the accepted version's")
  assert.ok(logs.some((l) => l.includes("[warning] intake: no Javy")))
  await tickUntil(h, () => h.events.includes(`start plan --settled-since ${h.clock.wall}`))
  await h.s.stop()
})

test("a failed intake pass is logged and counts as unknown", async () => {
  const h = harness({ env: { GAMES_IDLE_MIN: "0" }, timing: { settleMs: 0 } })
  h.control.intake = new GamesctlFailed("intake", "exit 1")
  await ready(h)
  await settle(h)
  assert.ok(logs.some((l) => l.includes("[warning] intake: exit 1")))
  h.clock.mono += 1
  await tickUntil(h, () => h.stops.length === 1)
  await h.s.stop()
})

test("idle: with nothing to do for GAMES_IDLE_MIN it stops the machine with 0", async () => {
  const h = harness({ env: { GAMES_IDLE_MIN: "0" }, timing: { settleMs: 0 } })
  await ready(h)
  await settle(h)
  h.clock.mono += 1
  await tickUntil(h, () => h.stops.length === 1)
  assert.deepEqual(h.stops, [0])
  assert.ok(logs.some((l) => l.includes("[info] idle for 0 minutes")))
  // stopped: ticks do nothing more
  h.s.tick()
  await sleep(30)
  assert.deepEqual(h.stops, [0])
  await h.s.stop()
})

test("idle waits for the plan's answer: a round it names is queued, and there is no stop", async () => {
  const h = harness({ env: { GAMES_IDLE_MIN: "0" }, timing: { settleMs: 0 } })
  h.control.plan = { round: 2, resume: false, why: "stale" }
  h.control.planMs = 200
  h.control.play = "block"
  await ready(h)
  await settle(h)
  h.clock.mono += 1
  await tickUntil(h, () => h.plays.length === 1)
  assert.deepEqual(h.stops, [])
  await h.s.stop()
})

test("a round that already ran at this boot does not keep the machine up", async () => {
  const h = harness({ env: { GAMES_IDLE_MIN: "0" }, timing: { settleMs: 0 } })
  h.control.plan = { round: 4, resume: true, why: "resume" }
  await ready(h)
  await settle(h)
  await tickUntil(h, () => h.plays.length === 1)
  // the round's end restarted the idle clock
  await eventually(() => h.s.snapshot().round === null)
  assert.deepEqual(h.stops, [])
  // plan names it again (standings still say it runs): nothing to do
  h.clock.mono += 1
  await tickUntil(h, () => h.stops.length === 1)
  assert.equal(h.plays.length, 1)
  await h.s.stop()
})

test("not idle with a job unfinished, or a child other than a push running", async () => {
  const h = harness({ env: { GAMES_IDLE_MIN: "0" }, timing: { settleMs: 0 } })
  h.control.intakeMs = 300
  await ready(h)
  h.clock.mono += 1
  h.s.tick()
  await sleep(50)
  assert.deepEqual(h.stops, [])
  await settle(h)
  h.running = ["warm"]
  h.s.tick()
  await settle(h)
  assert.deepEqual(h.stops, [])
  h.running = ["push"]
  h.control.intakeMs = 0
  await tickUntil(h, () => h.stops.length === 1)
  await h.s.stop()
})

test("nothing happens on a tick while stopping", async () => {
  const h = harness()
  await ready(h)
  await settle(h)
  await h.s.stop()
  const n = h.events.length
  h.s.wake()
  h.s.tick()
  await sleep(30)
  assert.equal(h.events.length, n)
})

describe("rounds (Oban's rules)", () => {
  const playing = async (h: Harness) => {
    await ready(h)
    await tickUntil(h, () => h.plays.length > 0)
  }

  test("a round that fails is tried once more after the backoff, then held until the next boot", async () => {
    const h = harness({ retryMs: 150 })
    h.control.plan = { round: 5, resume: false, why: "changed" }
    h.control.play = { kind: "failed", why: "a game failed twice" }
    await playing(h)
    await eventually(() => h.plays.length === 1)
    await eventually(() => h.s.snapshot().round?.attempts === 1 && !h.s.playing())
    // while it waits for its second attempt it is unfinished: no plan, no idle stop
    const plans = plansStarted(h)
    h.s.tick()
    await sleep(20)
    assert.equal(plansStarted(h), plans)
    assert.deepEqual(h.s.snapshot().incomplete, ["round"])
    await eventually(() => h.plays.length === 2 && h.s.snapshot().round === null)
    assert.ok(logs.some((l) => l.includes("[info] round 5 ended: failed (a game failed twice)")))
    assert.ok(logs.some((l) => l.includes("[warning] round 5 waits for the next boot (it failed twice: failed (a game failed twice))")))
    assert.deepEqual(h.updates.at(-1), { k: 5, set: { state: "held", boot: "this-boot", attempts: 2 } })
    assert.equal(h.resets, 2, "the leases are forgotten after each attempt")
    assert.equal(h.pokes, 3, "setup's push and one per attempt")
    // plan names it again: it waits for the next boot
    h.control.plan = { round: 5, resume: true, why: "resume" }
    await settle(h)
    await tickUntil(h, () => h.s.snapshot().warned.includes(5))
    assert.equal(h.plays.length, 2)
    await h.s.stop()
  })

  test("a round that dies is a failed attempt too", async () => {
    const h = harness({ retryMs: 50 })
    h.control.plan = { round: 6, resume: false, why: "changed" }
    h.control.play = "die"
    await playing(h)
    await eventually(() => h.plays.length === 2 && h.s.snapshot().round === null)
    assert.ok(logs.some((l) => l.includes("round 6 ended: crashed: it broke")))
    await h.s.stop()
  })

  test("a round past the round cap is held at once, not tried again", async () => {
    // 0.0001 h = 360 ms
    const h = harness({ env: { GAMES_ROUND_HOURS: "0.0001" }, retryMs: 50 })
    h.control.plan = { round: 7, resume: false, why: "changed" }
    h.control.play = "block"
    await playing(h)
    await eventually(() => h.events.includes("term play 7"), 3000)
    await eventually(() => h.s.snapshot().round === null)
    await sleep(150)
    assert.equal(h.plays.length, 1)
    assert.ok(logs.some((l) => l.includes("[info] round 7 ended: past the round cap")))
    assert.ok(logs.some((l) => l.includes("[warning] round 7 waits for the next boot (it ran past 0 h)")))
    assert.deepEqual(h.updates.at(-1)?.set, { state: "held", boot: "this-boot", attempts: 1 })
    assert.equal(h.kv.get("round_end"), undefined)
    await h.s.stop()
  })

  test("a round a stop cuts is not an attempt: no retry, no hold, no round end", async () => {
    const h = harness({ retryMs: 50 })
    h.control.plan = { round: 8, resume: false, why: "changed" }
    h.control.play = "block"
    await playing(h)
    await eventually(() => h.s.playing())
    await h.s.stop()
    assert.ok(h.events.includes("term play 8"))
    assert.ok(logs.some((l) => l.includes("[info] round 8 ended: stopped (shutdown)")))
    await sleep(100)
    assert.equal(h.plays.length, 1)
    assert.ok(!h.updates.some((u) => u.set.state === "held"))
    assert.equal(h.kv.get("round_end"), undefined)
    assert.equal(h.resets, 1)
  })

  test("a finished round keeps its end, counts its attempt, and pokes the pusher", async () => {
    const h = harness()
    h.control.plan = { round: 9, resume: false, why: "changed" }
    await playing(h)
    await eventually(() => h.s.snapshot().round === null && h.plays.length === 1)
    assert.ok(logs.some((l) => l.includes("[info] round 9 ended: done")))
    assert.equal(h.kv.get("round_end"), String(h.clock.wall))
    assert.deepEqual(h.updates.at(-1), { k: 9, set: { attempts: 1 } })
    assert.equal(h.s.snapshot().lastRan, 9)
    assert.equal(h.pokes, 2)
    await h.s.stop()
  })

  test("stop interrupts every step in flight and waits for them", async () => {
    const h = harness()
    h.control.intakeMs = 60_000
    await h.s.start()
    await eventually(() => h.events.some((e) => e.startsWith("start intake")))
    await h.s.stop()
    assert.ok(h.events.some((e) => e.startsWith("term intake")))
    assert.ok(!logs.some((l) => l.includes("[warning] intake:")), "a pass a stop cut is not a failure")
  })
})
