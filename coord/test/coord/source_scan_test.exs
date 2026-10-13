defmodule Coord.SourceScanTest do
  use ExUnit.Case, async: true

  # Coord.Proc is the one place that starts OS processes: it clears the environment, kills whole groups and
  # leaves pidfiles. Anything else that spawns would get none of that.
  @spawners ~w(System.cmd System.shell Port.open :os.cmd :erlang.open_port open_port spawn_executable MuonTrap :exec.)
  @allowed "lib/coord/proc.ex"

  test "no module but Coord.Proc starts an OS process" do
    files = Path.wildcard(Path.expand("../../lib/**/*.ex", __DIR__))
    assert files != []

    offenders =
      for file <- files,
          relative = Path.relative_to(file, Path.expand("../..", __DIR__)),
          relative != @allowed,
          text = File.read!(file),
          spawner <- @spawners,
          String.contains?(text, spawner),
          do: {relative, spawner}

    assert offenders == []
  end

  test "Coord.Proc is where processes are started" do
    text = File.read!(Path.expand("../../" <> @allowed, __DIR__))
    assert text =~ "Port.open"
  end
end
