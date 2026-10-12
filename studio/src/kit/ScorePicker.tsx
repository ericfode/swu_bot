import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { ScoreSource } from '../data/score';
import type { Sees } from '../data/lensFile';
import { CHANCE_WORD } from '../components/ScoreBadge';

/** The chosen label, cut in the middle: the ", as <bot> weighs it" tail tells two entries apart, so it stays. */
function ButtonLabel({ label }: { label: string }) {
    const at = label.lastIndexOf(', as ');
    return at > 0
        ? <span className="flex min-w-0"><span className="truncate">{label.slice(0, at)}</span><span className="whitespace-nowrap">{label.slice(at)}</span></span>
        : <span className="truncate">{label}</span>;
}

/** What a source sees, in words. */
export const SEES_TEXT: Record<Sees, string> = { public: 'scores the public board', seat: 'sees its own hand', omniscient: 'knows both hands', hindsight: 'knows the result' };

/**
 * Props of the picker: the game's sources (in registry order), the chosen one, and a callback with the picked key.
 * `coverage` gives the steps a source has values for (null when unknown).
 */
export interface ScorePickerProps {
    sources: ScoreSource[];
    chosen: ScoreSource | null;
    onPick: (key: string) => void;
    coverage?: (s: ScoreSource) => { have: number; of: number } | null;
}

/** A line sample as the timeline draws the source: solid with a chance on the % axis, dashed on its own axis. */
function LineSample({ source }: { source: ScoreSource }) {
    const solid = source.chance === 'fitted' || source.chance === 'model';
    return (
        <svg width="18" height="10" viewBox="0 0 18 10" aria-hidden="true" className="shrink-0">
            <path d="M1 7 L6 7 L10 3 L17 3" stroke="var(--color-edge)" strokeWidth="1.6" fill="none" strokeDasharray={solid ? undefined : '3 2'} />
        </svg>
    );
}

function quality(s: ScoreSource): string {
    const q = s.quality;
    if (q?.brier == null) {
        return 'accuracy not measured';
    }
    const on = q.games != null ? ` on ${q.games} games` : q.n != null ? ` on ${q.n} positions` : '';
    return `Brier ${q.brier.toFixed(3)}${on}${q.heldOut ? ', held-out' : ''}`;
}

/** Choose which score the board, the breakdown and the timeline show. Shown only when the game has two or more. */
export function ScorePicker({ sources, chosen, onPick, coverage }: ScorePickerProps) {
    const [open, setOpen] = useState(false);
    const box = useRef<HTMLDivElement>(null);
    const list = useRef<HTMLDivElement>(null);
    // on a narrow screen the list (right-aligned to the button) can start left of the screen: keep a 16px gutter
    useLayoutEffect(() => {
        const el = list.current;
        const left = el?.getBoundingClientRect().left;
        if (el && left != null && left < 16) {
            el.style.transform = `translateX(${16 - left}px)`;
        }
    }, [open]);
    useEffect(() => {
        if (!open) {
            return undefined;
        }
        // composedPath: the kit renders in a shadow root, where a document listener sees only the host as target
        const away = (e: Event) => {
            if (box.current && !e.composedPath().includes(box.current)) {
                setOpen(false);
            }
        };
        document.addEventListener('pointerdown', away);
        list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
        return () => document.removeEventListener('pointerdown', away);
    }, [open]);
    if (sources.length < 2) {
        return null;
    }
    const pick = (key: string) => {
        setOpen(false);
        onPick(key);
    };
    // arrows move between rows and Escape closes (the viewer's step keys ignore keys inside a listbox)
    const onKey = (e: KeyboardEvent) => {
        const rows = [...(list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
        const at = rows.indexOf(e.target as HTMLElement);
        if (e.key === 'Escape') {
            setOpen(false);
            box.current?.querySelector<HTMLElement>('button')?.focus();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
        }
    };
    return (
        <div ref={box} className="relative">
            <button className="btn !h-8 max-w-[19rem]" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}
                title={chosen ? `Score shown: ${chosen.label}. ${sources.length} scores have this game` : 'Choose a score'}>
                <span className="text-dim">Score:</span><ButtonLabel label={chosen?.label ?? 'none'} /><ChevronDown size={14} className="shrink-0" />
            </button>
            {open && (
                <div ref={list} role="listbox" aria-label="Score" onKeyDown={onKey}
                    className="panel !bg-panel absolute right-0 top-full mt-1 z-40 w-[23rem] max-w-[calc(100vw-2rem)] p-1 flex flex-col shadow-2xl">
                    {sources.map((s) => {
                        const on = s.key === chosen?.key;
                        const cov = coverage?.(s);
                        return (
                            <button key={s.key} role="option" aria-selected={on} onClick={() => pick(s.key)}
                                className={`text-left rounded-lg px-2 py-1.5 flex gap-2 items-start outline-none hover:bg-raise focus-visible:bg-raise ${on ? 'bg-raise/70' : ''}`}>
                                <span className="pt-1"><LineSample source={s} /></span>
                                <span className="flex flex-col min-w-0 flex-1">
                                    <span className="flex items-baseline gap-1.5 min-w-0">
                                        <span className="text-fg text-[13px] font-medium truncate">{s.label}</span>
                                        <span className="text-faint text-[11px] shrink-0">{s.unitText}</span>
                                        {on && <Check size={13} className="ml-auto shrink-0 self-center" style={{ color: 'var(--color-edge)' }} />}
                                    </span>
                                    {s.error ? <span className="text-p2 text-[11px]">{s.error}</span> : (
                                        <span className="text-dim text-[11px] leading-snug">
                                            {CHANCE_WORD[s.chance]} · {quality(s)} · {SEES_TEXT[s.sees]}
                                            {cov ? ` · ${cov.have} of ${cov.of} steps` : ''}
                                        </span>
                                    )}
                                </span>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
