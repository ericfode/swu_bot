import { useEffect, useMemo, useState } from 'react';
import type { CardRef, Game, PlayerSnap, Seat, Snapshot } from './types';
import {
    isNum, isObj, readLens, type CardValues, type Evaluator, type LensIndex, type LensRead, type LensSearch, type LensSide, type LensStep, type Quality,
    type Sampling, type Sees, type TermDef, type Weights, type WinMap
} from './lensFile';
import { chanceState, kEffOf, logit, sigmoid, typicalOf, winProb, type Chance } from './calibrate';
import { defaultTolerance, digitsOf, displayScales, unitText, type DisplayScales } from './format';
import { OTHER_ROW, rowsOf, unitNoteOf, type RowDef } from './terms';
import { estimateOmniV1, OMNI_V1_EVALUATOR, OMNI_V1_ID, OMNI_V1_LABEL, OMNI_V1_WEIGHTS, splitBase, splitUnit, type CostFrom } from './omniV1';

/**
 * One score, resolved once per game. Every lens file of a game (and, for a game with no file, the built-in Omni v1
 * estimate) is a source; the chosen source is resolved into a series with one entry per replay step. The board, the
 * card chips, the breakdown, the inspector, the timeline and the swings all read that series: no view computes a score
 * itself, and a gap in a file stays a gap (never filled from another source or from the estimate).
 */

export type { Chance } from './calibrate';

/** One lens file as given to sourcesFor: its dir ('' = the default path) and the parsed JSON. */
export interface LensInput {
    dir: string;
    file: unknown;
}

export interface ScoreSource {
    /** the dir ('' = the default path), or 'estimate' */
    key: string;
    id: string;
    label: string;
    description: string;
    /** 'points' | 'logit' | another unit */
    unit: string;
    unitText: string;
    /** decimals for values: 1 for points, 2 for log-odds */
    digits: number;
    sees: Sees;
    perspective: Seat | null;
    cardValues: CardValues;
    sampling: Sampling;
    quality: Quality | null;
    /** the chance map (the built-in rough map for Omni v1 files that give none) */
    map: WinMap | null;
    chance: Chance;
    /** log-odds per unit of edge (calibrate.kEffOf) */
    kEff: number;
    typical: number;
    typicalFrom: 'file' | 'logit' | 'percentile';
    /** declared rows, in breakdown order */
    rows: RowDef[];
    unitTerms: TermDef[];
    baseTerms: TermDef[];
    /** the unit note, filled with these weights */
    unitNote: (w: Weights | null) => string;
    builtIn: 'omni-v1' | 'legacy' | null;
    origin: 'file' | 'estimate';
    /** the file's default weights (W2), and its named weight sets */
    weights: Weights | null;
    weightSets: Record<string, { label: string; weights: Weights }>;
    constantWeights: boolean;
    /** the file as read; null for the estimate and for a refused file */
    lens: LensRead | null;
    /** the file was refused (e.g. another schema major): nothing of it is drawn, this says why */
    error: string | null;
    warnings: string[];
}

export interface SeatScore {
    base: number;
    ground: number[];
    space: number[];
    hand: number[];
    resources: number;
    initiative: number;
    extra: Record<string, number>;
    /** from the data; null when the file gives none (cardValues "ablation") */
    total: number | null;
    /** row id → this seat's value in that row (declared seat rows only) */
    rows: Record<string, number>;
    /** what each card's value is made of: from the file, computed (Omni v1 files without parts, the estimate), or none */
    parts: { base: Record<string, number> | null; ground: (Record<string, number> | null)[]; space: (Record<string, number> | null)[] };
    partsFrom: 'file' | 'computed' | 'none';
    /** for computed unit parts: where each unit's cost part came from (card data, the rest of the file's value, or none) */
    unitCostFrom?: { ground: CostFrom[]; space: CostFrom[] };
    /** the seat's summary of unitCostFrom: 'rest' when any unit's cost is the rest, else 'card' when any is from card data */
    costFrom?: CostFrom;
}

/** A search block with its defaults filled in. `sees`: the 9999 / −9998 sentinels (the search saw the game end on every line it tried; not a proof). */
export interface NormSearch extends Omit<LensSearch, 'kind'> {
    frame: 'by';
    unit: string;
    tolerance: number;
    kind: string | null;
    sees: 'win' | 'loss' | null;
    stats: Record<string, number>;
}

export interface ScoreStep {
    /** step index into game.steps, and its Step.n */
    i: number;
    n: number;
    /** state.round of the snapshot (setup is round 0): picks a map's byRound entry */
    round: number;
    /** file: the file's values; estimate: computed here; held: a sparse source's last value; missing / mismatch: a gap */
    status: 'file' | 'estimate' | 'held' | 'missing' | 'mismatch';
    /** held: the step index the values were taken from, and its Step.n */
    heldFrom?: number;
    heldFromN?: number;
    edge: number | null;
    /**
     * P(p1 wins) on the source's one scale: for a fitted or model source the step's p1Win, else the map, else the logistic
     * of log-odds; for a rough source always the map, and null for a source with no chance (so a file with p1Win on only
     * some steps never shows two chances under one label). The step's own p1Win is in stepP1Win.
     */
    p1Win: number | null;
    p1WinFrom: 'step' | 'map' | 'logit' | null;
    /** the file's own p1Win at this step (0..1), whether or not the source's chance uses it */
    stepP1Win: number | null;
    seats: Record<Seat, SeatScore> | null;
    joint: Record<string, number>;
    /** what the rows don't explain (shown as "Other (not split)"); null when they add up within the tolerance */
    other: { p1: number | null; p2: number | null; edge: number } | null;
    /** the weights in force (W1), the set's name, and whether they differ from the previous step's */
    weights: Weights | null;
    weightSet: string | null;
    weightsChanged: boolean;
    edgePrevWeights: number | null;
    /** an exhaustive solver proved a win for this seat (never set by a capped search's sentinels) */
    proven: { seat: Seat; inWindows?: number; by?: string } | null;
    search: NormSearch | null;
    /** an estimated step: whether the game's estimate took card cost from card data, decided once for the series */
    estimateCost?: 'card' | 'none';
}

export interface ScoreSeries {
    source: ScoreSource;
    steps: ScoreStep[];
    scales: DisplayScales;
    coverage: { file: number; estimate: number; held: number; missing: number; mismatch: number };
    /** steps whose rows don't add up to the file's total or edge ("Other (not split)" shown) */
    unsplit: number;
}

/** A source and one of its steps: what the board, the breakdown and the inspector draw. */
export interface ScoreView {
    source: ScoreSource;
    step: ScoreStep;
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
/** a p1Win the viewer reads: a number in 0..1 (I6); readLens warns about any other */
const isChance = (v: unknown): v is number => isNum(v) && v >= 0 && v <= 1;
/** a seat value that is not a number reads as 0 (readLens warns), so no view formats a string or NaN */
const num = (v: unknown) => (isNum(v) ? v : 0);
const SEATS: Seat[] = ['p1', 'p2'];
/** the weights the Omni v1 split reads (splitUnit, splitBase), dangerHp and danger aside */
const SPLIT_KEYS = ['power', 'hp', 'cost', 'shield', 'upgrade', 'sentinel', 'exhaustedMult', 'baseHp', 'baseMult'];
/** |search value| at or above this is a sentinel: the search saw the game end on every line it tried */
export const SENTINEL = 9000;
export const isSentinel = (v: number | null | undefined) => v != null && Math.abs(v) >= SENTINEL;
/**
 * What a card's best line saw, from its regret: the line's value is search.value + regret, so a card under a 9999 search
 * with regret −9963 scored 36 (it misses the win the search saw) and is not a "sees loss" card. 'win' or 'loss' when that
 * value is itself a sentinel, else null (show the regret as a number).
 */
export function cardSees(search: Pick<NormSearch, 'value'>, regret: number | null | undefined): 'win' | 'loss' | null {
    if (regret == null || !isNum(regret)) {
        return null;
    }
    const v = search.value + regret;
    return isSentinel(v) ? (v > 0 ? 'win' : 'loss') : null;
}
/** the invariants' tolerance: 0.05 for points, 0.005 for log-odds */
export const sumTolerance = (unit: string) => (unit === 'logit' ? 0.005 : 0.05) + 1e-9;

/** The bot name of each seat from the replay header (the seat id when a header names none). */
export const botsOf = (game: Game): Record<Seat, string> => ({
    p1: game.header.players.find((p) => p.id === 'p1')?.bot ?? 'p1',
    p2: game.header.players.find((p) => p.id === 'p2')?.bot ?? 'p2'
});

function sourceOf(game: Game, key: string, lens: LensRead | null, ev: Evaluator, origin: ScoreSource['origin'], weights: Weights | null, builtIn: ScoreSource['builtIn']): ScoreSource {
    const steps = lens?.file.steps ?? [];
    const edges = steps.map((s) => s?.edge).filter(isNum);
    const typical = typicalOf(ev, edges);
    const sets = lens && isObj(lens.file.weightSets) ? lens.file.weightSets : {};
    const weightSets = Object.fromEntries(Object.entries(sets).filter(([, s]) => isObj(s) && isObj(s.weights))
        .map(([k, s]) => [k, { label: typeof s.label === 'string' ? s.label : k, weights: s.weights }]));
    const kEff = kEffOf(ev, typical.value);
    return {
        key, id: ev.id,
        label: ev.perspective ? `${ev.label}, as ${botsOf(game)[ev.perspective]} weighs it` : ev.label,
        description: ev.description,
        unit: ev.unit, unitText: unitText(ev.unit), digits: digitsOf(ev.unit),
        sees: ev.sees, perspective: ev.perspective, cardValues: ev.cardValues, sampling: ev.sampling,
        quality: ev.quality, map: ev.toWinProb,
        // the evaluator's own chance only when every step writes p1Win; with some, the others still use the map
        chance: chanceState(ev, steps.length > 0 && steps.every((s) => isChance(s?.p1Win))),
        kEff, typical: typical.value, typicalFrom: typical.from,
        rows: rowsOf(ev), unitTerms: ev.terms.unit, baseTerms: ev.terms.base,
        unitNote: unitNoteOf(ev),
        builtIn, origin, weights, weightSets, constantWeights: ev.constantWeights,
        lens, error: null, warnings: lens?.warnings ?? []
    };
}

/** The built-in Omni v1 estimate as a source (a game with no lens file). */
export function estimateSource(game: Game): ScoreSource {
    const r = readLens({ schema: 'swu-lens/1', evaluator: { ...OMNI_V1_EVALUATOR, label: `${OMNI_V1_LABEL} · estimated here` }, weights: OMNI_V1_WEIGHTS, steps: [] });
    if ('error' in r) {
        throw new Error(r.error);
    }
    return { ...sourceOf(game, 'estimate', null, r.evaluator, 'estimate', OMNI_V1_WEIGHTS, 'omni-v1'), warnings: [] };
}

function refused(key: string, error: string): ScoreSource {
    return {
        key, id: 'refused', label: 'Lens file', description: '', unit: 'points', unitText: 'points', digits: 1, sees: 'public', perspective: null,
        cardValues: 'none', sampling: 'every-step', quality: null, map: null, chance: 'none', kEff: 1, typical: 1, typicalFrom: 'file',
        rows: [], unitTerms: [], baseTerms: [], unitNote: () => '', builtIn: null, origin: 'file', weights: null, weightSets: {}, constantWeights: true,
        lens: null, error, warnings: []
    };
}

/**
 * The score sources of a game: one per lens file (in the registry's order when there is one, else the default path
 * first), plus the Omni v1 estimate when the game has no file at all and `estimate` is not false. A refused file is a
 * source with `error` set, so the viewer can say why it draws nothing.
 */
export function sourcesFor(game: Game, files: LensInput[], registry?: LensIndex | null, opts: { estimate?: boolean } = {}): ScoreSource[] {
    const order = (dir: string) => {
        const k = registry?.evaluators.findIndex((e) => e.dir === dir) ?? -1;
        return k >= 0 ? k : dir === '' ? -1 : 1e6;
    };
    const sorted = files.map((f, k) => ({ f, k })).sort((a, b) => order(a.f.dir) - order(b.f.dir) || a.k - b.k).map((x) => x.f);
    const out: ScoreSource[] = [];
    for (const { dir, file } of sorted) {
        if (out.some((s) => s.key === dir)) {
            continue;
        }
        const r = readLens(file);
        out.push('error' in r ? refused(dir, r.error) : sourceOf(game, dir, r, r.evaluator, 'file', r.weights, r.builtIn));
    }
    if (!files.length && opts.estimate !== false) {
        out.push(estimateSource(game));
    }
    return out;
}

/**
 * The source to open on, in order: the requested key (deep link, mount option), the saved choice, the registry's
 * default, the default-path file, the first fitted or model source, the first file, the estimate; null when there is
 * none. A hindsight source is opened only when asked for by key, and a refused file only when asked for or when every
 * source is refused.
 */
export function chooseDefault(sources: ScoreSource[], opts: { requested?: string | null; saved?: string | null; registryDefault?: string | null } = {}): ScoreSource | null {
    const byKey = (k: string | null | undefined) => (k == null ? undefined : sources.find((s) => s.key === k));
    const asked = byKey(opts.requested);
    if (asked) {
        return asked;
    }
    const open = sources.filter((s) => s.sees !== 'hindsight');
    // a refused file only when every other source is refused too
    const auto = open.some((s) => !s.error) ? open.filter((s) => !s.error) : open;
    const autoKey = (k: string | null | undefined) => (k == null ? undefined : auto.find((s) => s.key === k));
    return autoKey(opts.saved) ?? autoKey(opts.registryDefault) ?? autoKey('')
        ?? auto.find((s) => !s.error && (s.chance === 'fitted' || s.chance === 'model'))
        ?? auto.find((s) => s.origin === 'file' && !s.error) ?? auto.find((s) => s.origin === 'estimate') ?? null;
}

/** A lens side lines up with the board: ground, space and hand have the snapshot's lengths. */
export const zonesFit = (l: Pick<LensSide, 'ground' | 'space' | 'hand'>, p: PlayerSnap) => Array.isArray(l.ground) && Array.isArray(l.space) && Array.isArray(l.hand)
    && l.ground.length === p.ground.length && l.space.length === p.space.length && l.hand.length === p.hand.length;

/** one card: by `id` when both copies have one (protocol v2 replays), else by name (older replays) */
const sameCard = (a: CardRef, b: CardRef) => (a.id != null && b.id != null ? a.id === b.id : a.n === b.n);

/**
 * the same cards, in order, in ground, space and hand: a held value's chips still sit on the cards it scored (a copy
 * with the same name that came in after the scored one left is another card)
 */
const sameCards = (a: PlayerSnap, b: PlayerSnap) => (['ground', 'space', 'hand'] as const)
    .every((z) => a[z].length === b[z].length && a[z].every((c, k) => sameCard(c, b[z][k])));

const weightsKey = (w: Weights | null) => (w ? JSON.stringify(Object.keys(w).sort().map((k) => [k, w[k]])) : '');

function seatScore(src: ScoreSource, l: LensSide, p: PlayerSnap, w: Weights | null, cardCost?: (c: CardRef) => number | null | undefined): SeatScore {
    const extra: Record<string, number> = isObj(l.extra) ? Object.fromEntries(Object.entries(l.extra).filter(([, v]) => isNum(v))) as Record<string, number> : {};
    const s = {
        base: num(l.base), ground: l.ground.map(num), space: l.space.map(num), hand: l.hand.map(num), resources: num(l.resources), initiative: num(l.initiative),
        extra, total: isNum(l.total) ? l.total : null
    };
    const rows: Record<string, number> = {};
    for (const r of src.rows) {
        const v = r.id === 'base' ? s.base : r.id === 'ground' ? sum(s.ground) : r.id === 'space' ? sum(s.space)
            : r.id === 'side.hand' ? sum(s.hand) : r.id === 'side.resources' ? s.resources : r.id === 'side.initiative' ? s.initiative
            : r.group === 'extra' ? extra[r.key] ?? 0 : null;
        if (v != null) {
            rows[r.id] = v;
        }
    }
    let parts: SeatScore['parts'] = { base: null, ground: s.ground.map(() => null), space: s.space.map(() => null) };
    let partsFrom: SeatScore['partsFrom'] = 'none';
    let unitCostFrom: SeatScore['unitCostFrom'];
    if (isObj(l.parts) && src.cardValues === 'additive') {
        const fp = l.parts;
        parts = {
            base: isObj(fp.base) ? fp.base as Record<string, number> : null,
            ground: s.ground.map((_, k) => (Array.isArray(fp.ground) && isObj(fp.ground[k]) ? fp.ground[k] as Record<string, number> : null)),
            space: s.space.map((_, k) => (Array.isArray(fp.space) && isObj(fp.space[k]) ? fp.space[k] as Record<string, number> : null))
        };
        partsFrom = 'file';
    } else if (src.builtIn && src.cardValues === 'additive' && w && SPLIT_KEYS.every((k) => isNum(w[k]))) {
        // an Omni v1 file without parts: the split computed from the built-in formula, cost from card data or the rest.
        // Only with every weight it reads in force (W1: never filled from the built-in ones; dangerHp and danger, which
        // older files leave out, are the one exception)
        const ground = p.ground.map((u, k) => splitUnit(u, w, { value: s.ground[k], cost: cardCost?.(u) ?? null }));
        const space = p.space.map((u, k) => splitUnit(u, w, { value: s.space[k], cost: cardCost?.(u) ?? null }));
        parts = { base: splitBase(p.base.hp - p.base.d, w), ground: ground.map((r) => r.parts), space: space.map((r) => r.parts) };
        partsFrom = 'computed';
        unitCostFrom = { ground: ground.map((r) => r.costFrom), space: space.map((r) => r.costFrom) };
    }
    return { ...s, rows, parts, partsFrom, ...(unitCostFrom ? withCostFrom(unitCostFrom) : {}) };
}

/** Per-unit cost sources and the seat's summary of them. */
function withCostFrom(u: NonNullable<SeatScore['unitCostFrom']>): Pick<SeatScore, 'unitCostFrom' | 'costFrom'> {
    const all = [...u.ground, ...u.space];
    return { unitCostFrom: u, costFrom: all.includes('rest') ? 'rest' : all.includes('card') ? 'card' : 'none' };
}

function normSearch(s: LensSearch, unit: string): NormSearch {
    const u = typeof s.unit === 'string' ? s.unit : unit;
    return {
        ...s, frame: 'by', unit: u,
        tolerance: isNum(s.tolerance) ? s.tolerance : defaultTolerance(u),
        kind: typeof s.kind === 'string' ? s.kind : null,
        sees: isSentinel(s.value) ? (s.value > 0 ? 'win' : 'loss') : null,
        stats: isObj(s.stats) ? Object.fromEntries(Object.entries(s.stats).filter(([, v]) => isNum(v))) as Record<string, number> : {}
    };
}

/**
 * P(p1 wins) at a step of a source: C1 step p1Win (only for a fitted or model source: a rough or uncalibrated one keeps
 * one scale on every step), C2 the map at the step's round, C3 log-odds; null for no chance.
 */
function chanceOf(src: ScoreSource, st: Pick<LensStep, 'p1Win'>, edge: number | null, round: number): { p: number | null; from: ScoreStep['p1WinFrom'] } {
    if (isChance(st.p1Win) && (src.chance === 'fitted' || src.chance === 'model')) {
        return { p: st.p1Win, from: 'step' };
    }
    if (edge == null) {
        return { p: null, from: null };
    }
    if (src.map) {
        return { p: winProb(src.map, edge, round), from: 'map' };
    }
    return src.unit === 'logit' ? { p: sigmoid(edge), from: 'logit' } : { p: null, from: null };
}

/**
 * Resolves a source over a game: one ScoreStep per replay step, matched on Step.n. A file step whose ground, space or
 * hand lengths differ from the snapshot is a mismatch; a step the file lacks is missing (every-step sources) or held
 * (decision and checkpoint sources hold the last value). `cardCost` gives printed costs (card data) for the estimate
 * and for the computed split of Omni v1 files without parts.
 */
export function resolveScore(game: Game, source: ScoreSource, opts: { cardCost?: (c: CardRef) => number | null | undefined } = {}): ScoreSeries {
    const byN = new Map<number, LensStep>();
    for (const st of source.lens?.file.steps ?? []) {
        // a repeated n (I5): the last copy, as earlier builds read it (readLens warns)
        if (isObj(st) && isNum(st.n)) {
            byN.set(st.n, st);
        }
    }
    const tol = sumTolerance(source.unit);
    const additive = source.cardValues !== 'none';
    const seatRows = source.rows.filter((r) => r.group !== 'joint');
    const jointRows = source.rows.filter((r) => r.group === 'joint');
    const steps: ScoreStep[] = [];
    let last: ScoreStep | null = null;
    let lastWeights: string | null = null;
    let unsplit = 0;
    game.steps.forEach((g, i) => {
        const state = g.state;
        const round = state.round;
        const blank: ScoreStep = {
            i, n: g.n, round, status: 'missing', edge: null, p1Win: null, p1WinFrom: null, stepP1Win: null, seats: null, joint: {}, other: null,
            weights: null, weightSet: null, weightsChanged: false, edgePrevWeights: null, proven: null, search: null
        };
        if (source.error) {
            steps.push(blank);
            return;
        }
        if (source.origin === 'estimate') {
            const w = source.weights ?? OMNI_V1_WEIGHTS;
            const e = estimateOmniV1(state, w, opts.cardCost);
            const seats = { p1: seatScore(source, e.p1, state.players.p1, w), p2: seatScore(source, e.p2, state.players.p2, w) };
            for (const s of SEATS) {
                const p = state.players[s];
                const from = (u: PlayerSnap['ground'][number]): CostFrom => (opts.cardCost?.(u) != null ? 'card' : 'none');
                seats[s] = { ...seats[s], partsFrom: 'computed', ...withCostFrom({ ground: p.ground.map(from), space: p.space.map(from) }) };
            }
            const c = chanceOf(source, {}, e.edge, round);
            steps.push({ ...blank, status: 'estimate', edge: e.edge, p1Win: c.p, p1WinFrom: c.from, seats, weights: w });
            return;
        }
        const st = byN.get(g.n);
        if (!st) {
            if (source.sampling !== 'every-step' && last && (last.status === 'file' || last.status === 'held')) {
                const from = last.status === 'held' ? last.heldFrom! : last.i;
                // a held value keeps its chance and edge; card values only while the board still has the cards they scored
                const sampled = steps[from];
                const at = game.steps[from].state.players;
                const fit = !!sampled.seats && SEATS.every((x) => sameCards(at[x], state.players[x]));
                const held: ScoreStep = {
                    ...blank, status: 'held', heldFrom: from, heldFromN: game.steps[from].n, edge: last.edge, p1Win: last.p1Win, p1WinFrom: last.p1WinFrom, stepP1Win: last.stepP1Win,
                    seats: fit ? sampled.seats : null, joint: last.joint, other: fit ? sampled.other : null, weights: last.weights, weightSet: last.weightSet
                };
                steps.push(held);
                last = held;
            } else {
                steps.push(blank);
            }
            return;
        }
        const edge = isNum(st.edge) ? st.edge : null;
        const w: Weights | null = isObj(st.weights) ? st.weights
            : typeof st.weightSet === 'string' && source.weightSets[st.weightSet] ? source.weightSets[st.weightSet].weights : source.weights;
        const wk = weightsKey(w);
        const weightsChanged = lastWeights != null && wk !== lastWeights;
        lastWeights = wk;
        const c = chanceOf(source, st, edge, round);
        const common = {
            edge, p1Win: c.p, p1WinFrom: c.from, stepP1Win: isChance(st.p1Win) ? st.p1Win : null, joint: isObj(st.joint) ? Object.fromEntries(Object.entries(st.joint).filter(([, v]) => isNum(v))) as Record<string, number> : {},
            weights: w, weightSet: typeof st.weightSet === 'string' ? st.weightSet : null, weightsChanged,
            edgePrevWeights: isNum(st.edgePrevWeights) ? st.edgePrevWeights : null,
            proven: st.proven === 'p1' || st.proven === 'p2' ? { seat: st.proven, ...(isNum(st.provenIn) ? { inWindows: st.provenIn } : {}), ...(typeof st.provenBy === 'string' ? { by: st.provenBy } : {}) } : null,
            search: isObj(st.search) && (st.search.by === 'p1' || st.search.by === 'p2') && isNum(st.search.value) ? normSearch(st.search, source.unit) : null
        };
        let seats: ScoreStep['seats'] = null;
        let status: ScoreStep['status'] = 'file';
        if (additive) {
            const ok = isObj(st.p1) && isObj(st.p2) && zonesFit(st.p1, state.players.p1) && zonesFit(st.p2, state.players.p2);
            if (!ok) {
                status = 'mismatch';
            } else {
                seats = { p1: seatScore(source, st.p1!, state.players.p1, w, opts.cardCost), p2: seatScore(source, st.p2!, state.players.p2, w, opts.cardCost) };
            }
        }
        if (status === 'mismatch') {
            // a gap: the file's numbers belong to another board
            steps.push({ ...blank, status, weights: w, weightSet: common.weightSet, weightsChanged });
            last = steps[steps.length - 1];
            return;
        }
        let other: ScoreStep['other'] = null;
        if (seats && edge != null) {
            const rowSum = (s: Seat) => sum(seatRows.map((r) => seats![s].rows[r.id] ?? 0));
            const jointSum = sum(jointRows.map((r) => common.joint[r.key] ?? 0));
            const gap = (s: Seat) => (seats![s].total == null ? null : seats![s].total! - rowSum(s));
            const o = { p1: gap('p1'), p2: gap('p2'), edge: edge - (rowSum('p1') - rowSum('p2')) - jointSum };
            // each invariant against the tolerance: I1 per seat, and I2 (edge = p1.total − p2.total + Σjoint) while both
            // totals are given; with a total missing (ablation), the edge against the rows
            const t1 = seats.p1.total;
            const t2 = seats.p2.total;
            const edgeOff = t1 != null && t2 != null ? edge - (t1 - t2) - jointSum : o.edge;
            if (Math.abs(edgeOff) > tol || Math.abs(o.p1 ?? 0) > tol || Math.abs(o.p2 ?? 0) > tol) {
                other = o;
                unsplit++;
            }
        }
        const step: ScoreStep = { ...blank, ...common, status, seats, other };
        steps.push(step);
        last = step;
    });
    if (source.origin === 'estimate') {
        // once per game, so a step with no units (setup) doesn't say cost was left out while card data is loaded
        const units = steps.flatMap((st) => SEATS.flatMap((x) => [...st.seats?.[x].unitCostFrom?.ground ?? [], ...st.seats?.[x].unitCostFrom?.space ?? []]));
        const cost = units.includes('card') || (opts.cardCost != null && !units.length) ? 'card' : 'none';
        steps.forEach((st) => (st.estimateCost = cost));
    }
    const coverage = { file: 0, estimate: 0, held: 0, missing: 0, mismatch: 0 };
    for (const s of steps) {
        coverage[s.status]++;
    }
    return { source, steps, scales: displayScales(source.kEff, source.unit), coverage, unsplit };
}

/** Whether the game's estimate took card cost from card data or left it out (else, any unit on either side at this step). */
export const estimateCostFrom = (step: Pick<ScoreStep, 'seats' | 'estimateCost'>): 'card' | 'none' => step.estimateCost ?? (SEATS.some((s) => step.seats?.[s].costFrom === 'card') ? 'card' : 'none');

/** The term keys a step's values leave out, for its rule texts: the cost term of an estimate made without card data. */
export const leftOutTerms = (step: Pick<ScoreStep, 'seats' | 'status' | 'estimateCost'>): string[] => (step.status === 'estimate' && estimateCostFrom(step) === 'none' ? ['cost'] : []);

/** The rows a step shows, Other (not split) included when the rows don't add up. */
export const rowsAt = (source: ScoreSource, step: ScoreStep) => (step.other ? [...source.rows, OTHER_ROW] : source.rows);

/** A row's value for each seat and toward p1 (joint rows and Other have only the edge column). */
export function rowValue(row: RowDef, step: ScoreStep): { p1: number | null; p2: number | null; edge: number } {
    if (row.id === 'other') {
        return { p1: step.other?.p1 ?? null, p2: step.other?.p2 ?? null, edge: step.other?.edge ?? 0 };
    }
    if (row.group === 'joint') {
        return { p1: null, p2: null, edge: step.joint[row.key] ?? 0 };
    }
    const a = step.seats?.p1.rows[row.id] ?? 0;
    const b = step.seats?.p2.rows[row.id] ?? 0;
    return { p1: a, p2: b, edge: a - b };
}

/** The transient rows' share of the edge at a step (initiative for Omni v1): what quiet moves flip without changing the board. */
export function transientEdge(series: ScoreSeries, i: number): number {
    const st = series.steps[i];
    if (!st?.seats) {
        return 0;
    }
    return sum(series.source.rows.filter((r) => r.transient).map((r) => rowValue(r, st).edge));
}

/**
 * P(p1 wins) at step i for swings: the step's chance for a fitted or model source, the map for a rough one, or a
 * stand-in logistic(kEff·edge) for a source with none (a step's own p1Win is left out of the last two). `quiet` leaves the transient rows out (through the map, or through kEff for a step's own p1Win);
 * `edge` replaces the step's edge (edgePrevWeights). Null at a gap.
 */
export function swingChance(series: ScoreSeries, i: number, opts: { quiet?: boolean; edge?: number } = {}): number | null {
    const st = series.steps[i];
    const src = series.source;
    if (!st || st.status === 'missing' || st.status === 'mismatch') {
        return null;
    }
    const t = opts.quiet ? transientEdge(series, i) : 0;
    // a step's own p1Win only for a calibrated source: a rough or uncalibrated one keeps one scale (map or stand-in) on
    // every step, so a file with p1Win on some steps never mixes two chances in one swing
    const calibrated = src.chance === 'fitted' || src.chance === 'model';
    if (calibrated && st.p1WinFrom === 'step' && st.p1Win != null && opts.edge == null) {
        return t ? sigmoid(logit(st.p1Win) - src.kEff * t) : st.p1Win;
    }
    // with both totals, the edge as p1.total − p2.total + Σjoint (I2) while that agrees with the file's edge within its
    // rounding: what the viewer always measured swings with, so near-ties between mirrored plays rank the same as before.
    // When the file breaks I2 the swing follows the file's edge, the one the chance on screen is drawn from.
    const totals = st.seats && st.seats.p1.total != null && st.seats.p2.total != null
        ? st.seats.p1.total - st.seats.p2.total + sum(src.rows.filter((r) => r.group === 'joint').map((r) => st.joint[r.key] ?? 0)) : null;
    const agrees = totals != null && (st.edge == null || Math.abs(totals - st.edge) <= sumTolerance(src.unit));
    const e = opts.edge ?? (agrees ? totals : st.edge);
    if (e == null) {
        return null;
    }
    if (src.map) {
        return winProb(src.map, e - t, st.round);
    }
    return src.unit === 'logit' ? sigmoid(e - t) : sigmoid(src.kEff * (e - t));
}

/** A label for a few facts of the board behind a fixed row ("3 units", "12 HP"); unknown rows have none. */
export function rowFacts(row: RowDef, s: Snapshot): Record<Seat, string> | null {
    const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
    const per = (f: (p: PlayerSnap, seat: Seat) => string) => ({ p1: f(s.players.p1, 'p1'), p2: f(s.players.p2, 'p2') });
    switch (row.id) {
        case 'base': return per((p) => `${Math.max(0, p.base.hp - p.base.d)} HP`);
        case 'ground': return per((p) => count(p.ground.length, 'unit'));
        case 'space': return per((p) => count(p.space.length, 'unit'));
        case 'side.hand': return per((p) => count(p.hand.length, 'card'));
        case 'side.resources': return per((p) => count(p.res.total, 'resource'));
        case 'side.initiative': return per((_, seat) => (s.initiative === seat ? 'has it' : 'no'));
        case 'extra.deck': return per((p) => count(p.deck, 'card'));
        case 'extra.discard': return per((p) => count(p.discard.length, 'card'));
        default: return null;
    }
}

/** A card's parts as labelled rows, labels from the terms (keys a term doesn't name keep their key). */
export function partRows(terms: TermDef[], parts: Record<string, number> | null, costFrom?: CostFrom): { key: string; label: string; points: number }[] {
    if (!parts) {
        return [];
    }
    const known = terms.map((t) => t.key).filter((k) => k in parts);
    const rest = Object.keys(parts).filter((k) => !known.includes(k));
    return [...known, ...rest].map((k) => {
        const t = terms.find((x) => x.key === k);
        const name = t?.label ?? k;
        return { key: k, label: k === 'cost' && costFrom === 'rest' ? `${name} (the rest)` : name, points: parts[k] };
    });
}

/** A one-board game around a snapshot (at Step.n `n`), for drawing a single position with a score. */
function boardGame(state: Snapshot, n = 0): Game {
    return { header: { t: 'header', v: 1, seed: 0, engine: null, players: [] }, steps: [{ t: 'step', n, state }], end: null };
}

/** A bare lens step's evaluator: nothing is known of it, so six rows, no rules and no chance. */
const UNKNOWN_STEP_EVALUATOR = { id: 'unknown', label: 'lens step (evaluator unknown)' };

/** One step of a whole lens file: the file's evaluator, weights and chance apply, and its step with this Step.n is drawn. */
export interface FileStep {
    file: unknown;
    n: number;
}

const isFileStep = (v: LensStep | FileStep): v is FileStep => 'file' in v && isNum(v.n);

/**
 * The score of one position: `true` for the Omni v1 estimate, `{file, n}` for the step n of a lens file (with the
 * file's evaluator, rules and chance), or one bare lens step. A bare step is labelled "lens step (evaluator unknown)"
 * with no rules and no chance; `bareAs: 'omni-v1'` reads it as an omni-linear-v1 step with the built-in weights
 * instead, as earlier builds did (for the deprecated wrappers). `cardCost` as for resolveScore.
 */
export function scoreOfBoard(state: Snapshot, lens: true | LensStep | FileStep, opts: { bareAs?: 'unknown' | 'omni-v1'; cardCost?: (c: CardRef) => number | null | undefined } = {}): ScoreView | null {
    const fromFile = lens !== true && isFileStep(lens);
    const game = boardGame(state, fromFile ? lens.n : 0);
    const omni = opts.bareAs === 'omni-v1';
    const sources = lens === true ? [estimateSource(game)]
        : fromFile ? sourcesFor(game, [{ dir: '', file: lens.file }])
        : sourcesFor(game, [{
            dir: '',
            file: { schema: 'swu-lens/1', evaluator: omni ? { id: OMNI_V1_ID } : UNKNOWN_STEP_EVALUATOR, ...(omni ? { weights: OMNI_V1_WEIGHTS } : {}), steps: [{ ...lens, n: 0 }] }
        }]);
    const source = sources[0];
    if (!source) {
        return null;
    }
    return { source, step: resolveScore(game, source, { cardCost: opts.cardCost }).steps[0] };
}

/** what logScoreNotes already printed, per source: its warnings, and the number of steps that don't add up */
const logged = new WeakMap<ScoreSource, number>();

/**
 * Prints a source's readLens warnings, and how many steps don't add up (I1 / I2; the Other row is shown there), once
 * per source and count, for whoever writes the file.
 */
export function logScoreNotes(series: ScoreSeries | null) {
    if (!series) {
        return;
    }
    const { source, unsplit } = series;
    const seen = logged.get(source);
    if (seen === undefined && (source.warnings.length || source.error)) {
        console.warn(`${source.label} (lens file${source.key ? ` ${source.key}/` : ''}): ${[source.error, ...source.warnings].filter(Boolean).join('; ')}`);
    }
    if (unsplit > 0 && seen !== unsplit) {
        console.warn(`${source.label}: ${unsplit} step${unsplit === 1 ? '' : 's'} don't add up (Other row shown)`);
    }
    logged.set(source, unsplit);
}

/**
 * The game's sources, the chosen one and its series, resolved once. `files` and `registry` should keep their identity
 * between renders (useMemo), or the series is resolved again.
 */
export function useScores(game: Game, files: LensInput[], registry: LensIndex | null = null,
    opts: { requested?: string | null; saved?: string | null; estimate?: boolean; cardCost?: (c: CardRef) => number | null | undefined } = {}) {
    const { requested, saved, estimate, cardCost } = opts;
    const sources = useMemo(() => sourcesFor(game, files, registry, { estimate }), [game, files, registry, estimate]);
    const [picked, setScore] = useState<string | null>(null);
    const source = useMemo(() => (picked != null ? sources.find((s) => s.key === picked) : undefined)
        ?? chooseDefault(sources, { requested, saved, registryDefault: registry?.default ?? null }), [sources, picked, requested, saved, registry]);
    const series = useMemo(() => (source ? resolveScore(game, source, { cardCost }) : null), [game, source, cardCost]);
    useEffect(() => logScoreNotes(series), [series]);
    return { sources, source, series, setScore };
}
