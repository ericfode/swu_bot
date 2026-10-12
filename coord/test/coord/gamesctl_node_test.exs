defmodule Coord.GamesctlNodeTest do
  # The real bot/arena/gamesctl.js against a small arena made here: no root and no card data needed. Excluded by
  # default; CI runs them with `mix test --include node` (node 22 on the PATH).
  use Coord.Case, async: false

  alias Coord.Gamesctl

  @moduletag :node

  setup do
    node = System.find_executable("node") || flunk("the :node tests need node on the PATH")
    File.exists?(Coord.Config.gamesctl()) || flunk("the :node tests need #{Coord.Config.gamesctl()}")
    data = Path.join(System.tmp_dir!(), "coord-node-test-#{System.unique_integer([:positive])}")
    File.mkdir_p!(Path.join(data, "arena"))
    on_exit(fn -> File.rm_rf(data) end)

    put_setting(:node, node)
    put_setting(:data, data)
    %{data: data}
  end

  test "plan prints one JSON line and names no round in an arena without competitors" do
    assert {:ok, %{round: nil, resume: false}} = Gamesctl.plan("open", 0)
  end

  test "plan resumes a round that standings.json says is still running", %{data: data} do
    standings = %{
      rounds: [%{round: 3, status: "running", bots: []}],
      updatedAt: DateTime.to_iso8601(DateTime.utc_now())
    }

    File.write!(Path.join(data, "arena/standings.json"), Jason.encode!(standings))
    assert {:ok, %{round: 3, resume: true, why: "resume"}} = Gamesctl.plan("open", 0)
  end

  test "referee-cmd gives a command for round K that passes the checks, with no token or window" do
    System.put_env("SWU_WINDOW_TOKEN", "must-not-pass")
    on_exit(fn -> System.delete_env("SWU_WINDOW_TOKEN") end)

    assert {:ok, spec} = Gamesctl.referee_cmd("open", 3)
    assert ["--round", "3"] in Enum.chunk_every(spec.cmd, 2, 1)
    refute Enum.any?(Map.keys(spec.env), &Coord.ChildEnv.forbidden?/1)
    refute Enum.any?(Map.values(spec.env) ++ spec.cmd, &String.contains?(&1, "must-not-pass"))

    if Coord.Proc.root?() do
      assert Enum.take(spec.cmd, 2) == ["bash", Path.join(Coord.Config.app(), "bot/arena/ops/isolate.sh")]
      assert "--hide" in spec.cmd
    end
  end

  test "an arena other than open is refused" do
    assert {:error, "exited with " <> _} = Gamesctl.plan("no-such-arena", 0)
  end
end
