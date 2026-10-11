import { useState, type CSSProperties } from 'react';
import { cardImageUrl, tileLook } from '../lib/cards';
import { useSettings } from '../lib/settings';
import type { CardRef, UnitRef } from '../data/types';

export interface Focus {
    card: CardRef;
    back: boolean;
    unit?: UnitRef;
    note?: string;
}

interface Props {
    card: CardRef;
    size?: 'sm' | 'md' | 'lg' | 'land';
    /** leader flipped to its deployed (unit) side */
    back?: boolean;
    unit?: UnitRef;
    exhausted?: boolean;
    note?: string;
    onFocus?: (f: Focus | null) => void;
}

/** One card: art when the CDN has it, otherwise a generated tile (tokens, unreleased sets, fixtures). */
export function Card({ card, size = 'md', back = false, unit, exhausted = false, note, onFocus }: Props) {
    const art = useSettings((s) => s.art);
    useSettings((s) => s.artVersion);
    const [failed, setFailed] = useState<string | null>(null);
    const url = art ? cardImageUrl(card.s, back) : null;
    const showImg = url !== null && failed !== url;
    const look = tileLook(card.n);
    const hp = unit ? unit.h - unit.d : null;
    const focus = onFocus
        ? { onMouseEnter: () => onFocus({ card, back, unit, note }), onFocus: () => onFocus({ card, back, unit, note }), tabIndex: 0 }
        : {};
    const cls = ['card', size !== 'md' ? size : '', exhausted ? 'exh' : ''].filter(Boolean).join(' ');
    return (
        <div className={cls} title={card.n} {...focus} aria-label={card.n + (unit ? `, ${unit.p} power, ${hp} HP left` : '') + (exhausted ? ', exhausted' : '')}>
            {showImg ? (
                <img src={url} alt="" loading="lazy" draggable={false} onError={() => setFailed(url)} />
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
        </div>
    );
}

export function CardBack({ size = 'md' }: { size?: 'sm' | 'md' }) {
    return <div className={`card card-back${size === 'sm' ? ' sm' : ''}`} aria-hidden="true" />;
}
