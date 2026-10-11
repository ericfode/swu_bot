import { memo, type CSSProperties } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { BrainCircuit, Crown, Layers, Library, Skull } from 'lucide-react';
import { Card, CardBack, type CardValue, type Focus } from './Card';
import { useSettings } from '../lib/settings';
import { humanize } from '../lib/cards';
import type { PlayerSnap, Seat, Snapshot, UnitRef } from '../data/types';
import type { UnitIds } from '../data/derive';
import { TERM_COLOR, type LensSearch, type LensSide, type LensView, type TermKey } from '../data/lens';
import { TermIcon } from './TermIcon';

interface BoardProps {
    state: Snapshot;
    prev: Snapshot | null;
    ids: UnitIds[number];
    prevIds: UnitIds[number] | null;
    bots: Record<Seat, string>;
    actor: Seat | null;
    step: number;
    onFocus: (f: Focus | null) => void;
    /** the pointer left a card (the floating zoom closes; the side inspector keeps the last card) */
    onLeave?: () => void;
    /** card values to draw on the board (the lens), or null */
    lens?: LensView | null;
}

const spring = { type: 'spring', stiffness: 420, damping: 32 } as const;
const fmt = (v: number) => v.toFixed(1);
const termStyle = (term: TermKey) => ({ '--term': TERM_COLOR[term] }) as CSSProperties;
const TERM_LABEL: Record<TermKey, string> = { ground: 'Ground units', space: 'Space units', base: 'Base', hand: 'Hand', resources: 'Resources', initiative: 'Initiative' };

/** Floating "-3" / "+2" over a unit or base whose damage changed since the previous step. */
function Pop({ delta, k }: { delta: number; k: string }) {
    if (!delta) {
        return null;
    }
    return (
        <motion.span key={k} className={`pop${delta < 0 ? ' heal' : ''}`} initial={{ opacity: 0, y: 6, scale: 0.7 }}
            animate={{ opacity: [0, 1, 1, 0], y: -34, scale: 1.15 }} transition={{ duration: 1.1, times: [0, 0.15, 0.7, 1] }}>
            {delta > 0 ? `-${delta}` : `+${-delta}`}
        </motion.span>
    );
}

/** Per-seat lens values lined up with the snapshot, plus the search's per-card regrets when that seat is the one deciding. */
interface SeatLens {
    side: LensSide;
    search: LensSearch | null;
    /** the most valuable unit on the whole table, for the glow */
    max: number;
}

function valueOf(seat: Seat, sl: SeatLens | null, zone: 'ground' | 'space' | 'hand', i: number): CardValue | null {
    if (!sl) {
        return null;
    }
    const v = sl.side[zone][i] ?? null;
    return { v, seat, term: zone, heat: zone === 'hand' || v == null ? 0 : Math.max(0, v) / sl.max, regret: sl.search?.[zone]?.[i] ?? null };
}

function Lane({ label, seat, arena, units, ids, prevUnits, prevIds, leader, step, onFocus, onLeave, sl }: {
    label: string; seat: Seat; arena: 'ground' | 'space'; units: UnitRef[]; ids: string[]; prevUnits: UnitRef[] | null; prevIds: string[] | null;
    leader: PlayerSnap['leader']; step: number; onFocus: (f: Focus | null) => void; onLeave?: () => void; sl: SeatLens | null;
}) {
    const total = sl ? sl.side[arena].reduce((a, b) => a + b, 0) : 0;
    return (
        <div className="lane">
            <span className="lane-label flex items-center gap-2">{label}{sl && units.length > 0 && (
                <span className="lens-chip !text-[10px] !tracking-normal" style={termStyle(arena)} title={`This player's ${label} units together: the ${TERM_LABEL[arena]} row of the board score`}>
                    <TermIcon term={arena} size={10} />{fmt(total)}
                </span>
            )}</span>
            <AnimatePresence mode="popLayout" initial={false}>
                {units.map((u, i) => {
                    const id = ids[i];
                    const pi = prevIds ? prevIds.indexOf(id) : -1;
                    const before = pi >= 0 && prevUnits ? prevUnits[pi] : null;
                    const isLeader = !!leader?.dep && u.n === leader.n && u.s === leader.s;
                    return (
                        <motion.div key={id} layout className="relative" transition={spring}
                            initial={{ opacity: 0, scale: 0.6, y: seat === 'p1' ? 40 : -40 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.4, rotate: seat === 'p1' ? -14 : 14, filter: 'blur(6px)', transition: { duration: 0.35 } }}>
                            <Card card={u} unit={u} back={isLeader} exhausted={!!u.x} onFocus={onFocus} onLeave={onLeave} note={isLeader ? 'Deployed leader' : undefined}
                                value={valueOf(seat, sl, arena, i)} />
                            <Pop k={`${step}`} delta={before ? u.d - before.d : 0} />
                        </motion.div>
                    );
                })}
            </AnimatePresence>
        </div>
    );
}

function Hq({ seat, p, prev, bot, step, onFocus, onLeave, sl }: { seat: Seat; p: PlayerSnap; prev: PlayerSnap | null; bot: string; step: number; onFocus: (f: Focus | null) => void; onLeave?: () => void; sl: SeatLens | null }) {
    const left = Math.max(0, p.base.hp - p.base.d);
    const frac = left / p.base.hp;
    const R = 34;
    const C = 2 * Math.PI * R;
    const deployed = p.leader?.dep === 1;
    const baseNote = `Base · ${left} of ${p.base.hp} HP left`;
    return (
        <div className="flex flex-col items-center gap-2 min-w-0">
            <div className="relative">
                <Card card={p.base} shape="wide" kind="base" hpLeft={left} note={baseNote} onFocus={onFocus} onLeave={onLeave} value={sl ? { v: sl.side.base, seat, term: 'base' } : null} />
                <svg viewBox="0 0 80 80" className="absolute -right-3 -top-3 size-14 drop-shadow-lg pointer-events-none" aria-label={`Base HP ${left} of ${p.base.hp}`}>
                    <circle cx="40" cy="40" r="38" fill="#060a13" />
                    <circle cx="40" cy="40" r={R} fill="none" stroke="#1d2a44" strokeWidth="6" />
                    <motion.circle cx="40" cy="40" r={R} fill="none" stroke={frac < 0.35 ? '#ff5f6d' : 'var(--seat)'} strokeWidth="6" strokeLinecap="round"
                        transform="rotate(-90 40 40)" strokeDasharray={C} initial={false} animate={{ strokeDashoffset: C * (1 - frac) }} transition={{ duration: 0.5 }} />
                    <text x="40" y="47" textAnchor="middle" fontFamily="Oxanium, sans-serif" fontWeight="800" fontSize="22" fill="#dce6fb">{left}</text>
                </svg>
                <Pop k={`b${step}`} delta={prev ? p.base.d - prev.base.d : 0} />
            </div>
            <div className="flex items-center gap-2">
                {p.leader && (deployed
                    ? <div className="card wide sm grid place-items-center text-[9px] leading-tight text-center text-dim border border-dashed border-line" style={{ background: 'transparent', boxShadow: 'none' }}>leader<br />deployed</div>
                    : <Card card={p.leader} size="sm" shape="wide" kind="leader" exhausted={!!p.leader.x} onFocus={onFocus} onLeave={onLeave} note="Leader"
                        value={sl?.search && sl.search.leader != null ? { v: null, seat, regret: sl.search.leader } : null} />)}
                <div className="flex flex-col gap-1 min-w-0">
                    <span className="flex items-center gap-1.5 min-w-0">
                        <span className="font-display text-[13px] font-semibold truncate max-w-[9rem]" style={{ color: 'var(--seat)' }}>{bot}</span>
                        {sl && <span className="lens-chip" style={{ '--seat': `var(--color-${seat})` } as CSSProperties} title="This player's total in the omni bot's board score: every coloured number on their side added up">Σ {fmt(sl.side.total)}</span>}
                    </span>
                    <div className="flex items-center gap-1.5">
                        <div className="pips" aria-label={`${p.res.ready} of ${p.res.total} resources ready`}>
                            {Array.from({ length: p.res.total }, (_, i) => <i key={i} className={i < p.res.ready ? '' : 'spent'} />)}
                        </div>
                        {sl && <span className="lens-chip !text-[10px]" style={termStyle('resources')} title="All resources together: the Resources row of the board score"><TermIcon term="resources" size={10} />{fmt(sl.side.resources)}</span>}
                    </div>
                    <div className="flex gap-2 text-[11px] text-dim num">
                        <span title="Cards in hand" className="inline-flex items-center gap-0.5"><Layers size={11} />{p.hand.length}</span>
                        <span title="Cards in deck" className="inline-flex items-center gap-0.5"><Library size={11} />{p.deck}</span>
                        <span title="Cards in discard" className="inline-flex items-center gap-0.5"><Skull size={11} />{p.discard.length}</span>
                        <span className="text-faint">{p.res.ready}/{p.res.total}</span>
                    </div>
                </div>
            </div>
        </div>
    );
}

function Hand({ seat, p, onFocus, onLeave, sl }: { seat: Seat; p: PlayerSnap; onFocus: (f: Focus | null) => void; onLeave?: () => void; sl: SeatLens | null }) {
    const perspective = useSettings((s) => s.perspective);
    const visible = perspective === 'god' || perspective === seat;
    // hand cards all score the same; a per-card number only when they differ
    const flat = !sl || sl.side.hand.every((v) => v === sl.side.hand[0]);
    const handTotal = sl ? sl.side.hand.reduce((a, b) => a + b, 0) : 0;
    return (
        <div className="flex gap-1.5 overflow-x-auto py-1 px-1 min-h-[72px] items-center" aria-label={`${seat} hand`}>
            <AnimatePresence initial={false} mode="popLayout">
                {p.hand.map((c, i) => {
                    const v = valueOf(seat, sl, 'hand', i);
                    const shown = v && flat ? { ...v, v: null } : v;
                    return (
                        <motion.div key={`${c.n}-${i}`} layout initial={{ opacity: 0, y: seat === 'p1' ? 20 : -20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.7 }} transition={spring}>
                            {visible ? <Card card={c} size="sm" kind="hand" onFocus={onFocus} onLeave={onLeave} note="In hand" value={shown} /> : <CardBack size="sm" value={shown} />}
                        </motion.div>
                    );
                })}
            </AnimatePresence>
            {p.hand.length === 0 && <span className="text-faint text-xs">empty hand</span>}
            {sl && p.hand.length > 0 && (
                <span className="lens-chip ml-1 shrink-0" style={termStyle('hand')} title="Cards in hand: the Hand row of the board score">
                    <TermIcon term="hand" size={10} />
                    {flat ? `${p.hand.length} × ${fmt(sl.side.hand[0])} = ${fmt(handTotal)}` : fmt(handTotal)}
                </span>
            )}
        </div>
    );
}

function Side({ seat, props, sl }: { seat: Seat; props: BoardProps; sl: SeatLens | null }) {
    const { state, prev, ids, prevIds, bots, actor, step, onFocus, onLeave } = props;
    const p = state.players[seat];
    const pp = prev?.players[seat] ?? null;
    const hasInit = state.initiative === seat;
    const row = (
        <div className={`grid gap-2 grid-cols-2 @2xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-stretch rounded-2xl p-2 transition-shadow ${actor === seat ? 'to-act' : ''}`}>
            <Lane label="ground" seat={seat} arena="ground" units={p.ground} ids={ids[seat].ground} prevUnits={pp?.ground ?? null} prevIds={prevIds?.[seat].ground ?? null} leader={p.leader} step={step} onFocus={onFocus} onLeave={onLeave} sl={sl} />
            <div className="relative px-2 py-1 flex flex-col items-center justify-center col-span-2 @2xl:col-span-1 order-first @2xl:order-none">
                <Hq seat={seat} p={p} prev={pp} bot={bots[seat]} step={step} onFocus={onFocus} onLeave={onLeave} sl={sl} />
                {hasInit && (
                    <motion.div layoutId="initiative" transition={spring} title={sl ? `Initiative: ${fmt(sl.side.initiative)} points` : 'Initiative'}
                        className="absolute -left-1 top-1 flex flex-col items-center gap-0.5">
                        <span className="size-7 rounded-full grid place-items-center bg-gold text-ink shadow-[0_0_18px_-2px_var(--color-gold)]"><Crown size={15} strokeWidth={2.5} /></span>
                        {sl && <span className="lens-chip !text-[10px]" style={termStyle('initiative')}>{fmt(sl.side.initiative)}</span>}
                    </motion.div>
                )}
            </div>
            <Lane label="space" seat={seat} arena="space" units={p.space} ids={ids[seat].space} prevUnits={pp?.space ?? null} prevIds={prevIds?.[seat].space ?? null} leader={p.leader} step={step} onFocus={onFocus} onLeave={onLeave} sl={sl} />
        </div>
    );
    return (
        <section className={`seat-${seat} flex flex-col gap-1`} aria-label={`${bots[seat]} (${seat})`}>
            {seat === 'p2' ? <><Hand seat={seat} p={p} onFocus={onFocus} onLeave={onLeave} sl={sl} />{row}</> : <>{row}<Hand seat={seat} p={p} onFocus={onFocus} onLeave={onLeave} sl={sl} /></>}
        </section>
    );
}

/** The lens's centre line: both totals as a tug of war, and what the omni bot's search saw when it is about to move. */
function LensLine({ lens, bots, state }: { lens: LensView; bots: Record<Seat, string>; state: Snapshot }) {
    const edge = lens.edge;
    const lead: Seat | null = edge > 0.5 ? 'p1' : edge < -0.5 ? 'p2' : null;
    const w = Math.min(50, (Math.abs(edge) / 40) * 50);
    const s = lens.search;
    return (
        <div className="flex flex-col gap-1 px-2">
            <div className="flex items-center gap-3">
                <span className="lens-chip seat-p2 shrink-0" title={`${bots.p2}'s total`}>{bots.p2} Σ {fmt(lens.p2.total)}</span>
                <div className="relative h-2 flex-1 rounded-full bg-ink/80 overflow-hidden" title="p1 total − p2 total">
                    <span className="absolute left-1/2 top-0 bottom-0 w-px bg-line" />
                    <motion.span className="absolute top-0 bottom-0 rounded-full" initial={false} animate={{ left: edge >= 0 ? '50%' : `${50 - w}%`, width: `${w}%` }}
                        style={{ background: edge >= 0 ? 'var(--color-p1)' : 'var(--color-p2)' }} transition={{ type: 'spring', stiffness: 300, damping: 30 }} />
                </div>
                <span className="lens-chip seat-p1 shrink-0" title={`${bots.p1}'s total`}>{bots.p1} Σ {fmt(lens.p1.total)}</span>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5 text-[11px] text-dim">
                <span className="eyebrow !text-[10px]">round {state.round} · {state.phase}</span>
                <span className="num" title="Omni score: player 1's total minus player 2's, the same number as the timeline's Omni score curve and the breakdown's total">
                    <span className="text-faint">score </span><b style={{ color: 'var(--color-edge)' }}>{edge >= 0 ? '+' : '−'}{Math.abs(edge).toFixed(1)}</b>
                    {lead ? <> · <b style={{ color: `var(--color-${lead})` }}>{bots[lead]}</b> ahead</> : ' · even'}
                </span>
                <span className="text-faint">{lens.exact ? 'omni lens file' : 'estimated (no lens file, cost left out)'}</span>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-0.5 text-[10.5px]" aria-label="What the colours mean">
                {(Object.keys(TERM_LABEL) as TermKey[]).map((t) => (
                    <span key={t} className="inline-flex items-center gap-1" style={{ color: TERM_COLOR[t] }}><TermIcon term={t} size={10} />{TERM_LABEL[t]}</span>
                ))}
                <span className="text-faint">· each colour is one row of the board score</span>
            </div>
            {s && (
                <div className={`seat-${s.by} flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-[11px]`}>
                    <BrainCircuit size={13} style={{ color: 'var(--seat)' }} />
                    <span><b style={{ color: 'var(--seat)' }}>{bots[s.by]}</b> <span className="text-dim">searched this board:</span></span>
                    {s.pv?.length ? <span className="text-fg">plan {s.pv.map(humanize).join(' → ')}</span> : null}
                    <span className="num text-faint">{[s.depth != null && `depth ${s.depth}`, s.nodes != null && `${s.nodes} nodes`, s.ms != null && `${(s.ms / 1000).toFixed(2)} s`].filter(Boolean).join(' · ')}</span>
                    {Object.entries(s.buttons ?? {}).map(([b, v]) => (
                        <span key={b} className={`lensr sm${v >= -0.05 ? ' pick' : ''}`}>{b} {v >= -0.05 ? '★' : `−${Math.abs(v).toFixed(1)}`}</span>
                    ))}
                </div>
            )}
        </div>
    );
}

function BoardImpl(props: BoardProps) {
    const { lens, state, bots } = props;
    const sls = (() => {
        if (!lens) {
            return null;
        }
        const all = [lens.p1.ground, lens.p1.space, lens.p2.ground, lens.p2.space].flat();
        const max = Math.max(1, ...all);
        const mk = (seat: Seat): SeatLens => ({ side: lens[seat], search: lens.search?.by === seat ? lens.search : null, max });
        return { p1: mk('p1'), p2: mk('p2') };
    })();
    return (
        <div className="flex flex-col gap-2">
            <Side seat="p2" props={props} sl={sls?.p2 ?? null} />
            {lens ? <LensLine lens={lens} bots={bots} state={state} /> : (
                <div className="flex items-center gap-3 px-2" aria-hidden="true">
                    <div className="h-px flex-1 bg-gradient-to-r from-transparent via-p2/40 to-transparent" />
                    <span className="eyebrow">round {state.round} · {state.phase}</span>
                    <div className="h-px flex-1 bg-gradient-to-r from-transparent via-p1/40 to-transparent" />
                </div>
            )}
            <Side seat="p1" props={props} sl={sls?.p1 ?? null} />
        </div>
    );
}

/** The table: both seats, the centre line, and the lens when it is on. Memoised: the timeline's hover re-renders the page but not the board. */
export const Board = memo(BoardImpl);
