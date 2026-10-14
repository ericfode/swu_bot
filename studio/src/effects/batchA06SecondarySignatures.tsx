import type { CardRef, Seat, UnitRef } from '../data/types';
import type { CardEffectCue, CardEffectOutcome } from './types';
import { easeInOut, envelope, phase } from './animationTimeline';
import { CardGhost, ScreenPixels, CountedMarks, ResourceBalance, ResourceSlot, mix, screenShift as shift, type EffectBox, type PlacedOutcome } from './primitives';

type Geometry = { source: EffectBox; target: EffectBox; friendlyBase: EffectBox; outcomes: PlacedOutcome[]; zones: Record<string, EffectBox>; cards?: Record<string, EffectBox>; endingCards?: Record<string, EffectBox>; pockets?: Record<string, EffectBox>; resourceCards?: Record<string, EffectBox> };
type Props = { cue: CardEffectCue; geometry: Geometry; p: number };
const ids = new Set(['moment-of-glory', 'cripple-authority', 'the-chaos-of-war', 'desperate-attack', 'pillage']);
export const isBatchA06Secondary = (cue: CardEffectCue) => ids.has(cue.definition.id);
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
const num = (o: CardEffectOutcome) => typeof o.amount === 'number' ? o.amount : NaN;
const cardList = (o: CardEffectOutcome) => o.cards?.length ? o.cards : o.card ? [o.card] : [];
const sameIds = (a: CardRef[], ids: string[]) => a.length === ids.length && new Set(ids).size === ids.length && a.every(c => !!c.id && ids.includes(c.id));
const group = (items: PlacedOutcome[]) => items.length > 0 && !!items[0].outcome.resolutionGroup?.id && items.every(item => item.outcome.resolutionGroup?.mode === 'simultaneous' && item.outcome.resolutionGroup.id === items[0].outcome.resolutionGroup!.id);
function Payment({ cue, geometry: g, p }: Props) {
    const before = cue.transition?.before.players[cue.seat], paid = cue.playPayment?.kind === 'resources' ? cue.playPayment.cardIds : undefined;
    if (!before?.resources || cue.playCost == null || !paid || paid.length !== cue.playCost) return null;
    return <>{before.resources.map((r, i) => { const at = g.resourceCards?.[`${cue.seat}:${key(r)}`]; return at && paid.includes(key(r)) ? <ResourceSlot key={key(r)} at={at} index={i} spent p={p} start={.04} /> : null; })}<ResourceBalance at={g.zones[`${cue.seat}:resources`]} countAt={g.zones[`${cue.seat}:resource-count`]} ready={before.res.ready - cue.playCost} total={before.res.total} p={p} start={.04} /></>;
}
function Stats({ at, unit, p, start }: { at: EffectBox; unit: UnitRef; p: number; start: number }) {
    return <>{(['power', 'hp'] as const).map((name, i) => { const s = sizeOf(at), counter = at.counters?.[name], pos = counter ? { ...at, ...counter } : shift(at, (i ? 1 : -1) * (s.w / 2 - 10), s.h / 2 - 12); return <ScreenPixels key={name} at={pos} opacity={visible(p, start)}><rect x="-11" y="-12" width="22" height="24" rx="3" fill={i ? '#173f6f' : '#8b2936'} stroke="#e2e9f7" strokeWidth="1" /><text textAnchor="middle" y="5" fill="#fff" stroke="none" style={{ font: '800 14px sans-serif' }}>{i ? unit.h - unit.d : unit.p}</text></ScreenPixels>; })}</>;
}
function BaseHp({ cue, item, p, start }: { cue: CardEffectCue; item: PlacedOutcome; p: number; start: number }) {
    const after = cue.transition!.after.players[item.outcome.seat].base, at = item.box, counter = at.counters?.hp;
    const pos = counter ? { ...at, ...counter } : shift(at, sizeOf(at).w / 2 - 9, -sizeOf(at).h / 2 + 10), d = counter ? Math.max(counter.w * (at.sx ?? 1), counter.h * (at.sy ?? 1)) : 39;
    return <ScreenPixels at={pos} opacity={visible(p, start)}><circle r={d / 2 + 1} fill="#08111e" stroke="#e98983" strokeWidth="3" /><text textAnchor="middle" y="5" fill="#fff" stroke="none" style={{ font: '800 17px sans-serif' }}>{Math.max(0, after.hp - after.d)}</text></ScreenPixels>;
}
const gloryProof = (cue: CardEffectCue, g: Geometry) => {
    const item = g.outcomes.find(i => i.outcome.kind === 'buff' && i.outcome.duration === 'phase' && i.outcome.amount === '+4/+4');
    if (!item) return;
    const o = item.outcome, before = unitIn(cue, o.card, o.seat), after = unitIn(cue, o.card, o.seat, true);
    if (!before || !after || !before.incarnation || before.incarnation !== after.incarnation || after.p !== before.p + 4 || after.h !== before.h + 4 || after.d !== before.d || after.x !== before.x || !after.status?.some(s => s.kind === 'buff' && s.duration === 'phase')) return;
    return { item, before, after };
};
const crippleProof = (cue: CardEffectCue, g: Geometry) => {
    const draw = g.outcomes.find(i => i.outcome.kind === 'draw' && i.outcome.seat === cue.seat), discard = g.outcomes.find(i => i.outcome.kind === 'discard' && i.outcome.seat !== cue.seat);
    if (!draw || !discard || !cue.transition || !group([draw, discard])) return;
    const o = discard.outcome, condition = o.condition, before = cue.transition.before, after = cue.transition.after, drawn = cardList(draw.outcome);
    if (drawn.length !== 1 || !drawn[0].id || !same(before.players[cue.seat].knownDeck?.[0], drawn[0]) || !after.players[cue.seat].hand.some(c => same(c, drawn[0])) || after.players[cue.seat].deck !== before.players[cue.seat].deck - 1
        || condition?.kind !== 'resources-more' || condition.player !== o.seat || condition.than !== cue.seat || condition.total !== before.players[o.seat].res.total || condition.thanTotal !== before.players[cue.seat].res.total || condition.total <= condition.thanTotal
        || !o.card?.id || o.fromZone !== 'hand' || o.fromSeat !== o.seat || o.chooserSeat !== o.seat || !before.players[o.seat].hand.some(c => same(c, o.card)) || after.players[o.seat].hand.some(c => same(c, o.card)) || !after.players[o.seat].discard.some(c => same(c, o.card))) return;
    return { draw, discard, drawn: drawn[0], condition };
};
const chaosProof = (cue: CardEffectCue, g: Geometry) => {
    const hits = g.outcomes.filter(i => i.outcome.kind === 'damage');
    if (hits.length !== 2 || new Set(hits.map(i => i.outcome.seat)).size !== 2 || !cue.transition || !group(hits)) return;
    for (const item of hits) { const o = item.outcome, before = cue.transition.before.players[o.seat], after = cue.transition.after.players[o.seat], hand = before.hand.filter(c => !same(c, cue.source)), basis = o.basis;
        if (o.zone !== 'base' || o.damageType !== 'ability' || !same(o.card, before.base) || basis?.kind !== 'hand-count' || basis.player !== o.seat || !sameIds(hand, basis.sourceIds) || basis.value !== hand.length || num(o) !== hand.length || after.base.d !== before.base.d + hand.length || !sameIds(after.hand, hand.map(c => c.id!))) return;
    }
    return hits;
};
const desperateProof = (cue: CardEffectCue, g: Geometry) => {
    const attack = g.outcomes.find(i => i.outcome.kind === 'attack' && i.outcome.zone === 'base'), buff = g.outcomes.find(i => i.outcome.kind === 'buff' && i.outcome.duration === 'attack'), hit = g.outcomes.find(i => i.outcome.kind === 'damage'), exhaust = g.outcomes.find(i => i.outcome.kind === 'exhaust');
    if (!attack || !buff || !hit || !exhaust || !cue.transition || !attack.outcome.attackId || g.outcomes.filter(i => i.outcome.kind === 'damage').length !== 1
        || g.outcomes.indexOf(buff) >= g.outcomes.indexOf(attack) || g.outcomes.indexOf(attack) >= g.outcomes.indexOf(hit) || g.outcomes.indexOf(exhaust) >= g.outcomes.indexOf(hit)) return;
    const o = attack.outcome, before = unitIn(cue, o.sourceCard, cue.seat), after = unitIn(cue, o.sourceCard, cue.seat, true), basis = buff.outcome.attackBonusBasis;
    if (!before || !after || !before.id || !before.incarnation || before.x || before.d <= 0 || basis?.kind !== 'damaged' || basis.sourceId !== before.id || basis.incarnation !== before.incarnation || basis.damage !== before.d
        || buff.outcome.amount !== '+2/+0' || !same(buff.outcome.card, before) || !same(exhaust.outcome.card, before) || !same(hit.outcome.sourceCard, before) || !same(hit.outcome.card, o.card) || hit.outcome.damageType !== 'combat'
        || [buff, hit, exhaust].some(i => i.outcome.attackId !== o.attackId) || num(hit.outcome) !== before.p + 2 || after.p !== before.p || after.h !== before.h || after.d !== before.d || after.incarnation !== before.incarnation || after.x !== 1 || after.status?.some(s => s.duration === 'attack')
        || o.seat === cue.seat || !same(o.card, cue.transition.before.players[o.seat].base) || cue.transition.after.players[o.seat].base.d !== cue.transition.before.players[o.seat].base.d + num(hit.outcome)) return;
    return { attack, buff, hit, exhaust, before, after };
};
const pillageProof = (cue: CardEffectCue, g: Geometry) => {
    const discards = g.outcomes.filter(i => i.outcome.kind === 'discard');
    if (!discards.length || !cue.transition || new Set(discards.map(i => key(i.outcome.card))).size !== discards.length) return;
    const selected = discards[0].outcome.seat, before = cue.transition.before.players[selected], after = cue.transition.after.players[selected], hand = before.hand.filter(c => !same(c, cue.source));
    if (discards.length !== Math.min(2, hand.length)) return;
    for (const item of discards) { const o = item.outcome;
        if (o.seat !== selected || o.fromZone !== 'hand' || o.fromSeat !== selected || o.chooserSeat !== selected || o.selection !== 'chosen' || o.playerChoice?.chooserSeat !== cue.seat || o.playerChoice.selectedSeat !== selected || !o.card?.id || !hand.some(c => same(c, o.card)) || after.hand.some(c => same(c, o.card)) || !after.discard.some(c => same(c, o.card))) return;
    }
    const retained = hand.filter(c => !discards.some(i => same(i.outcome.card, c)));
    if (!sameIds(after.hand, retained.map(c => c.id!))) return;
    return { discards, selected, retained };
};
export function batchA06SecondaryCovers(cue: CardEffectCue, g: Geometry, item: PlacedOutcome): boolean {
    switch (cue.definition.id) {
        case 'moment-of-glory': return item === gloryProof(cue, g)?.item;
        case 'cripple-authority': { const proof = crippleProof(cue, g); return !!proof && [proof.draw, proof.discard].includes(item); }
        case 'the-chaos-of-war': return !!chaosProof(cue, g)?.includes(item);
        case 'desperate-attack': { const proof = desperateProof(cue, g); return !!proof && [proof.attack, proof.buff, proof.hit, proof.exhaust].includes(item); }
        case 'pillage': return !!pillageProof(cue, g)?.discards.includes(item);
        default: return false;
    }
}
function Glory({ cue, geometry: g, p }: Props) {
    const proof = gloryProof(cue, g); if (!proof) return null;
    const { item, before, after } = proof, at = item.box, s = sizeOf(at);
    return <><Payment cue={cue} geometry={g} p={p} /><Mask at={g.source} p={p} start={.06} /><ScreenPixels at={at} color="#e9d48c" opacity={envelope(p, .07, .16, .8)}><rect x={-s.w / 2 - 6} y={-s.h / 2 - 6} width={s.w + 12} height={s.h + 12} rx="7" strokeWidth="2" />{[-1, 1].map(side => Array.from({ length: 4 }, (_, i) => <rect key={`${side}:${i}`} x={side * (s.w / 2 + 13) - 4} y={s.h / 2 - 12 - i * 15} width="8" height="11" rx="2" fill="currentColor" opacity={visible(p, .18 + i * .075)} />))}</ScreenPixels>
        <Stats at={at} unit={after} p={p} start={.51} /><Receipt at={center(g)} rows={[`POWER ${before.p} → ${after.p} · MAX HP ${before.h} → ${after.h}`, `DAMAGE ${before.d} UNCHANGED · THIS PHASE`]} p={p} start={.58} color="#ebd49a" />
    </>;
}
function Cripple({ cue, geometry: g, p }: Props) {
    const proof = crippleProof(cue, g); if (!proof) return null;
    const { draw, discard, drawn, condition } = proof, at = center(g), to = g.endingCards?.[`${cue.seat}:${key(drawn)}`] ?? draw.to;
    return <><Payment cue={cue} geometry={g} p={p} /><Mask at={g.source} p={p} start={.06} />
        <Receipt at={at} rows={['TOTAL RESOURCES', `${condition.thanTotal} < ${condition.total}`]} p={p} start={.05} until={.56} color="#e6c6a6" />
        <Receipt at={shift(discard.from, 0, 44)} rows={[`${discard.outcome.seat.toUpperCase()} CHOOSES 1`]} p={p} start={.13} until={.44} color="#f0c5a5" />
        <Mask at={discard.from} p={p} start={.31} /><Travel from={discard.from} to={discard.to} card={discard.outcome.card} p={p} start={.32} end={.7} hold={false} color="#e2b99b" />
        <Travel from={{ ...draw.from, cardSize: { w: 38, h: 53.2 } }} to={to} card={drawn} p={p} start={.32} end={.7} color="#b7d5f3" />
        <Receipt at={at} rows={[`TOTAL ${condition.total} > ${condition.thanTotal}`, `${cue.seat.toUpperCase()} DRAWS 1 · ${discard.outcome.seat.toUpperCase()} CHOOSES 1`]} p={p} start={.77} color="#d8d7c5" />
    </>;
}
function Chaos({ cue, geometry: g, p }: Props) {
    const hits = chaosProof(cue, g); if (!hits) return null;
    return <><Payment cue={cue} geometry={g} p={p} /><Mask at={g.source} p={p} start={.05} />{hits.map(item => {
        const o = item.outcome, hand = g.zones[`${o.seat}:hand`], at = item.box, count = num(o), start = .23, end = .49, t = easeInOut(phase(p, start, end));
        const source = bounded({ ...hand, x: hand.x + hand.w / 2 + 76 / (hand.sx ?? 1) }, 130, 42), mark = { ...source, ...mix(source, at, t) }, handCounter = g.zones[`${o.seat}:hand-count`];
        return <g key={item.key}>{handCounter && <ScreenPixels at={handCounter} opacity={visible(p, .05)}><rect x="-14" y="-8" width="28" height="16" rx="2" fill="#0a1524" stroke="none" /><path d="M-9 -3 L-4 -5 L1 -3 L-4 -1 Z M-9 0 L-4 2 L1 0 M-9 3 L-4 5 L1 3" stroke="#98a8c2" strokeWidth=".9" /><text x="6" y="4" fill="#cbd5e5" stroke="none" style={{ font: '11px sans-serif' }}>{count}</text></ScreenPixels>}<Receipt at={source} rows={[`${o.seat.toUpperCase()} HAND ${count}`, 'AFTER EVENT LEAVES HAND']} p={p} start={.06} until={.29} color="#efb297" />
            <path d={`M${source.x} ${source.y} L${at.x} ${at.y}`} stroke="#e28c78" strokeWidth="2" strokeDasharray="4 7" opacity={envelope(p, .21, .26, .54)} />
            <ScreenPixels at={mark} color="#ffc2a1" opacity={envelope(p, start, start + .05, end + .07)}><CountedMarks count={count} radius={4} gap={13} /></ScreenPixels>
            <ScreenPixels at={at} color="#f19b80" opacity={envelope(p, .47, .5, .7)}><circle r={18 + 41 * phase(p, .47, .7)} strokeWidth="3" /><path d="M-31 0 H31 M0 -23 V23" strokeWidth="2" /></ScreenPixels>
            <BaseHp cue={cue} item={item} p={p} start={.52} /><Receipt at={shift(at, 0, sizeOf(at).h / 2 + 18)} rows={[`${o.seat.toUpperCase()} OWN BASE · ${count} DAMAGE`]} p={p} start={.67} color="#f0bea9" />
        </g>;
    })}</>;
}
function Desperate({ cue, geometry: g, p }: Props) {
    const proof = desperateProof(cue, g); if (!proof) return null;
    const { attack, hit, before, after } = proof, from = atCard(g, before, cue.seat), to = attack.to, s = sizeOf(from);
    const approach = easeInOut(phase(p, .25, .45)), retreat = easeInOut(phase(p, .56, .77)), distance = approach * (1 - retreat), at = { ...from, ...mix(from, to, .76 * distance) };
    const cardUnit = p < .64 ? { ...before, p: before.p + 2 } : after;
    return <><Payment cue={cue} geometry={g} p={p} /><Mask at={g.source} p={p} start={.06} /><Receipt at={center(g)} rows={[`EXISTING DAMAGE ${before.d}`, '+2 POWER · THIS ATTACK']} p={p} start={.06} until={.35} color="#edc291" />
        <Mask at={from} p={p} start={.25} />{p >= .25 && <ScreenPixels at={at} opacity={visible(p, .25)} color="#eabb8f"><g transform={`rotate(${10 * phase(p, .64, .78)}) scale(${1 - .06 * phase(p, .64, .78)})`} opacity={1 - .28 * phase(p, .64, .78)}><CardGhost card={before} box={s} />{[-1, 1].map(side => <g key={side} transform={`translate(${side * (s.w / 2 - 10)} ${s.h / 2 - 11})`}><rect x="-10" y="-10" width="20" height="20" rx="3" fill={side < 0 ? '#8b2936' : '#173f6f'} /><text y="4" textAnchor="middle" fill="#fff" stroke="none" style={{ font: '800 13px sans-serif' }}>{side < 0 ? cardUnit.p : cardUnit.h - cardUnit.d}</text></g>)}</g></ScreenPixels>}
        <ScreenPixels at={to} color="#ffc49c" opacity={envelope(p, .41, .46, .64)}><CountedMarks count={num(hit.outcome)} gap={12} radius={4} /><circle r={18 + 36 * phase(p, .45, .65)} strokeWidth="3" /></ScreenPixels>
        <BaseHp cue={cue} item={hit} p={p} start={.49} /><Receipt at={center(g)} rows={[`BASE TAKES ${num(hit.outcome)} · RESTING POWER ${after.p}`, `DAMAGE ${after.d} · ATTACKER EXHAUSTED`]} p={p} start={.8} color="#ecc7a8" />
    </>;
}
function Pillage({ cue, geometry: g, p }: Props) {
    const proof = pillageProof(cue, g); if (!proof) return null;
    const { discards, selected, retained } = proof, centerAt = center(g);
    return <><Payment cue={cue} geometry={g} p={p} /><Mask at={g.source} p={p} start={.05} /><Receipt at={centerAt} rows={[`${cue.seat.toUpperCase()} CHOOSES PLAYER ${selected.toUpperCase()}`]} p={p} start={.04} until={.29} color="#d5c3f0" />
        <Receipt at={centerAt} rows={[`${selected.toUpperCase()} CHOOSES ${discards.length} CARDS`]} p={p} start={.29} until={.69} color="#e3c59f" />
        {discards.map((item, i) => { const s = sizeOf(item.from), start = .33 + i * .06, end = .63 + i * .06; return <g key={item.key}><ScreenPixels at={item.from} color="#e3be93" opacity={envelope(p, .16 + i * .035, .23 + i * .035, start + .05)}><rect x={-s.w / 2 - 4} y={-s.h / 2 - 4} width={s.w + 8} height={s.h + 8} rx="4" strokeWidth="2" /><text y={s.h / 2 + 17} textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '700 10px sans-serif' }}>{i + 1}</text></ScreenPixels><Mask at={item.from} p={p} start={start} /><Travel from={item.from} to={item.to} card={item.outcome.card} p={p} start={start} end={end} hold={false} color="#e1ba93" /></g>; })}
        <Receipt at={centerAt} rows={[`${cue.seat.toUpperCase()} CHOSE ${selected.toUpperCase()} · ${selected.toUpperCase()} CHOSE CARDS`, `DISCARD ${discards.length} · HAND ${retained.length}`]} p={p} start={.79} color="#dfcaaa" />
    </>;
}
export function BatchA06SecondarySignature(props: Props) {
    switch (props.cue.definition.id) {
        case 'moment-of-glory': return <Glory {...props} />;
        case 'cripple-authority': return <Cripple {...props} />;
        case 'the-chaos-of-war': return <Chaos {...props} />;
        case 'desperate-attack': return <Desperate {...props} />;
        case 'pillage': return <Pillage {...props} />;
        default: return null;
    }
}
