'use strict';
/**
 * Arena referee: rates the newest submitted version of every competitor against each other and the baselines.
 *
 *   node bot/arena/referee.js [--round K] [--games 4] [--workers 3]           run one rated round now
 *   node bot/arena/referee.js --watch [--interval 600] [--max-rounds 10]       run a round whenever any agent has
 *                                                                              submitted a new version since the last one
 *
 * A round is a round robin (bot/ladder.js) of <agent>-v<latest> for every roster agent plus roster.baselines: --games per
 * pair, every seed from both seats, replays recorded to <results>/arena-r<K>/ (the dashboard follows the games live).
 * Round seeds and keys are secret until the ladder starts: they come from a 32-byte secret outside the arena folder
 * (roundSeed, roundKey; the key deals every game, rng.js).
 * Every bot plays under the same rules (ladder.js --cap-ms roster.thinkCapMs, --hang-ms 30 s more): a bot that thinks
 * more than the cap in a game, throws, answers wrong, hangs or fails to load loses it (the game is an ERROR with `by`
 * = its seat; cappedScore). Ratings are Bradley-Terry with the baselines' mean pinned to 1500, per round and
 * over all rounds (so versions compare across rounds). Writes, all in ARENA_HOME:
 *   standings.json     every round so far
 *   rounds/r<K>.md     what competitors read: standings, results per opponent, lost games with replay paths
 * plus the dashboard panels and experiment (dash.js), refreshed every 30 s while a round runs. While its ladder runs,
 * <results>/arena-r<K>/referee.lock holds the referee's pid: a second referee will not start a ladder there.
 *
 *   node bot/arena/referee.js --tournament --rounds 3 --minutes 60 [--games 2] [--title "..."] [--task "..."] [--resume | --force]
 * runs a clocked tournament: every round opens a work window of --minutes (all competitors start together; the API's
 * `wait` returns when it opens, and everyone's inbox gets a message), then rates the newest version of every competitor
 * submitted by the end of the window. During the window the referee also plays evals queued through the API (`eval`),
 * each in its own process (eval.js --job, --eval-workers, default --workers) that is stopped when the window ends, so
 * clients without the engine can test. Evals still queued when a window ends are dropped when the next one opens.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { bradleyTerry } = require('../ratings');
const { HOME, RESULTS, readJson, writeJson, roster: loadRoster, versionsOf } = require('./home');
const dash = require('./dash');
const { TOURNAMENT, notify } = require('./api');
const { resolveArena } = require('./registry');

const STANDINGS = path.join(HOME, 'standings.json');
const EVAL_JS = path.join(__dirname, 'eval.js');
const EVAL_MIN_LEFT_MS = 120000; // no queued eval starts with less of the work window left
const EVAL_TRIES = 2; // an eval stopped by the end of a window this often fails with reason 'deadline'
const LOCK_STALE_MS = 120000; // a lock from another host counts as abandoned once its heartbeat is this old

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

let roster = loadRoster();
const agentOf = (bot) => roster.agents.find((a) => bot === a.name || bot.startsWith(`${a.name}-v`))?.name ?? null;

/**
 * Score of a finished game for p1, or null (unrated). A game a bot broke (outcome ERROR, `by` = the seat whose bot
 * failed to load, threw, answered wrong, went over the time cap or hung) is that seat's loss. Otherwise only a
 * played-out game ('won') counts.
 */
function cappedScore(g) {
    const forfeit = [g.outcome === 'ERROR' && g.by === 'p1', g.outcome === 'ERROR' && g.by === 'p2'];
    if (forfeit[0] || forfeit[1]) {
        return { score: forfeit[0] ? 0 : 1, forfeit };
    }
    if (g.outcome !== 'won') {
        return { score: null, forfeit };
    }
    const seat = g.winnerSeat ?? (g.winner === 'draw' ? 'draw' : g.winner === g.p1 ? 'p1' : g.winner === g.p2 ? 'p2' : null);
    return { score: seat === 'draw' ? 0.5 : seat === 'p1' ? 1 : seat === 'p2' ? 0 : null, forfeit };
}

/** The secret behind the round seeds: ARENA_SECRET_FILE or ~/.arena-secret, outside the arena folder, created once. */
function loadSecret(file = process.env.ARENA_SECRET_FILE ?? path.join(os.homedir(), '.arena-secret')) {
    try {
        fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
    } catch (e) {
        if (e.code !== 'EEXIST') {
            throw e;
        }
    }
    const s = fs.readFileSync(file, 'utf8').trim();
    if (!s) {
        throw new Error(`${file} is empty; delete it and the referee makes a new secret`);
    }
    return s;
}

/** First ladder seed of round k of the tournament with this id ('watch' outside tournaments). */
function roundSeed(secret, id, k) {
    return parseInt(crypto.createHash('sha256').update(`${secret}:${id}:${k}`).digest('hex').slice(0, 8), 16);
}

/**
 * The run key (ladder.js --key, rng.js) of round k: every game's deal comes from it, so the hidden cards cannot be
 * rebuilt from the seed. The same for a resumed round; ladder.json has it (config.key) once the round is done.
 */
function roundKey(secret, id, k) {
    return crypto.createHash('sha256').update(`${secret}:key:${id}:${k}`).digest('hex').slice(0, 32);
}

/** The SUBMISSION.json of a version. */
const submissionOf = (name) => readJson(path.join(HOME, 'versions', name, 'SUBMISSION.json'), {});
const noteOf = (name) => submissionOf(name).note ?? null;

/** Bradley-Terry over the given results with the baselines' mean pinned to 1500. */
function anchoredBT(names, results) {
    const bt = bradleyTerry(names, results);
    const bl = roster.baselines.filter((b) => names.includes(b));
    const shift = bl.length ? 1500 - bl.reduce((s, b) => s + bt[b], 0) / bl.length : 0;
    return Object.fromEntries(names.map((n) => [n, bt[n] + shift]));
}

function scoreRound(round, ladder) {
    roster = loadRoster(); // competitors register while the referee runs
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
                r.lost.push({ id: g.id, seat, opp, rounds: g.rounds, forfeit: forfeit[i], faultKind: forfeit[i] ? g.faultKind ?? null : null, outcome: g.outcome,
                              replay: fs.existsSync(path.join(RESULTS, ladder.id, 'games', `${g.id}.jsonl`)) ? path.join(RESULTS, ladder.id, 'games', `${g.id}.jsonl`) : null });
            }
        });
        if (score !== null) {
            results.push({ a: g.p1, b: g.p2, score });
        }
    }
    // no rated game yet: no Elo, ranks or leader to show (Bradley-Terry would put everyone at the prior)
    const elo = results.length ? anchoredBT(names, results) : null;
    const bots = names.map((n) => {
        const r = rows[n];
        const decided = r.wins + r.losses + r.draws;
        return { ...r, btElo: elo ? Math.round(elo[n]) : null, winRate: decided ? +((r.wins + r.draws / 2) / decided).toFixed(3) : null,
                 msPerDecision: r.decisions ? +(r.thinkMs / r.decisions).toFixed(1) : null, thinkMs: Math.round(r.thinkMs), idea: r.agent ? noteOf(n) : null };
    });
    if (elo) {
        bots.sort((x, y) => y.btElo - x.btElo);
    }
    bots.forEach((b, i) => (b.rank = elo ? i + 1 : null));
    const finished = ladder.games.filter((x) => x.outcome !== 'running').length;
    return { round, ladderId: ladder.id, seed: ladder.config.firstSeed, gamesPerPair: ladder.config.gamesPerPair, games: finished, rated: results.length, scheduled: ladder.progress.scheduled,
             status: ladder.status === 'done' ? 'done' : 'running', leader: elo ? bots.find((b) => b.agent)?.name ?? null : null, bots, results };
}

/** All-round Elo of every bot with at least one rated game. */
function globalElo(rounds) {
    const results = rounds.flatMap((rd) => rd.results);
    const names = [...new Set(results.flatMap((x) => [x.a, x.b]))];
    return Object.fromEntries(Object.entries(anchoredBT(names, results)).map(([k, v]) => [k, Math.round(v)]));
}

function report(rd, g) {
    const cap = roster.thinkCapMs ? `${roster.thinkCapMs / 1000}s of thinking per game` : 'none';
    const L = [`# Arena round ${rd.round} results`, '', `Ladder \`${rd.ladderId}\`: ${rd.games}/${rd.scheduled} games, ${rd.gamesPerPair} per pair (seeds from ${rd.seed}, each from both seats). Status: ${rd.status}.`,
        `Elo = Bradley-Terry, baselines' mean pinned to 1500. "All rounds" rates every game played so far, so it compares across rounds. Time cap: ${cap}. A bot that goes over it, throws, hangs or fails to load forfeits the game (a loss).`, ''];
    if (!rd.bots.some((b) => b.rank !== null)) {
        L.push(`No rated games yet${rd.games ? ` (${rd.games} finished, none rated)` : ''}.`, '');
    }
    L.push('| # | bot | Elo (round) | Elo (all rounds) | W-L-D | win % | ms/decision | forfeits |', '|---|---|---|---|---|---|---|---|');
    for (const b of rd.bots) {
        L.push(`| ${b.rank ?? '-'} | ${b.name} | ${b.btElo ?? '-'} | ${g[b.name] ?? '-'} | ${b.wins}-${b.losses}-${b.draws} | ${b.winRate === null ? '-' : Math.round(b.winRate * 100)} | ${b.msPerDecision ?? '-'} | ${b.forfeits} |`);
    }
    for (const b of rd.bots.filter((x) => x.agent)) {
        L.push('', `## ${b.agent} (${b.name})`, '', `Submission note: ${b.idea ?? '(none)'}`, '', 'Per opponent (W-L-D, unfinished):');
        for (const [o, v] of Object.entries(b.vs)) {
            L.push(`- vs ${o}: ${v.w}-${v.l}-${v.d}${v.u ? `, ${v.u} unfinished` : ''}`);
        }
        if (b.lost.length) {
            L.push('', 'Lost games (replays are JSON Lines: header, step..., end; see /mnt/project-files/spec/replay-format.md):');
            for (const x of b.lost) {
                L.push(`- ${x.id} as ${x.seat} vs ${x.opp}, ${x.rounds} rounds${x.forfeit ? `, FORFEIT (${x.faultKind ?? 'fault'})` : ''}: ${x.replay ?? 'no replay (the bot did not load)'}`);
            }
        }
    }
    return L.join('\n') + '\n';
}

/** What standings.json says about the tournament in progress (progress on the dashboard). */
const tourInfo = (t) => (t ? { id: t.id, title: t.title, plannedRounds: t.plannedRounds, rounds: t.rounds.map((r) => r.n) } : null);

function publish(round, t = null) {
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
    st.tournament = tourInfo(t);
    const lead = rd.leader ? `${rd.leader} leads` : rd.rated ? 'no competitor rated' : 'no games yet';
    st.now = rd.status === 'done' ? `Round ${round} done, ${lead}` : `Round ${round} running: ${rd.games}/${rd.scheduled} games${rd.rated ? '' : ', no games yet'}`;
    fs.mkdirSync(path.join(HOME, 'rounds'), { recursive: true });
    writeJson(STANDINGS, st);
    fs.writeFileSync(path.join(HOME, 'rounds', `r${round}.md`), report(rd, st.global));
    dash.publishStandings(st);
    return rd;
}

/** Marks standings (and so the dashboard's leaderboard and experiment) done at the end of a tournament. */
function publishDone(t) {
    const st = readJson(STANDINGS, null);
    if (!st) {
        return;
    }
    const last = st.rounds[st.rounds.length - 1];
    st.status = 'done';
    st.tournament = tourInfo(t);
    st.updatedAt = new Date().toISOString();
    st.now = `Tournament "${t.title}" done${last ? `: after round ${last.round}, ${last.leader ? `${last.leader} leads` : 'no games yet'}` : ''}`;
    writeJson(STANDINGS, st);
    dash.publishStandings(st);
}

/**
 * Newest version of every roster agent that has one, plus the baselines. With a cutoff (ISO time) only versions
 * submitted at or before it count (versions without submittedAt always do); later ones wait for the next round.
 */
function lineup(cutoff = null) {
    roster = loadRoster();
    const until = cutoff ? Date.parse(cutoff) : Infinity;
    const agents = [];
    for (const a of roster.agents) {
        const all = versionsOf(a.name);
        const ok = all.filter((v) => !(Date.parse(submissionOf(`${a.name}-v${v}`).submittedAt) > until));
        if (ok.length < all.length) {
            console.log(`${a.name}: ${all.filter((v) => !ok.includes(v)).map((v) => `v${v}`).join(', ')} came in after ${cutoff}, rated next round`);
        }
        // newest version that the registry can resolve (a folder without bot.js would stop the ladder)
        const v = [...ok].reverse().find((n) => resolveArena(`${a.name}-v${n}`));
        if (v !== undefined) {
            agents.push(`${a.name}-v${v}`);
        }
        if (ok.length && v !== ok[ok.length - 1]) {
            console.log(`${a.name}: v${ok[ok.length - 1]} cannot be loaded (no bot.js), using ${v === undefined ? 'nothing' : `v${v}`}`);
        }
    }
    return [...agents, ...roster.baselines];
}

// child processes (ladder, evals) die with the referee
const children = new Set();
let lockFile = null;

function track(child) {
    children.add(child);
    child.on('exit', () => children.delete(child));
    return child;
}

function cleanup() {
    for (const c of children) {
        try {
            c.kill('SIGTERM');
        } catch {
            // already gone
        }
    }
    releaseLock();
}

function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM';
    }
}

/** Takes <dir>/referee.lock, or throws while another live referee holds it. */
function takeLock(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'referee.lock');
    for (let attempt = 0; ; attempt++) {
        try {
            fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() }), { flag: 'wx' });
            lockFile = file;
            return;
        } catch (e) {
            if (e.code !== 'EEXIST' || attempt > 0) {
                throw e.code === 'EEXIST' ? new Error(`${file}: another referee took this ladder at the same time`) : e;
            }
        }
        let held = null;
        let age = Infinity;
        try {
            held = JSON.parse(fs.readFileSync(file, 'utf8'));
            age = Date.now() - fs.statSync(file).mtimeMs;
        } catch {
            // unreadable: treat as abandoned
        }
        // on this host the pids say (the ladder's too: it outlives a referee killed with SIGKILL); from another host (a
        // shared folder) the heartbeat does, as the 30 s tick touches the file
        const alive = !held ? false : held.host === os.hostname()
            ? (held.pid !== process.pid && pidAlive(held.pid)) || (!!held.ladderPid && pidAlive(held.ladderPid))
            : age < LOCK_STALE_MS;
        if (alive) {
            throw new Error(`a referee (pid ${held.pid}${held.ladderPid ? `, ladder pid ${held.ladderPid}` : ''} on ${held.host}) is running the ladder in ${dir}; stop it first (or delete ${file} if it is gone)`);
        }
        fs.rmSync(file, { force: true });
    }
}

/** Adds the ladder's pid to the lock. */
function lockLadder(pid) {
    if (lockFile) {
        writeJson(lockFile, { ...readJson(lockFile, {}), ladderPid: pid });
    }
}

function touchLock() {
    if (lockFile) {
        const now = new Date();
        fs.utimesSync(lockFile, now, now);
    }
}

function releaseLock() {
    if (lockFile) {
        fs.rmSync(lockFile, { force: true });
        lockFile = null;
    }
}

async function runRound(round, bots, { games = Number(arg('games', 4)), seed, key, t = null } = {}) {
    const dir = path.join(RESULTS, `arena-r${round}`);
    const cap = Number(roster.thinkCapMs);
    const limits = Number.isFinite(cap) && cap > 0 ? ['--cap-ms', String(cap), '--hang-ms', String(cap + 30000)] : [];
    const args = [path.join(__dirname, '..', 'ladder.js'), '--bots', bots.join(','), '--games', String(games), '--seed', String(seed), '--key', key,
        '--id', `arena-r${round}`, '--out', RESULTS, '--workers', arg('workers', '3'), ...limits, '--record', '--resume'];
    takeLock(dir);
    console.log(`round ${round}: ${bots.join(', ')}`);
    let code;
    const tick = setInterval(() => {
        try {
            touchLock();
            publish(round, t);
        } catch (e) {
            console.error(`round ${round}: publishing failed (${e.message}); retrying in 30 s`);
        }
    }, 30000);
    try {
        const child = track(spawn(process.execPath, args, { stdio: 'inherit' }));
        lockLadder(child.pid);
        code = await new Promise((resolve) => {
            child.on('exit', (c, sig) => resolve(c ?? sig));
            child.on('error', (e) => resolve(e.message));
        });
    } finally {
        clearInterval(tick);
        releaseLock();
    }
    if (code !== 0) {
        throw new Error(`ladder exited with ${code}`);
    }
    const rd = publish(round, t);
    console.log(fs.readFileSync(path.join(HOME, 'rounds', `r${round}.md`), 'utf8').split('\n## ')[0]);
    return rd;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const queueDir = () => path.join(HOME, 'queue');

/** Evals a stopped referee left 'running' go back to the queue. */
function requeueRunning() {
    const dir = queueDir();
    if (!fs.existsSync(dir)) {
        return;
    }
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
        const j = readJson(path.join(dir, f), null);
        if (j?.state === 'running') {
            writeJson(path.join(dir, f), { ...j, state: 'queued', requeuedAt: new Date().toISOString() });
            console.log(`eval ${j.id}: back in the queue (the referee stopped while it ran)`);
        }
    }
}

/**
 * Plays the oldest queued eval in a child process (eval.js --job), stopped at `deadline` (ms): a stopped eval goes back
 * to the queue, or fails with reason 'deadline' once it has been stopped EVAL_TRIES times. Returns true when it ran one.
 */
async function playQueuedEval(deadline, minLeftMs = EVAL_MIN_LEFT_MS) {
    const dir = queueDir();
    if (!fs.existsSync(dir) || deadline - Date.now() < minLeftMs) {
        return false;
    }
    const jobs = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f), null)).filter((j) => j?.state === 'queued')
        .sort((a, b) => String(a.queuedAt).localeCompare(String(b.queuedAt)));
    const j = jobs[0];
    if (!j) {
        return false;
    }
    const file = path.join(dir, `${j.id}.json`);
    const tries = (j.tries ?? 0) + 1;
    writeJson(file, { ...j, state: 'running', startedAt: new Date().toISOString(), tries });
    console.log(`eval ${j.id}: ${j.bot} vs ${j.vs.join(', ')} (try ${tries})`);
    const child = track(spawn(process.execPath, [EVAL_JS, '--job', file, '--workers', arg('eval-workers', arg('workers', '3'))], { stdio: ['ignore', 'inherit', 'inherit'] }));
    let stopped = false;
    const timer = setTimeout(() => {
        stopped = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, Math.max(0, deadline - Date.now()));
    const code = await new Promise((resolve) => {
        child.on('exit', (c, sig) => resolve(c ?? sig));
        child.on('error', (e) => resolve(e.message));
    });
    clearTimeout(timer);
    const after = readJson(file, null);
    if (after?.state === 'running') {
        const t = new Date().toISOString();
        if (!stopped) {
            writeJson(file, { ...after, state: 'failed', finishedAt: t, error: `eval process exited with ${code}` });
        } else if (tries >= EVAL_TRIES) {
            writeJson(file, { ...after, state: 'failed', reason: 'deadline', finishedAt: t, error: `stopped at the end of a work window ${tries} times` });
        } else {
            writeJson(file, { ...after, state: 'queued', requeuedAt: t });
        }
        console.log(`eval ${j.id}: ${stopped ? 'stopped at the end of the work window' : `exited with ${code}`}`);
    }
    return true;
}

/** Evals queued before `since` (ISO) and still waiting fail with reason 'window over': each window starts afresh. */
function expireQueued(since) {
    const dir = queueDir();
    if (!fs.existsSync(dir)) {
        return;
    }
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
        const j = readJson(path.join(dir, f), null);
        // queued in an earlier window; one queued in this window already (a client saw it open first) stays
        if (j?.state === 'queued' && String(j.queuedAt) < since) {
            writeJson(path.join(dir, f), { ...j, state: 'failed', reason: 'window over', finishedAt: new Date().toISOString(), error: 'the work window it was queued in ended before it was played' });
        }
    }
}

/** A message to every competitor's inbox; a failed write is logged, it does not stop the tournament. */
function broadcast(text) {
    try {
        notify({ to: 'all', from: 'referee', text });
    } catch (e) {
        console.error(`could not message the competitors: ${e.message}`);
    }
}

/** tournament.json for --resume: throws when it is missing or does not parse (never silently starts over). */
function readTournament() {
    let text;
    try {
        text = fs.readFileSync(TOURNAMENT(), 'utf8');
    } catch (e) {
        throw new Error(`--resume: cannot read ${TOURNAMENT()} (${e.code ?? e.message}); start a new tournament without --resume`);
    }
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error(`--resume: ${TOURNAMENT()} is not valid JSON (${e.message}); fix it by hand, or move it away and start a new tournament`);
    }
}

/**
 * Clocked tournament: rounds of (work window, rated ladder), all competitors on the same clock. Round numbers continue
 * from standings.json (a fresh arena starts at round 1). With --resume it picks up the tournament in tournament.json
 * where it stopped: it waits out the open work window, or replays the unfinished ladder (finished games are kept).
 */
async function tournament() {
    const st = () => readJson(STANDINGS, { rounds: [] });
    const secret = loadSecret();
    let t;
    if (process.argv.includes('--resume')) {
        t = readTournament();
        if (t?.state !== 'running') {
            throw new Error(`--resume: tournament ${t?.id ?? '?'} is ${t?.state ?? 'not running'}; start a new one without --resume`);
        }
        console.log(`resuming ${t.id}: ${t.rounds.length} of ${t.plannedRounds} rounds opened`);
    } else {
        const running = readJson(TOURNAMENT(), null);
        if (running?.state === 'running' && !process.argv.includes('--force')) {
            throw new Error(`tournament ${running.id} is still running: use --resume to continue it, or --force to replace it`);
        }
        const rounds = Number(arg('rounds', 3));
        t = { id: arg('id', `arena-t${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`), title: arg('title', 'Arena tournament'), task: arg('task', null),
              plannedRounds: rounds, roundMinutes: Number(arg('minutes', 60)), gamesPerPair: Number(arg('games', '2')), state: 'running', startedAt: new Date().toISOString(), rounds: [] };
    }
    requeueRunning();
    const save = () => writeJson(TOURNAMENT(), t);
    for (;;) {
        let r = t.rounds[t.rounds.length - 1];
        if (!r || r.ladderEnd) {
            if (t.rounds.length >= t.plannedRounds) {
                break;
            }
            const n = Math.max(r?.n ?? 0, st().rounds.map((x) => x.round).pop() ?? 0) + 1;
            const now = Date.now();
            r = { n, workStart: new Date(now).toISOString(), workEnd: new Date(now + t.roundMinutes * 60000).toISOString() };
            t.rounds.push(r);
            save();
            expireQueued(r.workStart);
            broadcast(`Round ${n} (${t.rounds.length} of ${t.plannedRounds}) has started. Submit by ${r.workEnd} (${t.roundMinutes} min); the referee then rates the newest version of every competitor submitted by then.${t.task ? ' Task: ' + t.task : ''}`);
        }
        console.log(`round ${r.n}: work until ${r.workEnd}`);
        const workEnd = Date.parse(r.workEnd);
        while (!r.ladderStart && Date.now() < workEnd) {
            if (!(await playQueuedEval(workEnd))) {
                await sleep(Math.max(0, Math.min(10000, workEnd - Date.now())));
            }
        }
        if (!r.ladderStart) {
            // the seed is drawn only now, so nobody can tune on it during the window; kept for --resume
            r.ladderStart = new Date().toISOString();
            r.bots = lineup(r.workEnd);
            r.seed = roundSeed(secret, t.id, r.n);
            save();
        }
        // a ladder started before seeds were kept in tournament.json resumes with the seed it was started with
        const seed = r.seed ?? readJson(path.join(RESULTS, `arena-r${r.n}`, 'ladder.json'), null)?.config?.firstSeed ?? roundSeed(secret, t.id, r.n);
        await runRound(r.n, r.bots ?? lineup(r.workEnd), { games: t.gamesPerPair, seed, key: roundKey(secret, t.id, r.n), t });
        r.ladderEnd = new Date().toISOString();
        save();
    }
    t.state = 'done';
    t.endedAt = new Date().toISOString();
    save();
    publishDone(t);
    broadcast(`Tournament "${t.title}" is over. Final standings: arena_standings / arena_report.`);
}

async function main() {
    process.on('exit', cleanup);
    for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
        process.on(sig, () => {
            console.error(`referee: ${sig}, stopping`);
            process.exit(code);
        });
    }
    if (process.argv.includes('--tournament')) {
        await tournament();
        return;
    }
    const st = () => readJson(STANDINGS, { rounds: [] });
    const nextRound = () => (st().rounds.map((r) => r.round).pop() ?? -1) + 1;
    const watchSeed = (k) => ({ seed: roundSeed(loadSecret(), 'watch', k), key: roundKey(loadSecret(), 'watch', k) });
    if (!process.argv.includes('--watch')) {
        const k = arg('round') !== undefined ? Number(arg('round')) : nextRound();
        await runRound(k, lineup(), watchSeed(k));
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
            const k = nextRound();
            await runRound(k, bots, watchSeed(k));
            n++;
        } else {
            await sleep(interval);
        }
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e.message || e);
        process.exit(1);
    });
}

module.exports = { cappedScore, scoreRound, anchoredBT, globalElo, lineup, roundSeed, roundKey, loadSecret, report, playQueuedEval, requeueRunning };
