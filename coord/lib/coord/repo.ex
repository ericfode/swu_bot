defmodule Coord.Repo do
  @moduledoc "The coordinator's SQLite database (GAMES_DATA/coord/coord.db): Oban's jobs and nothing else."

  use Ecto.Repo, otp_app: :coord, adapter: Ecto.Adapters.SQLite3

  # The pool's connections all switch a new file to WAL at once, and SQLite may answer one of them "database is
  # locked" without waiting (exqlite sets busy_timeout only after journal_mode). WAL is kept in the file, so
  # switching once here, before the pool starts, makes theirs a no-op.
  @impl true
  def init(_context, config) do
    if path = config[:database], do: wal!(path)
    {:ok, config}
  end

  defp wal!(path) do
    File.mkdir_p!(Path.dirname(path))
    {:ok, db} = Exqlite.Sqlite3.open(path)

    try do
      :ok = Exqlite.Sqlite3.execute(db, "PRAGMA journal_mode = WAL")
    after
      Exqlite.Sqlite3.close(db)
    end
  end
end
