'use strict';
/**
 * Quick self-evaluation for an arena competitor.
 *
 *   node bot/arena/eval.js <bot> [--vs rush,tempo] [--seeds 3] [--seed 20001] [--workers 1] [--record] [--json]
 *   node bot/arena/eval.js --job <queue file> [--workers 1]        (the referee) play a queued eval, see below
 *
 * <bot> vs each opponent on `--seeds` seeds, each seed played from both seats (decks follow the seat, so deck luck
 * cancels). Prints W-L per opponent, harness-timed ms per decision for <bot>, and the lost games. With --record,
 * replays go to replays/arena-eval/<agent>/<id>.jsonl in this checkout (gitignored) for loss review.
 * Eval seeds start at 20001 by default; round ladders use other seeds, so do not tune on a fixed handful of seeds.
 * Opponents can be any registry name: rush, heuristic, aggro, tempo, control, random, another agent, or <agent>-v<N>.
 * Every bot plays under the arena's time cap (roster.thinkCapMs of thinking per game, players/guard.js): a bot that
 * goes over it, throws, hangs or fails to load forfeits that game, which counts as a loss for it (`forfeit` in the row).
 *
 * --job is how the referee plays an eval queued through the API (api.js `eval`) in its own process, so it can stop the
 * eval when the work window ends: the job file ({id, bot, vs, seeds, state: 'running', ...}) gets state 'done' with the
 * summary, or 'failed' with the error. Replays go to <results>/arena-evals/<id>/.
 */
const path = require('path');
const { describeBot } = require('../players');
const { resolveArena } = require('./registry');
const { runJobs } = require('./pool');
const { killChildren } = require('../game-pool');
const { RESULTS, readJson, writeJson, roster } = require('./home');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

/** Result of a finished game for the bot in mySeat: win / loss / draw, or the outcome when it is unrated (ERROR, ...). */
function resultFor(r, mySeat) {
    if (r.outcome === 'ERROR' && (r.by === 'p1' || r.by === 'p2')) {
        return r.by === mySeat ? 'loss' : 'win';
    }
    if (r.outcome !== 'won') {
        return r.outcome;
    }
    const seat = r.winnerSeat ?? r.winner;
    return seat === 'draw' ? 'draw' : seat === mySeat ? 'win' : 'loss';
}

/** Plays `me` against each opponent, `seeds` seeds from both seats; resolves a summary (W-L per opponent, timing, losses). */
async function runEval({ me, opps, seeds = 3, first = 20001, workers = 1, recDir = null, onRow = null, capMs = roster().thinkCapMs ?? Infinity }) {
    const jobs = [];
    for (const o of opps) {
        for (let s = first; s < first + seeds; s++) {
            for (const seat of [1, 2]) {
                const [p1, p2] = seat === 1 ? [me, o] : [o, me];
                const id = `${me}-vs-${o}-${s}-s${seat}`;
                jobs.push({ id, seed: s, p1, p2, seat, opp: o, replayFile: recDir ? path.join(recDir, `${id}.jsonl`) : undefined });
            }
        }
    }
    const t0 = Date.now();
    const rows = [];
    // same rules as a rated round (referee.js): the cap, and the watchdog 30 s past the 2x wall cap
    await runJobs(jobs, {
        workers, capMs, hangMs: Number.isFinite(capMs) ? 2 * capMs + 30000 : 600000,
        onResult: ({ job, result: r }) => {
            const mySeat = `p${job.seat}`;
            const t = r.timing?.[mySeat] ?? { n: 0, ms: 0 };
            const forfeit = r.outcome === 'ERROR' && r.by ? { seat: r.by === mySeat ? 'me' : 'opponent', kind: r.faultKind ?? null } : null;
            const row = { id: job.id, opp: job.opp, seed: job.seed, seat: job.seat, result: resultFor(r, mySeat), forfeit, rounds: r.round, steps: r.steps, myMs: t.ms ?? 0, myDecisions: t.n ?? 0,
                          myP95: t.p95, myThinkMs: r.think?.[mySeat] ?? null, error: r.error ?? null, replay: job.replayFile ?? null };
            rows.push(row);
            onRow?.(row);
        }
    });
    const summary = { bot: me, games: rows.length, wallSec: Math.round((Date.now() - t0) / 1000), capMs: Number.isFinite(capMs) ? capMs : null, byOpp: {}, timing: null, losses: [] };
    for (const o of opps) {
        const mine = rows.filter((r) => r.opp === o);
        summary.byOpp[o] = { win: mine.filter((r) => r.result === 'win').length, loss: mine.filter((r) => r.result === 'loss').length, other: mine.filter((r) => !['win', 'loss'].includes(r.result)).length,
                             forfeits: mine.filter((r) => r.forfeit?.seat === 'me').length };
    }
    const ms = rows.reduce((a, r) => a + r.myMs, 0);
    const n = rows.reduce((a, r) => a + r.myDecisions, 0);
    summary.timing = { msPerDecision: n ? +(ms / n).toFixed(2) : null, maxGameMs: Math.round(Math.max(0, ...rows.map((r) => r.myMs))), worstP95: Math.max(0, ...rows.map((r) => r.myP95 ?? 0)),
                       maxThinkMs: Math.round(Math.max(0, ...rows.map((r) => r.myThinkMs ?? 0))) };
    summary.losses = rows.filter((r) => r.result !== 'win').map(({ id, result, forfeit, rounds, error, replay }) => ({ id, result, forfeit, rounds, error, replay }));
    const wins = rows.filter((r) => r.result === 'win').length;
    summary.winRate = rows.length ? +(wins / rows.length).toFixed(3) : null;
    return summary;
}

const rowLine = (r) => `${r.id}: ${r.result}${r.forfeit ? ` (${r.forfeit.seat === 'me' ? 'my' : 'opponent'} forfeit: ${r.forfeit.kind})` : ''}${r.error ? ' ' + r.error : ''} R${r.rounds} ${r.steps} steps, my think ${Math.round(r.myMs)}ms over ${r.myDecisions} decisions`;

/** --job: plays one queued eval and writes the outcome into its job file. */
async function runJobFile(file) {
    const j = readJson(file, null);
    if (!j?.id || !j.bot || !Array.isArray(j.vs)) {
        throw new Error(`${file} is not an eval job`);
    }
    try {
        for (const b of [j.bot, ...j.vs]) {
            if (!describeBot(b)) {
                throw new Error(`unknown bot "${b}"`);
            }
        }
        const summary = await runEval({ me: j.bot, opps: j.vs, seeds: j.seeds, first: 20001, workers: Number(arg('workers', 1)), recDir: path.join(RESULTS, 'arena-evals', j.id),
                                        onRow: (r) => console.log(`eval ${j.id}: ${rowLine(r)}`) });
        writeJson(file, { ...j, state: 'done', finishedAt: new Date().toISOString(), summary });
    } catch (e) {
        writeJson(file, { ...j, state: 'failed', finishedAt: new Date().toISOString(), error: String(e.message || e) });
    }
}

async function main() {
    if (process.argv.includes('--job')) {
        await runJobFile(path.resolve(arg('job')));
        return;
    }
    const me = process.argv[2];
    if (!me || me.startsWith('--') || !describeBot(me)) {
        throw new Error('usage: node bot/arena/eval.js <bot> [--vs rush,tempo] [--seeds 3] [--seed 20001] [--workers 1] [--record] [--json]');
    }
    const opps = arg('vs', 'rush,tempo').split(',');
    for (const o of opps) {
        if (!describeBot(o)) {
            throw new Error(`unknown bot "${o}"`);
        }
    }
    const json = process.argv.includes('--json');
    const arena = resolveArena(me);
    // replays stay in this container (replays/ is gitignored), not in the shared folder
    const recDir = process.argv.includes('--record') ? path.join(__dirname, '..', '..', 'replays', 'arena-eval', arena ? arena.agent : me) : null;
    const summary = await runEval({
        me, opps, seeds: Number(arg('seeds', 3)), first: Number(arg('seed', 20001)), workers: Number(arg('workers', 1)), recDir,
        onRow: json ? null : (r) => console.log(rowLine(r))
    });
    if (json) {
        console.log(JSON.stringify(summary, null, 1));
    } else {
        const wins = Object.values(summary.byOpp).reduce((s, x) => s + x.win, 0);
        console.log(`\n${me}: ${wins}/${summary.games} wins (${Math.round(100 * summary.winRate)}%) in ${summary.wallSec}s`);
        for (const [o, x] of Object.entries(summary.byOpp)) {
            console.log(`  vs ${o.padEnd(14)} ${x.win}-${x.loss}${x.other ? ` (+${x.other} unfinished)` : ''}${x.forfeits ? `, ${x.forfeits} of them my forfeits` : ''}`);
        }
        const cap = summary.capMs === null ? 'no cap' : `cap ${summary.capMs} ms per game`;
        console.log(`  think time: ${summary.timing.msPerDecision} ms/decision, worst game ${summary.timing.maxGameMs} ms total (guarded thinking ${summary.timing.maxThinkMs} ms, ${cap})`);
    }
}

if (require.main === module) {
    main().then(() => {
        killChildren();
        process.exit(0);
    }, (e) => {
        killChildren();
        console.error(e.message || e);
        process.exit(1);
    });
}

module.exports = { runEval, resultFor };
