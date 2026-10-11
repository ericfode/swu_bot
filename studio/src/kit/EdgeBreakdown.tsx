import { motion } from 'motion/react';
import { edgeTerms } from '../data/derive';
import { LENS_SCALE, type LensStep } from '../data/lens';
import type { Seat, Snapshot } from '../data/types';

const sgn = (v: number, d = 1) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`;

/**
 * Why the board score is what it is, in the omniscient bot's own terms: what each part of the board is worth to each
 * player, drawn as a tug of war (bars right of centre pull toward player 1, left toward player 2), then the edge.
 * `lens` is the game's lens step for this board (exact values); without it the score is estimated without card cost.
 */
export function EdgeBreakdown({ state, prev, bots, lens = null, prevLens = null }: { state: Snapshot; prev: Snapshot | null; bots: Record<Seat, string>; lens?: LensStep | null; prevLens?: LensStep | null }) {
    const { terms, sum, edge, exact } = edgeTerms(state, lens);
    const before = prev ? edgeTerms(prev, prevLens) : null;
    const max = Math.max(8, ...terms.map((t) => Math.abs(t.points)));
    const lead = sum > 0.5 ? 'p1' : sum < -0.5 ? 'p2' : null;
    const tot = (s: Seat) => terms.reduce((a, t) => a + t[s], 0);
    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="eyebrow">Omni board score</span>
                <span className="num text-lg font-semibold" style={{ color: lead === 'p1' ? 'var(--color-p1)' : lead === 'p2' ? 'var(--color-p2)' : 'var(--color-fg)' }}>
                    {sgn(sum)}
                </span>
                <span className="text-dim text-[13px]">{lead ? `${bots[lead]} ahead by ${Math.abs(sum).toFixed(1)} points` : 'even board'}</span>
                <span className="text-faint text-[11px] num ml-auto" title="the curve plots tanh(edge / 25)">
                    {tot('p1').toFixed(1)} − {tot('p2').toFixed(1)} · curve {sgn(edge, 2)}{before ? ` · ${sgn(sum - before.sum)} this step` : ''}
                </span>
            </div>
            <div className="grid grid-cols-[minmax(0,8.5rem)_2.8rem_minmax(0,1fr)_2.8rem_3.2rem] items-center gap-x-2 gap-y-1.5 text-[12px]">
                <span />
                <span className="text-right text-p2 truncate text-[11px]" title={bots.p2}>{bots.p2}</span>
                <span className="flex justify-between text-[10px] text-faint px-1"><span>← toward {bots.p2}</span><span>toward {bots.p1} →</span></span>
                <span className="text-p1 truncate text-[11px]" title={bots.p1}>{bots.p1}</span>
                <span className="text-right text-faint text-[10px]">edge</span>
                {terms.map((t) => {
                    const w = (Math.abs(t.points) / max) * 50;
                    const pos = t.points >= 0;
                    const what = t.what.p1 === t.what.p2 ? t.what.p1 : `${t.what.p2} vs ${t.what.p1}`;
                    return [
                        <span key={`${t.key}l`} className="truncate" title={t.how}><span className="text-dim">{t.label}</span> <span className="text-faint text-[10px]">{what}</span></span>,
                        <span key={`${t.key}a`} className="num text-right text-fg/80">{t.p2.toFixed(1)}</span>,
                        <span key={`${t.key}b`} className="relative h-3.5 rounded-sm bg-ink/80" title={t.how}>
                            <span className="absolute left-1/2 top-0 bottom-0 w-px bg-line" />
                            <motion.span className="absolute top-0.5 bottom-0.5 rounded-sm" initial={false}
                                animate={{ left: pos ? '50%' : `${50 - w}%`, width: `${w}%` }} transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                                style={{ background: pos ? 'var(--color-p1)' : 'var(--color-p2)', opacity: 0.85 }} />
                        </span>,
                        <span key={`${t.key}c`} className="num text-fg/80">{t.p1.toFixed(1)}</span>,
                        <span key={`${t.key}d`} className="num text-right" style={{ color: Math.abs(t.points) < 0.05 ? 'var(--color-faint)' : pos ? 'var(--color-p1)' : 'var(--color-p2)' }}>
                            {sgn(t.points)}
                        </span>
                    ];
                })}
            </div>
            <p className="text-faint text-[11px] leading-snug m-0">
                The score the omniscient bot's search uses at its leaves: each row is what that part of the board is worth to each player (hover a row for its rule),
                and the edge is player 1's total minus player 2's. The curve plots tanh(edge / {LENS_SCALE}).
                {exact ? ' Values from this game\'s lens file.' : ' No lens file for this game: estimated from the board, without card cost.'} Turn on Lens to see every card's value on the board.
            </p>
        </div>
    );
}
