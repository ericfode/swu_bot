import { useState, type CSSProperties } from 'react';
import { Castle, ChevronsUp, Crosshair, Crown, Flag, Gem, Hand, Shuffle, Sparkles, Swords, Undo2, UserPlus, Wand, Zap, type LucideIcon } from 'lucide-react';
import { classInfo, type ActionClass, type Outcome } from '../data/actions';
import type { CardRef, Seat } from '../data/types';
import { cardImageUrl, tileLook } from '../lib/cards';
import { useSettings } from '../lib/settings';

export const ACTION_GLYPHS: Record<ActionClass, LucideIcon> = {
    'play-unit': UserPlus,
    'play-upgrade': ChevronsUp,
    'play-event': Zap,
    attack: Swords,
    'attack-base': Castle,
    deploy: Crown,
    ability: Sparkles,
    trigger: Wand,
    resource: Gem,
    pass: Hand,
    initiative: Flag,
    choose: Crosshair,
    setup: Shuffle,
    cancel: Undo2
};

export type IconTier = 'glyph' | 'chip' | 'card' | 'caption';

/** Which drawing a size gets: only what is legible at that size. */
export function tierFor(size: number): IconTier {
    return size < 22 ? 'glyph' : size < 48 ? 'chip' : size < 96 ? 'card' : 'caption';
}

export interface ActionIconProps {
    cls: ActionClass;
    seat: Seat;
    /** the card acted with; without one the icon is the action alone */
    card?: CardRef | null;
    outcome?: Outcome | null;
    /** width in px; the drawing changes with it (see tierFor) unless `tier` is given */
    size?: number;
    tier?: IconTier;
    /** caption tier: the sentence under the card */
    caption?: string;
    title?: string;
}

const SEAT = { p1: 'var(--color-p1)', p2: 'var(--color-p2)' };

function Face({ card, back = false }: { card: CardRef; back?: boolean }) {
    const art = useSettings((s) => s.art);
    useSettings((s) => s.artVersion);
    const [failed, setFailed] = useState<string | null>(null);
    const url = art ? cardImageUrl(card.s, back) : null;
    const look = tileLook(card.n);
    if (url && failed !== url) {
        return <img src={url} alt="" draggable={false} onError={() => setFailed(url)} className="absolute inset-0 size-full object-cover object-[50%_18%]" />;
    }
    return (
        <span className="absolute inset-0 grid place-items-center" style={{ background: `radial-gradient(circle at 30% 20%, #ffffff22, transparent 55%), linear-gradient(${look.angle}deg, ${look.a}, ${look.b})` } as CSSProperties}>
            <span className="font-display font-extrabold text-white/80" style={{ fontSize: '0.9em' }}>{look.mono}</span>
        </span>
    );
}

function outcomeText(o: Outcome | null | undefined): string[] {
    if (!o) {
        return [];
    }
    const out: string[] = [];
    if (o.baseDamage) {
        out.push(`−${o.baseDamage} base`);
    }
    if (o.defeated) {
        out.push(`✕${o.defeated}`);
    }
    return out;
}

/**
 * An action drawn with its card, at any size. Small sizes keep only what stays legible:
 *   glyph (<22px): the action pictogram in the player's colour
 *   chip (22–47px): the card's art or tile, cropped square, with the pictogram on top
 *   card (48–95px): the card with an action badge and the outcome (base damage, units defeated)
 *   caption (96px+): the card plus a sentence saying what happened
 */
export function ActionIcon({ cls, seat, card, outcome, size = 32, tier, caption, title }: ActionIconProps) {
    const t = tier ?? tierFor(size);
    const G = ACTION_GLYPHS[cls];
    const col = SEAT[seat];
    const label = title ?? caption ?? `${classInfo(cls).label}${card ? `: ${card.n}` : ''}`;
    if (t === 'glyph' || (!card && t !== 'caption')) {
        const s = t === 'glyph' ? size : Math.min(size, 40);
        return (
            <span role="img" aria-label={label} title={label} className="inline-grid place-items-center rounded-full shrink-0"
                style={{ width: s, height: s, background: `color-mix(in srgb, ${col} 22%, var(--color-ink))`, boxShadow: `inset 0 0 0 1.5px ${col}` }}>
                <G size={Math.round(s * 0.6)} color={col} strokeWidth={2.4} />
            </span>
        );
    }
    if (t === 'chip') {
        return (
            <span role="img" aria-label={label} title={label} className="relative inline-block shrink-0 overflow-hidden rounded-[28%]"
                style={{ width: size, height: size, fontSize: size * 0.42, boxShadow: `0 0 0 2px ${col}, 0 4px 10px -4px #000` }}>
                {card && <Face card={card} back={cls === 'deploy'} />}
                <span className="absolute inset-0" style={{ background: 'linear-gradient(180deg, #0000 25%, #000a)' }} />
                <span className="absolute right-0 bottom-0 grid place-items-center rounded-tl-[40%]" style={{ width: size * 0.56, height: size * 0.56, background: col }}>
                    <G size={Math.round(size * 0.38)} color="#0b1220" strokeWidth={2.6} />
                </span>
            </span>
        );
    }
    const w = t === 'caption' ? Math.max(96, size) : size;
    const badge = Math.max(18, Math.round(w * 0.3));
    const out = outcomeText(outcome);
    const cardBox = (
        <span className="relative block overflow-hidden" style={{ width: w, height: w * 1.4, borderRadius: w * 0.09, fontSize: w * 0.34, boxShadow: `0 0 0 2px ${col}, 0 8px 20px -8px #000` }}>
            {card ? <Face card={card} back={cls === 'deploy'} /> : (
                <span className="absolute inset-0 grid place-items-center" style={{ background: `radial-gradient(circle at 50% 40%, color-mix(in srgb, ${col} 30%, var(--color-ink)), var(--color-ink) 75%)` }}>
                    <G size={Math.round(w * 0.5)} color={col} strokeWidth={1.8} />
                </span>
            )}
            <span className="absolute inset-0" style={{ background: 'linear-gradient(180deg, #0000 45%, #000c)' }} />
            {card && w >= 64 && <span className="absolute left-1.5 right-1.5 bottom-1 text-white font-semibold leading-tight line-clamp-2" style={{ fontSize: Math.max(9, w * 0.105) }}>{card.n}</span>}
            {out.length > 0 && (
                <span className="absolute left-1 top-1 flex flex-col gap-0.5 items-start">
                    {out.map((o) => <span key={o} className="rounded px-1 font-display font-bold text-[#2a1d00] bg-gold leading-tight" style={{ fontSize: Math.max(9, w * 0.11) }}>{o}</span>)}
                </span>
            )}
            {card && <span className="absolute grid place-items-center rounded-full" style={{ right: w * 0.05, top: w * 0.05, width: badge, height: badge, background: col, boxShadow: '0 2px 6px #0009' }}>
                <G size={Math.round(badge * 0.62)} color="#0b1220" strokeWidth={2.6} />
            </span>}
        </span>
    );
    if (t === 'card') {
        return <span role="img" aria-label={label} title={label} className="inline-block shrink-0">{cardBox}</span>;
    }
    return (
        <figure role="img" aria-label={label} className="inline-flex flex-col items-center gap-1.5 m-0 shrink-0" style={{ width: w + 24 }}>
            {cardBox}
            <figcaption className="text-center text-[12px] leading-snug text-dim">{caption ?? label}</figcaption>
        </figure>
    );
}
