import { motion } from 'motion/react';
import { BrainCircuit } from 'lucide-react';
import { Card, type Focus } from './Card';
import type { ScoreView } from '../data/score';
import { rowColor } from '../data/terms';
import { PartIcon } from './TermIcon';
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

const sg = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`;

/** Why a card is worth what the chosen score says: the parts of that one card, labelled from the score's terms. */
function ValueBreakdown({ focus, lens }: { focus: Focus; lens: ScoreView }) {
    const { source, step } = lens;
    const v = focus.value?.v ?? null;
    const rows = [...(focus.value?.parts ?? [])];
    const seat = step.seats?.[focus.value?.seat ?? 'p1'];
    let note: string | null = null;
    if (focus.kind === 'unit' && v != null) {
        if (focus.unit?.x && rows.length) {
            note = `Exhausted: ${source.unitNote(step.weights)}.`;
        }
        if (step.status === 'estimate') {
            note = `${note ? `${note} ` : ''}${rows.some((r) => r.key === 'cost') ? 'Estimated here from the board, with the printed cost from the card data.'
                : 'Estimated here from the board: replays don\'t record card cost, so the cost part is left out.'}`;
        } else if (seat?.partsFrom === 'computed' && seat.costFrom === 'rest') {
            note = `${note ? `${note} ` : ''}This file gives no split: the parts are computed here, and cost is the rest of the file's value.`;
        } else if (!rows.length) {
            note = 'This file gives no split for this card.';
        }
    } else if (focus.kind === 'base' && v != null) {
        const hp = focus.hpLeft ?? null;
        if (hp != null && (focus.value?.parts ?? []).some((r) => r.key === 'danger' && r.points < 0)) {
            note = 'Under the danger line the base loses worth faster the closer it gets to 0 HP.';
        }
    } else if (focus.kind === 'hand' && v != null) {
        rows.push({ key: 'hand', label: 'any card in hand', points: v });
    } else if (focus.kind === 'leader') {
        note = `${source.label} gives an undeployed leader no value of its own; once deployed it scores as a unit.`;
    }
    const regret = focus.value?.regret;
    return (
        <div className="flex flex-col gap-1 rounded-lg bg-ink/70 border border-line px-2.5 py-2">
            <div className="flex items-baseline gap-2">
                <span className="eyebrow">{source.label} value</span>
                {v != null && <span className="num font-semibold inline-flex items-center gap-1" style={{ color: rowColor(focus.value!.row ?? 'ground') }}><PartIcon row={focus.value!.row ?? 'ground'} />{v.toFixed(1)}</span>}
                <span className="text-faint text-[10px] ml-auto">{step.status === 'file' ? 'lens file' : step.status === 'estimate' ? 'estimate' : step.status}</span>
            </div>
            {rows.length > 0 && (
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 text-[12px]">
                    {rows.map((r) => [
                        <span key={`${r.label}l`} className="text-dim truncate">{r.label}</span>,
                        <span key={`${r.label}v`} className="num text-right" style={{ color: r.points < 0 ? 'var(--color-p2)' : 'var(--color-fg)' }}>{sg(r.points)}</span>
                    ])}
                </div>
            )}
            {note && <p className="m-0 text-faint text-[11px] leading-snug">{note}</p>}
            {regret != null && (
                <p className="m-0 text-[11px] leading-snug flex gap-1.5 items-start">
                    <BrainCircuit size={13} className="text-fg shrink-0 mt-px" />
                    {regret >= -0.05
                        ? <span className="text-fg">★ The omni bot's chosen move (or one just as good) starts with this card.</span>
                        : <span className="text-dim">The omni bot's best move with this card scored <b className="text-fg">{Math.abs(regret).toFixed(1)}</b> points below the move it played.</span>}
                </p>
            )}
        </div>
    );
}

/** Name, stats, upgrades and (under the lens) the value breakdown of the inspected card. */
export function CardFacts({ focus, lens, compact = false }: { focus: Focus; lens: ScoreView | null; compact?: boolean }) {
    const u = focus.unit;
    const text = useFocusText(focus);
    return (
        <div className="min-w-0 flex flex-col gap-1">
            <div className="font-display font-semibold leading-tight text-[15px]">{focus.card.n}{text?.st ? <span className="text-dim font-normal text-[13px]"> · {text.st}</span> : null}</div>
            <div className="flex flex-wrap gap-x-2 text-xs text-dim">
                {focus.note && <span>{focus.note}</span>}
                {u && <span className="num">{u.p} power · {u.h - u.d}/{u.h} HP{u.x ? ' · exhausted' : ''}{u.sn ? ' · Sentinel' : ''}</span>}
                <span className="num text-faint">{focus.card.s ?? 'token'}</span>
            </div>
            {u?.u?.length ? <div className="flex flex-wrap gap-1">{u.u.map((x, i) => <span key={i} className={`up !static${x.t ? ' token' : ''}`} title={x.t ? `${x.n} (token upgrade)` : x.n}>{x.n}</span>)}</div> : null}
            {lens && !compact && <ValueBreakdown focus={focus} lens={lens} />}
            {lens && compact && focus.value?.v != null && <span className="text-xs text-dim inline-flex items-center gap-1">{lens.source.label} value <PartIcon row={focus.value.row ?? 'ground'} /><b className="num" style={{ color: rowColor(focus.value.row ?? 'ground') }}>{focus.value.v.toFixed(1)}</b></span>}
        </div>
    );
}

/** The inspected card as large as the side panel allows, with its facts underneath. */
export function CardInspector({ focus, lens }: { focus: Focus; lens: ScoreView | null }) {
    const text = useFocusText(focus);
    return (
        <div className="flex flex-col gap-3">
            <div className="grid place-items-center" style={{ height: 'min(350px, 44vh)' }}>
                <motion.div key={`${focus.card.s}:${focus.back}`} initial={{ opacity: 0.3, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.18 }}>
                    <Card card={focus.card} back={focus.back} shape={focus.shape} size="xl" kind={focus.kind} face={faceOf(focus, text)} />
                </motion.div>
            </div>
            <CardFacts focus={focus} lens={lens} />
        </div>
    );
}

/**
 * The hovered card, enlarged next to the pointer, for layouts with no side panel beside the board (narrow windows,
 * compact embeds, phones). Fixed to the viewport and click-through.
 */
export function FloatingZoom({ focus, lens }: { focus: Focus; lens: ScoreView | null }) {
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
            <CardFacts focus={focus} lens={lens} compact />
        </motion.div>
    );
}
