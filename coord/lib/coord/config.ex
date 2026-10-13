defmodule Coord.Config do
  @moduledoc """
  The coordinator's settings: defaults in config/config.exs, read from the GAMES_* variables by config/runtime.exs.

  | Variable | Setting | Default |
  |---|---|---|
  | GAMES_DATA | data | /data |
  | GAMES_APP | app (the repo checkout: bot/arena/gamesctl.js) | /app |
  | PORT | port (wake and health) | 8080 |
  | GAMES_LISTEN | listen | :: (0.0.0.0 where the host has no IPv6) |
  | GAMES_PROXY_PORT | proxy_port (the window proxy, 127.0.0.1 only) | 8081 |
  | GAMES_IDLE_MIN | idle_ms | 10 minutes |
  | GAMES_REPLAY_HOURS | replay_hours | 24 |
  | GAMES_ROUND_HOURS | round_cap_ms | 6 hours |
  | GAMES_GAMES, GAMES_WORKERS | games, workers | 2, 2 |
  | GAMES_REQUIRE_MOUNT=1 | require_mount | off |
  | SWU_WINDOW | window | required in prod |
  | ARENA_RESIDENTS, SWU_CARD_JSON | passed on to the children when set | unset |
  | GAMES_HELPER_PORT | helper_port (the helper API; nil keeps the helper node off) | unset |
  | GAMES_HELPER_LISTEN | helper_listen | FLY_PRIVATE_IP, else :: |
  | GAMES_RELAY_PORT | relay_port (the ladder's relay, 127.0.0.1 only) | 8082 |
  | GAMES_HELPER_IMAGE | helper_image (named in a build mismatch answer) | registry.fly.io/swu-arena-games |
  | GAMES_BUILD, GAMES_CARDS | build, cards (rehearsals) | GAMES_APP/BUILD_SHA, GAMES_APP/CARDS_SHA |

  GAMES_HELPER_TOKENS (the helpers' names and token hashes) is a secret: Coord.Secrets reads it, not this module.
  A helper (COORD_ROLE=helper) reads GAMES_HELPER_URL (helper_url, required), GAMES_HELPER_SLOTS (helper_slots, 1 to
  16, default 1), GAMES_DATA, GAMES_APP, GAMES_BUILD and GAMES_CARDS; Coord.Secrets takes its GAMES_HELPER_TOKEN.
  """

  require Logger

  def get(key), do: Keyword.fetch!(Application.fetch_env!(:coord, __MODULE__), key)

  def data, do: get(:data)
  def app, do: get(:app)
  def coord_dir, do: Path.join(data(), "coord")
  def procs_dir, do: Path.join(coord_dir(), "procs")
  def gamesctl, do: Path.join(app(), "bot/arena/gamesctl.js")
  def play_seed, do: Path.join(app(), "bot/arena/play-seed.js")
  def helper_dir, do: Path.join(data(), "helper")

  @doc """
  The build this release runs (Dockerfile.games writes the commit to /app/BUILD_SHA): GAMES_BUILD when set, else
  that file, else "unknown". A helper and the games machine must run the same one.
  """
  def build, do: identity(:build, "BUILD_SHA")

  @doc "The card data's hash (/app/CARDS_SHA, made by Dockerfile.games): GAMES_CARDS when set, else \"unknown\"."
  def cards, do: identity(:cards, "CARDS_SHA")

  defp identity(key, file) do
    case get(key) do
      value when is_binary(value) and value != "" ->
        value

      _ ->
        with {:ok, text} <- File.read(Path.join(app(), file)),
             value = String.trim(text),
             true <- Regex.match?(~r/^[\w.-]{1,128}$/, value) do
          value
        else
          _ -> "unknown"
        end
    end
  end

  @doc "The address the wake and health endpoint listens on: GAMES_LISTEN, or 0.0.0.0 when IPv6 is missing."
  def listen_ip, do: parse_ip("GAMES_LISTEN", get(:listen), fn _ip -> {0, 0, 0, 0} end)

  @doc """
  The address the helper API listens on: GAMES_HELPER_LISTEN, else Fly's private address. When that IPv6 address
  cannot be used, :: becomes 0.0.0.0 (as for listen_ip/0) and any other address 127.0.0.1, never a wider one.
  """
  def helper_ip do
    parse_ip("GAMES_HELPER_LISTEN", get(:helper_listen), fn
      {0, 0, 0, 0, 0, 0, 0, 0} -> {0, 0, 0, 0}
      _ip -> {127, 0, 0, 1}
    end)
  end

  defp parse_ip(name, listen, ipv4) do
    case :inet.parse_address(String.to_charlist(listen)) do
      {:ok, ip} when tuple_size(ip) == 8 ->
        # Fly's private network is IPv6; a machine without IPv6 listens on IPv4
        if ipv6_available?(ip) do
          ip
        else
          fallback = ipv4.(ip)
          Logger.warning("no IPv6 here: listening on #{:inet.ntoa(fallback)} instead of #{listen}")
          fallback
        end

      {:ok, ip} ->
        ip

      {:error, _} ->
        raise ArgumentError, "#{name} is not an IP address: #{inspect(listen)}"
    end
  end

  defp ipv6_available?(ip) do
    case :gen_tcp.listen(0, [:inet6, ip: ip]) do
      {:ok, socket} ->
        :gen_tcp.close(socket)
        true

      {:error, _} ->
        false
    end
  end
end
