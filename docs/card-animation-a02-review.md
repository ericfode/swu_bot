# A02 independent animation review

Reviewer: `animation_a02_review`, GPT-6.1-sol / `xhigh`, 2026-10-11.
Rules sources were inspected independently in installed card JSON and the pinned
engine's ten `01_SOR/events/` implementations. Engine source was read only.
Acceptance applies to the deliberately staged primary examples, not every legal
choice or unknown detail in a recorded game.

**First pass: 7/10.** Search Your Feelings, The Emperor's Legion, and Heroic
Sacrifice failed because the mobile caption covered the arriving hand cards before
handoff. **Final acceptance: 10/10**, after the separately captured caption-footer
correction. All ten completed boards are correct. This first-pass count is
permanent; the clean new-authoring streak remains zero and effort stays `xhigh`.

First served fingerprint:
`e69d7515508325441973b8cd64f5ff8a62d48816d356005709ebccf1d124cd8f`.

Corrected served fingerprint:
`552512c84c8806d8cc38e5e068bca9e699d4f522df2eddd19121bc647e4837e1`.

## Per-card findings

Scores are readability / meaning / impact, 0–5, taking the weaker desktop or
mobile result. Acceptance requires at least 4 / 4 / 3 and no material clipping,
semantic contradiction, or state failure.

| Exact identity | First scores | First verdict | Inspected action and completed result |
| --- | --- | --- | --- |
| `search-your-feelings` | 3 / 4 / 3 | Fail | Whole deck/private label, back-only selection and draw route, then shuffle remainder. Completed Open Fire in P1 hand, deck 26, discard 1, resources 4/10. At mobile 72/90 the arrived back is partly covered by the caption. |
| `it-binds-all-things` | 4 / 5 / 3 | Pass | Three green marks transfer from damaged Luke through the Force balance ring to a different Wampa. Luke ends at 6/7, Wampa at 4/1; readiness unchanged, resources 8/10. Both live counters and final pixels agree. |
| `the-emperors-legion` | 3 / 4 / 3 | Fail | Current-phase rack identifies two defeated units; historical P2 controller mark does not change the P1 recovery destination. Two intact routes end at hand; ordinary board has both real faces, discard 3, resources 6/10. At mobile 72/90 the arriving faces are almost completely covered. |
| `rebel-assault` | 4 / 5 / 4 | Pass | Separate numbered ground and space attacks, +1 for each attack, base damage 6→10→13. Final Marine and X-Wing exhausted with resting power 3 and 2; Marine's existing damage is retained, Defender stays ready, resources 9/10. |
| `uwing-reinforcement` | 4 / 5 / 4 | Pass | Ten private backs, three numbered choices, 2+3+2=7 ruler and sequential public arrivals. Mobile wrapping lands two new ground units on the second row and X-Wing in the second space slot. All three end exhausted, deck 24, resources 3/10; no nested payments. |
| `heroic-sacrifice` | 3 / 4 / 4 | Fail | Draw precedes +2 attack; five combat marks precede self-defeat to P1 discard. Final Marine absent, Repair in hand, enemy base HP 19, discard 2, resources 7/10. Mobile caption completely hides the arrived draw back at 46/72/90. |
| `karabast` | 4 / 5 / 3 | Pass | Exhausted damaged Marine feeds the explicit 1 damage + 1 = 2 formula and ability-damage route. It never attacks or changes state; Wampa ends at 4/2, resources 6/10. |
| `for-a-cause-i-believe-in` | 4 / 5 / 3 | Pass | Four public faces and exactly two Heroism marks; choice routes separate two discard cards from TOP 1 Repair / TOP 2 Marine. Final enemy base HP 22, deck 25, discard 3, empty P1 hand, resources 5/10. No draw or random-bottom language. |
| `rallying-cry` | 4 / 5 / 3 | Pass | Rally ribbon reaches both friendly arenas; three Raid 2 phase pennants at rest. Completed pixels show three readable Raid 2 phase chips inside the cards while resting powers remain 3/4/2 and poses remain ready. Resources 3/10. |
| `force-throw` | 4 / 5 / 4 | Pass | P2 CHOOSES precedes the exact Takedown face, printed cost 4 passes through the ring linked to friendly Luke, four marks hit Wampa, and the face goes to P2 discard. Final P2 hand empty, discard 1, Wampa 4/1, P2 resources unchanged; P1 resources 7/10. |

Corrected final scores are Search Your Feelings **4 / 5 / 3**, The Emperor's
Legion **4 / 5 / 3**, and Heroic Sacrifice **4 / 5 / 4**. Their hand arrivals are
fully visible above the caption at both sizes, including the private draw backs.
The other seven retain their passing scores. The correction changes only shared
caption clearance; their existing semantic and ending evidence remains applicable.

## Evidence and verification

- `results/card-effects-review/A02-gpt61/first-pass/desktop/manifest.json`: all
  ten at 1440×1100, 18/46/72/90/100%, plus natural completion.
- `results/card-effects-review/A02-gpt61/first-pass/mobile/manifest.json`: all
  ten at 390×844 with the same five frames and natural completion.
- Every contact sheet and every separate natural-completion image was actually
  inspected. A manifest or DOM label alone was not counted as pixel review.
- All 20 natural endings equal the held completed-board DOM; all 20 frozen 90%
  images remain stable. Both capture runs report zero browser errors or warnings
  and identify the served build as their source. The pointer was parked outside
  cards and external sticky navigation was hidden only in board crops.
- Read-only rules audit checked exact print IDs, costs/aspect multiplicities,
  unit stats/traits, owner destinations, different Rebel attackers, the printed
  cost budget, Force prerequisites, actual healing basis and current-phase
  eligibility against source. Luke in HQ is not a Force-unit prerequisite.
- Independent assertions against both captured ending manifests checked 20 staged
  results, including exact resource payment, deck/discard/hand destinations,
  damage, resting stats, exhaustion and phase keywords. All passed; receipt:
  `results/card-effects-review/A02-gpt61/first-pass/independent-ending-assertions.json`.
- The implementation coordinator reports the full smoke gate passing 134 root
  tests, 86 studio tests, analysis checks and both viewer builds, plus the kit
  build. Independent browser lifecycle checks are recorded separately below.
- The coordinator's actual recorded-replay inspection is
  `results/card-effects-state-check/replay-state-a02-qa.json`: 14 observed
  before/after transitions, including six A02 events. These are separate from
  staged semantic assertions. Unknown attack/search/keyword details remain
  unknown rather than being inferred from aggregate deltas.

## Shared movement regression

Five existing scenes were captured and inspected at 390×844 in
`results/card-effects-review/A02-gpt61/first-pass/regression-mobile/`.
Mission Briefing's P2 hand arrival, Restock's deck-bottom route, and Change of
Heart/Sneak Attack's wrapped final arena slots remain clear and settle correctly.
Recruit's P1 hand arrival shares the new caption obstruction: the revealed Marine
was mostly covered at 90%. Its final board remained correct. Recruit was recaptured
with the three failed A02 scenes after correction, at both sizes, and now passes.
The Marine reaches the real hand slot clearly. Its approximately 42×59 moving
ghost becomes the ordinary 46×64 hand card at handoff; that small size change is
residual polish, not a material route, identity or clipping failure.

## Correction evidence

`results/card-effects-review/A02-gpt61/corrected/desktop/` and `corrected/mobile/`
each contain the four affected scenes at 18/46/72/90/100% plus natural completion.
All eight contact sheets and all eight separate completion images were actually
inspected, as were eight contact sheets of actual natural playback samples in
`corrected/lifecycle-desktop/` and `corrected/lifecycle-mobile/`. Every held/natural
ending agrees; the three corrected A02 endings also exactly match their first-pass
board receipts. Both capture runs report no browser errors or warnings.

Exact mobile frozen-image hashes differed for Recruit, Search, and Legion in the
capture run, and for all four in the separate lifecycle run. This was investigated
rather than recaptured until a favorable hash appeared. Four repeated held poses
have identical measured card/caption/hand geometry and identical 90% progress.
The inspected difference images contain only 10–19 changed pixels among roughly
313,000, with maximum RGB-channel differences of 1–8 at rounded border/caption
edges. This is visually immaterial raster noise, not drifting animation geometry.
The exact-hash failures remain in the manifests; the quantified receipt is
`corrected/lifecycle-mobile/frozen-raster-differences.json`.

During the effect, the mobile board wrapper measures 849.5px for Recruit/Search
and 862.5px for Legion/Heroic, then returns to 778.5px at natural completion.
Desktop returns from 657.47px to 572.47px. The overlay is removed, and cancellation
from Recruit to a held It Binds All Things also restores the ordinary board height;
the later selection remains at 18% with identical state/layout after seven seconds.
Repeated replay, completion, backward seek and reduced-motion endings pass for
all four at both sizes. No correction evidence overwrote the first-pass files.

## Lifecycle and timing

The first frozen build's independent browser receipt is
`results/card-effects-review/A02-gpt61/first-pass/lifecycle-desktop/lifecycle.json`.
All ten pass natural completion, a second full replay, reset to the original board,
backward 100→18% and 90→18% seeking, and return to 100%. Cancellation from U-Wing
to held It Binds All Things does not later advance the selected scene. All ten
reduced-motion endings match their ordinary endings; reduced motion suppresses
moving artwork but retains the scene clock, so no shortened duration is claimed.
The served fingerprint remains unchanged and there are no browser errors.

Six actual playback samples per card were saved at approximately 12/30/48/65/80/94%
and all ten natural contact sheets were inspected. Measured desktop durations in
milliseconds, in A02 order, are **4811, 4739, 4718, 5964, 6425, 5676, 4355, 5657,
4276, 4911**. The six samples and completion waits add some measurement overhead;
they are observations, not exact authored clock durations. Sequential Rebel
attacks and U-Wing arrivals remain distinct, Heroic's draw precedes combat and
self-defeat, Cause's public count precedes its split routes, and Force Throw's
choice/printed-cost/damage/discard sequence is readable at natural speed.

The corrected affected scenes repeat these checks at both sizes in the two
`corrected/lifecycle-*/lifecycle.json` receipts. All actual natural playback contact
sheets were inspected; no synthetic SSR frame was counted as a pixel observation.

## Rules limitations retained

The pinned It Binds All Things zero-heal branch reads a missing event. The
positive staged branch is legal, but this review does not claim fresh engine
validation of the zero branch or repair that engine bug. A02's recipes are
specific chosen branches; documented optional/short-deck/no-damage branches
remain bounded by explicit receipts. No paid or external analysis was used.
