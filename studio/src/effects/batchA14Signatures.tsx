import type { BaseDamageProtection, CardRef, Seat, Snapshot, UnitRef } from '../data/types';
import type { CardEffectCue, CardEffectOutcome } from './types';
import { A14_DEFINITIONS } from './batchA14';
import { previewPlayCost } from './previewCosts';
import { easeInOut, envelope, phase } from './animationTimeline';
import { CardGhost, ResourceBalance, ResourceSlot, ScreenPixels, mix, screenShift as shift, type EffectBox, type PlacedOutcome } from './primitives';

type Geometry = { source: EffectBox; target: EffectBox; friendlyBase: EffectBox; outcomes: PlacedOutcome[]; zones: Record<string, EffectBox>; cards?: Record<string, EffectBox>; endingCards?: Record<string, EffectBox>; intermediateCards?: Record<string, EffectBox>; resourceCards?: Record<string, EffectBox> };
type Props = { cue: CardEffectCue; geometry: Geometry; p: number };
const seats: Seat[] = ['p1', 'p2'];
const ids = new Set(['private-manufacturing', 'no-glory-only-results', 'close-the-shield-gate', 'covering-the-wing', 'in-the-heat-of-battle']);
export const isBatchA14 = (cue: CardEffectCue) => ids.has(cue.definition.id);
const key = (c?: CardRef | null) => c?.id ?? '';
const same = (a?: CardRef | null, b?: CardRef | null) => !!a?.id && a.id === b?.id;
const refEqual = (a?: CardRef | null, b?: CardRef | null) => same(a, b) && a?.n === b?.n && a?.s === b?.s && a?.owner === b?.owner;
const exact = (a: unknown, b: unknown): boolean => {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => exact(v, b[i]));
    const x = a as Record<string, unknown>, y = b as Record<string, unknown>, keys = Object.keys(x);
    return keys.length === Object.keys(y).length && keys.every(k => Object.prototype.hasOwnProperty.call(y, k) && exact(x[k], y[k]));
};
const ordered = (a: CardRef[], b: CardRef[]) => a.length === b.length && a.every((c, i) => refEqual(c, b[i]));
const units = (s: Snapshot, seat: Seat) => [...s.players[seat].ground, ...s.players[seat].space];
const refs = (s: Snapshot) => seats.flatMap(seat => { const p = s.players[seat]; return [p.base, ...(p.leader ? [p.leader] : []), ...p.hand, ...p.discard, ...(p.resources ?? []), ...(p.knownDeck ?? []), ...units(s, seat), ...units(s, seat).flatMap(u => [...(u.u ?? []), ...(u.cap ?? [])])]; });
const allowed = (o: CardEffectOutcome, extra: string[]) => Object.keys(o).every(k => ['kind', 'card', 'seat', 'zone', 'sourceCard', 'incarnation', 'prevented', 'label', ...extra].includes(k));
const eventSource = (cue: CardEffectCue, o: CardEffectOutcome) => refEqual(cue.source, o.sourceCard) && !o.prevented;
const size = (at: EffectBox) => { const s=at.cardSize ?? { w: at.w*(at.sx??1), h:at.h*(at.sy??1) }; return {w:Math.max(12,s.w),h:Math.max(12,s.h)}; };
const visible = (p: number, start: number) => phase(p, start, start + .045);
function locate(cue: CardEffectCue, c?: CardRef | null) {
    if (!c?.id || !cue.transition) return;
    const found = seats.flatMap(seat => (['ground', 'space'] as const).flatMap(zone => cue.transition!.before.players[seat][zone].filter(u => same(u, c)).map(unit => ({ unit, seat, zone }))));
    return found.length === 1 && found[0].unit.incarnation && found[0].unit.d < found[0].unit.h ? found[0] : undefined;
}
type Located = NonNullable<ReturnType<typeof locate>>;
function paidState(cue: CardEffectCue) {
    const d = A14_DEFINITIONS.find(d => d.id === cue.definition.id), t = cue.transition;
    if (!d || !t || !seats.includes(cue.seat) || cue.stage || cue.definition.name !== d.name || cue.definition.setCode !== d.setCode || !cue.source?.id || cue.source.n !== d.name || cue.source.s !== d.setCode || cue.source.owner !== cue.seat || t.before.phase !== 'action'
        || t.before.round !== t.after.round || t.before.phase !== t.after.phase || t.before.initiative !== t.after.initiative || cue.playPayment?.kind !== 'resources' || cue.playPayment.exploit || cue.playPayment.smuggle) return;
    if (t.before.players[cue.seat].hand.filter(c => refEqual(c, cue.source)).length !== 1 || refs(t.before).filter(c => same(c, cue.source)).length !== 1 || refs(t.after).filter(c => same(c, cue.source)).length !== 1) return;
    let cost: number; try { cost = previewPlayCost(d, t.before, cue.seat, cue.playPayment); } catch { return; }
    const paid = cue.playPayment.cardIds;
    if (!paid || cue.playCost !== cost || paid.length !== cost || new Set(paid).size !== cost || !seats.every(seat => {
        const p = t.before.players[seat]; return !!p.resources && p.resources.length === p.res.total && p.resources.filter(r => !r.x).length === p.res.ready;
    }) || !paid.every(id => t.before.players[cue.seat].resources!.some(r => r.id === id && !r.x))) return;
    const result = structuredClone(t.before), p = result.players[cue.seat];
    p.resources = p.resources!.map(r => paid.includes(key(r)) ? { ...r, x: 1 } : r); p.res.ready -= cost;
    p.hand = p.hand.filter(c => !same(c, cue.source)); p.discard.push(cue.source);
    return result;
}
function ending(cue: CardEffectCue, expected: Snapshot) {
    if (!cue.transition) return false;
    for (const seat of seats) {
        const e = expected.players[seat], a = cue.transition.after.players[seat];
        if (!ordered(e.hand, a.hand) || !ordered(e.discard, a.discard) || !ordered(e.knownDeck ?? [], a.knownDeck ?? [])) return false;
        e.hand = a.hand; e.discard = a.discard; e.knownDeck = a.knownDeck;
    }
    return exact(expected, cue.transition.after);
}
function replace(s: Snapshot, t: Located, next: UnitRef) { s.players[t.seat][t.zone] = s.players[t.seat][t.zone].map(u => same(u, t.unit) ? next : u); }

type BodyFact={name:string;title:string;traits:string[];keywords:string[];zone:'ground'|'space';token?:boolean};
// Limited face/type facts verified directly against the installed card JSON.
const bodies:Record<string,BodyFact>={
 SOR_095:{name:'Battlefield Marine',title:'Battlefield Marine',traits:['rebel','trooper'],keywords:[],zone:'ground'},
 SOR_098:{name:'Echo Base Defender',title:'Echo Base Defender',traits:['rebel','trooper'],keywords:['sentinel'],zone:'ground'},
 SOR_237:{name:'Alliance X-Wing',title:'Alliance X-Wing',traits:['rebel','vehicle','fighter'],keywords:[],zone:'space'},
 SOR_033:{name:'Death Trooper',title:'Death Trooper',traits:['imperial','trooper'],keywords:[],zone:'ground'},
 SOR_164:{name:'Wampa',title:'Wampa',traits:['creature'],keywords:['overwhelm'],zone:'ground'},
 SOR_225:{name:'TIE/ln Fighter',title:'TIE/ln Fighter',traits:['imperial','vehicle','fighter'],keywords:[],zone:'space'},
 SEC_250:{name:'Rebel Pathfinder',title:'Rebel Pathfinder',traits:['rebel','trooper'],keywords:['saboteur'],zone:'ground'},
 'Battle Droid':{name:'Battle Droid',title:'Battle Droid',traits:['separatist','droid','trooper'],keywords:[],zone:'ground',token:true},
 'Clone Trooper':{name:'Clone Trooper',title:'Clone Trooper',traits:['republic','clone','trooper'],keywords:[],zone:'ground',token:true},
 'X-Wing':{name:'X-Wing',title:'X-Wing',traits:['vehicle','fighter'],keywords:[],zone:'space',token:true},
};
const body=(u:UnitRef)=>u.s?bodies[u.s]:u.t===1?bodies[u.n]:undefined;
function knownBody(t:Located){const u=t.unit,f=body(u);return !!f&&u.n===f.name&&u.printedTitle===f.title&&u.unique===false&&u.leaderUnit===false&&!!u.owner&&seats.includes(u.owner)&&exact(u.traits,f.traits)&&t.zone===f.zone&&!!f.token===(u.t===1)&&Number.isSafeInteger(u.p)&&u.p>=0&&Number.isSafeInteger(u.h)&&u.h>0&&Number.isSafeInteger(u.d)&&u.d>=0&&u.d<u.h;}
const faceCards:Record<string,string>={SOR_074:'Repair',SOR_077:'Takedown',SOR_095:'Battlefield Marine',SOR_237:'Alliance X-Wing',SOR_098:'Echo Base Defender'};
const knownFace=(c:CardRef)=>!!c.id&&!!c.s&&faceCards[c.s]===c.n;
function boundaryState(cue:CardEffectCue,stage:'next-action'|'phase-end'){
 const d=A14_DEFINITIONS.find(d=>d.id===cue.definition.id),t=cue.transition;
 if(!d||!t||!seats.includes(cue.seat)||cue.stage!==stage||cue.definition.name!==d.name||cue.definition.setCode!==d.setCode||!cue.source?.id||cue.source.n!==d.name||cue.source.s!==d.setCode||cue.source.owner!==cue.seat||cue.playCost!==undefined||cue.playPayment!==undefined||t.before.phase!=='action'||t.before.round!==t.after.round||t.before.phase!==t.after.phase||t.before.initiative!==t.after.initiative
  ||t.before.players[cue.seat].discard.filter(c=>refEqual(c,cue.source)).length!==1||refs(t.before).filter(c=>same(c,cue.source)).length!==1||refs(t.after).filter(c=>same(c,cue.source)).length!==1)return;
 return structuredClone(t.before);
}
function manufactureProof(cue:CardEffectCue,g:Geometry){
 const expected=paidState(cue);if(!expected||!cue.transition)return;
 const draw=g.outcomes[0],o=draw?.outcome,player=expected.players[cue.seat],deck=player.knownDeck,drawn=deck?.slice(0,2);
 if(!o||!deck||deck.length!==player.deck||deck.length<2||!drawn||drawn.some(c=>!knownFace(c)||c.owner!==cue.seat)||new Set(refs(cue.transition.before).map(key)).size!==refs(cue.transition.before).length
  ||!allowed(o,['cards','fromSeat','fromZone','amount'])||!eventSource(cue,o)||o.kind!=='draw'||o.card!==null||o.seat!==cue.seat||o.fromSeat!==cue.seat||o.fromZone!=='deck'||o.zone!=='hand'||o.amount!==2||!exact(o.cards,drawn)||o.incarnation!==undefined)return;
 player.knownDeck=deck.slice(2);player.deck-=2;player.hand.push(...drawn);
 const controlled=units(cue.transition.before,cue.seat);
 // The condition concerns actual unit tokens, not an unverified token marker on a printed unit.
 if(controlled.some(unit=>{const t=locate(cue,unit);return !t||t.seat!==cue.seat||!knownBody(t);}))return;
 const intermediate=structuredClone(expected),tokens=controlled.filter(u=>u.t===1),moves=g.outcomes.slice(1);
 if(tokens.length)return !moves.length&&ending(cue,expected)?{draw,drawn,moves,intermediate,order:[],items:g.outcomes}:undefined;
 if(moves.length!==2)return;
 const w=moves[0].outcome.handBottom;
 if(!w?.id||w.player!==cue.seat||!exact(w.drawnIds,drawn.map(key))||!exact(w.tokenUnitIdsAtResolution,[])||w.selectedIds.length!==2||new Set(w.selectedIds).size!==2||w.order.length!==2||new Set(w.order).size!==2||w.order.some(id=>!w.selectedIds.includes(id))||!w.selectedIds.every(id=>player.hand.filter(c=>c.id===id&&c.owner===cue.seat).length===1))return;
 for(const [i,item] of moves.entries()){
  const c=item.outcome,selected=player.hand.find(x=>x.id===w.order[i]);
  if(!selected||!allowed(c,['fromSeat','fromZone','destination','ownerSeat','handBottom','selection','chooserSeat'])||!eventSource(cue,c)||c.kind!=='return'||!exact(c.card,selected)||c.seat!==cue.seat||c.fromSeat!==cue.seat||c.fromZone!=='hand'||c.zone!=='deck'||c.destination!=='deck-bottom'||c.ownerSeat!==cue.seat||c.selection!=='chosen'||c.chooserSeat!==cue.seat||!exact(c.handBottom,w)||c.incarnation!==undefined)return;
  player.hand=player.hand.filter(x=>!same(x,selected));player.knownDeck!.push(selected);player.deck++;
 }
 return ending(cue,expected)?{draw,drawn,moves,intermediate,order:w.order,items:g.outcomes}:undefined;
}
function gloryProof(cue:CardEffectCue,g:Geometry){
 const expected=paidState(cue);if(!expected||!cue.transition||g.outcomes.length!==2)return;
 const [control,death]=g.outcomes,c=control.outcome,o=death.outcome,t=locate(cue,c.card);
 if(!t||!knownBody(t)||t.unit.u?.length||t.unit.cap?.length||seats.some(s=>same(cue.transition!.before.players[s].leader,t.unit))||!allowed(c,['unit','fromSeat','fromZone','ownerSeat','duration','sequenceId','sequenceIndex'])||!refEqual(c.sourceCard,cue.source)||c.kind!=='control'||!exact(c.card,t.unit)||!exact(c.unit,t.unit)||c.seat!==cue.seat||c.fromSeat!==t.seat||c.fromZone!==t.zone||c.zone!==t.zone||c.ownerSeat!==t.unit.owner||c.incarnation!==t.unit.incarnation||c.duration!=='permanent'||!c.sequenceId||c.sequenceIndex!==1)return;
 if(c.prevented!==undefined&&c.prevented!==false&&c.prevented!==true)return;
 const controller=c.prevented?t.seat:cue.seat;
 if(controller!==t.seat){expected.players[t.seat][t.zone]=expected.players[t.seat][t.zone].filter(u=>!same(u,t.unit));expected.players[controller][t.zone].push(structuredClone(t.unit));}
 const intermediate=structuredClone(expected);
 if(!allowed(o,['fromSeat','fromZone','ownerSeat','sequenceId','sequenceIndex'])||!refEqual(o.sourceCard,cue.source)||o.kind!=='defeat'||!exact(o.card,t.unit)||o.seat!==controller||o.fromSeat!==controller||o.fromZone!==t.zone||o.zone!=='discard'||o.ownerSeat!==t.unit.owner||o.incarnation!==t.unit.incarnation||o.sequenceId!==c.sequenceId||o.sequenceIndex!==2||o.prevented!==undefined&&o.prevented!==false&&o.prevented!==true)return;
 if(!o.prevented){expected.players[controller][t.zone]=expected.players[controller][t.zone].filter(u=>!same(u,t.unit));if(!t.unit.t)expected.players[t.unit.owner!].discard.push(t.unit);if(expected.pending)expected.pending=expected.pending.filter(p=>p.targetId!==t.unit.id);}
 return ending(cue,expected)?{control,death,target:t,controller,intermediate,items:g.outcomes}:undefined;
}
function descriptor(e:BaseDamageProtection|undefined,cue:CardEffectCue,seat:Seat){const b=cue.transition!.before.players[seat].base;return !!e?.id&&exact(e,{id:e.id,sourceId:key(cue.source),baseId:key(b),seat,round:cue.transition!.before.round,phase:cue.transition!.before.phase,uses:1});}
function gateGrantProof(cue:CardEffectCue,g:Geometry){
 const expected=paidState(cue);if(!expected||g.outcomes.length!==1)return;
 const item=g.outcomes[0],o=item.outcome,op=o.baseProtection;if(!seats.includes(o.seat))return;const base=expected.players[o.seat].base;
 if(!allowed(o,['duration','baseProtection'])||!eventSource(cue,o)||o.kind!=='buff'||o.zone!=='base'||!exact(o.card,base)||o.duration!=='phase'||o.incarnation!==undefined||op?.operation!=='grant'||!descriptor(op.effect,cue,o.seat)||base.damageProtection?.length||seats.some(s=>expected.players[s].base.damageProtection?.some(e=>e.id===op.effect.id)))return;
 base.damageProtection=[op.effect];return ending(cue,expected)?{item,seat:o.seat,effect:op.effect,items:g.outcomes}:undefined;
}
function gateLaterProof(cue:CardEffectCue,g:Geometry){
 const expected=boundaryState(cue,'next-action');if(!expected||g.outcomes.length!==3)return;
 const [attack,exhaust,hit]=g.outcomes,a=attack.outcome,x=exhaust.outcome,h=hit.outcome;if(!seats.includes(a.seat))return;const t=locate(cue,a.sourceCard),base=expected.players[a.seat].base,op=h.baseProtection;
 if(!t||!knownBody(t)||t.unit.x||t.unit.p<=0||t.seat===a.seat||t.zone!=='space'||t.unit.status?.some(s=>s.kind==='suppressed'||s.keyword?.name==='Saboteur'||s.lostKeyword)||expected.players[a.seat].space.some(u=>u.sn)||!a.attackId)return;
 const effect=base.damageProtection?.find(e=>e.id===(op?.operation==='consume'?op.effectId:undefined));
 if(!descriptor(effect,cue,a.seat)||base.damageProtection?.length!==1||!allowed(a,['attackId','attackIndex','amount','combatOrder'])||a.prevented||a.kind!=='attack'||a.zone!=='base'||!exact(a.card,base)||!exact(a.sourceCard,t.unit)||a.incarnation!==t.unit.incarnation||a.attackIndex!==1||a.amount!==t.unit.p||a.combatOrder!=='simultaneous'
  ||!allowed(x,['attackId','attackIndex','amount'])||x.prevented||x.kind!=='exhaust'||x.seat!==t.seat||x.zone!==t.zone||!exact(x.card,t.unit)||!exact(x.sourceCard,t.unit)||x.incarnation!==t.unit.incarnation||x.attackId!==a.attackId||x.attackIndex!==1||x.amount!==1
  ||!allowed(h,['attackId','attackIndex','amount','damageType','baseProtection'])||h.prevented||h.kind!=='damage'||h.seat!==a.seat||h.zone!=='base'||!exact(h.card,base)||!exact(h.sourceCard,t.unit)||h.incarnation!==undefined||h.attackId!==a.attackId||h.attackIndex!==1||h.damageType!=='combat'||h.amount!==0||!exact(op,{operation:'consume',effectId:effect!.id,sourceId:key(cue.source),incoming:t.unit.p,prevented:t.unit.p,channel:'direct'}))return;
 replace(expected,t,{...t.unit,x:1});base.damageProtection=[];return ending(cue,expected)?{attack,exhaust,hit,attacker:t,seat:a.seat,effect:effect!,items:g.outcomes}:undefined;
}
function gateExpiryProof(cue:CardEffectCue,g:Geometry){
 const expected=boundaryState(cue,'phase-end');if(!expected)return;
 const active=seats.flatMap(seat=>(expected.players[seat].base.damageProtection??[]).filter(e=>e.sourceId===key(cue.source)).map(effect=>({effect,seat})));
 if(!active.length||active.length!==g.outcomes.length)return;
 for(const [i,item] of g.outcomes.entries()){const o=item.outcome,{effect,seat}=active[i],base=expected.players[seat].base;if(!descriptor(effect,cue,seat)||!allowed(o,['baseProtection'])||!eventSource(cue,o)||o.kind!=='buff'||o.seat!==seat||o.zone!=='base'||!exact(o.card,base)||o.incarnation!==undefined||!exact(o.baseProtection,{operation:'expire',effectId:effect.id,sourceId:key(cue.source)}))return;base.damageProtection=base.damageProtection!.filter(e=>e.id!==effect.id);}
 return ending(cue,expected)?{active,items:g.outcomes}:undefined;
}
function coverProof(cue:CardEffectCue,g:Geometry){
 const expected=paidState(cue);if(!expected||!cue.transition||g.outcomes.length<1||g.outcomes.length>2)return;
 const create=g.outcomes[0],o=create.outcome,u=o.unit;
 if(!u?.id||!u.incarnation||refs(cue.transition.before).some(c=>same(c,u))||u.incarnation===cue.transition.before.mostRecentIncarnations?.[u.id]||!allowed(o,['unit','ownerSeat','amount','tokenType','entryType','entersReady'])||!eventSource(cue,o)||o.kind!=='create'||o.seat!==cue.seat||o.zone!=='space'||o.ownerSeat!==cue.seat||o.amount!==1||o.tokenType!=='x-wing'||o.entryType!=='created'||o.entersReady!==false||o.incarnation!==u.incarnation||!exact(o.card,u)
  ||!exact(u,{id:u.id,n:'X-Wing',s:null,owner:cue.seat,t:1,p:2,h:2,d:0,x:1,traits:['vehicle','fighter'],printedTitle:'X-Wing',unique:false,leaderUnit:false,incarnation:u.incarnation}))return;
 expected.players[cue.seat].space.push(u);
 const shield=g.outcomes[1],h=shield?.outcome,host=h&&locate(cue,h.card);
 if(h){const chip=h.cards?.[0];if(!host||!knownBody(host)||same(host.unit,u)||!chip?.id||!allowed(h,['amount','ownerSeat','cards'])||!eventSource(cue,h)||h.kind!=='shield'||h.seat!==host.seat||h.zone!==host.zone||!exact(h.card,host.unit)||h.incarnation!==host.unit.incarnation||h.amount!==1||h.ownerSeat!==host.seat||h.cards?.length!==1||!exact(chip,{id:chip.id,n:'Shield',s:null,owner:host.seat})||refs(cue.transition.before).some(c=>same(c,chip))||same(chip,u))return;replace(expected,host,{...host.unit,u:[...(host.unit.u??[]),{...chip,t:1,p:0,h:0}]});}
 return ending(cue,expected)?{create,unit:u,shield,host,items:g.outcomes}:undefined;
}
function heatProof(cue:CardEffectCue,g:Geometry){
 const expected=paidState(cue);if(!expected||!cue.transition)return;
 const all=[cue.seat,cue.seat==='p1'?'p2':'p1' as Seat].flatMap(seat=>(['ground','space'] as const).flatMap(zone=>cue.transition!.before.players[seat][zone].map(unit=>({unit,seat,zone})))),w=g.outcomes[0]?.outcome.keywordWindow;
 if(!all.length||g.outcomes.length!==all.length*2||!w?.id||all.some(t=>!t.unit.incarnation||!knownBody(t as Located)||t.unit.status?.some(s=>s.kind==='suppressed'||s.lostKeyword||s.keywordWindow||s.kind==='keyword'&&!s.keyword)||body(t.unit)!.keywords.includes('sentinel')&&!t.unit.sn)||new Set(all.map(t=>key(t.unit))).size!==all.length)return;
 const members=all.map(t=>({id:key(t.unit),incarnation:t.unit.incarnation!,nativeSentinel:body(t.unit)!.keywords.includes('sentinel')}));
 if(!exact(w,{id:w.id,sourceId:key(cue.source),round:expected.round,phase:expected.phase,members}))return;
 const results:{target:Located;end:UnitRef}[]=[];
 for(const [i,t] of all.entries()){
  const member=members[i],mark={id:w.id,sourceId:w.sourceId,subjectId:member.id,incarnation:member.incarnation,round:w.round,phase:w.phase,nativeSentinel:member.nativeSentinel};
  for(const [j,name,op] of [[0,'Sentinel','gain'],[1,'Saboteur','lose']] as const){const o=g.outcomes[i*2+j].outcome;if(!allowed(o,['round','duration','keyword','keywordOperation','keywordWindow'])||!eventSource(cue,o)||o.kind!=='keyword'||!exact(o.card,t.unit)||o.seat!==t.seat||o.zone!==t.zone||o.incarnation!==t.unit.incarnation||o.round!==expected.round||o.duration!=='phase'||!exact(o.keyword,{name,amount:1})||o.keywordOperation!==op||!exact(o.keywordWindow,w))return;}
  const end:UnitRef={...t.unit,sn:1,status:[...(t.unit.status??[]),{kind:'keyword',label:'Sentinel · phase',duration:'phase',keyword:{name:'Sentinel',amount:1},keywordWindow:mark,round:expected.round,phase:expected.phase,incarnation:t.unit.incarnation},{kind:'keyword',label:'No Saboteur · phase',duration:'phase',lostKeyword:'Saboteur',keywordWindow:mark,round:expected.round,phase:expected.phase,incarnation:t.unit.incarnation}]};replace(expected,t as Located,end);results.push({target:t as Located,end});
 }
 return ending(cue,expected)?{results,window:w,items:g.outcomes}:undefined;
}
function heatExpiryProof(cue:CardEffectCue,g:Geometry){
 const expected=boundaryState(cue,'phase-end');if(!expected||!cue.transition)return;
 const all=[cue.seat,cue.seat==='p1'?'p2':'p1' as Seat].flatMap(seat=>(['ground','space'] as const).flatMap(zone=>cue.transition!.before.players[seat][zone].filter(u=>u.status?.some(s=>s.keywordWindow?.sourceId===key(cue.source))).map(unit=>({unit,seat,zone}))));
 if(!all.length||g.outcomes.length!==all.length)return;
 const results:{target:Located;end:UnitRef}[]=[];
 for(const [i,t] of all.entries()){
  const o=g.outcomes[i].outcome,retained=t.unit.status!.filter(s=>s.keywordWindow?.sourceId===key(cue.source)),mark=retained[0]?.keywordWindow,native=body(t.unit)?.keywords.includes('sentinel');
  if(!knownBody(t as Located)||!mark||retained.length!==2||native===undefined||mark.nativeSentinel!==native||!exact(mark,{id:mark.id,sourceId:key(cue.source),subjectId:key(t.unit),incarnation:t.unit.incarnation,round:expected.round,phase:expected.phase,nativeSentinel:native}))return;
  const shared={kind:'keyword',duration:'phase',keywordWindow:mark,round:expected.round,phase:expected.phase,incarnation:t.unit.incarnation};
  if(!exact(retained[0],{...shared,label:'Sentinel · phase',keyword:{name:'Sentinel',amount:1}})||!exact(retained[1],{...shared,label:'No Saboteur · phase',lostKeyword:'Saboteur'}))return;
  const end=structuredClone(t.unit);end.status=end.status!.filter(s=>s.keywordWindow?.id!==mark.id);if(end.status.some(s=>s.keyword?.name==='Sentinel'&&(!native||s.duration==='phase')||s.kind==='keyword'&&!s.keyword&&!s.lostKeyword))return;if(native)end.sn=1;else delete end.sn;
  const w={id:mark.id,sourceId:mark.sourceId,round:mark.round,phase:mark.phase,members:[{id:key(t.unit),incarnation:t.unit.incarnation,nativeSentinel:native}]};
  if(!allowed(o,['unit','round','duration','keywordOperation','keywordWindow'])||!eventSource(cue,o)||o.kind!=='keyword'||!exact(o.card,t.unit)||!exact(o.unit,end)||o.seat!==t.seat||o.zone!==t.zone||o.incarnation!==t.unit.incarnation||o.round!==expected.round||o.duration!=='phase'||o.keywordOperation!=='expire'||!exact(o.keywordWindow,w))return;replace(expected,t as Located,end);results.push({target:t as Located,end});
 }
 return ending(cue,expected)?{results,items:g.outcomes}:undefined;
}
function recipe(cue:CardEffectCue,g:Geometry){switch(cue.definition.id){case 'private-manufacturing':return manufactureProof(cue,g);case 'no-glory-only-results':return gloryProof(cue,g);case 'close-the-shield-gate':return cue.stage==='next-action'?gateLaterProof(cue,g):cue.stage==='phase-end'?gateExpiryProof(cue,g):gateGrantProof(cue,g);case 'covering-the-wing':return coverProof(cue,g);case 'in-the-heat-of-battle':return cue.stage==='phase-end'?heatExpiryProof(cue,g):heatProof(cue,g);}}
export const batchA14Covers=(cue:CardEffectCue,g:Geometry,item:PlacedOutcome)=>recipe(cue,g)?.items.includes(item)??false;
/** A verified presentation waypoint. Never substitutes for the recorded before/after truth. */
export function batchA14IntermediateLayout(cue:CardEffectCue):Snapshot|undefined{
 const box={x:500,y:300,w:80,h:112,exact:false},g:Geometry={source:box,target:box,friendlyBase:box,zones:{},outcomes:(cue.outcomes??[]).map((outcome,i)=>({outcome,box,from:box,to:box,key:String(i),slot:i}))};
 return cue.definition.id==='private-manufacturing'?manufactureProof(cue,g)?.intermediate:cue.definition.id==='no-glory-only-results'?gloryProof(cue,g)?.intermediate:undefined;
}


const bound = (at: EffectBox, w: number, h: number): EffectBox => ({ ...at, x: Math.max((w / 2 + 8) / (at.sx ?? 1), Math.min(1000 - (w / 2 + 8) / (at.sx ?? 1), at.x)), y: Math.max((h / 2 + 40) / (at.sy ?? 1), Math.min(600 - (h / 2 + 122) / (at.sy ?? 1), at.y)) });
const side = (g: Geometry) => shift({ ...g.friendlyBase, x: 1000 }, 0, 24);
const cardAt = (g: Geometry, t: Located) => g.cards?.[t.seat + ':' + key(t.unit)] ?? g.zones[t.seat + ':' + t.zone];
function Receipt({ at, rows, p, start, until, color = '#b8dad7' }: { at: EffectBox; rows: string[]; p: number; start: number; until?: number; color?: string }) {
    const w = Math.min(320, Math.max(100, ...rows.map(r => r.length * 6 + 24))), h = rows.length * 16 + 8;
    return <ScreenPixels at={bound(at, w, h)} color={color} opacity={visible(p, start) * (until ? 1 - phase(p, until - .05, until) : 1)}><rect x={-w / 2} y={-h / 2} width={w} height={h} rx="4" fill="#09121e" fillOpacity=".98" strokeWidth="1" />{rows.map((r, i) => <text key={i} y={-h / 2 + 14 + i * 16} textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '700 9px sans-serif' }}>{r}</text>)}</ScreenPixels>;
}
function Mask({ at, p, start }: { at: EffectBox; p: number; start: number }) { const s = size(at); return <ScreenPixels at={at} opacity={visible(p, start)}><rect x={-s.w / 2 - 3} y={-s.h / 2 - 3} width={s.w + 6} height={s.h + 6} rx="5" fill="#0b1420" stroke="none" /></ScreenPixels>; }
function Flight({ from, to, card, p, start, end, back = false, arrive = false, token = false }: { from: EffectBox; to: EffectBox; card: CardRef; p: number; start: number; end: number; back?: boolean; arrive?: boolean; token?: boolean }) {
    if (p < start) return null;
    const t = easeInOut(phase(p, start, end)), left = 16 / (from.sx ?? 1), approach = shift(to, 0, arrive ? -24 : 24), route = [from, { ...from, x: left }, { ...approach, x: left }, approach, to], leg = Math.min(3, Math.floor(t * 4)), at = token ? from : { ...to, ...mix(route[leg], route[leg + 1], Math.min(1, t * 4 - leg)) }, grow = arrive ? phase(t, .92, 1) : 0, s = size(to);
    return <ScreenPixels at={at} color="#b8dad7" opacity={visible(p, start) * (arrive ? 1 : 1 - phase(p, end - .025, end + .04))}><g transform={`scale(${token ? 1 - t : 1})`}><CardGhost card={card} back={back} box={{ w: 20 + (s.w - 20) * grow, h: 28 + (s.h - 28) * grow }} /></g></ScreenPixels>;
}

function UnitFace({ at, unit, label, p, start, opaque = false }: { at: EffectBox; unit: UnitRef; label?: string; p: number; start: number; opaque?: boolean }) {
    const s = size(at);
    return <ScreenPixels at={at} opacity={opaque ? 1 : visible(p, start)} color="#b8dad7"><g transform={`rotate(${unit.x ? 10 : 0}) scale(${unit.x ? .94 : 1})`} opacity={unit.x ? .72 : 1}><CardGhost card={unit} box={s} />{unit.sn && <text x={-s.w / 2 + 4} y={-s.h / 2 + 10} fill="#f6edd9" stroke="none" style={{ font: '700 7px sans-serif' }}>SEN</text>}{label && <><rect x={-s.w / 2 + 1} y={-s.h / 2 + 13} width={Math.max(12,s.w - 2)} height="18" fill="#101925" /><text y={-s.h / 2 + 25} textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '700 7px sans-serif' }}>{label}</text></>}{[-1, 1].map(i => <g key={i} transform={`translate(${i * (s.w / 2 - 10)} ${s.h / 2 - 11})`}><rect x="-9" y="-10" width="18" height="20" rx="3" fill={i < 0 ? '#8b2936' : '#173f6f'} /><text textAnchor="middle" y="4" fill="#fff" stroke="none" style={{ font: '800 12px sans-serif' }}>{i < 0 ? unit.p : Math.max(0, unit.h - unit.d)}</text></g>)}</g></ScreenPixels>;
}
function Settle({ cue, geometry: g, p }: Props) {
    if (!cue.transition || p < .8) return null;
    return <>{seats.flatMap(seat => units(cue.transition!.after, seat).map(unit => {
        const old = locate(cue, unit), from = old && cardAt(g, old), to = g.endingCards?.[seat + ':' + key(unit)];
        if (!from || !to || old!.seat !== seat || Math.hypot((to.x - from.x) * (from.sx ?? 1), (to.y - from.y) * (from.sy ?? 1)) < 1) return null;
        return <g key={seat + ':' + key(unit)}><Mask at={from} p={p} start={.8} /><UnitFace at={{ ...to, ...mix(from, to, easeInOut(phase(p, .8, .94))) }} unit={unit} p={p} start={.8} opaque  /></g>;
    }))}</>;
}

function Payment({cue,geometry:g,p,extra,extraStart=.42}:Props&{extra?:PlacedOutcome;extraStart?:number}){
    const before=cue.transition!.before.players[cue.seat],paid=cue.playPayment?.kind==='resources'?cue.playPayment.cardIds!:[],extraIds=extra?.outcome.cards?.map(key)??[];
    return <><ResourceBalance at={g.zones[cue.seat+':resources']} countAt={g.zones[cue.seat+':resource-count']} ready={before.res.ready-paid.length} total={before.res.total} p={p} start={.04}/>{before.resources!.map((r,i)=>{const at=g.resourceCards?.[cue.seat+':'+key(r)];return at&&(paid.includes(key(r))||extraIds.includes(key(r)))?<ResourceSlot key={key(r)} at={at} index={i} spent p={p} start={paid.includes(key(r))?.04:extraStart}/>:null;})}<Mask at={g.source} p={p} start={.04}/><Flight from={g.source} to={g.zones[cue.seat+':discard']} card={cue.source!} p={p} start={.04} end={.21}/>{extra&&<ResourceBalance at={g.zones[cue.seat+':resources']} countAt={g.zones[cue.seat+':resource-count']} ready={before.res.ready-paid.length-extraIds.length} total={before.res.total} p={p} start={extraStart}/>}</>;
}
function Band({at,lines,p,start,color='#b8dad7'}:{at:EffectBox;lines:string[];p:number;start:number;color?:string}){
    const s=size(at),h=lines.length*9+4;return <ScreenPixels at={shift(at,0,-s.h/2+13+h/2)} color={color} opacity={visible(p,start)}><rect x={-s.w/2+1} y={-h/2} width={Math.max(12,s.w-2)} height={h} rx="2" fill="#0b1722" strokeWidth="1"/>{lines.map((x,i)=><text key={i} y={-h/2+9+i*9} textAnchor="middle" fill="currentColor" stroke="none" style={{font:'700 6px sans-serif'}}>{x}</text>)}</ScreenPixels>;
}

function receiptAt(cue:CardEffectCue,g:Geometry){
 const upper=units(cue.transition!.before,'p2').map(u=>g.cards?.['p2:'+key(u)]).filter((b):b is EffectBox=>!!b),lower=units(cue.transition!.before,'p1').map(u=>g.cards?.['p1:'+key(u)]).filter((b):b is EffectBox=>!!b);
 return (g.source.sx??1)>.65&&upper.length&&lower.length?{...side(g),y:(Math.max(...upper.map(b=>b.y+b.h/2))+Math.min(...lower.map(b=>b.y-b.h/2)))/2}:side(g);
}
function Count({at,n,p,start}:{at:EffectBox;n:number;p:number;start:number}){return <ScreenPixels at={at} opacity={visible(p,start)}><rect x="-13" y="-9" width="26" height="18" rx="2" fill="#0b1420" stroke="none"/><text x="5" y="4" textAnchor="middle" fill="#c4d8de" stroke="none" style={{font:'700 10px sans-serif'}}>{n}</text></ScreenPixels>;}
function HandFace({at,card,p,start}:{at:EffectBox;card:CardRef;p:number;start:number}){return p<start?null:<ScreenPixels at={at} opacity={1}><CardGhost card={card} box={size(at)}/></ScreenPixels>;}
function Manufacturing(props:Props){
 const {cue,geometry:g,p}=props,r=manufactureProof(cue,g);if(!r)return null;
 const player=cue.transition!.before.players[cue.seat],hand=r.intermediate.players[cue.seat].hand,slot=(card:CardRef)=>g.intermediateCards?.[cue.seat+':'+key(card)]??g.endingCards?.[cue.seat+':'+key(card)]??g.zones[cue.seat+':hand'];
 const endingIds=cue.transition!.after.players[cue.seat].hand.map(key),deck=g.zones[cue.seat+':deck'],drawCount=p<.42?0:p<.495?1:2,bottomCount=r.moves.length?(p<.72?0:p<.85?1:2):0;
 return <><Payment {...props}/><Receipt at={receiptAt(cue,g)} rows={['DRAW TWO · PRIVATE HAND',r.moves.length?'THEN CHOOSE TWO · BOTTOM ORDER':'CONTROLLED UNIT TOKEN · KEEP DRAWS']} p={p} start={.08} until={.53}/>
  {player.hand.filter(c=>!same(c,cue.source)).map(card=>{const from=g.cards?.[cue.seat+':'+key(card)]??g.zones[cue.seat+':hand'],selected=r.order.indexOf(key(card)),hidden=selected>=0&&p>=.6+selected*.13;return <g key={key(card)}><Mask at={from} p={p} start={.27}/>{!hidden&&p<.84&&<HandFace at={slot(card)} card={card} p={p} start={.29}/>}</g>;})}
  {r.drawn.map((card,i)=>{const selected=r.order.indexOf(key(card)),hidden=selected>=0&&p>=.6+selected*.13;return !hidden?<g key={key(card)}>{p<.42+i*.075&&<Flight from={deck} to={slot(card)} card={card} back p={p} start={.28+i*.075} end={.42+i*.075} arrive/>}{p>=.42+i*.075&&p<.84&&<HandFace at={slot(card)} card={card} p={p} start={.42+i*.075}/>}</g>:null;})}
  {r.moves.map((move,i)=><g key={move.key}><Flight from={slot(move.outcome.card!)} to={deck} card={move.outcome.card!} back p={p} start={.6+i*.13} end={.72+i*.13}/><Receipt at={receiptAt(cue,g)} rows={[`P${cue.seat==='p1'?'1':'2'} CHOSEN BOTTOM ORDER`,`${i+1} OF 2 · ${move.outcome.card!.n.toUpperCase()}`]} p={p} start={.59+i*.13} until={.72+i*.13}/></g>)}
  {p>=.84&&hand.filter(c=>endingIds.includes(key(c))).map(card=>{const from=slot(card),to=g.endingCards?.[cue.seat+':'+key(card)]??from;return <HandFace key={key(card)} at={{...to,...mix(from,to,easeInOut(phase(p,.84,.94)))}} card={card} p={p} start={.84}/>;})}
  <Count at={g.zones[cue.seat+':hand-count']} n={player.hand.length-1+drawCount-bottomCount} p={p} start={.04}/>
  <Count at={deck} n={player.deck-drawCount+bottomCount} p={p} start={.04}/>
  <Receipt at={receiptAt(cue,g)} rows={r.moves.length?['TWO CHOSEN CARDS ON BOTTOM','OTHER HAND CARDS KEPT','DRAW THEN BOTTOM · ORDER KEPT']:['UNIT TOKEN CONDITION','BOTH DRAWS STAY IN HAND']} p={p} start={.87}/>
 </>;
}
function Glory(props:Props){
 const {cue,geometry:g,p}=props,r=gloryProof(cue,g);if(!r)return null;
 const from=cardAt(g,r.target),waypoint=g.intermediateCards?.[r.controller+':'+key(r.target.unit)]??from,transferred=r.controller!==r.target.seat,dead=!r.death.outcome.prevented;
 return <><Payment {...props}/><Receipt at={receiptAt(cue,g)} rows={['TAKE CONTROL · THEN DEFEAT',`OWNER ${r.target.unit.owner!.toUpperCase()} STAYS`,r.control.outcome.prevented?'CONTROL PREVENTED · DEFEAT STILL ATTEMPTED':`CONTROLLER ${r.controller.toUpperCase()}`]} p={p} start={.08} until={.58}/>
  <Mask at={from} p={p} start={.27}/>{transferred&&p<.46&&<Flight from={from} to={waypoint} card={r.target.unit} p={p} start={.28} end={.46} arrive/>}
  {p>=.46&&(!dead||p<.6)&&<><UnitFace at={waypoint} unit={r.target.unit} p={p} start={.46} opaque/><Band at={waypoint} lines={[`OWNER ${r.target.unit.owner!.toUpperCase()}`,`CONTROL ${r.controller.toUpperCase()}`]} p={p} start={.46}/></>}
  {dead&&<Flight from={waypoint} to={g.zones[r.target.unit.owner!+':discard']} card={r.target.unit} p={p} start={.6} end={.82} token={!!r.target.unit.t}/>}<Settle {...props}/>
  <Receipt at={receiptAt(cue,g)} rows={dead?[r.target.unit.t?'TOKEN CEASES':'OWNER DISCARD',`DEFEATED UNDER ${r.controller.toUpperCase()} CONTROL`]:['DEFEAT PREVENTED','ACTUAL CONTROLLER KEPT']} p={p} start={.85}/>
 </>;
}
function BaseStatus({at,rows,p,start,until}:{at:EffectBox;rows:string[];p:number;start:number;until?:number}){return <ScreenPixels at={at} opacity={visible(p,start)*(until?1-phase(p,until-.06,until):1)} color="#a9d7e7"><rect x="-57" y="-14" width="114" height="28" rx="3" fill="#102232" strokeWidth="1"/>{rows.map((r,i)=><text key={i} y={-4+i*11} textAnchor="middle" fill="currentColor" stroke="none" style={{font:'700 7px sans-serif'}}>{r}</text>)}</ScreenPixels>;}
function gateReceiptAt(cue:CardEffectCue,g:Geometry,base:EffectBox,status:EffectBox){
 const at=receiptAt(cue,g);if((g.source.sx??1)>.65)return at;
 // Fit the compact receipt between the actual HP numeral and separate protection shelf.
 const minimum=(base.stat?.y??shift(base,0,-size(base).h/2).y)+34/(base.sy??1),maximum=status.y-37/(status.sy??1);
 return {...at,y:Math.max(minimum,Math.min(maximum,shift(base,0,12).y))};
}
function Gate(props:Props){
 const {cue,geometry:g,p}=props,grant=cue.stage?undefined:gateGrantProof(cue,g),later=cue.stage==='next-action'?gateLaterProof(cue,g):undefined,expiry=cue.stage==='phase-end'?gateExpiryProof(cue,g):undefined;if(!grant&&!later&&!expiry)return null;
 const seat=grant?.seat??later?.seat??expiry!.active[0].seat,base=g.zones[seat+':base'],s=size(base),status=g.zones[seat+':base-protection']??shift(base,0,s.h/2+18),remaining=cue.transition!.after.players[seat].base.hp-cue.transition!.after.players[seat].base.d,receipt=gateReceiptAt(cue,g,base,status);
 return <>{grant&&<Payment {...props}/>}<ScreenPixels at={base} opacity={visible(p,.22)*(expiry?1-phase(p,.45,.68):later?1-phase(p,.49,.65):1)} color="#95d7e9"><rect x={-s.w/2-5} y={-s.h/2-5} width={s.w+10} height={s.h+10} rx="5" fill="none" strokeWidth="2"/>{[-1,1].map(i=><path key={i} d={`M${i*(s.w/2+14*(1-easeInOut(phase(p,.23,.42))))} ${-s.h/2} V${s.h/2}`} strokeWidth="4"/>)}</ScreenPixels>
  {grant&&<><BaseStatus at={status} rows={['NEXT DAMAGE · ONE USE','THIS PHASE']} p={p} start={.43}/><Receipt at={receipt} rows={['PREVENT NEXT DAMAGE · ONE USE',`${seat.toUpperCase()} BASE · THIS PHASE · HP ${remaining}`]} p={p} start={.08}/></>}
  {later&&(()=>{const at=cardAt(g,later.attacker);return <><Mask at={at} p={p} start={.23}/><UnitFace at={at} unit={{...later.attacker.unit,x:1}} p={p} start={.23}/><path d={`M${at.x} ${at.y} L${base.x} ${base.y}`} stroke="#cc8b8b" strokeWidth="1.5" fill="none" opacity={envelope(p,.27,.36,.53)}/><BaseStatus at={status} rows={p<.49?['NEXT DAMAGE · ONE USE','THIS PHASE']:['PROTECTION USED','DAMAGE ZERO']} p={p} start={.2}/><Receipt at={receipt} rows={[`INCOMING ${later.attacker.unit.p} · PREVENT ${later.attacker.unit.p} · DAMAGE 0`,'ONE USE CONSUMED · ATTACKER EXHAUSTED']} p={p} start={.12}/></>;})()}
  {expiry&&<><BaseStatus at={status} rows={p<.55?['UNUSED PROTECTION','PHASE ENDS']:['PROTECTION EXPIRED','BASE DAMAGE KEPT']} p={p} start={.16}/><Receipt at={receipt} rows={['PHASE ENDS · UNUSED USE EXPIRES',`BASE HP ${remaining} · DAMAGE KEPT`]} p={p} start={.12}/></>}
 </>;
}
function Covering(props:Props){
 const {cue,geometry:g,p}=props,r=coverProof(cue,g);if(!r)return null;
 const to=g.endingCards?.[cue.seat+':'+key(r.unit)]??r.create.to,s=size(to),grow=easeInOut(phase(p,.3,.58));
 const chip=r.shield?.outcome.cards?.[0],host=r.host&&cardAt(g,r.host),target=chip&&r.host?(g.endingCards?.[r.host.seat+':'+key(chip)]??shift(host!,0,-size(host!).h/2+14)):undefined;
 return <><Payment {...props}/><Receipt at={receiptAt(cue,g)} rows={['CREATE X-WING · SPACE','FRESH TOKEN · EXHAUSTED','OPTIONAL SHIELD · ANOTHER UNIT']} p={p} start={.08} until={.6}/>
  {p<.58?<ScreenPixels at={to} opacity={visible(p,.3)} color="#acc9e9"><g transform={`scale(${.25+.75*grow})`}><CardGhost card={r.unit} box={s}/><path d={`M${-s.w/2} 0 H${s.w/2} M0 ${-s.h/2} V${s.h/2}`} strokeWidth="1"/></g></ScreenPixels>:<><UnitFace at={to} unit={r.unit} p={p} start={.58}/><Band at={to} lines={['X-WING · TOKEN','CREATED','EXHAUSTED']} p={p} start={.58}/></>}
  {target&&host&&<><path d={`M${to.x} ${to.y-to.h/2} Q${(to.x+target.x)/2} ${Math.min(to.y-to.h/2,target.y)-16/(to.sy??1)} ${target.x} ${target.y}`} stroke="#a4dceb" strokeWidth="1.5" fill="none" opacity={envelope(p,.58,.65,.78)}/><ScreenPixels at={target} opacity={visible(p,.72)} color="#c3e7ee"><rect x={-size(target).w/2} y={-size(target).h/2} width={size(target).w} height={size(target).h} rx="3" fill="#18303d" strokeWidth="1"/><text y="3" textAnchor="middle" fill="currentColor" stroke="none" style={{font:'700 7px sans-serif'}}>Shield</text></ScreenPixels></>}
  <Settle {...props}/><Receipt at={receiptAt(cue,g)} rows={r.shield?['NEW X-WING STAYS UNSHIELDED','ANOTHER EXISTING UNIT · SHIELD']:['X-WING CREATED','OPTIONAL SHIELD DECLINED']} p={p} start={.83}/>
 </>;
}
function Heat(props:Props){
 const {cue,geometry:g,p}=props,r=cue.stage==='phase-end'?heatExpiryProof(cue,g):heatProof(cue,g);if(!r)return null;const expire=cue.stage==='phase-end';
 return <>{!expire&&<Payment {...props}/>}<Receipt at={receiptAt(cue,g)} rows={expire?['PHASE ENDS · THIS SOURCE WINDOW','PRINTED KEYWORDS RESTORE','BODIES AND WOUNDS KEPT']:['EVERY CURRENT UNIT · BOTH ARENAS','SENTINEL · NO SABOTEUR','THIS PHASE · LATER ENTRIES UNCHANGED']} p={p} start={.08}/>
  {r.results.map(({target:t,end},i)=>{const at=cardAt(g,t),start=.29+i*.012;return <g key={key(t.unit)}><Mask at={at} p={p} start={start}/><UnitFace at={at} unit={p<start+.13?t.unit:end} p={p} start={start}/>{!expire?<Band at={at} lines={['SENTINEL · PHASE','NO SABOTEUR']} p={p} start={start+.13}/>:body(t.unit)?.keywords.includes('saboteur')?<Band at={at} lines={['SABOTEUR','PRINTED']} p={p} start={start+.13}/>:body(t.unit)?.keywords.includes('sentinel')?<Band at={at} lines={['SENTINEL','PRINTED']} p={p} start={start+.13}/>:null}<ScreenPixels at={at} color={expire?'#c9d9cc':'#b2cbe6'} opacity={envelope(p,start,start+.08,start+.23)}><rect x={-size(at).w/2-3} y={-size(at).h/2-3} width={size(at).w+6} height={size(at).h+6} rx="5" fill="none" strokeWidth="2"/></ScreenPixels></g>;})}
 </>;
}
export function BatchA14Signature(props:Props){if(!recipe(props.cue,props.geometry))return null;switch(props.cue.definition.id){case 'private-manufacturing':return <Manufacturing {...props}/>;case 'no-glory-only-results':return <Glory {...props}/>;case 'close-the-shield-gate':return <Gate {...props}/>;case 'covering-the-wing':return <Covering {...props}/>;case 'in-the-heat-of-battle':return <Heat {...props}/>;default:return null;}}
