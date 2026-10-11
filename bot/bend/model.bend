# The decide message as records: the board from my seat, the prompt, and the
# legal actions. Card numbers come from the card table by set code; the
# protocol's own live numbers (power, hp, damage) win where both exist.
import Base
import ./json.bend as J
import ./io.bend as I
import ./cards.bend as C

# A unit in play (a Piece, since Base owns the name Unit). arena: 1 ground, 2 space. p, h, d: power, hp, damage now.
# shields/exps: Shield and Experience tokens; ups: other upgrades.
type Piece is Data:
  Piece{id: String, code: String, mine: Bool, arena: U32, p: U32, h: U32, d: U32, ready: Bool, sentinel: Bool, shields: U32, exps: U32, ups: U32, leader: Bool, info: C.Info}

def Piece.id(x: Piece) -> String:
  Piece{id, code, mine, arena, p, h, d, ready, sentinel, shields, exps, ups, leader, info} = x
  id

def Piece.code(x: Piece) -> String:
  Piece{id, code, mine, arena, p, h, d, ready, sentinel, shields, exps, ups, leader, info} = x
  code

def Piece.mine(x: Piece) -> Bool:
  Piece{id, code, mine, arena, p, h, d, ready, sentinel, shields, exps, ups, leader, info} = x
  mine

def Piece.arena(x: Piece) -> U32:
  Piece{id, code, mine, arena, p, h, d, ready, sentinel, shields, exps, ups, leader, info} = x
  arena

def Piece.p(x: Piece) -> U32:
  Piece{id, code, mine, arena, p, h, d, ready, sentinel, shields, exps, ups, leader, info} = x
  p

def Piece.h(x: Piece) -> U32:
  Piece{id, code, mine, arena, p, h, d, ready, sentinel, shields, exps, ups, leader, info} = x
  h

def Piece.d(x: Piece) -> U32:
  Piece{id, code, mine, arena, p, h, d, ready, sentinel, shields, exps, ups, leader, info} = x
  d

def Piece.ready(x: Piece) -> Bool:
  Piece{id, code, mine, arena, p, h, d, ready, sentinel, shields, exps, ups, leader, info} = x
  ready

def Piece.sentinel(x: Piece) -> Bool:
  Piece{id, code, mine, arena, p, h, d, ready, sentinel, shields, exps, ups, leader, info} = x
  sentinel

def Piece.shields(x: Piece) -> U32:
  Piece{id, code, mine, arena, p, h, d, ready, sentinel, shields, exps, ups, leader, info} = x
  shields

def Piece.exps(x: Piece) -> U32:
  Piece{id, code, mine, arena, p, h, d, ready, sentinel, shields, exps, ups, leader, info} = x
  exps

def Piece.ups(x: Piece) -> U32:
  Piece{id, code, mine, arena, p, h, d, ready, sentinel, shields, exps, ups, leader, info} = x
  ups

def Piece.leader(x: Piece) -> Bool:
  Piece{id, code, mine, arena, p, h, d, ready, sentinel, shields, exps, ups, leader, info} = x
  leader

def Piece.info(x: Piece) -> C.Info:
  Piece{id, code, mine, arena, p, h, d, ready, sentinel, shields, exps, ups, leader, info} = x
  info

# A card in my hand or my resources (ready: an unexhausted resource).
type HCard is Data:
  HCard{id: String, code: String, ready: Bool, info: C.Info}

def HCard.id(x: HCard) -> String:
  HCard{id, code, ready, info} = x
  id

def HCard.code(x: HCard) -> String:
  HCard{id, code, ready, info} = x
  code

def HCard.ready(x: HCard) -> Bool:
  HCard{id, code, ready, info} = x
  ready

def HCard.info(x: HCard) -> C.Info:
  HCard{id, code, ready, info} = x
  info

# One player. vig..vil: aspect icons of leader plus base (for the +2 aspect penalty).
type Side is Data:
  Side{base_id: String, base_code: String, base_hp: U32, base_d: U32, leader_id: String, leader_code: String, leader_dep: Bool, leader_x: Bool, res_ready: U32, res_total: U32, hand_n: U32, deck: U32, discard_n: U32, units: List<&2, Piece>, hand: List<&2, HCard>, resources: List<&2, HCard>, vig: U32, cmd: U32, agg: U32, cun: U32, her: U32, vil: U32}

def Side.base_id(x: Side) -> String:
  Side{base_id, base_code, base_hp, base_d, leader_id, leader_code, leader_dep, leader_x, res_ready, res_total, hand_n, deck, discard_n, units, hand, resources, vig, cmd, agg, cun, her, vil} = x
  base_id

def Side.base_code(x: Side) -> String:
  Side{base_id, base_code, base_hp, base_d, leader_id, leader_code, leader_dep, leader_x, res_ready, res_total, hand_n, deck, discard_n, units, hand, resources, vig, cmd, agg, cun, her, vil} = x
  base_code

def Side.base_hp(x: Side) -> U32:
  Side{base_id, base_code, base_hp, base_d, leader_id, leader_code, leader_dep, leader_x, res_ready, res_total, hand_n, deck, discard_n, units, hand, resources, vig, cmd, agg, cun, her, vil} = x
  base_hp

def Side.base_d(x: Side) -> U32:
  Side{base_id, base_code, base_hp, base_d, leader_id, leader_code, leader_dep, leader_x, res_ready, res_total, hand_n, deck, discard_n, units, hand, resources, vig, cmd, agg, cun, her, vil} = x
  base_d

def Side.leader_id(x: Side) -> String:
  Side{base_id, base_code, base_hp, base_d, leader_id, leader_code, leader_dep, leader_x, res_ready, res_total, hand_n, deck, discard_n, units, hand, resources, vig, cmd, agg, cun, her, vil} = x
  leader_id

def Side.leader_code(x: Side) -> String:
  Side{base_id, base_code, base_hp, base_d, leader_id, leader_code, leader_dep, leader_x, res_ready, res_total, hand_n, deck, discard_n, units, hand, resources, vig, cmd, agg, cun, her, vil} = x
  leader_code

def Side.leader_dep(x: Side) -> Bool:
  Side{base_id, base_code, base_hp, base_d, leader_id, leader_code, leader_dep, leader_x, res_ready, res_total, hand_n, deck, discard_n, units, hand, resources, vig, cmd, agg, cun, her, vil} = x
  leader_dep

def Side.leader_x(x: Side) -> Bool:
  Side{base_id, base_code, base_hp, base_d, leader_id, leader_code, leader_dep, leader_x, res_ready, res_total, hand_n, deck, discard_n, units, hand, resources, vig, cmd, agg, cun, her, vil} = x
  leader_x

def Side.res_ready(x: Side) -> U32:
  Side{base_id, base_code, base_hp, base_d, leader_id, leader_code, leader_dep, leader_x, res_ready, res_total, hand_n, deck, discard_n, units, hand, resources, vig, cmd, agg, cun, her, vil} = x
  res_ready

def Side.res_total(x: Side) -> U32:
  Side{base_id, base_code, base_hp, base_d, leader_id, leader_code, leader_dep, leader_x, res_ready, res_total, hand_n, deck, discard_n, units, hand, resources, vig, cmd, agg, cun, her, vil} = x
  res_total

def Side.hand_n(x: Side) -> U32:
  Side{base_id, base_code, base_hp, base_d, leader_id, leader_code, leader_dep, leader_x, res_ready, res_total, hand_n, deck, discard_n, units, hand, resources, vig, cmd, agg, cun, her, vil} = x
  hand_n

def Side.deck(x: Side) -> U32:
  Side{base_id, base_code, base_hp, base_d, leader_id, leader_code, leader_dep, leader_x, res_ready, res_total, hand_n, deck, discard_n, units, hand, resources, vig, cmd, agg, cun, her, vil} = x
  deck

def Side.discard_n(x: Side) -> U32:
  Side{base_id, base_code, base_hp, base_d, leader_id, leader_code, leader_dep, leader_x, res_ready, res_total, hand_n, deck, discard_n, units, hand, resources, vig, cmd, agg, cun, her, vil} = x
  discard_n

def Side.units(x: Side) -> List<&2, Piece>:
  Side{base_id, base_code, base_hp, base_d, leader_id, leader_code, leader_dep, leader_x, res_ready, res_total, hand_n, deck, discard_n, units, hand, resources, vig, cmd, agg, cun, her, vil} = x
  units

def Side.hand(x: Side) -> List<&2, HCard>:
  Side{base_id, base_code, base_hp, base_d, leader_id, leader_code, leader_dep, leader_x, res_ready, res_total, hand_n, deck, discard_n, units, hand, resources, vig, cmd, agg, cun, her, vil} = x
  hand

def Side.resources(x: Side) -> List<&2, HCard>:
  Side{base_id, base_code, base_hp, base_d, leader_id, leader_code, leader_dep, leader_x, res_ready, res_total, hand_n, deck, discard_n, units, hand, resources, vig, cmd, agg, cun, her, vil} = x
  resources

def Side.vig(x: Side) -> U32:
  Side{base_id, base_code, base_hp, base_d, leader_id, leader_code, leader_dep, leader_x, res_ready, res_total, hand_n, deck, discard_n, units, hand, resources, vig, cmd, agg, cun, her, vil} = x
  vig

def Side.cmd(x: Side) -> U32:
  Side{base_id, base_code, base_hp, base_d, leader_id, leader_code, leader_dep, leader_x, res_ready, res_total, hand_n, deck, discard_n, units, hand, resources, vig, cmd, agg, cun, her, vil} = x
  cmd

def Side.agg(x: Side) -> U32:
  Side{base_id, base_code, base_hp, base_d, leader_id, leader_code, leader_dep, leader_x, res_ready, res_total, hand_n, deck, discard_n, units, hand, resources, vig, cmd, agg, cun, her, vil} = x
  agg

def Side.cun(x: Side) -> U32:
  Side{base_id, base_code, base_hp, base_d, leader_id, leader_code, leader_dep, leader_x, res_ready, res_total, hand_n, deck, discard_n, units, hand, resources, vig, cmd, agg, cun, her, vil} = x
  cun

def Side.her(x: Side) -> U32:
  Side{base_id, base_code, base_hp, base_d, leader_id, leader_code, leader_dep, leader_x, res_ready, res_total, hand_n, deck, discard_n, units, hand, resources, vig, cmd, agg, cun, her, vil} = x
  her

def Side.vil(x: Side) -> U32:
  Side{base_id, base_code, base_hp, base_d, leader_id, leader_code, leader_dep, leader_x, res_ready, res_total, hand_n, deck, discard_n, units, hand, resources, vig, cmd, agg, cun, her, vil} = x
  vil

# The board from my seat.
type State is Data:
  State{round: U32, phase: String, my_init: Bool, opp_init: Bool, me: Side, opp: Side}

def State.round(x: State) -> U32:
  State{round, phase, my_init, opp_init, me, opp} = x
  round

def State.phase(x: State) -> String:
  State{round, phase, my_init, opp_init, me, opp} = x
  phase

def State.my_init(x: State) -> Bool:
  State{round, phase, my_init, opp_init, me, opp} = x
  my_init

def State.opp_init(x: State) -> Bool:
  State{round, phase, my_init, opp_init, me, opp} = x
  opp_init

def State.me(x: State) -> Side:
  State{round, phase, my_init, opp_init, me, opp} = x
  me

def State.opp(x: State) -> Side:
  State{round, phase, my_init, opp_init, me, opp} = x
  opp

# The prompt being answered (aw: the top-level action window).
type Prompt is Data:
  Prompt{ptype: String, sig: String, title: String, ptitle: String, multi: Bool, selected: List<&2, String>, aw: Bool}

def Prompt.ptype(x: Prompt) -> String:
  Prompt{ptype, sig, title, ptitle, multi, selected, aw} = x
  ptype

def Prompt.sig(x: Prompt) -> String:
  Prompt{ptype, sig, title, ptitle, multi, selected, aw} = x
  sig

def Prompt.title(x: Prompt) -> String:
  Prompt{ptype, sig, title, ptitle, multi, selected, aw} = x
  title

def Prompt.ptitle(x: Prompt) -> String:
  Prompt{ptype, sig, title, ptitle, multi, selected, aw} = x
  ptitle

def Prompt.multi(x: Prompt) -> Bool:
  Prompt{ptype, sig, title, ptitle, multi, selected, aw} = x
  multi

def Prompt.selected(x: Prompt) -> List<&2, String>:
  Prompt{ptype, sig, title, ptitle, multi, selected, aw} = x
  selected

def Prompt.aw(x: Prompt) -> Bool:
  Prompt{ptype, sig, title, ptitle, multi, selected, aw} = x
  aw

# A clickable card. zone: 1 hand, 2 ground, 3 space, 4 base (leaders and bases), 5 resource, 6 discard, 0 other.
type CRef is Data:
  CRef{id: String, code: String, zone: U32, mine: Bool}

def CRef.id(x: CRef) -> String:
  CRef{id, code, zone, mine} = x
  id

def CRef.code(x: CRef) -> String:
  CRef{id, code, zone, mine} = x
  code

def CRef.zone(x: CRef) -> U32:
  CRef{id, code, zone, mine} = x
  zone

def CRef.mine(x: CRef) -> Bool:
  CRef{id, code, zone, mine} = x
  mine

# A distribute target.
type DT is Data:
  DT{id: String, cap: U32, capped: Bool}

def DT.id(x: DT) -> String:
  DT{id, cap, capped} = x
  id

def DT.cap(x: DT) -> U32:
  DT{id, cap, capped} = x
  cap

def DT.capped(x: DT) -> Bool:
  DT{id, cap, capped} = x
  capped

# A distribute prompt (max_t 0: no limit).
type Dist is Data:
  Dist{dtype: String, amount: U32, less: Bool, none_ok: Bool, max_t: U32, targets: List<&2, DT>}

def Dist.dtype(x: Dist) -> String:
  Dist{dtype, amount, less, none_ok, max_t, targets} = x
  dtype

def Dist.amount(x: Dist) -> U32:
  Dist{dtype, amount, less, none_ok, max_t, targets} = x
  amount

def Dist.less(x: Dist) -> Bool:
  Dist{dtype, amount, less, none_ok, max_t, targets} = x
  less

def Dist.none_ok(x: Dist) -> Bool:
  Dist{dtype, amount, less, none_ok, max_t, targets} = x
  none_ok

def Dist.max_t(x: Dist) -> U32:
  Dist{dtype, amount, less, none_ok, max_t, targets} = x
  max_t

def Dist.targets(x: Dist) -> List<&2, DT>:
  Dist{dtype, amount, less, none_ok, max_t, targets} = x
  targets

# A legal action. kind: 1 button, 2 card, 3 option, 4 displayCard, 5 perCardButton, 6 distribute.
# arg is the text of the arg; argn is it as a number.
type Act is Data:
  Act{i: U32, kind: U32, label: String, arg: String, argn: U32, has_card: Bool, card: CRef, dist: Dist}

def Act.i(x: Act) -> U32:
  Act{i, kind, label, arg, argn, has_card, card, dist} = x
  i

def Act.kind(x: Act) -> U32:
  Act{i, kind, label, arg, argn, has_card, card, dist} = x
  kind

def Act.label(x: Act) -> String:
  Act{i, kind, label, arg, argn, has_card, card, dist} = x
  label

def Act.arg(x: Act) -> String:
  Act{i, kind, label, arg, argn, has_card, card, dist} = x
  arg

def Act.argn(x: Act) -> U32:
  Act{i, kind, label, arg, argn, has_card, card, dist} = x
  argn

def Act.has_card(x: Act) -> Bool:
  Act{i, kind, label, arg, argn, has_card, card, dist} = x
  has_card

def Act.card(x: Act) -> CRef:
  Act{i, kind, label, arg, argn, has_card, card, dist} = x
  card

def Act.dist(x: Act) -> Dist:
  Act{i, kind, label, arg, argn, has_card, card, dist} = x
  dist

# One decide message.
type Msg is Data:
  Msg{seq: U32, you: String, prompt: Prompt, state: State, acts: List<&2, Act>}

def Msg.seq(x: Msg) -> U32:
  Msg{seq, you, prompt, state, acts} = x
  seq

def Msg.you(x: Msg) -> String:
  Msg{seq, you, prompt, state, acts} = x
  you

def Msg.prompt(x: Msg) -> Prompt:
  Msg{seq, you, prompt, state, acts} = x
  prompt

def Msg.state(x: Msg) -> State:
  Msg{seq, you, prompt, state, acts} = x
  state

def Msg.acts(x: Msg) -> List<&2, Act>:
  Msg{seq, you, prompt, state, acts} = x
  acts

# Decoding
# --------

def str(j: J.Json) -> String:
  I.text(J.str(j))

def zone_of(+z: String) -> U32:
  Bool.pick(U32, String.eq(z, "hand"), 1,
    Bool.pick(U32, String.eq(z, "groundArena"), 2,
      Bool.pick(U32, String.eq(z, "spaceArena"), 3,
        Bool.pick(U32, String.eq(z, "base"), 4,
          Bool.pick(U32, String.eq(z, "resource"), 5,
            Bool.pick(U32, String.eq(z, "discard"), 6, 0))))))

def is_shield(+u: J.Json) -> Bool:
  String.eq(str(J.get(u, "n")), "Shield")

def is_exp(+u: J.Json) -> Bool:
  String.eq(str(J.get(u, "n")), "Experience")

def count_ups(us: List<&2, J.Json>, +shields: U32, +exps: U32, +others: U32) -> U32 & (U32 & U32):
  match us:
    case Nil{}:
      (shields, (exps, others))
    case Con{+u, rest}:
      +s = is_shield(u)
      +e = is_exp(u)
      count_ups(rest, Bool.pick(U32, s, (shields + 1 : U32), shields), Bool.pick(U32, e, (exps + 1 : U32), exps),
        Bool.pick(U32, s || e, others, (others + 1 : U32)))

def piece_with(+cs: C.Cards, mine: Bool, arena: U32, +j: J.Json, ups: U32 & (U32 & U32)) -> Piece:
  (sh, rest) = ups
  (ex, ot) = rest
  +code = str(J.get(j, "s"))
  +info = C.info_of(cs, code)
  Piece{str(J.get(j, "id")), code, mine, arena, J.num(J.get(j, "p")), J.num(J.get(j, "h")), J.num(J.get(j, "d")),
    Bool.not(J.flag(J.get(j, "x"))), J.flag(J.get(j, "sn")), sh, ex, ot,
    U32.is_eq(C.Info.kind(info), 4), info}

def piece(+cs: C.Cards, +mine: Bool, +arena: U32, +j: J.Json) -> Piece:
  piece_with(cs, mine, arena, j, count_ups(J.arr(J.get(j, "u")), 0, 0, 0))

def units(+cs: C.Cards, +mine: Bool, +arena: U32, js: List<&2, J.Json>) -> List<&2, Piece>:
  match js:
    case Nil{}:
      Nil{}
    case Con{j, rest}:
      piece(cs, mine, arena, j) <> units(cs, mine, arena, rest)

def hcards(+cs: C.Cards, js: List<&2, J.Json>) -> List<&2, HCard>:
  match js:
    case Nil{}:
      Nil{}
    case Con{+j, rest}:
      +code = str(J.get(j, "s"))
      HCard{str(J.get(j, "id")), code, Bool.not(J.flag(J.get(j, "x"))), C.info_of(cs, code)} <> hcards(cs, rest)

def side_with(+cs: C.Cards, mine: Bool, +j: J.Json, +base: J.Json, +lead: J.Json, +res: J.Json) -> Side:
  +bcode = str(J.get(base, "s"))
  +lcode = str(J.get(lead, "s"))
  +bi = C.info_of(cs, bcode)
  +li = C.info_of(cs, lcode)
  +m = mine
  Side{str(J.get(base, "id")), bcode, J.num(J.get(base, "hp")), J.num(J.get(base, "d")),
    str(J.get(lead, "id")), lcode, J.flag(J.get(lead, "dep")), J.flag(J.get(lead, "x")),
    J.num(J.get(res, "ready")), J.num(J.get(res, "total")), J.num(J.get(j, "handCount")), J.num(J.get(j, "deck")),
    U32.from_nat(List.length(&2, J.Json, J.arr(J.get(j, "discard")))),
    List.append(&2, Piece, units(cs, m, 1, J.arr(J.get(j, "ground"))), units(cs, m, 2, J.arr(J.get(j, "space")))),
    hcards(cs, J.arr(J.get(j, "hand"))), hcards(cs, J.arr(J.get(j, "resources"))),
    (C.Info.vig(bi) + C.Info.vig(li) : U32), (C.Info.cmd(bi) + C.Info.cmd(li) : U32),
    (C.Info.agg(bi) + C.Info.agg(li) : U32), (C.Info.cun(bi) + C.Info.cun(li) : U32),
    (C.Info.her(bi) + C.Info.her(li) : U32), (C.Info.vil(bi) + C.Info.vil(li) : U32)}

def side(+cs: C.Cards, mine: Bool, +j: J.Json) -> Side:
  side_with(cs, mine, j, J.get(j, "base"), J.get(j, "leader"), J.get(j, "res"))

def other_seat(+you: String) -> String:
  Bool.pick(String, String.eq(you, "p1"), "p2", "p1")

def state(+cs: C.Cards, +you: String, +j: J.Json) -> State:
  +players = J.get(j, "players")
  +init = str(J.get(j, "initiative"))
  State{J.num(J.get(j, "round")), str(J.get(j, "phase")), String.eq(init, you), String.eq(init, other_seat(you)),
    side(cs, True{}, J.get(players, you)), side(cs, False{}, J.get(players, other_seat(you)))}

def strs(js: List<&2, J.Json>) -> List<&2, String>:
  match js:
    case Nil{}:
      Nil{}
    case Con{j, rest}:
      str(j) <> strs(rest)

def prompt(+j: J.Json) -> Prompt:
  Prompt{str(J.get(j, "type")), str(J.get(j, "signature")), str(J.get(j, "title")), str(J.get(j, "promptTitle")),
    String.eq(str(J.get(j, "selectCardMode")), "multiple"), strs(J.arr(J.get(j, "selected"))), J.flag(J.get(j, "actionWindow"))}

def kind_of(+k: String) -> U32:
  Bool.pick(U32, String.eq(k, "button"), 1,
    Bool.pick(U32, String.eq(k, "card"), 2,
      Bool.pick(U32, String.eq(k, "option"), 3,
        Bool.pick(U32, String.eq(k, "displayCard"), 4,
          Bool.pick(U32, String.eq(k, "perCardButton"), 5,
            Bool.pick(U32, String.eq(k, "distribute"), 6, 0))))))

# an arg is text or a number; keep both readings
def arg_text(j: J.Json) -> String:
  match j:
    case J.JStr{s}:
      I.text(s)
    case J.JNum{n, neg}:
      U32.show(n)
    case _:
      ""

def arg_num(j: J.Json) -> U32:
  match j:
    case J.JNum{n, neg}:
      n
    case J.JStr{s}:
      I.nat(s)
    case _:
      0

def cref(+you: String, +j: J.Json) -> CRef:
  CRef{str(J.get(j, "id")), str(J.get(j, "s")), zone_of(str(J.get(j, "zone"))), String.eq(str(J.get(j, "ctl")), you)}

def dts(js: List<&2, J.Json>) -> List<&2, DT>:
  match js:
    case Nil{}:
      Nil{}
    case Con{+j, rest}:
      +cap = J.get(j, "cap")
      DT{str(J.get(j, "id")), J.num(cap), Bool.not(J.is_null(cap))} <> dts(rest)

def dist(+j: J.Json) -> Dist:
  Dist{str(J.get(j, "type")), J.num(J.get(j, "amount")), J.flag(J.get(j, "canDistributeLess")),
    J.flag(J.get(j, "canChooseNoTargets")), J.num(J.get(j, "maxTargets")), dts(J.arr(J.get(j, "targets")))}

def act(+you: String, +j: J.Json) -> Act:
  +card = J.get(j, "card")
  +arg = J.get(j, "arg")
  Act{J.num(J.get(j, "i")), kind_of(str(J.get(j, "kind"))), str(J.get(j, "label")), arg_text(arg), arg_num(arg),
    Bool.not(J.is_null(card)), cref(you, card), dist(J.get(j, "distribute"))}

def acts(+you: String, js: List<&2, J.Json>) -> List<&2, Act>:
  match js:
    case Nil{}:
      Nil{}
    case Con{j, rest}:
      act(you, j) <> acts(you, rest)

def msg(+cs: C.Cards, +j: J.Json) -> Msg:
  +you = str(J.get(j, "you"))
  Msg{J.num(J.get(j, "seq")), you, prompt(J.get(j, "prompt")), state(cs, you, J.get(j, "state")), acts(you, J.arr(J.get(j, "actions")))}
