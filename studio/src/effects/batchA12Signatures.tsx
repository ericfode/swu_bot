import type { CardRef, PendingEffect, PhaseDiscardPlayPermission, Seat, Snapshot, UnitRef } from '../data/types';
import type { CardEffectCue, CardEffectOutcome } from './types';
import { A12_DEFINITIONS } from './batchA12';
import { previewGivenCost, previewPlayCost, type PreviewAspect } from './previewCosts';
import { easeInOut, envelope, phase } from './animationTimeline';
import { AttachmentMask, CardGhost, ResourceBalance, ResourceSlot, ScreenPixels, UpgradePlay, mix, screenShift as shift, type EffectBox, type PlacedOutcome } from './primitives';

type Geometry = { source: EffectBox; target: EffectBox; friendlyBase: EffectBox; outcomes: PlacedOutcome[]; zones: Record<string, EffectBox>; cards?: Record<string, EffectBox>; endingCards?: Record<string, EffectBox>; resourceCards?: Record<string, EffectBox>; endingResources?: Record<string, EffectBox> };
type Props = { cue: CardEffectCue; geometry: Geometry; p: number };
const ids = new Set(['guerilla-insurgency', 'planetary-invasion', 'unnatural-life', 'aid-from-the-innocent', 'impropriety-among-thieves']);
export const isBatchA12 = (cue: CardEffectCue) => ids.has(cue.definition.id);
const seats: Seat[] = ['p1', 'p2'];
const key = (c?: CardRef | null) => c?.id ?? '';
const same = (a?: CardRef | null, b?: CardRef | null) => !!a?.id && a.id === b?.id;
const refEqual = (a?: CardRef | null, b?: CardRef | null) => same(a, b) && a?.n === b?.n && a?.s === b?.s && a?.owner === b?.owner;
const equal = (a: unknown, b: unknown): boolean => {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => equal(v, b[i]));
    const x = a as Record<string, unknown>, y = b as Record<string, unknown>, keys = Object.keys(x);
    return keys.length === Object.keys(y).length && keys.every(k => Object.prototype.hasOwnProperty.call(y, k) && equal(x[k], y[k]));
};
const ordered = (a: CardRef[], b: CardRef[]) => a.length === b.length && a.every((c, i) => refEqual(c, b[i]));
const units = (s: Snapshot, seat: Seat) => [...s.players[seat].ground, ...s.players[seat].space];
const refs = (s: Snapshot) => seats.flatMap(seat => { const p = s.players[seat]; return [p.base, ...(p.leader ? [p.leader] : []), ...p.hand, ...p.discard, ...(p.resources ?? []), ...(p.knownDeck ?? []), ...units(s, seat), ...units(s, seat).flatMap(u => [...(u.u ?? []), ...(u.cap ?? [])])]; });
const eventSource = (cue: CardEffectCue, o: CardEffectOutcome) => refEqual(cue.source, o.sourceCard);
const allowed = (o: CardEffectOutcome, extra: string[]) => Object.keys(o).every(k => ['kind', 'card', 'seat', 'zone', 'sourceCard', 'incarnation', 'prevented', 'label', ...extra].includes(k));
function locate(cue: CardEffectCue, c?: CardRef | null) {
    if (!c?.id || !cue.transition) return;
    const found = seats.flatMap(seat => (['ground', 'space'] as const).flatMap(zone => cue.transition!.before.players[seat][zone].filter(u => same(u, c)).map(unit => ({ unit, seat, zone }))));
    return found.length === 1 && found[0].unit.incarnation && found[0].unit.d < found[0].unit.h ? found[0] : undefined;
}
type Located = NonNullable<ReturnType<typeof locate>>;
type Death = { item: PlacedOutcome; target: Located };
/** The independent cost check is shared by rich rendering and generic suppression. */
function sourceProof(cue: CardEffectCue, stage?: 'regroup-start' | 'next-action') {
    const d = A12_DEFINITIONS.find(d => d.id === cue.definition.id), t = cue.transition;
    if (!d || !t || cue.stage !== stage || cue.definition.name !== d.name || cue.definition.setCode !== d.setCode || !cue.source?.id || cue.source.n !== d.name || cue.source.s !== d.setCode || cue.source.owner !== cue.seat
        || t.before.round !== t.after.round || t.before.phase !== t.after.phase || t.before.initiative !== t.after.initiative) return;
    const beforeSource = t.before.players[cue.seat][stage ? 'discard' : 'hand'];
    if (beforeSource.filter(c => refEqual(c, cue.source)).length !== 1 || t.after.players[cue.seat].discard.filter(c => refEqual(c, cue.source)).length !== 1
        || refs(t.before).filter(c => same(c, cue.source)).length !== 1 || refs(t.after).filter(c => same(c, cue.source)).length !== 1) return;
    if (stage) return cue.playCost === undefined && cue.playPayment === undefined && t.before.phase === (stage === 'regroup-start' ? 'regroup' : 'action') ? { cost: 0, paid: [] as string[] } : undefined;
    if (t.before.phase !== 'action' || cue.playPayment?.kind !== 'resources' || cue.playPayment.smuggle || cue.definition.id !== 'planetary-invasion' && cue.playPayment.exploit) return;
    let cost: number; try { cost = previewPlayCost(d, t.before, cue.seat, cue.playPayment); } catch { return; }
    const paid = cue.playPayment.cardIds;
    if (!paid || cue.playCost !== cost || paid.length !== cost || new Set(paid).size !== cost || !seats.every(seat => {
        const p = t.before.players[seat]; return !!p.resources && p.resources.length === p.res.total && p.resources.filter(r => !r.x).length === p.res.ready;
    }) || !paid.every(id => t.before.players[cue.seat].resources!.some(r => r.id === id && !r.x))) return;
    return { cost, paid };
}
function charge(s: Snapshot, seat: Seat, cards: CardRef[]) {
    const p = s.players[seat], ids = cards.map(key);
    if (new Set(ids).size !== ids.length || !p.resources || cards.some(c => !p.resources!.some(r => refEqual(r, c) && !r.x))) return false;
    p.resources = p.resources.map(r => ids.includes(key(r)) ? { ...r, x: 1 } : r); p.res.ready -= ids.length;
    return true;
}
function paidState(cue: CardEffectCue, deferSource = false) {
    const proof = sourceProof(cue); if (!proof || !cue.transition) return;
    const expected = structuredClone(cue.transition.before), p = expected.players[cue.seat];
    if (!charge(expected, cue.seat, proof.paid.map(id => p.resources!.find(r => r.id === id)!))) return;
    p.hand = p.hand.filter(c => !same(c, cue.source)); if (!deferSource) p.discard.push(cue.source!);
    return expected;
}
/** Minimal discard references may omit arena stats; other ending truth stays exact. */
function endingProof(cue: CardEffectCue, expected: Snapshot) {
    const after = cue.transition?.after; if (!after) return false;
    for (const seat of seats) {
        const a = expected.players[seat], b = after.players[seat];
        if (!ordered(a.hand, b.hand) || !ordered(a.discard, b.discard) || !ordered(a.knownDeck ?? [], b.knownDeck ?? [])) return false;
        a.hand = b.hand; a.discard = b.discard; a.knownDeck = b.knownDeck;
    }
    return equal(expected, after);
}
function deathProof(cue: CardEffectCue, item: PlacedOutcome | undefined, t: Located, extras: string[] = []) {
    const o = item?.outcome, u = t.unit, owner = u.owner, summary = owner && cue.transition!.before.players[owner].leader, leader = summary?.dep === 1 && same(summary, u);
    return !!o && allowed(o, ['ownerSeat', 'leader', ...extras]) && o.kind === 'defeat' && !o.prevented && eventSource(cue, o) && o.seat === t.seat && o.zone === t.zone && o.incarnation === u.incarnation && equal(o.card, u)
        && !!owner && o.ownerSeat === owner && !u.cap?.length && (u.u ?? []).every(up => !!up.owner) && (leader ? equal(o.leader, { ...summary, dep: 0, x: 1 }) : !o.leader);
}
function kill(s: Snapshot, t: Located, o: CardEffectOutcome) {
    const u = t.unit, owner = u.owner!;
    s.players[t.seat][t.zone] = s.players[t.seat][t.zone].filter(c => !same(c, u));
    for (const up of u.u ?? []) if (!up.t) s.players[up.owner!].discard.push(up);
    if (o.leader) s.players[owner].leader = o.leader; else if (!u.t) s.players[owner].discard.push(u);
    if (s.pending) s.pending = s.pending.filter(p => p.targetId !== u.id);
}
function replace(s: Snapshot, t: Located, next: UnitRef) { s.players[t.seat][t.zone] = s.players[t.seat][t.zone].map(u => same(u, t.unit) ? next : u); }
const phaseStatus = (u: UnitRef, label: string, kind: 'buff' | 'keyword', extra = {}) => ({ ...u, status: [...(u.status ?? []), { kind, label, duration: 'phase' as const, ...extra }] });
const clearRegroup = (u: UnitRef) => { const next = structuredClone(u); next.status = next.status?.filter(s => !(['control', 'delay'].includes(s.kind) && s.duration === 'regroup')); if (!next.status?.length) delete next.status; return next; };
type FaceFact = { name: string; title: string; printed: number; aspects: PreviewAspect[]; type: 'unit' | 'event' | 'upgrade'; p?: number; h?: number; traits?: string[]; arena?: 'ground' | 'space'; overwhelm?: boolean; sentinel?: boolean };
/** These limited face facts are verified against installed JSON; unsupported prints keep generic movement. */
const facts: Record<string, FaceFact> = {
    SOR_095: { name: 'Battlefield Marine', title: 'Battlefield Marine', printed: 2, aspects: ['command', 'heroism'], type: 'unit', p: 3, h: 3, traits: ['rebel', 'trooper'], arena: 'ground' },
    SOR_098: { name: 'Echo Base Defender', title: 'Echo Base Defender', printed: 3, aspects: ['command', 'heroism'], type: 'unit', p: 4, h: 3, traits: ['rebel', 'trooper'], arena: 'ground', sentinel: true },
    SOR_237: { name: 'Alliance X-Wing', title: 'Alliance X-Wing', printed: 2, aspects: ['heroism'], type: 'unit', p: 2, h: 3, traits: ['rebel', 'vehicle', 'fighter'], arena: 'space' },
    SOR_033: { name: 'Death Trooper', title: 'Death Trooper', printed: 3, aspects: ['villainy', 'vigilance'], type: 'unit', p: 3, h: 3, traits: ['imperial', 'trooper'], arena: 'ground' },
    SOR_164: { name: 'Wampa', title: 'Wampa', printed: 4, aspects: ['aggression'], type: 'unit', p: 4, h: 5, traits: ['creature'], arena: 'ground', overwhelm: true },
    SOR_225: { name: 'TIE/ln Fighter', title: 'TIE/ln Fighter', printed: 1, aspects: ['villainy'], type: 'unit', p: 2, h: 1, traits: ['imperial', 'vehicle', 'fighter'], arena: 'space' },
    SOR_054: { name: 'Jedi Lightsaber', title: 'Jedi Lightsaber', printed: 3, aspects: ['heroism', 'vigilance'], type: 'upgrade', p: 3, h: 3 },
    TWI_251: { name: 'Drop In', title: 'Drop In', printed: 4, aspects: ['heroism'], type: 'event' },
    SOR_077: { name: 'Takedown', title: 'Takedown', printed: 4, aspects: ['vigilance'], type: 'event' },
    SOR_074: { name: 'Repair', title: 'Repair', printed: 1, aspects: ['vigilance'], type: 'event' },
    SOR_251: { name: 'Confiscate', title: 'Confiscate', printed: 1, aspects: [], type: 'event' },
    SOR_103: { name: 'Rebel Assault', title: 'Rebel Assault', printed: 1, aspects: ['heroism', 'command'], type: 'event' },
    TWI_052: { name: 'Hello There', title: 'Hello There', printed: 3, aspects: ['vigilance', 'heroism'], type: 'event' }
};
const face = (c?: CardRef | null) => c?.s && facts[c.s]?.name === c.n ? facts[c.s] : undefined;

function guerillaProof(cue: CardEffectCue, g: Geometry) {
    const expected = paidState(cue); if (!expected || !cue.transition) return;
    const b = cue.transition.before, group = g.outcomes[0]?.outcome.resolutionGroup;
    if (!group?.id || group.mode !== 'simultaneous' || g.outcomes.some(i => !equal(i.outcome.resolutionGroup, group) || !eventSource(cue, i.outcome) || i.outcome.prevented)) return;
    const losses: { item: PlacedOutcome; resource: boolean; ready: boolean }[] = [], hits: { item: PlacedOutcome; target: Located }[] = [], deaths: Death[] = [];
    let index = 0;
    for (const seat of [cue.seat, cue.seat === 'p1' ? 'p2' : 'p1'] as Seat[]) {
        const p = b.players[seat], ep = expected.players[seat];
        if (p.res.total) {
            const item = g.outcomes[index++], o = item?.outcome, r = p.resources?.find(r => same(r, o?.card)), current = ep.resources?.find(r => same(r, o?.card));
            if (!o || !r || !current || !allowed(o, ['fromSeat', 'fromZone', 'ownerSeat', 'chooserSeat', 'selection', 'resolutionGroup']) || o.kind !== 'defeat' || o.seat !== seat || o.fromSeat !== seat || o.fromZone !== 'resources' || o.zone !== 'discard' || o.ownerSeat !== r.owner || !r.owner || o.chooserSeat !== seat || o.selection !== 'chosen' || !equal(o.card, r) || o.incarnation) return;
            losses.push({ item, resource: true, ready: !current.x }); ep.resources = ep.resources!.filter(c => !same(c, r)); ep.res.total--; if (!current.x) ep.res.ready--; expected.players[r.owner].discard.push(r);
        }
        const available = p.hand.filter(c => !same(c, cue.source)), chosen: CardRef[] = [];
        for (let n = 0; n < Math.min(2, available.length); n++) {
            const item = g.outcomes[index++], o = item?.outcome, c = available.find(c => refEqual(c, o?.card));
            if (!o || !c || chosen.some(a => same(a, c)) || !allowed(o, ['fromSeat', 'fromZone', 'ownerSeat', 'chooserSeat', 'selection', 'resolutionGroup']) || o.kind !== 'discard' || o.seat !== seat || o.fromSeat !== seat || o.fromZone !== 'hand' || o.zone !== 'discard' || c.owner !== seat || o.ownerSeat !== seat || o.chooserSeat !== seat || o.selection !== 'chosen') return;
            chosen.push(c); ep.hand = ep.hand.filter(a => !same(a, c)); ep.discard.push(c); losses.push({ item, resource: false, ready: false });
        }
    }
    const targets = ([cue.seat, cue.seat === 'p1' ? 'p2' : 'p1'] as Seat[]).flatMap(seat => b.players[seat].ground.map(unit => ({ unit, seat, zone: 'ground' as const })));
    for (const t of targets) {
        const item = g.outcomes[index++], o = item?.outcome;
        if (!o || !t.unit.incarnation || !allowed(o, ['amount', 'damageType', 'resolutionGroup']) || o.kind !== 'damage' || o.seat !== t.seat || o.zone !== 'ground' || o.incarnation !== t.unit.incarnation || !equal(o.card, t.unit) || o.amount !== 4 || o.damageType !== 'ability' || t.unit.u?.some(u => u.t && u.n === 'Shield') || t.unit.status?.some(s => s.keyword?.name === 'Grit')) return;
        replace(expected, t, { ...t.unit, d: t.unit.d + 4 }); hits.push({ item, target: t });
    }
    for (const t of targets) if (t.unit.d + 4 >= t.unit.h) {
        const item = g.outcomes[index++]; if (!deathProof(cue, item, t, ['resolutionGroup'])) return;
        kill(expected, t, item.outcome); deaths.push({ item, target: t });
    }
    if (index !== g.outcomes.length || !endingProof(cue, expected)) return;
    return { losses, hits, deaths, items: g.outcomes };
}
function planetaryProof(cue: CardEffectCue, g: Geometry) {
    const expected = paidState(cue, true), payment = cue.playPayment?.kind === 'resources' ? cue.playPayment.exploit : undefined;
    if (!expected || !cue.transition || !payment || payment.sourceId !== cue.source?.id || payment.units.length > 3 || new Set(payment.units.map(u => u.id)).size !== payment.units.length) return;
    const deaths: Death[] = [], targets: { t: Located; ready: PlacedOutcome; buff: PlacedOutcome; keyword: PlacedOutcome; end: UnitRef }[] = [];
    for (let i = 0; i < payment.units.length; i++) {
        const witness = payment.units[i], item = g.outcomes[i], t = locate(cue, item?.outcome.card);
        if (!t || t.seat !== cue.seat || witness.id !== t.unit.id || witness.incarnation !== t.unit.incarnation || !deathProof(cue, item, t, ['paymentRole']) || item.outcome.paymentRole !== 'exploit') return;
        kill(expected, t, item.outcome); deaths.push({ item, target: t });
    }
    expected.players[cue.seat].discard.push(cue.source!);
    const cost = g.outcomes[payment.units.length], o = cost?.outcome;
    if (!o || !allowed(o, ['amount']) || o.kind !== 'cost' || o.prevented || o.seat !== cue.seat || o.zone !== undefined || !refEqual(o.card, cue.source) || !eventSource(cue, o) || o.amount !== -2 * payment.units.length) return;
    const grants = g.outcomes.slice(payment.units.length + 1);
    if (grants.length % 3 || grants.length > 9) return;
    for (let i = 0; i < grants.length; i += 3) {
        const ready = grants[i], buff = grants[i + 1], keyword = grants[i + 2], t = locate(cue, ready.outcome.card);
        if (!t || deaths.some(d => same(d.target.unit, t.unit)) || targets.some(v => same(v.t.unit, t.unit))) return;
        const r = ready.outcome, b = buff.outcome, k = keyword.outcome;
        if (![r, b, k].every(o => !o.prevented && eventSource(cue, o) && o.seat === t.seat && o.zone === t.zone && o.incarnation === t.unit.incarnation && equal(o.card, t.unit))
            || !allowed(r, []) || r.kind !== 'ready' || !allowed(b, ['amount', 'duration']) || b.kind !== 'buff' || b.amount !== '+1/+0' || b.duration !== 'phase' || !b.label?.includes('PHASE')
            || !allowed(k, ['keyword', 'duration']) || k.kind !== 'keyword' || k.duration !== 'phase' || !equal(k.keyword, { name: 'Overwhelm', amount: 1 })) return;
        let end = { ...t.unit, p: t.unit.p + 1 }; delete end.x;
        end = phaseStatus(end, '+1/+0 · phase', 'buff');
        end = phaseStatus(end, 'Overwhelm · phase', 'keyword', { keyword: { name: 'Overwhelm', amount: 1 }, round: expected.round, phase: expected.phase, incarnation: end.incarnation });
        replace(expected, t, end); const leader = t.unit.owner && expected.players[t.unit.owner].leader; if (leader?.dep === 1 && same(leader, t.unit)) leader.x = 0;
        targets.push({ t, ready, buff, keyword, end });
    }
    if (!endingProof(cue, expected)) return;
    return { deaths, targets, cost, normalCost: cue.playCost! + payment.units.length * 2, items: g.outcomes };
}
function lifeProof(cue: CardEffectCue, g: Geometry) {
    const expected = paidState(cue); if (!expected || !cue.transition || g.outcomes.length !== 4) return;
    const [cost, pay, play, delay] = g.outcomes, c = cost.outcome, p = pay.outcome, o = play.outcome, l = delay.outcome, selected = cue.transition.before.players[cue.seat].discard.find(a => refEqual(a, c.card)), f = face(selected), u = o.unit;
    const h = cue.transition.before.defeatedThisPhase, old = selected?.id && cue.transition.before.mostRecentIncarnations?.[selected.id], witness = selected && old ? { id: key(selected), incarnation: old } : undefined, phaseWitness = { round: expected.round, phase: expected.phase };
    if (!selected || selected.owner !== cue.seat || refs(cue.transition.before).filter(a => same(a, selected)).length !== 1 || !f || f.type !== 'unit' || !u?.id || !u.incarnation || same(u, cue.source) || !refEqual(u, selected) || u.incarnation === old || refs(cue.transition.before).some(a => !same(a, selected) && same(a, u))
        || !h || h.round !== expected.round || h.phase !== expected.phase || !witness || !h.cards.some(a => a.id === witness.id && a.incarnation === witness.incarnation && ['unit', 'leader-unit'].includes(a.lastKnownType ?? ''))
        || !allowed(c, ['amount', 'defeatedEntry', 'defeatPhase']) || c.kind !== 'cost' || c.prevented || !eventSource(cue, c) || c.seat !== cue.seat || c.zone !== undefined || c.incarnation !== undefined || c.amount !== -2 || !equal(c.defeatedEntry, witness) || !equal(c.defeatPhase, phaseWitness)
        || !allowed(p, ['amount', 'cards']) || p.kind !== 'pay' || p.prevented || p.seat !== cue.seat || p.zone !== 'resources' || !refEqual(p.card, selected) || !refEqual(p.sourceCard, selected)
        || !allowed(o, ['unit', 'ownerSeat', 'entryType', 'entersReady', 'printedCost', 'defeatedEntry', 'defeatPhase', 'fromSeat', 'fromZone']) || o.kind !== 'play' || o.prevented || o.seat !== cue.seat || o.zone !== f.arena || o.fromSeat !== cue.seat || o.fromZone !== 'discard' || !refEqual(o.card, selected) || !eventSource(cue, o) || o.ownerSeat !== cue.seat || o.entryType !== 'played' || o.entersReady !== true || o.printedCost !== f.printed || o.incarnation !== u.incarnation || !equal(o.defeatedEntry, witness) || !equal(o.defeatPhase, phaseWitness)) return;
    const entering: UnitRef = { ...selected, p: f.p!, h: f.h!, d: 0, traits: f.traits!, printedTitle: f.title, unique: false, leaderUnit: false, incarnation: u.incarnation, ...(f.sentinel ? { sn: 1 } : {}),
        ...(f.overwhelm ? { status: [{ kind: 'keyword', label: 'Overwhelm (printed)', duration: 'permanent', keyword: { name: 'Overwhelm', amount: 1 } }] } : {}) };
    let price: number; try { price = previewGivenCost(f, cue.transition.before, cue.seat, 2); } catch { return; }
    if (!equal(u, entering) || p.amount !== price || !p.cards || p.cards.length !== price || !charge(expected, cue.seat, p.cards)) return;
    const pending = l.pending;
    if (!pending?.id || !allowed(l, ['pending']) || l.kind !== 'delay' || l.prevented || l.seat !== cue.seat || !equal(l.card, entering) || !eventSource(cue, l) || !equal(pending, { id: pending.id, sourceId: key(cue.source), targetId: key(u), incarnation: u.incarnation, trigger: 'regroup-start', kind: 'defeat' }) || expected.pending?.some(a => a.id === pending.id)) return;
    const ep = expected.players[cue.seat]; ep.discard = ep.discard.filter(a => !same(a, selected));
    const ending = { ...entering, status: [...(entering.status ?? []), { kind: 'delay' as const, label: 'Defeat at regroup', duration: 'regroup' as const }] };
    ep[f.arena!].push(ending); expected.mostRecentIncarnations![u.id] = u.incarnation; (expected.pending ??= []).push(pending);
    if (!endingProof(cue, expected)) return;
    return { cost, pay, play, delay, selected, entering, ending, pending, price, items: g.outcomes };
}
function permissionProof(cue: CardEffectCue, permission: PhaseDiscardPlayPermission, card: CardRef) {
    const f = face(card), before = cue.transition!.before;
    return !!f && f.type !== 'unit' && f.aspects.includes('heroism') && !!permission.id && equal(permission, { id: permission.id, sourceId: key(cue.source), cardId: key(card), player: cue.seat, round: before.round, phase: before.phase, fromZone: 'discard', discount: 2, cardType: f.type, aspects: f.aspects });
}
function aidProof(cue: CardEffectCue, g: Geometry) {
    const expected = paidState(cue); if (!expected || !cue.transition || !g.outcomes.length) return;
    const search = g.outcomes[0], o = search.outcome, op = o.deckOperation, b = cue.transition.before.players[cue.seat], deck = b.knownDeck;
    if (!allowed(o, ['amount', 'fromSeat', 'fromZone', 'deckOperation']) || o.kind !== 'search' || o.prevented || !eventSource(cue, o) || o.seat !== cue.seat || o.zone !== 'deck' || o.fromSeat !== cue.seat || o.fromZone !== 'deck'
        || !op || !deck || deck.length !== b.deck || !ordered(op.looked, deck.slice(0, 10)) || o.amount !== op.looked.length || op.scope !== 'top' || op.visibility !== 'private' || op.policy !== 'top-search-bottom' || op.selectionLimit !== 2
        || Object.keys(op).some(k => !['scope', 'visibility', 'policy', 'looked', 'selectedIds', 'revealedIds', 'selectionLimit', 'remainingOrder'].includes(k)) || op.selectedIds.length > 2 || new Set(op.selectedIds).size !== op.selectedIds.length || !equal(op.revealedIds, op.selectedIds)
        || op.remainingOrder.length !== deck.length || new Set(op.remainingOrder.map(key)).size !== deck.length || op.remainingOrder.some(c => !deck.some(a => refEqual(a, c))) || new Set(deck.map(key)).size !== deck.length) return;
    const chosen = op.selectedIds.map(id => op.looked.find(c => c.id === id)); if (chosen.some(c => !c || c.owner !== cue.seat || !face(c) || face(c)!.type === 'unit' || !face(c)!.aspects.includes('heroism'))) return;
    const cards = chosen as CardRef[], remaining = op.remainingOrder.filter(c => !op.selectedIds.includes(key(c)));
    if (!ordered(op.remainingOrder.slice(0, cards.length), cards) || !ordered(remaining.slice(0, deck.length - op.looked.length), deck.slice(op.looked.length)) || g.outcomes.length !== 1 + cards.length * 2) return;
    const discards = g.outcomes.slice(1, 1 + cards.length), grants = g.outcomes.slice(1 + cards.length);
    for (let i = 0; i < cards.length; i++) {
        const c = cards[i], d = discards[i].outcome, grant = grants[i].outcome, permission = grant.phasePlayPermission;
        if (!allowed(d, ['fromSeat', 'fromZone', 'ownerSeat', 'chooserSeat', 'selection']) || d.kind !== 'discard' || d.prevented || !eventSource(cue, d) || !refEqual(d.card, c) || d.seat !== cue.seat || d.zone !== 'discard' || d.fromSeat !== cue.seat || d.fromZone !== 'deck' || d.ownerSeat !== cue.seat || d.chooserSeat !== cue.seat || d.selection !== 'chosen'
            || !allowed(grant, ['amount', 'duration', 'fromZone', 'phasePlayPermission']) || grant.kind !== 'cost' || grant.prevented || !eventSource(cue, grant) || !refEqual(grant.card, c) || grant.seat !== cue.seat || grant.zone !== 'discard' || grant.fromZone !== 'discard' || grant.amount !== -2 || grant.duration !== 'phase' || !permission || !permissionProof(cue, permission, c)
            || expected.discardPlayPermissions?.some(p => p.id === permission.id || p.cardId === permission.cardId)) return;
        expected.players[cue.seat].discard.push(c); (expected.discardPlayPermissions ??= []).push(permission);
    }
    expected.players[cue.seat].deck -= cards.length; expected.players[cue.seat].knownDeck = remaining;
    if (!endingProof(cue, expected)) return;
    return { search, op, cards, discards, grants, items: g.outcomes };
}
function aidLaterProof(cue: CardEffectCue, g: Geometry) {
    if (!sourceProof(cue, 'next-action') || !cue.transition || g.outcomes.length !== 3) return;
    const [cost, pay, play] = g.outcomes, c = cost.outcome, p = pay.outcome, o = play.outcome, before = cue.transition.before, expected = structuredClone(before), selected = before.players[cue.seat].discard.find(a => refEqual(a, c.card)), f = face(selected), permission = before.discardPlayPermissions?.find(a => a.id === c.phasePermissionId), host = locate(cue, o.targetCard), hostFace = face(host?.unit), up = o.upgrade;
    if (!selected || !f || f.type !== 'upgrade' || selected.s !== 'SOR_054' || !permission || before.discardPlayPermissions!.filter(a => a.id === permission.id || a.cardId === permission.cardId).length !== 1 || !permissionProof(cue, permission, selected) || !host || host.seat !== cue.seat || !hostFace?.traits || !equal(hostFace.traits, host.unit.traits) || hostFace.traits.includes('vehicle') || !up || selected.owner !== cue.seat
        || !allowed(c, ['amount', 'phasePermissionId']) || c.kind !== 'cost' || c.prevented || c.seat !== cue.seat || !eventSource(cue, c) || c.amount !== -2
        || !allowed(p, ['amount', 'cards', 'phasePermissionId']) || p.kind !== 'pay' || p.prevented || p.seat !== cue.seat || p.zone !== 'resources' || !refEqual(p.card, selected) || !refEqual(p.sourceCard, selected) || p.phasePermissionId !== permission.id
        || !allowed(o, ['playAs', 'fromSeat', 'fromZone', 'ownerSeat', 'controllerSeat', 'targetCard', 'upgrade', 'printedCost', 'phasePermissionId']) || o.kind !== 'play' || o.prevented || o.playAs !== 'upgrade' || !refEqual(o.card, selected) || o.seat !== cue.seat || o.zone !== host.zone || o.fromSeat !== cue.seat || o.fromZone !== 'discard' || !eventSource(cue, o) || o.ownerSeat !== cue.seat || o.controllerSeat !== cue.seat || !equal(o.targetCard, host.unit) || o.printedCost !== f.printed || o.phasePermissionId !== permission.id
        || !equal(up, { ...selected, t: 0, owner: cue.seat, controller: cue.seat, p: 3, h: 3 })) return;
    let price: number; try { price = previewGivenCost(f, before, cue.seat, permission.discount); } catch { return; }
    if (p.amount !== price || !p.cards || p.cards.length !== price || !charge(expected, cue.seat, p.cards)) return;
    const ep = expected.players[cue.seat]; ep.discard = ep.discard.filter(a => !same(a, selected)); expected.discardPlayPermissions = expected.discardPlayPermissions!.filter(a => a.cardId !== selected.id);
    const end = { ...host.unit, p: host.unit.p + 3, h: host.unit.h + 3, u: [...(host.unit.u ?? []), up] }; replace(expected, host, end);
    if (!endingProof(cue, expected)) return;
    return { cost, pay, play, selected, host, end, permission, price, items: g.outcomes };
}
function improprietyProof(cue: CardEffectCue, g: Geometry) {
    const expected = paidState(cue); if (!expected || !cue.transition) return;
    if (!g.outcomes.length) {
        const missingSide = seats.some(seat => !units(cue.transition!.before, seat).some(u => u.leaderUnit === false && !u.x));
        return missingSide && endingProof(cue, expected) ? { moves: [], delays: [], items: g.outcomes } : undefined;
    }
    if (g.outcomes.length !== 4) return;
    const controls = g.outcomes.slice(0, 2), delays = g.outcomes.slice(2), exchange = controls[0].outcome.controlExchange, targets = controls.map(i => locate(cue, i.outcome.card));
    if (!exchange?.id || targets.some(t => !t) || new Set(targets.map(t => key(t!.unit))).size !== 2 || new Set(targets.map(t => t!.seat)).size !== 2 || !equal(exchange.memberIds, targets.map(t => key(t!.unit)))) return;
    const moves: { item: PlacedOutcome; t: Located; to: Seat; end: UnitRef; pending: PendingEffect }[] = [];
    for (let i = 0; i < controls.length; i++) {
        const item = controls[i], o = item.outcome, t = targets[i]!, to: Seat = t.seat === 'p1' ? 'p2' : 'p1', u = structuredClone(t.unit), d = delays[i].outcome, pending = d.pending;
        if (t.unit.x || t.unit.leaderUnit !== false || !t.unit.owner || t.unit.cap?.length || seats.some(seat => same(cue.transition!.before.players[seat].leader, t.unit))) return;
        for (const up of u.u ?? []) if (up.t) { up.owner = to; up.controller = to; }
        (u.status ??= []).push({ kind: 'control', label: 'Controller until regroup', duration: 'regroup' });
        if (!allowed(o, ['unit', 'fromSeat', 'fromZone', 'ownerSeat', 'duration', 'controlExchange']) || o.kind !== 'control' || o.prevented || !eventSource(cue, o) || o.fromSeat !== t.seat || o.fromZone !== t.zone || o.seat !== to || o.zone !== t.zone || o.incarnation !== t.unit.incarnation || o.ownerSeat !== t.unit.owner || !equal(o.card, t.unit) || !equal(o.unit, u) || o.duration !== 'regroup' || !equal(o.controlExchange, exchange)
            || !allowed(d, ['pending']) || d.kind !== 'delay' || d.prevented || !eventSource(cue, d) || d.seat !== to || d.zone !== t.zone || !equal(d.card, t.unit) || !pending?.id || expected.pending?.some(a => a.id === pending.id) || !equal(pending, { id: pending.id, sourceId: key(cue.source), targetId: key(t.unit), incarnation: t.unit.incarnation, trigger: 'regroup-start', kind: 'return-control', returnController: t.unit.owner })) return;
        u.status!.push({ kind: 'delay', label: 'Return at regroup', duration: 'regroup' });
        expected.players[t.seat][t.zone] = expected.players[t.seat][t.zone].filter(a => !same(a, t.unit)); expected.players[to][t.zone].push(u); (expected.pending ??= []).push(pending);
        moves.push({ item, t, to, end: u, pending });
    }
    if (!endingProof(cue, expected)) return;
    return { moves, delays, items: g.outcomes };
}
function regroupProof(cue: CardEffectCue, g: Geometry) {
    if (!sourceProof(cue, 'regroup-start') || !cue.transition) return;
    const before = cue.transition.before, expected = structuredClone(before), pending = before.pending?.filter(p => p.sourceId === cue.source?.id && p.trigger === 'regroup-start'), kind = cue.definition.id === 'unnatural-life' ? 'defeat' : 'return-control';
    if (!pending?.length || new Set(pending.map(p => p.id)).size !== pending.length || before.pending?.some(p => p.trigger === 'regroup-start' && p.sourceId !== cue.source?.id)) return;
    const moves: { item: PlacedOutcome; t: Located; to?: Seat; end?: UnitRef; pending: PendingEffect }[] = [], continuing: Located[] = [];
    for (const p of pending) {
        if (!p.id || !p.targetId || !p.incarnation || p.kind !== kind || !equal(p, { id: p.id, sourceId: key(cue.source), targetId: p.targetId, incarnation: p.incarnation, trigger: 'regroup-start', kind, ...(kind === 'return-control' ? { returnController: p.returnController } : {}) })) return;
        const t = locate(cue, { id: p.targetId, n: '', s: null }); if (!t || t.unit.incarnation !== p.incarnation) continue;
        if (!t.unit.owner || t.unit.leaderUnit !== false || t.unit.cap?.length || t.unit.u?.length || seats.some(seat => same(before.players[seat].leader, t.unit))
            || !t.unit.status?.some(s => s.kind === 'delay' && s.duration === 'regroup') || t.unit.status.some(s => ['Defeat at regroup', 'Return at regroup', 'Controller until regroup'].includes(s.label) && (s.duration !== 'regroup' || !['control', 'delay'].includes(s.kind)))) return;
        const end = clearRegroup(t.unit), actual = g.outcomes.filter(i => same(i.outcome.card, t.unit)); continuing.push(t);
        if (kind === 'return-control' && p.returnController !== t.unit.owner) return;
        if (kind === 'return-control' && p.returnController === t.seat) { if (actual.length) return; replace(expected, t, end); continue; }
        const item = actual[0], o = item?.outcome;
        if (actual.length !== 1 || !o || !allowed(o, ['fromSeat', 'fromZone', 'ownerSeat', 'pending', 'pendingOperation']) || o.prevented || !eventSource(cue, o) || !equal(o.card, end) || o.incarnation !== p.incarnation || !equal(o.pending, p) || o.pendingOperation !== 'consume' || o.ownerSeat !== t.unit.owner) return;
        if (kind === 'defeat') { if (o.kind !== 'defeat' || o.seat !== t.seat || o.zone !== 'discard' || o.fromSeat || o.fromZone) return; expected.players[t.seat][t.zone] = expected.players[t.seat][t.zone].filter(a => !same(a, t.unit)); if (!t.unit.t) expected.players[t.unit.owner].discard.push(t.unit); }
        else { if (o.kind !== 'control' || o.seat !== t.unit.owner || o.fromSeat !== t.seat || o.fromZone !== t.zone || o.zone !== t.zone) return; expected.players[t.seat][t.zone] = expected.players[t.seat][t.zone].filter(a => !same(a, t.unit)); expected.players[t.unit.owner][t.zone].push(end); }
        moves.push({ item, t, to: kind === 'return-control' ? t.unit.owner : undefined, end: kind === 'return-control' ? end : undefined, pending: p });
    }
    expected.pending = expected.pending!.filter(p => p.trigger !== 'regroup-start');
    if (g.outcomes.length !== moves.length || !endingProof(cue, expected)) return;
    return { moves, continuing, pending, kind, items: g.outcomes };
}
function recipe(cue: CardEffectCue, g: Geometry) {
    if (cue.stage === 'regroup-start' && ['unnatural-life', 'impropriety-among-thieves'].includes(cue.definition.id)) return regroupProof(cue, g);
    switch (cue.definition.id) {
        case 'guerilla-insurgency': return guerillaProof(cue, g);
        case 'planetary-invasion': return planetaryProof(cue, g);
        case 'unnatural-life': return lifeProof(cue, g);
        case 'aid-from-the-innocent': return cue.stage === 'next-action' ? aidLaterProof(cue, g) : aidProof(cue, g);
        case 'impropriety-among-thieves': return improprietyProof(cue, g);
    }
}
export const batchA12Covers = (cue: CardEffectCue, g: Geometry, item: PlacedOutcome) => recipe(cue, g)?.items.includes(item) ?? false;

const size = (at: EffectBox) => at.cardSize ?? { w: at.w * (at.sx ?? 1), h: at.h * (at.sy ?? 1) };
const visible = (p: number, start: number) => phase(p, start, start + .035);
const bound = (at: EffectBox, w: number, h: number): EffectBox => ({ ...at, x: Math.max((w / 2 + 8) / (at.sx ?? 1), Math.min(1000 - (w / 2 + 8) / (at.sx ?? 1), at.x)), y: Math.max((h / 2 + 40) / (at.sy ?? 1), Math.min(600 - (h / 2 + 122) / (at.sy ?? 1), at.y)) });
const side = (g: Geometry) => shift({ ...g.friendlyBase, x: 1000 }, 0, 24);
const cardAt = (g: Geometry, t: Located) => g.cards?.[t.seat + ':' + key(t.unit)] ?? g.zones[t.seat + ':' + t.zone];
function Receipt({ at, rows, p, start, until, color = '#b8dad7' }: { at: EffectBox; rows: string[]; p: number; start: number; until?: number; color?: string }) {
    const w = Math.min(320, Math.max(100, ...rows.map(r => r.length * 6 + 24))), h = rows.length * 16 + 8;
    return <ScreenPixels at={bound(at, w, h)} color={color} opacity={visible(p, start) * (until ? 1 - phase(p, until - .05, until) : 1)}><rect x={-w / 2} y={-h / 2} width={w} height={h} rx="4" fill="#09121e" fillOpacity=".98" strokeWidth="1" />{rows.map((r, i) => <text key={i} y={-h / 2 + 14 + i * 16} textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '700 9px sans-serif' }}>{r}</text>)}</ScreenPixels>;
}
function Mask({ at, p, start }: { at: EffectBox; p: number; start: number }) { const s = size(at); return <ScreenPixels at={at} opacity={visible(p, start)}><rect x={-s.w / 2 - 3} y={-s.h / 2 - 3} width={s.w + 6} height={s.h + 6} rx="5" fill="#0b1420" stroke="none" /></ScreenPixels>; }
function Flight({ from, to, card, p, start, end, back = false, arrive = false, token = false }: { from: EffectBox; to: EffectBox; card: CardRef; p: number; start: number; end: number; back?: boolean; arrive?: boolean; token?: boolean }) {
    if (p < start) return null;
    const t = easeInOut(phase(p, start, end)), left = 16 / (from.sx ?? 1), approach = shift(to, 0, arrive ? -24 : 24), route = [from, { ...from, x: left }, { ...approach, x: left }, approach, to], leg = Math.min(3, Math.floor(t * 4)), at = token ? from : { ...to, ...mix(route[leg], route[leg + 1], Math.min(1, t * 4 - leg)) }, grow = arrive ? phase(t, .92, 1) : 0, s = size(to);
    return <ScreenPixels at={at} color="#b8dad7" opacity={visible(p, start) * (arrive ? 1 : 1 - phase(p, end - .025, end + .04))}><g transform={`scale(${token ? 1 - t : 1})`}><CardGhost card={card} back={back} box={{ w: 20 + (s.w - 20) * grow, h: 28 + (s.h - 28) * grow }} /></g></ScreenPixels>;
}
function Payment({ cue, geometry: g, p, start = .04, end = .21, extra, extraStart = .3 }: Props & { start?: number; end?: number; extra?: PlacedOutcome; extraStart?: number }) {
    const proof = sourceProof(cue); if (!proof || !cue.transition || !cue.source) return null;
    const before = cue.transition.before.players[cue.seat], extraPaid = extra?.outcome.cards ?? [], all = [...proof.paid, ...extraPaid.map(key)];
    return <><ResourceBalance at={g.zones[cue.seat + ':resources']} countAt={g.zones[cue.seat + ':resource-count']} ready={before.res.ready - proof.cost} total={before.res.total} p={p} start={start} />{before.resources?.map((r, i) => { const at = g.resourceCards?.[cue.seat + ':' + key(r)]; return at && all.includes(key(r)) ? <ResourceSlot key={key(r)} at={at} index={i} spent p={p} start={proof.paid.includes(key(r)) ? start : extraStart} /> : null; })}<Mask at={g.source} p={p} start={start} /><Flight from={g.source} to={g.zones[cue.seat + ':discard']} card={cue.source} p={p} start={start} end={end} />{extra && <ResourceBalance at={g.zones[cue.seat + ':resources']} countAt={g.zones[cue.seat + ':resource-count']} ready={before.res.ready - all.length} total={before.res.total} p={p} start={extraStart} />}</>;
}
function Stats({ at, unit, p, start }: { at: EffectBox; unit: UnitRef; p: number; start: number }) {
    return <>{(['power', 'hp'] as const).map((name, i) => { const s = size(at), c = at.counters?.[name], place = c ? { ...at, ...c } : shift(at, (i ? 1 : -1) * (s.w / 2 - 10), s.h / 2 - 11); return <ScreenPixels key={name} at={place} opacity={visible(p, start)}><rect x="-10" y="-11" width="20" height="22" rx="3" fill={i ? '#173f6f' : '#8b2936'} stroke="#dcebe8" /><text textAnchor="middle" y="4" fill="#fff" stroke="none" style={{ font: '800 12px sans-serif' }}>{i ? Math.max(0, unit.h - unit.d) : unit.p}</text></ScreenPixels>; })}</>;
}
function UnitFace({ at, unit, label, p, start, opaque = false }: { at: EffectBox; unit: UnitRef; label?: string; p: number; start: number; opaque?: boolean }) {
    const s = size(at);
    return <ScreenPixels at={at} opacity={opaque ? 1 : visible(p, start)} color="#b8dad7"><g transform={`rotate(${unit.x ? 10 : 0}) scale(${unit.x ? .94 : 1})`} opacity={unit.x ? .72 : 1}><CardGhost card={unit} box={s} />{unit.sn && <text x={-s.w / 2 + 4} y={-s.h / 2 + 10} fill="#f6edd9" stroke="none" style={{ font: '700 7px sans-serif' }}>SEN</text>}{label && <><rect x={-s.w / 2 + 1} y={-s.h / 2 + 13} width={s.w - 2} height="18" fill="#101925" /><text y={-s.h / 2 + 25} textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '700 7px sans-serif' }}>{label}</text></>}{[-1, 1].map(i => <g key={i} transform={`translate(${i * (s.w / 2 - 10)} ${s.h / 2 - 11})`}><rect x="-9" y="-10" width="18" height="20" rx="3" fill={i < 0 ? '#8b2936' : '#173f6f'} /><text textAnchor="middle" y="4" fill="#fff" stroke="none" style={{ font: '800 12px sans-serif' }}>{i < 0 ? unit.p : Math.max(0, unit.h - unit.d)}</text></g>)}</g></ScreenPixels>;
}
function Settle({ cue, geometry: g, p }: Props) {
    if (!cue.transition || p < .8) return null;
    return <>{seats.flatMap(seat => units(cue.transition!.after, seat).map(unit => {
        const old = locate(cue, unit), from = old && cardAt(g, old), to = g.endingCards?.[seat + ':' + key(unit)];
        if (!from || !to || old!.seat !== seat || Math.hypot((to.x - from.x) * (from.sx ?? 1), (to.y - from.y) * (from.sy ?? 1)) < 1) return null;
        return <g key={seat + ':' + key(unit)}><Mask at={from} p={p} start={.8} /><UnitFace at={{ ...to, ...mix(from, to, easeInOut(phase(p, .8, .94))) }} unit={unit} p={p} start={.8} opaque label={unit.status?.some(s => s.keyword?.name === 'Overwhelm' && s.duration === 'phase') ? '+1 · OW PHASE' : undefined} /></g>;
    }))}</>;
}
function Departure({ geometry: g, p, death, start, end }: Props & { death: Death; start: number; end: number }) {
    const u = death.target.unit, from = cardAt(g, death.target), owner = u.owner!, to = death.item.outcome.leader ? g.endingCards?.[owner + ':' + key(u)] ?? g.zones[owner + ':leader'] : g.zones[owner + ':discard'];
    return <><Mask at={from} p={p} start={start} /><Flight from={from} to={to} card={u} p={p} start={start} end={end} token={!!u.t} />{(u.u ?? []).map(up => { const at = g.cards?.[death.target.seat + ':' + key(up)] ?? from; return <g key={key(up)}><AttachmentMask at={at} p={p} start={start} /><Flight from={at} to={g.zones[up.owner! + ':discard']} card={up} p={p} start={start} end={end} token={!!up.t} /></g>; })}</>;
}
function Clock({ at, p, start, consuming = false }: { at: EffectBox; p: number; start: number; consuming?: boolean }) {
    const s = size(at), place = shift(at, s.w / 2 - 8, -s.h / 2 + 8), a = visible(p, start);
    return <ScreenPixels at={place} color="#b8dad7" opacity={a * (consuming ? 1 - phase(p, .64, .72) : 1)}><circle r="9" fill="#0c1521" strokeWidth="1.4" /><path d={`M0 -5 V0 L${consuming ? 5 * a : 4} ${consuming ? 1 : 3}`} strokeWidth="1.4" /></ScreenPixels>;
}
function Guerilla(props: Props) {
    const { cue, geometry: g, p } = props, r = guerillaProof(cue, g); if (!r) return null;
    const after = cue.transition!.after;
    return <><Payment {...props} /><Receipt at={side(g)} rows={['EACH PLAYER CHOOSES', 'ONE RESOURCE + TWO HAND CARDS', 'GROUND UNITS · DAMAGE 4']} p={p} start={.07} until={.43} />
        {r.losses.map(({ item, resource }) => { const o = item.outcome, from = resource ? g.resourceCards?.[o.fromSeat! + ':' + key(o.card)] ?? item.from : g.cards?.[o.fromSeat! + ':' + key(o.card)] ?? item.from; return <g key={item.key}>{resource ? <AttachmentMask at={from} p={p} start={.24} /> : <Mask at={from} p={p} start={.24} />}<Flight from={from} to={g.zones[o.ownerSeat! + ':discard']} card={o.card!} p={p} start={.25} end={.43} /></g>; })}
        {seats.map(seat => <g key={seat}>{after.players[seat].resources?.map((resource, index) => { const at = g.resourceCards?.[seat + ':' + key(resource)]; return at ? <ResourceSlot key={key(resource)} at={at} index={index} spent={!!resource.x} p={p} start={.44} /> : null; })}<ResourceBalance at={g.zones[seat + ':resources']} countAt={g.zones[seat + ':resource-count']} ready={after.players[seat].res.ready} total={after.players[seat].res.total} p={p} start={.44} /></g>)}
        {r.hits.map(({ item, target }) => { const at = cardAt(g, target), s = size(at); return <g key={item.key}><ScreenPixels at={at} color="#e8af99" opacity={envelope(p, .36, .42, .6)}><rect x={-s.w / 2} y="-11" width={s.w} height="22" fill="#632f31" fillOpacity=".85" /><text y="5" textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '800 16px sans-serif' }}>4</text></ScreenPixels><Stats at={at} unit={{ ...target.unit, d: target.unit.d + 4 }} p={p} start={.54} /></g>; })}
        {r.deaths.map(death => <Departure key={key(death.target.unit)} {...props} death={death} start={.62} end={.78} />)}<Settle {...props} />
        <Receipt at={side(g)} rows={['BOTH RESOURCE / HAND LOSSES', `GROUND HIT ${r.hits.length} · SPACE UNTOUCHED`, 'SURVIVING WOUNDS REMAIN']} p={p} start={.84} />
    </>;
}
function Planetary(props: Props) {
    const { cue, geometry: g, p } = props, r = planetaryProof(cue, g); if (!r) return null;
    return <>{r.deaths.map(death => <Departure key={key(death.target.unit)} {...props} death={death} start={.05} end={.23} />)}<Payment {...props} start={.25} end={.4} />
        <Receipt at={side(g)} rows={[`EXPLOIT ${r.deaths.length} · COST ${r.normalCost} → ${cue.playCost}`, 'THREE OR FEWER SURVIVING CHOICES', 'EITHER PLAYER / ARENA']} p={p} start={.08} until={.47} />
        {r.targets.map(({ t, end }, i) => { const at = cardAt(g, t); return <g key={key(t.unit)}><Mask at={at} p={p} start={.46 + i * .02} /><UnitFace at={at} unit={p >= .58 ? end : { ...t.unit, x: undefined }} p={p} start={.46 + i * .02} label={p >= .58 ? '+1 · OW PHASE' : 'READY'} /><Stats at={at} unit={end} p={p} start={.58} /></g>; })}<Settle {...props} />
        <Receipt at={side(g)} rows={[`${r.targets.length} CHOSEN · READY`, '+1/+0 AND OVERWHELM · PHASE', 'WOUNDS / HP UNCHANGED']} p={p} start={.84} />
    </>;
}
function Life(props: Props) {
    const { cue, geometry: g, p } = props, r = lifeProof(cue, g); if (!r) return null;
    const to = r.play.to;
    return <><Payment {...props} extra={r.pay} /><Receipt at={side(g)} rows={['ACTUAL UNIT DEFEATED THIS PHASE', `EVENT ${cue.playCost} · UNIT ${r.price}`, 'UNIT COST −2 · ENTERS READY']} p={p} start={.07} until={.45} />
        <Flight from={g.zones[cue.seat + ':discard']} to={to} card={r.entering} p={p} start={.39} end={.68} arrive />{p >= .68 && <UnitFace at={to} unit={r.entering} label="READY · REGROUP" p={p} start={.68} />}<Clock at={to} p={p} start={.7} /><Settle {...props} />
        <Receipt at={side(g)} rows={['DISCARD → FRESH READY ENTRY', 'DEFEAT AT REGROUP', 'PENDING · NOT DEFEATED NOW']} p={p} start={.82} />
    </>;
}
function shelf(g: Geometry, seat: Seat, n: number) {
    const enemy: Seat = seat === 'p1' ? 'p2' : 'p1', scale = g.source.sx ?? 1, sy = g.source.sy ?? 1, bottom = Math.max(...Object.entries(g.cards ?? {}).filter(([id]) => id.startsWith(enemy + ':')).map(([, at]) => at.y + size(at).h / (2 * sy)), g.zones[enemy + ':ground'].y + g.zones[enemy + ':ground'].h / 2), top = g.friendlyBase.y - size(g.friendlyBase).h / (2 * sy), y = (bottom + top) / 2, width = Math.max(12, Math.min(30, (1000 * scale - 32) / Math.max(1, n))), gap = width + 3;
    return Array.from({ length: n }, (_, i) => ({ ...g.source, x: 500 + (i - (n - 1) / 2) * gap / scale, y, cardSize: { w: width, h: width * 1.4 }, w: width / scale, h: width * 1.4 / sy }));
}
function Aid(props: Props) {
    const { cue, geometry: g, p } = props, r = aidProof(cue, g); if (!r) return null;
    const slots = shelf(g, cue.seat, r.op.looked.length);
    return <><Payment {...props} /><Receipt at={side(g)} rows={[`PRIVATE TOP ${r.op.looked.length}`, `${r.cards.length} HEROISM NON-UNIT CHOSEN`, 'OTHERS RANDOM BOTTOM']} p={p} start={.07} until={.45} />
        {r.op.looked.map((card, i) => { const chosen = r.cards.findIndex(c => same(c, card)), start = .43 + chosen * .08; return <g key={key(card)}>{(chosen < 0 && p < .68 || chosen >= 0 && p < start) && <ScreenPixels at={slots[i]} opacity={visible(p, .2)}><CardGhost card={card} back box={size(slots[i])} /></ScreenPixels>}{chosen >= 0 && <Flight from={slots[i]} to={g.zones[cue.seat + ':discard']} card={card} p={p} start={start} end={start + .19} />}</g>; })}
        {r.grants.map((item, i) => <g key={item.key}><ScreenPixels at={g.zones[cue.seat + ':discard-permission:' + i] ?? g.zones[cue.seat + ':discard']} opacity={visible(p, .71 + i * .015)}><CardGhost card={r.cards[i]} box={{ w: 28, h: 40 }} /></ScreenPixels><Receipt at={g.zones[cue.seat + ':discard-permission-label:' + i] ?? side(g)} rows={[r.cards[i].n.toUpperCase(), 'PLAY FROM DISCARD · −2 THIS PHASE']} p={p} start={.71 + i * .015} /></g>)}
        <Receipt at={side(g)} rows={[`DECK −${r.cards.length} · NO DRAW`, `${r.cards.length} PHASE PLAY PERMISSIONS`, 'NO CARD PLAYED YET']} p={p} start={.86} />
    </>;
}
function AidLater(props: Props) {
    const { cue, geometry: g, p } = props, r = aidLaterProof(cue, g); if (!r) return null;
    const before = cue.transition!.before.players[cue.seat], paid = r.pay.outcome.cards!, from = r.play.from, host = cardAt(g, r.host), to = r.play.to, approach = { ...shift(to, 0, -24), cardSize: { w: 20, h: 28 } };
    const permissionIndex = cue.transition!.before.discardPlayPermissions?.filter(p => p.player === cue.seat).findIndex(p => p.id === r.permission.id) ?? 0, label = g.zones[cue.seat + ':discard-permission-label:' + permissionIndex];
    const remaining = cue.transition!.after.discardPlayPermissions?.filter(p => p.player === cue.seat && p.round === cue.transition!.after.round && p.phase === cue.transition!.after.phase) ?? [];
    return <>{paid.map(card => { const i = before.resources!.findIndex(c => same(c, card)), at = g.resourceCards?.[cue.seat + ':' + key(card)]; return at ? <ResourceSlot key={key(card)} at={at} index={i} spent p={p} start={.26} /> : null; })}<ResourceBalance at={g.zones[cue.seat + ':resources']} countAt={g.zones[cue.seat + ':resource-count']} ready={before.res.ready - r.price} total={before.res.total} p={p} start={.26} />
        <Receipt at={side(g)} rows={['LATER ACTION · SELECTED COPY', `JEDI LIGHTSABER 3 −2 · PAY ${r.price}`, 'FROM DISCARD · NOT FREE']} p={p} start={.06} until={.47} /><Mask at={from} p={p} start={.34} /><Flight from={from} to={approach} card={r.selected} p={p} start={.34} end={.57} /><UpgradePlay from={approach} to={to} card={r.selected} p={p} start={.56} end={.67} /><Stats at={host} unit={r.end} p={p} start={.67} />
        <ScreenPixels at={to} opacity={visible(p, .67)} color="#f6c454"><rect x={-size(to).w / 2} y={-size(to).h / 2} width={size(to).w} height={size(to).h} rx="3" fill="currentColor" stroke="none" /><text y={size(to).h > 14 ? -1 : 2} textAnchor="middle" fill="#2a1d00" stroke="none" style={{ font: '600 6px sans-serif' }}>{size(to).h > 14 ? 'Jedi' : 'Jedi Lightsaber'}</text>{size(to).h > 14 && <text y="6" textAnchor="middle" fill="#2a1d00" stroke="none" style={{ font: '600 6px sans-serif' }}>Lightsaber</text>}</ScreenPixels>
        {label && <><Mask at={label} p={p} start={.67} /><Receipt at={label} rows={['JEDI PERMISSION USED']} p={p} start={.67} /></>}
        <Receipt at={side(g)} rows={[`${r.host.unit.n.toUpperCase()} +3/+3`, 'WOUNDS KEPT · JEDI PERMISSION USED', `${remaining.length} OTHER PERMISSION${remaining.length === 1 ? '' : 'S'} REMAIN`]} p={p} start={.77} /><Settle {...props} />
    </>;
}
function Impropriety(props: Props) {
    const { cue, geometry: g, p } = props, r = improprietyProof(cue, g); if (!r) return null;
    return <><Payment {...props} /><Receipt at={side(g)} rows={r.moves.length ? ['TWO READY NON-LEADERS', 'EXCHANGE CONTROLLERS', 'OWNERS REMAIN'] : ['NO COMPLETE PAIR', 'NO CONTROL EXCHANGE']} p={p} start={.07} until={.44} />
        {r.moves.map(({ item, t, to, end }) => <g key={key(t.unit)}><Mask at={cardAt(g, t)} p={p} start={.29} /><Flight from={cardAt(g, t)} to={item.to} card={end} p={p} start={.3} end={.68} arrive />{p >= .68 && <UnitFace at={item.to} unit={end} label={`O:${end.owner!.toUpperCase()} C:${to.toUpperCase()}`} p={p} start={.68} />}<Clock at={item.to} p={p} start={.7} /></g>)}<Settle {...props} />
        <Receipt at={side(g)} rows={r.moves.length ? ['TWO OWNERS · TWO REGROUP CLOCKS', 'WOUNDS / READINESS KEPT', 'OWNER RETURNS PENDING'] : ['PAYMENT RESOLVED', 'BOARD CONTROL UNCHANGED']} p={p} start={.82} />
    </>;
}
function Regroup(props: Props) {
    const { cue, geometry: g, p } = props, r = regroupProof(cue, g); if (!r) return null;
    return <><Receipt at={side(g)} rows={['REGROUP BEGINS', 'ACTUAL CONTINUING ENTRIES', 'NO PAYMENT / DRAW / READY']} p={p} start={.05} until={.4} />
        {r.continuing.map(t => <Clock key={key(t.unit)} at={cardAt(g, t)} p={p} start={.1} consuming />)}
        {r.moves.map(({ item, t, to, end }) => <g key={key(t.unit)}><Mask at={cardAt(g, t)} p={p} start={.35} /><Flight from={cardAt(g, t)} to={to ? item.to : g.zones[t.unit.owner! + ':discard']} card={end ?? t.unit} p={p} start={.36} end={.69} arrive={!!to} token={!to && !!t.unit.t} />{to && p >= .69 && <UnitFace at={item.to} unit={end!} label={`OWNER ${to.toUpperCase()}`} p={p} start={.69} />}</g>)}<Settle {...props} />
        <Receipt at={side(g)} rows={r.kind === 'defeat' ? ['PLAYED ENTRY → OWNER DISCARD', 'REGROUP OBLIGATION CONSUMED'] : ['CONTINUING UNITS → OWNERS', 'PAIRED OBLIGATIONS CONSUMED']} p={p} start={.8} />
    </>;
}
export function BatchA12Signature(props: Props) {
    if (props.cue.stage === 'regroup-start' && ['unnatural-life', 'impropriety-among-thieves'].includes(props.cue.definition.id)) return <Regroup {...props} />;
    switch (props.cue.definition.id) {
        case 'guerilla-insurgency': return <Guerilla {...props} />;
        case 'planetary-invasion': return <Planetary {...props} />;
        case 'unnatural-life': return <Life {...props} />;
        case 'aid-from-the-innocent': return props.cue.stage === 'next-action' ? <AidLater {...props} /> : <Aid {...props} />;
        case 'impropriety-among-thieves': return <Impropriety {...props} />;
        default: return null;
    }
}
