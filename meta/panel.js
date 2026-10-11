'use strict';

/**
 * Writes the research dashboard panel for the meta-analyzer (contract: /mnt/project-files/dashboard/README.md §5).
 *   node meta/panel.js <meta.json> <theory.json> <out panel.json> [artifact url]
 */
const fs = require('fs');

const [metaFile, theoryFile, out, url] = process.argv.slice(2);
const M = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
const T = fs.existsSync(theoryFile) ? JSON.parse(fs.readFileSync(theoryFile, 'utf8')) : { versions: [] };
const MIN = 8;
const mapped = M.bots.filter((b) => b.games >= MIN && b.replayGames >= 5);
const rankIn = (sid) => mapped.filter((b) => b.situations[sid].n >= MIN).sort((a, b) => b.situations[sid].edge - a.situations[sid].edge);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pp = (x) => { const v = Math.round(x * 100); return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v); };
const cur = T.versions[T.versions.length - 1] || {};
const scored = T.versions.filter((v) => v.score != null);

// Compact "who to bet on" table for the dashboard's sandboxed html widget; uses system colors so it reads in both themes.
const rows = M.situations.map((s) => {
    const r = rankIn(s.id);
    if (!r.length) return '';
    return `<tr><td style="color:GrayText">${esc(s.group)}</td><td>${esc(s.label)}</td><td><b>${esc(r[0].id)}</b> ${pp(r[0].situations[s.id].edge)}</td><td style="color:GrayText">${r.slice(1, 3).map((b) => esc(b.id)).join(', ')}</td></tr>`;
}).join('');
const html = `<div style="font:13px system-ui,sans-serif;color:CanvasText"><table style="border-collapse:collapse;width:100%">`
    + `<tr style="text-align:left;color:GrayText"><th></th><th>Spot</th><th>Bet on (pts vs avg bot)</th><th>Next</th></tr>${rows}</table></div>`;

const panel = {
    schema: 1,
    id: 'meta-analyzer',
    title: 'Meta-analyzer: Strategy Atlas',
    thread: 'Meta-analyzer',
    bots: [],
    status: 'running',
    updatedAt: M.generatedAt,
    now: `Studying ${mapped.length} bots over ${M.totals.games} games; page theory v${cur.v || 1}.`,
    goal: 'Show at a glance which bot wins in which game spot and how each one plays, and keep testing that picture on reviewers.',
    mentalModel: {
        summary: 'Every round start in every replay is a spot (base, board, hand, round). A logistic baseline says how often an average bot (1500) wins from there against that opponent; each bot is scored by how much better or worse it does.',
        features: Object.entries(M.baseline.coef).map(([name, weight]) => ({ name, weight })),
    },
    plan: [
        { text: 'Extract spots and play style from every replay', state: 'done' },
        { text: 'Grid of bots x spots, style map, rivalries, scouting cards', state: 'done' },
        { text: 'Screenshot review rounds with a graded quiz', state: 'doing' },
        { text: 'Refresh as new results land', state: 'doing' },
    ],
    thoughts: T.versions.map((v) => ({ t: v.date, text: `v${v.v}: ${v.change}${v.score != null ? ` (quiz ${Math.round(v.score * 100)}%)` : ''}` })),
    widgets: [
        { type: 'stats', items: [
            { label: 'bots compared', value: mapped.length },
            { label: 'games read', value: M.totals.games },
            { label: 'round starts', value: M.totals.snapshots },
            ...(scored.length ? [{ label: 'last review quiz', value: Math.round(scored[scored.length - 1].score * 100) + '%' }] : []),
        ] },
        { type: 'html', title: 'Who to bet on in each spot', height: 300, html },
        ...(scored.length > 1 ? [{ type: 'line', title: 'Review quiz score by page version', x: 'version', yFormat: 'pct', series: [{ name: 'quiz', points: scored.map((v) => [v.v, v.score]) }] }] : []),
        ...(url ? [{ type: 'text', title: 'Full page', body: url }] : []),
    ],
};
fs.writeFileSync(out + '.tmp', JSON.stringify(panel, null, 1));
fs.renameSync(out + '.tmp', out);
console.log(`panel: ${out}`);
