import { memo, useEffect, useRef } from 'react';
import { humanize } from '../lib/cards';
import { ActionIcon } from '../kit/ActionIcon';
import { describe, type Action } from '../data/actions';
import type { Delta } from '../data/derive';
import type { Game, Seat } from '../data/types';

const KIND_STYLE: Record<Delta['kind'], string> = {
    enter: 'text-dim',
    defeat: 'text-p2',
    base: 'text-gold',
    heal: 'text-good',
    deploy: 'text-gold',
    resource: 'text-faint'
};

const Row = memo(function Row({ i, game, bots, deltas, current, onGo, action }: { i: number; game: Game; bots: Record<Seat, string>; deltas: Delta[]; current: boolean; onGo: (n: number) => void; action?: Action }) {
    const s = game.steps[i];
    const prevRound = i > 0 ? game.steps[i - 1].state.round : -1;
    return (
        <li>
            {s.state.round !== prevRound && (
                <div className="eyebrow px-3 pt-3 pb-1 sticky top-0 bg-panel/95 backdrop-blur z-[1]">Round {s.state.round}</div>
            )}
            <button onClick={() => onGo(i)} aria-current={current ? 'step' : undefined}
                className="flex gap-2 px-3 py-1.5 rounded-md hover:bg-raise/60 transition-colors">
                <span className="num text-[11px] text-faint w-8 shrink-0 pt-0.5 text-right">{s.n}</span>
                <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                        {action ? <ActionIcon cls={action.cls} seat={action.seat} size={16} title={describe(action, bots[action.seat])} />
                            : s.pid && <i className="size-2 mx-1 rounded-full shrink-0 opacity-60" style={{ background: s.pid === 'p1' ? 'var(--color-p1)' : 'var(--color-p2)' }} />}
                        <span className="truncate">
                            {s.pid && <b className="font-medium" style={{ color: s.pid === 'p1' ? 'var(--color-p1)' : 'var(--color-p2)' }}>{bots[s.pid]} </b>}
                            <span className="text-fg">{s.action ? humanize(s.action.label) : s.label}</span>
                        </span>
                    </span>
                    {(s.title || s.legal) && <span className="block text-[11px] text-faint truncate">{s.title ?? s.prompt}{s.legal ? ` · ${s.legal} options` : ''}</span>}
                    {deltas.length > 0 && (
                        <span className="flex flex-wrap gap-x-2 text-[11px]">
                            {deltas.map((d, k) => <span key={k} className={KIND_STYLE[d.kind]}>{d.text}</span>)}
                        </span>
                    )}
                </span>
            </button>
        </li>
    );
});

/** Every decision, grouped by round, with what each one changed on the board. */
export function Log({ game, bots, deltas, step, onGo, actions }: { game: Game; bots: Record<Seat, string>; deltas: Delta[][]; step: number; onGo: (n: number) => void; actions?: Map<number, Action> }) {
    const ref = useRef<HTMLOListElement>(null);
    useEffect(() => {
        const box = ref.current;
        const li = box?.children[step] as HTMLElement | undefined;
        if (box && li) {
            const target = li.offsetTop - box.clientHeight / 2 + li.clientHeight / 2;
            box.scrollTo({ top: target, behavior: Math.abs(box.scrollTop - target) > 2000 ? 'auto' : 'smooth' });
        }
    }, [step]);
    return (
        <ol ref={ref} className="log relative overflow-y-auto min-h-0 flex-1 pb-2" aria-label="Decision log">
            {game.steps.map((_, i) => <Row key={i} i={i} game={game} bots={bots} deltas={deltas[i]} current={i === step} onGo={onGo} action={actions?.get(i)} />)}
        </ol>
    );
}
