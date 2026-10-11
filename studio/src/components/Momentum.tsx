import { useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ActionIcon } from '../kit/ActionIcon';
import { describe, type Action } from '../data/actions';
import { Area, ComposedChart, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Metrics } from '../data/derive';
import type { EvalPoint } from '../data/evals';
import type { Seat } from '../data/types';

export type LaneKey = 'llm' | 'base' | 'power' | 'edge' | 'cards';
export const LANES: { key: LaneKey; label: string; hint: string }[] = [
    { key: 'llm', label: 'Evaluations', hint: 'P(player 1 wins) from each viewpoint; the band spans their disagreement' },
    { key: 'base', label: 'Base HP', hint: 'HP left on each base' },
    { key: 'power', label: 'Board power', hint: 'Total power of each side\'s units' },
    { key: 'edge', label: 'Omni score', hint: 'The omniscient bot\'s board score for player 1 (its total minus player 2\'s), squashed to -1..+1' },
    { key: 'cards', label: 'Hand', hint: 'Cards in hand' }
];

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
    onSeek: (n: number) => void;
}

const P1 = '#56c8ff';
const P2 = '#ff5f6d';

/** The game at a glance: chosen curves over every decision, round bands, and the playhead. Click or drag to seek. */
export function Momentum({ data, rounds, step, lanes, bots, onSeek, evals, height = 160, markers = [] }: Props) {
    const box = useRef<HTMLDivElement>(null);
    const last = Math.max(1, data.length - 1);
    const rows = useMemo(() => {
        if (!evals?.size) {
            return data;
        }
        return data.map((m, i) => {
            const e = evals.get(i);
            if (!e) {
                return m;
            }
            const vs = [e.p1_subjective, e.p2_subjective, e.objective_state, e.objective_hindsight].filter((v): v is number => v != null);
            return { ...m, ...e, step: i, band: vs.length ? [Math.min(...vs), Math.max(...vs)] : undefined };
        });
    }, [data, evals]);
    const hasEvals = !!evals?.size;
    const bands = useMemo(() => rounds.map((r, i) => ({ ...r, end: rounds[i + 1]?.step ?? last })), [rounds, last]);
    const seekAt = (clientX: number) => {
        const r = box.current?.getBoundingClientRect();
        if (r) {
            onSeek(Math.round(Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * last));
        }
    };
    const show = (k: LaneKey) => lanes.includes(k);
    return (
        <div className="flex flex-col">
            {markers.length > 0 && <Markers markers={markers} last={last} step={step} bots={bots} onSeek={onSeek} />}
        <div className="relative select-none touch-none" style={{ height }} ref={box}
            onPointerDown={(e) => {
                (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                seekAt(e.clientX);
            }}
            onPointerMove={(e) => e.buttons === 1 && seekAt(e.clientX)}>
            <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={rows} margin={{ top: 8, right: 0, bottom: 0, left: 0 }}>
                    <defs>
                        <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={P1} stopOpacity={0.45} /><stop offset="1" stopColor={P1} stopOpacity={0} /></linearGradient>
                        <linearGradient id="g2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={P2} stopOpacity={0.45} /><stop offset="1" stopColor={P2} stopOpacity={0} /></linearGradient>
                    </defs>
                    {bands.map((b, i) => i % 2 === 1 && <ReferenceArea key={b.step} x1={b.step} x2={b.end} yAxisId="v" fill="#ffffff" fillOpacity={0.025} strokeOpacity={0} />)}
                    <XAxis dataKey="step" type="number" domain={[0, last]} hide />
                    <YAxis yAxisId="v" hide domain={[0, 'dataMax + 4']} />
                    <YAxis yAxisId="e" hide domain={[-1.05, 1.05]} />
                    <YAxis yAxisId="p" hide domain={[-0.02, 1.02]} />
                    {hasEvals && show('llm') && <ReferenceLine yAxisId="p" y={0.5} stroke="#56658a" strokeDasharray="2 4" />}
                    {hasEvals && show('llm') && <Area yAxisId="p" type="monotone" dataKey="band" name="disagreement" stroke="none" fill="#dce6fb" fillOpacity={0.09} connectNulls isAnimationActive={false} />}
                    {hasEvals && show('llm') && <Line yAxisId="p" type="monotone" dataKey="p1_subjective" name="P1's view" stroke={P1} strokeWidth={1.6} strokeDasharray="5 3" connectNulls dot={false} isAnimationActive={false} />}
                    {hasEvals && show('llm') && <Line yAxisId="p" type="monotone" dataKey="p2_subjective" name="P2's view" stroke={P2} strokeWidth={1.6} strokeDasharray="5 3" connectNulls dot={false} isAnimationActive={false} />}
                    {hasEvals && show('llm') && <Line yAxisId="p" type="monotone" dataKey="objective_state" name="Both hands" stroke="#dce6fb" strokeWidth={2.2} connectNulls dot={{ r: 2, strokeWidth: 0, fill: '#dce6fb' }} isAnimationActive={false} />}
                    {hasEvals && show('llm') && <Line yAxisId="p" type="monotone" dataKey="objective_hindsight" name="Hindsight" stroke="#f6c454" strokeWidth={2.2} connectNulls dot={false} isAnimationActive={false} />}
                    {show('edge') && <ReferenceLine yAxisId="e" y={0} stroke="#56658a" strokeDasharray="2 4" />}
                    {show('base') && <Area yAxisId="v" type="monotone" dataKey="base1" name={`${bots.p1} base`} stroke={P1} strokeWidth={2} fill="url(#g1)" isAnimationActive={false} dot={false} />}
                    {show('base') && <Area yAxisId="v" type="monotone" dataKey="base2" name={`${bots.p2} base`} stroke={P2} strokeWidth={2} fill="url(#g2)" isAnimationActive={false} dot={false} />}
                    {show('power') && <Line yAxisId="v" type="stepAfter" dataKey="power1" name={`${bots.p1} power`} stroke={P1} strokeDasharray="4 3" strokeWidth={1.5} dot={false} isAnimationActive={false} />}
                    {show('power') && <Line yAxisId="v" type="stepAfter" dataKey="power2" name={`${bots.p2} power`} stroke={P2} strokeDasharray="4 3" strokeWidth={1.5} dot={false} isAnimationActive={false} />}
                    {show('cards') && <Line yAxisId="v" type="stepAfter" dataKey="hand1" name={`${bots.p1} hand`} stroke={P1} strokeOpacity={0.6} strokeWidth={1} dot={false} isAnimationActive={false} />}
                    {show('cards') && <Line yAxisId="v" type="stepAfter" dataKey="hand2" name={`${bots.p2} hand`} stroke={P2} strokeOpacity={0.6} strokeWidth={1} dot={false} isAnimationActive={false} />}
                    {show('edge') && <Line yAxisId="e" type="monotone" dataKey="edge" name="omni score (p1)" stroke="#a48bff" strokeWidth={2} dot={false} isAnimationActive={false} />}
                    <ReferenceLine yAxisId="v" x={step} stroke="#f6c454" strokeWidth={2} />
                    <Tooltip cursor={{ stroke: '#dce6fb33' }} isAnimationActive={false}
                        contentStyle={{ background: '#0f1829ee', border: '1px solid #1d2a44', borderRadius: 10, fontSize: 12 }}
                        labelStyle={{ color: '#8494b8' }}
                        labelFormatter={(l) => `step ${l} · round ${data[Number(l)]?.round ?? ''}`}
                        formatter={(v, name) => [Array.isArray(v) ? v.map((x) => Number(x).toFixed(2)).join('–') : typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(2)) : String(v), name]} />
                </ComposedChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-4">
                {bands.map((b) => (
                    <span key={b.step} className="absolute bottom-0 text-[10px] text-faint num" style={{ left: `${(b.step / last) * 100}%` }}>{b.round}</span>
                ))}
            </div>
        </div>
        </div>
    );
}

/** Pivotal plays pinned over the timeline at their step; alternate rows keep neighbours from overlapping. Hover for the full card. */
function Markers({ markers, last, step, bots, onSeek }: { markers: Action[]; last: number; step: number; bots: Record<Seat, string>; onSeek: (n: number) => void }) {
    const [hover, setHover] = useState<number | null>(null);
    const rows: number[] = [];
    let prevX = -1;
    let prevRow = 1;
    for (const m of markers) {
        const x = m.index / last;
        const row = x - prevX < 0.045 ? 1 - prevRow : 0;
        rows.push(row);
        prevX = x;
        prevRow = row;
    }
    const twoRows = rows.some((r) => r === 1);
    return (
        <div className="relative" style={{ height: twoRows ? 58 : 32 }} aria-label="Pivotal plays">
            {markers.map((m, k) => {
                const passed = m.index <= step;
                return (
                    <button key={m.index} className="absolute -translate-x-1/2 transition-[opacity,transform] hover:scale-110 focus-visible:scale-110"
                        style={{ left: `clamp(14px, ${(m.index / last) * 100}%, calc(100% - 14px))`, top: rows[k] * 26, opacity: passed ? 1 : 0.55, zIndex: hover === k ? 5 : 1 }}
                        onClick={() => onSeek(m.index)} onMouseEnter={() => setHover(k)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(k)} onBlur={() => setHover(null)}
                        aria-label={`${describe(m, bots[m.seat])}, step ${m.index}`}>
                        <ActionIcon cls={m.cls} seat={m.seat} card={m.card} outcome={m.outcome} size={26} title="" />
                        <AnimatePresence>
                            {hover === k && (
                                <motion.span className="absolute left-1/2 bottom-full mb-2 -translate-x-1/2 panel !bg-panel p-2 pointer-events-none" initial={{ opacity: 0, y: 6, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0 }}>
                                    <ActionIcon cls={m.cls} seat={m.seat} card={m.card} outcome={m.outcome} size={110} caption={describe(m, bots[m.seat])} />
                                </motion.span>
                            )}
                        </AnimatePresence>
                    </button>
                );
            })}
        </div>
    );
}
