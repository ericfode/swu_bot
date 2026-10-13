defmodule CoordWeb.ErrorJSON do
  @moduledoc "What a request that crashed gets: the status in words, nothing about the cause."

  def render(template, _assigns), do: %{error: Phoenix.Controller.status_message_from_template(template)}
end
