"""Publish the deck-building experiments to the research dashboard (dashboard/README.md section 2).

    python3 bot/deckbuild/dashboard.py [--root /mnt/project-files/deckbuild] [--builder DIR ...] [--draft DIR ...]

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
    ap.add_argument("--builder", nargs="*", default=[])
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

    series, metrics = [], []
    for d in a.builder:
        b = load(os.path.join(d, "summary.json"))
        if not b:
            continue
        for g, v in sorted(b["groups"].items(), key=lambda kv: -kv[1]["score"]):
            metrics.append({"label": f"{g} ({os.path.basename(d)})", "value": v["score"], "format": "pct"})
    if metrics:
        write(a.dash, {
            "schema": 1, "id": "deckbuild-builder", "title": "Deck JEPA builder vs real decks", "owner": OWNER,
            "hypothesis": "A deck model trained on bot games builds decks that score as well as real tournament lists against the field.",
            "status": "running", "startedAt": "2026-10-11T18:10:00Z", "updatedAt": now(), "metrics": metrics, "conclusion": None,
        })

    metrics = []
    for d in a.draft:
        p = load(os.path.join(d, "summary.json"))
        if not p:
            continue
        for k, v in sorted(p["drafters"].items(), key=lambda kv: -kv[1]["score"]):
            metrics.append({"label": f"{k} drafter ({os.path.basename(d)})", "value": v["score"], "format": "pct"})
    if metrics:
        write(a.dash, {
            "schema": 1, "id": "deckbuild-draft", "title": "Draft bots: JEPA drafter vs simple drafters", "owner": OWNER,
            "hypothesis": "A drafter that imagines the finished deck with the deck JEPA drafts stronger decks than pick-by-stats.",
            "status": "running", "startedAt": "2026-10-11T18:10:00Z", "updatedAt": now(), "metrics": metrics, "conclusion": None,
        })


if __name__ == "__main__":
    main()
