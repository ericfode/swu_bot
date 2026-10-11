---
name: swu-card-conversion
description: Extend swu_bot TypeScript card conversion and Rust/Wasm execution in measured batches, with real-engine semantic witnesses and tested push receipts. Use for this repository's card migration work.
---

# Card conversion batches

Read `CLAUDE.md`, `bot/card-compiler/README.md`, and relevant compiler/runtime code. Use Node 22. Keep engine tracked source unchanged. Follow the user's current batch size and model settings; when they request GPT-6.1 Sol low-effort workers, use that model and effort explicitly with minimal task context. Delegate disjoint compiler/runtime families and integrate before claiming progress.

## Establish the batch

Regenerate conversion and admission artifacts before taking the baseline. `tools/card-batch.js` is accounting, not a test runner:

Its snapshot verifies pool inventory and metadata against admission/catalogue, and distinguishes the runtime's canonical JSON hash from exact artifact-byte hashes. A readable pool file with a recorded hash can still be stale; never bypass this consistency check.

```sh
node tools/card-batch.js snapshot bot/card-compiler/generated > /tmp/card-before.json
node tools/card-batch.js select /tmp/card-before.json 100 /tmp/chosen-ids.json > /tmp/card-manifest.json
```

The chosen IDs file is a JSON array of set codes. Select achievable semantic families from named blockers; the optional default alphabetical selection is only a queue convenience. A family prototype can establish feasibility before selecting a full batch. Preserve the original baseline, record `selectionTiming` honestly (before implementation or after exploratory prototypes), and freeze the selected manifest for accounting. Never present a retrospective selection as a prospective trial. Exactly 100 queued cards does not fulfill a request for 100 implemented cards. If fewer become executable, report the shortfall and explicit blockers, then continue authorized work. Do not silently replace failed candidates or count already admitted cards.

Declare which manifest governs final accounting. Preserve and label helper demonstrations or exploratory queues separately; explicitly retire their authority when adopting a final retrospective selection. An unfinalized alphabetical demo queue is not the user's requested card list.

Each worker receives: owned files, concrete source family and candidate IDs, engine helper definitions/defaults, existing analogous lowering/runtime rule, required real-engine witness, and exact checks. A broad pattern is not a semantic specification. Inspect costs, timing, optionality, legal targets, zones, token distinctions, dynamic values and continuation captures before lowering it. Reject unsupported fields and partial cards; never add no-op implementations, card-ID special cases, or relax importer admission to improve counts.

## Prove the behavior

For each newly executable family add a small synthetic compiler test and real-engine differential cases. Require a positive witness where the effect actually changes state, plus applicable optional/no-target and interaction witnesses that distinguish the proposed semantics from plausible wrong implementations. Existing admitted cards and traces that merely draw or hold a card are insufficient. Exercise shared semantic distinctions per family; avoid duplicating every edge case for every card.

Make fixture generation assert the intended observed outcome. For example, a phase HP expiry case must observe the damaged unit alive with its bonus, then defeated after expiry; a damage sequence that kills it beforehand is a different witness. Explicit initial positions must include engine invariants such as a deployed leader's spent epic action, and refresh legal prompts before recording normal inputs.

The first batch exposed these distinctions; check them when extending these families:

- Arena-query callback `card` is the iterated unit; `context.target` stays the outer chosen target. Test with differing powers and mixed ground/space arenas.
- Phase expiry must select the complete lethal set before defeating any member; removing an aura source during incremental selection can incorrectly save another unit. Assert both deaths when phase HP bonuses expire under Snoke.
- Nested `selectCard` optionality, cancellation and no-target behavior have their own engine prompt protocol. Compare complete canonical action sets, including button arguments and labels.
- Source registrations and keyword triggers can share a prompt. Preserve engine ordering, and test new leader deployment keywords as well as ordinary unit play.
- Unique replacement precedes incoming aura activation and incoming stat-death checks. Offer both copies before resolving the choice; keep-old/keep-new can differ. Capture eligible When Played triggers before the defeat subwindow: a defeated source can still draw, while a self-only upgrade cannot rescue a source already defeated. Use explicit engine witnesses for each distinction.

Use `make-phase-fixtures.js`, `make-constant-fixtures.js`, `make-query-fixtures.js`, and `make-leader-fixtures.js` in `bot/omni/rs/` for targeted cases. `make-batch-play-fixtures.js` records per-card engine `onCardPlayed` witnesses and completed games; it leaves non-hand cards explicitly requiring dedicated cases and does not claim their semantics from play alone. Keep immutable pools/traces and SHA indexes under `bot/omni-rs/tests/card-batches/`. Native and Wasm CI compare every indexed receipt against the current generated programs, so compiler changes are checked too.

Record a family witness ledger: family, candidate IDs, fixture path/hash, observed effect/decision, relevant negative/interaction case, native check command/result, Wasm check command/result. Fixture generation and observed-card reports do not establish agreement. Admission alone does not establish conformance of a card's complete interaction space. Keep untested families explicitly unassessed.

The pinned engine source and generated engine build must belong to the same input snapshot. A shared submodule's `build/` can be changed by another writer without changing the superproject HEAD. Inspect actual engine revision and dirty source/build state; isolate a pinned engine copy if concurrent writers exist. Generate JS receipts and the catalog from the same engine snapshot. Do not compare stale traces to an unrelated pool/catalog merely because both files exist.

Run compiler tests, relevant Rust tests, generated-output checks, and native plus Wasm differential checks for both the original 100-card corpus and expanded compiled corpus (historically 450 admitted cards; inspect current pool rather than hard-coding it). Existing native corpus tests are `conformance.rs` and `compiled_conformance.rs`; Wasm checker is `bot/omni/wasm/check.js` with matching `--pool` and `--catalogue` for compiled traces. Rebuild native/Wasm after runtime edits. Check every generated game completed; the seed gate's exit status alone does not assert outcomes. Respect current user instructions concerning Perch.

Immutable trace hashes prove the oracle inputs stayed fixed; they do not prove the tested runtime is fresh. Record current source/commit identity, native and Wasm build commands, binary hashes and fresh check receipts against the final catalog/pools. Rebuild and rerun relevant comparisons after fixes; earlier passing outputs or an old Wasm package cannot authorize a push of changed code.

```sh
node tools/card-batch.js snapshot bot/card-compiler/generated > /tmp/card-after.json
node tools/card-batch.js report /tmp/card-before.json /tmp/card-after.json /tmp/card-manifest.json > /tmp/card-report.json
```

Review every per-card outcome, outside-batch gains, and admission regression. Source-converted, runtime-admitted, and witnessed differential behavior are three separate measures. The helper deliberately leaves conformance unassessed. Report the number requested, queued, newly executable, source-only, blocked, and families actually witnessed; do not call an incomplete batch done.

## Commit and push authorized batches

For this migration, use an independent GPT-6.1 Sol reviewer at high effort (higher for complex semantics) before push, even when implementation workers use low effort. Give the reviewer raw changed source, pinned engine semantics, tests and differential receipts. Resolve findings with tests and real-engine comparisons; block uncertain semantics instead of admitting them. Record what was actually verified. Passing finite traces cannot promise correctness across every possible interaction.

Commit implementation, tests, regenerated artifacts and batch evidence together. Record exact tested SHA, engine revision/input hashes, catalog/pool/fixture hashes, commands and exit results, and remaining blockers. Push only when the user has authorized it. Read the actual remote branch SHA after push and compare it with the tested commit; record the branch, tested SHA and remote SHA. A changed HEAD or uncommitted implementation after testing requires new relevant checks before push.

After the first real batch, refine this skill only for demonstrated decision failures. Forward-test meaningful revisions with an independent worker using the requested model/effort and raw artifacts, without supplying the intended answer. Validate frontmatter with the skill-creator quick validator. Schema validation proves formatting, not reliable low-effort behavior; report forward-test limitations honestly.
