import SwuTheory.Value

/-!
# Policies, perfect play, and how evaluator error turns into lost value

A policy picks one move at every state. Because a state holds everything (perfect information
for one fixed deal), memoryless deterministic policies are enough.

`polVal σ τ s` is the expected result for player 1 when player 1 plays `σ`, player 2 plays `τ`
and shuffles fall at random.
-/

namespace Swu
namespace Game

open Finset

variable (G : Game)

/-- A deterministic policy: a move at every state (only used where that player acts). -/
abbrev Policy := (s : G.S) → G.Act s

/-- One step of fixed play: both players follow their policies, chance averages. -/
def pbackup (σ τ : G.Policy) (f : G.S → ℚ) (s : G.S) : ℚ :=
  match G.kind s with
  | .terminal => G.payoff s
  | .max => f (G.next s (σ s))
  | .min => f (G.next s (τ s))
  | .chance => ∑ a, G.prob s a * f (G.next s a)

/-- Expected result for player 1 when the players follow `σ` and `τ`. -/
def polVal (σ τ : G.Policy) : G.S → ℚ := G.fix (G.pbackup σ τ)

/-- Player 1's perfect policy: a move whose child has the highest true value. -/
noncomputable def bestMax : G.Policy := fun s =>
  (exists_mem_eq_sup' univ_nonempty (fun a => G.value (G.next s a))).choose

/-- Player 2's perfect policy: a move whose child has the lowest true value. -/
noncomputable def bestMin : G.Policy := fun s =>
  (exists_mem_eq_inf' univ_nonempty (fun a => G.value (G.next s a))).choose

/-- Greedy 1-ply play for player 1 with evaluator `h`: pick the move whose child `h` likes
most. -/
noncomputable def greedy (h : G.S → ℚ) : G.Policy := fun s =>
  (exists_mem_eq_sup' univ_nonempty (fun a => h (G.next s a))).choose

variable {G}

theorem pbackup_local (σ τ : G.Policy) : G.Local (G.pbackup σ τ) := by
  intro f g s hfg
  cases hk : G.kind s <;> simp only [pbackup, hk, hfg]

theorem pbackup_terminal (σ τ : G.Policy) : G.Terminal (G.pbackup σ τ) := by
  intro f s ht
  simp only [pbackup, ht]

theorem polVal_bellman (σ τ : G.Policy) (s : G.S) :
    G.polVal σ τ s = G.pbackup σ τ (G.polVal σ τ) s :=
  fix_bellman (pbackup_local σ τ) (pbackup_terminal σ τ) s

theorem bestMax_spec (s : G.S) :
    G.value (G.next s (G.bestMax s)) = univ.sup' univ_nonempty (fun a => G.value (G.next s a)) :=
  (exists_mem_eq_sup' univ_nonempty (fun a => G.value (G.next s a))).choose_spec.2.symm

theorem bestMin_spec (s : G.S) :
    G.value (G.next s (G.bestMin s)) = univ.inf' univ_nonempty (fun a => G.value (G.next s a)) :=
  (exists_mem_eq_inf' univ_nonempty (fun a => G.value (G.next s a))).choose_spec.2.symm

theorem greedy_spec (h : G.S → ℚ) (s : G.S) :
    h (G.next s (G.greedy h s)) = univ.sup' univ_nonempty (fun a => h (G.next s a)) :=
  (exists_mem_eq_sup' univ_nonempty (fun a => h (G.next s a))).choose_spec.2.symm

/-! ## Perfect play reaches the value (minimax theorem for one deal) -/

/-- When both players play perfectly the expected result is the true value. -/
theorem polVal_best (s : G.S) : G.polVal G.bestMax G.bestMin s = G.value s := by
  refine (fix_unique (pbackup_local _ _) (pbackup_terminal _ _) (f := G.value) (fun s => ?_) s).symm
  rw [value_bellman s]
  cases hk : G.kind s
  · rw [backup_terminal _ _ hk, pbackup_terminal _ _ _ _ hk]
  · rw [backup_max hk, ← bestMax_spec]; simp only [pbackup, hk]
  · rw [backup_min hk, ← bestMin_spec]; simp only [pbackup, hk]
  · rw [backup_chance hk]; simp only [pbackup, hk]

/-- Against a perfect player 2, no policy of player 1 gets more than the value. -/
theorem polVal_le_value (σ : G.Policy) (s : G.S) : G.polVal σ G.bestMin s ≤ G.value s := by
  refine fix_le_of (pbackup_local _ _) (pbackup_terminal _ _) (fun s f hf => ?_) s
  rw [value_bellman s]
  cases hk : G.kind s
  · rw [backup_terminal _ _ hk, pbackup_terminal _ _ _ _ hk]
  · have h := hf (by simp [hk])
    simp only [pbackup, hk]
    rw [backup_max hk]
    exact (h _).trans (le_sup' (fun a => G.value (G.next s a)) (mem_univ _))
  · have h := hf (by simp [hk])
    simp only [pbackup, hk]
    rw [backup_min hk, ← bestMin_spec]
    exact h _
  · have h := hf (by simp [hk])
    simp only [pbackup, hk]
    rw [backup_chance hk]
    exact sum_le_sum fun a _ => mul_le_mul_of_nonneg_left (h a) (G.prob_nonneg s a hk)

/-- Against a perfect player 1, no policy of player 2 holds player 1 below the value. -/
theorem value_le_polVal (τ : G.Policy) (s : G.S) : G.value s ≤ G.polVal G.bestMax τ s := by
  refine le_fix_of (pbackup_local _ _) (pbackup_terminal _ _) (fun s f hf => ?_) s
  rw [value_bellman s]
  cases hk : G.kind s
  · rw [backup_terminal _ _ hk, pbackup_terminal _ _ _ _ hk]
  · have h := hf (by simp [hk])
    simp only [pbackup, hk]
    rw [backup_max hk, ← bestMax_spec]
    exact h _
  · have h := hf (by simp [hk])
    simp only [pbackup, hk]
    rw [backup_min hk]
    exact (inf'_le (fun a => G.value (G.next s a)) (mem_univ _)).trans (h _)
  · have h := hf (by simp [hk])
    simp only [pbackup, hk]
    rw [backup_chance hk]
    exact sum_le_sum fun a _ => mul_le_mul_of_nonneg_left (h a) (G.prob_nonneg s a hk)

/-- **Saddle point.** The perfect policies form an equilibrium whose result is the value:
neither player can gain by changing policy alone. -/
theorem saddle_point (σ τ : G.Policy) (s : G.S) :
    G.polVal σ G.bestMin s ≤ G.polVal G.bestMax G.bestMin s ∧
      G.polVal G.bestMax G.bestMin s ≤ G.polVal G.bestMax τ s := by
  rw [polVal_best]
  exact ⟨polVal_le_value σ s, value_le_polVal τ s⟩

/-! ## From evaluator error to lost games -/

/-- **Greedy play with an `ε`-accurate evaluator.** If `h` is within `ε` of the true value
everywhere, then 1-ply greedy play with `h` guarantees player 1 at least
`value − 2ε × (moves left)`, against *any* player 2 policy.

Each of player 1's decisions can lose at most `2ε` (the evaluator may overrate the chosen
child by `ε` and underrate the best child by `ε`). -/
theorem greedy_regret {h : G.S → ℚ} {ε : ℚ} (hh : ∀ t, |h t - G.value t| ≤ ε) (τ : G.Policy)
    (s : G.S) : G.value s - 2 * ε * G.height s ≤ G.polVal (G.greedy h) τ s := by
  have hε : 0 ≤ ε := (abs_nonneg _).trans (hh s)
  refine le_fix_of (g := fun t => G.value t - 2 * ε * G.height t)
    (pbackup_local _ _) (pbackup_terminal _ _) (fun s f hf => ?_) s
  beta_reduce at hf ⊢
  by_cases ht : G.kind s = .terminal
  · rw [pbackup_terminal _ _ _ _ ht, value_terminal ht]
    have : (0 : ℚ) ≤ 2 * ε * G.height s := by positivity
    linarith
  have hcf := hf ht
  -- every child is at least `value child − 2ε (height s − 1)`
  have hc : ∀ a, G.value (G.next s a) - 2 * ε * (G.height s - 1) ≤ f (G.next s a) := by
    intro a
    have hlt : (G.height (G.next s a) : ℚ) + 1 ≤ G.height s := by
      exact_mod_cast G.height_lt s a ht
    have hm : 2 * ε * (G.height (G.next s a) : ℚ) ≤ 2 * ε * (G.height s - 1) :=
      mul_le_mul_of_nonneg_left (by linarith) (by positivity)
    have := hcf a
    linarith
  rw [value_bellman s]
  cases hk : G.kind s
  · exact absurd hk ht
  · simp only [pbackup, hk]
    rw [backup_max hk]
    -- the greedy child is within 2ε of the best child
    obtain ⟨b, -, hb⟩ := exists_mem_eq_sup' univ_nonempty (fun a => G.value (G.next s a))
    rw [hb]
    have h1 := (abs_sub_le_iff.1 (hh (G.next s (G.greedy h s)))).1
    have h2 := (abs_sub_le_iff.1 (hh (G.next s b))).2
    have h3 : h (G.next s b) ≤ h (G.next s (G.greedy h s)) := by
      rw [greedy_spec h s]; exact le_sup' (fun a => h (G.next s a)) (mem_univ b)
    have h4 := hc (G.greedy h s)
    linarith
  · simp only [pbackup, hk]
    rw [backup_min hk]
    have h1 := inf'_le (fun a => G.value (G.next s a)) (mem_univ (τ s))
    have h4 := hc (τ s)
    have : (0 : ℚ) ≤ 2 * ε := by positivity
    linarith
  · simp only [pbackup, hk]
    rw [backup_chance hk]
    have hsum : ∑ a, G.prob s a * (G.value (G.next s a) - 2 * ε * (G.height s - 1)) ≤
        ∑ a, G.prob s a * f (G.next s a) :=
      sum_le_sum fun a _ => mul_le_mul_of_nonneg_left (hc a) (G.prob_nonneg s a hk)
    have hexp : ∑ a, G.prob s a * (G.value (G.next s a) - 2 * ε * (G.height s - 1)) =
        ∑ a, G.prob s a * G.value (G.next s a) - 2 * ε * (G.height s - 1) := by
      simp only [mul_sub, sum_sub_distrib, ← sum_mul, G.prob_sum s hk, one_mul]
    have : (0 : ℚ) ≤ 2 * ε := by positivity
    linarith

/-- With a perfect evaluator, greedy 1-ply play is perfect play. -/
theorem greedy_value_optimal (τ : G.Policy) (s : G.S) :
    G.value s ≤ G.polVal (G.greedy G.value) τ s := by
  have := greedy_regret (h := G.value) (ε := 0) (fun t => by simp) τ s
  simpa using this

end Game
end Swu
