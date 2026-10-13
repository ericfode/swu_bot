defmodule Coord.Secrets do
  @moduledoc """
  The window token and the helper tokens, kept inside the BEAM only. `take!/0` runs at boot before any child is
  started: it keeps the token and the helpers' token hashes, removes them and the other secrets from the
  environment, and makes this boot's three nonces (the window proxy's push and intake, the helper relay's remote).
  Children reach the window through CoordWeb.WindowProxy with a nonce, never with the token.

  A helper (COORD_ROLE=helper) runs `take_helper!/0` instead: it keeps its own GAMES_HELPER_TOKEN, which goes only
  in the authorization header of its requests to the games machine.
  """

  require Logger

  # what nothing started here may inherit, even by accident
  @scrubbed ~w(SWU_WINDOW_TOKEN ARENA_PUSH_TOKEN ARENA_ADMIN_TOKEN RELEASE_COOKIE FLY_API_TOKEN GAMES_HELPER_TOKENS
               GAMES_HELPER_TOKEN)
  @roles [:push, :intake, :remote]
  @helper_name ~r/^[a-z][a-z0-9_-]{0,31}$/
  @sha256_hex ~r/^[0-9a-f]{64}$/

  def scrubbed, do: @scrubbed

  @doc """
  Keeps SWU_WINDOW_TOKEN and the GAMES_HELPER_TOKENS list and deletes the scrubbed variables. Raises when the token
  is missing and Coord.Config require_token is set (prod). Calling it again keeps the token, the list and the
  nonces it already has.
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

    case System.get_env("GAMES_HELPER_TOKENS") do
      text when is_binary(text) -> keep_helpers(text)
      nil -> :ok
    end

    Enum.each(@scrubbed, &System.delete_env/1)

    for role <- @roles do
      if :persistent_term.get({__MODULE__, role}, nil) == nil do
        :persistent_term.put({__MODULE__, role}, new_nonce())
      end
    end

    :ok
  end

  # each entry is name:sha256-hex of that helper's token; a malformed one is named by its place only (it may hold a
  # token pasted by mistake)
  defp keep_helpers(text) do
    {helpers, bad} = parse_helpers(text)

    for n <- bad do
      Logger.warning(
        "GAMES_HELPER_TOKENS: entry #{n} is not name:sha256-hex (a lowercase name other than machine); it is ignored"
      )
    end

    :persistent_term.put({__MODULE__, :helpers}, fn -> helpers end)
  end

  @doc false
  # {[{name, hash}], [the 1-based places of malformed entries]}; empty entries (a trailing comma) are skipped
  def parse_helpers(text) do
    entries = text |> String.split(",") |> Enum.map(&String.trim/1) |> Enum.with_index(1)

    Enum.reduce(entries, {[], []}, fn
      {"", _n}, acc ->
        acc

      {entry, n}, {good, bad} ->
        with [name, hash] <- String.split(entry, ":"),
             # "machine" is what the round report calls the games machine's own games (bot/arena/referee.js)
             true <- Regex.match?(@helper_name, name) and name != "machine" and Regex.match?(@sha256_hex, hash) do
          {good ++ [{name, hash}], bad}
        else
          _ -> {good, bad ++ [n]}
        end
    end)
  end

  @doc "The helpers allowed in, as [{name, sha256 hex of the token}] (empty when GAMES_HELPER_TOKENS is unset)."
  def helpers do
    case :persistent_term.get({__MODULE__, :helpers}, nil) do
      nil -> []
      fun -> fun.()
    end
  end

  @doc """
  The name of the helper whose token this is, or nil. The token's sha256 is compared in constant time with every
  entry, and the loop does not stop at a match, so the time says nothing about which entry matched. A token shorter
  than 32 bytes never matches, so a hash staged from an empty token (helper.sh with a failed `openssl`) lets no one in.
  """
  def helper_name(token) when is_binary(token) and byte_size(token) >= 32 do
    hash = :sha256 |> :crypto.hash(token) |> Base.encode16(case: :lower)

    Enum.reduce(helpers(), nil, fn {name, expected}, found ->
      if Plug.Crypto.secure_compare(hash, expected) and found == nil, do: name, else: found
    end)
  end

  def helper_name(_token), do: nil

  @doc """
  On a helper: keeps GAMES_HELPER_TOKEN and deletes the scrubbed variables. Raises when the token is missing.
  Calling it again keeps the token it already has.
  """
  def take_helper! do
    case System.get_env("GAMES_HELPER_TOKEN") do
      token when is_binary(token) and token != "" ->
        :persistent_term.put({__MODULE__, :helper_token}, fn -> token end)

      _ ->
        if helper_token() == nil, do: raise("GAMES_HELPER_TOKEN is not set")
    end

    Enum.each(@scrubbed, &System.delete_env/1)
    :ok
  end

  @doc "On a helper: its token, or nil before take_helper!/0."
  def helper_token do
    case :persistent_term.get({__MODULE__, :helper_token}, nil) do
      nil -> nil
      fun -> fun.()
    end
  end

  @doc "The window token, or nil (no token outside prod)."
  def token do
    case :persistent_term.get({__MODULE__, :token}, nil) do
      nil -> nil
      fun -> fun.()
    end
  end

  @doc """
  This boot's nonce for :push or :intake (the first path segment after /p/ or /i/ on the window proxy), or for
  :remote (after /r/ on the helper relay).
  """
  def nonce(role) when role in @roles do
    case :persistent_term.get({__MODULE__, role}, nil) do
      nil -> raise "no #{role} nonce yet: Coord.Secrets.take!/0 has not run"
      nonce -> nonce
    end
  end

  @doc false
  # for the tests: forget the tokens and nonces, as a new boot would
  def forget do
    for key <- [:token, :helpers, :helper_token | @roles], do: :persistent_term.erase({__MODULE__, key})
    :ok
  end

  defp new_nonce, do: Base.url_encode64(:crypto.strong_rand_bytes(32), padding: false)
end
