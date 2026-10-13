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
  """

  require Logger

  def get(key), do: Keyword.fetch!(Application.fetch_env!(:coord, __MODULE__), key)

  def data, do: get(:data)
  def app, do: get(:app)
  def coord_dir, do: Path.join(data(), "coord")
  def procs_dir, do: Path.join(coord_dir(), "procs")
  def gamesctl, do: Path.join(app(), "bot/arena/gamesctl.js")

  @doc "The address the wake and health endpoint listens on: GAMES_LISTEN, or 0.0.0.0 when IPv6 is missing."
  def listen_ip do
    listen = get(:listen)

    case :inet.parse_address(String.to_charlist(listen)) do
      {:ok, ip} when tuple_size(ip) == 8 ->
        # as games.js: Fly's private network is IPv6, a machine without IPv6 listens on IPv4
        if ipv6_available?(ip) do
          ip
        else
          Logger.warning("no IPv6 here: listening on 0.0.0.0 instead of #{listen}")
          {0, 0, 0, 0}
        end

      {:ok, ip} ->
        ip

      {:error, _} ->
        raise ArgumentError, "GAMES_LISTEN is not an IP address: #{inspect(listen)}"
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
