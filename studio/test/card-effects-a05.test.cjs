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
const { A05_DEFINITIONS, A05_COSTS, a05ShowcaseState, a05PreviewOutcomes, a05PreviewPayment } = loadTS(path.join(__dirname, '../src/effects/batchA05.ts'));
const { resolvePreviewState } = loadTS(path.join(__dirname, '../src/effects/previewState.ts'));
const { previewPlayCost, previewExtraPayment } = loadTS(path.join(__dirname, '../src/effects/previewCosts.ts'));
const { cardAbilities } = loadTS(path.join(__dirname, '../src/effects/abilities.ts'));
const { observedOutcomes } = loadTS(path.join(__dirname, '../src/effects/outcomes.ts'));
const clone = structuredClone;
const ids = cards => cards.map(c => c.id);
const allCards = state => Object.values(state.players).flatMap(p => [...p.hand, ...p.discard, ...(p.knownDeck ?? []), ...p.ground, ...p.space,
    ...(p.resources??[]), ...(p.leader?.dep===0?[p.leader]:[]), ...[...p.ground, ...p.space].flatMap(c => [...(c.u ?? []), ...(c.cap ?? [])])]);
function staged(id, modify, choices, modifyCue) {
    const definition = A05_DEFINITIONS.find(c => c.id === id); assert.ok(definition);
    const before = a05ShowcaseState(definition); if (modify) modify(before);
    const cue = { definition, source: before.players.p1.hand.find(c => c.s === definition.setCode), seat: 'p1', target: null,
        key: `test:${id}:1`, playPayment:a05PreviewPayment(definition,before,'p1'), outcomes: a05PreviewOutcomes(definition, before, 'p1', choices) };
    if (modifyCue) modifyCue(cue, before);
    const original = clone(before), savedCue = clone(cue), after = resolvePreviewState(before, cue);
    assert.deepEqual(before, original); assert.deepEqual(cue, savedCue);
    return { definition, before, cue, after, p1: after.players.p1, p2: after.players.p2 };
}
const cardDir=path.join(__dirname,'../../forceteki/test/json/Card');
const jsonCards=fs.readdirSync(cardDir).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(cardDir,n))));
const printCode=p=>`${p.set}_${String(p.number).padStart(3,'0')}`;
const byPrint=new Map(jsonCards.flatMap(c=>(c.setCodes??[]).map(p=>[printCode(p),c])));
const { previewCue }=loadTS(path.join(__dirname,'../src/effects/preview.ts'));
const { showcaseGame }=loadTS(path.join(__dirname,'../src/effects/showcase.ts'));
const { findCardEffect }=loadTS(path.join(__dirname,'../src/effects/catalogue.ts'));

test('A05 canonical identities, exact sole aliases, costs and complete actual unit/upgrade/resource facts match source JSON',()=>{
    const canonical=['6452159858','3329959260','5303936245','1565760222','4643489029','9828896088','8080818347','5984647454','5576996578','1141018768'];
    for(const [i,d] of A05_DEFINITIONS.entries()){
        const source=JSON.parse(fs.readFileSync(path.join(cardDir,`${d.id}.json`)));assert.equal(source.id,canonical[i]);assert.equal(d.name,source.title);assert.equal(d.setCode,printCode(source.setId));assert.equal(source.setCodes.length,1);assert.equal(source.unique,false);
        assert.deepEqual(A05_COSTS[d.id],{printed:source.cost,aspects:source.aspects});assert.equal(findCardEffect({n:d.name,s:d.setCode}).id,d.id);
        for(const c of allCards(a05ShowcaseState(d))){assert.ok(c.id&&c.owner);if(!c.s){assert.equal(c.n,'Unknown card');continue;}const json=byPrint.get(c.s);assert.ok(json,c.s);assert.equal(c.n,json.subtitle?`${json.title}: ${json.subtitle}`:json.title);
            if('d' in c){assert.equal(c.p,json.power+(c.u??[]).reduce((n,u)=>n+u.p,0));assert.equal(c.h,json.hp+(c.u??[]).reduce((n,u)=>n+u.h,0));assert.ok(c.d<c.h);assert.equal(c.incarnation,`${c.id}:entry-1`);}
        }
    }
    assert.equal(A05_DEFINITIONS.length,10);assert.equal(findCardEffect({n:'Commission',s:'NOPE_127'}),undefined);
});

test('every primary pays exact actual resources once, conserves physical IDs/owners and is deterministic through registered preview/reset',()=>{
    const payments=[3,4,6,6,8,2,4,4,16,1];
    for(const [i,d] of A05_DEFINITIONS.entries()){
        const e=staged(d.id),extra=d.id==='palpatines-return'?2:0;
        assert.equal(previewPlayCost(d,e.before),payments[i]);assert.equal(previewExtraPayment(d),extra);assert.equal(e.p1.res.ready,e.before.players.p1.res.ready-payments[i]-extra);assert.equal(e.p2.res.ready,7);
        assert.deepEqual(ids(allCards(e.after)).sort(),ids(allCards(e.before)).sort(),d.id);assert.equal(new Set(ids(allCards(e.after))).size,allCards(e.after).length);
        const owners=new Map(allCards(e.before).map(c=>[c.id,c.owner]));for(const c of allCards(e.after))assert.equal(c.owner,owners.get(c.id));
        assert.equal(e.p1.discard.filter(c=>c.id===e.cue.source.id).length,1);assert.equal(e.p1.hand.some(c=>c.id===e.cue.source.id),false);
        for(const p of Object.values(e.after.players)){assert.equal(p.resources.length,p.res.total);assert.equal(p.resources.filter(c=>!c.x).length,p.res.ready);assert.equal(p.knownDeck.length,p.deck);}
        assert.deepEqual(resolvePreviewState(e.before,{...e.cue,key:'other-clock'}),e.after);assert.deepEqual(showcaseGame(d).steps[0].state,e.before);
        const preview=previewCue({definition:d,nonce:77},e.before);assert.deepEqual(preview.outcomes,e.cue.outcomes);assert.deepEqual(preview.playPayment,e.cue.playPayment);
    }
});

test('resource payments require exact distinct ready IDs; manifest/count contradictions and insufficient nested payment reject',()=>{
    const e=staged('evidence-of-the-crime');assert.deepEqual(e.cue.playPayment.cardIds,['a05:p1:resource:0','a05:p1:resource:1','a05:p1:resource:2']);assert.ok(e.p1.resources.slice(0,3).every(c=>c.x));assert.ok(e.p1.resources.slice(3).every(c=>!c.x));
    for(const change of [cue=>cue.playPayment.cardIds[1]=cue.playPayment.cardIds[0],cue=>cue.playPayment.cardIds.pop(),cue=>cue.playPayment.cardIds[0]='absent-resource']){const cue=clone(e.cue);change(cue);assert.throws(()=>resolvePreviewState(e.before,cue),/exact distinct ready/);}
    const stale=clone(e.before);stale.players.p1.resources[0].x=1;assert.throws(()=>resolvePreviewState(stale,e.cue),/manifest contradicts/);
    assert.throws(()=>staged('palpatines-return',s=>{s.players.p1.res.ready=9;s.players.p1.resources[9].x=1;}),/additional payment needs 2/);
});

test('Evidence moves exactly one attachment and its control while preserving owner, hosts, damage and actual stat contributions',()=>{
    const e=staged('evidence-of-the-crime'),m=e.p1.ground[0],w=e.p2.ground[1];assert.deepEqual([m.p,m.h,m.d,m.x],[5,5,1,undefined]);assert.deepEqual([w.p,w.h,w.d,w.x,w.u.length],[4,5,1,undefined,0]);
    assert.equal(m.u.length,1);assert.equal(m.u[0].id,'a05:evidence:academy');assert.equal(m.u[0].owner,'p2');assert.equal(m.u[0].controller,'p1');assert.equal(e.p2.discard.length,0);
    const sameHost=staged('evidence-of-the-crime',undefined,{hostId:'a05:p2:wampa'});assert.deepEqual([sameHost.p2.ground[1].p,sameHost.p2.ground[1].h,sameHost.p2.ground[1].u.length],[6,7,1]);assert.equal(sameHost.p2.ground[1].u[0].controller,'p1');
    const afterRemoval=resolvePreviewState(e.after,{...e.cue,source:null,playPayment:undefined,outcomes:[{kind:'defeat',card:m.u[0],seat:'p1',zone:'discard'}]});assert.deepEqual(ids(afterRemoval.players.p2.discard),['a05:evidence:academy']);assert.equal(afterRemoval.players.p1.ground[0].p,3);
    const wrong=clone(e.cue);wrong.outcomes[0].upgrade.owner='p1';assert.throws(()=>resolvePreviewState(e.before,wrong),/unchanged owner/);
    const absent=clone(e.cue);absent.outcomes[0].card.id='not-the-attachment';assert.throws(()=>resolvePreviewState(e.before,absent),/exact source/);
});

test('Fell uses current nonleader power rather than printed power, cost or HP and performs direct defeat',()=>{
    const e=staged('fell-the-dragon');assert.deepEqual(ids(e.p2.discard),['a05:fell:academy','a05:p2:wampa']);assert.equal(e.p2.ground.some(c=>c.id==='a05:p2:wampa'),false);assert.equal(e.cue.outcomes.some(o=>o.kind==='damage'),false);
    const five=staged('fell-the-dragon',s=>{s.players.p2.ground[1].p=5;s.players.p2.ground[1].status=[{kind:'debuff',label:'−1/+0 · phase',duration:'phase'}];});assert.equal(five.p2.ground.length,1);
    assert.throws(()=>staged('fell-the-dragon',s=>s.players.p2.ground[1].p=4),/current power/);
    assert.throws(()=>staged('fell-the-dragon',s=>{s.players.p2.ground[1].s='SOR_010';s.players.p2.ground[1].n='Darth Vader: Dark Lord of the Sith';}),/non-leader/);
    const wrong=clone(e.cue);wrong.outcomes[0].incarnation='later-entry';assert.throws(()=>resolvePreviewState(e.before,wrong),/different arena incarnation/);
});

test('Rival removes deployed Vader only into the same exhausted undeployed leader summary, with epic spent and no discard/damage',()=>{
    const e=staged('rivals-fall');assert.equal(e.p2.ground.some(c=>c.id==='a05:p2:leader'),false);assert.deepEqual(e.p2.leader,{id:'a05:p2:leader',n:'Darth Vader: Dark Lord of the Sith',s:'SOR_010',owner:'p2',dep:0,x:1,epic:1});assert.equal(e.p2.discard.length,0);assert.equal(e.p2.leader.d,undefined);assert.equal(e.p2.base.d,6);
    for(const change of [cue=>delete cue.outcomes[0].leader,cue=>cue.outcomes[0].leader.epic=undefined,cue=>cue.outcomes[0].leader.x=0,cue=>cue.outcomes[0].leader.id='other-leader']){const cue=clone(e.cue);change(cue);assert.throws(()=>resolvePreviewState(e.before,cue),/exhausted undeployed owner summary/);}
    const ordinary=staged('rivals-fall',undefined,{targetId:'a05:p2:wampa'});assert.ok(ordinary.p2.discard.some(c=>c.id==='a05:p2:wampa'));assert.equal(ordinary.p2.leader.dep,1);
});

test('Remnant privately searches five, publicly reveals only three actual cost-nine units and draws each exactly once',()=>{
    const e=staged('remnant-reserves'),op=e.cue.outcomes[0].deckOperation;assert.equal(op.visibility,'private');assert.deepEqual(op.revealedIds,op.selectedIds);assert.equal(op.printedCostLimit,undefined);
    assert.deepEqual(ids(e.p1.hand),[0,2,3].map(i=>`a05:remnant:top:${i}`));assert.equal(e.p1.hand.reduce((sum,c)=>sum+byPrint.get(c.s).cost,0),9);assert.equal(e.p1.deck,24);
    assert.deepEqual(ids(e.p1.knownDeck),[...ids(e.before.players.p1.knownDeck.slice(5)),'a05:remnant:top:4','a05:remnant:top:1']);assert.equal(e.p1.ground.length,2);
    const none=staged('remnant-reserves',undefined,{selectedIds:[]});assert.equal(none.p1.hand.length,0);assert.equal(none.p1.deck,27);assert.equal(none.cue.outcomes.length,1);
    assert.throws(()=>staged('remnant-reserves',undefined,{selectedIds:['a05:remnant:top:1']}),/trait\/type filter/);
    const wrong=clone(e.cue);wrong.outcomes[0].deckOperation.revealedIds.push('a05:remnant:top:1');assert.throws(()=>resolvePreviewState(e.before,wrong),/actual selected group/);
});

test('Palpatine plays actual Force Kylo directly from discard for event8 plus nested2 with exhausted fresh entry and no Rey waiver',()=>{
    const e=staged('palpatines-return'),kylo=e.p1.ground.at(-1);assert.deepEqual([kylo.id,kylo.p,kylo.h,kylo.d,kylo.x,kylo.incarnation],['a05:return:kylo',6,7,0,1,'a05:return:kylo:entry-2']);assert.equal(e.p1.res.ready,0);assert.deepEqual(ids(e.p1.discard),['a05:palpatines-return:event']);assert.equal(e.p1.hand.length,0);
    assert.equal(e.cue.outcomes[0].amount,-8);assert.equal(e.cue.outcomes[1].amount,2);assert.deepEqual(ids(e.cue.outcomes[1].cards),['a05:p1:resource:8','a05:p1:resource:9']);assert.equal(e.cue.outcomes[2].fromZone,'discard');
    const nonForce=staged('palpatines-return',s=>{Object.assign(s.players.p1.discard[0],{n:'Wampa',s:'SOR_164'});s.players.p1.ground[1]={id:'another:force',n:'Luke Skywalker: Jedi Knight',s:'SOR_051',owner:'p1',p:6,h:7,d:0,incarnation:'another:force:entry-1'};});assert.equal(nonForce.cue.outcomes[0].amount,-6);assert.equal(nonForce.cue.outcomes[1].amount,0);assert.equal(nonForce.p1.res.ready,2);
    const missing=clone(e.cue);missing.outcomes.splice(1,1);assert.throws(()=>resolvePreviewState(e.before,missing),/explicit linked unit payment/);
});

test('Spark resources only own-discard current-phase most-recent unit incarnation, exhausted, and leaves source event discarded',()=>{
    const e=staged('spark-of-hope');assert.deepEqual(e.p1.res,{ready:8,total:11});assert.deepEqual(e.p1.resources.at(-1),{id:'a05:p1:marine',n:'Battlefield Marine',s:'SOR_095',owner:'p1',x:1});assert.deepEqual(ids(e.p1.discard),['a05:spark:old','a05:spark:discarded','a05:spark-of-hope:event']);assert.equal(e.p1.ground.length,1);assert.equal(e.before.defeatedThisPhase.cards[0].controller,'p2');
    for(const edit of [s=>delete s.defeatedThisPhase,s=>s.defeatedThisPhase.round--,s=>s.defeatedThisPhase.phase='regroup',s=>s.defeatedThisPhase.cards[0].lastKnownType='resource',s=>s.mostRecentIncarnations['a05:p1:marine']='a05:p1:marine:entry-2']){const skipped=staged('spark-of-hope',edit);assert.equal(skipped.p1.res.total,10);assert.equal(skipped.p1.discard.length,4);assert.equal(skipped.cue.outcomes.length,0);}
    const duplicate=staged('spark-of-hope',s=>s.defeatedThisPhase.cards.push(clone(s.defeatedThisPhase.cards[0])));assert.equal(duplicate.p1.resources.filter(c=>c.id==='a05:p1:marine').length,1);
    const stale=clone(e.before);stale.mostRecentIncarnations['a05:p1:marine']='later-entry';assert.throws(()=>resolvePreviewState(stale,e.cue),/most-recent unit defeat/);
});

test('Respect captures exact witnessed current enemy base attackers across arenas and strips arena state into owner-preserving pockets',()=>{
    const e=staged('rule-with-respect'),m=e.p1.ground[0];assert.deepEqual(m.cap,[{id:'a05:p2:wampa',n:'Wampa',s:'SOR_164',owner:'p2'},{id:'a05:p2:tie',n:'TIE/ln Fighter',s:'SOR_225',owner:'p2'}]);assert.deepEqual([m.p,m.h,m.d,m.x],[3,3,1,undefined]);assert.deepEqual(ids(e.p2.ground),['a05:p2:trooper']);assert.equal(e.p2.space.length,0);assert.equal(e.p2.discard.length,0);assert.equal(e.p1.base.d,9);
    assert.equal(e.before.players.p1.ground.some(c=>c.sn),false,'prior ground base attack does not bypass Sentinel');
    for(const edit of [s=>s.attacksThisPhase.phase='regroup',s=>s.attacksThisPhase.attacks.forEach(a=>a.targetIds=['a05:p1:marine']),s=>s.attacksThisPhase.attacks.forEach(a=>a.defendingSeat='p2')])assert.equal(staged('rule-with-respect',edit).cue.outcomes.length,0);
    const newInc=staged('rule-with-respect',s=>s.players.p2.ground[1].incarnation='later-wampa');assert.deepEqual(ids(newInc.p1.ground[0].cap),['a05:p2:tie']);
    const nowFriendly=staged('rule-with-respect',s=>s.players.p1.ground.push(s.players.p2.ground.pop()));assert.deepEqual(ids(nowFriendly.p1.ground[0].cap),['a05:p2:tie']);
    const repeated=staged('rule-with-respect',s=>s.attacksThisPhase.attacks.push(clone(s.attacksThisPhase.attacks[0])));assert.equal(repeated.p1.ground[0].cap.length,2);
    const wrong=clone(e.cue);wrong.outcomes[0].captureBasis.targetId='a05:p1:marine';assert.throws(()=>resolvePreviewState(e.before,wrong),/witnessed own-base attack/);
    assert.throws(()=>staged('rule-with-respect',s=>s.players.p2.ground[1].cap=[{id:'nested:captive',n:'Battlefield Marine',s:'SOR_095',owner:'p1'}]),/nested captive cleanup/);
});

test('Loyalty draws only after successful exact friendly defeat; owner and draw recipient differ correctly; attempts do not satisfy',()=>{
    const e=staged('enforced-loyalty');assert.deepEqual(ids(e.p1.discard),['a05:enforced-loyalty:event','a05:p1:marine']);assert.deepEqual(ids(e.p1.hand),['a05:loyalty:draw:0','a05:loyalty:draw:1']);assert.equal(e.p1.deck,25);
    assert.deepEqual(e.cue.outcomes[1].requiresDefeat,{id:'a05:p1:marine',incarnation:'a05:p1:marine:entry-1'});
    const foreign=staged('enforced-loyalty',s=>s.players.p1.ground[0].owner='p2');assert.deepEqual(ids(foreign.p2.discard),['a05:p1:marine']);assert.equal(foreign.p1.hand.length,2);
    const absent=clone(e.cue);absent.outcomes.shift();assert.throws(()=>resolvePreviewState(e.before,absent),/actual successful defeat/);
    const prevented=clone(e.cue);prevented.outcomes[0].prevented=true;assert.throws(()=>resolvePreviewState(e.before,prevented),/actual successful defeat/);
    const attemptedOnly=resolvePreviewState(e.before,{...prevented,outcomes:[prevented.outcomes[0]]});assert.equal(attemptedOnly.players.p1.hand.length,0);assert.equal(attemptedOnly.players.p1.deck,27);assert.equal(attemptedOnly.players.p1.ground.length,2);
    assert.throws(()=>staged('enforced-loyalty',s=>{s.players.p1.knownDeck.splice(1);s.players.p1.deck=1;}),/failed-draw damage/);
});

test('Legions exhausts exact event resources, reveals four, plays three in declared order and ends ready4 total17 without deck replacement',()=>{
    const e=staged('endless-legions');assert.deepEqual(e.p1.res,{ready:4,total:17});assert.equal(e.p1.deck,27);assert.equal(e.p1.hand.length,0);assert.equal(e.p1.discard.length,1);
    assert.deepEqual(e.cue.outcomes.filter(o=>o.kind==='play').map(o=>o.card.id),[0,2,1].map(i=>`a05:p1:resource:${i}`));assert.ok(e.cue.outcomes.filter(o=>o.kind==='pay').every(o=>o.amount===0));
    const entered=[...e.p1.ground,...e.p1.space].filter(c=>c.id.includes(':resource:'));assert.equal(entered.length,3);assert.ok(entered.every(c=>c.x===1&&c.d===0));assert.equal(e.p1.resources.find(c=>c.id==='a05:p1:resource:3').x,1);
    assert.deepEqual(ids(e.p1.resources),ids(e.before.players.p1.resources).filter(id=>!['a05:p1:resource:0','a05:p1:resource:1','a05:p1:resource:2'].includes(id)));
    const none=staged('endless-legions',undefined,{revealIds:[],playIds:[]});assert.deepEqual(none.p1.res,{ready:4,total:20});
    const eventOnly=staged('endless-legions',undefined,{revealIds:['a05:p1:resource:3'],playIds:[]});assert.equal(eventOnly.p1.ground.length,2);assert.equal(eventOnly.p1.res.total,20);
    assert.throws(()=>staged('endless-legions',undefined,{playIds:['a05:p1:resource:0']}),/still-legal revealed/);
    const wrong=clone(e.cue);wrong.outcomes[2].card={...wrong.outcomes[2].card,id:'a05:p1:resource:16'};assert.throws(()=>resolvePreviewState(e.before,wrong),/selected face|revealed chosen sequence/);
});

test('ready resource departure needs exact declared swap; swaps preserve ready count and do not replace from deck',()=>{
    const modify=s=>Object.assign(s.players.p1.resources[16],{n:'Battlefield Marine',s:'SOR_095'}),id='a05:p1:resource:16';
    const e=staged('endless-legions',modify,{revealIds:[id],playIds:[id],resourceReadySwaps:{[id]:{readyId:id,exhaustedId:'a05:p1:resource:3'}}});assert.deepEqual(e.p1.res,{ready:4,total:19});assert.equal(e.p1.resources.find(c=>c.id==='a05:p1:resource:3').x,undefined);assert.equal(e.p1.deck,27);
    assert.throws(()=>staged('endless-legions',modify,{revealIds:[id],playIds:[id]}),/explicit readiness swap/);
    assert.throws(()=>staged('endless-legions',modify,{revealIds:[id],playIds:[id],resourceReadySwaps:{[id]:{readyId:id,exhaustedId:'a05:p1:resource:17'}}}),/actual ready\/exhausted/);
});

test('Commission chooses actual Item upgrade without playing/attaching, accepts all three trait branches, and preserves private unselected group',()=>{
    const e=staged('commission');assert.deepEqual(ids(e.p1.hand),['a05:commission:top:8']);assert.equal(e.p1.hand[0].s,'SOR_071');assert.equal(e.p1.deck,26);assert.equal(e.p1.ground[0].u,undefined);assert.equal(e.cue.outcomes.some(o=>['play','attach'].includes(o.kind)),false);
    const op=e.cue.outcomes[0].deckOperation;assert.equal(op.visibility,'private');assert.deepEqual(op.revealedIds,['a05:commission:top:8']);assert.deepEqual(ids(e.p1.knownDeck.slice(0,17)),ids(e.before.players.p1.knownDeck.slice(10)));
    for(const [n,s] of [['Discerning Veteran','SHD_120'],['Naboo Royal Starship: Fit For A Queen','SEC_099']]){const branch=staged('commission',state=>Object.assign(state.players.p1.knownDeck[8],{n,s}));assert.equal(branch.p1.hand[0].s,s);}
    assert.throws(()=>staged('commission',undefined,{selectedIds:['a05:commission:top:0']}),/trait\/type/);
    assert.throws(()=>staged('commission',undefined,{selectedIds:['a05:p1:deck:10']}),/outside actual looked prefix/);
    const none=staged('commission',undefined,{selectedIds:[]});assert.equal(none.p1.deck,27);assert.equal(none.p1.hand.length,0);
    assert.ok(cardAbilities('commission').some(b=>b.condition.includes('Actual source resource')));
});

test('recordings without optional history/manifests never manufacture upgrade ownership, Spark source, capture witness or nested cost',()=>{
    for(const d of A05_DEFINITIONS){const e=staged(d.id),before=clone(e.before),after=clone(e.after);for(const state of [before,after]){delete state.defeatedThisPhase;delete state.mostRecentIncarnations;delete state.attacksThisPhase;for(const p of Object.values(state.players)){delete p.knownDeck;delete p.resources;for(const c of allCards(state)){delete c.owner;delete c.incarnation;delete c.controller;}}}
        const game={header:{t:'header',v:1,seed:1,engine:null,players:[]},end:null,steps:[{t:'step',n:0,state:before},{t:'step',n:1,state:after}]};const observed=observedOutcomes(game,{index:1,until:1,seat:'p1',kind:'play-event',card:e.cue.source});
        assert.ok(observed.every(o=>!o.captureBasis&&!o.defeatPhase&&!o.requiresDefeat&&!o.deckOperation&&!o.controllerSeat));
        if(d.id==='spark-of-hope'){const resource=observed.find(o=>o.kind==='resource');assert.ok(resource);assert.equal(resource.card,null);assert.equal(resource.entersReady,undefined);}
    }
});
