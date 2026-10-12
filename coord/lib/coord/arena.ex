defmodule Coord.Arena do
  @moduledoc """
  One arena the coordinator plans rounds for. M1 has exactly one, the open arena; the No-sims arena will be a
  second entry here (its Round jobs already carry the arena in their unique key).
  """

  defstruct id: "open"

  def all, do: [%__MODULE__{id: "open"}]
end
