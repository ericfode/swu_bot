#!/usr/bin/env node
'use strict';

/**
 * Writes bot/bend/cards.tsv: one line per set code (reprints included) with the numbers the Bend bot reads at start.
 * The bot gets cards by set code (`s` in the protocol, e.g. SOR_095) and knows nothing else about them, so this
 * table is its only card knowledge. Only facts are extracted here (stats, keywords, aspects, and a few effect tags
 * found by regular expressions in the card text); every decision is made in Bend.
 *
 *   node bot/bend/tools/gen-cards.js [cardDir] [out] [textOut]
 *   defaults: forceteki/test/json/Card  bot/bend/cards.tsv  bot/bend/cards-text.tsv
 *
 * Columns (all numbers except code):
 *   code kind cost power hp arena vig cmd agg cun her vil kw raid restore upPower upHp unique fx fxN
 * kind: 1 unit, 2 event, 3 upgrade, 4 leader, 5 base, 6 token unit, 7 token upgrade, 0 other
 * arena: 0 none, 1 ground, 2 space
 * vig..vil: how many of each aspect icon the card has
 * kw: keyword bits (KW below); raid/restore: their amounts from the text
 * fx: effect tag bits (FX below); fxN: the largest "deal N damage" amount in the text
 *
 * cards-text.tsv has `code internalName title text` per line (display prompts name cards by internal name only), folded to ASCII on one line, for the TypeSafe questions the bot asks.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..', '..');
const cardDir = process.argv[2] ?? path.join(root, 'forceteki', 'test', 'json', 'Card');
const out = process.argv[3] ?? path.join(__dirname, '..', 'cards.tsv');
const textOut = process.argv[4] ?? path.join(__dirname, '..', 'cards-text.tsv');

// one ASCII line: accents dropped, curly quotes straightened, tabs and newlines turned into separators
const ascii = (s) => (s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/\u2026/g, '...').replace(/\t/g, ' ')
    .replace(/\s*\n\s*/g, ' / ').replace(/[^\x20-\x7e]/g, '');

const KW = ['sentinel', 'raid', 'overwhelm', 'ambush', 'restore', 'saboteur', 'hidden', 'shielded', 'grit', 'piloting',
    'smuggle', 'bounty', 'plot', 'support', 'coordinate', 'exploit', 'fortify'];
const ASPECTS = ['vigilance', 'command', 'aggression', 'cunning', 'heroism', 'villainy'];

// effect tags: bit -> test on the lower-cased text
const FX = [
    ['damage', /deal \d+ damage to/],
    ['defeat', /\bdefeat (a|an|another|each|up to|that|all)\b/],
    ['heal', /\bheal \d+/],
    ['draw', /\bdraw (a|an|\d+|that|two|three) cards?/],
    ['exhaust', /\bexhaust (a|an|another|each|up to|that|all|it|them)\b/],
    ['ready', /\bready (a|an|another|that|it|each|up to)\b/],
    ['bounce', /return .* to (its|their) owner'?s? hand/],
    ['capture', /\bcaptures?\b/],
    ['shield', /shield tokens?/],
    ['experience', /experience tokens?/],
    ['token', /create (a|an|\d+|two|three) .*token/],
    ['buff', /gets? \+\d+\/\+\d+/],
    ['debuff', /gets? -\d+\/-\d+/],
    ['search', /search the top/],
    ['discard', /\bdiscards?\b/],
    ['basedamage', /damage to (a|each|the|your opponent'?s|an enemy|that player'?s) base/]
];

function kindOf(types) {
    const t = new Set(types ?? []);
    if (t.has('token')) {
        return t.has('unit') ? 6 : t.has('upgrade') ? 7 : 0;
    }
    if (t.has('leader')) {
        return 4;
    }
    if (t.has('base')) {
        return 5;
    }
    if (t.has('unit')) {
        return 1;
    }
    if (t.has('event')) {
        return 2;
    }
    if (t.has('upgrade')) {
        return 3;
    }
    return 0;
}

const num = (x) => (Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);
const amount = (text, word) => {
    const m = new RegExp(`\\b${word} (\\d+)`, 'i').exec(text);
    return m ? Number(m[1]) : 0;
};

const rows = new Map();
const texts = new Map();
for (const file of fs.readdirSync(cardDir).filter((f) => f.endsWith('.json')).sort()) {
    const c = JSON.parse(fs.readFileSync(path.join(cardDir, file), 'utf8'));
    const text = [c.text, c.deployBox, c.epicAction].filter(Boolean).join('\n');
    const low = text.toLowerCase();
    const kws = new Set((c.keywords ?? []).map((k) => k.toLowerCase()));
    let kw = 0;
    KW.forEach((k, i) => {
        if (kws.has(k)) {
            kw |= 1 << i;
        }
    });
    let fx = 0;
    FX.forEach(([, re], i) => {
        if (re.test(low)) {
            fx |= 1 << i;
        }
    });
    const dmg = [...low.matchAll(/deal (\d+) damage/g)].map((m) => Number(m[1]));
    const aspects = ASPECTS.map((a) => (c.aspects ?? []).filter((x) => x === a).length);
    const arena = c.arena === 'ground' ? 1 : c.arena === 'space' ? 2 : 0;
    const row = [
        kindOf(c.types), num(c.cost), num(c.power), num(c.hp), arena, ...aspects, kw,
        kws.has('raid') ? amount(text, 'raid') : 0, kws.has('restore') ? amount(text, 'restore') : 0,
        num(c.upgradePower), num(c.upgradeHp), c.unique ? 1 : 0, fx, dmg.length ? Math.max(...dmg) : 0
    ];
    for (const sc of c.setCodes ?? (c.setId ? [c.setId] : [])) {
        if (!sc || sc.number == null) {
            continue;
        }
        const code = `${sc.set}_${String(sc.number).padStart(3, '0')}`;
        if (!rows.has(code)) {
            rows.set(code, row);
            const title = ascii(c.subtitle ? `${c.title}, ${c.subtitle}` : c.title);
            const parts = [c.text, c.deployBox && `Deployed: ${c.deployBox}`, c.epicAction].filter(Boolean).map(ascii);
            texts.set(code, `${c.internalName ?? ''}\t${title}\t${parts.join(' / ')}`);
        }
    }
}

const lines = [...rows.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([code, r]) => [code, ...r].join('\t'));
fs.writeFileSync(out, lines.join('\n') + '\n');
const textLines = [...texts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([code, t]) => `${code}\t${t}`);
fs.writeFileSync(textOut, textLines.join('\n') + '\n');
console.error(`wrote ${lines.length} cards to ${path.relative(process.cwd(), out)}`);
