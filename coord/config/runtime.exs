import Config

# The games machine's settings come from its environment (fly.games.toml); the names start with GAMES_ as there.
# SWU_WINDOW_TOKEN, GAMES_HELPER_TOKENS and GAMES_HELPER_TOKEN are not read here: Coord.Secrets takes them out of the
# environment at boot, so they never sit in the application env. COORD_ROLE=helper makes this release a helper.
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
  data = System.get_env("GAMES_DATA", "/data")

  # GAMES_BUILD and GAMES_CARDS are for rehearsals; unset, the image's BUILD_SHA and CARDS_SHA say (Coord.Config)
  identity = fn name ->
    case System.get_env(name) do
      "" -> nil
      value -> value
    end
  end

  if System.get_env("COORD_ROLE") == "helper" do
    # A helper (Coord.Helper): the games image run on someone's computer, playing seeds the games machine hands out.
    # It needs no window, no database and no listener.
    url = String.trim_trailing(System.get_env("GAMES_HELPER_URL", ""), "/")

    if not String.match?(url, ~r{^https?://[^/]+$}) do
      raise "GAMES_HELPER_URL is required: the games machine through fly proxy, say http://host.docker.internal:18090"
    end

    slots = int.("GAMES_HELPER_SLOTS", 1)
    if slots not in 1..16, do: raise("GAMES_HELPER_SLOTS must be 1 to 16")

    config :coord, role: :helper

    config :coord, Coord.Config,
      data: data,
      app: System.get_env("GAMES_APP", "/app"),
      node: System.find_executable("node") || "/usr/local/bin/node",
      helper_url: url,
      helper_slots: slots,
      # as root the plays run as the bots' user through setpriv; Docker's container is the boundary (Coord.Proc)
      isolate: :user,
      build: identity.("GAMES_BUILD"),
      cards: identity.("GAMES_CARDS")
  else
    window =
      case System.get_env("SWU_WINDOW") do
        nil when prod? -> raise "SWU_WINDOW is required (the window's address)"
        nil -> "http://127.0.0.1:8080"
        url -> String.trim_trailing(url, "/")
      end

    # the helper API is off unless GAMES_HELPER_PORT is set (and GAMES_HELPER_TOKENS names a helper)
    helper_port =
      case System.get_env("GAMES_HELPER_PORT") do
        value when value in [nil, ""] -> nil
        value -> String.to_integer(value)
      end

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
      think_cap_sec: int.("GAMES_THINK_CAP_SEC", 60),
      require_mount: System.get_env("GAMES_REQUIRE_MOUNT") == "1",
      require_token: prod?,
      window: window,
      card_json: System.get_env("SWU_CARD_JSON"),
      helper_port: helper_port,
      # Fly's private (6PN) address: `fly proxy` reaches it, the internet does not
      helper_listen: System.get_env("GAMES_HELPER_LISTEN") || System.get_env("FLY_PRIVATE_IP") || "::",
      relay_port: int.("GAMES_RELAY_PORT", 8082),
      helper_image: System.get_env("GAMES_HELPER_IMAGE", "registry.fly.io/swu-arena-games"),
      build: identity.("GAMES_BUILD"),
      cards: identity.("GAMES_CARDS")

    config :coord, Coord.Repo,
      database: Path.join(data, "coord/coord.db"),
      journal_mode: :wal,
      synchronous: :full,
      busy_timeout: 5_000,
      pool_size: 5
  end

  # nothing is signed or encrypted with it (no sessions, no cookies), but Phoenix wants one
  config :coord, CoordWeb.Endpoint, secret_key_base: Base.encode64(:crypto.strong_rand_bytes(48))
end
