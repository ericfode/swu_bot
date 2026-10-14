defmodule Coord.Scheduler.Policy do
  @moduledoc """
  The Scheduler's rules as pure functions over plain maps, so they are tested without processes or clocks.
  Times are monotonic milliseconds; `incomplete` lists the workers (:intake, :round) that have a job not yet done.
  """

  @doc "An intake pass is due once setup is done: on every third tick (tick 0 comes right after setup) and after a wake."
  def intake_due?(phase, %{ticks: ticks, woken: woken}) do
    phase != :setup and (rem(ticks, 3) == 0 or woken)
  end

  @doc "plan runs when ready, with no Intake or Round job incomplete and no plan still running."
  def plan?(%{phase: :ready, incomplete: [], planning: false}), do: true
  def plan?(_facts), do: false

  @doc """
  The machine may stop: ready, no job incomplete, no plan waiting for its answer, no child running but a push, no
  wake, open submission or round end for idle_ms, and no version accepted for settle_ms (settled_at is nil when
  none came in this boot).
  """
  def idle?(facts, now) do
    facts.phase == :ready and facts.incomplete == [] and not facts.planning and
      Enum.all?(facts.children, &(&1 == :push)) and
      now - facts.busy_at > facts.idle_ms and
      (facts.settled_at == nil or now - facts.settled_at > facts.settle_ms)
  end

  @doc """
  How long a new round still waits after the last round's end (wall clock ms; nil when no round has finished) for
  Eric's wait between rounds: 0 when it may start, and never more than the wait itself (a clock set back).
  """
  def round_wait(nil, _gap_ms, _now), do: 0
  def round_wait(ended_at, gap_ms, now), do: ended_at |> Kernel.+(gap_ms - now) |> min(gap_ms) |> max(0)

  @doc """
  What an intake pass changes: busy when submissions are still open, settled when one was accepted. An unknown
  open count (nil: the window is down or the toolchain missing) does not keep the machine up.
  """
  def after_intake(open, accepted) do
    %{busy: is_integer(open) and open > 0, settled: is_integer(accepted) and accepted > 0}
  end
end
