'use strict';
// Scores protocol `state`s with a bot/eval evaluator, for jepa_bot.py's oracle modes (--score sim-eval, --log).
//   node bot/jepa/eval_helper.js [linear-deck-g4]
// stdin: one request per line {"judge":"p1","decks":{"p1":[...],"p2":[...]}|null,"states":[...],"toAct":[...]}
// stdout: one line {"logits":[...]} per request: logit of P(judge wins), judged from the judge's own seat.
const readline = require('readline');
const { loadEvaluator } = require('../eval/evaluators');

const ev = loadEvaluator(process.argv[2] || 'linear-deck-g4');
const HIDDEN = { id: 'hidden', n: 'hidden card', s: null };

// A seat's view lists only the opponent's hand count; the evaluator reads hand.length and values hidden cards from
// the decklist (subjective view), so the count is filled in with hidden cards.
function withHands(state) {
    const players = {};
    for (const [seat, p] of Object.entries(state.players)) {
        players[seat] = p.hand ? p : { ...p, hand: Array.from({ length: p.handCount ?? 0 }, () => HIDDEN) };
    }
    return { ...state, players };
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) {
        return;
    }
    const q = JSON.parse(line);
    const logits = q.states.map((s, k) => ev.logit(ev.frame(withHands(s), q.judge, { view: 'subjective', decks: q.decks, toAct: q.toAct?.[k] ?? null })));
    process.stdout.write(`${JSON.stringify({ logits })}\n`);
});
