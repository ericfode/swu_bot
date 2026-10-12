import Config

# exqlite 0.42 reads this (EXQLITE_FORCE_BUILD does nothing): build the NIF from source, never download it
config :exqlite, force_build: true

config :coord, ecto_repos: [Coord.Repo]

# The defaults; config/runtime.exs reads the GAMES_* variables over them (see Coord.Config)
config :coord, Coord.Config,
  data: "/data",
  app: "/app",
  node: "/usr/local/bin/node",
  port: 8080,
  listen: "::",
  proxy_port: 8081,
  idle_ms: 10 * 60_000,
  settle_ms: 90_000,
  tick_ms: 20_000,
  replay_hours: 24,
  round_cap_ms: 6 * 3_600_000,
  games: 2,
  workers: 2,
  require_mount: false,
  require_token: false,
  window: "http://127.0.0.1:8080",
  window_req: [],
  residents: nil,
  card_json: nil,
  arena_user: "arena",
  isolate: :auto,
  choom: :auto

config :coord, Oban,
  # SQLite: the Isolated peer (always the leader) and the PG notifier
  engine: Oban.Engines.Lite,
  repo: Coord.Repo,
  queues: [intake: 1, rounds: 1],
  # opt-in, as are lifeline and cron, which stay off (Coord.Boot cancels orphaned jobs instead)
  pruner: [max_age: {7, :days}],
  shutdown_grace_period: 3_000

# server: and http: come from Coord.Application.endpoint_spec/2 (GAMES_LISTEN, PORT)
config :coord, CoordWeb.Endpoint,
  adapter: Bandit.PhoenixAdapter,
  render_errors: [formats: [json: CoordWeb.ErrorJSON], layout: false]

config :phoenix, :json_library, Jason

config :logger, :default_formatter, format: "$time [$level] $message\n"

import_config "#{config_env()}.exs"
