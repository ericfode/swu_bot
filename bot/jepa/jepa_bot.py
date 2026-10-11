#!/usr/bin/env python3
"""JEPA bot: plays over the stdio protocol (spec/stdio-protocol.md) by planning in a learned latent space.

    python3 bot/jepa/jepa_bot.py --model bot/jepa/models/jepa-v1.safetensors [--mix 0.5] [--temp 0] [--name jepa]

For each decision: z = E(observation); for every legal action a, imagine the latent future ẑ_1 = z + P(z, a, 1)
(my next decision) and ẑ_4 (four of my decisions later), and score a by the value head on those imagined
latents: score = (1 - mix) * V(ẑ_1) + mix * V(ẑ_4). The move with the best score is played. Nothing is decoded
back into a board: the plan lives entirely in the embedding space, as in a JEPA.

Inference is numpy only (the weights were trained in tinygrad, see train.py). Logs go to stderr.
SWU_JEPA_THOUGHTS=<file> writes the latest decision (scores, imagined board read back by linear probes,
2-D latent map coordinates) for the research dashboard panel (bot/jepa/panel.py).
"""
import argparse
import json
import os
import random
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import features as F  # noqa: E402
import model as M  # noqa: E402


def log(*a):
    print("jepa:", *a, file=sys.stderr, flush=True)


class JepaPlayer:
    def __init__(self, model_path, db, mix=0.5, temp=0.0, seed=0):
        w, self.meta = M.load_safetensors(model_path)
        self.net = M.NumpyJepa(w)
        self.db = db
        self.mix = mix
        self.temp = temp
        self.rng = random.Random(seed)
        self.seen = {}

    def new_game(self, seed):
        self.rng = random.Random(seed)
        self.seen = {}

    def think(self, msg):
        e = F.encode(msg, self.db)
        z = self.net.encode(e["state"][None], e["tok_ids"][None].astype(np.int64), e["tok_feats"][None], e["tok_mask"][None])
        a = self.net.action(e["actions"], e["aids"].astype(np.int64))
        z1 = self.net.predict(z, a, 1)
        z4 = self.net.predict(z, a, 4)
        v1 = M.sigmoid(self.net.value(z1))
        v4 = M.sigmoid(self.net.value(z4))
        score = (1 - self.mix) * v1 + self.mix * v4
        return {"z": z[0], "z1": z1, "z4": z4, "v1": v1, "v4": v4, "score": score, "v0": float(M.sigmoid(self.net.value(z))[0])}

    def choose(self, msg):
        n = len(msg.get("actions") or [])
        if n <= 1:
            return 0, None
        t = self.think(msg)
        score = t["score"].astype(np.float64)
        # loop guard: if this exact observation keeps coming back, stop repeating the same pick
        key = hash(json.dumps([msg.get("prompt"), msg.get("state"), [x.get("label") for x in msg["actions"]]], sort_keys=True))
        tried = self.seen.setdefault(key, [])
        order = list(np.argsort(-score))
        if self.temp > 0:
            p = np.exp((score - score.max()) / self.temp)
            p /= p.sum()
            pick = int(self.rng.choices(range(n), weights=p.tolist())[0])
        else:
            pick = int(order[0])
        if len(tried) >= 2 and pick in tried:
            fresh = [i for i in order if i not in tried]
            pick = int(fresh[0]) if fresh else int(self.rng.randrange(n))
        tried.append(pick)
        return pick, t


def thoughts_record(msg, t, pick, ms, net):
    acts = msg["actions"]
    order = np.argsort(-t["score"])[:8]
    rec = {"t": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "seq": msg.get("seq"), "you": msg.get("you"),
           "round": (msg.get("state") or {}).get("round"), "prompt": (msg.get("prompt") or {}).get("title"), "ms": round(ms, 2),
           "value_now": t["v0"], "chosen": int(pick),
           "top": [{"i": int(i), "label": acts[i].get("label"), "card": (acts[i].get("card") or {}).get("n"),
                    "v1": float(t["v1"][i]), "v4": float(t["v4"][i]), "score": float(t["score"][i])} for i in order]}
    if "probe.w" in net.w:
        now = net.probe(t["z"][None])[0]
        imag = net.probe(t["z1"][pick][None])[0]
        imag4 = net.probe(t["z4"][pick][None])[0]
        rec["probes"] = [{"name": nm, "now": float(now[k]), "next": float(imag[k]), "later": float(imag4[k])} for k, (_, nm, _) in enumerate(M.PROBES)]
    if "pca.w" in net.w:
        P = lambda z: ((z - net.w["pca.mean"]) @ net.w["pca.w"]).tolist()
        rec["map"] = {"now": P(t["z"]), "actions": [{"i": int(i), "label": acts[i].get("label"), "xy1": P(t["z1"][i]), "xy4": P(t["z4"][i]),
                                                       "score": float(t["score"][i])} for i in order]}
    return rec


def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument("--model", default=os.path.join(here, "models", "jepa-v1.safetensors"))
    ap.add_argument("--mix", type=float, default=0.5, help="weight of the 4-decision horizon in the score")
    ap.add_argument("--temp", type=float, default=0.0, help="softmax temperature over scores; 0 = best move")
    ap.add_argument("--name", default="jepa")
    a = ap.parse_args()

    db = F.load_cards()
    log(f"{len(db)} card codes, model {a.model}")
    player = JepaPlayer(a.model, db, a.mix, a.temp)
    thoughts = os.environ.get("SWU_JEPA_THOUGHTS")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        t = msg.get("t")
        if t == "hello":
            player.new_game(msg.get("seed", 0))
            out = {"t": "ready", "v": 1, "name": a.name}
        elif t == "decide":
            t0 = time.perf_counter()
            pick, th = player.choose(msg)
            ms = (time.perf_counter() - t0) * 1000
            out = {"t": "act", "i": pick}
            if thoughts and th is not None:
                try:
                    tmp = thoughts + ".tmp"
                    with open(tmp, "w") as fh:
                        json.dump(thoughts_record(msg, th, pick, ms, player.net), fh)
                    os.replace(tmp, thoughts)
                except OSError as err:
                    log("thoughts:", err)
        else:
            continue
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
