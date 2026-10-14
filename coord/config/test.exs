import Config

# One folder per test run, removed when the run ends (test/test_helper.exs)
data = Path.join(System.tmp_dir!(), "coord-test-#{System.pid()}")

# the test role starts only the Repo, ProcSup and Oban; each test starts the rest it needs (Coord.Application)
config :coord, role: :test

config :coord, Coord.Config,
  data: data,
  app: Path.expand("../..", __DIR__),
  # node is replaced by a shell script (see its header); the :node tests switch to the real one
  node: Path.expand("../test/support/fake_node", __DIR__),
  window: "http://window.test",
  window_req: [plug: {Req.Test, CoordWeb.WindowProxy}],
  # no isolate.sh in the tests, root or not (its argv is tested as data)
  isolate: false,
  tick_ms: 3_600_000,
  round_tick_ms: 3_600_000

config :coord, Coord.Repo,
  database: Path.join(data, "coord.db"),
  pool: Ecto.Adapters.SQL.Sandbox,
  pool_size: 5

config :coord, Oban, testing: :manual

config :coord, CoordWeb.Endpoint, secret_key_base: String.duplicate("test", 16)

config :logger, level: :warning
