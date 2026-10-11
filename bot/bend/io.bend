# Lines in, lines out.
#
# stdin is read in chunks of bytes (File.read_bytes on /dev/stdin, which a
# pipe answers with what it has); `scan` moves bytes into the current line
# until a newline. Bytes stay bytes: the protocol is ASCII except inside
# card names, which the bot never echoes back.
import Base

type Scan is Data:
  Line{line: List<&2, U32>, rest: List<&2, U32>}
  More{acc: List<&2, U32>}

# moves bytes from buf onto acc (reversed) until a newline
def scan(buf: List<&2, U32>, acc: List<&2, U32>) -> Scan:
  match buf:
    case Nil{}:
      More{acc}
    case Con{b, t}:
      match b:
        case 10:
          Line{List.reverse(&2, U32, acc), t}
        case _:
          scan(t, b <> acc)

# Reading a whole file
# --------------------

def slurp_got?(m: File & Result<&1, &1, U32 & String, List<&2, U32>>, acc: List<&2, List<&2, U32>>) ->
  IO(List<&2, U32>):
  (f, r) = m
  match r:
    case Fail{e}:
      do IO<List<&2, U32>>:
        File.close(f)
        return List.concat(&2, U32, List.reverse(&2, List<&2, U32>, acc))
    case Done{chunk}:
      match chunk:
        case Nil{}:
          do IO<List<&2, U32>>:
            File.close(f)
            return List.concat(&2, U32, List.reverse(&2, List<&2, U32>, acc))
        case Con{h, t}:
          slurp_go(f, (h <> t) <> acc)

def slurp_go?(f: File, acc: List<&2, List<&2, U32>>) -> IO(List<&2, U32>):
  do IO<List<&2, U32>>:
    m : File & Result<&1, &1, U32 & String, List<&2, U32>> <- File.read_bytes(f, 1048576)
    slurp_got(m, acc)

# a file's bytes, or none if it cannot be opened
def slurp_open(r: Result<&1, &1, U32 & String, File>) -> IO(Maybe<&2, List<&2, U32>>):
  match r:
    case Fail{e}:
      IO.pure(Maybe<&2, List<&2, U32>>, None{})
    case Done{f}:
      do IO<Maybe<&2, List<&2, U32>>>:
        bs : List<&2, U32> <- slurp_go(f, Nil{})
        return Some{bs}

def slurp(path: String) -> IO(Maybe<&2, List<&2, U32>>):
  do IO<Maybe<&2, List<&2, U32>>>:
    r : Result<&1, &1, U32 & String, File> <- File.open(path, "r")
    slurp_open(r)

# Splitting text tables
# ---------------------

type Rows is Data:
  Rows{field: List<&2, U32>, row: List<&2, List<&2, U32>>, rows: List<&2, List<&2, List<&2, U32>>>}

def rows_byte(+b: U32, rs: Rows) -> Rows:
  match b:
    case 9:
      Rows{field, row, rows} = rs
      Rows{Nil{}, List.reverse(&2, U32, field) <> row, rows}
    case 10:
      Rows{field, row, rows} = rs
      Rows{Nil{}, Nil{}, List.reverse(&2, List<&2, U32>, List.reverse(&2, U32, field) <> row) <> rows}
    case 13:
      rs
    case _:
      Rows{field, row, rows} = rs
      Rows{b <> field, row, rows}

def rows_go(bs: List<&2, U32>, rs: Rows) -> List<&2, List<&2, List<&2, U32>>>:
  match bs:
    case Nil{}:
      Rows{field, row, rows} = rs
      List.reverse(&2, List<&2, List<&2, U32>>, rows)
    case Con{b, t}:
      rows_go(t, rows_byte(b, rs))

# tab-separated lines: rows of fields of bytes (a last line needs its newline)
def tsv(bs: List<&2, U32>) -> List<&2, List<&2, List<&2, U32>>>:
  rows_go(bs, Rows{Nil{}, Nil{}, Nil{}})

# a decimal number at the front of the bytes (0 when there is none)
def nat_go(bs: List<&2, U32>, +acc: U32, stop: Bool) -> U32:
  match bs:
    case Nil{}:
      acc
    case Con{+b, t}:
      +halt = stop || Bool.not(Bool.and(U32.is_ge(b, 48), U32.is_le(b, 57)))
      nat_go(t, Bool.pick(U32, halt, acc, (acc * 10 + b - 48 : U32)), halt)

def nat(bs: List<&2, U32>) -> U32:
  nat_go(bs, 0, False{})

# ASCII text from bytes; any other byte becomes '?'
def text(bs: List<&2, U32>) -> String:
  match bs:
    case Nil{}:
      SNil{}
    case Con{+b, t}:
      SCon{Chr{Bool.pick(U32, U32.is_lt(b, 128), b, 63)}, text(t)}
