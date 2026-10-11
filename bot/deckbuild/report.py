"""Merge field-eval runs and compare deck groups on the same seeds.

    python3 bot/deckbuild/report.py DIR [DIR ...] [--out report.json] [--base real,stat]

A candidate named `<group>:<target>` belongs to <group> (built-linear, real, stat, ...). Runs made with the same
--seed share seeds per (target, field deck), so groups from different runs are paired. For every group and every
base group, the paired difference is averaged over (target, field deck) cells that both played.
"""
import argparse
import json
import math
import os


def score(r):
    if r.get("outcome") == "ERROR" and not r.get("winner"):
        return None
    if not r.get("winner"):
        return 0.5
    return 1.0 if r["winner"] == r["aSeat"] else 0.0


def mean_ci(xs):
    n = len(xs)
    m = sum(xs) / n
    sd = math.sqrt(sum((x - m) ** 2 for x in xs) / max(n - 1, 1))
    h = 1.96 * sd / math.sqrt(n)
    return {"n": n, "mean": round(m, 4), "ci95": [round(m - h, 4), round(m + h, 4)]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dirs", nargs="+")
    ap.add_argument("--out", default=None)
    ap.add_argument("--base", default="real,stat")
    a = ap.parse_args()

    cells = {}  # group -> (target, field) -> [scores]
    errors, games = {}, {}
    for d in a.dirs:
        with open(os.path.join(d, "results.jsonl")) as fh:
            for line in fh:
                if not line.strip():
                    continue
                r = json.loads(line)
                group, _, target = r["deck"].partition(":")
                games[group] = games.get(group, 0) + 1
                s = score(r)
                if s is None:
                    errors[group] = errors.get(group, 0) + 1
                    continue
                cells.setdefault(group, {}).setdefault((target, r["field"]), []).append(s)

    groups = {}
    for g, cs in cells.items():
        xs = [s for v in cs.values() for s in v]
        m = sum(xs) / len(xs)
        se = math.sqrt(m * (1 - m) / len(xs))
        per = {}
        for (t, _), v in cs.items():
            per.setdefault(t, []).extend(v)
        groups[g] = {"games": games[g], "errors": errors.get(g, 0), "score": round(m, 4),
                     "ci95": [round(m - 1.96 * se, 4), round(m + 1.96 * se, 4)],
                     "perTarget": {t: round(sum(v) / len(v), 3) for t, v in sorted(per.items())}}

    paired = {}
    for b in a.base.split(","):
        if b not in cells:
            continue
        for g in cells:
            if g == b:
                continue
            both = [k for k in cells[g] if k in cells[b]]
            if not both:
                continue
            diffs = [sum(cells[g][k]) / len(cells[g][k]) - sum(cells[b][k]) / len(cells[b][k]) for k in both]
            paired[f"{g}-minus-{b}"] = mean_ci(diffs)

    rep = {"runs": a.dirs, "groups": groups, "paired": paired}
    for g, v in sorted(groups.items(), key=lambda kv: -kv[1]["score"]):
        print(f"{g:24s} {v['score']:.3f} [{v['ci95'][0]:.3f}, {v['ci95'][1]:.3f}]  {v['games']} games, {v['errors']} errors")
    for k, v in paired.items():
        print(f"{k:36s} {v['mean']:+.3f} [{v['ci95'][0]:+.3f}, {v['ci95'][1]:+.3f}]  {v['n']} cells")
    if a.out:
        with open(a.out, "w") as fh:
            json.dump(rep, fh, indent=1)


if __name__ == "__main__":
    main()
