# Questions about the board: find a card by id, what a card in hand costs me
# and is worth, and what my units can do this round.
import Base
import ./cards.bend as C
import ./model.bend as M
import ./eval.bend as E

def find(ps: List<&2, M.Piece>, +id: String) -> Maybe<&2, M.Piece>:
  match ps:
    case Nil{}:
      None{}
    case Con{+p, rest}:
      Bool.pick(Maybe<&2, M.Piece>, String.eq(M.Piece.id(p), id), Some{p}, find(rest, id))

def is_some(m: Maybe<&2, M.Piece>) -> Bool:
  Maybe.is_some(&2, M.Piece, m)

def mine(+st: M.State) -> List<&2, M.Piece>:
  M.Side.units(M.State.me(st))

def theirs(+st: M.State) -> List<&2, M.Piece>:
  M.Side.units(M.State.opp(st))

def contains(xs: List<&2, String>, +x: String) -> Bool:
  match xs:
    case Nil{}:
      False{}
    case Con{y, rest}:
      String.eq(y, x) || contains(rest, x)

# Costs
# -----

# missing aspect icons of one aspect, times 2
def gap(+need: U32, +have: U32) -> U32:
  (E.sub0(need, have) * 2 : U32)

# printed cost plus the aspect penalty against my leader and base
def eff_cost(+i: C.Info, +s: M.Side) -> U32:
  (C.Info.cost(i) + gap(C.Info.vig(i), M.Side.vig(s)) + gap(C.Info.cmd(i), M.Side.cmd(s)) +
    gap(C.Info.agg(i), M.Side.agg(s)) + gap(C.Info.cun(i), M.Side.cun(s)) +
    gap(C.Info.her(i), M.Side.her(s)) + gap(C.Info.vil(i), M.Side.vil(s)) : U32)

def penalty(+i: C.Info, +s: M.Side) -> U32:
  E.sub0(eff_cost(i, s), C.Info.cost(i))

# Units by arena
# --------------

def in_arena(ps: List<&2, M.Piece>, +arena: U32) -> List<&2, M.Piece>:
  match ps:
    case Nil{}:
      Nil{}
    case Con{+p, rest}:
      +r = in_arena(rest, arena)
      Bool.pick(List<&2, M.Piece>, U32.is_eq(M.Piece.arena(p), arena), p <> r, r)

def sentinels(ps: List<&2, M.Piece>) -> List<&2, M.Piece>:
  match ps:
    case Nil{}:
      Nil{}
    case Con{+p, rest}:
      +r = sentinels(rest)
      Bool.pick(List<&2, M.Piece>, M.Piece.sentinel(p), p <> r, r)

def total_power(ps: List<&2, M.Piece>) -> U32:
  match ps:
    case Nil{}:
      0
    case Con{+p, rest}:
      (M.Piece.p(p) + total_power(rest) : U32)

def max_worth(ps: List<&2, M.Piece>) -> U32:
  match ps:
    case Nil{}:
      0
    case Con{+p, rest}:
      U32.max(E.worth(p), max_worth(rest))

# the most an attack of d damage gains against these units (kill: its worth plus 20)
def best_hit(ps: List<&2, M.Piece>, +d: U32) -> U32:
  match ps:
    case Nil{}:
      0
    case Con{+p, rest}:
      +v = Bool.pick(U32, Bool.and(U32.is_ge(d, E.rem(p)), U32.is_eq(M.Piece.shields(p), 0)), (E.worth(p) + 20 : U32), (d * 5 : U32))
      U32.max(v, best_hit(rest, d))

# Attacks
# -------

# the best value (around Z) of a attacking one of these targets, or the base when it can
def best_target(+a: M.Piece, ts: List<&2, M.Piece>, +base_ok: Bool, +r: U32, +my_d: U32) -> U32:
  match ts:
    case Nil{}:
      Bool.pick(U32, base_ok, E.hit_base(a, r, my_d), E.minus(E.Z(), 100))
    case Con{+t, rest}:
      U32.max(E.hit_unit(a, t, r), best_target(a, rest, base_ok, r, my_d))

# what attacking with my unit a is worth now (around Z), against the enemy board
def attack_value(+a: M.Piece, +st: M.State) -> U32:
  +opp = M.State.opp(st)
  +foes = in_arena(M.Side.units(opp), M.Piece.arena(a))
  +sents = sentinels(foes)
  +blocked = Bool.and(Bool.not(List.is_empty(&2, M.Piece, sents)), Bool.not(E.kw(a, C.kw_saboteur())))
  best_target(a, Bool.pick(List<&2, M.Piece>, blocked, sents, foes), Bool.not(blocked), E.base_left(opp), M.Side.base_d(M.State.me(st)))

# damage my ready units can put on the enemy base this round
def reach(ps: List<&2, M.Piece>, +st: M.State) -> U32:
  match ps:
    case Nil{}:
      0
    case Con{+p, rest}:
      +foes = in_arena(theirs(st), M.Piece.arena(p))
      +open = List.is_empty(&2, M.Piece, sentinels(foes)) || E.kw(p, C.kw_saboteur())
      (Bool.pick(U32, Bool.and(M.Piece.ready(p), open), E.atk(p), 0) + reach(rest, st) : U32)

def can_kill_base(+st: M.State) -> Bool:
  U32.is_ge(reach(mine(st), st), E.base_left(M.State.opp(st)))

# Card values (what playing a card adds, in the same tenths)
# ---------------------------------------------------------

def unit_value(+i: C.Info) -> U32:
  (C.Info.cost(i) * 12 + (C.Info.power(i) + C.Info.hp(i)) * 4 +
    E.bonus(C.has(C.Info.kw(i), C.kw_sentinel()), 6) + E.bonus(C.has(C.Info.kw(i), C.kw_shielded()), 10) +
    E.bonus(C.has(C.Info.kw(i), C.kw_ambush()), 8) : U32)

def fx(+i: C.Info, bit: U32) -> Bool:
  C.has(C.Info.fx(i), bit)

def event_value(+i: C.Info, +st: M.State) -> U32:
  +foes = theirs(st)
  +friends = mine(st)
  +have = Bool.not(List.is_empty(&2, M.Piece, friends))
  +n = C.Info.fx_n(i)
  U32.max((C.Info.cost(i) * 6 : U32),
    U32.max(E.bonus(fx(i, C.fx_damage()), best_hit(foes, n)),
    U32.max(E.bonus(Bool.or(fx(i, C.fx_defeat()), fx(i, C.fx_capture())), max_worth(foes)),
    U32.max(E.bonus(fx(i, C.fx_bounce()), (max_worth(foes) * 6 / 10 : U32)),
    U32.max(E.bonus(fx(i, C.fx_draw()), 25),
    U32.max(E.bonus(fx(i, C.fx_token()), 30),
    U32.max(E.bonus(Bool.and(have, fx(i, C.fx_shield()) || fx(i, C.fx_experience()) || fx(i, C.fx_buff())), 25),
    U32.max(E.bonus(fx(i, C.fx_basedamage()), (n * 10 : U32)),
      E.bonus(fx(i, C.fx_search()), 20)))))))))

def upgrade_value(+i: C.Info, +st: M.State) -> U32:
  Bool.pick(U32, List.is_empty(&2, M.Piece, mine(st)), 0,
    (C.Info.cost(i) * 8 + (C.Info.up_p(i) * 20 + C.Info.up_h(i) * 8) : U32))

# what playing a card is worth (0: nothing useful)
def card_value(+i: C.Info, +st: M.State) -> U32:
  +k = C.Info.kind(i)
  Bool.pick(U32, U32.is_eq(k, 1) || U32.is_eq(k, 6), unit_value(i),
    Bool.pick(U32, U32.is_eq(k, 2), event_value(i, st),
      Bool.pick(U32, U32.is_eq(k, 3) || U32.is_eq(k, 7), upgrade_value(i, st),
        (C.Info.cost(i) * 8 : U32))))
