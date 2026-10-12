defmodule Coord.Application do
  @moduledoc """
  The games machine's coordinator. Elixir decides when things happen (wake, intake cadence, rounds, idle, stop);
  Node decides what happens (bot/arena/gamesctl.js).

  The tree stops in reverse order: the Endpoint (no more wakes), Coord.Shutdown (TERM to every child group but a
  push, then wait), the Scheduler, Oban, the FLAME pool, the Pusher (its last push, after the round stopped), the
  window proxy, ProcSup (KILL to anything left), the Repo. That takes about 22 s at most, inside Fly's 30 s.
  """

  use Application

  @impl true
  def start(_type, _args), do: start_tree(role(), name: Coord.Supervisor)

  @doc false
  def start_tree(role, opts) do
    # only the coordinator takes the token: a runner (M2) holds none
    if role == :coordinator, do: Coord.Boot.prepare!()
    # more than 3 restarts in 5 s ends the application, and with it the VM (exit 1: Fly restarts the machine)
    Supervisor.start_link(children(role), [strategy: :one_for_one, max_restarts: 3, max_seconds: 5] ++ opts)
  end

  @doc """
  :runner on a FLAME runner (M2; nothing runs there in M1), :coordinator otherwise. The tests set :test, which
  starts the Repo (migrated by Coord.Boot), ProcSup and Oban in manual mode, and leaves the rest to each test.
  """
  def role do
    if FLAME.Parent.get(), do: :runner, else: Application.get_env(:coord, :role, :coordinator)
  end

  @doc false
  def children(:runner), do: []

  def children(:test), do: [Coord.Repo, Coord.Boot, Coord.ProcSup, {Oban, Application.fetch_env!(:coord, Oban)}]

  def children(:coordinator) do
    [
      Coord.Repo,
      Coord.Boot,
      Coord.ProcSup,
      proxy_spec(Coord.Config.get(:proxy_port)),
      Coord.Pusher,
      Coord.Round.pool_spec(),
      {Oban, Application.fetch_env!(:coord, Oban)},
      Coord.Scheduler,
      Coord.Shutdown,
      endpoint_spec(Coord.Config.listen_ip(), Coord.Config.get(:port))
    ]
  end

  @doc "The wake and health endpoint's listener (the app env sets neither, so these options hold)."
  def endpoint_spec(ip, port), do: {CoordWeb.Endpoint, server: true, http: [ip: ip, port: port]}

  @doc """
  The window proxy's listener: loopback only. It stops after the last push, so a request still open then belongs
  to a push that was killed; it may be waiting up to 60 s on a slow window, and Thousand Island's default 15 s wait
  for it would break the stop's budget (Fly kills the machine at 30 s).
  """
  def proxy_spec(port) do
    Supervisor.child_spec(
      {Bandit,
       plug: CoordWeb.WindowProxy,
       scheme: :http,
       ip: {127, 0, 0, 1},
       port: port,
       startup_log: false,
       thousand_island_options: [shutdown_timeout: 1_000]},
      id: CoordWeb.WindowProxy
    )
  end
end
