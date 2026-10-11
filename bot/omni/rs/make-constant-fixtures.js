'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Env } = require('../../env');
const { loadPool } = require('./pool');
const { fixture } = require('./make-phase-fixtures');
const summary = (c) => c.getSummary(c.controller, true);
const scenarios = [
    { name: 'veers-aura-source-leave-lethal', extraCodes: ['SOR_230', 'ASH_242'], ownCode: 'ASH_242', constant: { code: 'SOR_230', owner: 'own' }, initialOwnDamage: 4,
        plan: [['TWI_226', 'constant']],
        observeInitial: ({ targets }) => targets.own.zoneName === 'groundArena' && summary(targets.own).hp === 5 && summary(targets.own).power === 6 && summary(targets.constant).hp === targets.constant.cardData.hp,
        observeAfter: ({ targets }) => targets.constant.zoneName === 'hand' && targets.own.zoneName === 'discard' },
    { name: 'snoke-aura-source-bounce-restores', extraCodes: ['SHD_037'], constant: { code: 'SHD_037', owner: 'enemy' },
        plan: [['TWI_226', 'constant']],
        observeInitial: ({ targets }) => summary(targets.own).hp === 2 && summary(targets.own).power === 1,
        observeAfter: ({ targets }) => targets.constant.zoneName === 'hand' && summary(targets.own).hp === 4 && summary(targets.own).power === 3 },
    { name: 'snoke-entry-defeats-low-hp', extraCodes: ['SHD_037'], enemyCode: 'ASH_190', plan: [['SHD_037', 'own']],
        observeInitial: ({ targets }) => targets.own.zoneName === 'groundArena',
        observeAfter: ({ targets, own, enemy }) => targets.enemy.zoneName === 'discard' && own.getCardsInZone('groundArena').some((c) => c.internalName === 'supreme-leader-snoke#shadow-ruler') && enemy.getCardsInZone('groundArena').length === 0 },
    { name: 'scimitar-damage-enables-power', extraCodes: ['LOF_233'], constant: { code: 'LOF_233', owner: 'own' }, plan: [['TWI_170', 'constant']],
        observeInitial: ({ targets }) => targets.constant.damage === 0 && summary(targets.constant).power === targets.constant.cardData.power,
        observeAfter: ({ targets }) => targets.constant.damage === 2 && summary(targets.constant).power === targets.constant.cardData.power + 3 },
    ...[['IBH_002', 20], ['IBH_054', 20], ['JTL_031', 34]].map(([baseCode, hp]) => ({ name: `base-${baseCode}-${hp}-hp-terminal`, baseCode, terminalBase: true, plan: [['TWI_170', 'enemyBase']],
        observeInitial: ({ enemy }) => enemy.base.cardData.hp === hp && enemy.base.damage === hp - 1,
        observeAfter: ({ eg, enemy }) => eg.over && eg.winner === 'p1' && enemy.base.damage >= hp })),
];
async function main(args) {
    const [sourcePool, directory] = args;
    assert.ok(sourcePool && directory && args.length === 2, 'Usage: make-constant-fixtures.js POOL_JSON NEW_OUTPUT_DIRECTORY');
    assert.ok(!fs.existsSync(directory), 'Use a fresh output directory');
    fs.mkdirSync(directory, { recursive: true });
    const poolFile = path.join(directory, 'pool.json'); fs.copyFileSync(sourcePool, poolFile);
    const pool = loadPool(poolFile), env = new Env(), witnesses = [];
    for (const [i, scenario] of scenarios.entries()) {
        const { records, witness } = await fixture(env, pool, scenario, 9501 + i);
        const file = scenario.name + '.jsonl.gz';
        fs.writeFileSync(path.join(directory, file), zlib.gzipSync(records.map((r) => JSON.stringify(r)).join('\n') + '\n'));
        const sha256 = createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('hex');
        witnesses.push({ file, sha256, ...witness });
        console.log(`${file}: ${records.filter((r) => r.type === 'decision').length} decisions`);
    }
    fs.writeFileSync(path.join(directory, 'constant-witnesses.json'), JSON.stringify({ conformance: 'unassessed; run native and Wasm check', witnesses }, null, 2) + '\n');
}
if (require.main === module) main(process.argv.slice(2)).catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { scenarios };
