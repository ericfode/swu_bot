defmodule Coord.ApplicationTest do
  use Coord.Case, async: false

  alias Coord.Application, as: App

  defp ids(children), do: Enum.map(children, &Supervisor.child_spec(&1, []).id)

  test "the coordinator's tree, in start order (it stops in reverse)" do
    children = App.children(:coordinator)

    assert ids(children) == [
             Coord.Repo,
             Coord.Boot,
             Coord.ProcSup,
             CoordWeb.WindowProxy,
             Coord.Pusher,
             {FLAME.Pool, Coord.RoundRunner},
             Oban,
             Coord.Scheduler,
             Coord.Shutdown,
             CoordWeb.Endpoint
           ]

    shutdowns = Map.new(children, &{Supervisor.child_spec(&1, []).id, Supervisor.child_spec(&1, [])[:shutdown]})
    assert shutdowns[Coord.Shutdown] == 11_000
    assert shutdowns[Coord.Pusher] == 9_000
  end

  test "a Proc is temporary and has 10 s to stop" do
    spec = Coord.Proc.child_spec({:t, [], [], self()})
    assert spec.restart == :temporary
    assert spec.shutdown == 10_000
  end

  test "the window proxy listens on loopback only" do
    %{start: {Bandit, :start_link, [opts]}} = App.proxy_spec(8081)
    assert opts[:ip] == {127, 0, 0, 1}
    assert opts[:port] == 8081
    assert opts[:plug] == CoordWeb.WindowProxy
    # a request left open by a killed push may not hold the stop for Thousand Island's default 15 s
    assert opts[:thousand_island_options][:shutdown_timeout] <= 2_000
  end

  test "on a FLAME runner the role is :runner" do
    parent = FLAME.Parent.new(make_ref(), self(), FLAME.LocalBackend, "coord", nil)
    System.put_env("FLAME_PARENT", FLAME.Parent.encode(parent))
    on_exit(fn -> System.delete_env("FLAME_PARENT") end)
    assert App.role() == :runner
  end

  test "the runner role starts no Repo, Oban, Endpoint or proxy, and takes no token" do
    assert App.children(:runner) == []

    System.put_env("SWU_WINDOW_TOKEN", "not-for-runners")
    Coord.Secrets.forget()

    on_exit(fn ->
      System.delete_env("SWU_WINDOW_TOKEN")
      Coord.Secrets.forget()
      Coord.Secrets.take!()
    end)

    {:ok, sup} = App.start_tree(:runner, [])
    assert Supervisor.which_children(sup) == []
    assert Coord.Secrets.token() == nil
    Supervisor.stop(sup)
  end

  test "GAMES_LISTEN: an IPv4 address is used as it is, a bad one is refused" do
    put_setting(:listen, "127.0.0.1")
    assert Coord.Config.listen_ip() == {127, 0, 0, 1}
    put_setting(:listen, "not an address")
    assert_raise ArgumentError, fn -> Coord.Config.listen_ip() end
  end

  test "GAMES_LISTEN=:: is IPv6 where the host has it, else 0.0.0.0" do
    put_setting(:listen, "::")

    ExUnit.CaptureLog.capture_log(fn ->
      assert Coord.Config.listen_ip() in [{0, 0, 0, 0, 0, 0, 0, 0}, {0, 0, 0, 0}]
    end)
  end
end
