#!/usr/bin/env python3
"""Reference client for the stdio bot protocol (spec/stdio-protocol.md). Standard library only.

Reads one JSON message per line on stdin and answers each with one line on stdout.
Logs go to stderr; stdout carries protocol lines only.

    node bot/tournament.js --bots py-random,random-a --games 2 --out replays/py-test
"""
import json
import random
import sys


def split(dist, rng):
    """Pick a legal split for a distribute action: fill targets in random order up to their caps."""
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
    if left and not dist["canDistributeLess"]:
        return None  # not enough capacity in the targets we kept: let the engine side split it
    return out


def main():
    rng = random.Random(0)
    for line in sys.stdin:
        msg = json.loads(line)
        if msg["t"] == "hello":
            rng = random.Random(msg["seed"])
            print(f"[py-random] new game as {msg['you']}", file=sys.stderr)
            reply = {"t": "ready", "v": 1, "name": "py-random"}
        elif msg["t"] == "decide":
            action = rng.choice(msg["actions"])
            reply = {"t": "act", "i": action["i"]}
            if action["kind"] == "distribute":
                d = split(action["distribute"], rng)
                if d is not None:
                    reply["distribution"] = d
        else:
            reply = {"t": "error", "error": f"unknown message {msg['t']}"}
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
