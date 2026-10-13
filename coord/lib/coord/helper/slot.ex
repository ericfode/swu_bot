defmodule Coord.Helper.Slot do
  @moduledoc """
  One seed at a time on a helper. The loop: claim (a long poll); on a lease, play it in a task (Coord.Helper.Play)
  and heartbeat every heartbeatMs meanwhile; post the result; remove the work folder; claim again. A seed is never
  played twice here: whatever happens, the lease ends with its result, a failure, or the machine taking it back.

    * claim: 204 claims again at once; no answer (the machine may be stopped) backs off 5, 10, 20, 40, then 60 s
      until one comes; 409 (the machine runs another build) stops the VM with 3, 401 with 1
    * heartbeat: 410 stops the play and drops the lease; no answer keeps playing (the machine decides)
    * suspend: when the wall clock and the monotonic clock moved apart by more than 20 s since the last heartbeat
      (the computer slept), the play stops and the lease fails with "the computer slept"
  """

  use GenServer, restart: :temporary

  require Logger

  alias Coord.Helper.{Client, Play}

  @slept_ms 20_000
  @post_tries 3
  @post_gap_ms 5_000

  @doc "Options: `id:` the slot's id (\"1\" to \"16\"), `timing:` hello's %{heartbeat_ms, claim_ms}, `stop:`."
  def start_link(opts), do: GenServer.start_link(__MODULE__, opts)

  @doc """
  Whether the computer slept between two heartbeats: the wall clock and the monotonic clock (which stands still
  while the computer sleeps) moved apart by more than limit ms. Each tick is {wall ms, monotonic ms}.
  """
  def slept?({wall0, mono0}, {wall1, mono1}, limit \\ @slept_ms) do
    abs(wall1 - wall0 - (mono1 - mono0)) > limit
  end

  @impl true
  def init(opts) do
    # the play's task is linked; a crash in it is a failed lease, not a dead slot
    Process.flag(:trap_exit, true)
    id = Keyword.fetch!(opts, :id)

    state = %{
      id: id,
      # each slot's plays are their own Coord.Proc kind, so that one slot stops its play and no other
      kind: String.to_atom("play-" <> id),
      timing: Keyword.fetch!(opts, :timing),
      stop: Keyword.fetch!(opts, :stop),
      task: nil,
      lease: nil,
      beat: nil,
      tick: nil,
      backoff: 0,
      failing: nil,
      stopped: false
    }

    {:ok, state, {:continue, :claim}}
  end

  @impl true
  def handle_continue(:claim, state), do: {:noreply, claim(state)}

  @impl true
  def handle_info(:claim, state), do: {:noreply, claim(state)}

  def handle_info({ref, result}, %{task: {what, %Task{ref: ref}}} = state) do
    Process.demonitor(ref, [:flush])
    state = %{state | task: nil}

    case what do
      :claim -> {:noreply, claimed(result, state)}
      :play -> {:noreply, played(result, state)}
    end
  end

  def handle_info({:DOWN, ref, :process, _pid, reason}, %{task: {what, %Task{ref: ref}}} = state) do
    Logger.error("slot #{state.id}: the #{what} task crashed (#{String.slice(inspect(reason), 0, 200)})")
    state = %{state | task: nil}

    case what do
      :claim -> {:noreply, claimed({:error, "the claim crashed"}, state)}
      :play -> {:noreply, played({:failed, "the helper crashed while playing"}, state)}
    end
  end

  def handle_info(:beat, %{lease: nil} = state), do: {:noreply, state}
  def handle_info(:beat, state), do: {:noreply, beat(%{state | beat: nil})}

  # the tasks' links (this server traps exits), and late messages
  def handle_info(_message, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, %{lease: %{} = lease} = state) do
    # The helper is stopping (docker stop, or a build mismatch): the machine gets the seed back at once instead of
    # after a missed heartbeat. ProcSup, which stops after the helper, kills what is left of the play.
    post(lease, failed_json("the helper stopped"), 1, 3_000)
    if match?({:play, _}, state.task), do: Task.shutdown(elem(state.task, 1), :brutal_kill)
    File.rm_rf(lease.dir)
    :ok
  end

  def terminate(_reason, _state), do: :ok

  # --- claiming

  defp claim(%{stopped: true} = state), do: state

  defp claim(state) do
    %{id: id, timing: %{claim_ms: claim_ms}} = state
    %{state | task: {:claim, Task.async(fn -> Client.claim(id, claim_ms) end)}}
  end

  defp claimed({:lease, lease}, state) do
    state = answered(state)
    dir = Path.join([Coord.Config.helper_dir(), state.id, lease.id])
    kind = state.kind
    # a minute before the machine's deadline, so the failure reaches it first
    timeout = max(lease.deadline_ms - 60_000, 60_000)
    task = Task.async(fn -> Play.run(lease, dir, kind, timeout) end)
    lease = Map.merge(lease, %{dir: dir, started: now()})
    beat = Process.send_after(self(), :beat, state.timing.heartbeat_ms)
    %{state | task: {:play, task}, lease: lease, beat: beat, tick: ticks()}
  end

  defp claimed(:none, state), do: state |> answered() |> claim()
  defp claimed({:build, want}, state), do: stop_vm(state, 3, Coord.Helper.wrong_build(want))
  defp claimed(:unauthorized, state), do: stop_vm(state, 1, Coord.Helper.unauthorized())

  defp claimed({:error, why}, state) do
    delays = Coord.Config.get(:claim_backoff_ms)
    delay = Enum.at(delays, state.backoff, List.last(delays))

    if state.failing != why do
      Logger.warning("slot #{state.id}: no claim (#{why}); trying again, the next in #{div(delay, 1000)} s")
    end

    Process.send_after(self(), :claim, delay)
    %{state | backoff: state.backoff + 1, failing: why}
  end

  defp answered(%{failing: nil} = state), do: state

  defp answered(state) do
    Logger.info("slot #{state.id}: the games machine answers again")
    %{state | backoff: 0, failing: nil}
  end

  # --- playing

  defp beat(state) do
    tick = ticks()

    if slept?(state.tick, tick) do
      Logger.warning("lease #{state.lease.id}: the computer slept; the seed goes back to the games machine")
      state |> stop_play() |> finish_lease({:failed, "the computer slept"})
    else
      case Client.heartbeat(state.lease.id) do
        :gone ->
          Logger.info("lease #{state.lease.id}: the games machine took it back (410); stopping its play")
          state |> stop_play() |> drop_lease()

        {:build, want} ->
          stop_vm(state, 3, Coord.Helper.wrong_build(want))

        :unauthorized ->
          stop_vm(state, 1, Coord.Helper.unauthorized())

        # :ok, or no answer: playing on, the machine decides
        _ ->
          beat = Process.send_after(self(), :beat, state.timing.heartbeat_ms)
          %{state | beat: beat, tick: tick}
      end
    end
  end

  defp played({:ok, json, results}, state) do
    lease = state.lease
    answer = post(lease, json, @post_tries, 120_000)
    Logger.info("lease #{lease.id} (seed #{seed(lease)}): #{outcomes(results)}; #{seconds(lease)} s#{answer}")
    drop_lease(state)
  end

  defp played({:failed, why}, state), do: finish_lease(state, {:failed, why})

  defp finish_lease(state, {:failed, why}) do
    lease = state.lease
    answer = post(lease, failed_json(why), @post_tries, 120_000)
    Logger.info("lease #{lease.id} (seed #{seed(lease)}): failed (#{why}); #{seconds(lease)} s#{answer}")
    drop_lease(state)
  end

  # the work folder goes, and the slot claims again
  defp drop_lease(state) do
    if state.beat, do: Process.cancel_timer(state.beat)
    File.rm_rf(state.lease.dir)
    claim(%{state | lease: nil, beat: nil, tick: nil, task: nil})
  end

  # The task goes first; its Coord.Proc then sees its caller go, sends TERM to the play's group and KILL after the
  # grace period. The work folder is removed only once that group is gone.
  defp stop_play(%{task: {:play, task}} = state) do
    Task.shutdown(task, :brutal_kill)
    pids = for %{pid: pid, kind: kind} <- Coord.Proc.running(), kind == state.kind, do: pid
    wait_down(pids, Play.grace() + 5_000)
    %{state | task: nil}
  end

  defp stop_play(state), do: state

  defp wait_down(pids, timeout) do
    deadline = now() + timeout

    for pid <- pids do
      ref = Process.monitor(pid)

      receive do
        {:DOWN, ^ref, :process, _, _} -> :ok
      after
        max(deadline - now(), 0) -> :ok
      end
    end
  end

  # A result is posted again (at most 3 times, 5 s apart) only when no answer came; never the seed. A 410 is fine:
  # the machine took the lease back meanwhile.
  defp post(lease, json, tries, timeout) do
    case Client.result(lease.id, json, timeout) do
      :ok ->
        ""

      :gone ->
        " (the games machine no longer wanted it)"

      {:error, _why} when tries > 1 ->
        Process.sleep(@post_gap_ms)
        post(lease, json, tries - 1, timeout)

      other ->
        " (not sent: #{describe(other)})"
    end
  end

  defp failed_json(why), do: Jason.encode!(%{failed: String.slice(why, 0, 300)})

  defp stop_vm(state, code, message) do
    Logger.error(message)
    state.stop.(code)
    %{state | stopped: true}
  end

  defp describe({:error, why}), do: why
  defp describe(:unauthorized), do: "unauthorized"
  defp describe({:build, _want}), do: "another build"
  defp describe(other), do: inspect(other)

  # one game per entry: its id, outcome and winning seat ("won p1", "STEP_CAP")
  defp outcomes(results) do
    Enum.map_join(results, ", ", fn %{"id" => id, "result" => result} ->
      seat = if is_binary(result["winnerSeat"]), do: " " <> result["winnerSeat"], else: ""
      "#{printable(id)} #{printable(result["outcome"])}#{printable(seat)}"
    end)
  end

  defp seed(%{job: %{"seed" => seed}}) when is_integer(seed), do: seed
  defp seed(_lease), do: "?"

  defp seconds(lease), do: div(now() - lease.started, 1000)

  defp printable(value) when is_binary(value), do: value |> String.replace(~r/[^\w .:-]/, "?") |> String.slice(0, 80)
  defp printable(value), do: printable(inspect(value))

  defp ticks, do: {System.os_time(:millisecond), System.monotonic_time(:millisecond)}
  defp now, do: System.monotonic_time(:millisecond)
end
