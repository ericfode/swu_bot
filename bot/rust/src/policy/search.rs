use super::greedy2::{unit_value, Greedy2};
use super::{Policy, SimOp, Simulator};
use crate::cards::CardDb;
use crate::protocol::{other, Decide, DistShare, Hello, Over, PlayerView, Simulated, State};
use std::time::{Duration, Instant};

/// Search: greedy2 plus a look ahead with protocol v2 simulations.
///
/// At each decision with simulations it takes greedy2's best few actions, and for each one: starts a simulation (hidden
/// cards dealt again at random, the same deals for every candidate), plays the action, then lets greedy2 play both seats
/// until the round's action phase ends (or `rounds` more rounds) or a step cap, and scores the board from its own seat.
/// It plays the action with the best average score; greedy2's own order breaks near-ties. Without simulations (a v1
/// referee, or any error) it is greedy2.
pub struct Search {
    g: Greedy2,
    seed: u64,
    me: String,
    /// Candidates per decision, deals per candidate, simulated steps per playout, extra rounds per playout.
    pub width: usize,
    pub deals: usize,
    pub max_steps: usize,
    pub rounds: u32,
    pub w: Weights,
}

/// `$name` as a number, or `default` (for experiments: `env` in `bot/external-bots.json`).
fn env_or<T: std::str::FromStr>(name: &str, default: T) -> T {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

impl Search {
    pub fn new(db: &'static CardDb) -> Self {
        Search {
            g: Greedy2::new(db),
            seed: 0,
            me: String::new(),
            width: env_or("SWU_SEARCH_WIDTH", 6),
            deals: env_or("SWU_SEARCH_DEALS", 1),
            max_steps: env_or("SWU_SEARCH_STEPS", 60),
            rounds: env_or("SWU_SEARCH_ROUNDS", 0),
            w: Weights::from_env(),
        }
    }
}

/// Weights of the board score.
#[derive(Clone, Copy)]
pub struct Weights {
    /// Per point of base HP left (the danger term below 12 HP comes on top).
    pub base: f64,
    /// Times greedy2's unit value (power, HP left, shields, sentinel).
    pub unit: f64,
    /// Share of its value an exhausted unit keeps.
    pub exhausted: f64,
    pub hand: f64,
    pub resource: f64,
    pub initiative: f64,
}

impl Default for Weights {
    fn default() -> Self {
        Weights { base: 1.35, unit: 1.0, exhausted: 0.85, hand: 1.8, resource: 1.4, initiative: 2.5 }
    }
}

impl Weights {
    fn from_env() -> Self {
        let d = Weights::default();
        Weights {
            base: env_or("SWU_EVAL_BASE", d.base),
            unit: env_or("SWU_EVAL_UNIT", d.unit),
            exhausted: env_or("SWU_EVAL_EXHAUSTED", d.exhausted),
            hand: env_or("SWU_EVAL_HAND", d.hand),
            resource: env_or("SWU_EVAL_RESOURCE", d.resource),
            initiative: env_or("SWU_EVAL_INITIATIVE", d.initiative),
        }
    }
}

/// Board score from `me`'s seat: base HP (steeper when low), units, cards in hand, resources, initiative.
pub fn evaluate(state: &State, me: &str, w: &Weights) -> f64 {
    let empty = PlayerView::default();
    let side = |seat: &str| -> f64 {
        let p = state.players.get(seat).unwrap_or(&empty);
        let hp = p.base_left() as f64;
        let mut v = hp * w.base + if hp <= 12.0 { (12.0 - hp).powi(2) / 6.0 * -1.5 } else { 0.0 };
        for u in p.units() {
            v += unit_value(u) * w.unit * if u.ready() { 1.0 } else { w.exhausted };
        }
        let initiative = if state.initiative.as_deref() == Some(seat) { w.initiative } else { 0.0 };
        v + p.hand_count as f64 * w.hand + p.res.total as f64 * w.resource + initiative
    };
    side(me) - side(other(me))
}

const WIN: f64 = 10_000.0;

impl Search {
    fn outcome(&self, over: &Over) -> f64 {
        match over.winner.as_deref() {
            Some(w) if w == self.me => WIN,
            Some(w) if w == other(&self.me) => -WIN,
            _ => 0.0,
        }
    }

    /// Plays the simulation from `pos` with greedy2 on both seats; the score at the end or at the step cap, or None if
    /// it failed or ran past the deadline (a cut playout is not comparable with full ones).
    fn playout(&self, mut pos: Simulated, sim: &mut dyn Simulator, round: u32, deadline: Instant) -> Option<f64> {
        let mut mine = self.g.clone();
        let mut theirs = Greedy2::new(self.g.db());
        theirs.new_game(&Hello { protocol: String::new(), v: 1, bot: String::new(), you: other(&self.me).into(), seed: self.seed ^ 0x5eed, versions: vec![] });
        for _ in 0..self.max_steps {
            if pos.error.is_some() || Instant::now() >= deadline {
                return None;
            }
            if let Some(over) = pos.over.as_ref() {
                return Some(self.outcome(over));
            }
            let state = pos.state.take()?;
            let last = round + self.rounds;
            if state.round > last || (state.round == last && state.phase.as_deref().is_some_and(|ph| ph != "action")) {
                return Some(evaluate(&state, &self.me, &self.w));
            }
            let actor = pos.actor.take()?;
            let d = Decide { seq: 0, you: actor.clone(), prompt: pos.prompt.take()?, state, actions: pos.actions.take()?, sim: false, ms: None };
            if d.actions.is_empty() {
                return Some(evaluate(&d.state, &self.me, &self.w));
            }
            let who = if actor == self.me { &mut mine } else { &mut theirs };
            let i = who.choose(&d);
            let split = if d.actions[i].kind == "distribute" { who.distribution(&d, i) } else { None };
            pos = sim.sim(SimOp::Act(i, split));
            if pos.error.is_some() || pos.over.is_some() {
                continue;
            }
            if pos.state.is_none() {
                return Some(evaluate(&d.state, &self.me, &self.w));
            }
        }
        // step cap
        match (&pos.error, &pos.over, &pos.state) {
            (Some(_), ..) => None,
            (_, Some(over), _) => Some(self.outcome(over)),
            (_, _, state) => state.as_ref().map(|s| evaluate(s, &self.me, &self.w)),
        }
    }
}

impl Policy for Search {
    fn new_game(&mut self, hello: &Hello) {
        self.g.new_game(hello);
        self.seed = hello.seed;
        self.me = hello.you.clone();
    }

    fn choose(&mut self, req: &Decide) -> usize {
        self.g.choose(req)
    }

    fn distribution(&mut self, req: &Decide, i: usize) -> Option<Vec<DistShare>> {
        self.g.distribution(req, i)
    }

    fn wants_sim(&self) -> bool {
        true
    }

    fn choose_sim(&mut self, req: &Decide, sim: &mut dyn Simulator) -> usize {
        // spend at most a third of the time on offer, and never more than 3 s; a playout stops at the deadline
        let deadline = Instant::now() + Duration::from_millis((req.ms.unwrap_or(10_000) / 3).min(3_000));
        let scores = self.g.scores(req);
        let mut order: Vec<usize> = (0..req.actions.len()).collect();
        order.sort_by(|a, b| scores[*b].partial_cmp(&scores[*a]).unwrap_or(std::cmp::Ordering::Equal));
        let cands: Vec<usize> = order.into_iter().filter(|i| scores[*i] > -40.0).take(self.width).collect();
        if cands.len() < 2 {
            return self.g.choose(req);
        }
        let mut best: Option<(f64, usize)> = None;
        for (rank, &i) in cands.iter().enumerate() {
            if Instant::now() >= deadline {
                break;
            }
            let mut total = 0.0;
            let mut n = 0;
            for deal in 1..=self.deals as u32 {
                if Instant::now() >= deadline {
                    break;
                }
                let begin = sim.sim(SimOp::Begin(Some(deal)));
                // a slow begin can use up the budget: then no act either
                if begin.error.is_some() || Instant::now() >= deadline {
                    break;
                }
                let split = if req.actions[i].kind == "distribute" { self.g.distribution(req, i) } else { None };
                let pos = sim.sim(SimOp::Act(i, split));
                if let Some(v) = self.playout(pos, sim, req.state.round, deadline) {
                    total += v;
                    n += 1;
                }
            }
            if n == 0 {
                continue;
            }
            // greedy2's order breaks near-ties
            let v = total / n as f64 - rank as f64 * 0.01;
            if best.is_none_or(|(bv, _)| v > bv) {
                best = Some((v, i));
            }
        }
        sim.sim(SimOp::End);
        match best {
            Some((_, i)) => {
                self.g.record(req, i);
                i
            }
            None => self.g.choose(req),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Decide;

    /// A scripted referee: `begin` returns nothing useful, `act i` ends the game with a win only for action 1.
    struct Scripted {
        last: Option<usize>,
        calls: Vec<String>,
    }
    impl Simulator for Scripted {
        fn sim(&mut self, op: SimOp) -> Simulated {
            self.calls.push(op.name().into());
            if let SimOp::Act(i, _) = op {
                self.last = Some(i);
                let winner = if i == 1 { "p1" } else { "p2" };
                return serde_json::from_str(&format!(r#"{{"t":"simulated","op":"act","over":{{"winner":"{winner}"}}}}"#)).unwrap();
            }
            Simulated { op: op.name().into(), ..Default::default() }
        }
    }

    #[test]
    fn plays_the_action_whose_simulation_wins() {
        let db: &'static CardDb = Box::leak(Box::new(CardDb::default()));
        let mut s = Search::new(db);
        s.new_game(&serde_json::from_str(r#"{"t":"hello","v":1,"you":"p1","seed":3}"#).unwrap());
        // greedy2 alone prefers the hand card (0); only the simulation knows that passing (1) wins
        let req: Decide = serde_json::from_str(
            r#"{"t":"decide","you":"p1","sim":true,"ms":10000,
                "prompt":{"type":"actionWindow","signature":"actionWindow|-","title":"Choose an action","selected":[],"actionWindow":true},
                "state":{"round":2,"phase":"action","players":{"p1":{"res":{"ready":3,"total":3}},"p2":{}}},
                "actions":[{"i":0,"kind":"card","label":"x","card":{"id":"h1","zone":"hand","ctl":"p1"}},{"i":1,"kind":"button","label":"Claim Initiative"}]}"#,
        )
        .unwrap();
        let mut sim = Scripted { last: None, calls: vec![] };
        assert_eq!(s.choose_sim(&req, &mut sim), 1);
        assert_eq!(sim.calls, ["begin", "act", "begin", "act", "end"]);
    }

    #[test]
    fn stops_simulating_at_the_deadline() {
        /// A game that never ends, 5 ms per step.
        struct Slow(usize);
        impl Simulator for Slow {
            fn sim(&mut self, op: SimOp) -> Simulated {
                self.0 += 1;
                std::thread::sleep(Duration::from_millis(5));
                serde_json::from_str(&format!(
                    r#"{{"t":"simulated","op":"{}","actor":"p1","prompt":{{"type":"actionWindow","signature":"a","title":"x","selected":[],"actionWindow":true}},
                        "state":{{"round":2,"phase":"action","players":{{"p1":{{}},"p2":{{}}}}}},"actions":[{{"i":0,"kind":"button","label":"Pass"}},{{"i":1,"kind":"button","label":"Claim Initiative"}}]}}"#,
                    op.name()
                ))
                .unwrap()
            }
        }
        let db: &'static CardDb = Box::leak(Box::new(CardDb::default()));
        let mut s = Search::new(db);
        s.new_game(&serde_json::from_str(r#"{"t":"hello","v":1,"you":"p1","seed":3}"#).unwrap());
        let req: Decide = serde_json::from_str(
            r#"{"t":"decide","you":"p1","sim":true,"ms":90,
                "prompt":{"type":"actionWindow","signature":"actionWindow|-","title":"Choose an action","selected":[],"actionWindow":true},
                "state":{"round":2,"phase":"action","players":{"p1":{},"p2":{}}},
                "actions":[{"i":0,"kind":"button","label":"Pass"},{"i":1,"kind":"card","label":"x","card":{"id":"h1","zone":"hand","ctl":"p1"}}]}"#,
        )
        .unwrap();
        let t0 = Instant::now();
        let mut sim = Slow(0);
        // 30 ms budget: a few steps of the first playout, which is then dropped, so greedy2 decides
        assert_eq!(s.choose_sim(&req, &mut sim), 1);
        assert!(t0.elapsed() < Duration::from_millis(60), "{:?}", t0.elapsed());
        assert!(sim.0 < 12, "{} sims", sim.0);
    }

    #[test]
    fn falls_back_to_greedy2_when_sims_fail() {
        struct Off;
        impl Simulator for Off {
            fn sim(&mut self, op: SimOp) -> Simulated {
                Simulated { op: op.name().into(), error: Some("off".into()), ..Default::default() }
            }
        }
        let db: &'static CardDb = Box::leak(Box::new(CardDb::default()));
        let mut s = Search::new(db);
        s.new_game(&serde_json::from_str(r#"{"t":"hello","v":1,"you":"p1","seed":3}"#).unwrap());
        let req: Decide = serde_json::from_str(
            r#"{"t":"decide","you":"p1","sim":true,
                "prompt":{"type":"actionWindow","signature":"actionWindow|-","title":"Choose an action","selected":[],"actionWindow":true},
                "state":{"round":2,"phase":"action","players":{"p1":{},"p2":{}}},
                "actions":[{"i":0,"kind":"button","label":"Pass"},{"i":1,"kind":"card","label":"x","card":{"id":"h1","zone":"hand","ctl":"p1"}}]}"#,
        )
        .unwrap();
        assert_eq!(s.choose_sim(&req, &mut Off), 1);
    }
}
