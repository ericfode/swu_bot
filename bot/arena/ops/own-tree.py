"""
Who owns a folder tree on the games volume, set as root without ever following a link (gamesctl.js setup runs it on
every start, before anything reads the trees):

    python3 -I bot/arena/ops/own-tree.py root <dir>...           arena/ and dash/: root's alone
    python3 -I bot/arena/ops/own-tree.py give <uid>:<gid> <dir>... the bots' trees (their HOME, the wasm cache)

root: everything in each tree becomes root's, folders 0755 and files 0644 (0755 when any execute bit was set), so the
bots' user still reads it all and writes nothing. What the bots' user could have planted while it owned the tree goes:
links, pipes, sockets and devices are removed; a file that has other hard links is copied to a file of its own (the
other names keep the old one); ACLs and other extended attributes are dropped; setuid, setgid and sticky bits go.
give: every folder and file becomes uid:gid's; a link is never followed, and a file with other hard links keeps its
owner (it may be a name for a file elsewhere on the volume).

Every step works through file descriptors (dir_fd, O_NOFOLLOW), so a name swapped mid-walk is never followed. A folder
deeper than MAX_DEPTH (no bundle or arena file is) is removed whole with GNU rm, which never follows a link either.
Prints one JSON line: {"removed": [...], "copied": [...], "attrs": N, "kept": [...], "failed": [...]} (paths relative to
their tree, at most 100 of each). Exit 0 when nothing failed, 1 when something did (the line says what), 2 on a usage
error or a top folder that is not a folder.
"""
import errno
import json
import os
import stat
import subprocess
import sys

LIMIT = 100
MAX_DEPTH = 40
ATTRS = ("system.posix_acl_access", "system.posix_acl_default")


class Walk:
    def __init__(self):
        self.removed = []
        self.copied = []
        self.kept = []
        self.failed = []
        self.attrs = 0

    def note(self, where, rel):
        if len(where) < LIMIT:
            where.append(rel)

    def strip_attrs(self, fd):
        try:
            names = os.listxattr(fd)
        except OSError as e:
            if e.errno in (errno.ENOTSUP, errno.EOPNOTSUPP):
                return
            raise
        for name in names:
            # ACLs and anything else the bots' user set; security.* (labels) is the kernel's business
            if name.startswith("security."):
                continue
            try:
                os.removexattr(fd, name)
                self.attrs += 1
            except OSError as e:
                if e.errno not in (errno.ENODATA, errno.ENOTSUP, errno.EOPNOTSUPP):
                    raise


def file_mode(mode):
    return 0o755 if mode & 0o111 else 0o644


def copy_alone(dirfd, name, fd, st):
    """Replaces dirfd/name (open as fd, st its fstat) with a new file of the same bytes and mode; returns the new fd."""
    tmp = ".own-tree-%s.tmp" % os.urandom(6).hex()
    out = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dirfd)
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        while True:
            chunk = os.read(fd, 1 << 20)
            if not chunk:
                break
            while chunk:
                chunk = chunk[os.write(out, chunk):]
        os.fchmod(out, file_mode(st.st_mode))
        os.rename(tmp, name, src_dir_fd=dirfd, dst_dir_fd=dirfd)
    except BaseException:
        os.close(out)
        try:
            os.unlink(tmp, dir_fd=dirfd)
        except OSError:
            pass
        raise
    os.close(fd)
    return out


def remove_deep(dirfd, name):
    """Removes the folder dirfd/name and all in it (rm walks without following links; /proc names this process's fd)."""
    r = subprocess.run(["rm", "-rf", "--", "/proc/%d/fd/%d/%s" % (os.getpid(), dirfd, name)], stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    if r.returncode != 0:
        raise OSError(errno.EIO, r.stderr.decode(errors="replace").strip() or "rm failed")


def own_root(walk, dirfd, rel, depth=1):
    """Makes everything inside the folder open as dirfd root's (the folder itself is done by the caller)."""
    for name in sorted(os.listdir(dirfd)):
        path = rel + "/" + name if rel else name
        try:
            own_root_entry(walk, dirfd, name, path, depth)
        except OSError as e:
            walk.note(walk.failed, "%s: %s" % (path, e.strerror or e))


def own_root_entry(walk, dirfd, name, path, depth):
    st = os.stat(name, dir_fd=dirfd, follow_symlinks=False)
    if not (stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode)):
        os.unlink(name, dir_fd=dirfd)
        walk.note(walk.removed, path)
        return
    if stat.S_ISDIR(st.st_mode) and depth > MAX_DEPTH:
        remove_deep(dirfd, name)
        walk.note(walk.removed, path)
        return
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | (os.O_DIRECTORY if stat.S_ISDIR(st.st_mode) else 0)
    try:
        fd = os.open(name, flags, dir_fd=dirfd)
    except OSError as e:
        if e.errno in (errno.ELOOP, errno.ENOENT, errno.ENOTDIR, errno.ENXIO):
            raise OSError(e.errno, "changed while it was read")
        raise
    try:
        now = os.fstat(fd)
        if (now.st_dev, now.st_ino) != (st.st_dev, st.st_ino):
            raise OSError(errno.ESTALE, "changed while it was read")
        if stat.S_ISREG(now.st_mode) and now.st_nlink > 1:
            fd = copy_alone(dirfd, name, fd, now)
            now = os.fstat(fd)
            walk.note(walk.copied, path)
        walk.strip_attrs(fd)
        os.fchown(fd, 0, 0)
        os.fchmod(fd, 0o755 if stat.S_ISDIR(now.st_mode) else file_mode(now.st_mode))
        if stat.S_ISDIR(now.st_mode):
            own_root(walk, fd, path, depth + 1)
    finally:
        os.close(fd)


def give(walk, dirfd, rel, uid, gid, depth=1):
    """Gives everything inside the folder open as dirfd to uid:gid, never through a link."""
    for name in sorted(os.listdir(dirfd)):
        path = rel + "/" + name if rel else name
        try:
            give_entry(walk, dirfd, name, path, uid, gid, depth)
        except OSError as e:
            walk.note(walk.failed, "%s: %s" % (path, e.strerror or e))


def give_entry(walk, dirfd, name, path, uid, gid, depth):
    st = os.stat(name, dir_fd=dirfd, follow_symlinks=False)
    if stat.S_ISLNK(st.st_mode):
        os.chown(name, uid, gid, dir_fd=dirfd, follow_symlinks=False)
        return
    if not (stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode)):
        return
    if (stat.S_ISREG(st.st_mode) and st.st_nlink > 1) or (stat.S_ISDIR(st.st_mode) and depth > MAX_DEPTH):
        walk.note(walk.kept, path)
        return
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | (os.O_DIRECTORY if stat.S_ISDIR(st.st_mode) else 0)
    try:
        fd = os.open(name, flags, dir_fd=dirfd)
    except OSError as e:
        if e.errno in (errno.ELOOP, errno.ENOENT, errno.ENOTDIR, errno.ENXIO):
            return  # gone or swapped for a link since: the bots' own business
        raise
    try:
        now = os.fstat(fd)
        if (now.st_dev, now.st_ino) != (st.st_dev, st.st_ino) or (stat.S_ISREG(now.st_mode) and now.st_nlink > 1):
            return
        os.fchown(fd, uid, gid)
        if stat.S_ISDIR(now.st_mode):
            give(walk, fd, path, uid, gid, depth + 1)
    finally:
        os.close(fd)


def main(argv):
    if len(argv) < 2 or argv[0] not in ("root", "give") or (argv[0] == "give" and len(argv) < 3):
        print("usage: own-tree.py root <dir>... | own-tree.py give <uid>:<gid> <dir>...", file=sys.stderr)
        return 2
    if argv[0] == "give":
        try:
            uid, gid = (int(x) for x in argv[1].split(":"))
        except ValueError:
            print("own-tree.py: give takes <uid>:<gid>", file=sys.stderr)
            return 2
        tops = argv[2:]
    else:
        tops = argv[1:]
    walk = Walk()
    for top in tops:
        try:
            fd = os.open(top, os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY)
        except OSError as e:
            print("own-tree.py: %s is not a folder (%s)" % (top, e.strerror), file=sys.stderr)
            return 2
        try:
            if argv[0] == "root":
                walk.strip_attrs(fd)
                os.fchown(fd, 0, 0)
                os.fchmod(fd, 0o755)
                own_root(walk, fd, "")
            else:
                os.fchown(fd, uid, gid)
                give(walk, fd, "", uid, gid)
        finally:
            os.close(fd)
    print(json.dumps({"removed": walk.removed, "copied": walk.copied, "attrs": walk.attrs, "kept": walk.kept, "failed": walk.failed}))
    return 1 if walk.failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
