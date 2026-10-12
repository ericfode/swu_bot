defmodule Coord.MixProject do
  use Mix.Project

  def project do
    [
      app: :coord,
      version: "0.1.0",
      elixir: "~> 1.19",
      elixirc_paths: elixirc_paths(Mix.env()),
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      releases: [coord: [include_executables_for: [:unix]]]
    ]
  end

  def application do
    [mod: {Coord.Application, []}, extra_applications: [:logger, :crypto, :public_key]]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  # exqlite (0.42) comes in through ecto_sqlite3 and is pinned by mix.lock; config :exqlite, force_build: true
  # makes it compile from source. No muontrap and no erlexec: Coord.Proc starts every OS process with a plain Port.
  defp deps do
    [
      {:phoenix, "~> 1.8.15"},
      {:bandit, "~> 1.12.5"},
      {:jason, "~> 1.4.5"},
      {:oban, "~> 2.24.1"},
      {:ecto_sql, "~> 3.14.0"},
      {:ecto_sqlite3, "~> 0.25.0"},
      {:flame, "~> 0.5.4"},
      {:req, "~> 0.7.5"}
    ]
  end
end
