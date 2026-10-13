import type { CardRef, Seat, UnitRef } from '../data/types';
import type { CardEffectCue, CardEffectOutcome } from './types';
import { easeInOut, easeOut, envelope, phase } from './animationTimeline';
import { AttachmentMask, CardGhost, CountedMarks, ScreenPixels, mix, screenShift as shift, sequence, type EffectBox, type PlacedOutcome } from './primitives';

type Geometry = { source: EffectBox; target: EffectBox; friendlyBase: EffectBox; outcomes: PlacedOutcome[]; zones: Record<string, EffectBox>; cards?: Record<string, EffectBox>; endingCards?: Record<string, EffectBox>; pockets?: Record<string, EffectBox> };
type Props = { cue: CardEffectCue; geometry: Geometry; p: number };
const ids = new Set(['i-am-your-father', 'maximum-firepower', 'galactic-ambition', 'medal-ceremony', 'youre-my-only-hope', 'calculated-lethality', 'mystic-reflection', 'midnight-repairs', 'covert-strength', 'unexpected-escape']);
export const isBatchA04 = (cue: CardEffectCue) => ids.has(cue.definition.id);
const key = (card?: CardRef | null) => card?.id ?? `${card?.s ?? ''}:${card?.n ?? ''}`;
const same = (a?: CardRef | null, b?: CardRef | null) => !!a && !!b && key(a) === key(b);
const amount = (o: CardEffectOutcome) => typeof o.amount === 'number' ? o.amount : 0;
const dimensions = (at: EffectBox) => at.cardSize ?? { w: at.w * (at.sx ?? 1), h: at.h * (at.sy ?? 1) };
const opacity = (p: number, start: number) => phase(p, start, start + .065);
const unitIn = (cue: CardEffectCue, card: CardRef | null | undefined, seat: Seat, after = false) => {
    const player = cue.transition?.[after ? 'after' : 'before'].players[seat];
    return [...(player?.ground ?? []), ...(player?.space ?? [])].find(unit => same(unit, card));
};
const cardAt = (g: Geometry, card: CardRef, seat: Seat, zone = 'ground') => g.cards?.[`${seat}:${key(card)}`] ?? g.zones[`${seat}:${zone}`];
const bounded = (at: EffectBox, halfWidth = 60, halfHeight = 12): EffectBox => ({ ...at,
    x: Math.max((halfWidth + 8) / (at.sx ?? 1), Math.min(1000 - (halfWidth + 8) / (at.sx ?? 1), at.x)),
    y: Math.max((halfHeight + 40) / (at.sy ?? 1), Math.min(600 - (halfHeight + 122) / (at.sy ?? 1), at.y)) });
const middle = (g: Geometry) => {
    const upper = g.zones['p2:ground'], base = g.zones['p1:base'];
    return bounded({ ...g.source, x: 500, y: upper && base ? (upper.y + upper.h / 2 + base.y - base.h / 2) / 2 : 300 });
};

function Receipt({ at, rows, p, start = .63, until, color = '#dfebff' }: { at: EffectBox; rows: string[]; p: number; start?: number; until?: number; color?: string }) {
    const width = Math.max(52, Math.min(238, Math.max(...rows.map(row => row.length)) * 5 + 18)), height = rows.length * 18 + 6;
    return <ScreenPixels at={bounded(at, width / 2, height / 2)} color={color} opacity={opacity(p, start) * (until ? 1 - phase(p, until - .08, until) : 1)}><rect x={-width / 2} y={-height / 2} width={width} height={height} rx="4" fill="#080f1b" fillOpacity=".97" strokeWidth="1" />
        {rows.map((row, i) => <text key={i} y={-height / 2 + 15 + i * 18} textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '700 9px var(--font-display,sans-serif)', letterSpacing: '.02em' }}>{row}</text>)}
    </ScreenPixels>;
}
function Route({ from, to, p, start, end, color = '#d2dfff', bend = 25 }: { from: EffectBox; to: EffectBox; p: number; start: number; end: number; color?: string; bend?: number }) {
    const c = shift({ ...from, ...mix(from, to, .5) }, bend, -34);
    return <path d={`M${from.x} ${from.y} Q${c.x} ${c.y} ${to.x} ${to.y}`} pathLength="1" strokeDasharray="1" strokeDashoffset={1 - easeOut(phase(p, start, end))} stroke={color} strokeWidth="2" opacity={envelope(p, start, start + .08, end + .14)} />;
}
function Travel({ from, to, card, unit, p, start, end, back = false, hold = true, startSize, color = '#d3e4ff' }: { from: EffectBox; to: EffectBox; card?: CardRef | null; unit?: UnitRef; p: number; start: number; end: number; back?: boolean; hold?: boolean; startSize?: { w: number; h: number }; color?: string }) {
    if (p < start) return null;
    const t = easeInOut(phase(p, start, end)), c = shift({ ...from, ...mix(from, to, .5) }, 22, -43);
    const at = { ...from, x: (1 - t) ** 2 * from.x + 2 * (1 - t) * t * c.x + t * t * to.x, y: (1 - t) ** 2 * from.y + 2 * (1 - t) * t * c.y + t * t * to.y };
    const a = startSize ?? from.cardSize ?? { w: 42, h: 58.8 }, b = to.cardSize ?? { w: 34, h: 47.6 };
    const w = a.w + (b.w - a.w) * t, h = a.h + (b.h - a.h) * t, exhausted = unit?.x === 1;
    return <><Route from={from} to={to} p={p} start={start} end={end} color={color} /><ScreenPixels at={at} color={color} opacity={opacity(p, start) * (hold ? 1 : 1 - phase(p, end, end + .08))}>
        <g transform={`rotate(${exhausted ? 10 * t : -7 * Math.sin(t * Math.PI)}) scale(${exhausted ? 1 - .06 * t : 1})`} opacity={exhausted ? 1 - .28 * t : 1}><CardGhost card={card} back={back} box={{ w, h }} />
            {unit && [-1, 1].map(side => <g key={side} transform={`translate(${side * (w / 2 - 10)} ${h / 2 - 11})`}><rect x="-9" y="-10" width="18" height="20" rx="3" fill={side < 0 ? '#8b2936' : '#173f6f'} /><text textAnchor="middle" y="4" fill="#fff" stroke="none" style={{ font: '800 12px sans-serif' }}>{side < 0 ? unit.p : unit.h - unit.d}</text></g>)}
        </g>
    </ScreenPixels></>;
}
function Mask({ at, p, start }: { at: EffectBox; p: number; start: number }) {
    const size = dimensions(at);
    return <ScreenPixels at={at} opacity={opacity(p, start)}><rect x={-size.w / 2 - 4} y={-size.h / 2 - 4} width={size.w + 8} height={size.h + 8} rx="5" fill="#09121f" stroke="none" /></ScreenPixels>;
}
function Stats({ at, power, hp, p, start }: { at: EffectBox; power?: number; hp: number; p: number; start: number }) {
    if (at.stat) return <ScreenPixels at={{ ...at, ...at.stat }} opacity={opacity(p, start)} color="#ffd3b4"><circle r={Math.max(18, Math.min(28, at.stat.w * (at.sx ?? 1) / 2))} fill="#09121f" strokeWidth="3" /><text textAnchor="middle" y="6" fill="#fff0df" stroke="none" style={{ font: '800 20px sans-serif' }}>{Math.max(0, hp)}</text><text y="16" textAnchor="middle" fill="#fff0df" stroke="none" style={{ font: '700 6px sans-serif' }}>HP</text></ScreenPixels>;
    if (at.counters) return <>{(['power', 'hp'] as const).filter(name => name === 'hp' || power != null).map(name => {
        const box = at.counters![name], w = box.w * (at.sx ?? 1) + 2, h = box.h * (at.sy ?? 1) + 2;
        return <ScreenPixels key={name} at={{ ...at, ...box }} opacity={opacity(p, start)}><rect x={-w / 2} y={-h / 2} width={w} height={h} rx="3" fill={name === 'power' ? '#8b2936' : '#173f6f'} stroke="#d6e6fb" strokeWidth="1" /><text textAnchor="middle" y="4" fill="#fff" stroke="none" style={{ font: '800 14px sans-serif' }}>{name === 'power' ? power : Math.max(0, hp)}</text></ScreenPixels>;
    })}</>;
    const size = dimensions(at);
    return <ScreenPixels at={at} opacity={opacity(p, start)}>{[-1, 1].filter(side => side === 1 || power != null).map(side => <g key={side} transform={`translate(${side * (size.w / 2 - 10)} ${size.h / 2 - 12})`}><rect x="-11" y="-12" width="22" height="24" rx="3" fill={side < 0 ? '#8b2936' : '#173f6f'} stroke="#d6e6fb" strokeWidth="1" /><text textAnchor="middle" y="4" fill="#fff" stroke="none" style={{ font: '800 14px sans-serif' }}>{side < 0 ? power : Math.max(0, hp)}</text></g>)}</ScreenPixels>;
}
function Pose({ at, card, p, start = .17, end = .39 }: { at: EffectBox; card: UnitRef; p: number; start?: number; end?: number }) {
    const t = card.x ? 1 : easeOut(phase(p, start, end));
    return <><Mask at={at} p={p} start={start} /><ScreenPixels at={at} opacity={opacity(p, start)}><g transform={`rotate(${10 * t}) scale(${1 - .06 * t})`} opacity={1 - .28 * t}><CardGhost card={card} box={dimensions(at)} /></g></ScreenPixels></>;
}
function Packet({ from, to, count, p, start, end, color = '#ffb290' }: { from: EffectBox; to: EffectBox; count: number; p: number; start: number; end: number; color?: string }) {
    if (count <= 0) return null;
    const at = { ...from, ...mix(from, to, easeInOut(phase(p, start, end))) };
    return <><Route from={from} to={to} p={p} start={start} end={end} color={color} bend={0} /><ScreenPixels at={at} color={color} opacity={envelope(p, start, start + .05, end + .04)}><CountedMarks count={count} color={color} /></ScreenPixels></>;
}
function Pulse({ at, p, start, color = '#ffbd96' }: { at: EffectBox; p: number; start: number; color?: string }) {
    const t = easeOut(phase(p, start, start + .18));
    return <ScreenPixels at={at} color={color} opacity={envelope(p, start, start + .04, start + .21)}><circle r={10 + 48 * t} strokeWidth="3" opacity={1 - t} /></ScreenPixels>;
}
const drawCards = (o: CardEffectOutcome) => o.cards?.length ? o.cards : o.card ? [o.card] : [];
const entering = (item: PlacedOutcome) => item.outcome.kind === 'play' && item.outcome.entryType === 'played' && !!item.outcome.unit?.id && same(item.outcome.card, item.outcome.unit);
const xpTokens = (cue: CardEffectCue, item: PlacedOutcome) => {
    const o = item.outcome, before = unitIn(cue, o.card, o.seat), after = unitIn(cue, o.card, o.seat, true);
    return o.kind === 'buff' && o.duration === 'token' && !!o.cards?.length && !!before && !!after && before.incarnation === after.incarnation && o.cards.every(card => !!card.id && !before.u?.some(old => same(old, card)) && after.u?.some(upgrade => same(upgrade, card) && upgrade.t === 1 && upgrade.n === 'Experience' && upgrade.p === 1 && upgrade.h === 1));
};
const fatherEvidence = (cue: CardEffectCue, g: Geometry) => g.outcomes.find(item => {
    const o = item.outcome, choice = o.choice;
    return choice?.kind === 'controller-response' && o.chooserSeat === choice.controller && !!unitIn(cue, choice.subject, choice.controller)
        && (choice.decision === 'no' ? o.kind === 'draw' && o.seat === cue.seat && !!drawCards(o).length : o.kind === 'damage' && same(o.card, choice.subject) && amount(o) === 7);
});
const powerHits = (cue: CardEffectCue, g: Geometry) => {
    const candidates = g.outcomes.filter(item => item.outcome.kind === 'damage' && item.outcome.basis?.kind === 'source-power');
    if (!candidates.length || candidates.length > 2) return [];
    const hits = candidates.filter(item => {
    const o = item.outcome, source = unitIn(cue, o.sourceCard, cue.seat), target = unitIn(cue, o.card, o.seat);
    return o.kind === 'damage' && o.damageType === 'ability' && o.basis?.kind === 'source-power' && !!o.sequenceId && typeof o.sequenceIndex === 'number'
        && !!source && !!target && !!o.targetIncarnation && o.targetIncarnation === target.incarnation && o.basis.sourceIds.includes(key(source)) && o.basis.value === source.p && amount(o) === source.p;
    }).sort((a, b) => a.outcome.sequenceIndex! - b.outcome.sequenceIndex!);
    if (hits.length !== candidates.length || hits.some((item, i) => item.outcome.sequenceIndex !== i + 1 || item.outcome.sequenceId !== hits[0].outcome.sequenceId || !same(item.outcome.card, hits[0].outcome.card)
        || item.outcome.targetIncarnation !== hits[0].outcome.targetIncarnation) || new Set(hits.map(item => key(item.outcome.sourceCard))).size !== hits.length) return [];
    return hits;
};
const ambitionEvidence = (cue: CardEffectCue, g: Geometry) => {
    const hit = g.outcomes.find(item => item.outcome.kind === 'damage' && item.outcome.seat === cue.seat && item.outcome.zone === 'base' && item.outcome.basis?.kind === 'played-printed-cost');
    const play = hit && g.outcomes.find(item => entering(item) && item.outcome.fromZone === 'hand' && item.outcome.seat === cue.seat && item.outcome.label?.startsWith('FREE PLAY')
        && item.outcome.printedCost === hit.outcome.basis!.value && hit.outcome.basis!.sourceIds.includes(key(item.outcome.card)));
    return hit && play ? { hit, play } : undefined;
};
const medalEvidence = (cue: CardEffectCue, item: PlacedOutcome) => {
    const before = cue.transition?.before, history = before?.attacksThisPhase, phaseEvidence = item.outcome.attackPhase, unit = unitIn(cue, item.outcome.card, item.outcome.seat);
    return xpTokens(cue, item) && !!unit && !!history && !!phaseEvidence && history.round === before?.round && history.phase === before.phase
        && phaseEvidence.round === history.round && phaseEvidence.phase === history.phase && phaseEvidence.incarnation === unit.incarnation
        && history.attacks.some(attack => attack.attackerId === unit.id && attack.incarnation === unit.incarnation);
};
const hopeEvidence = (cue: CardEffectCue, g: Geometry) => {
    const inspect = g.outcomes.find(item => item.outcome.kind === 'inspect' && item.outcome.zone === 'deck' && item.outcome.choice?.kind === 'private-top' && drawCards(item.outcome).length === 1);
    if (!inspect || inspect.outcome.choice?.kind !== 'private-top') return;
    const card = drawCards(inspect.outcome)[0], choice = inspect.outcome.choice;
    const play = g.outcomes.find(item => entering(item) && item.outcome.fromZone === 'deck' && same(item.outcome.card, card));
    if (choice.decision === 'leave') return { inspect, card, choice, play: undefined };
    const pay = g.outcomes.find(item => item.outcome.kind === 'pay' && same(item.outcome.card, card) && typeof item.outcome.amount === 'number' && item.outcome.amount >= 0);
    const cost = g.outcomes.find(item => item.outcome.kind === 'cost' && same(item.outcome.card, card) && item.outcome.amount === (choice.decision === 'play-free' ? 0 : -choice.discount));
    const base = cue.transition?.before.players[inspect.outcome.seat].base;
    if (!play || !pay || !cost || choice.decision === 'play-free' && (!base || base.hp - base.d > choice.freeAtRemainingHp || amount(pay.outcome) !== 0)) return;
    return { inspect, card, choice, play, pay, cost };
};
const lethalityEvidence = (cue: CardEffectCue, g: Geometry) => {
    const awards = g.outcomes.filter(item => xpTokens(cue, item) && !!item.outcome.upgradeCountBasis);
    const basis = awards[0]?.outcome.upgradeCountBasis;
    if (!basis || !basis.count) return;
    const defeat = g.outcomes.find(item => item.outcome.kind === 'defeat' && item.outcome.card?.id === basis.sourceId && typeof item.outcome.printedCost === 'number' && item.outcome.printedCost <= 3);
    const prior = defeat && unitIn(cue, defeat.outcome.card, defeat.outcome.seat);
    if (!defeat || !prior || prior.incarnation !== basis.incarnation || prior.u?.length !== basis.count || !prior.u.every(card => !!card.id && basis.upgradeIds.includes(card.id))
        || awards.reduce((sum, item) => sum + (item.outcome.cards?.length ?? 0), 0) !== basis.count || awards.some(item => item.outcome.upgradeCountBasis?.distributionId !== basis.distributionId)
        || (basis.resolution === 'prevented') !== (defeat.outcome.prevented === true)) return;
    return { awards, basis, defeat, prior };
};
const reflectionEvidence = (cue: CardEffectCue, g: Geometry) => g.outcomes.find(item => item.outcome.kind === 'debuff' && !!unitIn(cue, item.outcome.card, item.outcome.seat)
    && (unitIn(cue, item.outcome.card, item.outcome.seat, true)?.d === unitIn(cue, item.outcome.card, item.outcome.seat)?.d || g.outcomes.some(other => other.outcome.kind === 'defeat' && same(other.outcome.card, item.outcome.card))));
const repairEvidence = (cue: CardEffectCue, g: Geometry) => {
    const repairs = g.outcomes.filter(item => item.outcome.kind === 'heal' && item.outcome.allocation?.limit === 8 && Number.isSafeInteger(item.outcome.amount) && amount(item.outcome) >= 0 && !!unitIn(cue, item.outcome.card, item.outcome.seat) && amount(item.outcome) <= unitIn(cue, item.outcome.card, item.outcome.seat)!.d);
    return repairs.length && repairs.every(item => item.outcome.allocation?.id === repairs[0].outcome.allocation?.id) && repairs.reduce((sum, item) => sum + amount(item.outcome), 0) <= 8 ? repairs : [];
};
const covertEvidence = (cue: CardEffectCue, g: Geometry) => {
    const award = g.outcomes.find(item => xpTokens(cue, item) && item.outcome.cards?.length === 1), heal = award && g.outcomes.find(item => item.outcome.kind === 'heal' && same(item.outcome.card, award.outcome.card) && item.outcome.seat === award.outcome.seat && amount(item.outcome) <= 2);
    return award && heal ? { award, heal } : undefined;
};
const rescueEvidence = (cue: CardEffectCue, g: Geometry) => g.outcomes.find(item => {
    const o = item.outcome, captor = unitIn(cue, o.sourceCard, o.fromSeat ?? o.seat), after = unitIn(cue, o.card, o.seat, true);
    const afterCaptor = unitIn(cue, o.sourceCard, o.fromSeat ?? o.seat, true);
    return o.kind === 'rescue' && o.entryType === 'rescued' && !!o.ownerSeat && o.ownerSeat === o.seat && o.card?.owner === o.ownerSeat && o.unit?.owner === o.ownerSeat
        && !!o.unit?.incarnation && !!after && after.incarnation === o.unit.incarnation && same(o.unit, o.card) && !!captor?.cap?.some(card => same(card, o.card) && card.owner === o.ownerSeat) && item.from.exact
        && afterCaptor?.x === 1 && !afterCaptor.cap?.some(card => same(card, o.card)) && g.outcomes.some(other => other.outcome.kind === 'exhaust' && same(other.outcome.card, captor));
});

/** Suppression and choreography share the exact evidence functions above. */
export function batchA04Covers(cue: CardEffectCue, g: Geometry, item: PlacedOutcome): boolean {
    const o = item.outcome;
    switch (cue.definition.id) {
        case 'i-am-your-father': { const proof = fatherEvidence(cue, g); return item === proof || !!proof && proof.outcome.choice?.decision === 'damage' && o.kind === 'defeat' && same(o.card, proof.outcome.card); }
        case 'maximum-firepower': { const hits = powerHits(cue, g); return hits.includes(item) || !!hits.length && o.kind === 'defeat' && same(o.card, hits[0].outcome.card); }
        case 'galactic-ambition': { const proof = ambitionEvidence(cue, g); return !!proof && (item === proof.play || item === proof.hit); }
        case 'medal-ceremony': return medalEvidence(cue, item);
        case 'youre-my-only-hope': { const proof = hopeEvidence(cue, g); return !!proof && (item === proof.inspect || item === proof.play || ['pay', 'cost'].includes(o.kind) && same(o.card, proof.card)); }
        case 'calculated-lethality': { const proof = lethalityEvidence(cue, g); return !!proof && (item === proof.defeat || proof.awards.includes(item)); }
        case 'mystic-reflection': { const proof = reflectionEvidence(cue, g); return item === proof || !!proof && o.kind === 'defeat' && same(o.card, proof.outcome.card); }
        case 'midnight-repairs': return repairEvidence(cue, g).includes(item);
        case 'covert-strength': { const proof = covertEvidence(cue, g); return !!proof && (item === proof.award || item === proof.heal); }
        case 'unexpected-escape': { const proof = rescueEvidence(cue, g); return item === proof || !!proof && o.kind === 'exhaust' && same(o.card, proof.outcome.sourceCard); }
        default: return false;
    }
}

function TokenDrops({ cue, geometry: g, item, p, start = .27, end = .54, from }: Props & { item: PlacedOutcome; start?: number; end?: number; from?: EffectBox }) {
    const tokens = item.outcome.cards ?? [], after = unitIn(cue, item.outcome.card, item.outcome.seat, true)!;
    return <>{tokens.map((token, i) => {
        const to = g.endingCards?.[`${item.outcome.seat}:${key(token)}`] ?? shift(item.box, dimensions(item.box).w / 2 - 22, -dimensions(item.box).h / 2 + 14 + i * 13);
        const origin = from ?? shift(to, (i - (tokens.length - 1) / 2) * 20, -65), t = easeInOut(phase(p, start + i * .025, end + i * .025));
        const at = { ...to, ...mix(origin, to, t) }, chipW = to.w * (to.sx ?? 1), chipH = to.h * (to.sy ?? 1);
        return <ScreenPixels key={key(token)} at={at} opacity={opacity(p, start + i * .025)} color="#f1d88b"><g opacity={1 - phase(p, end - .05, end + .025)} transform={`scale(${.8 + Math.sin(t * Math.PI) * .35})`}><path d="M-8 4 L-12 20 L0 14 L12 20 L8 4" fill="#92702f" /><circle r="12" fill="#282112" strokeWidth="2" /><path d="M-6 0 H6 M0 -6 V6" strokeWidth="2" /></g>
            <g opacity={phase(p, end - .05, end + .025)}><rect x={-chipW / 2} y={-chipH / 2} width={chipW} height={chipH} rx="3" fill="#85caa4" stroke="none" /><text textAnchor="middle" y="3" fill="#092718" stroke="none" style={{ font: '600 8px sans-serif' }}>{chipW > 52 ? 'Experience' : 'XP'}</text></g>
        </ScreenPixels>;
    })}<Stats at={item.box} power={after.p} hp={after.h - after.d} p={p} start={end + .045} /></>;
}
function Father({ cue, geometry: g, p }: Props) {
    const proof = fatherEvidence(cue, g);
    if (!proof || proof.outcome.choice?.kind !== 'controller-response') return null;
    const choice = proof.outcome.choice, target = cardAt(g, choice.subject, choice.controller), refusal = choice.decision === 'no';
    const stopped = { ...target, ...mix(g.source, target, .68) }, defeated = g.outcomes.find(item => item.outcome.kind === 'defeat' && same(item.outcome.card, choice.subject));
    return <>
        <Route from={g.source} to={stopped} p={p} start={.05} end={.22} color="#ddb3ee" />
        <ScreenPixels at={target} color="#deb9ef" opacity={envelope(p, .04, .17, .36)}><path d={`M${-dimensions(target).w / 2 - 7} -38 V38 M${dimensions(target).w / 2 + 7} -38 V38`} strokeWidth="3" /><g transform="translate(0 -31)"><CountedMarks count={7} gap={7} radius={2} color="#ddb3ee" /></g></ScreenPixels>
        {refusal ? <>
            <ScreenPixels at={target} color="#f0cbfa" opacity={opacity(p, .22)}><rect x="-24" y="-14" width="48" height="28" rx="4" fill="#3b203c" strokeWidth="2" /><text textAnchor="middle" y="5" fill="#fff1ff" stroke="none" style={{ font: '800 16px sans-serif' }}>NO</text></ScreenPixels>
            <Route from={stopped} to={proof.from} p={p} start={.24} end={.39} color="#d7b6e7" />
            {drawCards(proof.outcome).map((card, i) => <Travel key={key(card)} from={shift(proof.from, i * 5, -i * 3)} to={g.endingCards?.[`${cue.seat}:${key(card)}`] ?? proof.to} card={card} back p={p} start={.34 + i * .04} end={.65 + i * .04} color="#e9caf4" />)}
            <Receipt at={shift(proof.from, 0, -47)} rows={[`${choice.controller.toUpperCase()} SAYS NO`, `${cue.seat.toUpperCase()} DRAWS ${drawCards(proof.outcome).length}`]} p={p} start={.69} color="#efccfb" />
        </> : <><Packet from={g.source} to={target} count={amount(proof.outcome)} p={p} start={.3} end={.5} color="#e8b0c8" /><Pulse at={target} p={p} start={.5} />{defeated ? <><Mask at={target} p={p} start={.55} /><Travel from={target} to={defeated.to} card={choice.subject} p={p} start={.56} end={.79} hold={false} /><Receipt at={target} rows={['7 DAMAGE · UNIT DEFEATED']} p={p} start={.82} /></> : <Stats at={target} hp={unitIn(cue, choice.subject, choice.controller)!.h - unitIn(cue, choice.subject, choice.controller)!.d - 7} p={p} start={.5} />}</>}
    </>;
}
function Firepower({ cue, geometry: g, p }: Props) {
    const hits = powerHits(cue, g);
    if (!hits.length) return null;
    const target = unitIn(cue, hits[0].outcome.card, hits[0].outcome.seat)!;
    const defeat = g.outcomes.find(item => item.outcome.kind === 'defeat' && same(item.outcome.card, target)), at = hits[0].box;
    const applied = hits.reduce((sum, item, i) => sum + (p >= .34 + i * .27 ? amount(item.outcome) : 0), 0);
    return <>
        {hits.map((item, i) => {
            const from = cardAt(g, item.outcome.sourceCard!, cue.seat), hit = .34 + i * .27;
            return <g key={item.key}><Receipt at={shift(from, 0, -dimensions(from).h / 2 - 22)} rows={[`${i + 1} · CURRENT POWER ${amount(item.outcome)}`]} p={p} start={.04 + i * .3} color="#ffd2a0" /><Packet from={from} to={at} count={amount(item.outcome)} p={p} start={hit - .14} end={hit} color={i ? '#ffc785' : '#ffc09f'} />{amount(item.outcome) > 0 && <Pulse at={at} p={p} start={hit} />}</g>;
        })}
        {!defeat && <Stats at={at} hp={target.h - target.d - applied} p={p} start={.34} />}
        <Receipt at={shift(at, 0, dimensions(at).h / 2 + 22)} rows={[`DAMAGE ${target.d} → ${target.d + applied}`, 'ABILITY FIRE · SOURCES STAY']} p={p} start={.39} color="#ffd0a8" />
        {defeat && <><Mask at={at} p={p} start={.39 + (hits.length - 1) * .27} /><Travel from={at} to={defeat.to} card={target} p={p} start={.4 + (hits.length - 1) * .27} end={.88} hold={false} color="#ffc69c" /></>}
    </>;
}
function Ambition({ cue, geometry: g, p }: Props) {
    const proof = ambitionEvidence(cue, g);
    if (!proof) return null;
    const { play, hit } = proof, base = cue.transition?.before.players[cue.seat].base;
    return <><Mask at={play.from} p={p} start={.17} /><Travel from={play.from} to={play.to} card={play.outcome.card} unit={play.outcome.unit} p={p} start={.18} end={.48} color="#dec4ef" />
        <Receipt at={middle(g)} rows={['FREE HAND PLAY']} p={p} start={.08} until={.5} color="#e2c5f3" /><Packet from={play.to} to={hit.box} count={amount(hit.outcome)} p={p} start={.52} end={.68} color="#ffb297" />
        {amount(hit.outcome) > 0 && <Pulse at={hit.box} p={p} start={.68} />}{base && <Stats at={hit.box} hp={base.hp - base.d - amount(hit.outcome)} p={p} start={.69} />}
        <Receipt at={shift(play.to, 110, 0)} rows={['FREE · EXHAUSTED', `OWN BASE · PRINTED ${amount(hit.outcome)}`]} p={p} start={.74} color="#e2c5f3" />
    </>;
}
function Medal({ cue, geometry: g, p }: Props) {
    const awards = g.outcomes.filter(item => medalEvidence(cue, item));
    return <>{awards.map((item, i) => <g key={item.key}>
        <ScreenPixels at={shift(item.box, 0, -dimensions(item.box).h / 2 - 23)} color="#f3d88d" opacity={opacity(p, .06 + i * .05)}><circle r="13" strokeWidth="2" /><path d="M-6 0 L-1 5 L7 -5" strokeWidth="2" /></ScreenPixels>
        <TokenDrops cue={cue} geometry={g} item={item} p={p} start={.25 + i * .055} end={.5 + i * .055} />
    </g>)}{awards.length > 0 && <Receipt at={middle(g)} rows={[`${awards.length} WITNESSED ATTACKS · THIS PHASE`, '1 XP EACH · PERMANENT TOKENS']} p={p} start={.69} color="#f1d791" />}</>;
}
function Hope({ cue, geometry: g, p }: Props) {
    const proof = hopeEvidence(cue, g);
    if (!proof) return null;
    const focus = bounded(shift(proof.inspect.from, 0, -57), 35, 46), free = proof.choice.decision === 'play-free';
    const paid = g.outcomes.find(item => item.outcome.kind === 'pay' && same(item.outcome.card, proof.card));
    const cost = g.outcomes.find(item => item.outcome.kind === 'cost' && same(item.outcome.card, proof.card));
    return <>
        <ScreenPixels at={focus} color="#b5e5ec" opacity={envelope(p, .03, .18, .4)}><circle r="33" strokeDasharray="6 5" strokeWidth="2" /><CardGhost back box={{ w: 31, h: 43.4 }} /><path d="M-40 -19 V19 M40 -19 V19" strokeWidth="3" /></ScreenPixels>
        <Receipt at={shift(focus, 0, -47)} rows={['PRIVATE TOP · CARD BACK']} p={p} start={.05} until={proof.play ? .4 : undefined} color="#c3edf2" />
        {proof.play ? <><Travel from={focus} to={proof.play.to} card={proof.card} unit={proof.play.outcome.unit} p={p} start={.35} end={.69} color="#bdeaf0" />
            <Receipt at={shift(proof.play.to, 110, 0)} rows={[free ? 'BASE HP ≤ 5 · FREE' : cost?.outcome.label?.replace(/^UNIT\s+/, '') ?? `DISCOUNT ${proof.choice.discount}`, `FROM DECK · PAID ${amount(paid!.outcome)}`, `EXHAUSTED · DECK ${cue.transition?.after.players[proof.inspect.outcome.seat].deck ?? '?'}`]} p={p} start={.73} color="#bce9ef" />
        </> : <Receipt at={shift(focus, 0, 47)} rows={['LEAVE TOP · DECK UNCHANGED']} p={p} start={.52} color="#c3edf2" />}
    </>;
}
function Lethality({ cue, geometry: g, p }: Props) {
    const proof = lethalityEvidence(cue, g);
    if (!proof) return null;
    const { prior, defeat, awards, basis } = proof, at = defeat.box, cut = .36, hub = middle(g);
    return <>
        {(prior.u ?? []).map((upgrade, i) => <ScreenPixels key={key(upgrade)} at={cardAt(g, upgrade, defeat.outcome.seat)} color="#efd1b0" opacity={envelope(p, .03 + i * .015, .16, .34)}><circle cx={-dimensions(cardAt(g, upgrade, defeat.outcome.seat)).w / 2 - 8} r="7" fill="#242016" /><text x={-dimensions(cardAt(g, upgrade, defeat.outcome.seat)).w / 2 - 8} y="3" textAnchor="middle" fill="#fff" stroke="none" style={{ font: '800 9px sans-serif' }}>{i + 1}</text></ScreenPixels>)}
        <Receipt at={shift(at, 0, -dimensions(at).h / 2 - 26)} rows={[`COUNT ${basis.count} ACTUAL UPGRADES`]} p={p} start={.05} color="#f2d2b0" />
        {defeat.outcome.prevented ? <Receipt at={at} rows={['DEFEAT PREVENTED', 'UPGRADES REMAIN']} p={p} start={cut} color="#f2d2b0" /> : <>
            <Mask at={at} p={p} start={cut} /><Travel from={at} to={defeat.to} card={prior} p={p} start={cut} end={.62} hold={false} color="#f2c1a1" />
            {(prior.u ?? []).map((upgrade, i) => {
                const origin = cardAt(g, upgrade, defeat.outcome.seat);
                return <g key={key(upgrade)}><AttachmentMask at={origin} p={p} start={cut} />{upgrade.t ? <ScreenPixels at={origin} color="#e3c2ed" opacity={envelope(p, cut, .42, .61)}><circle r={15 * (1 - phase(p, cut, .61))} strokeWidth="2" /></ScreenPixels> : <Travel from={origin} to={g.zones[`${upgrade.owner ?? defeat.outcome.seat}:discard`]} card={upgrade} p={p} start={cut + .025 * i} end={.63 + .025 * i} hold={false} color="#f0c5a6" />}</g>;
            })}
            <ScreenPixels at={at} color="#e9b29f" opacity={envelope(p, .36, .43, .64)}><path d="M-20 -26 L20 26 M20 -26 L-20 26" strokeWidth="4" /></ScreenPixels>
        </>}
        <ScreenPixels at={hub} color="#f2d794" opacity={envelope(p, .33, .51, .77)}><rect x="-64" y="-19" width="128" height="38" rx="5" fill="#17191f" /><CountedMarks count={basis.count} gap={20} radius={5} color="#f1d895" /></ScreenPixels>
        {awards.map((item, i) => <g key={item.key}><TokenDrops cue={cue} geometry={g} item={item} p={p} start={.51 + i * .06} end={.74 + i * .06} from={hub} /><Receipt at={shift(item.box, 0, dimensions(item.box).h / 2 + 23)} rows={[`${item.outcome.cards!.length} XP · +${item.outcome.cards!.length}/+${item.outcome.cards!.length}`]} p={p} start={.81} color="#f1d895" /></g>)}
    </>;
}
function Reflection({ cue, geometry: g, p }: Props) {
    const item = reflectionEvidence(cue, g);
    if (!item) return null;
    const before = unitIn(cue, item.outcome.card, item.outcome.seat)!, after = unitIn(cue, item.outcome.card, item.outcome.seat, true);
    const modifier = String(item.outcome.amount).replaceAll('−', '-').match(/([+-]?\d+)\/([+-]?\d+)/);
    const powerAfter = after?.p ?? Math.max(0, before.p + Number(modifier?.[1] ?? 0)), maxAfter = after?.h ?? Math.max(0, before.h + Number(modifier?.[2] ?? 0));
    const t = easeInOut(phase(p, .16, .5)), power = Math.round(before.p + (powerAfter - before.p) * t), maximum = Math.round(before.h + (maxAfter - before.h) * t);
    const force = item.outcome.sourceCard && unitIn(cue, item.outcome.sourceCard, cue.seat), at = item.box, defeat = g.outcomes.find(other => other.outcome.kind === 'defeat' && same(other.outcome.card, before));
    return <>
        {force && <Route from={cardAt(g, force, cue.seat)} to={at} p={p} start={.07} end={.34} color="#c2bdf7" />}
        <ScreenPixels at={shift(at, 0, -dimensions(at).h / 2 - 31)} color="#d4caf9" opacity={opacity(p, .08)}><rect x="-67" y="-24" width="134" height="48" rx="5" fill="#131727" />
            {[['POWER', power, before.p], ['MAX HP', maximum, before.h]].map(([label, value, old], i) => <g key={String(label)} transform={`translate(0 ${-10 + i * 21})`}><text x="-58" y="3" fill="currentColor" stroke="none" style={{ font: '700 7px sans-serif' }}>{label}</text>{sequence(Math.min(7, Number(old))).map(n => <rect key={n} x={-20 + n * 8} y="-6" width="5" height="10" fill={n < Number(value) ? '#c9b8f2' : '#2a2c3c'} stroke="none" />)}<text x="56" y="4" textAnchor="middle" fill="#fff" stroke="none" style={{ font: '800 12px sans-serif' }}>{value}</text></g>)}
        </ScreenPixels>
        {!defeat && <Stats at={at} power={power} hp={maximum - before.d} p={p} start={.18} />}
        <Receipt at={shift(at, 0, dimensions(at).h / 2 + 27)} rows={[`DAMAGE ${before.d} UNCHANGED`, ...(item.outcome.duration === 'phase' ? ['THIS PHASE'] : [])]} p={p} start={.59} color="#d4caf9" />
        {defeat && <><Mask at={at} p={p} start={.55} /><Travel from={at} to={defeat.to} card={before} p={p} start={.56} end={.82} hold={false} /><Receipt at={at} rows={['REDUCED HP · UNIT DEFEATED', 'NO NEW DAMAGE']} p={p} start={.85} color="#d4caf9" /></>}
    </>;
}
function Repairs({ cue, geometry: g, p }: Props) {
    const repairs = repairEvidence(cue, g);
    if (!repairs.length) return null;
    const hub = middle(g), used = repairs.reduce((sum, item) => sum + amount(item.outcome), 0);
    const spent = repairs.reduce((sum, item, i) => sum + (p >= .43 + i * .06 ? amount(item.outcome) : 0), 0);
    return <>
        <ScreenPixels at={hub} color="#a3e9c4" opacity={opacity(p, .05)}><rect x="-102" y="-24" width="204" height="48" rx="5" fill="#0b1a1b" strokeWidth="1" /><text y="-8" textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '700 9px sans-serif' }}>REPAIR BUDGET · {8 - spent} LEFT</text>{sequence(8).map(i => <rect key={i} x={-88 + i * 23} y="0" width="15" height="10" rx="2" fill={i >= spent ? '#8fcdb0' : '#253c38'} stroke="none" />)}<text y="19" opacity={opacity(p, .73)} textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '700 7px sans-serif' }}>{used} HEALED · MAX HP UNCHANGED</text></ScreenPixels>
        {repairs.map((item, i) => {
            const before = unitIn(cue, item.outcome.card, item.outcome.seat)!, end = .43 + i * .06, restored = p >= end;
            return <g key={item.key}><Packet from={hub} to={item.box} count={amount(item.outcome)} p={p} start={.19 + i * .06} end={end} color="#95e0b9" />
                <ScreenPixels at={shift(item.box, 0, -5)} color="#f3b5a2" opacity={opacity(p, .07)}><rect x="-21" y="-9" width="42" height="18" rx="3" fill="#101a24" /><text y="3" textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '700 8px sans-serif' }}>DMG {before.d - (restored ? amount(item.outcome) : 0)}</text></ScreenPixels>
                <Stats at={item.box} hp={before.h - before.d + (restored ? amount(item.outcome) : 0)} p={p} start={.07} />
                <Receipt at={shift(item.box, 0, -dimensions(item.box).h / 2 - 20)} rows={[`HEAL ${amount(item.outcome)}`]} p={p} start={end} color="#a3e9c4" />
            </g>;
        })}
    </>;
}
function Covert({ cue, geometry: g, p }: Props) {
    const proof = covertEvidence(cue, g);
    if (!proof) return null;
    const { award, heal } = proof, at = award.box, before = unitIn(cue, award.outcome.card, award.outcome.seat)!;
    const hub = shift(at, 0, -dimensions(at).h / 2 - 40);
    return <>
        <Packet from={shift(hub, -22, 0)} to={at} count={amount(heal.outcome)} p={p} start={.19} end={.47} color="#a0e1b5" />
        <TokenDrops cue={cue} geometry={g} item={award} p={p} start={.19} end={.47} from={shift(hub, 22, 0)} />
        <ScreenPixels at={shift(at, 0, -4)} color="#e5bb9f" opacity={envelope(p, .07, .2, .48)}><CountedMarks count={before.d} color="#e5a69c" /></ScreenPixels>
        <Receipt at={shift(at, 0, dimensions(at).h / 2 + 30)} rows={[`HEAL ${amount(heal.outcome)} · EXISTING DAMAGE`, '1 XP · +1/+1 CAPACITY']} p={p} start={.58} color="#cae8ac" />
    </>;
}
function Escape({ cue, geometry: g, p }: Props) {
    const rescue = rescueEvidence(cue, g);
    if (!rescue) return null;
    const o = rescue.outcome, captor = unitIn(cue, o.sourceCard, o.fromSeat ?? o.seat)!;
    const at = cardAt(g, captor, o.fromSeat!), pocket = g.pockets?.[`${o.fromSeat}:${key(captor)}`], remaining = cue.transition?.after.players[o.fromSeat!][o.fromZone === 'space' ? 'space' : 'ground'].find(card => same(card, captor))?.cap?.length;
    return <>
        <Pose at={at} card={captor} p={p} /><Stats at={g.endingCards?.[`${o.fromSeat}:${key(captor)}`] ?? at} power={captor.p} hp={captor.h - captor.d} p={p} start={.39} />
        <ScreenPixels at={rescue.from} color="#b7e5f1" opacity={envelope(p, .07, .23, .46)}><path d="M-20 12 V-16 H20 V12 M-13 -20 L-23 -26 M13 -20 L23 -26" strokeWidth="3" /></ScreenPixels>
        <AttachmentMask at={rescue.from} p={p} start={.3} />
        {pocket && <><AttachmentMask at={pocket} p={p} start={.35} /><ScreenPixels at={pocket} color="#c7b8df" opacity={opacity(p, .35)}><rect x={-pocket.w * (pocket.sx ?? 1) / 2} y="-19" width={pocket.w * (pocket.sx ?? 1)} height="38" rx="4" fill="#111421" strokeWidth="1" /><text textAnchor="middle" y="3" fill="currentColor" stroke="none" style={{ font: '700 8px sans-serif' }}>CAPTIVE {remaining ?? 0}</text></ScreenPixels></>}
        <Travel from={rescue.from} to={rescue.to} card={o.card} unit={o.unit} p={p} start={.3} end={.72} startSize={{ w: 23, h: 32.2 }} color="#b8e1ed" />
        <Receipt at={shift(rescue.to, 0, -dimensions(rescue.to).h / 2 - 25)} rows={[`RESCUE · OWNER ${o.ownerSeat!.toUpperCase()}`, o.unit?.x ? 'ARENA · ENTERED EXHAUSTED' : 'ARENA · ENTERED READY']} p={p} start={.76} color="#b8e1ed" />
        <Receipt at={shift(at, 0, -dimensions(at).h / 2 - 22)} rows={['CAPTOR EXHAUSTED · SURVIVES']} p={p} start={.53} color="#cbdbea" />
    </>;
}

export function BatchA04Signature(props: Props) {
    switch (props.cue.definition.id) {
        case 'i-am-your-father': return <Father {...props} />;
        case 'maximum-firepower': return <Firepower {...props} />;
        case 'galactic-ambition': return <Ambition {...props} />;
        case 'medal-ceremony': return <Medal {...props} />;
        case 'youre-my-only-hope': return <Hope {...props} />;
        case 'calculated-lethality': return <Lethality {...props} />;
        case 'mystic-reflection': return <Reflection {...props} />;
        case 'midnight-repairs': return <Repairs {...props} />;
        case 'covert-strength': return <Covert {...props} />;
        case 'unexpected-escape': return <Escape {...props} />;
        default: return null;
    }
}
