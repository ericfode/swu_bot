'use strict';
/**
 * Arena referee: rates the newest submitted version of every competitor against each other and the baselines.
 *
 *   node bot/arena/referee.js [--round K] [--games 4] [--workers 3]           run one rated round now
 *   node bot/arena/referee.js --watch [--interval 600] [--max-rounds 10]       run a round whenever any agent has
 *                                                                              submitted a new version since the last one
 *
 * A round is a round robin (bot/ladder.js) of <agent>-v<latest> for every roster agent plus roster.baselines: --games per
 * pair, every seed from both seats, replays recorded to <results>/<ladder id>/ (the dashboard follows the games live). A
 * tournament's rounds are <tournament id>-r<K> (arena-t202610130610-r1), so a later tournament never reuses a folder;
 * rounds outside a tournament are arena-r<K>.
 * Round seeds and keys are secret until the ladder starts: they come from a 32-byte secret outside the arena folder
 * (roundSeed, roundKey; the key deals every game, rng.js).
 * Every bot plays under the same rules (ladder.js --cap-ms roster.thinkCapMs, --hang-ms 30 s past the 2x wall cap): a bot that thinks
 * more than the cap in a game, throws, answers wrong, hangs or fails to load loses it (the game is an ERROR with `by`
 * = its seat; cappedScore). Ratings are Bradley-Terry with the baselines' mean pinned to 1500, per round and
 * over all rounds (so versions compare across rounds). Writes, all in ARENA_HOME:
 *   standings.json     every round so far
 *   rounds/r<K>.md     what competitors read: standings, results per opponent, lost games with replay paths
 * plus the dashboard panels and experiment (dash.js), refreshed every 30 s while a round runs. While its ladder runs,
 * <results>/<ladder id>/referee.lock holds the referee's pid: a second referee will not start a ladder there.
 *
 *   node bot/arena/referee.js --tournament --rounds 3 --minutes 60 [--games 2] [--title "..."] [--task "..."] [--resume | --force]
 * runs a clocked tournament: every round opens a work window of --minutes (all competitors start together; the API's
 * `wait` returns when it opens, and everyone's inbox gets a message), then rates the newest version of every competitor
 * submitted by the end of the window. During the window the referee also plays evals queued through the API (`eval`),
 * each in its own process (eval.js --job, --eval-workers, default --workers) that is stopped when the window ends, so
 * clients without the engine can test. Evals still queued when a window ends are dropped when the next one opens.
 *
 * Custom rules (Eric, 2026-10-11). --holdout <fraction> (e.g. 0.3) makes a card-pool holdout tournament: at the start
 * the referee splits the cards (cardpool.js, seeded from the secret) into ARENA_HOME/rules/<tournament id>/train.json
 * and holdout.json. Every work round's ladder and every eval deals decks from the training cards only. After the last
 * round, one more ladder (kind 'holdout', no work window) plays the same versions on decks dealt only from the held-out
 * cards, and its report compares each bot's rank on the two pools. Held-out rounds stay out of the all-round Elo.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { bradleyTerry } = require('../ratings');
const { HOME, RESULTS, PUBLIC_RESULTS, readJson, writeJson, roster: loadRoster, versionsOf } = require('./home');
const dash = require('./dash');
const { TOURNAMENT, notify } = require('./api');
const { resolveArena } = require('./registry');
const { splitPool, writePools, loadPool, checkPool } = require('../cardpool');

const STANDINGS = path.join(HOME, 'standings.json');
const EVAL_JS = path.join(__dirname, 'eval.js');
const EVAL_MIN_LEFT_MS = 120000; // no queued eval starts with less of the work window left
const EVAL_TRIES = 2; // an eval stopped by the end of a window this often fails with reason 'deadline'
const LOCK_STALE_MS = 120000; // a lock from another host counts as abandoned once its heartbeat is this old
// from another PID namespace on this host (a referee restarted by launch.sh): two and a half 30 s heartbeats, so the
// keeper's restart after a crash does not wait out the full two minutes
const LOCK_STALE_NS_MS = 75000;

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

let roster = loadRoster();
// benched competitors too: one withdrawn while its last round's ladder runs still owns that round's games
const agentOf = (bot) => [...roster.agents, ...(roster.bench ?? [])].find((a) => bot === a.name || bot.startsWith(`${a.name}-v`))?.name ?? null;

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
                              replay: fs.existsSync(path.join(RESULTS, ladder.id, 'games', `${g.id}.jsonl`)) ? path.join(PUBLIC_RESULTS, ladder.id, 'games', `${g.id}.jsonl`) : null });
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
    return { round, ladderId: ladder.id, ...(ladder.config.pool ? { pool: ladder.config.pool.kind, poolCards: ladder.config.pool.cards } : {}),
             seed: ladder.config.firstSeed, gamesPerPair: ladder.config.gamesPerPair, games: finished, rated: results.length, scheduled: ladder.progress.scheduled,
             status: ladder.status === 'done' ? 'done' : 'running', leader: elo ? bots.find((b) => b.agent)?.name ?? null : null, bots, results };
}

/** All-round Elo of every bot with at least one rated game. Held-out rounds (another card pool) are left out. */
function globalElo(rounds) {
    const results = rounds.filter((rd) => rd.pool !== 'holdout').flatMap((rd) => rd.results);
    const names = [...new Set(results.flatMap((x) => [x.a, x.b]))];
    return Object.fromEntries(Object.entries(anchoredBT(names, results)).map(([k, v]) => [k, Math.round(v)]));
}

/** Spearman rank correlation of two rankings ({name: rank}) over the names both have; null with fewer than 3. */
function rankCorrelation(a, b) {
    const names = Object.keys(a).filter((n) => a[n] !== null && b[n] !== null && b[n] !== undefined);
    if (names.length < 3) {
        return null;
    }
    // re-rank within the common names, so a bot missing from one side does not leave a gap
    const rerank = (r) => Object.fromEntries([...names].sort((x, y) => r[x] - r[y]).map((n, i) => [n, i + 1]));
    const ra = rerank(a);
    const rb = rerank(b);
    const d2 = names.reduce((s, n) => s + (ra[n] - rb[n]) ** 2, 0);
    const n = names.length;
    return +(1 - (6 * d2) / (n * (n * n - 1))).toFixed(3);
}

/** The held-out section of a report: each bot's rank and Elo on the training cards (round cmp) and on the held-out ones. */
function holdoutSection(rd, cmp) {
    const rank = (r) => Object.fromEntries(r.bots.map((b) => [b.name, b.rank]));
    const elo = (r) => Object.fromEntries(r.bots.map((b) => [b.name, b.btElo]));
    const [trainRank, testRank, trainElo, testElo] = [rank(cmp), rank(rd), elo(cmp), elo(rd)];
    const rho = rankCorrelation(trainRank, testRank);
    const L = ['', '## Held-out cards vs training cards', '',
        `The same versions on round ${cmp.round}'s training cards and on the held-out cards. Spearman rank correlation: ${rho ?? '- (fewer than 3 rated bots)'}${rho === null ? '' : ' (1 = the same order, 0 = unrelated, -1 = reversed)'}.`, '',
        `| bot | rank, training (round ${cmp.round}) | rank, held-out | Elo, training | Elo, held-out | Elo change |`, '|---|---|---|---|---|---|'];
    for (const b of rd.bots) {
        const change = trainElo[b.name] !== null && trainElo[b.name] !== undefined && testElo[b.name] !== null ? testElo[b.name] - trainElo[b.name] : null;
        L.push(`| ${b.name} | ${trainRank[b.name] ?? '-'} | ${testRank[b.name] ?? '-'} | ${trainElo[b.name] ?? '-'} | ${testElo[b.name] ?? '-'} | ${change === null ? '-' : (change > 0 ? '+' : '') + change} |`);
    }
    return L;
}

function report(rd, g, cmp = null) {
    const cap = roster.thinkCapMs ? `${roster.thinkCapMs / 1000}s of thinking per game` : 'none';
    const cards = rd.pool === 'holdout' ? `Cards: decks dealt only from the held-out pool (${rd.poolCards} cards: the leaders and main-deck cards no competitor practised with, plus every base). This round is left out of the all-round Elo.`
        : rd.pool === 'train' ? `Cards: decks dealt only from this tournament's training pool (${rd.poolCards} cards, every base included).` : null;
    const L = [`# Arena round ${rd.round} results${rd.pool === 'holdout' ? ' (held-out cards)' : ''}`, '', `Ladder \`${rd.ladderId}\`: ${rd.games}/${rd.scheduled} games, ${rd.gamesPerPair} per pair (seeds from ${rd.seed}, each from both seats). Status: ${rd.status}.`,
        ...(cards ? [cards] : []),
        `Elo = Bradley-Terry, baselines' mean pinned to 1500. "All rounds" rates every game played so far, so it compares across rounds. Time cap: ${cap}. A bot that goes over it, throws, hangs or fails to load forfeits the game (a loss).`, ''];
    if (!rd.bots.some((b) => b.rank !== null)) {
        L.push(`No rated games yet${rd.games ? ` (${rd.games} finished, none rated)` : ''}.`, '');
    }
    L.push('| # | bot | Elo (round) | Elo (all rounds) | W-L-D | win % | ms/decision | forfeits |', '|---|---|---|---|---|---|---|---|');
    for (const b of rd.bots) {
        L.push(`| ${b.rank ?? '-'} | ${b.name} | ${b.btElo ?? '-'} | ${g[b.name] ?? '-'} | ${b.wins}-${b.losses}-${b.draws} | ${b.winRate === null ? '-' : Math.round(b.winRate * 100)} | ${b.msPerDecision ?? '-'} | ${b.forfeits} |`);
    }
    if (rd.pool === 'holdout' && cmp) {
        L.push(...holdoutSection(rd, cmp));
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

/**
 * A round's ladder id, which is also its folder in <results>: scoped to the tournament (its id plus -r<K>, with the
 * arena- prefix every arena run carries), so rounds of different tournaments never share a folder.
 */
function ladderIdOf(round, t = null) {
    if (!t) {
        return `arena-r${round}`;
    }
    return `${t.id.startsWith('arena-') ? '' : 'arena-'}${t.id}-r${round}`;
}

/** What standings.json says about the tournament in progress (progress on the dashboard). */
// rounds lists the work rounds (plannedRounds counts those); a holdout tournament's extra ladder is holdoutRound
const tourInfo = (t) => (t ? { id: t.id, title: t.title, plannedRounds: t.plannedRounds, rounds: t.rounds.filter((r) => r.kind !== 'holdout').map((r) => r.n),
                                ...(t.rules ? { rules: rulesInfo(t.rules) } : {}), ...(t.rounds.some((r) => r.kind === 'holdout') ? { holdoutRound: t.rounds.find((r) => r.kind === 'holdout').n } : {}) } : null);

/** The public summary of a tournament's rules (standings, the API clock and the brief show it). */
function rulesInfo(rules) {
    const h = rules?.holdout;
    return h ? { holdout: { fraction: h.fraction, train: h.train, trainCards: h.counts?.train ?? null, holdoutCards: h.counts?.holdout ?? null } } : {};
}

function publish(round, t = null, id = ladderIdOf(round, t)) {
    const ladderFile = path.join(RESULTS, id, 'ladder.json');
    if (!fs.existsSync(ladderFile)) {
        return null;
    }
    const ladder = JSON.parse(fs.readFileSync(ladderFile, 'utf8'));
    const st = readJson(STANDINGS, { schema: 'swu-arena/1', startedAt: new Date().toISOString(), rounds: [] });
    const rd = scoreRound(round, ladder);
    st.rounds = [...st.rounds.filter((x) => x.round !== round), rd].sort((a, b) => a.round - b.round);
    // a held-out round is compared with the last round played on the training cards
    const cmp = rd.pool === 'holdout' ? st.rounds.filter((x) => x.round < round && x.pool !== 'holdout').pop() ?? null : null;
    st.global = globalElo(st.rounds);
    st.updatedAt = new Date().toISOString();
    st.status = 'running';
    st.tournament = tourInfo(t);
    const lead = rd.leader ? `${rd.leader} leads` : rd.rated ? 'no competitor rated' : 'no games yet';
    st.now = rd.status === 'done' ? `Round ${round} done, ${lead}` : `Round ${round} running: ${rd.games}/${rd.scheduled} games${rd.rated ? '' : ', no games yet'}`;
    fs.mkdirSync(path.join(HOME, 'rounds'), { recursive: true });
    writeJson(STANDINGS, st);
    fs.writeFileSync(path.join(HOME, 'rounds', `r${round}.md`), report(rd, st.global, cmp));
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
        // versions the owner withdrew (api.js withdraw) are not rated
        const all = versionsOf(a.name).filter((v) => !(a.withdrawn ?? []).includes(v));
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

/**
 * An earlier round's bots minus the versions benched or withdrawn since (api.js withdraw), for a ladder that replays
 * that lineup (the held-out ladder). Baselines stay; a withdrawn version is dropped, not swapped for an older one, so
 * the held-out ranks still compare the versions the training ladder rated.
 */
function stillIn(bots) {
    roster = loadRoster();
    return bots.filter((b) => {
        const v = /^([a-z][a-z0-9_]*)-v(\d+)$/.exec(b);
        if (!v || roster.baselines.includes(b)) {
            return true;
        }
        const a = roster.agents.find((x) => x.name === v[1]);
        if (a && !(a.withdrawn ?? []).includes(Number(v[2]))) {
            return true;
        }
        console.log(`${b}: ${a ? 'withdrawn' : 'benched'} by its owner, sits out`);
        return false;
    });
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

// which PID namespace this process is in (launch.sh starts the referee in its own, isolate.sh): pids mean something
// only inside one
const PIDNS = (() => {
    try {
        return fs.readlinkSync('/proc/self/ns/pid');
    } catch {
        return null;
    }
})();

// Bot code runs in the ladders and evals the referee starts. When the referee runs as root (launch.sh, in its own
// namespace), they run as ARENA_BOT_USER with no capabilities: a bot then cannot undo the namespace's hiding, and cannot
// read the round-seed secret, which stays root's (a bot running as the referee's own user could read its file, its
// environment or its memory). Neither ever gets the secret's path.
/** [uid, gid] of ARENA_BOT_USER when the referee runs as root, else null. */
function botUser() {
    const name = process.getuid?.() === 0 ? process.env.ARENA_BOT_USER : null;
    return name ? ['-u', '-g'].map((f) => Number(execFileSync('id', [f, name], { encoding: 'utf8' }))) : null;
}

/** Starts `node args...` for bot code: as ARENA_BOT_USER when set, and without the secret's path in its environment. */
function spawnBots(args, opts) {
    const env = { ...process.env };
    delete env.ARENA_SECRET_FILE;
    delete env.ARENA_BOT_USER;
    const ids = botUser();
    if (!ids) {
        return spawn(process.execPath, args, { ...opts, env });
    }
    return spawn('setpriv', [`--reuid=${ids[0]}`, `--regid=${ids[1]}`, '--clear-groups', '--inh-caps=-all', '--bounding-set=-all', '--no-new-privs',
        '--', process.execPath, ...args], { ...opts, env });
}

/** A folder the referee made that bot code writes into (a round's ladder folder) belongs to ARENA_BOT_USER. */
function giveToBots(dir) {
    const ids = botUser();
    if (ids) {
        fs.chownSync(dir, ids[0], ids[1]);
    }
}

/** Takes <dir>/referee.lock, or throws while another live referee holds it. */
function takeLock(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'referee.lock');
    for (let attempt = 0; ; attempt++) {
        try {
            fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: os.hostname(), pidns: PIDNS, startedAt: new Date().toISOString() }), { flag: 'wx' });
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
        // on this host and in this PID namespace the pids say (the ladder's too: it outlives a referee killed with
        // SIGKILL); from another host (a shared folder) or namespace the heartbeat does, as the 30 s tick touches the file
        const here = held?.host === os.hostname();
        const alive = !held ? false : here && (held.pidns ?? null) === PIDNS
            ? (held.pid !== process.pid && pidAlive(held.pid)) || (!!held.ladderPid && pidAlive(held.ladderPid))
            : age < (here ? LOCK_STALE_NS_MS : LOCK_STALE_MS);
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

async function runRound(round, bots, { games = Number(arg('games', 4)), seed, key, t = null, id = ladderIdOf(round, t), pool = null } = {}) {
    const dir = path.join(RESULTS, id);
    const cap = Number(roster.thinkCapMs);
    // the watchdog waits 30 s past the wall cap (guard.js: 2 x cap), so a call the guard allows is never taken for a hang
    const limits = Number.isFinite(cap) && cap > 0 ? ['--cap-ms', String(cap), '--hang-ms', String(2 * cap + 30000)] : [];
    const args = [path.join(__dirname, '..', 'ladder.js'), '--bots', bots.join(','), '--games', String(games), '--seed', String(seed), '--key', key,
        '--id', id, '--out', RESULTS, '--workers', arg('workers', '3'), ...limits, ...(pool ? ['--pool', pool] : []), '--record', '--resume'];
    takeLock(dir);
    giveToBots(dir);
    console.log(`round ${round}: ${bots.join(', ')}`);
    let code;
    const tick = setInterval(() => {
        try {
            touchLock();
            publish(round, t, id);
        } catch (e) {
            console.error(`round ${round}: publishing failed (${e.message}); retrying in 30 s`);
        }
    }, 30000);
    try {
        const child = track(spawnBots(args, { stdio: 'inherit' }));
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
    const rd = publish(round, t, id);
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
    const child = track(spawnBots([EVAL_JS, '--job', file, '--workers', arg('eval-workers', arg('workers', '3'))], { stdio: ['ignore', 'inherit', 'inherit'] }));
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
 * The card split of a holdout tournament (--holdout): cardpool.js splits the cards the engine can play, seeded from the
 * secret, into ARENA_HOME/rules/<tournament id>/{train,holdout}.json, and both are checked to fill a deck for every
 * leader and base. Returns the rule kept in tournament.json (paths relative to ARENA_HOME). Counts leave out the bases,
 * which are in both pools.
 */
function makeHoldout(t, fraction, secret) {
    if (!(fraction > 0 && fraction < 1)) {
        throw new Error(`--holdout ${fraction}: the share of the cards to hold out, between 0 and 1 (e.g. 0.3)`);
    }
    const { Env } = require('../env');
    const env = new Env();
    const seed = crypto.createHash('sha256').update(`${secret}:${t.id}:holdout`).digest('hex');
    const rel = path.join('rules', t.id);
    const files = writePools(path.join(HOME, rel), splitPool(env.index(), { fraction, seed }), { fraction });
    for (const f of Object.values(files)) {
        checkPool(env, loadPool(f.path));
    }
    const playable = (c) => c.leaders + c.main;
    console.log(`holdout: ${playable(files.train.counts)} training cards, ${playable(files.holdout.counts)} held out (${fraction}), in ${path.join(HOME, rel)}`);
    return { fraction, train: path.join(rel, 'train.json'), holdout: path.join(rel, 'holdout.json'),
             counts: { train: playable(files.train.counts), holdout: playable(files.holdout.counts) }, sha256: { train: files.train.sha256, holdout: files.holdout.sha256 } };
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
        if (!/^[\w-]+$/.test(t.id)) {
            throw new Error(`--id ${JSON.stringify(t.id)}: letters, digits, _ and - only (it names the rounds' result folders)`);
        }
        if (arg('holdout') !== undefined) {
            t.rules = { holdout: makeHoldout(t, Number(arg('holdout')), secret) };
        }
    }
    requeueRunning();
    const save = () => writeJson(TOURNAMENT(), t);
    for (;;) {
        let r = t.rounds[t.rounds.length - 1];
        if (!r || r.ladderEnd) {
            const n = Math.max(r?.n ?? 0, st().rounds.map((x) => x.round).pop() ?? 0) + 1;
            if (t.rounds.filter((x) => x.kind !== 'holdout').length >= t.plannedRounds) {
                if (!t.rules?.holdout || t.rounds.some((x) => x.kind === 'holdout') || !r?.bots) {
                    break;
                }
                // the held-out ladder: no work window, the versions of the last round, decks from the held-out cards
                const last = r;
                const now = new Date().toISOString();
                r = { n, kind: 'holdout', ladder: ladderIdOf(n, t), workStart: now, workEnd: now, ladderStart: now, bots: stillIn(last.bots), seed: roundSeed(secret, t.id, n) };
                t.rounds.push(r);
                save();
                broadcast(`The work rounds are over. Last ladder (round ${n}): the versions rated in round ${last.n} play again on decks dealt only from the ${t.rules.holdout.counts.holdout} held-out cards. Its report compares every bot's rank on the training and the held-out cards.`);
            }
        }
        if (!r || r.ladderEnd) {
            const n = Math.max(r?.n ?? 0, st().rounds.map((x) => x.round).pop() ?? 0) + 1;
            const now = Date.now();
            r = { n, ladder: ladderIdOf(n, t), workStart: new Date(now).toISOString(), workEnd: new Date(now + t.roundMinutes * 60000).toISOString() };
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
        // a round opened before ladder ids were scoped to the tournament keeps its arena-r<K> folder
        const id = r.ladder ?? `arena-r${r.n}`;
        // a ladder started before seeds were kept in tournament.json resumes with the seed it was started with
        const seed = r.seed ?? readJson(path.join(RESULTS, id, 'ladder.json'), null)?.config?.firstSeed ?? roundSeed(secret, t.id, r.n);
        // a holdout tournament deals its work rounds from the training cards and its last ladder from the held-out ones
        const pool = t.rules?.holdout ? path.resolve(HOME, r.kind === 'holdout' ? t.rules.holdout.holdout : t.rules.holdout.train) : null;
        await runRound(r.n, r.bots ?? lineup(r.workEnd), { games: t.gamesPerPair, seed, key: roundKey(secret, t.id, r.n), t, id, pool });
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

module.exports = { cappedScore, scoreRound, anchoredBT, globalElo, lineup, stillIn, takeLock, releaseLock, roundSeed, roundKey, loadSecret, report, playQueuedEval, requeueRunning, ladderIdOf, rankCorrelation, spawnBots, giveToBots };
