defmodule Coord.HelperTest do
  # A helper's slots and Coord.Helper against a games machine in this VM: the real Coord.Remote and helper API on a
  # Bandit listener, and the fake node playing the seeds (test/support/fake_node, "play-seed").
  use Coord.Case, async: false

  alias Coord.Helper.{Play, Slot}
  alias Coord.Remote

  @moduletag :fake

  setup do
    start_helper_node()
    put_setting(:claim_ms, 1_000)
    pid = start_supervised!(Coord.Application.helper_api_spec({127, 0, 0, 1}, 0))
    {:ok, {_ip, port}} = ThousandIsland.listener_info(pid)
    put_setting(:helper_url, "http://127.0.0.1:#{port}")
    put_setting(:hello_retry_ms, 100)
    put_setting(:claim_backoff_ms, [50, 100])
    as_helper(helper_token("eric"))
    File.mkdir_p!(Coord.Config.helper_dir())

    on_exit(fn ->
      Req.Test.set_req_test_to_private()
      Coord.Shutdown.set_stopping(false)
    end)

    %{url: "http://127.0.0.1:#{port}"}
  end

  defp as_helper(token) do
    System.put_env("GAMES_HELPER_TOKEN", token)
    :persistent_term.erase({Coord.Secrets, :helper_token})
    Coord.Secrets.take_helper!()
  end

  defp start_slot(timing \\ %{}) do
    test = self()
    timing = Map.merge(%{heartbeat_ms: 200, claim_ms: 1_000, lease_lost_ms: 90_000}, timing)
    pid = start_supervised!({Slot, id: "1", timing: timing, stop: fn code -> send(test, {:stop, code}) end})
    eventually(fn -> Remote.status().waiting == 1 end)
    pid
  end

  defp offer(job \\ remote_job(), bundles \\ []) do
    {:ok, id, "eric"} = Remote.offer(job, bundles)
    id
  end

  defp work_dir(id), do: Path.join([Coord.Config.helper_dir(), "1", id])

  # the lease once it is done or lost (reading it then forgets it)
  defp ended(id, timeout \\ 10_000) do
    eventually(
      fn ->
        case Remote.lease(id) do
          {:running, _, _} -> false
          other -> other
        end
      end,
      timeout
    )
  end

  defp started?(name), do: Enum.any?(fake_events(), &String.starts_with?(&1, "start #{name} "))

  defp with_info_log(fun) do
    ExUnit.CaptureLog.capture_log([level: :info], fn ->
      Logger.configure(level: :info)

      try do
        fun.()
      after
        Logger.configure(level: :warning)
      end
    end)
  end

  describe "a slot" do
    test "plays a lease: the bundle, the job and play-seed.js, then posts the results and replays" do
      hex = sha256_hex("a canonical tar")
      :ok = Remote.store_bundle(hex, "a canonical tar")

      log =
        with_info_log(fn ->
          start_slot()
          id = offer(remote_job(4321), [hex])
          send(self(), {:id, id})

          assert {:done, "eric", results, replays} = ended(id)
          assert [%{"id" => "a", "result" => %{"winnerSeat" => "p1"}}, %{"id" => "b"}] = results

          assert replays == %{
                   "a" => ~s({"t":"header","game":"a"}\n{"t":"end","game":"a"}\n),
                   "b" => ~s({"t":"header","game":"b"}\n{"t":"end","game":"b"}\n)
                 }

          # the folder goes, and the slot claims the next seed
          eventually(fn -> not File.exists?(work_dir(id)) end)
          eventually(fn -> Remote.status().waiting == 1 end)
        end)

      assert_received {:id, id}
      dir = work_dir(id)
      assert "start play-seed --job #{dir}/job.json --bundles #{dir}/bundles --work #{dir}" in fake_events()
      assert "bundles #{hex}.tar " in fake_events()
      assert "job " <> json = Enum.find(fake_events(), &String.starts_with?(&1, "job "))
      assert Jason.decode!(json) == remote_job(4321)
      assert log =~ "lease #{id} (seed 4321): a won p1, b won p2;"
    end

    test "the play's environment is built from nothing: no token, no address of the machine", %{url: url} do
      System.put_env("COORD_TEST_LEAK", "from the BEAM")
      on_exit(fn -> System.delete_env("COORD_TEST_LEAK") end)
      start_slot()
      id = offer()
      assert {:done, _, _, _} = ended(id)

      env = fake_env("play-seed")
      data = Coord.Config.data()
      assert Map.keys(env) -- ["PWD"] == ~w(HOME LANG PATH SWU_WASM_CACHE TZ)
      assert env["HOME"] == Path.join(data, "home")
      assert env["SWU_WASM_CACHE"] == Path.join(data, "wasm-cache")
      refute Enum.any?(Map.values(env), &(&1 =~ helper_token("eric") or &1 =~ url))
    end

    test "a play that fails is posted as failed, so the machine plays the seed itself" do
      fake("play-seed", :exit, 1)
      start_slot()
      id = offer()
      assert ended(id) == {:lost, "eric", "play-seed exited with 1"}
      eventually(fn -> not File.exists?(work_dir(id)) end)
    end

    test "a play that prints something else than its results fails the lease" do
      fake("play-seed", :json, ~s({"ok":true,"results":[{"id":"a","result":{}}],"replays":{"a":"/etc/passwd"}}))
      start_slot()
      id = offer()
      # it made no out/ folder, and names a file elsewhere (the cases are in Play.result_body's tests)
      assert ended(id) == {:lost, "eric", "no replay folder"}
    end

    test "a bundle whose bytes are not its id fails the lease before anything plays" do
      hex = sha256_hex("the real tar")
      :ok = Remote.store_bundle(hex, "the real tar")
      File.write!(Remote.bundle_file(hex), "something else")
      start_slot()
      id = offer(remote_job(), [hex])
      assert {:lost, "eric", "bundle " <> why} = ended(id)
      assert why =~ "sha256 is not its id"
      refute started?("play-seed")
    end

    test "a heartbeat answered 410 stops the play and drops the lease" do
      fake("play-seed", :sleep, 30)
      start_slot()
      id = offer()
      running_proc(:"play-1")
      eventually(fn -> started?("play-seed") end)

      Remote.revoke(id)
      eventually(fn -> "term play-seed" in fake_events() end)
      eventually(fn -> not File.exists?(work_dir(id)) end)
      eventually(fn -> Remote.status().waiting == 1 end)
      assert Coord.Proc.running() == []
    end

    test "heartbeats keep the lease while the play runs" do
      put_setting(:lease_lost_ms, 600)
      put_setting(:sweep_ms, 50)
      send(Remote, :sweep)
      fake("play-seed", :sleep, 2)
      start_slot()
      id = offer()
      Process.sleep(1_200)
      assert {:running, "eric", _} = Remote.lease(id)
      assert {:done, "eric", _, _} = ended(id)
    end

    test "after the computer slept the play stops and the lease fails" do
      fake("play-seed", :sleep, 30)
      slot = start_slot(%{heartbeat_ms: 300})
      id = offer()
      running_proc(:"play-1")

      # the wall clock jumped a minute past the monotonic one, as after a sleep
      :sys.replace_state(slot, fn %{tick: {wall, mono}} = state -> %{state | tick: {wall - 60_000, mono}} end)

      assert ended(id) == {:lost, "eric", "the computer slept"}
      assert "term play-seed" in fake_events()
      eventually(fn -> not File.exists?(work_dir(id)) end)
    end

    test "the first heartbeat goes as soon as the lease arrives; a sleep found only when the play ends fails it" do
      fake("play-seed", :sleep, 2)
      slot = start_slot(%{heartbeat_ms: 60_000})
      id = offer()
      eventually(fn -> :sys.get_state(Remote).leases[id].acked end)

      # the wall clock jumped a minute past the monotonic one after that heartbeat, as after a sleep
      :sys.replace_state(slot, fn %{tick: {wall, mono}} = state -> %{state | tick: {wall - 60_000, mono}} end)

      assert ended(id) == {:lost, "eric", "the computer slept"}
    end

    test "a slot that stops gives its seed back at once" do
      fake("play-seed", :sleep, 30)
      start_slot()
      id = offer()
      running_proc(:"play-1")
      eventually(fn -> started?("play-seed") end)

      stop_supervised!(Slot)
      assert Remote.lease(id) == {:lost, "eric", "the helper stopped"}
      eventually(fn -> "term play-seed" in fake_events() end)
    end

    test "a claim answered 409 stops the VM with 3, naming the image; 401 with 1" do
      Req.Test.set_req_test_to_shared()
      put_setting(:helper_req, plug: {Req.Test, Coord.Helper.Client})
      want = %{build: "build-2", cards: "c", image: "registry.fly.io/swu-arena-games:build-2"}

      Req.Test.stub(Coord.Helper.Client, fn conn ->
        conn |> Plug.Conn.put_status(409) |> Req.Test.json(%{error: %{code: "build", want: want}})
      end)

      test = self()
      stop = fn code -> send(test, {:stop, code}) end

      log =
        ExUnit.CaptureLog.capture_log(fn ->
          start_supervised!({Slot, id: "1", timing: %{heartbeat_ms: 200, claim_ms: 500}, stop: stop})
          assert_receive {:stop, 3}, 2_000
        end)

      assert log =~ "pull registry.fly.io/swu-arena-games:build-2"
      stop_supervised!(Slot)

      put_setting(:helper_req, [])
      as_helper("not-a-token-the-machine-knows")

      ExUnit.CaptureLog.capture_log(fn ->
        start_supervised!({Slot, id: "1", timing: %{heartbeat_ms: 200, claim_ms: 500}, stop: stop})
        assert_receive {:stop, 1}, 2_000
      end)

      refute_received {:stop, _}
    end

    test "no answer: the claim is tried again, backing off, and logged once" do
      Req.Test.set_req_test_to_shared()
      put_setting(:helper_req, plug: {Req.Test, Coord.Helper.Client})
      test = self()

      Req.Test.stub(Coord.Helper.Client, fn conn ->
        send(test, :claimed)
        Req.Test.transport_error(conn, :econnrefused)
      end)

      log =
        ExUnit.CaptureLog.capture_log(fn ->
          stop = fn code -> send(test, {:stop, code}) end
          start_supervised!({Slot, id: "1", timing: %{heartbeat_ms: 200, claim_ms: 500}, stop: stop})
          for _ <- 1..4, do: assert_receive(:claimed, 2_000)
        end)

      assert length(String.split(log, "no claim (connection refused)")) == 2
      refute_received {:stop, _}
    end
  end

  describe "the suspend check" do
    test "the computer slept when the wall clock and the monotonic clock moved apart by more than 20 s" do
      refute Slot.slept?({0, 0}, {30_000, 30_000})
      refute Slot.slept?({1_000, 5}, {21_000, 5})
      assert Slot.slept?({1_000, 5}, {21_001, 5})
      assert Slot.slept?({0, 0}, {90_000, 30_000})
      # the other way (the wall clock set back) too
      assert Slot.slept?({0, 0}, {0, 25_000})
      refute Slot.slept?({0, 0}, {30_000, 30_000}, 0)
    end
  end

  describe "Play.result_body" do
    setup do
      dir = Path.join(data(), "result-body-#{System.unique_integer([:positive])}")
      out = Path.join(dir, "out")
      File.mkdir_p!(out)
      File.write!(Path.join(out, "a.jsonl"), "{\"t\":\"header\"}\n")
      on_exit(fn -> File.rm_rf(dir) end)
      %{dir: dir, out: out}
    end

    defp line(replays), do: Jason.encode!(%{ok: true, results: [%{id: "a", result: %{}}], replays: replays})

    test "reads the replays named in play-seed's last line", %{out: out} do
      assert {:ok, json, [%{"id" => "a"}]} = Play.result_body("a log line\n" <> line(%{a: "#{out}/a.jsonl"}), out)
      assert Jason.decode!(json)["replays"] == %{"a" => "{\"t\":\"header\"}\n"}
      assert {:ok, _, _} = Play.result_body(line(%{}), out)
    end

    test "only regular files right in out/, within the limits", %{dir: dir, out: out} do
      File.write!(Path.join(dir, "secret"), "x")
      File.ln_s!(Path.join(dir, "secret"), Path.join(out, "link.jsonl"))
      File.mkdir_p!(Path.join(out, "sub"))
      File.write!(Path.join(out, "sub/b.jsonl"), "x")

      for path <- [
            "#{dir}/secret",
            "#{out}/link.jsonl",
            "#{out}/sub/b.jsonl",
            "#{out}/../secret",
            "#{out}/missing.jsonl",
            "relative.jsonl"
          ] do
        assert {:failed, "a replay path is not a file in out/"} = Play.result_body(line(%{a: path}), out), path
      end

      {:ok, file} = :file.open(Path.join(out, "big.jsonl"), [:write, :raw])
      {:ok, _} = :file.position(file, 32_000_001)
      :ok = :file.truncate(file)
      :ok = :file.close(file)
      assert {:failed, "a replay is over 32000000 bytes"} = Play.result_body(line(%{a: "#{out}/big.jsonl"}), out)
    end

    test "anything but ok and its results fails", %{out: out} do
      for bad <- [
            "",
            "not json",
            ~s({"ok":false}),
            ~s({"ok":true,"results":{},"replays":{}}),
            ~s({"ok":true,"results":[{"id":1,"result":{}}],"replays":{}}),
            ~s({"ok":true,"results":[]})
          ] do
        assert {:failed, _} = Play.result_body(bad, out), bad
      end
    end
  end

  describe "Coord.Helper" do
    defp start_helper do
      test = self()
      start_supervised!({Coord.Helper, stop: fn code -> send(test, {:stop, code}) end})
    end

    test "warms, says hello, then its slots claim seeds" do
      put_setting(:heartbeat_ms, 1_000)
      put_setting(:helper_slots, 2)
      start_helper()
      eventually(fn -> Remote.status() == %{waiting: 2, hosts: ["eric"]} end)
      assert started?("play-seed-warm")
      starts = for "start " <> rest <- fake_events(), do: rest
      assert List.first(starts) == "play-seed-warm --warm"
    end

    test "a failed warm is only logged" do
      fake("play-seed-warm", :exit, 1)

      log =
        ExUnit.CaptureLog.capture_log(fn ->
          start_helper()
          eventually(fn -> Remote.status().waiting == 1 end)
        end)

      assert log =~ "play-seed --warm failed (play-seed exited with 1)"
      refute_received {:stop, _}
    end

    test "hello answered 409 stops the VM with 3, 401 with 1" do
      put_setting(:build, "build-1")
      Req.Test.set_req_test_to_shared()
      put_setting(:helper_req, plug: {Req.Test, Coord.Helper.Client})

      Req.Test.stub(Coord.Helper.Client, fn conn ->
        want = %{build: "build-9", image: "registry.fly.io/swu-arena-games:build-9"}
        conn |> Plug.Conn.put_status(409) |> Req.Test.json(%{error: %{code: "build", want: want}})
      end)

      log = ExUnit.CaptureLog.capture_log(fn -> start_helper() && assert_receive({:stop, 3}, 5_000) end)
      assert log =~ "the games machine runs build build-9: pull registry.fly.io/swu-arena-games:build-9"
      stop_supervised!(Coord.Helper)

      put_setting(:helper_req, [])
      as_helper("unknown-token")
      ExUnit.CaptureLog.capture_log(fn -> start_helper() && assert_receive({:stop, 1}, 5_000) end)
      assert Remote.status().hosts == []
    end

    test "with no answer it says hello again every hello_retry_ms, logging it once, and never stops" do
      Req.Test.set_req_test_to_shared()
      put_setting(:helper_req, plug: {Req.Test, Coord.Helper.Client})
      test = self()

      Req.Test.stub(Coord.Helper.Client, fn conn ->
        send(test, :hello)
        Req.Test.transport_error(conn, :econnrefused)
      end)

      log =
        ExUnit.CaptureLog.capture_log(fn ->
          start_helper()
          for _ <- 1..3, do: assert_receive(:hello, 2_000)
        end)

      assert length(String.split(log, "hello: no answer from the games machine (connection refused)")) == 2
      refute_received {:stop, _}
    end
  end

  describe "Coord.Helper.prepare!" do
    setup do
      dir = Path.join(System.tmp_dir!(), "coord-helper-test-#{System.unique_integer([:positive])}")
      on_exit(fn -> File.rm_rf(dir) end)
      put_setting(:data, dir)
      %{dir: dir}
    end

    test "keeps the token, scrubs the environment and makes the folders; old work folders go", %{dir: dir} do
      File.mkdir_p!(Path.join(dir, "helper/1/old-lease"))
      System.put_env("GAMES_HELPER_TOKEN", "prepared-token")
      System.put_env("SWU_WINDOW_TOKEN", "not-for-helpers")
      on_exit(fn -> System.delete_env("SWU_WINDOW_TOKEN") end)
      :persistent_term.erase({Coord.Secrets, :helper_token})

      assert :ok = Coord.Helper.prepare!()
      assert Coord.Secrets.helper_token() == "prepared-token"
      assert System.get_env("GAMES_HELPER_TOKEN") == nil
      assert System.get_env("SWU_WINDOW_TOKEN") == nil
      assert File.ls!(Path.join(dir, "helper")) == []
      assert Bitwise.band(File.stat!(Path.join(dir, "helper")).mode, 0o777) == 0o700
      assert Bitwise.band(File.stat!(Path.join(dir, "coord")).mode, 0o777) == 0o700
      assert File.dir?(Path.join(dir, "home"))
      assert File.dir?(Path.join(dir, "wasm-cache"))
    end

    test "without GAMES_HELPER_TOKEN it raises" do
      System.delete_env("GAMES_HELPER_TOKEN")
      :persistent_term.erase({Coord.Secrets, :helper_token})
      assert_raise RuntimeError, ~r/GAMES_HELPER_TOKEN/, fn -> Coord.Helper.prepare!() end
    end

    test "as root with plays as the bots' user: their folders are theirs, and the work folders reachable", %{dir: dir} do
      if Coord.Proc.root?() do
        put_setting(:isolate, :user)
        put_setting(:arena_user, "nobody")
        {:ok, {uid, gid}} = Coord.Proc.user_ids("nobody")
        assert :ok = Coord.Helper.prepare!()
        assert Bitwise.band(File.stat!(Path.join(dir, "helper")).mode, 0o777) == 0o711
        assert %File.Stat{uid: ^uid, gid: ^gid} = File.stat!(Path.join(dir, "home"))
        assert %File.Stat{uid: ^uid, gid: ^gid} = File.stat!(Path.join(dir, "wasm-cache"))

        put_setting(:arena_user, "no-such-user-here")
        assert_raise RuntimeError, ~r/no user no-such-user-here/, fn -> Coord.Helper.prepare!() end
      end
    end
  end
end
