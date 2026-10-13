# Replacing the rejected sound prototype

Research and implementation audit, 2026-10-11.

The user listened to the twenty procedural cues and rejected their sound quality. The earlier checks established playback, timing, bounded synthesis, and clean signal levels. They did not establish that the effects were enjoyable, convincing, or appropriate for Star Wars. This document proposes a different production approach; it does not claim that replacement sounds have been made or auditioned.

## What the practitioners do

**Start with characterful source material.** Ben Burtt describes Star Wars sound as grounded in recordings of real objects, transformed into unfamiliar contexts. That supplies irregularity, material identity, and associations before electronic processing. This supports a recording-led direction for this project; it does not mean synthesis is inherently unsuitable. [Ben Burtt interview, StarWars.com](https://www.starwars.com/news/empire-at-40-ben-burtt-interview)

**Design the card's dramatic event.** Hearthstone's sound team works from card art, emotional impact, fixed gameplay pacing, and cast/hit beats. Their spell and creature examples combine physical recordings with processing. They also explicitly discuss choosing which sounds should be heard and which should be omitted. The closest lesson for this viewer is to author one coherent event per play while preserving essential gameplay information. [Hearthstone sound team, Blizzard](https://news.blizzard.com/en-us/article/23964694/inside-battle-net-meet-the-sound-team-behind-hearthstones-harmonic-design)

**Give each layer a job.** The Ascent's designers describe collecting sources for punch, mechanical character, crack, texture, noise, and environment. Much of their processing was ordinary dynamics, gating, and editing. The useful capability is selecting and combining complementary material; a larger plugin collection does not itself provide that judgment. [The Ascent sound team interview](https://www.asoundeffect.com/the-ascent-game-audio/)

**Control what dominates the mix.** Jedi: Survivor's team describes refining impact, contextual processing, shared reverberation, and mixing so important gameplay sounds remain audible. Their bubble-shield example combines synthesizer patches with processed plastic and packing-tape recordings. They also describe frequent playtesting, including listening with eyes closed. This is a useful model for combining electronic identity with physical texture and checking perception in context. [Jedi: Survivor sound team interview](https://www.asoundeffect.com/star-wars-jedi-survivor-game-audio/)

**Make layers fuse.** iZotope's layering guide recommends purposeful source selection, aligning attacks, avoiding competing low-frequency layers, and care with compression that suppresses transients. Its examples concern drums; applying these principles to our weapon impacts is an engineering/design inference. [iZotope layering guide](https://www.izotope.com/community/blog/layering-drums-benefits-pitfalls-and-techniques)

**Vary performances within an identity.** Unity documents clip shuffle, avoiding recent repeats, and bounded pitch/volume variation. We can use the same idea without adopting Unity: select among authored alternatives using the recorded action ID, preserving deterministic replay. [Unity Audio Random Container](https://docs.unity3d.com/Manual/AudioRandomContainer-UI.html)

## What is wrong with the current approach

These are source-code observations and design risks, not a claimed listening evaluation.

| Current implementation | Consequence or risk |
| --- | --- |
| `audio.ts` builds every voice from oscillator mixtures and the same fixed 120/2200 Hz noise filters. It contains no recorded material or room response. | A narrow palette can make mechanically different effects feel like variations of the same electronic toy. This is a likely explanation, not a measured perception result. |
| The `whoosh` pitch controls affect only a quiet sine component; its dominant noise bands stay fixed. The `card` voice does not use pitch at all. | Many score parameters do not produce the intended moving air or card-texture changes. A detailed-looking score overstates the range of the synthesizer. |
| `soundScore.ts` combines a launch phrase, a motion phrase, and a motif for every outcome. Damage and defeat can both add their own repeated layers for multiple victims. | Individual result sounds compete with the main event. A six-unit wipe should have one dominant discharge/destruction gesture, with subordinate debris. The screen can carry the exact count. |
| Healing, buffing, shielding, and several other actions use related pitched pulses/chimes. | These may communicate a UI category but offer little material distinction or dramatic character. |
| Event durations multiply total animation length. | Changing visual pacing changes the sound envelope's physical character. Trigger onset should follow contact; the short attack and decay should be authored independently. |
| Noise seeds depend on card ID, note index, and voice. Replays of the same outcome pattern are identical. | Repetition will expose the construction. Authored alternate takes and restrained variation are preferable. |
| Every voice uses `tanh`; every cue has a 16:1 compressor with a 3 ms attack. | These are potential transient/contrast problems. Actual harshness, pumping, or gain reduction must be evaluated by listening and measurement; the settings alone do not establish those defects. |
| The voice cap accepts notes chronologically. | Under sufficiently dense input, a later important result can be dropped while less important earlier sounds remain. Preserve the principal event before optional detail. |

See [audio.ts](../studio/src/effects/audio.ts) and [soundScore.ts](../studio/src/effects/soundScore.ts). The existing unlock, mute, cancellation, and volume plumbing is useful and can be retained.

## Proposed direction for the cards

These are authoring briefs, not descriptions of completed audio.

| Card/family | Source palette and intended gesture |
| --- | --- |
| Open Fire | A struck spring or tensioned-metal recording for the distinctive snap, a compact physical impact for body, a restrained electronic accent, and a short tail. Each visible shot should feel like a discharge. |
| Force Lightning | Irregular electrical/crackling source, strained resonant metal, and controlled low-frequency pressure. Shape the texture's brightness and intensity through the arc, then end with a decisive cut or discharge. |
| Superlaser Blast | A rising machine/energy texture, a moment of contrast before release, one broad heavy discharge, and a decaying destruction bed. Small debris sounds support scale; six matching notification-like fractures should not dominate. |
| Repair / beneficial Force effects | Small tactile mechanism or resonant material, warm filtered air, and a subtle resolving tone. Healing, protection, and strengthening can share a family without all becoming ascending chime sequences. |
| Return / draw / discard / resource | Close, tactile card movement and destination-specific catches, with restrained spectral treatment for the supernatural cases. Everyday card handling should leave room for the rare dramatic effects. |

The common ability language should constrain meaning and family resemblance. It should not require every badge to have an equally prominent sound. Similar damage can retain a recognizable impact character while blasters, lightning, and an orbital weapon have different sources and scale.

## A practical replacement workflow

1. **Set the reference and target.** Select a few practitioner examples for material character, scale, and pacing. Describe the intended feeling in plain words before choosing DSP parameters. Use references to guide original work, not as extracted game assets.
2. **Make three prototypes first:** Open Fire, Force Lightning, and Superlaser Blast. Together they test short transients, sustained texture, and a large cinematic event. Produce a few substantially different versions of each before expanding to twenty.
3. **Choose real source material.** Record suitable physical objects or use source recordings with an appropriate license. Keep source and license provenance with the project. Synthesis supplies controllable low end, energy, or modulation where it improves the result.
4. **Edit to the animation.** Place markers for charge, discharge, contact, and settlement. Give the sound an intentional attack, body, texture, and tail where each is useful. Keep physical envelope lengths independent of total visual duration. Do not fill every available millisecond.
5. **Mix deliberately.** Choose which layer owns the initial attack and low end; remove competing material. Align layers by ear so they read as one event. Use automation and filtering before adding blanket compression. Reserve space around the main hit and keep minor gameplay confirmations subordinate.
6. **Listen before expanding.** Compare alternatives at matched perceived level, with and without the animation. Test quiet playback, ordinary speakers, headphones, and repeated plays. Ask whether the source/action is identifiable, the hit coincides with contact, the large event feels large, and any high-frequency texture becomes tiring. The user's listening judgment is the acceptance criterion.
7. **Integrate approved assets.** Render the authored core and optional tails/layers, then schedule them through the existing Web Audio player. Keep subtle variations deterministic per recorded action. Aggregate simultaneous outcomes and prioritize the principal event. Retain tests for clipping, cancellation, silence while scrubbing, and resource bounds as technical checks.

REAPER is a suitable authoring option: its documented tools cover multitrack editing, video, pitch/time processing, automation, EQ, compression, reverb, and region rendering. The first pass does not require a special game-audio middleware or a collection of premium effects. [REAPER capabilities](https://www.reaper.fm/about.php)

The next quality milestone is three convincing, listened-to prototypes. Twenty generated files and twenty different hashes are not an artistic milestone.
