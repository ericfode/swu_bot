import type { CardRef, ResourceRef, Seat, UnitRef } from '../data/types';
import type { CardEffectCue, CardEffectOutcome } from './types';
import { previewPlayCost } from './previewCosts';
import { easeInOut, envelope, phase } from './animationTimeline';
import { AttachmentMask, CardGhost, CountedMarks, ResourceBalance, ResourceSlot, ScreenPixels, UpgradePlay, mix, screenShift as shift, type EffectBox, type PlacedOutcome } from './primitives';

type Geometry = { source: EffectBox; target: EffectBox; friendlyBase: EffectBox; outcomes: PlacedOutcome[]; zones: Record<string, EffectBox>; cards?: Record<string, EffectBox>; endingCards?: Record<string, EffectBox>; pockets?: Record<string, EffectBox>; endingPockets?: Record<string, EffectBox>; endingCaptured?: Record<string, EffectBox>; resourceCards?: Record<string, EffectBox>; endingResources?: Record<string, EffectBox> };
type Props = { cue: CardEffectCue; geometry: Geometry; p: number };
const ids = new Set(['relentless-pursuit', 'altering-the-deal', 'smugglers-aid', 'a-fine-addition', 'lethal-crackdown']);
export const isBatchA08 = (cue: CardEffectCue) => ids.has(cue.definition.id);
const seats: Seat[] = ['p1', 'p2'];
const key = (card?: CardRef | null) => card?.id ?? `${card?.s ?? ''}:${card?.n ?? ''}`;
const same = (a?: CardRef | null, b?: CardRef | null) => !!a && !!b && !!a.id && a.id === b.id;
const refEqual = (a?: CardRef | null, b?: CardRef | null) => same(a, b) && a?.n === b?.n && a?.s === b?.s && a?.owner === b?.owner;
const ordered = (a: CardRef[], b: CardRef[]) => a.length === b.length && a.every((card, i) => refEqual(card, b[i]));
const num = (outcome: CardEffectOutcome) => typeof outcome.amount === 'number' ? outcome.amount : NaN;
const units = (cue: CardEffectCue, seat: Seat, after = false) => [...(cue.transition?.[after ? 'after' : 'before'].players[seat].ground ?? []), ...(cue.transition?.[after ? 'after' : 'before'].players[seat].space ?? [])];
const unitIn = (cue: CardEffectCue, card: CardRef | null | undefined, seat: Seat, after = false) => units(cue, seat, after).find(unit => same(unit, card));
const fullUnit = (card?: CardRef | null): card is UnitRef => !!card && 'p' in card && 'h' in card && 'd' in card;
const statsEqual = (a: UnitRef, b: UnitRef) => refEqual(a, b) && a.incarnation === b.incarnation && a.p === b.p && a.h === b.h && a.d === b.d && !!a.x === !!b.x;
const poseEqual = (a: UnitRef, b: UnitRef) => a.incarnation === b.incarnation && a.owner === b.owner && a.d === b.d && !!a.x === !!b.x && JSON.stringify(a.status ?? []) === JSON.stringify(b.status ?? []);
const isLeader = (cue: CardEffectCue, unit: UnitRef) => seats.some(seat => same(cue.transition?.before.players[seat].leader, unit));
const size = (at: EffectBox) => at.cardSize ?? { w: at.w * (at.sx ?? 1), h: at.h * (at.sy ?? 1) };
const visible = (p: number, start: number) => phase(p, start, start + .045);
const bounded = (at: EffectBox, width = 220, height = 40): EffectBox => ({ ...at, x: Math.max((width / 2 + 8) / (at.sx ?? 1), Math.min(1000 - (width / 2 + 8) / (at.sx ?? 1), at.x)), y: Math.max((height / 2 + 40) / (at.sy ?? 1), Math.min(600 - (height / 2 + 120) / (at.sy ?? 1), at.y)) });
const center = (g: Geometry) => { const top = g.zones['p2:ground'], base = g.zones['p1:base']; return bounded({ ...g.source, x: 500, y: top && base ? (top.y + top.h / 2 + base.y - base.h / 2) / 2 : 300 }); };
function Receipt({ at, rows, p, start = .7, until, color = '#dce7ef' }: { at: EffectBox; rows: string[]; p: number; start?: number; until?: number; color?: string }) {
    const width = Math.min(244, Math.max(70, ...rows.map(row => row.length * 4.8 + 18))), height = rows.length * 16 + 8;
    return <ScreenPixels at={bounded(at, width, height)} opacity={visible(p, start) * (until ? 1 - phase(p, until - .06, until) : 1)} color={color}><rect x={-width / 2} y={-height / 2} width={width} height={height} rx="4" fill="#08111e" fillOpacity=".97" strokeWidth="1" />{rows.map((row, i) => <text key={i} x="0" y={-height / 2 + 14 + i * 16} textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '700 9px var(--font-display,sans-serif)' }}>{row}</text>)}</ScreenPixels>;
}
function Mask({ at, p, start }: { at: EffectBox; p: number; start: number }) { const s = size(at); return <ScreenPixels at={at} opacity={visible(p, start)}><rect x={-s.w / 2 - 4} y={-s.h / 2 - 4} width={s.w + 8} height={s.h + 8} rx="4" fill="#0b1420" stroke="none" /></ScreenPixels>; }
function Travel({ from, to, card, p, start, end, back = false, pocket = false, hold = false, portrait = false, corridor }: { from: EffectBox; to: EffectBox; card: CardRef; p: number; start: number; end: number; back?: boolean; pocket?: boolean; hold?: boolean; portrait?: boolean; corridor?: number }) {
    if (p < start) return null;
    const t = easeInOut(phase(p, start, end)), middle = shift({ ...from, ...mix(from, to, .5) }, 26, -32);
    const at = corridor === undefined ? { ...from, x: (1 - t) ** 2 * from.x + 2 * (1 - t) * t * middle.x + t * t * to.x, y: (1 - t) ** 2 * from.y + 2 * (1 - t) * t * middle.y + t * t * to.y }
        : { ...from, x: t < .22 ? from.x + (corridor - from.x) * easeInOut(phase(t, 0, .22)) : t < .8 ? corridor : corridor + (to.x - corridor) * easeInOut(phase(t, .8, 1)),
            y: t < .22 ? from.y : t < .8 ? from.y + (to.y - from.y) * easeInOut(phase(t, .22, .8)) : to.y };
    const a = portrait ? { w: 32, h: 45 } : from.cardSize ?? { w: 28, h: 39 }, b = pocket ? size(to) : { w: 20, h: 28 };
    const route = corridor === undefined ? 'M' + from.x + ' ' + from.y + ' Q' + middle.x + ' ' + middle.y + ' ' + to.x + ' ' + to.y
        : 'M' + from.x + ' ' + from.y + ' L' + corridor + ' ' + from.y + ' L' + corridor + ' ' + to.y + ' L' + to.x + ' ' + to.y;
    return <><path d={route} stroke="#b9cbd7" strokeWidth="1.5" opacity={envelope(p, start, start + .03, end + .1)} /><ScreenPixels at={at} opacity={hold ? 1 : 1 - phase(p, end, end + .08)}><g transform={`rotate(${Math.sin(t * Math.PI) * 6})`}><CardGhost card={card} back={back || pocket && t > .45} box={{ w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t }} /></g></ScreenPixels></>;
}
function Counter({ at, value, label, p, start }: { at: EffectBox; value: number; label: string; p: number; start: number }) { return <ScreenPixels at={at} opacity={visible(p, start)}><rect x="-17" y="-14" width="34" height="28" rx="4" fill="#0b1523" stroke="#e3d1b0" /><text y="3" textAnchor="middle" fill="#f4e5c8" stroke="none" style={{ font: '800 16px sans-serif' }}>{value}</text><text y="11" textAnchor="middle" fill="#e3d1b0" stroke="none" style={{ font: '700 5px sans-serif' }}>{label}</text></ScreenPixels>; }
function Stats({ at, unit, p, start }: { at: EffectBox; unit: UnitRef; p: number; start: number }) { const s = size(at); return <>{(['power', 'hp'] as const).map((name, i) => { const counter = at.counters?.[name]; return <Counter key={name} at={counter ? { ...at, ...counter } : shift(at, (i ? 1 : -1) * (s.w / 2 - 11), s.h / 2 - 12)} value={i ? Math.max(0, unit.h - unit.d) : unit.p} label={i ? 'HP' : 'PWR'} p={p} start={start} />; })}</>; }
function BaseHP({ at, hp, p, start }: { at: EffectBox; hp: number; p: number; start: number }) { const pos = at.stat ? { ...at, ...at.stat } : shift(at, size(at).w / 2 - 3, -size(at).h / 2 + 4); return <ScreenPixels at={pos} opacity={visible(p, start)}><circle r="24" fill="#07101b" stroke="#9bb6cd" strokeWidth="3" /><text textAnchor="middle" y="7" fill="#e3edf7" stroke="none" style={{ font: '800 22px var(--font-display,sans-serif)' }}>{hp}</text></ScreenPixels>; }

/** Exact staged payment proof; ordinary recordings cannot borrow the authored resource story. */
function eventProof(cue: CardEffectCue, extra: CardRef[] = []) {
    if (!cue.transition || cue.stage || !cue.source?.id || cue.source.s !== cue.definition.setCode || cue.source.n !== cue.definition.name || cue.source.owner !== cue.seat || cue.playPayment?.kind !== 'resources' || cue.playPayment.smuggle) return false;
    const before = cue.transition.before.players[cue.seat], after = cue.transition.after.players[cue.seat], paid = cue.playPayment.cardIds;
    let cost: number; try { cost = previewPlayCost(cue.definition, cue.transition.before, cue.seat, cue.playPayment); } catch { return false; }
    if (!paid || cue.playCost !== cost || paid.length !== cost || !before.resources || !after.resources || before.hand.filter(c => refEqual(c, cue.source)).length !== 1 || after.hand.some(c => same(c, cue.source)) || after.discard.filter(c => refEqual(c, cue.source)).length !== 1) return false;
    const all = [...paid, ...extra.map(key)];
    return new Set(all).size === all.length && all.every(id => before.resources!.some(c => c.id === id && !c.x)) && before.res.total === after.res.total && after.res.ready === before.res.ready - all.length && before.resources.length === before.res.total && after.resources.length === after.res.total && before.resources.filter(c => !c.x).length === before.res.ready && after.resources.filter(c => !c.x).length === after.res.ready && ordered(before.resources, after.resources) && before.resources.every((c, i) => !!after.resources![i].x === (!!c.x || all.includes(key(c))));
}
function Payment({ cue, geometry: g, p, extra = [] }: Props & { extra?: CardRef[] }) {
    const before = cue.transition!.before.players[cue.seat], paid = cue.playPayment!.kind === 'resources' ? cue.playPayment!.cardIds! : [], all = [...paid, ...extra.map(key)];
    return <>{before.resources?.map((r, i) => { const at = g.resourceCards?.[`${cue.seat}:${key(r)}`]; return at && all.includes(key(r)) ? <ResourceSlot key={key(r)} at={at} index={i} spent p={p} start={extra.some(c => same(c, r)) ? .28 : .04} /> : null; })}<ResourceBalance at={g.zones[`${cue.seat}:resources`]} countAt={g.zones[`${cue.seat}:resource-count`]} ready={before.res.ready - paid.length} total={before.res.total} p={p} start={.04} />{!!extra.length && <ResourceBalance at={g.zones[`${cue.seat}:resources`]} countAt={g.zones[`${cue.seat}:resource-count`]} ready={before.res.ready - all.length} total={before.res.total} p={p} start={.28} />}<Mask at={g.source} p={p} start={.04} /><Travel from={g.source} to={g.zones[`${cue.seat}:discard`]} card={cue.source!} p={p} start={.04} end={.23} /></>;
}
const printed: Record<string, number> = { SHD_239: 3, SOR_095: 2, SOR_098: 3, SOR_237: 2, SOR_033: 3, SHD_030: 3, SEC_030: 3, SOR_164: 4, LOF_164: 4, SOR_225: 1, SOR_005: 6, SOR_010: 7 };
function captureProof(cue: CardEffectCue, g: Geometry) {
    if (!eventProof(cue)) return;
    const item = g.outcomes.find(i => i.outcome.kind === 'capture'), o = item?.outcome;
    if (!item || !o || o.prevented || !fullUnit(o.card) || !fullUnit(o.sourceCard) || !o.fromSeat || !['ground', 'space'].includes(o.fromZone ?? '') || o.seat !== cue.seat || o.fromSeat === cue.seat || o.captureBasis || !o.captureCost) return;
    const captor = unitIn(cue, o.sourceCard, cue.seat), target = unitIn(cue, o.card, o.fromSeat), end = unitIn(cue, captor, cue.seat, true);
    if (!captor || !target || !end || !statsEqual(captor, o.sourceCard) || !statsEqual(target, o.card) || !target.owner || !captor.incarnation || !target.incarnation || o.incarnation !== target.incarnation || o.ownerSeat !== target.owner || isLeader(cue, target) || target.cap?.length || !captor.s || !target.s || printed[captor.s] === undefined || printed[target.s] === undefined || o.captureCost.captorPrintedCost !== printed[captor.s] || o.captureCost.targetPrintedCost !== printed[target.s] || printed[target.s] > printed[captor.s] || !statsEqual(captor, end) || !ordered(end.cap ?? [], [...(captor.cap ?? []), target]) || seats.some(s => units(cue, s, true).some(c => same(c, target)))) return;
    for (const up of target.u ?? []) { if (!up.owner || up.t && seats.some(s => cue.transition!.after.players[s].discard.some(c => same(c, up))) || !up.t && cue.transition!.after.players[up.owner].discard.filter(c => refEqual(c, up)).length !== 1) return; }
    return { item, captor, target, end };
}
function shieldProof(cue: CardEffectCue, g: Geometry) {
    if (!eventProof(cue)) return;
    const item = g.outcomes.find(i => i.outcome.kind === 'shield'), o = item?.outcome;
    if (!item || !o || o.prevented || o.seat !== cue.seat || num(o) !== 1 || !fullUnit(o.card) || !fullUnit(o.sourceCard) || !refEqual(o.card, o.sourceCard) || o.cards?.length !== 1) return;
    const old = unitIn(cue, o.card, cue.seat), end = unitIn(cue, o.card, cue.seat, true), token = o.cards[0];
    if (!old || !end || old.s !== 'SHD_239' || old.n !== 'Toro Calican: Ambitious Upstart' || !statsEqual(old, o.card) || !statsEqual(old, o.sourceCard) || !statsEqual(old, end) || o.incarnation !== old.incarnation || !token.id || token.n !== 'Shield' || token.s !== null || token.owner !== cue.seat || seats.some(s => units(cue, s).some(u => u.u?.some(c => same(c, token)))) || end.u?.length !== (old.u?.length ?? 0) + 1) return;
    const actual = end.u.find(u => refEqual(u, token));
    if (!actual || actual.t !== 1 || actual.p !== 0 || actual.h !== 0 || JSON.stringify(end.u.filter(u => !same(u, token))) !== JSON.stringify(old.u ?? [])) return;
    return { item, old, end, token };
}
function dealProof(cue: CardEffectCue, g: Geometry) {
    if (!eventProof(cue) || g.outcomes.length !== 1) return;
    const item = g.outcomes[0], o = item.outcome;
    if (o.kind !== 'discard' || o.prevented || o.fromZone !== 'capture' || o.fromSeat !== cue.seat || !fullUnit(o.sourceCard) || !o.card?.id || !o.ownerSeat || o.seat !== o.ownerSeat || o.zone !== 'discard' || num(o) !== 1) return;
    const guard = unitIn(cue, o.sourceCard, cue.seat), end = unitIn(cue, o.sourceCard, cue.seat, true), captive = guard?.cap?.find(c => refEqual(c, o.card));
    if (!guard || !end || !captive || !statsEqual(guard, o.sourceCard) || !statsEqual(guard, end) || captive.owner !== o.ownerSeat || !ordered(end.cap ?? [], guard.cap!.filter(c => !same(c, captive))) || end.cap === undefined || JSON.stringify(guard.u ?? []) !== JSON.stringify(end.u ?? []) || cue.transition!.after.players[o.ownerSeat].discard.filter(c => refEqual(c, captive)).length !== 1 || seats.some(s => units(cue, s, true).some(u => u.cap?.some(c => same(c, captive)) || same(u, captive)))) return;
    return { item, guard, end, captive };
}
function aidProof(cue: CardEffectCue, g: Geometry) {
    if (!cue.transition || cue.stage || !cue.source?.id || cue.source.s !== 'SHD_252' || cue.source.n !== "Smuggler's Aid" || cue.source.owner !== cue.seat || cue.playPayment?.kind !== 'resources') return;
    const before = cue.transition.before.players[cue.seat], after = cue.transition.after.players[cue.seat], heal = g.outcomes.find(i => i.outcome.kind === 'heal'), replacement = g.outcomes.find(i => i.outcome.kind === 'resource'), o = heal?.outcome, mode = cue.playPayment.smuggle;
    if (!heal || !o || o.prevented || o.seat !== cue.seat || o.zone !== 'base' || !refEqual(o.card, before.base) || num(o) !== Math.min(3, before.base.d) || after.base.hp !== before.base.hp || after.base.d !== before.base.d - num(o) || after.discard.filter(c => refEqual(c, cue.source)).length !== 1 || seats.some(s => JSON.stringify(units(cue, s)) !== JSON.stringify(units(cue, s, true)))) return;
    if (!mode) { if (!eventProof(cue) || g.outcomes.length !== 1 || after.deck !== before.deck || !ordered(after.hand, before.hand.filter(c => !same(c, cue.source)))) return; return { heal, before, after, paid: cue.playPayment.cardIds!, resources: after.resources!, replacement: undefined, mode: 'hand' as const }; }
    const paid = cue.playPayment.cardIds, resources = mode.resourcesAfterPayment, original = before.resources;
    let cost: number; try { cost = previewPlayCost(cue.definition, cue.transition.before, cue.seat, cue.playPayment); } catch { return; }
    if (!paid || !original || !after.resources || mode.sourceId !== cue.source.id || cue.playCost !== cost || paid.length !== cost || new Set(paid).size !== paid.length || !original.some(c => refEqual(c, cue.source)) || before.hand.some(c => same(c, cue.source)) || original.length !== before.res.total || original.filter(c => !c.x).length !== before.res.ready || resources.length !== original.length || new Set(resources.map(key)).size !== resources.length || resources.some(c => !original.some(r => refEqual(c, r))) || paid.some(id => !original.some(r => r.id === id && !r.x)) || !resources.find(c => same(c, cue.source))?.x || resources.filter(c => !c.x).length !== before.res.ready - cost || !ordered(after.hand, before.hand)) return;
    const top = before.knownDeck?.[0], r = replacement?.outcome;
    const remaining = resources.filter(c => !same(c, cue.source));
    if (top) { if (!replacement || !r || r.prevented || num(r) !== 1 || r.seat !== cue.seat || r.ownerSeat !== cue.seat || r.fromSeat !== cue.seat || r.fromZone !== 'deck' || r.zone !== 'resources' || r.visibility !== 'private' || r.entersReady !== false || !refEqual(r.card, top) || !refEqual(r.sourceCard, cue.source) || after.deck !== before.deck - 1 || !ordered(after.knownDeck ?? [], before.knownDeck!.slice(1))) return; remaining.push({ ...top, x: 1 } as ResourceRef); }
    else if (before.deck !== 0 || replacement || after.deck !== 0) return;
    if (g.outcomes.length !== (top ? 2 : 1) || !ordered(after.resources, remaining) || after.resources.some((r, i) => !!r.x !== !!remaining[i].x) || after.res.total !== remaining.length || after.res.ready !== before.res.ready - cost || after.resources.filter(r => !r.x).length !== after.res.ready) return;
    return { heal, replacement, before, after, paid, resources, mode: 'smuggle' as const };
}
function additionProof(cue: CardEffectCue, g: Geometry) {
    if (!cue.transition || g.outcomes.length !== 3) return;
    const cost = g.outcomes.find(i => i.outcome.kind === 'cost'), pay = g.outcomes.find(i => i.outcome.kind === 'pay'), play = g.outcomes.find(i => i.outcome.kind === 'play'), o = play?.outcome, permission = o?.upgradePlayPermission, history = cue.transition.before.defeatedThisPhase;
    if (!cost || !pay || !play || !o || cost.outcome.prevented || pay.outcome.prevented || o.prevented || o.playAs !== 'upgrade' || o.entryType !== 'played' || !permission || permission.sourceId !== cue.source?.id || permission.player !== cue.seat || permission.ignoreAspectPenalties !== true || !history || history.round !== cue.transition.before.round || history.phase !== cue.transition.before.phase || o.defeatPhase?.round !== history.round || o.defeatPhase.phase !== history.phase || !history.cards.some(w => w.id === permission.defeated.id && w.incarnation === permission.defeated.incarnation && !!w.controller && w.controller !== cue.seat && ['unit', 'leader-unit'].includes(w.lastKnownType ?? '')) || !o.fromSeat || !['hand', 'discard'].includes(o.fromZone ?? '') || o.fromZone === 'hand' && o.fromSeat !== cue.seat || !o.card?.id || o.card.s !== 'SHD_224' || o.card.n !== "Boba Fett's Armor" || !o.ownerSeat || o.card.owner !== o.ownerSeat || o.controllerSeat !== cue.seat || !fullUnit(o.targetCard)) return;
    const origin = cue.transition.before.players[o.fromSeat][o.fromZone as 'hand' | 'discard'], actual = origin.find(c => refEqual(c, o.card)), host = unitIn(cue, o.targetCard, o.seat), end = unitIn(cue, o.targetCard, o.seat, true), up = o.upgrade;
    const extra = pay.outcome.cards;
    if (!actual || !host || !end || !extra || extra.length !== 2 || !eventProof(cue, extra) || num(cost.outcome) !== -2 || !refEqual(cost.outcome.card, actual) || cost.outcome.seat !== cue.seat || num(pay.outcome) !== 2 || pay.outcome.seat !== cue.seat || !refEqual(pay.outcome.sourceCard, actual) || !['SOR_095', 'SOR_098', 'SHD_239'].includes(host.s ?? '') || !statsEqual(host, o.targetCard) || !poseEqual(host, end) || end.p !== host.p + 2 || end.h !== host.h + 2 || !up || !refEqual(up, actual) || up.owner !== o.ownerSeat || up.controller !== cue.seat || up.t !== 0 || up.p !== 2 || up.h !== 2 || o.printedCost !== 2 || JSON.stringify(end.u ?? []) !== JSON.stringify([...(host.u ?? []), up]) || JSON.stringify(host.cap ?? []) !== JSON.stringify(end.cap ?? []) || cue.transition.after.players[o.fromSeat][o.fromZone as 'hand' | 'discard'].some(c => same(c, actual)) || g.outcomes.indexOf(cost) >= g.outcomes.indexOf(pay) || g.outcomes.indexOf(pay) >= g.outcomes.indexOf(play)) return;
    const paid = cue.playPayment?.kind === 'resources' ? cue.playPayment.cardIds : [];
    if (extra.some(c => !cue.transition!.before.players[cue.seat].resources?.some(r => refEqual(r, c) && !r.x) || paid?.includes(key(c)))) return;
    return { cost, pay, play, actual, host, end, up, extra, witness: permission.defeated };
}
function crackdownProof(cue: CardEffectCue, g: Geometry) {
    if (!eventProof(cue) || !cue.transition || g.outcomes.length !== 2) return;
    const defeat = g.outcomes.find(i => i.outcome.kind === 'defeat'), damage = g.outcomes.find(i => i.outcome.kind === 'damage'), d = defeat?.outcome, o = damage?.outcome;
    if (!defeat || !damage || !d || !o || d.prevented || o.prevented || !fullUnit(d.card) || !fullUnit(o.sourceCard) || !d.ownerSeat || !d.incarnation || d.card.incarnation !== d.incarnation || o.seat !== cue.seat || o.zone !== 'base' || o.damageType !== 'ability' || !refEqual(o.card, cue.transition.before.players[cue.seat].base) || o.requiresDefeat?.id !== d.card.id || o.requiresDefeat?.incarnation !== d.incarnation || o.basis?.kind !== 'defeated-power' || o.basis.sourceIds.length !== 1 || o.basis.sourceIds[0] !== d.card.id || g.outcomes.indexOf(defeat) >= g.outcomes.indexOf(damage)) return;
    const target = unitIn(cue, d.card, d.seat), power = target ? Math.max(0, target.p) : NaN, before = cue.transition.before.players[cue.seat], after = cue.transition.after.players[cue.seat];
    if (!target || target.cap?.length || isLeader(cue, target) || !statsEqual(target, d.card) || !statsEqual(target, o.sourceCard) || o.sourceCard.incarnation !== d.incarnation || target.owner !== d.ownerSeat || num(o) !== power || o.basis.value !== power || after.base.hp !== before.base.hp || after.base.d !== before.base.d + power || seats.some(s => units(cue, s, true).some(c => same(c, target))) || cue.transition.after.players[d.ownerSeat].discard.filter(c => refEqual(c, target)).length !== 1) return;
    for (const up of target.u ?? []) if (!up.owner || !up.t && cue.transition.after.players[up.owner].discard.filter(c => refEqual(c, up)).length !== 1 || up.t && seats.some(s => cue.transition!.after.players[s].discard.some(c => same(c, up)))) return;
    return { defeat, damage, target, power, before, after };
}
/** The renderer and generic-receipt suppression call exactly these same predicates. */
export function batchA08Covers(cue: CardEffectCue, g: Geometry, item: PlacedOutcome): boolean {
    switch (cue.definition.id) {
        case 'relentless-pursuit': return item === captureProof(cue, g)?.item || item === shieldProof(cue, g)?.item;
        case 'altering-the-deal': return item === dealProof(cue, g)?.item;
        case 'smugglers-aid': { const r = aidProof(cue, g); return !!r && (item === r.heal || item === r.replacement); }
        case 'a-fine-addition': { const r = additionProof(cue, g); return !!r && [r.cost, r.pay, r.play].includes(item); }
        case 'lethal-crackdown': { const r = crackdownProof(cue, g); return !!r && (item === r.defeat || item === r.damage); }
        default: return false;
    }
}
function Cleanup({ geometry: g, unit, seat, p, start = .25 }: Props & { unit: UnitRef; seat: Seat; start?: number }) { return <>{(unit.u ?? []).map(up => { const at = g.cards?.[`${seat}:${key(up)}`]; return at ? <g key={key(up)}><AttachmentMask at={at} p={p} start={start} />{!up.t && up.owner && <Travel from={at} to={g.zones[`${up.owner}:discard`]} card={up} portrait p={p} start={start} end={start + .3} />}</g> : null; })}</>; }
function Pursuit(props: Props) {
    const { cue, geometry: g, p } = props, capture = captureProof(cue, g), shield = shieldProof(cue, g);
    if (!capture && !shield) return null;
    const captor = capture?.captor ?? shield!.old, at = g.cards?.[`${cue.seat}:${key(captor)}`] ?? g.target, pocket = g.pockets?.[`${cue.seat}:${key(captor)}`];
    return <><Payment {...props} />{capture && <><Receipt at={center(g)} rows={[`PRINTED ${printed[capture.target.s!]} ≤ ${printed[captor.s!]}`, 'CAPTURE → FACEDOWN POCKET']} p={p} start={.05} until={.26} /><Mask at={capture.item.from} p={p} start={.25} /><Cleanup {...props} unit={capture.target} seat={capture.item.outcome.fromSeat!} start={.23} />{pocket && <><AttachmentMask at={pocket} p={p} start={.6} /><ScreenPixels at={shift(pocket, -size(pocket).w / 2 + 18, 0)} opacity={visible(p, .61)} color="#d0dbc7"><text textAnchor="middle" y="-4" fill="currentColor" stroke="none" style={{font:'700 5px sans-serif'}}>CAPTIVE</text><text textAnchor="middle" y="9" fill="currentColor" stroke="none" style={{font:'800 12px sans-serif'}}>{capture.end.cap!.length}</text></ScreenPixels></>}<Travel from={capture.item.from} to={capture.item.to} card={capture.target} p={p} start={.26} end={.61} pocket hold /><Receipt at={center(g)} rows={[`CAPTIVE OWNER ${capture.target.owner!.toUpperCase()}`, `${captor.n.split(':')[0].toUpperCase()} KEEPS DAMAGE / READINESS`]} p={p} start={.71} /></>}{shield && <><ScreenPixels at={at} opacity={visible(p, .44)} color="#b5dcaa"><path d={`M0 ${-size(at).h / 2 - 9} L${size(at).w / 2 + 10} ${-size(at).h / 3} V${size(at).h / 4} Q${size(at).w / 2} ${size(at).h / 2 + 14} 0 ${size(at).h / 2 + 18} Q${-size(at).w / 2} ${size(at).h / 2 + 14} ${-size(at).w / 2 - 10} ${size(at).h / 4} V${-size(at).h / 3} Z`} fill="#b5dcaa" fillOpacity=".08" strokeWidth="2" /></ScreenPixels><Receipt at={shift(at, 0, -size(at).h / 2 - 32)} rows={['BOUNTY HUNTER · SHIELD']} p={p} start={.47} color="#b5dcaa" /></>}</>;
}
function Deal(props: Props) {
    const { cue, geometry: g, p } = props, r = dealProof(cue, g); if (!r) return null;
    const pocket = g.pockets?.[`${cue.seat}:${key(r.guard)}`];
    const scale = r.item.from.sx ?? 1, hq = seats.map(seat => g.zones[seat + ':base']).filter(Boolean);
    const corridor = Math.min(1000 - 34 / scale, Math.max(r.item.from.x + 72 / scale, r.item.to.x, ...hq.map(base => (base.stat?.x ?? base.x + base.w / 2) + 88 / scale)));

    return <><Payment {...props} /><Receipt at={center(g)} rows={['ONE ACTUAL CAPTIVE', `OWNER ${r.captive.owner!.toUpperCase()} DISCARD`]} p={p} start={.06} until={.29} /><ScreenPixels at={r.item.from} opacity={envelope(p, .08, .17, .4)} color="#e2acc2"><path d="M-13 -5 V16 H13 V-5 M-8 -5 V-13 A8 8 0 0 1 8 -13" strokeWidth="2" /></ScreenPixels><AttachmentMask at={r.item.from} p={p} start={.29} /><Travel from={r.item.from} to={r.item.to} card={r.captive} p={p} start={.3} end={.66} portrait corridor={corridor} />{pocket && <ScreenPixels at={pocket} opacity={visible(p, .65)} color="#cad6e1"><rect x={-size(pocket).w / 2} y={-size(pocket).h / 2} width={size(pocket).w} height={size(pocket).h} fill="#101b2a" /><text y="3" textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '700 8px sans-serif' }}>CAPTIVE {r.end.cap!.length}</text></ScreenPixels>}<Receipt at={center(g)} rows={['GUARD STAYS · POCKET EMPTIED', `${r.captive.owner!.toUpperCase()} DISCARD +1`]} p={p} start={.73} /></>;
}
function Aid(props: Props) {
    const { cue, geometry: g, p } = props, r = aidProof(cue, g); if (!r) return null;
    const base = g.friendlyBase, sourceIndex = r.resources.findIndex(c => same(c, cue.source)), sourcePosition = r.before.resources?.[sourceIndex], sourceSlot = sourcePosition ? g.resourceCards?.[`${cue.seat}:${key(sourcePosition)}`] ?? g.source : g.source;
    const slotAt = (i: number) => g.resourceCards?.[`${cue.seat}:${key(r.before.resources?.[i])}`];
    return <>{r.mode === 'hand' ? <Payment {...props} /> : <>{r.resources.map((resource, i) => { const at = slotAt(i); return at ? <ResourceSlot key={key(resource)} at={at} index={i} spent={!!resource.x} p={p} start={.04} /> : null; })}<ResourceBalance at={g.zones[`${cue.seat}:resources`]} countAt={g.zones[`${cue.seat}:resource-count`]} ready={r.before.res.ready - r.paid.length} total={r.before.res.total} p={p} start={.04} /><AttachmentMask at={sourceSlot} p={p} start={.19} />{r.resources.filter(c => !same(c, cue.source)).map((resource, i) => { const at = slotAt(i); return at ? <ResourceSlot key={`departed-${key(resource)}`} at={at} index={i} spent={!!resource.x} p={p} start={.19} /> : null; })}<ResourceBalance at={g.zones[`${cue.seat}:resources`]} countAt={g.zones[`${cue.seat}:resource-count`]} ready={r.after.res.ready} total={r.before.res.total - 1} p={p} start={.19} /><Travel from={{ ...sourceSlot, cardSize: { w: 27, h: 38 } }} to={g.zones[`${cue.seat}:discard`]} card={cue.source!} p={p} start={.19} end={.41} /><Receipt at={center(g)} rows={[`SMUGGLE PAYMENT ${cue.playCost}`, 'ACTUAL RESOURCE → OWN DISCARD']} p={p} start={.05} until={.43} />{r.replacement && <><Travel from={r.replacement.from} to={r.replacement.to} card={r.replacement.outcome.card!} back p={p} start={.42} end={.68} /><ResourceSlot at={r.replacement.to} index={r.after.resources!.length - 1} spent p={p} start={.68} /></>}<ResourceBalance at={g.zones[`${cue.seat}:resources`]} countAt={g.zones[`${cue.seat}:resource-count`]} ready={r.after.res.ready} total={r.after.res.total} p={p} start={.68} /></>}<ScreenPixels at={base} opacity={envelope(p, .52, .63, .79)} color="#9cdfbd"><CountedMarks count={num(r.heal.outcome)} color="#9cdfbd" gap={12} /><path d="M-32 -13 H32 M-32 13 H32" strokeWidth="2" /></ScreenPixels><BaseHP at={base} hp={r.after.base.hp - r.after.base.d} p={p} start={.62} /><Receipt at={center(g)} rows={[`BASE HEAL ${num(r.heal.outcome)} · DAMAGE ${r.before.base.d} → ${r.after.base.d}`, ...(r.mode === 'smuggle' ? [r.replacement ? 'PRIVATE REPLACEMENT · EXHAUSTED' : 'EMPTY DECK · NO REPLACEMENT', `${r.after.res.ready}/${r.after.res.total} RESOURCES READY`] : ['HAND PLAY · NO SMUGGLE'])]} p={p} start={.76} color="#b4e2c7" /></>;
}
function Addition(props: Props) {
    const { cue, geometry: g, p } = props, r = additionProof(cue, g); if (!r) return null;
    const host = g.cards?.[`${r.play.outcome.seat}:${key(r.host)}`] ?? g.target;
    return <><Payment {...props} extra={r.extra} /><Receipt at={center(g)} rows={['ENEMY UNIT DEFEATED THIS PHASE', 'ASPECT PENALTY IGNORED · PAY 2']} p={p} start={.05} until={.36} /><UpgradePlay from={r.play.from} to={r.play.to} card={r.actual} p={p} start={.3} end={.68} /><Stats at={host} unit={r.end} p={p} start={.67} /><Receipt at={center(g)} rows={[`FROM ${r.play.outcome.fromSeat!.toUpperCase()} ${r.play.outcome.fromZone!.toUpperCase()} · +2/+2`, `OWNER ${r.up.owner!.toUpperCase()} · CONTROLLER ${r.up.controller!.toUpperCase()}`, 'ARMOR ATTACHED · DAMAGE KEPT']} p={p} start={.73} color="#c5cce7" /></>;
}
function Crackdown(props: Props) {
    const { cue, geometry: g, p } = props, r = crackdownProof(cue, g); if (!r) return null;
    const target = r.defeat.box, base = g.friendlyBase, t = easeInOut(phase(p, .55, .72)), packet = { ...target, ...mix(target, base, t) };
    return <><Payment {...props} /><Receipt at={center(g)} rows={[`POWER AT DEFEAT ${r.power}`, `${r.target.n.split(':')[0].toUpperCase()} → OWNER DISCARD`]} p={p} start={.06} until={.31} /><Counter at={shift(target, 0, -size(target).h / 2 - 27)} value={r.power} label="AT DEFEAT" p={p} start={.14} /><Mask at={target} p={p} start={.3} /><Cleanup {...props} unit={r.target} seat={r.defeat.outcome.seat} start={.3} /><Travel from={target} to={r.defeat.to} card={r.target} p={p} start={.31} end={.54} /><ScreenPixels at={packet} opacity={envelope(p, .55, .59, .76)} color="#efada4"><CountedMarks count={r.power} gap={11} color="#efada4" /></ScreenPixels><path d={`M${target.x} ${target.y} L${base.x} ${base.y}`} stroke="#ec9f9b" strokeWidth="2" strokeDasharray="5 6" opacity={envelope(p, .55, .58, .76)} /><BaseHP at={base} hp={Math.max(0, r.after.base.hp - r.after.base.d)} p={p} start={.73} /><Receipt at={center(g)} rows={[`${r.target.n.split(':')[0].toUpperCase()} DEFEATED · OWN BASE`, `POWER ${r.power} → ${r.power} DAMAGE`, `BASE DAMAGE ${r.before.base.d} → ${r.after.base.d}`]} p={p} start={.78} color="#f0b9b5" /></>;
}
export function BatchA08Signature(props: Props) {
    switch (props.cue.definition.id) { case 'relentless-pursuit': return <Pursuit {...props} />; case 'altering-the-deal': return <Deal {...props} />; case 'smugglers-aid': return <Aid {...props} />; case 'a-fine-addition': return <Addition {...props} />; case 'lethal-crackdown': return <Crackdown {...props} />; default: return null; }
}
