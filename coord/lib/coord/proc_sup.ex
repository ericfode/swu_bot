defmodule Coord.ProcSup do
  @moduledoc """
  Supervises one Coord.Proc per running child process. It stops late in a shutdown, and each Proc then KILLs
  whatever group is still running.
  """

  use DynamicSupervisor

  def start_link(_opts), do: DynamicSupervisor.start_link(__MODULE__, :ok, name: __MODULE__)

  @impl true
  def init(:ok), do: DynamicSupervisor.init(strategy: :one_for_one)
end
