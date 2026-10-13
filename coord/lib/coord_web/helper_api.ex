defmodule CoordWeb.HelperAPI do
  @moduledoc """
  The helper API (bot/arena/HELPER.md): what a helper (Coord.Helper, on someone's computer through `fly proxy`)
  calls on the games machine, served on GAMES_HELPER_LISTEN:GAMES_HELPER_PORT (Fly's private address, never a
  [[services]] port). Only in the tree when the helper node is on (Coord.Remote.enabled?/0).

  Every request carries `authorization: Bearer <token>`, whose sha256 must be one of GAMES_HELPER_TOKENS (401
  otherwise), and `x-helper-build`, which must be this machine's build (409 otherwise, naming the image to run).
  While the machine stops, everything is 503. Routes, all under /v1:

    * POST hello {build, cards, slots}: the timing to follow, or 409 when the build or the cards differ
    * POST claim {slot}: waits up to claimMs for a seed: 200 {lease, job, bundles, deadlineMs}, or 204
    * GET bundle/<hex>: a bundle named by a lease this helper holds now (else 404)
    * POST lease/<id>/heartbeat: 200 {continue: true} while this helper holds it, else 410
    * POST lease/<id>/result {results, replays} or {failed}: 200, or 410 as for a heartbeat

  Tokens and paths are never logged; helper names and lease ids may be.
  """

  @behaviour Plug

  import Plug.Conn

  require Logger

  alias Coord.Remote
  alias CoordWeb.Body

  @small 4_096
  @result_limit 40_000_000
  @lease_id ~r/^[A-Za-z0-9_-]{1,64}$/
  @slot ~r/^[A-Za-z0-9_-]{1,32}$/
  @failed_chars 300

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    with {:ok, name} <- authorize(conn),
         :ok <- check_build(conn),
         :ok <- check_running(conn) do
      route(conn, conn.method, conn.path_info, name)
    end
  rescue
    # a broken connection is Bandit's to report (it logs no path); anything else is answered here, so that no
    # crash report prints the request (its path, its authorization header)
    e in [Bandit.TransportError, Bandit.HTTPError] ->
      reraise e, __STACKTRACE__

    e ->
      Logger.error("helper API: #{inspect(e.__struct__)} raised")
      Body.error(conn, 500, "internal", "the games machine could not answer")
  catch
    :exit, _ ->
      Logger.error("helper API: the lease server did not answer")
      Body.error(conn, 503, "unavailable", "the games machine could not answer")
  end

  defp authorize(conn) do
    with ["Bearer " <> token] <- get_req_header(conn, "authorization"),
         name when is_binary(name) <- Coord.Secrets.helper_name(token) do
      {:ok, name}
    else
      _ -> Body.error(conn, 401, "unauthorized", "a helper token is needed")
    end
  end

  defp check_build(conn) do
    case get_req_header(conn, "x-helper-build") do
      [build] -> if Remote.build_matches?(build), do: :ok, else: wrong_build(conn)
      _ -> wrong_build(conn)
    end
  end

  defp wrong_build(conn) do
    want = Remote.wanted()
    message = "the games machine runs build #{want.build}"
    Body.json(conn, 409, %{error: %{code: "build", message: message, want: want}})
  end

  defp check_running(conn) do
    if Coord.Shutdown.stopping?(), do: Body.error(conn, 503, "stopping"), else: :ok
  end

  defp route(conn, "POST", ["v1", "hello"], name), do: hello(conn, name)
  defp route(conn, "POST", ["v1", "claim"], name), do: claim(conn, name)
  defp route(conn, "GET", ["v1", "bundle", hex], name), do: bundle(conn, name, hex)
  defp route(conn, "POST", ["v1", "lease", id, "heartbeat"], name), do: heartbeat(conn, name, id)
  defp route(conn, "POST", ["v1", "lease", id, "result"], name), do: result(conn, name, id)
  defp route(conn, _method, _path, _name), do: Body.error(conn, 404, "not_found")

  defp hello(conn, name) do
    with {:ok, body, conn} <- Body.read_json(conn, @small) do
      case body do
        %{"build" => build, "cards" => cards, "slots" => slots}
        when is_binary(build) and is_binary(cards) and is_integer(slots) ->
          if Remote.build_matches?(build) and cards == Coord.Config.cards() do
            Remote.hello(name)
            Logger.info("helper #{name} said hello (#{min(max(slots, 0), 99)} slots)")
            Body.json(conn, 200, Map.merge(%{ok: true, name: name}, Remote.timing()))
          else
            wrong_build(conn)
          end

        _ ->
          Body.error(conn, 400, "bad_request", "hello needs build, cards and slots")
      end
    end
  end

  defp claim(conn, name) do
    with {:ok, body, conn} <- Body.read_json(conn, @small) do
      case body do
        %{"slot" => slot} when is_binary(slot) ->
          if Regex.match?(@slot, slot), do: await_claim(conn, name, slot), else: bad_slot(conn)

        _ ->
          bad_slot(conn)
      end
    end
  end

  defp bad_slot(conn), do: Body.error(conn, 400, "bad_request", "claim needs a slot id")

  defp await_claim(conn, name, slot) do
    case Remote.await_claim(name, slot, Coord.Config.get(:claim_ms)) do
      {:ok, lease} -> answer_claim(conn, lease)
      :none -> send_resp(conn, 204, "")
      :stopping -> Body.error(conn, 503, "stopping")
    end
  end

  # When the answer cannot be sent (the helper went away), the lease goes back at once instead of waiting for the
  # heartbeat it will never get.
  defp answer_claim(conn, lease) do
    body = %{lease: lease.id, job: lease.job, bundles: lease.bundles, deadlineMs: lease.deadline_ms}

    conn =
      try do
        Body.json(conn, 200, body)
      rescue
        e ->
          Remote.claim_dropped(lease.id)
          reraise e, __STACKTRACE__
      end

    Remote.claim_sent(lease.id)
    conn
  end

  defp bundle(conn, name, hex) do
    with true <- Remote.hex?(hex),
         {:ok, path} <- Remote.bundle_for(name, hex),
         true <- File.regular?(path) do
      conn
      |> put_resp_content_type("application/x-tar", nil)
      |> send_file(200, path)
    else
      _ -> Body.error(conn, 404, "not_found")
    end
  end

  defp heartbeat(conn, name, id) do
    with {:ok, _body, conn} <- read_small(conn) do
      if Regex.match?(@lease_id, id) and Remote.heartbeat(id, name) == :ok do
        Body.json(conn, 200, %{continue: true})
      else
        gone(conn)
      end
    end
  end

  # A lease this helper does not hold is answered before its (up to 40 MB) body is read. The check is a heartbeat, so
  # a slow upload gets a full lease_lost_ms before the sweep could take the lease back.
  defp result(conn, name, id) do
    if Regex.match?(@lease_id, id) and Remote.heartbeat(id, name) == :ok do
      with {:ok, body, conn} <- Body.read_json(conn, @result_limit, read_timeout: 60_000) do
        case outcome(body) do
          {:ok, outcome} ->
            if Remote.result(id, name, outcome) == :ok, do: Body.json(conn, 200, %{ok: true}), else: gone(conn)

          :error ->
            Body.error(conn, 400, "bad_request", "a result is {results, replays} or {failed}")
        end
      end
    else
      gone(conn)
    end
  end

  @doc false
  # The machine keeps a result as it came; the ladder checks the games (bot/remote-lane.js). Only the shape is
  # checked here: a list of {id, result} and a map of replay texts, or a failure reason (cut to 300 characters).
  def outcome(%{"failed" => reason}) when is_binary(reason) do
    {:ok, {:failed, String.slice(reason, 0, @failed_chars)}}
  end

  def outcome(%{"results" => results} = body) when is_list(results) do
    replays = Map.get(body, "replays", %{})

    if Enum.all?(results, &result_entry?/1) and replays?(replays) do
      {:ok, {:results, results, replays}}
    else
      :error
    end
  end

  def outcome(_body), do: :error

  defp result_entry?(%{"id" => id, "result" => %{}}) when is_binary(id), do: true
  defp result_entry?(_entry), do: false

  defp replays?(replays) when is_map(replays), do: Enum.all?(replays, fn {_, text} -> is_binary(text) end)
  defp replays?(_replays), do: false

  defp read_small(conn) do
    case Body.read_limited(conn, @small) do
      {:ok, body, conn} -> {:ok, body, conn}
      {:too_large, conn} -> Body.error(conn, 413, "too_large", "request body over #{@small} bytes")
      {:error, conn} -> Body.error(conn, 400, "bad_request", "could not read the request body")
    end
  end

  defp gone(conn), do: Body.error(conn, 410, "gone")
end
