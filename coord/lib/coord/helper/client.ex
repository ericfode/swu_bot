defmodule Coord.Helper.Client do
  @moduledoc """
  A helper's requests to the games machine's helper API (CoordWeb.HelperAPI), at GAMES_HELPER_URL: `fly proxy` on
  the computer running the helper. Each carries the helper token, only in the authorization header, and this
  release's build. The answers come back as plain terms; Coord.Helper and its slots decide what to do:

    * `:unauthorized` (401): the token is not one the machine knows
    * `{:build, want}` (409): the machine runs another build, want names it and its image
    * `{:error, why}`: no answer (the machine may be stopped), or one that makes no sense; worth trying again
  """

  alias Coord.Config

  @bundle_limit 64_000_000
  @lease_id ~r/^[A-Za-z0-9_-]{1,64}$/

  @doc "POST /v1/hello: {:ok, %{name, heartbeat_ms, lease_lost_ms, claim_ms}} or one of the common answers."
  def hello(slots) do
    body = %{build: Config.build(), cards: Config.cards(), slots: slots}

    case request(method: :post, url: "/v1/hello", json: body, receive_timeout: 15_000) do
      {:ok, 200, body} ->
        with {:ok, %{"ok" => true, "name" => name} = map} when is_binary(name) <- Jason.decode(body),
             {:ok, heartbeat} <- ms(map["heartbeatMs"]),
             {:ok, lost} <- ms(map["leaseLostMs"]),
             {:ok, claim} <- ms(map["claimMs"]) do
          {:ok, %{name: name, heartbeat_ms: heartbeat, lease_lost_ms: lost, claim_ms: claim}}
        else
          _ -> {:error, "hello's answer is not the one expected"}
        end

      other ->
        common(other)
    end
  end

  # a time the machine gives: 1 s to 10 min
  defp ms(n) when is_integer(n) and n >= 1_000 and n <= 600_000, do: {:ok, n}
  defp ms(_n), do: :error

  @doc """
  POST /v1/claim, a long poll of claim_ms: {:lease, %{id, job, bundles: [hex], deadline_ms}}, :none (204), or one
  of the common answers.
  """
  def claim(slot, claim_ms) do
    case request(method: :post, url: "/v1/claim", json: %{slot: slot}, receive_timeout: claim_ms + 10_000) do
      {:ok, 200, body} ->
        case Jason.decode(body) do
          {:ok, %{"lease" => id, "job" => %{} = job, "bundles" => bundles, "deadlineMs" => deadline}}
          when is_binary(id) and is_list(bundles) and is_integer(deadline) and deadline > 0 ->
            hexes = for %{"id" => hex} <- bundles, Coord.Remote.hex?(hex), do: hex

            if Regex.match?(@lease_id, id) and length(hexes) == length(bundles) do
              {:lease, %{id: id, job: job, bundles: hexes, deadline_ms: deadline}}
            else
              {:error, "the claim's answer is not a lease"}
            end

          _ ->
            {:error, "the claim's answer is not a lease"}
        end

      {:ok, 204, _body} ->
        :none

      other ->
        common(other)
    end
  end

  @doc """
  GET /v1/bundle/<hex> into file: :ok when it came whole, at most 64 MB, and its sha256 is hex; else
  {:error, why} or one of the common answers.
  """
  def bundle(hex, file) do
    # streamed, so a body over the limit is cut off instead of held
    into = fn {:data, data}, {req, resp} ->
      size = Req.Response.get_private(resp, :size, 0) + byte_size(data)

      if size > @bundle_limit do
        {:halt, {req, Req.Response.put_private(resp, :too_large, true)}}
      else
        resp = Req.Response.update_private(resp, :chunks, [data], &[data | &1])
        {:cont, {req, Req.Response.put_private(resp, :size, size)}}
      end
    end

    case request_raw(method: :get, url: "/v1/bundle/#{hex}", into: into, receive_timeout: 120_000) do
      {:ok, response} ->
        body = response |> Req.Response.get_private(:chunks, []) |> Enum.reverse() |> IO.iodata_to_binary()

        cond do
          response.status != 200 -> common({:ok, response.status, body})
          Req.Response.get_private(response, :too_large, false) -> {:error, "bundle over #{@bundle_limit} bytes"}
          Coord.Remote.sha256_hex(body) != hex -> {:error, "bundle's sha256 is not its id"}
          true -> File.write(file, body)
        end

      {:error, why} ->
        {:error, why}
    end
  end

  @doc "POST /v1/lease/<id>/heartbeat: :ok (go on), :gone (410: stop), or one of the common answers."
  def heartbeat(id), do: lease_post(id, "heartbeat", body: "", receive_timeout: 15_000)

  @doc "POST /v1/lease/<id>/result with the encoded JSON body: :ok, :gone (410), or one of the common answers."
  def result(id, json, timeout \\ 120_000) do
    lease_post(id, "result", body: json, headers: [{"content-type", "application/json"}], receive_timeout: timeout)
  end

  defp lease_post(id, what, opts) do
    case request([method: :post, url: "/v1/lease/#{id}/#{what}"] ++ opts) do
      {:ok, 200, _body} -> :ok
      {:ok, 410, _body} -> :gone
      other -> common(other)
    end
  end

  defp common({:ok, 401, _body}), do: :unauthorized

  defp common({:ok, 409, body}) do
    case Jason.decode(body) do
      {:ok, %{"error" => %{"code" => "build", "want" => %{} = want}}} -> {:build, want}
      _ -> {:error, "HTTP 409"}
    end
  end

  defp common({:ok, 503, _body}), do: {:error, "the games machine is stopping"}
  defp common({:ok, status, _body}), do: {:error, "HTTP #{status}"}
  defp common({:error, why}), do: {:error, why}

  defp request(opts) do
    case request_raw(opts) do
      {:ok, %Req.Response{status: status, body: body}} -> {:ok, status, body}
      {:error, why} -> {:error, why}
    end
  end

  defp request_raw(opts) do
    headers = [
      {"authorization", "Bearer " <> (Coord.Secrets.helper_token() || "")},
      {"x-helper-build", Config.build()}
    ]

    options =
      [
        base_url: Config.get(:helper_url),
        retry: false,
        redirect: false,
        compressed: false,
        decode_body: false,
        connect_options: [timeout: 10_000]
      ] ++ opts ++ Config.get(:helper_req)

    # the headers go in last, so nothing passed in can drop or repeat them
    options = Keyword.update(options, :headers, headers, &(&1 ++ headers))

    case Req.request(options) do
      {:ok, response} -> {:ok, response}
      # the message only (connection refused, timeout): the request with its header never reaches a log
      {:error, exception} -> {:error, String.slice(Exception.message(exception), 0, 200)}
    end
  rescue
    e -> {:error, "the request failed (#{inspect(e.__struct__)})"}
  end
end
