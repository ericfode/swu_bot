defmodule CoordWeb.Endpoint do
  @moduledoc """
  POST /wake and GET /healthz on PORT (8080), reached over Fly's private network only (flycast). Neither says
  anything about the arena; operators read the Fly logs. No sessions, no HTML, no sockets.
  """

  use Phoenix.Endpoint, otp_app: :coord

  plug CoordWeb.Router
end
