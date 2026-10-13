# A11 independent review

Reviewer `animation_a05_spec`, GPT-6.1-sol / `xhigh`; authored none of A11's spec, contract, data, integration or signatures. Product/engine source remains read-only. No builds, new games, commits or paid providers by this reviewer.

**ACCEPTED A11 10/10; catalogue130 accepted,2,328 remaining. Frozen130 full pixels/lifecycle plus deployed frozen140 semantic corrections pass independent review. BUILD-CLEAR130 remains valid. Original first4/10, cleanfalse/streak0 stays preserved; keep `xhigh`.**

## Frozen source and authoritative rules

`results/card-effects-review/A11-gpt61/source130/served-manifest.json` preserves54 served source files and335 authority/support files at `ed53bf9df50643f1d471c7e21ba10f783dc9b005219e76401c7c6dbc7f370a0f`. All source hashes match the freshly fetched local production manifest. Archive completed before A12 product source was released. All frozen review transpilation uses this archive.

Direct installed JSON, full reverse print aliases, ten event classes and matching tests were archived/read. Corner's erratum excludes base wounds; Bold intersects one trait across the entire selected set; Unlimited is simultaneous; Grenade selects an optional different same-arena second unit before resolution; Crossfire's reciprocal sources are enemy units, not the playing event. UnitProperties/Grit authority and Scout Bike Pursuer SOR032 establish that native Grit already contributes current wounds once. Engine unchanged.

Normal fixture is round13/action/P1 initiative, Luke SOR005 Vigilance/Heroism plus Echo Base SOR024 Command. Own16 actual ready resources, opposing7/10; own/enemy bases21/24HP; actual deck IDs27/29; real source `a11:<internal-id>:event` in hand, then one paid owner discard. Unknown cards retain IDs and privacy. Repeated missing aspects each add2.

| Identity / all print aliases | Actual payment | Independent primary ending |
| --- | ---: | --- |
| Corner the Prey6476609909 /TWI139 | 5 | Own Wampa4/5 starts0wounds, enemy Wampa starts2. Attack bonus2→combat6; enemy Wampa to P2discard, own Wampa exhausted/resting4 with4wounds. Defender/X-Wing unchanged. |
| Self-Destruct8060312086 /TWI140, exact internal `selfdestruct` | 6 | Actual own Marine sacrifice to P1discard unlocks a separate4 hit; enemy Wampa1→5wounds, P2discard. No attack/extra payment/base effect. |
| Bold Resistance8022262805 /TWI153 | 5 | Marine/Defender/enemyTrooper share Trooper. Power5/6/5, maxHP3/3/3 and wounds1/0/1 unchanged; ready/current entries, visible phase+2/+0. |
| Unlimited Power0056489820 /TWI156 | 10 | Distinct Marine4/Wampa3/X-Wing2/TIE1 hits precede departures. Marine/P1 and TIE/P2 discard; Wampa4wounds, X-Wing2wounds, both ready. Leading-zero identity retained. |
| Daring Raid7826408293 /TWI170,SHD178 | 3 | Chosen own base wounds9→11, HP19/30; every unit/other base unchanged. |
| Grenade Strike4042866439 /TWI171 | 4 | Enemy Trooper1→3wounds, chosen friendly Defender0→1 in same ground arena; both hits precede Trooper/P2discard. Defender ready4/3, Sentinel retained. |
| Grim Resolve6669050232 /TWI172 | 4 | Marine resting3/wounds2 gains Grit for one attack at5 into enemy base24→19. Marine exhausted/resting3, wound2; no retained attack keyword/buff. |
| Blood Sport2103133661 /TWI173 | 5 | All six ground units hit2 together. Marine/P1 and Trooper/P2 discard, Clone token ceases. Defender wounds2, Wampa3, deployed exhausted Vader4; both space units and bases untouched. |
| Strategic Analysis1417180295 /TWI175 | 7 | Actual Repair/Marine/X-Wing top3 in order enter hand, deck27→24; no public search/reveal or play. |
| Caught in the Crossfire5013139687 /TWI176 | 8 | Seal enemy Wampa4/Trooper3. Reciprocal ability hits4/3 before Trooper/P2discard; Wampa wounds4/ready. No attack/exhaust; damage source/controller remains the opposite selected P2unit. |

Manual `scripts/ending-oracle.cjs` imports no production builder/resolver. It specifies both players' exact unit IDs/entries/owner/printed identity, current power/maxHP/wounds/readiness/traits/statuses, full resource poses/IDs, deck/hand/discard order, leader summaries and global round/phase/history. Separate DOM assertions check ordinary completed counters, phase statuses, Sentinel, resources, hand/deck/discard and actual deployed-leader placeholder. Physical cards conserve identity; canonical token facts are independently checked before damage and ceased tokens never become discards. Inputs remain unchanged and repeated nonce/output agrees.

Initial19/19 legal endings include ten primaries and nine explicit alternatives: Corner base bonus0; Self friendly recipient; Bold0/1/2 selections; Daring enemy base/unit; Grenade second declined; native-Grit Grim Scout resting/combat3 at wounds2 without doubling. No blanket rich-branch claim: zero/short cases can remain generic; short deck, Shield absorption and surviving native-Grit wound changes require additional actual receipts.

## Preserved independent failures and corrections

`independent-gates-validated-initial.json`:244/252. All ten legal primary rich predicates/renderers agree, but five secondary recipes accept unreceipted initiative changes. Daring ignores an unsatisfied typed `requiresDefeat`; Analysis ignores an unsatisfied Official `traitCondition`; Bold accepts an unrelated `attackId` on its phase buff. Original raw252 attempt and three invalid harness probes are retained in `gate-harness-classification.json`: one no-op combat ordinal, one aliased shared-group rename, and one undeclared search field. These are excluded from product failures; corrected typed/mutation probes establish the eight reported failures.

`independent-oracle-expanded-initial.json`:19/20. Corner permits Scout SOR032 before1/4, wounds0, permanent native Grit to attack wounded Trooper at2 and receive counter3. Generated Scout survives3wounds but incorrectly keeps resting power1; actual native Grit requires4. Main factory and rich gate only applied their survival boundary to Grim. `independent-gates-expanded-initial.json`:244/255 additionally preserves the rich Corner contradiction and two coherent external Grenade/Blood Scout receipts whose wounds increase while their native-Grit resting power incorrectly stays1. The factory already rejected those secondary incomplete branches; their rich gates did not. Eleven gate failures plus the generated ending failure affect six identities, so first combined4/10/cleanfalse remains.

Root/authors corrected only semantic validation in three A11 modules. Independent isolated archive `source130-grit-correction` preserves immutable frozen130 authority plus exact corrected files, explicitly unbuilt and not production140:

- `batchA11.ts`: `e9b01ab81ee1fbf848ab5dcfe465ef9bf9a8036ffa5b6e8f6a8be9d308489405`.
- `batchA11Signatures.tsx`: `a349a889ba833a6a85fdcfba680612af6165aff57e112d2382743827c801dd7c`.
- `batchA11SecondarySignatures.tsx`: `43283366eb66fa750b6901268b6a67093b5cdba43065854a7c19984264b016dc`.

`independent-gates-grit-correction.json` passes255/255. The rich Corner negative uses the original contradictory cue saved in `corner-native-grit-negative-fixture.json`; a newly throwing factory is never called a passing rich gate. `independent-oracle-final-source-correction.json` passes19 legal endings plus one explicitly unsupported factory rejection,20/20. Original19/20 and244/255 stay intact. No broad Grit evaluator or second engine was introduced. At the initial handoff, acceptance still required the corrected files served and frozen source rerun; those isolated source receipts did not label production130 as fixed. The deployed closure below now meets that requirement.

## Actual pixels, natural timing and lifecycle

Actually viewed all20 ordered contacts18/46/72/90/100, all20 six-level natural contacts12/30/48/65/80/94, all20 separate ordinary natural endings and all20 early payment route contacts6/13/22 at desktop1440×1100/mobile390×844. Native art is decoded before early frames; pointer is parked after Replay. No new material pixel failure or invalid native ending was observed. Scores for valid selected scenes: readability4, meaning5, impact3 for Bold/Daring/Analysis and4 for Corner/Self/Unlimited/Grenade/Grim/Blood/Crossfire, both sizes. Those primary scene scores do not erase semantic first-pass failures.

All20 independent manual DOM endings, natural-versus-held result checks, Replay/reset/backward/reseek, seven-second cancellation, reduced-motion final truth and real source-hover unmount checks pass; no browser errors or fingerprint drift. Normal duration ranges3.697–5.350 seconds, with clear distinct sacrifice, sealed bonus, simultaneous multi-hit, phase trait, direct base strike, fragment, Grit, bilateral ground and ordered draw beats. Reduced motion preserves truth; A11's timer duration is retained rather than being mislabeled as instant. Hover inspector disappears on actual source unmount at both sizes.

Twelve arrival centers across Strategic's three draws and Endless's three resource-unit plays, both sizes, are within1.131px of ordinary100% targets (2px limit), with no continuing-native shift failures. Other A11 entries are existing survivors/departures, not new played cards. Native after-death repacking is visible and does not carry false readiness/power/owner state.

Original desktop90% repeated pairs are exact. Original mobile Corner/Self/Bold/Daring/Crossfire pairs differ4pixels/max1; Unlimited differs8pixels/max7. All six original/repeat/difference images were inspected. Same-run mobile lifecycle differences4–14pixels/max7 lie on rounded caption/board borders; exact progress0.9000 and geometry remain unchanged, all ten diagnostics inspected. No visible primary information moves or is clipped. Cross-browser initial-versus-lifecycle differences are separately retained and never called same-run motion evidence. No repeat capture sought a favorable hash. `review-png-hashes.json` retains the independent originals/comparisons/endings and separate regression evidence; author/root directories are preserved and never counted as reviewer acceptance.

## Existing recordings and separate Endless hardening

Root matching-build checker reports Grenade and Self-Destruct two existing plays PASS before/after/Replay/backseek/no errors at ed53. Eight A11 identities and Endless have no recording, explicitly listed in `recorded-replays-frozen130.json`; no new games generated.

Independent `independent-native-leader-endings/report.json` additionally replays both available final sequences at both sizes, asserts exact raw leader name/print/id, exhausted undeployed leader-area presence, deployment-spent text, absent arena leader and no leader in raw discard. All four native images actually viewed with sticky navigation hidden. Grenade returns Bossk HMW015 c51; Self returns Doctor Hemlock HMW003 c51; both dep0/x1/epic1. Actual own Punishing One can be the Self damage recipient. Raw owner/incarnation/causal chronology remain unknown; this is completed recorded-state evidence, not invented rich defeat/combat witnesses.

Separate `endless-correction-acceptance.json` closes the historical frozen120 early-public-reveal badge blocker. Corrected frozen130 early11/12/13/16/22/30 raw frames, ordered/natural contacts and native endings were actually inspected at both sizes. `PUBLIC RESOURCE REVEAL 4` is beside the own base, clear of enemy Wampa/TIE counters; small resource backs take a clear corridor, public fan remains between rows, later TOTAL19/18/READY4 stays clear of base21, all three exhausted actual arrivals end4/17 without deck replacements. Both independent exact manual endings/lifecycle pass, repeated same-run hashes are exact. Prior failure remains under A09 `existing-scene-hardening-frozen120.json`. This closure adds no new catalogue identity and is separate from A11 semantic acceptance.

## Handoff decision

`build-clear130.json` permits root to replace consumed frozen130: all source/authority and requested first-pass pixel/lifecycle/recorded evidence is durably retained. A11 selected primary visuals are clear, semantic corrections independently clear255/255 and19legal+1unsupported-boundary. At BUILD-CLEAR130 A11 remained uncounted pending corrected served validation; original first4/10, clean0 and GPT-6.1-sol/`xhigh` remain unchanged. Existing author v1/v2 label-width failures and main author captures remain separately attributed.

## Deployed correction acceptance at frozen140

Frozen served140 fingerprint`23f8258e6210acfed4fcc07fdbb4964883d1558c3198aaf624d10222729dd31f` includes the exact three independently reviewed correction hashes. `source140-correction` preserves57 source files from root's immutable author-v2 archive and335 frozen A11 authority/support files. Preflight checks every archived hash, exact served manifest and the three correction hashes; final served readback remains identical. Separately archived `lib/cards.ts` is outside the served manifest; its current read-only support bytes match the frozen authority hash. Root reports full smoke134 root/411 studio plus analysis/both builds PASS; this is author execution, separate from reviewer receipts.

Independent immutable reruns pass255/255 gates and19 legal source endings plus one specifically rejected incomplete native-Grit survivor boundary,20/20. The original wrong-power cue is explicitly suppressed by the corrected rich predicate, rather than being hidden behind a now-throwing builder. Original source19/20 and gates244/255 remain preserved.

All240 primary SSR signature samples are byte-identical to reviewed130 output at twelve progress levels and two screen scales. Shared source inspection found only conditional A12 arena footprints, discard-permission rows, phase Overwhelm status text, dispatch/cost/stage registration and receipt guards; these do not activate in the A11 primary fixtures. Exact A11 source endings still match the independent oracle. This is source parity with synthetic geometry, not a new browser pixel matrix. The fully inspected frozen130 pixels/lifecycle and recorded leader endings are reused transparently; no material shared A11 visual change justifies repeating them.

`correction140-acceptance.json` and `acceptance.json` accept all ten A11 identities: total130, remaining2,328. First4/10/clean0 remains unchanged, GPT-6.1-sol/`xhigh` retained. Separate Endless hardening closure stays accepted without adding an identity. A12 author captures on the same build are outside this decision; no independent A12 acceptance is claimed.


## Post-acceptance scroll-entry regression

A12 author candidate23f825 introduced a shared viewport fallback defect outside synthetic SSR parity: selecting a paid-hand card while its whole board was above the viewport increased footer reservation. Independent original desktop Corner/Analysis frames gained205px; mobile Corner gained7,231px. Original mobile Analysis's cold baseline inherited page scroll and is explicitly a harness qualification. The initial four failing cases/images remain in `scroll-entry140-initial`; no original acceptance score was rewritten.

Corrected served140 `bd284fdf7d623bda2b6021e8a8687b4d4277b0ed3a5cbd4a6715822c5b1ea887` passes4/4 targeted independent cases using fresh pages and actual above-viewport hand coordinates. Desktop height783.969px/padding97px and mobile994.5px/padding92px remain exactly invariant after offscreen selection and viewport entry for both Corner and Analysis. All four corrected contacts were actually viewed: board/footer and primary counters stay clear. This narrow scroll test makes no new image-decoding/full-matrix claim. `scroll-entry140-acceptance.json` preserves both image sets and hashes. Catalogue130 acceptance, original first4/10 and clean0 remain; corrected A12 pixel acceptance is still separate.
