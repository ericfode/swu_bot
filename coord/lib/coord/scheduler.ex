defmodule Coord.Scheduler do
  @moduledoc """
  Decides when things happen; Node decides what.

  Phases: `:setup` (gamesctl setup; a failure stops the VM with 1), `:warming` (gamesctl warm; failures are only
  logged), then `:ready`. Ticks start when setup is done and come every 20 s, or at once on a wake or a round's
  end. A tick
    1. inserts an Intake job on every third tick (tick 0 is the first) and after a wake,
    2. when ready and no Intake or Round job is incomplete, runs gamesctl plan, and inserts a Round job for the
       round it names; a new round first waits out Eric's wait between rounds (Coord.Settings round_gap_ms) after
       the last round that finished (its end is kept on the volume, so a new boot keeps the wait), and the machine
       stays awake while it waits,
    3. stops the VM with 0 when the machine is idle (Coord.Scheduler.Policy.idle?/2); when a plan runs, that check
       waits for its answer, so a round about to be queued never meets an idle stop.
  Every Oban insert comes from this one process, so the Lite engine's uniqueness check (read, then insert) never
  races.
  """

  use GenServer

  import Ecto.Query

  require Logger

  alias Coord.{Config, Gamesctl}
  alias Coord.Scheduler.Policy

  @incomplete ~w(available scheduled executing retryable suspended)
  @workers %{"Coord.Workers.Intake" => :intake, "Coord.Workers.Round" => :round}

  @doc """
  Options: `stop:` the function that stops the VM (default System.stop/1, the tests pass their own), `restart:`
  whether this is a restart within one boot (default: whether a Scheduler ran before in this VM).
  """
  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "POST /wake: the idle clock starts again and an intake pass runs at once."
  def wake, do: GenServer.cast(__MODULE__, :wake)

  @doc "From the Intake worker: how many submissions are still open (nil: unknown) and how many were accepted."
  def intake_done(open, accepted), do: GenServer.cast(__MODULE__, {:intake_done, open, accepted})

  @doc "From the Round worker: round k ended with Coord.Proc's result."
  def round_done(k, result), do: GenServer.cast(__MODULE__, {:round_done, k, result})

  @impl true
  def init(opts) do
    restart? = Keyword.get_lazy(opts, :restart, fn -> :persistent_term.get({__MODULE__, :started}, false) end)

    if not restart? do
      :persistent_term.put({__MODULE__, :started}, true)
      :persistent_term.put({__MODULE__, :set_up}, false)
    end

    # A restart after this boot's setup does not run setup again: setup empties /data/intake (an intake pass may be
    # checking there now) and chowns the arena's folders under a running round. It is ready at once.
    set_up? = restart? and :persistent_term.get({__MODULE__, :set_up}, false)
    now = now()

    state = %{
      phase: if(set_up?, do: :ready, else: :setup),
      ticks: 0,
      woken: false,
      # the idle clock starts at boot; settled_at is when the last version came in (nil: none this
      # boot). After a restart (not a boot) both start now, which can only delay a round or the stop.
      busy_at: now,
      settled_at: if(restart?, do: now),
      settled_wall: if(restart?, do: System.os_time(:millisecond), else: 0),
      task: nil,
      plan: nil,
      timer: nil,
      stopped: false,
      warned: MapSet.new(),
      # when the last round that finished ended (wall clock, from the volume), the round now waiting out the wait
      # after it, and the last round this boot played (one that failed is not queued again, so it never waits)
      round_end: read_round_end(),
      waiting: nil,
      last_ran: nil,
      stop: Keyword.get(opts, :stop, &System.stop/1)
    }

    {:ok, state, {:continue, if(set_up?, do: :tick, else: :setup)}}
  end

  @impl true
  def handle_continue(:setup, state) do
    {:noreply, %{state | task: {:setup, Task.async(&Gamesctl.setup/0)}}}
  end

  def handle_continue(:tick, state), do: {:noreply, tick(state)}

  @impl true
  def handle_cast(:wake, state) do
    {:noreply, tick(%{state | busy_at: now(), woken: true})}
  end

  def handle_cast({:intake_done, open, accepted}, state) do
    change = Policy.after_intake(open, accepted)
    state = if change.busy, do: %{state | busy_at: now()}, else: state

    if change.settled do
      Coord.Pusher.poke()
      {:noreply, %{state | settled_at: now(), settled_wall: System.os_time(:millisecond)}}
    else
      {:noreply, state}
    end
  end

  def handle_cast({:round_done, k, result}, state) do
    Logger.info("round #{k} ended: #{describe(result)}")
    Coord.Pusher.poke()
    # only a round that finished starts the wait between rounds
    round_end = if match?({:exit, 0, _}, result), do: keep_round_end(), else: state.round_end
    {:noreply, tick(%{state | busy_at: now(), round_end: round_end, last_ran: k})}
  end

  @impl true
  def handle_info(:tick, state), do: {:noreply, tick(%{state | timer: nil})}

  def handle_info({ref, result}, %{task: {step, %Task{ref: ref}}} = state) do
    Process.demonitor(ref, [:flush])
    {:noreply, step_done(step, result, %{state | task: nil})}
  end

  def handle_info({ref, result}, %{plan: %Task{ref: ref}} = state) do
    Process.demonitor(ref, [:flush])
    {:noreply, planned(result, %{state | plan: nil})}
  end

  # anything else (a stray reply): a crash here would restart the Scheduler and reset both clocks
  def handle_info(_message, state), do: {:noreply, state}

  defp step_done(:setup, {:ok, out}, state) do
    Logger.info("set up; residents #{Enum.join(List.wrap(out["residents"]), ", ")}")
    if is_binary(out["toolchain"]), do: Logger.warning("toolchain: #{out["toolchain"]}")
    :persistent_term.put({__MODULE__, :set_up}, true)
    Coord.Pusher.poke()
    tick(%{state | phase: :warming, task: {:warm, Task.async(&Gamesctl.warm/0)}})
  end

  defp step_done(:setup, {:error, why}, state) do
    Logger.error("gamesctl setup failed (#{why}): stopping")
    state.stop.(1)
    %{state | stopped: true}
  end

  defp step_done(:warm, result, state) do
    case result do
      {:ok, %{warmed: warmed, failed: []}} -> Logger.info("warmed #{length(warmed)} resident bundles")
      {:ok, %{failed: failed}} -> Logger.warning("could not warm #{Enum.join(failed, ", ")}")
      {:error, why} -> Logger.warning("gamesctl warm failed (#{why})")
    end

    %{state | phase: :ready}
  end

  defp tick(%{phase: :setup} = state), do: state

  defp tick(state) do
    if state.timer, do: Process.cancel_timer(state.timer)

    if state.stopped or Coord.Shutdown.stopping?() do
      %{state | timer: nil}
    else
      state = maybe_intake(state)
      incomplete = incomplete_jobs()
      state = maybe_plan(state, incomplete)
      state = if state.plan == nil, do: maybe_stop(state, incomplete), else: state
      timer = if state.stopped, do: nil, else: Process.send_after(self(), :tick, Config.get(:tick_ms))
      %{state | ticks: state.ticks + 1, timer: timer}
    end
  end

  defp maybe_intake(state) do
    if Policy.intake_due?(state.phase, state) do
      case Oban.insert(Coord.Workers.Intake.new(%{})) do
        {:ok, _job} -> :ok
        {:error, reason} -> Logger.error("could not queue an intake pass: #{inspect(reason)}")
      end

      %{state | woken: false}
    else
      state
    end
  end

  defp maybe_plan(state, incomplete) do
    if Policy.plan?(%{phase: state.phase, incomplete: incomplete, planning: state.plan != nil}) do
      [arena | _] = Coord.Arena.all()
      settled_wall = state.settled_wall
      %{state | plan: Task.async(fn -> {arena, Gamesctl.plan(arena.id, settled_wall)} end)}
    else
      state
    end
  end

  # no round to play: this tick's idle check, which waited for the answer
  defp planned({_arena, {:ok, %{round: nil}}}, state), do: maybe_stop(state)

  # The idle check comes after the insert: a round queued now is an incomplete job, so the machine stays up; a round
  # that already ran (or failed twice) at this boot is not queued again, and must not keep the machine up for ever,
  # since only the next boot plays it.
  defp planned({arena, {:ok, %{round: k, why: why} = plan}}, state) do
    wait =
      if plan[:resume] or k == state.last_ran,
        do: 0,
        else: Policy.round_wait(state.round_end, Coord.Settings.round_gap_ms(), System.os_time(:millisecond))

    cond do
      state.stopped or Coord.Shutdown.stopping?() ->
        state

      # a round that waits keeps the machine awake: nothing else would wake it when the wait is over
      wait > 0 ->
        if state.waiting != k,
          do: Logger.info("round #{k} waits #{div(wait + 59_999, 60_000)} min (the wait between rounds)")

        %{state | waiting: k, busy_at: now()}

      true ->
        arena |> insert_round(k, why, %{state | waiting: nil}) |> maybe_stop()
    end
  end

  defp planned({_arena, {:error, why}}, state) do
    Logger.warning("gamesctl plan failed (#{why})")
    maybe_stop(state)
  end

  defp insert_round(arena, k, why, state) do
    args = %{"arena" => arena.id, "round" => k, "boot" => Coord.Boot.id()}

    case Oban.insert(Coord.Workers.Round.new(args)) do
      {:ok, %Oban.Job{conflict?: false}} ->
        Logger.info("round #{k} of #{arena.id} queued (#{why})")
        state

      {:ok, %Oban.Job{conflict?: true}} ->
        # it ran (or failed twice) at this boot already: it waits for the next boot
        if MapSet.member?(state.warned, {arena.id, k}) do
          state
        else
          Logger.warning("round #{k} of #{arena.id} already ran at this boot; it waits for the next boot")
          %{state | warned: MapSet.put(state.warned, {arena.id, k})}
        end

      {:error, reason} ->
        Logger.error("could not queue round #{k}: #{inspect(reason)}")
        state
    end
  end

  defp maybe_stop(state, incomplete \\ nil) do
    if state.stopped or Coord.Shutdown.stopping?(), do: state, else: stop_if_idle(state, incomplete)
  end

  defp stop_if_idle(state, incomplete) do
    facts = %{
      phase: state.phase,
      incomplete: incomplete || incomplete_jobs(),
      planning: state.plan != nil,
      children: Enum.map(Coord.Proc.running(), & &1.kind),
      busy_at: state.busy_at,
      settled_at: state.settled_at,
      idle_ms: Config.get(:idle_ms),
      settle_ms: Config.get(:settle_ms)
    }

    if Policy.idle?(facts, now()) do
      Logger.info("idle for #{div(now() - state.busy_at, 60_000)} minutes")
      state.stop.(0)
      %{state | stopped: true}
    else
      state
    end
  end

  @doc "The workers (:intake, :round) that have a job not yet done."
  def incomplete_jobs do
    query =
      from(j in Oban.Job,
        where: j.state in @incomplete and j.worker in ^Map.keys(@workers),
        distinct: true,
        select: j.worker
      )

    query |> Coord.Repo.all() |> Enum.map(&Map.fetch!(@workers, &1)) |> Enum.sort()
  end

  defp describe({:exit, code, _}), do: "exit #{code}"
  defp describe({:timeout, _}), do: "past the round cap"
  defp describe({:stopped, reason}), do: "stopped (#{inspect(reason)})"
  defp describe(other), do: inspect(other)

  defp now, do: System.monotonic_time(:millisecond)

  defp round_end_file, do: Path.join(Config.coord_dir(), "round_end")

  defp read_round_end do
    with {:ok, text} <- File.read(round_end_file()),
         {ms, ""} <- Integer.parse(String.trim(text)) do
      ms
    else
      _ -> nil
    end
  end

  # written whole, then renamed; a failed write only shortens the wait after the next boot
  defp keep_round_end do
    ms = System.os_time(:millisecond)
    tmp = round_end_file() <> ".tmp"

    with :ok <- File.mkdir_p(Config.coord_dir()),
         :ok <- File.write(tmp, Integer.to_string(ms)),
         :ok <- File.rename(tmp, round_end_file()) do
      :ok
    else
      {:error, reason} -> Logger.warning("could not keep the round's end on the volume (#{inspect(reason)})")
    end

    ms
  end
end
