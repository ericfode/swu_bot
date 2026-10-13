defmodule Coord.ChildEnvTest do
  use Coord.Case, async: false

  alias Coord.{ChildEnv, Gamesctl}

  @leaky %{
    "SWU_WINDOW_TOKEN" => "s3cret-token",
    "ARENA_PUSH_TOKEN" => "push-token",
    "HTTPS_PROXY" => "http://proxy.example:3128",
    "http_proxy" => "http://proxy.example:3128",
    "FLY_API_TOKEN" => "fly-token",
    "FLY_REGION" => "dfw",
    "RELEASE_COOKIE" => "cookie",
    "RELEASE_NODE" => "coord@host",
    "ERL_AFLAGS" => "-kernel shell_history enabled",
    "COORD_TEST_OTHER" => "anything the BEAM has"
  }
  @forbidden ~r/TOKEN|PROXY|FLY|RELEASE|COOKIE/i

  defp ctx(kind), do: Gamesctl.context(kind)

  describe "for_kind" do
    test "every kind gets the base, its HOME, and SWU_WINDOW only for push and intake" do
      data = Coord.Config.data()

      for kind <- ChildEnv.kinds() do
        env = ChildEnv.for_kind(kind, ctx(kind))
        assert env["GAMES_DATA"] == data
        assert env["LANG"] == "C.UTF-8"
        assert env["TZ"] == "UTC"
        assert env["NODE_ENV"] == "production"
        assert env["ARENA_USER"] == "arena"
        assert env["GAMES_HIDE"] == "/.fly:" <> Path.join(data, "coord")
        assert env["PATH"] =~ "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

        if kind in [:push, :intake] do
          assert env["SWU_WINDOW"] =~ ~r"^http://127\.0\.0\.1:\d+/[pi]/[\w-]{43}$"
        else
          refute Map.has_key?(env, "SWU_WINDOW")
        end

        for {k, _} <- env, k != "SWU_WINDOW", do: refute(ChildEnv.forbidden?(k), "#{kind} has #{k}")
      end

      assert ChildEnv.for_kind(:push, ctx(:push))["SWU_WINDOW"] =~ "/p/" <> Coord.Secrets.nonce(:push)
      assert ChildEnv.for_kind(:intake, ctx(:intake))["SWU_WINDOW"] =~ "/i/" <> Coord.Secrets.nonce(:intake)
      assert ChildEnv.for_kind(:plan, ctx(:plan))["HOME"] == Path.join(data, "home")
      assert ChildEnv.for_kind(:push, ctx(:push))["HOME"] == Path.join(data, "home")
    end

    test "ARENA_RESIDENTS and SWU_CARD_JSON pass on only when set" do
      refute Map.has_key?(ChildEnv.for_kind(:setup, ctx(:setup)), "ARENA_RESIDENTS")
      put_setting(:residents, "heuristic,rush")
      put_setting(:card_json, "/cards")
      env = ChildEnv.for_kind(:setup, ctx(:setup))
      assert env["ARENA_RESIDENTS"] == "heuristic,rush"
      assert env["SWU_CARD_JSON"] == "/cards"
    end

    test "a window that is not this machine's proxy is refused" do
      assert_raise ArgumentError, fn ->
        ChildEnv.for_kind(:push, %{ctx(:push) | window: "https://swu-arena.fly.dev"})
      end
    end

    test "forbidden? covers tokens, proxies, Fly, the release and the BEAM's own variables" do
      for key <- ~w(SWU_WINDOW_TOKEN X_TOKEN HTTPS_PROXY http_proxy FLY_REGION RELEASE_COOKIE ERL_AFLAGS BINDIR
                    ROOTDIR EMU PROGNAME SWU_WINDOW) do
        assert ChildEnv.forbidden?(key), key
      end

      for key <- ~w(PATH HOME ARENA_HOME SWU_CARD_JSON ARENA_SECRET_FILE), do: refute(ChildEnv.forbidden?(key), key)
    end
  end

  describe "the environments children really get" do
    @describetag :fake

    setup do
      # as if Coord.Secrets.take!/0 had missed them, or something put them back
      for {k, v} <- @leaky, do: System.put_env(k, v)
      on_exit(fn -> for {k, _} <- @leaky, do: System.delete_env(k) end)
    end

    test "no child sees a token, a proxy, Fly's or the release's variables, and only push and intake the window" do
      assert {:ok, _} = Gamesctl.setup()
      assert {:ok, _} = Gamesctl.warm()
      assert {:ok, _} = Gamesctl.plan("open", 0)
      assert {:ok, _} = Gamesctl.intake()
      assert {:ok, true} = Gamesctl.push("open")
      assert {:ok, spec} = Gamesctl.referee_cmd("open", 4)
      assert {:exit, 0, ""} = Coord.Round.play(spec)

      for name <- ~w(setup warm plan referee-cmd intake push referee) do
        env = fake_env(name)
        assert env != %{}, name
        assert Enum.filter(Map.keys(env), &(&1 != "SWU_WINDOW" and Regex.match?(@forbidden, &1))) == [], name
        refute Map.has_key?(env, "COORD_TEST_OTHER"), name

        if name in ~w(push intake) do
          assert env["SWU_WINDOW"] =~ ~r{^http://127\.0\.0\.1:\d+/[pi]/}
        else
          refute Map.has_key?(env, "SWU_WINDOW"), name
        end
      end

      # the referee's environment is exactly referee-cmd's
      assert Map.keys(fake_env("referee")) -- ["PWD"] == Enum.sort(Map.keys(spec.env))
    end
  end
end
