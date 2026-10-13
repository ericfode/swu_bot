defmodule Coord.SecretsTest do
  use Coord.Case, async: false

  alias Coord.Secrets

  @token "s3cret-window-token-xyz"

  setup do
    on_exit(fn ->
      for name <- Secrets.scrubbed(), do: System.delete_env(name)
      Secrets.forget()
      Secrets.take!()
    end)
  end

  test "take! keeps the token and removes it, the cookie and the other tokens from the environment" do
    for name <- Secrets.scrubbed(), do: System.put_env(name, "value-of-" <> name)
    System.put_env("SWU_WINDOW_TOKEN", @token)
    Secrets.forget()

    assert :ok = Secrets.take!()
    assert Secrets.token() == @token
    for name <- Secrets.scrubbed(), do: assert(System.get_env(name) == nil, name)
  end

  test "the token is kept as a function, so inspecting persistent_term does not print it" do
    System.put_env("SWU_WINDOW_TOKEN", @token)
    Secrets.forget()
    Secrets.take!()
    refute inspect(:persistent_term.get()) =~ @token
  end

  test "a second take! keeps the token and the nonces" do
    System.put_env("SWU_WINDOW_TOKEN", @token)
    Secrets.forget()
    Secrets.take!()
    push = Secrets.nonce(:push)
    Secrets.take!()
    assert Secrets.token() == @token
    assert Secrets.nonce(:push) == push
  end

  test "each boot has two different 32-byte proxy nonces" do
    Secrets.forget()
    Secrets.take!()
    push = Secrets.nonce(:push)
    intake = Secrets.nonce(:intake)
    assert push != intake
    assert byte_size(Base.url_decode64!(push, padding: false)) == 32
    assert byte_size(Base.url_decode64!(intake, padding: false)) == 32
  end

  test "without a token, take! raises when one is required (prod)" do
    put_setting(:require_token, true)
    Secrets.forget()
    assert_raise RuntimeError, ~r/SWU_WINDOW_TOKEN/, fn -> Secrets.take!() end
  end

  defp sha(token), do: :sha256 |> :crypto.hash(token) |> Base.encode16(case: :lower)
  # helper tokens are at least 32 bytes (Secrets.helper_name/1)
  defp tok(x), do: "token-#{x}-" <> String.duplicate("0", 32)

  describe "the helpers' tokens (GAMES_HELPER_TOKENS)" do
    test "each entry is name:sha256 of a token; a token is known by its hash, and only by it" do
      System.put_env("GAMES_HELPER_TOKENS", "eric:#{sha(tok("a"))}, bob_2:#{sha(tok("b"))},")
      Secrets.forget()
      Secrets.take!()

      assert Secrets.helpers() == [{"eric", sha(tok("a"))}, {"bob_2", sha(tok("b"))}]
      assert Secrets.helper_name(tok("a")) == "eric"
      assert Secrets.helper_name(tok("b")) == "bob_2"
      assert Secrets.helper_name(tok("c")) == nil
      assert Secrets.helper_name(sha(tok("a"))) == nil
      assert Secrets.helper_name("") == nil
      assert Secrets.helper_name(nil) == nil
      assert System.get_env("GAMES_HELPER_TOKENS") == nil
    end

    test "a hash staged from an empty or short token lets no one in" do
      System.put_env("GAMES_HELPER_TOKENS", "eric:#{sha("")},bob:#{sha("short")}")
      Secrets.forget()
      Secrets.take!()

      assert length(Secrets.helpers()) == 2
      assert Secrets.helper_name("") == nil
      assert Secrets.helper_name("short") == nil
    end

    test "a malformed entry is logged by its place, never its text, and ignored" do
      pasted = "the-raw-token-pasted-by-mistake"

      entries = [
        "eric:#{sha(tok("a"))}",
        pasted,
        "Eric:#{sha(tok("b"))}",
        "carl:#{String.upcase(sha(tok("c")))}",
        "dan:#{sha(tok("d"))}:extra",
        "x" <> String.duplicate("y", 32) <> ":#{sha(tok("e"))}"
      ]

      System.put_env("GAMES_HELPER_TOKENS", Enum.join(entries, ","))
      Secrets.forget()

      log = ExUnit.CaptureLog.capture_log(fn -> Secrets.take!() end)

      assert Secrets.helpers() == [{"eric", sha(tok("a"))}]
      for n <- 2..6, do: assert(log =~ "GAMES_HELPER_TOKENS: entry #{n} is not name:sha256-hex", "entry #{n}")
      refute log =~ pasted
      refute log =~ "token-"
      refute log =~ sha(tok("b"))
      assert Secrets.helper_name(tok("c")) == nil
    end

    test "unset or empty, no helper is known" do
      System.put_env("GAMES_HELPER_TOKENS", "")
      Secrets.forget()
      Secrets.take!()
      assert Secrets.helpers() == []

      Secrets.forget()
      Secrets.take!()
      assert Secrets.helpers() == []
    end

    test "the list is kept as a function, and a second take! keeps it" do
      System.put_env("GAMES_HELPER_TOKENS", "eric:#{sha(tok("a"))}")
      Secrets.forget()
      Secrets.take!()
      refute inspect(:persistent_term.get()) =~ sha(tok("a"))
      Secrets.take!()
      assert Secrets.helper_name(tok("a")) == "eric"
    end
  end

  test "the relay's nonce is a third 32-byte nonce" do
    Secrets.forget()
    Secrets.take!()
    remote = Secrets.nonce(:remote)
    assert remote not in [Secrets.nonce(:push), Secrets.nonce(:intake)]
    assert byte_size(Base.url_decode64!(remote, padding: false)) == 32
  end

  describe "on a helper (take_helper!)" do
    test "it keeps GAMES_HELPER_TOKEN as a function and scrubs the environment" do
      System.put_env("GAMES_HELPER_TOKEN", "the-helper-token")
      System.put_env("SWU_WINDOW_TOKEN", @token)
      Secrets.forget()

      assert :ok = Secrets.take_helper!()
      assert Secrets.helper_token() == "the-helper-token"
      assert Secrets.token() == nil
      for name <- Secrets.scrubbed(), do: assert(System.get_env(name) == nil, name)
      refute inspect(:persistent_term.get()) =~ "the-helper-token"

      # a second call keeps it
      assert :ok = Secrets.take_helper!()
      assert Secrets.helper_token() == "the-helper-token"
    end

    test "without GAMES_HELPER_TOKEN it raises" do
      Secrets.forget()
      assert_raise RuntimeError, ~r/GAMES_HELPER_TOKEN/, fn -> Secrets.take_helper!() end
      System.put_env("GAMES_HELPER_TOKEN", "")
      assert_raise RuntimeError, ~r/GAMES_HELPER_TOKEN/, fn -> Secrets.take_helper!() end
    end
  end

  @tag :fake
  test "while intake runs, no process's command line holds the token or a nonce" do
    System.put_env("SWU_WINDOW_TOKEN", @token)
    Secrets.forget()
    Secrets.take!()
    fake("intake", :sleep, 3)

    task = Task.async(fn -> Coord.Gamesctl.intake() end)
    running_proc(:intake)
    eventually(fn -> Enum.any?(fake_log(), &String.starts_with?(&1, "start intake")) end)
    {ps, 0} = System.cmd("ps", ["-eo", "args"])

    assert ps =~ "gamesctl.js intake"
    refute ps =~ @token
    refute ps =~ Secrets.nonce(:intake)
    refute ps =~ Secrets.nonce(:push)
    Coord.Proc.stop_kind(:intake, 1_000)
    Task.await(task)
  end
end
