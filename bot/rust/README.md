# swu-bot-rs

Star Wars Unlimited bots in Rust. The engine stays in JS: `bot/players/external.js` runs forceteki, lists the legal
actions and applies the one this process picks, over the stdio JSON Lines protocol in `spec/stdio-protocol.md`.
No card data or engine code is needed on the Rust side.

    cargo build --release --manifest-path bot/rust/Cargo.toml
    node bot/tournament.js --bots rust-greedy,heuristic --games 10 --out replays/rust
    node bot/rust/check.js 10 1                  # both Rust bots vs random-a, both seats

Policies (first CLI argument): `random` (seeded from the game's `hello`) and `greedy` (rules over the wire data:
play cards, attack with the biggest ready unit, hit enemy threats, help own units; loop guards for no-op choices).
Add one in `src/policy/` and a line in `bot/external-bots.json`.

## Why a subprocess

| Route | Verdict |
| --- | --- |
| **Child process, JSON Lines over stdio** (this) | Any language, no build coupling with Node, a crashed bot only fails its game. Measured ~80 us per round trip; the engine itself takes ~1-5 ms per decision. |
| WASM loaded into Node | Same speed class, but ties the bot to wasm-bindgen and the JS heap. Can be added later behind the same `choose()`. |
| napi-rs native addon | Fastest calls, but a per-platform native build for everyone running the tournament. |
| Port the engine to Rust | Not realistic: ~2000 card implementations. |

What a stdio bot cannot do yet is search: it cannot roll the engine back to try moves (see "Not in v1" in the spec).
A search bot in Rust needs either its own game model or a `try` request in a later protocol version.
