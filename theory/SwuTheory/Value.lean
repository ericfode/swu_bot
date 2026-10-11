import SwuTheory.Game

/-!
# The true value of a position, and lookahead search

`value s` is what player 1 gets from `s` when both players play perfectly and shuffles fall
at random: the expectiminimax value. With payoff `1` = win and `0` = loss it is player 1's
win probability under perfect play.

`search h n s` is what a depth-`n` expectiminimax search returns when it scores its leaves with
the evaluator `h`. This is what the omni bot and the heuristic lookahead bots compute.
-/

namespace Swu
namespace Game

open Finset

variable (G : Game)

/-- One step of perfect play: player 1 takes the best child, player 2 the worst, chance
averages. -/
def backup (f : G.S → ℚ) (s : G.S) : ℚ :=
  match G.kind s with
  | .terminal => G.payoff s
  | .max => univ.sup' univ_nonempty (fun a => f (G.next s a))
  | .min => univ.inf' univ_nonempty (fun a => f (G.next s a))
  | .chance => ∑ a, G.prob s a * f (G.next s a)

/-- The true (expectiminimax) value of a position. -/
def value : G.S → ℚ := G.fix G.backup

/-- Depth-`n` expectiminimax search with leaf evaluator `h`. -/
def search (h : G.S → ℚ) (n : ℕ) : G.S → ℚ := G.iter G.backup h n

variable {G}

theorem backup_local : G.Local G.backup := by
  intro f g s hfg
  cases hk : G.kind s <;> simp only [backup, hk, hfg]

theorem backup_terminal : G.Terminal G.backup := by
  intro f s ht
  simp only [backup, ht]

theorem backup_max {f : G.S → ℚ} {s : G.S} (hk : G.kind s = .max) :
    G.backup f s = univ.sup' univ_nonempty (fun a => f (G.next s a)) := by
  simp only [backup, hk]

theorem backup_min {f : G.S → ℚ} {s : G.S} (hk : G.kind s = .min) :
    G.backup f s = univ.inf' univ_nonempty (fun a => f (G.next s a)) := by
  simp only [backup, hk]

theorem backup_chance {f : G.S → ℚ} {s : G.S} (hk : G.kind s = .chance) :
    G.backup f s = ∑ a, G.prob s a * f (G.next s a) := by
  simp only [backup, hk]

/-! ## The value exists and is unique -/

/-- **Bellman equation** for the true value. -/
theorem value_bellman (s : G.S) : G.value s = G.backup G.value s :=
  fix_bellman backup_local backup_terminal s

/-- **Uniqueness.** The true value is the only evaluator that agrees with its own one-step
lookahead everywhere (terminal states included, where the lookahead is the payoff). -/
theorem value_unique {f : G.S → ℚ} (hf : ∀ s, f s = G.backup f s) (s : G.S) :
    f s = G.value s :=
  fix_unique backup_local backup_terminal hf s

theorem value_terminal {s : G.S} (ht : G.kind s = .terminal) : G.value s = G.payoff s := by
  rw [value_bellman, backup_terminal _ _ ht]

/-! ## Basic facts about one step of lookahead -/

/-- A move by move comparison of `f` and `g` carries over to the backup. -/
theorem backup_mono {f g : G.S → ℚ} {s : G.S}
    (hfg : G.kind s ≠ .terminal → ∀ a, f (G.next s a) ≤ g (G.next s a)) :
    G.backup f s ≤ G.backup g s := by
  cases hk : G.kind s
  · rw [backup_terminal _ _ hk, backup_terminal _ _ hk]
  · have h := hfg (by simp [hk])
    rw [backup_max hk, backup_max hk]
    exact sup'_le _ _ fun a _ => (h a).trans (le_sup' (fun a => g (G.next s a)) (mem_univ a))
  · have h := hfg (by simp [hk])
    rw [backup_min hk, backup_min hk]
    exact le_inf' _ _ fun a _ => (inf'_le (fun a => f (G.next s a)) (mem_univ a)).trans (h a)
  · have h := hfg (by simp [hk])
    rw [backup_chance hk, backup_chance hk]
    exact sum_le_sum fun a _ => mul_le_mul_of_nonneg_left (h a) (G.prob_nonneg s a hk)

/-- One step of lookahead never makes a uniform error bigger (it is 1-Lipschitz in the
max norm): max, min and averages all keep the error within `ε`. -/
theorem backup_lipschitz {f g : G.S → ℚ} {s : G.S} {ε : ℚ} (hε : 0 ≤ ε)
    (hfg : G.kind s ≠ .terminal → ∀ a, |f (G.next s a) - g (G.next s a)| ≤ ε) :
    |G.backup f s - G.backup g s| ≤ ε := by
  cases hk : G.kind s
  · rw [backup_terminal _ _ hk, backup_terminal _ _ hk, sub_self, abs_zero]; exact hε
  · have h := hfg (by simp [hk])
    rw [backup_max hk, backup_max hk, abs_sub_le_iff]
    constructor
    · rw [sub_le_iff_le_add]
      refine sup'_le _ _ fun a _ => ?_
      have h1 := (abs_sub_le_iff.1 (h a)).1
      have h2 : g (G.next s a) ≤ univ.sup' univ_nonempty (fun a => g (G.next s a)) :=
        le_sup' (fun a => g (G.next s a)) (mem_univ a)
      linarith
    · rw [sub_le_iff_le_add]
      refine sup'_le _ _ fun a _ => ?_
      have h1 := (abs_sub_le_iff.1 (h a)).2
      have h2 : f (G.next s a) ≤ univ.sup' univ_nonempty (fun a => f (G.next s a)) :=
        le_sup' (fun a => f (G.next s a)) (mem_univ a)
      linarith
  · have h := hfg (by simp [hk])
    rw [backup_min hk, backup_min hk, abs_sub_le_iff]
    have hf' : univ.inf' univ_nonempty (fun a => f (G.next s a)) - ε ≤
        univ.inf' univ_nonempty (fun a => g (G.next s a)) :=
      le_inf' _ _ fun a _ => by
        have h1 := (abs_sub_le_iff.1 (h a)).1
        have h2 : univ.inf' univ_nonempty (fun a => f (G.next s a)) ≤ f (G.next s a) :=
          inf'_le (fun a => f (G.next s a)) (mem_univ a)
        linarith
    have hg' : univ.inf' univ_nonempty (fun a => g (G.next s a)) - ε ≤
        univ.inf' univ_nonempty (fun a => f (G.next s a)) :=
      le_inf' _ _ fun a _ => by
        have h1 := (abs_sub_le_iff.1 (h a)).2
        have h2 : univ.inf' univ_nonempty (fun a => g (G.next s a)) ≤ g (G.next s a) :=
          inf'_le (fun a => g (G.next s a)) (mem_univ a)
        linarith
    constructor <;> linarith
  · have h := hfg (by simp [hk])
    rw [backup_chance hk, backup_chance hk, ← sum_sub_distrib]
    calc |∑ a, (G.prob s a * f (G.next s a) - G.prob s a * g (G.next s a))|
        ≤ ∑ a, |G.prob s a * f (G.next s a) - G.prob s a * g (G.next s a)| :=
          abs_sum_le_sum_abs _ _
      _ ≤ ∑ a, G.prob s a * ε := by
          refine sum_le_sum fun a _ => ?_
          rw [← mul_sub, abs_mul, abs_of_nonneg (G.prob_nonneg s a hk)]
          exact mul_le_mul_of_nonneg_left (h a) (G.prob_nonneg s a hk)
      _ = ε := by rw [← sum_mul, G.prob_sum s hk, one_mul]

/-! ## Search -/

/-- **Endgame solving.** If the search reaches the end of the game, it returns the true value
whatever the evaluator. This is the exact endgame prover. -/
theorem search_exact (h : G.S → ℚ) {n : ℕ} {s : G.S} (hn : G.height s ≤ n) :
    G.search h n s = G.value s :=
  fix_eq_iter backup_local backup_terminal h hn

/-- **A perfect evaluator gains nothing from search.** Searching any depth with the true value
at the leaves returns the true value. -/
theorem search_value (n : ℕ) (s : G.S) : G.search G.value n s = G.value s := by
  induction n generalizing s with
  | zero =>
    show (if G.kind s = .terminal then G.payoff s else G.value s) = G.value s
    split_ifs with ht
    · exact (value_terminal ht).symm
    · rfl
  | succ n ih =>
    show G.backup (G.search G.value n) s = G.value s
    rw [value_bellman s]
    exact backup_local _ _ _ fun a => ih _

/-- **Search does not amplify evaluator error.** If the leaf evaluator is within `ε` of the
true value everywhere, every depth of search is within `ε` too. -/
theorem search_error {h : G.S → ℚ} {ε : ℚ} (hh : ∀ t, |h t - G.value t| ≤ ε) (n : ℕ)
    (s : G.S) : |G.search h n s - G.value s| ≤ ε := by
  have hε : 0 ≤ ε := (abs_nonneg _).trans (hh s)
  induction n generalizing s with
  | zero =>
    show |(if G.kind s = .terminal then G.payoff s else h s) - G.value s| ≤ ε
    split_ifs with ht
    · rw [value_terminal ht, sub_self, abs_zero]; exact hε
    · exact hh s
  | succ n ih =>
    show |G.backup (G.search h n) s - G.value s| ≤ ε
    rw [value_bellman s]
    exact backup_lipschitz hε fun _ a => ih _

/-- **Search keeps an optimistic evaluator optimistic** (and, by the same proof with the
inequalities reversed, a pessimistic one pessimistic). -/
theorem search_ge_value {h : G.S → ℚ} (hh : ∀ t, G.value t ≤ h t) (n : ℕ) (s : G.S) :
    G.value s ≤ G.search h n s := by
  induction n generalizing s with
  | zero =>
    show G.value s ≤ if G.kind s = .terminal then G.payoff s else h s
    split_ifs with ht
    · exact (value_terminal ht).le
    · exact hh s
  | succ n ih =>
    show G.value s ≤ G.backup (G.search h n) s
    rw [value_bellman s]
    exact backup_mono fun _ a => ih _

/-! ## Range of the value -/

/-- If every payoff lies in `[lo, hi]`, so does every value. With win = 1 and loss = 0 the
value is a probability. -/
theorem value_mem_Icc {lo hi : ℚ} (hp : ∀ s, G.kind s = .terminal → lo ≤ G.payoff s ∧ G.payoff s ≤ hi)
    (s : G.S) : lo ≤ G.value s ∧ G.value s ≤ hi := by
  constructor
  · refine le_fix_of (g := fun _ => lo) backup_local backup_terminal (fun s f hf => ?_) s
    by_cases ht : G.kind s = .terminal
    · rw [backup_terminal _ _ ht]; exact (hp s ht).1
    · calc lo = G.backup (fun _ => lo) s := by
            cases hk : G.kind s
            · exact absurd hk ht
            · simp only [backup_max hk, sup'_const]
            · simp only [backup_min hk, inf'_const]
            · simp only [backup_chance hk, ← sum_mul, G.prob_sum s hk, one_mul]
        _ ≤ G.backup f s := backup_mono hf
  · refine fix_le_of (g := fun _ => hi) backup_local backup_terminal (fun s f hf => ?_) s
    by_cases ht : G.kind s = .terminal
    · rw [backup_terminal _ _ ht]; exact (hp s ht).2
    · calc G.backup f s ≤ G.backup (fun _ => hi) s := backup_mono hf
        _ = hi := by
            cases hk : G.kind s
            · exact absurd hk ht
            · simp only [backup_max hk, sup'_const]
            · simp only [backup_min hk, inf'_const]
            · simp only [backup_chance hk, ← sum_mul, G.prob_sum s hk, one_mul]

/-! ## Self-consistency error bounds the true error -/

/-- **TD residual bound.** Suppose that on a closed set of positions the one-step lookahead of
the evaluator `h` disagrees with `h` by at most `ε` (at terminal states the lookahead is the
payoff, so `h` is within `ε` of the result there). Then `h` is within `ε × (moves left + 1)` of
the true value on that set.

So driving the self-consistency (TD) error to zero drives the evaluator to the true value,
and the error left over grows at most linearly with the distance to the end of the game. -/
theorem residual_bound_on {P : G.S → Prop} (hP : G.Closed P) {h : G.S → ℚ} {ε : ℚ}
    (hε : 0 ≤ ε) (hres : ∀ s, P s → |h s - G.backup h s| ≤ ε) :
    ∀ s, P s → |h s - G.value s| ≤ ε * (G.height s + 1) := by
  suffices ∀ n s, G.height s = n → P s → |h s - G.value s| ≤ ε * (G.height s + 1) from
    fun s => this _ s rfl
  intro n
  induction n using Nat.strong_induction_on with
  | _ n ih =>
    intro s hn hs
    have hchild : G.kind s ≠ .terminal →
        ∀ a, |h (G.next s a) - G.value (G.next s a)| ≤ ε * G.height s := by
      intro ht a
      have hlt := G.height_lt s a ht
      refine (ih _ (hn ▸ hlt) _ rfl (hP s hs ht a)).trans (mul_le_mul_of_nonneg_left ?_ hε)
      have : (G.height (G.next s a) : ℚ) + 1 ≤ G.height s := by exact_mod_cast hlt
      exact this
    have hb := backup_lipschitz (s := s) (f := h) (g := G.value)
      (mul_nonneg hε (Nat.cast_nonneg _)) hchild
    rw [value_bellman s]
    calc |h s - G.backup G.value s|
        ≤ |h s - G.backup h s| + |G.backup h s - G.backup G.value s| := abs_sub_le _ _ _
      _ ≤ ε + ε * G.height s := add_le_add (hres s hs) hb
      _ = ε * (G.height s + 1) := by ring

/-- `residual_bound_on` for all positions. -/
theorem residual_bound {h : G.S → ℚ} {ε : ℚ} (hε : 0 ≤ ε)
    (hres : ∀ s, |h s - G.backup h s| ≤ ε) (s : G.S) :
    |h s - G.value s| ≤ ε * (G.height s + 1) :=
  residual_bound_on (P := fun _ => True) (fun _ _ _ _ => trivial) hε (fun s _ => hres s) s trivial

end Game
end Swu
