# Holotable animation integration audit

Independent reviewer: `animation_a05_spec`, GPT-6.1-sol / xhigh. This was a bounded, read-only source audit of the accepted 180-card integration on `codex/holotable-animation-support`, based on `origin/main` (`7679536`). The reviewer wrote this report only; implementation, builds and browser verification were performed by the integrator. A17 and later batches are excluded from this MR.

**Source audit clear.** The main branch's score resolver, weights panel, atlas data and unit-tracking implementation remain unchanged. Existing v2 replay fields are preserved, while explicit staged-only presentation fields are optional. Ordinary recorded snapshots are not assigned invented future obligations or history.

The replay integration uses one keyed effect scene and reverts its Anime.js timeline when replaced or unmounted. Backward and large seeks clear active effects; external seeking stops autoplay. Recorded animations display their authoritative before snapshot and select that snapshot's score. Staged examples have no recorded positional score. Adaptive lanes reserve the maximum actual before, after and supported intermediate counts; destination probes reuse the same adaptive layout function and remove duplicate IDs.

One score-context defect was found and corrected. `Board` received the score for the displayed before snapshot, but `CardInspector` and `FloatingZoom` received the after-step playhead score. Their value breakdown combines the supplied step's weights, seat values and win chance with the hovered card's value, so the mismatch could explain a before-board card using after-step context. Both inspector props now receive `boardScore`; the obsolete playhead-score memo was removed. Independent reread verified exactly these changes and the corresponding API-comment update. No other actionable defect emerged in this bounded audit.

Final reviewed source hashes:

- `studio/src/kit/GameViewer.tsx`: `6fd5ece46282a6eb79689bec8a1881ed2bb768c0d67cd92d9b55033b9879a42e`
- `studio/src/components/CardZoom.tsx`: `3ffbece657f05c15a82225d8f25e6ff87f2fcf49ccb26bb57bbbe3144cf36fbb`

The integrator's completed validation was read separately: 632/632 studio tests, application typecheck/build and embedded-kit build pass. Existing final-board browser verification covers 392 cases at both sizes, and all four available recorded-action checks pass before/after, Replay and backward seeking. These are integrator-executed receipts, not reviewer execution or a second full pixel matrix. The integrator retains initial failed captures and the mechanical unused-memo typecheck failure before its correction, and owns the final matching served-manifest readback before opening the MR.

`git diff --check origin/main` passes. No new games, engine changes, paid-provider calls or additional broad capture matrix were run for this audit. The corrected A17 isolated candidate has a separate adoption clearance; it does not expand this MR's accepted180 boundary.
