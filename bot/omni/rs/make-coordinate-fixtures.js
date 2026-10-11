'use strict';
// Pinned-engine Coordinate family witnesses; generation is not admission/conformance.
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { Env } = require('../../env'), { loadPool } = require('./pool'), { canonicalAction } = require('./state'), { fixture } = require('./make-group-fixtures');
const unit = (key, code, owner = 'own', damage = 0) => ({ key, code, owner, damage });
const card = (c, u) => c.actions.find(a => a.cardUuid === u.uuid);
const scenarios = [];
scenarios.push({ name: 'echo-coordinate-live-two-three-two', family: 'coordinate-constant-stats', units: [unit('source', 'TWI_090'), unit('other', 'HMW_082'), unit('enemy', 'ASH_261', 'enemy')], baseDamage: 0, plan: [{ code: 'ASH_261' }, { code: 'TWI_226' }], beforeApply: c => {
        if (!c.observed.postAction && c.atWindow && c.pid === c.own.id && c.chosen.kind === 'card' && c.pending?.code === 'ASH_261') {
            assert.equal(c.targets.source.getHp(), 2);
            assert.equal(c.targets.source.getPower(), 2);
            c.scratch.third = c.scratch.incoming;
            c.observed.initialTwoInactive = true;
        }
        if (!c.observed.postAction && c.atWindow && c.pid === c.own.id && c.chosen.kind === 'card' && c.pending?.code === 'TWI_226') {
            assert.equal(c.targets.source.getHp(), 4);
            assert.equal(c.targets.source.getPower(), 4);
            c.observed.thirdActivated = true;
        }
    }, choose: c => card(c, c.scratch.third), assertAfter: c => { assert.equal(c.targets.source.getHp(), 2); assert.equal(c.targets.source.getPower(), 2); assert.equal(c.scratch.third.zoneName, 'hand'); assert.ok(c.observed.initialTwoInactive && c.observed.thirdActivated); c.observed.returnRemovedGate = true; } });
for (const third of [false, true])
    scenarios.push({ name: 'coruscant-guard-incoming-' + (third ? 'third-ambush' : 'second-no-ambush'), family: 'coordinate-incoming-keyword', units: [unit('other', 'HMW_082'), ...(third ? [unit('second', 'ASH_261')] : []), unit('enemy', 'HMW_082', 'enemy')], baseDamage: 0, plan: [{ code: 'TWI_106' }], choose: c => {
            const title = c.eg.player(c.pid).currentPrompt().menuTitle;
            c.observed.menus ??= [];
            c.observed.menus.push({ title, actions: c.actions.map(a => canonicalAction(c.eg, a)) });
            if (title === 'You may trigger this ability') {
                assert.deepEqual(c.actions.map(a => [a.kind, a.arg, a.label]), [['button', 'trigger', 'Trigger'], ['button', 'pass', 'Pass']]);
                c.observed.ambushOffered = true;
                return c.actions.find(a => a.arg === 'trigger');
            }
            return card(c, c.targets.enemy);
        }, assertAfter: c => { assert.equal(c.targets.enemy.damage, third ? 3 : 0); assert.equal(c.scratch.incoming.damage, third ? 1 : 0); assert.equal(c.scratch.incoming.hasSomeKeyword('ambush'), third); assert.equal(!!c.observed.ambushOffered, third); assert.equal(c.scratch.incoming.exhausted, true); } });
scenarios.push({ name: 'cody-aura-loss-complete-lethal-set', family: 'coordinate-aura-hp-loss', units: [unit('source', 'TWI_114'), unit('ant', 'ASH_116', 'own', 2), unit('plain', 'ASH_261', 'own', 4), unit('enemy', 'ASH_261', 'enemy')], baseDamage: 0, plan: [{ code: 'TWI_226', target: 'source' }], beforeApply: c => {
        if (!c.observed.postAction && c.atWindow && c.pid === c.own.id && c.chosen.kind === 'card') {
            assert.equal(c.targets.ant.getHp(), 3);
            assert.equal(c.targets.plain.getHp(), 5);
            assert.equal(c.targets.source.getHp(), 4);
            assert.equal(c.targets.enemy.getHp(), 4);
            assert.ok(c.targets.ant.hasSomeKeyword('overwhelm'));
            assert.equal(c.targets.enemy.hasSomeKeyword('overwhelm'), false);
            c.scratch.hand = c.own.getCardsInZone('hand').length;
            c.observed.auraActiveBeforeRemoval = true;
        }
    }, assertAfter: c => { assert.equal(c.targets.source.zoneName, 'hand'); assert.equal(c.targets.ant.zoneName, 'discard'); assert.equal(c.targets.plain.zoneName, 'discard'); assert.equal(c.own.getCardsInZone('hand').length, c.scratch.hand + 1); assert.ok(c.observed.auraActiveBeforeRemoval); c.observed.bothHpLossVictimsDefeated = true; } });
for (const active of [false, true])
    scenarios.push({ name: 'anakin-coordinate-attack-' + (active ? 'three-draw' : 'two-no-draw'), family: 'coordinate-trigger', units: [unit('source', 'TWI_147'), unit('other', 'HMW_082'), ...(active ? [unit('third', 'ASH_261')] : []), unit('enemy', 'HMW_082', 'enemy')], baseDamage: 0, plan: [{ from: 'source', code: 'TWI_147' }], beforeApply: c => {
            if (!c.observed.postAction && c.atWindow && c.pid === c.own.id && c.chosen.kind === 'card') {
                c.scratch.hand = c.own.getCardsInZone('hand').length;
                c.scratch.top = c.eg.cardId(c.own.drawDeck[0].uuid);
            }
        }, choose: c => card(c, c.enemy.base), assertAfter: c => {
            assert.equal(c.own.getCardsInZone('hand').length, c.scratch.hand + (active ? 1 : 0));
            assert.equal(c.enemy.base.damage, 6);
            if (active)
                assert.ok(c.own.getCardsInZone('hand').some(x => c.eg.cardId(x.uuid) === c.scratch.top));
            c.observed.coordinateAttackDraw = active;
        } });
for (const decline of [false, true])
    scenarios.push({ name: 'kit-fisto-coordinate-attack-' + (decline ? 'pass' : 'damage'), family: 'coordinate-optional-trigger', units: [unit('source', 'TWI_165'), unit('other', 'HMW_082'), unit('third', 'ASH_261'), unit('enemy', 'ASH_061', 'enemy')], baseDamage: 0, plan: [{ from: 'source', code: 'TWI_165' }], choose: c => {
            const title = c.eg.player(c.pid).currentPrompt().menuTitle;
            if (title === 'Choose a target for attack')
                return card(c, c.enemy.base);
            assert.equal(title, 'Deal 3 damage to a ground unit');
            assert.ok(c.actions.some(a => a.arg === 'passAbility'));
            assert.ok(c.actions.some(a => a.cardUuid === c.targets.source.uuid));
            assert.ok(c.actions.some(a => a.cardUuid === c.targets.enemy.uuid));
            c.observed.optionalGroundMenu = true;
            return decline ? c.actions.find(a => a.arg === 'passAbility') : card(c, c.targets.enemy);
        }, assertAfter: c => { assert.ok(c.observed.optionalGroundMenu); assert.equal(c.targets.enemy.damage, decline ? 0 : 3); assert.equal(c.enemy.base.damage, 7); } });
scenarios.push({ name: 'coordinate-two-self-hp-bonuses-lost-complete-lethal-set', family: 'coordinate-constant-hp-loss', units: [unit('source', 'TWI_090', 'own', 2), unit('corps', 'TWI_045', 'own', 3), unit('third', 'ASH_261')], baseDamage: 0, plan: [{ code: 'TWI_226', target: 'third' }], beforeApply: c => {
        if (!c.observed.postAction && c.atWindow && c.pid === c.own.id && c.chosen.kind === 'card') {
            assert.equal(c.targets.source.getHp(), 4);
            assert.equal(c.targets.corps.getHp(), 6);
            c.observed.bothAliveWithGate = true;
        }
    }, assertAfter: c => { assert.equal(c.targets.third.zoneName, 'hand'); assert.equal(c.targets.source.zoneName, 'discard'); assert.equal(c.targets.corps.zoneName, 'discard'); assert.ok(c.observed.bothAliveWithGate); } });
scenarios.push({ name: 'SYNTHETIC-coordinate-captured-attack-survives-gate-loss', family: 'SYNTHETIC-coordinate-trigger-capture-diagnostic', diagnosticOnly: true, units: [unit('source', 'TWI_147'), unit('other', 'HMW_082'), unit('third', 'ASH_261')], baseDamage: 0, plan: [{ from: 'source', code: 'TWI_147' }], beforeApply: c => {
        if (!c.scratch.registered && c.atWindow && c.pid === c.own.id && c.chosen.kind === 'card') {
            const helper = require('../../../forceteki/build/server/game/AbilityHelper').getAbilityHelper(c.eg.game);
            c.targets.source.addGainedTriggeredAbility({ title: 'SYNTHETIC defeat third friendly unit before Coordinate draw', when: { onAttack: true }, immediateEffect: helper.immediateEffects.defeat({ target: c.targets.third }) });
            c.scratch.registered = true;
            c.scratch.hand = c.own.getCardsInZone('hand').length;
            c.scratch.top = c.eg.cardId(c.own.drawDeck[0].uuid);
        }
    }, choose: c => {
        const title = c.eg.player(c.pid).currentPrompt().menuTitle;
        c.observed.menus ??= [];
        c.observed.menus.push({ title, actions: c.actions.map(a => canonicalAction(c.eg, a)) });
        if (title === 'Choose a target for attack')
            return card(c, c.enemy.base);
        return c.actions.find(a => a.label === 'SYNTHETIC defeat third friendly unit before Coordinate draw');
    }, assertAfter: c => { assert.equal(c.targets.third.zoneName, 'discard'); assert.equal(c.own.getCardsInZone('hand').length, c.scratch.hand + 1); assert.ok(c.own.getCardsInZone('hand').some(x => c.eg.cardId(x.uuid) === c.scratch.top)); c.observed.capturedDrawResolvedAtTwoUnits = true; } });
for (const active of [false, true])
    scenarios.push({ name: 'coordinate-sentinel-' + (active ? 'three-blocks-base-and-other-unit' : 'two-allows-base'), family: 'coordinate-constant-keyword-targeting', actualScriptedCardIds: ['TWI_061'], units: [unit('attacker', 'ASH_261'), unit('sentinel', 'TWI_061', 'enemy'), unit('other', 'HMW_082', 'enemy'), ...(active ? [unit('spaceCount', 'JTL_212', 'enemy')] : [])], baseDamage: 0, plan: [{ from: 'attacker', code: 'ASH_261' }], choose: c => { assert.equal(c.eg.player(c.pid).currentPrompt().menuTitle, 'Choose a target for attack'); assert.equal(c.targets.sentinel.hasSomeKeyword('sentinel'), active); const targets = c.actions.filter(a => a.kind === 'card').map(a => a.cardUuid).sort(); assert.deepEqual(targets, (active ? [c.targets.sentinel.uuid] : [c.targets.sentinel.uuid, c.targets.other.uuid, c.enemy.base.uuid]).sort()); c.observed.exactSentinelTargetMenu = true; return c.actions.find(a => a.cardUuid === (active ? c.targets.sentinel : c.enemy.base).uuid); }, assertAfter: c => { assert.ok(c.observed.exactSentinelTargetMenu); assert.equal(c.enemy.base.damage, active ? 0 : 3); assert.equal(c.targets.sentinel.damage, active ? 3 : 0); assert.equal(c.targets.attacker.damage, active ? 2 : 0); } });
async function main([poolFile, out, filter]) {
    assert.ok(poolFile && out);
    assert.ok(!fs.existsSync(out));
    fs.mkdirSync(out, { recursive: true });
    fs.copyFileSync(poolFile, path.join(out, 'pool.json'));
    const pool = loadPool(path.join(out, 'pool.json')), env = new Env(), witnesses = [];
    for (const [i, s] of scenarios.entries()) {
        if (s.diagnosticOnly && !filter)
            continue;
        if (filter && !s.name.includes(filter))
            continue;
        const r = await fixture(env, pool, s, 19001 + i);
        if (s.diagnosticOnly) {
            r.records[0].evidenceStatus = 'SYNTHETIC ENGINE REGISTRATION TIMING DIAGNOSTIC; not an actual printed-card witness or native/Wasm admission';
            r.records[0].syntheticRegistration = 'Initial action boundary: real Anakin gains a second onAttack ability that explicitly defeats third friendly unit. Resolve synthetic defeat before captured printed Coordinate draw.';
        }
        const file = s.name + '.jsonl.gz', bytes = zlib.gzipSync(r.records.map(x => JSON.stringify(x)).join('\n') + '\n');
        fs.writeFileSync(path.join(out, file), bytes);
        witnesses.push({ ...r.witness, file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), actualScriptedCardIds: s.diagnosticOnly ? [] : s.actualScriptedCardIds ?? (s.name.startsWith('echo') ? ['TWI_090'] : s.name.startsWith('coruscant') ? ['TWI_106'] : s.name.startsWith('cody') ? ['TWI_114', 'ASH_116'] : s.name.startsWith('anakin') ? ['TWI_147'] : s.name.startsWith('kit') ? ['TWI_165'] : s.name.startsWith('coordinate-two-self') ? ['TWI_090', 'TWI_045'] : []), sharedRelatedCardIds: [], synthetic: !!s.diagnosticOnly });
        fs.writeFileSync(path.join(out, 'coordinate-witnesses.json'), JSON.stringify({ evidenceStatus: pool.oracleOnly ? 'PROTOTYPE real engine' : 'real engine observations', conformance: 'unassessed; fresh native and Wasm comparison required', pool: pool.provenance, generatorSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'), witnesses }, null, 2) + '\n');
        console.log(s.name);
    }
}
if (require.main === module)
    main(process.argv.slice(2)).catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { main, scenarios };
