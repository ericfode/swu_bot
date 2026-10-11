import { motion } from 'motion/react';
import { edgeTerms } from '../data/derive';
import { LENS_SCALE, TERM_COLOR, type LensStep } from '../data/lens';
import { TermIcon, ValuesIcon } from '../components/TermIcon';
import type { Seat, Snapshot } from '../data/types';

const sgn = (v: number, d = 1) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`;
/** points of edge one full half-bar stands for, the same at every step so lengths compare */
const SCALE = 15;
const spring = { type: 'spring', stiffness: 300, damping: 30 } as const;
const seatCol = (v: number) => (Math.abs(v) < 0.05 ? 'var(--color-faint)' : v > 0 ? 'var(--color-p1)' : 'var(--color-p2)');

/** One row's tug of war: the bar grows from the centre toward the side the term favours; the outline is the previous step. */
function Bar({ value, prev }: { value: number; prev: number | null }) {
    const w = (v: number) => Math.min(50, (Math.abs(v) / SCALE) * 50);
    const over = Math.abs(value) > SCALE;
    return (
        <span className="relative block h-3.5 rounded-sm bg-ink/80">
            <span className="absolute left-1/2 top-0 bottom-0 w-px bg-line" />
            {prev != null && Math.abs(prev - value) >= 0.05 && (
                <span className="absolute top-0 bottom-0 rounded-sm border border-dashed border-fg/30"
                    style={{ left: prev >= 0 ? '50%' : `${50 - w(prev)}%`, width: `${w(prev)}%` }} />
            )}
            <motion.span className="absolute top-0.5 bottom-0.5 rounded-sm" initial={false} transition={spring}
                animate={{ left: value >= 0 ? '50%' : `${50 - w(value)}%`, width: `${w(value)}%` }}
                style={{ background: value >= 0 ? 'var(--color-p1)' : 'var(--color-p2)', opacity: 0.85 }} />
            {over && <span className="absolute top-1/2 -translate-y-1/2 text-[9px] leading-none text-fg" style={value > 0 ? { right: 1 } : { left: 1 }}>{value > 0 ? '▶' : '◀'}</span>}
        </span>
    );
}

/**
 * Why the board score is what it is, in the omniscient bot's own terms: what each part of the board is worth to each
 * player, the rule for each row, the total, and the chance to win it implies. Bars keep one scale (15 points
 * to the end) and the dashed outline is the previous step, so a change shows as movement.
 * `lens` is the game's lens step for this board (exact values); without it the score is estimated without card cost.
 */
export function EdgeBreakdown({ state, prev, bots, lens = null, prevLens = null, previewN = null }: {
    state: Snapshot; prev: Snapshot | null; bots: Record<Seat, string>; lens?: LensStep | null; prevLens?: LensStep | null;
    /** set while the pointer previews another step on the timeline: that step's Step.n */
    previewN?: number | null;
}) {
    const { terms, sum, edge, exact } = edgeTerms(state, lens);
    const before = prev ? edgeTerms(prev, prevLens) : null;
    const prevOf = (k: string) => before?.terms.find((t) => t.key === k)?.points ?? null;
    const lead: Seat | null = sum > 0.5 ? 'p1' : sum < -0.5 ? 'p2' : null;
    const tot = (s: Seat) => terms.reduce((a, t) => a + t[s], 0);
    const moved = before ? terms.map((t) => ({ t, d: t.points - (prevOf(t.key) ?? 0) })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0] : null;
    const cols = 'grid grid-cols-[2.6rem_minmax(0,1fr)_2.6rem_4.2rem] @md:grid-cols-[minmax(0,12.5rem)_2.8rem_minmax(0,1fr)_2.8rem_4.4rem] items-center gap-x-2';
    const name = (s: Seat) => <span className="truncate" style={{ color: `var(--color-${s})` }} title={`${bots[s]} (${s})`}>{bots[s]}</span>;
    return (
        <div className="@container flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="eyebrow">Omni board score</span>
                <span className="num text-lg font-semibold" style={{ color: 'var(--color-edge)' }} title="The same number as the timeline's Omni score line (in points) and the board's centre line">{sgn(sum)}</span>
                <span className="text-dim text-[13px]">{lead ? <>{name(lead)} ahead by {Math.abs(sum).toFixed(1)} points</> : 'even board'}</span>
                {previewN != null && <span className="chip !text-fg !border-fg/40 ml-auto">previewing step {previewN}</span>}
            </div>
            <div className={`${cols} text-[10px] text-faint`}>
                <span className="hidden @md:block" />
                <span className="text-right" style={{ color: 'var(--color-p2)' }} title={`${bots.p2} (p2)`}>p2</span>
                <span className="flex justify-between gap-2 px-1 min-w-0"><span className="flex gap-1 min-w-0">◀ {name('p2')}</span><span className="flex gap-1 min-w-0 justify-end">{name('p1')} ▶</span></span>
                <span style={{ color: 'var(--color-p1)' }} title={`${bots.p1} (p1)`}>p1</span>
                <span className="text-right">edge</span>
            </div>
            <div className={`${cols} gap-y-1 text-[12px]`}>
                {terms.map((t) => {
                    const p = prevOf(t.key);
                    const d = p == null ? 0 : t.points - p;
                    const what = t.what.p1 === t.what.p2 ? `${t.what.p1} each` : `${t.what.p2} vs ${t.what.p1}`;
                    return [
                        <span key={`${t.key}l`} className="col-span-4 @md:col-span-1 min-w-0 leading-tight pt-1 @md:pt-0" title={t.how}>
                            <span className="inline-flex items-center gap-1 font-medium" style={{ color: TERM_COLOR[t.key] }}><TermIcon term={t.key} />{t.label}</span> <span className="text-faint text-[11px]">{what}</span>
                            <span className="block text-faint text-[10.5px] truncate">{t.rule}</span>
                        </span>,
                        <span key={`${t.key}a`} className="num text-right" style={{ color: TERM_COLOR[t.key] }}>{t.p2.toFixed(1)}</span>,
                        <Bar key={`${t.key}b`} value={t.points} prev={p} />,
                        <span key={`${t.key}c`} className="num" style={{ color: TERM_COLOR[t.key] }}>{t.p1.toFixed(1)}</span>,
                        <span key={`${t.key}d`} className="num text-right whitespace-nowrap">
                            <span style={{ color: seatCol(t.points) }}>{sgn(t.points)}</span>
                            {Math.abs(d) >= 0.05 && <span className="text-[10px] ml-1" style={{ color: seatCol(d) }} title="change since the previous step">{d > 0 ? '▲' : '▼'}{Math.abs(d).toFixed(1)}</span>}
                        </span>
                    ];
                })}
                <span className="col-span-4 @md:col-span-1 pt-1.5 border-t border-line font-semibold text-fg">Total <span className="font-normal text-faint text-[11px]">Σ on the board</span></span>
                <span className="num text-right pt-1.5 border-t border-line text-fg">{tot('p2').toFixed(1)}</span>
                <span className="pt-1.5 border-t border-line text-center text-[11px] text-dim num">{tot('p1').toFixed(1)} − {tot('p2').toFixed(1)}</span>
                <span className="num pt-1.5 border-t border-line text-fg">{tot('p1').toFixed(1)}</span>
                <span className="num text-right pt-1.5 border-t border-line font-semibold" style={{ color: 'var(--color-edge)' }}>{sgn(sum)}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-dim">
                <span title="The estimate action swings use when a game has no evaluations">As a chance {name('p1')} wins: (1 + tanh({sgn(sum)} / {LENS_SCALE})) / 2 = <b className="num" style={{ color: 'var(--color-edge)' }}>{Math.round(50 + edge * 50)}%</b></span>
                <span className="relative h-2 w-40 rounded-full bg-line shrink-0" aria-hidden="true">
                    <span className="absolute left-1/2 -top-0.5 -bottom-0.5 w-px bg-line" />
                    <motion.span className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-bg" initial={false} transition={spring}
                        animate={{ left: `${50 + edge * 50}%` }} style={{ background: 'var(--color-edge)' }} />
                    <span className="absolute -bottom-3.5 left-0 text-[9px] text-faint num">0%</span>
                    <span className="absolute -bottom-3.5 right-0 text-[9px] text-faint num">100%</span>
                </span>
            </div>
            {moved && (
                <div className="text-[11px] text-dim pt-1">
                    {Math.abs(moved.d) < 0.05 ? 'Nothing on the board score changed this step.' : <>Biggest change this step: <b className="text-fg/90">{moved.t.label}</b> moved {Math.abs(moved.d).toFixed(1)} toward {name(moved.d > 0 ? 'p1' : 'p2')} (edge {sgn(sum - before!.sum)} in total).</>}
                </div>
            )}
            <p className="text-faint text-[11px] leading-snug m-0">
                This is the score the omniscient bot's search uses at its leaves: each row is what that part of the board is worth to each player, and the edge is player 1's total minus player 2's.
                {exact ? ' Values come from this game\'s lens file.' : ' This game has no lens file, so the values are estimated from the board and leave out card cost.'} Turn on card values (<span className="inline-block align-[-3px]"><ValuesIcon on size={14} /></span> next to Card art) to see each card's value on the board, in its row's colour.
            </p>
        </div>
    );
}
