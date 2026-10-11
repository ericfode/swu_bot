import { useMemo, useRef } from 'react';
import { Area, ComposedChart, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Metrics } from '../data/derive';
import type { Seat } from '../data/types';

export type LaneKey = 'base' | 'power' | 'edge' | 'cards';
export const LANES: { key: LaneKey; label: string; hint: string }[] = [
    { key: 'base', label: 'Base HP', hint: 'HP left on each base' },
    { key: 'power', label: 'Board power', hint: 'Total power of each side\'s units' },
    { key: 'edge', label: 'Material edge', hint: 'Simple board read, +1 = player 1 far ahead, -1 = player 2' },
    { key: 'cards', label: 'Hand', hint: 'Cards in hand' }
];

interface Props {
    data: Metrics[];
    rounds: { step: number; round: number }[];
    step: number;
    lanes: LaneKey[];
    bots: Record<Seat, string>;
    onSeek: (n: number) => void;
}

const P1 = '#56c8ff';
const P2 = '#ff5f6d';

/** The game at a glance: chosen curves over every decision, round bands, and the playhead. Click or drag to seek. */
export function Momentum({ data, rounds, step, lanes, bots, onSeek }: Props) {
    const box = useRef<HTMLDivElement>(null);
    const last = Math.max(1, data.length - 1);
    const bands = useMemo(() => rounds.map((r, i) => ({ ...r, end: rounds[i + 1]?.step ?? last })), [rounds, last]);
    const seekAt = (clientX: number) => {
        const r = box.current?.getBoundingClientRect();
        if (r) {
            onSeek(Math.round(Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * last));
        }
    };
    const show = (k: LaneKey) => lanes.includes(k);
    return (
        <div className="relative h-40 select-none" ref={box}
            onPointerDown={(e) => {
                (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                seekAt(e.clientX);
            }}
            onPointerMove={(e) => e.buttons === 1 && seekAt(e.clientX)}>
            <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={data} margin={{ top: 8, right: 0, bottom: 0, left: 0 }}>
                    <defs>
                        <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={P1} stopOpacity={0.45} /><stop offset="1" stopColor={P1} stopOpacity={0} /></linearGradient>
                        <linearGradient id="g2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={P2} stopOpacity={0.45} /><stop offset="1" stopColor={P2} stopOpacity={0} /></linearGradient>
                    </defs>
                    {bands.map((b, i) => i % 2 === 1 && <ReferenceArea key={b.step} x1={b.step} x2={b.end} yAxisId="v" fill="#ffffff" fillOpacity={0.025} strokeOpacity={0} />)}
                    <XAxis dataKey="step" type="number" domain={[0, last]} hide />
                    <YAxis yAxisId="v" hide domain={[0, 'dataMax + 4']} />
                    <YAxis yAxisId="e" hide domain={[-1.05, 1.05]} />
                    {show('edge') && <ReferenceLine yAxisId="e" y={0} stroke="#56658a" strokeDasharray="2 4" />}
                    {show('base') && <Area yAxisId="v" type="monotone" dataKey="base1" name={`${bots.p1} base`} stroke={P1} strokeWidth={2} fill="url(#g1)" isAnimationActive={false} dot={false} />}
                    {show('base') && <Area yAxisId="v" type="monotone" dataKey="base2" name={`${bots.p2} base`} stroke={P2} strokeWidth={2} fill="url(#g2)" isAnimationActive={false} dot={false} />}
                    {show('power') && <Line yAxisId="v" type="stepAfter" dataKey="power1" name={`${bots.p1} power`} stroke={P1} strokeDasharray="4 3" strokeWidth={1.5} dot={false} isAnimationActive={false} />}
                    {show('power') && <Line yAxisId="v" type="stepAfter" dataKey="power2" name={`${bots.p2} power`} stroke={P2} strokeDasharray="4 3" strokeWidth={1.5} dot={false} isAnimationActive={false} />}
                    {show('cards') && <Line yAxisId="v" type="stepAfter" dataKey="hand1" name={`${bots.p1} hand`} stroke={P1} strokeOpacity={0.6} strokeWidth={1} dot={false} isAnimationActive={false} />}
                    {show('cards') && <Line yAxisId="v" type="stepAfter" dataKey="hand2" name={`${bots.p2} hand`} stroke={P2} strokeOpacity={0.6} strokeWidth={1} dot={false} isAnimationActive={false} />}
                    {show('edge') && <Line yAxisId="e" type="monotone" dataKey="edge" name="material edge (p1)" stroke="#f6c454" strokeWidth={2} dot={false} isAnimationActive={false} />}
                    <ReferenceLine yAxisId="v" x={step} stroke="#f6c454" strokeWidth={2} />
                    <Tooltip cursor={{ stroke: '#dce6fb33' }} isAnimationActive={false}
                        contentStyle={{ background: '#0f1829ee', border: '1px solid #1d2a44', borderRadius: 10, fontSize: 12 }}
                        labelStyle={{ color: '#8494b8' }}
                        labelFormatter={(l) => `step ${l} · round ${data[Number(l)]?.round ?? ''}`}
                        formatter={(v, name) => [typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(2)) : String(v), name]} />
                </ComposedChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-4">
                {bands.map((b) => (
                    <span key={b.step} className="absolute bottom-0 text-[10px] text-faint num" style={{ left: `${(b.step / last) * 100}%` }}>{b.round}</span>
                ))}
            </div>
        </div>
    );
}
