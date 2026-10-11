const fs=require('fs'),zlib=require('zlib'),assert=require('assert/strict');
const ws='/Users/ericfode/.codex/worktrees/omni-rs/swu_bot';
const {Env}=require(ws+'/bot/env'); const {loadPool}=require(ws+'/bot/omni/rs/pool'); const {tokenFixture}=require(ws+'/bot/omni/rs/make-token-unit-fixtures');
(async()=>{
const pool=loadPool(ws+'/bot/omni-rs/tests/card-batches/003/incidental/pool.json');
const s={name:'SYNTHETIC-empty-draw-before-heal-at-base1',family:'SYNTHETIC-draw-contingent-handler-order',units:[],baseDamage:1,emptyOwnDeck:true,plan:[{code:'SOR_077'}],beforeApply:c=>{
 if(!c.scratch.registered&&c.atWindow&&c.pid===c.own.id&&c.chosen.kind==='card'){
  const h=require(ws+'/forceteki/build/server/game/AbilityHelper').getAbilityHelper(c.eg.game);
  c.scratch.hand=c.own.getCardsInZone('hand').length;
  c.scratch.incoming.setEventAbility({title:'SYNTHETIC Draw then Heal',immediateEffect:h.immediateEffects.simultaneous([h.immediateEffects.draw({target:c.own,amount:1}),h.immediateEffects.heal({target:c.own.base,amount:3})])});c.scratch.registered=true;
 }
},assertAfter:c=>{c.observed.damageAfterGroup=c.own.base.damage;c.observed.handDelta=c.own.getCardsInZone('hand').length-c.scratch.hand;c.observed.winnerAtAfterGroup=c.eg.winner;assert.equal(c.own.drawDeck.length,0);console.log(JSON.stringify({observed:c.observed}));}};
const r=await tokenFixture(new Env(),pool,s,23101);r.records[0].evidenceStatus='SYNTHETIC ENGINE DIAGNOSTIC only; no printed-card claim';r.records[0].syntheticRegistration='At initial action input only replace SOR077 eventAbility with simultaneous Draw1 ownPlayer then Heal3 ownBase; initial own deck empty, both bases damage1.';
fs.writeFileSync('/private/tmp/swu-draw-heal-review-diagnostic-base1.jsonl.gz',zlib.gzipSync(r.records.map(x=>JSON.stringify(x)).join('\n')+'\n'));fs.writeFileSync('/private/tmp/swu-draw-heal-review-diagnostic-base1-observed.json',JSON.stringify(r.witness,null,2)+'\n');console.log(JSON.stringify(r.witness));
})().catch(e=>{console.error(e);process.exitCode=1});
