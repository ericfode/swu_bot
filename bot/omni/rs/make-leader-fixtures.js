'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { Env } = require('../../env');
const { loadPool } = require('./pool');
const { fixture } = require('./make-phase-fixtures');
const scenarios = [
    { name: 'kanan-shield-and-creature-aura', leaderCode: 'LOF_004', extraCodes: ['ASH_131'], ownCode: 'ASH_131',
        plan: [['LOF_004', 'own', 'leaderAction'], ['LOF_004', 'own', 'deploy']],
        observeInitial: ({ own, targets }) => !own.getAllDeckLeaders()[0].deployed && targets.own.upgrades.length === 0,
        observeAfter: ({ own, targets }) => { const l = own.getAllDeckLeaders()[0]; return l.deployed && l.getPower() === 5 && l.getSummary(own, true).hp === 8 && l.upgrades.some((c) => c.internalName === 'shield') && targets.own.upgrades.some((c) => c.internalName === 'shield'); } },
    { name: 'c3po-action-and-on-attack', leaderCode: 'SEC_015', exhaustedOwn: true,
        plan: [['SEC_015', 'enemy', 'leaderAction'], ['SEC_015', 'own', 'deploy'], ['SEC_015', 'enemy', 'attack']],
        observeInitial: ({ own, targets }) => !own.getAllDeckLeaders()[0].deployed && targets.own.exhausted && !targets.enemy.exhausted,
        observeAfter: ({ own, targets }) => own.getAllDeckLeaders()[0].deployed && own.getAllDeckLeaders()[0].exhausted && targets.enemy.exhausted && targets.enemy.damage === 1 },
];
async function main(args) {
    const [sourcePool, directory] = args;
    assert.ok(args.length === 2, 'Usage: make-leader-fixtures.js POOL_JSON NEW_OUTPUT_DIRECTORY');
    assert.ok(!fs.existsSync(directory), 'Use a fresh output directory'); fs.mkdirSync(directory, { recursive: true });
    const poolFile = path.join(directory, 'pool.json'); fs.copyFileSync(sourcePool, poolFile);
    const pool = loadPool(poolFile), env = new Env(), witnesses = [];
    for (const [i, scenario] of scenarios.entries()) {
        const { records, witness } = await fixture(env, pool, scenario, 9901 + i);
        const file = scenario.name + '.jsonl.gz'; fs.writeFileSync(path.join(directory, file), zlib.gzipSync(records.map((r) => JSON.stringify(r)).join('\n') + '\n'));
        witnesses.push({ file, ...witness }); console.log(`${file}: ${records.filter((r) => r.type === 'decision').length} decisions`);
    }
    fs.writeFileSync(path.join(directory, 'leader-witnesses.json'), JSON.stringify({ conformance: 'unassessed; run native and Wasm check', witnesses }, null, 2) + '\n');
}
if (require.main === module) main(process.argv.slice(2)).catch((error) => { console.error(error); process.exitCode = 1; });
