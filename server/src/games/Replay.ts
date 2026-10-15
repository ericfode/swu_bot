/**
 * STUB (part D replaces this file): the done-check. Plays a recorded round again from its seeds and compares.
 */
import type { Effect } from "effect"

/** `node src/main-games.ts replay ...`; resolves the process's exit code (0 when every compared game came out the same). */
export declare const runReplay: (argv: ReadonlyArray<string>) => Effect.Effect<number>
