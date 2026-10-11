#!/usr/bin/env python3
"""
Do compiled bots play the same games as the programs they were built from? Reads one ladder run (bot/ladder.js
--out <dir>, file ladder.json) that has both <name> and <name>-wasm against the same opponents, seeds and --key, pairs
their games by (opponent, seed, seat) and counts the pairs with the same winner seat, rounds and steps.

    SWU_EXTERNAL_BOTS=... node bot/ladder.js --bots c-clock,c-clock-wasm --vs rush --games 4 --key none --out results/x
    python3 bot/compiled/compare.py results/x [--json]
"""
import glob
import json
import os
import sys


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 1:
        sys.exit(__doc__.strip().split("\n\n")[1])
    path = args[0]
    if os.path.isdir(path):
        # the run folder (<out>/<id>) or the --out folder holding one run
        found = [p for p in [os.path.join(path, "ladder.json")] + sorted(glob.glob(os.path.join(path, "*", "ladder.json"))) if os.path.exists(p)]
        if len(found) != 1:
            sys.exit("%s: expected one ladder.json, found %d" % (path, len(found)))
        path = found[0]
    games = json.load(open(path))["games"]
    # (bot, opponent, seed, seat) -> outcome, for finished games
    seen = {}
    for g in games:
        if g.get("outcome") is None:
            continue  # not played (an interrupted run)
        for seat, other in (("p1", "p2"), ("p2", "p1")):
            seen[(g[seat], g[other], g["seed"], seat)] = g
    rows = {}
    for (me, opp, seed, seat), g in seen.items():
        if me.endswith("-wasm") or (me + "-wasm", opp, seed, seat) not in seen:
            continue
        w = seen[(me + "-wasm", opp, seed, seat)]
        r = rows.setdefault(me, {"bot": me, "games": 0, "same": 0, "same_winner": 0, "differ": [], "ms": [0, 0], "n": [0, 0]})
        r["games"] += 1
        a = (g.get("winnerSeat"), g.get("rounds"), g.get("steps"), g.get("outcome"))
        b = (w.get("winnerSeat"), w.get("rounds"), w.get("steps"), w.get("outcome"))
        r["same"] += a == b
        r["same_winner"] += a[0] == b[0]
        if a != b:
            r["differ"].append({"opponent": opp, "seed": seed, "seat": seat, "native": a, "wasm": b})
        for k, x in enumerate((g, w)):
            t = (x.get("timing") or {}).get(seat) or {}
            r["ms"][k] += t.get("ms", 0)
            r["n"][k] += t.get("n", 0)
    out = []
    for r in sorted(rows.values(), key=lambda r: r["bot"]):
        native = r["ms"][0] / r["n"][0] if r["n"][0] else None
        wasm = r["ms"][1] / r["n"][1] if r["n"][1] else None
        out.append({"bot": r["bot"], "games": r["games"], "identical": r["same"], "same_winner": r["same_winner"],
                    "ms_per_decision": {"native": native, "wasm": wasm}, "differ": r["differ"]})
    if "--json" in sys.argv:
        print(json.dumps(out, indent=2))
        return
    print("%-14s %5s %9s %11s %10s %10s %6s" % ("bot", "games", "identical", "same winner", "native ms", "wasm ms", "ratio"))
    for r in out:
        n, w = r["ms_per_decision"]["native"], r["ms_per_decision"]["wasm"]
        print("%-14s %5d %9d %11d %10s %10s %6s" % (
            r["bot"], r["games"], r["identical"], r["same_winner"],
            "%.2f" % n if n is not None else "-", "%.2f" % w if w is not None else "-",
            "%.1fx" % (w / n) if n and w else "-"))
    if not out:
        print("no <name> / <name>-wasm pairs with the same opponent, seed and seat in %s" % path)


if __name__ == "__main__":
    main()
