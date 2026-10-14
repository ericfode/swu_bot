/**
 * Replays, kept for every game for good: what people watch and the engines' test corpus. Each is a gzipped JSONL file
 * in ARENA_DATA/replays/<round>/<game>.jsonl.gz; the games table keeps its path, its size and the sha256 of its text.
 */
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { gzipSync } from "node:zlib"
import { Context, Effect, Layer } from "effect"
import { dataDir } from "./Db.ts"

export interface Stored {
  /** Relative to the replays folder. */
  readonly path: string
  /** Of the text, not the gzip. */
  readonly bytes: number
  readonly sha256: string
}

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._#@+-]{0,159}$/

export class Replays extends Context.Service<Replays, {
  /** Gzips and stores a replay's text (written whole, then renamed into place). */
  readonly put: (round: string, game: string, text: Uint8Array) => Effect.Effect<Stored>
  /** The gzipped file, or null when it is missing. */
  readonly get: (stored: string) => Effect.Effect<Uint8Array | null>
  /** Where a stored replay's file is, for a process that reads it (bot/trace.js); null for a path that is not one. */
  readonly pathOf: (stored: string) => string | null
}>()("arena/Replays") {
  static readonly layerAt = (root: string) =>
    Layer.sync(Replays, () => {
      const put = Effect.fn("Replays.put")(function*(round: string, game: string, text: Uint8Array) {
        if (!SAFE.test(round) || !SAFE.test(game)) return yield* Effect.die(new Error(`unsafe replay name ${round}/${game}`))
        const rel = `${round}/${game}.jsonl.gz`
        const file = path.join(root, rel)
        yield* Effect.sync(() => {
          mkdirSync(path.dirname(file), { recursive: true })
          writeFileSync(`${file}.tmp`, gzipSync(text))
          renameSync(`${file}.tmp`, file)
        })
        return { path: rel, bytes: text.length, sha256: createHash("sha256").update(text).digest("hex") }
      })
      const pathOf = (stored: string) => {
        const [round, name] = stored.split("/")
        return stored.split("/").length === 2 && SAFE.test(round) && SAFE.test(name) ? path.join(root, stored) : null
      }
      const get = (stored: string) =>
        Effect.sync(() => {
          const file = pathOf(stored)
          if (file === null) return null
          try {
            return new Uint8Array(readFileSync(file))
          } catch {
            return null
          }
        })
      return Replays.of({ put, get, pathOf })
    })

  /** ARENA_DATA/replays. */
  static readonly layer = Layer.unwrap(Effect.gen(function*() {
    return Replays.layerAt(path.join(yield* dataDir, "replays"))
  }))
}
