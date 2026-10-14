'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {compileSource,loadEnums}=require('../compiler');
const engine=path.resolve(__dirname,'../../../forceteki');
const enums=loadEnums(path.join(engine,'server'));
function compile(fragment,context=false) {
    return compileSource('export default class Example extends NonLeaderUnitCard { getImplementationId(){return {id:"new-title",internalName:"new-title"};} setupCardAbilities(registrar,AbilityHelper){registrar.addOnAttackAbility({title:`Pay '+fragment+'`,'+(context?'contextTitle:ctx=>`Pay '+fragment+' to ${ctx.source.title}`,':'')+'immediateEffect:AbilityHelper.immediateEffects.draw()});}}','title.ts',enums);
}
function oracle(expression,mode) {
    const helper=path.join(engine,'build/server/game/core/utils/TextHelper.js');
    const constants=path.join(engine,'build/server/game/core/Constants.js');
    const result=spawnSync(process.execPath,['-e',`const {TextHelper}=require(${JSON.stringify(helper)});const {KeywordName}=require(${JSON.stringify(constants)});process.stdout.write(JSON.stringify(${expression}));`],{env:{...process.env,NODE_ENV:mode},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    return JSON.parse(result.stdout);
}
test('resource labels match pinned headless helper, including zero and singular',()=>{
    for(const amount of [0,1,2,99]) {
        const label=oracle(`TextHelper.resource(${amount})`,'test');
        const card=compile('${TextHelper.resource('+amount+')}',true);
        assert.equal(card.status,'supported');
        assert.equal(card.abilities.card[0].title,'Pay '+label);
        assert.equal(card.abilities.card[0].contextTitle[1].value,label);
        assert.equal(oracle(`TextHelper.resource(${amount})`,'production'),`{resource:${amount}}`);
    }
});
test('bare and object keyword labels match real helper without dropping numeric zero',()=>{
    for(const input of ['KeywordName.Raid','KeywordName.Ambush','{keyword:KeywordName.Raid}','{keyword:KeywordName.Restore,amount:0}','{keyword:KeywordName.Raid,amount:3}']) {
        const label=oracle(`TextHelper.keyword(${input})`,'test');
        const card=compile('${TextHelper.keyword('+input+')}',true);
        assert.equal(card.status,'supported',JSON.stringify(card.diagnostics));
        assert.equal(card.abilities.card[0].title,'Pay '+label);
        assert.equal(card.abilities.card[0].contextTitle[1].value,label);
        assert.match(oracle(`TextHelper.keyword(${input})`,'production'),/^\{keyword:/);
    }
});
test('unsupported helper arguments reject whole cards rather than hiding executable expressions',()=>{
    for(const call of ['resource()','resource(1,2)','resource(-1)','resource(1.5)','resource(ctx.source.damage)','keyword()','keyword("unknown")','keyword(KeywordName.Raid,1)','keyword({keyword:KeywordName.Raid,amount:-1})','keyword({keyword:KeywordName.Raid,amount:ctx.source.damage})','keyword({keyword:KeywordName.Raid,extra:1})','keyword({amount:1})']) {
        const card=compile('${TextHelper.'+call+'}',true);
        assert.equal(card.status,'unsupported',call);
    }
});
test('real card title helpers reveal remaining mechanic blockers without admitting partial cards',()=>{
    const fs=require('node:fs');
    for(const [file,pattern] of [
        ['07_LAW/units/DoggedPursuers.ts','immediateEffect:payResources'],
        ['01_SOR/units/MiningGuildTieFighter.ts','immediateEffect:payResources'],
        ['09_HMW/events/VolleyFire.ts','unsupported-field:source'],
        ['02_SHD/events/LookTheOtherWay.ts','unsupported-named-resolver-field:unlessEffect'],
    ]) {
        const relative='game/cards/'+file;
        const card=compileSource(fs.readFileSync(path.join(engine,'server',relative),'utf8'),relative,enums);
        assert.equal(card.status,'unsupported',file);
        assert.ok(card.diagnostics.some(d=>d.pattern===pattern),JSON.stringify(card.diagnostics));
        assert.ok(!card.diagnostics.some(d=>d.pattern==='unsupported-title-helper'),JSON.stringify(card.diagnostics));
    }
});
