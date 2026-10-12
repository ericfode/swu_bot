defmodule Coord.Workers.Intake do
  @moduledoc """
  One intake pass (gamesctl intake): take the window's pending submissions, check them, enter the accepted ones.
  At most one pass waits behind the running one. Oban never retries a pass: the retry rules of a submission
  (tries, retryAt, stuck checks) live in intake.js and the window's documents, so they survive restarts.
  """

  use Oban.Worker,
    queue: :intake,
    max_attempts: 1,
    unique: [states: [:available, :scheduled], period: :infinity]

  require Logger

  @impl Oban.Worker
  # The pass waiting behind one that Coord.Shutdown stopped starts while Oban is still up: it does nothing (the
  # next boot runs a pass at once).
  def perform(%Oban.Job{}) do
    if Coord.Shutdown.stopping?(), do: :ok, else: pass()
  end

  defp pass do
    case Coord.Gamesctl.intake() do
      {:ok, %{open: open, accepted: accepted}} ->
        Coord.Scheduler.intake_done(open, accepted)

      {:error, why} ->
        if not Coord.Shutdown.stopping?(), do: Logger.warning("intake: #{why}")
        Coord.Scheduler.intake_done(nil, 0)
    end

    :ok
  end

  # a minute above gamesctl's own 65 minutes, so its TERM and KILL come first
  @impl Oban.Worker
  def timeout(_job), do: :timer.minutes(66)
end
