defmodule Coord.SettingsTest do
  use Coord.Case, async: false

  import Plug.Conn

  alias Coord.{Secrets, Settings}

  @token "the-window-token"

  setup do
    System.put_env("SWU_WINDOW_TOKEN", @token)
    Secrets.forget()
    Secrets.take!()
    Req.Test.set_req_test_to_shared()
    File.mkdir_p!(Coord.Config.coord_dir())
    File.rm(Settings.file())

    on_exit(fn ->
      Req.Test.set_req_test_to_private()
      :persistent_term.erase({Settings, :settings})
      File.rm(Settings.file())
      Secrets.forget()
      Secrets.take!()
    end)

    :ok
  end

  # the window answers with `settings`, or with `status`; it tells the test what it saw
  defp window(answer) do
    test_pid = self()

    Req.Test.stub(CoordWeb.WindowProxy, fn conn ->
      send(test_pid, {:window, conn.method, conn.request_path, get_req_header(conn, "authorization")})

      case answer do
        {:status, status} -> conn |> put_status(status) |> Req.Test.json(%{error: %{code: "x"}})
        settings -> Req.Test.json(conn, %{result: %{settings: settings, updatedAt: nil, by: nil}})
      end
    end)
  end

  defp start do
    pid = start_supervised!(Settings)
    :sys.get_state(pid)
    pid
  end

  test "parse keeps the settings in range and drops the rest" do
    assert Settings.parse(%{"gamesPerPair" => 4, "thinkCapSec" => 90, "workers" => 3, "roundGapMin" => 0}) ==
             %{games: 4, think_cap_sec: 90, workers: 3, round_gap_min: 0}

    for bad <- [
          %{"gamesPerPair" => 3},
          %{"gamesPerPair" => 12},
          %{"gamesPerPair" => 0},
          %{"thinkCapSec" => 9},
          %{"workers" => 0},
          %{"workers" => 17},
          %{"workers" => "3"},
          %{"workers" => 2.0},
          %{"roundGapMin" => -1},
          %{"idleMin" => 5}
        ] do
      assert Settings.parse(bad) == %{}, inspect(bad)
    end

    assert Settings.parse(nil) == %{}
    assert Settings.parse([1]) == %{}
  end

  test "without settings the machine's defaults hold" do
    window(%{})
    start()
    assert Settings.games() == 2
    assert Settings.workers() == 2
    assert Settings.think_cap_ms() == 60_000
    assert Settings.round_gap_ms() == 0
  end

  test "it reads the window with the token, applies the settings and keeps them for a boot without the window" do
    window(%{"workers" => 3, "gamesPerPair" => 4, "thinkCapSec" => 90, "roundGapMin" => 5})
    ExUnit.CaptureLog.capture_log(fn -> start() end)
    assert_received {:window, "GET", "/api/arena-settings", ["Bearer " <> @token]}

    assert {Settings.games(), Settings.workers(), Settings.think_cap_ms(), Settings.round_gap_ms()} ==
             {4, 3, 90_000, 300_000}

    assert Jason.decode!(File.read!(Settings.file())) == %{
             "workers" => 3,
             "gamesPerPair" => 4,
             "thinkCapSec" => 90,
             "roundGapMin" => 5
           }

    # the window is down: the last settings stay, and a new start reads them from the volume
    window({:status, 502})
    stop_supervised!(Settings)
    :persistent_term.erase({Settings, :settings})

    log = ExUnit.CaptureLog.capture_log(fn -> start() end)
    assert log =~ "the window answered 502"
    assert Settings.workers() == 3
    assert Settings.games() == 4
  end

  test "a change on the window is read at the next pass; a setting removed there goes back to the default" do
    window(%{"workers" => 3})
    pid = ExUnit.CaptureLog.capture_log(fn -> send(self(), {:pid, start()}) end) && receive(do: ({:pid, p} -> p))
    assert Settings.workers() == 3

    window(%{"gamesPerPair" => 6})
    ExUnit.CaptureLog.capture_log(fn -> send(pid, :read) && :sys.get_state(pid) end)
    assert Settings.workers() == 2
    assert Settings.games() == 6
  end
end
