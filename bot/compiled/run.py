#!/usr/bin/env python3
"""
Run a compiled bot bundle (bot/compiled/README.md) as a normal stdio bot program, sandboxed by wasmtime.

    python3 bot/compiled/run.py build/compiled/rust-greedy2 [--fuel N] [--memory-mb N] [--wall-s S] [--quiet] [--warm]

The bundle is a folder with arena.json and the files it lists. The runner checks every file against its sha256,
then runs the WebAssembly (WASI preview 1) program with:
  - stdin / stdout of this process: protocol v2 JSON lines pass straight through (spec/protocol.md),
  - stderr (dropped with --quiet),
  - read-only folders only: the bundle at /bot, card data at /cards when the bundle asks for "cards", and for Python
    bundles the standard library of the pinned python.wasm,
  - the environment it sets here (nothing is inherited), a clock and random numbers.
No sockets (WASI preview 1 has none), no writable files, no subprocesses.

Limits:
  --memory-mb N   linear memory cap (default: the bundle's memory_mb, else 512). Past it, allocation fails in the bot.
  --fuel N        wasm fuel (about one unit per instruction) per reply, refilled each time the bot finishes a reply line
                  other than a `sim` request; waiting on stdin burns none. Running out traps, which the referee scores
                  as a forfeit. 0 (default) = off: the referee's per-decision clock is the limit.
  --start-fuel N  separate fuel for start-up up to the first reply (default: --fuel).
  --wall-s S      epoch watchdog: trap after S seconds of total run time (0 = off), a coarse backstop.
Stats (fuel per reply, startup, memory) go to $WASM_HOST_STATS as one JSON line at exit.
Compiled machine code is cached by the sha256 of the module in $SWU_WASM_CACHE (default build/compiled/.cache).
Never load .cwasm files from anywhere else: they are trusted machine code.
"""
import argparse
import ctypes
import hashlib
import json
import os
import sys
import threading
import time

T0 = time.perf_counter()

import wasmtime  # noqa: E402  (pip install wasmtime; tested with 49.0.0)
from wasmtime import _ffi as ffi  # noqa: E402
from importlib.metadata import version as _version  # noqa: E402

WASMTIME = _version("wasmtime")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bundle  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
WASI = "wasi_snapshot_preview1"
EBADF = 8
EFAULT = 21


def die(msg):
    sys.stderr.write("[compiled] %s\n" % msg)
    sys.exit(2)


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--memory-mb", type=int, default=0)
    ap.add_argument("--fuel", type=int, default=0)
    ap.add_argument("--start-fuel", type=int, default=0, help="fuel until the first reply (start-up); default --fuel")
    ap.add_argument("--wall-s", type=float, default=0)
    ap.add_argument("--quiet", action="store_true", help="drop the bot's stderr")
    ap.add_argument("--warm", action="store_true", help="check the bundle and compile it into the cache, then exit")
    ap.add_argument("bundle")
    o = ap.parse_args()

    folder = os.path.abspath(o.bundle)
    try:
        m = bundle.load(folder)
    except bundle.BundleError as e:
        die("%s (build bundles with: python3 bot/compiled/build.py)" % e)
    name = m.get("name") or os.path.basename(folder)
    with open(os.path.join(HERE, "toolchain.json")) as f:
        toolchain = json.load(f)
    tools = os.path.join(ROOT, "build", "compiled", ".tools")
    preopens = [(folder, "/bot")]
    env = dict(m["run"].get("env", {}))
    cards = m.get("cards", {"use": "none"})
    if cards.get("use") == "mount":
        host = os.environ.get("SWU_CARD_JSON") or os.path.join(ROOT, "forceteki", "test", "json")
        preopens.append((host, "/cards"))
        env.update(cards.get("env", {"SWU_CARD_JSON": "/cards"}))
    runtime = m["runtime"]
    if runtime == "wasi-p1":
        wasm_path = os.path.join(folder, bundle.entry_file(m))
        argv = [name] + list(m["run"].get("args", []))
    elif runtime in toolchain["runtimes"]:
        rt = toolchain["runtimes"][runtime]
        home = os.path.join(tools, rt["dir"])
        wasm_path = os.path.join(home, rt["wasm"])
        if not os.path.exists(wasm_path):
            die("runtime %s is not installed (python3 bot/compiled/build.py fetches it)" % runtime)
        for host, guest in rt.get("preopen", {}).items():
            preopens.append((os.path.join(home, host), guest))
        env.update(rt.get("env", {}))
        args = list(m["run"].get("args", []))
        argv = [m["run"]["cmd"], "/bot/" + bundle.safe_rel(args[0])] + args[1:]
    else:
        die("unknown runtime %r" % runtime)

    cfg = wasmtime.Config()
    if o.fuel:
        cfg.consume_fuel = True
    if o.wall_s:
        cfg.epoch_interruption = True
    engine = wasmtime.Engine(cfg)

    t_compile = time.perf_counter()
    wasm_bytes = open(wasm_path, "rb").read()
    cache_dir = os.environ.get("SWU_WASM_CACHE") or os.path.join(ROOT, "build", "compiled", ".cache")
    os.makedirs(cache_dir, exist_ok=True)
    # machine code depends on the wasmtime version and on the fuel and epoch settings, so they are part of the key
    key = hashlib.sha256(wasm_bytes + repr((WASMTIME, o.fuel > 0, o.wall_s > 0)).encode()).hexdigest()
    cpath = os.path.join(cache_dir, key + ".cwasm")
    module = None
    if os.path.exists(cpath):
        try:
            module = wasmtime.Module.deserialize_file(engine, cpath)
        except wasmtime.WasmtimeError:
            pass  # cut short or from another wasmtime: compile again, and replace it below
    cached = module is not None
    if not cached:
        module = wasmtime.Module(engine, wasm_bytes)
        tmp = cpath + ".%d.tmp" % os.getpid()
        with open(tmp, "wb") as f:
            f.write(module.serialize())
        os.replace(tmp, cpath)
    compile_ms = (time.perf_counter() - t_compile) * 1000
    if o.warm:
        sys.stderr.write("[compiled] %s: %s in %.0f ms\n" % (name, "cached" if cached else "compiled", compile_ms))
        return

    store = wasmtime.Store(engine)
    store.set_limits(memory_size=(o.memory_mb or m.get("resources", {}).get("memory_mb") or 512) * 1024 * 1024)
    wasi = wasmtime.WasiConfig()
    wasi.argv = argv
    wasi.env = sorted(env.items())
    wasi.inherit_stdin()
    for host, guest in preopens:
        wasi.preopen_dir(host, guest, False)  # fs_mutable=False: read-only
    store.set_wasi(wasi)

    linker = wasmtime.Linker(engine)
    linker.define_wasi()
    linker.allow_shadowing = True

    stats = {"bundle": name, "fuel_per_reply": [], "replies": 0, "sims": 0}
    out = sys.stdout.buffer
    err = sys.stderr.buffer
    line = bytearray()

    def on_line(caller, text):
        # one complete line the bot wrote on stdout
        t = None
        try:
            t = json.loads(text).get("t")
        except Exception:
            pass
        if t == "sim":
            stats["sims"] += 1
            return
        stats["replies"] += 1
        if o.fuel:
            ctx = caller._Caller__context
            left = ctypes.c_uint64(0)
            ffi.wasmtime_context_get_fuel(ctx, ctypes.byref(left))
            stats["fuel_per_reply"].append(((o.start_fuel or o.fuel) if stats["replies"] == 1 else o.fuel) - left.value)
            ffi.wasmtime_context_set_fuel(ctx, o.fuel)

    def fd_write(caller, fd, iovs, iovs_len, nwritten_ptr):
        # our own fd_write: stdout and stderr only, nothing else is writable
        if fd not in (1, 2):
            return EBADF
        mem = caller["memory"]
        # Memory.read clamps to the memory's size like a slice, so a pointer or length past the end is checked here
        raw = mem.read(caller, iovs, iovs + 8 * iovs_len)
        if len(raw) != 8 * iovs_len:
            return EFAULT
        chunks = []
        for k in range(iovs_len):
            ptr = int.from_bytes(raw[8 * k:8 * k + 4], "little")
            n = int.from_bytes(raw[8 * k + 4:8 * k + 8], "little")
            if n:
                chunk = bytes(mem.read(caller, ptr, ptr + n))
                if len(chunk) != n:
                    return EFAULT
                chunks.append(chunk)
        data = b"".join(chunks)
        if fd == 1:
            out.write(data)
            out.flush()
            line.extend(data)
            while True:
                i = line.find(b"\n")
                if i < 0:
                    break
                on_line(caller, bytes(line[:i]))
                del line[:i + 1]
        elif not o.quiet:
            err.write(data)
            err.flush()
        mem.write(caller, len(data).to_bytes(4, "little"), nwritten_ptr)
        return 0

    i32 = wasmtime.ValType.i32()
    linker.define_func(WASI, "fd_write", wasmtime.FuncType([i32, i32, i32, i32], [i32]), fd_write, access_caller=True)

    if o.fuel:
        store.set_fuel(o.start_fuel or o.fuel)
    if o.wall_s:
        store.set_epoch_deadline(int(o.wall_s * 100))
        threading.Thread(target=tick, args=(engine,), daemon=True).start()

    instance = linker.instantiate(store, module)
    stats["startup_ms"] = round((time.perf_counter() - T0) * 1000, 1)
    stats["compile_ms"] = round(compile_ms, 1)
    stats["cached"] = cached
    code = 0
    t_run = time.perf_counter()
    try:
        instance.exports(store)["_start"](store)
    except wasmtime.ExitTrap as e:
        code = e.code
    except (wasmtime.Trap, wasmtime.WasmtimeError) as e:
        code = 134
        stats["trap"] = trap_reason(e)
        err.write(("[compiled] %s: trap: %s\n" % (name, stats["trap"])).encode())
    stats["run_s"] = round(time.perf_counter() - t_run, 3)
    mem = instance.exports(store).get("memory")
    if mem is not None:
        stats["guest_memory_mb"] = round(mem.data_len(store) / 1048576, 2)
    stats["exit"] = code
    path = os.environ.get("WASM_HOST_STATS")
    if path:
        f = sorted(stats.pop("fuel_per_reply"))
        if f:
            stats["fuel"] = {"n": len(f), "total": sum(f), "p50": f[len(f) // 2], "p95": f[int(len(f) * 0.95)], "max": f[-1]}
        with open(path, "a") as fh:
            fh.write(json.dumps(stats) + "\n")
    out.flush()
    err.flush()
    os._exit(code)


def trap_reason(e):
    # wasmtime puts the backtrace first and the cause last
    lines = [x.strip() for x in str(e).split("\n") if x.strip()]
    return lines[-1] if lines else repr(e)


def tick(engine):
    while True:
        time.sleep(0.01)
        engine.increment_epoch()


if __name__ == "__main__":
    main()
