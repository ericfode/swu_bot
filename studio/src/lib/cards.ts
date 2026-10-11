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

/**
 * Use a pack of images ({"SOR_010": "data:...", "SOR_010-b": ...}, or a URL to one) instead of the CDN; cards not in
 * the pack fall back to tiles. Made by studio/scripts/art-pack.py.
 */
export async function loadArtPack(pack: string | Record<string, string>): Promise<number> {
    const map: Record<string, string> = typeof pack === 'string' ? await (await fetch(pack)).json() : pack;
    setArtResolver((code, back) => map[back ? `${code}-b` : code] ?? (back ? map[code] : null) ?? null);
    const { useSettings } = await import('./settings');
    useSettings.setState((s) => ({ artVersion: s.artVersion + 1 }));
    return Object.keys(map).length;
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

// The six SWU aspects. The replay format has no aspect data, so a tile borrows one from its name: it only has to be stable.
const ASPECTS = [
    { name: 'vigilance', a: '#2f6fe0', b: '#0d2350' },
    { name: 'command', a: '#2fae62', b: '#0b3320' },
    { name: 'aggression', a: '#d8434b', b: '#45101a' },
    { name: 'cunning', a: '#e0b63a', b: '#4a3608' },
    { name: 'heroism', a: '#c9d6ea', b: '#2c3a52' },
    { name: 'villainy', a: '#8a5cf0', b: '#1c1040' }
];

export function tileLook(name: string) {
    const h = hash(name);
    const asp = ASPECTS[h % ASPECTS.length];
    const words = name.split(',')[0].split(/\s+/).filter((w) => /^[A-Z0-9]/i.test(w));
    const mono = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2)).toUpperCase();
    return { ...asp, mono, angle: 120 + (h % 90) };
}

const BOT_COLORS = ['#56c8ff', '#ff6b78', '#f6c454', '#a48bff', '#4fe0a8', '#ff9d5c', '#7fd1d8', '#e58bd8'];
export const botColor = (bots: string[], bot: string) => BOT_COLORS[Math.max(0, bots.indexOf(bot)) % BOT_COLORS.length];
