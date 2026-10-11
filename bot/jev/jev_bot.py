#!/usr/bin/env python3
"""Jev bot: a stdio bot (spec/stdio-protocol.md) whose decisions come from TypeSafe's Jev model.

At every decision with more than one legal action it sends Jev one request (POST /v1/systemone) with:
  - state: the board from its own seat, in plain words and numbers, with card text from the card data;
  - question "action": a Choice over the legal actions (labels a0, a1, ...), each described in plain English;
  - question "win": a Score of how likely it is to win from here (used for the dashboard, not for the choice).
It plays the action with the highest probability. Code keeps what code can do exactly: single-option prompts,
damage splits, loop guards, and a fallback when the API fails.

Standard library only. stdout carries protocol lines; logs go to stderr.

    node bot/tournament.js --bots jev,heuristic --games 4 --out replays/jev-test

With --look (registered as `jev-look`, adapter bot/jev/look.js) it can imagine before acting: at an action window where
Jev's favourite move has less than JEV_LOOK_CONFIDENT probability, it asks Jev which situation to imagine from a small
vocabulary (the board right after one of its top moves, the opponent's board reply to it, or the rest of the round),
the adapter simulates it on the engine and rolls back, the outcome is added to the state as `imagined`, and Jev is
asked again, until it picks "decide" or runs out of imaginations.

Environment:
  TYPESAFE_API_KEY      sent as a Bearer token when set
  TYPESAFE_BASE_URL     default https://api.typesafe.ai
  JEV_MODEL             default jev-latest
  JEV_TIMEOUT           seconds per API attempt, default 20
  JEV_PANEL             if set, path of a dashboard strategy panel to keep updated (dashboard/README.md section 5);
                        "{name}" in the path becomes the bot name (jev or jev-look)
  JEV_LOG               if set, append one JSON line per decision (what Jev saw and answered) to this file;
                        "{pid}" in the path is replaced by the process id, so parallel games don't share a file
  SWU_CARD_JSON         card data folder, default forceteki/test/json next to this repo
"""
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
BASE_URL = os.environ.get("TYPESAFE_BASE_URL", "https://api.typesafe.ai").rstrip("/")
MODEL = os.environ.get("JEV_MODEL", "jev-latest")
TIMEOUT = float(os.environ.get("JEV_TIMEOUT", "20"))
# all Jev calls between two messages to the harness share this many seconds (below the harness's own timeout), so a
# slow API still ends in a fallback move instead of the harness killing the bot
BUDGET = float(os.environ.get("JEV_BUDGET", "90"))
_deadline = [float("inf")]
LOOK = "--look" in sys.argv[1:]
NAME = "jev-look" if LOOK else "jev"
LOOK_CONFIDENT = float(os.environ.get("JEV_LOOK_CONFIDENT", "0.8"))  # skip imagining when the top action is this likely
LOOK_TOP = 3  # imagine only among the top actions

RULES = (
    "Star Wars: Unlimited. Each player has a base; you win when the enemy base has 0 HP left. "
    "Units are in the ground or space arena. A ready unit can attack an enemy unit in its own arena or the enemy base, "
    "then it is exhausted; both units deal damage equal to their power to each other. "
    "If the enemy has a Sentinel unit in that arena, attacks there must target it. "
    "Cards are paid for with ready resources; each round you may put one card from hand into resources. "
    "Each round both players alternate actions until both pass. 'Claim Initiative' gives you the initiative for next round "
    "but you take no more actions this round. Early in the game, putting a card into resources each round usually pays off "
    "because more resources allow bigger plays."
)


def log(*a):
    print("[jev]", *a, file=sys.stderr, flush=True)


# ---------- card data ----------

def load_cards():
    folder = os.environ.get("SWU_CARD_JSON", os.path.join(ROOT, "forceteki", "test", "json"))
    cards = {}
    cdir = os.path.join(folder, "Card")
    if not os.path.isdir(cdir):
        log("no card data at", cdir, "- cards will be described by name only")
        return cards
    for fn in os.listdir(cdir):
        if not fn.endswith(".json"):
            continue
        try:
            with open(os.path.join(cdir, fn), encoding="utf8") as f:
                c = json.load(f)
        except (OSError, ValueError):
            continue
        info = {
            "name": c.get("title") + (f", {c['subtitle']}" if c.get("subtitle") else ""),
            "type": "/".join(c.get("types") or []),
            "cost": c.get("cost"),
            "power": c.get("power"),
            "hp": c.get("hp"),
            "arena": c.get("arena"),
            "text": short(c.get("text")),
            "deploy": short(c.get("deployBox")),
            "keywords": c.get("keywords") or [],
        }
        for sc in c.get("setCodes") or ([c["setId"]] if c.get("setId") else []):
            if isinstance(sc, dict) and sc.get("set") and sc.get("number") is not None:
                cards.setdefault(f"{sc['set']}_{int(sc['number']):03d}", info)
    log(f"loaded {len(cards)} set codes")
    return cards


def short(text, n=220):
    if not text:
        return None
    text = " ".join(str(text).split())
    return text if len(text) <= n else text[: n - 1] + "…"


CARDS = {}


def card_info(ref):
    return CARDS.get((ref or {}).get("s") or "", {})


def card_name(ref):
    return card_info(ref).get("name") or (ref or {}).get("n") or (ref or {}).get("s") or "a card"


# ---------- describing the position ----------

def describe_unit(u):
    info = card_info(u)
    out = {"name": card_name(u), "power": u.get("p"), "hp_left": (u.get("h") or 0) - (u.get("d") or 0)}
    out["status"] = "exhausted" if u.get("x") else "ready"
    if u.get("sn"):
        out["sentinel"] = True
    if u.get("u"):
        out["upgrades"] = [card_name(x) for x in u["u"]]
    if info.get("text"):
        out["text"] = info["text"]
    return out


def describe_hand_card(c):
    info = card_info(c)
    out = {"name": card_name(c), "type": info.get("type"), "cost": info.get("cost")}
    if info.get("power") is not None:
        out["power_hp"] = f"{info.get('power')}/{info.get('hp')}"
    if info.get("arena"):
        out["arena"] = info["arena"]
    if info.get("text"):
        out["text"] = info["text"]
    return out


def describe_side(p, mine):
    base = p["base"]
    out = {
        "base": {"name": card_name(base), "hp_left": base["hp"] - base["d"], "max_hp": base["hp"]},
        "resources": {"ready": p["res"]["ready"], "total": p["res"]["total"]},
        "cards_in_hand": p.get("handCount"),
        "cards_in_deck": p.get("deck"),
        "cards_in_discard": len(p.get("discard") or []),
        "ground_units": [describe_unit(u) for u in p.get("ground") or []],
        "space_units": [describe_unit(u) for u in p.get("space") or []],
    }
    if p.get("leader"):
        ld = p["leader"]
        li = card_info(ld)
        out["leader"] = {"name": card_name(ld), "deployed": bool(ld.get("dep")), "exhausted": bool(ld.get("x"))}
        if not ld.get("dep") and li.get("text"):
            out["leader"]["ability"] = li["text"]
        if li.get("deploy") and not ld.get("dep"):
            out["leader"]["when_deployed"] = li["deploy"]
    if mine and p.get("hand") is not None:
        out["hand"] = [describe_hand_card(c) for c in p["hand"]]
    return out


def describe_state(msg):
    st, you = msg["state"], msg["you"]
    opp = "p2" if you == "p1" else "p1"
    pr = msg["prompt"]
    init = st.get("initiative")
    return {
        "round": st.get("round"),
        "phase": st.get("phase"),
        "initiative": None if init is None else ("you" if init == you else "opponent"),
        "prompt": {"question": pr.get("title"), "from": pr.get("promptTitle"), "main_action_choice": bool(pr.get("actionWindow")),
                   "already_selected": [card_name(c) for c in selected_cards(msg)]},
        "you": describe_side(st["players"][you], True),
        "opponent": describe_side(st["players"][opp], False),
    }


def selected_cards(msg):
    sel = set(msg["prompt"].get("selected") or [])
    if not sel:
        return []
    found = []
    for p in msg["state"]["players"].values():
        for zone in ("hand", "ground", "space", "discard"):
            found += [c for c in (p.get(zone) or []) if c.get("id") in sel]
    return found


ZONE_WORDS = {"hand": "hand", "groundArena": "ground arena", "spaceArena": "space arena", "base": "base",
              "discard": "discard pile", "resource": "resources", "leader": "leader", "deck": "deck"}


def unit_lookup(msg):
    m = {}
    for seat, p in msg["state"]["players"].items():
        for u in (p.get("ground") or []) + (p.get("space") or []):
            m[u.get("id")] = u
    return m


def describe_action(a, msg, units):
    kind, you, aw = a["kind"], msg["you"], msg["prompt"].get("actionWindow")
    if kind == "card" and a.get("card"):
        c = a["card"]
        name = card_name(c)
        zone, mine = c.get("zone"), c.get("ctl") == you
        u = units.get(c.get("id"))
        stats = f" ({u.get('p')} power, {(u.get('h') or 0) - (u.get('d') or 0)} HP left)" if u else ""
        if aw and mine:
            if zone == "hand":
                cost = card_info(c).get("cost")
                return f"Play {name} from your hand" + (f" (cost {cost})" if cost is not None else "")
            if zone in ("groundArena", "spaceArena"):
                return f"Attack (or use an action ability) with your {name}{stats}"
            if zone == "base":
                return f"Use your leader or base action: {name}"
            if zone == "resource":
                return f"Play {name} from your resources (Smuggle)"
            if zone == "discard":
                return f"Play {name} from your discard pile"
            return f"Use {name} ({ZONE_WORDS.get(zone, zone)})"
        owner = "your" if mine else "the opponent's"
        if c.get("id") in (msg["prompt"].get("selected") or []):
            return f"Unselect {owner} {name} (it is already selected)"
        if (msg["prompt"].get("signature") or "").startswith("resource") and zone == "hand":
            cost = card_info(c).get("cost")
            return f"Put your {name} (cost {cost}) into resources instead of keeping it in hand"
        return f"Choose {owner} {name} in {ZONE_WORDS.get(zone, zone or 'play')}{stats}"
    if kind == "distribute":
        d = a.get("distribute") or {}
        what = "healing" if "Heal" in (d.get("type") or "") else "damage"
        return f"Distribute {d.get('amount')} {what} (split chosen by code)"
    label = str(a.get("label"))
    if kind == "button":
        return f"Press '{label}'"
    if kind in ("displayCard", "perCardButton", "option"):
        return f"Choose '{label}'"
    return label


# ---------- imagined situations (lookahead) ----------

SITUATION_WORDS = {
    "after": "the board right after you: {a}",
    "reply": "the opponent's most aggressive board reply after you: {a}",
    "round": "how the rest of this round plays out (board actions only) after you: {a}",
}


def brief_side(p):
    units = []
    for zone in ("ground", "space"):
        for u in p.get(zone) or []:
            units.append(f"{card_name(u)} {u.get('p')}/{(u.get('h') or 0) - (u.get('d') or 0)}" + (" exhausted" if u.get("x") else ""))
    return {"base_hp_left": p["base"]["hp"] - p["base"]["d"], "ready_resources": p["res"]["ready"],
            "cards_in_hand": p.get("handCount"), "units": units}


def changes(before, after, you):
    opp = "p2" if you == "p1" else "p1"
    out = []
    for seat, who in ((you, "your"), (opp, "the opponent's")):
        b, a = before["players"][seat], after["players"][seat]
        dmg = a["base"]["d"] - b["base"]["d"]
        if dmg:
            out.append(f"{who} base {'takes' if dmg > 0 else 'heals'} {abs(dmg)}")
        bu = {u["id"]: u for z in ("ground", "space") for u in b.get(z) or []}
        au = {u["id"]: u for z in ("ground", "space") for u in a.get(z) or []}
        for i in bu.keys() - au.keys():
            out.append(f"{who} {card_name(bu[i])} is gone")
        for i in au.keys() - bu.keys():
            out.append(f"{who} {card_name(au[i])} enters play")
        for i in bu.keys() & au.keys():
            d = (au[i].get("d") or 0) - (bu[i].get("d") or 0)
            if d > 0:
                out.append(f"{who} {card_name(au[i])} takes {d} damage")
    return out


def describe_imagined(sit_text, res, msg):
    you = msg["you"]
    if not res.get("ok"):
        return {"situation": sit_text, "result": f"could not simulate ({res.get('error')})"}
    after = res["state"]
    opp = "p2" if you == "p1" else "p1"
    steps = [("you" if s["who"] == you else "opponent") + (" choose " if s.get("at") == "choice" else ": ") + str(s["what"])
             for s in res.get("steps") or []]
    out = {"situation": sit_text, "what_happened": steps[:12], "changes": changes(msg["state"], after, you) or ["nothing visible"],
           "board_after": {"you": brief_side(after["players"][you]), "opponent": brief_side(after["players"][opp])}}
    if res.get("over"):
        out["game_over"] = "you win" if res.get("winner") == you else ("opponent wins" if res.get("winner") else "draw")
    return out


# ---------- code-owned parts ----------

def split(action, msg):
    """Damage: kill the strongest enemy units that can be killed, rest on the enemy base. Heal: most damaged own first."""
    d = action["distribute"]
    you = msg["you"]
    units = unit_lookup(msg)
    bases = {p["base"]["id"]: seat for seat, p in msg["state"]["players"].items()}
    heal = "Heal" in (d.get("type") or "")

    def owner(tid):
        if tid in bases:
            return bases[tid]
        for seat, p in msg["state"]["players"].items():
            for u in (p.get("ground") or []) + (p.get("space") or []):
                if u.get("id") == tid:
                    return seat
        return None

    def key(t):
        u = units.get(t["id"])
        friendly = owner(t["id"]) == you
        if heal:
            dmg = (u or {}).get("d", 0) if u else 0
            return (0 if friendly else 1, -dmg)
        if u:
            left = (u.get("h") or 0) - (u.get("d") or 0)
            return (1 if friendly else 0, -(u.get("p") or 0) if left <= d["amount"] else 50, left)
        return (1 if friendly else 0, 40, 0)

    targets = sorted(d["targets"], key=key)
    if d.get("maxTargets") is not None:
        targets = targets[: d["maxTargets"]]
    left, given = d["amount"], {}

    def useful(t):
        # damage: lethal on a unit is enough; healing: no more than the damage it has
        u = units.get(t["id"])
        if not u:
            return None
        return (u.get("d") or 0) if heal else max(0, (u.get("h") or 0) - (u.get("d") or 0))

    # first pass stops at what is useful, the second places what must still go somewhere (up to the real caps)
    for limit_useful in (True, False):
        for t in targets:
            if not left:
                break
            # damage goes on friendly targets (sorted last) and healing on enemy ones only when it must all be placed
            if d.get("canDistributeLess") and (owner(t["id"]) == you) != heal:
                continue
            room = float("inf") if t["cap"] is None else t["cap"]
            if limit_useful and useful(t) is not None:
                room = min(room, useful(t))
            give = int(min(left, room - given.get(t["id"], 0)))
            if give > 0:
                given[t["id"]] = given.get(t["id"], 0) + give
                left -= give
        if heal and d.get("canDistributeLess"):
            break  # no over-healing when it may be left unplaced
    out = [{"id": i, "amount": a} for i, a in given.items()]
    if left and not d.get("canDistributeLess"):
        return None
    if not out and not d.get("canChooseNoTargets"):
        return None
    return out


class Guard:
    """Stops loops: the same choice in the same prompt state more than twice in a round gets ruled out."""

    def __init__(self):
        self.seen = {}

    def key(self, msg, a):
        pr, st = msg["prompt"], msg["state"]
        return (st.get("round"), pr.get("signature"), pr.get("title"), a.get("label"), a.get("cardUuid"))

    def blocked(self, msg, a):
        return self.seen.get(self.key(msg, a), 0) >= 3

    def note(self, msg, a):
        k = self.key(msg, a)
        self.seen[k] = self.seen.get(k, 0) + 1


# ---------- Jev ----------

WIN_QUESTION = {
    "type": "score",
    "instructions": {"game_rules": RULES, "task": "How likely is 'you' to win this game from this position?"},
    "criteria": ["you almost certainly lose", "you are behind", "even game", "you are ahead", "you almost certainly win"],
}


def action_question(actions_text):
    return {
        "type": "choice",
        "instructions": {
            "game_rules": RULES,
            "task": "You are 'you' in this Star Wars: Unlimited game. The prompt says what is being decided. "
                    "If `imagined` is present, it shows simulated outcomes of some options; use them. "
                    "Pick the legal option that most raises your chance to win the game.",
        },
        "criteria": {f"a{i}": t for i, t in enumerate(actions_text)},
    }


def look_question(options):
    return {
        "type": "choice",
        "instructions": {
            "game_rules": RULES,
            "task": "Before you act, you may imagine one situation: the game engine simulates it and shows you the board "
                    "it leads to (the opponent only uses units already on the board in these simulations). "
                    "Pick the situation whose outcome would best help you choose your action. "
                    "Pick 'decide' if you are already sure, or if `imagined` already answers your doubts.",
        },
        "criteria": options,
    }


def ask_jev(state, questions):
    body = {"model": MODEL, "state": state, "questions": questions}
    headers = {"content-type": "application/json", "user-agent": "swu-bot-jev/1"}
    key = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if key:
        headers["authorization"] = f"Bearer {key}"
    data = json.dumps(body).encode("utf8")
    delay = 0.5
    for attempt in range(4):
        left = _deadline[0] - time.time()
        if left < 2:
            raise RuntimeError("out of time budget")
        req = urllib.request.Request(f"{BASE_URL}/v1/systemone", data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=min(TIMEOUT, left)) as r:
                return json.loads(r.read().decode("utf8"))
        except urllib.error.HTTPError as e:
            if e.code not in (408, 429) and e.code < 500:
                raise RuntimeError(f"HTTP {e.code}: {e.read()[:200]!r}")
            wait = float(e.headers.get("retry-after") or delay)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            if attempt == 3:
                raise RuntimeError(f"connection: {e}")
            wait = delay
        time.sleep(max(0, min(wait, 10, _deadline[0] - time.time() - 2)))
        delay *= 2
    raise RuntimeError("no answer after retries")


# ---------- dashboard panel ----------

class Panel:
    def __init__(self, path):
        self.path = path
        self.last_write = 0
        self.thoughts = []
        self.win_curve = []
        self.last_probs = []
        self.last_imagined = []
        self.now = ""
        self.stats = {"decisions": 0, "jev_calls": 0, "fallbacks": 0, "api_ms": [], "tokens": 0, "games": 0, "imagined": 0}

    def game(self, you):
        self.stats["games"] += 1
        self.win_curve = []
        self.now = f"Game {self.stats['games']} started, playing {you}"

    def decision(self, msg, texts, probs, chosen, win, ms, imagined=None):
        self.stats["decisions"] += 1
        self.now = f"Round {msg['state'].get('round')}: {texts[chosen]} (p={probs[chosen]:.2f})"
        if win is not None:
            self.win_curve.append([msg["seq"], round(win, 3)])
        order = sorted(range(len(texts)), key=lambda i: -probs[i])[:8]
        self.last_probs = [{"label": texts[i][:60], "value": round(probs[i], 3)} for i in order]
        if imagined:
            self.last_imagined = [[x["situation"][:70], ", ".join((x.get("changes") or [x.get("result", "")])[:4])] for x in imagined]
        if msg["prompt"].get("actionWindow") or len(self.thoughts) == 0:
            alt = order[1] if len(order) > 1 and order[0] == chosen else order[0]
            w = f", thinks it wins with {win:.0%}" if win is not None else ""
            if imagined:
                w += "; imagined " + "; ".join(f"{x['situation'][:60]} -> {', '.join((x.get('changes') or [x.get('result', '')])[:3])}" for x in imagined)
            self.thoughts.append({
                "t": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "text": f"R{msg['state'].get('round')}: {texts[chosen]} ({probs[chosen]:.0%}; next best: {texts[alt][:50]} {probs[alt]:.0%}){w}",
            })
            self.thoughts = self.thoughts[-12:]
        self.maybe_write()

    def maybe_write(self, force=False):
        if not self.path or (not force and time.time() - self.last_write < 3):
            return
        self.last_write = time.time()
        api = sorted(self.stats["api_ms"][-500:])
        p50 = api[len(api) // 2] if api else None
        doc = {
            "schema": 1, "id": NAME, "title": "Jev + lookahead" if LOOK else "Jev (TypeSafe System One) bot", "thread": "Jev decision bot",
            "bots": [NAME], "status": "running",
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "now": self.now,
            "goal": "Play SWU by asking TypeSafe's Jev model to pick among the legal moves, with code owning the rules it can compute.",
            "mentalModel": {
                "summary": "No search and no training. Each decision is one Jev Choice over the legal actions, described in plain English "
                           "with the board and card text as state; the action with the highest probability is played. A parallel Score "
                           "question gives Jev's own win estimate. Code handles damage splits, single-option prompts and loop guards.",
                "features": [],
            },
            "plan": [
                {"text": "Jev Choice per decision over the stdio protocol", "state": "done"},
                {"text": "Ladder games vs random and heuristic bots", "state": "doing"},
                {"text": "Tune action wording and state from losses", "state": "todo"},
            ],
            "thoughts": self.thoughts,
            "widgets": [
                {"type": "stats", "items": [
                    {"label": "decisions", "value": self.stats["decisions"]},
                    {"label": "Jev calls", "value": self.stats["jev_calls"]},
                    {"label": "API p50 ms", "value": p50},
                    {"label": "fallbacks", "value": self.stats["fallbacks"]},
                    {"label": "situations imagined", "value": self.stats["imagined"]},
                    {"label": "tokens used", "value": self.stats["tokens"]},
                ]},
                {"type": "bars", "title": "Jev's probabilities at the last decision", "items": self.last_probs},
                *([{"type": "table", "title": "What it imagined last time it was unsure", "columns": ["situation", "what changed"],
                    "rows": self.last_imagined}] if LOOK else []),
                {"type": "line", "title": "Jev's own win estimate this game", "x": "decision", "yFormat": "pct",
                 "series": [{"name": "P(win)", "points": self.win_curve[-300:]}]},
            ],
        }
        try:
            tmp = f"{self.path}.{os.getpid()}.tmp"
            with open(tmp, "w", encoding="utf8") as f:
                json.dump(doc, f)
            os.replace(tmp, self.path)
        except OSError as e:
            log("panel write failed:", e)


# ---------- main loop ----------

def call_jev(panel, state, questions):
    t0 = time.time()
    res = ask_jev(state, questions)
    ms = (time.time() - t0) * 1000
    panel.stats["jev_calls"] += 1
    panel.stats["api_ms"].append(ms)
    panel.stats["tokens"] += sum((res.get("usage") or {}).values())
    return res, ms


def probs_of(ans, n):
    return [float(ans["probabilities"].get(f"a{i}", 0.0)) for i in range(n)]


MAX_CHOICES = 250  # the API allows at most 255 choices per question


def ask_action(panel, state, texts, extra=None):
    """Probabilities over all `texts`, plus the raw response. Over MAX_CHOICES (e.g. a 'name a card' list), Jev first
    picks inside each chunk, then among the chunk winners; p(i) = p(i in its chunk) * p(its chunk's winner)."""
    if len(texts) <= MAX_CHOICES:
        res, _ = call_jev(panel, state, {"action": action_question(texts), **(extra or {})})
        return probs_of(res["answers"]["action"], len(texts)), res
    chunks = [list(range(j, min(j + MAX_CHOICES, len(texts)))) for j in range(0, len(texts), MAX_CHOICES)]
    qs = {f"action{c}": action_question([texts[i] for i in ids]) for c, ids in enumerate(chunks)}
    res, _ = call_jev(panel, state, {**qs, **(extra or {})})
    inner, best = [], []
    for c, ids in enumerate(chunks):
        p = probs_of(res["answers"][f"action{c}"], len(ids))
        inner.append(p)
        best.append(ids[max(range(len(ids)), key=lambda j: p[j])])
    final, _ = call_jev(panel, state, {"action": action_question([texts[i] for i in best])})
    pf = probs_of(final["answers"]["action"], len(best))
    probs = [inner[c][j] * pf[c] for c, ids in enumerate(chunks) for j in range(len(ids))]
    return probs, res


def decide(msg, rng, guard, panel, logf, io=None):
    """io: (send, recv) for imagine requests, or None when lookahead is off."""
    actions = msg["actions"]
    allowed = [a for a in actions if not guard.blocked(msg, a)] or actions
    if len(allowed) == 1:
        a = allowed[0]
        guard.note(msg, a)
        return a, None
    units = unit_lookup(msg)
    texts = [describe_action(a, msg, units) for a in allowed]
    state = describe_state(msg)
    t0 = time.time()
    win = None
    imagined, looked = [], set()
    try:
        probs, res = ask_action(panel, state, texts, {"win": WIN_QUESTION})
        w = res["answers"].get("win")
        if w and w.get("score") is not None:
            win = float(w["score"]) / 4.0
        look = msg.get("imagine") or {}
        left = look.get("left", 0) if io else 0
        kinds = set(look.get("kinds") or [])
        # imagine only when Jev is unsure: one clear favourite needs no lookahead
        while left > 0 and max(probs) < LOOK_CONFIDENT:
            top = sorted(range(len(allowed)), key=lambda i: -probs[i])[:LOOK_TOP]
            options = {"decide": "Decide now without imagining anything more"}
            for i in top:
                for kind in ("after", "reply", "round"):
                    if kind in kinds and (kind, i) not in looked:
                        options[f"{kind}{i}"] = "Imagine " + SITUATION_WORDS[kind].format(a=texts[i])
            if len(options) == 1:
                break
            if imagined:
                state["imagined"] = imagined
            res, _ = call_jev(panel, state, {"look": look_question(options)})
            pick = res["answers"]["look"]["choice"]
            if pick == "decide" or pick not in options:
                break
            kind, i = pick.rstrip("0123456789"), int(pick[len(pick.rstrip("0123456789")):])
            looked.add((kind, i))
            send, recv = io
            send({"t": "imagine", "situation": {"kind": kind, "i": allowed[i]["i"]}})
            got = recv()
            _deadline[0] = time.time() + BUDGET
            if got.get("t") != "imagined":
                raise RuntimeError(f"expected imagined, got {got.get('t')}")
            left = got.get("left", 0)
            imagined.append(describe_imagined(SITUATION_WORDS[kind].format(a=texts[i]), got, msg))
            panel.stats["imagined"] += 1
            # re-ask the action with what it has imagined so far
            state["imagined"] = imagined
            probs, _ = ask_action(panel, state, texts)
        k = max(range(len(allowed)), key=lambda i: probs[i])
        ms = (time.time() - t0) * 1000
        fallback = False
    except EOFError:
        raise
    except Exception as e:  # noqa: BLE001 - any API failure falls back to a legal move
        ms = (time.time() - t0) * 1000
        panel.stats["fallbacks"] += 1
        log("Jev call failed, falling back:", e)
        non_pass = [i for i, a in enumerate(allowed) if str(a.get("arg")) != "pass"]
        k = rng.choice(non_pass or list(range(len(allowed))))
        probs = [1.0 if i == k else 0.0 for i in range(len(allowed))]
        fallback = True
    a = allowed[k]
    guard.note(msg, a)
    panel.decision(msg, texts, probs, k, win, ms, imagined)
    if logf:
        logf.write(json.dumps({"seq": msg["seq"], "you": msg["you"], "round": msg["state"].get("round"),
                               "prompt": msg["prompt"].get("signature"), "title": msg["prompt"].get("title"),
                               "options": texts, "probs": [round(p, 4) for p in probs], "chosen": k,
                               "win": win, "ms": round(ms, 1), "fallback": fallback, "imagined": imagined}) + "\n")
        logf.flush()
    return a, win


def main():
    global CARDS
    CARDS = load_cards()
    rng = random.Random(0)
    guard = Guard()
    panel = Panel(os.environ.get("JEV_PANEL", "").replace("{name}", NAME) or None)
    logp = os.environ.get("JEV_LOG", "").replace("{pid}", str(os.getpid()))
    logf = open(logp, "a", encoding="utf8") if logp else None
    def send(obj):
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()

    def recv():
        while True:
            line = sys.stdin.readline()
            if not line:
                raise EOFError
            if line.strip():
                return json.loads(line)

    io = (send, recv) if LOOK else None
    while True:
        try:
            msg = recv()
        except EOFError:
            break
        if msg["t"] == "hello":
            rng = random.Random(msg["seed"])
            guard = Guard()
            panel.game(msg["you"])
            reply = {"t": "ready", "v": 1, "name": NAME}
        elif msg["t"] == "decide":
            _deadline[0] = time.time() + BUDGET
            try:
                a, _ = decide(msg, rng, guard, panel, logf, io)
                reply = {"t": "act", "i": a["i"]}
                if a["kind"] == "distribute":
                    d = split(a, msg)
                    if d is not None:
                        reply["distribution"] = d
            except EOFError:
                break
            except Exception as e:  # noqa: BLE001 - never crash the game on a bug of ours
                log("decide failed:", repr(e))
                reply = {"t": "act", "i": rng.randrange(len(msg["actions"]))}
        else:
            reply = {"t": "error", "error": f"unknown message {msg['t']}"}
        send(reply)
    panel.maybe_write(force=True)


if __name__ == "__main__":
    main()
