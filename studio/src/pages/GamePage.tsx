import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronLeft, ChevronRight, Eye, Pause, Play, Radio, SkipBack, SkipForward, Trophy } from 'lucide-react';
import { Board } from '../components/Board';
import { Card, type Focus } from '../components/Card';
import { Log } from '../components/Log';
import { LANES, Momentum, type LaneKey } from '../components/Momentum';
import { deltas as diff, metrics, roundStarts, trackUnits } from '../data/derive';
import { useGame } from '../data/hooks';
import type { Game, Seat } from '../data/types';
import { humanize } from '../lib/cards';
import { hrefTournament, replaceStep } from '../lib/route';
import { SPEEDS, useSettings, type Perspective } from '../lib/settings';

export function GamePage({ tid, gid, startStep }: { tid: string; gid: string; startStep: number }) {
    const { game, error, live } = useGame(tid, gid);
    if (error && !game) {
        return <div className="p-8 text-p2">Couldn't load this game: {error}</div>;
    }
    if (!game) {
        return <div className="p-8 text-dim">Loading game…</div>;
    }
    return <Replay key={`${tid}/${gid}`} tid={tid} gid={gid} game={game} live={live} startStep={startStep} />;
}

function Replay({ tid, gid, game, live, startStep }: { tid: string; gid: string; game: Game; live: boolean; startStep: number }) {
    const last = game.steps.length - 1;
    const [step, setStep] = useState(() => (live && !startStep ? last : Math.min(startStep, last)));
    const [playing, setPlaying] = useState(false);
    const [follow, setFollow] = useState(live && !startStep);
    const [focus, setFocus] = useState<Focus | null>(null);
    const [hideResult, setHideResult] = useState(false);
    const [lanes, setLanes] = useState<LaneKey[]>(['base', 'edge']);
    const { speed, setSpeed, perspective, setPerspective, art, setArt } = useSettings();

    const ids = useMemo(() => trackUnits(game), [game]);
    const series = useMemo(() => metrics(game), [game]);
    const rounds = useMemo(() => roundStarts(game), [game]);
    const changes = useMemo(() => game.steps.map((s, i) => (i ? diff(game.steps[i - 1].state, s.state) : [])), [game]);
    const bots = useMemo(() => ({
        p1: game.header.players.find((p) => p.id === 'p1')?.bot ?? 'p1',
        p2: game.header.players.find((p) => p.id === 'p2')?.bot ?? 'p2'
    }), [game]);
    // recorded deck names are engine internal names ("leader#subtitle / base"); show the leader and base
    const decks = Object.fromEntries(game.header.players.map((p) => [p.id, p.deck.split(' / ').map((x) => humanize(x).split(':')[0]).join(' · ')])) as Record<Seat, string>;
    const endRound = Math.max(game.end?.round ?? 0, game.steps[last].state.round);

    // a deep link to another step of the game already open (?step= changed by hand or by a link)
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
        const t = setTimeout(() => replaceStep(tid, gid, step), 250);
        return () => clearTimeout(t);
    }, [tid, gid, step]);

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

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const el = e.target as HTMLElement;
            if (/INPUT|SELECT|TEXTAREA/.test(el.tagName) || e.metaKey || e.ctrlKey) {
                return;
            }
            const k = e.key;
            if (k === 'ArrowRight') {
                seek(step + (e.shiftKey ? 10 : 1));
            } else if (k === 'ArrowLeft') {
                seek(step - (e.shiftKey ? 10 : 1));
            } else if (k === ']' || k === 'ArrowDown') {
                e.preventDefault();
                roundJump(1);
            } else if (k === '[' || k === 'ArrowUp') {
                e.preventDefault();
                roundJump(-1);
            } else if (k === ' ') {
                e.preventDefault();
                setPlaying((p) => (step >= last ? false : !p));
            } else if (k === 'Home') {
                seek(0);
            } else if (k === 'End') {
                seek(last);
            } else {
                return;
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [seek, roundJump, step, last]);

    const cur = game.steps[step];
    const prev = step > 0 ? game.steps[step - 1] : null;
    const actor: Seat | null = game.steps[step + 1]?.pid ?? null;
    const end = step === last ? game.end : null;
    const winner = game.end?.winner;

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

    return (
        <div className="flex flex-col gap-3 px-4 py-3 md:py-4 min-h-full">
            <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <a href={hrefTournament(tid)} className="btn" aria-label="Back to tournament"><ChevronLeft size={16} />{tid}</a>
                <div className="flex items-baseline gap-3 min-w-0 flex-wrap">
                    {(['p1', 'p2'] as Seat[]).map((s, i) => (
                        <span key={s} className="flex items-baseline gap-2 min-w-0">
                            {i === 1 && <span className="text-faint font-display">vs</span>}
                            <span className="font-display text-xl font-bold" style={{ color: s === 'p1' ? 'var(--color-p1)' : 'var(--color-p2)' }}>{bots[s]}</span>
                            {winner === s && <Trophy size={16} className="text-gold self-center" aria-label="winner" />}
                            <span className="text-faint text-xs truncate max-w-[14rem]">{decks[s]}</span>
                        </span>
                    ))}
                </div>
                <div className="flex gap-2 ml-auto items-center">
                    <span className="chip num">seed {game.header.seed}</span>
                    {game.end && <span className="chip num">{game.end.steps} decisions · R{endRound}</span>}
                    {live && (
                        <button className="btn" aria-pressed={follow} onClick={() => setFollow(true)}>
                            <Radio size={14} className={follow ? 'text-p2 animate-pulse' : ''} />{follow ? 'Live' : 'Jump to live'}
                        </button>
                    )}
                </div>
            </header>

            <div className="grid gap-3 grid-cols-[minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_340px] min-h-0">
                <div className="flex flex-col gap-3 min-w-0">
                    <div className="panel p-2 md:p-3 relative overflow-hidden">
                        <Board state={cur.state} prev={prev?.state ?? null} ids={ids[step]} prevIds={step > 0 ? ids[step - 1] : null} bots={bots} actor={actor} step={step} onFocus={setFocus} />
                        <AnimatePresence>
                            {end && !hideResult && (
                                <motion.div className="absolute inset-0 grid place-items-center bg-bg/60 backdrop-blur-[2px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setHideResult(true)}>
                                    <motion.div className="panel px-8 py-6 text-center" initial={{ scale: 0.85, y: 20 }} animate={{ scale: 1, y: 0 }}>
                                        <div className="eyebrow mb-1">Round {endRound} · {end.steps} decisions</div>
                                        <div className="font-display text-3xl font-extrabold" style={{ color: end.winner === 'p1' ? 'var(--color-p1)' : end.winner === 'p2' ? 'var(--color-p2)' : undefined }}>
                                            {end.winner === 'draw' ? 'Draw' : end.winner ? `${bots[end.winner]} wins` : end.outcome}
                                        </div>
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
                            <span className="num text-dim text-sm px-1">{step}<span className="text-faint"> / {last}</span></span>
                            <div className="flex gap-1 ml-auto" role="group" aria-label="Playback speed">
                                {SPEEDS.map((s, i) => <button key={s.label} className="btn !h-7 !px-2 num text-xs" aria-pressed={speed === i} onClick={() => setSpeed(i)}>{s.label}</button>)}
                            </div>
                        </div>
                        <Momentum data={series} rounds={rounds} step={step} lanes={lanes} bots={bots} onSeek={seek} />
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                            {LANES.map((l) => (
                                <button key={l.key} className="chip hover:text-fg" title={l.hint} aria-pressed={lanes.includes(l.key)}
                                    style={lanes.includes(l.key) ? { borderColor: '#f6c454', color: '#f6c454' } : undefined}
                                    onClick={() => setLanes((ls) => (ls.includes(l.key) ? ls.filter((x) => x !== l.key) : [...ls, l.key]))}>{l.label}</button>
                            ))}
                            <span className="ml-auto text-faint hidden md:inline">← → step · shift ×10 · [ ] round · space play</span>
                        </div>
                    </div>
                </div>

                <aside className="flex flex-col gap-3 min-h-0 xl:h-[calc(100vh-110px)] xl:sticky xl:top-3">
                    <div className="panel p-3 flex gap-3 items-start min-h-[164px]">
                        {focus ? (
                            <>
                                <Card card={focus.card} back={focus.back} unit={focus.unit} />
                                <div className="min-w-0 flex flex-col gap-1">
                                    <div className="font-display font-semibold leading-tight">{focus.card.n}</div>
                                    {focus.note && <div className="text-xs text-dim">{focus.note}</div>}
                                    {focus.unit && <div className="num text-xs text-dim">{focus.unit.p} power · {focus.unit.h - focus.unit.d}/{focus.unit.h} HP{focus.unit.x ? ' · exhausted' : ''}</div>}
                                    {focus.unit?.u?.map((u, i) => <div key={i} className="text-xs text-gold">+ {u.n}{u.t ? ' (token)' : ''}</div>)}
                                    <div className="num text-[11px] text-faint">{focus.card.s ?? 'token'}</div>
                                </div>
                            </>
                        ) : (
                            <div className="text-faint text-sm self-center">Hover or focus a card to inspect it.</div>
                        )}
                    </div>
                    <div className="panel flex flex-col min-h-[320px] xl:min-h-0 flex-1 overflow-hidden">
                        <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
                            <span className="eyebrow">Decisions</span>
                            <label className="ml-auto flex items-center gap-1 text-xs text-dim">
                                <Eye size={13} />
                                <select id="perspective" className="bg-transparent text-xs outline-none" value={perspective} onChange={(e) => setPerspective(e.target.value as Perspective)} aria-label="Whose hand to show">
                                    <option value="god">Both hands</option>
                                    <option value="p1">{bots.p1}'s view</option>
                                    <option value="p2">{bots.p2}'s view</option>
                                </select>
                            </label>
                            <label className="flex items-center gap-1 text-xs text-dim"><input id="art" type="checkbox" checked={art} onChange={(e) => setArt(e.target.checked)} />Art</label>
                        </div>
                        <Log game={game} bots={bots} deltas={changes} step={step} onGo={seek} />
                    </div>
                </aside>
            </div>
        </div>
    );
}
