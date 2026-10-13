import type { CardRef, ResourceRef, Seat, Snapshot, UnitRef, UpgradeRef } from '../data/types';
import type { AbilityBeat } from './abilities';
import type { PreviewAspect, PreviewCardCost } from './previewCosts';
import type { CardEffectDefinition, CardEffectOutcome, PreviewPlayPayment } from './types';

/** Source-verified chosen fixtures; docs/card-animation-a05-spec.md and card-animation-a05-contract.md. */
export const A05_DEFINITIONS: CardEffectDefinition[] = [
    { id:'evidence-of-the-crime',name:'Evidence of the Crime',setCode:'SHD_077',family:'tactics',color:'#d8bc8a',visual:'evidence-of-the-crime',durationMs:5400,description:'Take control of an eligible cost-three-or-less upgrade and attach it to a chosen unit; ownership stays distinct.' },
    { id:'fell-the-dragon',name:'Fell the Dragon',setCode:'SHD_078',family:'tactics',color:'#e6b29b',visual:'fell-the-dragon',durationMs:4400,description:'Directly defeat a non-leader with current effective power at least five.' },
    { id:'rivals-fall',name:"Rival's Fall",setCode:'SHD_079',family:'tactics',color:'#c6ace3',visual:'rivals-fall',durationMs:4800,description:'Defeat any unit; a deployed leader returns to its owner leader area exhausted, deployment still spent.' },
    { id:'remnant-reserves',name:'Remnant Reserves',setCode:'SHD_093',family:'support',color:'#aed0bc',visual:'remnant-reserves',durationMs:5600,description:'Private top-five search; reveal and draw up to three selected units, other searched cards to random bottom.' },
    { id:'palpatines-return',name:"Palpatine's Return",setCode:'SHD_094',family:'force',color:'#c3ace5',visual:'palpatines-return',durationMs:5800,description:'Play an actual discard unit for six less, or eight less if that selected unit has Force.' },
    { id:'spark-of-hope',name:'Spark of Hope',setCode:'SHD_105',family:'support',color:'#b7dfa2',visual:'spark-of-hope',durationMs:4800,description:'Resource an own-discard unit defeated this phase, with no later return to play; it enters exhausted.' },
    { id:'rule-with-respect',name:'Rule with Respect',setCode:'SHD_106',family:'tactics',color:'#b4d9de',visual:'rule-with-respect',durationMs:6000,description:'A friendly unit captures enemy non-leaders that attacked your base this phase and remain in the same uninterrupted arena entry.' },
    { id:'enforced-loyalty',name:'Enforced Loyalty',setCode:'SHD_108',family:'tactics',color:'#c6c99c',visual:'enforced-loyalty',durationMs:5200,description:'Defeat a friendly unit; only a successful defeat authorizes drawing two for the event controller.' },
    { id:'endless-legions',name:'Endless Legions',setCode:'SHD_109',family:'support',color:'#c4d4b1',visual:'endless-legions',durationMs:7000,description:'Publicly reveal selected actual resources, then play their legal units free one at a time without deck replacements.' },
    { id:'commission',name:'Commission',setCode:'SHD_127',family:'support',color:'#deb98a',visual:'commission',durationMs:5600,description:'Private top-ten search for one Bounty Hunter, Item or Transport card; reveal/draw it, others to random bottom.' }
];
export const A05_COSTS: Record<string, PreviewCardCost> = {
    'evidence-of-the-crime':{printed:3,aspects:['vigilance']},'fell-the-dragon':{printed:4,aspects:['vigilance']},'rivals-fall':{printed:6,aspects:['vigilance']},
    'remnant-reserves':{printed:4,aspects:['command','villainy']},'palpatines-return':{printed:6,aspects:['command','villainy']},
    'spark-of-hope':{printed:2,aspects:['command','heroism']},'rule-with-respect':{printed:4,aspects:['command','heroism']},
    'enforced-loyalty':{printed:2,aspects:['command','command']},'endless-legions':{printed:14,aspects:['command','command']},commission:{printed:1,aspects:['command']}
};
export const A05_ABILITIES: Record<string, AbilityBeat[]> = {
    'evidence-of-the-crime':[{kind:'attach',label:'Take control of an upgrade costing at most three and attach it to an eligible unit',scope:'target',selection:'chosen',condition:'Any source/destination side or arena and deployed unit hosts; preserve owner, explicit new controller; attachment restrictions; not play/defeat/return; pinned class excludes base-attached sources'}],
    'fell-the-dragon':[{kind:'defeat',label:'Defeat any non-leader with current effective power at least five',scope:'target',selection:'chosen',condition:'Current modifiers count; either controller/arena; no leader/base; no damage; attachments/captives require supported cleanup'}],
    'rivals-fall':[{kind:'defeat',label:'Defeat any unit',scope:'target',selection:'chosen',condition:'Either side/arena; deployed leader goes to owner leader area exhausted with deployment spent; nonleader to owner discard, tokens cease; ordinary cleanup remains'}],
    'remnant-reserves':[{kind:'search',label:'Privately search top five for up to three units; reveal only selections',scope:'own-deck',amount:5,selection:'chosen',optional:true,condition:'No combined cost cap; fewer with short deck; unchosen searched cards to random bottom; untouched suffix ordered'},{kind:'draw',label:'Draw the actual selected units',scope:'own-hand',from:'own-deck',amount:'up to 3',condition:'Separate movement once, no play or draw when none selected'}],
    'palpatines-return':[{kind:'cost',label:'Selected discard unit costs six less, or eight less if it has Force',scope:'resources',amount:'−6 or −8',condition:'Trait of selected unit, not another controlled Force unit; all penalties before zero floor; additional costs/restrictions still apply'},{kind:'play',label:'Play the selected unit directly from your discard',scope:'friendly-arena',from:'discard',selection:'chosen',condition:'Ordinary exhausted entry and normal entry effects; unit mode, not Pilot upgrade; new arena incarnation, same physical ID'}],
    'spark-of-hope':[{kind:'resource',label:'Resource a unit in own discard defeated as its most recent unit incarnation this phase',scope:'resources',from:'discard',selection:'chosen',amount:1,condition:'Actual current-phase unit-type defeat plus most-recent incarnation; former controller irrelevant; no old/resource defeat/ordinary discard; enters exhausted; source event remains discard'}],
    'rule-with-respect':[{kind:'capture',label:'A chosen friendly unit captures every current enemy non-leader that attacked your base this phase',scope:'friendly-unit',selection:'all',condition:'Exact current incarnation, attack players and own base target; zero damage still qualifies; any arena/exhausted captor; no current-friendly/leader/new-entry targets; preserve owners and supported cleanup'}],
    'enforced-loyalty':[{kind:'defeat',label:'Defeat a chosen friendly unit',scope:'friendly-unit',selection:'chosen',condition:'Either arena including deployed leader; owner destination can differ from controller; prevention is not success'},{kind:'draw',label:'If successfully defeated, draw two',scope:'own-hand',from:'own-deck',amount:2,condition:'Exact prior successful defeat of this incarnation; not disappearance/attempt; short-deck failed draws require actual separate damage receipts'}],
    'endless-legions':[{kind:'inspect',label:'Publicly reveal any number of actual own resources',scope:'resources',selection:'chosen',optional:true,condition:'Zero/non-unit selections legal; exact identity and readiness; no source resourcing'},{kind:'play',label:'Play each legal revealed unit from resources free, one at a time',scope:'friendly-arena',from:'resources',amount:'all legal revealed units',condition:'Chosen order with all normal plays/triggers; resource/aspect costs ignored, other costs remain; no deck replacement or non-unit conversion; resource readiness swap needs actual evidence'}],
    commission:[{kind:'search',label:'Privately search top ten for up to one Bounty Hunter, Item or Transport card; reveal it',scope:'own-deck',amount:10,selection:'chosen',optional:true,condition:'Actual traits, any card type; short/empty deck searches fewer; unchosen searched cards to random bottom, untouched suffix ordered'},{kind:'draw',label:'Draw that selected card',scope:'own-hand',from:'own-deck',amount:1,condition:'Only if selected; no attachment/play/fatigue on empty selection'},{kind:'play',label:'Separate Smuggle route: play from resources for three and one Command',scope:'resources',optional:true,condition:'Actual source resource and exhausted deck-top replacement if available; remove source once; no additional printed hand payment; primary uses normal hand route'}]
};
const labels: Record<string,string> = {
    'evidence-of-the-crime':'Transfer Academy from Wampa to Marine: owner P2, control P1, both hosts survive',
    'fell-the-dragon':'Upgraded Wampa current power 6 qualifies; defeat unit and ordinary Academy, no damage',
    'rivals-fall':'Defeat deployed Vader into owner leader area exhausted; deployment remains spent',
    'remnant-reserves':'Reveal/draw three actual units costing 4+3+2; no combined cost cap; other two to random bottom',
    'palpatines-return':'Event 8; selected Force Kylo from discard costs 6 + 2 + 2 − 8 = 2, enters exhausted; no Rey controlled',
    'spark-of-hope':'Marine was defeated as a unit this phase and has not returned to play; resource it exhausted, event remains discard',
    'rule-with-respect':'Actual earlier legal base attacks by Wampa/TIE; capture both under ready Marine, owners stay P2',
    'enforced-loyalty':'Successful friendly Marine defeat authorizes P1 draw 2; second Command penalty paid',
    'endless-legions':'Pay 16 from 20; reveal Marine, Wampa, X-Wing and Repair; play Marine → X-Wing → Wampa free, end 4/17 without replacement',
    commission:'Normal hand play; select Item upgrade Electrostaff, reveal/draw it without attaching it'
};
export const A05_EXAMPLES: Record<string,{label:string;beats:AbilityBeat[]}> = Object.fromEntries(Object.entries(labels).map(([id,label])=>[id,{label,beats:id==='palpatines-return'?[...A05_ABILITIES[id],{kind:'pay',label:'Pay selected Kylo adjusted cost',scope:'resources',amount:2}]:id==='commission'?A05_ABILITIES[id].slice(0,2):A05_ABILITIES[id]}]));
const supported = new Set(A05_DEFINITIONS.map(d=>d.id));
const card = (id:string,n:string,s:string|null,owner:Seat):CardRef=>({id,n,s,owner});
const unit = (c:CardRef,p:number,h:number,d=0,extra:Partial<UnitRef>={}):UnitRef=>({...c,p,h,d,incarnation:`${c.id}:entry-1`,...extra});
const unknownDeck = (seat:Seat,n:number):CardRef[]=>Array.from({length:n},(_,i)=>card(`a05:${seat}:deck:${i}`,'Unknown card',null,seat));
const resources = (seat:Seat,n:number,ready:number):ResourceRef[]=>Array.from({length:n},(_,i)=>({...card(`a05:${seat}:resource:${i}`,'Unknown card',null,seat),...(i>=ready?{x:1 as const}:{})}));
const facts:Record<string,{cost:number;aspects:PreviewAspect[];kind:'unit'|'leader'|'event'|'upgrade';p?:number;h?:number;arena?:'ground'|'space';force?:true;item?:true;bountyHunter?:true;transport?:true;vehicle?:true;protected?:true}>= {
    SOR_095:{cost:2,aspects:['command','heroism'],kind:'unit',p:3,h:3,arena:'ground'},SOR_098:{cost:3,aspects:['command','heroism'],kind:'unit',p:4,h:3,arena:'ground'},
    SOR_237:{cost:2,aspects:['heroism'],kind:'unit',p:2,h:3,arena:'space',vehicle:true},SOR_033:{cost:3,aspects:['villainy','vigilance'],kind:'unit',p:3,h:3,arena:'ground'},
    SOR_164:{cost:4,aspects:['aggression'],kind:'unit',p:4,h:5,arena:'ground'},SOR_225:{cost:1,aspects:['villainy'],kind:'unit',p:2,h:1,arena:'space',vehicle:true},
    SOR_010:{cost:7,aspects:['aggression','villainy'],kind:'leader',p:5,h:8,arena:'ground',force:true},SOR_005:{cost:6,aspects:['vigilance','heroism'],kind:'leader',p:4,h:7,arena:'ground',force:true},
    SHD_141:{cost:6,aspects:['villainy','aggression'],kind:'unit',p:6,h:7,arena:'ground',force:true},SOR_051:{cost:7,aspects:['vigilance','heroism'],kind:'unit',p:6,h:7,arena:'ground',force:true},
    SHD_120:{cost:5,aspects:['command'],kind:'unit',p:3,h:4,arena:'ground',bountyHunter:true},SEC_099:{cost:4,aspects:['command','heroism'],kind:'unit',p:2,h:5,arena:'space',transport:true,vehicle:true},
    SHD_187:{cost:3,aspects:['cunning','villainy'],kind:'unit',p:2,h:2,arena:'space',vehicle:true,protected:true},
    SOR_071:{cost:2,aspects:['vigilance'],kind:'upgrade',p:2,h:2,item:true},SOR_120:{cost:2,aspects:['command'],kind:'upgrade',p:2,h:2},
    SOR_074:{cost:1,aspects:['vigilance'],kind:'event'},SOR_172:{cost:3,aspects:['aggression'],kind:'event'},SOR_126:{cost:3,aspects:['command'],kind:'event'},SHD_108:{cost:2,aspects:['command','command'],kind:'event'}
};
function fail(message:string):never {throw new Error(`A05: ${message}`);}
function info(c:CardRef){return c.s&&facts[c.s]||fail('unverified selected card face');}
function normalCost(metadata:PreviewCardCost,state:Snapshot,seat:Seat):number {
    const providers:Record<string,PreviewAspect[]>={SOR_024:['command'],SOR_020:['vigilance'],SOR_005:['vigilance','heroism'],SOR_010:['aggression','villainy']};
    const p=state.players[seat],available=[...(p.base.s&&providers[p.base.s]||fail('unverified base provider')),...(p.leader?(p.leader.s&&providers[p.leader.s]||fail('unverified leader provider')):[])];
    return metadata.printed+metadata.aspects.filter(a=>{const i=available.indexOf(a);if(i<0)return true;available.splice(i,1);return false;}).length*2;
}
export interface A05Choices {targetId?:string;hostId?:string;selectedIds?:string[];revealIds?:string[];playIds?:string[];resourceReadySwaps?:Record<string,{readyId:string;exhaustedId:string}>;preventDefeat?:boolean}

export function a05ShowcaseState(definition:CardEffectDefinition):Snapshot|undefined {
    if(!supported.has(definition.id))return undefined;
    const state:Snapshot={round:9,phase:'action',initiative:'p1',players:{
        p1:{name:'Rebel Alliance',base:{...card('a05:p1:base','Echo Base','SOR_024','p1'),hp:30,d:9},leader:{...card('a05:p1:leader','Luke Skywalker: Faithful Friend','SOR_005','p1'),dep:0,x:0},res:{ready:10,total:10},resources:resources('p1',10,10),hand:[card(`a05:${definition.id}:event`,definition.name,definition.setCode,'p1')],deck:27,knownDeck:unknownDeck('p1',27),discard:[],ground:[unit(card('a05:p1:marine','Battlefield Marine','SOR_095','p1'),3,3,1),unit(card('a05:p1:defender','Echo Base Defender','SOR_098','p1'),4,3,0,{sn:1})],space:[unit(card('a05:p1:xwing','Alliance X-Wing','SOR_237','p1'),2,3)]},
        p2:{name:'Galactic Empire',base:{...card('a05:p2:base','Capital City','SOR_020','p2'),hp:30,d:6},leader:{...card('a05:p2:leader','Darth Vader: Dark Lord of the Sith','SOR_010','p2'),dep:0,x:1},res:{ready:7,total:10},resources:resources('p2',10,7),hand:[card('a05:p2:hand:takedown','Takedown','SOR_077','p2')],deck:29,knownDeck:unknownDeck('p2',29),discard:[],ground:[unit(card('a05:p2:trooper','Death Trooper','SOR_033','p2'),3,3),unit(card('a05:p2:wampa','Wampa','SOR_164','p2'),4,5,1)],space:[unit(card('a05:p2:tie','TIE/ln Fighter','SOR_225','p2'),2,1)]}
    }};
    const p1=state.players.p1,p2=state.players.p2;
    const academy=(id:string):UpgradeRef=>({...card(id,'Academy Training','SOR_120','p2'),controller:'p2',t:0,p:2,h:2});
    if(['evidence-of-the-crime','fell-the-dragon'].includes(definition.id)){const w=p2.ground[1];w.u=[academy(definition.id==='fell-the-dragon'?'a05:fell:academy':'a05:evidence:academy')];w.p=6;w.h=7;}
    if(definition.id==='rivals-fall'){p2.leader={...p2.leader!,dep:1,x:0,epic:1};p2.ground.push(unit(card('a05:p2:leader','Darth Vader: Dark Lord of the Sith','SOR_010','p2'),5,8,2));}
    if(definition.id==='remnant-reserves')p1.knownDeck!.splice(0,5,...[['Wampa','SOR_164'],['Repair','SOR_074'],['Echo Base Defender','SOR_098'],['Alliance X-Wing','SOR_237'],['Open Fire','SOR_172']].map(([n,s],i)=>card(`a05:remnant:top:${i}`,n,s,'p1')));
    if(definition.id==='palpatines-return')p1.discard=[card('a05:return:kylo','Kylo Ren: Killing the Past','SHD_141','p1')];
    if(definition.id==='spark-of-hope'){
        const marine=p1.ground.shift()!;p1.discard=[card(marine.id!,marine.n,marine.s,'p1'),card('a05:spark:old','Alliance X-Wing','SOR_237','p1'),card('a05:spark:discarded','Wampa','SOR_164','p1')];
        state.defeatedThisPhase={round:9,phase:'action',cards:[{id:marine.id!,controller:'p2',incarnation:marine.incarnation,lastKnownType:'unit'}]};state.mostRecentIncarnations={[marine.id!]:marine.incarnation!,'a05:spark:old':'a05:spark:old:entry-1'};
    }
    if(definition.id==='rule-with-respect'){
        p1.ground.pop();p2.ground[1].x=1;p2.space[0].x=1;
        state.attacksThisPhase={round:9,phase:'action',attacks:[p2.ground[1],p2.space[0]].map((c,i)=>({id:`a05:respect:attack:${i?'f':'w'}`,attackerId:c.id!,incarnation:c.incarnation!,attackingSeat:'p2',defendingSeat:'p1',targetIds:[p1.base.id!]}))};
    }
    if(definition.id==='enforced-loyalty')p1.knownDeck!.splice(0,2,card('a05:loyalty:draw:0','Repair','SOR_074','p1'),card('a05:loyalty:draw:1','Open Fire','SOR_172','p1'));
    if(definition.id==='endless-legions'){
        p1.res={ready:20,total:20};p1.resources=resources('p1',20,20);
        [['Battlefield Marine','SOR_095'],['Wampa','SOR_164'],['Alliance X-Wing','SOR_237'],['Repair','SOR_074']].forEach(([n,s],i)=>Object.assign(p1.resources![i],{n,s}));
    }
    if(definition.id==='commission')p1.knownDeck!.splice(0,10,...[['Battlefield Marine','SOR_095'],['Repair','SOR_074'],['Open Fire','SOR_172'],['Echo Base Defender','SOR_098'],['Wampa','SOR_164'],['Alliance X-Wing','SOR_237'],['TIE/ln Fighter','SOR_225'],['Enforced Loyalty','SHD_108'],['Electrostaff','SOR_071'],['Resupply','SOR_126']].map(([n,s],i)=>card(`a05:commission:top:${i}`,n,s,'p1')));
    return state;
}
export function a05PreviewPayment(definition:CardEffectDefinition,state:Snapshot,seat:Seat):PreviewPlayPayment|undefined {
    if(!supported.has(definition.id))return undefined;
    const manifest=state.players[seat].resources;if(!manifest)fail('explicit resource payment requires actual resource identities');
    return {kind:'resources',cardIds:manifest.filter(c=>!c.x).slice(0,normalCost(A05_COSTS[definition.id],state,seat)).map(c=>c.id!)};
}
export function a05PreviewOutcomes(definition:CardEffectDefinition,state:Snapshot,seat:Seat,choices:A05Choices={}):CardEffectOutcome[]|undefined {
    if(!supported.has(definition.id))return undefined;
    const foe:Seat=seat==='p1'?'p2':'p1',p=state.players[seat],enemy=state.players[foe];
    const all=(s:Seat)=>[...state.players[s].ground,...state.players[s].space];
    const findUnit=(id:string)=>{for(const s of [seat,foe]){const c=all(s).find(u=>u.id===id);if(c)return {c,seat:s,zone:state.players[s].space.includes(c)?'space' as const:'ground' as const};}return undefined;};
    const required=(id:string)=>{const result=findUnit(id);if(!result?.c.incarnation)fail('missing exact arena incarnation');return result;};
    const m=all(seat).find(c=>c.id==='a05:p1:marine'),w=all(foe).find(c=>c.id==='a05:p2:wampa');
    const source=p.hand.find(c=>c.s===definition.setCode);if(!source?.id)fail('missing source event');
    const outcomes:CardEffectOutcome[]=[];
    const add=(kind:CardEffectOutcome['kind'],c:CardRef|null|undefined,s:Seat,amount:number|string|undefined,zone:NonNullable<CardEffectOutcome['zone']>,label:string,extra:Partial<CardEffectOutcome>={})=>outcomes.push({kind,card:c,seat:s,amount,zone,label,...extra});
    const defeat=(id:string,label:string,prevented=false)=>{const target=required(id);if(target.c.cap?.length)fail('departing captor needs separately authored cleanup');add('defeat',target.c,target.seat,1,'discard',label,{fromSeat:target.seat,fromZone:target.zone,ownerSeat:target.c.owner,incarnation:target.c.incarnation,prevented});return target;};
    const deck=()=>{if(!p.knownDeck||p.knownDeck.length!==p.deck)fail('complete known deck required');return p.knownDeck;};
    const paidEvent=normalCost(A05_COSTS[definition.id],state,seat);
    const play=(c:CardRef,origin:'discard'|'resources',price:number,incarnation:string,extra:Partial<CardEffectOutcome>={})=>{
        const f=info(c);if(f.kind!=='unit'||f.p===undefined||f.h===undefined||!f.arena)fail('selected play must have supported actual unit facts');
        add('play',c,seat,1,f.arena,`${origin.toUpperCase()} PLAY · PAID ${price} · EXHAUSTED`,{fromSeat:seat,fromZone:origin,ownerSeat:c.owner,entersReady:false,entryType:'played',printedCost:f.cost,unit:unit(c,f.p,f.h,0,{x:1,incarnation}),...extra});
    };
    switch(definition.id){
        case 'evidence-of-the-crime':{
            const old=required('a05:p2:wampa'),upgrade=old.c.u?.find(u=>u.id==='a05:evidence:academy'),target=required(choices.hostId??'a05:p1:marine');if(!upgrade)fail('actual upgrade absent');
            const f=info(upgrade);if(f.kind!=='upgrade'||f.cost>3||upgrade.p===undefined||upgrade.h===undefined)fail('upgrade cost/contributions not eligible');
            add('attach',upgrade,target.seat,1,target.zone,'OWNER P2 · CONTROL P1 · HOSTS STAY',{sourceCard:old.c,targetCard:target.c,fromSeat:old.seat,fromZone:old.zone,ownerSeat:upgrade.owner,controllerSeat:seat,upgrade:{...upgrade,controller:seat},printedCost:f.cost});break;
        }
        case 'fell-the-dragon':{
            const target=required(choices.targetId??w?.id??'missing');if(info(target.c).kind!=='unit'||target.c.p<5)fail('non-leader current power must be at least five');defeat(target.c.id!,`POWER ${target.c.p} ≥ 5 · NON-LEADER`);break;
        }
        case 'rivals-fall':{
            const target=required(choices.targetId??enemy.leader?.id??'missing'),owner=target.c.owner!;
            if(target.c.cap?.length)fail('departing captor needs separately authored cleanup');
            if(state.players[owner].leader?.id===target.c.id){const leader=state.players[owner].leader!;if(!leader.dep)fail('target leader is not deployed');add('defeat',target.c,target.seat,1,'leader','LEADER DEFEATED · UNDEPLOYED',{fromSeat:target.seat,fromZone:target.zone,ownerSeat:owner,incarnation:target.c.incarnation,leader:{...leader,dep:0,x:1}});}else defeat(target.c.id!,'UNIT DEFEATED');break;
        }
        case 'remnant-reserves':case 'commission':{
            const manifest=deck(),count=definition.id==='commission'?10:5,looked=manifest.slice(0,count);if(!looked.length)break;
            const chosenIds=choices.selectedIds??(definition.id==='commission'?['a05:commission:top:8']:['a05:remnant:top:0','a05:remnant:top:2','a05:remnant:top:3']),limit=definition.id==='commission'?1:3;
            if(chosenIds.length>limit||new Set(chosenIds).size!==chosenIds.length)fail('invalid selected-card count');
            const selected=chosenIds.map(id=>looked.find(c=>c.id===id)??fail('selection outside actual looked prefix'));
            if(selected.some(c=>{const f=info(c);return definition.id==='commission'?!(f.item||f.bountyHunter||f.transport):f.kind!=='unit';}))fail('selected cards fail actual trait/type filter');
            const unchosen=looked.filter(c=>!chosenIds.includes(c.id!)).toReversed();
            add('search',selected.length===1?selected[0]:null,seat,looked.length,'deck','PRIVATE SEARCH · REVEAL ONLY SELECTED',{cards:looked,chooserSeat:seat,deckOperation:{scope:'top',visibility:'private',policy:'top-search-bottom',looked,selectedIds:[...chosenIds],revealedIds:[...chosenIds],selectionLimit:limit,remainingOrder:[...selected,...manifest.slice(looked.length),...unchosen]}});
            if(selected.length)add('draw',selected.length===1?selected[0]:null,seat,selected.length,'hand',`REVEALED SELECTIONS · DRAW ${selected.length}`,{cards:selected,fromSeat:seat,fromZone:'deck'});break;
        }
        case 'palpatines-return':{
            const selected=p.discard.find(c=>c.id===(choices.targetId??'a05:return:kylo'));if(!selected)break;const f=info(selected);if(!['SHD_141','SOR_164'].includes(selected.s??''))fail('other discard plays need separately authored entry/static effects');
            const reduction=f.force?8:6,price=Math.max(0,normalCost({printed:f.cost,aspects:f.aspects},state,seat)-reduction);
            add('cost',selected,seat,-reduction,'resources',`${f.force?'SELECTED FORCE':'SELECTED NON-FORCE'} · −${reduction}`,{sourceCard:selected,printedCost:f.cost});
            add('pay',selected,seat,price,'resources',`UNIT PAID ${price}`,{sourceCard:selected,cards:p.resources?.filter(c=>!c.x).slice(paidEvent,paidEvent+price)});
            play(selected,'discard',price,`${selected.id}:entry-2`);break;
        }
        case 'spark-of-hope':{
            const history=state.defeatedThisPhase;if(!history||history.round!==state.round||history.phase!==state.phase)break;
            const selected=p.discard.find(c=>c.id===(choices.targetId??'a05:p1:marine'));if(!selected||info(selected).kind!=='unit')break;
            const incarnation=state.mostRecentIncarnations?.[selected.id!];if(!incarnation||!history.cards.some(c=>c.id===selected.id&&c.incarnation===incarnation&&c.lastKnownType==='unit'))break;
            add('resource',selected,seat,1,'resources','MARINE RESOURCED · EXHAUSTED',{fromSeat:seat,fromZone:'discard',ownerSeat:selected.owner,incarnation,defeatPhase:{round:state.round,phase:state.phase},entersReady:false});break;
        }
        case 'rule-with-respect':{
            const captor=required(choices.hostId??m?.id??'missing');if(captor.seat!==seat)fail('captor must be friendly');const history=state.attacksThisPhase;if(!history||history.round!==state.round||history.phase!==state.phase)break;
            const captured=new Set<string>();
            for(const attack of history.attacks){const target=findUnit(attack.attackerId);if(!target||target.seat===seat||info(target.c).kind!=='unit'||info(target.c).protected||target.c.incarnation!==attack.incarnation||attack.attackingSeat===seat||!attack.attackingSeat||attack.defendingSeat!==seat||!attack.targetIds?.includes(p.base.id!))continue;
                if(captured.has(target.c.id!))continue;if(target.c.cap?.length)fail('nested captive cleanup needs separate supplied results');captured.add(target.c.id!);
                add('capture',target.c,seat,1,captor.zone,'BASE ATTACK WITNESSED · CAPTURED',{sourceCard:captor.c,fromSeat:target.seat,fromZone:target.zone,ownerSeat:target.c.owner,incarnation:target.c.incarnation,captureBasis:{round:state.round,phase:state.phase,attackId:attack.id,attackerId:target.c.id!,incarnation:attack.incarnation,attackingSeat:attack.attackingSeat,defendingSeat:seat,targetId:p.base.id!}});
            }break;
        }
        case 'enforced-loyalty':{
            if(!m)break;if(choices.preventDefeat)fail('prevented Loyalty requires a separately supplied protected fixture');const target=defeat(m.id!,'FRIENDLY UNIT DEFEATED');const drawn=deck().slice(0,2);if(drawn.length<2)fail('short draws require explicit failed-draw damage');
            add('draw',null,seat,2,'hand','SUCCESSFUL DEFEAT · P1 DRAWS 2',{cards:drawn,fromSeat:seat,fromZone:'deck',requiresDefeat:{id:target.c.id!,incarnation:target.c.incarnation!}});break;
        }
        case 'endless-legions':{
            const manifest=p.resources;if(!manifest||manifest.length!==p.res.total)fail('actual resource manifest required');
            const revealIds=choices.revealIds??[0,1,2,3].map(i=>`a05:p1:resource:${i}`),revealed=revealIds.map(id=>manifest.find(c=>c.id===id)??fail('revealed resource absent'));
            if(revealed.some(c=>!c.s||!facts[c.s]))fail('authored public resource reveal requires actual verified faces');
            const playIds=choices.playIds??[0,2,1].map(i=>`a05:p1:resource:${i}`);if(new Set(revealIds).size!==revealIds.length||new Set(playIds).size!==playIds.length||playIds.some(id=>!revealIds.includes(id)))fail('invalid resource reveal/play selections');
            if(revealed.filter(c=>c.s&&facts[c.s]?.kind==='unit').some(c=>!playIds.includes(c.id!)))fail('still-legal revealed primary units must be played');
            add('inspect',null,seat,revealed.length,'resources','PUBLIC RESOURCE REVEAL',{cards:revealed,fromSeat:seat,fromZone:'resources',visibility:'public',resourceReveal:{playIds}});
            for(const id of playIds){const c=revealed.find(c=>c.id===id)!;if(!['SOR_095','SOR_164','SOR_237'].includes(c.s??''))fail('primary resource plays require authored trigger-free units');add('pay',c,seat,0,'resources','UNIT PAID 0 · FREE',{sourceCard:c,cards:[]});play(c,'resources',0,`${c.id}:entry-1`,{resourceReadySwap:choices.resourceReadySwaps?.[id]});}break;
        }
    }
    return outcomes;
}
