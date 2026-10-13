import type { CardRef, Seat, UnitRef, Snapshot } from '../data/types';
import type { CardEffectCue } from './types';
import { A12_DEFINITIONS } from './batchA12';
import { previewPlayCost } from './previewCosts';
import { easeInOut, envelope, phase } from './animationTimeline';
import { CardGhost, ResourceBalance, ResourceSlot, ScreenPixels, mix, screenShift as shift, type EffectBox, type PlacedOutcome } from './primitives';

type Geometry = { source: EffectBox; target: EffectBox; friendlyBase: EffectBox; outcomes: PlacedOutcome[]; zones: Record<string, EffectBox>; cards?: Record<string, EffectBox>; endingCards?: Record<string, EffectBox>; resourceCards?: Record<string, EffectBox> };
type Props = { cue: CardEffectCue; geometry: Geometry; p: number };
const seats: Seat[] = ['p1','p2'];
const ids=new Set(['wartime-profiteering','on-the-doorstep','clear-the-field','creative-thinking','in-pursuit']);
export const isBatchA12Secondary=(cue:CardEffectCue)=>ids.has(cue.definition.id);
const key=(c?:CardRef|null)=>c?.id??'';
const same=(a?:CardRef|null,b?:CardRef|null)=>!!a?.id&&a.id===b?.id;
const refEqual=(a?:CardRef|null,b?:CardRef|null)=>same(a,b)&&a?.s===b?.s&&a?.n===b?.n&&a?.owner===b?.owner;
const ordered=(a:CardRef[],b:CardRef[])=>a.length===b.length&&a.every((c,i)=>refEqual(c,b[i]));
const exact=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const sourceProof=(cue:CardEffectCue,i:PlacedOutcome)=>refEqual(i.outcome.sourceCard,cue.source)&&(!i.outcome.requiresExhaust||cue.definition.id==='in-pursuit')&&!i.outcome.requiresDefeat&&!i.outcome.requiresReturn&&!i.outcome.traitCondition&&!i.outcome.attackId&&i.outcome.attackIndex===undefined;
const size=(at:EffectBox)=>at.cardSize??{w:at.w*(at.sx??1),h:at.h*(at.sy??1)};
const visible=(p:number,start:number)=>phase(p,start,start+.045);
const bounded=(at:EffectBox,w=220,h=42):EffectBox=>({...at,x:Math.max((w/2+8)/(at.sx??1),Math.min(1000-(w/2+8)/(at.sx??1),at.x)),y:Math.max((h/2+40)/(at.sy??1),Math.min(600-(h/2+122)/(at.sy??1),at.y))});
const center=(g:Geometry)=>{const upper=g.zones['p2:ground'],base=g.zones['p1:base'];return bounded({...g.source,x:500,y:upper&&base?(upper.y+upper.h/2+base.y-base.h/2)/2:300});};
function eventProof(cue:CardEffectCue){
 const canonical=A12_DEFINITIONS.find(d=>d.id===cue.definition.id);
 if(!canonical||!cue.transition||cue.transition.before.phase!=='action'||!exact({...cue.transition.before,players:undefined},{...cue.transition.after,players:undefined})||cue.transition.before.initiative!==cue.transition.after.initiative||cue.transition.before.round!==cue.transition.after.round||cue.transition.before.phase!==cue.transition.after.phase||cue.stage||!cue.source?.id||cue.definition.name!==canonical.name||cue.definition.setCode!==canonical.setCode||cue.source.n!==canonical.name||cue.source.s!==canonical.setCode||cue.source.owner!==cue.seat||cue.playPayment?.kind!=='resources'||cue.playPayment.exploit||cue.playPayment.smuggle)return false;
 const b=cue.transition.before.players[cue.seat],a=cue.transition.after.players[cue.seat],paid=cue.playPayment.cardIds,foe:Seat=cue.seat==='p1'?'p2':'p1';let cost:number;try{cost=previewPlayCost(cue.definition,cue.transition.before,cue.seat,cue.playPayment);}catch{return false;}
 return !!paid&&cue.playCost===cost&&paid.length===cost&&new Set(paid).size===paid.length&&b.hand.filter(c=>refEqual(c,cue.source)).length===1&&!a.hand.some(c=>same(c,cue.source))&&a.discard.filter(c=>refEqual(c,cue.source)).length===1
 &&!!b.resources&&!!a.resources&&b.resources.length===b.res.total&&a.resources.length===a.res.total&&ordered(b.resources,a.resources)&&a.res.total===b.res.total&&b.resources.filter(r=>!r.x).length===b.res.ready&&a.resources.filter(r=>!r.x).length===a.res.ready&&a.res.ready===b.res.ready-cost&&paid.every(id=>b.resources!.some(r=>r.id===id&&!r.x))&&b.resources.every((r,i)=>!!a.resources![i].x===(!!r.x||paid.includes(key(r))))
 &&exact(cue.transition.before.players[foe].resources,cue.transition.after.players[foe].resources)&&exact(cue.transition.before.players[foe].res,cue.transition.after.players[foe].res);
}
function locate(cue:CardEffectCue,card:CardRef|null|undefined){
 if(!card?.id)return;const found=seats.flatMap(seat=>(['ground','space']as const).flatMap(zone=>cue.transition?.before.players[seat][zone].filter(u=>same(u,card)).map(unit=>({unit,seat,zone}))??[]));return found.length===1?found[0]:undefined;
}
type Located=NonNullable<ReturnType<typeof locate>>;
function boardMatches(cue:CardEffectCue,changes:Map<string,UnitRef|null>,baseChange?:{seat:Seat;damage:number}){
 if(!cue.transition)return false;
 return seats.every(seat=>{
  const before=cue.transition!.before.players[seat],after=cue.transition!.after.players[seat];
  return exact(before.leader,after.leader)&&exact({...before.base,...(baseChange?.seat===seat?{d:baseChange.damage}:{})},after.base)
   &&(['ground','space']as const).every(zone=>{
    const expected=before[zone].flatMap(u=>{const changed=changes.get(key(u));return changed===null?[]:[changed??u];});return exact(expected,after[zone]);
   });
 });
}
function pocketsMatch(cue:CardEffectCue,departures:Located[]=[],draws:CardRef[]=[]){
 if(!cue.transition)return false;
 return seats.every(seat=>{
  const b=cue.transition!.before.players[seat],a=cue.transition!.after.players[seat],own=seat===cue.seat;
  const fallen=departures.filter(t=>t.unit.owner===seat&&!t.unit.t).map(t=>t.unit);
  return ordered(a.hand,[...b.hand.filter(c=>!own||!same(c,cue.source)),...(own?draws:[])])
   &&ordered(a.discard,[...b.discard,...(own?[cue.source!]:[]),...fallen])
   &&a.deck===b.deck-(own?draws.length:0)&&ordered(a.knownDeck??[],(b.knownDeck??[]).slice(own?draws.length:0));
 });
}

function Receipt({at,rows,p,start=.73,until,color='#b8dcd8'}:{at:EffectBox;rows:string[];p:number;start?:number;until?:number;color?:string}){
 const w=Math.min(320,Math.max(100,...rows.map(r=>r.length*6+24))),h=rows.length*16+8;
 return <ScreenPixels at={bounded(at,w,h)} color={color} opacity={visible(p,start)*(until?1-phase(p,until-.05,until):1)}><rect x={-w/2} y={-h/2} width={w} height={h} rx="4" fill="#08111e" fillOpacity=".97"/>{rows.map((r,i)=><text key={i} y={-h/2+14+i*16} textAnchor="middle" fill="currentColor" stroke="none" style={{font:'700 9px sans-serif'}}>{r}</text>)}</ScreenPixels>;
}
function Mask({at,p,start}:{at:EffectBox;p:number;start:number}){const s=size(at);return <ScreenPixels at={at} opacity={visible(p,start)}><rect x={-s.w/2-4} y={-s.h/2-4} width={s.w+8} height={s.h+8} rx="5" fill="#0b1420" stroke="none"/></ScreenPixels>;}
function CompactDiscardRoute({from,to,card,p,start,end}:{from:EffectBox;to:EffectBox;card:CardRef;p:number;start:number;end:number}){
 const left=12/(from.sx??1),approach=shift(to,0,24),route=[from,{...from,x:left},{...approach,x:left},approach,to],t=easeInOut(phase(p,start,end)),segment=Math.min(3,Math.floor(t*4));
 const at={...from,...mix(route[segment],route[segment+1],easeInOut(t*4-segment))};
 return <><path d={route.map((point,i)=>`${i?'L':'M'}${point.x} ${point.y}`).join(' ')} stroke="#acd4d8" strokeWidth="1.5" opacity={envelope(p,start,start+.03,end+.06)}/><ScreenPixels at={at} opacity={envelope(p,start,start+.025,end+.06)}><CardGhost card={card} box={{w:20,h:28}}/></ScreenPixels></>;
}
function Payment({cue,geometry:g,p}:Props){const before=cue.transition!.before.players[cue.seat],paid=cue.playPayment?.kind==='resources'?cue.playPayment.cardIds!:[];return <>{before.resources!.map((r,i)=>{const at=g.resourceCards?.[cue.seat+':'+key(r)];return at&&paid.includes(key(r))?<ResourceSlot key={key(r)} at={at} index={i} spent p={p} start={.04}/>:null;})}<ResourceBalance at={g.zones[cue.seat+':resources']} countAt={g.zones[cue.seat+':resource-count']} ready={before.res.ready-paid.length} total={before.res.total} p={p} start={.04}/><Mask at={g.source} p={p} start={.04}/><CompactDiscardRoute from={g.source} to={g.zones[cue.seat+':discard']} card={cue.source!} p={p} start={.04} end={.21}/></>;}

const refs=(s:Snapshot)=>seats.flatMap(seat=>{const p=s.players[seat];return[p.base,...(p.leader?[p.leader]:[]),...p.ground,...p.space,...p.hand,...p.discard,...(p.knownDeck??[]),...(p.resources??[]),...[...p.ground,...p.space].flatMap(u=>[...(u.u??[]),...(u.cap??[])])];});
const ended=(cue:CardEffectCue,card:CardRef,seat:Seat)=>[...cue.transition!.after.players[seat].ground,...cue.transition!.after.players[seat].space].find(u=>same(u,card));
const names:Record<string,{title:string;name:string;cost:number;unique:boolean}>={
 SOR_095:{title:'Battlefield Marine',name:'Battlefield Marine',cost:2,unique:false},SOR_098:{title:'Echo Base Defender',name:'Echo Base Defender',cost:3,unique:false},SOR_237:{title:'Alliance X-Wing',name:'Alliance X-Wing',cost:2,unique:false},SOR_033:{title:'Death Trooper',name:'Death Trooper',cost:3,unique:false},SOR_164:{title:'Wampa',name:'Wampa',cost:4,unique:false},SOR_225:{title:'TIE/ln Fighter',name:'TIE/ln Fighter',cost:1,unique:false},
 SHD_157:{title:'Bo-Katan Kryze',name:'Bo-Katan Kryze: Fighting For Mandalore',cost:2,unique:true},SEC_051:{title:'Bo-Katan Kryze',name:'Bo-Katan Kryze: Alone',cost:9,unique:true}
};
function printed(u:UnitRef){
 if(u.t&&u.s===null&&['Battle Droid','Clone Trooper'].includes(u.n))return{title:u.n,name:u.n,cost:0,unique:false};
 const fact=u.s?names[u.s]:undefined;return fact&&u.n===fact.name&&u.printedTitle===fact.title&&u.unique===fact.unique?fact:undefined;
}
function common(cue:CardEffectCue,g:Geometry){return eventProof(cue)&&!!cue.transition&&g.outcomes.every(i=>sourceProof(cue,i)&&!i.outcome.prevented)&&refs(cue.transition.before).filter(c=>same(c,cue.source)).length===1&&refs(cue.transition.after).filter(c=>same(c,cue.source)).length===1;}
function creationProof(cue:CardEffectCue,g:Geometry,count:number,ready:boolean,type:'battle-droid'|'clone-trooper'){
 if(!cue.transition)return;
 const items=g.outcomes.filter(i=>i.outcome.kind==='create'),seen=new Set<string>(),b=refs(cue.transition.before),a=refs(cue.transition.after),power=type==='battle-droid'?1:2,name=type==='battle-droid'?'Battle Droid':'Clone Trooper';
 if(items.length!==count)return;
 for(const i of items){const o=i.outcome,u=o.unit,end=u&&ended(cue,u,cue.seat);
  if(!u?.id||!u.incarnation||seen.has(u.id)||b.some(c=>same(c,u))||a.filter(c=>same(c,u)).length!==1||!end||!exact(end,u)||!exact(o.card,u)||o.seat!==cue.seat||o.ownerSeat!==cue.seat||o.zone!=='ground'||o.fromZone!==undefined||o.fromSeat!==undefined||o.incarnation!==u.incarnation||o.tokenType!==type||o.entryType!=='created'||o.amount!==1||o.entersReady!==ready||!!u.x===ready||u.t!==1||u.s!==null||u.n!==name||u.owner!==cue.seat||u.p!==power||u.h!==power||u.d!==0||u.printedTitle!==name||u.unique!==false||u.leaderUnit!==false||!exact(u.traits,type==='battle-droid'?['separatist','droid','trooper']:['republic','clone','trooper'])||u.sn||u.u?.length||u.cap?.length||u.status?.length||o.requiresExhaust||o.requiresDefeat||o.requiresReturn)return;
  seen.add(u.id);
 }
 return items;
}
function arenaWith(cue:CardEffectCue,changes:Map<string,UnitRef|null>,created:PlacedOutcome[]=[]){
 if(!cue.transition)return false;return seats.every(seat=>{
  const b=cue.transition!.before.players[seat],a=cue.transition!.after.players[seat];
  return exact(b.base,a.base)&&exact(b.leader,a.leader)&&(['ground','space']as const).every(zone=>exact(a[zone],[...b[zone].flatMap(u=>{const n=changes.get(key(u));return n===null?[]:[n??u];}),...created.filter(i=>i.outcome.seat===seat&&i.outcome.zone===zone).map(i=>i.outcome.unit!)]));
 });
}
function doorstepProof(cue:CardEffectCue,g:Geometry){
 if(!common(cue,g)||g.outcomes.length!==3||!pocketsMatch(cue))return;
 const creates=creationProof(cue,g,3,true,'battle-droid');if(!creates||!arenaWith(cue,new Map(),creates))return;
 return{creates,items:g.outcomes};
}
function exhaustProof(cue:CardEffectCue,item:PlacedOutcome){
 const o=item.outcome,t=locate(cue,o.card);if(!t||!t.unit.incarnation||o.kind!=='exhaust'||o.seat!==t.seat||o.zone!==t.zone||o.incarnation!==t.unit.incarnation||!exact(o.card,t.unit)||o.amount!==(t.unit.x?0:1)||o.prevented||!sourceProof(cue,item))return;
 // Leader summary poses need their own receipt; this rich composition supports the explicit non-leader recipe.
 if(seats.some(s=>same(cue.transition!.before.players[s].leader,t.unit)))return;
 return{item,t,end:{...t.unit,x:1 as const},changed:!t.unit.x};
}
function creativeProof(cue:CardEffectCue,g:Geometry){
 if(!common(cue,g)||!pocketsMatch(cue))return;
 const creates=creationProof(cue,g,1,false,'clone-trooper'),folds=g.outcomes.filter(i=>i.outcome.kind==='exhaust');if(!creates||folds.length>1||g.outcomes.length!==1+folds.length)return;
 const fold=folds.length?exhaustProof(cue,folds[0]):undefined,changes=new Map<string,UnitRef|null>();
 if(folds.length){const fact=fold&&printed(fold.t.unit);if(!fold||!fact||fact.unique||fold.t.unit.unique!==false||fold.item.outcome.requiresExhaust)return;changes.set(key(fold.t.unit),fold.end);}
 else if(seats.some(s=>[...cue.transition!.before.players[s].ground,...cue.transition!.before.players[s].space].some(u=>printed(u)?.unique===false&&!u.x)))return;
 const group=creates[0].outcome.resolutionGroup;if(!group?.id||group.mode!=='simultaneous'||g.outcomes.some(i=>!exact(i.outcome.resolutionGroup,group))||!arenaWith(cue,changes,creates))return;
 return{creates,fold,items:g.outcomes};
}
function pursuitProof(cue:CardEffectCue,g:Geometry){
 if(!common(cue,g)||!pocketsMatch(cue)||!g.outcomes.length||g.outcomes.length>2)return;
 const first=exhaustProof(cue,g.outcomes[0]);if(!first||first.t.seat!==cue.seat||first.item.outcome.requiresExhaust)return;
 const second=g.outcomes[1]?exhaustProof(cue,g.outcomes[1]):undefined,changes=new Map<string,UnitRef|null>([[key(first.t.unit),first.end]]);
 if(g.outcomes.length===2){const dep=second?.item.outcome.requiresExhaust;if(!first.changed||!second||second.t.seat===cue.seat||!dep||dep.id!==first.t.unit.id||dep.incarnation!==first.t.unit.incarnation)return;changes.set(key(second.t.unit),second.end);}
 if(first.changed&&!second&&seats.some(s=>s!==cue.seat&&[...cue.transition!.before.players[s].ground,...cue.transition!.before.players[s].space].some(u=>!u.x)))return;
 if(!arenaWith(cue,changes))return;return{first,second,items:g.outcomes};
}
function wartimeProof(cue:CardEffectCue,g:Geometry){
 if(!common(cue,g)||!cue.transition||g.outcomes.length<1||g.outcomes.length>2||!boardMatches(cue,new Map()))return;
 const before=cue.transition.before,p=before.players[cue.seat],q=cue.transition.after.players[cue.seat],history=before.defeatedThisPhase,search=g.outcomes[0],o=search.outcome,op=o.deckOperation,w=o.unitDefeatCount,deck=p.knownDeck,draw=g.outcomes[1];
 if(!history||history.round!==before.round||history.phase!==before.phase||!w||w.round!==before.round||w.phase!==before.phase||o.kind!=='search'||o.seat!==cue.seat||o.zone!=='deck'||o.fromZone!=='deck'||o.fromSeat!==cue.seat||!op||!deck||deck.length!==p.deck||new Set(deck.map(key)).size!==deck.length)return;
 const known=history.cards.filter(c=>['unit','leader-unit','token-unit'].includes(c.lastKnownType??''));
 // Ambiguous legacy token history and the engine's upgrade-inclusive watcher are not asserted as unit counts.
 if(history.cards.some(c=>!['unit','leader-unit','token-unit'].includes(c.lastKnownType??'')||!c.incarnation)||new Set(known.map(c=>c.id+':'+c.incarnation)).size!==known.length||w.units.length!==known.length||w.units.some(u=>!known.some(k=>k.id===u.id&&k.incarnation===u.incarnation))||new Set(w.units.map(u=>u.id+':'+u.incarnation)).size!==w.units.length)return;
 if(op.looked.length>10||op.scope!=='top'||op.visibility!=='private'||op.policy!=='top-search-bottom'||op.selectionLimit!==1||!ordered(op.looked,deck.slice(0,known.length))||o.amount!==op.looked.length||op.selectedIds.length>1||new Set(op.selectedIds).size!==op.selectedIds.length||op.revealedIds?.length||op.remainingOrder.length!==deck.length||new Set(op.remainingOrder.map(key)).size!==deck.length||op.remainingOrder.some(c=>!deck.some(d=>refEqual(c,d))))return;
 const selected=op.selectedIds.map(id=>op.looked.find(c=>c.id===id));if(selected.some(c=>!c))return;const cards=selected as CardRef[],remaining=op.remainingOrder.filter(c=>!op.selectedIds.includes(key(c)));
 if(!ordered(remaining.slice(0,deck.length-op.looked.length),deck.slice(op.looked.length))||!ordered(q.knownDeck??[],remaining)||q.deck!==p.deck-cards.length)return;
 if(cards.length){if(!draw||draw.outcome.kind!=='draw'||draw.outcome.amount!==1||draw.outcome.seat!==cue.seat||draw.outcome.fromSeat!==cue.seat||draw.outcome.fromZone!=='deck'||draw.outcome.zone!=='hand'||draw.outcome.visibility==='public'||!ordered(draw.outcome.cards??[],cards))return;}else if(draw)return;
 const enemy:Seat=cue.seat==='p1'?'p2':'p1',eb=before.players[enemy],ea=cue.transition.after.players[enemy];
 if(!ordered(q.hand,[...p.hand.filter(c=>!same(c,cue.source)),...cards])||!ordered(q.discard,[...p.discard,cue.source!])||!ordered(eb.hand,ea.hand)||!ordered(eb.discard,ea.discard)||eb.deck!==ea.deck||!ordered(eb.knownDeck??[],ea.knownDeck??[]))return;
 return{search,draw,op,cards,count:known.length,items:g.outcomes};
}
function clearProof(cue:CardEffectCue,g:Geometry){
 if(!common(cue,g)||!cue.transition||!g.outcomes.length)return;
 const b=cue.transition.before,a=cue.transition.after,group=g.outcomes[0].outcome.sameNameGroup,enemy:Seat=cue.seat==='p1'?'p2':'p1';if(!group?.id||!group.selectedId||!group.selectedIncarnation||!group.title)return;
 const selected=locate(cue,{id:group.selectedId,n:'',s:null}),fact=selected&&printed(selected.unit);if(!selected||!fact||selected.unit.incarnation!==group.selectedIncarnation||selected.unit.leaderUnit!==false||fact.cost>3||group.selectedPrintedCost!==fact.cost||group.title!==fact.title)return;
 const all=seats.flatMap(seat=>(['ground','space']as const).flatMap(zone=>b.players[seat][zone].map(unit=>({seat,zone,unit})))),members=all.filter(t=>same(t.unit,selected.unit)||t.seat===enemy&&t.unit.printedTitle===group.title&&t.unit.leaderUnit===false),ids=new Set(members.map(t=>key(t.unit)));
 if(all.some(t=>t.seat===enemy&&(t.unit.leaderUnit===undefined||!t.unit.leaderUnit&&!printed(t.unit))))return;
 if(g.outcomes.length!==members.length||group.members.length!==members.length||new Set(group.members.map(m=>m.id)).size!==members.length||group.members.some(m=>!members.some(t=>t.unit.id===m.id&&t.unit.incarnation===m.incarnation)))return;
 const returns:({item:PlacedOutcome;t:Located})[]=[];
 for(const t of members){const f=printed(t.unit),matches=g.outcomes.filter(i=>same(i.outcome.card,t.unit)),item=matches[0],o=item?.outcome;
  if(!f||f.title!==group.title||t.unit.leaderUnit!==false||!t.unit.incarnation||!t.unit.owner||t.unit.u?.length||t.unit.cap?.length||matches.length!==1||!o||!exact(o.card,t.unit)||o.kind!=='return'||o.fromSeat!==t.seat||o.fromZone!==t.zone||o.seat!==t.unit.owner||o.ownerSeat!==t.unit.owner||o.zone!=='hand'||o.destination!==undefined&&o.destination!=='hand'||o.incarnation!==t.unit.incarnation||!exact(o.sameNameGroup,group))return;
  returns.push({item,t});
 }
 if(!arenaWith(cue,new Map(members.map(t=>[key(t.unit),null]))))return;
 for(const seat of seats){const old=b.players[seat],end=a.players[seat],arrivals=g.outcomes.map(i=>i.outcome.card as UnitRef).filter(u=>u.owner===seat&&!u.t);
  if(!ordered(end.hand,[...old.hand.filter(c=>seat!==cue.seat||!same(c,cue.source)),...arrivals])||!ordered(end.discard,[...old.discard,...(seat===cue.seat?[cue.source!]:[])])||old.deck!==end.deck||!ordered(old.knownDeck??[],end.knownDeck??[]))return;
 }
 if(refs(a).some(c=>ids.has(key(c))&&members.find(t=>same(t.unit,c))?.unit.t))return;
 return{returns,group,items:g.outcomes};
}
export function batchA12SecondaryCovers(cue:CardEffectCue,g:Geometry,item:PlacedOutcome):boolean{
 switch(cue.definition.id){case'wartime-profiteering':return wartimeProof(cue,g)?.items.includes(item)??false;case'on-the-doorstep':return doorstepProof(cue,g)?.items.includes(item)??false;case'clear-the-field':return clearProof(cue,g)?.items.includes(item)??false;case'creative-thinking':return creativeProof(cue,g)?.items.includes(item)??false;case'in-pursuit':return pursuitProof(cue,g)?.items.includes(item)??false;default:return false;}
}

function UnitFace({at,unit,p,start,rotate=false}:{at:EffectBox;unit:UnitRef;p:number;start:number;rotate?:boolean}){
 const s=size(at),turn=rotate?10*easeInOut(phase(p,start,start+.13)):unit.x?10:0;
 return <ScreenPixels at={at} opacity={visible(p,start)}><g transform={`rotate(${turn})`}><CardGhost card={unit} box={s}/>{[0,1].map(i=><g key={i} transform={`translate(${(i?1:-1)*(s.w/2-10)} ${s.h/2-12})`}><rect x="-10" y="-11" width="20" height="22" rx="3" fill={i?'#174772':'#8b2936'} stroke="#d8e4e5"/><text y="4" textAnchor="middle" fill="#fff" stroke="none" style={{font:'800 13px sans-serif'}}>{i?Math.max(0,unit.h-unit.d):unit.p}</text></g>)}</g></ScreenPixels>;
}
function FreshToken({item,geometry:g,p,start,end,door=false}:{item:PlacedOutcome;geometry:Geometry;p:number;start:number;end:number;door?:boolean}){
 const u=item.outcome.unit!,at=g.endingCards?.[item.outcome.seat+':'+key(u)]??item.to,s=size(at),t=easeInOut(phase(p,start,end));
 if(p<start)return null;
 return <ScreenPixels at={at} color="#c9d8aa" opacity={visible(p,start)}><g transform={`rotate(${u.x?10*t:0})`}>
  <g opacity={1-t}><path d={`M${-s.w/2-4} ${s.h/2} V${-s.h/2-5} H${s.w/2+4} V${s.h/2}`} fill="none" strokeWidth="2"/>{door?[-1,1].map(side=><rect key={side} x={side<0?-s.w/2-s.w*t/2:s.w*t/2} y={-s.h/2} width={s.w/2} height={s.h} fill="#25352b" strokeWidth="1"/>):[0,1,2].map(i=><path key={i} d={`M${-s.w/2-12*(1-t)} ${-s.h/2+(i+1)*s.h/4} H${s.w/2+12*(1-t)}`} strokeWidth="2"/>)}</g>
  <g opacity={phase(p,start+.04,end)}><CardGhost card={u} box={s}/><rect x={-s.w/2+3} y={-s.h/2+3} width={s.w-6} height="21" rx="2" fill="#26362b" stroke="none"/><text y={-s.h/2+11} textAnchor="middle" fill="#eff5d2" stroke="none" style={{font:'800 6px sans-serif'}}>{u.n.toUpperCase()}</text><text y={-s.h/2+20} textAnchor="middle" fill="#dbedb7" stroke="none" style={{font:'700 6px sans-serif'}}>{u.x?'CREATED · EXHAUSTED':'CREATED · READY'}</text>{[0,1].map(i=><g key={i} transform={`translate(${(i?1:-1)*(s.w/2-10)} ${s.h/2-12})`}><rect x="-10" y="-11" width="20" height="22" rx="3" fill={i?'#174772':'#8b2936'} stroke="#e0e8c5"/><text y="4" textAnchor="middle" fill="#fff" stroke="none" style={{font:'800 13px sans-serif'}}>{i?u.h:u.p}</text></g>)}</g>
 </g></ScreenPixels>;
}
function Fold({fold,geometry:g,p,start}:{fold:NonNullable<ReturnType<typeof exhaustProof>>;geometry:Geometry;p:number;start:number}){
 const at=g.cards?.[fold.t.seat+':'+key(fold.t.unit)]??fold.item.box,s=size(at);
 return <><ScreenPixels at={at} color="#a7cbea" opacity={envelope(p,start-.09,start-.03,start+.21)}><path d={`M${-s.w/2-5} -10 L${-s.w/2-5} 10 L${-s.w/2+3} 4 M${s.w/2+5} 10 L${s.w/2+5} -10 L${s.w/2-3} -4`} strokeWidth="2" fill="none"/></ScreenPixels>{fold.changed&&<><Mask at={at} p={p} start={start}/><UnitFace at={at} unit={fold.end} p={p} start={start} rotate/></>}</>;
}
function HandArrival({from,to,card,p,start,end,privateCard=false}:{from:EffectBox;to:EffectBox;card:CardRef;p:number;start:number;end:number;privateCard?:boolean}){
 const rail=1000-12/(from.sx??1),route=[from,{...from,x:rail},{...to,x:rail},to],arrival=start+(end-start)*.78,t=easeInOut(phase(p,start,arrival)),leg=Math.min(2,Math.floor(t*3)),at={...from,...mix(route[leg],route[leg+1],easeInOut(t*3-leg))},grow=easeInOut(phase(p,arrival,end)),s=size(to);
 return <><path d={route.map((point,i)=>`${i?'L':'M'}${point.x} ${point.y}`).join(' ')} fill="none" stroke="#c3d4e8" strokeWidth="1.5" opacity={envelope(p,start,start+.04,end+.08)}/><ScreenPixels at={at} opacity={visible(p,start)}><CardGhost card={card} back={privateCard&&p<arrival} box={{w:20+(s.w-20)*grow,h:28+(s.h-28)*grow}}/></ScreenPixels></>;
}
function Doorstep(props:Props){
 const{cue,geometry:g,p}=props,r=doorstepProof(cue,g);if(!r)return null;
 return <><Payment {...props}/><Receipt at={center(g)} rows={['THREE BATTLE DROIDS','CREATE DIRECTLY INTO PLAY · READY']} p={p} start={.06} until={.34}/>{r.creates.map((item,i)=><FreshToken key={item.key} item={item} geometry={g} p={p} start={.29+i*.06} end={.62+i*.06} door/>)}<Receipt at={center(g)} rows={['3 READY ACTIONS · 3 NEW BODIES','NO HAND OR DECK CARDS USED']} p={p} start={.8}/></>;
}
function Creative(props:Props){
 const{cue,geometry:g,p}=props,r=creativeProof(cue,g);if(!r)return null;
 return <><Payment {...props}/><Receipt at={center(g)} rows={['NON-UNIQUE UNIT · EXHAUST','INDEPENDENTLY CREATE ONE CLONE']} p={p} start={.06} until={.31}/>{r.fold&&<Fold fold={r.fold} geometry={g} p={p} start={.32}/>}<FreshToken item={r.creates[0]} geometry={g} p={p} start={.32} end={.69}/><Receipt at={center(g)} rows={[r.fold?.changed?`${r.fold.t.seat.toUpperCase()} UNIT EXHAUSTED`:r.fold?'CHOSEN UNIT ALREADY EXHAUSTED':'NO UNIT EXHAUSTED','1 CLONE CREATED · EXHAUSTED']} p={p} start={.79}/></>;
}
function Pursuit(props:Props){
 const{cue,geometry:g,p}=props,r=pursuitProof(cue,g);if(!r)return null;const from=g.cards?.[r.first.t.seat+':'+key(r.first.t.unit)]??r.first.item.box,to=r.second&&(g.cards?.[r.second.t.seat+':'+key(r.second.t.unit)]??r.second.item.box);
 return <><Payment {...props}/><Receipt at={center(g)} rows={['FIRST · EXHAUST FRIENDLY UNIT','SUCCESS ENABLES ENEMY EXHAUST']} p={p} start={.06} until={.28}/><Fold fold={r.first} geometry={g} p={p} start={.28}/>{r.first.changed&&to&&<path d={`M${from.x} ${from.y} Q${500} ${(from.y+to.y)/2} ${to.x} ${to.y}`} fill="none" stroke="#a3cbe8" strokeDasharray="4 5" strokeWidth="2" pathLength="1" strokeDashoffset={1-phase(p,.4,.54)} opacity={envelope(p,.4,.46,.62)}/>}<Receipt at={center(g)} rows={[r.first.changed?'FRIENDLY EXHAUST SUCCEEDED':'FRIENDLY ALREADY EXHAUSTED',r.second?'THEN · ENEMY UNIT':r.first.changed?'NO ENEMY EXHAUSTION':'SECOND CLAUSE DOES NOT RESOLVE']} p={p} start={.4} until={.64}/>{r.second&&<Fold fold={r.second} geometry={g} p={p} start={.55}/>}<Receipt at={center(g)} rows={[r.second?.changed?'BOTH UNITS EXHAUSTED':r.second?'ENEMY ALREADY EXHAUSTED':'NO ENEMY CHANGE','STATS, WOUNDS AND OWNERS KEPT']} p={p} start={.79}/></>;
}
function Wartime(props:Props){
 const{cue,geometry:g,p}=props,r=wartimeProof(cue,g);if(!r)return null;const hub=center(g),shown=r.op.looked.slice(0,10),row=shift(hub,0,6);
 return <><Payment {...props}/><Receipt at={hub} rows={[`${r.count} UNIT DEFEATS · THIS PHASE`,`PRIVATE LOOK AT TOP ${r.op.looked.length}`]} p={p} start={.06} until={.26}/>
 <ScreenPixels at={row} color="#c8d9bd" opacity={visible(p,.29)*(1-phase(p,.52,.57))}><text y="-20" textAnchor="middle" fill="currentColor" stroke="none" style={{font:'700 8px sans-serif'}}>PRIVATE TOP {r.op.looked.length}</text>{shown.map((card,i)=><g key={key(card)} transform={`translate(${(i-(shown.length-1)/2)*25} 0)`}><CardGhost back box={{w:19,h:27}}/>{r.op.selectedIds.includes(key(card))&&<rect x="-11" y="-15" width="22" height="30" rx="3" fill="none" strokeWidth="2"/>}</g>)}</ScreenPixels>
 {r.cards.map(card=>{const index=r.op.looked.findIndex(c=>same(c,card)),from=shift(row,(Math.min(index,9)-(shown.length-1)/2)*25,0),to=g.endingCards?.[cue.seat+':'+key(card)]??r.draw!.to;return <HandArrival key={key(card)} from={from} to={to} card={card} p={p} start={.52} end={.8} privateCard/>;})}
 <Receipt at={hub} rows={[`DRAW ${r.cards.length} · HAND`,`${r.op.looked.length-r.cards.length} UNCHOSEN · RANDOM BOTTOM`]} p={p} start={.84}/></>;
}
function Clear(props:Props){
 const{cue,geometry:g,p}=props,r=clearProof(cue,g);if(!r)return null;const hub=center(g);
 return <><Payment {...props}/><Receipt at={hub} rows={[`${r.group.title.toUpperCase()} · TITLE MATCH`,`SELECTED COST ${r.group.selectedPrintedCost} ≤ 3`]} p={p} start={.06} until={.32}/>{r.returns.map(({item,t},i)=>{const from=g.cards?.[t.seat+':'+key(t.unit)]??item.from,to=g.endingCards?.[t.unit.owner+':'+key(t.unit)]??item.to;return <g key={item.key}><ScreenPixels at={from} opacity={envelope(p,.13,.2,.34)} color="#c3d3e5"><path d="M-19 -16 H19 M-19 -10 H19" strokeWidth="2"/></ScreenPixels><Mask at={from} p={p} start={.34}/>{t.unit.t?<ScreenPixels at={from} color="#d2c9b1" opacity={envelope(p,.34,.38,.61)}><path d="M-12 -12 L12 12 M12 -12 L-12 12" strokeWidth="3"/></ScreenPixels>:<HandArrival from={from} to={to} card={t.unit} p={p} start={.35+i*.025} end={.72+i*.025}/>}</g>;})}<Receipt at={hub} rows={seats.map(s=>`OWNER ${s.toUpperCase()} HAND +${r.returns.filter(x=>x.t.unit.owner===s&&!x.t.unit.t).length}`)} p={p} start={.83}/></>;
}
export function BatchA12SecondarySignature(props:Props){switch(props.cue.definition.id){case'wartime-profiteering':return <Wartime {...props}/>;case'on-the-doorstep':return <Doorstep {...props}/>;case'clear-the-field':return <Clear {...props}/>;case'creative-thinking':return <Creative {...props}/>;case'in-pursuit':return <Pursuit {...props}/>;default:return null;}}
