'use strict';
/*
 * Turn-by-turn position analysis of recorded swu_bot games.
 *
 *   node analysis/analyze.js <game.jsonl | tournament dir> [options]
 *
 * Views (every value is stored as P(p1 wins) so the curves share one axis):
 *   subjective_p1 / subjective_p2  each player's own information: own hand, public board, opponent hand size
 *   objective                      both hands, the full log so far, nothing about the future
 *   omniscient                     the whole game with every hand and the result, judged with hindsight
 *
 * Options:
 *   --evaluator llm|heuristic       default llm (Claude; needs ANTHROPIC_API_KEY or `ant auth login`)
 *   --model claude-opus-5-5         Claude model
 *   --effort medium                 effort for checkpoint calls; --omni-effort high for the omniscient pass
 *   --views subjective_p1,subjective_p2,objective,omniscient
 *   --granularity turn|round        turn = after every player's turn (default); round = once per round
 *   --max-checkpoints N             evenly subsample long games
 *   --log-window 30                 recent decisions shown to the checkpoint views
 *   --concurrency 8 | --batch       direct calls in parallel, or one Message Batch at half price
 *   --out file.json | --out-dir dir output (default analysis/out/<game>.<evaluator>.json)
 *   --dashboard dir                 also write the research-dashboard eval file (<dir>/<gameId>.json)
 *   --dump-prompts file.jsonl       write the requests instead of calling anything, then exit
 *   --answers file.jsonl[,more]     use answers produced elsewhere for those requests ({id, output} per line)
 *   --label name                    evaluator label for --answers (default external)
 *   --no-cache                      skip the on-disk answer cache (analysis/.cache)
 */

const fs = require('fs');
const path = require('path');
const { loadGame, gameFiles, checkpoints, botName } = require('./lib/game');
const { renderBoard, renderLog, trajectoryLine } = require('./lib/render');
const P = require('./lib/prompts');
const H = require('./lib/heuristic');
const { ClaudeEvaluator, AnswerFileEvaluator, DEFAULT_MODEL } = require('./lib/llm');

const ALL_VIEWS = ['subjective_p1', 'subjective_p2', 'objective', 'omniscient'];

function args(argv) {
    const o = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const k = a.slice(2);
            const v = argv[i + 1];
            if (v === undefined || v.startsWith('--')) {
                o[k] = true;
            } else {
                o[k] = v;
                i++;
            }
        } else {
            o._.push(a);
        }
    }
    return o;
}

const clamp01 = (x) => Math.max(0, Math.min(1, Number(x)));
const viewSeat = (view) => (view === 'subjective_p2' ? 'p2' : 'p1');

/**
 * An imported human game (importer/) is recorded from one seat, so the other hand was never seen. The views that
 * need that hand (the other seat's subjective view, and objective, which would only repeat the recorder's view)
 * are dropped unless asked for by name.
 */
const hiddenSeats = (game) => game.header.source?.hiddenHands ?? [];
function usableViews(game, views) {
    const hidden = hiddenSeats(game);
    if (!hidden.length) {
        return views;
    }
    return views.filter((v) => v === 'omniscient' || (v !== 'objective' && !hidden.includes(viewSeat(v))));
}

/** Build the Claude requests for one game. */
function buildRequests(game, cps, views, opt) {
    const names = { p1: botName(game, 'p1'), p2: botName(game, 'p2') };
    const decks = game.header.players.map((p) => `${p.id}: ${p.bot}, deck "${p.deck}"`).join('; ');
    const reqs = [];
    for (const cp of cps) {
        const state = game.steps[cp.stepIndex].state;
        for (const view of views) {
            if (view === 'omniscient') {
                continue;
            }
            const pov = view === 'objective' ? null : viewSeat(view);
            const seat = viewSeat(view);
            const note = pov ? P.SUBJECTIVE_NOTE : P.OBJECTIVE_NOTE;
            const who = pov ? `YOU (${seat === 'p1' ? 'player 1' : 'player 2'})` : 'PLAYER 1';
            const user = [
                note,
                `Players: ${decks}.`,
                `POSITION after decision #${cp.step}:\n${renderBoard(state, { pov, names })}`,
                `RECENT DECISIONS (oldest first):\n${renderLog(game.steps, cp.stepIndex, { pov, k: opt.logWindow })}`,
                `Question: what is the probability that ${who} wins? p_win and the factors are for ${who}.`
            ].join('\n\n');
            reqs.push({ id: `cp${cp.i}-${view}`, view, cp: cp.i, system: P.CHECKPOINT_SYSTEM, user, schema: P.CHECKPOINT_SCHEMA, effort: opt.effort, maxTokens: 16000 });
        }
    }
    if (views.includes('omniscient') && game.end?.winner) {
        const lines = cps.map((cp) => trajectoryLine(cp, game.steps[cp.stepIndex].state));
        const result = game.end.winner === 'draw' ? 'The game was a draw.' : `RESULT: ${game.end.winner} (${names[game.end.winner]}) won in round ${game.end.round} after ${game.end.steps} decisions (${game.end.outcome}).`;
        const hidden = hiddenSeats(game);
        const user = [
            `Players: ${decks}.`,
            ...(hidden.length ? [`This game was recorded from the ${game.header.source.pov} view: the hand of ${hidden.join(', ')} was never seen and is listed as "Hidden card". Judge from what is shown.`] : []),
            `CHECKPOINTS (index, round, phase, what was done since the previous checkpoint, then both sides after it; hands are listed in full):`,
            lines.join('\n'),
            result,
            `Return one eval for every checkpoint index from 0 to ${cps[cps.length - 1].i}.`
        ].join('\n\n');
        reqs.push({ id: 'omniscient', view: 'omniscient', system: P.OMNISCIENT_SYSTEM, user, schema: P.OMNISCIENT_SCHEMA, effort: opt.omniEffort, maxTokens: 64000 });
    }
    return reqs;
}

/** Fill gaps in the omniscient series by linear interpolation over checkpoint index. */
function interpolate(cps, byI) {
    const known = cps.filter((c) => byI.has(c.i)).map((c) => c.i);
    return (i) => {
        if (byI.has(i)) {
            return { ...byI.get(i), interpolated: false };
        }
        const lo = known.filter((k) => k < i).pop();
        const hi = known.find((k) => k > i);
        if (lo === undefined && hi === undefined) {
            return null;
        }
        if (lo === undefined || hi === undefined) {
            return { p1: byI.get(lo ?? hi).p1, note: '', interpolated: true };
        }
        const t = (i - lo) / (hi - lo);
        return { p1: byI.get(lo).p1 * (1 - t) + byI.get(hi).p1 * t, note: '', interpolated: true };
    };
}

function checkpointView(view, out) {
    const seat = viewSeat(view);
    const pWin = clamp01(out.p_win);
    return {
        p1: seat === 'p1' ? pWin : 1 - pWin,
        p_win: pWin,
        confidence: out.confidence == null ? null : clamp01(out.confidence),
        factors: out.factors,
        key_factor: out.key_factor,
        why: out.why
    };
}

async function analyzeGame(game, opt, evaluator) {
    const cps = checkpoints(game, { granularity: opt.granularity, max: opt.maxCheckpoints });
    const views = opt.views;
    const result = {
        t: 'analysis',
        v: 1,
        createdAt: new Date().toISOString(),
        promptVersion: P.PROMPT_VERSION,
        game: {
            id: game.id,
            file: path.relative(process.cwd(), game.file).startsWith('..') ? game.file : path.relative(process.cwd(), game.file),
            seed: game.header.seed,
            engine: game.header.engine,
            players: game.header.players,
            winner: game.end?.winner ?? null,
            rounds: game.end?.round ?? game.steps[game.steps.length - 1].state.round,
            steps: game.end?.steps ?? game.steps.length - 1,
            outcome: game.end?.outcome ?? 'running'
        },
        evaluator: null,
        settings: { views, granularity: opt.granularity, logWindow: opt.logWindow, effort: opt.effort, omniEffort: opt.omniEffort },
        checkpoints: [],
        omniscient: null,
        usage: null
    };

    let answers;
    if (opt.evaluator === 'heuristic') {
        result.evaluator = { kind: 'heuristic', model: 'heuristic-v1' };
        answers = new Map();
        for (const cp of cps) {
            const state = game.steps[cp.stepIndex].state;
            for (const view of views.filter((v) => v !== 'omniscient')) {
                answers.set(`cp${cp.i}-${view}`, { output: H.checkpointAnswer(state, viewSeat(view)) });
            }
        }
        if (views.includes('omniscient') && game.end?.winner) {
            answers.set('omniscient', { output: H.omniscientAnswer(cps, cps.map((c) => game.steps[c.stepIndex].state), game.end.winner) });
        }
    } else {
        const reqs = buildRequests(game, cps, views, opt);
        result.evaluator = { ...evaluator.describe(), effort: opt.effort, omniEffort: opt.omniEffort };
        answers = await evaluator.run(reqs);
    }

    let usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0, calls: 0, cached: 0, errors: 0 };
    for (const a of answers.values()) {
        if (a.error) {
            usage.errors++;
        }
        if (a.cached) {
            usage.cached++;
            continue;
        }
        if (a.usage) {
            usage.calls++;
            for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
                usage[k] += a.usage[k] ?? 0;
            }
            usage.cost_usd += a.cost ?? 0;
        }
    }
    usage.cost_usd = Number(usage.cost_usd.toFixed(4));
    result.usage = opt.evaluator === 'heuristic' ? null : usage;

    const omni = answers.get('omniscient');
    let omniAt = () => null;
    if (omni?.output) {
        const byI = new Map(omni.output.evals.filter((e) => Number.isInteger(e.i)).map((e) => [e.i, { p1: clamp01(e.p1), note: e.note ?? '' }]));
        omniAt = interpolate(cps, byI);
        result.omniscient = { turningPoints: omni.output.turning_points ?? [], summary: omni.output.summary ?? '', missing: cps.filter((c) => !byI.has(c.i)).length };
    } else if (omni?.error) {
        result.omniscient = { error: omni.error };
    }

    for (const cp of cps) {
        const rec = { ...cp, views: {} };
        delete rec.stepIndex;
        for (const view of views) {
            if (view === 'omniscient') {
                const o = omniAt(cp.i);
                if (o) {
                    rec.views.omniscient = o;
                }
                continue;
            }
            const a = answers.get(`cp${cp.i}-${view}`);
            if (a?.output) {
                rec.views[view] = checkpointView(view, a.output);
            } else if (a?.error) {
                rec.views[view] = { error: a.error };
            }
        }
        result.checkpoints.push(rec);
    }
    return result;
}

/** The research dashboard's eval format (see /mnt/project-files/dashboard/README.md, section 3). */
function toDashboard(a, tournament = null) {
    const key = { subjective_p1: 'p1_subjective', subjective_p2: 'p2_subjective', objective: 'objective_state', omniscient: 'objective_hindsight' };
    return {
        schema: 1,
        gameId: a.game.id,
        tournament,
        replay: a.game.file,
        p1: a.game.players.find((p) => p.id === 'p1')?.bot,
        p2: a.game.players.find((p) => p.id === 'p2')?.bot,
        winner: a.game.winner,
        rounds: a.game.rounds,
        evaluator: { model: a.evaluator.model, prompt: a.promptVersion, note: `${a.settings.granularity} checkpoints, ${a.evaluator.kind}` },
        points: a.checkpoints.map((c) => {
            const pt = { step: c.step, round: c.round };
            for (const [v, k] of Object.entries(key)) {
                if (c.views[v]?.p1 != null) {
                    pt[k] = Number(c.views[v].p1.toFixed(4));
                }
            }
            const note = c.views.omniscient?.note || c.views.objective?.why;
            if (note) {
                pt.note = note;
            }
            return pt;
        })
    };
}

function writeAtomic(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data, null, 1));
    fs.renameSync(tmp, file);
}

async function main() {
    const a = args(process.argv.slice(2));
    if (!a._.length) {
        console.error('usage: node analysis/analyze.js <game.jsonl | tournament dir> [--evaluator llm|heuristic] [--out file] ... (see header)');
        process.exit(2);
    }
    const opt = {
        evaluator: a.answers ? 'external' : a.evaluator ?? 'llm',
        model: a.model ?? DEFAULT_MODEL,
        effort: a.effort ?? 'medium',
        omniEffort: a['omni-effort'] ?? 'high',
        views: (a.views ?? ALL_VIEWS.join(',')).split(',').filter((v) => ALL_VIEWS.includes(v)),
        granularity: a.granularity ?? 'turn',
        maxCheckpoints: a['max-checkpoints'] ? Number(a['max-checkpoints']) : Infinity,
        logWindow: Number(a['log-window'] ?? 30)
    };
    const files = a._.flatMap(gameFiles);
    const viewsFor = (game) => {
        if (!hiddenSeats(game).length) {
            return opt;
        }
        const views = a.views ? opt.views : usableViews(game, opt.views);
        console.error(`${game.id}: recorded from the ${game.header.source.pov} view (no record of ${hiddenSeats(game).join(', ')}'s hand); views ${views.join(',')}`);
        return { ...opt, views };
    };

    if (a['dump-prompts']) {
        const lines = [];
        for (const f of files) {
            const game = loadGame(f);
            const cps = checkpoints(game, { granularity: opt.granularity, max: opt.maxCheckpoints });
            const o = viewsFor(game);
            for (const r of buildRequests(game, cps, o.views, o)) {
                lines.push(JSON.stringify({ game: game.id, ...r }));
            }
        }
        writeAtomic(a['dump-prompts'], lines.join('\n') + '\n');
        console.error(`wrote ${lines.length} requests to ${a['dump-prompts']}`);
        return;
    }

    let evaluator = null;
    if (opt.evaluator === 'external') {
        evaluator = new AnswerFileEvaluator(String(a.answers).split(','), a.label ?? 'external');
    } else if (opt.evaluator === 'llm') {
        evaluator = new ClaudeEvaluator({
            model: opt.model,
            concurrency: Number(a.concurrency ?? 8),
            batch: Boolean(a.batch),
            cacheDir: a['no-cache'] ? null : path.join(__dirname, '.cache')
        });
    }

    for (const f of files) {
        const game = loadGame(f);
        const t0 = Date.now();
        const res = await analyzeGame(game, viewsFor(game), evaluator);
        const tag = opt.evaluator === 'heuristic' ? 'heuristic' : opt.evaluator === 'external' ? (a.label ?? 'external') : opt.model;
        const out = a.out && files.length === 1 ? a.out : path.join(a['out-dir'] ?? path.join(__dirname, 'out'), `${game.id}.${tag}.json`);
        writeAtomic(out, res);
        if (a.dashboard) {
            writeAtomic(path.join(a.dashboard, `${game.id}.json`), toDashboard(res, a.tournament ?? null));
        }
        const u = res.usage;
        console.error(`${game.id}: ${res.checkpoints.length} checkpoints -> ${out} (${((Date.now() - t0) / 1000).toFixed(1)}s${u ? `, ${u.calls} calls, ${u.cached} cached, ${u.errors} errors, $${u.cost_usd}` : ''})`);
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e.message ?? e);
        process.exit(1);
    });
}

module.exports = { analyzeGame, buildRequests, toDashboard, usableViews, ALL_VIEWS };
