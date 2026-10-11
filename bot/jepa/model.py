"""The JEPA's layers and its numpy forward pass (used by the bot at play time; training is in tinygrad, train.py).

    x (state 73 + card tokens) --encoder E--> z (D)          target encoder Ē = slow EMA copy of E
    action (62 + card id)      --action enc--> a (64)
    [z, a, horizon]            --predictor P--> ẑ_h = z + P(z, a, h)   trained so ẑ_h ≈ Ē(state h own decisions later)
    z                          --value V-----> logit "I win from here"

There is no decoder: the model never reconstructs the board, it only predicts the embedding of the future board,
which is what makes it a joint-embedding predictive architecture (LeCun 2022, I-JEPA / V-JEPA) rather than a
generative world model. The bot plans in latent space: score(a) = mix of V(ẑ_1) and V(ẑ_4).
Linear probes (ridge regression from z to readable board numbers) are fitted after training only to show
what a latent "means" on the dashboard; they play no part in choosing moves.
"""
import json
import struct

import numpy as np

import features as F

D = 96          # latent size
EMB = 16        # card identity embedding
TOK_H = 64
ACT_H = 64
PRED_H = 256
HORIZONS = (1, 4)

# name -> shape, the parameter list shared by train.py (tinygrad) and this file (numpy)
# Card identity: the shared 2048 hash buckets, embedded as the sum of three small tables indexed by different
# functions of the bucket (each bucket gets a unique triple). A full 2048-row table costs ~20x more on CPU in
# tinygrad, whose gather is a one-hot mask over the table.
EMB_TABLES = {"emb_a": 64, "emb_b": 32, "emb_c": 61}
ENCODER = {
    **{k: (n, EMB) for k, n in EMB_TABLES.items()},
    "tok1.w": (F.TOKEN_DIM + EMB, TOK_H), "tok1.b": (TOK_H,),
    "tok2.w": (TOK_H, TOK_H), "tok2.b": (TOK_H,),
    "st1.w": (F.STATE_DIM + 2 * TOK_H, 256), "st1.b": (256,),
    "st2.w": (256, D), "st2.b": (D,),
}
HEADS = {
    "act1.w": (F.ACTION_DIM + EMB, ACT_H), "act1.b": (ACT_H,),
    "act2.w": (ACT_H, ACT_H), "act2.b": (ACT_H,),
    "p1.w": (D + ACT_H + len(HORIZONS), PRED_H), "p1.b": (PRED_H,),
    "p2.w": (PRED_H, PRED_H), "p2.b": (PRED_H,),
    "p3.w": (PRED_H, D), "p3.b": (D,),
    "v1.w": (D, 64), "v1.b": (64,),
    "v2.w": (64, 1), "v2.b": (1,),
}

# readable numbers the probes read back out of a latent (index into the state vector, label, scale to units)
PROBES = [(0, "my base HP left", 30.0), (F.SIDE, "opp base HP left", 30.0), (5, "my hand", 10.0), (F.SIDE + 5, "opp hand", 10.0),
          (10, "my ground power", 20.0), (F.SIDE + 10, "opp ground power", 20.0), (11, "my space power", 20.0),
          (F.SIDE + 11, "opp space power", 20.0), (12, "my unit HP", 30.0), (F.SIDE + 12, "opp unit HP", 30.0),
          (4, "my resources", 10.0), (F.SIDE + 4, "opp resources", 10.0)]


def embed(w, ids):
    """Card identity embedding; works on numpy arrays and tinygrad Tensors alike."""
    return w["emb_a"][ids % 64] + w["emb_b"][ids // 64] + w["emb_c"][(ids * 7 + 3) % 61]


def relu(x):
    return np.maximum(x, 0.0)


def load_safetensors(path):
    with open(path, "rb") as fh:
        n = struct.unpack("<Q", fh.read(8))[0]
        header = json.loads(fh.read(n))
        buf = fh.read()
    out, meta = {}, header.pop("__metadata__", {})
    dt = {"F32": np.float32, "F16": np.float16, "I32": np.int32, "I64": np.int64}
    for k, v in header.items():
        a, b = v["data_offsets"]
        out[k] = np.frombuffer(buf[a:b], dtype=dt[v["dtype"]]).reshape(v["shape"]).astype(np.float32)
    return out, meta


def save_safetensors(path, tensors, meta=None):
    header, blobs, off = {}, [], 0
    for k, v in tensors.items():
        v = np.ascontiguousarray(v, np.float32)
        b = v.tobytes()
        header[k] = {"dtype": "F32", "shape": list(v.shape), "data_offsets": [off, off + len(b)]}
        blobs.append(b)
        off += len(b)
    if meta:
        header["__metadata__"] = {k: str(v) for k, v in meta.items()}
    h = json.dumps(header).encode()
    h += b" " * ((8 - len(h) % 8) % 8)
    with open(path, "wb") as fh:
        fh.write(struct.pack("<Q", len(h)) + h + b"".join(blobs))


class NumpyJepa:
    """Forward pass for play. `w` holds online encoder + heads (+ optional probe.w / probe.b)."""

    def __init__(self, w):
        self.w = w

    def lin(self, name, x):
        return x @ self.w[name + ".w"] + self.w[name + ".b"]

    def encode(self, state, tok_ids, tok_feats, tok_mask):
        """state [B,73], tok_ids [B,T], tok_feats [B,T,TD], tok_mask [B,T] -> z [B,D]"""
        e = embed(self.w, tok_ids)
        h = relu(self.lin("tok1", np.concatenate([tok_feats, e], -1)))
        h = relu(self.lin("tok2", h))
        m = tok_mask[..., None]
        mean = (h * m).sum(1) / np.maximum(m.sum(1), 1.0)
        mx = (h + (m - 1.0) * 1e4).max(1)
        mx = np.where(m.sum(1) > 0, mx, 0.0)
        x = np.concatenate([state, mean, mx], -1)
        return self.lin("st2", relu(self.lin("st1", x)))

    def action(self, act, aid):
        return relu(self.lin("act2", relu(self.lin("act1", np.concatenate([act, embed(self.w, aid)], -1)))))

    def predict(self, z, a, h):
        hz = np.zeros((len(a), len(HORIZONS)), np.float32)
        hz[:, HORIZONS.index(h)] = 1.0
        x = np.concatenate([np.broadcast_to(z, (len(a), z.shape[-1])), a, hz], -1)
        return z + self.lin("p3", relu(self.lin("p2", relu(self.lin("p1", x)))))

    def value(self, z):
        return self.lin("v2", relu(self.lin("v1", z)))[..., 0]

    def probe(self, z):
        if "probe.w" not in self.w:
            return None
        return z @ self.w["probe.w"] + self.w["probe.b"]


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))
