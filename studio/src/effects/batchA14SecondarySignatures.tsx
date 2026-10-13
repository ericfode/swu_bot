import type { CardRef, Seat, Snapshot, UnitRef } from '../data/types';
import type { CardEffectCue, CardEffectOutcome } from './types';
import { A14_DEFINITIONS } from './batchA14';
import { previewPlayCost } from './previewCosts';
import { easeInOut, envelope, phase } from './animationTimeline';
import { CardGhost, ResourceBalance, ResourceSlot, ScreenPixels, mix, screenShift as shift, type EffectBox, type PlacedOutcome } from './primitives';

type Geometry = { source: EffectBox; target: EffectBox; friendlyBase: EffectBox; outcomes: PlacedOutcome[]; zones: Record<string, EffectBox>; cards?: Record<string, EffectBox>; endingCards?: Record<string, EffectBox>; resourceCards?: Record<string, EffectBox> };
type Props = { cue: CardEffectCue; geometry: Geometry; p: number };
const seats: Seat[] = ['p1', 'p2'];
const ids = new Set(['drop-in', 'power-from-pain', 'youre-all-clear-kid', 'direct-hit', 'out-the-airlock']);
export const isBatchA14Secondary = (cue: CardEffectCue) => ids.has(cue.definition.id);
const key = (c?: CardRef | null) => c?.id ?? '';
const same = (a?: CardRef | null, b?: CardRef | null) => !!a?.id && a.id === b?.id;
const refEqual = (a?: CardRef | null, b?: CardRef | null) => same(a, b) && a?.n === b?.n && a?.s === b?.s && a?.owner === b?.owner;
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
    const d = A14_DEFINITIONS.find(d => d.id === cue.definition.id), t = cue.transition;
    if (!d || !t || cue.stage || cue.definition.name !== d.name || cue.definition.setCode !== d.setCode || !cue.source?.id || cue.source.n !== d.name || cue.source.s !== d.setCode || cue.source.owner !== cue.seat || t.before.phase !== 'action'
        || t.before.round !== t.after.round || t.before.phase !== t.after.phase || t.before.initiative !== t.after.initiative || cue.playPayment?.kind !== 'resources' || cue.playPayment.exploit || cue.playPayment.smuggle) return;
    if (t.before.players[cue.seat].hand.filter(c => refEqual(c, cue.source)).length !== 1 || refs(t.before).filter(c => same(c, cue.source)).length !== 1 || refs(t.after).filter(c => same(c, cue.source)).length !== 1) return;
    let cost: number; try { cost = previewPlayCost(d, t.before, cue.seat, cue.playPayment); } catch { return; }
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

// Keep these conservative witnesses local: an unsupported native aftermath stays generic.
type BodyFact = { name: string; traits: string[]; zone: 'ground' | 'space' };
const bodyFacts: Record<string, BodyFact> = {
    SOR_095: { name: 'Battlefield Marine', traits: ['rebel', 'trooper'], zone: 'ground' },
    SOR_098: { name: 'Echo Base Defender', traits: ['rebel', 'trooper'], zone: 'ground' },
    SOR_237: { name: 'Alliance X-Wing', traits: ['rebel', 'vehicle', 'fighter'], zone: 'space' },
    SOR_033: { name: 'Death Trooper', traits: ['imperial', 'trooper'], zone: 'ground' },
    SOR_164: { name: 'Wampa', traits: ['creature'], zone: 'ground' },
    SOR_225: { name: 'TIE/ln Fighter', traits: ['imperial', 'vehicle', 'fighter'], zone: 'space' },
    SOR_232: { name: 'AT-ST', traits: ['imperial', 'vehicle', 'walker'], zone: 'ground' },
};
const tokenFacts: Record<string, BodyFact> = {
    'Battle Droid': { name: 'Battle Droid', traits: ['separatist', 'droid', 'trooper'], zone: 'ground' },
    'Clone Trooper': { name: 'Clone Trooper', traits: ['republic', 'clone', 'trooper'], zone: 'ground' },
    'X-Wing': { name: 'X-Wing', traits: ['vehicle', 'fighter'], zone: 'space' },
};
function knownBody(t: Located) {
    const u = t.unit, f = u.s && !u.t ? bodyFacts[u.s] : u.s === null && u.t === 1 ? tokenFacts[u.n] : undefined;
    return !!f && u.n === f.name && u.printedTitle === f.name && u.unique === false && u.leaderUnit === false && exact(u.traits, f.traits) && t.zone === f.zone
        && Number.isSafeInteger(u.p) && u.p >= 0 && Number.isSafeInteger(u.h) && u.h > 0 && Number.isSafeInteger(u.d) && u.d >= 0 && u.d < u.h
        && !u.status?.some(s => s.keyword?.name === 'Grit');
}
function removeUnit(expected: Snapshot, t: Located) {
    expected.players[t.seat][t.zone] = expected.players[t.seat][t.zone].filter(u => !same(u, t.unit));
    if (!t.unit.t) expected.players[t.unit.owner!].discard.push(t.unit);
    if (expected.pending) expected.pending = expected.pending.filter(p => p.targetId !== t.unit.id);
}
function departure(cue: CardEffectCue, item: PlacedOutcome, extra: string[] = []) {
    const o = item.outcome, t = locate(cue, o.card);
    if (!t || !knownBody(t) || !t.unit.owner || t.unit.u?.length || t.unit.cap?.length || !allowed(o, ['fromSeat', 'fromZone', 'ownerSeat', ...extra]) || !eventSource(cue, o)
        || o.kind !== 'defeat' || o.seat !== t.seat || o.fromSeat !== t.seat || o.fromZone !== t.zone || o.zone !== 'discard' || o.ownerSeat !== t.unit.owner || o.incarnation !== t.unit.incarnation || !exact(o.card, t.unit)
        || seats.some(s => same(cue.transition!.before.players[s].leader, t.unit))) return;
    return t;
}
function dropProof(cue: CardEffectCue, g: Geometry) {
    const expected = paidState(cue); if (!expected || !cue.transition || g.outcomes.length !== 2) return;
    const prior = refs(cue.transition.before), made = new Set<string>();
    for (const item of g.outcomes) {
        const o = item.outcome, u = o.unit;
        if (!u?.id || !u.incarnation || made.has(u.id) || prior.some(c => same(c, u)) || u.incarnation === cue.transition.before.mostRecentIncarnations?.[u.id] || !allowed(o, ['unit', 'ownerSeat', 'amount', 'tokenType', 'entryType', 'entersReady']) || !eventSource(cue, o)
            || o.kind !== 'create' || o.seat !== cue.seat || o.ownerSeat !== cue.seat || o.zone !== 'ground' || o.amount !== 1 || o.tokenType !== 'clone-trooper' || o.entryType !== 'created' || o.entersReady !== false || o.incarnation !== u.incarnation || !exact(o.card, u)
            || !exact(u, { id: u.id, n: 'Clone Trooper', s: null, owner: cue.seat, t: 1, p: 2, h: 2, d: 0, x: 1, traits: ['republic', 'clone', 'trooper'], printedTitle: 'Clone Trooper', unique: false, leaderUnit: false, incarnation: u.incarnation })) return;
        expected.players[cue.seat].ground.push(u); made.add(u.id);
    }
    return ending(cue, expected) ? { creates: g.outcomes, items: g.outcomes } : undefined;
}
function directProof(cue: CardEffectCue, g: Geometry) {
    const expected = paidState(cue); if (!expected || g.outcomes.length !== 1) return;
    const item = g.outcomes[0], t = departure(cue, item); if (!t || !t.unit.traits?.includes('vehicle')) return;
    removeUnit(expected, t); return ending(cue, expected) ? { item, t, items: g.outcomes } : undefined;
}
function phaseStats(cue: CardEffectCue, item: PlacedOutcome, kind: 'buff' | 'debuff', amount: string, extra: string[] = []) {
    const o = item.outcome, t = locate(cue, o.card);
    if (!t || !knownBody(t) || !allowed(o, ['round', 'amount', 'duration', ...extra]) || !eventSource(cue, o) || o.kind !== kind || !exact(o.card, t.unit) || o.seat !== t.seat || o.zone !== t.zone || o.incarnation !== t.unit.incarnation
        || o.round !== cue.transition!.before.round || o.amount !== amount || o.duration !== 'phase') return;
    return t;
}
function fixedEnd(expected: Snapshot, t: Located, kind: 'buff' | 'debuff', power: number, hp: number, amount: string): UnitRef {
    return { ...t.unit, p: Math.max(0, t.unit.p + power), h: Math.max(0, t.unit.h + hp), status: [...(t.unit.status ?? []), { kind, label: amount + ' · phase', duration: 'phase', round: expected.round, phase: expected.phase, incarnation: t.unit.incarnation }] };
}
function painProof(cue: CardEffectCue, g: Geometry) {
    const expected = paidState(cue); if (!expected || g.outcomes.length !== 1) return;
    const item = g.outcomes[0], o = item.outcome, w = o.woundBoost;
    if (!w || !Number.isSafeInteger(w.wounds) || w.wounds < 0) return;
    const amount = w.wounds, t = phaseStats(cue, item, 'buff', `+${amount}/+0`, ['woundBoost']);
    if (!t || !exact(w, { subjectId: key(t.unit), incarnation: t.unit.incarnation, wounds: t.unit.d })) return;
    const end = fixedEnd(expected, t, 'buff', amount, 0, `+${amount}/+0`); replace(expected, t, end);
    return ending(cue, expected) ? { item, t, amount, end, items: g.outcomes } : undefined;
}
function airlockProof(cue: CardEffectCue, g: Geometry) {
    const expected = paidState(cue); if (!expected || g.outcomes.length < 1 || g.outcomes.length > 2) return;
    const item = g.outcomes[0], t = phaseStats(cue, item, 'debuff', '-5/-5'); if (!t) return;
    const end = fixedEnd(expected, t, 'debuff', -5, -5, '-5/-5'); replace(expected, t, end);
    const lethal = end.d >= end.h, dead = g.outcomes[1];
    if (lethal) {
        if (!dead) return;
        const fallen = departure(cue, dead); if (!fallen || !same(fallen.unit, t.unit)) return;
        removeUnit(expected, t);
    } else if (dead) return;
    return ending(cue, expected) ? { item, t, end, dead, items: g.outcomes } : undefined;
}
function clearProof(cue: CardEffectCue, g: Geometry) {
    const expected = paidState(cue); if (!expected || !cue.transition || g.outcomes.length < 1 || g.outcomes.length > 2) return;
    const item = g.outcomes[0], t = departure(cue, item, ['spaceClearance']);
    if (!t || t.seat === cue.seat || t.zone !== 'space' || t.unit.h - t.unit.d > 3) return;
    const clear = cue.transition.before.players[t.seat].space.length === 1, w = item.outcome.spaceClearance;
    if (clear ? !w?.id || !exact(w, { id: w.id, defeatedId: key(t.unit), incarnation: t.unit.incarnation, opponent: t.seat, remainingIdsAtDefeat: [] }) : w !== undefined) return;
    removeUnit(expected, t);
    const buff = g.outcomes[1];
    if (!buff) return ending(cue, expected) ? { item, t, xp: undefined, items: g.outcomes } : undefined;
    const o = buff.outcome, host = locate(cue, o.card), token = o.cards?.[0];
    if (!clear || !w || !host || same(host.unit, t.unit) || !knownBody(host) || !allowed(o, ['ownerSeat', 'amount', 'duration', 'cards', 'requiresDefeat', 'spaceClearance']) || !eventSource(cue, o)
        || o.kind !== 'buff' || !exact(o.card, host.unit) || o.seat !== host.seat || o.zone !== host.zone || o.incarnation !== host.unit.incarnation || o.ownerSeat !== host.seat || o.amount !== '+1/+1' || o.duration !== 'token' || o.label !== '1 EXPERIENCE'
        || !exact(o.requiresDefeat, { id: key(t.unit), incarnation: t.unit.incarnation }) || !exact(o.spaceClearance, w) || o.cards?.length !== 1 || !token?.id || refs(cue.transition.before).some(c => same(c, token))
        || !exact(token, { id: token.id, n: 'Experience', s: null, owner: host.seat })) return;
    const upgrade = { ...token, t: 1 as const, p: 1, h: 1 }, end: UnitRef = { ...host.unit, p: host.unit.p + 1, h: host.unit.h + 1, u: [...(host.unit.u ?? []), upgrade] };
    replace(expected, host, end);
    return ending(cue, expected) ? { item, t, xp: { item: buff, t: host, token: upgrade, end }, items: g.outcomes } : undefined;
}
export function batchA14SecondaryCovers(cue: CardEffectCue, g: Geometry, item: PlacedOutcome) {
    switch (cue.definition.id) {
        case 'drop-in': return dropProof(cue, g)?.items.includes(item) ?? false;
        case 'power-from-pain': return painProof(cue, g)?.items.includes(item) ?? false;
        case 'youre-all-clear-kid': return clearProof(cue, g)?.items.includes(item) ?? false;
        case 'direct-hit': return directProof(cue, g)?.items.includes(item) ?? false;
        case 'out-the-airlock': return airlockProof(cue, g)?.items.includes(item) ?? false;
        default: return false;
    }
}
function Receipt({ at, rows, p, start = .73, until, color = '#b8dcd8' }: { at: EffectBox; rows: string[]; p: number; start?: number; until?: number; color?: string }) {
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
    const before = cue.transition!.before.players[cue.seat], paid = cue.playPayment?.kind === 'resources' ? cue.playPayment.cardIds! : [];
    return <>{before.resources!.map((r, i) => { const at = g.resourceCards?.[cue.seat + ':' + key(r)]; return at && paid.includes(key(r)) ? <ResourceSlot key={key(r)} at={at} index={i} spent p={p} start={.04} /> : null; })}<ResourceBalance at={g.zones[cue.seat + ':resources']} countAt={g.zones[cue.seat + ':resource-count']} ready={before.res.ready - paid.length} total={before.res.total} p={p} start={.04} /><Mask at={g.source} p={p} start={.04} /><CompactRoute from={g.source} to={g.zones[cue.seat + ':discard']} card={cue.source!} p={p} start={.04} end={.21} /></>;
}
function Counters({ at, u, p, start }: { at: EffectBox; u: UnitRef; p: number; start: number }) {
    const s = size(at); return <>{(['power', 'hp'] as const).map((n, i) => { const c = at.counters?.[n]; return <ScreenPixels key={n} at={c ? { ...at, ...c } : shift(at, (i ? 1 : -1) * (s.w / 2 - 10), s.h / 2 - 12)} opacity={visible(p, start)}><rect x="-11" y="-12" width="22" height="24" rx="3" fill={i ? '#174772' : '#8b2936'} stroke="#e1e7e6" /><text y="4" textAnchor="middle" fill="#fff" stroke="none" style={{ font: '800 14px sans-serif' }}>{i ? Math.max(0, u.h - u.d) : u.p}</text></ScreenPixels>; })}</>;
}
function Badge({ at, lines, p, start, color = '#c7d7e6' }: { at: EffectBox; lines: string[]; p: number; start: number; color?: string }) {
    const s = size(at), h = lines.length * 10 + 6; return <ScreenPixels at={shift(at, 0, -s.h / 2 + 8 + h / 2)} color={color} opacity={visible(p, start)}><rect x={-s.w / 2 + 2} y={-h / 2} width={s.w - 4} height={h} rx="2" fill="#101c2b" strokeWidth="1" />{lines.map((l, i) => <text key={i} y={-h / 2 + 10 + i * 10} textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '800 6px sans-serif' }}>{l}</text>)}</ScreenPixels>;
}
function Drop(props: Props) {
    const { cue, geometry: g, p } = props, r = dropProof(cue, g); if (!r) return null;
    return <><Payment {...props} /><Receipt at={center(g)} rows={['TWO CLONE TROOPERS', 'CREATED IN YOUR GROUND ARENA']} p={p} start={.06} until={.33} color="#bbd0ea" />{r.creates.map((item, i) => {
        const u = item.outcome.unit!, at = g.endingCards?.[cue.seat + ':' + key(u)] ?? item.to, s = size(at), start = .28 + i * .075, end = .68 + i * .075, t = easeInOut(phase(p, start, end));
        if (p < start) return null;
        return <g key={item.key}><ScreenPixels at={at} color="#b7cbe5" opacity={envelope(p, start, start + .025, end + .08)}><path d={`M${-s.w / 2 - 3} ${-s.h / 2 + 12} V${-s.h / 2 - 2} H${s.w / 2 + 3} V${-s.h / 2 + 12}`} fill="none" strokeWidth="3" />{[-1, 1].map(side => <path key={side} d={`M${side * s.w * .34} ${-s.h * .35} V${s.h * (.38 * t - .15)}`} strokeWidth="2" strokeDasharray="4 4" />)}</ScreenPixels><ScreenPixels at={at} opacity={visible(p, start)}><g transform={`translate(0 ${s.h * .12 * (1 - t)}) rotate(${10 * t})`} opacity={phase(p, start, start + .075)}><CardGhost card={u} box={s} /><rect x={-s.w / 2 + 2} y={-s.h / 2 + 3} width={s.w - 4} height="22" rx="2" fill="#162b44" stroke="none" /><text y={-s.h / 2 + 12} textAnchor="middle" fill="#e4eefc" stroke="none" style={{ font: '800 6px sans-serif' }}>CLONE TROOPER</text><text y={-s.h / 2 + 21} textAnchor="middle" fill="#c4d7f4" stroke="none" style={{ font: '700 6px sans-serif' }}>2/2 · EXHAUSTED</text>{[0, 1].map(n => <g key={n} transform={`translate(${(n ? 1 : -1) * (s.w / 2 - 10)} ${s.h / 2 - 12})`}><rect x="-10" y="-11" width="20" height="22" rx="3" fill={n ? '#174772' : '#8b2936'} stroke="#d5e2f5" /><text y="4" textAnchor="middle" fill="#fff" stroke="none" style={{ font: '800 13px sans-serif' }}>2</text></g>)}</g></ScreenPixels></g>;
    })}<Receipt at={center(g)} rows={['TWO FRESH 2/2 BODIES', 'CREATED EXHAUSTED IN GROUND']} p={p} start={.85} color="#bbd0ea" /></>;
}
function Depart({ geometry: g, p, item, t, start = .43, end = .73 }: Props & { item: PlacedOutcome; t: Located; start?: number; end?: number }) {
    const at = g.cards?.[t.seat + ':' + key(t.unit)] ?? item.from;
    return <><Mask at={at} p={p} start={start} />{t.unit.t ? <ScreenPixels at={at} color="#dcb898" opacity={envelope(p, start, start + .045, end)}><path d="M-13 -13 L13 13 M13 -13 L-13 13" strokeWidth="3" /><circle r={6 + 18 * phase(p, start, end)} fill="none" strokeDasharray="3 4" /></ScreenPixels> : <CompactRoute from={at} to={g.zones[t.unit.owner + ':discard'] ?? item.to} card={t.unit} p={p} start={start} end={end} />}</>;
}
function Direct(props: Props) {
    const { cue, geometry: g, p } = props, r = directProof(cue, g); if (!r) return null;
    const at = g.cards?.[r.t.seat + ':' + key(r.t.unit)] ?? r.item.from, s = size(at), lock = easeInOut(phase(p, .21, .4));
    return <><Payment {...props} /><Receipt at={center(g)} rows={['ONE NON-LEADER VEHICLE', r.t.zone.toUpperCase() + ' VEHICLE · DEFEAT']} p={p} start={.06} until={.36} color="#dcc19b" /><ScreenPixels at={at} color="#e4c48e" opacity={envelope(p, .21, .27, .46)}>{[-1, 1].flatMap(x => [-1, 1].map(y => <path key={x + ':' + y} d={`M${x * (s.w / 2 + 10 * (1 - lock))} ${y * (s.h / 2 - 8)} V${y * (s.h / 2 - 19)} M${x * (s.w / 2 + 10 * (1 - lock))} ${y * (s.h / 2 - 8)} H${x * (s.w / 2 - 10)}`} strokeWidth="2" />))}<path d="M-12 0 H12 M0 -12 V12" fill="none" strokeWidth="2" /></ScreenPixels><Badge at={at} lines={['VEHICLE LOCK']} p={p} start={.26} color="#e4c48e" /><Depart {...props} {...r} /><Receipt at={center(g)} rows={['TARGET DEFEATED', r.t.unit.t ? 'UNIT TOKEN CEASES' : 'OWNER ' + r.t.unit.owner!.toUpperCase() + ' DISCARD']} p={p} start={.82} color="#dcc19b" /></>;
}
function Pain(props: Props) {
    const { cue, geometry: g, p } = props, r = painProof(cue, g); if (!r) return null;
    const at = g.cards?.[r.t.seat + ':' + key(r.t.unit)] ?? r.item.box, s = size(at);
    return <><Payment {...props} /><Receipt at={center(g)} rows={[`${r.amount} EXISTING DAMAGE`, 'BONUS FIXED WHEN THIS EVENT RESOLVES']} p={p} start={.07} until={.36} color="#d9aeb8" /><ScreenPixels at={at} color="#e2adb9" opacity={envelope(p, .23, .3, .61)}><path d={`M${-s.w * .38} 0 H${s.w * .38}`} fill="none" strokeWidth="2" />{Array.from({ length: Math.min(8, r.amount) }, (_, i) => <circle key={i} cx={(i - (Math.min(8, r.amount) - 1) / 2) * 9} cy="0" r="3" fill="#962f49" stroke="#f0c2cd" />)}<path d={`M0 6 V${s.h / 2 - 15} H${-s.w / 2 + 12}`} fill="none" strokeWidth="2" strokeDasharray="4 3" /></ScreenPixels><Badge at={at} lines={[`+${r.amount} POWER · PHASE`, `${r.t.unit.d} WOUNDS KEPT`]} p={p} start={.46} color="#e2adb9" /><Counters at={at} u={r.end} p={p} start={.47} /><Receipt at={center(g)} rows={[`${r.t.unit.p} → ${r.end.p} POWER`, `MAX HP ${r.t.unit.h} · WOUNDS ${r.t.unit.d} UNCHANGED`]} p={p} start={.8} color="#d9aeb8" /></>;
}
function Airlock(props: Props) {
    const { cue, geometry: g, p } = props, r = airlockProof(cue, g); if (!r) return null;
    const at = g.cards?.[r.t.seat + ':' + key(r.t.unit)] ?? r.item.box, s = size(at), shrink = easeInOut(phase(p, .28, .57));
    return <><Payment {...props} /><Receipt at={center(g)} rows={['−5 POWER / −5 MAX HP', 'A PHASE REDUCTION · WOUNDS STAY']} p={p} start={.06} until={.35} color="#bbc2e4" /><ScreenPixels at={at} color="#b8c8ec" opacity={envelope(p, .22, .29, .65)}>{[0, 1, 2, 3, 4].map(i => <rect key={i} x={-s.w * (.45 - i * .045) * (1 - shrink * .35)} y={-s.h * (.32 - i * .028) * (1 - shrink * .3)} width={s.w * (.9 - i * .09) * (1 - shrink * .35)} height={s.h * (.64 - i * .056) * (1 - shrink * .3)} rx="2" fill="none" strokeWidth="1.4" opacity={1 - phase(p, .35 + i * .03, .5 + i * .03)} />)}</ScreenPixels><Badge at={at} lines={['−5/−5 · PHASE', `${r.t.unit.d} WOUNDS KEPT`]} p={p} start={.5} color="#c5ccef" /><Counters at={at} u={r.end} p={p} start={.53} />{r.dead && <Depart {...props} item={r.dead} t={r.t} start={.62} end={.83} />}<Receipt at={center(g)} rows={r.dead ? ['REDUCED HP IS LETHAL', r.t.unit.t ? 'UNIT TOKEN CEASES' : 'OWNER ' + r.t.unit.owner!.toUpperCase() + ' DISCARD'] : [`SURVIVES AT ${r.end.p}/${r.end.h} · ${r.end.d} WOUNDS`, 'REDUCTION REMAINS THIS PHASE']} p={p} start={.86} color="#bbc2e4" /></>;
}
function Clear(props: Props) {
    const { cue, geometry: g, p } = props, r = clearProof(cue, g); if (!r) return null;
    const from = g.cards?.[r.t.seat + ':' + key(r.t.unit)] ?? r.item.from;
    return <><Payment {...props} /><Receipt at={center(g)} rows={[`ENEMY SPACE · ${r.t.unit.h - r.t.unit.d} HP REMAINING`, 'DEFEAT FIRST, THEN CHECK THE LANE']} p={p} start={.06} until={.33} color="#bcd8c7" /><Badge at={from} lines={['SPACE TARGET', '3 OR LESS HP']} p={p} start={.18} color="#bddbcc" /><Depart {...props} {...r} start={.31} end={.58} />{r.xp && (() => {
        const xp = r.xp, at = g.cards?.[xp.t.seat + ':' + key(xp.t.unit)] ?? xp.item.box, to = g.endingCards?.[xp.t.seat + ':' + key(xp.token)] ?? shift(at, 0, -size(at).h / 2 + 12), lane = g.zones[r.t.seat + ':space'];
        const origin = lane ?? from, left = 12 / (to.sx ?? 1), approach = shift(to, 0, 24), route = [origin, { ...origin, x: left }, { ...approach, x: left }, approach, to], t = easeInOut(phase(p, .61, .81)), segment = Math.min(3, Math.floor(t * 4));
        const tokenAt = { ...to, ...mix(route[segment], route[segment + 1], easeInOut(t * 4 - segment)) }, grow = phase(p, .8, .84), w = 16 + 38 * grow, h = 12 + 4 * grow;
        return <><ScreenPixels at={lane ?? from} color="#b5d7bd" opacity={envelope(p, .56, .59, .68)}><path d="M-15 0 L-4 9 L17 -11" fill="none" strokeWidth="3" /></ScreenPixels><path d={route.map((point, i) => `${i ? 'L' : 'M'}${point.x} ${point.y}`).join(' ')} fill="none" stroke="#b5d7bd" strokeWidth="1.5" strokeDasharray="3 5" opacity={envelope(p, .61, .65, .82)} /><ScreenPixels at={tokenAt} color="#d6e2b1" opacity={visible(p, .61)}><rect x={-w / 2} y={-h / 2} width={w} height={h} rx="3" fill="#203527" strokeWidth="1" /><text y="3" textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '800 7px sans-serif' }}>{grow > .7 ? 'EXPERIENCE' : 'XP'}</text></ScreenPixels><Counters at={at} u={xp.end} p={p} start={.81} /></>;
    })()}<Receipt at={center(g)} rows={r.xp ? ['ENEMY SPACE CLEARED BY THE DEFEAT', 'ONE EXPERIENCE · +1/+1 · WOUNDS KEPT'] : ['SPACE DEFEAT RESOLVED', 'NO EXPERIENCE CHOSEN OR AVAILABLE']} p={p} start={.87} color="#bcd8c7" /></>;
}
export function BatchA14SecondarySignature(props: Props) {
    switch (props.cue.definition.id) {
        case 'drop-in': return <Drop {...props} />;
        case 'power-from-pain': return <Pain {...props} />;
        case 'youre-all-clear-kid': return <Clear {...props} />;
        case 'direct-hit': return <Direct {...props} />;
        case 'out-the-airlock': return <Airlock {...props} />;
        default: return null;
    }
}
