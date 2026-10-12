defmodule Coord.Secrets do
  @moduledoc """
  The window token, kept inside the BEAM only. `take!/0` runs at boot before any child is started: it keeps the
  token, removes it and the other secrets from the environment, and makes this boot's two proxy nonces.
  Children reach the window through CoordWeb.WindowProxy with a nonce, never with the token.
  """

  # what nothing started here may inherit, even by accident
  @scrubbed ~w(SWU_WINDOW_TOKEN ARENA_PUSH_TOKEN ARENA_ADMIN_TOKEN RELEASE_COOKIE FLY_API_TOKEN)

  def scrubbed, do: @scrubbed

  @doc """
  Keeps SWU_WINDOW_TOKEN and deletes the scrubbed variables. Raises when the token is missing and Coord.Config
  require_token is set (prod). Calling it again keeps the token and nonces it already has.
  """
  def take! do
    case System.get_env("SWU_WINDOW_TOKEN") do
      token when is_binary(token) and token != "" ->
        # a closure, so an inspected persistent_term or a crash report shows #Function<...>, not the token
        :persistent_term.put({__MODULE__, :token}, fn -> token end)

      _ ->
        if token() == nil and Coord.Config.get(:require_token) do
          raise "SWU_WINDOW_TOKEN is not set"
        end
    end

    Enum.each(@scrubbed, &System.delete_env/1)

    for role <- [:push, :intake] do
      if :persistent_term.get({__MODULE__, role}, nil) == nil do
        :persistent_term.put({__MODULE__, role}, new_nonce())
      end
    end

    :ok
  end

  @doc "The window token, or nil (no token outside prod)."
  def token do
    case :persistent_term.get({__MODULE__, :token}, nil) do
      nil -> nil
      fun -> fun.()
    end
  end

  @doc "This boot's nonce for :push or :intake (the first path segment after /p/ or /i/ on the proxy)."
  def nonce(role) when role in [:push, :intake] do
    case :persistent_term.get({__MODULE__, role}, nil) do
      nil -> raise "no #{role} nonce yet: Coord.Secrets.take!/0 has not run"
      nonce -> nonce
    end
  end

  @doc false
  # for the tests: forget the token and nonces, as a new boot would
  def forget do
    for key <- [:token, :push, :intake], do: :persistent_term.erase({__MODULE__, key})
    :ok
  end

  defp new_nonce, do: Base.url_encode64(:crypto.strong_rand_bytes(32), padding: false)
end
