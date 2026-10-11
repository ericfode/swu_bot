'use strict';
// node bot/analyze-game.js <game.jsonl>  -> steps, how many changed nothing visible, longest no-change streak, last actions.
const fs = require('fs');
const L = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.t === 'step');
const sig = (s) => JSON.stringify([s.round, s.phase, s.initiative, Object.values(s.players).map((p) => [p.base.d, p.res.ready, p.res.total, p.hand.length, p.deck, p.ground.map((u) => [u.n, u.d, u.x]), p.space.map((u) => [u.n, u.d, u.x])])]);
let same = 0, streak = 0, longest = 0, at = 0;
for (let i = 1; i < L.length; i++) {
    if (sig(L[i].state) === sig(L[i - 1].state)) {
        same++; streak++;
        if (streak > longest) { longest = streak; at = i; }
    } else {
        streak = 0;
    }
}
const last = L[L.length - 1];
console.log(JSON.stringify({ steps: L.length, noChangeSteps: same, longestNoChangeStreak: longest, atStep: at, lastRound: last.state.round }));
