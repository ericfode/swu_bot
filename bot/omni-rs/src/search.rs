//! Bounded, perfect-information AND/OR proofs. Only action-window moves spend depth.
//!
//! Regroup is deliberately pessimistic for the prover: it commits its simultaneous
//! resource choice first, so the defender can observe it before choosing a reply.
//! Budgets are cumulative across both targets and all iterative-deepening passes.

use crate::{Action, Engine, Seat, State};
use serde::Serialize;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

/// Small adapter also permits adversarial tests of the proof algorithm itself.
pub trait Game {
    type Position: Copy + Eq;
    type Move;
    fn actor(&self, state: &Self::Position) -> Option<Seat>;
    fn terminal(&self, state: &Self::Position) -> bool;
    fn winner(&self, state: &Self::Position) -> Option<Seat>;
    fn window(&self, state: &Self::Position) -> bool;
    fn hash(&self, state: &Self::Position) -> u64;
    fn order_regroup(&self, state: &mut Self::Position, prover: Seat);
    fn actions(&self, state: &Self::Position) -> Vec<Self::Move>;
    /// A UI cancellation returns to the original window without committing a
    /// game action. Other choices from that window are already separate branches.
    fn cancels_uncommitted(&self, _state: &Self::Position, _action: &Self::Move) -> bool {
        false
    }
    fn apply(&self, state: &Self::Position, action: &Self::Move) -> Result<Self::Position, String>;
}

impl Game for Engine {
    type Position = State;
    type Move = Action;
    fn actor(&self, s: &State) -> Option<Seat> {
        s.actor()
    }
    fn terminal(&self, s: &State) -> bool {
        s.is_terminal()
    }
    fn winner(&self, s: &State) -> Option<Seat> {
        s.winner()
    }
    fn window(&self, s: &State) -> bool {
        s.is_action_window()
    }
    fn hash(&self, s: &State) -> u64 {
        s.zobrist()
    }
    fn order_regroup(&self, s: &mut State, p: Seat) {
        Engine::order_regroup(self, s, p);
    }
    fn actions(&self, s: &State) -> Vec<Action> {
        let mut actions = self.legal_actions(s);
        // Reordering only: no replies or targets are capped. Base attacks and
        // existing attackers are typically the shortest endgame proofs.
        actions.sort_by_key(|action| {
            if let Some(id) = action.id() {
                if s.players.iter().any(|p| p.base == id) {
                    return 0;
                }
                if s.players
                    .iter()
                    .any(|p| p.ground.contains(id) || p.space.contains(id))
                {
                    return 1;
                }
                if s.players.iter().any(|p| p.leader == id) {
                    return 2;
                }
                return 3;
            }
            if action.label == "Pass" {
                9
            } else {
                8
            }
        });
        actions
    }
    fn cancels_uncommitted(&self, s: &State, a: &Action) -> bool {
        use crate::model::Decision;
        a.kind == "button"
            && a.label == "Cancel"
            && match s.decision {
                Decision::LeaderMenu | Decision::NoEffect | Decision::AbilityMenu => true,
                Decision::AbilityNoEffect | Decision::AbilityTarget => {
                    !s.ability_committed && s.ability_return == 0
                }
                Decision::AttackTarget => !s.ambush,
                Decision::VaderBase => s.trigger_context == 0,
                _ => false,
            }
    }
    fn apply(&self, s: &State, a: &Action) -> Result<State, String> {
        Engine::apply(self, s, a)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub depth: u16,
    /// Number of action-window moves applied, including repeated iterative passes.
    pub nodes: Option<u64>,
    pub time: Option<Duration>,
    /// A bounded table prevents an unconstrained proof from exhausting memory.
    pub table_entries: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            depth: 12,
            nodes: None,
            time: None,
            table_entries: 16_384,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SolveResult {
    pub result: Option<Seat>,
    pub depth: u16,
    pub nodes: u64,
    pub decisions: u64,
    pub ms: f64,
    pub complete: bool,
    pub transpositions: u64,
}

#[derive(Clone, Copy)]
struct Entry<S> {
    state: S,
    proved: Option<u16>,
    disproved: Option<u16>,
}

enum Stop {
    Budget,
    Error(String),
}

#[derive(Clone, Copy)]
struct Verdict {
    win: bool,
    cycle: bool,
    skipped: bool,
}
impl Verdict {
    fn exact(win: bool) -> Self {
        Self {
            win,
            cycle: false,
            skipped: false,
        }
    }
}

pub struct Search<'a, G: Game> {
    game: &'a G,
    limits: Limits,
    start: Instant,
    nodes: u64,
    decisions: u64,
    hits: u64,
    // A hash hit is NEVER sufficient: semantic state equality is required. Hash
    // collisions replace a slot and only reduce performance, never soundness.
    table: HashMap<(u64, Seat), Entry<G::Position>>,
}

impl<'a, G: Game> Search<'a, G> {
    pub fn new(game: &'a G) -> Self {
        Self {
            game,
            limits: Limits::default(),
            start: Instant::now(),
            nodes: 0,
            decisions: 0,
            hits: 0,
            table: HashMap::new(),
        }
    }

    fn deadline(&self) -> Result<(), Stop> {
        if self
            .limits
            .time
            .is_some_and(|limit| self.start.elapsed() >= limit)
        {
            Err(Stop::Budget)
        } else {
            Ok(())
        }
    }

    fn visit(
        &mut self,
        mut state: G::Position,
        target: Seat,
        depth: u16,
        prompt_path: &mut Vec<G::Position>,
    ) -> Result<Verdict, Stop> {
        self.deadline()?;
        if self.game.terminal(&state) {
            return Ok(Verdict::exact(self.game.winner(&state) == Some(target)));
        }
        let window = self.game.window(&state);
        // Prompts caused by the last permitted window must still finish. A target
        // or trigger can deliver lethal after depth has reached zero.
        if window && depth == 0 {
            return Ok(Verdict::exact(false));
        }
        self.game.order_regroup(&mut state, target);
        let actor = self
            .game
            .actor(&state)
            .ok_or_else(|| Stop::Error("nonterminal state has no actor".into()))?;
        let key = (self.game.hash(&state), target);
        if let Some(hit) = self.table.get(&key).filter(|hit| hit.state == state) {
            if hit.proved.is_some_and(|d| d <= depth) {
                self.hits += 1;
                return Ok(Verdict::exact(true));
            }
            if hit.disproved.is_some_and(|d| d >= depth) {
                self.hits += 1;
                return Ok(Verdict::exact(false));
            }
        }
        // Menus can select/unselect forever. They represent a finite choice of
        // eventual committed outcomes, not a legal strategy to stall the game.
        // Enumerate every simple prompt path; never cache a result that depends
        // on excluding an ancestor (positive OR negative).
        if !window && prompt_path.contains(&state) {
            return Ok(Verdict {
                win: false,
                cycle: true,
                skipped: true,
            });
        }
        if !window {
            prompt_path.push(state);
        }
        let actions = self.game.actions(&state);
        if actions.is_empty() {
            return Err(Stop::Error("nonterminal state has no legal actions".into()));
        }
        let is_or = actor == target;
        let mut result = !is_or;
        let mut cycle = false;
        let mut any = false;
        for action in actions {
            self.deadline()?;
            if self.game.cancels_uncommitted(&state, &action) {
                continue;
            }
            if window {
                if self.limits.nodes.is_some_and(|limit| self.nodes >= limit) {
                    return Err(Stop::Budget);
                }
                self.nodes += 1;
            }
            self.decisions += 1;
            let child = self.game.apply(&state, &action).map_err(Stop::Error)?;
            // Some engine menus expose rejected clicks in their selectable set.
            // Preserve these in differential checking, but they are not moves.
            if !window && child == state {
                cycle = true;
                continue;
            }
            let good = if window {
                // Prompt-cycle checks cover only the segment between windows.
                self.visit(child, target, depth - 1, &mut Vec::new())?
            } else {
                self.visit(child, target, depth, prompt_path)?
            };
            cycle |= good.cycle;
            if good.skipped {
                continue;
            }
            any = true;
            if good.win == is_or {
                result = good.win;
                break;
            }
        }
        if !window {
            prompt_path.pop();
        }
        // No partially searched node reaches this point on cancellation/error.
        if self.limits.table_entries > 0 && !cycle && any {
            let previous = self.table.get(&key).filter(|e| e.state == state).copied();
            let mut entry = previous.unwrap_or(Entry {
                state,
                proved: None,
                disproved: None,
            });
            if result {
                entry.proved = Some(entry.proved.map_or(depth, |d| d.min(depth)));
            } else {
                entry.disproved = Some(entry.disproved.map_or(depth, |d| d.max(depth)));
            }
            if self.table.len() < self.limits.table_entries || self.table.contains_key(&key) {
                self.table.insert(key, entry);
            }
        }
        Ok(Verdict {
            win: any && result,
            cycle,
            skipped: !any,
        })
    }

    pub fn solve(&mut self, state: G::Position, limits: Limits) -> Result<SolveResult, String> {
        self.limits = limits;
        self.start = Instant::now();
        self.nodes = 0;
        self.decisions = 0;
        self.hits = 0;
        self.table.clear();
        let first = self.game.actor(&state).unwrap_or(Seat::P1);
        let mut completed_depth = 0;
        if self.game.terminal(&state) {
            return Ok(self.result(self.game.winner(&state), 0, true));
        }
        for depth in 1..=limits.depth {
            for target in [first, first.other()] {
                match self.visit(state, target, depth, &mut Vec::new()) {
                    Ok(Verdict { win: true, .. }) => {
                        return Ok(self.result(Some(target), depth, true))
                    }
                    Ok(Verdict { win: false, .. }) => (),
                    Err(Stop::Budget) => return Ok(self.result(None, completed_depth, false)),
                    Err(Stop::Error(error)) => return Err(error),
                }
            }
            completed_depth = depth;
        }
        Ok(self.result(None, completed_depth, true))
    }

    fn result(&self, result: Option<Seat>, depth: u16, complete: bool) -> SolveResult {
        SolveResult {
            result,
            depth,
            nodes: self.nodes,
            decisions: self.decisions,
            ms: self.start.elapsed().as_secs_f64() * 1_000.,
            complete,
            transpositions: self.hits,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone)]
    struct Node {
        actor: Seat,
        window: bool,
        terminal: bool,
        winner: Option<Seat>,
        children: Vec<usize>,
    }
    struct Tiny {
        nodes: Vec<Node>,
        collide: bool,
        regroup: bool,
    }
    impl Game for Tiny {
        type Position = usize;
        type Move = usize;
        fn actor(&self, s: &usize) -> Option<Seat> {
            Some(self.nodes[*s].actor)
        }
        fn terminal(&self, s: &usize) -> bool {
            self.nodes[*s].terminal
        }
        fn winner(&self, s: &usize) -> Option<Seat> {
            self.nodes[*s].winner
        }
        fn window(&self, s: &usize) -> bool {
            self.nodes[*s].window
        }
        fn hash(&self, s: &usize) -> u64 {
            if self.collide {
                0
            } else {
                *s as u64
            }
        }
        fn order_regroup(&self, s: &mut usize, p: Seat) {
            if self.regroup && *s == 1 && p == Seat::P2 {
                *s = 4;
            }
        }
        fn actions(&self, s: &usize) -> Vec<usize> {
            self.nodes[*s].children.clone()
        }
        fn cancels_uncommitted(&self, _: &usize, action: &usize) -> bool {
            *action == 99
        }
        fn apply(&self, _: &usize, a: &usize) -> Result<usize, String> {
            Ok(*a)
        }
    }
    fn node(actor: Seat, window: bool, children: &[usize]) -> Node {
        Node {
            actor,
            window,
            terminal: false,
            winner: None,
            children: children.to_vec(),
        }
    }
    fn win(winner: Option<Seat>) -> Node {
        Node {
            terminal: true,
            winner,
            ..node(Seat::P1, false, &[])
        }
    }
    fn run(nodes: Vec<Node>, depth: u16, budget: Option<u64>, collide: bool) -> SolveResult {
        Search::new(&Tiny {
            nodes,
            collide,
            regroup: false,
        })
        .solve(
            0,
            Limits {
                depth,
                nodes: budget,
                ..Limits::default()
            },
        )
        .unwrap()
    }

    #[test]
    fn target_prompt_can_deliver_lethal_at_depth_zero() {
        let r = run(
            vec![
                node(Seat::P1, true, &[1]),
                node(Seat::P1, false, &[2, 3]),
                win(Some(Seat::P2)),
                win(Some(Seat::P1)),
            ],
            1,
            None,
            false,
        );
        assert_eq!(r.result, Some(Seat::P1));
        assert_eq!((r.depth, r.nodes, r.decisions), (1, 1, 3));
    }

    #[test]
    fn defender_subchoices_are_all_checked() {
        let r = run(
            vec![
                node(Seat::P1, true, &[1]),
                node(Seat::P2, false, &[2, 3]),
                win(Some(Seat::P1)),
                win(Some(Seat::P2)),
            ],
            1,
            None,
            false,
        );
        assert_eq!(r.result, Some(Seat::P2));
    }

    #[test]
    fn draw_is_not_a_win_for_either_side() {
        let r = run(vec![node(Seat::P1, true, &[1]), win(None)], 3, None, false);
        assert_eq!(r.result, None);
        assert!(r.complete);
    }

    #[test]
    fn limit_is_shared_by_targets_and_depths_and_never_proves_unvisited_replies() {
        let r = run(
            vec![
                node(Seat::P2, true, &[1, 2]),
                win(Some(Seat::P1)),
                node(Seat::P1, true, &[1]),
            ],
            3,
            Some(1),
            false,
        );
        assert_eq!(r.result, None);
        assert_eq!((r.depth, r.nodes), (0, 1));
        assert!(!r.complete);
    }

    #[test]
    fn zero_budget_is_incomplete_without_visiting_a_move() {
        let r = run(
            vec![node(Seat::P1, true, &[1]), win(Some(Seat::P1))],
            3,
            Some(0),
            false,
        );
        assert_eq!(r.nodes, 0);
        assert!(!r.complete);
        assert_eq!(r.result, None);
    }

    #[test]
    fn side_to_move_is_proved_first() {
        let r = run(
            vec![node(Seat::P2, true, &[1]), win(Some(Seat::P2))],
            1,
            Some(1),
            false,
        );
        assert_eq!(r.result, Some(Seat::P2));
        assert!(r.complete);
    }

    #[test]
    fn zobrist_collisions_cannot_turn_a_defender_escape_into_a_proof() {
        // Both prompt states hash alike. First is winning for p1; second has
        // a defender escape. A table keyed only by hash falsely proves p1.
        let r = run(
            vec![
                node(Seat::P2, true, &[1, 2]),
                node(Seat::P1, false, &[3]),
                node(Seat::P1, false, &[4]),
                win(Some(Seat::P1)),
                win(Some(Seat::P2)),
            ],
            2,
            None,
            true,
        );
        assert_eq!(r.result, Some(Seat::P2));
    }

    #[test]
    fn iterative_depth_counts_both_players_windows() {
        let nodes = vec![
            node(Seat::P1, true, &[1]),
            node(Seat::P2, true, &[2]),
            win(Some(Seat::P1)),
        ];
        assert_eq!(run(nodes.clone(), 1, None, false).result, None);
        assert_eq!(run(nodes, 2, None, false).depth, 2);
    }

    #[test]
    fn elapsed_budget_interrupts_without_claiming_a_win() {
        let game = Tiny {
            nodes: vec![node(Seat::P1, true, &[1]), win(Some(Seat::P1))],
            collide: false,
            regroup: false,
        };
        let r = Search::new(&game)
            .solve(
                0,
                Limits {
                    time: Some(Duration::ZERO),
                    ..Limits::default()
                },
            )
            .unwrap();
        assert_eq!(r.result, None);
        assert!(!r.complete);
    }

    #[test]
    fn optional_prompt_cycles_do_not_hide_a_finite_win() {
        let game = Tiny {
            nodes: vec![
                node(Seat::P1, true, &[1]),
                node(Seat::P1, false, &[1, 2]),
                win(Some(Seat::P1)),
            ],
            collide: false,
            regroup: false,
        };
        assert_eq!(
            Search::new(&game)
                .solve(0, Limits::default())
                .unwrap()
                .result,
            Some(Seat::P1)
        );
    }

    #[test]
    fn menus_with_only_loops_do_not_vacuously_prove_a_win() {
        let game = Tiny {
            nodes: vec![node(Seat::P1, true, &[1]), node(Seat::P1, false, &[1])],
            collide: false,
            regroup: false,
        };
        assert_eq!(
            Search::new(&game)
                .solve(0, Limits::default())
                .unwrap()
                .result,
            None
        );
    }

    #[test]
    fn resource_selection_switches_reach_every_committed_choice() {
        // 1 = nothing selected, 2 = first resource selected, 3 = second selected.
        // A defender can switch from first to second before committing.
        let nodes = vec![
            node(Seat::P1, true, &[1]),
            node(Seat::P2, false, &[2, 3]),
            node(Seat::P2, false, &[1, 3, 4]),
            node(Seat::P2, false, &[1, 2, 5]),
            win(Some(Seat::P1)),
            win(Some(Seat::P2)),
        ];
        assert_eq!(run(nodes, 1, None, false).result, Some(Seat::P2));
    }

    #[test]
    fn cycle_dependent_positive_prompt_results_are_not_cached() {
        // B appears winning while ancestor A is excluded, but A has a losing
        // commit. Reusing that positive result from another path is unsound.
        let nodes = vec![
            node(Seat::P1, true, &[1, 2]),
            node(Seat::P2, false, &[2, 3]),
            node(Seat::P2, false, &[1, 4]),
            win(Some(Seat::P2)),
            win(Some(Seat::P1)),
        ];
        assert_eq!(run(nodes, 1, None, false).result, Some(Seat::P2));
    }

    #[test]
    fn simultaneous_choices_give_the_defender_the_second_choice() {
        // The second chooser can always beat the first. Neither side has a
        // sound proof when the simultaneous choice is pessimistically ordered.
        let game = Tiny {
            nodes: vec![
                node(Seat::P1, true, &[1]),
                node(Seat::P1, false, &[2, 3]),
                node(Seat::P2, false, &[7, 8]),
                node(Seat::P2, false, &[8, 7]),
                node(Seat::P2, false, &[5, 6]),
                node(Seat::P1, false, &[7, 8]),
                node(Seat::P1, false, &[8, 7]),
                win(Some(Seat::P1)),
                win(Some(Seat::P2)),
            ],
            collide: false,
            regroup: true,
        };
        let result = Search::new(&game)
            .solve(
                0,
                Limits {
                    depth: 1,
                    ..Limits::default()
                },
            )
            .unwrap();
        assert_eq!(result.result, None);
        assert!(result.complete);
    }

    #[test]
    fn defender_target_cancellation_does_not_become_a_stalling_reply() {
        let nodes = vec![
            node(Seat::P2, true, &[1]),
            node(Seat::P2, false, &[99, 2]),
            win(Some(Seat::P1)),
        ];
        assert_eq!(run(nodes, 1, None, false).result, Some(Seat::P1));
    }

    #[test]
    fn compiled_ability_cancellation_is_skipped_only_before_commitment() {
        use crate::model::Decision;
        let pool: serde_json::Value =
            serde_json::from_str(include_str!("../../omni/rs/pool.json")).unwrap();
        let engine = Engine::from_pool_value(&pool).unwrap();
        let cancel = Action::button("Cancel", "cancel");
        let mut state = State::default();
        for decision in [
            Decision::AbilityMenu,
            Decision::AbilityTarget,
            Decision::AbilityNoEffect,
        ] {
            state.decision = decision;
            assert!(engine.cancels_uncommitted(&state, &cancel));
        }
        state.decision = Decision::AbilityTarget;
        state.ability_committed = true;
        assert!(!engine.cancels_uncommitted(&state, &cancel));
        state.ability_committed = false;
        state.ability_return = 1;
        assert!(!engine.cancels_uncommitted(&state, &cancel));
        state.decision = Decision::AbilityOptional;
        assert!(!engine.cancels_uncommitted(&state, &Action::button("Pass", "pass")));
    }

    #[test]
    fn real_action_window_loops_consume_depth_instead_of_being_skipped() {
        let nodes = vec![node(Seat::P2, true, &[0, 1]), win(Some(Seat::P1))];
        assert_eq!(run(nodes, 3, None, false).result, None);
    }
}
