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
