# Card sound language

**Status:** the user listened to this procedural prototype and rejected its sound quality on 2026-10-11. The specification below records the current implementation, not an accepted artistic direction. See [the replacement research and workflow](card-sound-research.md). Passing synthesis and playback tests does not establish sound quality.

The twenty card effects have original procedural scores. They use synthesized oscillators and shaped noise, with no licensed samples, external audio requests, or service cost. Each score combines a quiet card identity with a reusable sound for each recorded outcome. The soundtrack follows the same evidence boundary as the animation: `cue.outcomes` supplies the mechanics. Card rules are never expanded into sounds for branches that were not selected or changes that were not observed.

`studio/src/effects/soundScore.ts` exports `scoreEffect(cue)`. `audio.ts` owns synthesis, playback cancellation, volume and silent offline rendering. The score only returns data. Timing (`at`, `duration`) is a fraction of the card's animation duration; `pitch` and `pitchEnd` are Hz. Noise seeds derive from the card identity and note position, so replaying an example with a new preview nonce preserves its timbre.

## The shared nineteen sounds

| Mechanic | Audible meaning |
| --- | --- |
| Damage | A short low impact with a small electrical scrape. It does not contain the defeat fracture. |
| Defeat | An inharmonic brittle snap followed by collapsing air. It contains no invented damage thud or amount. |
| Heal | Three soft rising mending tones, based on 392, 523 and 659 Hz. |
| Shield | A resonant enclosure rises and locks with a soft upper tone. |
| Strengthen | Two rising, overlapping tones; the second sits an octave above the first. |
| Weaken | Descending pressure followed by a downward mechanical contraction. It does not use damage impact. |
| Draw | A card slip and a light arrival tone. |
| Discard | A dry card slide followed by a low settling latch. |
| Mill | A closely spaced run of card slips directly into a low deck latch. Up to six slips are individually counted. |
| Return to hand | A rising inward air sweep, followed by an intact card catch. No breakage. |
| Recover | A gentle lifting sweep, card insertion and a destination tone: lower for deck bottom, higher for hand. |
| Resource | One card inserts, a mechanism settles, and a low stable pulse confirms the slot. |
| Ready | A mechanical rise and bright relighting tone. |
| Exhaust | The inverse gesture: mechanism descends and its low pulse powers down. |
| Suppress abilities | A high mechanism is rapidly damped into a muffled low pressure bed. |
| Attack | A short release and forward air lunge. A separate damage receipt is required for an impact. |
| Cost reduction | A compact downward adjustment before the effect resolves. No resource-insertion sound. |
| Pay resources | Short downward resource latches; up to six are separately counted. |
| Inspect | A sustained scanning movement followed by a quiet focus pulse. |

The mechanics retain their pitches, intervals and envelopes across cards. Their location changes modestly in stereo according to the acting and receiving seat; they do not attempt to reconstruct precise screen coordinates from a missing layout. Large groups are attenuated so a board-wide effect does not become six times louder than a targeted effect.

## The twenty identities

Every card has a different opening rhythm and spectral shape. These launch textures occur before the result and remain meaningful when a recording provides no resolved outcomes. They contain no result impact, fracture, card movement, protective shell or mending tones. Additional action layers in the final column require the stated receipt.

| Card | Opening identity | Receipt-dependent character |
| --- | --- | --- |
| Open Fire | Three stages of a blaster mechanism arming | With damage: three descending laser reports, then the shared hit. |
| Force Lightning | Low electrical pressure and increasingly bright crackle | With suppression or damage: sustained arcs. Suppression damps down; paid damage has its own later impact. |
| Force Choke | Descending pressure and an uneven low heartbeat | Shared damage lands before the target controller's card draw. |
| Takedown | Two precise targeting servos and a quick intake | With defeat: one narrow, high-to-low shot, then fracture. |
| Vanquish | A wide intake, suspended body tone and opposing sweep | With defeat: two staggered cutting air strokes, then fracture. |
| Superlaser Blast | A low generator gathers three converging harmonics | With defeat: deep beam release, then one removal snap per recipient. The staged six-unit scene has six snaps. |
| Overwhelming Barrage | A heavy mechanism climbs through two firing stages | With damage: three compact artillery reports. Strengthening precedes firing. |
| Bombing Run | Low engine body passes left to right with Doppler-like sweeps | With damage: a descending release; individual observed hits follow the chosen arena's recipients. |
| Make an Opening | A narrowing, descending aperture | Stat contraction precedes the base's softer healing phrase. |
| Repair | Two small repair mechanisms align around a rising body tone | Shared mending triad confirms the actual healing. |
| Restock | Reversing air and a winding spool | Existing cards lift from discard and settle at deck bottom. |
| Resupply | A cargo mechanism rises out of a low motor bed | One card docks as one exhausted resource. |
| Command | A measured low fifth followed by a higher transmission | Only the selected pair of outcomes answers the transmission. |
| Vigilance | A wide, steady surveillance field | Selected heal, Shield, mill or defeat contributes only its own motif. |
| Aggression | A rough low engine and two opposing mechanical accents | Cutting strokes occur only with damage; other selected modes retain their own sounds. |
| Cunning | Asymmetric, alternating side-to-side sweeps and detuned-direction pulses | Return, exhaust, discard or strengthen follows the actual selected result. |
| Power of the Dark Side | A descending low interval inside collapsing air | The chosen unit's defeat provides the fracture. |
| The Force Is With Me | Two gently ascending harmonics inside lifting air | Strengthen, optional Shield, optional attack, then any separately observed damage. |
| Waylay | A descending then rising orbital sweep | The unit retracts intact and catches as a card. |
| Spark of Rebellion | A scanning mechanism with a small electrical ignition | Inspection focuses before the chosen card is discarded. |

## Timing and mix

Most identity textures begin at 0.02–0.24 of the animation and end near 0.30. Mechanical hits sit around 0.35–0.52, followed by travel and settlement around 0.60–0.80. Cost reductions and inspection begin earlier. Force Choke's draw follows its hit. Overwhelming Barrage strengthens before firing. The Force Is With Me grants Experience and a Shield before its optional lunge; damage is an independent later receipt.

Result motifs usually have higher gain than the opening textures. Layered voices use short attacks and releases in the synthesis engine, with a master gain and compressor. Scores are bounded to 48 notes and 12 simultaneous voices; the twenty current staged examples already fit these limits without the engine dropping notes. Very large recorded boards are bounded and repeated outcome groups are attenuated. The display remains the exact source for numerical amounts when a quantity exceeds an individual audible count.

Empty outcomes play only the quiet identity texture. Numeric zero outcomes add no mechanic or conditional action layer. Unknown card identities can still use the shared mechanics but have no invented identity texture. No score calls the rules engine or mutates a cue.

## Checks and audition

`node --test studio/test/card-sound-score.test.cjs` checks all twenty deterministic identities, the nineteen distinct motifs, matching motifs across cards, modal selection, missing and zero outcomes, attack versus damage, intact return versus defeat, six Superlaser removals, Force sequencing, and bounded aggregate counts.

The audio engine's tests and `studio/scripts/render-effect-audio.mjs` cover synthesis and offline audition. An offline peak or RMS result checks the rendered signal; it is not a substitute for listening with the animation. Sound enablement and volume belong to the user-facing player, and paused/scrubbed examples must not repeatedly trigger notes.
