'use strict';
/**
 * Writes the arena's research-dashboard files (contract: /mnt/project-files/dashboard/README.md):
 *   panels/arena-<agent>.json     one strategy panel per competitor (prompt, current idea, thoughts, Elo by round, speed)
 *   panels/arena-leaderboard.json the leaderboard across rounds
 *   experiments/arena.json        Elo over rounds, one series per competitor
 * The page polls these files, so a write shows up live. All writes are atomic.
 * ARENA_DASH overrides the dashboard folder (default /mnt/project-files/dashboard, skipped when it does not exist).
 * Panel thread names come from roster.json `owner` (the project thread that runs that competitor).
 */
const fs = require('fs');
const path = require('path');
const { roster, readJson, writeJson } = require('./home');

const DASH = process.env.ARENA_DASH ?? '/mnt/project-files/dashboard';
const THREAD = 'Competing Claudes';

function enabled() {
    return fs.existsSync(DASH);
}

const panelFile = (agent) => path.join(DASH, 'panels', `arena-${agent}.json`);

function basePanel(agent) {
    const a = roster().agents.find((x) => x.name === agent) ?? { name: agent, title: agent, philosophy: '', start: '' };
    return {
        schema: 1, id: `arena-${agent}`, title: `Arena: ${agent}, ${a.title}`, thread: a.owner ?? THREAD, bots: [agent], status: 'running',
        updatedAt: new Date().toISOString(), now: 'Waiting for its first round', goal: a.philosophy,
        mentalModel: { summary: `Started from ${a.start}.` }, plan: [], thoughts: [], widgets: []
    };
}

/** Change the live part of a panel (now / idea / thought / plan) and keep the rest. */
function updatePanel(agent, { now, idea, thought, plan, status } = {}) {
    if (!enabled()) {
        return;
    }
    const p = readJson(panelFile(agent), null) ?? basePanel(agent);
    const t = new Date().toISOString();
    if (now) {
        p.now = now;
    }
    if (idea) {
        p.mentalModel = { ...(p.mentalModel ?? {}), summary: idea };
    }
    if (thought) {
        p.thoughts = [...(p.thoughts ?? []), { t, text: thought }].slice(-40);
    }
    if (plan) {
        p.plan = plan;
    }
    if (status) {
        p.status = status;
    }
    p.updatedAt = t;
    writeJson(panelFile(agent), p);
}

/** Rebuild the standings-driven parts of every panel, the leaderboard and the experiment from standings.json. */
function publishStandings(st) {
    if (!enabled()) {
        return;
    }
    const r = roster();
    const rounds = st.rounds;
    const last = rounds[rounds.length - 1];
    const g = st.global ?? {};
    const eloOf = (agent, rd) => g[rd.bots.find((b) => b.agent === agent)?.name] ?? null;
    const t = new Date().toISOString();

    for (const a of r.agents) {
        const p = readJson(panelFile(a.name), null) ?? basePanel(a.name);
        const rows = rounds.map((rd) => ({ rd, b: rd.bots.find((b) => b.agent === a.name) })).filter((x) => x.b);
        const cur = rows[rows.length - 1]?.b;
        p.bots = rows.map((x) => x.b.name);
        p.goal = a.philosophy;
        p.thread = a.owner ?? p.thread;
        p.updatedAt = t;
        p.widgets = [
            { type: 'stats', items: [
                { label: 'Elo (all rounds)', value: cur ? Math.round(eloOf(a.name, rows[rows.length - 1].rd)) : '-' },
                { label: `rank in round ${last?.round ?? '-'}`, value: cur ? `${cur.rank} / ${last.bots.length}` : '-' },
                { label: 'win rate', value: cur?.winRate === null || !cur ? '-' : `${Math.round(cur.winRate * 100)}%` },
                { label: 'ms / decision', value: cur?.msPerDecision ?? '-' },
                { label: 'time forfeits', value: cur?.forfeits ?? 0 }
            ] },
            { type: 'line', title: 'Elo by round (all-round Bradley-Terry, baselines anchor the scale)', x: 'round',
              series: [{ name: a.name, points: rows.map((x) => [x.rd.round, Math.round(eloOf(a.name, x.rd))]) },
                       ...r.baselines.map((bl) => ({ name: bl, points: rounds.map((rd) => [rd.round, Math.round(g[bl] ?? 1500)]) }))].slice(0, 4) },
            { type: 'line', title: 'Think time, ms per decision (harness-timed)', x: 'round',
              series: [{ name: a.name, points: rows.map((x) => [x.rd.round, x.b.msPerDecision ?? 0]) }] },
            { type: 'table', title: 'Rounds', columns: ['round', 'version', 'Elo', 'rank', 'W-L', 'ms/dec', 'forfeits', 'submission note'],
              rows: rows.map((x) => [x.rd.round, x.b.name, Math.round(eloOf(a.name, x.rd)), x.b.rank, `${x.b.wins}-${x.b.losses}`, x.b.msPerDecision, x.b.forfeits, x.b.idea ?? '']) },
            { type: 'text', title: 'Its prompt (research philosophy)', body: `${a.title}. Started from ${a.start}.\n\n${a.philosophy}` }
        ];
        writeJson(panelFile(a.name), p);
    }

    const board = last ? [...last.bots].sort((x, y) => x.rank - y.rank) : [];
    writeJson(path.join(DASH, 'panels', 'arena-leaderboard.json'), {
        schema: 1, id: 'arena-leaderboard', title: 'Arena leaderboard: competing Claudes', thread: THREAD,
        bots: board.map((b) => b.name), status: st.status ?? 'running', updatedAt: t,
        now: st.now ?? (last ? `Round ${last.round} ladder ${last.status}` : 'Starting'),
        goal: 'Several Claudes, each with a different research prompt, race to improve their own SWU bot.',
        mentalModel: { summary: `Each competitor is a project thread with its own prompt. It edits its bot in /mnt/project-files/arena/agents/<name>/ and submits versions; the referee rates the newest version of each against rush and heuristic. Over ${r.thinkCapMs / 1000}s of thinking in a game loses it. Rules: bot/arena/README.md.` },
        plan: rounds.map((rd) => ({ text: `Round ${rd.round}: ${rd.games} games, leader ${rd.leader ?? '-'}`, state: rd.status === 'done' ? 'done' : 'doing' })),
        thoughts: [],
        widgets: [
            { type: 'table', title: last ? `Round ${last.round} standings` : 'Standings', columns: ['#', 'bot', 'agent', 'Elo', 'W-L', 'win %', 'ms/dec', 'forfeits', 'submission note'],
              rows: board.map((b) => [b.rank, b.name, b.agent ?? 'baseline', Math.round(g[b.name] ?? b.btElo), `${b.wins}-${b.losses}`, b.winRate === null ? '-' : Math.round(b.winRate * 100), b.msPerDecision, b.forfeits, b.idea ?? '']) },
            { type: 'line', title: 'Elo by round', x: 'round',
              series: r.agents.map((a) => ({ name: a.name, points: rounds.filter((rd) => eloOf(a.name, rd) !== null).map((rd) => [rd.round, Math.round(eloOf(a.name, rd))]) })) },
            { type: 'bars', title: 'Think time, ms per decision (latest round)', items: board.map((b) => ({ label: b.name, value: b.msPerDecision ?? 0 })) }
        ]
    });

    writeJson(path.join(DASH, 'experiments', 'arena.json'), {
        schema: 1, id: 'arena', title: 'Arena: competing Claudes improving their own bots', owner: THREAD,
        hypothesis: 'Different research prompts (search, tuning, card knowledge, replay coaching) improve a bot at different speeds.',
        status: st.status ?? 'running', startedAt: st.startedAt, updatedAt: t,
        progress: { done: rounds.filter((rd) => rd.status === 'done').length, total: Math.max(st.plannedRounds ?? 0, rounds.length), unit: 'rounds' },
        metrics: [
            { label: 'leader', value: board.find((b) => b.agent)?.name ?? '-' },
            ...board.filter((b) => b.agent).map((b) => ({ label: `${b.agent} Elo`, value: Math.round(g[b.name] ?? b.btElo) }))
        ],
        chart: { x: 'round', y: 'Elo (all-round Bradley-Terry)',
                 series: r.agents.map((a) => ({ name: a.name, points: rounds.filter((rd) => eloOf(a.name, rd) !== null).map((rd) => [rd.round, Math.round(eloOf(a.name, rd))]) })) },
        conclusion: st.conclusion ?? null
    });
}

module.exports = { updatePanel, publishStandings, enabled, DASH };
