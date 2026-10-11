import { Castle, Crown, Gem, Layers, Mountain, Rocket, type LucideIcon } from 'lucide-react';
import { TERM_COLOR, type TermKey } from '../data/lens';

const ICONS: Record<TermKey, LucideIcon> = { base: Castle, ground: Mountain, space: Rocket, hand: Layers, resources: Gem, initiative: Crown };

/** The small icon for one part of the omni board score, in that part's colour: on the board's totals and the breakdown's rows. */
export function TermIcon({ term, size = 11, colored = true }: { term: TermKey; size?: number; colored?: boolean }) {
    const I = ICONS[term];
    return <I size={size} strokeWidth={2.4} aria-hidden="true" style={colored ? { color: TERM_COLOR[term] } : undefined} />;
}

/**
 * The card-values button's icon: a card with a value chip on it whose bars are the score's colours (ground, space,
 * base), i.e. "show what each card is worth". In colour while the values are on, plain while they're off.
 */
export function ValuesIcon({ on, size = 18 }: { on: boolean; size?: number }) {
    const bar = (term: TermKey) => (on ? TERM_COLOR[term] : 'currentColor');
    return (
        <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <rect x="1.75" y="1.75" width="9.5" height="13" rx="1.6" stroke="currentColor" strokeWidth="1.5" />
            <path d="M4 11.5 L6.4 8.4 L8.2 10.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" opacity="0.6" />
            <rect x="8" y="8.25" width="9.25" height="8.5" rx="2" fill="var(--color-bg)" stroke="currentColor" strokeWidth="1.3" />
            <rect x="9.9" y="13" width="1.5" height="2.2" rx="0.4" fill={bar('ground')} />
            <rect x="12" y="11.4" width="1.5" height="3.8" rx="0.4" fill={bar('space')} />
            <rect x="14.1" y="9.8" width="1.5" height="5.4" rx="0.4" fill={bar('base')} />
        </svg>
    );
}
