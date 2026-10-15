import assert from "node:assert/strict"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { Effect, Exit, Fiber } from "effect"
import { readConfig, TIMING } from "../../src/games/Config.ts"
import { clearWork, MAX_REPLAY_BYTES, PlayFailed, playLocal, workDir } from "../../src/games/Executor.ts"
import * as Log from "../../src/games/Log.ts"
import { makeProc } from "../../src/games/Proc.ts"
import type { PlaySeedJob } from "../../src/games/Types.ts"

// A fake app folder whose bot/arena/play-seed.js acts by the job's seed, as play-seed.js would on its command line:
// it writes each game's replay into <work>/out and prints one answer line. As root (the machine, and this sandbox)
// it runs as the bots' user inside the real isolate.sh, so every folder on the way must be open to that user.
const repo = path.resolve(import.meta.dirname, "..", "..", "..")
// isolate.sh puts the job's own folder in place of /tmp, so as root the fixture lives elsewhere (on the machine: /data)
const base = process.getuid?.() === 0 && existsSync("/var/tmp") ? "/var/tmp" : tmpdir()
const root = mkdtempSync(path.join(base, "games-executor-"))
chmodSync(root, 0o755)
after(() => rmSync(root, { recursive: true, force: true }))
const app = path.join(root, "app")
mkdirSync(path.join(app, "bot", "arena", "ops"), { recursive: true })
copyFileSync(path.join(repo, "bot", "arena", "ops", "isolate.sh"), path.join(app, "bot", "arena", "ops", "isolate.sh"))
writeFileSync(path.join(app, "bot", "arena", "play-seed.js"), String.raw`
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const arg = (n) => process.argv[process.argv.indexOf('--' + n) + 1]
const job = JSON.parse(fs.readFileSync(arg('job'), 'utf8'))
const work = arg('work')
const out = path.join(work, 'out')
const line = (o) => JSON.stringify(o) + '\n'
const replay = (g) => line({ t: 'header', v: 1, seed: job.seed, players: [{ id: 'p1', bot: g.p1 }, { id: 'p2', bot: g.p2 }] }) +
  line({ t: 'step', n: 0, label: 'Game start' }) + line({ t: 'end', winner: 'p1', round: 2, steps: 9, outcome: 'won', error: null, by: null, faultKind: null })
const result = (g) => ({ seed: job.seed, steps: 9, outcome: 'won', winner: g.p1, winnerSeat: 'p1', round: 2, ms: 7, key: job.key, by: null, faultKind: null, think: { p1: 1, p2: 2 } })
const answer = (results) => process.stdout.write(JSON.stringify({ ok: true, results, replays: Object.fromEntries(job.games.map((g) => [g.id, path.join(out, g.id + '.jsonl')])) }) + '\n')
const seed = job.seed
if (seed === 2) { console.error('play-seed: broken'); process.exit(1) }
if (seed === 3) { process.stdout.write('not json\n'); process.exit(0) }
if (seed === 4) { answer([{ id: job.games[0].id, result: result(job.games[0]) }]); process.exit(0) }
if (seed === 6) {
  // slow: a line every 50 ms, for a long time
  const g = job.games[0]
  const file = path.join(out, g.id + '.jsonl')
  fs.writeFileSync(file, line({ t: 'header', v: 1, seed: job.seed, players: [] }))
  let n = 0
  // half a line at times: only whole ones may come out
  setInterval(() => fs.appendFileSync(file, ++n % 2 ? line({ t: 'step', n }) + '{"t":"st' : 'ep"}\n' + line({ t: 'step', n })), 50)
  setTimeout(() => {}, 60000)
  return
}
for (const g of job.games) {
  const file = path.join(out, g.id + '.jsonl')
  if (seed === 5) fs.symlinkSync('/etc/hostname', file)
  else if (seed === 7) execFileSync('mkfifo', [file])
  else if (seed === 8) fs.writeFileSync(file, Buffer.alloc(${MAX_REPLAY_BYTES} + 1, 10))
  else if (!(seed === 9 && g === job.games[1])) fs.writeFileSync(file, replay(g))
}
const env = Object.keys(process.env).sort()
const self = { argv: process.argv.slice(2), env, cwd: process.cwd(), arena: fs.statSync(path.join(work, 'arena')).mode & 0o777, outMode: fs.statSync(out).mode & 0o777 }
answer(job.games.map((g, i) => ({ id: g.id, result: { ...result(g), ...(i === 0 ? { self } : {}) } })))
`)

const data = mkdtempSync(path.join(root, "data-"))
chmodSync(data, 0o755)
const c = readConfig({ GAMES_DATA: data, GAMES_APP: app }, TIMING)
mkdirSync(c.paths.home, { recursive: true })
const proc = makeProc(c)
const lines: Array<string> = []
Log.setSink((l) => lines.push(l))

const job = (seed: number, games = 2): PlaySeedJob => ({
  v: 1, seed, key: "k".repeat(64), maxSteps: 6000, capMs: 20000, hangMs: 70000, gameMs: 680000,
  games: [{ id: `a-v1-vs-b-v1-${seed}`, p1: "a-v1", p2: "b-v1" }, { id: `b-v1-vs-a-v1-${seed}`, p1: "b-v1", p2: "a-v1" }].slice(0, games),
  bots: { "a-v1": { kind: "wasm", bundle: "a".repeat(64) }, "b-v1": { kind: "wasm", bundle: "b".repeat(64) } }
})

const fails = async (seed: number, why: RegExp) => {
  const exit = await Effect.runPromise(Effect.exit(playLocal(c, proc, job(seed), `t-${seed}`)))
  assert.ok(Exit.isFailure(exit), `seed ${seed} should fail`)
  const e = Exit.findErrorOption(exit)
  assert.ok(e._tag === "Some" && e.value instanceof PlayFailed)
  assert.match(e.value.why, why)
  assert.equal(e.value.stopped, false)
  assert.ok(!existsSync(workDir(c, `t-${seed}`)), "the work folder goes")
}

test("executor: play-seed in its own folder, with exactly its environment; results and replays read back, the folder gone", async () => {
  const played = await Effect.runPromise(playLocal(c, proc, job(1), "t-1"))
  assert.deepEqual(played.results.map((r) => r.id), ["a-v1-vs-b-v1-1", "b-v1-vs-a-v1-1"])
  const self = (played.results[0]!.result as any).self
  const dir = workDir(c, "t-1")
  assert.deepEqual(self.argv, ["--job", path.join(dir, "job.json"), "--bundles", c.paths.bundles, "--work", dir])
  // no NODE_ENV: play-seed must run under the engine's default, 'test', as every hosted game did (isolate.sh's bash
  // adds only its own bookkeeping)
  assert.deepEqual(self.env.filter((k: string) => !["_", "PWD", "OLDPWD", "SHLVL"].includes(k)), ["HOME", "LANG", "PATH", "SWU_WASM_CACHE", "TZ"])
  assert.equal(self.cwd, app)
  assert.equal(self.arena, 0o700)
  assert.equal(self.outMode, 0o700)
  assert.match(played.replays["a-v1-vs-b-v1-1"]!, /^\{"t":"header".*\n.*\n\{"t":"end".*\n$/)
  assert.equal(Object.keys(played.replays).length, 2)
  assert.ok(!existsSync(dir))
  assert.equal(readdirSync(c.paths.procs).length, 0)
})

test("executor: a game without a replay (a bot that did not load) is kept without one", async () => {
  const played = await Effect.runPromise(playLocal(c, proc, job(9), "t-9"))
  assert.equal(played.results.length, 2)
  assert.deepEqual(Object.keys(played.replays), ["a-v1-vs-b-v1-9"])
})

test("executor: a failed run, no answer, a missing result, a linked or FIFO replay all fail the job", async () => {
  await fails(2, /exited 1/)
  await fails(3, /no JSON line/)
  await fails(4, /no result for b-v1-vs-a-v1-4/)
  await fails(5, /not a file the server reads/)
  await fails(7, /not a plain file/)
})

test("executor: a replay over the cap is left out, its game kept", async () => {
  const played = await Effect.runPromise(playLocal(c, proc, job(8), "t-8"))
  assert.equal(played.results.length, 2)
  assert.deepEqual(played.replays, {})
  assert.ok(lines.some((l) => /its replay is over/.test(l)))
})

test("executor: whole lines come out while a game plays; interrupted, the child stops and the folder goes", async () => {
  const got: Array<{ id: string; from: number; text: string }> = []
  await Effect.runPromise(Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(playLocal(c, proc, job(6, 1), "t-6", { everyMs: 30, onLines: (id, from, text) => got.push({ id, from, text }) }))
    for (let i = 0; i < 300 && got.length < 3; i++) yield* Effect.sleep(20)
    assert.ok(got.length >= 3, "lines came out while it played")
    assert.deepEqual(proc.running(), ["play"])
    yield* Fiber.interrupt(fiber)
  }))
  assert.deepEqual(proc.running(), [])
  assert.ok(!existsSync(workDir(c, "t-6")))
  assert.equal(got[0]!.from, 0)
  let at = 0
  for (const x of got) {
    assert.equal(x.id, "a-v1-vs-b-v1-6")
    assert.equal(x.from, at, "each piece goes right after the one before")
    assert.ok(x.text.endsWith("\n"), "whole lines only")
    for (const l of x.text.trimEnd().split("\n")) JSON.parse(l)
    at += Buffer.byteLength(x.text)
  }
})

test("executor: stopping while it plays reads as stopped, and job folders an earlier run left are cleared", async () => {
  const exit = await Effect.runPromise(Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(Effect.exit(playLocal(c, proc, job(6, 1), "t-stop")))
    for (let i = 0; i < 300 && !proc.running().includes("play"); i++) yield* Effect.sleep(20)
    yield* proc.stopAll([], 500)
    return yield* Fiber.join(fiber)
  }))
  const e = Exit.findErrorOption(exit)
  assert.ok(e._tag === "Some" && e.value.stopped)
  mkdirSync(path.join(c.paths.work, "r3-11-2", "out"), { recursive: true })
  mkdirSync(path.join(c.paths.work, "replay-1"), { recursive: true })
  assert.equal(clearWork(c, /^r\d+-\d+-\d+$/), 1)
  assert.deepEqual(readdirSync(c.paths.work), ["replay-1"])
  assert.equal(statSync(c.paths.work).isDirectory(), true)
})
