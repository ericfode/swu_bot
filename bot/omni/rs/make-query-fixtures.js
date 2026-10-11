'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Env } = require('../../env');
const { loadPool } = require('./pool');
const { fixture } = require('./make-phase-fixtures');
const { phaseStats } = require('./state');
const scenarios = [
    { name: 'outer-target-power-and-other-than', extraCodes: ['ASH_115', 'ASH_201'], ownCode: 'ASH_061', extraOwnUnits: ['ASH_261', 'ASH_201'], plan: [['ASH_115', 'own']],
        observeInitial: ({ targets }) => targets.own.getPower() === 5,
        observeAfter: ({ targets }) => phaseStats(targets.own).phaseStats?.power === 2 && targets.own.getPower() === 7 },
    { name: 'target-arena-filter-mixed-board', extraCodes: ['TWI_099', 'ASH_201'], extraOwnUnits: ['ASH_201'], plan: [['TWI_099', 'enemy']],
        observeInitial: ({ own, targets }) => own.getCardsInZone('groundArena').length === 1 && own.getCardsInZone('spaceArena').length === 1 && targets.enemy.damage === 0,
        observeAfter: ({ targets }) => targets.enemy.damage === 1 },
    { name: 'simultaneous-phase-expiry-aura-deaths', extraCodes: ['SHD_037'], constant: { code: 'SHD_037', owner: 'own' }, initialConstantDamage: 3,
        plan: [['TWI_124', 'constant'], ['TWI_124', 'enemy'], ['TWI_174', 'constant'], ['TWI_174', 'enemy']],
        observeInitial: ({ targets }) => targets.constant.zoneName === 'groundArena' && targets.enemy.zoneName === 'groundArena',
        observeAfter: ({ targets }) => targets.constant.zoneName === 'groundArena' && targets.constant.damage === 7 && targets.enemy.zoneName === 'groundArena' && targets.enemy.damage === 4,
        observeLater: ({ targets }) => targets.constant.zoneName === 'discard' && targets.enemy.zoneName === 'discard' },
    { name: 'conditional-select-air-superiority', extraCodes: ['JTL_125', 'ASH_201'], extraOwnUnits: ['ASH_201'], plan: [['JTL_125', 'enemy']],
        observeInitial: ({ own, enemy }) => own.getCardsInZone('spaceArena').length > enemy.getCardsInZone('spaceArena').length,
        observeAfter: ({ targets }) => targets.enemy.damage === 4 },
    { name: 'conditional-select-ruthless-duo', extraCodes: ['LAW_137', 'ASH_242'], ownCode: 'ASH_242', plan: [['LAW_137', 'enemy']],
        observeInitial: ({ targets }) => targets.own.cardData.aspects.includes('villainy'),
        observeAfter: ({ targets }) => targets.enemy.damage === 2 },
    { name: 'conditional-sequential-select-ewoks', extraCodes: ['HMW_177', 'HMW_116'], ownCode: 'HMW_116', plan: [['HMW_177', 'enemy']],
        observeInitial: ({ targets }) => targets.own.cardData.traits.includes('ewok'),
        observeAfter: ({ own, enemy, targets }) => own.base.damage + enemy.base.damage === 49 && targets.enemy.damage === 1 },
    { name: 'on-attack-conditional-select-r2d2', extraCodes: ['IBH_011', 'HMW_116'], ownCode: 'HMW_116', enemyCode: 'ASH_261', constant: { code: 'IBH_011', owner: 'own' },
        plan: [['IBH_011', 'enemy', 'attack']],
        observeInitial: ({ targets }) => targets.own.cardData.aspects.includes('command') && !targets.enemy.exhausted,
        observeAfter: ({ targets }) => targets.enemy.exhausted && targets.enemy.damage === 1 },
    { name: 'conditional-select-no-enemy-target', extraCodes: ['JTL_125', 'ASH_201'], extraOwnUnits: ['ASH_201'], noEnemyUnits: true, expectedPlayed: 'JTL_125', plan: [['JTL_125', 'enemy']],
        observeInitial: ({ own, enemy }) => own.getCardsInZone('spaceArena').length === 1 && enemy.getCardsInZone('groundArena').length === 0,
        observeAfter: ({ own, enemy }) => own.getCardsInZone('discard').some((c) => c.internalName === 'air-superiority') && enemy.getCardsInZone('groundArena').length === 0 && enemy.base.damage === 24 },
    { name: 'conditional-select-optional-decline', extraCodes: ['LAW_137', 'ASH_242'], ownCode: 'ASH_242', decline: true, expectedPlayed: 'LAW_137', required: 'decline', plan: [['LAW_137', 'enemy']],
        observeInitial: ({ targets }) => targets.own.cardData.aspects.includes('villainy') && targets.enemy.damage === 0,
        observeAfter: ({ targets, own }) => targets.enemy.damage === 0 && own.getCardsInZone('groundArena').some((c) => c.internalName === 'ruthless-duo') },
];
async function main(args) {
    const [sourcePool, directory] = args;
    assert.ok(args.length === 2, 'Usage: make-query-fixtures.js POOL_JSON NEW_OUTPUT_DIRECTORY');
    assert.ok(!fs.existsSync(directory), 'Use a fresh output directory');
    fs.mkdirSync(directory, { recursive: true });
    const poolFile = path.join(directory, 'pool.json'); fs.copyFileSync(sourcePool, poolFile);
    const pool = loadPool(poolFile), env = new Env(), witnesses = [];
    for (const [i, scenario] of scenarios.entries()) {
        const { records, witness } = await fixture(env, pool, scenario, 9801 + i);
        if (scenario.observeLater) {
            const initial = records.find((r) => r.type === 'state').state.round;
            assert.ok(records.some((r) => r.type === 'state' && r.state.round > initial &&
                r.state.players.p1.discard.some((c) => c.setCode === 'SHD_037') && r.state.players.p2.discard.some((c) => c.setCode === 'ASH_061')), 'Missing both-expiry-deaths receipt');
        }
        const file = scenario.name + '.jsonl.gz', bytes = zlib.gzipSync(records.map((r) => JSON.stringify(r)).join('\n') + '\n');
        fs.writeFileSync(path.join(directory, file), bytes);
        witnesses.push({ file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), ...witness });
        console.log(`${file}: ${records.filter((r) => r.type === 'decision').length} decisions`);
    }
    fs.writeFileSync(path.join(directory, 'query-witnesses.json'), JSON.stringify({ conformance: 'unassessed; run native and Wasm check', witnesses }, null, 2) + '\n');
}
if (require.main === module) main(process.argv.slice(2)).catch((error) => { console.error(error); process.exitCode = 1; });
