import type { CardRef, Seat, UnitRef } from '../data/types';
import type { CardEffectCue, CardEffectOutcome } from './types';
import { A02_DEFINITIONS } from './batchA02';
import { previewPlayCost } from './previewCosts';
import { easeInOut, easeOut, envelope, phase } from './animationTimeline';
import { AbilityGlyph, CardGhost, CountedMarks, RaidPennant, ResourceBalance, ScreenPixels, mix, screenShift as shift, sequence, type EffectBox, type PlacedOutcome, type Point } from './primitives';

type Geometry = { source: EffectBox; target: EffectBox; friendlyBase: EffectBox; outcomes: PlacedOutcome[]; zones: Record<string, EffectBox>; cards?: Record<string, EffectBox> };
type Props = { cue: CardEffectCue; geometry: Geometry; p: number };
const A02_IDS = new Set(['search-your-feelings', 'it-binds-all-things', 'the-emperors-legion', 'rebel-assault', 'uwing-reinforcement', 'heroic-sacrifice', 'karabast', 'for-a-cause-i-believe-in', 'rallying-cry', 'force-throw']);
export const isBatchA02 = (cue: CardEffectCue) => A02_IDS.has(cue.definition.id);
const same = (a: CardRef | null | undefined, b: CardRef | null | undefined) => !!a && !!b && (a.id && b.id ? a.id === b.id : a.n === b.n && a.s === b.s);
const size = (at: EffectBox) => at.cardSize ?? { w: at.w * (at.sx ?? 1), h: at.h * (at.sy ?? 1) };
const pixelsWide = (at: EffectBox) => 1000 * (at.sx ?? 1);
const number = (outcome: CardEffectOutcome) => typeof outcome.amount === 'number' ? outcome.amount : 0;
// These in-play Force faces were verified in the A02 rules sources; a leader in HQ does not count.
const forceUnit = (cue: CardEffectCue) => {
    const player = cue.transition?.before.players[cue.seat];
    return [...(player?.ground ?? []), ...(player?.space ?? [])].find(card => ['SOR_051', 'SOR_005', 'SOR_010'].includes(card.s ?? ''));
};
const curved = (a: Point, b: Point, c: Point, t: number): Point => ({ x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * b.x + t * t * c.x, y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * b.y + t * t * c.y });
const bounded = (at: EffectBox, halfWidth = 60, halfHeight = 15): EffectBox => ({ ...at,
    x: Math.max((halfWidth + 8) / (at.sx ?? 1), Math.min(1000 - (halfWidth + 8) / (at.sx ?? 1), at.x)),
    y: Math.max((halfHeight + 42) / (at.sy ?? 1), Math.min(600 - (halfHeight + 118) / (at.sy ?? 1), at.y)),
});
const shelf = (g: Geometry, width = 250, height = 130): EffectBox => bounded({ ...g.source, x: 500, y: 290 }, width / 2, height / 2);

function Label({ at, text, opacity = 1, color = '#d9ecff' }: { at: EffectBox; text: string; opacity?: number; color?: string }) {
    const width = Math.max(64, Math.min(232, text.length * 5.4 + 18));
    return <ScreenPixels at={bounded(at, width / 2, 12)} opacity={opacity} color={color}>
        <rect x={-width / 2} y="-11" width={width} height="22" rx="4" fill="#070e19" fillOpacity=".97" strokeWidth="1" />
        <text textAnchor="middle" y="3.4" fill="currentColor" stroke="none" style={{ font: '700 9px var(--font-display,sans-serif)', letterSpacing: '.025em' }}>{text}</text>
    </ScreenPixels>;
}

function Route({ from, to, p, start, end, color, bend = -38 }: { from: EffectBox; to: EffectBox; p: number; start: number; end: number; color: string; bend?: number }) {
    const control = shift({ ...from, x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, bend, -34);
    return <path d={`M${from.x} ${from.y} Q${control.x} ${control.y} ${to.x} ${to.y}`} pathLength="1" strokeDasharray="1" strokeDashoffset={1 - easeOut(phase(p, start, end))} stroke={color} strokeWidth="2" opacity={envelope(p, start, end, Math.min(1.04, end + .2))} />;
}

function Packet({ from, to, p, start, end, count, color }: { from: EffectBox; to: EffectBox; p: number; start: number; end: number; count: number; color: string }) {
    const t = easeInOut(phase(p, start, end));
    const at = { ...from, ...mix(from, to, t) };
    const tail = mix(from, to, easeInOut(phase(p, start + .025, end + .025)));
    return <g opacity={envelope(p, start, start + .07, end + .055)}>
        <path d={`M${tail.x} ${tail.y} L${at.x} ${at.y}`} stroke={color} strokeWidth="10" opacity=".28" />
        <ScreenPixels at={at} color={color}><CountedMarks count={count} color={color} /></ScreenPixels>
    </g>;
}

function Pulse({ at, p, start, color, count = 0 }: { at: EffectBox; p: number; start: number; color: string; count?: number }) {
    const t = easeOut(phase(p, start, start + .22));
    const dimensions = size(at);
    return <ScreenPixels at={at} opacity={envelope(p, start, start + .055, start + .24)} color={color}>
        <rect x={-dimensions.w / 2 - 5} y={-dimensions.h / 2 - 5} width={dimensions.w + 10} height={dimensions.h + 10} rx="7" fill={color} fillOpacity={.15 * (1 - t)} strokeWidth="2" />
        <circle r={12 + t * Math.min(70, dimensions.h * .65)} opacity={1 - t} strokeWidth="3" />
        {count > 0 && <g transform={`translate(0 ${dimensions.h / 2 - 9})`}><CountedMarks count={count} color={color} /></g>}
    </ScreenPixels>;
}

/** Intact cards travel between measured slots; entry pose matches the ordinary board CSS. */
function Travel({ from, to, card, unit, back = false, exhausted = false, p, start, end, color, hold = true }: { from: EffectBox; to: EffectBox; card?: CardRef | null; unit?: UnitRef; back?: boolean; exhausted?: boolean; p: number; start: number; end: number; color: string; hold?: boolean }) {
    if (p < start - .025) return null;
    const t = easeInOut(phase(p, start, end));
    const control = shift({ ...from, x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, 27, -49);
    const at = { ...from, ...curved(from, control, to, t) };
    const destination = to.cardSize ?? { w: 46, h: 64.4 };
    const width = 42 + (destination.w - 42) * t;
    const height = 58.8 + (destination.h - 58.8) * t;
    const opacity = phase(p, start - .025, start + .035) * (hold ? 1 : 1 - phase(p, end, end + .08));
    return <>
        <Route from={from} to={to} p={p} start={start - .04} end={end} color={color} />
        <ScreenPixels at={at} opacity={opacity} color={color}>
            <g transform={`rotate(${exhausted ? 10 * t : -8 * Math.sin(t * Math.PI)}) scale(${exhausted ? 1 - .06 * t : 1})`} opacity={exhausted ? 1 - .28 * t : 1}>
                <CardGhost card={card} box={{ w: width, h: height }} back={back} />
                {unit && [-1, 1].map(side => <g key={side} transform={`translate(${side * (width / 2 - 11)} ${height / 2 - 12})`}>
                    <rect x="-9" y="-10" width="18" height="20" rx="3" fill={side < 0 ? '#8e2631' : '#1a467f'} stroke="#cad9ed" strokeWidth="1" />
                    <text y="4" textAnchor="middle" fill="#f7faff" stroke="none" style={{ font: '800 12px var(--font-display,sans-serif)' }}>{side < 0 ? unit.p : unit.h - unit.d}</text>
                </g>)}
            </g>
        </ScreenPixels>
    </>;
}

/** Cover old counters with the cumulative, current receipt, not conflicting final-HP badges. */
function Stat({ at, hp, power, opacity = 1 }: { at: EffectBox; hp: number; power?: number; opacity?: number }) {
    if (at.stat) return <ScreenPixels at={{ ...at, ...at.stat }} opacity={opacity} color="#ffbb9d">
        <circle r={Math.max(18, Math.min(29, at.stat.w * (at.sx ?? 1) / 2))} fill="#09121e" strokeWidth="3" />
        <text y="6" textAnchor="middle" fill="#ffe5d8" stroke="none" style={{ font: '800 20px var(--font-display,sans-serif)' }}>{hp}</text>
        <text y="16" textAnchor="middle" fill="#ffe5d8" stroke="none" style={{ font: '700 6px sans-serif' }}>HP</text>
    </ScreenPixels>;
    const dimensions = size(at);
    return <ScreenPixels at={at} opacity={opacity}>{[-1, 1].filter(side => side > 0 || power != null).map(side => <g key={side} transform={`translate(${side * (dimensions.w / 2 - 12)} ${dimensions.h / 2 - 13})`}>
        <rect x="-12" y="-13" width="24" height="26" rx="3" fill={side < 0 ? '#8e2631' : '#173a65'} stroke="#d7e7ff" strokeWidth="1" />
        <text y="4" textAnchor="middle" fill="#f7faff" stroke="none" style={{ font: '800 15px var(--font-display,sans-serif)' }}>{side < 0 ? power : hp}</text>
    </g>)}</ScreenPixels>;
}

function priorCard(cue: CardEffectCue, card: CardRef | null | undefined, seat: Seat): (UnitRef | { hp: number; d: number }) | undefined {
    const player = cue.transition?.before.players[seat];
    if (!player) return;
    if (same(player.base, card)) return player.base;
    return [...player.ground, ...player.space].find(unit => same(unit, card));
}
function hpBefore(cue: CardEffectCue, hit: PlacedOutcome) {
    const value = priorCard(cue, hit.outcome.card, hit.outcome.seat);
    return value ? ('h' in value ? value.h : value.hp) - value.d : undefined;
}
const richSearch = (g: Geometry, policy: NonNullable<CardEffectOutcome['deckOperation']>['policy']) => g.outcomes.find(item => item.outcome.kind === 'search' && item.outcome.deckOperation?.policy === policy
    && item.outcome.deckOperation.scope === (policy === 'whole-search-shuffle' ? 'whole' : 'top')
    && item.outcome.deckOperation.visibility === (policy === 'reveal-top-choice' ? 'public' : 'private'));
const actualAttack = (item: PlacedOutcome) => item.outcome.kind === 'attack' && !!item.outcome.attackId && typeof item.outcome.attackIndex === 'number' && !!item.outcome.sourceCard && !!item.outcome.card;
const phaseRecovery = (cue: CardEffectCue, item: PlacedOutcome) => item.outcome.kind === 'recover' && item.outcome.fromZone === 'discard' && item.outcome.zone === 'hand'
    && !!item.outcome.defeatPhase && !!item.outcome.card?.id && cue.transition?.before.defeatedThisPhase?.cards.some(card => card.id === item.outcome.card!.id)
    && cue.transition.before.defeatedThisPhase.round === cue.transition.before.round && cue.transition.before.defeatedThisPhase.phase === cue.transition.before.phase
    && item.outcome.defeatPhase.round === cue.transition?.before.round && item.outcome.defeatPhase.phase === cue.transition?.before.phase;

/** Only receipts fully expressed by the rich scene are suppressed in the generic renderer. */
export function batchA02Covers(cue: CardEffectCue, g: Geometry, placed: PlacedOutcome): boolean {
    const o = placed.outcome;
    switch (cue.definition.id) {
        case 'search-your-feelings': {
            const search = richSearch(g, 'whole-search-shuffle');
            return !!search && (o.kind === 'search' || o.kind === 'draw' && !!o.card?.id && search.outcome.deckOperation!.selectedIds.includes(o.card.id));
        }
        case 'it-binds-all-things': return o.kind === 'heal' || (o.kind === 'damage' && o.basis?.kind === 'healed');
        case 'the-emperors-legion': return !!phaseRecovery(cue, placed);
        case 'rebel-assault': return g.outcomes.some(actualAttack) && !!o.attackId && g.outcomes.some(item => actualAttack(item) && item.outcome.attackId === o.attackId) && ['attack', 'buff', 'damage', 'exhaust'].includes(o.kind);
        case 'uwing-reinforcement': return !!richSearch(g, 'top-search-bottom') && (o.kind === 'search' || o.kind === 'play' && o.fromZone === 'deck' && !!o.unit);
        case 'heroic-sacrifice': return o.kind === 'draw' && !!o.card || g.outcomes.some(actualAttack) && !!o.attackId && g.outcomes.some(item => actualAttack(item) && item.outcome.attackId === o.attackId) && ['attack', 'buff', 'damage', 'exhaust', 'defeat'].includes(o.kind);
        case 'karabast': return o.kind === 'damage' && o.basis?.kind === 'source-damage-plus-one' && !!o.sourceCard;
        case 'for-a-cause-i-believe-in': return richSearch(g, 'reveal-top-choice')?.outcome.deckOperation?.visibility === 'public' && (o.kind === 'search' || o.kind === 'damage' && o.basis?.kind === 'heroism-count' || o.kind === 'discard' && o.fromZone === 'deck');
        case 'rallying-cry': return o.kind === 'keyword' && o.keyword?.name === 'Raid' && o.duration === 'phase';
        case 'force-throw': return o.kind === 'discard' && !!o.chooserSeat || o.kind === 'damage' && o.basis?.kind === 'printed-cost' && !!forceUnit(cue) && g.outcomes.some(item => item.outcome.kind === 'discard' && !!item.outcome.chooserSeat && !!item.outcome.card?.s);
        default: return false;
    }
}

function Feelings({ cue, geometry: g, p }: Props) {
    const search = richSearch(g, 'whole-search-shuffle');
    if (!search) return null;
    const operation = search.outcome.deckOperation!;
    const deck = search.from;
    const draw = g.outcomes.find(item => item.outcome.kind === 'draw' && item.outcome.card?.id && operation.selectedIds.includes(item.outcome.card.id));
    const count = operation.looked.length;
    const after = cue.transition?.after.players[search.outcome.seat];
    const focus = bounded(shift(deck, 0, -64), 74, 58);
    const index = easeOut(phase(p, .07, .31));
    const shuffle = Math.sin(phase(p, .57, .82) * Math.PI);
    return <>
        <ScreenPixels at={focus} opacity={envelope(p, .02, .18, .49)} color="#ffd499">
            <circle r={25 + index * 21} strokeDasharray="7 6" strokeWidth="2" /><circle r="22" fill="#302214" fillOpacity=".3" strokeWidth="3" />
            {sequence(8).map(i => <g key={i} transform={`rotate(${i * 45 + index * 45})`}><path d="M0 -53 V-45" strokeWidth="2" /></g>)}
            <path d="M16 16 L34 34" strokeWidth="4" />
            <CardGhost box={{ w: 25, h: 35 }} back />
        </ScreenPixels>
        <Label at={shift(focus, 0, -61)} text={`WHOLE DECK ${count} · PRIVATE`} opacity={envelope(p, .02, .16, .56)} color="#ffd499" />
        {draw && <Travel from={focus} to={draw.to} card={draw.outcome.card} back p={p} start={.3} end={.57} color="#ffe2ae" />}
        <ScreenPixels at={deck} opacity={envelope(p, .55, .66, .93)} color="#e5ba78">
            {sequence(3).map(i => <g key={i} transform={`translate(${(i - 1) * shuffle * 24} ${(i - 1) * 7}) rotate(${(i - 1) * shuffle * 13})`}><CardGhost box={{ w: 31, h: 43 }} back /></g>)}
            <path d="M-42 0 A42 29 0 1 1 26 24 L23 9 M26 24 L10 26" pathLength="1" strokeDasharray="1" strokeDashoffset={1 - phase(p, .6, .84)} strokeWidth="3" />
        </ScreenPixels>
        <Label at={shift(deck, 0, -48)} text="SHUFFLE ENTIRE REMAINDER" opacity={phase(p, .6, .76)} color="#ffd499" />
        {after && <Label at={shift(draw?.to ?? focus, 0, -48)} text={`DECK ${after.deck} / HAND ${after.hand.length}`} opacity={phase(p, .83, .94)} color="#ffe1b0" />}
    </>;
}

function Binds({ cue, geometry: g, p }: Props) {
    const heal = g.outcomes.find(item => item.outcome.kind === 'heal');
    if (!heal) return null;
    const hit = g.outcomes.find(item => item.outcome.kind === 'damage' && item.outcome.basis?.kind === 'healed');
    const amount = number(heal.outcome);
    const ring = bounded(shift({ ...heal.box, x: (heal.box.x + (hit?.box.x ?? heal.box.x)) / 2, y: (heal.box.y + (hit?.box.y ?? heal.box.y)) / 2 }, 0, -27), 40, 36);
    const removed = easeInOut(phase(p, .14, .38));
    const hp = hpBefore(cue, heal);
    const targetHp = hit && hpBefore(cue, hit);
    return <>
        <ScreenPixels at={heal.box} opacity={envelope(p, .03, .17, .48)} color="#a4ffd0"><circle r={size(heal.box).h * .57} strokeDasharray="4 10" strokeWidth="2" /><AbilityGlyph kind="heal" size={27} /></ScreenPixels>
        <Packet from={shift(heal.box, 0, size(heal.box).h / 2 - 12)} to={ring} p={p} start={.15} end={.37} count={amount} color="#a4ffd0" />
        <ScreenPixels at={ring} opacity={envelope(p, .2, .39, .65)} color="#b9f6de"><circle r="30" strokeWidth="3" /><path d="M-40 0 H40 M0 -35 V-27 M0 27 V35" strokeWidth="2" /><CountedMarks count={amount} color="#adffd0" /></ScreenPixels>
        <Label at={shift(heal.box, 0, -size(heal.box).h / 2 - 23)} text={`HEALED ${amount}${hit ? ' · FORCE PRESENT' : ''}`} opacity={phase(p, .34, .46)} color="#baffdc" />
        {hp != null && <Stat at={heal.box} hp={hp + Math.round(removed * amount)} opacity={phase(p, .14, .23)} />}
        {hit && <>
            <Route from={ring} to={hit.box} p={p} start={.43} end={.64} color="#ffd4ae" />
            <Packet from={ring} to={hit.box} p={p} start={.45} end={.65} count={number(hit.outcome)} color="#ff9b7f" />
            <Pulse at={hit.box} p={p} start={.63} color="#ff937c" count={number(hit.outcome)} />
            <Label at={shift(hit.box, 0, -size(hit.box).h / 2 - 23)} text={`${number(hit.outcome)} HEALED → ${number(hit.outcome)} DAMAGE`} opacity={phase(p, .64, .77)} color="#ffc0a7" />
            {targetHp != null && <Stat at={hit.box} hp={Math.max(0, targetHp - (p >= .65 ? number(hit.outcome) : 0))} opacity={phase(p, .59, .65)} />}
        </>}
    </>;
}

function Legion({ cue, geometry: g, p }: Props) {
    const returning = g.outcomes.filter(item => phaseRecovery(cue, item));
    if (!returning.length) return null;
    const discard = returning[0].from;
    const rack = bounded(shift(discard, 0, -78), 107, 43);
    const before = cue.transition!.before.players[returning[0].outcome.seat];
    const excluded = before.discard.filter(card => !returning.some(item => same(item.outcome.card, card)));
    return <>
        <Label at={shift(rack, 0, -55)} text={`THIS PHASE · ${returning.length} DEFEATED UNITS`} opacity={envelope(p, .02, .18, .64)} color="#bdd8ff" />
        <ScreenPixels at={rack} opacity={envelope(p, .07, .24, .57)} color="#bad6ff">
            <path d="M-95 -37 V37 M95 -37 V37 M-95 -37 H-79 M79 -37 H95" strokeWidth="3" />
            {returning.map((item, i) => <g key={item.key} transform={`translate(${(i - (returning.length - 1) / 2) * 54} 0)`}><CardGhost card={item.outcome.card} box={{ w: 42, h: 59 }} /><circle cx="15" cy="-24" r="7" fill="#244b6e" stroke="#bfedff" /><path d="M12 -24 L14 -22 L18 -27" stroke="#d7f6ff" strokeWidth="1.5" /></g>)}
        </ScreenPixels>
        {excluded.slice(0, 2).map((card, i) => <ScreenPixels key={card.id ?? i} at={bounded(shift(rack, 93 + i * 13, 28), 15, 20)} opacity={envelope(p, .09, .22, .63) * .35} color="#a9b3c2"><CardGhost card={card} box={{ w: 26, h: 36 }} /></ScreenPixels>)}
        {excluded.length > 0 && <Label at={shift(rack, 90, 65)} text="INELIGIBLE · STAYS" opacity={envelope(p, .15, .28, .62)} color="#9daabb" />}
        {returning.map((item, i) => {
            const from = shift(rack, (i - (returning.length - 1) / 2) * 54, 0);
            const history = cue.transition!.before.defeatedThisPhase?.cards.find(card => card.id === item.outcome.card?.id);
            return <g key={item.key}>
                {history?.controller && history.controller !== item.outcome.seat && <Label at={shift(from, 0, 49)} text={`${history.controller.toUpperCase()} AT DEFEAT`} opacity={envelope(p, .14, .28, .51)} color="#bfd4ef" />}
                <Travel from={from} to={item.to} card={item.outcome.card} p={p} start={.43 + i * .045} end={.76 + i * .045} color="#d0e7ff" />
            </g>;
        })}
        <Label at={shift(returning[0].to, 55, -46)} text={`${returning[0].outcome.seat.toUpperCase()} HAND · ${returning.length} RECOVERED`} opacity={phase(p, .78, .9)} color="#c8e2ff" />
    </>;
}

/** Each actual attack gets its own damage beat and transient power tab. */
function Attack({ cue, geometry: g, p, placed, start, end, index, sacrifice }: Props & { placed: PlacedOutcome; start: number; end: number; index: number; sacrifice?: PlacedOutcome }) {
    const o = placed.outcome;
    const attacker = priorCard(cue, o.sourceCard, o.fromSeat ?? cue.seat);
    const unit = attacker && 'p' in attacker ? attacker : undefined;
    const linked = g.outcomes.filter(item => item.outcome.attackId === o.attackId);
    const buff = linked.find(item => item.outcome.kind === 'buff' && item.outcome.duration === 'attack' && same(item.outcome.card, o.sourceCard));
    const bonus = Number(String(buff?.outcome.amount ?? '0/0').replaceAll('−', '-').split('/')[0]);
    const damage = linked.filter(item => item.outcome.kind === 'damage');
    const combat = damage.find(item => item.outcome.damageType === 'combat');
    const from = placed.from;
    const target = combat?.box ?? placed.box;
    const dimensions = size(from);
    const duration = end - start;
    const impactAt = start + duration * .58;
    const moving = phase(p, start + duration * .2, start + duration * .88);
    const lunge = Math.sin(moving * Math.PI) * .58;
    const at = { ...from, ...mix(from, target, lunge) };
    const exhausted = easeOut(phase(p, impactAt, end));
    const shown = phase(p, start, start + .05);
    const resolvesSacrifice = sacrifice?.outcome.trigger === 'combat-damage' && combat && number(combat.outcome) > 0;
    const gone = resolvesSacrifice ? phase(p, end + .06, end + .1) : 0;
    const boost = envelope(p, start + .035, impactAt, end - .025);
    const basePrior = damage.map(hit => {
        const original = hpBefore(cue, hit);
        const priorHits = g.outcomes.filter(item => item.outcome.kind === 'damage' && same(item.outcome.card, hit.outcome.card) && (item.outcome.attackIndex ?? 0) < (o.attackIndex ?? index));
        return { hit, original, previous: priorHits.reduce((sum, item) => sum + number(item.outcome), 0) };
    });
    return <>
        <Route from={from} to={target} p={p} start={start} end={impactAt} color="#ffc992" bend={index % 2 ? 34 : -34} />
        <ScreenPixels at={from} opacity={envelope(p, start, start + .06, end)} color="#ffd0a2">
            <path d={`M${-dimensions.w / 2 - 9} ${-dimensions.h / 2} V${dimensions.h / 2} M${dimensions.w / 2 + 9} ${-dimensions.h / 2} V${dimensions.h / 2}`} strokeWidth="3" />
            <circle cx={-dimensions.w / 2 - 10} cy={-dimensions.h / 2 - 11} r="12" fill="#3a281a" />
            <text x={-dimensions.w / 2 - 10} y={-dimensions.h / 2 - 7} textAnchor="middle" fill="#ffdbb5" stroke="none" style={{ font: '800 12px sans-serif' }}>{index}</text>
        </ScreenPixels>
        <ScreenPixels at={from} opacity={shown} color="#efc19f"><rect x={-dimensions.w / 2 - 3} y={-dimensions.h / 2 - 3} width={dimensions.w + 6} height={dimensions.h + 6} rx="6" fill="#09121f" stroke="none" /></ScreenPixels>
        <ScreenPixels at={at} opacity={shown * (1 - gone)} color="#ffd2a3">
            <g transform={`rotate(${exhausted * 10}) scale(${1 - exhausted * .06})`} opacity={1 - exhausted * .28}>
                <CardGhost card={o.sourceCard} box={dimensions} />
                {unit && [-1, 1].map(side => <g key={side} transform={`translate(${side * (dimensions.w / 2 - 11)} ${dimensions.h / 2 - 12})`}>
                    <rect x="-10" y="-11" width="20" height="22" rx="3" fill={side < 0 ? '#8e2631' : '#1a467f'} stroke="#d7e7ff" strokeWidth="1" />
                    <text y="4" textAnchor="middle" fill="#fff2e4" stroke="none" style={{ font: '800 13px var(--font-display,sans-serif)' }}>{side < 0 ? unit.p + (boost > .15 ? bonus : 0) : unit.h - unit.d}</text>
                </g>)}
            </g>
            {sacrifice && <circle r={dimensions.h * (.6 - .21 * phase(p, impactAt, end + .06))} stroke="#ffd7b1" strokeWidth="2" strokeDasharray={p < impactAt ? '4 8' : undefined} opacity={envelope(p, start, impactAt, end + .1)} />}
        </ScreenPixels>
        {buff && <Label at={shift(at, 0, -dimensions.h / 2 - 22)} text={`+${bonus} THIS ATTACK`} opacity={boost} color="#ffdaa8" />}
        {damage.map(hit => <g key={hit.key}><Packet from={at} to={hit.box} p={p} start={impactAt - .055} end={impactAt} count={number(hit.outcome)} color="#ffaf83" /><Pulse at={hit.box} p={p} start={impactAt} color="#ff996f" count={number(hit.outcome)} /></g>)}
        {basePrior.map(({ hit, original, previous }) => {
            const nextAttack = g.outcomes.find(item => actualAttack(item) && (item.outcome.attackIndex ?? 0) > (o.attackIndex ?? index));
            const nextImpact = nextAttack ? .08 + ((nextAttack.outcome.attackIndex ?? index + 1) - 1) * .4 + .35 * .58 : 2;
            const opacity = p >= impactAt && p < nextImpact ? 1 : 0;
            const hp = original == null ? undefined : Math.max(0, original - previous - number(hit.outcome));
            const baseDamage = cue.transition?.before.players[hit.outcome.seat].base.d;
            return <g key={`proof-${hit.key}`}>
                {hp != null && <Stat at={hit.box} hp={hp} opacity={opacity} />}
                <Label at={shift(hit.box, 0, size(hit.box).h / 2 + 24)} text={hit.outcome.zone === 'base' && baseDamage != null ? `+${number(hit.outcome)} · BASE DAMAGE ${baseDamage + previous + number(hit.outcome)}` : `${number(hit.outcome)} COMBAT DAMAGE`} opacity={opacity} color="#ffbd9b" />
            </g>;
        })}
        {!resolvesSacrifice && unit && <Label at={shift(from, 0, dimensions.h / 2 + 25)} text={`EXHAUSTED · RESTING ${unit.p}/${unit.h - unit.d}`} opacity={phase(p, end - .02, end + .055)} color="#edcfae" />}
        {resolvesSacrifice && sacrifice && <>
            <Label at={shift(from, 0, -dimensions.h / 2 - 23)} text="COMBAT DEALT → SACRIFICE" opacity={envelope(p, end - .015, end + .06, end + .24)} color="#ffcbac" />
            <Travel from={from} to={sacrifice.to} card={sacrifice.outcome.card} p={p} start={end + .07} end={Math.min(.94, end + .3)} color="#f3b494" hold={false} />
            <Label at={shift(sacrifice.to, 0, -39)} text={`${(sacrifice.outcome.ownerSeat ?? sacrifice.outcome.seat).toUpperCase()} DISCARD`} opacity={phase(p, end + .26, end + .34)} color="#ffc9b1" />
        </>}
    </>;
}

function Assault(props: Props) {
    const attacks = props.geometry.outcomes.filter(actualAttack).sort((a, b) => (a.outcome.attackIndex ?? 0) - (b.outcome.attackIndex ?? 0));
    return <>{attacks.map((attack, i) => <Attack key={attack.key} {...props} placed={attack} start={.08 + i * .4} end={.43 + i * .4} index={i + 1} />)}</>;
}

function uwingPayment(cue: CardEffectCue) {
    const canonical = A02_DEFINITIONS.find(d => d.id === 'uwing-reinforcement');
    if (!canonical || !cue.transition || cue.stage || !cue.source?.id || cue.definition.id !== canonical.id || cue.definition.name !== canonical.name || cue.definition.setCode !== canonical.setCode || cue.transition.before.round !== cue.transition.after.round || cue.transition.before.phase !== cue.transition.after.phase || cue.source.n !== canonical.name || cue.source.s !== canonical.setCode || cue.source.owner !== cue.seat || cue.playPayment !== undefined) return;
    const before = cue.transition.before.players[cue.seat], after = cue.transition.after.players[cue.seat];
    let cost: number; try { cost = previewPlayCost(canonical, cue.transition.before, cue.seat, cue.playPayment); } catch { return; }
    const source = (card: CardRef) => card.id === cue.source!.id && card.n === canonical.name && card.s === canonical.setCode && card.owner === cue.seat;
    if (cue.playCost !== cost || before.hand.filter(source).length !== 1 || after.hand.some(card => card.id === cue.source!.id) || after.discard.filter(source).length !== 1 || before.res.total !== after.res.total || before.res.ready - after.res.ready !== cost) return;
    return { cost, after };
}

function UwingEventRoute({ from, to, card, p, back = false, start = .025, end = .2 }: { from: EffectBox; to: EffectBox; card?: CardRef; p: number; back?: boolean; start?: number; end?: number }) {
    const left = 12 / (from.sx ?? 1), approach = shift(to, 0, 24), route = [from, { ...from, x: left }, { ...approach, x: left }, approach, to];
    const t = easeInOut(phase(p, start, end)), segment = Math.min(3, Math.floor(t * 4));
    const at = { ...from, ...mix(route[segment], route[segment + 1], easeInOut(t * 4 - segment)) };
    return <>
        <path d={route.map((point, i) => `${i ? 'L' : 'M'}${point.x} ${point.y}`).join(' ')} stroke="#9cdce8" strokeWidth="1.5" opacity={envelope(p, start, start + .035, end + .08)} />
        <ScreenPixels at={at} opacity={envelope(p, start, start + .02, end + .06)}><CardGhost card={card} back={back} box={{ w: 20, h: 28 }} /></ScreenPixels>
    </>;
}

function UwingArrival({ from, to, item, p, start, end, index }: { from: EffectBox; to: EffectBox; item: PlacedOutcome; p: number; start: number; end: number; index: number }) {
    const rail = item.outcome.zone === 'space' ? 1000 - 12 / (from.sx ?? 1) : 12 / (from.sx ?? 1);
    const arrival = start + (end - start) * .76, t = easeInOut(phase(p, start, arrival));
    const points = [from, { ...from, x: rail }, { ...to, x: rail }, to], segment = Math.min(2, Math.floor(t * 3));
    const at = { ...from, ...mix(points[segment], points[segment + 1], easeInOut(t * 3 - segment)) };
    const grown = easeOut(phase(p, arrival, end)), destination = size(to), w = 20 + (destination.w - 20) * grown, h = 28 + (destination.h - 28) * grown, unit = item.outcome.unit!;
    return <>
        <path d={points.map((point, i) => `${i ? 'L' : 'M'}${point.x} ${point.y}`).join(' ')} stroke="#c4ebff" strokeWidth="1.5" opacity={envelope(p, start, start + .04, end + .07)} />
        <ScreenPixels at={at} opacity={phase(p, start, start + .035)} color="#c4ebff"><g transform={`rotate(${10 * grown}) scale(${1 - .06 * grown})`} opacity={1 - .28 * grown}>
            <CardGhost card={item.outcome.card} box={{ w, h }} />
            <g opacity={phase(p, arrival, end)}>
                <rect x={-w / 2 + 1} y={-h / 2 + 1} width={w - 2} height="14" rx="2" fill="#07121f" stroke="none" />
                <text y={-h / 2 + 10} textAnchor="middle" fill="#d8f2ff" stroke="none" style={{ font: '800 7px sans-serif' }}>{index + 1} FREE · EXH</text>
                {[-1, 1].map(side => <g key={side} transform={`translate(${side * (w / 2 - 11)} ${h / 2 - 12})`}><rect x="-9" y="-10" width="18" height="20" rx="3" fill={side < 0 ? '#8e2631' : '#1a467f'} stroke="#cad9ed" /><text y="4" textAnchor="middle" fill="#f7faff" stroke="none" style={{ font: '800 12px sans-serif' }}>{side < 0 ? unit.p : unit.h - unit.d}</text></g>)}
            </g>
        </g></ScreenPixels>
    </>;
}

function Uwing({ cue, geometry: g, p }: Props) {
    const search = richSearch(g, 'top-search-bottom');
    if (!search) return null;
    const operation = search.outcome.deckOperation!;
    const cards = operation.looked;
    const plays = operation.selectedIds.map(id => g.outcomes.find(item => item.outcome.kind === 'play' && item.outcome.fromZone === 'deck' && item.outcome.card?.id === id && !!item.outcome.unit)).filter((item): item is PlacedOutcome => !!item);
    const gap = Math.min(24, (pixelsWide(g.source) - 55) / Math.max(1, cards.length));
    const enemy: Seat = cue.seat === 'p1' ? 'p2' : 'p1';
    const upper = g.zones[enemy + ':ground'], base = g.zones[cue.seat + ':base'];
    const center = shift({ ...g.source, x: 500, y: upper && base ? (upper.y + upper.h / 2 + base.y - base.h / 2) / 2 : 290 }, 0, 8);
    const slots = cards.map((_, i) => shift(center, (i - (cards.length - 1) / 2) * gap, 0));
    const cost = plays.map(item => operation.printedCosts?.[item.outcome.card!.id!] ?? 0);
    const hasCost = cost.every(value => value > 0);
    const left = cards.filter(card => !operation.selectedIds.includes(card.id ?? ''));
    const deploying = envelope(p, .28, .43, .85);
    const payment = uwingPayment(cue), sourceSize = size(g.source);
    return <>
        {payment && <>
            <ResourceBalance at={g.zones[cue.seat + ':resources']} countAt={g.zones[cue.seat + ':resource-count']} ready={payment.after.res.ready} total={payment.after.res.total} p={p} start={.025} />
            <ScreenPixels at={g.source} opacity={phase(p, .025, .07)}><rect x={-sourceSize.w / 2 - 4} y={-sourceSize.h / 2 - 4} width={sourceSize.w + 8} height={sourceSize.h + 8} rx="5" fill="#0b1420" stroke="none" /></ScreenPixels>
            <UwingEventRoute from={g.source} to={g.zones[cue.seat + ':discard']} card={cue.source!} p={p} />
        </>}
        <Label at={shift(center, 0, -27)} text={`PRIVATE TOP ${cards.length} · CHOOSE UP TO ${operation.selectionLimit ?? 3}`} opacity={envelope(p, .02, .06, .16)} color="#b9e8ff" />
        <Label at={shift(center, 0, -27)} text={hasCost ? `${cost.join(' + ')} = ${cost.reduce((a, b) => a + b, 0)} / ${operation.printedCostLimit ?? 7}` : `PRINTED COST LIMIT ${operation.printedCostLimit ?? 7}`} opacity={envelope(p, .16, .24, .78)} color="#f0d5a2" />
        {cards.map((card, i) => {
            const chosen = operation.selectedIds.indexOf(card.id ?? '');
            const depart = chosen >= 0 ? phase(p, .3 + chosen * .17, .35 + chosen * .17) : phase(p, .76, .92);
            return <ScreenPixels key={card.id ?? i} at={slots[i]} opacity={phase(p, .03, .12) * (1 - depart)} color={chosen >= 0 ? '#d0f6ff' : '#708a9d'}>
                <CardGhost box={{ w: 20, h: 28 }} back />
                {chosen >= 0 && <g opacity={phase(p, .17, .25)}><rect x="-11" y="-15" width="22" height="30" rx="3" fill="none" strokeWidth="2" /><circle cy="0" r="7" fill="#183444" /><text y="3" textAnchor="middle" fill="#e5f8ff" stroke="none" style={{ font: '800 9px sans-serif' }}>{chosen + 1}</text></g>}
            </ScreenPixels>;
        })}
        <ScreenPixels at={center} opacity={deploying} color="#a9dcf8"><g transform="scale(.38)">
            <path d="M-61 -9 L-48 -27 H-25 L-16 -8 H16 L25 -27 H48 L61 -9 L38 -4 L24 6 H-24 L-38 -4 Z M-16 -8 L-10 -19 H10 L16 -8 M-58 -20 H-76 M58 -20 H76" fill="#10253a" strokeWidth="2" />
            <path d="M-28 12 L-37 24 M28 12 L37 24" strokeWidth="3" />
        </g></ScreenPixels>
        {plays.map((item, i) => {
            const slot = slots[cards.findIndex(card => same(card, item.outcome.card))];
            if (!slot) return null;
            const start = .3 + i * .17, end = start + .22;
            return <UwingArrival key={item.key} from={slot} to={item.to} item={item} p={p} start={start} end={end} index={i} />;
        })}
        {left.length > 0 && <UwingEventRoute from={center} to={search.from} p={p} back start={.76} end={.92} />}
        <ScreenPixels at={shift(search.from, 0, 19)} opacity={phase(p, .79, .89)} color="#8db7cc"><path d="M-28 -8 V9 H28 V-8 M-10 -5 L10 5 M-10 5 L10 -5" strokeWidth="2" /></ScreenPixels>
        <Label at={shift(search.from, 0, 43)} text={`${left.length} → BOTTOM · RANDOM`} opacity={phase(p, .8, .91)} color="#a7cddd" />
        <Label at={center} text={payment ? `EVENT ${payment.cost} PAID · ${plays.length} UNITS PLAY FREE` : `DECK → ${plays.length} REAL UNITS · FREE`} opacity={phase(p, .88, .95)} color="#d2eeff" />
    </>;
}

function Heroic(props: Props) {
    const { geometry: g, p } = props;
    const draw = g.outcomes.find(item => item.outcome.kind === 'draw' && !!item.outcome.card);
    const attack = g.outcomes.find(actualAttack);
    const sacrifice = attack && g.outcomes.find(item => item.outcome.kind === 'defeat' && item.outcome.attackId === attack.outcome.attackId && item.outcome.trigger === 'combat-damage');
    return <>
        {draw && <><Travel from={draw.from} to={draw.to} card={draw.outcome.card} back p={p} start={.06} end={.25} color="#c5e5ff" /><Label at={shift(draw.to, 0, -43)} text="1 DRAWN BEFORE ATTACK" opacity={envelope(p, .2, .31, .58)} color="#d5ebff" /></>}
        {attack && <Attack {...props} placed={attack} start={.29} end={.64} index={1} sacrifice={sacrifice} />}
    </>;
}

function Karabast({ cue, geometry: g, p }: Props) {
    const hit = g.outcomes.find(item => item.outcome.kind === 'damage' && item.outcome.basis?.kind === 'source-damage-plus-one' && !!item.outcome.sourceCard);
    if (!hit) return null;
    const source = priorCard(cue, hit.outcome.sourceCard, hit.outcome.fromSeat ?? cue.seat);
    const scar = source?.d ?? hit.outcome.basis!.value;
    const counter = bounded(shift(hit.from, 0, -size(hit.from).h / 2 - 30), 53, 20);
    const hp = hpBefore(cue, hit);
    return <>
        <ScreenPixels at={hit.from} opacity={phase(p, .02, .13)} color="#ffc77e"><g transform={`translate(0 ${size(hit.from).h / 2 - 11})`}><CountedMarks count={scar} color="#ffc77e" /></g></ScreenPixels>
        <Route from={shift(hit.from, 0, size(hit.from).h / 2 - 11)} to={counter} p={p} start={.07} end={.27} color="#ffd28d" />
        <Label at={counter} text={`${scar} DAMAGE + 1 = ${number(hit.outcome)}`} opacity={phase(p, .18, .31)} color="#ffd6a1" />
        <ScreenPixels at={shift(counter, 0, 26)} opacity={envelope(p, .19, .31, .47)} color="#ffae7c"><CountedMarks count={number(hit.outcome)} /></ScreenPixels>
        <Route from={counter} to={hit.box} p={p} start={.31} end={.57} color="#ffb581" />
        <Packet from={shift(counter, 0, 26)} to={hit.box} p={p} start={.36} end={.58} count={number(hit.outcome)} color="#ff9d7c" />
        <Pulse at={hit.box} p={p} start={.57} color="#ff977a" count={number(hit.outcome)} />
        <Label at={shift(hit.from, 0, size(hit.from).h / 2 + 24)} text={`${source && 'x' in source ? source.x ? 'EXHAUSTED · ' : 'READY · ' : ''}SCAR REMAINS`} opacity={phase(p, .64, .77)} color="#e6c89e" />
        <Label at={shift(hit.box, 0, -size(hit.box).h / 2 - 22)} text={`${number(hit.outcome)} ABILITY DAMAGE`} opacity={phase(p, .58, .73)} color="#ffc0a3" />
        {hp != null && <Stat at={hit.box} hp={Math.max(0, hp - number(hit.outcome))} opacity={phase(p, .58, .66)} />}
    </>;
}

function Cause({ cue, geometry: g, p }: Props) {
    const search = richSearch(g, 'reveal-top-choice');
    if (!search || search.outcome.deckOperation?.visibility !== 'public') return null;
    const op = search.outcome.deckOperation;
    const cards = op.looked;
    const center = shelf(g, 260, 120);
    const gap = Math.min(60, (pixelsWide(center) - 65) / Math.max(1, cards.length));
    const slots = cards.map((_, i) => shift(center, (i - (cards.length - 1) / 2) * gap, 0));
    const discarded = g.outcomes.filter(item => item.outcome.kind === 'discard' && item.outcome.fromZone === 'deck' && cards.some(card => same(item.outcome.card, card)));
    const kept = op.remainingOrder.filter(card => cards.some(looked => same(looked, card)) && !discarded.some(item => same(item.outcome.card, card)));
    const hit = g.outcomes.find(item => item.outcome.kind === 'damage' && item.outcome.basis?.kind === 'heroism-count');
    const hp = hit && hpBefore(cue, hit);
    const reveal = easeInOut(phase(p, .08, .24));
    return <>
        <Label at={shift(center, 0, -66)} text={`PUBLIC REVEAL · TOP ${cards.length}`} opacity={envelope(p, .02, .15, .45)} color="#f0d9a8" />
        {cards.map((card, i) => {
            const discard = discarded.find(item => same(item.outcome.card, card));
            const order = kept.findIndex(remaining => same(remaining, card));
            const destination = discard ? discard.to : shift(search.from, order * 5, -13 - order * 5);
            const travel = easeInOut(phase(p, .58 + i * .015, .86 + i * .015));
            const control = shift({ ...center, x: (slots[i].x + destination.x) / 2, y: (slots[i].y + destination.y) / 2 }, discard ? 38 : -38, discard ? 29 : -57);
            const at = { ...center, ...curved(slots[i], control, destination, travel) };
            const heroic = hit?.outcome.basis?.sourceIds.includes(card.id ?? '');
            return <g key={card.id ?? i}>
                <ScreenPixels at={at} opacity={phase(p, .05, .12) * (1 - phase(p, .89, .98))} color={heroic ? '#f8d79d' : '#adbfce'}>
                    <g transform={`scale(${reveal === 1 ? 1 : Math.max(.05, Math.abs(1 - reveal * 2))} 1)`}><CardGhost card={card} box={{ w: 43, h: 60.2 }} back={reveal < .5} /></g>
                    {heroic && <g transform="translate(14 -25)" opacity={envelope(p, .24, .34, .64)}><circle r="10" fill="#544425" stroke="#ffe6a9" /><path d="M-5 0 L0 -6 L5 0 L0 6 Z" fill="#ffdf8d" stroke="none" /></g>}
                    {order >= 0 && <g transform="translate(0 -39)" opacity={phase(p, .5, .61)}><rect x="-17" y="-10" width="34" height="20" rx="4" fill="#0c253b" /><text y="3" textAnchor="middle" fill="#dbf0ff" stroke="none" style={{ font: '800 9px sans-serif' }}>TOP {order + 1}</text></g>}
                    {discard && <g transform="translate(0 39)" opacity={envelope(p, .47, .56, .86)}><AbilityGlyph kind="discard" size={14} /></g>}
                </ScreenPixels>
                {heroic && hit && <Packet from={slots[i]} to={hit.box} p={p} start={.28} end={.47} count={1} color="#ffd899" />}
            </g>;
        })}
        {hit && <><Pulse at={hit.box} p={p} start={.46} color="#ffc081" count={number(hit.outcome)} /><Label at={shift(hit.box, 0, size(hit.box).h / 2 + 22)} text={`${number(hit.outcome)} HEROISM CARDS → ${number(hit.outcome)} DAMAGE`} opacity={phase(p, .45, .59)} color="#ffcf96" />{hp != null && <Stat at={hit.box} hp={Math.max(0, hp - number(hit.outcome))} opacity={phase(p, .47, .55)} />}</>}
        <Label at={shift(center, 0, 69)} text={`${discarded.length} TO DISCARD · ${kept.length} CHOSEN TOP ORDER`} opacity={phase(p, .52, .66)} color="#d6e1eb" />
        <ScreenPixels at={shift(search.from, 0, -16)} opacity={phase(p, .7, .88)} color="#bedef4"><path d="M-28 0 H28 M-28 -7 H28 M0 -27 V-10 M-8 -18 L0 -27 L8 -18" strokeWidth="2.5" /></ScreenPixels>
        <Label at={shift(search.from, 0, -53)} text={`TOP: ${kept.map(card => card.n.split(' ')[0]).join(' → ')}`} opacity={phase(p, .87, .95)} color="#c5e9ff" />
    </>;
}

function Rally({ geometry: g, p }: Props) {
    const grants = g.outcomes.filter(item => item.outcome.kind === 'keyword' && item.outcome.keyword?.name === 'Raid' && item.outcome.duration === 'phase');
    if (!grants.length) return null;
    const wave = easeInOut(phase(p, .08, .5));
    return <>
        {grants.map((item, i) => {
            const at = shift(item.box, 0, -size(item.box).h / 2 - 22);
            const start = .18 + i * .09;
            return <g key={item.key}>
                <Route from={i ? grants[i - 1].box : g.source} to={item.box} p={p} start={start - .08} end={start + .11} color="#f2d8a5" bend={26} />
                <ScreenPixels at={item.box} opacity={envelope(p, start - .08, start + .1, start + .3)} color="#eec786"><path d={`M${-size(item.box).w / 2 - 8} ${size(item.box).h * (.5 - wave)} H${size(item.box).w / 2 + 8}`} strokeWidth="4" /><path d={`M${-size(item.box).w / 2 - 8} ${size(item.box).h * (.5 - wave) + 7} H${size(item.box).w / 2 + 8}`} strokeWidth="1" /></ScreenPixels>
                <ScreenPixels at={bounded(at, 45, 18)} opacity={phase(p, start, start + .16)}><RaidPennant amount={item.outcome.keyword!.amount} /></ScreenPixels>
            </g>;
        })}
        <Label at={shift(shelf(g, 230, 45), 0, 40)} text="WHILE ATTACKING · RESTING POWER UNCHANGED" opacity={phase(p, .62, .78)} color="#ead5b1" />
    </>;
}

function Throw({ cue, geometry: g, p }: Props) {
    const discard = g.outcomes.find(item => item.outcome.kind === 'discard' && !!item.outcome.chooserSeat);
    if (!discard) return null;
    const forceCard = forceUnit(cue);
    const hit = forceCard && g.outcomes.find(item => item.outcome.kind === 'damage' && item.outcome.basis?.kind === 'printed-cost');
    const hand = g.zones[`${discard.outcome.chooserSeat}:hand`] ?? discard.from;
    const choice = bounded(shift(hand, 0, 45), 54, 20);
    const ring = bounded({ ...discard.from, x: (discard.from.x + (hit?.box.x ?? discard.to.x)) / 2, y: (discard.from.y + (hit?.box.y ?? discard.to.y)) / 2 }, 37, 37);
    const force = forceCard?.id ? g.cards?.[`${cue.seat}:${forceCard.id}`] : undefined;
    const hp = hit && hpBefore(cue, hit);
    const hasFace = !!discard.outcome.card?.s;
    return <>
        <ScreenPixels at={hand} opacity={envelope(p, .02, .17, .42)} color="#dbc0ff"><path d={`M${-Math.min(90, size(hand).w / 2) - 8} -36 V36 M${Math.min(90, size(hand).w / 2) + 8} -36 V36`} strokeWidth="3" /><path d="M-15 0 H15 M6 -8 L15 0 L6 8" strokeWidth="3" /></ScreenPixels>
        <Label at={choice} text={`${discard.outcome.chooserSeat!.toUpperCase()} CHOOSES`} opacity={envelope(p, .03, .17, .49)} color="#e6ceff" />
        <Travel from={discard.from} to={discard.to} card={discard.outcome.card} back={!hasFace} p={p} start={.22} end={.75} color="#d8b6ff" hold={false} />
        {hit && hasFace && <>
            <Label at={shift(ring, 0, -47)} text={`PRINTED COST ${hit.outcome.basis!.value}`} opacity={envelope(p, .26, .39, .72)} color="#e6ceff" />
            <ScreenPixels at={ring} opacity={envelope(p, .29, .42, .75)} color="#d6b4ff"><circle r="30" strokeWidth="3" /><circle r="22" strokeDasharray="4 7" /><path d="M0 -15 L8 0 L0 15 L-8 0 Z" strokeWidth="2" /></ScreenPixels>
            <Label at={shift(ring, 0, 47)} text="FRIENDLY FORCE UNIT" opacity={envelope(p, .3, .45, .7)} color="#dfc9ff" />
            {force && <Route from={force} to={ring} p={p} start={.26} end={.44} color="#c2a4f2" />}
            <Packet from={ring} to={hit.box} p={p} start={.44} end={.63} count={number(hit.outcome)} color="#dfb8ff" />
            <Pulse at={hit.box} p={p} start={.62} color="#d5a1ff" count={number(hit.outcome)} />
            <Label at={shift(hit.box, 0, -size(hit.box).h / 2 - 21)} text={`${number(hit.outcome)} DAMAGE · UNIT`} opacity={phase(p, .63, .77)} color="#e9ceff" />
            {hp != null && <Stat at={hit.box} hp={Math.max(0, hp - number(hit.outcome))} opacity={phase(p, .63, .69)} />}
        </>}
        <Label at={shift(discard.to, 0, -39)} text={`${(discard.outcome.ownerSeat ?? discard.outcome.seat).toUpperCase()} DISCARD · 1 CARD`} opacity={phase(p, .74, .86)} color="#dec4fa" />
    </>;
}

/** Rich choreography is driven by explicit receipts; unknown recordings stay at observed facts. */
export function BatchA02Signature(props: Props) {
    switch (props.cue.definition.id) {
        case 'search-your-feelings': return <Feelings {...props} />;
        case 'it-binds-all-things': return <Binds {...props} />;
        case 'the-emperors-legion': return <Legion {...props} />;
        case 'rebel-assault': return <Assault {...props} />;
        case 'uwing-reinforcement': return <Uwing {...props} />;
        case 'heroic-sacrifice': return <Heroic {...props} />;
        case 'karabast': return <Karabast {...props} />;
        case 'for-a-cause-i-believe-in': return <Cause {...props} />;
        case 'rallying-cry': return <Rally {...props} />;
        case 'force-throw': return <Throw {...props} />;
        default: return null;
    }
}
