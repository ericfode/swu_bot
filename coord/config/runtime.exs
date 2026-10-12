import Config

# The games machine's settings come from its environment (fly.games.toml); the names start with GAMES_ as there.
# SWU_WINDOW_TOKEN is not read here: Coord.Secrets.take!/0 takes it out of the environment at boot, so it never
# sits in the application env.
if config_env() != :test do
  int = fn name, default -> String.to_integer(System.get_env(name, Integer.to_string(default))) end

  # GAMES_ROUND_HOURS may be a fraction ("0.5" for a rehearsal)
  hours_ms = fn name, default ->
    case Float.parse(System.get_env(name, Integer.to_string(default))) do
      {h, ""} when h > 0 -> round(h * 3_600_000)
      _ -> raise "#{name} must be a positive number of hours"
    end
  end

  prod? = config_env() == :prod

  window =
    case System.get_env("SWU_WINDOW") do
      nil when prod? -> raise "SWU_WINDOW is required (the window's address)"
      nil -> "http://127.0.0.1:8080"
      url -> String.trim_trailing(url, "/")
    end

  data = System.get_env("GAMES_DATA", "/data")

  config :coord, Coord.Config,
    data: data,
    app: System.get_env("GAMES_APP", "/app"),
    node: System.find_executable("node") || "/usr/local/bin/node",
    port: int.("PORT", 8080),
    listen: System.get_env("GAMES_LISTEN", "::"),
    proxy_port: int.("GAMES_PROXY_PORT", 8081),
    idle_ms: int.("GAMES_IDLE_MIN", 10) * 60_000,
    replay_hours: int.("GAMES_REPLAY_HOURS", 24),
    round_cap_ms: hours_ms.("GAMES_ROUND_HOURS", 6),
    games: int.("GAMES_GAMES", 2),
    workers: int.("GAMES_WORKERS", 2),
    require_mount: System.get_env("GAMES_REQUIRE_MOUNT") == "1",
    require_token: prod?,
    window: window,
    residents: System.get_env("ARENA_RESIDENTS"),
    card_json: System.get_env("SWU_CARD_JSON")

  config :coord, Coord.Repo,
    database: Path.join(data, "coord/coord.db"),
    journal_mode: :wal,
    synchronous: :full,
    busy_timeout: 5_000,
    pool_size: 5

  # nothing is signed or encrypted with it (no sessions, no cookies), but Phoenix wants one
  config :coord, CoordWeb.Endpoint, secret_key_base: Base.encode64(:crypto.strong_rand_bytes(48))
end
