'use strict';
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {Env}=require('../../../env'),{loadPool}=require('../../../omni/rs/pool'),{tokenFixture}=require('./unit-tokens');
const unit=(key,code,owner='own',damage=0)=>({key,code,owner,damage});
function start(c){if(c.scratch.start!==undefined||!c.atWindow||c.pid!==c.own.id||c.chosen.kind!=='card')return;Object.assign(c.scratch,{start:c.eg.game.state.allCards.length,ownDeck:c.own.drawDeck.map(x=>c.eg.cardId(x.uuid)),enemyDeck:c.enemy.drawDeck.map(x=>c.eg.cardId(x.uuid)),ownDamage:c.own.base.damage});}
function created(c,n){
 const allocated=c.eg.game.state.allCards.slice(c.scratch.start).map(id=>c.eg.game.findAnyCardInAnyList(id)),made=allocated.filter(t=>t.internalName==='mandalorian'),shields=allocated.filter(t=>t.internalName==='shield');
 assert.equal(allocated.length,n*2,'Mandalorians plus printed Shielded tokens');assert.equal(made.length,n);assert.equal(shields.length,n);assert.equal(new Set(allocated.map(t=>t.uuid)).size,n*2);
 for(const t of made){assert.equal(t.owner.id,c.own.id);assert.equal(t.controller.id,c.own.id);assert.equal(t.zoneName,'groundArena');assert.equal(t.exhausted,true);assert.equal(t.getPower(),2);assert.equal(t.getHp(),2);assert.equal(t.hasSomeKeyword('shielded'),true);assert.equal(t.hasSomeKeyword('sentinel'),false,'No intrinsic Sentinel in pinned printed data');assert.deepEqual(t.cardData.traits,['mandalorian']);assert.deepEqual(t.cardData.aspects,['vigilance']);assert.equal(t.upgrades.length,1);assert.equal(t.upgrades[0].internalName,'shield');assert.ok(shields.includes(t.upgrades[0]));}
 c.observed.createdIds=made.map(t=>c.eg.cardId(t.uuid));c.observed.attachedShieldIds=made.map(t=>c.eg.cardId(t.upgrades[0].uuid));c.observed.printedShielded=n>0;c.observed.noIntrinsicSentinel=true;
}
const scenarios=[
{name:'children-two-distinct-exhausted-mandalorians',family:'create-mandalorian',actualScriptedCardIds:['ASH_111'],units:[],baseDamage:0,plan:[{code:'ASH_111'}],beforeApply:start,assertAfter:c=>created(c,2)},
{name:'duchess-death-mandalorian',family:'create-mandalorian-death',actualScriptedCardIds:['ASH_058'],units:[unit('source','ASH_058')],baseDamage:0,plan:[{code:'SOR_077',target:'source'}],beforeApply:start,assertAfter:c=>{assert.equal(c.targets.source.zoneName,'discard');created(c,1);}},
...[false,true].map(p=>({name:'protectorate-fighter-condition-'+(p?'true':'false'),family:'conditional-create-mandalorian',actualScriptedCardIds:['ASH_124'],units:p?[unit('unique','JTL_117')]:[],baseDamage:0,plan:[{code:'ASH_124'}],beforeApply:c=>{start(c);if(c.atWindow&&!c.observed.postAction)assert.equal(c.own.getArenaUnits().some(u=>u.unique),p);},assertAfter:c=>created(c,p?1:0)})),
...[false,true].map(empty=>({name:'bracca-explicit-self-deck-'+(empty?'empty-no-fatigue':'top-discard'),family:'scalar-discard-deck',actualScriptedCardIds:['LAW_192'],units:[unit('source','LAW_192')],baseDamage:0,emptyOwnDeck:empty,plan:[{code:'LAW_192',from:'source'}],beforeApply:start,choose:c=>c.actions.find(a=>a.cardUuid===c.enemy.base.uuid),assertAfter:c=>{assert.deepEqual(c.own.drawDeck.map(x=>c.eg.cardId(x.uuid)),c.scratch.ownDeck.slice(empty?0:1));assert.deepEqual(c.enemy.drawDeck.map(x=>c.eg.cardId(x.uuid)),c.scratch.enemyDeck);assert.equal(c.own.base.damage,c.scratch.ownDamage);if(!empty)assert.ok(c.own.getCardsInZone('discard').some(x=>c.eg.cardId(x.uuid)===c.scratch.ownDeck[0]));c.observed.discardedIds=c.scratch.ownDeck.slice(0,empty?0:1);c.observed.opponentDeckUnchanged=true;c.observed.noFatigue=true;}})),
{name:'protector-parent-grant-and-removal',family:'attached-keyword',actualScriptedCardIds:['SOR_057'],units:[unit('parent','ASH_261')],baseDamage:0,plan:[{code:'SOR_057',target:'parent'},{code:'SOR_077',target:'parent'}],beforeApply:c=>{start(c);if(c.pending.code==='SOR_057'&&c.atWindow)assert.equal(c.targets.parent.hasSomeKeyword('sentinel'),false);if(c.pending.code==='SOR_077'&&c.atWindow){assert.equal(c.targets.parent.hasSomeKeyword('sentinel'),true);assert.equal(c.targets.parent.upgrades.length,1);c.observed.attachedSentinel=true;}},assertAfter:c=>{assert.ok(c.observed.attachedSentinel);assert.equal(c.targets.parent.zoneName,'discard');assert.equal(c.targets.parent.hasSomeKeyword('sentinel'),false);c.observed.grantRemoved=true;}}
];
// Source-derived boundary: contingent Mandalorians enter as one event batch;
// state resolution enables Shielded, applies Snoke and queues HP-zero defeats.
// The defeat subwindow precedes captured Shielded ability resolution. Its give
// system cannot affect a unit outside play, therefore it allocates no Shields.
scenarios.push({name:'children-mandalorian-entry-snoke-stat-death-before-shielded',family:'create-mandalorian-shielded-stat-death',actualScriptedCardIds:['ASH_111','SHD_037'],units:[unit('snoke','SHD_037','enemy')],baseDamage:0,plan:[{code:'ASH_111'}],beforeApply:c=>{
 start(c);
 if(!c.scratch.probeRegistered&&c.atWindow&&c.pid===c.own.id){
  c.scratch.probeRegistered=true;c.scratch.boundaryEvents=[];
  for(const name of ['onUnitEntersPlay','onCardDefeated','onTokensCreated'])c.eg.game.on(name,e=>{
   if(c.observed.postAction)return;
   if(name==='onTokensCreated'){c.scratch.boundaryEvents.push({name,allocated:c.eg.game.state.allCards.length,tokenType:e.tokenType});return;}
   if(e.card?.internalName==='mandalorian')c.scratch.boundaryEvents.push({name,id:c.eg.cardId(e.card.uuid),zone:e.card.zoneName,exhausted:e.card.isInPlay()?e.card.exhausted:null});
  });
 }
},assertAfter:c=>{
 const allocated=c.eg.game.state.allCards.slice(c.scratch.start).map(id=>c.eg.game.findAnyCardInAnyList(id));
 assert.equal(allocated.length,2,'No Shield IDs allocated for dead Mandalorians');
 assert.deepEqual(allocated.map(t=>c.eg.cardId(t.uuid)),['c'+c.scratch.start,'c'+(c.scratch.start+1)]);
 for(const t of allocated){assert.equal(t.internalName,'mandalorian');assert.equal(t.zoneName,'outsideTheGame');assert.equal(t.owner.id,c.own.id);assert.equal(t.controller.id,c.own.id);}
 const boundaries=c.scratch.boundaryEvents.filter(e=>e.name!=='onTokensCreated');
 assert.deepEqual(boundaries.map(e=>e.name),['onUnitEntersPlay','onUnitEntersPlay','onCardDefeated','onCardDefeated']);
 assert.deepEqual(boundaries.slice(0,2).map(e=>e.zone),['groundArena','groundArena']);
 assert.ok(boundaries.slice(0,2).every(e=>e.exhausted));
 assert.deepEqual(boundaries.slice(2).map(e=>e.zone),['outsideTheGame','outsideTheGame']);
 c.observed.boundaryEvents=c.scratch.boundaryEvents;c.observed.createdIds=allocated.map(t=>c.eg.cardId(t.uuid));c.observed.noShieldsAllocated=true;c.observed.bothEntriesBeforeStatDeaths=true;
}});
// Controller-relative grants apply to the actual parent, including enemy parents.
for(const enemy of [false,true]) scenarios.push({name:'devotion-numeric-stack-'+(enemy?'enemy':'own')+'-parent',family:'attached-numeric-keyword',actualScriptedCardIds:['SOR_069'],units:[unit('parent','ASH_261',enemy?'enemy':'own')],baseDamage:0,plan:[{code:'SOR_069',target:'parent'},{code:'SOR_069',target:'parent'}],beforeApply:c=>{start(c);if(c.atWindow&&c.index===1)assert.equal(c.targets.parent.hasSomeKeyword('restore'),false);if(c.atWindow&&c.index===2){assert.equal(c.targets.parent.getKeywordsWithNumericValues('restore').reduce((n,k)=>n+k.value,0),2);c.observed.oneGrant=2;}},assertAfter:c=>{assert.equal(c.targets.parent.upgrades.length,2);assert.equal(c.targets.parent.getKeywordsWithNumericValues('restore').reduce((n,k)=>n+k.value,0),4);assert.equal(c.targets.parent.controller.id,enemy?c.enemy.id:c.own.id);c.observed.stackedRestore=4;}});
scenarios.push({name:'mark-my-words-damaged-attach-legality-mixed-controller',family:'attach-condition',actualScriptedCardIds:['ASH_181'],units:[unit('parent','ASH_261','enemy',1),unit('invalid','ASH_261'),unit('validOwn','ASH_261','own',1)],baseDamage:0,plan:[{code:'ASH_181',target:'parent'}],beforeApply:start,choose:c=>{if(c.actions.some(a=>a.cardUuid===c.targets.parent.uuid)){assert.ok(c.actions.some(a=>a.cardUuid===c.targets.validOwn.uuid));assert.ok(!c.actions.some(a=>a.cardUuid===c.targets.invalid.uuid));c.observed.damagedOwnAndEnemyLegal=true;c.observed.undamagedIllegal=true;return c.actions.find(a=>a.cardUuid===c.targets.parent.uuid);}},assertAfter:c=>{assert.ok(c.observed.damagedOwnAndEnemyLegal);assert.ok(c.observed.undamagedIllegal);assert.equal(c.targets.parent.hasSomeKeyword('overwhelm'),true);assert.equal(c.targets.parent.upgrades.length,1);}});
module.exports = { scenarios, fixture: tokenFixture };
