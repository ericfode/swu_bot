'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compileSource, loadEnums, hash } = require('../compiler');
const root = path.resolve(process.env.SWU_ENGINE_SOURCE || path.join(__dirname, '../../../forceteki/server'));
const enums = loadEnums(root);
const ref = (...path) => ({ kind: 'ref', path });
function compile(body) {
    return compileSource(`export default class ArenaProbe extends NonLeaderUnitCard {
        getImplementationId(){return {id:'arena-probe',internalName:'arena-probe'};}
        setupCardAbilities(registrar,AbilityHelper){${body}}
    }`, 'arena-probe.ts', enums);
}
function ready(target) { return `registrar.addWhenPlayedAbility({immediateEffect:AbilityHelper.immediateEffects.ready(${target})});`; }
function supported(body) { const c=compile(body); assert.equal(c.status,'supported',JSON.stringify(c.diagnostics)); return c.abilities.card[0]; }
function rejected(body, pattern) { const c=compile(body); assert.equal(c.status,'unsupported',body); if(pattern) assert.ok(c.diagnostics.some(d=>d.pattern===pattern),JSON.stringify(c.diagnostics)); return c; }
function refs(value) { const paths=[]; const walk=v=>{if(!v||typeof v!=='object')return;if(v.kind==='ref')paths.push(v.path.join('.'));Object.values(v).forEach(walk);};walk(value);return paths; }
test('arena lists preserve global and controller-fixed receivers, and stable filters',()=>{
    for(const [source,receiver] of [['ctx.game',['game']],['ctx.player',['player']],['ctx.player.opponent',['opponent']],['ctx.source.controller',['player']],['ctx.source.controller.opponent',['opponent']]]) {
        const e=supported(ready(`ctx=>({target:${source}.getArenaUnits()})`)).effect;
        assert.deepEqual(e.target,{kind:'arenaList',receiver:ref(...receiver),predicate:{kind:'const',value:true}});
    }
    const e=supported(ready(`ctx=>({target:ctx.game.getArenaUnits({arena:ZoneName.GroundArena,trait:[Trait.Jedi,Trait.Rebel],aspect:Aspect.Heroism,keyword:KeywordName.Sentinel,otherThan:ctx.source,condition:unit=>unit.damage>0}).filter(unit=>!unit.exhausted).filter(unit=>unit.unique)})`)).effect;
    assert.equal(e.target.kind,'arenaFilter');assert.equal(e.target.receiver.kind,'arenaFilter');assert.equal(e.target.receiver.receiver.kind,'arenaList');
    assert.deepEqual(e.target.predicate,ref('card','unique'));
    assert.ok(refs(e).includes('source'));assert.ok(refs(e).includes('card.zoneName'));
});
test('some and filtered length are scalar; direct existing Player length stays exact',()=>{
    const a=supported(`registrar.addWhenPlayedAbility({condition:ctx=>ctx.player.getArenaUnits().some(unit=>unit.damage>0),immediateEffect:AbilityHelper.immediateEffects.draw()});`);
    assert.equal(a.condition.kind,'arenaSome');assert.deepEqual(a.condition.predicate.left,ref('card','damage'));
    const amount=supported(`registrar.addWhenPlayedAbility({immediateEffect:AbilityHelper.immediateEffects.damage({amount:ctx=>ctx.game.getArenaUnits().filter(unit=>unit.damage>0).length})});`).effect.amount;
    assert.equal(amount.kind,'arenaLength');assert.equal(amount.receiver.kind,'arenaFilter');
    const direct=supported(`registrar.addWhenPlayedAbility({immediateEffect:AbilityHelper.immediateEffects.damage({amount:ctx=>ctx.player.getArenaUnits().length})});`).effect.amount;
    assert.deepEqual(direct,{kind:'query',name:'arenaUnitCount',receiver:ref('player'),args:[{kind:'const',value:true}]});
    const alias=supported(`registrar.addWhenPlayedAbility({immediateEffect:AbilityHelper.immediateEffects.damage(ctx=>{const all=ctx.player.getArenaUnits();return {amount:all.length};})});`).effect.amount;
    assert.equal(alias.kind,'arenaLength');
});
test('readonly aliases retain lexical source and outer target through candidate shadowing',()=>{
    const a=supported(ready(`ctx=>{const outer=ctx.target;const own=ctx.source;const all=ctx.player.opponent.getArenaUnits({arena:outer.zoneName,otherThan:own});const damaged=all.filter(ctx=>ctx.getPower()<outer.getPower());return {target:damaged};}`));
    assert.ok(refs(a).includes('target.zoneName'));assert.ok(refs(a).includes('source'));assert.ok(refs(a).includes('card'));assert.ok(refs(a).includes('target'));
    const shadow=supported(ready(`ctx=>{const unit=ctx.source;return {target:ctx.game.getArenaUnits().filter(unit=>unit.damage>0),amount:unit.damage};}`));
    const aliasShadow=supported(ready(`ctx=>{const unit=ctx.source;const saved=unit;return {target:ctx.game.getArenaUnits().filter(unit=>unit!==saved)};}`));
    assert.deepEqual(aliasShadow.effect.target.predicate.right,ref('source'));
    assert.deepEqual(shadow.effect.amount,ref('source','damage'));assert.deepEqual(shadow.effect.target.predicate.left,ref('card','damage'));
});
test('list grammar rejects unknown filters, mutation, receivers and callback shapes',()=>{
    for(const filter of ['{controller:ctx.player}','{type:"unit"}','{owner:ctx.player}','{unknown:true}','{condition:()=>true}','{condition:(unit,index)=>index===0}','{condition:true}','{condition:unit=>{unit.damage++;return true;}}']) rejected(ready(`ctx=>({target:ctx.game.getArenaUnits(${filter})})`));
    for(const receiver of ['ctx.target.controller','ctx.player.base','ctx.source','ctx.game.players']) rejected(ready(`ctx=>({target:${receiver}.getArenaUnits()})`),'arena-query-receiver');
    for(const method of ['filter','some']) for(const args of ['', 'true','(unit,index)=>index===0','unit=>true,ctx']) rejected(ready(`ctx=>({target:ctx.game.getArenaUnits().${method}(${args})})`));
    rejected(ready(`ctx=>({target:ctx.game.getArenaUnits({}, {})})`),'arena-query-arity');
    rejected(ready(`ctx=>({target:ctx.game.getArenaUnits?.()})`),'optional-arena-list');
    rejected(ready(`ctx=>({target:ctx.game.getArenaUnits()${'.filter(unit=>true)'.repeat(25)}})`),'arena-list-bound');
});
test('arbitrary collection operations and list scalar/array confusion fail closed',()=>{
    for(const suffix of ['.map(unit=>unit)','.find(unit=>true)','.every(unit=>true)','.includes(ctx.source)','.concat(ctx.player.getArenaUnits())','.slice(0,1)']) rejected(ready(`ctx=>({target:ctx.game.getArenaUnits()${suffix}})`));
    for(const amount of ['ctx=>ctx.game.getArenaUnits()','ctx=>ctx.game.getArenaUnits()+1','ctx=>ctx.game.getArenaUnits().filter(unit=>true)']) rejected(`registrar.addWhenPlayedAbility({immediateEffect:AbilityHelper.immediateEffects.damage({amount:${amount}})});`);
    rejected(ready(`ctx=>({target:ctx.game.getArenaUnits()+1})`),'arena-list-scalar');
    rejected(ready(`ctx=>({target:[ctx.game.getArenaUnits()]})`),'arena-list-scalar');
    rejected(ready(`ctx=>({target:ctx.game.getArenaUnits()[0]})`));
});
test('candidate capture, array-selected outer targets, cycles and unsupported predicate roots reject',()=>{
    const selector=p=>`registrar.addWhenPlayedAbility({targetResolver:{cardTypeFilter:'unit',cardCondition:(outer,ctx)=>${p},immediateEffect:AbilityHelper.immediateEffects.ready()}});`;
    rejected(selector(`ctx.player.getArenaUnits().some(inner=>inner!==outer)`),'arena-query-card-capture');
    rejected(selector(`{const saved=outer;return ctx.player.getArenaUnits().some(inner=>inner!==saved);}`),'arena-query-card-capture');
    rejected(ready(`ctx=>({target:ctx.game.getArenaUnits({condition:unit=>ctx.game.getArenaUnits().some(other=>other!==unit)})})`),'arena-query-card-capture');
    for(const predicate of ['unit=>ctx.target[0].power<unit.power','unit=>ctx.event.card===unit','unit=>ctx.attack.attacker===unit','unit=>unit.upgrades.some(upgrade=>upgrade.isUnit())','unit=>ctx.player.getArenaUnits().length>0']) rejected(ready(`ctx=>({target:ctx.game.getArenaUnits().filter(${predicate})})`));
    for(const locals of ['const a=a;','const a=b;const b=a;']) rejected(ready(`ctx=>{${locals}return {target:a};}`));
    rejected(ready(`ctx=>{let all=ctx.game.getArenaUnits();return {target:all};}`),'mutable-callback-local');
});

// Complete pinned sources: 28 planned, seven incidental source-only gains, ten blockers.
const actualSources = [
    [
        "ASH_064",
        "game/cards/08_ASH/units/TheArmorerSecrecyIsOurSurvival.ts",
        "a586c462934e811de2dba13e093db6da411e7635dad595d57a939f202ed7d6da",
        null
    ],
    [
        "ASH_083",
        "game/cards/08_ASH/units/Summa-Verminoth.ts",
        "c73c3289d38cbba79a5a0cba275e228f22238bf8a1242175c219de426b83aeed",
        null
    ],
    [
        "ASH_098",
        "game/cards/08_ASH/units/AT-STRaider.ts",
        "129aa1d4b448fbcceaac0a01693247e05b7639dc18e56003dbba93c959e1da8f",
        null
    ],
    [
        "ASH_112",
        "game/cards/08_ASH/units/LukeSkywalkerAnsweringTheCall.ts",
        "d9ff80a9a6063062901a72a46d2d77a7a009ea06c3a22a81043afb145ddf0678",
        null
    ],
    [
        "ASH_151",
        "game/cards/08_ASH/events/OperationCinder.ts",
        "cf245ad766b2c283f3df98dd3748c5883f040c89a0abe3220ff02dca7b7fea7c",
        null
    ],
    [
        "HMW_080",
        "game/cards/09_HMW/units/FambaaShieldTeam.ts",
        "e649cbf19cf64772b71c36aeffb2babf0b6f1561a7ac473a3048994c86da0f3d",
        "unsupported-query:isShield"
    ],
    [
        "HMW_111",
        "game/cards/09_HMW/units/InvasionLander.ts",
        "8795a42978fbca3a3dd02e11a10d941de1e88920b84450fec581a31f55035a65",
        null
    ],
    [
        "IBH_072",
        "game/cards/06_IBH/units/AvengerHuntingTheRebels.ts",
        "8f3c6fdf1fd6187af59986d4c3a7f55080679ff974692952dc0fc7d0d3b5e7fe",
        null
    ],
    [
        "JTL_077",
        "game/cards/04_JTL/events/InTheHeatOfBattle.ts",
        "4466d4565502c137094342f3634f2f7b81f7417e3f34a9793fe68e7402b12afc",
        null
    ],
    [
        "JTL_080",
        "game/cards/04_JTL/events/NebulaIgnition.ts",
        "999bd70c9f4531c420f3d474bdcdafa08529667e9761170b9ed1fb2926627b79",
        null
    ],
    [
        "JTL_209",
        "game/cards/04_JTL/events/ItsATrap.ts",
        "17120d53cebaf4d738895d23138373041bf18bfcd520278a624d14da5f15f8e4",
        null
    ],
    [
        "LAW_169",
        "game/cards/07_LAW/events/PayrollHeist.ts",
        "190d81b71195d716388b104517b7035656c745a7d3e407a6857145650a00229d",
        "unsupported-modifier:AbilityHelper.ongoingEffects.gainAbility"
    ],
    [
        "LOF_033",
        "game/cards/05_LOF/units/NamelessTerror.ts",
        "65c0973f956a446d4671cb528ff2a6b9fddb1a8f8a9f3634660f12724de1d0f8",
        "unsupported-modifier:AbilityHelper.ongoingEffects.loseTrait"
    ],
    [
        "LOF_045",
        "game/cards/05_LOF/units/YaddleAChanceToMakeThingsRight.ts",
        "540f2b443b0f83acb1238615e86fe35a0e88565fcc298ad1d014d552cad31a0d",
        null
    ],
    [
        "LOF_127",
        "game/cards/05_LOF/events/Rampage.ts",
        "dee7f6ecba237b0ba09d2b64b83c8aef625ab3024d02006b8602da5327605cd8",
        null
    ],
    [
        "LOF_141",
        "game/cards/05_LOF/events/DeathField.ts",
        "69f7344af9acb9ed2db3e687b549eb56ab4d3e802991dc430c069490e32da269",
        null
    ],
    [
        "LOF_152",
        "game/cards/05_LOF/events/FocusDeterminesReality.ts",
        "4191a587e26f0efa3e85c605ccbf73454afa2cf5a230274d7a860f51db4a1962",
        null
    ],
    [
        "LOF_170",
        "game/cards/05_LOF/units/BenduDoYouFearTheStorm.ts",
        "9f4b6ec67e7cdf9fe7e73692a89ad6dba78a30504d4450136513f16406efa89d",
        null
    ],
    [
        "LOF_209",
        "game/cards/05_LOF/units/TuskenTracker.ts",
        "d44731ae9bb14217cdd780bd9703f79ad9f9c016c0e5a3a47a42960180ca26fd",
        null
    ],
    [
        "LOF_211",
        "game/cards/05_LOF/units/DookuItIsTooLate.ts",
        "25f915b4a9b78a9fd119d824b5bac298f7d1997256336a504d3b1b01a1a36d76",
        "unsupported-modifier:AbilityHelper.ongoingEffects.cardCannot"
    ],
    [
        "LOF_235",
        "game/cards/05_LOF/units/HK87AssassinDroid.ts",
        "add5c3778a8b5f07bbff3f3ea9bbce937a17d94d6c0838f642def3497a25c21c",
        "unsupported-arena-collection:concat"
    ],
    [
        "SEC_078",
        "game/cards/06_SEC/events/HyperspaceDisaster.ts",
        "2cb0e6c2a786009f878f13145577b27a5b2283fea387671434fe97438b25a8b2",
        null
    ],
    [
        "SEC_091",
        "game/cards/06_SEC/events/CorporateWarmongering.ts",
        "ad32d4f28ca269ca627db4c1ad4bf5e68e0c4487b98787d128f981cee485aa5e",
        null
    ],
    [
        "SEC_119",
        "game/cards/06_SEC/units/CrucibleCenturiesOfWisdom.ts",
        "91957e6387c59c2e6ffcd96fb8bfc89adc5289dedaaa2fbbe2199a97c62307cf",
        null
    ],
    [
        "SEC_183",
        "game/cards/06_SEC/events/ToppleTheSummit.ts",
        "8a07af0338f07fae2873b5f3b9fecced6d8b0245eb3ae645a6bbc30f3e6aa208",
        null
    ],
    [
        "SEC_252",
        "game/cards/06_SEC/units/MaarvaAndorWeveBeenSleeping.ts",
        "619038e3d8266464754e6e363fb5b6a705b4c6c9dde5060a4c76a064911ba0cf",
        null
    ],
    [
        "SEC_263",
        "game/cards/06_SEC/units/AssassinProbe.ts",
        "93886938075d2ca9482426e16b1f922c285c3014f6506e5a53419f7a6cadfdfc",
        null
    ],
    [
        "SHD_158",
        "game/cards/02_SHD/units/WildRancor.ts",
        "a94ac871fae24d6d16f7b8b09f9a558e48ac92d1649e54f2836bd70f824da317",
        null
    ],
    [
        "SHD_208",
        "game/cards/02_SHD/events/FinalShowdown.ts",
        "0d5c46a613015c2e17c7e520414745b13118deba7d1d265ee1e7dba24c92a374",
        "immediateEffect:delayedPlayerEffect"
    ],
    [
        "SHD_233",
        "game/cards/02_SHD/events/Evacuate.ts",
        "9ef94adc3d3e5dd365c9750b7616f47b97530b7e445aec3191fd874e4bce2c8d",
        null
    ],
    [
        "SOR_037",
        "game/cards/01_SOR/units/AcademyDefenseWalker.ts",
        "8c91c6b070fc1d6569c57a2758fd5e4b9f5c2e035cb08a81d814aa895d456701",
        null
    ],
    [
        "SOR_043",
        "game/cards/01_SOR/events/SuperlaserBlast.ts",
        "0c54236a10249d9c690b52ff9ce5ba7aa2b45746ff08892710ce94e48246ba81",
        null
    ],
    [
        "SOR_154",
        "game/cards/01_SOR/events/RallyingCry.ts",
        "18bc3125d1ab5b00ba529ba155263fc9f5266cc3bf1a0b875fc7db00ddd5d36c",
        null
    ],
    [
        "TS26_016",
        "game/cards/07_TS26/units/KingKatuunkoGreatKingOfToydaria.ts",
        "7193856ab043c5974bed2465536751297b7c5ef99fb68629a53d7182ab3f521a",
        null
    ],
    [
        "TS26_028",
        "game/cards/07_TS26/units/PrimeMinisterAlmecSchemingPopulist.ts",
        "5efbeebfb96b6ea25b1adc2cff55168dd80134934a16999ac949ed9bae850385",
        null
    ],
    [
        "TS26_048",
        "game/cards/07_TS26/events/VanquishTheLegion.ts",
        "cf4a2caea8e28954ec9545bcff054a6dc855238dedeb82c764e529a1a178541a",
        null
    ],
    [
        "TWI_075",
        "game/cards/03_TWI/events/DisruptiveBurst.ts",
        "834e1dabdfd0af938ed5c899a91d047b9d0f3981e418b343e5daf6c3606351dd",
        null
    ],
    [
        "TWI_078",
        "game/cards/03_TWI/events/TheInvasionOfChristophsis.ts",
        "339d1165bd8d6463c0d24ca99d83492f3e3a6c5684921445c6ce5ff86c650429",
        null
    ],
    [
        "TWI_084",
        "game/cards/03_TWI/units/KrakenConfederateTactician.ts",
        "5d5083699a770bb5b555dd56ed6a79e66caf686064a380ef475cf357f3d7a1b3",
        "unsupported-query:isTokenUnit"
    ],
    [
        "TWI_103",
        "game/cards/03_TWI/events/PyrrhicAssault.ts",
        "49102e157508ae8c543834a9f61e451c6562199f0bb943653b68ed811babd69c",
        "unsupported-modifier:AbilityHelper.ongoingEffects.gainAbility"
    ],
    [
        "TWI_126",
        "game/cards/03_TWI/events/EncouragingLeadership.ts",
        "c5fc1ede2daca5dac11500cf0777d20c70db3f20080f05ea793f3a8e3e3d6151",
        null
    ],
    [
        "TWI_129",
        "game/cards/03_TWI/events/InDefenseOfKamino.ts",
        "0cf421ef6fc8ab581491faccca5f7e469cb1d92556d50e64f71ff182046b86c2",
        "unsupported-modifier:AbilityHelper.ongoingEffects.gainAbility"
    ],
    [
        "TWI_150",
        "game/cards/03_TWI/units/SawGerreraResistanceIsNotTerrorism.ts",
        "fcd1772838a1ce797afb1deab5c3e7706f656e4a87c46d5ed6227a29ce8fe044",
        null
    ],
    [
        "TWI_164",
        "game/cards/03_TWI/units/HevyStaunchMartyr.ts",
        "2aeb1ab9146cf3cf2100972e998894bd80c9e4190f1dfa1f84ac7533c835a63f",
        null
    ],
    [
        "TWI_250",
        "game/cards/03_TWI/events/SwordAndShieldManeuver.ts",
        "5e6df77edb0df96159845ad29bdb225f24adc5f8688c7ccdf7b6823448d66733",
        null
    ]
];
test('all 45 full pinned sources match hashes and retain complete card support or precise rejection',()=>{
    let supportedCount=0;
    for(const [setCode,file,sourceHash,blocker] of actualSources) {
        const sourcePath=path.join(root,file),source=fs.readFileSync(sourcePath,'utf8');
        assert.equal(hash(source),sourceHash,setCode+' source drift');
        const c=compileSource(source,sourcePath,enums);
        assert.equal(c.status,blocker?'unsupported':'supported',setCode+JSON.stringify(c.diagnostics));
        if(blocker) assert.ok(c.diagnostics.some(d=>d.pattern===blocker),setCode+JSON.stringify(c.diagnostics));
        else {supportedCount++;assert.ok(Object.values(c.abilities).some(side=>side.length),setCode+' missing complete ability');}
    }
    assert.equal(supportedCount,36);
});

test("four additional generic source-only gains retain full source identities",()=>{
    const sources=[["JTL_217", "game/cards/04_JTL/units/DeathSpaceSkirmisher.ts", "ae8e4acb0ddb8613a37d52aaa504de8ed96abd3174bb7e316e70f21cdcb90b98"], ["SEC_014", "game/cards/06_SEC/leaders/SlyMooreCipherInTheDark.ts", "0a2a30e721f4646995428e662724233577c9718b1d374440ee5e2fcd236c15fe"], ["TWI_137", "game/cards/03_TWI/units/SavageOpressMonster.ts", "6ab2d2128e79311328d13c0bd8f27df93483baf14c3804a48b9fbd4aa72424cc"], ["TWI_194", "game/cards/03_TWI/units/AhsokaTanoAlwaysReadyForTrouble.ts", "4df31d40dc641ac824a829817fd9ad564872bd4824ffee69bd78108a95fcb5c2"]];
    for(const [id,file,expectedHash] of sources){const p=path.join(root,file),source=fs.readFileSync(p,"utf8");assert.equal(hash(source),expectedHash,id);const c=compileSource(source,p,enums);assert.equal(c.status,"supported",id+JSON.stringify(c.diagnostics));}
});

test('arena snapshots cannot move from setup or an outer factory to a later callback',()=>{
    for(const setup of [
        `const units=this.controller.getArenaUnits();registrar.addWhenPlayedAbility({immediateEffect:AbilityHelper.immediateEffects.ready({target:units})});`,
        `const units=this.controller.getArenaUnits();const saved=units;registrar.addWhenPlayedAbility({immediateEffect:AbilityHelper.immediateEffects.ready(ctx=>({target:saved}))});`,
        `const count=this.controller.getArenaUnits().length;registrar.addWhenPlayedAbility({condition:ctx=>count>0,immediateEffect:AbilityHelper.immediateEffects.draw()});`,
        `const count=this.controller.getArenaUnits().filter(unit=>unit.damage>0).length+1;const saved=count;registrar.addWhenPlayedAbility({condition:ctx=>saved>1,immediateEffect:AbilityHelper.immediateEffects.draw()});`,
        `const exists=this.controller.getArenaUnits().some(unit=>unit.damage>0)?2:0;registrar.addWhenPlayedAbility({condition:ctx=>exists>0,immediateEffect:AbilityHelper.immediateEffects.draw()});`,
        `const exists=this.controller.hasSomeArenaUnit();registrar.addWhenPlayedAbility({condition:ctx=>exists,immediateEffect:AbilityHelper.immediateEffects.draw()});`,
    ]) rejected(setup,'arena-query-snapshot-capture');
    for(const binding of ['const owner=this.controller;', 'const owner=this.controller;const saved=owner;']) rejected(`${binding}registrar.addWhenPlayedAbility({immediateEffect:AbilityHelper.immediateEffects.ready(ctx=>({target:${binding.includes('saved')?'saved':'owner'}.getArenaUnits()}))});`,'arena-controller-snapshot-capture');
    rejected(ready(`{target:this.controller.getArenaUnits()}`),'arena-query-evaluation-stage');
    rejected(`registrar.addWhenPlayedAbility({immediateEffect:AbilityHelper.immediateEffects.draw(),then:ctx=>{const units=ctx.player.getArenaUnits();return {immediateEffect:AbilityHelper.immediateEffects.damage(other=>({amount:1,target:units}))};}});`,'arena-query-snapshot-capture');
    rejected(`registrar.addWhenPlayedAbility({immediateEffect:AbilityHelper.immediateEffects.draw(),then:ctx=>{const n=ctx.player.getArenaUnits().length;const saved=n+1;return {immediateEffect:AbilityHelper.immediateEffects.damage(other=>({amount:saved,target:other.source}))};}});`,'arena-query-snapshot-capture');
    rejected(`registrar.addWhenPlayedAbility({immediateEffect:AbilityHelper.immediateEffects.draw(),then:ctx=>{const units=ctx.player.getArenaUnits();return {immediateEffect:AbilityHelper.immediateEffects.sequential([AbilityHelper.immediateEffects.defeat({target:units}),AbilityHelper.immediateEffects.ready({target:units})])};}});`,'continuation-factory-value-lifetime');
});
test('same executing helper or condition keeps snapshot locals and identity aliases',()=>{
    const a=supported(ready(`ctx=>{const player=ctx.player;const units=player.getArenaUnits();const saved=units;return {target:saved};}`));
    assert.deepEqual(a.effect.target,{kind:'arenaList',receiver:ref('player'),predicate:{kind:'const',value:true}});
    const count=supported(`registrar.addWhenPlayedAbility({condition:ctx=>{const player=ctx.player;const n=player.getArenaUnits().length;const saved=n+1;return saved>2;},immediateEffect:AbilityHelper.immediateEffects.draw()});`);
    assert.equal(count.condition.left.left.name,'arenaUnitCount');
    const nested=supported(ready(`ctx=>{const owner=ctx.player;return {target:owner.getArenaUnits().filter(unit=>unit.controller===owner)};}`));
    assert.deepEqual(nested.effect.target.predicate.right,ref('player'));
    // The synchronous predicate shares evaluation time, but nested count IR is
    // still outside this bounded predicate grammar and is explicitly rejected.
    rejected(ready(`ctx=>{const n=ctx.player.getArenaUnits().length;return {target:ctx.game.getArenaUnits().filter(unit=>unit.damage<n)};}`),'arena-predicate-query');
});
