"""Reads what a prompt or card text wants done ("Deal 3 damage to a unit", "Give a Shield token", ...).

Returns an Intent: what kind of effect, an amount, and whether it is meant for enemy cards (harm) or mine (help).
Unknown text gives kind None; callers then fall back to the HARM / HELP word lists.
"""
import re

HARM_WORDS = re.compile(r"defeat|damage|exhaust|capture|return|discard|take control|destroy|deal|disable|-\d+/-\d+|"
                        r"can't attack|cannot attack|bottom of")
HELP_WORDS = re.compile(r"heal|shield|experience|give|ready|attach|restore|\+\d+/\+\d+|play|draw|search|token")

_NUM = {"a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5}

_RULES = [
    ("damage", re.compile(r"deal (\d+) damage")),
    ("defeat", re.compile(r"\bdefeat\b(?! all)")),
    ("capture", re.compile(r"\bcapture")),
    ("bounce", re.compile(r"return [^.]*?to (?:its|their) owner'?s? hand")),
    ("debuff", re.compile(r"-(\d+)/-(\d+)")),
    ("exhaust", re.compile(r"\bexhaust (?:an?|another|target|each|up to)")),
    ("heal", re.compile(r"heal (\d+|all) damage")),
    ("shield", re.compile(r"shield token")),
    ("experience", re.compile(r"experience token")),
    ("buff", re.compile(r"\+(\d+)/\+(\d+)")),
    ("ready", re.compile(r"\bready (?:an?|another|target|up to)")),
    ("attack", re.compile(r"attack with")),
    ("draw", re.compile(r"draw (a|an|one|two|three|\d+) cards?")),
    ("tokens", re.compile(r"create (?:a|an|one|two|three|\d+) [^.]*tokens?")),
]

HARM_KINDS = {"damage", "defeat", "capture", "bounce", "debuff", "exhaust"}
HELP_KINDS = {"heal", "shield", "experience", "buff", "ready", "attack", "draw", "tokens"}


class Intent:
    __slots__ = ("kind", "n", "harm", "limit", "limit_kind", "enemy_only", "arena")

    def __init__(self, kind=None, n=0, harm=None):
        self.kind = kind
        self.n = n
        self.harm = harm
        self.limit = None          # "with 5 or less remaining HP" / "that costs 3 or less" / "with 2 or less power"
        self.limit_kind = None
        self.enemy_only = False
        self.arena = None

    def __repr__(self):
        return "Intent(%s %s %s)" % (self.kind, self.n, "harm" if self.harm else "help" if self.harm is False else "?")


def _int(tok):
    tok = tok.lower()
    return int(tok) if tok.isdigit() else _NUM.get(tok, 1)


def parse(text):
    """First effect named in `text` (lower case)."""
    text = (text or "").lower()
    best = None
    for kind, rx in _RULES:
        m = rx.search(text)
        if m and (best is None or m.start() < best[1].start()):
            best = (kind, m)
    if best is None:
        if HARM_WORDS.search(text):
            return Intent(None, 0, True)
        if HELP_WORDS.search(text):
            return Intent(None, 0, False)
        return Intent()
    kind, m = best
    it = Intent(kind, 0, kind in HARM_KINDS)
    if kind in ("damage", "heal") and m.group(1) != "all":
        it.n = int(m.group(1))
    elif kind == "heal":
        it.n = 99
    elif kind in ("debuff", "buff"):
        it.n = int(m.group(1))
    elif kind in ("draw", "tokens"):
        it.n = _int(m.group(1)) if m.groups() else 1
    rest = text[m.start():m.start() + 120]
    lim = re.search(r"with (\d+) or less remaining hp|with (\d+) or less hp|costs? (\d+) or less|with (\d+) or less power",
                    rest)
    if lim:
        g = lim.groups()
        if g[0] or g[1]:
            it.limit, it.limit_kind = int(g[0] or g[1]), "hp"
        elif g[2]:
            it.limit, it.limit_kind = int(g[2]), "cost"
        else:
            it.limit, it.limit_kind = int(g[3]), "power"
    it.enemy_only = bool(re.search(r"\benemy\b", rest))
    if re.search(r"\bground unit", rest):
        it.arena = "ground"
    elif re.search(r"\bspace unit", rest):
        it.arena = "space"
    return it


def wanted(title):
    """How many cards a select prompt asks for: (min, max) from 'Select 2 cards', 'between 0 and 1', 'up to 3'."""
    t = (title or "").lower()
    m = re.search(r"between (\d+) and (\d+)", t)
    if m:
        return int(m.group(1)), int(m.group(2))
    m = re.search(r"(?:select|choose)\s+up to\s+(\d+|a|an|one|two|three)", t)
    if m:
        return 0, _int(m.group(1))
    m = re.search(r"(?:select|choose|discard|resource)\s+(\d+|a|an|one|two|three)\b", t)
    if m:
        n = _int(m.group(1))
        return n, n
    return 1, 1
