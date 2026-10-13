# A07: next ten SHD events

**Specification only, GPT-6.1-sol / xhigh, 2026-10-11.** Scope remains all 2,458 imported identities / 2,549 prints. These ten are the next queue after A06: `results/card-animation-catalogue/imported-a04/batches.json`, `batches[8]`, generated `A003`. Generated batch numbering and authored registration are not acceptance. A06 data is frozen; A07 product writes must wait for root's explicit release after the frozen80 build, recorded check and reviewer source snapshot.

Read-only authority: installed `forceteki/test/json/Card/<slug>.json`, `forceteki/test/json/_setCodeMap.json`, matching `forceteki/server/game/cards/02_SHD/events/<Class>.ts` and `forceteki/test/server/cards/02_SHD/events/<Class>.spec.ts`; related watcher, collect-Bounty and resource-ready systems. Engine HEAD `2be4fcdb4325346bb4a1ba14b29d4f66a1093e2a`. No engine edits, builds, fresh games, paid calls or UI acceptance performed. Current skill retains measured arrival/departure clearance and exact compound-evidence gates; clean authored streak remains zero.

## Exact identity and primary cost

All ten are non-unique events with **one sole installed print alias**, confirmed in both `setCodes` and reverse `_setCodeMap`. Preserve leading zero in Ma Klounkee's identity. P1 Luke SOR_005 supplies Vigilance/Heroism; Echo Base SOR_024 supplies Command. Missing **each** aspect occurrence adds2; complete event payment occurs once, before resolution. Nested payments are separate and include explicit known zero.

| Slug / exact title | Canonical identity | Sole print | Printed cost / aspects | Primary actual payment → P1 ready/total |
| --- | --- | --- | --- | --- |
| bravado / Bravado | 7212445649 | SHD_182 | 5 / Aggression | 5 + 2 − 2 = **5 → 5/10** |
| triple-dark-raid / Triple Dark Raid | 5696041568 | SHD_194 | 3 / Cunning, Villainy | Event **7**, nested X-Wing0 → **3/10** |
| let-the-wookiee-win / Let the Wookiee Win | 7578472075 | SHD_205 | 2 / Cunning, Heroism | **4 → 6/10** |
| spare-the-target / Spare the Target | 5283722046 | SHD_206 | 3 / Cunning, Heroism | **5 → 5/10** |
| a-new-adventure / A New Adventure | 4717189843 | SHD_207 | 2 / Cunning, Cunning | Event **6 → 4/10**; P2 nested free0 |
| final-showdown / Final Showdown | 1910812527 | SHD_208 | 6 / Cunning, Cunning | **10 → 0/10** |
| look-the-other-way / Look the Other Way | 2750823386 | SHD_227 | 0 / Cunning | Event **2 → 8/10**; P2 chosen pay2 → **5/10** |
| bounty-posting / Bounty Posting | 6151970296 | SHD_228 | 1 / Cunning | Event **3**, nested Public Enemy0 → **7/10** |
| ma-klounkee / Ma Klounkee | 0931441928 | SHD_229 | 1 / Cunning | **3 → 7/10** |
| swoop-down / Swoop Down | 4663781580 | SHD_230 | 1 / Cunning | **3 → 7/10** |

## Common explicit fixture

Fresh round9/action, P1 initiative. Prefix every physical ID `a07:`. Each arena entry is `<id>:entry-1`; previous entry abilities and supporting history are already resolved. Ordinary owner is explicit and controller is enclosing seat.

- P1 Echo Base SOR_024 `a07:p1:base`, HP30/damage9; undeployed/ready Luke SOR_005 `a07:p1:leader`; P2 Capital City SOR_020 `a07:p2:base`, HP30/damage6; undeployed/exhausted Vader SOR_010 `a07:p2:leader`. Resources P1 ready10/total10, P2 ready7/total10, complete actual `resources` arrays with IDs `a07:<seat>:resource:0..9`, unknown faces/prints, P2 slots7..9 exhausted. Pay exact distinct ready IDs, beginning at0 unless overridden.
- P1 hand contains exact source `a07:<slug>:event`; P2 hand Takedown SOR_077 `a07:p2:hand:takedown`; discards empty. Complete deliberately known decks27/29, stable unknown slots `a07:<seat>:deck:<i>`, named tops replace slots rather than increase counts.
- P1 **M** Marine SOR_095 `a07:p1:marine`, cost2, 3/3/damage1/ready; **D** Echo Base Defender SOR_098 `a07:p1:defender`, cost3, 4/3/damage0/ready/Sentinel; **X** Alliance X-Wing SOR_237 `a07:p1:xwing`, cost2, space2/3/damage0/ready.
- P2 **T** Death Trooper SOR_033 `a07:p2:trooper`, ground3/3/damage0/ready; **W** Wampa SOR_164 `a07:p2:wampa`, cost4, ground4/5/damage1/ready/Overwhelm; **F** TIE/ln SOR_225 `a07:p2:tie`, space2/1/damage0/ready. No attachments/captives/statuses/history unless specified.
- Supporting real faces: Liberated Slaves SHD_200 (`8656645362`), cost3 Cunning/Heroism, ground3/5, Wookiee, no text; Underworld Thug SOR_247 **and SHD_257** (`1598425314`), cost2/no aspects, ground2/3, Underworld/no text; Pyke Sentinel SHD_029 (`2969011922`), cost2 Villainy/Vigilance, ground2/3/Sentinel. Death Mark SHD_176 (`0807120264`), cost2/Aggression, ordinary upgrade0/0, Bounty/Condition, grants draw2 Bounty. Public Enemy SHD_068 (`1780014071`), cost0/Vigilance, ordinary upgrade0/0, Bounty/Condition, grants a Shield Bounty. Academy Training SOR_120 cost2/Command, ordinary +2/+2.

After each normal primary, source leaves hand for P1 discard once. Preserve unrelated cards, stats/damage/poses/owners, bases and deck order/counts. All overrides and additional changes follow below. Do not let elapsed scene time cross phase boundaries.

## 1. Bravado — attributed prior defeat, ready now

**All clauses.** If P1 defeated an enemy unit this phase, the event costs2 less; then ready any unit, either side/arena and deployed leader. Determine enemy controller at defeat and actual `defeatedBy`, not ownership/current discard. A controlled card or resolved ability can supply defeat attribution. No friendly-only or power/cost restriction on readying; already-ready targets change no pose. Returning/capturing a unit or somebody else defeating it is not this prerequisite. Earlier defeated entries still qualify after later return to play; this is not Spark's most-recent-entry recovery test.

**Primary.** X earlier legally attacked F in space: F took2 and was defeated by P1; X took2 and exhausted. Move F into P2 discard; X before is2/3/damage2/exhausted. Supply round9/action unit-defeat witness `{id:F,incarnation:entry-1,controller:P2,defeatedBy:P1,lastKnownType:'unit'}` and actual prior attackID `a07:bravado:prior-attack`. Pay5, ready X, keep damage2/remainingHP1 and same entry. F remains previously discarded, not defeated again; P1 discard source, ready5/10.

**Signature ~4.4s.** A small historical defeat receipt authorizes a 7→5 payment gate; X's action latch relights while the two existing scars remain. Do not animate a fresh TIE kill. **Edges:** no/wrong-phase/opponent-attributed/friendly-at-defeat history pays7; unit owner can differ from defeated controller; ready enemy/deployed units remains legal. Pinned watcher `playerDefeatedEnemyUnit` currently lacks the type filter present in its other unit helpers, while its updater tracks upgrades too: upgrade-only discount is a source-inspected concern, not verified gameplay or authorization to stage that printed-rule violation.

## 2. Triple Dark Raid — private top7, ready entry, phase-end return

**All clauses.** Privately search top7 for a Vehicle, optionally take nothing; play chosen actual card from deck at cost−5, entering ready where applicable. Vehicle **upgrades also qualify** (engine test plays Grievous's Wheel Bike); not unit-only. Pay remaining resource/aspect/additional costs, obey play/attachment restrictions and resolve actual entry abilities. Unchosen searched cards go random bottom; untouched suffix stays ordered. At action-phase end return that same continuing card to its real owner's hand, even after control change. Departed or returned/replayed entries do not inherit the old obligation. Unit departure performs actual attachment/captive/pilot-leader cleanup when relevant.

**Primary.** Top7 IDs `a07:raid:top:0..6`: Marine, Repair, **X-Wing**, Defender, Wampa, Open Fire, Resupply. Select2; cost2 −5 floors to0, Heroism supplied; explicit nested pay0. Event7; deck27→26, no hand waypoint/draw, new X-Wing ready2/3/damage0/entry-1 in measured final P1 space beside X. Final knownDeck is untouched suffix7..26 followed by unchosen6,5,4,3,1,0 (one explicit valid random ordering); only selected face becomes public on actual play. Retain phase-end-return pending on new unit; P1 hand empty/ready3/10.

**Required separate phase-end scene.** From that exact ending, return selected same entry to P1 hand, consume pending, no cost/draw/ready/regroup work. **Signature ~6.2s / ~4.4s:** seven private backs, selected card pays known0 and arrives ready; an end-of-phase tether holds. Boundary retracts intact card to measured owner hand. **Edges:** none/short deck, unaffordable discounted play, vehicle upgrade, controller change, vanished/new entry, owner versus controller, unsupported pilot/captive cleanup must remain explicit; never generalize unit-return handling to all Vehicle card types silently.

## 3. Let the Wookiee Win — opponent selects mode, P1 acts

**All clauses.** An opponent chooses either P1 readying up to6 resources, or P1 readying a friendly unit. P1 selects the unit. If that selected unit is a Wookiee, P1 attacks with it if able at +2/+0 for that attack; non-Wookiee only readies. Already-ready Wookiees can still attack; all normal targets/readiness/Sentinel/arena/counterdamage apply, including legal base targets. This is not optional attack wording. No permanent/phase power buff or new resource creation. Multiplayer opponent choice is outside this two-player fixture.

**Primary.** Replace D with exhausted Liberated Slaves `a07:wookiee:slaves`, 3/5/damage1. P2 explicitly chooses unit branch; P1 selects Slaves. Event4; ready then attack T at5, simultaneous counter3: T to owner P2 discard, Slaves damage1→4, exhausted, resting3/5. Others/bases/decks unchanged; ready6/10. **Signature ~5.8s:** P2's two-mode fork closes to UNIT; P1's actual Wookiee latch opens into one boosted attack, held scar4 and resting power3.

**Required alternate evidence:** resource mode can use before P1 ready4/10; event4 leaves0, exact six exhausted IDs ready to end6/10, no unit attack. **Edges:** non-Wookiee ready only; mode chooser is P2 and target chooser P1; available exhausted resource count caps benefit; wrong trait, fabricated six new resources or lingering +2 reject.

## 4. Spare the Target — return, collect actual Bounties

**All clauses.** Return an enemy non-leader to owner hand and collect all its actual Bounties. Unit need not have a Bounty; no Bounty means no extra result. Collect intrinsic/gained abilities, preserve actual choices/order when multiple; collector is P1, not upgrade owner. The engine executes return and Bounty collection as simultaneous systems: there is **no if-you-do dependency** tying collection to successful return. This is not defeat/capture, but card-specific Bounty results are explicitly authorized here. Ordinary return cleanup removes upgrades to their owners, tokens cease and captives require supported release; no unit damage invented.

**Primary.** W guards no captives and carries Death Mark `a07:spare:death-mark`, owner/controllerP1, ordinary0/0. P1 top2 actual Repair/Open Fire `a07:spare:draw:0/1`. Event5; W leaves intact to P2 hand (hand1→2), Death Mark to P1 discard, capture the before Bounty ability witness and P1 collects draw2. P1 deck27→25/hand2, discard source+Death Mark, ready5/10. No arena W or death badge; all bases unchanged. **Signature ~5.6s:** intact owner-hand return and a separately witnessed bounty seal route two actual deck cards to collector's hand. Remove real attachment chip at cleanup; return alone must not suppress generic movement when Bounty evidence is absent.

**Edges:** no bounty returns only; multiple actual bounty abilities and non-owner collector; leaders excluded. A replaced/prevented return does not by itself prove or disprove collection: require separate actual Bounty-resolution evidence, without adding an absent if-you-do rule. The chosen rich fixture differs from the sole existing recording below.

## 5. A New Adventure — owner decides a fresh free replay

**All clauses.** Return any non-leader of printed cost≤6 to owner hand; then **that owner may** play that exact card free. Either current controller/arena; printed cost ignores modifiers. Free ignores resource/aspect costs, not other additional costs/restrictions. Return cleanup happens first; actual new entry/When Played effects apply, normally exhausted, old damage/upgrades/statuses/attack history do not carry over. Owner can decline; no half-invented replay when return failed.

**Primary.** W carries Academy `a07:adventure:academy`, owner/controllerP1, +2/+2: before W6/7/damage1/ready, printed4. Event6. Return W to P2 hand and Academy to P1 discard. P2 explicitly chooses free replay, explicit nested pay0 byP2; same physical W enters P2 ground exhausted4/5/damage0/entry-2. P2 hand ends original Takedown only, resources stay7/10; P1 ready4/10/discard source+Academy. No attack or retained buff. **Signature ~5.8s:** separate return and OWNER P2 DECIDES gate; measured actual hand waypoint, then fresh clean exhausted entry. **Edges:** decline stays in hand, ownership/controller differ, cost7 rejects despite discount, old-entry delay cannot attach to replay, cannot call zero payment merely because receipt is absent.

## 6. Final Showdown — ready all, player loses at regroup

**All clauses.** Ready every currently controlled arena unit including deployed leaders, both arenas; owner can differ. Enemy-controlled units stay unchanged. At start of regroup the **event controller loses the game**, a player-bound obligation independent of units or source presence. It is not base damage, surrender now or unit defeat. Winning during the intervening action phase can end the actual game before this trigger.

**Primary.** M/D/X all exhausted; P2 T also exhausted to prove exclusion. Event10 exhausts all P1 resources; ready M/D/X, preserve damage/stats, P2 T stays exhausted. Hold explicit P1-loss-at-regroup player pending; game remains ongoing, bases unchanged. **Required separate regroup-start scene:** same paid ending, declare P1 loses/P2 wins by effect, consume player obligation before any normal regroup draw/ready. No card resource payment, fabricated base damage or field wipe. **Signature ~5.0s / ~4.0s:** three own action latches open as one push; a clear player-level regroup-loss marker remains. Boundary closes a terminal result plate while actual board remains intact. **Edges:** no arena units still creates player loss; departed/source/controlled unit cannot cancel it; preexisting actual terminal result is authoritative. Need explicit staged match-result/player pending contract, not a scheduler or unit-incarnation substitute.

## 7. Look the Other Way — target controller pays or exhausts

**All clauses.** Choose any unit including friendly/either arena/deployed leader; its actual controller chooses pay2 or exhaustion. Pay requires two real ready resources of that controller; insufficient payment leaves exhaustion. Existing exhausted unit does not become ready. Printed0 still costs2 here from missing Cunning.

**Primary.** Choose ready W. Event2 P1; P2 explicitly pays resourceIDs0,1, ready7→5; W remains ready4/5/damage1, no exhaust receipt. P1 ready8/10, discards source only. **Signature ~4.6s:** controllerP2's PAY2 / EXHAUST fork resolves two actual resource flags, with a held unchanged ready action latch. **Edges:** exhaust branch pays only source2 and exhausts W, unaffordable pay is rejected, own target uses P1 controller payment after source cost, no stat change. Preserve chosen branch, not a generic “pay to play unit” interpretation.

## 8. Bounty Posting — private whole deck, selected reveal/draw, optional paid upgrade play

**All clauses.** Search own entire deck for a **Bounty-trait upgrade**, reveal/draw it and shuffle deck; not any unit bearing a Bounty keyword. May then play that same upgrade from hand paying full cost/aspects/additional costs and choosing a legal host. Decline/insufficient affordability leaves it in hand. No selection creates no draw/play but still an actual shuffle. Search is private except selected public reveal; no top10/random-bottom substitute.

**Primary.** Known27 deck has Public Enemy `a07:posting:public-enemy` at8, all other entries distinct unknowns. Event3. Search selects/reveals it; explicit remaining permutation selected first plus remaining26 in reversed order (a deliberate valid shuffle), then draw consumes only selected/deck27→26. P1 explicitly pays normal nested0 (Vigilance supplied) and plays **upgrade** onto W: owner/controllerP1, ordinary0/0; W retains4/5/damage1/ready. P1 hand empty/discard source only/ready7/10. Grant its printed Bounty through the actual attached upgrade; **no Shield yet**, no free-unit pose/entry. **Signature ~5.8s:** private deck vault, selected public posting, actual hand arrival and paid0 host attachment chip. **Edges:** real costed bounty with missing aspects, decline, no host, Bounty unit/non-Bounty upgrade rejected, shuffle permutation/count conservation, no implied Bounty collection on attachment.

## 9. Ma Klounkee — successful Underworld return gates damage

**All clauses.** Return a friendly non-leader Underworld unit to its real owner's hand; **if you do**, deal3 ability damage to any unit, friendly/enemy/either arena/deployed leader. No base target. The returned unit is now in hand and cannot receive unit damage. Successful return is prerequisite, not source payment/attempt/upgrade removal. Preserve owner versus controller and ordinary return cleanup.

**Primary.** Replace M with own Underworld Thug `a07:ma:thug` 2/3/damage1/exhausted; Academy `a07:ma:academy` owner/controllerP2 adds2/2, before Thug4/5. Event3; return Thug to P1 hand, Academy to P2 discard; then deal3 to W, existing damage1→4/remainingHP1, readiness unchanged. P1 discard source/handThug/ready7/10, P2 W survives, bases/decks unchanged. **Signature ~5.0s:** intact owner-hand retreat clears an IF RETURNED gate before a counted three-mark ability strike. **Edges:** missing trait/friendly controller/leader, failed/prevented return, damage recipient left arena, owner differing from controller, permitted friendly damage. No attack/exhaustion implied by damage.

## 10. Swoop Down — attack-only cross-arena permission and two stat modifiers

**All clauses.** Attack with a ready friendly space unit if able. For this attack it gains Saboteur and may attack ground units. If target is ground, attacker +2/+0 and defending unit −2/−0 **only this attack**; otherwise no ±2. Saboteur ignores Sentinel and defeats actual defending Shields before combat. Ordinary legal enemy units/base are targets; base gives no counterdamage. Defender power floors at0. No permanent arena move or phase stat change.

**Primary.** Replace T with Pyke Sentinel `a07:swoop:pyke`, ground2/3/damage0/ready/Sentinel; W has Shield `a07:swoop:shield`, token ownerP2/0/0. Event3; X attacks W across space→ground despite Pyke. Grant Saboteur and explicit cross-arena permission; remove the real Shield token before simultaneous combat. X attack power2+2=4 deals4: W damage1→5/defeated to P2 discard. W defending power4−2=2 deals2 to X, which survives exhausted2/3/damage2/restingpower2. Pyke/F and all friendly ground units unchanged; no Overwhelm from defending W/base damage. Ready7/10, no lingering bonus/debuff/keyword/arena permission. **Signature ~5.8s:** measured space-to-ground dive lane, Shield fracture before a paired +2/−2 exchange, survivor held back in its own space slot. **Edges:** space/base target has no ±2; wrong arena/exhausted attacker rejected; zero-floor counterdamage; missing Shield-cause or cross-arena evidence stays generic; actual attachment chip must disappear before hit.

## Minimum shared seams and evidence checks

Use current play/return/search/pay/ready/attack/buff/debuff/keyword/delay/draw primitives; add new semantic meaning only where concrete. Keep explicit staged facts separate from actual replay snapshots.

1. Extend unit-defeat history with optional `defeatedBy:Seat`; Bravado cost helper requires current phase, unit-type and opposing controller at defeat. No discard inference or latest-entry requirement. Record discount witness before paying once.
2. Add **phase-end** owner-hand return pending bound to exact physical ID/continuing incarnation (unit primary), separately selected from immediate scene. Pilot/vehicle-upgrade destinations require their real card/host evidence, not automatic unit handling. Reuse existing owner return cleanup; generic phase scheduling remains out of scope.
3. Add narrow **player** regroup-loss pending and explicit staged terminal result; bind to source/player rather than an arena target. Boundary must not ready resources/draw or replay source payment. Terminal result is a supplied fact, not inferred from counters or simulated combat.
4. `ready` may target actual resources with explicit selected card IDs; update `res.ready` only, preserve total/identities. Add explicit opponent-selected mode and controller pay-or-exhaust choice, separate from unit target chooser and nested unit payment.
5. Link successful return evidence `{id,incarnation,owner}` to Ma's damage and Adventure's owner decision/free fresh play. Existing complete `unit` handles unit replay; no reset of old incarnation/history before actual return and no free claim without explicit payment0.
6. Play actual upgrades from hand/deck with complete `upgrade`, `targetCard` and `playAs:'upgrade'`; distinguish this from an existing attachment transfer. Link optional BountyPosting play to revealed/drawn same ID and actual payment; apply explicit attachment contributions once. Search existing whole/top policies remain distinct.
7. Explicit Bounty-resolution witness identifies before host/entry, actual granted/intrinsic ability and collector, with separate concrete draw/ready/etc receipts. Spare's mere return cannot manufacture this witness. A before attachment's 0/0 stats do not prove its ability was collected.
8. Extend attack scope with explicit cross-arena permission and defending attack-only power modifier linked to the same attackID. Counterdamage uses declared actual defending attack power/floor; resting stats remain unchanged. Do not alter old A03 Saboteur/Shield handling or infer a cross-arena attack from final exhaustion.

Meaningful tests must read installed JSON directly: all ten identities/sole aliases, supporting aliases/traits/stats, exact aspect occurrences and payments; physical conservation; history attribution; opponent/owner/card chooser roles; full private permutation/visibility; return cleanup/new-entry links; all conditional false/zero/declined branches; player loss boundary versus ongoing immediate state; attack-only expiry and actual Shield removal timing. Rendering/suppression share compound evidence gates. Independently inspect desktop/390×844 named contacts **and natural route between them**, overlay-free ending, both future boundaries, repeated replay/reset/seek/cancel/reduced-motion. Authored means no more than source verified and asserted; no ten-card acceptance is claimed here.

## Existing recording availability

Root's read-only discovery `/tmp/swu-a07-recorded-actions.json` contains one action: **Spare the Target**, `replays/demo/games/random-a-vs-random-c-7.jsonl`, indices367..368 (before366). P2 sourcec84 SHD_206 pays actual3, ready11→8/total11, hand→discard. Enemy P1 Maz Kanata LOF_111 c15, ground3/4/damage0/ready, moves to owner P1 hand; P1 hand2→3, P2 hand5→4. No attachments, Bounties, resource-readying or extra draw; bases/decks unchanged. Preserve this actual return and price, with no invented rich Bounty collection. Nine other identities have no existing recording. Discovery is not UI acceptance; no fresh games or replay checks were run for this spec.
