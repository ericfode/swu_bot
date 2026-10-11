/** Card art lives on swu-db's CDN: /images/cards/<SET>/<NNN>.png, with "-b" for the deployed side of a leader. */
export function cardImageUrl(setCode: string | null, back = false): string | null {
    if (!setCode) {
        return null;
    }
    const [set, num] = setCode.split('_');
    if (!set || !num) {
        return null;
    }
    return `https://cdn.swu-db.com/images/cards/${set}/${num}${back ? '-b' : ''}.png`;
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
