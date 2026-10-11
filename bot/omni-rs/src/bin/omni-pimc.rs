//! PIMC (omniscient sampling) bias on real endgames.
//!
//! For each action window near the end of a recorded trace, the side to move sees its own hand,
//! the board, every discard and every count. It does not see the opponent's hand or face-down
//! resources, or the order of either deck. A "deal" re-draws exactly that hidden part, keeping
//! every visible fact. Deal 0 is the real one.
//!
//! For every deal w and every legal move a, the prover solves the position after a and gives
//! f(w, a) = 1 (mover forces a win), 0 (opponent forces a win), 1/2 (the move ends the game in a
//! draw) or null (not proven in budget).
//! A decision is complete when every f is known. Its PIMC gap is
//!     E_w[max_a f(w, a)] - max_a E_w[f(w, a)]
//! which `pimc_choice_loss` in theory/SwuTheory/Hidden.lean equates with the expected loss of the
//! PIMC move against the omniscient value (under a uniform belief over the deals).
//!
//! The belief is uniform over the hidden part given the decklists (both decklists are known, as
//! in a tournament). It ignores what the opponent's earlier choices reveal about their hand.

use omni_rs::{
    check::open_jsonl,
    model::{CardId, Zone},
    search::{Limits, Search},
    Engine, Seat, State,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    env,
    io::{BufRead, Write},
    path::{Path, PathBuf},
};

const HELP: &str = "omni-pimc <trace.jsonl[.gz]>... [--deals 8] [--last 10] [--depth 12] [--nodes 50000] [--seed 1] [--pool FILE]

One JSON line per action window among the last --last windows of each trace. --deals counts the
real deal. Proof limits apply to each (deal, move) solve separately. A window where no move is proven
on the real deal stops there (complete=false, one row of values).
";

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        // SplitMix64
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
        z ^ (z >> 31)
    }
    fn shuffle(&mut self, v: &mut [CardId]) {
        for i in (1..v.len()).rev() {
            let j = (self.next() % (i as u64 + 1)) as usize;
            v.swap(i, j);
        }
    }
}

fn zone(ids: &[CardId]) -> Result<Zone, String> {
    let mut z = Zone::default();
    for &id in ids {
        z.push(id)?;
    }
    Ok(z)
}

/// Re-deal what `seer` cannot see: the opponent's hand, face-down resources and deck from one
/// shuffle (zone sizes kept, exhausted resources stay at the same resource positions), and the
/// order of the seer's own deck. Same model as `determinize` in bot/protocol.js.
fn redeal(s: &State, seer: Seat, rng: &mut Rng) -> Result<State, String> {
    let mut out = *s;
    let opp = s.player(seer.other());
    let (hand_len, res_len) = (opp.hand.len as usize, opp.resources.len as usize);
    let exhausted: Vec<bool> = opp
        .resources
        .as_slice()
        .iter()
        .map(|&id| s.card(id).exhausted)
        .collect();
    let mut pool: Vec<CardId> = [
        opp.resources.as_slice(),
        opp.hand.as_slice(),
        opp.deck.as_slice(),
    ]
    .concat();
    rng.shuffle(&mut pool);
    for (k, &id) in pool.iter().enumerate() {
        out.card_mut(id).exhausted = k < res_len && exhausted[k];
    }
    let p = out.player_mut(seer.other());
    p.resources = zone(&pool[..res_len])?;
    p.hand = zone(&pool[res_len..res_len + hand_len])?;
    p.deck = zone(&pool[res_len + hand_len..])?;
    let mut own: Vec<CardId> = s.player(seer).deck.as_slice().to_vec();
    rng.shuffle(&mut own);
    out.player_mut(seer).deck = zone(&own)?;
    Ok(out)
}

struct Opts {
    deals: usize,
    last: usize,
    limits: Limits,
    seed: u64,
}

/// meta record, (step, state) per action window, winner.
type Trace = (Value, Vec<(u64, Value)>, Option<String>);

fn traces(path: &Path) -> Result<Trace, String> {
    let mut meta = Value::Null;
    let mut states = Vec::new();
    let mut winner = None;
    for (line, text) in open_jsonl(path)?.lines().enumerate() {
        let text = text.map_err(|e| e.to_string())?;
        if text.trim().is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(&text)
            .map_err(|e| format!("{}:{}: {e}", path.display(), line + 1))?;
        match v["type"].as_str() {
            Some("meta") => meta = v,
            Some("state") => states.push((v["step"].as_u64().unwrap_or(0), v["state"].clone())),
            Some("result") => winner = v["winner"].as_str().map(String::from),
            _ => (),
        }
    }
    Ok((meta, states, winner))
}

fn value_for(result: Option<Seat>, mover: Seat) -> Value {
    match result {
        Some(s) if s == mover => json!(1),
        Some(_) => json!(0),
        None => Value::Null,
    }
}

fn run_trace(engine: &Engine, path: &Path, o: &Opts, out: &mut impl Write) -> Result<(), String> {
    let (meta, states, winner) = traces(path)?;
    // As in check::check: a trace without the hash of the loaded pool may use other card rules.
    if meta["pool"]["sha256"].as_str() != Some(engine.pool_hash()) {
        return Err(format!(
            "{}: trace pool hash missing or different from the loaded pool",
            path.display()
        ));
    }
    let n = states.len();
    let mut search = Search::new(engine);
    let game = path
        .file_name()
        .unwrap()
        .to_string_lossy()
        .replace(".jsonl.gz", "")
        .replace(".jsonl", "");
    for (i, (step, sj)) in states.iter().enumerate().skip(n.saturating_sub(o.last)) {
        let real = engine
            .load_state(sj)
            .map_err(|e| format!("{}: window {i}: {e}", path.display()))?;
        let mover = real.active;
        let actions = engine.legal_actions(&real);
        let keys: Vec<String> = actions.iter().map(|a| a.key()).collect();
        let mut rng =
            Rng(o.seed ^ (i as u64).wrapping_mul(0x2545f4914f6cdd1d) ^ step.wrapping_mul(0x9e37));
        let mut values = Vec::with_capacity(o.deals);
        let mut hashes = std::collections::HashSet::new();
        let mut nodes = 0u64;
        let mut ms = 0f64;
        for d in 0..o.deals {
            let w = if d == 0 {
                real
            } else {
                redeal(&real, mover, &mut rng)?
            };
            // Every deal keeps the mover's legal moves; a difference would break the information set.
            let here: Vec<String> = engine.legal_actions(&w).iter().map(|a| a.key()).collect();
            if here != keys {
                return Err(format!(
                    "{}: window {i}: deal {d} changed the mover's legal moves",
                    path.display()
                ));
            }
            let mut row = Vec::with_capacity(actions.len());
            for a in &actions {
                let child = match engine.apply(&w, a) {
                    Ok(c) => c,
                    Err(_) => {
                        row.push(Value::Null);
                        continue;
                    }
                };
                // A move that ends the game in a draw is settled at 1/2; the prover would call it unproven.
                if child.is_terminal() && child.winner().is_none() {
                    row.push(json!(0.5));
                    continue;
                }
                let r = search.solve(child, o.limits)?;
                nodes += r.nodes;
                ms += r.ms;
                row.push(value_for(r.result, mover));
            }
            let nothing = row.iter().all(Value::is_null);
            values.push(row);
            hashes.insert(w.zobrist());
            // No move proven on the real deal: nothing to learn here, so stop spending budget.
            if d == 0 && nothing {
                break;
            }
        }
        let complete = values.len() == o.deals
            && values
                .iter()
                .all(|r| r.len() == actions.len() && r.iter().all(|v| !v.is_null()));
        let mut rec = BTreeMap::new();
        rec.insert("game", json!(game));
        rec.insert("seed", meta["seed"].clone());
        rec.insert("bots", meta["bots"].clone());
        rec.insert("i", json!(i));
        rec.insert("windows", json!(n));
        rec.insert("fromEnd", json!(n - i));
        rec.insert("step", json!(step));
        rec.insert("round", json!(real.round));
        rec.insert("mover", json!(mover.as_str()));
        rec.insert("winner", json!(winner));
        rec.insert("oppHand", json!(real.player(mover.other()).hand.len));
        rec.insert("moves", json!(keys));
        rec.insert("values", json!(values));
        rec.insert("complete", json!(complete));
        rec.insert("deals", json!(o.deals));
        rec.insert("distinctDeals", json!(hashes.len()));
        rec.insert("nodes", json!(nodes));
        rec.insert("ms", json!(ms));
        if complete {
            let k = o.deals as f64;
            let f = |d: usize, a: usize| values[d][a].as_f64().unwrap();
            let omni = (0..o.deals)
                .map(|d| (0..actions.len()).map(|a| f(d, a)).fold(0., f64::max))
                .sum::<f64>()
                / k;
            let avg: Vec<f64> = (0..actions.len())
                .map(|a| (0..o.deals).map(|d| f(d, a)).sum::<f64>() / k)
                .collect();
            let best = avg.iter().cloned().fold(0., f64::max);
            let pick = avg.iter().position(|&x| x == best).unwrap_or(0);
            rec.insert("omni", json!(omni));
            rec.insert("pimc", json!(best));
            rec.insert("gap", json!(omni - best));
            rec.insert("pimcMove", json!(keys.get(pick)));
            rec.insert(
                "realBest",
                json!((0..actions.len()).map(|a| f(0, a)).fold(0., f64::max)),
            );
            rec.insert("realPimc", json!(f(0, pick)));
        }
        serde_json::to_writer(&mut *out, &rec).map_err(|e| e.to_string())?;
        out.write_all(b"\n").map_err(|e| e.to_string())?;
        out.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn run() -> Result<(), String> {
    let mut files = Vec::new();
    let mut flags = BTreeMap::new();
    let mut it = env::args().skip(1);
    while let Some(a) = it.next() {
        if a == "--help" || a == "-h" {
            print!("{HELP}");
            return Ok(());
        }
        if let Some(k) = a.strip_prefix("--") {
            flags.insert(
                k.to_string(),
                it.next().ok_or(format!("{a} requires a value"))?,
            );
        } else {
            files.push(a);
        }
    }
    let num = |k: &str, d: u64| -> Result<u64, String> {
        flags.get(k).map_or(Ok(d), |v| {
            v.parse().map_err(|_| format!("invalid --{k} {v}"))
        })
    };
    let o = Opts {
        deals: num("deals", 8)? as usize,
        last: num("last", 10)? as usize,
        seed: num("seed", 1)?,
        limits: Limits {
            depth: num("depth", 12)? as u16,
            nodes: Some(num("nodes", 50_000)?),
            time: None,
            table_entries: 16_384,
        },
    };
    if o.deals == 0 || files.is_empty() {
        return Err(HELP.into());
    }
    let pool = flags
        .get("pool")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../omni/rs/pool.json"));
    let engine = Engine::from_pool(&pool)?;
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for f in &files {
        run_trace(&engine, Path::new(f), &o, &mut out)?;
    }
    Ok(())
}

fn main() {
    let outcome = std::thread::Builder::new()
        .stack_size(64 * 1024 * 1024)
        .spawn(run)
        .expect("thread")
        .join();
    match outcome {
        Ok(Ok(())) => (),
        Ok(Err(e)) => {
            eprintln!("omni-pimc: {e}");
            std::process::exit(1);
        }
        Err(_) => {
            eprintln!("omni-pimc: thread panicked");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use omni_rs::check::first_state;

    fn sorted(z: &[CardId]) -> Vec<CardId> {
        let mut v = z.to_vec();
        v.sort();
        v
    }

    #[test]
    fn redeal_keeps_everything_the_mover_sees() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let engine = Engine::from_pool(&root.join("../omni/rs/pool.json")).unwrap();
        let (_, states, _) =
            traces(&root.join("tests/fixtures/heuristic-vs-heuristic-1.jsonl.gz")).unwrap();
        let mut rng = Rng(7);
        let mut changed = false;
        let mut tried_exhausted = false;
        for (_, sj) in states.iter().step_by(5) {
            let s = engine.load_state(sj).unwrap();
            let seer = s.active;
            let (o, me) = (s.player(seer.other()), s.player(seer));
            let unseen = |p: &omni_rs::model::Player| {
                sorted(&[p.hand.as_slice(), p.resources.as_slice(), p.deck.as_slice()].concat())
            };
            let tired = |st: &State, z: &Zone| {
                z.as_slice()
                    .iter()
                    .map(|&id| st.card(id).exhausted)
                    .collect::<Vec<_>>()
            };
            tried_exhausted |= tired(&s, &o.resources).contains(&true);
            for _ in 0..5 {
                let w = redeal(&s, seer, &mut rng).unwrap();
                let (o2, me2) = (w.player(seer.other()), w.player(seer));
                assert_eq!(
                    (o.hand.len, o.resources.len, o.deck.len),
                    (o2.hand.len, o2.resources.len, o2.deck.len)
                );
                assert_eq!(unseen(o), unseen(o2));
                assert_eq!(tired(&s, &o.resources), tired(&w, &o2.resources));
                assert!(o2
                    .hand
                    .as_slice()
                    .iter()
                    .chain(o2.deck.as_slice())
                    .all(|&id| !w.card(id).exhausted));
                assert_eq!(sorted(me.deck.as_slice()), sorted(me2.deck.as_slice()));
                assert_eq!(
                    (me.hand, me.resources, me.ground, me.space, me.discard),
                    (me2.hand, me2.resources, me2.ground, me2.space, me2.discard)
                );
                assert_eq!(
                    (o.ground, o.space, o.discard),
                    (o2.ground, o2.space, o2.discard)
                );
                let keys = |x: &State| {
                    engine
                        .legal_actions(x)
                        .iter()
                        .map(|a| a.key())
                        .collect::<Vec<_>>()
                };
                assert_eq!(keys(&s), keys(&w));
                changed |= w.zobrist() != s.zobrist();
            }
        }
        assert!(changed, "re-deals must change the hidden part");
        assert!(
            tried_exhausted,
            "the fixture must exercise exhausted resources"
        );
    }
}
