# JSON for the stdio protocol: a byte list in, a Json value out.
#
# Two passes, both plain structural recursion (no `?` defs): `lex` turns the
# bytes into tokens with a small state machine, `build` folds the tokens into
# values with a stack of open arrays and objects. Strings stay byte lists
# (UTF-8 as sent); numbers are integers (U32 plus a sign); a fraction or
# exponent is read and dropped, since the protocol sends none.
import Base

type Json is Data:
  JNull{}
  JBool{b: Bool}
  JNum{n: U32, neg: Bool}
  JStr{s: List<&2, U32>}
  JArr{xs: List<&2, Json>}
  JObj{fs: List<&2, JField>}

type JField is Data:
  JField{k: List<&2, U32>, v: Json}

type Tok is Data:
  TBeg{arr: Bool}
  TEnd{}
  TStr{s: List<&2, U32>}
  TNum{n: U32, neg: Bool}
  TLit{v: U32}

type Lex is Data:
  LNorm{}
  LStr{acc: List<&2, U32>, esc: Bool}
  LNum{n: U32, neg: Bool}
  LSkip{n: U32, neg: Bool}
  LWord{}

type LexOut is Data:
  LexOut{st: Lex, out: List<&2, Tok>}

def is_digit(+b: U32) -> Bool:
  Bool.and(U32.is_ge(b, 48), U32.is_le(b, 57))

def is_letter(+b: U32) -> Bool:
  Bool.and(U32.is_ge(b, 97), U32.is_le(b, 122))

# a number's tail: '.', 'e', 'E', '+', '-' and digits
def is_num_tail(+b: U32) -> Bool:
  is_digit(b) || U32.is_eq(b, 46) || U32.is_eq(b, 101) || U32.is_eq(b, 69) ||
    U32.is_eq(b, 43) || U32.is_eq(b, 45)

def unescape(b: U32) -> U32:
  match b:
    case 110:
      10
    case 116:
      9
    case 114:
      13
    case 98:
      8
    case 102:
      12
    case _:
      b

def norm_num(isd: Bool, b: U32, out: List<&2, Tok>) -> LexOut:
  match isd:
    case True{}:
      LexOut{LNum{(b - 48 : U32), False{}}, out}
    case False{}:
      LexOut{LNorm{}, out}

# one byte in the normal state
def norm(+b: U32, out: List<&2, Tok>) -> LexOut:
  match b:
    case 123:
      LexOut{LNorm{}, TBeg{False{}} <> out}
    case 91:
      LexOut{LNorm{}, TBeg{True{}} <> out}
    case 125:
      LexOut{LNorm{}, TEnd{} <> out}
    case 93:
      LexOut{LNorm{}, TEnd{} <> out}
    case 34:
      LexOut{LStr{Nil{}, False{}}, out}
    case 45:
      LexOut{LNum{0, True{}}, out}
    case 116:
      LexOut{LWord{}, TLit{1} <> out}
    case 102:
      LexOut{LWord{}, TLit{2} <> out}
    case 110:
      LexOut{LWord{}, TLit{0} <> out}
    case _:
      norm_num(is_digit(b), b, out)

def str_step(esc: Bool, +b: U32, acc: List<&2, U32>, out: List<&2, Tok>) -> LexOut:
  match esc:
    case True{}:
      LexOut{LStr{unescape(b) <> acc, False{}}, out}
    case False{}:
      match b:
        case 34:
          LexOut{LNorm{}, TStr{List.reverse(&2, U32, acc)} <> out}
        case 92:
          LexOut{LStr{acc, True{}}, out}
        case _:
          LexOut{LStr{b <> acc, False{}}, out}

def skip_step(tail: Bool, +b: U32, n: U32, neg: Bool, out: List<&2, Tok>) -> LexOut:
  match tail:
    case True{}:
      LexOut{LSkip{n, neg}, out}
    case False{}:
      norm(b, TNum{n, neg} <> out)

def num_step(isd: Bool, +b: U32, +n: U32, neg: Bool, out: List<&2, Tok>) -> LexOut:
  match isd:
    case True{}:
      LexOut{LNum{(n * 10 + b - 48 : U32), neg}, out}
    case False{}:
      skip_step(is_num_tail(b), b, n, neg, out)

def word_step(isl: Bool, +b: U32, out: List<&2, Tok>) -> LexOut:
  match isl:
    case True{}:
      LexOut{LWord{}, out}
    case False{}:
      norm(b, out)

def step(st: Lex, +b: U32, out: List<&2, Tok>) -> LexOut:
  match st:
    case LNorm{}:
      norm(b, out)
    case LStr{acc, esc}:
      str_step(esc, b, acc, out)
    case LNum{n, neg}:
      num_step(is_digit(b), b, n, neg, out)
    case LSkip{n, neg}:
      skip_step(is_num_tail(b), b, n, neg, out)
    case LWord{}:
      word_step(is_letter(b), b, out)

def lex_end(st: Lex, out: List<&2, Tok>) -> List<&2, Tok>:
  match st:
    case LNum{n, neg}:
      List.reverse(&2, Tok, TNum{n, neg} <> out)
    case LSkip{n, neg}:
      List.reverse(&2, Tok, TNum{n, neg} <> out)
    case _:
      List.reverse(&2, Tok, out)

def lex_go(bs: List<&2, U32>, lo: LexOut) -> List<&2, Tok>:
  match bs:
    case Nil{}:
      LexOut{st, out} = lo
      lex_end(st, out)
    case Con{b, t}:
      LexOut{st, out} = lo
      lex_go(t, step(st, b, out))

def lex(bs: List<&2, U32>) -> List<&2, Tok>:
  lex_go(bs, LexOut{LNorm{}, Nil{}})

# Building
# --------

type Frame is Data:
  FArr{items: List<&2, Json>}
  FObj{fs: List<&2, JField>, key: Maybe<&2, List<&2, U32>>}

type Build is Data:
  Build{stack: List<&2, Frame>, res: Json}

# a finished value goes into the open container, or becomes the result
def put(v: Json, stack: List<&2, Frame>, res: Json) -> Build:
  match stack:
    case Nil{}:
      Build{Nil{}, v}
    case Con{f, rest}:
      match f:
        case FArr{items}:
          Build{FArr{v <> items} <> rest, res}
        case FObj{fs, key}:
          match key:
            case None{}:
              Build{FObj{fs, None{}} <> rest, res}
            case Some{k}:
              Build{FObj{JField{k, v} <> fs, None{}} <> rest, res}

# a string is a key when the open object waits for one
def put_str(s: List<&2, U32>, stack: List<&2, Frame>, res: Json) -> Build:
  match stack:
    case Nil{}:
      Build{Nil{}, JStr{s}}
    case Con{f, rest}:
      match f:
        case FArr{items}:
          Build{FArr{JStr{s} <> items} <> rest, res}
        case FObj{fs, key}:
          match key:
            case None{}:
              Build{FObj{fs, Some{s}} <> rest, res}
            case Some{k}:
              Build{FObj{JField{k, JStr{s}} <> fs, None{}} <> rest, res}

def close(stack: List<&2, Frame>, res: Json) -> Build:
  match stack:
    case Nil{}:
      Build{Nil{}, res}
    case Con{f, rest}:
      match f:
        case FArr{items}:
          put(JArr{List.reverse(&2, Json, items)}, rest, res)
        case FObj{fs, key}:
          put(JObj{List.reverse(&2, JField, fs)}, rest, res)

def lit(v: U32) -> Json:
  match v:
    case 1:
      JBool{True{}}
    case 2:
      JBool{False{}}
    case _:
      JNull{}

def tok(t: Tok, stack: List<&2, Frame>, res: Json) -> Build:
  match t:
    case TBeg{arr}:
      match arr:
        case True{}:
          Build{FArr{Nil{}} <> stack, res}
        case False{}:
          Build{FObj{Nil{}, None{}} <> stack, res}
    case TEnd{}:
      close(stack, res)
    case TStr{s}:
      put_str(s, stack, res)
    case TNum{n, neg}:
      put(JNum{n, neg}, stack, res)
    case TLit{v}:
      put(lit(v), stack, res)

def build(ts: List<&2, Tok>, b: Build) -> Json:
  match ts:
    case Nil{}:
      Build{stack, res} = b
      res
    case Con{t, rest}:
      Build{stack, res} = b
      build(rest, tok(t, stack, res))

def parse(bs: List<&2, U32>) -> Json:
  build(lex(bs), Build{Nil{}, JNull{}})

# Access
# ------

# whether a byte list spells an ASCII string
def bytes_eq(k: List<&2, U32>, s: String) -> Bool:
  match k:
    case Nil{}:
      String.is_empty(s)
    case Con{b, kt}:
      match s:
        case SNil{}:
          False{}
        case SCon{Chr{c}, st}:
          U32.is_eq(b, c) && bytes_eq(kt, st)

def field(fs: List<&2, JField>, +key: String) -> Json:
  match fs:
    case Nil{}:
      JNull{}
    case Con{f, rest}:
      JField{k, v} = f
      Bool.pick(Json, bytes_eq(k, key), v, field(rest, key))

# o[key], or null
def get(o: Json, key: String) -> Json:
  match o:
    case JObj{fs}:
      field(fs, key)
    case _:
      JNull{}

def num(j: Json) -> U32:
  match j:
    case JNum{n, neg}:
      n
    case JBool{b}:
      Bool.to_u32(b)
    case _:
      0

def flag(j: Json) -> Bool:
  match j:
    case JBool{b}:
      b
    case JNum{n, neg}:
      U32.is_ne(n, 0)
    case _:
      False{}

def is_null(j: Json) -> Bool:
  match j:
    case JNull{}:
      True{}
    case _:
      False{}

def str(j: Json) -> List<&2, U32>:
  match j:
    case JStr{s}:
      s
    case _:
      Nil{}

def arr(j: Json) -> List<&2, Json>:
  match j:
    case JArr{xs}:
      xs
    case _:
      Nil{}

# Bytes and text
# --------------

def to_bytes(s: String) -> List<&2, U32>:
  match s:
    case SNil{}:
      Nil{}
    case SCon{Chr{c}, t}:
      c <> to_bytes(t)

def to_string(bs: List<&2, U32>) -> String:
  match bs:
    case Nil{}:
      SNil{}
    case Con{b, t}:
      SCon{Chr{b}, to_string(t)}
