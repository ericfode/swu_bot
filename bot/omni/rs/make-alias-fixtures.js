'use strict';
const path = require('node:path'), fs = require('node:fs'), zlib = require('node:zlib'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { Env } = require('../../env'), { loadPool } = require('./pool'), { fixture } = require('./make-group-fixtures');
const scenarios = [];
for (const hook of ['play', 'attack'])
    for (const mode of ['heal', 'pass', 'no-effect'])
        scenarios.push({ name: 'rho-medical-shuttle-alias-' + hook + '-' + mode, family: 'standard-when-alias', baseDamage: mode === 'no-effect' ? 0 : 3, units: hook === 'attack' ? [{ key: 'source', code: 'HMW_063', owner: 'own' }] : [], plan: [hook === 'attack' ? { from: 'source', code: 'HMW_063' } : { code: 'HMW_063' }], choose: c => { const title = c.eg.player(c.pid).currentPrompt().menuTitle; if (title === 'Choose a target for attack')
                return c.actions.find(a => a.cardUuid === c.enemy.base.uuid); if (title === 'Heal 1 damage from another unit or base') {
                assert.ok(!c.actions.some(a => a.cardUuid === c.scratch.incoming.uuid));
                assert.ok(c.actions.some(a => a.arg === 'passAbility'));
                c.observed.aliasHealPrompt = true;
                return c.actions.find(a => mode === 'pass' ? a.arg === 'passAbility' : a.cardUuid === c.own.base.uuid);
            } }, assertAfter: c => { assert.equal(c.own.base.damage, mode === 'heal' ? 2 : mode === 'pass' ? 3 : 0); c.observed.actualScriptedCard = 'HMW_063 Rho Medical Shuttle'; c.observed.actualScriptedEffect = 'Heal 1 damage from another unit or base via ' + hook; if (mode === 'no-effect')
                assert.ok(!c.observed.aliasHealPrompt);
            else
                assert.ok(c.observed.aliasHealPrompt); } });
async function main([poolFile, out]) { assert.ok(poolFile && out); assert.ok(!fs.existsSync(out)); fs.mkdirSync(out, { recursive: true }); fs.copyFileSync(poolFile, path.join(out, 'pool.json')); const pool = loadPool(path.join(out, 'pool.json')), env = new Env(), w = []; for (const [i, s] of scenarios.entries()) {
    const r = await fixture(env, pool, s, 18501 + i), file = s.name + '.jsonl.gz';
    fs.writeFileSync(path.join(out, file), zlib.gzipSync(r.records.map(x => JSON.stringify(x)).join('\n') + '\n'));
    w.push({ ...r.witness, file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(out, file))).digest('hex'), actualScriptedCardIds: ['HMW_063'], sharedRelatedCardIds: [], synthetic: false });
    console.log(s.name);
} fs.writeFileSync(path.join(out, 'alias-witnesses.json'), JSON.stringify({ conformance: 'unassessed', pool: pool.provenance, generatorSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'), witnesses: w }, null, 2) + '\n'); }
if (require.main === module)
    main(process.argv.slice(2)).catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { main, scenarios };
