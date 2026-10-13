defmodule Coord.Proc do
  @moduledoc """
  The only code that starts OS processes (test/coord/source_scan_test.exs checks it).

  A child gets exactly the environment it is given: every variable the BEAM has is unset through the Port's :env.
  The Port makes it a session leader, so its pid is its process group, and stopping it signals the whole group:
  TERM, then KILL after a grace period. Each child has a pidfile in GAMES_DATA/coord/procs, so that the next boot
  can reap a group that outlived a crashed BEAM (reap_stale/0).
  """

  use GenServer, restart: :temporary, shutdown: 10_000

  require Logger

  @max_stdout 1_048_576
  @line_bytes 65_536
  @default_path "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

  @type result :: {:exit, non_neg_integer(), binary()} | {:timeout, binary()} | {:stopped, term()}

  @doc """
  Runs argv to its end under Coord.ProcSup and returns what happened. Options:

    * `env:` the child's whole environment (a map); nothing is inherited
    * `as:` `:root` (default) or `:arena`, which wraps the command when the BEAM is root: in isolate.sh --user arena
      on the games machine, in setpriv on a helper (Coord.Config isolate :user)
    * `tmp:` the folder isolate.sh puts in place of /tmp (default GAMES_DATA/tmp/<kind>)
    * `cd:` the working folder (default GAMES_APP)
    * `timeout:`, `grace:` ms before TERM (default :infinity), then ms before KILL (default 5000)
    * `stdout:` `:capture` (returned, at most `max_stdout:` bytes) or `:log` (each line to Logger as "[kind] ...")

  The child is stopped when it runs past its timeout, when the calling process exits, or on stop_all/2. Once the
  coordinator is stopping (Coord.Shutdown), only a push may start: anything else would miss Shutdown's TERM.
  """
  @spec run(atom(), [String.t()], keyword()) :: result()
  def run(kind, argv, opts \\ []) when is_atom(kind) and is_list(argv) do
    case DynamicSupervisor.start_child(Coord.ProcSup, {__MODULE__, {kind, argv, opts, self()}}) do
      {:ok, pid} -> await(pid)
      :ignore -> {:stopped, :stopping}
      {:error, reason} -> {:stopped, reason}
    end
  end

  defp await(pid) do
    ref = Process.monitor(pid)

    receive do
      {__MODULE__, ^pid, result} ->
        Process.demonitor(ref, [:flush])
        result

      {:DOWN, ^ref, :process, ^pid, reason} ->
        {:stopped, reason}
    end
  end

  @doc "The children running now: [%{pid, kind, pgid}]."
  def running do
    if Process.whereis(Coord.ProcSup) do
      for {_, pid, _, _} <- DynamicSupervisor.which_children(Coord.ProcSup), is_pid(pid), info = info(pid), do: info
    else
      []
    end
  end

  defp info(pid) do
    GenServer.call(pid, :info, 5_000)
  catch
    :exit, _ -> nil
  end

  @doc "Sends TERM to every child whose kind is not in `except`, and KILL `grace` ms later. Returns their pids."
  def stop_all(except, grace) do
    for %{pid: pid, kind: kind} <- running(), kind not in except do
      GenServer.cast(pid, {:stop, grace})
      pid
    end
  end

  @doc "Sends TERM to every child of this kind, and KILL `grace` ms later. Returns their pids."
  def stop_kind(kind, grace) do
    for %{pid: pid, kind: ^kind} <- running() do
      GenServer.cast(pid, {:stop, grace})
      pid
    end
  end

  @doc "KILLs the group of every pidfile left by an earlier run of this kernel whose leader still runs."
  def reap_stale do
    dir = Coord.Config.procs_dir()
    boot = kernel_boot()

    names =
      case File.ls(dir) do
        {:ok, names} -> names
        {:error, _} -> []
      end

    for name <- names, String.ends_with?(name, ".json") do
      file = Path.join(dir, name)

      # the start time and boot id make sure the pid was not reused by something else since
      with {:ok, text} <- File.read(file),
           {:ok, %{"pgid" => pgid, "start" => start, "kernel_boot" => ^boot} = entry} when is_integer(pgid) <-
             Jason.decode(text),
           true <- start != nil and start_time(pgid) == start do
        Logger.warning("killing the #{entry["kind"]} group #{pgid}, left over from an earlier run")
        signal_group(pgid, "KILL")
      end

      File.rm(file)
    end

    :ok
  end

  @doc "Whether the BEAM runs as root (its effective uid is 0)."
  def root? do
    case File.read("/proc/self/status") do
      {:ok, status} -> Regex.match?(~r/^Uid:\s+\d+\s+0\s/m, status)
      {:error, _} -> false
    end
  end

  @doc false
  # The argv the Port starts: choom first when there is one (the kernel's OOM killer then picks a ladder or a check
  # before the BEAM), and for an arena child when the BEAM is root, isolate.sh or setpriv (no wrapper without root,
  # as games.js). {:error, {:no_user, name}} when setpriv's user does not exist: nothing may run as root instead.
  def command_line(kind, argv, opts) do
    wrapped =
      case {Keyword.get(opts, :as, :root), isolation()} do
        {:arena, :isolate} -> {:ok, isolate_argv(kind, opts) ++ argv}
        {:arena, :setpriv} -> with {:ok, {uid, gid}} <- user_ids(), do: {:ok, setpriv_argv(uid, gid) ++ argv}
        _ -> {:ok, argv}
      end

    with {:ok, argv} <- wrapped do
      case choom() do
        nil -> {:ok, argv}
        choom -> {:ok, [choom, "-n", "300", "--" | argv]}
      end
    end
  end

  @doc false
  # as isolate.sh's --user: no supplementary groups, no capabilities and no way to gain any (no setuid programs)
  def setpriv_argv(uid, gid) do
    ["setpriv", "--reuid=#{uid}", "--regid=#{gid}", "--clear-groups", "--inh-caps=-all", "--bounding-set=-all"] ++
      ["--no-new-privs", "--"]
  end

  defp isolate_argv(kind, opts) do
    data = Coord.Config.data()
    tmp = Keyword.get(opts, :tmp, Path.join([data, "tmp", Atom.to_string(kind)]))

    ["bash", Path.join(Coord.Config.app(), "bot/arena/ops/isolate.sh")] ++
      ["--user", Coord.Config.get(:arena_user), "--tmp", tmp] ++
      ["--hide", "/.fly", "--hide", Path.join(data, "secret"), "--hide", Coord.Config.coord_dir(), "--"]
  end

  @doc "Whether arena children are wrapped in isolate.sh: when the BEAM is root, unless Coord.Config isolate says."
  def isolate?, do: isolation() == :isolate

  @doc """
  How an arena child is wrapped: `:isolate` (isolate.sh: its own PID and mount namespaces, as the bots' user),
  `:setpriv` (only the bots' user, no namespaces: a helper, whose Docker container is the boundary) or `:none`.
  Coord.Config isolate is :auto (isolate.sh when the BEAM is root), :user (setpriv when root), true or false.
  """
  def isolation do
    case Coord.Config.get(:isolate) do
      :auto -> if root?(), do: :isolate, else: :none
      :user -> if root?(), do: :setpriv, else: :none
      true -> :isolate
      _ -> :none
    end
  end

  @doc """
  The uid and gid of the bots' user (Coord.Config arena_user), from `id -u` and `id -g`: {:ok, {uid, gid}}, or
  {:error, {:no_user, name}}. Looked up once; a failed lookup is tried again next time.
  """
  def user_ids(user \\ Coord.Config.get(:arena_user)) do
    case :persistent_term.get({__MODULE__, :ids, user}, nil) do
      nil ->
        with {:ok, uid} <- id_of(user, "-u"),
             {:ok, gid} <- id_of(user, "-g") do
          :persistent_term.put({__MODULE__, :ids, user}, {uid, gid})
          {:ok, {uid, gid}}
        end

      ids ->
        {:ok, ids}
    end
  end

  # a name id could read as an option or a number is never asked about
  defp id_of(user, flag) do
    with true <- Regex.match?(~r/^[a-z_][a-z0-9_-]{0,31}$/, user),
         {:ok, file} <- executable("id", @default_path),
         {0, out} <- short_command(file, [flag, user]),
         {n, ""} when n >= 0 <- Integer.parse(String.trim(out)) do
      {:ok, n}
    else
      _ -> {:error, {:no_user, user}}
    end
  end

  # a quick command whose output is a line or two (id): its exit code and stdout, or :error after 5 s
  defp short_command(file, args) do
    port =
      Port.open({:spawn_executable, file}, [
        :binary,
        :exit_status,
        :stderr_to_stdout,
        {:args, args},
        {:env, env_list(%{"PATH" => "/usr/bin:/bin"})}
      ])

    collect(port, "")
  end

  defp collect(port, out) do
    receive do
      {^port, {:data, data}} -> collect(port, out <> data)
      {^port, {:exit_status, code}} -> {code, out}
    after
      5_000 ->
        Port.close(port)
        :error
    end
  end

  defp choom do
    case Coord.Config.get(:choom) do
      :auto -> System.find_executable("choom")
      path when is_binary(path) -> path
      _ -> nil
    end
  end

  # --- the server, one per child

  def start_link(arg), do: GenServer.start_link(__MODULE__, arg)

  @impl true
  def init({kind, [exe | args], opts, caller}) do
    # Checked here, inside ProcSup's start_child: Coord.Shutdown sets the flag before it lists the children
    # (which_children waits for this start), so a child is either refused or in that list and gets its TERM.
    if kind != :push and Coord.Shutdown.stopping?(), do: :ignore, else: start(kind, exe, args, opts, caller)
  end

  defp start(kind, exe, args, opts, caller) do
    Process.flag(:trap_exit, true)
    env = Map.new(Keyword.get(opts, :env, %{}))

    # the command is looked up in the child's own PATH, and a missing one is an error here, not choom's exit 127
    with {:ok, file} <- executable(exe, Map.get(env, "PATH", @default_path)),
         {:ok, cmd} <- command_line(kind, [file | args], opts),
         {:ok, port, pgid} <- open(cmd, env, Keyword.get(opts, :cd, Coord.Config.app())) do
      timeout = Keyword.get(opts, :timeout, :infinity)

      state = %{
        kind: kind,
        port: port,
        pgid: pgid,
        caller: caller,
        caller_ref: Process.monitor(caller),
        pidfile: write_pidfile(kind, pgid),
        grace: Keyword.get(opts, :grace, 5_000),
        timeout: timeout,
        timer: if(timeout == :infinity, do: nil, else: Process.send_after(self(), :timeout, timeout)),
        kill_timer: nil,
        close_timer: nil,
        stopping: nil,
        exit_code: nil,
        mode: Keyword.get(opts, :stdout, :capture),
        max: Keyword.get(opts, :max_stdout, @max_stdout),
        out: [],
        size: 0,
        partial: ""
      }

      {:ok, state}
    else
      {:error, reason} ->
        Logger.error("[#{kind}] could not start #{exe}: #{inspect(reason)}")
        {:stop, {:spawn_failed, reason}}
    end
  end

  defp open([exe | args], env, cd) do
    with {:ok, file} <- executable(exe, @default_path),
         {:ok, port} <- open_port(file, args, env, cd) do
      # a child that is already done (its Port closed) has no group left to look after: nil
      case Port.info(port, :os_pid) do
        {:os_pid, pgid} -> {:ok, port, pgid}
        nil -> {:ok, port, nil}
      end
    end
  end

  defp open_port(file, args, env, cd) do
    options = [:binary, :exit_status, {:line, @line_bytes}, {:cd, cd}, {:args, args}, {:env, env_list(env)}]
    {:ok, Port.open({:spawn_executable, file}, options)}
  rescue
    e in ErlangError -> {:error, e.original}
  end

  defp executable(exe, path) do
    cond do
      String.contains?(exe, "/") and File.regular?(exe) ->
        {:ok, exe}

      String.contains?(exe, "/") ->
        {:error, {:not_found, exe}}

      true ->
        case :os.find_executable(String.to_charlist(exe), String.to_charlist(path)) do
          false -> {:error, {:not_found, exe}}
          found -> {:ok, List.to_string(found)}
        end
    end
  end

  # every variable of the BEAM's own environment is unset, so the child sees exactly `env`
  defp env_list(env) do
    clear = for {k, _} <- System.get_env(), not Map.has_key?(env, k), do: {String.to_charlist(k), false}
    clear ++ for {k, v} <- env, do: {String.to_charlist(k), String.to_charlist(v)}
  end

  @impl true
  def handle_call(:info, _from, state), do: {:reply, %{pid: self(), kind: state.kind, pgid: state.pgid}, state}

  @impl true
  def handle_cast({:stop, grace}, state), do: {:noreply, stop_group(state, :stop, grace)}

  @impl true
  def handle_info({port, {:data, {eol, data}}}, %{port: port} = state), do: {:noreply, output(state, eol, data)}

  # The child exited, and so did everything that held its stdout: the Port reports an exit only after the end of
  # stdout, then closes. Whatever is left in the group (a backgrounded process without stdout) is killed; the result
  # goes out when the Port closes.
  def handle_info({port, {:exit_status, code}}, %{port: port} = state) do
    for t <- [state.timer, state.kill_timer], t != nil, do: Process.cancel_timer(t)
    signal_group(state.pgid, "KILL")
    close_timer = state.close_timer || Process.send_after(self(), :close, 2_000)
    {:noreply, %{state | exit_code: code, timer: nil, kill_timer: nil, close_timer: close_timer}}
  end

  def handle_info({:EXIT, port, reason}, %{port: port} = state) do
    if state.exit_code == nil, do: signal_group(state.pgid, "KILL")
    finish(state, reason)
  end

  def handle_info(:close, %{port: port} = state) when port != nil do
    # the Port may have closed a moment ago, its EXIT still in the mailbox
    try do
      Port.close(port)
    rescue
      ArgumentError -> :ok
    end

    finish(state, :closed)
  end

  def handle_info(:timeout, state) do
    Logger.warning("[#{state.kind}] still running after #{state.timeout} ms: stopping its group")
    {:noreply, stop_group(state, :timeout, state.grace)}
  end

  def handle_info(:kill, %{exit_code: nil} = state) do
    signal_group(state.pgid, "KILL")
    # A process outside the group (one that made its own session) may still hold stdout, and then the Port would
    # report nothing for ever: the caller would wait for ever, and the idle check would see this child running.
    close_timer = state.close_timer || Process.send_after(self(), :close, 2_000)
    {:noreply, %{state | kill_timer: nil, close_timer: close_timer}}
  end

  def handle_info({:DOWN, ref, :process, _, _}, %{caller_ref: ref} = state) do
    {:noreply, stop_group(state, :caller_down, state.grace)}
  end

  # the short-lived ports of signal_group/2, and late timers
  def handle_info(_message, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, %{port: port} = state) when port != nil do
    # ProcSup is stopping (the last step of a shutdown) or this server crashed: nothing may outlive it
    if state.exit_code == nil, do: signal_group(state.pgid, "KILL")
    remove_pidfile(state.pidfile)
  end

  def terminate(_reason, _state), do: :ok

  defp stop_group(%{stopping: nil, exit_code: nil} = state, why, grace) do
    signal_group(state.pgid, "TERM")
    %{state | stopping: why, kill_timer: Process.send_after(self(), :kill, grace)}
  end

  # already stopping (the first reason stands, and so does its KILL), or already exited
  defp stop_group(state, _why, _grace), do: state

  defp finish(state, port_reason) do
    if state.close_timer, do: Process.cancel_timer(state.close_timer)
    flush_partial(state)
    remove_pidfile(state.pidfile)
    out = state.out |> Enum.reverse() |> IO.iodata_to_binary()

    # a child that was told to stop gets the reason it was told, even when its Port had to be closed
    result =
      case {state.stopping, state.exit_code} do
        {:caller_down, _} -> nil
        {:timeout, _} -> {:timeout, out}
        {:stop, _} -> {:stopped, :shutdown}
        {nil, nil} -> {:stopped, {:port_closed, port_reason}}
        {nil, code} -> {:exit, code, out}
      end

    if result, do: send(state.caller, {__MODULE__, self(), result})
    {:stop, :normal, %{state | port: nil}}
  end

  defp output(%{mode: :log} = state, :eol, data) do
    Logger.info("[#{state.kind}] #{state.partial}#{data}")
    %{state | partial: ""}
  end

  defp output(%{mode: :log} = state, :noeol, data) do
    partial = state.partial <> data

    if byte_size(partial) >= @line_bytes do
      Logger.info("[#{state.kind}] #{partial}")
      %{state | partial: ""}
    else
      %{state | partial: partial}
    end
  end

  defp output(state, eol, data) do
    data = if eol == :eol, do: data <> "\n", else: data
    room = state.max - state.size

    cond do
      room <= 0 -> state
      byte_size(data) <= room -> %{state | out: [data | state.out], size: state.size + byte_size(data)}
      true -> %{state | out: [binary_part(data, 0, room) | state.out], size: state.max}
    end
  end

  defp flush_partial(%{mode: :log, partial: partial} = state) when partial != "" do
    Logger.info("[#{state.kind}] #{partial}")
  end

  defp flush_partial(_state), do: :ok

  @doc false
  # dash's builtin kill (the slim image has no /bin/kill), on the whole group; never on a pattern
  def signal_group(nil, _signal), do: false

  def signal_group(pgid, signal) when is_integer(pgid) and signal in ["TERM", "KILL"] do
    if pgid > 1 and Integer.to_string(pgid) != System.pid() do
      port =
        Port.open({:spawn_executable, "/bin/sh"}, [
          :binary,
          :exit_status,
          {:args, ["-c", ~S(kill -s "$1" -- "-$2" 2>/dev/null), "sh", signal, Integer.to_string(pgid)]},
          {:env, env_list(%{"PATH" => "/usr/bin:/bin"})}
        ])

      receive do
        {^port, {:exit_status, code}} -> code == 0
      after
        5_000 ->
          Port.close(port)
          false
      end
    else
      false
    end
  end

  defp write_pidfile(_kind, nil), do: nil

  defp write_pidfile(kind, pgid) do
    with start when start != nil <- start_time(pgid),
         dir = Coord.Config.procs_dir(),
         :ok <- File.mkdir_p(dir),
         file = Path.join(dir, "#{pgid}.json"),
         entry = %{kind: kind, pgid: pgid, start: start, kernel_boot: kernel_boot()},
         :ok <- File.write(file, Jason.encode!(entry)) do
      file
    else
      nil ->
        nil

      {:error, reason} ->
        Logger.warning("[#{kind}] no pidfile for group #{pgid}: #{inspect(reason)}")
        nil
    end
  end

  defp remove_pidfile(nil), do: :ok
  defp remove_pidfile(file), do: File.rm(file)

  @doc false
  # field 22 of /proc/<pid>/stat: when the process started, in clock ticks since the kernel booted
  def start_time(pid) do
    case File.read("/proc/#{pid}/stat") do
      {:ok, stat} ->
        # the command name (field 2) may hold spaces and parentheses: count the fields after the last ")"
        stat |> :binary.split(")", [:global]) |> List.last() |> String.split(" ", trim: true) |> Enum.at(19)

      {:error, _} ->
        nil
    end
  end

  @doc false
  def kernel_boot do
    case File.read("/proc/sys/kernel/random/boot_id") do
      {:ok, id} -> String.trim(id)
      {:error, _} -> nil
    end
  end
end
