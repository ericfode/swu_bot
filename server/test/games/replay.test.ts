import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { Effect } from "effect"
import { gzipReplay } from "../../src/games/Compact.ts"
import { PlayFailed } from "../../src/games/Executor.ts"
import { loadArenaJs } from "../../src/games/Js.ts"
import { compareReplays, parseReplayArgs, readRound, replayLines, runReplay, withKey } from "../../src/games/Replay.ts"
import type { ReplayOptions } from "../../src/games/Replay.ts"
import { buildSchedule, keyId } from "../../src/games/Schedule.ts"
import type { DeckList, GameResult, Played, PlaySeedJob, RoundSpec, ScheduledGame } from "../../src/games/Types.ts"

const app = path.resolve(import.meta.dirname, "..", "..", "..")
const js = loadArenaJs(app)
const require = createRequire(path.join(app, "bot", "package.json"))
const { normalizeDeck } = require(path.join(app, "bot", "decklists.js"))
const { checkJob } = require(path.join(app, "bot", "arena", "play-seed.js"))
const hex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex")
const ENGINE = existsSync(path.join(app, "forceteki", "build", "server")) && existsSync(path.join(app, "forceteki", "test", "json"))

const BOTS = ["a-v1", "b-v2", "c-v1"]
const RUN_KEY = "0123456789abcdef0123456789abcdef"
const FIRST = 4000
const deck = (name: string): DeckList => normalizeDeck({ metadata: { name }, leader: { id: "SOR_005", count: 1 }, base: { id: "SOR_022", count: 1 }, deck: [{ id: "SOR_100", count: 3 }] })
// the file's lists, one of them left out as the arena leaves lando out
const FILE_LISTS = ["d0", "d1", "lando", "d2", "d3"].map(deck)
const LISTS = FILE_LISTS.filter((d) => d.metadata.name !== "lando")
const DECKS_SHA = hex("the deck file")
const loadDecks = () => ({ decks: FILE_LISTS, sha256: DECKS_SHA })

/** One game as play-seed plays it: a result and a replay without the key on its end line, its header's engine null. */
const playGame = (g: { id: string; p1: string; p2: string; decks?: readonly [number, number] }, seed: number, key: string | null, lists: ReadonlyArray<DeckList> | null) => {
  const h = hex(`${g.id}:${key}`)
  const p1 = parseInt(h.slice(0, 2), 16) % 2 === 0
  const steps = 40 + parseInt(h.slice(2, 4), 16)
  const round = 3 + (steps % 5)
  const decks = g.decks && lists ? { p1: lists[g.decks[0]]!, p2: lists[g.decks[1]]! } : null
  const lines = [
    { t: "header", v: 1, seed, engine: null, players: [{ id: "p1", bot: g.p1, deck: decks?.p1.metadata.name }, { id: "p2", bot: g.p2, deck: decks?.p2.metadata.name }], decks },
    { t: "step", n: 0, label: "Game start", state: { hand: [h.slice(0, 6)] } },
    { t: "step", n: 1, pid: "p1", action: { kind: "button", i: 0 }, state: { hand: [h.slice(6, 12)], round } },
    { t: "end", winner: p1 ? "p1" : "p2", round, steps, outcome: "won", error: null, by: null, faultKind: null }
  ]
  const result: GameResult = {
    seed, steps, outcome: "won", winner: p1 ? g.p1 : g.p2, round, ms: 900 + steps, ...(key ? { key } : {}), botStats: [null, null],
    timing: { p1: { n: 3, ms: 1 }, p2: { n: 2, ms: 1 } }, winnerSeat: p1 ? "p1" : "p2", by: null, faultKind: null, think: { p1: 1.5, p2: 2.5 }
  }
  return { result, replay: lines.map((l) => JSON.stringify(l)).join("\n") + "\n" }
}

/** A fake play-seed: plays a job's games as playGame does, after the job passes play-seed's own check. */
const fakePlay = (bundles: string, seen: Array<{ job: PlaySeedJob; tag: string }> = [], change: (id: string, played: { result: GameResult; replay: string }) => { result: GameResult; replay: string } = (_, x) => x) =>
  (job: PlaySeedJob, tag: string): Effect.Effect<Played, PlayFailed> =>
    Effect.sync(() => {
      checkJob(JSON.parse(JSON.stringify(job)), bundles)
      seen.push({ job, tag })
      const results: Array<{ id: string; result: GameResult }> = []
      const replays: Record<string, string> = {}
      for (const g of job.games) {
        const x = change(g.id, playGame(g, job.seed, job.key, job.decks ?? null))
        results.push({ id: g.id, result: x.result })
        replays[g.id] = x.replay
      }
      return { results, replays }
    })

/**
 * A round recorded as ladder.js writes it (ladder.json config and games, games/<id>.jsonl with the key on the end line
 * and the engine revision of a git checkout in the header), each game as playGame plays it, plus the versions' tars and
 * the names file. Returns the folders.
 */
const recordRound = (opts: { key?: string | null; decks?: boolean; skip?: ReadonlyArray<string>; bots?: ReadonlyArray<string>; firstSeed?: number; placement?: NonNullable<RoundSpec["placement"]> } = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), "games-replay-"))
  const results = path.join(dir, "results", "arena-r7")
  const bundles = path.join(dir, "bundles")
  mkdirSync(path.join(results, "games"), { recursive: true })
  mkdirSync(bundles, { recursive: true })
  const names: Record<string, string> = {}
  const bots = opts.bots ?? BOTS
  const firstSeed = opts.firstSeed ?? FIRST
  for (const b of bots) {
    const bytes = Buffer.from(`the canonical tar of ${b}`)
    names[b] = hex(bytes)
    writeFileSync(path.join(bundles, `${names[b]}.tar`), bytes)
  }
  writeFileSync(path.join(dir, "names.json"), JSON.stringify(names))
  const withDecks = opts.decks !== false
  const spec = { bots, gamesPerPair: 2, decks: withDecks ? { file: "x.json", sha256: DECKS_SHA, names: LISTS.map((d) => d.metadata.name), deal: "seat" as const, skipped: ["lando"], lists: LISTS } : null,
    ...(opts.placement ? { placement: opts.placement } : {}) }
  const schedule = buildSchedule(js, spec, firstSeed)
  const key = opts.key === undefined ? RUN_KEY : opts.key
  const games = schedule.filter((g) => !opts.skip?.includes(g.id)).map((g: ScheduledGame) => {
    const gk = key ? js.gameKey(key, g.seed) : null
    const { result: r, replay } = playGame(g, g.seed, gk, withDecks ? LISTS : null)
    const lines = replay.trim().split("\n").map((l) => JSON.parse(l))
    lines[0].engine = "2ebed8ca2"
    lines[lines.length - 1].key = gk
    writeFileSync(path.join(results, "games", `${g.id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
    return {
      id: g.id, seed: g.seed, p1: g.p1, p2: g.p2, winner: r.winner, winnerSeat: r.winnerSeat, outcome: r.outcome, rounds: r.round, steps: r.steps, ms: 7,
      error: null, by: null, faultKind: null, host: null, ...(g.decks ? { decks: { p1: LISTS[g.decks[0]]!.metadata.name, p2: LISTS[g.decks[1]]!.metadata.name } } : {}),
      timing: r.timing, think: r.think, botStats: r.botStats, ...(gk ? { key: gk } : {})
    }
  })
  const config = {
    bots, gamesPerPair: 2, firstSeed, maxSteps: 6000, workers: 2, capMs: 20000, hangMs: 70000, harness: "abc.def", engineDiff: null, programs: null,
    keyId: key ? keyId(key) : null, record: true,
    ...(opts.placement ? { placement: opts.placement } : {}),
    ...(withDecks ? { decks: { file: "x.json", sha256: DECKS_SHA, names: LISTS.map((d) => d.metadata.name), deal: "seat", skipped: ["lando"] } } : {}),
    ...(key ? { key } : {})
  }
  writeFileSync(path.join(results, "ladder.json"), JSON.stringify({ schema: "swu-ladder/1", id: "arena-r7", status: "done", engine: "2ebed8ca2", config, games }))
  return { dir, results, bundles, names: path.join(dir, "names.json"), out: path.join(dir, "out"), schedule }
}

const argsOf = (r: ReturnType<typeof recordRound>, extra: ReadonlyArray<string> = []) =>
  ["replay", "--results", r.results, "--bundles", r.bundles, "--names", r.names, "--out", r.out, ...extra]

/** runReplay with the fakes: its exit code, the printed line, the notes. */
const replay = async (argv: ReadonlyArray<string>, opts: Partial<ReplayOptions> = {}) => {
  const printed: Array<string> = []
  const notes: Array<string> = []
  const code = await Effect.runPromise(runReplay(argv, {
    loadDecks,
    env: { GAMES_DATA: mkdtempSync(path.join(tmpdir(), "games-replay-data-")) },
    print: (l) => printed.push(l),
    note: (l) => notes.push(l),
    ...opts
  }))
  assert.equal(printed.length, 1, "one summary line")
  return { code, doc: JSON.parse(printed[0]!), notes }
}

test("replay: a round played again the same way comes out the same, one play-seed job per seed", async () => {
  const r = recordRound()
  const seen: Array<{ job: PlaySeedJob; tag: string }> = []
  const { code, doc, notes } = await replay(argsOf(r), { play: fakePlay(r.bundles, seen) })
  assert.deepEqual(doc, { ok: true, games: 6, same: 6, different: [], missing: [] })
  assert.equal(code, 0)
  // each seed's two games in one job, dealt from the seed's game key, as the round's lane builds it
  assert.deepEqual(seen.map((s) => s.job.seed), [FIRST, FIRST + 1, FIRST + 2])
  for (const { job, tag } of seen) {
    assert.equal(job.key, js.gameKey(RUN_KEY, job.seed))
    assert.deepEqual([job.maxSteps, job.capMs, job.hangMs, job.gameMs], [6000, 20000, 70000, 4 * 20000 + 600000])
    assert.equal(job.games.length, 2)
    assert.ok(job.decks && job.decks.every((d) => LISTS.some((l) => l.metadata.name === d.metadata.name)))
    assert.match(tag, /^replay-\d+-\d+$/)
  }
  assert.equal(new Set(seen.map((s) => s.tag)).size, 3)
  assert.equal(notes.filter((n) => /the same/.test(n)).length, 3)
  // the games as played here, as the round's files would hold them: the key on the end line, the engine as it played
  const files = readdirSync(path.join(r.out, "games")).sort()
  assert.deepEqual(files, r.schedule.map((g) => `${g.id}.jsonl`).sort())
  const one = readFileSync(path.join(r.out, "games", files[0]!), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  assert.equal(one[0].engine, null)
  assert.equal(one.at(-1).key, js.gameKey(RUN_KEY, one[0].seed))
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(r.out, "results.json"), "utf8"))), r.schedule.map((g) => g.id))
  assert.deepEqual(JSON.parse(readFileSync(path.join(r.out, "summary.json"), "utf8")), doc)
})

test("replay: a recorded placement replays only its target pairs without inventing missing opponent games", async () => {
  const placement = { version: "b-v2", ref: "window:s1" }
  const r = recordRound({ placement })
  const seen: Array<{ job: PlaySeedJob; tag: string }> = []
  assert.equal(r.schedule.length, 4)
  const { code, doc } = await replay(argsOf(r), { play: fakePlay(r.bundles, seen) })
  assert.equal(code, 0)
  assert.deepEqual(doc, { ok: true, games: 4, same: 4, different: [], missing: [] })
  assert.deepEqual(seen.map(({ job }) => job.seed), [FIRST, FIRST + 2], "the opponent-only pair's seed is omitted")
  const games = seen.flatMap(({ job }) => job.games)
  assert.deepEqual(games.map((g) => g.id).sort(), r.schedule.map((g) => g.id).sort())
  assert.ok(games.every((g) => g.p1 === placement.version || g.p2 === placement.version))
  assert.deepEqual(readdirSync(path.join(r.out, "games")).sort(), r.schedule.map((g) => `${g.id}.jsonl`).sort())
  assert.deepEqual(JSON.parse(readFileSync(path.join(r.out, "summary.json"), "utf8")), doc)
})

test("replay: recorded placement metadata preserves the bounded schedule and rejects malformed bounds", () => {
  const placement = { version: "b-v2", ref: "window:s1" }
  const config = { bots: BOTS, gamesPerPair: 2, firstSeed: FIRST, maxSteps: 6000, capMs: 20000, hangMs: 70000, key: RUN_KEY, placement }
  assert.deepEqual(readRound({ config }).placement, placement)
  assert.deepEqual(readRound({ config: { ...config, bots: [...BOTS, "d-v1", "e-v1"], gamesPerPair: 10 } }).placement, placement)
  const invalid: Array<Record<string, unknown>> = [
    { placement: null },
    { placement: {} },
    { placement: { version: "missing-v1", ref: placement.ref } },
    { placement: { version: 1, ref: placement.ref } },
    { placement: { version: placement.version, ref: "submission-1" } },
    { placement: { version: placement.version, ref: 1 } },
    { placement: { version: placement.version, ref: `window:${"x".repeat(300)}` } },
    { bots: [...BOTS, "d-v1", "e-v1", "f-v1"] },
    { gamesPerPair: 3 },
    { gamesPerPair: 12 }
  ]
  for (const change of invalid) assert.throws(() => readRound({ config: { ...config, ...change } }), /ladder\.json/, JSON.stringify(change))
})

test("replay: adaptive placement preserves its exclusions and replays the actual fresh seed", async () => {
  const placement = { version: "b-v2", ref: "window:s1", adaptive: true as const, excludedSeeds: [FIRST, FIRST + 1, FIRST + 2] }
  const r = recordRound({ bots: ["b-v2", "a-v1"], firstSeed: FIRST + 3, placement })
  const recorded = readRound(JSON.parse(readFileSync(path.join(r.results, "ladder.json"), "utf8")))
  assert.deepEqual(recorded.placement, placement)
  assert.equal(recorded.firstSeed, FIRST + 3)
  const seen: Array<{ job: PlaySeedJob; tag: string }> = []
  const { code, doc } = await replay(argsOf(r), { play: fakePlay(r.bundles, seen) })
  assert.equal(code, 0)
  assert.deepEqual(doc, { ok: true, games: 2, same: 2, different: [], missing: [] })
  assert.deepEqual(seen.map(({ job }) => job.seed), [FIRST + 3])
  assert.deepEqual(seen[0]!.job.games.map((g) => g.id), r.schedule.map((g) => g.id))
})

test("replay: adaptive placement rejects malformed metadata and impossible fresh seeds", () => {
  const placement = { version: "b-v2", ref: "window:s1", adaptive: true, excludedSeeds: [FIRST] }
  const config = { bots: ["b-v2", "a-v1"], gamesPerPair: 2, firstSeed: FIRST + 1, maxSteps: 6000, capMs: 20000, hangMs: 70000, key: RUN_KEY, placement }
  const invalid: Array<Record<string, unknown>> = [
    { placement: { ...placement, adaptive: false } },
    { placement: { version: placement.version, ref: placement.ref, excludedSeeds: [] } },
    { placement: { version: placement.version, ref: placement.ref, adaptive: true } },
    { placement: { ...placement, excludedSeeds: [1, 1] } },
    { placement: { ...placement, excludedSeeds: [2, 1] } },
    { placement: { ...placement, excludedSeeds: [-1] } },
    { placement: { ...placement, excludedSeeds: [0x100000000] } },
    { bots: BOTS },
    { gamesPerPair: 4 },
    { firstSeed: FIRST },
    { firstSeed: 0x100000000 }
  ]
  for (const change of invalid) assert.throws(() => readRound({ config: { ...config, ...change } }), /ladder\.json/)
})

test("replay: a round the games machine gzipped, before the check or while it plays, is read from <id>.jsonl.gz", async () => {
  const gzipAll = async (r: ReturnType<typeof recordRound>) => {
    for (const f of readdirSync(path.join(r.results, "games"))) {
      const file = path.join(r.results, "games", f)
      await gzipReplay(file, readFileSync(file))
    }
  }
  const before = recordRound()
  await gzipAll(before)
  const a = await replay(argsOf(before), { play: fakePlay(before.bundles) })
  assert.deepEqual(a.doc, { ok: true, games: 6, same: 6, different: [], missing: [] })
  // a compaction pass during the first seed's job, after the check named <id>.jsonl for every game
  const during = recordRound()
  const base = fakePlay(during.bundles)
  let gzipped = false
  const play = (job: PlaySeedJob, tag: string) =>
    Effect.gen(function*() {
      if (!gzipped) {
        gzipped = true
        yield* Effect.promise(() => gzipAll(during))
      }
      return yield* base(job, tag)
    })
  const b = await replay(argsOf(during), { play })
  assert.ok(gzipped)
  assert.deepEqual(b.doc, { ok: true, games: 6, same: 6, different: [], missing: [] })
  assert.equal(b.code, 0)
})

test("replay: a round of random decks plays the same way, its jobs without deck lists", async () => {
  const r = recordRound({ decks: false })
  const seen: Array<{ job: PlaySeedJob; tag: string }> = []
  const { code, doc } = await replay(argsOf(r), { play: fakePlay(r.bundles, seen), loadDecks: () => assert.fail("no deck file to load") })
  assert.equal(code, 0)
  assert.equal(doc.same, 6)
  assert.ok(seen.every(({ job }) => !("decks" in job) && job.games.every((g) => !("decks" in g))))
})

test("replay: each field that came out differently is named, with what the round recorded and what played here", async () => {
  const r = recordRound()
  const id = r.schedule[3]!.id
  const other = r.schedule[4]!.id
  const play = fakePlay(r.bundles, [], (gid, x) => {
    if (gid === id) {
      const flip = x.result.winnerSeat === "p1" ? "p2" : "p1"
      const lines = x.replay.trim().split("\n").map((l) => JSON.parse(l))
      lines.at(-1).winner = flip
      return { result: { ...x.result, winnerSeat: flip, winner: lines[0].players[flip === "p1" ? 0 : 1].bot, steps: x.result.steps + 1 }, replay: lines.map((l: unknown) => JSON.stringify(l)).join("\n") + "\n" }
    }
    if (gid === other) {
      // the same result, but one board differs on the way
      const lines = x.replay.trim().split("\n").map((l) => JSON.parse(l))
      lines[2].state.hand[0] = "c99"
      return { ...x, replay: lines.map((l: unknown) => JSON.stringify(l)).join("\n") + "\n" }
    }
    return x
  })
  const { code, doc } = await replay(argsOf(r), { play })
  assert.equal(code, 1)
  assert.equal(doc.ok, false)
  assert.equal(doc.games, 6)
  assert.equal(doc.same, 4)
  const fields = doc.different.map((d: { id: string; field: string }) => `${d.id}:${d.field}`)
  assert.deepEqual(fields, [`${id}:winner`, `${id}:winnerSeat`, `${id}:steps`, `${id}:replay`, `${other}:replay`])
  const board = doc.different.at(-1)
  assert.match(board.want, /^line 3 \(step 1\) state\.hand\[0\]: "[0-9a-f]{6}"$/)
  assert.equal(board.got, 'line 3 (step 1) state.hand[0]: "c99"')
})

test("replay: --only plays the games between the versions it names, or the games it names", async () => {
  const r = recordRound()
  const seen: Array<{ job: PlaySeedJob; tag: string }> = []
  const { code, doc } = await replay(argsOf(r, ["--only", "a-v1,c-v1"]), { play: fakePlay(r.bundles, seen) })
  assert.equal(code, 0)
  assert.equal(doc.games, 2)
  assert.ok(seen.every(({ job }) => job.games.every((g) => [g.p1, g.p2].sort().join() === "a-v1,c-v1")))
  assert.deepEqual(Object.keys(seen[0]!.job.bots).sort(), ["a-v1", "c-v1"])
  const one = await replay(argsOf(r, ["--only", r.schedule[5]!.id]), { play: fakePlay(r.bundles) })
  assert.equal(one.doc.games, 1)
  assert.equal(one.code, 0)
  const bad = await replay(argsOf(r, ["--only", "z-v9"]), { play: fakePlay(r.bundles) })
  assert.equal(bad.code, 2)
  assert.match(bad.doc.error, /z-v9 is neither a version of the round nor one of its games/)
  const none = await replay(argsOf(r, ["--only", "a-v1"]), { play: fakePlay(r.bundles) })
  assert.equal(none.code, 2)
  assert.match(none.doc.error, /leaves no game to play/)
})

test("replay: a seed that cannot be played is a difference of its games; the other seeds are still compared", async () => {
  const r = recordRound()
  const ok = fakePlay(r.bundles)
  const play = (job: PlaySeedJob, tag: string) => (job.seed === FIRST + 1 ? Effect.fail(new PlayFailed(job.seed, "play-seed exit 1")) : ok(job, tag))
  const { code, doc } = await replay(argsOf(r, ["--jobs", "2"]), { play })
  assert.equal(code, 1)
  assert.equal(doc.same, 4)
  assert.deepEqual(doc.different.map((d: { field: string; got: string }) => [d.field, d.got]), [["play", "play-seed exit 1"], ["play", "play-seed exit 1"]])
})

test("replay: games the round did not finish are named as missing and not played", async () => {
  const r = recordRound({ skip: [] })
  const doc0 = JSON.parse(readFileSync(path.join(r.results, "ladder.json"), "utf8"))
  doc0.games[0].outcome = "running"
  doc0.games.pop()
  writeFileSync(path.join(r.results, "ladder.json"), JSON.stringify(doc0))
  const seen: Array<{ job: PlaySeedJob; tag: string }> = []
  const { code, doc } = await replay(argsOf(r), { play: fakePlay(r.bundles, seen) })
  assert.equal(code, 1)
  assert.equal(doc.ok, false)
  assert.equal(doc.games, 4)
  assert.equal(doc.same, 4)
  assert.deepEqual(doc.missing, [r.schedule[0]!.id, r.schedule[5]!.id])
  assert.equal(seen.flatMap((s) => s.job.games).length, 4)
})

test("replay: refuses, before any game plays, what it cannot replay", async () => {
  const never = () => assert.fail("nothing may play")
  const cases: Array<[string, (r: ReturnType<typeof recordRound>) => { argv?: Array<string>; opts?: Partial<ReplayOptions> }, RegExp]> = [
    ["no run key", () => ({}), /no run key/],
    ["a deck file with other bytes", () => ({ opts: { loadDecks: () => ({ decks: FILE_LISTS, sha256: hex("other") }) } }), /not the file the round dealt/],
    ["a deck file whose lists are not the round's", () => ({ opts: { loadDecks: () => ({ decks: [...FILE_LISTS].reverse(), sha256: DECKS_SHA }) } }), /not the round's 4 lists/],
    ["a deck file that does not load", () => ({ opts: { loadDecks: () => { throw new Error("x.json: d0: SOR_999 is not in the card data") } } }), /cannot load the round's deck lists from .*x\.json \(x\.json: d0: SOR_999/],
    ["a version missing from the names", (r) => {
      writeFileSync(r.names, JSON.stringify({ "a-v1": hex("x") }))
      return {}
    }, /no sha256 for b-v2|no [0-9a-f]{64}\.tar/],
    ["a tar that does not hash to its name", (r) => {
      const names = JSON.parse(readFileSync(r.names, "utf8"))
      writeFileSync(path.join(r.bundles, `${names["b-v2"]}.tar`), "changed")
      return {}
    }, /b-v2: [0-9a-f]{64}\.tar does not hash to its name/],
    ["no ladder.json", (r) => ({ argv: argsOf({ ...r, results: path.join(r.dir, "nowhere") }) }), /cannot read .*ladder\.json/],
    ["--out inside the round's folder", (r) => ({ argv: argsOf({ ...r, out: path.join(r.results, "again") }) }), /--out must be outside/],
    ["an unknown option", (r) => ({ argv: argsOf(r, ["--fast"]) }), /fast/],
    ["a missing option", (r) => ({ argv: ["replay", "--results", r.results] }), /^usage: replay/],
    ["--jobs out of range", (r) => ({ argv: argsOf(r, ["--jobs", "0"]) }), /--jobs is 1 to 16/]
  ]
  for (const [why, setup, error] of cases) {
    const r = recordRound(why === "no run key" ? { key: null } : {})
    const { argv, opts } = setup(r)
    const { code, doc } = await replay(argv ?? argsOf(r), { play: never, ...opts })
    assert.equal(code, 2, why)
    assert.equal(doc.ok, false, why)
    assert.match(doc.error, error, why)
    assert.ok(!existsSync(r.out), `${why}: nothing written`)
  }
})

test("replay: ladder.json configs that are not an arena round robin are refused", () => {
  const config = { bots: ["a-v1", "b-v1"], gamesPerPair: 2, firstSeed: 1, maxSteps: 6000, capMs: 1000, hangMs: 32000, key: "k" }
  assert.equal(readRound({ id: "x", config }).key, "k")
  assert.equal(readRound({ id: "x", config }).decks, null)
  for (const [why, change] of [
    ["a gauntlet", { format: "gauntlet", vs: ["c-v1"] }],
    ["a card pool", { pool: { file: "p.json" } }],
    ["odd games", { gamesPerPair: 3 }],
    ["no cap", { capMs: null }],
    ["one bot", { bots: ["a-v1"] }],
    ["decks dealt by bot", { decks: { file: "x.json", sha256: hex("x"), names: ["a", "b"] } }],
    ["a deck path", { decks: { file: "../x.json", sha256: hex("x"), names: ["a", "b"], deal: "seat" } }]
  ] as const) {
    assert.throws(() => readRound({ config: { ...config, ...change } }), /ladder\.json/, why)
  }
  assert.throws(() => readRound({}), /no config/)
})

test("replay: the key goes on the end line once, and the header's engine revision is left out of the comparison", () => {
  const text = '{"t":"header","v":1,"seed":3,"engine":"2ebed8ca2","players":[]}\n{"t":"step","n":0}\n{"t":"end","winner":"p1","outcome":"won"}\n'
  const keyed = withKey(text, "k1")
  assert.equal(keyed.trim().split("\n").at(-1), '{"t":"end","winner":"p1","outcome":"won","key":"k1"}')
  assert.equal(withKey(keyed, "k2"), keyed, "a key already there stays")
  assert.equal(withKey(text, null), text)
  assert.equal(withKey("not json\n", "k"), "not json\n")
  const lines = replayLines(text, "k1")
  assert.equal(lines.length, 3)
  assert.equal(lines[0], '{"t":"header","v":1,"seed":3,"engine":null,"players":[]}')
  assert.deepEqual(replayLines(text.replace('"2ebed8ca2"', "null"), "k1"), lines)
  assert.deepEqual(compareReplays("g", lines, lines.slice(0, 2)), { id: "g", field: "replay", want: "3 lines", got: "2 lines" })
  assert.equal(compareReplays("g", lines, [...lines]), null)
})

test("replay: from the command line, stdout carries the summary line alone; the log and anything the engine prints go to stderr", () => {
  const r = recordRound({ decks: false })
  // a play that prints on stdout, as the engine and bots may, and answers with the round's own games
  const script = `
    import { readFileSync } from "node:fs"
    import path from "node:path"
    import { Effect } from "effect"
    import { runReplay } from ${JSON.stringify(path.join(app, "server", "src", "games", "Replay.ts"))}
    const results = ${JSON.stringify(r.results)}
    const doc = JSON.parse(readFileSync(path.join(results, "ladder.json"), "utf8"))
    const play = (job) => Effect.sync(() => {
      console.log("noise from the engine")
      return {
        results: job.games.map((g) => {
          const e = doc.games.find((x) => x.id === g.id)
          return { id: g.id, result: { outcome: e.outcome, winner: e.winner, winnerSeat: e.winnerSeat, by: e.by, faultKind: e.faultKind, round: e.rounds, steps: e.steps, ms: 1, key: e.key } }
        }),
        replays: Object.fromEntries(job.games.map((g) => [g.id, readFileSync(path.join(results, "games", g.id + ".jsonl"), "utf8")]))
      }
    })
    process.exitCode = await Effect.runPromise(runReplay(${JSON.stringify(argsOf(r))}, { play }))
  `
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, GAMES_DATA: r.dir }
  const out = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: path.join(app, "server"), env, encoding: "utf8", timeout: 60000 })
  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(out.stdout.split("\n"), [JSON.stringify({ ok: true, games: 6, same: 6, different: [], missing: [] }), ""])
  assert.match(out.stderr, /noise from the engine/)
  assert.match(out.stderr, /\[info\] replay: seed \d+: 2 games, the same/)
})

test("replay: the command line, a leading replay word skipped", () => {
  const a = parseReplayArgs(["--results", "r", "--bundles", "b", "--names", "n.json", "--out", "o", "--only", "a-v1, b-v1", "--decks-dir", "d"])
  assert.equal(a.results, path.resolve("r"))
  assert.deepEqual(a.only, ["a-v1", "b-v1"])
  assert.equal(a.decksDir, path.resolve("d"))
  assert.equal(a.jobs, 1)
  assert.deepEqual(parseReplayArgs(["replay", "--results", "r", "--bundles", "b", "--names", "n", "--out", "o"]).only, null)
})

test("replay: the round's deck file is loaded and checked by the engine in this process", { skip: !ENGINE && "engine or card data not built" }, async () => {
  const file = path.join(app, "bot", "decks", "ash-meta-2026-09.json")
  const bytes = readFileSync(file)
  const all = JSON.parse(bytes.toString("utf8")).map(normalizeDeck) as Array<DeckList>
  const lists = all.filter((d) => d.metadata.name !== "lando-calrissian_law_blue")
  const r = recordRound({ decks: false })
  // the same round, but recorded as dealt from the tournament lists
  const doc = JSON.parse(readFileSync(path.join(r.results, "ladder.json"), "utf8"))
  doc.config.decks = { file: "ash-meta-2026-09.json", sha256: hex(bytes), names: lists.map((d) => d.metadata.name), deal: "seat", skipped: ["lando-calrissian_law_blue"] }
  const schedule = buildSchedule(js, { bots: BOTS, gamesPerPair: 2, decks: { ...doc.config.decks, lists } }, FIRST)
  for (const g of doc.games) {
    const s = schedule.find((x) => x.id === g.id)!
    g.decks = { p1: lists[s.decks![0]]!.metadata.name, p2: lists[s.decks![1]]!.metadata.name }
  }
  writeFileSync(path.join(r.results, "ladder.json"), JSON.stringify(doc))
  // replays of random decks recorded no lists: compare the results only, the replays are each game's own
  const play = fakePlay(r.bundles, [], (id, x) => ({ ...x, replay: readFileSync(path.join(r.results, "games", `${id}.jsonl`), "utf8") }))
  const printed: Array<string> = []
  // no loadDecks given: decklists.js loadDecks with bot/env.js's card data, as ladder.js checks a deck file
  const code = await Effect.runPromise(runReplay(argsOf(r), { play, env: { GAMES_DATA: r.dir }, print: (l) => printed.push(l), note: () => {} }))
  const out = JSON.parse(printed[0]!)
  assert.equal(code, 0, JSON.stringify(out))
  assert.equal(out.same, 6)
  // and a file that is not the round's is refused
  const other = path.join(r.dir, "decks")
  mkdirSync(other)
  writeFileSync(path.join(other, "ash-meta-2026-09.json"), JSON.stringify(all.slice(0, 5)))
  printed.length = 0
  const refused = await Effect.runPromise(runReplay(argsOf(r, ["--decks-dir", other]), { play, env: { GAMES_DATA: r.dir }, print: (l) => printed.push(l), note: () => {} }))
  assert.equal(refused, 2)
  assert.match(JSON.parse(printed[0]!).error, /not the file the round dealt/)
})
