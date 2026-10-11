import { motion } from 'motion/react';
import type { LensStep } from '../data/lensFile';
import { estimateCostFrom, rowFacts, rowsAt, rowValue, scoreOfBoard, type ScoreStep, type ScoreView } from '../data/score';
import { loadedCardCost } from '../lib/cardText';
import { displayScales, fmtSigned, fmtValue, pct } from '../data/format';
import { PartIcon, ValuesIcon } from '../components/TermIcon';
import type { Seat, Snapshot } from '../data/types';

const spring = { type: 'spring', stiffness: 300, damping: 30 } as const;

/** One row's tug of war: the bar grows from the centre toward the side the row favours; the outline is the previous step. */
function Bar({ value, prev, scale, tiny }: { value: number; prev: number | null; scale: number; tiny: number }) {
    const w = (v: number) => Math.min(50, (Math.abs(v) / scale) * 50);
    const over = Math.abs(value) > scale;
    return (
        <span className="relative block h-3.5 rounded-sm bg-ink/80">
            <span className="absolute left-1/2 top-0 bottom-0 w-px bg-line" />
            {prev != null && Math.abs(prev - value) >= tiny && (
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

const isView = (v: ScoreView | LensStep): v is ScoreView => 'source' in v && 'step' in v;

/**
 * Why the score is what it is, in the chosen source's own terms: what each part of the board is worth to each player,
 * the rule for each row, the total, and the chance to win when the source gives one. Bars keep one scale (the source's
 * half-bar, 15 points for Omni v1) and the dashed outline is the previous step, so a change shows as movement.
 * `lens` is the source and step to show (a bare lens step of earlier builds is read as "lens step (evaluator unknown)":
 * six rows, no rules, no chance; left out, the board is estimated with Omni v1; null: no score for this game).
 * `prevLens` is the step before, for the changes: a series step, or (earlier builds) a bare lens step for `prev`; with
 * `prev` and no `prevLens` the previous board is estimated with Omni v1 when the step shown is the estimate, else no
 * change is shown.
 */
export function EdgeBreakdown({ state, prev = null, bots, lens, prevLens = null, previewN = null }: {
    state: Snapshot; prev?: Snapshot | null; bots: Record<Seat, string>; lens?: ScoreView | LensStep | null; prevLens?: ScoreStep | LensStep | null;
    /** set while the pointer previews another step on the timeline: that step's Step.n */
    previewN?: number | null;
}) {
    // the estimate takes card cost from the loaded card data, as the viewer does
    const opts = { cardCost: loadedCardCost };
    const view = lens === undefined ? scoreOfBoard(state, true, opts) : lens === null ? null : isView(lens) ? lens : scoreOfBoard(state, lens, opts);
    // `prev` with no `prevLens` is estimated with Omni v1 only when the step shown is the estimate too: another
    // evaluator's rows are never compared with Omni v1's
    const before = prevLens != null && 'i' in prevLens && 'status' in prevLens ? prevLens
        : prev && (prevLens != null || view?.source.origin === 'estimate') ? scoreOfBoard(prev, prevLens ?? true, opts)?.step ?? null : null;
    const name = (s: Seat) => <span className="truncate" style={{ color: `var(--color-${s})` }} title={`${bots[s]} (${s})`}>{bots[s]}</span>;
    if (!view || view.step.edge == null) {
        const why = !view ? 'No score for this game.' : view.source.error ?? (view.step.status === 'mismatch' ? 'The lens file doesn\'t match this board here.' : 'No value at this step.');
        return (
            <div className="flex flex-col gap-1">
                <span className="eyebrow">{view && !view.source.error ? view.source.label : 'Board score'}</span>
                <span className="text-dim text-[13px]">{why}</span>
            </div>
        );
    }
    const { source, step } = view;
    const unit = source.unit;
    const scales = displayScales(source.kEff, unit);
    const edge = step.edge!;
    const tiny = 10 ** -source.digits / 2;
    const rows = rowsAt(source, step);
    const prevOf = (id: string) => (before?.seats || before?.other ? rowValue(rows.find((r) => r.id === id)!, before).edge : null);
    const lead: Seat | null = edge > scales.lead ? 'p1' : edge < -scales.lead ? 'p2' : null;
    const total = (s: Seat) => step.seats?.[s].total ?? null;
    // no change line after a gap (no values at the previous step): it would print a whole row as the change
    const moved = before?.seats || before?.other ? rows.map((r) => ({ r, d: rowValue(r, step).edge - (prevOf(r.id) ?? 0) })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0] ?? null : null;
    const seatCol = (v: number) => (Math.abs(v) < tiny ? 'var(--color-faint)' : v > 0 ? 'var(--color-p1)' : 'var(--color-p2)');
    const cols = 'grid grid-cols-[2.6rem_minmax(0,1fr)_2.6rem_4.2rem] @md:grid-cols-[minmax(0,12.5rem)_2.8rem_minmax(0,1fr)_2.8rem_4.4rem] items-center gap-x-2';
    const chance = step.p1Win;
    const chanceText = source.chance === 'rough' ? 'Rough guess, not fitted' : source.chance === 'none' ? null : `Chance ${bots.p1} wins`;
    return (
        <div className="@container flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="eyebrow">{source.label}</span>
                <span className="num text-lg font-semibold" style={{ color: 'var(--color-edge)' }} title="The same number as the timeline's score line and the board's centre line">{fmtSigned(edge, unit)}</span>
                <span className="text-dim text-[13px]">{lead ? <>{name(lead)} ahead by {fmtValue(Math.abs(edge), unit)} {source.unitText}</> : 'even board'}</span>
                {previewN != null && <span className="chip !text-fg !border-fg/40 ml-auto">previewing step {previewN}</span>}
            </div>
            {rows.length > 0 && (
                <>
                    <div className={`${cols} text-[10px] text-faint`}>
                        <span className="hidden @md:block" />
                        <span className="text-right" style={{ color: 'var(--color-p2)' }} title={`${bots.p2} (p2)`}>p2</span>
                        <span className="flex justify-between gap-2 px-1 min-w-0"><span className="flex gap-1 min-w-0">◀ {name('p2')}</span><span className="flex gap-1 min-w-0 justify-end">{name('p1')} ▶</span></span>
                        <span style={{ color: 'var(--color-p1)' }} title={`${bots.p1} (p1)`}>p1</span>
                        <span className="text-right">edge</span>
                    </div>
                    <div className={`${cols} gap-y-1 text-[12px]`}>
                        {rows.map((r) => {
                            const v = rowValue(r, step);
                            const p = prevOf(r.id);
                            const d = p == null ? 0 : v.edge - p;
                            const facts = rowFacts(r, state);
                            const what = !facts ? '' : facts.p1 === facts.p2 ? `${facts.p1} each` : `${facts.p2} vs ${facts.p1}`;
                            const cell = (x: number | null, k: string) => (
                                <span key={k} className={`num ${k.endsWith('a') ? 'text-right' : ''}`} style={{ color: r.color }}>{x == null ? '' : fmtValue(x, unit)}</span>
                            );
                            return [
                                <span key={`${r.id}l`} className="col-span-4 @md:col-span-1 min-w-0 leading-tight pt-1 @md:pt-0" title={r.how(step.weights)}>
                                    <span className={`inline-flex items-center gap-1 font-medium${r.group === 'joint' || r.group === 'other' ? ' italic' : ''}`} style={{ color: r.color }}><PartIcon row={r} />{r.label}{r.group === 'joint' ? ' (both sides)' : ''}</span> <span className="text-faint text-[11px]">{what}</span>
                                    <span className="block text-faint text-[10.5px] truncate">{r.rule(step.weights)}</span>
                                </span>,
                                cell(v.p2, `${r.id}a`),
                                <Bar key={`${r.id}b`} value={v.edge} prev={p} scale={scales.halfBar} tiny={tiny} />,
                                cell(v.p1, `${r.id}c`),
                                <span key={`${r.id}d`} className="num text-right whitespace-nowrap">
                                    <span style={{ color: seatCol(v.edge) }}>{fmtSigned(v.edge, unit)}</span>
                                    {Math.abs(d) >= tiny && <span className="text-[10px] ml-1" style={{ color: seatCol(d) }} title="change since the previous step">{d > 0 ? '▲' : '▼'}{fmtValue(Math.abs(d), unit)}</span>}
                                </span>
                            ];
                        })}
                        <span className="col-span-4 @md:col-span-1 pt-1.5 border-t border-line font-semibold text-fg">Total <span className="font-normal text-faint text-[11px]">{step.status === 'estimate' ? 'estimated here' : step.status === 'held' ? `as of step ${step.heldFromN}` : 'from the file'}</span></span>
                        <span className="num text-right pt-1.5 border-t border-line text-fg">{total('p2') == null ? '' : fmtValue(total('p2')!, unit)}</span>
                        <span className="pt-1.5 border-t border-line text-center text-[11px] text-dim num">{total('p1') != null && total('p2') != null ? `${fmtValue(total('p1')!, unit)} − ${fmtValue(total('p2')!, unit)}` : ''}</span>
                        <span className="num pt-1.5 border-t border-line text-fg">{total('p1') == null ? '' : fmtValue(total('p1')!, unit)}</span>
                        <span className="num text-right pt-1.5 border-t border-line font-semibold" style={{ color: 'var(--color-edge)' }}>{fmtSigned(edge, unit)}</span>
                    </div>
                </>
            )}
            {chanceText && chance != null && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-dim">
                    <span title={source.chance === 'rough' ? 'A hand-set curve, not fitted to results; action swings use it when a game has no evaluations' : 'Action swings use this chance when a game has no evaluations'}>
                        {chanceText}: <b className="num" style={{ color: 'var(--color-edge)' }}>{pct(chance)}</b>
                        {source.quality?.brier != null && <span className="text-faint"> · Brier {source.quality.brier.toFixed(3)}{source.quality.games != null ? ` on ${source.quality.games} games` : ''}</span>}
                    </span>
                    <span className="relative h-2 w-40 rounded-full bg-line shrink-0" aria-hidden="true">
                        <span className="absolute left-1/2 -top-0.5 -bottom-0.5 w-px bg-line" />
                        <motion.span className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-bg" initial={false} transition={spring}
                            animate={{ left: `${chance * 100}%` }} style={source.chance === 'rough' ? { background: 'var(--color-bg)', boxShadow: 'inset 0 0 0 2px var(--color-edge)' } : { background: 'var(--color-edge)' }} />
                        <span className="absolute -bottom-3.5 left-0 text-[9px] text-faint num">0%</span>
                        <span className="absolute -bottom-3.5 right-0 text-[9px] text-faint num">100%</span>
                    </span>
                </div>
            )}
            {moved && (
                <div className="text-[11px] text-dim pt-1">
                    {Math.abs(moved.d) < tiny ? 'Nothing on the board score changed this step.' : <>Biggest change this step: <b className="text-fg/90">{moved.r.label}</b> moved {fmtValue(Math.abs(moved.d), unit)} toward {name(moved.d > 0 ? 'p1' : 'p2')}{before?.edge != null ? <> (edge {fmtSigned(edge - before.edge, unit)} in total)</> : null}.</>}
                </div>
            )}
            <p className="text-faint text-[11px] leading-snug m-0">
                {source.description ? `${source.description} ` : ''}Each row is what that part of the board is worth to each player, and the edge is player 1's total minus player 2's.
                {step.status === 'file' ? ' Values come from this game\'s lens file.' : step.status === 'estimate' ? ` This game has no lens file, so the values are estimated from the board${estimateCostFrom(step) === 'card' ? ', with card cost from card data' : ' and leave out card cost'}.` : ''} Turn on card values (<span className="inline-block align-[-3px]"><ValuesIcon on size={14} /></span> next to Card art) to see each card's value on the board, in its row's colour.
            </p>
        </div>
    );
}
