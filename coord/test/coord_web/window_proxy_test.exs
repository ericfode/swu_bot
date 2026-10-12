defmodule CoordWeb.WindowProxyTest do
  use Coord.Case, async: false

  import Plug.Test
  import Plug.Conn

  alias Coord.Secrets

  @token "the-window-token"

  setup do
    System.put_env("SWU_WINDOW_TOKEN", @token)
    Secrets.forget()
    Secrets.take!()

    on_exit(fn ->
      Secrets.forget()
      Secrets.take!()
    end)

    # the window: it answers with what it saw
    test_pid = self()

    Req.Test.stub(CoordWeb.WindowProxy, fn conn ->
      {:ok, body, conn} = read_body(conn, length: 40_000_000)
      seen = %{method: conn.method, path: conn.request_path, query: conn.query_string, body: body}
      send(test_pid, {:window, Map.put(seen, :auth, get_req_header(conn, "authorization"))})
      Req.Test.json(conn, %{result: "ok"})
    end)

    :ok
  end

  defp push(path), do: "/p/" <> Secrets.nonce(:push) <> path
  defp intake(path), do: "/i/" <> Secrets.nonce(:intake) <> path

  defp request(method, path, body \\ "", headers \\ []) do
    conn = conn(method, path, body)
    conn = Enum.reduce(headers, conn, fn {k, v}, conn -> put_req_header(conn, k, v) end)
    CoordWeb.WindowProxy.call(conn, [])
  end

  defp forwarded?(method, path, body \\ "") do
    conn = request(method, path, body)
    conn.status == 200 and receive_window() != nil
  end

  defp receive_window do
    receive do
      {:window, seen} -> seen
    after
      0 -> nil
    end
  end

  defp refused?(method, path, body \\ "") do
    conn = request(method, path, body)
    conn.status == 403 and receive_window() == nil and Jason.decode!(conn.resp_body)["error"]["code"] == "forbidden"
  end

  test "push may write the arena's documents and its runs' replays" do
    for collection <- ~w(arena runs ladders panels experiments) do
      assert forwarded?("PUT", push("/api/docs/#{collection}/report-3"), ~s({"a":1})), collection
    end

    assert forwarded?("GET", push("/api/replays/arena-r4?sizes=1"))
    assert forwarded?("POST", push("/api/replays/arena-r4/g001?at=120"), "line\n")
    assert forwarded?("PUT", push("/api/replays/arena-r4/g001"), "line\n")
  end

  test "push may do nothing else" do
    assert refused?("PUT", push("/api/docs/submissions/s1"), "{}")
    assert refused?("GET", push("/api/docs/submissions"))
    assert refused?("PUT", push("/api/docs/admin/invites"), "{}")
    assert refused?("GET", push("/api/docs/arena/standings"))
    assert refused?("DELETE", push("/api/docs/arena/standings"))
    assert refused?("PUT", push("/api/docs/arena/standings/more"), "{}")
    assert refused?("PUT", push("/api/docs/arena/standings?x=1"), "{}")
    assert refused?("GET", push("/api/replays/arena-r4"))
    assert refused?("GET", push("/api/replays/arena-r4?sizes=1&x=2"))
    assert refused?("POST", push("/api/replays/arena-r4/g001"), "x\n")
    assert refused?("POST", push("/api/replays/arena-r4/g001?at=x"), "x\n")
    assert refused?("PUT", push("/api/replays/arena-r4/g001?at=1"), "x\n")
    assert refused?("DELETE", push("/api/replays/arena-r4/g001"))
  end

  test "a replay outside the arena's runs is refused" do
    assert refused?("PUT", push("/api/replays/ladder-7/g001"), "x\n")
    assert refused?("GET", push("/api/replays/other?sizes=1"))
    assert refused?("POST", push("/api/replays/arena-/g001?at=0"), "x\n")
    assert refused?("POST", push("/api/replays/arena-r4!/g001?at=0"), "x\n")
  end

  test "intake may read and write submissions, and nothing else" do
    assert forwarded?("GET", intake("/api/docs/submissions"))
    assert forwarded?("GET", intake("/api/docs/submissions/s-1"))
    assert forwarded?("PUT", intake("/api/docs/submissions/s-1"), "{}")

    assert refused?("POST", intake("/api/docs/submissions"), "{}")
    assert refused?("DELETE", intake("/api/docs/submissions/s-1"))
    assert refused?("PUT", intake("/api/docs/arena/standings"), "{}")
    assert refused?("GET", intake("/api/replays/arena-r4?sizes=1"))
    assert refused?("GET", intake("/api/docs/submissions?all=1"))
  end

  test "a wrong or missing nonce is refused" do
    assert refused?("PUT", "/p/" <> Secrets.nonce(:intake) <> "/api/docs/arena/x", "{}")
    assert refused?("GET", "/i/" <> Secrets.nonce(:push) <> "/api/docs/submissions")
    assert refused?("PUT", "/p/not-the-nonce/api/docs/arena/x", "{}")
    assert refused?("PUT", "/p//api/docs/arena/x", "{}")
    assert refused?("PUT", "/api/docs/arena/x", "{}")
    assert refused?("GET", "/")
    assert refused?("GET", "/x/" <> Secrets.nonce(:push) <> "/api/docs/arena/x")
  end

  test ".. and encoded slashes are refused" do
    assert refused?("PUT", push("/api/docs/arena/../submissions"), "{}")
    assert refused?("PUT", push("/api/docs/arena/%2e%2e"), "{}")
    assert refused?("PUT", push("/api/docs/arena/..%2F..%2Fadmin"), "{}")
    assert refused?("PUT", push("/api/docs/arena/a%2Fb"), "{}")
    assert refused?("GET", intake("/api/docs/submissions/%2E%2E"))
    assert refused?("GET", intake("/api/docs/submissions/a..b"))
  end

  test "a . segment, plain or encoded, is refused (the window's URL parser would drop it)" do
    assert refused?("PUT", push("/api/docs/arena/."), "{}")
    assert refused?("PUT", intake("/api/docs/submissions/%2e"), "{}")
    assert refused?("PUT", push("/api/replays/arena-r4/%2E"), "x\n")
    assert refused?("POST", push("/api/replays/arena-r4/.?at=0"), "x\n")
  end

  test "the token replaces whatever authorization came in, and the path goes on as it came" do
    conn = request("PUT", intake("/api/docs/submissions/a%20b"), "{}", [{"authorization", "Bearer evil"}])
    assert conn.status == 200
    assert_received {:window, seen}
    assert seen.auth == ["Bearer " <> @token]
    assert seen.method == "PUT"
    assert seen.path == "/api/docs/submissions/a%20b"
    assert seen.body == "{}"
  end

  test "the query goes on unchanged" do
    assert forwarded?("POST", push("/api/replays/arena-r4/g001?at=120"), "x\n")
    request("POST", push("/api/replays/arena-r4/g001?at=120"), "x\n")
    assert_received {:window, %{query: "at=120"}}
  end

  test "the window's status and body come back byte for byte (push.js reads 409 conflicts)" do
    body = ~s({"error":{"code":"conflict","message":"at 5, have 9","size":9}})

    Req.Test.stub(CoordWeb.WindowProxy, fn conn ->
      conn |> put_resp_content_type("application/json") |> send_resp(409, body)
    end)

    conn = request("POST", push("/api/replays/arena-r4/g001?at=5"), "x\n")
    assert conn.status == 409
    assert conn.resp_body == body
    assert [type] = get_resp_header(conn, "content-type")
    assert type =~ "application/json"
  end

  test "bodies over the limits get 413 and never reach the window" do
    assert request("POST", push("/api/replays/arena-r4/g001?at=0"), :binary.copy("x", 8_000_001)).status == 413
    assert request("PUT", push("/api/replays/arena-r4/g001"), :binary.copy("x", 32_000_001)).status == 413
    assert request("PUT", push("/api/docs/arena/big"), :binary.copy("x", 16_000_001)).status == 413
    assert request("GET", push("/api/replays/arena-r4?sizes=1"), "x").status == 413
    assert receive_window() == nil

    # a declared length over the limit is refused before reading
    conn = request("POST", push("/api/replays/arena-r4/g001?at=0"), "x", [{"content-length", "8000001"}])
    assert conn.status == 413

    # exactly at the limit is fine
    assert forwarded?("POST", push("/api/replays/arena-r4/g001?at=0"), :binary.copy("x", 8_000_000))
  end

  test "a window that does not answer gives 502" do
    Req.Test.stub(CoordWeb.WindowProxy, &Req.Test.transport_error(&1, :econnrefused))

    ExUnit.CaptureLog.capture_log(fn ->
      conn = request("GET", intake("/api/docs/submissions"))
      assert conn.status == 502
      assert Jason.decode!(conn.resp_body)["error"]["code"] == "unavailable"
    end)
  end

  test "served on 127.0.0.1 by its own listener" do
    Req.Test.set_req_test_to_shared()
    on_exit(fn -> Req.Test.set_req_test_to_private() end)
    test_pid = self()

    Req.Test.stub(CoordWeb.WindowProxy, fn conn ->
      send(test_pid, {:window, get_req_header(conn, "authorization")})
      Req.Test.json(conn, %{result: [1]})
    end)

    pid = start_supervised!(Coord.Application.proxy_spec(0))
    {:ok, {{127, 0, 0, 1}, port}} = ThousandIsland.listener_info(pid)

    response = Req.get!("http://127.0.0.1:#{port}" <> intake("/api/docs/submissions"), retry: false)
    assert response.status == 200
    assert response.body == %{"result" => [1]}
    assert_received {:window, ["Bearer " <> @token]}

    assert Req.get!("http://127.0.0.1:#{port}/api/docs/submissions", retry: false).status == 403
  end
end
