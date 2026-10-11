use super::greedy2::{unit_value, Greedy2};
use super::{Policy, SimOp, Simulator};
use crate::cards::CardDb;
use crate::protocol::{other, Decide, DistShare, Hello, Over, PlayerView, Simulated, State};
use std::time::Instant;

/// Search: greedy2 plus a look ahead with protocol v2 simulations.
///
/// At each decision with simulations it takes greedy2's best few actions, and for each one: starts a simulation (hidden
/// cards dealt again at random, the same deals for every candidate), plays the action, then lets greedy2 play both seats
/// until the round's action phase ends or a step cap, and scores the board from its own seat. It plays the action with
/// the best average score; greedy2's own order breaks near-ties. Without simulations (a v1 referee, or any error) it is
/// greedy2.
pub struct Search {
    g: Greedy2,
    seed: u64,
    me: String,
    /// Candidates per window, deals per candidate, simulated steps per playout.
    pub width: usize,
    pub deals: usize,
    pub max_steps: usize,
}

impl Search {
    pub fn new(db: &'static CardDb) -> Self {
        Search { g: Greedy2::new(db), seed: 0, me: String::new(), width: 6, deals: 1, max_steps: 60 }
    }
}

/// Board score from `me`'s seat: base HP (steeper when low), units, cards in hand, resources, initiative.
pub fn evaluate(state: &State, me: &str) -> f64 {
    let empty = PlayerView::default();
    let side = |seat: &str| -> f64 {
        let p = state.players.get(seat).unwrap_or(&empty);
        let hp = p.base_left() as f64;
        let mut v = hp * 0.9 * 1.5 + if hp <= 12.0 { (12.0 - hp).powi(2) / 6.0 * -1.5 } else { 0.0 };
        for u in p.units() {
            v += unit_value(u) * if u.ready() { 1.0 } else { 0.85 };
        }
        v + p.hand_count as f64 * 1.8 + p.res.total as f64 * 1.4 + if state.initiative.as_deref() == Some(seat) { 2.5 } else { 0.0 }
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

    /// Plays the simulation from `pos` with greedy2 on both seats; the score at the end, or None if it failed.
    fn playout(&self, mut pos: Simulated, sim: &mut dyn Simulator, round: u32) -> Option<f64> {
        let mut mine = self.g.clone();
        let mut theirs = Greedy2::new(self.g.db());
        theirs.new_game(&Hello { protocol: String::new(), v: 1, bot: String::new(), you: other(&self.me).into(), seed: self.seed ^ 0x5eed, versions: vec![] });
        for _ in 0..self.max_steps {
            if pos.error.is_some() {
                return None;
            }
            if let Some(over) = pos.over.as_ref() {
                return Some(self.outcome(over));
            }
            let state = pos.state.take()?;
            if state.round != round || state.phase.as_deref().is_some_and(|ph| ph != "action") {
                return Some(evaluate(&state, &self.me));
            }
            let actor = pos.actor.take()?;
            let d = Decide { seq: 0, you: actor.clone(), prompt: pos.prompt.take()?, state, actions: pos.actions.take()?, sim: false, ms: None };
            if d.actions.is_empty() {
                return Some(evaluate(&d.state, &self.me));
            }
            let who = if actor == self.me { &mut mine } else { &mut theirs };
            let i = who.choose(&d);
            let split = if d.actions[i].kind == "distribute" { who.distribution(&d, i) } else { None };
            pos = sim.sim(SimOp::Act(i, split));
            if pos.error.is_some() || pos.over.is_some() {
                continue;
            }
            if pos.state.is_none() {
                return Some(evaluate(&d.state, &self.me));
            }
        }
        // step cap
        match (&pos.error, &pos.over, &pos.state) {
            (Some(_), ..) => None,
            (_, Some(over), _) => Some(self.outcome(over)),
            (_, _, state) => state.as_ref().map(|s| evaluate(s, &self.me)),
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
        let t0 = Instant::now();
        // spend at most a third of the time on offer, and never more than 3 s
        let budget_ms = (req.ms.unwrap_or(10_000) / 3).min(3_000) as u128;
        let scores = self.g.scores(req);
        let mut order: Vec<usize> = (0..req.actions.len()).collect();
        order.sort_by(|a, b| scores[*b].partial_cmp(&scores[*a]).unwrap_or(std::cmp::Ordering::Equal));
        let cands: Vec<usize> = order.into_iter().filter(|i| scores[*i] > -40.0).take(self.width).collect();
        if cands.len() < 2 {
            return self.g.choose(req);
        }
        let mut best: Option<(f64, usize)> = None;
        for (rank, &i) in cands.iter().enumerate() {
            if t0.elapsed().as_millis() > budget_ms {
                break;
            }
            let mut total = 0.0;
            let mut n = 0;
            for deal in 1..=self.deals as u32 {
                let begin = sim.sim(SimOp::Begin(Some(deal)));
                if begin.error.is_some() {
                    break;
                }
                let split = if req.actions[i].kind == "distribute" { self.g.distribution(req, i) } else { None };
                let pos = sim.sim(SimOp::Act(i, split));
                if let Some(v) = self.playout(pos, sim, req.state.round) {
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
