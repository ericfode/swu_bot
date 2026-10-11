import SwuTheory.Policy
import SwuTheory.Information
import Mathlib.Algebra.BigOperators.Fin

/-!
# Hidden information over a whole game

`Information.lean` measures the omniscience bias at one decision. This file carries it over a
whole game tree.

* `perf_diff` (performance difference): the true value minus what a pair of policies actually
  gets equals the expected sum, along the play those policies produce, of each move's loss in
  true value. Player 1's moves add their regret (best child minus chosen child); player 2's
  moves subtract their mistakes (`localLoss_min_nonpos`).
* `regret_bound`: if every player-1 move gives up at most `δ` of true value, player 1 keeps at
  least `value − δ × (moves left)` against any player 2. `greedy_regret` is the case `δ = 2ε`.
* `Info` gives player 1 information sets: an observation of each state, and names for the
  moves that are the same at every state with that observation. A `blind` policy picks a move
  name from the observation only, so it cannot use hidden cards.
* `blind_le_value`: a blind player 1 never gets more than the omniscient value against a perfect
  player 2. Whole-game omniscient (PIMC-style) evaluation overrates the blind side.
* `pimc_choice_loss`: at one information set, with a belief `p` over the hidden states, the move
  PIMC picks (best average child value) loses in expectation exactly the omniscience bias of that
  set, and no blind move loses less (`blind_choice_loss_ge`).
* `hiddenCoin_blind`: a whole game where the gap is half the payoff range: guess a hidden coin.
  The omniscient value is 1 and every blind policy gets 1/2.

Not formalized: that the belief PIMC samples from is the true conditional distribution of the
hidden state given the play so far. With that, `perf_diff` and `pimc_choice_loss` together say
the omniscient value overrates the PIMC player by the expected sum of the omniscience biases of
the information sets play passes through.
-/

namespace Swu
namespace Game

open Finset

variable (G : Game)

/-! ## Adding up per-move quantities along play -/

/-- The same game with every payoff 0. Its fixed points add up per-move quantities. -/
abbrev zeroed : Game := { G with payoff := fun _ => 0 }

/-- One step of "add `r` here, then continue with the policies". -/
def abackup (σ τ : G.Policy) (r : G.S → ℚ) (f : G.S → ℚ) (s : G.S) : ℚ :=
  match G.kind s with
  | .terminal => 0
  | .max => r s + f (G.next s (σ s))
  | .min => r s + f (G.next s (τ s))
  | .chance => r s + ∑ a, G.prob s a * f (G.next s a)

/-- Expected sum of `r` over the non-terminal states that play visits when player 1 follows `σ`,
player 2 follows `τ` and chance falls at random. -/
def pathSum (σ τ : G.Policy) (r : G.S → ℚ) : G.S → ℚ := G.zeroed.fix (G.abackup σ τ r)

/-- What one move costs in true value: player 1's regret at its states, and at player 2's
states the true value player 2 gives away (negative or zero, see `localLoss_min_nonpos`). -/
def localLoss (σ τ : G.Policy) (s : G.S) : ℚ :=
  match G.kind s with
  | .terminal => 0
  | .max => G.value s - G.value (G.next s (σ s))
  | .min => G.value s - G.value (G.next s (τ s))
  | .chance => 0

variable {G}

theorem abackup_local (σ τ : G.Policy) (r : G.S → ℚ) : G.zeroed.Local (G.abackup σ τ r) := by
  intro f g s hfg
  cases hk : G.kind s <;> simp only [abackup, hk] <;> simp only [hfg]

theorem abackup_terminal (σ τ : G.Policy) (r : G.S → ℚ) :
    G.zeroed.Terminal (G.abackup σ τ r) := by
  intro f s ht
  have ht' : G.kind s = .terminal := ht
  simp only [abackup, ht']

theorem pathSum_bellman (σ τ : G.Policy) (r : G.S → ℚ) (s : G.S) :
    G.pathSum σ τ r s = G.abackup σ τ r (G.pathSum σ τ r) s :=
  fix_bellman (G := G.zeroed) (abackup_local σ τ r) (abackup_terminal σ τ r) s

/-- **Performance difference.** The true value minus the result of the policies equals the
expected sum of the per-move losses in true value along the play they produce. -/
theorem perf_diff (σ τ : G.Policy) (s : G.S) :
    G.value s - G.polVal σ τ s = G.pathSum σ τ (G.localLoss σ τ) s := by
  refine fix_unique (G := G.zeroed) (abackup_local σ τ _) (abackup_terminal σ τ _)
    (f := fun s => G.value s - G.polVal σ τ s) (fun s => ?_) s
  show G.value s - G.polVal σ τ s = G.abackup σ τ (G.localLoss σ τ)
    (fun s => G.value s - G.polVal σ τ s) s
  rw [polVal_bellman σ τ s]
  cases hk : G.kind s
  · simp only [abackup, pbackup, hk, value_terminal hk, sub_self]
  · simp only [abackup, pbackup, localLoss, hk]; ring
  · simp only [abackup, pbackup, localLoss, hk]; ring
  · simp only [abackup, pbackup, localLoss, hk]
    rw [value_bellman (G := G) s, backup_chance (G := G) hk, zero_add, ← sum_sub_distrib]
    exact sum_congr rfl fun a _ => by ring

theorem polVal_max (σ τ : G.Policy) {s : G.S} (hk : G.kind s = .max) :
    G.polVal σ τ s = G.polVal σ τ (G.next s (σ s)) := by
  rw [polVal_bellman]; simp only [pbackup, hk]

theorem polVal_chance (σ τ : G.Policy) {s : G.S} (hk : G.kind s = .chance) :
    G.polVal σ τ s = ∑ a, G.prob s a * G.polVal σ τ (G.next s a) := by
  rw [polVal_bellman]; simp only [pbackup, hk]

/-- Player 2's moves never cost player 1 true value: the chosen child is at least the worst. -/
theorem localLoss_min_nonpos (σ τ : G.Policy) {s : G.S} (hk : G.kind s = .min) :
    G.localLoss σ τ s ≤ 0 := by
  simp only [localLoss, hk]
  rw [value_bellman s, backup_min hk]
  linarith [inf'_le (fun a => G.value (G.next s a)) (mem_univ (τ s))]

/-- Against a perfect player 2, player 2's moves cost nothing either way. -/
theorem localLoss_bestMin (σ : G.Policy) {s : G.S} (hk : G.kind s = .min) :
    G.localLoss σ G.bestMin s = 0 := by
  simp only [localLoss, hk]
  rw [value_bellman s, backup_min hk, bestMin_spec, sub_self]

/-- If every per-move term is at most `δ`, the sum along play is at most `δ × (moves left)`. -/
theorem pathSum_le (σ τ : G.Policy) {r : G.S → ℚ} {δ : ℚ} (hδ : 0 ≤ δ)
    (hr : ∀ s, G.kind s ≠ .terminal → r s ≤ δ) (s : G.S) :
    G.pathSum σ τ r s ≤ δ * G.height s := by
  refine fix_le_of (G := G.zeroed) (abackup_local σ τ r) (abackup_terminal σ τ r)
    (g := fun s => δ * G.height s) (fun s f hf => ?_) s
  by_cases ht : G.kind s = .terminal
  · simp only [abackup, ht]; positivity
  have hcf := hf ht
  have hc : ∀ a, f (G.next s a) ≤ δ * (G.height s - 1) := by
    intro a
    have hlt : (G.height (G.next s a) : ℚ) + 1 ≤ G.height s := by
      exact_mod_cast G.height_lt s a ht
    have := hcf a
    have : δ * (G.height (G.next s a) : ℚ) ≤ δ * (G.height s - 1) :=
      mul_le_mul_of_nonneg_left (by linarith) hδ
    linarith
  have hrs := hr s ht
  cases hk : G.kind s
  · exact absurd hk ht
  · simp only [abackup, hk]; linarith [hc (σ s)]
  · simp only [abackup, hk]; linarith [hc (τ s)]
  · simp only [abackup, hk]
    have hsum : ∑ a, G.prob s a * f (G.next s a) ≤ ∑ a, G.prob s a * (δ * (G.height s - 1)) :=
      sum_le_sum fun a _ => mul_le_mul_of_nonneg_left (hc a) (G.prob_nonneg s a hk)
    rw [← sum_mul, G.prob_sum s hk, one_mul] at hsum
    linarith

/-- If every per-move term is nonnegative, so is the sum along play. -/
theorem pathSum_nonneg (σ τ : G.Policy) {r : G.S → ℚ} (hr : ∀ s, 0 ≤ r s) (s : G.S) :
    0 ≤ G.pathSum σ τ r s := by
  refine le_fix_of (G := G.zeroed) (abackup_local σ τ r) (abackup_terminal σ τ r)
    (g := fun _ => 0) (fun s f hf => ?_) s
  by_cases ht : G.kind s = .terminal
  · simp only [abackup, ht, le_refl]
  have hc := hf ht
  cases hk : G.kind s
  · exact absurd hk ht
  · simp only [abackup, hk]; linarith [hr s, hc (σ s)]
  · simp only [abackup, hk]; linarith [hr s, hc (τ s)]
  · simp only [abackup, hk]
    have := sum_nonneg fun a (_ : a ∈ univ) =>
      mul_nonneg (G.prob_nonneg s a hk) (hc a)
    linarith [hr s]

/-- **Per-move regret bound.** If each of player 1's moves gives up at most `δ` of true value,
player 1 keeps at least `value − δ × (moves left)` against any player 2. -/
theorem regret_bound {σ : G.Policy} {δ : ℚ} (hδ : 0 ≤ δ)
    (hσ : ∀ s, G.kind s = .max → G.value s - G.value (G.next s (σ s)) ≤ δ) (τ : G.Policy)
    (s : G.S) : G.value s - δ * G.height s ≤ G.polVal σ τ s := by
  have h := pathSum_le σ τ (r := G.localLoss σ τ) hδ (fun t ht => by
    cases hk : G.kind t
    · exact absurd hk ht
    · simpa only [localLoss, hk] using hσ t hk
    · exact (localLoss_min_nonpos σ τ hk).trans hδ
    · simp only [localLoss, hk]; exact hδ) s
  rw [← perf_diff] at h
  linarith

end Game

/-! ## Information sets for player 1 -/

/-- Player 1's information: what it observes at each state, and the names of its moves. States
with the same observation offer the same named moves (a player knows its own legal moves). -/
structure Info (G : Game) where
  /-- What player 1 can see: its hand, the board, discards, but not the hidden cards. -/
  O : Type
  obs : G.S → O
  /-- Player 1's move names at an observation. -/
  A : O → Type
  [fin : ∀ o, Fintype (A o)]
  [ne : ∀ o, Nonempty (A o)]
  /-- At a player-1 state, the named moves are exactly its moves. -/
  name : ∀ s, G.kind s = .max → A (obs s) ≃ G.Act s

attribute [instance] Info.fin Info.ne

namespace Info

open Finset Game

variable {G : Game} (I : Info G)

/-- A blind policy: the move name depends only on what player 1 observes. -/
noncomputable def blind (π : ∀ o, I.A o) : G.Policy := fun s =>
  if h : G.kind s = .max then I.name s h (π (I.obs s)) else Classical.arbitrary _

theorem blind_max (π : ∀ o, I.A o) {s : G.S} (h : G.kind s = .max) :
    I.blind π s = I.name s h (π (I.obs s)) := by
  simp only [blind, h, dite_true]

/-- **A blind player is overrated by the omniscient value.** Against a perfect player 2, no
policy that cannot see hidden cards gets more than the omniscient value. -/
theorem blind_le_value (π : ∀ o, I.A o) (s : G.S) :
    G.polVal (I.blind π) G.bestMin s ≤ G.value s :=
  polVal_le_value _ s

/-- The omniscient value at a player-1 state is the best value over its named moves. -/
theorem value_eq_sup_named {s : G.S} (h : G.kind s = .max) :
    G.value s = univ.sup' univ_nonempty (fun b : I.A (I.obs s) => G.value (G.next s (I.name s h b))) := by
  rw [value_bellman s, backup_max h]
  apply le_antisymm
  · refine sup'_le _ _ fun a _ => ?_
    calc G.value (G.next s a)
        = G.value (G.next s (I.name s h ((I.name s h).symm a))) := by rw [Equiv.apply_symm_apply]
      _ ≤ _ := le_sup' (fun b : I.A (I.obs s) => G.value (G.next s (I.name s h b))) (mem_univ _)
  · exact sup'_le _ _ fun b _ => le_sup' (fun a => G.value (G.next s a)) (mem_univ _)

/-- How much the blind policy loses over the whole game against a perfect player 2: exactly the
expected sum, along play, of its per-move regrets (`perf_diff` with player 2's terms zero). -/
theorem blind_gap (π : ∀ o, I.A o) (s : G.S) :
    G.value s - G.polVal (I.blind π) G.bestMin s =
      G.pathSum (I.blind π) G.bestMin (G.localLoss (I.blind π) G.bestMin) s :=
  perf_diff _ _ s

end Info

/-! ## One information set: what PIMC's move loses -/

section Local

open Finset

variable {W A : Type*} [Fintype W] [Fintype A] [Nonempty A]

/-- **What PIMC's move loses.** Hidden states `w` with belief `p` (summing to 1); `f w a` is the
true value after the named move `a` in state `w`, so the omniscient value of `w` is
`max_a f w a`. PIMC averages over the belief and plays a move `a₀` with the best average. Its
expected loss in true value is exactly the omniscience bias of this information set:
`E[max_a f] − max_a E[f]`. -/
theorem pimc_choice_loss (p : W → ℚ) (f : W → A → ℚ) {a₀ : A}
    (ha₀ : ∑ w, p w * f w a₀ = univ.sup' univ_nonempty (fun a => ∑ w, p w * f w a)) :
    ∑ w, p w * (univ.sup' univ_nonempty (fun a => f w a) - f w a₀) =
      ∑ w, p w * univ.sup' univ_nonempty (fun a => f w a) -
        univ.sup' univ_nonempty (fun a => ∑ w, p w * f w a) := by
  rw [← ha₀, ← sum_sub_distrib]
  exact sum_congr rfl fun w _ => by ring

/-- No blind move loses less than PIMC's: every move's expected loss is at least the
omniscience bias. -/
theorem blind_choice_loss_ge (p : W → ℚ) (f : W → A → ℚ) (a : A) :
    ∑ w, p w * univ.sup' univ_nonempty (fun a => f w a) -
        univ.sup' univ_nonempty (fun a => ∑ w, p w * f w a) ≤
      ∑ w, p w * (univ.sup' univ_nonempty (fun a => f w a) - f w a) := by
  have h := le_sup' (fun a => ∑ w, p w * f w a) (mem_univ a)
  have e : ∑ w, p w * (univ.sup' univ_nonempty (fun a => f w a) - f w a) =
      ∑ w, p w * univ.sup' univ_nonempty (fun a => f w a) - ∑ w, p w * f w a := by
    rw [← sum_sub_distrib]; exact sum_congr rfl fun w _ => by ring
  rw [e]
  linarith

/-- The loss is never negative (it is the omniscience bias of `Information.lean`). -/
theorem pimc_loss_nonneg (p : W → ℚ) (hp : ∀ w, 0 ≤ p w) (f : W → A → ℚ) :
    0 ≤ ∑ w, p w * univ.sup' univ_nonempty (fun a => f w a) -
      univ.sup' univ_nonempty (fun a => ∑ w, p w * f w a) :=
  sub_nonneg.2 (omniscience_bias p hp f)

end Local

/-! ## A whole game where the gap is the full payoff range -/

/-- Guess a hidden coin. State 0 flips it (1 = heads, 2 = tails), player 1 guesses without
seeing it (move 0 = "heads"), 3 is a win and 4 a loss. -/
abbrev hiddenCoin : Game where
  S := Fin 5
  Act := fun _ => Fin 2
  kind := fun s => if s = 0 then .chance else if s = 1 ∨ s = 2 then .max else .terminal
  next := fun s a =>
    if s = 0 then (if a = 0 then 1 else 2)
    else if s = 1 then (if a = 0 then 3 else 4)
    else if s = 2 then (if a = 0 then 4 else 3) else s
  prob := fun _ _ => 1 / 2
  payoff := fun s => if s = 3 then 1 else 0
  height := fun s => if s = 0 then 2 else if s = 1 ∨ s = 2 then 1 else 0
  height_lt := by decide
  prob_nonneg := by intros; norm_num
  prob_sum := by intros; simp

/-- Player 1 sees nothing of the coin: one observation, two named guesses. -/
abbrev hiddenCoinInfo : Info hiddenCoin where
  O := Unit
  obs := fun _ => ()
  A := fun _ => Fin 2
  name := fun _ _ => Equiv.refl _

theorem hiddenCoin_value : hiddenCoin.value (0 : Fin 5) = 1 := by
  have v3 : hiddenCoin.value (3 : Fin 5) = 1 := by
    rw [Game.value_terminal (G := hiddenCoin) (s := (3 : Fin 5)) (by decide)]; rfl
  have v4 : hiddenCoin.value (4 : Fin 5) = 0 := by
    rw [Game.value_terminal (G := hiddenCoin) (s := (4 : Fin 5)) (by decide)]; rfl
  have vmax : ∀ s : Fin 5, hiddenCoin.kind s = .max →
      (∀ a, hiddenCoin.value (hiddenCoin.next s a) ≤ 1) →
      (∃ a, hiddenCoin.value (hiddenCoin.next s a) = 1) → hiddenCoin.value s = 1 := by
    intro s hk hle ⟨a, ha⟩
    rw [Game.value_bellman, Game.backup_max hk]
    exact le_antisymm (Finset.sup'_le _ _ fun b _ => hle b)
      (ha ▸ Finset.le_sup' (fun b => hiddenCoin.value (hiddenCoin.next s b)) (Finset.mem_univ a))
  have hle : ∀ s : Fin 5, s = 1 ∨ s = 2 → ∀ a : Fin 2,
      hiddenCoin.value (hiddenCoin.next s a) ≤ 1 := by
    intro s hs a
    have : hiddenCoin.next s a = 3 ∨ hiddenCoin.next s a = 4 := by
      rcases hs with rfl | rfl <;> revert a <;> decide
    rcases this with h | h <;> rw [h] <;> simp [v3, v4]
  have v1 : hiddenCoin.value (1 : Fin 5) = 1 :=
    vmax 1 (by decide) (hle 1 (by decide)) ⟨0, by
      show hiddenCoin.value (3 : Fin 5) = 1; exact v3⟩
  have v2 : hiddenCoin.value (2 : Fin 5) = 1 :=
    vmax 2 (by decide) (hle 2 (by decide)) ⟨1, by
      show hiddenCoin.value (3 : Fin 5) = 1; exact v3⟩
  rw [Game.value_bellman, Game.backup_chance (G := hiddenCoin) (s := (0 : Fin 5)) (by decide),
    Fin.sum_univ_two]
  show 1 / 2 * hiddenCoin.value (1 : Fin 5) + 1 / 2 * hiddenCoin.value (2 : Fin 5) = 1
  rw [v1, v2]; norm_num

/-- **The whole-game gap can be the full payoff range.** Every blind policy wins the hidden
coin game half the time, against any player 2, while its omniscient value is a sure win. -/
theorem hiddenCoin_blind (π : ∀ o, hiddenCoinInfo.A o) (τ : hiddenCoin.Policy) :
    hiddenCoin.polVal (hiddenCoinInfo.blind π) τ (0 : Fin 5) = 1 / 2 ∧
      hiddenCoin.value (0 : Fin 5) = 1 := by
  refine ⟨?_, hiddenCoin_value⟩
  set σ := hiddenCoinInfo.blind π
  have t : ∀ s : Fin 5, s = 3 ∨ s = 4 →
      hiddenCoin.polVal σ τ s = if s = 3 then 1 else 0 := by
    intro s hs
    rw [Game.polVal_bellman, Game.pbackup_terminal _ _ _ _ (by rcases hs with rfl | rfl <;> decide)]
  have hσ : ∀ s : Fin 5, (h : hiddenCoin.kind s = .max) → σ s = π () := by
    intro s h
    exact (Info.blind_max hiddenCoinInfo π h).trans rfl
  have p1 : hiddenCoin.polVal σ τ (1 : Fin 5) = hiddenCoin.polVal σ τ (hiddenCoin.next 1 (π ())) := by
    rw [Game.polVal_max σ τ (s := (1 : Fin 5)) (by decide), hσ 1 (by decide)]
  have p2 : hiddenCoin.polVal σ τ (2 : Fin 5) = hiddenCoin.polVal σ τ (hiddenCoin.next 2 (π ())) := by
    rw [Game.polVal_max σ τ (s := (2 : Fin 5)) (by decide), hσ 2 (by decide)]
  rw [Game.polVal_chance σ τ (s := (0 : Fin 5)) (by decide), Fin.sum_univ_two]
  show 1 / 2 * hiddenCoin.polVal σ τ (1 : Fin 5) + 1 / 2 * hiddenCoin.polVal σ τ (2 : Fin 5) = 1 / 2
  rw [p1, p2]
  have hg : π () = 0 ∨ π () = 1 := by
    rcases Fin.exists_fin_two.mp ⟨π (), rfl⟩ with h | h <;> simp [h]
  rcases hg with hg | hg <;> rw [hg]
  · rw [show hiddenCoin.next (1 : Fin 5) 0 = 3 by decide, show hiddenCoin.next (2 : Fin 5) 0 = 4 by decide,
      t 3 (by decide), t 4 (by decide)]; norm_num
  · rw [show hiddenCoin.next (1 : Fin 5) 1 = 4 by decide, show hiddenCoin.next (2 : Fin 5) 1 = 3 by decide,
      t 3 (by decide), t 4 (by decide)]; norm_num

end Swu
