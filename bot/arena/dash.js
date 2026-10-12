'use strict';
/**
 * Writes the arena's research-dashboard files (contract: /mnt/project-files/dashboard/README.md):
 *   panels/arena-<agent>.json     one strategy panel per competitor (prompt, current idea, thoughts, Elo by round, speed)
 *   panels/arena-leaderboard.json the leaderboard across rounds
 *   experiments/arena.json        Elo over rounds, one series per competitor
 * The page polls these files, so a write shows up live. All writes are atomic.
 * ARENA_DASH overrides the dashboard folder (default /mnt/project-files/dashboard, skipped when it does not exist).
 * Panel thread names come from roster.json `owner` (the project thread that runs that competitor).
 *
 * A competitor panel has two writers, the competitor (say: now, idea, plan, thoughts, strategy diagram) and the referee
 * (publishStandings: versions, standings widgets, status). Each keeps its half in its own file in ARENA_HOME,
 *   panels/<agent>.say.json   panels/<agent>.rated.json
 * and every write of either half recomposes the dashboard panel from both, so neither overwrites the other's fields.
 * The leaderboard and the experiment are kept in ARENA_HOME too (panels/leaderboard.json, panels/experiment.json), so
 * the API serves every panel (api.js `panels`) without the dashboard folder; the dashboard files are copies.
 */
const fs = require('fs');
const path = require('path');
const { HOME, roster, readJson, writeJson } = require('./home');

const DASH = process.env.ARENA_DASH ?? '/mnt/project-files/dashboard';
const THREAD = 'Competing Claudes';
const PLAN_STATES = ['done', 'doing', 'todo'];
const NO_GAMES = 'no games yet';

function enabled() {
    return fs.existsSync(DASH);
}

const panelFile = (agent) => path.join(DASH, 'panels', `arena-${agent}.json`);
const halfFile = (agent, side) => path.join(HOME, 'panels', `${agent}.${side}.json`);
const boardFile = (name) => path.join(HOME, 'panels', `${name}.json`);
// benched competitors (api.js withdraw) keep their panels, ratings and history
const everyone = (r) => [...r.agents, ...(r.bench ?? [])];
const agentInfo = (agent) => everyone(roster()).find((x) => x.name === agent) ?? { name: agent, title: agent, philosophy: '', start: '' };

/** A trimmed string of at most max chars, or undefined (null, empty, objects). */
function text(v, max) {
    if (typeof v !== 'string' && typeof v !== 'number') {
        return undefined;
    }
    const s = String(v).trim().slice(0, max);
    return s || undefined;
}

/** Plan items as the dashboard draws them: [{text, state}], at most 12; strings become todo items, junk is dropped. */
function cleanPlan(plan) {
    return plan.map((x) => (x && typeof x === 'object' ? { text: text(x.text, 200), state: PLAN_STATES.includes(x.state) ? x.state : 'todo' } : { text: text(x, 200), state: 'todo' }))
        .filter((x) => x.text).slice(0, 12);
}

/** The competitor's half. Before its first write it is taken from the dashboard panel an older version wrote whole. */
function readSay(agent) {
    const s = readJson(halfFile(agent, 'say'), null);
    if (s) {
        return s;
    }
    const p = enabled() ? readJson(panelFile(agent), null) : null;
    return p ? { now: p.now, idea: p.mentalModel?.summary, plan: p.plan, thoughts: p.thoughts, diagram: p.widgets?.find((w) => w.type === 'strategy'), status: p.status } : {};
}

/** The dashboard panel of a competitor, composed from both halves. */
function composePanel(agent) {
    const a = agentInfo(agent);
    const say = readSay(agent);
    const rated = readJson(halfFile(agent, 'rated'), {});
    return {
        schema: 1, id: `arena-${agent}`, title: `Arena: ${agent}, ${a.title}`, thread: a.owner ?? THREAD, bots: rated.bots ?? [agent],
        status: rated.status === 'done' ? 'done' : say.status ?? 'running', updatedAt: [say.updatedAt, rated.updatedAt].filter(Boolean).sort().pop() ?? new Date().toISOString(),
        now: say.now ?? 'Waiting for its first round', goal: a.philosophy, mentalModel: { summary: say.idea ?? `Started from ${a.start}.` },
        plan: say.plan ?? [], thoughts: say.thoughts ?? [],
        // the strategy diagram is always the panel's first widget
        widgets: [...(say.diagram ? [say.diagram] : []), ...(rated.widgets ?? [])]
    };
}

function writePanel(agent) {
    if (enabled()) {
        writeJson(panelFile(agent), composePanel(agent));
    }
}

/** Change the competitor's half of its panel (now / idea / thought / plan / status / diagram) and keep the rest. */
function updatePanel(agent, { now, idea, thought, plan, status, diagram } = {}) {
    const s = readSay(agent);
    const t = new Date().toISOString();
    if (text(now, 300)) {
        s.now = text(now, 300);
    }
    if (text(idea, 1000)) {
        s.idea = text(idea, 1000);
    }
    if (text(thought, 2000)) {
        s.thoughts = [...(s.thoughts ?? []), { t, text: text(thought, 2000) }].slice(-40);
    }
    if (Array.isArray(plan)) {
        s.plan = cleanPlan(plan);
    }
    if (text(status, 20)) {
        s.status = text(status, 20);
    }
    if (diagram) {
        s.diagram = { ...diagram, updatedAt: t };
    }
    s.updatedAt = t;
    writeJson(halfFile(agent, 'say'), s);
    writePanel(agent);
}

/** Series sorted by their latest value, highest first (the dashboard shows the first few until "Show all"). */
function bestFirst(series) {
    const last = (s) => (s.points.length ? s.points[s.points.length - 1][1] : -Infinity);
    return [...series].sort((x, y) => last(y) - last(x));
}

/** Rebuild the referee's half of every panel, the leaderboard and the experiment from standings.json. */
function publishStandings(st) {
    const r = roster();
    const rounds = st.rounds;
    const last = rounds[rounds.length - 1];
    const g = st.global ?? {};
    const elo = (name) => (g[name] === undefined || g[name] === null ? null : Math.round(g[name]));
    const eloOf = (agent, rd) => elo(rd.bots.find((b) => b.agent === agent)?.name);
    const show = (v) => (v === null || v === undefined ? '-' : v);
    const t = new Date().toISOString();
    const done = st.status === 'done';
    const eloSeries = () => bestFirst(everyone(r).map((a) => ({ name: a.name, points: rounds.filter((rd) => eloOf(a.name, rd) !== null).map((rd) => [rd.round, eloOf(a.name, rd)]) })));

    for (const a of everyone(r)) {
        const rows = rounds.map((rd) => ({ rd, b: rd.bots.find((b) => b.agent === a.name) })).filter((x) => x.b);
        const cur = rows[rows.length - 1]?.b;
        // the round those stats are from: the latest one it played (a benched or missing competitor sat out the later ones)
        const curRd = rows[rows.length - 1]?.rd ?? last;
        const curElo = cur ? elo(cur.name) : null;
        writeJson(halfFile(a.name, 'rated'), {
            bots: [...new Set(rows.map((x) => x.b.name))], status: done ? 'done' : 'running', updatedAt: t,
            widgets: [
                { type: 'stats', items: [
                    { label: 'Elo (all rounds)', value: !cur ? '-' : curElo === null ? NO_GAMES : curElo },
                    { label: `rank in round ${curRd?.round ?? '-'}`, value: !cur ? '-' : cur.rank === null || cur.rank === undefined ? NO_GAMES : `${cur.rank} / ${curRd.bots.length}` },
                    { label: 'win rate', value: cur?.winRate === null || !cur ? '-' : `${Math.round(cur.winRate * 100)}%` },
                    { label: 'ms / decision', value: cur?.msPerDecision ?? '-' },
                    { label: 'forfeits', value: cur?.forfeits ?? 0 }
                ] },
                { type: 'line', title: 'Elo by round (all-round Bradley-Terry, baselines anchor the scale)', x: 'round',
                  series: bestFirst([{ name: a.name, points: rows.filter((x) => elo(x.b.name) !== null).map((x) => [x.rd.round, elo(x.b.name)]) },
                                     ...r.baselines.filter((bl) => elo(bl) !== null).map((bl) => ({ name: bl, points: rounds.map((rd) => [rd.round, elo(bl)]) }))]).slice(0, 4) },
                { type: 'line', title: 'Think time, ms per decision (harness-timed)', x: 'round',
                  series: [{ name: a.name, points: rows.filter((x) => x.b.msPerDecision !== null).map((x) => [x.rd.round, x.b.msPerDecision]) }] },
                { type: 'table', title: 'Rounds', columns: ['round', 'version', 'Elo', 'rank', 'W-L', 'ms/dec', 'forfeits', 'submission note'],
                  rows: rows.map((x) => [x.rd.round, x.b.name, show(elo(x.b.name)), show(x.b.rank), `${x.b.wins}-${x.b.losses}`, x.b.msPerDecision, x.b.forfeits, x.b.idea ?? '']) },
                { type: 'text', title: 'Its prompt (research philosophy)', body: `${a.title}. Started from ${a.start}.\n\n${a.philosophy}` }
            ]
        });
        writePanel(a.name);
    }
    // a round without rated games has no ranks yet: keep its bots in lineup order
    const board = last ? [...last.bots].sort((x, y) => (x.rank ?? Infinity) - (y.rank ?? Infinity)) : [];
    const noGames = !!last && !last.bots.some((b) => b.rank !== null && b.rank !== undefined);
    const leader = last ? last.leader ?? (noGames ? NO_GAMES : '-') : '-';
    const leaderboard = {
        // a summary panel: its bots are on the competitors' own panels
        schema: 1, id: 'arena-leaderboard', title: 'Arena leaderboard: competing Claudes', thread: THREAD,
        bots: [], status: st.status ?? 'running', updatedAt: t,
        now: st.now ?? (last ? `Round ${last.round} ladder ${last.status}${noGames ? `, ${NO_GAMES}` : ''}` : 'Starting'),
        goal: 'Several Claudes, each with a different research prompt, race to improve their own SWU bot.',
        mentalModel: { summary: `Each competitor is a project thread with its own prompt. It edits its bot in /mnt/project-files/arena/agents/<name>/ and submits versions; the referee rates the newest version of each against ${r.baselines.join(' and ')}. A bot that thinks more than ${r.thinkCapMs / 1000}s in a game, throws, hangs or fails to load forfeits it. Rules: bot/arena/README.md.` },
        plan: rounds.map((rd) => ({ text: `Round ${rd.round}: ${rd.games} games, ${rd.leader ? `leader ${rd.leader}` : rd.bots.some((b) => b.rank != null) ? 'no leader' : NO_GAMES}`, state: rd.status === 'done' ? 'done' : 'doing' })),
        thoughts: [],
        widgets: [
            { type: 'table', title: last ? `Round ${last.round} standings${noGames ? ` (${NO_GAMES})` : ''}` : 'Standings', columns: ['#', 'bot', 'agent', 'Elo', 'W-L', 'win %', 'ms/dec', 'forfeits', 'submission note'],
              rows: board.map((b) => [show(b.rank), b.name, b.agent ?? 'baseline', elo(b.name) ?? b.btElo ?? NO_GAMES, `${b.wins}-${b.losses}`, b.winRate === null ? '-' : Math.round(b.winRate * 100), b.msPerDecision, b.forfeits, b.idea ?? '']) },
            { type: 'line', title: 'Elo by round', x: 'round', series: eloSeries() },
            { type: 'bars', title: 'Think time, ms per decision (latest round)', items: board.map((b) => ({ label: b.name, value: b.msPerDecision ?? 0 })) }
        ]
    };

    // progress: rounds done of the tournament's planned rounds (outside a tournament, of the rounds so far)
    const tour = st.tournament;
    const progress = tour?.plannedRounds
        ? { done: rounds.filter((rd) => rd.status === 'done' && (tour.rounds ?? []).includes(rd.round)).length, total: tour.plannedRounds, unit: 'rounds' }
        : { done: rounds.filter((rd) => rd.status === 'done').length, total: rounds.length, unit: 'rounds' };
    const experiment = {
        schema: 1, id: 'arena', title: 'Arena: competing Claudes improving their own bots', owner: THREAD,
        hypothesis: 'Different research prompts (search, tuning, card knowledge, replay coaching) improve a bot at different speeds.',
        status: st.status ?? 'running', startedAt: st.startedAt, updatedAt: t, progress,
        metrics: [
            { label: 'leader', value: leader },
            ...board.filter((b) => b.agent).map((b) => ({ label: `${b.agent} Elo`, value: elo(b.name) ?? NO_GAMES }))
        ],
        chart: { x: 'round', y: 'Elo (all-round Bradley-Terry)', series: eloSeries() },
        conclusion: st.conclusion ?? null
    };
    writeJson(boardFile('leaderboard'), leaderboard);
    writeJson(boardFile('experiment'), experiment);
    if (enabled()) {
        writeJson(path.join(DASH, 'panels', 'arena-leaderboard.json'), leaderboard);
        writeJson(path.join(DASH, 'experiments', 'arena.json'), experiment);
    }
}

/** The leaderboard and experiment last published (null before the first round); older arenas kept them only in the dashboard. */
function boards() {
    const read = (name, dashFile) => readJson(boardFile(name), null) ?? (enabled() ? readJson(dashFile, null) : null);
    return {
        leaderboard: read('leaderboard', path.join(DASH, 'panels', 'arena-leaderboard.json')),
        experiment: read('experiment', path.join(DASH, 'experiments', 'arena.json'))
    };
}

module.exports = { updatePanel, publishStandings, composePanel, boards, enabled, DASH };
