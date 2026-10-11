# swu-bend: a Star Wars Unlimited bot in Bend 2, playing the forceteki engine
# over the stdio protocol (spec/stdio-protocol.md): one JSON line in, one out.
#
#   bun <bend>/bend2/main.ts bot/bend/main.bend -o bot/bend/swu-bend   (see build.sh)
#   bot/bend/swu-bend [--jev] [--name NAME] [--cards DIR/]
#
# The card tables (cards.tsv, cards-text.tsv) are read from --cards, else from
# the folder of the program. --jev asks TypeSafe's Jev model to pick among the
# best few moves (needs curl and TYPESAFE_API_KEY); without it the bot plays
# its own scores. stdout is protocol only; the bot's thoughts go to stderr.
import Base
import ./json.bend as J
import ./io.bend as I
import ./cards.bend as C
import ./model.bend as M
import ./eval.bend as E
import ./txt.bend as T
import ./policy.bend as P
import ./jev.bend as V

# jev: ask Jev at all; ties: only among moves within 15 (1.5 base damage) of the best
type Cfg is Data:
  Cfg{cs: C.Cards, jev: Bool, ties: Bool, name: String}

def Cfg.cs(x: Cfg) -> C.Cards:
  Cfg{cs, jev, ties, name} = x
  cs

def Cfg.jev(x: Cfg) -> Bool:
  Cfg{cs, jev, ties, name} = x
  jev

def Cfg.ties(x: Cfg) -> Bool:
  Cfg{cs, jev, ties, name} = x
  ties

def Cfg.name(x: Cfg) -> String:
  Cfg{cs, jev, ties, name} = x
  name

# Command line
# ------------

type Opts is Data:
  Opts{jev: Bool, ties: Bool, name: String, dir: String}

# the folder part of a path, with its '/', or "./"
def dir_go(s: String, +cur: String, +last: String) -> String:
  match s:
    case SNil{}:
      last
    case SCon{Chr{+c}, t}:
      +cur2 = cur ++ SCon{Chr{c}, SNil{}}
      dir_go(t, cur2, Bool.pick(String, U32.is_eq(c, 47), cur2, last))

def dir_of(s: String) -> String:
  dir_go(s, "", "./")

def opts_go?(xs: List<String>, +o: Opts) -> Opts:
  match xs:
    case Nil{}:
      o
    case Con{+x, +rest}:
      Opts{+jev, +ties, +name, +dir} = o
      +next = Maybe.default(&1, String, List.head(&1, String, rest), "")
      Bool.pick(Opts, String.eq(x, "--jev"), opts_go(rest, Opts{True{}, ties, Bool.pick(String, String.eq(name, "swu-bend"), "swu-bend-jev", name), dir}),
        Bool.pick(Opts, String.eq(x, "--jev-ties"), opts_go(rest, Opts{True{}, True{}, Bool.pick(String, String.eq(name, "swu-bend"), "swu-bend-jev-ties", name), dir}),
          Bool.pick(Opts, String.eq(x, "--name"), opts_go(List.drop(&1, String, rest, 1n), Opts{jev, ties, next, dir}),
            Bool.pick(Opts, String.eq(x, "--cards"), opts_go(List.drop(&1, String, rest, 1n), Opts{jev, ties, name, next}),
              opts_go(rest, o)))))

def opts(xs: List<String>) -> Opts:
  match xs:
    case Nil{}:
      Opts{False{}, False{}, "swu-bend", "./"}
    case Con{prog, rest}:
      opts_go(rest, Opts{False{}, False{}, "swu-bend", dir_of(prog)})

# Replies
# -------

def reply(+c: P.Cand) -> String:
  +d = P.Cand.dist(c)
  T.obj(List.append(&2, String, [T.kv("t", T.q("act")), T.kv("i", T.n(P.Cand.i(c)))],
    Bool.pick(List<&2, String>, String.is_empty(d), Nil{}, [T.kv("distribution", d)])))

def ready(+name: String) -> String:
  T.obj([T.kv("t", T.q("ready")), T.kv("v", "1"), T.kv("name", T.q(name))])

def thought(+m: M.Msg, +out: P.Out, +c: P.Cand, +note: String) -> String:
  +st = M.Msg.state(m)
  "[bend] r" ++ U32.show(M.State.round(st)) ++ " #" ++ U32.show(M.Msg.seq(m)) ++ " " ++ P.Out.cls(out) ++ ": " ++
    P.Cand.why(c) ++ " (" ++ P.show_score(P.Cand.score(c)) ++ ", " ++
    U32.show(U32.from_nat(List.length(&2, P.Cand, P.Out.cands(out)))) ++ " options)" ++ note

# Jev
# ---

def jev_note(+o: V.Opinion, +n: U32) -> String:
  " | jev " ++ Bool.pick(String, V.Opinion.ok(o), "m" ++ U32.show(V.Opinion.pick(o)) ++ "/" ++ U32.show(n), "failed: " ++ V.Opinion.err(o)) ++
    Bool.pick(String, U32.is_le(V.Opinion.win(o), 100), " win " ++ U32.show(V.Opinion.win(o)) ++ "%", "")

def with_jev(+tops: List<&2, P.Cand>, +best: P.Cand, +o: V.Opinion) -> P.Cand:
  P.nth_cand(tops, Bool.pick(U32, V.Opinion.ok(o), V.Opinion.pick(o), 99), best)

def ask_jev(go: Bool, +cfg: Cfg, +m: M.Msg, +out: P.Out, +tops: List<&2, P.Cand>, +best: P.Cand) -> IO(P.Cand & String):
  match go:
    case False{}:
      IO.pure(P.Cand & String, (best, ""))
    case True{}:
      +n = U32.from_nat(List.length(&2, P.Cand, tops))
      do IO<P.Cand & String>:
        +o : V.Opinion <- V.ask(V.request(Cfg.cs(cfg), m, P.Out.ask(out), tops, True{}))
        return (with_jev(tops, best, o), jev_note(o, n))

# Messages
# --------

def emit(pick: P.Cand & String, +m: M.Msg, +out: P.Out) -> IO(P.Mem):
  (+c, note) = pick
  do IO<P.Mem>:
    IO.print(reply(c))
    IO.print_err(thought(m, out, c, note))
    return P.commit(P.Out.mem(out), c, M.Prompt.aw(M.Msg.prompt(m)))

def on_decide(+cfg: Cfg, mem: P.Mem, +m: M.Msg) -> IO(P.Mem):
  +out = P.decide(Cfg.cs(cfg), mem, m)
  +ranked = P.rank(P.Out.cands(out), Nil{})
  +best = P.nth_cand(ranked, 0, P.Cand{0, 0, "none", "", "", ""})
  +tops = Bool.pick(List<&2, P.Cand>, Cfg.ties(cfg), P.close(ranked, E.sub0(P.Cand.score(best), 15), 4), P.contenders(ranked, 4))
  +go = Bool.and(Bool.and(Cfg.jev(cfg), U32.is_gt(P.Out.ask(out), 0)), U32.is_ge(U32.from_nat(List.length(&2, P.Cand, tops)), 2))
  do IO<P.Mem>:
    pick : P.Cand & String <- ask_jev(go, cfg, m, out, tops, best)
    emit(pick, m, out)

def on_kind(k: U32, +cfg: Cfg, mem: P.Mem, +j: J.Json) -> IO(P.Mem):
  match k:
    case 1:
      do IO<P.Mem>:
        IO.print(ready(Cfg.name(cfg)))
        IO.print_err("[bend] new game as " ++ I.text(J.str(J.get(j, "you"))) ++ Bool.pick(String, Cfg.jev(cfg), " (with Jev)", ""))
        return P.Mem.fresh()
    case 2:
      on_decide(cfg, mem, M.msg(Cfg.cs(cfg), j))
    case _:
      do IO<P.Mem>:
        IO.print(T.obj([T.kv("t", T.q("error")), T.kv("error", T.q("unknown message"))]))
        return mem

def kind(+t: String) -> U32:
  Bool.pick(U32, String.eq(t, "hello"), 1, Bool.pick(U32, String.eq(t, "decide"), 2, 0))

def on_json(+cfg: Cfg, mem: P.Mem, +j: J.Json) -> IO(P.Mem):
  on_kind(kind(I.text(J.str(J.get(j, "t")))), cfg, mem, j)

# The loop: read stdin in chunks, answer each complete line
# ----------------------------------------------------------

def on_scan?(s: I.Scan, f: File, +cfg: Cfg, mem: P.Mem) -> IO(Unit):
  match s:
    case I.Line{line, rest}:
      match line:
        case Nil{}:
          on_scan(I.scan(rest, Nil{}), f, cfg, mem)
        case Con{h, t}:
          do IO<Unit>:
            mem2 : P.Mem <- on_json(cfg, mem, J.parse(h <> t))
            on_scan(I.scan(rest, Nil{}), f, cfg, mem2)
    case I.More{acc}:
      read(f, acc, cfg, mem)

def on_chunk?(got: File & Result<&1, &1, U32 & String, List<&2, U32>>, acc: List<&2, U32>, +cfg: Cfg, mem: P.Mem) -> IO(Unit):
  (f, r) = got
  match r:
    case Fail{e}:
      File.close(f)
    case Done{chunk}:
      match chunk:
        case Nil{}:
          File.close(f)
        case Con{h, t}:
          on_scan(I.scan(h <> t, acc), f, cfg, mem)

def read?(f: File, acc: List<&2, U32>, +cfg: Cfg, mem: P.Mem) -> IO(Unit):
  do IO<Unit>:
    got : File & Result<&1, &1, U32 & String, List<&2, U32>> <- File.read_bytes(f, 65536)
    on_chunk(got, acc, cfg, mem)

def start(o: Opts) -> IO(Unit):
  Opts{+jev, ties, name, +dir} = o
  do IO<Unit>:
    +cs : C.Cards <- C.load(dir)
    IO.print_err("[bend] " ++ Nat.show(C.size(cs)) ++ " cards from " ++ dir ++ Bool.pick(String, jev, ", Jev on", ""))
    f : File <- IO.try(File, File.open("/dev/stdin", "r"))
    read(f, Nil{}, Cfg{cs, jev, ties, name}, P.Mem.fresh())

def main() -> IO(Unit):
  do IO<Unit>:
    xs : List<String> <- IO.args()
    start(opts(xs))
