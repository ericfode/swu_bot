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
  choom: :auto,
  # the helper node (Coord.Remote, CoordWeb.HelperAPI, CoordWeb.RemoteRelay): off while helper_port is nil
  helper_port: nil,
  helper_listen: "::",
  relay_port: 8082,
  helper_image: "registry.fly.io/swu-arena-games",
  build: nil,
  cards: nil,
  heartbeat_ms: 30_000,
  lease_lost_ms: 90_000,
  claim_ms: 25_000,
  sweep_ms: 5_000,
  lease_keep_ms: 30 * 60_000,
  # the most a round's bundles take on the volume, so puts on the relay cannot fill it
  bundles_limit: 512 * 1024 * 1024,
  # the helper role (Coord.Helper): where the games machine is, how many seeds at once, and its retry pace
  helper_url: nil,
  helper_slots: 1,
  helper_req: [],
  hello_retry_ms: 30_000,
  claim_backoff_ms: [5_000, 10_000, 20_000, 40_000, 60_000]

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
