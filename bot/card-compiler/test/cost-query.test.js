'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {compileSource,loadEnums}=require('../compiler');
const {compileCatalog}=require('../build');
const engine=path.resolve(__dirname,'../../../forceteki');
const enums=loadEnums(path.join(engine,'server'));
function compile(body,base="NonLeaderUnitCard") {
    return compileSource('export default class Unknown extends '+base+' {getImplementationId(){return {id:"unknown-cost",internalName:"unknown-cost"};} setupCardAbilities(registrar,AbilityHelper){'+body+'}}','cost.ts',enums);
}
const ability=condition=>'registrar.addWhenPlayedAbility({title:"Ready",targetResolver:{cardCondition:(card,context)=>'+condition+',immediateEffect:AbilityHelper.immediateEffects.ready()}});';
test('hasCost is a typed zero-argument query, including guarded arena candidates',()=>{
    const card=compile(ability('card.hasCost() && card.cost <= 0'));
    assert.equal(card.status,'supported');
    assert.deepEqual(card.abilities.card[0].targetResolver.predicate.left,{kind:'query',name:'hasCost',receiver:{kind:'ref',path:['card']},args:[]});
    const arena=compile('registrar.addWhenPlayedAbility({title:"Draw",immediateEffect:AbilityHelper.immediateEffects.conditional({condition:context=>context.player.hasSomeArenaUnit({condition:c=>c.hasCost()&&c.cost<=1}),onTrue:AbilityHelper.immediateEffects.draw()})});');
    assert.equal(arena.status,'supported',JSON.stringify(arena.diagnostics));
    const attachment=compile('registrar.setAttachCondition(context=>context.attachTarget.hasCost()&&context.attachTarget.cost<=4);','UpgradeCard');
    assert.equal(attachment.status,'supported',JSON.stringify(attachment.diagnostics));
});
test('hasCost rejects optional calls, arguments and non-card or nested receivers',()=>{
    for(const expression of ['card.hasCost(0)','card.hasCost(...[])','card?.hasCost()','card.hasCost?.()','context.player.hasCost()','context.player.base.hasCost()','context.source.parentUnit.hasCost()','[card].hasCost()'])assert.equal(compile(ability(expression)).status,'unsupported',expression);
});
test('pinned engine hasCost follows WithCost ancestry, including leaders and token upgrades',()=>{
    const classes=[['Card','Card',false],['BaseCard','BaseCard',false],['EventCard','EventCard',true],['NonLeaderUnitCard','NonLeaderUnitCard',true],['UpgradeCard','UpgradeCard',true],['LeaderUnitCard','LeaderUnitCard',true],['TokenCards','TokenUnitCard',true],['TokenCards','TokenUpgradeCard',true],['TokenCards','TokenCard',true]];
    for(const [file,name,expected] of classes){
        const cls=require(path.join(engine,'build/server/game/core/card',file+'.js'))[name];
        // The actual method is a pure type guard; varying an own cost demonstrates
        // that numerical truthiness is not its implementation.
        for(const cost of [0,3]) {
            const receiver=Object.create(cls.prototype);
            Object.defineProperty(receiver,'cost',{value:cost});
            assert.equal(receiver.hasCost(),expected,name+' cost '+cost);
        }
    }
});
test('full pinned sources convert six cards and retain four remaining mechanic rejections',()=>{
    const entries=[
        ['09_HMW/units/DookusSolarSailerDroidArmyPortent.ts',null],
        ['09_HMW/units/SandcrawlerSalesTeam.ts',null],
        ['09_HMW/units/FrenziedTriFighters.ts',null],
        ['06_IBH/events/WatchThis.ts',null],
        ['06_SEC/units/InnerRimCoalition.ts',null],
        ['07_TS26/upgrades/Underestimated.ts',null],
        ['08_ASH/units/TraskWalker.ts','immediateEffect:chooseModalEffects'],
        ['02_SHD/events/EvidenceOfTheCrime.ts','named-target-card-domain'],
        ['03_TWI/units/OsiSobeckWardenOfTheCitadel.ts','immediateEffect:capture'],
        ['04_JTL/leaders/AdmiralTrenchChkchkchkchk.ts','method:deployActionAbilityProps'],
    ];
    for(const [file,remaining] of entries){
        const relative='game/cards/'+file;
        const card=compileSource(fs.readFileSync(path.join(engine,'server',relative),'utf8'),relative,enums);
        assert.equal(card.status,remaining?'unsupported':'supported',file+':'+JSON.stringify(card.diagnostics));
        assert.ok(!card.diagnostics.some(d=>d.pattern==='unsupported-query:hasCost'));
        if(remaining)assert.ok(card.diagnostics.some(d=>d.pattern===remaining),JSON.stringify(card.diagnostics));
    }
});


test('catalog capability inventory includes attachment-only cost predicates',()=>{
    const entry=compileCatalog().cards.find(c=>c.setCode==='TS26_079');
    assert.ok(entry.requiredCapabilities.includes('query:hasCost'));
    assert.ok(entry.requiredCapabilities.includes('ref:card.cost'));
    assert.ok(entry.requiredCapabilities.includes('binary:<='));
});
