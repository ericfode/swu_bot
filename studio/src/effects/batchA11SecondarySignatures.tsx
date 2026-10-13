import type { CardRef, Seat, UnitRef } from '../data/types';
import type { CardEffectCue } from './types';
import { A11_DEFINITIONS } from './batchA11';
import { previewPlayCost } from './previewCosts';
import { easeInOut, envelope, phase } from './animationTimeline';
import { CardGhost, CountedMarks, ResourceBalance, ResourceSlot, ScreenPixels, mix, screenShift as shift, type EffectBox, type PlacedOutcome } from './primitives';

type Geometry = { source: EffectBox; target: EffectBox; friendlyBase: EffectBox; outcomes: PlacedOutcome[]; zones: Record<string, EffectBox>; cards?: Record<string, EffectBox>; endingCards?: Record<string, EffectBox>; resourceCards?: Record<string, EffectBox> };
type Props = { cue: CardEffectCue; geometry: Geometry; p: number };
const seats: Seat[] = ['p1','p2'];
const ids=new Set(['bold-resistance','daring-raid','grenade-strike','blood-sport','strategic-analysis']);
export const isBatchA11Secondary=(cue:CardEffectCue)=>ids.has(cue.definition.id);
const key=(c?:CardRef|null)=>c?.id??'';
const same=(a?:CardRef|null,b?:CardRef|null)=>!!a?.id&&a.id===b?.id;
const refEqual=(a?:CardRef|null,b?:CardRef|null)=>same(a,b)&&a?.s===b?.s&&a?.n===b?.n&&a?.owner===b?.owner;
const ordered=(a:CardRef[],b:CardRef[])=>a.length===b.length&&a.every((c,i)=>refEqual(c,b[i]));
const exact=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const sourceProof=(cue:CardEffectCue,i:PlacedOutcome)=>refEqual(i.outcome.sourceCard,cue.source)&&!i.outcome.requiresDefeat&&!i.outcome.requiresReturn&&!i.outcome.requiresExhaust&&!i.outcome.traitCondition&&!i.outcome.attackId&&i.outcome.attackIndex===undefined;
const size=(at:EffectBox)=>at.cardSize??{w:at.w*(at.sx??1),h:at.h*(at.sy??1)};
const visible=(p:number,start:number)=>phase(p,start,start+.045);
const bounded=(at:EffectBox,w=220,h=42):EffectBox=>({...at,x:Math.max((w/2+8)/(at.sx??1),Math.min(1000-(w/2+8)/(at.sx??1),at.x)),y:Math.max((h/2+40)/(at.sy??1),Math.min(600-(h/2+122)/(at.sy??1),at.y))});
const center=(g:Geometry)=>{const upper=g.zones['p2:ground'],base=g.zones['p1:base'];return bounded({...g.source,x:500,y:upper&&base?(upper.y+upper.h/2+base.y-base.h/2)/2:300});};
function eventProof(cue:CardEffectCue){
 const canonical=A11_DEFINITIONS.find(d=>d.id===cue.definition.id);
 if(!canonical||!cue.transition||cue.transition.before.initiative!==cue.transition.after.initiative||cue.transition.before.round!==cue.transition.after.round||cue.transition.before.phase!==cue.transition.after.phase||cue.stage||!cue.source?.id||cue.definition.name!==canonical.name||cue.definition.setCode!==canonical.setCode||cue.source.n!==canonical.name||cue.source.s!==canonical.setCode||cue.source.owner!==cue.seat||cue.playPayment?.kind!=='resources'||cue.playPayment.exploit||cue.playPayment.smuggle)return false;
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
function boldProof(cue:CardEffectCue,g:Geometry){
 if(!eventProof(cue)||!cue.transition||g.outcomes.length<1||g.outcomes.length>3||!pocketsMatch(cue))return;
 const shared=g.outcomes[0].outcome.sharedTrait;if(!shared?.id||!shared.trait||shared.units.length!==g.outcomes.length||new Set(shared.units.map(u=>u.id)).size!==shared.units.length)return;
 const members:{item:PlacedOutcome;old:UnitRef;end:UnitRef;seat:Seat}[]=[],changes=new Map<string,UnitRef|null>();
 for(const item of g.outcomes){const o=item.outcome,t=locate(cue,o.card),w=shared.units.find(w=>w.id===o.card?.id);
  if(!t||!w||!t.unit.incarnation||w.incarnation!==t.unit.incarnation||!t.unit.traits?.includes(shared.trait)||o.kind!=='buff'||o.prevented||o.duration!=='phase'||o.amount!=='+2/+0'||o.seat!==t.seat||o.zone!==t.zone||o.incarnation!==t.unit.incarnation||!exact(o.card,t.unit)||!sourceProof(cue,item)||!exact(shared,o.sharedTrait)||changes.has(key(t.unit)))return;
  const old=t.unit,end={...old,p:old.p+2,status:[...(old.status??[]),{kind:'buff' as const,label:'+2/+0 · phase',duration:'phase' as const}]};changes.set(key(old),end);members.push({item,old,end,seat:t.seat});
 }
 if(!boardMatches(cue,changes))return;return{members,shared,items:g.outcomes};
}
function drawProof(cue:CardEffectCue,g:Geometry){
 if(!eventProof(cue)||!cue.transition||g.outcomes.length!==1)return;
 const item=g.outcomes[0],o=item.outcome,b=cue.transition.before.players[cue.seat],cards=o.cards;
 if(o.kind!=='draw'||o.prevented||o.seat!==cue.seat||o.fromSeat!==cue.seat||o.fromZone!=='deck'||o.zone!=='hand'||!sourceProof(cue,item)||o.amount!==3||cards?.length!==3||cards.some(c=>!c.id||c.owner!==cue.seat)||new Set(cards.map(key)).size!==3||b.knownDeck?.length!==b.deck||!ordered(cards,b.knownDeck.slice(0,3))||!boardMatches(cue,new Map())||!pocketsMatch(cue,[],cards))return;
 return{item,cards,before:b,after:cue.transition.after.players[cue.seat],items:g.outcomes};
}
function baseRaidProof(cue:CardEffectCue,g:Geometry){
 if(!eventProof(cue)||!cue.transition||g.outcomes.length!==1)return;
 const item=g.outcomes[0],o=item.outcome,b=cue.transition.before.players[o.seat].base;
 if(o.kind!=='damage'||o.zone!=='base'||o.damageType!=='ability'||o.prevented||o.attackId||o.resolutionGroup||o.amount!==2||!sourceProof(cue,item)||!refEqual(o.card,b)||!pocketsMatch(cue)||!boardMatches(cue,new Map(),{seat:o.seat,damage:b.d+2}))return;
 return{item,old:b,end:cue.transition.after.players[o.seat].base,items:g.outcomes};
}
function damageProof(cue:CardEffectCue,g:Geometry,mode:'raid'|'grenade'|'ground'){
 if(!eventProof(cue)||!cue.transition)return;
 const hits=g.outcomes.filter(i=>i.outcome.kind==='damage'),deaths=g.outcomes.filter(i=>i.outcome.kind==='defeat'),changes=new Map<string,UnitRef|null>(),members:{item:PlacedOutcome;t:Located;amount:number;end:UnitRef;death?:PlacedOutcome}[]=[],departures:Located[]=[];
 if(g.outcomes.length!==hits.length+deaths.length||g.outcomes.some(i=>i.outcome.prevented)||!hits.length||mode==='raid'&&hits.length!==1||mode==='grenade'&&![1,2].includes(hits.length))return;
 const group=hits[0].outcome.resolutionGroup;
 if(!group?.id||group.mode!=='simultaneous'||g.outcomes.some(i=>!exact(i.outcome.resolutionGroup,group))||deaths.some(d=>g.outcomes.indexOf(d)<g.outcomes.indexOf(hits.at(-1)!)))return;
 for(const [index,item]of hits.entries()){
  const o=item.outcome,t=locate(cue,o.card),amount=mode==='grenade'?(index===0?2:1):2;
  if(!t||!t.unit.incarnation||!t.unit.owner||o.seat!==t.seat||o.zone!==t.zone||o.incarnation!==t.unit.incarnation||!exact(t.unit,o.card)||o.amount!==amount||o.damageType!=='ability'||o.attackId||!sourceProof(cue,item)||changes.has(key(t.unit))||t.unit.u?.length||t.unit.cap?.length)return;
  const end={...t.unit,d:t.unit.d+amount},matching=deaths.filter(d=>same(d.outcome.card,t.unit)),lethal=end.d>=end.h,death=matching[0];
  if(lethal){
   if(matching.length!==1||!death||!exact(death.outcome.card,t.unit)||death.outcome.incarnation!==t.unit.incarnation||death.outcome.seat!==t.seat||death.outcome.ownerSeat!==t.unit.owner||death.outcome.zone!==t.zone||!sourceProof(cue,death)||seats.some(s=>same(cue.transition!.before.players[s].leader,t.unit)))return;
   changes.set(key(t.unit),null);departures.push(t);
  }else{
   // This signature has wound receipts, but no independently established resting-power change.
   // Current Grit changes both; do not suppress the generic evidence behind stale power.
   if(matching.length||t.unit.s==='SOR_032'||t.unit.status?.some(status=>status.keyword?.name==='Grit'))return;
   changes.set(key(t.unit),end);
  }
  members.push({item,t,amount,end,death});
 }
 if(deaths.length!==departures.length||mode==='grenade'&&members.some(m=>m.t.zone!==members[0].t.zone))return;
 if(mode==='ground'){const all=seats.flatMap(s=>cue.transition!.before.players[s].ground);if(all.length!==members.length||members.some(m=>m.t.zone!=='ground')||all.some(u=>!changes.has(key(u))))return;}
 if(!boardMatches(cue,changes)||!pocketsMatch(cue,departures))return;
 return{members,departures,items:g.outcomes,group};
}
export function batchA11SecondaryCovers(cue:CardEffectCue,g:Geometry,item:PlacedOutcome):boolean{
 switch(cue.definition.id){case'bold-resistance':return boldProof(cue,g)?.items.includes(item)??false;case'strategic-analysis':return drawProof(cue,g)?.items.includes(item)??false;case'daring-raid':return(baseRaidProof(cue,g)??damageProof(cue,g,'raid'))?.items.includes(item)??false;case'grenade-strike':return damageProof(cue,g,'grenade')?.items.includes(item)??false;case'blood-sport':return damageProof(cue,g,'ground')?.items.includes(item)??false;default:return false;}
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
function Counters({at,unit,p,start}:{at:EffectBox;unit:UnitRef;p:number;start:number}){const s=size(at);return <>{(['power','hp']as const).map((n,i)=>{const c=at.counters?.[n];return <ScreenPixels key={n} at={c?{...at,...c}:shift(at,(i?1:-1)*(s.w/2-10),s.h/2-12)} opacity={visible(p,start)}><rect x="-11" y="-12" width="22" height="24" rx="3" fill={i?'#174772':'#8b2936'} stroke="#e1e7e6"/><text y="4" textAnchor="middle" fill="#fff" stroke="none" style={{font:'800 14px sans-serif'}}>{i?Math.max(0,unit.h-unit.d):unit.p}</text></ScreenPixels>;})}</>;}
function Bold(props:Props){
 const {cue,geometry:g,p}=props,r=boldProof(cue,g);if(!r)return null;const seal=center(g);
 return <><Payment {...props}/><Receipt at={seal} rows={[`ONE SHARED TRAIT · ${r.shared.trait.toUpperCase()}`,`${r.members.length} CHOSEN UNITS · EITHER SIDE`]} p={p} start={.05} until={.47}/>
  {r.members.map((m,i)=>{const at=g.cards?.[m.seat+':'+key(m.old)]??m.item.box,s=size(at);return <g key={key(m.old)}>
   <path d={`M${seal.x} ${seal.y} L${at.x} ${at.y}`} stroke="#deb886" strokeDasharray="3 6" strokeWidth="1.5" opacity={envelope(p,.16+i*.02,.26+i*.02,.47)}/>
   <ScreenPixels at={at} opacity={envelope(p,.16+i*.02,.31,.62)} color="#e9bd80"><path d={`M${-s.w/2-4} ${-s.h/2+8} V${-s.h/2-4} H${s.w/2+4} V${-s.h/2+8}`} strokeWidth="2" fill="none"/><path d={`M${-s.w/2-4} ${s.h/2-8} V${s.h/2+4} H${s.w/2+4} V${s.h/2-8}`} strokeWidth="2" fill="none"/></ScreenPixels>
   <Counters at={at} unit={m.end} p={p} start={.48+i*.025}/>
  </g>;})}<Receipt at={seal} rows={['+2 POWER · THIS PHASE','HP, WOUNDS AND READINESS KEPT']} p={p} start={.69}/></>;
}
function Raid(props:Props){
 const {cue,geometry:g,p}=props,r=baseRaidProof(cue,g);if(!r)return <Damage {...props} mode="raid"/>;
 const at=g.zones[r.item.outcome.seat+':base']??r.item.box,numeral=at.stat?{...at,...at.stat}:at,hub=center(g),own=r.item.outcome.seat===cue.seat;
 return <><Payment {...props}/><Receipt at={hub} rows={[`${own?'OWN':'OPPONENT'} BASE · CHOSEN TARGET`,'2 ABILITY DAMAGE']} p={p} start={.06} until={.45}/>
  <ScreenPixels at={at} color="#e3a36e" opacity={envelope(p,.24,.38,.61)}><path d="M-36 -16 L-23 0 L-36 16 M36 -16 L23 0 L36 16" fill="none" strokeWidth="4"/><circle r={28+16*phase(p,.39,.61)} fill="none" strokeWidth="2" opacity={1-phase(p,.43,.63)}/></ScreenPixels>
  <ScreenPixels at={numeral} color="#f0b18a" opacity={visible(p,.43)}><circle r="23" fill="#07101b" strokeWidth="3"/><text y="5" textAnchor="middle" fill="#fff" stroke="none" style={{font:'800 17px sans-serif'}}>{Math.max(0,r.end.hp-r.end.d)}</text></ScreenPixels>
  <Receipt at={hub} rows={[`BASE WOUNDS ${r.old.d} → ${r.end.d}`,'NO ATTACK · ALL UNITS STAY']} p={p} start={.66}/></>;
}
function Damage(props:Props&{mode:'raid'|'grenade'|'ground'}){
 const {cue,geometry:g,p,mode}=props,r=damageProof(cue,g,mode);if(!r)return null;const hub=center(g),impact=.45,depart=.6,tokenCount=r.departures.filter(t=>t.unit.t).length;
 const intro=mode==='ground'?[`${r.members.length} GROUND UNITS · BOTH PLAYERS`,'2 EACH · SPACE UNITS UNTOUCHED']:mode==='grenade'?[`${r.members[0].t.zone.toUpperCase()} · FIRST 2${r.members.length===2?' + CHOSEN SECOND 1':''}`,r.members.length===2?'DIFFERENT UNITS · SAME ARENA':'NO SECOND TARGET']:['CHOSEN UNIT · EITHER SIDE','2 ABILITY DAMAGE'];
 return <><Payment {...props}/><Receipt at={hub} rows={intro} p={p} start={.06} until={.4}/>
  {mode==='ground'&&seats.map(seat=>{const zone=g.zones[seat+':ground'];return zone?<rect key={seat} x={zone.x-zone.w/2} y={zone.y-zone.h/2} width={zone.w} height={zone.h} rx="9" fill="#7d381a" fillOpacity={.06*envelope(p,.22,.39,.58)} stroke="#db9e74" strokeWidth="2" opacity={envelope(p,.2,.38,.61)}/>:null;})}
  {r.members.map((m,i)=>{const at=g.cards?.[m.t.seat+':'+key(m.t.unit)]??m.item.box,s=size(at);return <g key={key(m.t.unit)}>
   <ScreenPixels at={at} color="#efb477" opacity={envelope(p,.23,.36,impact+.17)}><path d={`M${-s.w/2-4} ${-s.h/2} H${s.w/2+4} M${-s.w/2-4} ${s.h/2} H${s.w/2+4}`} strokeWidth="2"/><circle r={12+22*phase(p,impact-.06,impact+.15)} fill="none" strokeWidth="2" opacity={1-phase(p,impact+.01,impact+.18)}/><CountedMarks count={m.amount} gap={12} radius={4} color="#f0ba85"/></ScreenPixels>
   {(!m.death||p<depart)&&<Counters at={at} unit={m.end} p={p} start={impact}/>}
   {m.death&&<><Mask at={at} p={p} start={depart}/>{m.t.unit.t?<ScreenPixels at={at} opacity={envelope(p,depart,depart+.035,.8)} color="#d0b8a0"><path d="M-12 -12 L12 12 M12 -12 L-12 12" strokeWidth="3"/><circle r={12+20*phase(p,depart,.81)} strokeDasharray="3 7" strokeWidth="2" fill="none"/></ScreenPixels>:<CompactDiscardRoute from={at} to={g.zones[m.t.unit.owner+':discard']??m.death.to} card={m.t.unit} p={p} start={depart+i*.012} end={.81+i*.012}/>}</>}
  </g>;})}
  <Receipt at={hub} rows={mode==='ground'?[`${r.departures.length-tokenCount} TO OWNER DISCARD${tokenCount?` · ${tokenCount} TOKEN CEASES`:''}`,'GROUND WOUNDS HELD · SPACE STAYS']:mode==='grenade'?['DECLARED HITS RESOLVE TOGETHER',`${r.departures.length} DEFEATED · SURVIVORS KEEP WOUNDS`]:['2 WOUNDS APPLIED',r.departures.length?'UNIT TO OWNER DISCARD':'UNIT STAYS · WOUNDS HELD']} p={p} start={.85}/></>;
}
function DrawArrival({item,card,to,p,start,end}:{item:PlacedOutcome;card:CardRef;to:EffectBox;p:number;start:number;end:number}){
 const from=item.from,rail=1000-12/(from.sx??1),approach=shift(from,0,24),points=[from,approach,{...approach,x:rail},{...to,x:rail},to],arrival=start+(end-start)*.79,t=easeInOut(phase(p,start,arrival)),segment=Math.min(3,Math.floor(t*4)),at={...from,...mix(points[segment],points[segment+1],easeInOut(t*4-segment))},grown=easeInOut(phase(p,arrival,end)),s=size(to);
 return <><path d={points.map((pt,i)=>`${i?'L':'M'}${pt.x} ${pt.y}`).join(' ')} stroke="#bfcfb8" strokeWidth="1.5" opacity={envelope(p,start,start+.04,end+.06)}/><ScreenPixels at={at} opacity={visible(p,start)}><CardGhost card={card} back={p<arrival} box={{w:20+(s.w-20)*grown,h:28+(s.h-28)*grown}}/></ScreenPixels></>;
}
function Analysis(props:Props){
 const {cue,geometry:g,p}=props,r=drawProof(cue,g);if(!r)return null;const hub=center(g);
 return <><Payment {...props}/><Receipt at={hub} rows={['ANALYSIS · DRAW 3','YOUR DECK → YOUR HAND']} p={p} start={.06} until={.41}/>
  <ScreenPixels at={r.item.from} opacity={envelope(p,.2,.31,.63)} color="#ced8a4"><path d="M-21 -15 H21 V15 H-21 Z M-15 -7 H15 M-15 0 H15 M-15 7 H15" strokeWidth="1.5" fill="none"/></ScreenPixels>
  {r.cards.map((card,i)=>{const to=g.endingCards?.[cue.seat+':'+key(card)]??r.item.to;return <DrawArrival key={key(card)} item={r.item} card={card} to={to} p={p} start={.25+i*.055} end={.69+i*.055}/>;})}
  <Receipt at={hub} rows={['3 CARDS ENTER YOUR HAND',`DECK ${r.before.deck} → ${r.after.deck}`]} p={p} start={.85}/></>;
}
export function BatchA11SecondarySignature(props:Props){switch(props.cue.definition.id){case'bold-resistance':return <Bold {...props}/>;case'daring-raid':return <Raid {...props}/>;case'grenade-strike':return <Damage {...props} mode="grenade"/>;case'blood-sport':return <Damage {...props} mode="ground"/>;case'strategic-analysis':return <Analysis {...props}/>;default:return null;}}
