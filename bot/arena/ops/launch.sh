#!/bin/bash
# Starts (or, after a crash or a new container, resumes) a clocked arena tournament with unattended competitors:
# the referee (referee.js --tournament) and the runner (runner.js), both detached from this shell.
#
#   bot/arena/ops/launch.sh start <commit>     set up and start a new tournament on <commit> (TITLE, TASK, ROUNDS,
#                                              MINUTES, GAMES, BUDGET_USD, BRAKE_5H (0.8), BRAKE_7D (0.85) from the
#                                              environment; HOLDOUT=0.3 makes it a card-pool holdout tournament, see
#                                              referee.js)
#   bot/arena/ops/launch.sh resume             set up whatever is missing and resume the tournament in tournament.json
#                                              (the commit comes from <ARENA_HOME>/launch.json)
#   bot/arena/ops/launch.sh referee|runner|uplink   restart only that process, on the existing setup (keeper.sh uses these)
#   bot/arena/ops/launch.sh uplink-stop        one last push to the window, then stop the uplink (keeper.sh, at the end)
#
# With SWU_WINDOW set at start (e.g. https://swu-arena.fly.dev; kept in launch.json as "window"), a third process, the
# uplink (push.js arena), sends the arena's state and its round ladders to the arena window's API every 20 s (WINDOW.md).
# It is the only process that gets the egress proxy, which adds the window's push token, and it runs only our own code
# (push.js and api.js's read methods). The referee and the bots never get the proxy: a bot could push as the project.
#
# Layout under $BASE (default /srv/arena-run, local disk):
#   referee/        frozen git worktree of the commit; forceteki/ and node_modules/ link to $SRC's built engine, which
#                   setup checks out at the revision the commit pins (from the address in its .gitmodules) and builds
#   repos/<name>/   each competitor's own copy (runner --repo): a clone of the commit with its own engine copy and no
#                   usable remote, so an edit or a git command there changes nothing for the referee or the others
#   results/        ARENA_RESULTS: ladders record here; the runner mirrors it into $SHARED_RESULTS
#   logs/           runner logs, competitor HOMEs, transcripts; usage, prompts and OptMem memory are backed up to $BACKUP
#   tools/memo      OptMem (it must be executable, so not on the shared mount)
#   home/, etc/     the HOME of the ladders' user, a copy of the CA bundle
# ARENA_HOME stays the shared /mnt/project-files/arena (roster, agents/, versions/, tournament.json, standings).
# Both processes start with a minimal environment (env -i): no session tokens and no NODE_OPTIONS reach the bots.
# Each also starts in its own PID and mount namespace (isolate.sh): what runs under it, competitors and bot programs
# included, sees only its own processes, so it cannot read another process's environment (this session's tokens, the
# uplink's). The session's credential files are hidden, and /tmp is a folder of its own. The referee itself (our own
# code) stays root there and alone reads the round-seed secret. Every ladder and eval it starts, where bot programs and
# in-process bots run, runs as the user $ARENA_USER (default arena, made by setup) with no capabilities: bot code cannot
# undo the hiding, and reads none of root's files, the secret included. It writes only $BASE/results, home/ and the
# shared folders; the referee's worktree and the engine stay root's. The runner and the Claude Code competitors it
# starts still run as root (Claude Code signs in with a credential only root may read), so they could undo it; the
# runner's side also hides the secret. The network is shared, and the arena folder stays writable: this keeps secrets
# from bots, while the integrity of a tournament still rests on the competitors' honesty (a hosted arena is the real
# boundary).
set -euo pipefail
MODE=${1:?usage: launch.sh start <commit> | resume | referee | runner}
SRC=${SRC:-/home/user/swu_bot}
BASE=${BASE:-/srv/arena-run}
ARENA_USER=${ARENA_USER:-arena}
# the round seeds' secret: root's alone (the referee reads it; bot code, as $ARENA_USER, cannot)
SECRET=${ARENA_SECRET_FILE:-/root/.arena-secret}
# the CA bundle the cloud container's certificate settings name, copied where $ARENA_USER may read it
CA_SRC=${NODE_EXTRA_CA_CERTS:-${SSL_CERT_FILE:-}}
CA=${CA_SRC:+$BASE/etc/ca-bundle.crt}
ARENA_HOME=${ARENA_HOME:-/mnt/project-files/arena}
SHARED_RESULTS=${SHARED_RESULTS:-/mnt/project-files/results}
BACKUP=${BACKUP:-/mnt/project-files/arena-runner}
MEMO_SRC=${MEMO_SRC:-$ARENA_HOME/tools/memo}
LAUNCH=$ARENA_HOME/launch.json
LAUNCH_TOURNAMENT=$ARENA_HOME/tournament.json

# a minimal environment for the referee and the runner (the runner passes even less on to competitors)
# (git: the ladders' user reads the root-owned worktree and engine, which git refuses unless told they are safe)
CLEAN=(env -i "PATH=$PATH" "HOME=$BASE/home" "LANG=${LANG:-C.UTF-8}" "TZ=UTC" "NO_PROXY=${NO_PROXY:-}" "no_proxy=${no_proxy:-}"
       "NODE_EXTRA_CA_CERTS=$CA" "SSL_CERT_FILE=$CA" "ARENA_HOME=$ARENA_HOME" "ARENA_RESULTS=$BASE/results"
       "ARENA_PUBLIC_RESULTS=$SHARED_RESULTS" "ARENA_SECRET_FILE=$SECRET" "ARENA_BOT_USER=$ARENA_USER"
       "GIT_CONFIG_COUNT=1" "GIT_CONFIG_KEY_0=safe.directory" "GIT_CONFIG_VALUE_0=*")
# a rehearsal points this elsewhere too (default: the project's dashboard folder)
[ -n "${ARENA_DASH:-}" ] && CLEAN+=("ARENA_DASH=$ARENA_DASH")
UPLINK_LOOP='bot/arena/push.js arena --every'
# the session's credentials and settings (and the usual places of others, hidden only where they exist), hidden from
# the referee and the runner and all they start. Each gets a /tmp of its own under $BASE/tmp, so the session's
# scratchpad and anything else in the real /tmp is out of reach too, and the other's /tmp is hidden.
SECRETS=(/root/.claude /root/.claude.json /root/.config /root/.fly /root/.aws /root/.boto /root/.ssh /root/.gitconfig
         /root/.git-credentials /root/.netrc /root/.npmrc /root/.docker /root/.kube /root/.pki /root/.hex /root/.mix
         /root/.cargo/credentials /root/.cargo/credentials.toml /root/.gradle/gradle.properties /root/.ccr-hearth-status-nudge
         /home/claude/.claude/remote/.session_ingress_token)
ISOLATE=(bash "$(dirname "$(readlink -f "$0")")/isolate.sh")
for p in "${SECRETS[@]}"; do ISOLATE+=(--hide "$p"); done
# the runner's side (competitors) must not learn the round seeds either; the referee needs the secret to draw them
ISOLATE_RUNNER=("${ISOLATE[@]}" --tmp "$BASE/tmp/runner" --hide "$SECRET" --hide "$BASE/tmp/referee" --)
# the referee's side needs no sign-in at all; the referee starts its ladders and evals as $ARENA_USER (ARENA_BOT_USER)
ISOLATE+=(--tmp "$BASE/tmp/referee" --hide /home/claude/.claude --hide "$BASE/tmp/runner" --)

say() { echo "[launch $(date -u +%H:%M:%S)] $*"; }
# a launch setting from launch.json, or $2 when it has none
setting() { node -e "const j=require('$LAUNCH'); process.stdout.write(String(j[process.argv[1]] ?? process.argv[2] ?? ''))" "$1" "${2:-}"; }

# check out in $SRC/forceteki the engine revision <commit> pins, from the address <commit>'s .gitmodules names
# (PR #105 moved it to the fork; a plain `git submodule update` fails until the address is synced)
pin() {
    local commit=$1 want have url
    [ -e "$SRC/forceteki/package.json" ] || git -C "$SRC" submodule update --init
    want=$(git -C "$SRC" rev-parse "$commit:forceteki")
    have=$(git -C "$SRC/forceteki" rev-parse HEAD)
    [ "$want" = "$have" ] && return
    if [ -n "$(git -C "$SRC/forceteki" status --porcelain --untracked-files=no)" ]; then
        say "$SRC/forceteki has uncommitted changes; the arena runs only a committed engine revision"
        exit 1
    fi
    url=$(git -C "$SRC" config --blob "$commit:.gitmodules" submodule.forceteki.url)
    say "moving $SRC/forceteki from $have to $want, the revision $commit pins ($url)"
    git -C "$SRC" config submodule.forceteki.url "$url"
    git -C "$SRC/forceteki" remote set-url origin "$url"
    if ! git -C "$SRC/forceteki" fetch --quiet origin "$want" || ! git -C "$SRC/forceteki" checkout --quiet --detach "$want"; then
        say "could not check out forceteki $want from $url"
        exit 1
    fi
}

engine() {
    # an edited engine would not match the revision its build records (and the engine is read-only here): refuse it
    if [ -n "$(git -C "$SRC/forceteki" status --porcelain --untracked-files=no)" ]; then
        say "$SRC/forceteki has uncommitted changes; the arena runs only a committed engine revision"
        exit 1
    fi
    # the build records the forceteki revision it was made from; another one (or none recorded) is built again
    local rev stamp="$SRC/forceteki/build/.built-from"
    rev=$(git -C "$SRC/forceteki" rev-parse HEAD)
    if [ ! -d "$SRC/forceteki/build/server" ] || [ "$(cat "$stamp" 2>/dev/null)" != "$rev" ]; then
        say "building the engine in $SRC/forceteki ($rev)"
        (cd "$SRC/forceteki" && npm install --no-audit --no-fund && rm -rf build && npm run build)
        echo "$rev" > "$stamp"
    fi
    if [ ! -d "$SRC/forceteki/test/json/Card" ]; then
        mkdir -p "$SRC/forceteki/test/json"
        cp -a /mnt/project-files/games/card-data/. "$SRC/forceteki/test/json/"
    fi
    [ -d "$SRC/node_modules" ] || (cd "$SRC" && npm install --no-audit --no-fund)
}

# the user the referee runs as: no capabilities, so nothing it starts can undo isolate.sh's hiding
arena_user() {
    id -u "$ARENA_USER" > /dev/null 2>&1 && return
    say "adding the user $ARENA_USER"
    useradd --system --user-group --no-create-home --home-dir "$BASE/home" --shell /usr/sbin/nologin "$ARENA_USER"
}

setup() {
    local commit=$1
    arena_user
    mkdir -p "$BASE/results" "$BASE/logs" "$BASE/repos" "$BASE/tools" "$BASE/home" "$BASE/etc"
    # $BASE (and the folders above it) must let $ARENA_USER through to the worktree and its own folders
    chmod 755 "$BASE"
    if ! runuser -u "$ARENA_USER" -- test -x "$BASE/home"; then
        say "$ARENA_USER cannot reach $BASE (a folder above it is closed, e.g. /root): pick a BASE outside it (default /srv/arena-run)"
        exit 1
    fi
    # the engine is built once, in $SRC, at the forceteki revision <commit> pins
    pin "$commit"
    engine
    # a checkout of another commit (an earlier tournament's) is made again
    at() { git -C "$1" rev-parse HEAD 2>/dev/null || true; }
    if [ ! -e "$BASE/referee/bot/arena/referee.js" ] || [ "$(at "$BASE/referee")" != "$commit" ]; then
        git -C "$SRC" worktree remove --force "$BASE/referee" 2>/dev/null || true
        git -C "$SRC" worktree prune
        rm -rf "$BASE/referee"
        git -C "$SRC" worktree add --detach "$BASE/referee" "$commit"
        rmdir "$BASE/referee/forceteki"
        ln -s "$SRC/forceteki" "$BASE/referee/forceteki"
        ln -s "$SRC/node_modules" "$BASE/referee/node_modules"
    fi
    local names
    # benched competitors too: rejoin gives them work windows again without another setup
    names=$(node -e "const r=require('$ARENA_HOME/roster.json'); console.log([...r.agents, ...(r.bench ?? [])].filter(a=>a.harness&&!a.harness.selfRun&&['claude-code','script','command'].includes(a.harness.kind)).map(a=>a.name).join(' '))")
    for n in $names; do
        local d=$BASE/repos/$n
        [ -e "$d/bot/arena/eval.js" ] && [ -d "$d/forceteki/build/server" ] && [ "$(at "$d")" = "$commit" ] && continue
        say "competitor copy for $n"
        rm -rf "$d"
        git clone -q --no-hardlinks "$SRC" "$d"
        git -C "$d" checkout -q --detach "$commit"
        # the reference code the brief points at
        git -C "$d" fetch -q "$SRC" refs/remotes/origin/claude/project-thread-t81nys:refs/remotes/origin/claude/project-thread-t81nys || true
        git -C "$d" remote set-url origin /nonexistent/no-remote
        git -C "$d" remote set-url --push origin /nonexistent/no-push
        rmdir "$d/forceteki" 2>/dev/null || true
        tar -C "$SRC" --exclude=forceteki/.git -cf - forceteki | tar -C "$d" -xf -
        cp -a "$SRC/node_modules" "$d/node_modules"
    done
    if [ ! -x "$BASE/tools/memo" ]; then
        install -m 755 "$MEMO_SRC" "$BASE/tools/memo"
    fi
    # after a new container: every round ladder the mirror kept that standings.json or tournament.json names (games and the
    # replay server read them here; a running round resumes from its copy), and the backup of the logs
    local id ids
    ids=$(node -e "
const fs = require('fs');
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const ids = new Set();
for (const rd of read(process.argv[1])?.rounds ?? []) ids.add(rd.ladderId ?? 'arena-r' + rd.round);
for (const r of read(process.argv[2])?.rounds ?? []) ids.add(r.ladder ?? 'arena-r' + r.n);
console.log([...ids].join('\n'));" "$ARENA_HOME/standings.json" "$LAUNCH_TOURNAMENT" 2>/dev/null || true)
    for id in $ids; do
        [[ "$id" =~ ^arena-[A-Za-z0-9_-]+$ ]] || continue
        if [ -d "$SHARED_RESULTS/$id" ] && [ ! -e "$BASE/results/$id" ]; then
            cp -a "$SHARED_RESULTS/$id" "$BASE/results/" && say "restored $id from $SHARED_RESULTS"
        fi
    done
    if [ -d "$BACKUP" ] && [ -z "$(ls -A "$BASE/logs" 2>/dev/null)" ]; then
        cp -a "$BACKUP/." "$BASE/logs/" && say "restored the runner's logs backup from $BACKUP"
    fi
    # made here (the referee would make it too) so that the runner's side hides it from its very first start
    if [ ! -s "$SECRET" ]; then
        mkdir -p "$(dirname "$SECRET")"
        (umask 077 && node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" > "$SECRET")
    fi
    [ -n "$CA" ] && install -m 644 "$CA_SRC" "$CA"
    # what the ladders write is their user's; the secret, the worktree, the engine, the tools and the runner's folders
    # stay root's
    chown -R "$ARENA_USER:" "$BASE/results" "$BASE/home"
    chown root: "$SECRET"
    chmod 600 "$SECRET"
    # the arena and dashboard folders: the shared mount lets any user write, a rehearsal's local copy is made its user's
    local d
    for d in "$ARENA_HOME" "${ARENA_DASH:-}"; do
        [ -n "$d" ] && [ -d "$d" ] || continue
        runuser -u "$ARENA_USER" -- test -w "$d" || chown -R "$ARENA_USER:" "$d"
    done
}

start_referee() {
    local resume=$1
    mkdir -p "$BASE/tmp/referee" "$BASE/tmp/runner"
    cd "$BASE/referee"
    if [ "$resume" = 1 ]; then
        "${CLEAN[@]}" setsid nohup "${ISOLATE[@]}" node bot/arena/referee.js --tournament --resume --workers 3 --eval-workers 1 >> "$BASE/referee.log" 2>&1 < /dev/null &
    else
        "${CLEAN[@]}" setsid nohup "${ISOLATE[@]}" node bot/arena/referee.js --tournament --rounds "${ROUNDS:-3}" --minutes "${MINUTES:-60}" --games "${GAMES:-2}" \
            --workers 3 --eval-workers 1 --title "${TITLE:?TITLE}" --task "${TASK:-}" ${HOLDOUT:+--holdout "$HOLDOUT"} >> "$BASE/referee.log" 2>&1 < /dev/null &
    fi
    say "referee started (pid $!)"
}

start_runner() {
    mkdir -p "$BASE/tmp/referee" "$BASE/tmp/runner"
    cd "$BASE/referee"
    "${CLEAN[@]}" setsid nohup "${ISOLATE_RUNNER[@]}" node bot/arena/runner.js --repo "$BASE/repos/{name}" --logs "$BASE/logs" --memo "$BASE/tools/memo" \
        --budget-usd "$(setting budgetUSD 50)" --brake-5h "$(setting brake5h 0.8)" --brake-7d "$(setting brake7d 0.85)" --mirror "$BASE/results" "$SHARED_RESULTS" --backup "$BACKUP" >> "$BASE/runner.log" 2>&1 < /dev/null &
    say "runner started (pid $!)"
}

# the window's address: from the environment, else the one the tournament started with
window_url() { printf '%s' "${SWU_WINDOW:-$(setting window)}"; }

# the uplink's environment: CLEAN plus the egress proxy, and its ladders read from the local results (the freshest copy)
uplink_env() {
    UPLINK=(env -i "PATH=$PATH" "HOME=/root" "LANG=${LANG:-C.UTF-8}" "TZ=UTC" "NO_PROXY=${NO_PROXY:-}" "no_proxy=${no_proxy:-}"
            "HTTPS_PROXY=${HTTPS_PROXY:-}" "https_proxy=${https_proxy:-}" "NODE_USE_ENV_PROXY=1" "NODE_OPTIONS=--disable-warning=UNDICI-EHPA"
            "NODE_EXTRA_CA_CERTS=${NODE_EXTRA_CA_CERTS:-}" "SSL_CERT_FILE=${SSL_CERT_FILE:-}" "ARENA_HOME=$ARENA_HOME"
            "ARENA_RESULTS=$BASE/results" "ARENA_PUBLIC_RESULTS=$BASE/results" "SWU_WINDOW=$1")
    [ -n "${ARENA_DASH:-}" ] && UPLINK+=("ARENA_DASH=$ARENA_DASH")
    # the uplink alone gets the push token (SWU_WINDOW_TOKEN, else ARENA_PUSH_TOKEN). Nothing the referee or the runner
    # starts can read the uplink's environment: they see only their own processes (isolate.sh)
    local tok=${SWU_WINDOW_TOKEN:-${ARENA_PUSH_TOKEN:-}}
    [ -n "$tok" ] && UPLINK+=("SWU_WINDOW_TOKEN=$tok")
    return 0
}

start_uplink() {
    local window
    window=$(window_url)
    if [ -z "$window" ]; then
        say "no SWU_WINDOW: the window uplink is off"
        return 0
    fi
    uplink_env "$window"
    cd "$BASE/referee"
    "${UPLINK[@]}" setsid nohup node bot/arena/push.js arena --every 20 >> "$BASE/uplink.log" 2>&1 < /dev/null &
    say "uplink to $window started (pid $!)"
}

# whether any of these processes is still running
alive() {
    local p
    for p in "$@"; do
        kill -0 "$p" 2>/dev/null && return 0
    done
    return 1
}

stop_uplink() {
    local window pids
    window=$(window_url)
    pids=$(pgrep -f "$UPLINK_LOOP" || true)
    # stop the loop first and wait until it has exited, so a request of its still open cannot land after the last push
    if [ -n "$pids" ]; then
        kill $pids 2>/dev/null || true
        for _ in $(seq 50); do
            alive $pids || break
            sleep 0.2
        done
        kill -9 $pids 2>/dev/null || true
        say "uplink stopped"
    fi
    if [ -n "$window" ]; then
        uplink_env "$window"
        (cd "$BASE/referee" && "${UPLINK[@]}" node bot/arena/push.js arena --once >> "$BASE/uplink.log" 2>&1) || say "the last push to $window failed (see $BASE/uplink.log)"
    fi
    return 0
}

case "$MODE" in
    start)
        COMMIT=${2:?usage: launch.sh start <commit>}
        COMMIT=$(git -C "$SRC" rev-parse "$COMMIT")
        mkdir -p "$ARENA_HOME/tools"
        [ -e "$ARENA_HOME/tools/memo" ] || cp "${MEMO_FROM:?MEMO_FROM: path to OptMem memo}" "$ARENA_HOME/tools/memo"
        node -e "require('fs').writeFileSync('$LAUNCH', JSON.stringify({commit: process.argv[1], budgetUSD: Number(process.argv[2]), brake5h: Number(process.argv[3]), brake7d: Number(process.argv[4]), window: process.argv[5] || null, startedAt: new Date().toISOString()}, null, 1))" \
            "$COMMIT" "${BUDGET_USD:-50}" "${BRAKE_5H:-0.8}" "${BRAKE_7D:-0.85}" "${SWU_WINDOW:-}"
        setup "$COMMIT"
        # a new tournament starts with an empty /tmp for the referee and the runner (a restart keeps it)
        rm -rf "$BASE/tmp"
        (cd "$BASE/referee" && "${CLEAN[@]}" HOME=/root npm run -s gate)
        start_referee 0
        sleep 5
        start_runner
        start_uplink
        ;;
    resume)
        setup "$(setting commit)"
        pgrep -f 'bot/arena/referee.js --tournament' > /dev/null || start_referee 1
        sleep 5
        pgrep -f 'bot/arena/runner.js --repo' > /dev/null || start_runner
        pgrep -f "$UPLINK_LOOP" > /dev/null || start_uplink
        ;;
    referee) start_referee 1 ;;
    runner) start_runner ;;
    uplink) start_uplink ;;
    uplink-stop) stop_uplink ;;
    *) echo "unknown mode $MODE" >&2; exit 1 ;;
esac
