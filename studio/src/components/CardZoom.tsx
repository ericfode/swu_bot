import { useEffect, useRef, useState, type RefObject } from 'react';
import { motion } from 'motion/react';
import { BrainCircuit } from 'lucide-react';
import { Card, fmtCardValue, regretTag, type CardValue, type Focus } from './Card';
import type { ScoreView } from '../data/score';
import { logit, sigmoid, winProb } from '../data/calibrate';
import { digitsOf, fmtSigned, fmtValue, pct, ppText, unitText } from '../data/format';
import { rowColor, termRule, type RowDef } from '../data/terms';
import { PartIcon } from './TermIcon';
import { ScoreBadge, setLabel } from './ScoreBadge';
import { CardTextFace } from './CardFace';
import { cardTextOf } from '../lib/cardText';
import { useSettings } from '../lib/settings';

/** The inspected card's printed data when card data is loaded (re-read when a card-data file or art pack arrives). */
function useFocusText(focus: Focus) {
    useSettings((s) => s.artVersion);
    return cardTextOf(focus.card);
}

/** The text face to draw when the inspected card has no image, or undefined (Card then draws its tile). */
function faceOf(focus: Focus, text: ReturnType<typeof cardTextOf>) {
    return text ? <CardTextFace text={text} back={focus.back} shape={focus.shape} /> : undefined;
}

/** The row of the score a card counts in: its chip's row, else the row its kind of card belongs to. */
function rowOfFocus(focus: Focus, view: ScoreView): RowDef | undefined {
    const id = focus.value?.row ?? (focus.kind === 'base' ? 'base' : focus.kind === 'hand' ? 'side.hand' : focus.kind === 'leader' ? 'extra.leader' : null);
    return id ? view.source.rows.find((r) => r.id === id) : undefined;
}

/** Why the score gives no values at this step, or null when it does. */
function noValuesWhy({ source, step }: ScoreView): string | null {
    if (source.error) {
        return source.error;
    }
    if (source.cardValues === 'none') {
        return `${source.label} gives a chance only, no card values.`;
    }
    switch (step.status) {
        case 'missing': return 'No value at this step.';
        case 'mismatch': return 'The file doesn\'t match this board here, so it gives no card values at this step.';
        case 'held': return step.seats ? null : `The cards changed since step ${step.heldFromN}, the last step ${source.label} scored.`;
        default: return null;
    }
}

/** Weights to 4 significant digits, as the Weights tab prints them. */
const sig4 = (v: number) => String(Number(v.toPrecision(4))).replace(/^-/, '−');

/** "Weights at this step (Rounds 4-6): power 1.3, hp 0.9", the keys this row reads, when the source's weights change during a game. */
function WeightsLine({ view, row }: { view: ScoreView; row: RowDef | undefined }) {
    const { source, step } = view;
    const w = step.weights;
    if (!row || !w || (source.constantWeights && step.weightSet == null)) {
        return null;
    }
    const keys = row.uses.filter((k) => Number.isFinite(w[k]));
    if (!keys.length) {
        return null;
    }
    const set = step.weightSet ? setLabel(source, step.weightSet) : null;
    const base = source.weights;
    return (
        <p className="m-0 text-faint text-[11px] leading-snug">
            Weights at this step{set ? ` (${set})` : ''}:{' '}
            {keys.map((k, n) => {
                // a weight that differs from the file's default is brighter
                const moved = base != null && Number.isFinite(base[k]) && base[k] !== w[k];
                return (
                    <span key={k} className={moved ? 'text-fg' : undefined} title={moved ? `the file's default is ${sig4(base![k])}` : undefined}>
                        {k} <span className="num">{sig4(w[k])}</span>{n < keys.length - 1 ? ', ' : ''}
                    </span>
                );
            })}
        </p>
    );
}

/**
 * The owner's chance to win now and with the card's value taken off the edge, for a fitted or model source with
 * values that add up; null otherwise. It uses the step's round of the map, the logistic of log-odds, or (for a
 * chance written per step) moves that chance by the value in log-odds.
 */
function chanceWithout({ source, step }: ScoreView, value: CardValue): { from: number; to: number } | null {
    if ((source.chance !== 'fitted' && source.chance !== 'model') || source.cardValues !== 'additive' || value.v == null || step.p1Win == null || step.edge == null) {
        return null;
    }
    const sign = value.seat === 'p1' ? 1 : -1;
    const edge = step.edge - sign * value.v;
    const p = step.p1WinFrom === 'map' && source.map ? winProb(source.map, edge, step.round)
        : step.p1WinFrom === 'logit' ? sigmoid(edge)
        : sigmoid(logit(step.p1Win) - sign * source.kEff * value.v);
    const own = (x: number) => (value.seat === 'p1' ? x : 1 - x);
    return { from: own(step.p1Win), to: own(p) };
}

/** The search's verdict on the card, in its unit and tolerance; a sentinel reads "search sees a win" (not a proof). */
function RegretLine({ value, label }: { value: CardValue; label: string }) {
    const r = value.regret!;
    const tag = regretTag(value, false);
    const bot = value.searchBot ?? 'the bot';
    const tol = value.tolerance ?? 0.05;
    const unit = value.regretUnit ?? 'points';
    const search = `the ${label} search${value.searchKind ? ` (${value.searchKind})` : ''}`;
    let text: string;
    if (value.sees) {
        text = `Search sees a ${value.sees} for ${bot} with this card: ${search} saw the game end on every line it tried (not a proof).`;
    } else if (value.searchSees === 'win') {
        text = `The search saw a win for ${bot} with another move, but no line it tried with this card ended in a win (not a proof).`;
    } else if (r >= -tol) {
        text = `The move ${bot} played (or one within ${tol} ${unitText(unit)}) starts with this card.`;
    } else {
        const by = unit === 'prob' ? `${Math.abs(Math.round(r * 100))} pp of chance` : `${fmtCardValue(Math.abs(r), unit === 'logit' ? 2 : 1)} ${unitText(unit)}`;
        text = `${bot}'s best move with this card scored ${by} below the move it played.`;
    }
    return (
        <p className="m-0 text-[11px] leading-snug flex gap-1.5 items-start" title={tag.title}>
            <BrainCircuit size={13} className="text-fg shrink-0 mt-px" />
            <span className={`lensr !text-[10px] shrink-0${tag.cls ? ` ${tag.cls}` : ''}`}>{tag.text}</span>
            <span className={tag.cls.includes('pick') ? 'text-fg' : 'text-dim'}>{text}</span>
        </p>
    );
}

/**
 * Parts rounded to `digits` decimals so they add up to the total as fmtValue prints it (largest remainder), so +14.8
 * and −0.3 never sit under 14.6. Parts that don't add up to the total are left as they are.
 */
function roundParts(parts: number[], total: number, digits: number): number[] {
    const f = 10 ** digits;
    const floor = parts.map((x) => Math.floor(x * f + 1e-9));
    // from the printed string: toFixed and Math.round disagree at .x5 (25.65 prints 25.6)
    const want = Math.round(Number(Math.abs(total).toFixed(digits)) * f) * Math.sign(total);
    const off = want - floor.reduce((a, b) => a + b, 0);
    if (Math.abs(parts.reduce((a, b) => a + b, 0) - total) > 1 / f || off < 0 || off > parts.length) {
        return parts;
    }
    const order = parts.map((x, i) => ({ i, r: x * f - floor[i] })).sort((a, b) => b.r - a.r);
    order.slice(0, off).forEach(({ i }) => floor[i]++);
    return floor.map((x) => x / f);
}

/**
 * Why a card is worth what the chosen score says: its parts labelled from the score's terms (computed for Omni v1
 * files that give none), the rule of its row, the weights in force when they change, what losing it would do to the
 * chance, and the search's verdict on it.
 */
function ValueBreakdown({ focus, view }: { focus: Focus; view: ScoreView }) {
    const { source, step } = view;
    const w = step.weights;
    const row = rowOfFocus(focus, view);
    const seat = focus.value ? step.seats?.[focus.value.seat] : undefined;
    // the board leaves the value off hand cards that are all worth the same (the hand chip shows it once)
    const flatHand = focus.kind === 'hand' && focus.value?.v == null && seat?.hand.length && seat.hand.every((x) => x === seat.hand[0]) ? seat.hand[0] : null;
    const value = focus.value ? { ...focus.value, v: focus.value.v ?? flatHand } : null;
    const v = value?.v ?? null;
    // a base is a seat field, not a card the score can drop, so its value is plain even in an ablation score
    const abl = !!value?.ablation;
    const terms = focus.kind === 'base' ? source.baseTerms : focus.kind === 'unit' ? source.unitTerms : [];
    const why = noValuesWhy(view);
    const notes: string[] = [];
    let rows: { key: string; label: string; rule: string; how?: string; points: number }[] = [];
    if (!why && v != null) {
        const split = focus.kind === 'unit' || focus.kind === 'base';
        if (split) {
            rows = (value!.parts ?? []).map((p) => {
                const t = terms.find((x) => x.key === p.key);
                // a computed cost that is the rest of the file's value: the printed-cost rule doesn't describe it
                const rest = p.label.endsWith('(the rest)');
                const rule = rest ? 'the rest of the file\'s value' : t ? termRule(t, w) : '';
                return { ...p, rule, how: rest ? `what is left of the file's value for this card after the other parts (the rule is ${t ? termRule(t, w) : p.key})` : rule };
            });
        } else if (row && source.cardValues === 'additive') {
            rows = [{ key: row.id, label: row.label, rule: row.rule(w), how: row.how(w), points: v }];
        }
        // parts that add up: round them so the shown parts add up to the shown value too
        if (split && !abl && rows.length) {
            const shown = roundParts(rows.map((r) => r.points), v, digitsOf(source.unit));
            rows = rows.map((r, i) => ({ ...r, points: shown[i] }));
        }
        const hasCost = rows.some((r) => r.key === 'cost');
        const restCost = rows.some((r) => r.key === 'cost' && r.label.endsWith('(the rest)'));
        if (abl) {
            notes.push('Value = what the score loses without this card; values don\'t add up.');
        } else if (step.status === 'estimate') {
            notes.push(focus.kind !== 'unit' ? 'Estimated here from the board.'
                : hasCost ? 'Estimated here from the board, with the printed cost from the card data.'
                : 'Estimated here from the board: replays don\'t record card cost, so the cost part is left out.');
        } else if (split && seat?.partsFrom === 'computed' && rows.length) {
            notes.push(`No split in this file: parts computed here from its weights${focus.kind !== 'unit' ? '' : restCost ? ', cost is the rest of its value' : hasCost ? ', printed cost from card data' : ''}.`);
        } else if (split && !rows.length) {
            notes.push('This file gives no split for this card.');
        }
        if (step.status === 'held') {
            notes.push(`As of step ${step.heldFromN}: ${source.label} doesn't score every step.`);
        }
    } else if (!why && focus.kind === 'leader' && !row) {
        notes.push(focus.back ? 'Deployed: it scores as a unit on the board.' : `${source.label} gives an undeployed leader no value of its own.`);
    }
    const unitNote = !why && focus.kind === 'unit' && rows.length ? source.unitNote(w) : '';
    const lostAt = value && !why && focus.kind !== 'base' ? chanceWithout(view, value) : null;
    const lostPp = lostAt ? Math.round((lostAt.to - lostAt.from) * 100) : 0;
    // at 0% or 100% either way the line says nothing
    const lost = lostAt && !(lostPp === 0 && [0, 100].includes(Math.round(lostAt.from * 100))) ? lostAt : null;
    const color = rowColor(row?.id ?? value?.row ?? 'ground');
    return (
        <div className="flex flex-col gap-1 rounded-lg bg-ink/70 border border-line px-2.5 py-2">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="eyebrow">{source.cardValues === 'none' ? source.label : `${source.label} value`}</span>
                {!why && v != null && (
                    <span className="num font-semibold inline-flex items-center gap-1" style={{ color }} title={abl ? 'what the score loses without this card' : undefined}>
                        <PartIcon row={row ?? value!.row ?? 'ground'} />{abl && <span aria-hidden="true">⊖</span>}{fmtValue(v, source.unit)}
                        <span className="text-faint font-normal text-[10px]">{source.unitText}</span>
                    </span>
                )}
                <ScoreBadge source={source} step={step} className="ml-auto" />
            </div>
            {why && <p className="m-0 text-dim text-[11px] leading-snug">{why}</p>}
            {rows.length > 0 && (
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 text-[12px]">
                    {rows.map((r) => [
                        <span key={`${r.key}l`} className="text-dim truncate" title={r.how || r.rule || undefined}>
                            {r.label}{r.rule && <span className="text-faint text-[11px]"> · {r.rule}</span>}
                        </span>,
                        <span key={`${r.key}v`} className="num text-right" style={{ color: r.points < 0 ? 'var(--color-p2)' : 'var(--color-fg)' }}>{fmtSigned(r.points, source.unit)}</span>
                    ])}
                </div>
            )}
            {unitNote && <p className="m-0 text-faint text-[11px] leading-snug">{focus.unit?.x ? `Exhausted: ${unitNote}.` : `${unitNote[0].toUpperCase()}${unitNote.slice(1)}.`}</p>}
            {!why && <WeightsLine view={view} row={row} />}
            {notes.map((n) => <p key={n} className="m-0 text-faint text-[11px] leading-snug">{n}</p>)}
            {lost && (
                <p className="m-0 text-[11px] leading-snug text-dim"
                    title={`The chance this card's owner wins under ${source.label}, now and with the card's ${fmtCardValue(Math.abs(v!), source.digits)} ${source.unitText} taken off the edge${step.p1WinFrom === 'map' && source.map?.byRound?.length ? ` (the map for round ${step.round})` : ''}.`}>
                    If the score lost this card's value, {value?.owner ? `${value.owner}'s` : 'its owner\'s'} chance: <span className="num text-fg">{pct(lost.from)} → {pct(lost.to)}</span> <span className="num">({lostPp ? ppText(lostPp) : 'under 1 pp'})</span>.
                </p>
            )}
            {value?.regret != null && <RegretLine value={value} label={source.label} />}
        </div>
    );
}

/** Name, stats, upgrades and (with a score) the value breakdown of the inspected card. */
export function CardFacts({ focus, score, compact = false }: { focus: Focus; score: ScoreView | null; compact?: boolean }) {
    const u = focus.unit;
    const text = useFocusText(focus);
    const v = focus.value?.v;
    return (
        <div className="min-w-0 flex flex-col gap-1">
            <div className="font-display font-semibold leading-tight text-[15px]">{focus.card.n}{text?.st ? <span className="text-dim font-normal text-[13px]"> · {text.st}</span> : null}</div>
            <div className="flex flex-wrap gap-x-2 text-xs text-dim">
                {focus.note && <span>{focus.note}</span>}
                {u && <span className="num">{u.p} power · {u.h - u.d}/{u.h} HP{u.x ? ' · exhausted' : ''}{u.sn ? ' · Sentinel' : ''}</span>}
                <span className="num text-faint">{focus.card.s ?? 'token'}</span>
                {focus.card.id && <span className="num text-faint opacity-70" title="Card id: the same card for the whole game">{focus.card.id}</span>}
            </div>
            {u?.u?.length ? <div className="flex flex-wrap gap-1">{u.u.map((x, i) => <span key={i} className={`up !static${x.t ? ' token' : ''}`} title={x.t ? `${x.n} (token upgrade)` : x.n}>{x.n}</span>)}</div> : null}
            {u?.cap?.length ? (
                <div className="flex flex-wrap items-center gap-1 text-xs">
                    <span className="text-dim">Captured:</span>
                    {u.cap.map((x, i) => <span key={x.id ?? i} className="up more !static" title={`${x.n}${x.s ? ` · ${x.s}` : ''}${x.id ? ` · ${x.id}` : ''}: captured by this unit`}>{x.n}</span>)}
                </div>
            ) : null}
            {score && !compact && <ValueBreakdown focus={focus} view={score} />}
            {score && compact && v != null && (
                <span className="text-xs text-dim inline-flex items-center gap-1">
                    {score.source.label} value <PartIcon row={focus.value!.row ?? 'ground'} />
                    <b className="num" style={{ color: rowColor(focus.value!.row ?? 'ground') }}>{focus.value!.ablation ? '⊖' : ''}{fmtCardValue(v, score.source.digits)}</b>
                </span>
            )}
        </div>
    );
}

/**
 * Props of CardInspector and FloatingZoom: the card under the pointer (its value chip comes from the board) and the
 * chosen score at the playhead (source and ScoreStep); null when card values are off or the game has no score.
 */
export interface CardZoomProps {
    focus: Focus;
    score: ScoreView | null;
}

/** Whether the scrolling panel around `ref` has more below what it shows (the inspector follows the pointer, so no one scrolls it by habit). */
function useMoreBelow(ref: RefObject<HTMLElement | null>, key: unknown): boolean {
    const [more, setMore] = useState(false);
    useEffect(() => {
        const box = ref.current?.parentElement;
        if (!box) {
            return;
        }
        const check = () => setMore(box.scrollHeight - box.scrollTop - box.clientHeight > 4);
        check();
        const ro = new ResizeObserver(check);
        ro.observe(box);
        ro.observe(ref.current!);
        box.addEventListener('scroll', check, { passive: true });
        return () => {
            ro.disconnect();
            box.removeEventListener('scroll', check);
        };
    }, [ref, key]);
    return more;
}

/** The inspected card as large as the side panel allows, with its facts underneath. */
export function CardInspector({ focus, score }: CardZoomProps) {
    const text = useFocusText(focus);
    const ref = useRef<HTMLDivElement>(null);
    const more = useMoreBelow(ref, focus);
    return (
        <div className="flex flex-col gap-3" ref={ref}>
            <div className="grid place-items-center" style={{ height: 'min(350px, 44vh)' }}>
                <motion.div key={`${focus.card.s}:${focus.back}`} initial={{ opacity: 0.3, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.18 }}>
                    <Card card={focus.card} back={focus.back} shape={focus.shape} size="xl" kind={focus.kind} face={faceOf(focus, text)} />
                </motion.div>
            </div>
            <CardFacts focus={focus} score={score} />
            {more && (
                <div className="sticky -bottom-3 -mx-3 -mt-12 h-12 pointer-events-none flex items-end justify-center pb-1 bg-gradient-to-t from-panel from-30% to-transparent" aria-hidden="true">
                    <span className="rounded-full bg-panel border border-line px-2 text-[10px] text-dim">more below ▾</span>
                </div>
            )}
        </div>
    );
}

/**
 * The hovered card, enlarged next to the pointer, for layouts with no side panel beside the board (narrow windows,
 * compact embeds, phones). Fixed to the viewport and click-through.
 */
export function FloatingZoom({ focus, score }: CardZoomProps) {
    const text = useFocusText(focus);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const wide = focus.shape === 'wide';
    const cw = Math.min(wide ? 300 : 220, vw - 48);
    const ch = wide ? cw * 5 / 7 : cw * 7 / 5;
    const W = cw + 24;
    const H = ch + 96;
    const r = focus.rect ?? { left: vw / 2, right: vw / 2, top: vh / 2, bottom: vh / 2 };
    let left: number;
    let top: number;
    if (vw < 640) {
        left = (vw - W) / 2;
        top = r.top > vh / 2 ? Math.max(8, r.top - H - 8) : Math.min(vh - H - 8, r.bottom + 8);
    } else {
        left = r.right + 12 + W < vw ? r.right + 12 : Math.max(8, r.left - 12 - W);
        top = Math.max(8, Math.min(vh - H - 8, r.top - 20));
    }
    return (
        <motion.div className="panel !bg-panel fixed z-50 p-3 flex flex-col gap-2 pointer-events-none shadow-2xl" style={{ left, top, width: W }}
            initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.12 }} aria-hidden="true">
            <Card card={focus.card} back={focus.back} shape={focus.shape} size="xl" kind={focus.kind} width={cw} face={faceOf(focus, text)} />
            <CardFacts focus={focus} score={score} compact />
        </motion.div>
    );
}
