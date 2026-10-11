"""
Bot bundles (schema swu-arena-bot/1, research/bot-packaging/design.md section 3): read and check a manifest, and
pack a bundle folder as a canonical tar whose sha256 is the bundle id (the bot's version).

    python3 bot/compiled/bundle.py build/compiled/rust-search      # prints the id and sizes
"""
import gzip
import hashlib
import io
import json
import os
import sys
import tarfile

SCHEMA = "swu-arena-bot/1"
KINDS = {"wasm": "wasm32-wasip1"}  # "native" (linux/amd64) is not built here yet
FORBIDDEN_ENV = ("LD_", "PYTHONHASHSEED", "SWU_ARENA_", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY")


class BundleError(Exception):
    pass


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def files_of(folder):
    """Every path in the bundle, relative, sorted by bytes. Regular files and folders only."""
    out = []
    for dirpath, dirnames, filenames in os.walk(folder):
        for name in dirnames + filenames:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, folder).replace(os.sep, "/")
            if os.path.islink(full) or not (os.path.isfile(full) or os.path.isdir(full)):
                raise BundleError("%s: only regular files and folders are allowed" % rel)
            if rel.startswith(".git") or "/.git" in rel:
                raise BundleError("%s: no .git in a bundle" % rel)
            if len(rel.encode()) > 255:
                raise BundleError("%s: path longer than 255 bytes" % rel)
            out.append(rel)
    return sorted(out, key=lambda r: r.encode())


def canonical_tar(folder):
    """The bundle as a POSIX tar in canonical form: sorted entries, mtime 0, uid/gid 0, no names, mode 0644/0755."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for rel in files_of(folder):
            full = os.path.join(folder, rel)
            info = tarfile.TarInfo(rel)
            info.mtime = 0
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            if os.path.isdir(full):
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                tar.addfile(info)
            else:
                info.mode = 0o755 if os.access(full, os.X_OK) else 0o644
                info.size = os.path.getsize(full)
                with open(full, "rb") as f:
                    tar.addfile(info, f)
    return buf.getvalue()


def bundle_id(folder):
    """sha256 of the uncompressed canonical tar, written sha256:<hex>, plus the tar and gzip sizes."""
    tar = canonical_tar(folder)
    gz = gzip.compress(tar, compresslevel=9, mtime=0)
    return "sha256:" + sha256_bytes(tar), len(tar), len(gz)


def load(folder):
    """Read and check arena.json; returns the manifest. Raises BundleError when anything is off."""
    path = os.path.join(folder, "arena.json")
    if not os.path.isfile(path):
        raise BundleError("no arena.json in %s" % folder)
    m = json.load(open(path))
    if m.get("schema") != SCHEMA:
        raise BundleError("%s: schema must be %r, got %r" % (path, SCHEMA, m.get("schema")))
    for field in ("protocol", "kind", "platform", "runtime", "run"):
        if field not in m:
            raise BundleError("%s: missing %r" % (path, field))
    if KINDS.get(m["kind"]) != m["platform"]:
        raise BundleError("%s: kind %r with platform %r is not supported here" % (path, m["kind"], m["platform"]))
    run = m["run"]
    if not isinstance(run.get("cmd"), str) or not all(isinstance(a, str) for a in run.get("args", [])):
        raise BundleError("%s: run.cmd and run.args must be strings" % path)
    for k in run.get("env", {}):
        if k.startswith(FORBIDDEN_ENV):
            raise BundleError("%s: run.env may not set %s" % (path, k))
    entry = entry_file(m)
    if entry is not None:
        full = os.path.join(folder, entry)
        if not os.path.isfile(full):
            raise BundleError("%s: entry %s is not in the bundle" % (path, entry))
        if m.get("entry_sha256") and sha256_file(full) != m["entry_sha256"]:
            raise BundleError("%s: %s does not match entry_sha256" % (path, entry))
    if m.get("network", "none") != "none":
        raise BundleError("%s: a wasm bundle has no network" % path)
    return m


def entry_file(m):
    """The bundle file that is run: ./bot.wasm for wasi-p1, the script (first arg) for an interpreter runtime."""
    run = m["run"]
    if run["cmd"].startswith("./"):
        return safe_rel(run["cmd"][2:])
    args = run.get("args", [])
    return safe_rel(args[0]) if args else None


def safe_rel(p):
    p = p[2:] if p.startswith("./") else p
    if p.startswith("/") or ".." in p.split("/"):
        raise BundleError("path %r must stay inside the bundle" % p)
    return p


if __name__ == "__main__":
    for folder in sys.argv[1:]:
        try:
            m = load(folder)
            bid, size, gz = bundle_id(folder)
            print("%-16s %s  tar %d B, gzip %d B" % (m.get("name", folder), bid, size, gz))
        except BundleError as e:
            print("error: %s" % e, file=sys.stderr)
            sys.exit(2)
