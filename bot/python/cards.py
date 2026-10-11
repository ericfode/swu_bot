"""Card data from the engine's card JSON (forceteki/test/json/Card/*.json, the output of `npm run get-cards`).

The stdio protocol sends card names and set codes but no costs or keywords, so the bot reads them here.
"""
import json
import os
import re

DEFAULT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "forceteki", "test", "json")

_N_KEYWORDS = {"raid": re.compile(r"\braid (\d+)"), "restore": re.compile(r"\brestore (\d+)")}


class Card:
    """Static data of one card. Missing numbers are 0, missing lists are empty."""

    __slots__ = ("title", "subtitle", "internal", "cost", "power", "hp", "text", "deploy_text", "types", "keywords",
                 "arena", "aspects", "traits", "up_power", "up_hp", "unique", "raid", "restore")

    def __init__(self, d):
        self.title = d.get("title") or ""
        self.subtitle = d.get("subtitle") or ""
        self.internal = d.get("internalName") or ""
        self.cost = d.get("cost") or 0
        self.power = d.get("power") or 0
        self.hp = d.get("hp") or 0
        self.text = (d.get("text") or "").lower()
        self.deploy_text = (d.get("deployBox") or "").lower()
        self.types = set(d.get("types") or [])
        self.keywords = set(k.lower() for k in (d.get("keywords") or []))
        self.arena = d.get("arena")
        self.aspects = list(d.get("aspects") or [])
        self.traits = set(d.get("traits") or [])
        self.up_power = d.get("upgradePower") or 0
        self.up_hp = d.get("upgradeHp") or 0
        self.unique = bool(d.get("unique"))
        text = self.text + " " + self.deploy_text
        self.raid = _first_int(_N_KEYWORDS["raid"], text) if "raid" in self.keywords else 0
        self.restore = _first_int(_N_KEYWORDS["restore"], text) if "restore" in self.keywords else 0

    def is_unit(self):
        return "unit" in self.types

    def is_event(self):
        return "event" in self.types

    def is_upgrade(self):
        return "upgrade" in self.types

    def is_leader(self):
        return "leader" in self.types

    def __repr__(self):
        return "Card(%s %d %d/%d)" % (self.internal, self.cost, self.power, self.hp)


def _first_int(rx, text):
    m = rx.search(text)
    return int(m.group(1)) if m else 1


def set_code(set_id):
    if set_id.get("set") is None or set_id.get("number") is None:
        return None
    return "%s_%03d" % (set_id["set"], set_id["number"])


class CardDb:
    def __init__(self):
        self.by_set = {}
        self.by_internal = {}
        self.by_title = {}

    def add(self, d):
        c = Card(d)
        for sid in d.get("setCodes") or ([d["setId"]] if d.get("setId") else []):
            code = set_code(sid)
            if code:
                self.by_set.setdefault(code, c)
        if c.internal:
            self.by_internal[c.internal] = c
        self.by_title.setdefault(c.title.lower(), c)
        return c

    @classmethod
    def load(cls, path=None):
        db = cls()
        folder = os.path.join(path or os.environ.get("SWU_CARD_JSON") or DEFAULT_DIR, "Card")
        if not os.path.isdir(folder):
            return db
        for name in os.listdir(folder):
            if name.endswith(".json"):
                with open(os.path.join(folder, name), encoding="utf-8") as f:
                    db.add(json.load(f))
        return db

    def __len__(self):
        return len(self.by_internal)

    def find(self, s=None, label=None, title=None):
        """Best match for a card seen on the wire: set code, then internal name (action label), then title."""
        if s and s in self.by_set:
            return self.by_set[s]
        if label and label in self.by_internal:
            return self.by_internal[label]
        if title:
            return self.by_title.get(title.lower())
        return None


def aspect_penalty(card, have):
    """Extra cost: 2 per aspect icon on the card that the leader and base do not provide (icons count with repeats)."""
    pool = list(have)
    missing = 0
    for a in card.aspects:
        if a in pool:
            pool.remove(a)
        else:
            missing += 1
    return 2 * missing
