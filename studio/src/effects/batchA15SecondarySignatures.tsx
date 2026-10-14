import type { CardRef, Seat, Snapshot, UnitRef } from '../data/types';
import type { CardEffectCue, CardEffectOutcome } from './types';
import { A15_DEFINITIONS } from './batchA15';
import { previewPlayCost } from './previewCosts';
import { easeInOut, envelope, phase } from './animationTimeline';
import { CardGhost, ResourceBalance, ResourceSlot, ScreenPixels, mix, screenShift as shift, type EffectBox, type PlacedOutcome } from './primitives';

type Geometry = { source: EffectBox; target: EffectBox; friendlyBase: EffectBox; outcomes: PlacedOutcome[]; zones: Record<string, EffectBox>; cards?: Record<string, EffectBox>; endingCards?: Record<string, EffectBox>; resourceCards?: Record<string, EffectBox> };
type Props = { cue: CardEffectCue; geometry: Geometry; p: number };
const seats: Seat[] = ['p1', 'p2'];
const ids = new Set(['nebula-ignition', 'apology-accepted', 'unity-of-purpose', 'all-wings-report-in', 'air-superiority']);
export const isBatchA15Secondary = (cue: CardEffectCue) => ids.has(cue.definition.id);
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
    const d = A15_DEFINITIONS.find(d => d.id === cue.definition.id), t = cue.transition;
    if (!d || !t || cue.stage || cue.definition.name !== d.name || cue.definition.setCode !== d.setCode || !cue.source?.id || cue.source.n !== d.name || cue.source.s !== d.setCode || cue.source.owner !== cue.seat || t.before.phase !== 'action'
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

type BodyFact = { name: string; title?: string; unique?: boolean; traits: string[]; zone: 'ground' | 'space' };
const bodyFacts: Record<string, BodyFact> = {
    SOR_095: { name: 'Battlefield Marine', traits: ['rebel', 'trooper'], zone: 'ground' },
    SOR_098: { name: 'Echo Base Defender', traits: ['rebel', 'trooper'], zone: 'ground' },
    SOR_237: { name: 'Alliance X-Wing', traits: ['rebel', 'vehicle', 'fighter'], zone: 'space' },
    SOR_033: { name: 'Death Trooper', traits: ['imperial', 'trooper'], zone: 'ground' },
    SOR_164: { name: 'Wampa', traits: ['creature'], zone: 'ground' },
    SOR_225: { name: 'TIE/ln Fighter', traits: ['imperial', 'vehicle', 'fighter'], zone: 'space' },
    SOR_232: { name: 'AT-ST', traits: ['imperial', 'vehicle', 'walker'], zone: 'ground' },
    SHD_204: { name: "Millennium Falcon: Lando's Pride", title: 'Millennium Falcon', unique: true, traits: ['underworld', 'vehicle', 'transport'], zone: 'space' },
    JTL_249: { name: 'Millennium Falcon: Get Out And Push', title: 'Millennium Falcon', unique: true, traits: ['rebel', 'vehicle', 'transport'], zone: 'space' },
};
const tokenFacts: Record<string, BodyFact> = {
    'Battle Droid': { name: 'Battle Droid', traits: ['separatist', 'droid', 'trooper'], zone: 'ground' },
    'Clone Trooper': { name: 'Clone Trooper', traits: ['republic', 'clone', 'trooper'], zone: 'ground' },
    'X-Wing': { name: 'X-Wing', traits: ['vehicle', 'fighter'], zone: 'space' },
    'TIE Fighter': { name: 'TIE Fighter', traits: ['vehicle', 'fighter'], zone: 'space' },
};
function knownBody(t: Located) {
    const u = t.unit, f = u.s && !u.t ? bodyFacts[u.s] : u.s === null && u.t === 1 ? tokenFacts[u.n] : undefined;
    return !!f && u.n === f.name && u.printedTitle === (f.title ?? f.name) && u.unique === !!f.unique && u.leaderUnit === false && exact(u.traits, f.traits) && t.zone === f.zone
        && Number.isSafeInteger(u.p) && u.p >= 0 && Number.isSafeInteger(u.h) && u.h > 0 && Number.isSafeInteger(u.d) && u.d >= 0 && u.d < u.h
        && !u.status?.some(s => s.keyword?.name === 'Grit');
}
function supportedBattlefield(cue: CardEffectCue) {
    return seats.every(seat => units(cue.transition!.before, seat).every(u => {
        const t = locate(cue, u);
        return !!t && knownBody(t) && !!u.owner && !u.cap?.length && !(u.u ?? []).some(a => !a.t || a.s !== null || !['Shield', 'Experience'].includes(a.n));
    }));
}
function removeUnit(expected: Snapshot, t: Located) {
    expected.players[t.seat][t.zone] = expected.players[t.seat][t.zone].filter(u => !same(u, t.unit));
    if (!t.unit.t) expected.players[t.unit.owner!].discard.push(t.unit);
    if (expected.pending) expected.pending = expected.pending.filter(p => p.targetId !== t.unit.id);
}
function departure(cue: CardEffectCue, item: PlacedOutcome, extra: string[] = [], mayPrevent = false) {
    const o = item.outcome, t = locate(cue, o.card);
    if (!t || !knownBody(t) || !t.unit.owner || t.unit.u?.length || t.unit.cap?.length || !allowed(o, ['fromSeat', 'fromZone', 'ownerSeat', ...extra]) || !refEqual(cue.source, o.sourceCard) || o.prevented && !mayPrevent
        || o.kind !== 'defeat' || o.seat !== t.seat || o.fromSeat !== t.seat || o.fromZone !== t.zone || o.zone !== 'discard' || o.ownerSeat !== t.unit.owner || o.incarnation !== t.unit.incarnation || !exact(o.card, t.unit)
        || seats.some(s => same(cue.transition!.before.players[s].leader, t.unit))) return;
    return t;
}
const entry = (u: UnitRef) => ({ id: key(u), incarnation: u.incarnation! });
const membersEqual = (a: { id: string; incarnation: string }[], b: { id: string; incarnation: string }[]) => a.length === b.length && new Set(a.map(m => m.id)).size === a.length && a.every(m => b.some(n => exact(m, n)));

function nebulaProof(cue: CardEffectCue, g: Geometry) {
    const expected = paidState(cue); if (!expected || !cue.transition) return;
    const all = seats.flatMap(s => units(cue.transition!.before, s)), selected = all.filter(u => !u.u?.length), dead: { item: PlacedOutcome; t: Located }[] = [];
    if (g.outcomes.length !== selected.length) return;
    const witness = g.outcomes[0]?.outcome.unupgradedSet;
    if (selected.length && (!witness?.id || !exact({ ...witness, members: [] }, { id: witness.id, sourceId: key(cue.source), round: expected.round, phase: expected.phase, members: [] }) || !membersEqual(witness.members, selected.map(entry)))) return;
    for (const item of g.outcomes) {
        const t = departure(cue, item, ['unupgradedSet']);
        if (!t || dead.some(d => same(d.t.unit, t.unit)) || !selected.some(u => same(u, t.unit)) || !exact(item.outcome.unupgradedSet, witness)) return;
        dead.push({ item, t }); removeUnit(expected, t);
    }
    return ending(cue, expected) ? { dead, protectedUnits: all.filter(u => u.u?.length), items: g.outcomes } : undefined;
}
function apologyProof(cue: CardEffectCue, g: Geometry) {
    const expected = paidState(cue); if (!expected || !cue.transition || g.outcomes.length < 1 || g.outcomes.length > 2) return;
    const item = g.outcomes[0], o = item.outcome, t = departure(cue, item, ['sequenceId', 'sequenceIndex'], true);
    if (!t || t.seat !== cue.seat || !o.sequenceId || o.sequenceIndex !== 1) return;
    if (!o.prevented) removeUnit(expected, t);
    const buff = g.outcomes[1];
    if (!buff) return ending(cue, expected) ? { item, t, prevented: !!o.prevented, xp: undefined, items: g.outcomes } : undefined;
    const b = buff.outcome, host = locate(cue, b.card), cards = b.cards;
    if (!host || !knownBody(host) || !o.prevented && same(host.unit, t.unit) || !allowed(b, ['amount', 'duration', 'cards', 'sequenceId', 'sequenceIndex']) || !eventSource(cue, b)
        || b.kind !== 'buff' || !exact(b.card, host.unit) || b.seat !== host.seat || b.zone !== host.zone || b.incarnation !== host.unit.incarnation || b.amount !== '+2/+2' || b.duration !== 'token'
        || b.label !== '2 EXPERIENCE' || b.sequenceId !== o.sequenceId || b.sequenceIndex !== 2 || cards?.length !== 2 || new Set(cards.map(key)).size !== 2
        || cards.some(c => !c.id || refs(cue.transition!.before).some(old => same(c, old)) || !exact(c, { id: c.id, n: 'Experience', s: null, owner: host.seat }))) return;
    const upgrades = cards.map(c => ({ ...c, t: 1 as const, p: 1, h: 1 })), end = { ...host.unit, p: host.unit.p + 2, h: host.unit.h + 2, u: [...(host.unit.u ?? []), ...upgrades] };
    replace(expected, host, end);
    return ending(cue, expected) ? { item, t, prevented: !!o.prevented, xp: { item: buff, t: host, upgrades, end }, items: g.outcomes } : undefined;
}
function unityProof(cue: CardEffectCue, g: Geometry) {
    const expected = paidState(cue); if (!expected || !cue.transition) return;
    const all = units(cue.transition.before, cue.seat), titles = [...new Set(all.map(u => u.printedTitle))], amount = titles.length;
    if (g.outcomes.length !== all.length || all.some(u => { const t = locate(cue, u); return !t || !knownBody(t); })) return;
    const witness = g.outcomes[0]?.outcome.distinctTitleBoost, changed: { item: PlacedOutcome; t: Located; end: UnitRef }[] = [];
    if (all.length && (!witness?.id || !exact(witness, { id: witness.id, sourceId: key(cue.source), round: expected.round, phase: expected.phase, members: all.map(u => ({ ...entry(u), title: u.printedTitle })), titles, amount }))) return;
    for (const item of g.outcomes) {
        const o = item.outcome, t = locate(cue, o.card);
        if (!t || t.seat !== cue.seat || changed.some(v => same(v.t.unit, t.unit)) || !allowed(o, ['round', 'duration', 'amount', 'phaseStatsOperation', 'distinctTitleBoost']) || !eventSource(cue, o)
            || o.kind !== 'buff' || o.zone !== t.zone || o.seat !== t.seat || !exact(o.card, t.unit) || o.incarnation !== t.unit.incarnation || o.round !== expected.round || o.duration !== 'phase' || o.amount !== `+${amount}/+${amount}` || o.phaseStatsOperation !== 'grant' || !exact(o.distinctTitleBoost, witness)) return;
        const end: UnitRef = { ...t.unit, p: t.unit.p + amount, h: t.unit.h + amount, status: [...(t.unit.status ?? []), { kind: 'buff', label: `${o.amount} · phase`, duration: 'phase', round: expected.round, phase: expected.phase, incarnation: t.unit.incarnation,
            titleBoost: { id: witness!.id, sourceId: key(cue.source), subjectId: key(t.unit), incarnation: t.unit.incarnation!, round: expected.round, phase: expected.phase, amount } }] };
        replace(expected, t, end); changed.push({ item, t, end });
    }
    return ending(cue, expected) ? { changed, amount, count: all.length, expire: false, items: g.outcomes } : undefined;
}
function unityExpiryProof(cue: CardEffectCue, g: Geometry) {
    const d = A15_DEFINITIONS.find(d => d.id === cue.definition.id), tr = cue.transition;
    if (!d || !tr || cue.stage !== 'phase-end' || d.id !== 'unity-of-purpose' || d.name !== cue.definition.name || d.setCode !== cue.definition.setCode || !cue.source?.id || cue.source.n !== d.name || cue.source.s !== d.setCode || cue.source.owner !== cue.seat || cue.playPayment !== undefined || cue.playCost !== undefined || tr.before.phase !== 'action'
        || tr.before.players[cue.seat].discard.filter(c => refEqual(c, cue.source)).length !== 1) return;
    if (!supportedBattlefield(cue)) return;
    const expected = structuredClone(tr.before), all = seats.flatMap(s => units(tr.before, s)).filter(u => u.status?.some(s => s.titleBoost?.sourceId === cue.source!.id)), changed: { item: PlacedOutcome; t: Located; end: UnitRef }[] = [];
    if (g.outcomes.length !== all.length) return;
    let amount = 0;
    for (const item of g.outcomes) {
        const o = item.outcome, t = locate(cue, o.card), w = o.distinctTitleBoost;
        if (!t || !knownBody(t) || !all.some(u => same(u, t.unit)) || changed.some(v => same(v.t.unit, t.unit)) || !allowed(o, ['round', 'duration', 'unit', 'phaseStatsOperation', 'distinctTitleBoost']) || !eventSource(cue, o)
            || o.kind !== 'buff' || o.phaseStatsOperation !== 'expire' || o.seat !== t.seat || o.zone !== t.zone || !exact(o.card, t.unit) || o.incarnation !== t.unit.incarnation || o.round !== expected.round || o.duration !== 'phase' || !w) return;
        const statuses = t.unit.status?.filter(s => s.titleBoost?.sourceId === cue.source!.id) ?? [], status = statuses[0], mark = status?.titleBoost;
        if (statuses.length !== 1 || !mark || mark.sourceId !== cue.source.id || mark.subjectId !== t.unit.id || mark.incarnation !== t.unit.incarnation || mark.round !== expected.round || mark.phase !== expected.phase || !Number.isSafeInteger(mark.amount) || mark.amount < 1
            || !exact(status, { kind: 'buff', label: `+${mark.amount}/+${mark.amount} · phase`, duration: 'phase', round: expected.round, phase: expected.phase, incarnation: t.unit.incarnation, titleBoost: mark })
            || !exact(w, { id: mark.id, sourceId: mark.sourceId, round: mark.round, phase: mark.phase, members: [{ ...entry(t.unit), title: t.unit.printedTitle }], titles: [], amount: mark.amount })) return;
        const end = { ...t.unit, p: Math.max(0, t.unit.p - mark.amount), h: Math.max(0, t.unit.h - mark.amount), status: t.unit.status!.filter(s => s !== status) };
        if (end.d >= end.h || !exact(o.unit, end)) return;
        amount = mark.amount; replace(expected, t, end); changed.push({ item, t, end });
    }
    return ending(cue, expected) ? { changed, amount, count: all.length, expire: true, items: g.outcomes } : undefined;
}
function wingsProof(cue: CardEffectCue, g: Geometry) {
    const expected = paidState(cue); if (!expected || !cue.transition) return;
    const exhausts = g.outcomes.filter(i => i.outcome.kind === 'exhaust'), creates = g.outcomes.filter(i => i.outcome.kind === 'create'), witness = exhausts[0]?.outcome.spaceExhaustion;
    if (exhausts.length > 2 || exhausts.length + creates.length !== g.outcomes.length || g.outcomes.slice(0, exhausts.length).some(i => i.outcome.kind !== 'exhaust')) return;
    if (exhausts.length && (!witness?.id || !exact({ ...witness, members: [] }, { id: witness.id, sourceId: key(cue.source), round: expected.round, phase: expected.phase, members: [] }) || !membersEqual(witness.members, exhausts.map(i => ({ id: key(i.outcome.card), incarnation: i.outcome.incarnation! }))))) return;
    const attempts: { item: PlacedOutcome; t: Located; success: boolean }[] = [];
    for (const item of exhausts) {
        const o = item.outcome, t = locate(cue, o.card);
        if (!t || !knownBody(t) || t.seat !== cue.seat || t.zone !== 'space' || attempts.some(a => same(a.t.unit, t.unit)) || !allowed(o, ['amount', 'spaceExhaustion']) || !refEqual(o.sourceCard, cue.source)
            || !exact(o.card, t.unit) || o.seat !== cue.seat || o.zone !== 'space' || o.incarnation !== t.unit.incarnation || o.amount !== (t.unit.x ? 0 : 1) || !exact(o.spaceExhaustion, witness)) return;
        const success = !t.unit.x && !o.prevented; if (success) replace(expected, t, { ...t.unit, x: 1 }); attempts.push({ item, t, success });
    }
    const succeeded = attempts.filter(a => a.success), linked = new Set<string>(), made = new Set<string>();
    if (creates.length !== succeeded.length) return;
    for (const item of creates) {
        const o = item.outcome, u = o.unit, parent = succeeded.find(a => exact(o.requiresExhaust, entry(a.t.unit)));
        if (!parent || linked.has(key(parent.t.unit)) || !u?.id || !u.incarnation || made.has(u.id) || refs(cue.transition.before).some(c => same(c, u)) || Object.prototype.hasOwnProperty.call(cue.transition.before.mostRecentIncarnations ?? {}, u.id) || !allowed(o, ['unit', 'ownerSeat', 'amount', 'tokenType', 'entryType', 'entersReady', 'spaceExhaustion', 'requiresExhaust']) || !eventSource(cue, o)
            || o.seat !== cue.seat || o.ownerSeat !== cue.seat || o.zone !== 'space' || o.amount !== 1 || o.tokenType !== 'x-wing' || o.entryType !== 'created' || o.entersReady !== false || o.incarnation !== u.incarnation || !exact(o.card, u) || !exact(o.spaceExhaustion, witness)
            || !exact(u, { id: u.id, n: 'X-Wing', s: null, owner: cue.seat, t: 1, p: 2, h: 2, d: 0, x: 1, traits: ['vehicle', 'fighter'], printedTitle: 'X-Wing', unique: false, leaderUnit: false, incarnation: u.incarnation })) return;
        expected.players[cue.seat].space.push(u); linked.add(key(parent.t.unit)); made.add(u.id);
    }
    return ending(cue, expected) ? { attempts, creates, items: g.outcomes } : undefined;
}
function airProof(cue: CardEffectCue, g: Geometry) {
    const expected = paidState(cue); if (!expected || !cue.transition) return;
    const enemy: Seat = cue.seat === 'p1' ? 'p2' : 'p1', own = cue.transition.before.players[cue.seat].space, opposing = cue.transition.before.players[enemy].space;
    if (own.length <= opposing.length) return !g.outcomes.length && ending(cue, expected) ? { own: own.length, other: opposing.length, hit: undefined, dead: undefined, items: g.outcomes } : undefined;
    if (g.outcomes.length < 1 || g.outcomes.length > 2 || [...own, ...opposing].some(u => !u.id || !u.incarnation)) return;
    const item = g.outcomes[0], o = item.outcome, t = locate(cue, o.card), w = o.spaceCensus;
    if (!t || !knownBody(t) || t.seat !== enemy || t.zone !== 'ground' || t.unit.u?.length || t.unit.cap?.length || !allowed(o, ['amount', 'damageType', 'spaceCensus']) || !eventSource(cue, o)
        || o.kind !== 'damage' || !exact(o.card, t.unit) || o.seat !== t.seat || o.zone !== t.zone || o.incarnation !== t.unit.incarnation || o.amount !== 4 || o.damageType !== 'ability'
        || !exact(w, { sourceId: key(cue.source), round: expected.round, phase: expected.phase, player: cue.seat, opponent: enemy, own: own.map(entry), other: opposing.map(entry) })) return;
    const end = { ...t.unit, d: t.unit.d + 4 }, dead = g.outcomes[1]; replace(expected, t, end);
    if (end.d >= end.h) {
        if (!dead || !exact(dead.outcome.spaceCensus, w)) return;
        const fallen = departure(cue, dead, ['spaceCensus']); if (!fallen || !same(fallen.unit, t.unit)) return;
        removeUnit(expected, t);
    } else if (dead) return;
    return ending(cue, expected) ? { own: own.length, other: opposing.length, hit: { item, t, end }, dead, items: g.outcomes } : undefined;
}
function proof(cue: CardEffectCue, g: Geometry) {
    switch (cue.definition.id) {
        case 'nebula-ignition': return nebulaProof(cue, g);
        case 'apology-accepted': return apologyProof(cue, g);
        case 'unity-of-purpose': return cue.stage ? unityExpiryProof(cue, g) : unityProof(cue, g);
        case 'all-wings-report-in': return wingsProof(cue, g);
        case 'air-superiority': return airProof(cue, g);
    }
}
export const batchA15SecondaryCovers = (cue: CardEffectCue, g: Geometry, item: PlacedOutcome) => proof(cue, g)?.items.includes(item) ?? false;

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
function LocalCounters({ u, box }: { u: UnitRef; box: { w: number; h: number } }) {
    return <>{[0, 1].map(n => <g key={n} transform={`translate(${(n ? 1 : -1) * (box.w / 2 - 10)} ${box.h / 2 - 12})`}><rect x="-10" y="-11" width="20" height="22" rx="3" fill={n ? '#174772' : '#8b2936'} stroke="#d5e2f5" /><text y="4" textAnchor="middle" fill="#fff" stroke="none" style={{ font: '800 13px sans-serif' }}>{n ? Math.max(0, u.h - u.d) : u.p}</text></g>)}</>;
}
function Badge({ at, text, p, start, color = '#c5d8e3' }: { at: EffectBox; text: string; p: number; start: number; color?: string }) {
    const s = size(at); return <ScreenPixels at={shift(at, 0, -s.h / 2 + 11)} color={color} opacity={visible(p, start)}><rect x={-s.w / 2 + 2} y="-8" width={s.w - 4} height="16" rx="2" fill="#101c2b" /><text y="2" textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '800 6px sans-serif' }}>{text}</text></ScreenPixels>;
}
function Depart({ geometry: g, p, item, t, start = .4, end = .72 }: Props & { item: PlacedOutcome; t: Located; start?: number; end?: number }) {
    const at = g.cards?.[t.seat + ':' + key(t.unit)] ?? item.from;
    return <><Mask at={at} p={p} start={start} />{t.unit.t ? <ScreenPixels at={at} color="#dcb898" opacity={envelope(p, start, start + .045, end)}><path d="M-13 -13 L13 13 M13 -13 L-13 13" strokeWidth="3" /><circle r={6 + 18 * phase(p, start, end)} fill="none" strokeDasharray="3 4" /></ScreenPixels> : <CompactRoute from={at} to={g.zones[t.unit.owner + ':discard'] ?? item.to} card={t.unit} p={p} start={start} end={end} />}</>;
}
function Nebula(props: Props) {
    const { cue, geometry: g, p } = props, r = nebulaProof(cue, g); if (!r) return null;
    return <><Payment {...props} /><Receipt at={center(g)} rows={['BOTH ARENAS · BOTH PLAYERS', `${r.dead.length} UNUPGRADED UNITS EXPOSED`]} p={p} start={.06} until={.34} color="#a5c6db" />{r.protectedUnits.map(u => {
        const t = locate(cue, u), at = t && g.cards?.[t.seat + ':' + key(u)]; if (!at) return null; const s = size(at);
        return <g key={key(u)}><ScreenPixels at={at} color="#bbd4b5" opacity={envelope(p, .24, .29, .8)}><rect x={-s.w / 2 - 2} y={-s.h / 2 - 2} width={s.w + 4} height={s.h + 4} rx="6" fill="none" strokeWidth="2" /></ScreenPixels></g>;
    })}{r.dead.map(({ item, t }, i) => { const at = g.cards?.[t.seat + ':' + key(t.unit)] ?? item.from, s = size(at); return <g key={item.key}><ScreenPixels at={at} color="#9cbfd6" opacity={envelope(p, .2, .3, .49)}>{[0, 1, 2].map(n => <ellipse key={n} rx={s.w * (.4 + phase(p, .23 + n * .02, .43) * .15)} ry={s.h * (.12 + phase(p, .23 + n * .02, .43) * .28)} fill="none" strokeWidth="2" opacity={.8 - n * .15} />)}</ScreenPixels><Depart {...props} item={item} t={t} start={.38 + i * .025} end={.69 + i * .025} /></g>; })}<Receipt at={center(g)} rows={[`${r.dead.length} UNUPGRADED UNITS DEFEATED`, `${r.protectedUnits.length} UPGRADED UNITS REMAIN`]} p={p} start={.86} color="#a5c6db" /></>;
}
function Apology(props: Props) {
    const { cue, geometry: g, p } = props, r = apologyProof(cue, g); if (!r) return null;
    const from = g.cards?.[r.t.seat + ':' + key(r.t.unit)] ?? r.item.from;
    return <><Payment {...props} /><Receipt at={center(g)} rows={['YOUR UNIT SELECTED', 'THEN · OPTIONAL TWO EXPERIENCE']} p={p} start={.06} until={.29} color="#d8b9b0" /><Badge at={from} text={r.prevented ? 'DEFEAT PREVENTED' : 'SELECTED TO DEFEAT'} p={p} start={.2} color="#d5b4af" />{!r.prevented && <Depart {...props} {...r} start={.27} end={.53} />}{r.xp && (() => {
        const xp = r.xp, at = g.cards?.[xp.t.seat + ':' + key(xp.t.unit)] ?? xp.item.box;
        return <>{xp.upgrades.map((u, i) => { const to = shift(at, 0, -size(at).h / 2 + 28 + i * 16), t = easeInOut(phase(p, .58 + i * .05, .75 + i * .05)); return <ScreenPixels key={key(u)} at={shift(to, 0, 18 * (1 - t))} color="#d9e3bb" opacity={visible(p, .58 + i * .05)}><rect x="-16" y="-7" width="32" height="14" rx="3" fill="#263c28" /><text y="3" textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '800 7px sans-serif' }}>XP +1</text></ScreenPixels>; })}<Counters at={at} u={xp.end} p={p} start={.81} /></>;
    })()}<Receipt at={center(g)} rows={r.xp ? ['TWO EXPERIENCE · +2/+2', 'PERMANENT TOKENS · WOUNDS KEPT'] : [r.prevented ? 'DEFEAT PREVENTED' : 'OWN UNIT DEFEATED', 'NO EXPERIENCE GIVEN']} p={p} start={.88} color="#d8b9b0" /></>;
}
function Unity(props: Props) {
    const { cue, geometry: g, p } = props, r = cue.stage ? unityExpiryProof(cue, g) : unityProof(cue, g); if (!r) return null;
    return <><Payment {...props} /><Receipt at={center(g)} rows={r.expire ? ['ACTION PHASE ENDS', 'REMOVE ONLY THIS FIXED TITLE BONUS'] : [`${r.count} UNITS · ${r.amount} DISTINCT TITLES`, 'SAME TITLE COUNTS ONCE']} p={p} start={.06} until={.35} color="#b8d4c2" />{r.changed.map(({ item, t, end }, i) => { const at = g.cards?.[t.seat + ':' + key(t.unit)] ?? item.box, s = size(at); return <g key={item.key}><ScreenPixels at={at} color="#b9d4c1" opacity={envelope(p, .24, .3, .58)}><path d={`M${-s.w / 2 - 3} ${-s.h / 2 + 7} V${-s.h / 2 - 3} H${s.w / 2 + 3} V${-s.h / 2 + 7}`} fill="none" strokeWidth="2" /><circle cy="-8" r={10 + 12 * phase(p, .28, .5)} fill="none" strokeDasharray="4 4" /></ScreenPixels><Badge at={at} text={r.expire ? 'TITLE BONUS ENDS' : `+${r.amount}/+${r.amount} · PHASE`} p={p} start={.48 + i * .025} />{r.expire && (() => { const mark = t.unit.status!.find(status => status.titleBoost?.sourceId === cue.source!.id)!.titleBoost!, status = at.statusBoxes?.[mark.id]; if (!status) return null; return <ScreenPixels at={{ ...at, ...status }} opacity={visible(p, .54 + i * .025)}><rect x={-status.w * (at.sx ?? 1) / 2} y={-status.h * (at.sy ?? 1) / 2} width={status.w * (at.sx ?? 1)} height={status.h * (at.sy ?? 1)} fill="#0b1420" stroke="none" /></ScreenPixels>; })()}<Counters at={at} u={end} p={p} start={.54 + i * .025} /></g>; })}<Receipt at={center(g)} rows={r.expire ? ['TITLE GRANT EXPIRED', 'POSES AND WOUNDS UNCHANGED'] : [`EVERY CURRENT UNIT +${r.amount}/+${r.amount}`, 'FIXED THIS PHASE · NO EXPERIENCE']} p={p} start={.84} color="#b8d4c2" /></>;
}
function Wings(props: Props) {
    const { cue, geometry: g, p } = props, r = wingsProof(cue, g); if (!r) return null;
    return <><Payment {...props} /><Receipt at={center(g)} rows={[`${r.attempts.length} FRIENDLY SPACE UNITS SELECTED`, 'ONE X-WING PER SUCCESSFUL EXHAUSTION']} p={p} start={.06} until={.34} color="#a4c9df" />{r.attempts.map(({ item, t, success }, i) => {
        const at = g.cards?.[t.seat + ':' + key(t.unit)] ?? item.box, s = size(at), turn = phase(p, .27 + i * .04, .48 + i * .04);
        return <g key={item.key}>{success && <><Mask at={at} p={p} start={.27 + i * .04} /><ScreenPixels at={at} opacity={visible(p, .27 + i * .04)}><g transform={`rotate(${10 * turn})`}><CardGhost card={t.unit} box={s} /><LocalCounters u={t.unit} box={s} /></g></ScreenPixels></>}<Badge at={at} text={success ? 'EXHAUSTED · +1 X-WING' : 'NO EXHAUSTION · NO TOKEN'} p={p} start={.48 + i * .04} /></g>;
    })}{r.creates.map((item, i) => { const u = item.outcome.unit!, at = g.endingCards?.[cue.seat + ':' + key(u)] ?? item.to, s = size(at), start = .56 + i * .05, t = easeInOut(phase(p, start, .8 + i * .03)); return <ScreenPixels key={item.key} at={at} color="#bfd6e6" opacity={visible(p, start)}><g transform={`translate(0 ${s.h * .12 * (1 - t)}) rotate(${10 * t})`}><CardGhost card={u} box={s} /><rect x={-s.w / 2 + 2} y={-s.h / 2 + 2} width={s.w - 4} height="20" rx="2" fill="#15283b" /><text y={-s.h / 2 + 10} textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '800 6px sans-serif' }}>X-WING</text><text y={-s.h / 2 + 18} textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '700 6px sans-serif' }}>2/2 · EXHAUSTED</text><LocalCounters u={u} box={s} /></g></ScreenPixels>; })}<Receipt at={center(g)} rows={[`${r.creates.length} SUCCESSFUL EXHAUSTIONS`, `${r.creates.length} FRESH EXHAUSTED 2/2 X-WINGS`]} p={p} start={.89} color="#a4c9df" /></>;
}
function Air(props: Props) {
    const { cue, geometry: g, p } = props, r = airProof(cue, g); if (!r) return null;
    const at = r.hit && (g.cards?.[r.hit.t.seat + ':' + key(r.hit.t.unit)] ?? r.hit.item.box);
    return <><Payment {...props} /><Receipt at={center(g)} rows={[`YOUR SPACE ${r.own} · OPPONENT SPACE ${r.other}`, r.hit ? 'MORE SPACE UNITS · ONE GROUND HIT' : 'CONDITION NOT MET']} p={p} start={.06} until={.37} color="#bcd6c9" />{r.hit && at && <><ScreenPixels at={at} color="#deac86" opacity={envelope(p, .34, .4, .65)}><path d="M-18 -18 L18 18 M18 -18 L-18 18" strokeWidth="2" /><circle r={10 + 23 * phase(p, .35, .6)} fill="none" strokeWidth="2" /><rect x="-13" y="-12" width="26" height="24" rx="4" fill="#46231d" /><text y="5" textAnchor="middle" fill="#fff" stroke="none" style={{ font: '800 17px sans-serif' }}>4</text></ScreenPixels><Counters at={at} u={r.hit.end} p={p} start={.48} />{r.dead && <Depart {...props} item={r.dead} t={r.hit.t} start={.63} end={.83} />}</>}<Receipt at={center(g)} rows={r.hit ? [r.dead ? 'FOUR DAMAGE · GROUND TARGET DEFEATED' : 'FOUR DAMAGE · GROUND TARGET SURVIVES', 'SPACE UNITS AND BASES UNCHANGED'] : ['NO GROUND DAMAGE', 'PAID EVENT RESOLVED']} p={p} start={.88} color="#bcd6c9" /></>;
}
export function BatchA15SecondarySignature(props: Props) {
    switch (props.cue.definition.id) {
        case 'nebula-ignition': return <Nebula {...props} />;
        case 'apology-accepted': return <Apology {...props} />;
        case 'unity-of-purpose': return <Unity {...props} />;
        case 'all-wings-report-in': return <Wings {...props} />;
        case 'air-superiority': return <Air {...props} />;
        default: return null;
    }
}
