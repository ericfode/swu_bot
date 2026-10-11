import type { DeckList, Header, Seat } from '../data/types';
import { cardTextBySet } from '../lib/cardText';

/** The bot program's language (v2 header players[].lang), small beside its name. */
export function LangTag({ header, seat }: { header: Header; seat: Seat }) {
    const lang = header.players.find((p) => p.id === seat)?.lang;
    return lang ? <span className="text-faint text-[10px] font-mono self-center" title={`Bot program written in ${lang}`}>{lang}</span> : null;
}

/** A deck list (v2 header decks) as a title: leader, base and every card, by name when card data is loaded. */
export function deckTitle(header: Header, seat: Seat): string | undefined {
    const d: DeckList | undefined = header.decks?.[seat];
    if (!d?.deck) {
        return undefined;
    }
    const name = (id: string) => cardTextBySet(id)?.t ?? id;
    const cards = d.deck.map((c) => ({ n: name(c.id), id: c.id, count: c.count })).sort((a, b) => a.n.localeCompare(b.n));
    const total = cards.reduce((a, c) => a + c.count, 0);
    return [`Leader ${name(d.leader.id)} · base ${name(d.base.id)}`, `${total} cards:`, ...cards.map((c) => `${c.count}× ${c.n}${c.n !== c.id ? ` (${c.id})` : ''}`)].join('\n');
}
