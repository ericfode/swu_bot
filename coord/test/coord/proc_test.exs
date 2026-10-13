defmodule Coord.ProcTest do
  # every test here starts real processes through /bin/sh, and reap_stale reads the shared pidfile folder
  use Coord.Case, async: false

  alias Coord.Proc

  @two_sleeps ["/bin/sh", "-c", "sleep 300 & sleep 300 & wait"]

  test "the child's environment is exactly what it was given" do
    System.put_env("COORD_TEST_LEAK", "from the BEAM")
    on_exit(fn -> System.delete_env("COORD_TEST_LEAK") end)

    assert {:exit, 0, out} = Proc.run(:env_test, ["/usr/bin/env"], env: %{"A" => "1", "PATH" => "/usr/bin:/bin"})
    assert out |> String.split("\n", trim: true) |> Enum.sort() == ["A=1", "PATH=/usr/bin:/bin"]
  end

  test "exit codes and stdout come back" do
    assert {:exit, 3, "one\ntwo\n"} = Proc.run(:t, ["/bin/sh", "-c", "echo one; echo two; exit 3"])
    assert {:exit, 0, "no newline"} = Proc.run(:t, ["/bin/sh", "-c", "printf 'no newline'"])
  end

  test "a command is looked up in the child's PATH, and a missing one does not start" do
    assert {:exit, 0, "hi\n"} = Proc.run(:t, ["echo", "hi"], env: %{"PATH" => "/usr/bin:/bin"})
    assert {:stopped, {:spawn_failed, {:not_found, "no-such-command"}}} = Proc.run(:t, ["no-such-command"])
  end

  test "stdout is capped at max_stdout bytes" do
    cmd = ["/bin/sh", "-c", "seq 100000"]
    assert {:exit, 0, out} = Proc.run(:t, cmd, max_stdout: 1000)
    assert byte_size(out) == 1000
  end

  test "in :log mode each line goes to the log with the kind" do
    log =
      ExUnit.CaptureLog.capture_log([level: :info], fn ->
        Logger.configure(level: :info)
        assert {:exit, 0, ""} = Proc.run(:logged, ["/bin/sh", "-c", "echo first; echo second"], stdout: :log)
        Logger.configure(level: :warning)
      end)

    assert log =~ "[logged] first"
    assert log =~ "[logged] second"
  end

  test "a timeout stops the whole group" do
    task = Task.async(fn -> Proc.run(:sleeper, @two_sleeps, timeout: 1_000, grace: 2_000) end)
    %{pgid: pgid} = running_proc(:sleeper)
    # the Proc is registered before sh has forked its two sleeps
    eventually(fn -> length(group_members(pgid)) == 3 end)
    assert {:timeout, ""} = Task.await(task)
    eventually(fn -> group_members(pgid) == [] end)
  end

  test "a child that ignores TERM gets KILL after the grace period" do
    started = System.monotonic_time(:millisecond)
    cmd = ["/bin/sh", "-c", "trap '' TERM; sleep 300 & wait"]
    task = Task.async(fn -> Proc.run(:stubborn, cmd, timeout: 200, grace: 600) end)
    %{pgid: pgid} = running_proc(:stubborn)
    assert {:timeout, ""} = Task.await(task)
    assert System.monotonic_time(:millisecond) - started >= 800
    eventually(fn -> group_members(pgid) == [] end)
  end

  test "the caller's death stops the group" do
    caller = spawn(fn -> Proc.run(:orphan, @two_sleeps, grace: 500) end)
    %{pgid: pgid, pid: proc} = running_proc(:orphan)
    ref = Process.monitor(proc)
    Process.exit(caller, :kill)
    assert_receive {:DOWN, ^ref, :process, ^proc, :normal}, 5_000
    eventually(fn -> group_members(pgid) == [] end)
  end

  test "what the child leaves running in its group is killed when it exits" do
    # the backgrounded sleep keeps running after sh exits, in sh's group
    assert {:exit, 0, out} = Proc.run(:leaver, ["/bin/sh", "-c", "sleep 300 >/dev/null & echo $$"])
    pgid = out |> String.trim() |> String.to_integer()
    eventually(fn -> group_members(pgid) == [] end)
  end

  test "a process that left the group but holds stdout does not keep the Proc (and its caller) waiting" do
    # setsid takes the sleep out of sh's group; it keeps the Port's stdout open, so the Port never reports an exit
    cmd = ["/bin/sh", "-c", "setsid /bin/sh -c 'echo $$; exec sleep 60' & wait"]
    started = System.monotonic_time(:millisecond)
    assert {:timeout, out} = Proc.run(:escaper, cmd, timeout: 200, grace: 200, env: %{"PATH" => "/usr/bin:/bin"})
    assert System.monotonic_time(:millisecond) - started < 5_000
    escaped = out |> String.trim() |> String.to_integer()
    assert group_members(escaped) != []
    Proc.signal_group(escaped, "KILL")
    eventually(fn -> group_members(escaped) == [] end)
    assert Proc.running() == []
  end

  describe "while the coordinator is stopping" do
    setup do
      Coord.Shutdown.set_stopping(true)
      on_exit(fn -> Coord.Shutdown.set_stopping(false) end)
    end

    test "only a push may start: anything else would miss Shutdown's TERM" do
      assert {:stopped, :stopping} = Proc.run(:intake, ["/bin/sh", "-c", "echo started"])
      assert {:stopped, :stopping} = Proc.run(:referee, ["/bin/sh", "-c", "echo started"])
      assert {:exit, 0, "pushed\n"} = Proc.run(:push, ["/bin/sh", "-c", "echo pushed"])
    end
  end

  test "stop_all sends TERM to every kind but the excepted ones" do
    stopped = Task.async(fn -> Proc.run(:referee, @two_sleeps, grace: 500) end)
    kept = Task.async(fn -> Proc.run(:push, ["/bin/sh", "-c", "sleep 1"]) end)
    running_proc(:referee)
    running_proc(:push)

    assert [_] = Proc.stop_all([:push], 500)
    assert {:stopped, :shutdown} = Task.await(stopped)
    assert {:exit, 0, ""} = Task.await(kept)
  end

  test "a pidfile is written while the child runs and removed after" do
    task = Task.async(fn -> Proc.run(:pidfile, ["/bin/sh", "-c", "sleep 1"]) end)
    %{pgid: pgid} = running_proc(:pidfile)
    file = Path.join(Coord.Config.procs_dir(), "#{pgid}.json")

    entry = eventually(fn -> File.exists?(file) and Jason.decode!(File.read!(file)) end)
    assert %{"kind" => "pidfile", "pgid" => ^pgid, "start" => start, "kernel_boot" => boot} = entry
    assert start == Proc.start_time(pgid)
    assert boot == Proc.kernel_boot()

    assert {:exit, 0, ""} = Task.await(task)
    refute File.exists?(file)
  end

  describe "reap_stale" do
    setup do
      File.rm_rf!(Coord.Config.procs_dir())
      File.mkdir_p!(Coord.Config.procs_dir())
      :ok
    end

    test "kills the group of a pidfile whose start time and boot id match, and skips the others" do
      orphan = start_outside_proc()
      reused = start_outside_proc()
      other_boot = start_outside_proc()

      write_pidfile(orphan, Proc.start_time(orphan), Proc.kernel_boot())
      write_pidfile(reused, "1", Proc.kernel_boot())
      write_pidfile(other_boot, Proc.start_time(other_boot), "another-boot")

      ExUnit.CaptureLog.capture_log(fn -> Proc.reap_stale() end)

      eventually(fn -> group_members(orphan) == [] end)
      assert group_members(reused) != []
      assert group_members(other_boot) != []
      assert File.ls!(Coord.Config.procs_dir()) == []

      Proc.signal_group(reused, "KILL")
      Proc.signal_group(other_boot, "KILL")
    end
  end

  describe "command_line" do
    test "arena children go through isolate.sh when isolating, after choom" do
      put_setting(:isolate, true)
      put_setting(:choom, "/usr/bin/choom")
      data = Coord.Config.data()
      isolate_sh = Path.join(Coord.Config.app(), "bot/arena/ops/isolate.sh")

      assert Proc.command_line(:plan, ["node", "x.js"], as: :arena) ==
               {:ok,
                ["/usr/bin/choom", "-n", "300", "--", "bash", isolate_sh, "--user", "arena"] ++
                  ["--tmp", Path.join(data, "tmp/plan"), "--hide", "/.fly", "--hide", Path.join(data, "secret")] ++
                  ["--hide", Path.join(data, "coord"), "--", "node", "x.js"]}

      # root children are never wrapped (the referee's own argv already holds isolate.sh)
      assert Proc.command_line(:setup, ["node", "x.js"], as: :root) ==
               {:ok, ["/usr/bin/choom", "-n", "300", "--", "node", "x.js"]}
    end

    test "without isolation or choom the argv runs as it is" do
      put_setting(:isolate, false)
      put_setting(:choom, false)
      assert Proc.command_line(:plan, ["node", "x.js"], as: :arena) == {:ok, ["node", "x.js"]}
    end

    test "a helper's arena children run under setpriv as the bots' user when the BEAM is root, without namespaces" do
      put_setting(:isolate, :user)
      put_setting(:choom, "/usr/bin/choom")
      put_setting(:arena_user, "nobody")
      setpriv = ["--clear-groups", "--inh-caps=-all", "--bounding-set=-all", "--no-new-privs", "--"]

      assert Proc.setpriv_argv(996, 995) == ["setpriv", "--reuid=996", "--regid=995"] ++ setpriv

      if Proc.root?() do
        assert {:ok, {uid, gid}} = Proc.user_ids("nobody")
        assert Proc.isolation() == :setpriv
        refute Proc.isolate?()

        assert Proc.command_line(:play, ["node", "x.js"], as: :arena) ==
                 {:ok, ["/usr/bin/choom", "-n", "300", "--"] ++ Proc.setpriv_argv(uid, gid) ++ ["node", "x.js"]}
      else
        # not root: no wrapper
        assert Proc.isolation() == :none

        assert Proc.command_line(:play, ["node", "x.js"], as: :arena) ==
                 {:ok, ["/usr/bin/choom", "-n", "300", "--", "node", "x.js"]}
      end

      # root children are never wrapped
      assert Proc.command_line(:x, ["node", "x.js"], as: :root) ==
               {:ok, ["/usr/bin/choom", "-n", "300", "--", "node", "x.js"]}
    end

    test "under setpriv the child really runs as the bots' user, with no capabilities" do
      if Proc.root?() do
        put_setting(:isolate, :user)
        put_setting(:choom, false)
        put_setting(:arena_user, "nobody")
        {:ok, {uid, _gid}} = Proc.user_ids("nobody")
        env = %{"PATH" => "/usr/bin:/bin"}

        assert {:exit, 0, out} =
                 Proc.run(:t, ["/bin/sh", "-c", "id -u; grep CapEff /proc/self/status"], as: :arena, env: env)

        assert [^uid, "CapEff:\t0000000000000000"] =
                 out |> String.split("\n", trim: true) |> then(fn [u, c] -> [String.to_integer(u), c] end)

        assert {:exit, 0, "0\n"} = Proc.run(:t, ["/usr/bin/id", "-u"], as: :root, env: env)
      end
    end

    test "a user that does not exist is refused: nothing runs as root in its place" do
      put_setting(:isolate, :user)
      put_setting(:arena_user, "no-such-user-here")

      if Proc.root?() do
        assert Proc.command_line(:play, ["node"], as: :arena) == {:error, {:no_user, "no-such-user-here"}}
        assert {:stopped, {:spawn_failed, {:no_user, _}}} = Proc.run(:t, ["/bin/true"], as: :arena)
      end

      # a name that could pass for an option is never looked up
      assert Proc.user_ids("-x") == {:error, {:no_user, "-x"}}
    end
  end

  # a group leader that Coord.Proc does not know about, as a crashed BEAM would leave it
  defp start_outside_proc do
    port = Port.open({:spawn_executable, "/bin/sh"}, [:binary, args: ["-c", "sleep 300 & sleep 300 & wait"]])
    {:os_pid, pid} = Port.info(port, :os_pid)
    eventually(fn -> length(group_members(pid)) == 3 end)
    pid
  end

  defp write_pidfile(pgid, start, boot) do
    entry = %{kind: "referee", pgid: pgid, start: start, kernel_boot: boot}
    File.write!(Path.join(Coord.Config.procs_dir(), "#{pgid}.json"), Jason.encode!(entry))
  end
end
