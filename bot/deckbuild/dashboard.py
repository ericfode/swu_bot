"""Publish the deck-building experiments to the research dashboard (dashboard/README.md section 2).

    python3 bot/deckbuild/dashboard.py [--root /mnt/project-files/deckbuild] [--builder report.json] [--draft DIR ...]

Writes dashboard/experiments/deckbuild-*.json (this thread is their only writer). Missing runs are skipped.
"""
import argparse
import datetime
import json
import os

OWNER = "JEPA deck building and drafting"


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write(dash, doc):
    os.makedirs(dash, exist_ok=True)
    path = os.path.join(dash, f"{doc['id']}.json")
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(doc, fh, indent=1)
    os.replace(tmp, path)
    print(f"wrote {path}")


def load(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="/mnt/project-files/deckbuild")
    ap.add_argument("--dash", default="/mnt/project-files/dashboard/experiments")
    ap.add_argument("--builder", default=None, help="report.json from report.py")
    ap.add_argument("--draft", nargs="*", default=[])
    a = ap.parse_args()

    s = load(os.path.join(a.root, "exp1-c-clock", "summary.json"))
    if s:
        rows = s["rows"]
        pr = s["paired"]["real-minus-random"]
        write(a.dash, {
            "schema": 1, "id": "deckbuild-visible", "title": "Can our bots tell a good deck from a bad one?", "owner": OWNER,
            "hypothesis": "With c-clock piloting both seats, real tournament decks beat random and simple stat decks of the same leader and base.",
            "status": "done", "startedAt": "2026-10-11T17:37:00Z", "updatedAt": now(),
            "progress": {"done": s["games"], "total": s["games"], "unit": "games"},
            "metrics": [{"label": f"{k} decks vs the 27-deck field", "value": rows[k]["score"], "format": "pct"} for k in ("real", "stat", "random")]
            + [{"label": "real minus random (paired)", "value": pr["diff"], "format": "pct"}],
            "conclusion": f"Yes. Real lists score {rows['real']['score']:.0%}, the stat builder {rows['stat']['score']:.0%}, random cards "
                          f"{rows['random']['score']:.0%} against the same field. Deck quality is visible to the pilot, so a builder can be judged in games.",
        })

    b = load(a.builder) if a.builder else None
    if b:
        g, pr = b["groups"], b["paired"]
        order = sorted(g.items(), key=lambda kv: -kv[1]["score"])
        loops = sorted(k for k in g if k.startswith("loop") and k.endswith("-linear"))
        best = loops[-1] if loops else "built-linear"
        lin = pr.get(f"{best}-minus-real")
        write(a.dash, {
            "schema": 1, "id": "deckbuild-builder", "title": "Deck model builder vs real decks", "owner": OWNER,
            "hypothesis": "A deck model trained on bot games builds decks that score as well as real tournament lists against the field.",
            "status": "done", "startedAt": "2026-10-11T18:10:00Z", "updatedAt": now(),
            "progress": {"done": sum(v["games"] for v in g.values()), "total": sum(v["games"] for v in g.values()), "unit": "games"},
            "metrics": [{"label": f"{k} vs the field", "value": v["score"], "format": "pct"} for k, v in order],
            "conclusion": None if not lin else
            f"Yes for the bot pilot. Decks built with the linear card-value model ({best}) score {g[best]['score']:.0%} against "
            f"{g['real']['score']:.0%} for real lists on the same seeds (gap {lin['mean'] * 100:+.1f} points). Deep and JEPA models "
            f"build weaker decks because the builder finds decks they overrate.",
        })

    metrics, scores = [], {}
    for d in a.draft:
        p = load(os.path.join(d, "summary.json"))
        if not p:
            continue
        for k, v in sorted(p["drafters"].items(), key=lambda kv: -kv[1]["score"]):
            metrics.append({"label": f"{k} drafter ({os.path.basename(d)})", "value": v["score"], "format": "pct"})
            scores.setdefault(k, []).append(v["score"])
    if metrics:
        write(a.dash, {
            "schema": 1, "id": "deckbuild-draft", "title": "Draft bots: JEPA drafter vs simple drafters", "owner": OWNER,
            "hypothesis": "A drafter that imagines the finished deck with the deck JEPA drafts stronger decks than pick-by-stats.",
            "status": "done" if "model" in scores else "running", "startedAt": "2026-10-11T18:10:00Z", "updatedAt": now(),
            "metrics": metrics,
            "conclusion": None if "model" not in scores else
            ("Yes, after training on its own pods. " if scores["model"][-1] > 0.53 else "Not yet. ")
            + f"Picking by printed stats beats random and rarity-first picks; the JEPA drafter scores {scores['model'][-1]:.0%} "
            f"against the stat drafter's {scores['stat'][-1]:.0%} in shared pods (latest run).",
        })


if __name__ == "__main__":
    main()
