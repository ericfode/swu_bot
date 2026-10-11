"""Deck models in tinygrad: a deck encoder, a JEPA objective on partial decks, and a matchup value.

    python3 bot/deckbuild/deck_jepa.py --runs DIR [DIR ...] --mode jepa-ft --out MODEL.npz [--steps 3000]

Data (from the JS side): cards.json (export-cards.js), deck lists (bot/decks/*.json, a run's candidates.json or
decks.jsonl) and games (results.jsonl rows from play.js: deck A against deck B, one pilot in both seats).

The model
    deck  = leader + base + a multiset of main-deck cards (counts over every card in the pool)
    s     = counts/size @ (E + F Wf)           card embeddings: a learned id vector plus printed features
                                              (cost, power, hp, arena, aspects, keywords, traits); a sum over
                                              copies (DeepSets), so a swap changes s linearly
    z     = enc([s, leader, base, curve/type/arena mix, size, aspect penalty])     the deck latent (64)
    P(A beats B) = σ(v(z_A) − v(z_B) + g(z_A, z_B) − g(z_B, z_A) ± seat)           strength plus matchup

The JEPA objective ("imagine the finished deck"): the context encoder sees a partial deck (each copy kept with
probability u ~ U(0.3, 0.9), as in a draft pool or a half-built deck) and a predictor maps its latent to the latent
an EMA target encoder gives the whole deck: ‖P(E(partial)) − sg(Ē(full))‖² + VICReg variance/covariance terms.
It needs no game results, and its predictor is what a drafter uses to score a pick by the deck it leads to.

Modes (--mode)
    linear      v = a value per card copy + per leader + per base (Bradley-Terry over decks); no matchup term
    sup         encoder and heads trained on game results only
    jepa        stage 1 JEPA only, stage 2 heads on the frozen encoder (two stages, as bot/jepa found best)
    jepa-ft     stage 1 JEPA, stage 2 heads and encoder together, the JEPA loss kept on (weight --w-jepa-ft)
Every mode early-stops on held-out decks (a share of the generated decks never seen in training).
Writes MODEL.npz (numpy weights and the card index; numpy forward in deck_np.py) and MODEL.json (metrics).
"""
import argparse
import hashlib
import json
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import deck_np as DN  # noqa: E402


# ---------------------------------------------------------------- data

def read_lists(path):
    if path.endswith(".jsonl"):
        out = []
        with open(path) as fh:
            for line in fh:
                if line.strip():
                    d = json.loads(line)
                    out.append(d)
        return out
    with open(path) as fh:
        raw = json.load(fh)
    return raw if isinstance(raw, list) else raw.get("decks", [])


def as_counts(d):
    """SWUDB list or {leader, base, cards} -> (name, leader, base, {code: n})."""
    if "cards" in d:
        c = {}
        for x in d["cards"]:
            c[x] = c.get(x, 0) + 1
        return d["name"], d["leader"], d["base"], c
    c = {}
    for e in d["deck"]:
        c[e["id"]] = c.get(e["id"], 0) + int(e["count"])
    return d["metadata"]["name"], d["leader"]["id"], d["base"]["id"], c


def load_decks(paths, idx):
    decks = {}
    for p in paths:
        if not os.path.exists(p):
            continue
        for d in read_lists(p):
            name, L, B, c = as_counts(d)
            decks[name] = idx.deck(L, B, c, kind=d.get("kind"))
    return decks


def load_picks(run_dirs, idx):
    """Draft runs (pods.json from draft.py): deck name -> the player's picks in order, as main-card indexes."""
    out = {}
    for r in run_dirs:
        f = os.path.join(r, "pods.json")
        if not os.path.exists(f):
            continue
        with open(f) as fh:
            doc = json.load(fh)
        for pod in doc["pods"]:
            for pl in pod["players"]:
                ids = [idx.pos.get(idx.code(c)) for c in pl.get("picks", [])]
                out[pl["deck"]["metadata"]["name"]] = np.array([i for i in ids if i is not None], np.int64)
    return out


def load_games(run_dirs):
    games = []
    for r in run_dirs:
        f = os.path.join(r, "results.jsonl")
        if not os.path.exists(f):
            continue
        with open(f) as fh:
            for line in fh:
                if not line.strip():
                    continue
                g = json.loads(line)
                if g.get("outcome") == "ERROR" and not g.get("winner"):
                    continue
                a_first = g["aSeat"] == "p1"
                a = g["p1"] if a_first else g["p2"]
                b = g["p2"] if a_first else g["p1"]
                s = 0.5 if not g.get("winner") else (1.0 if g["winner"] == g["aSeat"] else 0.0)
                games.append((a, b, 1.0 if a_first else -1.0, s))
    return games


def deck_paths(run_dirs, real=True):
    ps = [os.path.join(REPO, "bot/decks/ash-meta-2026-09.json")] if real else []
    for r in run_dirs:
        ps += [os.path.join(r, "candidates.json"), os.path.join(r, "decks.jsonl")]
    return ps


def held_out(name, share):
    h = int(hashlib.sha256(name.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
    return h < share


# ---------------------------------------------------------------- tinygrad model

def init_params(idx, rng, d=DN.D):
    nf, nl, nb = idx.F.shape[1], idx.FL.shape[1], idx.FB.shape[1]
    din = 3 * d + DN.EXTRA
    shapes = {
        "E": (idx.n, d), "Wf": (nf, d), "EL": (idx.nl, d), "Wlf": (nl, d), "EB": (idx.nb, d), "Wbf": (nb, d),
        "e1.w": (din, 128), "e1.b": (128,), "e2.w": (128, d), "e2.b": (d,),
        "p1.w": (d, 128), "p1.b": (128,), "p2.w": (128, d), "p2.b": (d,),
        "v1.w": (d, 64), "v1.b": (64,), "v2.w": (64, 1), "v2.b": (1,),
        "g1.w": (2 * d, 64), "g1.b": (64,), "g2.w": (64, 1), "g2.b": (1,),
        "seat": (1,),
        # linear mode
        "lw": (idx.n,), "ll": (idx.nl,), "lb": (idx.nb,),
    }
    p = {}
    for k, sh in shapes.items():
        if k in ("E", "EL", "EB"):
            p[k] = rng.normal(0, 0.05, sh)
        elif k in ("Wf", "Wlf", "Wbf"):
            p[k] = rng.normal(0, 0.05, sh)
        elif k.endswith(".w"):
            p[k] = rng.uniform(-1, 1, sh) * np.sqrt(6.0 / (sh[0] + sh[1]))
        else:
            p[k] = np.zeros(sh)
    return {k: v.astype(np.float32) for k, v in p.items()}


ENC = ["E", "Wf", "EL", "Wlf", "EB", "Wbf", "e1.w", "e1.b", "e2.w", "e2.b"]
PRED = ["p1.w", "p1.b", "p2.w", "p2.b"]
HEADS = ["v1.w", "v1.b", "v2.w", "v2.b", "g1.w", "g1.b", "g2.w", "g2.b", "seat"]
LIN = ["lw", "ll", "lb", "seat"]


def main():
    from tinygrad import Context, Tensor, TinyJit, nn

    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", nargs="+", required=True, help="run folders with results.jsonl (+ decks)")
    ap.add_argument("--cards", default="/mnt/project-files/deckbuild/cards.json")
    ap.add_argument("--mode", choices=["linear", "sup", "jepa", "jepa-ft"], default="jepa-ft")
    ap.add_argument("--out", required=True)
    ap.add_argument("--jepa-steps", type=int, default=3000)
    ap.add_argument("--steps", type=int, default=4000, help="stage 2 (outcome) steps")
    ap.add_argument("--batch", type=int, default=512)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--wd", type=float, default=1e-3)
    ap.add_argument("--ema", type=float, default=0.99)
    ap.add_argument("--w-var", type=float, default=1.0)
    ap.add_argument("--w-cov", type=float, default=0.04)
    ap.add_argument("--w-jepa-ft", type=float, default=0.3)
    ap.add_argument("--holdout", type=float, default=0.2)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--no-real", action="store_true", help="leave out the real Premier decks (draft runs)")
    ap.add_argument("--pool-ctx", type=float, default=0.7, help="share of JEPA contexts taken from draft pools")
    a = ap.parse_args()
    t0 = time.time()
    rng = np.random.default_rng(a.seed)

    idx = DN.CardIndex(a.cards)
    decks = load_decks(deck_paths(a.runs, real=not a.no_real), idx)
    games = [g for g in load_games(a.runs) if g[0] in decks and g[1] in decks]
    names = sorted(decks)
    pos = {n: i for i, n in enumerate(names)}
    X = np.stack([decks[n]["x"] for n in names]).astype(np.float32)  # counts / size
    XE = np.stack([decks[n]["extra"] for n in names]).astype(np.float32)
    picks = load_picks(a.runs, idx)
    PK = [picks.get(n) for n in names]
    LI = np.array([decks[n]["L"] for n in names])
    BI = np.array([decks[n]["B"] for n in names])
    real = {n for n in names if decks[n]["kind"] is None and ":" not in n}
    held = np.array([held_out(n, a.holdout) and n not in real for n in names])
    ga = np.array([pos[g[0]] for g in games])
    gb = np.array([pos[g[1]] for g in games])
    gs = np.array([g[2] for g in games], np.float32)
    gy = np.array([g[3] for g in games], np.float32)
    g_held = held[ga] | held[gb]
    tr = np.where(~g_held)[0]
    he = np.where(g_held)[0]
    print(f"{len(names)} decks ({held.sum()} held out), {len(games)} games: train {len(tr)}, held-out {len(he)} "
          f"({time.time() - t0:.0f}s)", file=sys.stderr)

    params = init_params(idx, rng)
    P = {k: Tensor(v) for k, v in params.items()}
    T = {k: Tensor(params[k].copy()).is_param_(False) for k in ENC}
    F, FL, FB = Tensor(idx.F), Tensor(idx.FL), Tensor(idx.FB)
    eyeL, eyeB = np.eye(idx.nl, dtype=np.float32), np.eye(idx.nb, dtype=np.float32)

    lin = lambda w, n, x: x.matmul(w[n + ".w"]) + w[n + ".b"]

    def encode(w, x, xe, lo, bo):
        s = x.matmul(w["E"] + F.matmul(w["Wf"]))
        lv = lo.matmul(w["EL"] + FL.matmul(w["Wlf"]))
        bv = bo.matmul(w["EB"] + FB.matmul(w["Wbf"]))
        return lin(w, "e2", lin(w, "e1", s.cat(lv, bv, xe, dim=-1)).relu())

    predict = lambda z: z + lin(P, "p2", lin(P, "p1", z).relu())
    value = lambda z: lin(P, "v2", lin(P, "v1", z).relu())[:, 0]
    gfun = lambda za, zb: lin(P, "g2", lin(P, "g1", za.cat(zb, dim=-1)).relu())[:, 0]

    def logit_deep(za, zb, seat):
        return value(za) - value(zb) + gfun(za, zb) - gfun(zb, za) + seat * P["seat"][0]

    def lin_value(x, lo, bo):
        return x.matmul(P["lw"].unsqueeze(1))[:, 0] + lo.matmul(P["ll"].unsqueeze(1))[:, 0] + bo.matmul(P["lb"].unsqueeze(1))[:, 0]

    def bce(lg, y):
        return (lg.maximum(0) - lg * y + (-(lg.abs())).exp().add(1).log()).mean()

    def jepa_loss(x, xe, lo, bo, xc, xec):
        zt = encode(T, x, xe, lo, bo).detach()
        zc = encode(P, xc, xec, lo, bo)
        l_pred = ((predict(zc) - zt) ** 2).mean()
        z = encode(P, x, xe, lo, bo)
        zz = z - z.mean(axis=0)
        std = (zz.square().mean(axis=0) + 1e-4).sqrt()
        l_var = (1.0 - std).relu().mean()
        cov = zz.T.matmul(zz) / (x.shape[0] - 1)
        l_cov = (cov.square().sum() - (cov * Tensor.eye(DN.D)).square().sum()) / DN.D
        return l_pred + a.w_var * l_var + a.w_cov * l_cov, l_pred

    def thin(rows):
        """Partial decks: keep each copy with probability u ~ U(0.3, 0.9). For drafted decks, most of the time the
        context is instead the player's pool after k picks (k ~ U(5, all)): cards that never made the deck
        included, which is what a drafter holds mid-draft."""
        u = rng.uniform(0.3, 0.9, (len(rows), 1))
        size = np.round(X[rows] * DN.SIZE_NORM).astype(np.int64)  # counts
        kept = rng.binomial(size, np.broadcast_to(u, size.shape)).astype(np.float32)
        for t, r in enumerate(rows):
            pk = PK[r]
            if pk is not None and len(pk) > 5 and rng.random() < a.pool_ctx:
                k = int(rng.integers(5, len(pk) + 1))
                kept[t] = np.bincount(pk[:k], minlength=idx.n).astype(np.float32)
        xc, xec = idx.normalize(kept, LI[rows], BI[rows])
        return xc, xec

    def deck_batch(rows):
        return X[rows], XE[rows], eyeL[LI[rows]], eyeB[BI[rows]]

    out = {"mode": a.mode, "decks": len(names), "held_decks": int(held.sum()), "games": len(games), "train_games": int(len(tr)),
           "held_games": int(len(he))}
    B = a.batch

    # ---- stage 1: JEPA on decks (no game results)
    if a.mode in ("jepa", "jepa-ft"):
        opt1 = nn.optim.AdamW([P[k] for k in ENC + PRED], lr=a.lr, weight_decay=1e-4)
        drows = np.where(~held)[0]
        hrows = np.where(held)[0] if held.sum() >= 8 else drows

        @TinyJit
        def jstep(x, xe, lo, bo, xc, xec):
            with Context(TRAINING=1):
                opt1.zero_grad()
                total, l_pred = jepa_loss(x, xe, lo, bo, xc, xec)
                total.backward()
                opt1.step()
                for k in ENC:
                    T[k].assign(T[k] * a.ema + P[k].detach() * (1.0 - a.ema))
                Tensor.realize(*[T[k] for k in ENC])
                return Tensor.stack(total, l_pred).realize()

        curve = []
        for it in range(1, a.jepa_steps + 1):
            rows = rng.choice(drows, B, replace=len(drows) < B)
            xc, xec = thin(rows)
            l = jstep(*[Tensor(v) for v in deck_batch(rows)], Tensor(xc), Tensor(xec)).numpy()
            if it % 250 == 0:
                hr = rng.choice(hrows, min(B, len(hrows)), replace=len(hrows) < B)
                xc, xec = thin(hr)
                x, xe, lo, bo = [Tensor(v) for v in deck_batch(hr)]
                zt = encode(T, x, xe, lo, bo)
                zp = predict(encode(P, Tensor(xc), Tensor(xec), lo, bo))
                zc = encode(T, Tensor(xc), Tensor(xec), lo, bo)
                hp = float(((zp - zt) ** 2).mean().numpy())
                copy = float(((zc - zt) ** 2).mean().numpy())
                # retrieval: is the predicted finished deck nearest to its own finished deck?
                dist = (zp.unsqueeze(1) - zt.unsqueeze(0)).square().sum(-1).numpy()
                top1 = float((dist.argmin(1) == np.arange(len(hr))).mean())
                curve.append({"step": it, "train": float(l[1]), "held_pred": hp, "held_copy": copy, "top1": top1})
                print(f"  jepa {it}: train {l[1]:.4f} held {hp:.4f} (no-predictor {copy:.4f}) top1 {top1:.3f}", file=sys.stderr)
        out["jepa"] = curve

    # ---- stage 2: game results
    if a.mode == "linear":
        keys = LIN
    elif a.mode == "jepa":
        keys = HEADS
    else:
        keys = ENC + HEADS + (PRED if a.mode == "jepa-ft" else [])
    opt2 = nn.optim.AdamW([P[k] for k in keys], lr=a.lr if a.mode != "jepa-ft" else a.lr * 0.5, weight_decay=a.wd)

    def game_logit(ia, ib, seat):
        xa, xea, loa, boa = [Tensor(v) for v in deck_batch(ia)]
        xb, xeb, lob, bob = [Tensor(v) for v in deck_batch(ib)]
        s = Tensor(seat)
        if a.mode == "linear":
            return lin_value(xa, loa, boa) - lin_value(xb, lob, bob) + s * P["seat"][0], None
        enc_w = P
        za, zb = encode(enc_w, xa, xea, loa, boa), encode(enc_w, xb, xeb, lob, bob)
        if a.mode == "jepa":
            za, zb = za.detach(), zb.detach()
        return logit_deep(za, zb, s), (xa, xea, loa, boa)

    @TinyJit
    def step2(ia_x, ia_xe, ia_l, ia_b, ib_x, ib_xe, ib_l, ib_b, seat, y, xc, xec):
        with Context(TRAINING=1):
            opt2.zero_grad()
            if a.mode == "linear":
                lg = lin_value(ia_x, ia_l, ia_b) - lin_value(ib_x, ib_l, ib_b) + seat * P["seat"][0]
                loss = bce(lg, y)
            else:
                za, zb = encode(P, ia_x, ia_xe, ia_l, ia_b), encode(P, ib_x, ib_xe, ib_l, ib_b)
                if a.mode == "jepa":
                    za, zb = za.detach(), zb.detach()
                loss = bce(logit_deep(za, zb, seat), y)
                if a.mode == "jepa-ft":
                    jl, _ = jepa_loss(ia_x, ia_xe, ia_l, ia_b, xc, xec)
                    loss = loss + a.w_jepa_ft * jl
            loss.backward()
            opt2.step()
            if a.mode == "jepa-ft":
                for k in ENC:
                    T[k].assign(T[k] * a.ema + P[k].detach() * (1.0 - a.ema))
                Tensor.realize(*[T[k] for k in ENC])
            return loss.realize()

    def held_metrics():
        lg_all = []
        for k in range(0, len(he), 4096):
            r = he[k:k + 4096]
            lg, _ = game_logit(ga[r], gb[r], gs[r])
            lg_all.append(lg.numpy())
        lg = np.concatenate(lg_all) if lg_all else np.zeros(0)
        y = gy[he]
        loss = float(np.mean(np.maximum(lg, 0) - lg * y + np.log1p(np.exp(-np.abs(lg))))) if len(lg) else float("nan")
        dec = y != 0.5
        acc = float(((lg[dec] > 0) == (y[dec] > 0.5)).mean()) if dec.any() else float("nan")
        return loss, acc

    best, curve2 = None, []
    for it in range(1, a.steps + 1):
        r = rng.choice(tr, B, replace=len(tr) < B)
        xc, xec = thin(ga[r])
        args_ = [Tensor(v) for v in deck_batch(ga[r])] + [Tensor(v) for v in deck_batch(gb[r])]
        step2(*args_, Tensor(gs[r]), Tensor(gy[r]), Tensor(xc), Tensor(xec)).numpy()
        if it % 200 == 0:
            loss, acc = held_metrics()
            curve2.append({"step": it, "held_bce": loss, "held_acc": acc})
            if best is None or loss < best[0]:
                best = (loss, it, {k: P[k].numpy().copy() for k in P}, acc, {k: T[k].numpy().copy() for k in T})
            if it % 1000 == 0:
                print(f"  outcome {it}: held BCE {loss:.4f} acc {acc:.3f}", file=sys.stderr)
    w = best[2]
    w.update({f"T.{k}": v for k, v in best[4].items()})
    out.update({"best_step": best[1], "held_bce": best[0], "held_acc": best[3], "outcome": curve2})
    # constant baseline: the held-out games' own mean
    ybar = float(gy[tr].mean())
    out["held_bce_const"] = float(np.mean(-(gy[he] * np.log(ybar) + (1 - gy[he]) * np.log(1 - ybar))))

    # per-deck check: predicted strength against the field vs observed score, held-out decks with 8+ games
    model = DN.DeckModel(w, idx, a.mode)
    fr = [pos[n] for n in names if n in real]
    zf = None if a.mode == "linear" or not fr else model.latent(X[fr], XE[fr], LI[fr], BI[fr])
    obs = {}
    for g in he:
        n = names[ga[g]]
        if held[ga[g]]:
            obs.setdefault(n, []).append(gy[g])
    hn = [n for n, v in obs.items() if len(v) >= 8]
    if len(hn) >= 5:
        rows = [pos[n] for n in hn]
        if fr:
            pred = model.field_score(X[rows], XE[rows], LI[rows], BI[rows], zf, field=(X[fr], XE[fr], LI[fr], BI[fr]))
        elif a.mode == "linear":
            pred = model.lin_value(X[rows], LI[rows], BI[rows])
        else:
            pred = model.value(model.latent(X[rows], XE[rows], LI[rows], BI[rows]))
        o = np.array([np.mean(obs[n]) for n in hn])
        rank = lambda v: np.argsort(np.argsort(v))
        out["held_deck_spearman"] = float(np.corrcoef(rank(pred), rank(o))[0, 1])
        out["held_deck_pearson"] = float(np.corrcoef(pred, o)[0, 1])
        out["held_deck_n"] = len(hn)
    np.savez(a.out, mode=np.array(a.mode), **{k.replace(".", "__"): v for k, v in w.items()})
    out["seconds"] = round(time.time() - t0)
    with open(a.out.replace(".npz", "") + ".json", "w") as fh:
        json.dump(out, fh, indent=1)
    print(json.dumps({k: v for k, v in out.items() if k not in ("jepa", "outcome")}), file=sys.stderr)


if __name__ == "__main__":
    main()
