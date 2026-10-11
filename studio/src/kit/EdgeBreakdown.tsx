import { motion } from 'motion/react';
import { edgeTerms } from '../data/derive';
import type { Seat, Snapshot } from '../data/types';

/**
 * Why the material edge is what it is: each term's raw numbers for both players and the points it gives,
 * drawn as a tug of war (bars right of centre pull toward player 1, left toward player 2), then the squash to -1..1.
 */
export function EdgeBreakdown({ state, prev, bots }: { state: Snapshot; prev: Snapshot | null; bots: Record<Seat, string> }) {
    const { terms, sum, edge } = edgeTerms(state);
    const before = prev ? edgeTerms(prev) : null;
    const max = Math.max(8, ...terms.map((t) => Math.abs(t.points)));
    const lead = edge > 0.02 ? 'p1' : edge < -0.02 ? 'p2' : null;
    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="eyebrow">Material edge</span>
                <span className="num text-lg font-semibold" style={{ color: lead === 'p1' ? 'var(--color-p1)' : lead === 'p2' ? 'var(--color-p2)' : 'var(--color-fg)' }}>
                    {edge >= 0 ? '+' : ''}{edge.toFixed(2)}
                </span>
                <span className="text-dim text-[13px]">{lead ? `${bots[lead]} ahead on the board` : 'even board'}</span>
                <span className="text-faint text-[11px] num ml-auto">tanh({sum.toFixed(1)} / 18){before ? ` · ${sum - before.sum >= 0 ? '+' : ''}${(sum - before.sum).toFixed(1)} this step` : ''}</span>
            </div>
            <div className="grid grid-cols-[minmax(0,7.5rem)_2.6rem_minmax(0,1fr)_2.6rem_3.4rem] items-center gap-x-2 gap-y-1.5 text-[12px]">
                <span />
                <span className="text-right text-p2 truncate text-[11px]" title={bots.p2}>{bots.p2}</span>
                <span className="flex justify-between text-[10px] text-faint px-1"><span>← toward {bots.p2}</span><span>toward {bots.p1} →</span></span>
                <span className="text-p1 truncate text-[11px]" title={bots.p1}>{bots.p1}</span>
                <span className="text-right text-faint text-[10px]">points</span>
                {terms.map((t) => {
                    const w = (Math.abs(t.points) / max) * 50;
                    const pos = t.points >= 0;
                    return [
                        <span key={`${t.key}l`} className="text-dim truncate" title={t.how}>{t.label}</span>,
                        <span key={`${t.key}a`} className="num text-right text-fg/80">{t.p2}</span>,
                        <span key={`${t.key}b`} className="relative h-3.5 rounded-sm bg-ink/80" title={t.how}>
                            <span className="absolute left-1/2 top-0 bottom-0 w-px bg-line" />
                            <motion.span className="absolute top-0.5 bottom-0.5 rounded-sm" initial={false}
                                animate={{ left: pos ? '50%' : `${50 - w}%`, width: `${w}%` }} transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                                style={{ background: pos ? 'var(--color-p1)' : 'var(--color-p2)', opacity: 0.85 }} />
                        </span>,
                        <span key={`${t.key}c`} className="num text-fg/80">{t.p1}</span>,
                        <span key={`${t.key}d`} className="num text-right" style={{ color: Math.abs(t.points) < 0.05 ? 'var(--color-faint)' : pos ? 'var(--color-p1)' : 'var(--color-p2)' }}>
                            {t.points >= 0 ? '+' : ''}{t.points.toFixed(1)}
                        </span>
                    ];
                })}
            </div>
            <p className="text-faint text-[11px] leading-snug m-0">
                A simple built-in score, not a bot's opinion: each row is (player 1 − player 2) × a weight, hover a row for its rule. The total is squashed with tanh so the curve stays in −1..+1.
            </p>
        </div>
    );
}
