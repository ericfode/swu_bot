# Compiled bots

A compiled bot is a bot program built to WebAssembly (WASI preview 1) and packed as a **bundle**: a folder with
`arena.json` and the files it names. A bundle runs the same on any machine, in a sandbox, and its id (a sha256) is the
bot's version. The format is `swu-arena-bot/1` from the bot packaging design
(`/mnt/project-files/research/bot-packaging/design.md`, section 3).

This folder builds 9 of our bots that way and plays them like any other bot program, as `<name>-wasm` in
`bot/external-bots.json`. The arena (`bot/arena`) does not use it yet.

| Bundle | Source | How it is built | Runtime | gzip size |
|---|---|---|---|---|
| `rust-random`, `rust-greedy`, `rust-greedy2`, `rust-search` | `bot/rust` | `cargo build --target wasm32-wasip1`, one `bot.wasm`, the policy is an argument | `wasi-p1` | 172 KB |
| `c-clock` | `bot/c` | `zig cc --target=wasm32-wasi` | `wasi-p1` | 37 KB |
| `py-random` | `bot/examples/random_bot.py` | the `.py` files, copied | `python-3.14-wasi` | 1.4 KB |
| `py-clock` | `bot/python` | the `.py` files, copied (not `test_*`) | `python-3.14-wasi` | 15 KB |
| `node-random`, `node-search` | `bot/examples/*.js` | `js/bundle.js` packs the program and its requires into one script, Javy compiles it with QuickJS | `wasi-p1` | 514 KB |

## Use

```bash
python3 -m pip install wasmtime==49.0.0 ziglang==0.17.0   # once; rustup target add wasm32-wasip1 for the Rust bots
python3 bot/compiled/build.py                  # all 9 into build/compiled/<name>/, ids in build/compiled/index.json
python3 bot/compiled/build.py c-clock          # just one
node bot/ladder.js --bots c-clock,c-clock-wasm --vs rush --games 6 --key none --out results/wasm-check
python3 bot/compiled/compare.py results/wasm-check   # same games as the native build?
python3 bot/compiled/bundle.py build/compiled/c-clock   # print a bundle's id and sizes
```

The first build downloads Javy 8.0.0 and CPython 3.14.7 for WASI (`toolchain.json` pins their URLs and sha256) into
`build/compiled/.tools`. `build/` is not in git.

## Files

- `build.py` builds bundles. `BOTS` lists them; add a bot there.
- `run.py` runs one bundle as a normal stdio bot program: `python3 bot/compiled/run.py build/compiled/<name>`. It
  checks the bundle (`bundle.load`), then runs it under wasmtime.
- `bundle.py` reads and checks `arena.json`, and computes the bundle id: the sha256 of the bundle as a canonical tar
  (sorted entries, mtime 0, uid and gid 0, modes 0644 or 0755).
- `compare.py` pairs `<name>` and `<name>-wasm` games in a ladder run by opponent, seed and seat.
- `js/bundle.js`, `js/serve.js`, `js/crypto.js`: the JS bundler and what it swaps in. `bot/stdio.js` becomes
  `js/serve.js` (the same `serve()` over Javy's blocking stdin and stdout), and `crypto` becomes a sha1-only shim.
  Any other Node built-in stops the build. Tests: `bot/test/compiled.test.js`.
- `toolchain.json`: pinned tools and the Python runtime.

## The sandbox

`run.py` gives the bot:

- stdin and stdout (the protocol lines), and stderr unless `--quiet`;
- read-only folders only: the bundle at `/bot`, the card data at `/cards` when `cards.use` is `mount`
  (`$SWU_CARD_JSON` on the host, else `forceteki/test/json`), and for Python the standard library at `/usr/local/lib`;
- the environment from the manifest and runtime, nothing inherited;
- a memory cap (`resources.memory_mb`, default 512), and optional `--fuel` per reply and a `--wall-s` watchdog.

No network (WASI preview 1 has no sockets), no writable files, no other programs. Compiled machine code is cached in
`build/compiled/.cache` by the sha256 of the module, and `build.py` fills that cache so the first game does not spend
its `hello` time compiling. Never load `.cwasm` files from anywhere else: wasmtime trusts them as machine code.

## Same games as native?

Run with `--key none` so both builds see the same seeds and deals.

- Rust, C and JS bundles play the same games as their native builds.
- `py-random` plays the same games.
- `py-clock` picks the same winners but some games differ: `python.wasm` is a 32-bit build, so `hash()`, and with it
  set order, differs from 64-bit Python even with `PYTHONHASHSEED=0` (which both runs set), and some ties break the
  other way. Each build is repeatable on its own.

Speed: Rust and C run at 1.1-1.5x native compute. The JS bundles run QuickJS, an interpreter, so pure JS compute is
about 38x slower than Node; message handling is 4-5x. For search bots the referee's simulations take most of the time
either way.

## Not here yet

- Bots that read the engine directly (the heuristic family, ISMCTS, learned bots, the arena's JS agents) need a port
  to protocol simulations first; `omni` stays native.
- `native` (Linux) bundles, the arena's registry reading `arena.json`, and per-round versions on the Open table.
