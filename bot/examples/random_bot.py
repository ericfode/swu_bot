#!/usr/bin/env python3
"""Reference client for the bot protocol v2 (spec/protocol.md). Standard library only.

Reads one JSON message per line on stdin and answers each with one line on stdout; logs go to stderr.

    node bot/tournament.js --bots py-random,random-a --games 2 --out replays/py-test
"""
import json
import random
import sys


def split(dist, rng):
    """A legal split for a distribute action: fill targets in random order up to their caps (None: let the referee pick)."""
    targets = list(dist["targets"])
    rng.shuffle(targets)
    if dist["maxTargets"] is not None:
        targets = targets[: dist["maxTargets"]]
    left, out = dist["amount"], []
    for t in targets:
        give = left if t["cap"] is None else min(left, t["cap"])
        if give > 0:
            out.append({"id": t["id"], "amount": give})
            left -= give
    return None if left and not dist["canDistributeLess"] else out


def reply(msg, rng):
    if msg["t"] == "hello":
        rng.seed(msg["seed"])
        print(f"[py-random] new game as {msg['you']}", file=sys.stderr)
        return {"t": "ready", "v": 2, "name": "py-random"}
    if msg["t"] == "decide":
        action = rng.choice(msg["actions"])
        out = {"t": "act", "i": action["i"]}
        if action["kind"] == "distribute":
            s = split(action["distribute"], rng)
            if s is not None:
                out["split"] = s
        return out
    if msg["t"] == "over":
        print(f"[py-random] game over: {msg['winner']} ({msg['outcome']})", file=sys.stderr)
        return {"t": "ok"}
    return {"t": "error", "error": f"unknown message {msg['t']}"}


def main():
    rng = random.Random(0)
    for line in sys.stdin:
        if line.strip():
            sys.stdout.write(json.dumps(reply(json.loads(line), rng)) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
