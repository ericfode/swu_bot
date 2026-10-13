import { memo, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { BrainCircuit, Coins, Flag, Layers, Library, Skull, Sparkle } from 'lucide-react';
import { Card, CardBack, CapturedPocket, regretTag, type CardValue, type Focus } from './Card';
import { useSettings } from '../lib/settings';
import { humanize } from '../lib/cards';
import type { PlayerSnap, Seat, Snapshot, UnitRef } from '../data/types';
import type { UnitIds } from '../data/derive';
import { cardSees, estimateCostFrom, leftOutTerms, partRows, sumTolerance, type NormSearch, type ScoreView, type SeatScore } from '../data/score';
import { rowColor, type RowDef } from '../data/terms';
import { digitsOf, displayScales, fmtSigned, fmtValue, pct, unitText } from '../data/format';
import { PartIcon } from './TermIcon';
import { badgeText, ScoreBadge } from './ScoreBadge';
import { SpotChips } from './Spots';
import { spotsOf, type SeatSpots } from '../data/atlas';

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
    /** the chosen score at this board: its source and the playhead's step (ScoreStep); null when the game has no score */
    score?: ScoreView | null;
    /** the Card values switch: card chips, totals and search tags (default true; GameViewer passes its button's state) */
    values?: boolean;
    /** the Strategy Atlas spots each seat is in, as chips by its base (default true) */
    spots?: boolean;
    /** The effect owns the departure; commit its final board without repeating it. */
    animateChanges?: boolean;
    /** Reserve the measured obligation/result rail throughout a supplied effect transition. */
    reservePlayerEffect?: boolean;
    /** Keep selected title-return examples at one measured footprint until the cue is replaced. */
    reserveArenaSlots?: Record<Seat, Record<'ground' | 'space', number>>;
    /** Stable card-specific discard permission rows for an active or completed presentation. */
    reserveDiscardPermissions?: Record<Seat, string[]>;
    /** Keep an explicit base-protection row stable across grant/consumption/expiry. */
    reserveBaseProtection?: Record<Seat, boolean>;
}

const spring = { type: 'spring', stiffness: 420, damping: 32 } as const;
const rowStyle = (id: string) => ({ '--term': rowColor(id) }) as CSSProperties;

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

/** Per-seat score values lined up with the snapshot, plus the search's per-card regrets when that seat is the one deciding. */
interface SeatLens {
    seat: Seat;
    side: SeatScore;
    search: NormSearch | null;
    /** the most valuable unit on the whole table (at least the heat floor), for the glow */
    max: number;
    view: ScoreView;
    bots: Record<Seat, string>;
}

const rowOf = (sl: SeatLens | null, id: string): RowDef | undefined => sl?.view.source.rows.find((r) => r.id === id);
const has = (sl: SeatLens | null, id: string) => !!rowOf(sl, id);
const additive = (sl: SeatLens | null) => sl?.view.source.cardValues === 'additive';
/** a total or chip number in the score's unit (1 decimal for points, 2 for log-odds) */
const fmtOf = (sl: SeatLens, v: number) => fmtValue(v, sl.view.source.unit);

/** A per-card value with the digits it has (up to 2 more than the unit's), as the rule prints it: 2 × 2.03 = 4.1, not 2 × 2.0. */
function perCard(sl: SeatLens, v: number): string {
    const d = digitsOf(sl.view.source.unit);
    const k = [d, d + 1].find((x) => Math.abs(Number(v.toFixed(x)) - v) < 1e-9) ?? d + 2;
    const s = Math.abs(v).toFixed(k);
    return v < 0 && Number(s) !== 0 ? `−${s}` : s;
}

/** A row chip's title: what the number is, the row's rules at this step's weights, and the score's badge. */
function rowTitle(sl: SeatLens, id: string, what: string): string {
    const r = rowOf(sl, id);
    const how = r?.how(sl.view.step.weights, leftOutTerms(sl.view.step));
    return [`${what}: the ${r?.label ?? id} row of ${sl.view.source.label}.`, how, badgeText(sl.view.source, sl.view.step)].filter(Boolean).join('\n');
}

/** What every value of this seat shares: unit, decimals, labels, and how it was made. */
function valueBase(sl: SeatLens, id: string): Omit<CardValue, 'v'> {
    const { source, step } = sl.view;
    return {
        seat: sl.seat, owner: sl.bots[sl.seat], row: id, rowLabel: rowOf(sl, id)?.label, unit: source.unit, digits: source.digits, label: source.label, badge: badgeText(source, step),
        ...(step.status === 'estimate' ? { estimated: true } : {}), ...(source.cardValues === 'ablation' ? { ablation: true } : {})
    };
}

/** A search regret as CardValue fields (the deciding seat's search only). */
function regretOf(sl: SeatLens, r: number | null | undefined): Partial<CardValue> {
    const s = sl.search;
    if (!s || r == null) {
        return {};
    }
    return { regret: r, regretUnit: s.unit, tolerance: s.tolerance, sees: cardSees(s, r), searchSees: s.sees, searchKind: s.kind, searchBot: sl.bots[s.by] };
}

function valueOf(sl: SeatLens | null, zone: 'ground' | 'space' | 'hand', i: number): CardValue | null {
    if (!sl) {
        return null;
    }
    const id = zone === 'hand' ? 'side.hand' : zone;
    const v = has(sl, id) ? sl.side[zone][i] ?? null : null;
    const parts = zone === 'hand' ? undefined : partRows(sl.view.source.unitTerms, sl.side.parts[zone][i] ?? null, sl.side.unitCostFrom?.[zone][i] ?? sl.side.costFrom);
    return {
        ...valueBase(sl, id), v, heat: zone === 'hand' || v == null ? 0 : Math.max(0, v) / sl.max,
        ...regretOf(sl, sl.search?.[zone]?.[i]), ...(parts?.length ? { parts } : {})
    };
}

/** A small chip for one row of a seat (a lane's units, resources, an extra term), in that row's colour. */
function RowChip({ sl, id, v, what, className = '' }: { sl: SeatLens; id: string; v: number; what: string; className?: string }) {
    return (
        <span className={`lens-chip !text-[10px] ${className}`} style={rowStyle(id)} title={rowTitle(sl, id, what)}>
            <PartIcon row={rowOf(sl, id) ?? id} size={10} />{fmtOf(sl, v)}
        </span>
    );
}

// Lane geometry, matching .lane and .card in styles.css: an 84px card, 8px gaps, 8px padding and a 1px border each side.
const CARD_W = 84;
const GAP = 8;
const LANE_X = 2 * (8 + 1);
// a row of cards in a lane (card height 84 × 7/5, plus the gap)
const ROW_H = 126;
const laneWidth = (cols: number) => LANE_X + cols * CARD_W + (cols - 1) * GAP;
const colsIn = (w: number) => Math.max(1, Math.floor((w - LANE_X + GAP) / (CARD_W + GAP)));
const rowsOf = (n: number, cols: number) => Math.ceil(n / cols);

/**
 * How a side's two lanes share their width (total: both lanes together, px). The even split is kept whenever both
 * lanes fit in two rows (weights null: today's look); a crowded lane otherwise gets the columns it needs from the other
 * one, so the deeper lane is as shallow as it can be (ties: fewest rows in all). Weights are fr values for the tracks.
 */
export function laneSplit(total: number, ground: number, space: number): { rows: number; weights: [number, number] | null } {
    const even = colsIn((total - GAP) / 2);
    let rows = Math.max(rowsOf(ground, even), rowsOf(space, even));
    if (total <= 0 || rows <= 2) {
        return { rows, weights: null };
    }
    let sum = rowsOf(ground, even) + rowsOf(space, even);
    let best: [number, number] | null = null;
    for (let cg = 1; laneWidth(cg) + GAP + laneWidth(1) <= total; cg++) {
        const cs = colsIn(total - GAP - laneWidth(cg));
        const r = Math.max(rowsOf(ground, cg), rowsOf(space, cs));
        const s = rowsOf(ground, cg) + rowsOf(space, cs);
        if (r < rows || (r === rows && s < sum)) {
            best = [cg, cs];
            rows = r;
            sum = s;
        }
    }
    return { rows, weights: best && [laneWidth(best[0]), laneWidth(best[1])] };
}

interface SideBox {
    /** the lanes row's width */
    row: number;
    /** the base and leader block's own size */
    hqW: number;
    hqH: number;
    /** the container is wide enough for ground | base | space */
    wide: boolean;
}

/** Sizes the side's layout depends on; none of them changes with the layout it picks, so the choice can't loop. */
function useSideBox(row: RefObject<HTMLDivElement | null>, hq: RefObject<HTMLDivElement | null>, probe: RefObject<HTMLSpanElement | null>) {
    const [box, setBox] = useState<SideBox>({ row: 0, hqW: 0, hqH: 0, wide: true });
    useLayoutEffect(() => {
        const r = row.current;
        const h = hq.current;
        const p = probe.current;
        if (!r || !h || !p || typeof ResizeObserver === 'undefined') {
            return;
        }
        const measure = () => {
            const next = { row: Math.round(r.clientWidth), hqW: Math.round(h.offsetWidth), hqH: Math.round(h.offsetHeight), wide: getComputedStyle(p).display !== 'none' };
            setBox((b) => (b.row === next.row && b.hqW === next.hqW && b.hqH === next.hqH && b.wide === next.wide ? b : next));
        };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(r);
        ro.observe(h);
        return () => ro.disconnect();
    }, [row, hq, probe]);
    return box;
}

/**
 * The side's layout: ground | base | space when there is room (today's look), else the base on top of the two lanes.
 * A crowded side also moves its base on top when that makes it clearly shorter, so the lanes get the middle's width.
 */
export function sideLayout(box: SideBox, ground: number, space: number): { stack: boolean; weights: [number, number] | null } {
    const stacked = laneSplit(box.row - GAP, ground, space);
    if (!box.wide) {
        return { stack: true, weights: stacked.weights };
    }
    // the base column is the block plus its px-2 padding
    const three = laneSplit(box.row - (box.hqW + 16) - 2 * GAP, ground, space);
    // only when it saves more than a row of cards: a small gain isn't worth the base leaving the middle
    const stack = box.row > 0 && three.rows > 2 && box.hqH + GAP + stacked.rows * ROW_H + ROW_H < three.rows * ROW_H;
    return stack ? { stack, weights: stacked.weights } : { stack, weights: three.weights };
}

function Lane({ label, seat, arena, units, ids, prevUnits, prevIds, leader, hiLeader, step, onFocus, onLeave, sl, animateChanges, reservedSlots = 0 }: {
    label: string; seat: Seat; arena: 'ground' | 'space'; units: UnitRef[]; ids: string[]; prevUnits: UnitRef[] | null; prevIds: string[] | null;
    leader: PlayerSnap['leader']; hiLeader: boolean; step: number; onFocus: (f: Focus | null) => void; onLeave?: () => void; sl: SeatLens | null; animateChanges: boolean; reservedSlots?: number;
}) {
    const total = sl ? sl.side.rows[arena] ?? 0 : 0;
    return (
        <div className="lane" data-effect-zone={arena} data-effect-reserved-slots={reservedSlots || undefined}>
            <span className="lane-label">{label}{sl && additive(sl) && has(sl, arena) && units.length > 0 && (
                <RowChip sl={sl} id={arena} v={total} what={`This player's ${label} units together`} className="!tracking-normal" />
            )}</span>
            <AnimatePresence mode="popLayout" initial={false}>
                {units.map((u, i) => {
                    const id = ids[i];
                    const pi = prevIds ? prevIds.indexOf(id) : -1;
                    const before = pi >= 0 && prevUnits ? prevUnits[pi] : null;
                    const isLeader = !!leader?.dep && u.n === leader.n && u.s === leader.s;
                    // a leader deployed as a pilot rides on another unit as an upgrade
                    const carries = !!leader?.dep && !isLeader && !!u.u?.some((x) => x.n === leader.n);
                    return (
                        <motion.div key={id} layout={animateChanges} className={`relative${hiLeader && (isLeader || carries) ? ' lead-hi' : ''}`} transition={animateChanges ? { ...spring, filter: { type: 'tween', duration: 0.2 } } : { duration: 0 }}
                            initial={animateChanges ? { opacity: 0, scale: 0.6, y: seat === 'p1' ? 40 : -40 } : false}
                            animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
                            exit={animateChanges ? { opacity: 0, scale: 0.4, rotate: seat === 'p1' ? -14 : 14, filter: 'blur(6px)', transition: { type: 'tween', duration: 0.35 } } : { opacity: 0, transition: { duration: 0 } }}>
                            <Card card={u} unit={u} controllerSeat={seat} detailedEffects={!animateChanges} back={isLeader} exhausted={!!u.x} onFocus={onFocus} onLeave={onLeave} leader={isLeader || carries}
                                note={isLeader ? 'Deployed leader' : carries ? `Carries the leader ${leader!.n}` : undefined}
                                value={valueOf(sl, arena, i)} />
                            <CapturedPocket unit={u} seat={seat} />
                            <Pop k={`${step}`} delta={before ? u.d - before.d : 0} />
                        </motion.div>
                    );
                })}
            </AnimatePresence>
            {Array.from({ length: Math.max(0, reservedSlots - units.length) }, (_, i) => <div key={`footprint:${i}`} className="relative arena-footprint" aria-hidden="true"><div className="card" /></div>)}
        </div>
    );
}

/** The leader card's chip: extra.leader when the score has it (else no value of its own), and its search regret. */
function leaderValue(sl: SeatLens | null, unitTagged = false): CardValue | null {
    if (!sl) {
        return null;
    }
    const v = has(sl, 'extra.leader') ? sl.side.extra.leader ?? null : null;
    // a deployed leader's unit already carries its search tag
    const regret = unitTagged ? undefined : sl.search?.leader;
    return v == null && regret == null ? null : { ...valueBase(sl, 'extra.leader'), v, ...regretOf(sl, regret) };
}

/** The leader slot: the leader card on the side it is on now (back art once deployed or flipped), tilted when exhausted. */
function LeaderSlot({ p, onFocus, onLeave, onHi, sl }: { p: PlayerSnap; onFocus: (f: Focus | null) => void; onLeave?: () => void; onHi: (on: boolean) => void; sl: SeatLens | null }) {
    const l = p.leader!;
    const units = [...p.ground, ...p.space];
    const isIt = (u: PlayerSnap['ground'][number]) => (u.n === l.n && u.s === l.s) || !!u.u?.some((x) => x.n === l.n);
    const onBoard = !!l.dep && units.some(isIt);
    const unitTagged = onBoard && (['ground', 'space'] as const).some((z) => p[z].some((u, k) => isIt(u) && sl?.search?.[z]?.[k] != null));
    // v2: its deploy (epic action) is used but it is back in the base zone: it was defeated
    const gone = !!l.epic && !l.dep;
    const note = gone ? 'Leader · deployed, then defeated (its deploy is used)' : !l.dep ? 'Leader' : onBoard ? 'Leader · deployed (on the board, marked LEADER)' : 'Leader · flipped to its other side';
    return (
        <div className={`leader-slot${gone ? ' gone' : ''}`} onMouseEnter={() => onHi(true)} onMouseLeave={() => onHi(false)} onFocus={() => onHi(true)} onBlur={() => onHi(false)}>
            <Card card={l} shape="wide" kind="leader" width={92} effectIdentity={!onBoard} back={!!l.dep} exhausted={!!l.x} onFocus={onFocus} onLeave={onLeave} note={note}
                value={leaderValue(sl, unitTagged)} />
            {onBoard && <span className="leader-out" title="Deployed: hover to find it on the board">on board</span>}
            {gone && <span className="leader-out gone" title="Deployed with its epic action, then defeated: the deploy is used">defeated</span>}
        </div>
    );
}

/** Extra side terms with no place of their own on the board (deck, discard and leader have one). */
const otherExtras = (sl: SeatLens) => sl.view.source.rows.filter((r) => r.group === 'extra' && !['deck', 'discard', 'leader'].includes(r.key));

/** A seat Σ's title; says when the total holds a part the rows don't split, and that ablation values don't add up to it. */
function totalTitle(view: ScoreView, seat: Seat, bot: string): string {
    const { source, step } = view;
    const o = step.other?.[seat];
    const rest = o != null && Math.abs(o) > sumTolerance(source.unit) ? ', plus Other (not split)' : '';
    const what = source.cardValues === 'ablation' ? 'the file\'s own number (the card values don\'t add up to it)' : `the coloured numbers on this side added up${rest}`;
    return `${bot}'s total in ${source.label}: ${what}.\n${badgeText(source, step)}`;
}

function Hq({ seat, p, prev, bot, step, onFocus, onLeave, onHiLeader, hqRef, sl, spots, reserveProtection }: { seat: Seat; p: PlayerSnap; prev: PlayerSnap | null; bot: string; step: number; onFocus: (f: Focus | null) => void; onLeave?: () => void; onHiLeader: (on: boolean) => void; hqRef: RefObject<HTMLDivElement | null>; sl: SeatLens | null; spots: string[] | null; reserveProtection?: boolean }) {
    const left = Math.max(0, p.base.hp - p.base.d);
    const frac = left / p.base.hp;
    const R = 34;
    const C = 2 * Math.PI * R;
    const baseNote = `Base · ${left} of ${p.base.hp} HP left${p.base.epic ? ' · epic action used' : ''}`;
    // v2: the hand is still listed; handCount matters only when it says otherwise
    const handN = p.handCount ?? p.hand.length;
    return (
        <div ref={hqRef} className="flex flex-col items-center gap-2 min-w-0">
            <div className="relative base-frame">
                <Card card={p.base} shape="wide" kind="base" hpLeft={left} note={baseNote} onFocus={onFocus} onLeave={onLeave} value={sl && has(sl, 'base') ? baseValue(sl) : null} />
                <svg viewBox="0 0 80 80" className="absolute -right-3 -top-3 size-14 drop-shadow-lg pointer-events-none z-[4]" aria-label={`Base HP ${left} of ${p.base.hp}`}>
                    <circle cx="40" cy="40" r="38" fill="#060a13" />
                    <circle cx="40" cy="40" r={R} fill="none" stroke="#1d2a44" strokeWidth="6" />
                    <motion.circle cx="40" cy="40" r={R} fill="none" stroke={frac < 0.35 ? '#ff5f6d' : 'var(--seat)'} strokeWidth="6" strokeLinecap="round"
                        transform="rotate(-90 40 40)" strokeDasharray={C} initial={false} animate={{ strokeDashoffset: C * (1 - frac) }} transition={{ duration: 0.5 }} />
                    <text x="40" y="47" textAnchor="middle" fontFamily="Oxanium, sans-serif" fontWeight="800" fontSize="22" fill="#dce6fb">{left}</text>
                </svg>
                <Pop k={`b${step}`} delta={prev ? p.base.d - prev.base.d : 0} />
                {!!p.base.epic && <span className="epic-used" title="This base's epic action is used">epic used</span>}
            </div>
            {(reserveProtection || !!p.base.damageProtection?.length) && <div className="base-protection" data-effect-zone="base-protection" aria-hidden={!p.base.damageProtection?.length ? true : undefined}>
                {p.base.damageProtection?.map(effect => <span key={effect.id} data-effect-base-protection={effect.id} data-effect-source={effect.sourceId} data-effect-duration="phase" role="status">NEXT DAMAGE<br /><small>ONE USE · PHASE</small></span>)}
            </div>}
            <div className="flex items-center gap-2.5">
                {p.leader && <LeaderSlot p={p} onFocus={onFocus} onLeave={onLeave} onHi={onHiLeader} sl={sl} />}
                <div className={`flex flex-col gap-1 min-w-0${p.resources ? ' resources-explicit' : ''}`}>
                    <span className="flex items-center gap-1.5 min-w-0">
                        <span className="font-display text-[13px] font-semibold truncate max-w-[9rem]" style={{ color: 'var(--seat)' }}>{bot}</span>
                        {p.out ? <span className="seat-tag" title={`Done for this action phase: claimed the initiative, or both players passed${p.passed ? ' (passed its last action)' : ''}`}>out</span>
                            : p.passed ? <span className="seat-tag" title="Passed its last action">passed</span> : null}
                        {sl && sl.side.total != null && <span className="lens-chip" style={{ '--seat': `var(--color-${seat})` } as CSSProperties} title={totalTitle(sl.view, seat, bot)}>Σ {fmtOf(sl, sl.side.total)}</span>}
                    </span>
                    <div className="flex items-center gap-1.5">
                        {/* more than 12 resources: two even rows (a pip and its gap are 12px) */}
                        <div className="pips" data-effect-zone="resources" style={!p.resources && p.res.total > 12 ? { maxWidth: Math.ceil(p.res.total / 2) * 12 } : undefined} aria-label={`${p.res.ready} of ${p.res.total} resources ready`}>
                            {Array.from({ length: p.res.total }, (_, i) => <i key={i} className={i < p.res.ready ? '' : 'spent'} />)}
                        </div>
                        {sl && has(sl, 'side.resources') && <RowChip sl={sl} id="side.resources" v={sl.side.resources} what="All resources together" />}
                    </div>
                    <div className="flex gap-2 text-[11px] text-dim num">
                        <span title={handN !== p.hand.length ? `Cards in hand (${p.hand.length} listed)` : 'Cards in hand'} data-effect-zone="hand-count" className="inline-flex items-center gap-0.5"><Layers size={11} />{handN}</span>
                        <span title="Cards in deck" data-effect-zone="deck" className="inline-flex items-center gap-0.5"><Library size={11} />{p.deck}</span>
                        {sl && has(sl, 'extra.deck') && <RowChip sl={sl} id="extra.deck" v={sl.side.extra.deck ?? 0} what="The deck" />}
                        <span title="Cards in discard" data-effect-zone="discard" className="inline-flex items-center gap-0.5"><Skull size={11} />{p.discard.length}</span>
                        {sl && has(sl, 'extra.discard') && <RowChip sl={sl} id="extra.discard" v={sl.side.extra.discard ?? 0} what="The discard pile" />}
                        {p.force ? <span title="Has the Force token" className="inline-flex items-center text-fg"><Sparkle size={11} /></span> : null}
                        {p.credits ? <span title={`${p.credits} credit token${p.credits > 1 ? 's' : ''}`} className="inline-flex items-center gap-0.5 text-fg"><Coins size={11} />{p.credits}</span> : null}
                        <span className="text-faint" data-effect-zone="resource-count">{p.res.ready}/{p.res.total}</span>
                    </div>
                    {p.resources && <div className="resource-manifest" data-effect-zone="resource-cards" aria-label={`${p.res.ready} ready of ${p.resources.length} identified resource slots`}>
                        {p.resources.map((resource, i) => <span key={resource.id ?? i} className={`resource-slot${resource.x ? ' spent' : ''}`} data-effect-resource={resource.n} data-effect-id={resource.id} data-effect-code={resource.s ?? undefined} data-effect-owner={resource.owner}
                            title={`Resource ${i + 1}${resource.s ? ` · ${resource.n}` : ''} · ${resource.x ? 'exhausted' : 'ready'}`} aria-label={`Resource ${i + 1}, ${resource.x ? 'exhausted' : 'ready'}`}><b>{i + 1}</b></span>)}
                    </div>}
                    {sl && otherExtras(sl).length > 0 && (
                        <div className="flex flex-wrap gap-1">
                            {otherExtras(sl).map((r) => <RowChip key={r.id} sl={sl} id={r.id} v={sl.side.extra[r.key] ?? 0} what={`${r.label} for this player`} />)}
                        </div>
                    )}
                </div>
            </div>
            {spots && <SpotChips ids={spots} bot={bot} />}
        </div>
    );
}

function Hand({ seat, p, onFocus, onLeave, sl, animateChanges }: { seat: Seat; p: PlayerSnap; onFocus: (f: Focus | null) => void; onLeave?: () => void; sl: SeatLens | null; animateChanges: boolean }) {
    const perspective = useSettings((s) => s.perspective);
    const visible = perspective === 'god' || perspective === seat;
    // hand cards all score the same; a per-card number only when they differ
    // (ablation values never add up, so each card keeps its own number)
    const flat = !sl || (additive(sl) && sl.side.hand.every((v) => v === sl.side.hand[0]));
    const handTotal = sl ? sl.side.rows['side.hand'] ?? 0 : 0;
    const count = p.handCount ?? p.hand.length;
    return (
        <div className="hand" data-effect-zone="hand" aria-label={`${seat} hand, ${count} cards`}>
            <span className="hand-label">Hand · {count}{count !== p.hand.length ? ` (${p.hand.length} listed)` : ''}</span>
            <div className="hand-cards">
                <AnimatePresence initial={false} mode="popLayout">
                    {p.hand.map((c, i) => {
                        const v = valueOf(sl, 'hand', i);
                        const shown = v && flat ? { ...v, v: null } : v;
                        return (
                            <motion.div key={c.id ?? `${c.n}-${i}`} layout={animateChanges} className="hand-card" initial={animateChanges ? { opacity: 0, y: seat === 'p1' ? 20 : -20 } : false} animate={{ opacity: 1, y: 0 }} exit={animateChanges ? { opacity: 0, scale: 0.7 } : { opacity: 0, transition: { duration: 0 } }} transition={animateChanges ? spring : { duration: 0 }}>
                                {visible ? <Card card={c} size="sm" kind="hand" onFocus={onFocus} onLeave={onLeave} note="In hand" value={shown} /> : <CardBack size="sm" value={shown} />}
                                {visible && <span className="hand-name">{c.n}</span>}
                            </motion.div>
                        );
                    })}
                </AnimatePresence>
                {p.hand.length === 0 && <span className="text-faint text-xs self-center">empty</span>}
            </div>
            {sl && additive(sl) && has(sl, 'side.hand') && p.hand.length > 0 && (
                <span className="lens-chip shrink-0 ml-auto" style={rowStyle('side.hand')} title={rowTitle(sl, 'side.hand', 'Cards in hand')}>
                    <PartIcon row={rowOf(sl, 'side.hand')!} size={10} />
                    {flat ? `${p.hand.length} × ${perCard(sl, sl.side.hand[0])} = ${fmtOf(sl, handTotal)}` : fmtOf(sl, handTotal)}
                </span>
            )}
        </div>
    );
}

function Side({ seat, props, sl, spots }: { seat: Seat; props: BoardProps; sl: SeatLens | null; spots: string[] | null }) {
    const { state, prev, ids, prevIds, bots, actor, step, onFocus, onLeave, animateChanges = true } = props;
    const p = state.players[seat];
    const pp = prev?.players[seat] ?? null;
    const hasInit = state.initiative === seat;
    const [hiLeader, setHiLeader] = useState(false);
    const rowRef = useRef<HTMLDivElement>(null);
    const hqRef = useRef<HTMLDivElement>(null);
    const probeRef = useRef<HTMLSpanElement>(null);
    const { stack, weights } = sideLayout(useSideBox(rowRef, hqRef, probeRef),
        Math.max(p.ground.length, props.reserveArenaSlots?.[seat].ground ?? 0),
        Math.max(p.space.length, props.reserveArenaSlots?.[seat].space ?? 0));
    const cols = (weights ? { '--gw': `${weights[0]}fr`, '--sw': `${weights[1]}fr` } : {}) as CSSProperties;
    const row = (
        <div ref={rowRef} className={`grid gap-2 grid-cols-[minmax(0,var(--gw,1fr))_minmax(0,var(--sw,1fr))] items-stretch ${stack ? '' : '@2xl:grid-cols-[minmax(0,var(--gw,1fr))_auto_minmax(0,var(--sw,1fr))]'}`} style={cols}>
            <Lane label="ground" seat={seat} arena="ground" units={p.ground} ids={ids[seat].ground} prevUnits={pp?.ground ?? null} prevIds={prevIds?.[seat].ground ?? null} leader={p.leader} hiLeader={hiLeader} step={step} onFocus={onFocus} onLeave={onLeave} sl={sl} animateChanges={animateChanges} reservedSlots={props.reserveArenaSlots?.[seat].ground} />
            <div className={`relative px-2 py-1 flex flex-col items-center justify-center col-span-2 order-first ${stack ? '' : '@2xl:col-span-1 @2xl:order-none'}`}>
                <Hq seat={seat} p={p} prev={pp} bot={bots[seat]} step={step} onFocus={onFocus} onLeave={onLeave} onHiLeader={setHiLeader} hqRef={hqRef} sl={sl} spots={spots} reserveProtection={props.reserveBaseProtection?.[seat]} />
                {hasInit && (
                    <motion.div layoutId="initiative" transition={spring} title={sl && has(sl, 'side.initiative') ? rowTitle(sl, 'side.initiative', `Initiative: ${fmtOf(sl, sl.side.initiative)} ${sl.view.source.unitText}`) : 'Initiative'}
                        className="absolute -left-1 top-1 flex flex-col items-center gap-0.5">
                        <span className="size-7 rounded-full grid place-items-center bg-gold text-ink shadow-[0_0_18px_-2px_var(--color-gold)]"><Flag size={14} strokeWidth={2.5} /></span>
                        {sl && has(sl, 'side.initiative') && <span className="lens-chip !text-[10px]" style={rowStyle('side.initiative')}>{fmtOf(sl, sl.side.initiative)}</span>}
                    </motion.div>
                )}
            </div>
            <Lane label="space" seat={seat} arena="space" units={p.space} ids={ids[seat].space} prevUnits={pp?.space ?? null} prevIds={prevIds?.[seat].space ?? null} leader={p.leader} hiLeader={hiLeader} step={step} onFocus={onFocus} onLeave={onLeave} sl={sl} animateChanges={animateChanges} reservedSlots={props.reserveArenaSlots?.[seat].space} />
        </div>
    );
    return (
        <section className={`seat-${seat} half flex flex-col gap-1.5${actor === seat ? ' to-act' : ''}`} data-effect-seat={seat} aria-label={`${bots[seat]} (${seat})`}>
            {/* shown only when the container has room for ground | base | space: tells the layout which one CSS picked */}
            <span ref={probeRef} className="absolute size-0 hidden @2xl:block" aria-hidden="true" />
            {seat === 'p2' ? <><Hand seat={seat} p={p} onFocus={onFocus} onLeave={onLeave} sl={sl} animateChanges={animateChanges} />{row}</> : <>{row}<Hand seat={seat} p={p} onFocus={onFocus} onLeave={onLeave} sl={sl} animateChanges={animateChanges} /></>}
            <DiscardPermissions state={state} seat={seat} reserved={props.reserveDiscardPermissions?.[seat]} onFocus={onFocus} onLeave={onLeave} />
        </section>
    );
}

/** Permission is available now; displaying it does not play or pay for the card. */
function DiscardPermissions({ state, seat, reserved, onFocus, onLeave }: { state: Snapshot; seat: Seat; reserved?: string[]; onFocus: (f: Focus | null) => void; onLeave?: () => void }) {
    const permissions = state.discardPlayPermissions?.filter(p => p.player === seat && p.round === state.round && p.phase === state.phase && state.players[seat].discard.some(c => c.id === p.cardId && c.owner === seat)) ?? [];
    const ids = reserved?.length ? reserved : permissions.map(p => p.id);
    if (!ids.length) return null;
    return <div className="discard-permissions" data-effect-zone="discard-permissions" aria-label={`${seat} cards playable from discard this phase`}>
        {ids.map((id, i) => {
            const permission = permissions.find(p => p.id === id), card = permission && state.players[seat].discard.find(c => c.id === permission.cardId);
            return <div key={id} className={`discard-permission${card ? '' : ' empty'}`} aria-hidden={!card || undefined} data-effect-permission={card ? id : undefined} data-effect-permission-card={card?.id} data-effect-permission-source={permission?.sourceId}>
                <div className="discard-permission-face" data-effect-zone={`discard-permission:${i}`}>{card ? <Card card={card} size="sm" width={28} note="In discard · may play for two less this phase" onFocus={onFocus} onLeave={onLeave} /> : null}</div>
                <div className="discard-permission-text" data-effect-zone={`discard-permission-label:${i}`}><strong>{card?.n}</strong><span>{card ? 'Play from discard · −2 this phase' : ''}</span></div>
            </div>;
        })}
    </div>;
}

/** The base's value chip, with its parts for the inspector. */
function baseValue(sl: SeatLens): CardValue {
    const parts = partRows(sl.view.source.baseTerms, sl.side.parts.base);
    // a base is a seat field, not a card the score drops (spec: ablation numbers are the card arrays), so its chip is plain
    const { ablation: _, ...base } = valueBase(sl, 'base');
    return { ...base, v: sl.side.base, ...(parts.length ? { parts } : {}) };
}

/** Where the centre line's numbers come from, in a few words. */
function provenance(view: ScoreView): string {
    const { step } = view;
    switch (step.status) {
        case 'file': return 'from its lens file';
        case 'estimate': return estimateCostFrom(step) === 'card' ? 'estimated here (card cost from card data)' : 'estimated here, card cost left out';
        case 'held': return `as of step ${step.heldFromN ?? step.n}`;
        case 'mismatch': return 'file doesn\'t match this board here';
        default: return view.source.error ?? 'no value at this step';
    }
}

/** A search value in its unit: "+3.2 points", "+0.42 log-odds", "64%" for a chance. */
const fmtSearch = (v: number, unit: string) => (unit === 'prob' ? pct(v) : `${fmtSigned(v, unit)} ${unitText(unit)}`);

/** "search sees a win for X": the search saw the game end on every line it tried. Plain, never gold: a capped search is not a proof. */
function SeesNote({ s, bots, short = false }: { s: NormSearch; bots: Record<Seat, string>; short?: boolean }) {
    const what = s.sees === 'win' ? 'a win' : 'a loss';
    return (
        <span className="sees-note" title={`${bots[s.by]}'s search${s.kind ? ` (${s.kind})` : ''} saw the game end on every line it tried, with ${bots[s.by]} ${s.sees === 'win' ? 'winning' : 'losing'}. Not a proof: the search may have missed a defence.`}>
            {short ? `sees ${what}` : `search sees ${what} for ${bots[s.by]}`}
        </span>
    );
}

/** The search line: who searched this board and how, the plan, the search's value for that bot, its stats, and the button regrets. */
function SearchLine({ view, s, bots }: { view: ScoreView; s: NormSearch; bots: Record<Seat, string> }) {
    const stats = [
        s.depth != null && `depth ${s.depth}`, s.nodes != null && `${s.nodes} nodes`, s.ms != null && `${(s.ms / 1000).toFixed(2)} s`,
        ...Object.entries(s.stats).map(([k, v]) => `${k} ${Number(v.toPrecision(4))}`)
    ].filter(Boolean).join(' · ');
    const tag = (v: number) => regretTag({
        v: null, seat: s.by, label: view.source.label, regret: v, regretUnit: s.unit, tolerance: s.tolerance, sees: cardSees(s, v), searchSees: s.sees, searchKind: s.kind, searchBot: bots[s.by]
    }, true);
    return (
        <div className={`seat-${s.by} flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-[11px]`}>
            <BrainCircuit size={13} style={{ color: 'var(--seat)' }} />
            <span><b style={{ color: 'var(--seat)' }}>{bots[s.by]}</b> <span className="text-dim">searched this board{s.kind ? ` (${s.kind})` : ''}:</span></span>
            {s.pv?.length ? <span className="text-fg">plan {s.pv.map(humanize).join(' → ')}</span> : null}
            {s.sees ? <SeesNote s={s} bots={bots} short /> : (
                <span className="num text-dim" title={`The search's value of this board for ${bots[s.by]}, in its own unit`}>value <b className="text-fg">{fmtSearch(s.value, s.unit)}</b> for {bots[s.by]}</span>
            )}
            {stats && <span className="num text-faint">{stats}</span>}
            {Object.entries(s.buttons ?? {}).map(([b, v]) => {
                const t = tag(v);
                return <span key={b} className={`lensr sm${t.cls ? ` ${t.cls}` : ''}`} title={t.title}>{b} {t.text}</span>;
            })}
        </div>
    );
}

/**
 * The score's centre line: the edge as a tug of war (its end at the source's tug scale), the edge in the score's unit,
 * the chance only for a fitted or model source, the badge and where the numbers come from, a gold badge only for a
 * solver's proof, and, with card values on, both totals, the colour legend and what the searching bot saw.
 */
function ScoreLine({ view, bots, state, values }: { view: ScoreView; bots: Record<Seat, string>; state: Snapshot; values: boolean }) {
    const { source, step } = view;
    const scales = displayScales(source.kEff, source.unit);
    const edge = step.edge ?? 0;
    const lead: Seat | null = step.edge == null ? null : edge > scales.lead ? 'p1' : edge < -scales.lead ? 'p2' : null;
    const w = Math.min(50, (Math.abs(edge) / scales.tug) * 50);
    const s = step.search;
    const total = (seat: Seat) => (values ? step.seats?.[seat].total ?? null : null);
    const rows = values && step.seats ? source.rows.filter((r) => r.group !== 'joint') : [];
    const chance = (source.chance === 'fitted' || source.chance === 'model') && step.p1Win != null ? step.p1Win : null;
    const badge = badgeText(source, step);
    const seatTotal = (seat: Seat) => (
        <span className={`lens-chip seat-${seat} shrink-0`} title={totalTitle(view, seat, bots[seat])}>
            {bots[seat]} Σ {fmtValue(total(seat)!, source.unit)}
        </span>
    );
    return (
        <div className="flex flex-col gap-1 px-2">
            {source.error ? (
                <div className="flex items-center gap-3">
                    <div className="h-px flex-1 bg-gradient-to-r from-transparent via-p2/40 to-transparent" />
                    <span className="eyebrow">round {state.round} · {state.phase}</span>
                    <div className="h-px flex-1 bg-gradient-to-r from-transparent via-p1/40 to-transparent" />
                </div>
            ) : (
                <div className="flex items-center gap-3">
                    {total('p2') != null && seatTotal('p2')}
                    <div className="relative h-2 flex-1 rounded-full bg-ink/80 overflow-hidden" title={`${source.label}: the edge (${bots.p1}'s side minus ${bots.p2}'s); the bar ends at ±${fmtValue(scales.tug, source.unit)} ${source.unitText}`}>
                        <span className="absolute left-1/2 top-0 bottom-0 w-px bg-line" />
                        <motion.span className="absolute top-0 bottom-0 rounded-full" initial={false} animate={{ left: edge >= 0 ? '50%' : `${50 - w}%`, width: `${w}%` }}
                            style={{ background: edge >= 0 ? 'var(--color-p1)' : 'var(--color-p2)' }} transition={{ type: 'spring', stiffness: 300, damping: 30 }} />
                    </div>
                    {total('p1') != null && seatTotal('p1')}
                </div>
            )}
            <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5 text-[11px] text-dim">
                {!source.error && <span className="eyebrow !text-[10px]">round {state.round} · {state.phase}</span>}
                {source.error ? <span className="text-fg">{source.error}</span> : <ScoreBadge source={source} step={step} />}
                {step.edge != null && (
                    <span className="num" title={`${source.label}: the edge, ${bots.p1}'s side minus ${bots.p2}'s (the timeline's score line and the breakdown's total), ${provenance(view)}.\n${badge}`}>
                        <b style={{ color: 'var(--color-edge)' }}>{fmtSigned(edge, source.unit)}</b> {source.unitText}
                        {lead ? <> · <b style={{ color: `var(--color-${lead})` }}>{bots[lead]}</b> ahead</> : ' · even'}
                        {chance != null && <> · <span title={`Chance ${bots.p1} wins, ${source.chance === 'model' ? `${source.label}'s own chance` : 'from a fitted map'}`}><b style={{ color: 'var(--color-p1)' }}>{bots.p1}</b> {pct(chance)}</span></>}
                    </span>
                )}
                {/* the badge already says held, missing or mismatched; an estimate adds where card cost came from */}
                {!source.error && step.status === 'estimate' && <span className="text-faint">{provenance(view)}</span>}
                {step.proven && (
                    <span className="proven-badge" title={`An exhaustive solver${step.proven.by ? ` (${step.proven.by})` : ''} proved a win for ${bots[step.proven.seat]} from this board${step.proven.inWindows != null ? `, ${step.proven.inWindows} action windows from the end` : ''}.`}>
                        proven win for {bots[step.proven.seat]}{step.proven.inWindows != null ? ` in ${step.proven.inWindows} windows` : ''}
                    </span>
                )}
                {s?.sees && <SeesNote s={s} bots={bots} />}
            </div>
            {rows.length > 0 && (
                <div className="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-0.5 text-[10.5px]" aria-label="What the colours mean">
                    {rows.map((r) => (
                        <span key={r.id} className="inline-flex items-center gap-1" style={{ color: r.color }} title={r.how(step.weights, leftOutTerms(step)) || undefined}><PartIcon row={r} size={10} />{r.label}</span>
                    ))}
                    <span className="text-faint">· each colour is one part of {source.label}</span>
                </div>
            )}
            {values && s && <SearchLine view={view} s={s} bots={bots} />}
        </div>
    );
}

/** Player obligations and terminal outcomes are snapshot data, so they survive effect removal. */
function PlayerEffectRail({ state, reserve }: { state: Snapshot; reserve?: boolean }) {
    const pending = state.pendingPlayers?.filter(effect => effect.kind === 'lose-game' && effect.trigger === 'regroup-start') ?? [];
    const result = state.matchResult;
    if (!reserve && !pending.length && !result) return null;
    return <div className="player-effect-rail" data-effect-zone="player-effect" aria-hidden={!pending.length && !result ? true : undefined}>
        {result ? <div className="player-effect-message result" role="status" data-effect-result={result.reason} data-effect-winner={result.winner} data-effect-loser={result.loser} data-effect-source={result.sourceId}>
            <strong>{result.winner === 'draw' ? 'DRAW' : `${result.winner.toUpperCase()} WINS`}{result.loser ? ` · ${result.loser.toUpperCase()} LOSES` : ''}</strong>
            <span>Card effect resolved</span>
        </div> : pending.map(effect => <div key={effect.id} className="player-effect-message pending" data-effect-player-pending={effect.player} data-effect-source={effect.sourceId} data-effect-trigger={effect.trigger}>
            <strong>{effect.player.toUpperCase()} · LOSES AT REGROUP</strong><span>Pending card effect</span>
        </div>)}
    </div>;
}

function BoardImpl(props: BoardProps) {
    const { state, bots } = props;
    const view = props.score ?? null;
    const values = props.values !== false;
    const sls = (() => {
        const seats = view?.step.seats;
        if (!view || !seats || !values || view.source.cardValues === 'none') {
            return null;
        }
        const all = [seats.p1.ground, seats.p1.space, seats.p2.ground, seats.p2.space].flat();
        const max = Math.max(displayScales(view.source.kEff, view.source.unit).heatFloor, ...all);
        const search = view.step.search;
        const mk = (seat: Seat): SeatLens => ({ seat, side: seats[seat], search: search?.by === seat ? search : null, max, view, bots });
        return { p1: mk('p1'), p2: mk('p2') };
    })();
    // read straight from the snapshot by the Atlas kit's own rules
    const spots: SeatSpots | null = useMemo(() => (props.spots === false ? null : spotsOf(state)), [state, props.spots]);
    return (
        <div className="flex flex-col gap-2">
            <Side seat="p2" props={props} sl={sls?.p2 ?? null} spots={spots?.p2 ?? null} />
            {view ? <ScoreLine view={view} bots={bots} state={state} values={values} /> : (
                <div className="flex items-center gap-3 px-2">
                    <div className="h-px flex-1 bg-gradient-to-r from-transparent via-p2/40 to-transparent" />
                    <span className="eyebrow">round {state.round} · {state.phase}</span>
                    {props.score === null && <span className="text-faint text-[11px]">no score for this game</span>}
                    <div className="h-px flex-1 bg-gradient-to-r from-transparent via-p1/40 to-transparent" />
                </div>
            )}
            <PlayerEffectRail state={state} reserve={props.reservePlayerEffect} />
            <Side seat="p1" props={props} sl={sls?.p1 ?? null} spots={spots?.p1 ?? null} />
        </div>
    );
}

/** The table: both seats, the centre line, and the score's card values when they are on. Memoised: the timeline's hover re-renders the page but not the board. */
export const Board = memo(BoardImpl);
