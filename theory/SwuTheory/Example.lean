import SwuTheory.Fitness
import Mathlib.Algebra.BigOperators.Fin

/-!
# A tiny game, to show the assumptions can all hold at once

State 0 is a coin flip (a shuffle); state 1 is a win, state 2 a loss.
-/

namespace Swu

/-- A one-shuffle game: player 1 wins on heads. -/
abbrev coinFlip : Game where
  S := Fin 3
  Act := fun _ => Fin 2
  kind := fun s => if s = 0 then .chance else .terminal
  next := fun _ a => if a = 0 then 1 else 2
  prob := fun _ _ => 1 / 2
  payoff := fun s => if s = 1 then 1 else 0
  height := fun s => if s = 0 then 1 else 0
  height_lt := by decide
  prob_nonneg := by intros; norm_num
  prob_sum := by intros; simp

/-- Its value is a 1/2 win probability. -/
theorem coinFlip_value : coinFlip.value (0 : Fin 3) = 1 / 2 := by
  have h1 : coinFlip.value (1 : Fin 3) = 1 := by
    rw [Game.value_terminal (G := coinFlip) (s := (1 : Fin 3)) (by decide)]; rfl
  have h2 : coinFlip.value (2 : Fin 3) = 0 := by
    rw [Game.value_terminal (G := coinFlip) (s := (2 : Fin 3)) (by decide)]; rfl
  rw [Game.value_bellman, Game.backup_chance (G := coinFlip) (s := (0 : Fin 3)) (by decide), Fin.sum_univ_two]
  show 1 / 2 * coinFlip.value (1 : Fin 3) + 1 / 2 * coinFlip.value (2 : Fin 3) = 1 / 2
  rw [h1, h2]; norm_num

/-- **Why `tdLoss_eq_zero_iff` needs a closed set of positions.** Train only on the coin-flip
position, not on its two results, and an evaluator that says 7 everywhere has zero TD loss
while the true value is 1/2. Self-consistency only pins the value down when the training
positions include their successors, down to finished games. -/
theorem tdLoss_needs_closure :
    coinFlip.tdLoss {(0 : Fin 3)} (fun _ => 1) (fun _ => 7) = 0 ∧
      (fun _ => (7 : ℚ)) (0 : Fin 3) ≠ coinFlip.value (0 : Fin 3) := by
  refine ⟨?_, by rw [coinFlip_value]; norm_num⟩
  simp only [Game.tdLoss, Finset.sum_singleton]
  rw [Game.backup_chance (G := coinFlip) (s := (0 : Fin 3)) (by decide), Fin.sum_univ_two]
  norm_num

end Swu
