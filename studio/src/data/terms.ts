import { FIXED_SIDE, type Evaluator, type TermDef, type Weights } from './lensFile';

/**
 * The rows of a score, in the order the breakdown lists them, with the colour and icon the viewer gives each one.
 * Producers never send colours: the six fixed rows keep their tokens on every source, the extra keys that mean
 * something on the board (deck, discard, leader) have fixed slots, any other extra key is grey, and joint rows and
 * "Other (not split)" are hatched and never drawn on a card. Seat colours, gold and violet stay out of this set.
 */
export interface RowDef {
    /** 'base' | 'ground' | 'space' | 'side.hand' | 'side.resources' | 'side.initiative' | 'extra.<key>' | 'joint.<key>' | 'other' */
    id: string;
    group: 'base' | 'unit' | 'side' | 'extra' | 'joint' | 'other';
    key: string;
    label: string;
    /** the short rule, filled with the weights in force ('' when the file gives none); `skip` leaves out those term keys */
    rule(w: Weights | null, skip?: string[]): string;
    /** every rule of the row in full (tooltip) */
    how(w: Weights | null, skip?: string[]): string;
    color: string;
    /** icon key for PartIcon */
    icon: string;
    /** flips on quiet moves; swings leave it out */
    transient: boolean;
    /** weight keys the row reads */
    uses: string[];
}

const COLORS: Record<string, string> = {
    base: 'var(--color-v-base)',
    ground: 'var(--color-v-ground)',
    space: 'var(--color-v-space)',
    'side.hand': 'var(--color-v-hand)',
    'side.resources': 'var(--color-v-res)',
    'side.initiative': 'var(--color-v-init)',
    'extra.deck': 'var(--color-v-x1)',
    'extra.discard': 'var(--color-v-x2)',
    'extra.leader': 'var(--color-v-x3)'
};

const ICONS: Record<string, string> = {
    base: 'base', ground: 'ground', space: 'space', 'side.hand': 'hand', 'side.resources': 'resources', 'side.initiative': 'initiative',
    'extra.deck': 'deck', 'extra.discard': 'discard', 'extra.leader': 'leader', other: 'other'
};

/** a bare side key ('hand') read as its row id ('side.hand') */
const rowId = (id: string) => (FIXED_SIDE.includes(id) ? `side.${id}` : id);

/** The colour of a row, by row id (a bare 'hand', 'resources' or 'initiative' works too). */
export function rowColor(id: string): string {
    const r = rowId(id);
    return COLORS[r] ?? (r.startsWith('joint.') || r === 'other' ? 'var(--color-v-joint)' : 'var(--color-v-other)');
}

/** The icon key of a row, by row id. */
export function rowIcon(id: string): string {
    const r = rowId(id);
    return ICONS[r] ?? (r.startsWith('joint.') ? 'joint' : 'extra');
}

/** 3 significant digits: 0.1666… → "0.167", 0.04 → "0.04", 1234.5 → "1230" */
export const sig3 = (v: number) => String(Number(v.toPrecision(3)));

/** A rule template with each {weightKey} filled with that weight (3 significant digits); an unknown key prints '?'. */
export function fillRule(tpl: string, w: Weights | null): string {
    return tpl.replace(/\{([^{}]+)\}/g, (_, k: string) => (w && Number.isFinite(w[k]) ? sig3(w[k]) : '?'));
}

/** The weight keys a term reads: its `uses`, else the slots of its template. */
export const usesOf = (t: TermDef) => t.uses ?? [...(t.ruleTpl ?? '').matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]);

const sameWeight = (a: number | undefined, b: number | undefined) => a != null && b != null && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

/**
 * A term's rule at these weights: the literal rule while the weights it reads are the ones it was written for, else the
 * filled template, else the literal rule (always, when there are no weights).
 */
export function termRule(t: TermDef, w: Weights | null): string {
    const at = t.literalAt;
    if (t.rule && w && at && usesOf(t).every((k) => sameWeight(w[k], at[k]))) {
        return t.rule;
    }
    if (t.ruleTpl && w) {
        return fillRule(t.ruleTpl, w);
    }
    return t.rule ?? (t.ruleTpl ? fillRule(t.ruleTpl, w) : '');
}

const label = (t: TermDef) => t.label ?? t.key;
const joinRules = (ts: TermDef[], w: Weights | null) => ts.map((t) => {
    const r = termRule(t, w);
    return r ? `${label(t)}: ${r}` : label(t);
}).join('; ');

/** The row everything a file's rows don't explain goes into. */
export const OTHER_ROW: RowDef = {
    id: 'other', group: 'other', key: 'other', label: 'Other (not split)',
    rule: () => 'the part of the score its rows do not explain',
    how: () => 'The file\'s total (or edge) minus what its rows add up to.',
    color: rowColor('other'), icon: 'other', transient: false, uses: []
};

/** The unit note filled with the given weights (the literal note when there is no template or no weights). */
export const unitNoteOf = (ev: Pick<Evaluator, 'terms'>) => (w: Weights | null) => (ev.terms.unitNoteTpl && w ? fillRule(ev.terms.unitNoteTpl, w) : ev.terms.unitNote ?? '');

/**
 * The declared rows of an evaluator, in breakdown order: base, ground, space, then hand, resources and initiative
 * (only the declared ones), then the extra side terms, then the joint terms. A file that names no terms gets the six
 * fixed rows with no rules; cardValues "none" has no rows.
 */
export function rowsOf(ev: Evaluator): RowDef[] {
    if (ev.cardValues === 'none') {
        return [];
    }
    const { unit, base, side, joint, sixRows } = ev.terms;
    const rows: RowDef[] = [];
    const unitNote = unitNoteOf(ev);
    const mk = (id: string, group: RowDef['group'], key: string, name: string, terms: TermDef[], note?: (w: Weights | null) => string): RowDef => {
        const kept = (skip?: string[]) => (skip?.length ? terms.filter((t) => !skip.includes(t.key)) : terms);
        return {
            id, group, key, label: name,
            // a zone row lists its unit terms by name; any other row prints its rules
            rule: (w, skip) => {
                const ts = kept(skip);
                return ts.length === 1 ? termRule(ts[0], w) : group === 'unit' ? ts.map(label).join(' + ') : ts.map((t) => termRule(t, w)).filter(Boolean).join('; ');
            },
            how: (w, skip) => [joinRules(kept(skip), w), note?.(w)].filter(Boolean).join('; '),
            color: rowColor(id), icon: rowIcon(id),
            transient: terms.length === 1 && (terms[0].transient ?? terms[0].key === 'initiative'),
            uses: [...new Set(terms.flatMap(usesOf))]
        };
    };
    if (base.length || sixRows) {
        rows.push(mk('base', 'base', 'base', 'Base', base));
    }
    if (unit.length || sixRows) {
        rows.push(mk('ground', 'unit', 'ground', 'Ground units', unit, unitNote));
        rows.push(mk('space', 'unit', 'space', 'Space units', unit, unitNote));
    }
    for (const key of FIXED_SIDE) {
        const t = side.find((x) => x.key === key);
        if (t) {
            rows.push(mk(`side.${key}`, 'side', key, label(t), [t]));
        }
    }
    for (const t of side.filter((x) => !FIXED_SIDE.includes(x.key))) {
        rows.push(mk(`extra.${t.key}`, 'extra', t.key, label(t), [t]));
    }
    for (const t of joint) {
        rows.push({ ...mk(`joint.${t.key}`, 'joint', t.key, label(t), [t]), transient: t.transient ?? false });
    }
    return rows;
}
