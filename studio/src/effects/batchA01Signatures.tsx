import type { ReactNode } from 'react';
import type { CardRef, Seat, UnitRef } from '../data/types';
import type { CardEffectCue, CardEffectOutcome } from './types';
import { easeInOut, easeOut, envelope, phase } from './animationTimeline';
import { AbilityGlyph, CardGhost, OutcomeVisual, mix, sequence, type EffectBox, type PlacedOutcome, type Point } from './primitives';

type Geometry = {
    source: EffectBox;
    target: EffectBox;
    friendlyBase: EffectBox;
    outcomes: PlacedOutcome[];
    zones: Record<string, EffectBox>;
};
type Props = { cue: CardEffectCue; geometry: Geometry; p: number };
type Receipt = CardEffectOutcome & {
    fromSeat?: Seat;
    ownerSeat?: Seat;
    sourceCard?: CardRef | null;
    cards?: CardRef[];
    duration?: string;
    entersReady?: boolean;
};
const W = 1000;
const H = 600;
const sameCard = (a: CardRef | null | undefined, b: CardRef | null | undefined) => !!a && !!b &&
    (a.id && b.id ? a.id === b.id : a.n === b.n && a.s === b.s);
const kind = ({ outcome }: PlacedOutcome) => String(outcome.kind);
const receipt = ({ outcome }: PlacedOutcome) => outcome as Receipt;
const sx = (box: EffectBox) => box.sx ?? 1;
const sy = (box: EffectBox) => box.sy ?? 1;
const shift = (box: EffectBox, x = 0, y = 0): EffectBox => ({ ...box, x: box.x + x / sx(box), y: box.y + y / sy(box) });
const pixelSize = (box: EffectBox) => ({ w: box.w * sx(box), h: box.h * sy(box) });
const bounded = (at: EffectBox, halfWidth = 55, halfHeight = 15): EffectBox => ({ ...at,
    x: Math.max((halfWidth + 8) / sx(at), Math.min(W - (halfWidth + 8) / sx(at), at.x)),
    y: Math.max((halfHeight + 44) / sy(at), Math.min(H - (halfHeight + 118) / sy(at), at.y)),
});
const curvePoint = (from: Point, control: Point, to: Point, t: number): Point => ({
    x: (1 - t) ** 2 * from.x + 2 * (1 - t) * t * control.x + t * t * to.x,
    y: (1 - t) ** 2 * from.y + 2 * (1 - t) * t * control.y + t * t * to.y,
});

/** Children use screen pixels, so a tall mobile board cannot squash cards or text. */
function Pixels({ at, opacity = 1, color, children }: { at: EffectBox; opacity?: number; color?: string; children: ReactNode }) {
    return <g transform={`translate(${at.x} ${at.y}) scale(${1 / sx(at)} ${1 / sy(at)})`} opacity={opacity} style={{ color }}>{children}</g>;
}

function Label({ at, text, opacity = 1, color = '#d6ecff' }: { at: EffectBox; text: string; opacity?: number; color?: string }) {
    const width = Math.max(60, Math.min(206, text.length * 5.6 + 18));
    return <Pixels at={bounded(at, width / 2, 12)} opacity={opacity} color={color}>
        <rect x={-width / 2} y="-11" width={width} height="22" rx="4" fill="#070e19" fillOpacity=".96" strokeWidth="1" />
        <text y="3.3" fill="currentColor" stroke="none" textAnchor="middle" style={{ font: '700 9px var(--font-display, sans-serif)', letterSpacing: '.035em' }}>{text}</text>
    </Pixels>;
}

function Clock({ at, p, label }: { at: EffectBox; p: number; label: string }) {
    const shown = easeOut(phase(p, .57, .75));
    return <>
        <Pixels at={bounded(shift(at, 0, -pixelSize(at).h / 2 - 29), 14, 14)} opacity={shown} color="#e2b5ff">
            <circle r="11" fill="#120f22" strokeWidth="2" /><path d="M0 -6 V0 L5 3" strokeWidth="2" />
            <path d="M-6 -13 H6 M0 -13 V-11" strokeWidth="1.5" />
        </Pixels>
        <Label at={shift(at, 0, -pixelSize(at).h / 2 - 54)} text={label} opacity={shown} color="#e2b5ff" />
    </>;
}

/** Wrapped arrivals have an empty adjacent row; keep their receipts beside the card. */
function mobileReceiptAnchor(at: EffectBox, rows = 1): EffectBox | null {
    if (W * sx(at) >= 570) return null;
    const dimensions = at.cardSize ?? pixelSize(at);
    const width = 146;
    const rightSpace = (W - at.x) * sx(at) - dimensions.w / 2;
    // Clamp the complete receipt stack. Clamping its rows separately near the caption folds them together.
    return bounded(shift(at, (rightSpace >= width + 24 ? 1 : -1) * (dimensions.w / 2 + width / 2 + 17), 0),
        width / 2, 12 + (rows - 1) * 12.5);
}

function Route({ from, to, p, start = .12, end = .52, color = '#b2dcff', bend = -45 }: { from: EffectBox; to: EffectBox; p: number; start?: number; end?: number; color?: string; bend?: number }) {
    const control = shift({ ...from, x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, bend, -35);
    return <path d={`M${from.x} ${from.y} Q${control.x} ${control.y} ${to.x} ${to.y}`} pathLength="1"
        stroke={color} strokeWidth="2" strokeDasharray="1" strokeDashoffset={1 - easeOut(phase(p, start, end))}
        opacity={envelope(p, start, start + .12, .86) * .85} />;
}

function Packet({ from, to, p, start, end, color, width = 3 }: { from: EffectBox; to: EffectBox; p: number; start: number; end: number; color: string; width?: number }) {
    const progress = phase(p, start, end);
    const at = { ...from, ...mix(from, to, easeOut(progress)) };
    const tail = mix(from, to, easeOut(Math.max(0, progress - .2)));
    const opacity = progress > 0 && progress < 1 ? Math.min(1, progress * 10, (1 - progress) * 8) : 0;
    return <g opacity={opacity}>
        <path d={`M${tail.x} ${tail.y} L${at.x} ${at.y}`} stroke={color} strokeWidth={width * 3} opacity=".35" />
        <path d={`M${tail.x} ${tail.y} L${at.x} ${at.y}`} stroke="#f3ffdf" strokeWidth={width} />
        <Pixels at={at} color={color}><circle r={width + 2} fill="#f3ffdf" stroke="none" /></Pixels>
    </g>;
}

function Peace({ geometry: g, p }: Props) {
    const shield = g.outcomes.find(item => kind(item) === 'shield');
    if (!shield) return null;
    const at = shield.box;
    const dimensions = pixelSize(at);
    const radius = Math.max(38, Math.min(69, dimensions.h * .58));
    const closure = easeInOut(phase(p, .13, .47));
    const light = envelope(p, .02, .35, .8);
    return <>
        <Route from={g.source} to={at} p={p} color="#a8dbff" bend={34} />
        <Pixels at={at} opacity={light} color="#acdfff">
            {sequence(6).map(i => {
                const theta = i * Math.PI / 3;
                const shutter = easeInOut(phase(p, .07 + i * .035, .28 + i * .039));
                const r = radius + (1 - shutter) * 56;
                return <g key={i} transform={`translate(${Math.cos(theta) * r} ${Math.sin(theta) * r}) rotate(${i * 60 + 90})`}>
                    <path d="M-15 7 L0 -7 L15 7" strokeWidth="3" /><path d="M-9 13 H9" opacity=".5" />
                </g>;
            })}
            <path d={`M0 ${-radius} L${radius * .87} ${-radius * .5} V${radius * .5} L0 ${radius} L${-radius * .87} ${radius * .5} V${-radius * .5} Z`}
                pathLength="1" strokeDasharray="1" strokeDashoffset={1 - closure} strokeWidth="3" fill="#79c4ff" fillOpacity={closure * .08} />
        </Pixels>
        <Pixels at={shift(at, dimensions.w / 2 + 13, -dimensions.h / 2 + 6)} opacity={phase(p, .48, .66)} color="#9ed5ff">
            <circle r="13" fill="#0c2137" /><AbilityGlyph kind="shield" size={15} />
        </Pixels>
        <Label at={shift(at, 0, -dimensions.h / 2 - 20)} text="1 SHIELD TOKEN" opacity={phase(p, .39, .6)} color="#a8dbff" />
    </>;
}

function Briefing({ cue, geometry: g, p }: Props) {
    const draws = g.outcomes.filter(item => kind(item) === 'draw');
    if (!draws.length) return null;
    const chosen = draws[0];
    const amount = draws.reduce((total, item) => total + (typeof item.outcome.amount === 'number' ? item.outcome.amount : 1), 0);
    const count = Math.min(6, amount);
    const deck = chosen.from;
    const hand = chosen.to;
    return <>
        <Route from={g.source} to={deck} p={p} end={.3} color="#ffbb84" />
        <Pixels at={deck} opacity={envelope(p, .02, .28, .77)} color="#ffc297">
            <path d="M-30 -25 V-35 H-12 M30 -25 V-35 H12 M-30 25 V35 H-12 M30 25 V35 H12" strokeWidth="3" />
            {sequence(count).map(i => <g key={i} transform={`translate(${(i - (count - 1) / 2) * 23} ${-18 - easeOut(phase(p, .06 + i * .045, .29 + i * .045)) * 12})`}>
                <rect x="-8" y="-10" width="16" height="20" rx="2" fill="#1b1a23" /><text y="3" textAnchor="middle" fill="#ffdfc2" stroke="none" style={{ font: '700 9px sans-serif' }}>{i + 1}</text>
            </g>)}
        </Pixels>
        {sequence(count).map(i => <Packet key={i} from={shift(deck, (i - (count - 1) / 2) * 9, 0)} to={shift(hand, (i - (count - 1) / 2) * 11, 0)}
            p={p} start={.17 + i * .055} end={.53 + i * .055} width={2} color="#ffd6aa" />)}
        <Label at={shift(deck, 0, -50)} text={`${chosen.outcome.seat.toUpperCase()} CHOSEN · DRAW ${amount}`} opacity={phase(p, .06, .22)} color="#ffd1aa" />
        <Label at={shift(hand, 0, -48)} text={`DECK → ${chosen.outcome.seat === cue.seat ? 'YOUR' : chosen.outcome.seat.toUpperCase()} HAND`} opacity={phase(p, .48, .68)} color="#ffd1aa" />
    </>;
}

function Fighting({ geometry: g, p }: Props) {
    const ready = g.outcomes.find(item => kind(item) === 'ready');
    if (!ready) return null;
    const at = ready.box;
    const dimensions = pixelSize(at);
    const lift = easeOut(phase(p, .15, .55));
    return <>
        <Route from={g.source} to={at} p={p} color="#7ee3d5" bend={25} />
        <Pixels at={at} opacity={envelope(p, .03, .4, .88)} color="#9ef4e4">
            {[-1, 1].map(side => <g key={side} transform={`translate(${side * (dimensions.w / 2 + 16)} 0)`}>
                <path d={`M0 ${dimensions.h * .36} V${dimensions.h * .36 - lift * dimensions.h * .8}`} strokeWidth="3" />
                <path d={`M-6 ${dimensions.h * .36 - lift * dimensions.h * .8 + 7} L0 ${dimensions.h * .36 - lift * dimensions.h * .8} L6 ${dimensions.h * .36 - lift * dimensions.h * .8 + 7}`} strokeWidth="3" />
            </g>)}
            {sequence(3).map(i => <path key={i} d="M-11 5 L0 -5 L11 5" transform={`translate(0 ${dimensions.h / 2 + 15 - phase(p, .12 + i * .055, .63 + i * .055) * (dimensions.h + 25)})`}
                opacity={envelope(p, .12 + i * .055, .36 + i * .055, .68 + i * .055)} strokeWidth="3" />)}
        </Pixels>
        <Label at={shift(at, 0, -dimensions.h / 2 - 39)} text="POWER ≤3 · READY" opacity={phase(p, .08, .24)} color="#9ef4e4" />
    </>;
}

function Outmaneuver({ geometry: g, p }: Props) {
    const affected = g.outcomes.filter(item => kind(item) === 'exhaust');
    if (!affected.length) return null;
    const arena = affected[0].outcome.zone === 'space' ? 'space' : 'ground';
    const zones = [g.zones[`p1:${arena}`], g.zones[`p2:${arena}`]].filter(Boolean);
    const sweep = easeInOut(phase(p, .16, .53));
    const midpoint = zones.length === 2 ? { ...zones[0], x: (zones[0].x + zones[1].x) / 2, y: (zones[0].y + zones[1].y) / 2 } : affected[0].box;
    return <>
        {zones.map((zone, i) => {
            const pad = 7 / sx(zone);
            return <g key={i} opacity={envelope(p, .02, .3, .88)} style={{ color: '#ffd175' }}>
                <rect x={zone.x - zone.w / 2 - pad} y={zone.y - zone.h / 2 - 7 / sy(zone)} width={zone.w + pad * 2} height={zone.h + 14 / sy(zone)} rx="5" strokeDasharray="9 7" strokeWidth="2" fill="#b97824" fillOpacity=".07" />
                <path d={`M${zone.x - zone.w / 2 + zone.w * sweep} ${zone.y - zone.h / 2} V${zone.y + zone.h / 2}`} stroke="#ffe2a0" strokeWidth="4" />
            </g>;
        })}
        {affected.map((item, i) => <Pixels key={item.key} at={item.box} opacity={envelope(p, .19 + i * .015, .49, .9)} color="#ffd175">
            <path d="M-19 -13 H19 M-19 13 H19" strokeWidth="3" /><path d="M-10 0 H10" strokeWidth="5" />
        </Pixels>)}
        <Label at={shift(midpoint, 0, -36)} text={`${arena.toUpperCase()} · BOTH PLAYERS`} opacity={phase(p, .03, .19)} color="#ffe1a3" />
    </>;
}

function Delta({ geometry: g, p }: Props) {
    const buffs = g.outcomes.filter(item => kind(item) === 'buff').slice(0, 3);
    if (!buffs.length) return null;
    return <>
        {buffs.map((item, i) => {
            const start = .12 + i * .14;
            const dimensions = pixelSize(item.box);
            const amount = String(item.outcome.amount ?? '+?');
            return <g key={item.key}>
                <Route from={i ? buffs[i - 1].box : g.source} to={item.box} p={p} start={start} end={start + .19} color="#a6f6a6" bend={i % 2 ? 34 : -34} />
                <Pixels at={item.box} opacity={envelope(p, start, start + .18, .95)} color="#bdfeb6">
                    {sequence(3 - i).map(n => <path key={n} d="M-12 6 L0 -6 L12 6" strokeWidth="3" transform={`translate(0 ${-dimensions.h / 2 - 7 - n * 13})`} />)}
                    <circle cx={dimensions.w / 2 + 11} cy={-dimensions.h / 2 + 4} r="11" fill="#123223" />
                    <text x={dimensions.w / 2 + 11} y={-dimensions.h / 2 + 7} textAnchor="middle" fill="#dcffdd" stroke="none" style={{ font: '700 10px sans-serif' }}>{i + 1}</text>
                </Pixels>
                <Label at={shift(item.box, 0, -dimensions.h / 2 - 57 - i % 2 * 25)} text={`${amount} · THIS PHASE`} opacity={phase(p, start + .12, start + .28)} color="#bdffbe" />
            </g>;
        })}
    </>;
}

function Failure({ cue, geometry: g, p }: Props) {
    const defeated = g.outcomes.filter(item => kind(item) === 'defeat');
    const upgrades = defeated.filter(item => !sameCard(item.outcome.card, cue.target));
    if (!upgrades.length) return null;
    const host = g.target;
    const hostSize = pixelSize(host);
    const isToken = (item: PlacedOutcome) => (item.outcome.card as CardRef & { t?: number } | null | undefined)?.t === 1;
    const ordinary = upgrades.filter(item => !isToken(item));
    const tokens = upgrades.filter(isToken);
    const afterHost = cue.transition?.after.players[cue.targetSeat ?? upgrades[0].outcome.seat];
    const settledHost = [...(afterHost?.ground ?? []), ...(afterHost?.space ?? [])].find(unit => sameCard(unit, cue.target));
    return <>
        <Pixels at={host} opacity={envelope(p, .03, .32, .9)} color="#ffd391">
            <path d={`M${-hostSize.w / 2 - 7} ${-hostSize.h / 2} V${hostSize.h / 2} H${-hostSize.w / 2 + 8} M${hostSize.w / 2 + 7} ${-hostSize.h / 2} V${hostSize.h / 2} H${hostSize.w / 2 - 8}`} strokeWidth="2" />
        </Pixels>
        {upgrades.map((item, i) => {
            const start = .21 + i * .055;
            const from = item.box.exact ? item.box : shift(host, (i - (upgrades.length - 1) / 2) * 30, hostSize.h / 2 + 17);
            const token = isToken(item);
            const depart = easeInOut(phase(p, start + .1, .79 + i * .025));
            const control = shift({ ...from, x: (from.x + item.to.x) / 2, y: (from.y + item.to.y) / 2 }, (i % 2 ? 1 : -1) * 36, -55);
            const at = { ...from, ...curvePoint(from, control, item.to, depart) };
            return <g key={item.key}>
                <Route from={host} to={from} p={p} start={.05} end={start} color="#ff926f" bend={12} />
                {from.exact && <rect x={from.x - from.w / 2 - 1} y={from.y - from.h / 2 - 1} width={from.w + 2} height={from.h + 2} rx="3" fill="#0e1522" stroke="none" opacity={phase(p, start, start + .09)} />}
                <Pixels at={from} opacity={envelope(p, start - .08, start + .05, start + .25)} color="#ff9a7f">
                    <path d="M-17 -14 L17 14 M-17 14 L17 -14" strokeWidth="3" /><path d="M-24 0 H-11 M11 0 H24" strokeWidth="2" />
                </Pixels>
                {token ? <Pixels at={from} opacity={envelope(p, start, start + .07, start + .4)} color="#a8d7ff">
                    {sequence(6).map(n => <g key={n} transform={`rotate(${n * 60}) translate(0 ${-12 - easeOut(phase(p, start + .02, start + .35)) * 18})`}>
                        <path d="M-7 4 L0 0 L7 4" strokeWidth="2" />
                    </g>)}
                </Pixels> : <Pixels at={at} opacity={envelope(p, start, start + .08, .94)} color="#ff9c89">
                    <g transform={`rotate(${(i % 2 ? -1 : 1) * depart * 26}) scale(${1 - depart * .5})`}>
                        <CardGhost card={item.outcome.card} box={{ w: 27, h: 38 }} /><path d="M-8 -12 L8 12 M-8 12 L8 -12" stroke="#ffd2c4" strokeWidth="2" />
                    </g>
                </Pixels>}
            </g>;
        })}
        {upgrades.length <= 3 && upgrades.map((item, i) => <Label key={`selected-${item.key}`}
            at={shift(host, 0, -hostSize.h / 2 - 26 - (upgrades.length - 1 - i) * 24)}
            text={item.outcome.card?.n.toUpperCase() ?? 'SELECTED UPGRADE'} opacity={envelope(p, .03 + i * .025, .14 + i * .025, .5)} color="#ffbf9c" />)}
        <Label at={shift(host, 0, -hostSize.h / 2 - 28)} text={`${upgrades.length} UPGRADES DEFEATED`} opacity={phase(p, .5, .64)} color="#ffbf9c" />
        {!!ordinary.length && <Label at={shift(ordinary[0].to, 0, -37)} text={`${ordinary.length} → DISCARD`} opacity={phase(p, .68, .84)} color="#ff9c89" />}
        {!!tokens.length && <Label at={shift(host, 0, hostSize.h / 2 + 39)}
            text={settledHost?.u?.some(upgrade => upgrade.n === 'Experience') ? 'HOST SURVIVES · EXPERIENCE KEPT' : `${tokens.length} TOKEN${tokens.length === 1 ? '' : 'S'} REMOVED`}
            opacity={phase(p, .51, .7)} color="#b6d6fa" />}
        {settledHost && <Pixels at={shift(host, 0, hostSize.h / 2 - 15)} opacity={phase(p, .44, .66)} color="#ffd2a1">
            {[-1, 1].map(side => <g key={side} transform={`translate(${side * Math.max(12, hostSize.w / 2 - 12)} 0)`}>
                <rect x="-11" y="-15" width="22" height="29" rx="4" fill="#101820" strokeWidth="1.5" />
                <text y="1" textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '800 15px var(--font-display, sans-serif)' }}>{side < 0 ? settledHost.p : settledHost.h - settledHost.d}</text>
                <text y="10" textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '700 5px sans-serif' }}>{side < 0 ? 'PWR' : 'HP'}</text>
            </g>)}
        </Pixels>}
        {defeated.filter(item => sameCard(item.outcome.card, cue.target)).map(item => <OutcomeVisual key={item.key} placed={item} p={p} />)}
    </>;
}

function MovingCard({ placed, p, start, end, color, ready = false }: { placed: PlacedOutcome; p: number; start: number; end: number; color: string; ready?: boolean }) {
    const { from, to, outcome } = placed;
    const t = easeInOut(phase(p, start, end));
    const control = shift({ ...from, x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, 42, -60);
    const at = { ...from, ...curvePoint(from, control, to, t) };
    const sourceSize = from.cardSize ?? pixelSize(from);
    const destinationSize = to.cardSize ?? pixelSize(to);
    const width = Math.max(38, Math.min(88, sourceSize.w + (destinationSize.w - sourceSize.w) * t));
    const height = Math.max(54, Math.min(122, sourceSize.h + (destinationSize.h - sourceSize.h) * t));
    const candidate = outcome.unit ?? outcome.card;
    const unit = candidate && 'p' in candidate && 'h' in candidate && 'd' in candidate ? candidate as UnitRef : null;
    const exhausted = !ready && unit?.x === 1;
    return <>
        {from.exact && <rect x={from.x - from.w / 2 - 2} y={from.y - from.h / 2 - 2} width={from.w + 4} height={from.h + 4} rx="5" fill="#09121f" stroke="none" opacity={phase(p, start, start + .08)} />}
        <Route from={from} to={to} p={p} start={start - .06} end={end} color={color} />
        <Pixels at={at} opacity={phase(p, start - .03, start + .055)} color={color}>
            <g transform={`rotate(${exhausted ? 10 : (ready ? -7 : 9) * Math.sin(t * Math.PI)}) scale(${exhausted ? .94 : 1})`} opacity={exhausted ? .72 : 1}>
                <CardGhost card={outcome.card} box={{ w: width, h: height }} />
                {unit && [-1, 1].map(side => <g key={side} transform={`translate(${side * (width / 2 - 11)} ${height / 2 - 12})`}>
                    <rect x="-9" y="-10" width="18" height="20" rx="3" fill={side < 0 ? '#8e2631' : '#1a467f'} stroke="#cad9ed" strokeWidth="1" />
                    <text y="4" textAnchor="middle" fill="#f7faff" stroke="none" style={{ font: '800 12px var(--font-display, sans-serif)' }}>{side < 0 ? unit.p : unit.h - unit.d}</text>
                </g>)}
            </g>
            {ready && <g transform={`translate(${width / 2 - 6} ${-height / 2 + 7})`} opacity={phase(p, end - .08, end + .08)}><circle r="12" fill="#0d302c" /><AbilityGlyph kind="ready" size={14} /></g>}
        </Pixels>
    </>;
}

function Heart({ geometry: g, p }: Props) {
    const control = g.outcomes.find(item => kind(item) === 'control');
    if (!control) return null;
    const data = receipt(control);
    const owner = data.ownerSeat;
    const at = control.to;
    const dimensions = pixelSize(at);
    const settle = phase(p, .58, .76);
    const delayed = g.outcomes.some(item => kind(item) === 'delay' && sameCard(item.outcome.card, control.outcome.card));
    const side = mobileReceiptAnchor(at, 3);
    return <>
        <Pixels at={control.from} opacity={envelope(p, .03, .22, .55)} color="#e7b5ff">
            <path d="M-30 -9 H-13 L0 5 L13 -9 H30 M-30 9 H-13 L0 -5 L13 9 H30" strokeWidth="3" />
        </Pixels>
        <MovingCard placed={control} p={p} start={.17} end={.64} color="#d5a1ff" />
        <Pixels at={at} opacity={settle} color="#c7a4ff">
            <path d={`M${-dimensions.w / 2 - 7} ${dimensions.h / 2 + 5} H${dimensions.w / 2 + 7}`} strokeWidth="3" />
            <circle cx={dimensions.w / 2 + 11} cy={dimensions.h / 2 - 7} r="10" fill="#211431" /><path d={`M${dimensions.w / 2 + 6} ${dimensions.h / 2 - 7} h10 m-5 -5 v10`} strokeWidth="2" />
        </Pixels>
        <Label at={side ? shift(side, 0, -25) : shift(at, 0, dimensions.h / 2 + 28)} text={`${control.outcome.seat.toUpperCase()} CONTROLS${!side && owner ? ` · OWNER ${owner.toUpperCase()}` : ''}`} opacity={settle} color="#dbc2ff" />
        {side && owner && <Label at={side} text={`OWNER ${owner.toUpperCase()}`} opacity={settle} color="#dbc2ff" />}
        {delayed && (side ? <>
            <Label at={shift(side, 0, 25)} text={`${owner?.toUpperCase() ?? 'OWNER'} AT REGROUP START`} opacity={phase(p, .57, .75)} color="#e2b5ff" />
            <Pixels at={shift(side, -76, 25)} opacity={phase(p, .57, .75)} color="#e2b5ff"><AbilityGlyph kind="delay" size={10} /></Pixels>
        </> : <Clock at={at} p={p} label={`${owner?.toUpperCase() ?? 'OWNER'} AT REGROUP START`} />)}
    </>;
}

function Sneak({ cue, geometry: g, p }: Props) {
    const played = g.outcomes.find(item => kind(item) === 'play');
    if (!played) return null;
    const at = played.to;
    const dimensions = pixelSize(at);
    const portal = envelope(p, .06, .38, .74);
    const ready = receipt(played).entersReady === true || played.outcome.label === 'ENTERS READY';
    const cost = g.outcomes.find(item => kind(item) === 'cost');
    const payments = g.outcomes.filter(item => kind(item) === 'pay');
    const delayed = g.outcomes.some(item => kind(item) === 'delay' && sameCard(item.outcome.card, played.outcome.card));
    const paymentAnchor = bounded(shift(played.from, 0, -50), 110, 60);
    const eventCost = (cue as CardEffectCue & { playCost?: number }).playCost;
    const side = mobileReceiptAnchor(at, 3);
    return <>
        <Pixels at={at} opacity={portal} color="#c7adff">
            <path d={`M${-dimensions.w / 2 - 13} ${dimensions.h / 2 + 11} H${dimensions.w / 2 + 13}`} strokeWidth="5" />
            {[-1, 1].map(side => <path key={side} d={`M${side * (dimensions.w / 2 + 14)} ${dimensions.h / 2 + 11} V${dimensions.h / 2 + 11 - easeOut(phase(p, .13, .43)) * (dimensions.h + 20)}`} strokeWidth="3" />)}
        </Pixels>
        <MovingCard placed={played} p={p} start={.18} end={.63} color="#bc9cff" ready={ready} />
        {cost && <Label at={shift(paymentAnchor, 0, 25)} text={cost.outcome.label ?? `UNIT COST ${cost.outcome.amount ?? ''}`} opacity={envelope(p, .04, .2, .57)} color="#dcc5ff" />}
        {eventCost != null && <Label at={shift(paymentAnchor, 0, -25 * Math.max(1, payments.length))} text={`EVENT PAYMENT ${eventCost}`} opacity={envelope(p, .01, .15, .51)} color="#efd5ff" />}
        {payments.map((payment, i) => <Label key={payment.key} at={shift(paymentAnchor, 0, -i * 25)} text={payment.outcome.label ?? `${payment.outcome.amount ?? ''} RESOURCES PAID`}
            opacity={envelope(p, .04 + i * .08, .2 + i * .08, .55 + i * .06)} color="#efd5ff" />)}
        {ready && <Label at={side ? shift(side, 0, -25) : shift(at, 0, dimensions.h / 2 + 23)} text="PLAYED READY" opacity={phase(p, .53, .7)} color="#8ef0d8" />}
        {eventCost != null && payments.length === 1 && <Label at={side ?? shift(at, 0, dimensions.h / 2 + 49)}
            text={`EVENT ${eventCost} · UNIT ${payments[0].outcome.amount ?? '?'} PAID`} opacity={phase(p, .59, .76)} color="#efd5ff" />}
        {delayed && (side ? <>
            <Label at={shift(side, 0, 25)} text="DEFEAT AT REGROUP START" opacity={phase(p, .57, .75)} color="#e2b5ff" />
            <Pixels at={shift(side, -76, 25)} opacity={phase(p, .57, .75)} color="#e2b5ff"><AbilityGlyph kind="delay" size={10} /></Pixels>
        </> : <Clock at={at} p={p} label="DEFEAT AT REGROUP START" />)}
    </>;
}

/** The explicit later scene resolves an existing obligation; it never installs a new delay. */
function Regroup({ geometry: g, p }: Props) {
    const resolved = g.outcomes.find(item => ['control', 'defeat'].includes(kind(item)));
    if (!resolved) return null;
    const at = resolved.outcome.kind === 'control' ? resolved.from : resolved.box;
    const dimensions = at.cardSize ?? pixelSize(at);
    const anticipation = envelope(p, .01, .16, .54);
    const control = resolved.outcome.kind === 'control';
    const landing = control ? resolved.to : at;
    const side = mobileReceiptAnchor(landing);
    return <>
        <Pixels at={shift(at, 0, -dimensions.h / 2 - 23)} opacity={anticipation} color="#e2b5ff">
            <circle r="13" fill="#120f22" strokeWidth="2" />
            <g transform={`rotate(${easeOut(phase(p, .05, .31)) * 90})`}><path d="M0 -8 V0 L6 4" strokeWidth="2" /></g>
            <path d="M-6 -16 H6 M0 -16 V-13" strokeWidth="1.5" />
        </Pixels>
        <Label at={shift(at, 0, -dimensions.h / 2 - 50)} text="REGROUP START" opacity={anticipation} color="#e2b5ff" />
        {control ? <>
            <MovingCard placed={resolved} p={p} start={.3} end={.72} color="#d5a1ff" />
            <Label at={side ?? shift(landing, 0, pixelSize(landing).h / 2 + 26)}
                text={`${resolved.outcome.fromSeat?.toUpperCase() ?? '?'} → ${resolved.outcome.seat.toUpperCase()} CONTROL`}
                opacity={phase(p, .66, .82)} color="#dbc2ff" />
        </> : <Label at={shift(resolved.to, 0, -32)} text="UNIT → DISCARD" opacity={phase(p, .7, .85)} color="#ffb3a3" />}
    </>;
}

function Recruit({ geometry: g, p }: Props) {
    const search = g.outcomes.find(item => kind(item) === 'search');
    if (!search) return null;
    const data = receipt(search);
    const cards = data.cards ?? [];
    const count = Math.max(0, Math.floor(cards.length || (typeof data.amount === 'number' ? data.amount : 0)));
    if (!count) return null;
    const selected = cards.findIndex(card => sameCard(card, data.card));
    const hasSelection = !!data.card;
    const selectedIndex = selected >= 0 ? selected : hasSelection ? Math.min(2, count - 1) : -1;
    const deck = g.zones[`${data.seat}:deck`] ?? search.from;
    const draw = g.outcomes.find(item => kind(item) === 'draw');
    const hand = draw?.to ?? g.zones[`${data.seat}:hand`] ?? search.to;
    const gap = Math.min(35, (W * sx(deck) - 68) / Math.max(1, count - 1));
    const fanWidth = (count - 1) * gap + 42;
    const fan = bounded(shift(deck, 58, -51), fanWidth / 2 + 9, 44);
    const spread = easeOut(phase(p, .07, .33));
    return <>
        <Label at={shift(fan, 0, -49)} text={`TOP ${count} · SEARCH FOR A UNIT`} opacity={phase(p, .03, .17)} color="#b4f2bd" />
        {sequence(count).map(i => {
            const chosen = i === selectedIndex;
            const slot = shift(fan, (i - (count - 1) / 2) * gap, Math.abs(i - (count - 1) / 2) * 3);
            const initial = mix(deck, slot, spread);
            const depart = chosen ? easeInOut(phase(p, .53, .81)) : easeInOut(phase(p, .62 + (i % 3) * .025, .9 + (i % 3) * .015));
            const destination = chosen ? hand : shift(deck, ((i * 3 + 1) % Math.max(1, count) - (count - 1) / 2) * 4, 15);
            const control = shift({ ...deck, x: (slot.x + destination.x) / 2, y: (slot.y + destination.y) / 2 }, chosen ? 18 : (i % 2 ? 36 : -36), chosen ? -36 : 48);
            const final = curvePoint(slot, control, destination, depart);
            const at = { ...deck, x: initial.x + (final.x - slot.x), y: initial.y + (final.y - slot.y) };
            const reveal = chosen ? easeInOut(phase(p, .34, .49)) : 0;
            const face = reveal > .5;
            const turnScale = chosen && reveal < 1 ? Math.max(.05, Math.abs(1 - reveal * 2)) : 1;
            const opacity = chosen ? phase(p, .07, .17) : phase(p, .07, .17) * (1 - phase(p, .89, .98));
            return <Pixels key={i} at={at} opacity={opacity} color={chosen ? '#d5ffc9' : '#8dbea5'}>
                <g transform={`rotate(${chosen ? 0 : ((i * 3 + 1) % 5 - 2) * 7 * Math.sin(depart * Math.PI)}) scale(${turnScale * (1 - (chosen ? 0 : depart * .5))} ${1 - (chosen ? 0 : depart * .5)})`}>
                    <CardGhost card={chosen ? data.card : undefined} box={{ w: 42, h: 59 }} back={!face} />
                    {chosen && <rect x="-25" y="-34" width="50" height="68" rx="5" fill="none" stroke="#d0ffbd" strokeWidth="3" opacity={phase(p, .29, .4)} />}
                </g>
            </Pixels>;
        })}
        <Pixels at={fan} opacity={envelope(p, .19, .34, .58)} color="#d3ffd7">
            <path d={`M${-fanWidth / 2 - 5} ${-31 + phase(p, .2, .4) * 62} H${fanWidth / 2 + 5}`} strokeWidth="3" />
        </Pixels>
        <Pixels at={shift(deck, 0, 19)} opacity={phase(p, .59, .76)} color="#b4dfc6">
            <path d="M-28 -5 V9 H28 V-5 M-10 -7 L10 5 M-10 5 L10 -7 M6 -7 H10 V-3 M6 5 H10 V1" strokeWidth="2" />
        </Pixels>
        {hasSelection && <Label at={shift(hand, 0, -44)} text="REVEAL 1 UNIT → HAND" opacity={phase(p, .48, .65)} color="#caffc3" />}
        {count > (hasSelection ? 1 : 0) && <Label at={shift(deck, 0, 47)} text={`${count - (hasSelection ? 1 : 0)} → DECK BOTTOM · RANDOM`} opacity={phase(p, .63, .8)} color="#b4dfc6" />}
    </>;
}

function Strike({ geometry: g, p }: Props) {
    const hit = g.outcomes.find(item => kind(item) === 'damage');
    if (!hit || !receipt(hit).sourceCard) return null;
    const from = hit.from;
    const to = hit.box;
    const focus = envelope(p, .02, .29, .67);
    const dimensions = pixelSize(to);
    const inset = 17 * (1 - easeOut(phase(p, .08, .31)));
    return <>
        <Route from={from} to={to} p={p} start={.05} end={.29} color="#bff2ad" bend={0} />
        <Pixels at={from} opacity={focus} color="#c4f6af">
            <path d="M-21 0 H-9 M9 0 H21 M0 -21 V-9 M0 9 V21" strokeWidth="2" /><circle r="7" strokeWidth="2" />
        </Pixels>
        <Pixels at={to} opacity={focus} color="#e4ffc5">
            {[-1, 1].flatMap(x => [-1, 1].map(y => <path key={`${x}:${y}`} d={`M${x * (dimensions.w / 2 + inset)} ${y * (dimensions.h / 2 + inset - 12)} V${y * (dimensions.h / 2 + inset)} H${x * (dimensions.w / 2 + inset - 12)}`} strokeWidth="3" />))}
        </Pixels>
        <Packet from={from} to={to} p={p} start={.29} end={.46} color="#cbf9a9" width={5} />
        <Pixels at={to} opacity={envelope(p, .43, .47, .66)} color="#d4f5af">
            <circle r={8 + easeOut(phase(p, .43, .66)) * 33} strokeWidth="2" />
        </Pixels>
        <Label at={shift(from, 0, -pixelSize(from).h / 2 - 23)} text={hit.outcome.amount == null ? 'UNIT DEALS ITS POWER' : `UNIT POWER → ${hit.outcome.amount} DAMAGE`} opacity={phase(p, .06, .23)} color="#d8ffc0" />
    </>;
}

/** New A01 choreography only. The twenty approved scenes retain their original renderer. */
export function BatchA01Signature(props: Props) {
    if (props.cue.stage === 'regroup-start') return <Regroup {...props} />;
    switch (props.cue.definition.id) {
        case 'moment-of-peace': return <Peace {...props} />;
        case 'mission-briefing': return <Briefing {...props} />;
        case 'keep-fighting': return <Fighting {...props} />;
        case 'outmaneuver': return <Outmaneuver {...props} />;
        case 'attack-pattern-delta': return <Delta {...props} />;
        case 'power-failure': return <Failure {...props} />;
        case 'change-of-heart': return <Heart {...props} />;
        case 'sneak-attack': return <Sneak {...props} />;
        case 'recruit': return <Recruit {...props} />;
        case 'strike-true': return <Strike {...props} />;
        default: return null;
    }
}
