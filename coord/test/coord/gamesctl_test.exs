defmodule Coord.GamesctlTest do
  use Coord.Case, async: false

  alias Coord.Gamesctl

  describe "check_plan (plan runs as arena: only a round number gets through)" do
    test "a round, or none" do
      assert {:ok, %{round: 4, resume: false, why: "changed"}} =
               Gamesctl.check_plan(%{"round" => 4, "resume" => false, "why" => "changed"})

      assert {:ok, %{round: 3, resume: true}} = Gamesctl.check_plan(%{"round" => 3, "resume" => true})
      assert {:ok, %{round: nil}} = Gamesctl.check_plan(%{"round" => nil, "why" => "same"})
      assert {:ok, %{round: 0}} = Gamesctl.check_plan(%{"round" => 0, "resume" => false})
      assert {:ok, %{round: 1_000_000}} = Gamesctl.check_plan(%{"round" => 1_000_000, "resume" => false})
    end

    test "anything else is refused" do
      for bad <- [
            %{"round" => -1, "resume" => false},
            %{"round" => 1_000_001, "resume" => false},
            %{"round" => 4.0, "resume" => false},
            %{"round" => "4", "resume" => false},
            %{"round" => 4},
            %{"round" => 4, "resume" => "yes"},
            %{"why" => "same"},
            %{}
          ] do
        assert {:error, _} = Gamesctl.check_plan(bad), inspect(bad)
      end
    end

    test "an unknown reason does not reach the log as it came" do
      assert {:ok, %{why: "?"}} = Gamesctl.check_plan(%{"round" => nil, "why" => "\e[31mspoof\nline"})
    end
  end

  describe "check_referee_cmd" do
    @env %{"PATH" => "/usr/bin", "HOME" => "/data/home", "ARENA_HOME" => "/data/arena"}

    defp isolate_sh, do: Path.join(Coord.Config.app(), "bot/arena/ops/isolate.sh")
    defp cmd(k), do: ["/usr/local/bin/node", "/app/bot/arena/referee.js", "--round", "#{k}", "--games", "2"]

    test "a command for round k with the allowed environment" do
      assert :ok = Gamesctl.check_referee_cmd(%{"cmd" => cmd(4), "env" => @env, "cwd" => "/app"}, 4, false)
      assert :ok = Gamesctl.check_referee_cmd(%{"cmd" => cmd(4), "env" => @env}, 4, false)
    end

    test "an environment key outside the list, or a forbidden one, is refused" do
      for key <-
            ~w(X_TOKEN SWU_WINDOW SWU_WINDOW_TOKEN HTTPS_PROXY FLY_API_TOKEN RELEASE_COOKIE NODE_OPTIONS LD_PRELOAD) do
        out = %{"cmd" => cmd(4), "env" => Map.put(@env, key, "x")}
        assert {:error, "env may not hold " <> ^key} = Gamesctl.check_referee_cmd(out, 4, false)
      end
    end

    test "every allowed key is allowed" do
      env =
        Map.new(
          ~w(PATH HOME LANG TZ ARENA_HOME ARENA_RESULTS ARENA_PUBLIC_RESULTS ARENA_DASH SWU_WASM_CACHE
                       SWU_CARD_JSON ARENA_SECRET_FILE ARENA_BOT_USER ARENA_REMOTE),
          &{&1, "x"}
        )

      assert :ok = Gamesctl.check_referee_cmd(%{"cmd" => cmd(4), "env" => env}, 4, false)
    end

    test "a command without --round k is refused" do
      assert {:error, "cmd lacks --round 4"} = Gamesctl.check_referee_cmd(%{"cmd" => cmd(5), "env" => @env}, 4, false)
      cmd = ["node", "referee.js", "--round"]
      assert {:error, _} = Gamesctl.check_referee_cmd(%{"cmd" => cmd, "env" => @env}, 4, false)
    end

    test "as root the command must start with bash isolate.sh" do
      assert {:error, "cmd does not start with bash" <> _} =
               Gamesctl.check_referee_cmd(%{"cmd" => cmd(4), "env" => @env}, 4, true)

      coord = Coord.Config.coord_dir()

      isolated =
        ["bash", isolate_sh(), "--tmp", "/data/tmp/referee", "--hide", "/.fly", "--hide", coord, "--"] ++ cmd(4)

      assert :ok = Gamesctl.check_referee_cmd(%{"cmd" => isolated, "env" => @env}, 4, true)
    end

    test "as root isolate.sh must hide /.fly and the job database" do
      coord = Coord.Config.coord_dir()
      start = ["bash", isolate_sh(), "--tmp", "/data/tmp/referee"]

      assert {:error, "cmd does not hide " <> ^coord} =
               Gamesctl.check_referee_cmd(
                 %{"cmd" => start ++ ["--hide", "/.fly", "--"] ++ cmd(4), "env" => @env},
                 4,
                 true
               )

      assert {:error, "cmd does not hide /.fly and " <> ^coord} =
               Gamesctl.check_referee_cmd(%{"cmd" => start ++ ["--"] ++ cmd(4), "env" => @env}, 4, true)

      # a --hide after "--" is the referee's own argument, not isolate.sh's
      late = start ++ ["--hide", "/.fly", "--"] ++ cmd(4) ++ ["--hide", coord]
      assert {:error, "cmd does not hide " <> _} = Gamesctl.check_referee_cmd(%{"cmd" => late, "env" => @env}, 4, true)
    end

    test "malformed results are refused" do
      for out <- [
            %{"cmd" => "node referee.js --round 4", "env" => @env},
            %{"cmd" => [], "env" => @env},
            %{"cmd" => ["node", 4, "--round", "4"], "env" => @env},
            %{"cmd" => cmd(4), "env" => ["PATH=/usr/bin"]},
            %{"cmd" => cmd(4), "env" => %{"PATH" => 1}},
            %{"cmd" => cmd(4), "env" => @env, "cwd" => "relative"},
            %{"env" => @env}
          ] do
        assert {:error, _} = Gamesctl.check_referee_cmd(out, 4, false), inspect(out)
      end
    end
  end

  describe "check_intake" do
    test "counts, with open possibly unknown" do
      assert {:ok, %{open: 1, accepted: 1, done: 2}} =
               Gamesctl.check_intake(%{"open" => 1, "accepted" => 1, "done" => 2})

      assert {:ok, %{open: nil, accepted: 0, done: 0}} = Gamesctl.check_intake(%{"open" => nil})
      assert {:error, _} = Gamesctl.check_intake(%{"open" => -1})
      assert {:error, _} = Gamesctl.check_intake(%{"open" => 1, "accepted" => "1"})
    end
  end

  describe "through the fake node" do
    @describetag :fake

    test "plan reads only the last stdout line (a log line that slipped through does not break it)" do
      fake("plan", :json, "loading lineup\n{\"round\":2,\"resume\":false,\"why\":\"stale\"}")
      assert {:ok, %{round: 2, why: "stale"}} = Gamesctl.plan("open", 0)
    end

    test "exit codes other than 0, and output that is not one JSON object, are errors" do
      fake("plan", :exit, 2)
      assert {:error, "exited with 2"} = Gamesctl.plan("open", 0)
      fake("plan", :exit, 0)
      fake("plan", :json, "not json")
      assert {:error, "no JSON object on stdout"} = Gamesctl.plan("open", 0)
      fake("plan", :json, "[1,2]")
      assert {:error, _} = Gamesctl.plan("open", 0)
      fake("setup", :json, ~s({"ok":false}))
      assert {:error, _} = Gamesctl.setup()
      fake("push", :json, ~s({"ok":false}))
      assert {:ok, false} = Gamesctl.push("open")
    end

    test "a command that runs past its time limit is stopped" do
      fake("push", :sleep, 30)

      ExUnit.CaptureLog.capture_log(fn ->
        assert {:error, "ran past 300 ms"} = Gamesctl.push("open", timeout: 300)
      end)

      assert "term push" in fake_events()
    end

    test "referee-cmd asks for the round and the configured games and workers" do
      put_setting(:games, 3)
      put_setting(:workers, 1)
      assert {:ok, spec} = Gamesctl.referee_cmd("open", 9)
      assert "start referee-cmd --arena open --round 9 --games 3 --workers 1" in fake_events()
      assert %Coord.Round.Spec{arena: "open", round: 9, cap_ms: 21_600_000} = spec
      assert ["--round", "9"] in Enum.chunk_every(spec.cmd, 2, 1)
    end

    test "referee-cmd puts ARENA_REMOTE, the relay's URL, in the referee's environment only when the helper node is on" do
      assert {:ok, spec} = Gamesctl.referee_cmd("open", 9)
      refute Map.has_key?(spec.env, "ARENA_REMOTE")

      start_helper_node()
      put_setting(:relay_port, 8082)
      assert {:ok, spec} = Gamesctl.referee_cmd("open", 9)
      assert spec.env["ARENA_REMOTE"] == "http://127.0.0.1:8082/r/" <> Coord.Secrets.nonce(:remote)
      refute Coord.ChildEnv.forbidden?("ARENA_REMOTE")
      assert :ok = Gamesctl.check_referee_cmd(%{"cmd" => spec.cmd, "env" => spec.env}, 9, false)
    end

    test "an ARENA_REMOTE from referee-cmd itself is dropped, on or off" do
      cmd = ~s(["/bin/true","--round","4"])
      fake("referee-cmd", :json, ~s({"cmd":#{cmd},"env":{"PATH":"/usr/bin","ARENA_REMOTE":"http://elsewhere"}}))
      assert {:ok, spec} = Gamesctl.referee_cmd("open", 4)
      refute Map.has_key?(spec.env, "ARENA_REMOTE")

      start_helper_node()
      assert {:ok, spec} = Gamesctl.referee_cmd("open", 4)
      assert spec.env["ARENA_REMOTE"] == Coord.Remote.relay_url()
    end

    test "warm names what it warmed and what failed" do
      fake("warm", :json, ~s({"ok":true,"warmed":["a-wasm"],"failed":[{"name":"b-wasm","error":"x"}]}))
      assert {:ok, %{warmed: ["a-wasm"], failed: ["b-wasm"]}} = Gamesctl.warm()
    end
  end
end
