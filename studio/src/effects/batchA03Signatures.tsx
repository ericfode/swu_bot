import type { CardRef, Seat, UnitRef, UpgradeRef } from '../data/types';
import type { CardEffectCue, CardEffectOutcome } from './types';
import { easeInOut, easeOut, envelope, phase } from './animationTimeline';
import { AbilityGlyph, CardGhost, CountedMarks, ScreenPixels, mix, screenShift as shift, sequence, type EffectBox, type PlacedOutcome } from './primitives';

type Geometry = { source: EffectBox; target: EffectBox; friendlyBase: EffectBox; outcomes: PlacedOutcome[]; zones: Record<string, EffectBox>; cards?: Record<string, EffectBox>; endingCards?: Record<string, EffectBox> };
type Props = { cue: CardEffectCue; geometry: Geometry; p: number };
const ids = new Set(['precision-fire', 'smoke-and-cinders', 'forced-surrender', 'no-good-to-me-dead', 'i-had-no-choice', 'bamboozle', 'disarm', 'shoot-first', 'asteroid-sanctuary', 'dont-get-cocky']);
export const isBatchA03 = (cue: CardEffectCue) => ids.has(cue.definition.id);
const key = (card?: CardRef | null) => card?.id ?? `${card?.s ?? ''}:${card?.n ?? ''}`;
const same = (a?: CardRef | null, b?: CardRef | null) => !!a && !!b && key(a) === key(b);
const amount = (o: CardEffectOutcome) => typeof o.amount === 'number' ? o.amount : 0;
const dimensions = (at: EffectBox) => at.cardSize ?? { w: at.w * (at.sx ?? 1), h: at.h * (at.sy ?? 1) };
const opacity = (p: number, start: number) => phase(p, start, start + .07);
const bounded = (at: EffectBox, halfWidth = 65, halfHeight = 12): EffectBox => ({ ...at,
    x: Math.max((halfWidth + 8) / (at.sx ?? 1), Math.min(1000 - (halfWidth + 8) / (at.sx ?? 1), at.x)),
    y: Math.max((halfHeight + 40) / (at.sy ?? 1), Math.min(600 - (halfHeight + 122) / (at.sy ?? 1), at.y)) });
const unitIn = (cue: CardEffectCue, card: CardRef | null | undefined, seat: Seat, after = false) => {
    const player = cue.transition?.[after ? 'after' : 'before'].players[seat];
    return [...(player?.ground ?? []), ...(player?.space ?? [])].find(item => same(item, card));
};
const cardAt = (g: Geometry, card: CardRef, seat: Seat, zone = 'ground') => g.cards?.[`${seat}:${key(card)}`] ?? g.zones[`${seat}:${zone}`];

/** A stack is clamped once, so its choice/destination rows retain their separation. */
function Receipt({ at, rows, p, start = .63, color = '#d9edff' }: { at: EffectBox; rows: string[]; p: number; start?: number; color?: string }) {
    const width = Math.max(78, Math.min(238, Math.max(...rows.map(row => row.length)) * 5.1 + 18));
    const height = rows.length * 19 + 5;
    return <ScreenPixels at={bounded(at, width / 2, height / 2)} color={color} opacity={opacity(p, start)}>
        <rect x={-width / 2} y={-height / 2} width={width} height={height} rx="5" fill="#080e18" fillOpacity=".97" strokeWidth="1" />
        {rows.map((row, i) => <text key={i} textAnchor="middle" y={-height / 2 + 15 + i * 19} fill="currentColor" stroke="none" style={{ font: '700 9px var(--font-display,sans-serif)', letterSpacing: '.025em' }}>{row}</text>)}
    </ScreenPixels>;
}
function Route({ from, to, p, start, end, color = '#b7d6ff', bend = 24 }: { from: EffectBox; to: EffectBox; p: number; start: number; end: number; color?: string; bend?: number }) {
    const c = shift({ ...from, ...mix(from, to, .5) }, bend, -38);
    return <path d={`M${from.x} ${from.y} Q${c.x} ${c.y} ${to.x} ${to.y}`} pathLength="1" strokeDasharray="1" strokeDashoffset={1 - easeOut(phase(p, start, end))} stroke={color} strokeWidth="2" opacity={envelope(p, start, start + .1, end + .17)} />;
}
function Travel({ from, to, card, p, start, end, back = false, hold = true, color = '#d8e9ff' }: { from: EffectBox; to: EffectBox; card?: CardRef | null; p: number; start: number; end: number; back?: boolean; hold?: boolean; color?: string }) {
    if (p < start) return null;
    const t = easeInOut(phase(p, start, end)), c = shift({ ...from, ...mix(from, to, .5) }, 24, -42);
    const at = { ...from, x: (1 - t) ** 2 * from.x + 2 * (1 - t) * t * c.x + t * t * to.x, y: (1 - t) ** 2 * from.y + 2 * (1 - t) * t * c.y + t * t * to.y };
    const a = dimensions(from), b = to.cardSize ?? { w: 39, h: 54.6 };
    return <><Route from={from} to={to} p={p} start={start} end={end} color={color} /><ScreenPixels at={at} color={color} opacity={opacity(p, start) * (hold ? 1 : 1 - phase(p, end, end + .08))}>
        <g transform={`rotate(${-7 * Math.sin(t * Math.PI)})`}><CardGhost card={card} back={back} box={{ w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t }} /></g>
    </ScreenPixels></>;
}
function Mask({ at, p, start }: { at: EffectBox; p: number; start: number }) {
    const size = dimensions(at);
    return <ScreenPixels at={at} opacity={opacity(p, start)}><rect x={-size.w / 2 - 5} y={-size.h / 2 - 5} width={size.w + 10} height={size.h + 10} rx="5" fill="#09121e" stroke="none" /></ScreenPixels>;
}
function Stats({ at, power, hp, p, start }: { at: EffectBox; power?: number; hp: number; p: number; start: number }) {
    const size = dimensions(at);
    return <ScreenPixels at={at} opacity={opacity(p, start)}>{[-1, 1].filter(side => side === 1 || power != null).map(side => <g key={side} transform={`translate(${side * (size.w / 2 - 11)} ${size.h / 2 - 12})`}>
        <rect x="-11" y="-12" width="22" height="24" rx="3" fill={side < 0 ? '#872938' : '#183f6c'} stroke="#d8e7ff" strokeWidth="1" />
        <text y="4" textAnchor="middle" fill="#fff" stroke="none" style={{ font: '800 14px var(--font-display,sans-serif)' }}>{side < 0 ? power : Math.max(0, hp)}</text>
    </g>)}</ScreenPixels>;
}
function Pose({ at, card, p, start = .28, end = .47 }: { at: EffectBox; card: UnitRef; p: number; start?: number; end?: number }) {
    const t = easeOut(phase(p, start, end));
    return <><Mask at={at} p={p} start={start} /><ScreenPixels at={at} opacity={opacity(p, start)}>
        <g transform={`rotate(${10 * t}) scale(${1 - .06 * t})`} opacity={1 - .28 * t}><CardGhost card={card} box={dimensions(at)} /></g>
    </ScreenPixels></>;
}
function Packet({ from, to, count, p, start, end, color = '#ffa682' }: { from: EffectBox; to: EffectBox; count: number; p: number; start: number; end: number; color?: string }) {
    if (count <= 0) return null;
    const at = { ...from, ...mix(from, to, easeInOut(phase(p, start, end))) };
    return <><Route from={from} to={to} p={p} start={start} end={end} color={color} bend={0} /><ScreenPixels at={at} color={color} opacity={envelope(p, start, start + .05, end + .04)}><CountedMarks count={count} color={color} /></ScreenPixels></>;
}
function Pulse({ at, p, start, color = '#ffb18b' }: { at: EffectBox; p: number; start: number; color?: string }) {
    const t = easeOut(phase(p, start, start + .18)), size = dimensions(at);
    return <ScreenPixels at={at} color={color} opacity={envelope(p, start, start + .035, start + .22)}><rect x={-size.w / 2 - 4} y={-size.h / 2 - 4} width={size.w + 8} height={size.h + 8} rx="6" fill={color} fillOpacity={.2 * (1 - t)} strokeWidth="2" /><circle r={10 + t * 48} opacity={1 - t} strokeWidth="3" /></ScreenPixels>;
}

const combat = (cue: CardEffectCue, g: Geometry) => g.outcomes.find(item => {
    const o = item.outcome, precision = cue.definition.id === 'precision-fire';
    if (o.kind !== 'attack' || !o.attackId || !o.sourceCard || !o.card || o.combatOrder !== (precision ? 'simultaneous' : 'attacker-first')) return false;
    const attacker = unitIn(cue, o.sourceCard, o.fromSeat ?? cue.seat), defender = unitIn(cue, o.card, o.seat);
    if (!attacker || !defender) return false;
    const linked = g.outcomes.filter(k => k.outcome.attackId === o.attackId);
    const forward = linked.find(k => k.outcome.kind === 'damage' && k.outcome.damageType === 'combat' && same(k.outcome.card, defender) && typeof k.outcome.amount === 'number');
    const counter = linked.find(k => k.outcome.kind === 'damage' && k.outcome.damageType === 'combat' && same(k.outcome.card, attacker) && typeof k.outcome.amount === 'number');
    if (!forward) return false;
    if (precision) return !!counter && linked.some(k => k.outcome.kind === 'keyword' && k.outcome.keyword?.name === 'Saboteur' && k.outcome.duration === 'attack');
    return !!counter || amount(forward.outcome) > 0 && amount(forward.outcome) >= defender.h - defender.d && linked.some(k => k.outcome.kind === 'defeat' && same(k.outcome.card, defender));
});
const ownDiscard = (item: PlacedOutcome) => item.outcome.kind === 'discard' && !!item.outcome.card?.id && item.outcome.fromZone === 'hand' && item.outcome.chooserSeat === item.outcome.fromSeat && item.outcome.fromSeat === item.outcome.seat;
const historyDiscard = (cue: CardEffectCue, item: PlacedOutcome) => {
    const condition = item.outcome.baseDamagePhase, before = cue.transition?.before, history = before?.baseDamagedThisPhase;
    return ownDiscard(item) && !!condition && !!history && condition.round === before?.round && condition.phase === before.phase && history.round === condition.round && history.phase === condition.phase
        && condition.player === cue.seat && history.damage.some(d => d.player === condition.player && d.targetId === condition.targetId && d.amount > 0 && !!d.sourceId);
};
const intactReturn = (o: CardEffectOutcome) => o.kind === 'return' && !!o.card?.id && !!o.fromSeat && !!o.fromZone && !!o.ownerSeat && o.seat === o.ownerSeat && (o.destination === 'hand' || o.destination === 'deck-bottom');
const attachment = (cue: CardEffectCue, o: CardEffectOutcome): UpgradeRef | undefined => unitIn(cue, o.sourceCard, o.fromSeat ?? o.seat)?.u?.find(card => same(card, o.card));
const chosenReturn = (cue: CardEffectCue, o: CardEffectOutcome) => intactReturn(o) && o.chooserSeat === (cue.seat === 'p1' ? 'p2' : 'p1') && o.selection === 'opponent' && !!unitIn(cue, o.card, o.fromSeat!);
const lock = (cue: CardEffectCue, item: PlacedOutcome) => item.outcome.kind === 'restrict' && item.outcome.restriction === 'cannot-ready' && item.outcome.duration === 'round'
    && typeof item.outcome.round === 'number' && !!item.outcome.incarnation && item.outcome.round === cue.transition?.before.round && item.outcome.incarnation === unitIn(cue, item.outcome.card, item.outcome.seat)?.incarnation;
const bamboozleEvidence = (cue: CardEffectCue, g: Geometry) => {
    const returns = g.outcomes.filter(item => intactReturn(item.outcome) && item.outcome.selection === 'all' && !!attachment(cue, item.outcome));
    const exhaust = g.outcomes.find(item => item.outcome.kind === 'exhaust' && returns.some(r => same(r.outcome.sourceCard, item.outcome.card)));
    if (!exhaust) return;
    const before = unitIn(cue, exhaust.outcome.card, exhaust.outcome.seat), after = unitIn(cue, exhaust.outcome.card, exhaust.outcome.seat, true);
    if (!before || !after || !before.u?.length || !before.u.every(upgrade => returns.some(r => same(r.outcome.card, upgrade)))) return;
    return { returns, exhaust, before, after };
};
const cockySearch = (g: Geometry) => g.outcomes.find(item => {
    const op = item.outcome.deckOperation;
    if (item.outcome.kind !== 'search' || op?.scope !== 'top' || op.visibility !== 'public' || op.policy !== 'top-search-bottom' || !op.reveal || !op.looked.length || op.reveal.runningTotals.length !== op.looked.length) return false;
    let total = 0;
    return op.looked.every((card, i) => { const cost = card.id && op.printedCosts?.[card.id]; if (typeof cost !== 'number') return false; total += cost; return op.reveal!.runningTotals[i] === total; });
});
const cockyDamage = (g: Geometry) => {
    const search = cockySearch(g), op = search?.outcome.deckOperation;
    if (!op?.reveal) return;
    const total = op.reveal.runningTotals.at(-1)!;
    return g.outcomes.find(item => item.outcome.kind === 'damage' && item.outcome.basis?.kind === 'printed-cost-sum'
        && item.outcome.basis.value === total && item.outcome.basis.threshold === op.reveal!.damageThreshold && amount(item.outcome) === total
        && total <= op.reveal!.damageThreshold && item.outcome.basis.sourceIds.length === op.looked.length && op.looked.every(card => !!card.id && item.outcome.basis!.sourceIds.includes(card.id)));
};

/** Rich proofs are optional. A recording without them keeps its observed generic receipts. */
export function batchA03Covers(cue: CardEffectCue, g: Geometry, placed: PlacedOutcome): boolean {
    const o = placed.outcome;
    switch (cue.definition.id) {
        case 'precision-fire': case 'shoot-first': {
            const attack = combat(cue, g);
            return !!attack && o.attackId === attack.outcome.attackId && ['keyword', 'buff', 'attack', 'exhaust', 'damage', 'defeat'].includes(o.kind);
        }
        case 'smoke-and-cinders': return ownDiscard(placed) && !!cue.transition?.before.players[o.seat].hand.some(card => same(card, o.card));
        case 'forced-surrender': return o.kind === 'draw' && (!!o.card || !!o.cards?.length) || !!historyDiscard(cue, placed);
        case 'no-good-to-me-dead': return lock(cue, placed) || o.kind === 'exhaust' && g.outcomes.some(item => lock(cue, item) && same(item.outcome.card, o.card));
        case 'i-had-no-choice': return chosenReturn(cue, o);
        case 'bamboozle': {
            const evidence = bamboozleEvidence(cue, g);
            return !!evidence && (evidence.returns.includes(placed) || placed === evidence.exhaust);
        }
        case 'disarm': return o.kind === 'debuff' && !!unitIn(cue, o.card, o.seat) && !!unitIn(cue, o.card, o.seat, true);
        case 'asteroid-sanctuary': return o.kind === 'exhaust' && o.seat !== cue.seat && !!unitIn(cue, o.card, o.seat) || o.kind === 'shield' && o.seat === cue.seat && !!o.cards?.length && (o.printedCost == null || o.printedCost <= 3) && !!unitIn(cue, o.card, o.seat);
        case 'dont-get-cocky': return placed === cockySearch(g) || placed === cockyDamage(g) || o.kind === 'defeat' && !!cockyDamage(g) && same(o.card, cockyDamage(g)!.outcome.card);
        default: return false;
    }
}

function Combat({ cue, geometry: g, p }: Props) {
    const attack = combat(cue, g);
    if (!attack) return null;
    const a = attack.outcome, id = a.attackId, source = a.sourceCard!, attackerSeat = a.fromSeat ?? cue.seat;
    const attacker = unitIn(cue, source, attackerSeat), defender = unitIn(cue, a.card, a.seat);
    if (!attacker || !defender) return null;
    const from = cardAt(g, attacker, attackerSeat), to = attack.box;
    const linked = g.outcomes.filter(item => item.outcome.attackId === id), hits = linked.filter(item => item.outcome.kind === 'damage');
    const forward = hits.find(item => same(item.outcome.card, defender)), counter = hits.find(item => same(item.outcome.card, attacker));
    const defeat = linked.find(item => item.outcome.kind === 'defeat' && same(item.outcome.card, defender));
    const attackerDefeat = linked.find(item => item.outcome.kind === 'defeat' && same(item.outcome.card, attacker));
    const precision = cue.definition.id === 'precision-fire', hitAt = precision ? .49 : .38, counterAt = precision ? .49 : .56;
    const lethalFirst = !precision && !counter && !!defeat && amount(forward?.outcome ?? a) > 0 && amount(forward?.outcome ?? a) >= defender.h - defender.d;
    const bonus = linked.find(item => item.outcome.kind === 'buff' && item.outcome.duration === 'attack');
    const shields = linked.filter(item => item.outcome.kind === 'defeat' && defender.u?.some(u => same(u, item.outcome.card) && u.n === 'Shield'));
    const sentinel = cue.transition?.before.players[a.seat].ground.find(unit => unit.sn && !same(unit, defender));
    return <>
        {precision && sentinel && <ScreenPixels at={cardAt(g, sentinel, a.seat)} opacity={envelope(p, .04, .16, .44)} color="#8eb1cc"><rect x={-dimensions(cardAt(g, sentinel, a.seat)).w / 2 - 5} y={-dimensions(cardAt(g, sentinel, a.seat)).h / 2 - 5} width={dimensions(cardAt(g, sentinel, a.seat)).w + 10} height={dimensions(cardAt(g, sentinel, a.seat)).h + 10} rx="5" strokeDasharray="4 5" /><path d="M-13 -8 L13 8 M-13 8 L13 -8" strokeWidth="2" /></ScreenPixels>}
        <Receipt at={shift(from, 0, -dimensions(from).h / 2 - 26)} rows={[precision ? 'SABOTEUR · THIS ATTACK' : 'ATTACKER DEALS DAMAGE FIRST', ...(bonus ? [String(bonus.outcome.amount) + ' · THIS ATTACK'] : [])]} p={p} start={.05} color="#ffdba1" />
        {precision && <Route from={from} to={to} p={p} start={.08} end={.31} color="#ffdc9e" bend={38} />}
        {shields.length > 0 && <ScreenPixels at={to} opacity={envelope(p, .13, .25, .39)} color="#c3ecff"><g transform={`scale(${1 + phase(p, .25, .39) * .55})`}><path d="M0 -40 L28 -25 V8 Q20 34 0 42 Q-20 34 -28 8 V-25 Z" strokeWidth="3" /><path d={`M${-20 - phase(p, .24, .35) * 16} -8 L${20 + phase(p, .24, .35) * 16} 8`} stroke="#ffcf98" strokeWidth="4" /></g></ScreenPixels>}
        {shields.filter(shield => shield.box.exact).map(shield => <Mask key={shield.key} at={shield.box} p={p} start={.25} />)}
        <Pose at={from} card={attacker} p={p} start={.2} end={.36} />
        {forward && <Packet from={from} to={to} count={amount(forward.outcome)} p={p} start={hitAt - .12} end={hitAt} />}
        {counter && <Packet from={to} to={from} count={amount(counter.outcome)} p={p} start={counterAt - .12} end={counterAt} color="#c7d6ff" />}
        {forward && amount(forward.outcome) > 0 && <Pulse at={to} p={p} start={hitAt} />}{counter && amount(counter.outcome) > 0 && <Pulse at={from} p={p} start={counterAt} color="#c7d6ff" />}
        {lethalFirst && <><path d={`M${to.x} ${to.y} L${mix(to, from, .22).x} ${mix(to, from, .22).y}`} opacity={envelope(p, .29, .36, .46)} stroke="#acbddb" strokeDasharray="4 6" strokeWidth="2" /><ScreenPixels at={shift(to, 0, 0)} opacity={opacity(p, .4)} color="#ffb5a0"><AbilityGlyph kind="defeat" size={25} /></ScreenPixels></>}
        {defeat && <><Mask at={to} p={p} start={hitAt + .055} /><Travel from={to} to={defeat.to} card={defender} p={p} start={hitAt + .07} end={.78} hold={false} color="#ffb797" /><Receipt at={shift(to, 0, 0)} rows={[lethalFirst ? 'DEFEATED BEFORE COUNTER' : 'DEFENDER DEFEATED']} p={p} start={.78} color="#ffba9f" /></>}
        {attackerDefeat ? <><Mask at={from} p={p} start={counterAt + .04} /><Travel from={from} to={attackerDefeat.to} card={attacker} p={p} start={counterAt + .06} end={.81} hold={false} /></> : <Stats at={from} power={attacker.p} hp={attacker.h - attacker.d - (counter ? amount(counter.outcome) : 0)} p={p} start={counter ? counterAt : hitAt} />}
        {!defeat && forward && <Stats at={to} hp={defender.h - defender.d - amount(forward.outcome)} p={p} start={hitAt} />}
        <Receipt at={shift(from, 0, dimensions(from).h / 2 + 20)} rows={[precision ? `${amount(forward?.outcome ?? a)} ↔ ${counter ? amount(counter.outcome) : '?'} · SIMULTANEOUS` : lethalFirst ? 'COUNTER INTERRUPTED · NO DAMAGE' : counter ? `${amount(counter.outcome)} COUNTER DAMAGE` : 'OBSERVED ATTACK', 'EXHAUSTED · ATTACK BONUS ENDS']} p={p} start={.8} color="#cddfff" />
    </>;
}

function Smoke({ cue, geometry: g, p }: Props) {
    if (!cue.transition) return null;
    return <><Mask at={g.source} p={p} start={.03} />{(['p2', 'p1'] as Seat[]).map(seat => {
        const chosen = g.outcomes.filter(item => ownDiscard(item) && item.outcome.seat === seat);
        if (!chosen.length) return null;
        const before = cue.transition!.before.players[seat].hand.filter(card => !same(card, cue.source));
        const kept = before.filter(card => !chosen.some(item => same(item.outcome.card, card)));
        const at = g.zones[`${seat}:hand`];
        return <g key={seat}>
            {before.map(card => {
                const from = cardAt(g, card, seat, 'hand'), selected = chosen.find(item => same(item.outcome.card, card));
                const to = selected?.to ?? g.endingCards?.[`${seat}:${key(card)}`] ?? from;
                return <g key={key(card)}><Mask at={from} p={p} start={.07} />{selected && <ScreenPixels at={from} opacity={opacity(p, .07) * (1 - phase(p, .31, .36))} color="#ffbf9d"><CardGhost back box={dimensions(from)} /></ScreenPixels>}<Travel from={from} to={to} card={card} back p={p} start={selected ? .31 : .1} end={selected ? .69 : .35} hold={!selected} color={selected ? '#ffbf9d' : '#bde1ff'} /></g>;
            })}
            <Receipt at={shift(at, 0, seat === 'p1' ? -dimensions(at).h / 2 - 38 : dimensions(at).h / 2 + 35)} rows={[`${seat.toUpperCase()} CHOOSES OWN HAND`, `KEEP ${kept.length} · DISCARD ${chosen.length}`]} p={p} start={.12} color="#e6c8a8" />
            <Pulse at={chosen[0].to} p={p} start={.7} color="#e6c8a8" />
        </g>;
    })}</>;
}
function Forced({ cue, geometry: g, p }: Props) {
    const draws = g.outcomes.filter(item => item.outcome.kind === 'draw' && (!!item.outcome.card || !!item.outcome.cards?.length));
    const discards = g.outcomes.filter(item => historyDiscard(cue, item));
    return <>
        {draws.flatMap(item => (item.outcome.cards ?? (item.outcome.card ? [item.outcome.card] : [])).map((card, i) => <Travel key={key(card)} from={shift(item.from, i * 7, -i * 4)} to={g.endingCards?.[`${item.outcome.seat}:${key(card)}`] ?? item.to} card={card} p={p} start={.18 + i * .055} end={.59 + i * .055} color="#c0ddff" />))}
        {draws.length > 0 && <Receipt at={shift(draws[0].from, 0, -45)} rows={[`DRAW ${draws.reduce((n, item) => n + (item.outcome.cards?.length ?? 1), 0)}`]} p={p} start={.1} color="#c0ddff" />}
        {discards.map((item, i) => <g key={item.key}><Mask at={item.from} p={p} start={.25} /><Travel from={item.from} to={item.to} card={item.outcome.card} back p={p} start={.24 + i * .06} end={.62 + i * .06} hold={false} color="#ffc298" /></g>)}
        {discards.length > 0 && <>
            <Receipt at={shift(g.zones[`${discards[0].outcome.seat}:base`], 0, -50)} rows={[`${cue.seat.toUpperCase()} DAMAGED THIS BASE`, 'EARLIER · THIS ACTION PHASE']} p={p} start={.05} color="#ffd1a4" />
            <Receipt at={discards[0].to} rows={[`${discards[0].outcome.chooserSeat!.toUpperCase()} CHOOSES OWN DISCARDS`, `${discards.length} TO DISCARD`]} p={p} start={.68} color="#ffd1a4" />
        </>}
    </>;
}
function NoGood({ cue, geometry: g, p }: Props) {
    const restriction = g.outcomes.find(item => lock(cue, item));
    if (!restriction) return null;
    const unit = unitIn(cue, restriction.outcome.card, restriction.outcome.seat);
    if (!unit) return null;
    const at = restriction.box, size = dimensions(at), close = easeOut(phase(p, .08, .33));
    return <>
        <ScreenPixels at={at} color="#c4b7ff" opacity={envelope(p, .03, .18, .57)}>{[-1, 1].map(side => <path key={side} d={`M${side * (size.w / 2 + 25 - close * 20)} ${-size.h / 2 - 7} V${size.h / 2 + 7} h${-side * 13}`} strokeWidth="4" />)}</ScreenPixels>
        <Pose at={at} card={unit} p={p} start={.27} end={.5} />
        <Stats at={at} power={unit.p} hp={unit.h - unit.d} p={p} start={.47} />
        <ScreenPixels at={shift(at, 0, -size.h / 2 - 26)} color="#d6caff" opacity={opacity(p, .4)}><AbilityGlyph kind="restrict" size={23} /></ScreenPixels>
        <Receipt at={shift(at, 0, size.h / 2 + 35)} rows={['EXHAUSTED · CANNOT READY', `REST OF ROUND ${restriction.outcome.round}`]} p={p} start={.55} color="#d6caff" />
    </>;
}
function NoChoice({ cue, geometry: g, p }: Props) {
    const moved = g.outcomes.filter(item => chosenReturn(cue, item.outcome));
    return <>{moved.map((item, i) => {
        const o = item.outcome, bottom = o.destination === 'deck-bottom';
        return <g key={item.key}>
            <ScreenPixels at={item.from} color="#c9baff" opacity={envelope(p, .03, .17, .4)}><rect x={-dimensions(item.from).w / 2 - 4} y={-dimensions(item.from).h / 2 - 4} width={dimensions(item.from).w + 8} height={dimensions(item.from).h + 8} rx="6" strokeDasharray="5 4" /><path d="M-12 0 H12 M0 -12 V12" strokeWidth="2" /></ScreenPixels>
            <Receipt at={shift(item.from, 0, -dimensions(item.from).h / 2 - 31)} rows={[`${o.chooserSeat!.toUpperCase()} CHOOSES`, `${o.ownerSeat!.toUpperCase()} OWNER ${bottom ? 'DECK BOTTOM' : 'HAND'}`]} p={p} start={.17 + i * .04} color="#dbcbff" />
            <Mask at={item.from} p={p} start={.32} /><Travel from={item.from} to={item.to} card={o.card} p={p} start={.32 + i * .04} end={.7 + i * .04} hold={!bottom} color="#d2c2ff" />
            {bottom && <ScreenPixels at={shift(item.to, 0, 19)} color="#d8c6ff" opacity={opacity(p, .71)}><path d="M-24 -7 V9 H24 V-7 M-16 15 H16" strokeWidth="3" /></ScreenPixels>}
        </g>;
    })}</>;
}
function Bamboozle({ cue, geometry: g, p }: Props) {
    const evidence = bamboozleEvidence(cue, g);
    if (!evidence) return null;
    const { returns, exhaust: hostReceipt, before: host, after } = evidence;
    const alternate = cue.playPayment?.kind === 'alternate-discard' && cue.playPayment.sourceId === cue.source?.id && cue.playPayment.replacesAllCosts ? cue.playPayment : null;
    const at = hostReceipt.box;
    return <>
        {alternate && alternate.cards.map(card => <g key={key(card)}><Mask at={cardAt(g, card, cue.seat, 'hand')} p={p} start={.07} /><Travel from={cardAt(g, card, cue.seat, 'hand')} to={g.zones[`${cue.seat}:discard`]} card={card} p={p} start={.06} end={.29} hold={false} color="#efd29a" /></g>)}
        {alternate && <Receipt at={shift(g.zones[`${cue.seat}:discard`], 0, -45)} rows={['DISCARD CUNNING CARD', 'REPLACES ALL COSTS · 0 RESOURCES']} p={p} start={.1} color="#f0d59a" />}
        <Pose at={at} card={host} p={p} start={.32} end={.54} />
        {returns.map((item, i) => {
            const upgrade = attachment(cue, item.outcome)!;
            const start = .31 + i * .065;
            return <g key={item.key}>{upgrade.t ? <ScreenPixels at={item.from} color="#d6bdff" opacity={envelope(p, start, start + .07, start + .23)}><circle r={14 * (1 - easeOut(phase(p, start, start + .23)))} strokeWidth="3" /><AbilityGlyph kind={upgrade.n === 'Shield' ? 'shield' : 'buff'} size={18 * (1 - phase(p, start, start + .23))} /></ScreenPixels>
                : <Travel from={{ ...item.from, cardSize: { w: 42, h: 58.8 } }} to={item.to} card={upgrade} p={p} start={start} end={.73 + i * .045} color="#d8c5ff" />}</g>;
        })}
        <Stats at={at} power={p < .67 ? host.p : after.p} hp={p < .67 ? host.h - host.d : after.h - after.d} p={p} start={.32} />
        <Receipt at={shift(at, 0, dimensions(at).h / 2 + 40)} rows={[`HOST STAYS · ${host.p}/${host.h} → ${after.p}/${after.h}`, returns.some(item => attachment(cue, item.outcome)?.t) ? 'UPGRADES TO OWNERS · TOKENS CEASE' : 'UPGRADES TO OWNERS']} p={p} start={.76} color="#e3d3ff" />
        {returns.filter(item => !attachment(cue, item.outcome)?.t).map(item => <Receipt key={item.key} at={shift(item.to, 0, -dimensions(item.to).h / 2 - 18)} rows={[`${item.outcome.ownerSeat!.toUpperCase()} OWNER HAND`]} p={p} start={.84} color="#e3d3ff" />)}
    </>;
}
function Disarm({ cue, geometry: g, p }: Props) {
    const item = g.outcomes.find(item => batchA03Covers(cue, g, item));
    if (!item) return null;
    const before = unitIn(cue, item.outcome.card, item.outcome.seat)!, after = unitIn(cue, item.outcome.card, item.outcome.seat, true)!;
    const drain = easeInOut(phase(p, .16, .5)), visiblePower = Math.round(before.p + (after.p - before.p) * drain);
    const at = item.box, gauge = shift(at, 0, -dimensions(at).h / 2 - 32), notchCount = Math.max(1, Math.min(8, before.p));
    return <>
        <ScreenPixels at={gauge} color="#e5bcff" opacity={opacity(p, .04)}>
            <rect x="-64" y="-16" width="128" height="32" rx="4" fill="#121321" strokeWidth="1" />
            {sequence(notchCount).map(i => <rect key={i} x={-44 + i * 12} y="-7" width="8" height="14" fill={i < visiblePower ? '#d1a5fb' : '#252536'} stroke="none" />)}
            <path d="M-49 -10 V10" stroke="#fff" strokeWidth="3" /><text x="52" y="4" textAnchor="middle" fill="#fff" stroke="none" style={{ font: '800 13px sans-serif' }}>{visiblePower}</text>
        </ScreenPixels>
        <Pulse at={at} p={p} start={.47} color="#d5abff" /><Stats at={at} power={visiblePower} hp={after.h - after.d} p={p} start={.16} />
        <Receipt at={shift(at, 0, dimensions(at).h / 2 + 32)} rows={[`POWER ${before.p} → ${after.p} · FLOOR 0`, ...(item.outcome.duration === 'phase' ? ['THIS PHASE'] : [])]} p={p} start={.6} color="#dfbdff" />
    </>;
}
function Asteroid({ cue, geometry: g, p }: Props) {
    const exhaust = g.outcomes.find(item => item.outcome.kind === 'exhaust' && batchA03Covers(cue, g, item));
    const shield = g.outcomes.find(item => item.outcome.kind === 'shield' && batchA03Covers(cue, g, item));
    return <>
        {exhaust && <>
            <ScreenPixels at={exhaust.box} color="#b4a7ca" opacity={envelope(p, .04, .23, .55)}>{sequence(5).map(i => <g key={i} transform={`translate(${-82 + phase(p, .04 + i * .025, .4 + i * .025) * 160} ${(i - 2) * 22}) rotate(${i * 27})`}><path d="M-10 -7 L3 -12 L12 -1 L6 11 L-7 8 Z" fill="#65576e" fillOpacity=".72" strokeWidth="2" /></g>)}</ScreenPixels>
            <Pose at={exhaust.box} card={unitIn(cue, exhaust.outcome.card, exhaust.outcome.seat)!} p={p} start={.25} end={.48} />
            <Stats at={exhaust.box} power={unitIn(cue, exhaust.outcome.card, exhaust.outcome.seat)!.p} hp={unitIn(cue, exhaust.outcome.card, exhaust.outcome.seat)!.h - unitIn(cue, exhaust.outcome.card, exhaust.outcome.seat)!.d} p={p} start={.48} />
            <Receipt at={shift(exhaust.box, 0, dimensions(exhaust.box).h / 2 + 26)} rows={['ENEMY EXHAUSTED']} p={p} start={.54} color="#dbcbeb" />
        </>}
        {shield && <>
            <ScreenPixels at={shield.box} color="#a5e9ff" opacity={opacity(p, .38)}><g transform={`scale(${.6 + easeOut(phase(p, .38, .61)) * .4})`}><path d={`M0 ${-dimensions(shield.box).h * .58} L${dimensions(shield.box).w * .6} ${-dimensions(shield.box).h * .35} V12 Q24 38 0 ${dimensions(shield.box).h * .6} Q-24 38 ${-dimensions(shield.box).w * .6} 12 V${-dimensions(shield.box).h * .35} Z`} fill="#85d8f4" fillOpacity=".12" strokeWidth="3" /><AbilityGlyph kind="shield" size={25} /></g></ScreenPixels>
            <Receipt at={shift(shield.box, 0, -dimensions(shield.box).h / 2 - 29)} rows={['FRIENDLY SHIELD', ...(shield.outcome.printedCost != null ? [`PRINTED COST ${shield.outcome.printedCost} ≤ 3`] : [])]} p={p} start={.63} color="#b8ecff" />
        </>}
    </>;
}
function Cocky({ cue, geometry: g, p }: Props) {
    const search = cockySearch(g);
    if (!search) return null;
    const op = search.outcome.deckOperation!, reveal = op.reveal!, count = op.looked.length;
    const at = bounded({ ...g.source, x: 500, y: 295 }, 142, 82);
    const last = reveal.runningTotals.at(-1)!, bust = last > reveal.damageThreshold;
    const revealStep = Math.min(.1, .32 / count), settled = .1 + (count - 1) * revealStep + .07, stopAt = settled + .06;
    const shown = Math.max(0, Math.min(count, Math.floor((p - .1) / revealStep) + 1)), total = shown ? reveal.runningTotals[shown - 1] : 0;
    const hit = cockyDamage(g), defeated = hit && g.outcomes.find(item => item.outcome.kind === 'defeat' && same(item.outcome.card, hit.outcome.card));
    return <>
        <ScreenPixels at={at} color={bust && p >= stopAt ? '#ff9e9c' : '#f8d9a4'} opacity={opacity(p, .03) * (1 - phase(p, .66, .77))}>
            <rect x="-134" y="-83" width="268" height="134" rx="8" fill="#0a101d" fillOpacity=".94" strokeWidth="1" />
            <text x="0" y="-65" textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '700 9px sans-serif', letterSpacing: '.06em' }}>PUBLIC · TOP CARDS ONE AT A TIME</text>
            {op.looked.map((card, i) => <g key={key(card)} opacity={opacity(p, .1 + i * revealStep)} transform={`translate(${(i - (count - 1) / 2) * Math.min(49, 230 / count)} -21)`}>
                <CardGhost card={card} box={{ w: Math.min(40, 205 / count), h: Math.min(56, 287 / count) }} />
                <rect x="-11" y="14" width="22" height="19" rx="3" fill="#0a1422" /><text y="27" textAnchor="middle" fill="#fff" stroke="none" style={{ font: '800 11px sans-serif' }}>{op.printedCosts![card.id!]}</text>
            </g>)}
            {sequence(reveal.damageThreshold).map(i => <rect key={i} x={-108 + i * 28} y="44" width="23" height="10" rx="2" fill={i < total ? total > reveal.damageThreshold ? '#ff8b91' : '#ecc48c' : '#283243'} stroke="none" />)}
            <text x="111" y="53" textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '800 14px sans-serif' }}>{total}</text>
            {p >= stopAt && <g opacity={opacity(p, stopAt)}><rect x="-85" y="67" width="170" height="24" rx="4" fill={bust ? '#501f2b' : '#26383d'} /><text textAnchor="middle" y="83" fill="#fff" stroke="none" style={{ font: '800 10px sans-serif' }}>{bust ? `${last} > ${reveal.damageThreshold} · NO DAMAGE` : `${reveal.stop === 'chosen' ? 'STOP' : reveal.stop.toUpperCase()} · SUM ${last}`}</text></g>}
        </ScreenPixels>
        <Receipt at={shift(search.to, 0, -78)} rows={[bust ? `SUM ${last} > ${reveal.damageThreshold} · NO DAMAGE` : `${reveal.stop === 'chosen' ? 'STOP' : reveal.stop.toUpperCase()} · PRINTED SUM ${last}`]} p={p} start={.78} color={bust ? '#ffadaa' : '#f8d9a4'} />
        {!bust && hit && <><Packet from={shift(at, 0, 48)} to={hit.box} count={amount(hit.outcome)} p={p} start={stopAt + .06} end={.67} />{amount(hit.outcome) > 0 && <Pulse at={hit.box} p={p} start={.67} />}{unitIn(cue, hit.outcome.card, hit.outcome.seat, true) && <Stats at={hit.box} hp={unitIn(cue, hit.outcome.card, hit.outcome.seat, true)!.h - unitIn(cue, hit.outcome.card, hit.outcome.seat, true)!.d} p={p} start={.68} />}{defeated && <><Mask at={hit.box} p={p} start={.72} /><Travel from={hit.box} to={defeated.to} card={hit.outcome.card} p={p} start={.73} end={.91} hold={false} /><Receipt at={hit.box} rows={['UNIT DEFEATED']} p={p} start={.88} color="#ffb29b" /></>}</>}
        {op.looked.map((card, i) => {
            const order = op.remainingOrder.slice(-count).findIndex(item => same(item, card));
            return <Travel key={`bottom-${key(card)}`} from={shift(at, (i - (count - 1) / 2) * Math.min(49, 230 / count), -21)} to={shift(search.to, order * 4, order * 3)} card={card} p={p} start={.68 + order * .04 / count} end={.74 + order * .04 / count} hold={false} color="#e8cda8" />;
        })}
        <Receipt at={shift(search.to, 0, -42)} rows={['REVEALED → RANDOM DECK BOTTOM', `DECK COUNT ${cue.transition?.after.players[search.outcome.seat].deck ?? 'UNCHANGED'}`]} p={p} start={.87} color="#eed1a3" />
    </>;
}

export function BatchA03Signature(props: Props) {
    switch (props.cue.definition.id) {
        case 'precision-fire': case 'shoot-first': return <Combat {...props} />;
        case 'smoke-and-cinders': return <Smoke {...props} />;
        case 'forced-surrender': return <Forced {...props} />;
        case 'no-good-to-me-dead': return <NoGood {...props} />;
        case 'i-had-no-choice': return <NoChoice {...props} />;
        case 'bamboozle': return <Bamboozle {...props} />;
        case 'disarm': return <Disarm {...props} />;
        case 'asteroid-sanctuary': return <Asteroid {...props} />;
        case 'dont-get-cocky': return <Cocky {...props} />;
        default: return null;
    }
}
