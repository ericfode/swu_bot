defmodule CoordWeb.Router do
  @moduledoc "The two routes games.js answered, and a JSON 404 for everything else."

  use Phoenix.Router, helpers: false

  post "/wake", CoordWeb.OpsController, :wake
  get "/healthz", CoordWeb.OpsController, :healthz
  match :*, "/*path", CoordWeb.OpsController, :not_found
end
