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

  test "each boot has two different 32-byte nonces" do
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
