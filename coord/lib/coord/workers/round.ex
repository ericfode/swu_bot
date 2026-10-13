defmodule Coord.Workers.Round do
  @moduledoc """
  Plays round k of an arena: referee-cmd gives the checked command, which runs through the FLAME pool.

  The unique key is (arena, round, boot) over every state: a round whose referee failed twice (max_attempts 2)
  waits for the next boot, as in games.js, and so does a round that completed while standings still say it runs
  (that would be a bug, and rerunning it every 20 s would hide it). An explicit round number means a retry
  replays the same round, never the next one.
  """

  use Oban.Worker,
    queue: :rounds,
    max_attempts: 2,
    unique: [keys: [:arena, :round, :boot], states: :all, period: :infinity]

  require Logger

  @impl Oban.Worker
  def perform(%Oban.Job{args: %{"arena" => arena, "round" => k, "boot" => boot}}) when is_integer(k) do
    cond do
      boot != Coord.Boot.id() -> {:cancel, "round #{k} was planned at an earlier boot"}
      Coord.Shutdown.stopping?() -> {:snooze, 60}
      true -> play(arena, k)
    end
  end

  def perform(%Oban.Job{}), do: {:cancel, "not a round"}

  # Whatever the round's end, the helper node forgets its leases and bundles (Coord.Remote.reset/0): a helper still
  # playing one of its seeds gets 410 at its next heartbeat.
  defp play(arena, k) do
    case Coord.Gamesctl.referee_cmd(arena, k) do
      {:ok, spec} ->
        result =
          try do
            FLAME.call(Coord.RoundRunner, fn -> Coord.Round.play(spec) end, timeout: :infinity)
          after
            Coord.Remote.reset()
          end

        Coord.Scheduler.round_done(k, result)
        outcome(k, result)

      # a referee-cmd that Coord.Shutdown stopped is not a failed attempt either
      {:error, why} ->
        Coord.Remote.reset()
        if Coord.Shutdown.stopping?(), do: {:snooze, 60}, else: {:error, "referee-cmd: #{why}"}
    end
  end

  @doc false
  def outcome(k, result) do
    cond do
      # the round resumes at the next boot; a snooze does not count as an attempt
      Coord.Shutdown.stopping?() -> {:snooze, 60}
      match?({:exit, 0, _}, result) -> :ok
      match?({:timeout, _}, result) -> {:cancel, "round #{k} ran past #{cap_hours()} h"}
      true -> {:error, "referee: #{describe(result)}"}
    end
  end

  defp describe({:exit, code, _}), do: "exited with #{code}"
  defp describe({:stopped, reason}), do: "stopped (#{inspect(reason)})"
  defp describe(other), do: inspect(other)

  defp cap_hours, do: Float.round(Coord.Config.get(:round_cap_ms) / 3_600_000, 2)

  @impl Oban.Worker
  def backoff(_job), do: 30

  # two minutes above the round cap, so the referee's TERM and KILL come first
  @impl Oban.Worker
  def timeout(_job), do: Coord.Config.get(:round_cap_ms) + :timer.minutes(2)
end
