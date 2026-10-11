'use strict';

/**
 * Text renderings of replay snapshots for the three evaluation views.
 *
 *   subjective (pov p1|p2): own hand by name, opponent hand as a count, both boards, discards, resources;
 *                           the action log hides the opponent's private choices (cards they resourced).
 *   objective:              both hands by name, full action log; nothing about the future.
 *   omniscient:             the whole trajectory, every hand, and the result.
 *
 * Deck order and resource identities are not in the replay format, so even the objective view cannot see them.
 */

const other = (seat) => (seat === 'p1' ? 'p2' : 'p1');
const pretty = (label) => String(label).replace(/-/g, ' ');

function unitLine(u) {
    const flags = [u.x ? 'exhausted' : 'ready', u.sn ? 'sentinel' : null].filter(Boolean).join(', ');
    const ups = u.u?.length ? ` +[${u.u.map((x) => x.n).join(', ')}]` : '';
    return `${u.n} ${u.p}/${u.h}${u.d ? ` (${u.d} dmg, ${u.h - u.d} left)` : ''}${ups} [${flags}]`;
}

function cardList(cards) {
    if (!cards.length) {
        return '(none)';
    }
    const counts = new Map();
    for (const c of cards) {
        counts.set(c.n, (counts.get(c.n) ?? 0) + 1);
    }
    return [...counts].map(([n, k]) => (k > 1 ? `${n} x${k}` : n)).join('; ');
}

/** One player's side of the board. showHand=false prints only the hand size. */
function sideBlock(seat, p, { showHand, label }) {
    const lines = [];
    const base = `${p.base.n}: ${p.base.hp - p.base.d}/${p.base.hp} HP left`;
    const leader = p.leader ? `${p.leader.n} (${p.leader.dep ? 'deployed as a unit' : 'not deployed'}${p.leader.x ? ', exhausted' : ''})` : '(none)';
    lines.push(`${label} [${seat}]`);
    lines.push(`  Base: ${base}`);
    lines.push(`  Leader: ${leader}`);
    lines.push(`  Resources: ${p.res.ready} ready of ${p.res.total}`);
    lines.push(`  Hand (${p.hand.length}): ${showHand ? cardList(p.hand) : 'hidden'}`);
    lines.push(`  Deck: ${p.deck} cards`);
    lines.push(`  Ground: ${p.ground.length ? p.ground.map(unitLine).join('; ') : '(empty)'}`);
    lines.push(`  Space: ${p.space.length ? p.space.map(unitLine).join('; ') : '(empty)'}`);
    lines.push(`  Discard (${p.discard.length}): ${cardList(p.discard)}`);
    return lines.join('\n');
}

/** Board text. pov = 'p1' | 'p2' for a subjective view, null for the objective view. */
function renderBoard(state, { pov = null, names = {} } = {}) {
    const order = pov ? [pov, other(pov)] : ['p1', 'p2'];
    const parts = [`Round ${state.round}, ${state.phase} phase. Initiative: ${state.initiative ?? 'none'}.`];
    for (const seat of order) {
        const label = pov ? (seat === pov ? 'YOU' : 'OPPONENT') : seat === 'p1' ? 'PLAYER 1' : 'PLAYER 2';
        parts.push(sideBlock(seat, state.players[seat], { showHand: !pov || seat === pov, label: `${label}${names[seat] ? ` (${names[seat]})` : ''}` }));
    }
    return parts.join('\n\n');
}

/** Is this decision private to its maker? Resource choices put a card face down. */
function isPrivate(step) {
    return /^resource/.test(step.prompt ?? '') && step.action?.kind === 'card';
}

/** The last `k` decisions up to and including steps[upto], as seen from pov (null = everything). */
function renderLog(steps, upto, { pov = null, k = 30 } = {}) {
    const from = Math.max(1, upto - k + 1);
    const lines = [];
    for (let j = from; j <= upto; j++) {
        const s = steps[j];
        if (!s?.pid) {
            continue;
        }
        const who = pov ? (s.pid === pov ? 'you' : 'opponent') : s.pid;
        const hidden = pov && s.pid !== pov && isPrivate(s);
        const what = hidden ? 'resourced a card (hidden)' : `${s.title ? `${s.title}: ` : ''}${pretty(s.action?.label ?? s.label ?? '')}`;
        lines.push(`  #${s.n} r${s.state.round} ${s.state.phase} ${who}: ${what}`);
    }
    return lines.length ? lines.join('\n') : '  (no decisions yet)';
}

/** One compact line per checkpoint for the omniscient pass: everything, hands included. */
function trajectoryLine(cp, state) {
    const side = (seat) => {
        const p = state.players[seat];
        const units = [...p.ground, ...p.space].map((u) => `${u.n} ${u.p}/${u.h - u.d}${u.x ? 'x' : ''}`).join(', ') || '-';
        return `${seat} base ${p.base.hp - p.base.d}/${p.base.hp} res ${p.res.total} hand[${p.hand.map((c) => c.n).join(', ')}] deck ${p.deck} units[${units}]${p.leader?.dep ? ' leader deployed' : ''}`;
    };
    const did = cp.actor ? `${cp.actor}: ${cp.actions.map(pretty).join(' > ')}` : cp.actions.map(pretty).join(' > ') || 'start';
    return `[${cp.i}] r${cp.round} ${cp.phase} | ${did} || ${side('p1')} || ${side('p2')} || init ${state.initiative ?? '-'}`;
}

module.exports = { renderBoard, renderLog, trajectoryLine, other, isPrivate };
