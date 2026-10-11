"""Build decks with a trained deck model: hill-climb card swaps that raise the predicted win rate against a field.

    python3 bot/deckbuild/build.py --model M.npz --out built.json [--field bot/decks/ash-meta-2026-09.json]
        [--targets field|LEADER/BASE,...] [--fold K/N] [--starts starts.json] [--random-starts 2] [--steps 150] [--tag NAME]

For every target leader and base (default: those of the field decks) it starts from each given start deck with that
leader and base (--starts, e.g. statDeck output) and from --random-starts random aspect-legal decks, then makes the
best single-copy swap (remove one copy of a card, add one copy of an aspect-legal card, at most 3 copies) until no
swap raises the score. The score is the model's mean P(win) against the field decks (deck_np.DeckModel.field_score).
The encoder input is linear in the card counts, so every swap is scored from one shared first-layer input.
Writes the best deck per target as SWUDB lists (metadata: name, predicted, start) for field-eval.js.
"""
import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import deck_np as DN  # noqa: E402
from deck_jepa import as_counts, fold_names, read_lists  # noqa: E402

MAX_COPIES = 3


def to_list(idx, name, L, B, counts, meta=None):
    deck = [{"id": idx.main[i]["setCode"], "count": int(k)} for i, k in enumerate(counts) if k > 0]
    return {"metadata": {"name": name, **(meta or {})}, "leader": {"id": idx.leaders[L]["setCode"], "count": 1},
            "base": {"id": idx.bases[B]["setCode"], "count": 1}, "deck": deck}


class Builder:
    def __init__(self, model, idx, field, weights=None):
        self.m, self.idx = model, idx
        fx, fe = idx.extras(np.stack([f["counts"] for f in field]), [f["L"] for f in field], [f["B"] for f in field])
        self.fL = np.array([f["L"] for f in field])
        self.fB = np.array([f["B"] for f in field])
        self.field = (fx, fe, self.fL, self.fB)
        self.zf = None if model.mode == "linear" else model.latent(fx, fe, self.fL, self.fB)
        self.weights = weights

    def score(self, counts, L, B):
        x, e = self.idx.extras(counts[None], [L], [B])
        return float(self.m.field_score(x, e, np.array([L]), np.array([B]), self.zf, field=self.field, weights=self.weights)[0])

    def _score_pre(self, pre):
        z = self.m.latent_from_pre(pre)
        p = self.m.matchup(z, self.zf)
        w = np.ones(p.shape[1]) if self.weights is None else np.asarray(self.weights)
        return (p * w).sum(1) / w.sum()

    def climb(self, counts, L, B, steps=150, prefilter=256, log=None):
        idx, m = self.idx, self.m
        counts = counts.astype(np.float32).copy()
        legal = np.where(idx.penalty_icons(L, B) == 0)[0]
        pen = idx.penalty_icons(L, B)
        best = self.score(counts, L, B)
        for step in range(steps):
            have = np.where(counts > 0)[0]
            add = legal[counts[legal] < MAX_COPIES]
            total = counts.sum()
            if m.mode == "linear":
                gain = m.w["lw"][add][None, :] - m.w["lw"][have][:, None]
                gain = gain / DN.SIZE_NORM
                gain[have[:, None] == add[None, :]] = -np.inf
                r, c = np.unravel_index(np.argmax(gain), gain.shape)
                if gain[r, c] <= 1e-6:
                    break
                counts[have[r]] -= 1
                counts[add[c]] += 1
                best = self.score(counts, L, B)
                continue
            x, e = idx.extras(counts[None], [L], [B])
            pre0 = m.pre(x, e, np.array([L]), np.array([B]))[0]
            d = DN.D
            ds = (m.emb[add][None, :, :] - m.emb[have][:, None, :]) / DN.SIZE_NORM  # (h, a, D)
            dmix = (idx.XM[add][None, :, :] - idx.XM[have][:, None, :]) / total
            dpen = (pen[add][None, :] - pen[have][:, None]) / total
            h, a_ = len(have), len(add)
            pre = np.repeat(np.repeat(pre0[None, None, :], h, 0), a_, 1)
            pre[:, :, :d] += ds
            pre[:, :, 3 * d:3 * d + DN.MIX] += dmix
            pre[:, :, 3 * d + DN.MIX + 1] += dpen
            pre = pre.reshape(h * a_, -1)
            same = (have[:, None] == add[None, :]).reshape(-1)
            # cheap filter on strength alone, then the full field score on the best few
            v = m.value(m.latent_from_pre(pre))
            v[same] = -np.inf
            top = np.argsort(-v)[:prefilter]
            s = self._score_pre(pre[top])
            j = int(np.argmax(s))
            if s[j] <= best + 1e-5:
                break
            best = float(s[j])
            r, c = divmod(int(top[j]), a_)
            counts[have[r]] -= 1
            counts[add[c]] += 1
            if log and step % 25 == 0:
                log(f"    step {step}: {best:.4f}")
        return counts, self.score(counts, L, B)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--cards", default="/mnt/project-files/deckbuild/cards.json")
    ap.add_argument("--field", default=os.path.join(REPO, "bot/decks/ash-meta-2026-09.json"))
    ap.add_argument("--targets", default="field")
    ap.add_argument("--fold", default=None, help="K/N: only the field targets of fold K (pairs with deck_jepa.py --exclude-fold)")
    ap.add_argument("--starts", default=None)
    ap.add_argument("--random-starts", type=int, default=1)
    ap.add_argument("--steps", type=int, default=150)
    ap.add_argument("--tag", default="built")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    rng = np.random.default_rng(a.seed)
    idx = DN.CardIndex(a.cards)
    model = DN.DeckModel(a.model, idx)
    field = []
    for d in read_lists(a.field):
        name, L, B, c = as_counts(d)
        field.append({**idx.deck(L, B, c), "name": name})
    b = Builder(model, idx, field)
    if a.targets == "field":
        targets = [(f["L"], f["B"], f["name"]) for f in field]
        if a.fold:
            keep = set(fold_names([f["name"] for f in field], a.fold))
            targets = [t for t in targets if t[2] in keep]
    else:
        targets = []
        for t in a.targets.split(","):
            L, B = t.split("/")
            targets.append((idx.lpos[idx.code(L)], idx.bpos[idx.code(B)], t))
    starts = []
    if a.starts:
        for d in read_lists(a.starts):
            name, L, B, c = as_counts(d)
            starts.append({**idx.deck(L, B, c), "name": name})
    out = []
    for L, B, tname in targets:
        tries = [(s["name"], s["counts"]) for s in starts if s["L"] == L and s["B"] == B]
        legal = np.where(idx.penalty_icons(L, B) == 0)[0]
        for k in range(a.random_starts):
            c = np.zeros(idx.n, np.float32)
            while c.sum() < 50:
                i = rng.choice(legal)
                if c[i] < MAX_COPIES:
                    c[i] += 1
            tries.append((f"random{k}", c))
        results = []
        for sname, c in tries:
            s0 = b.score(c, L, B)
            cc, s1 = b.climb(c, L, B, steps=a.steps)
            results.append((s1, sname, s0, cc))
            print(f"  {tname} from {sname}: {s0:.3f} -> {s1:.3f}", file=sys.stderr)
        s1, sname, s0, cc = max(results, key=lambda r: r[0])
        out.append(to_list(idx, f"{a.tag}:{tname}", L, B, cc, {"predicted": round(s1, 4), "start": sname, "startPredicted": round(s0, 4)}))
    with open(a.out, "w") as fh:
        json.dump(out, fh)
    print(f"{len(out)} decks -> {a.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
