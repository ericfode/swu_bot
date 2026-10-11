'use strict';
const fs = require('fs');
const path = require('path');
const ALLOWED = new Set(['sentinel', 'raid', 'overwhelm', 'saboteur', 'restore', 'ambush', 'grit', 'shielded']);
const LEADERS = ['SOR_014', 'IBH_053', 'SEC_005'];
const code = (c) => c.setId.number == null ? 'TOKEN_SHIELD' : `${c.setId.set}_${String(c.setId.number).padStart(3, '0')}`;

/** Whitelist the whole text, not just its first keyword or the data's keyword tags. */
function parseKeywords(c) {
    if (c.pilotText || (c.keywords ?? []).some((k) => !ALLOWED.has(k))) return null;
    const text = (c.text ?? '').replace(/\([^)]*\)/g, '').trim();
    if (!text) return {};
    const out = {};
    for (const line of text.split(/\n|,/).map((s) => s.trim()).filter(Boolean)) {
        const m = /^(Sentinel|Raid|Overwhelm|Saboteur|Restore|Ambush|Grit|Shielded)(?:\s+(\d+))?\.?$/i.exec(line);
        if (!m) return null;
        const k = m[1].toLowerCase();
        if ((k === 'raid' || k === 'restore') !== (m[2] !== undefined)) return null;
        out[k] = m[2] ? Number(m[2]) : 1;
    }
    return out;
}
function main() {
    const { Env } = require('../../env');
    const env = new Env();
    const all = env.cardDataGetter.cardIds.map((id) => env.cardDataGetter.getCardSync(id))
        .filter((c) => !env.mockNames.has(c.internalName) && env.isImplemented(c));
    const leaders = LEADERS.map((s) => {
        const c = all.find((c) => code(c) === s && c.types.includes('leader'));
        if (!c) throw new Error(`Required leader missing: ${s}`);
        return c;
    });
    const bases = [];
    for (const aspect of ['vigilance', 'command', 'aggression', 'cunning']) {
        bases.push(...all.filter((c) => c.types.includes('base') && c.hp === 30 && !c.text && !c.epicAction && c.aspects.length === 1 && c.aspects[0] === aspect).sort((a, b) => code(a).localeCompare(code(b))).slice(0, 2));
    }
    const units = all.filter((c) => c.types.includes('unit') && !c.types.includes('token') && parseKeywords(c) !== null && c.setId.number != null)
        .sort((a, b) => code(a).localeCompare(code(b)));
    // Neutral cards guarantee all leader/base combinations can form fifty cards without aspect penalties.
    const selected = units.filter((c) => !c.aspects.length).slice(0, 18);
    for (const keyword of ALLOWED) {
        const c = units.find((u) => parseKeywords(u)[keyword] && !selected.includes(u));
        if (c) selected.push(c);
    }
    for (const c of units) {
        if (selected.length >= 88) break;
        if (!selected.includes(c)) selected.push(c);
    }
    const shield = all.find((c) => c.internalName === 'shield');
    if (!shield) throw new Error('Shield token missing');
    const cards = [...bases, ...leaders, ...selected, shield].map((c) => ({
        ...c, setCode: code(c), keywordValues: c.types.includes('unit') ? parseKeywords(c) : {},
        reason: c.types.includes('base') ? 'Plain 30 HP base without abilities.' : c.types.includes('leader') ? 'Explicitly implemented leader and deployed side.' : c.internalName === 'shield' ? 'Shield token needed by Shielded.' : Object.keys(parseKeywords(c)).length ? `Keywords only: ${Object.entries(parseKeywords(c)).map(([k, v]) => `${k}${v > 1 ? ` ${v}` : ''}`).join(', ')}.` : 'Unit without rules text.'
    }));
    for (const l of leaders) for (const b of bases) {
        const icons = new Set([...l.aspects, ...b.aspects]);
        const capacity = selected.filter((c) => c.aspects.every((a) => icons.has(a))).reduce((n, c) => n + (c.unique ? 1 : 3), 0);
        if (capacity < 50) throw new Error(`Pool cannot fill ${code(l)}/${code(b)}: ${capacity} cards`);
    }
    const pool = { schema: 'omni-rs-pool-v1', description: 'Strict keyword-unit subset with three explicit leader implementations.', excluded: ['non-keyword unit text', 'events', 'non-token upgrades', 'Piloting', 'Bounty', 'Smuggle', 'Exploit', 'Coordinate', 'random effects', 'shuffle effects', 'capture', 'control changes', 'lasting effects'], cards };
    const file = process.argv[2] || path.join(__dirname, 'pool.json');
    fs.writeFileSync(file, JSON.stringify(pool, null, 2) + '\n');
    console.log(`${cards.length} cards (${bases.length} bases, ${leaders.length} leaders, ${selected.length} units, Shield): ${file}`);
}
if (require.main === module) main();
module.exports = { parseKeywords };
