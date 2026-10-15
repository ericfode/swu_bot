import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import http from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, beforeEach, test } from "node:test"
import { readConfig } from "../../src/games/Config.ts"
import { setSink } from "../../src/games/Log.ts"
import { makeSettings, parseSettings } from "../../src/games/Settings.ts"

const TOKEN = "the-window-token"

// the window: answers `settings` (or a bare status) and records what it saw
let answer: { readonly settings: unknown } | { readonly status: number } = { settings: {} }
let seen: Array<{ method: string; url: string; auth: string | undefined }> = []
const window = http.createServer((req, res) => {
  seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization })
  if ("status" in answer) {
    res.writeHead(answer.status, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { code: "x" } }))
  } else {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ result: { settings: answer.settings, updatedAt: null, by: null } }))
  }
})
let windowUrl = ""
let logs: Array<string> = []

before(async () => {
  setSink((l) => logs.push(l))
  await new Promise<void>((r) => window.listen(0, "127.0.0.1", r))
  windowUrl = `http://127.0.0.1:${(window.address() as { port: number }).port}`
})
after(() => new Promise((r) => window.close(r)))
beforeEach(() => {
  seen = []
  logs = []
  answer = { settings: {} }
})

const config = (env: Record<string, string> = {}) => {
  const data = mkdtempSync(path.join(tmpdir(), "games-settings-"))
  return readConfig({ GAMES_DATA: data, SWU_WINDOW: windowUrl, ...env })
}

test("parse keeps the settings in range and drops the rest", () => {
  assert.deepEqual(parseSettings({ gamesPerPair: 4, thinkCapSec: 90, workers: 3, roundGapMin: 0 }), { gamesPerPair: 4, thinkCapSec: 90, workers: 3, roundGapMin: 0 })
  for (const bad of [
    { gamesPerPair: 3 }, { gamesPerPair: 12 }, { gamesPerPair: 0 }, { thinkCapSec: 9 }, { thinkCapSec: 601 }, { workers: 0 },
    { workers: 17 }, { workers: "3" }, { workers: 2.5 }, { roundGapMin: -1 }, { roundGapMin: 241 }, { idleMin: 5 }
  ]) {
    assert.deepEqual(parseSettings(bad), {}, JSON.stringify(bad))
  }
  assert.deepEqual(parseSettings(null), {})
  assert.deepEqual(parseSettings([1]), {})
  assert.deepEqual(parseSettings("x"), {})
})

test("without settings the machine's defaults hold (GAMES_GAMES, GAMES_THINK_CAP_SEC, GAMES_WORKERS, no wait)", async () => {
  const s = makeSettings({ config: config({ GAMES_WORKERS: "3" }), token: () => TOKEN })
  await s.read()
  assert.deepEqual(s.current(), { gamesPerPair: 2, thinkCapSec: 60, workers: 3, roundGapMin: 0 })
})

test("it reads the window with the token, applies the settings and keeps them for a boot without the window", async () => {
  const c = config()
  answer = { settings: { workers: 3, gamesPerPair: 4, thinkCapSec: 90, roundGapMin: 5 } }
  const s = makeSettings({ config: c, token: () => TOKEN })
  await s.read()
  assert.deepEqual(seen, [{ method: "GET", url: "/api/arena-settings", auth: `Bearer ${TOKEN}` }])
  assert.deepEqual(s.current(), { gamesPerPair: 4, thinkCapSec: 90, workers: 3, roundGapMin: 5 })
  const file = path.join(c.paths.server, "settings.json")
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { gamesPerPair: 4, thinkCapSec: 90, workers: 3, roundGapMin: 5 })
  assert.ok(logs.some((l) => l.includes("[info] arena settings: 4 games per pair, 90 s to think per game, 3 at once, 5 min between rounds")))

  // the window is down: the last settings stay, and a new start reads them from the volume
  answer = { status: 502 }
  const again = makeSettings({ config: c, token: () => TOKEN })
  assert.equal(again.current().workers, 3)
  await again.read()
  assert.ok(logs.some((l) => l.includes("[warning] arena settings: the window answered 502; keeping 4 games per pair")))
  assert.equal(again.current().workers, 3)
  assert.equal(again.current().gamesPerPair, 4)
})

test("a change on the window is read at the next pass; a setting removed there goes back to the default", async () => {
  const s = makeSettings({ config: config(), token: () => TOKEN })
  answer = { settings: { workers: 3 } }
  await s.read()
  assert.equal(s.current().workers, 3)
  answer = { settings: { gamesPerPair: 6 } }
  await s.read()
  assert.equal(s.current().workers, 2)
  assert.equal(s.current().gamesPerPair, 6)
})

test("a failure is logged once per kind, and the recovery once", async () => {
  const s = makeSettings({ config: config(), token: () => TOKEN })
  answer = { status: 500 }
  await s.read()
  await s.read()
  answer = { status: 401 }
  await s.read()
  answer = { settings: {} }
  await s.read()
  await s.read()
  assert.equal(logs.filter((l) => l.includes("the window answered 500")).length, 1)
  assert.equal(logs.filter((l) => l.includes("the window answered 401")).length, 1)
  assert.equal(logs.filter((l) => l.includes("the window answers again")).length, 1)
})

test("a 200 without settings, and a window that does not answer, are failures that keep the settings", async () => {
  const c = config()
  const s = makeSettings({ config: c, token: () => TOKEN })
  answer = { settings: { workers: 4 } }
  await s.read()
  answer = { settings: [1, 2] }
  await s.read()
  assert.ok(logs.some((l) => l.includes("arena settings: the window answered 200; keeping")))
  assert.equal(s.current().workers, 4)
  const down = makeSettings({ config: readConfig({ GAMES_DATA: c.data, SWU_WINDOW: "http://127.0.0.1:1" }), token: () => TOKEN })
  await down.read()
  assert.ok(logs.some((l) => l.includes("arena settings: the window did not answer (")))
  assert.equal(down.current().workers, 4)
})

test("the first boot after the cut reads the old coordinator's settings, and keeps them as its own", async () => {
  const c = config()
  mkdirSync(c.paths.oldCoord, { recursive: true })
  writeFileSync(path.join(c.paths.oldCoord, "settings.json"), JSON.stringify({ workers: 5, roundGapMin: 30, thinkCapSec: 9 }))
  answer = { status: 503 }
  const s = makeSettings({ config: c, token: () => TOKEN })
  assert.deepEqual(s.current(), { gamesPerPair: 2, thinkCapSec: 60, workers: 5, roundGapMin: 30 })
  assert.ok(existsSync(path.join(c.paths.server, "settings.json")))
  // ours wins from now on
  writeFileSync(path.join(c.paths.oldCoord, "settings.json"), JSON.stringify({ workers: 7 }))
  assert.equal(makeSettings({ config: c, token: () => TOKEN }).current().workers, 5)
})

test("without a token there is no authorization header; without a window nothing is asked", async () => {
  const s = makeSettings({ config: config(), token: () => null })
  await s.read()
  assert.equal(seen[0]!.auth, undefined)
  const none = makeSettings({ config: readConfig({ GAMES_DATA: mkdtempSync(path.join(tmpdir(), "games-settings-")) }), token: () => TOKEN })
  seen = []
  await none.read()
  assert.equal(seen.length, 0)
  assert.ok(logs.some((l) => l.includes("no window address")))
})

test("start reads at once and then every settingsMs; close stops it", async () => {
  const c = readConfig({ GAMES_DATA: mkdtempSync(path.join(tmpdir(), "games-settings-")), SWU_WINDOW: windowUrl }, { ...readConfig({}).timing, settingsMs: 50 })
  const s = makeSettings({ config: c, token: () => TOKEN })
  s.start()
  await new Promise((r) => setTimeout(r, 240))
  s.close()
  const n = seen.length
  assert.ok(n >= 3, `read ${n} times`)
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(seen.length, n)
})
