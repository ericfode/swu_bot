'use strict';

/**
 * Trace checks: play a recorded game again on the engine and check that it comes out the same.
 *
 * A replay (spec/replay-format.md) holds both deck lists, the seed, the game's key and the index of every chosen
 * action, and the real game is a function of those alone: the referee never rolls it back, and the bots' timing and
 * simulations happen on copies. So the engine is seeded as match.js seeds it (rng.js gameStreams), each recorded
 * action is applied with its split, and the board after it must equal the recorded snapshot. A change that alters how
 * games play or how they are recorded shows up as the first step whose board differs.
 *
 *   node bot/trace.js check <replay.jsonl[.gz] | folder>...    one line per game; exit 1 when any game differs
 *   node bot/trace.js rewrite <replay.jsonl[.gz]>...           play the recorded moves again and write the boards anew
 *
 * `rewrite` is for a change that is meant to alter the boards (a new snapshot field, an engine upgrade): it still
 * fails when a recorded move is no longer legal or the game ends differently.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { gameStreams, seededRng } = require('./rng');

// view.js and env.js load the engine, so they are required only when a game is played
const engine = () => ({ ...require('./view'), ...require('./env') });

/** The events of a replay file (.jsonl, or gzipped .jsonl.gz). */
function readTrace(file) {
    const raw = fs.readFileSync(file);
    const text = file.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function writeTrace(file, events) {
    const text = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(file, file.endsWith('.gz') ? zlib.gzipSync(text, { level: 9 }) : text);
}

/** The first place where two JSON values differ, as `path: want X, got Y`, or null when they are equal. */
function difference(want, got, at = 'state') {
    if (Object.is(want, got)) {
        return null;
    }
    const show = (v) => (v === undefined ? 'nothing' : JSON.stringify(v).slice(0, 120));
    if (typeof want !== 'object' || typeof got !== 'object' || want === null || got === null || Array.isArray(want) !== Array.isArray(got)) {
        return `${at}: want ${show(want)}, got ${show(got)}`;
    }
    if (Array.isArray(want) && want.length !== got.length) {
        return `${at}: want ${want.length} entries, got ${got.length} (${show(want)} vs ${show(got)})`;
    }
    for (const k of new Set([...Object.keys(want), ...Object.keys(got)])) {
        const d = difference(want[k], got[k], Array.isArray(want) ? `${at}[${k}]` : `${at}.${k}`);
        if (d) {
            return d;
        }
    }
    return null;
}

/** The first line of an error's message, as the end event records it. */
const firstLine = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 200);

/** A fresh game with the replay's decks and engine seed, seeded as match.js seeds it. */
async function freshGame(env, header, end) {
    const eg = env.newGame({ seed: gameStreams(header.seed, end?.key ?? null).engine, deck1: header.decks.p1, deck2: header.decks.p2 });
    await eg.start();
    return eg;
}

/** Apply one recorded step; returns what no longer matches the recording, or null. Engine errors are thrown. */
function applyStep(eg, step) {
    const { actionKey, splitError } = engine();
    const pid = eg.pidOf(step.pid);
    const actions = eg.legalActions(pid);
    const a = actions[step.action.i];
    if (actions.length !== step.legal || !a || a.kind !== step.action.kind || a.label !== step.action.label) {
        const seen = a ? `${a.kind} "${a.label}"` : 'nothing';
        return `${step.pid} had ${actions.length} legal actions (recorded ${step.legal}), action ${step.action.i} is ${seen} (recorded ${step.action.kind} "${step.action.label}")`;
    }
    const id = a.cardUuid ?? (a.kind === 'displayCard' ? a.arg : undefined);
    if (step.action.id !== undefined && eg.cardId(id) !== step.action.id) {
        return `action ${step.action.i} acts on ${eg.cardId(id)}, recorded ${step.action.id}`;
    }
    let move = a;
    if (a.kind === 'distribute') {
        const split = (step.action.split ?? []).map((e) => ({ id: eg.uuidOf(e.id), amount: e.amount }));
        const why = splitError(a, split);
        if (why) {
            return `the recorded split no longer fits (${why}): ${actionKey(eg, a)}`;
        }
        move = { ...a, split };
    }
    eg.apply(pid, move);
    return null;
}

/**
 * Splits worth trying for a distribute action whose split was not recorded, as [{k (target index), amount}]: nothing
 * at all, everything on one target, and two seeded random splits; only the legal ones.
 */
function splitsOf(a, i) {
    const { splitError, randomSplit } = engine();
    const { spec, targets, caps } = a;
    const tries = [[], ...targets.map((_, k) => [{ k, amount: Math.min(caps[k], spec.amount) }])];
    for (const n of [0, 1]) {
        const random = randomSplit(a, seededRng(`trace-split:${i}:${n}`));
        tries.push(random.map((e) => ({ k: targets.indexOf(e.id), amount: e.amount })));
    }
    return tries.filter((t) => !splitError(a, t.map((e) => ({ id: targets[e.k], amount: e.amount }))));
}

/**
 * A game that ended in an engine error records every move but the one that raised it. Look for that move: the error
 * may come from listing the legal actions, else from one of the acting player's actions, each tried on a fresh game.
 * Returns a note saying where the recorded error happens again, or null when no move raises it. The split of a
 * distribute action was the bot's and is not recorded, so a few splits are tried (splitsOf); at most `tries` moves are.
 */
async function reproduceError(env, header, end, steps, eg, snapshot, tries = 40) {
    const same = (e) => firstLine(e) === end.error;
    let acting = null;
    for (const pid of eg.ids) {
        try {
            const actions = eg.legalActions(pid);
            if (actions.length) {
                acting ??= { pid, actions };
            }
        } catch (e) {
            return same(e) ? `the recorded engine error happens again when ${eg.seatOf(pid)}'s legal actions are listed` : null;
        }
    }
    const candidates = (acting?.actions ?? []).flatMap((a, i) => (a.kind === 'distribute' ? splitsOf(a, i).map((split) => ({ a, i, split })) : [{ a, i }]));
    for (const { a, i, split } of candidates.slice(0, tries)) {
        // actions name the prompt and cards of their own game, so each copy lists its own
        const copy = await freshGame(env, header, end);
        steps.slice(1).forEach((step) => applyStep(copy, step));
        try {
            const move = copy.legalActions(acting.pid)[i];
            copy.apply(acting.pid, split ? { ...move, split: split.map((e) => ({ id: move.targets[e.k], amount: e.amount })) } : move);
            snapshot(copy);
        } catch (e) {
            if (same(e)) {
                const how = split ? `, split ${JSON.stringify(split.map((e) => e.amount))}` : '';
                return `the recorded engine error happens again when ${copy.seatOf(acting.pid)} takes action ${i} (${a.kind} "${a.label}"${how})`;
            }
        }
    }
    return null;
}

/**
 * Play the moves of `events` (one replay) again on a fresh game. Returns { steps, ok, diff, note, events }:
 * `diff` names the first step that came out differently, `note` says how a game that ended in an engine error was
 * checked, and `events` is the replay with the boards this engine produced.
 */
async function replayTrace(env, events, { snapshot = engine().snapshot } = {}) {
    const header = events.find((e) => e.t === 'header');
    const end = events.find((e) => e.t === 'end') ?? null;
    const steps = events.filter((e) => e.t === 'step').sort((a, b) => a.n - b.n);
    if (!header || !header.decks) {
        throw new Error('the replay has no header with deck lists');
    }
    const out = { steps: 0, ok: true, diff: null, note: null, events: [] };
    const fail = (n, what) => Object.assign(out, { ok: false, diff: `step ${n}: ${what}` });
    if (!steps.length || steps[0].n !== 0) {
        out.note = 'no opening board: the game ended before it started';
        out.events = events;
        return out;
    }
    const eg = await freshGame(env, header, end);
    const boards = new Map();
    for (const step of steps) {
        try {
            const wrong = step.n === 0 ? null : applyStep(eg, step);
            if (wrong) {
                return fail(step.n, wrong);
            }
            const state = snapshot(eg);
            boards.set(step.n, state);
            const d = difference(step.state, state);
            if (d) {
                return fail(step.n, d);
            }
        } catch (e) {
            return fail(step.n, `engine error: ${firstLine(e)}`);
        }
        out.steps = step.n;
    }
    if (end) {
        if (end.outcome === 'won' && (!eg.over || eg.winner !== end.winner)) {
            return fail(out.steps, `the game ends with winner ${eg.winner ?? 'none yet'}, recorded ${end.winner}`);
        }
        if (end.outcome !== 'won' && eg.over) {
            return fail(out.steps, `the game is over (winner ${eg.winner}), recorded ${end.outcome}`);
        }
        if (end.round !== undefined && end.outcome === 'won' && eg.round !== end.round) {
            return fail(out.steps, `the game ends in round ${eg.round}, recorded ${end.round}`);
        }
        // an error no move reproduces came from elsewhere, such as the referee's simulations, or the engine has
        // changed: either way the recorded moves matched, so it is a note, not a difference
        if (end.outcome === 'ERROR' && !end.by) {
            out.note = (await reproduceError(env, header, end, steps, eg, snapshot)) ?? `no move raises the recorded error again: ${end.error}`;
        }
    }
    out.events = events.map((e) => (e.t === 'step' && boards.has(e.n) ? { ...e, state: boards.get(e.n) } : e.t === 'header' ? { ...e, engine: env.engineRev ?? e.engine } : e));
    return out;
}

/** Replay files under the given files and folders, in name order. */
function traceFiles(args) {
    const files = [];
    for (const a of args) {
        if (fs.statSync(a).isDirectory()) {
            files.push(...fs.readdirSync(a).filter((f) => /\.jsonl(\.gz)?$/.test(f)).sort().map((f) => path.join(a, f)));
        } else {
            files.push(a);
        }
    }
    return files;
}

async function main([mode, ...args]) {
    if (!['check', 'rewrite'].includes(mode) || !args.length) {
        console.error('usage: node bot/trace.js check|rewrite <replay.jsonl[.gz] | folder>...');
        return 2;
    }
    const env = new (engine().Env)();
    let bad = 0;
    for (const file of traceFiles(args)) {
        const t0 = Date.now();
        let r;
        try {
            r = await replayTrace(env, readTrace(file));
        } catch (e) {
            r = { ok: false, steps: 0, diff: String(e?.message ?? e).split('\n')[0] };
        }
        const ms = Date.now() - t0;
        if (r.ok && mode === 'rewrite') {
            writeTrace(file, r.events);
        }
        bad += r.ok ? 0 : 1;
        console.log(JSON.stringify({ file: path.basename(file), ok: r.ok, steps: r.steps, ms, ...(r.diff ? { diff: r.diff } : {}), ...(r.note ? { note: r.note } : {}) }));
    }
    return bad ? 1 : 0;
}

if (require.main === module) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
        console.error(e);
        process.exit(1);
    });
}

module.exports = { readTrace, writeTrace, replayTrace, traceFiles, difference };
