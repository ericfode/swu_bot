# SWU-PGN test vectors

Copied unchanged from [SWU-Karabast/forceteki](https://github.com/SWU-Karabast/forceteki), branch
`swu-game-notation` (draft PR #2350, "A portable game notation system for SWU"), commit
`82dc657b094748681661df3bb6286a9d264a646b`, folder `swupgn/test-vectors/`. They are the spec's normative examples
(docs/SWU-PGN-1.0-SPEC.md, section 20).

| file | what it is | made by (in that branch) |
|---|---|---|
| `minimal.swupgn` | hand-written two-round game, the spec's Appendix A; `Result "Incomplete"` | by hand |
| `organic.swupgn` | engine game: setup with a mulligan, four rounds of plays, attacks and regroups, a concession | `test/server/chat/SwuPgnOrganicGame.spec.ts` |
| `upgrades.swupgn` | a printed upgrade, Advantage / Experience / Shield tokens, the host defeated with all of it attached | `test/server/chat/SwuPgnVectors.spec.ts` |
| `pilot.swupgn` | pilots flown onto vehicles, a piloted vehicle Vanquished | `test/server/chat/SwuPgnVectors.spec.ts` |
| `capture.swupgn` | a unit taken captive, then rescued when its captor is defeated | `test/server/chat/SwuPgnVectors.spec.ts` |

`<name>.fold.json` is the board the reference reader (`swupgn/src/fold.ts`) folds each file to; `swupgn.test.js`
checks that `importer/swupgn.js` folds to the same board.

## License

MIT, as the rest of forceteki:

```
Copyright (c) 2016 Stuart Walsh (https://github.com/ringteki/ringteki)
Copyright (c) 2024 Addison Mayberry

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
