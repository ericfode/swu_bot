#!/usr/bin/env python3
"""Compare move rankings from jepa_bot.py --log files: imagined (the bot) vs real next positions (sim-v, sim-eval).

    python3 bot/jepa/oracle_report.py jepa-h1.jsonl jepa-sim-v.jsonl ... [--json out.json]

For every logged decision with all three score lists:
  top1    the imagined best move is one of the best moves by the other score (ties count), and the chance level
  rho     Spearman correlation of the two scores over the moves of one decision (median over decisions)
  spread  standard deviation of a score over the moves of one decision (median): a predictor that ignores the move
          gives a small imagined spread next to the real one
  regret  sim-eval of the best move minus sim-eval of the move each score would pick (mean, in win probability)
"""
import argparse
import json

import numpy as np


def ranks(x):
    order = np.argsort(x, kind="stable")
    r = np.empty(len(x))
    r[order] = np.arange(len(x))
    # ties share their mean rank
    for v in np.unique(x):
        m = x == v
        if m.sum() > 1:
            r[m] = r[m].mean()
    return r


def spearman(a, b):
    ra, rb = ranks(a), ranks(b)
    if ra.std() == 0 or rb.std() == 0:
        return None
    return float(np.corrcoef(ra, rb)[0, 1])


def best_set(x, eps=1e-6):
    return set(np.flatnonzero(x >= x.max() - eps))


def summarise(recs):
    keys = ["imagined", "sim_v", "sim_eval"]
    pairs = [("imagined", "sim_v"), ("imagined", "sim_eval"), ("sim_v", "sim_eval")]
    out = {"decisions": len(recs)}
    for a, b in pairs:
        hit, chance, rho = [], [], []
        for r in recs:
            x, y = np.asarray(r[a]), np.asarray(r[b])
            bx, by = best_set(x), best_set(y)
            hit.append(len(bx & by) / len(bx))
            chance.append(len(by) / len(y))
            s = spearman(x, y)
            if s is not None:
                rho.append(s)
        out[f"{a}~{b}"] = {"top1": float(np.mean(hit)), "chance": float(np.mean(chance)),
                           "rho_median": float(np.median(rho)) if rho else None, "rho_n": len(rho)}
    for k in keys:
        out[f"spread_{k}"] = float(np.median([np.std(r[k]) for r in recs]))
        regret = []
        for r in recs:
            x, e = np.asarray(r[k]), np.asarray(r["sim_eval"])
            pick = sorted(best_set(x))
            regret.append(float(e.max() - e[pick].mean()))
        out[f"regret_{k}"] = float(np.mean(regret))
    rnd = [float(np.asarray(r["sim_eval"]).max() - np.mean(r["sim_eval"])) for r in recs]
    out["regret_random"] = float(np.mean(rnd))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("logs", nargs="+")
    ap.add_argument("--json", default=None)
    a = ap.parse_args()
    recs = []
    for f in a.logs:
        for line in open(f):
            r = json.loads(line)
            if all(k in r for k in ("imagined", "sim_v", "sim_eval")) and r["n"] > 1:
                recs.append(r)
    groups = {"all": recs, "actionWindow": [r for r in recs if r.get("prompt") == "actionWindow"],
              "other prompts": [r for r in recs if r.get("prompt") != "actionWindow"]}
    res = {g: summarise(rs) for g, rs in groups.items() if rs}
    for g, s in res.items():
        print(f"== {g}: {s['decisions']} decisions")
        for k, v in s.items():
            if isinstance(v, dict):
                rho = f"{v['rho_median']:.2f}" if v["rho_median"] is not None else "-"
                print(f"  {k:22s} top-1 agree {v['top1']:.3f} (chance {v['chance']:.3f})  median rho {rho} over {v['rho_n']}")
        print("  spread  " + "  ".join(f"{k}: {s['spread_' + k]:.4f}" for k in ("imagined", "sim_v", "sim_eval")))
        print("  regret vs sim-eval best  " + "  ".join(f"{k}: {s['regret_' + k]:.4f}" for k in ("imagined", "sim_v", "sim_eval", "random")))
    if a.json:
        json.dump(res, open(a.json, "w"), indent=1)


if __name__ == "__main__":
    main()
