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

Planner (--score plan): at an action window, play every candidate move on the referee's copy together with its
follow-up choices (targets, cards, options: the best few by the imagined score, two levels deep), stop each line where
the move has settled (anyone's next action window, the end of the action phase, or the end of the game), and score
that real position with the value head. The best line's follow-up choices are then replayed at the real follow-up
prompts while they match; every other decision (resource prompts, the opponent's turn) uses the imagined score.
"""
import argparse
import json
import os
import random
import subprocess
import sys
import time
from collections import deque

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import features as F  # noqa: E402
import model as M  # noqa: E402
import resource_policy as R  # noqa: E402


def log(*a):
    print("jepa:", *a, file=sys.stderr, flush=True)


def is_button(a, label):
    return a.get("kind") == "button" and str(a.get("label", "")).lower() == label


def action_key(a):
    """An action's identity across the referee's copy and the real game (card ids can differ there)."""
    c = a.get("card") or {}
    return [a.get("kind"), a.get("label"), c.get("n"), c.get("zone"), c.get("ctl"), a.get("arg") if isinstance(a.get("arg"), (int, float)) else None]


def labels_key(acts):
    return json.dumps([action_key(a) for a in acts])


# the prompt a settled position is encoded with when the opponent is the one to act: the value head was trained on my
# own decisions only, so every such position is read as my action window, the same way for every candidate move
WAIT_PROMPT = {"type": "actionWindow", "actionWindow": True, "selectCardMode": None, "selected": []}


class JepaPlayer:
    def __init__(self, model_path, db, mix=0.5, temp=0.0, seed=0, score="imagined", evaluator=None, deals=1, log=None, judge="round", window_model=None,
                 plan=None, resource=None, plan_model=None):
        w, self.meta = M.load_safetensors(model_path)
        self.net = M.NumpyJepa(w)
        # optional model that scores only the planner's settled positions (e.g. a value head trained to rank moves)
        self.plan_net = M.NumpyJepa(M.load_safetensors(plan_model)[0]) if plan_model else self.net
        # optional second model used only in action windows (e.g. a predictor fine-tuned on branches, which only cover windows)
        self.window_net = M.NumpyJepa(M.load_safetensors(window_model)[0]) if window_model else None
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
        # planner settings (--score plan): root moves, follow-up options at the first and deeper levels, levels, lines and
        # wall-clock seconds per decision, and the time left (ms) below which no more simulation requests are sent
        self.plan_cfg = {"roots": 16, "follow": 6, "follow2": 3, "depth": 2, "lines": 150, "secs": 5.0, "floor": 2500, **(plan or {})}
        self.plan = []  # my remaining follow-up choices from the chosen line: [(labels_key, action_key)]
        self.resource = R.ResourcePolicy(resource) if resource else None  # resource prompts copied from strong bots
        self.new_game(seed)

    def new_game(self, seed, hello=None):
        self.rng = random.Random(seed)
        self.seen = {}
        self.decks = None
        self.plan = []
        self.stats = {"windows": 0, "planned": 0, "lines": 0, "leaves": 0, "failed": 0, "secs": 0.0, "followed": 0, "unplanned": 0, "dropped": 0}
        if hello and hello.get("deck") and hello.get("opponent"):
            you = hello.get("you", "p1")
            them = "p2" if you == "p1" else "p1"
            flat = lambda d: [c["id"] for c in d.get("deck") or [] for _ in range(int(c.get("count", 1)))]
            self.decks = {you: flat(hello["deck"]), them: flat(hello["opponent"])}

    @property
    def needs_sim(self):
        return self.score != "imagined" or self.log is not None

    def think(self, msg):
        net = self.window_net if self.window_net is not None and (msg.get("prompt") or {}).get("actionWindow") else self.net
        e = F.encode(msg, self.db)
        z = net.encode(e["state"][None], e["tok_ids"][None].astype(np.int64), e["tok_feats"][None], e["tok_mask"][None])
        a = net.action(e["actions"], e["aids"].astype(np.int64))
        z1 = net.predict(z, a, 1)
        z4 = net.predict(z, a, 4)
        v1 = M.sigmoid(net.value(z1))
        v4 = M.sigmoid(net.value(z4))
        score = (1 - self.mix) * v1 + self.mix * v4
        return {"z": z[0], "z1": z1, "z4": z4, "v1": v1, "v4": v4, "score": score, "v0": float(M.sigmoid(net.value(z))[0])}

    def rush_move(self, r, target, seen):
        """A move inside a simulation for the seat to act, played like bot/players/rush.js (the training data's main
        opponent): in its action window a card from hand first, then an attack with a ready unit, then the leader,
        else pass, passing when the same window keeps coming back; attacks go at `target`'s base when it can be
        picked. Other prompts are random, never Cancel when something else is legal."""
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
        # a Cancel would undo the move being judged (it then looks like a no-op), so pick among the other answers
        keep = [a["i"] for a in acts if not (a.get("kind") == "button" and str(a.get("label", "")).lower() == "cancel")]
        return self.rng.choice(keep) if keep else self.rng.randrange(len(acts))

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
            if (self.judge == "round" and r.get("actor") == me and prompt.get("actionWindow") and r.get("state") == msg.get("state")
                    and all(x.startswith("me:") for x in trail)):
                r["noop"] = True  # the move changed nothing (maybe after a cancelled follow-up prompt) and left me in the same window
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
                cancel = {k for k, x in enumerate(acts) if x.get("kind") == "button" and str(x.get("label", "")).lower() == "cancel"}
                order = [k for k in order if k not in cancel] + [k for k in order if k in cancel]
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

    @staticmethod
    def settled(r):
        """A simulated line stops when my move has played out: the game ended, someone is in an action window, or the
        action phase is over."""
        return bool(r.get("over") or (r.get("prompt") or {}).get("actionWindow") or (r.get("state") or {}).get("phase") != "action")

    def plan_line(self, msg, sim, path, queue, depth_cap):
        """Replay `path` (action indices from the real position, both seats) on a fresh simulation, then play on until
        the move has settled: the opponent like rush, my follow-up prompts by the imagined score. At a follow-up prompt
        reached for the first time in this line, the next best options go into `queue` as new lines. Returns
        (taken, my_steps, position), None when this line failed, or "abort" when no more simulations can be sent."""
        me = msg["you"]
        cfg = self.plan_cfg
        r = sim({"t": "sim", "op": "begin", "deal": 0})
        if r.get("error") or len(r.get("actions") or []) != len(msg["actions"]):
            self.fail = f"begin: {r.get('error') or 'actions differ'}"
            return "abort"
        taken, mine, guard, seen, depth = [], [], {}, {}, 0
        for step in range(80):
            if r.get("error"):
                self.fail = f"act: {r['error']}"
                return None  # the simulation is closed; the next line begins a new one
            if r.get("ms") is not None and r["ms"] < cfg["floor"]:
                self.fail = "time"
                return "abort"
            if step > 0 and self.settled(r):
                return taken, mine, r
            acts = r.get("actions") or []
            if not acts:
                self.fail = "no actions"
                return None
            actor = r.get("actor")
            key = None
            if actor == me and len(acts) > 1:
                key = json.dumps([r.get("prompt"), r.get("state"), [x.get("label") for x in acts]], sort_keys=True)
            if step < len(path):
                j = path[step]
                if key is not None and step > 0:
                    guard.setdefault(key, []).append(j)
                    depth += 1
            elif actor != me:
                j = self.rush_move(r, me, seen)
            elif len(acts) == 1:
                j = 0
            else:
                pos = {"you": me, "prompt": r.get("prompt"), "state": r.get("state"), "actions": acts}
                order = [int(k) for k in np.argsort(-self.think(pos)["score"])]
                cancel = {k for k, x in enumerate(acts) if is_button(x, "cancel")}
                order = [k for k in order if k not in cancel] + [k for k in order if k in cancel]
                tried = guard.setdefault(key, [])
                if not tried and depth < depth_cap:
                    # a new follow-up prompt: this line takes the best option, the next ones become lines of their own
                    width = cfg["follow"] if depth == 0 else cfg["follow2"]
                    opts = [k for k in order if k not in cancel][:width] or order[:1]
                    for alt in opts[1:]:
                        queue.append(taken + [alt])
                    j = opts[0]
                else:
                    # the same prompt again in this line (a multi-select prompt toggles cards), or past the depth cap
                    j = order[0]
                    if len(tried) >= 2 and j in tried:
                        fresh = [k for k in order if k not in tried]
                        j = fresh[0] if fresh else self.rng.randrange(len(acts))
                tried.append(j)
                depth += 1
            if actor == me and step > 0 and len(acts) > 1:
                mine.append((labels_key(acts), action_key(acts[j])))
            taken.append(j)
            r = sim({"t": "sim", "op": "act", "i": j})
        self.fail = "step cap"
        return None

    def plan_moves(self, msg, sim, imagined):
        """The planner's score for every root move (max over its simulated lines of the value of the settled
        position), and the best line's follow-up choices per root move. None when nothing could be simulated."""
        me = msg["you"]
        acts = msg["actions"]
        n = len(acts)
        cfg = self.plan_cfg
        order = [int(k) for k in np.argsort(-imagined)]
        roots = order[:cfg["roots"]] + [k for k in range(n) if is_button(acts[k], "pass") and k not in order[:cfg["roots"]]]
        queue = deque([[i] for i in roots])  # first one line per root move, in imagined order, then the alternatives
        t0 = time.perf_counter()
        leaves, lines = [], 0
        while queue and lines < cfg["lines"] and time.perf_counter() - t0 < cfg["secs"]:
            path = queue.popleft()
            res = self.plan_line(msg, sim, path, queue, cfg["depth"])
            lines += 1
            if res == "abort":
                break
            if res is None:
                self.stats["failed"] += 1
                why = (self.fail or "?")[:60]
                self.stats.setdefault("fails", {})[why] = self.stats.setdefault("fails", {}).get(why, 0) + 1
            else:
                leaves.append(res)
        sim({"t": "sim", "op": "end"})
        self.stats["lines"] += lines
        self.stats["leaves"] += len(leaves)
        self.stats["secs"] += time.perf_counter() - t0
        if not leaves:
            return None
        vals = np.full(len(leaves), np.nan)
        live, pos = [], []
        for k, (taken, _, r) in enumerate(leaves):
            if r.get("over"):
                w = r["over"].get("winner")
                vals[k] = 1.0 if w == me else 0.5 if w in ("draw", None) else 0.0
            elif r.get("actor") == me and (r.get("prompt") or {}).get("actionWindow") and r.get("state") == msg.get("state"):
                vals[k] = 0.0  # back in my window with nothing changed: the move does nothing
            else:
                live.append(k)
                if r.get("actor") == me:
                    pos.append({"you": me, "prompt": r.get("prompt"), "state": r.get("state"), "actions": r.get("actions")})
                else:
                    pos.append({"you": me, "prompt": WAIT_PROMPT, "state": r.get("state"), "actions": acts})
        if live and self.plan_cfg.get("scorer") == "eval":
            # the fitted bot/eval evaluator in place of the value head (a yardstick for the value head)
            to_act = [leaves[k][2].get("actor") if (leaves[k][2].get("prompt") or {}).get("actionWindow") else None for k in live]
            vals[live] = M.sigmoid(np.asarray(self.evaluator.logits(me, self.decks, [m["state"] for m in pos], to_act)))
        elif live:
            es = [F.encode(m, self.db) for m in pos]
            z = self.plan_net.encode(np.stack([e["state"] for e in es]), np.stack([e["tok_ids"] for e in es]).astype(np.int64),
                                     np.stack([e["tok_feats"] for e in es]), np.stack([e["tok_mask"] for e in es]))
            vals[live] = M.sigmoid(self.plan_net.value(z))
        score = np.full(n, -1.0)
        best = {}
        for k, (taken, mine, _) in enumerate(leaves):
            i = taken[0]
            if vals[k] > score[i]:
                score[i] = vals[k]
                best[i] = mine
        return score, best

    def follow_plan(self, msg):
        """My planned choice at a real follow-up prompt, or None when the prompt is not the one the plan expects."""
        if not self.plan:
            return None
        sig = labels_key(msg["actions"])
        for k, (want, choice) in enumerate(self.plan):
            if want == sig:
                self.plan = self.plan[k + 1:]
                for i, a in enumerate(msg["actions"]):
                    if action_key(a) == choice:
                        return i
                return None
        self.plan = []
        self.stats["dropped"] += 1
        return None

    def choose(self, msg, sim=None):
        n = len(msg.get("actions") or [])
        if n <= 1:
            return 0, None
        t = self.think(msg)
        if self.resource is not None:
            j = self.resource.choose(msg)
            if j is not None:
                return j, t
        score = t["score"].astype(np.float64)
        self.fail = None
        window = bool((msg.get("prompt") or {}).get("actionWindow"))
        best = None
        if self.score == "plan":
            if window:
                self.plan = []
                self.stats["windows"] += 1
                if sim is not None and msg.get("sim"):
                    planned = self.plan_moves(msg, sim, score)
                    if planned is None:
                        self.fallbacks += 1
                    else:
                        score, best = planned
                        self.stats["planned"] += 1
            else:
                had = bool(self.plan)
                j = self.follow_plan(msg)
                if j is not None:
                    self.stats["followed"] += 1
                    return j, t
                self.stats["unplanned"] += 1
                kind = "resource" if F.prompt_type(msg.get("prompt") or {}) == 1 else "plan missed" if had else "other"
                self.stats.setdefault("why", {})[kind] = self.stats.setdefault("why", {}).get(kind, 0) + 1
        elif sim is not None and msg.get("sim") and self.needs_sim:
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
        if best is not None:
            self.plan = list(best.get(pick) or [])
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
    ap.add_argument("--score", choices=["imagined", "sim-v", "sim-eval", "plan"], default="imagined",
                    help="what ranks the moves: the imagined next latent (the bot), the real next position from a simulation, "
                         "or the planner (whole moves with their follow-up choices, simulated)")
    ap.add_argument("--plan", default="", help="planner settings as k=v,... (roots, follow, follow2, depth, lines, secs, floor)")
    ap.add_argument("--resource", default=None, help="answer resource prompts with this model (bot/jepa/resource_policy.py)")
    ap.add_argument("--plan-scorer", choices=["v", "eval"], default="v",
                    help="what scores the planner's settled positions: the value head, or the --evaluator (a yardstick)")
    ap.add_argument("--evaluator", default="linear-deck-g4", help="bot/eval evaluator for sim-eval and --log")
    ap.add_argument("--deals", type=int, default=1, help="deals of the hidden cards per move in sim modes")
    ap.add_argument("--judge", choices=["round", "window"], default="round",
                    help="when a simulated move is judged: after this round's action phase (round) or at my next action window")
    ap.add_argument("--window-model", default=None, help="a second model used only in action windows")
    ap.add_argument("--plan-model", default=None, help="a second model that scores only the planner's settled positions")
    ap.add_argument("--log", default=None, help="append every decision's imagined and simulated scores here (JSON lines)")
    a = ap.parse_args()

    db = F.load_cards()
    log(f"{len(db)} card codes, model {a.model}, score {a.score}")
    logf = open(a.log, "a") if a.log else None
    helper = EvalHelper(a.evaluator) if (a.score == "sim-eval" or logf or (a.score == "plan" and a.plan_scorer == "eval")) else None
    plan = {k: float(v) for k, v in (kv.split("=") for kv in a.plan.split(",") if kv)}
    player = JepaPlayer(a.model, db, a.mix, a.temp, score=a.score, evaluator=helper, deals=a.deals, log=logf, judge=a.judge, window_model=a.window_model,
                        plan={**{k: (v if k == "secs" else int(v)) for k, v in plan.items()}, "scorer": a.plan_scorer}, resource=a.resource, plan_model=a.plan_model)
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
            if player.score == "plan" and player.stats.get("windows"):
                st = player.stats
                log(f"plan: {st['planned']}/{st['windows']} windows planned, {st['lines'] / max(st['planned'], 1):.1f} lines and "
                    f"{st['secs'] / max(st['planned'], 1):.2f} s each, {st['failed']} failed lines {st.get('fails') or ''}; follow-ups {st['followed']} from the plan, "
                    f"{st['unplanned']} unplanned {st.get('why')}, {st['dropped']} plans dropped")
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
