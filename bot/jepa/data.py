"""Builds JEPA training arrays from "swu-traj/1" games (see /mnt/project-files/learn/README.md).

    python3 bot/jepa/data.py --out data/jepa/mix-v1.npz data/traj/rr data/traj/rush-random ...

Every recorded decision becomes one row: the state vector, card tokens, the chosen action, who won, and the
row index of the same seat's next recorded decision (+1) and its 4th next decision (+4), which are the targets
the predictor must reach in latent space. Games that ended in ERROR, STEP_CAP or a draw are skipped.
"""
import argparse
import glob
import gzip
import json
import os
import sys
from multiprocessing import Pool

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import features as F  # noqa: E402

HORIZONS = (1, 4)
_db = None


def _init(card_data):
    global _db
    _db = F.load_cards(card_data)


def iter_games(path):
    """Yields (header, [decision lines], end) per game; tolerates a truncated last member."""
    game, ds = None, []
    with gzip.open(path, "rt", encoding="utf8") as fh:
        try:
            for line in fh:
                o = json.loads(line)
                if o["t"] == "game":
                    game, ds = o, []
                elif o["t"] == "d":
                    ds.append(o)
                elif o["t"] == "end" and game is not None:
                    yield game, ds, o
                    game, ds = None, []
        except (EOFError, OSError, ValueError):
            return


def encode_file(path):
    cols = {k: [] for k in ("state", "tok_ids", "tok_feats", "tok_mask", "act", "aid", "nact", "win", "game", "nxt1", "nxt4", "seq", "bot")}
    n = 0
    games = 0
    for game, ds, end in iter_games(path):
        if end.get("winner") not in ("p1", "p2"):
            continue
        games += 1
        seats = {"p1": [], "p2": []}
        start = n
        for d in ds:
            if not (0 <= d.get("i", -1) < len(d.get("actions") or [])):
                continue
            e = F.encode(d, _db)
            k = d["i"]
            cols["state"].append(e["state"])
            cols["tok_ids"].append(e["tok_ids"].astype(np.int16))
            cols["tok_feats"].append(e["tok_feats"].astype(np.float16))
            cols["tok_mask"].append(e["tok_mask"].astype(np.uint8))
            cols["act"].append(e["actions"][k])
            cols["aid"].append(e["aids"][k])
            cols["nact"].append(len(d["actions"]))
            cols["win"].append(1 if end["winner"] == d["you"] else 0)
            cols["game"].append(end["seed"])
            cols["seq"].append(d.get("seq", 0))
            seat_bot = game["bots"][0 if d["you"] == "p1" else 1]
            cols["bot"].append(seat_bot)
            seats[d["you"]].append(n - start)
            n += 1
        nx = {h: [-1] * (n - start) for h in HORIZONS}
        for rows in seats.values():
            for j, r in enumerate(rows):
                for h in HORIZONS:
                    if j + h < len(rows):
                        nx[h][r] = rows[j + h]
        cols["nxt1"] += nx[1]  # local index within the game; made global by the caller
        cols["nxt4"] += nx[4]
        cols.setdefault("gstart", []).extend([start] * (n - start))
    return path, games, cols


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--card-data", default=os.environ.get("SWU_CARD_DATA", "forceteki/test/json"))
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("dirs", nargs="+")
    a = ap.parse_args()
    files = sorted(f for d in a.dirs for f in (glob.glob(os.path.join(d, "*.jsonl.gz")) if os.path.isdir(d) else [d]))
    out = {}
    offset = 0
    total_games = 0
    with Pool(a.workers, initializer=_init, initargs=(a.card_data,)) as pool:
        for path, games, cols in pool.imap(encode_file, files):
            m = len(cols["state"])
            gstart = np.asarray(cols.pop("gstart", []), np.int64) + offset
            for h in HORIZONS:
                loc = np.asarray(cols[f"nxt{h}"], np.int64)
                cols[f"nxt{h}"] = np.where(loc >= 0, loc + gstart, -1)
            for k, v in cols.items():
                out.setdefault(k, []).append(np.asarray(v) if k != "bot" else np.asarray(v, dtype="U32"))
            offset += m
            total_games += games
            print(f"{path}: {games} games, {m} decisions", file=sys.stderr)
    arrays = {k: np.concatenate(v) for k, v in out.items()}
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    np.savez(a.out, **arrays)
    print(f"wrote {a.out}: {total_games} games, {offset} decisions", file=sys.stderr)


if __name__ == "__main__":
    main()
