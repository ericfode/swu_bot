#!/usr/bin/env python3
"""
Kills every process of one user and returns once none is left. A games helper runs it as root after each play of a
slot (server/src/games/Helper.ts): the slot's user then runs nothing, so nothing a bot left running reaches the slot's
next lease.

    python3 -I bot/arena/ops/kill-user.py <uid>

The kill is kill(-1, SIGKILL) from a child that drops to real and saved uid nobody (65534) and effective uid <uid>:
- the kernel walks every process at once, so one that forks, or forks and exits, cannot slip past, and a process
  whose main thread exited while its other threads run is still reached;
- it reaches what runs with <uid> as its real or saved uid (and whatever runs as nobody, so nothing may: this refuses
  to start when something does), and never root's processes;
- the user's processes cannot signal or trace the killer: its real and saved uid are not theirs.
Then it checks every thread of every process, and kills again until none of <uid> is alive (a zombie is dead).
Two killers at once would kill each other (both run as real uid nobody), so each holds a lock in a folder only root
reaches (LOCK_DIR) for the whole run: the helper's slots finish plays at the same time.

Exit 0: none left; 1: some still ran when the time was up (TIMEOUT_S), or the kill could not run; 2: bad usage, not
root, the lock folder is not root's alone, or something runs as nobody.
"""
import fcntl
import os
import signal
import stat
import sys
import time

TIMEOUT_S = 10
NOBODY = 65534
LOCK_DIR = "/run/swu-kill-user"


def live_tasks(uid):
    """The threads (of every process) that run with uid as one of their uids and are not dead."""
    tids = []
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            tasks = os.listdir("/proc/%s/task" % pid)
        except OSError:
            continue
        for tid in tasks:
            try:
                with open("/proc/%s/task/%s/status" % (pid, tid)) as f:
                    text = f.read()
            except OSError:
                continue
            state = uids = None
            for line in text.splitlines():
                if line.startswith("State:"):
                    state = line.split()[1]
                elif line.startswith("Uid:"):
                    uids = [int(x) for x in line.split()[1:5]]
            if uids is not None and uid in uids and state not in ("Z", "X"):
                tids.append(int(tid))
    return tids


def lock():
    """The lock every kill-user.py holds while it runs (an open file in LOCK_DIR, flocked); None when LOCK_DIR is not
    root's alone."""
    try:
        os.mkdir(LOCK_DIR, 0o700)
    except FileExistsError:
        pass
    st = os.lstat(LOCK_DIR)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o077:
        return None
    fd = os.open(os.path.join(LOCK_DIR, "lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    return fd


def kill_all(uid, lock_fd):
    """kill(-1, SIGKILL) as real and saved uid nobody, effective uid uid; whether it ran."""
    try:
        child = os.fork()
    except OSError:
        # no process left to fork (the user's processes may hold them all): the caller tries again until its time is up
        return False
    if child == 0:
        try:
            os.close(lock_fd)
            os.setgroups([])
            os.setresgid(NOBODY, NOBODY, NOBODY)
            os.setresuid(NOBODY, uid, NOBODY)
            try:
                os.kill(-1, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os._exit(0)
        except BaseException:
            os._exit(1)
    _, status = os.waitpid(child, 0)
    return os.waitstatus_to_exitcode(status) == 0


def main():
    if len(sys.argv) != 2 or not sys.argv[1].isdigit() or int(sys.argv[1]) in (0, NOBODY):
        sys.stderr.write("usage: python3 -I kill-user.py <uid other than 0 and %d>\n" % NOBODY)
        return 2
    if os.geteuid() != 0:
        sys.stderr.write("kill-user.py: must run as root\n")
        return 2
    lock_fd = lock()
    if lock_fd is None:
        sys.stderr.write("kill-user.py: %s is not a folder only root reaches\n" % LOCK_DIR)
        return 2
    if live_tasks(NOBODY):
        sys.stderr.write("kill-user.py: something runs as nobody, which the kill would reach too\n")
        return 2
    uid = int(sys.argv[1])
    end = time.monotonic() + TIMEOUT_S
    while True:
        ran = kill_all(uid, lock_fd)
        if ran and not live_tasks(uid):
            return 0
        if time.monotonic() > end:
            if ran:
                sys.stderr.write("kill-user.py: processes of uid %d still run after %d s\n" % (uid, TIMEOUT_S))
            else:
                sys.stderr.write("kill-user.py: the kill could not run\n")
            return 1
        time.sleep(0.01)


if __name__ == "__main__":
    sys.exit(main())
