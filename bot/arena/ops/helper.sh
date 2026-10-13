#!/bin/sh
# Runs a games helper on your own computer (bot/arena/HELPER.md): the games machine's own image in Docker, joined to
# the machine through `fly proxy` under your Fly login. Run it as yourself, from any folder, with Docker running:
#
#   sh helper.sh init          make the helper token (once) and stage its hash on Fly; the next games deploy takes it
#   sh helper.sh [--slots N]   pull the image the machine runs, forward the port, play games until Ctrl-C
#   sh helper.sh revoke        remove every helper token from Fly (helpers are refused after the next deploy)
#
# The token stays in ~/.config/swu-helper/env (mode 600) and goes to the container as an env file; only its sha256 is
# set on Fly. Your Fly login stays outside the container: this script runs `fly proxy` and `fly auth docker` itself.
# The container gets no folder of yours, only a Docker volume (swu-helper-data) for its work and its compiled-module
# cache. Each slot plays one seed (two games at once); the default is (CPUs - 1) / 2 of Docker's CPUs, at most one per
# 2 GB of Docker's memory and at most 16 (what the coordinator accepts).
# When the machine moves to a new build, the helper stops with exit code 3 and this script pulls the new image.
set -eu

APP=${SWU_GAMES_APP:-swu-arena-games}
PORT=${SWU_HELPER_PORT:-18090}
DIR=$HOME/.config/swu-helper
ENVFILE=$DIR/env
NAME=${SWU_HELPER_NAME:-eric}

die() {
    echo "helper.sh: $*" >&2
    exit 1
}

need() {
    command -v "$1" >/dev/null 2>&1 || die "$1 is not installed ($2)"
}

# sha256 of the token in the env file, without printing the token
token_hash() {
    sed -n 's/^GAMES_HELPER_TOKEN=//p' "$ENVFILE" | tr -d '\n' | { if command -v shasum >/dev/null 2>&1; then shasum -a 256; else sha256sum; fi; } | cut -d' ' -f1
}

init() {
    need fly "https://fly.io/docs/flyctl/install/"
    need openssl "it comes with macOS; on Linux, your package manager"
    # the names GAMES_HELPER_TOKENS takes; "machine" is the games machine's own row in the round report
    { printf '%s' "$NAME" | grep -Eqx '[a-z][a-z0-9_-]{0,31}' && [ "$NAME" != machine ]; } ||
        die "SWU_HELPER_NAME must be a lowercase name (a-z, 0-9, _ or -, at most 32) other than machine"
    if [ ! -s "$ENVFILE" ]; then
        token=$(openssl rand -hex 32) || die "openssl could not make a token"
        (umask 077 && mkdir -p "$DIR" && printf 'GAMES_HELPER_TOKEN=%s\n' "$token" >"$ENVFILE")
        token=
        echo "made a helper token in $ENVFILE"
    fi
    chmod 600 "$ENVFILE"
    # 64 hex digits, so a failed openssl never stages the hash of an empty token
    sed -n 's/^GAMES_HELPER_TOKEN=//p' "$ENVFILE" | grep -Eqx '[0-9a-f]{64}' ||
        die "$ENVFILE does not hold a 64-digit hex token: delete it and run init again"
    hash=$(token_hash)
    [ ${#hash} = 64 ] || die "could not hash the token in $ENVFILE"
    echo "staging GAMES_HELPER_TOKENS=$NAME:<hash> on $APP (the hash, never the token)"
    fly secrets set --stage -a "$APP" "GAMES_HELPER_TOKENS=$NAME:$hash"
    echo "done: the next deploy of the games machine accepts this helper"
}

revoke() {
    need fly "https://fly.io/docs/flyctl/install/"
    fly secrets unset -a "$APP" GAMES_HELPER_TOKENS
}

# the image the machine runs now (its config, so a stopped machine answers too)
image() {
    json=$(fly machine list -a "$APP" --json) || return 1
    if command -v jq >/dev/null 2>&1; then
        printf '%s' "$json" | jq -r '.[0].config.image'
    elif command -v plutil >/dev/null 2>&1; then
        printf '%s' "$json" | plutil -extract 0.config.image raw -o - -
    else
        die "install jq (brew install jq) to read the machine's image"
    fi
}

# `fly proxy` waits for the machine to be up (it never starts it) and exits when that takes too long: start it again
forward() {
    fp=
    trap 'kill "$fp" 2>/dev/null; exit 0' TERM INT
    while :; do
        fly proxy "$PORT:8090" -a "$APP" -q >/dev/null 2>&1 &
        fp=$!
        wait "$fp" || true
        sleep 30
    done
}

run() {
    slots=
    while [ $# -gt 0 ]; do
        case $1 in
        --slots) slots=$2; shift 2 ;;
        *) die "unknown option $1 (see the top of this file)" ;;
        esac
    done
    need fly "https://fly.io/docs/flyctl/install/"
    need docker "Docker Desktop"
    [ -s "$ENVFILE" ] || die "no token yet: run sh helper.sh init first"
    chmod 600 "$ENVFILE"
    if [ -z "$slots" ]; then
        cpus=$(docker info --format '{{.NCPU}}')
        mem=$(docker info --format '{{.MemTotal}}')
        slots=$(( (cpus - 1) / 2 ))
        bymem=$(( mem / 2147483648 ))
        [ "$bymem" -lt "$slots" ] && slots=$bymem
        [ "$slots" -gt 16 ] && slots=16
        [ "$slots" -lt 1 ] && slots=1
    fi
    # Docker Desktop reaches a port on this computer's 127.0.0.1 as host.docker.internal; on Linux the container
    # shares the host's network instead
    if [ "$(uname)" = Darwin ]; then
        net="-e GAMES_HELPER_URL=http://host.docker.internal:$PORT"
        awake="caffeinate -i"
    else
        net="--network host -e GAMES_HELPER_URL=http://127.0.0.1:$PORT"
        awake=
        command -v systemd-inhibit >/dev/null 2>&1 && awake="systemd-inhibit --what=sleep --why=swu-helper"
    fi
    forward &
    fwd=$!
    trap 'kill "$fwd" 2>/dev/null' EXIT
    trap 'exit 130' INT TERM
    fly auth docker >/dev/null
    while :; do
        img=$(image) || die "could not read the games machine's image (fly machine list -a $APP)"
        echo "pulling $img"
        docker pull --quiet --platform linux/amd64 "$img"
        echo "playing with $slots slots; Ctrl-C stops (games held go back to the machine within 90 s)"
        code=0
        # shellcheck disable=SC2086
        $awake docker run --rm --name swu-helper --platform linux/amd64 $net \
            --env-file "$ENVFILE" -e COORD_ROLE=helper -e "GAMES_HELPER_SLOTS=$slots" -e RELEASE_TMP=/tmp \
            -v swu-helper-data:/data --security-opt no-new-privileges --cap-drop NET_RAW --cap-drop MKNOD \
            "$img" /app/coord/bin/coord start || code=$?
        [ "$code" = 3 ] || exit "$code"
        echo "the games machine runs a new build: pulling it"
    done
}

case ${1:-run} in
init) init ;;
revoke) revoke ;;
run) shift 2>/dev/null || true; run "$@" ;;
--slots) run "$@" ;;
*) die "unknown command $1 (init, run, revoke)" ;;
esac
