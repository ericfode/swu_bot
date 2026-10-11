import { memo } from 'react';
import type { PlayerSnap, Seat, Snapshot, UnitRef } from '../data/types';

// A whole board in a 40x48 icon, after the research dashboard's glyph (dashboard/site/glyph.cjs), so both draw positions the same way.
// Player 2 is the top half, player 1 the bottom half, mirrored on the centre line.
//   edge bar: base HP left · tall row: ground units · short row: space units
//   unit height = power (cap 7), opacity = HP left, outline only = exhausted
//   left pips: cards in hand (≤6) · right pips: ready (filled) of total resources (≤8) · triangle: initiative
const COL: Record<Seat, string> = { p1: 'var(--color-p1)', p2: 'var(--color-p2)' };

function Half({ ps, seat, top }: { ps: PlayerSnap; seat: Seat; top: boolean }) {
    const col = COL[seat];
    const Y = (y: number, h = 0) => (top ? y : 48 - y - h);
    const hp = ps.base?.hp || 30;
    const left = Math.max(0, hp - (ps.base?.d || 0));
    const row = (units: UnitRef[], y0: number, maxH: number) => units.slice(0, 6).map((u, i) => {
        const h = Math.max(1.2, (Math.min(7, u.p || 0) / 7) * maxH);
        const x = 5.5 + i * 5;
        const op = u.h ? Math.max(0.3, (u.h - (u.d || 0)) / u.h) : 1;
        const y = top ? y0 : 48 - y0 - h;
        return u.x
            ? <rect key={i} x={x} y={y} width={3.6} height={h} fill="none" stroke={col} strokeWidth={0.8} opacity={op} />
            : <rect key={i} x={x} y={y} width={3.6} height={h} rx={0.6} fill={col} opacity={op} />;
    });
    const tot = Math.min(8, ps.res?.total || 0);
    const rdy = Math.min(tot, ps.res?.ready || 0);
    return (
        <g>
            <rect x={5} y={Y(1.2, 2.6)} width={30} height={2.6} rx={1.3} fill="var(--color-line)" />
            <rect x={5} y={Y(1.2, 2.6)} width={(30 * left) / hp} height={2.6} rx={1.3} fill={col} />
            {row(ps.space ?? [], 5.2, 4.6)}
            {row(ps.ground ?? [], 11.2, 9.6)}
            {Array.from({ length: Math.min(6, ps.hand?.length || 0) }, (_, i) => <circle key={`h${i}`} cx={2.3} cy={Y(6 + i * 2.7)} r={0.9} fill="var(--color-fg)" opacity={0.55} />)}
            {Array.from({ length: tot }, (_, i) => (
                <circle key={`r${i}`} cx={37.7} cy={Y(5.5 + i * 2.15)} r={0.85} {...(i < rdy ? { fill: col } : { fill: 'none', stroke: col, strokeWidth: 0.5 })} />
            ))}
            {ps.leader?.dep ? <path d={`M36.2 ${Y(1.2)} l1.5 ${top ? 2.6 : -2.6} l1.5 ${top ? -2.6 : 2.6}z`} fill={col} /> : null}
        </g>
    );
}

/** value (P(p1 wins), 0..1) tints the frame toward player 1 or player 2. */
export const Glyph = memo(function Glyph({ state, size = 40, value, selected, title }: { state: Snapshot; size?: number; value?: number | null; selected?: boolean; title?: string }) {
    const lean = value == null ? 0 : Math.min(1, Math.abs(value - 0.5) * 2.4);
    const frame = selected ? 'var(--color-gold)' : value == null ? 'var(--color-line)'
        : `color-mix(in srgb, ${value >= 0.5 ? 'var(--color-p1)' : 'var(--color-p2)'} ${Math.round(lean * 100)}%, var(--color-line))`;
    return (
        <svg width={size} height={size * 1.2} viewBox="0 0 40 48" role="img" aria-label={title ?? 'board position'} className="block">
            {title && <title>{title}</title>}
            <rect x={0.5} y={0.5} width={39} height={47} rx={3} fill="var(--color-ink)" stroke={frame} strokeWidth={selected || value != null ? 1.6 : 0.8} />
            <line x1={4} x2={36} y1={24} y2={24} stroke="var(--color-line)" strokeWidth={0.6} />
            <Half ps={state.players.p2} seat="p2" top />
            <Half ps={state.players.p1} seat="p1" top={false} />
            {state.initiative && (
                <path d={`M1 ${state.initiative === 'p2' ? 25.6 : 22.4} l2 ${state.initiative === 'p2' ? -3.2 : 3.2} l2 ${state.initiative === 'p2' ? 3.2 : -3.2}z`} fill={COL[state.initiative]} />
            )}
        </svg>
    );
});
