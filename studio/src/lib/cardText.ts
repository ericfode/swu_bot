import type { CardRef } from '../data/types';
import { bumpArtVersion } from './settings';

/**
 * Printed card data, for drawing a card that has no image (a text face in the inspector, real aspect colours on tiles).
 * The file is swu-card-text/1 (made by viewer-kit/make-card-text.py from the engine's card data): `{schema, source, cards}`
 * with cards keyed by set code ("SOR_059"), the same code as a replay card's `s`.
 */
export interface CardText {
    /** title, subtitle */
    t: string;
    st?: string;
    /** cost (a leader's: the resources it deploys at) */
    c?: number;
    /** power and HP (a leader's: its deployed unit side) */
    p?: number;
    h?: number;
    /** upgrade bonus (upgrades, and pilots that can attach as one) */
    up?: number;
    uh?: number;
    /** unit, event, upgrade, leader, base; tokens add 'token' */
    ty?: string[];
    /** ground or space */
    ar?: string;
    /** vigilance, command, aggression, cunning, heroism, villainy (a repeat means the card needs that aspect twice) */
    as?: string[];
    tr?: string[];
    kw?: string[];
    /** rules text, a leader's deployed-side text (deploy box) and its epic action */
    tx?: string;
    db?: string;
    ea?: string;
    /** unique */
    u?: 1;
}

export interface CardTextFile {
    schema: 'swu-card-text/1' | string;
    source?: string;
    cards: Record<string, CardText>;
}

// every card from the files loaded so far (files add to each other, like art packs)
const bySet = new Map<string, CardText>();
// tokens have no set number (a replay writes s: null for them), so a file's token entries are found by title
const tokens = new Map<string, CardText>();
const fetched = new Map<string, Promise<number>>();
let version = 0;

function add(src: CardTextFile | Record<string, CardText>): number {
    const cards = (src as CardTextFile).cards && typeof (src as CardTextFile).cards === 'object' ? (src as CardTextFile).cards : (src as Record<string, CardText>);
    for (const [code, c] of Object.entries(cards ?? {})) {
        if (!c || typeof c.t !== 'string') {
            continue;
        }
        bySet.set(code, c);
        if (c.ty?.includes('token')) {
            tokens.set(c.t, c);
        }
    }
    version++;
    bumpArtVersion();
    return bySet.size;
}

/**
 * Load card data (a swu-card-text/1 file, its `cards` map, or a URL to one) for every viewer on the page. A URL is
 * fetched once; cards re-render when it arrives. Resolves to the number of cards known.
 */
export function loadCardText(src: string | CardTextFile | Record<string, CardText>): Promise<number> {
    if (typeof src !== 'string') {
        return Promise.resolve(add(src));
    }
    let p = fetched.get(src);
    if (!p) {
        p = fetch(src).then((r) => {
            if (!r.ok) {
                throw new Error(`${src}: ${r.status}`);
            }
            return r.json();
        }).then((j) => add(j));
        // a failed fetch can be retried by calling again
        p.catch(() => fetched.delete(src));
        fetched.set(src, p);
    }
    return p;
}

/** The printed data of a card by set code ("SOR_059"), or null when no loaded file has it. */
export function cardTextBySet(setCode: string | null | undefined): CardText | null {
    return setCode ? bySet.get(setCode) ?? null : null;
}

/** The printed data of a replay card: by set code, or for a token (no set code) by title when the file has tokens. */
export function cardTextOf(card: Pick<CardRef, 'n' | 's'>): CardText | null {
    return card.s ? bySet.get(card.s) ?? null : tokens.get(card.n) ?? null;
}

/**
 * A card's printed cost from the loaded card data, or null. Every score path passes this as `cardCost` (the viewer, the
 * kit's pivotal and classifyGame, mountBoard, a standalone EdgeBreakdown), so they all give the same estimate.
 */
export const loadedCardCost = (card: Pick<CardRef, 'n' | 's'>): number | null => cardTextOf(card)?.c ?? null;

/** Bumps every time card data is added (for caches keyed on it). */
export const cardTextVersion = () => version;

/**
 * A token unit or upgrade (Battle Droid, Clone Trooper, X-Wing, Shield, Experience…): the recorder writes `s: null` for
 * cards with no set number, and `t: 1` on token upgrades; card data marks them 'token' too.
 * Hidden replay cards and unknown preview draws also have no set number, without being tokens.
 */
export function isToken(card: Pick<CardRef, 'n' | 's'> & { t?: 0 | 1 }): boolean {
    const hidden = /^(?:unknown|hidden) card$/i.test(card.n);
    return card.t === 1 || !!cardTextOf(card)?.ty?.includes('token') || (card.s == null && !hidden);
}
