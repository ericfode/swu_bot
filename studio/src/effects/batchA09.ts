import type { AbilityBeat } from './abilities';
import type { PreviewAspect, PreviewCardCost } from './previewCosts';
import type { CardEffectDefinition, CardEffectOutcome, PreviewPlayPayment } from './types';
import type { CardRef, ResourceRef, Seat, Snapshot, UnitRef, UpgradeRef } from '../data/types';

const rows: [string,string,string,number,string,string][] = [
 ['hello-there','Hello There','TWI_052',4400,'force','Four stat steps compress a proven recent entry'],
 ['equalize','Equalize','TWI_055',5000,'tactics','First reduction, live count checkpoint, different second recipient'],
 ['i-have-the-high-ground','I Have the High Ground','TWI_072',4200,'tactics','A standing defensive bracket with unchanged resting stats'],
 ['grievous-reassembly','Grievous Reassembly','TWI_073',4800,'support','Wound repair and independent exhausted token assembly'],
 ['guarding-the-way','Guarding the Way','TWI_074',4400,'tactics','Space Sentinel ring with a separate initiative authorization'],
 ['disruptive-burst','Disruptive Burst','TWI_075',5000,'force','Opponent-only interference across both arenas'],
 ['death-by-droids','Death by Droids','TWI_076',5000,'tactics','Printed-cost defeat and two independent assembly columns'],
 ['the-invasion-of-christophsis','The Invasion of Christophsis','TWI_078',6600,'tactics','Four cost sacrifices, exact payment, then opponent-only collapse'],
 ['reprocess','Reprocess','TWI_088',5600,'support','Chosen discard cards to private bottom, same count freshly assembled'],
 ['consolidation-of-power','Consolidation of Power','TWI_089',6200,'tactics','Seal selected power, free arrival, then sacrifice the original set']
];
export const A09_DEFINITIONS:CardEffectDefinition[]=rows.map(([id,name,setCode,durationMs,family,description])=>({id,name,setCode,durationMs,family:family as CardEffectDefinition['family'],description,visual:id,color:'#a6bbdd'}));
export const A09_COSTS:Record<string,PreviewCardCost>={
 'hello-there':{printed:3,aspects:['vigilance','heroism']},equalize:{printed:3,aspects:['vigilance','vigilance']},
 'i-have-the-high-ground':{printed:1,aspects:['vigilance']},'grievous-reassembly':{printed:2,aspects:['vigilance']},
 'guarding-the-way':{printed:2,aspects:['vigilance']},'disruptive-burst':{printed:3,aspects:['vigilance']},
 'death-by-droids':{printed:5,aspects:['vigilance']},'the-invasion-of-christophsis':{printed:15,aspects:['vigilance'],exploit:4},
 reprocess:{printed:3,aspects:['command','villainy']},'consolidation-of-power':{printed:6,aspects:['command','villainy']}
};
export const A09_ABILITIES:Record<string,AbilityBeat[]>={
 'hello-there':[{kind:'debuff',label:'Give any unit that entered play this phase −4/−4 for this phase',scope:'target',amount:'−4/−4',duration:'phase',condition:'Any current unit/either arena/controller, including played, deployed, created or rescued; actual current-phase entry evidence, unchanged wounds, power floor zero and explicit HP-loss departure'}],
 equalize:[{kind:'debuff',label:'Give any unit −2/−2 for this phase',scope:'target',amount:'−2/−2',duration:'phase'},{kind:'debuff',label:'Then, if you control fewer units than its controller, give a different unit −2/−2',scope:'target',amount:'−2/−2',duration:'phase',condition:'Count current units after first reduction and actual departures; first controller, not owner; different target either side/arena. Friendly first target cannot satisfy own-count comparison'}],
 'i-have-the-high-ground':[{kind:'buff',label:'Choose a friendly unit: while it defends this phase, the attacker gets −4/−0',scope:'friendly-unit',duration:'phase',condition:'Printed errata; unchanged resting stats, no immediate attack. Matching actual later combat only; power floors zero, current protected entry and phase'}],
 'grievous-reassembly':[{kind:'heal',label:'Heal up to 3 existing damage from any unit',scope:'target',amount:3,condition:'Either controller/arena/deployed leader; never a base; simultaneous with independent creation'},{kind:'create',label:'Create one Battle Droid token under your control',scope:'friendly-unit',amount:1,condition:'Independent of successful healing; ground 1/1, new token identity, exhausted normal created entry; no When Played'}],
 'guarding-the-way':[{kind:'keyword',label:'Give any unit Sentinel this phase',scope:'target',duration:'phase',condition:'Friendly or enemy/either arena; keyword not an attachment'},{kind:'buff',label:'If you have initiative, also give it +2/+2 this phase',scope:'target',amount:'+2/+2',duration:'phase',condition:'Event controller initiative, not recipient controller; simultaneous, unchanged damage/readiness'}],
 'disruptive-burst':[{kind:'debuff',label:'Give every enemy unit −1/−1 this phase',scope:'all-units',selection:'all',amount:'−1/−1',duration:'phase',condition:'Opponent-controlled both arenas/deployed leaders/tokens, not ownership; damage/pose unchanged, explicit owner/leader/token HP-loss destinations'}],
 'death-by-droids':[{kind:'defeat',label:'Defeat any unit of printed cost 3 or less',scope:'target',condition:'Any controller/arena, eligible leaders/tokens; printed cost, actual separate defeat result; simultaneous with creation'},{kind:'create',label:'Create two Battle Droid tokens under your control',scope:'friendly-unit',amount:2,condition:'Independent of eligible target or successful defeat, no if-you-do; distinct exhausted ground token entries, no When Played'}],
 'the-invasion-of-christophsis':[{kind:'cost',label:'Exploit 4: optionally defeat up to four controlled units to reduce this cost by 2 each',scope:'friendly-arena',amount:'2 per chosen unit',optional:true,condition:'Actual cost sacrifices before resource payment, either arena/leader/token, exact continuing entries; other costs/aspects unchanged'},{kind:'defeat',label:'Choose an opponent and defeat every unit they control',scope:'all-units',selection:'all',condition:'Both arenas/deployed leaders/tokens; actual owner destinations, no own survivors or bases; attachment/captive consequences separately supplied'}],
 reprocess:[{kind:'recover',label:'Choose up to four unit cards in your discard and put them on the bottom of your deck in random order',scope:'discard',selection:'chosen',amount:'up to 4',optional:true,condition:'Printed unit type including discarded Piloting units, not upgrades/events/opponent discard; zero legal, no phase history needed'},{kind:'create',label:'Create a Battle Droid for each chosen unit card',scope:'friendly-unit',amount:'chosen count',condition:'Chosen target count, not if-you-do movement success; fresh distinct exhausted ground token entries'}],
 'consolidation-of-power':[{kind:'inspect',label:'Choose any number of units you control and sum their current power',scope:'friendly-arena',selection:'chosen',amount:'chosen current power',condition:'May choose zero, either arena/leader/token/ready or exhausted; current modifiers included'},{kind:'play',label:'You may play an own-hand unit of printed cost no greater than that total for free',scope:'own-hand',optional:true,condition:'Resource/aspect costs ignored, other restrictions/additional costs and actual normal entry effects remain; new exhausted entry'},{kind:'defeat',label:'Then defeat all originally chosen units',scope:'friendly-arena',selection:'chosen',condition:'Even when free play declined or no legal hand target; selected power sealed before play, new arrival not chosen; actual owner/attachment destinations'}]
};
const labels:Record<string,string>={
 'hello-there':'Pay 3; newly played AT-ST 6/7 → 2/3 this phase, damage 0 and exhaustion stay',
 equalize:'Pay 5; Wampa −2/−2, then P1 2 < P2 4; different wounded Trooper loses its last HP',
 'i-have-the-high-ground':'Pay 1; Defender keeps 4/3 and Sentinel; while defending this phase, attacker gets −4 power',
 'grievous-reassembly':'Pay 2; enemy Wampa damage 4 → 1 while one new exhausted Battle Droid assembles',
 'guarding-the-way':'Pay 2; X-Wing gains Sentinel; P1 initiative also grants +2/+2 this phase',
 'disruptive-burst':'Pay 3; five enemy units −1/−1 across both arenas; Fighter discarded, token ceases, Vader survives',
 'death-by-droids':'Pay 5; printed cost 3 Trooper defeated while two new exhausted Battle Droids assemble',
 'the-invasion-of-christophsis':'Exploit Marine, Defender, X-Wing and Droid: 15 − 8 = 7 paid; then five enemy units defeated',
 reprocess:'Pay 5; choose three discard units, random bottom X-Wing → Marine → Defender; create three exhausted Droids',
 'consolidation-of-power':'Pay 8; choose Marine power 5 + X-Wing 2; free Wampa cost 4, then original units sacrificed'
};
export const A09_EXAMPLES:Record<string,{label:string;beats:AbilityBeat[]}>=Object.fromEntries(Object.entries(labels).map(([id,label])=>[id,{label,beats:A09_ABILITIES[id]}]));
const supported=new Set(rows.map(r=>r[0]));
const card=(id:string,n:string,s:string|null,owner:Seat):CardRef=>({id,n,s,owner});
const unit=(c:CardRef,p:number,h:number,d=0,extra:Partial<UnitRef>={}):UnitRef=>({...c,p,h,d,incarnation:`${c.id}:entry-1`,...extra});
const droid=(id:string,owner:Seat):UnitRef=>unit(card(id,'Battle Droid',null,owner),1,1,0,{t:1,x:1});
const resources=(seat:Seat,total:number,ready:number):ResourceRef[]=>Array.from({length:total},(_,i)=>({...card(`a09:${seat}:resource:${i}`,'Unknown card',null,seat),...(i>=ready?{x:1 as const}:{})}));
const deck=(seat:Seat,total:number):CardRef[]=>Array.from({length:total},(_,i)=>card(`a09:${seat}:deck:${i}`,'Unknown card',null,seat));
const academy=(id:string,owner:Seat):UpgradeRef=>({...card(id,'Academy Training','SOR_120',owner),controller:owner,t:0,p:2,h:2});
function fail(s:string):never{throw new Error(`A09: ${s}`);}
const costFacts:Record<string,number>={SOR_095:2,SOR_098:3,SOR_237:2,SOR_033:3,SOR_164:4,SOR_225:1,SOR_232:6,SHD_239:3,SOR_010:7};
const unitFaces=new Set(Object.keys(costFacts));
function price(d:CardEffectDefinition,s:Snapshot,seat:Seat,discount=0):number{
 const facts:Record<string,PreviewAspect[]>={SOR_024:['command'],SOR_020:['vigilance'],SOR_005:['vigilance','heroism'],SOR_010:['aggression','villainy']},p=s.players[seat],have=[...(p.base.s&&facts[p.base.s]||fail('unverified base provider')),...(p.leader?(p.leader.s&&facts[p.leader.s]||fail('unverified leader provider')):[])],meta=A09_COSTS[d.id];
 return Math.max(0,meta.printed+2*meta.aspects.filter(a=>{const i=have.indexOf(a);if(i<0)return true;have.splice(i,1);return false;}).length-discount);
}
export function a09ShowcaseState(d:CardEffectDefinition):Snapshot|undefined{
 if(!supported.has(d.id))return;
 const s:Snapshot={round:11,phase:'action',initiative:'p1',players:{
 p1:{name:'Rebel Alliance',base:{...card('a09:p1:base','Echo Base','SOR_024','p1'),hp:30,d:9},leader:{...card('a09:p1:leader','Luke Skywalker: Faithful Friend','SOR_005','p1'),dep:0,x:0},res:{total:16,ready:16},resources:resources('p1',16,16),hand:[card(`a09:${d.id}:event`,d.name,d.setCode,'p1')],deck:27,knownDeck:deck('p1',27),discard:[],ground:[unit(card('a09:p1:marine','Battlefield Marine','SOR_095','p1'),3,3,1),unit(card('a09:p1:defender','Echo Base Defender','SOR_098','p1'),4,3,0,{sn:1})],space:[unit(card('a09:p1:xwing','Alliance X-Wing','SOR_237','p1'),2,3)]},
 p2:{name:'Galactic Empire',base:{...card('a09:p2:base','Capital City','SOR_020','p2'),hp:30,d:6},leader:{...card('a09:p2:leader','Darth Vader: Dark Lord of the Sith','SOR_010','p2'),dep:0,x:1},res:{total:10,ready:7},resources:resources('p2',10,7),hand:[card('a09:p2:hand:takedown','Takedown','SOR_077','p2'),card('a09:p2:hand:repair','Repair','SOR_074','p2')],deck:29,knownDeck:deck('p2',29),discard:[],ground:[unit(card('a09:p2:trooper','Death Trooper','SOR_033','p2'),3,3,1),unit(card('a09:p2:wampa','Wampa','SOR_164','p2'),4,5,1)],space:[unit(card('a09:p2:tie','TIE/ln Fighter','SOR_225','p2'),2,1)]}
 }},p=s.players.p1,q=s.players.p2;
 const deployed=()=>{q.leader!.dep=1;q.leader!.epic=1;q.ground.push(unit(q.leader!,5,8,2,{x:1}));};
 switch(d.id){
 case 'hello-there':q.ground[1]=unit(card('a09:hello:atst','AT-ST','SOR_232','p2'),6,7,0,{x:1});q.res.ready=4;q.resources=resources('p2',10,10).map((r,i)=>({...r,...(i<6?{x:1 as const}:{})}));s.enteredThisPhase={round:11,phase:'action',units:[{id:q.ground[1].id!,incarnation:q.ground[1].incarnation!,entryType:'played'}]};break;
 case 'equalize':p.ground.splice(1,1);p.ground[0].d=0;q.ground.push(unit(card('a09:equalize:enemy-defender','Echo Base Defender','SOR_098','p2'),4,3,0,{sn:1}));break;
 case 'grievous-reassembly':q.ground[1].d=4;break;
 case 'disruptive-burst':q.ground.push(droid('a09:burst:droid','p2'));deployed();break;
 case 'the-invasion-of-christophsis':p.ground.push(droid('a09:invasion:own-droid','p1'),unit(card('a09:invasion:survivor','Toro Calican: Ambitious Upstart','SHD_239','p1'),3,5,1));q.ground.push(droid('a09:invasion:enemy-droid','p2'));deployed();q.ground[1].u=[academy('a09:invasion:academy','p1')];q.ground[1].p=6;q.ground[1].h=7;break;
 case 'reprocess':p.discard=[card('a09:reprocess:dead:0','Battlefield Marine','SOR_095','p1'),card('a09:reprocess:dead:1','Echo Base Defender','SOR_098','p1'),card('a09:reprocess:dead:2','Alliance X-Wing','SOR_237','p1'),card('a09:reprocess:repair','Repair','SOR_074','p1')];break;
 case 'consolidation-of-power':p.ground[0].u=[academy('a09:consolidation:academy','p2')];p.ground[0].p=5;p.ground[0].h=5;p.space[0].x=1;p.hand.push(card('a09:consolidation:played','Wampa','SOR_164','p1'));break;
 }
 return s;
}
export interface A09Choices{targetId?:string|null;firstId?:string;secondId?:string|null;exploitIds?:string[];selectedIds?:string[];bottomOrder?:string[];playId?:string|null;preventDefeat?:boolean;preventRecoverIds?:string[]}
const arena=(s:Snapshot,seat:Seat)=>[...s.players[seat].ground,...s.players[seat].space];
export function a09PreviewSource(d:CardEffectDefinition,s:Snapshot,seat:Seat):CardRef|undefined{
 if(!supported.has(d.id))return;const a=s.players[seat].hand.filter(c=>c.id===`a09:${d.id}:event`&&c.n===d.name&&c.s===d.setCode);if(a.length!==1)fail('exact own-hand event missing or ambiguous');return a[0];
}
function exploit(d:CardEffectDefinition,s:Snapshot,seat:Seat,c:A09Choices):UnitRef[]{
 if(d.id!=='the-invasion-of-christophsis')return[];
 const ids=c.exploitIds??['a09:p1:marine','a09:p1:defender','a09:p1:xwing','a09:invasion:own-droid'];
 if(ids.length>4||new Set(ids).size!==ids.length)fail('Exploit chooses zero to four distinct controlled entries');
 return ids.map(id=>arena(s,seat).find(u=>u.id===id&&u.incarnation&&u.h>u.d)??fail('Exploit chosen controlled live entry missing'));
}
export function a09PreviewPayment(d:CardEffectDefinition,s:Snapshot,seat:Seat,c:A09Choices={}):PreviewPlayPayment|undefined{
 if(!supported.has(d.id))return;const source=a09PreviewSource(d,s,seat)!,chosen=exploit(d,s,seat,c),n=price(d,s,seat,chosen.length*2),paid=s.players[seat].resources?.filter(r=>!r.x).slice(0,n)??fail('resource manifest missing');if(paid.length!==n)fail('event payment unaffordable');
 return{kind:'resources',cardIds:paid.map(r=>r.id!),...(d.id==='the-invasion-of-christophsis'?{exploit:{sourceId:source.id!,units:chosen.map(u=>({id:u.id!,incarnation:u.incarnation!}))}}:{})};
}
export function a09PreviewOutcomes(d:CardEffectDefinition,s:Snapshot,seat:Seat,c:A09Choices={}):CardEffectOutcome[]|undefined{
 if(!supported.has(d.id))return;const source=a09PreviewSource(d,s,seat)!,enemy:Seat=seat==='p1'?'p2':'p1',p=s.players[seat],q=s.players[enemy],out:CardEffectOutcome[]=[];
 const locate=(id:string)=>{for(const side of [seat,enemy]){const u=arena(s,side).find(u=>u.id===id);if(u&&u.incarnation)return{u,side,zone:p.space.includes(u)||q.space.includes(u)?'space' as const:'ground' as const};}return fail('actual arena target missing');};
 const defeat=(u:UnitRef,side:Seat,extra:Partial<CardEffectOutcome>={}):CardEffectOutcome=>{const summary=s.players[u.owner??side].leader,isLeader=summary?.dep===1&&summary.id===u.id;return{kind:'defeat',card:u,seat:side,zone:isLeader?'leader':p.space.includes(u)||q.space.includes(u)?'space':'ground',sourceCard:source,ownerSeat:u.owner??side,incarnation:u.incarnation,...(isLeader?{leader:{...summary,dep:0,x:1}}:{}),...extra};};
 const reduction=(id:string,amount:string,extra:Partial<CardEffectOutcome>={})=>{const t=locate(id);out.push({kind:'debuff',card:t.u,seat:t.side,zone:t.zone,amount,duration:'phase',label:`${amount} PHASE`,sourceCard:source,incarnation:t.u.incarnation,...extra});const loss=Number(amount.replaceAll('−','-').split('/')[1]);if(t.u.d>=Math.max(0,t.u.h+loss))out.push(defeat(t.u,t.side));return t;};
 const create=(stem:string,n:number,extra:Partial<CardEffectOutcome>={})=>{for(let i=0;i<n;i++){const u=droid(`a09:${stem}:droid:${i}`,seat);out.push({kind:'create',card:u,unit:u,seat,zone:'ground',amount:1,tokenType:'battle-droid',entryType:'created',entersReady:false,sourceCard:source,ownerSeat:seat,incarnation:u.incarnation,...extra});}};
 switch(d.id){
 case 'hello-there':{const t=locate(c.targetId??'a09:hello:atst'),h=s.enteredThisPhase;if(!h||h.round!==s.round||h.phase!==s.phase||!h.units.some(x=>x.id===t.u.id&&x.incarnation===t.u.incarnation))fail('current phase actual entry prerequisite missing');reduction(t.u.id!,'−4/−4',{enteredPhase:{round:s.round,phase:s.phase,incarnation:t.u.incarnation!}});break;}
 case 'equalize':{const sequenceId='a09:equalize:sequence',first=reduction(c.firstId??'a09:p2:wampa','−2/−2',{sequenceId,sequenceIndex:1});const lethal=first.u.d>=Math.max(0,first.u.h-2),ownCount=arena(s,seat).length-(lethal&&first.side===seat?1:0),otherCount=arena(s,first.side).length-(lethal?1:0),secondId=c.secondId===undefined?'a09:p2:trooper':c.secondId;if(ownCount<otherCount&&secondId){if(secondId===first.u.id)fail('Equalize requires a different second unit');reduction(secondId,'−2/−2',{sequenceId,sequenceIndex:2,unitCountCondition:{firstId:first.u.id!,incarnation:first.u.incarnation!,player:seat,against:first.side,ownCount,otherCount}});}break;}
 case 'i-have-the-high-ground':{const t=locate(c.targetId??'a09:p1:defender');if(t.side!==seat)fail('High Ground needs friendly unit');out.push({kind:'buff',card:t.u,seat,zone:t.zone,duration:'phase',label:'DEFENDING: ATTACKER −4',sourceCard:source,incarnation:t.u.incarnation,defenseModifier:{attackerPower:-4,sourceId:source.id!,round:s.round,phase:s.phase,incarnation:t.u.incarnation!}});break;}
 case 'grievous-reassembly':{const resolutionGroup={id:'a09:reassembly:simultaneous',mode:'simultaneous' as const},fallback=arena(s,enemy).find(u=>u.id==='a09:p2:wampa')??arena(s,seat)[0]??arena(s,enemy)[0],target=c.targetId===undefined?fallback?.id:c.targetId;if(target){const t=locate(target);out.push({kind:'heal',card:t.u,seat:t.side,zone:t.zone,amount:Math.min(3,t.u.d),sourceCard:source,resolutionGroup});}create('reassembly',1,{resolutionGroup});break;}
 case 'guarding-the-way':{const t=locate(c.targetId??'a09:p1:xwing'),resolutionGroup={id:'a09:guard:simultaneous',mode:'simultaneous' as const};out.push({kind:'keyword',card:t.u,seat:t.side,zone:t.zone,keyword:{name:'Sentinel',amount:1},duration:'phase',sourceCard:source,incarnation:t.u.incarnation,resolutionGroup});if(s.initiative===seat)out.push({kind:'buff',card:t.u,seat:t.side,zone:t.zone,amount:'+2/+2',duration:'phase',label:'+2/+2 PHASE',sourceCard:source,incarnation:t.u.incarnation,resolutionGroup,condition:{kind:'initiative',player:seat,initiative:seat}});break;}
 case 'disruptive-burst':for(const u of arena(s,enemy))reduction(u.id!,'−1/−1');break;
 case 'death-by-droids':{const resolutionGroup={id:'a09:death:simultaneous',mode:'simultaneous' as const};const fallback=arena(s,enemy).concat(arena(s,seat)).find(u=>(u.t?0:costFacts[u.s??'']??Infinity)<=3),target=c.targetId===undefined?fallback?.id:c.targetId;if(target){const t=locate(target),cost=t.u.t?0:costFacts[t.u.s??''];if(cost===undefined||cost>3)fail('Death by Droids requires actual printed unit cost at most three');out.push(defeat(t.u,t.side,{printedCost:cost,resolutionGroup,...(c.preventDefeat?{prevented:true}:{})}));}create('death',2,{resolutionGroup});break;}
 case 'the-invasion-of-christophsis':{const selected=exploit(d,s,seat,c);for(const u of selected)out.push(defeat(u,seat,{paymentRole:'exploit',label:'EXPLOIT COST SACRIFICE'}));out.push({kind:'cost',card:source,sourceCard:source,seat,zone:'resources',amount:selected.length?-2*selected.length:0,label:`15 − ${2*selected.length} = ${price(d,s,seat,2*selected.length)} PAID`});for(const u of arena(s,enemy))out.push(defeat(u,enemy,{selection:'all'}));break;}
 case 'reprocess':{const ids=c.selectedIds??['a09:reprocess:dead:0','a09:reprocess:dead:1','a09:reprocess:dead:2'];if(ids.length>4||new Set(ids).size!==ids.length)fail('Reprocess chooses at most four distinct discard units');const chosen=ids.map(id=>p.discard.find(x=>x.id===id&&x.s&&unitFaces.has(x.s))??fail('Reprocess requires actual own discard printed unit'));const order=c.bottomOrder??[...ids.slice(2),...ids.slice(0,2)];if(order.length!==ids.length||new Set(order).size!==ids.length||order.some(id=>!ids.includes(id)))fail('random bottom order must be exact selected permutation');const group='a09:reprocess:chosen';for(const id of order)out.push({kind:'recover',card:chosen.find(x=>x.id===id)!,seat,zone:'deck',destination:'deck-bottom',sourceCard:source,cards:chosen,chosenUnitGroup:group,...(c.preventRecoverIds?.includes(id)?{prevented:true}:{})});create('reprocess',chosen.length,{cards:chosen,chosenUnitGroup:group});break;}
 case 'consolidation-of-power':{const ids=c.selectedIds??['a09:p1:marine','a09:p1:xwing'];if(new Set(ids).size!==ids.length)fail('chosen units must be distinct');const chosen=ids.map(id=>arena(s,seat).find(u=>u.id===id&&u.incarnation)??fail('chosen current controlled unit missing')),chosenUnits=chosen.map(u=>({id:u.id!,incarnation:u.incarnation!,power:u.p})),chosenUnitGroup='a09:consolidation:chosen',sum=chosenUnits.reduce((n,u)=>n+u.power,0),playId=c.playId===undefined?'a09:consolidation:played':c.playId;
 if(playId){const selected=p.hand.find(x=>x.id===playId&&x.s&&unitFaces.has(x.s))??fail('free selected own-hand unit missing'),cost=costFacts[selected.s!];if(cost>sum)fail('free printed cost exceeds chosen actual power');const stats:Record<string,[number,number]>={SOR_164:[4,5],SOR_095:[3,3],SOR_225:[2,1]};if(!stats[selected.s!])fail('complete selected unit stats not verified');const [power,hp]=stats[selected.s!],entering=unit(selected,power,hp,0,{x:1});out.push({kind:'pay',sourceCard:selected,card:selected,seat,zone:'resources',amount:0,cards:[],chosenUnits,chosenUnitGroup});out.push({kind:'play',card:selected,unit:entering,seat,fromSeat:seat,fromZone:'hand',zone:selected.s==='SOR_225'?'space':'ground',sourceCard:source,ownerSeat:selected.owner,printedCost:cost,entersReady:false,entryType:'played',chosenUnits,chosenUnitGroup});}
 for(const u of chosen)out.push(defeat(u,seat,{chosenUnits,chosenUnitGroup}));break;}
 }
 return out;
}
