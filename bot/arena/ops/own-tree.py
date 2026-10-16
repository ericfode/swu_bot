"""
Makes folder trees on the games volume root's alone, as root, without ever following a link (gamesctl.js setup runs it
on every start, before anything reads the trees):

    python3 -I bot/arena/ops/own-tree.py root <dir>...           arena/ and dash/

Everything in each tree becomes root's, folders 0755 and files 0644 (0755 when any execute bit was set), so the bots'
user still reads it all and writes nothing. What the bots' user could have planted while it owned the tree goes:
links, pipes, sockets and devices are removed, and so is a file with other hard links (nothing of the arena's makes
one, and a copy could be made to fill the volume); ACLs and other extended attributes are dropped; setuid, setgid and
sticky bits go.

Every step works through file descriptors (dir_fd, O_NOFOLLOW), so a name swapped mid-walk is never followed. A folder
deeper than MAX_DEPTH (bundle.py keeps a bundle's paths to 255 bytes, so no entered version comes near it) is removed
whole with GNU rm, which never follows a link either.
Prints one JSON line: {"removed": [...], "attrs": N, "failed": [...]} (paths relative to their tree, at most 100 of
each, a long one shortened, so the line stays well under 1 MB). Exit 0 when nothing failed, 1 when something did (the
line says what), 2 on a usage error or a top folder that is not a folder.
"""
import errno
import json
import os
import stat
import subprocess
import sys

LIMIT = 100
PATH_CHARS = 160  # a path in the summary: longer ones keep their start and end
MAX_DEPTH = 160
ATTRS = ("system.posix_acl_access", "system.posix_acl_default")


class Walk:
    def __init__(self):
        self.removed = []
        self.failed = []
        self.attrs = 0

    def note(self, where, rel):
        if len(where) < LIMIT:
            where.append(rel if len(rel) <= PATH_CHARS else rel[:60] + "/.../" + rel[-(PATH_CHARS - 65):])

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
            os.unlink(name, dir_fd=dirfd)
            walk.note(walk.removed, path)
            return
        walk.strip_attrs(fd)
        os.fchown(fd, 0, 0)
        os.fchmod(fd, 0o755 if stat.S_ISDIR(now.st_mode) else file_mode(now.st_mode))
        if stat.S_ISDIR(now.st_mode):
            own_root(walk, fd, path, depth + 1)
    finally:
        os.close(fd)


def main(argv):
    if len(argv) < 2 or argv[0] != "root":
        print("usage: own-tree.py root <dir>...", file=sys.stderr)
        return 2
    tops = argv[1:]
    walk = Walk()
    for top in tops:
        try:
            fd = os.open(top, os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY)
        except OSError as e:
            print("own-tree.py: %s is not a folder (%s)" % (top, e.strerror), file=sys.stderr)
            return 2
        try:
            walk.strip_attrs(fd)
            os.fchown(fd, 0, 0)
            os.fchmod(fd, 0o755)
            own_root(walk, fd, "")
        finally:
            os.close(fd)
    print(json.dumps({"removed": walk.removed, "attrs": walk.attrs, "failed": walk.failed}))
    return 1 if walk.failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
