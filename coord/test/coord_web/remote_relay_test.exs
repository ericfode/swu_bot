defmodule CoordWeb.RemoteRelayTest do
  use Coord.Case, async: false

  import Plug.Test
  import Plug.Conn

  alias Coord.Remote

  setup do
    start_helper_node()
    :ok
  end

  defp relay(method, path, body \\ ""), do: CoordWeb.RemoteRelay.call(conn(method, path, body), [])
  defp base, do: "/r/" <> Coord.Secrets.nonce(:remote)

  test "a wrong or missing nonce is 403, whatever the route" do
    for path <- [
          "/r/not-the-nonce/status",
          "/r//status",
          "/status",
          "/",
          "/p/" <> Coord.Secrets.nonce(:push) <> "/status",
          "/r/" <> Coord.Secrets.nonce(:push) <> "/status",
          "/r/" <> Coord.Secrets.nonce(:intake) <> "/offer"
        ] do
      conn = relay(:get, path)
      assert conn.status == 403, path
      assert Jason.decode!(conn.resp_body)["error"]["code"] == "forbidden"
    end

    assert relay(:post, "/r/x/offer", Jason.encode!(%{job: remote_job(), bundles: []})).status == 403
  end

  test "status names how many claims wait and who said hello" do
    assert Jason.decode!(relay(:get, base() <> "/status").resp_body) == %{"waiting" => 0, "hosts" => []}
    Remote.hello("eric")
    task = Task.async(fn -> Remote.await_claim("bob", "1", 2_000) end)
    eventually(fn -> Remote.status().waiting == 1 end)
    assert Jason.decode!(relay(:get, base() <> "/status").resp_body) == %{"waiting" => 1, "hosts" => ["bob", "eric"]}
    assert Task.await(task, 3_000) == :none
  end

  test "an offer must be {job, bundles: [hex]} with a whole number of gameMs" do
    for bad <- [
          %{job: remote_job()},
          %{job: "x", bundles: []},
          %{job: remote_job(), bundles: ["NOTHEX"]},
          %{job: remote_job(1, %{"gameMs" => -1}), bundles: []},
          %{job: remote_job(1, %{"gameMs" => 1.5}), bundles: []}
        ] do
      assert relay(:post, base() <> "/offer", Jason.encode!(bad)).status == 400, inspect(bad)
    end

    assert relay(:post, base() <> "/offer", "not json").status == 400

    assert relay(:post, base() <> "/offer", Jason.encode!(%{job: remote_job(1, %{"gameMs" => 0}), bundles: []})).status ==
             204
  end

  test "bodies over the limits are 413: an offer over 1 MB, a bundle over 64 MB" do
    big = Jason.encode!(%{job: remote_job(1, %{"pad" => String.duplicate("x", 1_000_000)}), bundles: []})
    assert relay(:post, base() <> "/offer", big).status == 413

    conn = conn(:put, base() <> "/bundle/" <> sha256_hex("x"), "x") |> put_req_header("content-length", "64000001")
    assert CoordWeb.RemoteRelay.call(conn, []).status == 413
  end

  test "unknown routes are 404" do
    assert relay(:get, base() <> "/nowhere").status == 404
    assert relay(:get, base() <> "/lease/no-such-lease").status == 404
    assert relay(:get, base() <> "/lease/b%2Fad").status == 404
    assert relay(:post, base() <> "/status").status == 404
  end

  test "served on 127.0.0.1 by its own listener, at the URL the referee passes on" do
    pid = start_supervised!(Coord.Application.relay_spec(0))
    {:ok, {{127, 0, 0, 1}, port}} = ThousandIsland.listener_info(pid)
    put_setting(:relay_port, port)

    assert Remote.relay_url() == "http://127.0.0.1:#{port}/r/" <> Coord.Secrets.nonce(:remote)
    assert Req.get!(Remote.relay_url() <> "/status", retry: false).body == %{"waiting" => 0, "hosts" => []}
    assert Req.get!("http://127.0.0.1:#{port}/r/x/status", retry: false).status == 403
  end
end
