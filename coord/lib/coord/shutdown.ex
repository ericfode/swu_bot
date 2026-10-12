defmodule Coord.Shutdown do
  @moduledoc """
  The first step of a stop, by its place in the tree: started just before the Endpoint, it terminates right after
  it. It sets the stop flag, sends TERM to every child group but a push (the referee, an intake pass, a plan, a
  warm), and waits for them, so the jobs return before Oban's grace period and the Pusher's last push comes after
  the round has stopped. Groups still running after 8 s get KILL.
  """

  use GenServer, shutdown: 11_000

  require Logger

  @grace 8_000
  @wait 10_000

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "Whether the coordinator is stopping: the Scheduler stops ticking and jobs snooze or return."
  def stopping?, do: :persistent_term.get({__MODULE__, :stopping}, false)

  @impl true
  def init(_opts) do
    Process.flag(:trap_exit, true)
    set_stopping(false)
    {:ok, %{}}
  end

  @impl true
  def terminate(_reason, _state) do
    set_stopping(true)
    pids = Coord.Proc.stop_all([:push], @grace)
    if pids != [], do: Logger.info("stopping #{length(pids)} child groups")
    refs = for pid <- pids, do: Process.monitor(pid)
    deadline = System.monotonic_time(:millisecond) + @wait
    Enum.each(refs, &await(&1, deadline))
  end

  defp await(ref, deadline) do
    receive do
      {:DOWN, ^ref, :process, _, _} -> :ok
    after
      max(deadline - System.monotonic_time(:millisecond), 0) -> :ok
    end
  end

  @doc false
  # only changes at boot and at the stop, so the global GC a persistent_term update costs does not matter
  def set_stopping(value) when is_boolean(value) do
    if stopping?() != value, do: :persistent_term.put({__MODULE__, :stopping}, value)
  end
end
