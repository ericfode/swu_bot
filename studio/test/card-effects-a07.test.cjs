const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createRequire } = require('node:module');
const ts = require('../../viewer/node_modules/typescript');
const modules = new Map();
function loadTS(filename) {
    filename = path.resolve(filename); if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} }; modules.set(filename, module);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const local = createRequire(filename);
    new Function('require', 'module', 'exports', code)(specifier => {
        const candidate = path.resolve(path.dirname(filename), `${specifier}.ts`);
        return specifier.startsWith('.') && fs.existsSync(candidate) ? loadTS(candidate) : local(specifier);
    }, module, module.exports); return module.exports;
}
const {A07_DEFINITIONS,A07_COSTS,a07ShowcaseState,a07PreviewOutcomes,a07PreviewPayment,a07PhaseEndOutcomes,a07RegroupOutcomes}=loadTS(path.join(__dirname,'../src/effects/batchA07.ts'));
const {resolvePreviewState}=loadTS(path.join(__dirname,'../src/effects/previewState.ts'));
const {previewPlayCost,previewExtraPayment}=loadTS(path.join(__dirname,'../src/effects/previewCosts.ts'));
const {showcaseAbilities}=loadTS(path.join(__dirname,'../src/effects/abilities.ts'));
const clone=structuredClone,ids=a=>a.map(c=>c.id),definition=id=>A07_DEFINITIONS.find(c=>c.id===id);
function staged(id,change,choices,changeCue){const d=definition(id),before=a07ShowcaseState(d);if(change)change(before);const cue={definition:d,seat:'p1',source:before.players.p1.hand.find(c=>c.s===d.setCode),target:null,key:'a07:test',playPayment:a07PreviewPayment(d,before,'p1'),outcomes:a07PreviewOutcomes(d,before,'p1',choices??{})};if(changeCue)changeCue(cue,before);const saved=clone(before),savedCue=clone(cue),after=resolvePreviewState(before,cue);assert.deepEqual(before,saved);assert.deepEqual(cue,savedCue);assert.deepEqual(resolvePreviewState(before,cue),after);return{d,before,cue,after,p:after.players.p1,q:after.players.p2};}
const physical=s=>Object.values(s.players).flatMap(p=>[p.base,...(p.leader?.dep===0?[p.leader]:[]),...p.hand,...p.discard,...(p.knownDeck??[]),...(p.resources??[]),...p.ground,...p.space,...[...p.ground,...p.space].flatMap(c=>[...(c.u??[]),...(c.cap??[])])]);
const cardDir=path.join(__dirname,'../../forceteki/test/json/Card'),sourceCards=fs.readdirSync(cardDir).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(cardDir,f))));
const byPrint=new Map(sourceCards.flatMap(c=>(c.setCodes??[]).map(p=>[`${p.set}_${String(p.number).padStart(3,'0')}`,c])));
function boundary(r,stage,change){const before=clone(r.after);if(stage==='regroup-start')before.phase='regroup';const cue={definition:r.d,seat:'p1',source:null,target:null,key:`a07:${stage}`,stage,outcomes:stage==='phase-end'?a07PhaseEndOutcomes(r.d,before,'p1'):a07RegroupOutcomes(r.d,before,'p1')};if(change)change(cue,before);const old=clone(before),after=resolvePreviewState(before,cue);assert.deepEqual(before,old);return{before,cue,after};}

test('A07 exact identities, all sole aliases, costs/aspect occurrences and supporting real stats/traits match installed JSON',()=>{
 const canonical=['7212445649','5696041568','7578472075','5283722046','4717189843','1910812527','2750823386','6151970296','0931441928','4663781580'];
 A07_DEFINITIONS.forEach((d,i)=>{const j=byPrint.get(d.setCode);assert.equal(j.id,canonical[i]);assert.equal(j.title,d.name);assert.equal(j.unique,false);assert.equal(j.setCodes.length,1);assert.deepEqual(A07_COSTS[d.id],{printed:j.cost,aspects:j.aspects});const b=a07ShowcaseState(d);for(const p of Object.values(b.players)){assert.equal(p.resources.length,p.res.total);assert.equal(p.resources.filter(c=>!c.x).length,p.res.ready);assert.equal(p.knownDeck.length,p.deck);for(const u of [...p.ground,...p.space]){const f=byPrint.get(u.s),power=f.power+(u.u??[]).reduce((n,x)=>n+(x.p??0),0),hp=f.hp+(u.u??[]).reduce((n,x)=>n+(x.h??0),0);assert.equal(u.p,power);assert.equal(u.h,hp);assert.equal(u.incarnation,`${u.id}:entry-1`);assert.equal(f.arena,p.ground.includes(u)?'ground':'space');for(const upgrade of u.u??[])if(upgrade.s){const k=byPrint.get(upgrade.s);assert.equal(upgrade.n,k.title);assert.equal(upgrade.p,k.power);assert.equal(upgrade.h,k.hp);}}}});
 assert.ok(byPrint.get('SHD_200').traits.includes('wookiee'));assert.ok(byPrint.get('SOR_247').traits.includes('underworld'));assert.equal(byPrint.get('SOR_247').id,byPrint.get('SHD_257').id);assert.ok(byPrint.get('SHD_068').traits.includes('bounty'));assert.ok(byPrint.get('SHD_068').types.includes('upgrade'));
});

test('A07 all complete primary boards pay once, conserve real cards, preserve owners and repeat deterministically',()=>{
 const costs=[5,7,4,5,6,10,2,3,3,3];A07_DEFINITIONS.forEach((d,i)=>{const r=staged(d.id);assert.equal(previewPlayCost(d,r.before),costs[i]);assert.equal(r.before.players.p1.res.ready-r.p.res.ready,costs[i]);assert.equal(previewExtraPayment(d),0);const before=ids(physical(r.before)).filter(id=>id!=='a07:swoop:shield').sort();assert.deepEqual(ids(physical(r.after)).sort(),before);assert.equal(new Set(ids(physical(r.after))).size,physical(r.after).length);assert.equal(r.p.discard.filter(c=>c.id===r.cue.source.id).length,1);assert.ok(!r.p.hand.some(c=>c.id===r.cue.source.id));for(const p of Object.values(r.after.players)){assert.equal(p.resources.length,p.res.total);assert.equal(p.resources.filter(c=>!c.x).length,p.res.ready);}assert.deepEqual(r.p.base,r.before.players.p1.base);assert.deepEqual(r.q.base,r.before.players.p2.base);});
});

test('Bravado requires own attributed enemy-unit defeat this phase, not owner/discard/latest-entry membership',()=>{
 const r=staged('bravado');assert.deepEqual([r.p.space[0].p,r.p.space[0].h,r.p.space[0].d,r.p.space[0].x],[2,3,2,undefined]);assert.equal(r.cue.outcomes[0].amount,-2);assert.equal(r.q.discard.length,1);assert.ok(!r.cue.outcomes.some(o=>o.kind==='defeat'));
 for(const change of [s=>s.defeatedThisPhase=undefined,s=>s.defeatedThisPhase.round=8,s=>s.defeatedThisPhase.cards[0].controller='p1',s=>s.defeatedThisPhase.cards[0].defeatedBy='p2',s=>s.defeatedThisPhase.cards[0].lastKnownType='upgrade']){const a=staged('bravado',change);assert.equal(a.p.res.ready,3);assert.ok(!a.cue.outcomes.some(o=>o.kind==='cost'));}
 const again=staged('bravado',s=>{const c=s.players.p2.discard.pop();s.players.p2.space.push({...c,p:2,h:1,d:0,incarnation:`${c.id}:entry-2`});s.mostRecentIncarnations={[c.id]:`${c.id}:entry-2`};});assert.equal(again.p.res.ready,5);
 assert.throws(()=>staged('bravado',null,null,c=>{c.outcomes[0].incarnation='wrong';}),/defeat attribution/);
 assert.throws(()=>staged('bravado',null,null,c=>{c.outcomes[0].amount=2;}),/defeat attribution/);
});

test('Raid keeps private top7, explicit zero payment and ready direct deck entry, then separately returns only that continuing entry',()=>{
 const r=staged('triple-dark-raid'),x=r.p.space[1],search=r.cue.outcomes[0];assert.equal(search.deckOperation.visibility,'private');assert.equal(search.deckOperation.revealedIds,undefined);assert.equal(r.p.deck,26);assert.equal(r.p.hand.length,0);assert.deepEqual([x.s,x.p,x.h,x.d,x.x],['SOR_237',2,3,0,undefined]);assert.equal(r.after.pending[0].trigger,'phase-end');assert.equal(x.status[0].duration,'phase');assert.match(x.status[0].label,/phase end/);assert.equal(r.cue.outcomes.find(o=>o.kind==='pay').amount,0);
 const b=boundary(r,'phase-end');assert.equal(b.after.pending.length,0);assert.ok(!b.after.players.p1.space.some(c=>c.id===x.id));assert.equal(b.after.players.p1.hand[0].id,x.id);assert.equal(b.after.players.p1.res.ready,3);assert.equal(b.after.players.p1.deck,26);assert.deepEqual(b.after.players.p2.res,r.q.res);assert.ok(!b.cue.outcomes.some(o=>o.kind==='pay'||o.kind==='draw'||o.kind==='ready'));
 assert.throws(()=>boundary(r,'phase-end',c=>delete c.stage),/explicit boundary/);assert.throws(()=>boundary(r,'phase-end',c=>c.outcomes.unshift(clone(c.outcomes[0]))),/actual pending/);
 const none=staged('triple-dark-raid',null,{takeNothing:true});assert.equal(none.p.deck,27);assert.equal(none.after.pending,undefined);assert.equal(none.p.space.length,1);
});

test('Raid return follows owner after control change and never acts on a fresh same-ID entry',()=>{
 const r=staged('triple-dark-raid'),x=r.p.space[1];const stolen=clone(r.after);stolen.players.p1.space.pop();stolen.players.p2.space.push(x);const outcomes=a07PhaseEndOutcomes(r.d,stolen,'p1');const after=resolvePreviewState(stolen,{definition:r.d,seat:'p1',source:null,target:null,key:'stolen',stage:'phase-end',outcomes});assert.equal(after.players.p1.hand[0].id,x.id);assert.ok(!after.players.p2.hand.some(c=>c.id===x.id));
 const later=clone(r.after);later.players.p1.space[1].incarnation=`${x.id}:entry-2`;const cue={definition:r.d,seat:'p1',source:null,target:null,key:'later',stage:'phase-end',outcomes:a07PhaseEndOutcomes(r.d,later,'p1')};assert.equal(cue.outcomes.length,1);const end=resolvePreviewState(later,cue);assert.equal(end.pending.length,0);assert.equal(end.players.p1.space[1].incarnation,`${x.id}:entry-2`);assert.equal(end.players.p1.hand.length,0);
});

test('Wookiee mode is P2 choice, target P1 choice and attack-only trait boost; non-Wookiee only readies',()=>{
 const r=staged('let-the-wookiee-win'),a=r.p.ground[1];assert.deepEqual([a.p,a.h,a.d,a.x],[3,5,4,1]);assert.equal(r.cue.outcomes[0].choice.chooser,'p2');assert.equal(r.cue.outcomes[0].chooserSeat,'p1');assert.equal(r.cue.outcomes.find(o=>o.kind==='attack').sourceCard.x,undefined);assert.ok(r.q.discard.some(c=>c.id==='a07:p2:trooper'));assert.ok(!a.status?.some(s=>s.duration==='attack'));
 const normal=staged('let-the-wookiee-win',s=>s.players.p1.ground[0].x=1,{targetId:'a07:p1:marine'});assert.equal(normal.p.ground[0].x,undefined);assert.ok(!normal.cue.outcomes.some(o=>o.kind==='attack'));
 assert.throws(()=>staged('let-the-wookiee-win',null,null,c=>c.outcomes[0].choice.chooser='p1'),/mode chooser/);
});

test('Resource-ready alternative flips actual exhausted IDs without gains; source payment occurs before availability cap',()=>{
 const r=staged('let-the-wookiee-win',s=>{s.players.p1.res.ready=4;s.players.p1.resources.forEach((c,i)=>{if(i>=4)c.x=1;});},{mode:'resources'});assert.equal(r.p.res.ready,6);assert.equal(r.p.res.total,10);assert.equal(r.p.deck,27);assert.equal(r.cue.outcomes[0].cards.length,6);assert.ok(!r.cue.outcomes.some(o=>o.kind==='attack'));assert.deepEqual(ids(r.p.resources),ids(r.before.players.p1.resources));const cap=staged('let-the-wookiee-win',null,{mode:'resources'});assert.equal(cap.cue.outcomes[0].amount,4);assert.equal(cap.p.res.ready,10);
 assert.throws(()=>staged('let-the-wookiee-win',null,{mode:'resources'},c=>{c.outcomes[0].cards.push(c.outcomes[0].cards[0]);c.outcomes[0].amount++;}),/unique stable/);
});

test('Spare returns to owner hand and independently collects actual before-host Death Mark, no invented defeat',()=>{
 const r=staged('spare-the-target');assert.ok(!r.q.ground.some(c=>c.id==='a07:p2:wampa'));assert.ok(r.q.hand.some(c=>c.id==='a07:p2:wampa'));assert.deepEqual(ids(r.p.hand),['a07:spare:draw:0','a07:spare:draw:1']);assert.equal(r.p.deck,25);assert.ok(r.p.discard.some(c=>c.id==='a07:spare:death-mark'));assert.ok(!r.cue.outcomes.some(o=>o.kind==='defeat'));const no=staged('spare-the-target',s=>{s.players.p2.ground[1].u=undefined;});assert.equal(no.p.deck,27);assert.equal(no.cue.outcomes.length,1);
 const independent=staged('spare-the-target',null,null,c=>{c.outcomes=c.outcomes.filter(o=>o.kind!=='return');});assert.ok(independent.q.ground.some(c=>c.id==='a07:p2:wampa'));assert.equal(independent.p.deck,25);
 assert.throws(()=>staged('spare-the-target',null,null,c=>{c.outcomes[1].bountyResolution.abilitySourceId='missing';}),/Death Mark grant/);
 assert.throws(()=>staged('spare-the-target',null,null,c=>{c.outcomes[1].bountyResolution.collector='p2';}),/collector/);
});

test('Adventure owner chooses explicit free clean replay after actual return; decline and missing prerequisites preserve boundaries',()=>{
 const r=staged('a-new-adventure'),w=r.q.ground[1];assert.deepEqual([w.owner,w.p,w.h,w.d,w.x,w.incarnation],['p2',4,5,0,1,'a07:p2:wampa:entry-2']);assert.equal(w.u,undefined);assert.equal(w.status,undefined);assert.equal(r.q.hand.length,1);assert.equal(r.q.res.ready,7);assert.ok(r.p.discard.some(c=>c.id==='a07:adventure:academy'));assert.equal(r.after.mostRecentIncarnations[w.id],w.incarnation);
 const decline=staged('a-new-adventure',null,{replay:false});assert.equal(decline.q.hand.length,2);assert.ok(!decline.cue.outcomes.some(o=>o.kind==='play'||o.kind==='pay'));
 assert.throws(()=>staged('a-new-adventure',null,null,c=>{c.outcomes=c.outcomes.filter(o=>o.kind!=='return');}),/prior owner-hand return/);
 assert.throws(()=>staged('a-new-adventure',null,null,c=>{c.outcomes=c.outcomes.filter(o=>o.kind!=='pay');}),/zero payment/);
 assert.throws(()=>staged('a-new-adventure',null,null,c=>{c.outcomes.find(o=>o.kind==='play').unit.d=1;}),/clean fresh/);
});

test('Final is ongoing after all controlled units ready; only explicit regroup yields persistent player loss with no extra game actions',()=>{
 const r=staged('final-showdown');assert.equal(r.p.res.ready,0);assert.ok([...r.p.ground,...r.p.space].every(c=>!c.x));assert.equal(r.q.ground[0].x,1);assert.equal(r.after.matchResult,undefined);assert.equal(r.after.pendingPlayers.length,1);
 const b=boundary(r,'regroup-start');assert.deepEqual(b.after.matchResult,{winner:'p2',loser:'p1',reason:'card-effect',sourceId:r.cue.source.id});assert.equal(b.after.pendingPlayers.length,0);assert.deepEqual(b.after.players,r.after.players);assert.throws(()=>boundary(r,'regroup-start',c=>delete c.stage),/supplied regroup boundary/);assert.throws(()=>resolvePreviewState(b.after,b.cue),/prior obligation/);
 const prior=clone(r.after);prior.matchResult={winner:'p1',loser:'p2',reason:'card-effect',sourceId:'actual-prior-win'};assert.deepEqual(a07RegroupOutcomes(r.d,prior,'p1'),[]);assert.deepEqual(resolvePreviewState(prior,{...b.cue,outcomes:[]}).matchResult,prior.matchResult);
});

test('Look keeps P1 event2 separate from P2 pay2 and rejects wrong or unaffordable controller choice',()=>{
 const r=staged('look-the-other-way');assert.equal(r.p.res.ready,8);assert.equal(r.q.res.ready,5);assert.equal(r.q.ground[1].x,undefined);assert.equal(previewExtraPayment(r.d),0);assert.equal(showcaseAbilities(r.d.id)[0].payer,'opponent');assert.deepEqual(ids(r.cue.outcomes[0].cards),['a07:p2:resource:0','a07:p2:resource:1']);const exhaust=staged('look-the-other-way',null,{payUnless:false});assert.equal(exhaust.q.res.ready,7);assert.equal(exhaust.q.ground[1].x,1);
 assert.throws(()=>staged('look-the-other-way',s=>{s.players.p2.res.ready=1;s.players.p2.resources.forEach((c,i)=>{if(i>0)c.x=1;});},{payUnless:true}),/cannot afford/);assert.throws(()=>staged('look-the-other-way',null,null,c=>c.outcomes[0].choice.controller='p1'),/actual target controller/);
 const own=staged('look-the-other-way',null,{targetId:'a07:p1:marine'});assert.equal(own.p.res.ready,6);assert.equal(own.q.res.ready,7);assert.equal(own.p.ground[0].x,undefined);
});

test('Posting performs private whole shuffle, selected reveal/draw and actual normal paid0 hand upgrade play; no Shield now',()=>{
 const r=staged('bounty-posting'),search=r.cue.outcomes[0].deckOperation,u=r.q.ground[1].u[0];assert.equal(search.scope,'whole');assert.equal(search.visibility,'private');assert.deepEqual(search.revealedIds,['a07:posting:public-enemy']);assert.equal(r.p.deck,26);assert.equal(r.p.hand.length,0);assert.deepEqual([u.id,u.owner,u.controller,u.t,u.p,u.h],['a07:posting:public-enemy','p1','p1',0,0,0]);assert.deepEqual([r.q.ground[1].p,r.q.ground[1].h,r.q.ground[1].d,r.q.ground[1].x],[4,5,1,undefined]);assert.ok(!r.cue.outcomes.some(o=>o.kind==='shield'));assert.equal(r.cue.outcomes.find(o=>o.kind==='play').playAs,'upgrade');
 const decline=staged('bounty-posting',null,{playUpgrade:false});assert.equal(decline.p.hand[0].id,u.id);assert.equal(decline.q.ground[1].u,undefined);const none=staged('bounty-posting',null,{takeNothing:true});assert.equal(none.p.deck,27);assert.equal(none.p.hand.length,0);assert.notDeepEqual(ids(none.p.knownDeck),ids(none.before.players.p1.knownDeck));
 assert.throws(()=>staged('bounty-posting',null,null,c=>{c.outcomes=c.outcomes.filter(o=>o.kind!=='pay');}),/actual paid source/);
 assert.throws(()=>staged('bounty-posting',null,null,c=>{c.outcomes.find(o=>o.kind==='play').upgrade.owner='p2';}),/actual paid source/);
});

test('Ma successful Underworld owner-hand return gates actual three damage without attacking or defeating survivor',()=>{
 const r=staged('ma-klounkee');assert.equal(r.p.hand[0].id,'a07:ma:thug');assert.ok(r.q.discard.some(c=>c.id==='a07:ma:academy'));assert.deepEqual([r.q.ground[1].p,r.q.ground[1].h,r.q.ground[1].d,r.q.ground[1].x],[4,5,4,undefined]);assert.ok(!r.cue.outcomes.some(o=>o.kind==='attack'||o.kind==='defeat'));
 assert.throws(()=>staged('ma-klounkee',null,null,c=>c.outcomes.shift()),/prior owner-hand return/);assert.throws(()=>staged('ma-klounkee',null,{targetId:'a07:p1:defender'}),/Underworld/);assert.throws(()=>staged('ma-klounkee',null,{attackTargetId:'a07:ma:thug'}),/not a unit damage target/);
});

test('Swoop binds cross-arena Saboteur and separate transient attacker/defender power, removes actual Shield before combat',()=>{
 const r=staged('swoop-down'),x=r.p.space[0];assert.deepEqual([x.p,x.h,x.d,x.x],[2,3,2,1]);assert.equal(r.q.ground.length,1);assert.equal(r.q.ground[0].id,'a07:swoop:pyke');assert.ok(r.q.discard.some(c=>c.id==='a07:p2:wampa'));assert.ok(!physical(r.after).some(c=>c.id==='a07:swoop:shield'));const mods=r.cue.outcomes.filter(o=>o.duration==='attack'&&['buff','debuff'].includes(o.kind));assert.deepEqual(mods.map(o=>[o.amount,o.attackRole]),[['+2/+0','attacker'],['−2/−0','defender']]);assert.ok(r.cue.outcomes.findIndex(o=>o.card?.id==='a07:swoop:shield')<r.cue.outcomes.findIndex(o=>o.kind==='damage'));assert.ok(!x.status?.some(s=>s.duration==='attack'));assert.equal(r.cue.outcomes.find(o=>o.kind==='attack').attackArenaPermission,'space-to-ground');
 assert.throws(()=>staged('swoop-down',null,null,c=>{c.outcomes=c.outcomes.filter(o=>o.card?.id!=='a07:swoop:shield');}),/remove actual defender Shields/);
 assert.throws(()=>staged('swoop-down',null,null,c=>{c.outcomes.find(o=>o.kind==='debuff').attackRole='attacker';}),/duplicate modifier/);
 assert.throws(()=>staged('swoop-down',null,null,c=>{c.outcomes.find(o=>o.kind==='damage'&&o.seat==='p1').amount=4;}),/exceeds actual attack-scoped/);
 const floor=staged('swoop-down',null,{attackTargetId:'a07:swoop:pyke'});assert.equal(floor.p.space[0].d,0);const base=staged('swoop-down',null,{attackTargetId:'a07:p2:base'});assert.equal(base.q.base.d,8);assert.ok(!base.cue.outcomes.some(o=>['buff','debuff'].includes(o.kind)));assert.equal(base.cue.outcomes.filter(o=>o.kind==='damage').length,1);
});

test('Owner destinations stay independent of current controller and Bounty upgrade owner',()=>{
 const bounty=staged('spare-the-target',s=>{const u=s.players.p2.ground[1].u[0];u.owner='p2';u.controller='p2';});assert.ok(bounty.q.discard.some(c=>c.id==='a07:spare:death-mark'));assert.equal(bounty.p.hand.length,2);assert.equal(bounty.q.hand.length,2);
 const stolen=staged('ma-klounkee',s=>{s.players.p1.ground[0].owner='p2';});assert.equal(stolen.p.hand.length,0);assert.ok(stolen.q.hand.some(c=>c.id==='a07:ma:thug'));assert.equal(stolen.q.ground[1].d,4);
 const adventure=staged('a-new-adventure',s=>{s.players.p2.ground[1].owner='p1';});assert.ok(adventure.p.ground.some(c=>c.id==='a07:p2:wampa'));assert.ok(!adventure.q.ground.some(c=>c.id==='a07:p2:wampa'));assert.equal(adventure.p.res.ready,4);
});

test('Player loss does not depend on remaining units, while unsupported captor returns reject missing release evidence',()=>{
 const r=staged('final-showdown',s=>{for(const zone of ['ground','space']){s.players.p1.discard.push(...s.players.p1[zone].map(c=>({id:c.id,n:c.n,s:c.s,owner:c.owner})));s.players.p1[zone]=[];}});assert.equal(r.after.pendingPlayers.length,1);assert.equal(r.after.matchResult,undefined);assert.equal(boundary(r,'regroup-start').after.matchResult.winner,'p2');
 assert.throws(()=>staged('ma-klounkee',s=>{const c=s.players.p2.space.pop();s.players.p1.ground[0].cap=[{id:c.id,n:c.n,s:c.s,owner:c.owner}];}),/captor return needs separately supplied release/);
 const raid=staged('triple-dark-raid');raid.after.players.p1.space[1].cap=[{id:'a07:unsupported:captive',n:'Battlefield Marine',s:'SOR_095',owner:'p2'}];assert.throws(()=>boundary(raid,'phase-end'),/separately supplied captive cleanup/);
});

test('Wrong Bounty type and missing cross-arena authority cannot produce a rich staged result',()=>{
 assert.throws(()=>staged('bounty-posting',s=>{Object.assign(s.players.p1.knownDeck[8],{n:'Repair',s:'SOR_074'});}),/source verified/);
 assert.throws(()=>staged('swoop-down',null,null,c=>{delete c.outcomes.find(o=>o.kind==='attack').attackArenaPermission;}),/explicit permission/);
 const space=staged('swoop-down',null,{attackTargetId:'a07:p2:tie'});assert.ok(!space.cue.outcomes.some(o=>['buff','debuff'].includes(o.kind)));assert.equal(space.p.space[0].d,2);assert.ok(space.q.discard.some(c=>c.id==='a07:p2:tie'));assert.equal(space.q.ground[1].u.length,1);
});
