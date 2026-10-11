import { Asterisk, BrickWall, CircleDot, Crown, Database, Flag, Layers, Library, Mountain, Rocket, Scale, Skull, type LucideIcon } from 'lucide-react';
import { rowColor, rowIcon, type RowDef } from '../data/terms';

// base, resources and initiative use the action icons' pictograms (ActionIcon ACTION_GLYPHS), and deck and discard the
// board's own counters, so one picture means one thing; CircleDot is any other extra term
const ICONS: Record<string, LucideIcon> = {
    base: BrickWall, ground: Mountain, space: Rocket, hand: Layers, resources: Database, initiative: Flag,
    deck: Library, discard: Skull, leader: Crown, joint: Scale, other: Asterisk, extra: CircleDot
};

/**
 * The small icon for one part of a score, in that part's colour: on the board's totals, the breakdown's rows and the
 * inspector. `row` is a RowDef or a row id ('base', 'ground', 'side.hand', 'extra.deck', ...; a bare 'hand' works too).
 */
export function PartIcon({ row, size = 11, colored = true }: { row: RowDef | string; size?: number; colored?: boolean }) {
    const id = typeof row === 'string' ? row : row.id;
    const I = ICONS[typeof row === 'string' ? rowIcon(id) : row.icon] ?? CircleDot;
    return <I size={size} strokeWidth={2.4} aria-hidden="true" style={colored ? { color: typeof row === 'string' ? rowColor(id) : row.color } : undefined} />;
}

/**
 * The card-values button's icon: a card with a value chip on it whose bars are the score's colours (ground, space,
 * base), i.e. "show what each card is worth". In colour while the values are on, plain while they're off.
 */
export function ValuesIcon({ on, size = 18 }: { on: boolean; size?: number }) {
    const bar = (row: string) => (on ? rowColor(row) : 'currentColor');
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
