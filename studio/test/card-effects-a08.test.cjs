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
const {A08_DEFINITIONS,A08_COSTS,A08_ABILITIES,a08ShowcaseState,a08PreviewSource,a08PreviewOutcomes,a08PreviewPayment}=loadTS(path.join(__dirname,'../src/effects/batchA08.ts'));
const {resolvePreviewState}=loadTS(path.join(__dirname,'../src/effects/previewState.ts'));
const {previewPlayCost,previewExtraPayment}=loadTS(path.join(__dirname,'../src/effects/previewCosts.ts'));
const clone=structuredClone,ids=a=>a.map(c=>c.id),def=id=>A08_DEFINITIONS.find(d=>d.id===id);
function staged(id,change,choices,changeCue){const d=def(id),before=a08ShowcaseState(d);if(change)change(before);const cue={definition:d,seat:'p1',source:a08PreviewSource(d,before,'p1'),target:null,key:'a08:focused',playPayment:a08PreviewPayment(d,before,'p1',choices??{}),outcomes:a08PreviewOutcomes(d,before,'p1',choices??{})};if(changeCue)changeCue(cue,before);const old=clone(before),oldCue=clone(cue),after=resolvePreviewState(before,cue);assert.deepEqual(before,old);assert.deepEqual(cue,oldCue);assert.deepEqual(resolvePreviewState(before,cue),after);return{d,before,cue,after,p:after.players.p1,q:after.players.p2};}
const cardDir=path.join(__dirname,'../../forceteki/test/json/Card'),cards=fs.readdirSync(cardDir).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(cardDir,f))));
const byPrint=new Map(cards.flatMap(c=>(c.setCodes??[]).map(p=>[`${p.set}_${String(p.number).padStart(3,'0')}`,c]))),reverse=JSON.parse(fs.readFileSync(path.join(cardDir,'../_setCodeMap.json')));
const physical=s=>Object.values(s.players).flatMap(p=>[p.base,...(p.leader?.dep===0?[p.leader]:[]),...p.hand,...p.discard,...(p.resources??[]),...(p.knownDeck??[]),...p.ground,...p.space,...[...p.ground,...p.space].flatMap(c=>[...(c.u??[]),...(c.cap??[])])]);
const p1unit=r=>r.p.ground.find(c=>c.id==='a08:p1:marine'),wampa=r=>r.q.ground.find(c=>c.id==='a08:p2:wampa');
function handAid(s){const p=s.players.p1,c=p.resources[11];p.hand.push({id:c.id,n:c.n,s:c.s,owner:c.owner});p.resources[11]={id:'a08:p1:resource:11',n:'Unknown card',s:null,owner:'p1'};p.res.ready=12;}

test('A08 JSON identities, every exact print alias, costs and all supporting real before stats/traits are independently verified',()=>{
 const canonical=['3809048641','5778949819','8261033110','6425029011','7354795397','0866321455','9845101935','5950125325','7895170711','1389085256'];
 A08_DEFINITIONS.forEach((d,i)=>{const j=byPrint.get(d.setCode),m=A08_COSTS[d.id];assert.equal(j.id,canonical[i]);assert.equal(j.title,d.name);assert.equal(j.unique,false);assert.deepEqual({printed:m.printed,aspects:m.aspects},{printed:j.cost,aspects:j.aspects});assert.deepEqual(Object.keys(reverse).filter(p=>reverse[p]===j.id).sort(),j.setCodes.map(p=>`${p.set}_${String(p.number).padStart(3,'0')}`).sort());const b=a08ShowcaseState(d);for(const p of Object.values(b.players)){assert.equal(p.knownDeck.length,p.deck);assert.equal(p.resources.length,p.res.total);assert.equal(p.resources.filter(c=>!c.x).length,p.res.ready);for(const u of [...p.ground,...p.space]){const f=byPrint.get(u.s),phase=d.id==='lethal-crackdown'&&u.id==='a08:p2:wampa'?1:0;assert.equal(u.p,f.power+(u.u??[]).reduce((n,x)=>n+(x.p??0),0)+phase);assert.equal(u.h,f.hp+(u.u??[]).reduce((n,x)=>n+(x.h??0),0));assert.equal(f.arena,p.ground.includes(u)?'ground':'space');for(const a of u.u??[])if(a.s){const k=byPrint.get(a.s);assert.equal(a.p,k.power);assert.equal(a.h,k.hp);}}}});
 assert.equal(byPrint.get('SOR_220').id,byPrint.get('SHD_231').id);assert.equal(byPrint.get('SOR_251').id,byPrint.get('SHD_262').id);assert.ok(byPrint.get('SHD_239').traits.includes('bounty hunter'));assert.ok(byPrint.get('SOR_142').traits.includes('mandalorian'));assert.ok(byPrint.get('SOR_070').types.includes('upgrade'));assert.equal(byPrint.get('JTL_042').cost,3);assert.match(byPrint.get('JTL_042').text,/for each damage/);assert.match(byPrint.get('SHD_252').text,/Smuggle \[3 resources Heroism\]/);assert.deepEqual(A08_COSTS['smugglers-aid'].smuggle,{printed:3,aspects:['heroism']});
});

test('All ten primary boards charge explicit event and nested payments once, conserve physical cards, preserve owners and repeat',()=>{
 const costs=[4,5,8,3,5,3,2,1,2,6],ready=[8,7,4,9,7,8,10,11,8,6];A08_DEFINITIONS.forEach((d,i)=>{const r=staged(d.id);assert.equal(previewPlayCost(d,r.before,'p1',r.cue.playPayment),costs[i]);assert.equal(r.p.res.ready,ready[i]);assert.equal(r.p.res.total,12);assert.equal(previewExtraPayment(d),d.id==='a-fine-addition'?2:0);assert.equal(r.p.discard.filter(c=>c.id===r.cue.source.id).length,1);assert.ok(!r.p.hand.some(c=>c.id===r.cue.source.id));assert.ok(!r.p.resources.some(c=>c.id===r.cue.source.id));const actual=physical(r.after),before=physical(r.before),generated=d.id==='relentless-pursuit'?['a08:pursuit:shield']:[];assert.deepEqual(ids(actual).filter(id=>!generated.includes(id)).sort(),ids(before).sort());assert.equal(new Set(ids(actual)).size,actual.length);for(const c of before)assert.equal(actual.find(x=>x.id===c.id)?.owner,c.owner);for(const p of Object.values(r.after.players)){assert.equal(p.resources.length,p.res.total);assert.equal(p.resources.filter(c=>!c.x).length,p.res.ready);assert.equal(p.knownDeck.length,p.deck);}assert.equal(r.q.base.d,6);assert.equal(r.p.base.d,d.id==='smugglers-aid'?6:d.id==='lethal-crackdown'?16:9);});
});

test('Surprise binds a transient six-power attack and dying defender counterstroke, with two distinct owner departures',()=>{
 const r=staged('surprise-strike');assert.ok(!r.p.ground.some(c=>c.id==='a08:p1:marine'));assert.ok(!r.q.ground.some(c=>c.id==='a08:p2:trooper'));assert.deepEqual(r.cue.outcomes.filter(o=>o.kind==='damage').map(o=>[o.amount,o.attackIndex]),[[6,1],[3,2]]);assert.equal(new Set(r.cue.outcomes.map(o=>o.attackId)).size,1);assert.equal(r.cue.outcomes[0].duration,'attack');assert.equal(r.q.base.d,6);assert.equal(r.p.ground[0].p,4);assert.ok(!r.p.ground[0].status?.some(s=>s.duration==='attack'));
 const base=staged('surprise-strike',null,{attackTargetId:'a08:p2:base'});assert.equal(base.q.base.d,12);assert.equal(p1unit(base).d,1);assert.equal(p1unit(base).x,1);assert.equal(p1unit(base).p,3);assert.equal(base.cue.outcomes.filter(o=>o.kind==='damage').length,1);
 assert.throws(()=>staged('surprise-strike',s=>s.players.p1.ground[0].x=1),/ready legal/);assert.throws(()=>staged('surprise-strike',null,null,c=>c.outcomes.find(o=>o.kind==='attack').attackId='different'),/identified attack|attack/);
});

test('Pursuit compares printed three to three, captures clean owner ref, removes only actual upgrade and independently Shields stationary Toro',()=>{
 const r=staged('relentless-pursuit'),toro=r.p.ground[1];assert.deepEqual([toro.p,toro.h,toro.d,toro.x],[3,5,1,1]);assert.deepEqual(toro.cap,[{id:'a08:p2:trooper',n:'Death Trooper',s:'SOR_033',owner:'p2'}]);assert.equal(toro.u[0].id,'a08:pursuit:shield');assert.ok(r.p.discard.some(c=>c.id==='a08:pursuit:academy'));assert.ok(!r.q.ground.some(c=>c.id==='a08:p2:trooper'));assert.equal(r.q.discard.length,0);assert.deepEqual(r.cue.outcomes[0].captureCost,{captorPrintedCost:3,targetPrintedCost:3});assert.equal(r.cue.outcomes[0].captureBasis,undefined);
 assert.throws(()=>staged('relentless-pursuit',null,{targetId:'a08:p2:wampa'}),/printed cost/);assert.throws(()=>staged('relentless-pursuit',null,null,c=>c.outcomes[0].captureCost.targetPrintedCost=4),/comparison/);assert.throws(()=>staged('relentless-pursuit',null,null,c=>{delete c.outcomes[0].captureCost;}),/exactly one/);assert.throws(()=>staged('relentless-pursuit',null,null,c=>c.outcomes[0].incarnation='old'),/incarnation/);assert.throws(()=>staged('relentless-pursuit',null,null,c=>c.outcomes[0].card.s='SOR_164'),/faces contradict/);
});

test('Pursuit Hunter Shield remains independent for no legal target and an explicit prevented capture; non-Hunter only captures',()=>{
 const none=staged('relentless-pursuit',s=>{const p=s.players.p2;p.hand.push(...p.ground.splice(0,1).map(c=>({id:c.id,n:c.n,s:c.s,owner:c.owner})),...p.space.splice(0).map(c=>({id:c.id,n:c.n,s:c.s,owner:c.owner})));s.players.p1.discard.push(...s.players.p1.ground[1].cap);},{capture:false});assert.equal(none.cue.outcomes.length,1);assert.equal(none.cue.outcomes[0].kind,'shield');assert.deepEqual(none.p.ground[1].cap,[]);assert.equal(none.p.ground[1].u[0].n,'Shield');
 const prevented=staged('relentless-pursuit',null,{preventCapture:true});assert.equal(prevented.q.ground[0].u[0].id,'a08:pursuit:academy');assert.equal(prevented.p.ground[1].u[0].n,'Shield');assert.deepEqual(prevented.p.ground[1].cap,[]);
 const marine=staged('relentless-pursuit',null,{captorId:'a08:p1:marine',targetId:'a08:p2:tie'});assert.equal(p1unit(marine).cap[0].id,'a08:p2:tie');assert.equal(p1unit(marine).u,undefined);assert.equal(marine.cue.outcomes.length,1);assert.throws(()=>staged('relentless-pursuit',null,{capture:false}),/legal target remains/);
});

test('Evacuate returns all six non-leaders across arenas to owners, while deployed Vader and its spent deployment remain',()=>{
 const r=staged('evacuate');assert.equal(r.cue.outcomes.length,6);assert.equal(r.p.ground.length,0);assert.equal(r.p.space.length,0);assert.equal(r.q.space.length,0);assert.equal(r.p.hand.length,3);assert.equal(r.q.hand.length,5);assert.deepEqual([r.q.ground[0].id,r.q.ground[0].p,r.q.ground[0].h,r.q.ground[0].d,r.q.ground[0].x],['a08:p2:leader',5,8,2,1]);assert.deepEqual(r.q.leader,r.before.players.p2.leader);assert.ok(r.p.discard.some(c=>c.id==='a08:evacuate:academy'));assert.ok(!r.q.discard.length);assert.ok(r.cue.outcomes.every(o=>o.selection==='all'&&o.resolutionGroup.mode==='simultaneous'));
 const stolen=staged('evacuate',s=>{const m=s.players.p1.ground.shift();s.players.p2.ground.push(m);});assert.ok(stolen.p.hand.some(c=>c.id==='a08:p1:marine'));assert.ok(!stolen.q.hand.some(c=>c.id==='a08:p1:marine'));
 assert.throws(()=>staged('evacuate',s=>s.players.p1.ground[0].cap=[{id:'captive',n:'Wampa',s:'SOR_164',owner:'p2'}]),/declared rescue/);
});

test('Deal discards only actual current friendly pocket to captive owner, retaining guard, empty footprint and unrelated copy',()=>{
 const r=staged('altering-the-deal'),x=r.p.space[0];assert.deepEqual([x.p,x.h,x.d,x.x,x.cap],[2,3,0,undefined,[]]);assert.ok(r.q.discard.some(c=>c.id==='a08:deal:captive'));assert.ok(wampa(r));assert.equal(r.cue.outcomes[0].fromZone,'capture');assert.ok(!r.cue.outcomes.some(o=>['rescue','defeat','play','capture'].includes(o.kind)));
 const own=staged('altering-the-deal',s=>s.players.p1.space[0].cap[0].owner='p1');assert.ok(own.p.discard.some(c=>c.id==='a08:deal:captive'));assert.equal(own.q.discard.length,0);
 for(const mutate of [c=>c.outcomes[0].sourceCard.id='a08:p1:marine',c=>c.outcomes[0].card.id='absent',c=>c.outcomes[0].ownerSeat='p1',c=>c.outcomes[0].card.s='SOR_033',c=>c.outcomes.push(clone(c.outcomes[0]))])assert.throws(()=>staged('altering-the-deal',null,null,mutate),/captured discard/);
 assert.throws(()=>staged('altering-the-deal',s=>{s.players.p2.space.push(s.players.p1.space.pop());}),/friendly guard/);
});

test('NoBargain uses opposing own-hand choice and independent simultaneous actual draw; empty opponent hand still draws',()=>{
 const r=staged('no-bargain');assert.deepEqual(ids(r.q.hand),['a08:p2:hand:repair']);assert.deepEqual(ids(r.q.discard),['a08:p2:hand:takedown']);assert.deepEqual(ids(r.p.hand),['a08:no-bargain:draw']);assert.equal(r.p.deck,26);assert.equal(r.cue.outcomes[0].chooserSeat,'p2');assert.equal(r.cue.outcomes[0].selection,'opponent');assert.ok(r.cue.outcomes.every(o=>o.resolutionGroup.id==='a08:no-bargain:resolution'));
 const empty=staged('no-bargain',s=>s.players.p2.hand=[]);assert.equal(empty.cue.outcomes.length,1);assert.equal(empty.p.deck,26);assert.equal(empty.q.discard.length,0);
 const independent=staged('no-bargain',null,null,c=>c.outcomes=c.outcomes.filter(o=>o.kind==='draw'));assert.equal(independent.p.hand.length,1);assert.equal(independent.q.hand.length,2);
});

test('Smuggle keeps exact resource source, separate cost3, private exhausted top replacement, heal3 and zero hand waypoint',()=>{
 const r=staged('smugglers-aid');assert.equal(r.cue.source.id,'a08:smugglers-aid:event');assert.equal(r.before.players.p1.hand.length,0);assert.equal(r.before.players.p1.res.ready,11);assert.equal(r.cue.playPayment.smuggle.sourceId,r.cue.source.id);assert.equal(r.cue.playPayment.smuggle.resourcesAfterPayment.filter(c=>c.x).length,4);assert.equal(r.p.res.ready,8);assert.equal(r.p.res.total,12);assert.equal(r.p.deck,26);assert.equal(r.p.base.d,6);assert.equal(r.p.hand.length,0);assert.equal(r.p.resources.at(-1).id,'a08:aid:replacement');assert.equal(r.p.resources.at(-1).x,1);assert.equal(r.cue.outcomes[0].visibility,'private');assert.equal(r.cue.outcomes[0].entersReady,false);assert.equal(r.cue.outcomes[0].fromZone,'deck');assert.ok(!r.cue.outcomes.some(o=>['draw','play','inspect'].includes(o.kind)));
});

test('Smuggle wrong or missing explicit mode/source/rearrangement never falls back to hand cost or ignores contradictions',()=>{
 const mutations=[c=>delete c.playPayment.smuggle,c=>c.playPayment.smuggle.sourceId='absent',c=>c.source.s='SOR_074',c=>c.playPayment.smuggle.resourcesAfterPayment.pop(),c=>c.playPayment.smuggle.resourcesAfterPayment[0]=clone(c.playPayment.smuggle.resourcesAfterPayment[1]),c=>delete c.playPayment.smuggle.resourcesAfterPayment.at(-1).x,c=>c.playPayment.smuggle.resourcesAfterPayment[4].x=1,c=>c.playPayment.smuggle.resourcesAfterPayment[0].s='SOR_164'];
 for(const mutation of mutations)assert.throws(()=>staged('smugglers-aid',null,null,mutation),/Smuggle/);
 const b=a08ShowcaseState(def('smugglers-aid'));handAid(b);assert.throws(()=>a08PreviewPayment(def('smugglers-aid'),b,'p1'),/selected source mode/);assert.throws(()=>staged('surprise-strike',null,null,(c,b)=>c.playPayment.smuggle={sourceId:b.players.p1.resources[0].id,resourcesAfterPayment:clone(b.players.p1.resources)}),/Smuggle/);
});

test('Smuggle replacement is exact actual top and once-only, and empty deck intentionally loses one resource without invented replacement',()=>{
 for(const mutate of [c=>c.outcomes[0].card.id='a08:p1:deck:1',c=>c.outcomes[0].card.s='SOR_164',c=>c.outcomes[0].visibility='public',c=>c.outcomes[0].entersReady=true,c=>c.outcomes[0].sourceCard.id='different',c=>c.outcomes.unshift(clone(c.outcomes[0])),c=>c.outcomes.shift()])assert.throws(()=>staged('smugglers-aid',null,null,mutate),/replacement/);
 const empty=staged('smugglers-aid',s=>{s.players.p1.knownDeck=[];s.players.p1.deck=0;});assert.deepEqual(empty.p.res,{ready:8,total:11});assert.equal(empty.p.deck,0);assert.equal(empty.cue.outcomes.length,1);assert.equal(empty.p.base.d,6);assert.equal(empty.p.discard.length,1);
});

test('Ready-source Smuggle explicitly rearranges real flags without inventing resources or preserving paid-ID exhaustion',()=>{
 const r=staged('smugglers-aid',s=>{delete s.players.p1.resources[11].x;s.players.p1.res.ready=12;});assert.equal(r.p.res.ready,9);assert.equal(r.p.res.total,12);assert.equal(r.cue.playPayment.smuggle.resourcesAfterPayment.filter(c=>c.x).length,3);assert.equal(r.cue.playPayment.smuggle.resourcesAfterPayment.at(-1).x,1);assert.equal(r.p.resources[0].x,undefined);assert.equal(r.p.resources.at(-1).x,1);
 const reorder=staged('smugglers-aid',null,null,c=>c.playPayment.smuggle.resourcesAfterPayment.reverse());assert.deepEqual(ids(reorder.p.resources).slice(0,2),['a08:p1:resource:10','a08:p1:resource:9']);assert.equal(reorder.p.res.ready,8);
});

test('Hand Aid pays only1 with no deck replacement, and actual zero/partial healing never becomes fabricated three',()=>{
 const normal=staged('smugglers-aid',handAid,{sourceMode:'hand'});assert.equal(previewPlayCost(normal.d,normal.before,'p1',normal.cue.playPayment),1);assert.equal(normal.p.res.ready,11);assert.equal(normal.p.res.total,12);assert.equal(normal.p.deck,27);assert.equal(normal.p.base.d,6);assert.equal(normal.cue.playPayment.smuggle,undefined);assert.equal(normal.cue.outcomes.length,1);
 const zero=staged('smugglers-aid',s=>{handAid(s);s.players.p1.base.d=0;},{sourceMode:'hand'});assert.equal(zero.cue.outcomes[0].amount,0);assert.equal(zero.p.base.d,0);assert.equal(zero.p.deck,27);
 const partial=staged('smugglers-aid',s=>s.players.p1.base.d=1);assert.equal(partial.p.base.d,0);assert.equal(partial.cue.outcomes.at(-1).amount,1);
});

test('ThisWay privately looks eight, publicly reveals only actual two, consumes separate draws once and preserves untouched suffix',()=>{
 const r=staged('this-is-the-way'),op=r.cue.outcomes[0].deckOperation;assert.equal(op.visibility,'private');assert.deepEqual(op.selectedIds,['a08:way:top:1','a08:way:top:3']);assert.deepEqual(op.revealedIds,op.selectedIds);assert.deepEqual(ids(r.p.hand),op.selectedIds);assert.equal(r.p.deck,25);assert.deepEqual(ids(r.p.knownDeck).slice(0,19),ids(r.before.players.p1.knownDeck).slice(8));assert.deepEqual(ids(r.p.knownDeck).slice(19),['a08:way:top:7','a08:way:top:6','a08:way:top:5','a08:way:top:4','a08:way:top:2','a08:way:top:0']);assert.equal(r.cue.outcomes[1].visibility,'public');assert.ok(!r.p.ground.some(c=>c.s==='SOR_142'));
 const none=staged('this-is-the-way',null,{selectedIds:[]});assert.equal(none.p.deck,27);assert.equal(none.p.hand.length,0);assert.equal(none.cue.outcomes.length,1);
 const one=staged('this-is-the-way',null,{selectedIds:['a08:way:top:3']});assert.equal(one.p.deck,26);assert.equal(one.p.hand[0].s,'SOR_070');
 const short=staged('this-is-the-way',s=>{s.players.p1.knownDeck.splice(3);s.players.p1.deck=3;},{selectedIds:['a08:way:top:1']});assert.equal(short.cue.outcomes[0].amount,3);assert.equal(short.p.deck,2);
});

test('ThisWay permits two of the same category, rejects Pilot-only unit, duplicates/third selection and false permutations',()=>{
 const upgrades=staged('this-is-the-way',s=>s.players.p1.knownDeck[1]={...s.players.p1.knownDeck[1],n:'Resilient',s:'SOR_069'});assert.deepEqual(upgrades.p.hand.map(c=>c.s),['SOR_069','SOR_070']);const mando=staged('this-is-the-way',s=>s.players.p1.knownDeck[3]={...s.players.p1.knownDeck[3],n:'Sabine Wren: Explosives Artist',s:'SOR_142'});assert.deepEqual(mando.p.hand.map(c=>c.s),['SOR_142','SOR_142']);assert.ok(byPrint.get('JTL_196').keywords.includes('piloting'));assert.ok(!byPrint.get('JTL_196').types.includes('upgrade'));assert.ok(!byPrint.get('JTL_196').traits.includes('mandalorian'));
 assert.throws(()=>staged('this-is-the-way',s=>s.players.p1.knownDeck[1]={...s.players.p1.knownDeck[1],n:'Dagger Squadron Pilot',s:'JTL_196'}),/Mandalorian or upgrade/);
 assert.throws(()=>staged('this-is-the-way',null,{selectedIds:['a08:way:top:1','a08:way:top:1']}),/distinct/);assert.throws(()=>staged('this-is-the-way',null,{selectedIds:['a08:way:top:1','a08:way:top:3','a08:way:top:0']}),/two/);assert.throws(()=>staged('this-is-the-way',null,null,c=>c.outcomes[0].deckOperation.remainingOrder[4]=clone(c.outcomes[0].deckOperation.remainingOrder[3])),/unique stable/);
});

test('Confiscate removes only owner P1 ordinary attachment, rolls back exact stats and leaves original Shield/host wounds/pose',()=>{
 const r=staged('confiscate'),w=wampa(r);assert.deepEqual([w.p,w.h,w.d,w.x],[4,5,1,undefined]);assert.deepEqual(ids(w.u),['a08:confiscate:shield']);assert.ok(r.p.discard.some(c=>c.id==='a08:confiscate:academy'));assert.equal(r.q.discard.length,0);const token=staged('confiscate',null,{upgradeId:'a08:confiscate:shield'});assert.deepEqual([wampa(token).p,wampa(token).h],[6,7]);assert.ok(!physical(token.after).some(c=>c.id==='a08:confiscate:shield'));assert.deepEqual(ids(wampa(token).u),['a08:confiscate:academy']);assert.ok(!token.q.discard.length);
 assert.throws(()=>staged('confiscate',s=>s.players.p2.ground[1].d=5),/HP-loss defeat/);
});

test('Addition uses current-phase enemy controller/type, ignores selected Cunning penalty only, preserves opponent ownership and playing payer',()=>{
 const r=staged('a-fine-addition'),m=p1unit(r),play=r.cue.outcomes.find(o=>o.kind==='play');assert.deepEqual([m.p,m.h,m.d,m.x],[5,5,1,undefined]);assert.deepEqual([m.u[0].id,m.u[0].owner,m.u[0].controller],['a08:addition:armor','p2','p1']);assert.equal(play.fromSeat,'p2');assert.equal(play.fromZone,'discard');assert.equal(play.controllerSeat,'p1');assert.equal(play.printedCost,2);assert.equal(r.q.discard.length,1);assert.equal(r.p.res.ready,8);assert.equal(r.before.defeatedThisPhase.cards[0].defeatedBy,undefined);assert.equal(previewPlayCost(r.d,r.before,'p1',r.cue.playPayment),2);assert.equal(byPrint.get('SHD_224').cost,2);assert.deepEqual(byPrint.get('SHD_224').aspects,['cunning']);assert.equal(r.cue.outcomes.find(o=>o.kind==='pay').amount,2);
 for(const change of [s=>s.defeatedThisPhase=undefined,s=>s.defeatedThisPhase.round=9,s=>s.defeatedThisPhase.cards[0].controller='p1',s=>s.defeatedThisPhase.cards[0].lastKnownType='upgrade']){const no=staged('a-fine-addition',change);assert.equal(no.cue.outcomes.length,0);assert.equal(no.p.res.ready,10);assert.equal(p1unit(no).p,3);}
 const other=staged('a-fine-addition',s=>s.defeatedThisPhase.cards[0].defeatedBy='p2');assert.equal(p1unit(other).p,5);const returned=staged('a-fine-addition',s=>{const f=s.players.p2.discard.shift();s.players.p2.space.push({...f,p:2,h:1,d:0,incarnation:`${f.id}:entry-2`});s.mostRecentIncarnations={[f.id]:`${f.id}:entry-2`};});assert.equal(p1unit(returned).p,5);
});

test('Addition own-hand/discard alternatives work; opponent hand, absent permission, wrong payer/history and fake free play reject',()=>{
 for(const zone of ['hand','discard']){const r=staged('a-fine-addition',s=>{const a=s.players.p2.discard.pop();a.owner='p1';s.players.p1[zone].push(a);});assert.equal(p1unit(r).u[0].owner,'p1');assert.equal(p1unit(r).u[0].controller,'p1');}
 assert.throws(()=>staged('a-fine-addition',s=>s.players.p2.hand.push(s.players.p2.discard.pop())),/own hand or actual discard/);
 for(const mutate of [c=>delete c.outcomes.find(o=>o.kind==='play').upgradePlayPermission,c=>c.outcomes.find(o=>o.kind==='play').upgradePlayPermission.sourceId='wrong',c=>c.outcomes.find(o=>o.kind==='play').upgradePlayPermission.defeated.incarnation='later',c=>c.outcomes.find(o=>o.kind==='play').upgrade.owner='p1',c=>c.outcomes=c.outcomes.filter(o=>o.kind!=='pay'),c=>{const pay=c.outcomes.find(o=>o.kind==='pay');pay.amount=0;pay.cards=[];}])assert.throws(()=>staged('a-fine-addition',null,null,mutate),/permission|owner|paid source/);
 assert.throws(()=>staged('a-fine-addition',null,null,(c,b)=>{const pay=c.outcomes.find(o=>o.kind==='pay');pay.seat='p2';pay.cards=b.players.p2.resources.slice(0,2);}),/playing payer/);
});

test('Crackdown seals actual modified power7 before removal, conditionally damages only own base and leaves prior Pain already resolved',()=>{
 const r=staged('lethal-crackdown');assert.ok(!wampa(r));assert.ok(r.q.discard.some(c=>c.id==='a08:p2:wampa'));assert.ok(r.p.discard.some(c=>c.id==='a08:crackdown:academy'));assert.ok(r.q.discard.some(c=>c.id==='a08:crackdown:prior-pain'));assert.equal(r.p.base.d,16);assert.equal(r.q.base.d,6);assert.equal(r.cue.outcomes[1].basis.kind,'defeated-power');assert.equal(r.cue.outcomes[1].basis.value,7);assert.equal(r.cue.outcomes[1].requiresDefeat.incarnation,'a08:p2:wampa:entry-1');assert.ok(!r.cue.outcomes.some(o=>['attack','exhaust','buff'].includes(o.kind)));
 const friendly=staged('lethal-crackdown',null,{targetId:'a08:p1:marine'});assert.equal(friendly.p.base.d,12);assert.ok(!p1unit(friendly));
 const zero=staged('lethal-crackdown',s=>{const w=s.players.p2.ground[1];Object.assign(w,{n:'Grogu: Irresistible',s:'SHD_196',p:0,h:5,d:0});delete w.u;delete w.status;});assert.equal(byPrint.get('SHD_196').power,0);assert.equal(zero.p.base.d,9);assert.equal(zero.cue.outcomes[1].amount,0);assert.ok(!wampa(zero));
});

test('Crackdown failed/wrong-entry/absent defeat cannot authorize damage; cleanup-first power cannot masquerade as original seven',()=>{
 for(const mutate of [c=>c.outcomes[0].prevented=true,c=>c.outcomes.shift(),c=>c.outcomes[1].requiresDefeat.incarnation='new',c=>{c.outcomes[1].amount=5;c.outcomes[1].basis.value=5;},c=>c.outcomes[1].card.id='a08:p2:base'])assert.throws(()=>staged('lethal-crackdown',null,null,mutate),/successful defeat|sealed last-known power/);
 const prevented=staged('lethal-crackdown',null,null,c=>{c.outcomes[0].prevented=true;c.outcomes.pop();});assert.equal(prevented.p.base.d,9);assert.equal(wampa(prevented).p,7);assert.equal(wampa(prevented).u[0].id,'a08:crackdown:academy');
 const removeFirst=(c,b)=>{const w=b.players.p2.ground[1];c.outcomes.unshift({kind:'defeat',card:w.u[0],seat:'p2',zone:'discard',sourceCard:w,ownerSeat:'p1'});};assert.throws(()=>staged('lethal-crackdown',null,null,removeFirst),/sealed last-known power/);
 const reordered=staged('lethal-crackdown',null,null,(c,b)=>{removeFirst(c,b);c.outcomes.at(-1).amount=5;c.outcomes.at(-1).basis.value=5;});assert.equal(reordered.p.base.d,14);
});


test('A08 source API preserves actual source identity, rejects missing/ambiguous references, and skips unsupported definitions',()=>{
 const unrelated={id:'not-a08',name:'Unknown',setCode:'SOR_999'},state=a08ShowcaseState(def('confiscate'));assert.equal(a08ShowcaseState(unrelated),undefined);assert.equal(a08PreviewSource(unrelated,state,'p1'),undefined);assert.equal(a08PreviewPayment(unrelated,state,'p1'),undefined);assert.equal(a08PreviewOutcomes(unrelated,state,'p1'),undefined);
 assert.throws(()=>staged('surprise-strike',s=>s.players.p1.hand=[]),/source missing/);assert.throws(()=>staged('smugglers-aid',s=>s.players.p1.hand.push(clone(s.players.p1.resources[11]))),/ambiguous/);
 for(const [id,code]of [['surprise-strike','SOR_220'],['confiscate','SOR_251']]){const d={...def(id),setCode:code},s=a08ShowcaseState(d),source=a08PreviewSource(d,s,'p1');assert.equal(source.id,`a08:${id}:event`);assert.equal(source.s,code);assert.ok(a08PreviewOutcomes(d,s,'p1').length);}
});

test('Capture cost evidence cannot bypass owner/controller/entry roles or overwrite the older independent base-attack branch',()=>{
 for(const mutate of [c=>c.outcomes[0].captureBasis={round:10,phase:'action',attackId:'invented',attackerId:'a08:p2:trooper',incarnation:'a08:p2:trooper:entry-1',attackingSeat:'p2',defendingSeat:'p1',targetId:'a08:p1:base'},c=>c.outcomes[0].captureCost.targetPrintedCost=2.5,c=>c.outcomes[0].ownerSeat='p1',c=>c.outcomes[0].sourceCard.id='a08:p2:wampa',c=>c.outcomes[0].fromSeat='p1',c=>c.outcomes[0].kind='damage'])assert.throws(()=>staged('relentless-pursuit',null,null,mutate),/capture|captor/);
});

test('Smuggle explicit mode still respects affordability/aspects and actual complete deck manifest, without normal-cost fallback',()=>{
 assert.throws(()=>staged('smugglers-aid',s=>{s.players.p1.res.ready=2;s.players.p1.resources.forEach((c,i)=>{if(i>=2)c.x=1;});}),/unaffordable/);
 assert.throws(()=>staged('smugglers-aid',s=>s.players.p1.knownDeck.pop()),/deck manifest/);assert.throws(()=>staged('smugglers-aid',null,null,c=>c.playPayment.smuggle.resourcesAfterPayment=null),/complete array/);
 const missingAspect=staged('smugglers-aid',s=>s.players.p1.leader={...s.players.p1.leader,n:'Darth Vader: Dark Lord of the Sith',s:'SOR_010'});assert.equal(previewPlayCost(missingAspect.d,missingAspect.before,'p1',missingAspect.cue.playPayment),5);assert.equal(missingAspect.p.res.ready,6);assert.equal(missingAspect.p.res.total,12);assert.equal(missingAspect.p.base.d,6);
});

test('Upgrade authority and LKI receipts cannot be moved into unrelated card/play/damage semantics',()=>{
 assert.throws(()=>staged('a-fine-addition',null,null,c=>c.outcomes.find(o=>o.kind==='play').playAs='unit'),/different receipt kind/);
 assert.throws(()=>staged('a-fine-addition',null,null,c=>c.outcomes.find(o=>o.kind==='play').fromZone='hand'),/allowed origin/);
 assert.throws(()=>staged('lethal-crackdown',null,null,c=>c.outcomes[1].damageType='combat'),/sealed last-known power/);
 assert.throws(()=>staged('lethal-crackdown',null,null,c=>c.outcomes[1].card.s='SOR_020'),/actual own-base/);
});
