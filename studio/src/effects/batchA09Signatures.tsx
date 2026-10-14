import type { CardRef, Seat, Snapshot, UnitRef } from '../data/types';
import type { CardEffectCue, CardEffectOutcome } from './types';
import { previewPlayCost } from './previewCosts';
import { A09_DEFINITIONS } from './batchA09';
import { easeInOut, envelope, phase } from './animationTimeline';
import { AttachmentMask, CardGhost, CountedMarks, ResourceBalance, ResourceSlot, ScreenPixels, TokenAssembly, mix, screenShift as shift, type EffectBox, type PlacedOutcome } from './primitives';

type Geometry = { source: EffectBox; target: EffectBox; friendlyBase: EffectBox; outcomes: PlacedOutcome[]; zones: Record<string, EffectBox>; cards?: Record<string, EffectBox>; endingCards?: Record<string, EffectBox>; intermediateCards?: Record<string, EffectBox>; resourceCards?: Record<string, EffectBox> };
type Props = { cue: CardEffectCue; geometry: Geometry; p: number };
type Departure = { item: PlacedOutcome; old: UnitRef; leader: boolean };
const ids = new Set(['grievous-reassembly', 'death-by-droids', 'the-invasion-of-christophsis', 'reprocess', 'consolidation-of-power']);
export const isBatchA09 = (cue: CardEffectCue) => ids.has(cue.definition.id);
const seats: Seat[] = ['p1', 'p2'];
const key = (card?: CardRef | null) => card?.id ?? '';
const same = (a?: CardRef | null, b?: CardRef | null) => !!a?.id && a.id === b?.id;
const refEqual = (a?: CardRef | null, b?: CardRef | null) => same(a, b) && a?.s === b?.s && a?.n === b?.n && a?.owner === b?.owner;
const ordered = (a: CardRef[], b: CardRef[]) => a.length === b.length && a.every((c, i) => refEqual(c, b[i]));
const units = (cue: CardEffectCue, seat: Seat, after = false) => [...(cue.transition?.[after ? 'after' : 'before'].players[seat].ground ?? []), ...(cue.transition?.[after ? 'after' : 'before'].players[seat].space ?? [])];
const unitIn = (cue: CardEffectCue, card: CardRef | null | undefined, seat: Seat, after = false) => units(cue, seat, after).find(c => same(c, card));
const fullUnit = (card?: CardRef | null): card is UnitRef => !!card && 'p' in card && 'h' in card && 'd' in card;
const exactUnit = (a: UnitRef, b: UnitRef) => JSON.stringify(a) === JSON.stringify(b);
const samePose = (a: UnitRef, b: UnitRef) => refEqual(a, b) && a.incarnation === b.incarnation && a.p === b.p && a.h === b.h && !!a.x === !!b.x && a.sn === b.sn && JSON.stringify(a.u ?? []) === JSON.stringify(b.u ?? []) && JSON.stringify(a.cap ?? []) === JSON.stringify(b.cap ?? []) && JSON.stringify(a.status ?? []) === JSON.stringify(b.status ?? []);
const refs = (s: Snapshot) => seats.flatMap(seat => { const p = s.players[seat]; return [p.base, ...(p.leader ? [p.leader] : []), ...p.hand, ...p.discard, ...(p.knownDeck ?? []), ...(p.resources ?? []), ...p.ground, ...p.space, ...[...p.ground, ...p.space].flatMap(u => [...(u.u ?? []), ...(u.cap ?? [])])]; });
const sourceProof = (cue: CardEffectCue, o: CardEffectOutcome) => refEqual(o.sourceCard, cue.source);
const size = (at: EffectBox) => at.cardSize ?? { w: at.w * (at.sx ?? 1), h: at.h * (at.sy ?? 1) };
const visible = (p: number, start: number) => phase(p, start, start + .045);
const bounded = (at: EffectBox, w = 220, h = 42): EffectBox => ({ ...at, x: Math.max((w / 2 + 8) / (at.sx ?? 1), Math.min(1000 - (w / 2 + 8) / (at.sx ?? 1), at.x)), y: Math.max((h / 2 + 40) / (at.sy ?? 1), Math.min(600 - (h / 2 + 122) / (at.sy ?? 1), at.y)) });
const center = (g: Geometry) => { const upper = g.zones['p2:ground'], base = g.zones['p1:base']; return bounded({ ...g.source, x: 500, y: upper && base ? (upper.y + upper.h / 2 + base.y - base.h / 2) / 2 : 300 }); };
// Direct installed JSON facts for explicitly supported staged units, including the deployed leader side.
const printed: Record<string, number> = { SOR_095: 2, SOR_098: 3, SOR_237: 2, SOR_033: 3, SOR_164: 4, SOR_225: 1, SOR_232: 6, SHD_239: 3, SOR_005: 6, SOR_010: 7 };
const entering: Record<string, { name: string; p: number; h: number; zone: 'ground' | 'space' }> = { SOR_164: { name: 'Wampa', p: 4, h: 5, zone: 'ground' }, SOR_095: { name: 'Battlefield Marine', p: 3, h: 3, zone: 'ground' }, SOR_225: { name: 'TIE/ln Fighter', p: 2, h: 1, zone: 'space' } };
const printedCost = (u: UnitRef) => u.t === 1 && u.n === 'Battle Droid' && u.s === null ? 0 : u.s ? printed[u.s] : undefined;

/** Canonical legal event payment, independently compared with the declared amount and IDs. */
function eventProof(cue: CardEffectCue, allowExploit = false) {
    const canonical = A09_DEFINITIONS.find(d => d.id === cue.definition.id);
    if (!canonical || cue.definition.name !== canonical.name || cue.definition.setCode !== canonical.setCode || !cue.transition || cue.stage || !cue.source?.id || cue.source.s !== canonical.setCode || cue.source.n !== canonical.name || cue.source.owner !== cue.seat || cue.playPayment?.kind !== 'resources' || cue.playPayment.smuggle || !allowExploit && cue.playPayment.exploit) return false;
    const before = cue.transition.before.players[cue.seat], after = cue.transition.after.players[cue.seat], paid = cue.playPayment.cardIds;
    if (cue.playPayment.exploit?.sourceId && cue.playPayment.exploit.sourceId !== cue.source.id) return false;
    let cost: number; try { cost = previewPlayCost(cue.definition, cue.transition.before, cue.seat, cue.playPayment); } catch { return false; }
    return !!paid && cue.playCost === cost && paid.length === cost && new Set(paid).size === paid.length
        && before.hand.filter(c => refEqual(c, cue.source)).length === 1 && !after.hand.some(c => same(c, cue.source)) && after.discard.filter(c => refEqual(c, cue.source)).length === 1 && refs(cue.transition.before).filter(c => same(c, cue.source)).length === 1 && refs(cue.transition.after).filter(c => same(c, cue.source)).length === 1
        && !!before.resources && !!after.resources && before.resources.length === before.res.total && after.resources.length === after.res.total && ordered(before.resources, after.resources)
        && before.res.total === after.res.total && before.resources.filter(c => !c.x).length === before.res.ready && after.resources.filter(c => !c.x).length === after.res.ready && after.res.ready === before.res.ready - cost
        && paid.every(id => before.resources!.some(c => c.id === id && !c.x)) && before.resources.every((c, i) => !!after.resources![i].x === (!!c.x || paid.includes(key(c))))
        && seats.every(s => JSON.stringify(cue.transition!.before.players[s].base) === JSON.stringify(cue.transition!.after.players[s].base));
}

/** A declared creation has no physical hand/deck origin and never borrows a played entry. */
function creationProof(cue: CardEffectCue, g: Geometry, count: number, simultaneous = false) {
    if (!cue.transition || !Number.isInteger(count) || count < 0) return;
    const items = g.outcomes.filter(i => i.outcome.kind === 'create'), before = refs(cue.transition.before), after = refs(cue.transition.after);
    if (items.length !== count || new Set(items.map(i => key(i.outcome.card))).size !== count) return;
    const group = items[0]?.outcome.resolutionGroup;
    if (simultaneous && count && (!group?.id || group.mode !== 'simultaneous')) return;
    for (const item of items) {
        const o = item.outcome, u = o.unit, end = unitIn(cue, o.card, cue.seat, true);
        if (o.prevented || o.seat !== cue.seat || o.ownerSeat !== cue.seat || o.zone !== 'ground' || o.amount !== 1 || o.tokenType !== 'battle-droid' || o.entryType !== 'created' || o.entersReady !== false || o.fromZone || o.fromSeat || o.basis || o.requiresDefeat || o.requiresReturn || !sourceProof(cue, o)
            || !u?.id || !u.incarnation || !fullUnit(o.card) || !exactUnit(u, o.card) || o.incarnation !== u.incarnation || u.t !== 1 || u.n !== 'Battle Droid' || u.s !== null || u.owner !== cue.seat || u.p !== 1 || u.h !== 1 || u.d !== 0 || u.x !== 1 || u.sn || u.u?.length || u.cap?.length || u.status?.length
            || before.some(c => same(c, u)) || !end || !exactUnit(u, end) || cue.transition.after.players[cue.seat].ground.filter(c => same(c, u)).length !== 1 || after.filter(c => same(c, u)).length !== 1
            || simultaneous && JSON.stringify(o.resolutionGroup) !== JSON.stringify(group)) return;
    }
    return items;
}

function departureProof(cue: CardEffectCue, item: PlacedOutcome | undefined): Departure | undefined {
    const o = item?.outcome;
    if (!item || !o || o.kind !== 'defeat' || o.prevented || !cue.transition || !fullUnit(o.card) || !sourceProof(cue, o) || !o.incarnation || !o.ownerSeat) return;
    const old = unitIn(cue, o.card, o.seat), leader = !!old && seats.some(s => cue.transition!.before.players[s].leader?.dep === 1 && same(cue.transition!.before.players[s].leader, old));
    if (!old || !exactUnit(old, o.card) || old.incarnation !== o.incarnation || old.owner !== o.ownerSeat || old.cap?.length || seats.some(s => units(cue, s, true).some(c => same(c, old)))) return;
    if (leader) {
        const summary = cue.transition.before.players[o.ownerSeat].leader, end = cue.transition.after.players[o.ownerSeat].leader;
        if (o.zone !== 'leader' || !summary || !end || !o.leader || !refEqual(summary, old) || !refEqual(end, summary) || end.dep !== 0 || end.x !== 1 || end.epic !== summary.epic || JSON.stringify(end) !== JSON.stringify(o.leader) || seats.some(s => cue.transition!.after.players[s].discard.some(c => same(c, old)))) return;
    } else if (old.t === 1) {
        if (refs(cue.transition.after).some(c => same(c, old))) return;
    } else if (cue.transition.after.players[o.ownerSeat].discard.filter(c => refEqual(c, old)).length !== 1 || seats.some(s => s !== o.ownerSeat && cue.transition!.after.players[s].discard.some(c => same(c, old)))) return;
    for (const up of old.u ?? []) if (!up.owner || !up.t && cue.transition.after.players[up.owner].discard.filter(c => refEqual(c, up)).length !== 1 || up.t && refs(cue.transition.after).some(c => same(c, up))) return;
    return { item, old, leader };
}

function remainingArena(cue: CardEffectCue, changed: CardRef[], created: PlacedOutcome[] = []) {
    const removed = new Set(changed.map(key));
    return seats.every(s => {
        const old = units(cue, s).filter(c => !removed.has(key(c))), extra = created.filter(i => i.outcome.seat === s).map(i => i.outcome.unit!);
        return units(cue, s, true).length === old.length + extra.length && old.every(u => { const end = unitIn(cue, u, s, true); return !!end && exactUnit(u, end); });
    });
}
function deckUnchanged(cue: CardEffectCue) { return !!cue.transition && seats.every(s => cue.transition!.before.players[s].deck === cue.transition!.after.players[s].deck && ordered(cue.transition!.before.players[s].knownDeck ?? [], cue.transition!.after.players[s].knownDeck ?? [])); }

function healProof(cue: CardEffectCue, g: Geometry) {
    if (!eventProof(cue) || !cue.transition) return;
    const matches = g.outcomes.filter(i => i.outcome.kind === 'heal'), item = matches[0], o = item?.outcome;
    if (matches.length !== 1 || !o || o.prevented || !fullUnit(o.card) || !sourceProof(cue, o) || !['ground', 'space'].includes(o.zone ?? '') || !o.resolutionGroup?.id || o.resolutionGroup.mode !== 'simultaneous') return;
    const old = unitIn(cue, o.card, o.seat), end = unitIn(cue, o.card, o.seat, true);
    if (!old || !end || !exactUnit(old, o.card) || !samePose(old, end) || o.amount !== Math.min(3, old.d) || end.d !== old.d - o.amount || !deckUnchanged(cue)) return;
    return { item, old, end };
}
function deathProof(cue: CardEffectCue, g: Geometry) {
    if (!eventProof(cue)) return;
    const matches = g.outcomes.filter(i => i.outcome.kind === 'defeat'), r = matches.length === 1 ? departureProof(cue, matches[0]) : undefined;
    if (!r || printedCost(r.old) === undefined || printedCost(r.old)! > 3 || r.item.outcome.printedCost !== printedCost(r.old) || !r.item.outcome.resolutionGroup?.id || r.item.outcome.resolutionGroup.mode !== 'simultaneous' || !deckUnchanged(cue)) return;
    return r;
}
function independentCreates(cue: CardEffectCue, g: Geometry, count: number) {
    return eventProof(cue) && deckUnchanged(cue) ? creationProof(cue, g, count, true) : undefined;
}

function invasionProof(cue: CardEffectCue, g: Geometry) {
    if (!eventProof(cue, true) || !cue.transition || cue.playPayment?.kind !== 'resources' || !deckUnchanged(cue)) return;
    const selected = cue.playPayment.exploit?.units ?? [], enemy: Seat = cue.seat === 'p1' ? 'p2' : 'p1';
    if (selected.length > 4 || new Set(selected.map(u => u.id)).size !== selected.length || cue.playPayment.exploit && cue.playPayment.exploit.sourceId !== cue.source?.id) return;
    const prefix = g.outcomes.slice(0, selected.length), costs = g.outcomes.filter(i => i.outcome.kind === 'cost'), gate = costs[0], targetUnits = units(cue, enemy), rest = g.outcomes.slice(selected.length + 1);
    if (costs.length !== 1 || g.outcomes[selected.length] !== gate || gate.outcome.prevented || gate.outcome.amount !== -2 * selected.length || gate.outcome.seat !== cue.seat || !refEqual(gate.outcome.card, cue.source) || !sourceProof(cue, gate.outcome) || rest.length !== targetUnits.length) return;
    const sacrifices: Departure[] = [], targets: Departure[] = [];
    for (const [i, choice] of selected.entries()) {
        const d = departureProof(cue, prefix[i]);
        if (!d || d.item.outcome.paymentRole !== 'exploit' || d.item.outcome.seat !== cue.seat || d.old.id !== choice.id || d.old.incarnation !== choice.incarnation) return;
        sacrifices.push(d);
    }
    for (const old of targetUnits) {
        const matches = rest.filter(i => same(i.outcome.card, old)), d = matches.length === 1 ? departureProof(cue, matches[0]) : undefined;
        if (!d || d.item.outcome.seat !== enemy || d.item.outcome.selection !== 'all' || d.item.outcome.paymentRole) return;
        targets.push(d);
    }
    if (!remainingArena(cue, [...sacrifices, ...targets].map(d => d.old))) return;
    return { sacrifices, targets, gate, enemy, items: [...prefix, gate, ...rest] };
}

function reprocessProof(cue: CardEffectCue, g: Geometry) {
    if (!eventProof(cue) || !cue.transition) return;
    const witness = g.outcomes.find(i => i.outcome.chosenUnitGroup && i.outcome.cards), chosen = witness?.outcome.cards, group = witness?.outcome.chosenUnitGroup;
    if (!chosen || !group || chosen.length > 4 || new Set(chosen.map(key)).size !== chosen.length) return;
    const before = cue.transition.before.players[cue.seat], after = cue.transition.after.players[cue.seat];
    if (chosen.some(c => !c.id || !c.s || printed[c.s] === undefined || c.owner !== cue.seat || before.discard.filter(d => refEqual(c, d)).length !== 1 || same(c, cue.source))) return;
    const creates = creationProof(cue, g, chosen.length);
    if (!creates || g.outcomes.some(i => i.outcome.chosenUnitGroup !== group || !ordered(i.outcome.cards ?? [], chosen))) return;
    const moves = g.outcomes.filter(i => i.outcome.kind === 'recover'), successful: PlacedOutcome[] = [];
    if (moves.length !== chosen.length || new Set(moves.map(i => key(i.outcome.card))).size !== chosen.length || g.outcomes.length !== moves.length + creates.length) return;
    for (const item of moves) {
        const o = item.outcome;
        if (!o.card || !chosen.some(c => refEqual(c, o.card)) || !sourceProof(cue, o) || o.seat !== cue.seat || o.zone !== 'deck' || o.destination !== 'deck-bottom' || o.fromZone && o.fromZone !== 'discard' || o.fromSeat && o.fromSeat !== cue.seat) return;
        if (o.prevented) { if (after.discard.filter(c => refEqual(c, o.card)).length !== 1) return; }
        else { if (after.discard.some(c => same(c, o.card))) return; successful.push(item); }
    }
    const deckBefore = before.knownDeck ?? [], deckAfter = after.knownDeck ?? [];
    if (before.deck !== deckBefore.length || after.deck !== before.deck + successful.length || !ordered(deckAfter, [...deckBefore, ...successful.map(i => i.outcome.card!)])) return;
    const removed = successful.map(i => i.outcome.card!), expectedDiscard = [...before.discard.filter(c => !removed.some(r => same(c, r))), cue.source!];
    if (!ordered(after.discard, expectedDiscard) || !remainingArena(cue, [], creates)) return;
    const other: Seat = cue.seat === 'p1' ? 'p2' : 'p1';
    if (cue.transition.before.players[other].deck !== cue.transition.after.players[other].deck || !ordered(cue.transition.before.players[other].knownDeck ?? [], cue.transition.after.players[other].knownDeck ?? [])) return;
    return { chosen, creates, moves: successful, group, items: [...successful, ...creates], before, after };
}

function consolidationProof(cue: CardEffectCue, g: Geometry) {
    if (!eventProof(cue) || !cue.transition || !deckUnchanged(cue)) return;
    const witness = g.outcomes.find(i => i.outcome.chosenUnits && i.outcome.chosenUnitGroup), choices = witness?.outcome.chosenUnits, group = witness?.outcome.chosenUnitGroup;
    if (!choices || !group || new Set(choices.map(c => c.id)).size !== choices.length || g.outcomes.some(i => i.outcome.chosenUnitGroup !== group || JSON.stringify(i.outcome.chosenUnits) !== JSON.stringify(choices))) return;
    const selected: UnitRef[] = [];
    for (const choice of choices) {
        const old = units(cue, cue.seat).find(c => c.id === choice.id && c.incarnation === choice.incarnation);
        if (!old || choice.power !== old.p || old.p < 0) return; selected.push(old);
    }
    const sum = selected.reduce((n, u) => n + u.p, 0), plays = g.outcomes.filter(i => i.outcome.kind === 'play'), pays = g.outcomes.filter(i => i.outcome.kind === 'pay'), deaths = g.outcomes.filter(i => i.outcome.kind === 'defeat'), departures: Departure[] = [];
    if (plays.length > 1 || pays.length !== plays.length || deaths.length !== selected.length || g.outcomes.length !== deaths.length + plays.length + pays.length) return;
    for (const old of selected) {
        const matching = deaths.filter(i => same(i.outcome.card, old)), d = matching.length === 1 ? departureProof(cue, matching[0]) : undefined;
        if (!d || d.item.outcome.seat !== cue.seat || d.item.outcome.paymentRole) return; departures.push(d);
    }
    const play = plays[0], pay = pays[0], o = play?.outcome;
    let arrival: UnitRef | undefined;
    if (play && pay && o) {
        const actual = cue.transition.before.players[cue.seat].hand.find(c => refEqual(c, o.card)), unit = o.unit, facts = actual?.s ? entering[actual.s] : undefined;
        arrival = unitIn(cue, o.card, cue.seat, true);
        if (o.prevented || pay.outcome.prevented || o.playAs && o.playAs !== 'unit' || !sourceProof(cue, o) || o.seat !== cue.seat || o.ownerSeat !== cue.seat || o.fromSeat !== cue.seat || o.fromZone !== 'hand' || o.entryType !== 'played' || o.entersReady !== false || !actual || actual.owner !== cue.seat || !facts || actual.n !== facts.name || o.printedCost !== printed[actual.s!] || o.printedCost! > sum || !unit?.incarnation || !arrival || !exactUnit(unit, arrival) || !refEqual(unit, actual) || unit.p !== facts.p || unit.h !== facts.h || unit.d !== 0 || unit.x !== 1 || unit.t || unit.u?.length || unit.cap?.length || unit.status?.length || o.zone !== facts.zone || selected.some(c => same(c, unit))
            || pay.outcome.amount !== 0 || pay.outcome.seat !== cue.seat || pay.outcome.zone !== 'resources' || !refEqual(pay.outcome.card, actual) || !refEqual(pay.outcome.sourceCard, actual) || pay.outcome.cards?.length !== 0 || cue.transition.after.players[cue.seat].hand.some(c => same(c, actual))
            || g.outcomes.indexOf(pay) >= g.outcomes.indexOf(play) || deaths.some(d => g.outcomes.indexOf(d) <= g.outcomes.indexOf(play))) return;
    }
    const arrivals = play ? [play] : [];
    if (!remainingArena(cue, selected, arrivals)) return;
    return { choices, selected, sum, departures, play, pay, arrival, items: g.outcomes };
}

/** These same predicates select rich rendering and generic receipt suppression. */
export function batchA09Covers(cue: CardEffectCue, g: Geometry, item: PlacedOutcome): boolean {
    switch (cue.definition.id) {
        case 'grievous-reassembly': return item === healProof(cue, g)?.item || independentCreates(cue, g, 1)?.includes(item) === true;
        case 'death-by-droids': return item === deathProof(cue, g)?.item || independentCreates(cue, g, 2)?.includes(item) === true;
        case 'the-invasion-of-christophsis': return invasionProof(cue, g)?.items.includes(item) ?? false;
        case 'reprocess': return reprocessProof(cue, g)?.items.includes(item) ?? false;
        case 'consolidation-of-power': return consolidationProof(cue, g)?.items.includes(item) ?? false;
        default: return false;
    }
}

function Receipt({ at, rows, p, start = .72, until, color = '#d4dac0' }: { at: EffectBox; rows: string[]; p: number; start?: number; until?: number; color?: string }) {
    const w = Math.min(244, Math.max(80, ...rows.map(r => r.length * 4.8 + 18))), h = rows.length * 16 + 8;
    return <ScreenPixels at={bounded(at, w, h)} color={color} opacity={visible(p, start) * (until ? 1 - phase(p, until - .05, until) : 1)}><rect x={-w / 2} y={-h / 2} width={w} height={h} rx="4" fill="#08111e" fillOpacity=".97" strokeWidth="1" />{rows.map((r, i) => <text key={i} y={-h / 2 + 14 + i * 16} textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '700 9px var(--font-display,sans-serif)' }}>{r}</text>)}</ScreenPixels>;
}
function Mask({ at, p, start }: { at: EffectBox; p: number; start: number }) { const s = size(at); return <ScreenPixels at={at} opacity={visible(p, start)}><rect x={-s.w / 2 - 4} y={-s.h / 2 - 4} width={s.w + 8} height={s.h + 8} rx="5" fill="#0b1420" stroke="none" /></ScreenPixels>; }
function Travel({ from, to, card, p, start, end, back = false, hold = false, exhausted = false, corridor, approach }: { from: EffectBox; to: EffectBox; card: CardRef; p: number; start: number; end: number; back?: boolean; hold?: boolean; exhausted?: boolean; corridor?: number; approach?: EffectBox }) {
    if (p < start) return null;
    const t = easeInOut(phase(p, start, end)), mid = shift({ ...from, ...mix(from, to, .5) }, 22, -30), at = corridor === undefined ? { ...from, x: (1 - t) ** 2 * from.x + 2 * (1 - t) * t * mid.x + t * t * to.x, y: (1 - t) ** 2 * from.y + 2 * (1 - t) * t * mid.y + t * t * to.y } : { ...from, x: t < .22 ? from.x + (corridor - from.x) * easeInOut(t / .22) : t < .8 ? corridor : corridor + (to.x - corridor) * easeInOut((t - .8) / .2), y: t < .22 ? from.y : t < .8 ? from.y + (to.y - from.y) * easeInOut((t - .22) / .58) : to.y }, a = size(from), b = hold ? size(to) : { w: 20, h: 28 };
    const first = { ...from, x: corridor ?? from.x }, last = { ...(approach ?? to), x: corridor ?? to.x };
    const position = corridor !== undefined && approach ? { ...from, ...(t < .18 ? mix(from, first, easeInOut(t / .18)) : t < .65 ? mix(first, last, easeInOut((t - .18) / .47)) : t < .88 ? mix(last, approach, easeInOut((t - .65) / .23)) : mix(approach, to, easeInOut((t - .88) / .12))) } : at;
    return <><path d={corridor === undefined ? 'M' + from.x + ' ' + from.y + ' Q' + mid.x + ' ' + mid.y + ' ' + to.x + ' ' + to.y : 'M' + from.x + ' ' + from.y + ' L' + corridor + ' ' + from.y + ' L' + corridor + ' ' + (approach?.y ?? to.y) + ' L' + to.x + ' ' + (approach?.y ?? to.y) + (approach ? ' L' + to.x + ' ' + to.y : '')} stroke="#bdcbb6" strokeWidth="1.5" opacity={envelope(p, start, start + .04, end + .1)} /><ScreenPixels at={position} opacity={hold ? visible(p, start) : visible(p, start) * (1 - phase(p, end, end + .075))}><g transform={'rotate(' + (exhausted ? 10 : 5 * Math.sin(t * Math.PI)) + ')' + (exhausted ? ' scale(.94)' : '')}><CardGhost card={card} back={back && t > .5} box={{ w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t }} /></g></ScreenPixels></>;
}
function Payment({ cue, geometry: g, p, start = .04, end = .22 }: Props & { start?: number; end?: number }) {
    const before = cue.transition!.before.players[cue.seat], paid = cue.playPayment?.kind === 'resources' ? cue.playPayment.cardIds! : [];
    return <>{before.resources!.map((r, i) => { const at = g.resourceCards?.[cue.seat + ':' + key(r)]; return at && paid.includes(key(r)) ? <ResourceSlot key={key(r)} at={at} index={i} spent p={p} start={start} /> : null; })}<ResourceBalance at={g.zones[cue.seat + ':resources']} countAt={g.zones[cue.seat + ':resource-count']} ready={before.res.ready - paid.length} total={before.res.total} p={p} start={start} /><Mask at={g.source} p={p} start={start} /><Travel from={{ ...g.source, cardSize: { w: 20, h: 28 } }} to={g.zones[cue.seat + ':discard']} card={cue.source!} p={p} start={start} end={end} corridor={16 / (g.source.sx ?? 1)} approach={shift(g.zones[cue.seat + ':discard'], 0, g.source.y > g.zones[cue.seat + ':discard'].y ? 24 : -24)} /></>;
}
function Stats({ at, unit, p, start }: { at: EffectBox; unit: UnitRef; p: number; start: number }) {
    const s = size(at);
    return <>{(['power', 'hp'] as const).map((name, i) => { const pos = at.counters?.[name]; return <ScreenPixels key={name} at={pos ? { ...at, ...pos } : shift(at, (i ? 1 : -1) * (s.w / 2 - 11), s.h / 2 - 12)} opacity={visible(p, start)}><rect x="-11" y="-12" width="22" height="24" rx="3" fill={i ? '#174772' : '#8b2936'} stroke="#e6e6cc" /><text y="4" textAnchor="middle" fill="#fff" stroke="none" style={{ font: '800 14px sans-serif' }}>{i ? Math.max(0, unit.h - unit.d) : unit.p}</text></ScreenPixels>; })}{unit.sn === 1 && <ScreenPixels at={shift(at, -s.w / 2 + 17, -s.h / 2 + 10)} opacity={visible(p, start)}><rect x="-13" y="-8" width="26" height="16" rx="3" fill="#e9eef8" stroke="none" /><text y="3" textAnchor="middle" fill="#1d2a44" stroke="none" style={{ font: '800 8px sans-serif' }}>SEN</text></ScreenPixels>}</>;
}
function DepartureVisual({ departure: d, geometry: g, p, start, end }: { departure: Departure; geometry: Geometry; p: number; start: number; end: number }) {
    const at = g.cards?.[d.item.outcome.seat + ':' + key(d.old)] ?? d.item.box;
    return <><Mask at={at} p={p} start={start} />{(d.old.u ?? []).map(up => { const chip = g.cards?.[d.item.outcome.seat + ':' + key(up)]; return chip ? <g key={key(up)}><AttachmentMask at={chip} p={p} start={start} />{!up.t && up.owner && <Travel from={{ ...chip, cardSize: { w: 32, h: 45 } }} to={g.zones[up.owner + ':discard']} card={up} p={p} start={start} end={end} />}</g> : null; })}{d.old.t ? <ScreenPixels at={at} color="#d4caa1" opacity={envelope(p, start, start + .055, end)}>{Array.from({ length: 7 }, (_, i) => <rect key={i} x={Math.cos(i * Math.PI * 2 / 7) * 24 * phase(p, start, end)} y={Math.sin(i * Math.PI * 2 / 7) * 24 * phase(p, start, end)} width="5" height="5" fill="currentColor" stroke="none" />)}<text y="-15" textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '700 7px sans-serif' }}>TOKEN CEASES</text></ScreenPixels> : <Travel from={at} to={d.item.to} card={d.old} p={p} start={start} end={end} exhausted={d.leader} />}</>;
}
function Assemblies({ items, p, start = .28, end = .62 }: { items: PlacedOutcome[]; p: number; start?: number; end?: number }) {
    return <>{items.map((item, i) => <TokenAssembly key={key(item.outcome.card)} at={item.to} unit={item.outcome.unit!} p={p} start={start + i * .018} end={end + i * .018} />)}</>;
}
function SettleSurvivors({ cue, geometry: g, p, start, end, excluded = [], intermediate = false }: Props & { start: number; end: number; excluded?: CardRef[]; intermediate?: boolean }) {
    return <>{seats.flatMap(s => units(cue, s, true).filter(u => !excluded.some(c => same(c, u)) && units(cue, s).some(c => same(c, u))).map(u => {
        const from = g.cards?.[s + ':' + key(u)], to = (intermediate ? g.intermediateCards?.[s + ':' + key(u)] : undefined) ?? g.endingCards?.[s + ':' + key(u)];
        if (!from || !to || Math.abs(from.x - to.x) < .2 && Math.abs(from.y - to.y) < .2) return null;
        return <g key={s + ':' + key(u)}><Mask at={from} p={p} start={start} /><Travel from={from} to={to} card={u} p={p} start={start} end={end} hold exhausted={u.x === 1} /><Stats at={{ ...from, ...mix(from, to, easeInOut(phase(p, start, end))), counters: undefined }} unit={u} p={p} start={start} /></g>;
    }))}</>;
}
function Reassembly(props: Props) {
    const { cue, geometry: g, p } = props, heal = healProof(cue, g), creates = independentCreates(cue, g, 1); if (!heal && !creates) return eventProof(cue) ? <Payment {...props} /> : null;
    return <><Payment {...props} />{heal && <><ScreenPixels at={heal.item.box} color="#a8dbc3" opacity={envelope(p, .23, .32, .61)}><CountedMarks count={Number(heal.item.outcome.amount)} gap={12} color="#a8dbc3" /><path d="M-29 -12 H29 M-29 12 H29" strokeWidth="2" /></ScreenPixels><Stats at={heal.item.box} unit={heal.end} p={p} start={.49} /></>}{creates && <Assemblies items={creates} p={p} />}<Receipt at={center(g)} rows={[...(heal ? ['HEAL ' + heal.item.outcome.amount + ' · WOUNDS ' + heal.old.d + ' → ' + heal.end.d] : []), ...(creates ? ['CREATE 1 BATTLE DROID · EXHAUSTED'] : []), 'INDEPENDENT RESULTS']} p={p} start={.73} /></>;
}
function Death(props: Props) {
    const { cue, geometry: g, p } = props, death = deathProof(cue, g), creates = independentCreates(cue, g, 2); if (!death && !creates) return eventProof(cue) ? <Payment {...props} /> : null;
    return <><Payment {...props} />{death && <><Receipt at={center(g)} rows={['PRINTED COST ' + printedCost(death.old) + ' ≤ 3', 'ONE UNIT DEFEATED']} p={p} start={.06} until={.27} /><DepartureVisual departure={death} geometry={g} p={p} start={.28} end={.57} /></>}{death && <SettleSurvivors {...props} start={.4} end={.61} />}{creates && <Assemblies items={creates} p={p} start={.28} end={.61} />}<Receipt at={center(g)} rows={[...(death ? [death.old.t ? 'TARGET TOKEN CEASES' : 'TARGET → OWNER ' + death.old.owner!.toUpperCase() + (death.leader ? ' LEADER' : ' DISCARD')] : []), ...(creates ? ['CREATE 2 BATTLE DROIDS · EXHAUSTED'] : []), 'INDEPENDENT RESULTS']} p={p} start={.75} /></>;
}
function Invasion(props: Props) {
    const { cue, geometry: g, p } = props, r = invasionProof(cue, g); if (!r) return null;
    return <><Receipt at={center(g)} rows={['EXPLOIT ' + r.sacrifices.length + ' CONTROLLED UNITS', '15 − ' + 2 * r.sacrifices.length + ' = ' + cue.playCost]} p={p} start={.05} until={.4} />{r.sacrifices.map((d, i) => <DepartureVisual key={key(d.old)} departure={d} geometry={g} p={p} start={.14 + i * .015} end={.32 + i * .015} />)}<Payment {...props} start={.38} end={.51} /><SettleSurvivors {...props} start={.39} end={.57} intermediate /><Receipt at={center(g)} rows={['PAY ' + cue.playCost + ' · THEN RESOLVE', r.enemy.toUpperCase() + ' UNITS · BOTH ARENAS']} p={p} start={.4} until={.62} />{r.targets.map((d, i) => <DepartureVisual key={key(d.old)} departure={d} geometry={g} p={p} start={.56 + i * .012} end={.78 + i * .012} />)}<Receipt at={center(g)} rows={['OPPONENT UNITS DEFEATED', ...(r.targets.some(d => d.leader) ? ['LEADER UNDEPLOYED · EPIC STAYS SPENT'] : []), 'OWN SURVIVORS / BASES STAY']} p={p} start={.85} /></>;
}
function Reprocess(props: Props) {
    const { cue, geometry: g, p } = props, r = reprocessProof(cue, g); if (!r) return eventProof(cue) ? <Payment {...props} /> : null;
    return <><Payment {...props} /><Receipt at={center(g)} rows={['CHOOSE ' + r.chosen.length + ' OWN DISCARD UNITS', 'RANDOM ORDER → DECK BOTTOM']} p={p} start={.07} until={.47} />{r.moves.map((item, i) => <Travel key={key(item.outcome.card)} from={shift(item.from, (i - (r.moves.length - 1) / 2) * 24, -5)} to={item.to} card={item.outcome.card!} p={p} start={.26 + i * .035} end={.48 + i * .035} back />)}<Assemblies items={r.creates} p={p} start={.5} end={.73} /><Receipt at={center(g)} rows={['SELECTED ' + r.chosen.length + ' → ' + r.creates.length + ' NEW DROIDS', 'EXHAUSTED TOKEN ENTRIES', 'DECK ' + r.before.deck + ' → ' + r.after.deck]} p={p} start={.81} /></>;
}
function Consolidation(props: Props) {
    const { cue, geometry: g, p } = props, r = consolidationProof(cue, g); if (!r) return eventProof(cue) ? <Payment {...props} /> : null;
    const to = r.play ? g.intermediateCards?.[cue.seat + ':' + key(r.play.outcome.card)] ?? r.play.to : undefined, final = r.play?.to;
    const selectedPower = r.selected.map(u => String(u.p)).join(' + ') || '0';
    return <><Payment {...props} /><Receipt at={center(g)} rows={['CHOSEN POWER ' + selectedPower + ' = ' + r.sum, r.play ? 'PRINTED ' + r.play.outcome.printedCost + ' ≤ ' + r.sum + ' · FREE PLAY 0' : 'NO UNIT PLAYED · SACRIFICE STILL RESOLVES']} p={p} start={.06} until={.4} />{r.selected.map(u => { const at = g.cards?.[cue.seat + ':' + key(u)]; return at ? <ScreenPixels key={key(u)} at={shift(at, 0, -size(at).h / 2 - 17)} opacity={envelope(p, .11, .18, .47)} color="#e6d0ab"><rect x="-15" y="-11" width="30" height="22" rx="3" fill="#151925" /><text y="4" textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '800 14px sans-serif' }}>{u.p}</text></ScreenPixels> : null; })}
        {r.departures.map((d, i) => <DepartureVisual key={key(d.old)} departure={d} geometry={g} p={p} start={.55 + i * .015} end={.75 + i * .015} />)}
        <SettleSurvivors {...props} start={.7} end={.84} excluded={r.arrival ? [r.arrival] : []} />
        {r.play && r.arrival && to && final && <><Mask at={r.play.from} p={p} start={.3} /><Travel from={r.play.from} to={to} card={r.arrival} p={p} start={.3} end={.49} hold exhausted /><Stats at={to} unit={r.arrival} p={p} start={.49} />{p >= .69 && <><Mask at={to} p={p} start={.69} /><Travel from={to} to={final} card={r.arrival} p={p} start={.69} end={.84} hold exhausted /><Stats at={{ ...to, ...mix(to, final, easeInOut(phase(p, .69, .84))), counters: undefined }} unit={r.arrival} p={p} start={.69} /></>}</>}
        <Receipt at={center(g)} rows={['THEN DEFEAT ORIGINAL CHOSEN UNITS', 'NEW ARRIVAL IS NOT CHOSEN']} p={p} start={.5} until={.7} /><Receipt at={center(g)} rows={[r.play ? 'NEW UNIT STAYS · EXHAUSTED' : 'NO UNIT PLAYED · CHOSEN SET DEFEATED', r.departures.length + ' ORIGINAL UNITS → OWNER DESTINATIONS']} p={p} start={.86} /></>;
}
export function BatchA09Signature(props: Props) {
    switch (props.cue.definition.id) { case 'grievous-reassembly': return <Reassembly {...props} />; case 'death-by-droids': return <Death {...props} />; case 'the-invasion-of-christophsis': return <Invasion {...props} />; case 'reprocess': return <Reprocess {...props} />; case 'consolidation-of-power': return <Consolidation {...props} />; default: return null; }
}
