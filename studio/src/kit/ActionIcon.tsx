import { useState, type CSSProperties } from 'react';
import { Activity, ArrowLeftRight, BrickWall, ChevronsUp, CornerUpLeft, Crosshair, Crown, Database, Flag, Hand, Layers, Skull, Swords, Undo2, UserPlus, Wand, Zap, type LucideIcon } from 'lucide-react';
import { classInfo, type ActionClass, type Outcome } from '../data/actions';
import type { CardRef, Seat } from '../data/types';
import { cardImageUrl, monogram, tileLook } from '../lib/cards';
import { useSettings } from '../lib/settings';

/**
 * One pictogram per class, picked so no two read alike at 14px: Swords is the only X, the base is the only square,
 * resources the only cylinder, and Zap / Activity / Wand and Hand / Crosshair / UserPlus keep different outlines.
 */
export const ACTION_GLYPHS: Record<ActionClass, LucideIcon> = {
    'play-unit': UserPlus,
    'play-upgrade': ChevronsUp,
    'play-event': Zap,
    attack: Swords,
    'attack-base': BrickWall,
    deploy: Crown,
    ability: Activity,
    trigger: Wand,
    resource: Database,
    pass: Hand,
    initiative: Flag,
    choose: Crosshair,
    setup: Layers,
    cancel: Undo2
};

export type IconTier = 'glyph' | 'chip' | 'card' | 'caption';

/** Which drawing a size gets: only what is legible at that size. */
export function tierFor(size: number): IconTier {
    return size < 32 ? 'glyph' : size < 48 ? 'chip' : size < 96 ? 'card' : 'caption';
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
const INK = '#0b1220';
/** glyphs smaller than this are drawn bare: a ring and disc would leave too few pixels for the pictogram */
const BARE = 24;


/** The card's art, or a generated tile with its monogram at `mono` (top-left) when the art can't be shown. */
function Face({ card, back = false, mono }: { card: CardRef; back?: boolean; mono: CSSProperties }) {
    const art = useSettings((s) => s.art);
    useSettings((s) => s.artVersion);
    const [failed, setFailed] = useState<string | null>(null);
    const url = art ? cardImageUrl(card.s, back) : null;
    if (url && failed !== url) {
        return <img src={url} alt="" draggable={false} onError={() => setFailed(url)} className="absolute inset-0 size-full object-cover object-[50%_18%]" />;
    }
    const look = tileLook(card.n, card.s);
    return (
        <span className="absolute inset-0" style={{ background: `radial-gradient(circle at 0 0, #000a, #0000 62%), ${look.grad ?? `linear-gradient(${look.angle}deg, ${look.a}, ${look.b})`}` }}>
            <span className="absolute font-display font-extrabold text-white leading-none tracking-tight" style={{ textShadow: '0 1px 2px #000c, 0 0 6px #0009', ...mono }}>{monogram(card.n)}</span>
        </span>
    );
}

/** The pictogram on a seat-tinted disc with a ring; used from 24px, and as the cardless pill's disc. */
function Disc({ G, col, s }: { G: LucideIcon; col: string; s: number }) {
    return (
        <span className="inline-grid place-items-center rounded-full shrink-0"
            style={{ width: s, height: s, background: `color-mix(in srgb, ${col} 14%, ${INK})`, boxShadow: `inset 0 0 0 1.5px ${col}` }}>
            <G size={Math.round(s * 0.6)} color={col} strokeWidth={2.5} />
        </span>
    );
}

interface Tag {
    key: string;
    text: string;
    title: string;
    icon?: LucideIcon;
    /** the actor's own loss: drawn muted */
    muted?: boolean;
}

/** Outcome tags, worded so a count never reads as a multiplier: `wide` cards (80px+) add the word after a count, `roomy` ones (64px+) say "own base". */
function outcomeTags(o: Outcome | null | undefined, wide: boolean, roomy: boolean): Tag[] {
    if (!o) {
        return [];
    }
    // stolen, bounced, selfBaseDamage and lost are optional: older Outcome objects don't carry them
    const x = o as Outcome & { stolen?: number; bounced?: number; selfBaseDamage?: number; lost?: number };
    const n = (v: number, word: string) => (wide ? `${v} ${word}` : `${v}`);
    const out: Tag[] = [];
    if (x.baseDamage > 0) {
        out.push({ key: 'base', text: `−${x.baseDamage} base`, title: `${x.baseDamage} damage to the opponent's base` });
    }
    if (x.defeated > 0) {
        out.push({ key: 'defeated', icon: Skull, text: n(x.defeated, 'defeated'), title: `${x.defeated} enemy unit${x.defeated > 1 ? 's' : ''} defeated` });
    }
    if (x.stolen && x.stolen > 0) {
        out.push({ key: 'stolen', icon: ArrowLeftRight, text: n(x.stolen, 'stolen'), title: `${x.stolen} enemy unit${x.stolen > 1 ? 's' : ''} taken control of` });
    }
    if (x.bounced && x.bounced > 0) {
        out.push({ key: 'bounced', icon: CornerUpLeft, text: n(x.bounced, 'bounced'), title: `${x.bounced} enemy unit${x.bounced > 1 ? 's' : ''} returned to hand` });
    }
    if (x.selfBaseDamage && x.selfBaseDamage > 0) {
        out.push({ key: 'self', muted: true, text: roomy ? `−${x.selfBaseDamage} own base` : `−${x.selfBaseDamage} own`, title: `${x.selfBaseDamage} damage to the player's own base` });
    }
    if (x.lost && x.lost > 0) {
        out.push({ key: 'lost', muted: true, icon: Skull, text: n(x.lost, 'lost'), title: `${x.lost} own unit${x.lost > 1 ? 's' : ''} lost` });
    }
    return out;
}

/**
 * An action drawn with its card, at any size. Small sizes keep only what stays legible:
 *   glyph (<32px): the action pictogram in the player's colour, bare below 24px, on a ringed disc from 24px
 *   chip (32–47px): the card's art or tile, monogram top-left, action badge bottom-right
 *   card (48–95px): the card with an action badge, outcome tags above the name (name from 56px)
 *   caption (96px+): the card plus a sentence saying what happened
 * An action without a card is the glyph disc up to the chip tier, and a pill (disc plus label or caption) above it.
 */
export function ActionIcon({ cls, seat, card, outcome, size = 32, tier, caption, title }: ActionIconProps) {
    const t = tier ?? tierFor(size);
    const G = ACTION_GLYPHS[cls];
    const col = SEAT[seat];
    const label = title ?? caption ?? `${classInfo(cls).label}${card ? `: ${card.n}` : ''}`;
    if (t === 'glyph' || (!card && t === 'chip')) {
        if (size < BARE) {
            return (
                <span role="img" aria-label={label} title={label} className="inline-grid place-items-center shrink-0" style={{ width: size, height: size }}>
                    <G size={Math.round(size * 0.85)} color={col} strokeWidth={2.75} />
                </span>
            );
        }
        return <span role="img" aria-label={label} title={label} className="inline-flex shrink-0"><Disc G={G} col={col} s={Math.min(size, 40)} /></span>;
    }
    if (!card) {
        const text = t === 'caption' ? caption ?? label : classInfo(cls).label;
        return (
            <span role="img" aria-label={label} title={label} className="inline-flex items-center gap-2 shrink-0 rounded-full pr-3.5 align-middle"
                style={{ maxWidth: t === 'caption' ? Math.max(size + 24, 200) : undefined, background: `color-mix(in srgb, ${col} 10%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${col} 45%, transparent)` }}>
                <Disc G={G} col={col} s={40} />
                <span className={`text-[12px] leading-snug py-1 ${t === 'caption' ? '' : 'whitespace-nowrap'}`} style={{ color: 'inherit' }}>{text}</span>
            </span>
        );
    }
    if (t === 'chip') {
        const b = Math.round(size * 0.42);
        return (
            <span role="img" aria-label={label} title={label} className="relative inline-block shrink-0 overflow-hidden rounded-[22%]"
                style={{ width: size, height: size, boxShadow: `0 0 0 2px ${col}, 0 4px 10px -4px #000` }}>
                <Face card={card} back={cls === 'deploy'} mono={{ left: size * 0.09, top: size * 0.08, fontSize: size * 0.36 }} />
                <span className="absolute right-0 bottom-0 grid place-items-center rounded-tl-[45%]"
                    style={{ width: b, height: b, background: col, boxShadow: `0 0 0 1.5px ${INK}`, paddingLeft: b * 0.06, paddingTop: b * 0.06 }}>
                    <G size={Math.round(b * 0.74)} color={INK} strokeWidth={2.75} />
                </span>
            </span>
        );
    }
    const w = t === 'caption' ? Math.max(96, size) : size;
    const badge = Math.max(18, Math.round(w * 0.28));
    const pad = Math.max(3, Math.round(w * 0.05));
    const font = Math.max(9, Math.round(w * 0.105));
    const tags = outcomeTags(outcome, w >= 80, w >= 64);
    const cardBox = (
        <span className="relative block overflow-hidden" style={{ width: w, height: Math.round(w * 1.4), borderRadius: w * 0.09, boxShadow: `0 0 0 2px ${col}, 0 8px 20px -8px #000` }}>
            <Face card={card} back={cls === 'deploy'} mono={{ left: pad + 1, top: pad, fontSize: Math.min(w * 0.28, 26) }} />
            <span className="absolute inset-0" style={{ background: 'linear-gradient(180deg, #0000 40%, #000d)' }} />
            <span className="absolute grid place-items-center rounded-full" style={{ right: pad, top: pad, width: badge, height: badge, background: col, boxShadow: '0 2px 6px #0009' }}>
                <G size={Math.round(badge * 0.62)} color={INK} strokeWidth={2.6} />
            </span>
            <span className="absolute flex flex-col items-start" style={{ left: pad, right: pad, bottom: pad, gap: 2 }}>
                {tags.length > 0 && (
                    <span className="flex flex-wrap max-w-full" style={{ gap: 2 }}>
                        {tags.map(({ key, text, title: tip, icon: Icon, muted }) => (
                            <span key={key} title={tip}
                                className={`inline-flex items-center max-w-full overflow-hidden whitespace-nowrap rounded font-display font-bold leading-tight ${muted ? 'text-white/85 bg-black/60' : 'text-[#2a1d00] bg-gold'}`}
                                style={{ fontSize: font, gap: 1, padding: '0 3px', boxShadow: muted ? 'inset 0 0 0 1px #fff4' : undefined }}>
                                {Icon && <Icon size={Math.round(font * 0.95)} strokeWidth={2.5} className="shrink-0" />}
                                {text}
                            </span>
                        ))}
                    </span>
                )}
                {w >= 56 && (
                    <span className={`block w-full text-white font-semibold leading-tight ${t === 'caption' ? 'line-clamp-2' : 'truncate'}`} style={{ fontSize: font }}>{card.n}</span>
                )}
            </span>
        </span>
    );
    if (t === 'card') {
        return <span role="img" aria-label={label} title={label} className="inline-block shrink-0">{cardBox}</span>;
    }
    return (
        <figure role="img" aria-label={label} className="inline-flex flex-col items-center gap-1.5 m-0 shrink-0" style={{ width: w + 24 }}>
            {cardBox}
            {/* inherits the host's text colour, so it reads on light pages too */}
            <figcaption className="text-center text-[12px] leading-snug" style={{ color: 'inherit', opacity: 0.8 }}>{caption ?? label}</figcaption>
        </figure>
    );
}
