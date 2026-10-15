// The entry point the image runs: a helper stopped by a signal says so in the words helper-tui.js reads for its
// stopping phase (the Elixir helper's BEAM printed them), and exits 0.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"

const repo = path.resolve(import.meta.dirname, "..", "..", "..")
const root = mkdtempSync(path.join(process.getuid?.() === 0 && existsSync("/var/tmp") ? "/var/tmp" : tmpdir(), "games-main-"))
chmodSync(root, 0o755)
after(() => rmSync(root, { recursive: true, force: true }))

test("main-games: a helper stopped with SIGTERM logs 'SIGTERM received' and exits 0", { timeout: 120_000 }, async () => {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    COORD_ROLE: "helper",
    // nothing listens on port 9: hello keeps retrying until the stop
    GAMES_HELPER_URL: "http://127.0.0.1:9",
    GAMES_HELPER_SLOTS: "1",
    GAMES_HELPER_TOKEN: "t".repeat(40),
    GAMES_DATA: path.join(root, "data"),
    GAMES_APP: repo,
    GAMES_BUILD: "test1234",
    GAMES_CARDS: "cards1234"
  }
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(repo, "server", "src", "main-games.ts")], {
    env, stdio: ["ignore", "pipe", "pipe"]
  })
  let out = ""
  child.stdout.setEncoding("utf8").on("data", (s: string) => (out += s))
  child.stderr.setEncoding("utf8").on("data", (s: string) => (out += s))
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)))
  // once it is asking the machine, it is in its loop
  const started = Date.now()
  while (!/hello: no answer/.test(out) && Date.now() - started < 90_000) await new Promise((r) => setTimeout(r, 100))
  assert.match(out, /hello: no answer/)
  child.kill("SIGTERM")
  assert.equal(await exited, 0)
  assert.match(out, /SIGTERM received - shutting down/)
})
