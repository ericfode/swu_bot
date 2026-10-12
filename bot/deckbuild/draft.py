"""Draft simulator for Star Wars: Unlimited (Comprehensive Rules 10.3) with pluggable drafters and deck builders.

    python3 bot/deckbuild/draft.py --set SOR --pods 20 --drafters stat,rarity,random,stat --out pods.json
        [--model M.npz] [--builder stat|model] [--seed 1]

A pod is 8 players, 3 boosters each. Booster (16 cards, rates approximate): 1 leader (rare 1 in 6, else common),
1 common base, 9 commons, 3 uncommons, 1 rare (legendary 1 in 8), 1 foil of any rarity. Leaders are drafted first:
each player picks from the 3 leaders of their packs and passes the rest. Common bases are set aside (anyone may use
any common base of the set). Then 3 rounds of 14 picks, passing left, right, left. Each player builds a deck of one
of their 3 leaders, one base and 30 cards from what they drafted (no copy limit).

Drafters (--drafters, one per seat, cycled over the 8 seats; seats rotate between pods):
    random    any card
    rarity    highest rarity first
    stat      printed stats for the cost (decks.js statScorer) plus aspect fit with the cards and leaders it holds
    model     the deck JEPA: for each card in the pack, encode the pool with that card, let the predictor imagine the
              finished deck, and take the card whose imagined deck has the highest value (needs --model)
Builders: `stat` (in-aspect cards by stat score, on a 30-card curve; the default for every drafter, so drafters are
compared on the same footing) or `model` (hill-climbs the predicted value within the pool).
Writes { set, pods: [{ seed, players: [{ drafter, deck (SWUDB list), picks }] }] } for pod-eval.js.
"""
import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import deck_np as DN  # noqa: E402

RARITY_RANK = {"Common": 0, "Uncommon": 1, "Rare": 2, "Legendary": 3, "Special": 1}
LIMITED_CURVE = {1: 2, 2: 7, 3: 7, 4: 5, 5: 4, 6: 2, 7: 2, 8: 1}  # 30 cards
DECK = 30


class SetPool:
    """The cards of one set by rarity, from cards.json (rarityBySet comes from fetch-rarity.js)."""

    def __init__(self, idx, set_code):
        self.idx, self.set = idx, set_code
        self.by = {}
        for kind, cards in (("main", idx.main), ("leader", idx.leaders), ("base", idx.bases)):
            for i, c in enumerate(cards):
                r = (c.get("rarityBySet") or {}).get(set_code)
                if r:
                    self.by.setdefault((kind, r), []).append(i)
        self.common_bases = self.by.get(("base", "Common"), [])
        need = [("main", "Common"), ("main", "Uncommon"), ("main", "Rare"), ("leader", "Common")]
        missing = [k for k in need if not self.by.get(k)]
        if missing:
            raise SystemExit(f"set {set_code}: no cards for {missing} (run fetch-rarity.js, then export-cards.js)")

    def booster(self, rng):
        """-> (leader index, [main card indexes]) ; the common base slot is set aside, rare bases are skipped."""
        lr = "Rare" if rng.random() < 1 / 6 and self.by.get(("leader", "Rare")) else "Common"
        leader = int(rng.choice(self.by[("leader", lr)]))
        cards = list(rng.choice(self.by[("main", "Common")], 9, replace=False))
        cards += list(rng.choice(self.by[("main", "Uncommon")], 3, replace=False))
        rr = "Legendary" if rng.random() < 1 / 8 and self.by.get(("main", "Legendary")) else "Rare"
        cards.append(rng.choice(self.by[("main", rr)]))
        u = rng.random()
        fr = "Common" if u < 0.7 else "Uncommon" if u < 0.9 else "Rare" if u < 0.98 else "Legendary"
        cards.append(rng.choice(self.by.get(("main", fr)) or self.by[("main", "Common")]))
        return leader, [int(c) for c in cards]


def stat_scores(idx):
    """decks.js statScorer: printed power + hp beyond the cost line of all units, plus keyword bonuses; 0 for
    events and upgrades (stats cannot see their text)."""
    units = [c for c in idx.main if c["type"] == "unit"]
    x = np.array([c["cost"] or 0 for c in units], float)
    y = np.array([(c["power"] or 0) + (c["hp"] or 0) for c in units], float)
    slope, icpt = np.polyfit(x, y, 1)
    kw = {"sentinel": 1, "shielded": 1.5, "overwhelm": 0.5, "raid": 1, "restore": 1, "saboteur": 0.5, "ambush": 1, "grit": 0.5, "hidden": 0.5}
    s = np.zeros(idx.n)
    for i, c in enumerate(idx.main):
        if c["type"] == "unit":
            s[i] = (c["power"] or 0) + (c["hp"] or 0) - (icpt + slope * (c["cost"] or 0)) + sum(kw.get(k, 0) for k in c["keywords"])
    return s


# ---------------------------------------------------------------- deck building from a pool

def best_base(idx, sp, L, pool_counts, score):
    """The common base whose aspect lets the most good pool cards in."""
    best = None
    for B in sp.common_bases:
        pen = idx.penalty_icons(L, B)
        val = np.sort((score - 3 * pen)[pool_counts > 0])[-DECK:].sum()
        if best is None or val > best[0]:
            best = (val, B)
    return best[1]


def stat_build(idx, sp, leaders, pool_counts, score):
    """Try each leader with its best base; take 30 cards by score minus 3 per missing aspect icon, on a curve."""
    best = None
    for L in leaders:
        B = best_base(idx, sp, L, pool_counts, score)
        pen = idx.penalty_icons(L, B)
        val = score - 3 * pen
        counts = np.zeros(idx.n, np.float32)
        avail = pool_counts.copy()
        for cost, want in LIMITED_CURVE.items():
            cands = [i for i in np.argsort(-val) if avail[i] > 0 and min(idx.main[i]["cost"] or 0, 8) == cost]
            for i in cands:
                k = int(min(avail[i], want))
                counts[i] += k
                avail[i] -= k
                want -= k
                if want <= 0:
                    break
        for i in np.argsort(-val):  # top up a short curve
            while counts.sum() < DECK and avail[i] > 0:
                counts[i] += 1
                avail[i] -= 1
        tot = float((val * counts).sum())
        if best is None or tot > best[0]:
            best = (tot, L, B, counts)
    return best[1], best[2], best[3]


def model_build(model, idx, sp, leaders, pool_counts, score, steps=60):
    """Start from the stat build for each leader, then swap cards within the pool while the predicted value rises."""
    best = None
    for L in leaders:
        B = best_base(idx, sp, L, pool_counts, score)
        _, _, counts = stat_build(idx, sp, [L], pool_counts, score)
        val = lambda c: float(model.value(model.latent(*idx.extras(c[None], [L], [B]), np.array([L]), np.array([B])))[0])
        cur = val(counts)
        for _ in range(steps):
            have = np.where(counts > 0)[0]
            add = np.where(pool_counts - counts > 0)[0]
            if len(add) == 0:
                break
            trials = []
            for r in have:
                for c in add:
                    if r == c:
                        continue
                    trials.append((r, c))
            C = np.repeat(counts[None], len(trials), 0)
            for t, (r, c) in enumerate(trials):
                C[t, r] -= 1
                C[t, c] += 1
            x, e = idx.extras(C, [L] * len(C), [B] * len(C))
            v = model.value(model.latent(x, e, np.full(len(C), L), np.full(len(C), B)))
            j = int(np.argmax(v))
            if v[j] <= cur + 1e-5:
                break
            cur = float(v[j])
            counts = C[j]
        if best is None or cur > best[0]:
            best = (cur, L, B, counts)
    return best[1], best[2], best[3]


# ---------------------------------------------------------------- drafters

class Drafter:
    def __init__(self, kind, idx, sp, score, model=None, rng=None):
        self.kind, self.idx, self.sp, self.score, self.model, self.rng = kind, idx, sp, score, model, rng
        self.leaders, self.pool = [], np.zeros(idx.n, np.float32)

    def pick_leader(self, options):
        if self.kind == "random":
            return options[self.rng.integers(len(options))]
        if self.kind == "rarity":
            return max(options, key=lambda L: (self.idx.leaders[L].get("rarityBySet", {}).get(self.sp.set) == "Rare", self.rng.random()))
        # stat / model: the leader whose aspects fit the pool best (leader draft comes first: fit the others held)
        held = [self.idx.AL[L] for L in self.leaders]
        return max(options, key=lambda L: (sum(float(self.idx.AL[L] @ h) for h in held), self.rng.random()))

    def aspect_fit(self):
        """Penalty icons per card for the best leader held and its best base (lower is better)."""
        if not self.leaders:
            return np.zeros(self.idx.n)
        pens = []
        for L in self.leaders:
            B = best_base(self.idx, self.sp, L, self.pool, self.score) if self.pool.sum() else self.sp.common_bases[0]
            p = self.idx.penalty_icons(L, B)
            pens.append(((self.pool * p).sum(), p))
        return min(pens, key=lambda t: t[0])[1]

    def pick(self, pack, picks_done):
        idx = self.idx
        if self.kind == "random":
            c = pack[self.rng.integers(len(pack))]
        elif self.kind == "rarity":
            c = max(pack, key=lambda i: (RARITY_RANK.get(idx.main[i].get("rarityBySet", {}).get(self.sp.set), 0), self.score[i], self.rng.random()))
        elif self.kind == "stat":
            commit = min(1.0, picks_done / 10)  # take good cards early, stay in aspect later
            pen = self.aspect_fit()
            c = max(pack, key=lambda i: (self.score[i] - 3 * commit * pen[i], self.rng.random()))
        else:
            c = self.model_pick(pack)
        self.pool[c] += 1
        return c

    def model_pick(self, pack):
        """JEPA pick: imagine the finished deck from pool + card, score it with the value head; best leader wins."""
        idx, m = self.idx, self.model
        best = (-np.inf, pack[0])
        uniq = sorted(set(pack))
        for L in self.leaders:
            B = best_base(idx, self.sp, L, self.pool, self.score) if self.pool.sum() else self.sp.common_bases[0]
            C = np.repeat(self.pool[None], len(uniq), 0)
            for t, c in enumerate(uniq):
                C[t, c] += 1
            x, e = idx.extras(C, [L] * len(C), [B] * len(C))
            z = m.latent(x, e, np.full(len(C), L), np.full(len(C), B))
            v = m.value(m.predict(z))
            j = int(np.argmax(v))
            if v[j] > best[0]:
                best = (v[j], uniq[j])
        return best[1]


def run_pod(sp, drafters, rng, builder, model):
    idx = sp.idx
    n = len(drafters)
    packs = [[sp.booster(rng) for _ in range(3)] for _ in range(n)]
    # leader draft: start from your own 3 leaders, pass left
    lead = [[p[0] for p in packs[s]] for s in range(n)]
    for r in range(3):
        for s in range(n):
            L = drafters[s].pick_leader(lead[s])
            drafters[s].leaders.append(L)
            lead[s].remove(L)
        lead = [lead[(s - 1) % n] for s in range(n)]
    picks = [[] for _ in range(n)]
    for rnd in range(3):
        cur = [list(packs[s][rnd][1]) for s in range(n)]
        d = 1 if rnd % 2 == 0 else -1
        k = 0
        while any(cur):
            for s in range(n):
                if cur[s]:
                    c = drafters[s].pick(cur[s], k)
                    cur[s].remove(c)
                    picks[s].append(idx.main[c]["setCode"])
            cur = [cur[(s - d) % n] for s in range(n)]
            k += 1
    players = []
    for s, dr in enumerate(drafters):
        if builder == "model" and model is not None:
            L, B, counts = model_build(model, idx, sp, dr.leaders, dr.pool, dr.score)
        else:
            L, B, counts = stat_build(idx, sp, dr.leaders, dr.pool, dr.score)
        deck = [{"id": idx.main[i]["setCode"], "count": int(k)} for i, k in enumerate(counts) if k > 0]
        players.append({"drafter": dr.kind, "seat": s, "leaders": [idx.leaders[L]["setCode"] for L in dr.leaders],
                        "deck": {"metadata": {"name": ""}, "leader": {"id": idx.leaders[L]["setCode"], "count": 1},
                                 "base": {"id": idx.bases[B]["setCode"], "count": 1}, "deck": deck}, "picks": picks[s]})
    return players


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", default="SOR")
    ap.add_argument("--cards", default="/mnt/project-files/deckbuild/cards.json")
    ap.add_argument("--pods", type=int, default=10)
    ap.add_argument("--drafters", default="stat,rarity,random,stat")
    ap.add_argument("--builder", default="stat", choices=["stat", "model"])
    ap.add_argument("--model", default=None)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--tag", default="d")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    idx = DN.CardIndex(a.cards)
    sp = SetPool(idx, a.set)
    score = stat_scores(idx)
    model = DN.DeckModel(a.model, idx) if a.model else None
    kinds = a.drafters.split(",")
    pods = []
    for p in range(a.pods):
        rng = np.random.default_rng([a.seed, p])
        seats = [kinds[(s + p) % len(kinds)] for s in range(8)]
        drafters = [Drafter(k, idx, sp, score, model=model, rng=rng) for k in seats]
        players = run_pod(sp, drafters, rng, a.builder, model)
        for pl in players:
            pl["deck"]["metadata"]["name"] = f"{a.tag}{a.seed}-{p}-{pl['seat']}:{pl['drafter']}"
        pods.append({"seed": a.seed, "pod": p, "players": players})
        print(f"  pod {p}: " + ", ".join(f"{pl['drafter']}={pl['deck']['leader']['id']}" for pl in players), file=sys.stderr)
    with open(a.out, "w") as fh:
        json.dump({"set": a.set, "drafters": kinds, "builder": a.builder, "model": a.model, "pods": pods}, fh)
    print(f"{len(pods)} pods -> {a.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
