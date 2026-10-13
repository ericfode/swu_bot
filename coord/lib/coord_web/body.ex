defmodule CoordWeb.Body do
  @moduledoc """
  What the coordinator's own listeners (the window proxy, the helper API, the helper relay) share: request bodies
  read up to a limit, and JSON answers. None of them logs a path or a header.
  """

  import Plug.Conn

  @doc """
  Reads the whole body if it is at most limit bytes: {:ok, body, conn}, {:too_large, conn} (a declared length over
  the limit is refused before reading), or {:error, conn}. `read_timeout:` is the wait for each 1 MB (Plug's 15 s
  by default); a helper's result comes over someone's home connection.
  """
  def read_limited(conn, limit, opts \\ []) do
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
        case read_body(conn, [length: limit + 1, read_length: 1_000_000] ++ opts) do
          {:ok, body, conn} when byte_size(body) <= limit -> {:ok, body, conn}
          {:ok, _body, conn} -> {:too_large, conn}
          {:more, _body, conn} -> {:too_large, conn}
          {:error, _reason} -> {:error, conn}
        end
    end
  end

  @doc """
  Reads a JSON object of at most limit bytes: {:ok, map, conn}, or the conn with a 400 or 413 sent (so that in a
  `with` the conn is what the plug returns).
  """
  def read_json(conn, limit, opts \\ []) do
    case read_limited(conn, limit, opts) do
      {:ok, body, conn} ->
        case Jason.decode(body) do
          {:ok, %{} = map} -> {:ok, map, conn}
          _ -> error(conn, 400, "bad_request", "the body is not a JSON object")
        end

      {:too_large, conn} ->
        error(conn, 413, "too_large", "request body over #{limit} bytes")

      {:error, conn} ->
        error(conn, 400, "bad_request", "could not read the request body")
    end
  end

  def json(conn, status, body) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(status, Jason.encode!(body))
  end

  @doc "An answer in the window's error shape: {\"error\":{\"code\":...,\"message\":...}} (no message when nil)."
  def error(conn, status, code, message \\ nil) do
    error = if message, do: %{code: code, message: message}, else: %{code: code}
    json(conn, status, %{error: error})
  end
end
