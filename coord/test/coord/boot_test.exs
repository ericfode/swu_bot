defmodule Coord.BootTest do
  use Coord.Case, async: false

  alias Coord.Boot

  describe "cancel_orphans" do
    @describetag :db

    test "cancels every job an earlier run left unfinished, and only those" do
      states = ~w(available scheduled executing retryable suspended completed discarded cancelled)

      jobs =
        for {state, k} <- Enum.with_index(states) do
          {:ok, job} = Oban.insert(Coord.Workers.Round.new(%{"arena" => "open", "round" => k, "boot" => "old"}))
          job |> Ecto.Changeset.change(state: state) |> Coord.Repo.update!()
        end

      assert Boot.cancel_orphans() == 5

      after_boot = for job <- jobs, do: Coord.Repo.reload!(job)
      assert Enum.map(after_boot, & &1.state) == ~w(cancelled cancelled cancelled cancelled cancelled
                                                    completed discarded cancelled)
      assert Enum.all?(Enum.take(after_boot, 5), &(&1.cancelled_at != nil))
    end
  end

  test "mountpoint? compares the device with the root's" do
    refute Boot.mountpoint?("/")
    assert Boot.mountpoint?("/proc")
    refute Boot.mountpoint?("/no/such/folder")
  end

  test "prepare! refuses to start without the volume when GAMES_REQUIRE_MOUNT=1" do
    put_setting(:require_mount, true)
    # / is never a separate mount by this rule, so this is the "no volume" case on any machine
    put_setting(:data, "/")
    assert_raise RuntimeError, ~r/not a mounted volume/, fn -> Boot.prepare!() end
  end

  test "prepare! makes the coordinator's folders, takes the secrets and makes a new boot id" do
    data = Path.join(System.tmp_dir!(), "coord-boot-test-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm_rf(data) end)
    put_setting(:data, data)
    System.put_env("SWU_WINDOW_TOKEN", "boot-token")
    old_id = Boot.id()

    on_exit(fn ->
      Coord.Secrets.forget()
      Coord.Secrets.take!()
    end)

    Coord.Secrets.forget()
    assert :ok = Boot.prepare!()

    assert File.stat!(Path.join(data, "coord")).access == :read_write
    assert Bitwise.band(File.stat!(Path.join(data, "coord")).mode, 0o777) == 0o700
    assert File.dir?(Path.join(data, "coord/procs"))
    assert System.get_env("SWU_WINDOW_TOKEN") == nil
    assert Coord.Secrets.token() == "boot-token"
    assert Boot.id() != old_id
  end
end
