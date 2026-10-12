defmodule Coord.Scheduler.PolicyTest do
  use ExUnit.Case, async: true

  alias Coord.Scheduler.Policy

  describe "intake_due?" do
    test "at tick 0, every third tick and after a wake" do
      due = for t <- 0..9, Policy.intake_due?(:ready, %{ticks: t, woken: false}), do: t
      assert due == [0, 3, 6, 9]
      assert Policy.intake_due?(:ready, %{ticks: 1, woken: true})
      assert Policy.intake_due?(:ready, %{ticks: 2, woken: true})
    end

    test "while warming too, but never before setup is done" do
      assert Policy.intake_due?(:warming, %{ticks: 0, woken: false})
      refute Policy.intake_due?(:setup, %{ticks: 0, woken: false})
      refute Policy.intake_due?(:setup, %{ticks: 1, woken: true})
    end
  end

  describe "plan?" do
    test "only when ready, with no job incomplete and no plan running" do
      assert Policy.plan?(%{phase: :ready, incomplete: [], planning: false})
      refute Policy.plan?(%{phase: :ready, incomplete: [:intake], planning: false})
      refute Policy.plan?(%{phase: :ready, incomplete: [:round], planning: false})
      refute Policy.plan?(%{phase: :ready, incomplete: [:intake, :round], planning: false})
      refute Policy.plan?(%{phase: :ready, incomplete: [], planning: true})
      refute Policy.plan?(%{phase: :warming, incomplete: [], planning: false})
      refute Policy.plan?(%{phase: :setup, incomplete: [], planning: false})
    end
  end

  describe "idle?" do
    @minutes_10 600_000
    @idle %{
      phase: :ready,
      incomplete: [],
      planning: false,
      children: [],
      busy_at: 0,
      settled_at: nil,
      idle_ms: @minutes_10,
      settle_ms: 90_000
    }

    test "after idle_ms with nothing going on" do
      assert Policy.idle?(@idle, @minutes_10 + 1)
      refute Policy.idle?(@idle, @minutes_10)
      refute Policy.idle?(@idle, 1_000)
    end

    test "a push may be running, nothing else" do
      now = @minutes_10 + 1
      assert Policy.idle?(%{@idle | children: [:push]}, now)
      refute Policy.idle?(%{@idle | children: [:push, :plan]}, now)
      refute Policy.idle?(%{@idle | children: [:referee]}, now)
      refute Policy.idle?(%{@idle | children: [:intake]}, now)
      refute Policy.idle?(%{@idle | children: [:warm]}, now)
    end

    test "not with an incomplete job or a plan waiting for its answer, nor before the machine is ready" do
      now = @minutes_10 + 1
      refute Policy.idle?(%{@idle | incomplete: [:round]}, now)
      refute Policy.idle?(%{@idle | incomplete: [:intake]}, now)
      refute Policy.idle?(%{@idle | planning: true}, now)
      refute Policy.idle?(%{@idle | phase: :warming}, now)
      refute Policy.idle?(%{@idle | phase: :setup}, now)
    end

    test "not within 90 s of an accepted version, so its round can start" do
      now = @minutes_10 + 1
      refute Policy.idle?(%{@idle | settled_at: now - 90_000}, now)
      assert Policy.idle?(%{@idle | settled_at: now - 90_001}, now)
    end
  end

  describe "after_intake" do
    test "open submissions keep the machine busy; an unknown count does not" do
      assert Policy.after_intake(2, 0).busy
      refute Policy.after_intake(0, 0).busy
      refute Policy.after_intake(nil, 0).busy
    end

    test "an accepted version starts the settle clock" do
      assert Policy.after_intake(0, 1).settled
      refute Policy.after_intake(1, 0).settled
      refute Policy.after_intake(nil, 0).settled
    end

    test "after a pass with an unknown count, an otherwise idle machine is still idle" do
      facts = %{@idle | busy_at: 0}
      change = Policy.after_intake(nil, 0)
      facts = if change.busy, do: %{facts | busy_at: @minutes_10}, else: facts
      assert Policy.idle?(facts, @minutes_10 + 1)
    end
  end
end
