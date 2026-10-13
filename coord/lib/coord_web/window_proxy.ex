defmodule CoordWeb.WindowProxy do
  @moduledoc """
  The only way a child reaches the window: a signing proxy served on 127.0.0.1 (GAMES_PROXY_PORT).

  push gets SWU_WINDOW=http://127.0.0.1:<port>/p/<push nonce> and intake /i/<intake nonce>; both nonces are new at
  every boot. A request must carry its role's nonce and be on that role's allow-list; it is then forwarded to
  SWU_WINDOW with `authorization: Bearer <token>` in place of whatever came in, and the window's status and body
  come back unchanged (push.js reads its 409 conflict and size answers from them). So the token never leaves the
  BEAM, and each child can do only what its role needs: the project token could read every submission's source.
  Paths are never logged.
  """

  @behaviour Plug

  import Plug.Conn

  require Logger

  # the window's own limits (window.js MAX_DOC, MAX_APPEND, MAX_REPLAY)
  @doc_limit 16_000_000
  @append_limit 8_000_000
  @replay_limit 32_000_000

  @push_collections ~w(arena runs ladders panels experiments)
  @run ~r/^arena-[\w-]+$/

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    with {:ok, role, rest} <- role(conn.path_info),
         {:ok, segments} <- decode(conn.request_path, rest),
         {:ok, limit} <- allow(role, conn.method, segments, conn.query_string) do
      forward(conn, rest, limit)
    else
      :forbidden -> refuse(conn, 403, "forbidden", "not through the games proxy")
    end
  end

  defp role(["p", nonce | rest]), do: check_nonce(:push, nonce, rest)
  defp role(["i", nonce | rest]), do: check_nonce(:intake, nonce, rest)
  defp role(_path), do: :forbidden

  defp check_nonce(role, nonce, rest) do
    if Plug.Crypto.secure_compare(nonce, Coord.Secrets.nonce(role)), do: {:ok, role, rest}, else: :forbidden
  end

  # Each segment is checked decoded (so %2e%2e and %2f are caught) and forwarded as it came, still encoded. A "."
  # (or "%2e") is refused too: the window's URL parser drops it, so the path checked would not be the path served.
  defp decode(raw_path, rest) do
    decoded = Enum.map(rest, &decode_segment/1)

    if String.contains?(raw_path, "..") or Enum.any?(decoded, &(&1 == :bad)) do
      :forbidden
    else
      {:ok, decoded}
    end
  end

  defp decode_segment(raw) do
    segment = URI.decode(raw)

    if segment in ["", "."] or String.contains?(segment, ["/", "..", "\\"]) or String.match?(segment, ~r/[\x00-\x1f]/) do
      :bad
    else
      segment
    end
  rescue
    ArgumentError -> :bad
  end

  # what push.js needs: the arena's documents, and the arena's runs' replays
  defp allow(:push, "PUT", ["api", "docs", collection, _id], ""), do: if_ok(collection in @push_collections, @doc_limit)
  defp allow(:push, "GET", ["api", "replays", run], "sizes=1"), do: if_ok(run?(run), 0)

  defp allow(:push, "POST", ["api", "replays", run, _game], query) do
    if_ok(run?(run) and Regex.match?(~r/^at=\d+$/, query), @append_limit)
  end

  defp allow(:push, "PUT", ["api", "replays", run, _game], ""), do: if_ok(run?(run), @replay_limit)

  # what intake.js needs: the submissions, and nothing else
  defp allow(:intake, "GET", ["api", "docs", "submissions"], ""), do: {:ok, 0}
  defp allow(:intake, "GET", ["api", "docs", "submissions", _id], ""), do: {:ok, 0}
  defp allow(:intake, "PUT", ["api", "docs", "submissions", _id], ""), do: {:ok, @doc_limit}

  defp allow(_role, _method, _segments, _query), do: :forbidden

  defp if_ok(true, limit), do: {:ok, limit}
  defp if_ok(false, _limit), do: :forbidden

  defp run?(run), do: Regex.match?(@run, run)

  defp forward(conn, rest, limit) do
    case read_limited(conn, limit) do
      {:ok, body, conn} ->
        send_upstream(conn, rest, body)

      {:too_large, conn} ->
        refuse(conn, 413, "too_large", "request body over #{limit} bytes")

      {:error, conn} ->
        refuse(conn, 400, "bad_request", "could not read the request body")
    end
  end

  defp read_limited(conn, limit) do
    declared =
      case get_req_header(conn, "content-length") do
        [n] -> Integer.parse(n)
        _ -> :error
      end

    case declared do
      {n, ""} when n > limit ->
        {:too_large, conn}

      _ ->
        # one byte over the limit is enough to know the body is too large
        case read_body(conn, length: limit + 1, read_length: 1_000_000) do
          {:ok, body, conn} when byte_size(body) <= limit -> {:ok, body, conn}
          {:ok, _body, conn} -> {:too_large, conn}
          {:more, _body, conn} -> {:too_large, conn}
          {:error, _reason} -> {:error, conn}
        end
    end
  end

  defp send_upstream(conn, rest, body) do
    query = if conn.query_string == "", do: "", else: "?" <> conn.query_string
    url = Coord.Config.get(:window) <> "/" <> Enum.join(rest, "/") <> query

    headers =
      case get_req_header(conn, "content-type") do
        [type | _] -> [{"content-type", type}]
        [] -> []
      end

    headers =
      case Coord.Secrets.token() do
        nil -> headers
        token -> [{"authorization", "Bearer " <> token} | headers]
      end

    options =
      [
        method: conn.method,
        url: url,
        headers: headers,
        body: if(conn.method == "GET", do: nil, else: body),
        retry: false,
        redirect: false,
        compressed: false,
        decode_body: false,
        receive_timeout: 60_000
      ] ++ Coord.Config.get(:window_req)

    case Req.request(options) do
      {:ok, response} ->
        conn =
          case Req.Response.get_header(response, "content-type") do
            [type | _] -> put_resp_header(conn, "content-type", type)
            [] -> conn
          end

        send_resp(conn, response.status, response.body)

      {:error, exception} ->
        Logger.warning("window proxy: the window did not answer (#{Exception.message(exception)})")
        refuse(conn, 502, "unavailable", "the window did not answer")
    end
  end

  defp refuse(conn, status, code, message) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(status, Jason.encode!(%{error: %{code: code, message: message}}))
  end
end
