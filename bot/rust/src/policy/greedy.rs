use super::{Policy, Rng};
use crate::protocol::{Action, Decide, Hello, State};
use std::collections::{HashMap, HashSet};

/// Rule-based bot that only reads the wire data (labels, cards, this seat's view of the board); no lookahead.
/// Action window: play a card if it can, otherwise attack with its biggest ready unit, pass last.
/// Targeting: hurt the opponent's biggest threat, help its own. Ties break on its own seeded RNG.
#[derive(Default)]
pub struct Greedy {
    rng: Rng,
    /// Loop guards. A play it then cancelled (no target it liked) is a no-op, so it is not retried this round;
    /// and any one choice at one prompt made too often in a round is assumed to be part of a cycle.
    round: u32,
    last_window_pick: Option<String>,
    cancelled: HashSet<String>,
    picks: HashMap<String, u32>,
}

/// Same (prompt, choice) more often than this in one round is treated as a loop.
const MAX_REPEATS: u32 = 12;

fn action_key(a: &Action) -> String {
    format!("{}:{}:{}", a.kind, a.label, a.card.as_ref().map_or("", |c| c.id.as_str()))
}

const HARM: &[&str] = &["attack", "damage", "defeat", "exhaust", "capture", "return", "discard", "bounce", "destroy", "take control"];
const HELP: &[&str] = &["heal", "shield", "give", "ready", "attach", "experience", "restore", "+"];

fn has_any(text: &str, words: &[&str]) -> bool {
    words.iter().any(|w| text.contains(w))
}

/// How many cards a select prompt wants, from its title ("Select 2 cards to resource", "select up to 3", "between 1 and 2").
fn wanted(title: &str) -> usize {
    let words: Vec<&str> = title.split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty()).collect();
    if let Some(k) = words.iter().position(|w| *w == "between") {
        if let Some(n) = words.get(k + 3).and_then(|w| w.parse().ok()) {
            return n;
        }
    }
    for (k, w) in words.iter().enumerate() {
        if *w == "select" || *w == "choose" {
            let mut j = k + 1;
            if words.get(j) == Some(&"up") && words.get(j + 1) == Some(&"to") {
                j += 2;
            }
            if let Some(n) = words.get(j).and_then(|w| w.parse().ok()) {
                return n;
            }
        }
    }
    1
}

fn button_score(label: &str, state: &State, seat: &str) -> f64 {
    let l = label.to_lowercase();
    match l.as_str() {
        "keep" => 5.0,
        "mulligan" => 0.0,
        // claiming initiative ends this player's actions for the round; only worth it when nothing else is on offer
        "claim initiative" => {
            if state.initiative.as_deref() == Some(seat) { -5.0 } else { 0.5 }
        }
        "pass" => 0.0,
        "skip resourcing" => -1.0,
        _ if l.contains("yourself") || l.contains("trigger") || l.starts_with("use") || l.contains("yes") => 4.0,
        _ if l.contains("done") || l.contains("confirm") || l.contains("resolve") || l == "ok" || l.contains("continue") => 2.0,
        _ if l.contains("pass") || l.starts_with("no") || l.contains("decline") || l.contains("skip") || l.contains("choose nothing") || l.contains("cancel") => -2.0,
        _ => 1.0,
    }
}

fn score(req: &Decide, a: &Action) -> f64 {
    let seat = req.you.as_str();
    let state = &req.state;
    let p = &req.prompt;
    let title = format!("{} {}", p.title.as_deref().unwrap_or(""), p.prompt_title.as_deref().unwrap_or("")).to_lowercase();

    match a.kind.as_str() {
        "button" => button_score(&a.label, state, seat),
        // numbers: take the biggest; other dropdowns are neutral
        "option" => a.label.strip_prefix('#').and_then(|n| n.parse::<f64>().ok()).map_or(1.0, |n| 1.0 + n * 0.1),
        "card" => {
            let Some(c) = a.card.as_ref() else { return 0.0 };
            let mine = c.ctl.as_deref() == Some(seat);
            let zone = c.zone.as_deref().unwrap_or("");
            // a multi-select that already has what it asked for: confirm instead of clicking more (extra clicks do nothing)
            if p.select_card_mode.as_deref() == Some("multiple") && p.selected.len() >= wanted(&title) {
                return -5.0;
            }
            if p.kind.as_deref() == Some("resource") {
                // resource while still building up, then stop
                let total = state.players.get(seat).map_or(0, |pl| pl.res.total);
                return if total < 7 { 3.0 + c.cost.unwrap_or(0) as f64 * 0.1 } else { -2.0 };
            }
            let unit = state.unit(&c.id);
            if p.action_window {
                return match zone {
                    "hand" => 10.0 + c.cost.unwrap_or(0) as f64,
                    "groundArena" | "spaceArena" => 6.0 + unit.map_or(0, |u| u.p) as f64 * 0.5,
                    "resource" => 5.0,
                    _ => 3.0, // leader / base abilities
                };
            }
            let harm = has_any(&title, HARM);
            let help = !harm && has_any(&title, HELP);
            if zone == "base" && unit.is_none() {
                return match (mine, harm) {
                    (false, true) => 9.0,
                    (true, _) => -9.0,
                    (false, false) => -3.0,
                };
            }
            let (pw, hp_left) = unit.map_or((0, 0), |u| (u.p, (u.h - u.d).max(0)));
            let val = pw as f64 * 1.3 + hp_left as f64 * 0.9;
            match (mine, harm, help) {
                // attacking or removing: prefer the biggest threat, discounted by how hard it is to finish off
                (false, true, _) => 6.0 + val - hp_left as f64 * 0.3,
                (true, true, _) => -val,
                (true, false, true) => 5.0 + val,
                (false, false, true) => -val,
                (true, false, false) => 1.0 + val * 0.1,
                (false, false, false) => 0.5,
            }
        }
        // display/per-card choices and distribution have no cheap signal; stay neutral
        _ => 1.0,
    }
}

impl Policy for Greedy {
    fn new_game(&mut self, hello: &Hello) {
        self.rng.seed(hello.seed);
        self.round = 0;
        self.last_window_pick = None;
        self.cancelled.clear();
        self.picks.clear();
    }

    fn choose(&mut self, req: &Decide) -> usize {
        let p = &req.prompt;
        if req.state.round != self.round {
            self.round = req.state.round;
            self.cancelled.clear();
            self.picks.clear();
        }
        let prompt_key = format!("{}|{}|{}", p.signature, p.title.as_deref().unwrap_or(""), p.selected.len());
        let n = req.actions.len();
        let start = self.rng.below(n);
        let mut best = start;
        let mut best_score = f64::NEG_INFINITY;
        for k in 0..n {
            let i = (start + k) % n;
            let a = &req.actions[i];
            let key = action_key(a);
            let mut s = score(req, a);
            if p.action_window && self.cancelled.contains(&key) {
                s -= 50.0;
            }
            if self.picks.get(&format!("{prompt_key}|{key}")).copied().unwrap_or(0) >= MAX_REPEATS {
                s -= 100.0;
            }
            if s > best_score {
                best_score = s;
                best = i;
            }
        }
        let chosen = &req.actions[best];
        let key = action_key(chosen);
        if p.action_window {
            self.last_window_pick = Some(key.clone());
        } else if chosen.kind == "button" && chosen.label.eq_ignore_ascii_case("cancel") {
            if let Some(pick) = self.last_window_pick.take() {
                self.cancelled.insert(pick);
            }
        }
        *self.picks.entry(format!("{prompt_key}|{key}")).or_insert(0) += 1;
        best
    }
}

#[cfg(test)]
mod tests {
    use super::wanted;

    #[test]
    fn wanted_counts() {
        assert_eq!(wanted("select 2 cards to resource resource step"), 2);
        assert_eq!(wanted("select 1 card to resource"), 1);
        assert_eq!(wanted("choose up to 3 units"), 3);
        assert_eq!(wanted("select between 1 and 2 cards"), 2);
        assert_eq!(wanted("choose a unit to attack"), 1);
    }
}
