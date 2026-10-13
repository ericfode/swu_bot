defmodule Coord.PusherTest do
  use Coord.Case, async: false

  @moduletag :fake

  defp pushes, do: Enum.count(fake_events(), &String.starts_with?(&1, "start push "))

  test "it pushes from the first poke on, every tick after" do
    put_setting(:tick_ms, 200)
    start_supervised!(Coord.Pusher)
    Process.sleep(300)
    assert pushes() == 0

    Coord.Pusher.poke()
    eventually(fn -> pushes() >= 3 end)

    state = Path.join(Coord.Config.data(), "tmp/push/state.json")
    assert "start push --arena open --state #{state} --boot #{Coord.Boot.id()}" in fake_events()
  end

  test "a poke during a push makes one more push right after it" do
    start_supervised!(Coord.Pusher)
    fake("push", :sleep, 1)
    Coord.Pusher.poke()
    running_proc(:push)
    Coord.Pusher.poke()
    Coord.Pusher.poke()
    eventually(fn -> pushes() == 2 end)
    Process.sleep(1_500)
    assert pushes() == 2
  end

  test "a failing push is logged once, not every time" do
    put_setting(:tick_ms, 100)
    fake("push", :exit, 1)

    log =
      ExUnit.CaptureLog.capture_log(fn ->
        start_supervised!(Coord.Pusher)
        Coord.Pusher.poke()
        eventually(fn -> pushes() >= 3 end)
        stop_supervised!(Coord.Pusher)
      end)

    assert length(String.split(log, "push failed")) == 2
  end
end
