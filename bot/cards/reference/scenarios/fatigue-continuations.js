'use strict';
const assert=require('node:assert/strict');
const { tokenFixture }=require('./unit-tokens');
const { canonicalAction }=require('../../../omni/rs/state');
const scenarios=[0,1].map(n=>{let initialTop;
const s={name:'draw-two-deck-'+n+'-then-mandatory-discard',family:'draw-partial-or-empty-then-discard',units:[],baseDamage:0,beforeWindow:c=>{if(c.step===0){initialTop=n?c.eg.cardId(c.own.drawDeck[0].uuid):null;for(const card of c.own.drawDeck.slice(n))card.moveTo('discard');c.eg.game.resolveGameState(true);c.eg.game.continue();}},plan:[{code:'IBH_074'}],beforeApply:c=>{if(c.atWindow&&c.pending?.code==='IBH_074'&&c.scratch.hand===undefined){assert.equal(c.own.drawDeck.length,n);c.scratch.hand=c.own.getCardsInZone('hand').length;c.scratch.top=initialTop;c.scratch.enemyHand=c.enemy.getCardsInZone('hand').length;}},choose:c=>{
   assert.equal(c.pid,c.own.id);assert.equal(c.eg.player(c.pid).currentPrompt().menuTitle,"Choose a card to discard for I Want Proof, Not Leads's effect");
   assert.equal(c.own.base.damage,3*(2-n));assert.equal(c.own.drawDeck.length,0);assert.equal(c.own.getCardsInZone('hand').length,c.scratch.hand-1+n);
   const hand=c.own.getCardsInZone('hand');assert.ok(hand.length>1);assert.deepEqual(c.actions.map(a=>a.kind),hand.map(()=> 'card'));assert.deepEqual(c.actions.map(a=>a.cardUuid).sort(),hand.map(a=>a.uuid).sort());
   if(n)assert.ok(hand.some(x=>c.eg.cardId(x.uuid)===c.scratch.top));c.observed.discardMenu=c.actions.map(a=>canonicalAction(c.eg,a));c.observed.fatigueBeforeDiscard=c.own.base.damage;c.scratch.chosen=c.eg.cardId(c.actions[0].cardUuid);return c.actions[0];
  },assertAfter:c=>{assert.ok(c.observed.discardMenu);assert.equal(c.own.base.damage,3*(2-n));assert.equal(c.own.drawDeck.length,0);assert.equal(c.own.getCardsInZone('hand').length,c.scratch.hand+n-2);assert.equal(c.enemy.getCardsInZone('hand').length,c.scratch.enemyHand);assert.ok(c.own.getCardsInZone('discard').some(x=>c.eg.cardId(x.uuid)===c.scratch.chosen));c.observed.actualDrawn=n;c.observed.chosenDiscardId=c.scratch.chosen;c.observed.mandatoryDiscardResolved=true;}};
s.actualScriptedCardIds=['IBH_074'];s.initialOwnDrawDeckCount=n;return s;});
async function fixture(env,pool,scenario,seed){const result=await tokenFixture(env,pool,scenario,seed);result.records[0].fixtureConstruction+=' Trim p1 draw deck to '+scenario.initialOwnDrawDeckCount+' at the first recorded action boundary before first state/input; no subsequent direct edits.';result.records[0].constructionParameters.initialOwnDrawDeckCount=scenario.initialOwnDrawDeckCount;return result;}
module.exports={scenarios,fixture};
