'use strict';

/**
 * Card facts by set code (e.g. "SOR_232"), read straight from the card json that `npm run get-cards` writes.
 * Replay snapshots only carry name + set code, so evaluators look up cost, stats and keywords here.
 * No engine needed, so this also works on recorded games from any machine that has the card data.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', '..', 'forceteki', 'test', 'json');
const KEYWORDS = ['sentinel', 'raid', 'overwhelm', 'saboteur', 'restore', 'grit', 'ambush', 'shielded', 'bounty', 'smuggle', 'hidden', 'coordinate', 'piloting', 'exploit'];

class CardDb {
    constructor(dir = process.env.SWU_CARD_JSON ?? DEFAULT_DIR) {
        this.dir = dir;
        // without card data every lookup returns null (stats then come from the snapshot alone)
        const read = (f, dflt) => (fs.existsSync(path.join(dir, f)) ? JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) : dflt);
        this.bySet = read('_setCodeMap.json', {});
        this.idToName = new Map(read('_cardMap.json', []).map((c) => [c.id, c.internalName]));
        this.cache = new Map();
    }

    /** {cost, power, hp, unit, event, upgrade, arena, kw:Set, upPower, upHp} or null for tokens / unknown codes. */
    get(setCode) {
        if (!setCode) {
            return null;
        }
        if (this.cache.has(setCode)) {
            return this.cache.get(setCode);
        }
        let info = null;
        const id = this.bySet[setCode];
        const name = id && this.idToName.get(id);
        if (name) {
            try {
                const c = JSON.parse(fs.readFileSync(path.join(this.dir, 'Card', `${name}.json`), 'utf8'));
                const types = c.types ?? [];
                info = {
                    cost: c.cost ?? 0,
                    power: c.power ?? 0,
                    hp: c.hp ?? 0,
                    unit: types.includes('unit'),
                    event: types.includes('event'),
                    upgrade: types.includes('upgrade'),
                    arena: c.arena ?? null,
                    kw: new Set((c.keywords ?? []).filter((k) => KEYWORDS.includes(k))),
                    upPower: c.upgradePower ?? 0,
                    upHp: c.upgradeHp ?? 0
                };
            } catch {
                info = null;
            }
        }
        this.cache.set(setCode, info);
        return info;
    }
}

let shared = null;
const cardDb = () => (shared ??= new CardDb());

module.exports = { CardDb, cardDb, KEYWORDS };
