"""Board model built from a `decide` message, and the evaluation the bot plays by.

Evaluation idea ("the clock"): a unit is worth the base damage it will deal before it dies, plus a little for its body.
One point of base damage is worth more the closer that base is to 0. Who is ahead in the damage race shifts weight
between hitting the base and killing units.
"""
import math
import os

LIFETIME = float(os.environ.get("SWU_PY_LIFETIME", "2.2"))   # rounds a unit is expected to keep attacking
BODY_HP = 0.45       # value of one point of remaining HP
SHIELD = 1.8
SENTINEL = 1.5
LETHAL = 1000.0


def urgency(remaining):
    """Value of one point of damage to a base with `remaining` HP left."""
    return 1.0 + 6.0 / (max(remaining, 0) + 3.0)


class Unit:
    __slots__ = ("id", "name", "s", "power", "hp", "dmg", "exhausted", "sentinel", "shields", "upgrades", "arena",
                 "mine", "card", "raid", "restore", "overwhelm", "saboteur", "grit", "leader", "token")

    def __init__(self, v, arena, mine, db, leader_id=None):
        self.id = v["id"]
        self.name = v.get("n") or ""
        self.s = v.get("s")
        self.power = v.get("p") or 0
        self.hp = v.get("h") or 0
        self.dmg = v.get("d") or 0
        self.exhausted = bool(v.get("x"))
        self.sentinel = bool(v.get("sn"))
        ups = v.get("u") or []
        self.shields = sum(1 for u in ups if u.get("n") == "Shield")
        self.upgrades = len(ups)
        self.arena = arena
        self.mine = mine
        self.card = db.find(self.s, None, self.name) if db is not None else None
        kw = self.card.keywords if self.card else set()
        self.raid = self.card.raid if self.card else 0
        self.restore = self.card.restore if self.card else 0
        self.overwhelm = "overwhelm" in kw
        self.saboteur = "saboteur" in kw
        self.grit = "grit" in kw
        self.leader = leader_id is not None and self.id == leader_id
        self.token = self.s is None and not self.leader

    @property
    def remaining(self):
        return self.hp - self.dmg

    @property
    def attack_power(self):
        return self.power + self.raid

    def copy(self):
        u = Unit.__new__(Unit)
        for k in Unit.__slots__:
            setattr(u, k, getattr(self, k))
        return u

    def __repr__(self):
        return "%s(%d/%d-%d%s%s)" % (self.name, self.power, self.hp, self.dmg, " x" if self.exhausted else "",
                                    " S%d" % self.shields if self.shields else "")


class Side:
    def __init__(self, pv, mine, db):
        self.name = pv.get("name")
        base = pv.get("base") or {}
        self.base_id = base.get("id")
        self.base_card = db.find(base.get("s"), None, base.get("n")) if db is not None else None
        self.base_hp = base.get("hp") or 30
        self.base_dmg = base.get("d") or 0
        leader = pv.get("leader") or {}
        self.leader_id = leader.get("id")
        self.leader_card = db.find(leader.get("s"), None, leader.get("n")) if db is not None and leader else None
        self.leader_deployed = bool(leader.get("dep"))
        self.leader_exhausted = bool(leader.get("x"))
        res = pv.get("res") or {}
        self.ready = res.get("ready") or 0
        self.resources = res.get("total") or 0
        self.hand_count = pv.get("handCount", len(pv.get("hand") or []))
        self.deck = pv.get("deck") or 0
        self.hand = pv.get("hand") or []
        self.resource_cards = pv.get("resources") or []
        self.discard = pv.get("discard") or []
        self.units = [Unit(v, "ground", mine, db, self.leader_id) for v in pv.get("ground") or []]
        self.units += [Unit(v, "space", mine, db, self.leader_id) for v in pv.get("space") or []]
        aspects = []
        for c in (self.leader_card, self.base_card):
            if c is not None:
                aspects += c.aspects
        self.aspects = aspects

    @property
    def base_remaining(self):
        return self.base_hp - self.base_dmg


class Board:
    """Both sides from my seat, plus the value functions."""

    def __init__(self, msg, db):
        self.db = db
        self.you = msg["you"]
        st = msg.get("state") or {}
        players = st.get("players") or {}
        self.opp_seat = next((k for k in players if k != self.you), "p2" if self.you == "p1" else "p1")
        self.me = Side(players.get(self.you) or {}, True, db)
        self.opp = Side(players.get(self.opp_seat) or {}, False, db)
        self.round = st.get("round") or 0
        self.phase = st.get("phase")
        self.initiative = st.get("initiative")
        self.units = {u.id: u for u in self.me.units + self.opp.units}

    def has_initiative(self):
        return self.initiative == self.you

    def side_of(self, card_id):
        if card_id in self.units:
            return self.me if self.units[card_id].mine else self.opp
        if card_id == self.me.base_id or card_id == self.me.leader_id:
            return self.me
        if card_id == self.opp.base_id or card_id == self.opp.leader_id:
            return self.opp
        return None

    # ---- the clock ----

    def clocks(self):
        """Rounds each side needs to kill the other base if every unit hit the base each round (inf if no damage)."""
        def clock(attackers, base_remaining):
            dpr = sum(max(u.attack_power, 0) for u in attackers)
            return math.inf if dpr <= 0 else math.ceil(max(base_remaining, 0) / dpr)
        return clock(self.me.units, self.opp.base_remaining), clock(self.opp.units, self.me.base_remaining)

    def weights(self):
        """(value of 1 damage to the opponent base, value of 1 damage to mine), skewed by who wins the race."""
        mine, theirs = self.clocks()
        w_opp = urgency(self.opp.base_remaining)
        w_me = urgency(self.me.base_remaining)
        if mine < theirs or (mine == theirs and self.has_initiative()):
            w_opp *= 1.2      # I am the beatdown: push damage
        elif theirs < mine:
            w_me *= 1.25      # I am behind: their units are the problem
        return w_opp, w_me

    def unit_value(self, u, w=None):
        """Damage it will deal before dying, plus its body."""
        w_opp, w_me = w or self.weights()
        if u.remaining <= 0:
            return 0.0
        threat = max(u.attack_power, 0) * LIFETIME * (w_opp if u.mine else w_me)
        body = BODY_HP * u.remaining + SHIELD * u.shields + (SENTINEL if u.sentinel else 0.0)
        if u.overwhelm:
            body += 0.5
        if u.leader:
            body += 1.0
        return threat + body
