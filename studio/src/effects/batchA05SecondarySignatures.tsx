import type { CardRef, Seat } from '../data/types';
import type { CardEffectCue, CardEffectOutcome } from './types';
import { easeInOut, easeOut, envelope, phase } from './animationTimeline';
import { CardGhost, ScreenPixels, mix, screenShift as shift, type EffectBox, type PlacedOutcome } from './primitives';

type Geometry = { source: EffectBox; target: EffectBox; friendlyBase: EffectBox; outcomes: PlacedOutcome[]; zones: Record<string, EffectBox>; cards?: Record<string, EffectBox>; endingCards?: Record<string, EffectBox>; pockets?: Record<string, EffectBox> };
type Props = { cue: CardEffectCue; geometry: Geometry; p: number };
const ids = new Set(['fell-the-dragon', 'rivals-fall', 'remnant-reserves', 'enforced-loyalty', 'commission']);
export const isBatchA05Secondary = (cue: CardEffectCue) => ids.has(cue.definition.id);
const key = (card?: CardRef | null) => card?.id ?? `${card?.s ?? ''}:${card?.n ?? ''}`;
const same = (a?: CardRef | null, b?: CardRef | null) => !!a && !!b && key(a) === key(b);
const unitIn = (cue: CardEffectCue, card: CardRef | null | undefined, seat: Seat, after = false) => {
    const player = cue.transition?.[after ? 'after' : 'before'].players[seat];
    return [...(player?.ground ?? []), ...(player?.space ?? [])].find(unit => same(unit, card));
};
const sizeOf = (at: EffectBox) => at.cardSize ?? { w: at.w * (at.sx ?? 1), h: at.h * (at.sy ?? 1) };
const visible = (p: number, start: number) => phase(p, start, start + .06);
const bounded = (at: EffectBox, w = 120, h = 22): EffectBox => ({ ...at,
    x: Math.max((w / 2 + 8) / (at.sx ?? 1), Math.min(1000 - (w / 2 + 8) / (at.sx ?? 1), at.x)),
    y: Math.max((h / 2 + 40) / (at.sy ?? 1), Math.min(600 - (h / 2 + 122) / (at.sy ?? 1), at.y)) });
const center = (g: Geometry) => {
    const upper = g.zones['p2:ground'], base = g.zones['p1:base'];
    return bounded({ ...g.source, x: 500, y: upper && base ? (upper.y + upper.h / 2 + base.y - base.h / 2) / 2 : 300 });
};
const atCard = (g: Geometry, card: CardRef, seat: Seat, zone = 'ground') => g.cards?.[`${seat}:${key(card)}`] ?? g.zones[`${seat}:${zone}`] ?? g.target;
function Receipt({ at, rows, p, start = .7, until, color = '#dbe6ff' }: { at: EffectBox; rows: string[]; p: number; start?: number; until?: number; color?: string }) {
    const w = Math.min(242, Math.max(70, ...rows.map(row => row.length * 4.8 + 18))), h = rows.length * 18 + 6;
    return <ScreenPixels at={bounded(at, w, h)} color={color} opacity={visible(p, start) * (until ? 1 - phase(p, until - .06, until) : 1)}><rect x={-w / 2} y={-h / 2} width={w} height={h} rx="4" fill="#08111e" fillOpacity=".97" strokeWidth="1" />{rows.map((row, i) => <text key={i} y={-h / 2 + 15 + i * 18} textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '700 9px var(--font-display,sans-serif)' }}>{row}</text>)}</ScreenPixels>;
}
function Mask({ at, p, start }: { at: EffectBox; p: number; start: number }) {
    const s = sizeOf(at);
    return <ScreenPixels at={at} opacity={visible(p, start)}><rect x={-s.w / 2 - 5} y={-s.h / 2 - 5} width={s.w + 10} height={s.h + 10} rx="5" fill="#09121f" stroke="none" /></ScreenPixels>;
}
function Travel({ from, to, card, p, start, end, back = false, hold = true, exhausted = false, initialSize, color = '#d6e4ff' }: { from: EffectBox; to: EffectBox; card?: CardRef | null; p: number; start: number; end: number; back?: boolean; hold?: boolean; exhausted?: boolean; initialSize?: { w: number; h: number }; color?: string }) {
    if (p < start) return null;
    const t = easeInOut(phase(p, start, end)), mid = shift({ ...from, ...mix(from, to, .5) }, 20, -36);
    const at = { ...from, x: (1 - t) ** 2 * from.x + 2 * (1 - t) * t * mid.x + t * t * to.x, y: (1 - t) ** 2 * from.y + 2 * (1 - t) * t * mid.y + t * t * to.y };
    const a = initialSize ?? sizeOf(from), b = to.cardSize ?? { w: 38, h: 53.2 };
    return <><path d={`M${from.x} ${from.y} Q${mid.x} ${mid.y} ${to.x} ${to.y}`} pathLength="1" strokeDasharray="1" strokeDashoffset={1 - t} stroke={color} strokeWidth="2" opacity={envelope(p, start, start + .05, end + .12)} /><ScreenPixels at={at} opacity={visible(p, start) * (hold ? 1 : 1 - phase(p, end, end + .075))} color={color}><g transform={`rotate(${exhausted ? 10 * t : -7 * Math.sin(t * Math.PI)})`} opacity={exhausted ? 1 - .28 * t : 1}><CardGhost card={card} back={back} box={{ w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t }} /></g></ScreenPixels></>;
}
const discardDefeat = (cue: CardEffectCue, g: Geometry) => g.outcomes.find(item => {
    const o = item.outcome, unit = unitIn(cue, o.card, o.fromSeat ?? o.seat), owner = o.ownerSeat;
    return o.kind === 'defeat' && !o.prevented && !!unit && !!o.incarnation && o.incarnation === unit.incarnation && !!owner && o.zone === 'discard'
        && !unitIn(cue, unit, o.fromSeat ?? o.seat, true) && !!cue.transition?.after.players[owner].discard.some(card => same(card, unit));
});
const fellProof = (cue: CardEffectCue, g: Geometry) => {
    const defeat = discardDefeat(cue, g), unit = defeat && unitIn(cue, defeat.outcome.card, defeat.outcome.fromSeat ?? defeat.outcome.seat);
    const leaders = cue.transition && [cue.transition.before.players.p1.leader, cue.transition.before.players.p2.leader];
    return defeat && unit && unit.p >= 5 && !leaders?.some(card => same(card, unit)) ? { defeat, unit } : undefined;
};
const rivalProof = (cue: CardEffectCue, g: Geometry) => {
    const defeat = g.outcomes.find(item => {
        const o = item.outcome, owner = o.ownerSeat, leader = o.leader;
        const before = owner && cue.transition?.before.players[owner].leader, after = owner && cue.transition?.after.players[owner].leader;
        return o.kind === 'defeat' && !o.prevented && o.zone === 'leader' && !!owner && !!leader && leader.dep === 0 && leader.x === 1 && leader.epic === 1
            && same(o.card, leader) && same(before, leader) && before?.dep === 1 && !!unitIn(cue, o.card, o.fromSeat ?? o.seat)
            && same(after, leader) && after?.dep === 0 && after.x === 1 && after.epic === 1
            && !unitIn(cue, o.card, o.fromSeat ?? o.seat, true) && !cue.transition?.after.players[owner].discard.some(card => same(card, leader));
    });
    return defeat ? { defeat, unit: unitIn(cue, defeat.outcome.card, defeat.outcome.fromSeat ?? defeat.outcome.seat)! } : undefined;
};
const selectedCards = (o: CardEffectOutcome) => o.cards?.length ? o.cards : o.card ? [o.card] : [];
const searchProof = (cue: CardEffectCue, g: Geometry) => {
    const search = g.outcomes.find(item => {
        const o = item.outcome, op = o.deckOperation;
        return o.kind === 'search' && op?.policy === 'top-search-bottom' && op.scope === 'top' && op.visibility === 'private'
            && !!op.revealedIds && op.revealedIds.length === op.selectedIds.length && op.revealedIds.every(id => op.selectedIds.includes(id))
            && new Set(op.selectedIds).size === op.selectedIds.length && op.selectedIds.every(id => op.looked.some(card => card.id === id));
    });
    if (!search?.outcome.deckOperation) return;
    const op = search.outcome.deckOperation, selected = op.looked.filter(card => !!card.id && op.selectedIds.includes(card.id));
    const draws = g.outcomes.filter(item => item.outcome.kind === 'draw' && item.outcome.seat === search.outcome.seat);
    const actual = draws.flatMap(item => selectedCards(item.outcome));
    if (actual.length !== selected.length || selected.some(card => !actual.some(other => same(card, other))) || selected.some(card => !cue.transition?.after.players[search.outcome.seat].hand.some(other => same(card, other)))) return;
    return { search, op, selected, draws };
};
const loyaltyProof = (cue: CardEffectCue, g: Geometry) => {
    const defeat = discardDefeat(cue, g);
    if (!defeat || (defeat.outcome.fromSeat ?? defeat.outcome.seat) !== cue.seat) return;
    const draws = g.outcomes.filter(item => item.outcome.kind === 'draw' && item.outcome.seat === cue.seat
        && item.outcome.requiresDefeat?.id === defeat.outcome.card?.id && item.outcome.requiresDefeat?.incarnation === defeat.outcome.incarnation);
    const cards = draws.flatMap(item => selectedCards(item.outcome));
    if (draws.some(item => g.outcomes.indexOf(item) <= g.outcomes.indexOf(defeat))) return;
    return cards.length === 2 && new Set(cards.map(key)).size === 2 && cards.every(card => cue.transition?.after.players[cue.seat].hand.some(other => same(other, card))) ? { defeat, draws, cards } : undefined;
};

/** One predicate governs both rich rendering and removal of its generic receipts. */
export function batchA05SecondaryCovers(cue: CardEffectCue, g: Geometry, item: PlacedOutcome): boolean {
    switch (cue.definition.id) {
        case 'fell-the-dragon': return item === fellProof(cue, g)?.defeat;
        case 'rivals-fall': return item === rivalProof(cue, g)?.defeat;
        case 'remnant-reserves': case 'commission': { const proof = searchProof(cue, g); return !!proof && (item === proof.search || proof.draws.includes(item)); }
        case 'enforced-loyalty': { const proof = loyaltyProof(cue, g); return !!proof && (item === proof.defeat || proof.draws.includes(item)); }
        default: return false;
    }
}
function Fell({ cue, geometry: g, p }: Props) {
    const proof = fellProof(cue, g); if (!proof) return null;
    const { defeat, unit } = proof, from = atCard(g, unit, defeat.outcome.fromSeat ?? defeat.outcome.seat), s = sizeOf(from), cut = easeOut(phase(p, .25, .43));
    const upgrades = (unit.u ?? []).filter(card => !card.t && cue.transition?.after.players[card.owner ?? defeat.outcome.ownerSeat!].discard.some(other => same(card, other)));
    return <><Receipt at={shift(from, 0, -s.h / 2 - 27)} rows={[`CURRENT POWER ${unit.p} ≥ 5`, 'NON-LEADER QUALIFIES']} p={p} start={.06} until={.34} color="#f7d8b2" />
        <ScreenPixels at={shift(from, 0, -s.h / 2 - 6)} color="#e8ba7e" opacity={envelope(p, .06, .15, .4)}>{Array.from({ length: 5 }, (_, i) => <rect key={i} x={-28 + i * 12} y="-4" width="8" height="8" fill="currentColor" />)}</ScreenPixels>
        <Mask at={from} p={p} start={.33} /><ScreenPixels at={from} color="#ffd1a5" opacity={envelope(p, .21, .27, .52)}><path d={`M${-s.w * .7} ${-s.h * .7} L${-s.w * .7 + s.w * 1.4 * cut} ${-s.h * .7 + s.h * 1.4 * cut}`} strokeWidth="5" /></ScreenPixels>
        <Travel from={from} to={defeat.to} card={unit} p={p} start={.37} end={.71} hold={false} color="#efb982" />
        {upgrades.map((card, i) => { const at = g.cards?.[`${defeat.outcome.fromSeat ?? defeat.outcome.seat}:${key(card)}`] ?? shift(from, 24, -s.h / 2 + 16); const to = g.zones[`${card.owner ?? defeat.outcome.ownerSeat}:discard`] ?? defeat.to; return <g key={key(card)}><Mask at={at} p={p} start={.34} /><Travel from={at} to={to} card={card} p={p} start={.42 + .025 * i} end={.76 + .025 * i} hold={false} initialSize={{ w: 27, h: 37.8 }} color="#c4d4e9" /></g>; })}
        <Receipt at={from} rows={['DEFEATED', `OWNER ${defeat.outcome.ownerSeat!.toUpperCase()} · DISCARD`]} p={p} start={.79} color="#efc9a6" /></>;
}
function Rival({ cue, geometry: g, p }: Props) {
    const proof = rivalProof(cue, g); if (!proof) return null;
    const { defeat, unit } = proof, from = atCard(g, unit, defeat.outcome.fromSeat ?? defeat.outcome.seat), to = g.endingCards?.[`${defeat.outcome.ownerSeat}:${key(defeat.outcome.leader)}`] ?? defeat.to, s = sizeOf(from);
    return <><ScreenPixels at={from} color="#bdcfff" opacity={envelope(p, .03, .14, .4)}><path d={`M${-s.w / 2 - 9} -30 V-40 H-15 M${s.w / 2 + 9} 30 V40 H15`} strokeWidth="3" /></ScreenPixels>
        <Receipt at={center(g)} rows={['DEPLOYED LEADER CHOSEN']} p={p} start={.08} until={.39} color="#d1d9ff" />
        <Mask at={from} p={p} start={.25} /><Mask at={to} p={p} start={.61} /><Travel from={from} to={to} card={defeat.outcome.leader} p={p} start={.28} end={.69} exhausted color="#b2c5ff" />
        <Receipt at={from} rows={['LEADER DEFEATED', 'UNDEPLOYED · EXHAUSTED', 'DEPLOYMENT STILL SPENT']} p={p} start={.73} color="#ced9ff" /></>;
}
function Search({ cue, geometry: g, p }: Props) {
    const proof = searchProof(cue, g); if (!proof) return null;
    const { op, selected, search } = proof, commission = cue.definition.id === 'commission', middle = center(g), columns = Math.min(5, op.looked.length), rows = Math.ceil(op.looked.length / 5), step = 44;
    return <><Mask at={g.source} p={p} start={.08} />
        <ScreenPixels at={shift(middle, 0, -19)} opacity={envelope(p, .035, .1, .83)} color="#6685a6"><rect x="-125" y={-(rows * 65 + 65) / 2} width="250" height={rows * 65 + 65} rx="9" fill="#091522" fillOpacity=".96" strokeWidth="1" /></ScreenPixels>
        <Receipt at={shift(middle, 0, -rows * 34 - 23)} rows={[commission ? `PRIVATE TOP ${op.looked.length} · MATCH A TRAIT` : `PRIVATE TOP ${op.looked.length} · CHOOSE UP TO 3 UNITS`]} p={p} start={.05} until={commission ? .3 : .6} color="#c6ddf5" />
        {op.looked.map((card, i) => { const index = selected.findIndex(other => same(card, other)), chosen = index >= 0, at = shift(middle, ((i % 5) - (columns - 1) / 2) * step, (Math.floor(i / 5) - (rows - 1) / 2) * 65); const to = g.endingCards?.[`${search.outcome.seat}:${key(card)}`] ?? g.zones[`${search.outcome.seat}:hand`]; const reveal = chosen && p >= .29; return <g key={key(card)}>
            <ScreenPixels at={at} opacity={visible(p, .1 + i * .008) * (1 - phase(p, chosen ? .44 + index * .055 : .57, chosen ? .49 + index * .055 : .66))} color={chosen ? '#c6e7ff' : '#758ba5'}><g transform={`scale(${.88 + .12 * easeOut(phase(p, .1 + i * .008, .22 + i * .008))})`}><CardGhost card={card} back={!reveal} box={{ w: 36, h: 50.4 }} />{chosen && <rect x="-20" y="-27" width="40" height="54" rx="4" strokeWidth="2" />}</g></ScreenPixels>
            {chosen ? <Travel from={{ ...at, cardSize: { w: 36, h: 50.4 } }} to={to} card={card} p={p} start={.44 + index * .055} end={.69 + index * .055} color="#b9dbff" /> : <Travel from={{ ...at, cardSize: { w: 36, h: 50.4 } }} to={search.from} card={card} back p={p} start={.57 + i * .005} end={.76 + i * .005} hold={false} color="#7890ad" />}
        </g>; })}
        {commission && <Receipt at={shift(middle, 0, -rows * 34 - 23)} rows={[`${selected[0]?.s === 'SOR_071' ? 'ITEM SELECTED' : 'SELECTED'} · REVEAL ${selected.length}`]} p={p} start={.3} until={.61} color="#e8d8a7" />}
        <Receipt at={middle} rows={[`DRAW ${selected.length} · DECK ${cue.transition!.after.players[search.outcome.seat].deck}`, `BOTTOM ${op.looked.length - selected.length}`, ...(commission ? ['SELECTED CARD STAYS IN HAND'] : [])]} p={p} start={.84} color="#cbe1ff" /></>;
}
function Loyalty({ cue, geometry: g, p }: Props) {
    const proof = loyaltyProof(cue, g); if (!proof) return null;
    const { defeat, cards } = proof, unit = unitIn(cue, defeat.outcome.card, cue.seat)!, from = atCard(g, unit, cue.seat), s = sizeOf(from), deck = g.zones[`${cue.seat}:deck`];
    return <><Mask at={g.source} p={p} start={.08} /><ScreenPixels at={from} color="#ffd1a2" opacity={envelope(p, .05, .16, .36)}><circle r={Math.min(s.w, s.h) * .42} strokeWidth="2" /><path d="M-19 -19 L19 19 M-19 19 L19 -19" strokeWidth="3" /></ScreenPixels>
        <Receipt at={shift(from, 0, -s.h / 2 - 26)} rows={['CHOOSE FRIENDLY UNIT']} p={p} start={.05} until={.34} color="#efcea9" />
        <Mask at={from} p={p} start={.25} /><Travel from={from} to={defeat.to} card={unit} p={p} start={.28} end={.48} hold={false} color="#e9b68c" />
        <ScreenPixels at={deck} opacity={envelope(p, .46, .51, .68)} color="#b9ddff"><path d="M-25 -18 V18 M25 -18 V18 M-18 0 H18" strokeWidth="3" /><circle r={22 + 16 * phase(p, .46, .64)} /></ScreenPixels>
        {cards.map((card, i) => <Travel key={key(card)} from={{ ...shift(deck, i * 7, -i * 5), cardSize: { w: 38, h: 53.2 } }} to={g.endingCards?.[`${cue.seat}:${key(card)}`] ?? g.zones[`${cue.seat}:hand`]} card={card} p={p} start={.53 + i * .07} end={.75 + i * .07} color="#c6e1ff" />)}
        <Receipt at={from} rows={['FRIENDLY UNIT DEFEATED', `${cue.seat.toUpperCase()} DRAWS 2`]} p={p} start={.84} color="#d0e2fa" /></>;
}
export function BatchA05SecondarySignature(props: Props) {
    switch (props.cue.definition.id) {
        case 'fell-the-dragon': return <Fell {...props} />;
        case 'rivals-fall': return <Rival {...props} />;
        case 'remnant-reserves': case 'commission': return <Search {...props} />;
        case 'enforced-loyalty': return <Loyalty {...props} />;
        default: return null;
    }
}
