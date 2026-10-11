import { useState } from 'react';
import { cardImageUrl } from './cardImage';
import { useSettings } from './settings';
import type { CardRef, UnitRef } from './types';

export interface Focus {
    card: CardRef;
    back: boolean;
    unit?: UnitRef;
}

interface Props {
    card: CardRef;
    kind: 'unit' | 'hand' | 'base' | 'leader';
    /** leader flipped to its unit side */
    back?: boolean;
    unit?: UnitRef;
    exhausted?: boolean;
    onFocus?: (f: Focus | null) => void;
}

/** One card, as art when the image loads and as a stat tile otherwise (tokens and unreleased sets have no art). */
export function CardView({ card, kind, back = false, unit, exhausted = false, onFocus }: Props) {
    const { cardMode } = useSettings();
    const [failed, setFailed] = useState<string | null>(null);
    const url = cardMode === 'images' ? cardImageUrl(card.s, back) : null;
    const showImg = url !== null && failed !== url;
    const cls = `card ${kind}${exhausted ? ' exh' : ''}${showImg ? ' art' : ' tile'}`;
    const focus = onFocus ? { onMouseEnter: () => onFocus({ card, back, unit }), onMouseLeave: () => onFocus(null), onFocus: () => onFocus({ card, back, unit }), onBlur: () => onFocus(null), tabIndex: 0 } : {};
    const hp = unit ? unit.h - unit.d : null;
    return (
        <div className={cls} title={card.n} {...focus}>
            {showImg ? (
                <img src={url} alt={card.n} loading="lazy" draggable={false} onError={() => setFailed(url)} />
            ) : (
                <div className="tile-name">{card.n}</div>
            )}
            {unit && (
                <div className="stats-badge" aria-label={`power ${unit.p}, ${hp} hit points left`}>
                    <span className="pw">{unit.p}</span>
                    <span className={`hp${unit.d > 0 ? ' hurt' : ''}`}>{hp}</span>
                </div>
            )}
            {unit?.sn ? <span className="mark sentinel" title="Sentinel">S</span> : null}
            {unit?.u && unit.u.length > 0 && (
                <div className="ups">
                    {unit.u.map((u, i) => (
                        <span key={i} className={`up${u.t ? ' token' : ''}`} title={u.n}>{u.t ? u.n.slice(0, 1) : u.n}</span>
                    ))}
                </div>
            )}
            {exhausted && <span className="exh-label">exhausted</span>}
        </div>
    );
}

export function CardBack({ count, label }: { count: number; label: string }) {
    return <div className="card hand tile back" title={label}><div className="tile-name">{count}</div></div>;
}
