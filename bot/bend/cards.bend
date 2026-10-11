# Card knowledge: cards.tsv (numbers) and cards-text.tsv (names and rules
# text), loaded once at start into string-keyed Maps by set code (SOR_095).
import Base
import ./io.bend as I

# One row of cards.tsv: what the bot knows about a card (see tools/gen-cards.js).
# kind: 1 unit, 2 event, 3 upgrade, 4 leader, 5 base, 6 token unit, 7 token upgrade, 0 unknown.
# arena: 0 none, 1 ground, 2 space. vig..vil: aspect icon counts. kw, fx: bit sets (below).
type Info is Data:
  Info{kind: U32, cost: U32, power: U32, hp: U32, arena: U32, vig: U32, cmd: U32, agg: U32, cun: U32, her: U32, vil: U32, kw: U32, raid: U32, restore: U32, up_p: U32, up_h: U32, unique: U32, fx: U32, fx_n: U32}

def Info.kind(x: Info) -> U32:
  Info{kind, cost, power, hp, arena, vig, cmd, agg, cun, her, vil, kw, raid, restore, up_p, up_h, unique, fx, fx_n} = x
  kind

def Info.cost(x: Info) -> U32:
  Info{kind, cost, power, hp, arena, vig, cmd, agg, cun, her, vil, kw, raid, restore, up_p, up_h, unique, fx, fx_n} = x
  cost

def Info.power(x: Info) -> U32:
  Info{kind, cost, power, hp, arena, vig, cmd, agg, cun, her, vil, kw, raid, restore, up_p, up_h, unique, fx, fx_n} = x
  power

def Info.hp(x: Info) -> U32:
  Info{kind, cost, power, hp, arena, vig, cmd, agg, cun, her, vil, kw, raid, restore, up_p, up_h, unique, fx, fx_n} = x
  hp

def Info.arena(x: Info) -> U32:
  Info{kind, cost, power, hp, arena, vig, cmd, agg, cun, her, vil, kw, raid, restore, up_p, up_h, unique, fx, fx_n} = x
  arena

def Info.vig(x: Info) -> U32:
  Info{kind, cost, power, hp, arena, vig, cmd, agg, cun, her, vil, kw, raid, restore, up_p, up_h, unique, fx, fx_n} = x
  vig

def Info.cmd(x: Info) -> U32:
  Info{kind, cost, power, hp, arena, vig, cmd, agg, cun, her, vil, kw, raid, restore, up_p, up_h, unique, fx, fx_n} = x
  cmd

def Info.agg(x: Info) -> U32:
  Info{kind, cost, power, hp, arena, vig, cmd, agg, cun, her, vil, kw, raid, restore, up_p, up_h, unique, fx, fx_n} = x
  agg

def Info.cun(x: Info) -> U32:
  Info{kind, cost, power, hp, arena, vig, cmd, agg, cun, her, vil, kw, raid, restore, up_p, up_h, unique, fx, fx_n} = x
  cun

def Info.her(x: Info) -> U32:
  Info{kind, cost, power, hp, arena, vig, cmd, agg, cun, her, vil, kw, raid, restore, up_p, up_h, unique, fx, fx_n} = x
  her

def Info.vil(x: Info) -> U32:
  Info{kind, cost, power, hp, arena, vig, cmd, agg, cun, her, vil, kw, raid, restore, up_p, up_h, unique, fx, fx_n} = x
  vil

def Info.kw(x: Info) -> U32:
  Info{kind, cost, power, hp, arena, vig, cmd, agg, cun, her, vil, kw, raid, restore, up_p, up_h, unique, fx, fx_n} = x
  kw

def Info.raid(x: Info) -> U32:
  Info{kind, cost, power, hp, arena, vig, cmd, agg, cun, her, vil, kw, raid, restore, up_p, up_h, unique, fx, fx_n} = x
  raid

def Info.restore(x: Info) -> U32:
  Info{kind, cost, power, hp, arena, vig, cmd, agg, cun, her, vil, kw, raid, restore, up_p, up_h, unique, fx, fx_n} = x
  restore

def Info.up_p(x: Info) -> U32:
  Info{kind, cost, power, hp, arena, vig, cmd, agg, cun, her, vil, kw, raid, restore, up_p, up_h, unique, fx, fx_n} = x
  up_p

def Info.up_h(x: Info) -> U32:
  Info{kind, cost, power, hp, arena, vig, cmd, agg, cun, her, vil, kw, raid, restore, up_p, up_h, unique, fx, fx_n} = x
  up_h

def Info.unique(x: Info) -> U32:
  Info{kind, cost, power, hp, arena, vig, cmd, agg, cun, her, vil, kw, raid, restore, up_p, up_h, unique, fx, fx_n} = x
  unique

def Info.fx(x: Info) -> U32:
  Info{kind, cost, power, hp, arena, vig, cmd, agg, cun, her, vil, kw, raid, restore, up_p, up_h, unique, fx, fx_n} = x
  fx

def Info.fx_n(x: Info) -> U32:
  Info{kind, cost, power, hp, arena, vig, cmd, agg, cun, her, vil, kw, raid, restore, up_p, up_h, unique, fx, fx_n} = x
  fx_n

def Info.none() -> Info:
  Info{0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}

# One row of cards-text.tsv.
type Text is Data:
  Text{name: String, title: String, text: String}

def Text.name(x: Text) -> String:
  Text{name, title, text} = x
  name

def Text.title(x: Text) -> String:
  Text{name, title, text} = x
  title

def Text.text(x: Text) -> String:
  Text{name, title, text} = x
  text

def Text.none() -> Text:
  Text{"", "", ""}

# Keyword bits (kw)
# -----------------

def kw_sentinel() -> U32:
  1

def kw_raid() -> U32:
  2

def kw_overwhelm() -> U32:
  4

def kw_ambush() -> U32:
  8

def kw_restore() -> U32:
  16

def kw_saboteur() -> U32:
  32

def kw_hidden() -> U32:
  64

def kw_shielded() -> U32:
  128

def kw_grit() -> U32:
  256

def kw_piloting() -> U32:
  512

def kw_smuggle() -> U32:
  1024

def kw_bounty() -> U32:
  2048

def kw_coordinate() -> U32:
  16384

# Effect bits (fx), from the rules text
# -------------------------------------

def fx_damage() -> U32:
  1

def fx_defeat() -> U32:
  2

def fx_heal() -> U32:
  4

def fx_draw() -> U32:
  8

def fx_exhaust() -> U32:
  16

def fx_ready() -> U32:
  32

def fx_bounce() -> U32:
  64

def fx_capture() -> U32:
  128

def fx_shield() -> U32:
  256

def fx_experience() -> U32:
  512

def fx_token() -> U32:
  1024

def fx_buff() -> U32:
  2048

def fx_debuff() -> U32:
  4096

def fx_search() -> U32:
  8192

def fx_discard() -> U32:
  16384

def fx_basedamage() -> U32:
  32768

def has(+bits: U32, +bit: U32) -> Bool:
  U32.is_ne(U32.and(bits, bit), 0)

# Loading
# -------

type Cards is Data:
  Cards{info: Map<&2, Info>, text: Map<&2, Text>, names: Map<&2, String>}

def num_at(fs: List<&2, List<&2, U32>>, n: Nat) -> U32:
  I.nat(Maybe.default(&2, List<&2, U32>, List.get(&2, List<&2, U32>, fs, n), Nil{}))

def text_at(fs: List<&2, List<&2, U32>>, n: Nat) -> String:
  I.text(Maybe.default(&2, List<&2, U32>, List.get(&2, List<&2, U32>, fs, n), Nil{}))

def info_row(+fs: List<&2, List<&2, U32>>) -> Info:
  Info{num_at(fs, 1n), num_at(fs, 2n), num_at(fs, 3n), num_at(fs, 4n), num_at(fs, 5n),
    num_at(fs, 6n), num_at(fs, 7n), num_at(fs, 8n), num_at(fs, 9n), num_at(fs, 10n), num_at(fs, 11n),
    num_at(fs, 12n), num_at(fs, 13n), num_at(fs, 14n), num_at(fs, 15n), num_at(fs, 16n),
    num_at(fs, 17n), num_at(fs, 18n), num_at(fs, 19n)}

def load_info(rows: List<&2, List<&2, List<&2, U32>>>, m: Map<&2, Info>) -> Map<&2, Info>:
  match rows:
    case Nil{}:
      m
    case Con{+fs, rest}:
      load_info(rest, Map.set(&2, Info, m, text_at(fs, 0n), info_row(fs)))

def load_text(rows: List<&2, List<&2, List<&2, U32>>>, m: Map<&2, Text>, names: Map<&2, String>) ->
  Map<&2, Text> & Map<&2, String>:
  match rows:
    case Nil{}:
      (m, names)
    case Con{+fs, rest}:
      +code = text_at(fs, 0n)
      +name = text_at(fs, 1n)
      load_text(rest, Map.set(&2, Text, m, code, Text{name, text_at(fs, 2n), text_at(fs, 3n)}),
        Map.set(&2, String, names, name, code))

def bytes_or_empty(m: Maybe<&2, List<&2, U32>>) -> List<&2, U32>:
  Maybe.default(&2, List<&2, U32>, m, Nil{})

def build_with(info: Map<&2, Info>, tn: Map<&2, Text> & Map<&2, String>) -> Cards:
  (tm, nm) = tn
  Cards{info, tm, nm}

def build(nums: Maybe<&2, List<&2, U32>>, texts: Maybe<&2, List<&2, U32>>) -> Cards:
  build_with(load_info(I.tsv(bytes_or_empty(nums)), Map.new(&2, Info)),
    load_text(I.tsv(bytes_or_empty(texts)), Map.new(&2, Text), Map.new(&2, String)))

# both tables from a folder path ending in '/'
def load(+dir: String) -> IO(Cards):
  do IO<Cards>:
    nums : Maybe<&2, List<&2, U32>> <- I.slurp(dir ++ "cards.tsv")
    texts : Maybe<&2, List<&2, U32>> <- I.slurp(dir ++ "cards-text.tsv")
    return build(nums, texts)

# Lookups: the tables are shared (+), so a lookup keeps only the answer
# ---------------------------------------------------------------------

def info_of(cs: Cards, code: String) -> Info:
  Cards{im, tm, nm} = cs
  Pair.snd(Map<&2, Info>, Info, Map.get(Info, Info.none(), im, code))

def text_of(cs: Cards, code: String) -> Text:
  Cards{im, tm, nm} = cs
  Pair.snd(Map<&2, Text>, Text, Map.get(Text, Text.none(), tm, code))

# a set code from an internal name (display prompts only give that), or ""
def code_of(cs: Cards, name: String) -> String:
  Cards{im, tm, nm} = cs
  Pair.snd(Map<&2, String>, String, Map.get(String, "", nm, name))

def size(cs: Cards) -> Nat:
  Cards{im, tm, nm} = cs
  Map.size(&2, Info, im)
