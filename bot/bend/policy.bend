# The decisions. One handler per kind of prompt; each scores every legal
# action (around E.Z, higher is better) and the caller plays the best, or
# hands the top few to TypeSafe's Jev (jev.bend) when they are close.
import Base
import ./cards.bend as C
import ./model.bend as M
import ./eval.bend as E
import ./board.bend as Bd
import ./txt.bend as T

# A scored action. dist: a distribution reply (JSON array) or "". tried: a card id
# clicked at the action window (not clicked again this round). att: the
# attacker this click commits, for the target prompt that follows.
type Cand is Data:
  Cand{i: U32, score: U32, why: String, dist: String, tried: String, att: String}

def Cand.i(x: Cand) -> U32:
  Cand{i, score, why, dist, tried, att} = x
  i

def Cand.score(x: Cand) -> U32:
  Cand{i, score, why, dist, tried, att} = x
  score

def Cand.why(x: Cand) -> String:
  Cand{i, score, why, dist, tried, att} = x
  why

def Cand.dist(x: Cand) -> String:
  Cand{i, score, why, dist, tried, att} = x
  dist

def Cand.tried(x: Cand) -> String:
  Cand{i, score, why, dist, tried, att} = x
  tried

def Cand.att(x: Cand) -> String:
  Cand{i, score, why, dist, tried, att} = x
  att

# What the bot remembers between decisions: cards tried this round, the
# attacker it chose, and loop guards (the same prompt again and again; a
# multi-select click that changed nothing).
type Mem is Data:
  Mem{round: U32, tried: List<&2, String>, attacker: String, key: String, reps: U32, pick: String, sel_n: U32, bad: List<&2, String>}

def Mem.round(x: Mem) -> U32:
  Mem{round, tried, attacker, key, reps, pick, sel_n, bad} = x
  round

def Mem.tried(x: Mem) -> List<&2, String>:
  Mem{round, tried, attacker, key, reps, pick, sel_n, bad} = x
  tried

def Mem.attacker(x: Mem) -> String:
  Mem{round, tried, attacker, key, reps, pick, sel_n, bad} = x
  attacker

def Mem.key(x: Mem) -> String:
  Mem{round, tried, attacker, key, reps, pick, sel_n, bad} = x
  key

def Mem.reps(x: Mem) -> U32:
  Mem{round, tried, attacker, key, reps, pick, sel_n, bad} = x
  reps

def Mem.pick(x: Mem) -> String:
  Mem{round, tried, attacker, key, reps, pick, sel_n, bad} = x
  pick

def Mem.sel_n(x: Mem) -> U32:
  Mem{round, tried, attacker, key, reps, pick, sel_n, bad} = x
  sel_n

def Mem.bad(x: Mem) -> List<&2, String>:
  Mem{round, tried, attacker, key, reps, pick, sel_n, bad} = x
  bad

# A handler's answer. cls names the handler (for logs). ask: what to ask Jev
# about, 0 nothing, 1 the move, 2 a target, 3 a resource, 4 the mulligan.
type Out is Data:
  Out{cands: List<&2, Cand>, mem: Mem, cls: String, ask: U32}

def Out.cands(x: Out) -> List<&2, Cand>:
  Out{cands, mem, cls, ask} = x
  cands

def Out.mem(x: Out) -> Mem:
  Out{cands, mem, cls, ask} = x
  mem

def Out.cls(x: Out) -> String:
  Out{cands, mem, cls, ask} = x
  cls

def Out.ask(x: Out) -> U32:
  Out{cands, mem, cls, ask} = x
  ask

# A card I could play now, for the knapsack over this round's resources.
type Item is Data:
  Item{id: String, cost: U32, value: U32}

def Item.id(x: Item) -> String:
  Item{id, cost, value} = x
  id

def Item.cost(x: Item) -> U32:
  Item{id, cost, value} = x
  cost

def Item.value(x: Item) -> U32:
  Item{id, cost, value} = x
  value

def Mem.fresh() -> Mem:
  Mem{0, Nil{}, "", "", 0, "", 0, Nil{}}

def cand(+a: M.Act, score: U32, why: String) -> Cand:
  Cand{M.Act.i(a), score, why, "", "", ""}

def id_of(+a: M.Act) -> String:
  M.CRef.id(M.Act.card(a))

def is_card(+a: M.Act) -> Bool:
  U32.is_eq(M.Act.kind(a), 2)

def is_button(+a: M.Act) -> Bool:
  U32.is_eq(M.Act.kind(a), 1)

def label_is(+a: M.Act, s: String) -> Bool:
  String.eq(M.Act.label(a), s)

def up(x: U32) -> U32:
  E.plus(E.Z(), x)

def down(x: U32) -> U32:
  E.minus(E.Z(), x)

# Picking
# -------

def better(+a: Cand, +b: Cand) -> Cand:
  Bool.pick(Cand, U32.is_gt(Cand.score(b), Cand.score(a)), b, a)

def best_of(cs: List<&2, Cand>, +acc: Cand) -> Cand:
  match cs:
    case Nil{}:
      acc
    case Con{c, rest}:
      best_of(rest, better(acc, c))

def best(cs: List<&2, Cand>) -> Cand:
  match cs:
    case Nil{}:
      Cand{0, 0, "no actions", "", "", ""}
    case Con{c, rest}:
      best_of(rest, c)

# Buttons in general
# ------------------

def exits() -> List<&2, String>:
  ["cancel", "pass", "skip", "take nothing", "choose nothing", "done", "confirm", "no", "decline"]

# a button's general appeal, from its label
def button_score(+l: String) -> U32:
  Bool.pick(U32, T.starts_ci("(no effect)", l), down(200),
  Bool.pick(U32, T.starts_ci("cancel", l), down(100),
  Bool.pick(U32, T.has_any(l, ["deploy", "trigger", "resolve all", "confirm", "yes"]), up(120),
  Bool.pick(U32, T.has_any(l, ["play ", "attack"]), up(90),
  Bool.pick(U32, T.has_any(l, ["done", "resolve next", "keep", "yourself"]), up(60),
  Bool.pick(U32, T.has_any(l, ["pass", "skip", "take nothing", "choose nothing", "no"]), up(10),
    up(40)))))))

def buttons(acts: List<&2, M.Act>) -> List<&2, Cand>:
  match acts:
    case Nil{}:
      Nil{}
    case Con{+a, rest}:
      +r = buttons(rest)
      Bool.pick(List<&2, Cand>, is_button(a), cand(a, button_score(M.Act.label(a)), M.Act.label(a)) <> r, r)

# Polarity of a targeting prompt
# ------------------------------

# 1: it helps the target, 2: it hurts it, 0: cannot tell
def polarity(+title: String) -> U32:
  Bool.pick(U32, T.has_any(title, ["attack with", "friendly unit captures", "friendly unit deals", "heal", "shield", "experience", "advantage", "attach", "return a card from your discard", "to your hand from your discard"]), 1,
    Bool.pick(U32, T.has_any(title, ["damage", "defeat", "destroy", "exhaust", "captur", "-1/", "-2/", "-3/", "-4/", "-5/", "-6/", "/?", "weakness", "lose all abilities", "take control", "discard", "return", "exploit", "attack", "enemy"]), 2,
      Bool.pick(U32, T.has_any(title, ["ready", "+1/", "+2/", "+3/", "+4/", "+5/", "friendly", "play "]), 1, 0)))

# Scoring a clicked card in a targeting prompt
# --------------------------------------------

def unit_target(+p: M.Piece, +pol: U32, +n: U32) -> U32:
  +w = E.worth(p)
  +kill = Bool.and(U32.is_gt(n, 0), U32.is_ge(n, E.rem(p)))
  +harm = U32.is_eq(pol, 2)
  Bool.pick(U32, M.Piece.mine(p),
    Bool.pick(U32, harm, down(w), up((w + E.bonus(M.Piece.ready(p), 10) : U32))),
    Bool.pick(U32, harm, up((w + E.bonus(kill, 40) : U32)), down(w)))

def other_target(+cs: C.Cards, +st: M.State, +pol: U32, +r: M.CRef) -> U32:
  +id = M.CRef.id(r)
  +mineb = String.eq(id, M.Side.base_id(M.State.me(st)))
  +oppb = String.eq(id, M.Side.base_id(M.State.opp(st)))
  +v = Bd.card_value(C.info_of(cs, M.CRef.code(r)), st)
  +harm = U32.is_eq(pol, 2)
  Bool.pick(U32, mineb, Bool.pick(U32, harm, down(40), up(30)),
    Bool.pick(U32, oppb, Bool.pick(U32, harm, up(40), down(30)),
      Bool.pick(U32, M.CRef.mine(r),
        Bool.pick(U32, harm, up(E.sub0(300, v)), up(v)),
        Bool.pick(U32, harm, up(v), down(v)))))

def pick_target(m: Maybe<&2, M.Piece>, +cs: C.Cards, +st: M.State, +pol: U32, +n: U32, +a: M.Act) -> U32:
  match m:
    case Some{p}:
      unit_target(p, pol, n)
    case None{}:
      other_target(cs, st, pol, M.Act.card(a))

def piece_of(+st: M.State, +id: String) -> Maybe<&2, M.Piece>:
  Maybe.or(&2, M.Piece, Bd.find(Bd.mine(st), id), Bd.find(Bd.theirs(st), id))

# buttons beside targets: leaving is neutral, so any good target beats it
def target_button(+l: String) -> U32:
  Bool.pick(U32, T.has_any(l, exits()), E.Z(), button_score(l))

def target_cands(+cs: C.Cards, +st: M.State, +pol: U32, +n: U32, +bad: List<&2, String>, +sel: List<&2, String>, acts: List<&2, M.Act>) -> List<&2, Cand>:
  match acts:
    case Nil{}:
      Nil{}
    case Con{+a, rest}:
      +id = id_of(a)
      +s = Bool.pick(U32, Bd.contains(bad, id) || Bd.contains(sel, id), down(1000),
        pick_target(piece_of(st, id), cs, st, pol, n, a))
      +r = target_cands(cs, st, pol, n, bad, sel, rest)
      Bool.pick(List<&2, Cand>, is_card(a), Cand{M.Act.i(a), s, "target", "", id, ""} <> r,
        Bool.pick(List<&2, Cand>, is_button(a), Cand{M.Act.i(a), target_button(M.Act.label(a)), M.Act.label(a), "", "", ""} <> r, r))


# Picking the best of several (ties keep the first)
# ------------------------------------------------

def len_acts(acts: List<&2, M.Act>) -> U32:
  U32.from_nat(List.length(&2, M.Act, acts))

def len_strs(xs: List<&2, String>) -> U32:
  U32.from_nat(List.length(&2, String, xs))

# the first button whose label contains one of ps
def find_button(acts: List<&2, M.Act>, +ps: List<&2, String>) -> Maybe<&2, M.Act>:
  match acts:
    case Nil{}:
      None{}
    case Con{+a, rest}:
      +r = find_button(rest, ps)
      Bool.pick(Maybe<&2, M.Act>, Bool.and(is_button(a), T.has_any(M.Act.label(a), ps)), Some{a}, r)

def maybe_cand(m: Maybe<&2, M.Act>, score: U32, why: String) -> List<&2, Cand>:
  match m:
    case Some{a}:
      [Cand{M.Act.i(a), score, why, "", "", ""}]
    case None{}:
      Nil{}

# a candidate for the first button matching ps, else none
def button_cand(acts: List<&2, M.Act>, +ps: List<&2, String>, score: U32, why: String) -> List<&2, Cand>:
  maybe_cand(find_button(acts, ps), score, why)

# The knapsack over this round's resources
# ----------------------------------------

type Pick is Data:
  Pick{v: U32, ids: List<&2, String>}

def pick_ids(p: Pick) -> List<&2, String>:
  Pick{v, ids} = p
  ids

def better_pick(a: Pick, b: Pick) -> Pick:
  Pick{+va, ia} = a
  Pick{+vb, ib} = b
  +bw = U32.is_gt(vb, va)
  Pick{Bool.pick(U32, bw, vb, va), Bool.pick(List<&2, String>, bw, ib, ia)}

def with_item(p: Pick, +it: Item) -> Pick:
  Pick{tv, tids} = p
  Pick{(tv + Item.value(it) : U32), Item.id(it) <> tids}

# the most valuable set of cards that fits in cap resources
def knap(items: List<&2, Item>, +cap: U32) -> Pick:
  match items:
    case Nil{}:
      Pick{0, Nil{}}
    case Con{+it, +rest}:
      +c = Item.cost(it)
      take skip = knap(rest, E.sub0(cap, c)) knap(rest, cap)
      better_pick(Bool.pick(Pick, U32.is_le(c, cap), with_item(take, it), Pick{0, Nil{}}), skip)

def tried(+mem: Mem, +id: String) -> Bool:
  Bd.contains(Mem.tried(mem), id)

# what a card in hand (or a smuggled resource) costs me
def cost_of(+cs: C.Cards, +st: M.State, +r: M.CRef) -> U32:
  (Bd.eff_cost(C.info_of(cs, M.CRef.code(r)), M.State.me(st)) + E.bonus(U32.is_eq(M.CRef.zone(r), 5), 2) : U32)

def is_play(+a: M.Act) -> Bool:
  +r = M.Act.card(a)
  +z = M.CRef.zone(r)
  Bool.and(is_card(a), Bool.and(M.CRef.mine(r), U32.is_eq(z, 1) || U32.is_eq(z, 5)))

def items(+cs: C.Cards, +st: M.State, +mem: Mem, acts: List<&2, M.Act>) -> List<&2, Item>:
  match acts:
    case Nil{}:
      Nil{}
    case Con{+a, rest}:
      +r = items(cs, st, mem, rest)
      +ref = M.Act.card(a)
      +ok = Bool.and(is_play(a), Bool.not(tried(mem, M.CRef.id(ref))))
      Bool.pick(List<&2, Item>, ok,
        Item{M.CRef.id(ref), cost_of(cs, st, ref), Bd.card_value(C.info_of(cs, M.CRef.code(ref)), st)} <> r, r)

# The action window
# -----------------

def unit_click(m: Maybe<&2, M.Piece>, +st: M.State, +lethal: Bool, +a: M.Act) -> Cand:
  match m:
    case Some{+p}:
      +id = id_of(a)
      +s = Bool.pick(U32, M.Piece.ready(p),
        Bool.pick(U32, lethal, up((100000 + E.atk(p) : U32)), Bd.attack_value(p, st)), up(10))
      Cand{M.Act.i(a), s, "attack with " ++ id, "", id, id}
    case None{}:
      +id = id_of(a)
      Cand{M.Act.i(a), up(5), "use " ++ id, "", id, ""}

def window_card(+cs: C.Cards, +st: M.State, +mem: Mem, +pk: Pick, +lethal: Bool, +a: M.Act) -> Cand:
  +ref = M.Act.card(a)
  +id = M.CRef.id(ref)
  +z = M.CRef.zone(ref)
  # a leader keeps its id when it deploys: the deployed unit is a new card for the guard
  +key = Bool.pick(String, U32.is_eq(z, 4), id ++ "@base", id)
  +me = M.State.me(st)
  +v = Bd.card_value(C.info_of(cs, M.CRef.code(ref)), st)
  +in_pick = Bd.contains(pick_ids(pk), id)
  +play : Cand = Cand{M.Act.i(a), Bool.pick(U32, in_pick, up((100 + v : U32)), down(10)), "play " ++ id, "", id, ""}
  +unit : Cand = unit_click(Bd.find(Bd.mine(st), id), st, lethal, a)
  +deploy = Bool.and(Bool.not(M.Side.leader_dep(me)), U32.is_ge(M.Side.res_total(me), C.Info.cost(C.info_of(cs, M.Side.leader_code(me)))))
  +lead : Cand = Cand{M.Act.i(a), Bool.pick(U32, deploy, up(250), up(40)), Bool.pick(String, deploy, "deploy leader", "leader ability"), "", key, ""}
  +base : Cand = Cand{M.Act.i(a), up(15), "base ability", "", key, ""}
  +other : Cand = Cand{M.Act.i(a), Bool.pick(U32, M.CRef.mine(ref), up(5), down(5)), "use " ++ id, "", key, ""}
  Bool.pick(Cand, tried(mem, key), Cand{M.Act.i(a), down(1000), "tried", "", "", ""},
    Bool.pick(Cand, is_play(a), play,
      Bool.pick(Cand, Bool.and(M.CRef.mine(ref), U32.is_eq(z, 2) || U32.is_eq(z, 3)), unit,
        Bool.pick(Cand, String.eq(id, M.Side.leader_id(me)), lead,
          Bool.pick(Cand, String.eq(id, M.Side.base_id(me)), base, other)))))

def window_act(+cs: C.Cards, +st: M.State, +mem: Mem, +pk: Pick, +lethal: Bool, +a: M.Act) -> Cand:
  +l = M.Act.label(a)
  Bool.pick(Cand, is_card(a), window_card(cs, st, mem, pk, lethal, a),
    Bool.pick(Cand, T.starts_ci("claim", l), Cand{M.Act.i(a), up(5), "claim initiative", "", "", ""},
      Bool.pick(Cand, T.starts_ci("pass", l), Cand{M.Act.i(a), E.Z(), "pass", "", "", ""},
        cand(a, up(1), l))))

def window_all(+cs: C.Cards, +st: M.State, +mem: Mem, +pk: Pick, +lethal: Bool, acts: List<&2, M.Act>) -> List<&2, Cand>:
  match acts:
    case Nil{}:
      Nil{}
    case Con{+a, rest}:
      window_act(cs, st, mem, pk, lethal, a) <> window_all(cs, st, mem, pk, lethal, rest)

def window(+cs: C.Cards, +st: M.State, +mem: Mem, +acts: List<&2, M.Act>) -> List<&2, Cand>:
  +pk = knap(items(cs, st, mem, acts), M.Side.res_ready(M.State.me(st)))
  window_all(cs, st, mem, pk, Bd.can_kill_base(st), acts)

# Choosing an attack target
# -------------------------

def strongest(ps: List<&2, M.Piece>, +best: M.Piece) -> M.Piece:
  match ps:
    case Nil{}:
      best
    case Con{+p, rest}:
      strongest(rest, Bool.pick(M.Piece, Bool.and(M.Piece.ready(p), U32.is_gt(E.atk(p), E.atk(best))), p, best))

def no_piece() -> M.Piece:
  M.Piece{"", "", True{}, 1, 0, 1, 0, True{}, False{}, 0, 0, 0, False{}, C.Info.none()}

def piece_or(m: Maybe<&2, M.Piece>, d: M.Piece) -> M.Piece:
  match m:
    case Some{p}:
      p
    case None{}:
      d

def attacker(+st: M.State, +mem: Mem) -> M.Piece:
  piece_or(Bd.find(Bd.mine(st), Mem.attacker(mem)), strongest(Bd.mine(st), no_piece()))

def hit_or(m: Maybe<&2, M.Piece>, +a: M.Piece, +r: U32, +mode: U32) -> U32:
  match m:
    case Some{t}:
      E.hit_unit(a, t, r, mode)
    case None{}:
      down(50)

def attack_cands(+st: M.State, +a: M.Piece, acts: List<&2, M.Act>) -> List<&2, Cand>:
  match acts:
    case Nil{}:
      Nil{}
    case Con{+x, rest}:
      +r = attack_cands(st, a, rest)
      +id = id_of(x)
      +opp = M.State.opp(st)
      +mode = Bd.race(st)
      +s = Bool.pick(U32, String.eq(id, M.Side.base_id(opp)), E.hit_base(a, E.base_left(opp), M.Side.base_d(M.State.me(st)), mode),
        hit_or(Bd.find(Bd.theirs(st), id), a, E.base_left(opp), mode))
      Bool.pick(List<&2, Cand>, is_card(x), Cand{M.Act.i(x), s, "hit " ++ id, "", "", ""} <> r,
        Bool.pick(List<&2, Cand>, is_button(x), Cand{M.Act.i(x), down(300), M.Act.label(x), "", "", ""} <> r, r))

# Targets in general (single and multi-select)
# --------------------------------------------

def is_exit(+a: M.Act) -> Bool:
  Bool.and(is_button(a), T.has_any(M.Act.label(a), exits()))

# the exits, best first: Done, then the ways to take nothing, then Cancel
def exit_score(+l: String) -> U32:
  Bool.pick(U32, T.starts_ci("done", l) || T.starts_ci("confirm", l), up(3),
    Bool.pick(U32, T.has_any(l, ["choose nothing", "take nothing", "skip", "pass", "no"]), up(2), up(1)))

def exit_cands(acts: List<&2, M.Act>) -> List<&2, Cand>:
  match acts:
    case Nil{}:
      Nil{}
    case Con{+a, rest}:
      +r = exit_cands(rest)
      Bool.pick(List<&2, Cand>, is_exit(a), Cand{M.Act.i(a), exit_score(M.Act.label(a)), M.Act.label(a), "", "", ""} <> r, r)

# a multi-select prompt: click the best useful card not yet picked, else leave
def multi(cards: List<&2, Cand>, +exits: List<&2, Cand>) -> List<&2, Cand>:
  +c = best(cards)
  +useful = U32.is_gt(Cand.score(c), E.Z())
  Bool.pick(List<&2, Cand>, Bool.or(useful, List.is_empty(&2, Cand, exits)), [c], exits)

def targets(+cs: C.Cards, +st: M.State, +mem: Mem, +p: M.Prompt, +acts: List<&2, M.Act>) -> List<&2, Cand>:
  +title = M.Prompt.title(p)
  +cards = target_cands(cs, st, polarity(title), T.max_num(title, 0), Mem.bad(mem), M.Prompt.selected(p), acts)
  Bool.pick(List<&2, Cand>, M.Prompt.multi(p), multi(cards, exit_cands(acts)), cards)

# Resources
# ---------

def hand_card(hs: List<&2, M.HCard>, +id: String) -> M.HCard:
  match hs:
    case Nil{}:
      M.HCard{"", "", True{}, C.Info.none()}
    case Con{+h, rest}:
      +r = hand_card(rest, id)
      Bool.pick(M.HCard, String.eq(M.HCard.id(h), id), h, r)

# how much I want to keep a card in hand (low: put it into resources)
def keep(+cs: C.Cards, +st: M.State, +id: String) -> U32:
  +h = hand_card(M.Side.hand(M.State.me(st)), id)
  +i = M.HCard.info(h)
  +me = M.State.me(st)
  +cost = Bd.eff_cost(i, me)
  +far = E.sub0(cost, (M.Side.res_total(me) + 3 : U32))
  E.sub0((Bd.card_value(i, st) + 200 : U32), (far * 25 + Bd.penalty(i, me) * 10 : U32))

def resource_cards(+cs: C.Cards, +st: M.State, +sel: List<&2, String>, acts: List<&2, M.Act>) -> List<&2, Cand>:
  match acts:
    case Nil{}:
      Nil{}
    case Con{+a, rest}:
      +r = resource_cards(cs, st, sel, rest)
      +id = id_of(a)
      +s = Bool.pick(U32, Bd.contains(sel, id), 0, up(E.sub0(1000, keep(cs, st, id))))
      Bool.pick(List<&2, Cand>, is_card(a), Cand{M.Act.i(a), s, "resource " ++ id, "", id, ""} <> r, r)

# "Select 2 cards to resource" at the start, then "Select between 0 and 1"
def resource(+cs: C.Cards, +st: M.State, +p: M.Prompt, +acts: List<&2, M.Act>) -> List<&2, Cand>:
  +want = T.max_num(M.Prompt.title(p), 1)
  +sel = M.Prompt.selected(p)
  +me = M.State.me(st)
  +enough = Bool.and(U32.is_ge(M.Side.res_total(me), 8), U32.is_le(M.Side.hand_n(me), 3))
  +done = Bool.or(U32.is_ge(len_strs(sel), want), Bool.and(enough, T.has(M.Prompt.title(p), "between 0")))
  +exits = button_cand(acts, ["done", "confirm", "skip"], up(1), "done")
  Bool.pick(List<&2, Cand>, Bool.and(done, Bool.not(List.is_empty(&2, Cand, exits))), exits,
    [best(resource_cards(cs, st, sel, acts))])

# Mulligan: keep a hand with a card I can play in the first rounds
def cheap(hs: List<&2, M.HCard>) -> U32:
  match hs:
    case Nil{}:
      0
    case Con{+h, rest}:
      (E.bonus(U32.is_le(C.Info.cost(M.HCard.info(h)), 3), 1) + cheap(rest) : U32)

def mulligan(+st: M.State, +acts: List<&2, M.Act>) -> List<&2, Cand>:
  +keep_it = U32.is_ge(cheap(M.Side.hand(M.State.me(st))), 1)
  List.append(&2, Cand, button_cand(acts, ["keep"], Bool.pick(U32, keep_it, up(10), up(1)), "keep"),
    button_cand(acts, ["mulligan"], Bool.pick(U32, keep_it, up(1), up(10)), "mulligan"))

# Distributing damage, healing and tokens
# ---------------------------------------

# one target: how much I want to give it (around Z), how much is useful, the
# most it may take, and what it got
type Al is Data:
  Al{id: String, want: U32, need: U32, cap: U32, got: U32}

def Al.want(x: Al) -> U32:
  Al{id, want, need, cap, got} = x
  want

type Fill is Data:
  Fill{xs: List<&2, Al>, left: U32, used: U32}

# kinds: 1 damage, 2 indirect damage, 3 healing, 4 a good token, 5 a bad token
def dist_kind(+d: M.Dist, +title: String) -> U32:
  +t = M.Dist.dtype(d)
  Bool.pick(U32, T.has(t, "indirect"), 2,
    Bool.pick(U32, T.has(t, "healing"), 3,
      Bool.pick(U32, T.has(t, "token"), Bool.pick(U32, T.has(title, "weakness"), 5, 4), 1)))

def unit_want(+k: U32, +amount: U32, +p: M.Piece) -> Al:
  +w = E.worth(p)
  +mine = M.Piece.mine(p)
  +shielded = U32.is_gt(M.Piece.shields(p), 0)
  +kills = Bool.and(Bool.not(shielded), U32.is_le(E.rem(p), amount))
  +hurt = U32.is_le(k, 2)
  +want = Bool.pick(U32, hurt,
    Bool.pick(U32, mine, down(w), Bool.pick(U32, shielded, up(15), up((w + E.bonus(kills, 40) : U32)))),
    Bool.pick(U32, U32.is_eq(k, 3),
      Bool.pick(U32, Bool.and(mine, U32.is_gt(M.Piece.d(p), 0)), up((w / 2 + M.Piece.d(p) : U32)), down(1)),
      Bool.pick(U32, Bool.xor(mine, U32.is_eq(k, 5)), up(w), down(w))))
  +need = Bool.pick(U32, hurt, Bool.pick(U32, shielded, 1, E.rem(p)),
    Bool.pick(U32, U32.is_eq(k, 3), M.Piece.d(p), amount))
  Al{M.Piece.id(p), want, need, 1000, 0}

def base_want(+k: U32, +amount: U32, +s: M.Side, +mine: Bool) -> Al:
  +left = E.base_left(s)
  +want = Bool.pick(U32, U32.is_le(k, 2),
    Bool.pick(U32, mine,
      Bool.pick(U32, U32.is_gt(left, (amount + 2 : U32)), (E.Z() - 1 : U32), down(100000)),
      Bool.pick(U32, U32.is_le(left, amount), up(100000), up(10))),
    Bool.pick(U32, Bool.and(mine, U32.is_eq(k, 3)), up((M.Side.base_d(s) + 10 : U32)), down(1)))
  +need = Bool.pick(U32, U32.is_eq(k, 3), M.Side.base_d(s), Bool.pick(U32, mine, 0, amount))
  Al{M.Side.base_id(s), want, need, 1000, 0}

def piece_al(m: Maybe<&2, M.Piece>, +st: M.State, +k: U32, +amount: U32, +id: String) -> Al:
  match m:
    case Some{p}:
      unit_want(k, amount, p)
    case None{}:
      Bool.pick(Al, String.eq(id, M.Side.base_id(M.State.me(st))), base_want(k, amount, M.State.me(st), True{}),
        Bool.pick(Al, String.eq(id, M.Side.base_id(M.State.opp(st))), base_want(k, amount, M.State.opp(st), False{}),
          Al{id, (E.Z() - 2 : U32), 0, 1000, 0}))

def with_cap(a: Al, +t: M.DT) -> Al:
  Al{id, want, need, cap, got} = a
  Al{id, want, need, Bool.pick(U32, M.DT.capped(t), M.DT.cap(t), cap), got}

def al_ins(xs: List<&2, Al>, +x: Al) -> List<&2, Al>:
  match xs:
    case Nil{}:
      [x]
    case Con{+y, +rest}:
      Bool.pick(List<&2, Al>, U32.is_ge(Al.want(x), Al.want(y)), x <> y <> rest, y <> al_ins(rest, x))

def als(ts: List<&2, M.DT>, +st: M.State, +k: U32, +amount: U32, acc: List<&2, Al>) -> List<&2, Al>:
  match ts:
    case Nil{}:
      acc
    case Con{+t, rest}:
      +id = M.DT.id(t)
      als(rest, st, k, amount, al_ins(acc, with_cap(piece_al(piece_of(st, id), st, k, amount, id), t)))

def room(+used: U32, +max_t: U32) -> Bool:
  Bool.or(U32.is_eq(max_t, 0), U32.is_lt(used, max_t))

def fill_more(f: Fill, +x: Al, +g: U32) -> Fill:
  Fill{ys, l, u} = f
  Al{id, want, need, cap, got} = x
  Fill{Al{id, want, need, cap, (got + g : U32)} <> ys, l, u}

# first pass: give each wanted target what is useful to it
def fill1(xs: List<&2, Al>, +left: U32, +used: U32, +max_t: U32) -> Fill:
  match xs:
    case Nil{}:
      Fill{Nil{}, left, used}
    case Con{+x, rest}:
      Al{+id, +want, +need, +cap, +got} = x
      +g = Bool.pick(U32, Bool.and(U32.is_gt(want, E.Z()), room(used, max_t)), U32.min(left, U32.min(need, cap)), 0)
      fill_more(fill1(rest, (left - g : U32), Bool.pick(U32, U32.is_gt(g, 0), (used + 1 : U32), used), max_t), x, g)

# second pass, when everything must be given: the rest goes to the least bad places
def fill2(xs: List<&2, Al>, +left: U32, +used: U32, +max_t: U32) -> Fill:
  match xs:
    case Nil{}:
      Fill{Nil{}, left, used}
    case Con{+x, rest}:
      Al{+id, +want, +need, +cap, +got} = x
      +ok = Bool.or(U32.is_gt(got, 0), room(used, max_t))
      +g = Bool.pick(U32, ok, U32.min(left, E.sub0(cap, got)), 0)
      +fresh = Bool.and(U32.is_eq(got, 0), U32.is_gt(g, 0))
      fill_more(fill2(rest, (left - g : U32), Bool.pick(U32, fresh, (used + 1 : U32), used), max_t), x, g)

def fill_xs(f: Fill) -> List<&2, Al>:
  Fill{xs, l, u} = f
  xs

# all of it unless less is allowed; at least 1 unless no target is allowed
def fill_all(f: Fill, +amount: U32, +less: Bool, +none_ok: Bool, +max_t: U32) -> List<&2, Al>:
  Fill{+xs, +left, +used} = f
  +empty = U32.is_eq(left, amount)
  Bool.pick(List<&2, Al>, Bool.not(less), Bool.pick(List<&2, Al>, U32.is_eq(left, 0), xs, fill_xs(fill2(xs, left, used, max_t))),
    Bool.pick(List<&2, Al>, Bool.and(empty, Bool.not(none_ok)), fill_xs(fill2(xs, U32.min(amount, 1), used, max_t)), xs))

def dist_json(xs: List<&2, Al>) -> List<&2, String>:
  match xs:
    case Nil{}:
      Nil{}
    case Con{x, rest}:
      Al{id, want, need, cap, +got} = x
      +r = dist_json(rest)
      Bool.pick(List<&2, String>, U32.is_gt(got, 0), T.obj([T.kv("id", T.q(id)), T.kv("amount", T.n(got))]) <> r, r)

def distribute(+st: M.State, +title: String, +a: M.Act) -> Cand:
  +d = M.Act.dist(a)
  +k = dist_kind(d, title)
  +amount = M.Dist.amount(d)
  +max_t = M.Dist.max_t(d)
  +xs = als(M.Dist.targets(d), st, k, amount, Nil{})
  +out = fill_all(fill1(xs, amount, 0, max_t), amount, M.Dist.less(d), M.Dist.none_ok(d), max_t)
  Cand{M.Act.i(a), up(1), "distribute", T.arr(dist_json(out)), "", ""}

def first_dist(acts: List<&2, M.Act>, +st: M.State, +title: String) -> List<&2, Cand>:
  match acts:
    case Nil{}:
      Nil{}
    case Con{+a, rest}:
      Bool.pick(List<&2, Cand>, U32.is_eq(M.Act.kind(a), 6), [distribute(st, title, a)], first_dist(rest, st, title))

# Cards shown from a deck (search, reveal, discard)
# ------------------------------------------------

def display_cands(+cs: C.Cards, +st: M.State, +bottom: Bool, +sel: List<&2, String>, +bad: List<&2, String>, acts: List<&2, M.Act>) -> List<&2, Cand>:
  match acts:
    case Nil{}:
      Nil{}
    case Con{+a, rest}:
      +r = display_cands(cs, st, bottom, sel, bad, rest)
      +id = M.Act.arg(a)
      +v = Bd.card_value(C.info_of(cs, C.code_of(cs, M.Act.label(a))), st)
      +s = Bool.pick(U32, Bool.or(Bd.contains(sel, id), Bd.contains(bad, id)), down(1000),
        Bool.pick(U32, bottom, up(E.sub0(300, v)), up((v + 1 : U32))))
      Bool.pick(List<&2, Cand>, U32.is_eq(M.Act.kind(a), 4), Cand{M.Act.i(a), s, "take " ++ M.Act.label(a), "", id, ""} <> r, r)

def display(+cs: C.Cards, +st: M.State, +mem: Mem, +p: M.Prompt, +acts: List<&2, M.Act>) -> List<&2, Cand>:
  +cards = display_cands(cs, st, T.has(M.Prompt.title(p), "bottom"), M.Prompt.selected(p), Mem.bad(mem), acts)
  Bool.pick(List<&2, Cand>, M.Prompt.multi(p), multi(cards, exit_cands(acts)), cards)

# Numbers and lists of names
# --------------------------

def first_kind(acts: List<&2, M.Act>, +k: U32) -> List<&2, Cand>:
  match acts:
    case Nil{}:
      Nil{}
    case Con{+a, rest}:
      Bool.pick(List<&2, Cand>, U32.is_eq(M.Act.kind(a), k), [cand(a, up(1), M.Act.label(a))], first_kind(rest, k))

def max_opt(acts: List<&2, M.Act>) -> U32:
  match acts:
    case Nil{}:
      0
    case Con{+a, rest}:
      U32.max(Bool.pick(U32, U32.is_eq(M.Act.kind(a), 3), M.Act.argn(a), 0), max_opt(rest))

# a number: the largest, except a guess from a wide range (C-3PO: 2)
def number_cands(acts: List<&2, M.Act>, +goal: U32) -> List<&2, Cand>:
  match acts:
    case Nil{}:
      Nil{}
    case Con{+a, rest}:
      +r = number_cands(rest, goal)
      Bool.pick(List<&2, Cand>, U32.is_eq(M.Act.kind(a), 3),
        cand(a, Bool.pick(U32, U32.is_eq(M.Act.argn(a), goal), up(10), up(1)), M.Act.label(a)) <> r, r)

def is_number(acts: List<&2, M.Act>) -> Bool:
  match acts:
    case Nil{}:
      False{}
    case Con{+a, rest}:
      Bool.pick(Bool, U32.is_eq(M.Act.kind(a), 3), T.starts_ci("#", M.Act.label(a)), is_number(rest))

def options(+acts: List<&2, M.Act>) -> List<&2, Cand>:
  +top = max_opt(acts)
  Bool.pick(List<&2, Cand>, is_number(acts), number_cands(acts, Bool.pick(U32, U32.is_ge(top, 15), 2, top)), first_kind(acts, 3))

def has_kind(acts: List<&2, M.Act>, +k: U32) -> Bool:
  match acts:
    case Nil{}:
      False{}
    case Con{+a, rest}:
      U32.is_eq(M.Act.kind(a), k) || has_kind(rest, k)

# Menus of buttons
# ----------------

def player_choice(acts: List<&2, M.Act>, +harm: Bool) -> List<&2, Cand>:
  match acts:
    case Nil{}:
      Nil{}
    case Con{+a, rest}:
      +r = player_choice(rest, harm)
      +l = M.Act.label(a)
      +opp = T.has(l, "opponent")
      +me = Bool.and(Bool.not(opp), T.has(l, "you"))
      +s = Bool.pick(U32, harm, Bool.pick(U32, opp, up(150), up(1)), Bool.pick(U32, me, up(150), up(1)))
      Bool.pick(List<&2, Cand>, is_button(a), cand(a, Bool.pick(U32, T.starts_ci("cancel", l), down(100), s), l) <> r, r)

def menu_cands(acts: List<&2, M.Act>, +no_effect: Bool) -> List<&2, Cand>:
  match acts:
    case Nil{}:
      Nil{}
    case Con{+a, rest}:
      +r = menu_cands(rest, no_effect)
      +l = M.Act.label(a)
      +s = Bool.pick(U32, no_effect, Bool.pick(U32, T.starts_ci("cancel", l), up(500), up(1)),
        Bool.pick(U32, T.has(l, "without exploit"), up(130), button_score(l)))
      Bool.pick(List<&2, Cand>, is_button(a), cand(a, s, l) <> r, r)

def any_label(acts: List<&2, M.Act>, +p: String) -> Bool:
  match acts:
    case Nil{}:
      False{}
    case Con{+a, rest}:
      Bool.and(is_button(a), T.has(M.Act.label(a), p)) || any_label(rest, p)

def menu(+st: M.State, +p: M.Prompt, +acts: List<&2, M.Act>) -> List<&2, Cand>:
  +title = M.Prompt.title(p)
  Bool.pick(List<&2, Cand>, T.has(title, "mulligan"), mulligan(st, acts),
    Bool.pick(List<&2, Cand>, any_label(acts, "opponent"), player_choice(acts, U32.is_eq(polarity(title), 2)),
      menu_cands(acts, T.has(title, "will have no effect"))))

# Leaving a loop: an exit if there is one, else a different action each time
# --------------------------------------------------------------------------

def nth_act(acts: List<&2, M.Act>, +n: U32) -> List<&2, Cand>:
  match acts:
    case Nil{}:
      Nil{}
    case Con{+a, rest}:
      Bool.pick(List<&2, Cand>, U32.is_eq(n, 0), [cand(a, up(1), "escape " ++ M.Act.label(a))], nth_act(rest, (n - 1 : U32)))

def escape(+acts: List<&2, M.Act>, +reps: U32) -> List<&2, Cand>:
  +ex = exit_cands(acts)
  Bool.pick(List<&2, Cand>, List.is_empty(&2, Cand, ex), nth_act(acts, (reps % U32.max(len_acts(acts), 1) : U32)), ex)

# The decision
# ------------

def observe(mem: Mem, +round: U32, +key: String, +sel_n: U32, +multi: Bool) -> Mem:
  Mem{r0, tried, attacker, +k0, reps, +pick, s0, +bad} = mem
  +same = String.eq(k0, key)
  +same_sel = Bool.and(same, U32.is_eq(s0, sel_n))
  +noop = Bool.and(Bool.and(same_sel, multi), Bool.not(String.is_empty(pick)))
  Mem{round, Bool.pick(List<&2, String>, U32.is_eq(r0, round), tried, Nil{}), attacker, key,
    Bool.pick(U32, same_sel, (reps + 1 : U32), 0), pick, sel_n,
    Bool.pick(List<&2, String>, same, Bool.pick(List<&2, String>, noop, pick <> bad, bad), Nil{})}

# after the choice: remember the card it tried (action window) or clicked
def commit(mem: Mem, +c: Cand, +aw: Bool) -> Mem:
  Mem{round, +tried, +attacker, key, reps, pick, sel_n, bad} = mem
  +t = Cand.tried(c)
  Mem{round, Bool.pick(List<&2, String>, Bool.and(aw, Bool.not(String.is_empty(t))), t <> tried, tried),
    Bool.pick(String, aw, Cand.att(c), attacker), key, reps, Bool.pick(String, aw, "", t), sel_n, bad}

def key_of(+p: M.Prompt, +acts: List<&2, M.Act>) -> String:
  M.Prompt.sig(p) ++ "|" ++ M.Prompt.title(p) ++ "|" ++ U32.show(len_acts(acts))

# which handler, its candidates, and what to ask Jev (0 nothing, 1 the move,
# 2 a target, 3 a resource)
def handle(+cs: C.Cards, +st: M.State, +mem: Mem, +p: M.Prompt, +acts: List<&2, M.Act>) -> List<&2, Cand> & (String & U32):
  +title = M.Prompt.title(p)
  Bool.pick(List<&2, Cand> & (String & U32), M.Prompt.aw(p), (window(cs, st, mem, acts), ("window", 1)),
  Bool.pick(List<&2, Cand> & (String & U32), T.starts_ci("choose a target for attack", title), (attack_cands(st, attacker(st, mem), acts), ("attack", 2)),
  Bool.pick(List<&2, Cand> & (String & U32), String.eq(M.Prompt.ptype(p), "resource"), (resource(cs, st, p, acts), ("resource", 3)),
  Bool.pick(List<&2, Cand> & (String & U32), has_kind(acts, 6), (first_dist(acts, st, title), ("distribute", 0)),
  Bool.pick(List<&2, Cand> & (String & U32), has_kind(acts, 4), (display(cs, st, mem, p, acts), ("display", 0)),
  Bool.pick(List<&2, Cand> & (String & U32), has_kind(acts, 3), (options(acts), ("option", 0)),
  Bool.pick(List<&2, Cand> & (String & U32), has_kind(acts, 5), (first_kind(acts, 5), ("percard", 0)),
  Bool.pick(List<&2, Cand> & (String & U32), has_kind(acts, 2), (targets(cs, st, mem, p, acts), ("target", 2)),
    (menu(st, p, acts), ("menu", 0))))))))))

def first_any(acts: List<&2, M.Act>) -> List<&2, Cand>:
  match acts:
    case Nil{}:
      Nil{}
    case Con{+a, rest}:
      [cand(a, up(1), "first " ++ M.Act.label(a))]

def or_first(cs: List<&2, Cand>, acts: List<&2, M.Act>) -> List<&2, Cand>:
  match cs:
    case Nil{}:
      first_any(acts)
    case Con{c, rest}:
      c <> rest

def finish(h: List<&2, Cand> & (String & U32), +mem: Mem, +stuck: Bool, +acts: List<&2, M.Act>) -> Out:
  (cands, rest) = h
  (cls, ask) = rest
  Out{or_first(Bool.pick(List<&2, Cand>, stuck, escape(acts, Mem.reps(mem)), cands), acts), mem,
    Bool.pick(String, stuck, "escape", cls), Bool.pick(U32, stuck, 0, ask)}

def decide(+cs: C.Cards, mem: Mem, +m: M.Msg) -> Out:
  +p = M.Msg.prompt(m)
  +st = M.Msg.state(m)
  +acts = M.Msg.acts(m)
  +mem2 = observe(mem, M.State.round(st), key_of(p, acts), len_strs(M.Prompt.selected(p)), M.Prompt.multi(p))
  +stuck = Bool.and(Bool.not(M.Prompt.aw(p)), U32.is_ge(Mem.reps(mem2), 8))
  finish(handle(cs, st, mem2, p, acts), mem2, stuck, acts)

# Ranking
# -------

def cand_ins(xs: List<&2, Cand>, +x: Cand) -> List<&2, Cand>:
  match xs:
    case Nil{}:
      [x]
    case Con{+y, +rest}:
      Bool.pick(List<&2, Cand>, U32.is_gt(Cand.score(x), Cand.score(y)), x <> y <> rest, y <> cand_ins(rest, x))

# best first (ties keep their order)
def rank(cs: List<&2, Cand>, acc: List<&2, Cand>) -> List<&2, Cand>:
  match cs:
    case Nil{}:
      acc
    case Con{+c, rest}:
      rank(rest, cand_ins(acc, c))

# the top k candidates that are not clearly bad (score at least Z - 20)
def contenders(cs: List<&2, Cand>, +k: U32) -> List<&2, Cand>:
  match cs:
    case Nil{}:
      Nil{}
    case Con{+c, rest}:
      Bool.pick(List<&2, Cand>, Bool.and(U32.is_gt(k, 0), U32.is_ge(Cand.score(c), (E.Z() - 20 : U32))),
        c <> contenders(rest, (k - 1 : U32)), Nil{})

# the top k candidates within margin of the best (Jev as a tie-breaker)
def close(cs: List<&2, Cand>, +floor: U32, +k: U32) -> List<&2, Cand>:
  match cs:
    case Nil{}:
      Nil{}
    case Con{+c, rest}:
      Bool.pick(List<&2, Cand>, Bool.and(U32.is_gt(k, 0), U32.is_ge(Cand.score(c), floor)),
        c <> close(rest, floor, (k - 1 : U32)), Nil{})

def nth_cand(cs: List<&2, Cand>, +n: U32, +d: Cand) -> Cand:
  match cs:
    case Nil{}:
      d
    case Con{+c, rest}:
      Bool.pick(Cand, U32.is_eq(n, 0), c, nth_cand(rest, (n - 1 : U32), d))

def show_score(+s: U32) -> String:
  Bool.pick(String, U32.is_ge(s, E.Z()), "+" ++ U32.show((s - E.Z() : U32)), "-" ++ U32.show((E.Z() - s : U32)))
