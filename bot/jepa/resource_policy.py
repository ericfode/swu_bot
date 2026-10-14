#!/usr/bin/env python3
"""Resource choices learned from strong bots' recorded games.

    python3 bot/jepa/resource_policy.py fit --out bot/jepa/models/resource-v1.json data/traj/replays [--teachers c-clock,rust-search]

The planner cannot simulate the resource step (simulations are allowed only in action windows), and the imagined score
answered it badly: in recorded games the JEPA bot often kept every card and sat on 3 resources while c-clock had 6. The
strong bots' choices are in the replay data (bot/jepa/from_replays.js), so two small models copy them:

- which card: a conditional logit over the hand cards on offer, from card features (cost band, type, aspects the
  leader and base do not have, a second copy in hand) plus a weight per card for the cards seen often enough;
- whether to resource at all in the regroup phase: a logistic model on round, resources and hand size.

The model file is plain JSON; `ResourcePolicy.choose(msg)` answers a resource prompt (or returns None for another
prompt), with no numpy model of its own beyond the dot products.
"""
import argparse
import gzip
import json
import math
import os
import re
import sys

import numpy as np

FEATS = ["cost/8", "cost<=2", "cost 3-4", "cost>=5", "unit", "event", "upgrade", "off-aspect", "second copy", "space"]


def load_card_meta(path=None):
    """Cost, types and aspects by set code ("SOR_042") from the engine's card data."""
    path = path or os.environ.get("SWU_CARD_DATA", "forceteki/test/json")
    d = os.path.join(path, "Card") if os.path.isdir(os.path.join(path, "Card")) else path
    meta = {}
    if not os.path.isdir(d):
        return meta
    for name in os.listdir(d):
        try:
            with open(os.path.join(d, name), encoding="utf8") as fh:
                v = json.load(fh)
        except (OSError, ValueError):
            continue
        if not isinstance(v, dict):
            continue
        types = [t.lower() for t in v.get("types") or [] if isinstance(t, str)]
        m = {"cost": float(v["cost"]) if isinstance(v.get("cost"), (int, float)) else 0.0, "types": types,
             "aspects": [a.lower() for a in v.get("aspects") or [] if isinstance(a, str)], "space": v.get("arena") == "space"}
        codes = list(v.get("setCodes") or []) + ([v["setId"]] if v.get("setId") else [])
        for c in codes:
            if isinstance(c, dict) and isinstance(c.get("set"), str) and isinstance(c.get("number"), int):
                meta[f"{c['set']}_{c['number']:03d}"] = m
    return meta


def my_aspects(msg, meta):
    me = ((msg.get("state") or {}).get("players") or {}).get(msg.get("you")) or {}
    out = []
    for k in ("leader", "base"):
        s = (me.get(k) or {}).get("s")
        out += (meta.get(s) or {}).get("aspects", [])
    return out


def card_features(s, meta, aspects, hand_codes):
    m = meta.get(s) or {}
    cost = m.get("cost", 0.0)
    need = list(m.get("aspects", []))
    have = list(aspects)
    off = 0
    for a in need:  # an aspect icon counts once per copy the deck lacks, as the engine's penalty does
        if a in have:
            have.remove(a)
        else:
            off += 1
    t = m.get("types", [])
    return [cost / 8.0, float(cost <= 2), float(3 <= cost <= 4), float(cost >= 5), float("unit" in t), float("event" in t),
            float("upgrade" in t), float(off), float(hand_codes.count(s) > 1), float(bool(m.get("space")))]


def max_select(prompt):
    nums = re.findall(r"\d+", str(prompt.get("title") or ""))
    return int(nums[-1]) if nums else 1


def offered(msg):
    """The hand cards a resource prompt offers (index, set code), and the index of its button (skip or confirm)."""
    you = msg.get("you")
    cards, done = [], None
    for a in msg.get("actions") or []:
        c = a.get("card") or {}
        if a.get("kind") == "card" and c.get("zone") == "hand" and c.get("ctl") == you and c.get("s"):
            cards.append((a["i"], c["s"]))
        elif a.get("kind") == "button":  # "Skip Resourcing" before a pick, "Confirm Resources" or "Done" after
            done = a["i"]
    return cards, done


def stop_features(msg):
    st = msg.get("state") or {}
    me = (st.get("players") or {}).get(msg.get("you")) or {}
    res = (me.get("res") or {}).get("total") or 0
    return [1.0, (st.get("round") or 0) / 10.0, res / 10.0, (me.get("handCount") or 0) / 10.0]


class ResourcePolicy:
    def __init__(self, path, meta=None):
        with open(path) as fh:
            self.m = json.load(fh)
        self.meta = meta if meta is not None else load_card_meta()
        self.w = np.asarray(self.m["w"], np.float64)
        self.stop_w = np.asarray(self.m["stop"], np.float64)

    def score(self, msg, cards):
        aspects = my_aspects(msg, self.meta)
        me = ((msg.get("state") or {}).get("players") or {}).get(msg.get("you")) or {}
        hand = [c.get("s") for c in me.get("hand") or []]
        return [float(np.dot(self.w, card_features(s, self.meta, aspects, hand))) + self.m["card"].get(s, 0.0) for _, s in cards]

    def choose(self, msg):
        prompt = msg.get("prompt") or {}
        if prompt.get("type") != "resource":
            return None
        cards, done = offered(msg)
        picked = len(prompt.get("selected") or [])
        if done is not None and (picked >= max_select(prompt) or not cards):
            return done
        if not cards:
            return None
        if done is not None and picked == 0 and (msg.get("state") or {}).get("phase") == "regroup":
            p = 1.0 / (1.0 + math.exp(-float(np.dot(self.stop_w, stop_features(msg)))))
            if p > 0.5:
                return done
        sc = self.score(msg, cards)
        return cards[int(np.argmax(sc))][0]


def fit(a):
    meta = load_card_meta(a.card_data)
    teachers = set(a.teachers.split(","))
    choice, stops = [], []  # (game, [feature rows], [codes], chosen k) / (game, features, done?)
    files = sorted(os.path.join(d, f) for d in a.dirs for f in os.listdir(d) if f.endswith(".jsonl.gz"))
    gid = 0
    for f in files:
        bots = None
        with gzip.open(f, "rt", encoding="utf8") as fh:
            for line in fh:
                o = json.loads(line)
                if o["t"] == "game":
                    bots, gid = o["bots"], gid + 1
                    continue
                if o["t"] != "d" or (o.get("prompt") or {}).get("type") != "resource":
                    continue
                if bots[0 if o["you"] == "p1" else 1].split("#")[0] not in teachers:
                    continue
                prompt = o["prompt"]
                cards, done = offered(o)
                ch = o["actions"][o["i"]]
                picked = len(prompt.get("selected") or [])
                if done is not None and picked == 0 and o["state"].get("phase") == "regroup" and cards:
                    stops.append((gid, stop_features(o), float(o["i"] == done)))
                k = next((j for j, (i, _) in enumerate(cards) if i == o["i"]), None)
                if k is None or len(cards) < 2:
                    continue
                aspects = my_aspects(o, meta)
                hand = [c.get("s") for c in (o["state"]["players"][o["you"]].get("hand") or [])]
                choice.append((gid, [card_features(s, meta, aspects, hand) for _, s in cards], [s for _, s in cards], k))
    rng = np.random.default_rng(0)
    held = set(rng.choice(np.arange(1, gid + 1), max(1, gid // 10), replace=False).tolist())
    counts = {}
    for g, _, codes, _ in choice:
        if g not in held:
            for s in codes:
                counts[s] = counts.get(s, 0) + 1
    known = sorted(s for s, n in counts.items() if n >= a.min_seen)
    col = {s: j for j, s in enumerate(known)}
    nf = len(FEATS)

    def batch(rows):
        """Rows padded to the largest hand: features (N, K, F), card columns (N, K; -1 = no own weight), mask, chosen."""
        K = max(len(codes) for _, _, codes, _ in rows)
        X = np.zeros((len(rows), K, nf))
        C = np.full((len(rows), K), -1)
        mask = np.zeros((len(rows), K), bool)
        for r, (_, x, codes, _) in enumerate(rows):
            X[r, :len(x)] = x
            C[r, :len(codes)] = [col.get(s, -1) for s in codes]
            mask[r, :len(codes)] = True
        return X, C, mask, np.asarray([k for *_, k in rows])

    tr = [r for r in choice if r[0] not in held]
    he = [r for r in choice if r[0] in held]
    X, C, mask, Y = batch(tr)
    n = len(Y)
    has = C >= 0
    Cz = np.maximum(C, 0)
    w = np.zeros(nf)
    b = np.zeros(len(known))
    mw, vw, mb, vb = np.zeros_like(w), np.zeros_like(w), np.zeros_like(b), np.zeros_like(b)
    # full-batch Adam on the conditional logit; L2 keeps the per-card weights near the feature model
    for it in range(1, a.iters + 1):
        u = X @ w + np.where(has, b[Cz], 0.0)
        u = np.where(mask, u, -1e9)
        u -= u.max(axis=1, keepdims=True)
        p = np.exp(u) * mask
        p /= p.sum(axis=1, keepdims=True)
        nll = -np.mean(np.log(p[np.arange(n), Y] + 1e-12))
        gp = p.copy()
        gp[np.arange(n), Y] -= 1.0
        gw = np.einsum("nk,nkf->f", gp, X) / n
        gb = np.zeros(len(known))
        np.add.at(gb, Cz[has], gp[has])
        gb = gb / n + a.l2 * b
        for g, m_, v_, p_ in ((gw, mw, vw, w), (gb, mb, vb, b)):
            m_ *= 0.9
            m_ += 0.1 * g
            v_ *= 0.999
            v_ += 0.001 * g * g
            p_ -= a.lr * (m_ / (1 - 0.9 ** it)) / (np.sqrt(v_ / (1 - 0.999 ** it)) + 1e-8)
        if it % 50 == 0:
            print(f"iter {it}: train NLL {nll:.4f}", file=sys.stderr)

    def top1(rows, use_card=True, rule=False):
        hit = 0
        for _, x, codes, k in rows:
            x = np.asarray(x)
            if rule:  # bot/players/heuristic.js keepScore, lowest kept first
                u = x[:, 7] * 3 - x[:, 4] * 1.5 - (x[:, 0] * 8 <= 3) * 1.0 + x[:, 0] * 8 * 0.3
            else:
                u = x @ w + (np.asarray([b[col[s]] if s in col else 0.0 for s in codes]) if use_card else 0.0)
            hit += int(np.argmax(u) == k)
        return hit / max(len(rows), 1)

    chance = float(np.mean([1.0 / len(c) for _, _, c, _ in he]))
    res = {"held_choices": len(he), "top1_model": top1(he), "top1_features_only": top1(he, use_card=False), "top1_rule": top1(he, rule=True), "chance": chance}
    print(json.dumps(res), file=sys.stderr)

    # whether to resource at all (regroup, nothing picked yet): logistic regression
    S = np.asarray([x for g, x, _ in stops if g not in held])
    T = np.asarray([y for g, _, y in stops if g not in held])
    sw = np.zeros(S.shape[1])
    for _ in range(3000):
        p = 1 / (1 + np.exp(-(S @ sw)))
        sw -= 0.5 * (S.T @ (p - T)) / len(T)
    Sh = np.asarray([x for g, x, _ in stops if g in held])
    Th = np.asarray([y for g, _, y in stops if g in held])
    acc = float(np.mean(((1 / (1 + np.exp(-(Sh @ sw)))) > 0.5) == Th)) if len(Th) else None
    res.update({"stop_held": len(Th), "stop_acc": acc, "stop_base": float(Th.mean()) if len(Th) else None})
    out = {"format": "swu-resource/1", "teachers": sorted(teachers), "features": FEATS, "w": w.round(5).tolist(),
           "card": {s: round(float(b[col[s]]), 4) for s in known}, "stop": sw.round(5).tolist(), "stop_features": ["1", "round/10", "resources/10", "hand/10"],
           "train_choices": len(tr), "result": res}
    with open(a.out, "w") as fh:
        json.dump(out, fh, indent=1)
    print(f"wrote {a.out}: {len(known)} cards with their own weight; {json.dumps(res)}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fit")
    f.add_argument("--out", required=True)
    f.add_argument("--teachers", default="c-clock,rust-search")
    f.add_argument("--card-data", default=os.environ.get("SWU_CARD_DATA", "forceteki/test/json"))
    f.add_argument("--min-seen", type=int, default=30)
    f.add_argument("--iters", type=int, default=300)
    f.add_argument("--lr", type=float, default=0.05)
    f.add_argument("--l2", type=float, default=1e-3)
    f.add_argument("dirs", nargs="+")
    a = ap.parse_args()
    if a.cmd == "fit":
        fit(a)


if __name__ == "__main__":
    main()
