defmodule Coord.Application do
  @moduledoc """
  The games machine's coordinator. Elixir decides when things happen (wake, intake cadence, rounds, idle, stop);
  Node decides what happens (bot/arena/gamesctl.js).

  The tree stops in reverse order: the Endpoint (no more wakes), Coord.Shutdown (TERM to every child group but a
  push, then wait), the Scheduler, Oban, the FLAME pool, the helper API and relay with Coord.Remote when the helper
  node is on (1 s each at most), the Pusher (its last push, after the round stopped), the window proxy, ProcSup
  (KILL to anything left), the Repo. That takes about 24 s at most, inside Fly's 30 s.

  With COORD_ROLE=helper the same release is a helper (Coord.Helper): ProcSup and the helper only.
  """

  use Application

  @impl true
  def start(_type, _args), do: start_tree(role(), name: Coord.Supervisor)

  @doc false
  def start_tree(role, opts) do
    # only the coordinator takes the token: a runner (M2) holds none, a helper only its own
    case role do
      :coordinator -> Coord.Boot.prepare!()
      :helper -> Coord.Helper.prepare!()
      _ -> :ok
    end

    # more than 3 restarts in 5 s ends the application, and with it the VM (exit 1: Fly restarts the machine)
    Supervisor.start_link(children(role), [strategy: :one_for_one, max_restarts: 3, max_seconds: 5] ++ opts)
  end

  @doc """
  :runner on a FLAME runner (M2; nothing runs there in M1), :helper with COORD_ROLE=helper, :coordinator otherwise.
  The tests set :test, which starts the Repo (migrated by Coord.Boot), ProcSup and Oban in manual mode, and leaves
  the rest to each test.
  """
  def role do
    if FLAME.Parent.get(), do: :runner, else: Application.get_env(:coord, :role, :coordinator)
  end

  @doc false
  def children(:runner), do: []

  def children(:test), do: [Coord.Repo, Coord.Boot, Coord.ProcSup, {Oban, Application.fetch_env!(:coord, Oban)}]

  # no Repo, Boot, Oban or Endpoint: a helper keeps no jobs and listens on nothing
  def children(:helper), do: [Coord.ProcSup, Coord.Helper]

  def children(:coordinator) do
    [
      Coord.Repo,
      Coord.Boot,
      Coord.ProcSup,
      proxy_spec(Coord.Config.get(:proxy_port)),
      Coord.Pusher
    ] ++
      remote_specs(Coord.Remote.enabled?()) ++
      [
        Coord.Round.pool_spec(),
        {Oban, Application.fetch_env!(:coord, Oban)},
        Coord.Scheduler,
        Coord.Shutdown,
        endpoint_spec(Coord.Config.listen_ip(), Coord.Config.get(:port))
      ]
  end

  @doc """
  The helper node's children, only when it is on: Coord.Remote, then the relay and the helper API. They come just
  before the FLAME pool, so they stop after the round (the ladder may still read a lease while it stops).
  """
  def remote_specs(false), do: []

  def remote_specs(true) do
    [
      Coord.Remote,
      relay_spec(Coord.Config.get(:relay_port)),
      helper_api_spec(Coord.Config.helper_ip(), Coord.Config.get(:helper_port))
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

  @doc "The ladder's relay to the helper node: loopback only, and as quick to stop as the window proxy."
  def relay_spec(port), do: listener(CoordWeb.RemoteRelay, {127, 0, 0, 1}, port)

  @doc """
  The helper API's listener: Fly's private address (GAMES_HELPER_LISTEN), reached through `fly proxy` only. A claim
  waiting there sees the stop flag within a second and answers 503.
  """
  def helper_api_spec(ip, port), do: listener(CoordWeb.HelperAPI, ip, port)

  defp listener(plug, ip, port) do
    Supervisor.child_spec(
      {Bandit,
       plug: plug,
       scheme: :http,
       ip: ip,
       port: port,
       startup_log: false,
       thousand_island_options: [shutdown_timeout: 1_000]},
      id: plug
    )
  end
end
