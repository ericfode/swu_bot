import type { CardRef, GrantedDefeatAbility, Seat, Snapshot, UnitRef } from '../data/types';
import type { CardEffectCue, CardEffectOutcome } from './types';
import { A10_DEFINITIONS } from './batchA10';
import { previewPlayCost } from './previewCosts';
import { easeInOut, envelope, phase } from './animationTimeline';
import { AttachmentMask, CardGhost, EnergyBeam, ResourceBalance, ResourceSlot, ScreenPixels, TokenAssembly, mix, screenShift as shift, type EffectBox, type PlacedOutcome } from './primitives';

type Geometry = { source: EffectBox; target: EffectBox; friendlyBase: EffectBox; outcomes: PlacedOutcome[]; zones: Record<string, EffectBox>; cards?: Record<string, EffectBox>; endingCards?: Record<string, EffectBox>; pockets?: Record<string, EffectBox>; endingPockets?: Record<string, EffectBox>; endingCaptured?: Record<string, EffectBox>; resourceCards?: Record<string, EffectBox> };
type Props = { cue: CardEffectCue; geometry: Geometry; p: number };
const ids = new Set(['manufactured-soldiers', 'pyrrhic-assault', 'the-clone-wars', 'take-captive', 'in-defense-of-kamino']);
export const isBatchA10 = (cue: CardEffectCue) => ids.has(cue.definition.id);
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
const fullUnit = (c?: CardRef | null): c is UnitRef => !!c && 'p' in c && 'h' in c && 'd' in c;
const allUnits = (s: Snapshot, seat: Seat) => [...s.players[seat].ground, ...s.players[seat].space];
const refs = (s: Snapshot) => seats.flatMap(seat => { const p = s.players[seat]; return [p.base, ...(p.leader ? [p.leader] : []), ...p.hand, ...p.discard, ...(p.knownDeck ?? []), ...(p.resources ?? []), ...allUnits(s, seat), ...allUnits(s, seat).flatMap(u => [...(u.u ?? []), ...(u.cap ?? [])])]; });
const find = (cue: CardEffectCue, c?: CardRef | null, after = false) => {
    if (!cue.transition || !c?.id) return;
    const state = cue.transition[after ? 'after' : 'before'];
    const matches = seats.flatMap(seat => (['ground', 'space'] as const).flatMap(zone => state.players[seat][zone].filter(u => same(u, c)).map(unit => ({ unit, seat, zone }))));
    return matches.length === 1 ? matches[0] : undefined;
};
const canonical = (cue: CardEffectCue) => {
    const d = A10_DEFINITIONS.find(d => d.id === cue.definition.id);
    return d && cue.definition.name === d.name && cue.definition.setCode === d.setCode && cue.source?.id && cue.source.n === d.name && cue.source.owner === cue.seat
        && [d.setCode, ...(d.id === 'take-captive' ? ['SHD_131'] : [])].includes(cue.source.s ?? '') ? d : undefined;
};
const sourceProof = (cue: CardEffectCue, o: CardEffectOutcome) => refEqual(cue.source, o.sourceCard);
const phaseProof = (cue: CardEffectCue) => !!cue.transition && cue.transition.before.round === cue.transition.after.round && cue.transition.before.phase === cue.transition.after.phase && cue.transition.before.initiative === cue.transition.after.initiative;
const metadataProof = (cue: CardEffectCue, g: Geometry) => g.outcomes.every(({ outcome: o }) =>
    (!o.grantedAbility || o.kind === 'buff') && (!o.whenDefeatedOrigin || cue.stage === 'next-action' && ['damage', 'create'].includes(o.kind))
    && (!o.restoreOrigin || cue.stage === 'next-action' && o.kind === 'heal') && (!o.captureArena || o.kind === 'capture')
    && (!o.captureCost && !o.captureBasis || o.kind === 'capture') && (!o.tokenType || o.kind === 'create') && !o.traitCondition && !o.paymentRole);

/** Compare paid IDs with independently computed legal cost, including repeated aspects. */
function paymentProof(cue: CardEffectCue, extra: string[] = []) {
    if (!canonical(cue) || !phaseProof(cue) || cue.stage || cue.playPayment?.kind !== 'resources' || cue.playPayment.smuggle || cue.playPayment.exploit || !cue.source || !cue.transition) return;
    let cost: number; try { cost = previewPlayCost(cue.definition, cue.transition.before, cue.seat, cue.playPayment); } catch { return; }
    const paid = cue.playPayment.cardIds, before = cue.transition.before, after = cue.transition.after;
    if (!paid || cue.playCost !== cost || paid.length !== cost || new Set([...paid, ...extra]).size !== cost + extra.length
        || refs(before).filter(c => same(c, cue.source)).length !== 1 || refs(after).filter(c => same(c, cue.source)).length !== 1
        || before.players[cue.seat].hand.filter(c => refEqual(c, cue.source)).length !== 1 || after.players[cue.seat].discard.filter(c => refEqual(c, cue.source)).length !== 1) return;
    if (!seats.every(seat => {
        const a = before.players[seat], b = after.players[seat], charged = seat === cue.seat ? [...paid, ...extra] : [];
        return ordered(a.hand.filter(c => seat !== cue.seat || !same(c, cue.source)), b.hand) && a.deck === b.deck && ordered(a.knownDeck ?? [], b.knownDeck ?? [])
            && equal(a.base, b.base) && equal(a.leader, b.leader) && a.res.total === b.res.total && a.res.ready - charged.length === b.res.ready
            && !!a.resources && !!b.resources && a.resources.length === a.res.total && b.resources.length === b.res.total && ordered(a.resources, b.resources)
            && a.resources.filter(r => !r.x).length === a.res.ready && b.resources.filter(r => !r.x).length === b.res.ready
            && charged.every(id => a.resources!.some(r => r.id === id && !r.x)) && a.resources.every((r, i) => !!b.resources![i].x === (!!r.x || charged.includes(key(r))));
    })) return;
    return { cost, paid };
}

function laterProof(cue: CardEffectCue) {
    if (!canonical(cue) || !phaseProof(cue) || cue.stage !== 'next-action' || cue.playCost !== undefined || cue.playPayment || !cue.transition || !cue.source) return false;
    return refs(cue.transition.before).filter(c => same(c, cue.source)).length === 1 && refs(cue.transition.after).filter(c => same(c, cue.source)).length === 1
        && seats.every(seat => {
            const a = cue.transition!.before.players[seat], b = cue.transition!.after.players[seat];
            return ordered(a.hand, b.hand) && a.deck === b.deck && ordered(a.knownDeck ?? [], b.knownDeck ?? []) && equal(a.resources, b.resources) && equal(a.res, b.res) && equal(a.leader, b.leader)
                && (seat !== cue.seat || a.discard.filter(c => refEqual(c, cue.source)).length === 1 && b.discard.filter(c => refEqual(c, cue.source)).length === 1);
        });
}

/** Expected arena changes are limited to explicitly proved recipients and creations. */
function arenaProof(cue: CardEffectCue, changed: Map<string, UnitRef | null>, created: PlacedOutcome[] = []) {
    if (!cue.transition) return false;
    return seats.every(seat => (['ground', 'space'] as const).every(zone => {
        const expected = cue.transition!.before.players[seat][zone].flatMap(u => changed.has(key(u)) ? changed.get(key(u)) ? [changed.get(key(u))!] : [] : [u]);
        expected.push(...created.filter(i => i.outcome.seat === seat && i.outcome.zone === zone).map(i => i.outcome.unit!));
        return equal(expected, cue.transition!.after.players[seat][zone]);
    }));
}
function discardProof(cue: CardEffectCue, added: { card: CardRef; owner: Seat }[] = [], source = true) {
    if (!cue.transition) return false;
    return seats.every(seat => {
        const a = cue.transition!.before.players[seat].discard, b = cue.transition!.after.players[seat].discard;
        const extra = [...(source && seat === cue.seat && cue.source ? [cue.source] : []), ...added.filter(e => e.owner === seat).map(e => e.card)];
        return b.length === a.length + extra.length && ordered(a, b.slice(0, a.length)) && extra.every(c => b.slice(a.length).filter(e => refEqual(c, e)).length === 1);
    });
}
const tokenFacts = { 'clone-trooper': { name: 'Clone Trooper', stat: 2 }, 'battle-droid': { name: 'Battle Droid', stat: 1 } };
function createdProof(cue: CardEffectCue, item: PlacedOutcome, seat: Seat, type: keyof typeof tokenFacts, cause?: CardRef, activated = false) {
    if (!cue.transition) return false;
    const o = item.outcome, u = o.unit, facts = tokenFacts[type], end = find(cue, o.card, true);
    return o.kind === 'create' && !o.prevented && o.seat === seat && o.ownerSeat === seat && o.zone === 'ground' && o.amount === 1 && o.tokenType === type && o.entryType === 'created' && o.entersReady === false
        && !o.fromZone && !o.fromSeat && !o.basis && !o.requiresReturn && !o.chosenUnits && !o.chosenUnitGroup && !o.resolutionGroup && !o.restoreOrigin && !o.grantedAbility
        && (activated || !o.requiresDefeat && !o.whenDefeatedOrigin) && refEqual(o.sourceCard, cause ?? cue.source)
        && !!u?.id && !!u.incarnation && o.incarnation === u.incarnation && fullUnit(o.card) && equal(o.card, u) && u.n === facts.name && u.s === null && u.t === 1 && u.owner === seat && u.p === facts.stat && u.h === facts.stat && u.d === 0 && u.x === 1
        && !u.sn && !u.u?.length && !u.cap?.length && !u.status?.length && !refs(cue.transition.before).some(c => same(c, u))
        && !!end && end.seat === seat && end.zone === 'ground' && equal(end.unit, u) && refs(cue.transition.after).filter(c => same(c, u)).length === 1;
}
function manufacturedProof(cue: CardEffectCue, g: Geometry) {
    if (!metadataProof(cue, g) || !paymentProof(cue)) return;
    const items = g.outcomes, type = items[0]?.outcome.tokenType;
    if (!type || (type !== 'battle-droid' && type !== 'clone-trooper') || !(type in tokenFacts) || items.length !== (type === 'clone-trooper' ? 2 : 3) || new Set(items.map(i => key(i.outcome.card))).size !== items.length
        || !items.every(i => createdProof(cue, i, cue.seat, type)) || !arenaProof(cue, new Map(), items) || !discardProof(cue)) return;
    return { items, type };
}
function cloneWarsProof(cue: CardEffectCue, g: Geometry) {
    if (!metadataProof(cue, g)) return;
    const pay = g.outcomes[0], o = pay?.outcome, n = o?.amount;
    if (!o || o.kind !== 'pay' || o.prevented || !Number.isSafeInteger(n) || typeof n !== 'number' || n < 0 || o.seat !== cue.seat || o.zone !== 'resources' || !sourceProof(cue, o) || !refEqual(o.card, cue.source)
        || !o.cards || o.cards.length !== n || !paymentProof(cue, o.cards.map(key)) || o.fromZone || o.whenDefeatedOrigin || o.basis) return;
    const before = cue.transition!.before.players[cue.seat];
    if (!o.cards.every(c => before.resources?.some(r => refEqual(r, c) && !r.x))) return;
    const enemy: Seat = cue.seat === 'p1' ? 'p2' : 'p1', items = g.outcomes.slice(1);
    if (items.length !== n * 2 || new Set(items.map(i => key(i.outcome.card))).size !== items.length
        || !items.every((i, k) => createdProof(cue, i, k < n ? cue.seat : enemy, k < n ? 'clone-trooper' : 'battle-droid'))
        || !arenaProof(cue, new Map(), items) || !discardProof(cue)) return;
    return { pay, n, items, own: items.slice(0, n), enemy: items.slice(n) };
}

// JSON-verified primary trait facts. Missing recorded traits never earn a Republic story.
const currentTraits: Record<string, { name: string; traits: string[] }> = {
    SOR_095: { name: 'Battlefield Marine', traits: ['rebel', 'trooper'] },
    SOR_098: { name: 'Echo Base Defender', traits: ['rebel', 'trooper'] },
    SOR_237: { name: 'Alliance X-Wing', traits: ['rebel', 'vehicle', 'fighter'] },
    TWI_241: { name: 'Phase I Clone Trooper', traits: ['republic', 'clone', 'trooper'] },
    TWI_111: { name: 'Republic ARC-170', traits: ['republic', 'vehicle', 'fighter'] }
};
const verifiedTraits = (u: UnitRef) => {
    const f = u.s ? currentTraits[u.s] : u.t === 1 && u.n === 'Clone Trooper' ? { name: 'Clone Trooper', traits: ['republic', 'clone', 'trooper'] } : u.t === 1 && u.n === 'Battle Droid' ? { name: 'Battle Droid', traits: ['separatist', 'droid', 'trooper'] } : undefined;
    return !!f && u.n === f.name && !!u.traits && u.traits.length === f.traits.length && f.traits.every(t => u.traits!.includes(t));
};
function grantDescriptor(cue: CardEffectCue, u: UnitRef, grant: GrantedDefeatAbility | undefined, effect: GrantedDefeatAbility['effect']) {
    const s = cue.transition?.before;
    return !!s && !!grant?.id && grant.sourceId === cue.source?.id && grant.subjectId === u.id && grant.incarnation === u.incarnation && grant.round === s.round && grant.phase === s.phase && grant.effect === effect && grant.amount === (effect === 'create-clone' ? 1 : 2);
}
function grantProof(cue: CardEffectCue, g: Geometry, republic: boolean) {
    if (!metadataProof(cue, g) || !paymentProof(cue) || !cue.transition) return;
    const all = allUnits(cue.transition.before, cue.seat);
    if (republic && !all.every(verifiedTraits)) return;
    const chosen = republic ? all.filter(u => u.traits!.includes('republic')) : all;
    if (g.outcomes.length !== chosen.length * (republic ? 2 : 1)) return;
    const changed = new Map<string, UnitRef | null>(), grants: PlacedOutcome[] = [], keywords: PlacedOutcome[] = [];
    for (const u of chosen) {
        const located = find(cue, u), items = g.outcomes.filter(i => same(i.outcome.card, u)), grant = items.find(i => i.outcome.kind === 'buff'), o = grant?.outcome;
        if (!located || !o || o.prevented || o.seat !== cue.seat || o.zone !== located.zone || !fullUnit(o.card) || !equal(o.card, u) || o.incarnation !== u.incarnation || o.duration !== 'phase' || !sourceProof(cue, o)
            || o.amount !== undefined || o.basis || o.requiresDefeat || o.whenDefeatedOrigin || !grantDescriptor(cue, u, o.grantedAbility, republic ? 'create-clone' : 'damage-enemy-unit')
            || all.some(old => old.status?.some(s => s.grantedAbility?.id === o.grantedAbility!.id))) return;
        const end = find(cue, u, true)?.unit, added = end?.status?.slice(u.status?.length ?? 0), grantStatus = added?.find(s => s.grantedAbility);
        if (!end || !grantStatus || grantStatus.kind !== 'buff' || grantStatus.duration !== 'phase' || !equal(grantStatus.grantedAbility, o.grantedAbility)) return;
        if (republic) {
            const keyword = items.find(i => i.outcome.kind === 'keyword'), k = keyword?.outcome, status = added?.find(s => s.keyword?.name === 'Restore');
            if (!k || k.prevented || k.seat !== cue.seat || k.zone !== located.zone || !fullUnit(k.card) || !equal(k.card, u) || k.incarnation !== u.incarnation || k.duration !== 'phase' || !sourceProof(cue, k) || k.keyword?.name !== 'Restore' || k.keyword.amount !== 2 || k.whenDefeatedOrigin || k.basis || !status || status.kind !== 'keyword' || status.duration !== 'phase' || status.round !== cue.transition.before.round || status.phase !== cue.transition.before.phase || status.incarnation !== u.incarnation || !equal(status.keyword, k.keyword)) return;
            keywords.push(keyword!);
        }
        if (added?.length !== (republic ? 2 : 1) || !equal({ ...u, status: [...(u.status ?? []), ...added] }, end)) return;
        changed.set(key(u), end); grants.push(grant!);
    }
    if (new Set(grants.map(i => i.outcome.grantedAbility!.id)).size !== chosen.length || !arenaProof(cue, changed) || !discardProof(cue)) return;
    return { chosen, grants, keywords };
}

function captureProof(cue: CardEffectCue, g: Geometry) {
    if (!metadataProof(cue, g) || !paymentProof(cue) || g.outcomes.length !== 1 || !cue.transition) return;
    const item = g.outcomes[0], o = item.outcome, target = find(cue, o.card), captor = find(cue, o.sourceCard), arena = o.captureArena;
    if (o.kind !== 'capture' || o.prevented || !target || !captor || !arena || o.captureCost || o.captureBasis || target.seat === cue.seat || captor.seat !== cue.seat || target.zone !== captor.zone || o.seat !== cue.seat || o.zone !== captor.zone || o.fromSeat !== target.seat || o.fromZone !== target.zone
        || !fullUnit(o.card) || !equal(o.card, target.unit) || !fullUnit(o.sourceCard) || !equal(o.sourceCard, captor.unit) || !target.unit.incarnation || !captor.unit.incarnation || o.incarnation !== target.unit.incarnation || arena.captorId !== captor.unit.id || arena.incarnation !== captor.unit.incarnation || arena.arena !== captor.zone || o.ownerSeat !== target.unit.owner || !target.unit.owner
        || target.unit.cap?.length || seats.some(seat => same(cue.transition!.before.players[seat].leader, target.unit)) || o.requiresDefeat || o.requiresReturn || o.whenDefeatedOrigin || o.grantedAbility || o.basis || o.printedCost !== undefined || find(cue, target.unit, true)) return;
    const minimal: CardRef = { id: target.unit.id, n: target.unit.n, s: target.unit.s, owner: target.unit.owner }, end = find(cue, captor.unit, true)?.unit;
    const expected = { ...captor.unit, cap: [...(captor.unit.cap ?? []), ...(target.unit.t ? [] : [minimal])] };
    const added: { card: CardRef; owner: Seat }[] = [];
    for (const up of target.unit.u ?? []) {
        if (!up.owner || up.t && refs(cue.transition.after).some(c => same(c, up))) return;
        if (!up.t) added.push({ card: up, owner: up.owner });
    }
    if (!end || !equal(end, expected) || target.unit.t && refs(cue.transition.after).some(c => same(c, target.unit)) || !discardProof(cue, added)
        || !arenaProof(cue, new Map([[key(target.unit), null], [key(captor.unit), expected]]))) return;
    return { item, target, captor, end };
}

type Battle = { attack: PlacedOutcome; attacker: NonNullable<ReturnType<typeof find>>; defender: NonNullable<ReturnType<typeof find>>; exhaust: PlacedOutcome; forward: PlacedOutcome; counter: PlacedOutcome; deaths: PlacedOutcome[]; changed: Map<string, UnitRef | null>; added: { card: CardRef; owner: Seat }[] };
function battleProof(cue: CardEffectCue, g: Geometry): Battle | undefined {
    if (!metadataProof(cue, g) || !laterProof(cue) || !cue.transition) return;
    const attacks = g.outcomes.filter(i => i.outcome.kind === 'attack'), attack = attacks[0], a = attack?.outcome;
    const attacker = find(cue, a?.sourceCard), defender = find(cue, a?.card);
    if (attacks.length !== 1 || !a || a.prevented || !a.attackId || a.combatOrder !== 'simultaneous' || !attacker || !defender || attacker.seat === defender.seat || attacker.zone !== defender.zone || attacker.unit.x || a.seat !== defender.seat || a.zone !== defender.zone || !fullUnit(a.sourceCard) || !equal(a.sourceCard, attacker.unit) || !fullUnit(a.card) || !equal(a.card, defender.unit)
        || allUnits(cue.transition.before, defender.seat).some(u => cue.transition!.before.players[defender.seat][defender.zone].includes(u) && u.sn && !same(u, defender.unit))
        || [attacker.unit, defender.unit].some(u => !u.owner || !u.incarnation || u.t || u.u?.length || u.cap?.length || seats.some(seat => same(cue.transition!.before.players[seat].leader, u)))) return;
    const exhausts = g.outcomes.filter(i => i.outcome.kind === 'exhaust'), exhaust = exhausts[0], e = exhaust?.outcome;
    if (exhausts.length !== 1 || !e || e.prevented || e.attackId !== a.attackId || !refEqual(e.card, attacker.unit) || e.seat !== attacker.seat || e.zone !== attacker.zone) return;
    const hits = g.outcomes.filter(i => i.outcome.kind === 'damage' && i.outcome.damageType === 'combat'), forward = hits.find(i => i.outcome.attackIndex === 1), counter = hits.find(i => i.outcome.attackIndex === 2);
    if (hits.length !== 2 || !forward || !counter || ![forward, counter].every((item, index) => {
        const o = item.outcome, source = index ? defender : attacker, target = index ? attacker : defender;
        return !o.prevented && o.attackId === a.attackId && o.seat === target.seat && o.zone === target.zone && refEqual(o.sourceCard, source.unit) && refEqual(o.card, target.unit) && o.amount === source.unit.p && !o.basis && !o.whenDefeatedOrigin;
    })) return;
    if (!(g.outcomes.indexOf(attack) < g.outcomes.indexOf(exhaust) && g.outcomes.indexOf(exhaust) < g.outcomes.indexOf(forward) && g.outcomes.indexOf(forward) < g.outcomes.indexOf(counter))) return;
    const changed = new Map<string, UnitRef | null>(), deaths: PlacedOutcome[] = [], added: { card: CardRef; owner: Seat }[] = [];
    for (const [target, source, hit] of [[defender, attacker, forward], [attacker, defender, counter]] as const) {
        const fatal = target.unit.d + source.unit.p >= target.unit.h, items = g.outcomes.filter(i => i.outcome.kind === 'defeat' && same(i.outcome.card, target.unit));
        if (fatal) {
            const item = items[0], o = item?.outcome;
            if (items.length !== 1 || !o || o.prevented || o.seat !== target.seat || o.zone !== target.zone || !fullUnit(o.card) || !equal(o.card, target.unit) || o.incarnation !== target.unit.incarnation || o.ownerSeat !== target.unit.owner || !refEqual(o.sourceCard, source.unit) || o.whenDefeatedOrigin || g.outcomes.indexOf(item) <= Math.max(g.outcomes.indexOf(forward), g.outcomes.indexOf(counter)) || find(cue, target.unit, true)) return;
            deaths.push(item); changed.set(key(target.unit), null); added.push({ card: target.unit, owner: target.unit.owner! });
        } else {
            if (items.length) return;
            changed.set(key(target.unit), { ...target.unit, d: target.unit.d + Number(hit.outcome.amount), ...(target === attacker ? { x: 1 as const } : {}) });
        }
    }
    return { attack, attacker, defender, exhaust, forward, counter, deaths, changed, added };
}
function activationProof(cue: CardEffectCue, item: PlacedOutcome, subject: UnitRef, controller: Seat, effect: GrantedDefeatAbility['effect'], death: PlacedOutcome, g: Geometry) {
    const o = item.outcome, origin = o.whenDefeatedOrigin, status = subject.status?.find(s => s.grantedAbility?.id === origin?.abilityId), grant = status?.grantedAbility;
    return !o.prevented && !!origin && status?.kind === 'buff' && status.duration === 'phase' && grantDescriptor(cue, subject, grant, effect) && origin.abilityId === grant!.id && origin.sourceId === grant!.sourceId && origin.subjectId === subject.id && origin.incarnation === subject.incarnation
        && origin.controller === controller && origin.round === cue.transition!.before.round && origin.phase === cue.transition!.before.phase
        && refEqual(o.sourceCard, subject) && o.requiresDefeat?.id === subject.id && o.requiresDefeat.incarnation === subject.incarnation && g.outcomes.indexOf(item) > g.outcomes.indexOf(death);
}
function laterActivationProof(cue: CardEffectCue, g: Geometry, kamino: boolean) {
    const battle = battleProof(cue, g); if (!battle || !cue.transition) return;
    const subject = kamino ? battle.attacker : battle.defender, other = kamino ? battle.defender : battle.attacker, death = battle.deaths.find(i => same(i.outcome.card, subject.unit));
    if (!death || subject.seat === other.seat) return;
    const changed = new Map(battle.changed), added = [...battle.added];
    if (!kamino) {
        const abilities = g.outcomes.filter(i => i.outcome.kind === 'damage' && i.outcome.damageType === 'ability'), hit = abilities[0], o = hit?.outcome, target = find(cue, o?.card);
        if (abilities.length !== 1 || !o || !target || target.seat === subject.seat || changed.has(key(target.unit)) || o.seat !== target.seat || o.zone !== target.zone || o.amount !== 2 || o.basis || !fullUnit(o.card) || !equal(o.card, target.unit)
            || !activationProof(cue, hit, subject.unit, subject.seat, 'damage-enemy-unit', death, g) || g.outcomes.indexOf(hit) <= Math.max(...battle.deaths.map(i => g.outcomes.indexOf(i)))) return;
        const fatalities = g.outcomes.filter(i => i.outcome.kind === 'defeat' && same(i.outcome.card, target.unit)), fatal = target.unit.d + 2 >= target.unit.h;
        if (fatal) {
            const item = fatalities[0], d = item?.outcome;
            if (fatalities.length !== 1 || !d || d.prevented || d.seat !== target.seat || d.zone !== target.zone || !fullUnit(d.card) || !equal(d.card, target.unit) || d.incarnation !== target.unit.incarnation || d.ownerSeat !== target.unit.owner || !refEqual(d.sourceCard, subject.unit) || target.unit.t || target.unit.u?.length || target.unit.cap?.length || !target.unit.owner || g.outcomes.indexOf(item) <= g.outcomes.indexOf(hit) || find(cue, target.unit, true)) return;
            changed.set(key(target.unit), null); added.push({ card: target.unit, owner: target.unit.owner });
        } else { if (fatalities.length) return; changed.set(key(target.unit), { ...target.unit, d: target.unit.d + 2 }); }
        const expected = [battle.attack, battle.exhaust, battle.forward, battle.counter, ...battle.deaths, hit, ...fatalities];
        if (g.outcomes.length !== expected.length || !g.outcomes.every(i => expected.includes(i)) || !arenaProof(cue, changed) || !discardProof(cue, added, false) || !seats.every(s => equal(cue.transition!.before.players[s].base, cue.transition!.after.players[s].base))) return;
        return { battle, subject, hit, target, creates: [] as PlacedOutcome[], heal: undefined, triggerDeaths: fatalities };
    }
    const heals = g.outcomes.filter(i => i.outcome.kind === 'heal'), heal = heals[0], h = heal?.outcome, origin = h?.restoreOrigin;
    const matchingRestore = subject.unit.status?.filter(s => s.kind === 'keyword' && s.duration === 'phase' && s.keyword?.name === 'Restore' && s.round === cue.transition!.before.round && s.phase === cue.transition!.before.phase && s.incarnation === subject.unit.incarnation) ?? [];
    const total = matchingRestore.reduce((n, s) => n + (s.keyword?.amount ?? 0), 0), base = cue.transition.before.players[subject.seat].base;
    if (heals.length !== 1 || !h || h.prevented || !origin || subject.unit.s !== 'TWI_241' || subject.unit.n !== 'Phase I Clone Trooper' || !verifiedTraits(subject.unit) || !total || total !== origin.amount || !matchingRestore.every(s => Number.isSafeInteger(s.keyword?.amount) && s.keyword!.amount > 0)
        || origin.attackerId !== subject.unit.id || origin.incarnation !== subject.unit.incarnation || origin.attackId !== battle.attack.outcome.attackId || origin.round !== cue.transition.before.round || origin.phase !== cue.transition.before.phase || h.seat !== subject.seat || h.zone !== 'base' || !refEqual(h.card, base) || !refEqual(h.sourceCard, subject.unit) || h.amount !== Math.min(total, base.d) || h.whenDefeatedOrigin || h.basis
        || !(g.outcomes.indexOf(battle.exhaust) < g.outcomes.indexOf(heal) && g.outcomes.indexOf(heal) < g.outcomes.indexOf(battle.forward))) return;
    const creates = g.outcomes.filter(i => i.outcome.kind === 'create'), create = creates[0];
    if (creates.length !== 1 || !createdProof(cue, create, subject.seat, 'clone-trooper', subject.unit, true) || !activationProof(cue, create, subject.unit, subject.seat, 'create-clone', death, g)
        || !arenaProof(cue, changed, creates) || !discardProof(cue, added, false) || !seats.every(s => equal(s === subject.seat ? { ...cue.transition!.before.players[s].base, d: base.d - Number(h.amount) } : cue.transition!.before.players[s].base, cue.transition!.after.players[s].base))) return;
    const expected = [battle.attack, battle.exhaust, heal, battle.forward, battle.counter, ...battle.deaths, create];
    if (g.outcomes.length !== expected.length || !g.outcomes.every(i => expected.includes(i))) return;
    return { battle, subject, hit: undefined, target: undefined, creates, heal, triggerDeaths: [] as PlacedOutcome[] };
}

export function batchA10Covers(cue: CardEffectCue, g: Geometry, item: PlacedOutcome): boolean {
    if (cue.stage === 'next-action') return g.outcomes.includes(item) && ['pyrrhic-assault', 'in-defense-of-kamino'].includes(cue.definition.id) && !!laterActivationProof(cue, g, cue.definition.id === 'in-defense-of-kamino');
    switch (cue.definition.id) {
        case 'manufactured-soldiers': return manufacturedProof(cue, g)?.items.includes(item) ?? false;
        case 'the-clone-wars': { const r = cloneWarsProof(cue, g); return !!r && (r.pay === item || r.items.includes(item)); }
        case 'pyrrhic-assault': return grantProof(cue, g, false)?.grants.includes(item) ?? false;
        case 'in-defense-of-kamino': { const r = grantProof(cue, g, true); return !!r && [...r.grants, ...r.keywords].includes(item); }
        case 'take-captive': return captureProof(cue, g)?.item === item;
        default: return false;
    }
}

const size = (at: EffectBox) => at.cardSize ?? { w: at.w * (at.sx ?? 1), h: at.h * (at.sy ?? 1) };
const visible = (p: number, start: number) => phase(p, start, start + .04);
const bounded = (at: EffectBox, w = 220, h = 42): EffectBox => ({ ...at, x: Math.max((w / 2 + 8) / (at.sx ?? 1), Math.min(1000 - (w / 2 + 8) / (at.sx ?? 1), at.x)), y: Math.max((h / 2 + 40) / (at.sy ?? 1), Math.min(600 - (h / 2 + 122) / (at.sy ?? 1), at.y)) });
const center = (g: Geometry) => {
    const upper = g.zones['p2:ground'], lower = g.zones['p1:base'];
    return bounded({ ...g.source, x: 500, y: upper && lower ? (upper.y + upper.h / 2 + lower.y - lower.h / 2) / 2 : 300 });
};
function Receipt({ at, rows, p, start = .72, until, color = '#d4ddcd' }: { at: EffectBox; rows: string[]; p: number; start?: number; until?: number; color?: string }) {
    const w = Math.min(246, Math.max(82, ...rows.map(r => r.length * 4.8 + 16))), h = rows.length * 16 + 8;
    return <ScreenPixels at={bounded(at, w, h)} color={color} opacity={visible(p, start) * (until ? 1 - phase(p, until - .05, until) : 1)}>
        <rect x={-w / 2} y={-h / 2} width={w} height={h} rx="4" fill="#08111e" fillOpacity=".97" strokeWidth="1" />
        {rows.map((r, i) => <text key={i} y={-h / 2 + 14 + i * 16} textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '700 9px var(--font-display,sans-serif)' }}>{r}</text>)}
    </ScreenPixels>;
}
function Mask({ at, p, start }: { at: EffectBox; p: number; start: number }) {
    const s = size(at);
    return <ScreenPixels at={at} opacity={visible(p, start)}><rect x={-s.w / 2 - 4} y={-s.h / 2 - 4} width={s.w + 8} height={s.h + 8} rx="5" fill="#0b1420" stroke="none" /></ScreenPixels>;
}
/** Side corridor is used for capture; it keeps the crossing clear of HQ numerals. */
function Travel({ from, to, card, p, start, end, back = false, hold = false, exhausted = false, corridor, approach }: { from: EffectBox; to: EffectBox; card: CardRef; p: number; start: number; end: number; back?: boolean; hold?: boolean; exhausted?: boolean; corridor?: number; approach?: EffectBox }) {
    if (p < start) return null;
    const t = easeInOut(phase(p, start, end)), a = size(from), b = hold ? size(to) : { w: 20, h: 28 };
    let at = { ...from, ...mix(from, to, t) };
    if (corridor !== undefined) {
        const first = { ...from, x: corridor }, last = { ...(approach ?? to), x: corridor };
        at = { ...from, ...(approach
            ? t < .18 ? mix(from, first, easeInOut(t / .18)) : t < .65 ? mix(first, last, easeInOut((t - .18) / .47)) : t < .88 ? mix(last, approach, easeInOut((t - .65) / .23)) : mix(approach, to, easeInOut((t - .88) / .12))
            : t < .22 ? mix(from, first, easeInOut(t / .22)) : t < .8 ? mix(first, last, easeInOut((t - .22) / .58)) : mix(last, to, easeInOut((t - .8) / .2))) };
    }
    return <ScreenPixels at={at} opacity={visible(p, start) * (hold ? 1 : 1 - phase(p, end, end + .07))}>
        <g transform={'rotate(' + (exhausted ? 10 : 0) + ')' + (exhausted ? ' scale(.94)' : '')}><CardGhost card={card} back={back && t > .38} box={{ w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t }} /></g>
    </ScreenPixels>;
}
function Payment(props: Props) {
    const { cue, geometry: g, p } = props, before = cue.transition!.before.players[cue.seat], paid = cue.playPayment?.kind === 'resources' ? cue.playPayment.cardIds! : [];
    return <>{before.resources!.map((r, i) => {
        const at = g.resourceCards?.[cue.seat + ':' + key(r)];
        return at && paid.includes(key(r)) ? <ResourceSlot key={key(r)} at={at} index={i} spent p={p} start={.04} /> : null;
    })}<ResourceBalance at={g.zones[cue.seat + ':resources']} countAt={g.zones[cue.seat + ':resource-count']} ready={before.res.ready - paid.length} total={before.res.total} p={p} start={.04} />
        <Mask at={g.source} p={p} start={.04} /><Travel from={{ ...g.source, cardSize: { w: 20, h: 28 } }} to={g.zones[cue.seat + ':discard']} card={cue.source!} p={p} start={.04} end={.21} corridor={16 / (g.source.sx ?? 1)} approach={shift(g.zones[cue.seat + ':discard'], 0, g.source.y > g.zones[cue.seat + ':discard'].y ? 24 : -24)} />
    </>;
}
function Stats({ at, unit, p, start }: { at: EffectBox; unit: UnitRef; p: number; start: number }) {
    const s = size(at);
    return <>{(['power', 'hp'] as const).map((name, i) => {
        const counter = at.counters?.[name];
        return <ScreenPixels key={name} at={counter ? { ...at, ...counter } : shift(at, (i ? 1 : -1) * (s.w / 2 - 11), s.h / 2 - 12)} opacity={visible(p, start)}>
            <rect x="-11" y="-12" width="22" height="24" rx="3" fill={i ? '#174772' : '#8b2936'} stroke="#e8e7cc" /><text y="4" textAnchor="middle" fill="#fff" stroke="none" style={{ font: '800 14px sans-serif' }}>{i ? Math.max(0, unit.h - unit.d) : unit.p}</text>
        </ScreenPixels>;
    })}{unit.sn === 1 && <ScreenPixels at={shift(at, -s.w / 2 + 17, -s.h / 2 + 10)} opacity={visible(p, start)}><rect x="-13" y="-8" width="26" height="16" rx="3" fill="#e9eef8" stroke="none" /><text y="3" textAnchor="middle" fill="#1d2a44" stroke="none" style={{ font: '800 8px sans-serif' }}>SEN</text></ScreenPixels>}</>;
}
function GrantBadge({ at, p, start, clone, restore = false }: { at: EffectBox; p: number; start: number; clone: boolean; restore?: boolean }) {
    const s = size(at), w = Math.max(36, s.w - 6), rows = ['WHEN DEFEATED', clone ? 'CREATE CLONE' : 'ENEMY UNIT 2', 'PHASE'];
    return <ScreenPixels at={at} color={clone ? '#a4dbe6' : '#f4c093'} opacity={visible(p, start)}>
        <path d={`M${-s.w / 2 - 3} ${-s.h / 2 + 8} V${s.h / 2 - 27} M${s.w / 2 + 3} ${-s.h / 2 + 8} V${s.h / 2 - 27}`} strokeWidth="2" opacity={envelope(p, start, start + .07, start + .27)} />
        {restore && <g transform={`translate(0 ${s.h / 2 - 62})`}><rect x={-w / 2} y="-7" width={w} height="14" rx="2" fill="#183339" /><text y="2" textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '800 6px sans-serif' }}>RESTORE 2 · PHASE</text></g>}
        <g transform={`translate(0 ${s.h / 2 - 39})`}><rect x={-w / 2} y="-13" width={w} height="26" rx="3" fill={clone ? '#132a33' : '#33261b'} strokeWidth="1" />{rows.map((r, i) => <text key={r} y={-6 + i * 8} textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '800 5.5px sans-serif' }}>{r}</text>)}</g>
    </ScreenPixels>;
}
function SettleSurvivors({ cue, geometry: g, p, start = .73, end = .86 }: Props & { start?: number; end?: number }) {
    if (!cue.transition) return null;
    return <>{seats.flatMap(seat => allUnits(cue.transition!.after, seat).filter(u => find(cue, u)).map(u => {
        const from = g.cards?.[seat + ':' + key(u)], to = g.endingCards?.[seat + ':' + key(u)];
        if (!from || !to || Math.abs(from.x - to.x) < .2 && Math.abs(from.y - to.y) < .2) return null;
        return <g key={key(u)}><Mask at={from} p={p} start={start} /><Travel from={from} to={to} card={u} p={p} start={start} end={end} hold exhausted={u.x === 1} /><Stats at={{ ...from, ...mix(from, to, easeInOut(phase(p, start, end))), counters: undefined }} unit={u} p={p} start={start} /></g>;
    }))}</>;
}
function Depart({ item, geometry: g, p, start, end }: { item: PlacedOutcome; geometry: Geometry; p: number; start: number; end: number }) {
    const card = item.outcome.card!, from = g.cards?.[item.outcome.seat + ':' + key(card)] ?? item.box;
    return <><Mask at={from} p={p} start={start} /><Travel from={from} to={g.zones[item.outcome.ownerSeat + ':discard'] ?? item.to} card={card} p={p} start={start} end={end} /></>;
}
function Manufactured(props: Props) {
    const { cue, geometry: g, p } = props, r = manufacturedProof(cue, g);
    if (!r) return null;
    const clones = r.type === 'clone-trooper';
    return <><Payment {...props} /><Receipt at={center(g)} rows={['CHOOSE ONE MODE', clones ? '2 CLONE TROOPERS · 2/2' : '3 BATTLE DROIDS · 1/1']} p={p} start={.06} until={.37} color={clones ? '#bce3e7' : '#d4d8a3'} />
        {r.items.map((item, i) => <TokenAssembly key={key(item.outcome.card)} at={item.to} unit={item.outcome.unit!} p={p} start={.28 + i * .035} end={.62 + i * .035} color={clones ? '#bce3e7' : '#d4d8a3'} />)}
        <Receipt at={center(g)} rows={[r.items.length + ' OWN TOKEN UNITS CREATED', 'TOKENS ENTER EXHAUSTED']} p={p} start={.76} />
    </>;
}
function Grant(props: Props) {
    const { cue, geometry: g, p } = props, clone = cue.definition.id === 'in-defense-of-kamino', r = grantProof(cue, g, clone);
    if (!r) return null;
    return <><Payment {...props} /><Receipt at={center(g)} rows={[clone ? 'CURRENT FRIENDLY REPUBLIC UNITS' : 'CURRENT FRIENDLY UNITS · BOTH ARENAS', 'GRANT ABILITIES FOR THIS PHASE']} p={p} start={.06} until={.32} />
        {r.chosen.map((u, i) => { const at = g.cards?.[cue.seat + ':' + key(u)]; return at ? <GrantBadge key={key(u)} at={at} p={p} start={.25 + i * .05} clone={clone} restore={clone} /> : null; })}
        <Receipt at={center(g)} rows={[clone ? 'RESTORE 2 WHEN ATTACKING' : 'WHEN DEFEATED → ENEMY UNIT 2', clone ? 'WHEN DEFEATED → CREATE CLONE' : 'THESE UNITS KEEP THEIR GRANTS', 'LATER ACTION ACTIVATES THE GRANT']} p={p} start={.71} />
    </>;
}
function CloneWars(props: Props) {
    const { cue, geometry: g, p } = props, r = cloneWarsProof(cue, g); if (!r) return null;
    const before = cue.transition!.before.players[cue.seat];
    return <><Payment {...props} /><Receipt at={center(g)} rows={['EVENT ' + cue.playCost + ' · THEN EXTRA ' + r.n, 'EXTRA PAYMENT SETS EACH TOKEN COUNT']} p={p} start={.06} until={.36} />
        {r.pay.outcome.cards!.map(c => { const at = g.resourceCards?.[cue.seat + ':' + key(c)], index = before.resources!.findIndex(r => same(r, c)); return at ? <ResourceSlot key={key(c)} at={at} index={index} spent p={p} start={.24} /> : null; })}
        <ResourceBalance at={g.zones[cue.seat + ':resources']} countAt={g.zones[cue.seat + ':resource-count']} ready={before.res.ready - cue.playCost! - r.n} total={before.res.total} p={p} start={.24} />
        {r.own.map((item, i) => <TokenAssembly key={key(item.outcome.card)} at={item.to} unit={item.outcome.unit!} p={p} start={.35 + i * .02} end={.54 + i * .02} color="#bce3e7" />)}
        {r.enemy.map((item, i) => <TokenAssembly key={key(item.outcome.card)} at={item.to} unit={item.outcome.unit!} p={p} start={.59 + i * .02} end={.76 + i * .02} color="#d4d8a3" />)}
        <Receipt at={center(g)} rows={[r.n + ' OWN CLONES 2/2', r.n + ' OPPONENT DROIDS 1/1', 'EXHAUSTED · OPPONENT PAYS NOTHING']} p={p} start={.84} />
    </>;
}
function Captive(props: Props) {
    const { cue, geometry: g, p } = props, r = captureProof(cue, g); if (!r) return null;
    const from = g.cards?.[r.target.seat + ':' + key(r.target.unit)] ?? r.item.from, to = r.item.to;
    const corridor = 16 / (from.sx ?? 1);
    return <><Payment {...props} /><Receipt at={center(g)} rows={['SAME ' + r.captor.zone.toUpperCase() + ' ARENA', 'ENEMY NON-LEADER · NO COST LIMIT']} p={p} start={.07} until={.32} />
        <Mask at={from} p={p} start={.31} />{r.target.unit.u?.map(up => { const chip = g.cards?.[r.target.seat + ':' + key(up)]; return chip ? <g key={key(up)}><AttachmentMask at={chip} p={p} start={.29} />{!up.t && <Travel from={{ ...chip, cardSize: { w: 28, h: 39 } }} to={g.zones[up.owner + ':discard']} card={up} p={p} start={.29} end={.5} />}</g> : null; })}
        {!r.target.unit.t && <>
            {(() => { const pocket = g.endingPockets?.[cue.seat + ':' + key(r.captor.unit)] ?? g.pockets?.[cue.seat + ':' + key(r.captor.unit)]; return pocket ? <><AttachmentMask at={pocket} p={p} start={.69} /><ScreenPixels at={shift(pocket, -size(pocket).w / 2 + (size(pocket).w < 70 ? 12 : 18), 0)} opacity={visible(p, .69)} color="#d6c6ee"><text y="-5" textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '700 5px sans-serif' }}>CAPTIVE</text><text y="9" textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '800 12px sans-serif' }}>{r.end.cap!.length}</text></ScreenPixels></> : null; })()}
            <Travel from={{ ...from, cardSize: { w: 20, h: 28 } }} to={to} card={r.target.unit} p={p} start={.33} end={.69} back hold corridor={corridor} />
        </>}
        {r.target.unit.t && <Receipt at={center(g)} rows={['CAPTURED TOKEN CEASES']} p={p} start={.42} until={.68} />}
        <SettleSurvivors {...props} start={.71} end={.84} /><Receipt at={center(g)} rows={[r.target.unit.t ? 'TOKEN REMOVED · NO POCKET CARD' : 'FACEDOWN IN FRIENDLY CAPTOR POCKET', 'OWNER ' + r.target.unit.owner!.toUpperCase() + ' · CAPTOR POSE STAYS', 'ORDINARY UPGRADES → OWNERS']} p={p} start={.86} />
    </>;
}
function Later(props: Props) {
    const { cue, geometry: g, p } = props, kamino = cue.definition.id === 'in-defense-of-kamino', r = laterActivationProof(cue, g, kamino); if (!r) return null;
    const b = r.battle, from = g.cards?.[b.attacker.seat + ':' + key(b.attacker.unit)] ?? b.attack.from, target = g.cards?.[b.defender.seat + ':' + key(b.defender.unit)] ?? b.attack.box;
    const combatStart = kamino ? .36 : .27, removalStart = kamino ? .5 : .44, activation = kamino ? .67 : .67;
    return <><Receipt at={center(g)} rows={['LATER ACTION · EVENT ALREADY PAID', kamino ? 'DECLARE ATTACK · RESTORE FIRST' : 'ENEMY ATTACKS SENTINEL']} p={p} start={.05} until={.24} />
        <Mask at={from} p={p} start={.18} />
        {p < removalStart && <><Travel from={from} to={from} card={b.attacker.unit} p={p} start={.18} end={.23} hold exhausted /><Stats at={from} unit={b.attacker.unit} p={p} start={.18} />{kamino && <GrantBadge at={from} p={p} start={.18} clone restore />}</>}
        {r.heal && <><EnergyBeam from={from} to={r.heal.box} p={p} start={.2} end={.32} color="#9bdebd" width={3} /><Receipt at={center(g)} rows={['RESTORE ' + r.heal.outcome.restoreOrigin!.amount + ' · BASE HEAL ' + r.heal.outcome.amount]} p={p} start={.22} until={.37} /><ScreenPixels at={r.heal.box.stat ? { ...r.heal.box, ...r.heal.box.stat } : r.heal.box} opacity={visible(p, .31)}><circle r="24" fill="#0b1420" stroke="#85d1aa" strokeWidth="3" /><text y="6" textAnchor="middle" fill="#e8fff3" stroke="none" style={{ font: '800 19px sans-serif' }}>{cue.transition!.after.players[r.subject.seat].base.hp - cue.transition!.after.players[r.subject.seat].base.d}</text></ScreenPixels></>}
        <EnergyBeam from={from} to={target} p={p} start={combatStart} end={combatStart + .14} color="#efbd8e" width={5} /><EnergyBeam from={target} to={from} p={p} start={combatStart} end={combatStart + .14} color="#a9c8ed" width={4} />
        <Receipt at={center(g)} rows={['COMBAT ' + b.attacker.unit.p + ' / ' + b.defender.unit.p, 'SIMULTANEOUS DAMAGE']} p={p} start={combatStart} until={removalStart + .02} />
        {b.deaths.map(item => <Depart key={key(item.outcome.card)} item={item} geometry={g} p={p} start={removalStart} end={removalStart + .17} />)}
        {!b.changed.get(key(b.defender.unit)) ? null : <Stats at={target} unit={b.changed.get(key(b.defender.unit))!} p={p} start={combatStart + .12} />}
        {!b.changed.get(key(b.attacker.unit)) ? null : <Stats at={from} unit={b.changed.get(key(b.attacker.unit))!} p={p} start={combatStart + .12} />}
        {r.hit && r.target && <><EnergyBeam from={g.zones[r.subject.unit.owner + ':discard']} to={r.hit.box} p={p} start={activation} end={.78} color="#f3ae79" width={3} /><Receipt at={center(g)} rows={['DEFEATED UNIT’S GRANTED ABILITY', r.subject.seat.toUpperCase() + ' → ENEMY UNIT 2']} p={p} start={.64} until={.82} /><Stats at={r.hit.box} unit={{ ...r.target.unit, d: r.target.unit.d + 2 }} p={p} start={.77} />{r.triggerDeaths.map(item => <Depart key={key(item.outcome.card)} item={item} geometry={g} p={p} start={.81} end={.91} />)}</>}
        {r.creates.map(item => <TokenAssembly key={key(item.outcome.card)} at={item.to} unit={item.outcome.unit!} p={p} start={activation} end={.83} color="#bce3e7" />)}
        <SettleSurvivors {...props} start={.87} end={.94} /><Receipt at={center(g)} rows={kamino ? ['NEW CLONE 2/2 · EXHAUSTED', 'NEW CLONE HAS NO EARLIER GRANTS'] : ['MATCHING DEFEAT ACTIVATED ONE GRANT', 'SURVIVING PHASE GRANTS REMAIN']} p={p} start={.95} />
    </>;
}
export function BatchA10Signature(props: Props) {
    if (props.cue.stage === 'next-action') return ['pyrrhic-assault', 'in-defense-of-kamino'].includes(props.cue.definition.id) ? <Later {...props} /> : null;
    switch (props.cue.definition.id) {
        case 'manufactured-soldiers': return <Manufactured {...props} />;
        case 'pyrrhic-assault': case 'in-defense-of-kamino': return <Grant {...props} />;
        case 'the-clone-wars': return <CloneWars {...props} />;
        case 'take-captive': return <Captive {...props} />;
        default: return null;
    }
}
