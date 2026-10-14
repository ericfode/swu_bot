#!/bin/sh
# Turns the browser swarm on or off (bot/swarm/README.md, spec/executor.md). Run it as yourself, with flyctl logged in,
# on the computer that ran `helper.sh init` (it keeps that helper's token hash in GAMES_HELPER_TOKENS):
#
#   sh swarm.sh init     make the swarm's token and stage it on both apps: its sha256 in swu-arena-games'
#                        GAMES_HELPER_TOKENS (as "swarm", beside your helper), the token itself as SWARM_HELPER_TOKEN
#                        on swu-arena. The next deploy of each app takes them (or `fly secrets deploy -a <app>`).
#   sh swarm.sh revoke   remove the token from the window, and GAMES_HELPER_TOKENS back to your helper alone
#
# The token is never printed and never written to disk: it goes from openssl to fly through a pipe.
set -eu

GAMES=${SWU_GAMES_APP:-swu-arena-games}
WINDOW=${SWU_WINDOW_APP:-swu-arena}
ENVFILE=$HOME/.config/swu-helper/env
NAME=${SWU_HELPER_NAME:-eric}

die() {
    echo "swarm.sh: $*" >&2
    exit 1
}

command -v fly >/dev/null 2>&1 || die "flyctl is not installed"
sha() { if command -v shasum >/dev/null 2>&1; then shasum -a 256; else sha256sum; fi | cut -d' ' -f1; }

# your helper's entry, from its token (helper.sh init made it), so setting the list keeps it
[ -s "$ENVFILE" ] || die "no helper token in $ENVFILE: run sh helper.sh init first (GAMES_HELPER_TOKENS would lose your helper)"
helper=$(sed -n 's/^GAMES_HELPER_TOKEN=//p' "$ENVFILE" | tr -d '\n' | sha)
[ ${#helper} = 64 ] || die "could not hash the helper token in $ENVFILE"

case ${1:-} in
init)
    token=$(openssl rand -hex 32) || die "openssl could not make a token"
    printf '%s' "$token" | grep -Eqx '[0-9a-f]{64}' || die "openssl made no token"
    swarm=$(printf '%s' "$token" | sha)
    echo "staging GAMES_HELPER_TOKENS=$NAME:<hash>,swarm:<hash> on $GAMES"
    printf 'GAMES_HELPER_TOKENS=%s:%s,swarm:%s\n' "$NAME" "$helper" "$swarm" | fly secrets import --stage -a "$GAMES"
    echo "staging SWARM_HELPER_TOKEN on $WINDOW (the token itself, never printed)"
    printf 'SWARM_HELPER_TOKEN=%s\n' "$token" | fly secrets import --stage -a "$WINDOW"
    token=
    echo "done: the next deploys of $GAMES and $WINDOW turn the swarm on"
    ;;
revoke)
    fly secrets unset --stage -a "$WINDOW" SWARM_HELPER_TOKEN
    printf 'GAMES_HELPER_TOKENS=%s:%s\n' "$NAME" "$helper" | fly secrets import --stage -a "$GAMES"
    echo "done: the next deploys turn the swarm off"
    ;;
*) die "usage: sh swarm.sh init | revoke" ;;
esac
