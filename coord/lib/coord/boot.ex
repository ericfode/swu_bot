defmodule Coord.Boot do
  @moduledoc """
  What happens once per boot.

  prepare!/0 runs in Coord.Application.start/2, before the tree: the volume check, the coordinator's folders, the
  BEAM's OOM score, the secrets and the boot id. As a child placed right after the Repo, start_link/0 migrates the
  database, reaps the child groups an earlier run left behind and cancels its jobs, then returns :ignore.
  """

  import Ecto.Query

  require Logger

  alias Coord.Config

  # with one node, a job still in one of these at boot belongs to an earlier run: the window's documents and
  # standings.json hold the real state, so the Scheduler plans the work again from them
  @orphan_states ~w(available scheduled executing retryable suspended)

  def prepare! do
    data = Config.data()

    if Config.get(:require_mount) and not mountpoint?(data) do
      raise "#{data} is not a mounted volume (GAMES_REQUIRE_MOUNT=1)"
    end

    File.mkdir_p!(Config.coord_dir())
    File.chmod!(Config.coord_dir(), 0o700)
    File.mkdir_p!(Config.procs_dir())
    protect_from_oom()
    Coord.Secrets.take!()
    new_id!()
    :ok
  end

  @doc "Whether path is on another file system than / (a Fly volume is)."
  def mountpoint?(path) do
    with {:ok, %File.Stat{major_device: dev}} <- File.stat(path),
         {:ok, %File.Stat{major_device: root}} <- File.stat("/") do
      dev != root
    else
      _ -> false
    end
  end

  # the children start with choom -n 300, so the kernel's OOM killer picks a ladder or a check before the BEAM
  defp protect_from_oom do
    case File.write("/proc/self/oom_score_adj", "-500") do
      :ok -> :ok
      {:error, reason} -> Logger.info("could not lower the BEAM's OOM score (#{inspect(reason)})")
    end
  end

  @doc "This boot's id: Round jobs carry it, so a round that failed twice waits for the next boot."
  def id, do: :persistent_term.get({__MODULE__, :id}, nil)

  @doc false
  def new_id! do
    id = Base.url_encode64(:crypto.strong_rand_bytes(12), padding: false)
    :persistent_term.put({__MODULE__, :id}, id)
    id
  end

  def child_spec(_opts), do: %{id: __MODULE__, start: {__MODULE__, :start_link, []}}

  def start_link do
    Ecto.Migrator.run(Coord.Repo, :up, all: true, log: false)
    Coord.Proc.reap_stale()
    count = cancel_orphans()
    if count > 0, do: Logger.info("cancelled #{count} jobs left by an earlier run")
    :ignore
  end

  @doc """
  Cancels every job an earlier run left unfinished. Oban's lifeline is not used: it rescues by elapsed time only,
  so it would start a second copy of a round that is still running.
  """
  def cancel_orphans do
    query = from(j in Oban.Job, where: j.state in @orphan_states)
    {count, _} = Coord.Repo.update_all(query, set: [state: "cancelled", cancelled_at: DateTime.utc_now()])
    count
  end
end
