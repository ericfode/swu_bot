'use strict';

const fs = require('fs');
const path = require('path');

/** Read a replay .jsonl (header, step*, end) as written by bot/tournament.js. A game still being recorded has no end. */
function loadGame(file) {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    const game = { file: path.resolve(file), id: path.basename(file).replace(/\.jsonl$/, ''), header: null, steps: [], end: null };
    for (const l of lines) {
        const e = JSON.parse(l);
        if (e.t === 'header') {
            game.header = e;
        } else if (e.t === 'step') {
            game.steps.push(e);
        } else if (e.t === 'end') {
            game.end = e;
        }
    }
    if (!game.header || !game.steps.length) {
        throw new Error(`${file}: not a replay (needs a header and at least one step)`);
    }
    return game;
}

/** Expand a path argument: a .jsonl file, a tournament dir (<dir>/games/*.jsonl) or a dir of .jsonl files. */
function gameFiles(p) {
    const st = fs.statSync(p);
    if (st.isFile()) {
        return [p];
    }
    const dir = fs.existsSync(path.join(p, 'games')) ? path.join(p, 'games') : p;
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => path.join(dir, f));
}

const botName = (game, seat) => game.header.players.find((p) => p.id === seat)?.bot ?? seat;

/**
 * Split a game into checkpoints, the positions that get evaluated.
 *
 * granularity 'turn' (default): one checkpoint after every turn, where a turn is a maximal run of consecutive
 *   decisions by the same player in the same round and phase (an action plus its target prompts, or one player's
 *   resource choices). Checkpoint 0 is the game start.
 * granularity 'round': one checkpoint at the end of each round's action phase, plus the start and the end.
 *
 * max: if there are more checkpoints than this, keep an evenly spaced subset (always keeping the first and last).
 */
function checkpoints(game, { granularity = 'turn', max = Infinity } = {}) {
    const steps = game.steps;
    const groups = [];
    let cur = null;
    for (let k = 0; k < steps.length; k++) {
        const s = steps[k];
        const key = s.pid ? `${s.pid}|${s.state.round}|${s.state.phase}` : `start|${k}`;
        if (cur && cur.key === key) {
            cur.to = k;
        } else {
            cur = { key, from: k, to: k };
            groups.push(cur);
        }
    }

    let cps = groups.map((g) => ({ from: g.from, to: g.to }));
    if (granularity === 'round') {
        const keep = [];
        for (let i = 0; i < cps.length; i++) {
            const s = steps[cps[i].to];
            const next = cps[i + 1] ? steps[cps[i + 1].to] : null;
            const roundEnds = !next || (s.state.phase === 'action' && next.state.phase !== 'action');
            if (i === 0 || roundEnds) {
                keep.push({ from: keep.length ? keep[keep.length - 1].to + 1 : cps[i].from, to: cps[i].to });
            }
        }
        cps = keep;
    }

    let out = cps.map((g) => {
        const last = steps[g.to];
        const run = steps.slice(g.from, g.to + 1);
        return {
            step: last.n,
            stepIndex: g.to,
            fromStep: steps[g.from].n,
            round: last.state.round,
            phase: last.state.phase,
            actor: run.every((s) => s.pid === run[0].pid) ? run[0].pid ?? null : null,
            actions: run.map((s) => (s.action ? s.action.label : s.label)).filter(Boolean)
        };
    });

    if (out.length > max && max >= 2) {
        const picked = [];
        for (let j = 0; j < max; j++) {
            picked.push(out[Math.round((j * (out.length - 1)) / (max - 1))]);
        }
        out = [...new Set(picked)];
    }
    return out.map((c, i) => ({ i, ...c }));
}

module.exports = { loadGame, gameFiles, checkpoints, botName };
