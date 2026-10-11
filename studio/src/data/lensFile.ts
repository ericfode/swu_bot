import type { Seat } from './types';
import { LEGACY_WEIGHT_KEYS, OMNI_V1_EVALUATOR, OMNI_V1_ID, OMNI_V1_LEGACY_LABEL, OMNI_V1_WEIGHTS } from './omniV1';

/**
 * The lens contract (`swu-lens/1`, spec in /mnt/project-files/omni/LENS.md plus the optional fields of the viewer's
 * lens proposal): one evaluator's numbers for one game. dashboard/lens/<gameId>.json holds the default evaluator,
 * dashboard/lens/<dir>/<gameId>.json any other one, and dashboard/lens/evaluators.json lists the dirs. Every field added
 * after 08:44 is optional; readLens() fills what a file leaves out. Seat values are good for the card's owner; edge,
 * joint and p1Win are from p1's side.
 */

/** One part of the score as the producer names it. `ruleTpl` is the rule with {weightKey} slots, filled per step. */
export interface TermDef {
    key: string;
    label?: string;
    /** literal rule text, printed as is */
    rule?: string;
    ruleTpl?: string;
    /** weight keys this term reads; default: the slots in ruleTpl */
    uses?: string[];
    /** flips on quiet moves (pass, claim initiative, resource), so swings leave it out; default true for initiative only */
    transient?: boolean;
}

export interface LensTerms {
    unit?: TermDef[];
    unitNote?: string;
    unitNoteTpl?: string;
    base?: TermDef[];
    /** hand, resources and initiative read the seat fields of the same names; any other key is an extra term (seat.extra) */
    side?: TermDef[];
    /** terms of neither seat (step.joint), from p1's side */
    joint?: TermDef[];
}

/** One byRound entry of a chance map: the same kind as its parent, for rounds from..to. */
export interface WinMapRound {
    from: number;
    to: number;
    k?: number;
    b?: number;
    edge?: number[];
    p?: number[];
}

/** How a file's edge turns into P(p1 wins): a logistic 1 / (1 + e^−(k·edge + b)), or a table, linear between points. */
export type WinMap =
    | { kind: 'logistic'; k: number; b: number; byRound?: WinMapRound[]; fitted?: boolean }
    | { kind: 'table'; edge: number[]; p: number[]; byRound?: WinMapRound[]; fitted?: boolean };

/** How well a file's chance predicts results (shape of research/position-eval/brier.json). */
export interface Quality {
    data?: string;
    games?: number;
    n?: number;
    heldOut?: boolean;
    brier?: number;
    logloss?: number;
    acc?: number;
    byRound?: { from: number; to: number; n?: number; brier?: number; logloss?: number }[];
    calibration?: { n: number; p: number; y: number }[];
    proven?: { n: number; right: number; brier?: number };
}

export type Weights = Record<string, number>;
export type Sees = 'public' | 'seat' | 'omniscient' | 'hindsight';
export type CardValues = 'additive' | 'ablation' | 'none';
export type Sampling = 'every-step' | 'decisions' | 'checkpoints';

/** The evaluator block as a file writes it (every field but id may be missing). */
export interface LensEvaluator {
    id: string;
    label?: string;
    source?: string;
    description?: string;
    sees?: Sees;
    perspective?: Seat | null;
    cardValues?: CardValues;
    sampling?: Sampling;
    constantWeights?: boolean;
    scale?: { unit?: string; typical?: number; toWinProb?: WinMap | null };
    quality?: Quality | null;
    terms?: LensTerms;
}

export interface LensParts {
    base?: Record<string, number>;
    ground?: Record<string, number>[];
    space?: Record<string, number>[];
}

export interface LensSide {
    base: number;
    /** one value per card, same order as the snapshot's ground / space / hand */
    ground: number[];
    space: number[];
    hand: number[];
    resources: number;
    initiative: number;
    /** one number per extra side term */
    extra?: Record<string, number>;
    /** null only with cardValues "ablation" */
    total: number | null;
    parts?: LensParts;
}

/** A bot's search at a board it was about to act on: per card, the best move started by that card minus the move it played. */
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
    /** always "by": value and regrets are for the deciding seat */
    frame?: 'by';
    /** display label: "alpha-beta", "ismcts", "q-head", ... */
    kind?: string;
    /** default: scale.unit; "prob" means value is P(by wins) */
    unit?: string;
    /** a regret >= −tolerance counts as the pick */
    tolerance?: number;
    stats?: Record<string, number>;
}

export interface LensStep {
    /** Step.n of the replay step; values are for the board after that step's move */
    n: number;
    /** left out only with cardValues "none" */
    p1?: LensSide;
    p2?: LensSide;
    joint?: Record<string, number>;
    /** p1.total − p2.total + Σjoint, in scale.unit, from p1's side */
    edge: number;
    /** the evaluator's own P(p1 wins); wins over the chance map */
    p1Win?: number;
    weightSet?: string;
    weights?: Weights;
    /** this board's edge scored with the previous step's weights (only where the weights changed) */
    edgePrevWeights?: number;
    /** an exhaustive solver proved a win for this seat from this board */
    proven?: Seat;
    provenIn?: number;
    provenBy?: string;
    search?: LensSearch;
}

export interface LensFile {
    schema?: string;
    gameId?: string;
    seed?: number;
    players?: { id: Seat; bot: string }[];
    /** free text naming the program that wrote the file */
    source?: string;
    evaluator?: LensEvaluator;
    /** the weight set in force at step 0; null for a model with no weights */
    weights?: Weights | null;
    weightSets?: Record<string, { label?: string; weights: Weights }>;
    steps: LensStep[];
}

/** dashboard/lens/evaluators.json: the dirs that hold evaluators, and which one opens first ("" = the default path). */
export interface LensIndex {
    schema: string;
    default?: string;
    evaluators: { dir: string; id: string }[];
}

/** dashboard/lens/<dir>/index.json (optional): the evaluator block and the games that have a file. */
export interface LensDirIndex {
    schema: string;
    id: string;
    dir: string;
    evaluator?: LensEvaluator;
    games?: string[];
    updated?: string;
}

/** The evaluator with every field filled (spec section 6): what the rest of the viewer reads. */
export interface Evaluator {
    id: string;
    label: string;
    source: string;
    description: string;
    sees: Sees;
    perspective: Seat | null;
    cardValues: CardValues;
    sampling: Sampling;
    constantWeights: boolean;
    unit: string;
    /** scale.typical, or null (then calibrate.typicalOf takes it from the file's edges) */
    typical: number | null;
    toWinProb: WinMap | null;
    quality: Quality | null;
    terms: {
        unit: TermDef[];
        base: TermDef[];
        side: TermDef[];
        joint: TermDef[];
        unitNote: string | null;
        unitNoteTpl: string | null;
        /** the file names no terms: show the six fixed rows (base, ground, space, hand, resources, initiative) */
        sixRows: boolean;
    };
}

/** A lens file as read: the file itself (unchanged), its filled evaluator and the weights it starts with. */
export interface LensRead {
    file: LensFile;
    evaluator: Evaluator;
    weights: Weights | null;
    /** 'omni-v1': an omni-linear-v1 file, gaps filled from the built-in descriptor; 'legacy': a pre-08:40 omni file */
    builtIn: 'omni-v1' | 'legacy' | null;
    /** false when the file has no schema and is read as swu-lens/1 */
    schemaGiven: boolean;
    warnings: string[];
}

export type LensReadResult = LensRead | { error: string };

export const LENS_SCHEMA = /^swu-lens\/1(\.\d+)?$/;
const SEES: Sees[] = ['public', 'seat', 'omniscient', 'hindsight'];
const CARD_VALUES: CardValues[] = ['additive', 'ablation', 'none'];
const SAMPLING: Sampling[] = ['every-step', 'decisions', 'checkpoints'];
/** side keys that read the seat field of the same name */
export const FIXED_SIDE = ['hand', 'resources', 'initiative'];

type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNums = (v: unknown): v is number[] => Array.isArray(v) && v.every(isNum);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** A chance map if the value is a valid one, else null (with a warning when something was given). */
function readMap(v: unknown, warn: (m: string) => void): WinMap | null {
    if (v == null) {
        return null;
    }
    const tableOk = (edge: unknown, p: unknown) => isNums(edge) && isNums(p) && edge.length >= 2 && edge.length === p.length
        && edge.every((e, k) => k === 0 || e > edge[k - 1]) && p.every((x, k) => x >= 0 && x <= 1 && (k === 0 || x >= p[k - 1]));
    if (!isObj(v) || (v.kind !== 'logistic' && v.kind !== 'table')) {
        warn('scale.toWinProb has an unknown kind: no chance map');
        return null;
    }
    const rounds = (Array.isArray(v.byRound) ? v.byRound : []).filter((r): r is WinMapRound => {
        const ok = isObj(r) && isNum(r.from) && isNum(r.to) && (v.kind === 'logistic' ? (r.k == null || (isNum(r.k) && r.k > 0)) && (r.b == null || isNum(r.b)) : tableOk(r.edge, r.p));
        if (!ok) {
            warn('a scale.toWinProb.byRound entry is not valid: left out');
        }
        return ok;
    });
    const fitted = v.fitted === true;
    if (v.kind === 'logistic') {
        if (!isNum(v.k)) {
            warn('scale.toWinProb is logistic with no k: no chance map');
            return null;
        }
        // k = 0 is a flat 50%, and k < 0 favours the side behind
        if (v.k <= 0) {
            warn('scale.toWinProb is logistic with k <= 0: no chance map');
            return null;
        }
        return { kind: 'logistic', k: v.k, b: isNum(v.b) ? v.b : 0, ...(rounds.length ? { byRound: rounds } : {}), fitted };
    }
    if (!tableOk(v.edge, v.p)) {
        warn('scale.toWinProb table is not valid (edge must increase, p must not fall and stay in 0..1): no chance map');
        return null;
    }
    return { kind: 'table', edge: v.edge as number[], p: v.p as number[], ...(rounds.length ? { byRound: rounds } : {}), fitted };
}

/** The quality block with every field of the wrong type left out (with a warning), so views can format its numbers. */
function readQuality(v: unknown, warn: (m: string) => void): Quality | null {
    if (v == null) {
        return null;
    }
    if (!isObj(v)) {
        warn('evaluator.quality is not an object: left out');
        return null;
    }
    const q: Quality = {};
    const dropped: string[] = [];
    const nums = (o: Obj, keys: string[], at: string) => {
        const out: Record<string, number> = {};
        for (const k of keys) {
            if (isNum(o[k])) {
                out[k] = o[k];
            } else if (o[k] != null) {
                dropped.push(`${at}${k}`);
            }
        }
        return out;
    };
    const list = <T,>(key: string, keys: string[], need: string[]): T[] | undefined => {
        const a = v[key];
        if (a == null) {
            return undefined;
        }
        if (!Array.isArray(a)) {
            dropped.push(key);
            return undefined;
        }
        return a.flatMap((e, k) => {
            const r = isObj(e) ? nums(e, keys, `${key}[${k}].`) : null;
            if (!r || need.some((x) => r[x] == null)) {
                dropped.push(`${key}[${k}]`);
                return [];
            }
            return [r as T];
        });
    };
    Object.assign(q, nums(v, ['games', 'n', 'brier', 'logloss', 'acc'], ''));
    if (typeof v.data === 'string') {
        q.data = v.data;
    } else if (v.data != null) {
        dropped.push('data');
    }
    if (typeof v.heldOut === 'boolean') {
        q.heldOut = v.heldOut;
    } else if (v.heldOut != null) {
        dropped.push('heldOut');
    }
    const byRound = list<NonNullable<Quality['byRound']>[number]>('byRound', ['from', 'to', 'n', 'brier', 'logloss'], ['from', 'to']);
    const calibration = list<NonNullable<Quality['calibration']>[number]>('calibration', ['n', 'p', 'y'], ['n', 'p', 'y']);
    if (byRound) {
        q.byRound = byRound;
    }
    if (calibration) {
        q.calibration = calibration;
    }
    if (isObj(v.proven)) {
        const pr = nums(v.proven, ['n', 'right', 'brier'], 'proven.');
        if (pr.n != null && pr.right != null) {
            q.proven = pr as Quality['proven'];
        } else {
            dropped.push('proven');
        }
    } else if (v.proven != null) {
        dropped.push('proven');
    }
    if (dropped.length) {
        warn(`evaluator.quality: ${dropped.join(', ')} not valid: left out`);
    }
    return q;
}

/** The terms with a key, each field of the wrong type left out (with a warning), so views can print and fill them. */
function readTerms(v: unknown, at: string, warn: (m: string) => void): TermDef[] | null {
    if (!Array.isArray(v)) {
        return null;
    }
    const dropped: string[] = [];
    const terms = v.filter((t): t is Obj => isObj(t) && typeof t.key === 'string' && !!t.key).map((t) => {
        const out: Obj = { ...t };
        for (const [k, ok] of [['label', str], ['rule', str], ['ruleTpl', str]] as const) {
            if (t[k] != null && ok(t[k]) == null) {
                delete out[k];
                dropped.push(`${t.key}.${k}`);
            }
        }
        if (t.uses != null && !(Array.isArray(t.uses) && t.uses.every((x) => typeof x === 'string'))) {
            delete out.uses;
            dropped.push(`${t.key}.uses`);
        }
        if (t.transient != null && typeof t.transient !== 'boolean') {
            delete out.transient;
            dropped.push(`${t.key}.transient`);
        }
        return out as unknown as TermDef;
    });
    if (dropped.length) {
        warn(`evaluator.terms.${at}: ${dropped.join(', ')} not valid: left out`);
    }
    return terms;
}

/**
 * Notes what the views can't use as given in the steps (the file itself is not changed; resolveScore reads around it):
 * a repeated n (I5; the last copy is read, as earlier builds did), a p1Win outside 0..1 (I6; left out), seat values
 * that are not numbers (read as 0, so the Other row shows what they leave out of the total), and with `sets` (the
 * file's weightSets) a step that names no set or a set that doesn't exist (I8; the file's weights are used).
 */
function checkSteps(steps: unknown[], sets: Obj | null, warn: (m: string) => void) {
    const seen = new Set<number>();
    const repeated: number[] = [];
    const badChance: number[] = [];
    const badSeat: number[] = [];
    const unknownSet: number[] = [];
    const noSet: number[] = [];
    const isNumOrNone = (v: unknown) => v == null || isNum(v);
    for (const st of steps) {
        if (!isObj(st) || !isNum(st.n)) {
            continue;
        }
        if (seen.has(st.n)) {
            repeated.push(st.n);
        }
        seen.add(st.n);
        if (st.p1Win != null && !(isNum(st.p1Win) && st.p1Win >= 0 && st.p1Win <= 1)) {
            badChance.push(st.n);
        }
        const seatBad = (l: unknown) => isObj(l) && (!['base', 'resources', 'initiative'].every((k) => isNumOrNone(l[k]))
            || ['ground', 'space', 'hand'].some((k) => Array.isArray(l[k]) && !(l[k] as unknown[]).every(isNum)));
        if (seatBad(st.p1) || seatBad(st.p2)) {
            badSeat.push(st.n);
        }
        if (sets && !isObj(st.weights)) {
            if (typeof st.weightSet !== 'string') {
                noSet.push(st.n);
            } else if (!isObj(sets[st.weightSet]) || !isObj((sets[st.weightSet] as Obj).weights)) {
                unknownSet.push(st.n);
            }
        }
    }
    const at = (ns: number[]) => `${ns.length} step${ns.length === 1 ? '' : 's'} (first n ${ns[0]})`;
    if (repeated.length) {
        warn(`repeated step n at ${at(repeated)}: the last copy is read`);
    }
    if (badChance.length) {
        warn(`p1Win outside 0..1 at ${at(badChance)}: left out`);
    }
    if (badSeat.length) {
        warn(`seat values that are not numbers at ${at(badSeat)}: read as 0`);
    }
    if (unknownSet.length) {
        warn(`a weightSet that names no set in weightSets at ${at(unknownSet)}: the file's weights are used`);
    }
    if (noSet.length) {
        warn(`no weightSet or weights at ${at(noSet)} while the file has weightSets: the file's weights are used`);
    }
}

/**
 * Fills an evaluator block. `base` (the built-in Omni v1 descriptor) fills what the file leaves out, term by term;
 * fields the file gives always win. Without a base, missing fields take the plain defaults.
 */
function fillEvaluator(ev: Obj, base: LensEvaluator | null, warn: (m: string) => void): Evaluator {
    const scale = isObj(ev.scale) ? ev.scale : {};
    const pick = <T extends string>(v: unknown, allowed: T[], fallback: T, name: string): T => {
        if (v == null) {
            return fallback;
        }
        if (allowed.includes(v as T)) {
            return v as T;
        }
        warn(`unknown ${name} "${String(v)}": read as ${fallback}`);
        return fallback;
    };
    const id = str(ev.id) ?? 'unknown';
    const unit = str(scale.unit) ?? base?.scale?.unit ?? 'points';
    // an omni-linear-v1 file with toWinProb null gets the built-in rough map, the same as one that leaves the key out
    const map = readMap(scale.toWinProb, warn) ?? (base?.scale?.toWinProb ?? null);
    const fileTerms = isObj(ev.terms) ? ev.terms : null;
    const baseTerms = base?.terms ?? null;
    const group = (g: 'unit' | 'base' | 'side' | 'joint'): TermDef[] => {
        const own = fileTerms ? readTerms(fileTerms[g], g, warn) : null;
        const from = baseTerms?.[g] ?? [];
        if (!own) {
            return from.map((t) => ({ ...t }));
        }
        // a term the base knows gets the base's template, label and flags for whatever the file leaves out; a file term
        // with a rule of its own keeps it (the base's template, and the weights it uses, only go with the base's rule)
        return own.map((t) => {
            const b = from.find((x) => x.key === t.key);
            const keep = { ...b } as Partial<TermDef>;
            if (b && typeof t.rule === 'string' && t.rule !== b.rule) {
                delete keep.ruleTpl;
                delete keep.uses;
            }
            return { ...keep, ...Object.fromEntries(Object.entries(t).filter(([, x]) => x != null)) } as TermDef;
        });
    };
    // the same for the unit note: the base's template only while the file gives no other note
    const fileNote = str(fileTerms?.unitNote);
    const noteTpl = str(fileTerms?.unitNoteTpl) ?? (fileNote == null || fileNote === baseTerms?.unitNote ? baseTerms?.unitNoteTpl ?? null : null);
    const sixRows = !fileTerms && !baseTerms;
    return {
        id,
        label: str(ev.label) ?? base?.label ?? id,
        source: str(ev.source) ?? base?.source ?? '',
        description: str(ev.description) ?? base?.description ?? '',
        sees: pick(ev.sees, SEES, base?.sees ?? 'public', 'sees'),
        perspective: ev.perspective === 'p1' || ev.perspective === 'p2' ? ev.perspective : null,
        cardValues: pick(ev.cardValues, CARD_VALUES, 'additive', 'cardValues'),
        sampling: pick(ev.sampling, SAMPLING, 'every-step', 'sampling'),
        constantWeights: typeof ev.constantWeights === 'boolean' ? ev.constantWeights : true,
        unit,
        typical: isNum(scale.typical) && scale.typical > 0 ? scale.typical : base?.scale?.typical ?? null,
        toWinProb: map,
        quality: readQuality(ev.quality, warn),
        terms: {
            unit: group('unit'),
            base: group('base'),
            side: sixRows ? FIXED_SIDE.map((key) => ({ key, label: key[0].toUpperCase() + key.slice(1) })) : group('side'),
            joint: group('joint'),
            unitNote: fileNote ?? baseTerms?.unitNote ?? null,
            unitNoteTpl: noteTpl,
            sixRows
        }
    };
}

/**
 * Reads one lens file (parsed JSON) following spec section 6: the schema major first (a missing schema is read as
 * swu-lens/1 with a warning; any other major is refused), then a pre-08:40 omni file with no evaluator block (the
 * built-in Omni v1 descriptor with the file's own weights), then an omni-linear-v1 file (gaps filled from the
 * descriptor), then any other evaluator (plain defaults). Never throws.
 */
export function readLens(raw: unknown): LensReadResult {
    if (!isObj(raw)) {
        return { error: 'This lens file is not a JSON object.' };
    }
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    const schema = raw.schema;
    if (schema === undefined) {
        warn('no schema: read as swu-lens/1');
    } else if (typeof schema !== 'string' || !LENS_SCHEMA.test(schema)) {
        return { error: `This lens file is ${String(schema)}; this viewer reads swu-lens/1.` };
    }
    if (!Array.isArray(raw.steps)) {
        return { error: 'This lens file has no steps list.' };
    }
    const file = raw as unknown as LensFile;
    const fileWeights = isObj(raw.weights) ? (raw.weights as Weights) : null;
    let evaluator: Evaluator;
    let weights: Weights | null = fileWeights;
    let builtIn: LensRead['builtIn'] = null;
    if (!isObj(raw.evaluator)) {
        const legacy = str(raw.source)?.startsWith('bot/omni/lens.js') && !!fileWeights && LEGACY_WEIGHT_KEYS.every((k) => isNum(fileWeights[k]));
        if (legacy) {
            builtIn = 'legacy';
            evaluator = fillEvaluator({ id: OMNI_V1_ID, label: OMNI_V1_LEGACY_LABEL }, OMNI_V1_EVALUATOR, warn);
            weights = { ...fileWeights, dangerHp: fileWeights.dangerHp ?? OMNI_V1_WEIGHTS.dangerHp, danger: fileWeights.danger ?? OMNI_V1_WEIGHTS.danger };
        } else {
            evaluator = fillEvaluator({ id: 'unknown', label: 'Lens file (no evaluator info)' }, null, warn);
        }
    } else if (raw.evaluator.id === OMNI_V1_ID) {
        builtIn = 'omni-v1';
        evaluator = fillEvaluator(raw.evaluator, OMNI_V1_EVALUATOR, warn);
    } else {
        evaluator = fillEvaluator(raw.evaluator, null, warn);
    }
    if (raw.weightSets !== undefined && !isObj(raw.weightSets)) {
        warn('weightSets is not an object: ignored');
    }
    checkSteps(raw.steps, isObj(raw.weightSets) ? raw.weightSets : null, warn);
    return { file, evaluator, weights, builtIn, schemaGiven: schema !== undefined, warnings };
}

/** The evaluators.json registry, or null when the value is not one. */
export function readLensIndex(raw: unknown): LensIndex | null {
    if (!isObj(raw) || raw.schema !== 'swu-lens-index/1' || !Array.isArray(raw.evaluators)) {
        return null;
    }
    const evaluators = raw.evaluators.filter((e): e is { dir: string; id: string } => isObj(e) && typeof e.dir === 'string' && typeof e.id === 'string');
    return { schema: raw.schema, ...(typeof raw.default === 'string' ? { default: raw.default } : {}), evaluators };
}
