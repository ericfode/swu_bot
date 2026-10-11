# swu-bot-rs

Star Wars Unlimited bots in Rust. The engine stays in JS: `bot/players/external.js` runs forceteki, lists the legal
actions and applies the one this process picks, over the stdio JSON Lines protocol: v1 (`spec/stdio-protocol.md`),
or v2 (`spec/protocol.md`) when the referee offers it. No engine code is needed on the Rust side.

    cargo build --release --manifest-path bot/rust/Cargo.toml
    node bot/tournament.js --bots rust-greedy,heuristic --games 10 --out replays/rust
    node bot/rust/check.js 10 1                  # both Rust bots vs random-a, both seats

Policies (first CLI argument, registered as `rust-<policy>` in `bot/external-bots.json`):

- `random`: uniform, seeded from the game's `hello`.
- `greedy`: rules over the wire data only: play cards, attack with the biggest ready unit, hit enemy threats, help
  own units; loop guards for no-op choices.
- `greedy2`: greedy plus card data and combat math. It reads costs, aspects, keywords and upgrade stats from the
  engine's card JSON (`src/cards.rs`; `$SWU_CARD_JSON`, default `forceteki/test/json`, without it it falls back to
  rules). Leader deploy first (it is free and the leader arrives ready), lethal attacks, attacks that kill a ready
  enemy unit, then the set of hand cards that uses the most ready resources, most expensive first (removal held until
  there is a target), then the other attacks, then claim initiative. Attack targets
  weigh base damage against trades (kill value, damage taken back, shields, overwhelm, sentinels). Resources the
  expensive and off-aspect cards, keeps cheap on-aspect units. Sends its own damage/healing split for `distribute`.
- `search`: greedy2 plus lookahead with v2 simulations (`sim` requests). At a decision it takes greedy2's six best
  actions; for each it starts a simulation (hidden cards dealt again, the same deal for every candidate), plays the
  action, lets greedy2 play both seats until the round's action phase ends (60 steps at most), and scores the board
  from its seat (base HP, steeper below 12; units; cards in hand; resources; initiative). It plays the best score and
  uses at most a third of the decision's time, 3 s at most. Under a v1 referee it plays exactly like greedy2.

Add one in `src/policy/` and a line in `bot/external-bots.json`.

Real cards, forceteki 2be4fcd, both seats per seed (`node bot/ladder.js --bots a,b --games N`):

| Match | Result |
| --- | --- |
| greedy vs random-a | 19-1 (`check.js 10 1`) |
| greedy2 vs greedy | 19-1 |
| greedy2 vs rush (best JS bot) | 29-11; 78-21 over 100 games (seeds 101-150) |
| Ladder: greedy2, greedy, rush, tempo, random (10 games per pair, seeds 201-250) | greedy2 33-5 (87%, first); rush 65%, tempo 51%, greedy 42% |

Decision time: the Rust policy takes about 30 us; the harness measures about 1 ms per decision because the adapter
builds and sends the board JSON. The JS search bots (tempo, heuristic) average 170-430 ms.

## Why a subprocess

| Route | Verdict |
| --- | --- |
| **Child process, JSON Lines over stdio** (this) | Any language, no build coupling with Node, a crashed bot only fails its game. Measured ~80 us per round trip; the engine itself takes ~1-5 ms per decision. |
| WASM loaded into Node | Same speed class, but ties the bot to wasm-bindgen and the JS heap. Can be added later behind the same `choose()`. |
| napi-rs native addon | Fastest calls, but a per-platform native build for everyone running the tournament. |
| Port the engine to Rust | Not realistic: ~2000 card implementations. |

A stdio bot searches through protocol v2 simulations: the referee keeps the engine and runs moves on a private copy
for the bot, so the Rust side needs no game model.
