import { useState, type CSSProperties, type FocusEvent, type MouseEvent, type ReactNode } from 'react';
import { cardImageUrl, tileLook } from '../lib/cards';
import { isToken } from '../lib/cardText';
import { useSettings } from '../lib/settings';
import type { CardRef, Seat, UnitRef, UpgradeRef } from '../data/types';
import { TERM_COLOR, type TermKey } from '../data/lens';

/** Leader fronts and bases are printed landscape ('wide'); everything else, a deployed leader included, is portrait ('tall'). */
export type CardShape = 'tall' | 'wide';

/** What a card is worth under the lens (the omni bot's board score), drawn on the card. */
export interface CardValue {
    /** points for the card's owner; null for cards the score doesn't count on their own (an undeployed leader) */
    v: number | null;
    seat: Seat;
    /** which part of the score the card counts in: sets the chip's colour, the same as that part's total and breakdown row */
    term?: TermKey;
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
    /** a deployed leader on the board: gets a LEADER badge */
    leader?: boolean;
    /** drawn instead of the generated tile when there is no image (the inspector's text face) */
    face?: ReactNode;
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
                <span className={`lensv${small ? ' sm' : ''}`} style={{ '--term': TERM_COLOR[value.term ?? 'ground'] } as CSSProperties} title="What this card is worth to its owner in the omni bot's board score">
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

/**
 * A unit's upgrade tags: copies of one upgrade (Experience, Advantage tokens…) folded into "Name ×N", and at most three
 * tags, the third becoming "+N" (the inspector lists them all), so the stack never reaches the lens chip.
 */
function upgradeTags(ups: UpgradeRef[]) {
    const groups: { n: string; t: 0 | 1; count: number; title: string; more?: boolean }[] = [];
    for (const u of ups) {
        const g = groups.find((x) => x.n === u.n);
        if (g) {
            g.count++;
            g.title = `${u.n} ×${g.count}`;
        } else {
            groups.push({ n: u.n, t: u.t, count: 1, title: u.n });
        }
    }
    if (groups.length <= 3) {
        return groups;
    }
    const rest = groups.slice(2);
    return [...groups.slice(0, 2), { n: `+${rest.reduce((a, g) => a + g.count, 0)}`, t: 0 as const, count: 1, title: rest.map((g) => g.title).join(', '), more: true }];
}

/**
 * One card: art when there is some, otherwise a generated tile (tokens, unreleased sets, fixtures).
 * Board-size cards stack their facts from the bottom up so nothing covers anything: name bar, then power/HP, then the
 * lens chip; marks (LEADER, Sentinel) sit top left and upgrades top right.
 */
export function Card({ card, size = 'md', shape = 'tall', back = false, unit, exhausted = false, note, kind = 'unit', hpLeft, width, value, leader = false, face, onFocus, onLeave }: Props) {
    const art = useSettings((s) => s.art);
    useSettings((s) => s.artVersion);
    const [failed, setFailed] = useState<string | null>(null);
    // an image whose orientation doesn't match the box (art data can disagree with the card type) is fitted whole, not cropped
    const [mismatch, setMismatch] = useState<string | null>(null);
    const url = art ? cardImageUrl(card.s, back) : null;
    const showImg = url !== null && failed !== url;
    const look = tileLook(card.n, card.s);
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
    // board-size cards print their name in a bar at the bottom (one line over art, up to two on a tile)
    const named = size === 'md';
    const stats = !!unit && size !== 'sm';
    const ups = !!unit?.u?.length && size !== 'sm';
    // tokens (Battle Droid, Shield…) have no set number; a text face that says "Token unit" makes the tag redundant
    const token = isToken(card) && (showImg || !face);
    const cls = ['card', size !== 'md' ? size : '', shape === 'wide' ? 'wide' : '', exhausted ? 'exh' : '', lensed ? 'lensed' : '', showImg ? 'art' : '', named ? 'named' : ''].filter(Boolean).join(' ');
    const style = {
        ...(width ? { '--w': `${width}px` } : {}),
        // the glow: the card's score colour, stronger the closer it is to the most valuable unit on the table
        ...(lensed && heat > 0.05 ? {
            '--term': TERM_COLOR[value?.term ?? 'ground'],
            boxShadow: `0 0 0 2px color-mix(in oklab, var(--term) ${Math.round(25 + heat * 75)}%, transparent), 0 0 ${Math.round(6 + heat * 22)}px -2px color-mix(in oklab, var(--term) ${Math.round(heat * 80)}%, transparent)`
        } : {})
    } as CSSProperties;
    return (
        <div className={cls} style={style} title={card.n} {...focus}
            aria-label={(leader ? 'Leader ' : '') + card.n + (unit ? `, ${unit.p} power, ${hp} HP left${unit.d > 0 ? ` (${unit.d} damage)` : ''}` : '') + (unit?.sn ? ', Sentinel' : '') + (exhausted ? ', exhausted' : '') + (value?.v != null ? `, worth ${value.v.toFixed(1)}` : '')}>
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
            ) : face ?? (
                <div className="tile" style={{ '--a': look.a, '--b': look.b, '--ang': `${look.angle}deg`, ...(look.grad ? { background: `radial-gradient(circle at 30% 20%, #ffffff22, transparent 55%), ${look.grad}` } : {}) } as CSSProperties}>
                    <span className="mono">{look.mono}</span>
                    <span className="nm">{card.n}</span>
                </div>
            )}
            {(leader || unit?.sn || token || ups) && (
                <div className="top">
                    {(leader || unit?.sn || token) && (
                        <span className="marks">
                            {leader && <span className="mark leader" title="This player's leader, deployed">Leader</span>}
                            {token && <span className="mark token" title="Token: created during play, not a card from a deck">TOKEN</span>}
                            {unit?.sn ? <span className="mark sentinel" title="Sentinel">SEN</span> : null}
                        </span>
                    )}
                    {ups && (
                        <div className="ups">
                            {upgradeTags(unit!.u!).map((g) => (
                                <span key={g.n} className={`up${g.t ? ' token' : ''}${g.t && g.n === 'Shield' ? ' shield' : ''}${g.more ? ' more' : ''}`} title={g.title}>{g.n}{g.count > 1 ? ` ×${g.count}` : ''}</span>
                            ))}
                        </div>
                    )}
                </div>
            )}
            {(lensed || stats || named) && (
                <div className="foot">
                    {lensed && <LensMarks value={value!} size={size} />}
                    {stats && (
                        <div className="stats">
                            <span className="stat pw">{unit!.p}</span>
                            <span className={`stat hp${unit!.d > 0 ? ' hurt' : ''}`}>
                                {unit!.d > 0 && <span className="dmg" title={`${unit!.d} damage`}>{unit!.d}</span>}
                                {hp}
                            </span>
                        </div>
                    )}
                    {named && <span className="nmbar">{card.n}</span>}
                </div>
            )}
        </div>
    );
}

export function CardBack({ size = 'md', value }: { size?: 'sm' | 'md'; value?: CardValue | null }) {
    return (
        <div className={`card card-back${size === 'sm' ? ' sm' : ''}`} aria-hidden="true">
            {value && value.regret != null && <div className="foot"><LensMarks value={{ ...value, v: null }} size={size} /></div>}
        </div>
    );
}
