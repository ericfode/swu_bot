"""Trains the SWU JEPA in tinygrad.

    python3 bot/jepa/train.py --data data/jepa/mix-v1.npz --out bot/jepa/models/jepa-v1 [--steps 6000] [--batch 512]

Writes <out>.safetensors (online encoder + heads + probes; what the bot loads), <out>.train.json (config,
curves, held-out metrics) next to it.

Losses (see model.py for the layers):
  pred  ||ẑ_h - sg(Ē(x_{t+h}))||^2 for h in {1, 4} own decisions ahead      the JEPA objective
  var   hinge on the batch std of each latent dim (VICReg), keeps z from collapsing to a point
  cov   off-diagonal covariance of z (VICReg), spreads information over dims
  value BCE of V(z) and V(sg(ẑ_h)) against "the deciding seat won"         grounds the latent, scores plans
The target encoder Ē is an EMA of the online encoder and gets no gradient.
"""
import argparse
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import features as F  # noqa: E402
import model as M  # noqa: E402
from tinygrad import Context, Tensor, TinyJit, nn  # noqa: E402


def init_params(rng):
    p = {}
    for name, shape in {**M.ENCODER, **M.HEADS}.items():
        if name in M.EMB_TABLES:
            p[name] = rng.normal(0, 0.1, shape).astype(np.float32)
        elif name.endswith(".w"):
            p[name] = (rng.uniform(-1, 1, shape) * np.sqrt(6.0 / (shape[0] + shape[1]))).astype(np.float32)
        else:
            p[name] = np.zeros(shape, np.float32)
    return p


class TgJepa:
    def __init__(self, params):
        self.p = {k: Tensor(v) for k, v in params.items()}
        # target encoder: EMA copy, no grad
        self.t = {k: Tensor(params[k].copy()).is_param_(False) for k in M.ENCODER}

    @staticmethod
    def lin(w, name, x):
        return x.matmul(w[name + ".w"]) + w[name + ".b"]

    def encode(self, w, state, tok_ids, tok_feats, tok_mask):
        e = M.embed(w, tok_ids)
        h = self.lin(w, "tok1", tok_feats.cat(e, dim=-1)).relu()
        h = self.lin(w, "tok2", h).relu()
        m = tok_mask.unsqueeze(-1)
        cnt = m.sum(1)
        mean = (h * m).sum(1) / cnt.maximum(1.0)
        mx = (h + (m - 1.0) * 1e4).max(1) * (cnt > 0).float()
        return self.lin(w, "st2", self.lin(w, "st1", state.cat(mean, mx, dim=-1)).relu())

    def action(self, act, aid):
        w = self.p
        return self.lin(w, "act2", self.lin(w, "act1", act.cat(M.embed(w, aid), dim=-1)).relu()).relu()

    def predict(self, z, a, hz):
        w = self.p
        x = z.cat(a, hz, dim=-1)
        return z + self.lin(w, "p3", self.lin(w, "p2", self.lin(w, "p1", x).relu()).relu())

    def value(self, z):
        return self.lin(self.p, "v2", self.lin(self.p, "v1", z).relu())[:, 0]


def bce(logit, y):
    return (logit.maximum(0) - logit * y + (-(logit.abs())).exp().add(1).log()).mean()


def batch_arrays(d, idx):
    """numpy -> dict of float/int arrays for rows idx, their +1 and +4 successors."""
    out = {}
    n1 = d["nxt1"][idx]
    n4 = d["nxt4"][idx]
    m4 = (n4 >= 0).astype(np.float32)
    n4 = np.where(n4 >= 0, n4, n1)
    for tag, rows in (("x", idx), ("y1", n1), ("y4", n4)):
        out[tag + "_state"] = d["state"][rows]
        out[tag + "_tid"] = d["tok_ids"][rows].astype(np.int32)
        out[tag + "_tf"] = d["tok_feats"][rows].astype(np.float32)
        out[tag + "_tm"] = d["tok_mask"][rows].astype(np.float32)
    out["act"] = d["act"][idx]
    out["aid"] = d["aid"][idx].astype(np.int32)
    out["win"] = d["win"][idx].astype(np.float32)
    out["m4"] = m4
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--steps", type=int, default=6000)
    ap.add_argument("--batch", type=int, default=512)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--ema", type=float, default=0.995)
    ap.add_argument("--w-var", type=float, default=1.0)
    ap.add_argument("--w-cov", type=float, default=0.04)
    ap.add_argument("--w-value", type=float, default=0.5)
    ap.add_argument("--token-dropout", type=float, default=0.15)
    ap.add_argument("--holdout", type=float, default=0.1)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--eval-every", type=int, default=500)
    a = ap.parse_args()

    t0 = time.time()
    raw = np.load(a.data)
    d = {k: raw[k] for k in raw.files if k != "bot"}
    bots = raw["bot"] if "bot" in raw.files else None
    n = len(d["win"])
    rng = np.random.default_rng(a.seed)
    games = np.unique(d["game"])
    held = set(rng.choice(games, max(1, int(len(games) * a.holdout)), replace=False).tolist())
    is_held = np.isin(d["game"], list(held))
    ok = d["nxt1"] >= 0
    train_idx = np.where(ok & ~is_held)[0]
    held_idx = np.where(ok & is_held)[0]
    print(f"loaded {n} decisions ({len(games)} games) in {time.time() - t0:.0f}s; train {len(train_idx)}, held-out {len(held_idx)}", file=sys.stderr)

    net = TgJepa(init_params(rng))
    opt = nn.optim.AdamW(list(net.p.values()), lr=a.lr, weight_decay=1e-4)
    h1 = Tensor(np.tile(np.array([[1.0, 0.0]], np.float32), (a.batch, 1)))
    h4 = Tensor(np.tile(np.array([[0.0, 1.0]], np.float32), (a.batch, 1)))

    def losses(b):
        z = net.encode(net.p, b["x_state"], b["x_tid"], b["x_tf"], b["x_tm"])
        y1 = net.encode(net.t, b["y1_state"], b["y1_tid"], b["y1_tf"], b["y1_tm"]).detach()
        y4 = net.encode(net.t, b["y4_state"], b["y4_tid"], b["y4_tf"], b["y4_tm"]).detach()
        av = net.action(b["act"], b["aid"])
        p1 = net.predict(z, av, h1)
        p4 = net.predict(z, av, h4)
        l_p1 = ((p1 - y1) ** 2).mean()
        l_p4 = (((p4 - y4) ** 2).mean(axis=1) * b["m4"]).sum() / b["m4"].sum().maximum(1.0)
        zc = z - z.mean(axis=0)
        std = (zc.square().mean(axis=0) + 1e-4).sqrt()
        l_var = (1.0 - std).relu().mean()
        cov = zc.T.matmul(zc) / (a.batch - 1)
        l_cov = (cov.square().sum() - (cov * Tensor.eye(M.D)).square().sum()) / M.D
        win = b["win"]
        l_v = bce(net.value(z), win) + bce(net.value(p1.detach()), win) + 0.5 * bce(net.value(p4.detach()), win)
        # identity baseline: how far the next latent is from the current one (the predictor must beat this)
        l_copy = ((z.detach() - y1) ** 2).mean()
        total = l_p1 + l_p4 + a.w_var * l_var + a.w_cov * l_cov + a.w_value * l_v
        return total, [l_p1, l_p4, l_var, l_cov, l_v, l_copy]

    @TinyJit
    def step(b):
        with Context(TRAINING=1):
            opt.zero_grad()
            total, parts = losses(b)
            total.backward()
            opt.step()
            for k in M.ENCODER:
                net.t[k].assign(net.t[k] * a.ema + net.p[k].detach() * (1.0 - a.ema))
            Tensor.realize(*[net.t[k] for k in M.ENCODER])
            return Tensor.stack(total, *parts).realize()

    @TinyJit
    def evaluate(b):
        total, parts = losses(b)
        z = net.encode(net.p, b["x_state"], b["x_tid"], b["x_tf"], b["x_tm"])
        y1 = net.encode(net.t, b["y1_state"], b["y1_tid"], b["y1_tf"], b["y1_tm"])
        p1 = net.predict(z, net.action(b["act"], b["aid"]), h1)
        # retrieval: is the true next latent the nearest of all next latents in the batch?
        dist = (p1.unsqueeze(1) - y1.unsqueeze(0)).square().sum(-1)
        top1 = (dist.argmin(axis=1) == Tensor.arange(a.batch)).float().mean()
        distc = (z.unsqueeze(1) - y1.unsqueeze(0)).square().sum(-1)
        top1c = (distc.argmin(axis=1) == Tensor.arange(a.batch)).float().mean()
        vacc = ((net.value(z) > 0).float() == b["win"]).float().mean()
        return Tensor.stack(total, *parts, top1, top1c, vacc).realize()

    def to_t(b):
        return {k: Tensor(v) for k, v in b.items()}

    names = ["total", "pred1", "pred4", "var", "cov", "value", "copy1"]
    curve, evals = [], []
    erng = np.random.default_rng(1)
    eval_batches = [erng.choice(held_idx, a.batch, replace=False) for _ in range(8)]
    t1 = time.time()
    acc = np.zeros(len(names))
    best = None
    for it in range(1, a.steps + 1):
        idx = rng.choice(train_idx, a.batch, replace=False)
        b = batch_arrays(d, idx)
        b["x_tm"] *= rng.random(b["x_tm"].shape) >= a.token_dropout  # online view only: drop some card tokens
        out = step(to_t(b)).numpy()
        acc += out
        if it % 100 == 0:
            row = {"step": it, **{k: float(v / 100) for k, v in zip(names, acc)}}
            curve.append(row)
            acc[:] = 0
            el = time.time() - t1
            print(f"step {it} {el:.0f}s ({it / el:.1f} it/s) " + " ".join(f"{k}={row[k]:.4f}" for k in names), file=sys.stderr)
        if it % a.eval_every == 0 or it == a.steps:
            vals = np.mean([evaluate(to_t(batch_arrays(d, eb))).numpy() for eb in eval_batches], axis=0)
            row = {"step": it, **{k: float(v) for k, v in zip(names + ["retrieval_top1", "retrieval_top1_copy", "value_acc"], vals)}}
            evals.append(row)
            print("  held-out " + " ".join(f"{k}={v:.4f}" for k, v in row.items() if k != "step"), file=sys.stderr)
            # keep the checkpoint with the best held-out value loss: the value head is what scores plans, and it
            # can memorise game outcomes from the decks (leaders and bases nearly identify a training game)
            if best is None or row["value"] < best[0]:
                best = (row["value"], it, {k: v.numpy().copy() for k, v in net.p.items()})

    # linear probes on target-encoder latents of held-out-free training rows (readable meaning of z)
    w = best[2]
    print(f"using the step {best[1]} checkpoint (held-out value loss {best[0]:.4f})", file=sys.stderr)
    npj = M.NumpyJepa(w)
    pidx = rng.choice(train_idx, min(20000, len(train_idx)), replace=False)
    hidx = rng.choice(held_idx, min(5000, len(held_idx)), replace=False)

    def latents(rows):
        zs = []
        for k in range(0, len(rows), 2048):
            r = rows[k:k + 2048]
            zs.append(npj.encode(d["state"][r], d["tok_ids"][r].astype(np.int64), d["tok_feats"][r].astype(np.float32), d["tok_mask"][r].astype(np.float32)))
        return np.concatenate(zs)

    cols = [c for c, _, _ in M.PROBES]
    scale = np.array([s for _, _, s in M.PROBES], np.float32)
    Z = latents(pidx)
    Y = d["state"][pidx][:, cols] * scale
    Zb = np.concatenate([Z, np.ones((len(Z), 1), np.float32)], 1)
    sol = np.linalg.solve(Zb.T @ Zb + 1e-2 * np.eye(Zb.shape[1]), Zb.T @ Y)
    Zh = latents(hidx)
    Yh = d["state"][hidx][:, cols] * scale
    pred = np.concatenate([Zh, np.ones((len(Zh), 1), np.float32)], 1) @ sol
    r2 = 1.0 - ((pred - Yh) ** 2).sum(0) / np.maximum(((Yh - Yh.mean(0)) ** 2).sum(0), 1e-6)
    w["probe.w"] = sol[:-1].astype(np.float32)
    w["probe.b"] = sol[-1].astype(np.float32)
    # 2-D map of the latent space (PCA) for the dashboard, plus a sample of held-out positions on it
    mu = Z.mean(0)
    _, sv, vt = np.linalg.svd(Z - mu, full_matrices=False)
    w["pca.mean"] = mu.astype(np.float32)
    w["pca.w"] = vt[:2].T.astype(np.float32)
    explained = (sv[:2] ** 2 / (sv ** 2).sum()).tolist()
    ms = rng.choice(len(hidx), min(600, len(hidx)), replace=False)
    xy = (Zh[ms] - mu) @ w["pca.w"]
    vh = M.sigmoid(npj.value(Zh[ms]))
    latent_map = {"explained": explained, "points": [[round(float(p[0]), 3), round(float(p[1]), 3), int(d["win"][hidx[k]]), round(float(v), 3),
                                                       round(float(d["state"][hidx[k]][2 * F.SIDE + F.HAND] * 20), 1)]
                                                      for p, k, v in zip(xy, ms, vh)], "fields": ["x", "y", "won", "value", "round"]}
    probes = [{"name": nm, "r2": float(v)} for (_, nm, _), v in zip(M.PROBES, r2)]
    print("probe R^2 (held-out): " + ", ".join(f"{p['name']} {p['r2']:.2f}" for p in probes), file=sys.stderr)

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    meta = {"format": "swu-jepa/1", "D": M.D, "horizons": list(M.HORIZONS), "state_dim": F.STATE_DIM, "action_dim": F.ACTION_DIM, "token_dim": F.TOKEN_DIM}
    M.save_safetensors(a.out + ".safetensors", w, meta)
    info = {**meta, "data": a.data, "decisions": int(n), "games": int(len(games)), "train_rows": int(len(train_idx)), "held_rows": int(len(held_idx)),
            "bots": sorted(set(bots.tolist())) if bots is not None else None, "args": vars(a), "seconds": round(time.time() - t0),
            "curve": curve, "evals": evals, "probes": probes, "map": latent_map, "best_step": best[1], "framework": "tinygrad"}
    with open(a.out + ".train.json", "w") as fh:
        json.dump(info, fh, indent=1)
    print(f"wrote {a.out}.safetensors in {time.time() - t0:.0f}s", file=sys.stderr)


if __name__ == "__main__":
    main()
