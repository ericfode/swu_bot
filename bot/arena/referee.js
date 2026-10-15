'use strict';
/**
 * Arena referee: rates the newest submitted version of every competitor against each other and the baselines, one
 * round per run. The games machine no longer runs it (its server plays the rounds, server/src/games): there it is a
 * library for gamesctl.js (lineup, the deck lists, publish), and its main plays a round by hand (local rehearsals).
 *
 *   node bot/arena/referee.js [--round K] [--games 4] [--workers 3]           play rated round K (default: the next one)
 *
 * A round is a round robin (bot/ladder.js) of <agent>-v<latest> for every roster agent: --games per pair, every seed
 * from both seats, replays recorded to <results>/arena-r<K>/ (the dashboard follows the games live). Its games deal the
 * tournament deck lists (ROUND_DECKS), by seat: in the two games of a seed each bot plays both decks. The arena's own
 * bots play too: the resident entries (roster agents marked resident, submitted like any other), and the bots built
 * into the image that roster.baselines names until a resident replaces each (lineup).
 * Round K again resumes its ladder: the games already played are kept (ladder.js --resume).
 * Round seeds and keys are secret until the ladder starts: they come from a 32-byte secret outside the arena folder
 * (roundSeed, roundKey; the key deals every game, rng.js).
 * Every bot plays under the same rules (ladder.js --cap-ms roster.thinkCapMs, --hang-ms 30 s past the 2x wall cap): a bot that thinks
 * more than the cap in a game, throws, answers wrong, hangs or fails to load loses it (the game is an ERROR with `by`
 * = its seat; cappedScore). Ratings are Bradley-Terry with the mean of the arena's own bots (anchorsOf) pinned to 1500,
 * per round and over all rounds (so versions compare across rounds). Writes, all in ARENA_HOME:
 *   standings.json     every round so far
 *   rounds/r<K>.md     what competitors read: standings, results per opponent, lost games with replay paths
 * plus the dashboard panels and experiment (dash.js), refreshed every 30 s while a round runs. While its ladder runs,
 * <results>/<ladder id>/referee.lock holds the referee's pid: a second referee will not start a ladder there.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { bradleyTerry } = require('../ratings');
const { HOME, RESULTS, PUBLIC_RESULTS, readJson, writeJson, writeAtomic, roster: loadRoster, versionsOf, residentName } = require('./home');
const dash = require('./dash');
const { resolveArena } = require('./registry');

const STANDINGS = path.join(HOME, 'standings.json');
const LOCK_STALE_MS = 120000; // a lock from another host counts as abandoned once its heartbeat is this old
// from another PID namespace on this host (isolate.sh gives each referee run its own): two and a half 30 s heartbeats,
// so a restart after a crash does not wait out the full two minutes
const LOCK_STALE_NS_MS = 75000;
// the deck lists rated rounds deal (Eric, 2026-10-15: the tournament lists), by seat (decklists.js dealDecks), less the
// lists an engine bug ends too many games of (CLAUDE.md "Known engine bugs" 8: Barriss Offee ends 36% of Lando's)
const ROUND_DECKS = { file: path.join(__dirname, '..', 'decks', 'ash-meta-2026-09.json'), skip: ['lando-calrissian_law_blue'] };

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

let roster = loadRoster();
// benched competitors too: one withdrawn while its last round's ladder runs still owns that round's games
// a resident only by its versions' names (<name>-v<N>): a resident may share a name with the bot built into the image it
// replaces, and a built-in bot such as ismcts-vlinear-deck is no version of an entry named ismcts
const entryOf = (bot) => [...roster.agents, ...(roster.bench ?? [])].find((a) => (bot.startsWith(`${a.name}-v`) && /^\d+$/.test(bot.slice(a.name.length + 2))) || (bot === a.name && !a.resident)) ?? null;
/** The builder whose bot this is, or null for the arena's own bots (a resident entry, or a bot built into the image). */
const agentOf = (bot) => {
    const a = entryOf(bot);
    return a && !a.resident ? a.name : null;
};
/** The resident entry this bot is a version of, or null. */
const residentOf = (bot) => {
    const a = entryOf(bot);
    return a?.resident ? a.name : null;
};
/** The bots among `names` that anchor the ratings: the arena's own, resident entries and built-in baselines. */
const anchorsOf = (names) => names.filter((n) => roster.baselines.includes(n) || residentOf(n) !== null);

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

/**
 * First ladder seed of round k under id. Every round the referee plays uses the id 'watch' (main), so a resumed round
 * keeps its seed.
 */
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

/** Bradley-Terry over the given results with the mean of `anchors` (those among `names`) pinned to 1500. */
function anchoredBT(names, results, anchors = anchorsOf(names)) {
    const bt = bradleyTerry(names, results);
    const bl = anchors.filter((b) => names.includes(b));
    const shift = bl.length ? 1500 - bl.reduce((s, b) => s + bt[b], 0) / bl.length : 0;
    return Object.fromEntries(names.map((n) => [n, bt[n] + shift]));
}

function scoreRound(round, ladder) {
    roster = loadRoster(); // competitors register while the referee runs
    const names = ladder.config.bots;
    const results = [];
    const rows = Object.fromEntries(names.map((n) => [n, { name: n, agent: agentOf(n), ...(residentOf(n) ? { resident: residentOf(n) } : {}), wins: 0, losses: 0, draws: 0, unfinished: 0, forfeits: 0, thinkMs: 0, decisions: 0, p95: 0, vs: {}, lost: [] }]));
    // where the games ran: the games machine, or a helper computer by name (ladder.js host, remote-lane.js)
    const hosts = {};
    for (const g of ladder.games.filter((x) => x.outcome !== 'running')) {
        const { score, forfeit } = cappedScore(g);
        const h = (hosts[g.host ?? 'machine'] ??= { games: 0, decisions: 0, thinkMs: 0 });
        h.games++;
        for (const t of [g.timing?.p1, g.timing?.p2].filter(Boolean)) {
            h.decisions += t.n;
            h.thinkMs += t.ms;
        }
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
    const anchors = anchorsOf(names);
    const elo = results.length ? anchoredBT(names, results, anchors) : null;
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
    for (const h of Object.values(hosts)) {
        h.thinkMs = Math.round(h.thinkMs);
    }
    const decks = ladder.config.decks;
    return { round, ladderId: ladder.id, ...(ladder.config.pool ? { pool: ladder.config.pool.kind, poolCards: ladder.config.pool.cards } : {}),
             ...(decks ? { decks: { file: decks.file, sha256: decks.sha256, lists: decks.names.length, deal: decks.deal ?? 'bot' } } : {}),
             seed: ladder.config.firstSeed, gamesPerPair: ladder.config.gamesPerPair, games: finished, rated: results.length, scheduled: ladder.progress.scheduled,
             status: ladder.status === 'done' ? 'done' : 'running', leader: elo ? bots.find((b) => b.agent)?.name ?? null : null, anchors, bots, results, hosts,
             remote: ladder.remote ?? null };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The report's line on helper computers when the games machine offered this round to them (ladder.json remote, from
 * remote-lane.js), or null when the helper node is off. It says whether a helper said hello and claimed work, so a round
 * with no helper games shows why.
 */
function helpersLine(remote) {
    if (!remote || typeof remote !== 'object') {
        return null;
    }
    if (remote.lane === false) {
        return `Helpers: none this round (${remote.why}).`;
    }
    const hosts = Array.isArray(remote.hosts) ? remote.hosts : [];
    const parts = [hosts.length ? `${hosts.join(', ')} said hello` : 'no helper said hello to the games machine'];
    parts.push(`a claim waited at ${remote.claimLooks} of ${plural(remote.looks, 'look')}`);
    parts.push(`${plural(remote.leased, 'seed')} went out, ${plural(remote.played, 'game')} came back`);
    if (remote.lost) {
        parts.push(`${remote.lost} lost${remote.lastLost ? ` (last: ${remote.lastLost})` : ''}`);
    }
    if (remote.relayErrors?.length) {
        parts.push(`relay errors: ${remote.relayErrors.join(', ')}`);
    }
    if (remote.stopped) {
        parts.push(`the lane stopped: ${remote.stopped}`);
    }
    return `Helpers: ${parts.join('; ')}.`;
}

/**
 * All-round Elo of every bot with at least one rated game. Held-out rounds (the old holdout tournaments' last ladders,
 * on another card pool) are left out. The anchors stay the same as rounds go by, so a new version of a resident does not
 * move everyone's rating: the bots built into the image that ever played (rows with no builder and no resident entry),
 * which keep anchoring the old rounds once the image has none, else the first round's own bots.
 */
function globalElo(rounds) {
    const results = rounds.filter((rd) => rd.pool !== 'holdout').flatMap((rd) => rd.results);
    const names = [...new Set(results.flatMap((x) => [x.a, x.b]))];
    return Object.fromEntries(Object.entries(anchoredBT(names, results, allRoundAnchors(rounds, roster.baselines))).map(([k, v]) => [k, Math.round(v)]));
}

/** globalElo's anchors (app/src/model.cjs arenaHistory picks the same). */
function allRoundAnchors(rounds, baselines) {
    const builtIn = [...new Set([...baselines, ...rounds.flatMap((rd) => (rd.bots ?? []).filter((b) => !b.agent && !b.resident).map((b) => b.name))])];
    return builtIn.length ? builtIn : rounds.find((rd) => rd.anchors?.length)?.anchors ?? [];
}

function report(rd, g) {
    const cap = roster.thinkCapMs ? `${roster.thinkCapMs / 1000}s of thinking per game` : 'none';
    const decks = rd.decks ? `Decks: ${rd.decks.lists} tournament lists (\`${rd.decks.file}\`)${rd.decks.deal === 'seat' ? ', each seed\'s two decks played by both bots' : ''}.` : 'Decks: random.';
    const L = [`# Arena round ${rd.round} results`, '', `Ladder \`${rd.ladderId}\`: ${rd.games}/${rd.scheduled} games, ${rd.gamesPerPair} per pair (seeds from ${rd.seed}, each from both seats). ${decks} Status: ${rd.status}.`,
        `Elo = Bradley-Terry, the mean of the arena's own bots pinned to 1500. "All rounds" rates every game played so far, so it compares across rounds. Time cap: ${cap}. A bot that goes over it, throws, hangs or fails to load forfeits the game (a loss).`, ''];
    if (!rd.bots.some((b) => b.rank !== null)) {
        L.push(`No rated games yet${rd.games ? ` (${rd.games} finished, none rated)` : ''}.`, '');
    }
    L.push('| # | bot | Elo (round) | Elo (all rounds) | W-L-D | win % | ms/decision | forfeits |', '|---|---|---|---|---|---|---|---|');
    for (const b of rd.bots) {
        L.push(`| ${b.rank ?? '-'} | ${b.name} | ${b.btElo ?? '-'} | ${g[b.name] ?? '-'} | ${b.wins}-${b.losses}-${b.draws} | ${b.winRate === null ? '-' : Math.round(b.winRate * 100)} | ${b.msPerDecision ?? '-'} | ${b.forfeits} |`);
    }
    // only when a helper computer played some of the round (its clock is not the machine's)
    const hosts = Object.entries(rd.hosts ?? {}).sort(([a], [b]) => (a === 'machine' ? -1 : b === 'machine' ? 1 : a < b ? -1 : 1));
    if (hosts.some(([h]) => h !== 'machine')) {
        const where = hosts.map(([h, x]) => `${h} ${x.games} game${x.games === 1 ? '' : 's'}${x.decisions ? ` (${Math.round(x.thinkMs / x.decisions)} ms/decision)` : ''}`);
        L.push('', `Where games ran: ${where.join(', ')}.`);
    }
    const helpers = helpersLine(rd.remote);
    if (helpers) {
        L.push('', helpers);
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
 * A round's ladder id, which is also its folder in <results>. Rounds of the old clocked tournaments were
 * <tournament id>-r<K>; standings.json names those (ladderId).
 */
function ladderIdOf(round) {
    return `arena-r${round}`;
}

function publish(round, id = ladderIdOf(round)) {
    const ladderFile = path.join(RESULTS, id, 'ladder.json');
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
    // rounds belong to no clocked tournament now: dash.js and the app read null as none
    st.tournament = null;
    const lead = rd.leader ? `${rd.leader} leads` : rd.rated ? 'no competitor rated' : 'no games yet';
    st.now = rd.status === 'done' ? `Round ${round} done, ${lead}` : `Round ${round} running: ${rd.games}/${rd.scheduled} games${rd.rated ? '' : ', no games yet'}`;
    fs.mkdirSync(path.join(HOME, 'rounds'), { recursive: true });
    writeJson(STANDINGS, st);
    writeAtomic(path.join(HOME, 'rounds', `r${round}.md`), report(rd, st.global));
    dash.publishStandings(st);
    return rd;
}

/**
 * Newest version of every roster agent that has one, resident entries included, plus the built-in baselines that no
 * resident with a version has replaced (residentName: the same bot, entered as a submission), so the arena's own bots
 * move out of the image one by one and no round misses one. With a cutoff (ISO time) only versions submitted at or
 * before it count (versions without submittedAt always do); later ones wait for the next round. `playable` narrows the
 * versions that count (the games machine plays only WebAssembly ones): an agent whose newest one is not playable
 * fields its newest one that is, or nothing.
 */
function lineup(cutoff = null, { playable = () => true } = {}) {
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
        // newest version that the registry can resolve (a folder without bot.js would stop the ladder) and that plays here
        const v = [...ok].reverse().find((n) => resolveArena(`${a.name}-v${n}`) && playable(`${a.name}-v${n}`));
        if (v !== undefined) {
            agents.push(`${a.name}-v${v}`);
        }
        if (ok.length && v !== ok[ok.length - 1]) {
            console.log(`${a.name}: v${ok[ok.length - 1]} cannot be loaded or played here, using ${v === undefined ? 'nothing' : `v${v}`}`);
        }
    }
    const fielded = new Set(agents.map(residentOf).filter(Boolean));
    return [...agents, ...roster.baselines.filter((b) => !fielded.has(residentName(b)) && playable(b))];
}

// child processes (the ladder) die with the referee
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

// which PID namespace this process is in (the games machine starts the referee in its own, isolate.sh): pids mean
// something only inside one
const PIDNS = (() => {
    try {
        return fs.readlinkSync('/proc/self/ns/pid');
    } catch {
        return null;
    }
})();

// Bot code runs in the ladder the referee starts. When the referee runs as root (the games machine, in its own
// namespace), it runs as ARENA_BOT_USER with no capabilities: a bot then cannot undo the namespace's hiding, and
// cannot read the round-seed secret, which stays root's (a bot running as the referee's own user could read its file,
// its environment or its memory). The ladder never gets the secret's path.
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

/**
 * A folder the referee made that bot code writes into (a round's ladder folder) belongs to ARENA_BOT_USER. Changed
 * through a handle opened without following a link: the results folder is that user's, who could put a link there.
 */
function giveToBots(dir) {
    const ids = botUser();
    if (ids) {
        const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        try {
            fs.fchownSync(fd, ids[0], ids[1]);
        } finally {
            fs.closeSync(fd);
        }
    }
}

/** Takes <dir>/referee.lock, or throws while another live referee holds it. */
function takeLock(dir) {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.lstatSync(dir).isDirectory()) {
        throw new Error(`${dir} is not a folder (a link?): the referee does not write through it`);
    }
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

async function runRound(round, bots, { games = Number(arg('games', 4)), seed, key, id = ladderIdOf(round) } = {}) {
    const dir = path.join(RESULTS, id);
    const cap = Number(roster.thinkCapMs);
    // the watchdog waits 30 s past the wall cap (guard.js: 2 x cap), so a call the guard allows is never taken for a hang
    const limits = Number.isFinite(cap) && cap > 0 ? ['--cap-ms', String(cap), '--hang-ms', String(2 * cap + 30000)] : [];
    const args = [path.join(__dirname, '..', 'ladder.js'), '--bots', bots.join(','), '--games', String(games), '--seed', String(seed), '--key', key,
        '--id', id, '--out', RESULTS, '--workers', arg('workers', '3'), ...limits, '--decks', ROUND_DECKS.file, '--deal', 'seat', '--skip-decks', ROUND_DECKS.skip.join(','),
        '--record', '--resume'];
    takeLock(dir);
    giveToBots(dir);
    console.log(`round ${round}: ${bots.join(', ')}`);
    let code;
    const tick = setInterval(() => {
        try {
            touchLock();
            publish(round, id);
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
    const rd = publish(round, id);
    console.log(fs.readFileSync(path.join(HOME, 'rounds', `r${round}.md`), 'utf8').split('\n## ')[0]);
    return rd;
}

async function main() {
    process.on('exit', cleanup);
    for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
        process.on(sig, () => {
            console.error(`referee: ${sig}, stopping`);
            process.exit(code);
        });
    }
    const nextRound = () => (readJson(STANDINGS, { rounds: [] }).rounds.map((r) => r.round).pop() ?? -1) + 1;
    const k = arg('round') !== undefined ? Number(arg('round')) : nextRound();
    const secret = loadSecret();
    await runRound(k, lineup(), { seed: roundSeed(secret, 'watch', k), key: roundKey(secret, 'watch', k) });
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e.message || e);
        process.exit(1);
    });
}

module.exports = { ROUND_DECKS, cappedScore, scoreRound, anchoredBT, anchorsOf, residentName, globalElo, allRoundAnchors, lineup, publish, takeLock, releaseLock, roundSeed, roundKey, loadSecret, report, helpersLine, ladderIdOf, spawnBots, giveToBots };
