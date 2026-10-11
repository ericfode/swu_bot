# Small text helpers: case-insensitive search, the numbers in a title, and
# JSON string escaping for the requests the bot builds.
import Base

def lower(+c: U32) -> U32:
  Bool.pick(U32, Bool.and(U32.is_ge(c, 65), U32.is_le(c, 90)), (c + 32 : U32), c)

# whether p (lower case) starts s, ignoring case in s
def starts_ci(p: String, s: String) -> Bool:
  match p:
    case SNil{}:
      True{}
    case SCon{Chr{+a}, pt}:
      match s:
        case SNil{}:
          False{}
        case SCon{Chr{+b}, st}:
          U32.is_eq(a, lower(b)) && starts_ci(pt, st)

# whether s contains p (p in lower case), ignoring case in s
def has(s: String, +p: String) -> Bool:
  match s:
    case SNil{}:
      String.is_empty(p)
    case SCon{+c, +t}:
      starts_ci(p, SCon{c, t}) || has(t, p)

def has_any(+s: String, ps: List<&2, String>) -> Bool:
  match ps:
    case Nil{}:
      False{}
    case Con{p, rest}:
      has(s, p) || has_any(s, rest)

# The numbers in a text, in order
# -------------------------------

type Nums is Data:
  Nums{cur: U32, inn: Bool, out: List<&2, U32>}

def nums_step(d: Bool, +c: U32, st: Nums) -> Nums:
  match d:
    case True{}:
      Nums{cur, inn, out} = st
      Nums{(cur * 10 + c - 48 : U32), True{}, out}
    case False{}:
      Nums{cur, +inn, +out} = st
      Nums{0, False{}, Bool.pick(List<&2, U32>, inn, cur <> out, out)}

def nums_go(s: String, st: Nums) -> List<&2, U32>:
  match s:
    case SNil{}:
      Nums{cur, +inn, +out} = st
      List.reverse(&2, U32, Bool.pick(List<&2, U32>, inn, cur <> out, out))
    case SCon{Chr{+c}, t}:
      nums_go(t, nums_step(Bool.and(U32.is_ge(c, 48), U32.is_le(c, 57)), c, st))

def nums(s: String) -> List<&2, U32>:
  nums_go(s, Nums{0, False{}, Nil{}})

def nth(xs: List<&2, U32>, n: Nat, d: U32) -> U32:
  Maybe.default(&2, U32, List.get(&2, U32, xs, n), d)

# the largest number in a text, or d
def max_num(s: String, d: U32) -> U32:
  List.foldl(~&2, ~U32, ~U32, ~(a => b => U32.max(a, b)), nums(s), d)

# JSON
# ----

def esc_char(+c: U32) -> String:
  Bool.pick(String, U32.is_eq(c, 34), "\\\"",
    Bool.pick(String, U32.is_eq(c, 92), "\\\\",
      Bool.pick(String, U32.is_lt(c, 32), " ",
        Bool.pick(String, U32.is_gt(c, 126), "?", SCon{Chr{c}, SNil{}}))))

def esc(s: String) -> String:
  match s:
    case SNil{}:
      SNil{}
    case SCon{Chr{c}, t}:
      esc_char(c) ++ esc(t)

# a JSON string literal
def q(s: String) -> String:
  "\"" ++ esc(s) ++ "\""

def kv(k: String, v: String) -> String:
  q(k) ++ ":" ++ v

def join(xs: List<&2, String>) -> String:
  String.join(xs, ",")

def obj(xs: List<&2, String>) -> String:
  "{" ++ join(xs) ++ "}"

def arr(xs: List<&2, String>) -> String:
  "[" ++ join(xs) ++ "]"

def n(x: U32) -> String:
  U32.show(x)

def b(x: Bool) -> String:
  Bool.pick(String, x, "true", "false")
