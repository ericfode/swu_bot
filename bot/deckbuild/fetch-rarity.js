'use strict';

/**
 * Card rarity and set membership from the official card database (admin.starwarsunlimited.com, the same API
 * forceteki's `npm run get-cards` reads). The engine's card data has no rarity, and drafting needs it to build packs.
 *
 *   node bot/deckbuild/fetch-rarity.js [out.json]     # default /mnt/project-files/deckbuild/rarity.json
 *
 * Behind a proxy, run with NODE_USE_ENV_PROXY=1 (Node's fetch ignores HTTPS_PROXY otherwise).
 * Polite: one request every 3 s, pages of 100, variants left out (31 requests of ~6 MB each, ~12 minutes). Writes
 * { source, fetchedAt, cards: { "SOR_005": { rarity, type, cardId } } } keyed by set code, reprints included
 * (a reprint is its own record with its own set and number).
 */
const fs = require('fs');
const path = require('path');

const API = 'https://admin.starwarsunlimited.com/api/cards';
const UA = 'swu-bot research (polite; github.com/ericfode/swu_bot)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(n) {
    const q = `pagination[page]=${n}&pagination[pageSize]=100&filters[variantOf][id][$null]=true&populate=rarity,expansion,type`;
    const res = await fetch(`${API}?${q.replace(/\[/g, '%5B').replace(/\]/g, '%5D')}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(240000) });
    if (!res.ok) {
        throw new Error(`page ${n}: HTTP ${res.status}`);
    }
    return res.json();
}

const attr = (rel) => rel?.data?.attributes ?? null;

async function main() {
    const out = process.argv[2] ?? (fs.existsSync('/mnt/project-files') ? '/mnt/project-files/deckbuild/rarity.json' : 'replays/rarity.json');
    const cards = {};
    let pages = 1;
    for (let n = 1; n <= pages; n++) {
        const d = await page(n);
        pages = d.meta.pagination.pageCount;
        for (const r of d.data) {
            const a = r.attributes;
            const set = attr(a.expansion)?.code;
            if (!set || !Number.isInteger(a.cardNumber)) {
                continue;
            }
            const key = `${set}_${String(a.cardNumber).padStart(3, '0')}`;
            cards[key] = { rarity: attr(a.rarity)?.name ?? null, type: attr(a.type)?.name ?? null, cardId: a.cardId ?? a.cardUid, title: a.title };
        }
        process.stderr.write(`page ${n}/${pages}, ${Object.keys(cards).length} cards\n`);
        if (n < pages) {
            await sleep(3000);
        }
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const doc = { source: 'admin.starwarsunlimited.com/api/cards (official card database), variants left out', fetchedAt: new Date().toISOString(), cards };
    fs.writeFileSync(`${out}.tmp`, JSON.stringify(doc));
    fs.renameSync(`${out}.tmp`, out);
    console.log(`${Object.keys(cards).length} cards -> ${out}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
