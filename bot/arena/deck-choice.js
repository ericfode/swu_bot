'use strict';
// Decks are data, never paths/URLs or programs. A choice is bound into arena.json before the v2 check/tar hash.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeDeck, checkDecks, engineLookups } = require('../decklists');
const SCHEMA = 'swu-arena-deck/1';
const CATALOG = path.join(__dirname, '..', 'decks', 'ash-meta-2026-09.json');
const SKIP = new Set(['lando-calrissian_law_blue']);
const plain = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const hash = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
function material(deck) {
    const d = normalizeDeck(deck);
    return { leader: d.leader, base: d.base, deck: d.deck.slice().sort((a, b) => a.id.localeCompare(b.id)) };
}
const digest = (deck) => hash(material(deck));
function catalog() {
    const raw = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
    return (Array.isArray(raw) ? raw : raw.decks).map(normalizeDeck).filter((d) => !SKIP.has(d.metadata.name));
}
function describe({ name } = {}) {
    if (name !== undefined) return { deck: selection(name) };
    return { decks: catalog().map((d) => ({ name: d.metadata.name, leader: d.leader.id, base: d.base.id,
        cards: d.deck.reduce((n, c) => n + c.count, 0) })),
    default: 'No deck argument: tournament pool dealt by seat. A selected deck stays with your immutable bot version in both seats.' };
}
function selection(value) {
    if (value === undefined || value === null) return null;
    let d = value;
    if (typeof value === 'string') {
        d = catalog().find((x) => x.metadata.name === value);
        if (!d) throw new Error(`deck: unknown catalog name ${JSON.stringify(value)}; use arena_decks`);
    }
    if (!plain(d) || Buffer.byteLength(JSON.stringify(d)) > 65536 || !Array.isArray(d.deck) || d.deck.length > 300) {
        throw new Error('deck: use an arena_decks name or one SWUDB object with leader, base and main deck (at most 64 KiB/300 entries)');
    }
    for (const [slot, c] of [['leader', d.leader], ['base', d.base], ...d.deck.map((c) => ['deck', c])]) {
        if (!plain(c) || typeof c.id !== 'string' || !/^[A-Za-z0-9_#-]{1,80}$/.test(c.id) ||
            (slot === 'deck' && (!Number.isSafeInteger(c.count) || c.count < 1 || c.count > 1000)) ||
            (slot !== 'deck' && c.count !== undefined && c.count !== 1)) throw new Error(`deck: invalid ${slot} card/count`);
    }
    if (d.sideboard !== undefined && (!Array.isArray(d.sideboard) || d.sideboard.length)) throw new Error('deck: submit the main deck only; sideboards are not played');
    if (d.secondleader != null) throw new Error('deck: this arena supports one leader; a second leader cannot be silently discarded');
    const out = normalizeDeck(d);
    if (!out.metadata.name || out.metadata.name.length > 120 || (out.metadata.style?.length ?? 0) > 80) throw new Error('deck: metadata name/style is too long');
    return out;
}
function validate(value, lookups) {
    const list = selection(value);
    if (!list) return null;
    const problems = checkDecks([list], lookups ?? engineLookups(new (require('../env').Env)()));
    if (problems.length) throw new Error(`deck: ${problems.join('; ')}`);
    return { schema: SCHEMA, sha256: digest(list), list };
}
function binding(value) {
    if (value === undefined || value === null) return null;
    if (!plain(value) || value.schema !== SCHEMA || !/^[a-f0-9]{64}$/.test(value.sha256 ?? '')) throw new Error('deck: invalid frozen deck binding');
    const list = selection(value.list);
    if (!list || digest(list) !== value.sha256) throw new Error('deck: frozen deck digest differs');
    return { schema: SCHEMA, sha256: value.sha256, list };
}
function prepareBundle(folder, requested, { lookups } = {}) {
    const file = path.join(folder, 'arena.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const before = binding(manifest.arenaDeck);
    const chosen = requested == null ? before : validate(requested, lookups);
    // Validate even a prebuilt declaration, but preserve its exact bytes when no choice is being changed.
    if (chosen && requested == null) validate(chosen.list, lookups);
    if (before && requested != null && before.sha256 !== chosen.sha256) throw new Error('deck: request conflicts with arena.json.arenaDeck; build a bundle with the intended choice');
    if (chosen && !before) {
        manifest.arenaDeck = chosen;
        fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
    }
    return chosen;
}
function verifyRequested(folder, requested) {
    const chosen = binding(JSON.parse(fs.readFileSync(path.join(folder, 'arena.json'), 'utf8')).arenaDeck);
    const expected = selection(requested);
    if (expected && (!chosen || digest(expected) !== chosen.sha256)) throw new Error('deck: checked bundle does not contain the requested deck');
    return chosen;
}
function versionChoice(version) {
    const home = require('./home');
    const dir = path.join(home.VERSIONS, version);
    const meta = home.readJson(path.join(dir, 'SUBMISSION.json'), {});
    // Do not reinterpret/backfill an existing admission that predates this feature.
    if (meta.deck === undefined) return null;
    const chosen = binding(meta.deck);
    const declared = binding(JSON.parse(fs.readFileSync(path.join(dir, 'bundle', 'arena.json'), 'utf8')).arenaDeck);
    if (!chosen || !declared || JSON.stringify(chosen) !== JSON.stringify(declared)) throw new Error(`deck: ${version} admission differs from its frozen manifest`);
    return chosen;
}
function withChoices(base, choices) {
    const selected = Object.entries(choices).filter(([, d]) => d != null).map(([n, d]) => [n, binding(d)]);
    if (!selected.length) return base;
    if (!base || !Array.isArray(base.lists) || base.lists.length < 2) throw new Error('deck: no default deck pool');
    const out = { ...base, names: [...base.names], lists: structuredClone(base.lists), poolSize: base.lists.length, choices: {} };
    for (const [version, d] of selected) {
        let i = out.lists.findIndex((x) => JSON.stringify(x) === JSON.stringify(d.list));
        if (i < 0) {
            // A unique display label keeps different builders' custom lists distinct in deck statistics.
            const list = structuredClone(d.list);
            list.metadata.name = `${list.metadata.name} [${version}]`;
            i = out.lists.length; out.lists.push(list); out.names.push(list.metadata.name);
        }
        out.choices[version] = i;
    }
    return out;
}
function checkChoices(decks, bots) {
    if (decks?.choices === undefined) return;
    if (!plain(decks.choices) || !Array.isArray(decks.lists) || !Number.isSafeInteger(decks.poolSize) || decks.poolSize < 2 || decks.poolSize > decks.lists.length) throw new Error('deck: invalid per-version choices');
    for (const [n, i] of Object.entries(decks.choices)) {
        if (!bots.includes(n) || !Number.isSafeInteger(i) || i < 0 || i >= decks.lists.length) throw new Error('deck: choice does not name a scheduled version and valid list');
    }
}
module.exports = { SCHEMA, catalog, describe, selection, validate, binding, digest, prepareBundle, verifyRequested, versionChoice, withChoices, checkChoices };
