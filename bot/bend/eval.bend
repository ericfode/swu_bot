# What things are worth, in tenths of a point of base damage.
#
# The bot races: damage to the enemy base is the currency, and a unit is worth
# the damage it will deal (power) plus how hard it is to remove (remaining hp
# and keywords). Scores are U32 around a zero point Z, so they can go below
# zero without signed numbers.
import Base
import ./cards.bend as C
import ./model.bend as M

def Z() -> U32:
  1000000

def lethal() -> U32:
  200000

def plus(s: U32, x: U32) -> U32:
  (s + x : U32)

def minus(s: U32, x: U32) -> U32:
  (s - x : U32)

# a - b, floored at 0
def sub0(+a: U32, +b: U32) -> U32:
  Bool.pick(U32, U32.is_gt(a, b), (a - b : U32), 0)

def kw(+p: M.Piece, bit: U32) -> Bool:
  C.has(C.Info.kw(M.Piece.info(p)), bit)

def rem(+p: M.Piece) -> U32:
  sub0(M.Piece.h(p), M.Piece.d(p))

def bonus(c: Bool, x: U32) -> U32:
  Bool.pick(U32, c, x, 0)

# A unit's worth
def worth(+p: M.Piece) -> U32:
  (M.Piece.p(p) * 20 + rem(p) * 8 + M.Piece.shields(p) * 15 + bonus(M.Piece.sentinel(p), 10) +
    bonus(kw(p, C.kw_overwhelm()), 6) + bonus(kw(p, C.kw_raid()), 6) + bonus(kw(p, C.kw_saboteur()), 6) +
    bonus(kw(p, C.kw_restore()), 6) + bonus(kw(p, C.kw_grit()), 4) + bonus(M.Piece.leader(p), 30) : U32)

# what one point of damage to a base with r hp left is worth
def per_point(+r: U32) -> U32:
  Bool.pick(U32, U32.is_le(r, 6), 25, Bool.pick(U32, U32.is_le(r, 12), 15, 10))

# a points of damage to a base with r left
def base_hit(+a: U32, +r: U32) -> U32:
  Bool.pick(U32, U32.is_ge(a, r), lethal(), (a * per_point(sub0(r, a)) : U32))

def base_left(+s: M.Side) -> U32:
  sub0(M.Side.base_hp(s), M.Side.base_d(s))

# Combat
# ------

# attack power: power, plus Raid while attacking
def atk(+a: M.Piece) -> U32:
  (M.Piece.p(a) + bonus(kw(a, C.kw_raid()), C.Info.raid(M.Piece.info(a))) : U32)

# value of a attacking the enemy base (r hp left), healing mine (mine_d damage) with Restore
def hit_base(+a: M.Piece, +r: U32, +mine_d: U32) -> U32:
  plus(plus(Z(), base_hit(atk(a), r)),
    (U32.min(mine_d, bonus(kw(a, C.kw_restore()), C.Info.restore(M.Piece.info(a)))) * 8 : U32))

# value of a attacking unit t, with r hp left on the enemy base
def hit_unit(+a: M.Piece, +t: M.Piece, +r: U32) -> U32:
  +sab = kw(a, C.kw_saboteur())
  +t_shield = Bool.and(U32.is_gt(M.Piece.shields(t), 0), Bool.not(sab))
  +dmg = Bool.pick(U32, t_shield, 0, atk(a))
  +kill = U32.is_ge(dmg, rem(t))
  +a_shield = U32.is_gt(M.Piece.shields(a), 0)
  +back = Bool.pick(U32, a_shield, 0, M.Piece.p(t))
  +dies = Bool.and(U32.is_ge(back, rem(a)), U32.is_gt(back, 0))
  +gain = (Bool.pick(U32, kill, worth(t), (dmg * 4 : U32)) + bonus(t_shield, 15) +
    bonus(Bool.and(kill, kw(a, C.kw_overwhelm())), base_hit(sub0(dmg, rem(t)), r)) : U32)
  +loss = (Bool.pick(U32, dies, worth(a), (back * 4 : U32)) + bonus(a_shield, 15) : U32)
  minus(plus(Z(), gain), loss)
