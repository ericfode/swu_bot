# Synthetic review diagnostics

These four complete engine games use explicitly replaced abilities and dedicated
raw IR mirrors. They are **not printed-card conformance evidence** and are excluded
from the 200 actual-source games and all admission counts.

The cases distinguish primary healing from contingent fatigue (starting damage
29 and 1), an empty discard group's result after a successful draw, and a false
conditional with an omitted else branch. Each directory retains the original
engine trace, generator, comparison copy and compressed mirror catalogue/pool.
The index records every hash and metadata adjustment. Every state, decision and
terminal record is identical between each original and comparison trace; only
metadata identifies the dedicated comparison inputs and synthetic registration.

Both the engine registration and the raw IR mirror change every instance of the
selected card definition, with targets relative to each card's controller. The
registrations happen before the first recorded state and input, followed by a
game-state and prompt refresh. Earlier single-instance diagnostics are retained
under `../review-corrections/single-instance-diagnostics-retired` and do not
authorize the final implementation. The captured generators retain their original
local paths; the checker below uses the portable compressed inputs.

From the repository root, after building both runtimes:

```sh
python3 bot/omni-rs/tests/card-batches/003/review-diagnostics/check.py native
python3 bot/omni-rs/tests/card-batches/003/review-diagnostics/check.py wasm
```

Matching unit regressions are part of the Rust core suite. These full diagnostic
games are verified separately and are not loaded with the ordinary card catalogue.
