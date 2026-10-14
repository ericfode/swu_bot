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

  test "while a referee runs, it sends the round every round tick and everything every tick" do
    put_setting(:tick_ms, 1_000)
    put_setting(:round_tick_ms, 100)

    pushes_of = fn only ->
      Enum.count(
        fake_events(),
        &(String.starts_with?(&1, "start push ") and String.ends_with?(&1, " --only round") == only)
      )
    end

    referee = Task.async(fn -> Coord.Proc.run(:referee, ["/bin/sh", "-c", "sleep 30"], grace: 200) end)
    running_proc(:referee)
    start_supervised!(Coord.Pusher)
    Coord.Pusher.poke()

    # the poke's push is a full one; the round goes every round tick after it, and everything again a tick later
    eventually(fn -> pushes_of.(true) >= 3 end)
    assert pushes_of.(false) == 1
    assert hd(Enum.filter(fake_events(), &String.starts_with?(&1, "start push "))) =~ ~r/--boot \S+$/
    eventually(fn -> pushes_of.(false) >= 2 end, 3_000)

    # no referee, no round pushes: every push is a full one again, a tick apart
    Task.shutdown(referee, :brutal_kill)
    eventually(fn -> not Enum.any?(Coord.Proc.running(), &(&1.kind == :referee)) end)
    Process.sleep(300)
    round = pushes_of.(true)
    Process.sleep(1_300)
    assert pushes_of.(true) == round
  end

  test "a round push waits until something in the round's folder changed" do
    put_setting(:tick_ms, 60_000)
    put_setting(:round_tick_ms, 100)
    games = Path.join(data(), "results/arena-r13/games")
    File.mkdir_p!(games)
    File.write!(Path.join(games, "a.jsonl"), ~s({"t":"header"}\n))
    on_exit(fn -> File.rm_rf!(Path.join(data(), "results/arena-r13")) end)

    round_pushes = fn ->
      Enum.count(fake_events(), &(String.starts_with?(&1, "start push ") and String.ends_with?(&1, " --only round")))
    end

    referee = Task.async(fn -> Coord.Proc.run(:referee, ["/bin/sh", "-c", "sleep 30"], grace: 200) end)
    running_proc(:referee)
    start_supervised!(Coord.Pusher)
    Coord.Pusher.poke()

    # the poke's full push sent the folder as it is: nothing new, no round push
    eventually(fn -> pushes() == 1 end)
    Process.sleep(600)
    assert round_pushes.() == 0

    File.write!(Path.join(games, "a.jsonl"), ~s({"t":"header"}\n{"t":"step"}\n))
    eventually(fn -> round_pushes.() == 1 end)
    Process.sleep(600)
    assert round_pushes.() == 1

    Task.shutdown(referee, :brutal_kill)
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
