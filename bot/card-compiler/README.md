# Card compiler

This pipeline discovers every downloaded card definition and every pinned engine
card source. It converts a bounded subset of the TypeScript ability DSL into
`swu-card-ir/v1`, a data-only format interpreted by the Rust simulator. It does
not execute TypeScript callbacks, embed JavaScript in Rust, or select behavior by
card ID. Adding a card that uses supported source patterns needs no compiler edit.

**Inventory, source conversion, and executable support are separate facts.**
Every discovered card appears in the catalog. A source-converted card can still
require an operation the Rust runtime has not implemented. The runtime must
validate all its abilities, keywords, types, targeting, and state before admitting
it. The current catalog is not an all-card implementation of SWU.

## Run locally

Use Node 22 and the normal repository setup. The parser uses the TypeScript
version already installed by the pinned `forceteki` dependency.

```sh
node bot/card-compiler/build.js
node bot/card-compiler/build.js --check
node --test bot/card-compiler/test/*.test.js
```

`--check` recomputes all outputs and exits 1 if a generated file is missing or
stale, including when a new card or engine source appears. `--strict` exits 2 if
any known card remains unconverted; this deliberately does not pass yet. The
normal generation command succeeds with explicit unsupported entries so that a
new rule family cannot prevent already understood cards from being updated.

The optional `--source`, `--cards`, and `--out` arguments accept another engine
server directory, downloaded card-data directory, and output directory. For
example, a fixture source directory contains `game/cards/*.ts` and its data
directory contains `Card/*.json` plus `_mockCardNames.json`.

## Generated artifacts

- `generated/catalog.json` contains every nonmock card's full metadata, compiled
  abilities, keyword values, required capabilities, and source/data hashes.
- `generated/coverage.json` separates `sourceAstConverted` from `dataOnlyConverted`
  (plain bases and fully parsed keyword-only units with no source class), and lists
  all converted IDs, every blocked card, and blockers
  grouped by source pattern. `runtimeReady: null` means this report has not
  measured runtime acceptance.
- `generated/coverage.md` is a readable version of the source conversion report.

A rejected definition carries a pattern, file, line, and column. Partial
abilities may be retained for inspection, but `status: "unsupported"` rejects the
whole card. They must never be played as the subset of rules that happened to
compile. Unmatched sources and shared base files remain in the source inventory;
test mocks are counted separately. A compiler exception fails the build rather
than being relabeled as a normal unsupported pattern.

Provenance covers all engine server TypeScript, every card JSON file, the mock
list, compiler JavaScript, and its keyword-parser dependency. Outputs have no
timestamps or absolute machine paths, so identical inputs produce identical
bytes. The catalog also records the TypeScript parser version.

## Conversion boundary

The compiler lowers declarative action, event, when-played, on-attack,
when-defeated, and related registrations. It preserves costs, conditions,
targeting, continuations, dynamic amounts, and distinct sequential/simultaneous
effects. It understands bounded expression trees, enum values, readonly callback
locals, and an explicit query vocabulary. Display-only titles are rendered as
plain text; dynamic title values become placeholders and are not executed.

It rejects unknown fields, custom class state/methods, constructors, accessors,
module execution, activation limits, unsupported effect helpers, and mutable or
side-effecting callbacks. Constant abilities, arbitrary event watchers, lasting
effects, custom inheritance, many zones, and many other rule families remain
work items in the coverage report. The Rust operation set is narrower still.
In particular, source conversion of a simultaneous effect does not imply that
Rust implements an event batch.

Continuation factories that capture a target across new targeting, or dynamic
values across multiple effects, are rejected until the IR has explicit capture
slots. Unused local initializers are rejected so their possible side effects
cannot disappear. General JavaScript closure semantics are not implemented.

The three original leader definitions are compiled from their actual source,
using exactly the same path as new cards. Native engine tokens, such as Shield,
may have an independently verified runtime implementation while their source
class still appears as unconverted; the source report does not count those as
AST-converted.

## Extending support

1. Choose a blocker family in `generated/coverage.json` and inspect the pinned
   engine helper semantics, including defaults and legal-target behavior.
2. Add a typed lowering rule. Preserve distinctions such as basic units versus
   token units, optional targeting, event timing, and conditional continuations.
3. Add runtime support or leave an explicit runtime rejection. Never weaken the
   importer merely to increase an accepted-card count.
4. Add a small synthetic-source compiler test and a real engine differential
   fixture for the newly executable behavior. Run the relevant Rust tests and
   trace comparison before claiming gameplay support.
5. Regenerate all artifacts and run `--check`. The resulting coverage changes
   are reviewable alongside the implementation.

## Runtime admission and conformance

```sh
target/debug/omni-rs catalogue bot/card-compiler/generated/catalog.json --out-pool bot/card-compiler/generated/runtime-pool.json
target/debug/omni-rs check traces.jsonl.gz --catalogue bot/card-compiler/generated/catalog.json --pool bot/card-compiler/generated/runtime-pool.json
node bot/omni/rs/make-compiled-fixtures.js --out replays/compiled-card-fixtures
```

`catalogue` emits a deterministic admission report, including named rejection
reasons. `check`, `prove`, and `bench` accept `--catalogue` and an optional matching
pool. Omitting the catalog retains the original strict pool behavior.

The fixture generator records real engine games across four bot pairings plus
explicit effect/continuation decks, and preserves the exact pool beside them.
Its observed-card/effect report describes what ran in JavaScript; only a passing
Rust `check` establishes differential agreement for those traces. Admission of a
card alone does not establish conformance of all that card's interactions.

Repository CI regenerates conversion/admission artifacts and runs the existing
checks; it does not use model calls or alter engine source. Use `npm run
cards:compile`, `npm run cards:check`, and `npm run cards:test` locally. New syntax
within supported rules converts automatically, while unsupported families remain
named work items.

The separately configured daily local Codex job is authorized to implement and
push tested conversion/runtime increments. That local schedule is not repository
CI configuration. Each new executable family still requires real-engine
comparison before its coverage is claimed.

The committed expanded corpus in `../omni-rs/tests/compiled-fixtures/` currently
passes all 16 games: 3,748 decisions and 1,274 action windows. It actually plays
110 distinct cards, 40 with compiled ability programs, and records positive
witnesses for all eight primitive effect families. This is distinct from the
450-card runtime admission list.
