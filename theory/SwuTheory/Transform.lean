import SwuTheory.Value

/-!
# Does the scale of a score matter?

A position score is often read only for its order ("is this position better than that one?").
Here we ask which rescorings of the payoffs keep the value the same up to that rescoring.

* `value_mapPayoff_mono`: without chance nodes, any monotone rescoring commutes with the value.
  Only the order of results matters.
* `value_affine`: with chance nodes, positive affine rescorings (`a x + b`, `a > 0`) still
  commute.
* `rescore_flips_lottery`: but a monotone, non-affine rescoring can flip a decision that
  involves a shuffle.

So in SWU, which has shuffles, a score must be *calibrated*: an affine function of the win
probability. A score that only ranks positions correctly is not enough to make the right call
at a chance node. This is why fitting weights to game results (for example logistic
regression to win probability) is the right target, not hand-tuned ratios.
-/

namespace Swu
namespace Game

open Finset

variable (G : Game)

/-- The same game with every payoff passed through `g`. -/
abbrev mapPayoff (g : ℚ → ℚ) : Game := { G with payoff := fun s => g (G.payoff s) }

variable {G}

theorem sup'_map_mono {ι : Type*} [Fintype ι] [Nonempty ι] {g : ℚ → ℚ} (hg : Monotone g)
    (f : ι → ℚ) :
    univ.sup' univ_nonempty (fun i => g (f i)) = g (univ.sup' univ_nonempty f) := by
  apply le_antisymm
  · exact sup'_le _ _ fun i _ => hg (le_sup' f (mem_univ i))
  · obtain ⟨i, -, hi⟩ := exists_mem_eq_sup' univ_nonempty f
    rw [hi]
    exact le_sup' (fun i => g (f i)) (mem_univ i)

theorem inf'_map_mono {ι : Type*} [Fintype ι] [Nonempty ι] {g : ℚ → ℚ} (hg : Monotone g)
    (f : ι → ℚ) :
    univ.inf' univ_nonempty (fun i => g (f i)) = g (univ.inf' univ_nonempty f) := by
  apply le_antisymm
  · obtain ⟨i, -, hi⟩ := exists_mem_eq_inf' univ_nonempty f
    rw [hi]
    exact inf'_le (fun i => g (f i)) (mem_univ i)
  · exact le_inf' _ _ fun i _ => hg (inf'_le f (mem_univ i))

/-- **Only the order of results matters without chance.** In a game with no chance nodes,
rescoring the payoffs by a monotone `g` rescores every value by `g`. -/
theorem value_mapPayoff_mono {g : ℚ → ℚ} (hg : Monotone g)
    (hnc : ∀ s, G.kind s ≠ .chance) (s : G.S) :
    (G.mapPayoff g).value s = g (G.value s) := by
  refine (value_unique (G := G.mapPayoff g) (f := fun t => g (G.value t)) (fun t => ?_) s).symm
  rw [value_bellman (G := G) t]
  cases hk : G.kind (t : G.S)
  · rw [backup_terminal (G := G) _ _ hk, backup_terminal (G := G.mapPayoff g) _ _ hk]
  · rw [backup_max (G := G) hk, backup_max (G := G.mapPayoff g) hk]
    exact (sup'_map_mono hg _).symm
  · rw [backup_min (G := G) hk, backup_min (G := G.mapPayoff g) hk]
    exact (inf'_map_mono hg _).symm
  · exact absurd hk (hnc t)

/-- **Calibrated rescoring is always safe.** Positive affine rescoring commutes with the
value, even with chance nodes. -/
theorem value_affine {a b : ℚ} (ha : 0 < a) (s : G.S) :
    (G.mapPayoff (fun x => a * x + b)).value s = a * G.value s + b := by
  have hg : Monotone (fun x : ℚ => a * x + b) := fun x y h => by
    simp only; nlinarith
  refine (value_unique (G := G.mapPayoff (fun x => a * x + b))
    (f := fun t => a * G.value t + b) (fun t => ?_) s).symm
  rw [value_bellman (G := G) t]
  cases hk : G.kind (t : G.S)
  · rw [backup_terminal (G := G) _ _ hk, backup_terminal (G := G.mapPayoff _) _ _ hk]
  · rw [backup_max (G := G) hk, backup_max (G := G.mapPayoff _) hk]
    exact (sup'_map_mono hg (fun i => G.value (G.next t i))).symm
  · rw [backup_min (G := G) hk, backup_min (G := G.mapPayoff _) hk]
    exact (inf'_map_mono hg (fun i => G.value (G.next t i))).symm
  · rw [backup_chance (G := G) hk, backup_chance (G := G.mapPayoff _) hk]
    show a * (∑ i, G.prob t i * G.value (G.next t i)) + b =
      ∑ i, G.prob t i * (a * G.value (G.next t i) + b)
    simp only [mul_add, sum_add_distrib, ← sum_mul, G.prob_sum t hk, one_mul, mul_sum]
    congr 1
    exact sum_congr rfl fun i _ => by ring

/-- **A monotone rescoring can flip a decision at a shuffle.** Option A is a coin flip
between a loss (0) and a win (1); option B is a sure 3/5. B is better (3/5 > 1/2). After the
strictly increasing rescoring `x ↦ x³`, A looks better (1/2 > 27/125). -/
theorem rescore_flips_lottery :
    StrictMono (fun x : ℚ => x ^ 3) ∧
      (1 / 2 * 0 + 1 / 2 * 1 : ℚ) < 3 / 5 ∧
      ((3 / 5 : ℚ)) ^ 3 < 1 / 2 * 0 ^ 3 + 1 / 2 * 1 ^ 3 :=
  ⟨Odd.strictMono_pow ⟨1, rfl⟩, by norm_num, by norm_num⟩

end Game
end Swu
