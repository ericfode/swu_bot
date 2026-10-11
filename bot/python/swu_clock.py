#!/usr/bin/env python3
"""py-clock: a Star Wars Unlimited bot in Python for the stdio protocol (spec/stdio-protocol.md). Standard library only.

    node bot/ladder.js --bots py-clock,rush --games 10

Reads card data from forceteki/test/json (or $SWU_CARD_JSON). Set SWU_PY_TRACE=<file> to append every prompt it
sees and the choice it made, one JSON line each (for debugging).
"""
import json
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cards import CardDb  # noqa: E402
from policy import Policy  # noqa: E402

NAME = "py-clock"


def log(*parts):
    print("[%s]" % NAME, *parts, file=sys.stderr, flush=True)


def main():
    db = CardDb.load()
    if not len(db):
        log("no card data found (run from the repo root or set SWU_CARD_JSON); playing without card stats")
    policy = Policy(db)
    trace_path = os.environ.get("SWU_PY_TRACE")
    trace = open(trace_path, "a", encoding="utf-8") if trace_path else None
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        t = msg.get("t")
        if t == "hello":
            policy.reset()
            reply = {"t": "ready", "v": 1, "name": NAME}
        elif t == "decide":
            try:
                reply = policy.decide(msg)
            except Exception:  # a bug in a rule must not cost the game: fall back to the first action
                log("error, playing action 0:", traceback.format_exc())
                reply = {"t": "act", "i": msg["actions"][0]["i"]}
            if trace:
                p = msg.get("prompt") or {}
                pick = next((a for a in msg["actions"] if a["i"] == reply["i"]), {})
                trace.write(json.dumps({
                    "seq": msg.get("seq"), "you": msg.get("you"), "type": p.get("type"), "title": p.get("title"), "src": p.get("promptTitle"),
                    "mode": p.get("selectCardMode"), "sel": len(p.get("selected") or []),
                    "acts": [[a["kind"], a["label"], (a.get("card") or {}).get("zone"), (a.get("card") or {}).get("ctl")]
                             for a in msg["actions"][:12]],
                    "n": len(msg["actions"]), "pick": [pick.get("kind"), pick.get("label")],
                    "dist": reply.get("distribution")}) + "\n")
                trace.flush()
        else:
            reply = {"t": "error", "error": "unknown message %r" % t}
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
