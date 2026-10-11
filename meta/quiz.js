'use strict';

/**
 * Visual review quiz with an answer key, built from meta.json. Reviewers see only screenshots; their answers are
 * graded against the data, so "is the essence clear" becomes a number we can track per theory version.
 *   node meta/quiz.js <meta.json> <quiz.json>
 */
const fs = require('fs');

const [metaFile, out] = process.argv.slice(2);
const M = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
const MIN = 8;
const mapped = M.bots.filter((b) => b.games >= MIN && b.replayGames >= 5);
const top = (arr, f, k = 1) => [...arr].sort((a, b) => f(b) - f(a)).slice(0, k).map((b) => b.id);
const bestIn = (sid, k = 2) => top(mapped.filter((b) => b.situations[sid].n >= MIN), (b) => b.situations[sid].edge, k);
const SIT = Object.fromEntries(M.situations.map((s) => [s.id, s]));

// Pick a well-sampled mid-table bot for the "describe one bot" question.
const probe = [...mapped].filter((b) => b.games >= 50 && b.family !== 'random').sort((a, b) => b.games - a.games)[0] || mapped[0];
const pairs = M.pairs.filter((p) => p.games >= 10 && p.a !== 'random' && p.b !== 'random' && mapped.some((b) => b.id === p.a) && mapped.some((b) => b.id === p.b) && Math.abs(p.aWins / p.games - 0.5) >= 0.2);
const pair = pairs.sort((a, b) => b.games - a.games)[0];

const qs = [
    { id: 'strongest', q: 'Which bot is strongest overall?', key: top(mapped, (b) => b.rating, 2), kind: 'one-of' },
    { id: 'behind', q: 'Which bot does best when it is behind on base damage?', key: bestIn('base_behind'), kind: 'one-of' },
    { id: 'long', q: 'Which bot does best in long games (round 8 and later)?', key: bestIn('long_game'), kind: 'one-of' },
    { id: 'close', q: 'Which bot does best when the game is close at round 4?', key: bestIn('close_mid'), kind: 'one-of' },
    { id: 'racer', q: 'Name a bot that mostly attacks the enemy base and rarely removes enemy units.', key: mapped.filter((b) => b.summary.style === 'Racer').map((b) => b.id), kind: 'one-of' },
    { id: 'killer', q: 'Which bot removes the most enemy units per round?', key: top(mapped, (b) => b.style.kills || 0, 2), kind: 'one-of' },
    { id: 'clock', q: 'Which bots lose games by running out of thinking time? (list all you can see)', key: mapped.filter((b) => b.forfeits > 0).map((b) => b.id), kind: 'all-of' },
    { id: 'probe_best', q: `For the bot "${probe.id}": in which game spot is it strongest relative to its own level?`, key: [SIT[probe.summary.best.id].label], kind: 'one-of' },
    { id: 'probe_worst', q: `For the bot "${probe.id}": in which game spot is it weakest relative to its own level?`, key: [SIT[probe.summary.worst.id].label], kind: 'one-of' },
];
if (pair) {
    const winner = pair.aWins / pair.games > 0.5 ? pair.a : pair.b;
    qs.push({ id: 'h2h', q: `Head to head: who usually wins, ${pair.a} or ${pair.b}?`, key: [winner], kind: 'one-of' });
}
// Spot guide: can a reader who never played SWU decode the little table pictures?
qs.push(
    { id: 'icon_tower', q: 'In the small table pictures, what does the tall box at the left of each half show?', key: ['base', 'hp', 'health'], kind: 'one-of' },
    { id: 'icon_round', q: 'In the small table pictures, what does the circle marked R4 or R8 mean?', key: ['round'], kind: 'one-of' },
    { id: 'icon_near', q: 'One spot picture shows the bottom (your) tower almost empty and red. What does that spot mean in the game?', key: ['8 hp', '8 or less', 'near death', 'low base', 'about to lose', 'almost dead'], kind: 'one-of' },
);
// Face-off: the page opens on the top two bots; can the reader say which one is better in more spots?
const [fa, fb] = mapped;
if (fa && fb) {
    let aw = 0, bw = 0;
    for (const S of M.situations) {
        const ca = fa.situations[S.id], cb = fb.situations[S.id];
        if (!(ca && ca.n > 0 && cb && cb.n > 0)) continue;
        const d = ca.edge - cb.edge;
        if (d >= 0.03) aw++; else if (d <= -0.03) bw++;
    }
    if (aw !== bw) qs.push({ id: 'faceoff', q: `In the Face-off section, which of the two bots compared is better in more spots?`, key: [aw > bw ? fa.id : fb.id], kind: 'one-of' });
}
// Essence check: does the reader's one-line takeaway name the bot to back in each kind of spot?
const champions = {};
for (const S of M.situations) { const top = bestIn(S.id, 1)[0]; if (top) (champions[S.group] ||= new Set()).add(top); }
const essence = Object.fromEntries(Object.entries(champions).map(([g, s]) => [g, [...s]]));
fs.writeFileSync(out, JSON.stringify({ generatedAt: M.generatedAt, questions: qs, essence }, null, 1));
console.log(qs.map((q) => `${q.id}: ${q.q} -> ${q.key.join(' | ')}`).join('\n'));
