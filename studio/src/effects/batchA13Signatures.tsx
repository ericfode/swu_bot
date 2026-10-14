import type { CardRef, Seat, Snapshot, UnitRef } from '../data/types';
import type { CardEffectCue, CardEffectOutcome } from './types';
import { A13_DEFINITIONS } from './batchA13';
import { previewGivenCost, previewPlayCost, type PreviewAspect } from './previewCosts';
import { easeInOut, envelope, phase } from './animationTimeline';
import { AttachmentMask, CardGhost, ResourceBalance, ResourceSlot, ScreenPixels, TokenAssembly, mix, screenShift as shift, type EffectBox, type PlacedOutcome } from './primitives';

type Geometry = { source: EffectBox; target: EffectBox; friendlyBase: EffectBox; outcomes: PlacedOutcome[]; zones: Record<string, EffectBox>; cards?: Record<string, EffectBox>; endingCards?: Record<string, EffectBox>; pockets?: Record<string, EffectBox>; endingPockets?: Record<string, EffectBox>; resourceCards?: Record<string, EffectBox> };
type Props = { cue: CardEffectCue; geometry: Geometry; p: number };
const seats: Seat[] = ['p1', 'p2'];
const ids = new Set(['unmasking-the-conspiracy', 'breaking-in', 'now-there-are-two-of-them', 'prisoner-of-war', 'execute-order-66']);
export const isBatchA13 = (cue: CardEffectCue) => ids.has(cue.definition.id);
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
const size = (at: EffectBox) => at.cardSize ?? { w: at.w * (at.sx ?? 1), h: at.h * (at.sy ?? 1) };
const visible = (p: number, start: number) => phase(p, start, start + .045);
function locate(cue: CardEffectCue, c?: CardRef | null) {
    if (!c?.id || !cue.transition) return;
    const found = seats.flatMap(seat => (['ground', 'space'] as const).flatMap(zone => cue.transition!.before.players[seat][zone].filter(u => same(u, c)).map(unit => ({ unit, seat, zone }))));
    return found.length === 1 && found[0].unit.incarnation && found[0].unit.d < found[0].unit.h ? found[0] : undefined;
}
type Located = NonNullable<ReturnType<typeof locate>>;
function paidState(cue: CardEffectCue) {
    const d = A13_DEFINITIONS.find(d => d.id === cue.definition.id), t = cue.transition;
    if (!d || !t || cue.stage || cue.definition.name !== d.name || cue.definition.setCode !== d.setCode || !cue.source?.id || cue.source.n !== d.name || cue.source.s !== d.setCode || cue.source.owner !== cue.seat || t.before.phase !== 'action'
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

type Face = { name:string; title:string; printed:number; aspects:PreviewAspect[]; p:number|null; h:number|null; traits:string[]; keywords:string[]; unique:boolean; arena:string|null; types:string[] };
// Limited canonical face facts independently checked against installed JSON.
const facts:Record<string,Face> = {"LOF_038":{"name":"Pong Krell: It's Treason, Then","title":"Pong Krell","printed":7,"aspects":["vigilance","villainy"],"p":2,"h":9,"traits":["force","jedi","republic"],"keywords":["grit"],"unique":true,"arena":"ground","types":["unit"]},"LOF_195":{"name":"Vernestra Rwoh: Precocious Knight","title":"Vernestra Rwoh","printed":3,"aspects":["cunning","heroism"],"p":3,"h":4,"traits":["force","jedi"],"keywords":[],"unique":true,"arena":"ground","types":["unit"]},"JTL_251":{"name":"Jedi Light Cruiser","title":"Jedi Light Cruiser","printed":6,"aspects":["heroism"],"p":6,"h":7,"traits":["jedi","republic","vehicle","capital ship"],"keywords":[],"unique":false,"arena":"space","types":["unit"]},"JTL_110":{"name":"Scouting Headhunter","title":"Scouting Headhunter","printed":2,"aspects":["command"],"p":2,"h":1,"traits":["fringe","vehicle","fighter"],"keywords":["sentinel"],"unique":false,"arena":"space","types":["unit"]},"SOR_033":{"name":"Death Trooper","title":"Death Trooper","printed":3,"aspects":["villainy","vigilance"],"p":3,"h":3,"traits":["imperial","trooper"],"keywords":[],"unique":false,"arena":"ground","types":["unit"]},"SOR_074":{"name":"Repair","title":"Repair","printed":1,"aspects":["vigilance"],"p":null,"h":null,"traits":["supply"],"keywords":[],"unique":false,"arena":null,"types":["event"]},"SOR_164":{"name":"Wampa","title":"Wampa","printed":4,"aspects":["aggression"],"p":4,"h":5,"traits":["creature"],"keywords":["overwhelm"],"unique":false,"arena":"ground","types":["unit"]},"SHD_121":{"name":"Mercenary Company","title":"Mercenary Company","printed":6,"aspects":["command"],"p":5,"h":5,"traits":["underworld","trooper"],"keywords":["ambush","overwhelm"],"unique":false,"arena":"ground","types":["unit"]},"SOR_098":{"name":"Echo Base Defender","title":"Echo Base Defender","printed":3,"aspects":["command","heroism"],"p":4,"h":3,"traits":["rebel","trooper"],"keywords":["sentinel"],"unique":false,"arena":"ground","types":["unit"]},"SOR_077":{"name":"Takedown","title":"Takedown","printed":4,"aspects":["vigilance"],"p":null,"h":null,"traits":["tactic"],"keywords":[],"unique":false,"arena":null,"types":["event"]},"TWI_230":{"name":"Super Battle Droid","title":"Super Battle Droid","printed":3,"aspects":["villainy"],"p":4,"h":3,"traits":["separatist","droid","trooper"],"keywords":[],"unique":false,"arena":"ground","types":["unit"]},"SOR_225":{"name":"TIE/ln Fighter","title":"TIE/ln Fighter","printed":1,"aspects":["villainy"],"p":2,"h":1,"traits":["imperial","vehicle","fighter"],"keywords":[],"unique":false,"arena":"space","types":["unit"]},"SOR_237":{"name":"Alliance X-Wing","title":"Alliance X-Wing","printed":2,"aspects":["heroism"],"p":2,"h":3,"traits":["rebel","vehicle","fighter"],"keywords":[],"unique":false,"arena":"space","types":["unit"]},"LOF_060":{"name":"Padawan Starfighter","title":"Padawan Starfighter","printed":2,"aspects":["vigilance"],"p":1,"h":3,"traits":["jedi","republic","vehicle","fighter"],"keywords":[],"unique":false,"arena":"space","types":["unit"]},"SOR_095":{"name":"Battlefield Marine","title":"Battlefield Marine","printed":2,"aspects":["command","heroism"],"p":3,"h":3,"traits":["rebel","trooper"],"keywords":[],"unique":false,"arena":"ground","types":["unit"]},"SOR_051":{"name":"Luke Skywalker: Jedi Knight","title":"Luke Skywalker","printed":7,"aspects":["heroism","vigilance"],"p":6,"h":7,"traits":["force","jedi","rebel"],"keywords":["restore"],"unique":true,"arena":"ground","types":["unit"]},"SOR_032":{"name":"Scout Bike Pursuer","title":"Scout Bike Pursuer","printed":2,"aspects":["villainy","vigilance"],"p":1,"h":4,"traits":["imperial","trooper"],"keywords":["grit"],"unique":false,"arena":"ground","types":["unit"]}};
const face=(c?:CardRef|null)=>c?.s&&facts[c.s]?.name===c.n?facts[c.s]:undefined;

function discardProof(cue:CardEffectCue,item:PlacedOutcome|undefined,card:CardRef,seat:Seat,extra:string[]=[]){
    const o=item?.outcome;
    return !!o&&!!card.id&&card.owner===seat&&allowed(o,['fromSeat','fromZone','ownerSeat','selection','chooserSeat','amount',...extra])&&eventSource(cue,o)&&o.kind==='discard'&&exact(o.card,card)&&o.seat===seat&&o.fromSeat===seat&&o.fromZone==='hand'&&o.zone==='discard'&&o.ownerSeat===seat&&o.selection==='chosen'&&o.chooserSeat===cue.seat&&o.amount===1&&o.incarnation===undefined;
}
function unmaskProof(cue:CardEffectCue,g:Geometry){
    const expected=paidState(cue);if(!expected||!cue.transition)return;
    const enemy:Seat=cue.seat==='p1'?'p2':'p1',own=expected.players[cue.seat].hand,opponent=expected.players[enemy].hand;
    if(!g.outcomes.length)return !own.length&&ending(cue,expected)?{own:undefined,inspect:undefined,chosen:undefined,hand:[],items:g.outcomes}:undefined;
    const loss=g.outcomes[0],selected=own.find(c=>same(c,loss.outcome.card));
    if(!selected||!discardProof(cue,loss,selected,cue.seat)||refs(cue.transition.before).filter(c=>same(c,selected)).length!==1)return;
    expected.players[cue.seat].hand=own.filter(c=>!same(c,selected));expected.players[cue.seat].discard.push(selected);
    if(!opponent.length)return g.outcomes.length===1&&ending(cue,expected)?{own:loss,inspect:undefined,chosen:undefined,hand:[],items:g.outcomes}:undefined;
    if(g.outcomes.length!==3)return;
    const inspect=g.outcomes[1],chosen=g.outcomes[2],o=inspect.outcome,c=chosen.outcome,target=opponent.find(x=>same(x,o.card)),requiresDiscard={id:key(selected),seat:cue.seat};
    if(!target||opponent.some(x=>!x.id||!face(x)||x.owner!==enemy)||new Set(opponent.map(key)).size!==opponent.length||!allowed(o,['cards','fromSeat','fromZone','visibility','chooserSeat','requiresDiscard','amount','sequenceId','sequenceIndex'])||!eventSource(cue,o)||o.kind!=='inspect'||o.seat!==enemy||o.fromSeat!==enemy||o.fromZone!=='hand'||o.zone!=='hand'||o.visibility!=='private'||o.chooserSeat!==cue.seat||o.amount!==opponent.length||!exact(o.cards,opponent)||!exact(o.card,target)||!exact(o.requiresDiscard,requiresDiscard)||o.incarnation!==undefined||!o.sequenceId||o.sequenceIndex!==1
        ||!discardProof(cue,chosen,target,enemy,['requiresDiscard','sequenceId','sequenceIndex'])||!exact(c.requiresDiscard,requiresDiscard)||c.sequenceId!==o.sequenceId||c.sequenceIndex!==2)return;
    expected.players[enemy].hand=opponent.filter(x=>!same(x,target));expected.players[enemy].discard.push(target);
    return ending(cue,expected)?{own:loss,inspect,chosen,hand:opponent,items:g.outcomes}:undefined;
}
function nestedPay(expected:Snapshot,cue:CardEffectCue,o:CardEffectOutcome,card:CardRef,n:number){
    const player=expected.players[cue.seat],paid=o.cards;
    if(o.prevented||o.kind!=='pay'||o.seat!==cue.seat||o.zone!=='resources'||!exact(o.card,card)||!exact(o.sourceCard,card)||o.amount!==n||!paid||paid.length!==n||new Set(paid.map(key)).size!==n||!paid.every(r=>!!r.id&&player.resources?.some(a=>exact(a,r)&&!a.x))||n>player.res.ready)return false;
    player.resources=player.resources!.map(r=>paid.some(a=>same(a,r))?{...r,x:1}:r);player.res.ready-=n;return true;
}
function cleanEntry(card:CardRef,u:UnitRef|undefined,cue:CardEffectCue){
    const f=face(card);if(!f||!f.types.includes('unit')||f.p===null||f.h===null||!u?.id||!u.incarnation||u.incarnation===cue.transition!.before.mostRecentIncarnations?.[u.id])return false;
    const keyword=f.keywords.includes('overwhelm')?'Overwhelm':f.keywords.includes('restore')?'Restore':undefined;
    const expected={...card,p:f.p,h:f.h,d:0,traits:f.traits,printedTitle:f.title,unique:f.unique,leaderUnit:false,incarnation:u.incarnation,x:1,...(f.keywords.includes('sentinel')?{sn:1}:{}),...(keyword?{status:[{kind:'keyword',label:`${keyword} (printed)`,duration:'permanent',keyword:{name:keyword,amount:keyword==='Restore'?3:1}}]}:{})};
    return exact(u,expected);
}
function twoProof(cue:CardEffectCue,g:Geometry){
    const expected=paidState(cue);if(!expected||!cue.transition)return;
    const current=units(cue.transition.before,cue.seat);
    if(!g.outcomes.length)return ending(cue,expected)?{unit:undefined,selected:undefined,cost:undefined,pay:undefined,play:undefined,price:0,items:g.outcomes}:undefined;
    if(current.length!==1||g.outcomes.length!==3||!current[0].incarnation||!current[0].traits)return;
    const [cost,pay,play]=g.outcomes,c=cost.outcome,p=pay.outcome,o=play.outcome,selected=expected.players[cue.seat].hand.find(a=>same(a,c.card)),f=face(selected),w=c.singleUnitPlay,u=o.unit;
    if(!selected||selected.owner!==cue.seat||!f||!f.types.includes('unit')||f.traits.includes('vehicle')||!w||!exact(w,{player:cue.seat,unitId:key(current[0]),incarnation:current[0].incarnation,sharedTrait:w.sharedTrait,printedCost:f.printed,aspects:f.aspects})||!current[0].traits.includes(w.sharedTrait)||!f.traits.includes(w.sharedTrait)
        ||!allowed(c,['amount','singleUnitPlay'])||!eventSource(cue,c)||c.kind!=='cost'||c.seat!==cue.seat||c.zone!==undefined||c.incarnation!==undefined||!exact(c.card,selected)||c.amount!==-5
        ||!allowed(p,['cards','amount','singleUnitPlay'])||p.incarnation!==undefined||!exact(p.singleUnitPlay,w)
        ||!allowed(o,['unit','fromSeat','fromZone','ownerSeat','entryType','entersReady','printedCost','singleUnitPlay'])||!eventSource(cue,o)||o.kind!=='play'||o.seat!==cue.seat||o.zone!==f.arena||o.fromSeat!==cue.seat||o.fromZone!=='hand'||o.ownerSeat!==cue.seat||!exact(o.card,selected)||o.entryType!=='played'||o.entersReady!==false||o.printedCost!==f.printed||o.incarnation!==undefined||!exact(o.singleUnitPlay,w)||!cleanEntry(selected,u,cue)||!u)return;
    const price=previewGivenCost({printed:f.printed,aspects:f.aspects},cue.transition.before,cue.seat,5);
    if(!nestedPay(expected,cue,p,selected,price))return;
    expected.players[cue.seat].hand=expected.players[cue.seat].hand.filter(a=>!same(a,selected));expected.players[cue.seat][f.arena as 'ground'|'space'].push(u);
    if(expected.mostRecentIncarnations)expected.mostRecentIncarnations[u.id!]=u.incarnation!;
    return ending(cue,expected)?{unit:current[0],selected,cost,pay,play,price,items:g.outcomes}:undefined;
}
function tokenProof(cue:CardEffectCue,item:PlacedOutcome,expected:Snapshot,seat:Seat,clone:boolean,extra:string[]){
    const o=item.outcome,u=o.unit,name=clone?'Clone Trooper':'Battle Droid';
    if(!u?.id||!u.incarnation||refs(expected).some(c=>same(c,u))||!allowed(o,['unit','ownerSeat','amount','tokenType','entryType','entersReady',...extra])||!eventSource(cue,o)||o.kind!=='create'||o.seat!==seat||o.zone!=='ground'||o.ownerSeat!==seat||o.amount!==1||o.tokenType!==(clone?'clone-trooper':'battle-droid')||o.entryType!=='created'||o.entersReady!==false||o.incarnation!==u.incarnation||!exact(o.card,u)
        ||!exact(u,{id:u.id,n:name,s:null,owner:seat,t:1,p:clone?2:1,h:clone?2:1,d:0,x:1,traits:clone?['republic','clone','trooper']:['separatist','droid','trooper'],printedTitle:name,unique:false,leaderUnit:false,incarnation:u.incarnation}))return false;
    expected.players[seat].ground.push(u);if(expected.mostRecentIncarnations)expected.mostRecentIncarnations[u.id]=u.incarnation;return true;
}
function captureProof(cue:CardEffectCue,g:Geometry){
    const expected=paidState(cue);if(!expected||!cue.transition||!g.outcomes.length)return;
    const capture=g.outcomes[0],o=capture.outcome,captor=locate(cue,o.sourceCard),target=locate(cue,o.card),w=o.captureSelection,cf=face(captor?.unit),tf=face(target?.unit);
    if(!captor||!target||captor.seat!==cue.seat||target.seat===cue.seat||target.unit.leaderUnit!==false||seats.some(s=>same(cue.transition!.before.players[s].leader,target.unit))||!target.unit.traits||target.unit.traits.includes('vehicle')||!target.unit.owner||target.unit.cap?.length||!w?.id||w.sourceId!==key(cue.source)||!cf&&!captor.unit.t||!tf&&!target.unit.t)return;
    const ac=captor.unit.t?0:cf!.printed,tc=target.unit.t?0:tf!.printed;
    if(!allowed(o,['fromSeat','fromZone','ownerSeat','captureSelection'])||o.kind!=='capture'||!exact(o.sourceCard,captor.unit)||!exact(o.card,target.unit)||o.seat!==captor.seat||o.zone!==captor.zone||o.fromSeat!==target.seat||o.fromZone!==target.zone||o.ownerSeat!==target.unit.owner||o.incarnation!==target.unit.incarnation||!exact(w,{id:w.id,sourceId:key(cue.source),captor:{id:key(captor.unit),incarnation:captor.unit.incarnation,printedCost:ac},target:{id:key(target.unit),incarnation:target.unit.incarnation,printedCost:tc}}))return;
    if(!o.prevented){
        for(const up of target.unit.u??[])if(!up.owner)return;
        expected.players[target.seat][target.zone]=expected.players[target.seat][target.zone].filter(u=>!same(u,target.unit));
        for(const up of target.unit.u??[])if(!up.t)expected.players[up.owner!].discard.push(up);
        const captive:CardRef={id:target.unit.id,n:target.unit.n,s:target.unit.s,owner:target.unit.owner};
        const end={...captor.unit,cap:[...(captor.unit.cap??[]),...(!target.unit.t?[captive]:[])]};replace(expected,captor,end);
        if(expected.pending)expected.pending=expected.pending.filter(p=>p.targetId!==target.unit.id);
    }
    const creates=g.outcomes.slice(1);if(creates.length!==(tc<ac?2:0))return;
    for(const item of creates)if(!exact(item.outcome.captureSelection,w)||!tokenProof(cue,item,expected,captor.seat,false,['captureSelection']))return;
    return ending(cue,expected)?{capture,captor,target,creates,ac,tc,items:g.outcomes}:undefined;
}
type Death={item:PlacedOutcome;target:Located};
function deathProof(cue:CardEffectCue,item:PlacedOutcome|undefined,t:Located,source:CardRef,extra:string[]){
    const o=item?.outcome,u=t.unit,owner=u.owner,summary=owner&&cue.transition!.before.players[owner].leader,leader=summary?.dep===1&&same(summary,u);
    return !!o&&!!owner&&allowed(o,['fromSeat','fromZone','ownerSeat','leader',...extra])&&!o.prevented&&o.kind==='defeat'&&exact(o.card,u)&&exact(o.sourceCard,source)&&o.seat===t.seat&&o.fromSeat===t.seat&&o.fromZone===t.zone&&o.zone===(leader?'leader':'discard')&&o.ownerSeat===owner&&o.incarnation===u.incarnation&&!u.cap?.length&&(u.u??[]).every(up=>!!up.owner)&&(leader?exact(o.leader,{...summary,dep:0,x:1}):o.leader===undefined);
}
function kill(expected:Snapshot,t:Located,o:CardEffectOutcome){
    expected.players[t.seat][t.zone]=expected.players[t.seat][t.zone].filter(u=>!same(u,t.unit));
    for(const up of t.unit.u??[])if(!up.t)expected.players[up.owner!].discard.push(up);
    if(o.leader)expected.players[t.unit.owner!].leader=o.leader;else if(!t.unit.t)expected.players[t.unit.owner!].discard.push(t.unit);
    if(expected.pending)expected.pending=expected.pending.filter(p=>p.targetId!==t.unit.id);
}
const grit=(u:UnitRef)=>face(u)?.keywords.includes('grit')||u.status?.some(s=>s.keyword?.name==='Grit');
function orderProof(cue:CardEffectCue,g:Geometry){
    const expected=paidState(cue);if(!expected||!cue.transition)return;
    const all=seats.flatMap(s=>units(cue.transition!.before,s));if(all.some(u=>!u.traits||!u.incarnation))return;
    const targets=all.filter(u=>u.traits!.includes('jedi')).map(u=>locate(cue,u)!);if(targets.some(t=>!t||!face(t.unit)||!['LOF_195','JTL_251','LOF_060','SOR_051','LOF_038'].includes(t.unit.s??'')||t.unit.u?.some(up=>up.t&&up.n==='Shield')||grit(t.unit)&&t.unit.d+6<t.unit.h||t.unit.s==='LOF_060'&&t.unit.d+6<t.unit.h))return;
    const group=g.outcomes[0]?.outcome.resolutionGroup,hits:{item:PlacedOutcome;target:Located;end:UnitRef}[]=[],deaths:Death[]=[];
    if(targets.length&&(!group?.id||group.mode!=='simultaneous'))return;
    let index=0;
    for(const t of targets){const item=g.outcomes[index++],o=item?.outcome;if(!o||!allowed(o,['amount','damageType','resolutionGroup'])||!eventSource(cue,o)||o.kind!=='damage'||!exact(o.card,t.unit)||o.seat!==t.seat||o.zone!==t.zone||o.incarnation!==t.unit.incarnation||o.amount!==6||o.damageType!=='ability'||!exact(o.resolutionGroup,group))return;const end={...t.unit,d:t.unit.d+6};replace(expected,t,end);hits.push({item,target:t,end});}
    const dead=targets.filter(t=>t.unit.d+6>=t.unit.h);
    for(const t of dead){const item=g.outcomes[index++];if(!deathProof(cue,item,t,cue.source!,['resolutionGroup'])||!exact(item.outcome.resolutionGroup,group))return;kill(expected,t,item.outcome);deaths.push({item,target:t});}
    const creates=g.outcomes.slice(index),seen=new Set<string>();if(creates.length!==dead.length)return;
    for(const item of creates){const o=item.outcome,w=o.damageDefeatOrigin,t=dead.find(t=>key(t.unit)===w?.subjectId&&t.unit.incarnation===w?.incarnation);
        if(!t||seen.has(key(t.unit))||!exact(w,{sourceId:key(cue.source),subjectId:key(t.unit),incarnation:t.unit.incarnation,controller:t.seat,amount:6})||!exact(o.requiresDefeat,{id:key(t.unit),incarnation:t.unit.incarnation})||!tokenProof(cue,item,expected,t.seat,true,['requiresDefeat','damageDefeatOrigin']))return;seen.add(key(t.unit));}
    return ending(cue,expected)?{hits,deaths,creates,items:g.outcomes}:undefined;
}
function breakingProof(cue:CardEffectCue,g:Geometry){
    const expected=paidState(cue);if(!expected||!cue.transition)return;
    if(!g.outcomes.length)return !units(cue.transition.before,cue.seat).some(u=>!u.x)&&ending(cue,expected)?{attacker:undefined,defender:undefined,shields:[],deaths:[],hits:[],items:g.outcomes}:undefined;
    const [buff,keyword,attack,exhaust]=g.outcomes,a=locate(cue,buff?.outcome.card),b=locate(cue,attack?.outcome.card);if(!a||!b||a.seat!==cue.seat||b.seat===cue.seat||a.zone!==b.zone||a.unit.x||!face(a.unit)||!face(b.unit)||a.unit.cap?.length||b.unit.cap?.length)return;
    const safe=new Set(['SOR_095','SOR_098','SOR_237','SOR_033','SOR_225','JTL_110','JTL_251','LOF_195','TWI_230','SOR_164','SHD_121','SOR_032','LOF_038']);
    if(!safe.has(a.unit.s!)||!safe.has(b.unit.s!)||a.unit.status?.some(s=>s.kind==='suppressed')||(face(a.unit)!.keywords.includes('overwhelm')||a.unit.status?.some(s=>s.keyword?.name==='Overwhelm'))&&a.unit.p+2>b.unit.h-b.unit.d||grit(a.unit)&&b.unit.p>0&&a.unit.d+b.unit.p<a.unit.h||grit(b.unit)&&b.unit.d+a.unit.p+2<b.unit.h)return;
    const id=attack.outcome.attackId,common=(o:CardEffectOutcome,t:Located,source:UnitRef,extras:string[],index=true,inc=t.unit.incarnation)=>allowed(o,['attackId',...(index?['attackIndex']:[]),...extras])&&!o.prevented&&o.attackId===id&&(!index||o.attackIndex===1)&&o.incarnation===inc&&o.seat===t.seat&&o.zone===t.zone&&exact(o.card,t.unit)&&exact(o.sourceCard,source);
    if(!id||!common(buff.outcome,a,a.unit,['amount','duration'])||buff.outcome.kind!=='buff'||buff.outcome.amount!=='+2/+0'||buff.outcome.duration!=='attack'||!common(keyword.outcome,a,a.unit,['keyword','duration'])||keyword.outcome.kind!=='keyword'||!exact(keyword.outcome.keyword,{name:'Saboteur',amount:1})||keyword.outcome.duration!=='attack'
        ||!common(attack.outcome,b,a.unit,['amount','combatOrder'],true,a.unit.incarnation)||attack.outcome.kind!=='attack'||attack.outcome.amount!==a.unit.p+2||attack.outcome.combatOrder!=='simultaneous'||!common(exhaust.outcome,a,a.unit,['amount'])||exhaust.outcome.kind!=='exhaust'||exhaust.outcome.amount!==1)return;
    let index=4;const shields:PlacedOutcome[]=[],shieldCards=b.unit.u?.filter(u=>u.t&&u.n==='Shield')??[];
    for(const up of shieldCards){const item=g.outcomes[index++],o=item?.outcome;if(!o||!allowed(o,['fromSeat','fromZone','ownerSeat','attackId'])||o.prevented||o.kind!=='defeat'||!exact(o.card,up)||!exact(o.sourceCard,a.unit)||o.seat!==b.seat||o.zone!==b.zone||o.fromSeat!==b.seat||o.fromZone!==b.zone||o.ownerSeat!==up.owner||!up.owner||o.attackId!==id||o.incarnation!==undefined)return;shields.push(item);}
    const forward=g.outcomes[index++],counter=g.outcomes[index++];
    if(!forward||!counter||!common(forward.outcome,b,a.unit,['amount','damageType'])||forward.outcome.kind!=='damage'||forward.outcome.amount!==a.unit.p+2||forward.outcome.damageType!=='combat'||!common(counter.outcome,a,b.unit,['amount','damageType'])||counter.outcome.kind!=='damage'||counter.outcome.amount!==b.unit.p||counter.outcome.damageType!=='combat')return;
    const ae={...a.unit,d:a.unit.d+b.unit.p,x:1 as const},be={...b.unit,d:b.unit.d+a.unit.p+2};if(be.u)be.u=be.u.filter(up=>!shieldCards.some(s=>same(s,up)));replace(expected,a,ae);replace(expected,b,be);
    const deaths:Death[]=[];
    for(const [t,source,end] of [[b,a.unit,be],[a,b.unit,ae]] as [Located,UnitRef,UnitRef][]){if(end.d<end.h)continue;const item=g.outcomes[index++];if(!deathProof(cue,item,t,source,['attackId'])||item.outcome.attackId!==id)return;kill(expected,t,item.outcome);deaths.push({item,target:t});}
    if(index!==g.outcomes.length||!ending(cue,expected))return;
    return {attacker:a,defender:b,shields,deaths,hits:[forward,counter],attackerEnd:ae,defenderEnd:be,buff,keyword,attack,items:g.outcomes};
}
function recipe(cue:CardEffectCue,g:Geometry){switch(cue.definition.id){case 'unmasking-the-conspiracy':return unmaskProof(cue,g);case 'breaking-in':return breakingProof(cue,g);case 'now-there-are-two-of-them':return twoProof(cue,g);case 'prisoner-of-war':return captureProof(cue,g);case 'execute-order-66':return orderProof(cue,g);}}
export const batchA13Covers=(cue:CardEffectCue,g:Geometry,item:PlacedOutcome)=>recipe(cue,g)?.items.includes(item)??false;

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
function Stats({ at, unit, p, start }: { at: EffectBox; unit: UnitRef; p: number; start: number }) {
    return <>{(['power', 'hp'] as const).map((name, i) => { const s = size(at), c = at.counters?.[name], place = c ? { ...at, ...c } : shift(at, (i ? 1 : -1) * (s.w / 2 - 10), s.h / 2 - 11); return <ScreenPixels key={name} at={place} opacity={visible(p, start)}><rect x="-10" y="-11" width="20" height="22" rx="3" fill={i ? '#173f6f' : '#8b2936'} stroke="#dcebe8" /><text textAnchor="middle" y="4" fill="#fff" stroke="none" style={{ font: '800 12px sans-serif' }}>{i ? Math.max(0, unit.h - unit.d) : unit.p}</text></ScreenPixels>; })}</>;
}
function UnitFace({ at, unit, label, p, start, opaque = false }: { at: EffectBox; unit: UnitRef; label?: string; p: number; start: number; opaque?: boolean }) {
    const s = size(at);
    return <ScreenPixels at={at} opacity={opaque ? 1 : visible(p, start)} color="#b8dad7"><g transform={`rotate(${unit.x ? 10 : 0}) scale(${unit.x ? .94 : 1})`} opacity={unit.x ? .72 : 1}><CardGhost card={unit} box={s} />{unit.sn && <text x={-s.w / 2 + 4} y={-s.h / 2 + 10} fill="#f6edd9" stroke="none" style={{ font: '700 7px sans-serif' }}>SEN</text>}{label && <><rect x={-s.w / 2 + 1} y={-s.h / 2 + 13} width={s.w - 2} height="18" fill="#101925" /><text y={-s.h / 2 + 25} textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '700 7px sans-serif' }}>{label}</text></>}{[-1, 1].map(i => <g key={i} transform={`translate(${i * (s.w / 2 - 10)} ${s.h / 2 - 11})`}><rect x="-9" y="-10" width="18" height="20" rx="3" fill={i < 0 ? '#8b2936' : '#173f6f'} /><text textAnchor="middle" y="4" fill="#fff" stroke="none" style={{ font: '800 12px sans-serif' }}>{i < 0 ? unit.p : Math.max(0, unit.h - unit.d)}</text></g>)}</g></ScreenPixels>;
}
function Settle({ cue, geometry: g, p }: Props) {
    if (!cue.transition || p < .8) return null;
    return <>{seats.flatMap(seat => units(cue.transition!.after, seat).map(unit => {
        const old = locate(cue, unit), from = old && cardAt(g, old), to = g.endingCards?.[seat + ':' + key(unit)];
        if (!from || !to || old!.seat !== seat || Math.hypot((to.x - from.x) * (from.sx ?? 1), (to.y - from.y) * (from.sy ?? 1)) < 1) return null;
        return <g key={seat + ':' + key(unit)}><Mask at={from} p={p} start={.8} /><UnitFace at={{ ...to, ...mix(from, to, easeInOut(phase(p, .8, .94))) }} unit={unit} p={p} start={.8} opaque  /></g>;
    }))}</>;
}
function Departure({ geometry: g, p, death, start, end }: Props & { death: Death; start: number; end: number }) {
    const u = death.target.unit, from = cardAt(g, death.target), owner = u.owner!, to = death.item.outcome.leader ? g.endingCards?.[owner + ':' + key(u)] ?? g.zones[owner + ':leader'] : g.zones[owner + ':discard'];
    return <><Mask at={from} p={p} start={start} /><Flight from={from} to={to} card={u} p={p} start={start} end={end} token={!!u.t} />{(u.u ?? []).map(up => { const at = g.cards?.[death.target.seat + ':' + key(up)] ?? from; return <g key={key(up)}><AttachmentMask at={at} p={p} start={start} /><Flight from={at} to={g.zones[up.owner! + ':discard']} card={up} p={p} start={start} end={end} token={!!up.t} /></g>; })}</>;
}

function Payment({cue,geometry:g,p,extra,extraStart=.42}:Props&{extra?:PlacedOutcome;extraStart?:number}){
    const before=cue.transition!.before.players[cue.seat],paid=cue.playPayment?.kind==='resources'?cue.playPayment.cardIds!:[],extraIds=extra?.outcome.cards?.map(key)??[];
    return <><ResourceBalance at={g.zones[cue.seat+':resources']} countAt={g.zones[cue.seat+':resource-count']} ready={before.res.ready-paid.length} total={before.res.total} p={p} start={.04}/>{before.resources!.map((r,i)=>{const at=g.resourceCards?.[cue.seat+':'+key(r)];return at&&(paid.includes(key(r))||extraIds.includes(key(r)))?<ResourceSlot key={key(r)} at={at} index={i} spent p={p} start={paid.includes(key(r))?.04:extraStart}/>:null;})}<Mask at={g.source} p={p} start={.04}/><Flight from={g.source} to={g.zones[cue.seat+':discard']} card={cue.source!} p={p} start={.04} end={.21}/>{extra&&<ResourceBalance at={g.zones[cue.seat+':resources']} countAt={g.zones[cue.seat+':resource-count']} ready={before.res.ready-paid.length-extraIds.length} total={before.res.total} p={p} start={extraStart}/>}</>;
}
function Band({at,lines,p,start,color='#b8dad7'}:{at:EffectBox;lines:string[];p:number;start:number;color?:string}){
    const s=size(at),h=lines.length*9+4;return <ScreenPixels at={shift(at,0,-s.h/2+13+h/2)} color={color} opacity={visible(p,start)}><rect x={-s.w/2+1} y={-h/2} width={Math.max(12,s.w-2)} height={h} rx="2" fill="#0b1722" strokeWidth="1"/>{lines.map((x,i)=><text key={i} y={-h/2+9+i*9} textAnchor="middle" fill="currentColor" stroke="none" style={{font:'700 6px sans-serif'}}>{x}</text>)}</ScreenPixels>;
}
function Unmask(props:Props){
    const {cue,geometry:g,p}=props,r=unmaskProof(cue,g);if(!r)return null;
    const enemy:Seat=cue.seat==='p1'?'p2':'p1',scale=g.source.sx??1,width=Math.max(14,Math.min(44,(1000*scale-32)/Math.max(1,r.hand.length)-4)),gap=width+4,upper=g.zones[enemy+':ground'],base=g.friendlyBase;
    const shelf={...g.source,x:500,y:(upper.y+upper.h/2+base.y-base.h/2)/2};
    const selectedIndex=r.hand.findIndex(c=>same(c,r.chosen?.outcome.card)),fan=(i:number)=>shift(shelf,(i-(r.hand.length-1)/2)*gap,0),ownFrom=r.own?.from;
    return <><Payment {...props}/>{r.own&&ownFrom&&<><Mask at={ownFrom} p={p} start={.23}/><Flight from={ownFrom} to={g.zones[cue.seat+':discard']} card={r.own.outcome.card!} p={p} start={.23} end={.39}/></>}
        <Receipt at={side(g)} rows={r.own?['OWN CHOSEN DISCARD','ACTUAL LOSS OPENS PRIVATE LOOK']:['NO OWN HAND CARD','NO INSPECTION OR OPPONENT DISCARD']} p={p} start={.08} until={.42}/>
        {r.inspect&&<><Receipt at={side(g)} rows={['PRIVATE OPPONENT HAND',`${cue.seat.toUpperCase()} CHOOSES · ${r.hand.length} CARDS`]} p={p} start={.43} until={.69}/>{r.hand.map((c,i)=><ScreenPixels key={key(c)} at={fan(i)} opacity={envelope(p,.42,.48,.76)*(i===selectedIndex?1-phase(p,.625,.64):1)} color="#bfd6e8"><CardGhost card={c} back={i!==selectedIndex||p<.49} box={{w:width,h:width*1.4}}/>{i===selectedIndex&&<rect x={-width/2-2} y={-width*.7-2} width={width+4} height={width*1.4+4} rx="3" fill="none" strokeWidth="2" opacity={visible(p,.49)}/>}</ScreenPixels>)}</>}
        {r.chosen&&<><Mask at={r.chosen.from} p={p} start={.63}/><Flight from={fan(selectedIndex)} to={g.zones[enemy+':discard']} card={r.chosen.outcome.card!} p={p} start={.63} end={.81}/></>}
        <Receipt at={side(g)} rows={r.chosen?['CHOSEN CARD → OPPONENT DISCARD','OTHER HAND CARDS STAY PRIVATE']:r.own?['OWN DISCARD RESOLVED','OPPONENT HAND EMPTY']:['PAYMENT RESOLVED','HANDS OTHERWISE UNCHANGED']} p={p} start={.83}/>
    </>;
}
function Two(props:Props){
    const {cue,geometry:g,p}=props,r=twoProof(cue,g);if(!r)return null;
    const t=r.unit&&locate(cue,r.unit),at=t&&cardAt(g,t),to=r.play&&(g.endingCards?.[cue.seat+':'+key(r.play.outcome.unit)]??r.play.to);
    return <><Payment {...props} extra={r.pay}/><Receipt at={side(g)} rows={r.play?[`EXACTLY ONE OWN UNIT · ${r.cost!.outcome.singleUnitPlay!.sharedTrait.toUpperCase()}`,`UNIT COST ${r.play.outcome.printedCost} −5 · PAY ${r.price}`,'OWN HAND · NORMAL ENTRY']:['NO UNIT PLAYED','PAYMENT RESOLVED']} p={p} start={.08} until={.55}/>
        {at&&<Band at={at} lines={[r.cost!.outcome.singleUnitPlay!.sharedTrait.toUpperCase(),'SHARED TRAIT']} p={p} start={.25}/>}
        {r.play&&to&&<><Mask at={r.play.from} p={p} start={.49}/><Flight from={r.play.from} to={to} card={r.play.outcome.unit!} p={p} start={.5} end={.73} arrive/>{p>=.73&&<UnitFace at={to} unit={r.play.outcome.unit!} label="PLAYED · EXHAUSTED" p={p} start={.73}/>}</>}
        <Settle {...props}/><Receipt at={side(g)} rows={r.play?['TWO UNITS NOW · ORIGINAL KEPT','SEPARATE UNIT PAYMENT RESOLVED','NO ATTACK OR AMBUSH']:['EVENT RESOLVED','NO NEW BODY']} p={p} start={.83}/>
    </>;
}
function Prisoner(props:Props){
    const {cue,geometry:g,p}=props,r=captureProof(cue,g);if(!r)return null;
    const from=cardAt(g,r.target),to=r.capture.to,success=!r.capture.outcome.prevented,s=size(to);
    // On desktop the right receipt shares the captor's counter row. Use the actual clear
    // interval between both players' unit faces; keep the established mobile HQ shelf.
    const upper=units(cue.transition!.before,'p2').map(u=>g.cards?.['p2:'+key(u)]).filter((b):b is EffectBox=>!!b),lower=units(cue.transition!.before,'p1').map(u=>g.cards?.['p1:'+key(u)]).filter((b):b is EffectBox=>!!b);
    const receipt=(g.source.sx??1)>.65&&upper.length&&lower.length?{...side(g),y:(Math.max(...upper.map(b=>b.y+b.h/2))+Math.min(...lower.map(b=>b.y-b.h/2)))/2}:side(g);
    return <><Payment {...props}/><Receipt at={receipt} rows={['ANY ARENAS · FRIENDLY CAPTOR',`PRINTED COST ${r.tc} ${r.tc<r.ac?'<':'≥'} ${r.ac}`,r.tc<r.ac?'TWO DROIDS FOR CAPTOR CONTROLLER':'NO DROID BONUS']} p={p} start={.08} until={.59}/>
        {success&&<><Mask at={from} p={p} start={.3}/><Flight from={from} to={to} card={r.target.unit} back p={p} start={.31} end={.62}/>{(r.target.unit.u??[]).map(up=>{const at=g.cards?.[r.target.seat+':'+key(up)]??from;return <g key={key(up)}><AttachmentMask at={at} p={p} start={.3}/><Flight from={at} to={g.zones[up.owner!+':discard']} card={up} token={!!up.t} p={p} start={.31} end={.57}/></g>;})}</>}
        {success&&(()=>{const pocket=g.endingPockets?.[cue.seat+':'+key(r.captor.unit)]??g.pockets?.[cue.seat+':'+key(r.captor.unit)];const count=(r.captor.unit.cap?.length??0)+(r.target.unit.t?0:1);return pocket?<><AttachmentMask at={pocket} p={p} start={.6}/><ScreenPixels at={shift(pocket,-size(pocket).w/2+(size(pocket).w<70?12:18),0)} opacity={visible(p,.6)} color="#d6c6ee"><text y="-5" textAnchor="middle" fill="currentColor" stroke="none" style={{font:'700 5px sans-serif'}}>CAPTIVE</text><text y="9" textAnchor="middle" fill="currentColor" stroke="none" style={{font:'800 12px sans-serif'}}>{count}</text></ScreenPixels></>:null;})()}
        {r.creates.map((item,i)=><TokenAssembly key={item.key} at={g.endingCards?.[item.outcome.seat+':'+key(item.outcome.unit)]??item.to} unit={item.outcome.unit!} p={p} start={.58+i*.025} end={.79+i*.025}/>)}
        {success&&!r.target.unit.t&&<ScreenPixels at={to} opacity={visible(p,.6)}><CardGhost card={r.target.unit} back box={{w:Math.max(12,Math.min(24,s.w)),h:Math.max(17,Math.min(34,s.h))}}/></ScreenPixels>}
        <Settle {...props}/><Receipt at={receipt} rows={[success?(r.target.unit.t?'CAPTURED TOKEN CEASES':'OWNER KEPT · FACEDOWN POCKET'):'CAPTURE PREVENTED · BODY STAYS',r.creates.length?'STRICT LOWER COST · TWO EXHAUSTED DROIDS':'PRINTED COMPARISON · NO DROIDS']} p={p} start={.85}/>
    </>;
}
function Breaking(props:Props){
    const {cue,geometry:g,p}=props,r=breakingProof(cue,g);if(!r)return null;
    if(!r.attacker||!r.defender)return <><Payment {...props}/><Receipt at={side(g)} rows={['NO READY UNIT','NO ATTACK RESOLVED']} p={p} start={.12}/></>;
    const a=cardAt(g,r.attacker),b=cardAt(g,r.defender),right={...b,x:1000-18/(b.sx??1)},route=[a,{...a,x:right.x},right,b],t=easeInOut(phase(p,.29,.49)),leg=Math.min(2,Math.floor(t*3)),packet={...a,...mix(route[leg],route[leg+1],Math.min(1,t*3-leg))};
    return <><Payment {...props}/><Receipt at={side(g)} rows={['+2 POWER · SABOTEUR THIS ATTACK','IGNORE SENTINEL · DEFEAT SHIELDS','SIMULTANEOUS COMBAT']} p={p} start={.07} until={.58}/>
        <Mask at={a} p={p} start={.25}/>{p>=.25&&p<.61&&<UnitFace at={a} unit={{...r.attacker.unit,p:r.attacker.unit.p+2,d:p>=.53?r.attackerEnd!.d:r.attacker.unit.d,x:1}} label="SABOTEUR · ATTACK" p={p} start={.25}/>}
        <ScreenPixels at={packet} opacity={envelope(p,.29,.32,.51)} color="#b8d6e9"><path d="M-7 0 H7 M2 -5 L7 0 L2 5" fill="none" strokeWidth="2"/><text x="0" y="-9" textAnchor="middle" fill="currentColor" stroke="none" style={{font:'800 10px sans-serif'}}>{r.attacker.unit.p+2}</text></ScreenPixels>
        {r.shields.map(item=>{const at=g.cards?.[r.defender!.seat+':'+key(item.outcome.card)]??b;return <g key={item.key}><AttachmentMask at={at} p={p} start={.36}/><ScreenPixels at={at} opacity={envelope(p,.36,.4,.52)} color="#9cc8ec"><path d="M-12 -5 L-4 2 M12 -5 L4 2 M-10 9 L-2 3 M10 9 L2 3" strokeWidth="2"/></ScreenPixels></g>;})}
        {r.hits.map((item,i)=>{const target=i?r.attacker!:r.defender!,at=cardAt(g,target),s=size(at);return <ScreenPixels key={item.key} at={at} color="#efb39b" opacity={envelope(p,.49,.52,.63)}><rect x={-s.w/2} y="-8" width={s.w} height="17" fill="#4a2423" strokeWidth="1"/><text y="4" textAnchor="middle" fill="currentColor" stroke="none" style={{font:'800 11px sans-serif'}}>{item.outcome.amount}</text></ScreenPixels>;})}
        <Stats at={b} unit={r.defenderEnd!} p={p} start={.53}/>{r.deaths.map(death=><Departure key={death.item.key} {...props} death={death} start={.61} end={.77}/>)}
        {p>=.61&&r.attackerEnd!.d<r.attackerEnd!.h&&<><Mask at={a} p={p} start={.61}/><UnitFace at={a} unit={r.attackerEnd!} label="ATTACK FINISHED" p={p} start={.61} opaque/></>}
        <Receipt at={side(g)} rows={[`FORWARD ${r.attacker.unit.p+2} · COUNTER ${r.defender.unit.p}`,'ATTACK BONUS AND SABOTEUR EXPIRE','SURVIVING WOUNDS / EXHAUSTION KEPT']} p={p} start={.83}/>
    </>;
}
function Order(props:Props){
    const {cue,geometry:g,p}=props,r=orderProof(cue,g);if(!r)return null;
    return <><Payment {...props}/><Receipt at={side(g)} rows={['EVERY JEDI · BOTH PLAYERS / ARENAS','SIX ABILITY DAMAGE','CLONES ONLY FOR CAUSAL DEFEATS']} p={p} start={.08} until={.53}/>
        {r.hits.map(({item,target,end})=>{const at=cardAt(g,target),s=size(at);return <g key={item.key}><ScreenPixels at={at} color="#ebbc9e" opacity={envelope(p,.28,.34,.56)}><path d={`M${-s.w/2-2} ${-s.h/2+2} L${s.w/2+2} ${s.h/2-2} M${s.w/2+2} ${-s.h/2+2} L${-s.w/2-2} ${s.h/2-2}`} strokeWidth="2"/><rect x={-s.w/2} y="-8" width={s.w} height="17" fill="#39252b"/><text y="4" textAnchor="middle" fill="currentColor" stroke="none" style={{font:'800 12px sans-serif'}}>6</text></ScreenPixels><Stats at={at} unit={end} p={p} start={.48}/></g>;})}
        {r.deaths.map(death=><Departure key={death.item.key} {...props} death={death} start={.54} end={.71}/>)}
        {r.creates.map((item,i)=><TokenAssembly key={item.key} at={g.endingCards?.[item.outcome.seat+':'+key(item.outcome.unit)]??item.to} unit={item.outcome.unit!} p={p} start={.7+i*.013} end={.85+i*.013} color={item.outcome.seat==='p1'?'#a8d5ea':'#dfb8ae'}/>)}<Settle {...props}/>
        <Receipt at={side(g)} rows={[`${r.deaths.length} JEDI DEFEATS · ${r.creates.length} CLONES`,'CONTROLLER AT DEFEAT RECEIVES CLONE','SURVIVING JEDI KEEP SIX WOUNDS']} p={p} start={.88}/>
    </>;
}
export function BatchA13Signature(props:Props){switch(props.cue.definition.id){case 'unmasking-the-conspiracy':return <Unmask {...props}/>;case 'breaking-in':return <Breaking {...props}/>;case 'now-there-are-two-of-them':return <Two {...props}/>;case 'prisoner-of-war':return <Prisoner {...props}/>;case 'execute-order-66':return <Order {...props}/>;default:return null;}}
