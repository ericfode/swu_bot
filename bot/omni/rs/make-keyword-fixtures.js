'use strict';
// Reuses the disclosed real-card starting-position constructor. Each callback
// must observe the intended semantic change; all later actions are normal inputs.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Env } = require('../../env');
const { loadPool } = require('./pool');
const { fixture } = require('./make-phase-fixtures');
const { phaseStats } = require('./state');
const keyword = (card, name) => card.hasSomeKeyword(name);
const scenarios = [
    { name: 'phase-sentinel-expiry', family: 'phase-sentinel', extraCodes: ['JTL_229'], plan: [['JTL_229', 'own']],
        observeInitial: ({ targets }) => !keyword(targets.own, 'sentinel'),
        observeAfter: ({ targets }) => keyword(targets.own, 'sentinel') && phaseStats(targets.own).phaseKeywords?.sentinel === 1,
        observeLater: ({ targets }) => !keyword(targets.own, 'sentinel') && !phaseStats(targets.own).phaseKeywords },
    { name: 'phase-sentinel-bounce-cleanup', family: 'phase-sentinel', extraCodes: ['JTL_229'], plan: [['JTL_229', 'own'], ['TWI_226', 'own']],
        observeAfter: ({ targets }) => targets.own.zoneName === 'hand' && !phaseStats(targets.own).phaseKeywords },
    { name: 'phase-raid-printed-aggregation-combat-expiry', family: 'phase-raid', extraCodes: ['LAW_182','HMW_052','HMW_082'], enemyCode: 'HMW_082', constant: { code: 'HMW_052', owner: 'own' }, extraOwnUnits:['LAW_182'],
        plan: [['LAW_182', 'constant', 'attack'], ['HMW_052', 'enemy', 'attack']],
        chooseAction: ({pid,own,enemy,actions,targets,atWindow,index}) => {
            if(pid !== own.id) return;
            if(atWindow && index === 1) return actions.find((a)=>a.cardUuid===own.getArenaUnits().find((c)=>c.internalName==='weazel#fighting-back')?.uuid);
            if(!atWindow && index === 1 && own.currentPrompt().menuTitle === 'Choose a target for attack') return actions.find((a)=>a.cardUuid===enemy.base.uuid);
        },
        observeAfter: ({ targets }) => targets.constant.zoneName === 'groundArena' && targets.enemy.damage === 4 && phaseStats(targets.constant).phaseKeywords?.raid === 2,
        observeLater: ({ targets }) => !phaseStats(targets.constant).phaseKeywords },
    { name: 'phase-restore-printed-aggregation', family: 'phase-restore', extraCodes: ['SEC_045', 'ASH_076'], constant: { code: 'ASH_076', owner: 'own' },extraOwnUnits:['SEC_045'],
        plan: [['SEC_045','constant','attack'], ['ASH_076','enemyBase','attack']],
        chooseAction: ({pid,own,enemy,actions,atWindow,index}) => {
            if(pid !== own.id) return;
            if(atWindow && index === 1) return actions.find((a)=>a.cardUuid===own.getArenaUnits().find((c)=>c.internalName==='senator-chuchi#voice-for-the-voiceless')?.uuid);
            if(!atWindow && index === 1 && own.currentPrompt().menuTitle === 'Choose a target for attack') return actions.find((a)=>a.cardUuid===enemy.base.uuid);
        },
        observeAfter: ({ targets, own }) => phaseStats(targets.constant).phaseKeywords?.restore === 2 && own.base.damage === 19 },
    { name: 'constant-ambush-stat-aura-bounce', family: 'constant-ambush-mixed-stats', extraCodes: ['SOR_100'], constant: { code: 'SOR_100', owner: 'own' }, plan: [['TWI_226','constant']],
        observeInitial: ({ targets }) => keyword(targets.own,'ambush') && targets.own.getPower() === 4 && targets.own.getHp() === 5,
        observeAfter: ({ targets }) => targets.constant.zoneName === 'hand' && !keyword(targets.own,'ambush') && targets.own.getPower() === 3 && targets.own.getHp() === 4 },
    { name: 'constant-ambush-entry-decline', family: 'constant-ambush-entry', extraCodes: ['SOR_100'], constant: { code: 'SOR_100', owner: 'own' }, decline: true, trackIncoming: true, plan: [['ASH_261','enemy']],
        observeAfter: ({ targets }) => targets.incoming.zoneName === 'groundArena' && targets.incoming.exhausted && keyword(targets.incoming,'ambush') && targets.enemy.damage === 0 },
    { name: 'constant-ambush-entry-attack', family: 'constant-ambush-entry', extraCodes: ['SOR_100'], constant: { code: 'SOR_100', owner: 'own' }, trackIncoming: true, plan: [['ASH_261','enemy']],
        observeAfter: ({ targets }) => targets.incoming.zoneName === 'discard' && targets.enemy.damage === 4 },
    { name: 'conditional-shielded-positive-entry', family: 'constant-shielded-entry', baseCode: 'HMW_020', extraCodes: ['HMW_084'], trackIncoming: true, plan: [['HMW_084','own']],
        observeAfter: ({ targets }) => targets.incoming.upgrades.some((c) => c.internalName === 'shield') },
    { name: 'conditional-shielded-negative-entry', family: 'constant-shielded-entry', extraCodes: ['HMW_084'], trackIncoming: true, plan: [['HMW_084','own']],
        observeAfter: ({ targets }) => !targets.incoming.upgrades.some((c) => c.internalName === 'shield') },
    { name: 'conditional-grit-positive-combat', family: 'constant-grit', baseCode: 'HMW_020', extraCodes: ['HMW_090','HMW_082'], enemyCode: 'HMW_082', constant: { code: 'HMW_090', owner: 'own' }, initialConstantDamage: 1,
        plan: [['HMW_090','enemy','attack']],
        observeInitial: ({ targets }) => keyword(targets.constant,'grit') && targets.constant.getPower() === targets.constant.cardData.power + 1,
        observeAfter: ({ targets, enemy }) => targets.enemy.zoneName === 'groundArena' && targets.enemy.damage === targets.constant.cardData.power + 1 },
    { name: 'conditional-grit-negative-combat', family: 'constant-grit', extraCodes: ['HMW_090','HMW_082'], enemyCode: 'HMW_082', constant: { code: 'HMW_090', owner: 'own' }, initialConstantDamage: 1,
        plan: [['HMW_090','enemy','attack']],
        observeInitial: ({ targets }) => !keyword(targets.constant,'grit') && targets.constant.getPower() === targets.constant.cardData.power,
        observeAfter: ({ targets, enemy }) => targets.enemy.zoneName === 'groundArena' && targets.enemy.damage === targets.constant.cardData.power },
    { name: 'conditional-saboteur-overwhelm-positive', family: 'constant-saboteur-overwhelm', extraCodes: ['TWI_130','SHD_056','JTL_229'], ownCode:'SHD_056', constant: { code:'TWI_130',owner:'own' }, enemyCode:'ASH_261',
        plan: [['JTL_229','enemy'],['TWI_130','enemyBase','attack']],
        observeInitial: ({ targets }) => keyword(targets.constant,'saboteur') && keyword(targets.constant,'overwhelm'),
        observeAfter: ({ targets, enemy }) => targets.enemy.damage === 0 && enemy.base.damage === 24 + targets.constant.cardData.power },
    { name: 'keyword-predicate-hp-aura-phase-expiry-lethal', family: 'keyword-predicate-stat-aura', extraCodes: ['JTL_229','SEC_032'], constant: {code:'SEC_032',owner:'own'}, initialOwnDamage:3,
        plan:[['JTL_229','own'],['TWI_170','own']],
        observeInitial: ({targets}) => targets.own.getHp() === 4 && targets.own.damage === 3 && !keyword(targets.constant,'sentinel') && targets.constant.getHp() === 5,
        observeAfter: ({targets}) => targets.own.zoneName === 'groundArena' && targets.own.damage === 5 && targets.own.getHp() >= 6 && keyword(targets.own,'sentinel'),
        observeLater: ({targets}) => targets.own.zoneName === 'discard' },
    { name:'conditional-saboteur-shield-overwhelm-spill',family:'constant-saboteur-overwhelm',extraCodes:['TWI_130','SHD_056'],ownCode:'SHD_056',enemyCode:'ASH_190',constant:{code:'TWI_130',owner:'own'},
        plan:[['TWI_124','constant'],['SOR_073','enemy'],['TWI_130','enemy','attack']],
        observeInitial: ({targets}) => keyword(targets.constant,'saboteur') && keyword(targets.constant,'overwhelm'),
        observeAfter: ({targets,enemy}) => targets.enemy.zoneName === 'discard' && enemy.base.damage === 27 },

    { name:'sentinel-restricts-nonsaboteur-attack',family:'phase-sentinel-target-set',extraCodes:['JTL_229'],constant:{code:'ASH_261',owner:'own'},enemyCode:'ASH_061',
        plan:[['JTL_229','enemy'],['ASH_261','enemy','attack']],
        observeAfter: ({targets,enemy}) => targets.enemy.zoneName === 'groundArena' && targets.enemy.damage === 3 && enemy.base.damage === 24 },
    ...['old','new'].map((keep) => ({name:`constant-ambush-source-unique-keep-${keep}`,family:'constant-source-unique',extraCodes:['SOR_100'],ownCode:'SOR_100',uniqueKeep:keep,uniqueExistingOwn:true,
        plan:[['SOR_100','own']],
        observeAfter: ({targets}) => keep === 'old' ? targets.own.zoneName === 'groundArena' && targets.incoming.zoneName === 'discard' : targets.own.zoneName === 'discard' && targets.incoming.zoneName === 'groundArena' })),

    { name:'continuous-restore-captured-before-source-defeat',family:'constant-restore-trigger-capture',extraCodes:['HMW_039','JTL_037'],ownCode:'HMW_039',constant:{code:'JTL_037',owner:'own'},initialOwnDamage:3,initialConstantDamage:1,
        plan:[['JTL_037','own','attack']],
        chooseAction: ({eg,pid,actions,targets,own,enemy,atWindow}) => {
            if (pid !== own.id || atWindow) return;
            const title = own.currentPrompt().menuTitle ?? '';
            if (title === 'Choose a target for attack') return actions.find((a) => a.cardUuid === enemy.base.uuid);
            // Resolve the source's ordinary on-attack before captured Restore.
            if (actions.some((a) => /Restore/.test(a.label ?? ''))) return actions.find((a) => /Banshee|banshee|deal damage/i.test(a.label ?? ''));
            return actions.find((a) => a.cardUuid === targets.own.uuid) ?? actions.find((a) => /trigger|resolve|deal damage/i.test(a.label ?? ''));
        },
        observeInitial: ({targets}) => keyword(targets.constant,'restore') && targets.own.damage === 3,
        observeAfter: ({targets,own}) => targets.own.zoneName === 'discard' && !keyword(targets.constant,'restore') && own.base.damage === 23 },
    { name:'continuous-raid-attack-numeric',family:'constant-raid',extraCodes:['SOR_144','HMW_082'],constant:{code:'ASH_061',owner:'own'},enemyCode:'HMW_082',extraOwnUnits:['SOR_144'],
        plan:[['ASH_061','enemy','attack']],
        observeInitial: ({targets}) => keyword(targets.constant,'raid') && targets.constant.getPower() === 5,
        observeAfter: ({targets}) => targets.enemy.zoneName === 'groundArena' && targets.enemy.damage === 6 },

    { name:'mentioned-sentinel-is-not-printed-refugee',family:'printed-keyword-metadata',extraCodes:['LOF_242'],constant:{code:'ASH_061',owner:'own'},enemyCode:'LOF_242',
        plan:[['ASH_061','enemyBase','attack']],
        observeInitial: ({targets}) => !keyword(targets.enemy,'sentinel'),
        observeAfter: ({enemy}) => enemy.base.damage === 29 },
    { name:'mentioned-sentinel-is-not-printed-shuttle',family:'printed-keyword-metadata',extraCodes:['SEC_032'],constant:{code:'SEC_032',owner:'own'},plan:[['SEC_032','enemyBase','attack']],
        observeInitial: ({targets}) => !keyword(targets.constant,'sentinel') && targets.constant.getHp() === 5 && targets.own.getHp() === 4,
        observeAfter: ({enemy}) => enemy.base.damage === 27 },

    { name:'constant-ambush-entry-no-target',family:'constant-ambush-entry',extraCodes:['SOR_100'],constant:{code:'SOR_100',owner:'own'},noEnemyUnits:true,trackIncoming:true,plan:[['ASH_261','own']],
        observeAfter: ({targets}) => targets.incoming.zoneName === 'groundArena' && targets.incoming.exhausted && keyword(targets.incoming,'ambush') },
    { name:'continuous-raid-source-bounce-before-attack',family:'constant-raid',extraCodes:['SOR_144','HMW_082'],constant:{code:'ASH_061',owner:'own'},enemyCode:'HMW_082',extraOwnUnits:['SOR_144'],
        plan:[['TWI_226','own'],['ASH_061','enemy','attack']],
        chooseAction: ({eg,pid,own,actions,atWindow,targets}) => {
            if(pid !== own.id || atWindow) return;
            const source = own.getArenaUnits().find((c)=>c.internalName==='red-three#unstoppable');
            if(source && /Return/.test(own.currentPrompt().menuTitle ?? '')) {targets.aura=source; return actions.find((a)=>a.cardUuid===source.uuid);}
        },
        observeInitial: ({targets}) => keyword(targets.constant,'raid'),
        observeAfter: ({targets}) => targets.aura?.zoneName === 'hand' && !keyword(targets.constant,'raid') && targets.enemy.damage === 5 },

    { name:'continuous-restore-source-bounce-before-attack',family:'constant-restore-trigger-capture',extraCodes:['HMW_039','ASH_256'],constant:{code:'ASH_256',owner:'own'},extraOwnUnits:['HMW_039'],
        plan:[['TWI_226','own'],['ASH_256','enemyBase','attack']],
        chooseAction: ({pid,own,actions,atWindow,targets}) => {
            if(pid !== own.id || atWindow) return;
            const source = own.getArenaUnits().find((c)=>c.internalName==='mother-talzin#pledged-to-the-sisterhood');
            if(source && /Return/.test(own.currentPrompt().menuTitle ?? '')) {targets.aura=source; return actions.find((a)=>a.cardUuid===source.uuid);}
        },
        observeAfter: ({targets,own}) => targets.aura?.zoneName === 'hand' && targets.constant.getKeywordsWithNumericValues('restore').length === 1 && own.base.damage === 23 },

    { name:'phase-sentinel-loss-removes-hp-lethal',family:'phase-keyword-loss',extraCodes:['SOR_140','SEC_032','IBH_003'],ownCode:'IBH_003',constant:{code:'SEC_032',owner:'own'},initialOwnDamage:7,
        plan:[['SOR_140','own']],
        observeInitial: ({targets}) => targets.own.zoneName === 'groundArena' && keyword(targets.own,'sentinel') && targets.own.getHp() === 8 && targets.own.damage === 7,
        observeAfter: ({targets}) => targets.own.zoneName === 'discard' },
    { name:'phase-sentinel-loss-survivor-expiry-reacquires',family:'phase-keyword-loss',extraCodes:['SOR_140','SEC_032','IBH_003'],ownCode:'IBH_003',constant:{code:'SEC_032',owner:'own'},initialOwnDamage:5,
        plan:[['SOR_140','own']],
        observeInitial: ({targets}) => keyword(targets.own,'sentinel') && targets.own.getHp() === 8,
        observeAfter: ({targets}) => targets.own.zoneName === 'groundArena' && !keyword(targets.own,'sentinel') && targets.own.getHp() === 6 && phaseStats(targets.own).phaseLostKeywords.includes('sentinel'),
        observeLater: ({targets}) => targets.own.zoneName === 'groundArena' && keyword(targets.own,'sentinel') && targets.own.getHp() === 8 && !phaseStats(targets.own).phaseLostKeywords },
    { name:'phase-grit-combat-expiry',family:'phase-grit',extraCodes:['HMW_243','HMW_082'],constant:{code:'ASH_061',owner:'own'},initialConstantDamage:1,enemyCode:'HMW_082',
        plan:[['HMW_243','constant'],['ASH_061','enemy','attack']],
        observeInitial: ({targets}) => !keyword(targets.constant,'grit') && targets.constant.getPower() === 5,
        observeAfter: ({targets}) => targets.enemy.damage === 6 && keyword(targets.constant,'grit') && targets.constant.getPower() === 7,
        observeLater: ({targets}) => targets.constant.zoneName === 'groundArena' && !keyword(targets.constant,'grit') && targets.constant.getPower() === 5 },
    { name:'constant-loss-marrok-shield-enables-saboteur',family:'constant-keyword-loss',extraCodes:['ASH_030'],constant:{code:'ASH_030',owner:'own'},plan:[['SOR_073','constant']],
        observeInitial: ({targets}) => keyword(targets.constant,'sentinel') && !keyword(targets.constant,'saboteur'),
        observeAfter: ({targets}) => targets.constant.upgrades.some((c)=>c.internalName==='shield') && !keyword(targets.constant,'sentinel') && keyword(targets.constant,'saboteur') },
    { name:'constant-loss-marrok-shield-defeat-restores-sentinel',family:'constant-keyword-loss',extraCodes:['ASH_030'],constant:{code:'ASH_030',owner:'own'},plan:[['SOR_073','constant'],['TWI_170','constant']],
        observeInitial: ({targets}) => keyword(targets.constant,'sentinel') && !keyword(targets.constant,'saboteur'),
        observeAfter: ({targets}) => targets.constant.upgrades.length===0 && keyword(targets.constant,'sentinel') && !keyword(targets.constant,'saboteur') && targets.constant.damage===0 },
    { name:'live-raid-zero-to-three-combat',family:'constant-live-numeric-raid',extraCodes:['HMW_117','HMW_082'],constant:{code:'HMW_117',owner:'own'},enemyCode:'HMW_082',plan:[['SOR_073','own'],['HMW_117','enemy','attack']],
        observeInitial: ({targets}) => keyword(targets.constant,'raid') && targets.constant.getKeywordsWithNumericValues('raid')[0].value===0 && !keyword(targets.constant,'overwhelm'),
        observeAfter: ({targets,own}) => own.exhaustedResourceCount===3 && targets.enemy.damage===3 && targets.constant.getKeywordsWithNumericValues('raid')[0].value===3 && !keyword(targets.constant,'overwhelm') },
    { name:'live-raid-all-resources-enables-overwhelm-shield-blocks',family:'constant-live-numeric-raid',extraCodes:['HMW_117'],constant:{code:'HMW_117',owner:'own'},plan:[['JTL_042','own'],['SOR_073','enemy'],['TWI_170','own'],['SOR_216','enemy'],['HMW_117','enemy','attack']],
        observeInitial: ({targets}) => targets.constant.getKeywordsWithNumericValues('raid')[0].value===0 && !keyword(targets.constant,'overwhelm'),
        observeAfter: ({targets,own,enemy}) => own.readyResourceCount===0 && own.exhaustedResourceCount===14 && targets.constant.getKeywordsWithNumericValues('raid')[0].value===14 && keyword(targets.constant,'overwhelm') && targets.enemy.upgrades.length===0 && targets.enemy.damage===0 && enemy.base.damage===24 },

    { name:'phase-raid-double-grant-stack-and-expiry',family:'phase-raid',extraCodes:['LAW_182','HMW_052','SOR_169'],constant:{code:'HMW_052',owner:'own'},extraOwnUnits:['LAW_182'],plan:[['LAW_182','constant','attack'],['SOR_169','own'],['LAW_182','constant','attack']],
        chooseAction: ({pid,own,enemy,actions,atWindow,index}) => {
            if(pid!==own.id)return;
            const source=own.getArenaUnits().find((c)=>c.internalName==='weazel#fighting-back');
            if(atWindow&&(index===1||index===3))return actions.find((a)=>a.cardUuid===source?.uuid);
            const title=own.currentPrompt().menuTitle ?? '';
            if(!atWindow&&(index===1||index===3)&&title==='Choose a target for attack')return actions.find((a)=>a.cardUuid===enemy.base.uuid);
            if(!atWindow&&index===2&&/Ready/i.test(title))return actions.find((a)=>a.cardUuid===source?.uuid);
        },
        observeAfter: ({targets,enemy}) => phaseStats(targets.constant).phaseKeywords?.raid===4 && targets.constant.getKeywordsWithNumericValues('raid')[0].value===5 && enemy.base.damage===28,
        observeLater: ({targets}) => targets.constant.zoneName==='groundArena' && !phaseStats(targets.constant).phaseKeywords && targets.constant.getKeywordsWithNumericValues('raid')[0].value===1 },

];
async function main(args) {
    const [sourcePool, directory, filter] = args;
    assert.ok(sourcePool && directory && args.length <= 3, 'Usage: make-keyword-fixtures.js POOL_JSON NEW_OUTPUT_DIRECTORY [SCENARIO_FILTER]');
    assert.ok(!fs.existsSync(directory), 'Use a fresh output directory');
    fs.mkdirSync(directory, { recursive: true });
    const poolFile = path.join(directory, 'pool.json'); fs.copyFileSync(sourcePool, poolFile);
    const pool = loadPool(poolFile), env = new Env(), witnesses = [];
    for (const [i, scenario] of scenarios.entries()) {
        if (filter && !filter.split(',').some((part) => scenario.name.includes(part))) continue;
        const { records, witness } = await fixture(env, pool, scenario, 12001 + i);
        if (['sentinel-restricts-nonsaboteur-attack', 'conditional-saboteur-overwhelm-positive'].includes(scenario.name)) {
            const prompt = records.find((r) => r.type === 'decision' && r.prompt.title === 'Choose a target for attack');
            assert.ok(prompt, 'No attack target prompt');
            const targets = prompt.actions.filter((a) => a.kind === 'card');
            assert.equal(targets.length, scenario.name.startsWith('sentinel-') ? 1 : 2, 'Sentinel restriction / Saboteur bypass target count');
            witness.attackTargetSet = targets;
        }
        if (scenario.name === 'mentioned-sentinel-is-not-printed-refugee') {
            const prompt = records.find((r) => r.type === 'decision' && r.prompt.title === 'Choose a target for attack');
            assert.equal(prompt.actions.filter((a) => a.kind === 'card').length, 2, 'Refugee falsely restricts attacks as Sentinel');
            witness.attackTargetSet = prompt.actions.filter((a) => a.kind === 'card');
        }
        if (scenario.name === 'continuous-restore-captured-before-source-defeat') {
            const prompt = records.find((r) => r.type === 'decision' && r.actions.some((a) => a.label === 'Restore 1'));
            assert.ok(prompt?.chosen.includes('Deal 1 damage to a unit'), 'Restore must resolve after source-defeating trigger');
            witness.sourceDefeatChosenBeforeCapturedRestore = true;
        }
        if (scenario.name === 'conditional-saboteur-shield-overwhelm-spill') {
            assert.ok(records.some((r) => r.type === 'state' && r.state.players.p2.ground.some((c) => c.upgrades.some((u) => u.name === 'shield'))), 'No Shield present before Saboteur attack');
            witness.shieldBeforeAttack = true;
        }
        const file = scenario.name + '.jsonl.gz';
        fs.writeFileSync(path.join(directory, file), zlib.gzipSync(records.map((r) => JSON.stringify(r)).join('\n') + '\n'));
        witnesses.push({ family: scenario.family, file, sha256: createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('hex'), ...witness });
        console.log(`${file}: ${records.filter((r) => r.type === 'decision').length} decisions, complete winner ${records.at(-1).winner}`);
    }
    fs.writeFileSync(path.join(directory, 'keyword-witnesses.json'), JSON.stringify({ conformance: 'unassessed; run native and Wasm check', witnesses }, null, 2) + '\n');
}
if (require.main === module) main(process.argv.slice(2)).catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { scenarios, main };
