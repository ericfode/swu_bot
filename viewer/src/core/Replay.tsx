import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Board } from './Board';
import { CardView } from './CardView';
import type { Focus } from './CardView';
import { humanize } from './cardImage';
import { useSettings } from './settings';
import type { Game, Seat } from './types';

const SPEEDS = [{ label: 'slow', ms: 1000 }, { label: 'normal', ms: 400 }, { label: 'fast', ms: 120 }, { label: 'turbo', ms: 30 }];

/** The shared replay view: board, transport controls, decision log and card preview. The tournament page embeds this too. */
export function Replay({ game, startStep = 0 }: { game: Game; startStep?: number }) {
    const { cardMode, setCardMode, godView, setGodView } = useSettings();
    const last = game.steps.length - 1;
    const [step, setStep] = useState(Math.min(startStep, last));
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState(1);
    const [focus, setFocus] = useState<Focus | null>(null);
    const logRef = useRef<HTMLOListElement>(null);

    useEffect(() => {
        setStep(Math.min(startStep, last));
        setPlaying(false);
    }, [game, startStep, last]);

    useEffect(() => {
        if (!playing) {
            return;
        }
        const t = setInterval(() => {
            setStep((s) => {
                if (s >= last) {
                    setPlaying(false);
                    return s;
                }
                return s + 1;
            });
        }, SPEEDS[speed].ms);
        return () => clearInterval(t);
    }, [playing, speed, last]);

    const go = useCallback((n: number) => {
        setPlaying(false);
        setStep(Math.max(0, Math.min(last, n)));
    }, [last]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const el = e.target as HTMLElement;
            if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
                return;
            }
            if (e.key === 'ArrowRight') {
                go(step + (e.shiftKey ? 10 : 1));
            } else if (e.key === 'ArrowLeft') {
                go(step - (e.shiftKey ? 10 : 1));
            } else if (e.key === ' ') {
                e.preventDefault();
                setPlaying((p) => (step >= last ? false : !p));
            } else if (e.key === 'Home') {
                go(0);
            } else if (e.key === 'End') {
                go(last);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [go, step, last]);

    useEffect(() => {
        const li = logRef.current?.children[step] as HTMLElement | undefined;
        const box = logRef.current;
        if (li && box) {
            box.scrollTop = li.offsetTop - box.clientHeight / 2;
        }
    }, [step]);

    const togglePlay = () => {
        if (step >= last) {
            setStep(0);
            setPlaying(true);
        } else {
            setPlaying(!playing);
        }
    };

    const cur = game.steps[step];
    const nextActor: Seat | null = game.steps[step + 1]?.pid ?? null;
    const bots = useMemo(() => ({
        p1: game.header.players.find((p) => p.id === 'p1')?.bot ?? 'p1',
        p2: game.header.players.find((p) => p.id === 'p2')?.bot ?? 'p2'
    }), [game]);
    const roundStarts = useMemo(() => {
        const marks: { n: number; round: number }[] = [];
        let r = 0;
        game.steps.forEach((s, i) => {
            if (s.state.round !== r) {
                r = s.state.round;
                marks.push({ n: i, round: r });
            }
        });
        return marks;
    }, [game]);
    const atEnd = step === last && game.end;

    return (
        <div className="replay">
            <div className="replay-main">
                <Board state={cur.state} bots={bots} actor={nextActor} onFocus={setFocus} />
                {atEnd && (
                    <div className="result" role="status">
                        {game.end!.winner === 'draw' ? 'Draw' : game.end!.winner ? `${bots[game.end!.winner]} (${game.end!.winner === 'p1' ? 'Player 1' : 'Player 2'}) wins` : `Ended: ${game.end!.outcome}`}
                        {' · round '}{game.end!.round}{' · '}{game.end!.steps}{' decisions'}
                        {game.end!.error ? ` · error: ${game.end!.error}` : ''}
                    </div>
                )}
                <div className="transport">
                    <button className="btn" onClick={() => go(0)} aria-label="First step">&#x23EE;</button>
                    <button className="btn" onClick={() => go(step - 1)} aria-label="Previous step">&larr;</button>
                    <button className="btn primary" onClick={togglePlay}>{playing ? 'Pause' : step >= last ? 'Replay' : 'Play'}</button>
                    <button className="btn" onClick={() => go(step + 1)} aria-label="Next step">&rarr;</button>
                    <button className="btn" onClick={() => go(last)} aria-label="Last step">&#x23ED;</button>
                    <span className="mono step-n">{step} / {last}</span>
                    <label className="field">Speed
                        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                            {SPEEDS.map((s, i) => <option key={s.label} value={i}>{s.label}</option>)}
                        </select>
                    </label>
                </div>
                <div className="scrub">
                    <input type="range" min={0} max={last} value={step} onChange={(e) => go(Number(e.target.value))} aria-label="Timeline" />
                    <div className="rounds" aria-hidden="true">
                        {roundStarts.map((m) => <i key={m.n} style={{ left: `${(m.n / Math.max(1, last)) * 100}%` }} title={`round ${m.round}`} />)}
                    </div>
                </div>
                <div className="toggles">
                    <label className="field"><input type="checkbox" checked={godView} onChange={(e) => setGodView(e.target.checked)} /> Show hands</label>
                    <label className="field"><input type="checkbox" checked={cardMode === 'images'} onChange={(e) => setCardMode(e.target.checked ? 'images' : 'tiles')} /> Card art</label>
                    <span className="muted keys">&larr; &rarr; step · shift = 10 · space play · home/end</span>
                </div>
            </div>
            <aside className="replay-side">
                <div className="preview" aria-live="polite">
                    {focus ? (
                        <>
                            <CardView card={focus.card} kind="hand" back={focus.back} />
                            <div className="preview-name">{focus.card.n}</div>
                            {focus.unit && <div className="muted mono">{focus.unit.p} power · {focus.unit.h - focus.unit.d} / {focus.unit.h} HP{focus.unit.u?.length ? ` · ${focus.unit.u.map((u) => u.n).join(', ')}` : ''}</div>}
                        </>
                    ) : <span className="muted">Hover a card to enlarge it.</span>}
                </div>
                <ol className="log" ref={logRef} aria-label="Decision log">
                    {game.steps.map((s, i) => (
                        <li key={s.n}>
                            <button onClick={() => go(i)} aria-current={i === step ? 'step' : undefined}>
                                <span className="n">{s.n}</span>
                                <span className="what">
                                    {s.pid ? <b className={`${s.pid}c`}>{bots[s.pid]}</b> : null}{' '}
                                    {s.action ? humanize(s.action.label) : s.label}
                                    <span className="pk">r{s.state.round} · {s.title ?? s.prompt ?? ''}{s.legal ? ` · ${s.legal} options` : ''}</span>
                                </span>
                            </button>
                        </li>
                    ))}
                </ol>
            </aside>
        </div>
    );
}
