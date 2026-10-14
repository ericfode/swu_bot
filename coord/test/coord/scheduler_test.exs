defmodule Coord.SchedulerTest do
  use Coord.Case, async: false
  use Oban.Testing, repo: Coord.Repo, engine: Oban.Engines.Lite

  import Ecto.Query

  alias Coord.Scheduler

  @moduletag :db
  @moduletag :fake

  setup do
    File.rm(round_end_file())
    on_exit(fn -> Coord.Shutdown.set_stopping(false) end)
    :ok
  end

  defp round_end_file, do: Path.join(Coord.Config.coord_dir(), "round_end")
  defp wall, do: System.os_time(:millisecond)

  defp start_scheduler(opts \\ []) do
    test = self()

    start_supervised!(
      {Scheduler, Keyword.merge([stop: fn code -> send(test, {:stop, code}) end, restart: false], opts)}
    )
  end

  defp ready do
    eventually(fn -> :sys.get_state(Scheduler).phase == :ready end)
  end

  # in manual mode no job runs: what the tests let through is done by hand
  defp finish_jobs, do: Coord.Repo.update_all(Oban.Job, set: [state: "completed"])

  defp tick do
    send(Scheduler, :tick)
    :sys.get_state(Scheduler)
  end

  test "at boot: setup, then an intake pass at once (tick 0), then warm" do
    start_scheduler()
    assert_enqueued([worker: Coord.Workers.Intake], 2_000)
    ready()
    starts = for "start " <> rest <- fake_events(), do: rest |> String.split(" ") |> hd()
    assert Enum.take(starts, 2) == ["setup", "warm"]
  end

  test "a failed setup stops the VM with 1" do
    fake("setup", :exit, 1)
    ExUnit.CaptureLog.capture_log(fn -> start_scheduler() && assert_receive({:stop, 1}, 2_000) end)
    refute_enqueued(worker: Coord.Workers.Intake)
  end

  test "a failed warm is only logged" do
    fake("warm", :exit, 1)
    ExUnit.CaptureLog.capture_log(fn -> start_scheduler() && ready() end)
    refute_received {:stop, _}
  end

  test "no plan while an Intake job is incomplete; then the planned round is queued with this boot" do
    fake("plan", :json, ~s({"round":4,"resume":false,"why":"changed"}))
    start_scheduler()
    ready()
    tick()
    refute Enum.any?(fake_events(), &String.starts_with?(&1, "start plan"))

    finish_jobs()
    ExUnit.CaptureLog.capture_log(fn -> tick() end)
    args = %{"arena" => "open", "round" => 4, "boot" => Coord.Boot.id()}
    assert_enqueued([worker: Coord.Workers.Round, args: args], 2_000)
    assert "start plan --arena open --settled-since 0 --replay-hours 24" in fake_events()
  end

  test "a new round waits out the wait between rounds, keeping the machine awake; a round cut short does not wait" do
    :persistent_term.put({Coord.Settings, :settings}, %{round_gap_min: 1})
    on_exit(fn -> :persistent_term.erase({Coord.Settings, :settings}) end)
    fake("plan", :json, ~s({"round":4,"resume":false,"why":"changed"}))
    start_scheduler()
    ready()
    finish_jobs()

    # round 3 ended just now; the machine was last busy an hour ago (monotonic time may be negative)
    an_hour_ago = System.monotonic_time(:millisecond) - 3_600_000
    :sys.replace_state(Scheduler, &%{&1 | round_end: wall(), busy_at: an_hour_ago})
    ExUnit.CaptureLog.capture_log(fn -> tick() end)
    eventually(fn -> :sys.get_state(Scheduler).waiting == 4 end)
    refute_enqueued(worker: Coord.Workers.Round)
    assert :sys.get_state(Scheduler).busy_at > an_hour_ago + 3_000_000, "a waiting round keeps the machine awake"

    # the minute is over
    :sys.replace_state(Scheduler, &%{&1 | round_end: wall() - 61_000})
    ExUnit.CaptureLog.capture_log(fn -> tick() end)
    assert_enqueued([worker: Coord.Workers.Round, args: %{"round" => 4}], 2_000)
    eventually(fn -> :sys.get_state(Scheduler).waiting == nil end)

    # a round a stop cut short goes on at once (an intake pass may come first: every third tick)
    finish_jobs()
    fake("plan", :json, ~s({"round":5,"resume":true,"why":"resume"}))
    :sys.replace_state(Scheduler, &%{&1 | round_end: wall()})

    for _ <- 1..2 do
      ExUnit.CaptureLog.capture_log(fn -> tick() end)
      Coord.Repo.update_all(from(j in Oban.Job, where: j.worker == "Coord.Workers.Intake"), set: [state: "completed"])
    end

    assert_enqueued([worker: Coord.Workers.Round, args: %{"round" => 5}], 2_000)
  end

  test "the wait counts from the last round that finished, at this boot or an earlier one; a failed round never waits" do
    :persistent_term.put({Coord.Settings, :settings}, %{round_gap_min: 1})
    on_exit(fn -> :persistent_term.erase({Coord.Settings, :settings}) end)
    # an earlier boot's round ended just now
    File.mkdir_p!(Coord.Config.coord_dir())
    File.write!(round_end_file(), Integer.to_string(wall()))
    fake("plan", :json, ~s({"round":4,"resume":false,"why":"changed"}))
    start_scheduler()
    ready()
    finish_jobs()
    ExUnit.CaptureLog.capture_log(fn -> tick() end)
    eventually(fn -> :sys.get_state(Scheduler).waiting == 4 end)
    refute_enqueued(worker: Coord.Workers.Round)

    # a round that failed (exit 1) starts no wait and is not held back by the one before it; a finished one is kept
    ExUnit.CaptureLog.capture_log(fn -> GenServer.cast(Scheduler, {:round_done, 4, {:exit, 1, ""}}) end)
    eventually(fn -> :sys.get_state(Scheduler).last_ran == 4 end)
    ended = :sys.get_state(Scheduler).round_end
    assert File.read!(round_end_file()) == Integer.to_string(ended)
    ExUnit.CaptureLog.capture_log(fn -> tick() end)
    assert_enqueued([worker: Coord.Workers.Round, args: %{"round" => 4}], 2_000)

    finish_jobs()
    ExUnit.CaptureLog.capture_log(fn -> GenServer.cast(Scheduler, {:round_done, 4, {:exit, 0, ""}}) end)
    eventually(fn -> :sys.get_state(Scheduler).round_end != ended end)
    assert File.read!(round_end_file()) == Integer.to_string(:sys.get_state(Scheduler).round_end)
  end

  test "no plan while a Round job is incomplete" do
    fake("plan", :json, ~s({"round":4,"resume":false,"why":"changed"}))
    start_scheduler()
    ready()
    finish_jobs()
    Oban.insert!(Coord.Workers.Round.new(%{"arena" => "open", "round" => 3, "boot" => Coord.Boot.id()}))
    tick()
    tick()
    refute Enum.any?(fake_events(), &String.starts_with?(&1, "start plan"))
  end

  test "a round that already ran at this boot is not queued again" do
    fake("plan", :json, ~s({"round":4,"resume":true,"why":"resume"}))
    start_scheduler()
    ready()
    finish_jobs()
    ExUnit.CaptureLog.capture_log(fn -> tick() end)
    assert_enqueued([worker: Coord.Workers.Round], 2_000)
    finish_jobs()

    log =
      ExUnit.CaptureLog.capture_log(fn ->
        tick()
        eventually(fn -> :sys.get_state(Scheduler).warned != MapSet.new() end)
      end)

    assert log =~ "already ran at this boot"
    assert Coord.Repo.aggregate(where(Oban.Job, worker: "Coord.Workers.Round"), :count) == 1
  end

  test "an untrusted plan result is ignored" do
    fake("plan", :json, ~s({"round":-1,"resume":false}))
    start_scheduler()
    ready()
    finish_jobs()
    ExUnit.CaptureLog.capture_log(fn -> tick() && Process.sleep(300) end)
    refute_enqueued(worker: Coord.Workers.Round)
  end

  test "a wake queues an intake pass on a tick that is not a third one" do
    start_scheduler()
    ready()
    finish_jobs()
    %{ticks: ticks} = :sys.get_state(Scheduler)
    assert rem(ticks, 3) != 0
    Scheduler.wake()
    assert_enqueued([worker: Coord.Workers.Intake], 1_000)
  end

  test "an accepted version starts the settle clock, which plan receives" do
    fake("plan", :json, ~s({"round":null,"why":"settling"}))
    start_scheduler()
    ready()
    Scheduler.intake_done(0, 1)
    finish_jobs()
    tick()
    eventually(fn -> Enum.find(fake_events(), &String.starts_with?(&1, "start plan")) end)
    "start plan --arena open --settled-since " <> rest = Enum.find(fake_events(), &(&1 =~ "start plan"))
    settled = rest |> String.split(" ") |> hd() |> String.to_integer()
    assert_in_delta settled, System.os_time(:millisecond), 5_000
  end

  test "idle: with nothing to do for GAMES_IDLE_MIN it stops the VM with 0" do
    put_setting(:idle_ms, 0)
    put_setting(:settle_ms, 0)
    start_scheduler()
    ready()
    finish_jobs()
    ExUnit.CaptureLog.capture_log(fn -> tick() && assert_receive({:stop, 0}, 2_000) end)
  end

  test "idle waits for the plan's answer: a round it names is queued, and there is no stop" do
    put_setting(:idle_ms, 0)
    put_setting(:settle_ms, 0)
    fake("plan", :json, ~s({"round":2,"resume":false,"why":"stale"}))
    fake("plan", :sleep, 1)
    start_scheduler()
    ready()
    finish_jobs()
    tick()
    assert_enqueued([worker: Coord.Workers.Round], 3_000)
    refute_received {:stop, _}
  end

  test "a round that already ran at this boot does not keep the machine up" do
    put_setting(:idle_ms, 0)
    put_setting(:settle_ms, 0)
    fake("plan", :json, ~s({"round":4,"resume":true,"why":"resume"}))
    start_scheduler()
    ready()
    finish_jobs()

    ExUnit.CaptureLog.capture_log(fn ->
      tick()
      assert_enqueued([worker: Coord.Workers.Round], 2_000)
      refute_received {:stop, _}
      finish_jobs()

      # plan names it again (standings still say it runs): no new job, and nothing else to do
      tick()
      assert_receive {:stop, 0}, 3_000
    end)

    assert Coord.Repo.aggregate(where(Oban.Job, worker: "Coord.Workers.Round"), :count) == 1
  end

  test "not idle with a job incomplete" do
    put_setting(:idle_ms, 0)
    put_setting(:settle_ms, 0)
    start_scheduler()
    ready()
    tick()
    refute_received {:stop, _}
  end

  test "nothing happens on a tick while stopping" do
    start_scheduler()
    ready()
    finish_jobs()
    Coord.Shutdown.set_stopping(true)
    Scheduler.wake()
    tick()
    refute_enqueued(worker: Coord.Workers.Intake)
  end

  test "after a restart within a boot, both clocks start now" do
    :persistent_term.put({Scheduler, :set_up}, false)
    start_scheduler(restart: true)
    state = :sys.get_state(Scheduler)
    assert state.settled_at != nil
    assert_in_delta state.settled_wall, System.os_time(:millisecond), 5_000
  end

  test "a restart after this boot's setup does not run setup or warm again, and is ready at once" do
    start_scheduler()
    ready()
    stop_supervised!(Scheduler)
    finish_jobs()
    reset_fake()

    start_scheduler(restart: true)
    assert :sys.get_state(Scheduler).phase == :ready
    assert_enqueued([worker: Coord.Workers.Intake], 1_000)
    refute Enum.any?(fake_events(), &(&1 =~ ~r/^start (setup|warm) /))
  end

  test "a new boot runs setup again" do
    :persistent_term.put({Scheduler, :set_up}, true)
    start_scheduler(restart: false)
    assert :sys.get_state(Scheduler).phase in [:setup, :warming, :ready]
    eventually(fn -> "end setup 0" in fake_events() end)
  end
end
