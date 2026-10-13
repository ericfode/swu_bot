import { useId } from 'react';
import type { CardRef, Seat, Snapshot, UnitRef } from '../data/types';
import type { CardEffectCue, CardEffectOutcome } from './types';
import { A16_DEFINITIONS } from './batchA16';
import { previewPlayCost } from './previewCosts';
import { easeInOut, envelope, phase } from './animationTimeline';
import { CardGhost, ResourceBalance, ResourceSlot, ScreenPixels, mix, screenShift as shift, type EffectBox, type PlacedOutcome } from './primitives';

type Geometry = { source: EffectBox; target: EffectBox; friendlyBase: EffectBox; outcomes: PlacedOutcome[]; zones: Record<string, EffectBox>; cards?: Record<string, EffectBox>; endingCards?: Record<string, EffectBox>; resourceCards?: Record<string, EffectBox> };
type Props = { cue: CardEffectCue; geometry: Geometry; p: number };
const seats: Seat[] = ['p1', 'p2'];
const ids = new Set(['prepare-for-takeoff', 'focus-fire', 'turbolaser-salvo', 'no-disintegrations', 'fight-fire-with-fire']);
export const isBatchA16Secondary = (cue: CardEffectCue) => ids.has(cue.definition.id);
const key = (c?: CardRef | null) => c?.id ?? '';
const same = (a?: CardRef | null, b?: CardRef | null) => !!a?.id && a.id === b?.id;
const refEqual = (a?: CardRef | null, b?: CardRef | null) => same(a, b) && a?.n === b?.n && a?.s === b?.s && a?.owner === b?.owner && !!(a && 't' in a && a.t) === !!(b && 't' in b && b.t);
const exact = (a: unknown, b: unknown): boolean => {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => exact(v, b[i]));
    const x = a as Record<string, unknown>, y = b as Record<string, unknown>, keys = Object.keys(x);
    return keys.length === Object.keys(y).length && keys.every(k => Object.prototype.hasOwnProperty.call(y, k) && exact(x[k], y[k]));
};
const ordered = (a: CardRef[], b: CardRef[]) => a.length === b.length && a.every((c, i) => refEqual(c, b[i]));
const units = (s: Snapshot, seat: Seat) => [...s.players[seat].ground, ...s.players[seat].space];
const refs = (s: Snapshot) => seats.flatMap(seat => { const p = s.players[seat]; return [p.base, ...(p.leader ? [p.leader] : []), ...p.hand, ...p.discard, ...(p.resources ?? []), ...(p.knownDeck ?? []), ...units(s, seat), ...units(s, seat).flatMap(u => [...(u.u ?? []), ...(u.cap ?? [])])]; });
const allowed = (o: CardEffectOutcome, extra: string[]) => Object.keys(o).every(k => ['kind', 'card', 'seat', 'zone', 'sourceCard', 'incarnation', 'prevented', 'label', ...extra].includes(k));
const eventSource = (cue: CardEffectCue, o: CardEffectOutcome) => refEqual(cue.source, o.sourceCard) && !o.prevented;
const size = (at: EffectBox) => { const s = at.cardSize ?? { w: at.w * (at.sx ?? 1), h: at.h * (at.sy ?? 1) }; return { w: Math.max(12, s.w), h: Math.max(12, s.h) }; };
const visible = (p: number, start: number) => phase(p, start, start + .045);
const bounded = (at: EffectBox, w = 220, h = 42): EffectBox => ({ ...at, x: Math.max((w / 2 + 8) / (at.sx ?? 1), Math.min(1000 - (w / 2 + 8) / (at.sx ?? 1), at.x)), y: Math.max((h / 2 + 40) / (at.sy ?? 1), Math.min(600 - (h / 2 + 122) / (at.sy ?? 1), at.y)) });
const center = (g: Geometry) => { const upper = g.zones['p2:ground'], base = g.zones['p1:base']; return bounded({ ...g.source, x: 500, y: upper && base ? (upper.y + upper.h / 2 + base.y - base.h / 2) / 2 : 300 }); };
function locate(cue: CardEffectCue, c?: CardRef | null) {
    if (!c?.id || !cue.transition) return;
    const found = seats.flatMap(seat => (['ground', 'space'] as const).flatMap(zone => cue.transition!.before.players[seat][zone].filter(u => same(u, c)).map(unit => ({ unit, seat, zone }))));
    return found.length === 1 && found[0].unit.incarnation && found[0].unit.d < found[0].unit.h ? found[0] : undefined;
}
type Located = NonNullable<ReturnType<typeof locate>>;
function paidState(cue: CardEffectCue) {
    const d = A16_DEFINITIONS.find(d => d.id === cue.definition.id), t = cue.transition;
    if (!d || !t || cue.stage || cue.definition.name !== d.name || cue.definition.setCode !== d.setCode || !cue.source?.id || ('t' in cue.source && !!cue.source.t) || cue.source.n !== d.name || !([d.setCode, ...(d.id === 'prepare-for-takeoff' ? ['SOR_125'] : [])].includes(cue.source.s ?? '')) || cue.source.owner !== cue.seat || t.before.phase !== 'action'
        || t.before.round !== t.after.round || t.before.phase !== t.after.phase || t.before.initiative !== t.after.initiative || cue.playPayment?.kind !== 'resources' || cue.playPayment.exploit || cue.playPayment.smuggle) return;
    if (t.before.players[cue.seat].hand.filter(c => refEqual(c, cue.source)).length !== 1 || refs(t.before).filter(c => same(c, cue.source)).length !== 1 || refs(t.after).filter(c => same(c, cue.source)).length !== 1) return;
    let cost: number; try { cost = previewPlayCost(d, t.before, cue.seat, cue.playPayment); } catch { return; }
    if (!supportedBattlefield(cue)) return;
    const paid = cue.playPayment.cardIds;
    if (!paid || cue.playCost !== cost || paid.length !== cost || new Set(paid).size !== cost || !seats.every(seat => {
        const p = t.before.players[seat]; return !!p.resources && p.resources.length === p.res.total && p.resources.filter(r => !r.x).length === p.res.ready;
    }) || !paid.every(id => t.before.players[cue.seat].resources!.some(r => r.id === id && !r.x))) return;
    const result = structuredClone(t.before), p = result.players[cue.seat];
    p.resources = p.resources!.map(r => paid.includes(key(r)) ? { ...r, x: 1 } : r); p.res.ready -= cost;
    p.hand = p.hand.filter(c => !same(c, cue.source)); p.discard.push(cue.source);
    return result;
}
function ending(cue: CardEffectCue, expected: Snapshot) {
    if (!cue.transition) return false;
    for (const seat of seats) {
        const e = expected.players[seat], a = cue.transition.after.players[seat];
        if (!ordered(e.hand, a.hand) || !ordered(e.discard, a.discard) || !ordered(e.knownDeck ?? [], a.knownDeck ?? [])) return false;
        e.hand = a.hand; e.discard = a.discard; e.knownDeck = a.knownDeck;
    }
    return exact(expected, cue.transition.after);
}
function replace(s: Snapshot, t: Located, next: UnitRef) { s.players[t.seat][t.zone] = s.players[t.seat][t.zone].map(u => same(u, t.unit) ? next : u); }

type BodyFact = { name: string; traits: string[]; zone: 'ground' | 'space'; p: number; h: number; sentinel?: boolean; overwhelm?: boolean };
const bodyFacts: Record<string, BodyFact> = {
    SOR_095: { name: 'Battlefield Marine', traits: ['rebel', 'trooper'], zone: 'ground', p: 3, h: 3 },
    SOR_098: { name: 'Echo Base Defender', traits: ['rebel', 'trooper'], zone: 'ground', p: 4, h: 3, sentinel: true },
    SOR_237: { name: 'Alliance X-Wing', traits: ['rebel', 'vehicle', 'fighter'], zone: 'space', p: 2, h: 3 },
    SOR_033: { name: 'Death Trooper', traits: ['imperial', 'trooper'], zone: 'ground', p: 3, h: 3 },
    SOR_164: { name: 'Wampa', traits: ['creature'], zone: 'ground', p: 4, h: 5, overwhelm: true },
    SOR_225: { name: 'TIE/ln Fighter', traits: ['imperial', 'vehicle', 'fighter'], zone: 'space', p: 2, h: 1 },
    SOR_232: { name: 'AT-ST', traits: ['imperial', 'vehicle', 'walker'], zone: 'ground', p: 6, h: 7, overwhelm: true },
};
function knownBody(t: Located) {
    const u = t.unit, f = u.s && !u.t ? bodyFacts[u.s] : undefined;
    if (!f || u.n !== f.name || u.printedTitle !== f.name || u.unique !== false || u.leaderUnit !== false || !exact(u.traits, f.traits) || t.zone !== f.zone || !u.owner
        || u.p !== f.p || u.h !== f.h || !Number.isSafeInteger(u.d) || u.d < 0 || u.d >= u.h || u.u?.length || u.cap?.length || !exact(u.onAttackAbilities, [])
        || !!u.sn !== !!f.sentinel || !exact(u.status ?? [], f.overwhelm ? [{ kind: 'keyword', label: 'Overwhelm (printed)', duration: 'permanent', keyword: { name: 'Overwhelm', amount: 1 } }] : [])) return false;
    return true;
}
function supportedBattlefield(cue: CardEffectCue) {
    return seats.every(seat => units(cue.transition!.before, seat).every(u => { const t = locate(cue, u); return !!t && knownBody(t); }));
}
const entry = (u: UnitRef) => ({ id: key(u), incarnation: u.incarnation! });
function removeUnit(expected: Snapshot, t: Located) {
    expected.players[t.seat][t.zone] = expected.players[t.seat][t.zone].filter(u => !same(u, t.unit));
    expected.players[t.unit.owner!].discard.push(t.unit);
    if (expected.pending) expected.pending = expected.pending.filter(p => p.targetId !== t.unit.id);
}
type Hit = { item: PlacedOutcome; t: Located; end: UnitRef; amount: number; sources: Located[]; dead?: PlacedOutcome };
function damage(cue: CardEffectCue, item: PlacedOutcome, amount: number, source: CardRef, extra: string[], cause = false) {
    const o = item.outcome, t = locate(cue, o.card);
    if (!t || !knownBody(t) || !allowed(o, ['amount', 'damageType', 'damageAttempt', ...(cause ? ['causeCard'] : []), ...extra]) || o.kind !== 'damage' || !exact(o.card, t.unit)
        || o.seat !== t.seat || o.zone !== t.zone || o.incarnation !== t.unit.incarnation || !exact(o.sourceCard, source) || cause && !exact(o.causeCard, cue.source)
        || o.prevented || o.amount !== amount || o.damageType !== 'ability' || !exact(o.damageAttempt, { incoming: amount, prevention: 'none' })) return;
    return t;
}
function cleanup(cue: CardEffectCue, g: Geometry, expected: Snapshot, hits: Hit[]) {
    const dead = g.outcomes.filter(i => i.outcome.kind === 'defeat');
    if (dead.length !== hits.filter(h => h.end.d >= h.end.h).length) return false;
    for (const hit of hits) {
        if (hit.end.d < hit.end.h) { replace(expected, hit.t, hit.end); continue; }
        const item = dead.find(i => same(i.outcome.card, hit.t.unit)), o = item?.outcome;
        if (!item || !o || !allowed(o, ['fromSeat', 'fromZone', 'ownerSeat']) || !eventSource(cue, o) || !exact(o.card, hit.t.unit) || o.seat !== hit.t.seat || o.fromSeat !== hit.t.seat || o.fromZone !== hit.t.zone
            || o.zone !== 'discard' || o.ownerSeat !== hit.t.unit.owner || o.incarnation !== hit.t.unit.incarnation) return false;
        hit.dead = item; removeUnit(expected, hit.t);
    }
    return true;
}
function group(outcomes: PlacedOutcome[]) {
    const g = outcomes[0]?.outcome.resolutionGroup;
    return !!g?.id && exact(g, { id: g.id, mode: 'simultaneous' }) && outcomes.every(o => exact(o.outcome.resolutionGroup, g));
}
function takeoffProof(cue: CardEffectCue, g: Geometry) {
    const expected = paidState(cue), before = cue.transition?.before.players[cue.seat];
    if (!expected || !before || !before.knownDeck || before.knownDeck.length !== before.deck || new Set(before.knownDeck.map(key)).size !== before.deck || before.knownDeck.some(c => !c.id || c.owner !== cue.seat || ('t' in c && !!c.t))
        || g.outcomes.length < 1 || g.outcomes.length > 2) return;
    const o = g.outcomes[0].outcome, op = o.deckOperation, looked = before.knownDeck.slice(0, 8);
    if (!allowed(o, ['cards', 'fromSeat', 'fromZone', 'amount', 'selection', 'visibility', 'deckOperation']) || !eventSource(cue, o) || o.kind !== 'search' || o.card !== null || o.seat !== cue.seat || o.zone !== 'deck' || o.fromSeat !== cue.seat || o.fromZone !== 'deck'
        || o.amount !== looked.length || o.selection !== 'chosen' || o.visibility !== 'private' || !exact(o.cards, looked) || !op || op.scope !== 'top' || op.visibility !== 'private' || op.policy !== 'top-search-bottom' || op.selectionLimit !== 2
        || !exact(op.looked, looked) || !op.selectedIds || op.selectedIds.length > 2 || new Set(op.selectedIds).size !== op.selectedIds.length || !exact(op.revealedIds, op.selectedIds)
        || !exact(Object.keys(op).sort(), ['looked', 'policy', 'remainingOrder', 'revealedIds', 'scope', 'selectedIds', 'selectionLimit', 'visibility'].sort())) return;
    const selected = op.selectedIds.map(id => looked.find(c => c.id === id));
    if (selected.some(c => !c || !c.s || bodyFacts[c.s]?.name !== c.n || !bodyFacts[c.s]?.traits.includes('vehicle'))) return;
    const cards = selected as CardRef[], other = looked.filter(c => !op.selectedIds!.includes(key(c))), order = op.remainingOrder;
    if (!order || order.length !== before.deck || !exact(order.slice(0, cards.length), cards) || !exact(order.slice(cards.length, cards.length + before.deck - looked.length), before.knownDeck.slice(looked.length))) return;
    const bottom = order.slice(cards.length + before.deck - looked.length);
    if (bottom.length !== other.length || new Set(bottom.map(key)).size !== bottom.length || bottom.some(c => !other.some(old => exact(old, c)))) return;
    const draw = g.outcomes[1]?.outcome;
    if (cards.length ? !draw || !allowed(draw, ['cards', 'fromSeat', 'fromZone', 'amount']) || !eventSource(cue, draw) || draw.kind !== 'draw' || draw.card !== null || draw.seat !== cue.seat || draw.zone !== 'hand'
        || draw.fromSeat !== cue.seat || draw.fromZone !== 'deck' || draw.amount !== cards.length || !exact(draw.cards, cards) : !!draw) return;
    expected.players[cue.seat].hand.push(...cards); expected.players[cue.seat].deck -= cards.length; expected.players[cue.seat].knownDeck = order.slice(cards.length);
    return ending(cue, expected) ? { looked, selected: cards, other: bottom, items: g.outcomes } : undefined;
}
function focusProof(cue: CardEffectCue, g: Geometry) {
    const expected = paidState(cue); if (!expected || !cue.transition) return;
    const ds = g.outcomes.filter(i => i.outcome.kind === 'damage'), target = locate(cue, ds[0]?.outcome.card);
    if (!target || !knownBody(target) || !group(ds) || g.outcomes.slice(0, ds.length).some(i => i.outcome.kind !== 'damage') || g.outcomes.some(i => !['damage', 'defeat'].includes(i.outcome.kind))) return;
    const sources = cue.transition.before.players[cue.seat][target.zone].filter(u => u.traits?.includes('vehicle')).map(u => locate(cue, u)!);
    const witness = ds[0].outcome.vehicleSources;
    if (!sources.length || ds.length !== sources.length || !witness?.id || !exact(witness, { id: witness.id, sourceId: key(cue.source), arena: target.zone, targetId: key(target.unit), targetIncarnation: target.unit.incarnation, members: sources.map(t => ({ ...entry(t.unit), power: t.unit.p })) })) return;
    const seen = new Set<string>();
    for (const item of ds) {
        const source = sources.find(t => same(t.unit, item.outcome.sourceCard));
        if (!source || seen.has(key(source.unit)) || !same(damage(cue, item, source.unit.p, source.unit, ['vehicleSources', 'resolutionGroup'], true)?.unit, target.unit) || !exact(item.outcome.vehicleSources, witness)) return;
        seen.add(key(source.unit));
    }
    const amount = sources.reduce((n, t) => n + t.unit.p, 0), hits: Hit[] = [{ item: ds[0], t: target, end: { ...target.unit, d: target.unit.d + amount }, amount, sources }];
    return cleanup(cue, g, expected, hits) && ending(cue, expected) ? { hits, sources, arena: target.zone, items: g.outcomes } : undefined;
}
function salvoProof(cue: CardEffectCue, g: Geometry) {
    const expected = paidState(cue); if (!expected || !cue.transition) return;
    const ds = g.outcomes.filter(i => i.outcome.kind === 'damage'), w = ds[0]?.outcome.arenaSalvo, source = locate(cue, ds[0]?.outcome.sourceCard), enemy: Seat = cue.seat === 'p1' ? 'p2' : 'p1';
    if (!source || !knownBody(source) || source.seat !== cue.seat || source.zone !== 'space' || !w?.id || !['ground', 'space'].includes(w.arena) || !group(ds)
        || g.outcomes.slice(0, ds.length).some(i => i.outcome.kind !== 'damage') || g.outcomes.some(i => !['damage', 'defeat'].includes(i.outcome.kind))) return;
    const targets = cue.transition.before.players[enemy][w.arena];
    if (ds.length !== targets.length || !exact(w, { id: w.id, sourceId: key(cue.source), unitId: key(source.unit), incarnation: source.unit.incarnation, power: source.unit.p, opponent: enemy, arena: w.arena, members: targets.map(entry) })) return;
    const hits: Hit[] = [];
    for (const item of ds) {
        const t = damage(cue, item, source.unit.p, source.unit, ['arenaSalvo', 'resolutionGroup'], true);
        if (!t || t.seat !== enemy || t.zone !== w.arena || !exact(item.outcome.arenaSalvo, w) || hits.some(h => same(h.t.unit, t.unit))) return;
        hits.push({ item, t, end: { ...t.unit, d: t.unit.d + source.unit.p }, amount: source.unit.p, sources: [source] });
    }
    return cleanup(cue, g, expected, hits) && ending(cue, expected) ? { hits, source, arena: w.arena, items: g.outcomes } : undefined;
}
function noDisProof(cue: CardEffectCue, g: Geometry) {
    const expected = paidState(cue); if (!expected || g.outcomes.length !== 1) return;
    const item = g.outcomes[0], t = locate(cue, item.outcome.card); if (!t || !knownBody(t)) return;
    const amount = Math.max(0, t.unit.h - t.unit.d - 1), checked = damage(cue, item, amount, cue.source!, ['remainingHpDamage']);
    if (!checked || !exact(item.outcome.remainingHpDamage, { sourceId: key(cue.source), subjectId: key(t.unit), incarnation: t.unit.incarnation, hp: t.unit.h, wounds: t.unit.d, computed: amount })) return;
    const end = { ...t.unit, d: t.unit.d + amount }; replace(expected, t, end);
    return ending(cue, expected) ? { hits: [{ item, t, end, amount, sources: [] } as Hit], remaining: t.unit.h - t.unit.d, items: g.outcomes } : undefined;
}
function fightProof(cue: CardEffectCue, g: Geometry) {
    const expected = paidState(cue); if (!expected || !cue.transition) return;
    const ds = g.outcomes.filter(i => i.outcome.kind === 'damage'), w = ds[0]?.outcome.pairedDamage, hits: Hit[] = [], enemy: Seat = cue.seat === 'p1' ? 'p2' : 'p1';
    if (ds.length !== 2 || !group(ds) || !w?.id || g.outcomes.slice(0, 2).some(i => i.outcome.kind !== 'damage') || g.outcomes.some(i => !['damage', 'defeat'].includes(i.outcome.kind))) return;
    for (const item of ds) {
        const t = damage(cue, item, 3, cue.source!, ['pairedDamage', 'resolutionGroup']);
        if (!t || !exact(item.outcome.pairedDamage, w) || hits.some(h => same(h.t.unit, t.unit))) return;
        hits.push({ item, t, end: { ...t.unit, d: t.unit.d + 3 }, amount: 3, sources: [] });
    }
    const own = hits.find(h => h.t.seat === cue.seat), other = hits.find(h => h.t.seat === enemy);
    if (!own || !other || own.t.zone !== other.t.zone || !exact(w, { id: w.id, sourceId: key(cue.source), arena: own.t.zone, friendly: entry(own.t.unit), enemy: entry(other.t.unit) })) return;
    return cleanup(cue, g, expected, hits) && ending(cue, expected) ? { hits, arena: own.t.zone, items: g.outcomes } : undefined;
}
function proof(cue: CardEffectCue, g: Geometry) {
    switch (cue.definition.id) {
        case 'prepare-for-takeoff': return takeoffProof(cue, g);
        case 'focus-fire': return focusProof(cue, g);
        case 'turbolaser-salvo': return salvoProof(cue, g);
        case 'no-disintegrations': return noDisProof(cue, g);
        case 'fight-fire-with-fire': return fightProof(cue, g);
    }
}
export const batchA16SecondaryCovers = (cue: CardEffectCue, g: Geometry, item: PlacedOutcome) => proof(cue, g)?.items.includes(item) ?? false;
function Receipt({ at, rows, p, start = .77, until, color = '#b8dcd8' }: { at: EffectBox; rows: string[]; p: number; start?: number; until?: number; color?: string }) {
    const w = Math.min(320, Math.max(100, ...rows.map(r => r.length * 6 + 24))), h = rows.length * 16 + 8;
    return <ScreenPixels at={bounded(at, w, h)} color={color} opacity={visible(p, start) * (until ? 1 - phase(p, until - .05, until) : 1)}><rect x={-w / 2} y={-h / 2} width={w} height={h} rx="4" fill="#08111e" fillOpacity=".97" />{rows.map((r, i) => <text key={i} y={-h / 2 + 14 + i * 16} textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '700 9px sans-serif' }}>{r}</text>)}</ScreenPixels>;
}
function Mask({ at, p, start }: { at: EffectBox; p: number; start: number }) { const s = size(at); return <ScreenPixels at={at} opacity={visible(p, start)}><rect x={-s.w / 2 - 4} y={-s.h / 2 - 4} width={s.w + 8} height={s.h + 8} rx="5" fill="#0b1420" stroke="none" /></ScreenPixels>; }
function CompactRoute({ from, to, card, p, start, end }: { from: EffectBox; to: EffectBox; card: CardRef; p: number; start: number; end: number }) {
    const left = 12 / (from.sx ?? 1), approach = shift(to, 0, 24), route = [from, { ...from, x: left }, { ...approach, x: left }, approach, to], t = easeInOut(phase(p, start, end)), segment = Math.min(3, Math.floor(t * 4));
    const at = { ...from, ...mix(route[segment], route[segment + 1], easeInOut(t * 4 - segment)) };
    return <><path d={route.map((point, i) => `${i ? 'L' : 'M'}${point.x} ${point.y}`).join(' ')} stroke="#acd4d8" strokeWidth="1.5" opacity={envelope(p, start, start + .03, end + .06)} /><ScreenPixels at={at} opacity={envelope(p, start, start + .025, end + .06)}><CardGhost card={card} box={{ w: 20, h: 28 }} /></ScreenPixels></>;
}
function Payment({ cue, geometry: g, p }: Props) {
    if (cue.stage) return null;
    const before = cue.transition!.before.players[cue.seat], paid = cue.playPayment?.kind === 'resources' ? cue.playPayment.cardIds! : [];
    return <>{before.resources!.map((r, i) => { const at = g.resourceCards?.[cue.seat + ':' + key(r)]; return at && paid.includes(key(r)) ? <ResourceSlot key={key(r)} at={at} index={i} spent p={p} start={.04} /> : null; })}<ResourceBalance at={g.zones[cue.seat + ':resources']} countAt={g.zones[cue.seat + ':resource-count']} ready={before.res.ready - paid.length} total={before.res.total} p={p} start={.04} /><Mask at={g.source} p={p} start={.04} /><CompactRoute from={g.source} to={g.zones[cue.seat + ':discard']} card={cue.source!} p={p} start={.04} end={.21} /></>;
}
function Counters({ at, u, p, start }: { at: EffectBox; u: UnitRef; p: number; start: number }) {
    const s = size(at); return <>{(['power', 'hp'] as const).map((n, i) => { const c = at.counters?.[n]; return <ScreenPixels key={n} at={c ? { ...at, ...c } : shift(at, (i ? 1 : -1) * (s.w / 2 - 10), s.h / 2 - 12)} opacity={visible(p, start)}><rect x="-11" y="-12" width="22" height="24" rx="3" fill={i ? '#174772' : '#8b2936'} stroke="#e1e7e6" /><text y="4" textAnchor="middle" fill="#fff" stroke="none" style={{ font: '800 14px sans-serif' }}>{i ? Math.max(0, u.h - u.d) : u.p}</text></ScreenPixels>; })}</>;
}
function Badge({ at, text, p, start, color = '#c5d8e3' }: { at: EffectBox; text: string; p: number; start: number; color?: string }) {
    const s = size(at); return <ScreenPixels at={shift(at, 0, -s.h / 2 + 11)} color={color} opacity={visible(p, start)}><rect x={-s.w / 2 + 2} y="-8" width={s.w - 4} height="16" rx="2" fill="#101c2b" /><text y="2" textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '800 6px sans-serif' }}>{text}</text></ScreenPixels>;
}
function Depart({ geometry: g, p, item, t, start = .4, end = .72 }: Props & { item: PlacedOutcome; t: Located; start?: number; end?: number }) {
    const at = g.cards?.[t.seat + ':' + key(t.unit)] ?? item.from;
    return <><Mask at={at} p={p} start={start} />{t.unit.t ? <ScreenPixels at={at} color="#dcb898" opacity={envelope(p, start, start + .045, end)}><path d="M-13 -13 L13 13 M13 -13 L-13 13" strokeWidth="3" /><circle r={6 + 18 * phase(p, start, end)} fill="none" strokeDasharray="3 4" /></ScreenPixels> : <CompactRoute from={at} to={g.zones[t.unit.owner + ':discard'] ?? item.to} card={t.unit} p={p} start={start} end={end} />}</>;
}
function TargetLock({ at, p, color = '#b2d9df' }: { at: EffectBox; p: number; color?: string }) {
    const s = size(at), w = s.w / 2 + 3, h = s.h / 2 + 3;
    return <ScreenPixels at={at} color={color} opacity={envelope(p, .15, .25, .52)}><path d={`M${-w} ${-h + 12} V${-h} H${-w + 12} M${w - 12} ${-h} H${w} V${-h + 12} M${-w} ${h - 12} V${h} H${-w + 12} M${w - 12} ${h} H${w} V${h - 12}`} fill="none" strokeWidth="2" /></ScreenPixels>;
}
function Pulse({ from, to, g, p, start = .26, end = .45, color = '#a9dce0', bend = 0 }: { from: EffectBox; to: EffectBox; g: Geometry; p: number; start?: number; end?: number; color?: string; bend?: number }) {
    const maskId = useId(), t = easeInOut(phase(p, start, end)), mid = { x: (from.x + to.x) / 2 + bend, y: (from.y + to.y) / 2 };
    const at = { ...from, x: (1 - t) ** 2 * from.x + 2 * (1 - t) * t * mid.x + t * t * to.x, y: (1 - t) ** 2 * from.y + 2 * (1 - t) * t * mid.y + t * t * to.y };
    // These pulses connect units; both measured base counters are unrelated to their damage.
    const counters = seats.flatMap(seat => { const base = g.zones[seat + ':base']; return base?.exact && base.stat ? [{ seat, base, c: base.stat }] : []; });
    return <><defs><mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="1000" height="600"><rect width="1000" height="600" fill="white" />{counters.map(({ seat, base, c }) => <ScreenPixels key={seat} at={{ ...base, ...c }}><rect x={-c.w * (base.sx ?? 1) / 2 - 2} y={-c.h * (base.sy ?? 1) / 2 - 2} width={c.w * (base.sx ?? 1) + 4} height={c.h * (base.sy ?? 1) + 4} fill="black" /></ScreenPixels>)}</mask></defs><g mask={`url(#${maskId})`}><path d={`M${from.x} ${from.y} Q${mid.x} ${mid.y} ${to.x} ${to.y}`} fill="none" stroke={color} strokeWidth="1.1" opacity={envelope(p, start, start + .04, end + .03)} /><ScreenPixels at={at} color={color} opacity={envelope(p, start, start + .025, end + .025)}><circle r="4" fill="currentColor" stroke="#effcfa" /><circle r="8" fill="none" strokeWidth="1" /></ScreenPixels></g></>;
}
function HitResult(props: Props & { hit: Hit; start?: number }) {
    const { cue, geometry: g, p, hit, start = .48 } = props, at = g.cards?.[hit.t.seat + ':' + key(hit.t.unit)] ?? hit.item.box, s = size(at);
    return <><ScreenPixels at={at} color="#e2bdab" opacity={envelope(p, start - .045, start, start + .09)}><circle r={8 + 13 * phase(p, start - .04, start + .08)} fill="none" strokeWidth="2" />{[0, 1, 2].map(i => <path key={i} d={`M${-12 + i * 10} -14 l-7 10 5 2 -7 12`} fill="none" strokeWidth="2" />)}</ScreenPixels>
        {hit.dead ? <><Counters at={at} u={hit.end} p={p} start={start} /><Depart cue={cue} geometry={g} p={p} item={hit.dead} t={hit.t} start={start + .12} end={start + .29} /></>
            : <><Counters at={at} u={hit.end} p={p} start={start} /><ScreenPixels at={shift(at, 0, -s.h / 2 + 11)} color="#e8cbbb" opacity={visible(p, start)}><rect x={-s.w / 2 + 2} y="-8" width={s.w - 4} height="16" rx="2" fill="#241a1b" /><text y="2" textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '800 7px sans-serif' }}>{hit.amount} DAMAGE</text></ScreenPixels></>}
    </>;
}
function Takeoff(props: Props) {
    const { cue, geometry: g, p } = props, r = takeoffProof(cue, g); if (!r) return null;
    const c = center(g), deck = g.zones[cue.seat + ':deck'], spacing = 27, left = -(r.looked.length - 1) * spacing / 2;
    return <><Payment {...props} /><Receipt at={c} rows={[`TOP ${r.looked.length} · PRIVATE VEHICLE SEARCH`]} p={p} start={.10} until={.28} color="#b8d4d6" />
        {r.looked.map((card, i) => {
            const chosen = r.selected.some(v => same(v, card)), ordinal = r.selected.findIndex(v => same(v, card)), start = .52 + Math.max(0, ordinal) * .035;
            const shelf = shift(c, left + spacing * i, 0), appear = easeInOut(phase(p, .28, .38)), from = { ...deck, ...mix(deck, shelf, appear) };
            const target = chosen ? g.endingCards?.[cue.seat + ':' + key(card)] : deck;
            const moving = target && phase(p, chosen ? start : .59, chosen ? .8 : .76), t = moving ? easeInOut(moving) : 0;
            const routeX = 12 / (c.sx ?? 1), route = [shelf, { ...shelf, x: routeX }, { ...target ?? deck, x: routeX }, target ?? deck];
            const segment = Math.min(2, Math.floor(t * 3)), at = target && t ? { ...c, ...mix(route[segment], route[segment + 1], easeInOut(t * 3 - segment)) } : from;
            const final = target ? size(target) : { w: 42, h: 58.8 }, reveal = chosen && p >= .4 && p < start, w = reveal ? 34 : chosen ? 22 + (final.w - 22) * phase(p, .73, .8) : 22;
            return <ScreenPixels key={key(card)} at={at} opacity={visible(p, .28) * (chosen ? 1 : 1 - phase(p, .76, .82))} color="#b6d7df"><CardGhost card={card} back={!chosen || p < .4} box={{ w, h: w * 1.4 }} />{chosen && p >= .4 && p < start && <path d="M-12 -26 H12" strokeWidth="3" />}</ScreenPixels>;
        })}<Receipt at={c} rows={[`${r.selected.length} VEHICLE${r.selected.length === 1 ? '' : 'S'} REVEALED AND DRAWN`, `${r.other.length} OTHER CARDS · RANDOM BOTTOM`]} p={p} start={.84} color="#b8d4d6" /></>;
}
function Focus(props: Props) {
    const { cue, geometry: g, p } = props, r = focusProof(cue, g); if (!r) return null;
    const hit = r.hits[0], target = g.cards?.[hit.t.seat + ':' + key(hit.t.unit)] ?? hit.item.box;
    return <><Payment {...props} /><Receipt at={center(g)} rows={[`${r.sources.length} FRIENDLY VEHICLES · ${r.arena.toUpperCase()}`, 'SIMULTANEOUS ABILITY DAMAGE']} p={p} start={.06} until={.28} />
        <TargetLock at={target} p={p} color="#e9c2ae" />{r.sources.map((t, i) => { const at = g.cards?.[t.seat + ':' + key(t.unit)]; return at ? <g key={key(t.unit)}><TargetLock at={at} p={p} /><Badge at={at} text={`${t.unit.p} · ${t.unit.x ? 'EXHAUSTED' : 'READY'}`} p={p} start={.2} /><Pulse g={g} from={at} to={target} p={p} bend={(i - (r.sources.length - 1) / 2) * 42} /></g> : null; })}
        <HitResult {...props} hit={hit} /><Receipt at={center(g)} rows={[`${r.sources.map(t => t.unit.p).join(' + ')} = ${hit.amount} DAMAGE`, hit.dead ? 'TARGET DEFEATED · NO COMBAT' : 'SOURCE POSES UNCHANGED · NO COMBAT']} p={p} start={.84} /></>;
}
function Salvo(props: Props) {
    const { cue, geometry: g, p } = props, r = salvoProof(cue, g); if (!r) return null;
    const source = g.cards?.[r.source.seat + ':' + key(r.source.unit)] ?? g.source;
    return <><Payment {...props} /><Receipt at={center(g)} rows={[`ENEMY ${r.arena.toUpperCase()} · EVERY UNIT`, `${r.source.unit.p} POWER FROM YOUR SPACE UNIT`]} p={p} start={.06} until={.28} color="#c6d6a6" /><TargetLock at={source} p={p} color="#c6d6a6" />
        {r.hits.map((hit, i) => { const at = g.cards?.[hit.t.seat + ':' + key(hit.t.unit)] ?? hit.item.box; return <g key={hit.item.key}><TargetLock at={at} p={p} color="#ddb79b" /><Pulse g={g} from={source} to={at} p={p} bend={(i - (r.hits.length - 1) / 2) * 32} color="#d8d8a5" /><HitResult {...props} hit={hit} /></g>; })}
        <Receipt at={center(g)} rows={[`${r.hits.length} ${r.arena.toUpperCase()} TARGETS · ${r.source.unit.p} DAMAGE EACH`, 'SIMULTANEOUS · SOURCE DOES NOT ATTACK']} p={p} start={.84} color="#c6d6a6" /></>;
}
function NoDisintegrations(props: Props) {
    const { cue, geometry: g, p } = props, r = noDisProof(cue, g); if (!r) return null;
    const hit = r.hits[0], at = g.cards?.[hit.t.seat + ':' + key(hit.t.unit)] ?? hit.item.box, s = size(at), count = Math.min(12, r.remaining);
    return <><Payment {...props} /><Receipt at={center(g)} rows={[`${r.remaining} REMAINING HP − 1 = ${hit.amount}`, 'DAMAGE · MAXIMUM HP IS UNCHANGED']} p={p} start={.07} until={.37} color="#dfb4a7" /><TargetLock at={at} p={p} color="#dfb4a7" />
        <ScreenPixels at={shift(at, 0, -3)} color="#e3b9a6" opacity={envelope(p, .23, .28, .66)}>{Array.from({ length: count }, (_, i) => <rect key={i} x={-Math.min(s.w - 12, 60) / 2 + i * Math.min(s.w - 12, 60) / count} y="-6" width={Math.max(2, Math.min(s.w - 12, 60) / count - 2)} height="12" rx="2" fill={i === 0 ? '#addec9' : '#925343'} opacity={i === 0 ? 1 : 1 - phase(p, .35 + i * .018, .46 + i * .018)} />)}</ScreenPixels>
        <HitResult {...props} hit={hit} start={.61} /><Receipt at={center(g)} rows={[`${hit.amount} DAMAGE · 1 HP REMAINS`, 'POWER, MAX HP AND POSE KEPT']} p={p} start={.83} color="#dfb4a7" /></>;
}
function Fight(props: Props) {
    const { cue, geometry: g, p } = props, r = fightProof(cue, g); if (!r) return null;
    return <><Payment {...props} /><Receipt at={center(g)} rows={[`FRIENDLY + ENEMY · SAME ${r.arena.toUpperCase()}`, 'THREE DAMAGE EACH · SIMULTANEOUS']} p={p} start={.06} until={.31} color="#dcac9b" />{r.hits.map(hit => {
        const at = g.cards?.[hit.t.seat + ':' + key(hit.t.unit)] ?? hit.item.box;
        return <g key={hit.item.key}><TargetLock at={at} p={p} color={hit.t.seat === cue.seat ? '#aacdde' : '#e3ad99'} /><ScreenPixels at={at} color="#e5ae94" opacity={envelope(p, .29, .37, .51)}>{[0, 1, 2].map(i => <path key={i} d={`M${-15 + i * 15} -14 l-4 10 6 2 -6 13`} fill="none" strokeWidth="3" />)}</ScreenPixels><HitResult {...props} hit={hit} /></g>;
    })}<Receipt at={center(g)} rows={['3 DAMAGE EACH · INDEPENDENT RESULTS', `${r.hits.filter(h => h.dead).length} DEFEATED · NO ATTACK OR EXHAUSTION`]} p={p} start={.84} color="#dcac9b" /></>;
}
export function BatchA16SecondarySignature(props: Props) {
    switch (props.cue.definition.id) {
        case 'prepare-for-takeoff': return <Takeoff {...props} />;
        case 'focus-fire': return <Focus {...props} />;
        case 'turbolaser-salvo': return <Salvo {...props} />;
        case 'no-disintegrations': return <NoDisintegrations {...props} />;
        case 'fight-fire-with-fire': return <Fight {...props} />;
        default: return null;
    }
}
