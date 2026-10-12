# Card compiler

This pipeline discovers every downloaded card definition and every pinned engine
card source. It converts a bounded subset of the TypeScript ability DSL into
`swu-card-ir/v1`, a typed data-only rules language consumed by the Rust simulator.
Its build-time backend emits executable Rust for supported programs; other
validated programs retain explicit interpreter or live-modifier fallback. It does
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

Provenance covers all engine server TypeScript and JavaScript, every card JSON file, the mock
list, compiler JavaScript, and its keyword-parser dependency. Outputs have no
timestamps or absolute machine paths, so identical inputs produce identical
bytes. The catalog also records the TypeScript parser version.

## Conversion boundary

The compiler lowers declarative action, event, when-played, on-attack,
when-defeated, and related registrations. It preserves costs, conditions,
targeting, continuations, dynamic amounts, and distinct sequential/simultaneous
effects. It understands bounded expression trees, enum values, readonly callback
locals, and an explicit query vocabulary. Supported trigger-menu `contextTitle`
expressions retain live scalar values in a bounded fragment list. Static text
helpers preserve engine formatting, including numeric keywords and multiword
traits; unknown helpers and unsupported dynamic expressions are rejected.

Phase stat modifiers capture bounded signed power/HP values when applied and
expire together at phase end. Constant stat modifiers support static self and
aura bonuses with bounded conditions and target filters. Arena count/existence
queries preserve their outer target separately from each queried card. Live
stat calculations and stat-dependent constant conditions remain rejected.

Constant and phase effects can grant or remove the supported core keywords.
Numeric Raid and Restore stack, while boolean keywords track presence. Live
numeric conditions are restricted to supported queries; keyword dependency
cycles and unsupported duration/value shapes remain rejected. Intrinsic
keywords require the engine's printed-text match: a keyword in the downloaded
metadata may only be mentioned or granted to another card.

Standard self-defeat registrations retain their source and controller through
zone movement and nested trigger windows. Standard multi-trigger aliases use
the same programs. Printed Coordinate enables supported constant and on-attack
abilities at three friendly arena units, including tokens; on-attack eligibility
is captured when the attack is declared.

Unit-token creation supports Battle Droid, Clone Trooper, Beast, Spy, TIE Fighter
and X-Wing tokens, one to five at a time, for either player, with explicit ready
entry. Token allocation precedes entry, and tokens leaving play stay out of
ordinary hands and discard piles. Scalar hand-discard effects let the affected
player choose their own cards. Their inherited default target is the opponent;
the helper's name does not imply a friendly target. Player selectors remain
rejected until their selected-player context can be preserved.

Force token state records each player's persistent token ID and whether it is
held. Gain, spend, and regain reuse that identity without allocating a card; the
two players remain independent across phase changes. Full-state export includes
`forceStateVersion: 1` and `players.<seat>.forceToken: { id, held }`, including
tokens outside play. Imports validate canonical, distinct IDs against the full
card inventory. Markerless legacy snapshots remain valid only for selected pools
that cannot reach Force abilities; held state and reachable Force abilities
require the reviewed native token in the selected pool.

The first executable Force registrations are ordinary-unit When Played:
mandatory gain, or optional use followed by a successful draw-two or self-ready
continuation. They preserve captured source identity through unique replacement.
These operations use the validated interpreter fallback in Auto mode. Other
Force targets, costs, queries, events, groups, hooks, and continuations remain
explicit rejections. Source conversion and runtime admission remain separate.

Bounded simultaneous groups preserve separate event preparation and resolution.
The runtime supports selected combinations of damage, healing, tokens, readiness,
and phase modifiers, with independent nested selections. Up-to selections retain
click order, toggles, and zero selections; unlimited selection is currently
restricted to the two bases. A single phase-effect call with several modifiers
remains one lasting effect. Group admission rejects unsupported continuations,
ambiguous repeated damage, and reference scopes the runtime cannot preserve.
Supported draw/discard groups prepare choices before resolving their effects.
Mixed damage with hand effects or newly created unit tokens remains rejected.
The runtime checks its bounded storage and fails explicitly on overflow.

It rejects unknown fields, custom class state/methods, constructors, accessors,
module execution, activation limits, unsupported effect helpers, and mutable or
side-effecting callbacks. Other constant abilities, arbitrary event watchers,
other lasting effects, custom inheritance, many zones, and many other rule families remain
work items in the coverage report. The Rust operation set is narrower still.
Source conversion of a simultaneous effect does not imply runtime support for
every operation or interaction in that group.

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

See the [card catalog and reference-test guide](../cards/README.md) for card,
behavior, and test queries; reusable Karabast generation; and native/Wasm checking.
The compiler remains the authoritative source of metadata and ability IR, while
`../cards/` joins it with runtime admission and named semantic cases. Accepted
recordings live in `../cards/reference/fixtures/` and are checked by both runtimes
in CI. Work chronology and review journals do not define card coverage.

The original strict-pool and compiled-runtime integration corpora remain useful
smoke tests for their loading modes. Current counts come from `npm run cards --
summary` and `generated/runtime-admission.json`, rather than historical batch totals.

Follow the repository-local [conversion skill](../../.agents/skills/swu-card-conversion/SKILL.md)
for implementation, source-derived witnesses, and independent review requirements.
