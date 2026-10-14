defmodule Coord.Pusher do
  @moduledoc """
  Sends the arena's state, standings and round replays to the window (gamesctl push) every 20 s and when poked,
  from the first poke on: the Scheduler pokes it once setup is done.

  While a round plays (a referee child runs), it also sends the playing round's index and replays every 3 s
  (`gamesctl push --only round`, round_tick_ms), so viewers follow each game move by move: a game lasts about 17 s.
  A poke is a full push, and so is any push 20 s or more after the last full one.

  terminate/2 makes one last push of at most 7 s. It comes after the round has stopped: the Pusher starts before
  the FLAME pool, Oban, the Scheduler and Coord.Shutdown, so it stops after them.
  """

  use GenServer, shutdown: 9_000

  require Logger

  @last_timeout 6_000
  @last_grace 1_000

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "Push now (or right after the push in progress)."
  def poke, do: GenServer.cast(__MODULE__, :poke)

  @impl true
  def init(_opts) do
    Process.flag(:trap_exit, true)
    {:ok, %{started: false, task: nil, again: false, timer: nil, failing: false, full_at: nil, poked: false}}
  end

  @impl true
  def handle_cast(:poke, state), do: {:noreply, push_now(%{state | started: true, poked: true})}

  @impl true
  def handle_info(:tick, state), do: {:noreply, push_now(%{state | timer: nil})}

  def handle_info({ref, result}, %{task: %Task{ref: ref}} = state) do
    Process.demonitor(ref, [:flush])
    {:noreply, state |> report(result) |> after_push()}
  end

  def handle_info({:DOWN, ref, :process, _, reason}, %{task: %Task{ref: ref}} = state) do
    {:noreply, state |> report({:error, "crashed: #{inspect(reason)}"}) |> after_push()}
  end

  # the push task's link (this server traps exits for terminate/2)
  def handle_info({:EXIT, _, _}, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, %{started: true} = state) do
    # the push in progress stops first: two pushes would write the same state file
    if state.task do
      pids = Coord.Proc.stop_kind(:push, 500)
      Task.shutdown(state.task, :brutal_kill)
      wait_down(pids, 1_000)
    end

    Logger.info("last push")
    push_all(timeout: @last_timeout, grace: @last_grace)
  end

  def terminate(_reason, _state), do: :ok

  defp push_now(%{task: nil} = state) do
    if state.timer, do: Process.cancel_timer(state.timer)
    now = System.monotonic_time(:millisecond)

    full =
      state.poked or state.full_at == nil or now - state.full_at >= Coord.Config.get(:tick_ms) or not round_playing?()

    opts = if full, do: [], else: [only: :round]
    state = if full, do: %{state | full_at: now}, else: state
    %{state | task: Task.async(fn -> push_all(opts) end), again: false, timer: nil, poked: false}
  end

  defp push_now(state), do: %{state | again: true}

  defp after_push(state) do
    state = %{state | task: nil}

    cond do
      state.again -> push_now(state)
      round_playing?() -> %{state | timer: Process.send_after(self(), :tick, Coord.Config.get(:round_tick_ms))}
      true -> %{state | timer: Process.send_after(self(), :tick, Coord.Config.get(:tick_ms))}
    end
  end

  defp round_playing?, do: Enum.any?(Coord.Proc.running(), &(&1.kind == :referee))

  defp push_all(opts) do
    results = for arena <- Coord.Arena.all(), do: Coord.Gamesctl.push(arena.id, opts)
    Enum.find(results, {:ok, true}, &(&1 != {:ok, true}))
  end

  # gamesctl logs why a push failed; this only says when pushing starts or stops failing, not every 20 s
  defp report(state, {:ok, true}) do
    if state.failing, do: Logger.info("push works again")
    %{state | failing: false}
  end

  defp report(state, failure) do
    if not state.failing and not Coord.Shutdown.stopping?() do
      Logger.warning("push failed: #{describe(failure)}")
    end

    %{state | failing: true}
  end

  defp describe({:ok, false}), do: "the window refused it (see gamesctl's log)"
  defp describe({:error, why}), do: why

  defp wait_down(pids, timeout) do
    deadline = System.monotonic_time(:millisecond) + timeout

    for pid <- pids do
      ref = Process.monitor(pid)

      receive do
        {:DOWN, ^ref, :process, _, _} -> :ok
      after
        max(deadline - System.monotonic_time(:millisecond), 0) -> :ok
      end
    end
  end
end
