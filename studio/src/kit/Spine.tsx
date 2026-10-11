import { useEffect, useMemo, useRef } from 'react';
import { motion } from 'motion/react';
import { Glyph } from './Glyph';
import type { Game } from '../data/types';
import { evalAt, type EvalPoint } from '../data/evals';

/**
 * The game spine: one board glyph per round (taken at the round's first decision, plus the final board), so the whole
 * game reads at a glance. Frames lean blue or red with the evaluation when one exists. Click a glyph to jump there.
 */
export function Spine({ game, step, evals, onSeek }: { game: Game; step: number; evals: Map<number, EvalPoint>; onSeek: (n: number) => void }) {
    const box = useRef<HTMLDivElement>(null);
    const marks = useMemo(() => {
        const out: { i: number; label: string }[] = [];
        let r = -1;
        game.steps.forEach((s, i) => {
            if (s.state.round !== r) {
                r = s.state.round;
                out.push({ i, label: `R${r}` });
            }
        });
        const last = game.steps.length - 1;
        if (out[out.length - 1]?.i !== last) {
            out.push({ i: last, label: game.end ? 'end' : 'now' });
        }
        return out;
    }, [game]);
    const current = marks.reduce((best, m, k) => (m.i <= step ? k : best), 0);
    useEffect(() => {
        const el = box.current?.children[current] as HTMLElement | undefined;
        el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }, [current]);
    return (
        <div ref={box} className="flex gap-1.5 overflow-x-auto pb-1" role="list" aria-label="Game spine: the board at the start of each round">
            {marks.map((m, k) => {
                const ev = evalAt(evals, m.i)?.point;
                const value = ev?.objective_state ?? ev?.objective_hindsight ?? ev?.p1_subjective ?? null;
                const on = k === current;
                return (
                    <button key={m.i} role="listitem" onClick={() => onSeek(m.i)} title={`${m.label} · step ${game.steps[m.i].n}${value != null ? ` · P(p1 wins) ${Math.round(value * 100)}%` : ''}`}
                        className={`relative shrink-0 flex flex-col items-center gap-0.5 rounded-md px-0.5 pt-0.5 transition-opacity ${m.i > step ? 'opacity-45 hover:opacity-90' : ''}`}>
                        {on && <motion.span layoutId="spine-cursor" className="absolute inset-0 rounded-md bg-raise" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
                        <span className="relative"><Glyph state={game.steps[m.i].state} size={30} value={value} selected={on} /></span>
                        <span className={`relative num text-[9px] ${on ? 'text-gold' : 'text-faint'}`}>{m.label}</span>
                    </button>
                );
            })}
        </div>
    );
}
