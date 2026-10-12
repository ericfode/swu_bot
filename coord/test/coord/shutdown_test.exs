defmodule Coord.ShutdownTest do
  use Coord.Case, async: false

  @moduletag :fake

  setup do
    on_exit(fn -> Coord.Shutdown.set_stopping(false) end)
    :ok
  end

  # the two in their order in the real tree: Shutdown stops first, the Pusher after it
  defp start_pusher_and_shutdown do
    {:ok, sup} = Supervisor.start_link([Coord.Pusher, Coord.Shutdown], strategy: :one_for_one)
    Coord.Pusher.poke()
    eventually(fn -> "end push 0" in fake_events() end)
    sup
  end

  defp start_referee do
    data = Coord.Config.data()
    argv = [Coord.Config.get(:node), Path.join(Coord.Config.app(), "bot/arena/referee.js"), "--round", "4"]
    env = %{"PATH" => "/usr/bin:/bin", "ARENA_HOME" => Path.join(data, "arena")}
    task = Task.async(fn -> Coord.Proc.run(:referee, argv, env: env, grace: 5_000) end)
    proc = running_proc(:referee)
    eventually(fn -> "start referee --round 4" in fake_events() end)
    {task, proc}
  end

  test "the referee gets TERM before the last push, and its group is gone by then" do
    sup = start_pusher_and_shutdown()
    fake("referee", :sleep, 60)
    {task, %{pgid: pgid}} = start_referee()

    ExUnit.CaptureLog.capture_log(fn -> Supervisor.stop(sup) end)

    events = fake_events()
    term = Enum.find_index(events, &(&1 == "term referee"))
    last_push = events |> Enum.with_index() |> Enum.filter(fn {e, _} -> e =~ ~r/^start push / end) |> List.last()
    assert term != nil
    assert {_, last_push_at} = last_push
    assert term < last_push_at
    assert Enum.count(events, &(&1 =~ ~r/^start push /)) == 2
    assert group_members(pgid) == []
    assert {:stopped, :shutdown} = Task.await(task)
    assert Coord.Shutdown.stopping?()
  end

  test "a referee that ignores TERM is killed after 8 s, still before the last push" do
    sup = start_pusher_and_shutdown()
    fake("referee", :sleep, 60)
    fake("referee", :noterm, "")
    {task, %{pgid: pgid}} = start_referee()
    started = System.monotonic_time(:millisecond)

    ExUnit.CaptureLog.capture_log(fn -> Supervisor.stop(sup) end)

    assert System.monotonic_time(:millisecond) - started >= 8_000
    assert group_members(pgid) == []
    assert {:stopped, :shutdown} = Task.await(task)
    assert List.last(fake_events()) =~ ~r/^end push /
  end

  test "a push in progress is left to the Pusher, which stops it and pushes once more" do
    sup = start_pusher_and_shutdown()
    fake("push", :sleep, 60)
    Coord.Pusher.poke()
    %{pgid: pgid} = running_proc(:push)
    eventually(fn -> Enum.count(fake_events(), &(&1 =~ ~r/^start push /)) == 2 end)
    File.rm!(Path.join([Coord.Config.data(), "fake", "push.sleep"]))

    ExUnit.CaptureLog.capture_log(fn -> Supervisor.stop(sup) end)

    events = fake_events()
    assert "term push" in events
    assert Enum.count(events, &(&1 =~ ~r/^start push /)) == 3
    assert List.last(events) == "end push 0"
    assert group_members(pgid) == []
  end

  test "without a first push (setup never finished) there is no last push" do
    {:ok, sup} = Supervisor.start_link([Coord.Pusher, Coord.Shutdown], strategy: :one_for_one)
    Supervisor.stop(sup)
    assert fake_events() == []
  end
end
