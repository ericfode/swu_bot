defmodule Coord.Workers.RoundTest do
  use Coord.Case, async: false
  use Oban.Testing, repo: Coord.Repo, engine: Oban.Engines.Lite

  alias Coord.Workers.Round

  @moduletag :db
  @moduletag :fake

  setup do
    start_supervised!(Coord.Round.pool_spec())
    on_exit(fn -> Coord.Shutdown.set_stopping(false) end)
    :ok
  end

  defp args(k, boot \\ Coord.Boot.id()), do: %{"arena" => "open", "round" => k, "boot" => boot}

  defp started?(name), do: Enum.any?(fake_events(), &String.starts_with?(&1, "start #{name} "))

  test "a referee that exits 0 completes the job; it played the round it was given" do
    assert :ok = perform_job(Round, args(4))
    assert "start referee-cmd --arena open --round 4 --games 2 --workers 2" in fake_events()
    assert "start referee --round 4 --games 2 --workers 2" in fake_events()
  end

  test "a referee that fails is retried once, 30 s later, then discarded" do
    fake("referee", :exit, 1)
    {:ok, job} = Oban.insert(Round.new(args(5)))

    ExUnit.CaptureLog.capture_log(fn ->
      assert %{failure: 1} = Oban.drain_queue(queue: :rounds)
      retry = Coord.Repo.reload!(job)
      assert retry.state == "retryable"
      assert retry.attempt == 1
      assert_in_delta DateTime.diff(retry.scheduled_at, DateTime.utc_now()), 30, 2

      assert %{discard: 1} = Oban.drain_queue(queue: :rounds, with_scheduled: true)
      assert Coord.Repo.reload!(job).state == "discarded"
    end)

    assert Enum.count(fake_events(), &String.starts_with?(&1, "start referee ")) == 2
    assert Round.backoff(job) == 30
  end

  test "exit 1 is an error that names the exit code" do
    fake("referee", :exit, 1)
    assert {:error, "referee: exited with 1"} = perform_job(Round, args(4))
  end

  test "a round past the cap is cancelled" do
    put_setting(:round_cap_ms, 300)
    fake("referee", :sleep, 30)

    ExUnit.CaptureLog.capture_log(fn ->
      assert {:cancel, "round 4 ran past " <> _} = perform_job(Round, args(4))
    end)

    assert "term referee" in fake_events()
  end

  test "a round stopped by a shutdown snoozes, so it does not count as an attempt" do
    fake("referee", :sleep, 30)
    task = Task.async(fn -> perform_job(Round, args(4)) end)
    running_proc(:referee)
    eventually(fn -> started?("referee") end)

    Coord.Shutdown.set_stopping(true)
    Coord.Proc.stop_all([:push], 2_000)
    assert {:snooze, 60} = Task.await(task, 10_000)
    assert "term referee" in fake_events()
  end

  test "a referee-cmd stopped by a shutdown snoozes too, and no referee starts" do
    fake("referee-cmd", :sleep, 30)
    task = Task.async(fn -> perform_job(Round, args(4)) end)
    running_proc(:referee_cmd)
    eventually(fn -> started?("referee-cmd") end)

    Coord.Shutdown.set_stopping(true)
    Coord.Proc.stop_all([:push], 2_000)
    assert {:snooze, 60} = Task.await(task, 10_000)
    refute started?("referee")
  end

  test "no round starts while stopping" do
    Coord.Shutdown.set_stopping(true)
    assert {:snooze, 60} = perform_job(Round, args(4))
    refute started?("referee-cmd")
  end

  test "a job from an earlier boot is cancelled without running" do
    assert {:cancel, _} = perform_job(Round, args(4, "an-earlier-boot"))
    refute started?("referee-cmd")
  end

  test "the same arena, round and boot conflict in every state; another boot does not" do
    {:ok, first} = Oban.insert(Round.new(args(7)))
    refute first.conflict?
    assert {:ok, %{conflict?: true}} = Oban.insert(Round.new(args(7)))

    for state <- ~w(completed discarded cancelled) do
      first |> Ecto.Changeset.change(state: state) |> Coord.Repo.update!()
      assert {:ok, %{conflict?: true}} = Oban.insert(Round.new(args(7))), state
    end

    assert {:ok, %{conflict?: false}} = Oban.insert(Round.new(args(8)))
    assert {:ok, %{conflict?: false}} = Oban.insert(Round.new(args(7, "the-next-boot")))
    assert {:ok, %{conflict?: false}} = Oban.insert(Round.new(%{args(7) | "arena" => "nosims"}))
  end

  test "a referee-cmd result with a token in its environment is refused, and nothing runs" do
    cmd = ~s(["/bin/true","--round","4"])
    fake("referee-cmd", :json, ~s({"cmd":#{cmd},"env":{"PATH":"/usr/bin","X_TOKEN":"t"},"cwd":"/"}))
    assert {:error, "referee-cmd: env may not hold X_TOKEN"} = perform_job(Round, args(4))
    refute started?("referee")
  end

  test "a referee-cmd result without --round K is refused" do
    fake("referee-cmd", :json, ~s({"cmd":["/bin/true","--round","5"],"env":{"PATH":"/usr/bin"},"cwd":"/"}))
    assert {:error, "referee-cmd: cmd lacks --round 4"} = perform_job(Round, args(4))
    fake("referee-cmd", :json, ~s({"cmd":["/bin/true"],"env":{"PATH":"/usr/bin"},"cwd":"/"}))
    assert {:error, "referee-cmd: cmd lacks --round 4"} = perform_job(Round, args(4))
  end

  test "a failing referee-cmd is an error (retried like a failed referee)" do
    fake("referee-cmd", :exit, 1)
    assert {:error, "referee-cmd: exited with 1"} = perform_job(Round, args(4))
  end

  test "the job's time limit is the round cap plus two minutes" do
    put_setting(:round_cap_ms, 1_000)
    assert Round.timeout(%Oban.Job{}) == 121_000
  end
end
