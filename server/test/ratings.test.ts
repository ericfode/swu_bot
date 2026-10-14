import assert from "node:assert/strict"
import { test } from "node:test"
import { fit, scoreOf } from "../src/Ratings.ts"
import { EXPECTED } from "./fixture.ts"

const A = "alice_bot-v1"
const C = "c-clock-wasm"
const R = "rush"

test("ratings: Bradley-Terry gives the referee's numbers, with the anchors' mean at 1500", () => {
  // round 0 of the fixture; EXPECTED came from bot/ratings.js
  const results = [
    { a: A, b: C, score: 1 },
    { a: C, b: A, score: 1 },
    { a: A, b: R, score: 0 },
    { a: R, b: A, score: 0.5 },
    { a: C, b: R, score: 1 }
  ]
  const fitted = fit([A, C, R], results, [C, R])
  assert.deepEqual(Object.fromEntries([...fitted].map(([k, v]) => [k, Math.round(v.rating)])), EXPECTED.r0)
  assert.ok(Math.abs((fitted.get(C)!.rating + fitted.get(R)!.rating) / 2 - 1500) < 1e-9)
  for (const { se } of fitted.values()) assert.ok(se > 100 && se < 1000, `se ${se}`)
  // no anchors: the geometric mean sits at 1500
  const plain = fit([A, C, R], results, [])
  assert.ok(Math.abs([...plain.values()].reduce((s, x) => s + x.rating, 0) / 3 - 1500) < 1e-9)
})

test("ratings: more games give a smaller standard error", () => {
  const few = fit(["a", "b"], [{ a: "a", b: "b", score: 1 }, { a: "b", b: "a", score: 1 }], [])
  const many = fit(["a", "b"], Array.from({ length: 40 }, (_, i) => ({ a: "a", b: "b", score: i % 2 })), [])
  assert.ok(many.get("a")!.se < few.get("a")!.se / 2)
})

test("scoring: the referee's rule for every way a game ends", () => {
  const s = (end: Parameters<typeof scoreOf>[2]) => scoreOf("x", "y", end)
  assert.deepEqual(
    [s({ outcome: "won", winnerSeat: "p1" }).score, s({ outcome: "won", winner: "y" }).score],
    [1, 0]
  )
  const draw = s({ outcome: "won", winner: "draw", winnerSeat: "draw" })
  assert.deepEqual([draw.outcome, draw.score, draw.winner], ["draw", 0.5, null])
  const forfeit = s({ outcome: "ERROR", by: "p1", faultKind: "time", error: "TIME_FORFEIT" })
  assert.deepEqual(
    [forfeit.outcome, forfeit.score, forfeit.winner, forfeit.winnerSeat, forfeit.faultSeat, forfeit.faultKind],
    ["forfeit", 0, "y", "p2", "p1", "time"]
  )
  for (const [outcome, kind] of [["ERROR", "error"], ["STEP_CAP", "step_cap"], ["STUCK", "stuck"], ["abandoned", "abandoned"]]) {
    const end = s({ outcome })
    assert.deepEqual([end.outcome, end.score], [kind, null])
  }
  assert.throws(() => s({ outcome: "running" }), /has not ended/)
  assert.throws(() => s({ outcome: "won", winner: "z" }), /names no winner/)
})
