#!/bin/bash
# Watches a running tournament (started by launch.sh) for up to KEEP_SECONDS (default 6600), then exits so whoever
# started it (a Claude Code session, as a background task) wakes up and starts it again. Every 60 s:
#   - the tournament is done and nothing runs any more: exit 0
#   - the referee died while the tournament runs: restart it with --resume (at most 3 times per keeper run)
#   - the runner died: restart it (it first stops whatever the dead one left running)
# and every 10 minutes it prints one status line.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ARENA_HOME=${ARENA_HOME:-/mnt/project-files/arena}
BASE=${BASE:-/root/arena-run}
END=$(( $(date +%s) + ${KEEP_SECONDS:-6600} ))
restarts=0
i=0
state() { node -e "try{const t=require('$ARENA_HOME/tournament.json');const r=t.rounds[t.rounds.length-1]||{};console.log(t.state, 'round', r.n ?? '-', r.ladderStart ? (r.ladderEnd ? 'rated' : 'ladder') : 'work')}catch(e){console.log('unknown', e.message)}"; }
while [ "$(date +%s)" -lt "$END" ]; do
    s=$(state)
    ref=$(pgrep -f 'bot/arena/referee.js --tournament' | head -1)
    run=$(pgrep -f 'bot/arena/runner.js --repo' | head -1)
    if [[ $s == done* ]] && [ -z "$ref" ] && [ -z "$run" ]; then
        echo "[keeper $(date -u +%H:%M)] tournament done, nothing running"
        exit 0
    fi
    if [[ $s == running* ]] && [ -z "$ref" ]; then
        if [ $restarts -ge 3 ]; then
            echo "[keeper $(date -u +%H:%M)] referee down again after 3 restarts; stopping so someone looks"
            tail -20 "$BASE/referee.log"
            exit 2
        fi
        restarts=$((restarts + 1))
        echo "[keeper $(date -u +%H:%M)] referee is down ($s), restarting it (restart $restarts)"
        tail -5 "$BASE/referee.log"
        "$HERE/launch.sh" referee
    fi
    if [[ $s != done* ]] && [ -z "$run" ]; then
        echo "[keeper $(date -u +%H:%M)] runner is down ($s), restarting it"
        tail -5 "$BASE/runner.log"
        "$HERE/launch.sh" runner
    fi
    if [ $((i % 10)) -eq 0 ]; then
        echo "[keeper $(date -u +%H:%M)] $s; referee ${ref:-down}; runner ${run:-down}; $(tail -1 "$BASE/runner.log" 2>/dev/null | cut -c1-140)"
    fi
    i=$((i + 1))
    sleep 60
done
echo "[keeper $(date -u +%H:%M)] keeper time is up ($(state)); start it again"
