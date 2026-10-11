import type { CardRef, PlayerSnap, Snapshot, UnitRef } from './types';
import type { LensEvaluator, LensSide, LensStep, Weights, WinMap } from './lensFile';

/**
 * Omni v1 (`omni-linear-v1`): the hand-set linear board score the omni bot uses at its search leaves
 * (bot/omni/evaluate.js, the heuristic bot's weights with the low-base-HP penalty subtracted). This file is the only
 * place its numbers live. The viewer uses them in three cases only: to fill the fields an omni-linear-v1 lens file
 * leaves out, to read pre-08:40 omni files (no evaluator block), and to estimate the score of a game that has no lens
 * file at all. It never mixes them into another evaluator's numbers.
 */
export const OMNI_V1_ID = 'omni-linear-v1';
export const OMNI_V1_LABEL = 'Omni v1';
export const OMNI_V1_LEGACY_LABEL = 'Omni v1 (old file)';

/** The weights of the 08:44 files (dangerHp and danger came later; older files leave them out). */
export const OMNI_V1_WEIGHTS: Weights = {
    power: 1.3, hp: 0.9, cost: 0.25, shield: 2.2, upgrade: 0.6, sentinel: 1, exhaustedMult: 0.85,
    hand: 1.8, resource: 1.4, initiative: 2.5, baseHp: 0.9, baseMult: 1.5, dangerHp: 12, danger: 1 / 6
};

/** A pre-08:40 file with these weight keys (and source bot/omni/lens.js) is an old omni file. */
export const LEGACY_WEIGHT_KEYS = ['power', 'hp', 'cost', 'shield', 'upgrade', 'sentinel', 'exhaustedMult', 'hand', 'resource', 'initiative', 'baseHp', 'baseMult'];

/** A lead of this many points reads as "clearly ahead" (log-odds 2, about 7 wins in 8). */
export const OMNI_V1_TYPICAL = 25;

/**
 * The rough chance map: a hand-set guess, never fitted. It is exactly the viewer's old (1 + tanh(edge / 25)) / 2,
 * because tanh(x) = 2·sigmoid(2x) − 1, so k = 2 / 25 = 0.08.
 */
export const OMNI_V1_ROUGH_MAP: WinMap = { kind: 'logistic', k: 0.08, b: 0, fitted: false };

/** The built-in descriptor: the 08:44 evaluator block with the rule templates (lens proposal, example a2). */
export const OMNI_V1_EVALUATOR: LensEvaluator = {
    id: OMNI_V1_ID,
    label: OMNI_V1_LABEL,
    source: 'bot/omni/evaluate.js',
    description: 'Hand-set linear score from the original heuristic bot, with the low-base-HP penalty subtracted. Not fitted to data yet.',
    sees: 'public',
    constantWeights: true,
    scale: { unit: 'points', typical: OMNI_V1_TYPICAL, toWinProb: OMNI_V1_ROUGH_MAP },
    terms: {
        unit: [
            { key: 'power', label: 'Power', rule: 'power x 1.3', ruleTpl: 'power x {power}' },
            { key: 'hp', label: 'HP left', rule: 'remaining HP x 0.9', ruleTpl: 'remaining HP x {hp}' },
            { key: 'cost', label: 'Cost', rule: 'printed cost x 0.25', ruleTpl: 'printed cost x {cost}' },
            { key: 'upgrades', label: 'Upgrades', rule: '2.2 per Shield, 0.6 per other upgrade', ruleTpl: '{shield} per Shield, {upgrade} per other upgrade' },
            { key: 'sentinel', label: 'Sentinel', rule: '+1', ruleTpl: '+{sentinel}' }
        ],
        unitNote: 'every unit part is multiplied by 0.85 when the unit is exhausted',
        unitNoteTpl: 'every unit part is multiplied by {exhaustedMult} when the unit is exhausted',
        base: [
            { key: 'hp', label: 'Base HP', rule: 'HP left x 0.9 x 1.5', ruleTpl: 'HP left x {baseHp} x {baseMult}' },
            { key: 'danger', label: 'Danger', rule: '-(12 - HP left)^2 / 6 x 1.5 under 12 HP', ruleTpl: '-({dangerHp} - HP left)^2 x {danger} x {baseMult} under {dangerHp} HP' }
        ],
        side: [
            { key: 'hand', label: 'Hand', rule: '1.8 per card', ruleTpl: '{hand} per card' },
            { key: 'resources', label: 'Resources', rule: '1.4 per resource', ruleTpl: '{resource} per resource' },
            { key: 'initiative', label: 'Initiative', rule: '2.5 for the side holding it', ruleTpl: '{initiative} for the side holding it', transient: true }
        ]
    }
};

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const r2 = (v: number) => Math.round(v * 100) / 100;
const wt = (w: Weights, k: string) => w[k] ?? OMNI_V1_WEIGHTS[k] ?? 0;
export const isShield = (u: { n: string }) => u.n === 'Shield';

/** How the cost part of a computed unit split was found. */
export type CostFrom = 'card' | 'rest' | 'none';

/**
 * One unit's parts as Omni v1 scores it (keys as the lens file's parts: power, hp, cost, upgrades, sentinel), each
 * already multiplied by exhaustedMult when the unit is exhausted. Cost: the printed cost when `cost` is known (card
 * data), else what is left of `value` (the file's number for the unit) after the other parts, else left out of `parts`.
 * `value` is the unit's worth as the writer computes it: the raw parts summed first, then multiplied by exhaustedMult
 * once, so it rounds the same as bot/omni/evaluate.js (the scaled parts are for display only).
 */
export function splitUnit(u: UnitRef, w: Weights, opts: { value?: number | null; cost?: number | null } = {}): { parts: Record<string, number>; value: number; costFrom: CostFrom } {
    const hp = Math.max(0, u.h - u.d);
    const shields = (u.u ?? []).filter(isShield).length;
    const ups = (u.u ?? []).length - shields;
    const raw: Record<string, number> = {
        power: u.p * wt(w, 'power'),
        hp: hp * wt(w, 'hp'),
        cost: 0,
        upgrades: shields * wt(w, 'shield') + ups * wt(w, 'upgrade'),
        sentinel: u.sn ? wt(w, 'sentinel') : 0
    };
    const mult = u.x ? wt(w, 'exhaustedMult') : 1;
    let costFrom: CostFrom = 'none';
    if (opts.cost != null) {
        raw.cost = opts.cost * wt(w, 'cost');
        costFrom = 'card';
    } else if (opts.value != null && mult !== 0) {
        raw.cost = opts.value / mult - sum(Object.values(raw));
        costFrom = 'rest';
    }
    // the sum in the order the old viewer and the writer add it: power, HP, cost, one upgrade at a time, Sentinel
    let v = raw.power + raw.hp + raw.cost;
    for (const up of u.u ?? []) {
        v += isShield(up) ? wt(w, 'shield') : wt(w, 'upgrade');
    }
    v += raw.sentinel;
    // with no cost known the part is left out, not shown as 0
    const parts = Object.entries(raw).filter(([k]) => k !== 'cost' || costFrom !== 'none').map(([k, x]) => [k, x * mult]);
    return { parts: Object.fromEntries(parts), value: u.x ? v * mult : v, costFrom };
}

/** The base's parts: HP left (it falls faster near 0 HP through the danger part, under dangerHp HP). */
export function splitBase(hpLeft: number, w: Weights): Record<string, number> {
    const hp = Math.max(0, hpLeft);
    const mult = wt(w, 'baseMult');
    const dangerHp = wt(w, 'dangerHp');
    return { hp: mult * hp * wt(w, 'baseHp'), danger: hp <= dangerHp ? -mult * (dangerHp - hp) ** 2 * wt(w, 'danger') : 0 };
}

/** The base's worth as the writer computes it: baseMult × (HP part − danger part), multiplied once. */
export function baseValue(hpLeft: number, w: Weights): number {
    const hp = Math.max(0, hpLeft);
    const dangerHp = wt(w, 'dangerHp');
    return wt(w, 'baseMult') * (hp * wt(w, 'baseHp') - (hp <= dangerHp ? (dangerHp - hp) ** 2 * wt(w, 'danger') : 0));
}

function estimateSide(p: PlayerSnap, initiative: boolean, w: Weights, costOf?: (c: CardRef) => number | null | undefined): LensSide {
    const unit = (u: UnitRef) => splitUnit(u, w, { cost: costOf?.(u) ?? null });
    const groundSplit = p.ground.map(unit);
    const spaceSplit = p.space.map(unit);
    const ground = groundSplit.map((x) => r2(x.value));
    const space = spaceSplit.map((x) => r2(x.value));
    const hand = p.hand.map(() => wt(w, 'hand'));
    const baseParts = splitBase(p.base.hp - p.base.d, w);
    const base = r2(baseValue(p.base.hp - p.base.d, w));
    const resources = r2(p.res.total * wt(w, 'resource'));
    const init = initiative ? wt(w, 'initiative') : 0;
    const round = (x: Record<string, number>) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, r2(v)]));
    return {
        base, ground, space, hand, resources, initiative: init,
        total: r2(base + sum(ground) + sum(space) + sum(hand) + resources + init),
        parts: { base: round(baseParts), ground: groundSplit.map((x) => round(x.parts)), space: spaceSplit.map((x) => round(x.parts)) }
    };
}

/**
 * Omni v1 computed from a snapshot alone, for a game with no lens file. With `costOf` (printed costs from the card
 * data) it matches the lens writer; without it the cost part is left out, because replays don't record costs.
 */
export function estimateOmniV1(s: Snapshot, w: Weights = OMNI_V1_WEIGHTS, costOf?: (c: CardRef) => number | null | undefined): LensStep & { p1: LensSide; p2: LensSide } {
    const p1 = estimateSide(s.players.p1, s.initiative === 'p1', w, costOf);
    const p2 = estimateSide(s.players.p2, s.initiative === 'p2', w, costOf);
    return { n: -1, p1, p2, edge: r2((p1.total ?? 0) - (p2.total ?? 0)) };
}
