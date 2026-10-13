defmodule CoordWeb.OpsControllerTest do
  use Coord.Case, async: false

  setup do
    # stands in for the Scheduler, to see the wake
    Process.register(self(), Coord.Scheduler)
    pid = start_supervised!(Coord.Application.endpoint_spec({127, 0, 0, 1}, 0))
    assert is_pid(pid)
    {:ok, {_ip, port}} = CoordWeb.Endpoint.server_info(:http)
    %{url: "http://127.0.0.1:#{port}"}
  end

  test "POST /wake answers 202 and wakes the Scheduler", %{url: url} do
    response = Req.post!(url <> "/wake", retry: false)
    assert response.status == 202
    assert response.body == %{"ok" => true}
    assert_receive {:"$gen_cast", :wake}
  end

  test "GET /healthz answers 200", %{url: url} do
    response = Req.get!(url <> "/healthz", retry: false)
    assert response.status == 200
    assert response.body == %{"ok" => true}
  end

  test "anything else is a JSON 404 that says nothing about the arena", %{url: url} do
    for {method, path} <- [get: "/", get: "/wake", post: "/healthz", get: "/api/docs/arena", put: "/x/y"] do
      response = Req.request!(method: method, url: url <> path, retry: false)
      assert response.status == 404, "#{method} #{path}"
      assert response.body == %{"error" => "not found"}
    end

    refute_received {:"$gen_cast", :wake}
  end
end
