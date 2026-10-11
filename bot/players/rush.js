'use strict';

/**
 * Rush bot: fast, rule-based, no lookahead (does not need undo).
 *
 * In its action window: play the most expensive card it can from hand, otherwise attack with a unit, otherwise use
 * the leader, otherwise pass. Attack prompts go face first (the enemy base whenever it is selectable). Everything
 * else falls back to the heuristic bot's rule-based defaultChoose. A position that keeps coming back to the same
 * window is treated as a loop (e.g. a card click that gets cancelled) and the bot passes.
 */
const { defaultChoose } = require('./heuristic');

const isPass = (a) => a.kind === 'button' && /^pass$/i.test(a.label);
const ARENAS = new Set(['groundArena', 'spaceArena']);

/** Order of preference among card clicks in the action window (higher first). */
function windowPriority(a, pl) {
    const c = a.card;
    if (!c || c.controller !== pl) {
        return -1;
    }
    if (c.zoneName === 'hand') {
        return 300 + (c.cost ?? 0);
    }
    if (ARENAS.has(c.zoneName) && c.isUnit?.()) {
        return 200 + (c.getPower?.() ?? 0);
    }
    if (c.isLeader?.()) {
        return 100;
    }
    return 0;
}

function attackChoice(acts, pl) {
    const cards = acts.filter((a) => a.kind === 'card' && a.card);
    const base = cards.find((a) => a.card.isBase?.() && a.card.controller !== pl);
    if (base) {
        return base;
    }
    // no base (e.g. sentinel): hit the enemy unit we can damage the most relative to its health
    const enemies = cards.filter((a) => a.card.controller !== pl && a.card.isUnit?.());
    if (!enemies.length) {
        return null;
    }
    return enemies.reduce((best, a) => ((a.card.remainingHp ?? 99) < (best.card.remainingHp ?? 99) ? a : best));
}

function createRushBot(name = 'rush') {
    const seen = new Map();
    return {
        name,
        stats: { windows: 0, loopPasses: 0 },
        choose({ game: eg, pid, actions }) {
            const pl = eg.player(pid);
            if (eg.isActionWindow(pid)) {
                this.stats.windows++;
                const pass = actions.find(isPass);
                // same window, same visible counts as before: something we tried got cancelled, so stop retrying
                const key = [eg.round, pl.hand.length, pl.readyResourceCount, pl.opponent.base.damage, pl.getArenaUnits().filter((u) => !u.exhausted).length].join('|');
                const n = (seen.get(key) ?? 0) + 1;
                seen.set(key, n);
                if (n > 2 && pass) {
                    this.stats.loopPasses++;
                    return pass;
                }
                let best = null;
                let bestP = 0;
                for (const a of actions) {
                    const p = windowPriority(a, pl);
                    if (p > bestP) {
                        best = a;
                        bestP = p;
                    }
                }
                return best ?? pass ?? actions[0];
            }
            const prompt = pl.currentPrompt();
            const title = `${prompt.menuTitle ?? ''} ${prompt.promptTitle ?? ''}`;
            if (/attack/i.test(title)) {
                const a = attackChoice(actions, pl);
                if (a) {
                    return a;
                }
            }
            return defaultChoose(eg, pid, actions);
        }
    };
}

module.exports = { createRushBot, windowPriority, attackChoice };
