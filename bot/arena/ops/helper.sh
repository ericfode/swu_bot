#!/bin/sh
# Runs a games helper on your own computer (bot/arena/HELPER.md): the games machine's own image in Docker, joined to
# the machine through `fly proxy` under your Fly login. Run it as yourself, from any folder, with Docker running:
#
#   sh helper.sh init          make the helper token (once) and stage its hash on Fly; the next games deploy takes it
#   sh helper.sh [--slots N]   pull the image the machine runs, forward the port, play games until Ctrl-C (or q)
#   sh helper.sh watch         the live view of a helper that already runs (helper-tui.js watch)
#   sh helper.sh build         build the helper image for this computer's CPU from the machine's image
#                              (Dockerfile.helper)
#   sh helper.sh revoke        remove every helper token from Fly (helpers are refused after the next deploy)
#
# On a terminal, with Node 18 or later, the helper runs under its live view (helper-tui.js): the games in play with
# their boards, the seeds it finished, and its share of the computer's CPU. SWU_HELPER_PLAIN=1 prints the plain lines.
# The machine's image is built for amd64 only. On an ARM computer (a Mac with an Apple chip) it would run under
# emulation, so there the script builds a native image instead (Dockerfile.helper: the machine's files on this
# computer's own Node and Python) and runs that; SWU_HELPER_NATIVE=1 or 0 overrides. The container runs the image's own
# command, the arena server (server/src/main-games.ts), which COORD_ROLE=helper makes a helper.
#
# The token stays in ~/.config/swu-helper/env (mode 600) and goes to the container as an env file; only its sha256 is
# set on Fly. Your Fly login stays outside the container: this script runs `fly proxy` and `fly auth docker` itself.
# The container gets no folder of yours, only a Docker volume (swu-helper-data) for its work and its compiled-module
# cache. Each slot plays one seed (two games at once) and keeps about one core busy (3 slots averaged 2.8 cores on an
# Apple M5 Max). --slots N chooses; else the number in ~/.config/swu-helper/slots (the view's + and - write it); else
# (CPUs - 1) / 2 of Docker's CPUs, at most one per 2 GB of Docker's memory. At most 16 (what the machine accepts).
# When the machine moves to a new build, the helper stops with exit code 3 and this script pulls the new image.
set -eu

APP=${SWU_GAMES_APP:-swu-arena-games}
PORT=${SWU_HELPER_PORT:-18090}
DIR=$HOME/.config/swu-helper
ENVFILE=$DIR/env
SLOTSFILE=$DIR/slots
NAME=${SWU_HELPER_NAME:-eric}
HERE=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
# the swu_bot checkout this script is in (its Dockerfile.helper builds the native image)
REPO=${SWU_REPO:-$(cd "$(dirname "$0")/../../.." 2>/dev/null && pwd)}

die() {
    echo "helper.sh: $*" >&2
    exit 1
}

need() {
    command -v "$1" >/dev/null 2>&1 || die "$1 is not installed ($2)"
}

need_docker() {
    need docker "Docker Desktop"
    # the Docker CLI is there without its daemon when Docker Desktop is not open (no docker.sock)
    docker info >/dev/null 2>&1 ||
        die "Docker is not running: start Docker Desktop (on a Mac: open -a Docker), wait until docker info answers, and run this again"
}

# whether to run under the live view: a terminal, SWU_HELPER_PLAIN unset, Node 18 or later, the view next to this file
tui() {
    [ -t 0 ] && [ -t 1 ] && [ -z "${SWU_HELPER_PLAIN:-}" ] && [ -f "$HERE/helper-tui.js" ] &&
        command -v node >/dev/null 2>&1 &&
        node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' >/dev/null 2>&1
}

# whether to build the image for this computer instead of pulling the machine's amd64 one: on ARM (Apple chips, where
# amd64 code runs under emulation), unless SWU_HELPER_NATIVE says otherwise
native() {
    case ${SWU_HELPER_NATIVE:-} in
    1) return 0 ;;
    0) return 1 ;;
    esac
    case $(uname -m) in
    arm64 | aarch64) return 0 ;;
    esac
    return 1
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

# Pulls the machine's amd64 image $1, 6 tries 30 s apart. Each try logs in to Fly's registry again first: the login
# `fly auth docker` leaves expires within hours, and then the registry answers "not found" for every image (seen
# 2026-10-14: a helper that had run for hours could pull no new build until it logged in again).
pull() {
    tries=1
    until fly auth docker >/dev/null 2>&1; docker pull --quiet --platform linux/amd64 "$1" >/dev/null; do
        [ "$tries" -lt 6 ] || return 1
        tries=$((tries + 1))
        echo "could not pull $1 yet; trying again in 30 s ($tries of 6)"
        sleep 30
    done
}

# Builds swu-helper:<commit> for this computer's CPU from the machine's image $1, unless it is there already, and sets
# $tag to it: Dockerfile.helper puts the machine's files on native Node and Python, so it needs nothing but that image.
# Images of other commits (and the coordinator images older versions of this script built) are removed afterwards.
build_native() {
    img=$1
    sha=${img##*:}
    printf '%s' "$sha" | grep -Eqx '[0-9a-f]{40}' || die "the games machine's image $img is not tagged with a commit"
    tag=swu-helper:$sha
    if docker image inspect "$tag" >/dev/null 2>&1; then
        echo "using $tag (built before)"
        return 0
    fi
    [ -f "$REPO/bot/arena/ops/Dockerfile.helper" ] ||
        die "$REPO is not a swu_bot checkout with bot/arena/ops/Dockerfile.helper: run this script from one (or set SWU_REPO)"
    echo "pulling $img for its files (it does not run here)"
    if ! pull "$img"; then
        echo "could not pull $img" >&2
        return 2
    fi
    # Dockerfile.helper copies everything from the machine's image, so the build context is an empty folder
    ctx=$(mktemp -d "${TMPDIR:-/tmp}/swu-helper.XXXXXX") || die "could not make a build folder"
    echo "building the helper image for this computer at $sha"
    docker build -f "$REPO/bot/arena/ops/Dockerfile.helper" --build-arg "MACHINE_IMAGE=$img" -t "$tag" "$ctx" ||
        { rm -rf "$ctx"; die "the helper image did not build (the lines above say why)"; }
    rm -rf "$ctx"
    docker image ls --format '{{.Repository}}:{{.Tag}}' |
        grep -E "^(swu-helper|swu-helper-coord|registry\.fly\.io/$APP):" | grep -v ":$sha\$" |
        while read -r old; do docker image rm "$old" >/dev/null 2>&1 || true; done
    echo "built $tag"
}

build() {
    need fly "https://fly.io/docs/flyctl/install/"
    need_docker
    fly auth docker >/dev/null
    img=$(image) || die "could not read the games machine's image (fly machine list -a $APP)"
    build_native "$img"
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
    # the view runs this script again with SWU_HELPER_PLAIN=1 and shows its lines
    if tui; then
        need_docker
        exec node "$HERE/helper-tui.js" run "$@"
    fi
    slots=
    while [ $# -gt 0 ]; do
        case $1 in
        --slots) [ $# -ge 2 ] || die "--slots needs a number"; slots=$2; shift 2 ;;
        *) die "unknown option $1 (see the top of this file)" ;;
        esac
    done
    need fly "https://fly.io/docs/flyctl/install/"
    need_docker
    [ -s "$ENVFILE" ] || die "no token yet: run sh helper.sh init first"
    chmod 600 "$ENVFILE"
    [ -n "$slots" ] || [ ! -s "$SLOTSFILE" ] || slots=$(tr -dc 0-9 <"$SLOTSFILE")
    if [ -n "$slots" ]; then
        { printf '%s' "$slots" | grep -Eqx '[0-9]{1,2}' && [ "$slots" -ge 1 ] && [ "$slots" -le 16 ]; } ||
            die "slots must be 1 to 16 (--slots, or $SLOTSFILE)"
    else
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
        # only where it can reach logind (not in a container or WSL without systemd)
        systemd-inhibit --what=sleep --why=swu-helper true >/dev/null 2>&1 && awake="systemd-inhibit --what=sleep --why=swu-helper"
    fi
    forward &
    fwd=$!
    trap 'kill "$fwd" 2>/dev/null' EXIT
    trap 'exit 130' INT TERM
    fly auth docker >/dev/null
    last=
    while :; do
        img=$(image) || die "could not read the games machine's image (fly machine list -a $APP)"
        # code 3 means "another build": when the machine still runs the image that just stopped, pulling cannot fix it
        # (an image built without GIT_SHA has the build "unknown", which never matches)
        [ "$img" != "$last" ] || die "the games machine still runs $img, which this helper just ran: its build or card data differ for another reason (see the lines above)"
        last=$img
        if native; then
            # a build the registry never served (seen 2026-10-14: the machine named an image that stayed "not found") is
            # not this computer's problem: wait, and read the machine's image again, which a later deploy moves on
            code=0
            build_native "$img" || code=$?
            if [ "$code" = 2 ]; then
                echo "reading the games machine's image again in 2 min"
                sleep 120
                last=
                continue
            fi
            [ "$code" = 0 ] || exit "$code"
            platform=
        else
            echo "pulling $img"
            if ! pull "$img"; then
                echo "could not pull $img; reading the games machine's image again in 2 min"
                sleep 120
                last=
                continue
            fi
            tag=$img
            platform="--platform linux/amd64"
        fi
        echo "playing with $slots slots; Ctrl-C stops (games held go back to the machine within 90 s)"
        # A container left by an earlier run (its terminal closed, which ends `docker run` but not the container) would
        # take the name: docker stop lets it hand its seeds back first
        if docker container inspect swu-helper >/dev/null 2>&1; then
            echo "stopping the helper container an earlier run left behind"
            docker stop -t 30 swu-helper >/dev/null 2>&1 || true
            n=0
            while docker container inspect swu-helper >/dev/null 2>&1 && [ "$n" -lt 30 ]; do
                sleep 1
                n=$((n + 1))
            done
            docker rm -f swu-helper >/dev/null 2>&1 || true
        fi
        code=0
        # the image's own command: the arena server, which COORD_ROLE=helper makes a helper (on the pulled path, an
        # image from before the TypeScript server starts its Elixir coordinator the same way)
        # shellcheck disable=SC2086
        # --init: an init as PID 1 reaps what the server kills after a play (a process a bot left behind, reparented)
        $awake docker run --rm --init --name swu-helper $platform $net \
            --env-file "$ENVFILE" -e COORD_ROLE=helper -e "GAMES_HELPER_SLOTS=$slots" \
            -v swu-helper-data:/data --security-opt no-new-privileges --cap-drop NET_RAW --cap-drop MKNOD \
            "$tag" || code=$?
        [ "$code" = 3 ] || exit "$code"
        echo "the games machine runs another build: reading its image"
    done
}

case ${1:-run} in
init) init ;;
build) build ;;
watch)
    need_docker
    tui || die "the live view needs a terminal and Node 18 or later"
    exec node "$HERE/helper-tui.js" watch
    ;;
revoke) revoke ;;
run) [ $# -eq 0 ] || shift; run "$@" ;;
--slots) run "$@" ;;
*) die "unknown command $1 (init, run, watch, build, revoke)" ;;
esac
