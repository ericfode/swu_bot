const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createRequire } = require('node:module');
const ts = require('typescript5');
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
const {A12_DEFINITIONS,A12_COSTS,A12_ABILITIES,a12ShowcaseState,a12PreviewSource,a12PreviewPayment,a12PreviewOutcomes,a12LaterActionOutcomes}=loadTS(path.join(__dirname,'../src/effects/batchA12.ts'));
const {resolvePreviewState}=loadTS(path.join(__dirname,'../src/effects/previewState.ts'));
const {resolveStagedRegroup}=loadTS(path.join(__dirname,'../src/effects/previewStages.ts'));
const {previewPlayCost,previewExtraPayment}=loadTS(path.join(__dirname,'../src/effects/previewCosts.ts'));
const clone=structuredClone,def=id=>A12_DEFINITIONS.find(d=>d.id===id),units=p=>[...p.ground,...p.space],ids=a=>a.map(c=>c.id),get=(r,id)=>units(r.p).concat(units(r.q)).find(u=>u.id===id);
function staged(id,change,choices,mutate){const d=def(id),before=a12ShowcaseState(d);if(change)change(before);const cue={definition:d,seat:'p1',source:a12PreviewSource(d,before,'p1'),target:null,key:'a12:focused',playPayment:a12PreviewPayment(d,before,'p1',choices??{}),outcomes:a12PreviewOutcomes(d,before,'p1',choices??{})};if(mutate)mutate(cue,before);const old=clone(before),oldCue=clone(cue),after=resolvePreviewState(before,cue);assert.deepEqual(before,old);assert.deepEqual(cue,oldCue);assert.deepEqual(resolvePreviewState(before,{...cue,key:'a12:newnonce'}),after);return{d,before,cue,after,p:after.players.p1,q:after.players.p2};}
function later(changeBefore,mutate){const r=staged('aid-from-the-innocent'),before=r.after;if(changeBefore)changeBefore(before);const cue={definition:r.d,seat:'p1',source:r.cue.source,target:null,key:'a12:later',stage:'next-action',outcomes:a12LaterActionOutcomes(r.d,before,'p1')};if(mutate)mutate(cue,before);const old=clone(before),oldCue=clone(cue),after=resolvePreviewState(before,cue);assert.deepEqual(before,old);assert.deepEqual(cue,oldCue);assert.deepEqual(resolvePreviewState(before,cue),after);return{...r,before,cue,after,p:after.players.p1,q:after.players.p2};}
const cardDir=path.join(__dirname,'../../forceteki/test/json/Card'),cards=fs.readdirSync(cardDir).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(cardDir,f))));
const byPrint=new Map(cards.flatMap(c=>(c.setCodes??[]).map(p=>[`${p.set}_${String(p.number).padStart(3,'0')}`,c]))),reverse=JSON.parse(fs.readFileSync(path.join(cardDir,'../_setCodeMap.json')));
const physical=s=>Object.values(s.players).flatMap(p=>[p.base,...(p.leader?.dep===0?[p.leader]:[]),...p.hand,...p.discard,...(p.resources??[]),...(p.knownDeck??[]),...p.ground,...p.space,...units(p).flatMap(c=>[...(c.u??[]),...(c.cap??[])])]);
test('All ten A12 primary recipes and Aid later action resolve immutably with stable identities',()=>{for(const d of A12_DEFINITIONS)staged(d.id);later();});

test('Direct installed JSON verifies all ten sole aliases, canonical IDs, costs/keywords and complete real fixture identities',()=>{
 const canonical=['7235023816','1167572655','3459567689','4113123883','2483302291','9620454519','0328412140','7510418786','1302133998','6401761275'];for(const[i,d]of A12_DEFINITIONS.entries()){const c=byPrint.get(d.setCode);assert.equal(c.id,canonical[i]);assert.equal(c.title,d.name);assert.equal(d.visual,d.id);assert.equal(c.unique,false);assert.deepEqual([A12_COSTS[d.id].printed,A12_COSTS[d.id].aspects],[c.cost,c.aspects]);assert.deepEqual(Object.keys(reverse).filter(p=>reverse[p]===c.id),[d.setCode]);for(const p of Object.values(a12ShowcaseState(d).players))for(const u of units(p)){const f=byPrint.get(u.s);assert.equal(u.n,f.title+(f.subtitle?`: ${f.subtitle}`:''));assert.equal(u.printedTitle,f.title);assert.equal(u.unique,f.unique);assert.equal(u.leaderUnit,f.types.includes('leader'));assert.deepEqual([u.p,u.h,u.traits],[f.power,f.hp,f.traits]);assert.equal(f.arena,p.ground.includes(u)?'ground':'space');assert.ok(u.d<u.h&&u.id&&u.incarnation);}}
 assert.match(byPrint.get('TWI_178').text,/Exploit 3/);assert.equal(A12_COSTS['planetary-invasion'].exploit,3);assert.equal(byPrint.get('SEC_051').title,byPrint.get('SHD_157').title);assert.equal(byPrint.get('SEC_051').cost,9);assert.equal(byPrint.get('SOR_054').upgradePower,3);assert.equal(byPrint.get('SOR_054').upgradeHp,3);assert.ok(byPrint.get('TWI_251').aspects.includes('heroism'));
});

test('Primary event/nested payments, resource flags, card/owner conservation, stable replay and deck counts are exact',()=>{
 const prices=[10,8,5,7,8,4,4,7,8,2],ready=[9,12,15,9,12,16,16,13,12,18];for(const[i,d]of A12_DEFINITIONS.entries()){const r=staged(d.id);assert.equal(previewPlayCost(d,r.before,'p1',r.cue.playPayment),prices[i]);assert.equal(previewExtraPayment(d),d.id==='unnatural-life'?4:0);assert.equal(r.p.res.ready,ready[i]);assert.equal(r.p.res.total,d.id==='guerilla-insurgency'?19:20);assert.equal(r.q.res.ready,9);assert.equal(r.q.res.total,d.id==='guerilla-insurgency'?11:12);assert.equal(r.p.discard.filter(c=>c.id===r.cue.source.id).length,1);assert.ok(!r.p.hand.some(c=>c.id===r.cue.source.id));const made=r.cue.outcomes.filter(o=>o.kind==='create').map(o=>o.unit.id),before=physical(r.before),after=physical(r.after);assert.deepEqual(ids(after).filter(id=>!made.includes(id)).sort(),ids(before).sort());assert.equal(new Set(ids(after)).size,after.length);for(const old of before)assert.equal(after.find(c=>c.id===old.id).owner,old.owner);for(const p of Object.values(r.after.players)){assert.equal(p.resources.length,p.res.total);assert.equal(p.resources.filter(c=>!c.x).length,p.res.ready);assert.equal(p.knownDeck.length,p.deck);}assert.equal(r.p.deck,d.id==='wartime-profiteering'?26:d.id==='aid-from-the-innocent'?25:27);assert.equal(r.q.deck,29);}
});

test('Guerilla destroys a ready own and spent opposing resource, discards each player choices, then applies complete ground-only damage',()=>{
 const r=staged('guerilla-insurgency');assert.equal(r.p.res.ready,9);assert.equal(r.p.res.total,19);assert.equal(r.q.res.ready,9);assert.equal(r.q.res.total,11);assert.ok(r.p.discard.some(c=>c.id==='a12:p1:resource:10'));assert.ok(r.q.discard.some(c=>c.id==='a12:p2:resource:11'));assert.deepEqual(ids(r.p.hand),['a12:guerilla:hand:retained']);assert.equal(r.q.hand.length,0);const hits=r.cue.outcomes.filter(o=>o.kind==='damage');assert.deepEqual(ids(hits.map(o=>o.card)).sort(),ids(Object.values(r.before.players).flatMap(p=>p.ground)).sort());assert.equal(hits.length,6);assert.ok(hits.every(o=>o.amount===4&&o.zone==='ground'&&o.damageType==='ability'));assert.equal(get(r,'a12:guerilla:atst').d,4);assert.equal(get(r,'a12:p2:leader').d,6);assert.deepEqual([r.q.leader.dep,r.q.leader.x,r.q.leader.epic],[1,1,1]);assert.deepEqual(r.p.space,r.before.players.p1.space);assert.deepEqual(r.q.space,r.before.players.p2.space);assert.equal(r.after.defeatedThisPhase,undefined);
 const spent=staged('guerilla-insurgency',null,{resourceIds:{p1:'a12:p1:resource:0',p2:'a12:p2:resource:0'}});assert.equal(spent.p.res.ready,10);assert.equal(spent.q.res.ready,8);assert.equal(spent.p.res.total,19);assert.equal(spent.q.res.total,11);const stolen=staged('guerilla-insurgency',s=>s.players.p1.resources[10].owner='p2');assert.ok(stolen.q.discard.some(c=>c.id==='a12:p1:resource:10'));assert.ok(!stolen.p.discard.some(c=>c.id==='a12:p1:resource:10'));
});

test('Guerilla resource defeat never licenses unit history and independent clauses survive absent resources/short hands/prevention',()=>{
 const h={round:14,phase:'action',cards:[]};const r=staged('guerilla-insurgency',s=>s.defeatedThisPhase=clone(h));assert.deepEqual(r.after.defeatedThisPhase,h);const absent=staged('guerilla-insurgency',s=>{s.players.p2.resources=[];s.players.p2.res={ready:0,total:0};s.players.p2.hand.pop();s.players.p1.hand.splice(1);});assert.equal(absent.q.hand.length,0);assert.equal(absent.cue.outcomes.filter(o=>o.kind==='damage').length,6);assert.equal(absent.cue.outcomes.filter(o=>o.kind==='discard').length,1);const prevented=staged('guerilla-insurgency',null,null,c=>c.outcomes.find(o=>o.fromZone==='resources'&&o.seat==='p2').prevented=true);assert.equal(prevented.q.res.total,12);assert.equal(prevented.q.res.ready,9);assert.equal(get(prevented,'a12:guerilla:atst').d,4);
 for(const mutate of [o=>o.chooserSeat='p2',o=>o.ownerSeat='p2',o=>o.incarnation='fake-unit-entry',o=>o.sourceCard={...o.sourceCard,id:'unrelated'}])assert.throws(()=>staged('guerilla-insurgency',null,null,c=>mutate(c.outcomes[0])),/resource defeat/);assert.throws(()=>staged('guerilla-insurgency',null,{discardIds:{p1:['a12:guerilla:hand:repair']}}),/exact available two/);
});

test('Guerilla cannot fabricate unchanged resting power for a surviving printed-Grit unit',()=>{
 const f=byPrint.get('SOR_032');assert.deepEqual([f.power,f.hp],[1,4]);assert.ok(f.keywords.includes('grit'));
 assert.throws(()=>staged('guerilla-insurgency',s=>{
  const old=s.players.p1.ground[0];
  // One real Experience token makes Scout 2/5 before damage; four wounds would leave Grit power 6.
  s.players.p1.ground[0]={id:old.id,n:f.title,s:'SOR_032',owner:'p1',p:f.power+1,h:f.hp+1,d:0,traits:f.traits,
   printedTitle:f.title,unique:f.unique,leaderUnit:false,incarnation:old.incarnation,
   status:[{kind:'keyword',label:'Grit (printed)',duration:'permanent',keyword:{name:'Grit',amount:1}}],
   u:[{id:'a12:guerilla:scout:experience',n:'Experience',s:null,t:1,owner:'p1',controller:'p1',p:1,h:1}]};
 }),/resting-power change/);
});

test('Planetary Exploit3 pays after actual cost deaths, then readies either side with separate power-only and boolean phase grants',()=>{
 const r=staged('planetary-invasion');assert.equal(r.cue.outcomes.slice(0,3).every(o=>o.kind==='defeat'&&o.paymentRole==='exploit'),true);assert.equal(r.cue.outcomes[3].amount,-6);assert.equal(r.p.res.ready,12);for(const[id,power]of [['a12:planetary:marine',4],['a12:planetary:xwing',3],['a12:p2:trooper',4]]){const u=get(r,id),old=units(r.before.players.p1).concat(units(r.before.players.p2)).find(c=>c.id===id);assert.deepEqual([u.p,u.h,u.d,u.x],[power,old.h,old.d,undefined]);assert.equal(u.status.filter(s=>s.keyword?.name==='Overwhelm').length,1);assert.equal(u.status.at(-1).keyword.amount,1);assert.equal(u.status.at(-1).duration,'phase');assert.equal(u.status.at(-1).label,'Overwhelm · phase');}assert.ok(!r.cue.outcomes.some(o=>o.kind==='attack'||o.kind==='damage'));assert.equal(get(r,'a12:p1:marine'),undefined);
 for(const [n,ids] of [[],['a12:p1:marine'],['a12:p1:marine','a12:p1:defender'],['a12:p1:marine','a12:p1:defender','a12:p1:xwing']].entries()){const x=staged('planetary-invasion',null,{exploitIds:ids,unitIds:[]});assert.equal(previewPlayCost(x.d,x.before,'p1',x.cue.playPayment),14-2*n);assert.equal(x.p.res.ready,6+2*n);}assert.throws(()=>staged('planetary-invasion',null,{unitIds:['a12:p1:marine']}),/surviving/);assert.throws(()=>staged('planetary-invasion',null,{exploitIds:['a12:p1:marine','a12:p1:defender','a12:p1:xwing','a12:planetary:marine']}),/Exploit3/);assert.throws(()=>staged('planetary-invasion',null,null,c=>c.outcomes[0].prevented=true),/actual ordinary cost departure|cost sacrifices|cost-defeat prefix/);
});

test('Planetary Overwhelm has no stacking stat gain, correct current entry and canonical event, and normal Exhausted creation stays unchanged',()=>{
 const r=staged('planetary-invasion',null,{unitIds:['a12:p2:wampa']});const w=get(r,'a12:p2:wampa');assert.equal(w.p,5);assert.equal(w.h,5);assert.equal(w.d,1);assert.equal(w.status.filter(s=>s.keyword?.name==='Overwhelm').length,2);assert.equal(r.q.base.d,6);
 for(const mutate of [o=>o.keyword.amount=2,o=>o.incarnation='old',o=>o.sourceCard={...o.sourceCard,id:'other'}])assert.throws(()=>staged('planetary-invasion',null,null,c=>mutate(c.outcomes.find(o=>o.kind==='keyword'))),/Overwhelm/);
});

test('Wartime typed history counts actual unit entries on both sides and a ceased unit token; private shelf does not reveal selection',()=>{
 const r=staged('wartime-profiteering'),search=r.cue.outcomes[0];assert.equal(search.amount,3);assert.equal(search.unitDefeatCount.units.length,3);assert.equal(search.fromSeat,'p1');assert.deepEqual(search.deckOperation.revealedIds,[]);assert.equal(search.deckOperation.visibility,'private');assert.deepEqual(ids(r.p.hand),['a12:wartime:look:1']);assert.deepEqual(r.p.knownDeck.slice(-2).map(c=>c.s),['SOR_074','SOR_054']);assert.equal(r.p.deck,26);
 const repeated=staged('wartime-profiteering',s=>s.defeatedThisPhase.cards.push({...s.defeatedThisPhase.cards[0],incarnation:'a12:wartime:dead:marine:entry-2'}));assert.equal(repeated.cue.outcomes[0].amount,4);assert.equal(repeated.cue.outcomes[0].unitDefeatCount.units.length,4);const mixed=staged('wartime-profiteering',s=>s.defeatedThisPhase.cards.push({id:'old-upgrade',incarnation:'upgrade:1',lastKnownType:'upgrade'},{id:'old-shield',incarnation:'shield:1',lastKnownType:'token-upgrade'},{id:'old-resource',lastKnownType:'resource'}));assert.equal(mixed.cue.outcomes[0].amount,3);assert.equal(mixed.cue.outcomes[0].unitDefeatCount.units.length,3);
});

test('Wartime zero/short look and no selection conserve exact deck permutation; absent/stale/ambiguous history is not zero',()=>{
 const zero=staged('wartime-profiteering',s=>s.defeatedThisPhase.cards=[]);assert.equal(zero.cue.outcomes[0].amount,0);assert.equal(zero.cue.outcomes.length,1);assert.equal(zero.p.deck,27);assert.equal(zero.p.hand.length,0);const short=staged('wartime-profiteering',s=>{s.players.p1.knownDeck.length=2;s.players.p1.deck=2;});assert.equal(short.cue.outcomes[0].amount,2);assert.equal(short.p.deck,1);const none=staged('wartime-profiteering',null,{selectedIds:[]});assert.equal(none.p.deck,27);assert.equal(none.p.hand.length,0);assert.deepEqual(none.p.knownDeck.slice(-3).map(c=>c.s),['SOR_074','SOR_095','SOR_054']);
 for(const change of [s=>delete s.defeatedThisPhase,s=>s.defeatedThisPhase.round=13,s=>s.defeatedThisPhase.cards[2].lastKnownType='token'])assert.throws(()=>staged('wartime-profiteering',change),/typed unit defeat history/);
 for(const mutate of [o=>o.unitDefeatCount.units.pop(),o=>o.unitDefeatCount.units[0].incarnation='old',o=>o.amount=4,o=>o.deckOperation.revealedIds=[o.deckOperation.selectedIds[0]],o=>o.sourceCard={...o.sourceCard,id:'other'}])assert.throws(()=>staged('wartime-profiteering',null,null,c=>mutate(c.outcomes[0])),/unit-defeat/);
});

test('Unnatural pays event7 plus discounted actual Wampa4, enters clean ready from own discard and binds regroup to fresh entry',()=>{
 const r=staged('unnatural-life'),w=get(r,'a12:life:wampa');assert.deepEqual([w.p,w.h,w.d,w.x,w.owner,w.incarnation],[4,5,0,undefined,'p1','a12:life:wampa:entry-2']);assert.equal(r.p.res.ready,9);assert.deepEqual(r.cue.outcomes.map(o=>o.kind),['cost','pay','play','delay']);assert.equal(r.cue.outcomes[1].amount,4);assert.equal(r.cue.outcomes[2].fromZone,'discard');assert.equal(r.cue.outcomes[2].entersReady,true);assert.equal(r.after.mostRecentIncarnations[w.id],w.incarnation);assert.equal(r.after.pending[0].incarnation,w.incarnation);assert.equal(w.status.at(-1).label,'Defeat at regroup');const old=clone(r.after),reg=resolveStagedRegroup(r.after);assert.deepEqual(r.after,old);assert.equal(reg.after.phase,'regroup');assert.ok(reg.after.players.p1.discard.some(c=>c.id===w.id));assert.ok(!units(reg.after.players.p1).some(c=>c.id===w.id));assert.equal(reg.after.players.p1.res.ready,9);assert.equal(reg.after.players.p1.deck,27);assert.equal(reg.after.pending.length,0);
});

test('Unnatural requires most-recent exact unit history regardless of former controller and never carries an old obligation onto reentry',()=>{
 for(const change of [s=>s.defeatedThisPhase.phase='regroup',s=>s.mostRecentIncarnations['a12:life:wampa']='later-entry',s=>s.defeatedThisPhase.cards[0].lastKnownType='resource',s=>s.players.p1.discard=[]])assert.throws(()=>staged('unnatural-life',change),/phase actual unit defeat|discard unit/);
 for(const mutate of [c=>c.outcomes[0].defeatedEntry.incarnation='old',c=>c.outcomes[0].sourceCard={...c.source,id:'other'},c=>c.outcomes[2].unit.incarnation='a12:life:wampa:entry-1',c=>c.outcomes[2].unit.d=1,c=>c.outcomes[2].unit.x=1,c=>c.outcomes[2].fromZone='hand'])assert.throws(()=>staged('unnatural-life',null,null,mutate),/discard replay|corpse replay/);
 const r=staged('unnatural-life');r.after.players.p1.ground.find(c=>c.id==='a12:life:wampa').incarnation='a12:life:wampa:entry-3';const reg=resolveStagedRegroup(r.after);assert.ok(units(reg.after.players.p1).some(c=>c.id==='a12:life:wampa'));assert.ok(!reg.after.players.p1.discard.some(c=>c.id==='a12:life:wampa'));assert.equal(reg.after.pending.length,0);
});

test('Doorstep creates exactly three fresh ready Droids without play origin, separate ready or inherited abilities',()=>{
 const r=staged('on-the-doorstep');assert.equal(r.cue.outcomes.length,3);for(const o of r.cue.outcomes){assert.equal(o.kind,'create');assert.equal(o.entryType,'created');assert.equal(o.entersReady,true);assert.deepEqual([o.unit.p,o.unit.h,o.unit.d,o.unit.x,o.unit.t,o.unit.owner],[1,1,0,undefined,1,'p1']);assert.equal(o.unit.status,undefined);assert.equal(o.fromZone,undefined);assert.equal(o.unit.incarnation,`${o.unit.id}:entry-1`);}assert.equal(new Set(r.cue.outcomes.map(o=>o.unit.id)).size,3);
 for(const mutate of [o=>o.unit.x=1,o=>o.entersReady=false,o=>o.entersReady=undefined,o=>o.unit.id='a12:p1:marine',o=>o.prevented=true,o=>o.unit.status=[{kind:'buff',label:'old',duration:'phase'}]])assert.throws(()=>staged('on-the-doorstep',null,null,c=>mutate(c.outcomes[0])),/creation/);
});

test('Clear matches printed title across subtitles and high cost enemy print, returning only selected plus exact enemies to owners',()=>{
 const r=staged('clear-the-field');assert.deepEqual(ids(r.p.hand),['a12:clear:own']);assert.deepEqual(r.q.hand.slice(-2).map(c=>c.id),['a12:clear:enemy-low','a12:clear:enemy-high']);assert.equal(r.cue.outcomes[0].sameNameGroup.selectedPrintedCost,2);assert.equal(r.cue.outcomes[0].sameNameGroup.title,'Bo-Katan Kryze');assert.equal(byPrint.get('SEC_051').cost,9);assert.deepEqual(r.q.space,r.before.players.p2.space);assert.equal(r.q.discard.length,0);assert.equal(r.p.discard.length,1);for(const c of [...r.p.hand,...r.q.hand])assert.equal('p'in c,false);
 const enemy=staged('clear-the-field',null,{targetId:'a12:clear:enemy-low'});assert.equal(enemy.cue.outcomes.length,2);assert.ok(get(enemy,'a12:clear:own'));assert.ok(!enemy.p.hand.length);const stolen=staged('clear-the-field',s=>s.players.p2.ground.find(u=>u.id==='a12:clear:enemy-high').owner='p1');assert.ok(stolen.p.hand.some(c=>c.id==='a12:clear:enemy-high'));assert.ok(!stolen.q.hand.some(c=>c.id==='a12:clear:enemy-high'));
});

test('Clear sealed title group rejects missing/extra members, subtitle matching, old entry, wrong selected cost and unknown classification',()=>{
 for(const mutate of [c=>c.outcomes.pop(),c=>c.outcomes[0].sameNameGroup.members.pop(),c=>c.outcomes[0].sameNameGroup.title='Bo-Katan Kryze: Fighting For Mandalore',c=>c.outcomes[0].sameNameGroup.selectedPrintedCost=9,c=>c.outcomes[0].sameNameGroup.selectedIncarnation='old',c=>c.outcomes[0].prevented=true,c=>c.outcomes[0].sourceCard={...c.source,id:'other'}])assert.throws(()=>staged('clear-the-field',null,null,mutate),/same-title/);assert.throws(()=>staged('clear-the-field',s=>delete s.players.p2.ground[0].printedTitle),/complete current printed/);assert.throws(()=>staged('clear-the-field',null,{targetId:'a12:p2:wampa'}),/printed cost at most/);
});

test('Clear token title matches cease rather than inventing hand cards',()=>{
 const make=(id,owner)=>({id,n:'Battle Droid',s:null,owner,t:1,p:1,h:1,d:0,x:1,printedTitle:'Battle Droid',unique:false,leaderUnit:false,incarnation:`${id}:entry-1`});const r=staged('clear-the-field',s=>{s.players.p1.ground.push(make('a12:clear:token-own','p1'));s.players.p2.ground.push(make('a12:clear:token-enemy','p2'));}, {targetId:'a12:clear:token-own'});assert.ok(!physical(r.after).some(c=>c.id==='a12:clear:token-own'||c.id==='a12:clear:token-enemy'));
});

test('Creative exhaustion and Clone creation share one simultaneous window but creation does not require exhaustion success',()=>{
 const r=staged('creative-thinking');assert.equal(get(r,'a12:p2:tie').x,1);const clone=get(r,'a12:creative:clone:0');assert.deepEqual([clone.p,clone.h,clone.d,clone.x,clone.owner],[2,2,0,1,'p1']);assert.equal(r.cue.outcomes[0].amount,1);assert.deepEqual(r.cue.outcomes[0].resolutionGroup,r.cue.outcomes[1].resolutionGroup);assert.equal(r.cue.outcomes[1].requiresExhaust,undefined);
 const already=staged('creative-thinking',s=>s.players.p2.space[0].x=1);assert.equal(already.cue.outcomes[0].amount,0);assert.ok(get(already,'a12:creative:clone:0'));const noTarget=staged('creative-thinking',null,{targetId:null});assert.equal(noTarget.cue.outcomes.length,1);assert.ok(get(noTarget,'a12:creative:clone:0'));const prevented=staged('creative-thinking',null,null,c=>c.outcomes[0].prevented=true);assert.equal(get(prevented,'a12:p2:tie').x,undefined);assert.ok(get(prevented,'a12:creative:clone:0'));assert.throws(()=>staged('creative-thinking',s=>s.players.p2.space[0].unique=true,{targetId:'a12:p2:tie'}),/nonunique/);
});

test('In Pursuit actually exhausts friendly ground then enemy space with exact successful entry dependency, no attack/damage',()=>{
 const r=staged('in-pursuit');assert.equal(r.cue.outcomes.length,2);assert.deepEqual(r.cue.outcomes.map(o=>[o.kind,o.amount,o.seat,o.zone]),[['exhaust',1,'p1','ground'],['exhaust',1,'p2','space']]);assert.deepEqual(r.cue.outcomes[1].requiresExhaust,{id:'a12:p1:marine',incarnation:'a12:p1:marine:entry-1'});assert.deepEqual([get(r,'a12:p1:marine').x,get(r,'a12:p2:tie').x],[1,1]);assert.equal(get(r,'a12:p1:marine').d,1);assert.equal(get(r,'a12:p2:tie').d,0);assert.equal(r.q.base.d,6);
 const already=staged('in-pursuit',s=>s.players.p1.ground[0].x=1);assert.equal(already.cue.outcomes.length,1);assert.equal(already.cue.outcomes[0].amount,0);assert.equal(get(already,'a12:p2:tie').x,undefined);const none=staged('in-pursuit',null,{targetId:null});assert.equal(none.cue.outcomes.length,0);assert.equal(none.p.res.ready,18);
 for(const mutate of [c=>c.outcomes[0].prevented=true,c=>c.outcomes.shift(),c=>c.outcomes[1].requiresExhaust.incarnation='old',c=>c.outcomes[0].sourceCard={...c.source,id:'other'},c=>c.outcomes[1].sourceCard={...c.source,id:'other'}])assert.throws(()=>staged('in-pursuit',null,null,mutate),/actual successful friendly/);assert.throws(()=>staged('in-pursuit',null,{targetId:'a12:p2:trooper'}),/friendly unit/);
});

test('Aid privately selects only Heroism nonunit cards, separates actual two discards from grants and retains phase availability without play',()=>{
 const r=staged('aid-from-the-innocent');assert.equal(r.p.deck,25);assert.equal(r.p.hand.length,0);assert.equal(r.p.res.ready,13);assert.deepEqual(r.cue.outcomes.map(o=>o.kind),['search','discard','discard','cost','cost']);assert.equal(r.cue.outcomes[0].deckOperation.visibility,'private');assert.deepEqual(r.cue.outcomes[0].deckOperation.revealedIds,['a12:aid:look:0','a12:aid:look:1']);assert.deepEqual(r.after.discardPlayPermissions.map(p=>p.cardId),['a12:aid:look:0','a12:aid:look:1']);for(const p of r.after.discardPlayPermissions){assert.equal(p.discount,2);assert.equal(p.round,14);assert.equal(p.phase,'action');assert.equal(p.fromZone,'discard');assert.ok(p.aspects.includes('heroism'));}assert.deepEqual(r.p.ground,r.before.players.p1.ground);assert.deepEqual(r.p.space,r.before.players.p1.space);
 for(const selectedIds of [[],['a12:aid:look:0']]){const x=staged('aid-from-the-innocent',null,{selectedIds});assert.equal(x.p.deck,27-selectedIds.length);assert.equal(x.after.discardPlayPermissions?.length??0,selectedIds.length);}for(const selectedIds of [['a12:aid:look:2'],['a12:aid:look:4'],['a12:aid:look:7'],['a12:aid:look:0','a12:aid:look:1','a12:aid:look:8']])assert.throws(()=>staged('aid-from-the-innocent',null,{selectedIds}),/Heroism nonunit|exact deck group/);
});

test('Aid later Jedi pays actual three minus two equals one from discard, preserving host wounds/readiness and consuming only that permission',()=>{
 const r=later(),m=get(r,'a12:p1:marine');assert.deepEqual([m.p,m.h,m.d,m.x],[6,6,1,undefined]);assert.equal(m.u[0].s,'SOR_054');assert.deepEqual([m.u[0].p,m.u[0].h,m.u[0].owner,m.u[0].controller],[3,3,'p1','p1']);assert.equal(r.p.res.ready,12);assert.equal(r.p.deck,25);assert.equal(r.cue.playPayment,undefined);assert.equal(r.cue.playCost,undefined);assert.deepEqual(r.after.discardPlayPermissions.map(p=>p.cardId),['a12:aid:look:1']);assert.ok(!r.p.discard.some(c=>c.id==='a12:aid:look:0'));assert.equal(r.p.discard.filter(c=>c.id===r.cue.source.id).length,1);assert.equal(m.status,undefined);
});

test('Aid grants require successful exact deck discard, current phase/source, Heroism nonunit facts and no duplicates/prevention',()=>{
 for(const mutate of [c=>c.outcomes[1].prevented=true,c=>c.outcomes.splice(1,1),c=>c.outcomes[3].phasePlayPermission.round=13,c=>c.outcomes[3].phasePlayPermission.sourceId='other',c=>c.outcomes[3].phasePlayPermission.aspects=['vigilance'],c=>c.outcomes[3].phasePlayPermission.cardType='unit',c=>c.outcomes[3].phasePlayPermission.discount=1,c=>c.outcomes[3].sourceCard={...c.source,id:'other'},c=>c.outcomes[3].prevented=true,c=>c.outcomes.push(clone(c.outcomes[3]))])assert.throws(()=>staged('aid-from-the-innocent',null,null,mutate),/phase discard permission/);
});

test('Aid play permission expires by phase, actual leave-discard or consumption and cannot become an event replay loop',()=>{
 for(const change of [s=>s.phase='regroup',s=>s.round=15,s=>s.discardPlayPermissions=[],s=>s.players.p1.discard=s.players.p1.discard.filter(c=>c.id!=='a12:aid:look:0'),s=>s.players.p1.ground[0].traits=['vehicle']])assert.throws(()=>later(change),/phase permission|discard card|non-Vehicle/);
 for(const mutate of [c=>c.outcomes[0].phasePermissionId='other',c=>c.outcomes[2].phasePermissionId='other',c=>c.outcomes[1].amount=0,c=>c.outcomes[2].fromZone='hand',c=>c.outcomes[0].amount=-1,c=>c.outcomes[2].sourceCard={...c.source,id:'other'}])assert.throws(()=>later(null,mutate),/phase permission|permitted upgrade|discount must|additional payment/);
 const r=staged('aid-from-the-innocent'),selected=r.p.discard.find(c=>c.id==='a12:aid:look:1'),cue={definition:r.d,source:r.cue.source,seat:'p1',target:null,key:'external-move',stage:'next-action',outcomes:[{kind:'recover',card:selected,seat:'p1',zone:'hand',fromZone:'discard'}]};const moved=resolvePreviewState(r.after,cue);assert.ok(!moved.discardPlayPermissions.some(p=>p.cardId===selected.id));moved.players.p1.hand=moved.players.p1.hand.filter(c=>c.id!==selected.id);moved.players.p1.discard.push(selected);assert.ok(!moved.discardPlayPermissions.some(p=>p.cardId===selected.id));
});

test('Impropriety exchanges ready units in opposite arenas atomically with actual owner-return pending and preserves entry/stats/wounds',()=>{
 const r=staged('impropriety-among-thieves');assert.ok(r.q.ground.some(c=>c.id==='a12:p1:marine'));assert.ok(r.p.space.some(c=>c.id==='a12:p2:tie'));assert.ok(!r.p.ground.some(c=>c.id==='a12:p1:marine'));assert.ok(!r.q.space.some(c=>c.id==='a12:p2:tie'));assert.equal(r.after.pending.length,2);assert.deepEqual(r.after.pending.map(p=>p.returnController),['p1','p2']);for(const id of ['a12:p1:marine','a12:p2:tie']){const old=units(r.before.players.p1).concat(units(r.before.players.p2)).find(c=>c.id===id),end=get(r,id);assert.deepEqual([end.p,end.h,end.d,end.x,end.owner,end.incarnation],[old.p,old.h,old.d,old.x,old.owner,old.incarnation]);assert.equal(end.status[0].duration,'regroup');assert.equal(end.status[1].kind,'delay');}const reg=resolveStagedRegroup(r.after);assert.ok(reg.after.players.p1.ground.some(c=>c.id==='a12:p1:marine'));assert.ok(reg.after.players.p2.space.some(c=>c.id==='a12:p2:tie'));assert.equal(reg.after.pending.length,0);assert.equal(reg.after.players.p1.res.ready,12);assert.equal(reg.after.players.p1.deck,27);assert.equal(units(reg.after.players.p1).find(c=>c.id==='a12:p1:marine').status,undefined);
});

test('Impropriety no pair makes no exchange, stale/departed units do not return, and original controller is not owner',()=>{
 const none=staged('impropriety-among-thieves',s=>units(s.players.p2).forEach(u=>u.x=1));assert.equal(none.cue.outcomes.length,0);assert.equal(none.p.res.ready,12);assert.equal(none.after.pending,undefined);assert.throws(()=>staged('impropriety-among-thieves',s=>s.players.p1.ground[0].x=1,{targetId:'a12:p1:marine'}),/both opposite ready/);
 for(const mutate of [c=>c.outcomes[0].duration='permanent',c=>c.outcomes[2].pending.returnController='p2',c=>c.outcomes.splice(1,1),c=>c.outcomes[0].sourceCard={...c.source,id:'other'}])assert.throws(()=>staged('impropriety-among-thieves',null,null,mutate),/exchange/);
 const stolen=staged('impropriety-among-thieves',s=>s.players.p2.space[0].owner='p1');assert.deepEqual(stolen.after.pending.map(p=>p.returnController),['p1','p1']);const reg=resolveStagedRegroup(stolen.after);assert.ok(reg.after.players.p1.ground.some(c=>c.id==='a12:p1:marine'));assert.ok(reg.after.players.p1.space.some(c=>c.id==='a12:p2:tie'));
 const stale=staged('impropriety-among-thieves');stale.q.ground.find(c=>c.id==='a12:p1:marine').incarnation='new-entry';const after=resolveStagedRegroup(stale.after).after;assert.ok(after.players.p2.ground.some(c=>c.id==='a12:p1:marine'));assert.equal(after.pending.length,0);
});

test('Narrow new witnesses reject unrelated kinds and source APIs preserve unknown catalogue scope',()=>{
 for(const[id,index,kind]of [['wartime-profiteering',0,'draw'],['unnatural-life',0,'damage'],['clear-the-field',0,'defeat'],['in-pursuit',1,'ready'],['aid-from-the-innocent',3,'play']])assert.throws(()=>staged(id,null,null,c=>c.outcomes[index].kind=kind),/concrete receipt kind/);
 const d=def('in-pursuit'),s=a12ShowcaseState(d);s.players.p1.hand=[];assert.throws(()=>a12PreviewSource(d,s,'p1'),/exact own source/);const unknown={...d,id:'unknown'};assert.equal(a12ShowcaseState(unknown),undefined);assert.equal(a12PreviewSource(unknown,s,'p1'),undefined);assert.equal(a12PreviewPayment(unknown,s,'p1'),undefined);assert.equal(a12PreviewOutcomes(unknown,s,'p1'),undefined);assert.equal(a12LaterActionOutcomes(unknown,s,'p1'),undefined);
});

test('Unnatural Life replays a printed Sentinel with that native ability on its fresh ready entry',()=>{
 const fact=byPrint.get('SOR_098');assert.ok(fact.keywords.includes('sentinel'));
 const r=staged('unnatural-life',s=>{s.players.p1.discard[0]={...s.players.p1.discard[0],n:fact.title,s:'SOR_098'};});
 const entering=get(r,'a12:life:wampa');assert.equal(entering.n,fact.title);assert.equal(entering.sn,1);
 assert.deepEqual([entering.p,entering.h,entering.d,entering.x],[fact.power,fact.hp,0,undefined]);
 assert.equal(r.cue.outcomes.find(o=>o.kind==='pay').amount,1);assert.equal(r.p.res.ready,12);
 assert.equal(entering.status.at(-1).label,'Defeat at regroup');
});
