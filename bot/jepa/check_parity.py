"""Checks that the numpy forward pass (what the bot runs) matches the tinygrad one (what was trained).

    python3 bot/jepa/check_parity.py --model bot/jepa/models/jepa-v1.safetensors --data data/jepa/mix-v1.npz
"""
import argparse
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import model as M  # noqa: E402
from tinygrad import Tensor  # noqa: E402
from train import TgJepa  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--data", required=True)
    a = ap.parse_args()
    w, _ = M.load_safetensors(a.model)
    d = np.load(a.data)
    idx = np.arange(0, min(len(d["win"]), 256 * 97), 97)[:256]
    st, tid, tf, tm = d["state"][idx], d["tok_ids"][idx].astype(np.int32), d["tok_feats"][idx].astype(np.float32), d["tok_mask"][idx].astype(np.float32)
    act, aid = d["act"][idx], d["aid"][idx].astype(np.int32)
    npj = M.NumpyJepa(w)
    z = npj.encode(st, tid, tf, tm)
    av = npj.action(act, aid)
    hz = np.tile([[1.0, 0.0]], (len(idx), 1)).astype(np.float32)
    p1 = z + npj.lin("p3", M.relu(npj.lin("p2", M.relu(npj.lin("p1", np.concatenate([z, av, hz], -1))))))
    v = npj.value(p1)
    tg = TgJepa({k: v_ for k, v_ in w.items() if k in M.ENCODER or k in M.HEADS})
    tz = tg.encode(tg.p, Tensor(st), Tensor(tid), Tensor(tf), Tensor(tm))
    tp1 = tg.predict(tz, tg.action(Tensor(act), Tensor(aid)), Tensor(hz))
    tv = tg.value(tp1).numpy()
    err = max(np.abs(tz.numpy() - z).max(), np.abs(tp1.numpy() - p1).max(), np.abs(tv - v).max())
    # the per-action path the bot uses (one z broadcast over all actions) must agree with the batched one
    zr = np.repeat(z[:1], 5, 0)
    batched = zr + npj.lin("p3", M.relu(npj.lin("p2", M.relu(npj.lin("p1", np.concatenate([zr, av[:5], hz[:5]], -1))))))
    err = max(err, np.abs(npj.predict(z[:1], av[:5], 1) - batched).max())
    print(f"max abs difference numpy vs tinygrad: {err:.2e}")
    sys.exit(0 if err < 1e-3 else 1)


if __name__ == "__main__":
    main()
