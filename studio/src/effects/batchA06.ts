import type { CardRef, NextActionConstraint, ResourceRef, Seat, Snapshot, UnitRef } from '../data/types';
import type { AbilityBeat } from './abilities';
import type { PreviewAspect, PreviewCardCost } from './previewCosts';
import type { CardEffectDefinition, CardEffectOutcome, PreviewPlayPayment } from './types';

/** Explicit, source-verified examples; no general rules or phase engine. */
export const A06_DEFINITIONS:CardEffectDefinition[]=[
    {id:'timely-intervention',name:'Timely Intervention',setCode:'SHD_129',family:'support',color:'#b7dbbc',visual:'timely-intervention',durationMs:6000,description:'Pay to play a hand unit with Ambush for this phase; its chosen trigger readies and attacks an eligible enemy unit.'},
    {id:'moment-of-glory',name:'Moment of Glory',setCode:'SHD_130',family:'support',color:'#e0d297',visual:'moment-of-glory',durationMs:4400,description:'Give any unit +4/+4 for this phase; existing damage and pose stay unchanged.'},
    {id:'choose-sides',name:'Choose Sides',setCode:'SHD_132',family:'tactics',color:'#b9c7e6',visual:'choose-sides',durationMs:5800,description:'Simultaneously exchange control of a friendly and enemy non-leader; owners, arenas and uninterrupted entries remain distinct.'},
    {id:'give-in-to-your-anger',name:'Give In to Your Anger',setCode:'SHD_144',family:'force',color:'#e5af9a',visual:'give-in-to-your-anger',durationMs:4400,description:'Deal 1 to an enemy unit; its controller must use it for their next ordinary attack action this phase, if able.'},
    {id:'headhunting',name:'Headhunting',setCode:'SHD_145',family:'tactics',color:'#d6c891',visual:'headhunting',durationMs:6800,description:'Up to three ordered attacks against units; each Bounty Hunter gets +2 power only during its own attack.'},
    {id:'cripple-authority',name:'Cripple Authority',setCode:'SHD_156',family:'tactics',color:'#c6cae4',visual:'cripple-authority',durationMs:4800,description:'Draw 1 while each opponent with more total resources chooses 1 card from their hand to discard.'},
    {id:'the-chaos-of-war',name:'The Chaos of War',setCode:'SHD_159',family:'damage',color:'#e8ad91',visual:'the-chaos-of-war',durationMs:5000,description:'Simultaneously damage each base by that player’s resolving hand count; the source has already left hand.'},
    {id:'desperate-attack',name:'Desperate Attack',setCode:'SHD_179',family:'tactics',color:'#e5bd93',visual:'desperate-attack',durationMs:4800,description:'Attack with a damaged friendly unit at +2 power for that attack; a legal base target receives no counterdamage.'},
    {id:'detention-block-rescue',name:'Detention Block Rescue',setCode:'SHD_180',family:'damage',color:'#a5d1de',visual:'detention-block-rescue',durationMs:5800,description:'Deal 3 to any unit, or 6 if it guards captured cards; actual captor departure permits ordinary captive release.'},
    {id:'pillage',name:'Pillage',setCode:'SHD_181',family:'tactics',color:'#e1b799',visual:'pillage',durationMs:4600,description:'Choose a player; that player chooses 2 actual hand cards to discard, or all available if fewer.'}
];
export const A06_COSTS:Record<string,PreviewCardCost>={
    'timely-intervention':{printed:1,aspects:['command']},'moment-of-glory':{printed:3,aspects:['command']},'choose-sides':{printed:7,aspects:['command']},
    'give-in-to-your-anger':{printed:1,aspects:['villainy','aggression']},headhunting:{printed:2,aspects:['villainy','aggression']},
    'cripple-authority':{printed:2,aspects:['heroism','aggression']},'the-chaos-of-war':{printed:3,aspects:['aggression','aggression']},
    'desperate-attack':{printed:1,aspects:['aggression']},'detention-block-rescue':{printed:3,aspects:['aggression']},pillage:{printed:4,aspects:['aggression']}
};
export const A06_ABILITIES:Record<string,AbilityBeat[]>={
    'timely-intervention':[{kind:'play',label:'Play an affordable own-hand unit, paying its normal costs',scope:'friendly-arena',from:'own-hand',selection:'chosen',condition:'Unit mode, not a Pilot upgrade; normal exhausted entry and When Played abilities; choose nothing creates no unit'},{kind:'keyword',label:'Give the played unit Ambush for this phase',scope:'friendly-unit',duration:'phase',condition:'Granted in the play window; chosen trigger may ready and attack a legal enemy unit, ordinary arena/Sentinel restrictions; no legal target or declined trigger leaves entry exhausted'},{kind:'play',label:'Separate Smuggle route: source from resources costs 2 and one Command',scope:'resources',optional:true,condition:'Actual source identity leaves resources; actual deck top replaces exhausted when available, no replacement from empty deck; normal nested unit cost still applies'}],
    'moment-of-glory':[{kind:'buff',label:'Give any unit +4/+4 for this phase',scope:'target',amount:'+4/+4',duration:'phase',selection:'chosen',condition:'Either side/arena and deployed leaders; not a base or undeployed leader; preserve damage/readiness; not healing or Experience; capacity loss at an explicit phase boundary can cause actual defeat'}],
    'choose-sides':[{kind:'control',label:'Choose a friendly and enemy non-leader; exchange control simultaneously',scope:'target',selection:'chosen',duration:'permanent',condition:'Both selections required; either arena, each stays its own arena; ownership, damage, pose, same uninterrupted entry, ordinary attachment control/owner and captured owners persist; explicit token control/owner follows new controller; no regroup return; actual uniqueness/control effects require evidence'}],
    'give-in-to-your-anger':[{kind:'damage',label:'Deal 1 ability damage to an enemy unit',scope:'enemy-unit',amount:1,selection:'chosen',condition:'Either arena or deployed leader; actual prevention/departure remains explicit'},{kind:'restrict',label:'Its controller’s next action this phase must be Attack With a Unit using it, if able',scope:'target',duration:'next-action',condition:'Ordinary action only, unit target if able otherwise legal base; no readiness/Sentinel/arena/attack-prevention bypass; expires at actual controller next action or phase end; not a scheduled attack; departed/unable subject permits another action'}],
    headhunting:[{kind:'attack',label:'Attack with up to three friendly units, one attack fully resolves at a time',scope:'friendly-unit',amount:'up to 3',optional:true,condition:'Each may be declined; cannot target bases; normal readiness/arena/Sentinel/counterdamage/triggers; indirect base damage can occur; no distinct-ID requirement if an actual intervening ready permits reuse'},{kind:'buff',label:'Each actual Bounty Hunter gets +2/+0 only for its own attack',scope:'friendly-unit',amount:'+2/+0',duration:'attack',condition:'Current attacker trait; non-Hunters attack without this bonus; not a phase/resting-power increase'}],
    'cripple-authority':[{kind:'draw',label:'Draw 1',scope:'own-hand',from:'own-deck',amount:1,condition:'Same resolution window as conditional opposing discard; no fabricated short-deck card'},{kind:'discard',label:'Each opponent with strictly more total resources chooses 1 own-hand card to discard',scope:'enemy-hand',amount:1,selection:'opponent',condition:'Count exhausted and ready resources; equality/lower total gives no discard; empty hand loses none; no resource destruction or random selection'}],
    'the-chaos-of-war':[{kind:'damage',label:'Simultaneously damage each player’s base equal to that player’s current hand size',scope:'target',amount:'own hand count',selection:'all',condition:'Source already left hand; zero gives zero; hands remain intact, no unit damage; simultaneous lethal match result requires supplied truth'}],
    'desperate-attack':[{kind:'attack',label:'Attack with a damaged friendly unit, if able',scope:'friendly-unit',selection:'chosen',condition:'Actual existing damage, not low HP/debuff; ready and normal legal target rules; unit or base legal; base gives no counterdamage; not optionally skipped like Headhunting'},{kind:'buff',label:'It gets +2/+0 for that attack only',scope:'friendly-unit',amount:'+2/+0',duration:'attack',condition:'Bonus expires with identified attack; preserve existing scar, damage, final exhausted pose and resting power'}],
    'detention-block-rescue':[{kind:'damage',label:'Deal 3 to any unit, or 6 instead if it guards at least 1 captured card',scope:'target',amount:'3 or 6',selection:'chosen',condition:'Either side/arena and deployed leaders; count at resolution, never six per captive; surviving or protected captor keeps pocket; no independent rescue clause'},{kind:'rescue',label:'Only actual leave-play cleanup releases each captive to its real owner’s arena',scope:'owner-arena',condition:'Framework result, not a separate printed effect; explicit departed pocket, fresh clean normally exhausted entry; rescue is not play and does not trigger When Played; actual ready-entry replacement needs evidence'}],
    pillage:[{kind:'discard',label:'Choose a player; they choose 2 own-hand cards to discard',scope:'chosen-player-hand',amount:'up to 2',selection:'chosen',condition:'Any player including self; chooser is selected player; distinct actual hand IDs; fewer/empty discard all available; source left hand before self count; not random/deck/arena removal'}]
};
const labels:Record<string,string>={
    'timely-intervention':'Event 1 + new X-Wing 2; chosen Ambush attacks TIE, takes 2 and ends exhausted',
    'moment-of-glory':'Marine 3/3 → 7/7 this phase; damage 1 and ready pose stay',
    'choose-sides':'Permanent exchange: Marine owner P1 → control P2; exhausted TIE owner P2 → control P1',
    'give-in-to-your-anger':'Takes 1 now; next P2 action must attack with this Death Trooper if able; no attack yet',
    headhunting:'Hunter +2 attacks Trooper; Marine attacks Wampa and is lost; X-Wing attacks TIE; three resolved windows',
    'cripple-authority':'Total resources 8 vs 10: P1 draws Repair while P2 chooses Open Fire to discard',
    'the-chaos-of-war':'Source leaves hand; P1 keeps 3 cards and takes 3, P2 keeps 2 and takes 2, simultaneously',
    'desperate-attack':'Marine’s existing damage 1 permits attack power 5; enemy base takes 5, Marine returns to power 3 exhausted',
    'detention-block-rescue':'Captured 1 changes hit 3 → 6; captor departs, owner P1 Marine is rescued clean and exhausted',
    pillage:'P1 chooses P2; P2 chooses Takedown + Open Fire to discard and retains Resupply'
};
export const A06_EXAMPLES:Record<string,{label:string;beats:AbilityBeat[]}>=Object.fromEntries(Object.entries(labels).map(([id,label])=>[id,{label,beats:id==='timely-intervention'?[...A06_ABILITIES[id].slice(0,2),{kind:'pay',label:'Pay nested X-Wing cost',scope:'resources',amount:2}]:A06_ABILITIES[id]}]));
const supported=new Set(A06_DEFINITIONS.map(d=>d.id));
const card=(id:string,n:string,s:string|null,owner:Seat):CardRef=>({id,n,s,owner});
const unit=(c:CardRef,p:number,h:number,d=0,extra:Partial<UnitRef>={}):UnitRef=>({...c,p,h,d,incarnation:`${c.id}:entry-1`,...extra});
const deck=(seat:Seat,n:number):CardRef[]=>Array.from({length:n},(_,i)=>card(`a06:${seat}:deck:${i}`,'Unknown card',null,seat));
const resources=(seat:Seat,n:number,ready:number):ResourceRef[]=>Array.from({length:n},(_,i)=>({...card(`a06:${seat}:resource:${i}`,'Unknown card',null,seat),...(i>=ready?{x:1 as const}:{})}));
const stats:Record<string,{p:number;h:number;cost:number;aspects:PreviewAspect[];arena:'ground'|'space';bountyHunter?:true}>={
    SOR_095:{p:3,h:3,cost:2,aspects:['command','heroism'],arena:'ground'},SOR_098:{p:4,h:3,cost:3,aspects:['command','heroism'],arena:'ground'},SOR_237:{p:2,h:3,cost:2,aspects:['heroism'],arena:'space'},
    SOR_033:{p:3,h:3,cost:3,aspects:['villainy','vigilance'],arena:'ground'},SOR_164:{p:4,h:5,cost:4,aspects:['aggression'],arena:'ground'},SOR_225:{p:2,h:1,cost:1,aspects:['villainy'],arena:'space'},
    SHD_117:{p:3,h:4,cost:3,aspects:['command'],arena:'ground',bountyHunter:true},SHD_120:{p:3,h:4,cost:5,aspects:['command'],arena:'ground'}
};
function fail(message:string):never{throw new Error(`A06: ${message}`);}
function price(c:PreviewCardCost,state:Snapshot,seat:Seat):number{
    const providers:Record<string,PreviewAspect[]>={SOR_024:['command'],SOR_020:['vigilance'],SOR_005:['vigilance','heroism'],SOR_010:['aggression','villainy']},p=state.players[seat];
    const available=[...(p.base.s&&providers[p.base.s]||fail('unverified base provider')),...(p.leader?(p.leader.s&&providers[p.leader.s]||fail('unverified leader provider')):[])];
    return c.printed+c.aspects.filter(a=>{const i=available.indexOf(a);if(i<0)return true;available.splice(i,1);return false;}).length*2;
}
export interface A06Choices {targetId?:string;playerSeat?:Seat;discardIds?:string[];ambush?:boolean;attackPairs?:{attackerId:string;targetId:string}[]}
export function a06ShowcaseState(definition:CardEffectDefinition):Snapshot|undefined{
    if(!supported.has(definition.id))return undefined;
    const s:Snapshot={round:9,phase:'action',initiative:'p1',players:{
        p1:{name:'Rebel Alliance',base:{...card('a06:p1:base','Echo Base','SOR_024','p1'),hp:30,d:9},leader:{...card('a06:p1:leader','Luke Skywalker: Faithful Friend','SOR_005','p1'),dep:0,x:0},res:{ready:10,total:10},resources:resources('p1',10,10),hand:[card(`a06:${definition.id}:event`,definition.name,definition.setCode,'p1')],deck:27,knownDeck:deck('p1',27),discard:[],ground:[unit(card('a06:p1:marine','Battlefield Marine','SOR_095','p1'),3,3,1),unit(card('a06:p1:defender','Echo Base Defender','SOR_098','p1'),4,3,0,{sn:1})],space:[unit(card('a06:p1:xwing','Alliance X-Wing','SOR_237','p1'),2,3)]},
        p2:{name:'Galactic Empire',base:{...card('a06:p2:base','Capital City','SOR_020','p2'),hp:30,d:6},leader:{...card('a06:p2:leader','Darth Vader: Dark Lord of the Sith','SOR_010','p2'),dep:0,x:1},res:{ready:7,total:10},resources:resources('p2',10,7),hand:[card('a06:p2:hand:takedown','Takedown','SOR_077','p2')],deck:29,knownDeck:deck('p2',29),discard:[],ground:[unit(card('a06:p2:trooper','Death Trooper','SOR_033','p2'),3,3),unit(card('a06:p2:wampa','Wampa','SOR_164','p2'),4,5,1)],space:[unit(card('a06:p2:tie','TIE/ln Fighter','SOR_225','p2'),2,1)]}
    }},p=s.players.p1,q=s.players.p2;
    switch(definition.id){
        case 'timely-intervention':p.hand.push(card('a06:timely:new-xwing','Alliance X-Wing','SOR_237','p1'));break;
        case 'choose-sides':q.space[0].x=1;break;
        case 'headhunting':p.ground[1]=unit(card('a06:head:hunter','Reputable Hunter','SHD_117','p1'),3,4);break;
        case 'cripple-authority':p.res={ready:8,total:8};p.resources=resources('p1',8,8);q.res.ready=2;q.resources=resources('p2',10,2);q.hand.push(card('a06:cripple:p2:open','Open Fire','SOR_172','p2'));p.knownDeck![0]=card('a06:cripple:draw:0','Repair','SOR_074','p1');break;
        case 'the-chaos-of-war':p.hand.push(...[['Battlefield Marine','SOR_095'],['Repair','SOR_074'],['Open Fire','SOR_172']].map(([n,code],i)=>card(`a06:chaos:p1:hand:${i}`,n,code,'p1')));q.hand.push(card('a06:chaos:p2:resupply','Resupply','SOR_126','p2'));break;
        case 'detention-block-rescue':{const m=p.ground.shift()!;q.ground[0]=unit(card('a06:detention:captor','Discerning Veteran','SHD_120','p2'),3,4,0,{cap:[card(m.id!,m.n,m.s,'p1')]});s.mostRecentIncarnations={[m.id!]:m.incarnation!};break;}
        case 'pillage':q.hand.push(card('a06:pillage:p2:open','Open Fire','SOR_172','p2'),card('a06:pillage:p2:resupply','Resupply','SOR_126','p2'));break;
    }
    return s;
}
export function a06PreviewPayment(definition:CardEffectDefinition,state:Snapshot,seat:Seat):PreviewPlayPayment|undefined{
    if(!supported.has(definition.id))return undefined;
    const manifest=state.players[seat].resources||fail('actual resources required');
    return {kind:'resources',cardIds:manifest.filter(c=>!c.x).slice(0,price(A06_COSTS[definition.id],state,seat)).map(c=>c.id!)};
}
function makeReceipts(state:Snapshot,seat:Seat){
    const live=structuredClone(state),out:CardEffectOutcome[]=[],foe:Seat=seat==='p1'?'p2':'p1';
    const all=(side:Seat)=>[...live.players[side].ground,...live.players[side].space];
    const find=(id:string)=>{for(const side of [seat,foe])for(const zone of ['ground','space'] as const){const c=live.players[side][zone].find(u=>u.id===id);if(c)return{c,seat:side,zone};}return undefined;};
    const req=(id:string)=>find(id)||fail('missing current arena target');
    const push=(kind:CardEffectOutcome['kind'],c:CardRef|null,side:Seat,amount:number|string|undefined,zone:NonNullable<CardEffectOutcome['zone']>,label:string,extra:Partial<CardEffectOutcome>={})=>out.push({kind,card:structuredClone(c),seat:side,amount,zone,label,...extra});
    const defeat=(id:string,extra:Partial<CardEffectOutcome>={})=>{const r=req(id);push('defeat',r.c,r.seat,1,'discard','DEFEATED',{fromSeat:r.seat,fromZone:r.zone,ownerSeat:r.c.owner,incarnation:r.c.incarnation,...extra});if(!extra.prevented)live.players[r.seat][r.zone]=live.players[r.seat][r.zone].filter(c=>c.id!==id);};
    const attack=(attackerId:string,targetId:string,attackId:string,index:number,bonus?:CardEffectOutcome['attackBonusBasis'],origin?:CardEffectOutcome['attackOrigin'],unitOnly=false)=>{
        const a=req(attackerId);if(a.seat!==seat||a.c.x||!a.c.incarnation)fail('attacker must be a ready friendly current unit');
        const d=find(targetId),base=live.players[foe].base.id===targetId?live.players[foe].base:undefined;
        if(!d&&!base||d&&d.seat===seat||unitOnly&&base||d&&d.zone!==a.zone)fail('illegal attack destination');
        const sentinels=all(foe).filter(c=>c.sn&&live.players[foe][a.zone].includes(c));if(sentinels.length&&!sentinels.some(c=>c.id===targetId))fail('Sentinel must be targeted');
        const before=structuredClone(a.c),defender=structuredClone(d?.c??base!),power=a.c.p+(bonus?2:0);
        if(bonus){if(bonus.kind==='damaged'&&(a.c.d<=0||bonus.damage!==a.c.d)||bonus.kind==='bounty-hunter'&&!stats[a.c.s??'']?.bountyHunter)fail('attack bonus prerequisite absent');push('buff',a.c,seat,'+2/+0',a.zone,'+2 POWER · THIS ATTACK',{duration:'attack',attackId,attackIndex:index,attackBonusBasis:bonus});}
        push('attack',defender,foe,1,d?.zone??'base',`ATTACK ${index}`,{sourceCard:before,attackId,attackIndex:index,combatOrder:'simultaneous',attackOrigin:origin});
        push('exhaust',before,seat,1,a.zone,'ATTACKER EXHAUSTED',{attackId});a.c.x=1;
        push('damage',defender,foe,power,d?.zone??'base',`${power} COMBAT DAMAGE`,{sourceCard:before,attackId,attackIndex:index,combatOrder:'simultaneous',damageType:'combat'});
        if(d){push('damage',before,seat,d.c.p,a.zone,`${d.c.p} COUNTERDAMAGE`,{sourceCard:defender,attackId,attackIndex:index,combatOrder:'simultaneous',damageType:'combat'});d.c.d+=power;a.c.d+=d.c.p;if(d.c.d>=d.c.h)defeat(d.c.id!);if(a.c.d>=a.c.h)defeat(a.c.id!);}
        else base!.d+=power;
    };
    return{live,out,foe,all,req,push,defeat,attack};
}
export function a06PreviewOutcomes(definition:CardEffectDefinition,state:Snapshot,seat:Seat,choices:A06Choices={}):CardEffectOutcome[]|undefined{
    if(!supported.has(definition.id))return undefined;
    const r=makeReceipts(state,seat),{out,foe,req,push,defeat,attack}=r,p=state.players[seat],q=state.players[foe];
    const source=p.hand.find(c=>c.s===definition.setCode)||fail('actual event source absent'),eventCost=price(A06_COSTS[definition.id],state,seat);
    switch(definition.id){
        case 'timely-intervention':{
            const c=p.hand.find(c=>c.id===(choices.targetId??'a06:timely:new-xwing'))||fail('actual selected hand unit absent'),f=stats[c.s??''];
            if(!f||c.s!=='SOR_237')fail('selected entry effects require separate supported receipts');const n=price({printed:f.cost,aspects:f.aspects},state,seat);if(p.res.ready<eventCost+n)fail('nested unit is unaffordable after event payment');
            const entering=unit(c,f.p,f.h,0,{x:1}),origin={kind:'ambush' as const,playedId:c.id!,incarnation:entering.incarnation!};
            push('pay',null,seat,n,'resources',`UNIT PAID ${n}`,{sourceCard:c,cards:p.resources!.filter(x=>!x.x).slice(eventCost,eventCost+n)});
            push('play',c,seat,1,f.arena,'PAID HAND PLAY · EXHAUSTED',{sourceCard:c,fromSeat:seat,fromZone:'hand',ownerSeat:c.owner,entryType:'played',entersReady:false,printedCost:f.cost,unit:entering});
            push('keyword',entering,seat,1,f.arena,'AMBUSH · THIS PHASE',{duration:'phase',keyword:{name:'Ambush',amount:1}});r.live.players[seat][f.arena].push(structuredClone(entering));
            if(choices.ambush!==false){const enemy=r.all(foe).find(x=>x.id==='a06:p2:tie');if(enemy){push('ready',entering,seat,1,f.arena,'CHOSEN AMBUSH · READY',{incarnation:entering.incarnation,attackOrigin:origin});delete req(c.id!).c.x;attack(c.id!,enemy.id!,'a06:timely:ambush',1,undefined,origin,true);}}
            break;
        }
        case 'moment-of-glory':{const t=req(choices.targetId??'a06:p1:marine');push('buff',t.c,t.seat,'+4/+4',t.zone,'+4/+4 · THIS PHASE',{duration:'phase'});break;}
        case 'choose-sides':{
            const a=req('a06:p1:marine'),b=req('a06:p2:tie'),pair={id:'a06:choose:exchange',memberIds:[a.c.id!,b.c.id!] as [string,string]};
            for(const t of [a,b]){const dest:Seat=t.seat===seat?foe:seat,after=structuredClone(t.c);(after.status??=[]).push({kind:'control',label:`Owner ${t.c.owner?.toUpperCase()} · Control ${dest.toUpperCase()}`,duration:'permanent'});for(const u of after.u??[])if(u.t){u.controller=dest;u.owner=dest;}push('control',t.c,dest,1,t.zone,'PERMANENT · OWNER PRESERVED',{fromSeat:t.seat,fromZone:t.zone,ownerSeat:t.c.owner,incarnation:t.c.incarnation,duration:'permanent',controlExchange:pair,unit:after});}break;
        }
        case 'give-in-to-your-anger':{
            const t=req(choices.targetId??'a06:p2:trooper');if(t.seat===seat)fail('enemy unit required');push('damage',t.c,t.seat,1,t.zone,'1 ABILITY DAMAGE',{damageType:'ability'});
            if(t.c.d+1>=t.c.h){defeat(t.c.id!);break;}
            const constraint:NextActionConstraint={id:'a06:anger:constraint',sourceId:source.id!,subjectId:t.c.id!,incarnation:t.c.incarnation!,controller:t.seat,round:state.round,phase:state.phase,targetUnitIfAble:true};
            push('restrict',t.c,t.seat,1,t.zone,`NEXT ${t.seat.toUpperCase()} ACTION · ATTACK WITH THIS UNIT IF ABLE`,{duration:'next-action',restriction:'must-attack',incarnation:t.c.incarnation,nextAction:{operation:'add',constraint}});break;
        }
        case 'headhunting':{
            const pairs=choices.attackPairs??[{attackerId:'a06:head:hunter',targetId:'a06:p2:trooper'},{attackerId:'a06:p1:marine',targetId:'a06:p2:wampa'},{attackerId:'a06:p1:xwing',targetId:'a06:p2:tie'}];if(pairs.length>3)fail('at most three attacks');
            pairs.forEach(({attackerId,targetId},i)=>{const a=req(attackerId).c,bonus=stats[a.s??'']?.bountyHunter?{kind:'bounty-hunter' as const,sourceId:a.id!,incarnation:a.incarnation!}:undefined;attack(attackerId,targetId,`a06:head:attack:${i+1}`,i+1,bonus,undefined,true);});break;
        }
        case 'cripple-authority':{
            const top=p.knownDeck?.[0]||fail('actual draw requires known nonempty deck'),group={id:'a06:cripple:window',mode:'simultaneous' as const};
            push('draw',null,seat,1,'hand','DRAW 1',{cards:[top],fromZone:'deck',resolutionGroup:group});
            if(q.res.total>p.res.total&&q.hand.length){const c=q.hand.find(c=>c.id===(choices.discardIds?.[0]??'a06:cripple:p2:open'))||fail('selected player chooses actual own-hand card');push('discard',c,foe,1,'discard','P2 CHOOSES 1',{fromSeat:foe,fromZone:'hand',ownerSeat:c.owner,chooserSeat:foe,selection:'chosen',resolutionGroup:group,condition:{kind:'resources-more',player:foe,total:q.res.total,than:seat,thanTotal:p.res.total}});}break;
        }
        case 'the-chaos-of-war':{
            const group={id:'a06:chaos:window',mode:'simultaneous' as const};for(const side of [seat,foe]){const h=state.players[side].hand.filter(c=>c.id!==source.id);push('damage',state.players[side].base,side,h.length,'base',`${h.length} OWN-HAND DAMAGE`,{damageType:'ability',basis:{kind:'hand-count',sourceIds:h.map(c=>c.id!),value:h.length,player:side},resolutionGroup:group});}break;
        }
        case 'desperate-attack':{const a=req(choices.targetId??'a06:p1:marine').c;attack(a.id!,choices.attackPairs?.[0]?.targetId??q.base.id!,'a06:desperate:attack',1,{kind:'damaged',sourceId:a.id!,incarnation:a.incarnation!,damage:a.d});break;}
        case 'detention-block-rescue':{
            const t=req(choices.targetId??'a06:detention:captor'),captives=t.c.cap??[],n=captives.length?6:3;
            push('damage',t.c,t.seat,n,t.zone,`${captives.length} CAPTURED · ${n} DAMAGE`,{damageType:'ability',basis:{kind:'captured-count',sourceIds:[t.c.id!],value:captives.length,countRule:{zero:3,positive:6}}});
            if(t.c.d+n>=t.c.h){const cleanup={id:'a06:detention:cleanup',captorId:t.c.id!,incarnation:t.c.incarnation!,cards:structuredClone(captives)};defeat(t.c.id!,captives.length?{captiveCleanup:cleanup}:{});for(const c of captives){const f=stats[c.s??''];if(!f||!c.owner)fail('full owner and verified rescue entry required');push('rescue',c,c.owner,1,f.arena,'RESCUED · OWNER ENTRY · EXHAUSTED',{sourceCard:t.c,fromSeat:t.seat,fromZone:t.zone,ownerSeat:c.owner,entryType:'rescued',entersReady:false,unit:unit(c,f.p,f.h,0,{x:1,incarnation:`${c.id}:entry-2`}),captiveCleanupId:cleanup.id});}}
            break;
        }
        case 'pillage':{
            const selected=choices.playerSeat??foe,h=state.players[selected].hand.filter(c=>c.id!==source.id),ids=choices.discardIds??h.slice(0,Math.min(2,h.length)).map(c=>c.id!);
            if(ids.length!==Math.min(2,h.length)||new Set(ids).size!==ids.length)fail('selected player chooses distinct available two-or-fewer hand cards');for(const id of ids){const c=h.find(x=>x.id===id)||fail('selected discard is not in selected player hand');push('discard',c,selected,1,'discard',`${selected.toUpperCase()} CHOOSES`,{fromSeat:selected,fromZone:'hand',ownerSeat:c.owner,chooserSeat:selected,selection:'chosen',playerChoice:{chooserSeat:seat,selectedSeat:selected}});}break;
        }
    }
    return out;
}
/** Explicit second scene; source event is already paid and discarded in the supplied immediate ending. */
export function a06NextActionOutcomes(definition:CardEffectDefinition,state:Snapshot,_seat:Seat):CardEffectOutcome[]|undefined{
    if(definition.id!=='give-in-to-your-anger')return undefined;
    const constraint=state.nextActionConstraints?.find(c=>c.id==='a06:anger:constraint')||fail('actual immediate constraint required'),r=makeReceipts(state,constraint.controller),t=r.req(constraint.subjectId);
    if(t.c.incarnation!==constraint.incarnation||t.c.x)fail('chosen next ordinary attack needs the same ready entry');
    r.attack(t.c.id!,'a06:p1:defender','a06:anger:next-attack',1);
    r.push('restrict',t.c,constraint.controller,0,t.zone,'NEXT ACTION CONSTRAINT CONSUMED',{nextAction:{operation:'consume',constraintId:constraint.id,witness:{id:'a06:anger:action',player:constraint.controller,round:constraint.round,phase:constraint.phase,action:'attack-with-unit',result:'satisfied',attackerId:t.c.id!,incarnation:t.c.incarnation,attackId:'a06:anger:next-attack',targetId:'a06:p1:defender'}}});
    return r.out;
}
