import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { beforeEach, test } from "node:test"
import { Effect } from "effect"
import { readConfig, TIMING } from "../../src/games/Config.ts"
import { GamesctlFailed } from "../../src/games/Gamesctl.ts"
import { setSink } from "../../src/games/Log.ts"
import { makePusher, roundMark } from "../../src/games/Pusher.ts"
import type { Pusher } from "../../src/games/Pusher.ts"

const URL = "http://127.0.0.1:8081/p/nonce"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const eventually = async (f: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!f()) {
    if (Date.now() > end) throw new Error("not in time")
    await sleep(20)
  }
}

let logs: Array<string> = []
beforeEach(() => {
  logs = []
  setSink((l) => logs.push(l))
})

/**
 * A gamesctl whose push takes `delayMs` and answers `answer`; a stop (the fake proc's stopAll) or an interruption ends
 * the push in progress, as a TERM to its group would.
 */
const fakes = () => {
  const events: Array<string> = []
  const pending = new Set<(e: GamesctlFailed) => void>()
  const f = {
    events,
    delayMs: 0,
    answer: true as boolean | "fail" | "never",
    stopAlls: 0,
    gamesctl: {
      push: (url: string, only: "round" | null) =>
        Effect.callback<boolean, GamesctlFailed>((resume) => {
          events.push(`start push ${only ?? "full"} ${url}`)
          const finish = (r: Effect.Effect<boolean, GamesctlFailed>) => {
            pending.delete(stop)
            clearTimeout(timer)
            resume(r)
          }
          const stop = (e: GamesctlFailed) => {
            events.push("term push")
            finish(Effect.fail(e))
          }
          pending.add(stop)
          const timer = f.answer === "never" ? undefined : setTimeout(() => {
            events.push("end push")
            finish(f.answer === "fail" ? Effect.fail(new GamesctlFailed("push", "exit 1")) : Effect.succeed(f.answer === true))
          }, f.delayMs)
          return Effect.sync(() => {
            if (pending.has(stop)) stop(new GamesctlFailed("push", "interrupted", true))
          })
        })
    },
    proc: {
      stopAll: (keep: ReadonlyArray<string>, _grace: number) =>
        Effect.sync(() => {
          f.stopAlls++
          assert.ok(!keep.includes("push"), "only pushes are stopped")
          for (const stop of [...pending]) stop(new GamesctlFailed("push", "shutdown", true))
          return 0
        })
    }
  }
  return f
}

const pushes = (events: ReadonlyArray<string>, kind?: "full" | "round") =>
  events.filter((e) => e.startsWith(kind ? `start push ${kind} ` : "start push ")).length

const make = (f: ReturnType<typeof fakes>, timing: Partial<typeof TIMING>, o: { playing?: () => boolean; results?: string; lastPushMs?: number } = {}): Pusher => {
  const data = o.results ? path.dirname(o.results) : mkdtempSync(path.join(tmpdir(), "games-pusher-"))
  const config = readConfig({ GAMES_DATA: data }, { ...TIMING, ...timing })
  return makePusher({
    config,
    gamesctl: f.gamesctl,
    proc: f.proc,
    url: () => URL,
    playing: o.playing ?? (() => false),
    isStopping: () => false,
    ...(o.lastPushMs ? { lastPushMs: o.lastPushMs } : {})
  })
}

test("it pushes from the first poke on, every tick after", async () => {
  const f = fakes()
  const p = make(f, { tickMs: 200 })
  await sleep(300)
  assert.equal(pushes(f.events), 0)
  p.poke()
  await eventually(() => pushes(f.events) >= 3)
  assert.ok(f.events.every((e) => !e.startsWith("start") || e === `start push full ${URL}`))
  await p.stop()
})

test("while a round plays, it sends the round every round tick and everything every tick", async () => {
  const f = fakes()
  let playing = true
  const p = make(f, { tickMs: 1000, roundTickMs: 100 }, { playing: () => playing })
  p.poke()
  // the poke's push is a full one; the round goes every round tick after it, and everything again a tick later
  await eventually(() => pushes(f.events, "round") >= 3)
  assert.equal(pushes(f.events, "full"), 1)
  assert.equal(f.events[0], `start push full ${URL}`)
  await eventually(() => pushes(f.events, "full") >= 2, 3000)

  // no round, no round pushes: every push is a full one again, a tick apart
  playing = false
  await sleep(300)
  const round = pushes(f.events, "round")
  await sleep(1300)
  assert.equal(pushes(f.events, "round"), round)
  await p.stop()
})

test("a round push waits until something in the round's folder changed", async () => {
  const data = mkdtempSync(path.join(tmpdir(), "games-pusher-"))
  const results = path.join(data, "results")
  const games = path.join(results, "arena-r13", "games")
  mkdirSync(games, { recursive: true })
  mkdirSync(path.join(results, "arena-r9"), { recursive: true })
  writeFileSync(path.join(games, "a.jsonl"), "{\"t\":\"header\"}\n")
  const f = fakes()
  const p = make(f, { tickMs: 60_000, roundTickMs: 100 }, { playing: () => true, results })
  p.poke()
  // the poke's full push sent the folder as it is: nothing new, no round push
  await eventually(() => pushes(f.events) === 1 && f.events.includes("end push"))
  await sleep(500)
  assert.equal(pushes(f.events, "round"), 0)

  writeFileSync(path.join(games, "a.jsonl"), "{\"t\":\"header\"}\n{\"t\":\"step\"}\n")
  await eventually(() => pushes(f.events, "round") === 1)
  await sleep(500)
  assert.equal(pushes(f.events, "round"), 1)
  await p.stop()
})

test("the round mark follows the newest round's index and replays, not older rounds", () => {
  const results = path.join(mkdtempSync(path.join(tmpdir(), "games-pusher-")), "results")
  assert.equal(roundMark(results), null)
  mkdirSync(path.join(results, "arena-r2", "games"), { recursive: true })
  mkdirSync(path.join(results, "arena-r10", "games"), { recursive: true })
  const a = roundMark(results)
  assert.ok(a)
  writeFileSync(path.join(results, "arena-r2", "games", "x.jsonl"), "x\n")
  assert.equal(roundMark(results), a)
  writeFileSync(path.join(results, "arena-r10", "index.json"), "{}")
  const b = roundMark(results)
  assert.notEqual(b, a)
  writeFileSync(path.join(results, "arena-r10", "games", "g.jsonl"), "x\n")
  assert.notEqual(roundMark(results), b)
})

test("a poke during a push makes one more push right after it, not one per poke", async () => {
  const f = fakes()
  f.delayMs = 500
  const p = make(f, { tickMs: 60_000 })
  p.poke()
  await eventually(() => pushes(f.events) === 1)
  p.poke()
  p.poke()
  await eventually(() => pushes(f.events) === 2)
  await sleep(1200)
  assert.equal(pushes(f.events), 2)
  await p.stop()
})

test("a failing push is logged once, not every time; its recovery once", async () => {
  const f = fakes()
  f.answer = "fail"
  const p = make(f, { tickMs: 50 })
  p.poke()
  await eventually(() => pushes(f.events) >= 3)
  f.answer = false
  const n = pushes(f.events)
  await eventually(() => pushes(f.events) >= n + 2)
  f.answer = true
  await eventually(() => logs.some((l) => l.includes("push works again")))
  await p.stop()
  assert.equal(logs.filter((l) => l.includes("[warning] push failed")).length, 1)
  assert.ok(logs.some((l) => l.includes("push failed: exit 1")))
})

test("stop: a push in progress is stopped, then one last full push", async () => {
  const f = fakes()
  f.delayMs = 60_000
  const p = make(f, { tickMs: 60_000 })
  p.poke()
  await eventually(() => pushes(f.events) === 1)
  f.delayMs = 10
  await p.stop()
  assert.ok(f.events.includes("term push"))
  assert.equal(pushes(f.events, "full"), 2)
  assert.equal(f.events.at(-1), "end push")
  assert.ok(logs.some((l) => l.includes("[info] last push")))
  // nothing more after the stop
  p.poke()
  await sleep(100)
  assert.equal(pushes(f.events), 2)
})

test("the last push has a time limit", async () => {
  const f = fakes()
  const p = make(f, { tickMs: 60_000 }, { lastPushMs: 200 })
  p.poke()
  await eventually(() => f.events.includes("end push"))
  f.answer = "never"
  const t0 = Date.now()
  await p.stop()
  assert.ok(Date.now() - t0 < 2000)
  assert.ok(f.events.includes("term push"))
})

test("without a first poke (setup never finished) there is no last push", async () => {
  const f = fakes()
  const p = make(f, { tickMs: 50 })
  await sleep(150)
  await p.stop()
  assert.deepEqual(f.events, [])
  assert.equal(p.started(), false)
})
