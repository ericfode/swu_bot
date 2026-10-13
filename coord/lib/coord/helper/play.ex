defmodule Coord.Helper.Play do
  @moduledoc """
  One lease's work on a helper, run in a task of its slot (Coord.Helper.Slot): a fresh work folder, the lease's
  bundles, `node bot/arena/play-seed.js` as the bots' user, and the result's body. The play gets an environment
  built from nothing (Coord.ChildEnv.play/1): no token and no address of the games machine.

  play-seed.js prints one JSON line, `{"ok":true,"results":[...],"replays":{"<id>":"<path>"}}`, the replay paths
  under <work>/out/. Only regular files right in that folder are read (it belongs to the bots' user), each at most
  32 MB and the whole body at most 40 MB; anything else fails the lease, and the machine plays the seed itself.
  """

  alias Coord.{ChildEnv, Config}
  alias Coord.Helper.Client

  @replay_limit 32_000_000
  @body_limit 40_000_000
  @max_stdout 8_000_000
  @grace 5_000

  def grace, do: @grace

  @doc """
  Plays the lease in dir as Coord.Proc kind `kind`, at most timeout ms: {:ok, json, results} (the result's body,
  encoded, and the results for the log) or {:failed, reason}.
  """
  def run(lease, dir, kind, timeout) do
    bundles = Path.join(dir, "bundles")
    job = Path.join(dir, "job.json")

    with :ok <- fresh_dir(dir),
         :ok <- fetch_bundles(lease.bundles, bundles),
         :ok <- write(job, Jason.encode!(lease.job)),
         {:ok, out} <- play(kind, ["--job", job, "--bundles", bundles, "--work", dir], timeout) do
      result_body(out, Path.join(dir, "out"))
    else
      {:error, reason} -> {:failed, "could not prepare the play (#{inspect(reason)})"}
      failed -> failed
    end
  end

  @doc "Compiles the residents' bundles into the wasm cache (play-seed.js --warm, as the bots' user, 15 min)."
  def warm do
    case play(:warm, ["--warm"], :timer.minutes(15)) do
      {:ok, out} ->
        case last_json(out) do
          {:ok, %{"ok" => true} = map} -> {:ok, %{warmed: names(map["warmed"]), failed: names(map["failed"])}}
          _ -> {:failed, "warm printed something other than ok"}
        end

      failed ->
        failed
    end
  end

  # The work folder belongs to the bots' user when the plays run as that user (play-seed.js writes out/ and arena/
  # in it); the bundles and job.json in it stay root's, readable.
  defp fresh_dir(dir) do
    File.rm_rf(dir)

    with :ok <- File.mkdir_p(dir),
         :ok <- File.chmod(dir, 0o700),
         :ok <- give_to_bots(dir) do
      :ok
    else
      {:error, reason} -> {:failed, "could not make the work folder (#{inspect(reason)})"}
    end
  end

  defp give_to_bots(dir) do
    if Coord.Proc.isolation() == :setpriv do
      with {:ok, {uid, gid}} <- Coord.Proc.user_ids(), do: :file.change_owner(dir, uid, gid)
    else
      :ok
    end
  end

  defp fetch_bundles(hexes, dir) do
    with :ok <- File.mkdir_p(dir) do
      Enum.reduce_while(hexes, :ok, fn hex, :ok ->
        case Client.bundle(hex, Path.join(dir, hex <> ".tar")) do
          :ok -> {:cont, :ok}
          other -> {:halt, {:failed, "bundle #{String.slice(hex, 0, 12)}: #{describe(other)}"}}
        end
      end)
    end
  end

  defp describe({:error, why}) when is_binary(why), do: why
  defp describe(:unauthorized), do: "unauthorized"
  defp describe({:build, _want}), do: "the games machine runs another build"
  defp describe(other), do: inspect(other)

  defp write(file, data) do
    case File.write(file, data) do
      :ok -> :ok
      {:error, reason} -> {:failed, "could not write #{Path.basename(file)} (#{inspect(reason)})"}
    end
  end

  defp play(kind, args, timeout) do
    argv = [Config.get(:node), Config.play_seed() | args]
    env = ChildEnv.play(%{data: Config.data(), node_dir: Path.dirname(Config.get(:node))})
    opts = [as: :arena, env: env, timeout: timeout, grace: @grace, stdout: :capture, max_stdout: @max_stdout]

    case Coord.Proc.run(kind, argv, opts) do
      {:exit, 0, out} -> {:ok, out}
      {:exit, code, _out} -> {:failed, "play-seed exited with #{code}"}
      {:timeout, _out} -> {:failed, "play-seed ran past #{div(timeout, 1000)} s"}
      {:stopped, reason} -> {:failed, "play-seed was stopped (#{String.slice(inspect(reason), 0, 100)})"}
    end
  end

  @doc false
  # the body to post, from play-seed's line and its replay files
  def result_body(out, out_dir) do
    out_dir = Path.expand(out_dir)

    with {:ok, %{"ok" => true, "results" => results, "replays" => replays}} when is_list(results) and is_map(replays) <-
           last_json(out),
         true <- Enum.all?(results, &result_entry?/1) || {:failed, "play-seed's results are malformed"},
         {:ok, texts} <- read_replays(replays, out_dir),
         {:ok, json} <- encode(%{results: results, replays: texts}) do
      {:ok, json, results}
    else
      {:failed, why} -> {:failed, why}
      _ -> {:failed, "play-seed printed something other than ok and its results"}
    end
  end

  defp result_entry?(%{"id" => id, "result" => %{}}) when is_binary(id), do: true
  defp result_entry?(_entry), do: false

  defp read_replays(replays, out_dir) do
    if dir?(out_dir) do
      Enum.reduce_while(replays, {:ok, %{}, 0}, fn {id, path}, {:ok, texts, total} ->
        case read_replay(path, out_dir, @body_limit - total) do
          {:ok, text} -> {:cont, {:ok, Map.put(texts, id, text), total + byte_size(text)}}
          {:failed, why} -> {:halt, {:failed, why}}
        end
      end)
      |> case do
        {:ok, texts, _total} -> {:ok, texts}
        failed -> failed
      end
    else
      if replays == %{}, do: {:ok, %{}}, else: {:failed, "no replay folder"}
    end
  end

  # a regular file directly in out/ (no symlink, no subfolder), within the limits
  defp read_replay(path, out_dir, room) do
    with true <- is_binary(path) and Path.dirname(Path.expand(path)) == out_dir,
         {:ok, %File.Stat{type: :regular, size: size}} <- File.lstat(path) do
      cond do
        size > @replay_limit -> {:failed, "a replay is over #{@replay_limit} bytes"}
        size > room -> {:failed, "the replays are over #{@body_limit} bytes"}
        true -> with {:error, reason} <- File.read(path), do: {:failed, "could not read a replay (#{reason})"}
      end
    else
      _ -> {:failed, "a replay path is not a file in out/"}
    end
  end

  defp dir?(path) do
    match?({:ok, %File.Stat{type: :directory}}, File.lstat(path))
  end

  defp encode(body) do
    case Jason.encode(body) do
      {:ok, json} when byte_size(json) <= @body_limit -> {:ok, json}
      {:ok, _json} -> {:failed, "the result is over #{@body_limit} bytes"}
      {:error, _} -> {:failed, "a replay is not UTF-8 text"}
    end
  end

  # the result is the last line; anything before it is a log line that slipped past console.log = console.error
  defp last_json(out) do
    case out |> String.split("\n", trim: true) |> List.last() do
      nil -> :error
      line -> Jason.decode(line)
    end
  end

  defp names(list) when is_list(list) do
    for item <- list, name = item_name(item), do: name
  end

  defp names(_list), do: []

  defp item_name(name) when is_binary(name), do: name
  defp item_name(%{"name" => name}) when is_binary(name), do: name
  defp item_name(_item), do: nil
end
