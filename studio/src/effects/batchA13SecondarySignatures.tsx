import type { CardRef, Seat, Snapshot, UnitRef } from '../data/types';
import type { CardEffectCue, CardEffectOutcome } from './types';
import { A13_DEFINITIONS } from './batchA13';
import { previewPlayCost } from './previewCosts';
import { easeInOut, envelope, phase } from './animationTimeline';
import { CardGhost, ResourceBalance, ResourceSlot, ScreenPixels, mix, screenShift as shift, type EffectBox, type PlacedOutcome } from './primitives';

type Geometry = { source: EffectBox; target: EffectBox; friendlyBase: EffectBox; outcomes: PlacedOutcome[]; zones: Record<string, EffectBox>; cards?: Record<string, EffectBox>; endingCards?: Record<string, EffectBox>; resourceCards?: Record<string, EffectBox> };
type Props = { cue: CardEffectCue; geometry: Geometry; p: number };
const seats: Seat[] = ['p1', 'p2'];
const ids = new Set(['political-pressure', 'droid-deployment', 'merciless-contest', 'heroes-on-both-sides', 'sword-and-shield-maneuver']);
export const isBatchA13Secondary = (cue: CardEffectCue) => ids.has(cue.definition.id);
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
const size = (at: EffectBox) => at.cardSize ?? { w: at.w * (at.sx ?? 1), h: at.h * (at.sy ?? 1) };
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
    const d = A13_DEFINITIONS.find(d => d.id === cue.definition.id), t = cue.transition;
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
function createdDroids(cue: CardEffectCue, g: Geometry, expected: Snapshot, extra: string[] = []) {
    if (!cue.transition || g.outcomes.length !== 2) return;
    const old = refs(cue.transition.before), made = new Set<string>();
    for (const item of g.outcomes) {
        const o = item.outcome, u = o.unit;
        if (!u?.id || !u.incarnation || made.has(u.id) || old.some(c => same(c, u)) || !allowed(o, ['unit', 'ownerSeat', 'amount', 'tokenType', 'entryType', 'entersReady', ...extra]) || !eventSource(cue, o) || o.kind !== 'create' || o.seat !== cue.seat || o.zone !== 'ground' || o.ownerSeat !== cue.seat || o.amount !== 1 || o.tokenType !== 'battle-droid' || o.entryType !== 'created' || o.entersReady !== false || o.incarnation !== u.incarnation || !exact(o.card, u)
            || !exact(u, { id: u.id, n: 'Battle Droid', s: null, owner: cue.seat, t: 1, p: 1, h: 1, d: 0, x: 1, traits: ['separatist', 'droid', 'trooper'], printedTitle: 'Battle Droid', unique: false, leaderUnit: false, incarnation: u.incarnation })) return;
        expected.players[cue.seat].ground.push(u); made.add(u.id);
    }
    return g.outcomes;
}
function deploymentProof(cue: CardEffectCue, g: Geometry) {
    const expected = paidState(cue); if (!expected) return;
    const creates = createdDroids(cue, g, expected); return creates && ending(cue, expected) ? { creates, items: g.outcomes } : undefined;
}
function politicalProof(cue: CardEffectCue, g: Geometry) {
    const expected = paidState(cue); if (!expected || !cue.transition || !g.outcomes.length) return;
    const enemy: Seat = cue.seat === 'p1' ? 'p2' : 'p1', choice = g.outcomes[0].outcome.choice;
    if (choice?.kind !== 'opponent-random-discard' || choice.chooserSeat !== enemy || choice.handSeat !== enemy || g.outcomes.some(i => !exact(i.outcome.choice, choice))) return;
    if (choice.result === 'not-discarded') {
        // A prevented attempted discard requires its own result receipts. An empty hand has no phantom loss.
        if (choice.selectedId !== undefined || choice.decision !== 'decline' && !(choice.decision === 'discard' && !cue.transition.before.players[enemy].hand.length)) return;
        const creates = createdDroids(cue, g, expected, ['choice']);
        return creates && ending(cue, expected) ? { creates, discard: undefined, choice, items: g.outcomes } : undefined;
    }
    if (choice.result !== 'discarded' || choice.decision !== 'discard' || !choice.selectedId || g.outcomes.length !== 1) return;
    const item = g.outcomes[0], o = item.outcome, c = cue.transition.before.players[enemy].hand.find(c => c.id === choice.selectedId);
    if (!c || c.owner !== enemy || !allowed(o, ['fromSeat', 'fromZone', 'ownerSeat', 'selection', 'chooserSeat', 'choice', 'amount']) || !eventSource(cue, o) || o.kind !== 'discard' || !refEqual(o.card, c) || o.seat !== enemy || o.fromSeat !== enemy || o.fromZone !== 'hand' || o.zone !== 'discard' || o.ownerSeat !== enemy || o.amount !== 1 || o.selection !== 'random' || o.chooserSeat !== undefined || o.incarnation !== undefined) return;
    expected.players[enemy].hand = expected.players[enemy].hand.filter(a => !same(a, c)); expected.players[enemy].discard.push(c);
    return ending(cue, expected) ? { creates: [], discard: item, choice, items: g.outcomes } : undefined;
}
function mercilessProof(cue: CardEffectCue, g: Geometry) {
    const expected = paidState(cue); if (!expected || !cue.transition || g.outcomes.length > 2) return;
    const members: { item: PlacedOutcome; t: Located }[] = [], group = g.outcomes[0]?.outcome.resolutionGroup;
    if (g.outcomes.length && (!group?.id || group.mode !== 'simultaneous')) return;
    for (const seat of seats) {
        const all = units(cue.transition.before, seat); if (all.some(u => u.leaderUnit === undefined)) return;
        const eligible = all.filter(u => u.leaderUnit === false), chosen = g.outcomes.filter(i => i.outcome.seat === seat);
        if (chosen.length !== (eligible.length ? 1 : 0)) return;
        if (!chosen.length) continue;
        const item = chosen[0], o = item.outcome, t = locate(cue, o.card);
        if (!t || t.seat !== seat || t.unit.leaderUnit !== false || !t.unit.owner || t.unit.u?.length || t.unit.cap?.length || !allowed(o, ['fromSeat', 'fromZone', 'ownerSeat', 'chooserSeat', 'selection', 'resolutionGroup']) || !eventSource(cue, o) || o.kind !== 'defeat' || o.zone !== 'discard' || o.fromSeat !== t.seat || o.fromZone !== t.zone || o.incarnation !== t.unit.incarnation || o.ownerSeat !== t.unit.owner || o.chooserSeat !== seat || o.selection !== 'chosen' || !exact(o.resolutionGroup, group) || !exact(o.card, t.unit) || seats.some(s => same(cue.transition!.before.players[s].leader, t.unit))) return;
        expected.players[seat][t.zone] = expected.players[seat][t.zone].filter(c => !same(c, t.unit));
        if (!t.unit.t) expected.players[t.unit.owner].discard.push(t.unit);
        if (expected.pending) expected.pending = expected.pending.filter(p => p.targetId !== t.unit.id);
        members.push({ item, t });
    }
    return members.length === g.outcomes.length && ending(cue, expected) ? { members, items: g.outcomes } : undefined;
}
function grantMatches(cue: CardEffectCue, o: CardEffectOutcome, t: Located, trait: string, scope: string, members: UnitRef[]) {
    const grant = o.traitGrant;
    return !!grant?.id && grant.trait === trait && grant.scope === scope && exact(grant.members, members.map(u => ({ id: key(u), incarnation: u.incarnation }))) && members.every(u => !!u.incarnation && u.traits?.includes(trait))
        && eventSource(cue, o) && o.seat === t.seat && o.zone === t.zone && o.incarnation === t.unit.incarnation && exact(o.card, t.unit) && o.duration === 'phase';
}
function addKeyword(u: UnitRef, name: 'Saboteur' | 'Raid' | 'Sentinel', state: Snapshot): UnitRef {
    return { ...u, ...(name === 'Sentinel' ? { sn: 1 as const } : {}), status: [...(u.status ?? []), { kind: 'keyword' as const, label: `${name}${name === 'Raid' ? ' 1' : ''} · phase`, duration: 'phase' as const, keyword: { name, amount: 1 }, round: state.round, phase: state.phase, incarnation: u.incarnation }] };
}
function heroesProof(cue: CardEffectCue, g: Geometry) {
    const expected = paidState(cue); if (!expected || !cue.transition || g.outcomes.length % 2 || g.outcomes.length > 4) return;
    const seen = new Set<string>(), members: { buff: PlacedOutcome; keyword: PlacedOutcome; t: Located; end: UnitRef; trait: string }[] = [];
    for (let i = 0; i < g.outcomes.length; i += 2) {
        const buff = g.outcomes[i], keyword = g.outcomes[i + 1], b = buff.outcome, k = keyword.outcome, t = locate(cue, b.card), trait = b.traitGrant?.trait;
        if (!t || !['republic', 'separatist'].includes(trait ?? '') || seen.has(trait!) || !allowed(b, ['amount', 'duration', 'traitGrant']) || !allowed(k, ['keyword', 'duration', 'traitGrant']) || !grantMatches(cue, b, t, trait!, 'up-to-one-any', [t.unit]) || !grantMatches(cue, k, t, trait!, 'up-to-one-any', [t.unit]) || !exact(b.traitGrant, k.traitGrant) || b.kind !== 'buff' || b.amount !== '+2/+2' || k.kind !== 'keyword' || !exact(k.keyword, { name: 'Saboteur', amount: 1 })) return;
        const current = units(expected, t.seat).find(u => same(u, t.unit))!;
        const boosted: UnitRef = { ...current, p: current.p + 2, h: current.h + 2, status: [...(current.status ?? []), { kind: 'buff', label: '+2/+2 · phase', duration: 'phase', round: expected.round, phase: expected.phase, incarnation: current.incarnation }] };
        const end = addKeyword(boosted, 'Saboteur', expected); replace(expected, t, end); seen.add(trait!); members.push({ buff, keyword, t, end, trait: trait! });
    }
    return ending(cue, expected) ? { members, items: g.outcomes } : undefined;
}
function swordProof(cue: CardEffectCue, g: Geometry) {
    const expected = paidState(cue); if (!expected || !cue.transition) return;
    const all = units(cue.transition.before, cue.seat); if (all.some(u => !u.traits || !u.incarnation)) return;
    const group = g.outcomes[0]?.outcome.resolutionGroup;
    if (g.outcomes.length && (!group?.id || group.mode !== 'simultaneous')) return;
    let index = 0; const members: { item: PlacedOutcome; t: Located; end: UnitRef; name: 'Raid' | 'Sentinel' }[] = [];
    for (const trait of ['trooper', 'jedi'] as const) {
        const targets = all.filter(u => u.traits!.includes(trait)), name = trait === 'trooper' ? 'Raid' : 'Sentinel';
        for (const unit of targets) {
            const item = g.outcomes[index++], o = item?.outcome, t = locate(cue, unit);
            if (!o || !t || !allowed(o, ['keyword', 'duration', 'traitGrant', 'resolutionGroup']) || !grantMatches(cue, o, t, trait, 'all-friendly', targets) || o.kind !== 'keyword' || !exact(o.keyword, { name, amount: 1 }) || !exact(o.resolutionGroup, group)) return;
            const end = addKeyword(units(expected, t.seat).find(u => same(u, unit))!, name, expected); replace(expected, t, end); members.push({ item, t, end, name });
        }
    }
    return index === g.outcomes.length && ending(cue, expected) ? { members, items: g.outcomes } : undefined;
}
export function batchA13SecondaryCovers(cue: CardEffectCue, g: Geometry, item: PlacedOutcome) {
    switch (cue.definition.id) {
        case 'political-pressure': return politicalProof(cue, g)?.items.includes(item) ?? false;
        case 'droid-deployment': return deploymentProof(cue, g)?.items.includes(item) ?? false;
        case 'merciless-contest': return mercilessProof(cue, g)?.items.includes(item) ?? false;
        case 'heroes-on-both-sides': return heroesProof(cue, g)?.items.includes(item) ?? false;
        case 'sword-and-shield-maneuver': return swordProof(cue, g)?.items.includes(item) ?? false;
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
function Droid({ item, geometry: g, p, start, end, pressure = false }: { item: PlacedOutcome; geometry: Geometry; p: number; start: number; end: number; pressure?: boolean }) {
    const u = item.outcome.unit!, at = g.endingCards?.[item.outcome.seat + ':' + key(u)] ?? item.to, s = size(at), t = easeInOut(phase(p, start, end));
    if (p < start) return null;
    return <ScreenPixels at={at} color="#d5c493" opacity={visible(p, start)}><g transform={`rotate(${10 * t})`}><g opacity={1 - t}>{pressure ? <path d={`M${-s.w / 2} ${s.h / 2} V${-s.h / 2} H${s.w / 2} V${s.h / 2} M${-s.w / 2} 0 H${s.w / 2}`} fill="none" strokeWidth="2" /> : [-1, 1].map(side => <path key={side} d={`M0 ${-s.h / 2} L${side * s.w / 2} ${-s.h / 2 + s.h * t / 3} V${s.h / 2} H0 Z`} fill="#242e2a" strokeWidth="2" />)}</g><g opacity={phase(p, start + .035, end)}><CardGhost card={u} box={s} /><rect x={-s.w / 2 + 3} y={-s.h / 2 + 3} width={s.w - 6} height="21" rx="2" fill="#29332a" stroke="none" /><text y={-s.h / 2 + 11} textAnchor="middle" fill="#eff5d2" stroke="none" style={{ font: '800 6px sans-serif' }}>BATTLE DROID</text><text y={-s.h / 2 + 20} textAnchor="middle" fill="#dbedb7" stroke="none" style={{ font: '700 6px sans-serif' }}>CREATED · EXHAUSTED</text>{[0, 1].map(i => <g key={i} transform={`translate(${(i ? 1 : -1) * (s.w / 2 - 10)} ${s.h / 2 - 12})`}><rect x="-10" y="-11" width="20" height="22" rx="3" fill={i ? '#174772' : '#8b2936'} stroke="#e0e8c5" /><text y="4" textAnchor="middle" fill="#fff" stroke="none" style={{ font: '800 13px sans-serif' }}>1</text></g>)}</g></g></ScreenPixels>;
}
function Counters({ at, u, p, start }: { at: EffectBox; u: UnitRef; p: number; start: number }) {
    const s = size(at); return <>{(['power', 'hp'] as const).map((n, i) => { const c = at.counters?.[n]; return <ScreenPixels key={n} at={c ? { ...at, ...c } : shift(at, (i ? 1 : -1) * (s.w / 2 - 10), s.h / 2 - 12)} opacity={visible(p, start)}><rect x="-11" y="-12" width="22" height="24" rx="3" fill={i ? '#174772' : '#8b2936'} stroke="#e1e7e6" /><text y="4" textAnchor="middle" fill="#fff" stroke="none" style={{ font: '800 14px sans-serif' }}>{i ? u.h - u.d : u.p}</text></ScreenPixels>; })}</>;
}
function Badge({ at, lines, p, start, color = '#c7d7e6' }: { at: EffectBox; lines: string[]; p: number; start: number; color?: string }) {
    const s = size(at), h = lines.length * 10 + 6; return <ScreenPixels at={shift(at, 0, -s.h / 2 + 8 + h / 2)} color={color} opacity={visible(p, start)}><rect x={-s.w / 2 + 2} y={-h / 2} width={s.w - 4} height={h} rx="2" fill="#101c2b" strokeWidth="1" />{lines.map((l, i) => <text key={i} y={-h / 2 + 10 + i * 10} textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '800 6px sans-serif' }}>{l}</text>)}</ScreenPixels>;
}
function Political(props: Props) {
    const { cue, geometry: g, p } = props, r = politicalProof(cue, g); if (!r) return null;
    return <><Payment {...props} /><Receipt at={center(g)} rows={[`${r.choice.chooserSeat.toUpperCase()} CHOOSES THE MODE`, r.discard ? 'RANDOM CARD · NOT A CARD CHOICE' : r.choice.decision === 'decline' ? 'DECLINES THE RANDOM DISCARD' : 'NO CARD COULD BE DISCARDED']} p={p} start={.08} until={.4} color="#d4bea2" />{r.creates.map((i, n) => <Droid key={i.key} item={i} geometry={g} p={p} start={.42 + n * .045} end={.75 + n * .045} pressure />)}{r.discard && <><Mask at={r.discard.from} p={p} start={.4} /><CompactRoute from={r.discard.from} to={r.discard.to} card={r.discard.outcome.card!} p={p} start={.4} end={.76} /></>}<Receipt at={center(g)} rows={r.discard ? ['ONE RANDOM OPPONENT CARD DISCARDED', 'NO DROIDS CREATED'] : ['NO OPPONENT HAND LOSS', 'TWO OWN EXHAUSTED DROIDS']} p={p} start={.84} /></>;
}
function Deployment(props: Props) {
    const { cue, geometry: g, p } = props, r = deploymentProof(cue, g); if (!r) return null;
    return <><Payment {...props} /><Receipt at={center(g)} rows={['TWO DIRECT TOKEN ENTRIES', 'GROUND · 1/1 · EXHAUSTED']} p={p} start={.06} until={.36} />{r.creates.map((i, n) => <Droid key={i.key} item={i} geometry={g} p={p} start={.31 + n * .025} end={.7 + n * .025} />)}<Receipt at={center(g)} rows={['TWO NEW BODIES IN FORMATION', 'NO HAND OR DECK ORIGIN']} p={p} start={.82} /></>;
}
function Merciless(props: Props) {
    const { cue, geometry: g, p } = props, r = mercilessProof(cue, g); if (!r) return null;
    return <><Payment {...props} /><Receipt at={center(g)} rows={['EACH PLAYER CHOOSES ITS OWN UNIT', 'NON-LEADERS · EITHER ARENA']} p={p} start={.06} until={.35} color="#d5b3a0" />{r.members.map(({ item, t }) => { const from = g.cards?.[t.seat + ':' + key(t.unit)] ?? item.from; return <g key={item.key}><Badge at={from} lines={[t.seat.toUpperCase() + ' CHOICE']} p={p} start={.2} /><Mask at={from} p={p} start={.45} />{t.unit.t ? <ScreenPixels at={from} opacity={envelope(p, .45, .51, .78)} color="#d7bea4"><path d="M-14 -14 L14 14 M14 -14 L-14 14" fill="none" strokeWidth="3" /></ScreenPixels> : <CompactRoute from={from} to={g.zones[t.unit.owner + ':discard'] ?? item.to} card={t.unit} p={p} start={.46} end={.78} />}</g>; })}<Receipt at={center(g)} rows={r.members.length ? r.members.map(m => `${m.t.seat.toUpperCase()} CHOICE → ${m.t.unit.t ? 'TOKEN CEASES' : m.t.unit.owner!.toUpperCase() + ' DISCARD'}`) : ['NO ELIGIBLE NON-LEADER UNITS']} p={p} start={.85} color="#d6c1ac" /></>;
}
function Heroes(props: Props) {
    const { cue, geometry: g, p } = props, r = heroesProof(cue, g); if (!r) return null;
    const groups = r.members.filter((m, i) => r.members.findIndex(other => same(other.t.unit, m.t.unit)) === i);
    return <><Payment {...props} /><Receipt at={center(g)} rows={['REPUBLIC + SEPARATIST ROLES', 'EITHER CONTROLLER · THIS PHASE']} p={p} start={.06} until={.35} color="#bcdbb8" />{r.members.map((m, i) => {
        const at = g.cards?.[m.t.seat + ':' + key(m.t.unit)] ?? m.buff.box;
        return <path key={m.trait} d={`M${center(g).x} ${center(g).y} L${at.x} ${at.y}`} fill="none" stroke={i ? '#d4bf8d' : '#9fc9c4'} strokeDasharray="3 5" strokeWidth="2" opacity={envelope(p, .24 + i * .035, .36, .62)} />;
    })}{groups.map(m => {
        const at = g.cards?.[m.t.seat + ':' + key(m.t.unit)] ?? m.buff.box, roles = r.members.filter(other => same(other.t.unit, m.t.unit));
        const last = roles[roles.length - 1], start = .43 + r.members.indexOf(last) * .025;
        return <g key={key(m.t.unit)}><Badge at={at} lines={[...roles.map(role => role.trait.toUpperCase()), 'SABOTEUR · PHASE']} p={p} start={start} /><Counters at={at} u={last.end} p={p} start={start} /></g>;
    })}<Receipt at={center(g)} rows={['+2/+2 FOR EACH CHOSEN ROLE', 'WOUNDS, POSE AND OWNERS KEPT']} p={p} start={.79} /></>;
}
function Sword(props: Props) {
    const { cue, geometry: g, p } = props, r = swordProof(cue, g); if (!r) return null;
    return <><Payment {...props} /><Receipt at={center(g)} rows={['ALL FRIENDLY TROOPERS AND JEDI', 'BOTH ARENAS · THIS PHASE']} p={p} start={.06} until={.32} color="#b4c7e5" />{r.members.map((m, i) => { const at = g.cards?.[m.t.seat + ':' + key(m.t.unit)] ?? m.item.box, s = size(at), held = r.members.filter(other => same(other.t.unit, m.t.unit)); return <g key={m.item.key}><ScreenPixels at={at} color={m.name === 'Raid' ? '#dec093' : '#a7c5e8'} opacity={envelope(p, .26 + i * .012, .39, .65)}>{m.name === 'Raid' ? <path d={`M${-s.w / 2 - 3} ${s.h / 2 - 12} L${s.w / 2 + 3} ${-s.h / 2 + 8}`} fill="none" strokeWidth="3" /> : <path d={`M${-s.w / 2 - 4} ${-s.h / 2 + 6} Q0 ${-s.h / 2 - 14} ${s.w / 2 + 4} ${-s.h / 2 + 6} V${s.h / 2 - 12} Q0 ${s.h / 2 + 12} ${-s.w / 2 - 4} ${s.h / 2 - 12} Z`} fill="none" strokeWidth="2" />}</ScreenPixels>{held[0] === m && <Badge at={at} lines={held.map(x => (x.name === 'Raid' ? 'RAID 1' : 'SENTINEL') + ' · PHASE')} p={p} start={.5} color="#b7cce6" />}</g>; })}<Receipt at={center(g)} rows={['RAID APPLIES ONLY WHILE ATTACKING', 'RESTING STATS AND WOUNDS KEPT']} p={p} start={.78} /></>;
}
export function BatchA13SecondarySignature(props: Props) {
    switch (props.cue.definition.id) {
        case 'political-pressure': return <Political {...props} />;
        case 'droid-deployment': return <Deployment {...props} />;
        case 'merciless-contest': return <Merciless {...props} />;
        case 'heroes-on-both-sides': return <Heroes {...props} />;
        case 'sword-and-shield-maneuver': return <Sword {...props} />;
        default: return null;
    }
}
