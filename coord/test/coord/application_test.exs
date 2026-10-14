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
             Coord.Settings,
             {FLAME.Pool, Coord.RoundRunner},
             Oban,
             Coord.Scheduler,
             Coord.Shutdown,
             CoordWeb.Endpoint
           ]

    shutdowns = Map.new(children, &{Supervisor.child_spec(&1, []).id, Supervisor.child_spec(&1, [])[:shutdown]})
    assert shutdowns[Coord.Shutdown] == 11_000
    assert shutdowns[Coord.Pusher] == 9_000
    assert shutdowns[Coord.Settings] == 1_000
  end

  test "with the helper node on, Coord.Remote, the relay and the helper API come right before the FLAME pool" do
    start_helper_node()
    put_setting(:helper_listen, "127.0.0.1")
    children = App.children(:coordinator)

    assert ids(children) == [
             Coord.Repo,
             Coord.Boot,
             Coord.ProcSup,
             CoordWeb.WindowProxy,
             Coord.Pusher,
             Coord.Settings,
             Coord.Remote,
             CoordWeb.RemoteRelay,
             CoordWeb.HelperAPI,
             {FLAME.Pool, Coord.RoundRunner},
             Oban,
             Coord.Scheduler,
             Coord.Shutdown,
             CoordWeb.Endpoint
           ]

    # off again: a helper port without a valid token, or tokens without a port
    put_setting(:helper_port, nil)
    refute CoordWeb.HelperAPI in ids(App.children(:coordinator))
  end

  test "the relay listens on loopback only, the helper API on GAMES_HELPER_LISTEN; both stop within a second" do
    %{start: {Bandit, :start_link, [relay]}} = App.relay_spec(8082)
    assert relay[:ip] == {127, 0, 0, 1}
    assert relay[:port] == 8082
    assert relay[:plug] == CoordWeb.RemoteRelay
    assert relay[:thousand_island_options][:shutdown_timeout] <= 1_000

    %{start: {Bandit, :start_link, [api]}} = App.helper_api_spec({0xFDAA, 0, 0, 0, 0, 0, 0, 2}, 8090)
    assert api[:ip] == {0xFDAA, 0, 0, 0, 0, 0, 0, 2}
    assert api[:port] == 8090
    assert api[:plug] == CoordWeb.HelperAPI
    assert api[:thousand_island_options][:shutdown_timeout] <= 1_000
  end

  test "GAMES_HELPER_LISTEN: an address this host cannot listen on becomes 127.0.0.1, never a wider one" do
    put_setting(:helper_listen, "127.0.0.1")
    assert Coord.Config.helper_ip() == {127, 0, 0, 1}

    ExUnit.CaptureLog.capture_log(fn ->
      # a private Fly address this test host does not have
      put_setting(:helper_listen, "fdaa:0:1:a7b:1:2:3:4")
      assert Coord.Config.helper_ip() == {127, 0, 0, 1}
      put_setting(:helper_listen, "::")
      assert Coord.Config.helper_ip() in [{0, 0, 0, 0, 0, 0, 0, 0}, {0, 0, 0, 0}]
    end)

    put_setting(:helper_listen, "nope")
    assert_raise ArgumentError, ~r/GAMES_HELPER_LISTEN/, fn -> Coord.Config.helper_ip() end
  end

  test "the helper role starts ProcSup and the helper only, and takes the helper's token instead" do
    assert ids(App.children(:helper)) == [Coord.ProcSup, Coord.Helper]
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
