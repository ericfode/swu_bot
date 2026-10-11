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

The mirror changes every instance of the selected card definition, while the
engine generator changes the initial scripted instance. Full-game comparison
checks these recorded executions; it does not assert equivalence for arbitrary
later uses of that synthetic definition.

From the repository root, after building both runtimes:

```sh
python3 bot/omni-rs/tests/card-batches/003/review-diagnostics/check.py native
python3 bot/omni-rs/tests/card-batches/003/review-diagnostics/check.py wasm
```

Matching unit regressions are part of the Rust core suite. These full diagnostic
games are verified separately and are not loaded with the ordinary card catalogue.
