"""Fine-tune the JEPA predictor on branch data (bot/jepa/branches.js): many moves from the same position.

    python3 bot/jepa/branch_train.py --model bot/jepa/models/jepa-v1.safetensors --branches data/branch/rush-random data/branch/rush-rush \
        --data data/jepa/mix-v1.npz --out bot/jepa/models/jepa-v1b

The encoder and the value head stay frozen, so latents and targets are computed once. The predictor and the action
encoder learn from two batches per step:
  branch rows   ‖ẑ_h(a) − z(x_h(a))‖² plus, weighted by --w-diff, the same error after subtracting each position's mean
                over its moves: the part that tells moves apart, which a plain mean-squared error drowns in the shared
                part (most of a future does not depend on my move)
  recorded rows the original JEPA loss on recorded games, so prompts that branches cannot cover (targets, cards,
                resources: the engine rolls back only at action windows) keep their predictions
Before and after, on held-out games: how well V(ẑ_h(a)) ranks the moves of a position against V(z(x_h(a))) of the real
futures (top-1 agreement, median Spearman, spread), the yardstick of the oracle test in README.md.
"""
import argparse
import glob
import gzip
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import features as F  # noqa: E402
import model as M  # noqa: E402

K = 12  # most moves per branch point (branches.js --max-branch)


def encode_many(net, msgs, db, chunk=2048):
    zs = []
    for k in range(0, len(msgs), chunk):
        es = [F.encode(m, db) for m in msgs[k:k + chunk]]
        zs.append(net.encode(np.stack([e["state"] for e in es]), np.stack([e["tok_ids"] for e in es]).astype(np.int64),
                             np.stack([e["tok_feats"] for e in es]).astype(np.float32), np.stack([e["tok_mask"] for e in es]).astype(np.float32)))
    return np.concatenate(zs) if zs else np.zeros((0, M.D), np.float32)


def load_branches(dirs, net, db):
    """Arrays for every branch point: root latent, per-move action features, target latents and masks, padded to K."""
    roots, rows, games = [], [], []
    for d in dirs:
        for f in sorted(glob.glob(os.path.join(d, "*.jsonl.gz"))):
            with gzip.open(f, "rt") as fh:
                for line in fh:
                    o = json.loads(line)
                    if o["t"] == "b" and len(o["br"]) > 1:
                        roots.append(o)
    print(f"{len(roots)} branch points", file=sys.stderr)
    P = len(roots)
    out = {"z": np.zeros((P, M.D), np.float32), "act": np.zeros((P, K, F.ACTION_DIM), np.float32), "aid": np.zeros((P, K), np.int64),
           "t1": np.zeros((P, K, M.D), np.float32), "t4": np.zeros((P, K, M.D), np.float32), "m1": np.zeros((P, K), np.float32),
           "m4": np.zeros((P, K), np.float32), "over": np.full((P, K), -1.0, np.float32), "game": np.zeros(P, np.int64)}
    out["z"] = encode_many(net, roots, db)
    h1, h1_at, h4, h4_at = [], [], [], []
    for p, o in enumerate(roots):
        e = F.encode(o, db)
        out["game"][p] = o["seed"]
        for k, b in enumerate(o["br"][:K]):
            out["act"][p, k] = e["actions"][b["i"]]
            out["aid"][p, k] = e["aids"][b["i"]]
            if b.get("h1"):
                h1.append(b["h1"])
                h1_at.append((p, k))
            if b.get("h4"):
                h4.append(b["h4"])
                h4_at.append((p, k))
            if b.get("over") in ("p1", "p2"):
                out["over"][p, k] = 1.0 if b["over"] == o["you"] else 0.0
    for msgs, at, t, m in ((h1, h1_at, "t1", "m1"), (h4, h4_at, "t4", "m4")):
        z = encode_many(net, msgs, db)
        for (p, k), zz in zip(at, z):
            out[t][p, k] = zz
            out[m][p, k] = 1.0
    # a move that ends the game before the target has no latent to reach; its outcome is still a fact
    return out


def recorded_latents(net, d, rows, chunk=8192):
    """z, z(+1), z(+4), m4 for recorded rows (encoder frozen, so computed once)."""
    def enc(r):
        return net.encode(d["state"][r], d["tok_ids"][r].astype(np.int64), d["tok_feats"][r].astype(np.float32), d["tok_mask"][r].astype(np.float32))
    zs, y1s, y4s = [], [], []
    for k in range(0, len(rows), chunk):
        r = rows[k:k + chunk]
        n1, n4 = d["nxt1"][r], d["nxt4"][r]
        zs.append(enc(r))
        y1s.append(enc(n1))
        y4s.append(enc(np.where(n4 >= 0, n4, n1)))
    return {"z": np.concatenate(zs), "y1": np.concatenate(y1s), "y4": np.concatenate(y4s), "m4": (d["nxt4"][rows] >= 0).astype(np.float32),
            "act": d["act"][rows].astype(np.float32), "aid": d["aid"][rows].astype(np.int64)}


def spearman(a, b):
    ra, rb = np.argsort(np.argsort(a)), np.argsort(np.argsort(b))
    if ra.std() == 0 or rb.std() == 0:
        return None
    return float(np.corrcoef(ra, rb)[0, 1])


def yardstick(net, B, idx):
    """Imagined V(ẑ_h(a)) against real V(z(x_h(a))) over the moves of each held-out branch point."""
    res = {}
    for h, t, m in ((1, "t1", "m1"), (4, "t4", "m4")):
        top, chance, rho, sp_im, sp_re = [], [], [], [], []
        for p in idx:
            ok = np.flatnonzero(B[m][p] > 0)
            if len(ok) < 2:
                continue
            av = net.action(B["act"][p, ok], B["aid"][p, ok])
            im = M.sigmoid(net.value(net.predict(B["z"][p:p + 1], av, h)))
            re = M.sigmoid(net.value(B[t][p, ok]))
            best_re = set(np.flatnonzero(re >= re.max() - 1e-6))
            best_im = np.flatnonzero(im >= im.max() - 1e-6)
            top.append(np.mean([i in best_re for i in best_im]))
            chance.append(len(best_re) / len(re))
            r = spearman(im, re)
            if r is not None:
                rho.append(r)
            sp_im.append(im.std())
            sp_re.append(re.std())
        res[f"h{h}"] = {"points": len(top), "top1": float(np.mean(top)), "chance": float(np.mean(chance)),
                        "rho_median": float(np.median(rho)), "spread_imagined": float(np.median(sp_im)), "spread_real": float(np.median(sp_re))}
    return res


def show(tag, ys):
    for h, v in ys.items():
        print(f"  {tag} {h}: top-1 {v['top1']:.3f} (chance {v['chance']:.3f})  median rho {v['rho_median']:.2f}  spread imagined {v['spread_imagined'] * 100:.1f} / real {v['spread_real'] * 100:.1f} pts  ({v['points']} points)", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--branches", nargs="+", required=True)
    ap.add_argument("--data", help="recorded games (data.py npz) mixed in; none = branches only")
    ap.add_argument("--recorded", type=int, default=300000, help="recorded rows sampled from --data")
    ap.add_argument("--out", required=True)
    ap.add_argument("--steps", type=int, default=4000)
    ap.add_argument("--groups", type=int, default=64, help="branch points per batch")
    ap.add_argument("--batch", type=int, default=512, help="recorded rows per batch")
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--w-diff", type=float, default=4.0)
    ap.add_argument("--w-recorded", type=float, default=1.0)
    ap.add_argument("--holdout", type=float, default=0.1)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--cache", help="npz cache of the encoded branches (built when missing)")
    a = ap.parse_args()

    w, meta = M.load_safetensors(a.model)
    net = M.NumpyJepa(w)
    db = F.load_cards()
    t0 = time.time()
    if a.cache and os.path.exists(a.cache):
        B = dict(np.load(a.cache))
    else:
        B = load_branches(a.branches, net, db)
        if a.cache:
            np.savez(a.cache, **B)
    print(f"branches encoded ({time.time() - t0:.0f}s): {len(B['z'])} points, {int(B['m1'].sum())} h1 and {int(B['m4'].sum())} h4 targets", file=sys.stderr)
    rng = np.random.default_rng(a.seed)
    games = np.unique(B["game"])
    held_games = set(rng.choice(games, max(1, int(len(games) * a.holdout)), replace=False).tolist())
    held = np.array([p for p in range(len(B["z"])) if B["game"][p] in held_games])
    train = np.array([p for p in range(len(B["z"])) if B["game"][p] not in held_games])
    before = yardstick(net, B, held)
    show("before", before)

    R = None
    if a.data and a.w_recorded > 0:
        with np.load(a.data) as z:  # each access to an npz member reads it whole, so read the needed ones once
            d = {k: z[k] for k in ("state", "tok_ids", "tok_feats", "tok_mask", "act", "aid", "nxt1", "nxt4")}
        ok = np.flatnonzero(d["nxt1"] >= 0)
        rows = np.sort(rng.choice(ok, min(a.recorded, len(ok)), replace=False))
        R = recorded_latents(net, d, rows)
        print(f"recorded rows encoded ({time.time() - t0:.0f}s): {len(rows)}", file=sys.stderr)

    from tinygrad import Tensor, nn, TinyJit
    from tinygrad.helpers import Context
    heads = ["act1.w", "act1.b", "act2.w", "act2.b", "p1.w", "p1.b", "p2.w", "p2.b", "p3.w", "p3.b"]
    P = {k: Tensor(w[k].copy()) for k in heads}
    E = {k: Tensor(w[k]) for k in M.EMB_TABLES}  # card embedding tables stay frozen
    opt = nn.optim.AdamW([P[k] for k in heads], lr=a.lr, weight_decay=1e-3)
    G, Bn = a.groups, a.batch
    lin = lambda name, x: x.matmul(P[name + ".w"]) + P[name + ".b"]

    def predict(z, act, aid, hot):
        av = lin("act2", lin("act1", act.cat(M.embed(E, aid), dim=-1)).relu()).relu()
        return z + lin("p3", lin("p2", lin("p1", z.cat(av, hot, dim=-1)).relu()).relu())

    def hot(n, h):
        x = np.zeros((n, len(M.HORIZONS)), np.float32)
        x[:, M.HORIZONS.index(h)] = 1.0
        return Tensor(x)

    hb1, hb4, hr1, hr4 = hot(G * K, 1), hot(G * K, 4), hot(Bn, 1), hot(Bn, 4)

    def branch_loss(pred, tgt, m):
        # pred, tgt [G*K, D]; m [G, K]
        pred = pred.reshape(G, K, M.D)
        tgt = tgt.reshape(G, K, M.D)
        mm = m.unsqueeze(-1)
        n = m.sum()
        plain = (((pred - tgt) ** 2).mean(-1) * m).sum() / n.maximum(1.0)
        cnt = mm.sum(1, keepdim=True).maximum(1.0)
        cp = pred - (pred * mm).sum(1, keepdim=True) / cnt
        ct = tgt - (tgt * mm).sum(1, keepdim=True) / cnt
        diff = (((cp - ct) ** 2).mean(-1) * m).sum() / n.maximum(1.0)
        return plain, diff

    def losses(b):
        z = b["z"].unsqueeze(1).expand(G, K, M.D).reshape(G * K, M.D)
        act, aid = b["act"].reshape(G * K, F.ACTION_DIM), b["aid"].reshape(G * K)
        p1, d1 = branch_loss(predict(z, act, aid, hb1), b["t1"].reshape(G * K, M.D), b["m1"])
        p4, d4 = branch_loss(predict(z, act, aid, hb4), b["t4"].reshape(G * K, M.D), b["m4"])
        total = p1 + p4 + a.w_diff * (d1 + d4)
        rec = Tensor(0.0)
        if R is not None:
            q1 = predict(b["rz"], b["ract"], b["raid"], hr1)
            q4 = predict(b["rz"], b["ract"], b["raid"], hr4)
            rec = ((q1 - b["ry1"]) ** 2).mean() + (((q4 - b["ry4"]) ** 2).mean(-1) * b["rm4"]).sum() / b["rm4"].sum().maximum(1.0)
            total = total + a.w_recorded * rec
        return total, Tensor.stack(p1, d1, p4, d4, rec)

    @TinyJit
    def step(b):
        with Context(TRAINING=1):
            opt.zero_grad()
            total, parts = losses(b)
            total.backward()
            opt.step()
            return parts.realize()

    def batch(ps):
        b = {k: Tensor(B[k][ps]) for k in ("z", "act", "t1", "t4", "m1", "m4")}
        b["aid"] = Tensor(B["aid"][ps].astype(np.int32))
        if R is not None:
            r = rng.choice(len(R["z"]), Bn, replace=False)
            b.update({"rz": Tensor(R["z"][r]), "ract": Tensor(R["act"][r]), "raid": Tensor(R["aid"][r].astype(np.int32)),
                      "ry1": Tensor(R["y1"][r]), "ry4": Tensor(R["y4"][r]), "rm4": Tensor(R["m4"][r])})
        return b

    curve = []
    best = None
    t1 = time.time()
    for it in range(1, a.steps + 1):
        parts = step(batch(rng.choice(train, G, replace=False))).numpy()
        if it % 250 == 0 or it == a.steps:
            for k in heads:
                w[k] = P[k].numpy()
            ys = yardstick(net, B, held)
            score = ys["h1"]["rho_median"] + ys["h4"]["rho_median"]
            curve.append({"step": it, "loss": [float(x) for x in parts], "held": ys})
            print(f"step {it} ({time.time() - t1:.0f}s): branch h1 {parts[0]:.4f} diff {parts[1]:.4f} h4 {parts[2]:.4f} diff {parts[3]:.4f} recorded {parts[4]:.4f}", file=sys.stderr)
            show("held", ys)
            if best is None or score > best[0]:
                best = (score, it, {k: w[k].copy() for k in heads}, ys)
    for k, v in best[2].items():
        w[k] = v
    print(f"best at step {best[1]}", file=sys.stderr)
    show("after", best[3])
    meta = {**meta, "branch_ft": json.dumps({"from": os.path.basename(a.model), "branches": a.branches, "w_diff": a.w_diff, "w_recorded": a.w_recorded, "best_step": best[1]})}
    M.save_safetensors(a.out + ".safetensors", w, meta)
    with open(a.out + ".train.json", "w") as fh:
        json.dump({"args": vars(a), "before": before, "after": best[3], "best_step": best[1], "curve": curve,
                   "points": {"train": int(len(train)), "held": int(len(held))}}, fh, separators=(",", ":"))
    print(f"wrote {a.out}.safetensors", file=sys.stderr)


if __name__ == "__main__":
    main()
