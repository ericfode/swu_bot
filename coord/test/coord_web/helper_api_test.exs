defmodule CoordWeb.HelperAPITest do
  use Coord.Case, async: false

  import Plug.Test
  import Plug.Conn

  alias Coord.Remote
  alias CoordWeb.HelperAPI

  setup do
    start_helper_node()
    put_setting(:claim_ms, 2_000)
    on_exit(fn -> Coord.Shutdown.set_stopping(false) end)
    :ok
  end

  # a request from a helper: eric's token and the machine's build unless said otherwise
  defp api(method, path, body \\ "", opts \\ []) do
    conn = conn(method, path, body)

    conn =
      case Keyword.get(opts, :as, "eric") do
        nil -> conn
        name -> put_req_header(conn, "authorization", "Bearer " <> helper_token(name))
      end

    conn =
      case Keyword.get(opts, :build, "build-1") do
        nil -> conn
        build -> put_req_header(conn, "x-helper-build", build)
      end

    conn = Enum.reduce(Keyword.get(opts, :headers, []), conn, fn {k, v}, c -> put_req_header(c, k, v) end)
    HelperAPI.call(conn, [])
  end

  defp relay(method, path, body \\ ""), do: CoordWeb.RemoteRelay.call(conn(method, relay_path(path), body), [])
  defp relay_path(path), do: "/r/" <> Coord.Secrets.nonce(:remote) <> path

  defp body(conn), do: Jason.decode!(conn.resp_body)

  defp hello_body(build \\ "build-1", cards \\ "cards-1"),
    do: Jason.encode!(%{build: build, cards: cards, slots: 2})

  # a claim waiting in its own process, as Bandit's request process would
  defp claim_async(name \\ "eric") do
    before = Remote.status().waiting
    task = Task.async(fn -> api(:post, "/v1/claim", ~s({"slot":"1"}), as: name) end)
    eventually(fn -> Remote.status().waiting == before + 1 end)
    task
  end

  # a lease eric holds, its claim answered
  defp lease(job \\ remote_job(), bundles \\ []) do
    task = claim_async()
    assert {:ok, id, "eric"} = Remote.offer(job, bundles)
    conn = Task.await(task)
    assert conn.status == 200
    assert body(conn)["lease"] == id
    id
  end

  describe "the token" do
    test "a token whose sha256 is listed gets in, by its name" do
      conn = api(:post, "/v1/hello", hello_body())
      assert conn.status == 200

      assert body(conn) == %{
               "ok" => true,
               "name" => "eric",
               "heartbeatMs" => 30_000,
               "leaseLostMs" => 90_000,
               "claimMs" => 2_000
             }

      assert body(api(:post, "/v1/hello", hello_body(), as: "bob"))["name"] == "bob"
      assert Remote.status().hosts == ["bob", "eric"]
    end

    test "a bad, missing or malformed authorization is 401, before anything else is looked at" do
      for conn <- [
            api(:post, "/v1/hello", hello_body(), as: nil),
            api(:post, "/v1/hello", hello_body(), as: nil, headers: [{"authorization", "Bearer not-a-token"}]),
            api(:post, "/v1/hello", hello_body(), as: nil, headers: [{"authorization", "Bearer "}]),
            api(:post, "/v1/hello", hello_body(), as: nil, headers: [{"authorization", helper_token("eric")}]),
            api(:post, "/v1/hello", hello_body(),
              as: nil,
              headers: [{"authorization", "Bearer " <> sha256_hex(helper_token("eric"))}]
            ),
            api(:get, "/v1/nowhere", "", as: nil, build: "other")
          ] do
        assert conn.status == 401
        assert body(conn)["error"]["code"] == "unauthorized"
      end
    end

    test "a malformed GAMES_HELPER_TOKENS entry lets nobody in" do
      bad = "carl:" <> String.upcase(sha256_hex("carl-token-0123456789abcdef0123456789"))
      System.put_env("GAMES_HELPER_TOKENS", "eric:#{sha256_hex(helper_token("eric"))},#{bad}")
      Coord.Secrets.forget()
      ExUnit.CaptureLog.capture_log(fn -> Coord.Secrets.take!() end)

      conn =
        api(:post, "/v1/hello", hello_body(),
          as: nil,
          headers: [{"authorization", "Bearer carl-token-0123456789abcdef0123456789"}]
        )

      assert conn.status == 401
      assert api(:post, "/v1/hello", hello_body()).status == 200
    end
  end

  describe "the build" do
    test "another build in the header is 409, naming the build, the cards and the image to run" do
      conn = api(:post, "/v1/claim", ~s({"slot":"1"}), build: "build-0")
      assert conn.status == 409

      assert body(conn) == %{
               "error" => %{
                 "code" => "build",
                 "message" => "the games machine runs build build-1",
                 "want" => %{
                   "build" => "build-1",
                   "cards" => "cards-1",
                   "image" => "registry.fly.io/swu-arena-games:build-1"
                 }
               }
             }

      assert api(:post, "/v1/claim", ~s({"slot":"1"}), build: nil).status == 409
    end

    test "hello checks the build and the cards in its body too" do
      assert api(:post, "/v1/hello", hello_body("build-0")).status == 409
      assert api(:post, "/v1/hello", hello_body("build-1", "cards-0")).status == 409
      assert body(api(:post, "/v1/hello", hello_body("build-1", "cards-0")))["error"]["want"]["cards"] == "cards-1"
      assert Remote.status().hosts == []
    end

    test "an unknown build never matches, not even another unknown one" do
      put_setting(:build, nil)
      put_setting(:app, Path.join(data(), "no-such-app"))
      assert Coord.Config.build() == "unknown"
      assert api(:post, "/v1/hello", hello_body("unknown"), build: "unknown").status == 409
    end

    test "the build is read from BUILD_SHA and CARDS_SHA when GAMES_BUILD and GAMES_CARDS are unset" do
      app = Path.join(data(), "app-#{System.unique_integer([:positive])}")
      File.mkdir_p!(app)
      File.write!(Path.join(app, "BUILD_SHA"), "abc123\n")
      File.write!(Path.join(app, "CARDS_SHA"), "f00d\n")
      put_setting(:app, app)
      put_setting(:build, nil)
      put_setting(:cards, nil)

      assert {Coord.Config.build(), Coord.Config.cards()} == {"abc123", "f00d"}
      assert api(:post, "/v1/hello", hello_body("abc123", "f00d"), build: "abc123").status == 200
    end
  end

  describe "claims and offers" do
    test "a waiting claim gets the offer at once: the lease, the job, its bundles and the deadline" do
      Remote.store_bundle(sha256_hex("tar"), "tar")
      task = claim_async()
      assert Remote.status().waiting == 1
      job = remote_job(77)

      offer = relay(:post, "/offer", Jason.encode!(%{job: job, bundles: [sha256_hex("tar")]}))
      assert offer.status == 200
      assert %{"lease" => id, "host" => "eric"} = body(offer)

      conn = Task.await(task)
      assert conn.status == 200

      assert body(conn) == %{
               "lease" => id,
               "job" => job,
               "bundles" => [%{"id" => sha256_hex("tar"), "bytes" => 3}],
               "deadlineMs" => 840_000 + 300_000
             }

      assert Remote.status().waiting == 0
      assert {:running, "eric", _age} = Remote.lease(id)
    end

    test "a claim that waits claimMs for nothing gets 204, and no longer waits" do
      put_setting(:claim_ms, 300)
      started = System.monotonic_time(:millisecond)
      conn = api(:post, "/v1/claim", ~s({"slot":"s-1"}))
      assert conn.status == 204
      assert System.monotonic_time(:millisecond) - started >= 300
      assert Remote.status().waiting == 0
    end

    test "an offer with nobody waiting is 204; one naming a bundle not put first is 409" do
      assert relay(:post, "/offer", Jason.encode!(%{job: remote_job(), bundles: []})).status == 204

      conn = relay(:post, "/offer", Jason.encode!(%{job: remote_job(), bundles: [sha256_hex("never put")]}))
      assert conn.status == 409
      assert body(conn) == %{"error" => %{"code" => "bundle", "missing" => [sha256_hex("never put")]}}
    end

    test "offers go to the claim that waited longest" do
      first = claim_async("bob")
      second = claim_async("eric")
      assert {:ok, _, "bob"} = Remote.offer(remote_job(1), [])
      assert {:ok, _, "eric"} = Remote.offer(remote_job(2), [])
      assert body(Task.await(first))["job"]["seed"] == 1
      assert body(Task.await(second))["job"]["seed"] == 2
    end

    test "a claim needs a slot id of at most 32 characters" do
      for body <- [~s({}), ~s({"slot":""}), ~s({"slot":"a/b"}), ~s({"slot":"#{String.duplicate("s", 33)}"}), "[1]"] do
        assert api(:post, "/v1/claim", body).status == 400, body
      end
    end

    test "a claim whose process ends after it got the offer gives the lease back (claim dropped)" do
      test = self()

      pid =
        spawn(fn ->
          {:ok, lease} = Remote.await_claim("eric", "1", 5_000)
          send(test, {:got, lease.id})
          # ends without sending the answer
        end)

      eventually(fn -> Remote.status().waiting == 1 end)
      assert {:ok, id, "eric"} = Remote.offer(remote_job(), [])
      assert_receive {:got, ^id}
      ref = Process.monitor(pid)
      assert_receive {:DOWN, ^ref, :process, _, _}
      eventually(fn -> Remote.lease(id) == {:lost, "eric", "claim dropped"} end)
    end

    test "a claim whose answer cannot be sent gives the lease back at once" do
      conn =
        conn(:post, "/v1/claim", ~s({"slot":"1"}))
        |> put_req_header("authorization", "Bearer " <> helper_token("eric"))
        |> put_req_header("x-helper-build", "build-1")

      %{adapter: {_, state}} = conn
      conn = %{conn | adapter: {__MODULE__.GoneClient, state}}

      task =
        Task.async(fn ->
          try do
            HelperAPI.call(conn, [])
          rescue
            e -> e
          end
        end)

      eventually(fn -> Remote.status().waiting == 1 end)
      assert {:ok, id, "eric"} = Remote.offer(remote_job(), [])
      assert %Bandit.TransportError{error: :closed} = Task.await(task)
      assert Remote.lease(id) == {:lost, "eric", "claim dropped"}
    end
  end

  describe "bundles" do
    test "the relay stores a bundle only when its sha256 is its name" do
      hex = sha256_hex("tar body")
      assert relay(:put, "/bundle/" <> hex, "another body").status == 400
      refute File.exists?(Remote.bundle_file(hex))
      assert relay(:put, "/bundle/" <> hex, "tar body").status == 204
      assert relay(:put, "/bundle/" <> hex, "tar body").status == 204
      assert File.read!(Remote.bundle_file(hex)) == "tar body"
      assert Bitwise.band(File.stat!(Remote.bundle_file(hex)).mode, 0o777) == 0o600
      assert Bitwise.band(File.stat!(Remote.bundles_dir()).mode, 0o777) == 0o700
      assert relay(:put, "/bundle/NOTHEX", "x").status == 404
    end

    test "a round's bundles stop at bundles_limit (507); one already stored is still 204" do
      put_setting(:bundles_limit, 12)
      assert relay(:put, "/bundle/" <> sha256_hex("tar body"), "tar body").status == 204
      conn = relay(:put, "/bundle/" <> sha256_hex("other"), "other")
      assert conn.status == 507
      assert body(conn)["error"]["code"] == "full"
      refute File.exists?(Remote.bundle_file(sha256_hex("other")))
      assert relay(:put, "/bundle/" <> sha256_hex("tar body"), "tar body").status == 204
    end

    test "a helper gets a bundle only while it holds a lease that names it" do
      hex = sha256_hex("tar body")
      other = sha256_hex("other")
      :ok = Remote.store_bundle(hex, "tar body")
      :ok = Remote.store_bundle(other, "other")
      assert api(:get, "/v1/bundle/" <> hex).status == 404

      id = lease(remote_job(), [hex])
      conn = api(:get, "/v1/bundle/" <> hex)
      assert conn.status == 200
      assert conn.resp_body == "tar body"
      assert get_resp_header(conn, "content-type") == ["application/x-tar"]

      assert api(:get, "/v1/bundle/" <> hex, "", as: "bob").status == 404
      assert api(:get, "/v1/bundle/" <> other).status == 404
      assert api(:get, "/v1/bundle/../../etc").status == 404

      assert api(:post, "/v1/lease/#{id}/result", ~s({"failed":"x"})).status == 200
      assert api(:get, "/v1/bundle/" <> hex).status == 404
    end
  end

  describe "leases" do
    test "heartbeats and results go on while the lease is held; a result is stored as it came" do
      id = lease()
      conn = api(:post, "/v1/lease/#{id}/heartbeat")
      assert conn.status == 200
      assert body(conn) == %{"continue" => true}

      results = [%{"id" => "a", "result" => %{"outcome" => "won"}}, %{"id" => "b", "result" => %{"x" => 1}}]
      replays = %{"a" => "{\"t\":\"header\"}\n"}
      conn = api(:post, "/v1/lease/#{id}/result", Jason.encode!(%{results: results, replays: replays}))
      assert conn.status == 200
      assert body(conn) == %{"ok" => true}

      # done: a second result or a heartbeat is 410
      assert api(:post, "/v1/lease/#{id}/heartbeat").status == 410
      assert api(:post, "/v1/lease/#{id}/result", ~s({"failed":"again"})).status == 410

      # the ladder reads it once
      conn = relay(:get, "/lease/#{id}")
      assert body(conn) == %{"state" => "done", "host" => "eric", "results" => results, "replays" => replays}
      assert relay(:get, "/lease/#{id}").status == 404
    end

    test "a heartbeat or result for another helper's lease, or an unknown one, is 410" do
      id = lease()
      assert api(:post, "/v1/lease/#{id}/heartbeat", "", as: "bob").status == 410
      assert body(api(:post, "/v1/lease/#{id}/heartbeat", "", as: "bob")) == %{"error" => %{"code" => "gone"}}
      assert api(:post, "/v1/lease/#{id}/result", ~s({"failed":"x"}), as: "bob").status == 410
      assert api(:post, "/v1/lease/unknown/heartbeat").status == 410
      assert api(:post, "/v1/lease/b%2Fad/heartbeat").status == 410
      assert {:running, "eric", _} = Remote.lease(id)
    end

    test "a revoked lease is 410 for its heartbeat and its result, and unknown to the ladder" do
      id = lease()
      assert relay(:delete, "/lease/#{id}").status == 204
      assert api(:post, "/v1/lease/#{id}/heartbeat").status == 410
      assert api(:post, "/v1/lease/#{id}/result", ~s({"results":[],"replays":{}})).status == 410
      assert relay(:get, "/lease/#{id}").status == 404
      assert relay(:delete, "/lease/#{id}").status == 204
    end

    test "a failed lease is lost with its reason (cut to 300 characters), read once" do
      id = lease()
      reason = String.duplicate("r", 400)
      assert api(:post, "/v1/lease/#{id}/result", Jason.encode!(%{failed: reason})).status == 200

      conn = relay(:get, "/lease/#{id}")
      assert body(conn) == %{"state" => "lost", "host" => "eric", "reason" => String.duplicate("r", 300)}
      assert relay(:get, "/lease/#{id}").status == 404
    end

    test "a running lease shows its host and age to the ladder" do
      id = lease()
      assert %{"state" => "running", "host" => "eric", "ageMs" => age} = body(relay(:get, "/lease/#{id}"))
      assert is_integer(age) and age >= 0
    end

    test "a result counts as a heartbeat when it arrives, so a slow upload keeps its lease" do
      id = lease()
      :sys.replace_state(Remote, fn state -> update_in(state.leases[id].beat_at, &(&1 - 80_000)) end)
      before = :sys.get_state(Remote).leases[id].beat_at
      assert api(:post, "/v1/lease/#{id}/result", "not json").status == 400
      assert :sys.get_state(Remote).leases[id].beat_at >= before + 80_000
    end

    test "a result that is neither {results, replays} nor {failed} is 400 and changes nothing" do
      id = lease()

      for bad <- [
            ~s({}),
            ~s({"results":{}}),
            ~s({"results":[{"id":1,"result":{}}]}),
            ~s({"results":[{"id":"a"}]}),
            ~s({"results":[],"replays":{"a":1}}),
            ~s({"failed":1}),
            "not json"
          ] do
        assert api(:post, "/v1/lease/#{id}/result", bad).status == 400, bad
      end

      assert {:running, "eric", _} = Remote.lease(id)
    end
  end

  describe "limits and refusals" do
    test "bodies over a route's limit are 413" do
      big = Jason.encode!(%{build: "build-1", cards: String.duplicate("c", 5_000), slots: 1})
      assert api(:post, "/v1/hello", big).status == 413
      assert api(:post, "/v1/claim", String.duplicate(" ", 4_097)).status == 413
      id = lease()
      assert api(:post, "/v1/lease/#{id}/heartbeat", String.duplicate("x", 4_097)).status == 413

      conn = api(:post, "/v1/lease/#{id}/result", "{}", headers: [{"content-length", "40000001"}])
      assert conn.status == 413

      results = Jason.encode!(%{failed: String.duplicate("x", 40_000_000)})
      assert api(:post, "/v1/lease/#{id}/result", results).status == 413
      assert {:running, "eric", _} = Remote.lease(id)
    end

    test "while the machine stops everything is 503, and a waiting claim gives up within a second" do
      task = claim_async()
      Coord.Shutdown.set_stopping(true)
      conn = Task.await(task, 3_000)
      assert conn.status == 503
      assert body(conn) == %{"error" => %{"code" => "stopping"}}
      assert Remote.status().waiting == 0

      assert api(:post, "/v1/hello", hello_body()).status == 503
      assert api(:post, "/v1/claim", ~s({"slot":"1"})).status == 503
    end

    test "unknown routes are 404, bad JSON is 400" do
      assert api(:get, "/v1/hello").status == 404
      assert api(:post, "/v2/hello", hello_body()).status == 404
      assert api(:get, "/").status == 404
      assert api(:post, "/v1/hello", "not json").status == 400
      assert api(:post, "/v1/hello", ~s({"build":"build-1"})).status == 400
    end

    test "served by its own listener" do
      pid = start_supervised!(Coord.Application.helper_api_spec({127, 0, 0, 1}, 0))
      {:ok, {{127, 0, 0, 1}, port}} = ThousandIsland.listener_info(pid)

      headers = [authorization: "Bearer " <> helper_token("eric"), x_helper_build: "build-1"]
      headers = Enum.map(headers, fn {k, v} -> {String.replace(to_string(k), "_", "-"), v} end)

      response =
        Req.post!("http://127.0.0.1:#{port}/v1/hello", body: hello_body(), headers: headers, retry: false)

      assert response.status == 200
      assert response.body["name"] == "eric"
      assert Req.post!("http://127.0.0.1:#{port}/v1/hello", body: hello_body(), retry: false).status == 401
    end
  end

  defmodule GoneClient do
    @moduledoc false
    # a connection whose helper went away: the body reads, the answer cannot be sent (as Bandit raises it)
    def read_req_body(state, opts), do: Plug.Adapters.Test.Conn.read_req_body(state, opts)
    def send_resp(_state, _status, _headers, _body), do: raise(Bandit.TransportError, message: "closed", error: :closed)
  end
end
