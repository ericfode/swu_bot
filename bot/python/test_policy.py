"""Unit tests on mock boards (no engine, no card files): python3 -m unittest discover -s bot/python"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import effects  # noqa: E402
import planner  # noqa: E402
from board import Board  # noqa: E402
from cards import CardDb, aspect_penalty  # noqa: E402
from policy import Policy  # noqa: E402


def make_db():
    db = CardDb()
    for d in [
        {"title": "Wampa", "internalName": "wampa", "cost": 4, "power": 4, "hp": 5, "aspects": ["aggression"], "types": ["unit"],
         "arena": "ground", "setId": {"set": "SOR", "number": 38}},
        {"title": "Cheap Guy", "internalName": "cheap-guy", "cost": 1, "power": 1, "hp": 2, "aspects": ["villainy"], "types": ["unit"],
         "arena": "ground", "setId": {"set": "SOR", "number": 1}},
        {"title": "Big Ship", "internalName": "big-ship", "cost": 8, "power": 8, "hp": 8, "aspects": ["heroism", "heroism"],
         "types": ["unit"], "arena": "space", "setId": {"set": "SOR", "number": 2}},
        {"title": "Takedown", "internalName": "takedown", "cost": 4, "text": "Defeat a unit with 5 or less remaining HP.",
         "aspects": [], "types": ["event"], "setId": {"set": "SOR", "number": 77}},
        {"title": "Wall", "internalName": "wall", "cost": 3, "power": 1, "hp": 6, "keywords": ["sentinel"], "aspects": [],
         "types": ["unit"], "arena": "ground", "setId": {"set": "SOR", "number": 3}},
        {"title": "Darth Vader", "internalName": "vader", "cost": 7, "power": 5, "hp": 8, "aspects": ["aggression", "villainy"],
         "types": ["leader"], "setId": {"set": "SOR", "number": 10}},
        {"title": "Outpost", "internalName": "outpost", "hp": 30, "aspects": ["vigilance"], "types": ["base"],
         "setId": {"set": "LAW", "number": 19}},
    ]:
        db.add(d)
    return db


DB = make_db()
WINDOW = {"type": "actionWindow", "signature": "actionWindow|-", "title": "Choose an action", "promptTitle": "Action Window",
          "selectCardMode": None, "selected": [], "actionWindow": True}
ATTACK = {"type": None, "signature": "-|single", "title": "Choose a target for attack", "promptTitle": "Rebel",
          "selectCardMode": "single", "selected": [], "actionWindow": False}


def unit(i, p, h, d=0, **kw):
    u = {"id": i, "n": kw.pop("n", i), "s": kw.pop("s", None), "p": p, "h": h, "d": d}
    u.update(kw)
    return u


def side(name, base_d=0, ground=(), space=(), hand=(), ready=4, total=4, mine=False):
    s = {"name": name, "base": {"id": name + "-base", "n": "Outpost", "s": "LAW_019", "hp": 30, "d": base_d},
         "leader": {"id": name + "-leader", "n": "Darth Vader", "s": "SOR_010", "dep": 0, "x": 0},
         "res": {"ready": ready, "total": total}, "handCount": len(hand), "deck": 30, "discard": [],
         "ground": list(ground), "space": list(space)}
    if mine:
        s["hand"] = list(hand)
        s["resources"] = []
    return s


def msg(prompt, me, opp, actions, rnd=3):
    for i, a in enumerate(actions):
        a["i"] = i
    return {"t": "decide", "seq": 1, "you": "p1", "prompt": prompt,
            "state": {"round": rnd, "phase": "action", "initiative": "p2", "players": {"p1": me, "p2": opp}},
            "actions": actions}


def card_act(label, cid, zone, ctl, s=None):
    return {"kind": "card", "label": label, "cardUuid": cid, "card": {"id": cid, "n": label, "s": s, "zone": zone, "ctl": ctl}}


def button(label):
    return {"kind": "button", "label": label}


class EffectsTest(unittest.TestCase):
    def test_reads_damage_and_limits(self):
        it = effects.parse("deal 3 damage to a ground unit")
        self.assertEqual((it.kind, it.n, it.harm, it.arena), ("damage", 3, True, "ground"))
        it = effects.parse("defeat a unit with 5 or less remaining hp.")
        self.assertEqual((it.kind, it.limit, it.limit_kind), ("defeat", 5, "hp"))
        self.assertEqual(effects.parse("give a shield token to a unit").kind, "shield")
        self.assertFalse(effects.parse("give a shield token to a unit").harm)

    def test_wanted_counts(self):
        self.assertEqual(effects.wanted("Select 2 cards to resource"), (2, 2))
        self.assertEqual(effects.wanted("Select between 0 and 1 cards to resource"), (0, 1))
        self.assertEqual(effects.wanted("Choose up to 3 units"), (0, 3))

    def test_aspect_penalty_counts_each_missing_icon(self):
        self.assertEqual(aspect_penalty(DB.find(None, "big-ship"), ["heroism", "vigilance"]), 2)
        self.assertEqual(aspect_penalty(DB.find(None, "wampa"), ["aggression"]), 0)


class PlannerTest(unittest.TestCase):
    def test_two_small_units_kill_a_big_one_together(self):
        me = side("p1", ground=[unit("a1", 3, 7), unit("a2", 3, 7)], mine=True)
        opp = side("p2", base_d=0, ground=[unit("e1", 6, 5)])
        b = Board(msg(WINDOW, me, opp, []), DB)
        total, moves = planner.plan(b, ["a1", "a2"])
        self.assertEqual([t for _, t in moves].count("e1"), 2, moves)

    def test_no_gang_attack_when_both_attackers_die(self):
        me = side("p1", ground=[unit("a1", 3, 4), unit("a2", 3, 4)], mine=True)
        opp = side("p2", base_d=0, ground=[unit("e1", 5, 6)])
        b = Board(msg(WINDOW, me, opp, []), DB)
        total, moves = planner.plan(b, ["a1", "a2"])
        self.assertEqual([t for _, t in moves], [planner.BASE, planner.BASE])

    def test_kills_the_sentinel_first_then_hits_the_base(self):
        me = side("p1", ground=[unit("a1", 4, 6), unit("a2", 5, 5)], mine=True)
        opp = side("p2", base_d=22, ground=[unit("wall", 1, 3, sn=1)])
        b = Board(msg(WINDOW, me, opp, []), DB)
        total, moves = planner.plan(b, ["a1", "a2"])
        self.assertEqual(moves[0][1], "wall")
        self.assertEqual(moves[1][1], planner.BASE)

    def test_saboteur_defeats_shields_before_damage(self):
        me = side("p1", ground=[unit("a1", 4, 6)], mine=True)
        opp = side("p2", ground=[unit("e1", 2, 3, u=[{"id": "s1", "n": "Shield", "s": None, "t": 1}])])
        b = Board(msg(WINDOW, me, opp, []), DB)
        a = b.units["a1"]
        a.saboteur = True
        _, d, _ = planner.strike(a, b.units["e1"])
        self.assertEqual((d.shields, d.remaining), (0, -1))

    def test_restore_heals_once_per_damage(self):
        me = side("p1", base_d=2, ground=[unit("a1", 1, 9), unit("a2", 1, 9)], mine=True)
        b = Board(msg(WINDOW, me, side("p2"), []), DB)
        for u in b.me.units:
            u.restore = 2
        w = b.weights()
        sim = planner.Sim({u.id: u for u in b.me.units}, {}, frozenset(["a1", "a2"]), 30, 2)
        s1, d1 = planner.apply(sim, "a1", planner.BASE, b.unit_value, w)
        s2, d2 = planner.apply(s1, "a2", planner.BASE, b.unit_value, w)
        self.assertEqual(s2.my_base_dmg, 0)
        self.assertLess(d2, d1)

    def test_lethal(self):
        me = side("p1", ground=[unit("a1", 4, 6), unit("a2", 4, 5)], mine=True)
        opp = side("p2", base_d=23, ground=[unit("e1", 6, 6)])
        b = Board(msg(WINDOW, me, opp, []), DB)
        total, moves = planner.plan(b, ["a1", "a2"])
        self.assertGreater(total, 500)
        self.assertTrue(all(t == planner.BASE for _, t in moves))


class PolicyTest(unittest.TestCase):
    def setUp(self):
        self.p = Policy(DB)

    def pick(self, m):
        reply = self.p.decide(m)
        return m["actions"][reply["i"]], reply

    def test_spends_resources_and_holds_removal_without_targets(self):
        me = side("p1", ready=5, total=5, mine=True,
                  hand=[{"id": "h1", "n": "Cheap Guy", "s": "SOR_001"}, {"id": "h2", "n": "Wampa", "s": "SOR_038"},
                        {"id": "h3", "n": "Takedown", "s": "SOR_077"}])
        opp = side("p2")
        acts = [button("Pass"), card_act("cheap-guy", "h1", "hand", "p1", "SOR_001"), card_act("wampa", "h2", "hand", "p1", "SOR_038"),
                card_act("takedown", "h3", "hand", "p1", "SOR_077")]
        a, _ = self.pick(msg(WINDOW, me, opp, acts))
        self.assertEqual(a["label"], "wampa")

    def test_takes_lethal_before_playing_cards(self):
        me = side("p1", ground=[unit("u1", 5, 5)], hand=[{"id": "h2", "n": "Wampa", "s": "SOR_038"}], mine=True)
        opp = side("p2", base_d=26)
        acts = [button("Pass"), card_act("wampa", "h2", "hand", "p1", "SOR_038"), card_act("u1", "u1", "groundArena", "p1")]
        a, _ = self.pick(msg(WINDOW, me, opp, acts))
        self.assertEqual(a["label"], "u1")
        # and the follow-up target prompt picks the base
        acts = [button("Cancel"), card_act("outpost", "p2-base", "base", "p2"), card_act("e", "e1", "groundArena", "p2")]
        a, _ = self.pick(msg(ATTACK, me, opp, acts))
        self.assertEqual(a["card"]["id"], "p2-base")

    def test_free_kill_but_no_suicide(self):
        me = side("p1", ground=[unit("u1", 4, 5)], mine=True)
        opp = side("p2", ground=[unit("e1", 2, 3), unit("e2", 9, 9)])
        self.p.attacker = "u1"
        acts = [button("Cancel"), card_act("outpost", "p2-base", "base", "p2"), card_act("e1", "e1", "groundArena", "p2"),
                card_act("e2", "e2", "groundArena", "p2")]
        a, _ = self.pick(msg(ATTACK, me, opp, acts))
        self.assertEqual(a["card"]["id"], "e1")

    def test_damage_event_goes_for_the_kill(self):
        prompt = {"type": None, "signature": "-|single", "title": "Deal 3 damage to a unit", "promptTitle": "Zap",
                  "selectCardMode": "single", "selected": [], "actionWindow": False}
        me = side("p1", ground=[unit("u1", 2, 2)], mine=True)
        opp = side("p2", ground=[unit("big", 6, 8), unit("mid", 3, 3)])
        acts = [card_act("u1", "u1", "groundArena", "p1"), card_act("big", "big", "groundArena", "p2"),
                card_act("mid", "mid", "groundArena", "p2")]
        a, _ = self.pick(msg(prompt, me, opp, acts))
        self.assertEqual(a["card"]["id"], "mid")

    def test_resources_the_expensive_off_aspect_card(self):
        prompt = {"type": "resource", "signature": "resource|multiple", "title": "Select 1 card to resource",
                  "promptTitle": "Resource Step", "selectCardMode": "multiple", "selected": [], "actionWindow": False}
        me = side("p1", ready=2, total=2, mine=True,
                  hand=[{"id": "h1", "n": "Cheap Guy", "s": "SOR_001"}, {"id": "h2", "n": "Big Ship", "s": "SOR_002"}])
        acts = [card_act("cheap-guy", "h1", "hand", "p1", "SOR_001"), card_act("big-ship", "h2", "hand", "p1", "SOR_002")]
        a, _ = self.pick(msg(prompt, me, side("p2"), acts))
        self.assertEqual(a["label"], "big-ship")

    def test_cancels_a_play_that_has_no_effect(self):
        prompt = {"type": None, "signature": "-|-", "title": "Playing Zap will have no effect. Are you sure you want to play it?",
                  "promptTitle": "Framework effect", "selectCardMode": None, "selected": [], "actionWindow": False}
        a, _ = self.pick(msg(prompt, side("p1", mine=True), side("p2"), [button("Play anyway"), button("Cancel")]))
        self.assertEqual(a["label"], "Cancel")

    def test_never_repeats_a_choice_that_changed_nothing(self):
        me = side("p1", ready=5, total=5, mine=True, hand=[{"id": "h2", "n": "Wampa", "s": "SOR_038"}])
        acts = [button("Pass"), card_act("wampa", "h2", "hand", "p1", "SOR_038")]
        m = msg(WINDOW, me, side("p2"), acts)
        first, _ = self.pick(m)
        second, _ = self.pick(m)
        self.assertEqual(first["label"], "wampa")
        self.assertNotEqual(second["label"], "wampa")

    def test_display_pick_count_resets_for_a_new_occurrence(self):
        prompt = {"type": "displayCards", "signature": "displayCards|-", "title": "Select up to 1 card", "promptTitle": "Scout",
                  "selectCardMode": None, "selected": [], "actionWindow": False}
        acts = [button("Done"), {"kind": "displayCard", "label": "wampa", "cardUuid": "d1"}]
        me, opp = side("p1", mine=True), side("p2")
        first, _ = self.pick(msg(prompt, me, opp, [dict(a) for a in acts]))
        self.pick(msg(WINDOW, me, opp, [button("Pass")], rnd=4))
        again, _ = self.pick(msg(prompt, me, opp, [dict(a) for a in acts], rnd=5))
        self.assertEqual((first["kind"], again["kind"]), ("displayCard", "displayCard"))

    def test_damage_split_kills_then_goes_face(self):
        me = side("p1", mine=True)
        opp = side("p2", ground=[unit("e1", 3, 2), unit("e2", 5, 6)])
        b = Board(msg(WINDOW, me, opp, []), DB)
        d = {"type": "damage", "amount": 5, "canDistributeLess": False, "canChooseNoTargets": False, "maxTargets": None,
             "tokenType": None, "targets": [{"id": "e1", "cap": 2}, {"id": "e2", "cap": 6}, {"id": "p2-base", "cap": None}]}
        split = {e["id"]: e["amount"] for e in self.p.split(d, b)}
        self.assertEqual(split.get("e1"), 2)
        self.assertEqual(sum(split.values()), 5)


if __name__ == "__main__":
    unittest.main()
