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

Oracle modes, to find the weak part (each swaps one part for a perfect stand-in; protocol v2 simulations):
  --score sim-v     play each move on the referee's copy of the game, then both seats like rush to the end of this
                    round's action phase (--judge), and score that REAL position with the same value head: a perfect
                    predictor.
  --score sim-eval  the same real next positions, scored by a bot/eval evaluator (--evaluator, default
                    linear-deck-g4) through bot/jepa/eval_helper.js: a perfect predictor and a better scorer.
  --log <file>      every decision with more than one move appends one JSON line with all three scores per move
                    (imagined, sim-v, sim-eval), whatever --score picks with.
"""
import argparse
import json
import os
import random
import subprocess
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import features as F  # noqa: E402
import model as M  # noqa: E402


def log(*a):
    print("jepa:", *a, file=sys.stderr, flush=True)


class JepaPlayer:
    def __init__(self, model_path, db, mix=0.5, temp=0.0, seed=0, score="imagined", evaluator=None, deals=1, log=None, judge="round"):
        w, self.meta = M.load_safetensors(model_path)
        self.net = M.NumpyJepa(w)
        self.db = db
        self.mix = mix
        self.temp = temp
        self.rng = random.Random(seed)
        self.seen = {}
        self.score = score
        self.evaluator = evaluator  # EvalHelper, needed by sim-eval and --log
        self.deals = deals
        self.log = log
        self.judge = judge
        self.decks = None
        self.fallbacks = 0
        self.fail = None  # why the last simulation failed

    def new_game(self, seed, hello=None):
        self.rng = random.Random(seed)
        self.seen = {}
        self.decks = None
        if hello and hello.get("deck") and hello.get("opponent"):
            you = hello.get("you", "p1")
            them = "p2" if you == "p1" else "p1"
            flat = lambda d: [c["id"] for c in d.get("deck") or [] for _ in range(int(c.get("count", 1)))]
            self.decks = {you: flat(hello["deck"]), them: flat(hello["opponent"])}

    @property
    def needs_sim(self):
        return self.score != "imagined" or self.log is not None

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

    def rush_move(self, r, target, seen):
        """A move inside a simulation for the seat to act, played like bot/players/rush.js (the training data's main
        opponent): in its action window a card from hand first, then an attack with a ready unit, then the leader,
        else pass, passing when the same window keeps coming back; attacks go at `target`'s base when it can be
        picked. Other prompts are random."""
        acts = r["actions"]
        st = r.get("state") or {}
        players = st.get("players") or {}
        opp = players.get(r["actor"]) or {}
        mine = players.get(target) or {}
        prompt = r.get("prompt") or {}
        is_pass = lambda a: a.get("kind") == "button" and str(a.get("label", "")).lower() == "pass"
        if prompt.get("actionWindow"):
            units = {u.get("id"): u for z in ("ground", "space") for u in opp.get(z) or []}
            key = (st.get("round"), opp.get("handCount"), (opp.get("res") or {}).get("ready"), (mine.get("base") or {}).get("d"),
                   sum(1 for u in units.values() if not u.get("x")))
            seen[key] = seen.get(key, 0) + 1
            passes = [a["i"] for a in acts if is_pass(a)]
            if seen[key] > 2 and passes:
                return passes[0]
            leader = (opp.get("leader") or {}).get("id")
            best, best_p = None, 0
            for a in acts:
                c = a.get("card")
                if a.get("kind") != "card" or not c or c.get("ctl") != r["actor"]:
                    continue
                if c.get("zone") == "hand":
                    info = self.db.get(c.get("s") or "")
                    p = 300 + (info.cost if info else 0)
                elif c.get("id") in units:
                    p = 200 + float(units[c["id"]].get("p") or 0)
                elif c.get("id") == leader:
                    p = 100
                else:
                    p = 0
                if p > best_p:
                    best, best_p = a["i"], p
            return best if best is not None else (passes[0] if passes else 0)
        title = f"{prompt.get('title') or ''} {prompt.get('promptTitle') or ''}".lower()
        if "attack" in title:
            base = (mine.get("base") or {}).get("id")
            cards = [a for a in acts if a.get("kind") == "card" and a.get("card")]
            hit = [a["i"] for a in cards if a["card"].get("id") == base]
            if hit:
                return hit[0]
            hp = {u.get("id"): float(u.get("h") or 0) - float(u.get("d") or 0) for z in ("ground", "space") for u in mine.get(z) or []}
            mine_units = [a for a in cards if a["card"].get("id") in hp]
            if mine_units:
                return min(mine_units, key=lambda a: hp[a["card"]["id"]])["i"]
        return self.rng.randrange(len(acts))

    def real_next(self, msg, i, deal, sim, steps=400):
        """Play action i on the referee's copy, then play on to the moment every move is judged at.

        judge "round" (default): both seats play like rush to the end of this round's action phase, and the position
        is my first decision after it (in the regroup phase, after the draw). Every move is judged at the same moment
        of the game. judge "window": my next action window, my follow-up prompts chosen as the bot would, the
        opponent like rush; Pass and Claim Initiative then get judged a round later (after the next draw) than a
        card played now, and the judges picked them in most windows. None when the simulation fails."""
        me = msg["you"]
        them = "p2" if me == "p1" else "p1"
        start_round = (msg.get("state") or {}).get("round")
        r = sim({"t": "sim", "op": "begin", "deal": deal})
        if r.get("error") or len(r.get("actions") or []) != len(msg["actions"]):
            self.fail = f"begin: {r.get('error') or 'actions differ'}"
            return None
        r = sim({"t": "sim", "op": "act", "i": i})
        seen, seen_me, guard, trail = {}, {}, {}, []
        for _ in range(steps):
            acts = r.get("actions") or []
            if r.get("error") or not (r.get("over") or acts):
                self.fail = f"act: {r.get('error') or 'no actions'}"
                return None
            if r.get("ms") is not None and r["ms"] < 2500:
                self.fail = "time"  # a request past the decision's time gets no reply and loses the game
                return None
            prompt = r.get("prompt") or {}
            phase = (r.get("state") or {}).get("phase")
            if self.judge == "window" and not r.get("over") and r.get("actor") == me and prompt.get("actionWindow"):
                # back in my window with nothing changed (a cancelled click, "will have no effect" answered No):
                # judged before the opponent moves, such a move would always look best, so it scores lowest
                r["noop"] = r.get("state") == msg.get("state")
                return r
            if r.get("over") or (self.judge == "round" and r.get("actor") == me and len(acts) > 1
                                 and (phase != "action" or (r.get("state") or {}).get("round") != start_round)):
                return r
            if self.judge == "round" and r.get("actor") == me and prompt.get("actionWindow") and r.get("state") == msg.get("state") and not trail:
                r["noop"] = True  # the move changed nothing and left me in the same window
                return r
            if r.get("actor") != me:
                j = self.rush_move(r, me, seen)
            elif len(acts) == 1:
                j = 0
            elif self.judge == "round":
                j = self.rush_move(r, them, seen_me)
            else:
                # my own follow-up choice, with the same loop guard as in the real game (a multi-select prompt such
                # as choosing resources toggles a card on and off forever otherwise)
                pos = {"you": me, "prompt": r.get("prompt"), "state": r.get("state"), "actions": acts}
                order = [int(k) for k in np.argsort(-self.think(pos)["score"])]
                tried = guard.setdefault(json.dumps([pos["prompt"], pos["state"], [x.get("label") for x in acts]], sort_keys=True), [])
                j = order[0]
                if len(tried) >= 2 and j in tried:
                    fresh = [k for k in order if k not in tried]
                    j = fresh[0] if fresh else self.rng.randrange(len(acts))
                tried.append(j)
            trail.append(f"{'me' if r.get('actor') == me else 'opp'}:{(r.get('prompt') or {}).get('type')}:{acts[j].get('label')}")
            r = sim({"t": "sim", "op": "act", "i": j})
        self.fail = "step cap: " + " ".join(trail[-8:])
        return None

    def sim_scores(self, msg, sim, want):
        """P(I win) of the real next position for every move, as {"sim-v": [...], "sim-eval": [...]} for the scorers in
        `want`, averaged over self.deals deals. None if a simulation failed or time ran short (then the bot falls
        back to the imagined scores)."""
        me = msg["you"]
        n = len(msg["actions"])
        tot = {k: np.zeros(n) for k in want}
        for deal in range(self.deals):
            ends = []
            for i in range(n):
                r = self.real_next(msg, i, deal, sim)
                if r is not None and r.get("ms") is not None and r["ms"] < 2500:
                    self.fail = "time"
                if r is None or self.fail == "time":
                    sim({"t": "sim", "op": "end"})
                    return None
                ends.append(r)
            sim({"t": "sim", "op": "end"})
            done = {k: np.full(n, np.nan) for k in want}
            for i, r in enumerate(ends):
                if r.get("noop"):
                    for k in want:
                        done[k][i] = 0.0
                elif r.get("over"):
                    w = r["over"].get("winner")
                    for k in want:
                        done[k][i] = 1.0 if w == me else 0.5 if w in ("draw", None) else 0.0
            live = [i for i, r in enumerate(ends) if not (r.get("over") or r.get("noop"))]
            if live:
                pos = [{"you": me, "prompt": ends[i].get("prompt"), "state": ends[i].get("state"), "actions": ends[i].get("actions")} for i in live]
                if "sim-v" in want:
                    es = [F.encode(m, self.db) for m in pos]
                    z = self.net.encode(np.stack([e["state"] for e in es]), np.stack([e["tok_ids"] for e in es]).astype(np.int64),
                                        np.stack([e["tok_feats"] for e in es]), np.stack([e["tok_mask"] for e in es]))
                    done["sim-v"][live] = M.sigmoid(self.net.value(z))
                if "sim-eval" in want:
                    to_act = [me if (m["prompt"] or {}).get("actionWindow") else None for m in pos]
                    done["sim-eval"][live] = M.sigmoid(np.asarray(self.evaluator.logits(me, self.decks, [m["state"] for m in pos], to_act)))
            for k in want:
                tot[k] += done[k]
        return {k: v / self.deals for k, v in tot.items()}

    def choose(self, msg, sim=None):
        n = len(msg.get("actions") or [])
        if n <= 1:
            return 0, None
        t = self.think(msg)
        score = t["score"].astype(np.float64)
        self.fail = None
        if sim is not None and msg.get("sim") and self.needs_sim:
            want = ["sim-v", "sim-eval"] if (self.log is not None or self.score == "sim-eval") else ["sim-v"]
            real = self.sim_scores(msg, sim, want)
            if real is None:
                self.fallbacks += 1
            elif self.score != "imagined":
                score = real[self.score]
            t["real"] = real
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
        if self.log is not None:
            real = t.get("real")
            rec = {"seq": msg.get("seq"), "round": (msg.get("state") or {}).get("round"), "n": n, "pick": pick, "score": self.score,
                   "prompt": (msg.get("prompt") or {}).get("type"), "imagined": [round(float(x), 5) for x in t["score"]],
                   "v1": [round(float(x), 5) for x in t["v1"]], "v0": round(t["v0"], 5)}
            if self.fail:
                rec["fail"] = self.fail[:200]
            if real is not None:
                rec.update({k.replace("-", "_"): [round(float(x), 5) for x in v] for k, v in real.items()})
            self.log.write(json.dumps(rec) + "\n")
            self.log.flush()
        return pick, t


class EvalHelper:
    """bot/eval evaluator in a Node child process (bot/jepa/eval_helper.js), one JSON line per batch of states."""

    def __init__(self, name):
        here = os.path.dirname(os.path.abspath(__file__))
        self.p = subprocess.Popen(["node", os.path.join(here, "eval_helper.js"), name], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)

    def logits(self, judge, decks, states, to_act):
        self.p.stdin.write(json.dumps({"judge": judge, "decks": decks, "states": states, "toAct": to_act}) + "\n")
        self.p.stdin.flush()
        return json.loads(self.p.stdout.readline())["logits"]


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
    ap.add_argument("--score", choices=["imagined", "sim-v", "sim-eval"], default="imagined",
                    help="what ranks the moves: the imagined next latent (the bot), or the real next position from a simulation")
    ap.add_argument("--evaluator", default="linear-deck-g4", help="bot/eval evaluator for sim-eval and --log")
    ap.add_argument("--deals", type=int, default=1, help="deals of the hidden cards per move in sim modes")
    ap.add_argument("--judge", choices=["round", "window"], default="round",
                    help="when a simulated move is judged: after this round's action phase (round) or at my next action window")
    ap.add_argument("--log", default=None, help="append every decision's imagined and simulated scores here (JSON lines)")
    a = ap.parse_args()

    db = F.load_cards()
    log(f"{len(db)} card codes, model {a.model}, score {a.score}")
    logf = open(a.log, "a") if a.log else None
    helper = EvalHelper(a.evaluator) if (a.score == "sim-eval" or logf) else None
    player = JepaPlayer(a.model, db, a.mix, a.temp, score=a.score, evaluator=helper, deals=a.deals, log=logf, judge=a.judge)
    thoughts = os.environ.get("SWU_JEPA_THOUGHTS")
    stdin = sys.stdin

    def send(obj):
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()

    def sim(req):
        send(req)
        while True:
            line = stdin.readline()
            if not line:
                raise EOFError("referee closed the pipe during a simulation")
            if line.strip():
                return json.loads(line)

    while True:
        line = stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        t = msg.get("t")
        if t == "hello":
            player.new_game(msg.get("seed", 0), msg)
            # v1 unless a mode needs simulations (v2 also brings both deck lists and `over`)
            out = {"t": "ready", "v": 2, "name": a.name, "sim": True} if player.needs_sim and 2 in (msg.get("versions") or []) else {"t": "ready", "v": 1, "name": a.name}
        elif t == "over":
            out = {"t": "ok"}
        elif t == "decide":
            t0 = time.perf_counter()
            pick, th = player.choose(msg, sim)
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
        send(out)


if __name__ == "__main__":
    main()
