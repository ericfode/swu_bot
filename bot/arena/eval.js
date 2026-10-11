'use strict';
/**
 * Quick self-evaluation for an arena competitor.
 *
 *   node bot/arena/eval.js <bot> [--vs rush,tempo] [--seeds 3] [--seed 20001] [--workers 1] [--record] [--json]
 *
 * <bot> vs each opponent on `--seeds` seeds, each seed played from both seats (decks follow the seat, so deck luck
 * cancels). Prints W-L per opponent, harness-timed ms per decision for <bot>, and the lost games. With --record,
 * replays go to replays/arena-eval/<agent>/<id>.jsonl in this checkout (gitignored) for loss review.
 * Eval seeds start at 20001 by default; round ladders use other seeds, so do not tune on a fixed handful of seeds.
 * Opponents can be any registry name: rush, heuristic, aggro, tempo, control, random, another agent, or <agent>-v<N>.
 * Time forfeits show up as an ERROR result containing TIME_FORFEIT.
 */
const path = require('path');
const { describeBot } = require('../players');
const { resolveArena } = require('./registry');
const { runJobs } = require('./pool');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

/** Plays `me` against each opponent, `seeds` seeds from both seats; resolves a summary (W-L per opponent, timing, losses). */
async function runEval({ me, opps, seeds = 3, first = 20001, workers = 1, recDir = null, onRow = null }) {
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
    await runJobs(jobs, {
        workers,
        onResult: ({ job, result: r }) => {
            const mySeat = `p${job.seat}`;
            const forfeit = /TIME_FORFEIT (\S+)/.exec(r.error ?? '');
            const res = forfeit ? (forfeit[1] === me ? 'loss' : 'win') : r.outcome !== 'won' ? r.outcome : r.winner === 'draw' ? 'draw' : r.winner === mySeat ? 'win' : 'loss';
            const t = r.timing?.[mySeat] ?? { n: 0, ms: 0 };
            const row = { id: job.id, opp: job.opp, seed: job.seed, seat: job.seat, result: res, rounds: r.round, steps: r.steps, myMs: t.ms, myDecisions: t.n, myP95: t.p95, error: r.error ?? null, replay: job.replayFile ?? null };
            rows.push(row);
            onRow?.(row);
        }
    });
    const summary = { bot: me, games: rows.length, wallSec: Math.round((Date.now() - t0) / 1000), byOpp: {}, timing: null, losses: [] };
    for (const o of opps) {
        const mine = rows.filter((r) => r.opp === o);
        summary.byOpp[o] = { win: mine.filter((r) => r.result === 'win').length, loss: mine.filter((r) => r.result === 'loss').length, other: mine.filter((r) => !['win', 'loss'].includes(r.result)).length };
    }
    const ms = rows.reduce((a, r) => a + r.myMs, 0);
    const n = rows.reduce((a, r) => a + r.myDecisions, 0);
    summary.timing = { msPerDecision: n ? +(ms / n).toFixed(2) : null, maxGameMs: Math.round(Math.max(0, ...rows.map((r) => r.myMs))), worstP95: Math.max(0, ...rows.map((r) => r.myP95 ?? 0)) };
    summary.losses = rows.filter((r) => r.result !== 'win').map(({ id, result, rounds, error, replay }) => ({ id, result, rounds, error, replay }));
    const wins = rows.filter((r) => r.result === 'win').length;
    summary.winRate = rows.length ? +(wins / rows.length).toFixed(3) : null;
    return summary;
}

async function main() {
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
        onRow: json ? null : (r) => console.log(`${r.id}: ${r.result}${r.error ? ' ' + r.error : ''} R${r.rounds} ${r.steps} steps, my think ${Math.round(r.myMs)}ms over ${r.myDecisions} decisions`)
    });
    if (json) {
        console.log(JSON.stringify(summary, null, 1));
    } else {
        const wins = Object.values(summary.byOpp).reduce((s, x) => s + x.win, 0);
        console.log(`\n${me}: ${wins}/${summary.games} wins (${Math.round(100 * summary.winRate)}%) in ${summary.wallSec}s`);
        for (const [o, x] of Object.entries(summary.byOpp)) {
            console.log(`  vs ${o.padEnd(14)} ${x.win}-${x.loss}${x.other ? ` (+${x.other} unfinished)` : ''}`);
        }
        console.log(`  think time: ${summary.timing.msPerDecision} ms/decision, worst game ${summary.timing.maxGameMs} ms total`);
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e.message || e);
        process.exit(1);
    });
}

module.exports = { runEval };
