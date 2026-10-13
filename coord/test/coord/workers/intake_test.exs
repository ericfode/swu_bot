defmodule Coord.Workers.IntakeTest do
  use Coord.Case, async: false
  use Oban.Testing, repo: Coord.Repo, engine: Oban.Engines.Lite

  alias Coord.Workers.Intake

  @moduletag :fake

  # stands in for the Scheduler, to see what the worker tells it
  setup do
    Process.register(self(), Coord.Scheduler)
    :ok
  end

  test "reports the counts to the Scheduler; the pass knows its state file and boot" do
    fake("intake", :json, ~s({"open":2,"accepted":1,"done":3}))
    assert :ok = perform_job(Intake, %{})
    assert_received {:"$gen_cast", {:intake_done, 2, 1}}

    state = Path.join(Coord.Config.data(), "coord/intake.json")
    assert "start intake --state #{state} --boot #{Coord.Boot.id()}" in fake_events()
  end

  test "an unknown open count (window down, no toolchain) is passed on as nil" do
    fake("intake", :json, ~s({"open":null,"accepted":0,"done":0,"error":"no Javy"}))
    ExUnit.CaptureLog.capture_log(fn -> assert :ok = perform_job(Intake, %{}) end)
    assert_received {:"$gen_cast", {:intake_done, nil, 0}}
  end

  test "a failed pass is reported as unknown and never retried by Oban" do
    fake("intake", :exit, 1)
    ExUnit.CaptureLog.capture_log(fn -> assert :ok = perform_job(Intake, %{}) end)
    assert_received {:"$gen_cast", {:intake_done, nil, 0}}
  end

  test "a pass that starts while the coordinator stops does nothing" do
    Coord.Shutdown.set_stopping(true)
    on_exit(fn -> Coord.Shutdown.set_stopping(false) end)
    assert :ok = perform_job(Intake, %{})
    assert fake_events() == []
    refute_received {:"$gen_cast", _}
  end

  @tag :db
  test "at most one pass waits behind the running one" do
    {:ok, first} = Oban.insert(Intake.new(%{}))
    assert {:ok, %{conflict?: true}} = Oban.insert(Intake.new(%{}))
    first |> Ecto.Changeset.change(state: "executing") |> Coord.Repo.update!()
    assert {:ok, %{conflict?: false}} = Oban.insert(Intake.new(%{}))
  end
end
