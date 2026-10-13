import type { CardRef, Seat, UnitRef } from '../data/types';
import type { CardEffectCue, CardEffectOutcome } from './types';
import { easeInOut, easeOut, envelope, phase } from './animationTimeline';
import { AttachmentMask, CardGhost, ResourceBalance, ResourceSlot, ScreenPixels, mix, screenShift as shift, sequence, type EffectBox, type PlacedOutcome } from './primitives';

type Geometry = { source: EffectBox; target: EffectBox; friendlyBase: EffectBox; outcomes: PlacedOutcome[]; zones: Record<string, EffectBox>; cards?: Record<string, EffectBox>; endingCards?: Record<string, EffectBox>; pockets?: Record<string, EffectBox>; endingPockets?: Record<string, EffectBox>; endingCaptured?: Record<string, EffectBox>; resourceCards?: Record<string, EffectBox>; endingResources?: Record<string, EffectBox> };
type Props = { cue: CardEffectCue; geometry: Geometry; p: number };
const ids = new Set(['evidence-of-the-crime', 'palpatines-return', 'spark-of-hope', 'rule-with-respect', 'endless-legions']);
export const isBatchA05 = (cue: CardEffectCue) => ids.has(cue.definition.id);
const key = (card?: CardRef | null) => card?.id ?? `${card?.s ?? ''}:${card?.n ?? ''}`;
const same = (a?: CardRef | null, b?: CardRef | null) => !!a && !!b && key(a) === key(b);
const number = (o: CardEffectOutcome) => typeof o.amount === 'number' ? o.amount : NaN;
const size = (at: EffectBox) => at.cardSize ?? { w: at.w * (at.sx ?? 1), h: at.h * (at.sy ?? 1) };
const visible = (p: number, start: number) => phase(p, start, start + .055);
const unitIn = (cue: CardEffectCue, card: CardRef | null | undefined, seat: Seat, after = false) => {
    const player = cue.transition?.[after ? 'after' : 'before'].players[seat];
    return [...(player?.ground ?? []), ...(player?.space ?? [])].find(unit => same(unit, card));
};
const cardAt = (g: Geometry, card: CardRef, seat: Seat, zone = 'ground') => g.cards?.[`${seat}:${key(card)}`] ?? g.zones[`${seat}:${zone}`];
const bounded = (at: EffectBox, w = 120, h = 24): EffectBox => ({ ...at,
    x: Math.max((w / 2 + 8) / (at.sx ?? 1), Math.min(1000 - (w / 2 + 8) / (at.sx ?? 1), at.x)),
    y: Math.max((h / 2 + 40) / (at.sy ?? 1), Math.min(600 - (h / 2 + 122) / (at.sy ?? 1), at.y)) });
const center = (g: Geometry) => {
    const upper = g.zones['p2:ground'], base = g.zones['p1:base'];
    return bounded({ ...g.source, x: 500, y: upper && base ? (upper.y + upper.h / 2 + base.y - base.h / 2) / 2 : 300 });
};
function Receipt({ at, rows, p, start = .7, until, color = '#dbe6ff' }: { at: EffectBox; rows: string[]; p: number; start?: number; until?: number; color?: string }) {
    const w = Math.min(242, Math.max(54, ...rows.map(row => row.length * 4.8 + 18))), h = rows.length * 18 + 6;
    return <ScreenPixels at={bounded(at, w, h)} color={color} opacity={visible(p, start) * (until ? 1 - phase(p, until - .07, until) : 1)}><rect x={-w / 2} y={-h / 2} width={w} height={h} rx="4" fill="#08111e" fillOpacity=".97" strokeWidth="1" />{rows.map((row, i) => <text key={i} y={-h / 2 + 15 + i * 18} textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '700 9px var(--font-display,sans-serif)' }}>{row}</text>)}</ScreenPixels>;
}
function Mask({ at, p, start }: { at: EffectBox; p: number; start: number }) {
    const s = size(at);
    return <ScreenPixels at={at} opacity={visible(p, start)}><rect x={-s.w / 2 - 5} y={-s.h / 2 - 5} width={s.w + 10} height={s.h + 10} rx="5" fill="#09121f" stroke="none" /></ScreenPixels>;
}
function Travel({ from, to, card, unit, p, start, end, back = false, initialSize, corridor, color = '#cce5da' }: { from: EffectBox; to: EffectBox; card: CardRef; unit?: UnitRef; p: number; start: number; end: number; back?: boolean; initialSize?: { w: number; h: number }; corridor?: number; color?: string }) {
    if (p < start) return null;
    const t = easeInOut(phase(p, start, end)), c = shift({ ...from, ...mix(from, to, .5) }, 20, -40);
    const routed = corridor !== undefined, route = [from, { ...from, x: corridor ?? from.x }, { ...to, x: corridor ?? to.x }, to];
    const travel = routed ? easeInOut(phase(p, start, start + (end - start) * .8)) : t, leg = Math.min(2, Math.floor(travel * 3));
    const at = routed ? { ...from, ...mix(route[leg], route[leg + 1], Math.min(1, travel * 3 - leg)) } : { ...from, x: (1 - t) ** 2 * from.x + 2 * (1 - t) * t * c.x + t * t * to.x, y: (1 - t) ** 2 * from.y + 2 * (1 - t) * t * c.y + t * t * to.y };
    const grow = routed ? easeOut(phase(p, start + (end - start) * .8, end)) : t, a = routed ? { w: 20, h: 28 } : initialSize ?? from.cardSize ?? { w: 42, h: 58.8 }, b = size(to), w = a.w + (b.w - a.w) * grow, h = a.h + (b.h - a.h) * grow, exhausted = unit?.x === 1;
    const path = routed ? `M${from.x} ${from.y} H${corridor} V${to.y} H${to.x}` : `M${from.x} ${from.y} Q${c.x} ${c.y} ${to.x} ${to.y}`;
    return <><path d={path} pathLength="1" strokeDasharray="1" strokeDashoffset={1 - travel} stroke={color} strokeWidth="2" opacity={envelope(p, start, start + .05, end + .09)} /><ScreenPixels at={at} color={color} opacity={visible(p, start)}><g transform={`rotate(${exhausted ? 10 * grow : -7 * Math.sin(t * Math.PI)}) scale(${exhausted ? 1 - .06 * grow : 1})`} opacity={exhausted ? 1 - .28 * grow : 1}><CardGhost card={card} back={back} box={{ w, h }} />{unit && (!routed || grow > .35) && [-1, 1].map(side => <g key={side} transform={`translate(${side * (w / 2 - 10)} ${h / 2 - 11})`}><rect x="-9" y="-10" width="18" height="20" rx="3" fill={side < 0 ? '#8b2936' : '#173f6f'} /><text textAnchor="middle" y="4" fill="#fff" stroke="none" style={{ font: '800 12px sans-serif' }}>{side < 0 ? unit.p : unit.h - unit.d}</text></g>)}</g></ScreenPixels></>;
}
function Stats({ at, unit, p, start }: { at: EffectBox; unit: UnitRef; p: number; start: number }) {
    return <>{(['power', 'hp'] as const).map((name, i) => {
        const s = size(at), counter = at.counters?.[name], position = counter ? { ...at, ...counter } : shift(at, (i ? 1 : -1) * (s.w / 2 - 10), s.h / 2 - 12);
        const w = counter ? counter.w * (at.sx ?? 1) + 2 : 22, h = counter ? counter.h * (at.sy ?? 1) + 2 : 24;
        return <ScreenPixels key={name} at={position} opacity={visible(p, start)}><rect x={-w / 2} y={-h / 2} width={w} height={h} rx="3" fill={i ? '#173f6f' : '#8b2936'} stroke="#dce7f8" strokeWidth="1" /><text textAnchor="middle" y="4" fill="#fff" stroke="none" style={{ font: '800 14px sans-serif' }}>{i ? unit.h - unit.d : unit.p}</text></ScreenPixels>;
    })}</>;
}
function EventPayment({ cue, geometry: g, p }: Props) {
    const before = cue.transition?.before.players[cue.seat], ids = cue.playPayment?.kind === 'resources' ? cue.playPayment.cardIds : undefined;
    if (!before?.resources || !ids || ids.length !== cue.playCost) return null;
    return <><ResourceBalance at={g.zones[`${cue.seat}:resources`]} countAt={g.zones[`${cue.seat}:resource-count`]} ready={before.res.ready - cue.playCost!} total={before.res.total} p={p} start={.04} />{before.resources.map((resource, i) => {
        const at = g.resourceCards?.[`${cue.seat}:${key(resource)}`];
        return at && ids.includes(key(resource)) ? <ResourceSlot key={key(resource)} at={at} index={i} spent p={p} start={.04} /> : null;
    })}</>;
}
const transferProof = (cue: CardEffectCue, g: Geometry) => {
    const item = g.outcomes.find(item => item.outcome.kind === 'attach');
    if (!item) return;
    const o = item.outcome, old = unitIn(cue, o.sourceCard, o.fromSeat ?? o.seat), target = unitIn(cue, o.targetCard, o.seat);
    const oldAfter = unitIn(cue, o.sourceCard, o.fromSeat ?? o.seat, true), targetAfter = unitIn(cue, o.targetCard, o.seat, true);
    const upgrade = old?.u?.find(upgrade => same(upgrade, o.card)), after = targetAfter?.u?.find(upgrade => same(upgrade, o.card));
    if (!old || !target || !oldAfter || !targetAfter || !upgrade || !after || !o.upgrade || !o.ownerSeat || o.controllerSeat !== cue.seat || after.controller !== cue.seat || o.upgrade.controller !== cue.seat
        || o.ownerSeat !== upgrade.owner || o.ownerSeat !== after.owner || o.ownerSeat !== o.upgrade.owner || !same(o.upgrade, upgrade) || upgrade.t || typeof o.printedCost !== 'number' || o.printedCost > 3 || o.printedCost < 0
        || upgrade.p == null || upgrade.h == null || o.upgrade.p !== upgrade.p || o.upgrade.h !== upgrade.h || old.d !== oldAfter.d || target.d !== targetAfter.d || old.x !== oldAfter.x || target.x !== targetAfter.x
        || old.incarnation !== oldAfter.incarnation || target.incarnation !== targetAfter.incarnation) return;
    const sameHost = same(old, target);
    if (targetAfter.u?.filter(card => same(card, upgrade)).length !== 1 || (sameHost ? old.p !== oldAfter.p || old.h !== oldAfter.h : oldAfter.u?.some(card => same(card, upgrade)) || old.p - upgrade.p !== oldAfter.p || old.h - upgrade.h !== oldAfter.h || target.p + upgrade.p !== targetAfter.p || target.h + upgrade.h !== targetAfter.h)) return;
    return { item, old, target, oldAfter, targetAfter, upgrade, after, sameHost };
};
const discardPlayProof = (cue: CardEffectCue, g: Geometry) => {
    const play = g.outcomes.find(item => item.outcome.kind === 'play' && item.outcome.fromZone === 'discard' && item.outcome.entryType === 'played');
    if (!play?.outcome.card?.id || !play.outcome.unit || play.outcome.entersReady !== false || play.outcome.unit.x !== 1 || play.outcome.seat !== cue.seat || play.outcome.unit.owner !== cue.seat) return;
    const card = play.outcome.card, before = cue.transition?.before.players[cue.seat], after = unitIn(cue, card, cue.seat, true);
    const cost = g.outcomes.find(item => item.outcome.kind === 'cost' && same(item.outcome.card, card) && same(item.outcome.sourceCard, card) && [-6, -8].includes(number(item.outcome)) && typeof item.outcome.printedCost === 'number');
    const pay = g.outcomes.find(item => item.outcome.kind === 'pay' && same(item.outcome.card, card) && same(item.outcome.sourceCard, card) && Number.isSafeInteger(item.outcome.amount) && number(item.outcome) >= 0 && item.outcome.cards?.length === number(item.outcome));
    if (!before?.discard.some(prior => same(prior, card)) || !after || !same(after, play.outcome.unit) || after.incarnation !== play.outcome.unit.incarnation || after.x !== 1 || after.d !== 0 || !cost || !pay
        || cue.transition?.after.players[cue.seat].discard.some(prior => same(prior, card)) || new Set(pay.outcome.cards?.map(key)).size !== number(pay.outcome)
        || !pay.outcome.cards?.every(resource => before.resources?.some(prior => same(prior, resource) && !prior.x) && cue.transition?.after.players[cue.seat].resources?.some(current => same(current, resource) && current.x === 1))) return;
    const force = cost.outcome.label?.startsWith('SELECTED FORCE'), nonForce = cost.outcome.label?.startsWith('SELECTED NON-FORCE');
    if (number(cost.outcome) === -8 ? !force : !nonForce) return;
    const eventIds = cue.playPayment?.kind === 'resources' ? cue.playPayment.cardIds : undefined;
    if (pay.outcome.cards?.some(card => eventIds?.includes(key(card))) || g.outcomes.indexOf(cost) >= g.outcomes.indexOf(pay) || g.outcomes.indexOf(pay) >= g.outcomes.indexOf(play)) return;
    return { play, cost, pay, card, reduction: -number(cost.outcome), price: number(pay.outcome), force: !!force };
};
const resourceProof = (cue: CardEffectCue, g: Geometry) => g.outcomes.find(item => {
    const o = item.outcome, before = cue.transition?.before, player = before?.players[o.seat], after = cue.transition?.after.players[o.seat], phaseEvidence = o.defeatPhase, history = before?.defeatedThisPhase;
    return o.kind === 'resource' && o.fromZone === 'discard' && o.fromSeat === o.seat && o.seat === cue.seat && o.ownerSeat === cue.seat && o.card?.owner === cue.seat && !!o.card?.id && !!o.incarnation && o.entersReady === false
        && !!phaseEvidence && !!history && phaseEvidence.round === before?.round && phaseEvidence.phase === before.phase && history.round === before.round && history.phase === before.phase
        && before.mostRecentIncarnations?.[o.card.id] === o.incarnation && history.cards.some(card => card.id === o.card!.id && card.incarnation === o.incarnation && card.lastKnownType === 'unit')
        && !!player?.discard.some(card => same(card, o.card)) && !player.resources?.some(card => same(card, o.card)) && !after?.discard.some(card => same(card, o.card))
        && after?.resources?.filter(card => same(card, o.card) && card.x === 1 && card.owner === cue.seat).length === 1 && after.res.total === player.res.total + 1;
});
const captureProof = (cue: CardEffectCue, g: Geometry) => {
    const captures = g.outcomes.filter(item => item.outcome.kind === 'capture');
    if (!captures.length || new Set(captures.map(item => key(item.outcome.card))).size !== captures.length) return;
    const before = cue.transition?.before, history = before?.attacksThisPhase;
    if (!before || !history || history.round !== before.round || history.phase !== before.phase) return;
    for (const item of captures) {
        const o = item.outcome, basis = o.captureBasis, target = unitIn(cue, o.card, o.fromSeat ?? o.seat), captor = unitIn(cue, o.sourceCard, o.seat), afterCaptor = unitIn(cue, o.sourceCard, o.seat, true);
        const attack = basis && history.attacks.find(attack => attack.id === basis.attackId);
        if (!basis || !attack || !target || !captor || !afterCaptor || o.seat !== cue.seat || o.fromSeat === cue.seat || !o.ownerSeat || target.owner !== o.ownerSeat || !o.incarnation || target.incarnation !== o.incarnation
            || basis.round !== before.round || basis.phase !== before.phase || basis.incarnation !== target.incarnation || basis.attackerId !== target.id || attack.attackerId !== target.id || attack.incarnation !== target.incarnation
            || basis.attackingSeat !== o.fromSeat || attack.attackingSeat !== basis.attackingSeat || basis.defendingSeat !== cue.seat || attack.defendingSeat !== cue.seat || basis.targetId !== before.players[cue.seat].base.id || !attack.targetIds?.includes(basis.targetId)
            || target.cap?.length || target.u?.length || same(target, before.players[o.fromSeat!].leader) || unitIn(cue, target, o.fromSeat!, true) || afterCaptor.incarnation !== captor.incarnation || afterCaptor.d !== captor.d || afterCaptor.p !== captor.p || afterCaptor.h !== captor.h || afterCaptor.x !== captor.x
            || afterCaptor.cap?.filter(card => same(card, target) && card.owner === o.ownerSeat).length !== 1 || !same(o.sourceCard, captures[0].outcome.sourceCard)) return;
    }
    const enemy: Seat = cue.seat === 'p1' ? 'p2' : 'p1', eligible = [...before.players[enemy].ground, ...before.players[enemy].space].filter(unit => !same(unit, before.players[enemy].leader) && history.attacks.some(attack => attack.attackerId === unit.id && attack.incarnation === unit.incarnation && attack.attackingSeat === enemy && attack.defendingSeat === cue.seat && attack.targetIds?.includes(before.players[cue.seat].base.id!)));
    if (eligible.length !== captures.length || eligible.some(unit => !captures.some(item => same(item.outcome.card, unit)))) return;
    return { captures, captor: unitIn(cue, captures[0].outcome.sourceCard, cue.seat)!, afterCaptor: unitIn(cue, captures[0].outcome.sourceCard, cue.seat, true)! };
};
const legionsProof = (cue: CardEffectCue, g: Geometry) => {
    const inspect = g.outcomes.find(item => item.outcome.kind === 'inspect' && item.outcome.visibility === 'public' && item.outcome.zone === 'resources' && item.outcome.fromZone === 'resources' && !!item.outcome.resourceReveal);
    const before = cue.transition?.before.players[cue.seat], after = cue.transition?.after.players[cue.seat], revealed = inspect?.outcome.cards, order = inspect?.outcome.resourceReveal?.playIds;
    if (!inspect || !before?.resources || !after?.resources || !revealed || !order || inspect.outcome.seat !== cue.seat || new Set(revealed.map(key)).size !== revealed.length || new Set(order).size !== order.length
        || !revealed.every(card => !!card.id && before.resources?.some(resource => same(resource, card))) || order.some(id => !revealed.some(card => card.id === id))) return;
    const plays = g.outcomes.filter(item => item.outcome.kind === 'play' && item.outcome.fromZone === 'resources');
    if (plays.length !== order.length || plays.some((item, i) => item.outcome.card?.id !== order[i] || item.outcome.seat !== cue.seat || item.outcome.entryType !== 'played' || item.outcome.entersReady !== false || item.outcome.unit?.x !== 1 || !same(item.outcome.card, item.outcome.unit)
        || !item.outcome.unit?.incarnation || unitIn(cue, item.outcome.card, cue.seat, true)?.incarnation !== item.outcome.unit?.incarnation || after.resources?.some(resource => same(resource, item.outcome.card)))) return;
    const payments = plays.map(play => g.outcomes.find(item => item.outcome.kind === 'pay' && same(item.outcome.card, play.outcome.card) && number(item.outcome) === 0 && item.outcome.cards?.length === 0 && g.outcomes.indexOf(item) < g.outcomes.indexOf(play)));
    if (payments.some(item => !item || g.outcomes.indexOf(item) < g.outcomes.indexOf(inspect)) || plays.some(item => g.outcomes.indexOf(item) < g.outcomes.indexOf(inspect)) || after.res.total !== before.res.total - plays.length || before.deck !== after.deck || before.hand.filter(card => !same(card, cue.source)).length !== after.hand.length) return;
    return { inspect, revealed, order, plays, payments: payments.filter((item): item is PlacedOutcome => !!item), before, after };
};

/** Rich rendering and generic receipt suppression use exactly the same compound proofs. */
export function batchA05Covers(cue: CardEffectCue, g: Geometry, item: PlacedOutcome): boolean {
    switch (cue.definition.id) {
        case 'evidence-of-the-crime': return item === transferProof(cue, g)?.item;
        case 'palpatines-return': { const proof = discardPlayProof(cue, g); return !!proof && [proof.play, proof.cost, proof.pay].includes(item); }
        case 'spark-of-hope': return item === resourceProof(cue, g);
        case 'rule-with-respect': return !!captureProof(cue, g)?.captures.includes(item);
        case 'endless-legions': { const proof = legionsProof(cue, g); return !!proof && (item === proof.inspect || proof.plays.includes(item) || proof.payments.includes(item)); }
        default: return false;
    }
}

function Evidence({ cue, geometry: g, p }: Props) {
    const proof = transferProof(cue, g); if (!proof) return null;
    const { item, old, oldAfter, target, targetAfter, upgrade, sameHost } = proof, from = item.from, to = item.to, t = easeInOut(phase(p, .25, .58));
    const at = { ...from, ...mix(from, to, t) }, a = size(from), b = size(to), w = a.w + (b.w - a.w) * t, h = a.h + (b.h - a.h) * t;
    const titleRows = t > .9 && h > 22 && w < 72 ? upgrade.n.split(' ') : [upgrade.n];
    return <><EventPayment cue={cue} geometry={g} p={p} /><Receipt at={shift(from, 0, -29)} rows={[`PRINTED ${item.outcome.printedCost} ≤ 3`]} p={p} start={.06} until={.26} color="#f0d4a1" />
        <ScreenPixels at={from} color="#e9d19e" opacity={envelope(p, .05, .13, .31)}><path d={`M${-a.w / 2 - 4} -10 V-15 H-8 M${a.w / 2 + 4} 10 V15 H8`} strokeWidth="2" /></ScreenPixels>
        <AttachmentMask at={from} p={p} start={.24} /><ScreenPixels at={at} color="#f6c454" opacity={visible(p, .24)}><g transform={`rotate(${sameHost ? 0 : -8 * Math.sin(t * Math.PI)})`}><rect x={-w / 2} y={-h / 2} width={w} height={h} rx="3" fill="#f6c454" stroke="#ffe4a1" strokeWidth="1" />{titleRows.map((row, i) => <text key={i} textAnchor="middle" y={titleRows.length > 1 ? -h / 2 + 9 + i * 9 : t > .9 ? -2 : 3} fill="#2a1d00" stroke="none" style={{ font: `600 ${Math.min(8, (w - 6) / (row.length * .55))}px sans-serif` }}>{row}</text>)}{t > .9 && <text y={titleRows.length > 1 ? h / 2 - 3 : 6} textAnchor="middle" fill="#2a1d00" stroke="none" style={{ font: '700 6px sans-serif' }}>O:{item.outcome.ownerSeat!.toUpperCase()} C:{cue.seat.toUpperCase()}</text>}</g></ScreenPixels>
        {!sameHost && <path d={`M${from.x} ${from.y} L${to.x} ${to.y}`} stroke="#e2c995" strokeWidth="1.5" strokeDasharray="3 7" opacity={envelope(p, .22, .3, .63)} />}
        <Stats at={cardAt(g, old, item.outcome.fromSeat!)} unit={oldAfter} p={p} start={.26} /><Stats at={cardAt(g, target, item.outcome.seat)} unit={targetAfter} p={p} start={.59} />
        <Receipt at={center(g)} rows={[`OWNER ${item.outcome.ownerSeat!.toUpperCase()} · CONTROL ${cue.seat.toUpperCase()}`, 'INTACT TRANSFER · BOTH HOSTS STAY', `DAMAGE UNCHANGED ${old.d} / ${target.d}`]} p={p} start={.66} color="#ead3a9" />
    </>;
}
function Return({ cue, geometry: g, p }: Props) {
    const proof = discardPlayProof(cue, g); if (!proof) return null;
    const { play, card, pay, reduction, price, force } = proof, ruler = center(g), after = cue.transition!.after.players[cue.seat];
    const priceText = price > 0 ? `${price + reduction} → ${p > .35 ? price : price + reduction}` : 'FLOOR 0';
    const selected = cue.transition!.before.players[cue.seat].resources ?? [];
    return <><EventPayment cue={cue} geometry={g} p={p} /><ScreenPixels at={play.from} color="#c5a9e9" opacity={envelope(p, .04, .16, .48)}><ellipse rx="26" ry="13" strokeWidth="3" /><ellipse rx="34" ry="17" strokeDasharray="5 6" /><path d="M0 -13 V-29 M-9 -20 L0 -29 L9 -20" strokeWidth="2" /></ScreenPixels>
        <Receipt at={shift(play.from, 0, -54)} rows={['ACTUAL OWN DISCARD', ...(cue.playCost != null ? [`EVENT PAID ${cue.playCost}`] : [])]} p={p} start={.05} until={.46} color="#d8bff2" />
        <ScreenPixels at={ruler} color="#d8bff1" opacity={visible(p, .1) * (1 - phase(p, .44, .5))}>{sequence(reduction).map(i => <rect key={i} x={-reduction * 6 + i * 12} y="-9" width="8" height="18" rx="2" fill={phase(p, .19 + i * .019, .26 + i * .019) ? '#282335' : '#b498d9'} strokeWidth="1" />)}<text y="-18" textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '700 10px sans-serif' }}>{force ? 'SELECTED FORCE' : 'SELECTED NON-FORCE'} −{reduction}</text><text y="26" textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '800 16px sans-serif' }}>{priceText}</text></ScreenPixels>
        {selected.map((resource, i) => { const at = g.resourceCards?.[`${cue.seat}:${key(resource)}`]; return at && pay.outcome.cards?.some(card => same(card, resource)) ? <ResourceSlot key={key(resource)} at={at} index={i} spent p={p} start={.36} /> : null; })}
        <Travel from={play.from} to={play.to} card={card} unit={play.outcome.unit} p={p} start={.42} end={.7} initialSize={{ w: 42, h: 58.8 }} color="#c3aae5" />
        <ResourceBalance at={g.zones[`${cue.seat}:resources`]} countAt={g.zones[`${cue.seat}:resource-count`]} ready={after.res.ready} total={after.res.total} p={p} start={.38} />
        <Receipt at={center(g)} rows={[`FROM DISCARD · ${force ? 'FORCE' : 'NON-FORCE'} −${reduction}`, `UNIT PAID ${price} · EXHAUSTED`, ...(cue.playCost != null ? [`EVENT PAID ${cue.playCost} SEPARATELY`] : [])]} p={p} start={.75} color="#d8c4ec" />
    </>;
}
function Spark({ cue, geometry: g, p }: Props) {
    const item = resourceProof(cue, g); if (!item) return null;
    const before = cue.transition!.before.players[cue.seat], after = cue.transition!.after.players[cue.seat], to = item.to, t = easeInOut(phase(p, .25, .59)), card = item.outcome.card!;
    const at = { ...item.from, ...mix(item.from, to, t) }, b = size(to);
    return <><EventPayment cue={cue} geometry={g} p={p} /><Receipt at={center(g)} rows={['LATEST UNIT ENTRY', `DEFEATED · ROUND ${item.outcome.defeatPhase!.round} ${item.outcome.defeatPhase!.phase.toUpperCase()}`]} p={p} start={.06} until={.46} color="#cbe8b0" />
        <ScreenPixels at={item.from} color="#c4e7a9" opacity={envelope(p, .08, .17, .37)}><circle r="21" strokeWidth="2" /><path d="M-9 0 L-2 7 L11 -8" strokeWidth="3" /></ScreenPixels>
        <ScreenPixels at={at} color="#c4e7a9" opacity={visible(p, .23)}><g transform={`rotate(${80 * Math.sin(t * Math.PI)})`}><CardGhost card={card} back={t > .7} box={{ w: 38 + (b.w - 38) * t, h: 53.2 + (b.h - 53.2) * t }} /></g><circle r={10 + 10 * Math.sin(t * Math.PI)} opacity={Math.sin(t * Math.PI) * .8} strokeDasharray="3 4" /></ScreenPixels>
        {after.resources?.map((resource, i) => { const at = g.endingResources?.[`${cue.seat}:${key(resource)}`]; return at ? <ResourceSlot key={key(resource)} at={at} index={i} spent={!!resource.x} p={p} start={.61} /> : null; })}
        <ResourceBalance at={g.zones[`${cue.seat}:resources`]} countAt={g.zones[`${cue.seat}:resource-count`]} ready={after.res.ready} total={after.res.total} p={p} start={.61} />
        <Receipt at={center(g)} rows={[`${card.n === 'Battlefield Marine' ? 'MARINE' : card.n.toUpperCase()} RESOURCED · EXHAUSTED`, `TOTAL ${before.res.total} → ${after.res.total} · READY ${after.res.ready}`, 'SOURCE EVENT STAYS IN DISCARD']} p={p} start={.7} color="#c8e3ac" />
    </>;
}
function Respect({ cue, geometry: g, p }: Props) {
    const proof = captureProof(cue, g); if (!proof) return null;
    const { captures, afterCaptor } = proof, pocket = g.endingPockets?.[`${cue.seat}:${key(afterCaptor)}`];
    const count = (proof.captor.cap?.length ?? 0) + captures.filter((_, i) => p >= .56 + i * .13).length;
    return <><EventPayment cue={cue} geometry={g} p={p} />{pocket && <ScreenPixels at={pocket} color="#b4d7dc" opacity={visible(p, .2)}><rect x={-size(pocket).w / 2} y={-size(pocket).h / 2} width={size(pocket).w} height={size(pocket).h} rx="5" fill="#111421" strokeWidth="1.5" /><text y={-size(pocket).h / 2 + 12} textAnchor="middle" fill="#d9e9ed" stroke="none" style={{ font: '700 7px sans-serif' }}>CAPTIVE {count}</text></ScreenPixels>}{captures.map((item, i) => {
        const from = item.from, s = size(from), end = .56 + i * .13, start = .26 + i * .13;
        return <g key={item.key}><Receipt at={shift(from, 0, -s.h / 2 - 24)} rows={['PAST BASE ATTACK ✓']} p={p} start={.06 + i * .035} until={start + .08} color="#b6dae1" />
            <ScreenPixels at={from} color="#b6dae1" opacity={envelope(p, .12 + i * .03, .23 + i * .03, start + .1)}><path d={`M${-s.w / 2 - 5} ${-s.h / 2 - 3} H${s.w / 2 + 5} V${s.h / 2 + 3} H${-s.w / 2 - 5} Z M${-s.w / 2 - 5} 0 H${s.w / 2 + 5} M0 ${-s.h / 2 - 3} V${s.h / 2 + 3}`} strokeWidth="1.5" /></ScreenPixels>
            <Mask at={from} p={p} start={start} /><Travel from={from} to={item.to} card={item.outcome.card!} p={p} start={start + .01} end={end} initialSize={s} color="#b4d7dc" />
            <ScreenPixels at={shift(item.to, 0, size(item.to).h / 2 - 3)} opacity={visible(p, end)}><rect x={-size(item.to).w / 2} y="-4" width={size(item.to).w} height="7" fill="#0d1026" stroke="none" /><text y="1" textAnchor="middle" fill="#f2e8ff" stroke="none" style={{ font: '700 6px sans-serif' }}>{item.outcome.ownerSeat!.toUpperCase()}</text></ScreenPixels>
        </g>;
    })}
        <Receipt at={center(g)} rows={[`CAPTURED ${captures.length} · OWNERS PRESERVED`, 'FRIENDLY CAPTOR STAYS', 'PAST ATTACKS · NO NEW DAMAGE']} p={p} start={.77} color="#c2e0e4" />
    </>;
}
function Legions({ cue, geometry: g, p }: Props) {
    const proof = legionsProof(cue, g); if (!proof) return null;
    const { revealed, plays, before, after } = proof, middle = center(g), shelf = shift(middle, 0, -8);
    const landed = plays.filter((_, i) => p >= .46 + i * .16).length, total = before.res.total - landed;
    const ready = cue.playCost != null ? before.res.ready - cue.playCost : after.res.ready;
    return <><EventPayment cue={cue} geometry={g} p={p} /><Receipt at={shift({ ...g.friendlyBase, x: 1000 }, 0, 24)} rows={[`PUBLIC RESOURCE REVEAL ${revealed.length}`]} p={p} start={.06} until={.3} color="#d3dfb9" />
        {revealed.map((card, i) => {
            const origin = g.resourceCards?.[`${cue.seat}:${key(card)}`] ?? g.zones[`${cue.seat}:resources`], at = shift(shelf, (i - (revealed.length - 1) / 2) * 48, 0), playIndex = plays.findIndex(item => same(item.outcome.card, card));
            const end = playIndex >= 0 ? .46 + playIndex * .16 : .88, start = playIndex >= 0 ? end - .16 : .78, arriveStart = .08 + i * .012, arriveEnd = .2 + i * .012, leave = 1 - phase(p, start, start + .03);
            const t = easeInOut(phase(p, arriveStart, arriveStart + (arriveEnd - arriveStart) * .8)), rail = 16 / (at.sx ?? 1), route = [origin, { ...origin, x: rail }, { ...at, x: rail }, at], leg = Math.min(2, Math.floor(t * 3));
            const source = { ...at, ...mix(route[leg], route[leg + 1], Math.min(1, t * 3 - leg)) }, grow = easeOut(phase(p, arriveStart + (arriveEnd - arriveStart) * .8, arriveEnd)), w = 20 + 16 * grow, h = 28 + 22.4 * grow;
            return <g key={key(card)}><AttachmentMask at={origin} p={p} start={arriveStart} /><ScreenPixels at={source} color="#d3dfb9" opacity={visible(p, arriveStart) * leave}><CardGhost card={card} back={p < .22} box={{ w, h }} />{grow > .8 && <><rect x={-w / 2 + 1} y={-h / 2 + 1} width={w - 2} height="9" fill="#101b20" stroke="none" /><text y={-h / 2 + 8} textAnchor="middle" fill="#eff4df" stroke="none" style={{ font: `800 ${playIndex >= 0 ? 7 : 5}px sans-serif` }}>{playIndex >= 0 ? `PLAY ${playIndex + 1}` : 'NON-UNIT'}</text></>}</ScreenPixels>
                {playIndex >= 0 ? <Travel from={at} to={plays[playIndex].to} card={card} unit={plays[playIndex].outcome.unit} p={p} start={start} end={end} initialSize={{ w: 36, h: 50.4 }} corridor={(plays[playIndex].outcome.zone === 'space' ? 1000 - 16 / (at.sx ?? 1) : 16 / (at.sx ?? 1))} color="#cbd7ae" /> : <>{p >= start && <Travel from={at} to={g.endingResources?.[`${cue.seat}:${key(card)}`] ?? origin} card={card} back p={p} start={start} end={end} initialSize={{ w: 36, h: 50.4 }} corridor={16 / (at.sx ?? 1)} />}</>}
            </g>;
        })}
        {before.resources?.map((resource, i) => {
            const origin = g.resourceCards?.[`${cue.seat}:${key(resource)}`], departedIndex = plays.findIndex(item => same(item.outcome.card, resource));
            return origin && departedIndex < 0 && !revealed.some(card => same(card, resource)) ? <ResourceSlot key={key(resource)} at={origin} index={i} spent={cue.playPayment?.kind === 'resources' && !!cue.playPayment.cardIds?.includes(key(resource)) || !!resource.x} p={p} start={.05} /> : null;
        })}
        {p >= .84 && <><AttachmentMask at={g.zones[`${cue.seat}:resource-cards`]} p={p} start={.84} />{after.resources?.map((resource, i) => { const at = g.endingResources?.[`${cue.seat}:${key(resource)}`]; return at ? <ResourceSlot key={key(resource)} at={at} index={i} spent={!!resource.x} p={p} start={.84} /> : null; })}</>}
        <ResourceBalance at={g.zones[`${cue.seat}:resources`]} countAt={g.zones[`${cue.seat}:resource-count`]} ready={ready} total={total} p={p} start={.08} />
        <Receipt at={shift({ ...g.friendlyBase, x: 1000 }, 0, 24)} rows={[`TOTAL ${total} · READY ${ready}`, 'FREE · ONE BY ONE']} p={p} start={.33} until={.83} color="#d3dfb9" />
        <Receipt at={middle} rows={[`FREE UNIT PLAYS ${plays.length} · ${after.res.ready}/${after.res.total}`, 'EXHAUSTED · NO DECK REPLACEMENT']} p={p} start={.83} color="#d3dfb9" />
    </>;
}

export function BatchA05Signature(props: Props) {
    switch (props.cue.definition.id) {
        case 'evidence-of-the-crime': return <Evidence {...props} />;
        case 'palpatines-return': return <Return {...props} />;
        case 'spark-of-hope': return <Spark {...props} />;
        case 'rule-with-respect': return <Respect {...props} />;
        case 'endless-legions': return <Legions {...props} />;
        default: return null;
    }
}
