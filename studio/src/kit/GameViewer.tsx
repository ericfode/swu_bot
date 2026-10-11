import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronLeft, ChevronRight, Eye, Image, Pause, Play, Radio, Shapes, SkipBack, SkipForward, Sparkles, Trophy } from 'lucide-react';
import { Board } from '../components/Board';
import type { Focus } from '../components/Card';
import { CardInspector, FloatingZoom } from '../components/CardZoom';
import { Log } from '../components/Log';
import { EVAL_LINES, LaneSwatch, Momentum, evalLabels, laneKeyOf, lanesOf, onChanceAxis, type LaneKey } from '../components/Momentum';
import { ValuesIcon } from '../components/TermIcon';
import { WeightsPanel } from '../components/WeightsPanel';
import { Spine } from './Spine';
import { ActionIcon } from './ActionIcon';
import { NoScore, ScoreBreakdown } from './ScoreBreakdown';
import { ScorePicker } from './ScorePicker';
import { classifyGame, describe, pivotalActions } from '../data/actions';
import { deltas as diff, metrics, roundStarts, trackUnits } from '../data/derive';
import { EVAL_KEYS, evalAt, evalsByIndex, type EvalFile, type EvalPoint } from '../data/evals';
import type { LensFile, LensIndex } from '../data/lensFile';
import { resolveScore, useScores, type LensInput, type ScoreSeries, type ScoreSource, type ScoreView } from '../data/score';
import type { CardRef, Game, Seat } from '../data/types';
import { endWinner, failedSeat, resultText } from '../data/result';
import { deckTitle, LangTag } from '../components/SeatFacts';
import { cardTextVersion, loadedCardCost } from '../lib/cardText';
import { humanize } from '../lib/cards';
import { spotTimeline } from '../data/atlas';
import { SPEEDS, useSettings, type Perspective } from '../lib/settings';

/** A lens file as given to the viewer: a parsed file, or a file with its dir ('' = the default path). */
export type LensEntry = LensFile | LensInput;

const isInput = (x: LensEntry): x is LensInput => 'dir' in x && 'file' in x && !('steps' in x);

/**
 * The viewer's lens files as sources' inputs. Entries with a dir keep it; a bare file is the default path when it comes
 * first (one file, as earlier builds took it), else it is keyed by its evaluator id (plus "@p1" / "@p2" for a one-seat
 * perspective), the way the registry names dirs.
 */
export function lensInputs(lens: LensEntry | LensEntry[] | null | undefined): LensInput[] {
    const list = !lens ? [] : Array.isArray(lens) ? lens : [lens];
    const used = new Set<string>();
    return list.map((x, k) => {
        let dir = '';
        if (isInput(x)) {
            dir = x.dir;
        } else if (k > 0 || used.has('')) {
            const ev = x.evaluator;
            const base = `${ev?.id ?? 'lens'}${ev?.perspective ? `@${ev.perspective}` : ''}`;
            dir = base;
            for (let j = 2; used.has(dir); j++) {
                dir = `${base}-${j}`;
            }
        }
        used.add(dir);
        return isInput(x) ? x : { dir, file: x };
    });
}

export interface ViewerControl {
    seek: (step: number) => void;
    play: () => void;
    pause: () => void;
    /** pick a score by key, as the picker does */
    setScore: (key: string) => void;
    /** the game's sources, the chosen one and its series */
    scores: () => { sources: ScoreSource[]; chosen: ScoreSource | null; series: ScoreSeries | null };
}

export interface GameViewerProps {
    game: Game;
    /** game file has no end record yet: follow the newest move */
    live?: boolean;
    startStep?: number;
    /** dashboard evals contract (dashboard/evals/<gameId>.json): adds evaluation curves, the analyst note and spine tints */
    evals?: EvalFile | null;
    /**
     * the game's lens files (swu-lens/1), one per score: one file (the default path, dashboard/lens/<gameId>.json), or a
     * list of files, each with its dir from the registry or bare. Without any, Omni v1 is estimated from the board
     */
    lens?: LensEntry | LensEntry[] | null;
    /** dashboard/lens/evaluators.json: the order of the scores in the picker, and the one to open first */
    registry?: LensIndex | null;
    /** the score to open on: a lens dir ('' = the default path) or 'estimate' (the ?score= deep link, the kit's score option) */
    score?: string | null;
    /** the reader picked another score */
    onScore?: (key: string) => void;
    /** estimate Omni v1 from the board for a game with no lens file (default true) */
    estimate?: boolean;
    /** the Strategy Atlas spots each seat is in: chips by each base and a lane per seat under the timeline (default true) */
    spots?: boolean;
    /** timeline lanes to start with; 'edge' (earlier builds) means 'score'. Default: evaluations and base HP with evals, else score and base HP */
    lanes?: string[];
    /** playhead moved: step index, and that step's Step.n (the id evaluations and other data key on) */
    onStep?: (step: number, n: number) => void;
    /** 'window' listens for arrow keys everywhere (a full page); 'focus' only while the viewer has focus (embedded) */
    keyboard?: 'window' | 'focus';
    /** 'full' adds the card inspector and decision log beside the board */
    layout?: 'full' | 'compact';
    /** caps the side panel's height when embedded; the full page sizes it to the window */
    fillWindow?: boolean;
    back?: { href: string; label: string };
    control?: (c: ViewerControl) => void;
}

/** The whole replay experience in one component: Holotable's game page and every embed (dashboard, analysis pages) use it. */
export function GameViewer({ game, live = false, startStep = 0, evals = null, lens = null, registry = null, score: requested = null, onScore, estimate, spots = true, lanes: startLanes, onStep, keyboard = 'focus', layout = 'full', fillWindow = false, back, control }: GameViewerProps) {
    const last = game.steps.length - 1;
    const [stepState, setStep] = useState(() => (live && !startStep ? last : Math.min(startStep, last)));
    // a live file can be rewritten with fewer steps (a re-run into the same folder): never read past the end
    const step = Math.max(0, Math.min(stepState, last));
    const [playing, setPlaying] = useState(false);
    const [follow, setFollow] = useState(live && !startStep);
    const [focus, setFocus] = useState<Focus | null>(null);
    const [hovering, setHovering] = useState(false);
    // the side panel sits beside the board from 64rem up; narrower, a hovered card is enlarged next to the pointer instead
    const [beside, setBeside] = useState(false);
    const [hideResult, setHideResult] = useState(false);
    const ev = useMemo(() => evalsByIndex(game, evals), [game, evals]);
    const [lanes, setLanes] = useState<LaneKey[]>(() => startLanes?.map(laneKeyOf).filter((k): k is LaneKey => !!k) ?? (evals?.points?.length ? ['llm', 'base'] : ['score', 'base']));
    // once the reader picks lanes, evals arriving late don't override the pick
    const userLanes = useRef(false);
    const toggleLane = (k: LaneKey) => {
        userLanes.current = true;
        setLanes((ls) => (ls.includes(k) ? ls.filter((x) => x !== k) : [...ls, k]));
    };
    // the timeline step under the pointer: the board score panel previews it
    const [hoverStep, setHoverStep] = useState<number | null>(null);
    const { speed, setSpeed, perspective, setPerspective, art, setArt, lens: forcedValues, score: savedScore, setScore: saveScore } = useSettings();
    const root = useRef<HTMLDivElement>(null);
    // the game's score sources (its lens files, or the Omni v1 estimate) and the chosen one resolved over every step
    const lensFiles = useMemo(() => lensInputs(lens), [lens]);
    // printed costs from the loaded card data, for the estimate and for Omni v1 files without parts; a new function
    // (and the series resolved again) only when card data arrives (each load bumps artVersion, which renders this again)
    const textVersion = cardTextVersion();
    const cardCost = useMemo(() => (c: CardRef) => loadedCardCost(c), [textVersion]);
    const { sources, source, series: score, setScore } = useScores(game, lensFiles, registry, { requested, saved: savedScore, estimate, cardCost });
    // a new requested score from outside (deep link changed) wins over an earlier pick
    useEffect(() => {
        if (requested != null) {
            setScore(requested);
        }
    }, [requested, setScore]);
    const pickScore = useCallback((key: string) => {
        setScore(key);
        saveScore(key);
        onScore?.(key);
    }, [setScore, saveScore, onScore]);
    // card values: on by default when the chosen score has file values for this game, off for an estimate; the button
    // overrides that for this game, and a switch from outside (kit showLens, setLensView) overrides the button
    const [valuesPick, setValuesPick] = useState<boolean | null>(null);
    useEffect(() => setValuesPick(null), [forcedValues]);
    const fromFile = useMemo(() => !!score?.steps.some((s) => s.status === 'file'), [score]);
    const canValues = !!score && !score.source.error && score.source.cardValues !== 'none';
    const valuesOn = canValues && (valuesPick ?? forcedValues ?? fromFile);
    // Compare: the other sources with a chance, drawn as thin lines on the timeline's % axis
    const [compare, setCompare] = useState(false);
    const comparable = useMemo(() => sources.filter((s) => s !== source && onChanceAxis(s)), [sources, source]);
    const others = useMemo(() => (compare ? comparable.map((s) => resolveScore(game, s, { cardCost })) : []), [compare, comparable, game, cardCost]);

    const ids = useMemo(() => trackUnits(game), [game]);
    const actions = useMemo(() => classifyGame(game, ev, score), [game, ev, score]);
    const pivotal = useMemo(() => pivotalActions(actions, 10), [actions]);
    const actionAt = useMemo(() => new Map(actions.map((a) => [a.index, a])), [actions]);
    const [why, setWhy] = useState<'analyst' | 'board' | 'weights'>(() => (evals?.points?.length ? 'analyst' : 'board'));
    const facts = useMemo(() => metrics(game), [game]);
    const rounds = useMemo(() => roundStarts(game), [game]);
    const spotTl = useMemo(() => (spots ? spotTimeline(game) : null), [game, spots]);
    const changes = useMemo(() => game.steps.map((s, i) => (i ? diff(game.steps[i - 1].state, s.state) : [])), [game]);
    const bots = useMemo(() => ({
        p1: game.header.players.find((p) => p.id === 'p1')?.bot ?? 'p1',
        p2: game.header.players.find((p) => p.id === 'p2')?.bot ?? 'p2'
    }), [game]);
    // recorded deck names are engine internal names ("leader#subtitle / base"); show the leader and base
    const decks = Object.fromEntries(game.header.players.map((p) => [p.id, p.deck.split(' / ').map((x) => humanize(x).split(':')[0]).join(' · ')])) as Record<Seat, string>;
    const endRound = Math.max(game.end?.round ?? 0, game.steps[last].state.round);

    useEffect(() => {
        const el = root.current;
        if (!el || typeof ResizeObserver === 'undefined') {
            return undefined;
        }
        const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        const ro = new ResizeObserver(([e]) => setBeside(e.contentRect.width >= 64 * rem));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    const onCardFocus = useCallback((f: Focus | null) => {
        setFocus(f);
        setHovering(!!f);
    }, []);
    const onCardLeave = useCallback(() => setHovering(false), []);

    // an annotated game opens on its evaluations and base HP, whenever its evals file arrives
    useEffect(() => {
        if (evals?.points?.length) {
            if (!userLanes.current) {
                setLanes(['llm', 'base']);
            }
            setWhy('analyst');
        }
    }, [evals]);

    // a new start step from outside (deep link changed) moves the playhead
    const lastStart = useRef(startStep);
    useEffect(() => {
        if (lastStart.current === startStep) {
            return;
        }
        lastStart.current = startStep;
        setPlaying(false);
        setFollow(false);
        setStep(Math.min(startStep, last));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [startStep]);

    useEffect(() => {
        if (follow) {
            setStep(last);
        }
    }, [follow, last]);

    useEffect(() => {
        onStep?.(step, game.steps[step]?.n ?? step);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step]);

    useEffect(() => {
        if (!playing) {
            return undefined;
        }
        const t = setInterval(() => setStep((s) => {
            if (s >= last) {
                setPlaying(false);
                if (live) {
                    setFollow(true);
                }
                return s;
            }
            return s + 1;
        }), SPEEDS[speed].ms);
        return () => clearInterval(t);
    }, [playing, speed, last, live]);

    const go = useCallback((n: number) => {
        const target = Math.max(0, Math.min(last, n));
        setFollow(live && target === last);
        setStep(target);
    }, [last, live]);
    const seek = useCallback((n: number) => {
        setPlaying(false);
        go(n);
    }, [go]);
    const roundJump = useCallback((dir: 1 | -1) => {
        const cur = game.steps[step].state.round;
        const target = dir > 0 ? rounds.find((r) => r.round > cur) : [...rounds].reverse().find((r) => r.round < cur);
        seek(target ? target.step : dir > 0 ? last : 0);
    }, [game, step, rounds, seek, last]);

    const scoresNow = useRef({ sources, chosen: source, series: score });
    scoresNow.current = { sources, chosen: source, series: score };
    useEffect(() => {
        control?.({ seek, play: () => setPlaying(true), pause: () => setPlaying(false), setScore: pickScore, scores: () => scoresNow.current });
    }, [control, seek, pickScore]);

    useEffect(() => {
        const target: HTMLElement | Window | null = keyboard === 'window' ? window : root.current;
        if (!target) {
            return undefined;
        }
        const onKey = (e: Event) => {
            const k = e as KeyboardEvent;
            const el = (k.composedPath?.()[0] ?? k.target) as HTMLElement;
            if (/INPUT|SELECT|TEXTAREA/.test(el.tagName ?? '') || el.closest?.('[role="listbox"]') || k.metaKey || k.ctrlKey) {
                return;
            }
            const handled = () => k.preventDefault();
            if (k.key === 'ArrowRight') {
                handled();
                seek(step + (k.shiftKey ? 10 : 1));
            } else if (k.key === 'ArrowLeft') {
                handled();
                seek(step - (k.shiftKey ? 10 : 1));
            } else if (k.key === ']' || k.key === 'ArrowDown') {
                handled();
                roundJump(1);
            } else if (k.key === '[' || k.key === 'ArrowUp') {
                handled();
                roundJump(-1);
            } else if (k.key === ' ') {
                handled();
                setPlaying((p) => (step >= last ? false : !p));
            } else if (k.key === 'Home') {
                handled();
                seek(0);
            } else if (k.key === 'End') {
                handled();
                seek(last);
            }
        };
        target.addEventListener('keydown', onKey);
        return () => target.removeEventListener('keydown', onKey);
    }, [keyboard, seek, roundJump, step, last]);

    const cur = game.steps[step];
    const prev = step > 0 ? game.steps[step - 1] : null;
    const actor: Seat | null = game.steps[step + 1]?.pid ?? null;
    const end = step === last ? game.end : null;
    const winner = endWinner(game.end);
    // v2: the bot that broke the game (it loses)
    const failed = failedSeat(game.end);
    const analysis = ev.size ? evalAt(ev, step) : null;
    // the board and the card inspector show the playhead's step
    const view = useMemo((): ScoreView | null => (score && score.steps[step] ? { source: score.source, step: score.steps[step] } : null), [score, step]);
    // the board score panel shows the playhead's step, or the one under the pointer on the timeline
    const shown = hoverStep != null && hoverStep >= 0 && hoverStep <= last ? hoverStep : step;
    const shownScore = score?.steps[shown] ?? null;
    // steps each source has values for, for the picker (the chosen one from its series)
    const gameNs = useMemo(() => new Set(game.steps.map((s) => s.n)), [game]);
    const coverageOf = useCallback((s: ScoreSource) => {
        if (score && s === score.source) {
            return { have: score.coverage.file + score.coverage.estimate, of: game.steps.length };
        }
        return s.lens ? { have: s.lens.file.steps.filter((st) => st && gameNs.has(st.n)).length, of: game.steps.length } : null;
    }, [score, game, gameNs]);
    const valuesTitle = useMemo(() => {
        const src = score?.source;
        if (!src) {
            return 'Card values: no score for this game';
        }
        if (src.error) {
            return `Card values: ${src.error}`;
        }
        if (src.cardValues === 'none') {
            return `${src.label} gives a chance only, no card values`;
        }
        const rows = src.rows.filter((r) => r.group !== 'joint').map((r) => r.label).join(', ');
        const what = src.cardValues === 'ablation' ? `what ${src.label} loses without it` : `what it is worth to its owner in ${src.label}`;
        const search = score.steps.some((st) => st.search) ? ', and mark the cards its search liked' : '';
        return `Card values: write on every card ${what}, coloured by the row it counts in (${rows})${search}. On by default when the game has a lens file for this score`;
    }, [score]);
    const stepN = useCallback((i: number) => game.steps[i]?.n ?? i, [game]);
    const prevCheckpoint = useMemo(() => {
        if (!analysis) {
            return null;
        }
        let best = -1;
        for (const k of ev.keys()) {
            if (k < analysis.index && k > best) {
                best = k;
            }
        }
        return best >= 0 ? ev.get(best) ?? null : null;
    }, [ev, analysis]);
    const lastAction = useMemo(() => {
        for (let i = step; i > 0; i--) {
            const a = actionAt.get(i);
            if (a && a.cls !== 'resource' && a.cls !== 'setup') {
                return a;
            }
        }
        return null;
    }, [actionAt, step]);

    const togglePlay = () => {
        if (step >= last) {
            if (live) {
                setFollow(true);
            } else {
                setStep(0);
                setPlaying(true);
            }
        } else {
            setPlaying(!playing);
            setFollow(false);
        }
    };

    const full = layout === 'full';
    // the Weights tab, beside the board score: for any score that resolved (a refused file has nothing to show)
    const weightsTab = !!score && !score.source.error;
    // the chosen source unless its file was refused (a refused file draws no lane)
    const liveSource = score && !score.source.error ? score.source : null;
    return (
        <div ref={root} tabIndex={keyboard === 'focus' ? 0 : undefined} className="@container flex flex-col gap-3 outline-none" aria-label={`Replay: ${bots.p1} vs ${bots.p2}`}>
            <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
                {back && <a href={back.href} className="btn" aria-label={`Back to ${back.label}`}><ChevronLeft size={16} />{back.label}</a>}
                <div className="flex items-baseline gap-3 min-w-0 flex-wrap">
                    {(['p1', 'p2'] as Seat[]).map((s, i) => (
                        <span key={s} className="flex items-baseline gap-2 min-w-0">
                            {i === 1 && <span className="text-faint font-display">vs</span>}
                            <span className="font-display text-xl font-bold" style={{ color: s === 'p1' ? 'var(--color-p1)' : 'var(--color-p2)' }}>{bots[s]}</span>
                            <LangTag header={game.header} seat={s} />
                            {winner === s && <Trophy size={16} className="text-gold self-center" aria-label="winner" />}
                            <span className="text-faint text-xs truncate max-w-[14rem]" title={deckTitle(game.header, s)}>{decks[s]}</span>
                        </span>
                    ))}
                </div>
                <div className="flex gap-2 ml-auto items-center flex-wrap">
                    <div className="inline-flex rounded-lg border border-line bg-ink p-0.5" role="group" aria-label="Card display">
                        <button className="btn !h-7 !border-0 !bg-transparent aria-pressed:!bg-raise aria-pressed:!text-fg text-dim" aria-pressed={!art} onClick={() => setArt(false)} title="Generated tiles: always available, light"><Shapes size={14} />Vector</button>
                        <button className="btn !h-7 !border-0 !bg-transparent aria-pressed:!bg-raise aria-pressed:!text-fg text-dim" aria-pressed={art} onClick={() => setArt(true)} title="Card images; cards without art fall back to tiles"><Image size={14} />Card art</button>
                    </div>
                    <ScorePicker sources={sources} chosen={source} onPick={pickScore} coverage={coverageOf} />
                    <button className="btn !h-8 !px-2 disabled:opacity-40 disabled:cursor-not-allowed" aria-pressed={valuesOn} disabled={!canValues} onClick={() => setValuesPick(!valuesOn)} aria-label="Card values"
                        title={valuesTitle}>
                        <ValuesIcon on={valuesOn} />
                    </button>
                    <span className="chip num">seed {game.header.seed}</span>
                    {game.end && <span className="chip num">{game.end.steps} decisions · R{endRound}</span>}
                    {game.end && failed && <span className="chip !text-p2 !border-p2/50" title={game.end.error ?? undefined}>{resultText(game.end, bots)}</span>}
                    {live && (
                        <button className="btn" aria-pressed={follow} onClick={() => setFollow(true)}>
                            <Radio size={14} className={follow ? 'text-p2 animate-pulse' : ''} />{follow ? 'Live' : 'Jump to live'}
                        </button>
                    )}
                </div>
            </header>

            <div className={`grid gap-3 grid-cols-[minmax(0,1fr)] min-h-0 ${full ? '@5xl:grid-cols-[minmax(0,1fr)_384px]' : ''}`}>
                <div className="flex flex-col gap-3 min-w-0">
                    <div className="panel p-2 @3xl:p-3 relative overflow-hidden">
                        <Board state={cur.state} prev={prev?.state ?? null} ids={ids[step]} prevIds={step > 0 ? ids[step - 1] : null} bots={bots} actor={actor} step={step}
                            onFocus={onCardFocus} onLeave={onCardLeave} score={view} values={valuesOn} spots={spots} />
                        <AnimatePresence>
                            {end && !hideResult && (
                                <motion.div className="absolute inset-0 z-20 grid place-items-center bg-bg/60 backdrop-blur-[2px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setHideResult(true)}>
                                    <motion.div className="panel px-8 py-6 text-center" initial={{ scale: 0.85, y: 20 }} animate={{ scale: 1, y: 0 }}>
                                        <div className="eyebrow mb-1">Round {endRound} · {end.steps} decisions</div>
                                        <div className="font-display text-3xl font-extrabold" style={{ color: winner === 'p1' ? 'var(--color-p1)' : winner === 'p2' ? 'var(--color-p2)' : undefined }}>
                                            {winner === 'draw' ? 'Draw' : winner ? `${bots[winner]} wins` : end.outcome}
                                        </div>
                                        {failed && <div className="text-dim text-sm mt-1">{bots[failed]} failed (error)</div>}
                                        {end.error && <div className="text-p2 text-sm mt-2 max-w-md">{end.error}</div>}
                                        <div className="flex gap-2 justify-center mt-4">
                                            <button className="btn" onClick={(e) => { e.stopPropagation(); seek(0); }}>Watch from the start</button>
                                            <button className="btn">Show the final board</button>
                                        </div>
                                    </motion.div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>

                    <div className="panel p-3 flex flex-col gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                            <button className="btn" onClick={() => roundJump(-1)} aria-label="Previous round"><SkipBack size={15} /></button>
                            <button className="btn" onClick={() => seek(step - 1)} aria-label="Previous decision"><ChevronLeft size={15} /></button>
                            <button className="btn primary w-24 justify-center" onClick={togglePlay}>
                                {playing ? <><Pause size={15} />Pause</> : <><Play size={15} />{step >= last ? (live ? 'Live' : 'Replay') : 'Play'}</>}
                            </button>
                            <button className="btn" onClick={() => seek(step + 1)} aria-label="Next decision"><ChevronRight size={15} /></button>
                            <button className="btn" onClick={() => roundJump(1)} aria-label="Next round"><SkipForward size={15} /></button>
                            <span className="num text-dim text-sm px-1">{cur.n}<span className="text-faint"> / {game.steps[last].n}</span></span>
                            <div className="flex gap-1 ml-auto" role="group" aria-label="Playback speed">
                                {SPEEDS.map((s, i) => <button key={s.label} className="btn !h-7 !px-2 num text-xs" aria-pressed={speed === i} onClick={() => setSpeed(i)}>{s.label}</button>)}
                            </div>
                        </div>
                        <Momentum data={facts} series={score} others={others} rounds={rounds} step={step} lanes={lanes} bots={bots} onSeek={seek} onHover={setHoverStep} stepN={stepN} evals={ev} height={ev.size ? 190 : 160} markers={pivotal} spots={spotTl} />
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                            {lanesOf(liveSource).filter((l) => (l.key !== 'llm' || ev.size) && (l.key !== 'score' || liveSource)).map((l) => {
                                const on = lanes.includes(l.key);
                                return (
                                    <button key={l.key} className={`chip hover:text-fg ${on ? '!text-fg !border-fg/50 !bg-raise' : 'opacity-70'}`} title={l.hint} aria-pressed={on} onClick={() => toggleLane(l.key)}>
                                        <LaneSwatch lane={l.key} source={l.key === 'score' ? liveSource : null} />{l.label}
                                    </button>
                                );
                            })}
                            {comparable.length > 0 && (
                                <button className={`chip hover:text-fg ${compare ? '!text-fg !border-fg/50 !bg-raise' : 'opacity-70'}`} aria-pressed={compare} onClick={() => setCompare(!compare)}
                                    title="Draw the other scores that give a chance to win as thin lines on the % axis">
                                    Compare
                                </button>
                            )}
                            <span className="ml-auto text-faint hidden @3xl:inline">← → step · shift ×10 · [ ] round · space play</span>
                        </div>
                        <div className="@container rounded-lg bg-ink/70 border border-line">
                            {(ev.size > 0 || weightsTab) && (
                                <div className="flex items-center gap-1 px-2 pt-1.5" role="tablist" aria-label="Why the curves look this way">
                                    {ev.size > 0 && <button role="tab" aria-selected={why === 'analyst'} className={`chip @3xl:hidden ${why === 'analyst' ? '!text-fg !border-fg/50 !bg-raise' : ''}`} onClick={() => setWhy('analyst')}><Sparkles size={11} />Analyst</button>}
                                    {/* side by side with the analyst, the board score also shows while the Analyst tab is picked */}
                                    <button role="tab" aria-selected={why === 'board'} className={`chip ${why === 'board' ? '!text-fg !border-fg/50 !bg-raise' : why === 'analyst' ? '@3xl:!text-fg @3xl:!border-fg/50 @3xl:!bg-raise' : ''}`} onClick={() => setWhy('board')}>Board score</button>
                                    {weightsTab && <button role="tab" aria-selected={why === 'weights'} className={`chip ${why === 'weights' ? '!text-fg !border-fg/50 !bg-raise' : ''}`} onClick={() => setWhy('weights')}>Weights</button>}
                                </div>
                            )}
                            {/* with evaluations: the analyst and the board score (or weights) side by side when there is room, tabs when there isn't */}
                            <div className={ev.size ? 'grid @3xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] @3xl:divide-x divide-line' : ''}>
                                {ev.size > 0 && (
                                    <div className={`px-3 py-2 min-w-0 ${why === 'analyst' ? '' : 'hidden'} @3xl:block`}>
                                        {analysis
                                            ? <Analysis point={analysis.point} prev={prevCheckpoint} at={game.steps[analysis.index].n} ago={step - analysis.index} bots={bots} evaluator={evals?.evaluator?.model} />
                                            : <span className="text-faint text-sm">The analysis starts at step {game.steps[Math.min(...ev.keys())].n}.</span>}
                                    </div>
                                )}
                                <div className={`px-3 py-2 min-w-0 ${why === 'board' || (why === 'analyst' && !ev.size) ? '' : why === 'analyst' ? 'hidden @3xl:block' : 'hidden'}`}>
                                    {score && shownScore
                                        ? <ScoreBreakdown series={score} step={shownScore} prev={shown > 0 ? score.steps[shown - 1] ?? null : null} state={game.steps[shown].state} bots={bots}
                                            previewN={shown !== step ? game.steps[shown].n : null} />
                                        : <NoScore />}
                                </div>
                                {weightsTab && score && shownScore && (
                                    <div className={`px-3 py-2 min-w-0 ${why === 'weights' ? '' : 'hidden'}`}>
                                        <WeightsPanel series={score} step={shownScore} />
                                    </div>
                                )}
                            </div>
                        </div>
                        <Spine game={game} step={step} evals={ev} onSeek={seek} />
                    </div>
                </div>

                {full && (
                    <aside className={`flex flex-col gap-3 min-h-0 ${fillWindow ? '@5xl:h-[calc(100vh-110px)] @5xl:sticky @5xl:top-3' : '@5xl:max-h-[960px]'}`}>
                        <div className="panel p-3 shrink-0 overflow-y-auto @5xl:max-h-[72%]">
                            {focus ? <CardInspector focus={focus} score={valuesOn || !canValues ? view : null} /> : (
                                <div className="flex flex-col items-center gap-2 py-2">
                                    {lastAction ? (
                                        <>
                                            <span className="eyebrow">Last play · step {game.steps[lastAction.index].n}</span>
                                            <ActionIcon cls={lastAction.cls} seat={lastAction.seat} card={lastAction.card} outcome={lastAction.outcome} size={150} caption={describe(lastAction, bots[lastAction.seat])} />
                                        </>
                                    ) : null}
                                    <span className="text-faint text-[12px]">Hover or tap a card on the board to see it here at full size.</span>
                                </div>
                            )}
                        </div>
                        <div className="panel flex flex-col min-h-[320px] max-h-[640px] @5xl:max-h-none @5xl:min-h-[200px] flex-1 overflow-hidden">
                            <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
                                <span className="eyebrow">Decisions</span>
                                <label className="ml-auto flex items-center gap-1 text-xs text-dim">
                                    <Eye size={13} />
                                    <select className="bg-transparent text-xs outline-none" value={perspective} onChange={(e) => setPerspective(e.target.value as Perspective)} aria-label="Whose hand to show">
                                        <option value="god">Both hands</option>
                                        <option value="p1">{bots.p1}'s view</option>
                                        <option value="p2">{bots.p2}'s view</option>
                                    </select>
                                </label>
                            </div>
                            <Log game={game} bots={bots} deltas={changes} step={step} onGo={seek} actions={actionAt} />
                        </div>
                    </aside>
                )}
            </div>
            <AnimatePresence>
                {focus && hovering && !(full && beside) && <FloatingZoom key={`${focus.card.n}:${focus.rect?.left}:${focus.rect?.top}`} focus={focus} score={valuesOn ? view : null} />}
            </AnimatePresence>
        </div>
    );
}

const pct = (v: number | undefined) => (v == null ? '–' : `${Math.round(v * 100)}%`);

/**
 * The analyst's read at the playhead: the chance player 1 wins from each viewpoint at the latest checkpoint, how much
 * each moved since the checkpoint before, and the note. Swatches match the timeline's curves.
 */
function Analysis({ point, prev, at, ago, bots, evaluator }: { point: EvalPoint; prev: EvalPoint | null; at: number; ago: number; bots: Record<Seat, string>; evaluator?: string }) {
    const labels = evalLabels(bots);
    return (
        <motion.div key={at} initial={{ opacity: 0.4, y: 4 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-1.5">
            <span className="text-[12px] text-dim flex items-center gap-1.5" title={evaluator ? `Evaluator: ${evaluator}` : undefined}>
                <Sparkles size={12} className="shrink-0" />
                <span>Chance <b style={{ color: 'var(--color-p1)' }}>{bots.p1}</b> (p1) wins · checkpoint at step {at}{ago > 0 ? ` (${ago} step${ago === 1 ? '' : 's'} ago)` : ''}</span>
            </span>
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-0.5 text-[12px]">
                {EVAL_LINES.map((l) => {
                    const v = point[l.key];
                    const p = prev?.[l.key];
                    const d = v != null && p != null ? Math.round((v - p) * 100) : null;
                    const hint = EVAL_KEYS.find((k) => k.key === l.key)?.hint;
                    return [
                        <span key={`${l.key}s`} className="inline-block w-4 border-t-2" style={{ borderColor: l.color, borderTopStyle: l.dash ? 'dashed' : 'solid' }} />,
                        <span key={`${l.key}l`} className="text-dim truncate" title={hint}>{labels[l.key]}</span>,
                        <b key={`${l.key}v`} className="num text-fg text-right">{pct(v)}</b>,
                        <span key={`${l.key}d`} className="num text-[11px] w-10 text-right" title="change since the previous checkpoint"
                            style={{ color: d == null || d === 0 ? 'var(--color-faint)' : d > 0 ? 'var(--color-p1)' : 'var(--color-p2)' }}>
                            {d == null ? '' : d === 0 ? '±0' : `${d > 0 ? '▲' : '▼'}${Math.abs(d)}`}
                        </span>
                    ];
                })}
            </div>
            {point.note && <p className="m-0 text-dim text-[12.5px] leading-snug">{point.note}</p>}
        </motion.div>
    );
}
