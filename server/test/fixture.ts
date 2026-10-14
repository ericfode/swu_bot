/**
 * A small copy of the window's volume (WINDOW_HOME layout) for the import tests: two rounds of the open arena, the
 * first with two bots built into the games image, the second with the residents they became; every way a game can
 * end; a replay per game but one. Its standings were computed with the referee's own math (bot/ratings.js
 * bradleyTerry, anchored as referee.js does), so the import's check compares against an independent result.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { gzipSync } from "node:zlib"

const A = "alice_bot-v1"
const C = "c-clock-wasm"
const R = "rush"
const A2 = "alice_bot-v2"
const C1 = "c_clock-v1"
const R1 = "rush-v1"

/** bot/ratings.js on the games below (see the module comment). */
export const EXPECTED = {
  r0: { [A]: 1424, [C]: 1536, [R]: 1464 },
  r1: { [A2]: 1579, [C1]: 1421, [R1]: 1579 },
  global: { [A]: 1424, [C]: 1536, [R]: 1464, [A2]: 1526, [C1]: 1368, [R1]: 1526 }
}

const timing = (n: number) => ({ n, ms: n * 2.5, p50: 1, p95: 4, max: 9 })

const won = (seat: "p1" | "p2", p1: string, p2: string) =>
  ({ outcome: "won", winner: seat === "p1" ? p1 : p2, winnerSeat: seat, error: null, by: null, faultKind: null })

type End = ReturnType<typeof won> | { readonly [k: string]: unknown }

const game = (round: string, seed: number, p1: string, p2: string, end: End, host: string | null = null) => ({
  id: `${p1}-vs-${p2}-${seed}`,
  seed,
  p1,
  p2,
  winner: null,
  winnerSeat: null,
  error: null,
  by: null,
  faultKind: null,
  rounds: 7,
  steps: 120,
  ms: 1500,
  host,
  timing: { p1: timing(60), p2: timing(40) },
  key: `${round}-key-${seed}`,
  ...end
})

export const ROUND0 = [
  game("r0", 100, A, C, won("p1", A, C)),
  game("r0", 100, C, A, {
    outcome: "ERROR",
    winner: C,
    winnerSeat: "p1",
    by: "p2",
    faultKind: "time",
    error: `p2 ${A}: TIME_FORFEIT ${A} thought 60005 ms (cap 60000)`
  }),
  game("r0", 101, A, R, won("p2", A, R), "eric"),
  game("r0", 101, R, A, { outcome: "won", winner: "draw", winnerSeat: "draw" }),
  game("r0", 102, C, R, won("p1", C, R)),
  game("r0", 102, R, C, { outcome: "ERROR", error: "Unsupported phase effect on a card" })
]

export const ROUND1 = [
  game("r1", 200, A2, C1, won("p1", A2, C1)),
  game("r1", 200, C1, A2, won("p2", C1, A2)),
  game("r1", 201, A2, R1, won("p2", A2, R1)),
  game("r1", 201, R1, A2, { outcome: "STEP_CAP", steps: 6000 }),
  game("r1", 202, C1, R1, won("p1", C1, R1)),
  game("r1", 202, R1, C1, won("p1", R1, C1))
]

/** The one game whose replay the window lacks. */
export const NO_REPLAY = ROUND1[5].id

export const replayText = (id: string) =>
  [
    { t: "header", v: 1, seed: 1, players: [{ id: "p1" }, { id: "p2" }] },
    { t: "step", n: 0, label: "Game start", state: { game: id } },
    { t: "end", winner: "p1", round: 7, steps: 120, outcome: "won" }
  ].map((l) => JSON.stringify(l)).join("\n") + "\n"

const ladder = (id: string, bots: ReadonlyArray<string>, games: ReadonlyArray<{ id: string }>, at: number, capMs: number) => ({
  schema: "swu-ladder/1",
  id,
  status: "done",
  createdAt: `2026-10-13T1${at}:00:00.000Z`,
  updatedAt: `2026-10-13T1${at}:20:00.000Z`,
  config: { bots, gamesPerPair: 2, firstSeed: at * 100, maxSteps: 6000, capMs, hangMs: 150000, keyId: `kid${at}`, key: `runkey${at}` },
  progress: { scheduled: games.length, finished: games.length },
  games: games.map((g, i) => ({ ...g, think: { p1: 100 + i, p2: 200 + i } }))
})

const tally = (wins: number, losses: number, draws: number, unfinished: number, forfeits: number) =>
  ({ wins, losses, draws, unfinished, forfeits })

/** Writes the fixture under `home`; `tamper` changes one rating in the standings, which the import must refuse. */
export const writeFixture = (home: string, { tamper = false } = {}) => {
  const put = (ns: string, id: string, doc: unknown) => {
    mkdirSync(path.join(home, "docs", ns), { recursive: true })
    writeFileSync(path.join(home, "docs", ns, `${id}.json`), JSON.stringify(doc))
  }
  put("arena", "roster", {
    thinkCapMs: 45000,
    baselines: [],
    agents: [
      { name: "alice_bot", title: "Alice's bot", philosophy: "Attack the base", owner: "github:Alice", registeredAt: "2026-10-13T09:00:00.000Z" },
      { name: "c_clock", title: "c_clock", owner: "arena", resident: true, registeredAt: "2026-10-13T08:00:00.000Z" },
      { name: "rush", title: "rush", owner: "arena", resident: true, registeredAt: "2026-10-13T08:00:00.000Z" }
    ]
  })
  put("arena", "versions-alice_bot", [
    { v: 0, name: "alice_bot-v0", agent: "alice_bot", note: "starting strategy: heuristic", bot: { kind: "js" }, files: ["bot.js"] },
    { v: 1, name: A, agent: "alice_bot", note: "first", bot: { kind: "wasm" }, files: ["arena.json", "bot.wasm"], ref: "window:alice.x1", submittedAt: "2026-10-13T09:10:00.000Z" },
    { v: 2, name: A2, agent: "alice_bot", note: "second", bot: { kind: "wasm" }, files: ["arena.json", "bot.wasm"], ref: "window:alice.x2", submittedAt: "2026-10-13T10:10:00.000Z" }
  ])
  put("arena", "versions-c_clock", [{ v: 1, name: C1, agent: "c_clock", bot: { kind: "wasm" }, files: ["arena.json", "bot.wasm"], ref: "window:house.c_clock.1" }])
  put("arena", "versions-rush", [{ v: 1, name: R1, agent: "rush", bot: { kind: "wasm" }, files: ["arena.json", "bot.wasm"], ref: "window:house.rush.1" }])
  put("arena", "versions-old_bot", [{ v: 0, name: "old_bot-v0", agent: "old_bot", bot: { kind: "js" } }])
  const submission = (id: string, owner: string, name: string, state: string, extra: object = {}) =>
    put("submissions", id, { id, owner, name, kind: "wasm", note: null, state, submittedAt: "2026-10-13T09:05:00.000Z", fileNames: ["bot.wasm"], ...extra })
  submission("alice.x1", "Alice", "alice_bot", "accepted", { version: A, checkedAt: "2026-10-13T09:10:00.000Z" })
  submission("alice.x2", "Alice", "alice_bot", "accepted", { version: A2 })
  submission("alice.x3", "Alice", "alice_bot", "rejected", { error: "failed the start check" })
  submission("house.c_clock.1", "@arena", "c_clock", "accepted", { version: C1 })
  submission("house.rush.1", "@arena", "rush", "accepted", { version: R1 })
  submission("bob.x1", "bob", "bob_bot", "accepted")

  put("runs", "arena-r0", { id: "arena-r0", bots: [A, C, R], games: ROUND0 })
  put("runs", "arena-r1", { id: "arena-r1", bots: [A2, C1, R1], games: ROUND1 })
  put("ladders", "arena-r0", ladder("arena-r0", [A, C, R], ROUND0, 1, 60000))
  put("ladders", "arena-r1", ladder("arena-r1", [A2, C1, R1], ROUND1, 2, 45000))

  const r0 = { ...EXPECTED.r0, ...(tamper ? { [R]: EXPECTED.r0[R] + 1 } : {}) }
  put("arena", "standings", {
    schema: "swu-arena/1",
    startedAt: "2026-10-13T08:30:00.000Z",
    global: EXPECTED.global,
    rounds: [
      {
        round: 0,
        ladderId: "arena-r0",
        status: "done",
        bots: [
          { name: A, btElo: r0[A], ...tally(1, 2, 1, 0, 1) },
          { name: C, btElo: r0[C], ...tally(2, 1, 0, 1, 0) },
          { name: R, btElo: r0[R], ...tally(1, 1, 1, 1, 0) }
        ]
      },
      {
        round: 1,
        ladderId: "arena-r1",
        status: "done",
        bots: [
          { name: A2, btElo: EXPECTED.r1[A2], ...tally(2, 1, 0, 1, 0) },
          { name: C1, btElo: EXPECTED.r1[C1], ...tally(1, 3, 0, 0, 0) },
          { name: R1, btElo: EXPECTED.r1[R1], ...tally(2, 1, 0, 1, 0) }
        ]
      }
    ]
  })
  for (const [run, games] of [["arena-r0", ROUND0], ["arena-r1", ROUND1]] as const) {
    mkdirSync(path.join(home, "replays", run), { recursive: true })
    for (const g of games) {
      if (g.id !== NO_REPLAY) writeFileSync(path.join(home, "replays", run, `${g.id}.jsonl.gz`), gzipSync(replayText(g.id)))
    }
  }
}
