#!/bin/bash
# Starts (or, after a crash or a new container, resumes) a clocked arena tournament with unattended competitors:
# the referee (referee.js --tournament) and the runner (runner.js), both detached from this shell.
#
#   bot/arena/ops/launch.sh start <commit>     set up and start a new tournament on <commit> (TITLE, TASK, ROUNDS,
#                                              MINUTES, GAMES, BUDGET_USD, BRAKE_5H (0.8), BRAKE_7D (0.85) from the
#                                              environment)
#   bot/arena/ops/launch.sh resume             set up whatever is missing and resume the tournament in tournament.json
#                                              (the commit comes from <ARENA_HOME>/launch.json)
#   bot/arena/ops/launch.sh referee|runner     restart only that process, on the existing setup (keeper.sh uses these)
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

# a minimal environment for the referee and the runner (the runner passes even less on to competitors)
CLEAN=(env -i "PATH=$PATH" "HOME=/root" "LANG=${LANG:-C.UTF-8}" "TZ=UTC" "NO_PROXY=${NO_PROXY:-}" "no_proxy=${no_proxy:-}"
       "NODE_EXTRA_CA_CERTS=${NODE_EXTRA_CA_CERTS:-}" "SSL_CERT_FILE=${SSL_CERT_FILE:-}" "ARENA_HOME=$ARENA_HOME" "ARENA_RESULTS=$BASE/results")
# a rehearsal points these elsewhere too (defaults: the project's dashboard folder and ~/.arena-secret)
[ -n "${ARENA_DASH:-}" ] && CLEAN+=("ARENA_DASH=$ARENA_DASH")
[ -n "${ARENA_SECRET_FILE:-}" ] && CLEAN+=("ARENA_SECRET_FILE=$ARENA_SECRET_FILE")

say() { echo "[launch $(date -u +%H:%M:%S)] $*"; }
# a launch setting from launch.json, or $2 when it has none
setting() { node -e "const j=require('$LAUNCH'); process.stdout.write(String(j[process.argv[1]] ?? process.argv[2] ?? ''))" "$1" "${2:-}"; }

engine() {
    if [ ! -d "$SRC/forceteki/build/server" ] || [ ! -d "$SRC/forceteki/test/json/Card" ]; then
        say "building the engine in $SRC/forceteki"
        git -C "$SRC" submodule update --init
        (cd "$SRC/forceteki" && npm install --no-audit --no-fund && npm run build)
        mkdir -p "$SRC/forceteki/test/json"
        cp -a /mnt/project-files/games/card-data/. "$SRC/forceteki/test/json/"
    fi
    [ -d "$SRC/node_modules" ] || (cd "$SRC" && npm install --no-audit --no-fund)
}

setup() {
    local commit=$1
    mkdir -p "$BASE/results" "$BASE/logs" "$BASE/repos" "$BASE/tools"
    engine
    if [ ! -e "$BASE/referee/bot/arena/referee.js" ]; then
        git -C "$SRC" worktree prune
        rm -rf "$BASE/referee"
        git -C "$SRC" worktree add --detach "$BASE/referee" "$commit"
        rmdir "$BASE/referee/forceteki"
        ln -s "$SRC/forceteki" "$BASE/referee/forceteki"
        ln -s "$SRC/node_modules" "$BASE/referee/node_modules"
    fi
    local names
    names=$(node -e "const r=require('$ARENA_HOME/roster.json'); console.log(r.agents.filter(a=>a.harness&&['claude-code','script','command'].includes(a.harness.kind)).map(a=>a.name).join(' '))")
    for n in $names; do
        local d=$BASE/repos/$n
        [ -e "$d/bot/arena/eval.js" ] && [ -d "$d/forceteki/build/server" ] && continue
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
    # after a new container: what the mirror and the backup kept
    for r in "$SHARED_RESULTS"/arena-r*; do
        [ -d "$r" ] && [ ! -e "$BASE/results/$(basename "$r")" ] && cp -a "$r" "$BASE/results/" && say "restored $(basename "$r") from $SHARED_RESULTS"
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
            --workers 3 --eval-workers 1 --title "${TITLE:?TITLE}" --task "${TASK:-}" >> "$BASE/referee.log" 2>&1 < /dev/null &
    fi
    say "referee started (pid $!)"
}

start_runner() {
    cd "$BASE/referee"
    "${CLEAN[@]}" setsid nohup node bot/arena/runner.js --repo "$BASE/repos/{name}" --logs "$BASE/logs" --memo "$BASE/tools/memo" \
        --budget-usd "$(setting budgetUSD 50)" --brake-5h "$(setting brake5h 0.8)" --brake-7d "$(setting brake7d 0.85)" --mirror "$BASE/results" "$SHARED_RESULTS" --backup "$BACKUP" >> "$BASE/runner.log" 2>&1 < /dev/null &
    say "runner started (pid $!)"
}

case "$MODE" in
    start)
        COMMIT=${2:?usage: launch.sh start <commit>}
        COMMIT=$(git -C "$SRC" rev-parse "$COMMIT")
        mkdir -p "$ARENA_HOME/tools"
        [ -e "$ARENA_HOME/tools/memo" ] || cp "${MEMO_FROM:?MEMO_FROM: path to OptMem memo}" "$ARENA_HOME/tools/memo"
        node -e "require('fs').writeFileSync('$LAUNCH', JSON.stringify({commit: process.argv[1], budgetUSD: Number(process.argv[2]), brake5h: Number(process.argv[3]), brake7d: Number(process.argv[4]), startedAt: new Date().toISOString()}, null, 1))" \
            "$COMMIT" "${BUDGET_USD:-50}" "${BRAKE_5H:-0.8}" "${BRAKE_7D:-0.85}"
        setup "$COMMIT"
        (cd "$BASE/referee" && "${CLEAN[@]}" npm run -s gate)
        start_referee 0
        sleep 5
        start_runner
        ;;
    resume)
        setup "$(setting commit)"
        pgrep -f 'bot/arena/referee.js --tournament' > /dev/null || start_referee 1
        sleep 5
        pgrep -f 'bot/arena/runner.js --repo' > /dev/null || start_runner
        ;;
    referee) start_referee 1 ;;
    runner) start_runner ;;
    *) echo "unknown mode $MODE" >&2; exit 1 ;;
esac
