# TypeSafe's Jev model as a second opinion.
#
# The policy proposes the best few candidates; Jev gets the board (as short
# text lines) and picks one of them, and says how likely I am to win. One
# HTTPS call per decision through curl. The API key stays in the environment:
# curl reads TYPESAFE_API_KEY itself (--variable), so it never appears in this
# process, its arguments or its logs. Any failure means "no opinion".
import Base
import ./cards.bend as C
import ./model.bend as M
import ./eval.bend as E
import ./board.bend as Bd
import ./txt.bend as T
import ./policy.bend as P

# Text for the model
# ------------------

def take(s: String, +n: U32) -> String:
  match s:
    case SNil{}:
      SNil{}
    case SCon{c, t}:
      Bool.pick(String, U32.is_eq(n, 0), "...", SCon{c, take(t, (n - 1 : U32))})

def title(+cs: C.Cards, +code: String) -> String:
  C.Text.title(C.text_of(cs, code))

def kind_name(+k: U32) -> String:
  Bool.pick(String, U32.is_eq(k, 1) || U32.is_eq(k, 6), "unit",
    Bool.pick(String, U32.is_eq(k, 2), "event",
      Bool.pick(String, U32.is_eq(k, 3) || U32.is_eq(k, 7), "upgrade",
        Bool.pick(String, U32.is_eq(k, 4), "leader", "card"))))

def kw_name(+bits: U32, +bit: U32, name: String) -> String:
  Bool.pick(String, C.has(bits, bit), ", " ++ name, "")

def kws(+bits: U32) -> String:
  kw_name(bits, C.kw_sentinel(), "Sentinel") ++ kw_name(bits, C.kw_raid(), "Raid") ++
    kw_name(bits, C.kw_overwhelm(), "Overwhelm") ++ kw_name(bits, C.kw_ambush(), "Ambush") ++
    kw_name(bits, C.kw_restore(), "Restore") ++ kw_name(bits, C.kw_saboteur(), "Saboteur") ++
    kw_name(bits, C.kw_shielded(), "Shielded") ++ kw_name(bits, C.kw_grit(), "Grit") ++
    kw_name(bits, C.kw_hidden(), "Hidden")

def arena_name(+a: U32) -> String:
  Bool.pick(String, U32.is_eq(a, 1), "ground", "space")

def unit_line(+cs: C.Cards, +p: M.Piece) -> String:
  title(cs, M.Piece.code(p)) ++ Bool.pick(String, M.Piece.leader(p), " (leader)", "") ++ ": " ++
    arena_name(M.Piece.arena(p)) ++ ", " ++ U32.show(M.Piece.p(p)) ++ " power, " ++ U32.show(E.rem(p)) ++ " hp left, " ++
    Bool.pick(String, M.Piece.ready(p), "ready", "exhausted") ++ kws(C.Info.kw(M.Piece.info(p))) ++
    Bool.pick(String, U32.is_gt(M.Piece.shields(p), 0), ", " ++ U32.show(M.Piece.shields(p)) ++ " shield", "")

def units(+cs: C.Cards, ps: List<&2, M.Piece>) -> List<&2, String>:
  match ps:
    case Nil{}:
      Nil{}
    case Con{+p, rest}:
      T.q(unit_line(cs, p)) <> units(cs, rest)

def card_line(+cs: C.Cards, +me: M.Side, +code: String) -> String:
  +i = C.info_of(cs, code)
  +k = C.Info.kind(i)
  title(cs, code) ++ ": " ++ kind_name(k) ++ ", costs " ++ U32.show(Bd.eff_cost(i, me)) ++
    Bool.pick(String, U32.is_eq(k, 1) || U32.is_eq(k, 6), ", " ++ U32.show(C.Info.power(i)) ++ "/" ++ U32.show(C.Info.hp(i)), "") ++
    kws(C.Info.kw(i)) ++ ". " ++ take(C.Text.text(C.text_of(cs, code)), 160)

def hand(+cs: C.Cards, +me: M.Side, hs: List<&2, M.HCard>) -> List<&2, String>:
  match hs:
    case Nil{}:
      Nil{}
    case Con{+h, rest}:
      T.q(card_line(cs, me, M.HCard.code(h))) <> hand(cs, me, rest)

def leader_line(+cs: C.Cards, +s: M.Side) -> String:
  title(cs, M.Side.leader_code(s)) ++ Bool.pick(String, M.Side.leader_dep(s), " (deployed as a unit)",
    Bool.pick(String, M.Side.leader_x(s), " (exhausted)", " (ready)"))

def side(+cs: C.Cards, +s: M.Side, +mine: Bool) -> String:
  T.obj(List.append(&2, String, [
    T.kv("base_hp_left", T.n(E.base_left(s))),
    T.kv("leader", T.q(leader_line(cs, s))),
    T.kv("resources", T.q(U32.show(M.Side.res_ready(s)) ++ " ready of " ++ U32.show(M.Side.res_total(s)))),
    T.kv("cards_in_hand", T.n(M.Side.hand_n(s))),
    T.kv("units", T.arr(units(cs, M.Side.units(s))))],
    Bool.pick(List<&2, String>, mine, [T.kv("hand", T.arr(hand(cs, s, M.Side.hand(s))))], Nil{})))

def rules() -> String:
  "Star Wars: Unlimited. Each player has a base; the first to bring the enemy base to 0 hp wins. In the action phase players take turns doing one action each: play a card (pay its cost with ready resources), attack with a ready unit, use an ability, pass, or claim the initiative (no more actions this round, act first next round). A unit attacks an enemy unit in its own arena (ground or space) or the enemy base; in a unit fight both deal their power to each other at the same time. Units with Sentinel must be attacked first. Units played this round are exhausted and cannot attack. Each round you may put one card from hand into resources."

def state(+cs: C.Cards, +st: M.State) -> String:
  T.obj([
    T.kv("game", T.q(rules())),
    T.kv("round", T.n(M.State.round(st))),
    T.kv("initiative", T.q(Bool.pick(String, M.State.my_init(st), "me", "opponent"))),
    T.kv("me", side(cs, M.State.me(st), True{})),
    T.kv("opponent", side(cs, M.State.opp(st), False{}))])

# What a candidate does, in words
# -------------------------------

def act_at(acts: List<&2, M.Act>, +i: U32) -> M.Act:
  match acts:
    case Nil{}:
      M.Act{0, 0, "", "", 0, False{}, M.CRef{"", "", 0, False{}}, M.Dist{"", 0, False{}, False{}, 0, Nil{}}}
    case Con{+a, rest}:
      Bool.pick(M.Act, U32.is_eq(M.Act.i(a), i), a, act_at(rest, i))

def piece_line(m: Maybe<&2, M.Piece>, +cs: C.Cards, +code: String) -> String:
  match m:
    case Some{p}:
      unit_line(cs, p)
    case None{}:
      title(cs, code)

def card_act(+cs: C.Cards, +st: M.State, +ask: U32, +a: M.Act) -> String:
  +r = M.Act.card(a)
  +id = M.CRef.id(r)
  +code = M.CRef.code(r)
  +z = M.CRef.zone(r)
  +me = M.State.me(st)
  +opp = M.State.opp(st)
  +mine_base = String.eq(id, M.Side.base_id(me))
  +opp_base = String.eq(id, M.Side.base_id(opp))
  +unit = U32.is_eq(z, 2) || U32.is_eq(z, 3)
  Bool.pick(String, U32.is_eq(ask, 1),
    Bool.pick(String, U32.is_eq(z, 1) || U32.is_eq(z, 5), "play " ++ card_line(cs, me, code),
      Bool.pick(String, Bool.and(unit, M.CRef.mine(r)), "attack with my " ++ piece_line(P.piece_of(st, id), cs, code),
        Bool.pick(String, String.eq(id, M.Side.leader_id(me)), "use my leader " ++ leader_line(cs, me) ++ ": deploy it or use its ability",
          Bool.pick(String, mine_base, "use my base's ability: " ++ take(C.Text.text(C.text_of(cs, code)), 120),
            "use " ++ title(cs, code))))),
    Bool.pick(String, U32.is_eq(ask, 3), "put " ++ card_line(cs, me, code) ++ " into my resources",
      Bool.pick(String, opp_base, "the enemy base (" ++ U32.show(E.base_left(opp)) ++ " hp left)",
        Bool.pick(String, mine_base, "my own base",
          Bool.pick(String, unit, Bool.pick(String, M.CRef.mine(r), "my ", "enemy ") ++ piece_line(P.piece_of(st, id), cs, code),
            Bool.pick(String, M.CRef.mine(r), "my ", "enemy ") ++ title(cs, code))))))

def button_act(+l: String) -> String:
  Bool.pick(String, T.starts_ci("pass", l), "pass (I may still act later this round if the opponent acts)",
    Bool.pick(String, T.starts_ci("claim", l), "claim the initiative (I take no more actions this round and act first next round)",
      Bool.pick(String, T.starts_ci("cancel", l), "cancel", "choose: " ++ l)))

def act_text(+cs: C.Cards, +st: M.State, +ask: U32, +a: M.Act) -> String:
  Bool.pick(String, P.is_card(a), card_act(cs, st, ask, a), button_act(M.Act.label(a)))

def criteria(+cs: C.Cards, +st: M.State, +ask: U32, +acts: List<&2, M.Act>, cands: List<&2, P.Cand>, +j: U32) -> List<&2, String>:
  match cands:
    case Nil{}:
      Nil{}
    case Con{+c, rest}:
      T.kv("m" ++ U32.show(j), T.q(act_text(cs, st, ask, act_at(acts, P.Cand.i(c))))) <> criteria(cs, st, ask, acts, rest, (j + 1 : U32))

def question(+ask: U32, +prompt: String) -> String:
  Bool.pick(String, U32.is_eq(ask, 1), "It is my turn to act in the action phase. Which action is best for winning the game?",
    Bool.pick(String, U32.is_eq(ask, 3), "Which card should I put into my resources (the card I need least in hand)?",
      "The game asks: '" ++ prompt ++ "'. Which choice is best for me?"))

def request(+cs: C.Cards, +m: M.Msg, +ask: U32, cands: List<&2, P.Cand>, +outlook: Bool) -> String:
  +st = M.Msg.state(m)
  +move = T.obj([T.kv("type", T.q("choice")), T.kv("instructions", T.q(question(ask, M.Prompt.title(M.Msg.prompt(m))))),
    T.kv("criteria", T.obj(criteria(cs, st, ask, M.Msg.acts(m), cands, 0)))])
  +win = T.obj([T.kv("type", T.q("noul")), T.kv("instructions", T.q("Will I (the player called 'me') win this game?"))])
  T.obj([T.kv("model", T.q("jev-latest")), T.kv("state", state(cs, st)),
    T.kv("questions", T.obj(List.append(&2, String, [T.kv("move", move)], Bool.pick(List<&2, String>, outlook, [T.kv("outlook", win)], Nil{}))))])

# Reading the answer (plain text search: the reply is small)
# ----------------------------------------------------------

def prefix(p: String, s: String) -> Bool:
  match p:
    case SNil{}:
      True{}
    case SCon{Chr{+a}, pt}:
      match s:
        case SNil{}:
          False{}
        case SCon{Chr{+b}, st}:
          U32.is_eq(a, b) && prefix(pt, st)

def drop(s: String, +n: U32) -> String:
  match s:
    case SNil{}:
      SNil{}
    case SCon{+c, +t}:
      Bool.pick(String, U32.is_eq(n, 0), SCon{c, t}, drop(t, (n - 1 : U32)))

# what follows the first key in s, or ""
def after(s: String, +key: String) -> String:
  match s:
    case SNil{}:
      SNil{}
    case SCon{+c, +t}:
      Bool.pick(String, prefix(key, SCon{c, t}), drop(SCon{c, t}, U32.from_nat(String.length(key))), after(t, key))

# leading digits as a number, and how many there were
def digits(s: String, +acc: U32, +n: U32) -> U32 & U32:
  match s:
    case SNil{}:
      (acc, n)
    case SCon{Chr{+c}, t}:
      Bool.pick(U32 & U32, Bool.and(U32.is_ge(c, 48), U32.is_le(c, 57)), digits(t, (acc * 10 + c - 48 : U32), (n + 1 : U32)), (acc, n))

def lead_num(s: String) -> U32:
  Pair.fst(U32, U32, digits(s, 0, 0))

def lead_count(s: String) -> U32:
  Pair.snd(U32, U32, digits(s, 0, 0))

# the chosen index from "choice":"m3", or 99
def choice(+out: String) -> U32:
  +rest = after(out, "\"choice\":\"m")
  Bool.pick(U32, U32.is_gt(lead_count(rest), 0), lead_num(rest), 99)

# "noul":0.64 as a percent, or 999 when missing
def percent(+out: String) -> U32:
  +rest = after(out, "\"noul\":")
  +whole = lead_num(rest)
  +frac = after(rest, ".")
  +two = (lead_num(take(frac, 2)) * Bool.pick(U32, U32.is_eq(lead_count(take(frac, 2)), 1), 10, 1) : U32)
  Bool.pick(U32, U32.is_gt(lead_count(rest), 0), Bool.pick(U32, U32.is_ge(whole, 1), 100, two), 999)

# The call
# --------

type Opinion is Data:
  Opinion{pick: U32, win: U32, ok: Bool, ms: U32}

def failed(code: U32, msg: String) -> Opinion:
  Opinion{99, 999, False{}, 0}

def parse(r: Result<&1, &1, U32 & String, U32 & (String & String)>) -> Opinion:
  match r:
    case Fail{e}:
      Opinion{99, 999, False{}, 0}
    case Done{res}:
      (code, outs) = res
      (+out, err) = outs
      Opinion{choice(out), percent(out), U32.is_eq(code, 0), 0}

def curl_args() -> List<String>:
  ["-sS", "-m", "6", "--variable", "%TYPESAFE_API_KEY", "--expand-header", "Authorization: Bearer {{TYPESAFE_API_KEY}}",
    "-H", "Content-Type: application/json", "--data-binary", "@-", "https://api.typesafe.ai/v1/systemone"]

def ask(body: String) -> IO(Opinion):
  do IO<Opinion>:
    r : Result<&1, &1, U32 & String, U32 & (String & String)> <- Process.run("curl", curl_args(), body, 65536, 8000)
    return parse(r)

def Opinion.pick(x: Opinion) -> U32:
  Opinion{pick, win, ok, ms} = x
  pick

def Opinion.win(x: Opinion) -> U32:
  Opinion{pick, win, ok, ms} = x
  win

def Opinion.ok(x: Opinion) -> Bool:
  Opinion{pick, win, ok, ms} = x
  ok
