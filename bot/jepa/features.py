"""Turns one stdio `decide` message (prompt, state, actions) into numbers for the JEPA.

The state vector (73) and action vector (62) and the hashed card/label id (2048 buckets) are a line-by-line
port of the Rust learned bot's encoder (bot/rust-learned/src/features.rs), so the two learned bots share one
encoding and one data format ("swu-traj/1", /mnt/project-files/learn/README.md). On top of that the JEPA reads
a set of card tokens (hand, both boards, leaders, bases), each with its hashed identity, which the summary
vector alone cannot see.

Everything is from the deciding seat's point of view ("me" / "opp"), so one model plays both seats. The same
code runs at training time and at play time, so there is no train/play skew. numpy only (no tinygrad needed to
play).
"""
import json
import os

import numpy as np

SIDE = 20
HAND = 8
PROMPT_TYPES = ["actionWindow", "resource", "initiative", "triggerWindow", "optionalTrigger",
                "distributeAmongTargets", "displayCards", "number", "mulligan", "other"]
GLOBAL = 1 + 3 + 3 + len(PROMPT_TYPES) + 1 + 3 + 1 + 1 + 2
STATE_DIM = 2 * SIDE + HAND + GLOBAL  # 73
KINDS = ["button", "card", "option", "displayCard", "perCardButton", "distribute"]
BUTTONS = ["pass", "cancel", "done", "keep", "mulligan", "0", "1", "yes", "no", "claim", "skip", "other"]
ZONES = ["hand", "groundArena", "spaceArena", "base", "discard", "resource", "leader", "other"]
KEYWORDS = ["sentinel", "overwhelm", "raid", "restore", "saboteur", "shielded", "ambush", "grit", "bounty", "smuggle"]
CARD = 11 + len(KEYWORDS)
BOARD = 7
ACTION_DIM = len(KINDS) + len(BUTTONS) + len(ZONES) + 2 + CARD + BOARD + 4 + 2  # 62
ID_BUCKETS = 2048

# card tokens (JEPA only)
TOKEN_SLOTS = ["myHand", "myGround", "mySpace", "oppGround", "oppSpace", "myLeader", "oppLeader", "myBase", "oppBase"]
TOKEN_DIM = len(TOKEN_SLOTS) + 12
MAX_TOKENS = 32


class CardInfo:
    __slots__ = ("cost", "power", "hp", "unit", "event", "upgrade", "leader", "base", "token", "space", "keywords")


def load_cards(path=None):
    """Printed stats by set code ("SOR_042") from the engine's card data. Missing data gives an empty table."""
    path = path or os.environ.get("SWU_CARD_DATA", "forceteki/test/json")
    d = os.path.join(path, "Card") if os.path.isdir(os.path.join(path, "Card")) else path
    db = {}
    if not os.path.isdir(d):
        return db
    for name in os.listdir(d):
        try:
            with open(os.path.join(d, name), encoding="utf8") as fh:
                v = json.load(fh)
        except (OSError, ValueError):
            continue
        num = lambda k: float(v.get(k) or 0) if isinstance(v.get(k), (int, float)) else 0.0
        strs = lambda k: [s.lower() for s in (v.get(k) or []) if isinstance(s, str)]
        types, kws = strs("types"), strs("keywords")
        has = lambda t: any(t in x for x in types)
        i = CardInfo()
        i.cost, i.power, i.hp = num("cost"), num("power"), num("hp")
        i.unit, i.event, i.upgrade, i.leader, i.base, i.token = (has(t) for t in ("unit", "event", "upgrade", "leader", "base", "token"))
        i.space = v.get("arena") == "space"
        i.keywords = 0
        for bit, k in enumerate(KEYWORDS):
            if k in kws:
                i.keywords |= 1 << bit
        if i.upgrade and i.power == 0.0:
            i.power, i.hp = num("upgradePower"), num("upgradeHp")
        codes = list(v.get("setCodes") or [])
        if v.get("setId"):
            codes.append(v["setId"])
        for c in codes:
            if isinstance(c, dict) and isinstance(c.get("set"), str) and isinstance(c.get("number"), int):
                db[f"{c['set']}_{c['number']:03d}"] = i
    return db


def f(v, k):
    x = v.get(k) if isinstance(v, dict) else None
    return float(x) if isinstance(x, (int, float)) and not isinstance(x, bool) else 0.0


def arr(v, k):
    x = v.get(k) if isinstance(v, dict) else None
    return x if isinstance(x, list) else []


def hash_id(s):
    """FNV-1a, identical to the Rust bot's hash_id, so ids agree between Rust, Python and runs."""
    h = 0xcbf29ce484222325
    for b in s.encode("utf8"):
        h ^= b
        h = (h * 0x100000001b3) & 0xFFFFFFFFFFFFFFFF
    return h % ID_BUCKETS


def side_features(side, out):
    base = side.get("base") or {}
    base_hp = max(f(base, "hp"), 1.0)
    base_left = max(f(base, "hp") - f(base, "d"), 0.0)
    res = side.get("res") or {}
    leader = side.get("leader") or {}
    pow_g = sum(f(u, "p") for u in arr(side, "ground"))
    pow_s = sum(f(u, "p") for u in arr(side, "space"))
    hp_left = exhausted = ready_pow = sentinels = shields = ups = 0.0
    for u in arr(side, "ground") + arr(side, "space"):
        hp_left += max(f(u, "h") - f(u, "d"), 0.0)
        if f(u, "x") > 0:
            exhausted += 1
        else:
            ready_pow += f(u, "p")
        sentinels += f(u, "sn")
        for up in arr(u, "u"):
            if isinstance(up, dict) and up.get("n") == "Shield":
                shields += 1
            else:
                ups += 1
    out += [base_left / 30.0, base_left / base_hp, float(base_left <= 10.0), f(res, "ready") / 10.0, f(res, "total") / 10.0,
            f(side, "handCount") / 10.0, f(side, "deck") / 50.0, len(arr(side, "discard")) / 30.0,
            len(arr(side, "ground")) / 6.0, len(arr(side, "space")) / 6.0, pow_g / 20.0, pow_s / 20.0, hp_left / 30.0,
            exhausted / 6.0, ready_pow / 20.0, sentinels / 3.0, shields / 3.0, ups / 3.0, f(leader, "dep"), f(leader, "x")]


def prompt_type(prompt):
    t = prompt.get("type") if isinstance(prompt.get("type"), str) else ""
    title = prompt.get("title") if isinstance(prompt.get("title"), str) else ""
    if "mulligan" in title.lower():
        return 8
    return PROMPT_TYPES.index(t) if t in PROMPT_TYPES else len(PROMPT_TYPES) - 1


def _seats(msg):
    you = msg.get("you") or "p1"
    return you, ("p2" if you == "p1" else "p1")


def encode_state(msg, db):
    """The 73-number state vector (Rust STATE_DIM block)."""
    you, opp = _seats(msg)
    state = msg.get("state") or {}
    players = state.get("players") or {}
    me, them = players.get(you) or {}, players.get(opp) or {}
    prompt = msg.get("prompt") or {}
    s = []
    side_features(me, s)
    side_features(them, s)
    ready = f(me.get("res") or {}, "ready")
    cost = units_h = events = upgrades = playable = power = 0.0
    min_cost = 99.0
    hand = arr(me, "hand")
    for c in hand:
        i = db.get(c.get("s")) if isinstance(c, dict) else None
        if i:
            cost += i.cost
            units_h += i.unit
            events += i.event
            upgrades += i.upgrade
            playable += i.cost <= ready
            min_cost = min(min_cost, i.cost)
            power += i.power
    nh = float(len(hand))
    s += [cost / 30.0, units_h / 5.0, events / 5.0, upgrades / 5.0, playable / 5.0,
          min(min_cost, 10.0) / 10.0 if nh > 0 else 1.0, power / 20.0, nh / 10.0]
    s.append(f(state, "round") / 20.0)
    phase = state.get("phase") or ""
    s += [float(phase == p) for p in ("setup", "action", "regroup")]
    init = state.get("initiative")
    s += [float(init == you), float(init == opp), float(init is None)]
    pt = prompt_type(prompt)
    s += [float(k == pt) for k in range(len(PROMPT_TYPES))]
    s.append(float(prompt.get("actionWindow") is True))
    mode = prompt.get("selectCardMode")
    s += [float(mode == "single"), float(mode == "multiple"), float(mode is None)]
    s.append(len(arr(prompt, "selected")) / 5.0)
    s.append(min(float(len(arr(msg, "actions"))), 30.0) / 30.0)
    s.append(s[0] - s[SIDE])
    s.append(s[12] - s[SIDE + 12] + s[10] + s[11] - s[SIDE + 10] - s[SIDE + 11])
    assert len(s) == STATE_DIM
    return s


def encode_actions(msg, db):
    """Per legal action: the 62-number row and the hashed identity (Rust ACTION_DIM block)."""
    you, opp = _seats(msg)
    state = msg.get("state") or {}
    players = state.get("players") or {}
    me, them = players.get(you) or {}, players.get(opp) or {}
    prompt = msg.get("prompt") or {}
    ready = f(me.get("res") or {}, "ready")
    mode = prompt.get("selectCardMode")
    board = {}
    for side, mine in ((me, True), (them, False)):
        for u in arr(side, "ground") + arr(side, "space"):
            if isinstance(u, dict) and isinstance(u.get("id"), str):
                board[u["id"]] = (u, mine)
    base_them = (them.get("base") or {}).get("id")
    base_me = (me.get("base") or {}).get("id")
    rows, ids = [], []
    for a in arr(msg, "actions"):
        r = [0.0] * ACTION_DIM
        o = 0
        kind = a.get("kind") if isinstance(a.get("kind"), str) else ""
        if kind in KINDS:
            r[o + KINDS.index(kind)] = 1.0
        o += len(KINDS)
        label = (a.get("label") if isinstance(a.get("label"), str) else "").lower()
        av = a.get("arg")
        if isinstance(av, str):
            arg = av.lower()
        elif isinstance(av, bool) or av is None:
            arg = ""
        elif isinstance(av, int):
            arg = str(av)
        elif isinstance(av, float):
            arg = str(int(av)) if av.is_integer() else repr(av)
        else:
            arg = ""
        if kind in ("button", "perCardButton"):
            b = next((k for k, bt in enumerate(BUTTONS) if arg == bt or label == bt or (len(bt) > 2 and label.startswith(bt))), len(BUTTONS) - 1)
            r[o + b] = 1.0
        o += len(BUTTONS)
        card = a.get("card") if isinstance(a.get("card"), dict) else None
        code = None
        if card is not None:
            zone = card.get("zone") if isinstance(card.get("zone"), str) else "other"
            r[o + (ZONES.index(zone) if zone in ZONES else len(ZONES) - 1)] = 1.0
            code = card.get("s") if isinstance(card.get("s"), str) else None
        o += len(ZONES)
        if card is not None:
            r[o] = float(card.get("ctl") == you)
            r[o + 1] = float(card.get("ctl") == opp)
        o += 2
        i = db.get(card.get("s")) if card is not None else None
        if i:
            r[o:o + 11] = [i.cost / 10.0, i.power / 10.0, i.hp / 10.0, float(i.unit), float(i.event), float(i.upgrade),
                           float(i.leader), float(i.base), float(i.token), float(i.space), float(i.cost <= ready)]
            for b in range(len(KEYWORDS)):
                r[o + 11 + b] = float((i.keywords >> b) & 1)
        o += CARD
        cid = card.get("id") if card is not None and isinstance(card.get("id"), str) else None
        if cid is None and isinstance(a.get("cardUuid"), str):
            cid = a["cardUuid"]
        if cid is not None and cid in board:
            u, mine = board[cid]
            r[o:o + BOARD] = [1.0, float(mine), f(u, "p") / 10.0, max(f(u, "h") - f(u, "d"), 0.0) / 10.0, f(u, "x"), f(u, "sn"), len(arr(u, "u")) / 3.0]
        o += BOARD
        d = a.get("distribute")
        if isinstance(d, dict):
            r[o] = f(d, "amount") / 10.0
            r[o + 1] = len(arr(d, "targets")) / 10.0
        if kind == "option":
            try:
                r[o + 2] = float(arg) / 10.0
            except ValueError:
                pass
        r[o + 3] = float(mode == "multiple" and kind == "card")
        o += 4
        r[o] = float(cid is not None and cid == base_them)
        r[o + 1] = float(cid is not None and cid == base_me)
        o += 2
        assert o == ACTION_DIM
        rows.append(r)
        key = f"card:{code}" if code is not None else f"{kind}:{arg if arg else label}"
        ids.append(hash_id(key))
    return rows, ids


def encode_tokens(msg, db):
    """Card tokens: (ids [MAX_TOKENS], feats [MAX_TOKENS, TOKEN_DIM], mask [MAX_TOKENS])."""
    you, opp = _seats(msg)
    players = (msg.get("state") or {}).get("players") or {}
    me, them = players.get(you) or {}, players.get(opp) or {}
    ready = f(me.get("res") or {}, "ready")
    items = []
    for slot, cards in (("myLeader", [me.get("leader")]), ("oppLeader", [them.get("leader")]),
                        ("myBase", [me.get("base")]), ("oppBase", [them.get("base")]),
                        ("myGround", arr(me, "ground")), ("mySpace", arr(me, "space")),
                        ("oppGround", arr(them, "ground")), ("oppSpace", arr(them, "space")), ("myHand", arr(me, "hand"))):
        for c in cards:
            if isinstance(c, dict):
                items.append((slot, c))
    items = items[:MAX_TOKENS]
    ids = np.zeros(MAX_TOKENS, np.int32)
    feats = np.zeros((MAX_TOKENS, TOKEN_DIM), np.float32)
    mask = np.zeros(MAX_TOKENS, np.float32)
    for k, (slot, c) in enumerate(items):
        code = c.get("s") if isinstance(c.get("s"), str) else ""
        i = db.get(code)
        ids[k] = hash_id(f"card:{code}")
        mask[k] = 1.0
        row = feats[k]
        row[TOKEN_SLOTS.index(slot)] = 1.0
        o = len(TOKEN_SLOTS)
        hp = f(c, "h") if "h" in c else f(c, "hp")
        row[o:o + 12] = [f(c, "p") / 10.0, max(hp - f(c, "d"), 0.0) / 10.0, f(c, "x"), f(c, "sn"), len(arr(c, "u")) / 3.0,
                         f(c, "dep"), (i.cost / 10.0) if i else 0.0, float(i.unit) if i else 0.0, float(i.event) if i else 0.0,
                         float(i.upgrade) if i else 0.0, float(i.cost <= ready) if i else 0.0, float(i.space) if i else 0.0]
    return ids, feats, mask


def encode(msg, db):
    """Everything the model reads for one decision."""
    s = np.asarray(encode_state(msg, db), np.float32)
    rows, ids = encode_actions(msg, db)
    tid, tf, tm = encode_tokens(msg, db)
    return {"state": s, "actions": np.asarray(rows, np.float32).reshape(-1, ACTION_DIM), "aids": np.asarray(ids, np.int32),
            "tok_ids": tid, "tok_feats": tf, "tok_mask": tm}
