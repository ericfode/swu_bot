import assert from "node:assert/strict"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { beforeEach, test } from "node:test"
import { gunzipSync, gzipSync } from "node:zlib"
import { Effect } from "effect"
import { candidates, gzipReplay, makeCompactor, parseSizes } from "../../src/games/Compact.ts"
import type { CompactorOptions } from "../../src/games/Compact.ts"
import { readConfig } from "../../src/games/Config.ts"
import { setSink } from "../../src/games/Log.ts"

let logs: Array<string> = []
beforeEach(() => {
  logs = []
  setSink((l) => logs.push(l))
})

const replayText = (id: string, steps: number) =>
  [{ type: "header", id }, ...Array.from({ length: steps }, (_, i) => ({ step: i, board: { units: ["a", "b"], hp: 30 - (i % 7) } })), { type: "end", key: "k" }]
    .map((l) => JSON.stringify(l)).join("\n") + "\n"

/** A volume with results/arena-r<K>/ for each k: ladder.json (done unless said), games/<id>.jsonl replays. */
const volume = (rounds: Record<number, { status?: string; games?: Record<string, string>; lock?: boolean }>) => {
  const data = mkdtempSync(path.join(tmpdir(), "games-compact-"))
  const config = readConfig({ GAMES_DATA: data, SWU_WINDOW: "http://127.0.0.1:9" })
  for (const [k, r] of Object.entries(rounds)) {
    const dir = path.join(config.paths.results, `arena-r${k}`)
    mkdirSync(path.join(dir, "games"), { recursive: true })
    writeFileSync(path.join(dir, "ladder.json"), JSON.stringify({ id: `arena-r${k}`, status: r.status ?? "done" }))
    for (const [id, text] of Object.entries(r.games ?? {})) writeFileSync(path.join(dir, "games", `${id}.jsonl`), text)
    if (r.lock) writeFileSync(path.join(dir, "referee.lock"), "{}")
  }
  return { data, config, games: (k: number) => path.join(config.paths.results, `arena-r${k}`, "games") }
}

/** The window as the files are now: every replay at its size (what a push that went through leaves). */
const windowOf = (games: (k: number) => string, ks: ReadonlyArray<number>) => {
  const runs = new Map<string, Map<string, number>>()
  for (const k of ks) {
    const m = new Map<string, number>()
    for (const f of readdirSync(games(k)).filter((n) => n.endsWith(".jsonl"))) m.set(f.slice(0, -6), lstatSync(path.join(games(k), f)).size)
    runs.set(`arena-r${k}`, m)
  }
  return runs
}

const compactor = (v: ReturnType<typeof volume>, o: Partial<CompactorOptions> & { window?: Map<string, Map<string, number>> | null; rows?: Record<number, string> } = {}) => {
  const asked: Array<string> = []
  const c = makeCompactor({
    config: v.config,
    token: () => "t",
    store: { round: (k: number) => Effect.succeed(o.rows?.[k] ? ({ k, state: o.rows[k] } as any) : null) },
    busy: () => false,
    isStopping: () => false,
    windowSizes: async (run) => {
      asked.push(run)
      return o.window === null ? null : o.window?.get(run) ?? new Map()
    },
    ...o
  })
  return { c, asked }
}

test("compact: candidates are the arena-r<K> folders by K, without the newest two", () => {
  assert.deepEqual(candidates(["arena-r10", "arena-r9", "arena-r2", "arena-r11", "other", "arena-r03", "arena-rx"], 2).map((x) => x.run), ["arena-r2", "arena-r9"])
  assert.deepEqual(candidates(["arena-r1", "arena-r2"], 2), [])
  assert.deepEqual(candidates([], 2), [])
})

test("compact: the window's sizes answer is read as a map; anything else is no answer", () => {
  assert.deepEqual([...parseSizes(JSON.stringify({ result: [{ id: "a", size: 3 }, { id: "b", size: null }, { id: 4, size: 1 }] }))!], [["a", 3]])
  assert.equal(parseSizes("not json"), null)
  assert.equal(parseSizes(JSON.stringify({ result: { a: 1 } })), null)
  assert.equal(parseSizes(JSON.stringify({ error: { code: "unauthorized" } })), null)
})

test("compact: gzipReplay leaves <id>.jsonl.gz holding the same bytes, and no .jsonl or .tmp", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "games-compact-one-"))
  const file = path.join(dir, "g1.jsonl")
  const text = replayText("g1", 300)
  writeFileSync(file, text)
  const size = await gzipReplay(file, Buffer.from(text))
  assert.ok(!existsSync(file))
  assert.deepEqual(readdirSync(dir), ["g1.jsonl.gz"])
  assert.equal(lstatSync(`${file}.gz`).size, size)
  assert.equal(lstatSync(`${file}.gz`).mode & 0o777, 0o644)
  assert.ok(size < text.length / 5)
  assert.equal(gunzipSync(readFileSync(`${file}.gz`)).toString("utf8"), text)
})

test("compact: a pass gzips the replays the window holds at the same size, in old rounds only", async () => {
  const v = volume({
    1: { games: { a: replayText("a", 50), b: replayText("b", 80), c: replayText("c", 20) } },
    2: { games: { d: replayText("d", 40) } },
    3: { games: { e: replayText("e", 40) } },
    4: { games: { f: replayText("f", 40) } }
  })
  const window = windowOf(v.games, [1, 2, 3, 4])
  // the window lacks c, and holds b at another size (a push that was cut)
  window.get("arena-r1")!.delete("c")
  window.get("arena-r1")!.set("b", 7)
  const before = Object.fromEntries(["a", "b", "c"].map((id) => [id, readFileSync(path.join(v.games(1), `${id}.jsonl`), "utf8")]))
  const { c, asked } = compactor(v, { window })
  const report = await c.pass()
  assert.deepEqual(asked, ["arena-r1", "arena-r2"], "the two newest rounds are not even asked about")
  assert.deepEqual(readdirSync(v.games(1)).sort(), ["a.jsonl.gz", "b.jsonl", "c.jsonl"])
  assert.equal(gunzipSync(readFileSync(path.join(v.games(1), "a.jsonl.gz"))).toString("utf8"), before.a)
  assert.equal(readFileSync(path.join(v.games(1), "b.jsonl"), "utf8"), before.b)
  assert.deepEqual(readdirSync(v.games(2)), ["d.jsonl.gz"])
  assert.deepEqual(readdirSync(v.games(3)), ["e.jsonl"])
  assert.deepEqual(readdirSync(v.games(4)), ["f.jsonl"])
  const r1 = report.rounds.find((r) => r.run === "arena-r1")!
  assert.equal(r1.gzipped, 1)
  assert.equal(r1.kept, 2)
  assert.equal(r1.from, Buffer.byteLength(before.a))
  assert.ok(r1.to > 0 && r1.to < r1.from)
  assert.ok(!report.cut)
  assert.ok(logs.some((l) => l.includes("[info] compact: arena-r1: gzipped 1 replays") && l.includes("2 kept plain")))
  // a second pass has nothing left to gzip, and names the plain ones no more
  logs = []
  const again = await c.pass()
  assert.equal(again.rounds.reduce((n, r) => n + r.gzipped, 0), 0)
  assert.ok(!logs.some((l) => l.includes("arena-r1")))
})

test("compact: a round that is locked, not done in its ladder, or not done in games.db stays as it is", async () => {
  const v = volume({
    1: { games: { a: replayText("a", 10) }, lock: true },
    2: { games: { b: replayText("b", 10) }, status: "running" },
    3: { games: { c: replayText("c", 10) } },
    4: { games: { d: replayText("d", 10) } },
    5: {},
    6: {}
  })
  const { c, asked } = compactor(v, { window: windowOf(v.games, [1, 2, 3, 4]), rows: { 3: "held", 4: "done" } })
  const report = await c.pass()
  assert.deepEqual(readdirSync(v.games(1)), ["a.jsonl"])
  assert.deepEqual(readdirSync(v.games(2)), ["b.jsonl"])
  assert.deepEqual(readdirSync(v.games(3)), ["c.jsonl"])
  assert.deepEqual(readdirSync(v.games(4)), ["d.jsonl.gz"])
  assert.deepEqual(asked, ["arena-r4"], "the window is asked only about rounds that may be compacted")
  assert.deepEqual(report.rounds.map((r) => [r.run, r.skipped]).slice(0, 3), [
    ["arena-r1", "it holds referee.lock"],
    ["arena-r2", "its ladder.json does not say done"],
    ["arena-r3", "games.db says it is held"]
  ])
})

test("compact: with no answer from the window nothing is gzipped, and the warning comes once", async () => {
  const v = volume({ 1: { games: { a: replayText("a", 10) } }, 2: { games: { b: replayText("b", 10) } }, 3: {}, 4: {} })
  const { c } = compactor(v, { window: null })
  await c.pass()
  await c.pass()
  assert.deepEqual(readdirSync(v.games(1)), ["a.jsonl"])
  assert.deepEqual(readdirSync(v.games(2)), ["b.jsonl"])
  assert.equal(logs.filter((l) => l.includes("did not say which replays")).length, 1)
})

test("compact: stale .tmp files of a round it compacts go; a replay both plain and gzipped is gzipped again; a link is never read", async () => {
  const v = volume({ 1: { games: { a: replayText("a", 30), b: replayText("b", 30) } }, 2: {}, 3: {} })
  const g = v.games(1)
  writeFileSync(path.join(g, "a.jsonl.gz.0a1b2c.tmp"), "half a gzip")
  writeFileSync(path.join(g, "z.jsonl.77.tmp"), "an old atomic write")
  // a pass cut between the rename and the unlink left both; the gzip is of an older text
  writeFileSync(path.join(g, "b.jsonl.gz"), gzipSync("an older text"))
  const secret = path.join(v.data, "secret.txt")
  writeFileSync(secret, "not a replay")
  symlinkSync(secret, path.join(g, "l.jsonl"))
  const window = windowOf(v.games, [1])
  window.get("arena-r1")!.set("l", "not a replay".length)
  const { c } = compactor(v, { window })
  const report = await c.pass()
  assert.deepEqual(readdirSync(g).sort(), ["a.jsonl.gz", "b.jsonl.gz", "l.jsonl"])
  assert.equal(gunzipSync(readFileSync(path.join(g, "b.jsonl.gz"))).toString("utf8"), replayText("b", 30))
  assert.ok(lstatSync(path.join(g, "l.jsonl")).isSymbolicLink())
  assert.equal(readFileSync(secret, "utf8"), "not a replay")
  const r1 = report.rounds[0]!
  assert.deepEqual([r1.gzipped, r1.kept, r1.cleaned], [2, 1, 2])
})

test("compact: a pass stops between two replays when a round starts, and the next pass goes on", async () => {
  const games = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`g${i}`, replayText(`g${i}`, 20)]))
  const v = volume({ 1: { games }, 2: {}, 3: {} })
  let busy = false
  let done = 0
  const window = windowOf(v.games, [1])
  const { c } = compactor(v, {
    window,
    busy: () => busy,
    windowSizes: async () => {
      // a round is queued while the pass asks the window
      busy = done++ === 0
      return window.get("arena-r1")!
    }
  })
  const first = await c.pass()
  assert.ok(first.cut)
  assert.equal(readdirSync(v.games(1)).filter((n) => n.endsWith(".gz")).length, 0)
  busy = false
  const second = await c.pass()
  assert.ok(!second.cut)
  assert.equal(readdirSync(v.games(1)).filter((n) => n.endsWith(".gz")).length, 6)
})

test("compact: poke runs one pass at a time, one more when poked during it; none after stop", async () => {
  const v = volume({ 1: { games: { a: replayText("a", 10) } }, 2: {}, 3: {} })
  let calls = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  const { c } = compactor(v, {
    // the first pass finds the window without a; the one more pass finds it there
    windowSizes: async () => {
      calls++
      if (calls === 1) {
        await gate
        return new Map()
      }
      return new Map([["a", lstatSync(path.join(v.games(1), "a.jsonl")).size]])
    }
  })
  c.poke()
  assert.ok(c.running())
  c.poke()
  c.poke()
  release()
  const end = Date.now() + 3000
  while ((c.running() || calls < 2) && Date.now() < end) await new Promise((r) => setTimeout(r, 10))
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(calls, 2, "two pokes during a pass make one more pass")
  assert.ok(!c.running())
  assert.deepEqual(readdirSync(v.games(1)), ["a.jsonl.gz"])
  await c.stop()
  c.poke()
  assert.ok(!c.running())
})
