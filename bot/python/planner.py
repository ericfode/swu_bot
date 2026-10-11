"""Attack planner: beam search over sequences of attacks on a stats-only copy of the board.

The engine cannot be rolled back over stdio, so the bot simulates combat itself: each attack deals the attacker's
power (+Raid) to the target and the defender's power back, shields absorb one hit, Overwhelm spills over to the base,
Sentinel forces targets, Saboteur ignores Sentinel, Restore heals my base. That is enough to see plays a one-attack
greedy bot misses: two small units killing one big one, or killing a Sentinel first so the rest can hit the base.
"""
from board import LETHAL

BASE = "base"


class Sim:
    __slots__ = ("my", "opp", "ready", "opp_base", "my_base_dmg")

    def __init__(self, my, opp, ready, opp_base, my_base_dmg):
        self.my = my              # id -> Unit (my units)
        self.opp = opp            # id -> Unit (enemy units still alive)
        self.ready = ready        # frozenset of my unit ids that can still attack
        self.opp_base = opp_base  # remaining HP of the enemy base
        self.my_base_dmg = my_base_dmg

    def key(self):
        return (self.ready, self.opp_base, tuple(sorted((k, u.dmg, u.shields) for k, u in self.opp.items())),
                tuple(sorted((k, u.dmg, u.shields) for k, u in self.my.items())))


def targets(sim, aid):
    """Legal targets for my unit `aid`: enemy units in its arena or the base, Sentinels first."""
    a = sim.my[aid]
    enemies = [u for u in sim.opp.values() if u.arena == a.arena]
    if not a.saboteur:
        sentinels = [u.id for u in enemies if u.sentinel]
        if sentinels:
            return sentinels
    return [u.id for u in enemies] + [BASE]


def strike(attacker, defender):
    """Combat damage: returns (attacker after, defender after, excess for Overwhelm). Units are copied."""
    a = attacker.copy()
    d = defender.copy()
    dealt = max(a.attack_power, 0)
    back = max(d.power, 0)
    excess = 0
    if d.shields and dealt > 0:
        d.shields -= 1
    else:
        excess = max(0, dealt - d.remaining)
        d.dmg += dealt
    if a.shields and back > 0:
        a.shields -= 1
    else:
        a.dmg += back
    a.exhausted = True
    return a, d, excess


def apply(sim, aid, tgt, value, w):
    """One attack. Returns (new sim, value change). `value(unit, w)` is Board.unit_value."""
    w_opp, w_me = w
    a = sim.my[aid]
    my = dict(sim.my)
    opp = sim.opp
    delta = 0.0
    if a.restore and sim.my_base_dmg:
        delta += min(a.restore, sim.my_base_dmg) * w_me * 0.8
    if tgt == BASE:
        dealt = max(a.attack_power, 0)
        base = sim.opp_base - dealt
        a2 = a.copy()
        a2.exhausted = True
        my[aid] = a2
    else:
        d = opp[tgt]
        a2, d2, excess = strike(a, d)
        opp = dict(opp)
        delta += value(d, w) - value(d2, w)
        if d2.remaining <= 0:
            del opp[tgt]
        else:
            opp[tgt] = d2
        delta -= value(a, w) - value(a2, w)
        if a2.remaining <= 0:
            del my[aid]
        else:
            my[aid] = a2
        dealt = excess if a.overwhelm else 0
        base = sim.opp_base - dealt
    if dealt > 0:
        delta += dealt * w_opp
        if base <= 0 < sim.opp_base:
            delta += LETHAL
    return Sim(my, opp, sim.ready - {aid}, base, sim.my_base_dmg), delta


def plan(board, ready_ids, w=None, width=16):
    """Best attack sequence for my ready units. Returns (value, [(attacker id, target id or BASE), ...]).

    Any prefix of a sequence can be the plan (units may stay home). Moves that hit units come first in the
    returned order: base hits never enable anything, while killing a Sentinel can.
    """
    w = w or board.weights()
    value = board.unit_value
    my = {u.id: u for u in board.me.units}
    ready = frozenset(i for i in ready_ids if i in my)
    root = Sim(my, {u.id: u for u in board.opp.units}, ready, board.opp.base_remaining, board.me.base_dmg)
    beam = [(0.0, [], root)]
    best = (0.0, [])
    for _ in range(len(ready)):
        nxt = {}
        for score, moves, sim in beam:
            for aid in sim.ready:
                for tgt in targets(sim, aid):
                    s2, d = apply(sim, aid, tgt, value, w)
                    total = score + d
                    k = s2.key()
                    if k not in nxt or nxt[k][0] < total:
                        nxt[k] = (total, moves + [(aid, tgt)], s2)
        if not nxt:
            break
        beam = sorted(nxt.values(), key=lambda x: -x[0])[:width]
        if beam[0][0] > best[0]:
            best = (beam[0][0], beam[0][1])
    total, moves = best
    units_first = [m for m in moves if m[1] != BASE] + [m for m in moves if m[1] == BASE]
    return total, units_first


def best_target(board, attacker, offered, w=None):
    """Score each offered target id for one attack (`BASE` for the enemy base). Returns {id: value}."""
    w = w or board.weights()
    my = {u.id: u for u in board.me.units}
    if attacker is None or attacker.id not in my:
        return {}
    sim = Sim(my, {u.id: u for u in board.opp.units}, frozenset([attacker.id]), board.opp.base_remaining,
              board.me.base_dmg)
    out = {}
    for t in offered:
        if t == BASE or t in sim.opp:
            out[t] = apply(sim, attacker.id, t, board.unit_value, w)[1]
    return out
