import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ActionIcon } from '../kit/ActionIcon';
import { classInfo, describe, type Action, type SwingFrom } from '../data/actions';
import { Area, ComposedChart, Line, ReferenceArea, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Metrics } from '../data/derive';
import type { EvalPoint } from '../data/evals';
import type { Seat } from '../data/types';
import { isSentinel, type ScoreSeries, type ScoreSource, type ScoreStep } from '../data/score';
import { fmtSigned, pct } from '../data/format';
import { rowColor, sig3 } from '../data/terms';
import { CHANCE_WORD, setLabel, shortSet } from './ScoreBadge';

export type LaneKey = 'llm' | 'base' | 'power' | 'score' | 'cards';
/** A lane key as saved by earlier builds ('edge' was the score lane), or null for an unknown one. */
export const laneKeyOf = (k: string): LaneKey | null => (k === 'edge' ? 'score' : (['llm', 'base', 'power', 'score', 'cards'] as string[]).includes(k) ? k as LaneKey : null);
export const LANES: { key: LaneKey; label: string; hint: string }[] = [
    { key: 'llm', label: 'Evaluations', hint: 'Chance player 1 wins, from each viewpoint; the band spans their disagreement' },
    { key: 'base', label: 'Base HP', hint: 'HP left on each base' },
    { key: 'power', label: 'Board power', hint: 'Total power of each side\'s units' },
    { key: 'score', label: 'Score', hint: 'The chosen score: the chance player 1 wins when it gives one, else its lead for player 1 scaled to this game\'s biggest lead' },
    { key: 'cards', label: 'Hand', hint: 'Cards in hand' }
];

/** The lanes for a game: the score lane takes the source's label, and its hint is the description, unit and chance state. */
export function lanesOf(source: ScoreSource | null | undefined): typeof LANES {
    return LANES.map((l) => (l.key === 'score' && source
        ? { ...l, label: source.label, hint: [source.description, source.unitText, CHANCE_WORD[source.chance]].filter(Boolean).join(' · ') } : l));
}

/** A source drawn as a chance on the % axis (fitted or model); any other is drawn as its points on an axis of its own. */
export const onChanceAxis = (s: ScoreSource | null | undefined) => !!s && !s.error && (s.chance === 'fitted' || s.chance === 'model');

const P1 = '#56c8ff';
const P2 = '#ff5f6d';
const FG = '#dce6fb';
const GOLD = '#f6c454';
const EDGE = '#c4b2ff'; // --color-edge
const PLAYHEAD = '#ffffff';
/** width of the right (%) axis */
const AXIS_W = 34;
/** dash patterns of the Compare lines, one per other source (round caps, so '1 3' reads as dots), none like ROUGH_DASH */
const COMPARE_DASH = ['1 3', '9 3 1 3', '14 4', '1 6'];
/** the uncalibrated score line's dash */
const ROUGH_DASH = '5 3';

/** "Omni v1 (rough guess)", or "Omni v1 (old file) · rough guess" for a label that already ends in brackets. */
const labelWith = (label: string, note: string) => (label.endsWith(')') ? `${label} · ${note}` : `${label} (${note})`);

/** A 14px drawing of what a lane looks like on the chart, for its toggle chip; with a source, the score line is dashed unless it is a chance. */
export function LaneSwatch({ lane, source }: { lane: LaneKey; source?: ScoreSource | null }) {
    const dash = source && !onChanceAxis(source) ? '3 2' : undefined;
    return (
        <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden="true" className="shrink-0">
            {lane === 'llm' && <><path d="M0 8 L5 8 L5 4 L16 4" stroke={FG} strokeWidth="1.6" fill="none" /><path d="M0 10 L16 10" stroke={GOLD} strokeWidth="1.4" /><path d="M0 2 L16 2" stroke={P1} strokeWidth="1.2" strokeDasharray="2 2" /></>}
            {lane === 'base' && <><path d="M0 3 L16 3 L16 12 L0 12 Z" fill={P1} fillOpacity="0.3" /><path d="M0 3 L16 3" stroke={P1} strokeWidth="1.5" /><path d="M0 7 L16 7" stroke={P2} strokeWidth="1.5" /></>}
            {lane === 'power' && <><path d="M0 4 L16 4" stroke={P1} strokeWidth="1.4" strokeDasharray="3 2" /><path d="M0 9 L16 9" stroke={P2} strokeWidth="1.4" strokeDasharray="3 2" /></>}
            {lane === 'score' && <><rect x="0" y="1" width="8" height="5" fill={P1} fillOpacity="0.55" /><rect x="8" y="6" width="8" height="5" fill={P2} fillOpacity="0.55" /><path d="M0 3 L8 3 L8 9 L16 9" stroke={EDGE} strokeWidth="1.5" strokeDasharray={dash} fill="none" /></>}
            {lane === 'cards' && <><path d="M0 4 L16 4" stroke={P1} strokeOpacity="0.7" strokeWidth="1" /><path d="M0 9 L16 9" stroke={P2} strokeOpacity="0.7" strokeWidth="1" /></>}
        </svg>
    );
}

/** A step's board facts plus the chosen score's edge there (null at a gap). */
export type MomentumRow = Metrics & { score: number | null };

/**
 * The timeline's props: board facts per step (`data`), the chosen score resolved over the game (`series`, null when
 * the game has no score) and, with Compare on, the other fitted or model sources to overlay (`others`, empty when off).
 */
export interface MomentumProps {
    data: Metrics[];
    series: ScoreSeries | null;
    others?: ScoreSeries[];
    rounds: { step: number; round: number }[];
    step: number;
    lanes: LaneKey[];
    bots: Record<Seat, string>;
    evals?: Map<number, EvalPoint>;
    height?: number;
    /** pivotal actions to pin above the curves */
    markers?: Action[];
    /** Step.n per step index, for labels */
    stepN?: (i: number) => number;
    onSeek: (n: number) => void;
    /** the pointer is over this step of the chart (null when it leaves): lets the page preview that step */
    onHover?: (step: number | null) => void;
}

/** How each evaluation curve is drawn; the analyst panel's swatches use the same. */
export const EVAL_LINES = [
    { key: 'p1_subjective', dash: '5 3', color: P1, width: 1.6 },
    { key: 'p2_subjective', dash: '5 3', color: P2, width: 1.6 },
    { key: 'objective_state', dash: undefined, color: FG, width: 2.2 },
    { key: 'objective_hindsight', dash: undefined, color: GOLD, width: 2 }
] as const;

/** Who each eval line is, in bot names: every curve is the chance player 1 wins, seen from a viewpoint. */
export function evalLabels(bots: Record<Seat, string>): Record<string, string> {
    return { p1_subjective: `${bots.p1}'s own view`, p2_subjective: `${bots.p2}'s own view`, objective_state: 'sees both hands', objective_hindsight: 'hindsight' };
}

function useWidth(ref: RefObject<HTMLElement | null>) {
    const [w, setW] = useState(800);
    useEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') {
            return undefined;
        }
        const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
        ro.observe(el);
        return () => ro.disconnect();
    }, [ref]);
    return w;
}

/** Where a step's value comes from, for tooltips. */
function statusText(st: ScoreStep): string | null {
    switch (st.status) {
        case 'file': return 'from file';
        case 'estimate': return 'estimated here';
        case 'held': return `as of step ${st.heldFromN}`;
        default: return null;
    }
}

/** "proven win for heuristic (solver: and-or), 3 windows from the end" */
export function provenText(p: NonNullable<ScoreStep['proven']>, bots: Record<Seat, string>): string {
    const w = p.inWindows;
    return `proven win for ${bots[p.seat]}${p.by ? ` (solver: ${p.by})` : ''}${w != null ? `, ${w} window${w === 1 ? '' : 's'} from the end` : ''}`;
}

/** The weights that differ between two steps: "hand 1.8 → 2". */
function weightChanges(a: ScoreStep['weights'], b: ScoreStep['weights']): string {
    if (!a || !b) {
        return '';
    }
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k])
        .map((k) => `${k} ${a[k] == null ? '–' : sig3(a[k])} → ${b[k] == null ? '–' : sig3(b[k])}`).join(', ');
}

/** What a weight switch tick says: the set switched to (or the weights that changed), and how much the switch itself moved the score. */
function switchText(series: ScoreSeries, i: number, stepN: (i: number) => number): string {
    const { source, steps } = series;
    const st = steps[i];
    let prev: ScoreStep | undefined;
    for (let k = i - 1; k >= 0 && !prev; k--) {
        prev = steps[k].weights ? steps[k] : undefined;
    }
    const what = st.weightSet ? `weights switch to ${setLabel(source, st.weightSet)}` : `weights change: ${weightChanges(prev?.weights ?? null, st.weights)}`;
    const moved = st.edge != null && st.edgePrevWeights != null ? `; the switch itself moved the score by ${fmtSigned(st.edge - st.edgePrevWeights, source.unit)} ${source.unitText}` : '';
    return `${what}, at step ${stepN(i)}${moved}`;
}

/** The chosen score at one step, for the chart's tooltip. */
function ScoreTip({ source, st, chance }: { source: ScoreSource; st: ScoreStep; chance: boolean }) {
    if (st.status === 'missing' || st.status === 'mismatch') {
        return <div className="text-faint">{source.label}: {st.status === 'missing' ? 'no value at this step' : 'file doesn\'t match this board here'}</div>;
    }
    const where = [st.weightSet ? `weights ${shortSet(source, st.weightSet)}` : null, statusText(st)];
    if (chance && st.p1Win != null) {
        return (
            <>
                <div className="num"><span style={{ color: EDGE }}>{pct(st.p1Win)}</span> <span className="text-faint">{labelWith(source.label, CHANCE_WORD[source.chance])}</span></div>
                <div className="text-faint text-[11px]">{[st.edge != null ? `edge ${fmtSigned(st.edge, source.unit)} ${source.unitText}` : null, ...where].filter(Boolean).join(' · ')}</div>
            </>
        );
    }
    if (st.edge == null) {
        return null;
    }
    const word = source.chance === 'rough' && st.p1Win != null ? `rough guess ${pct(st.p1Win)}` : CHANCE_WORD[source.chance];
    return (
        <>
            <div className="num"><span style={{ color: EDGE }}>{fmtSigned(st.edge, source.unit)}</span> <span className="text-faint">{source.unitText} ({word})</span></div>
            <div className="text-faint text-[11px]">{[source.label, ...where.filter((w) => !w || !source.label.includes(w))].filter(Boolean).join(' · ')}</div>
        </>
    );
}

/** The game at a glance: chosen curves over every decision, round bands, and the playhead. Click or drag to seek. */
export function Momentum({ data: facts, series, others = [], rounds, step, lanes, bots, onSeek, onHover, evals, height = 160, markers = [], stepN = (i) => i }: MomentumProps) {
    // a refused file draws nothing; an edge at a search sentinel (never a real lead) never reaches an axis
    const live = series && !series.source.error ? series : null;
    const src = live?.source ?? null;
    const chance = onChanceAxis(src);
    const curve = src && src.sampling !== 'every-step' ? 'stepAfter' : 'linear';
    const cmp = useMemo(() => others.filter((o) => o !== live && o.source !== src && onChanceAxis(o.source)), [others, live, src]);
    const data: MomentumRow[] = useMemo(() => facts.map((m, i) => {
        const e = live?.steps[i]?.edge;
        return { ...m, score: e == null || isSentinel(e) ? null : e };
    }), [facts, live]);
    const typical = src?.typical ?? 1;
    const box = useRef<HTMLDivElement>(null);
    const width = useWidth(box);
    const last = Math.max(1, data.length - 1);
    const hasEvals = !!evals?.size;
    const show = (k: LaneKey) => lanes.includes(k);
    const showScore = show('score') && !!live;
    const labels = evalLabels(bots);
    // the score in its unit, scaled to this game's biggest lead (at least the source's typical lead), so a lopsided game doesn't pin the line to the edge
    const scale = useMemo(() => Math.max(typical, ...data.map((m) => (m.score == null ? 0 : Math.abs(m.score)))), [data, typical]);
    const rows = useMemo(() => {
        // evals exist at checkpoints only: the lines step between them, and the tooltip carries the latest one forward
        let held: (EvalPoint & { at: number }) | null = null;
        return data.map((m, i) => {
            const e = evals?.get(i);
            if (e) {
                held = { ...e, at: i };
            }
            const vs = e ? [e.p1_subjective, e.p2_subjective, e.objective_state, e.objective_hindsight].filter((v): v is number => v != null) : [];
            const sn = chance || m.score == null ? null : m.score / scale;
            const p = chance ? live?.steps[i]?.p1Win ?? null : null;
            return {
                ...m,
                sn,
                snUp: sn == null ? null : Math.max(0, sn),
                snDown: sn == null ? null : Math.min(0, sn),
                pw: p,
                pUp: p == null ? null : Math.max(0.5, p),
                pDown: p == null ? null : Math.min(0.5, p),
                cmp: cmp.map((o) => o.steps[i]?.p1Win ?? null),
                ...(e ? { p1_subjective: e.p1_subjective, p2_subjective: e.p2_subjective, objective_state: e.objective_state, objective_hindsight: e.objective_hindsight, band: vs.length ? [Math.min(...vs), Math.max(...vs)] : undefined } : {}),
                held
            };
        });
    }, [data, evals, scale, chance, live, cmp]);
    type Row = (typeof rows)[number];
    // gaps (missing or mismatched steps) between the first and last step with a value, as runs
    const gaps = useMemo(() => {
        const out: { from: number; to: number }[] = [];
        const steps = live?.steps ?? [];
        const valued = (s: ScoreStep) => s.status !== 'missing' && s.status !== 'mismatch';
        const first = steps.findIndex(valued);
        const end = steps.length - 1 - [...steps].reverse().findIndex(valued);
        for (let i = Math.max(0, first); first >= 0 && i <= end; i++) {
            if (valued(steps[i])) {
                continue;
            }
            const run = out[out.length - 1];
            if (run && run.to === i - 1) {
                run.to = i;
            } else {
                out.push({ from: i, to: i });
            }
        }
        return out;
    }, [live]);
    const switches = useMemo(() => live?.steps.filter((s) => s.weightsChanged).map((s) => s.i) ?? [], [live]);
    const rightAxis = (hasEvals && show('llm')) || (showScore && chance) || cmp.length > 0;
    const inset = rightAxis ? AXIS_W : 0;
    const plotW = Math.max(1, width - inset);
    /** CSS left of step i inside the plot (the right axis takes its width off the right) */
    const xAt = (i: number) => `calc((100% - ${inset}px) * ${i / last})`;
    // proven steps as pins, one per 5px per seat
    const pins = useMemo(() => {
        const lastX: Record<Seat, number> = { p1: -99, p2: -99 };
        return (live?.steps ?? []).filter((s) => {
            if (!s.proven) {
                return false;
            }
            const x = (s.i / last) * plotW;
            if (x - lastX[s.proven.seat] < 5) {
                return false;
            }
            lastX[s.proven.seat] = x;
            return true;
        });
    }, [live, last, plotW]);
    const bands = useMemo(() => rounds.map((r, i) => ({ ...r, end: rounds[i + 1]?.step ?? last })), [rounds, last]);
    // round labels: drop ones that would sit closer than 14px to the previous one
    const roundLabels = useMemo(() => {
        let prevX = -99;
        return bands.filter((b) => {
            const x = (b.step / last) * plotW;
            if (x - prevX < 14) {
                return false;
            }
            prevX = x;
            return true;
        });
    }, [bands, last, plotW]);
    const seekAt = (clientX: number) => {
        const r = box.current?.getBoundingClientRect();
        if (r) {
            onSeek(Math.round(Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width - inset))) * last));
        }
    };
    const centred = showScore || (hasEvals && show('llm'));
    const cur = rows[step];
    const topText = scale >= 10 ? scale.toFixed(0) : String(Number(scale.toPrecision(2)));
    const unitWord = src?.unitText ?? 'points';
    // the chosen score's line on its own axis, named in the legend next to the % lines so it isn't read against them
    const ownAxis = <span className="inline-flex items-center gap-1.5"><DashSample dash={ROUGH_DASH} main />{labelWith(src?.label ?? '', `${unitWord}, own axis`)}</span>;
    return (
        <div className="flex flex-col">
            {markers.length > 0 && <Markers markers={markers} last={last} step={step} bots={bots} onSeek={onSeek} width={plotW} inset={inset} stepN={stepN} rounds={data.map((d) => d.round)} series={live} />}
            <div className="relative select-none touch-none" style={{ height }} ref={box}
                onPointerDown={(e) => {
                    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                    seekAt(e.clientX);
                }}
                onPointerMove={(e) => e.buttons === 1 && seekAt(e.clientX)}>
                <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={rows} margin={{ top: 8, right: 0, bottom: 0, left: 0 }}
                        onMouseMove={(st) => onHover?.(typeof st?.activeLabel === 'number' ? st.activeLabel : st?.activeLabel != null ? Number(st.activeLabel) : null)}
                        onMouseLeave={() => onHover?.(null)}>
                        {bands.map((b, i) => i % 2 === 1 && <ReferenceArea key={b.step} x1={b.step} x2={b.end} yAxisId="v" fill="#ffffff" fillOpacity={0.025} strokeOpacity={0} />)}
                        <XAxis dataKey="step" type="number" domain={[0, last]} hide />
                        <YAxis yAxisId="v" hide domain={[0, 'dataMax + 4']} />
                        <YAxis yAxisId="e" hide domain={[-1.05, 1.05]} />
                        <YAxis yAxisId="p" orientation="right" hide={!rightAxis} domain={[-0.025, 1.025]} ticks={[0, 0.25, 0.5, 0.75, 1]} width={AXIS_W}
                            tickFormatter={(v: number) => `${Math.round(v * 100)}%`} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                        {markers.map((m) => <ReferenceLine key={`stem${m.index}`} yAxisId="v" x={m.index} stroke="#ffffff" strokeOpacity={0.12} />)}
                        {showScore && gaps.map((g) => (
                            <ReferenceArea key={`gap${g.from}`} yAxisId="e" x1={Math.max(0, g.from - 0.5)} x2={Math.min(last, g.to + 0.5)} fill={EDGE} fillOpacity={0.07} strokeOpacity={0} />
                        ))}
                        {show('base') && <Area yAxisId="v" type="monotone" dataKey="base1" name={`${bots.p1} base`} stroke={P1} strokeWidth={2} fill="url(#g1)" isAnimationActive={false} dot={false} />}
                        {show('base') && <Area yAxisId="v" type="monotone" dataKey="base2" name={`${bots.p2} base`} stroke={P2} strokeWidth={2} fill="url(#g2)" isAnimationActive={false} dot={false} />}
                        {/* the middle and the quarter guides: 0 and ±half the scale on the points axis, the same heights as 50%, 75% and 25% on the % axis */}
                        {centred && <ReferenceLine yAxisId="e" y={0} stroke="#56658a" strokeDasharray="2 4" />}
                        {centred && <ReferenceLine yAxisId="e" y={0.5} stroke="#56658a" strokeOpacity={0.45} strokeDasharray="1 5" />}
                        {centred && <ReferenceLine yAxisId="e" y={-0.5} stroke="#56658a" strokeOpacity={0.45} strokeDasharray="1 5" />}
                        {showScore && !chance && <Area yAxisId="e" type={curve} dataKey="snUp" baseValue={0} stroke="none" fill={P1} fillOpacity={0.22} isAnimationActive={false} dot={false} legendType="none" tooltipType="none" />}
                        {showScore && !chance && <Area yAxisId="e" type={curve} dataKey="snDown" baseValue={0} stroke="none" fill={P2} fillOpacity={0.22} isAnimationActive={false} dot={false} legendType="none" tooltipType="none" />}
                        {showScore && !chance && <Line yAxisId="e" type={curve} dataKey="sn" name={src!.label} stroke={EDGE} strokeWidth={1.8} strokeDasharray={ROUGH_DASH} dot={false} isAnimationActive={false} />}
                        {showScore && chance && <Area yAxisId="p" type={curve} dataKey="pUp" baseValue={0.5} stroke="none" fill={P1} fillOpacity={0.22} isAnimationActive={false} dot={false} legendType="none" tooltipType="none" />}
                        {showScore && chance && <Area yAxisId="p" type={curve} dataKey="pDown" baseValue={0.5} stroke="none" fill={P2} fillOpacity={0.22} isAnimationActive={false} dot={false} legendType="none" tooltipType="none" />}
                        {showScore && chance && <Line yAxisId="p" type={curve} dataKey="pw" name={src!.label} stroke={EDGE} strokeWidth={1.8} dot={false} isAnimationActive={false} />}
                        {cmp.map((o, k) => (
                            <Line key={`cmp${o.source.key}`} yAxisId="p" type={o.source.sampling !== 'every-step' ? 'stepAfter' : 'linear'} dataKey={(r: Row) => r.cmp[k]} name={o.source.label}
                                stroke={EDGE} strokeOpacity={0.55} strokeWidth={1.3} strokeLinecap="round" strokeDasharray={COMPARE_DASH[k % COMPARE_DASH.length]} dot={false} activeDot={false} isAnimationActive={false} />
                        ))}
                        {show('power') && <Line yAxisId="v" type="stepAfter" dataKey="power1" name={`${bots.p1} power`} stroke={P1} strokeDasharray="4 3" strokeWidth={1.5} dot={false} isAnimationActive={false} />}
                        {show('power') && <Line yAxisId="v" type="stepAfter" dataKey="power2" name={`${bots.p2} power`} stroke={P2} strokeDasharray="4 3" strokeWidth={1.5} dot={false} isAnimationActive={false} />}
                        {show('cards') && <Line yAxisId="v" type="stepAfter" dataKey="hand1" name={`${bots.p1} hand`} stroke={P1} strokeOpacity={0.6} strokeWidth={1} dot={false} isAnimationActive={false} />}
                        {show('cards') && <Line yAxisId="v" type="stepAfter" dataKey="hand2" name={`${bots.p2} hand`} stroke={P2} strokeOpacity={0.6} strokeWidth={1} dot={false} isAnimationActive={false} />}
                        {hasEvals && show('llm') && <Area yAxisId="p" type="stepAfter" dataKey="band" name="disagreement" stroke="none" fill={FG} fillOpacity={0.16} connectNulls isAnimationActive={false} />}
                        {hasEvals && show('llm') && EVAL_LINES.map((l) => (
                            <Line key={l.key} yAxisId="p" type="stepAfter" dataKey={l.key} name={labels[l.key]} stroke={l.color} strokeWidth={l.width} strokeDasharray={l.dash} connectNulls
                                dot={{ r: 1.8, strokeWidth: 0, fill: l.color }} activeDot={false} isAnimationActive={false} />
                        ))}
                        <ReferenceLine yAxisId="v" x={step} stroke={PLAYHEAD} strokeOpacity={0.85} strokeWidth={1.5} />
                        {showScore && !chance && cur && cur.score != null && cur.sn != null && (
                            <ReferenceDot yAxisId="e" x={step} y={cur.sn} r={3.5} fill={EDGE} stroke="#060a13" strokeWidth={1.5}
                                label={<PlayheadLabel text={fmtSigned(cur.score, src!.unit)} left={step > last * 0.9} />} />
                        )}
                        {showScore && chance && cur && cur.pw != null && (
                            <ReferenceDot yAxisId="p" x={step} y={cur.pw} r={3.5} fill={EDGE} stroke="#060a13" strokeWidth={1.5}
                                label={<PlayheadLabel text={pct(cur.pw)} left={step > last * 0.9} />} />
                        )}
                        <defs>
                            <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={P1} stopOpacity={0.4} /><stop offset="1" stopColor={P1} stopOpacity={0} /></linearGradient>
                            <linearGradient id="g2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={P2} stopOpacity={0.4} /><stop offset="1" stopColor={P2} stopOpacity={0} /></linearGradient>
                        </defs>
                        <Tooltip cursor={{ stroke: '#dce6fb33' }} isAnimationActive={false} content={({ active, label }) => {
                            const i = Number(label);
                            const r = active && Number.isFinite(i) ? rows[i] : null;
                            if (!r) {
                                return null;
                            }
                            const st = live?.steps[i];
                            return (
                                <div className="rounded-[10px] border border-line bg-panel/95 px-3 py-2 text-[12px] leading-relaxed shadow-xl max-w-[340px]">
                                    <div className="text-dim">step {stepN(i)} · round {r.round}</div>
                                    <div className="num"><span className="text-p1">{r.base1}</span> <span className="text-faint">vs</span> <span className="text-p2">{r.base2}</span> <span className="text-faint">base HP</span></div>
                                    {showScore && st && <ScoreTip source={src!} st={st} chance={chance} />}
                                    {showScore && st?.proven && <div style={{ color: GOLD }}>{provenText(st.proven, bots)}</div>}
                                    {cmp.length > 0 && (
                                        <div className="mt-1 border-t border-line pt-1">
                                            <div className="text-faint text-[11px]">chance {bots.p1} wins, other scores</div>
                                            {cmp.map((o, k) => (
                                                <div key={o.source.key} className="num flex items-center gap-1.5">
                                                    <DashSample dash={COMPARE_DASH[k % COMPARE_DASH.length]} />
                                                    <span className="text-fg">{r.cmp[k] == null ? '–' : pct(r.cmp[k]!)}</span> <span className="text-faint">{labelWith(o.source.label, CHANCE_WORD[o.source.chance])}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    {hasEvals && r.held && (
                                        <div className="mt-1 border-t border-line pt-1">
                                            <div className="text-faint text-[11px]">chance {bots.p1} wins{r.held.at !== i ? `, as of step ${stepN(r.held.at)}` : ''}</div>
                                            {EVAL_LINES.map((l) => r.held![l.key] != null && (
                                                <div key={l.key} className="num flex items-center gap-1.5">
                                                    <span className="inline-block w-3 border-t-2" style={{ borderColor: l.color, borderTopStyle: l.dash ? 'dashed' : 'solid' }} />
                                                    <span className="text-fg">{Math.round(r.held![l.key]! * 100)}%</span> <span className="text-faint">{labels[l.key]}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        }} />
                    </ComposedChart>
                </ResponsiveContainer>
                {centred && (
                    <div className="pointer-events-none absolute inset-y-0 left-1 flex flex-col justify-between pt-2 pb-4 text-[10px] text-faint">
                        <span>▲ {bots.p1} ahead{showScore && !chance && <span className="num"> · top +{topText} {unitWord}</span>}</span>
                        <span>▼ {bots.p2} ahead{showScore && !chance && <span className="num"> · bottom −{topText}</span>}</span>
                    </div>
                )}
                {showScore && pins.map((s) => (
                    <span key={`pin${s.i}`} className="absolute -translate-x-1/2" title={`${provenText(s.proven!, bots)} · step ${stepN(s.i)}`}
                        style={{ left: xAt(s.i), ...(s.proven!.seat === 'p1' ? { top: 0 } : { bottom: 14 }) }}>
                        <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true" style={{ filter: `drop-shadow(0 0 3px ${GOLD})` }}>
                            <path d={s.proven!.seat === 'p1' ? 'M0 0 L10 0 L5 9 Z' : 'M0 10 L10 10 L5 1 Z'} fill={GOLD} />
                        </svg>
                    </span>
                ))}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-4">
                    {roundLabels.map((b) => (
                        <span key={b.step} className="absolute bottom-0 pl-[3px] text-[10px] text-faint num" style={{ left: xAt(b.step) }}>{b.round}</span>
                    ))}
                    {showScore && switches.length <= 24 && switches.map((i) => (
                        <span key={`sw${i}`} className="pointer-events-auto absolute bottom-0 h-3 w-2 -translate-x-1/2 flex justify-center" style={{ left: xAt(i) }} title={switchText(live!, i, stepN)}>
                            <span className="h-full w-[1.5px]" style={{ background: EDGE }} />
                        </span>
                    ))}
                </div>
            </div>
            {showScore && switches.length > 0 && <WeightsStrip series={live!} last={last} inset={inset} stepN={stepN} />}
            {cmp.length > 0 && (
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 pt-1 text-[11px] text-dim" aria-label="Compare legend">
                    {showScore && !chance && ownAxis}
                    <span className="text-faint">Chance {bots.p1} wins:</span>
                    {showScore && chance && <span className="inline-flex items-center gap-1.5"><DashSample />{labelWith(src!.label, CHANCE_WORD[src!.chance])}</span>}
                    {cmp.map((o, k) => (
                        <span key={o.source.key} className="inline-flex items-center gap-1.5"><DashSample dash={COMPARE_DASH[k % COMPARE_DASH.length]} />{labelWith(o.source.label, CHANCE_WORD[o.source.chance])}</span>
                    ))}
                </div>
            )}
            {hasEvals && show('llm') && (
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 pt-1 text-[11px] text-dim" aria-label="Evaluation legend">
                    {showScore && !chance && !cmp.length && ownAxis}
                    <span className="text-faint">Chance {bots.p1} wins:</span>
                    {EVAL_LINES.map((l) => (
                        <span key={l.key} className="inline-flex items-center gap-1.5">
                            <span className="inline-block w-4 border-t-2" style={{ borderColor: l.color, borderTopStyle: l.dash ? 'dashed' : 'solid' }} />{labels[l.key]}
                        </span>
                    ))}
                    <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 h-2 rounded-sm" style={{ background: FG, opacity: 0.25 }} />where they disagree</span>
                </div>
            )}
        </div>
    );
}

/** A short line in the score's violet: full for the chosen score (solid, or dashed when `main`), lighter for a Compare line. */
function DashSample({ dash, main }: { dash?: string; main?: boolean }) {
    const full = main || !dash;
    return (
        <svg width="16" height="4" viewBox="0 0 16 4" aria-hidden="true" className="shrink-0">
            <path d="M1 2 L15 2" stroke={EDGE} strokeOpacity={full ? 1 : 0.55} strokeWidth={full ? 2 : 1.5} strokeLinecap={full ? 'butt' : 'round'} strokeDasharray={dash} />
        </svg>
    );
}

/** The playhead's value next to its dot, on a plate so the lines under it don't hide it. */
function PlayheadLabel({ text, left, viewBox }: { text: string; left: boolean; viewBox?: { x?: number; y?: number; width?: number; height?: number } }) {
    const cx = (viewBox?.x ?? 0) + (viewBox?.width ?? 0) / 2;
    const cy = (viewBox?.y ?? 0) + (viewBox?.height ?? 0) / 2;
    const w = text.length * 6.7 + 6;
    const x = left ? cx - 7 - w : cx + 7;
    return (
        <g pointerEvents="none">
            <rect x={x} y={cy - 8} width={w} height={16} rx={3} fill="var(--color-bg)" fillOpacity={0.85} />
            <text x={x + 3} y={cy + 4} fill={EDGE} fontSize={11} fontFamily="IBM Plex Mono, monospace">{text}</text>
        </g>
    );
}

/**
 * The weights in force under the timeline, when they change during the game: labelled segments for named weight
 * sets, else a sparkline per weight that changes (up to 4), relative to its first value and coloured by the row that reads it.
 */
function WeightsStrip({ series, last, inset, stepN }: { series: ScoreSeries; last: number; inset: number; stepN: (i: number) => number }) {
    const { source, steps } = series;
    const sets = useMemo(() => {
        // runs of one set; a step with no set (a gap) keeps the previous one
        const out: { set: string; from: number; to: number }[] = [];
        for (const s of steps) {
            const run = out[out.length - 1];
            if (s.weightSet && s.weightSet !== run?.set) {
                if (run) {
                    run.to = s.i;
                }
                out.push({ set: s.weightSet, from: s.i, to: last });
            }
        }
        return out;
    }, [steps, last]);
    const lines = useMemo(() => {
        const first = steps.find((s) => s.weights)?.weights;
        if (!first || sets.length) {
            return [];
        }
        const keys = [...new Set(steps.flatMap((s) => Object.keys(s.weights ?? {})))];
        const ratio = (k: string, v: number) => (first[k] ? v / first[k] : v);
        return keys.map((k) => {
            const vs = steps.map((s) => (s.weights && Number.isFinite(s.weights[k]) ? s.weights[k] : null));
            const spread = Math.max(0, ...vs.map((v) => (v == null ? 0 : Math.abs(ratio(k, v) - ratio(k, first[k] ?? v)))));
            const end = [...vs].reverse().find((v) => v != null) ?? null;
            const row = source.rows.find((r) => r.uses.includes(k));
            return { k, vs: vs.map((v) => (v == null ? null : ratio(k, v))), from: first[k] ?? null, end, spread, color: row?.color ?? rowColor(`extra.${k}`), row: row?.label ?? null };
        }).filter((l) => l.spread > 1e-9).sort((a, b) => b.spread - a.spread).slice(0, 4);
    }, [steps, sets, source]);
    const H = 22;
    if (sets.length) {
        return (
            <div className="relative mt-1 h-4 text-[10px]" style={{ marginRight: inset }} aria-label="Weights">
                {sets.map((r, k) => {
                    const label = setLabel(source, r.set);
                    return (
                        <span key={`${r.set}${r.from}`} className={`absolute inset-y-0 flex items-center overflow-hidden whitespace-nowrap border-l border-line px-1 text-dim ${k % 2 ? 'bg-white/[0.07]' : 'bg-white/[0.035]'}`}
                            style={{ left: `${(r.from / last) * 100}%`, width: `${((r.to - r.from) / last) * 100}%` }} title={`weights ${label}: steps ${stepN(r.from)}-${stepN(k < sets.length - 1 ? r.to - 1 : r.to)}`}>
                            {k === 0 ? `weights · ${label}` : label}
                        </span>
                    );
                })}
            </div>
        );
    }
    if (!lines.length) {
        return null;
    }
    const all = lines.flatMap((l) => l.vs.filter((v): v is number => v != null));
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    const y = (v: number) => 2 + (H - 4) * (hi === lo ? 0.5 : 1 - (v - lo) / (hi - lo));
    // held between steps, broken at a step with no weights
    const path = (vs: (number | null)[]) => {
        let d = '';
        let prev: number | null = null;
        vs.forEach((v, i) => {
            if (v == null) {
                prev = null;
                return;
            }
            d += prev == null ? `M${i} ${y(v)}` : `H${i} V${y(v)}`;
            prev = v;
        });
        return prev == null ? d : `${d} H${last}`;
    };
    return (
        <div className="mt-1 flex flex-col" aria-label="Weights">
            <svg width="100%" height={H} viewBox={`0 0 ${last} ${H}`} preserveAspectRatio="none" style={{ width: `calc(100% - ${inset}px)` }} aria-hidden="true">
                <rect x="0" y="0" width={last} height={H} fill="#ffffff" fillOpacity={0.025} />
                {lines.map((l) => <path key={l.k} d={path(l.vs)} fill="none" strokeWidth={1.5} vectorEffect="non-scaling-stroke" style={{ stroke: l.color }} />)}
            </svg>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 pt-0.5 text-[11px] text-dim">
                <span className="text-faint">Weights per step:</span>
                {lines.map((l) => (
                    <span key={l.k} className="inline-flex items-center gap-1.5 num" title={l.row ? `used by ${l.row}` : undefined}>
                        <span className="inline-block w-3 border-t-2" style={{ borderColor: l.color }} />{l.k} {l.from == null ? '–' : sig3(l.from)} → {l.end == null ? '–' : sig3(l.end)}
                    </span>
                ))}
            </div>
        </div>
    );
}

/** A pivotal play's swing in words, from what it was measured with: "+6.0 pp" and "from Omni v1 (rough guess)". */
export function swingWords(m: Action, bot: string, series: ScoreSeries | null): { amount: string; from: string; text: string } {
    const f: SwingFrom | undefined = m.swingFrom;
    const v = `${m.swing >= 0 ? '+' : '−'}${Math.abs(m.swing).toFixed(1)}`;
    const sw = f?.weights;
    const tail = sw?.switch === 'included' ? '; includes a weight switch'
        : sw?.switch === 'removed' && sw.by != null ? `; the weight switch itself moved the score by ${sw.by >= 0 ? '+' : '−'}${Math.abs(sw.by).toFixed(1)} pp; not counted` : '';
    if (f && !f.evals && f.chance === 'none') {
        // the evaluator's own name ("Aggro"), not the seat-qualified label
        const own = series?.source.key === f.key ? series.source : null;
        const from = `sized from ${own?.lens?.evaluator.label ?? f.label}'s ${own?.unitText ?? 'points'}; not a chance${tail}`;
        return { amount: v, from, text: `${v} for ${bot}, ${from}` };
    }
    const from = (!f ? 'from the evaluations' : f.evals ? `from the evaluations, shared by ${f.label}'s changes` : `from ${labelWith(f.label, CHANCE_WORD[f.chance])}`) + tail;
    return { amount: `${v} pp`, from, text: `${v} pp of ${bot}'s chance to win, ${from}` };
}

/**
 * Pivotal plays pinned over the timeline at their step, each with a thin stem down the chart. Markers are placed in up
 * to three rows so none sits closer than 30px to another in its row; ones that don't fit are counted at the end.
 */
function Markers({ markers, last, step, bots, onSeek, width, inset, stepN, rounds, series }: {
    markers: Action[]; last: number; step: number; bots: Record<Seat, string>; onSeek: (n: number) => void;
    /** the plot's width (the chart's minus the right axis, `inset`) */
    width: number; inset: number;
    stepN: (i: number) => number; rounds: number[]; series: ScoreSeries | null;
}) {
    const [hover, setHover] = useState<number | null>(null);
    const SIZE = 32;
    const placed = useMemo(() => {
        const rows: number[][] = [[], [], []];
        const out: { m: Action; row: number; x: number }[] = [];
        let hidden = 0;
        for (const m of markers) {
            const x = (m.index / last) * width;
            const row = rows.findIndex((r) => r.every((px) => Math.abs(px - x) >= 30));
            if (row < 0) {
                hidden++;
                continue;
            }
            rows[row].push(x);
            out.push({ m, row, x });
        }
        return { out, hidden, rows: rows.filter((r) => r.length).length };
    }, [markers, last, width]);
    return (
        <div className="relative" style={{ height: Math.max(1, placed.rows) * 30 + 12 }} aria-label="Pivotal plays">
            {placed.out.map(({ m, row, x }, k) => {
                const passed = m.index <= step;
                const gain: Seat = m.swing >= 0 ? m.seat : m.seat === 'p1' ? 'p2' : 'p1';
                const align = x < 130 ? 'left-0' : x > width + inset - 130 ? 'right-0' : 'left-1/2 -translate-x-1/2';
                const words = swingWords(m, bots[m.seat], series);
                return (
                    <div key={m.index} className="absolute -translate-x-1/2" style={{ left: `clamp(${SIZE / 2}px, calc((100% - ${inset}px) * ${m.index / last}), calc(100% - ${SIZE / 2}px))`, top: row * 30, zIndex: hover === k ? 30 : 1 }}>
                        <button className="relative block transition-transform hover:scale-110 focus-visible:scale-110"
                            onClick={() => onSeek(m.index)} onMouseEnter={() => setHover(k)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(k)} onBlur={() => setHover(null)}
                            aria-label={`${describe(m, bots[m.seat])}, step ${stepN(m.index)}`}>
                            <span className="block transition-[opacity,filter]" style={{ opacity: passed ? 1 : 0.7, filter: passed ? undefined : 'saturate(0.5)' }}>
                                <ActionIcon cls={m.cls} seat={m.seat} card={m.card} outcome={m.outcome} size={SIZE} title="" />
                            </span>
                            <span className="absolute left-1/2 -translate-x-1/2 -bottom-2 rounded px-0.5 text-[9px] leading-tight num font-semibold bg-bg/90"
                                style={{ color: `var(--color-${gain})` }} title={words.text}>{m.swing >= 0 ? '▲' : '▼'}{Math.abs(m.swing).toFixed(0)}</span>
                        </button>
                        <AnimatePresence>
                            {hover === k && (
                                <motion.div className={`absolute bottom-full mb-2 ${align} panel !bg-panel p-2 pointer-events-none flex flex-col items-center gap-1`} style={{ zIndex: 40 }}
                                    initial={{ opacity: 0, y: 6, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0 }}>
                                    <ActionIcon cls={m.cls} seat={m.seat} card={m.card} outcome={m.outcome} size={110} caption={describe(m, bots[m.seat])} />
                                    <span className="text-[11px] num text-dim whitespace-nowrap">
                                        step {stepN(m.index)} · R{rounds[m.index]} · {classInfo(m.cls).label.toLowerCase()} · <b style={{ color: `var(--color-${gain})` }}>{words.amount}</b> for {bots[m.seat]}
                                    </span>
                                    <span className="text-[10.5px] text-faint text-center w-max max-w-[280px]">{words.from}</span>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                );
            })}
            {placed.hidden > 0 && <span className="absolute right-0 -top-0.5 chip !text-[10px]">+{placed.hidden} more</span>}
        </div>
    );
}
