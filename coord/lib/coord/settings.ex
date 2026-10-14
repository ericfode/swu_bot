defmodule Coord.Settings do
  @moduledoc """
  Eric's arena settings, from the window's admin page (GET /api/arena-settings, read with the window token):

  | Setting | Group | What it changes | Without it |
  |---|---|---|---|
  | gamesPerPair | arena | games each pair plays in a new round (even, 2 to 10) | GAMES_GAMES |
  | thinkCapSec | arena | each bot's thinking time per game in a new round (10 to 600 s) | GAMES_THINK_CAP_SEC |
  | workers | compute | games played at once (1 to 16) | GAMES_WORKERS |
  | roundGapMin | compute | minutes from one round's end to the next round's start (0 to 240) | 0 |

  It reads them at start and every settings_ms (a minute), and keeps the last answer in coord/settings.json on the
  volume, so a boot that cannot reach the window plays by the last settings it had. A value missing or out of range
  falls back to the default. games/0, workers/0, think_cap_ms/0 and round_gap_ms/0 never block: they read a
  persistent term. A round that a stop cut short keeps its own games per pair and time limit (gamesctl.js roundRules).
  """

  # nothing to save at a stop (the file is written whole, then renamed), and a read of the window may be under way:
  # 1 s keeps the stop inside Fly's 30 s (Coord.Application)
  use GenServer, shutdown: 1_000

  require Logger

  alias Coord.Config

  @fields [
    {"gamesPerPair", :games, 2..10//2},
    {"thinkCapSec", :think_cap_sec, 10..600},
    {"workers", :workers, 1..16},
    {"roundGapMin", :round_gap_min, 0..240}
  ]

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "The settings in force: a map with any of :games, :think_cap_sec, :workers, :round_gap_min."
  def current, do: :persistent_term.get({__MODULE__, :settings}, %{})

  def games, do: Map.get(current(), :games) || Config.get(:games)
  def workers, do: Map.get(current(), :workers) || Config.get(:workers)
  def think_cap_ms, do: (Map.get(current(), :think_cap_sec) || Config.get(:think_cap_sec)) * 1000
  def round_gap_ms, do: (Map.get(current(), :round_gap_min) || 0) * 60_000

  @doc "The valid settings in the window's map (its JSON names); anything else is dropped."
  def parse(map) when is_map(map) do
    Enum.reduce(@fields, %{}, fn {name, key, range}, acc ->
      case Map.get(map, name) do
        value when is_integer(value) -> if value in range, do: Map.put(acc, key, value), else: acc
        _ -> acc
      end
    end)
  end

  def parse(_other), do: %{}

  @doc "The settings as the window names them (for the file and the log)."
  def to_json(settings) do
    for {name, key, _range} <- @fields, Map.has_key?(settings, key), into: %{}, do: {name, settings[key]}
  end

  def file, do: Path.join(Config.coord_dir(), "settings.json")

  @impl true
  def init(_opts) do
    settings =
      with {:ok, text} <- File.read(file()),
           {:ok, map} <- Jason.decode(text) do
        parse(map)
      else
        _ -> %{}
      end

    :persistent_term.put({__MODULE__, :settings}, settings)
    {:ok, %{failed: nil}, {:continue, :read}}
  end

  @impl true
  def handle_continue(:read, state), do: {:noreply, read(state)}

  @impl true
  def handle_info(:read, state), do: {:noreply, read(state)}
  def handle_info(_message, state), do: {:noreply, state}

  defp read(state) do
    Process.send_after(self(), :read, Config.get(:settings_ms))

    case fetch() do
      {:ok, map} ->
        if state.failed, do: Logger.info("arena settings: the window answers again")
        apply_settings(parse(map))
        %{state | failed: nil}

      {:error, why} ->
        # once per kind of failure: the window may be down for a while, and this asks every minute
        if why != state.failed, do: Logger.warning("arena settings: #{why}; keeping #{describe(current())}")
        %{state | failed: why}
    end
  end

  defp fetch do
    headers =
      case Coord.Secrets.token() do
        nil -> []
        token -> [{"authorization", "Bearer " <> token}]
      end

    options =
      [
        method: :get,
        url: Config.get(:window) <> "/api/arena-settings",
        headers: headers,
        retry: false,
        redirect: false,
        receive_timeout: 15_000
      ] ++ Config.get(:window_req)

    case Req.request(options) do
      {:ok, %Req.Response{status: 200, body: %{"result" => %{"settings" => map}}}} when is_map(map) -> {:ok, map}
      {:ok, %Req.Response{status: status}} -> {:error, "the window answered #{status}"}
      {:error, exception} -> {:error, "the window did not answer (#{Exception.message(exception)})"}
    end
  end

  defp apply_settings(settings) do
    if settings != current() do
      :persistent_term.put({__MODULE__, :settings}, settings)
      Logger.info("arena settings: #{describe(settings)}")

      tmp = file() <> ".tmp"

      with :ok <- File.write(tmp, Jason.encode!(to_json(settings))),
           :ok <- File.rename(tmp, file()) do
        :ok
      else
        {:error, reason} -> Logger.warning("arena settings: could not keep them on the volume (#{inspect(reason)})")
      end
    end
  end

  defp describe(settings) do
    "#{settings[:games] || Config.get(:games)} games per pair, " <>
      "#{settings[:think_cap_sec] || Config.get(:think_cap_sec)} s to think per game, " <>
      "#{settings[:workers] || Config.get(:workers)} at once, #{settings[:round_gap_min] || 0} min between rounds"
  end
end
