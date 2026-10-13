defmodule Coord.ChildEnv do
  @moduledoc """
  The environment of each kind of child, built from nothing; Coord.Proc passes it on with every inherited variable
  unset. The referee is the exception: it gets exactly the environment referee-cmd returned, which
  Coord.Gamesctl checks with forbidden?/1 first.
  """

  @path "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  @kinds [:setup, :referee_cmd, :intake, :warm, :plan, :push]

  # never passed to a child: tokens, Fly's and the release's variables, the BEAM's own (ERL*, BINDIR, ROOTDIR, EMU,
  # PROGNAME), and proxy settings (a proxy that adds a token would hand the token on)
  @forbidden ~r/TOKEN|PROXY|FLY|SWU_WINDOW|COOKIE|RELEASE|^ERL|^BINDIR$|^ROOTDIR$|^EMU$|^PROGNAME$/i

  def kinds, do: @kinds

  @doc "Whether a child's environment may never hold this variable (SWU_WINDOW aside, for push and intake)."
  def forbidden?(key) when is_binary(key), do: Regex.match?(@forbidden, key)

  @doc """
  The environment of a gamesctl child. ctx holds data, arena_user, residents, card_json, root_home, node_dir, and
  for :push and :intake the proxy URL as window.
  """
  def for_kind(kind, ctx) when kind in @kinds do
    env = Map.merge(base(ctx), extra(kind, ctx))

    # SWU_WINDOW is the one forbidden name a child gets, and then only as this machine's proxy
    for {k, v} <- env, forbidden?(k) do
      if k != "SWU_WINDOW" or not String.starts_with?(v, "http://127.0.0.1:") do
        raise ArgumentError, "#{k} may not be passed to #{kind}"
      end
    end

    env
  end

  defp extra(kind, ctx) when kind in [:setup, :referee_cmd], do: %{"HOME" => ctx.root_home}
  defp extra(:intake, ctx), do: %{"HOME" => ctx.root_home, "SWU_WINDOW" => ctx.window}
  defp extra(kind, ctx) when kind in [:warm, :plan], do: %{"HOME" => bot_home(ctx)}
  defp extra(:push, ctx), do: %{"HOME" => bot_home(ctx), "SWU_WINDOW" => ctx.window}

  defp bot_home(ctx), do: Path.join(ctx.data, "home")

  @doc "What every gamesctl child gets."
  def base(ctx) do
    %{
      "PATH" => path(ctx.node_dir),
      "LANG" => "C.UTF-8",
      "TZ" => "UTC",
      "NODE_ENV" => "production",
      "GAMES_DATA" => ctx.data,
      "ARENA_USER" => ctx.arena_user,
      "GAMES_HIDE" => "/.fly:" <> Path.join(ctx.data, "coord")
    }
    |> put_set("ARENA_RESIDENTS", ctx.residents)
    |> put_set("SWU_CARD_JSON", ctx.card_json)
  end

  # node's own folder goes first when it is elsewhere (a laptop, or CI's setup-node), so `node` means the same node
  defp path(node_dir) do
    if node_dir in [nil | String.split(@path, ":")], do: @path, else: node_dir <> ":" <> @path
  end

  defp put_set(env, _key, value) when value in [nil, ""], do: env
  defp put_set(env, key, value), do: Map.put(env, key, value)
end
