#!/usr/bin/env bash
# Close the loop: each round, train on every game so far, build (or draft) with the new models, play the new decks,
# and feed those games to the next round. The decks a builder picks are where its model is wrong, so their games are
# the most useful new data.
#
#   bash bot/deckbuild/loop.sh constructed [FIRST_ROUND] [LAST_ROUND]   # linear + sup builders vs the 27-deck field
#   bash bot/deckbuild/loop.sh draft [FIRST_ROUND] [LAST_ROUND]         # JEPA drafter vs stat drafter, SOR pods
#
# Constructed rounds train on exp1, gen1, every eval/con1-* run and the earlier loop rounds, and play on the field-eval
# seeds, so every round is paired with the real lists in eval/con1-a. Draft rounds train on sor-base1, sor-model1 and
# the earlier rounds. Run from the repo root; outputs go under /mnt/project-files/deckbuild.
set -euo pipefail
MODE=${1:?constructed or draft}
FIRST=${2:-1}
LAST=${3:-3}
D=${DECKBUILD_DIR:-/mnt/project-files/deckbuild}
PY=python3
mkdir -p "$D/loop" "$D/models" "$D/built" "$D/eval" "$D/draft"

# wait for each given pid and fail if any of them failed (a bare `wait` always returns 0)
wait_all() {
    local rc=0
    for p in "$@"; do wait "$p" || rc=$?; done
    return "$rc"
}

if [ "$MODE" = constructed ]; then
    for r in $(seq "$FIRST" "$LAST"); do
        runs="$D/exp1-c-clock $D/data/gen1 $(ls -d "$D"/eval/con1-*)"
        for k in $(seq 1 $((r - 1))); do runs="$runs $D/eval/loop$k"; done
        echo "round $r: training on $runs"
        pids=()
        for m in linear sup; do
            $PY bot/deckbuild/deck_jepa.py --runs $runs --mode $m --steps 2000 --batch 512 \
                --out "$D/models/loop$r-$m.npz" > "$D/loop/train-$r-$m.log" 2>&1 &
            pids+=($!)
        done
        wait_all "${pids[@]}"
        pids=()
        for m in linear sup; do
            $PY bot/deckbuild/build.py --model "$D/models/loop$r-$m.npz" --starts "$D/starts/stat.json" --random-starts 1 \
                --seed "$r" --tag "loop$r-$m" --out "$D/built/loop$r-$m.json" > "$D/loop/build-$r-$m.log" 2>&1 &
            pids+=($!)
        done
        wait_all "${pids[@]}"
        node bot/deckbuild/field-eval.js --candidates "$D/built/loop$r-linear.json,$D/built/loop$r-sup.json" \
            --out "$D/eval/loop$r" --workers 3 > "$D/loop/eval-$r.log" 2>&1
        $PY bot/deckbuild/report.py "$D/eval/con1-a" "$D"/eval/loop* | tee "$D/loop/report-$r.txt"
    done
elif [ "$MODE" = draft ]; then
    for r in $(seq "$FIRST" "$LAST"); do
        runs="$D/draft/sor-base1 $D/draft/sor-model1"
        for k in $(seq 1 $((r - 1))); do runs="$runs $D/draft/sor-loop$k"; done
        echo "round $r: training on $runs"
        $PY bot/deckbuild/deck_jepa.py --runs $runs --no-real --mode jepa-ft --jepa-steps 2000 --steps 3000 --batch 256 \
            --out "$D/models/draft-loop$r-jepa-ft.npz" > "$D/loop/draft-train-$r.log" 2>&1
        mkdir -p "$D/draft/sor-loop$r"
        $PY bot/deckbuild/draft.py --set SOR --pods 40 --drafters model,stat --model "$D/models/draft-loop$r-jepa-ft.npz" \
            --seed $((10 + r)) --tag "sorL$r-" --out "$D/draft/sor-loop$r/pods.json" > "$D/loop/draft-pods-$r.log" 2>&1
        node bot/deckbuild/pod-eval.js --pods "$D/draft/sor-loop$r/pods.json" --out "$D/draft/sor-loop$r" --workers 2 \
            --seed $((72000000 + r * 1000000)) > "$D/loop/draft-eval-$r.log" 2>&1
        $PY -c "import json,sys; s=json.load(open(sys.argv[1])); print('round', sys.argv[2], json.dumps(s['drafters']))" \
            "$D/draft/sor-loop$r/summary.json" "$r" | tee -a "$D/loop/draft-report.txt"
    done
else
    echo "unknown mode $MODE" >&2
    exit 2
fi
