'use strict';

/**
 * The card pool a deck builder may use: every implemented leader, base and main-deck card (unit, event, upgrade) in the
 * engine's card data, with the printed numbers a builder needs. Rarity comes from rarity.json when present
 * (fetch-rarity.js); the engine's card data has none.
 *
 * Aspect rules (Comprehensive Rules 1.2.4, 8.1): the leader and base provide their aspect icons; each icon on a card
 * that they do not provide costs 2 more resources. `penalty(card, provided)` counts those missing icons.
 */
const fs = require('fs');

const pad3 = (n) => String(n).padStart(3, '0');
const codeOf = (s) => `${s.set}_${pad3(s.number)}`;
const MAIN_TYPES = ['unit', 'event', 'upgrade'];

/** Missing aspect icons: each icon of the card must be matched by a distinct provided icon. */
function penalty(card, provided) {
    const have = [...provided];
    let miss = 0;
    for (const a of card.aspects) {
        const i = have.indexOf(a);
        if (i >= 0) {
            have.splice(i, 1);
        } else {
            miss++;
        }
    }
    return miss;
}

class CardPool {
    /** @param env bot/env.js Env (card data and the implemented-card rule) */
    constructor(env, { rarityFile = null } = {}) {
        const g = env.cardDataGetter;
        let rarity = {};
        const rf = rarityFile ?? (fs.existsSync('/mnt/project-files/deckbuild/rarity.json') ? '/mnt/project-files/deckbuild/rarity.json' : null);
        if (rf && fs.existsSync(rf)) {
            rarity = JSON.parse(fs.readFileSync(rf, 'utf8')).cards;
        }
        this.byCode = new Map();
        this.leaders = [];
        this.bases = [];
        this.main = [];
        for (const id of g.cardIds) {
            const c = g.getCardSync(id);
            if (env.mockNames.has(c.internalName) || c.types.includes('token') || !env.isImplemented(c)) {
                continue;
            }
            const setCode = codeOf(c.setId);
            if (!g.setCodeMap.has(setCode)) {
                continue;
            }
            const type = c.types.includes('leader') ? 'leader' : c.types.includes('base') ? 'base' : MAIN_TYPES.find((t) => c.types.includes(t));
            if (!type) {
                continue;
            }
            const setCodes = [...new Set((c.setCodes ?? [c.setId]).map(codeOf))];
            const r = setCodes.map((s) => rarity[s]?.rarity).find(Boolean) ?? null;
            const e = {
                id: c.id, setCode, setCodes, name: c.subtitle ? `${c.title}, ${c.subtitle}` : c.title, internalName: c.internalName, type,
                cost: c.cost ?? 0, power: c.power ?? 0, hp: c.hp ?? 0, aspects: c.aspects ?? [], arena: c.arena ?? null,
                keywords: c.keywords ?? [], traits: c.traits ?? [], unique: !!c.unique,
                upgradePower: c.upgradePower ?? null, upgradeHp: c.upgradeHp ?? null,
                text: Boolean(c.text && c.text.trim()), rarity: r,
                rarityBySet: Object.fromEntries(setCodes.filter((s) => rarity[s]).map((s) => [s.split('_')[0], rarity[s].rarity]))
            };
            this.byCode.set(setCode, e);
            (type === 'leader' ? this.leaders : type === 'base' ? this.bases : this.main).push(e);
        }
        // deck lists may name any printing (reprints): map every code to the card
        for (const e of [...this.byCode.values()]) {
            for (const s of e.setCodes) {
                if (!this.byCode.has(s) && g.setCodeMap.has(s)) {
                    this.byCode.set(s, e);
                }
            }
        }
        const sortKey = (a, b) => (a.setCode < b.setCode ? -1 : a.setCode > b.setCode ? 1 : 0);
        this.leaders.sort(sortKey);
        this.bases.sort(sortKey);
        this.main.sort(sortKey);
    }

    get(code) {
        return this.byCode.get(code) ?? null;
    }

    /** Aspect icons a leader and base provide. */
    provided(leader, base) {
        return [...this.get(leader).aspects, ...this.get(base).aspects];
    }

    /** Main-deck cards with no aspect penalty for this leader and base. */
    inAspect(leader, base) {
        const prov = this.provided(leader, base);
        return this.main.filter((c) => penalty(c, prov) === 0);
    }
}

module.exports = { CardPool, penalty, codeOf };
