# Automatic card pipeline

```mermaid
flowchart LR
  Source["Pinned source + printed card"] --> Compile["Deterministic typed lowering"]
  Compile --> IR["Extensible rules IR"]
  IR --> AOT["Cargo build: generated Rust"]
  IR --> Interpreter["Validated interpreter"]
  IR --> Planner["Generic experiment planner"]
  Planner --> Oracle["Karabast: actual choices and outcomes"]
  Oracle --> Compare["Native AOT/Interpreter + Wasm comparison"]
  AOT --> Compare
  Interpreter --> Compare
  Compare --> Coverage["Witnessed obligations + uncovered behavior"]
  Source --> Review["Independent LLM semantic review"]
  IR --> Review
  AOT --> Review
  Coverage --> Review
```

Run from the repository root with Node 22 and normal engine/Rust/Wasm setup:

```sh
npm run cards:pipeline -- plan --cards TWI_124,TWI_170,JTL_052
npm run cards:pipeline -- run --cards TWI_124,TWI_170,JTL_052 --out /tmp/card-pipeline-run
npm run cards:pipeline -- review --run /tmp/card-pipeline-run --file /tmp/semantic-review.json
npm run cards:reference -- import --corpus /tmp/card-pipeline-run/reference
```

`run` requires a fresh directory. It compiles all source configuration, chooses the
requested cards, builds native and Wasm against that exact catalog, constructs
real-engine experiments, compares complete actions/states/results in three modes,
and tries deliberately wrong configurations. It produces a review packet; an
LLM still has to review it. The repository conversion skill supplies that stage
through Codex's independent reviewer. No model is called during compilation,
fixture construction, replay comparison, mutation testing or CI.

Output includes `catalog.json`, `executable-plan.json`, immutable `reference/`,
`check-*.json`, `dispatch-*/`, `report.json`, and `review/packet.json` plus complete
source artifacts. A failed run keeps a partial report with uncovered work. The
`review` command checks the packet digest, source artifact hashes, complete card
coverage, and explicit assessments of uncovered obligations before writing
`reviewed-report.json`. It does not authenticate an external model provider.

## The rules language and its extension boundary

`swu-card-ir/v1` is a domain language: typed expressions, explicit receiver and
selected-target bindings, selectors, costs, triggers, effects, ordered steps,
conditional branches, grouped event preparation and continuations. Cards remain
data. There is no card-ID switch or JavaScript callback running inside search.
Program content determines generated execution, with canonical bytes checked as
well as the content hash. Reprints and equivalent cards share executable content.

The language must be extendable to every card. The current operation set is not
that complete language yet. Add missing concepts as reusable typed primitives:
new zones and queries; explicit capture slots; arbitrary event subscriptions;
replacement/prevention stages; delayed effects with lifetime/cleanup; controlled
movement, ownership and copying; and event-result bindings. For each extension,
update source lowering, type/capability validation, interpreter semantics, AOT
lowering, experiment construction, and semantic review obligations. Unsupported
operations stay named rejections or explicit backend fallbacks. Storage limits
are runtime capacity choices to revise with evidence, not limits on which cards
can be represented by a future language version.

The first AOT backend emits executable Rust for scalar draw, damage, healing,
ready/exhaust, no-action and phase-stat operations with supported constant
expressions and step control. Shared engine primitives still manage targeting,
legal choices, commits, defeats and prompts. Dynamic expressions, grouped
operations and constant/live modifiers currently use their validated runtime
paths. Reports name these boundaries. A static table of instructions alone would
not count as generated execution; dispatch receipts show actual generated steps.

```sh
target/release/omni-rs rules --catalogue bot/card-compiler/generated/catalog.json
target/release/omni-rs check TRACE --pool POOL --catalogue CATALOG --backend interpreter
target/release/omni-rs check TRACE --pool POOL --catalogue CATALOG --backend auto --rules-receipt /tmp/dispatch.json
```

Auto selects generated code when the exact program was present at build time;
otherwise the report names the interpreter fallback. Interpreter bypasses the
new generated execution. Strict `aot` rejects any program in the selected pool
that requires fallback, including constants. `SWU_RULES_CATALOGUE=FILE` selects
the catalog at Cargo build time; the pipeline sets it for both binaries. There
is no runtime JIT, parser or scripting VM on the generated instruction path.
Instrumentation is opt-in and disabled for ordinary play/search/benchmarks.
Compilation is a performance opportunity, not an assurance of faster search;
compare equal-work search results and binary size when extending code generation.

## Experiments and coverage

The planner operates on rule structure. The initial construction vocabulary
handles simple targeted constant damage and phase stat events, standalone phase
stat and defeat events over filtered arena lists, self stat modifiers whose power
depends on damage, and bounded cost-query conditions for discard, upgrade defeat,
death-triggered ready and upgrade attachment. Scalar upgrade-return experiments
cover ordinary and token attachments, ownership across host controllers, discard
recovery, cost and uniqueness filters, base-trait conditions, optional decline,
and host death after losing an attachment HP bonus. On Defense experiments cover
attacker-owned trigger ordering, Restore, Saboteur removing specific Shields,
ordinary Ambush play, a captured defense trigger after lethal On Attack damage,
optional Experience, cross-arena unit choices, readiness and terminal own-base
damage. Initial attack stat deaths and nested ability-caused deaths also have
separate synthetic diagnostics; those are not printed-card reference witnesses.
Controller changes, multi-target attacks and token-entry aura deaths remain
explicit gaps for this family. It selects setup cards from metadata,
uses ordinary engine actions after a disclosed starting position, and records
oracle observations. Arena-list defeat experiments exercise global entry order,
death draws, reverse cleanup across multiple parents, token removal and eligible
leader undeployment. Arena-list stat experiments exercise mixed controllers and
arenas, empty sets, expiry and simultaneous lethal targets. Aura-dependent timing
and unconstructed interactions remain explicit gaps for each family. It does not compute expected game outcomes from the IR.
Positive targeting, ownership/arena differences, damaged and lethal targets,
bases, invalid hand targets, no eligible units, phase expiry, initial stat values
and live damage changes have construction adapters. Other shapes remain visible
as uncovered obligations. This is extensible experiment generation, not exhaustive
state-space exploration.

Hidden experiments distinguish ordinary play from arena placement, observe phase
expiry, and compare ordinary and Saboteur attack menus. Actual source programs
exercise grants to previously played versus staged units, trait/controller/arena
filters, grant-source departure, conditional base traits, intrinsic Raid and
Saboteur combat, defense returns with Overwhelm, death exhaustion, live resource
counts, Hidden queries after expiry and their three-target limit, and healing
continuations based on actual damage healed. Full states carry explicit phase
history for every arena unit. Keyword-only Hidden units use their complete printed
text and metadata as the source, with actual Shielded play and Raid, Grit, Restore,
Overwhelm, Saboteur and Ambush combat where those keywords are present.
Synthetic grant/removal, Sentinel, reentry and
history-import checks remain separate diagnostics; unconstructed leader/token
history and controller-change interactions stay explicit coverage gaps.

Standalone arena-list phase keyword experiments cover Raid and Restore grants,
Hidden loss, controller/arena membership, entering sources, actual combat, later
arrivals, source departure, expiry, stacking two events, empty-event confirmation
and cancellation, and real token/deployed-leader recipients. Intrinsic numeric
stacking, recipient reentry, capped or ineffective Restore, Sentinel precedence,
and live Hidden regain remain explicit gaps. Capacity and overflow checks are
separate runtime tests.

Named-target experiments cover two independent optional unit selectors with
literal phase stats. They compare both owners, trait and arena filters, voluntary
declines, cancellation at each prepayment prompt, empty-event confirmation,
missing descriptors, entering-source eligibility, and natural phase expiry.
Selections prepare before event payment when available; a missing descriptor can
delay the remaining prompts until after payment. Effects wait for both choices.
Unique-source departure, recipient reentry, overlapping trait recipients, lethal
expiry, and token/deployed-leader interactions remain explicit coverage gaps.

Named On Attack phase-stat experiments normally play the source, wait for natural
readiness, then declare an attack. They cover mandatory and optional selectors,
both recipient controllers, arena restrictions, same-recipient stacking, zero
power clamping and phase expiry. Separate actual-source cases check lethal
recipient HP loss, captured defense and death triggers, attacker or defender
departure, and an ordinary upgrade granting Overwhelm before a defender departs.
A positive HP bonus can preserve a damaged recipient until natural expiry.
Same-recipient positive-then-negative HP proves deferral and stacking; it does
not distinguish an intermediate lethal sweep. Reversed source seats, unique
replacement, recipient reentry, broad token/leader combinations and framework
stat-death ordering remain explicit gaps.

Named unit-damage experiments normally play the source and preserve its chooser
through friendly and enemy selections. Both source seats, ground-only and
unrestricted unit domains, entering-source eligibility and missing enemies have
separate cases. Damage, Shield replacement and physical defeat wait for the
remaining selection. Paired Shields and captured death effects exercise both
owner priorities, exact surviving token identities and stable Force identity.
Actual Ambush accept/decline, unique replacement, natural readiness, captured
defense, defender departure and self-lethal damage preparation check attack
resumption. Ordinary attachment cleanup, repeated nonunique sources, reentry,
controller transfer, broad token/leader targets, gained Overwhelm and framework
aura deaths remain gaps. Ziton witnesses cover only the pinned two-player
implementation; its source explicitly disclaims accurate Twin Suns behavior.

Named ground-unit/base damage experiments normally play the space source and
wait for natural readiness. They cover both source seats, both base choices,
missing enemy ground recipients, owner/arena exclusions, one or two Shields,
lethal ground damage and original space-unit combat. Fatal own-base cases assert
the latched winner while the selected unit is defeated, its mandatory Force gain
resolves and combat completes. Unique replacement, source departure, token/leader
recipients, ordinary attachment cleanup, captured defense, gained Overwhelm and
controller transfer remain explicit gaps.

Opposite-chooser experiments cover normal unit/event play, both source seats,
missing domains and empty-event cancellation. They assert payment by the source
controller before the opponent chooses, both mandatory domains, deferred shared
damage/defeat, and original-actor replacement/death priority. Real cases cover
paired Shields, captured Force gains, unique-source keep-old/keep-new choices,
native Clone recipients and deployed-leader inclusion or exclusion. Defeat
checks ordinary and native attachment identity, detachment and destinations.
Control transfer/reentry, multiplayer, attack-time opposite choosers and broader
creation/replacement hooks remain gaps.

Mixed named-event experiments cover ready/damage, exhaust/cheap Shield and
Shield/negative power pairs. They distinguish truly empty domains from legal
but ineffective readiness choices, cancellation at either selection, delayed
payment, same/different recipients and controllers, and exact token allocation
after the final choice. Real Shields are consumed in later ordinary combat;
phase modifiers expire naturally. Fervor cases include prevention, captured
death effects, native attachment removal and ordinary attachments controlled
by the other player. Printed-cost boundaries include a native Beast and an
ineligible deployed leader. Reversed source seats, recipient departure during
selection, replacement/cancellation of token creation, controller transfer and
multiplayer remain gaps; attachment cleanup coverage is specific to Fervor.

Weakness experiments cover optional play/death registrations, both controllers,
damaged-only choices, exact resource thresholds, the entering source, signed
stat stacking and zero-power clamping, lethal HP loss, and native token/deployed
leader recipients. Creation and attachment observations preserve actual token
identity, recipient ownership and attachment order. Removing a negative HP
attachment cannot undo a defeat already captured. The native token adapter is
reviewed separately from the three printed source cards; its setup appearance
is not an ordinary token-play witness. Mixed attachment cleanup, removal/return,
replacement, and multiple-recipient or mixed-effect groups remain explicit gaps.

Friendly arena-list phase-stat experiments cover static trait filters and source
exclusion, mixed controllers and arenas, native token and deployed-leader
recipients, source departure, later arrivals, stacking, and empty-event payment
and cancellation. Actual damage while an HP bonus is active establishes survival
followed by defeat at natural phase expiry. Recipient reentry, later trait
changes, simultaneous expiry deaths, aura/attachment deaths, and matching
Creature leaders remain explicit gaps.

Force experiments cover gain, use, regain, already-held and absent tokens,
independent owners, optional decline, phase persistence, exact persistent token
identity and allocation, captured defeated-source continuations, and empty or
partial draw piles with fatigue. The first actual sources exercise draw-two,
self-ready and gain on ordinary-unit entry, including unique replacement. Native
token definitions are reviewed separately from printed-card play witnesses.
Further source experiments cover ordinary-unit play/death and event use before
scalar damage, healing, phase stats or opposing hand choice. They distinguish
absent Force and optional decline, prepayment event confirmation/cancellation,
post-use target selection, ineffective continuations, recipient deaths, Shield
prevention, and Shielded trigger ordering. Printed Overwhelm combat and Hidden
attack protection have their own witnesses.

Force-trigger experiments cover separate attack and defeat gain registrations,
including a lethal attack that captures both and an already-held token. Upgrade
experiments cover non-Vehicle attachment in both arenas, controller identity on
an enemy host, printed stat bonuses and aspect costs, both bases, partial and
capped healing, optional decline, and absent Force. Same-host unique upgrades
automatically lose the older copy; different hosts offer a choice, and a captured
When Played ability still heals after its source is defeated. Controller transfer,
attack cancellation, other simultaneous source triggers, replacement effects and
unit-host death after attachment remain explicit gaps.

Force-presence experiments cover actual gain/use/regain changing self Grit,
Sentinel attack menus and friendly power in both arenas. Enemy-only Force does
not activate these effects, and phase changes preserve them. Conditional Ambush
experiments cover both Shielded trigger orders, accept/decline, no enemy target,
and later Force gain without a retroactive attack. Actual Hidden grants test the
Sentinel exception as Force changes. Power-aura cases include a Beast token and
source departure. Deployed-leader membership and pending-window Force loss have
separate runtime diagnostics; controller transfer, unique replacement, reentry
and aura stacking remain explicit gaps. Other Force queries, hooks, costs,
groups and continuations remain uncovered or runtime-rejected; passing these
experiments does not establish them.

Self-resource experiments cover real event play and ordinary-unit defeat, both
controllers, optional decline, own/absent/enemy Force, exact paid cost, exhausted
entry, persistent card identity, repeated copies and natural phase readiness.
Wounded sources with ordinary and native attachments exercise real defeat cleanup
before movement. Event observations establish discard entry before the same card
becomes a resource. Earlier death-time return to hand and the live discard guard's
negative branch remain explicit printed-card gaps; current-zone movement,
already-resource readiness and destination capacity have separate runtime tests.

An obligation moves from generated to oracle-exercised only after its construction
and observation assertions pass, then to matched only when the same trace, pool
and catalog agree in native Auto, native Interpreter and Wasm Auto. Deliberately
wrong amounts, target restrictions, list scopes, signs, cost predicates, departure
destinations, optionality and condition branches test
the sensitivity of these experiments. Rejected mutants do not count as detected gameplay errors; surviving
mutants become uncovered obligations. Passing mutants tests only those mutations.

IR-derived tests cannot detect every source behavior omitted by the compiler.
The reviewer must independently compare printed text, full card and helper source,
configuration, generated code, runtime helpers and gaps. Unexercised Shield,
attachment, deployed-leader, aura/death timing and source-completeness obligations
remain explicit for the initial pilot. Distinguish an incorrect Karabast baseline
from a conversion error and from a Rust error. Finite traces and an LLM review
remain evidence with limits, not a proof for every interaction.

New automatic recordings retain their immutable construction definition in the
reference manifest. Accepted traces run in native and Wasm CI without regenerating
the oracle. The existing manual semantic cases remain useful for interactions
that do not yet have a general construction adapter.
