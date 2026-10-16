# Compiled bots

A compiled bot is a bot program built to WebAssembly (WASI preview 1) and packed as a **bundle**: a folder with
`arena.json` and the files it names. A bundle runs the same on any machine, in a sandbox, and its id (a sha256) is the
bot's version. The format is `swu-arena-bot/1` from the bot packaging design
(`/mnt/project-files/research/bot-packaging/design.md`, section 3), less its `cards` field: since 2026-10-16 a bot
gets the card data in `hello.cards`, the sandbox mounts no `/cards`, and the intake refuses `"cards": {"use": "mount"}`
(below). The design's other mentions of `/cards` and `SWU_CARD_JSON` no longer apply either.

The arena (`bot/arena`) plays the bots people submit on its window this way: its intake (`bot/arena/intake.js`)
packs each one into a bundle, and the arena runs it with `run.py`. The project's own bots and their sources live in
[holocron](https://github.com/ericfode/holocron); they reach the arena as submitted entries too. `build.py` keeps one
bundle of its own, `node-random` (the protocol random bot in `bot/test/fixtures/`, registered as `node-random-wasm` in
`bot/external-bots.json`), which the sandbox's tests play.

## Use

```bash
python3 -m pip install wasmtime==49.0.0          # once, into the interpreter or a virtualenv (python3 -I skips --user installs)
python3 bot/compiled/build.py --tools          # only Javy and CPython for WASI: what the arena's intake packs with
python3 bot/compiled/build.py                  # node-random into build/compiled/node-random/, id in build/compiled/index.json
python3 bot/compiled/bundle.py build/compiled/node-random   # print a bundle's id and sizes
```

The first build downloads Javy 8.0.0 and CPython 3.14.7 for WASI (`toolchain.json` pins their URLs and sha256) into
`build/compiled/.tools`. `build/` is not in git. A `build/compiled/.cache` made by an older `run.py` can be writable by
your group, and `run.py` then does not use it (`build.py` stops with "could not keep the compiled code"): delete it once.

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
- read-only folders only: the bundle at `/bot`, and for Python the standard library at `/usr/local/lib`;
- the environment from the manifest and runtime, nothing inherited;
- a memory cap (`resources.memory_mb`, default 512), and optional `--fuel` per reply and a `--wall-s` watchdog.

No card files either: like every bot, a bundle gets the card data in `hello.cards`
([spec/protocol.md](../../spec/protocol.md#hello--ready)), and `run.py` mounts nothing whatever `arena.json` says.
Bundles no longer have a `cards` key, and the intake (and the arena API's `submit`) refuses a submitted bundle whose
`cards.use` is `mount`. A version entered before 2026-10-16 that still has the key runs, without card files.

No network (WASI preview 1 has no sockets), no writable files, no other programs. Compiled machine code is cached in
`build/compiled/.cache` (`$SWU_WASM_CACHE`) by the sha256 of the module, and `build.py` fills that cache so the first
game does not spend its `hello` time compiling. Never load `.cwasm` files from anywhere else: wasmtime trusts them as
machine code. So `run.py` uses the cache only when its folder is root's or yours and nobody else can write in it, and
loads only entries of the folder's owner; a cache it cannot write is no error (what it compiled runs from memory). On
the games machine the cache is root's: root compiles into it and the games, as the bots' user, only read it. Run
`run.py` with `python3 -I` (the arena does), so wasmtime must be installed where Python finds it without the user's
site folder or `PYTHONPATH` (`pip install wasmtime` into the interpreter or a virtualenv).

Start-up counts against the bot's clock, so `run.py` keeps it short. A bot reads no card files, so what is left at
start is compiling (the cache above) and the files the bot itself opens. wasmtime hands every WASI file call to a
thread of its own and waits for it, and in a VM a hand-off to another CPU costs about eight times one on the same CPU.
So until the first reply `run.py` and its threads run on one CPU (`SWU_WASM_PIN=off` turns it off), and then every
thread goes back on all its CPUs. That still helps a Python bundle, which imports its standard library from
`/usr/local/lib` at start: `py-random` answered `hello` in 0.50 s on all CPUs and 0.44 s pinned (2026-10-16, four CPUs,
a 28 KB `hello`). A bundle that opens no files at start, such as a JS bundle, gains nothing (`node-random`: 0.13 s
either way). A browser tab (`bot/swarm/wasi.js`) serves the same files from memory.

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
