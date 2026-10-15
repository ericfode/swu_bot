/**
 * Tokens, taken out of the environment at boot (Coord.Secrets): nothing this process starts may inherit them, and a
 * child's environment is built from nothing anyway (Proc.ts). The values live in closures; nothing here logs a token,
 * a hash of one, or a nonce.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

/** Every name a token or a Fly credential could arrive under. */
export const SECRET_NAMES = [
  "SWU_WINDOW_TOKEN",
  "ARENA_PUSH_TOKEN",
  "ARENA_ADMIN_TOKEN",
  "ARENA_READ_TOKEN",
  "ARENA_IMPORT_TOKEN",
  "RELEASE_COOKIE",
  "FLY_API_TOKEN",
  "GAMES_HELPER_TOKENS",
  "GAMES_HELPER_TOKEN"
] as const

const HELPER_NAME = /^[a-z][a-z0-9_-]{0,31}$/
const HEX64 = /^[0-9a-f]{64}$/

export interface Secrets {
  /** the window token, or null when none was given (off the machine) */
  readonly windowToken: () => string | null
  /** the helper whose token this is, or null (constant time over every entry) */
  readonly helperName: (token: string) => string | null
  /** helper names with a token (the helper node is on only with at least one) */
  readonly helpers: ReadonlyArray<string>
  /** the helper role's own token */
  readonly helperToken: () => string | null
  /** per-boot nonces for the window proxy's two paths */
  readonly nonces: { readonly push: string; readonly intake: string }
}

const nonce = () => randomBytes(32).toString("base64url")

/**
 * Parses GAMES_HELPER_TOKENS (`name:sha256hex,...`). A bad entry is reported by its 1-based position only: it may hold
 * a pasted token.
 */
export const parseHelperTokens = (value: string | undefined, warn: (msg: string) => void = () => {}) => {
  const out: Array<{ name: string; hash: Buffer }> = []
  const entries = (value ?? "").split(",").map((s) => s.trim())
  entries.forEach((entry, i) => {
    if (!entry) return
    const at = entry.indexOf(":")
    const name = at < 0 ? "" : entry.slice(0, at)
    const hash = at < 0 ? "" : entry.slice(at + 1)
    if (!HELPER_NAME.test(name) || name === "machine" || !HEX64.test(hash)) {
      warn(`GAMES_HELPER_TOKENS: entry ${i + 1} is not name:sha256-hex with a usable name; it is ignored`)
      return
    }
    out.push({ name, hash: Buffer.from(hash, "hex") })
  })
  return out
}

/** Takes every secret out of `env` (deleting them) and keeps the ones this role uses. */
export const takeSecrets = (env: NodeJS.ProcessEnv = process.env, warn: (msg: string) => void = () => {}): Secrets => {
  const window = env.SWU_WINDOW_TOKEN || null
  const helperToken = env.GAMES_HELPER_TOKEN || null
  const entries = parseHelperTokens(env.GAMES_HELPER_TOKENS, warn)
  for (const k of SECRET_NAMES) delete env[k]
  const helperName = (token: string): string | null => {
    // shorter tokens never match, so the hash of an empty or short token cannot be a key
    if (typeof token !== "string" || Buffer.byteLength(token) < 32) return null
    const h = createHash("sha256").update(token).digest()
    let found: string | null = null
    for (const e of entries) {
      if (timingSafeEqual(h, e.hash) && found === null) found = e.name
    }
    return found
  }
  return {
    windowToken: () => window,
    helperName,
    helpers: [...new Set(entries.map((e) => e.name))],
    helperToken: () => helperToken,
    nonces: { push: nonce(), intake: nonce() }
  }
}

/** Compares two strings in constant time (for nonces in paths). */
export const sameSecret = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
