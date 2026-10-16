#!/usr/bin/env python3
"""
Kills every process of one user and returns once none is left. A games helper runs it as root after each play of a
slot (server/src/games/Helper.ts): the slot's user then runs nothing, so nothing a bot left running reaches the slot's
next lease.

    python3 -I bot/arena/ops/kill-user.py <uid>

It sweeps /proc and sends SIGKILL to each process whose real, effective, saved or filesystem uid is <uid>, again and
again until a sweep finds none alive (a zombie is dead: it only waits to be reaped). Each process is opened as a pidfd
before its uids are read, and the signal goes through that pidfd, so a pid that a process of someone else took over
meanwhile is never signalled. The user's processes cannot stop or signal this one: it is root's.

Exit 0: none left; 1: some still ran when the time was up (TIMEOUT_S); 2: bad usage, or not root.
"""
import os
import signal
import sys
import time

TIMEOUT_S = 10


def matches(pid, uid):
    """Whether the process pid is alive and runs with uid as one of its uids."""
    try:
        with open("/proc/%d/status" % pid) as f:
            text = f.read()
    except OSError:
        return False
    state = uids = None
    for line in text.splitlines():
        if line.startswith("State:"):
            state = line.split()[1]
        elif line.startswith("Uid:"):
            uids = [int(x) for x in line.split()[1:5]]
    return uids is not None and uid in uids and state not in ("Z", "X")


def sweep(uid):
    """Sends SIGKILL to every live process of uid; returns how many it found."""
    found = 0
    for name in os.listdir("/proc"):
        if not name.isdigit() or int(name) == os.getpid():
            continue
        try:
            fd = os.pidfd_open(int(name))
        except ProcessLookupError:
            continue
        try:
            # read after the pidfd is open: if the pid now names another process, the one the pidfd holds is gone and
            # the signal below fails
            if matches(int(name), uid):
                try:
                    signal.pidfd_send_signal(fd, signal.SIGKILL)
                    found += 1
                except ProcessLookupError:
                    pass
        finally:
            os.close(fd)
    return found


def main():
    if len(sys.argv) != 2 or not sys.argv[1].isdigit() or int(sys.argv[1]) == 0:
        sys.stderr.write("usage: python3 -I kill-user.py <uid other than 0>\n")
        return 2
    if os.geteuid() != 0:
        sys.stderr.write("kill-user.py: must run as root\n")
        return 2
    uid = int(sys.argv[1])
    end = time.monotonic() + TIMEOUT_S
    while sweep(uid):
        if time.monotonic() > end:
            sys.stderr.write("kill-user.py: processes of uid %d still run after %d s\n" % (uid, TIMEOUT_S))
            return 1
        time.sleep(0.01)
    return 0


if __name__ == "__main__":
    sys.exit(main())
