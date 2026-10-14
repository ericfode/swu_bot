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
const {A11_DEFINITIONS,A11_COSTS,A11_ABILITIES,a11ShowcaseState,a11PreviewSource,a11PreviewOutcomes,a11PreviewPayment}=loadTS(path.join(__dirname,'../src/effects/batchA11.ts'));
const {resolvePreviewState}=loadTS(path.join(__dirname,'../src/effects/previewState.ts'));
const {previewPlayCost,previewExtraPayment}=loadTS(path.join(__dirname,'../src/effects/previewCosts.ts'));
const clone=structuredClone,def=id=>A11_DEFINITIONS.find(d=>d.id===id),units=p=>[...p.ground,...p.space],ids=a=>a.map(c=>c.id),get=(r,id)=>units(r.p).concat(units(r.q)).find(u=>u.id===id);
function staged(id,change,choices,changeCue){const d=def(id),before=a11ShowcaseState(d);if(change)change(before);const cue={definition:d,seat:'p1',source:a11PreviewSource(d,before,'p1'),target:null,key:'a11:focused',playPayment:a11PreviewPayment(d,before,'p1'),outcomes:a11PreviewOutcomes(d,before,'p1',choices??{})};if(changeCue)changeCue(cue,before);const old=clone(before),oldCue=clone(cue),after=resolvePreviewState(before,cue);assert.deepEqual(before,old);assert.deepEqual(cue,oldCue);assert.deepEqual(resolvePreviewState(before,cue),after);assert.deepEqual(resolvePreviewState(before,{...cue,key:'a11:newnonce'}),after);return{d,before,cue,after,p:after.players.p1,q:after.players.p2};}
const cardDir=path.join(__dirname,'../../forceteki/test/json/Card'),cards=fs.readdirSync(cardDir).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(cardDir,f))));
const byPrint=new Map(cards.flatMap(c=>(c.setCodes??[]).map(p=>[`${p.set}_${String(p.number).padStart(3,'0')}`,c]))),reverse=JSON.parse(fs.readFileSync(path.join(cardDir,'../_setCodeMap.json')));
const physical=s=>Object.values(s.players).flatMap(p=>[p.base,...(p.leader?.dep===0?[p.leader]:[]),...p.hand,...p.discard,...(p.resources??[]),...(p.knownDeck??[]),...p.ground,...p.space,...units(p).flatMap(c=>[...(c.u??[]),...(c.cap??[])])]);
test('All ten A11 primary snapshots resolve into actual ending boards without input mutation or nonce identity changes',()=>{for(const d of A11_DEFINITIONS)staged(d.id);});

test('Installed JSON verifies exact ten canonical identities, Daring aliases, complete costs and every real unit face/trait',()=>{
 const canonical=['6476609909','8060312086','8022262805','0056489820','7826408293','4042866439','6669050232','2103133661','1417180295','5013139687'];
 for(const [i,d] of A11_DEFINITIONS.entries()){const c=byPrint.get(d.setCode);assert.equal(c.id,canonical[i]);assert.equal(c.title,d.name);assert.equal(c.unique,false);assert.deepEqual(A11_COSTS[d.id],{printed:c.cost,aspects:c.aspects});assert.equal(d.visual,d.id);assert.deepEqual(Object.keys(reverse).filter(p=>reverse[p]===c.id).sort(),c.setCodes.map(p=>`${p.set}_${String(p.number).padStart(3,'0')}`).sort());
  const s=a11ShowcaseState(d);for(const side of ['p1','p2'])for(const u of units(s.players[side])){const c=u.t?cards.find(c=>c.title==='Clone Trooper'&&!c.setCodes):byPrint.get(u.s);assert.equal(u.n,c.title+(c.subtitle?`: ${c.subtitle}`:''));assert.deepEqual([u.p,u.h],[c.power,c.hp]);assert.deepEqual(u.traits,c.traits);assert.equal(c.arena,s.players[side].ground.includes(u)?'ground':'space');assert.ok(u.id&&u.incarnation);assert.equal(u.owner,side);assert.ok(u.d<u.h);}}
 assert.equal(byPrint.get('TWI_170').id,byPrint.get('SHD_178').id);assert.equal(def('selfdestruct').name,'Self-Destruct');assert.equal(def('self-destruct'),undefined);assert.match(byPrint.get('TWI_173').text,/each ground unit/);assert.match(byPrint.get('TWI_176').text,/2 enemy units in the same arena/);assert.match(byPrint.get('TWI_172').text,/non-leader/);
});

test('All event aspect multisets, payment manifests, owner destinations, deck counts and token cessation conserve known state',()=>{
 const costs=[5,6,5,10,3,4,4,5,7,8],ending=[11,10,11,6,13,12,12,11,9,8];for(const [i,d] of A11_DEFINITIONS.entries()){const r=staged(d.id);assert.equal(previewPlayCost(d,r.before,'p1',r.cue.playPayment),costs[i]);assert.equal(previewExtraPayment(d),0);assert.equal(r.p.res.ready,ending[i]);assert.equal(r.p.res.total,16);assert.equal(r.q.res.ready,7);assert.equal(r.p.resources.length,16);assert.equal(r.q.resources.length,10);assert.equal(r.p.resources.filter(c=>!c.x).length,ending[i]);assert.deepEqual(r.q.resources,r.before.players.p2.resources);assert.equal(r.p.discard.filter(c=>c.id===r.cue.source.id).length,1);assert.ok(!r.p.hand.some(c=>c.id===r.cue.source.id));const before=physical(r.before),after=physical(r.after);assert.deepEqual(ids(after).sort(),ids(before).filter(id=>id!=='a11:blood:clone').sort());assert.equal(new Set(ids(after)).size,after.length);for(const c of after)assert.equal(c.owner,before.find(x=>x.id===c.id).owner);for(const p of Object.values(r.after.players))assert.equal(p.knownDeck.length,p.deck);assert.equal(r.p.deck,d.id==='strategic-analysis'?24:27);assert.equal(r.q.deck,29);}
 const r=staged('unlimited-power');assert.deepEqual(r.cue.playPayment.cardIds,Array.from({length:10},(_,i)=>`a11:p1:resource:${i}`));assert.deepEqual(A11_COSTS['unlimited-power'].aspects,['aggression','aggression']);
});

test('Corner seals defender wounds, applies actual six/four combat and restores only the transient power',()=>{
 const r=staged('corner-the-prey'),a=get(r,'a11:corner:attacker');assert.deepEqual([a.p,a.h,a.d,a.x],[4,5,4,1]);assert.equal(a.status,undefined);assert.equal(get(r,'a11:p2:wampa'),undefined);assert.ok(r.q.discard.some(c=>c.id==='a11:p2:wampa'));assert.deepEqual(r.cue.outcomes[0].defenderDamageAtStart,{defenderId:'a11:p2:wampa',incarnation:'a11:p2:wampa:entry-1',zone:'ground',damage:2});assert.deepEqual(r.cue.outcomes.filter(o=>o.kind==='damage').map(o=>[o.amount,o.sourceCard.id,o.damageType]),[[6,'a11:corner:attacker','combat'],[4,'a11:p2:wampa','combat']]);assert.equal(r.q.base.d,6);assert.equal(r.p.base.d,9);
 const base=staged('corner-the-prey',null,{targetId:'a11:p2:base'});assert.equal(base.cue.outcomes[0].amount,'+0/+0');assert.equal(base.cue.outcomes[0].defenderDamageAtStart.damage,0);assert.equal(base.cue.outcomes[0].defenderDamageAtStart.incarnation,undefined);assert.equal(base.q.base.d,10);assert.equal(get(base,'a11:corner:attacker').p,4);assert.equal(get(base,'a11:corner:attacker').d,0);
});

test('Corner rejects invented start wounds, target substitution, late grant, illegal Sentinel and old entry or false cause',()=>{
 for(const mutate of [c=>c.outcomes[0].defenderDamageAtStart.damage=3,c=>c.outcomes[0].defenderDamageAtStart.incarnation='old',c=>c.outcomes[0].defenderDamageAtStart.defenderId='a11:p2:trooper',c=>c.outcomes[0].sourceCard={...c.source,id:'wrong'},c=>c.outcomes[0].amount='+3/+0',c=>c.outcomes[1].card=c.outcomes[0].card,c=>c.outcomes[3].amount=7,c=>{const b=c.outcomes.shift();c.outcomes.splice(1,0,b);},c=>c.outcomes=c.outcomes.slice(0,1)])assert.throws(()=>staged('corner-the-prey',null,null,mutate),/defender start|attack target|ready attacker|attack-scoped|actual attack/);
 assert.throws(()=>staged('corner-the-prey',s=>s.players.p2.ground[0].sn=1),/Sentinel/);assert.throws(()=>staged('corner-the-prey',null,{targetId:'a11:p2:tie'}),/enemy arena/);assert.throws(()=>staged('corner-the-prey',s=>s.players.p1.ground[0].x=1,{attackerId:'a11:corner:attacker'}),/ready friendly/);const none=staged('corner-the-prey',s=>units(s.players.p1).forEach(u=>u.x=1));assert.equal(none.cue.outcomes.length,0);assert.equal(none.p.res.ready,11);
 assert.throws(()=>staged('corner-the-prey',null,{targetId:'a11:p2:base'},c=>c.outcomes[0].defenderDamageAtStart.damage=6),/base zero/);
});

test('Self-Destruct pays before its successful friendly effect sacrifice and permits own or cross-arena target damage',()=>{
 const r=staged('selfdestruct');assert.deepEqual(r.cue.outcomes.map(o=>o.kind),['defeat','damage','defeat']);assert.equal(r.cue.outcomes[0].paymentRole,undefined);assert.deepEqual(r.cue.outcomes[1].requiresDefeat,{id:'a11:p1:marine',incarnation:'a11:p1:marine:entry-1'});assert.ok(r.p.discard.some(c=>c.id==='a11:p1:marine'));assert.ok(r.q.discard.some(c=>c.id==='a11:p2:wampa'));assert.equal(r.cue.playPayment.exploit,undefined);
 const own=staged('selfdestruct',null,{targetId:'a11:p1:xwing'});assert.ok(own.p.discard.some(c=>c.id==='a11:p1:xwing'));assert.equal(own.q.discard.length,0);assert.equal(own.p.base.d,9);assert.ok(!own.cue.outcomes.some(o=>o.kind==='attack'||o.kind==='exhaust'));
 for(const mutate of [c=>c.outcomes[0].prevented=true,c=>c.outcomes.shift(),c=>c.outcomes[1].requiresDefeat.incarnation='old',c=>c.outcomes[0].incarnation='old',c=>c.outcomes[0].kind='return'])assert.throws(()=>staged('selfdestruct',null,null,mutate),/successful|incarnation/);
 assert.throws(()=>staged('selfdestruct',null,{sacrificeId:'a11:p2:trooper'}),/friendly sacrifice/);assert.throws(()=>staged('selfdestruct',null,{targetId:'a11:p1:marine'}),/distinct remaining/);assert.throws(()=>staged('selfdestruct',null,{targetId:'a11:p2:base'}),/arena unit/);
});

const realUnit=(code,id,side,d=0,extra={})=>{const c=byPrint.get(code);return{id,n:c.title+(c.subtitle?`: ${c.subtitle}`:''),s:code,owner:side,p:c.power,h:c.hp,d,traits:clone(c.traits),incarnation:`${id}:entry-1`,...extra};};
test('Self actual leader returns to exhausted undeployed area with spent epic, while an explicitly defeated token ceases',()=>{
 const leader=staged('selfdestruct',s=>{const p=s.players.p1;p.leader={...p.leader,dep:1,x:0,epic:1};p.ground[0]=realUnit('SOR_005',p.leader.id,'p1');},{sacrificeId:'a11:p1:leader'});assert.deepEqual([leader.p.leader.dep,leader.p.leader.x,leader.p.leader.epic],[0,1,1]);assert.ok(!leader.p.discard.some(c=>c.id==='a11:p1:leader'));assert.ok(leader.q.discard.some(c=>c.id==='a11:p2:wampa'));
 const token=staged('selfdestruct',s=>s.players.p1.ground[0]={id:'a11:self:token',n:'Clone Trooper',s:null,owner:'p1',t:1,p:2,h:2,d:0,x:1,traits:['republic','clone','trooper'],incarnation:'a11:self:token:entry-1'},{sacrificeId:'a11:self:token'});assert.ok(!physical(token.after).some(c=>c.id==='a11:self:token'));assert.ok(token.q.discard.some(c=>c.id==='a11:p2:wampa'));
 const stolen=staged('selfdestruct',s=>s.players.p1.ground[0].owner='p2');assert.ok(stolen.q.discard.some(c=>c.id==='a11:p1:marine'));assert.ok(!stolen.p.discard.some(c=>c.id==='a11:p1:marine'));
});

test('Bold expands only power on three current entries sharing Trooper across both controllers',()=>{
 const r=staged('bold-resistance');for(const id of ['a11:p1:marine','a11:p1:defender','a11:p2:trooper']){const old=units(r.before.players.p1).concat(units(r.before.players.p2)).find(u=>u.id===id),end=get(r,id);assert.deepEqual([end.p,end.h,end.d,end.x,end.sn],[old.p+2,old.h,old.d,old.x,old.sn]);assert.equal(end.status[0].duration,'phase');assert.equal(end.u,undefined);}assert.equal(r.cue.outcomes[0].sharedTrait.trait,'trooper');assert.deepEqual(get(r,'a11:p1:xwing'),r.before.players.p1.space[0]);assert.deepEqual(get(r,'a11:p2:wampa'),r.before.players.p2.ground[1]);
 for(const unitIds of [[],['a11:p1:xwing'],['a11:p1:xwing','a11:p2:tie']]){const x=staged('bold-resistance',null,{unitIds});assert.equal(x.cue.outcomes.length,unitIds.length);}
 assert.throws(()=>staged('bold-resistance',null,{unitIds:['a11:p1:marine','a11:p1:defender','a11:p2:trooper','a11:p1:xwing']}),/zero to three/);assert.throws(()=>staged('bold-resistance',null,{unitIds:['a11:p1:marine','a11:p1:marine']}),/distinct/);assert.throws(()=>staged('bold-resistance',null,{unitIds:['a11:p1:marine','a11:p2:wampa']}),/entire selected group/);assert.throws(()=>staged('bold-resistance',s=>delete s.players.p1.ground[0].traits),/known/);
});

test('Bold requires whole-set intersection rather than pairwise trait sharing and seals the selected group',()=>{
 assert.throws(()=>staged('bold-resistance',s=>{s.players.p1.ground[0].traits=['a','b'];s.players.p1.ground[1].traits=['b','c'];s.players.p2.ground[0].traits=['a','c'];}),/entire selected group/);
 for(const mutate of [c=>c.outcomes[0].sharedTrait.trait='rebel',c=>c.outcomes[1].sharedTrait=clone({...c.outcomes[1].sharedTrait,trait:'rebel'}),c=>c.outcomes[0].sharedTrait.units[0].incarnation='old',c=>c.outcomes[0].amount='+2/+2',c=>c.outcomes[0].sourceCard={...c.source,id:'other'},c=>c.outcomes.pop(),c=>c.outcomes.push(clone(c.outcomes[0])),c=>c.outcomes[0].kind='draw'])assert.throws(()=>staged('bold-resistance',null,null,mutate),/shared trait|shared-trait|current trait|concrete receipt/);
});

test('Unlimited emits all four distinct 4/3/2/1 hits before two real owner departures, preserving survivors and poses',()=>{
 const r=staged('unlimited-power');assert.deepEqual(r.cue.outcomes.map(o=>o.kind),['damage','damage','damage','damage','defeat','defeat']);assert.deepEqual(r.cue.outcomes.slice(0,4).map(o=>o.amount),[4,3,2,1]);assert.equal(new Set(r.cue.outcomes.slice(0,4).map(o=>o.card.id)).size,4);assert.equal(get(r,'a11:p2:wampa').d,4);assert.equal(get(r,'a11:p1:xwing').d,2);assert.equal(get(r,'a11:p2:wampa').x,undefined);assert.ok(r.p.discard.some(c=>c.id==='a11:p1:marine'));assert.ok(r.q.discard.some(c=>c.id==='a11:p2:tie'));assert.deepEqual(get(r,'a11:p1:defender'),r.before.players.p1.ground[1]);assert.deepEqual(get(r,'a11:p2:trooper'),r.before.players.p2.ground[0]);assert.equal(r.q.base.d,6);
 for(const unitIds of [['a11:p1:marine'],['a11:p1:marine','a11:p1:marine','a11:p1:xwing','a11:p2:tie'],['a11:p1:marine','a11:p2:wampa','a11:p1:xwing','a11:p2:base']])assert.throws(()=>staged('unlimited-power',null,{unitIds}),/four distinct|arena unit/);
 assert.throws(()=>staged('unlimited-power',null,null,c=>{const death=c.outcomes.splice(4,1)[0];c.outcomes.splice(1,0,death);}),/window must finish/);
});

test('Daring Raid independently targets either base or a real own/enemy unit without combat or hidden extra effects',()=>{
 const own=staged('daring-raid');assert.equal(own.p.base.d,11);assert.equal(own.q.base.d,6);assert.deepEqual(own.p.ground,own.before.players.p1.ground);assert.deepEqual(own.q.ground,own.before.players.p2.ground);assert.deepEqual(own.cue.outcomes.map(o=>[o.kind,o.amount,o.damageType]),[['damage',2,'ability']]);
 const enemy=staged('daring-raid',null,{targetId:'a11:p2:base'});assert.equal(enemy.q.base.d,8);const ownUnit=staged('daring-raid',null,{targetId:'a11:p1:marine'});assert.ok(ownUnit.p.discard.some(c=>c.id==='a11:p1:marine'));const enemyUnit=staged('daring-raid',null,{targetId:'a11:p2:tie'});assert.ok(enemyUnit.q.discard.some(c=>c.id==='a11:p2:tie'));assert.ok(!enemyUnit.cue.outcomes.some(o=>o.attackId||o.kind==='exhaust'));
});

test('Grenade optional different same-arena second remains eligible when the first hit is lethal',()=>{
 const r=staged('grenade-strike');assert.deepEqual(r.cue.outcomes.map(o=>[o.kind,o.amount,o.card.id]),[['damage',2,'a11:p2:trooper'],['damage',1,'a11:p1:defender'],['defeat',undefined,'a11:p2:trooper']]);assert.equal(get(r,'a11:p1:defender').d,1);assert.equal(get(r,'a11:p1:defender').sn,1);assert.ok(r.q.discard.some(c=>c.id==='a11:p2:trooper'));
 const decline=staged('grenade-strike',null,{secondId:null});assert.equal(decline.cue.outcomes.filter(o=>o.kind==='damage').length,1);assert.equal(get(decline,'a11:p1:defender').d,0);
 assert.throws(()=>staged('grenade-strike',null,{secondId:'a11:p2:trooper'}),/distinct unit/);assert.throws(()=>staged('grenade-strike',null,{secondId:'a11:p2:tie'}),/first arena/);assert.throws(()=>staged('grenade-strike',null,{targetId:'a11:p2:base'}),/arena unit/);assert.throws(()=>staged('grenade-strike',null,null,c=>{const death=c.outcomes.pop();c.outcomes.splice(1,0,death);}),/window must finish/);
});

test('Grim Grit adds own current wounds once during a real attack and expires without changing resting power or wounds',()=>{
 const r=staged('grim-resolve'),a=get(r,'a11:p1:marine');assert.deepEqual([a.p,a.h,a.d,a.x],[3,3,2,1]);assert.equal(a.status,undefined);assert.equal(r.q.base.d,11);assert.equal(r.p.base.d,9);assert.equal(r.cue.outcomes[0].keyword.name,'Grit');assert.equal(r.cue.outcomes[0].duration,'attack');assert.equal(r.cue.outcomes[1].amount,'+2/+0');assert.equal(r.cue.outcomes[4].amount,5);const zero=staged('grim-resolve',s=>s.players.p1.ground[0].d=0);assert.equal(zero.cue.outcomes[1].amount,'+0/+0');assert.equal(zero.q.base.d,9);
});

test('Native Grit already counted in real Scout Bike power does not stack with one or multiple additional Grit instances',()=>{
 const f=byPrint.get('SOR_032');assert.match(f.text,/Grit/);assert.deepEqual([f.power,f.hp],[1,4]);const change=s=>{s.players.p1.ground[0]=realUnit('SOR_032','a11:grim:native','p1',2,{p:3,status:[{kind:'keyword',label:'Grit (printed)',duration:'permanent',keyword:{name:'Grit',amount:1}}]});};
 const r=staged('grim-resolve',change);assert.equal(r.cue.outcomes[0].gritBasis.powerIncludesGrit,true);assert.equal(r.cue.outcomes[1].amount,'+0/+0');assert.equal(r.cue.outcomes[4].amount,3);assert.equal(r.q.base.d,9);assert.deepEqual([get(r,'a11:grim:native').p,get(r,'a11:grim:native').d],[3,2]);assert.equal(get(r,'a11:grim:native').status.length,1);
 const twice=staged('grim-resolve',s=>{change(s);s.players.p1.ground[0].status.push(clone(s.players.p1.ground[0].status[0]));});assert.equal(twice.cue.outcomes[4].amount,3);assert.equal(get(twice,'a11:grim:native').status.length,2);
});

test('Grim rejects leader/exhausted actor, invented wounds/cause, false native stacking and unobserved pre-combat wound changes',()=>{
 for(const mutate of [c=>c.outcomes[0].gritBasis.damage=1,c=>c.outcomes[0].gritBasis.powerIncludesGrit=true,c=>c.outcomes[0].gritBasis.incarnation='old',c=>c.outcomes[0].sourceCard={...c.source,id:'other'},c=>c.outcomes[0].keyword.amount=2,c=>c.outcomes[0].duration='phase',c=>c.outcomes[1].amount='+4/+0',c=>c.outcomes[4].amount=7,c=>c.outcomes.splice(2),c=>c.outcomes.splice(1,1)])assert.throws(()=>staged('grim-resolve',null,null,mutate),/Grit|attack-scoped|actual attack/);
 assert.throws(()=>staged('grim-resolve',s=>s.players.p1.ground[0].x=1,{attackerId:'a11:p1:marine'}),/ready friendly/);assert.throws(()=>staged('grim-resolve',s=>{const p=s.players.p1;p.leader={...p.leader,dep:1,x:0};p.ground[0]=realUnit('SOR_005',p.leader.id,'p1');},{attackerId:'a11:p1:leader'}),/eligible unit/);
 const none=staged('grim-resolve',s=>units(s.players.p1).forEach(u=>u.x=1));assert.equal(none.cue.outcomes.length,0);assert.equal(none.p.res.ready,12);
 assert.throws(()=>staged('grim-resolve',null,null,(c,b)=>c.outcomes.splice(2,0,{kind:'heal',card:b.players.p1.ground[0],seat:'p1',zone:'ground',amount:1,sourceCard:c.source})),/current wound window/);
});

test('Blood hits exactly every ground entry on both sides before any cleanup and preserves both spaces/bases and deployed leader pose',()=>{
 const r=staged('blood-sport'),damage=r.cue.outcomes.filter(o=>o.kind==='damage'),ground=Object.values(r.before.players).flatMap(p=>p.ground);assert.deepEqual(ids(damage.map(o=>o.card)).sort(),ids(ground).sort());assert.equal(damage.length,6);assert.ok(r.cue.outcomes.slice(0,6).every(o=>o.kind==='damage'&&o.amount===2&&o.zone==='ground'&&o.damageType==='ability'));assert.equal(r.cue.outcomes.slice(6).length,3);assert.ok(!physical(r.after).some(c=>c.id==='a11:blood:clone'));assert.ok(r.p.discard.some(c=>c.id==='a11:p1:marine'));assert.ok(r.q.discard.some(c=>c.id==='a11:p2:trooper'));assert.deepEqual([get(r,'a11:p1:defender').d,get(r,'a11:p2:wampa').d,get(r,'a11:p2:leader').d],[2,3,4]);assert.deepEqual([r.q.leader.dep,r.q.leader.x,r.q.leader.epic],[1,1,1]);assert.equal(get(r,'a11:p2:leader').x,1);assert.deepEqual(r.p.space,r.before.players.p1.space);assert.deepEqual(r.q.space,r.before.players.p2.space);assert.equal(r.p.base.d,9);assert.equal(r.q.base.d,6);
 const empty=staged('blood-sport',s=>{s.players.p1.ground=[];s.players.p2.ground=[];s.players.p2.leader.dep=0;});assert.equal(empty.cue.outcomes.length,0);assert.equal(empty.p.res.ready,11);assert.throws(()=>staged('blood-sport',null,null,c=>{const death=c.outcomes.splice(6,1)[0];c.outcomes.splice(1,0,death);}),/window must finish/);
});

test('Strategic draws three actual top identities in order, without reveal/trait/play or fabricated short deck cards',()=>{
 const r=staged('strategic-analysis');assert.deepEqual(ids(r.p.hand),['a11:analysis:draw:0','a11:analysis:draw:1','a11:analysis:draw:2']);assert.deepEqual(r.p.hand.map(c=>c.s),['SOR_074','SOR_095','SOR_237']);assert.equal(r.p.deck,24);assert.deepEqual(r.p.knownDeck,r.before.players.p1.knownDeck.slice(3));assert.equal(r.cue.outcomes[0].fromZone,'deck');assert.equal(r.cue.outcomes[0].visibility,undefined);assert.equal(r.cue.outcomes[0].traitCondition,undefined);assert.deepEqual(r.p.ground,r.before.players.p1.ground);assert.deepEqual(r.q.ground,r.before.players.p2.ground);
 assert.throws(()=>staged('strategic-analysis',s=>{s.players.p1.knownDeck.length=2;s.players.p1.deck=2;}),/empty-deck consequences/);assert.throws(()=>staged('strategic-analysis',null,null,c=>c.outcomes[0].cards.reverse()),/known deck order/);assert.throws(()=>staged('strategic-analysis',null,null,c=>c.outcomes[0].cards[0]={id:'fake',n:'Repair',s:'SOR_074',owner:'p1'}),/known deck order/);
});

test('Crossfire seals both enemy powers and sources, deals ability hits simultaneously and grants the event player no attack or defeat history',()=>{
 const r=staged('caught-in-the-crossfire');assert.deepEqual(r.cue.outcomes.map(o=>[o.kind,o.amount,o.card.id,o.sourceCard.id]),[['damage',4,'a11:p2:trooper','a11:p2:wampa'],['damage',3,'a11:p2:wampa','a11:p2:trooper'],['defeat',undefined,'a11:p2:trooper','a11:p2:wampa']]);assert.equal(get(r,'a11:p2:wampa').d,4);assert.equal(get(r,'a11:p2:wampa').p,4);assert.equal(get(r,'a11:p2:wampa').x,undefined);assert.ok(r.q.discard.some(c=>c.id==='a11:p2:trooper'));assert.equal(r.after.defeatedThisPhase,undefined);assert.equal(r.after.attacksThisPhase,undefined);assert.ok(!r.cue.outcomes.some(o=>o.attackId||o.kind==='attack'||o.kind==='exhaust'||o.kind==='cost'));assert.equal(r.q.base.d,6);
 const both=staged('caught-in-the-crossfire',s=>s.players.p2.ground[1].d=2);assert.ok(both.q.discard.some(c=>c.id==='a11:p2:wampa'));assert.ok(both.q.discard.some(c=>c.id==='a11:p2:trooper'));assert.equal(both.cue.outcomes[1].amount,3);const stolen=staged('caught-in-the-crossfire',s=>s.players.p2.ground[0].owner='p1');assert.ok(stolen.p.discard.some(c=>c.id==='a11:p2:trooper'));assert.equal(stolen.cue.outcomes[0].powerWindow.members[1].controller,'p2');
});

test('Crossfire rejects missing reciprocation, false powers/controller/entry/source, sequential death and non-enemy/arena selection',()=>{
 for(const mutate of [c=>c.outcomes[0].powerWindow.members[0].power=5,c=>c.outcomes[0].powerWindow.members[0].controller='p1',c=>c.outcomes[0].powerWindow.members[0].incarnation='old',c=>c.outcomes[0].sourceCard=c.source,c=>c.outcomes[0].amount=3,c=>c.outcomes[0].damageType='combat',c=>c.outcomes[0].attackId='invented',c=>c.outcomes.splice(1,1),c=>{const death=c.outcomes.pop();c.outcomes.splice(1,0,death);},c=>c.outcomes[1].powerWindow=clone({...c.outcomes[1].powerWindow,id:'other'}),c=>c.outcomes[0].kind='attack'])assert.throws(()=>staged('caught-in-the-crossfire',null,null,mutate),/reciprocal|simultaneous|concrete receipt/);
 for(const unitIds of [['a11:p2:wampa'],['a11:p2:wampa','a11:p2:wampa'],['a11:p2:wampa','a11:p1:marine'],['a11:p2:wampa','a11:p2:tie']])assert.throws(()=>staged('caught-in-the-crossfire',null,{unitIds}),/two distinct|two enemy/);
});

test('Crossfire uses declared current modified/native-Grit power once, retaining source stats rather than recomputing after wounds',()=>{
 const r=staged('caught-in-the-crossfire',s=>{s.players.p2.ground[0]=realUnit('SOR_032','a11:crossfire:native','p2',1,{p:2,status:[{kind:'keyword',label:'Grit (printed)',duration:'permanent',keyword:{name:'Grit',amount:1}}]});s.players.p2.ground[1].p=6;s.players.p2.ground[1].status=[{kind:'buff',label:'+2/+0 phase',duration:'phase'}];},{unitIds:['a11:p2:wampa','a11:crossfire:native']});assert.equal(r.cue.outcomes[0].amount,6);assert.equal(r.cue.outcomes[1].amount,2);assert.equal(get(r,'a11:p2:wampa').p,6);assert.equal(get(r,'a11:p2:wampa').d,3);assert.ok(r.q.discard.some(c=>c.id==='a11:crossfire:native'));
});

test('Source APIs preserve exact source identities and unknown catalogue coverage; no hidden mode or alias guessing',()=>{
 const d=def('bold-resistance'),s=a11ShowcaseState(d);assert.equal(a11PreviewSource(d,s,'p1').id,'a11:bold-resistance:event');s.players.p1.hand=[];assert.throws(()=>a11PreviewSource(d,s,'p1'),/actual source event/);const unknown={...d,id:'unknown'};assert.equal(a11ShowcaseState(unknown),undefined);assert.equal(a11PreviewSource(unknown,s,'p1'),undefined);assert.equal(a11PreviewPayment(unknown,s,'p1'),undefined);assert.equal(a11PreviewOutcomes(unknown,s,'p1'),undefined);
});

test('Explicit current-entry and simultaneous-window evidence cannot silently route to a replacement, wrong arena or prevented witness',()=>{
 for(const id of ['unlimited-power','grenade-strike','blood-sport','caught-in-the-crossfire'])assert.throws(()=>staged(id,null,null,c=>c.outcomes[0].incarnation='old'),/current target incarnation|two fixed current entries/);
 for(const id of ['unlimited-power','grenade-strike','blood-sport'])assert.throws(()=>staged(id,null,null,c=>c.outcomes[0].zone='space'),/current target incarnation/);
 for(const id of ['corner-the-prey','grim-resolve','bold-resistance','caught-in-the-crossfire'])assert.throws(()=>staged(id,null,null,c=>c.outcomes[0].prevented=true),/unprevented|shared trait|power window/);
 for(const id of ['unlimited-power','grenade-strike','blood-sport'])assert.throws(()=>staged(id,null,null,c=>c.outcomes[0].amount=1.5),/simultaneous damage/);
 assert.throws(()=>staged('grim-resolve',null,null,c=>c.outcomes[0].card={id:'missing',n:'Battlefield Marine',s:'SOR_095',owner:'p1'}),/current arena/);
});

test('Known printed Grit cannot lose its native witness and be treated as an additional wound bonus',()=>{
 assert.throws(()=>staged('grim-resolve',s=>{s.players.p1.ground[0]=realUnit('SOR_032','a11:grim:native','p1',2,{p:3});}),/printed Grit needs known/);
 assert.throws(()=>staged('grim-resolve',s=>{s.players.p1.ground[0]=realUnit('SOR_032','a11:grim:native','p1',2,{p:3,status:[{kind:'keyword',label:'Grit',duration:'permanent',keyword:{name:'Grit',amount:1}}]});},null,c=>{c.outcomes[0].gritBasis.powerIncludesGrit=false;}),/Grit needs/);
});

test('Unsupported Shield absorption or surviving native-Grit wound changes require explicit actual receipts instead of a fabricated ending',()=>{
 for(const id of ['selfdestruct','unlimited-power','grenade-strike','blood-sport','caught-in-the-crossfire'])assert.throws(()=>staged(id,s=>{for(const u of units(s.players.p2))u.u=[{id:`${u.id}:shield`,n:'Shield',s:null,owner:'p2',t:1,p:0,h:0}];}),/Shield damage/);
 assert.throws(()=>staged('daring-raid',s=>s.players.p2.ground[1].u=[{id:'a11:shield',n:'Shield',s:null,owner:'p2',t:1,p:0,h:0}],{targetId:'a11:p2:wampa'}),/Shield damage/);
 assert.throws(()=>staged('caught-in-the-crossfire',s=>{s.players.p2.ground[0]=realUnit('SOR_032','a11:crossfire:native','p2',0,{status:[{kind:'keyword',label:'Grit',duration:'permanent',keyword:{name:'Grit',amount:1}}]});s.players.p2.ground[1].p=1;},{unitIds:['a11:p2:wampa','a11:crossfire:native']}),/resting-power change/);
});

test('Crossfire zero power remains an actual reciprocal receipt; no legal pair pays the event without a fabricated target',()=>{
 const zero=staged('caught-in-the-crossfire',s=>{s.players.p2.ground[0].p=0;s.players.p2.ground[0].status=[{kind:'debuff',label:'power 0 phase',duration:'phase'}];});assert.deepEqual(zero.cue.outcomes.slice(0,2).map(o=>o.amount),[4,0]);assert.equal(get(zero,'a11:p2:wampa').d,1);assert.ok(zero.q.discard.some(c=>c.id==='a11:p2:trooper'));
 const none=staged('caught-in-the-crossfire',s=>s.players.p2.ground.pop());assert.equal(none.cue.outcomes.length,0);assert.equal(none.p.res.ready,8);assert.equal(none.q.discard.length,0);assert.equal(none.q.base.d,6);assert.throws(()=>staged('caught-in-the-crossfire',null,{unitIds:[]}),/exactly two/);
});
