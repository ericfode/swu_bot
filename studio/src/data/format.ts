/**
 * Numbers in a score's unit, and the display scales every view shares. Scales are written in log-odds and converted
 * with the source's kEff (calibrate.kEffOf), so a bar or a glow means the same change of chance whatever the unit.
 */

/** decimals for a value in this unit: points 1, log-odds 2 */
export const digitsOf = (unit: string) => (unit === 'logit' ? 2 : unit === 'prob' ? 3 : 1);

/** A value in its unit: points (and other units) with 1 decimal, log-odds with 2, a chance with 3; "−7.2", never "−0.0". */
export function fmtValue(v: number, unit = 'points'): string {
    const s = Math.abs(v).toFixed(digitsOf(unit));
    return v < 0 && Number(s) !== 0 ? `−${s}` : s;
}

/** "+12.3" / "−0.42"; a value that rounds to zero prints "+0.0", never "−0.0" */
export function fmtSigned(v: number, unit = 'points'): string {
    const s = fmtValue(Math.abs(v), unit);
    return `${v < 0 && Number(s) !== 0 ? '−' : '+'}${s}`;
}

/** the unit in words */
export const unitText = (unit: string) => (unit === 'logit' ? 'log-odds' : unit === 'prob' ? 'chance' : unit);

/** 0.64 → "64%"; a chance short of certain never prints as one: 0.998 → ">99%", 0.003 → "<1%" */
export function pct(p: number): string {
    const r = Math.round(p * 100);
    return r >= 100 && p < 1 ? '>99%' : r <= 0 && p > 0 ? '<1%' : `${r}%`;
}

/** a change in percentage points: "+6 pp" / "−4 pp" */
export const ppText = (d: number) => `${d >= 0 ? '+' : '−'}${Math.abs(Math.round(d))} pp`;

/** A search regret at or above −tolerance counts as the pick (spec 5.8): 0.05 points, 0.01 log-odds, 0.005 for a chance. */
export const defaultTolerance = (unit: string) => (unit === 'logit' ? 0.01 : unit === 'prob' ? 0.005 : 0.05);

export interface DisplayScales {
    /** the edge one full half-bar of the breakdown stands for */
    halfBar: number;
    /** the edge the centre tug bar reaches its end at */
    tug: number;
    /** below this |edge| the board reads as even */
    lead: number;
    /** the smallest "largest unit value" a card's glow is measured against */
    heatFloor: number;
    /** the pick tolerance when a search gives none */
    tolerance: number;
}

/** 12 significant digits, so 1.2 / 0.08 gives 15 and not 14.999999999999998 */
const clean = (v: number) => Number(v.toPrecision(12));

/** The display scales for a source: in log-odds 1.2 (half-bar), 3.2 (tug), 0.04 (even) and 0.08 (heat floor), over kEff. */
export function displayScales(kEff: number, unit = 'points'): DisplayScales {
    return { halfBar: clean(1.2 / kEff), tug: clean(3.2 / kEff), lead: clean(0.04 / kEff), heatFloor: clean(0.08 / kEff), tolerance: defaultTolerance(unit) };
}
