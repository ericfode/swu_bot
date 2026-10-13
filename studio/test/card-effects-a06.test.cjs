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
const { A06_DEFINITIONS, A06_COSTS, a06ShowcaseState, a06PreviewOutcomes, a06PreviewPayment, a06NextActionOutcomes } = loadTS(path.join(__dirname,'../src/effects/batchA06.ts'));
const { resolvePreviewState } = loadTS(path.join(__dirname,'../src/effects/previewState.ts'));
const { previewPlayCost, previewExtraPayment } = loadTS(path.join(__dirname,'../src/effects/previewCosts.ts'));
const clone=structuredClone;
const ids=a=>a.map(c=>c.id);
const definition=id=>A06_DEFINITIONS.find(c=>c.id===id);
function cueFor(d,b,choices){return {definition:d,source:b.players.p1.hand.find(c=>c.s===d.setCode),seat:'p1',target:null,key:'a06:test',playPayment:a06PreviewPayment(d,b,'p1'),outcomes:a06PreviewOutcomes(d,b,'p1',choices??{})};}
function staged(id,modify,choices,changeCue){const d=definition(id),before=a06ShowcaseState(d);if(modify)modify(before);const cue=cueFor(d,before,choices);if(changeCue)changeCue(cue,before);const old=clone(before),oldCue=clone(cue),after=resolvePreviewState(before,cue);assert.deepEqual(before,old);assert.deepEqual(cue,oldCue);assert.deepEqual(resolvePreviewState(before,cue),after);return {d,before,cue,after,p:after.players.p1,q:after.players.p2};}
const physical=s=>Object.values(s.players).flatMap(p=>[p.base,...(p.leader?.dep===0?[p.leader]:[]),...p.hand,...p.discard,...(p.resources??[]),...(p.knownDeck??[]),...p.ground,...p.space,...[...p.ground,...p.space].flatMap(u=>[...(u.u??[]),...(u.cap??[])])]);
const cardDir=path.join(__dirname,'../../forceteki/test/json/Card');
const allJSON=fs.readdirSync(cardDir).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(cardDir,f))));
const byPrint=new Map(allJSON.flatMap(c=>(c.setCodes??[]).map(p=>[`${p.set}_${String(p.number).padStart(3,'0')}`,c])));

test('A06 exact titles, sole prints, costs, repeated aspects and real fixture stats match installed JSON',()=>{
  const canon=['6847268098','1701265931','2346145249','3012322434','5896817672','3228620062','8090818642','6962053552','8576088385','4772866341'];
  A06_DEFINITIONS.forEach((d,i)=>{const j=byPrint.get(d.setCode);assert.equal(j.id,canon[i]);assert.equal(j.title,d.name);assert.equal(j.unique,false);assert.equal(j.setCodes.length,1);assert.deepEqual(A06_COSTS[d.id],{printed:j.cost,aspects:j.aspects});const b=a06ShowcaseState(d);for(const side of Object.values(b.players)){for(const u of [...side.ground,...side.space]){const f=byPrint.get(u.s);assert.equal(u.p,f.power);assert.equal(u.h,f.hp);assert.equal(u.incarnation,`${u.id}:entry-1`);assert.equal(f.arena,side.ground.includes(u)?'ground':'space');for(const c of u.cap??[])assert.equal(c.owner,'p1');}assert.equal(side.resources.length,side.res.total);assert.equal(side.resources.filter(c=>!c.x).length,side.res.ready);assert.equal(side.knownDeck.length,side.deck);}});
  assert.ok(byPrint.get('SHD_117').traits.includes('bounty hunter'));
});

test('A06 all ten completed primary states conserve cards, pay exact identities once and repeat without mutation',()=>{
  const amounts=[3,3,7,5,6,4,7,3,5,6];A06_DEFINITIONS.forEach((d,i)=>{const r=staged(d.id);assert.equal(r.before.players.p1.res.ready-r.p.res.ready,amounts[i]);assert.deepEqual(ids(physical(r.after)).sort(),ids(physical(r.before)).sort());assert.equal(new Set(ids(physical(r.after))).size,physical(r.after).length);assert.equal(r.p.discard.filter(c=>c.id===r.cue.source.id).length,1);assert.ok(!r.p.hand.some(c=>c.id===r.cue.source.id));for(const side of Object.values(r.after.players)){assert.equal(side.resources.length,side.res.total);assert.equal(side.resources.filter(c=>!c.x).length,side.res.ready);}assert.equal(previewExtraPayment(d),d.id==='timely-intervention'?2:0);});
});

test('Timely pays hand entry 2 then chosen Ambush readies and resolves simultaneous combat, retaining phase keyword',()=>{
  const {cue,p,q}=staged('timely-intervention'),x=p.space.find(c=>c.id==='a06:timely:new-xwing');assert.equal(x.x,1);assert.equal(x.d,2);assert.equal(x.p,2);assert.equal(x.h,3);assert.equal(x.status[0].keyword.name,'Ambush');assert.equal(x.status[0].duration,'phase');assert.ok(q.discard.some(c=>c.id==='a06:p2:tie'));assert.equal(p.space.find(c=>c.id==='a06:p1:xwing').d,0);assert.equal(cue.outcomes.find(o=>o.kind==='play').entersReady,false);
  const declined=staged('timely-intervention',null,{ambush:false});assert.equal(declined.p.space.find(c=>c.id==='a06:timely:new-xwing').d,0);assert.equal(declined.p.space.find(c=>c.id==='a06:timely:new-xwing').x,1);assert.ok(!declined.cue.outcomes.some(o=>o.kind==='ready'||o.kind==='attack'));
  const noTarget=staged('timely-intervention',s=>{s.players.p2.discard.push(s.players.p2.space.pop());});assert.ok(!noTarget.cue.outcomes.some(o=>o.kind==='ready'));assert.throws(()=>staged('timely-intervention',s=>{s.players.p1.res.ready=2;s.players.p1.resources.forEach((c,i)=>i<2?delete c.x:c.x=1);}),/unaffordable/);
  assert.throws(()=>staged('timely-intervention',null,null,c=>{c.outcomes=c.outcomes.filter(o=>o.kind!=='pay');}),/paid played entry/);
  assert.throws(()=>staged('timely-intervention',null,null,c=>{c.outcomes.find(o=>o.kind==='ready').attackOrigin.incarnation='later';}),/paid played entry/);
});

test('Moment capacity rises by four with unchanged existing scar and ready pose, including enemy target',()=>{
  const a=staged('moment-of-glory');assert.deepEqual([a.p.ground[0].p,a.p.ground[0].h,a.p.ground[0].d,a.p.ground[0].x],[7,7,1,undefined]);assert.equal(a.p.ground[0].status[0].duration,'phase');assert.equal(a.p.ground[0].u,undefined);
  const b=staged('moment-of-glory',null,{targetId:'a06:p2:wampa'});assert.deepEqual([b.q.ground[1].p,b.q.ground[1].h,b.q.ground[1].d],[8,9,1]);
});

test('Choose Sides is an atomic permanent exchange, preserving owners, poses, entries and mixed attachment truth',()=>{
  const a=staged('choose-sides');assert.ok(!a.p.ground.some(c=>c.id==='a06:p1:marine'));assert.deepEqual([a.q.ground[2].owner,a.q.ground[2].d,a.q.ground[2].x,a.q.ground[2].incarnation],['p1',1,undefined,'a06:p1:marine:entry-1']);assert.deepEqual([a.p.space[1].owner,a.p.space[1].x],['p2',1]);assert.ok(!a.after.pending?.length);assert.equal(a.p.space[1].status[0].duration,'permanent');
  const b=staged('choose-sides',s=>{const m=s.players.p1.ground[0];m.u=[{id:'a06:choose:academy',n:'Academy Training',s:'SOR_120',owner:'p2',controller:'p1',t:0,p:2,h:2},{id:'a06:choose:xp',n:'Experience',s:null,owner:'p1',controller:'p1',t:1,p:1,h:1}];m.p=6;m.h=6;});const u=b.q.ground[2].u;assert.deepEqual([u[0].owner,u[0].controller,u[1].owner,u[1].controller],['p2','p1','p2','p2']);assert.deepEqual([b.q.ground[2].p,b.q.ground[2].h,b.q.ground[2].d],[6,6,1]);
  assert.throws(()=>staged('choose-sides',null,null,c=>c.outcomes.pop()),/two exact/);
  assert.throws(()=>staged('choose-sides',null,null,c=>{c.outcomes[0].unit.d=0;}),/preserve stats/);
});
function boundary(first,mutate){const receipts=a06NextActionOutcomes(first.d,first.after,'p1'),cue={definition:first.d,source:null,seat:'p1',target:null,key:'a06:boundary',outcomes:receipts};if(mutate)mutate(cue);return resolvePreviewState(first.after,cue);}

test('Anger immediate damage holds one obligation, ordinary next attack consumes once without event re-payment',()=>{
  const first=staged('give-in-to-your-anger');assert.equal(first.q.ground[0].d,1);assert.equal(first.q.ground[0].x,undefined);assert.equal(first.after.nextActionConstraints.length,1);assert.ok(!first.cue.outcomes.some(o=>o.kind==='attack'));const after=boundary(first);assert.equal(after.players.p1.res.ready,5);assert.equal(after.nextActionConstraints.length,0);assert.ok(after.players.p1.discard.some(c=>c.id==='a06:p1:defender'));assert.ok(after.players.p2.discard.some(c=>c.id==='a06:p2:trooper'));assert.equal(after.players.p1.discard.filter(c=>c.id===first.cue.source.id).length,1);
  assert.throws(()=>boundary(first,c=>{c.outcomes.at(-1).nextAction.witness.player='p1';}),/obligation player/);
  assert.throws(()=>boundary(first,c=>{c.outcomes.at(-1).nextAction.witness.action='other';}),/unsupported or wrong/);
  assert.throws(()=>boundary(first,c=>{c.outcomes.at(-1).nextAction.witness.incarnation='later';}),/bound entry/);
  assert.throws(()=>boundary(first,c=>{c.outcomes.push(clone(c.outcomes.at(-1)));}),/obligation player/);
  const lethal=staged('give-in-to-your-anger',s=>{s.players.p2.ground[0].d=2;});assert.equal(lethal.after.nextActionConstraints,undefined);assert.ok(lethal.q.discard.some(c=>c.id==='a06:p2:trooper'));
});

test('Anger supports only explicit exhausted/departed/phase-end non-attack boundaries and never inherits a later entry',()=>{
  for(const reason of ['exhausted','departed','phase-end']){const first=staged('give-in-to-your-anger'),before=clone(first.after),c=before.nextActionConstraints[0];if(reason==='exhausted')before.players.p2.ground[0].x=1;if(reason==='departed'){before.players.p2.discard.push(before.players.p2.ground.shift());}if(reason==='phase-end')before.phase='regroup';const w={id:'boundary',player:'p2',round:c.round,phase:c.phase,action:reason==='phase-end'?'phase-end':'other',result:reason==='phase-end'?'expired':'unable',...(reason!=='phase-end'?{unableReason:reason}:{})};const cue={definition:first.d,source:null,seat:'p1',target:null,key:'unable',outcomes:[{kind:'restrict',card:null,seat:'p2',nextAction:{operation:'consume',constraintId:c.id,witness:w}}]};assert.equal(resolvePreviewState(before,cue).nextActionConstraints.length,0);if(reason==='exhausted'){const invalid=clone(before);delete invalid.players.p2.ground[0].x;assert.throws(()=>resolvePreviewState(invalid,cue),/witnessed exhaustion/);}}
});

test('An old Anger constraint cannot force the same physical card after a fresh arena entry',()=>{
  const first=staged('give-in-to-your-anger'),later=clone(first.after),unit=later.players.p2.ground[0];unit.incarnation='a06:p2:trooper:entry-2';unit.d=0;delete unit.status;
  assert.throws(()=>a06NextActionOutcomes(first.d,later,'p1'),/same ready entry/);
  const c=later.nextActionConstraints[0],cue={definition:first.d,seat:'p1',source:null,target:null,key:'later-entry',outcomes:[{kind:'restrict',seat:'p2',card:null,nextAction:{operation:'consume',constraintId:c.id,witness:{id:'unable-old-entry',player:'p2',round:9,phase:'action',action:'other',result:'unable',unableReason:'departed'}}}]};
  const after=resolvePreviewState(later,cue);assert.equal(after.nextActionConstraints.length,0);assert.equal(after.players.p2.ground[0].incarnation,'a06:p2:trooper:entry-2');assert.equal(after.players.p2.ground[0].x,undefined);assert.equal(after.players.p2.ground[0].status,undefined);
});

test('Headhunting resolves three ordered attacks, only Hunter boosted, middle attacker lost and resting bonus gone',()=>{
  const a=staged('headhunting');assert.deepEqual(a.cue.outcomes.filter(o=>o.kind==='attack').map(o=>o.attackIndex),[1,2,3]);assert.equal(a.cue.outcomes.filter(o=>o.kind==='buff').length,1);assert.equal(a.p.ground.length,1);assert.deepEqual([a.p.ground[0].p,a.p.ground[0].d,a.p.ground[0].x],[3,3,1]);assert.ok(a.p.discard.some(c=>c.id==='a06:p1:marine'));assert.deepEqual([a.q.ground[0].id,a.q.ground[0].d,a.q.ground[0].x],['a06:p2:wampa',4,undefined]);assert.equal(a.p.space[0].d,2);assert.equal(a.q.space.length,0);assert.deepEqual([a.p.base.d,a.q.base.d],[9,6]);assert.ok(!a.p.ground[0].status?.some(s=>s.duration==='attack'));
  assert.throws(()=>staged('headhunting',null,{attackPairs:[{attackerId:'a06:head:hunter',targetId:'a06:p2:base'}]}),/illegal attack destination/);assert.equal(staged('headhunting',null,{attackPairs:[]}).cue.outcomes.length,0);
});

test('Cripple compares total rather than ready resources; equal total never discards and draw is actual deck card',()=>{
  const a=staged('cripple-authority');assert.equal(a.p.deck,26);assert.equal(a.p.hand[0].id,'a06:cripple:draw:0');assert.deepEqual(ids(a.q.hand),['a06:p2:hand:takedown']);assert.equal(a.q.discard[0].id,'a06:cripple:p2:open');assert.equal(a.q.res.ready,2);const equal=staged('cripple-authority',s=>{s.players.p2.res.total=8;s.players.p2.resources=s.players.p2.resources.slice(0,8);});assert.ok(!equal.cue.outcomes.some(o=>o.kind==='discard'));assert.equal(equal.p.deck,26);
  assert.throws(()=>staged('cripple-authority',null,null,c=>{c.outcomes.find(o=>o.kind==='discard').condition.total=2;}),/strictly greater total/);
});

test('Chaos counts hands after source disposal without discarding them; zero hand yields zero own damage',()=>{
  const a=staged('the-chaos-of-war');assert.deepEqual([a.p.base.d,a.q.base.d,a.p.hand.length,a.q.hand.length],[12,8,3,2]);assert.equal(a.cue.outcomes[0].resolutionGroup.id,a.cue.outcomes[1].resolutionGroup.id);const z=staged('the-chaos-of-war',s=>{s.players.p1.hand=s.players.p1.hand.slice(0,1);s.players.p2.hand=[];});assert.deepEqual([z.p.base.d,z.q.base.d],[9,6]);assert.throws(()=>staged('the-chaos-of-war',null,null,c=>{c.outcomes[0].basis.sourceIds.push(c.source.id);c.outcomes[0].basis.value++;c.outcomes[0].amount++;}),/actual resolving hand/);
});

test('Desperate uses existing positive damage and attack-only bonus; base never counters',()=>{
  const a=staged('desperate-attack');assert.deepEqual([a.p.ground[0].p,a.p.ground[0].h,a.p.ground[0].d,a.p.ground[0].x,a.q.base.d],[3,3,1,1,11]);assert.equal(a.cue.outcomes.filter(o=>o.kind==='damage').length,1);assert.ok(!a.p.ground[0].status?.some(s=>s.duration==='attack'));assert.throws(()=>staged('desperate-attack',s=>{s.players.p1.ground[0].d=0;}),/bonus prerequisite/);assert.throws(()=>staged('desperate-attack',s=>{s.players.p1.ground[0].x=1;}),/ready friendly/);
});

test('Detention six-point hit defeats actual captor then consumes departed pocket into fresh owner rescue, not play',()=>{
  const a=staged('detention-block-rescue'),m=a.p.ground.find(c=>c.id==='a06:p1:marine');assert.deepEqual([m.owner,m.p,m.h,m.d,m.x,m.incarnation],['p1',3,3,0,1,'a06:p1:marine:entry-2']);assert.equal(m.u,undefined);assert.equal(m.status,undefined);assert.ok(a.q.discard.some(c=>c.id==='a06:detention:captor'));assert.ok(!a.cue.outcomes.some(o=>o.kind==='play'));assert.equal(a.cue.outcomes.find(o=>o.kind==='damage').amount,6);assert.equal(a.cue.outcomes.find(o=>o.kind==='rescue').entryType,'rescued');assert.throws(()=>staged('detention-block-rescue',null,null,c=>{delete c.outcomes.find(o=>o.kind==='defeat').captiveCleanup;}),/last-known pocket/);assert.throws(()=>staged('detention-block-rescue',null,null,c=>{c.outcomes=c.outcomes.filter(o=>o.kind!=='rescue');}),/all departed captor captives/);assert.throws(()=>staged('detention-block-rescue',null,null,c=>{c.outcomes.push(clone(c.outcomes.at(-1)));}),/fresh rescued entry/);
  const survivor=staged('detention-block-rescue',s=>{s.players.p2.ground[0].h=8;});assert.equal(survivor.q.ground[0].d,6);assert.equal(survivor.q.ground[0].cap.length,1);assert.ok(!survivor.p.ground.some(c=>c.id==='a06:p1:marine'));
  const zero=staged('detention-block-rescue',s=>{s.players.p1.hand.push(s.players.p2.ground[0].cap.pop());});assert.equal(zero.cue.outcomes.find(o=>o.kind==='damage').amount,3);assert.equal(zero.q.ground[0].d,3);assert.ok(!zero.cue.outcomes.some(o=>o.kind==='rescue'));
});

test('Pillage preserves P1 player choice versus P2 card choice; self selection cannot discard already-resolved source',()=>{
  const a=staged('pillage');assert.deepEqual(ids(a.q.hand),['a06:pillage:p2:resupply']);assert.deepEqual(ids(a.q.discard),['a06:p2:hand:takedown','a06:pillage:p2:open']);assert.ok(a.cue.outcomes.every(o=>o.chooserSeat==='p2'&&o.playerChoice.chooserSeat==='p1'));const self=staged('pillage',s=>{s.players.p1.hand.push({id:'a06:self:repair',n:'Repair',s:'SOR_074',owner:'p1'});}, {playerSeat:'p1'});assert.equal(self.p.hand.length,0);assert.equal(self.p.discard.length,2);assert.equal(self.cue.outcomes.length,1);assert.throws(()=>staged('pillage',null,{discardIds:['a06:p2:hand:takedown','a06:p2:hand:takedown']}),/distinct available/);assert.throws(()=>staged('pillage',null,null,c=>{c.outcomes[0].chooserSeat='p1';}),/remain distinct/);
});

test('Permanent exchange preserves prior phase statuses, persists into supplied regroup and later defeat follows real owner',()=>{
  const a=staged('choose-sides',s=>{const m=s.players.p1.ground[0];m.p=7;m.h=7;m.status=[{kind:'buff',label:'+4/+4 · phase',duration:'phase'}];});
  assert.deepEqual(a.q.ground[2].status[0],a.before.players.p1.ground[0].status[0]);
  const {resolveStagedRegroup}=loadTS(path.join(__dirname,'../src/effects/previewStages.ts'));
  const {after}=resolveStagedRegroup(a.after);assert.ok(after.players.p2.ground.some(c=>c.id==='a06:p1:marine'));assert.ok(after.players.p1.space.some(c=>c.id==='a06:p2:tie'));
  const m=a.q.ground[2],later={definition:a.d,seat:'p2',source:null,target:m,key:'later-defeat',outcomes:[{kind:'defeat',card:m,seat:'p2',ownerSeat:'p1',incarnation:m.incarnation,zone:'discard'}]};
  const defeated=resolvePreviewState(a.after,later);assert.ok(defeated.players.p1.discard.some(c=>c.id===m.id));assert.ok(!defeated.players.p2.discard.some(c=>c.id===m.id));
  assert.throws(()=>staged('choose-sides',null,null,c=>{c.outcomes[0].unit.status=[{kind:'buff',label:'fabricated',duration:'phase'}];}),/add only its permanent control/);
});

test('Departed captor releases every mixed-owner captive to fresh proper arenas; stale entries and prevented defeat cannot authorize release',()=>{
  const a=staged('detention-block-rescue',s=>{const f=s.players.p2.space.pop(),t=s.players.p2.ground[0];t.cap.push({id:f.id,n:f.n,s:f.s,owner:f.owner});s.mostRecentIncarnations[f.id]=f.incarnation;s.attacksThisPhase={round:9,phase:'action',attacks:[{id:'old-attack',attackerId:f.id,incarnation:f.incarnation}]};});
  assert.equal(a.cue.outcomes.find(o=>o.kind==='damage').amount,6);assert.equal(a.cue.outcomes.filter(o=>o.kind==='rescue').length,2);const f=a.q.space[0];assert.deepEqual([f.id,f.owner,f.d,f.x,f.incarnation],['a06:p2:tie','p2',0,1,'a06:p2:tie:entry-2']);assert.equal(a.after.mostRecentIncarnations[f.id],f.incarnation);assert.ok(!a.after.attacksThisPhase.attacks.some(x=>x.attackerId===f.id&&x.incarnation===f.incarnation));
  assert.throws(()=>staged('detention-block-rescue',null,null,c=>{c.outcomes.find(o=>o.kind==='rescue').unit.incarnation='a06:p1:marine:entry-1';}),/fresh rescued entry/);
  assert.throws(()=>staged('detention-block-rescue',null,null,c=>{c.outcomes.find(o=>o.kind==='defeat').prevented=true;}),/successful prior leave-play/);
  assert.throws(()=>staged('detention-block-rescue',null,null,c=>{c.outcomes.find(o=>o.kind==='defeat').captiveCleanup.incarnation='later';}),/last-known pocket/);
  const shield=staged('detention-block-rescue',s=>{s.players.p2.ground[0].u=[{id:'a06:detention:shield',n:'Shield',s:null,owner:'p2',t:1,p:0,h:0}];},null,(c,b)=>{const t=b.players.p2.ground[0];c.outcomes=[{kind:'defeat',card:t.u[0],sourceCard:t,seat:'p2',ownerSeat:'p2',zone:'ground',label:'SHIELD PREVENTED THE ABILITY DAMAGE'}];});
  assert.equal(shield.q.ground[0].d,0);assert.equal(shield.q.ground[0].cap.length,1);assert.equal(shield.q.ground[0].u.length,0);assert.ok(!shield.p.ground.some(c=>c.id==='a06:p1:marine'));assert.ok(!shield.cue.outcomes.some(o=>o.kind==='rescue'));
});

test('Attack windows allow a witnessed intervening ready without distinct-ID rule; damaged unit attack retains actual counterdamage',()=>{
  const one=staged('headhunting',null,{attackPairs:[{attackerId:'a06:head:hunter',targetId:'a06:p2:trooper'}]}),h=one.p.ground[1],w=one.q.ground[0];
  const second=[{kind:'ready',card:h,seat:'p1',amount:1,zone:'ground',incarnation:h.incarnation},
    {kind:'buff',card:h,seat:'p1',amount:'+2/+0',zone:'ground',duration:'attack',attackId:'repeat',attackBonusBasis:{kind:'bounty-hunter',sourceId:h.id,incarnation:h.incarnation}},
    {kind:'attack',card:w,sourceCard:h,seat:'p2',zone:'ground',attackId:'repeat',attackIndex:2,combatOrder:'simultaneous'},
    {kind:'exhaust',card:h,seat:'p1',amount:1,zone:'ground'},
    {kind:'damage',card:w,sourceCard:h,seat:'p2',amount:5,zone:'ground',attackId:'repeat',damageType:'combat'},
    {kind:'damage',card:h,sourceCard:w,seat:'p1',amount:4,zone:'ground',attackId:'repeat',damageType:'combat'},
    {kind:'defeat',card:w,seat:'p2',ownerSeat:'p2',zone:'discard',incarnation:w.incarnation},
    {kind:'defeat',card:h,seat:'p1',ownerSeat:'p1',zone:'discard',incarnation:h.incarnation}];
  const cue=clone(one.cue);cue.outcomes.push(...second);const end=resolvePreviewState(one.before,cue);assert.ok(end.players.p1.discard.some(c=>c.id===h.id));assert.ok(end.players.p2.discard.some(c=>c.id===w.id));
  assert.throws(()=>staged('headhunting',null,{attackPairs:[{attackerId:'a06:head:hunter',targetId:'a06:p2:trooper'},{attackerId:'a06:head:hunter',targetId:'a06:p2:wampa'}]}),/ready friendly/);
  const d=staged('desperate-attack',null,{attackPairs:[{attackerId:'a06:p1:marine',targetId:'a06:p2:wampa'}]});assert.ok(d.p.discard.some(c=>c.id==='a06:p1:marine'));assert.ok(d.q.discard.some(c=>c.id==='a06:p2:wampa'));assert.equal(d.q.base.d,6);assert.equal(d.cue.outcomes.filter(o=>o.kind==='damage').length,2);
});
