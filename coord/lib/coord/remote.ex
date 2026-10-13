defmodule Coord.Remote do
  @moduledoc """
  The helper node's leases, on the games machine. A helper (Coord.Helper: the games image run on someone's computer)
  asks for work through CoordWeb.HelperAPI; the ladder offers it whole seeds through CoordWeb.RemoteRelay. This
  server holds the claims waiting for work, the leases handed out, and the bundles the ladder put for them.

  A claim is a long poll: the API's request process waits (monitored) until an offer comes or claim_ms passes. An
  offer goes to the claim that has waited longest and becomes a lease, which is
    * offered while the claim's answer is being sent: lost ("claim dropped") when that fails or its process dies;
    * running once it is sent: lost after lease_lost_ms without a heartbeat ("no heartbeat"), or past its deadline
      (the job's gameMs, 30 min when it has none, plus 5 min: "deadline");
    * done or lost: kept until the ladder reads it (once), at most lease_keep_ms.
  A revoked lease is forgotten at once, and so is every lease when a round ends (reset/0): the helper's next
  heartbeat or result gets 410. The ladder owns the round: it picks what to offer and checks what comes back.
  Nothing here touches the Scheduler's idle clock, so a helper never keeps the machine up.

  The whole helper node is off unless Coord.Config helper_port is set and GAMES_HELPER_TOKENS names a helper
  (enabled?/0): then this server, the relay and the helper API are in the tree, and the referee gets ARENA_REMOTE.
  """

  use GenServer

  require Logger

  alias Coord.{Config, Secrets}

  @hex ~r/^[0-9a-f]{64}$/
  @no_game_cap :timer.minutes(30)
  @deadline_margin :timer.minutes(5)

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "Whether the helper node is on: a helper port and at least one valid entry in GAMES_HELPER_TOKENS."
  def enabled?, do: Config.get(:helper_port) != nil and Secrets.helpers() != []

  @doc "The relay's base URL, which the referee passes to the ladder as ARENA_REMOTE."
  def relay_url, do: "http://127.0.0.1:#{Config.get(:relay_port)}/r/#{Secrets.nonce(:remote)}"

  @doc "Whether a helper's build is this machine's. An unknown build never matches."
  def build_matches?(build), do: is_binary(build) and Config.build() != "unknown" and build == Config.build()

  @doc "What a helper with another build is told to run instead (the 409 answer's want)."
  def wanted do
    build = Config.build()
    %{build: build, cards: Config.cards(), image: "#{Config.get(:helper_image)}:#{build}"}
  end

  @doc "The timing a helper follows, as hello answers it (ms)."
  def timing do
    %{heartbeatMs: Config.get(:heartbeat_ms), leaseLostMs: Config.get(:lease_lost_ms), claimMs: Config.get(:claim_ms)}
  end

  @doc "How long a lease for this job may run after the claim's answer: gameMs (30 min when 0 or none) + 5 min."
  def deadline_ms(job) do
    game_ms =
      case job["gameMs"] do
        n when is_integer(n) and n > 0 -> n
        _ -> @no_game_cap
      end

    game_ms + @deadline_margin
  end

  def hex?(value), do: is_binary(value) and Regex.match?(@hex, value)

  @doc "Where the ladder's bundles are kept: <coord_dir>/bundles, which isolate.sh --hide keeps from every child."
  def bundles_dir, do: Path.join(Config.coord_dir(), "bundles")
  def bundle_file(hex), do: Path.join(bundles_dir(), hex <> ".tar")

  defp bundles_bytes do
    case File.ls(bundles_dir()) do
      {:ok, names} ->
        Enum.reduce(names, 0, fn name, sum ->
          case File.lstat(Path.join(bundles_dir(), name)) do
            {:ok, %File.Stat{size: size}} -> sum + size
            _ -> sum
          end
        end)

      _ ->
        0
    end
  end

  @doc """
  Stores a bundle the ladder put (its canonical tar), in the caller's process: :ok when sha256(body) is hex (and
  when it was there already), {:error, :hash} when it is not, {:error, :full} when the round's bundles would pass
  Config bundles_limit (the relay's nonce is not a secret from the arena user; CoordWeb.RemoteRelay). Written to a
  temporary name, then renamed.
  """
  def store_bundle(hex, body) do
    path = bundle_file(hex)

    cond do
      sha256_hex(body) != hex ->
        {:error, :hash}

      File.regular?(path) ->
        :ok

      bundles_bytes() + byte_size(body) > Config.get(:bundles_limit) ->
        {:error, :full}

      true ->
        dir = bundles_dir()
        tmp = Path.join(dir, ".#{hex}.#{System.unique_integer([:positive])}.tmp")

        with :ok <- File.mkdir_p(dir),
             :ok <- File.chmod(dir, 0o700),
             :ok <- File.write(tmp, body),
             :ok <- File.chmod(tmp, 0o600),
             :ok <- File.rename(tmp, path) do
          :ok
        else
          {:error, reason} ->
            File.rm(tmp)
            {:error, reason}
        end
    end
  end

  def sha256_hex(data), do: :sha256 |> :crypto.hash(data) |> Base.encode16(case: :lower)

  # --- the helper API's side (each runs in the request's process)

  @doc "A helper said hello: its name is one of the status's hosts from now on."
  def hello(name), do: GenServer.call(__MODULE__, {:hello, name})

  @doc """
  Waits for an offer, at most timeout ms: {:ok, lease} (a map with id, job, bundles and deadline_ms) when one came,
  :none when none did, :stopping when the machine began to stop meanwhile. After {:ok, lease} the caller must call
  claim_sent/1 once the answer went out, or claim_dropped/1 when it could not be sent.
  """
  def await_claim(name, slot, timeout) do
    ref = GenServer.call(__MODULE__, {:wait, self(), name, slot})
    await_offer(ref, now() + timeout)
  end

  # the stop flag is looked at every second, so a waiting claim does not hold up the machine's stop
  defp await_offer(ref, deadline) do
    receive do
      {__MODULE__, ^ref, lease} -> {:ok, lease}
    after
      min(max(deadline - now(), 0), 1_000) ->
        cond do
          Coord.Shutdown.stopping?() -> give_up(ref, :stopping)
          now() >= deadline -> give_up(ref, :none)
          true -> await_offer(ref, deadline)
        end
    end
  end

  # an offer that came between the last look and this call is already in the mailbox: it is taken, not lost
  defp give_up(ref, why) do
    case GenServer.call(__MODULE__, {:cancel, ref}) do
      :cancelled ->
        why

      :offered ->
        receive do
          {__MODULE__, ^ref, lease} -> {:ok, lease}
        end
    end
  end

  def claim_sent(id), do: GenServer.call(__MODULE__, {:claim_sent, id})
  def claim_dropped(id), do: GenServer.call(__MODULE__, {:claim_dropped, id})

  @doc "A heartbeat: :ok while this helper holds the lease, :gone otherwise."
  def heartbeat(id, name), do: GenServer.call(__MODULE__, {:heartbeat, id, name})

  @doc """
  A lease's result: {:results, results, replays} (done) or {:failed, reason} (lost with that reason, so the ladder
  plays the seed itself at once). :ok, or :gone when this helper does not hold the lease.
  """
  def result(id, name, outcome), do: GenServer.call(__MODULE__, {:result, id, name, outcome}, 30_000)

  @doc "The file of a bundle named by a lease this helper holds now: {:ok, path}, else :error."
  def bundle_for(name, hex), do: GenServer.call(__MODULE__, {:bundle, name, hex})

  # --- the relay's side (the ladder)

  @doc "%{waiting: claims waiting now, hosts: names of the helpers that said hello (or claimed) at this boot}."
  def status, do: GenServer.call(__MODULE__, :status)

  @doc """
  Offers a job to the claim that has waited longest: {:ok, lease_id, host}, :none when no claim waits (or the
  machine is stopping), {:missing, [hex]} when a bundle was not put first.
  """
  def offer(job, bundles), do: GenServer.call(__MODULE__, {:offer, job, Enum.uniq(bundles)})

  @doc """
  What the ladder sees of a lease: {:running, host, age_ms}, {:done, host, results, replays} or
  {:lost, host, reason} (both forgotten once read), or :unknown.
  """
  def lease(id), do: GenServer.call(__MODULE__, {:lease, id})

  @doc "Forgets a lease: the helper's next heartbeat or result gets 410."
  def revoke(id), do: GenServer.call(__MODULE__, {:revoke, id})

  @doc """
  At a round's end (Coord.Workers.Round), whatever its result: forgets every lease and deletes the stored bundles.
  Waiting claims stay. Nothing to do when the helper node is off.
  """
  def reset do
    if Process.whereis(__MODULE__), do: GenServer.call(__MODULE__, :reset, 30_000), else: :ok
  catch
    :exit, _ -> :ok
  end

  # --- the server

  @impl true
  def init(_opts) do
    # bundles a crashed run left behind belong to no lease now
    clear_bundles()
    {:ok, %{waiting: [], leases: %{}, hosts: MapSet.new()}, {:continue, :sweep}}
  end

  @impl true
  def handle_continue(:sweep, state) do
    Process.send_after(self(), :sweep, Config.get(:sweep_ms))
    {:noreply, state}
  end

  @impl true
  def handle_call({:hello, name}, _from, state) do
    {:reply, :ok, %{state | hosts: MapSet.put(state.hosts, name)}}
  end

  def handle_call({:wait, pid, name, slot}, _from, state) do
    claim = %{ref: make_ref(), pid: pid, mon: Process.monitor(pid), name: name, slot: slot}
    {:reply, claim.ref, %{state | waiting: state.waiting ++ [claim], hosts: MapSet.put(state.hosts, name)}}
  end

  def handle_call({:cancel, ref}, _from, state) do
    case Enum.split_with(state.waiting, &(&1.ref == ref)) do
      {[claim], rest} ->
        Process.demonitor(claim.mon, [:flush])
        {:reply, :cancelled, %{state | waiting: rest}}

      {[], _} ->
        # the caller is alive and no longer waits: an offer was sent to it
        {:reply, :offered, state}
    end
  end

  def handle_call({:offer, job, bundles}, _from, state) do
    missing = Enum.reject(bundles, &File.regular?(bundle_file(&1)))

    cond do
      missing != [] ->
        {:reply, {:missing, missing}, state}

      state.waiting == [] or Coord.Shutdown.stopping?() ->
        {:reply, :none, state}

      true ->
        [claim | rest] = state.waiting
        lease = new_lease(claim, job, bundles)
        send(claim.pid, {__MODULE__, claim.ref, claim_view(lease)})
        Logger.info("lease #{lease.id} (seed #{seed(job)}) goes to #{claim.name}")
        {:reply, {:ok, lease.id, claim.name}, %{state | waiting: rest, leases: Map.put(state.leases, lease.id, lease)}}
    end
  end

  def handle_call({:claim_sent, id}, _from, state) do
    state =
      update_lease(state, id, fn
        %{state: :offered} = lease ->
          Process.demonitor(lease.claim_mon, [:flush])
          now = now()
          %{lease | state: :running, claim_mon: nil, beat_at: now, deadline_at: now + lease.deadline_ms}

        lease ->
          lease
      end)

    {:reply, :ok, state}
  end

  def handle_call({:claim_dropped, id}, _from, state) do
    {:reply, :ok, update_lease(state, id, &drop_claim/1)}
  end

  def handle_call({:heartbeat, id, name}, _from, state) do
    if holds?(state.leases[id], name) do
      {:reply, :ok, update_lease(state, id, &%{&1 | beat_at: now()})}
    else
      {:reply, :gone, state}
    end
  end

  def handle_call({:result, id, name, outcome}, _from, state) do
    if holds?(state.leases[id], name) do
      {:reply, :ok, update_lease(state, id, &finish(&1, outcome))}
    else
      {:reply, :gone, state}
    end
  end

  def handle_call({:bundle, name, hex}, _from, state) do
    held = Enum.any?(Map.values(state.leases), &(holds?(&1, name) and hex in &1.bundles))
    {:reply, if(held, do: {:ok, bundle_file(hex)}, else: :error), state}
  end

  def handle_call(:status, _from, state) do
    {:reply, %{waiting: length(state.waiting), hosts: Enum.sort(state.hosts)}, state}
  end

  def handle_call({:lease, id}, _from, state) do
    case state.leases[id] do
      nil ->
        {:reply, :unknown, state}

      %{state: s} = lease when s in [:offered, :running] ->
        {:reply, {:running, lease.host, now() - lease.offered_at}, state}

      %{state: :done} = lease ->
        {:reply, {:done, lease.host, lease.results, lease.replays}, forget(state, id)}

      %{state: :lost} = lease ->
        {:reply, {:lost, lease.host, lease.reason}, forget(state, id)}
    end
  end

  def handle_call({:revoke, id}, _from, state) do
    if Map.has_key?(state.leases, id), do: Logger.info("lease #{id} taken back")
    {:reply, :ok, forget(state, id)}
  end

  def handle_call(:reset, _from, state) do
    for {_, %{claim_mon: mon}} <- state.leases, mon != nil, do: Process.demonitor(mon, [:flush])
    if state.leases != %{}, do: Logger.info("the round ended: #{map_size(state.leases)} leases forgotten")
    clear_bundles()
    {:reply, :ok, %{state | leases: %{}}}
  end

  @impl true
  def handle_info(:sweep, state) do
    Process.send_after(self(), :sweep, Config.get(:sweep_ms))
    {:noreply, sweep(state, now())}
  end

  # a waiting claim's process ended (the helper went away), or one that was sending an offer's answer
  def handle_info({:DOWN, mon, :process, _pid, _reason}, state) do
    case Enum.split_with(state.waiting, &(&1.mon == mon)) do
      {[_], rest} ->
        {:noreply, %{state | waiting: rest}}

      {[], _} ->
        case Enum.find(Map.values(state.leases), &(&1.claim_mon == mon)) do
          nil -> {:noreply, state}
          lease -> {:noreply, update_lease(state, lease.id, &drop_claim/1)}
        end
    end
  end

  def handle_info(_message, state), do: {:noreply, state}

  defp new_lease(claim, job, bundles) do
    now = now()
    deadline_ms = deadline_ms(job)

    %{
      id: Base.url_encode64(:crypto.strong_rand_bytes(12), padding: false),
      host: claim.name,
      slot: claim.slot,
      job: job,
      bundles: bundles,
      bundle_sizes: Map.new(bundles, &{&1, bundle_size(&1)}),
      state: :offered,
      claim_mon: claim.mon,
      offered_at: now,
      beat_at: now,
      deadline_ms: deadline_ms,
      deadline_at: now + deadline_ms,
      ended_at: nil,
      results: nil,
      replays: nil,
      reason: nil
    }
  end

  defp claim_view(lease) do
    bundles = for hex <- lease.bundles, do: %{id: hex, bytes: lease.bundle_sizes[hex]}
    %{id: lease.id, job: lease.job, bundles: bundles, deadline_ms: lease.deadline_ms}
  end

  defp bundle_size(hex) do
    case File.stat(bundle_file(hex)) do
      {:ok, %File.Stat{size: size}} -> size
      {:error, _} -> 0
    end
  end

  defp holds?(%{state: s, host: host}, name) when s in [:offered, :running], do: host == name
  defp holds?(_lease, _name), do: false

  defp drop_claim(%{state: :offered} = lease), do: lose(%{lease | claim_mon: nil}, "claim dropped")
  defp drop_claim(lease), do: lease

  defp finish(lease, {:results, results, replays}) do
    if lease.claim_mon, do: Process.demonitor(lease.claim_mon, [:flush])
    Logger.info("lease #{lease.id} done by #{lease.host}")

    %{lease | state: :done, results: results, replays: replays, ended_at: now(), job: nil, claim_mon: nil}
  end

  defp finish(lease, {:failed, reason}) do
    if lease.claim_mon, do: Process.demonitor(lease.claim_mon, [:flush])
    lose(%{lease | claim_mon: nil}, reason)
  end

  defp lose(lease, reason) do
    Logger.info("lease #{lease.id} of #{lease.host} lost (#{String.slice(reason, 0, 100)})")
    %{lease | state: :lost, reason: reason, ended_at: now(), job: nil}
  end

  @doc false
  # the sweep: running leases without a heartbeat or past their deadline are lost; read-never leases are forgotten
  def sweep(state, now) do
    lost_ms = Config.get(:lease_lost_ms)
    keep_ms = Config.get(:lease_keep_ms)

    leases =
      Enum.reduce(state.leases, %{}, fn {id, lease}, acc ->
        cond do
          lease.state in [:offered, :running] and now - lease.beat_at > lost_ms ->
            Map.put(acc, id, lose(lease, "no heartbeat"))

          lease.state in [:offered, :running] and now > lease.deadline_at ->
            Map.put(acc, id, lose(lease, "deadline"))

          lease.state in [:done, :lost] and now - lease.ended_at > keep_ms ->
            acc

          true ->
            Map.put(acc, id, lease)
        end
      end)

    %{state | leases: leases}
  end

  defp update_lease(state, id, fun) do
    case state.leases[id] do
      nil -> state
      lease -> %{state | leases: Map.put(state.leases, id, fun.(lease))}
    end
  end

  defp forget(state, id) do
    case state.leases[id] do
      %{claim_mon: mon} when mon != nil -> Process.demonitor(mon, [:flush])
      _ -> :ok
    end

    %{state | leases: Map.delete(state.leases, id)}
  end

  defp clear_bundles do
    dir = bundles_dir()
    File.rm_rf(dir)
    File.mkdir_p!(dir)
    File.chmod!(dir, 0o700)
  end

  defp seed(%{"seed" => seed}) when is_integer(seed), do: seed
  defp seed(_job), do: "?"

  defp now, do: System.monotonic_time(:millisecond)
end
