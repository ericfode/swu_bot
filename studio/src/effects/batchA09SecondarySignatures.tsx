import type { CardRef, Seat, UnitRef } from '../data/types';
import type { CardEffectCue } from './types';
import { A09_DEFINITIONS } from './batchA09';
import { previewPlayCost } from './previewCosts';
import { easeInOut, envelope, phase } from './animationTimeline';
import { CardGhost, ResourceBalance, ResourceSlot, ScreenPixels, mix, screenShift as shift, type EffectBox, type PlacedOutcome } from './primitives';

type Geometry = { source: EffectBox; target: EffectBox; friendlyBase: EffectBox; outcomes: PlacedOutcome[]; zones: Record<string, EffectBox>; cards?: Record<string, EffectBox>; endingCards?: Record<string, EffectBox>; resourceCards?: Record<string, EffectBox> };
type Props = { cue: CardEffectCue; geometry: Geometry; p: number };
type Member = { item: PlacedOutcome; old: UnitRef; end?: UnitRef; death?: PlacedOutcome; power: number; hp: number };
const seats: Seat[] = ['p1', 'p2'];
const ids = new Set(['hello-there', 'equalize', 'i-have-the-high-ground', 'guarding-the-way', 'disruptive-burst']);
export const isBatchA09Secondary = (cue: CardEffectCue) => ids.has(cue.definition.id);
const key = (card?: CardRef | null) => card?.id ?? '';
const same = (a?: CardRef | null, b?: CardRef | null) => !!a?.id && a.id === b?.id;
const refEqual = (a?: CardRef | null, b?: CardRef | null) => same(a, b) && a?.n === b?.n && a?.s === b?.s && a?.owner === b?.owner;
const ordered = (a: CardRef[], b: CardRef[]) => a.length === b.length && a.every((c, i) => refEqual(c, b[i]));
const units = (cue: CardEffectCue, seat: Seat, after = false) => [...(cue.transition?.[after ? 'after' : 'before'].players[seat].ground ?? []), ...(cue.transition?.[after ? 'after' : 'before'].players[seat].space ?? [])];
const unitIn = (cue: CardEffectCue, card: CardRef | null | undefined, seat: Seat, after = false) => units(cue, seat, after).find(u => same(u, card));
const arenaIn = (cue: CardEffectCue, card: CardRef, seat: Seat, after = false) => (['ground', 'space'] as const).find(zone => cue.transition?.[after ? 'after' : 'before'].players[seat][zone].some(u => same(u, card)));
const fullUnit = (card?: CardRef | null): card is UnitRef => !!card && 'p' in card && 'h' in card && 'd' in card;
const sameStats = (a: UnitRef, b: UnitRef) => refEqual(a, b) && a.incarnation === b.incarnation && a.p === b.p && a.h === b.h && a.d === b.d && !!a.x === !!b.x;
const samePose = (a: UnitRef, b: UnitRef) => refEqual(a, b) && a.incarnation === b.incarnation && a.d === b.d && !!a.x === !!b.x && a.t === b.t && JSON.stringify(a.u ?? []) === JSON.stringify(b.u ?? []) && JSON.stringify(a.cap ?? []) === JSON.stringify(b.cap ?? []);
const size = (at: EffectBox) => at.cardSize ?? { w: at.w * (at.sx ?? 1), h: at.h * (at.sy ?? 1) };
const visible = (p: number, start: number) => phase(p, start, start + .045);
const bounded = (at: EffectBox, w = 210, h = 42): EffectBox => ({ ...at, x: Math.max((w / 2 + 8) / (at.sx ?? 1), Math.min(1000 - (w / 2 + 8) / (at.sx ?? 1), at.x)), y: Math.max((h / 2 + 40) / (at.sy ?? 1), Math.min(600 - (h / 2 + 122) / (at.sy ?? 1), at.y)) });
const center = (g: Geometry) => { const upper = g.zones['p2:ground'], base = g.zones['p1:base']; return bounded({ ...g.source, x: 500, y: upper && base ? (upper.y + upper.h / 2 + base.y - base.h / 2) / 2 : 300 }); };

function eventProof(cue: CardEffectCue, g: Geometry) {
    const canonical = A09_DEFINITIONS.find(definition => definition.id === cue.definition.id);
    if (!canonical || cue.definition.name !== canonical.name || cue.definition.setCode !== canonical.setCode || !g.outcomes.every(i => refEqual(i.outcome.sourceCard, cue.source)) || !cue.transition || cue.transition.before.round !== cue.transition.after.round || cue.transition.before.phase !== cue.transition.after.phase || cue.stage || !cue.source?.id || cue.source.n !== canonical.name || cue.source.s !== canonical.setCode || cue.source.owner !== cue.seat || cue.playPayment?.kind !== 'resources' || cue.playPayment.smuggle || cue.playPayment.exploit) return false;
    const before = cue.transition.before.players[cue.seat], after = cue.transition.after.players[cue.seat], paid = cue.playPayment.cardIds;
    let cost: number; try { cost = previewPlayCost(cue.definition, cue.transition.before, cue.seat, cue.playPayment); } catch { return false; }
    return !!paid && cue.playCost === cost && paid.length === cost && new Set(paid).size === paid.length
        && before.hand.filter(c => refEqual(c, cue.source)).length === 1 && !after.hand.some(c => same(c, cue.source)) && after.discard.filter(c => refEqual(c, cue.source)).length === 1
        && !!before.resources && !!after.resources && before.resources.length === before.res.total && after.resources.length === after.res.total && ordered(before.resources, after.resources)
        && before.res.total === after.res.total && before.resources.filter(c => !c.x).length === before.res.ready && after.resources.filter(c => !c.x).length === after.res.ready && after.res.ready === before.res.ready - cost
        && paid.every(id => before.resources!.some(c => c.id === id && !c.x)) && before.resources.every((c, i) => !!after.resources![i].x === (!!c.x || paid.includes(key(c))))
        && seats.every(s => JSON.stringify(cue.transition!.before.players[s].base) === JSON.stringify(cue.transition!.after.players[s].base));
}

function statMember(cue: CardEffectCue, g: Geometry, item: PlacedOutcome | undefined, delta: number, allowsSentinelGrant = false): Member | undefined {
    const o = item?.outcome;
    if (!item || !o || o.prevented || o.kind !== (delta < 0 ? 'debuff' : 'buff') || o.duration !== 'phase' || String(o.amount).replaceAll('−', '-') !== `${delta > 0 ? '+' : ''}${delta}/${delta > 0 ? '+' : ''}${delta}` || !fullUnit(o.card)) return;
    const old = unitIn(cue, o.card, o.seat), end = unitIn(cue, o.card, o.seat, true);
    if (!old || !old.incarnation || !sameStats(old, o.card) || o.incarnation && o.incarnation !== old.incarnation || old.u?.length || old.cap?.length) return;
    const power = Math.max(0, old.p + delta), hp = Math.max(0, old.h + delta), lethal = old.d >= hp;
    if (!lethal) {
        if (!end || !samePose(old, end) || arenaIn(cue, old, o.seat) !== arenaIn(cue, end, o.seat, true) || !allowsSentinelGrant && old.sn !== end.sn || end.p !== power || end.h !== hp || !end.status?.some(s => s.kind === o.kind && s.duration === 'phase')) return;
        return { item, old, end, power, hp };
    }
    const death = g.outcomes.find(i => i.outcome.kind === 'defeat' && same(i.outcome.card, old));
    if (!death || death.outcome.prevented || death.outcome.incarnation !== old.incarnation || death.outcome.ownerSeat !== old.owner || !old.owner || g.outcomes.indexOf(death) <= g.outcomes.indexOf(item) || seats.some(s => units(cue, s, true).some(u => same(u, old)))) return;
    if (seats.some(s => same(cue.transition?.before.players[s].leader, old))) return; // Separate leader disposition needs its actual proof.
    if (old.t) { if (seats.some(s => cue.transition!.after.players[s].discard.some(c => same(c, old)) || cue.transition!.after.players[s].hand.some(c => same(c, old)))) return; }
    else if (cue.transition!.after.players[old.owner].discard.filter(c => refEqual(c, old)).length !== 1) return;
    return { item, old, death, power, hp };
}
function unrelatedStay(cue: CardEffectCue, members: Member[]) {
    const selected = new Set(members.map(m => key(m.old)));
    return seats.every(s => units(cue, s).filter(u => !selected.has(key(u))).every(u => JSON.stringify(u) === JSON.stringify(unitIn(cue, u, s, true)))
        && units(cue, s, true).length === units(cue, s).length - members.filter(m => m.item.outcome.seat === s && m.death).length);
}
function helloProof(cue: CardEffectCue, g: Geometry) {
    if (!eventProof(cue, g) || !cue.transition || g.outcomes.length !== 1) return;
    const member = statMember(cue, g, g.outcomes[0], -4), witness = g.outcomes[0]?.outcome.enteredPhase, history = cue.transition.before.enteredThisPhase;
    if (!member || !member.end || !witness || !history || witness.round !== cue.transition.before.round || witness.phase !== cue.transition.before.phase || history.round !== witness.round || history.phase !== witness.phase || witness.incarnation !== member.old.incarnation || !history.units.some(u => u.id === member.old.id && u.incarnation === member.old.incarnation && ['played', 'created', 'rescued', 'deployed'].includes(u.entryType)) || !unrelatedStay(cue, [member])) return;
    return { members: [member], items: g.outcomes };
}
function equalizeProof(cue: CardEffectCue, g: Geometry) {
    if (!eventProof(cue, g) || !cue.transition) return;
    const reductions = g.outcomes.filter(i => i.outcome.kind === 'debuff'), first = statMember(cue, g, reductions[0], -2), second = statMember(cue, g, reductions[1], -2);
    if (!first || !second || reductions.length !== 2 || same(first.old, second.old) || !first.item.outcome.sequenceId || second.item.outcome.sequenceId !== first.item.outcome.sequenceId || first.item.outcome.sequenceIndex !== 1 || second.item.outcome.sequenceIndex !== 2 || g.outcomes.indexOf(first.item) >= g.outcomes.indexOf(second.item) || first.death && g.outcomes.indexOf(first.death) >= g.outcomes.indexOf(second.item)) return;
    const condition = second.item.outcome.unitCountCondition, against = first.item.outcome.seat;
    const ownCount = units(cue, cue.seat).length - (first.death && first.item.outcome.seat === cue.seat ? 1 : 0), otherCount = units(cue, against).length - (first.death ? 1 : 0);
    const members = [first, second], items = members.flatMap(m => m.death ? [m.item, m.death] : [m.item]);
    if (!condition || condition.firstId !== first.old.id || condition.incarnation !== first.old.incarnation || condition.player !== cue.seat || condition.against !== against || condition.ownCount !== ownCount || condition.otherCount !== otherCount || ownCount >= otherCount || items.length !== g.outcomes.length || !unrelatedStay(cue, members)) return;
    return { members, items, ownCount, otherCount, against };
}
function highGroundProof(cue: CardEffectCue, g: Geometry) {
    if (!eventProof(cue, g) || !cue.transition || g.outcomes.length !== 1) return;
    const item = g.outcomes[0], o = item.outcome, modifier = o.defenseModifier, old = unitIn(cue, o.card, cue.seat), end = unitIn(cue, o.card, cue.seat, true);
    if (o.kind !== 'buff' || o.prevented || o.seat !== cue.seat || o.duration !== 'phase' || !old || !end || !fullUnit(o.card) || !sameStats(old, o.card) || !sameStats(old, end) || !samePose(old, end) || arenaIn(cue, old, cue.seat) !== arenaIn(cue, end, cue.seat, true) || old.sn !== end.sn || !modifier || modifier.attackerPower !== -4 || modifier.sourceId !== cue.source?.id || modifier.round !== cue.transition.before.round || modifier.phase !== cue.transition.before.phase || modifier.incarnation !== old.incarnation || !end.status?.some(s => s.kind === 'buff' && s.duration === 'phase' && JSON.stringify(s.defenseModifier) === JSON.stringify(modifier))) return;
    const member = { item, old, end, power: old.p, hp: old.h };
    if (!unrelatedStay(cue, [member])) return;
    return { member, items: [item] };
}
function guardProof(cue: CardEffectCue, g: Geometry) {
    if (!eventProof(cue, g) || !cue.transition) return;
    const keyword = g.outcomes.find(i => i.outcome.kind === 'keyword'), o = keyword?.outcome, old = o && unitIn(cue, o.card, o.seat), end = o && unitIn(cue, o.card, o.seat, true), buff = g.outcomes.find(i => i.outcome.kind === 'buff'), initiative = cue.transition.before.initiative === cue.seat;
    if (!keyword || !o || o.prevented || !old || !end || !fullUnit(o.card) || !sameStats(old, o.card) || !samePose(old, end) || arenaIn(cue, old, o.seat) !== arenaIn(cue, end, o.seat, true) || o.keyword?.name !== 'Sentinel' || o.keyword.amount !== 1 || o.duration !== 'phase' || end.sn !== 1 || !end.status?.some(s => s.kind === 'keyword' && s.duration === 'phase' && s.keyword?.name === 'Sentinel' && s.keyword.amount === 1)) return;
    const member: Member = { item: keyword, old, end, power: old.p, hp: old.h };
    if (initiative) {
        const adjusted = statMember(cue, g, buff, 2, true), condition = buff?.outcome.condition;
        if (!adjusted || !same(adjusted.old, old) || !condition || condition.kind !== 'initiative' || condition.player !== cue.seat || condition.initiative !== cue.seat) return;
        member.power = adjusted.power; member.hp = adjusted.hp;
    } else if (buff || end.p !== old.p || end.h !== old.h) return;
    if (g.outcomes.length !== (initiative ? 2 : 1) || !unrelatedStay(cue, [member])) return;
    return { member, keyword, buff, initiative, items: g.outcomes };
}
function burstProof(cue: CardEffectCue, g: Geometry) {
    if (!eventProof(cue, g) || !cue.transition) return;
    const enemy: Seat = cue.seat === 'p1' ? 'p2' : 'p1', targets = units(cue, enemy), reductions = g.outcomes.filter(i => i.outcome.kind === 'debuff');
    if (!targets.length || reductions.length !== targets.length) return;
    const members: Member[] = [];
    for (const target of targets) {
        const matching = reductions.filter(i => refEqual(i.outcome.card, target) && i.outcome.seat === enemy);
        if (matching.length !== 1) return;
        const member = statMember(cue, g, matching[0], -1); if (!member) return;
        members.push(member);
    }
    const items = members.flatMap(m => m.death ? [m.item, m.death] : [m.item]);
    if (items.length !== g.outcomes.length || !unrelatedStay(cue, members)) return;
    return { members, items, enemy };
}
export function batchA09SecondaryCovers(cue: CardEffectCue, g: Geometry, item: PlacedOutcome): boolean {
    switch (cue.definition.id) {
        case 'hello-there': return helloProof(cue, g)?.items.includes(item) ?? false;
        case 'equalize': return equalizeProof(cue, g)?.items.includes(item) ?? false;
        case 'i-have-the-high-ground': return highGroundProof(cue, g)?.items.includes(item) ?? false;
        case 'guarding-the-way': return guardProof(cue, g)?.items.includes(item) ?? false;
        case 'disruptive-burst': return burstProof(cue, g)?.items.includes(item) ?? false;
        default: return false;
    }
}

function Receipt({ at, rows, p, start = .7, until, color = '#c7d0ed' }: { at: EffectBox; rows: string[]; p: number; start?: number; until?: number; color?: string }) {
    const w = Math.min(244, Math.max(90, ...rows.map(r => r.length * 4.8 + 18))), h = rows.length * 16 + 8;
    return <ScreenPixels at={bounded(at, w, h)} color={color} opacity={visible(p, start) * (until ? 1 - phase(p, until - .05, until) : 1)}><rect x={-w / 2} y={-h / 2} width={w} height={h} rx="4" fill="#08111e" fillOpacity=".97" />{rows.map((r, i) => <text key={i} y={-h / 2 + 14 + i * 16} textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '700 9px var(--font-display,sans-serif)' }}>{r}</text>)}</ScreenPixels>;
}
function Mask({ at, p, start }: { at: EffectBox; p: number; start: number }) { const s = size(at); return <ScreenPixels at={at} opacity={visible(p, start)}><rect x={-s.w / 2 - 4} y={-s.h / 2 - 4} width={s.w + 8} height={s.h + 8} rx="5" fill="#09121f" stroke="none" /></ScreenPixels>; }
function Travel({ from, to, card, p, start, end }: { from: EffectBox; to: EffectBox; card: CardRef; p: number; start: number; end: number }) {
    if (p < start) return null;
    const t = easeInOut(phase(p, start, end)), mid = shift({ ...from, ...mix(from, to, .5) }, 20, -28), at = { ...from, x: (1 - t) ** 2 * from.x + 2 * (1 - t) * t * mid.x + t * t * to.x, y: (1 - t) ** 2 * from.y + 2 * (1 - t) * t * mid.y + t * t * to.y }, s = size(from);
    return <><path d={`M${from.x} ${from.y} Q${mid.x} ${mid.y} ${to.x} ${to.y}`} stroke="#c0bddc" strokeWidth="1.5" opacity={envelope(p, start, start + .04, end + .1)} /><ScreenPixels at={at} opacity={visible(p, start) * (1 - phase(p, end, end + .075))}><g transform={`rotate(${-5 * Math.sin(Math.PI * t)})`}><CardGhost card={card} box={{ w: s.w + (20 - s.w) * t, h: s.h + (28 - s.h) * t }} /></g></ScreenPixels></>;
}
function Payment({ cue, geometry: g, p }: Props) {
    const before = cue.transition!.before.players[cue.seat], paid = cue.playPayment?.kind === 'resources' ? cue.playPayment.cardIds! : [];
    const from = g.source, to = g.zones[`${cue.seat}:discard`], left = 12 / (from.sx ?? 1);
    const approach = shift(to, 0, 24), route = [from, { ...from, x: left }, { ...approach, x: left }, approach, to], t = easeInOut(phase(p, .04, .22)), segment = Math.min(3, Math.floor(t * 4));
    const at = { ...from, ...mix(route[segment], route[segment + 1], easeInOut(t * 4 - segment)) };
    return <>{before.resources!.map((r, i) => { const at = g.resourceCards?.[`${cue.seat}:${key(r)}`]; return at && paid.includes(key(r)) ? <ResourceSlot key={key(r)} at={at} index={i} spent p={p} start={.04} /> : null; })}<ResourceBalance at={g.zones[`${cue.seat}:resources`]} countAt={g.zones[`${cue.seat}:resource-count`]} ready={before.res.ready - paid.length} total={before.res.total} p={p} start={.04} /><Mask at={g.source} p={p} start={.04} /><path d={route.map((point, i) => `${i ? 'L' : 'M'}${point.x} ${point.y}`).join(' ')} stroke="#c0bddc" strokeWidth="1.5" opacity={envelope(p, .04, .07, .28)} /><ScreenPixels at={at} opacity={envelope(p, .04, .065, .28)}><CardGhost card={cue.source!} box={{ w: 20, h: 28 }} /></ScreenPixels></>;
}
function Counters({ at, power, hp, p, start }: { at: EffectBox; power: number; hp: number; p: number; start: number }) {
    const s = size(at);
    return <>{(['power', 'hp'] as const).map((name, i) => { const pos = at.counters?.[name]; return <ScreenPixels key={name} at={pos ? { ...at, ...pos } : shift(at, (i ? 1 : -1) * (s.w / 2 - 10), s.h / 2 - 12)} opacity={visible(p, start)}><rect x="-11" y="-12" width="22" height="24" rx="3" fill={i ? '#173f6f' : '#8b2936'} stroke="#d9e3f5" /><text y="4" textAnchor="middle" fill="#fff" stroke="none" style={{ font: '800 14px sans-serif' }}>{i ? hp : power}</text></ScreenPixels>; })}</>;
}
function Reduction({ member, geometry: g, p, start, end = start + .16 }: { member: Member; geometry: Geometry; p: number; start: number; end?: number }) {
    const at = g.cards?.[`${member.item.outcome.seat}:${key(member.old)}`] ?? member.item.box, s = size(at), delta = member.old.p - member.power;
    return <><ScreenPixels at={at} color="#c6b2ec" opacity={envelope(p, start, start + .05, end + .14)}>{Array.from({ length: Math.max(1, delta) }, (_, i) => <path key={i} d={`M${-s.w / 2 - 5} ${-s.h / 2 + (i + 1) * s.h / (Math.max(1, delta) + 1)} H${s.w / 2 + 5}`} strokeWidth="2" strokeDasharray="4 3" />)}<path d={`M${-s.w / 2 - 8} ${-s.h / 2} V${s.h / 2} M${s.w / 2 + 8} ${-s.h / 2} V${s.h / 2}`} strokeWidth="2" /></ScreenPixels><Counters at={at} power={member.power} hp={Math.max(0, member.hp - member.old.d)} p={p} start={end} />{member.death && <><Mask at={at} p={p} start={end + .1} />{member.old.t ? <ScreenPixels at={at} color="#c6b2ec" opacity={envelope(p, end + .1, end + .13, end + .28)}>{Array.from({ length: 6 }, (_, i) => <rect key={i} x={Math.cos(i * Math.PI / 3) * 20 * phase(p, end + .1, end + .28)} y={Math.sin(i * Math.PI / 3) * 20 * phase(p, end + .1, end + .28)} width="5" height="5" fill="currentColor" stroke="none" />)}</ScreenPixels> : <Travel from={at} to={member.death.to} card={member.old} p={p} start={end + .1} end={end + .3} />}</>}</>;
}
function Hello(props: Props) {
    const { cue, geometry: g, p } = props, r = helloProof(cue, g); if (!r) return null;
    const m = r.members[0];
    return <><Payment {...props} /><Receipt at={center(g)} rows={['ENTERED PLAY THIS PHASE', '−4 POWER / −4 MAX HP']} p={p} start={.05} until={.35} /><Reduction member={m} geometry={g} p={p} start={.28} end={.47} /><Receipt at={center(g)} rows={[`${m.power} POWER · ${m.hp - m.old.d} HP REMAINING`, 'PHASE REDUCTION · WOUNDS UNCHANGED']} p={p} start={.72} /></>;
}
function Equalize(props: Props) {
    const { cue, geometry: g, p } = props, r = equalizeProof(cue, g); if (!r) return null;
    return <><Payment {...props} /><Receipt at={center(g)} rows={['FIRST UNIT · −2/−2', 'THEN COUNT CONTROLLED UNITS']} p={p} start={.05} until={.29} /><Reduction member={r.members[0]} geometry={g} p={p} start={.21} end={.34} /><Receipt at={center(g)} rows={[`${cue.seat.toUpperCase()} ${r.ownCount} < ${r.against.toUpperCase()} ${r.otherCount}`, 'DIFFERENT SECOND UNIT · −2/−2']} p={p} start={.38} until={.64} /><Reduction member={r.members[1]} geometry={g} p={p} start={.5} end={.62} /><Receipt at={center(g)} rows={['TWO DISTINCT PHASE REDUCTIONS', ...(r.members.some(m => m.death) ? ['NO REMAINING HP · DEFEATED'] : ['EXISTING WOUNDS STAY'])]} p={p} start={.82} /></>;
}
function HighGround(props: Props) {
    const { cue, geometry: g, p } = props, r = highGroundProof(cue, g); if (!r) return null;
    const at = g.cards?.[`${cue.seat}:${key(r.member.old)}`] ?? r.member.item.box, s = size(at);
    return <><Payment {...props} /><ScreenPixels at={at} color="#a8c7ef" opacity={visible(p, .2)}><path d={`M${-s.w / 2 - 7} ${s.h / 2 + 5} V${-s.h / 2 - 7} L0 ${-s.h / 2 - 20} L${s.w / 2 + 7} ${-s.h / 2 - 7} V${s.h / 2 + 5}`} strokeWidth="2" fill="none" /><path d={`M-16 ${-s.h / 2 - 7} L0 ${-s.h / 2 - 14} L16 ${-s.h / 2 - 7}`} strokeWidth="2" /></ScreenPixels><Receipt at={center(g)} rows={['WHILE THIS UNIT DEFENDS', 'ATTACKER −4 POWER · THIS PHASE']} p={p} start={.22} color="#a8c7ef" /></>;
}
function Guard(props: Props) {
    const { cue, geometry: g, p } = props, r = guardProof(cue, g); if (!r) return null;
    const at = g.cards?.[`${r.keyword.outcome.seat}:${key(r.member.old)}`] ?? r.keyword.box, s = size(at);
    return <><Payment {...props} /><ScreenPixels at={at} color="#a4d8c5" opacity={visible(p, .22)}><path d={`M${-s.w / 2 - 7} ${-s.h / 2 - 7} V${s.h / 2 + 7} M${s.w / 2 + 7} ${-s.h / 2 - 7} V${s.h / 2 + 7}`} strokeWidth="3" />{[-1, 1].map(side => <path key={side} d={`M${side * (s.w / 2 + 20)} -8 L${side * (s.w / 2 + 9)} 0 L${side * (s.w / 2 + 20)} 8`} strokeWidth="2" />)}</ScreenPixels><Receipt at={center(g)} rows={['SENTINEL · THIS PHASE', r.initiative ? `${cue.seat.toUpperCase()} HAS INITIATIVE · +2/+2` : 'NO INITIATIVE BONUS']} p={p} start={.25} color="#a4d8c5" />{r.initiative && <Counters at={at} power={r.member.power} hp={r.member.hp - r.member.old.d} p={p} start={.48} />}</>;
}
function Burst(props: Props) {
    const { cue, geometry: g, p } = props, r = burstProof(cue, g); if (!r) return null;
    return <><Payment {...props} /><Receipt at={center(g)} rows={[`${r.enemy.toUpperCase()} UNITS · BOTH ARENAS`, `${r.members.length} TARGETS · −1/−1 THIS PHASE`]} p={p} start={.05} until={.34} />{r.members.map(m => <Reduction key={key(m.old)} member={m} geometry={g} p={p} start={.29} end={.46} />)}<Receipt at={center(g)} rows={['SURVIVORS KEEP THEIR WOUNDS', `${r.members.filter(m => m.death && !m.old.t).length} TO DISCARD · ${r.members.filter(m => m.death && m.old.t).length} TOKEN CEASES`]} p={p} start={.81} /></>;
}
export function BatchA09SecondarySignature(props: Props) {
    switch (props.cue.definition.id) {
        case 'hello-there': return <Hello {...props} />;
        case 'equalize': return <Equalize {...props} />;
        case 'i-have-the-high-ground': return <HighGround {...props} />;
        case 'guarding-the-way': return <Guard {...props} />;
        case 'disruptive-burst': return <Burst {...props} />;
        default: return null;
    }
}
