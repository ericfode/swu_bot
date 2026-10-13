'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compileSource, loadEnums } = require('../compiler');
const engine = path.resolve(__dirname, '../../../forceteki/server');
const enums = loadEnums(engine);
function compile(body, base = 'NonLeaderUnitCard') {
    return compileSource(`export default class Fresh extends ${base} {
        getImplementationId() { return {id:'fresh-entry-effect',internalName:'fresh-entry-effect'}; }
        setupCardAbilities(registrar, AbilityHelper) { ${body} }
    }`, 'fresh.ts', enums);
}
const immediate = (helper) => `registrar.addWhenPlayedAbility({immediateEffect:AbilityHelper.immediateEffects.${helper}});`;
const rejection = (body, pattern, base) => {
    const card = compile(body, base);
    assert.equal(card.status, 'unsupported');
    if (pattern) assert.ok(card.diagnostics.some(d => d.pattern === pattern), JSON.stringify(card.diagnostics));
};
test('Mandalorian factory preserves inherited exact defaults and scalar overrides', () => {
    assert.deepEqual(compile(immediate('createMandalorian()')).abilities.card[0].effect,
        {kind:'createTokenUnit',tokenType:'mandalorian',amount:{kind:'const',value:1},target:'ownPlayer',entersReady:false});
    const card = compile(immediate('createMandalorian(ctx=>({amount:2,entersReady:true,target:ctx.player.opponent}))'));
    assert.equal(card.status, 'supported');
    assert.equal(card.abilities.card[0].effect.target, 'enemyPlayer');
    for (const field of ['enterPlayEffect:AbilityHelper.immediateEffects.draw()', 'tokenType:"spy"', 'isCost:true', 'unknown:true', 'amount:6', 'target:[ctx.player,ctx.player.opponent]']) rejection(immediate(`createMandalorian(ctx=>({${field}}))`));
    rejection('registrar.addWhenPlayedAbility({immediateEffect:AbilityHelper.immediateEffects.createMandalorian(),then:ctx=>({immediateEffect:AbilityHelper.immediateEffects.damage({amount:ctx.events[0].amount})})});', 'token-event-result-capture');
});
test('deck discard requires bounded scalar amount and inherits opponent target', () => {
    for (const amount of [0,1,3,5]) {
        const card = compile(immediate(`discardFromDeck({amount:${amount}})`));
        assert.equal(card.status,'supported');
        assert.deepEqual(card.abilities.card[0].effect,{kind:'discardDeck',amount:{kind:'const',value:amount},target:'enemyPlayer'});
    }
    assert.equal(compile(immediate('discardFromDeck(ctx=>({amount:1,target:ctx.player}))')).abilities.card[0].effect.target,'ownPlayer');
    rejection(immediate('discardFromDeck()'),'deck-discard-missing-amount');
    for(const field of ['amount:-1','amount:6','amount:1.5','amount:ctx.source.power','amount:1,isCost:true','amount:1,unknown:true','amount:1,target:[ctx.player,ctx.player.opponent]','amount:1,target:ctx.source']) rejection(immediate(`discardFromDeck(ctx=>({${field}}))`));
    rejection('registrar.addWhenPlayedAbility({immediateEffect:AbilityHelper.immediateEffects.discardFromDeck({amount:1}),ifYouDo:ctx=>({condition:()=>ctx.events[0].card.isUnit(),immediateEffect:AbilityHelper.immediateEffects.draw({amount:1})})});','deck-discard-event-result-capture');
});
test('attached keyword retains lexical upgrade source and attach candidate independently', () => {
    const card=compile(`registrar.setAttachCondition(ctx=>!ctx.attachTarget.hasSomeTrait(Trait.Vehicle));
        registrar.addGainKeywordTargetingAttached({keyword:KeywordName.Restore,amount:2,gainCondition:ctx=>ctx.source.parentCard.hasSomeTrait(Trait.Force)});`, 'UpgradeCard');
    assert.equal(card.status,'supported',JSON.stringify(card.diagnostics));
    assert.deepEqual(card.attachCondition.value.receiver,{kind:'ref',path:['card']});
    const ability=card.abilities.card[0];
    assert.equal(ability.effect.target,'parent');
    assert.equal(ability.title,'Give Restore 2 to the attached unit');
    assert.deepEqual(ability.condition.receiver,{kind:'ref',path:['source','parentCard']});
    for(const field of ['ability:{immediateEffect:AbilityHelper.immediateEffects.draw()}','unknown:true','title:"ignored"','amount:ctx=>2']) rejection(`registrar.addGainKeywordTargetingAttached({keyword:KeywordName.Sentinel,${field}});`,null,'UpgradeCard');
    rejection('registrar.addGainKeywordTargetingAttached({keyword:KeywordName.Bounty,ability:{title:"draw",immediateEffect:AbilityHelper.immediateEffects.draw()}});','unsupported-attached-keyword-field:ability','UpgradeCard');
    rejection('registrar.addGainKeywordTargetingAttached({keyword:KeywordName.Sentinel});','attached-source-side');
    rejection('registrar.setAttachCondition(ctx=>true);registrar.setAttachCondition(ctx=>false);','duplicate-attach-condition','UpgradeCard');
    rejection('registrar.setAttachCondition(ctx=>{ctx.source.damage=1;return true;});',null,'UpgradeCard');
    rejection('registrar.addGainKeywordTargetingAttached({keyword:KeywordName.Sentinel}); registrar.addActionAbility({immediateEffect:AbilityHelper.immediateEffects.unmodeled()});',null,'UpgradeCard');
});
test('actual full sources support bounded families while captured results and Bounty stay rejected', () => {
    const sources = [
        ['game/cards/08_ASH/units/DuchesssProtector.ts',true],
        ['game/cards/08_ASH/events/FoundlingRescue.ts',true],
        ['game/cards/08_ASH/events/BuyTime.ts',false],
        ['game/cards/07_LAW/units/BraccaShipbreaker.ts',true],
        ['game/cards/07_LAW/units/BT-1Blastomech.ts',false],
        ['game/cards/01_SOR/upgrades/Protector.ts',true],
        ['game/cards/02_SHD/upgrades/DeathMark.ts',false]
    ];
    for(const [file,supported] of sources) {
        const card=compileSource(fs.readFileSync(path.join(engine,file),'utf8'),file,enums);
        assert.equal(card.status,supported?'supported':'unsupported',file+JSON.stringify(card.diagnostics));
    }
});
