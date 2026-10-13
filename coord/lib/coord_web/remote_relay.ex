defmodule CoordWeb.RemoteRelay do
  @moduledoc """
  The ladder's side of the helper node (bot/remote-lane.js), served on 127.0.0.1:GAMES_RELAY_PORT only while the
  helper node is on. The referee passes ARENA_REMOTE=http://127.0.0.1:<port>/r/<nonce> to the ladder; the nonce is
  new at every boot (Coord.Secrets :remote), and a request without it gets 403. No token is involved and nothing
  here reaches the window. Paths are never logged (they hold the nonce). The nonce keeps out other users on the
  machine, not the arena user: the ladder runs as arena and its /proc/<pid>/environ still holds ARENA_REMOTE, so a bot
  that escapes wasmtime can read it. Such a bot can already write the ladder's results as the same user, so the relay
  must never hold a token or reach the window. Routes under the base:

    * GET status: {waiting, hosts}
    * PUT bundle/<hex>: a version's canonical tar; 204 when its sha256 is hex, 400 when not, 507 when the round's
      bundles are at Config bundles_limit
    * POST offer {job, bundles}: 200 {lease, host} when a claim waited, 204 when none, 409 when a bundle is missing
    * GET lease/<id>: running, done or lost (the last two are forgotten once read); 404 when unknown
    * DELETE lease/<id>: 204, the lease is revoked
  """

  @behaviour Plug

  import Plug.Conn

  require Logger

  alias Coord.Remote
  alias CoordWeb.Body

  @bundle_limit 64_000_000
  @offer_limit 1_000_000
  @lease_id ~r/^[A-Za-z0-9_-]{1,64}$/

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    case conn.path_info do
      ["r", nonce | rest] ->
        if Plug.Crypto.secure_compare(nonce, Coord.Secrets.nonce(:remote)) do
          route(conn, conn.method, rest)
        else
          forbidden(conn)
        end

      _ ->
        forbidden(conn)
    end
  rescue
    e in [Bandit.TransportError, Bandit.HTTPError] ->
      reraise e, __STACKTRACE__

    e ->
      Logger.error("helper relay: #{inspect(e.__struct__)} raised")
      Body.error(conn, 500, "internal", "the relay could not answer")
  catch
    :exit, _ ->
      Logger.error("helper relay: the lease server did not answer")
      Body.error(conn, 503, "unavailable", "the relay could not answer")
  end

  defp forbidden(conn), do: Body.error(conn, 403, "forbidden", "not through the helper relay")

  defp route(conn, "GET", ["status"]), do: Body.json(conn, 200, Remote.status())
  defp route(conn, "PUT", ["bundle", hex]), do: put_bundle(conn, hex)
  defp route(conn, "POST", ["offer"]), do: offer(conn)
  defp route(conn, "GET", ["lease", id]), do: lease(conn, id)

  defp route(conn, "DELETE", ["lease", id]) do
    if Regex.match?(@lease_id, id), do: Remote.revoke(id)
    send_resp(conn, 204, "")
  end

  defp route(conn, _method, _path), do: Body.error(conn, 404, "not_found")

  defp put_bundle(conn, hex) do
    if Remote.hex?(hex) do
      case Body.read_limited(conn, @bundle_limit) do
        {:ok, body, conn} ->
          case Remote.store_bundle(hex, body) do
            :ok -> send_resp(conn, 204, "")
            {:error, :hash} -> Body.error(conn, 400, "hash", "the body's sha256 is not #{hex}")
            {:error, :full} -> Body.error(conn, 507, "full", "this round's bundles are at their limit")
            {:error, reason} -> Body.error(conn, 500, "internal", "could not store it (#{inspect(reason)})")
          end

        {:too_large, conn} ->
          Body.error(conn, 413, "too_large", "request body over #{@bundle_limit} bytes")

        {:error, conn} ->
          Body.error(conn, 400, "bad_request", "could not read the request body")
      end
    else
      Body.error(conn, 404, "not_found")
    end
  end

  defp offer(conn) do
    with {:ok, body, conn} <- Body.read_json(conn, @offer_limit) do
      case body do
        %{"job" => %{} = job, "bundles" => bundles} when is_list(bundles) ->
          if Enum.all?(bundles, &Remote.hex?/1) and game_ms?(job["gameMs"]) do
            answer_offer(conn, Remote.offer(job, bundles))
          else
            bad_offer(conn)
          end

        _ ->
          bad_offer(conn)
      end
    end
  end

  defp game_ms?(ms), do: ms == nil or (is_integer(ms) and ms >= 0)

  defp bad_offer(conn), do: Body.error(conn, 400, "bad_request", "an offer is {job, bundles: [hex]}")

  defp answer_offer(conn, {:ok, id, host}), do: Body.json(conn, 200, %{lease: id, host: host})
  defp answer_offer(conn, :none), do: send_resp(conn, 204, "")

  defp answer_offer(conn, {:missing, missing}) do
    Body.json(conn, 409, %{error: %{code: "bundle", missing: missing}})
  end

  defp lease(conn, id) do
    case if(Regex.match?(@lease_id, id), do: Remote.lease(id), else: :unknown) do
      {:running, host, age_ms} ->
        Body.json(conn, 200, %{state: "running", host: host, ageMs: age_ms})

      {:done, host, results, replays} ->
        Body.json(conn, 200, %{state: "done", host: host, results: results, replays: replays})

      {:lost, host, reason} ->
        Body.json(conn, 200, %{state: "lost", host: host, reason: reason})

      :unknown ->
        Body.error(conn, 404, "not_found")
    end
  end
end
