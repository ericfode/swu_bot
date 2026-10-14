# Compiled bots

A compiled bot is a bot program built to WebAssembly (WASI preview 1) and packed as a **bundle**: a folder with
`arena.json` and the files it names. A bundle runs the same on any machine, in a sandbox, and its id (a sha256) is the
bot's version. The format is `swu-arena-bot/1` from the bot packaging design
(`/mnt/project-files/research/bot-packaging/design.md`, section 3).

The arena (`bot/arena`) plays the bots people submit on its window this way: its intake (`bot/arena/intake.js`)
packs each one into a bundle, and the arena runs it with `run.py`. The project's own bots and their sources live in
[holocron](https://github.com/ericfode/holocron); they reach the arena as submitted entries too. `build.py` keeps one
bundle of its own, `node-random` (the protocol random bot in `bot/test/fixtures/`, registered as `node-random-wasm` in
`bot/external-bots.json`), which the sandbox's tests play.

## Use

```bash
python3 -m pip install wasmtime==49.0.0          # once
python3 bot/compiled/build.py --tools          # only Javy and CPython for WASI: what the arena's intake packs with
python3 bot/compiled/build.py                  # node-random into build/compiled/node-random/, id in build/compiled/index.json
python3 bot/compiled/bundle.py build/compiled/node-random   # print a bundle's id and sizes
```

The first build downloads Javy 8.0.0 and CPython 3.14.7 for WASI (`toolchain.json` pins their URLs and sha256) into
`build/compiled/.tools`. `build/` is not in git.

## Files

- `build.py` builds bundles (`BOTS`, today only `node-random`) and fetches the intake's tools (`--tools`).
- `run.py` runs one bundle as a normal stdio bot program: `python3 bot/compiled/run.py build/compiled/<name>`. It
  checks the bundle (`bundle.load`), then runs it under wasmtime.
- `bundle.py` reads and checks `arena.json`, and computes the bundle id: the sha256 of the bundle as a canonical tar
  (sorted entries, mtime 0, uid and gid 0, modes 0644 or 0755).
- `compare.py` pairs `<name>` and `<name>-wasm` games in a ladder run by opponent, seed and seat (does a bundle play
  the same games as the program it was built from?).
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

On 2026-10-11 the bundles of nine of the project's bots (Rust, C, Python and JS; now in holocron) played the same seeds
as their native programs with `--key none`, and `compare.py` paired the games: every pair had the same winner, and all
but two `py-clock` pairs were identical (`python.wasm` is a 32-bit build, so `hash()` and set order differ from 64-bit
Python). Rust and C ran at 1.1-1.5x native; the JS bundles run QuickJS, an interpreter, at about 38x Node for pure
compute (4-5x for message handling). The full table is in this file's history. Bundle ids repeat from build to build
for Rust, C and Python; Javy's output differs in a few bytes each build, so a JS bundle gets a new id every build.

## Not here yet

- Bots that read the engine directly need a port to protocol simulations first: the arena still plays `heuristic`
  and `rush` in process (holocron's `bots/ports` has their protocol v2 ports).
- `native` (Linux) bundles, the arena's registry reading `arena.json`, and per-round versions on the Open table.
