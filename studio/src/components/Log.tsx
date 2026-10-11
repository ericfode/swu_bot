import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { humanize } from '../lib/cards';
import { ActionIcon } from '../kit/ActionIcon';
import { describe, type Action } from '../data/actions';
import type { Delta } from '../data/derive';
import type { Game, Seat } from '../data/types';

const KIND_STYLE: Record<Delta['kind'], string> = {
    enter: 'text-dim',
    defeat: '',
    base: 'text-gold',
    heal: 'text-good',
    deploy: 'text-gold',
    flip: 'text-gold',
    steal: '',
    bounce: '',
    resource: 'text-faint'
};
const SEAT_TEXT: Record<Seat, string> = { p1: 'text-p1', p2: 'text-p2' };

/** A unit leaving the board (defeated, returned, taken) in the colour of the side that lost it; the rest by kind. */
function deltaClass(d: Delta): string {
    if (d.kind === 'defeat' || d.kind === 'bounce') {
        return SEAT_TEXT[d.seat];
    }
    // a steal is recorded on the side the unit went to; the loss is the other side's
    return d.kind === 'steal' ? SEAT_TEXT[d.seat === 'p1' ? 'p2' : 'p1'] : KIND_STYLE[d.kind];
}

/** The current row is marked in the foreground colour (the stylesheet's gold is kept for initiative and wins). */
const CURRENT_STYLE = { boxShadow: 'inset 2px 0 0 var(--color-fg)' };
/** the stylesheet makes every log button full width; the fold toggle is a small chip on the row's right */
const TOGGLE_STYLE = { width: 'auto' };

interface RowProps {
    i: number;
    game: Game;
    bots: Record<Seat, string>;
    deltas: Delta[];
    current: boolean;
    onGo: (n: number) => void;
    action?: Action;
    /** this step is one click of an action shown on another row (a resource window): only its round heading is drawn */
    hidden?: boolean;
    /** drawn indented under its action's row when that row is open */
    nested?: boolean;
    /** the action's own row: how many clicks it folds (0 = not a folded action), whether they are shown, and the toggle */
    foldCount?: number;
    foldOpen?: boolean;
    onToggle?: (index: number) => void;
}

const NO_DELTAS: Delta[] = [];

const Row = memo(function Row({ i, game, bots, deltas, current, onGo, action, hidden, nested, foldCount = 0, foldOpen = false, onToggle }: RowProps) {
    const fold = foldCount > 0;
    const s = game.steps[i];
    const prevRound = i > 0 ? game.steps[i - 1].state.round : -1;
    const heading = s.state.round !== prevRound && (
        <div className="eyebrow px-3 pt-3 pb-1 sticky top-0 bg-panel/95 backdrop-blur z-[1]">Round {s.state.round}</div>
    );
    if (hidden) {
        return <li>{heading}</li>;
    }
    // a folded action reads as the action ("resources Fenn Rau and Doctor Pershing"), not as its first click
    const text = fold && action ? describe(action, '').trim() : s.action ? humanize(s.action.label) : s.label;
    return (
        <li className="relative">
            {heading}
            <button onClick={() => onGo(i)} aria-current={current ? 'step' : undefined} style={current ? CURRENT_STYLE : undefined}
                className={`flex gap-2 px-3 py-1.5 rounded-md hover:bg-raise/60 transition-colors ${nested ? 'pl-8 opacity-70' : ''} ${fold ? 'pr-20' : ''}`}>
                <span className="num text-[11px] text-faint w-8 shrink-0 pt-0.5 text-right">{s.n}</span>
                <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                        {action ? <ActionIcon cls={action.cls} seat={action.seat} size={16} title={describe(action, bots[action.seat])} />
                            : s.pid && <i className="size-2 mx-1 rounded-full shrink-0 opacity-60" style={{ background: s.pid === 'p1' ? 'var(--color-p1)' : 'var(--color-p2)' }} />}
                        <span className="truncate">
                            {s.pid && <b className="font-medium" style={{ color: s.pid === 'p1' ? 'var(--color-p1)' : 'var(--color-p2)' }}>{bots[s.pid]} </b>}
                            <span className="text-fg">{text}</span>
                        </span>
                    </span>
                    {(s.title || s.legal) && !fold && <span className="block text-[11px] text-faint truncate">{s.title ?? s.prompt}{s.legal ? ` · ${s.legal} options` : ''}</span>}
                    {deltas.length > 0 && (
                        <span className="flex flex-wrap gap-x-2 text-[11px]">
                            {deltas.map((d, k) => <span key={k} className={deltaClass(d)}>{d.text}</span>)}
                        </span>
                    )}
                </span>
            </button>
            {foldCount > 1 && onToggle && (
                <button onClick={() => onToggle(i)} aria-expanded={foldOpen} title={foldOpen ? 'Hide the clicks' : 'Show every click'} style={TOGGLE_STYLE}
                    className="absolute right-2 top-1.5 flex items-center gap-0.5 rounded px-1 text-[11px] text-faint hover:text-fg hover:bg-raise/60">
                    {foldCount} clicks
                    <ChevronRight size={12} className={`transition-transform ${foldOpen ? 'rotate-90' : ''}`} />
                </button>
            )}
        </li>
    );
});

/**
 * Every decision, grouped by round, with what each one changed on the board. The clicks of a resource window fold
 * under one row per player (the action), which can be opened to show them.
 */
export function Log({ game, bots, deltas, step, onGo, actions }: { game: Game; bots: Record<Seat, string>; deltas: Delta[][]; step: number; onGo: (n: number) => void; actions?: Map<number, Action> }) {
    const ref = useRef<HTMLOListElement>(null);
    const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
    const onToggle = useCallback((index: number) => setOpen((o) => {
        const next = new Set(o);
        if (!next.delete(index)) {
            next.add(index);
        }
        return next;
    }), []);
    // step -> the action it is folded into, for every step of a multi-step action that lists its steps
    const owner = useMemo(() => {
        const m = new Map<number, Action>();
        for (const a of actions?.values() ?? []) {
            for (const k of a.steps ?? []) {
                if (k !== a.index) {
                    m.set(k, a);
                }
            }
        }
        return m;
    }, [actions]);
    // a folded action's row also shows what its hidden steps changed (other than the resource count it already names)
    const rowDeltas = useMemo(() => deltas.map((d, i) => {
        const a = actions?.get(i);
        if (!a?.steps || open.has(i)) {
            return d;
        }
        const more = a.steps.filter((k) => k !== i).flatMap((k) => deltas[k] ?? []).filter((x) => x.kind !== 'resource');
        return more.length ? [...d, ...more] : d;
    }), [deltas, actions, open]);
    const shown = (i: number) => {
        const a = owner.get(i);
        return a && !open.has(a.index) ? a.index : i;
    };
    const at = shown(step);
    useEffect(() => {
        const box = ref.current;
        const li = box?.children[at] as HTMLElement | undefined;
        if (box && li) {
            const target = li.offsetTop - box.clientHeight / 2 + li.clientHeight / 2;
            box.scrollTo({ top: target, behavior: Math.abs(box.scrollTop - target) > 2000 ? 'auto' : 'smooth' });
        }
    }, [at]);
    return (
        <ol ref={ref} className="log relative overflow-y-auto min-h-0 flex-1 pb-2" aria-label="Decision log">
            {game.steps.map((_, i) => {
                const a = actions?.get(i);
                const host = owner.get(i);
                const hidden = !!host && !open.has(host.index);
                return <Row key={i} i={i} game={game} bots={bots} deltas={hidden ? NO_DELTAS : rowDeltas[i]} current={i === at} onGo={onGo}
                    action={a} hidden={hidden} nested={!!host} foldCount={a?.steps?.length ?? 0} foldOpen={open.has(i)} onToggle={onToggle} />;
            })}
        </ol>
    );
}
