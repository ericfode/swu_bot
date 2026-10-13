defmodule Coord.RemoteTest do
  use Coord.Case, async: false

  alias Coord.Remote

  setup do
    start_helper_node()
    :ok
  end

  # a lease given to eric, its claim's answer sent (by the claim's process, as CoordWeb.HelperAPI does)
  defp running_lease(job \\ remote_job(), bundles \\ []) do
    task =
      Task.async(fn ->
        {:ok, lease} = Remote.await_claim("eric", "1", 5_000)
        :ok = Remote.claim_sent(lease.id)
        lease.id
      end)

    eventually(fn -> Remote.status().waiting == 1 end)
    {:ok, id, "eric"} = Remote.offer(job, bundles)
    ^id = Task.await(task)
    id
  end

  test "enabled only with a helper port and at least one valid token" do
    assert Remote.enabled?()
    put_setting(:helper_port, nil)
    refute Remote.enabled?()
    put_setting(:helper_port, 8090)
    System.put_env("GAMES_HELPER_TOKENS", "bad entry")
    Coord.Secrets.forget()
    ExUnit.CaptureLog.capture_log(fn -> Coord.Secrets.take!() end)
    refute Remote.enabled?()
  end

  test "the sweep marks a lease without a heartbeat lost, and one past its deadline" do
    put_setting(:lease_lost_ms, 300)
    put_setting(:sweep_ms, 50)
    # the sweep started at 5 s; this one comes every 50 ms from now
    send(Remote, :sweep)
    quiet = running_lease()
    beating = running_lease(remote_job(2))

    for _ <- 1..6 do
      Process.sleep(100)
      :ok = Remote.heartbeat(beating, "eric")
    end

    assert Remote.lease(quiet) == {:lost, "eric", "no heartbeat"}
    assert {:running, "eric", _} = Remote.lease(beating)
    assert Remote.heartbeat(quiet, "eric") == :gone

    # the deadline: gameMs + 5 min after the claim's answer (30 min + 5 when the job has none)
    assert Remote.deadline_ms(%{"gameMs" => 1_000}) == 301_000
    assert Remote.deadline_ms(%{"gameMs" => 0}) == 35 * 60_000
    assert Remote.deadline_ms(%{}) == 35 * 60_000
    state = :sys.get_state(Remote)
    later = state.leases[beating].deadline_at + 1
    swept = Remote.sweep(%{state | leases: Map.update!(state.leases, beating, &%{&1 | beat_at: later})}, later)
    assert %{state: :lost, reason: "deadline"} = swept.leases[beating]
  end

  test "a running lease whose first heartbeat does not come within lease_ack_ms is lost as claim dropped" do
    put_setting(:lease_ack_ms, 200)
    put_setting(:sweep_ms, 50)
    send(Remote, :sweep)
    silent = running_lease()
    acked = running_lease(remote_job(2))
    :ok = Remote.heartbeat(acked, "eric")
    Process.sleep(400)

    assert Remote.lease(silent) == {:lost, "eric", "claim dropped"}
    assert {:running, "eric", _} = Remote.lease(acked)
  end

  test "a claim waiting when the server restarted gives up instead of waiting forever" do
    waiting = Task.async(fn -> Remote.await_claim("eric", "1", 500) end)
    eventually(fn -> Remote.status().waiting == 1 end)
    stop_supervised!(Remote)
    start_supervised!(Remote)
    assert Task.await(waiting, 8_000) == :none
  end

  test "done and lost leases nobody reads are forgotten after lease_keep_ms" do
    put_setting(:lease_keep_ms, 1_000)
    id = running_lease()
    :ok = Remote.result(id, "eric", {:failed, "x"})
    state = :sys.get_state(Remote)
    assert Remote.sweep(state, state.leases[id].ended_at + 999).leases[id]
    refute Remote.sweep(state, state.leases[id].ended_at + 1_001).leases[id]
  end

  test "reset forgets every lease and deletes the bundles; waiting claims stay" do
    hex = sha256_hex("tar")
    :ok = Remote.store_bundle(hex, "tar")
    id = running_lease(remote_job(), [hex])
    waiting = Task.async(fn -> Remote.await_claim("bob", "1", 3_000) end)
    eventually(fn -> Remote.status().waiting == 1 end)

    assert :ok = Remote.reset()
    assert Remote.lease(id) == :unknown
    assert Remote.heartbeat(id, "eric") == :gone
    assert File.ls!(Remote.bundles_dir()) == []
    assert Remote.status().waiting == 1
    assert Task.await(waiting, 4_000) == :none
  end

  test "a new Remote (a boot) starts with an empty bundles folder" do
    File.write!(Path.join(Remote.bundles_dir(), "stale.tar"), "x")
    stop_supervised!(Remote)
    start_supervised!(Remote)
    assert File.ls!(Remote.bundles_dir()) == []
  end

  test "reset does nothing when the helper node is off" do
    stop_supervised!(Remote)
    assert Remote.reset() == :ok
  end

  test "no offer goes out while the machine stops" do
    task = Task.async(fn -> Remote.await_claim("eric", "1", 5_000) end)
    eventually(fn -> Remote.status().waiting == 1 end)
    Coord.Shutdown.set_stopping(true)
    on_exit(fn -> Coord.Shutdown.set_stopping(false) end)
    assert Remote.offer(remote_job(), []) == :none
    assert Task.await(task, 3_000) == :stopping
  end
end
