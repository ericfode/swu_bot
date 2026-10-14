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
const {A09_DEFINITIONS,A09_COSTS,A09_ABILITIES,a09ShowcaseState,a09PreviewSource,a09PreviewOutcomes,a09PreviewPayment}=loadTS(path.join(__dirname,'../src/effects/batchA09.ts'));
const {resolvePreviewState}=loadTS(path.join(__dirname,'../src/effects/previewState.ts'));
const {previewPlayCost,previewExtraPayment}=loadTS(path.join(__dirname,'../src/effects/previewCosts.ts'));
const clone=structuredClone,ids=a=>a.map(c=>c.id),def=id=>A09_DEFINITIONS.find(d=>d.id===id);
function staged(id,change,choices,changeCue){const d=def(id),before=a09ShowcaseState(d);if(change)change(before);const cue={definition:d,seat:'p1',source:a09PreviewSource(d,before,'p1'),target:null,key:'a09:focused',playPayment:a09PreviewPayment(d,before,'p1',choices??{}),outcomes:a09PreviewOutcomes(d,before,'p1',choices??{})};if(changeCue)changeCue(cue,before);const old=clone(before),oldCue=clone(cue),after=resolvePreviewState(before,cue);assert.deepEqual(before,old);assert.deepEqual(cue,oldCue);assert.deepEqual(resolvePreviewState(before,cue),after);return{d,before,cue,after,p:after.players.p1,q:after.players.p2};}
const units=p=>[...p.ground,...p.space],get=(r,id)=>units(r.p).concat(units(r.q)).find(u=>u.id===id);
const cardDir=path.join(__dirname,'../../forceteki/test/json/Card'),cards=fs.readdirSync(cardDir).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(cardDir,f))));
const byPrint=new Map(cards.flatMap(c=>(c.setCodes??[]).map(p=>[`${p.set}_${String(p.number).padStart(3,'0')}`,c]))),reverse=JSON.parse(fs.readFileSync(path.join(cardDir,'../_setCodeMap.json'))),token=cards.find(c=>c.id==='3463348370');
const physical=s=>Object.values(s.players).flatMap(p=>[p.base,...(p.leader?.dep===0?[p.leader]:[]),...p.hand,...p.discard,...(p.resources??[]),...(p.knownDeck??[]),...p.ground,...p.space,...units(p).flatMap(c=>[...(c.u??[]),...(c.cap??[])])]);
test('All ten A09 primary state applications',()=>{for(const d of A09_DEFINITIONS){const r=staged(d.id);assert.equal(r.p.base.d,9);assert.equal(r.q.base.d,6);}});

test('Installed JSON independently verifies all canonical identities, sole aliases, exact names/aspects and real supporting stats',()=>{
 const canonical=['4036958275','5013214638','9399634203','6732988831','2359136621','3596811933','0968965258','2565830105','7579458834','4895747419'];
 for(const [i,d] of A09_DEFINITIONS.entries()){const f=byPrint.get(d.setCode);assert.equal(f.id,canonical[i]);assert.equal(d.name,f.title);assert.equal(f.unique,false);assert.deepEqual({printed:A09_COSTS[d.id].printed,aspects:A09_COSTS[d.id].aspects},{printed:f.cost,aspects:f.aspects});assert.deepEqual(Object.keys(reverse).filter(p=>reverse[p]===f.id),[d.setCode]);const b=a09ShowcaseState(d);for(const p of Object.values(b.players)){assert.equal(p.resources.length,p.res.total);assert.equal(p.resources.filter(r=>!r.x).length,p.res.ready);assert.equal(p.knownDeck.length,p.deck);for(const u of units(p)){const face=u.t?token:byPrint.get(u.s);assert.equal(u.p,face.power+(u.u??[]).reduce((n,a)=>n+(a.p??0),0));assert.equal(u.h,face.hp+(u.u??[]).reduce((n,a)=>n+(a.h??0),0));assert.equal(face.arena,p.ground.includes(u)?'ground':'space');assert.ok(u.d<u.h);assert.ok(u.id&&u.incarnation);assert.ok(u.owner);for(const a of u.u??[]){const printed=byPrint.get(a.s);assert.equal(a.p,printed.power);assert.equal(a.h,printed.hp);}}}}
 assert.deepEqual([token.title,token.cost,token.power,token.hp,token.arena],['Battle Droid',0,1,1,'ground']);assert.deepEqual(token.types,['token','unit']);assert.equal(token.setCodes,undefined);assert.deepEqual(token.aspects,['villainy']);assert.ok(token.traits.includes('droid'));assert.match(byPrint.get('TWI_078').text,/Exploit 4/);assert.match(byPrint.get('TWI_089').text,/Then, defeat the chosen units/);assert.equal(A09_COSTS['the-invasion-of-christophsis'].exploit,4);
});

test('Primary payments and every physical owner are conserved, with explicit token creation/cessation exceptions',()=>{
 const costs=[3,5,1,2,2,3,5,7,5,8];for(const [i,d]of A09_DEFINITIONS.entries()){const r=staged(d.id);assert.equal(previewPlayCost(d,r.before,'p1',r.cue.playPayment),costs[i]);assert.equal(previewExtraPayment(d),0);assert.equal(r.p.res.ready,16-costs[i]);assert.equal(r.p.res.total,16);assert.equal(r.p.discard.filter(c=>c.id===r.cue.source.id).length,1);assert.equal(r.p.hand.filter(c=>c.id===r.cue.source.id).length,0);const original=physical(r.before),final=physical(r.after),created=r.cue.outcomes.filter(o=>o.kind==='create').map(o=>o.unit.id),ceased=r.cue.outcomes.filter(o=>o.kind==='defeat'&&o.card.t).map(o=>o.card.id);assert.equal(new Set(ids(final)).size,final.length);assert.deepEqual(ids(final).filter(id=>!created.includes(id)).sort(),ids(original).filter(id=>!ceased.includes(id)).sort());for(const card of original)if(!ceased.includes(card.id))assert.equal(final.find(c=>c.id===card.id)?.owner,card.owner);assert.deepEqual(r.p.base,r.before.players.p1.base);assert.deepEqual(r.q.base,r.before.players.p2.base);for(const p of Object.values(r.after.players)){assert.equal(p.resources.length,p.res.total);assert.equal(p.resources.filter(c=>!c.x).length,p.res.ready);assert.equal(p.knownDeck.length,p.deck);}}
});

test('Hello requires actual current entry evidence and changes maximum HP/power without adding wounds or changing pose',()=>{
 const r=staged('hello-there'),at=get(r,'a09:hello:atst');assert.deepEqual([at.p,at.h,at.d,at.x],[2,3,0,1]);assert.equal(at.status[0].kind,'debuff');assert.equal(at.status[0].duration,'phase');assert.equal(r.q.res.ready,4);assert.equal(r.q.discard.length,0);
 for(const entryType of ['played','created','rescued','deployed'])staged('hello-there',s=>s.enteredThisPhase.units[0].entryType=entryType);
 assert.throws(()=>staged('hello-there',s=>delete s.enteredThisPhase),/entry prerequisite/);assert.throws(()=>staged('hello-there',s=>s.enteredThisPhase.round--),/entry prerequisite/);assert.throws(()=>staged('hello-there',null,null,c=>c.outcomes[0].enteredPhase.incarnation='old'),/current entry history/);assert.throws(()=>staged('hello-there',null,null,c=>c.outcomes[0].enteredPhase.phase='regroup'),/current phase/);
});

test('Hello can reduce a proven newly created token to zero and cease it without a discard or extra damage',()=>{
 const r=staged('hello-there',s=>{const u={id:'a09:hello:new-token',n:'Battle Droid',s:null,owner:'p2',t:1,p:1,h:1,d:0,x:1,incarnation:'a09:hello:new-token:entry-1'};s.players.p2.ground.push(u);s.enteredThisPhase.units.push({id:u.id,incarnation:u.incarnation,entryType:'created'});},{targetId:'a09:hello:new-token'});assert.ok(!get(r,'a09:hello:new-token'));assert.ok(!r.q.discard.some(c=>c.id==='a09:hello:new-token'));assert.equal(r.cue.outcomes[1].kind,'defeat');assert.equal(r.cue.outcomes[0].amount,'−4/−4');assert.ok(!r.cue.outcomes.some(o=>o.kind==='damage'));
});

test('Equalize counts actual units after first effect and defeats second target from unchanged existing wound',()=>{
 const r=staged('equalize');assert.deepEqual([get(r,'a09:p2:wampa').p,get(r,'a09:p2:wampa').h,get(r,'a09:p2:wampa').d],[2,3,1]);assert.ok(!get(r,'a09:p2:trooper'));assert.ok(r.q.discard.some(c=>c.id==='a09:p2:trooper'));assert.deepEqual(r.cue.outcomes[1].unitCountCondition,{firstId:'a09:p2:wampa',incarnation:'a09:p2:wampa:entry-1',player:'p1',against:'p2',ownCount:2,otherCount:4});
 const equality=staged('equalize',s=>{s.players.p1.ground.push({id:'a09:equalize:own-third',n:'Echo Base Defender',s:'SOR_098',owner:'p1',p:4,h:3,d:0,sn:1,incarnation:'a09:equalize:own-third:entry-1'});},{firstId:'a09:p2:tie'});assert.equal(equality.cue.outcomes.filter(o=>o.kind==='debuff').length,1);assert.equal(equality.q.space.length,0);assert.equal(units(equality.p).length,3);assert.equal(units(equality.q).length,3);
 const friendly=staged('equalize',null,{firstId:'a09:p1:marine'});assert.equal(friendly.cue.outcomes.filter(o=>o.kind==='debuff').length,1);assert.deepEqual([get(friendly,'a09:p1:marine').p,get(friendly,'a09:p1:marine').h],[1,1]);
 assert.throws(()=>staged('equalize',null,{secondId:'a09:p2:wampa'}),/different second/);for(const mutate of [o=>o.unitCountCondition.ownCount++,o=>o.unitCountCondition.against='p1',o=>o.unitCountCondition.incarnation='old',o=>o.sequenceId='other'])assert.throws(()=>staged('equalize',null,null,c=>mutate(c.outcomes[1])),/post-first counts/);
});

test('High Ground stores a continuing friendly defensive condition and changes no resting arena stats',()=>{
 const r=staged('i-have-the-high-ground'),d=get(r,'a09:p1:defender');for(const p of ['p1','p2'])for(const old of units(r.before.players[p])){const end=get(r,old.id);assert.deepEqual([end.p,end.h,end.d,end.x,end.sn],[old.p,old.h,old.d,old.x,old.sn]);}assert.equal(d.status[0].label,'DEFENDING: ATTACKER −4');assert.deepEqual(d.status[0].defenseModifier,{attackerPower:-4,sourceId:r.cue.source.id,round:11,phase:'action',incarnation:d.incarnation});assert.ok(!r.cue.outcomes.some(o=>o.kind==='attack'));
 assert.throws(()=>staged('i-have-the-high-ground',null,{targetId:'a09:p2:wampa'}),/friendly/);for(const mutate of [m=>m.sourceId='other',m=>m.incarnation='old',m=>m.round=10,m=>m.attackerPower=-3])assert.throws(()=>staged('i-have-the-high-ground',null,null,c=>mutate(c.outcomes[0].defenseModifier)),/defensive status/);
});

function laterDefense(change){const r=staged('i-have-the-high-ground'),before=r.after,w=before.players.p2.ground.find(c=>c.id==='a09:p2:wampa'),d=before.players.p1.ground.find(c=>c.id==='a09:p1:defender'),attackId='a09:high:actual-later';const cue={definition:r.d,source:null,seat:'p2',target:d,key:'a09:later',outcomes:[{kind:'debuff',seat:'p2',zone:'ground',card:w,amount:'−4/−0',duration:'attack',attackId,attackRole:'attacker',defenseOrigin:{protectedId:d.id,incarnation:d.incarnation,sourceId:r.cue.source.id}},{kind:'attack',seat:'p1',zone:'ground',card:d,sourceCard:w,attackId},{kind:'exhaust',seat:'p2',zone:'ground',card:w,attackId},{kind:'damage',seat:'p1',zone:'ground',card:d,sourceCard:w,amount:0,damageType:'combat',attackId,attackIndex:1},{kind:'damage',seat:'p2',zone:'ground',card:w,sourceCard:d,amount:4,damageType:'combat',attackId,attackIndex:2},{kind:'defeat',seat:'p2',zone:'ground',card:w,incarnation:w.incarnation,ownerSeat:'p2'}]};if(change)change(cue,before);return{before,cue,after:resolvePreviewState(before,cue)};}
test('Later legal attack against Sentinel uses transient attacker power floor zero and actual counterdamage, without paying event again',()=>{
 const r=laterDefense();assert.equal(r.after.players.p1.res.ready,15);assert.equal(r.after.players.p2.res.ready,7);assert.equal(r.after.players.p1.ground.find(c=>c.id==='a09:p1:defender').d,0);assert.ok(r.after.players.p2.discard.some(c=>c.id==='a09:p2:wampa'));assert.ok(!units(r.after.players.p2).some(c=>c.id==='a09:p2:wampa'));assert.ok(!units(r.after.players.p1).some(c=>c.status?.some(s=>s.duration==='attack')));
 assert.throws(()=>laterDefense(c=>c.outcomes[3].amount=1),/attack-scoped/);assert.throws(()=>laterDefense(c=>c.outcomes[0].defenseOrigin.incarnation='old'),/defensive status/);assert.throws(()=>laterDefense((c,s)=>s.phase='regroup'),/defensive status/);assert.throws(()=>laterDefense((c,s)=>c.outcomes[1].card=s.players.p1.ground[0]),/protected continuing/);
});

test('Reassembly healing and creation share simultaneous timing but the token has no heal success dependency',()=>{
 const r=staged('grievous-reassembly'),w=get(r,'a09:p2:wampa'),created=get(r,'a09:reassembly:droid:0');assert.deepEqual([w.p,w.h,w.d,w.x],[4,5,1,undefined]);assert.deepEqual([created.t,created.p,created.h,created.d,created.x,created.owner],[1,1,1,0,1,'p1']);assert.deepEqual(r.cue.outcomes[0].resolutionGroup,r.cue.outcomes[1].resolutionGroup);assert.equal(r.cue.outcomes[1].requiresDefeat,undefined);
 const zero=staged('grievous-reassembly',s=>s.players.p2.ground[1].d=0);assert.equal(zero.cue.outcomes[0].amount,0);assert.ok(get(zero,'a09:reassembly:droid:0'));
 const none=staged('grievous-reassembly',s=>{s.players.p1.ground=[];s.players.p1.space=[];s.players.p2.ground=[];s.players.p2.space=[];});assert.equal(none.cue.outcomes.length,1);assert.equal(none.cue.outcomes[0].kind,'create');assert.equal(units(none.p).length,1);
 const partial=staged('grievous-reassembly',s=>s.players.p2.ground[1].d=1);assert.equal(get(partial,'a09:p2:wampa').d,0);assert.equal(partial.cue.outcomes[0].amount,1);
});

test('Created token identities, complete faces, owner, exhausted pose and new-entry meaning are mandatory',()=>{
 for(const mutate of [o=>o.prevented=true,o=>o.unit.id='a09:p1:marine',o=>o.unit.p=2,o=>o.unit.t=undefined,o=>o.entersReady=true,o=>o.unit.x=undefined,o=>o.ownerSeat='p2',o=>o.fromZone='hand',o=>o.entryType='played',o=>o.sourceCard={...o.sourceCard,id:'other'},o=>o.incarnation='other',o=>o.unit.n='Unknown card'])assert.throws(()=>staged('death-by-droids',null,null,c=>mutate(c.outcomes[1])),/creation/);
 assert.throws(()=>staged('death-by-droids',null,null,c=>c.outcomes[2]=clone(c.outcomes[1])),/creation/);
 const r=staged('death-by-droids');for(const o of r.cue.outcomes.filter(o=>o.kind==='create')){assert.equal(o.fromZone,undefined);assert.equal(o.printedCost,undefined);assert.equal(o.unit.status,undefined);assert.equal(o.unit.u,undefined);}assert.ok(!r.cue.outcomes.some(o=>o.kind==='play'||o.kind==='draw'||o.kind==='pay'));
});

test('Guard grants Sentinel on either side, and only event-controller initiative permits its separate actual stat bonus',()=>{
 const r=staged('guarding-the-way'),x=get(r,'a09:p1:xwing');assert.deepEqual([x.p,x.h,x.d,x.x,x.sn],[4,5,0,undefined,1]);assert.deepEqual(x.status.map(s=>s.kind),['keyword','buff']);assert.equal(x.status[0].keyword.name,'Sentinel');assert.equal(x.u,undefined);
 for(const initiative of ['p2',null]){const no=staged('guarding-the-way',s=>s.initiative=initiative);assert.deepEqual([get(no,'a09:p1:xwing').p,get(no,'a09:p1:xwing').h,get(no,'a09:p1:xwing').sn],[2,3,1]);assert.equal(no.cue.outcomes.length,1);}
 const enemy=staged('guarding-the-way',null,{targetId:'a09:p2:wampa'});assert.deepEqual([get(enemy,'a09:p2:wampa').p,get(enemy,'a09:p2:wampa').h,get(enemy,'a09:p2:wampa').d,get(enemy,'a09:p2:wampa').sn],[6,7,1,1]);
 assert.throws(()=>staged('guarding-the-way',null,null,c=>c.outcomes[1].condition.player='p2'),/event-controller initiative/);assert.throws(()=>staged('guarding-the-way',null,null,c=>c.outcomes[0].keyword.amount=2),/Sentinel grant/);
});

test('Burst affects all five opponent-controlled units across arenas, distinguishes real card discard from token cease, and leaves Vader deployed',()=>{
 const r=staged('disruptive-burst');assert.equal(r.cue.outcomes.filter(o=>o.kind==='debuff').length,5);for(const [id,p,h,d]of [['a09:p2:trooper',2,2,1],['a09:p2:wampa',3,4,1],['a09:p2:leader',4,7,2]])assert.deepEqual([get(r,id).p,get(r,id).h,get(r,id).d],[p,h,d]);assert.equal(get(r,'a09:p2:leader').x,1);assert.equal(r.q.leader.dep,1);assert.equal(r.q.leader.epic,1);assert.ok(r.q.discard.some(c=>c.id==='a09:p2:tie'));assert.ok(!r.q.discard.some(c=>c.id==='a09:burst:droid'));assert.equal(get(r,'a09:burst:droid'),undefined);assert.deepEqual(r.p.ground,r.before.players.p1.ground);assert.deepEqual(r.p.space,r.before.players.p1.space);
 const stolen=staged('disruptive-burst',s=>s.players.p2.space[0].owner='p1');assert.ok(stolen.p.discard.some(c=>c.id==='a09:p2:tie'));assert.ok(!stolen.q.discard.some(c=>c.id==='a09:p2:tie'));
 const empty=staged('disruptive-burst',s=>{s.players.p2.ground=[];s.players.p2.space=[];s.players.p2.leader.dep=0;});assert.equal(empty.cue.outcomes.length,0);
});

test('Death uses printed cost at most three and preserves two independent creations for no target or explicit prevention',()=>{
 const r=staged('death-by-droids');assert.equal(r.cue.outcomes[0].printedCost,3);assert.ok(r.q.discard.some(c=>c.id==='a09:p2:trooper'));assert.equal(r.cue.outcomes.filter(o=>o.kind==='create').length,2);
 const none=staged('death-by-droids',s=>{s.players.p1.ground=[];s.players.p1.space=[];s.players.p2.ground=[s.players.p2.ground[1]];s.players.p2.space=[];});assert.equal(none.cue.outcomes.length,2);assert.ok(get(none,'a09:p2:wampa'));
 const prevented=staged('death-by-droids',null,{preventDefeat:true});assert.ok(get(prevented,'a09:p2:trooper'));assert.equal(prevented.q.discard.length,0);assert.equal(prevented.cue.outcomes.filter(o=>o.kind==='create').length,2);
 const own=staged('death-by-droids',null,{targetId:'a09:p1:xwing'});assert.ok(own.p.discard.some(c=>c.id==='a09:p1:xwing'));assert.throws(()=>staged('death-by-droids',null,{targetId:'a09:p2:wampa'}),/printed unit cost/);
});

test('Exploit sacrifices occur before the single event payment, then every opponent entry has its exact owner/leader/token destination',()=>{
 const r=staged('the-invasion-of-christophsis');assert.deepEqual(r.cue.outcomes.slice(0,4).map(o=>[o.kind,o.paymentRole,o.card.id]),[['defeat','exploit','a09:p1:marine'],['defeat','exploit','a09:p1:defender'],['defeat','exploit','a09:p1:xwing'],['defeat','exploit','a09:invasion:own-droid']]);assert.equal(r.cue.outcomes[4].kind,'cost');assert.equal(r.cue.outcomes[4].amount,-8);assert.equal(r.p.res.ready,9);assert.deepEqual(units(r.p).map(c=>c.id),['a09:invasion:survivor']);assert.equal(units(r.q).length,0);assert.deepEqual([r.q.leader.dep,r.q.leader.x,r.q.leader.epic],[0,1,1]);assert.ok(r.p.discard.some(c=>c.id==='a09:invasion:academy'));assert.ok(!r.q.discard.some(c=>c.id==='a09:invasion:academy'));assert.ok(!physical(r.after).some(c=>c.id==='a09:invasion:own-droid'||c.id==='a09:invasion:enemy-droid'));
 const fewer=staged('the-invasion-of-christophsis',null,{exploitIds:['a09:p1:marine']});assert.equal(fewer.p.res.ready,3);assert.ok(get(fewer,'a09:p1:defender'));assert.ok(get(fewer,'a09:p1:xwing'));
 const zero=staged('the-invasion-of-christophsis',null,{exploitIds:[]});assert.equal(zero.p.res.ready,1);assert.equal(zero.cue.outcomes[0].kind,'cost');assert.equal(zero.cue.outcomes[0].amount,0);
});

test('Exploit rejects missing/foreign/repeated/stale/prevented/premature or duplicated cost facts without mutating inputs',()=>{
 for(const choices of [{exploitIds:['a09:p2:wampa']},{exploitIds:['a09:p1:marine','a09:p1:marine']},{exploitIds:['a09:p1:marine','a09:p1:defender','a09:p1:xwing','a09:invasion:own-droid','a09:invasion:survivor']}])assert.throws(()=>staged('the-invasion-of-christophsis',null,choices),/Exploit/);
 for(const mutate of [c=>c.outcomes[0].prevented=true,c=>c.outcomes[0].incarnation='old',c=>c.outcomes[0].seat='p2',c=>c.outcomes[0].sourceCard={...c.source,id:'other'},c=>c.outcomes.splice(0,1),c=>c.outcomes.unshift(c.outcomes.splice(4,1)[0]),c=>c.outcomes.push(clone(c.outcomes[0])),c=>c.playPayment.exploit.units[0].incarnation='old',c=>c.playPayment.exploit.sourceId='a09:p2:hand:repair'])assert.throws(()=>staged('the-invasion-of-christophsis',null,null,mutate),/Exploit|prefix|cost receipts/);
 assert.throws(()=>staged('the-invasion-of-christophsis',s=>{s.players.p1.resources.forEach((r,i)=>{if(i>=6)r.x=1;});s.players.p1.res.ready=6;}),/unaffordable/);
 const d=def('the-invasion-of-christophsis'),s=a09ShowcaseState(d),p=a09PreviewPayment(d,s,'p1');p.exploit.sourceId=s.players.p1.hand[0].id+'other';assert.throws(()=>previewPlayCost(d,s,'p1',p),/actual source/);
});

test('Reprocess exact selected discard subset reaches random bottom while three fresh identities equal chosen count',()=>{
 const r=staged('reprocess');assert.equal(r.p.deck,30);assert.deepEqual(r.p.knownDeck.slice(0,27),r.before.players.p1.knownDeck);assert.deepEqual(ids(r.p.knownDeck.slice(-3)),['a09:reprocess:dead:2','a09:reprocess:dead:0','a09:reprocess:dead:1']);assert.deepEqual(ids(r.p.discard),['a09:reprocess:repair',r.cue.source.id]);assert.equal(r.cue.outcomes.filter(o=>o.kind==='create').length,3);for(const o of r.cue.outcomes){assert.equal(o.chosenUnitGroup,'a09:reprocess:chosen');assert.equal(o.cards.length,3);assert.ok(o.cards.every(c=>c.incarnation===undefined));}assert.equal(new Set(ids(r.p.ground)).size,r.p.ground.length);
 const no=staged('reprocess',null,{selectedIds:[]});assert.equal(no.p.deck,27);assert.equal(no.cue.outcomes.length,0);
 const prevented=staged('reprocess',null,{preventRecoverIds:['a09:reprocess:dead:1']});assert.equal(prevented.p.deck,29);assert.ok(prevented.p.discard.some(c=>c.id==='a09:reprocess:dead:1'));assert.equal(prevented.cue.outcomes.filter(o=>o.kind==='create').length,3);
});

test('Reprocess rejects non-unit/other-discard/repeated selections, false bottom permutations and changed chosen-count witnesses',()=>{
 for(const choices of [{selectedIds:['a09:reprocess:repair']},{selectedIds:['a09:p2:trooper']},{selectedIds:['a09:reprocess:dead:0','a09:reprocess:dead:0']},{bottomOrder:['a09:reprocess:dead:0','a09:reprocess:dead:1','a09:reprocess:dead:1']}])assert.throws(()=>staged('reprocess',null,choices),/Reprocess|random bottom/);
 assert.throws(()=>staged('reprocess',null,null,c=>c.outcomes.pop()),/chosen group/);assert.throws(()=>staged('reprocess',null,null,c=>c.outcomes[3].cards=[]),/changed after selection/);assert.throws(()=>staged('reprocess',null,null,c=>c.outcomes[1].card=c.outcomes[0].card),/exact selected/);
});

test('Consolidation seals modified power seven, plays cost four free before sacrificing original units and routes attachment to its different owner',()=>{
 const r=staged('consolidation-of-power');assert.deepEqual(r.cue.outcomes.map(o=>o.kind),['pay','play','defeat','defeat']);assert.deepEqual(r.cue.outcomes[0].chosenUnits.map(u=>u.power),[5,2]);assert.equal(r.cue.outcomes[0].amount,0);assert.equal(r.cue.outcomes[1].printedCost,4);const w=get(r,'a09:consolidation:played');assert.deepEqual([w.p,w.h,w.d,w.x,w.owner],[4,5,0,1,'p1']);assert.equal(r.p.hand.length,0);assert.ok(r.p.discard.some(c=>c.id==='a09:p1:marine'));assert.ok(r.p.discard.some(c=>c.id==='a09:p1:xwing'));assert.ok(r.q.discard.some(c=>c.id==='a09:consolidation:academy'));assert.equal(get(r,'a09:p1:defender').sn,1);assert.equal(r.p.res.ready,8);
 const declined=staged('consolidation-of-power',null,{playId:null});assert.deepEqual(declined.cue.outcomes.map(o=>o.kind),['defeat','defeat']);assert.ok(declined.p.hand.some(c=>c.id==='a09:consolidation:played'));assert.ok(!get(declined,'a09:p1:marine'));assert.ok(!get(declined,'a09:p1:xwing'));
 const empty=staged('consolidation-of-power',null,{selectedIds:[],playId:null});assert.equal(empty.cue.outcomes.length,0);assert.equal(units(empty.p).length,3);
});

test('Consolidation rejects cost above actual selected power, changed selection, extra unit payment and missing then-sacrifice',()=>{
 assert.throws(()=>staged('consolidation-of-power',null,{selectedIds:['a09:p1:xwing']}),/exceeds chosen actual power/);
 for(const mutate of [c=>c.outcomes[0].chosenUnits[0].power=3,c=>c.outcomes[1].chosenUnits=[...c.outcomes[1].chosenUnits].reverse(),c=>c.outcomes[0].amount=1,c=>c.outcomes[1].printedCost=8,c=>c.outcomes.splice(0,1),c=>c.outcomes.pop(),c=>c.outcomes[3].card=c.outcomes[2].card,c=>c.outcomes[1].unit.d=1])assert.throws(()=>staged('consolidation-of-power',null,null,mutate),/chosen power|changed after|zero|free play|then sacrifice|chosen group/);
});

test('New source APIs reject ambiguous/missing event and leave unsupported catalogue identities untouched',()=>{
 const d=def('hello-there'),s=a09ShowcaseState(d);assert.equal(a09PreviewSource(d,s,'p1').id,'a09:hello-there:event');s.players.p1.hand=[];assert.throws(()=>a09PreviewSource(d,s,'p1'),/event missing/);const t=a09ShowcaseState(d);t.players.p1.hand.push(clone(t.players.p1.hand[0]));assert.throws(()=>a09PreviewSource(d,t,'p1'),/ambiguous/);const unknown={...d,id:'unknown'};assert.equal(a09ShowcaseState(unknown),undefined);assert.equal(a09PreviewSource(unknown,t,'p1'),undefined);assert.equal(a09PreviewPayment(unknown,t,'p1'),undefined);assert.equal(a09PreviewOutcomes(unknown,t,'p1'),undefined);
});

test('Exploit supports differently owned controlled cost units and its own deployed leader destination without increasing the cost limit',()=>{
 const stolen=staged('the-invasion-of-christophsis',s=>s.players.p1.ground[0].owner='p2');assert.ok(stolen.q.discard.some(c=>c.id==='a09:p1:marine'));assert.ok(!stolen.p.discard.some(c=>c.id==='a09:p1:marine'));assert.equal(stolen.p.res.ready,9);
 const leader=staged('the-invasion-of-christophsis',s=>{const p=s.players.p1;p.leader.dep=1;p.leader.epic=1;p.ground.push({...p.leader,p:6,h:7,d:0,x:1,incarnation:'a09:p1:leader:entry-1'});},{exploitIds:['a09:p1:leader','a09:p1:marine','a09:p1:xwing','a09:invasion:own-droid']});assert.deepEqual([leader.p.leader.dep,leader.p.leader.x,leader.p.leader.epic],[0,1,1]);assert.ok(!leader.p.discard.some(c=>c.id==='a09:p1:leader'));assert.ok(get(leader,'a09:p1:defender'));assert.equal(leader.p.res.ready,9);
 assert.throws(()=>staged('the-invasion-of-christophsis',null,null,c=>c.outcomes[4].amount=-6),/discount receipt/);
});

test('Reprocess maximum four uses minimal real discard refs and does not require fabricated prior arena entry history',()=>{
 const r=staged('reprocess',s=>s.players.p1.discard.push({id:'a09:reprocess:fourth',n:'TIE/ln Fighter',s:'SOR_225',owner:'p1'}),{selectedIds:['a09:reprocess:dead:0','a09:reprocess:dead:1','a09:reprocess:dead:2','a09:reprocess:fourth'],bottomOrder:['a09:reprocess:fourth','a09:reprocess:dead:2','a09:reprocess:dead:0','a09:reprocess:dead:1']});assert.equal(r.p.deck,31);assert.equal(r.cue.outcomes.filter(o=>o.kind==='create').length,4);assert.ok(r.cue.outcomes.every(o=>o.cards.every(c=>!('incarnation'in c))));assert.equal(r.before.defeatedThisPhase,undefined);assert.equal(r.before.enteredThisPhase,undefined);
});

test('Created tokens cease on a later separately declared defeat and never travel to owner discard',()=>{
 const r=staged('death-by-droids'),before=r.after,u=before.players.p1.ground.find(c=>c.id==='a09:death:droid:0');const after=resolvePreviewState(before,{definition:r.d,source:null,seat:'p2',target:u,key:'a09:later-token-removal',outcomes:[{kind:'defeat',card:u,seat:'p1',zone:'ground',ownerSeat:'p1',incarnation:u.incarnation}]});assert.ok(!units(after.players.p1).some(c=>c.id===u.id));assert.ok(!after.players.p1.discard.some(c=>c.id===u.id));assert.ok(units(after.players.p1).some(c=>c.id==='a09:death:droid:1'));assert.equal(after.players.p1.res.ready,r.p.res.ready);
});

test('Narrow history/defense/creation metadata cannot masquerade as unrelated payment or defeat receipts',()=>{
 assert.throws(()=>staged('hello-there',null,null,c=>c.outcomes[0].kind='defeat'),/concrete receipt meaning/);
 assert.throws(()=>staged('i-have-the-high-ground',null,null,c=>c.outcomes[0].kind='pay'),/concrete receipt meaning/);
 assert.throws(()=>staged('death-by-droids',null,null,c=>c.outcomes[1].kind='play'),/concrete receipt meaning/);
 assert.throws(()=>staged('equalize',null,null,c=>c.outcomes[1].kind='damage'),/concrete receipt meaning/);
});
