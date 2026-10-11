"""Trains the SWU JEPA in tinygrad.

    python3 bot/jepa/train.py --data data/jepa/mix-v1.npz --out bot/jepa/models/jepa-v1 [--steps 6000] [--batch 512]

Writes <out>.safetensors (online encoder + heads + probes; what the bot loads), <out>.train.json (config,
curves, held-out metrics) next to it.

Losses (see model.py for the layers):
  pred  ||ẑ_h - sg(Ē(x_{t+h}))||^2 for h in {1, 4} own decisions ahead      the JEPA objective
  var   hinge on the batch std of each latent dim (VICReg), keeps z from collapsing to a point
  cov   off-diagonal covariance of z (VICReg), spreads information over dims
The target encoder Ē is an EMA of the online encoder and gets no gradient.
Stage 2 then fits the value head V (BCE against "the deciding seat won") on frozen latents z, ẑ_1, ẑ_4,
early-stopped on held-out games; it is what scores imagined futures at play time (see train_value).
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


def latent_rows(npj, d, rows, chunk=4096):
    """numpy: (z, ẑ_1, ẑ_4) for rows, using the chosen action."""
    zs, p1s, p4s = [], [], []
    for k in range(0, len(rows), chunk):
        r = rows[k:k + chunk]
        z = npj.encode(d["state"][r], d["tok_ids"][r].astype(np.int64), d["tok_feats"][r].astype(np.float32), d["tok_mask"][r].astype(np.float32))
        av = npj.action(d["act"][r], d["aid"][r].astype(np.int64))
        for h, out in ((1, p1s), (4, p4s)):
            hz = np.zeros((len(r), len(M.HORIZONS)), np.float32)
            hz[:, M.HORIZONS.index(h)] = 1.0
            out.append(z + npj.lin("p3", M.relu(npj.lin("p2", M.relu(npj.lin("p1", np.concatenate([z, av, hz], -1)))))))
        zs.append(z)
    return np.concatenate(zs), np.concatenate(p1s), np.concatenate(p4s)


def train_value(a, d, npj, w, train_idx, held_idx, rng):
    """Stage 2: the value head V on frozen latents, early-stopped on held-out games.

    Training V together with the encoder let it memorise game outcomes (a deck's leader and base nearly name a
    training game): held-out value loss was best after 500 steps and then rose, while the JEPA loss kept
    improving. So the encoder learns only from the self-supervised JEPA loss, and V is fitted afterwards on
    current latents and on the predictor's imagined ones (what it scores at play time).
    """
    t0 = time.time()
    tr = rng.choice(train_idx, min(300000, len(train_idx)), replace=False)
    he = rng.choice(held_idx, min(60000, len(held_idx)), replace=False)
    zt = np.concatenate(latent_rows(npj, d, tr))
    yt = np.tile(d["win"][tr].astype(np.float32), 3)
    zh = np.concatenate(latent_rows(npj, d, he))
    yh = np.tile(d["win"][he].astype(np.float32), 3)
    print(f"value stage: {len(zt)} train / {len(zh)} held-out latents in {time.time() - t0:.0f}s", file=sys.stderr)
    vp = {k: Tensor(w[k]) for k in ("v1.w", "v1.b", "v2.w", "v2.b")}
    # fresh init
    vr = np.random.default_rng(a.seed + 7)
    for k in ("v1.w", "v2.w"):
        sh = w[k].shape
        vp[k] = Tensor((vr.uniform(-1, 1, sh) * np.sqrt(6.0 / (sh[0] + sh[1]))).astype(np.float32))
    for k in ("v1.b", "v2.b"):
        vp[k] = Tensor(np.zeros_like(w[k]))
    opt = nn.optim.AdamW(list(vp.values()), lr=1e-3, weight_decay=1e-2)
    V = lambda z: (z.matmul(vp["v1.w"]) + vp["v1.b"]).relu().matmul(vp["v2.w"])[:, 0] + vp["v2.b"][0]
    B = 2048

    @TinyJit
    def vstep(z, y):
        with Context(TRAINING=1):
            opt.zero_grad()
            l = bce(V(z.dropout(0.1)), y)
            l.backward()
            opt.step()
            return l.realize()

    def held_metrics():
        logit = (np.maximum(zh @ vp["v1.w"].numpy() + vp["v1.b"].numpy(), 0) @ vp["v2.w"].numpy())[:, 0] + vp["v2.b"].numpy()[0]
        loss = float(np.mean(np.maximum(logit, 0) - logit * yh + np.log1p(np.exp(-np.abs(logit)))))
        n = len(he)
        acc = [float(((logit[k * n:(k + 1) * n] > 0) == (yh[k * n:(k + 1) * n] > 0.5)).mean()) for k in range(3)]
        return loss, acc

    best, curve = None, []
    for it in range(1, a.value_steps + 1):
        idx = rng.integers(0, len(zt), B)
        vstep(Tensor(zt[idx]), Tensor(yt[idx])).numpy()
        if it % 100 == 0:
            loss, acc = held_metrics()
            curve.append({"step": it, "held_bce": loss, "acc_z": acc[0], "acc_pred1": acc[1], "acc_pred4": acc[2]})
            if best is None or loss < best[0]:
                best = (loss, it, {k: v.numpy().copy() for k, v in vp.items()}, acc)
    w.update(best[2])
    print(f"value head: best held-out BCE {best[0]:.4f} at step {best[1]}, accuracy on z / ẑ1 / ẑ4: "
          + " / ".join(f"{x:.3f}" for x in best[3]) + f" ({time.time() - t0:.0f}s)", file=sys.stderr)
    return {"best_step": best[1], "held_bce": best[0], "acc_z": best[3][0], "acc_pred1": best[3][1], "acc_pred4": best[3][2], "curve": curve}


def train_value_predictor(a, d, net, train_idx, held_idx, rng):
    """Stage 2, "predictor" mode: fine-tune the predictor, action encoder and V together, encoder frozen.

    The value loss goes through the predictor (V(P(z, a)) against the outcome) while the JEPA loss keeps the
    predictor pointed at the target latents, as in EfficientZero's value-plus-consistency training. The frozen
    encoder cannot memorise games; early stopping on held-out V(ẑ_1) guards the heads.
    """
    t0 = time.time()
    heads = [k for k in M.HEADS]
    opt = nn.optim.AdamW([net.p[k] for k in heads], lr=3e-4, weight_decay=1e-3)
    B = a.batch
    h1 = Tensor(np.tile(np.array([[1.0, 0.0]], np.float32), (B, 1)))
    h4 = Tensor(np.tile(np.array([[0.0, 1.0]], np.float32), (B, 1)))
    frozen = {k: net.p[k].detach() for k in M.ENCODER}

    def parts(b):
        z = net.encode(frozen, b["x_state"], b["x_tid"], b["x_tf"], b["x_tm"]).detach()
        y1 = net.encode(net.t, b["y1_state"], b["y1_tid"], b["y1_tf"], b["y1_tm"]).detach()
        y4 = net.encode(net.t, b["y4_state"], b["y4_tid"], b["y4_tf"], b["y4_tm"]).detach()
        w = net.p
        av = net.lin(w, "act2", net.lin(w, "act1", b["act"].cat(M.embed(frozen, b["aid"]), dim=-1)).relu()).relu()
        p1 = net.predict(z, av, h1)
        p4 = net.predict(z, av, h4)
        l_p = ((p1 - y1) ** 2).mean() + (((p4 - y4) ** 2).mean(axis=1) * b["m4"]).sum() / b["m4"].sum().maximum(1.0)
        win = b["win"]
        v1 = bce(net.value(p1), win)
        l_v = bce(net.value(z), win) + v1 + 0.5 * bce(net.value(p4), win)
        return l_p, l_v, v1

    @TinyJit
    def step(b):
        with Context(TRAINING=1):
            opt.zero_grad()
            l_p, l_v, v1 = parts(b)
            (l_p + a.w_value_ft * l_v).backward()
            opt.step()
            return Tensor.stack(l_p, l_v, v1).realize()

    @TinyJit
    def held(b):
        l_p, l_v, v1 = parts(b)
        return Tensor.stack(l_p, l_v, v1).realize()

    to_t = lambda b: {k: Tensor(v) for k, v in b.items()}
    erng = np.random.default_rng(2)
    eval_batches = [erng.choice(held_idx, B, replace=False) for _ in range(16)]
    best, curve = None, []
    for it in range(1, a.value_steps + 1):
        step(to_t(batch_arrays(d, rng.choice(train_idx, B, replace=False)))).numpy()
        if it % 100 == 0:
            hv = np.mean([held(to_t(batch_arrays(d, eb))).numpy() for eb in eval_batches], axis=0)
            curve.append({"step": it, "held_pred": float(hv[0]), "held_value": float(hv[1]), "held_bce_pred1": float(hv[2])})
            if best is None or hv[2] < best[0]:
                best = (float(hv[2]), it, {k: net.p[k].numpy().copy() for k in heads}, hv)
            if it % 500 == 0:
                print(f"  value-ft step {it}: held pred {hv[0]:.4f} value {hv[1]:.4f} V(ẑ1) {hv[2]:.4f}", file=sys.stderr)
    for k, v in best[2].items():
        net.p[k].assign(Tensor(v)).realize()
    print(f"value fine-tune: best held-out BCE of V(ẑ1) {best[0]:.4f} at step {best[1]} ({time.time() - t0:.0f}s)", file=sys.stderr)
    return {"mode": "predictor", "best_step": best[1], "held_bce": best[0], "held_pred": float(best[3][0]), "curve": curve}


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
    ap.add_argument("--w-value", type=float, default=0.0, help="value loss during stage 1 (0 = pure self-supervised encoder)")
    ap.add_argument("--value-steps", type=int, default=3000, help="stage 2: value head on frozen latents")
    ap.add_argument("--value-mode", choices=["frozen", "predictor"], default="frozen",
                    help="stage 2: fit V alone on frozen latents, or fine-tune predictor + action encoder + V together")
    ap.add_argument("--w-value-ft", type=float, default=1.0, help="value weight in predictor-mode stage 2")
    ap.add_argument("--init", help="start from this model file (with --steps 0: run stage 2 only)")
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

    params = init_params(rng)
    if a.init:
        loaded, _ = M.load_safetensors(a.init)
        params.update({k: v for k, v in loaded.items() if k in params})
        print(f"initialised from {a.init}", file=sys.stderr)
    net = TgJepa(params)
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
        # "nothing changes" baseline measured in the target space: how far apart Ē(now) and Ē(next) are
        y0 = net.encode(net.t, b["x_state"], b["x_tid"], b["x_tf"], b["x_tm"])
        copyt = ((y0 - y1) ** 2).mean()
        return Tensor.stack(total, *parts, top1, top1c, vacc, copyt).realize()

    def to_t(b):
        return {k: Tensor(v) for k, v in b.items()}

    names = ["total", "pred1", "pred4", "var", "cov", "value", "copy1"]
    curve, evals = [], []
    erng = np.random.default_rng(1)
    eval_batches = [erng.choice(held_idx, a.batch, replace=False) for _ in range(8)]
    t1 = time.time()
    acc = np.zeros(len(names))
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
            row = {"step": it, **{k: float(v) for k, v in zip(names + ["retrieval_top1", "retrieval_top1_copy", "value_acc", "copy1_target"], vals)}}
            evals.append(row)
            print("  held-out " + " ".join(f"{k}={v:.4f}" for k, v in row.items() if k != "step"), file=sys.stderr)

    if a.value_mode == "predictor":
        value_info = train_value_predictor(a, d, net, train_idx, held_idx, rng)
    w = {k: v.numpy().copy() for k, v in net.p.items()}
    npj = M.NumpyJepa(w)
    if a.value_mode == "frozen":
        value_info = train_value(a, d, npj, w, train_idx, held_idx, rng)

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
            "curve": curve, "evals": evals, "probes": probes, "map": latent_map, "value": value_info, "framework": "tinygrad"}
    with open(a.out + ".train.json", "w") as fh:
        json.dump(info, fh, indent=1)
    print(f"wrote {a.out}.safetensors in {time.time() - t0:.0f}s", file=sys.stderr)


if __name__ == "__main__":
    main()
