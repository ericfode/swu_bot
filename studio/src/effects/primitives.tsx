import { useId, type ReactNode } from 'react';
import { cardImageUrl } from '../lib/cards';
import type { CardRef, UnitRef } from '../data/types';
import type { CardEffectOutcome } from './types';
import { ABILITY_LANGUAGE, type AbilityKind } from './abilities';
import { clamp, easeInOut, easeOut, envelope, phase } from './animationTimeline';

export type Point = { x: number; y: number };
export type EffectBox = Point & { w: number; h: number; exact: boolean; sx?: number; sy?: number; count?: number; stat?: Point & { w: number; h: number }; counters?: { power: Point & { w: number; h: number }; hp: Point & { w: number; h: number } }; cardSize?: { w: number; h: number }; statusBoxes?: Record<string, Point & { w: number; h: number }> };
export type PlacedOutcome = { outcome: CardEffectOutcome; box: EffectBox; from: EffectBox; to: EffectBox; key: string; slot: number; routeLabels?: boolean };
export const sequence = (count: number) => Array.from({ length: count }, (_, i) => i);
export const offset = (p: Point, x: number, y: number): Point => ({ x: p.x + x, y: p.y + y });
export const mix = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const colorOf = (kind: AbilityKind) => ABILITY_LANGUAGE.find(ability => ability.id === kind)?.color ?? '#f8bd68';
/** Rotate in screen space even when the board's SVG stretches into a tall mobile layout. */
export const screenRotate = (angle: number, box: EffectBox) => {
    const ratio = (box.sx ?? 1) / (box.sy ?? 1);
    return `scale(1 ${ratio}) rotate(${angle}) scale(1 ${1 / ratio})`;
};
export const screenCardSize = (box: EffectBox, width = 48, height = 68) => ({ w: width / (box.sx ?? 1), h: height / (box.sy ?? 1) });

/** Authored labels and packets keep their screen dimensions on tall mobile boards. */
export function ScreenPixels({ at, opacity = 1, color, children }: { at: EffectBox; opacity?: number; color?: string; children: ReactNode }) {
    return <g transform={`translate(${at.x} ${at.y}) scale(${1 / (at.sx ?? 1)} ${1 / (at.sy ?? 1)})`} opacity={opacity} style={{ color }}>{children}</g>;
}
export const screenShift = (at: EffectBox, x = 0, y = 0): EffectBox => ({ ...at, x: at.x + x / (at.sx ?? 1), y: at.y + y / (at.sy ?? 1) });

/** Erase only the measured attachment chip, never the dimensions of its host card. */
export function AttachmentMask({ at, p, start }: { at: EffectBox; p: number; start: number }) {
    const w = at.w * (at.sx ?? 1), h = at.h * (at.sy ?? 1);
    return <ScreenPixels at={at} opacity={phase(p, start, start + .045)}><rect x={-w / 2 - 2} y={-h / 2 - 2} width={w + 4} height={h + 4} rx="3" fill="#0b1420" stroke="none" /></ScreenPixels>;
}

/** Explicit resource balances cover the old aggregate at its measured location. */
export function ResourceBalance({ at, countAt, ready, total, p, start }: { at: EffectBox; countAt?: EffectBox; ready: number; total: number; p: number; start: number }) {
    const w = at.w * (at.sx ?? 1), h = at.h * (at.sy ?? 1), columns = Math.max(1, Math.floor((w + 3) / 12));
    return <><ScreenPixels at={at} opacity={phase(p, start, start + .045)}><rect x={-w / 2 - 2} y={-h / 2 - 2} width={w + 4} height={h + 4} fill="#0b1420" stroke="none" />{sequence(total).map(i => <rect key={i} x={-w / 2 + i % columns * 12} y={-h / 2 + Math.floor(i / columns) * 16} width="9" height="13" rx="2" fill={i < ready ? '#68b897' : '#0b1420'} stroke="#68b897" strokeOpacity={i < ready ? 1 : .5} strokeWidth="1" />)}</ScreenPixels>
        {countAt && <ScreenPixels at={countAt} opacity={phase(p, start, start + .045)}><rect x={-countAt.w * (at.sx ?? 1) / 2 - 2} y="-8" width={countAt.w * (at.sx ?? 1) + 4} height="16" fill="#0b1420" stroke="none" /><text textAnchor="middle" y="4" fill="#a0b0c5" stroke="none" style={{ font: '11px sans-serif' }}>{ready}/{total}</text></ScreenPixels>}</>;
}

/** An explicit resource remains a small facedown slot; knowledge does not imply public reveal. */
export function ResourceSlot({ at, index, spent, p, start }: { at: EffectBox; index: number; spent: boolean; p: number; start: number }) {
    const w = at.w * (at.sx ?? 1), h = at.h * (at.sy ?? 1);
    return <ScreenPixels at={at} opacity={phase(p, start, start + .04)}><rect x={-w / 2} y={-h / 2} width={w} height={h} rx="2" fill={spent ? '#141a23' : '#1b2a37'} stroke={spent ? '#6a6e7d' : '#78c99b'} strokeWidth="1" /><text textAnchor="middle" y="2" fill={spent ? '#89929f' : '#c7e4d4'} stroke="none" style={{ font: '700 6px sans-serif' }}>{index + 1}</text>{spent && <path d={`M${-w / 2 + 2} ${h / 2 - 3} H${w / 2 - 2}`} stroke="#c0a875" strokeWidth="1" />}</ScreenPixels>;
}

/** A token assembles in its measured arena slot; it has no hand or deck departure. */
export function TokenAssembly({ at, unit, p, start = .28, end = .63, color = '#cdd5a4' }: { at: EffectBox; unit: UnitRef; p: number; start?: number; end?: number; color?: string }) {
    if (p < start) return null;
    if (!at.exact) return <ScreenPixels at={at} color={color} opacity={phase(p, start, end)}><AbilityGlyph kind="create" size={24} /></ScreenPixels>;
    const s = at.cardSize ?? { w: at.w * (at.sx ?? 1), h: at.h * (at.sy ?? 1) }, t = easeInOut(phase(p, start, end)), h = s.h, w = s.w;
    return <ScreenPixels at={at} color={color} opacity={phase(p, start, start + .06)}>
        <g transform={'rotate(' + (unit.x ? 10 * t : 0) + ') scale(' + (unit.x ? 1 - .06 * t : 1) + ')'}>
            <rect x={-w / 2 - 3} y={-h / 2 - 3} width={w + 6} height={h + 6} rx="5" fill="none" strokeWidth="1.5" opacity={1 - t} strokeDasharray="4 3" />
            {[0, 1, 2, 3].map(i => <path key={i} d={'M' + (-w / 2 - (1 - t) * 14) + ' ' + (-h / 2 + (i + 1) * h / 5) + ' H' + (w / 2 + (1 - t) * 14)} strokeWidth="2" opacity={1 - t} />)}
            <g opacity={phase(p, start + .04, end)}><CardGhost card={unit} box={s} />
                <rect x={-w / 2 + 3} y={-h / 2 + 3} width={w - 6} height="22" rx="2" fill="#2a342a" stroke="none" />
                <text y={-h / 2 + 11} textAnchor="middle" fill="#eaf0c7" stroke="none" style={{ font: '800 6px sans-serif' }}>{unit.n.toUpperCase()}</text>
                <text y={-h / 2 + 20} textAnchor="middle" fill="#d7dfb6" stroke="none" style={{ font: '700 5px sans-serif' }}>TOKEN · EXHAUSTED</text>
                {[0, 1].map(i => <g key={i} transform={'translate(' + ((i ? 1 : -1) * (w / 2 - 11)) + ' ' + (h / 2 - 12) + ')'}><rect x="-10" y="-11" width="20" height="22" rx="3" fill={i ? '#174772' : '#8b2936'} stroke="#e5eccb" /><text y="4" textAnchor="middle" fill="#fff" stroke="none" style={{ font: '800 14px sans-serif' }}>{i ? Math.max(0, unit.h - unit.d) : unit.p}</text></g>)}
            </g>
        </g>
    </ScreenPixels>;
}

/** Damage counters retain their count as a payload moves or changes from healed to inflicted. */
export function CountedMarks({ count, radius = 3, gap = 11, color = '#ff9f7d' }: { count: number; radius?: number; gap?: number; color?: string }) {
    return <g style={{ color }}>{sequence(Math.max(0, Math.min(12, count))).map(i => <g key={i} transform={`translate(${(i - (count - 1) / 2) * gap} 0)`}>
        <path d={`M0 ${-radius - 2} L${radius + 2} 0 L0 ${radius + 2} L${-radius - 2} 0 Z`} fill="currentColor" stroke="none" />
        <path d={`M0 ${-radius} V${radius}`} stroke="#fff5df" strokeWidth="1" />
    </g>)}</g>;
}

/** Raid is an outlined, attack-conditional keyword, never a resting power badge. */
export function RaidPennant({ amount }: { amount: number }) {
    return <g style={{ color: '#f6d5a1' }}>
        <path d="M-39 -16 H34 L42 0 L34 16 H-39 Z" fill="#141921" fillOpacity=".95" strokeWidth="1.5" />
        <path d="M-28 -7 L-20 0 L-28 7 M-20 0 H-12" strokeWidth="2" />
        <text x="9" y="-2" textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '800 10px var(--font-display,sans-serif)' }}>RAID {amount}</text>
        <text x="9" y="9" textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '700 6px var(--font-display,sans-serif)', letterSpacing: '.06em' }}>THIS PHASE</text>
    </g>;
}

export function outcomeLabel(outcome: CardEffectOutcome): string {
    const amount = outcome.amount;
    if (outcome.prevented) return `${outcome.kind.toUpperCase()} PREVENTED`;
    if (outcome.kind === 'damage') return amount == null ? 'DAMAGE' : `−${amount} DAMAGE`;
    if (outcome.kind === 'heal') return amount == null ? 'HEALED' : `+${amount} HEAL`;
    if (outcome.kind === 'resource') return `+${amount ?? 1} RESOURCE${outcome.entersReady === false ? ' · EXHAUSTED' : outcome.entersReady === true ? ' · READY' : ''}`;
    if (outcome.kind === 'capture' && outcome.prevented) return 'CAPTURE PREVENTED';
    if (outcome.kind === 'return') return outcome.label?.startsWith('TOKEN CEASES') ? 'TOKEN CEASES' : outcome.destination === 'deck-bottom' ? '→ DECK BOTTOM' : '→ HAND';
    if (outcome.kind === 'suppress') return 'ABILITIES OFF';
    if (outcome.kind === 'exhaust') return outcome.amount === 0 ? 'ALREADY EXHAUSTED' : 'EXHAUSTED';
    if (outcome.kind === 'ready') return 'READY';
    if (outcome.kind === 'defeat') return outcome.prevented ? 'DEFEAT PREVENTED' : outcome.selection === 'opponent' ? 'OPPONENT CHOICE · DEFEATED' : 'DEFEATED';
    if (outcome.kind === 'keyword') return `${outcome.keyword?.name.toUpperCase() ?? 'KEYWORD'}${outcome.keyword?.name === 'Raid' ? ` ${outcome.keyword.amount}` : ''} · ${outcome.duration === 'attack' ? 'THIS ATTACK' : 'THIS PHASE'}`;
    if (outcome.kind === 'restrict') return outcome.nextAction?.operation === 'consume' ? 'NEXT ACTION CONSTRAINT CONSUMED' : outcome.restriction === 'must-attack' ? 'NEXT ACTION · ATTACK IF ABLE' : outcome.restriction === 'cannot-ready' ? `CANNOT READY · ROUND ${outcome.round ?? '?'}` : 'RESTRICTED';
    if (outcome.label) return outcome.label;
    switch (outcome.kind) {
        case 'create': return 'TOKEN CREATED' + (outcome.entersReady === false ? ' · EXHAUSTED' : outcome.entersReady === true ? ' · READY' : '');
        case 'shield': return 'SHIELDED';
        case 'buff': return amount == null ? 'POWER UP' : `${amount} BUFF`;
        case 'debuff': return amount == null ? 'WEAKENED' : `${amount} WEAKENED`;
        case 'draw': return `DRAW ${amount ?? 1}`;
        case 'discard': return `DISCARD ${amount ?? 1}`;
        case 'mill': return `${amount ?? ''} TO DISCARD`.trim();
        case 'recover': return 'RECOVER TO HAND';
        case 'attack': return 'ATTACK';
        case 'inspect': return 'HAND REVEALED';
        case 'cost': return 'COST REDUCED';
        case 'pay': return `${amount ?? ''} PAID`.trim();
        case 'play': return outcome.playAs === 'upgrade' ? 'UPGRADE PLAYED' : 'UNIT PLAYED';
        case 'rescue': return 'RESCUED TO ARENA';
        case 'attach': return outcome.unit ? 'ATTACHMENT TO ARENA' : 'UPGRADE REATTACHED';
        case 'capture': return 'CAPTURED';
        case 'control': return 'CONTROLLER CHANGED';
        case 'search': return `SEARCH ${amount ?? ''}`.trim();
        case 'delay': return 'AT REGROUP START';
    }
}

/** Preview receipts hold pre-effect cards; recorded receipts already hold the measured final card. */
export function outcomeStats(outcome: CardEffectOutcome, preview: boolean): { hp: number; power?: number } | null {
    if (outcome.prevented) return null;
    if (!['damage', 'heal', 'buff', 'debuff'].includes(outcome.kind) || !outcome.card) return null;
    const card = outcome.card as CardRef & { h?: number; hp?: number; d?: number; p?: number };
    const maximum = card.h ?? card.hp;
    if (maximum == null || card.d == null) return null;
    let hp = maximum - card.d;
    let power = card.p;
    if (preview) {
        if (outcome.kind === 'damage' && typeof outcome.amount === 'number') hp -= outcome.amount;
        if (outcome.kind === 'heal' && typeof outcome.amount === 'number') hp = Math.min(maximum, hp + outcome.amount);
        if (outcome.kind === 'buff' || outcome.kind === 'debuff') {
            const amount = String(outcome.amount ?? '').replaceAll('−', '-').match(/([+-]?\d+)\/([+-]?\d+)/);
            if (amount) { if (power != null) power += Number(amount[1]); hp += Number(amount[2]); }
        }
    }
    return { hp: Math.max(0, hp), ...(['buff', 'debuff'].includes(outcome.kind) && power != null ? { power: Math.max(0, power) } : {}) };
}

export function AbilityGlyph({ kind, size = 20 }: { kind: AbilityKind; size?: number }) {
    const s = size / 20;
    if (kind === 'attach') return <g transform={`scale(${s})`} className="ce-ability-glyph"><rect x="-15" y="-17" width="12" height="18" rx="2" /><path d="M-7 7 H15 L8 0 M15 7 L8 14 M-16 10 V18 H-5" /></g>;
    if (kind === 'capture') return <g transform={`scale(${s})`} className="ce-ability-glyph"><path d="M-17 -15 V18 H17 V-15 M-17 5 H17 M-8 -15 V5 M8 -15 V5 M0 -20 V-7 L-6 -13 M0 -7 L6 -13" /></g>;
    if (kind === 'rescue') return <g transform={`scale(${s})`} className="ce-ability-glyph"><path d="M-16 -3 V17 H16 V-3 M-8 -11 H8 M0 10 V-18 L-7 -10 M0 -18 L7 -10" /><path d="M-12 -4 H-4 M4 -4 H12" strokeDasharray="3 2" /></g>;
    if (kind === 'restrict') return <g transform={`scale(${s})`} className="ce-ability-glyph"><path d="M-9 -3 V-9 A9 9 0 0 1 9 -9 V-3" /><rect x="-13" y="-3" width="26" height="22" rx="3" /><path d="M0 4 V12" /></g>;
    if (kind === 'keyword') return <g transform={`scale(${s})`} className="ce-ability-glyph"><path d="M-16 -16 V18 M-16 -15 H14 L6 -3 L14 9 H-16 M-8 -1 H3 M-2 -7 L4 -1 L-2 5" /></g>;
    if (kind === 'delay') return <g transform={`scale(${s})`} className="ce-ability-glyph"><circle r="16" /><path d="M0 -10 V0 L8 5 M-6 -20 H6" /></g>;
    if (kind === 'control') return <g transform={`scale(${s})`} className="ce-ability-glyph"><path d="M-17 -7 H16 L8 -15 M16 -7 L8 1 M17 9 H-16 L-8 1 M-16 9 L-8 17" /></g>;
    if (kind === 'search') return <g transform={`scale(${s})`} className="ce-ability-glyph"><circle cx="-4" cy="-4" r="11" /><path d="M4 4 L17 17 M-17 -17 V8" /></g>;
    if (kind === 'play') return <g transform={`scale(${s})`} className="ce-ability-glyph"><rect x="-12" y="-17" width="24" height="34" rx="3" /><path d="M-6 4 L0 -3 L6 4 M0 -3 V11" /></g>;
    return <g transform={`scale(${s})`} className="ce-ability-glyph">
        {kind === 'damage' || kind === 'attack' ? <path d="M-4 -17 L12 -5 L4 -2 L8 14 L-12 1 L-3 -3 Z" />
            : kind === 'defeat' ? <><path d="M-11 -14 L11 14 M11 -14 L-11 14" /><path d="M-16 -7 V-17 H-6 M6 17 H16 V7" /></>
                : kind === 'heal' ? <path d="M-13 0 H13 M0 -13 V13" />
                    : kind === 'shield' ? <path d="M0 -17 L14 -10 V3 Q13 12 0 19 Q-13 12 -14 3 V-10 Z M-7 1 L-1 7 L8 -5" />
                        : kind === 'buff' ? <path d="M-13 7 L0 -5 L13 7 M-13 -4 L0 -16 L13 -4" />
                            : kind === 'debuff' ? <path d="M-13 -7 L0 5 L13 -7 M-13 4 L0 16 L13 4" />
                                : kind === 'suppress' ? <><circle cx="0" cy="0" r="14" /><path d="M-16 16 L16 -16 M-6 0 L0 -8 L6 0 L0 8 Z" /></>
                                    : kind === 'ready' ? <><path d="M-10 13 V-13 H10 V13 Z M-17 2 L-17 -6 L-23 0 M-17 -6 L-11 0" /></>
                                        : kind === 'exhaust' ? <><path d="M-14 -9 H14 V9 H-14 Z M-3 16 H6 L0 22 M6 16 L0 10" /></>
                                            : kind === 'resource' || kind === 'pay' || kind === 'cost' ? <><path d="M0 -18 L13 0 L0 18 L-13 0 Z M0 -9 V9" />{kind !== 'resource' && <path d="M-8 0 H8" />}</>
                                                : kind === 'inspect' ? <><path d="M-19 0 Q0 -21 19 0 Q0 21 -19 0" /><circle r="6" /></>
                                                    : <><rect x="-10" y="-14" width="20" height="28" rx="2" /><path d={kind === 'discard' || kind === 'mill' ? 'M-5 -5 L5 5 M5 -5 L-5 5' : kind === 'return' || kind === 'recover' ? 'M6 0 H-6 L-1 -5 M-6 0 L-1 5' : 'M-5 0 H5 M0 -5 V5'} /></>}
    </g>;
}

export function CardGhost({ card, box, opacity = 1, back = false }: { card?: CardRef | null; box: Pick<EffectBox, 'w' | 'h'>; opacity?: number; back?: boolean }) {
    const image = !back && card ? cardImageUrl(card.s) : null;
    return <g opacity={opacity} className="ce-card-ghost">
        <rect x={-box.w / 2} y={-box.h / 2} width={box.w} height={box.h} rx="5" fill="#101827" />
        {image ? <image href={image} x={-box.w / 2} y={-box.h / 2} width={box.w} height={box.h} preserveAspectRatio="none" opacity=".9" /> : <>
            <rect x={-box.w * .4} y={-box.h * .41} width={box.w * .8} height={box.h * .82} rx="3" className="ce-card-back-inner" />
            <path d={`M0 ${-box.h * .28} L${box.w * .28} 0 L0 ${box.h * .28} L${-box.w * .28} 0 Z`} />
            <circle r={Math.min(box.w, box.h) * .1} />
        </>}
        <rect x={-box.w / 2} y={-box.h / 2} width={box.w} height={box.h} rx="5" fill="none" className="ce-card-outline" />
    </g>;
}

/** Playing a card as an upgrade is a hand-card arrival becoming an attachment,
 * with no unit-entry pose, readiness claim, or transferred-upgrade semantics. */
export function UpgradePlay({ from, to, card, p, start = .22, end = .7, color = '#d5c39b' }: { from: EffectBox; to: EffectBox; card: CardRef; p: number; start?: number; end?: number; color?: string }) {
    const clipId = `upgrade-play-${useId().replace(/:/g, '')}`;
    if (p < start) return null;
    const t = easeInOut(phase(p, start, end)), middle = screenShift({ ...from, ...mix(from, to, .5) }, 20, -35);
    const at = { ...from, x: (1 - t) ** 2 * from.x + 2 * (1 - t) * t * middle.x + t * t * to.x,
        y: (1 - t) ** 2 * from.y + 2 * (1 - t) * t * middle.y + t * t * to.y };
    const source = from.cardSize ?? { w: 46, h: 64.4 }, w = to.w * (to.sx ?? 1), h = to.h * (to.sy ?? 1), attached = phase(p, end - .05, end);
    return <><path d={`M${from.x} ${from.y} Q${middle.x} ${middle.y} ${to.x} ${to.y}`} stroke={color} opacity={envelope(p, start, start + .04, end + .04)} />
        <ScreenPixels at={at} opacity={1 - attached}><CardGhost card={card} box={{ w: source.w * (1 - .6 * t), h: source.h * (1 - .6 * t) }} /></ScreenPixels>
        <ScreenPixels at={to} opacity={attached} color={color}><defs><clipPath id={clipId}><rect x={-w / 2 + 2} y={-h / 2} width={Math.max(0, w - 4)} height={h} /></clipPath></defs><rect x={-w / 2} y={-h / 2} width={w} height={h} rx="3" fill="#25251a" strokeWidth="1" /><text clipPath={`url(#${clipId})`} textAnchor="middle" y="2" fill="currentColor" stroke="none" style={{ font: '700 7px sans-serif' }}>{card.n}</text></ScreenPixels></>;
}

export function EnergyBeam({ from, to, p, start = .2, end = .47, color = '#ffa45e', width = 5 }: { from: Point; to: Point; p: number; start?: number; end?: number; color?: string; width?: number }) {
    const t = phase(p, start, end);
    const point = mix(from, to, easeOut(t));
    const tail = mix(from, to, easeOut(clamp(t - .2)));
    const opacity = t > 0 && t < 1 ? Math.min(1, t * 10, (1 - t) * 6) : 0;
    return <g opacity={opacity} style={{ color }}>
        <path d={`M${tail.x} ${tail.y} L${point.x} ${point.y}`} className="ce-beam-haze" strokeWidth={width * 4} />
        <path d={`M${tail.x} ${tail.y} L${point.x} ${point.y}`} className="ce-beam-core" strokeWidth={width} />
        <circle cx={point.x} cy={point.y} r={width * 2} fill="#fff8db" stroke="none" />
    </g>;
}

export function Shockwave({ at, p, start = .4, radius = 190, color = '#ff9856', squash = 1 }: { at: Point; p: number; start?: number; radius?: number; color?: string; squash?: number }) {
    const t = phase(p, start, start + .37);
    if (!t || t === 1) return null;
    return <g transform={`translate(${at.x} ${at.y}) scale(1 ${squash})`} style={{ color }} opacity={(1 - t) ** 1.4}>
        <circle r={10 + easeOut(t) * radius} strokeWidth={6 * (1 - t) + .5} className="ce-shock-ring" />
        <circle r={easeOut(t) * radius * .68} strokeWidth="1" strokeDasharray="3 14" />
    </g>;
}

export function Debris({ at, p, start = .4, radius = 150, count = 20, color = '#ff9856', inward = false }: { at: Point; p: number; start?: number; radius?: number; count?: number; color?: string; inward?: boolean }) {
    return <g transform={`translate(${at.x} ${at.y})`} style={{ color }}>
        {sequence(count).map(i => {
            const t = phase(p, start + i % 5 * .008, start + .43 + i % 3 * .025);
            if (!t || t === 1) return null;
            const theta = i * 2.399963;
            const r = radius * (.5 + i % 7 / 10) * (inward ? 1 - easeOut(t) : easeOut(t));
            const point = { x: Math.cos(theta) * r, y: Math.sin(theta) * r + (inward ? 0 : t * t * 40) };
            const opacity = Math.sin(t * Math.PI) ** .55;
            return i % 3 === 0
                ? <path key={i} d={`M${point.x} ${point.y} l${Math.cos(theta) * (15 - t * 10)} ${Math.sin(theta) * (15 - t * 10)}`} opacity={opacity} strokeWidth={i % 4 ? 2 : 3.5} className={i % 2 ? '' : 'ce-white-core'} />
                : <rect key={i} x={point.x} y={point.y} width={i % 2 ? 3 : 5} height={i % 2 ? 3 : 5} transform={`rotate(${i * 41 + t * 190} ${point.x} ${point.y})`} opacity={opacity} fill="currentColor" stroke="none" />;
        })}
    </g>;
}

export function FracturedCard({ box, card, to, p }: { box: EffectBox; card?: CardRef | null; to: Point; p: number }) {
    const id = `split-${useId().replace(/:/g, '')}`;
    const split = easeOut(phase(p, .43, .76));
    const opacity = envelope(p, .24, .41, .85);
    const depart = easeOut(phase(p, .55, .88));
    const drift = { x: (to.x - box.x) * depart, y: (to.y - box.y) * depart };
    const crack = `M${-box.w * .1} ${-box.h / 2} L${box.w * .15} ${-box.h * .15} L${-box.w * .1} ${box.h * .12} L${box.w * .1} ${box.h / 2}`;
    return <g transform={`translate(${box.x} ${box.y})`}>
        <defs>
            <clipPath id={`${id}-left`}><path d={`${crack} H${-box.w} V${-box.h} H${-box.w * .1} Z`} /></clipPath>
            <clipPath id={`${id}-right`}><path d={`${crack} H${box.w} V${-box.h} H${-box.w * .1} Z`} /></clipPath>
        </defs>
        <g opacity={opacity} transform={`translate(${-split * 32 + drift.x} ${-split * 13 + drift.y}) ${screenRotate(-split * 15, box)} scale(${1 - depart * .75})`}><g clipPath={`url(#${id}-left)`}><CardGhost card={card} box={box} /></g></g>
        <g opacity={opacity} transform={`translate(${split * 32 + drift.x} ${split * 13 + drift.y}) ${screenRotate(split * 15, box)} scale(${1 - depart * .75})`}><g clipPath={`url(#${id}-right)`}><CardGhost card={card} box={box} /></g></g>
        <path d={crack} opacity={envelope(p, .35, .46, .7)} className="ce-white-core" strokeWidth="5" />
    </g>;
}

export function ZoneTravel({ placed, p, card }: { placed: PlacedOutcome; p: number; card?: CardRef | null }) {
    const { outcome, from, to } = placed;
    const count = Math.max(1, Math.min(6, typeof outcome.amount === 'number' ? outcome.amount : 1));
    const color = colorOf(outcome.kind);
    const companionDraw = outcome.kind === 'draw' && placed.routeLabels === false;
    const cardBox = screenCardSize(from);
    // The attached-unit compound uses the outside margin, keeping its draw away from both arena rows.
    const marginX = 12 / (from.sx ?? 1);
    const restock = outcome.kind === 'recover' && outcome.zone === 'deck';
    const curve = restock
        ? { x: Math.max(70, Math.min(930, (from.x + to.x) / 2 + (placed.slot - 1.5) * 170)), y: Math.max(95, Math.min(from.y, to.y) - 280) }
        : { x: (from.x + to.x) / 2, y: Math.max(65, Math.min(from.y, to.y) - 75) };
    const departure = ['return', 'resource', 'discard'].includes(outcome.kind);
    const initial = outcome.kind === 'draw' || outcome.kind === 'mill' ? 'DECK' : outcome.kind === 'recover' ? 'DISCARD' : outcome.kind === 'discard' ? outcome.fromZone === 'capture' ? 'CAPTIVE' : outcome.fromZone?.toUpperCase() ?? 'HAND' : outcome.kind === 'resource' ? outcome.fromZone?.toUpperCase() : 'ARENA';
    const destination = outcome.kind === 'resource' ? 'RESOURCE ROW' : outcome.kind === 'recover' && outcome.zone === 'deck' || outcome.kind === 'return' && outcome.destination === 'deck-bottom' ? 'DECK BOTTOM' : outcome.kind === 'discard' || outcome.kind === 'mill' ? 'DISCARD' : 'HAND';
    return <g style={{ color }}>
        {departure && from.exact && <g opacity={phase(p, .24, .42)}><rect x={from.x - from.w / 2 - 3} y={from.y - from.h / 2 - 3} width={from.w + 6} height={from.h + 6} rx="6" fill="#09121f" stroke="none" /><rect x={from.x - from.w / 2} y={from.y - from.h / 2} width={from.w} height={from.h} rx="5" opacity=".3" strokeDasharray="5 8" /></g>}
        <path d={companionDraw ? `M${from.x} ${from.y} H${marginX} V${to.y} H${to.x}` : `M${from.x} ${from.y} Q${curve.x} ${curve.y} ${to.x} ${to.y}`} strokeDasharray="4 9" opacity={envelope(p, .12, .33, .93) * .65} strokeWidth="2" />
        {sequence(count).map(i => {
            const stagger = (i + placed.slot) * .025;
            const t = restock ? easeInOut(phase(p, .12 + stagger, .78 + stagger)) : easeOut(phase(p, .2 + stagger, .69 + stagger));
            const leg = companionDraw ? phase(p, .2 + stagger, .69 + stagger) : t;
            const x = companionDraw ? leg < .24 ? from.x + (marginX - from.x) * easeInOut(leg / .24) : leg < .84 ? marginX : marginX + (to.x - marginX) * easeInOut((leg - .84) / .16)
                : (1 - t) ** 2 * from.x + 2 * (1 - t) * t * curve.x + t * t * to.x;
            const y = companionDraw ? leg < .24 ? from.y : leg < .84 ? from.y + (to.y - from.y) * easeInOut((leg - .24) / .6) : to.y
                : (1 - t) ** 2 * from.y + 2 * (1 - t) * t * curve.y + t * t * to.y;
            const opacity = phase(p, .16 + stagger, .27 + stagger);
            const rotation = companionDraw ? 0 : outcome.kind === 'resource' ? outcome.entersReady === false ? 90 * t : 0 : (1 - t) * (i % 2 ? -22 : 22);
            const travelScale = companionDraw ? .16 + .72 * phase(leg, .94, 1) : .88 + Math.sin(t * Math.PI) * .32;
            return <g key={i} transform={`translate(${x + (i + placed.slot - (count - 1) / 2) * 8} ${y - placed.slot * 3}) ${screenRotate(rotation, from)} scale(${travelScale})`} opacity={opacity}>
                <CardGhost box={cardBox} card={card} back={!card || ['draw', 'mill', 'discard'].includes(outcome.kind) || outcome.kind === 'resource' && outcome.visibility !== 'public'} />
                {outcome.kind === 'discard' || outcome.kind === 'mill' ? <g opacity={phase(p, .65, .78)}><AbilityGlyph kind="discard" size={17} /></g> : null}
            </g>;
        })}
        {placed.slot === 0 && placed.routeLabels !== false && <g opacity={phase(p, .08, .23)} className="ce-zone-route-label">
            {initial && <g transform={`translate(${from.x} ${Math.max(18, from.y - Math.min(from.h / 2 + 16, 55))})`}><rect x="-35" y="-10" width="70" height="20" rx="3" fill="#070d18" /><text textAnchor="middle" y="4">{initial}</text></g>}
            <g transform={`translate(${to.x} ${to.y > 490 ? to.y - 54 : to.y + 53})`}><rect x="-48" y="-10" width="96" height="20" rx="3" fill="#070d18" /><text textAnchor="middle" y="4">{destination}</text></g>
        </g>}
        <Shockwave at={to} p={p} start={.62} radius={78} color={color} squash={.5} />
    </g>;
}

/** The same action always gets the same geometry, colour and legible outcome marker. */
export function OutcomeVisual({ placed, p }: { placed: PlacedOutcome; p: number }) {
    const { outcome, box } = placed;
    const color = colorOf(outcome.kind);
    const w = Math.max(54, box.w + 14);
    const h = Math.max(76, box.h + 16);
    const resolve = easeOut(phase(p, .44, .66));
    const hit = envelope(p, .36, .47, .68);
    const hold = phase(p, .5, .67);
    const unit = <rect x={-w / 2} y={-h / 2} width={w} height={h} rx="7" fill="none" className="ce-outcome-frame" />;
    if (outcome.prevented) {
        const at = ['capture', 'play', 'attach', 'rescue', 'return', 'discard', 'draw', 'mill', 'recover', 'resource'].includes(outcome.kind) ? placed.from : box;
        return <ScreenPixels at={at} color={color} opacity={hold}><circle r="22" strokeWidth="2" /><path d="M-14 14 L14 -14" strokeWidth="3" /></ScreenPixels>;
    }
    if (outcome.kind === 'create') {
        const unit = outcome.unit;
        const droid = unit?.t === 1 && unit.n === 'Battle Droid' && unit.s === null && outcome.tokenType === 'battle-droid' && outcome.entryType === 'created' && outcome.entersReady === false && unit.x === 1;
        const clone = unit?.t === 1 && unit.n === 'Clone Trooper' && unit.s === null && outcome.tokenType === 'clone-trooper' && outcome.entryType === 'created' && outcome.entersReady === false && unit.x === 1 && unit.p === 2 && unit.h === 2 && unit.d === 0 && !unit.u?.length && !unit.cap?.length && !unit.status?.length;
        return droid || clone
            ? <TokenAssembly at={placed.to} unit={unit} p={p} color={color} />
            : <ScreenPixels at={placed.to} color={color} opacity={hold}><AbilityGlyph kind="create" size={24} /></ScreenPixels>;
    }
    if (outcome.kind === 'resource' && (!outcome.card || !outcome.fromZone)) return <ScreenPixels at={placed.to} color={color} opacity={hold}><AbilityGlyph kind="resource" size={24} /></ScreenPixels>;
    if (outcome.kind === 'play' && outcome.playAs === 'upgrade' && outcome.card) {
        if (!placed.to.exact) return <ScreenPixels at={placed.to} color={color} opacity={hold}><AbilityGlyph kind="play" size={24} /></ScreenPixels>;
        return <>{placed.from.exact && <AttachmentMask at={placed.from} p={p} start={.16} />}<UpgradePlay from={placed.from} to={placed.to} card={outcome.card} p={p} color={color} /></>;
    }
    if (outcome.kind === 'attach' && outcome.unit) {
        if (!placed.to.exact) return <ScreenPixels at={placed.to} color={color} opacity={hold}><AbilityGlyph kind="attach" size={24} /></ScreenPixels>;
        const t = easeInOut(phase(p, .22, .7)), at = { ...placed.from, ...mix(placed.from, placed.to, t) }, body = outcome.unit;
        const final = placed.to.cardSize ?? { w: 72, h: 100.8 }, growth = easeInOut(phase(p, .5, .7));
        const face = { w: 23 + (final.w - 23) * growth, h: 32.2 + (final.h - 32.2) * growth };
        return <>{placed.from.exact && <AttachmentMask at={placed.from} p={p} start={.22} />}<ScreenPixels at={at} color={color} opacity={phase(p, .2, .3)}>
            <g transform={`rotate(${body.x === 1 ? 10 * t : 0})`}><CardGhost card={body} box={face} />
                <g opacity={phase(p, .6, .7)}>{[body.p, Math.max(0, body.h - body.d)].map((value, i) => <g key={i} transform={`translate(${(i ? 1 : -1) * (face.w / 2 - 10)} ${face.h / 2 - 12})`}><rect x="-10" y="-11" width="20" height="22" rx="3" fill={i ? '#174772' : '#8b2936'} /><text y="4" textAnchor="middle" fill="#fff" stroke="none" style={{ font: '800 13px sans-serif' }}>{value}</text></g>)}</g>
            </g></ScreenPixels></>;
    }
    if (outcome.kind === 'attach' || outcome.kind === 'capture' || outcome.kind === 'defeat' && outcome.zone === 'leader') {
        const t = easeInOut(phase(p, .22, .7)), at = { ...placed.from, ...mix(placed.from, placed.to, t) };
        const chip = outcome.kind === 'attach', a = chip ? { w: placed.from.w * (at.sx ?? 1), h: placed.from.h * (at.sy ?? 1) } : placed.from.cardSize ?? { w: 46, h: 64.4 };
        const b = placed.to.cardSize ?? { w: placed.to.w * (at.sx ?? 1), h: placed.to.h * (at.sy ?? 1) };
        const exhausted = outcome.kind === 'defeat' && outcome.leader?.x === 1;
        return <>{placed.from.exact && <AttachmentMask at={placed.from} p={p} start={.22} />}<ScreenPixels at={at} color={color} opacity={phase(p, .2, .3)}><g transform={`rotate(${exhausted ? 10 * t : -6 * Math.sin(t * Math.PI)}) scale(${exhausted ? 1 - .06 * t : 1})`} opacity={exhausted ? 1 - .28 * t : 1}>
            {chip ? <><rect x={-(a.w + (b.w - a.w) * t) / 2} y={-(a.h + (b.h - a.h) * t) / 2} width={a.w + (b.w - a.w) * t} height={a.h + (b.h - a.h) * t} rx="3" fill="#f6c454" /><text textAnchor="middle" y="3" fill="#2a1d00" stroke="none" style={{ font: '600 8px sans-serif' }}>{outcome.card?.n}</text></> : <CardGhost card={outcome.card} back={outcome.kind === 'capture' && t >= .5} box={{ w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t }} />}
        </g></ScreenPixels></>;
    }
    if (outcome.kind === 'rescue') {
        const t = easeInOut(phase(p, .2, .7)), at = { ...placed.from, ...mix(placed.from, placed.to, t) };
        const final = placed.to.cardSize ?? { w: 72, h: 100.8 }, ready = outcome.unit?.x !== 1;
        return <>{placed.from.exact && <AttachmentMask at={placed.from} p={p} start={.2} />}<ScreenPixels at={at} opacity={phase(p, .18, .28)} color={color}>
            <g transform={`rotate(${ready ? 0 : 10 * t}) scale(${ready ? 1 : 1 - .06 * t})`} opacity={ready ? 1 : 1 - .28 * t}><CardGhost card={outcome.card} box={{ w: 23 + (final.w - 23) * t, h: 32.2 + (final.h - 32.2) * t }} /></g>
        </ScreenPixels></>;
    }
    if (outcome.kind === 'defeat' && outcome.prevented) return <ScreenPixels at={box} color={color} opacity={hold}><circle r="25" strokeWidth="3" /><path d="M-16 16 L16 -16" strokeWidth="3" /></ScreenPixels>;
    if (outcome.kind === 'return' && outcome.label?.startsWith('TOKEN CEASES')) return <ScreenPixels at={placed.from} color={color} opacity={envelope(p, .24, .4, .72)}><circle r={18 * (1 - resolve)} strokeWidth="3" /><AbilityGlyph kind="return" size={18 * (1 - resolve)} /></ScreenPixels>;
    const zones: AbilityKind[] = ['draw', 'discard', 'mill', 'return', 'recover', 'resource'];
    if (zones.includes(outcome.kind)) return <ZoneTravel placed={placed} p={p} card={outcome.kind === 'resource' || outcome.kind === 'return' || outcome.kind === 'recover' ? outcome.card : undefined} />;
    return <g style={{ color }}>
        {outcome.kind === 'damage' && <>
            <g transform={`translate(${box.x} ${box.y})`} opacity={Math.max(hit, hold * .5)}>{unit}<rect x={-w / 2} y={-h / 2} width={w} height={h} rx="7" fill="currentColor" stroke="none" opacity={hit * .24} /><path d={`M${-w / 2} ${h / 2 - 10} L${-w * .1} ${h / 2 - 18} L${w * .08} ${h / 2 - 7} L${w / 2} ${h / 2 - 19}`} strokeWidth="5" /></g>
            <Shockwave at={box} p={p} radius={Math.max(w, h) * .95} color={color} /><Debris at={box} p={p} radius={Math.max(w, h)} count={18} color={color} />
        </>}
        {outcome.kind === 'defeat' && <>
            <FracturedCard box={box} card={outcome.card} to={placed.to} p={p} />
            <g transform={`translate(${box.x} ${box.y})`} opacity={hold}><rect x={-w / 2} y={-h / 2} width={w} height={h} rx="6" fill="#080b13" fillOpacity=".94" strokeDasharray="5 8" />
                <g transform={`scale(${Math.min(2.2, w / 32)})`}><AbilityGlyph kind="defeat" /></g>
            </g><Debris at={box} p={p} count={15} radius={Math.max(w, h)} color={color} />
        </>}
        {outcome.kind === 'heal' && <g transform={`translate(${box.x} ${box.y})`}>
            <g opacity={Math.max(hit * .7, hold * .45)}>{unit}{sequence(5).map(i => <path key={i} d={`M${-w / 2} ${-h / 2 + (i + 1) * h / 6} H${w / 2}`} opacity=".5" strokeDasharray="8 6" />)}</g>
            {sequence(7).map(i => { const t = phase(p, .18 + i * .035, .76 + i * .027); return <g key={i} transform={`translate(${Math.sin(i * 2.4) * w * .52} ${h / 2 - t * h * 1.3}) scale(${.55 + i % 3 * .18})`} opacity={Math.sin(t * Math.PI)}><AbilityGlyph kind="heal" /></g>; })}
            <g transform={`translate(0 ${-h * .1}) scale(${resolve * 1.4})`} opacity={hit}><AbilityGlyph kind="heal" size={27} /></g>
        </g>}
        {outcome.kind === 'shield' && <g transform={`translate(${box.x} ${box.y}) scale(${.7 + resolve * .3})`} opacity={Math.max(hit, hold * .85)}>
            <path d={`M0 ${-h * .66} L${w * .68} ${-h * .4} V${h * .14} Q${w * .63} ${h * .53} 0 ${h * .7} Q${-w * .63} ${h * .53} ${-w * .68} ${h * .14} V${-h * .4} Z`} fill="currentColor" fillOpacity=".13" strokeWidth="4" />
            {sequence(9).map(i => <path key={i} d={hexPoints((i % 3 - 1) * w * .32, (Math.floor(i / 3) - 1) * h * .24, w * .19)} opacity=".45" />)}
        </g>}
        {(outcome.kind === 'buff' || outcome.kind === 'debuff') && <g transform={`translate(${box.x} ${box.y})`}>
            <g opacity={Math.max(hit, hold * .65)}>{unit}</g>
            {[-1, 1].map(side => <g key={side} transform={`translate(${side * (w / 2 + 16)} ${outcome.kind === 'buff' ? 12 - resolve * 30 : -12 + resolve * 30})`} opacity={Math.max(hit, hold * .8)}><AbilityGlyph kind={outcome.kind} size={20} /></g>)}
            {outcome.kind === 'debuff' && sequence(3).map(i => <ellipse key={i} cx="0" cy={(i - 1) * h * .25} rx={w * (.85 - resolve * .25)} ry={h * .1} opacity={hit * .8} strokeWidth="3" />)}
        </g>}
        {(outcome.kind === 'ready' || outcome.kind === 'exhaust') && outcome.amount === 0 && <g transform={`translate(${box.x} ${box.y})`} opacity={hold * .6}>{unit}</g>}
        {(outcome.kind === 'ready' || outcome.kind === 'exhaust') && outcome.amount !== 0 && <g transform={`translate(${box.x} ${box.y})`}>
            <rect x={-box.w / 2 - 4} y={-box.h / 2 - 4} width={box.w + 8} height={box.h + 8} fill="#09121f" stroke="none" opacity={phase(p, .12, .29)} />
            <g opacity={phase(p, .13, .3)} transform={screenRotate(outcome.kind === 'ready' ? -65 * (1 - resolve) : 90 * resolve, box)}><CardGhost card={outcome.card} box={{ w: box.w, h: box.h }} /></g>
            <path d={`M${-w * .75} ${h * .1} A${w * .7} ${h * .7} 0 0 1 ${w * .6} ${-h * .53} l-4 -22 M${w * .6} ${-h * .53} l-25 2`} strokeWidth="4" opacity={Math.max(hit, hold * .6)} />
            <g transform={`translate(0 ${-h / 2 - 22})`} opacity={hold}><AbilityGlyph kind={outcome.kind} size={22} /></g>
        </g>}
        {outcome.kind === 'suppress' && <g transform={`translate(${box.x} ${box.y})`}>
            <g opacity={Math.max(hit, hold * .65)}>{unit}</g>
            {[-1, 0, 1].map(i => <g key={i} transform={`translate(${i * w * .32} ${h * .2})`} opacity={resolve}><circle r={w * .11} fill="#181024" /><path d={`M${-w * .16} ${w * .16} L${w * .16} ${-w * .16}`} strokeWidth="3" /><path d={`M0 ${-w * .07} L${w * .07} 0 L0 ${w * .07} L${-w * .07} 0 Z`} strokeWidth="1" /></g>)}
            <g transform={`translate(0 ${-h * .2}) scale(${1.4 * resolve})`} opacity={Math.max(hit, hold * .8)}><AbilityGlyph kind="suppress" size={24} /></g>
        </g>}
        {outcome.kind === 'inspect' && <g transform={`translate(${box.x} ${box.y})`} opacity={envelope(p, .1, .35, .94)}>
            <path d={`M${-w * .75} ${-h * .6} V${h * .6} M${w * .75} ${-h * .6} V${h * .6}`} strokeWidth="4" />
            <path d={`M${-w * .9} ${-h / 2 + phase(p, .14, .62) * h} H${w * .9}`} className="ce-white-core" strokeWidth="4" />
            <g opacity={hold}><AbilityGlyph kind="inspect" size={30} /></g>
        </g>}
        {['pay', 'cost', 'attack'].includes(outcome.kind) && <g transform={`translate(${box.x} ${box.y}) scale(${.8 + resolve * .5})`} opacity={Math.max(hit, hold * .75)}><AbilityGlyph kind={outcome.kind} size={29} /></g>}
    </g>;
}

export function hexPoints(x: number, y: number, r: number): string {
    return sequence(6).map(i => `${i ? 'L' : 'M'}${x + Math.cos(i * Math.PI / 3) * r} ${y + Math.sin(i * Math.PI / 3) * r}`).join(' ') + ' Z';
}
