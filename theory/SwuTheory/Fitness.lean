import SwuTheory.Policy

/-!
# Fitness functions for evaluators

Two ways to score an evaluator `h` without knowing the true value:

1. **Self-consistency (TD) loss.** On a set `D` of positions, add up the squared gap between
   what `h` says and what one step of lookahead with `h` says. At terminal states the lookahead
   is the real result, so this also anchors `h` to the game results.
2. **Outcome regression (Monte Carlo).** Fit `h(s)` to the results of games played on from `s`.

Main results:
* `tdLoss_eq_zero_iff`: on a set of positions closed under moves, the TD loss is zero exactly
  when `h` is the true value there. The perfect evaluator is the unique global minimizer.
* `tdLoss_bound`: a small TD loss gives a small error, at most `ε × (moves left + 1)`.
* `sq_loss_decomp`: outcome regression is minimized by the mean result, which is the value of
  the policies that played the games, not the true value (`polVal_le_value`).
-/

namespace Swu
namespace Game

open Finset

variable (G : Game)

/-- Self-consistency (TD) loss of evaluator `h` on positions `D` with weights `w`. -/
def tdLoss (D : Finset G.S) (w : G.S → ℚ) (h : G.S → ℚ) : ℚ :=
  ∑ s ∈ D, w s * (h s - G.backup h s) ^ 2

variable {G}

theorem tdLoss_nonneg {D : Finset G.S} {w h : G.S → ℚ} (hw : ∀ s ∈ D, 0 ≤ w s) :
    0 ≤ G.tdLoss D w h :=
  sum_nonneg fun s hs => mul_nonneg (hw s hs) (sq_nonneg _)

/-- The true value has zero TD loss on any set of positions. -/
theorem tdLoss_value (D : Finset G.S) (w : G.S → ℚ) : G.tdLoss D w G.value = 0 := by
  unfold tdLoss
  refine sum_eq_zero fun s _ => ?_
  rw [← value_bellman, sub_self]
  ring

/-- **The perfect evaluator minimizes the TD loss** (the loss is never below zero, and the
true value reaches zero). -/
theorem value_minimizes_tdLoss {D : Finset G.S} {w : G.S → ℚ} (hw : ∀ s ∈ D, 0 ≤ w s)
    (h : G.S → ℚ) : G.tdLoss D w G.value ≤ G.tdLoss D w h := by
  rw [tdLoss_value]; exact tdLoss_nonneg hw

/-- **It is the only minimizer.** On a set of positions that is closed under moves, with
positive weights, zero TD loss means `h` equals the true value on the whole set. -/
theorem tdLoss_eq_zero_iff {D : Finset G.S} {w h : G.S → ℚ} (hD : G.Closed (· ∈ D))
    (hw : ∀ s ∈ D, 0 < w s) : G.tdLoss D w h = 0 ↔ ∀ s ∈ D, h s = G.value s := by
  constructor
  · intro hL
    have hz := (sum_eq_zero_iff_of_nonneg fun s hs =>
      mul_nonneg (hw s hs).le (sq_nonneg (h s - G.backup h s))).1 hL
    have hfix : ∀ s, s ∈ D → h s = G.backup h s := by
      intro s hs
      have := hz s hs
      rcases mul_eq_zero.1 this with h0 | h0
      · exact absurd h0 (hw s hs).ne'
      · exact sub_eq_zero.1 ((pow_eq_zero_iff (n := 2) (by norm_num)).1 h0)
    exact fix_unique_on backup_local backup_terminal hD hfix
  · intro hv
    refine sum_eq_zero fun s hs => ?_
    have hb : G.backup h s = G.backup G.value s := by
      by_cases ht : G.kind s = .terminal
      · rw [backup_terminal _ _ ht, backup_terminal _ _ ht]
      · exact backup_local _ _ _ fun a => hv _ (hD s hs ht a)
    rw [hb, ← value_bellman, hv s hs, sub_self]
    ring

/-- **Small TD loss means a small error.** If every weight on a closed set is at least `m > 0`
and the TD loss is at most `m ε²`, then `h` is within `ε × (moves left + 1)` of the true value
on that set. -/
theorem tdLoss_bound {D : Finset G.S} {w h : G.S → ℚ} {m ε : ℚ} (hD : G.Closed (· ∈ D))
    (hm : 0 < m) (hw : ∀ s ∈ D, m ≤ w s) (hε : 0 ≤ ε) (hL : G.tdLoss D w h ≤ m * ε ^ 2) :
    ∀ s ∈ D, |h s - G.value s| ≤ ε * (G.height s + 1) := by
  refine residual_bound_on hD hε fun s hs => abs_le_of_sq_le_sq ?_ hε
  have h1 : w s * (h s - G.backup h s) ^ 2 ≤ G.tdLoss D w h :=
    single_le_sum (f := fun s => w s * (h s - G.backup h s) ^ 2)
      (fun t ht => mul_nonneg (hm.le.trans (hw t ht)) (sq_nonneg _)) hs
  have h2 : m * (h s - G.backup h s) ^ 2 ≤ w s * (h s - G.backup h s) ^ 2 :=
    mul_le_mul_of_nonneg_right (hw s hs) (sq_nonneg _)
  exact le_of_mul_le_mul_left (h2.trans (h1.trans hL)) hm

/-! ## Outcome regression -/

/-- **Bias-variance split of the squared loss.** For results `z` with probabilities `p`
(summing to 1), the expected squared error of a prediction `c` is the squared distance from
`c` to the mean result, plus the variance. -/
theorem sq_loss_decomp {ι : Type*} [Fintype ι] (p z : ι → ℚ) (hp : ∑ i, p i = 1) (c : ℚ) :
    ∑ i, p i * (c - z i) ^ 2 =
      (c - ∑ i, p i * z i) ^ 2 + ∑ i, p i * (z i - ∑ j, p j * z j) ^ 2 := by
  set m := ∑ i, p i * z i with hm
  have h1 : ∀ i, p i * (c - z i) ^ 2 =
      (c - m) ^ 2 * p i + (2 * (c - m) * m * p i - 2 * (c - m) * (p i * z i)) +
        p i * (z i - m) ^ 2 := by
    intro i; ring
  simp only [h1, sum_add_distrib, sum_sub_distrib, ← mul_sum, hp, ← hm]
  ring

/-- **Outcome regression is minimized by the mean result, and only by it.** -/
theorem mean_minimizes_sq_loss {ι : Type*} [Fintype ι] (p z : ι → ℚ) (hp : ∑ i, p i = 1)
    (c : ℚ) :
    ∑ i, p i * ((∑ j, p j * z j) - z i) ^ 2 ≤ ∑ i, p i * (c - z i) ^ 2 ∧
      (∑ i, p i * (c - z i) ^ 2 = ∑ i, p i * ((∑ j, p j * z j) - z i) ^ 2 ↔
        c = ∑ j, p j * z j) := by
  rw [sq_loss_decomp p z hp c, sq_loss_decomp p z hp]
  constructor
  · simp only [sub_self, ne_eq, OfNat.ofNat_ne_zero, not_false_eq_true, zero_pow, zero_add]
    exact le_add_of_nonneg_left (sq_nonneg _)
  · simp only [sub_self, ne_eq, OfNat.ofNat_ne_zero, not_false_eq_true, zero_pow, zero_add,
      add_eq_right, pow_eq_zero_iff, sub_eq_zero]

/-- **What outcome regression learns.** The mean result of games played on from `s` with
policies `σ`, `τ` is `polVal σ τ s` (that is how `polVal` is defined). Against a perfect
opponent it never exceeds the true value, and it equals the true value when player 1 also
plays perfectly. So fitting to results of imperfect play learns the value of that play, which
is biased low for the weaker side. -/
theorem outcome_target_bias (σ : G.Policy) (s : G.S) :
    G.polVal σ G.bestMin s ≤ G.value s ∧ G.polVal G.bestMax G.bestMin s = G.value s :=
  ⟨polVal_le_value σ s, polVal_best s⟩

end Game
end Swu
