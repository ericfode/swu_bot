'use strict';
/**
 * Arena referee: rates the newest submitted version of every competitor against each other and the baselines.
 *
 *   node bot/arena/referee.js [--round K] [--games 4] [--workers 3]           run one rated round now
 *   node bot/arena/referee.js --watch [--interval 600] [--max-rounds 10]       run a round whenever any agent has
 *                                                                              submitted a new version since the last one
 *
 * A round is a round robin (bot/ladder.js) of <agent>-v<latest> for every roster agent plus roster.baselines: --games per
 * pair, every seed from both seats, seeds 1000*K+101..., replays recorded to <results>/arena-r<K>/ (the dashboard follows
 * the games live). Scoring: a TIME_FORFEIT (see registry.js) or more than roster.thinkCapMs of thinking in a game is a
 * loss for that bot. Ratings are Bradley-Terry with the baselines' mean pinned to 1500, per round and over all rounds
 * (so versions compare across rounds). Writes, all in ARENA_HOME:
 *   standings.json     every round so far
 *   rounds/r<K>.md     what competitors read: standings, results per opponent, lost games with replay paths
 * plus the dashboard panels and experiment (dash.js), refreshed every 30 s while a round runs.
 *
 *   node bot/arena/referee.js --tournament --rounds 3 --minutes 60 [--games 2] [--title "..."] [--task "..."]
 * runs a clocked tournament: every round opens a work window of --minutes (all competitors start together; the API's
 * `wait` returns when it opens, and everyone's inbox gets a message), then rates the newest versions. Between ladders
 * the referee also plays evals queued through the API (`eval`), so clients without the engine can test.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { bradleyTerry } = require('../ratings');
const { HOME, RESULTS, readJson, writeJson, roster: loadRoster, versionsOf } = require('./home');
const dash = require('./dash');
const { TOURNAMENT, api } = require('./api');
const { runEval } = require('./eval');

const STANDINGS = path.join(HOME, 'standings.json');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

let roster = loadRoster();
const agentOf = (bot) => roster.agents.find((a) => bot === a.name || bot.startsWith(`${a.name}-v`))?.name ?? null;

/** Score of a finished game for p1 under the time cap, or null (unfinished / both over the cap). */
function cappedScore(g) {
    const tf = /TIME_FORFEIT (\S+)/.exec(g.error ?? '');
    const over = ['p1', 'p2'].map((s, i) => (g.timing?.[s]?.ms ?? 0) > roster.thinkCapMs || (tf !== null && tf[1] === [g.p1, g.p2][i]));
    if (over[0] && over[1]) {
        return { score: null, forfeit: [true, true] };
    }
    if (over[0] || over[1]) {
        return { score: over[0] ? 0 : 1, forfeit: over };
    }
    if (g.outcome !== 'won') {
        return { score: null, forfeit: over };
    }
    return { score: g.winner === 'draw' ? 0.5 : g.winner === g.p1 ? 1 : g.winner === g.p2 ? 0 : null, forfeit: over };
}

/** The SUBMISSION.json note of a version. */
function noteOf(name) {
    return readJson(path.join(HOME, 'versions', name, 'SUBMISSION.json'), {}).note ?? null;
}

/** Bradley-Terry over the given results with the baselines' mean pinned to 1500. */
function anchoredBT(names, results) {
    const bt = bradleyTerry(names, results);
    const bl = roster.baselines.filter((b) => names.includes(b));
    const shift = bl.length ? 1500 - bl.reduce((s, b) => s + bt[b], 0) / bl.length : 0;
    return Object.fromEntries(names.map((n) => [n, bt[n] + shift]));
}

function scoreRound(round, ladder) {
    const names = ladder.config.bots;
    const results = [];
    const rows = Object.fromEntries(names.map((n) => [n, { name: n, agent: agentOf(n), wins: 0, losses: 0, draws: 0, unfinished: 0, forfeits: 0, thinkMs: 0, decisions: 0, p95: 0, vs: {}, lost: [] }]));
    for (const g of ladder.games.filter((x) => x.outcome !== 'running')) {
        const { score, forfeit } = cappedScore(g);
        [g.p1, g.p2].forEach((n, i) => {
            const r = rows[n];
            const seat = i ? 'p2' : 'p1';
            const opp = i ? g.p1 : g.p2;
            const t = g.timing?.[seat];
            if (t) {
                r.thinkMs += t.ms;
                r.decisions += t.n;
                r.p95 = Math.max(r.p95, t.p95);
            }
            if (forfeit[i]) {
                r.forfeits++;
            }
            const vs = (r.vs[opp] ??= { w: 0, l: 0, d: 0, u: 0 });
            const my = score === null ? null : i ? 1 - score : score;
            if (my === null) {
                r.unfinished++;
                vs.u++;
            } else if (my === 0.5) {
                r.draws++;
                vs.d++;
            } else if (my === 1) {
                r.wins++;
                vs.w++;
            } else {
                r.losses++;
                vs.l++;
                r.lost.push({ id: g.id, seat, opp, rounds: g.rounds, forfeit: forfeit[i], outcome: g.outcome, replay: path.join(RESULTS, ladder.id, 'games', `${g.id}.jsonl`) });
            }
        });
        if (score !== null) {
            results.push({ a: g.p1, b: g.p2, score });
        }
    }
    const elo = anchoredBT(names, results);
    const bots = names.map((n) => {
        const r = rows[n];
        const decided = r.wins + r.losses + r.draws;
        return { ...r, btElo: Math.round(elo[n]), winRate: decided ? +((r.wins + r.draws / 2) / decided).toFixed(3) : null,
                 msPerDecision: r.decisions ? +(r.thinkMs / r.decisions).toFixed(1) : null, thinkMs: Math.round(r.thinkMs), idea: r.agent ? noteOf(n) : null };
    }).sort((x, y) => y.btElo - x.btElo);
    bots.forEach((b, i) => (b.rank = i + 1));
    const finished = ladder.games.filter((x) => x.outcome !== 'running').length;
    return { round, ladderId: ladder.id, seed: ladder.config.firstSeed, gamesPerPair: ladder.config.gamesPerPair, games: finished, scheduled: ladder.progress.scheduled,
             status: ladder.status === 'done' ? 'done' : 'running', leader: bots.find((b) => b.agent)?.name ?? null, bots, results };
}

function globalElo(rounds) {
    const names = [...new Set(rounds.flatMap((rd) => rd.bots.map((b) => b.name)))];
    return Object.fromEntries(Object.entries(anchoredBT(names, rounds.flatMap((rd) => rd.results))).map(([k, v]) => [k, Math.round(v)]));
}

function report(rd, g) {
    const L = [`# Arena round ${rd.round} results`, '', `Ladder \`${rd.ladderId}\`: ${rd.games}/${rd.scheduled} games, ${rd.gamesPerPair} per pair (seeds from ${rd.seed}, each from both seats). Status: ${rd.status}.`,
        `Elo = Bradley-Terry, baselines' mean pinned to 1500. "All rounds" rates every game played so far, so it compares across rounds. Time cap: ${roster.thinkCapMs / 1000}s of thinking per game, over it the game is a loss.`, '',
        '| # | bot | Elo (round) | Elo (all rounds) | W-L-D | win % | ms/decision | forfeits |', '|---|---|---|---|---|---|---|---|'];
    for (const b of rd.bots) {
        L.push(`| ${b.rank} | ${b.name} | ${b.btElo} | ${g[b.name] ?? '-'} | ${b.wins}-${b.losses}-${b.draws} | ${b.winRate === null ? '-' : Math.round(b.winRate * 100)} | ${b.msPerDecision ?? '-'} | ${b.forfeits} |`);
    }
    for (const b of rd.bots.filter((x) => x.agent)) {
        L.push('', `## ${b.agent} (${b.name})`, '', `Submission note: ${b.idea ?? '(none)'}`, '', 'Per opponent (W-L-D, unfinished):');
        for (const [o, v] of Object.entries(b.vs)) {
            L.push(`- vs ${o}: ${v.w}-${v.l}-${v.d}${v.u ? `, ${v.u} unfinished` : ''}`);
        }
        if (b.lost.length) {
            L.push('', 'Lost games (replays are JSON Lines: header, step..., end; see /mnt/project-files/spec/replay-format.md):');
            for (const x of b.lost) {
                L.push(`- ${x.id} as ${x.seat} vs ${x.opp}, ${x.rounds} rounds${x.forfeit ? ', TIME FORFEIT' : ''}: ${x.replay}`);
            }
        }
    }
    return L.join('\n') + '\n';
}

function publish(round) {
    const ladderFile = path.join(RESULTS, `arena-r${round}`, 'ladder.json');
    if (!fs.existsSync(ladderFile)) {
        return null;
    }
    const ladder = JSON.parse(fs.readFileSync(ladderFile, 'utf8'));
    const st = readJson(STANDINGS, { schema: 'swu-arena/1', startedAt: new Date().toISOString(), rounds: [] });
    const rd = scoreRound(round, ladder);
    st.rounds = [...st.rounds.filter((x) => x.round !== round), rd].sort((a, b) => a.round - b.round);
    st.global = globalElo(st.rounds);
    st.updatedAt = new Date().toISOString();
    st.status = 'running';
    st.now = rd.status === 'done' ? `Round ${round} done, ${rd.leader} leads` : `Round ${round} running: ${rd.games}/${rd.scheduled} games`;
    fs.mkdirSync(path.join(HOME, 'rounds'), { recursive: true });
    writeJson(STANDINGS, st);
    fs.writeFileSync(path.join(HOME, 'rounds', `r${round}.md`), report(rd, st.global));
    dash.publishStandings(st);
    return rd;
}

/** Newest version of every roster agent that has one, plus the baselines. */
function lineup() {
    roster = loadRoster();
    const agents = roster.agents.map((a) => ({ a: a.name, v: versionsOf(a.name).pop() })).filter((x) => x.v !== undefined).map((x) => `${x.a}-v${x.v}`);
    return [...agents, ...roster.baselines];
}

async function runRound(round, bots) {
    const args = [path.join(__dirname, '..', 'ladder.js'), '--bots', bots.join(','), '--games', arg('games', process.argv.includes('--tournament') ? '2' : '4'), '--seed', String(1000 * round + 101),
        '--id', `arena-r${round}`, '--out', RESULTS, '--workers', arg('workers', '3'), '--record'];
    console.log(`round ${round}: ${bots.join(', ')}`);
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    const tick = setInterval(() => publish(round), 30000);
    const code = await new Promise((resolve) => child.on('exit', resolve));
    clearInterval(tick);
    if (code !== 0) {
        throw new Error(`ladder exited with ${code}`);
    }
    const rd = publish(round);
    console.log(fs.readFileSync(path.join(HOME, 'rounds', `r${round}.md`), 'utf8').split('\n## ')[0]);
    return rd;
}

/** Plays the oldest queued eval, if any. Returns true when it played one. */
async function playQueuedEval() {
    const dir = path.join(HOME, 'queue');
    if (!fs.existsSync(dir)) {
        return false;
    }
    const jobs = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f), null)).filter((j) => j?.state === 'queued')
        .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
    const j = jobs[0];
    if (!j) {
        return false;
    }
    const file = path.join(dir, `${j.id}.json`);
    writeJson(file, { ...j, state: 'running', startedAt: new Date().toISOString() });
    try {
        const recDir = path.join(RESULTS, 'arena-evals', j.id);
        const summary = await runEval({ me: j.bot, opps: j.vs, seeds: j.seeds, first: 20001, workers: Number(arg('workers', '3')), recDir });
        writeJson(file, { ...j, state: 'done', finishedAt: new Date().toISOString(), summary });
    } catch (e) {
        writeJson(file, { ...j, state: 'failed', error: String(e.message || e) });
    }
    return true;
}

/** Clocked tournament: rounds of (work window, rated ladder), all competitors on the same clock. */
async function tournament() {
    const rounds = Number(arg('rounds', 3));
    const minutes = Number(arg('minutes', 60));
    const st = () => readJson(STANDINGS, { rounds: [] });
    const t = { id: arg('id', `arena-t${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`), title: arg('title', 'Arena tournament'), task: arg('task', null),
                plannedRounds: rounds, roundMinutes: minutes, gamesPerPair: Number(arg('games', '2')), state: 'running', startedAt: new Date().toISOString(), rounds: [] };
    const save = () => writeJson(TOURNAMENT(), t);
    for (let i = 0; i < rounds; i++) {
        const n = (st().rounds.map((r) => r.round).pop() ?? -1) + 1;
        const now = Date.now();
        const r = { n, workStart: new Date(now).toISOString(), workEnd: new Date(now + minutes * 60000).toISOString() };
        t.rounds.push(r);
        save();
        api.send({ to: 'all', from: 'referee', text: `Round ${n} (${i + 1} of ${rounds}) has started. Submit by ${r.workEnd} (${minutes} min); the referee then rates the newest version of every competitor.${t.task ? ' Task: ' + t.task : ''}` });
        console.log(`round ${n}: work until ${r.workEnd}`);
        while (Date.now() < Date.parse(r.workEnd)) {
            if (!(await playQueuedEval())) {
                await new Promise((res) => setTimeout(res, 10000));
            }
        }
        r.ladderStart = new Date().toISOString();
        save();
        await runRound(n, lineup());
        r.ladderEnd = new Date().toISOString();
        save();
    }
    t.state = 'done';
    t.endedAt = new Date().toISOString();
    save();
    api.send({ to: 'all', from: 'referee', text: `Tournament "${t.title}" is over. Final standings: arena_standings / arena_report.` });
}

async function main() {
    if (process.argv.includes('--tournament')) {
        await tournament();
        return;
    }
    const st = () => readJson(STANDINGS, { rounds: [] });
    const nextRound = () => (st().rounds.map((r) => r.round).pop() ?? -1) + 1;
    if (!process.argv.includes('--watch')) {
        await runRound(arg('round') !== undefined ? Number(arg('round')) : nextRound(), lineup());
        return;
    }
    const interval = Number(arg('interval', 600)) * 1000;
    const maxRounds = Number(arg('max-rounds', 10));
    for (let n = 0; n < maxRounds;) {
        const bots = lineup();
        const prev = st().rounds.slice(-1)[0];
        const prevBots = prev ? prev.bots.map((b) => b.name) : [];
        const changed = bots.filter((b) => !prevBots.includes(b));
        if (changed.length && bots.length > roster.baselines.length) {
            await runRound(nextRound(), bots);
            n++;
        } else {
            await new Promise((r) => setTimeout(r, interval));
        }
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e.message || e);
        process.exit(1);
    });
}

module.exports = { cappedScore, scoreRound, anchoredBT, lineup };
