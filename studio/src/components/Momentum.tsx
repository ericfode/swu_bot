import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ActionIcon } from '../kit/ActionIcon';
import { classInfo, describe, type Action } from '../data/actions';
import { Area, ComposedChart, Line, ReferenceArea, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Metrics } from '../data/derive';
import type { EvalPoint } from '../data/evals';
import type { Seat } from '../data/types';

export type LaneKey = 'llm' | 'base' | 'power' | 'edge' | 'cards';
export const LANES: { key: LaneKey; label: string; hint: string }[] = [
    { key: 'llm', label: 'Evaluations', hint: 'Chance player 1 wins, from each viewpoint; the band spans their disagreement' },
    { key: 'base', label: 'Base HP', hint: 'HP left on each base' },
    { key: 'power', label: 'Board power', hint: 'Total power of each side\'s units' },
    { key: 'edge', label: 'Omni score', hint: 'The omniscient bot\'s board score for player 1 in points (its total minus player 2\'s), scaled to this game\'s biggest lead: above the middle player 1 is ahead' },
    { key: 'cards', label: 'Hand', hint: 'Cards in hand' }
];

const P1 = '#56c8ff';
const P2 = '#ff5f6d';
const FG = '#dce6fb';
const GOLD = '#f6c454';
const EDGE = '#c4b2ff'; // --color-edge
const PLAYHEAD = '#ffffff';

/** A 14px drawing of what a lane looks like on the chart, for its toggle chip. */
export function LaneSwatch({ lane }: { lane: LaneKey }) {
    return (
        <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden="true" className="shrink-0">
            {lane === 'llm' && <><path d="M0 8 L5 8 L5 4 L16 4" stroke={FG} strokeWidth="1.6" fill="none" /><path d="M0 10 L16 10" stroke={GOLD} strokeWidth="1.4" /><path d="M0 2 L16 2" stroke={P1} strokeWidth="1.2" strokeDasharray="2 2" /></>}
            {lane === 'base' && <><path d="M0 3 L16 3 L16 12 L0 12 Z" fill={P1} fillOpacity="0.3" /><path d="M0 3 L16 3" stroke={P1} strokeWidth="1.5" /><path d="M0 7 L16 7" stroke={P2} strokeWidth="1.5" /></>}
            {lane === 'power' && <><path d="M0 4 L16 4" stroke={P1} strokeWidth="1.4" strokeDasharray="3 2" /><path d="M0 9 L16 9" stroke={P2} strokeWidth="1.4" strokeDasharray="3 2" /></>}
            {lane === 'edge' && <><rect x="0" y="1" width="8" height="5" fill={P1} fillOpacity="0.55" /><rect x="8" y="6" width="8" height="5" fill={P2} fillOpacity="0.55" /><path d="M0 3 L8 3 L8 9 L16 9" stroke={EDGE} strokeWidth="1.5" fill="none" /></>}
            {lane === 'cards' && <><path d="M0 4 L16 4" stroke={P1} strokeOpacity="0.7" strokeWidth="1" /><path d="M0 9 L16 9" stroke={P2} strokeOpacity="0.7" strokeWidth="1" /></>}
        </svg>
    );
}

interface Props {
    data: Metrics[];
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

/** The game at a glance: chosen curves over every decision, round bands, and the playhead. Click or drag to seek. */
export function Momentum({ data, rounds, step, lanes, bots, onSeek, onHover, evals, height = 160, markers = [], stepN = (i) => i }: Props) {
    const box = useRef<HTMLDivElement>(null);
    const width = useWidth(box);
    const last = Math.max(1, data.length - 1);
    const hasEvals = !!evals?.size;
    const show = (k: LaneKey) => lanes.includes(k);
    const labels = evalLabels(bots);
    // the omni score in points, scaled to this game's biggest lead (at least 25), so a lopsided game doesn't pin the line to the edge
    const scale = useMemo(() => Math.max(25, ...data.map((m) => Math.abs(m.score))), [data]);
    const rows = useMemo(() => {
        // evals exist at checkpoints only: the lines step between them, and the tooltip carries the latest one forward
        let held: (EvalPoint & { at: number }) | null = null;
        return data.map((m, i) => {
            const e = evals?.get(i);
            if (e) {
                held = { ...e, at: i };
            }
            const vs = e ? [e.p1_subjective, e.p2_subjective, e.objective_state, e.objective_hindsight].filter((v): v is number => v != null) : [];
            return {
                ...m,
                sn: m.score / scale,
                snUp: Math.max(0, m.score / scale),
                snDown: Math.min(0, m.score / scale),
                ...(e ? { p1_subjective: e.p1_subjective, p2_subjective: e.p2_subjective, objective_state: e.objective_state, objective_hindsight: e.objective_hindsight, band: vs.length ? [Math.min(...vs), Math.max(...vs)] : undefined } : {}),
                held
            };
        });
    }, [data, evals, scale]);
    const bands = useMemo(() => rounds.map((r, i) => ({ ...r, end: rounds[i + 1]?.step ?? last })), [rounds, last]);
    // round labels: drop ones that would sit closer than 14px to the previous one
    const roundLabels = useMemo(() => {
        let prevX = -99;
        return bands.filter((b) => {
            const x = (b.step / last) * width;
            if (x - prevX < 14) {
                return false;
            }
            prevX = x;
            return true;
        });
    }, [bands, last, width]);
    const seekAt = (clientX: number) => {
        const r = box.current?.getBoundingClientRect();
        if (r) {
            onSeek(Math.round(Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * last));
        }
    };
    const centred = show('edge') || (hasEvals && show('llm'));
    const cur = rows[step];
    return (
        <div className="flex flex-col">
            {markers.length > 0 && <Markers markers={markers} last={last} step={step} bots={bots} onSeek={onSeek} width={width} stepN={stepN} rounds={data.map((d) => d.round)} />}
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
                        <YAxis yAxisId="p" orientation="right" hide={!(hasEvals && show('llm'))} domain={[-0.025, 1.025]} ticks={[0, 0.5, 1]} width={34}
                            tickFormatter={(v: number) => `${Math.round(v * 100)}%`} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                        {markers.map((m) => <ReferenceLine key={`stem${m.index}`} yAxisId="v" x={m.index} stroke="#ffffff" strokeOpacity={0.12} />)}
                        {show('base') && <Area yAxisId="v" type="monotone" dataKey="base1" name={`${bots.p1} base`} stroke={P1} strokeWidth={2} fill="url(#g1)" isAnimationActive={false} dot={false} />}
                        {show('base') && <Area yAxisId="v" type="monotone" dataKey="base2" name={`${bots.p2} base`} stroke={P2} strokeWidth={2} fill="url(#g2)" isAnimationActive={false} dot={false} />}
                        {centred && <ReferenceLine yAxisId="e" y={0} stroke="#56658a" strokeDasharray="2 4" />}
                        {centred && <ReferenceLine yAxisId="e" y={0.5} stroke="#56658a" strokeOpacity={0.45} strokeDasharray="1 5" />}
                        {centred && <ReferenceLine yAxisId="e" y={-0.5} stroke="#56658a" strokeOpacity={0.45} strokeDasharray="1 5" />}
                        {show('edge') && <Area yAxisId="e" type="linear" dataKey="snUp" baseValue={0} stroke="none" fill={P1} fillOpacity={0.22} isAnimationActive={false} dot={false} legendType="none" tooltipType="none" />}
                        {show('edge') && <Area yAxisId="e" type="linear" dataKey="snDown" baseValue={0} stroke="none" fill={P2} fillOpacity={0.22} isAnimationActive={false} dot={false} legendType="none" tooltipType="none" />}
                        {show('edge') && <Line yAxisId="e" type="linear" dataKey="sn" name="Omni score" stroke={EDGE} strokeWidth={1.8} dot={false} isAnimationActive={false} />}
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
                        {show('edge') && cur && (
                            <ReferenceDot yAxisId="e" x={step} y={cur.sn} r={3.5} fill={EDGE} stroke="#060a13" strokeWidth={1.5}
                                label={{ value: `${cur.score >= 0 ? '+' : '−'}${Math.abs(cur.score).toFixed(1)}`, position: step > last * 0.9 ? 'left' : 'right', fill: EDGE, fontSize: 11, fontFamily: 'IBM Plex Mono, monospace' }} />
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
                            return (
                                <div className="rounded-[10px] border border-line bg-panel/95 px-3 py-2 text-[12px] leading-relaxed shadow-xl">
                                    <div className="text-dim">step {stepN(i)} · round {r.round}</div>
                                    <div className="num"><span className="text-p1">{r.base1}</span> <span className="text-faint">vs</span> <span className="text-p2">{r.base2}</span> <span className="text-faint">base HP</span></div>
                                    <div className="num"><span style={{ color: EDGE }}>{r.score >= 0 ? '+' : '−'}{Math.abs(r.score).toFixed(1)}</span> <span className="text-faint">Omni score (points)</span></div>
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
                    <div className="pointer-events-none absolute inset-y-0 left-1 flex flex-col justify-between py-2 text-[10px] text-faint">
                        <span>▲ {bots.p1} ahead{show('edge') && <span className="num"> · top +{scale.toFixed(0)}</span>}</span>
                        <span>▼ {bots.p2} ahead{show('edge') && <span className="num"> · bottom −{scale.toFixed(0)}</span>}</span>
                    </div>
                )}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-4">
                    {roundLabels.map((b) => (
                        <span key={b.step} className="absolute bottom-0 text-[10px] text-faint num" style={{ left: `${(b.step / last) * 100}%` }}>{b.round}</span>
                    ))}
                </div>
            </div>
            {hasEvals && show('llm') && (
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 pt-1 text-[11px] text-dim" aria-label="Evaluation legend">
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

/**
 * Pivotal plays pinned over the timeline at their step, each with a thin stem down the chart. Markers are placed in up
 * to three rows so none sits closer than 30px to another in its row; ones that don't fit are counted at the end.
 */
function Markers({ markers, last, step, bots, onSeek, width, stepN, rounds }: {
    markers: Action[]; last: number; step: number; bots: Record<Seat, string>; onSeek: (n: number) => void; width: number;
    stepN: (i: number) => number; rounds: number[];
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
                const align = x < 130 ? 'left-0' : x > width - 130 ? 'right-0' : 'left-1/2 -translate-x-1/2';
                return (
                    <div key={m.index} className="absolute -translate-x-1/2" style={{ left: `clamp(${SIZE / 2}px, ${(m.index / last) * 100}%, calc(100% - ${SIZE / 2}px))`, top: row * 30, zIndex: hover === k ? 30 : 1 }}>
                        <button className="relative block transition-transform hover:scale-110 focus-visible:scale-110"
                            onClick={() => onSeek(m.index)} onMouseEnter={() => setHover(k)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(k)} onBlur={() => setHover(null)}
                            aria-label={`${describe(m, bots[m.seat])}, step ${stepN(m.index)}`}>
                            <span className="block transition-[opacity,filter]" style={{ opacity: passed ? 1 : 0.7, filter: passed ? undefined : 'saturate(0.5)' }}>
                                <ActionIcon cls={m.cls} seat={m.seat} card={m.card} outcome={m.outcome} size={SIZE} title="" />
                            </span>
                            <span className="absolute left-1/2 -translate-x-1/2 -bottom-2 rounded px-0.5 text-[9px] leading-tight num font-semibold bg-bg/90"
                                style={{ color: `var(--color-${gain})` }} title={`${m.swing >= 0 ? '+' : '−'}${Math.abs(m.swing).toFixed(1)} points of ${bots[m.seat]}'s chance to win (from the evaluations, or from the omni score's curve without them)`}>{m.swing >= 0 ? '▲' : '▼'}{Math.abs(m.swing).toFixed(0)}</span>
                        </button>
                        <AnimatePresence>
                            {hover === k && (
                                <motion.div className={`absolute bottom-full mb-2 ${align} panel !bg-panel p-2 pointer-events-none flex flex-col items-center gap-1`} style={{ zIndex: 40 }}
                                    initial={{ opacity: 0, y: 6, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0 }}>
                                    <ActionIcon cls={m.cls} seat={m.seat} card={m.card} outcome={m.outcome} size={110} caption={describe(m, bots[m.seat])} />
                                    <span className="text-[11px] num text-dim whitespace-nowrap">
                                        step {stepN(m.index)} · R{rounds[m.index]} · {classInfo(m.cls).label.toLowerCase()} · <b style={{ color: `var(--color-${gain})` }}>{m.swing >= 0 ? '+' : '−'}{Math.abs(m.swing).toFixed(1)} pts</b> for {bots[m.seat]}
                                    </span>
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
