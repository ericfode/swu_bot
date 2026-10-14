defmodule Coord.Helper do
  @moduledoc """
  The helper role (COORD_ROLE=helper): the games image run in Docker on someone's computer, which plays whole seeds
  for the games machine's rounds (bot/arena/HELPER.md). It reaches the machine through `fly proxy` at
  GAMES_HELPER_URL with its own token (GAMES_HELPER_TOKEN), and it listens on nothing.

  At start it compiles the resident bundles the image builds, if any (play-seed.js --warm, as the bots' user; a failure
  is only logged), then says hello, which checks that both run the same build and card data:
    * 200: GAMES_HELPER_SLOTS slots (Coord.Helper.Slot) start claiming seeds
    * 409: the machine runs another build; the log names the image to pull and the VM stops with 3, which the
      script on the computer takes as "pull it and start again"
    * 401: the token is not one the machine knows; the VM stops with 1
    * no answer (the machine is stopped most of the time): hello again every 30 s, for ever
  A slot that crashes is started again 5 s later.
  """

  use GenServer, shutdown: 10_000

  require Logger

  alias Coord.Config
  alias Coord.Helper.{Client, Play, Slot}

  @restart_ms 5_000
  @slot_stop_ms 8_000

  @doc """
  Before the tree (Coord.Application.start_tree/2): keeps the helper token (and takes it out of the environment),
  reaps the child groups a crashed run left, and makes the folders: <data>/coord for the pidfiles (0700),
  <data>/helper for the work folders (0700; 0711 when the plays run as the bots' user, who must reach their own
  folder in it), and the bots' HOME and wasm cache, which are theirs.
  """
  def prepare! do
    Coord.Secrets.take_helper!()
    File.mkdir_p!(Config.coord_dir())
    File.chmod!(Config.coord_dir(), 0o700)
    File.mkdir_p!(Config.procs_dir())
    Coord.Proc.reap_stale()

    bots_user? = Coord.Proc.isolation() == :setpriv
    ids = if bots_user?, do: bots_ids!()

    # the plays of a run that crashed are gone (reaped), and so are their work folders
    dir = Config.helper_dir()
    File.rm_rf!(dir)
    File.mkdir_p!(dir)
    File.chmod!(dir, if(bots_user?, do: 0o711, else: 0o700))

    for sub <- ["home", "wasm-cache"] do
      path = Path.join(Config.data(), sub)
      File.mkdir_p!(path)

      if ids do
        {uid, gid} = ids
        :ok = :file.change_owner(path, uid, gid)
      end
    end

    :ok
  end

  defp bots_ids! do
    case Coord.Proc.user_ids() do
      {:ok, ids} -> ids
      {:error, _} -> raise "no user #{Config.get(:arena_user)}: the plays could not run as the bots' user"
    end
  end

  @doc "The message for a 409: the build the machine runs and the image to pull."
  def wrong_build(want) do
    "the games machine runs build #{printable(want["build"])}: pull #{printable(want["image"])} and start it " <>
      "(stopping with 3)"
  end

  def unauthorized, do: "the games machine does not know this helper's token (stopping with 1)"

  @doc "Options: `stop:` the function that stops the VM (default System.stop/1; the tests pass their own)."
  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @impl true
  def init(opts) do
    # the slots are linked: one that crashes is started again, and terminate/2 stops them in order
    Process.flag(:trap_exit, true)
    state = %{stop: Keyword.get(opts, :stop, &System.stop/1), task: nil, slots: %{}, timing: nil, failing: nil}
    {:ok, state, {:continue, :warm}}
  end

  @impl true
  def handle_continue(:warm, state), do: {:noreply, %{state | task: {:warm, Task.async(&Play.warm/0)}}}

  @impl true
  def handle_info({ref, result}, %{task: {step, %Task{ref: ref}}} = state) do
    Process.demonitor(ref, [:flush])
    {:noreply, step_done(step, result, %{state | task: nil})}
  end

  def handle_info({:DOWN, ref, :process, _pid, _reason}, %{task: {step, %Task{ref: ref}}} = state) do
    {:noreply, step_done(step, {:error, "crashed"}, %{state | task: nil})}
  end

  def handle_info(:hello, state), do: {:noreply, hello(state)}

  def handle_info({:restart, id}, state), do: {:noreply, start_slot(state, id)}

  # a slot that ended: started again a little later, unless the VM is stopping
  def handle_info({:EXIT, pid, reason}, %{slots: slots} = state) when is_map_key(slots, pid) do
    {id, slots} = Map.pop(slots, pid)
    Logger.error("slot #{id} ended (#{String.slice(inspect(reason), 0, 200)}); starting it again in 5 s")
    Process.send_after(self(), {:restart, id}, @restart_ms)
    {:noreply, %{state | slots: slots}}
  end

  # the tasks' links, and late messages
  def handle_info(_message, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, state) do
    # each slot gives its seed back (Slot.terminate/2) before ProcSup, which stops after this, kills the plays
    for {pid, _id} <- state.slots, do: Process.exit(pid, :shutdown)
    deadline = System.monotonic_time(:millisecond) + @slot_stop_ms

    for {pid, _id} <- state.slots do
      receive do
        {:EXIT, ^pid, _} -> :ok
      after
        max(deadline - System.monotonic_time(:millisecond), 0) -> :ok
      end
    end

    :ok
  end

  defp step_done(:warm, result, state) do
    case result do
      {:ok, %{warmed: warmed, failed: []}} -> Logger.info("warmed #{length(warmed)} resident bundles")
      {:ok, %{failed: failed}} -> Logger.warning("could not warm #{Enum.join(failed, ", ")}")
      {:failed, why} -> Logger.warning("play-seed --warm failed (#{why})")
      {:error, why} -> Logger.warning("play-seed --warm failed (#{why})")
    end

    hello(state)
  end

  defp step_done(:hello, {:ok, timing}, state) do
    Logger.info("the games machine knows this helper as #{timing.name}; #{Config.get(:helper_slots)} slots claim seeds")
    state = %{state | timing: timing, failing: nil}
    Enum.reduce(1..Config.get(:helper_slots), state, &start_slot(&2, Integer.to_string(&1)))
  end

  defp step_done(:hello, {:build, want}, state), do: stop_vm(state, 3, wrong_build(want))
  defp step_done(:hello, :unauthorized, state), do: stop_vm(state, 1, unauthorized())

  defp step_done(:hello, {:error, why}, state) do
    retry_ms = Config.get(:hello_retry_ms)

    if state.failing != why do
      Logger.warning("hello: no answer from the games machine (#{why}); trying every #{div(retry_ms, 1000)} s")
    end

    Process.send_after(self(), :hello, retry_ms)
    %{state | failing: why}
  end

  defp hello(state) do
    slots = Config.get(:helper_slots)
    %{state | task: {:hello, Task.async(fn -> Client.hello(slots) end)}}
  end

  defp start_slot(state, id) do
    {:ok, pid} = Slot.start_link(id: id, timing: state.timing, stop: state.stop)
    %{state | slots: Map.put(state.slots, pid, id)}
  end

  defp stop_vm(state, code, message) do
    Logger.error(message)
    state.stop.(code)
    state
  end

  defp printable(value) when is_binary(value), do: value |> String.replace(~r/[^\w.:\/@-]/, "?") |> String.slice(0, 200)
  defp printable(value), do: printable(inspect(value))
end
