import { useState, type CSSProperties, type FocusEvent, type MouseEvent } from 'react';
import { cardImageUrl, tileLook } from '../lib/cards';
import { useSettings } from '../lib/settings';
import type { CardRef, Seat, UnitRef } from '../data/types';

/** Leader fronts and bases are printed landscape ('wide'); everything else, a deployed leader included, is portrait ('tall'). */
export type CardShape = 'tall' | 'wide';

/** What a card is worth under the lens (the omni bot's board score), drawn on the card. */
export interface CardValue {
    /** points for the card's owner; null for cards the score doesn't count on their own (an undeployed leader) */
    v: number | null;
    seat: Seat;
    /** 0..1: how this card compares with the most valuable unit on the table (drives the glow) */
    heat?: number;
    /** the omni bot's search on this board: 0 = the card it picked, negative = how much worse its best move with this card was */
    regret?: number | null;
}

export interface Focus {
    card: CardRef;
    back: boolean;
    shape: CardShape;
    unit?: UnitRef;
    note?: string;
    value?: CardValue | null;
    kind: 'unit' | 'base' | 'leader' | 'hand';
    /** a base's HP left */
    hpLeft?: number;
    /** where the card is on screen, for the floating zoom */
    rect?: { left: number; top: number; right: number; bottom: number };
}

interface Props {
    card: CardRef;
    size?: 'sm' | 'md' | 'lg' | 'xl';
    shape?: CardShape;
    /** leader flipped to its deployed (unit) side */
    back?: boolean;
    unit?: UnitRef;
    exhausted?: boolean;
    note?: string;
    kind?: Focus['kind'];
    hpLeft?: number;
    /** width in px, overriding the size's width */
    width?: number;
    value?: CardValue | null;
    onFocus?: (f: Focus | null) => void;
    onLeave?: () => void;
}

const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));

/** The value chip and the search tag the lens draws on a card. */
export function LensMarks({ value, size }: { value: CardValue; size: 'sm' | 'md' | 'lg' | 'xl' }) {
    const small = size === 'sm';
    return (
        <span className="lens">
            {value.v != null && (
                <span className={`lensv${small ? ' sm' : ''}`} style={{ '--seat': `var(--color-${value.seat})` } as CSSProperties} title="What this card is worth to its owner in the omni bot's board score">
                    {fmt(value.v)}
                </span>
            )}
            {value.regret != null && (
                <span className={`lensr${small ? ' sm' : ''}${value.regret >= -0.05 ? ' pick' : ''}`}
                    title={value.regret >= -0.05 ? 'The move the omni bot played (or one just as good) starts with this card' : `The omni bot's best move with this card scored ${(-value.regret).toFixed(1)} points below the move it played`}>
                    {value.regret >= -0.05 ? (small ? '★' : '★ pick') : `−${Math.abs(value.regret).toFixed(1)}`}
                </span>
            )}
        </span>
    );
}

/** One card: art when there is some, otherwise a generated tile (tokens, unreleased sets, fixtures). */
export function Card({ card, size = 'md', shape = 'tall', back = false, unit, exhausted = false, note, kind = 'unit', hpLeft, width, value, onFocus, onLeave }: Props) {
    const art = useSettings((s) => s.art);
    useSettings((s) => s.artVersion);
    const [failed, setFailed] = useState<string | null>(null);
    // an image whose orientation doesn't match the box (art data can disagree with the card type) is fitted whole, not cropped
    const [mismatch, setMismatch] = useState<string | null>(null);
    const url = art ? cardImageUrl(card.s, back) : null;
    const showImg = url !== null && failed !== url;
    const look = tileLook(card.n);
    const hp = unit ? unit.h - unit.d : null;
    const focusOf = (el: HTMLElement): Focus => {
        const r = el.getBoundingClientRect();
        return { card, back, shape, unit, note, value, kind, hpLeft, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } };
    };
    const focus = onFocus
        ? {
            onMouseEnter: (e: MouseEvent<HTMLDivElement>) => onFocus(focusOf(e.currentTarget)),
            onFocus: (e: FocusEvent<HTMLDivElement>) => onFocus(focusOf(e.currentTarget)),
            onMouseLeave: onLeave,
            onBlur: onLeave,
            tabIndex: 0
        }
        : {};
    const lensed = value && (value.v != null || value.regret != null);
    const heat = value?.heat ?? 0;
    const cls = ['card', size !== 'md' ? size : '', shape === 'wide' ? 'wide' : '', exhausted ? 'exh' : '', lensed ? 'lensed' : ''].filter(Boolean).join(' ');
    const style = {
        ...(width ? { '--w': `${width}px` } : {}),
        ...(lensed && heat > 0.05 ? { boxShadow: `0 0 0 2px rgba(246,196,84,${(0.25 + heat * 0.75).toFixed(2)}), 0 0 ${Math.round(6 + heat * 22)}px -2px rgba(246,196,84,${(heat * 0.8).toFixed(2)})` } : {})
    } as CSSProperties;
    return (
        <div className={cls} style={style} title={card.n} {...focus}
            aria-label={card.n + (unit ? `, ${unit.p} power, ${hp} HP left` : '') + (exhausted ? ', exhausted' : '') + (value?.v != null ? `, worth ${value.v.toFixed(1)}` : '')}>
            {showImg ? (
                <>
                    {mismatch === url && <img src={url} alt="" draggable={false} className="backdrop" />}
                    <img src={url} alt="" loading="lazy" draggable={false} className={mismatch === url ? 'whole' : undefined} onError={() => setFailed(url)}
                        onLoad={(e) => {
                            const im = e.currentTarget;
                            if (im.naturalWidth && (im.naturalWidth > im.naturalHeight) !== (shape === 'wide')) {
                                setMismatch(url);
                            }
                        }} />
                </>
            ) : (
                <div className="tile" style={{ '--a': look.a, '--b': look.b, '--ang': `${look.angle}deg` } as CSSProperties}>
                    <span className="mono">{look.mono}</span>
                    <span className="nm">{card.n}</span>
                </div>
            )}
            {unit && size !== 'sm' && (
                <>
                    <span className="stat pw">{unit.p}</span>
                    <span className={`stat hp${unit.d > 0 ? ' hurt' : ''}`}>{hp}</span>
                </>
            )}
            {unit?.sn ? <span className="mark sentinel" title="Sentinel">SEN</span> : null}
            {unit?.u && unit.u.length > 0 && size !== 'sm' && (
                <div className="ups">
                    {unit.u.map((u, i) => <span key={i} className={`up${u.t ? ' token' : ''}`} title={u.n}>{u.n}</span>)}
                </div>
            )}
            {lensed && <LensMarks value={value!} size={size} />}
        </div>
    );
}

export function CardBack({ size = 'md', value }: { size?: 'sm' | 'md'; value?: CardValue | null }) {
    return (
        <div className={`card card-back${size === 'sm' ? ' sm' : ''}`} aria-hidden="true">
            {value && <LensMarks value={{ ...value, v: null }} size={size} />}
        </div>
    );
}
