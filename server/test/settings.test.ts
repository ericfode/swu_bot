import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { ADMIN, READER, client, fakePlayer, startArena, tempData } from "./harness.ts"

test("settings: an admin sets and resets them; the document says who and when", async () => {
  const arena = startArena(tempData(), fakePlayer([]))
  try {
    await arena.runPromise(Effect.gen(function*() {
      const admin = yield* client(ADMIN)
      assert.deepEqual(yield* admin.settings.get(), { settings: {}, updatedAt: null, by: null })

      const set = yield* admin.settings.update({ payload: { set: { gamesPerPair: 6, workers: 4 } } })
      assert.deepEqual(set.settings, { gamesPerPair: 6, workers: 4 })
      assert.equal(set.by, "admin token")
      assert.ok(set.updatedAt)

      const reset = yield* admin.settings.update({ payload: { set: { workers: null } } })
      assert.deepEqual(reset.settings, { gamesPerPair: 6 })
    }))
  } finally {
    await arena.dispose()
  }
})

test("settings: the same schema refuses bad values in the client and again in the server", async () => {
  const arena = startArena(tempData(), fakePlayer([]))
  try {
    await arena.runPromise(Effect.gen(function*() {
      const admin = yield* client(ADMIN)
      const http = yield* HttpClient.HttpClient
      for (const [body, expected] of [
        [{ set: { gamesPerPair: 3 } }, /multiple of 2/],
        [{ set: { gamesPerPair: 12 } }, /between 2 and 10/],
        [{ set: { thinkCapSec: 5 } }, /between 10 and 600/],
        [{ set: {} }, /at least 1/],
        [{ set: { gamesPerPair: 2, colour: "red" } }, /excess property/]
      ] as const) {
        // the generated client checks the payload before sending it
        const local = yield* admin.settings.update({ payload: body as never }).pipe(Effect.flip)
        assert.equal(local._tag, "SchemaError", JSON.stringify(body))
        // a client that skips the check gets a 400 that says why
        const response = yield* http.execute(HttpClientRequest.post("/api/v1/settings").pipe(
          HttpClientRequest.bearerToken(ADMIN),
          HttpClientRequest.bodyJsonUnsafe(body)
        ))
        assert.equal(response.status, 400, JSON.stringify(body))
        const error = (yield* response.json) as { _tag: string; part: string; message: string }
        assert.equal(error._tag, "BadInput")
        assert.equal(error.part, "Payload")
        assert.match(error.message, expected)
      }
      assert.deepEqual((yield* admin.settings.get()).settings, {})
    }))
  } finally {
    await arena.dispose()
  }
})

test("settings: readers are refused, and so is a request with no token", async () => {
  const arena = startArena(tempData(), fakePlayer([]))
  try {
    await arena.runPromise(Effect.gen(function*() {
      const reader = yield* client(READER)
      assert.equal((yield* reader.settings.get().pipe(Effect.flip))._tag, "Forbidden")
      const stranger = yield* client("not-a-token")
      assert.equal((yield* stranger.settings.get().pipe(Effect.flip))._tag, "Unauthorized")
    }))
  } finally {
    await arena.dispose()
  }
})
