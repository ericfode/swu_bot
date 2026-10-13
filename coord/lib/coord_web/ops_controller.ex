defmodule CoordWeb.OpsController do
  @moduledoc "The window's wake-up call, Fly's health check, and nothing else."

  use Phoenix.Controller, formats: [:json]

  def wake(conn, _params) do
    Coord.Scheduler.wake()
    conn |> put_status(202) |> json(%{ok: true})
  end

  def healthz(conn, _params), do: json(conn, %{ok: true})

  def not_found(conn, _params), do: conn |> put_status(404) |> json(%{error: "not found"})
end
