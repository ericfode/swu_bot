import type { CardRef, Seat, UnitRef } from '../data/types';
import type { CardEffectCue, CardEffectOutcome } from './types';
import { easeInOut, easeOut, envelope, phase } from './animationTimeline';
import { AbilityGlyph, AttachmentMask, CardGhost, CountedMarks, FracturedCard, ResourceBalance, ResourceSlot, ScreenPixels, mix, screenShift as shift, type EffectBox, type PlacedOutcome } from './primitives';

type Geometry = { source: EffectBox; target: EffectBox; friendlyBase: EffectBox; outcomes: PlacedOutcome[]; zones: Record<string, EffectBox>; cards?: Record<string, EffectBox>; endingCards?: Record<string, EffectBox>; pockets?: Record<string, EffectBox>; endingPockets?: Record<string, EffectBox>; endingCaptured?: Record<string, EffectBox>; resourceCards?: Record<string, EffectBox>; endingResources?: Record<string, EffectBox> };
type Props = { cue: CardEffectCue; geometry: Geometry; p: number };
const ids = new Set(['timely-intervention', 'choose-sides', 'give-in-to-your-anger', 'headhunting', 'detention-block-rescue']);
export const isBatchA06 = (cue: CardEffectCue) => ids.has(cue.definition.id);
const key = (card?: CardRef | null) => card?.id ?? `${card?.s ?? ''}:${card?.n ?? ''}`;
const same = (a?: CardRef | null, b?: CardRef | null) => !!a && !!b && key(a) === key(b);
const number = (o: CardEffectOutcome) => typeof o.amount === 'number' ? o.amount : NaN;
const size = (at: EffectBox) => at.cardSize ?? { w: at.w * (at.sx ?? 1), h: at.h * (at.sy ?? 1) };
const visible = (p: number, start: number) => phase(p, start, start + .055);
const unitIn = (cue: CardEffectCue, card: CardRef | null | undefined, seat: Seat, after = false) => {
    const player = cue.transition?.[after ? 'after' : 'before'].players[seat];
    return [...(player?.ground ?? []), ...(player?.space ?? [])].find(unit => same(unit, card));
};
const cardAt = (g: Geometry, card: CardRef, seat: Seat, zone = 'ground') => g.cards?.[`${seat}:${key(card)}`] ?? g.zones[`${seat}:${zone}`];
const bounded = (at: EffectBox, w = 120, h = 24): EffectBox => ({ ...at,
    x: Math.max((w / 2 + 8) / (at.sx ?? 1), Math.min(1000 - (w / 2 + 8) / (at.sx ?? 1), at.x)),
    y: Math.max((h / 2 + 40) / (at.sy ?? 1), Math.min(600 - (h / 2 + 122) / (at.sy ?? 1), at.y)) });
const center = (g: Geometry) => {
    const upper = g.zones['p2:ground'], base = g.zones['p1:base'];
    const lower = base?.stat ? Math.min(base.y - base.h / 2, base.stat.y - base.stat.h / 2) : base?.y - (base?.h ?? 0) / 2;
    return bounded({ ...g.source, x: 500, y: upper && base ? (upper.y + upper.h / 2 + lower) / 2 : 300 });
};
function Receipt({ at, rows, p, start = .7, until, color = '#dbe6ff' }: { at: EffectBox; rows: string[]; p: number; start?: number; until?: number; color?: string }) {
    const w = Math.min(242, Math.max(54, ...rows.map(row => row.length * 4.8 + 18))), h = rows.length * 16 + 6;
    return <ScreenPixels at={bounded(at, w, h)} color={color} opacity={visible(p, start) * (until ? 1 - phase(p, until - .07, until) : 1)}><rect x={-w / 2} y={-h / 2} width={w} height={h} rx="4" fill="#08111e" fillOpacity=".97" strokeWidth="1" />{rows.map((row, i) => <text key={i} y={-h / 2 + 14 + i * 16} textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '700 9px var(--font-display,sans-serif)' }}>{row}</text>)}</ScreenPixels>;
}
function Mask({ at, p, start, immediate = false }: { at: EffectBox; p: number; start: number; immediate?: boolean }) {
    const s = size(at);
    return <ScreenPixels at={at} opacity={immediate ? p >= start ? 1 : 0 : visible(p, start)}><rect x={-s.w / 2 - 5} y={-s.h / 2 - 5} width={s.w + 10} height={s.h + 10} rx="5" fill="#09121f" stroke="none" /></ScreenPixels>;
}
function Travel({ from, to, card, unit, p, start, end, back = false, initialSize, until, preservePose = false, continuing = false, color = '#cce5da' }: { from: EffectBox; to: EffectBox; card: CardRef; unit?: UnitRef; p: number; start: number; end: number; back?: boolean; initialSize?: { w: number; h: number }; until?: number; preservePose?: boolean; continuing?: boolean; color?: string }) {
    if (p < start) return null;
    const t = easeInOut(phase(p, start, end)), c = shift({ ...from, ...mix(from, to, .5) }, 20, -40);
    const at = { ...from, x: (1 - t) ** 2 * from.x + 2 * (1 - t) * t * c.x + t * t * to.x, y: (1 - t) ** 2 * from.y + 2 * (1 - t) * t * c.y + t * t * to.y };
    const a = initialSize ?? from.cardSize ?? { w: 42, h: 58.8 }, b = size(to), w = a.w + (b.w - a.w) * t, h = a.h + (b.h - a.h) * t, exhausted = unit?.x === 1;
    return <><path d={`M${from.x} ${from.y} Q${c.x} ${c.y} ${to.x} ${to.y}`} pathLength="1" strokeDasharray="1" strokeDashoffset={1 - t} stroke={color} strokeWidth="2" opacity={envelope(p, start, start + .05, end + .09)} /><ScreenPixels at={at} color={color} opacity={(continuing ? 1 : visible(p, start)) * (until ? 1 - phase(p, until - .035, until) : 1)}><g transform={`rotate(${preservePose ? exhausted ? 10 : 0 : exhausted ? 10 * t : -7 * Math.sin(t * Math.PI)}) scale(${exhausted ? preservePose ? .94 : 1 - .06 * t : 1})`} opacity={exhausted ? preservePose ? .72 : 1 - .28 * t : 1}><CardGhost card={card} back={back} box={{ w, h }} />{unit && [-1, 1].map(side => <g key={side} transform={`translate(${side * (w / 2 - 10)} ${h / 2 - 11})`}><rect x="-9" y="-10" width="18" height="20" rx="3" fill={side < 0 ? '#8b2936' : '#173f6f'} /><text textAnchor="middle" y="4" fill="#fff" stroke="none" style={{ font: '800 12px sans-serif' }}>{side < 0 ? unit.p : unit.h - unit.d}</text></g>)}</g></ScreenPixels></>;
}
function Stats({ at, unit, p, start }: { at: EffectBox; unit: UnitRef; p: number; start: number }) {
    return <>{(['power', 'hp'] as const).map((name, i) => {
        const s = size(at), counter = at.counters?.[name], position = counter ? { ...at, ...counter } : shift(at, (i ? 1 : -1) * (s.w / 2 - 10), s.h / 2 - 12);
        const w = counter ? counter.w * (at.sx ?? 1) + 2 : 22, h = counter ? counter.h * (at.sy ?? 1) + 2 : 24;
        return <ScreenPixels key={name} at={position} opacity={visible(p, start)}><rect x={-w / 2} y={-h / 2} width={w} height={h} rx="3" fill={i ? '#173f6f' : '#8b2936'} stroke="#dce7f8" strokeWidth="1" /><text textAnchor="middle" y="4" fill="#fff" stroke="none" style={{ font: '800 14px sans-serif' }}>{i ? unit.h - unit.d : unit.p}</text></ScreenPixels>;
    })}</>;
}
function EventPayment({ cue, geometry: g, p }: Props) {
    const before = cue.transition?.before.players[cue.seat], ids = cue.playPayment?.kind === 'resources' ? cue.playPayment.cardIds : undefined;
    if (!before?.resources || !ids || ids.length !== cue.playCost) return null;
    return <><Mask at={g.source} p={p} start={.04} /><ResourceBalance at={g.zones[`${cue.seat}:resources`]} countAt={g.zones[`${cue.seat}:resource-count`]} ready={before.res.ready - cue.playCost!} total={before.res.total} p={p} start={.04} />{before.resources.map((resource, i) => {
        const at = g.resourceCards?.[`${cue.seat}:${key(resource)}`];
        return at && ids.includes(key(resource)) ? <ResourceSlot key={key(resource)} at={at} index={i} spent p={p} start={.04} /> : null;
    })}</>;
}

const fullUnit = (card?: CardRef | null): card is UnitRef => !!card && 'p' in card && typeof card.p === 'number' && 'h' in card && typeof card.h === 'number' && 'd' in card && typeof card.d === 'number';
const seats: Seat[] = ['p1', 'p2'];
function combatProof(cue: CardEffectCue, g: Geometry) {
    const attacks = g.outcomes.filter(item => item.outcome.kind === 'attack');
    if (!attacks.length || attacks.length > 3 || new Set(attacks.map(item => item.outcome.attackId)).size !== attacks.length) return;
    const groups = [];
    for (const [i, attack] of attacks.entries()) {
        const o = attack.outcome;
        if (!o.attackId || o.attackIndex !== i + 1 || o.combatOrder !== 'simultaneous' || !fullUnit(o.sourceCard) || !fullUnit(o.card) || !o.sourceCard.incarnation || !o.card.incarnation || o.sourceCard.x) return;
        const attacker = o.sourceCard, defender = o.card;
        const play = g.outcomes.find(item => item.outcome.kind === 'play' && same(item.outcome.unit, attacker) && item.outcome.unit?.incarnation === attacker.incarnation);
        const seat = seats.find(seat => unitIn(cue, attacker, seat)?.incarnation === attacker.incarnation) ?? play?.outcome.seat;
        if (!seat || o.seat === seat || unitIn(cue, defender, o.seat)?.incarnation !== defender.incarnation) return;
        const start = g.outcomes.indexOf(attack), end = i + 1 < attacks.length ? g.outcomes.indexOf(attacks[i + 1]) : g.outcomes.length;
        const items = g.outcomes.slice(start, end);
        const forward = items.find(item => item.outcome.kind === 'damage' && item.outcome.attackId === o.attackId && same(item.outcome.card, defender));
        const counter = items.find(item => item.outcome.kind === 'damage' && item.outcome.attackId === o.attackId && same(item.outcome.card, attacker));
        const exhaust = items.find(item => item.outcome.kind === 'exhaust' && item.outcome.attackId === o.attackId && same(item.outcome.card, attacker));
        const bonuses = g.outcomes.filter(item => item.outcome.kind === 'buff' && item.outcome.attackId === o.attackId);
        const bonus = bonuses[0];
        if (bonuses.length > 1 || bonus && (bonus.outcome.duration !== 'attack' || bonus.outcome.amount !== '+2/+0' || bonus.outcome.attackBonusBasis?.sourceId !== attacker.id || bonus.outcome.attackBonusBasis?.incarnation !== attacker.incarnation || g.outcomes.indexOf(bonus) >= start)) return;
        if (!forward || !counter || !exhaust || number(forward.outcome) !== attacker.p + (bonus ? 2 : 0) || number(counter.outcome) !== defender.p
            || [forward, counter].some(item => item.outcome.damageType !== 'combat' || item.outcome.combatOrder !== 'simultaneous' || item.outcome.attackIndex !== o.attackIndex)) return;
        const original = unitIn(cue, attacker, seat) ?? play?.outcome.unit;
        const defenderOriginal = unitIn(cue, defender, o.seat);
        if (!original || !defenderOriginal) return;
        // Attack references describe the current entry, including wounds from earlier attacks.
        for (const [baseline, current] of [[original, attacker], [defenderOriginal, defender]]) {
            const earlierDamage = g.outcomes.slice(0, start).filter(item => item.outcome.damageType === 'combat' && same(item.outcome.card, current))
                .reduce((sum, item) => sum + number(item.outcome), 0);
            if (current.p !== baseline.p || current.h !== baseline.h || current.d !== baseline.d + earlierDamage || current.owner !== baseline.owner || current.incarnation !== baseline.incarnation) return;
        }
        const earlierAttack = attacks.slice(0, i).reverse().find(item => same(item.outcome.sourceCard, attacker));
        const readinessStart = earlierAttack ? g.outcomes.indexOf(earlierAttack) : 0;
        if ((original?.x || earlierAttack) && !g.outcomes.slice(readinessStart, start).some(item => item.outcome.kind === 'ready' && same(item.outcome.card, attacker))) return;
        const deaths = items.filter(item => item.outcome.kind === 'defeat' && !item.outcome.prevented && [attacker, defender].some(card => same(card, item.outcome.card)));
        for (const [card, hit, owner] of [[attacker, counter, seat], [defender, forward, o.seat]] as const) {
            const lethal = card.d + number(hit.outcome) >= card.h, death = deaths.find(item => same(item.outcome.card, card));
            if (lethal !== !!death || death && (death.outcome.incarnation !== card.incarnation || !death.outcome.ownerSeat || unitIn(cue, card, owner, true)?.incarnation === card.incarnation)) return;
        }
        groups.push({ attack, attacker, defender, seat, forward, counter, exhaust, bonus, deaths, items });
    }
    const involved = new Map<string, { card: UnitRef; seat: Seat }>();
    for (const group of groups) for (const [card, seat] of [[group.attacker, group.seat], [group.defender, group.attack.outcome.seat]] as const) involved.set(key(card), { card, seat });
    for (const { card, seat } of involved.values()) {
        const original = unitIn(cue, card, seat) ?? g.outcomes.find(item => item.outcome.kind === 'play' && same(item.outcome.unit, card))?.outcome.unit;
        const after = unitIn(cue, card, seat, true);
        if (!original || !after) continue;
        const damage = g.outcomes.filter(item => item.outcome.damageType === 'combat' && same(item.outcome.card, card)).reduce((sum, item) => sum + number(item.outcome), 0);
        const exhausted = g.outcomes.filter(item => item.outcome.kind === 'exhaust' && same(item.outcome.card, card)).at(-1);
        const readied = g.outcomes.filter(item => item.outcome.kind === 'ready' && same(item.outcome.card, card)).at(-1);
        const expectedExhausted = exhausted ? !readied || g.outcomes.indexOf(readied) < g.outcomes.indexOf(exhausted) : !!original.x;
        if (after.d !== original.d + damage || after.p !== original.p || after.h !== original.h || after.incarnation !== original.incarnation || after.owner !== original.owner || !!after.x !== expectedExhausted) return;
    }
    return groups;
}
const timelyProof = (cue: CardEffectCue, g: Geometry) => {
    const play = g.outcomes.find(item => item.outcome.kind === 'play' && item.outcome.fromZone === 'hand' && item.outcome.entryType === 'played');
    const unit = play?.outcome.unit, before = cue.transition?.before.players[cue.seat];
    if (!play || !unit?.incarnation || unit.x !== 1 || play.outcome.entersReady !== false || play.outcome.ownerSeat !== unit.owner || play.outcome.seat !== cue.seat || !same(unit, play.outcome.card) || !before?.hand.some(card => same(card, unit))) return;
    const pay = g.outcomes.find(item => item.outcome.kind === 'pay' && same(item.outcome.sourceCard, unit) && Number.isSafeInteger(item.outcome.amount) && number(item.outcome) >= 0 && item.outcome.cards?.length === number(item.outcome));
    const keyword = g.outcomes.find(item => item.outcome.kind === 'keyword' && same(item.outcome.card, unit) && item.outcome.keyword?.name === 'Ambush' && item.outcome.keyword.amount === 1 && item.outcome.duration === 'phase');
    const after = unitIn(cue, unit, cue.seat, true), death = g.outcomes.find(item => item.outcome.kind === 'defeat' && same(item.outcome.card, unit));
    const eventIds = cue.playPayment?.kind === 'resources' ? cue.playPayment.cardIds : undefined;
    if (!pay || !keyword || !eventIds || eventIds.length !== cue.playCost || g.outcomes.indexOf(pay) >= g.outcomes.indexOf(play) || g.outcomes.indexOf(keyword) <= g.outcomes.indexOf(play)
        || new Set(pay.outcome.cards?.map(key)).size !== number(pay.outcome) || !pay.outcome.cards?.every(card => before.resources?.some(resource => same(resource, card) && !resource.x))
        || pay.outcome.cards?.some(card => eventIds.includes(key(card))) || !pay.outcome.cards?.every(card => cue.transition?.after.players[cue.seat].resources?.some(resource => same(resource, card) && resource.x === 1))
        || !after && !death || after && (after.incarnation !== unit.incarnation || !after.status?.some(status => status.keyword?.name === 'Ambush' && status.duration === 'phase'))) return;
    const attacks = g.outcomes.filter(item => item.outcome.kind === 'attack');
    if (!attacks.length) return after?.x === 1 && after.d === unit.d && !g.outcomes.some(item => ['ready', 'exhaust', 'defeat'].includes(item.outcome.kind) || item.outcome.damageType === 'combat') ? { play, pay, keyword, unit, after, ready: undefined, combat: undefined } : undefined;
    const groups = combatProof(cue, g), combat = groups?.length === 1 ? groups[0] : undefined;
    const ready = g.outcomes.find(item => item.outcome.kind === 'ready' && same(item.outcome.card, unit) && item.outcome.attackOrigin?.kind === 'ambush' && item.outcome.attackOrigin.playedId === unit.id && item.outcome.attackOrigin.incarnation === unit.incarnation);
    const origin = combat?.attack.outcome.attackOrigin;
    if (!combat || !ready || !same(combat.attacker, unit) || origin?.kind !== 'ambush' || origin.playedId !== unit.id || origin.incarnation !== unit.incarnation || g.outcomes.indexOf(ready) <= g.outcomes.indexOf(keyword) || g.outcomes.indexOf(ready) >= g.outcomes.indexOf(combat.attack)) return;
    return { play, pay, keyword, unit, after, ready, combat };
};
const exchangeProof = (cue: CardEffectCue, g: Geometry) => {
    const changes = g.outcomes.filter(item => item.outcome.kind === 'control');
    const pair = changes[0]?.outcome.controlExchange;
    if (changes.length !== 2 || !pair || new Set(pair.memberIds).size !== 2) return;
    const hosts = [];
    for (const item of changes) {
        const o = item.outcome, before = o.fromSeat && unitIn(cue, o.card, o.fromSeat), after = unitIn(cue, o.card, o.seat, true);
        if (!before || !after || !o.unit || !o.fromSeat || o.fromSeat === o.seat || o.duration !== 'permanent' || o.controlExchange?.id !== pair.id || o.controlExchange.memberIds.some((id, i) => id !== pair.memberIds[i]) || !pair.memberIds.includes(key(o.card))
            || before.owner !== o.ownerSeat || after.owner !== before.owner || o.unit.owner !== before.owner || before.incarnation !== o.incarnation || after.incarnation !== before.incarnation || o.unit.incarnation !== before.incarnation
            || before.p !== after.p || before.h !== after.h || before.d !== after.d || before.x !== after.x || o.fromZone !== o.zone || same(before, cue.transition?.before.players[o.fromSeat].leader)
            || before.cap?.length || before.u?.length || !after.status?.some(status => status.kind === 'control' && status.duration === 'permanent')) return;
        hosts.push({ item, before, after });
    }
    return new Set(changes.map(item => item.outcome.fromSeat)).size === 2 && new Set(changes.map(item => key(item.outcome.card))).size === 2 ? hosts : undefined;
};
const angerProof = (cue: CardEffectCue, g: Geometry) => {
    const restriction = g.outcomes.find(item => item.outcome.kind === 'restrict' && item.outcome.nextAction?.operation === 'add');
    if (!restriction || restriction.outcome.nextAction?.operation !== 'add') return;
    const o = restriction.outcome, constraint = restriction.outcome.nextAction.constraint, prior = unitIn(cue, o.card, o.seat), after = unitIn(cue, o.card, o.seat, true), snapshot = cue.transition?.before;
    const damage = g.outcomes.find(item => item.outcome.kind === 'damage' && same(item.outcome.card, o.card) && item.outcome.damageType === 'ability' && number(item.outcome) === 1);
    if (!prior || !after || !damage || !snapshot || !cue.source?.id || constraint.sourceId !== cue.source.id || constraint.subjectId !== prior.id || constraint.incarnation !== prior.incarnation || constraint.controller !== o.seat || constraint.round !== snapshot.round || constraint.phase !== snapshot.phase
        || !constraint.targetUnitIfAble || o.duration !== 'next-action' || o.restriction !== 'must-attack' || after.d !== prior.d + 1 || after.p !== prior.p || after.h !== prior.h || after.owner !== prior.owner || after.x !== prior.x || after.incarnation !== prior.incarnation
        || !cue.transition?.after.nextActionConstraints?.some(current => current.id === constraint.id && current.sourceId === constraint.sourceId && current.subjectId === prior.id && current.incarnation === prior.incarnation && current.controller === constraint.controller && current.round === constraint.round && current.phase === constraint.phase && current.targetUnitIfAble === constraint.targetUnitIfAble) || !after.status?.some(status => status.actionConstraintId === constraint.id)
        || g.outcomes.indexOf(damage) >= g.outcomes.indexOf(restriction) || g.outcomes.some(item => ['attack', 'ready', 'exhaust'].includes(item.outcome.kind))) return;
    return { restriction, damage, constraint, prior, after };
};
const boundaryProof = (cue: CardEffectCue, g: Geometry) => {
    const consumed = g.outcomes.find(item => item.outcome.kind === 'restrict' && item.outcome.nextAction?.operation === 'consume');
    if (!consumed || consumed.outcome.nextAction?.operation !== 'consume') return;
    const action = consumed.outcome.nextAction, constraint = cue.transition?.before.nextActionConstraints?.find(current => current.id === action.constraintId), witness = action.witness;
    if (!constraint || witness.player !== constraint.controller || witness.round !== constraint.round || witness.phase !== constraint.phase || cue.transition?.after.nextActionConstraints?.some(current => current.id === constraint.id)) return;
    if (witness.action === 'attack-with-unit' && witness.result === 'satisfied') {
        const groups = combatProof(cue, g), combat = groups?.length === 1 ? groups[0] : undefined;
        return combat && combat.seat === constraint.controller && combat.attacker.id === constraint.subjectId && combat.attacker.incarnation === constraint.incarnation && witness.attackerId === combat.attacker.id && witness.incarnation === constraint.incarnation && witness.attackId === combat.attack.outcome.attackId && witness.targetId === combat.defender.id && g.outcomes.indexOf(consumed) > g.outcomes.indexOf(combat.counter) ? { consumed, constraint, witness, combat } : undefined;
    }
    const before = unitIn(cue, { id: constraint.subjectId, n: '', s: null }, constraint.controller);
    if (witness.action === 'phase-end' && witness.result === 'expired' || witness.action === 'other' && witness.result === 'unable' && (witness.unableReason === 'exhausted' && before?.x === 1 || witness.unableReason === 'departed' && !before)) return { consumed, constraint, witness, combat: undefined };
};
const huntProof = (cue: CardEffectCue, g: Geometry) => {
    const groups = combatProof(cue, g);
    return groups?.every(group => group.seat === cue.seat && (!group.bonus || group.bonus.outcome.attackBonusBasis?.kind === 'bounty-hunter')) ? groups : undefined;
};
const detentionProof = (cue: CardEffectCue, g: Geometry) => {
    const damage = g.outcomes.find(item => item.outcome.kind === 'damage' && item.outcome.damageType === 'ability' && item.outcome.basis?.kind === 'captured-count');
    const prior = damage && unitIn(cue, damage.outcome.card, damage.outcome.seat), basis = damage?.outcome.basis;
    if (!damage || !prior || !basis || basis.value !== (prior.cap?.length ?? 0) || basis.sourceIds.length !== 1 || basis.sourceIds[0] !== prior.id || basis.countRule?.zero !== 3 || basis.countRule.positive !== 6 || number(damage.outcome) !== (basis.value ? 6 : 3)) return;
    const death = g.outcomes.find(item => item.outcome.kind === 'defeat' && same(item.outcome.card, prior));
    const after = unitIn(cue, prior, damage.outcome.seat, true);
    if (!death || death.outcome.prevented) return after && after.incarnation === prior.incarnation && after.d === prior.d + number(damage.outcome) && !g.outcomes.some(item => item.outcome.kind === 'rescue') ? { damage, prior, death, after, rescues: [] as PlacedOutcome[] } : undefined;
    if (after || death.outcome.incarnation !== prior.incarnation || g.outcomes.indexOf(death) <= g.outcomes.indexOf(damage)) return;
    const cleanup = death.outcome.captiveCleanup, caps = prior.cap ?? [], rescues = g.outcomes.filter(item => item.outcome.kind === 'rescue');
    if (!caps.length) return rescues.length ? undefined : { damage, prior, death, after, rescues };
    if (!cleanup || cleanup.captorId !== prior.id || cleanup.incarnation !== prior.incarnation || cleanup.cards.length !== caps.length || cleanup.cards.some(card => !caps.some(captive => same(captive, card) && captive.owner === card.owner)) || rescues.length !== caps.length || new Set(rescues.map(item => key(item.outcome.card))).size !== caps.length) return;
    for (const item of rescues) {
        const o = item.outcome, actual = unitIn(cue, o.card, o.seat, true);
        if (o.captiveCleanupId !== cleanup.id || !same(o.sourceCard, prior) || o.ownerSeat !== o.seat || o.card?.owner !== o.seat || !caps.some(card => same(card, o.card)) || o.entryType !== 'rescued' || o.entersReady !== false || o.unit?.x !== 1 || o.unit.d !== 0 || !o.unit.incarnation || o.unit.incarnation === cue.transition?.before.mostRecentIncarnations?.[key(o.card)] || actual?.incarnation !== o.unit.incarnation || actual.x !== 1 || actual.d !== 0 || actual.p !== o.unit.p || actual.h !== o.unit.h || actual.owner !== o.seat || o.unit.owner !== o.seat || actual.u?.length || actual.status?.length || actual.cap?.length || o.unit.u?.length || o.unit.status?.length || !item.from.exact || g.outcomes.indexOf(item) <= g.outcomes.indexOf(death)) return;
    }
    return { damage, prior, death, after, rescues };
};

/** Rendering and receipt suppression share these complete evidence predicates. */
export function batchA06Covers(cue: CardEffectCue, g: Geometry, item: PlacedOutcome): boolean {
    switch (cue.definition.id) {
        case 'timely-intervention': { const proof = timelyProof(cue, g); return !!proof && ([proof.play, proof.pay, proof.keyword, proof.ready].includes(item) || !!proof.combat && (proof.combat.items.includes(item) || item === proof.combat.bonus)); }
        case 'choose-sides': return !!exchangeProof(cue, g)?.some(host => host.item === item);
        case 'give-in-to-your-anger': { const boundary = boundaryProof(cue, g); if (boundary) return item === boundary.consumed || !!boundary.combat && boundary.combat.items.includes(item); const proof = angerProof(cue, g); return !!proof && (item === proof.damage || item === proof.restriction); }
        case 'headhunting': return !!huntProof(cue, g)?.some(group => group.items.includes(item) || item === group.bonus);
        case 'detention-block-rescue': { const proof = detentionProof(cue, g); return !!proof && (item === proof.damage || item === proof.death || proof.rescues.includes(item)); }
        default: return false;
    }
}

function Packet({ from, to, count, p, start, end, color = '#ffb296' }: { from: EffectBox; to: EffectBox; count: number; p: number; start: number; end: number; color?: string }) {
    const at = { ...from, ...mix(from, to, easeInOut(phase(p, start, end))) };
    return <ScreenPixels at={at} color={color} opacity={envelope(p, start, start + .025, end + .025)}><CountedMarks count={count} gap={8} radius={2.5} color={color} /></ScreenPixels>;
}
function Combat({ cue, geometry: g, group, p, start, hit, end, settleAt = 2 }: { cue: CardEffectCue; geometry: Geometry; group: NonNullable<ReturnType<typeof combatProof>>[number]; p: number; start: number; hit: number; end: number; settleAt?: number }) {
    const { attacker, defender, seat, forward, counter, deaths, bonus } = group;
    const from = unitIn(cue, attacker, seat) ? cardAt(g, attacker, seat) : g.outcomes.find(item => item.outcome.kind === 'play' && same(item.outcome.card, attacker))?.to ?? g.endingCards?.[`${seat}:${key(attacker)}`] ?? cardAt(g, attacker, seat), to = cardAt(g, defender, group.attack.outcome.seat);
    const attackerDeath = deaths.find(item => same(item.outcome.card, attacker)), defenderDeath = deaths.find(item => same(item.outcome.card, defender));
    const t = phase(p, start, hit), lunge = Math.sin(t * Math.PI) * .11, at = { ...from, ...mix(from, to, lunge) };
    const pose = p >= hit ? { ...attacker, d: attacker.d + number(counter.outcome) } : { ...attacker, p: attacker.p + (bonus ? 2 : 0) }, shape = size(from);
    return <><Mask at={from} p={p} start={start} immediate /><ScreenPixels at={at} opacity={(p >= start ? 1 : 0) * (p >= settleAt ? 0 : attackerDeath ? 1 - phase(p, hit + .03, hit + .07) : 1)}><g transform={`rotate(${10 * easeOut(phase(p, start, hit))}) scale(${1 - .06 * easeOut(phase(p, start, hit))})`} opacity={1 - .28 * phase(p, start, hit)}><CardGhost card={attacker} box={shape} />{[-1, 1].map(side => <g key={side} transform={`translate(${side * (shape.w / 2 - 10)} ${shape.h / 2 - 11})`}><rect x="-10" y="-11" width="20" height="22" rx="3" fill={side < 0 ? '#8b2936' : '#173f6f'} /><text textAnchor="middle" y="4" fill="#fff" stroke="none" style={{ font: '800 13px sans-serif' }}>{side < 0 ? pose.p : Math.max(0, pose.h - pose.d)}</text></g>)}</g></ScreenPixels>
        {bonus && <ScreenPixels at={shift(from, size(from).w / 2 + 10, 0)} opacity={envelope(p, start - .025, start, hit + .035)} color="#edda9b"><CountedMarks count={2} radius={3} gap={10} color="#edda9b" /></ScreenPixels>}
        <Packet from={from} to={to} count={number(forward.outcome)} p={p} start={hit - .08} end={hit} /><Packet from={to} to={from} count={number(counter.outcome)} p={p} start={hit - .08} end={hit} color="#becde9" />
        {defenderDeath ? <><Mask at={to} p={p} start={hit + .025} /><Travel from={to} to={defenderDeath.to} card={defender} p={p} start={hit + .03} end={end} until={end + .035} initialSize={size(to)} color="#e7b29b" /><ScreenPixels at={to} opacity={visible(p, end)} color="#e8baa6"><AbilityGlyph kind="defeat" size={22} /></ScreenPixels></> : <Stats at={to} unit={{ ...defender, d: defender.d + number(forward.outcome) }} p={p} start={hit} />}
        {attackerDeath && <><Mask at={from} p={p} start={hit + .025} /><Travel from={from} to={attackerDeath.to} card={attacker} p={p} start={hit + .03} end={end} until={end + .035} initialSize={size(from)} /><ScreenPixels at={from} opacity={visible(p, end)} color="#e8baa6"><AbilityGlyph kind="defeat" size={22} /></ScreenPixels></>}
    </>;
}
function Timely({ cue, geometry: g, p }: Props) {
    const proof = timelyProof(cue, g); if (!proof) return null;
    const { play, pay, unit, combat } = proof;
    const player = cue.transition!.before.players[cue.seat], afterPlayer = cue.transition!.after.players[cue.seat];
    return <><EventPayment cue={cue} geometry={g} p={p} />{player.resources?.map((resource, i) => { const at = g.resourceCards?.[`${cue.seat}:${key(resource)}`]; return at && pay.outcome.cards?.some(card => same(card, resource)) ? <ResourceSlot key={key(resource)} at={at} index={i} spent p={p} start={.14} /> : null; })}<ResourceBalance at={g.zones[`${cue.seat}:resources`]} countAt={g.zones[`${cue.seat}:resource-count`]} ready={afterPlayer.res.ready} total={afterPlayer.res.total} p={p} start={.14} /><Mask at={play.from} p={p} start={.16} />{(!combat || p < .43) && <Travel from={play.from} to={play.to} card={unit} unit={{ ...unit, x: combat && p >= .38 ? undefined : unit.x }} p={p} start={.17} end={.35} />}
        <Receipt at={center(g)} rows={[`UNIT PAID ${number(pay.outcome)}`, ...(cue.playCost != null ? [`EVENT PAID ${cue.playCost} SEPARATELY`] : [])]} p={p} start={.05} until={.34} color="#d4e9af" />
        <Receipt at={center(g)} rows={['AMBUSH · THIS PHASE', combat ? 'CHOSEN: READY → ATTACK' : 'NO AMBUSH ATTACK · STAYS EXHAUSTED']} p={p} start={.35} until={.57} color="#cbdcb0" />
        {combat && <Combat cue={cue} geometry={g} group={combat} p={p} start={.43} hit={.64} end={.79} />}
        {proof.after && <ScreenPixels at={shift(play.to, 0, -size(play.to).h / 2 - 8)} opacity={visible(p, .82)} color="#cbdcb0"><path d="M-26 -7 H26 L31 0 L26 7 H-26 Z" fill="#17241b" strokeWidth="1" /><text textAnchor="middle" y="2" fill="currentColor" stroke="none" style={{ font: '700 7px sans-serif' }}>AMBUSH · PHASE</text></ScreenPixels>}
        <Receipt at={center(g)} rows={[combat ? 'AMBUSH ATTACK RESOLVED' : 'PAID ENTRY · NO ATTACK', ...(proof.after ? [`SURVIVOR DAMAGE ${proof.after.d} · EXHAUSTED`] : ['ENTERING UNIT DEFEATED'])]} p={p} start={.82} color="#d3e7b8" />
    </>;
}
function Sides({ cue, geometry: g, p }: Props) {
    const hosts = exchangeProof(cue, g); if (!hosts) return null;
    return <><EventPayment cue={cue} geometry={g} p={p} />{hosts.map(({ item, before, after }, i) => <g key={item.key}><ScreenPixels at={shift(item.from, 0, -size(item.from).h / 2 - 11)} opacity={envelope(p, .05, .12, .3)} color="#cebce8"><circle r="10" fill="#251c31" strokeWidth="1.5" /><text y="4" textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '800 11px sans-serif' }}>{i + 1}</text></ScreenPixels><Mask at={item.from} p={p} start={.25} /><Travel from={item.from} to={item.to} card={before} unit={after} p={p} start={.26} end={.62} preservePose initialSize={size(item.from)} color={i ? '#c3d5e6' : '#d4bde5'} /></g>)}
        <Receipt at={center(g)} rows={['PERMANENT EXCHANGE · POSES STAY']} p={p} start={.05} until={.64} color="#d5c6e7" /><Receipt at={center(g)} rows={hosts.map(({ item, before }) => `${before.n === 'Battlefield Marine' ? 'MARINE' : 'TIE'} · OWNER ${item.outcome.ownerSeat!.toUpperCase()} · CONTROL ${item.outcome.seat.toUpperCase()}`)} p={p} start={.69} color="#d5c6e7" />
    </>;
}
function Anger({ cue, geometry: g, p }: Props) {
    const boundary = boundaryProof(cue, g);
    if (boundary) return <><Receipt at={center(g)} rows={[`ACTUAL NEXT ${boundary.constraint.controller.toUpperCase()} ACTION`, boundary.combat ? 'ORDINARY UNIT ATTACK' : boundary.witness.result === 'expired' ? 'PHASE ENDED · CONSTRAINT EXPIRES' : `UNABLE · ${boundary.witness.unableReason?.toUpperCase()}`]} p={p} start={.05} until={.43} color="#eac0d0" />{boundary.combat && <Combat cue={cue} geometry={g} group={boundary.combat} p={p} start={.23} hit={.5} end={.76} />}<Receipt at={center(g)} rows={['NEXT-ACTION CONSTRAINT CONSUMED', boundary.combat ? `${boundary.combat.deaths.length} UNIT DEFEATS · ORDINARY ATTACK` : 'BOUNDARY RESOLVED · NO ATTACK']} p={p} start={.8} color="#e5bacb" /></>;
    const proof = angerProof(cue, g); if (!proof) return null;
    const at = proof.damage.box, s = size(at);
    return <><EventPayment cue={cue} geometry={g} p={p} /><Packet from={g.source} to={at} count={1} p={p} start={.12} end={.32} color="#e4a6bc" /><Stats at={at} unit={proof.after} p={p} start={.33} />
        <ScreenPixels at={at} color="#e4aac0" opacity={visible(p, .35)}><path d={`M${-s.w / 2 - 5} -25 V25 L${-s.w / 2 - 12} 32 M${s.w / 2 + 5} -25 V25 L${s.w / 2 + 12} 32`} strokeWidth="2" /><path d="M-12 -15 H12 L6 -21 M12 -15 L6 -9" strokeWidth="2" /></ScreenPixels>
        <Receipt at={center(g)} rows={[`NEXT ${proof.constraint.controller.toUpperCase()} ACTION · ATTACK IF ABLE`, 'WITH THIS UNIT · UNIT TARGET IF ABLE']} p={p} start={.57} color="#e7b8cb" />
    </>;
}
function HuntSettlement({ cue, geometry: g, groups, p }: Props & { groups: NonNullable<ReturnType<typeof combatProof>> }) {
    const survivors = new Map<string, { unit: UnitRef; seat: Seat }>();
    for (const group of groups) for (const [card, seat] of [[group.attacker, group.seat], [group.defender, group.attack.outcome.seat]] as const) {
        const unit = unitIn(cue, card, seat, true);
        if (unit) survivors.set(key(card), { unit, seat });
    }
    return <>{[...survivors.values()].map(({ unit, seat }) => {
        const from = cardAt(g, unit, seat), to = g.endingCards?.[`${seat}:${key(unit)}`];
        return to ? <g key={key(unit)}><Mask at={from} p={p} start={.89} immediate /><Travel from={from} to={to} card={unit} unit={unit} p={p} start={.89} end={.96} preservePose continuing initialSize={size(from)} /></g> : null;
    })}</>;
}
function Hunt({ cue, geometry: g, p }: Props) {
    const groups = huntProof(cue, g); if (!groups?.length) return null;
    return <><EventPayment cue={cue} geometry={g} p={p} /><ScreenPixels at={shift(center(g), 0, -13)} color="#e0c4ab" opacity={visible(p, .03)}>{groups.map((group, i) => <g key={group.attack.key} transform={`translate(${(i - (groups.length - 1) / 2) * 45} 0)`}><circle r="13" fill={p >= .26 + i * .27 ? '#3a3025' : '#111922'} strokeWidth="1.5" /><text y="4" textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '800 12px sans-serif' }}>{i + 1}</text><path d="M-8 20 H8" strokeWidth={p >= .26 + i * .27 ? 3 : 1} /></g>)}</ScreenPixels>
        {groups.map((group, i) => <Combat key={group.attack.key} cue={cue} geometry={g} group={group} p={p} start={.1 + i * .27} hit={.26 + i * .27} end={.34 + i * .27} settleAt={.89} />)}
        <Receipt at={shift(center(g), 0, 22)} rows={['HUNTER +2 · THAT ATTACK ONLY']} p={p} start={.04} until={.83} color="#e5c7a6" />
        <HuntSettlement cue={cue} geometry={g} groups={groups} p={p} />
        <Receipt at={center(g)} rows={[`${groups.length} UNIT ATTACKS RESOLVED`, 'COUNTERDAMAGE · RESTING POWER RESTORED']} p={p} start={.83} color="#ddc1a4" />
    </>;
}
function Detention({ cue, geometry: g, p }: Props) {
    const proof = detentionProof(cue, g); if (!proof) return null;
    const { damage, prior, death, rescues, after } = proof, at = damage.box, pocket = g.pockets?.[`${damage.outcome.seat}:${key(prior)}`];
    return <><EventPayment cue={cue} geometry={g} p={p} /><Receipt at={center(g)} rows={[`CAPTURED ${prior.cap?.length ?? 0}`, `DAMAGE RAIL ${(prior.cap?.length ?? 0) ? '3 → 6' : '3'}`]} p={p} start={.05} until={.36} color="#c5dde7" />
        <Packet from={g.source} to={at} count={number(damage.outcome)} p={p} start={.16} end={.35} color="#e5b7a3" />
        {death && !death.outcome.prevented ? <><Mask at={at} p={p} start={.38} /><FracturedCard box={at} card={prior} to={death.to} p={phase(p, .27, .61)} />{pocket && <AttachmentMask at={pocket} p={p} start={.57} />}{rescues.map((item, i) => <g key={item.key}><AttachmentMask at={item.from} p={p} start={.56} /><Travel from={item.from} to={item.to} card={item.outcome.card!} unit={item.outcome.unit} p={p} start={.58 + i * .035} end={.82 + i * .035} initialSize={size(item.from)} color="#bddbe5" /></g>)}</> : after && <Stats at={at} unit={after} p={p} start={.36} />}
        <Receipt at={center(g)} rows={rescues.length ? [`RESCUED ${rescues.length} · OWNER ${rescues[0].outcome.ownerSeat!.toUpperCase()} · EXHAUSTED`, 'AFTER CAPTOR DEFEAT · FRESH ENTRY'] : [`${number(damage.outcome)} DAMAGE`, after ? 'CAPTOR STAYS · POCKET PRESERVED' : 'UNIT DEFEATED · NO CAPTIVES']} p={p} start={.84} color="#c6dfe8" />
    </>;
}

export function BatchA06Signature(props: Props) {
    switch (props.cue.definition.id) {
        case 'timely-intervention': return <Timely {...props} />;
        case 'choose-sides': return <Sides {...props} />;
        case 'give-in-to-your-anger': return <Anger {...props} />;
        case 'headhunting': return <Hunt {...props} />;
        case 'detention-block-rescue': return <Detention {...props} />;
        default: return null;
    }
}
