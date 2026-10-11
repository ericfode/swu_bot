import type { Game, PlayerSnap, Seat, Snapshot, UnitRef } from './types';

/**
 * The card-value lens (`swu-lens/1`, written by bot/omni/lens.js into dashboard/lens/<gameId>.json, spec in
 * /mnt/project-files/omni/LENS.md): what each card on the table is worth to the omniscient bot, in the points of the
 * position score its search uses at the leaves. Values are good for the card's owner.
 */
export interface LensSide {
    /** base HP term */
    base: number;
    /** one value per unit, same order as the snapshot's ground / space / hand */
    ground: number[];
    space: number[];
    hand: number[];
    /** all resources together */
    resources: number;
    /** 0 when the other side has it */
    initiative: number;
    total: number;
}

/** The omni bot's search at a board it was about to act on: per card, best move started by that card minus the move it played. */
export interface LensSearch {
    by: Seat;
    value: number;
    depth?: number;
    nodes?: number;
    ms?: number;
    /** principal variation, one entry per action window */
    pv?: string[];
    /** 0 = the card it chose, negative = worse, null = no move */
    ground?: (number | null)[];
    space?: (number | null)[];
    hand?: (number | null)[];
    leader?: number | null;
    buttons?: Record<string, number>;
}

export interface LensStep {
    /** Step.n of the replay step; values are for the board after that step's move */
    n: number;
    p1: LensSide;
    p2: LensSide;
    /** p1.total - p2.total */
    edge: number;
    search?: LensSearch;
}

export interface LensFile {
    schema: string;
    gameId?: string;
    seed?: number;
    players?: { id: Seat; bot: string }[];
    weights?: Partial<LensWeights>;
    source?: string;
    steps: LensStep[];
}

export const OMNI_WEIGHTS = { power: 1.3, hp: 0.9, cost: 0.25, shield: 2.2, upgrade: 0.6, sentinel: 1, exhaustedMult: 0.85, hand: 1.8, resource: 1.4, initiative: 2.5, baseHp: 0.9, baseMult: 1.5 };
export type LensWeights = typeof OMNI_WEIGHTS;

/** One position as the omni bot scores it. `exact`: read from its lens file; otherwise estimated here, without card cost (replays don't record it). */
export interface LensView extends LensStep {
    exact: boolean;
    weights: LensWeights;
}

/** Edge in points squashed to -1..1 for the curves (an edge of 25 points reads as about 0.76). */
export const LENS_SCALE = 25;

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const r2 = (v: number) => Math.round(v * 100) / 100;
export const isShield = (u: { n: string }) => u.n === 'Shield';

/** The omni score's base term: it falls faster near 0 HP (the heuristic bot adds the low-base term instead, a bug the omni score fixes). */
export function baseValue(hpLeft: number, w: LensWeights = OMNI_WEIGHTS): number {
    const hp = Math.max(0, hpLeft);
    return w.baseMult * (hp * w.baseHp - (hp <= 12 ? (12 - hp) ** 2 / 6 : 0));
}

/** The parts of the score, in the order the breakdown lists them. */
export type TermKey = 'base' | 'ground' | 'space' | 'hand' | 'resources' | 'initiative';

/**
 * One colour per part of the score, used everywhere the lens shows a number: the chip on a card, the lane and HQ totals,
 * the breakdown row and the card inspector. Seat is shown by where a number sits (and by the totals' outline), never by
 * these colours, so a green number is always a ground unit's worth, whoever owns it.
 */
export const TERM_COLOR: Record<TermKey, string> = {
    base: 'var(--color-v-base)',
    ground: 'var(--color-v-ground)',
    space: 'var(--color-v-space)',
    hand: 'var(--color-v-hand)',
    resources: 'var(--color-v-res)',
    initiative: 'var(--color-v-init)'
};

/** A unit's value without its cost term (the replay has no costs). */
export function unitValueNoCost(u: UnitRef, w: LensWeights = OMNI_WEIGHTS): number {
    let v = u.p * w.power + Math.max(0, u.h - u.d) * w.hp;
    for (const up of u.u ?? []) {
        v += isShield(up) ? w.shield : w.upgrade;
    }
    if (u.sn) {
        v += w.sentinel;
    }
    return u.x ? v * w.exhaustedMult : v;
}

export interface UnitTerm {
    key: 'power' | 'hp' | 'cost' | 'shield' | 'upgrade' | 'sentinel' | 'exhausted';
    label: string;
    points: number;
}

/**
 * Why a unit is worth what it is: power, HP left, shields, other upgrades, Sentinel, then the exhausted discount. With
 * the lens file's exact value, the cost term is what is left over (value / discount - the rest).
 */
export function unitTerms(u: UnitRef, value: number | null, w: LensWeights = OMNI_WEIGHTS): UnitTerm[] {
    const hp = Math.max(0, u.h - u.d);
    const shields = (u.u ?? []).filter(isShield).length;
    const ups = (u.u ?? []).length - shields;
    const raw: UnitTerm[] = [
        { key: 'power', label: `${u.p} power × ${w.power}`, points: u.p * w.power },
        { key: 'hp', label: `${hp} HP left × ${w.hp}`, points: hp * w.hp }
    ];
    if (shields) {
        raw.push({ key: 'shield', label: `${shields} Shield × ${w.shield}`, points: shields * w.shield });
    }
    if (ups) {
        raw.push({ key: 'upgrade', label: `${ups} upgrade${ups > 1 ? 's' : ''} × ${w.upgrade}`, points: ups * w.upgrade });
    }
    if (u.sn) {
        raw.push({ key: 'sentinel', label: 'Sentinel', points: w.sentinel });
    }
    const mult = u.x ? w.exhaustedMult : 1;
    if (value != null) {
        const cost = value / mult - sum(raw.map((t) => t.points));
        if (Math.abs(cost) > 0.04) {
            const c = Math.round(cost / w.cost);
            raw.splice(2, 0, { key: 'cost', label: `cost ${c} × ${w.cost}`, points: cost });
        }
    }
    if (u.x) {
        raw.push({ key: 'exhausted', label: `exhausted × ${w.exhaustedMult}`, points: -(1 - mult) * sum(raw.map((t) => t.points)) });
    }
    return raw.map((t) => ({ ...t, points: r2(t.points) }));
}

function estimateSide(p: PlayerSnap, initiative: boolean, w: LensWeights): LensSide {
    const ground = p.ground.map((u) => r2(unitValueNoCost(u, w)));
    const space = p.space.map((u) => r2(unitValueNoCost(u, w)));
    const hand = p.hand.map(() => w.hand);
    const base = r2(baseValue(p.base.hp - p.base.d, w));
    const resources = r2(p.res.total * w.resource);
    const init = initiative ? w.initiative : 0;
    return { base, ground, space, hand, resources, initiative: init, total: r2(base + sum(ground) + sum(space) + sum(hand) + resources + init) };
}

/** The static layer of the lens computed from a snapshot alone (no cost term). */
export function estimateLens(s: Snapshot, w: LensWeights = OMNI_WEIGHTS): LensStep {
    const p1 = estimateSide(s.players.p1, s.initiative === 'p1', w);
    const p2 = estimateSide(s.players.p2, s.initiative === 'p2', w);
    return { n: -1, p1, p2, edge: r2(p1.total - p2.total) };
}

/** Lens steps keyed by replay step index (matched on Step.n). */
export function lensByIndex(game: Game, lens: LensFile | null | undefined): Map<number, LensStep> {
    const out = new Map<number, LensStep>();
    if (!lens?.steps?.length) {
        return out;
    }
    const indexOfN = new Map(game.steps.map((s, i) => [s.n, i]));
    for (const st of lens.steps) {
        const i = indexOfN.get(st.n);
        if (i != null) {
            out.set(i, st);
        }
    }
    return out;
}

const fits = (l: LensSide, p: PlayerSnap) => l.ground.length === p.ground.length && l.space.length === p.space.length && l.hand.length === p.hand.length;

/** The lens at step index i: the file's values when it has this step and they line up with the board, else the estimate. */
export function lensAt(game: Game, i: number, byIndex: Map<number, LensStep>, lens?: LensFile | null): LensView {
    const w = { ...OMNI_WEIGHTS, ...(lens?.weights ?? {}) };
    const s = game.steps[i].state;
    const st = byIndex.get(i);
    if (st && fits(st.p1, s.players.p1) && fits(st.p2, s.players.p2)) {
        return { ...st, exact: true, weights: w };
    }
    return { ...estimateLens(s, w), n: game.steps[i].n, exact: false, weights: w };
}

/** p1's lens edge per step, squashed to -1..1, for the curves. */
export function lensEdges(game: Game, byIndex: Map<number, LensStep>, lens?: LensFile | null): number[] {
    return game.steps.map((_, i) => Math.tanh(lensAt(game, i, byIndex, lens).edge / LENS_SCALE));
}
