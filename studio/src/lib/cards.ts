/** Card art lives on swu-db's CDN: /images/cards/<SET>/<NNN>.png, with "-b" for the deployed side of a leader. */
export function cardImageUrl(setCode: string | null, back = false): string | null {
    const [set, num] = (setCode ?? '').split('_');
    return set && num ? `https://cdn.swu-db.com/images/cards/${set}/${num}${back ? '-b' : ''}.png` : null;
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
