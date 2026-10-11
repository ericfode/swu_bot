'use strict';
/**
 * Win-probability curves for a recorded game from a fitted evaluator, in the research dashboard's eval format
 * (dashboard/README.md section 3: every value is P(p1 wins)).
 *
 *   node bot/eval/curves.js --replay games/<id>.jsonl --eval mlp-deck [--decks decks.jsonl dir] [--out dashboard/evals/<id>.json]
 *
 * Views: p1_subjective and p2_subjective (each player's own hand visible), objective_state (both hands).
 * Hindsight is not produced; an evaluator has no knowledge of the future.
 */
const fs = require('fs');
const path = require('path');
const { readJsonl } = require('./data');
const { loadEvaluator } = require('./evaluators');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

function curves(events, ev, decks) {
    const header = events.find((e) => e.t === 'header');
    const end = events.find((e) => e.t === 'end');
    const steps = events.filter((e) => e.t === 'step');
    const points = [];
    steps.forEach((s, i) => {
        const next = steps[i + 1];
        // one point per action-window decision, plus the final position
        if (!(next?.prompt?.startsWith('actionWindow') && s.state.phase === 'action') && next) {
            return;
        }
        const o = { decks, toAct: next?.pid ?? null };
        const r = (x) => +x.toFixed(4);
        points.push({
            step: s.n, round: s.state.round,
            p1_subjective: r(ev.predict(s.state, 'p1', { ...o, view: 'subjective' })),
            p2_subjective: r(1 - ev.predict(s.state, 'p2', { ...o, view: 'subjective' })),
            objective_state: r(ev.predict(s.state, 'p1', { ...o, view: 'objective' }))
        });
    });
    return {
        header, end, points
    };
}

function main() {
    const replay = arg('replay');
    const id = path.basename(replay, '.jsonl');
    const ev = loadEvaluator(arg('eval', 'mlp-deck'));
    let decks = null;
    const deckDir = arg('decks', path.join(path.dirname(path.dirname(replay)), 'decks'));
    if (fs.existsSync(deckDir)) {
        for (const f of fs.readdirSync(deckDir)) {
            const d = readJsonl(path.join(deckDir, f)).find((x) => x.id === id);
            if (d) {
                decks = { p1: d.p1, p2: d.p2 };
            }
        }
    }
    const { header, end, points } = curves(readJsonl(replay), ev, decks);
    const out = {
        schema: 1, gameId: id, tournament: path.basename(path.dirname(path.dirname(replay))), replay: `replays/${path.basename(path.dirname(path.dirname(replay)))}/games/${id}.jsonl`,
        p1: header?.players?.[0]?.bot ?? null, p2: header?.players?.[1]?.bot ?? null, winner: end?.winner ?? null, rounds: end?.round ?? null,
        evaluator: { model: `bot/eval ${ev.name}`, prompt: null, note: `fitted position evaluator (${ev.kind}${ev.decks ? ', known decklists' : ''}); one point per action-window decision` },
        points
    };
    const file = arg('out', null);
    if (file) {
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(out));
        fs.renameSync(`${file}.tmp`, file);
    } else {
        console.log(JSON.stringify(out).slice(0, 2000));
    }
}

if (require.main === module) {
    main();
}

module.exports = { curves };
