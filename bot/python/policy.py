"""py-clock: decides one prompt at a time from the `decide` message alone (plus card data and a little memory).

Action window order:
  1. an attack plan that kills the enemy base this round
  2. deploy the leader (free, arrives ready)
  3. attacks from the plan that kill a ready enemy unit, and removal that does the same
  4. cards from hand: the set that uses the most resources (knapsack), upgrades first, then most expensive
  5. the rest of the attack plan
  6. leader action ability
  7. claim initiative when nothing useful is left, else pass
Every other prompt is read from its title (effects.py) and scored with the same unit values (board.py).
"""
import json
import re
from board import Board, Unit, BODY_HP, LIFETIME, SHIELD, SENTINEL
from cards import aspect_penalty
import effects
import planner

ARENAS = ("groundArena", "spaceArena")
PLAY_ZONES = ("hand", "resource", "discard")
DONE = re.compile(r"^(done|confirm|submit|ok|continue|resolve)", re.I)
# cards whose play crashes the engine at forceteki 2be4fcd (found in testing; the engine is read-only here)
ENGINE_BUGS = {"resonate"}   # Resonate.ts: heal target check reads damage of a leader still in the base zone
NO = re.compile(r"^(no\b|pass|cancel|decline|skip|don't|do not|choose nothing|take nothing|nothing)", re.I)


def is_button(a, rx):
    return a["kind"] == "button" and re.search(rx, a["label"] or "", re.I) is not None


class Policy:
    def __init__(self, db):
        self.db = db
        self.reset()

    def reset(self):
        self.tried = set()          # (state, prompt, action) already chosen: choosing it again means it did nothing
        self.attacker = None        # my unit id that is attacking (clicked in the action window or picked by a prompt)
        self.planned = None         # planned target for that attack
        self.last_window_choice = None
        self.display_picks = {}     # prompt key -> number of display cards clicked
        self.plan_targets = {}      # attacker id -> target id from the last attack plan
        self.round_bans = set()     # (round, action key): window actions that ended in a Cancel this round

    # ------------------------------------------------------------------ entry

    def decide(self, msg):
        b = Board(msg, self.db)
        acts = msg["actions"]
        p = msg.get("prompt") or {}
        ranked = self.rank(msg, b, p, acts)
        state_key = json.dumps(msg.get("state"), sort_keys=True)
        prompt_key = "%s|%s|%s|%s" % (p.get("signature"), p.get("title"), p.get("promptTitle"), ",".join(p.get("selected") or []))
        pick = None
        for a in ranked + acts:
            k = (state_key, prompt_key, a["kind"], a["label"], a.get("cardUuid"), str(a.get("arg")))
            if k not in self.tried:
                self.tried.add(k)
                pick = a
                break
        if pick is None:
            pick = ranked[0] if ranked else acts[0]
        self.after(pick, b, p)
        reply = {"t": "act", "i": pick["i"]}
        if pick["kind"] == "distribute":
            split = self.split(pick["distribute"], b)
            if split is not None:
                reply["distribution"] = split
        return reply

    @staticmethod
    def window_key(a):
        return (a["kind"], a["label"], (a.get("card") or {}).get("id"))

    def after(self, pick, b, p):
        """Remember what a choice started (the attacker of an attack), and window actions that came to nothing."""
        c = pick.get("card")
        if not p.get("actionWindow") and pick["kind"] == "button" and re.match(r"cancel", pick["label"] or "", re.I):
            if self.last_window_choice is not None:
                self.round_bans.add((b.round, self.window_key(self.last_window_choice)))
        if p.get("actionWindow"):
            self.last_window_choice = pick
            if c and c.get("zone") in ARENAS and c.get("ctl") == b.you:
                self.attacker = c["id"]
                self.planned = self.plan_targets.get(c["id"])
            else:
                self.attacker = None
                self.planned = None
        elif c and c.get("zone") in ARENAS and c.get("ctl") == b.you and "attack" in (p.get("title") or "").lower():
            if "target" not in (p.get("title") or "").lower():
                self.attacker = c["id"]
                self.planned = None

    # ------------------------------------------------------------------ dispatch

    def rank(self, msg, b, p, acts):
        ptype = p.get("type")
        title = (p.get("title") or "").lower()
        if p.get("actionWindow"):
            return self.action_window(b, acts)
        if ptype == "initiative" or "initiative player" in (p.get("promptTitle") or "").lower():
            return self.by_label(acts, [r"yourself"])
        if "mulligan" in title:
            return self.mulligan(b, acts)
        if ptype == "resource":
            return self.resource(b, p, acts)
        kinds = {a["kind"] for a in acts}
        if "distribute" in kinds:
            return [a for a in acts if a["kind"] == "distribute"] + [a for a in acts if a["kind"] != "distribute"]
        if "card" in kinds:
            return self.targets(b, p, acts)
        if "displayCard" in kinds:
            return self.display(b, p, acts)
        if "option" in kinds:
            return self.options(acts)
        if "perCardButton" in kinds:
            return self.per_card(b, p, acts)
        return self.buttons(b, p, acts)

    @staticmethod
    def by_label(acts, patterns):
        out = []
        for rx in patterns:
            out += [a for a in acts if re.search(rx, a["label"] or "", re.I) and a not in out]
        return out + [a for a in acts if a not in out]

    # ------------------------------------------------------------------ cards in hand

    def card_of(self, a):
        c = a.get("card") or {}
        return self.db.find(c.get("s"), a.get("label"), c.get("n"))

    def cost_of(self, card, b, zone="hand"):
        cost = card.cost + aspect_penalty(card, b.me.aspects)
        if zone == "resource":
            m = re.search(r"smuggle \[(\d+)", card.text)
            cost = int(m.group(1)) if m else cost + 2
        return cost

    def fresh_unit(self, card, b, mine=True):
        u = Unit({"id": "?", "n": card.title, "p": card.power, "h": card.hp}, card.arena or "ground", mine, None)
        u.card = card
        u.raid, u.restore = card.raid, card.restore
        u.overwhelm = "overwhelm" in card.keywords
        u.saboteur = "saboteur" in card.keywords
        u.sentinel = "sentinel" in card.keywords
        u.shields = 1 if "shielded" in card.keywords else 0
        return u

    def effect_value(self, it, b, w):
        """Value of an event/ability effect on its best target, or None if it has no sensible target."""
        if it.kind in ("damage", "defeat", "capture", "bounce", "debuff", "exhaust"):
            best = None
            for u in b.opp.units:
                if it.arena and u.arena != it.arena:
                    continue
                if it.limit is not None:
                    have = {"hp": u.remaining, "power": u.power, "cost": u.card.cost if u.card else 0}[it.limit_kind]
                    if have > it.limit:
                        continue
                if it.kind in ("capture", "bounce") and u.leader:
                    continue
                v = self.harm_value(u, it, b, w)
                if best is None or v > best:
                    best = v
            return best
        if it.kind == "heal":
            hurt = sum(min(u.dmg, it.n) for u in b.me.units) + min(b.me.base_dmg, it.n)
            return hurt * 0.6 if hurt else 0.3
        if it.kind in ("shield", "experience", "buff", "ready", "attack"):
            if not b.me.units:
                return None
            return 2.5 if it.kind != "buff" else 1.0 + it.n
        if it.kind == "draw":
            return 2.2 * max(it.n, 1)
        if it.kind == "tokens":
            return 2.5 * max(it.n, 1)
        return 0.0

    def harm_value(self, u, it, b, w):
        """Value of doing `it` to enemy unit u."""
        full = b.unit_value(u, w)
        if it.kind == "damage":
            if u.shields:
                return SHIELD * 0.8
            if it.n >= u.remaining:
                return full
            v = u.copy()
            v.dmg += it.n
            return full - b.unit_value(v, w)
        if it.kind == "debuff":
            if it.n >= u.remaining:
                return full
            return it.n * LIFETIME * w[1] * 0.5
        if it.kind == "exhaust":
            return 0.0 if u.exhausted else max(u.attack_power, 0) * w[1] * 0.8
        if it.kind == "bounce":
            return full * 0.8 + (u.upgrades * 1.0)
        return full

    def play_value(self, a, b, w):
        """Value of playing this card now, or None if it should stay in hand."""
        card = self.card_of(a)
        if card is None:
            return 1.0
        if card.internal in ENGINE_BUGS:
            return None
        if card.is_unit():
            u = self.fresh_unit(card, b)
            v = b.unit_value(u, w) + 0.35 * card.cost
            if "ambush" in card.keywords:
                v += 1.0 if b.opp.units else 0.0
            if u.sentinel and b.opp.units:
                v += 1.0
            return v
        if card.is_upgrade():
            if not b.me.units and card.up_power >= 0:
                return None
            gain = max(card.up_power, 0) * LIFETIME * w[0] + max(card.up_hp, 0) * BODY_HP
            if "shield" in card.text:
                gain += SHIELD
            return gain + 0.3 * card.cost
        if card.is_event():
            it = effects.parse(card.text)
            if it.kind is None:
                return 0.7 * card.cost
            ev = self.effect_value(it, b, w)
            if it.kind == "damage" and re.search(r"unit or base|to a base|enemy base|each enemy base", card.text):
                ev = max(ev or 0.0, it.n * w[0])
            if ev is None or ev < 1.0:
                return None
            return ev
        return 0.5 * card.cost

    def knapsack(self, plays, budget):
        """Subset of (action, cost, value) with total cost <= budget and the most value. Returns the actions."""
        best = {0: (0.0, [])}
        for a, cost, v in plays:
            for spent, (val, chosen) in list(best.items()):
                s2 = spent + cost
                if s2 <= budget and (s2 not in best or best[s2][0] < val + v):
                    best[s2] = (val + v, chosen + [a])
        return max(best.values(), key=lambda x: x[0])[1]

    # ------------------------------------------------------------------ action window

    def action_window(self, b, acts):
        w = b.weights()
        mine = b.you
        units, plays, leader, other = {}, [], [], []
        for a in acts:
            c = a.get("card")
            if a["kind"] != "card" or not c:
                continue
            if c.get("ctl") == mine and c.get("zone") in ARENAS:
                units[c["id"]] = a
            elif c.get("ctl") == mine and c.get("zone") in PLAY_ZONES:
                plays.append(a)
            elif c["id"] == b.me.leader_id:
                leader.append(a)
            else:
                other.append(a)
        pass_btn = [a for a in acts if is_button(a, r"^pass$")]
        claim = [a for a in acts if is_button(a, r"initiative")]

        total, moves = planner.plan(b, list(units), w)
        lethal = total >= 500
        out = []
        if lethal and moves:
            out.append(units[moves[0][0]])

        # leader deploy is free and the leader arrives ready
        if leader and not b.me.leader_deployed and b.me.leader_card and b.me.resources >= b.me.leader_card.cost:
            out += leader

        # attacks that kill a ready enemy unit
        ready_enemy = {u.id for u in b.opp.units if not u.exhausted}
        for aid, tgt in moves:
            if tgt in ready_enemy and aid in units:
                out.append(units[aid])
                break

        # cards: best set by knapsack, removal that kills ready units first, upgrades, then most expensive
        scored = []
        for a in plays:
            card = self.card_of(a)
            v = self.play_value(a, b, w)
            if v is None:
                continue
            cost = self.cost_of(card, b, a["card"].get("zone")) if card else 0
            scored.append((a, cost, v, card))
        chosen = set(id(a) for a in self.knapsack([(a, c, v) for a, c, v, _ in scored], b.me.ready))

        def order(x):
            a, cost, v, card = x
            rank = 2
            if card is not None and card.is_event():
                it = effects.parse(card.text)
                rank = 0 if it.harm else 3
            elif card is not None and card.is_upgrade():
                rank = 1
            return (rank, -cost, -v)

        out += [a for a, cost, v, card in sorted(scored, key=order) if id(a) in chosen]

        # the rest of the attack plan
        out += [units[aid] for aid, _ in moves]
        # remaining units: attack the base or the best target anyway if positive
        out += list(units.values())
        out += leader + other
        # cheap leftovers outside the knapsack set
        out += [a for a, cost, v, card in sorted(scored, key=lambda x: -x[2]) if v > 0]
        if claim and not b.has_initiative():
            out += claim
        out += pass_btn
        # dedupe, keep order, actions that were cancelled earlier this round go last
        seen, ranked, banned = set(), [], []
        for a in out:
            if id(a) not in seen:
                seen.add(id(a))
                (banned if (b.round, self.window_key(a)) in self.round_bans else ranked).append(a)
        ranked += banned
        self.plan_targets = dict(moves)
        first = ranked[0] if ranked else None
        # nothing useful: claim initiative before passing
        if first is not None and first in pass_btn and claim:
            ranked = claim + [a for a in ranked if a not in claim]
        return ranked

    # ------------------------------------------------------------------ setup prompts

    def keep_value(self, card, b):
        """How much I want to keep this card in hand rather than resource it."""
        if card is None:
            return 0.0
        cost = card.cost + aspect_penalty(card, b.me.aspects)
        res_after = b.me.resources + 1
        v = 0.0
        if cost <= res_after + 1:
            v += 3.0
        elif cost > res_after + 3:
            v -= 2.0
        if card.is_unit():
            v += 1.5
        if card.is_upgrade():
            v -= 0.5
        v -= 0.25 * cost
        v -= 1.0 * (cost - card.cost) / 2
        return v

    def mulligan(self, b, acts):
        cheap = 0
        for h in b.me.hand:
            c = self.db.find(h.get("s"), None, h.get("n"))
            if c is not None and c.cost + aspect_penalty(c, b.me.aspects) <= 3:
                cheap += 1
        keep = cheap >= 2
        return self.by_label(acts, [r"keep" if keep else r"mulligan"])

    def resource(self, b, p, acts):
        lo, hi = effects.wanted(p.get("title"))
        n_sel = len(p.get("selected") or [])
        done = [a for a in acts if a["kind"] == "button" and DONE.search(a["label"] or "")]
        skip = [a for a in acts if a["kind"] == "button" and re.search(r"skip", a["label"] or "", re.I)]
        cards = [a for a in acts if a["kind"] == "card"]
        if lo == hi:
            want = hi
        else:
            want = hi if self.should_resource(b) else lo
        if n_sel >= want:
            return done + skip + cards
        ranked = sorted(cards, key=lambda a: self.keep_value(self.card_of(a), b))
        return ranked + done + skip

    def should_resource(self, b):
        total = b.me.resources
        hand = b.me.hand_count
        if total < 4:
            return True
        costs = [self.db.find(h.get("s"), None, h.get("n")) for h in b.me.hand]
        top = max((c.cost for c in costs if c is not None), default=0)
        if total < 6 and hand >= 2:
            return True
        if total < 8 and (hand >= 3 or top > total):
            return True
        return hand >= 5 and total < 10

    # ------------------------------------------------------------------ targets

    def source_card(self, p):
        return self.db.find(None, None, p.get("promptTitle")) if p.get("promptTitle") else None

    def intent(self, p):
        title = (p.get("title") or "").lower()
        it = effects.parse(title)
        if it.kind is None:
            src = self.source_card(p)
            if src is not None:
                if src.is_upgrade() and re.search(r"attach|choose|select|play", title):
                    it = effects.Intent("attach", 0, src.up_power < 0 or src.up_hp < 0)
                elif it.harm is None:
                    it2 = effects.parse(src.text)
                    if it2.kind is not None or it2.harm is not None:
                        it = it2
        if it.kind is None and "attach" in title:
            it = effects.Intent("attach", 0, False)
        return it

    def target_score(self, a, b, p, it, w):
        c = a.get("card") or {}
        cid = c.get("id") or a.get("cardUuid")
        zone = c.get("zone")
        title = (p.get("title") or "").lower()
        mine = c.get("ctl") == b.you
        if zone in ("hand", "discard", "resource", "deck") or (zone is None and cid not in b.units):
            card = self.card_of(a)
            kv = self.keep_value(card, b) + (card.cost * 0.3 if card else 0)
            bad = re.search(r"discard|resource|bottom", title) and mine
            return -kv if bad else kv
        u = b.units.get(cid)
        if u is None:
            # a base or an undeployed leader
            is_base = cid in (b.me.base_id, b.opp.base_id)
            if it.harm:
                if is_base:
                    return (it.n or 1) * (w[0] if not mine else -w[1])
                return -1.0 if mine else 0.5
            if it.harm is False:
                if it.kind == "heal" and is_base and mine:
                    return min(b.me.base_dmg, it.n or 1) * 0.6
                return 0.2 if mine else -1.0
            return 0.0
        if "attack" in title and "with" in title:
            return self.attacker_score(u, b, w) if mine else -5.0
        harm = it.harm
        if harm is None:
            harm = not mine and False
        if harm:
            v = self.harm_value(u, it, b, w) if it.kind in ("damage", "debuff", "exhaust", "bounce") else b.unit_value(u, w)
            if mine:
                return -v - (2.0 if not u.token else 0.0)
            return v
        # help
        if not mine:
            return -b.unit_value(u, w) * 0.2 - 1.0
        if it.kind == "heal":
            return min(u.dmg, it.n or 99) * 0.6 + 0.1
        if it.kind in ("attach", "buff", "experience", "shield"):
            v = b.unit_value(u, w)
            if it.kind == "shield" and u.shields:
                v *= 0.5
            if not u.exhausted:
                v += 1.0
            return v
        if it.kind == "ready":
            return (max(u.attack_power, 0) * 2.0) if u.exhausted else 0.1
        return b.unit_value(u, w) * 0.5

    def attacker_score(self, u, b, w):
        if u.exhausted:
            return -1.0
        offered = [t.id for t in b.opp.units if t.arena == u.arena] + [planner.BASE]
        scores = planner.best_target(b, u, offered, w)
        return max(scores.values()) if scores else 0.0

    def targets(self, b, p, acts):
        title = (p.get("title") or "").lower()
        w = b.weights()
        cards = [a for a in acts if a["kind"] == "card"]
        buttons = [a for a in acts if a["kind"] != "card"]
        done = [a for a in buttons if DONE.search(a["label"] or "")]
        nos = [a for a in buttons if NO.search(a["label"] or "")]
        if "target for attack" in title or ("attack" in title and "with" not in title and "target" in title):
            return self.attack_targets(b, p, cards, buttons, w)
        it = self.intent(p)
        scored = sorted(((self.target_score(a, b, p, it, w), a) for a in cards), key=lambda x: -x[0])
        selected = p.get("selected") or []
        if p.get("selectCardMode") == "multiple":
            lo, hi = effects.wanted(p.get("title"))
            if len(selected) >= hi or (len(selected) >= lo and (not scored or scored[0][0] <= 0)):
                return done + [a for _, a in scored] + nos + buttons
            return [a for s, a in scored] + done + buttons
        if scored and scored[0][0] < 0 and nos:
            # every target hurts me and the prompt can be declined
            return nos + [a for _, a in scored] + buttons
        return [a for _, a in scored] + done + buttons

    def attack_targets(self, b, p, cards, buttons, w):
        att = b.units.get(self.attacker) if self.attacker else None
        if att is None:
            # attacker from the prompt's source title (Ambush, "attack with" abilities)
            src = (p.get("promptTitle") or "").lower()
            att = next((u for u in b.me.units if u.name.lower() == src), None)
        ids = {}
        for a in cards:
            cid = a["card"]["id"]
            ids[planner.BASE if cid == b.opp.base_id else cid] = a
        scores = planner.best_target(b, att, list(ids), w) if att is not None else {}
        if not scores:
            fallback = sorted(cards, key=lambda a: -self.target_score(a, b, p, effects.Intent("damage", 3, True), w))
            return fallback + buttons
        if self.planned in ids and scores.get(self.planned, -99) >= max(scores.values()) - 0.5:
            order = [self.planned] + sorted((k for k in scores if k != self.planned), key=lambda k: -scores[k])
        else:
            order = sorted(scores, key=lambda k: -scores[k])
        ranked = [ids[k] for k in order]
        cancel = [a for a in buttons if NO.search(a["label"] or "")]
        if scores[order[0]] < -0.5 and cancel:
            return cancel + ranked + buttons
        return ranked + [a for a in cards if a not in ranked] + buttons

    # ------------------------------------------------------------------ other prompt shapes

    def display(self, b, p, acts):
        key = "%s|%s" % (p.get("title"), p.get("promptTitle"))
        title = (p.get("title") or "").lower()
        lo, hi = effects.wanted(p.get("title"))
        picks = self.display_picks.get(key, 0)
        cards = [a for a in acts if a["kind"] == "displayCard"]
        buttons = [a for a in acts if a["kind"] != "displayCard"]
        done = [a for a in buttons if DONE.search(a["label"] or "")]
        if picks >= hi and done:
            return done + buttons + cards
        self.display_picks[key] = picks + 1

        def val(a):
            c = self.db.find(None, a.get("label"), None)
            if c is None:
                return 0.0
            return c.cost + (1.5 if c.is_unit() else 0.0)
        ranked = sorted(cards, key=lambda a: -val(a))
        if "bottom" in title or "discard" in title and "opponent" not in title:
            ranked.reverse()
        return ranked + done + buttons

    def options(self, acts):
        opts = [a for a in acts if a["kind"] == "option"]
        nums = []
        for a in opts:
            m = re.match(r"^#?(-?\d+)$", str(a["label"]))
            if m:
                nums.append((int(m.group(1)), a))
        if nums:
            return [a for _, a in sorted(nums, key=lambda x: -x[0])] + acts
        return opts + acts

    def per_card(self, b, p, acts):
        return self.by_label(acts, [r"top", r"hand", r"play", r"keep"])

    def buttons(self, b, p, acts):
        title = ((p.get("title") or "") + " " + (p.get("promptTitle") or "")).lower()
        if "no effect" in title or "are you sure" in title:
            return self.by_label(acts, [r"^cancel", r"^no\b", r"don't", r"pass"])
        labels = " ".join((a["label"] or "").lower() for a in acts)
        if "yourself" in labels or "opponent" in labels:
            it = self.intent(p)
            harm = it.harm if it.harm is not None else bool(effects.HARM_WORDS.search(title))
            return self.by_label(acts, [r"opponent" if harm else r"yourself"])
        if "deploy" in labels:
            return self.by_label(acts, [r"deploy", r"attack"])
        if self.attacker and "attack" in labels:
            return self.by_label(acts, [r"^attack"])
        # optional triggers and menus: use the ability unless it only hurts me
        def score(a):
            label = (a["label"] or "").lower()
            if re.search(r"trigger|^yes|^use|^play|^resolve|^keep|^attack|^deal|^draw|^give|^heal|^defeat", label):
                return 5
            if DONE.search(label):
                return 3
            if NO.search(label):
                return -3
            return 0
        return sorted(acts, key=lambda a: -score(a))

    # ------------------------------------------------------------------ distribute

    def split(self, d, b):
        """Damage: kill the most valuable enemy units, rest to the enemy base (or soak on my own base).
        Healing and tokens: my most valuable damaged units, then my base."""
        amount = d["amount"]
        targets = d["targets"]
        maxt = d.get("maxTargets")
        w = b.weights()
        harm = d.get("type") in ("damage", "indirectDamage") or "damage" in str(d.get("type")).lower()
        alloc = {}

        def cap(t):
            return amount if t["cap"] is None else t["cap"]

        def add(tid, n):
            alloc[tid] = alloc.get(tid, 0) + n

        left = amount
        if harm:
            enemy = [t for t in targets if b.side_of(t["id"]) is b.opp]
            own = [t for t in targets if b.side_of(t["id"]) is b.me]
            units = [(b.units[t["id"]], t) for t in enemy if t["id"] in b.units]
            # cheapest kills per point first, by value per damage needed
            units.sort(key=lambda x: -b.unit_value(x[0], w) / max(x[0].remaining + (99 if x[0].shields else 0), 1))
            for u, t in units:
                need = u.remaining
                if u.shields or need > left or need > cap(t):
                    continue
                add(t["id"], need)
                left -= need
            if left:
                base = [t for t in enemy if t["id"] == b.opp.base_id]
                if base:
                    add(base[0]["id"], min(left, cap(base[0])))
                    left -= min(left, cap(base[0]))
            for u, t in units:
                if not left:
                    break
                room = cap(t) - alloc.get(t["id"], 0)
                give = min(room, left)
                if give > 0:
                    add(t["id"], give)
                    left -= give
            if left and own:
                # damage I have to take: base first while it is safe, units without killing them
                mb = [t for t in own if t["id"] == b.me.base_id]
                if mb and b.me.base_remaining > left + 4:
                    add(mb[0]["id"], min(left, cap(mb[0])))
                    left -= min(left, cap(mb[0]))
                for t in sorted(own, key=lambda t: -(b.units[t["id"]].remaining if t["id"] in b.units else 0)):
                    if not left:
                        break
                    u = b.units.get(t["id"])
                    room = cap(t) - alloc.get(t["id"], 0)
                    if u is not None:
                        room = min(room, u.remaining - 1)
                    give = min(max(room, 0), left)
                    if give > 0:
                        add(t["id"], give)
                        left -= give
                for t in own:
                    if not left:
                        break
                    room = cap(t) - alloc.get(t["id"], 0)
                    give = min(room, left)
                    if give > 0:
                        add(t["id"], give)
                        left -= give
        else:
            own = [t for t in targets if b.side_of(t["id"]) is b.me]
            others = [t for t in targets if t not in own]

            def need(t):
                u = b.units.get(t["id"])
                if u is not None:
                    return (u.dmg, b.unit_value(u, w))
                if t["id"] == b.me.base_id:
                    return (b.me.base_dmg, 0.5)
                return (0, 0)
            for t in sorted(own, key=lambda t: -need(t)[1]):
                give = min(cap(t), left, need(t)[0] if need(t)[0] else 0)
                if give > 0:
                    add(t["id"], give)
                    left -= give
            for t in sorted(own, key=lambda t: -need(t)[1]) + others:
                if not left:
                    break
                room = cap(t) - alloc.get(t["id"], 0)
                give = min(room, left)
                if give > 0:
                    add(t["id"], give)
                    left -= give
        out = [{"id": k, "amount": v} for k, v in alloc.items() if v > 0]
        if maxt is not None and len(out) > maxt:
            return None
        total = sum(e["amount"] for e in out)
        if total > amount or (total < amount and not d.get("canDistributeLess")):
            return None
        if total == 0 and not d.get("canChooseNoTargets"):
            return None
        return out
