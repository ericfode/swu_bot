#!/usr/bin/env python3
"""
Build compiled bot bundles (bot/compiled/README.md): one folder per bot in build/compiled/<name>/ with arena.json
(schema swu-arena-bot/1) and its files, plus build/compiled/index.json with each bundle's id and sizes.

    python3 bot/compiled/build.py                    # every bot in BOTS
    python3 bot/compiled/build.py rust-search c-clock
    python3 bot/compiled/build.py --list

Needs: Python packages wasmtime and ziglang (versions in toolchain.json), rustc with the wasm32-wasip1 target, and
network access the first time, to fetch Javy and python.wasm (checked against their sha256) into build/compiled/.tools.
"""
import argparse
import gzip
import json
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(ROOT, "build", "compiled")
TOOLS = os.path.join(OUT, ".tools")
sys.path.insert(0, HERE)
import bundle  # noqa: E402

TOOLCHAIN = json.load(open(os.path.join(HERE, "toolchain.json")))

# name -> how to build it. The names are the bots' names in bot/external-bots.json; each bundle registers as <name>-wasm.
BOTS = {
    "rust-random": {"lang": "rust", "args": ["random"]},
    "rust-greedy": {"lang": "rust", "args": ["greedy"]},
    "rust-greedy2": {"lang": "rust", "args": ["greedy2"]},
    "rust-search": {"lang": "rust", "args": ["search"]},
    "c-clock": {"lang": "c", "protocol": 1},
    "py-random": {"lang": "python", "files": ["bot/examples/random_bot.py"], "cards": False, "protocol": 2},
    "py-clock": {"lang": "python", "dir": "bot/python", "entry": "swu_clock.py", "cards": True, "protocol": 1},
    "node-random": {"lang": "js", "entry": "bot/examples/random-bot.js", "args": ["node-random"]},
    "node-search": {"lang": "js", "entry": "bot/examples/search-bot.js", "args": ["node-search"]},
}
SOURCE = {"rust": "bot/rust", "c": "bot/c"}


def log(msg):
    print("[build] %s" % msg, flush=True)


def run(cmd, **kw):
    log(" ".join(cmd))
    subprocess.run(cmd, check=True, **kw)


def git(*args):
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True).stdout.strip()


def fetch(url, sha256, dest):
    """Download url to dest unless a file with that sha256 is already there."""
    if os.path.exists(dest) and bundle.sha256_file(dest) == sha256:
        return dest
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    log("fetch %s" % url)
    tmp = dest + ".part"
    with urllib.request.urlopen(url, timeout=120) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f)
    got = bundle.sha256_file(tmp)
    if got != sha256:
        os.remove(tmp)
        sys.exit("%s: sha256 %s, expected %s" % (url, got, sha256))
    os.replace(tmp, dest)
    return dest


def javy():
    j = TOOLCHAIN["javy"]
    exe = os.path.join(TOOLS, "javy-%s" % j["version"], "javy")
    gz = fetch(j["url"], j["sha256"], os.path.join(TOOLS, "downloads", os.path.basename(j["url"])))
    if not os.path.exists(exe):
        os.makedirs(os.path.dirname(exe), exist_ok=True)
        with gzip.open(gz) as src, open(exe + ".part", "wb") as dst:
            shutil.copyfileobj(src, dst)
        os.chmod(exe + ".part", 0o755)
        os.replace(exe + ".part", exe)
    return exe


def runtime(name):
    """Fetch and unpack an interpreter runtime (python.wasm and its standard library)."""
    rt = TOOLCHAIN["runtimes"][name]
    home = os.path.join(TOOLS, rt["dir"])
    wasm = os.path.join(home, rt["wasm"])
    if os.path.exists(wasm) and bundle.sha256_file(wasm) == rt["wasm_sha256"]:
        return rt
    z = fetch(rt["url"], rt["sha256"], os.path.join(TOOLS, "downloads", os.path.basename(rt["url"])))
    with zipfile.ZipFile(z) as zf:
        for n in zf.namelist():
            bundle.safe_rel(n)  # nothing may land outside the folder
        zf.extractall(home)
    if bundle.sha256_file(wasm) != rt["wasm_sha256"]:
        sys.exit("%s: unexpected sha256" % wasm)
    return rt


def check_python_packages():
    want = TOOLCHAIN["python"]
    for pkg, version in want.items():
        try:
            from importlib.metadata import version as installed
            got = installed(pkg)
        except Exception:
            got = None
        if got != version:
            sys.exit("needs the Python package %s==%s (found %s): python3 -m pip install %s==%s" % (pkg, version, got, pkg, version))


def provenance(path, recipe, toolchain):
    commit = git("rev-parse", "HEAD")
    if git("status", "--porcelain", "--", path, "bot/compiled"):
        commit += "+dirty"
    return {
        "source": "https://github.com/ericfode/swu_bot", "commit": commit, "path": path, "recipe": recipe,
        "toolchain": toolchain, "builder": "self", "source_date_epoch": int(git("log", "-1", "--format=%ct") or 0) or None,
    }


def card_snapshot():
    p = os.path.join(ROOT, "forceteki", "test", "json", "card-data-hash.txt")
    return "forceteki-card-data sha256:" + open(p).read().strip() if os.path.exists(p) else None


def build_rust(cache):
    if "rust" in cache:
        return cache["rust"]
    target = os.path.join(OUT, ".cargo")
    cargo_home = os.environ.get("CARGO_HOME") or os.path.expanduser("~/.cargo")
    # strip symbols, and drop this machine's paths from panic messages so the wasm is the same on any machine
    flags = "-C strip=symbols --remap-path-prefix=%s=. --remap-path-prefix=%s=/cargo" % (ROOT, cargo_home)
    env = dict(os.environ, CARGO_TARGET_DIR=target, RUSTFLAGS=flags)
    run(["cargo", "build", "--release", "--target", "wasm32-wasip1", "--manifest-path", os.path.join(ROOT, "bot/rust/Cargo.toml")], env=env)
    rustc = subprocess.run(["rustc", "--version"], capture_output=True, text=True).stdout.strip()
    cache["rust"] = (os.path.join(target, "wasm32-wasip1", "release", "swu-bot-rs.wasm"),
                     "RUSTFLAGS='%s' cargo build --release --target wasm32-wasip1" % flags.replace(ROOT, "<repo>").replace(cargo_home, "<cargo>"), rustc)
    return cache["rust"]


def build_c(work):
    src = os.path.join(ROOT, "bot", "c")
    out = os.path.join(work, "c-clock.wasm")
    cmd = [sys.executable, "-m", "ziglang", "cc", "--target=wasm32-wasi", "-O2", "-std=gnu11", "-s", "-o", out, "bot.c", "cards.c", "json.c", "-lm"]
    run(cmd, cwd=src)
    return out, "zig cc --target=wasm32-wasi -O2 -std=gnu11 -s -o bot.wasm bot.c cards.c json.c -lm", "zig %s (pip ziglang)" % TOOLCHAIN["python"]["ziglang"]


def build_js(spec, work, name):
    sys_js = os.path.join(work, name + ".bundle.js")
    with open(sys_js, "w") as f:
        subprocess.run(["node", os.path.join(HERE, "js", "bundle.js"), spec["entry"], *spec.get("args", [])], cwd=ROOT, check=True, stdout=f)
    out = os.path.join(work, name + ".wasm")
    flags = TOOLCHAIN["javy"]["flags"]
    run([javy(), "build", *flags, "-o", out, sys_js])
    return out, "node bot/compiled/js/bundle.js %s %s | javy build %s" % (spec["entry"], " ".join(spec.get("args", [])), " ".join(flags)), "javy %s" % TOOLCHAIN["javy"]["version"]


def manifest(name, spec, entry_path, runtime_name, run_spec, prov, cards):
    m = {
        "schema": bundle.SCHEMA, "name": name, "lang": spec["lang"], "protocol": spec.get("protocol", 2),
        "kind": "wasm", "platform": "wasm32-wasip1", "runtime": runtime_name, "run": run_spec,
        "entry_sha256": bundle.sha256_file(entry_path),
        "resources": {"memory_mb": 1024 if spec["lang"] in ("python", "js") else 512, "start_ms": 30000, "decide_ms": 10000},
        "cards": {"use": "mount", "layout": "dir", "env": {"SWU_CARD_JSON": "/cards"}} if cards else {"use": "none"},
        "network": "none", "deterministic": True, "build": prov,
    }
    if cards and card_snapshot():
        m["cards"]["built_with"] = card_snapshot()
    return m


def build_one(name, cache):
    spec = BOTS[name]
    folder = os.path.join(OUT, name)
    work = os.path.join(OUT, ".work")
    os.makedirs(work, exist_ok=True)
    if os.path.isdir(folder):
        shutil.rmtree(folder)
    os.makedirs(folder)
    lang = spec["lang"]
    if lang in ("rust", "c", "js"):
        if lang == "rust":
            wasm, recipe, tool = build_rust(cache)
            path = SOURCE["rust"]
        elif lang == "c":
            wasm, recipe, tool = build_c(work)
            path = SOURCE["c"]
        else:
            wasm, recipe, tool = build_js(spec, work, name)
            path = spec["entry"]
        entry = os.path.join(folder, "bot.wasm")
        shutil.copyfile(wasm, entry)
        args = spec.get("args", []) if lang == "rust" else []
        m = manifest(name, spec, entry, "wasi-p1", {"cmd": "./bot.wasm", "args": args, "env": {}},
                     provenance(path, recipe, tool), cards=lang in ("rust", "c"))
    else:
        runtime("python-3.14-wasi")
        files = spec.get("files") or sorted(
            os.path.join(spec["dir"], f) for f in os.listdir(os.path.join(ROOT, spec["dir"]))
            if f.endswith(".py") and not f.startswith("test_"))
        for f in files:
            dest = os.path.join(folder, os.path.basename(f))
            shutil.copyfile(os.path.join(ROOT, f), dest)
            os.chmod(dest, 0o644)
        entry_name = spec.get("entry") or os.path.basename(files[0])
        src = spec.get("dir") or os.path.dirname(spec["files"][0])
        m = manifest(name, spec, os.path.join(folder, entry_name), "python-3.14-wasi",
                     {"cmd": "python3", "args": [entry_name], "env": {}},
                     provenance(src, "copy %s" % ", ".join(files), "python-3.14-wasi (CPython 3.14.7)"), cards=spec["cards"])
    with open(os.path.join(folder, "arena.json"), "w") as f:
        json.dump(m, f, indent=2)
        f.write("\n")
    for dirpath, _, filenames in os.walk(folder):
        for fn in filenames:
            p = os.path.join(dirpath, fn)
            os.chmod(p, (os.stat(p).st_mode & ~0o7777) | 0o644)
    bundle.load(folder)  # the checks run.py makes
    bid, tar_bytes, gz_bytes = bundle.bundle_id(folder)
    # compile once now, so the first game does not spend its hello time on it
    subprocess.run([sys.executable, os.path.join(HERE, "run.py"), "--warm", folder], check=True)
    info = {"id": bid, "lang": lang, "runtime": m["runtime"], "entry_bytes": os.path.getsize(os.path.join(folder, bundle.entry_file(m))),
            "tar_bytes": tar_bytes, "gzip_bytes": gz_bytes, "commit": m["build"]["commit"]}
    log("%-12s %s  gzip %d B" % (name, bid[:19], gz_bytes))
    return info


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("bots", nargs="*", help="names from BOTS (default: all)")
    ap.add_argument("--list", action="store_true")
    o = ap.parse_args()
    if o.list:
        for name, spec in BOTS.items():
            print("%-12s %s" % (name, spec["lang"]))
        return
    unknown = [b for b in o.bots if b not in BOTS]
    if unknown:
        sys.exit("unknown bot(s): %s (see --list)" % ", ".join(unknown))
    check_python_packages()
    index_path = os.path.join(OUT, "index.json")
    index = json.load(open(index_path)) if os.path.exists(index_path) else {}
    cache = {}
    for name in o.bots or list(BOTS):
        index[name] = build_one(name, cache)
    with open(index_path, "w") as f:
        json.dump(dict(sorted(index.items())), f, indent=2)
        f.write("\n")
    log("index: %s" % os.path.relpath(index_path, ROOT))


if __name__ == "__main__":
    main()
