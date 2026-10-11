import SwuTheory.Prelude

/-!
# Hidden information and simultaneous choices

Real SWU is not one fixed deal: players do not see the opponent's hand or either deck order,
and some prompts (mulligan, setup resource, every regroup resource step) ask both players at
once. The model in `Game.lean` covers one deal seen by an omniscient observer. These lemmas
measure what that simplification costs.

* `omniscience_bias`: choosing after seeing the hidden state is worth at least as much as
  choosing before (`E[max] ≥ max E`). An omniscient (or PIMC, "solve each sampled deal")
  evaluator therefore overrates the side to move at its own decisions. `omniscience_bias_min`
  is the mirror for the opponent's decisions. `omniscience_bias_strict` shows the gap is real.
* `maximin_le_minimax`: if a simultaneous prompt is answered in order and the second player
  sees the first answer, the second player gains. The true (mixed-strategy) value lies between
  the two orders; that last fact is von Neumann's minimax theorem, which is assumed here, not
  proven.
-/

namespace Swu

open Finset

/-- **Omniscience bias.** For worlds `w` (hidden states) with weights `p ≥ 0` and a payoff
`f w a` for each action: the best single action chosen without seeing the world is worth no
more than choosing the best action in each world. -/
theorem omniscience_bias {W A : Type*} [Fintype W] [Fintype A] [Nonempty A] (p : W → ℚ)
    (hp : ∀ w, 0 ≤ p w) (f : W → A → ℚ) :
    univ.sup' univ_nonempty (fun a => ∑ w, p w * f w a) ≤
      ∑ w, p w * univ.sup' univ_nonempty (fun a => f w a) :=
  sup'_le _ _ fun a _ => sum_le_sum fun w _ =>
    mul_le_mul_of_nonneg_left (le_sup' (fun a => f w a) (mem_univ a)) (hp w)

/-- The mirror for the minimizing side: an omniscient opponent looks stronger than a real
one. -/
theorem omniscience_bias_min {W A : Type*} [Fintype W] [Fintype A] [Nonempty A] (p : W → ℚ)
    (hp : ∀ w, 0 ≤ p w) (f : W → A → ℚ) :
    ∑ w, p w * univ.inf' univ_nonempty (fun a => f w a) ≤
      univ.inf' univ_nonempty (fun a => ∑ w, p w * f w a) :=
  le_inf' _ _ fun a _ => sum_le_sum fun w _ =>
    mul_le_mul_of_nonneg_left (inf'_le (fun a => f w a) (mem_univ a)) (hp w)

/-- The bias can be large: guess a hidden coin. Without seeing it, any guess wins 1/2.
Seeing it, you always win. -/
theorem omniscience_bias_strict :
    univ.sup' univ_nonempty (fun a : Bool => ∑ w : Bool, (1 / 2 : ℚ) * (if w = a then 1 else 0)) <
      ∑ w : Bool, (1 / 2 : ℚ) * univ.sup' univ_nonempty
        (fun a : Bool => if w = a then (1 : ℚ) else 0) := by
  have h1 : univ.sup' univ_nonempty
      (fun a : Bool => ∑ w : Bool, (1 / 2 : ℚ) * (if w = a then 1 else 0)) = 1 / 2 := by
    apply le_antisymm
    · exact sup'_le _ _ fun a _ => by cases a <;> simp
    · exact le_sup'_of_le _ (mem_univ true) (by simp)
  have h2 : ∀ w : Bool, univ.sup' univ_nonempty
      (fun a : Bool => if w = a then (1 : ℚ) else 0) = 1 := by
    intro w
    apply le_antisymm
    · exact sup'_le _ _ fun a _ => by split_ifs <;> norm_num
    · exact le_sup'_of_le _ (mem_univ w) (by simp)
  rw [h1]
  simp only [h2, Fintype.sum_bool]
  norm_num

/-- **Answering a simultaneous prompt in order favors the second player.** Moving first and
being answered (maximin) is never better than seeing the other side's choice (minimax). -/
theorem maximin_le_minimax {I J : Type*} [Fintype I] [Nonempty I] [Fintype J] [Nonempty J]
    (M : I → J → ℚ) :
    univ.sup' univ_nonempty (fun i => univ.inf' univ_nonempty (fun j => M i j)) ≤
      univ.inf' univ_nonempty (fun j => univ.sup' univ_nonempty (fun i => M i j)) :=
  sup'_le _ _ fun i _ => le_inf' _ _ fun j _ =>
    (inf'_le (fun j => M i j) (mem_univ j)).trans (le_sup' (fun i => M i j) (mem_univ i))

/-- The gap can be the whole payoff range: matching pennies. -/
theorem maximin_lt_minimax_pennies :
    univ.sup' univ_nonempty
        (fun i : Bool => univ.inf' univ_nonempty (fun j : Bool => if i = j then (1 : ℚ) else 0)) <
      univ.inf' univ_nonempty
        (fun j : Bool => univ.sup' univ_nonempty (fun i : Bool => if i = j then (1 : ℚ) else 0)) := by
  have h1 : ∀ i : Bool, univ.inf' univ_nonempty
      (fun j : Bool => if i = j then (1 : ℚ) else 0) = 0 := by
    intro i
    apply le_antisymm
    · exact inf'_le_of_le _ (mem_univ (!i)) (by cases i <;> simp)
    · exact le_inf' _ _ fun j _ => by split_ifs <;> norm_num
  have h2 : ∀ j : Bool, univ.sup' univ_nonempty
      (fun i : Bool => if i = j then (1 : ℚ) else 0) = 1 := by
    intro j
    apply le_antisymm
    · exact sup'_le _ _ fun i _ => by split_ifs <;> norm_num
    · exact le_sup'_of_le _ (mem_univ j) (by simp)
  simp only [h1, h2, sup'_const, inf'_const]
  norm_num

end Swu
