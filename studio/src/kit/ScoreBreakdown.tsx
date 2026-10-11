import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { estimateCostFrom, leftOutTerms, rowFacts, rowsAt, rowValue, type ScoreSeries, type ScoreSource, type ScoreStep } from '../data/score';
import type { Quality } from '../data/lensFile';
import { mapAt } from '../data/calibrate';
import { fmtSigned, fmtValue, pct } from '../data/format';
import { sig3, type RowDef } from '../data/terms';
import { badgeText, ScoreBadge, setLabel } from '../components/ScoreBadge';
import { PartIcon, ValuesIcon } from '../components/TermIcon';
import type { Seat, Snapshot } from '../data/types';

const spring = { type: 'spring', stiffness: 300, damping: 30 } as const;
const SEATS: Seat[] = ['p1', 'p2'];

/** One row's tug of war: the bar grows from the centre toward the side the row favours; the outline is the previous step. */
function Bar({ value, prev, scale, tiny, hatch = false }: { value: number; prev: number | null; scale: number; tiny: number; hatch?: boolean }) {
    const w = (v: number) => Math.min(50, (Math.abs(v) / scale) * 50);
    const over = Math.abs(value) > scale;
    const seat = value >= 0 ? 'var(--color-p1)' : 'var(--color-p2)';
    return (
        <span className="relative block h-3.5 rounded-sm bg-ink/80">
            <span className="absolute left-1/2 top-0 bottom-0 w-px bg-line" />
            {prev != null && Math.abs(prev - value) >= tiny && (
                <span className="absolute top-0 bottom-0 rounded-sm border border-dashed border-fg/30"
                    style={{ left: prev >= 0 ? '50%' : `${50 - w(prev)}%`, width: `${w(prev)}%` }} />
            )}
            {/* a part of no seat (joint, Other) is hatched over a paler seat colour: it sits on no card */}
            <motion.span className={`absolute top-0.5 bottom-0.5 rounded-sm${hatch ? ' hatch' : ''}`} initial={false} transition={spring}
                animate={{ left: value >= 0 ? '50%' : `${50 - w(value)}%`, width: `${w(value)}%` }}
                style={hatch ? { backgroundColor: `color-mix(in oklab, ${seat} 50%, transparent)` } : { background: seat, opacity: 0.85 }} />
            {over && <span className="absolute top-1/2 -translate-y-1/2 text-[9px] leading-none text-fg" style={value > 0 ? { right: 1 } : { left: 1 }}>{value > 0 ? '▶' : '◀'}</span>}
        </span>
    );
}

/** The chance as a dot on a 0-100% track: filled for a fitted or model chance, hollow for a rough guess. */
function ChanceDot({ p, hollow }: { p: number; hollow: boolean }) {
    return (
        <span className="relative h-2 w-40 mb-3 rounded-full bg-line shrink-0" aria-hidden="true">
            <span className="absolute left-1/2 -top-0.5 -bottom-0.5 w-px bg-line" />
            <motion.span className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-bg" initial={false} transition={spring}
                animate={{ left: `${p * 100}%` }} style={hollow ? { background: 'var(--color-bg)', boxShadow: 'inset 0 0 0 2px var(--color-edge)' } : { background: 'var(--color-edge)' }} />
            <span className="absolute -bottom-3.5 left-0 text-[9px] text-faint num">0%</span>
            <span className="absolute -bottom-3.5 right-0 text-[9px] text-faint num">100%</span>
        </span>
    );
}

/** "rounds 4-6" / "rounds 10+" */
const roundsText = (from: number, to: number) => (to >= 99 ? `rounds ${from}+` : from === to ? `round ${from}` : `rounds ${from}-${to}`);

/** "Brier 0.168 on 206 held-out games (a coin flip scores 0.25)"; null when the file measured none. */
export function qualityText(q: Quality | null, coin = true): string | null {
    if (!q || q.brier == null) {
        return null;
    }
    const held = q.heldOut ? ' held-out' : '';
    const on = q.games != null ? `${q.games}${held} games` : q.n != null ? `${q.n}${held} positions` : null;
    return `Brier ${q.brier.toFixed(3)}${on ? ` on ${on}` : ''}${q.heldOut === false ? ' (in-sample)' : ''}${coin ? ' (a coin flip scores 0.25)' : ''}`;
}

/** What the source may look at, in words. */
function seesText(source: ScoreSource, bots: Record<Seat, string>): string {
    switch (source.sees) {
        case 'public': return 'Scores the public board.';
        case 'seat': return `Sees what ${source.perspective ? bots[source.perspective] : 'one seat'} sees, its own hand included.`;
        case 'omniscient': return 'Knows both hands.';
        case 'hindsight': return 'Knows the result.';
    }
}

/** "187 of 187 steps from the file, 3 held, 2 with no value"; null for a one-step series (a lone board). */
function coverageText(series: ScoreSeries): string | null {
    const n = series.steps.length;
    if (n <= 1) {
        return null;
    }
    const c = series.coverage;
    const gaps = c.missing + c.mismatch;
    const parts = [
        c.file ? `${c.file} of ${n} steps from the file` : null,
        c.estimate ? `${c.estimate} of ${n} steps estimated here` : null,
        c.held ? `${c.held} held from the last value` : null,
        gaps ? `${gaps} with no value` : null
    ].filter(Boolean);
    return parts.length ? `${parts.join(', ')}.` : null;
}

/** The weight set's label, or null. */
const setOf = (source: ScoreSource, set: string | null) => (set ? setLabel(source, set) : null);

/** The weights in force, one per line, each marked when it differs from the file's default. */
function weightsTitle(source: ScoreSource, step: ScoreStep): string {
    const w = step.weights;
    if (!w) {
        return 'No weights at this step.';
    }
    const def = source.weights;
    const set = setOf(source, step.weightSet);
    // 4 significant digits, as the Weights tab shows them
    const sig4 = (v: number) => String(Number(v.toPrecision(4))).replace(/^-/, '−');
    const lines = Object.keys(w).map((k) => `${k} ${sig4(w[k])}${def && k in def && def[k] !== w[k] ? ` (file default ${sig4(def[k])})` : ''}`);
    return `Weights in force at this step${set ? ` (${set})` : ''}:\n${lines.join('\n')}`;
}

/** The ablation's cards with the largest values, per side: what the score loses most without them. */
function TopCards({ step, state, rows, unit, bots }: { step: ScoreStep; state: Snapshot; rows: RowDef[]; unit: string; bots: Record<Seat, string> }) {
    const rowOf = (id: string) => rows.find((r) => r.id === id) ?? null;
    const zones = [['ground', 'ground'], ['space', 'space'], ['hand', 'side.hand']] as const;
    const top = (s: Seat) => zones.flatMap(([z, id]) => (step.seats?.[s][z] ?? []).map((v, k) => ({ v, name: state.players[s][z][k]?.n ?? '?', row: rowOf(id), id })))
        .sort((a, b) => Math.abs(b.v) - Math.abs(a.v)).slice(0, 5);
    return (
        <div className="flex flex-col gap-1">
            <span className="text-[11px] text-dim font-medium">Cards that matter most</span>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11.5px]">
                {SEATS.map((s) => (
                    <div key={s} className="flex flex-col gap-0.5 min-w-0">
                        <span className="text-[10px] truncate" style={{ color: `var(--color-${s})` }}>{bots[s]} ({s})</span>
                        {top(s).length === 0 && <span className="text-faint">no cards</span>}
                        {top(s).map((c, k) => (
                            <span key={k} className="flex items-center gap-1 min-w-0" title={`${c.name}: ${fmtValue(c.v, unit)} ${unit} lost without this card`}>
                                <PartIcon row={c.row ?? c.id} />
                                <span className="truncate text-fg/90">{c.name}</span>
                                <span className="num ml-auto" style={{ color: c.row?.color }}>{fmtValue(c.v, unit)}</span>
                            </span>
                        ))}
                    </div>
                ))}
            </div>
        </div>
    );
}

/**
 * Props of the breakdown: the chosen score over the game, the step shown (one of series.steps in a viewer: the
 * playhead or the step hovered on the timeline) and the one before it (null at the first step), the board at that step
 * (for the row facts), the bot names, and `previewN`, the hovered step's Step.n while the pointer previews it.
 */
export interface ScoreBreakdownProps {
    series: ScoreSeries;
    step: ScoreStep;
    prev: ScoreStep | null;
    state: Snapshot;
    bots: Record<Seat, string>;
    previewN?: number | null;
}

/** The breakdown's place when the game has no score at all. */
export function NoScore() {
    return (
        <div className="flex flex-col gap-1">
            <span className="eyebrow">Board score</span>
            <span className="text-dim text-[13px]">No score for this game.</span>
        </div>
    );
}

/**
 * Why the score is what it is, in the chosen source's own terms: what each part of the board is worth to each player,
 * the rule for each row (filled with the weights in force at this step), the total, and the chance to win when the
 * source gives one. Bars keep one scale for the game (the source's half-bar, 1.2 log-odds) and the dashed outline is
 * the previous step, so a change shows as movement. A source that gives a chance only shows the chance and its edge.
 */
export function ScoreBreakdown({ series, step, prev: before, state, bots, previewN = null }: ScoreBreakdownProps) {
    const { source, scales } = series;
    const name = (s: Seat) => <span className="truncate" style={{ color: `var(--color-${s})` }} title={`${bots[s]} (${s})`}>{bots[s]}</span>;
    const preview = previewN != null && <span className="chip !text-fg !border-fg/40 ml-auto">previewing step {previewN}</span>;
    if (step.edge == null) {
        const why = source.error ?? (step.status === 'mismatch' ? 'The file doesn\'t match this board here.' : 'No value at this step.');
        return (
            <div className="flex flex-col gap-1">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="eyebrow">{!source.error ? source.label : 'Board score'}</span>
                    {!source.error && <ScoreBadge source={source} step={step} />}
                    {preview}
                </div>
                <span className="text-dim text-[13px]">{why}</span>
            </div>
        );
    }
    const unit = source.unit;
    const edge = step.edge;
    const badge = badgeText(source, step);
    const tiny = 10 ** -source.digits / 2;
    // term keys this step's values leave out (card cost in an estimate without card data)
    const skip = leftOutTerms(step);
    const rows = rowsAt(source, step);
    // rows need this step's seat values (a held step keeps them only while the board has the same cards)
    const showRows = rows.length > 0 && (step.seats != null || step.other != null);
    const hasPrevRows = !!(before?.seats || before?.other);
    const prevOf = (r: RowDef) => (hasPrevRows ? rowValue(r, before!).edge : null);
    const lead: Seat | null = edge > scales.lead ? 'p1' : edge < -scales.lead ? 'p2' : null;
    const total = (s: Seat) => step.seats?.[s].total ?? null;
    // no change line after a gap (no values at the previous step): it would print a whole row as the change
    const moved = showRows && hasPrevRows ? rows.map((r) => ({ r, d: rowValue(r, step).edge - (prevOf(r) ?? 0) })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0] ?? null : null;
    const seatCol = (v: number) => (Math.abs(v) < tiny ? 'var(--color-faint)' : v > 0 ? 'var(--color-p1)' : 'var(--color-p2)');
    const cols = 'grid grid-cols-[2.6rem_minmax(0,1fr)_2.6rem_4.8rem] @md:grid-cols-[minmax(0,12.5rem)_2.8rem_minmax(0,1fr)_2.8rem_5.4rem] items-center gap-x-2';
    const chance = step.p1Win;
    const calibrated = (source.chance === 'fitted' || source.chance === 'model') && chance != null;
    const dChance = calibrated && before?.p1Win != null ? (chance! - before.p1Win) * 100 : null;
    const chanceMove = dChance != null && Math.round(Math.abs(dChance)) >= 1
        ? <span title={`change in the chance that ${bots.p1} wins since the previous step`}>, chance {dChance > 0 ? '▲' : '▼'}{Math.round(Math.abs(dChance))} pp</span> : null;
    const ablation = source.cardValues === 'ablation';
    const weightsVary = !source.constantWeights || step.weightSet != null;
    const set = setOf(source, step.weightSet);
    // the half-bar in the source's unit, named when no chance gives the bars a meaning of their own
    const barEnd = source.chance === 'none' ? sig3(scales.halfBar) : null;
    const barEndTitle = `A full half-bar is ${sig3(scales.halfBar)} ${source.unitText}: 0.6 × the typical lead of ${sig3(source.typical)} ${source.unitText}${source.typicalFrom === 'percentile' ? ' (the 90th percentile of |edge| in this file, rounded up)' : ''}.`;
    const toward = (d: number) => <>{fmtValue(Math.abs(d), unit)} toward {name(d > 0 ? 'p1' : 'p2')}</>;

    // the chance line: a fitted or model chance is the headline, so this line says where it comes from; a rough guess
    // shows its % here only (never as the headline), with a hollow dot
    let chanceLine: ReactNode = null;
    const q = qualityText(source.quality);
    if (source.chance === 'fitted' && chance != null) {
        const r = source.map?.byRound?.find((e) => e.from <= step.round && step.round <= e.to);
        const fit = step.p1WinFrom === 'map' && r ? ` (fit for ${roundsText(r.from, r.to)})` : '';
        chanceLine = <>From a fitted map{fit}{q ? `, ${q}` : ''}.</>;
    } else if (source.chance === 'model' && chance != null) {
        chanceLine = <>{source.label}'s own chance{step.p1WinFrom === 'logit' ? ' (the logistic of its log-odds edge)' : ''}{q ? `, ${q}` : ''}.</>;
    } else if (source.chance === 'rough' && chance != null && source.map) {
        const m = mapAt(source.map, step.round);
        const curve = m.kind === 'logistic'
            ? m.b === 0 ? `1 / (1 + e^(−${sig3(m.k)} × edge)), the same curve as (1 + tanh(edge / ${sig3(2 / m.k)})) / 2` : `1 / (1 + e^(−(${sig3(m.k)} × edge + ${sig3(m.b)})))`
            : 'a hand-set table from edge to chance';
        chanceLine = <>{curve}.{q ? ` ${q}.` : ''}</>;
    } else if (source.chance === 'none') {
        chanceLine = <>Not calibrated: no chance to win from {source.label}.</>;
    }

    // a row whose weights changed this step: part (or all) of its change is the new weights, not the board
    const reweighed = (r: RowDef) => !!step.weightsChanged && !!before?.weights && !!step.weights && r.uses.some((k) => before.weights![k] !== step.weights![k]);

    // a weight switch: the change splits into what the new weights did to this board and what the move did
    let switchLine: ReactNode = null;
    if (step.weightsChanged) {
        const from = setOf(source, before?.weightSet ?? null);
        const sets = from && set ? ` (${from} → ${set})` : '';
        const epw = step.edgePrevWeights;
        switchLine = epw != null && before?.edge != null
            ? <>Weights changed this step{sets}. The new weights moved the edge {toward(edge - epw)}; the move itself moved it {toward(epw - before.edge)}.</>
            : <>Weights changed this step{sets}: part of this change comes from the new weights, not the board.</>;
    }

    return (
        <div className="@container flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="eyebrow">{source.label}</span>
                <ScoreBadge source={source} step={step} />
                {weightsVary && (
                    <span className="chip !text-[10.5px] cursor-help" title={weightsTitle(source, step)}>{set ? `weights: ${set}` : 'weights change every step'}</span>
                )}
                {preview}
            </div>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                {calibrated ? (
                    <>
                        <span className="text-lg font-semibold" style={{ color: 'var(--color-edge)' }} title={`${badge}\nThe same chance as the timeline's score line`}>
                            Chance {bots.p1} wins <span className="num">{pct(chance!)}</span>
                        </span>
                        <span className="text-dim text-[13px]" title={badge}>edge <span className="num">{fmtSigned(edge, unit)}</span> {source.unitText}</span>
                    </>
                ) : (
                    <>
                        <span className="num text-lg font-semibold" style={{ color: 'var(--color-edge)' }} title={`${badge}\nThe same number as the timeline's score line and the board's centre line`}>{fmtSigned(edge, unit)}</span>
                        <span className="text-dim text-[13px]">{lead ? <>{name(lead)} ahead by {fmtValue(Math.abs(edge), unit)} {source.unitText}</> : 'even board'}</span>
                    </>
                )}
            </div>
            {rows.length === 0 && (
                <span className="text-dim text-[12px]">{source.label} gives a chance only; it doesn't split it into parts.</span>
            )}
            {rows.length > 0 && !showRows && (
                <span className="text-dim text-[12px]">{step.status === 'held' ? `The values as of step ${step.heldFromN} belong to another board, so only the edge is held.` : 'This step gives no values per part.'}</span>
            )}
            {showRows && (
                <>
                    <div className={`${cols} text-[10px] text-faint`}>
                        <span className="hidden @md:block" />
                        <span className="text-right" style={{ color: 'var(--color-p2)' }} title={`${bots.p2} (p2)`}>p2</span>
                        {/* where the bars are narrow the names go; the p1 and p2 columns still name the seats */}
                        <span className="flex justify-between gap-2 px-1 min-w-0"><span className="flex gap-1 min-w-0">◀ <span className="contents @md:@max-xl:hidden">{name('p2')}</span></span><span className="flex gap-1 min-w-0 justify-end"><span className="contents @md:@max-xl:hidden">{name('p1')}</span> ▶</span></span>
                        <span style={{ color: 'var(--color-p1)' }} title={`${bots.p1} (p1)`}>p1</span>
                        <span className="text-right">edge</span>
                    </div>
                    <div className={`${cols} gap-y-1 text-[12px]`}>
                        {rows.map((r) => {
                            const v = rowValue(r, step);
                            const p = prevOf(r);
                            const d = p == null ? 0 : v.edge - p;
                            const facts = rowFacts(r, state);
                            const what = !facts ? '' : facts.p1 === facts.p2 ? `${facts.p1} each` : `${facts.p2} vs ${facts.p1}`;
                            const shared = r.group === 'joint' || r.group === 'other';
                            const rule = r.rule(step.weights, skip) || (step.weights ? '' : 'learned contribution');
                            const note = (s: Seat, x: number) => `${r.label}: ${fmtValue(x, unit)} ${source.unitText} for ${bots[s]} (${s})\n${badge}`;
                            const cell = (x: number | null, s: Seat, k: string) => (
                                <span key={k} className={`num ${s === 'p2' ? 'text-right' : ''}`} style={{ color: r.color }} title={x == null ? undefined : note(s, x)}>{x == null ? '' : fmtValue(x, unit)}</span>
                            );
                            return [
                                <span key={`${r.id}l`} className="col-span-4 @md:col-span-1 min-w-0 leading-tight pt-1 @md:pt-0" title={r.how(step.weights, skip)}>
                                    <span className={`inline-flex items-center gap-1 font-medium${shared ? ' italic' : ''}`} style={{ color: r.color }}><PartIcon row={r} />{r.label}{r.group === 'joint' ? ' (both sides)' : ''}</span> <span className="text-faint text-[11px] whitespace-nowrap">{what}</span>
                                    {rule && <span className="text-faint text-[10.5px] line-clamp-2">{rule}</span>}
                                </span>,
                                cell(v.p2, 'p2', `${r.id}a`),
                                <Bar key={`${r.id}b`} value={v.edge} prev={p} scale={scales.halfBar} tiny={tiny} hatch={shared} />,
                                cell(v.p1, 'p1', `${r.id}c`),
                                <span key={`${r.id}d`} className="num text-right whitespace-nowrap" title={`${r.label}: ${fmtSigned(v.edge, unit)} ${source.unitText} toward p1\n${badge}`}>
                                    <span style={{ color: seatCol(v.edge) }}>{fmtSigned(v.edge, unit)}</span>
                                    {Math.abs(d) >= tiny && <span className="text-[10px] ml-1" style={{ color: seatCol(d) }} title="change since the previous step">{d > 0 ? '▲' : '▼'}{fmtValue(Math.abs(d), unit)}</span>}
                                </span>
                            ];
                        })}
                        <span className="col-span-4 @md:col-span-1 pt-1.5 border-t border-line font-semibold text-fg">Total <span className="font-normal text-faint text-[11px]">{total('p1') == null && total('p2') == null ? 'edge only, no seat totals here' : step.status === 'estimate' ? 'estimated here' : step.status === 'held' ? `as of step ${step.heldFromN}` : 'from the file'}</span></span>
                        <span className="num text-right pt-1.5 border-t border-line text-fg" title={total('p2') == null ? 'This step gives no total for p2' : undefined}>{total('p2') == null ? '' : fmtValue(total('p2')!, unit)}</span>
                        <span className="pt-1.5 border-t border-line text-center text-[11px] text-dim num whitespace-nowrap"><span className="@md:@max-xl:hidden">{total('p1') != null && total('p2') != null ? `${fmtValue(total('p1')!, unit)} − ${total('p2')! < 0 ? `(${fmtValue(total('p2')!, unit)})` : fmtValue(total('p2')!, unit)}` : ''}</span></span>
                        <span className="num pt-1.5 border-t border-line text-fg" title={total('p1') == null ? 'This step gives no total for p1' : undefined}>{total('p1') == null ? '' : fmtValue(total('p1')!, unit)}</span>
                        <span className="num text-right pt-1.5 border-t border-line font-semibold" style={{ color: 'var(--color-edge)' }} title={badge}>{fmtSigned(edge, unit)}</span>
                        {barEnd && [
                            <span key="be0" className="hidden @md:block" />,
                            <span key="be1" />,
                            <span key="be2" className="text-center text-[10px] text-faint num" title={barEndTitle}>bar end = {barEnd} {source.unitText}</span>,
                            <span key="be3" />,
                            <span key="be4" />
                        ]}
                    </div>
                </>
            )}
            {ablation && showRows && <TopCards step={step} state={state} rows={source.rows} unit={unit} bots={bots} />}
            {source.chance === 'rough' && chance != null && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-dim">
                    <span title="A hand-set curve, not fitted to results; action swings use it when a game has no evaluations">
                        Rough guess, not fitted: <b className="num" style={{ color: 'var(--color-edge)' }}>{pct(chance)}</b>
                    </span>
                    <ChanceDot p={chance} hollow />
                </div>
            )}
            {calibrated && chanceLine && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-dim">
                    <ChanceDot p={chance!} hollow={false} />
                    <span className="leading-snug" title="Action swings use this chance when a game has no evaluations">{chanceLine}</span>
                </div>
            )}
            {!calibrated && chanceLine && <div className={`text-[11px] leading-snug ${source.chance === 'none' ? 'text-faint' : 'text-dim'}`}>{chanceLine}</div>}
            {(moved || switchLine || (rows.length === 0 && before?.edge != null)) && (
                <div className="flex flex-col gap-0.5 text-[11px] text-dim pt-1">
                    {moved && (Math.abs(moved.d) < tiny
                        ? <span>Nothing on the board score changed this step.</span>
                        : <span>Biggest change this step: <b className="text-fg/90">{moved.r.label}</b> moved {toward(moved.d)}{reweighed(moved.r) ? ', counting its new weights' : ''}{before?.edge != null ? <> (edge {fmtSigned(edge - before.edge, unit)} in total{chanceMove})</> : chanceMove}.</span>)}
                    {!moved && rows.length === 0 && before?.edge != null && (
                        Math.abs(edge - before.edge) < tiny && !chanceMove
                            ? <span>Nothing changed this step.</span>
                            : <span>This step: edge {fmtSigned(edge - before.edge, unit)} {source.unitText}{chanceMove}.</span>
                    )}
                    {switchLine && <span>{switchLine}</span>}
                </div>
            )}
            <p className="text-faint text-[11px] leading-snug m-0">
                {source.description ? `${source.description} ` : ''}{seesText(source, bots)}
                {ablation ? ' Each card\'s value is what the score loses without that card; the values don\'t add up, and Other (not split) holds the rest.'
                    : rows.length > 0 ? ' Each row is what that part of the board is worth to each player, and the edge is player 1\'s total minus player 2\'s.' : ''}
                {step.status === 'estimate' ? ` This game has no lens file, so the values are estimated from the board${estimateCostFrom(step) === 'card' ? ', with card cost from card data' : ' and leave out card cost'}.` : ''}
                {coverageText(series) ? ` ${coverageText(series)}` : ''}
                {' '}{q ? <span title={source.quality?.data ? `Measured on ${source.quality.data}` : undefined}>Accuracy: {qualityText(source.quality, false)}.</span> : 'Accuracy not measured.'}
                {source.cardValues !== 'none' && <> Turn on card values (<span className="inline-block align-[-3px]"><ValuesIcon on size={14} /></span> next to Card art) to see each card's value on the board, in its row's colour.</>}
            </p>
        </div>
    );
}
