'use strict';
const fs=require('node:fs'),zlib=require('node:zlib'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root='/Users/ericfode/.codex/worktrees/omni-rs/swu_bot';
const {Env}=require(root+'/bot/env');
const {loadPool}=require(root+'/bot/omni/rs/pool');
const {tokenFixture}=require(root+'/bot/omni/rs/make-token-unit-fixtures');
const {canonicalAction}=require(root+'/bot/omni/rs/state');
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
async function main(){
 const out='/private/tmp/swu-low-proof-boundaries';assert.ok(!fs.existsSync(out));fs.mkdirSync(out);const poolFile=root+'/bot/card-compiler/generated/runtime-pool.json';fs.copyFileSync(poolFile,out+'/pool.json');const pool=loadPool(out+'/pool.json');const witnesses=[];
 for(const n of [0,1]){
  const env=new Env(),original=env.newGame.bind(env);let initialTop;
  const s={name:'low-proof-draw-two-deck-'+n+'-then-mandatory-discard',family:'draw-partial-or-empty-then-discard',units:[],baseDamage:0,beforeWindow:c=>{if(c.step===0){initialTop=n?c.eg.cardId(c.own.drawDeck[0].uuid):null;for(const card of c.own.drawDeck.slice(n))card.moveTo('discard');c.eg.game.resolveGameState(true);c.eg.game.continue();}},plan:[{code:'IBH_074'}],beforeApply:c=>{if(c.atWindow&&c.pending?.code==='IBH_074'&&c.scratch.hand===undefined){assert.equal(c.own.drawDeck.length,n);c.scratch.hand=c.own.getCardsInZone('hand').length;c.scratch.top=initialTop;c.scratch.enemyHand=c.enemy.getCardsInZone('hand').length;}},choose:c=>{
   assert.equal(c.pid,c.own.id);assert.equal(c.eg.player(c.pid).currentPrompt().menuTitle,"Choose a card to discard for I Want Proof, Not Leads's effect");
   assert.equal(c.own.base.damage,3*(2-n));assert.equal(c.own.drawDeck.length,0);assert.equal(c.own.getCardsInZone('hand').length,c.scratch.hand-1+n);
   const hand=c.own.getCardsInZone('hand');assert.ok(hand.length>1);assert.deepEqual(c.actions.map(a=>a.kind),hand.map(()=> 'card'));assert.deepEqual(c.actions.map(a=>a.cardUuid).sort(),hand.map(a=>a.uuid).sort());
   if(n)assert.ok(hand.some(x=>c.eg.cardId(x.uuid)===c.scratch.top));c.observed.discardMenu=c.actions.map(a=>canonicalAction(c.eg,a));c.observed.fatigueBeforeDiscard=c.own.base.damage;c.scratch.chosen=c.eg.cardId(c.actions[0].cardUuid);return c.actions[0];
  },assertAfter:c=>{assert.ok(c.observed.discardMenu);assert.equal(c.own.base.damage,3*(2-n));assert.equal(c.own.drawDeck.length,0);assert.equal(c.own.getCardsInZone('hand').length,c.scratch.hand+n-2);assert.equal(c.enemy.getCardsInZone('hand').length,c.scratch.enemyHand);assert.ok(c.own.getCardsInZone('discard').some(x=>c.eg.cardId(x.uuid)===c.scratch.chosen));c.observed.actualDrawn=n;c.observed.chosenDiscardId=c.scratch.chosen;c.observed.mandatoryDiscardResolved=true;}};
  const r=await tokenFixture(env,pool,s,23401+n);r.records[0].fixtureConstruction+=' Independent LOW fixture wrapper trims p1 drawDeck to '+n+' at first recorded action boundary before first recorded state/input; no later state or ability edits.';r.records[0].constructionParameters.initialOwnDrawDeckCount=n;const file=s.name+'.jsonl.gz';fs.writeFileSync(out+'/'+file,zlib.gzipSync(r.records.map(x=>JSON.stringify(x)).join('\n')+'\n'));witnesses.push({...r.witness,file,sha256:hash(out+'/'+file),actualScriptedCardIds:['IBH_074'],sharedRelatedCardIds:[],synthetic:false});console.log(JSON.stringify(witnesses.at(-1)));
 }
 fs.writeFileSync(out+'/witnesses.json',JSON.stringify({expectationsSha256:hash('/private/tmp/swu-low-proof-expectations.json'),generatorSha256:hash(__filename),poolSha256:hash(out+'/pool.json'),conformance:'unassessed; await runtime owner fresh binary confirmation',witnesses},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
