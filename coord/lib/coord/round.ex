defmodule Coord.Round do
  @moduledoc """
  Plays one round: the referee command that referee-cmd returned, run through FLAME so that M2 can move it to a
  runner machine. In M1 the pool is FLAME.LocalBackend with one runner, which adds no capacity; it is the seam,
  and its link kills the referee's group when the job dies.
  """

  defmodule Spec do
    @moduledoc "One round to play, as plain data: what goes to the runner."
    @enforce_keys [:arena, :round, :cmd, :env, :cwd, :cap_ms]
    defstruct [:arena, :round, :cmd, :env, :cwd, :cap_ms]
  end

  # isolate.sh passes TERM to the referee, which stops its ladders and releases referee.lock
  @grace 12_000

  @doc "The FLAME pool the Round worker calls into."
  def pool_spec do
    {FLAME.Pool,
     name: Coord.RoundRunner,
     backend: FLAME.LocalBackend,
     min: 0,
     max: 1,
     max_concurrency: 1,
     idle_shutdown_after: 30_000}
  end

  @doc "Runs the referee to its end; called inside FLAME.call. Returns Coord.Proc's result."
  def play(%Spec{} = spec) do
    Coord.Proc.run(:referee, spec.cmd,
      env: spec.env,
      cd: spec.cwd,
      timeout: spec.cap_ms,
      grace: @grace,
      stdout: :log
    )
  end
end
