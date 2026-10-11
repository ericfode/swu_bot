import SwuTheory.Prelude

/-!
# The game model

One SWU game, seen by an omniscient observer for one fixed deal, is a finite-horizon two-player
zero-sum game with chance:

* a state `s` holds everything: both decks in order, hands, board, resources, the engine RNG
  position, whose prompt it is;
* `kind s` says who acts: player 1 (`max`), player 2 (`min`), the shuffler (`chance`), or nobody
  (`terminal`, the game is over);
* `Act s` is the finite, nonempty set of moves at `s` (for a chance node: the possible results);
* `payoff s` is the result for player 1 at a terminal state (for example `1` win, `0` loss);
* `height s` bounds how many moves are left. Every move lowers it. This is the "every SWU game
  ends" assumption (`height_lt`); it is not proven from the card rules.

Values are in `ℚ`: SWU shuffles and random picks are uniform over finite sets, so every
probability is rational.

The second half of the file proves the fixed-point facts once, for any "local" backup operator
`B`. Both the optimal value (`Value.lean`) and the value of fixed policies (`Policy.lean`) are
instances.
-/

namespace Swu

/-- Who acts at a state. -/
inductive Kind where
  | terminal
  | max
  | min
  | chance
  deriving DecidableEq

/-- A finite-horizon two-player zero-sum game with chance (perfect information). -/
structure Game where
  /-- Full game states. -/
  S : Type
  /-- Moves (or chance results) at a state. -/
  Act : S → Type
  [fin : ∀ s, Fintype (Act s)]
  [ne : ∀ s, Nonempty (Act s)]
  /-- Who acts at a state. -/
  kind : S → Kind
  /-- The state after a move. -/
  next : (s : S) → Act s → S
  /-- Probability of each result at a chance node (ignored elsewhere). -/
  prob : (s : S) → Act s → ℚ
  /-- Result for player 1 at a terminal state (ignored elsewhere). -/
  payoff : S → ℚ
  /-- Upper bound on the number of moves left. -/
  height : S → ℕ
  /-- Every move makes progress: the game always ends. -/
  height_lt : ∀ s a, kind s ≠ .terminal → height (next s a) < height s
  prob_nonneg : ∀ s a, kind s = .chance → 0 ≤ prob s a
  prob_sum : ∀ s, kind s = .chance → ∑ a, prob s a = 1

attribute [instance] Game.fin Game.ne

namespace Game

variable (G : Game)

/-- A state with no moves left must be terminal. -/
theorem terminal_of_height_zero {s : G.S} (h : G.height s = 0) : G.kind s = .terminal := by
  by_contra ht
  have := G.height_lt s (Classical.arbitrary _) ht
  omega

theorem height_pos {s : G.S} (ht : G.kind s ≠ .terminal) : 0 < G.height s := by
  have := G.height_lt s (Classical.arbitrary _) ht
  omega

/-! ## Local backup operators and their fixed points -/

/-- `B f s` depends only on the values of `f` at the children of `s`. -/
def Local (B : (G.S → ℚ) → G.S → ℚ) : Prop :=
  ∀ f g s, (∀ a, f (G.next s a) = g (G.next s a)) → B f s = B g s

/-- At a terminal state `B` returns the payoff. -/
def Terminal (B : (G.S → ℚ) → G.S → ℚ) : Prop :=
  ∀ f s, G.kind s = .terminal → B f s = G.payoff s

/-- A set of states that is closed under moves (for example: every state reachable from
a start state). -/
def Closed (P : G.S → Prop) : Prop :=
  ∀ s, P s → G.kind s ≠ .terminal → ∀ a, P (G.next s a)

/-- Depth-limited lookahead: back up `n` times from the leaf evaluator `h`.
Terminal states always score their payoff. -/
def iter (B : (G.S → ℚ) → G.S → ℚ) (h : G.S → ℚ) : ℕ → G.S → ℚ
  | 0, s => if G.kind s = .terminal then G.payoff s else h s
  | n + 1, s => B (iter B h n) s

/-- The value defined by `B`: look ahead all the way to the end of the game. -/
def fix (B : (G.S → ℚ) → G.S → ℚ) (s : G.S) : ℚ :=
  G.iter B (fun _ => 0) (G.height s) s

variable {G} {B : (G.S → ℚ) → G.S → ℚ}

theorem iter_terminal (hT : G.Terminal B) {h : G.S → ℚ} {s : G.S} (ht : G.kind s = .terminal) :
    ∀ n, G.iter B h n s = G.payoff s
  | 0 => by simp [iter, ht]
  | n + 1 => hT _ _ ht

/-- Once the lookahead reaches the end of the game, the leaf evaluator no longer matters and
deeper lookahead changes nothing. -/
theorem iter_stable (hB : G.Local B) (hT : G.Terminal B) (h h' : G.S → ℚ) :
    ∀ n m s, G.height s ≤ n → G.height s ≤ m → G.iter B h n s = G.iter B h' m s := by
  intro n
  induction n with
  | zero =>
    intro m s hn _
    have ht := G.terminal_of_height_zero (by omega : G.height s = 0)
    rw [iter_terminal hT ht, iter_terminal hT ht]
  | succ k ih =>
    intro m s hn hm
    by_cases ht : G.kind s = .terminal
    · rw [iter_terminal hT ht, iter_terminal hT ht]
    · cases m with
      | zero => exact absurd (G.terminal_of_height_zero (by omega)) ht
      | succ j =>
        apply hB
        intro a
        have := G.height_lt s a ht
        exact ih j (G.next s a) (by omega) (by omega)

theorem fix_eq_iter (hB : G.Local B) (hT : G.Terminal B) (h : G.S → ℚ) {n : ℕ} {s : G.S}
    (hn : G.height s ≤ n) : G.iter B h n s = G.fix B s :=
  iter_stable hB hT _ _ _ _ _ hn le_rfl

/-- **Bellman equation.** The value is consistent with one step of lookahead. -/
theorem fix_bellman (hB : G.Local B) (hT : G.Terminal B) (s : G.S) :
    G.fix B s = B (G.fix B) s := by
  by_cases ht : G.kind s = .terminal
  · rw [fix, iter_terminal hT ht, hT _ _ ht]
  · obtain ⟨k, hk⟩ : ∃ k, G.height s = k + 1 := ⟨G.height s - 1, by
      have := G.height_pos ht; omega⟩
    show G.iter B (fun _ => 0) (G.height s) s = _
    rw [hk]
    apply hB
    intro a
    have := G.height_lt s a ht
    exact fix_eq_iter hB hT _ (s := G.next s a) (by omega)

/-- **Uniqueness on a closed set.** Any function that satisfies the Bellman equation on a set
of states closed under moves equals the value there. -/
theorem fix_unique_on (hB : G.Local B) (hT : G.Terminal B) {P : G.S → Prop} (hP : G.Closed P)
    {f : G.S → ℚ} (hf : ∀ s, P s → f s = B f s) : ∀ s, P s → f s = G.fix B s := by
  suffices ∀ n s, G.height s = n → P s → f s = G.fix B s from fun s => this _ s rfl
  intro n
  induction n using Nat.strong_induction_on with
  | _ n ih =>
    intro s hn hs
    rw [hf s hs, fix_bellman hB hT s]
    by_cases ht : G.kind s = .terminal
    · rw [hT _ _ ht, hT _ _ ht]
    · apply hB
      intro a
      exact ih _ (hn ▸ G.height_lt s a ht) _ rfl (hP s hs ht a)

/-- **Uniqueness.** The value is the only function that satisfies the Bellman equation. -/
theorem fix_unique (hB : G.Local B) (hT : G.Terminal B) {f : G.S → ℚ}
    (hf : ∀ s, f s = B f s) (s : G.S) : f s = G.fix B s :=
  fix_unique_on hB hT (P := fun _ => True) (fun _ _ _ _ => trivial) (fun s _ => hf s) s trivial

/-- Lower bound by induction on the moves left: if `B` keeps `g` below it whenever the
children are above `g`, then the value is above `g`. -/
theorem le_fix_of (hB : G.Local B) (hT : G.Terminal B) {g : G.S → ℚ}
    (hg : ∀ s f, (G.kind s ≠ .terminal → ∀ a, g (G.next s a) ≤ f (G.next s a)) → g s ≤ B f s)
    (s : G.S) : g s ≤ G.fix B s := by
  suffices ∀ n s, G.height s = n → g s ≤ G.fix B s from this _ s rfl
  intro n
  induction n using Nat.strong_induction_on with
  | _ n ih =>
    intro s hn
    rw [fix_bellman hB hT s]
    exact hg s _ fun ht a => ih _ (hn ▸ G.height_lt s a ht) _ rfl

/-- Upper bound, the mirror of `le_fix_of`. -/
theorem fix_le_of (hB : G.Local B) (hT : G.Terminal B) {g : G.S → ℚ}
    (hg : ∀ s f, (G.kind s ≠ .terminal → ∀ a, f (G.next s a) ≤ g (G.next s a)) → B f s ≤ g s)
    (s : G.S) : G.fix B s ≤ g s := by
  suffices ∀ n s, G.height s = n → G.fix B s ≤ g s from this _ s rfl
  intro n
  induction n using Nat.strong_induction_on with
  | _ n ih =>
    intro s hn
    rw [fix_bellman hB hT s]
    exact hg s _ fun ht a => ih _ (hn ▸ G.height_lt s a ht) _ rfl

end Game

end Swu
