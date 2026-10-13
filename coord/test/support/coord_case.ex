defmodule Coord.Case do
  @moduledoc """
  Helpers for the tests: the fake node's controls and log (test/support/fake_node), settings changed for one
  test, the database sandbox, and process groups seen through /proc.
  """

  use ExUnit.CaseTemplate

  using do
    quote do
      import Coord.Case
    end
  end

  setup tags do
    if tags[:db] do
      pid = Ecto.Adapters.SQL.Sandbox.start_owner!(Coord.Repo, shared: not tags[:async])
      on_exit(fn -> Ecto.Adapters.SQL.Sandbox.stop_owner(pid) end)
    end

    if tags[:fake] do
      # a child started by the last test (say a setup when its Scheduler was stopped at once) is still being
      # stopped; it could write to the log after the reset
      eventually(fn -> DynamicSupervisor.count_children(Coord.ProcSup).active == 0 end, 15_000)
      reset_fake()
    end

    :ok
  end

  def data, do: Coord.Config.data()

  @doc "Empties the fake node's controls and log."
  def reset_fake do
    File.rm_rf!(Path.join(data(), "fake"))
    File.mkdir_p!(Path.join(data(), "fake"))
    File.rm(Path.join(data(), "fake-node.log"))
    :ok
  end

  @doc "Sets a control of the fake node: fake(\"plan\", :json, ~s({...})), fake(\"push\", :exit, 1), ..."
  def fake(name, control, value) do
    File.write!(Path.join([data(), "fake", "#{name}.#{control}"]), to_string(value))
  end

  def fake_log do
    case File.read(Path.join(data(), "fake-node.log")) do
      {:ok, text} -> String.split(text, "\n", trim: true)
      {:error, _} -> []
    end
  end

  @doc "The lines of the fake node's log that are not environment lines."
  def fake_events, do: Enum.reject(fake_log(), &String.starts_with?(&1, "env "))

  @doc "The environment the fake node saw as `name` (the last run of it)."
  def fake_env(name) do
    prefix = "env #{name} "

    fake_log()
    |> Enum.filter(&String.starts_with?(&1, prefix))
    |> Enum.map(&String.replace_prefix(&1, prefix, ""))
    |> Map.new(fn line ->
      case String.split(line, "=", parts: 2) do
        [k, v] -> {k, v}
        [k] -> {k, ""}
      end
    end)
  end

  @helper_tokens %{
    "eric" => "eric-helper-token-0123456789abcdef0123",
    "bob" => "bob-helper-token-4567456789abcdef01234"
  }

  @doc "The token of a test helper (eric or bob)."
  def helper_token(name), do: Map.fetch!(@helper_tokens, name)

  def sha256_hex(data), do: :sha256 |> :crypto.hash(data) |> Base.encode16(case: :lower)

  @doc """
  The helper node on, as the games machine has it for the rest of the test: GAMES_HELPER_TOKENS naming eric and
  bob, a helper port, build build-1 with cards cards-1, and Coord.Remote running.
  """
  def start_helper_node do
    tokens = Enum.map_join(@helper_tokens, ",", fn {name, token} -> "#{name}:#{sha256_hex(token)}" end)
    System.put_env("GAMES_HELPER_TOKENS", tokens)
    Coord.Secrets.forget()
    Coord.Secrets.take!()

    ExUnit.Callbacks.on_exit(fn ->
      Coord.Secrets.forget()
      Coord.Secrets.take!()
    end)

    put_setting(:helper_port, 0)
    put_setting(:build, "build-1")
    put_setting(:cards, "cards-1")
    ExUnit.Callbacks.start_supervised!(Coord.Remote)
  end

  @doc "A job as the ladder offers it (bot/remote-lane.js): one seed, its two seat-swapped games."
  def remote_job(seed \\ 1234, extra \\ %{}) do
    Map.merge(
      %{
        "v" => 1,
        "seed" => seed,
        "key" => "k-#{seed}",
        "maxSteps" => 6000,
        "capMs" => 60_000,
        "hangMs" => 150_000,
        "gameMs" => 840_000,
        "games" => [
          %{"id" => "a", "p1" => "a-v2", "p2" => "heuristic"},
          %{"id" => "b", "p1" => "heuristic", "p2" => "a-v2"}
        ],
        "bots" => %{"a-v2" => %{"kind" => "wasm"}, "heuristic" => %{"kind" => "resident"}}
      },
      extra
    )
  end

  @doc "Changes one Coord.Config setting for the rest of the test."
  def put_setting(key, value) do
    old = Application.fetch_env!(:coord, Coord.Config)
    Application.put_env(:coord, Coord.Config, Keyword.put(old, key, value))
    ExUnit.Callbacks.on_exit(fn -> Application.put_env(:coord, Coord.Config, old) end)
  end

  @doc "The pids of the processes in process group pgid, read from /proc (no pgrep)."
  def group_members(pgid) do
    for entry <- File.ls!("/proc"),
        Regex.match?(~r/^\d+$/, entry),
        stat = read_stat(entry),
        stat != nil,
        group_of(stat) == pgid,
        do: String.to_integer(entry)
  end

  defp read_stat(pid) do
    case File.read("/proc/#{pid}/stat") do
      {:ok, stat} -> stat
      {:error, _} -> nil
    end
  end

  # field 5 is the process group; field 3 the state (a zombie is gone for our purposes)
  defp group_of(stat) do
    [state, _ppid, pgrp | _] = stat |> :binary.split(")", [:global]) |> List.last() |> String.split(" ", trim: true)
    if state == "Z", do: nil, else: String.to_integer(pgrp)
  end

  @doc "Polls until fun returns a truthy value, or fails after timeout ms."
  def eventually(fun, timeout \\ 5_000) do
    deadline = System.monotonic_time(:millisecond) + timeout
    poll(fun, deadline)
  end

  defp poll(fun, deadline) do
    case fun.() do
      result when result not in [nil, false] ->
        result

      _ ->
        if System.monotonic_time(:millisecond) > deadline do
          ExUnit.Assertions.flunk("condition not met in time")
        else
          Process.sleep(50)
          poll(fun, deadline)
        end
    end
  end

  @doc "The one running Coord.Proc of this kind, once it is there."
  def running_proc(kind) do
    eventually(fn -> Enum.find(Coord.Proc.running(), &(&1.kind == kind)) end)
  end
end
