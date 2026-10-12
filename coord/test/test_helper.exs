data = Coord.Config.data()
File.mkdir_p!(Path.join(data, "fake"))
ExUnit.after_suite(fn _ -> File.rm_rf(data) end)

# Coord.Boot migrated the database when the application started
Ecto.Adapters.SQL.Sandbox.mode(Coord.Repo, :manual)

# what Coord.Boot.prepare!/0 does at a real boot: the proxy nonces and the boot id
Coord.Secrets.take!()
Coord.Boot.new_id!()

# :node tests run the real bot/arena/gamesctl.js (CI: mix test --include node); a test's log shows when it fails
ExUnit.start(exclude: [:node], capture_log: true)
