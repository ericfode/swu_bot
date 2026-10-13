# Holotable animation integration

This change adds the animation runtime, preview catalogue, review tooling, and the first **180 accepted card identities** to the current Holotable viewer. It preserves the current score registry, weights and Atlas views, card faces, replay metadata, and adaptive arena layout. Later batches remain separate work.

Open `#/effects` to select a scene, play it, hold a frame, or inspect its completed board. Recorded playback uses observed before/after snapshots and card identities; authored examples explicitly describe their staged choices. Backward seeking cancels an active effect. The embeddable viewer exposes the same controls.

The port reserves the largest arena footprint needed by a transition so returning cards and newly created units land in the correct slot on both wide and narrow boards. Geometry probes reproduce the current card and hand layout. The board and hovered-card inspector share the same score snapshot throughout playback. Individual upgrade/token identities and persistent status chips remain visible. Hidden cards and unknown draws no longer acquire a token badge merely because they lack a set code.

## Validation

- 632 studio tests pass, including the two hidden-card/token regressions.
- Studio application, embeddable kit, and original viewer builds pass. All six analysis test groups pass.
- 392 browser final-state checks pass: all 180 scenes and 16 authored boundary scenes at 1440×1100 and 390×844. Visible units, identities, readiness, stats, upgrades, base HP, resources, deck, discard, and hand counts match the staged ending snapshots.
- Visual review covers 12 representative scenes at both sizes, five held frames per scene, and separate natural completions: Force Choke, Superlaser Blast, Repair, Change of Heart, Search Your Feelings, Galactic Ambition, Pillage, Clear the Field, Private Manufacturing, Scramble Fighters, Timely Reinforcements, and They Hate That Ship. Natural completion matches the held final board for all 24 cases. The corrected unknown draw was captured again at both sizes.
- Existing replay verification passes for four recorded plays, including natural completion, Replay effect, and backward seeking. Two of the six requested identities were absent from the supplied recordings; no new games were generated.
- Two mobile held-frame image hashes differed. Inspection found raster paint differences only: 292 pixels around the rotated leader footer and decorative edges for Repair, and nine one-channel pixels at the outer corner for Private Manufacturing. Recorded identity, progress, geometry, and visible game values remained unchanged. The original captures are retained.
- Root smoke stops at five pre-existing arena process/lock failures on macOS: 299 tests pass, five fail, five skip. Those paths use Linux `/proc`; their source and tests are unchanged by this integration. The downstream studio, analysis, and viewer checks were run separately.

The local review preview requests optional `/card-text.json`, which is absent in this setup and returns 404. It falls back to the existing card art/monogram behavior. No browser page errors were observed.

Review captures, source manifests, and logs are kept in gitignored `results/card-effects-review/MR-180` in the authoring checkout. The final viewer source fingerprint is `77e5cdb9194c35b9d8458ed7b2c424bbf057637a31893cf741623ee57c9c6c1e`. The final build additionally fixes the inspector score context identified by the [independent port audit](holotable-animation-integration-audit.md), removes its unused score memo, and trims a trailing blank line. Final application and kit builds pass; the source manifest matches all 112 local source files and the served preview. Earlier manifests, failed build logs, and captures remain preserved.

## Scope and limits

The [batch ledger](card-animation-batches.md) records the original per-batch acceptance. This port's representative visual regression does not replace those independent reviews. Existing recordings provide less evidence than the authored catalogue; missing outcomes or ambiguous identities use the conservative replay fallback.

The procedural audio prototype is included with its controls and cancellation support, starts off each session, and remains artistically rejected as recorded in the [sound language](card-sound-language.md). Audio quality is not an acceptance claim for this change. Engine source and its submodule pin are unchanged.
