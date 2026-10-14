defmodule Coord.Gamesctl do
  @moduledoc """
  Runs `node bot/arena/gamesctl.js <command>`: Node decides what happens (intake, round planning, the window
  protocol, the referee), this coordinator decides when.

  gamesctl prints exactly one JSON line on stdout (its logs go to stderr) and exits 0 when it printed its result,
  1 when it failed, 2 on a usage error, 143 when SIGTERM stopped it. Each function here builds the argv, the
  environment and the time limit of one command, then checks the result. plan runs as the bots' user, so nothing
  it prints is trusted beyond a round number; the referee's command comes from referee-cmd, which runs as root and
  reads no arena files, and is checked before anything runs it.
  """

  require Logger

  alias Coord.{ChildEnv, Config}

  # the referee's whole environment may hold these and nothing else (gamesctl.js botEnv), and ARENA_REMOTE, the helper
  # relay's URL, which only this module puts there
  @referee_env ~w(PATH HOME LANG TZ ARENA_HOME ARENA_RESULTS ARENA_PUBLIC_RESULTS ARENA_DASH SWU_WASM_CACHE
                  SWU_CARD_JSON ARENA_SECRET_FILE ARENA_BOT_USER ARENA_REMOTE)
  @max_round 1_000_000
  @reasons ~w(changed stale resume same settling no-competitor)

  @doc "Folders, the round-seed secret and the roster (root, 5 min)."
  def setup do
    case call(:setup, ["setup"], as: :root, timeout: :timer.minutes(5)) do
      {:ok, %{"ok" => true} = out} -> {:ok, out}
      {:ok, _} -> {:error, "setup did not say ok"}
      error -> error
    end
  end

  @doc "Compiles the resident bundles into the cache (arena, 15 min)."
  def warm do
    case call(:warm, ["warm"], as: :arena, timeout: :timer.minutes(15)) do
      {:ok, %{"ok" => true} = out} -> {:ok, %{warmed: names(out["warmed"]), failed: names(out["failed"])}}
      {:ok, _} -> {:error, "warm did not say ok"}
      error -> error
    end
  end

  @doc """
  The round to play now: {:ok, %{round: k | nil, resume: boolean, why: string}} (arena, 30 s). settled_since is the
  wall-clock ms of the last accepted version, which the plan lets settle for 90 s.
  """
  def plan(arena, settled_since) when is_integer(settled_since) do
    args = ["plan", "--arena", arena, "--settled-since", Integer.to_string(settled_since)]
    args = args ++ ["--replay-hours", Integer.to_string(Config.get(:replay_hours))]

    with {:ok, out} <- call(:plan, args, as: :arena, timeout: 30_000) do
      check_plan(out)
    end
  end

  @doc false
  def check_plan(%{"round" => nil} = out), do: {:ok, %{round: nil, resume: false, why: reason(out)}}

  def check_plan(%{"round" => k, "resume" => resume} = out)
      when is_integer(k) and k >= 0 and k <= @max_round and is_boolean(resume) do
    {:ok, %{round: k, resume: resume, why: reason(out)}}
  end

  def check_plan(_), do: {:error, "plan printed something other than a round"}

  # plan's words reach the log only when they are one of the reasons it may give
  defp reason(%{"why" => why}) when why in @reasons, do: why
  defp reason(_), do: "?"

  @doc """
  The checked command for round k: {:ok, %Coord.Round.Spec{}} (root, 30 s). It also clears a stale lock. When the
  helper node is on, the referee's environment gets ARENA_REMOTE, the relay's URL, which it passes to the ladder.
  """
  def referee_cmd(arena, k) when is_integer(k) do
    args = ["referee-cmd", "--arena", arena, "--round", Integer.to_string(k)]

    # Eric's settings (Coord.Settings); a round a stop cut short keeps its own games and time limit (gamesctl.js)
    args =
      args ++
        ["--games", Integer.to_string(Coord.Settings.games()), "--workers", Integer.to_string(Coord.Settings.workers())] ++
        ["--cap-ms", Integer.to_string(Coord.Settings.think_cap_ms())]

    with {:ok, out} <- call(:referee_cmd, args, as: :root, timeout: 30_000),
         :ok <- check_referee_cmd(out, k, Coord.Proc.isolate?()) do
      spec = %Coord.Round.Spec{
        arena: arena,
        round: k,
        cmd: out["cmd"],
        env: remote_env(out["env"]),
        cwd: out["cwd"] || Config.app(),
        cap_ms: Config.get(:round_cap_ms)
      }

      {:ok, spec}
    end
  end

  # the relay's URL is this machine's to give: one that came from referee-cmd is dropped
  defp remote_env(env) do
    env = Map.delete(env, "ARENA_REMOTE")
    if Coord.Remote.enabled?(), do: Map.put(env, "ARENA_REMOTE", Coord.Remote.relay_url()), else: env
  end

  def referee_cmd!(arena, k) do
    case referee_cmd(arena, k) do
      {:ok, spec} -> spec
      {:error, why} -> raise "referee-cmd for round #{k}: #{why}"
    end
  end

  @doc false
  def check_referee_cmd(out, k, isolated?) do
    cmd = out["cmd"]
    env = out["env"]
    cwd = out["cwd"]
    isolate_sh = Path.join(Config.app(), "bot/arena/ops/isolate.sh")

    cond do
      not is_list(cmd) or cmd == [] or not Enum.all?(cmd, &is_binary/1) ->
        {:error, "cmd is not a list of strings"}

      not is_map(env) or not Enum.all?(env, fn {_, v} -> is_binary(v) end) ->
        {:error, "env is not a map of strings"}

      key = Enum.find(Map.keys(env), &(&1 not in @referee_env or ChildEnv.forbidden?(&1))) ->
        {:error, "env may not hold #{String.slice(key, 0, 40)}"}

      ["--round", Integer.to_string(k)] not in Enum.chunk_every(cmd, 2, 1) ->
        {:error, "cmd lacks --round #{k}"}

      isolated? and Enum.take(cmd, 2) != ["bash", isolate_sh] ->
        {:error, "cmd does not start with bash #{isolate_sh}"}

      # the referee runs as root, so the mount namespace is what keeps the job database and Fly's files out of reach
      isolated? and missing_hides(cmd) != [] ->
        {:error, "cmd does not hide #{Enum.join(missing_hides(cmd), " and ")}"}

      cwd != nil and not (is_binary(cwd) and String.starts_with?(cwd, "/")) ->
        {:error, "cwd is not an absolute path"}

      true ->
        :ok
    end
  end

  # the folders isolate.sh must hide from the referee, looked for among its options (before "--")
  defp missing_hides(cmd) do
    options = cmd |> Enum.drop(2) |> Enum.take_while(&(&1 != "--"))
    hides = for ["--hide", dir] <- Enum.chunk_every(options, 2, 1), do: dir
    Enum.reject(["/.fly", Config.coord_dir()], &(&1 in hides))
  end

  @doc """
  One intake pass: {:ok, %{open: n | nil, accepted: n, done: n}} (root, 65 min). It reaches the window through
  the proxy's intake nonce; an unknown open count (window down, no toolchain) is nil.
  """
  def intake do
    args = ["intake", "--state", Path.join(Config.coord_dir(), "intake.json"), "--boot", Coord.Boot.id()]

    with {:ok, out} <- call(:intake, args, as: :root, timeout: :timer.minutes(65), grace: 8_000) do
      check_intake(out)
    end
  end

  @doc false
  def check_intake(out) do
    open = out["open"]
    accepted = Map.get(out, "accepted", 0)
    done = Map.get(out, "done", 0)

    if (open == nil or count?(open)) and count?(accepted) and count?(done) do
      if is_binary(out["error"]), do: Logger.warning("intake: #{String.slice(out["error"], 0, 300)}")
      {:ok, %{open: open, accepted: accepted, done: done}}
    else
      {:error, "intake printed something other than counts"}
    end
  end

  @doc """
  Sends the arena's documents and replays to the window through the proxy's push nonce: {:ok, true | false}
  (arena, 2 min by default; the last push of a shutdown passes a shorter timeout). `only: :round` sends just the
  playing round's index and replays.
  """
  def push(arena, opts \\ []) do
    dir = Path.join([Config.data(), "tmp", "push"])
    File.mkdir_p(dir)
    args = ["push", "--arena", arena, "--state", Path.join(dir, "state.json"), "--boot", Coord.Boot.id()]
    args = if opts[:only] == :round, do: args ++ ["--only", "round"], else: args
    timeout = Keyword.get(opts, :timeout, 120_000)

    case call(:push, args, as: :arena, timeout: timeout, grace: Keyword.get(opts, :grace, 2_000)) do
      {:ok, %{"ok" => ok}} when is_boolean(ok) -> {:ok, ok}
      {:ok, _} -> {:error, "push printed something other than ok"}
      error -> error
    end
  end

  defp call(kind, args, opts) do
    argv = [Config.get(:node), Config.gamesctl() | args]
    env = ChildEnv.for_kind(kind, context(kind))

    case Coord.Proc.run(kind, argv, Keyword.merge([env: env, grace: 5_000, stdout: :capture], opts)) do
      {:exit, 0, out} -> decode(out)
      {:exit, code, _} -> {:error, "exited with #{code}"}
      {:timeout, _} -> {:error, "ran past #{opts[:timeout]} ms"}
      {:stopped, reason} -> {:error, "stopped (#{inspect(reason)})"}
    end
  end

  # the result is the last line; anything before it is a log line that slipped past console.log = console.error
  defp decode(out) do
    case out |> String.split("\n", trim: true) |> List.last() do
      nil ->
        {:error, "nothing on stdout"}

      line ->
        case Jason.decode(line) do
          {:ok, %{} = map} -> {:ok, map}
          _ -> {:error, "no JSON object on stdout"}
        end
    end
  end

  @doc false
  def context(kind) do
    %{
      data: Config.data(),
      arena_user: Config.get(:arena_user),
      residents: Config.get(:residents),
      card_json: Config.get(:card_json),
      root_home: root_home(),
      node_dir: Path.dirname(Config.get(:node)),
      window: window(kind)
    }
  end

  defp window(:push), do: proxy_url("p", Coord.Secrets.nonce(:push))
  defp window(:intake), do: proxy_url("i", Coord.Secrets.nonce(:intake))
  defp window(_kind), do: nil

  defp proxy_url(prefix, nonce), do: "http://127.0.0.1:#{Config.get(:proxy_port)}/#{prefix}/#{nonce}"

  # root's children use root's home; without root (CI, a laptop) the BEAM's own
  defp root_home do
    if Coord.Proc.root?(), do: "/root", else: System.user_home() || "/tmp"
  end

  defp count?(n), do: is_integer(n) and n >= 0

  defp names(list) when is_list(list) do
    for item <- list, name = item_name(item), do: name
  end

  defp names(_), do: []

  defp item_name(name) when is_binary(name), do: name
  defp item_name(%{"name" => name}) when is_binary(name), do: name
  defp item_name(_), do: nil
end
