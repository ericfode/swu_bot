import { cardTextOf } from './cardText';

/** Card art lives on swu-db's CDN: /images/cards/<SET>/<NNN>.png, with "-b" for the deployed side of a leader. */
export function swuDbImageUrl(setCode: string | null, back = false): string | null {
    const [set, num] = (setCode ?? '').split('_');
    return set && num ? `https://cdn.swu-db.com/images/cards/${set}/${num}${back ? '-b' : ''}.png` : null;
}

export type ArtResolver = (setCode: string, back: boolean) => string | null;
let resolver: ArtResolver = (s, b) => swuDbImageUrl(s, b);

/** Where card images come from. Pages that can't reach the CDN (published artifacts) point this at bundled art. */
export function setArtResolver(r: ArtResolver | null) {
    resolver = r ?? ((s, b) => swuDbImageUrl(s, b));
}

// every image from the packs loaded so far: packs add to each other
const packed: Record<string, string> = {};

/**
 * Use a pack of images ({"SOR_010": "data:...", "SOR_010-b": ...}, or a URL to one) instead of the CDN; cards not in
 * the pack fall back to tiles. A pack can also be {"parts": ["a.json", "b.json"]} (URLs relative to it), for packs too
 * big for one file. Made by studio/scripts/art-pack.py.
 */
export async function loadArtPack(pack: string | Record<string, string>): Promise<number> {
    const read = async (url: string): Promise<Record<string, string>> => {
        const j = await (await fetch(url)).json();
        if (Array.isArray(j?.parts)) {
            const parts = await Promise.all((j.parts as string[]).map((p) => read(new URL(p, new URL(url, location.href)).href)));
            return Object.assign({}, ...parts);
        }
        return j;
    };
    Object.assign(packed, typeof pack === 'string' ? await read(pack) : pack);
    setArtResolver((code, back) => packed[back ? `${code}-b` : code] ?? (back ? packed[code] : null) ?? null);
    const { bumpArtVersion } = await import('./settings');
    bumpArtVersion();
    return Object.keys(packed).length;
}

export function cardImageUrl(setCode: string | null, back = false): string | null {
    return setCode ? resolver(setCode, back) : null;
}

/** Engine internal names show up as action labels, e.g. "luke-skywalker#faithful-friend". */
export function humanize(label: string): string {
    return label
        .replace(/#/g, ': ')
        .split(/[-\s]+/)
        .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
        .join(' ')
        .replace(/ : /g, ': ');
}

function hash(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    }
    return h >>> 0;
}

// Tile colours without card data: muted, non-aspect tones. The replay format has no aspect data, so faking one misled (a
// villain shown as heroism silver); these only need to be stable per name, and none is a seat colour, gold or a lens score
// colour. With card data loaded (loadCardText), tiles take their real aspects instead (aspectGradient).
const TILE_TONES = [
    { a: '#5b6b86', b: '#161d2c' },
    { a: '#4d756d', b: '#12221d' },
    { a: '#76694f', b: '#252014' },
    { a: '#6a5b7c', b: '#1d1727' },
    { a: '#5c744c', b: '#182212' },
    { a: '#6f6470', b: '#1f1a21' }
];

const MINOR = new Set(['the', 'a', 'an', 'of', 'to', 'for', 'in', 'on', 'and', 'or', 'from', 'with', 'by', 'at', 'is']);

/**
 * Two letters for a card, from its distinct words: initials of the first two that aren't "the", "of"…, else the first
 * letter and the next consonant or digit (Maul ML, The Mandalorian MN, Mandalorian Warrior MW, R2-D2 R2).
 */
export function monogram(name: string): string {
    const words = name.split(',')[0].split(/\s+/).map((w) => w.replace(/^[^a-z0-9]+/i, '')).filter(Boolean);
    const sig = words.filter((w) => !MINOR.has(w.toLowerCase()));
    const use = sig.length ? sig : words;
    if (use.length > 1) {
        return (use[0][0] + use[1][0]).toUpperCase();
    }
    const w = use[0] ?? '?';
    const next = w.slice(1).match(/[b-df-hj-np-tv-z0-9]/i)?.[0] ?? w[1] ?? '';
    return (w[0] + next).toUpperCase();
}

/**
 * The six aspects in card colours, used only when card data is loaded (src/lib/cardText.ts). `hi`/`lo` are a tile's light
 * and dark ends, kept as dark as the muted tones so white names stay readable; `pip` is the swatch on a dark face.
 * Vigilance is a royal blue and Aggression a brick red, so neither reads as a seat colour (p1 cyan, p2 pink-red), and
 * none is the score's violet.
 */
export const ASPECTS: Record<string, { label: string; hi: string; lo: string; pip: string }> = {
    vigilance: { label: 'Vigilance', hi: '#3a5fa8', lo: '#111f3d', pip: '#4c7bd4' },
    command: { label: 'Command', hi: '#3c7f4b', lo: '#0f2716', pip: '#4ea062' },
    aggression: { label: 'Aggression', hi: '#a2472a', lo: '#34140a', pip: '#cf5a35' },
    cunning: { label: 'Cunning', hi: '#9c7a23', lo: '#332608', pip: '#d4a838' },
    heroism: { label: 'Heroism', hi: '#d8d1bf', lo: '#68645a', pip: '#e9e3d3' },
    villainy: { label: 'Villainy', hi: '#2c2731', lo: '#060508', pip: '#16131a' }
};
const ORDER = ['vigilance', 'command', 'aggression', 'cunning', 'heroism', 'villainy'];

/** A card's aspects, each once, colours first and Heroism/Villainy last (data lists some as "villainy, vigilance"). */
export function aspectsOf(as: string[] | undefined): string[] {
    return [...new Set((as ?? []).map((a) => a.toLowerCase()))].filter((a) => ASPECTS[a]).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
}

/**
 * A tile's background from real aspects. One aspect: its colour, darkening down the card (Heroism alone: grey with an
 * off-white corner, so the white monogram stays readable). Several: split across the diagonal, first aspect top-left,
 * Heroism/Villainy bottom-right, with dark seams where the name sits. No aspect: neutral slate.
 */
export function aspectGradient(as: string[] | undefined): string {
    const ks = aspectsOf(as);
    if (!ks.length) {
        return 'linear-gradient(160deg, #596170, #1d212a)';
    }
    if (ks.length === 1) {
        const k = ASPECTS[ks[0]];
        return ks[0] === 'heroism'
            ? `linear-gradient(135deg, #7f7b70 0%, ${k.lo} 58%, ${k.hi} 100%)`
            : `linear-gradient(160deg, ${k.hi}, color-mix(in oklab, ${k.hi} 45%, ${k.lo}))`;
    }
    const n = ks.length;
    const stops = ks.map((a, i) => {
        const k = ASPECTS[a];
        const from = Math.round((i / n) * 100);
        const to = Math.round(((i + 1) / n) * 100);
        // the first band fades towards the seam, the last brightens towards its corner
        return i === 0 ? `${k.hi} ${from}%, ${k.lo} ${to}%` : i === n - 1 ? `${k.lo} ${from}%, ${k.hi} ${to}%` : `${k.hi} ${from}%, ${k.lo} ${to}%`;
    });
    return `linear-gradient(135deg, ${stops.join(', ')})`;
}

/**
 * How a card without art is drawn: monogram, and colours. Muted per-name tones by default; with card data loaded for
 * that card, `grad` is the background in its real aspects (null without data).
 */
export function tileLook(name: string, setCode: string | null = null) {
    const h = hash(name);
    const asp = TILE_TONES[h % TILE_TONES.length];
    const text = cardTextOf({ n: name, s: setCode });
    return { ...asp, mono: monogram(name), angle: 120 + (h % 90), grad: text ? aspectGradient(text.as) : null, aspects: text ? aspectsOf(text.as) : null };
}

// tournament colours per bot: none is a seat colour (p1 blue, p2 red), gold or the score's violet, so a bot's colour never reads as a seat
const BOT_COLORS = ['#4fe0a8', '#ff9d5c', '#e58bd8', '#c9d36a', '#d6b48a', '#9ad0e0'];
export const botColor = (bots: string[], bot: string) => BOT_COLORS[Math.max(0, bots.indexOf(bot)) % BOT_COLORS.length];
