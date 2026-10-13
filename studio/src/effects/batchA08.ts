import type { CardRef, ResourceRef, Seat, Snapshot, UnitRef, UpgradeRef } from '../data/types';
import type { AbilityBeat } from './abilities';
import type { PreviewAspect, PreviewCardCost } from './previewCosts';
import type { CardEffectDefinition, CardEffectOutcome, PreviewPlayPayment } from './types';

/** Verified theatre fixtures and declared receipts; recorded matches never call this module. */
export const A08_DEFINITIONS: CardEffectDefinition[] = [
    { id:'surprise-strike',name:'Surprise Strike',setCode:'SHD_231',family:'tactics',color:'#ecc68e',visual:'surprise-strike',durationMs:5000,description:'One ready unit attacks at three extra power for that attack; actual counterdamage and departures remain distinct.' },
    { id:'relentless-pursuit',name:'Relentless Pursuit',setCode:'SHD_232',family:'tactics',color:'#b7cc9f',visual:'relentless-pursuit',durationMs:5600,description:'A friendly unit captures an enemy of no greater printed cost; a Bounty Hunter receives an independent Shield.' },
    { id:'evacuate',name:'Evacuate',setCode:'SHD_233',family:'tactics',color:'#b1d7df',visual:'evacuate',durationMs:5400,description:'Every non-leader in both arenas returns to its real owner’s hand; deployed leaders stay anchored.' },
    { id:'altering-the-deal',name:'Altering the Deal',setCode:'SHD_243',family:'tactics',color:'#d5a4b4',visual:'altering-the-deal',durationMs:4600,description:'One actual captive leaves a friendly guard’s pocket for its owner’s discard, while the guard stays intact.' },
    { id:'no-bargain',name:'No Bargain',setCode:'SHD_244',family:'tactics',color:'#d9b995',visual:'no-bargain',durationMs:4400,description:'Each opponent chooses a hand discard while the event controller draws one actual card.' },
    { id:'smugglers-aid',name:"Smuggler's Aid",setCode:'SHD_252',family:'support',color:'#93d5b8',visual:'smugglers-aid',durationMs:5000,description:'Heal three from your base; resource-origin Smuggle has its separate cost and exhausted private deck replacement.' },
    { id:'this-is-the-way',name:'This Is The Way',setCode:'SHD_253',family:'support',color:'#bdd0da',visual:'this-is-the-way',durationMs:5400,description:'Privately inspect eight; reveal and draw up to two Mandalorian or upgrade cards, sending unchosen cards to random bottom.' },
    { id:'confiscate',name:'Confiscate',setCode:'SHD_262',family:'tactics',color:'#c6bd9e',visual:'confiscate',durationMs:4200,description:'Defeat one actual upgrade and retain its host unless a separately witnessed consequence defeats it.' },
    { id:'a-fine-addition',name:'A Fine Addition',setCode:'TWI_040',family:'support',color:'#b2bfde',visual:'a-fine-addition',durationMs:5600,description:'After an enemy unit’s defeat this phase, pay to play an upgrade from own hand or any discard, ignoring its aspect penalties.' },
    { id:'lethal-crackdown',name:'Lethal Crackdown',setCode:'TWI_041',family:'tactics',color:'#df9796',visual:'lethal-crackdown',durationMs:5200,description:'Successful non-leader defeat seals its actual power before cleanup; that much damage reaches your own base.' }
];
export const A08_COSTS: Record<string,PreviewCardCost> = {
    'surprise-strike':{printed:2,aspects:['cunning']},'relentless-pursuit':{printed:3,aspects:['cunning']},evacuate:{printed:6,aspects:['cunning']},
    'altering-the-deal':{printed:1,aspects:['villainy']},'no-bargain':{printed:3,aspects:['villainy']},
    'smugglers-aid':{printed:1,aspects:['heroism'],smuggle:{printed:3,aspects:['heroism']}},'this-is-the-way':{printed:2,aspects:['heroism']},
    confiscate:{printed:1,aspects:[]},'a-fine-addition':{printed:0,aspects:['vigilance','villainy']},'lethal-crackdown':{printed:4,aspects:['vigilance','villainy']}
};
export const A08_ABILITIES: Record<string,AbilityBeat[]> = {
    'surprise-strike':[{kind:'attack',label:'Attack with a ready friendly unit if able',scope:'friendly-unit',condition:'Either arena/deployed leader; legal targets, Sentinel and actual entry/attack abilities; base has no counterdamage, defender deals simultaneous combat even when defeated'},{kind:'buff',label:'That unit gets +3/+0 only for this attack',scope:'friendly-unit',amount:'+3/+0',duration:'attack',condition:'No readying or lasting power/status; actual Shield prevention remains separate'}],
    'relentless-pursuit':[{kind:'capture',label:'Friendly unit captures an enemy non-leader of no greater printed cost',scope:'friendly-unit',selection:'chosen',condition:'Any friendly unit including deployed leader/either arena; cross-arena permitted, compare printed costs not modified stats; actual ordinary departure/Bounty/captive cleanup'},{kind:'shield',label:'If the chosen friendly unit is a Bounty Hunter, give it a Shield',scope:'friendly-unit',amount:1,condition:'Independent conditional even with no legal capture or actual prevented capture; no fabricated base-attack history'}],
    evacuate:[{kind:'return',label:'Return every non-leader in both arenas to its owner hand',scope:'all-units',selection:'all',condition:'Both sides/arenas, exclude deployed leaders; ordinary upgrades to owner discard/tokens cease; supported captive/pilot cleanup, newly rescued arrivals not original targets; no draw/heal/defeat'}],
    'altering-the-deal':[{kind:'discard',label:'Discard one actual captive guarded by a friendly unit',scope:'target',selection:'chosen',condition:'Either arena, current guard friendly; actual captive owner receives discard; no arena defeat/rescue/play/Bounty or guard removal'}],
    'no-bargain':[{kind:'discard',label:'Each opponent chooses one card from their own hand to discard',scope:'enemy-hand',amount:1,selection:'opponent',condition:'Not random or event-controller selection; empty opposing hand skips discard without preventing draw'},{kind:'draw',label:'Draw one actual card simultaneously',scope:'own-hand',from:'own-deck',amount:1,condition:'Independent of successful discard; actual empty-deck consequences are separate'}],
    'smugglers-aid':[{kind:'heal',label:'Heal up to three existing damage from your base',scope:'friendly-base',amount:3,condition:'Own base only; zero existing damage means no healing/max-HP increase'},{kind:'cost',label:'Normal hand cost one; optional resource-origin Smuggle cost three Heroism',scope:'resources',amount:'1 hand / 3 Smuggle',optional:true,condition:'Exact actual resource source, alternate cost/aspects and exhaustion rearrangement; departing source becomes exhausted, event goes discard once'},{kind:'resource',label:'When using Smuggle, replace source with actual deck top as exhausted resource',scope:'resources',from:'own-deck',amount:1,condition:'Private, no hand/draw/unit-entry waypoint; replacement only if deck nonempty, total preserved then; empty deck loses one resource'}],
    'this-is-the-way':[{kind:'search',label:'Search top eight privately for up to two Mandalorian and/or upgrade cards',scope:'own-deck',amount:8,selection:'chosen',optional:true,condition:'Mandalorian trait OR actual upgrade card type; zero/one/two, two of same category legal; short deck; Piloting unit alone not an upgrade in deck'},{kind:'draw',label:'Reveal and draw only chosen cards; unchosen searched cards to random bottom',scope:'own-hand',from:'own-deck',amount:'up to 2',condition:'Untouched suffix ordered; exact selection/permutation/visibility, no automatic play'}],
    confiscate:[{kind:'defeat',label:'Defeat any actual upgrade on either side/arena',scope:'target',selection:'chosen',condition:'Ordinary card to actual owner discard, upgrade tokens cease; preserve host and other attachments unless separately supported HP-loss defeat; pilot/leader destination needs distinct actual cleanup'}],
    'a-fine-addition':[{kind:'play',label:'If an enemy unit was defeated this phase, play an upgrade from own hand or any discard',scope:'target',condition:'Current-phase last-known unit/leader-unit and enemy controller; no own-defeater/latest-entry/discard requirement; never opponent hand; actual cost/additional restrictions/legal host; Piloting upgrade mode uses Piloting cost'},{kind:'cost',label:'Ignore all selected upgrade aspect penalties',scope:'resources',condition:'Event own aspects/cost unchanged; not free, preserve owner versus playing controller, no transfer of existing attachment'}],
    'lethal-crackdown':[{kind:'defeat',label:'Defeat any non-leader unit',scope:'target',selection:'chosen',condition:'Friendly/enemy/either arena, no HP/cost limit; successful actual departure required, ordinary owner cleanup and supported triggers'},{kind:'damage',label:'If successfully defeated, damage your base for its last-known power',scope:'friendly-base',amount:'actual departed power',condition:'Seal before removing upgrades including phase modifiers; not print/post-cleanup power; zero valid, failed/prevented defeat cannot authorize damage; no combat'}]
};
const labels:Record<string,string>={
    'surprise-strike':'Pay 4; Marine attacks at 6, Death Trooper counters 3; both reach their owner discards',
    'relentless-pursuit':'Pay 5; exhausted Toro captures printed cost 3 Death Trooper; Academy to P1 discard, Toro gains independent Shield',
    evacuate:'Pay 8; six non-leaders return to two owner hands; Academy leaves, deployed Vader stays scarred and exhausted',
    'altering-the-deal':'Pay 3; actual Wampa captive leaves X-Wing pocket for owner P2 discard; guard stays ready',
    'no-bargain':'Pay 5; P2 chooses Takedown discard while P1 draws actual top Repair',
    'smugglers-aid':'Smuggle 3 from actual exhausted resource; private deck replacement stays exhausted; base damage 9 → 6',
    'this-is-the-way':'Pay 2; private top 8 reveals and draws Sabine plus Devotion; six unchosen to random bottom',
    confiscate:'Pay 1; defeat owner P1 Academy on enemy Wampa, 6/7 → 4/5; damage and original Shield stay',
    'a-fine-addition':'Enemy unit defeated this phase; event 2, Armor pay 2 with Cunning penalty ignored; owner P2, playing controller P1',
    'lethal-crackdown':'Pay 6; defeat Wampa at actual power 7 before Academy cleanup, then own base damage 9 → 16'
};
const chosen:Record<string,AbilityBeat[]>={
    'smugglers-aid':[{kind:'cost',label:'Use explicit resource-origin Smuggle cost three',scope:'resources',amount:3},{kind:'resource',label:'Actual private deck top replaces spent source exhausted',scope:'resources',from:'own-deck',amount:1},A08_ABILITIES['smugglers-aid'][0]],
    'this-is-the-way':[A08_ABILITIES['this-is-the-way'][0],{kind:'draw',label:'Reveal and draw actual Sabine and Devotion',scope:'own-hand',from:'own-deck',amount:2}],
    'a-fine-addition':[A08_ABILITIES['a-fine-addition'][1],{kind:'pay',label:'Pay actual Armor printed cost two, ignoring its missing Cunning penalty',scope:'resources',amount:2},A08_ABILITIES['a-fine-addition'][0]],
    'lethal-crackdown':[A08_ABILITIES['lethal-crackdown'][0],{kind:'damage',label:'Actual successful departed power seven damages own base',scope:'friendly-base',amount:7}]
};
export const A08_EXAMPLES:Record<string,{label:string;beats:AbilityBeat[]}>=Object.fromEntries(Object.entries(labels).map(([id,label])=>[id,{label,beats:chosen[id]??A08_ABILITIES[id]}]));
const supported=new Set(A08_DEFINITIONS.map(d=>d.id));
const card=(id:string,n:string,s:string|null,owner:Seat):CardRef=>({id,n,s,owner});
const unit=(c:CardRef,p:number,h:number,d=0,extra:Partial<UnitRef>={}):UnitRef=>({...c,p,h,d,incarnation:`${c.id}:entry-1`,...extra});
const resourceCards=(seat:Seat,n:number,ready:number):ResourceRef[]=>Array.from({length:n},(_,i)=>({...card(`a08:${seat}:resource:${i}`,'Unknown card',null,seat),...(i>=ready?{x:1 as const}:{})}));
const deck=(seat:Seat,n:number):CardRef[]=>Array.from({length:n},(_,i)=>card(`a08:${seat}:deck:${i}`,'Unknown card',null,seat));
const academy=(id:string,owner:Seat):UpgradeRef=>({...card(id,'Academy Training','SOR_120',owner),controller:owner,t:0,p:2,h:2});
function fail(s:string):never{throw new Error(`A08: ${s}`);}
const faceCosts:Record<string,number>={SOR_095:2,SOR_098:3,SOR_237:2,SOR_033:3,SHD_030:3,SEC_030:3,SOR_164:4,LOF_164:4,SOR_225:1,SHD_239:3,SOR_005:6,SOR_010:7};
function price(meta:Pick<PreviewCardCost,'printed'|'aspects'>,s:Snapshot,seat:Seat):number{
    const p=s.players[seat],providers:Record<string,PreviewAspect[]>={SOR_024:['command'],SOR_020:['vigilance'],SOR_005:['vigilance','heroism'],SOR_010:['aggression','villainy']};
    const available=[...(p.base.s&&providers[p.base.s]||fail('unverified base')),...(p.leader?(p.leader.s&&providers[p.leader.s]||fail('unverified leader')):[])];
    return meta.printed+meta.aspects.filter(a=>{const i=available.indexOf(a);if(i<0)return true;available.splice(i,1);return false;}).length*2;
}
export function a08ShowcaseState(d:CardEffectDefinition):Snapshot|undefined{
    if(!supported.has(d.id))return undefined;
    const s:Snapshot={round:10,phase:'action',initiative:'p1',players:{
        p1:{name:'Rebel Alliance',base:{...card('a08:p1:base','Echo Base','SOR_024','p1'),hp:30,d:9},leader:{...card('a08:p1:leader','Luke Skywalker: Faithful Friend','SOR_005','p1'),dep:0,x:0},res:{ready:12,total:12},resources:resourceCards('p1',12,12),hand:[card(`a08:${d.id}:event`,d.name,d.setCode,'p1')],deck:27,knownDeck:deck('p1',27),discard:[],ground:[unit(card('a08:p1:marine','Battlefield Marine','SOR_095','p1'),3,3,1),unit(card('a08:p1:defender','Echo Base Defender','SOR_098','p1'),4,3,0,{sn:1})],space:[unit(card('a08:p1:xwing','Alliance X-Wing','SOR_237','p1'),2,3)]},
        p2:{name:'Galactic Empire',base:{...card('a08:p2:base','Capital City','SOR_020','p2'),hp:30,d:6},leader:{...card('a08:p2:leader','Darth Vader: Dark Lord of the Sith','SOR_010','p2'),dep:0,x:1},res:{ready:7,total:10},resources:resourceCards('p2',10,7),hand:[card('a08:p2:hand:takedown','Takedown','SOR_077','p2'),card('a08:p2:hand:repair','Repair','SOR_074','p2')],deck:29,knownDeck:deck('p2',29),discard:[],ground:[unit(card('a08:p2:trooper','Death Trooper','SOR_033','p2'),3,3,1),unit(card('a08:p2:wampa','Wampa','SOR_164','p2'),4,5,1)],space:[unit(card('a08:p2:tie','TIE/ln Fighter','SOR_225','p2'),2,1)]}
    }},p=s.players.p1,q=s.players.p2;
    switch(d.id){
        case 'relentless-pursuit':p.ground[1]=unit(card('a08:pursuit:toro','Toro Calican: Ambitious Upstart','SHD_239','p1'),3,5,1,{x:1,cap:[]});q.ground[0].u=[academy('a08:pursuit:academy','p1')];q.ground[0].p=5;q.ground[0].h=5;break;
        case 'evacuate':q.space[0].u=[academy('a08:evacuate:academy','p1')];q.space[0].p=4;q.space[0].h=3;q.leader!.dep=1;q.leader!.epic=1;q.ground.push(unit(q.leader!,5,8,2,{x:1}));break;
        case 'altering-the-deal':p.space[0].cap=[card('a08:deal:captive','Wampa','SOR_164','p2')];break;
        case 'no-bargain':p.knownDeck![0]=card('a08:no-bargain:draw','Repair','SOR_074','p1');break;
        case 'smugglers-aid':p.resources![11]={...p.hand.pop()!,x:1};p.res.ready=11;p.knownDeck![0]=card('a08:aid:replacement','Battlefield Marine','SOR_095','p1');break;
        case 'this-is-the-way':p.knownDeck!.splice(0,8,...[['Battlefield Marine','SOR_095'],['Sabine Wren: Explosives Artist','SOR_142'],['Repair','SOR_074'],['Devotion','SOR_070'],['Wampa','SOR_164'],['Alliance X-Wing','SOR_237'],['Open Fire','SOR_172'],['Resupply','SOR_126']].map(([n,code],i)=>card(`a08:way:top:${i}`,n,code,'p1')));break;
        case 'confiscate':q.ground[1].u=[academy('a08:confiscate:academy','p1'),{...card('a08:confiscate:shield','Shield',null,'p2'),t:1,p:0,h:0}];q.ground[1].p=6;q.ground[1].h=7;break;
        case 'a-fine-addition':{const f=q.space.pop()!;q.discard.push(card(f.id!,f.n,f.s,'p2'),card('a08:addition:armor',"Boba Fett's Armor",'SHD_224','p2'));s.defeatedThisPhase={round:10,phase:'action',cards:[{id:f.id!,incarnation:f.incarnation,controller:'p2',lastKnownType:'unit'}]};break;}
        case 'lethal-crackdown':q.ground[1].u=[academy('a08:crackdown:academy','p1')];q.ground[1].p=7;q.ground[1].h=7;q.ground[1].status=[{kind:'buff',label:'Power from Pain +1/+0 · phase',duration:'phase'}];q.discard.push(card('a08:crackdown:prior-pain','Power from Pain','JTL_042','p2'));break;
    }
    return s;
}
export function a08PreviewSource(d:CardEffectDefinition,s:Snapshot,seat:Seat):CardRef|undefined{
    if(!supported.has(d.id))return undefined;
    const matches=[...s.players[seat].hand,...(s.players[seat].resources??[])].filter(c=>c.id===`a08:${d.id}:event`);
    if(matches.length!==1||matches[0].s!==d.setCode||matches[0].n!==d.name)return fail('exact actual source missing or ambiguous');
    return matches[0];
}
export interface A08Choices {targetId?:string;captorId?:string;capture?:boolean;preventCapture?:boolean;upgradeId?:string;discardId?:string;selectedIds?:string[];sourceMode?:'hand'|'smuggle';attackTargetId?:string}
export function a08PreviewPayment(d:CardEffectDefinition,s:Snapshot,seat:Seat,choices:A08Choices={}):PreviewPlayPayment|undefined{
    if(!supported.has(d.id))return undefined;
    const source=a08PreviewSource(d,s,seat)!,p=s.players[seat],manifest=p.resources??fail('actual resource manifest required'),smuggle=d.id==='smugglers-aid'&&(choices.sourceMode??'smuggle')==='smuggle';
    if(smuggle&&!manifest.some(c=>c.id===source.id)||!smuggle&&!p.hand.some(c=>c.id===source.id))fail('explicit selected source mode contradicts actual origin');
    const cost=price(smuggle?A08_COSTS[d.id].smuggle!:A08_COSTS[d.id],s,seat),paid=manifest.filter(c=>!c.x).slice(0,cost);
    if(paid.length!==cost)fail('source payment unaffordable');
    const payment:PreviewPlayPayment={kind:'resources',cardIds:paid.map(c=>c.id!)};
    if(smuggle){const after=structuredClone(manifest);for(const c of after)if(paid.some(x=>x.id===c.id))c.x=1;
        const actual=after.find(c=>c.id===source.id)!;if(!actual.x){const swapped=after.find(c=>c.x)!;delete swapped.x;actual.x=1;}
        payment.smuggle={sourceId:source.id!,resourcesAfterPayment:after};
    }
    return payment;
}
export function a08PreviewOutcomes(d:CardEffectDefinition,s:Snapshot,seat:Seat,choices:A08Choices={}):CardEffectOutcome[]|undefined{
    if(!supported.has(d.id))return undefined;
    const foe:Seat=seat==='p1'?'p2':'p1',p=s.players[seat],q=s.players[foe],source=a08PreviewSource(d,s,seat)!,out:CardEffectOutcome[]=[];
    const add=(kind:CardEffectOutcome['kind'],c:CardRef|null,side:Seat,amount:number|string|undefined,zone:NonNullable<CardEffectOutcome['zone']>,label:string,extra:Partial<CardEffectOutcome>={})=>out.push({kind,card:structuredClone(c),seat:side,amount,zone,label,...structuredClone(extra)});
    const find=(id:string)=>{for(const side of [seat,foe])for(const zone of ['ground','space'] as const){const c=s.players[side][zone].find(c=>c.id===id);if(c)return{c,seat:side,zone};}return undefined;};
    const req=(id:string)=>find(id)??fail('actual arena subject absent');
    const nonleader=(t:ReturnType<typeof req>)=>t.c.id!==s.players[t.c.owner??t.seat].leader?.id;
    const nested=(c:CardRef,amount:number)=>{const sourceCost=price(A08_COSTS[d.id],s,seat),cards=p.resources!.filter(c=>!c.x).slice(sourceCost,sourceCost+amount);if(cards.length!==amount)fail('nested payment unaffordable');add('pay',null,seat,amount,'resources',`UPGRADE PAID ${amount}`,{sourceCard:c,cards});};
    switch(d.id){
        case 'surprise-strike':{const a=req(choices.targetId??'a08:p1:marine'),t=find(choices.attackTargetId??'a08:p2:trooper'),base=q.base.id===choices.attackTargetId?q.base:undefined,id='a08:surprise:attack';
            if(a.seat!==seat||a.c.x||!t&&!base||t&&(t.seat===seat||t.zone!==a.zone)||t?.c.u?.some(u=>u.n==='Shield'))fail('supported ready legal unshielded attack required');
            if(t&&s.players[foe][a.zone].some(c=>c.sn)&&!t.c.sn)fail('Sentinel forbids target');
            const target=t?.c??base!,power=Math.max(0,a.c.p+3);
            add('buff',a.c,seat,'+3/+0',a.zone,'+3 POWER · THIS ATTACK',{duration:'attack',attackId:id,attackRole:'attacker'});
            add('attack',target,t?.seat??foe,1,t?.zone??'base','ONE BOOSTED ATTACK',{sourceCard:a.c,attackId:id,combatOrder:'simultaneous'});
            add('exhaust',a.c,seat,1,a.zone,'ATTACKER EXHAUSTS',{attackId:id});
            add('damage',target,t?.seat??foe,power,t?.zone??'base',`FORWARD ${power}`,{sourceCard:a.c,damageType:'combat',attackId:id,attackIndex:1});
            if(t&&t.c.d+power>=t.c.h)add('defeat',t.c,t.seat,1,'discard','DEFENDER TO OWNER DISCARD',{ownerSeat:t.c.owner,incarnation:t.c.incarnation,attackId:id});
            if(t){const counter=Math.max(0,t.c.p);add('damage',a.c,seat,counter,a.zone,`COUNTER ${counter}`,{sourceCard:t.c,damageType:'combat',attackId:id,attackIndex:2});if(a.c.d+counter>=a.c.h)add('defeat',a.c,seat,1,'discard','ATTACKER TO OWNER DISCARD',{ownerSeat:a.c.owner,incarnation:a.c.incarnation,attackId:id});}
            break;
        }
        case 'relentless-pursuit':{const c=req(choices.captorId??'a08:pursuit:toro'),cost=c.c.s?faceCosts[c.c.s]:undefined;if(c.seat!==seat||cost===undefined)fail('actual friendly captor with verified printed cost required');
            if(choices.capture!==false){const t=req(choices.targetId??'a08:p2:trooper'),tc=t.c.s?faceCosts[t.c.s]:undefined;if(t.seat===seat||!nonleader(t)||tc===undefined||tc>cost)fail('enemy nonleader printed cost must not exceed captor');add('capture',t.c,seat,1,c.zone,`PRINTED ${tc} ≤ ${cost} · CAPTURE`,{sourceCard:c.c,fromSeat:t.seat,fromZone:t.zone,ownerSeat:t.c.owner,incarnation:t.c.incarnation,captureCost:{captorPrintedCost:cost,targetPrintedCost:tc},...(choices.preventCapture?{prevented:true}:{})});}
            else if([...q.ground,...q.space].some(x=>x.id!==q.leader?.id&&x.s&&faceCosts[x.s]!==undefined&&faceCosts[x.s]<=cost))fail('capture cannot be declined when a legal target remains');
            if(c.c.s==='SHD_239')add('shield',c.c,seat,1,c.zone,'BOUNTY HUNTER · SHIELD',{sourceCard:c.c,incarnation:c.c.incarnation,cards:[card('a08:pursuit:shield','Shield',null,seat)]});break;
        }
        case 'evacuate':for(const side of [seat,foe])for(const zone of ['ground','space'] as const)for(const c of s.players[side][zone]){if(c.id===s.players[c.owner??side].leader?.id)continue;if(c.cap?.length)fail('captor return needs declared rescue cleanup');add('return',c,c.owner??fail('owner required'),1,'hand','EVACUATE TO OWNER HAND',{fromSeat:side,fromZone:zone,ownerSeat:c.owner,incarnation:c.incarnation,selection:'all',resolutionGroup:{id:'a08:evacuate:return',mode:'simultaneous'}});}break;
        case 'altering-the-deal':{const guard=req(choices.captorId??'a08:p1:xwing'),captives=guard.c.cap??[],c=captives.find(c=>c.id===(choices.targetId??'a08:deal:captive'));if(guard.seat!==seat||!c?.owner)fail('exact captive under friendly guard and actual owner required');add('discard',c,c.owner,1,'discard','CAPTIVE TO OWNER DISCARD',{sourceCard:guard.c,fromSeat:guard.seat,fromZone:'capture',ownerSeat:c.owner,selection:'chosen',chooserSeat:seat});break;}
        case 'no-bargain':{const c=q.hand.find(c=>c.id===(choices.discardId??'a08:p2:hand:takedown'));if(q.hand.length&&!c)fail('actual opposing hand choice required');const group={id:'a08:no-bargain:resolution',mode:'simultaneous' as const};if(c)add('discard',c,foe,1,'discard','P2 CHOOSES HAND DISCARD',{fromSeat:foe,fromZone:'hand',ownerSeat:c.owner,chooserSeat:foe,selection:'opponent',resolutionGroup:group});const top=p.knownDeck?.[0]??fail('empty-deck draw needs separate actual exhaustion damage');add('draw',top,seat,1,'hand','P1 DRAWS ACTUAL TOP',{cards:[top],fromSeat:seat,fromZone:'deck',resolutionGroup:group});break;}
        case 'smugglers-aid':{const payment=a08PreviewPayment(d,s,seat,choices)!;if(payment.kind==='resources'&&payment.smuggle){const top=p.knownDeck?.[0];if(top)add('resource',top,seat,1,'resources','PRIVATE TOP REPLACEMENT · EXHAUSTED',{fromSeat:seat,fromZone:'deck',ownerSeat:seat,sourceCard:source,entersReady:false,visibility:'private'});}add('heal',p.base,seat,Math.min(3,p.base.d),'base',`BASE HEAL ${Math.min(3,p.base.d)}`);break;}
        case 'this-is-the-way':{const manifest=p.knownDeck??fail('known full deck required'),looked=manifest.slice(0,8),selected=choices.selectedIds??['a08:way:top:1','a08:way:top:3'];if(new Set(selected).size!==selected.length||selected.length>2)fail('up to two distinct selections required');const cards=selected.map(id=>looked.find(c=>c.id===id)??fail('selection outside actual top eight'));if(cards.some(c=>!['SOR_142','SOR_070','HMW_096','SOR_069','SHD_070'].includes(c.s??'')))fail('selected card must be verified Mandalorian or upgrade');add('search',cards[0]??null,seat,looked.length,'deck','PRIVATE TOP 8 · TWO QUALIFYING CARDS',{cards:looked,deckOperation:{scope:'top',visibility:'private',policy:'top-search-bottom',looked,selectedIds:selected,revealedIds:selected,remainingOrder:[...cards,...manifest.slice(looked.length),...looked.filter(c=>!selected.includes(c.id!)).reverse()],selectionLimit:2}});if(cards.length)add('draw',cards[0],seat,cards.length,'hand',`REVEAL AND DRAW ${cards.length}`,{cards,fromSeat:seat,fromZone:'deck',visibility:'public'});break;}
        case 'confiscate':{const t=req(choices.targetId??'a08:p2:wampa'),u=t.c.u?.find(c=>c.id===(choices.upgradeId??'a08:confiscate:academy'));if(!u)fail('actual selected upgrade required');if(t.c.h-(u.h??0)<=t.c.d)fail('host HP-loss defeat needs separate declared receipt');add('defeat',u,t.seat,1,'discard',u.t?'UPGRADE TOKEN CEASES':'UPGRADE TO OWNER DISCARD',{sourceCard:t.c,ownerSeat:u.owner});break;}
        case 'a-fine-addition':{const h=s.defeatedThisPhase,w=h?.round===s.round&&h.phase===s.phase?h.cards.find(c=>['unit','leader-unit'].includes(c.lastKnownType??'')&&c.controller&&c.controller!==seat&&c.incarnation):undefined;if(!w)break;
            const candidate=[...p.hand.map(c=>({c,seat,zone:'hand' as const})),...p.discard.map(c=>({c,seat,zone:'discard' as const})),...q.discard.map(c=>({c,seat:foe,zone:'discard' as const}))].find(x=>x.c.id===(choices.upgradeId??'a08:addition:armor'))??fail('upgrade must be own hand or actual discard');
            if(candidate.c.s!=='SHD_224'||candidate.c.n!=="Boba Fett's Armor")fail('alternate upgrade play requires source-verified cost/host receipts');const t=req(choices.targetId??'a08:p1:marine');if(['SOR_237','SOR_225'].includes(t.c.s??''))fail('Armor needs non-Vehicle host');
            add('cost',candidate.c,seat,-2,'resources','IGNORE MISSING CUNNING 2');nested(candidate.c,2);add('play',candidate.c,t.seat,1,t.zone,'OPPONENT DISCARD · PAID UPGRADE PLAY',{playAs:'upgrade',fromSeat:candidate.seat,fromZone:candidate.zone,ownerSeat:candidate.c.owner,controllerSeat:seat,targetCard:t.c,upgrade:{...candidate.c,controller:seat,t:0,p:2,h:2},entryType:'played',printedCost:2,defeatPhase:{round:s.round,phase:s.phase},upgradePlayPermission:{sourceId:source.id!,player:seat,ignoreAspectPenalties:true,defeated:{id:w.id,incarnation:w.incarnation!}}});break;
        }
        case 'lethal-crackdown':{const t=req(choices.targetId??'a08:p2:wampa');if(!nonleader(t)||!t.c.incarnation||t.c.cap?.length)fail('actual nonleader departure with supplied cleanup required');const witness={id:t.c.id!,incarnation:t.c.incarnation};add('defeat',t.c,t.seat,1,'discard','SUCCESSFUL NON-LEADER DEFEAT',{ownerSeat:t.c.owner,incarnation:t.c.incarnation});add('damage',p.base,seat,Math.max(0,t.c.p),'base',`OWN BASE TAKES LAST-KNOWN POWER ${Math.max(0,t.c.p)}`,{sourceCard:t.c,damageType:'ability',requiresDefeat:witness,basis:{kind:'defeated-power',sourceIds:[t.c.id!],value:Math.max(0,t.c.p)}});break;}
    }
    return out;
}
