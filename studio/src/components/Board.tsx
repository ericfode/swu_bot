import { AnimatePresence, motion } from 'motion/react';
import { Crown, Layers, Library, Skull } from 'lucide-react';
import { Card, CardBack, type Focus } from './Card';
import { useSettings } from '../lib/settings';
import type { PlayerSnap, Seat, Snapshot, UnitRef } from '../data/types';
import type { UnitIds } from '../data/derive';

interface BoardProps {
    state: Snapshot;
    prev: Snapshot | null;
    ids: UnitIds[number];
    prevIds: UnitIds[number] | null;
    bots: Record<Seat, string>;
    actor: Seat | null;
    step: number;
    onFocus: (f: Focus | null) => void;
}

const spring = { type: 'spring', stiffness: 420, damping: 32 } as const;

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

function Lane({ label, seat, units, ids, prevUnits, prevIds, leader, step, onFocus }: {
    label: string; seat: Seat; units: UnitRef[]; ids: string[]; prevUnits: UnitRef[] | null; prevIds: string[] | null;
    leader: PlayerSnap['leader']; step: number; onFocus: (f: Focus | null) => void;
}) {
    return (
        <div className="lane">
            <span className="lane-label">{label}</span>
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
                            <Card card={u} unit={u} back={isLeader} exhausted={!!u.x} onFocus={onFocus} note={isLeader ? 'Deployed leader' : undefined} />
                            <Pop k={`${step}`} delta={before ? u.d - before.d : 0} />
                        </motion.div>
                    );
                })}
            </AnimatePresence>
        </div>
    );
}

function Hq({ p, prev, bot, step, onFocus }: { p: PlayerSnap; prev: PlayerSnap | null; bot: string; step: number; onFocus: (f: Focus | null) => void }) {
    const left = Math.max(0, p.base.hp - p.base.d);
    const frac = left / p.base.hp;
    const R = 34;
    const C = 2 * Math.PI * R;
    const deployed = p.leader?.dep === 1;
    return (
        <div className="flex flex-col items-center gap-2 min-w-0">
            <div className="relative" onMouseEnter={() => onFocus({ card: p.base, back: false, note: `Base · ${left} of ${p.base.hp} HP left` })}>
                <Card card={p.base} size="land" />
                <svg viewBox="0 0 80 80" className="absolute -right-3 -top-3 size-14 drop-shadow-lg" aria-label={`Base HP ${left} of ${p.base.hp}`}>
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
                    ? <div className="card sm grid place-items-center text-[9px] text-center text-dim border border-dashed border-line" style={{ background: 'transparent', boxShadow: 'none' }}>leader<br />deployed</div>
                    : <Card card={p.leader} size="sm" exhausted={!!p.leader.x} onFocus={onFocus} note="Leader" />)}
                <div className="flex flex-col gap-1 min-w-0">
                    <span className="font-display text-[13px] font-semibold truncate max-w-[9rem]" style={{ color: 'var(--seat)' }}>{bot}</span>
                    <div className="pips" aria-label={`${p.res.ready} of ${p.res.total} resources ready`}>
                        {Array.from({ length: p.res.total }, (_, i) => <i key={i} className={i < p.res.ready ? '' : 'spent'} />)}
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

function Hand({ seat, p, onFocus }: { seat: Seat; p: PlayerSnap; onFocus: (f: Focus | null) => void }) {
    const perspective = useSettings((s) => s.perspective);
    const visible = perspective === 'god' || perspective === seat;
    return (
        <div className="flex gap-1.5 overflow-x-auto py-1 px-1 min-h-[72px] items-center" aria-label={`${seat} hand`}>
            <AnimatePresence initial={false} mode="popLayout">
                {p.hand.map((c, i) => (
                    <motion.div key={`${c.n}-${i}`} layout initial={{ opacity: 0, y: seat === 'p1' ? 20 : -20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.7 }} transition={spring}>
                        {visible ? <Card card={c} size="sm" onFocus={onFocus} note="In hand" /> : <CardBack size="sm" />}
                    </motion.div>
                ))}
            </AnimatePresence>
            {p.hand.length === 0 && <span className="text-faint text-xs">empty hand</span>}
        </div>
    );
}

function Side({ seat, props }: { seat: Seat; props: BoardProps }) {
    const { state, prev, ids, prevIds, bots, actor, step, onFocus } = props;
    const p = state.players[seat];
    const pp = prev?.players[seat] ?? null;
    const hasInit = state.initiative === seat;
    const row = (
        <div className={`grid gap-2 grid-cols-2 @2xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-stretch rounded-2xl p-2 transition-shadow ${actor === seat ? 'to-act' : ''}`}>
            <Lane label="ground" seat={seat} units={p.ground} ids={ids[seat].ground} prevUnits={pp?.ground ?? null} prevIds={prevIds?.[seat].ground ?? null} leader={p.leader} step={step} onFocus={onFocus} />
            <div className="relative px-2 py-1 flex flex-col items-center justify-center col-span-2 @2xl:col-span-1 order-first @2xl:order-none">
                <Hq p={p} prev={pp} bot={bots[seat]} step={step} onFocus={onFocus} />
                {hasInit && (
                    <motion.div layoutId="initiative" transition={spring} title="Initiative"
                        className="absolute -left-1 top-1 size-7 rounded-full grid place-items-center bg-gold text-ink shadow-[0_0_18px_-2px_var(--color-gold)]">
                        <Crown size={15} strokeWidth={2.5} />
                    </motion.div>
                )}
            </div>
            <Lane label="space" seat={seat} units={p.space} ids={ids[seat].space} prevUnits={pp?.space ?? null} prevIds={prevIds?.[seat].space ?? null} leader={p.leader} step={step} onFocus={onFocus} />
        </div>
    );
    return (
        <section className={`seat-${seat} flex flex-col gap-1`} aria-label={`${bots[seat]} (${seat})`}>
            {seat === 'p2' ? <><Hand seat={seat} p={p} onFocus={onFocus} />{row}</> : <>{row}<Hand seat={seat} p={p} onFocus={onFocus} /></>}
        </section>
    );
}

export function Board(props: BoardProps) {
    return (
        <div className="flex flex-col gap-2">
            <Side seat="p2" props={props} />
            <div className="flex items-center gap-3 px-2" aria-hidden="true">
                <div className="h-px flex-1 bg-gradient-to-r from-transparent via-p2/40 to-transparent" />
                <span className="eyebrow">round {props.state.round} · {props.state.phase}</span>
                <div className="h-px flex-1 bg-gradient-to-r from-transparent via-p1/40 to-transparent" />
            </div>
            <Side seat="p1" props={props} />
        </div>
    );
}
