import type { CardRef, Seat, Snapshot, UnitRef } from '../data/types';
import type { CardEffectCue, CardEffectOutcome } from './types';
import { A11_DEFINITIONS } from './batchA11';
import { previewPlayCost } from './previewCosts';
import { easeInOut, envelope, phase } from './animationTimeline';
import { CardGhost, EnergyBeam, ResourceBalance, ResourceSlot, ScreenPixels, mix, screenShift as shift, type EffectBox, type PlacedOutcome } from './primitives';

type Geometry = { source: EffectBox; target: EffectBox; friendlyBase: EffectBox; outcomes: PlacedOutcome[]; zones: Record<string, EffectBox>; cards?: Record<string, EffectBox>; endingCards?: Record<string, EffectBox>; resourceCards?: Record<string, EffectBox> };
type Props = { cue: CardEffectCue; geometry: Geometry; p: number };
const ids = new Set(['corner-the-prey', 'selfdestruct', 'unlimited-power', 'grim-resolve', 'caught-in-the-crossfire']);
export const isBatchA11 = (cue: CardEffectCue) => ids.has(cue.definition.id);
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
const units = (s: Snapshot, seat: Seat) => [...s.players[seat].ground, ...s.players[seat].space];
const refs = (s: Snapshot) => seats.flatMap(seat => { const p = s.players[seat]; return [p.base, ...(p.leader ? [p.leader] : []), ...p.hand, ...p.discard, ...(p.resources ?? []), ...(p.knownDeck ?? []), ...units(s, seat), ...units(s, seat).flatMap(u => [...(u.u ?? []), ...(u.cap ?? [])])]; });
function locate(cue: CardEffectCue, c?: CardRef | null) {
    if (!c?.id || !cue.transition) return;
    const found = seats.flatMap(seat => (['ground', 'space'] as const).flatMap(zone => cue.transition!.before.players[seat][zone].filter(u => same(u, c)).map(unit => ({ unit, seat, zone }))));
    return found.length === 1 && found[0].unit.d < found[0].unit.h && !!found[0].unit.incarnation ? found[0] : undefined;
}
type Located = NonNullable<ReturnType<typeof locate>>;
type Death = { item: PlacedOutcome; target: Located };
const eventSource = (cue: CardEffectCue, o: CardEffectOutcome) => refEqual(cue.source, o.sourceCard);
/** Narrow rich recipes refuse unclaimed cause, choice, trigger and payment metadata. */
const allowed = (o: CardEffectOutcome, extra: string[]) => Object.keys(o).every(k => ['kind', 'card', 'seat', 'zone', 'sourceCard', 'incarnation', 'prevented', 'label', ...extra].includes(k));
function eventProof(cue: CardEffectCue) {
    const d = A11_DEFINITIONS.find(d => d.id === cue.definition.id), t = cue.transition;
    if (!d || !t || cue.stage || cue.definition.name !== d.name || cue.definition.setCode !== d.setCode || !cue.source?.id || cue.source.n !== d.name || cue.source.s !== d.setCode || cue.source.owner !== cue.seat
        || t.before.round !== t.after.round || t.before.phase !== t.after.phase || t.before.initiative !== t.after.initiative || cue.playPayment?.kind !== 'resources' || cue.playPayment.smuggle || cue.playPayment.exploit) return;
    let cost: number; try { cost = previewPlayCost(d, t.before, cue.seat, cue.playPayment); } catch { return; }
    const paid = cue.playPayment.cardIds;
    if (!paid || cue.playCost !== cost || paid.length !== cost || new Set(paid).size !== cost || refs(t.before).filter(c => same(c, cue.source)).length !== 1 || refs(t.after).filter(c => same(c, cue.source)).length !== 1
        || t.before.players[cue.seat].hand.filter(c => refEqual(c, cue.source)).length !== 1 || t.after.players[cue.seat].discard.filter(c => refEqual(c, cue.source)).length !== 1) return;
    if (!seats.every(seat => {
        const a = t.before.players[seat], b = t.after.players[seat], charged = seat === cue.seat ? paid : [];
        return !!a.resources && !!b.resources && a.resources.length === a.res.total && b.resources.length === b.res.total && ordered(a.resources, b.resources) && a.res.total === b.res.total && a.res.ready - charged.length === b.res.ready
            && a.resources.filter(r => !r.x).length === a.res.ready && b.resources.filter(r => !r.x).length === b.res.ready && charged.every(id => a.resources!.some(r => r.id === id && !r.x))
            && a.resources.every((r, i) => !!b.resources![i].x === (!!r.x || charged.includes(key(r))));
    })) return;
    return { cost, paid };
}
function deathProof(cue: CardEffectCue, item: PlacedOutcome | undefined, target: Located, cause: CardRef, extras: string[] = []) {
    if (!item || !cue.transition) return false;
    const o = item.outcome, u = target.unit, owner = u.owner, summary = owner && cue.transition.before.players[owner].leader, leader = summary?.dep === 1 && same(summary, u);
    return allowed(o, ['ownerSeat', 'leader', ...extras]) && o.kind === 'defeat' && !o.prevented && o.seat === target.seat && o.zone === target.zone && o.incarnation === u.incarnation && !!owner && o.ownerSeat === owner
        && fullUnit(o.card) && equal(o.card, u) && refEqual(o.sourceCard, cause) && !u.cap?.length && (u.u ?? []).every(up => !!up.owner)
        && (leader ? equal(o.leader, { ...summary, dep: 0, x: 1 }) : !o.leader);
}
/** Ending audit permits only witnessed arena wounds/exhaustion, owner cleanup and base damage. */
function endingProof(cue: CardEffectCue, changed: Map<string, UnitRef | null>, deaths: Death[], baseChange?: { seat: Seat; damage: number }) {
    if (!cue.transition || !eventProof(cue)) return false;
    const expected = structuredClone(cue.transition.before), paid = cue.playPayment!.kind === 'resources' ? cue.playPayment!.cardIds! : [];
    for (const seat of seats) {
        const a = expected.players[seat], actual = cue.transition.after.players[seat];
        if (seat === cue.seat) {
            a.hand = a.hand.filter(c => !same(c, cue.source)); a.discard.push(cue.source!); a.res.ready -= paid.length;
            a.resources = a.resources!.map(r => paid.includes(key(r)) ? { ...r, x: 1 } : r);
        }
        for (const zone of ['ground', 'space'] as const) a[zone] = a[zone].flatMap(u => changed.has(key(u)) ? changed.get(key(u)) ? [changed.get(key(u))!] : [] : [u]);
        if (baseChange?.seat === seat) a.base.d = baseChange.damage;
        // Discard snapshots can omit last wounds; identity/owner remain exact.
        if (!ordered(a.hand, actual.hand) || a.deck !== actual.deck || !ordered(a.knownDeck ?? [], actual.knownDeck ?? [])) return false;
    }
    for (const { item, target } of deaths) {
        const u = target.unit, owner = u.owner!;
        for (const up of u.u ?? []) if (!up.t) expected.players[up.owner!].discard.push(up);
        if (item.outcome.leader) expected.players[owner].leader = item.outcome.leader;
        else if (!u.t) expected.players[owner].discard.push(u);
        if (u.t && refs(cue.transition.after).some(c => same(c, u)) || (u.u ?? []).some(up => up.t && refs(cue.transition!.after).some(c => same(c, up)))) return false;
    }
    for (const seat of seats) {
        const a = expected.players[seat], actual = cue.transition.after.players[seat];
        if (!ordered(a.discard, actual.discard)) return false;
        a.hand = actual.hand; a.discard = actual.discard; a.knownDeck = actual.knownDeck;
    }
    return equal(expected, cue.transition.after);
}
function nativeGrit(cue: CardEffectCue, u: UnitRef) {
    const active = u.status?.filter(s => s.keyword?.name === 'Grit' && (s.duration === 'permanent' || s.duration === 'phase' && s.round === cue.transition!.before.round && s.phase === cue.transition!.before.phase && s.incarnation === u.incarnation)) ?? [];
    if (active.some(s => s.kind !== 'keyword' || s.keyword!.amount !== 1)) return;
    const includes = active.length > 0;
    if (u.s === 'SOR_032' && (u.n !== 'Scout Bike Pursuer' || !includes || u.p !== 1 + u.d || u.h !== 4 || u.u?.length)) return;
    return includes;
}
function attackProof(cue: CardEffectCue, g: Geometry, grim: boolean) {
    if (!eventProof(cue) || !cue.transition) return;
    const offset = grim ? 2 : 1, modifier = g.outcomes[grim ? 1 : 0], m = modifier?.outcome, attack = g.outcomes[offset], a = attack?.outcome, attacker = locate(cue, a?.sourceCard);
    if (!m || !a || !attacker || attacker.seat !== cue.seat || attacker.unit.x || grim && seats.some(s => same(cue.transition!.before.players[s].leader, attacker.unit))) return;
    const enemy: Seat = cue.seat === 'p1' ? 'p2' : 'p1', base = cue.transition.before.players[enemy].base, isBase = same(a.card, base), defender = isBase ? undefined : locate(cue, a.card), target = defender?.unit ?? base;
    if (!isBase && (!defender || defender.seat !== enemy || defender.zone !== attacker.zone) || cue.transition.before.players[enemy][attacker.zone].some(u => u.sn) && (isBase || !defender?.unit.sn)
        || attacker.unit.u?.some(u => u.t && u.n === 'Shield') || defender?.unit.u?.some(u => u.t && u.n === 'Shield')) return;
    let bonus: number;
    if (grim) {
        const includes = nativeGrit(cue, attacker.unit), witness = { attackerId: key(attacker.unit), incarnation: attacker.unit.incarnation!, damage: attacker.unit.d, powerIncludesGrit: includes };
        const keyword = g.outcomes[0]?.outcome;
        if (includes === undefined || !keyword || !allowed(keyword, ['keyword', 'duration', 'attackId', 'gritBasis']) || keyword.kind !== 'keyword' || keyword.prevented || keyword.seat !== cue.seat || keyword.zone !== attacker.zone || !equal(keyword.card, attacker.unit) || keyword.incarnation !== attacker.unit.incarnation || !eventSource(cue, keyword)
            || keyword.duration !== 'attack' || !equal(keyword.keyword, { name: 'Grit', amount: 1 }) || keyword.attackId !== a.attackId || !equal(keyword.gritBasis, witness) || !equal(m.gritBasis, witness)) return;
        bonus = includes ? 0 : attacker.unit.d;
    } else {
        bonus = defender?.unit.d ?? 0;
        if (!equal(m.defenderDamageAtStart, { defenderId: key(target), ...(defender ? { incarnation: defender.unit.incarnation } : {}), zone: isBase ? 'base' : defender!.zone, damage: bonus })) return;
    }
    if (!allowed(m, ['amount', 'duration', 'attackId', grim ? 'gritBasis' : 'defenderDamageAtStart']) || m.kind !== 'buff' || m.prevented || m.seat !== cue.seat || m.zone !== attacker.zone || m.incarnation !== attacker.unit.incarnation || !equal(m.card, attacker.unit) || !eventSource(cue, m) || m.duration !== 'attack' || m.amount !== `+${bonus}/+0` || !a.attackId || m.attackId !== a.attackId
        || !allowed(a, ['attackId', 'combatOrder']) || a.kind !== 'attack' || a.prevented || a.seat !== enemy || a.zone !== (isBase ? 'base' : defender!.zone) || a.incarnation !== attacker.unit.incarnation || a.combatOrder !== 'simultaneous' || !equal(a.card, target) || !equal(a.sourceCard, attacker.unit)) return;
    const exhaust = g.outcomes[offset + 1], e = exhaust?.outcome, forward = g.outcomes[offset + 2], f = forward?.outcome, counter = defender ? g.outcomes[offset + 3] : undefined, c = counter?.outcome;
    if (!e || !allowed(e, ['attackId']) || e.kind !== 'exhaust' || e.prevented || e.seat !== cue.seat || e.zone !== attacker.zone || e.incarnation !== attacker.unit.incarnation || !equal(e.card, attacker.unit) || !eventSource(cue, e) || e.attackId !== a.attackId) return;
    const hit = (o: CardEffectOutcome | undefined, recipient: CardRef, source: UnitRef, seat: Seat, zone: CardEffectOutcome['zone'], amount: number, index: number) => !!o && allowed(o, ['amount', 'damageType', 'attackId', 'attackIndex']) && o.kind === 'damage' && !o.prevented && o.damageType === 'combat' && o.attackId === a.attackId && o.attackIndex === index && o.seat === seat && o.zone === zone && equal(o.card, recipient) && refEqual(o.sourceCard, source) && o.amount === amount && o.incarnation === undefined;
    const power = attacker.unit.p + bonus;
    if (!hit(f, target, attacker.unit, enemy, isBase ? 'base' : defender!.zone, power, 1) || defender && !hit(c, attacker.unit, defender.unit, cue.seat, attacker.zone, defender.unit.p, 2)) return;
    const changed = new Map<string, UnitRef | null>(), deaths: Death[] = [], cleanup = g.outcomes.slice(offset + (defender ? 4 : 3));
    const recipients = [...(defender ? [{ t: attacker, damage: defender.unit.p, cause: defender.unit }] : []), ...(defender ? [{ t: defender, damage: power, cause: attacker.unit }] : [])];
    changed.set(key(attacker.unit), { ...attacker.unit, x: 1, d: attacker.unit.d + (defender?.unit.p ?? 0) });
    for (const r of recipients) {
        if (r.t.unit.d + r.damage >= r.t.unit.h) {
            const item = cleanup.find(i => same(i.outcome.card, r.t.unit));
            if (!deathProof(cue, item, r.t, r.cause, ['attackId']) || item!.outcome.attackId !== a.attackId) return;
            deaths.push({ item: item!, target: r.t }); changed.set(key(r.t.unit), null);
        } else {
            const grit = nativeGrit(cue, r.t.unit);
            if (grit === undefined || grit && r.damage > 0) return;
            changed.set(key(r.t.unit), { ...r.t.unit, d: r.t.unit.d + r.damage, ...(r.t === attacker ? { x: 1 as const } : {}) });
        }
    }
    if (cleanup.length !== deaths.length || new Set(cleanup).size !== deaths.length || !endingProof(cue, changed, deaths, isBase ? { seat: enemy, damage: base.d + power } : undefined)) return;
    return { attacker, defender, target, attack, forward, counter, bonus, power, grim, changed, deaths, items: g.outcomes };
}
function selfProof(cue: CardEffectCue, g: Geometry) {
    if (!eventProof(cue) || !cue.transition || ![2, 3].includes(g.outcomes.length)) return;
    const first = g.outcomes[0], sacrifice = locate(cue, first.outcome.card), hit = g.outcomes[1], o = hit.outcome, target = locate(cue, o.card);
    if (!sacrifice || sacrifice.seat !== cue.seat || !deathProof(cue, first, sacrifice, cue.source!) || !target || same(sacrifice.unit, target.unit)
        || !allowed(o, ['amount', 'damageType', 'requiresDefeat']) || o.kind !== 'damage' || o.prevented || o.damageType !== 'ability' || o.seat !== target.seat || o.zone !== target.zone || o.incarnation !== target.unit.incarnation || !equal(o.card, target.unit) || !eventSource(cue, o) || o.amount !== 4
        || !equal(o.requiresDefeat, { id: key(sacrifice.unit), incarnation: sacrifice.unit.incarnation }) || target.unit.u?.some(u => u.t && u.n === 'Shield')) return;
    const changed = new Map<string, UnitRef | null>([[key(sacrifice.unit), null]]), deaths: Death[] = [{ item: first, target: sacrifice }], fatal = target.unit.d + 4 >= target.unit.h;
    if (fatal) { if (g.outcomes.length !== 3 || !deathProof(cue, g.outcomes[2], target, cue.source!)) return; deaths.push({ item: g.outcomes[2], target }); changed.set(key(target.unit), null); }
    else { if (g.outcomes.length !== 2 || nativeGrit(cue, target.unit)) return; changed.set(key(target.unit), { ...target.unit, d: target.unit.d + 4 }); }
    if (!endingProof(cue, changed, deaths)) return;
    return { sacrifice, target, first, hit, changed, deaths, items: g.outcomes };
}
function windowProof(cue: CardEffectCue, g: Geometry, reciprocal: boolean) {
    if (!eventProof(cue) || !cue.transition) return;
    const hits = g.outcomes.filter(i => i.outcome.kind === 'damage'), cleanup = g.outcomes.slice(hits.length), count = reciprocal ? 2 : 4, group = hits[0]?.outcome.resolutionGroup;
    if (hits.length !== count || !group?.id || group.mode !== 'simultaneous' || g.outcomes.slice(0, count).some(i => i.outcome.kind !== 'damage') || new Set(hits.map(i => key(i.outcome.card))).size !== count || cleanup.some(i => i.outcome.kind !== 'defeat')) return;
    const members: { hit: PlacedOutcome; target: Located; amount: number; cause: CardRef }[] = [], changed = new Map<string, UnitRef | null>(), deaths: Death[] = [], window = hits[0].outcome.powerWindow;
    const selected = hits.map(i => locate(cue, i.outcome.card));
    if (selected.some(t => !t)) return;
    if (reciprocal && (selected.some(t => t!.seat === cue.seat) || selected[0]!.zone !== selected[1]!.zone || !window?.id || window.id !== group.id || window.members.length !== 2 || new Set(window.members.map(m => m.id)).size !== 2 || !window.members.every(m => { const t = selected.find(t => key(t!.unit) === m.id)!; return !!t && equal(m, { id: key(t.unit), incarnation: t.unit.incarnation, power: t.unit.p, controller: t.seat }); }))) return;
    for (let i = 0; i < hits.length; i++) {
        const item = hits[i], o = item.outcome, t = selected[i]!, source = reciprocal ? selected[1 - i]!.unit : cue.source!, amount = reciprocal ? (source as UnitRef).p : 4 - i;
        if (!allowed(o, ['amount', 'damageType', 'resolutionGroup', ...(reciprocal ? ['powerWindow', 'basis'] : [])]) || o.prevented || o.damageType !== 'ability' || o.seat !== t.seat || o.zone !== t.zone || o.incarnation !== t.unit.incarnation || !equal(o.card, t.unit) || !refEqual(o.sourceCard, source) || o.amount !== amount || !equal(o.resolutionGroup, group)
            || reciprocal && (!equal(o.powerWindow, window) || !equal(o.basis, { kind: 'source-power', sourceIds: [key(source)], value: amount })) || t.unit.u?.some(u => u.t && u.n === 'Shield')) return;
        if (t.unit.d + amount >= t.unit.h) {
            const death = cleanup.find(d => same(d.outcome.card, t.unit));
            if (!deathProof(cue, death, t, source, ['resolutionGroup']) || !equal(death!.outcome.resolutionGroup, group)) return;
            deaths.push({ item: death!, target: t }); changed.set(key(t.unit), null);
        } else { if (amount > 0 && nativeGrit(cue, t.unit)) return; changed.set(key(t.unit), { ...t.unit, d: t.unit.d + amount }); }
        members.push({ hit: item, target: t, amount, cause: source });
    }
    // Cleanup order is explicit and does not turn simultaneous hits into sequential combat.
    const orderedDeaths = cleanup.map(item => deaths.find(d => d.item === item));
    if (cleanup.length !== deaths.length || orderedDeaths.some(d => !d) || new Set(cleanup).size !== deaths.length || !endingProof(cue, changed, orderedDeaths as Death[])) return;
    return { members, changed, deaths: orderedDeaths as Death[], reciprocal, window, items: g.outcomes };
}
function recipe(cue: CardEffectCue, g: Geometry) {
    switch (cue.definition.id) {
        case 'corner-the-prey': return attackProof(cue, g, false);
        case 'grim-resolve': return attackProof(cue, g, true);
        case 'selfdestruct': return selfProof(cue, g);
        case 'unlimited-power': return windowProof(cue, g, false);
        case 'caught-in-the-crossfire': return windowProof(cue, g, true);
    }
}
export const batchA11Covers = (cue: CardEffectCue, g: Geometry, item: PlacedOutcome) => recipe(cue, g)?.items.includes(item) ?? false;

const size = (at: EffectBox) => at.cardSize ?? { w: at.w * (at.sx ?? 1), h: at.h * (at.sy ?? 1) };
const visible = (p: number, start: number) => phase(p, start, start + .035);
const bound = (at: EffectBox, w: number, h: number): EffectBox => ({ ...at, x: Math.max((w / 2 + 8) / (at.sx ?? 1), Math.min(1000 - (w / 2 + 8) / (at.sx ?? 1), at.x)), y: Math.max((h / 2 + 40) / (at.sy ?? 1), Math.min(600 - (h / 2 + 122) / (at.sy ?? 1), at.y)) });
const side = (g: Geometry) => shift({ ...g.friendlyBase, x: 1000 }, 0, 24);
function Receipt({ at, rows, p, start, until, color = '#e9bd8f' }: { at: EffectBox; rows: string[]; p: number; start: number; until?: number; color?: string }) {
    const w = Math.min(320, Math.max(100, ...rows.map(r => r.length * 5.4 + 20))), h = rows.length * 16 + 8;
    return <ScreenPixels at={bound(at, w, h)} color={color} opacity={visible(p, start) * (until ? 1 - phase(p, until - .05, until) : 1)}><rect x={-w / 2} y={-h / 2} width={w} height={h} rx="4" fill="#09121e" fillOpacity=".98" strokeWidth="1" />{rows.map((r, i) => <text key={i} y={-h / 2 + 14 + i * 16} textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '700 8px var(--font-display,sans-serif)' }}>{r}</text>)}</ScreenPixels>;
}
function Mask({ at, p, start }: { at: EffectBox; p: number; start: number }) { const s = size(at); return <ScreenPixels at={at} opacity={visible(p, start)}><rect x={-s.w / 2 - 4} y={-s.h / 2 - 4} width={s.w + 8} height={s.h + 8} rx="5" fill="#0b1420" stroke="none" /></ScreenPixels>; }
function CompactFlight({ from, to, card, p, start, end, token = false }: { from: EffectBox; to: EffectBox; card: CardRef; p: number; start: number; end: number; token?: boolean }) {
    if (p < start) return null;
    const t = easeInOut(phase(p, start, end)), corridor = 16 / (from.sx ?? 1), approach = shift(to, 0, 24), route = [from, { ...from, x: corridor }, { ...approach, x: corridor }, approach, to], leg = Math.min(3, Math.floor(t * 4)), at = { ...from, ...mix(route[leg], route[leg + 1], Math.min(1, t * 4 - leg)) };
    return <ScreenPixels at={token ? from : at} color="#e9ad84" opacity={visible(p, start) * (1 - phase(p, end - .04, end))}><g transform={`scale(${token ? 1 - t : 1})`}><CardGhost card={card} box={{ w: 20, h: 28 }} /></g></ScreenPixels>;
}
function Payment({ cue, geometry: g, p }: Props) {
    const proof = eventProof(cue); if (!proof || !cue.transition || !cue.source) return null;
    const before = cue.transition.before.players[cue.seat], to = g.zones[cue.seat + ':discard'];
    return <><ResourceBalance at={g.zones[cue.seat + ':resources']} countAt={g.zones[cue.seat + ':resource-count']} ready={before.res.ready - proof.cost} total={before.res.total} p={p} start={.04} />{before.resources?.map((r, i) => { const at = g.resourceCards?.[cue.seat + ':' + key(r)]; return at && proof.paid.includes(key(r)) ? <ResourceSlot key={key(r)} at={at} index={i} spent p={p} start={.04} /> : null; })}<Mask at={g.source} p={p} start={.04} />{to && <CompactFlight from={g.source} to={to} card={cue.source} p={p} start={.04} end={.21} />}</>;
}
function Stats({ at, unit, p, start }: { at: EffectBox; unit: UnitRef; p: number; start: number }) {
    return <>{(['power', 'hp'] as const).map((name, i) => { const s = size(at), c = at.counters?.[name], place = c ? { ...at, ...c } : shift(at, (i ? 1 : -1) * (s.w / 2 - 10), s.h / 2 - 11), w = c ? c.w * (at.sx ?? 1) + 2 : 20, h = c ? c.h * (at.sy ?? 1) + 2 : 22; return <ScreenPixels key={name} at={place} opacity={visible(p, start)}><rect x={-w / 2} y={-h / 2} width={w} height={h} rx="3" fill={i ? '#173f6f' : '#8b2936'} stroke="#f4dfc8" strokeWidth="1" /><text textAnchor="middle" y="4" fill="#fff" stroke="none" style={{ font: '800 12px sans-serif' }}>{i ? Math.max(0, unit.h - unit.d) : unit.p}</text></ScreenPixels>; })}</>;
}
function UnitFace({ at, unit, p, start, label, persistent = false }: { at: EffectBox; unit: UnitRef; p: number; start: number; label?: string; persistent?: boolean }) {
    const s = size(at), turn = unit.x ? 10 * visible(p, start) : 0;
    return <ScreenPixels at={at} opacity={persistent ? 1 : visible(p, start)} color="#e8bc8e"><g transform={`rotate(${turn}) scale(${unit.x ? .94 : 1})`} opacity={unit.x ? .72 : 1}><CardGhost card={unit} box={s} />{unit.sn && <text x={-s.w / 2 + 4} y={-s.h / 2 + 10} fill="#f6edd9" stroke="none" style={{ font: '700 7px sans-serif' }}>SEN</text>}{label && <><rect x={-s.w / 2 + 2} y={-9} width={s.w - 4} height="15" rx="2" fill="#101925" strokeWidth=".7" /><text y="1" textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '800 8px sans-serif' }}>{label}</text></>}{[-1, 1].map(i => <g key={i} transform={`translate(${i * (s.w / 2 - 10)} ${s.h / 2 - 11})`}><rect x="-9" y="-10" width="18" height="20" rx="3" fill={i < 0 ? '#8b2936' : '#173f6f'} /><text textAnchor="middle" y="4" fill="#fff" stroke="none" style={{ font: '800 12px sans-serif' }}>{i < 0 ? unit.p : Math.max(0, unit.h - unit.d)}</text></g>)}</g></ScreenPixels>;
}
const cardAt = (g: Geometry, t: Located) => g.cards?.[t.seat + ':' + key(t.unit)] ?? g.zones[t.seat + ':' + t.zone];
function Settle({ cue, geometry: g, p }: Props) {
    if (!cue.transition || p < .8) return null;
    return <>{seats.flatMap(seat => units(cue.transition!.after, seat).map(unit => {
        const old = locate(cue, unit), from = old && cardAt(g, old), to = g.endingCards?.[seat + ':' + key(unit)];
        if (!from || !to || Math.hypot((to.x - from.x) * (from.sx ?? 1), (to.y - from.y) * (from.sy ?? 1)) < 1) return null;
        const at = { ...to, ...mix(from, to, easeInOut(phase(p, .8, .94))) };
        return <g key={seat + ':' + key(unit)}><Mask at={from} p={p} start={.8} /><UnitFace at={at} unit={unit} p={p} start={.8} persistent label={unit.status?.some(s => s.keyword?.name === 'Grit') ? 'GRIT' : undefined} /></g>;
    }))}</>;
}
function Departure({ geometry: g, p, death, start, end }: Props & { death: Death; start: number; end: number }) {
    const u = death.target.unit, from = cardAt(g, death.target), owner = u.owner!, to = death.item.outcome.leader ? g.endingCards?.[owner + ':' + key(u)] ?? g.zones[owner + ':leader'] : g.zones[owner + ':discard'];
    return <><Mask at={from} p={p} start={start} />{to && <CompactFlight from={from} to={to} card={u} p={p} start={start} end={end} token={!!u.t} />}{(u.u ?? []).map((up, i) => { const box = g.cards?.[death.target.seat + ':' + key(up)] ?? from, target = g.zones[up.owner! + ':discard']; return target ? <CompactFlight key={key(up)} from={box} to={target} card={up} p={p} start={start + i * .01} end={end} token={!!up.t} /> : null; })}{u.t && <Receipt at={side(g)} rows={['TOKEN CEASES']} p={p} start={start + .02} until={end + .05} />}</>;
}
function Attack(props: Props) {
    const { cue, geometry: g, p } = props, grim = cue.definition.id === 'grim-resolve', r = attackProof(cue, g, grim); if (!r) return null;
    const from = cardAt(g, r.attacker), target = r.defender ? cardAt(g, r.defender) : r.forward.box, ownDeath = r.deaths.some(d => same(d.target.unit, r.attacker.unit)), after = r.changed.get(key(r.attacker.unit)), attackUnit = { ...r.attacker.unit, p: r.power, x: 1 as const };
    return <><Payment {...props} /><Receipt at={side(g)} rows={grim ? [`OWN WOUNDS ${r.attacker.unit.d}`, r.bonus ? `GRIT · ${r.attacker.unit.p} + ${r.bonus} = ${r.power}` : `GRIT ALREADY COUNTED · POWER ${r.power}`, 'ONE ATTACK'] : [`DEFENDER START WOUNDS ${r.bonus}`, `ATTACK ${r.attacker.unit.p} + ${r.bonus} = ${r.power}`, 'ONE ATTACK']} p={p} start={.07} until={.39} />
        <Mask at={from} p={p} start={.23} />{(!ownDeath || p < .61) && <UnitFace at={from} unit={p >= .76 && after ? after : { ...attackUnit, d: r.attacker.unit.d + (p >= .53 && r.counter ? Number(r.counter.outcome.amount) : 0) }} p={p} start={.23} label={p >= .76 ? nativeGrit(cue, r.attacker.unit) ? 'GRIT' : undefined : grim ? 'GRIT' : `ATTACK ${r.power}`} />}
        <EnergyBeam from={from} to={target} p={p} start={.39} end={.53} color="#eda46d" width={5} />{r.counter && <EnergyBeam from={target} to={from} p={p} start={.39} end={.53} color="#a8c5e8" width={4} />}
        {r.defender && <Stats at={target} unit={{ ...r.defender.unit, d: r.defender.unit.d + r.power }} p={p} start={.53} />}
        {!r.defender && <ScreenPixels at={target.stat ? { ...target, ...target.stat } : target} opacity={visible(p, .53)}><circle r="24" fill="#101725" stroke="#e9a06b" strokeWidth="3" /><text y="6" textAnchor="middle" fill="#ffefe0" stroke="none" style={{ font: '800 19px sans-serif' }}>{cue.transition!.after.players[r.forward.outcome.seat].base.hp - cue.transition!.after.players[r.forward.outcome.seat].base.d}</text></ScreenPixels>}
        {r.deaths.map(death => <Departure key={key(death.target.unit)} {...props} death={death} start={.61} end={.75} />)}
        <Settle {...props} />
        <Receipt at={side(g)} rows={ownDeath ? ['ACTUAL OWNER DESTINATIONS', 'ATTACK BONUS ENDS'] : [`RESTING POWER ${r.attacker.unit.p}`, `WOUNDS ${after?.d ?? r.attacker.unit.d} · EXHAUSTED`, 'ATTACK BONUS ENDS']} p={p} start={.82} />
    </>;
}
function Self(props: Props) {
    const { cue, geometry: g, p } = props, r = selfProof(cue, g); if (!r) return null;
    const source = g.zones[cue.seat + ':discard'] ?? g.source, target = cardAt(g, r.target), targetDeath = r.deaths.find(d => same(d.target.unit, r.target.unit));
    return <><Payment {...props} /><Receipt at={side(g)} rows={['FRIENDLY UNIT DEFEATED', 'THEN DEAL 4 TO A UNIT']} p={p} start={.07} until={.45} /><Departure {...props} death={r.deaths[0]} start={.25} end={.41} />
        <EnergyBeam from={source} to={target} p={p} start={.47} end={.61} color="#e8a17a" width={5} /><Stats at={target} unit={{ ...r.target.unit, d: r.target.unit.d + 4 }} p={p} start={.61} />{targetDeath && <Departure {...props} death={targetDeath} start={.67} end={.81} />}
        <Settle {...props} />
        <Receipt at={side(g)} rows={['SUCCESSFUL SACRIFICE → DAMAGE 4', targetDeath ? 'BOTH ACTUAL OWNER DESTINATIONS' : 'TARGET WOUNDS +4', 'NO ATTACK']} p={p} start={.85} />
    </>;
}
function Window(props: Props) {
    const { cue, geometry: g, p } = props, reciprocal = cue.definition.id === 'caught-in-the-crossfire', r = windowProof(cue, g, reciprocal); if (!r) return null;
    const gather = shift(g.friendlyBase, 0, -size(g.friendlyBase).h / 2 - 15);
    return <><Payment {...props} /><Receipt at={side(g)} rows={reciprocal ? ['TWO ENEMY UNITS · SAME ARENA', 'CURRENT POWERS SEALED', 'ABILITY DAMAGE · NO ATTACK'] : ['FOUR DISTINCT UNITS', 'DAMAGE 4 / 3 / 2 / 1', 'SIMULTANEOUS']} p={p} start={.07} until={.48} />
        {r.members.map(({ hit, target, amount, cause }) => {
            const at = cardAt(g, target), from = reciprocal ? cardAt(g, r.members.find(m => same(m.target.unit, cause))!.target) : gather, s = size(at);
            return <g key={key(target.unit)}><ScreenPixels at={at} color="#e8ad83" opacity={envelope(p, .22, .29, .55)}><rect x={-s.w / 2 - 2} y={-s.h / 2 - 2} width={s.w + 4} height={s.h + 4} rx="4" strokeWidth="1.5" /><rect x={-s.w / 2 + 2} y={-9} width={s.w - 4} height="18" rx="2" fill="#111927" /><text y="4" textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '800 13px sans-serif' }}>{reciprocal ? `${target.unit.p} →` : `HIT ${amount}`}</text></ScreenPixels><EnergyBeam from={from} to={at} p={p} start={.38} end={.54} color={amount > 2 ? '#ed9b70' : '#e0c3a4'} width={2 + amount} /><Stats at={hit.box} unit={{ ...target.unit, d: target.unit.d + amount }} p={p} start={.54} /></g>;
        })}
        {r.deaths.map(death => <Departure key={key(death.target.unit)} {...props} death={death} start={.64} end={.79} />)}
        <Settle {...props} />
        <Receipt at={side(g)} rows={reciprocal ? ['BOTH UNIT POWERS DEALT TOGETHER', 'SURVIVING WOUNDS REMAIN', 'POSES UNCHANGED'] : ['ALL FOUR HITS LANDED TOGETHER', 'ACTUAL OWNER DESTINATIONS', 'SURVIVING WOUNDS REMAIN']} p={p} start={.84} />
    </>;
}
export function BatchA11Signature(props: Props) {
    switch (props.cue.definition.id) {
        case 'corner-the-prey': case 'grim-resolve': return <Attack {...props} />;
        case 'selfdestruct': return <Self {...props} />;
        case 'unlimited-power': case 'caught-in-the-crossfire': return <Window {...props} />;
        default: return null;
    }
}
