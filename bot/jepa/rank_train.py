"""Train the JEPA's value head to rank moves, on data from bot/jepa/rank_data.js.

The planner keeps the move whose settled position the value head scores highest, so what matters for play is the
order of the positions reached from one window, not who wins in general. Each window in the data holds the teacher's
settled position (a strong bot's real move) and the settled positions of the other lines the planner would try.
The value head is trained with a softmax over each window's positions to put the teacher's first, plus an outcome
term on the teacher's position. The encoder is frozen (v1's), so only V changes. By default the softmax also holds
the positions the planner scores without V (an ended game, a move that changed nothing); that orders moves best on
held-out games but lets V's level drift, so V stops being a win estimate. --live-only --w-outcome 1 keeps it one.

    python3 bot/jepa/rank_train.py prep --data data/rank/v1 --out data/jepa/rank-v1.npz [--eval linear-deck-g4]
    python3 bot/jepa/rank_train.py fit --data data/jepa/rank-v1.npz --out bot/jepa/models/jepa-v1k

prep encodes every position with the encoder (z) and, with --eval, scores the held-out windows with a bot/eval
evaluator as a yardstick. fit writes <out>.safetensors (the input model with a new value head) and <out>.train.json.
Metrics on held-out games: "move top-1" is how often the planner's pick (best line per move, as jepa_bot.py does)
is the teacher's move; "line top-1" is how often the teacher's position scores first among all positions.
"""
import argparse
import glob
import gzip
import json
import math
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import features as F  # noqa: E402
import model as M  # noqa: E402

WAIT_PROMPT = {"type": "actionWindow", "actionWindow": True, "selectCardMode": None, "selected": []}
FIXED_LOGIT = 7.0  # an ended game or a move that changed nothing: the planner scores these 1 / 0 without V


def held_games(n_games, frac=0.1, seed=0):
    rng = np.random.default_rng(seed)
    return set(rng.choice(np.arange(n_games), max(1, int(n_games * frac)), replace=False).tolist())


def prep(a):
    here = os.path.dirname(os.path.abspath(__file__))
    net = M.NumpyJepa(M.load_safetensors(a.model)[0])
    db = F.load_cards()
    helper = None
    if a.eval:
        from jepa_bot import EvalHelper  # noqa: E402
        helper = EvalHelper(a.eval)
    files = sorted(glob.glob(os.path.join(a.data, "shard-*.jsonl.gz")))
    games = []  # (src, decks, winner)
    windows = []  # per window: (game, you, main, leaf rows)
    for f in files:
        with gzip.open(f, "rt", encoding="utf8") as fh:
            game = None
            try:
                for line in fh:
                    o = json.loads(line)
                    if o["t"] == "game":
                        game = {"src": o["src"], "decks": o.get("decks"), "winner": None, "windows": []}
                        games.append(game)
                    elif o["t"] == "w":
                        game["windows"].append(o)
                    elif o["t"] == "end":
                        game["winner"] = o["winner"]
            except (EOFError, OSError, ValueError):
                pass  # a run stopped while writing its last game: keep the whole games before it
            if games and games[-1]["winner"] is None:
                games.pop()
    held = held_games(len(games))
    t0 = time.time()
    Z, rows, wins = [], [], []
    pending, pend_rows = [], []

    def flush():
        if not pending:
            return
        es = [F.encode(m, db) for m in pending]
        z = net.encode(np.stack([e["state"] for e in es]), np.stack([e["tok_ids"] for e in es]).astype(np.int64),
                       np.stack([e["tok_feats"] for e in es]), np.stack([e["tok_mask"] for e in es]))
        for r, zz in zip(pend_rows, z):
            r["z"] = len(Z)
            Z.append(zz.astype(np.float32))
        pending.clear()
        pend_rows.clear()

    for gi, g in enumerate(games):
        flat = None
        if helper is not None and (a.eval_all or gi in held) and g["decks"]:
            flat = {s: [c["id"] for c in g["decks"][s].get("deck") or [] for _ in range(int(c.get("count", 1)))] for s in ("p1", "p2")}
        for w in g["windows"]:
            you, main, main_path = w["you"], w["main"], w.get("mainPath") or [w["main"]]
            opp = "p2" if you == "p1" else "p1"
            leaves = [(main, True, w["teacher"])]
            own = None
            for alt in w["alts"]:
                p = alt["path"]
                if p == main_path or (len(main_path) == 1 and p[0] == main):
                    own = alt["leaf"]  # the teacher's own move played on by random choices
                    continue
                leaves.append((p[0], False, alt["leaf"]))
            if a.teacher_line == "alt":
                # the teacher's position from the same random play as the other lines, so only the move differs
                if own is None:
                    continue
                leaves[0] = (main, True, own)
            first = len(rows)
            ev_states, ev_act, ev_rows = [], [], []
            for root, teacher, leaf in leaves:
                r = {"w": len(wins), "root": root, "teacher": teacher, "fixed": math.nan, "z": -1, "ev": math.nan}
                if "over" in leaf:
                    r["fixed"] = 1.0 if leaf["over"] == you else 0.5 if leaf["over"] in ("draw", None) else 0.0
                elif leaf.get("noop"):
                    r["fixed"] = 0.0
                else:
                    if leaf.get("mine"):
                        msg = {"you": you, "prompt": leaf["prompt"], "state": leaf["state"], "actions": leaf["actions"]}
                    else:
                        msg = {"you": you, "prompt": WAIT_PROMPT, "state": leaf["state"], "actions": w["root"]["actions"]}
                    pending.append(msg)
                    pend_rows.append(r)
                    if flat is not None:
                        ev_states.append(leaf["state"])
                        ev_act.append(you if leaf.get("mine") else opp if (leaf["state"] or {}).get("phase") == "action" else None)
                        ev_rows.append(r)
                rows.append(r)
            if ev_rows:
                for r, lg in zip(ev_rows, helper.logits(you, flat, ev_states, ev_act)):
                    r["ev"] = float(lg)
            wins.append((gi, 1.0 if g["winner"] == you else 0.0, first, len(rows)))
            if len(pending) >= 2048:
                flush()
        if gi % 200 == 0:
            print(f"{gi}/{len(games)} games, {len(wins)} windows, {len(rows)} positions, {time.time() - t0:.0f}s", flush=True)
    flush()
    np.savez_compressed(
        a.out,
        Z=np.stack(Z).astype(np.float16),
        leaf_w=np.array([r["w"] for r in rows], np.int32), leaf_root=np.array([r["root"] for r in rows], np.int32),
        leaf_teacher=np.array([r["teacher"] for r in rows], np.bool_), leaf_fixed=np.array([r["fixed"] for r in rows], np.float32),
        leaf_z=np.array([r["z"] for r in rows], np.int32), leaf_ev=np.array([r["ev"] for r in rows], np.float32),
        win_game=np.array([x[0] for x in wins], np.int32), win_won=np.array([x[1] for x in wins], np.float32),
        win_lo=np.array([x[2] for x in wins], np.int32), win_hi=np.array([x[3] for x in wins], np.int32),
        held=np.array(sorted(held), np.int32), n_games=np.int32(len(games)),
    )
    print(f"wrote {a.out}: {len(games)} games, {len(wins)} windows, {len(rows)} positions ({len(Z)} encoded) in {time.time() - t0:.0f}s")


class Data:
    def __init__(self, path):
        d = np.load(path)
        self.Z = d["Z"].astype(np.float32)
        for k in ("leaf_w", "leaf_root", "leaf_teacher", "leaf_fixed", "leaf_z", "leaf_ev", "win_game", "win_won", "win_lo", "win_hi"):
            setattr(self, k, d[k])
        held = set(d["held"].tolist())
        self.is_held = np.array([g in held for g in self.win_game])


def window_logits(data, w, v):
    """Logits of every position of window w: V for encoded positions, fixed for ended games and no-op moves."""
    lo, hi = data.win_lo[w], data.win_hi[w]
    fx = data.leaf_fixed[lo:hi]
    live = np.isnan(fx)
    out = np.where(live, 0.0, (np.nan_to_num(fx) * 2 - 1) * FIXED_LOGIT)
    out[live] = v[data.leaf_z[lo:hi][live]]
    return out


def pick(data, w, lg):
    """The planner's move in window w for these logits: the move of its best line."""
    roots = data.leaf_root[data.win_lo[w]:data.win_hi[w]]
    best = {}
    for k, r in enumerate(roots):
        if r not in best or lg[k] > best[r]:
            best[r] = lg[k]
    return max(best, key=best.get)


def metrics(data, wins, v, ref=None):
    """Move top-1 (planner's pick = best line per move), line top-1, softmax loss; v = logit per encoded position.
    With ref (another scorer's logit per encoded position), also how often the two scorers pick the same move."""
    move = line = same = 0
    ce = 0.0
    for w in wins:
        lo, hi = data.win_lo[w], data.win_hi[w]
        lg = window_logits(data, w, v)
        t = np.flatnonzero(data.leaf_teacher[lo:hi])[0]
        line += int(np.argmax(lg) == t)
        move += int(pick(data, w, lg) == data.leaf_root[lo + t])
        if ref is not None:
            same += int(pick(data, w, lg) == pick(data, w, window_logits(data, w, ref)))
        m = lg.max()
        ce += -(lg[t] - m - math.log(np.exp(lg - m).sum()))
    n = max(len(wins), 1)
    out = {"move_top1": round(move / n, 4), "line_top1": round(line / n, 4), "ce": round(float(ce) / n, 4), "n": len(wins)}
    if ref is not None:
        out["same_as_eval"] = round(same / n, 4)
    return out


def fit(a):
    data = Data(a.data)
    w0, meta = M.load_safetensors(a.model)
    H = w0["v1.w"].shape[1] if a.hidden == 0 else a.hidden
    rng = np.random.default_rng(a.seed)
    if a.hidden == 0:
        P = {k: w0[k].copy() for k in ("v1.w", "v1.b", "v2.w", "v2.b")}
    else:
        P = {"v1.w": rng.normal(0, 1 / math.sqrt(M.D), (M.D, H)).astype(np.float32), "v1.b": np.zeros(H, np.float32),
             "v2.w": rng.normal(0, 1 / math.sqrt(H), (H, 1)).astype(np.float32), "v2.b": np.zeros(1, np.float32)}
    value = lambda Z, P: (np.maximum(Z @ P["v1.w"] + P["v1.b"], 0) @ P["v2.w"] + P["v2.b"])[:, 0]
    train = np.flatnonzero(~data.is_held)
    if a.live_only:
        # The planner scores an ended game 1 or 0 and a no-op 0 without V, and any live position between them, so V
        # only has to order the live positions: train on those, in windows where the teacher's position is live.
        # With the fixed positions in the softmax (the default), a teacher's winning move pulls every live V down,
        # so V orders positions but is no longer a win estimate.
        teacher_live = np.array([np.isnan(data.leaf_fixed[lo:hi][data.leaf_teacher[lo:hi]][0]) for lo, hi in zip(data.win_lo, data.win_hi)])
        train = train[teacher_live[train]]
    held = np.flatnonzero(data.is_held)
    # a check on held windows only needs V of their positions
    held_z = np.unique(np.concatenate([data.leaf_z[data.win_lo[w]:data.win_hi[w]] for w in held]))
    held_z = held_z[held_z >= 0]

    def vall(P):
        v = np.zeros(len(data.Z), np.float32)
        v[held_z] = value(data.Z[held_z], P)
        return v

    ref = None
    if np.isfinite(data.leaf_ev).any():
        # the evaluator's logit per encoded position, where prep scored it: held windows it scored all of become the check
        ev = np.full(len(data.Z), np.nan, np.float32)
        ok = data.leaf_z >= 0
        ev[data.leaf_z[ok]] = data.leaf_ev[ok]
        scored = lambda w: np.isfinite(ev[data.leaf_z[data.win_lo[w]:data.win_hi[w]][data.leaf_z[data.win_lo[w]:data.win_hi[w]] >= 0]]).all()
        held = np.array([w for w in held if scored(w)])
        ref = np.nan_to_num(ev)
        if a.target == "eval":
            train = np.array([w for w in train if scored(w)])
    elif a.target == "eval":
        sys.exit("--target eval needs data prepped with --eval and --eval-all")
    goal = "same_as_eval" if a.target == "eval" else "move_top1"
    log = {"args": vars(a), "windows": {"train": int(len(train)), "held": int(len(held))}, "curve": []}
    base = metrics(data, held, vall(P), ref)
    log["start"] = base
    print(f"start ({'v1 value head' if a.hidden == 0 else 'random head'}): {base}", flush=True)
    if ref is not None:
        log["evaluator"] = metrics(data, held, ref)
        print(f"evaluator (scored in prep) on {len(held)} held windows: {log['evaluator']}", flush=True)
    m = {k: np.zeros_like(x) for k, x in P.items()}
    s = {k: np.zeros_like(x) for k, x in P.items()}
    step = 0
    best = (base[goal], {k: x.copy() for k, x in P.items()}, 0)
    for ep in range(a.epochs):
        rng.shuffle(train)
        for b0 in range(0, len(train), a.batch):
            bw = train[b0:b0 + a.batch]
            idx = np.concatenate([np.arange(data.win_lo[w], data.win_hi[w]) for w in bw])
            seg = np.concatenate([np.full(data.win_hi[w] - data.win_lo[w], k) for k, w in enumerate(bw)])
            fx = data.leaf_fixed[idx]
            live = np.isnan(fx)
            if a.live_only:
                idx, seg, fx, live = idx[live], seg[live], fx[live], live[live]
            Zb = data.Z[data.leaf_z[idx][live]]
            h_pre = Zb @ P["v1.w"] + P["v1.b"]
            h = np.maximum(h_pre, 0)
            lg = np.where(live, 0.0, (np.nan_to_num(fx) * 2 - 1) * FIXED_LOGIT)
            lg[live] = (h @ P["v2.w"] + P["v2.b"])[:, 0]
            # softmax within each window
            mx = np.full(len(bw), -np.inf)
            np.maximum.at(mx, seg, lg)
            e = np.exp(lg - mx[seg])
            sm = np.zeros(len(bw))
            np.add.at(sm, seg, e)
            p = e / sm[seg]
            teach = data.leaf_teacher[idx]
            if a.target == "eval":
                # copy the evaluator: cross-entropy against its win probability at every live position
                g = np.zeros(len(idx))
                g[live] = (1 / (1 + np.exp(-lg[live])) - 1 / (1 + np.exp(-ref[data.leaf_z[idx][live]]))) * len(bw) / max(live.sum(), 1)
            else:
                g = p - teach  # d(softmax CE)/d logit, per position
                # outcome term on the teacher's position: keeps V a win estimate
                won = data.win_won[bw][seg]
                g = g + a.w_outcome * teach * (1 / (1 + np.exp(-lg)) - won)
            gv = g[live] / len(bw)
            grads = {"v2.w": h.T @ gv[:, None], "v2.b": np.array([gv.sum()], np.float32)}
            dh = (gv[:, None] @ P["v2.w"].T) * (h_pre > 0)
            grads["v1.w"] = Zb.T @ dh + a.l2 * P["v1.w"]
            grads["v1.b"] = dh.sum(0)
            step += 1
            for k in P:
                m[k] = 0.9 * m[k] + 0.1 * grads[k]
                s[k] = 0.999 * s[k] + 0.001 * grads[k] ** 2
                P[k] -= (a.lr * (m[k] / (1 - 0.9 ** step)) / (np.sqrt(s[k] / (1 - 0.999 ** step)) + 1e-8)).astype(np.float32)
        r = metrics(data, held, vall(P), ref)
        r["epoch"] = ep + 1
        log["curve"].append(r)
        print(f"epoch {ep + 1}: {r}", flush=True)
        if r[goal] > best[0]:
            best = (r[goal], {k: x.copy() for k, x in P.items()}, ep + 1)
    log["best_epoch"] = best[2]
    log["best"] = next((c for c in log["curve"] if c["epoch"] == best[2]), base)
    w = dict(w0)
    w.update(best[1])
    M.save_safetensors(a.out + ".safetensors", w, {**meta, "value": "rank_train.py", "rank_data": a.data})
    with open(a.out + ".train.json", "w") as fh:
        json.dump(log, fh, indent=1)
    print(f"wrote {a.out}.safetensors (best epoch {best[2]}: {goal} {best[0]:.3f}, start {base[goal]:.3f})")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    here = os.path.dirname(os.path.abspath(__file__))
    p = sub.add_parser("prep")
    p.add_argument("--data", default="data/rank/v1")
    p.add_argument("--model", default=os.path.join(here, "models", "jepa-v1.safetensors"))
    p.add_argument("--out", default="data/jepa/rank-v1.npz")
    p.add_argument("--eval", default=None, help="bot/eval evaluator to score held-out windows with, as a yardstick")
    p.add_argument("--eval-all", action="store_true", help="score every window with --eval, for fit --target eval")
    p.add_argument("--teacher-line", choices=["real", "alt"], default="real",
                   help="the teacher's position: where the real game settled, or its move played on by random choices like the other lines")
    f = sub.add_parser("fit")
    f.add_argument("--data", default="data/jepa/rank-v1.npz")
    f.add_argument("--model", default=os.path.join(here, "models", "jepa-v1.safetensors"))
    f.add_argument("--out", default=os.path.join(here, "models", "jepa-v1k"))
    f.add_argument("--epochs", type=int, default=20)
    f.add_argument("--batch", type=int, default=256, help="windows per step")
    f.add_argument("--lr", type=float, default=1e-3)
    f.add_argument("--l2", type=float, default=1e-4)
    f.add_argument("--w-outcome", type=float, default=0.3)
    f.add_argument("--hidden", type=int, default=0, help="0: fine-tune the model's value head; N: a new head with N hidden units")
    f.add_argument("--seed", type=int, default=0)
    f.add_argument("--live-only", action="store_true", help="softmax over live positions only, which keeps V a win estimate")
    f.add_argument("--target", choices=["rank", "eval"], default="rank",
                   help="rank: put the teacher's position first; eval: copy the evaluator's scores (prep with --eval-all)")
    a = ap.parse_args()
    prep(a) if a.cmd == "prep" else fit(a)


if __name__ == "__main__":
    main()
