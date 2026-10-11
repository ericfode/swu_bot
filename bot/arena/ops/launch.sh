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
# Layout under $BASE (default /root/arena-run, local disk):
#   referee/        frozen git worktree of the commit; forceteki/ and node_modules/ link to $SRC's built engine
#   repos/<name>/   each competitor's own copy (runner --repo): a clone of the commit with its own engine copy and no
#                   usable remote, so an edit or a git command there changes nothing for the referee or the others
#   results/        ARENA_RESULTS: ladders record here; the runner mirrors it into $SHARED_RESULTS
#   logs/           runner logs, competitor HOMEs, transcripts; usage, prompts and OptMem memory are backed up to $BACKUP
#   tools/memo      OptMem (it must be executable, so not on the shared mount)
# ARENA_HOME stays the shared /mnt/project-files/arena (roster, agents/, versions/, tournament.json, standings).
# Both processes start with a minimal environment (env -i): no session tokens and no NODE_OPTIONS reach the bots.
set -euo pipefail
MODE=${1:?usage: launch.sh start <commit> | resume | referee | runner}
SRC=${SRC:-/home/user/swu_bot}
BASE=${BASE:-/root/arena-run}
ARENA_HOME=${ARENA_HOME:-/mnt/project-files/arena}
SHARED_RESULTS=${SHARED_RESULTS:-/mnt/project-files/results}
BACKUP=${BACKUP:-/mnt/project-files/arena-runner}
MEMO_SRC=${MEMO_SRC:-$ARENA_HOME/tools/memo}
LAUNCH=$ARENA_HOME/launch.json
LAUNCH_TOURNAMENT=$ARENA_HOME/tournament.json

# a minimal environment for the referee and the runner (the runner passes even less on to competitors)
CLEAN=(env -i "PATH=$PATH" "HOME=/root" "LANG=${LANG:-C.UTF-8}" "TZ=UTC" "NO_PROXY=${NO_PROXY:-}" "no_proxy=${no_proxy:-}"
       "NODE_EXTRA_CA_CERTS=${NODE_EXTRA_CA_CERTS:-}" "SSL_CERT_FILE=${SSL_CERT_FILE:-}" "ARENA_HOME=$ARENA_HOME" "ARENA_RESULTS=$BASE/results"
       "ARENA_PUBLIC_RESULTS=$SHARED_RESULTS")
# a rehearsal points these elsewhere too (defaults: the project's dashboard folder and ~/.arena-secret)
[ -n "${ARENA_DASH:-}" ] && CLEAN+=("ARENA_DASH=$ARENA_DASH")
[ -n "${ARENA_SECRET_FILE:-}" ] && CLEAN+=("ARENA_SECRET_FILE=$ARENA_SECRET_FILE")
UPLINK_LOOP='bot/arena/push.js arena --every'

say() { echo "[launch $(date -u +%H:%M:%S)] $*"; }
# a launch setting from launch.json, or $2 when it has none
setting() { node -e "const j=require('$LAUNCH'); process.stdout.write(String(j[process.argv[1]] ?? process.argv[2] ?? ''))" "$1" "${2:-}"; }

engine() {
    [ -e "$SRC/forceteki/package.json" ] || git -C "$SRC" submodule update --init
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

setup() {
    local commit=$1
    mkdir -p "$BASE/results" "$BASE/logs" "$BASE/repos" "$BASE/tools"
    engine
    # the engine is built once, in $SRC: it must be the forceteki revision <commit> pins
    local want have
    want=$(git -C "$SRC" rev-parse "$commit:forceteki")
    have=$(git -C "$SRC/forceteki" rev-parse HEAD)
    if [ "$want" != "$have" ]; then
        say "$commit pins forceteki $want, but $SRC/forceteki is at $have: check that out and rebuild (npm run build in forceteki), then launch again"
        exit 1
    fi
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
    names=$(node -e "const r=require('$ARENA_HOME/roster.json'); console.log(r.agents.filter(a=>a.harness&&!a.harness.selfRun&&['claude-code','script','command'].includes(a.harness.kind)).map(a=>a.name).join(' '))")
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
}

start_referee() {
    local resume=$1
    cd "$BASE/referee"
    if [ "$resume" = 1 ]; then
        "${CLEAN[@]}" setsid nohup node bot/arena/referee.js --tournament --resume --workers 3 --eval-workers 1 >> "$BASE/referee.log" 2>&1 < /dev/null &
    else
        "${CLEAN[@]}" setsid nohup node bot/arena/referee.js --tournament --rounds "${ROUNDS:-3}" --minutes "${MINUTES:-60}" --games "${GAMES:-2}" \
            --workers 3 --eval-workers 1 --title "${TITLE:?TITLE}" --task "${TASK:-}" ${HOLDOUT:+--holdout "$HOLDOUT"} >> "$BASE/referee.log" 2>&1 < /dev/null &
    fi
    say "referee started (pid $!)"
}

start_runner() {
    cd "$BASE/referee"
    "${CLEAN[@]}" setsid nohup node bot/arena/runner.js --repo "$BASE/repos/{name}" --logs "$BASE/logs" --memo "$BASE/tools/memo" \
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
    [ -n "${SWU_WINDOW_TOKEN:-}" ] && UPLINK+=("SWU_WINDOW_TOKEN=$SWU_WINDOW_TOKEN")
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

stop_uplink() {
    local window pids
    window=$(window_url)
    pids=$(pgrep -f "$UPLINK_LOOP" || true)
    if [ -n "$window" ]; then
        uplink_env "$window"
        (cd "$BASE/referee" && "${UPLINK[@]}" node bot/arena/push.js arena --once >> "$BASE/uplink.log" 2>&1) || say "the last push to $window failed (see $BASE/uplink.log)"
    fi
    [ -n "$pids" ] && kill $pids && say "uplink stopped"
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
        (cd "$BASE/referee" && "${CLEAN[@]}" npm run -s gate)
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
