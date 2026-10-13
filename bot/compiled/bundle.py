"""
Bot bundles (schema swu-arena-bot/1, research/bot-packaging/design.md section 3): read and check a manifest, and
pack a bundle folder as a canonical tar whose sha256 is the bundle id (the bot's version), and unpack one.

    python3 bot/compiled/bundle.py build/compiled/rust-search      # prints the id and sizes
    python3 bot/compiled/bundle.py tar <folder> > x.tar            # the canonical tar, on stdout
    python3 bot/compiled/bundle.py unpack <tar> <dest> <hex>       # checks it, then makes <dest> from it

The games machine sends a version's bundle to a helper as its canonical tar (bot/arena/play-seed.js). unpack trusts
nothing in the tar: it refuses one whose sha256 is not <hex>, anything but plain files and folders, names that leave
<dest>, and more than MAX_UNPACK_BYTES or MAX_UNPACK_ENTRIES; it never follows a link, and the folder it made must pack
to the same canonical tar again. Exit 0 ok, 2 refused (the reason on stderr).
"""
import gzip
import hashlib
import io
import json
import os
import shutil
import stat
import sys
import tarfile

SCHEMA = "swu-arena-bot/1"
KINDS = {"wasm": "wasm32-wasip1"}  # "native" (linux/amd64) is not built here yet
FORBIDDEN_ENV = ("LD_", "PYTHONHASHSEED", "SWU_ARENA_", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY")
MAX_UNPACK_BYTES = 64 << 20  # the tar, and the files in it together
MAX_UNPACK_ENTRIES = 2000
USTAR_MAGIC = b"ustar\x0000"  # POSIX ustar (GNU tars say "ustar  \0")


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
    with open(path) as f:
        m = json.load(f)
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
    if entry is None:
        raise BundleError("%s: no entry file (run.cmd ./<file>, or the script as run.args[0])" % path)
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


def tar_names(data):
    """The members of a canonical tar, checked before anything is written: [(TarInfo, rel)] in tar order."""
    try:
        tar = tarfile.open(fileobj=io.BytesIO(data), mode="r:")
        members = tar.getmembers()
    except (tarfile.TarError, EOFError, ValueError) as e:
        raise BundleError("not a tar (%s)" % e)
    if tar.pax_headers:
        raise BundleError("pax headers are not allowed")
    if len(members) > MAX_UNPACK_ENTRIES:
        raise BundleError("%d entries, more than %d" % (len(members), MAX_UNPACK_ENTRIES))
    out = []
    seen = set()
    folders = {""}
    total = 0
    for info in members:
        name = info.name
        # every header in POSIX ustar form: no GNU long names, no pax records
        if data[info.offset + 257:info.offset + 265] != USTAR_MAGIC or info.pax_headers:
            raise BundleError("%r: only ustar entries are allowed" % name)
        if info.type not in (tarfile.REGTYPE, tarfile.DIRTYPE):
            raise BundleError("%r: only regular files and folders are allowed" % name)
        if len(name.encode()) > 255 or "\0" in name:
            raise BundleError("%r: bad name" % name)
        parts = name.split("/")
        if any(p in ("", ".", "..") for p in parts):
            raise BundleError("%r: empty, '.' or '..' path segment" % name)
        rel = safe_rel(name)
        if rel in seen:
            raise BundleError("%r: appears twice" % name)
        seen.add(rel)
        # a canonical tar lists every folder before what is in it, so nothing is made implicitly
        if "/".join(parts[:-1]) not in folders:
            raise BundleError("%r: its folder is not in the tar before it" % name)
        if info.isdir():
            if info.mode != 0o755:
                raise BundleError("%r: folder mode %o, not 755" % (name, info.mode))
            folders.add(rel)
        else:
            if info.mode not in (0o644, 0o755):
                raise BundleError("%r: file mode %o, not 644 or 755" % (name, info.mode))
            total += info.size
            if total > MAX_UNPACK_BYTES:
                raise BundleError("more than %d bytes of files" % MAX_UNPACK_BYTES)
        out.append((info, rel))
    return tar, out


def unpack(tar_path, dest, hexid):
    """Makes dest (which must not exist) from the canonical tar at tar_path whose sha256 must be hexid."""
    # the files plus their headers and padding (at most 1 KB an entry, and the end blocks)
    if os.path.getsize(tar_path) > MAX_UNPACK_BYTES + (4 << 20):
        raise BundleError("%s: too large" % tar_path)
    with open(tar_path, "rb") as f:
        data = f.read()
    if sha256_bytes(data) != hexid:
        raise BundleError("%s: sha256 is not %s" % (tar_path, hexid))
    tar, members = tar_names(data)
    if os.path.lexists(dest):
        raise BundleError("%s already exists" % dest)
    os.mkdir(dest, 0o755)
    try:
        os.chmod(dest, 0o755)
        root = os.open(dest, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for info, rel in members:
                write_member(root, tar, info, rel)
        finally:
            os.close(root)
        # the folder must say exactly what the tar said
        if sha256_bytes(canonical_tar(dest)) != hexid:
            raise BundleError("%s does not pack back to %s" % (dest, hexid))
    except BaseException:
        shutil.rmtree(dest, ignore_errors=True)
        raise


def write_member(root, tar, info, rel):
    """One file or folder under the folder open as root; no link is followed on the way (O_NOFOLLOW, dir_fd)."""
    parts = rel.split("/")
    fd = root
    try:
        for p in parts[:-1]:
            nxt = os.open(p, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            if fd != root:
                os.close(fd)
            fd = nxt
        if info.isdir():
            os.mkdir(parts[-1], 0o755, dir_fd=fd)
            os.chmod(parts[-1], 0o755, dir_fd=fd, follow_symlinks=False)
            return
        out = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, info.mode, dir_fd=fd)
        try:
            src = tar.extractfile(info)
            left = info.size
            while left > 0:
                chunk = src.read(min(left, 1 << 20))
                if not chunk:
                    raise BundleError("%r: the tar ends inside it" % rel)
                left -= len(chunk)
                while chunk:
                    chunk = chunk[os.write(out, chunk):]
            os.fchmod(out, info.mode)
            if not stat.S_ISREG(os.fstat(out).st_mode):
                raise BundleError("%r: not a regular file" % rel)
        finally:
            os.close(out)
    finally:
        if fd != root:
            os.close(fd)


def main(argv):
    if argv[:1] == ["tar"]:
        if len(argv) != 2:
            print("usage: bundle.py tar <folder>", file=sys.stderr)
            return 2
        if os.path.islink(argv[1]) or not os.path.isdir(argv[1]):
            raise BundleError("%s is not a folder" % argv[1])
        sys.stdout.buffer.write(canonical_tar(argv[1]))
        sys.stdout.buffer.flush()
        return 0
    if argv[:1] == ["unpack"]:
        if len(argv) != 4:
            print("usage: bundle.py unpack <tar> <dest> <hex>", file=sys.stderr)
            return 2
        unpack(argv[1], argv[2], argv[3])
        return 0
    for folder in argv:
        m = load(folder)
        bid, size, gz = bundle_id(folder)
        print("%-16s %s  tar %d B, gzip %d B" % (m.get("name", folder), bid, size, gz))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (BundleError, OSError) as e:
        print("error: %s" % e, file=sys.stderr)
        sys.exit(2)
