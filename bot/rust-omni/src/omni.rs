//! Search with playouts in the native simulator.
//!
//! The same idea as rust-search (greedy2 picks the candidates, greedy2 plays both seats to the end of the round's
//! action phase, the board score from our seat decides), but every playout runs in-process on bot/omni-rs instead of
//! through the referee's `sim` requests. That is about a thousand times cheaper per step, so it plays out more
//! candidates against several guesses of the hidden cards (my deck order, the opponent's hand, resources and deck).
//!
//! It only knows the simulator's card pool. When a game has another card, the referee sent no deck lists, or the
//! real position does not map onto the simulator exactly (card numbering, the legal actions), it plays as
//! rust-search and says why once per game on stderr.

use crate::view::{self, Pool, Table};
use omni_rs::model::{CardId, Decision, Seat, State as Sim};
use omni_rs::{Action as SimAction, Engine};
use serde_json::Value;
use std::collections::HashSet;
use std::time::{Duration, Instant};
use swu_bot_rs::cards::CardDb;
use swu_bot_rs::policy::greedy2::Greedy2;
use swu_bot_rs::policy::search::{evaluate, Search, Weights};
use swu_bot_rs::policy::{Policy, Rng, Simulator};
use swu_bot_rs::protocol::{Decide, DistShare, Hello};

const WIN: f64 = 10_000.0;

/// `$name` as a number, or `default`.
fn env_or<T: std::str::FromStr>(name: &str, default: T) -> T {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

pub struct OmniSearch {
    base: Search,
    engine: Result<(Engine, Pool), String>,
    table: Result<Table, String>,
    me: Seat,
    seed: u64,
    rng: Rng,
    /// Fallback reasons already reported this game.
    said: HashSet<String>,
    /// This game: decisions searched in the simulator, and decisions left to rust-search.
    pub searched: u32,
    pub fallbacks: u32,
    /// The attack target picked with the attacker, for the target prompt that follows.
    planned: Option<SimAction>,
    /// Candidates per decision, guesses of the hidden cards, simulated steps per playout, extra rounds per playout.
    pub width: usize,
    pub deals: usize,
    pub max_steps: usize,
    pub rounds: u16,
    /// Score an attack with each of its targets (the attacker and target are picked together).
    pub targets: bool,
    pub w: Weights,
}

/// The simulator with its card pool, from the pool file (`bot/omni/rs/pool.json`, run from the repo root).
pub fn load_engine(path: &str) -> Result<(Engine, Pool), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
    let v: Value = serde_json::from_slice(&bytes).map_err(|e| format!("{path}: {e}"))?;
    Ok((Engine::from_pool_value(&v)?, Pool::from_json(&v)))
}

impl OmniSearch {
    pub fn new(db: &'static CardDb, engine: Result<(Engine, Pool), String>) -> Self {
        OmniSearch {
            base: Search::new(db),
            engine,
            table: Err("no game yet".into()),
            me: Seat::P1,
            seed: 0,
            rng: Rng::default(),
            said: HashSet::new(),
            searched: 0,
            fallbacks: 0,
            planned: None,
            width: env_or("SWU_OMNI_WIDTH", 8),
            deals: env_or("SWU_OMNI_DEALS", 8),
            max_steps: env_or("SWU_OMNI_STEPS", 400),
            rounds: env_or("SWU_OMNI_ROUNDS", 0),
            targets: env_or("SWU_OMNI_TARGETS", 1) == 1,
            w: Weights {
                // the pool's units are keyword-only, and racing the base matters more there: base 2.0 (rust-search's
                // 1.35) won 20 of 56 against c-clock instead of 14, and 33-23 against rust-search instead of 31-25
                base: env_or("SWU_EVAL_BASE", 2.0),
                ..Weights::from_env()
            },
        }
    }

    fn note(&mut self, why: &str) {
        if self.said.insert(why.to_owned()) {
            eprintln!("rust-omni: playing as rust-search: {why}");
        }
    }

    /// The action to play (with the attack target to pick next, if any), None when there is nothing to compare (greedy2
    /// decides), or why the simulator cannot.
    fn plan(&mut self, req: &Decide) -> Result<Option<(usize, Option<SimAction>)>, String> {
        let (e, pool) = self.engine.as_ref().map_err(Clone::clone)?;
        let t = self.table.as_ref().map_err(Clone::clone)?;
        if !req.prompt.action_window {
            return Err("not an action window".into());
        }
        if !t.agrees(&req.state) {
            return Err("card ids are not numbered like the engine's".into());
        }
        let deadline = Instant::now() + Duration::from_millis((req.ms.unwrap_or(10_000) / 3).min(3_000));
        let mut deals = Vec::with_capacity(self.deals);
        for _ in 0..self.deals.max(1) {
            let v = view::full_state(t, pool, &req.state, self.me.as_str(), &mut self.rng)?;
            deals.push(e.load_state(&v)?);
        }
        // every referee action must be exactly one simulator action, and the other way round
        let legal = e.legal_actions(&deals[0]);
        let mut map: Vec<SimAction> = Vec::with_capacity(req.actions.len());
        for a in &req.actions {
            let mut m = legal.iter().filter(|b| view::same(a, b));
            match (m.next(), m.next()) {
                (Some(b), None) => map.push(b.clone()),
                _ => return Err(format!("no single simulator action for {} {:?}", a.kind, a.label)),
            }
        }
        if legal.len() != map.len() {
            let extra: Vec<&str> = legal.iter().filter(|b| !map.contains(b)).map(|b| b.label.as_str()).collect();
            return Err(format!("the simulator also allows {extra:?}"));
        }
        let g = self.base.greedy2();
        let scores = g.scores(req);
        let mut order: Vec<usize> = (0..req.actions.len()).collect();
        order.sort_by(|a, b| scores[*b].partial_cmp(&scores[*a]).unwrap_or(std::cmp::Ordering::Equal));
        let cands: Vec<usize> = order.into_iter().filter(|i| scores[*i] > -40.0).take(self.width).collect();
        if cands.len() < 2 {
            return Ok(None);
        }
        let g = g.clone();
        // a unit's attack is one candidate per target, in greedy2's order of the targets
        let mut options: Vec<(usize, Option<SimAction>)> = vec![];
        for &i in &cands {
            let s = e.apply(&deals[0], &map[i])?;
            if self.targets && s.decision == Decision::AttackTarget && s.active == self.me {
                let targets: Vec<SimAction> = e.legal_actions(&s).into_iter().filter(|a| a.kind == "card").collect();
                let d = view::decide(e, &s, &targets);
                let scores = g.clone().scores(&d);
                let mut order: Vec<usize> = (0..targets.len()).collect();
                order.sort_by(|a, b| scores[*b].partial_cmp(&scores[*a]).unwrap_or(std::cmp::Ordering::Equal));
                options.extend(order.into_iter().map(|k| (i, Some(targets[k].clone()))));
            } else {
                options.push((i, None));
            }
        }
        // one guess at a time for all candidates, so every candidate is scored on the same guesses
        let mut totals = vec![0.0; options.len()];
        let mut done = 0;
        'deals: for d in &deals {
            let mut round = vec![0.0; options.len()];
            for (k, (i, target)) in options.iter().enumerate() {
                let mut s = e.apply(d, &map[*i])?;
                if let Some(t) = target {
                    s = e.apply(&s, t)?;
                }
                match self.playout(e, s, &g, req.state.round as u16, deadline) {
                    Some(v) => round[k] = v,
                    None => break 'deals,
                }
            }
            for (t, v) in totals.iter_mut().zip(round) {
                *t += v;
            }
            done += 1;
        }
        if done == 0 {
            return Err("no playout finished in time".into());
        }
        // greedy2's order breaks near-ties
        let rank = |i: usize| cands.iter().position(|&c| c == i).unwrap_or(0) as f64;
        let mut best: Option<(f64, usize)> = None;
        for (k, (i, _)) in options.iter().enumerate() {
            let v = totals[k] / done as f64 - rank(*i) * 0.01 - k as f64 * 1e-4;
            if best.is_none_or(|b| v > b.0) {
                best = Some((v, k));
            }
        }
        Ok(best.map(|(_, k)| options.swap_remove(k)))
    }

    /// Greedy2 on both seats from `s` to the end of the action phase `rounds` rounds later (or the step cap); the board
    /// score from my seat, or None past the deadline.
    fn playout(&self, e: &Engine, mut s: Sim, g: &Greedy2, round: u16, deadline: Instant) -> Option<f64> {
        let mut mine = g.clone();
        let mut theirs = Greedy2::new(g.db());
        theirs.new_game(&Hello { v: 1, you: self.me.other().as_str().into(), seed: self.seed ^ 0x5eed, ..Default::default() });
        let last = round.saturating_add(self.rounds);
        for step in 0..self.max_steps {
            if s.is_terminal() || s.round > last || (s.round == last && s.regroup) {
                break;
            }
            if step % 16 == 0 && Instant::now() >= deadline {
                return None;
            }
            let actions = e.legal_actions(&s);
            if actions.is_empty() {
                break;
            }
            let i = match s.decision {
                Decision::Window | Decision::AttackTarget | Decision::LeaderMenu | Decision::VaderBase | Decision::NoEffect => {
                    let d = view::decide(e, &s, &actions);
                    let who = if s.active == self.me { &mut mine } else { &mut theirs };
                    who.choose(&d)
                }
                // the regroup's resource step: greedy2's pick of a hand card (or none), then confirm
                Decision::Resource if s.resource_selected[s.active.index()] == 0 => {
                    let who = if s.active == self.me { &mut mine } else { &mut theirs };
                    let scores = who.scores(&view::decide(e, &s, &actions));
                    (0..scores.len()).fold(0, |b, k| if scores[k] > scores[b] { k } else { b })
                }
                Decision::SatineHeal => heal(&s, &actions),
                Decision::Unique => keep_the_best(&s, &actions),
                // ambush: attack; trigger order: the simulator lists triggers with an effect first; shields: mine
                _ => 0,
            };
            s = e.apply(&s, &actions[i]).ok()?;
        }
        Some(match s.winner() {
            Some(w) if w == self.me => WIN,
            Some(_) => -WIN,
            None if s.is_terminal() => 0.0,
            None => evaluate(&view::view(e, &s, None), self.me.as_str(), &self.w),
        })
    }
}

fn card_id(v: &Value) -> Option<CardId> {
    v.as_str()?.strip_prefix('c')?.parse::<CardId>().ok()?.checked_add(1)
}

/// Satine's heal: as much healing as possible on the acting seat's own units, none on the opponent's.
fn heal(s: &Sim, actions: &[SimAction]) -> usize {
    let value = |a: &SimAction| -> i32 {
        let Some(Value::Array(shares)) = &a.arg else { return 0 };
        shares
            .iter()
            .filter_map(|sh| {
                let id = card_id(&sh[0])?;
                let healed = (sh[1].as_u64()? as i32).min(s.card(id).damage as i32);
                Some(if s.card(id).owner == s.active { healed } else { -healed })
            })
            .sum()
    };
    (0..actions.len()).fold(0, |best, i| if value(&actions[i]) > value(&actions[best]) { i } else { best })
}

/// A second copy of a unique unit: defeat the most damaged copy (the exhausted one on a tie).
fn keep_the_best(s: &Sim, actions: &[SimAction]) -> usize {
    let worse = |a: &SimAction| a.id().map_or((0, false), |id| (s.card(id).damage, s.card(id).exhausted));
    (0..actions.len()).fold(0, |best, i| if worse(&actions[i]) > worse(&actions[best]) { i } else { best })
}

impl Policy for OmniSearch {
    fn new_game(&mut self, hello: &Hello) {
        if self.searched + self.fallbacks > 0 {
            eprintln!("rust-omni: last game {} decisions searched in the simulator, {} as rust-search", self.searched, self.fallbacks);
        }
        self.base.new_game(hello);
        self.me = Seat::parse(&hello.you).unwrap_or(Seat::P1);
        self.seed = hello.seed;
        self.rng.seed(hello.seed ^ 0x0a11);
        self.said.clear();
        self.searched = 0;
        self.fallbacks = 0;
        self.table = match &self.engine {
            Ok((_, pool)) => Table::new(hello, pool),
            Err(e) => Err(e.clone()),
        };
    }

    fn choose(&mut self, req: &Decide) -> usize {
        // the target picked together with the attacker
        if let Some(i) = self.planned.as_ref().and_then(|t| req.actions.iter().position(|a| view::same(a, t))) {
            self.planned = None;
            self.base.greedy2().record(req, i);
            return i;
        }
        self.base.choose(req)
    }

    fn distribution(&mut self, req: &Decide, i: usize) -> Option<Vec<DistShare>> {
        self.base.distribution(req, i)
    }

    fn wants_sim(&self) -> bool {
        true
    }

    fn choose_sim(&mut self, req: &Decide, sim: &mut dyn Simulator) -> usize {
        self.planned = None;
        match self.plan(req) {
            Ok(Some((i, target))) => {
                self.searched += 1;
                self.planned = target;
                self.base.greedy2().record(req, i);
                i
            }
            Ok(None) => self.base.choose(req),
            Err(why) => {
                self.fallbacks += 1;
                self.note(&why);
                self.base.choose_sim(req, sim)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::view::tests::{board, engine, hello};
    use swu_bot_rs::policy::SimOp;
    use swu_bot_rs::protocol::Simulated;

    /// A referee that counts `sim` requests and fails them.
    struct Referee(u32);
    impl Simulator for Referee {
        fn sim(&mut self, op: SimOp) -> Simulated {
            self.0 += 1;
            Simulated { op: op.name().into(), error: Some("sims off".into()), ..Default::default() }
        }
    }

    /// The decision at `board()` as the referee would send it: the simulator's own legal actions there.
    fn request() -> Decide {
        let (e, pool) = engine();
        let t = Table::new(&hello("p1"), &pool).unwrap();
        let s = e.load_state(&view::full_state(&t, &pool, &board(), "p1", &mut Rng::default()).unwrap()).unwrap();
        let mut d = view::decide(&e, &s, &e.legal_actions(&s));
        d.state = board();
        d.sim = true;
        d.ms = Some(600);
        d
    }

    fn bot() -> OmniSearch {
        let db: &'static CardDb = Box::leak(Box::new(CardDb::default()));
        let mut b = OmniSearch::new(db, Ok(engine()));
        b.new_game(&hello("p1"));
        b
    }

    #[test]
    fn searches_pool_games_without_the_referee() {
        let req = request();
        assert!(req.actions.len() >= 3, "{:?}", req.actions.iter().map(|a| &a.label).collect::<Vec<_>>());
        let mut b = bot();
        let mut referee = Referee(0);
        let i = b.choose_sim(&req, &mut referee);
        assert!(i < req.actions.len());
        assert_eq!((b.searched, b.fallbacks, referee.0), (1, 0, 0));
    }

    #[test]
    fn playouts_can_run_through_the_regroup() {
        let req = request();
        let mut b = bot();
        b.rounds = 2;
        let mut referee = Referee(0);
        b.choose_sim(&req, &mut referee);
        assert_eq!((b.searched, b.fallbacks, referee.0), (1, 0, 0));
    }

    #[test]
    fn plays_as_rust_search_when_the_actions_differ() {
        let mut req = request();
        req.actions.retain(|a| a.label != "Claim Initiative");
        for (i, a) in req.actions.iter_mut().enumerate() {
            a.i = i;
        }
        let mut b = bot();
        let mut referee = Referee(0);
        b.choose_sim(&req, &mut referee);
        assert_eq!((b.searched, b.fallbacks), (0, 1));
        assert!(referee.0 > 0, "rust-search asked the referee");
    }

    #[test]
    fn heals_its_own_units_only() {
        let (e, pool) = engine();
        let t = Table::new(&hello("p1"), &pool).unwrap();
        let mut s = e.load_state(&view::full_state(&t, &pool, &board(), "p1", &mut Rng::default()).unwrap()).unwrap();
        let shares = |id: &str, n: u64| SimAction { kind: "distribute".into(), card: None, arg: Some(serde_json::json!([[id, n]])), method: None, label: "distribute 2".into() };
        let none = SimAction { arg: Some(serde_json::json!([])), ..shares("c9", 1) };
        // only the opponent's Pod (c9) is damaged: heal nothing
        assert_eq!(heal(&s, &[none.clone(), shares("c9", 1), shares("c9", 2)]), 0);
        s.active = Seat::P2;
        assert_eq!(heal(&s, &[none, shares("c9", 1), shares("c9", 2)]), 1, "1 damage: healing 1 is enough");
    }
}
