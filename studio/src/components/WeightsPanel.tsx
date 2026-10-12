import { useMemo } from 'react';
import { sig3 } from '../data/terms';
import type { Weights } from '../data/lensFile';
import type { ScoreSeries, ScoreStep } from '../data/score';

/** Props of the Weights tab: the chosen score over the game, and the step shown (the playhead or the hovered step). */
export interface WeightsPanelProps {
    series: ScoreSeries;
    step: ScoreStep;
}

/** One column of the table: a weight set, the file's default weights, or the step's own weights. */
interface Col {
    key: string;
    label: string;
    title: string;
    w: Weights;
}

/** Weight keys under the rows that read them, with the rows' colours. */
interface Group {
    label: string;
    colors: string[];
    keys: string[];
}

const sameWeights = (a: Weights | null, b: Weights | null) => {
    if (a === b) {
        return true;
    }
    if (!a || !b) {
        return false;
    }
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

/** a weight with 4 significant digits: 1.495, 0.2875, 12 */
const sig4 = (v: number) => String(Number(v.toPrecision(4))).replace(/^-/, '−');

/** "+0.15" / "−0.2": a change between two columns, 3 significant digits */
const delta = (d: number) => `${d >= 0 ? '+' : '−'}${sig3(Math.abs(d))}`;

/** "steps 37-84" for the steps a set is in force at */
function spanText(steps: ScoreStep[], set: string): string {
    const ns = steps.filter((s) => s.weightSet === set).map((s) => s.n);
    return ns.length ? `steps ${ns[0]}-${ns[ns.length - 1]}` : 'not used in this game';
}

/** The weight keys a unit note template reads: the note is filled through a probe that records each key asked for. */
function noteKeys(note: (w: Weights | null) => string): string[] {
    const seen: string[] = [];
    note(new Proxy({}, {
        get: (_, k) => {
            if (typeof k === 'string' && !seen.includes(k)) {
                seen.push(k);
            }
            return 1;
        }
    }));
    return seen;
}

/** "1.8 to 2.4": the lowest and highest value of a weight over the game */
function rangeOf(steps: ScoreStep[], k: string): string {
    const vs = steps.map((s) => s.weights?.[k]).filter((v): v is number => Number.isFinite(v));
    return `${sig4(Math.min(...vs))} to ${sig4(Math.max(...vs))}`;
}

/** A tiny line of one weight over the game, with a dot at the step shown. */
function Spark({ steps, k, at, color }: { steps: ScoreStep[]; k: string; at: number; color: string }) {
    const W = 56, H = 14;
    const pts = steps.map((s, i) => [i, s.weights?.[k]] as const).filter((p): p is readonly [number, number] => Number.isFinite(p[1]));
    if (pts.length < 2) {
        return null;
    }
    const vs = pts.map((p) => p[1]);
    const lo = Math.min(...vs), hi = Math.max(...vs);
    const x = (i: number) => (i / Math.max(1, steps.length - 1)) * (W - 2) + 1;
    const y = (v: number) => (hi === lo ? H / 2 : H - 2 - ((v - lo) / (hi - lo)) * (H - 4));
    const cur = steps[at]?.weights?.[k];
    return (
        <svg width={W} height={H} className="block" aria-hidden>
            <polyline points={pts.map(([i, v]) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} fill="none" stroke={color} strokeWidth={1.25} strokeOpacity={0.8} />
            {Number.isFinite(cur) && <circle cx={x(at)} cy={y(cur as number)} r={2} fill={color} />}
        </svg>
    );
}

/**
 * The weights the chosen score uses (read only): weight keys grouped by the row that reads them, one column per weight
 * set (or the file's single set, "constant"), plus "this step" when the file gives weights per step. The column in force
 * at the step shown is highlighted; each cell shows its change from the column before it.
 */
export function WeightsPanel({ series, step }: WeightsPanelProps) {
    const { source, steps } = series;

    const model = useMemo(() => {
        const sets = Object.entries(source.weightSets);
        // steps that carry their own weights (not a set, not the file's default)
        const inline = steps.some((s) => s.weights && !s.weightSet && !sameWeights(s.weights, source.weights));
        const usesDefault = steps.some((s) => s.weights && !s.weightSet && sameWeights(s.weights, source.weights));
        const cols: Col[] = [];
        if (source.weights && !sets.some(([, s]) => sameWeights(s.weights, source.weights)) && (usesDefault || inline || !sets.length)) {
            const only = !sets.length && !inline;
            cols.push({
                key: '', label: only ? (source.constantWeights ? 'constant' : 'this game') : 'default',
                title: only ? 'The same weights at every step' : 'The file\'s weights, used where a step names no set or weights of its own', w: source.weights
            });
        }
        for (const [k, s] of sets) {
            cols.push({ key: k, label: s.label, title: `${s.label}: ${spanText(steps, k)}`, w: s.weights });
        }
        // every key any column (or step) has, in first-seen order
        const all: string[] = [];
        const add = (w: Weights | null) => Object.keys(w ?? {}).forEach((k) => all.includes(k) || all.push(k));
        cols.forEach((c) => add(c.w));
        if (inline) {
            steps.forEach((s) => add(s.weights));
        }
        // keys per row; the two unit rows read the same terms, so they share one group
        const groups: Group[] = [];
        let units: Group | null = null;
        const placed = new Set<string>();
        const unitNote = noteKeys(source.unitNote);
        for (const r of source.rows) {
            const keys = [...r.uses, ...(r.group === 'unit' ? unitNote : [])].filter((k, i, a) => a.indexOf(k) === i && all.includes(k));
            if (r.group === 'unit' && units) {
                units.colors.push(r.color);
                continue;
            }
            const mine = keys.filter((k) => !placed.has(k));
            mine.forEach((k) => placed.add(k));
            if (mine.length) {
                const g = { label: r.group === 'unit' ? 'Units' : r.label, colors: [r.color], keys: mine };
                groups.push(g);
                units = r.group === 'unit' ? g : units;
            }
        }
        const rest = all.filter((k) => !placed.has(k));
        if (rest.length) {
            groups.push({ label: groups.length ? 'Other weights' : 'Weights', colors: [], keys: rest });
        }
        // which rows read a key (tooltip)
        const usedBy = (k: string) => source.rows.filter((r) => r.uses.includes(k) || (r.group === 'unit' && unitNote.includes(k))).map((r) => r.label);
        // keys that change over the game, for the sparklines (per-step weights only)
        const first = steps.find((s) => s.weights)?.weights;
        const moving = new Set(inline && first ? all.filter((k) => steps.some((s) => s.weights && s.weights[k] !== first[k])) : []);
        return { cols, inline, groups, usedBy, moving };
    }, [source, steps]);

    const { groups, usedBy, moving, inline } = model;
    if (!model.cols.length && !inline) {
        return <span className="text-dim text-[13px]">No weights: a learned model.</span>;
    }

    // the column in force at this step: the step's set, else a column with the same weights, else "this step"
    let at = step.weightSet ? model.cols.findIndex((c) => c.key === step.weightSet) : -1;
    if (at < 0) {
        at = model.cols.findIndex((c) => sameWeights(c.w, step.weights));
    }
    const cols = [...model.cols];
    if (inline) {
        cols.push({ key: '#step', label: 'this step', title: `The file's weights at step ${step.n}`, w: step.weights ?? {} });
        if (at < 0) {
            at = cols.length - 1;
        }
    }
    const atLabel = at >= 0 ? cols[at].label : null;
    const varies = cols.length > 1;

    const caption = !varies
        ? 'The same weights at every step.'
        : inline
            ? `The file gives weights at every step; "this step" shows those at step ${step.n}${atLabel && atLabel !== 'this step' ? ` (the same as "${atLabel}")` : ''}.`
            : `The weights switch by set during the game; ${atLabel ? `"${atLabel}" is in force at step ${step.n}` : `step ${step.n} uses none of these`}.`;

    const hi = (j: number) => j === at && varies;
    const bg = (j: number) => (hi(j) ? 'bg-raise' : '');
    return (
        <div className="flex flex-col gap-1.5 text-[12px] min-w-0">
            <span className="eyebrow">Weights · {source.label}</span>
            <span className="text-dim text-[11.5px]">{caption}</span>
            <div className="overflow-x-auto">
                <table className="border-separate border-spacing-0 leading-[1.35]">
                    <thead>
                        <tr>
                            <th className="text-left font-normal text-faint pr-3 pb-1">weight</th>
                            {cols.map((c, j) => (
                                <th key={c.key} colSpan={2} title={c.title} aria-current={hi(j) ? 'true' : undefined}
                                    className={`font-normal text-left pl-2 pr-1 pb-1 pt-0.5 rounded-t-md whitespace-nowrap max-w-[112px] truncate ${hi(j) ? 'text-fg bg-raise' : 'text-faint'}`}>
                                    {c.label}
                                </th>
                            ))}
                            {moving.size > 0 && <th className="font-normal text-faint text-left pl-3 pb-1 whitespace-nowrap">over the game</th>}
                        </tr>
                    </thead>
                    <tbody>
                        {groups.map((g) => [
                            <tr key={`g:${g.label}`}>
                                <td className="pt-1.5 pr-3 whitespace-nowrap">
                                    <span className="inline-flex items-center gap-1.5 text-dim text-[11px]">
                                        {g.colors.map((c) => <span key={c} className="size-2 rounded-full shrink-0" style={{ background: c }} />)}
                                        {g.label}
                                    </span>
                                </td>
                                {cols.map((c, j) => <td key={c.key} colSpan={2} className={bg(j)} />)}
                                {moving.size > 0 && <td />}
                            </tr>,
                            ...g.keys.map((k) => {
                                const by = usedBy(k);
                                return (
                                    <tr key={`${g.label}:${k}`}>
                                        <td className="text-dim pl-3.5 pr-3 truncate max-w-[150px]" title={by.length ? `${k}: read by ${by.join(', ')}` : k}>{k}</td>
                                        {cols.map((c, j) => {
                                            const v = c.w[k];
                                            const p = j > 0 ? cols[j - 1].w[k] : undefined;
                                            const d = Number.isFinite(v) && Number.isFinite(p) ? Number(((v as number) - (p as number)).toPrecision(12)) : 0;
                                            return [
                                                <td key={c.key} className={`num text-right pl-2 ${bg(j)} ${hi(j) ? 'text-fg' : 'text-dim'}`}>
                                                    {Number.isFinite(v) ? sig4(v) : '–'}
                                                </td>,
                                                <td key={`${c.key}:d`} className={`num text-left text-[10px] text-dim pl-1 pr-2 min-w-[5ch] ${bg(j)}`}
                                                    title={d ? `${delta(d)} from ${cols[j - 1].label}` : undefined}>
                                                    {d ? delta(d) : ''}
                                                </td>
                                            ];
                                        })}
                                        {moving.size > 0 && (
                                            <td className="pl-3 align-middle">
                                                {moving.has(k) && (
                                                    <span className="inline-flex items-center gap-1.5">
                                                        <Spark steps={steps} k={k} at={step.i} color={g.colors[0] ?? 'var(--color-dim)'} />
                                                        <span className="num text-[10px] text-faint whitespace-nowrap">{rangeOf(steps, k)}</span>
                                                    </span>
                                                )}
                                            </td>
                                        )}
                                    </tr>
                                );
                            })
                        ])}
                        <tr>
                            <td />
                            {cols.map((c, j) => <td key={c.key} colSpan={2} className={`h-1.5 rounded-b-md ${bg(j)}`} />)}
                        </tr>
                    </tbody>
                </table>
            </div>
                    </div>
    );
}
