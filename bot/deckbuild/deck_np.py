"""Card index, deck features and the numpy forward pass of the deck models (deck_jepa.py trains them).

numpy only, so builders and drafters run without tinygrad.
"""
import json

import numpy as np

D = 64
SIZE_NORM = 50.0
ASPECTS = ["vigilance", "command", "aggression", "cunning", "villainy", "heroism"]
TYPES = ["unit", "event", "upgrade"]
COSTS = 9  # 0..7, 8+
MIX = COSTS + len(TYPES) + 2  # cost, type and arena mix of the main deck
EXTRA = MIX + 2  # + size / 50, aspect-penalty icons per card


def relu(x):
    return np.maximum(x, 0)


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


class CardIndex:
    """Every card a deck may use, with printed features. Reprint codes map to the card's own code."""

    def __init__(self, path):
        with open(path) as fh:
            raw = json.load(fh)
        self.main, self.leaders, self.bases = raw["main"], raw["leaders"], raw["bases"]
        self.alias = raw.get("alias", {})
        self.pos = {c["setCode"]: i for i, c in enumerate(self.main)}
        self.lpos = {c["setCode"]: i for i, c in enumerate(self.leaders)}
        self.bpos = {c["setCode"]: i for i, c in enumerate(self.bases)}
        self.n, self.nl, self.nb = len(self.main), len(self.leaders), len(self.bases)
        kw = {}
        tr = {}
        for c in self.main + self.leaders:
            for k in c["keywords"]:
                kw[k] = kw.get(k, 0) + 1
            for t in c["traits"]:
                tr[t] = tr.get(t, 0) + 1
        self.keywords = [k for k, _ in sorted(kw.items(), key=lambda x: -x[1])[:20]]
        self.traits = [t for t, _ in sorted(tr.items(), key=lambda x: -x[1])[:40]]
        self.F = np.stack([self._main_feat(c) for c in self.main]).astype(np.float32)
        self.FL = np.stack([self._leader_feat(c) for c in self.leaders]).astype(np.float32)
        self.FB = np.stack([self._base_feat(c) for c in self.bases]).astype(np.float32)
        self.A = np.stack([self._aspects(c) for c in self.main]).astype(np.float32)
        self.AL = np.stack([self._aspects(c) for c in self.leaders]).astype(np.float32)
        self.AB = np.stack([self._aspects(c) for c in self.bases]).astype(np.float32)
        self.XM = np.stack([self._mix(c) for c in self.main]).astype(np.float32)
        self.unique = np.array([bool(c["unique"]) for c in self.main])

    def code(self, code):
        return self.alias.get(code, code)

    def _aspects(self, c):
        v = np.zeros(len(ASPECTS))
        for a in c["aspects"]:
            if a in ASPECTS:
                v[ASPECTS.index(a)] += 1
        return v

    def _multi(self, items, vocab):
        v = np.zeros(len(vocab))
        for x in items:
            if x in vocab:
                v[vocab.index(x)] = 1
        return v

    def _mix(self, c):
        v = np.zeros(MIX)
        v[min(int(c["cost"] or 0), COSTS - 1)] = 1
        v[COSTS + TYPES.index(c["type"])] = 1
        if c["type"] == "unit":
            v[COSTS + 3 + (1 if c["arena"] == "space" else 0)] = 1
        return v

    def _main_feat(self, c):
        cost = float(c["cost"] or 0)
        unit = c["type"] == "unit"
        nums = [cost / 8, (c["power"] or 0) / 8 if unit else 0, (c["hp"] or 0) / 8 if unit else 0,
                (c["upgradePower"] or 0) / 4, (c["upgradeHp"] or 0) / 4, float(c["unique"]), float(c["text"])]
        return np.concatenate([self._mix(c), nums, self._aspects(c), self._multi(c["keywords"], self.keywords),
                               self._multi(c["traits"], self.traits)])

    def _leader_feat(self, c):
        nums = [float(c["cost"] or 0) / 8, (c["power"] or 0) / 8, (c["hp"] or 0) / 8]
        return np.concatenate([nums, self._aspects(c), self._multi(c["keywords"], self.keywords), self._multi(c["traits"], self.traits)])

    def _base_feat(self, c):
        return np.concatenate([[(c["hp"] or 0) / 30, float(c["text"])], self._aspects(c)])

    def penalty_icons(self, L, B):
        """Missing aspect icons per main card for this leader and base (cached)."""
        key = (int(L), int(B))
        cache = self.__dict__.setdefault("_pen", {})
        if key not in cache:
            prov = self.AL[L] + self.AB[B]
            cache[key] = np.maximum(self.A - prov, 0).sum(1)
        return cache[key]

    def extras(self, counts, L, B):
        """counts: (rows, n) copies; L, B: (rows,) indexes -> (x = counts/50, extra)."""
        counts = np.asarray(counts, np.float32)
        total = counts.sum(1, keepdims=True)
        safe = np.maximum(total, 1.0)
        pen = np.stack([self.penalty_icons(l, b) for l, b in zip(L, B)])
        mix = counts @ self.XM / safe
        extra = np.concatenate([mix, total / SIZE_NORM, (counts * pen).sum(1, keepdims=True) / safe], 1)
        return counts / SIZE_NORM, extra.astype(np.float32)

    normalize = extras

    def deck(self, leader, base, counts, kind=None):
        L, B = self.lpos.get(self.code(leader)), self.bpos.get(self.code(base))
        if L is None or B is None:
            raise KeyError(f"unknown leader/base {leader}/{base}")
        v = np.zeros(self.n, np.float32)
        for code, k in counts.items():
            i = self.pos.get(self.code(code))
            if i is not None:
                v[i] += k
        x, extra = self.extras(v[None], [L], [B])
        return {"x": x[0], "extra": extra[0], "L": L, "B": B, "kind": kind, "counts": v}


class DeckModel:
    """numpy forward of a trained deck_jepa.py model."""

    def __init__(self, w, idx, mode=None):
        if isinstance(w, str):
            raw = np.load(w)
            mode = str(raw["mode"])
            w = {k.replace("__", "."): raw[k] for k in raw.files if k != "mode"}
        self.w, self.idx, self.mode = w, idx, mode
        if mode != "linear":
            self.emb = w["E"] + idx.F @ w["Wf"]
            self.lemb = w["EL"] + idx.FL @ w["Wlf"]
            self.bemb = w["EB"] + idx.FB @ w["Wbf"]

    def lin(self, n, x):
        return x @ self.w[n + ".w"] + self.w[n + ".b"]

    def pre(self, x, extra, L, B):
        """First-layer input of the encoder (linear in the card counts, so a swap is a vector add)."""
        return np.concatenate([x @ self.emb, self.lemb[L], self.bemb[B], extra], 1)

    def latent_from_pre(self, inp):
        return self.lin("e2", relu(self.lin("e1", inp)))

    def latent(self, x, extra, L, B):
        return self.latent_from_pre(self.pre(x, extra, L, B))

    def predict(self, z):
        return z + self.lin("p2", relu(self.lin("p1", z)))

    def value(self, z):
        return self.lin("v2", relu(self.lin("v1", z)))[:, 0]

    def g(self, za, zb):
        return self.lin("g2", relu(self.lin("g1", np.concatenate([za, zb], -1))))[..., 0]

    def lin_value(self, x, L, B):
        return x @ self.w["lw"] + self.w["ll"][L] + self.w["lb"][B]

    def matchup(self, za, zf):
        """(rows, D) decks against (m, D) field decks -> (rows, m) P(win), seat averaged out."""
        va = self.value(za)[:, None]
        vf = self.value(zf)[None, :]
        r, m = len(za), len(zf)
        A = np.repeat(za[:, None, :], m, 1)
        Fz = np.repeat(zf[None, :, :], r, 0)
        lg = va - vf + self.g(A, Fz) - self.g(Fz, A)
        return sigmoid(lg)

    def field_score(self, x, extra, L, B, zf=None, field=None, weights=None):
        """Mean predicted win rate against the field (zf latents, or `field` = (x, extra, L, B) for linear)."""
        if self.mode == "linear":
            va = self.lin_value(x, L, B)[:, None]
            vf = self.lin_value(*[field[i] for i in (0, 2, 3)])[None, :]
            p = sigmoid(va - vf)
        else:
            p = self.matchup(self.latent(x, extra, L, B), zf)
        wts = np.ones(p.shape[1]) if weights is None else np.asarray(weights, float)
        return (p * wts).sum(1) / wts.sum()
