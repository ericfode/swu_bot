import type { CardRef, Seat, UnitRef } from '../data/types';
import type { CardEffectCue, CardEffectOutcome } from './types';
import { A08_DEFINITIONS } from './batchA08';
import { previewPlayCost } from './previewCosts';
import { easeInOut, envelope, phase } from './animationTimeline';
import { CardGhost, ScreenPixels, CountedMarks, ResourceBalance, ResourceSlot, AttachmentMask, mix, screenShift as shift, type EffectBox, type PlacedOutcome } from './primitives';

type Geometry = { source: EffectBox; target: EffectBox; friendlyBase: EffectBox; outcomes: PlacedOutcome[]; zones: Record<string, EffectBox>; cards?: Record<string, EffectBox>; endingCards?: Record<string, EffectBox>; pockets?: Record<string, EffectBox>; resourceCards?: Record<string, EffectBox> };
type Props = { cue: CardEffectCue; geometry: Geometry; p: number };
const ids = new Set(['surprise-strike', 'evacuate', 'no-bargain', 'this-is-the-way', 'confiscate']);
export const isBatchA08Secondary = (cue: CardEffectCue) => ids.has(cue.definition.id);
const key = (card?: CardRef | null) => card?.id ?? `${card?.s ?? ''}:${card?.n ?? ''}`;
const same = (a?: CardRef | null, b?: CardRef | null) => !!a && !!b && key(a) === key(b);
const unitIn = (cue: CardEffectCue, card: CardRef | null | undefined, seat: Seat, after = false) => {
    const player = cue.transition?.[after ? 'after' : 'before'].players[seat];
    return [...(player?.ground ?? []), ...(player?.space ?? [])].find(unit => same(unit, card));
};
const sizeOf = (at: EffectBox) => at.cardSize ?? { w: at.w * (at.sx ?? 1), h: at.h * (at.sy ?? 1) };
const visible = (p: number, start: number) => phase(p, start, start + .06);
const bounded = (at: EffectBox, w = 120, h = 22): EffectBox => ({ ...at,
    x: Math.max((w / 2 + 8) / (at.sx ?? 1), Math.min(1000 - (w / 2 + 8) / (at.sx ?? 1), at.x)),
    y: Math.max((h / 2 + 40) / (at.sy ?? 1), Math.min(600 - (h / 2 + 122) / (at.sy ?? 1), at.y)) });
const center = (g: Geometry) => {
    const upper = g.zones['p2:ground'], base = g.zones['p1:base'];
    return bounded({ ...g.source, x: 500, y: upper && base ? (upper.y + upper.h / 2 + base.y - base.h / 2) / 2 : 300 });
};
function Receipt({ at, rows, p, start = .7, until, color = '#dbe6ff' }: { at: EffectBox; rows: string[]; p: number; start?: number; until?: number; color?: string }) {
    const w = Math.min(242, Math.max(70, ...rows.map(row => row.length * 4.8 + 18))), h = rows.length * 18 + 6;
    return <ScreenPixels at={bounded(at, w, h)} color={color} opacity={visible(p, start) * (until ? 1 - phase(p, until - .06, until) : 1)}><rect x={-w / 2} y={-h / 2} width={w} height={h} rx="4" fill="#08111e" fillOpacity=".97" strokeWidth="1" />{rows.map((row, i) => <text key={i} y={-h / 2 + 15 + i * 18} textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '700 9px var(--font-display,sans-serif)' }}>{row}</text>)}</ScreenPixels>;
}
function Mask({ at, p, start }: { at: EffectBox; p: number; start: number }) {
    const s = sizeOf(at);
    return <ScreenPixels at={at} opacity={visible(p, start)}><rect x={-s.w / 2 - 5} y={-s.h / 2 - 5} width={s.w + 10} height={s.h + 10} rx="5" fill="#09121f" stroke="none" /></ScreenPixels>;
}
function Travel({ from, to, card, p, start, end, back = false, hold = true, exhausted = false, initialSize, route, growAt = 0, color = '#d6e4ff' }: { from: EffectBox; to: EffectBox; card?: CardRef | null; p: number; start: number; end: number; back?: boolean; hold?: boolean; exhausted?: boolean; initialSize?: { w: number; h: number }; route?: EffectBox[]; growAt?: number; color?: string }) {
    if (p < start) return null;
    const t = easeInOut(phase(p, start, end)), mid = shift({ ...from, ...mix(from, to, .5) }, 20, -36);
    const points = route ? [from, ...route, to] : undefined;
    const segment = points ? Math.min(points.length - 2, Math.floor(t * (points.length - 1))) : 0;
    const at = { ...from, ...(points ? mix(points[segment], points[segment + 1], easeInOut(t * (points.length - 1) - segment)) : { x: (1 - t) ** 2 * from.x + 2 * (1 - t) * t * mid.x + t * t * to.x, y: (1 - t) ** 2 * from.y + 2 * (1 - t) * t * mid.y + t * t * to.y }) };
    const a = initialSize ?? sizeOf(from), b = to.cardSize ?? { w: 38, h: 53.2 }, grow = phase(t, growAt, 1);
    const path = points ? points.map((point, i) => `${i ? 'L' : 'M'}${point.x} ${point.y}`).join(' ') : `M${from.x} ${from.y} Q${mid.x} ${mid.y} ${to.x} ${to.y}`;
    return <><path d={path} pathLength="1" strokeDasharray="1" strokeDashoffset={1 - t} stroke={color} strokeWidth="2" opacity={envelope(p, start, start + .05, end + .12)} /><ScreenPixels at={at} opacity={visible(p, start) * (hold ? 1 : 1 - phase(p, end, end + .075))} color={color}><g transform={`rotate(${exhausted ? 10 * t : -7 * Math.sin(t * Math.PI)})`} opacity={exhausted ? 1 - .28 * t : 1}><CardGhost card={card} back={back} box={{ w: a.w + (b.w - a.w) * grow, h: a.h + (b.h - a.h) * grow }} /></g></ScreenPixels></>;
}

const num = (o: CardEffectOutcome) => typeof o.amount === 'number' ? o.amount : NaN;
const fullUnit = (card?: CardRef | null): card is UnitRef => !!card && 'p' in card && 'h' in card && 'd' in card;
const unchanged = (a: UnitRef, b: UnitRef) => a.incarnation === b.incarnation && a.owner === b.owner && a.p === b.p && a.h === b.h && a.d === b.d;
const paidEventIds = (cue: CardEffectCue) => cue.playPayment?.kind === 'resources' ? cue.playPayment.cardIds : undefined;
const sameStats = (a: UnitRef, b: UnitRef) => unchanged(a, b) && !!a.x === !!b.x;
function Payment({ cue, geometry:g, p }: Props) {
    const before = cue.transition?.before.players[cue.seat], ids = paidEventIds(cue);
    if (!before?.resources || !ids || ids.length !== cue.playCost) return null;
    return <>{before.resources.map((resource, i) => { const at=g.resourceCards?.[`${cue.seat}:${key(resource)}`];return at && ids.includes(key(resource)) ? <ResourceSlot key={key(resource)} at={at} index={i} spent p={p} start={.04} /> : null; })}<ResourceBalance at={g.zones[`${cue.seat}:resources`]} countAt={g.zones[`${cue.seat}:resource-count`]} ready={before.res.ready-cue.playCost!} total={before.res.total} p={p} start={.04}/></>;
}
function Stats({ at, unit, p, start }: { at:EffectBox;unit:UnitRef;p:number;start:number }) {
    return <>{(['power','hp'] as const).map((name,i)=>{const counter=at.counters?.[name], shape=sizeOf(at), pos=counter?{...at,...counter}:shift(at,(i?1:-1)*(shape.w/2-10),shape.h/2-12);return <ScreenPixels key={name} at={pos} opacity={visible(p,start)}><rect x="-11" y="-12" width="22" height="24" rx="3" fill={i?'#173f6f':'#8b2936'} stroke="#dce7f8" strokeWidth="1"/><text textAnchor="middle" y="4" fill="#fff" stroke="none" style={{font:'800 14px sans-serif'}}>{i?Math.max(0,unit.h-unit.d):unit.p}</text></ScreenPixels>;})}</>;
}
function UnitFace({ at, unit, p, start, rotation=0, opacity=1, instant=false }: {at:EffectBox;unit:UnitRef;p:number;start:number;rotation?:number;opacity?:number;instant?:boolean}) {
    const shape=sizeOf(at); return <ScreenPixels at={at} opacity={(p<start?0:instant?1:visible(p,start))*opacity}><g transform={`rotate(${rotation}) scale(${rotation? .94:1})`} opacity={rotation ? .72 : 1}><CardGhost card={unit} box={shape}/>{[-1,1].map(side=><g key={side} transform={`translate(${side*(shape.w/2-10)} ${shape.h/2-11})`}><rect x="-10" y="-11" width="20" height="22" rx="3" fill={side<0?'#8b2936':'#173f6f'}/><text textAnchor="middle" y="4" fill="#fff" stroke="none" style={{font:'800 13px sans-serif'}}>{side<0?unit.p:Math.max(0,unit.h-unit.d)}</text></g>)}</g></ScreenPixels>;
}
function Packet({from,to,count,p,start,end,color='#efb994'}:{from:EffectBox;to:EffectBox;count:number;p:number;start:number;end:number;color?:string}) {
    const at={...from,...mix(from,to,easeInOut(phase(p,start,end)))};return <><path d={`M${from.x} ${from.y} L${to.x} ${to.y}`} stroke={color} strokeWidth="2" opacity={envelope(p,start,start+.04,end+.1)}/><ScreenPixels at={at} opacity={envelope(p,start,start+.04,end+.045)} color={color}><CountedMarks count={count} gap={12} radius={4}/></ScreenPixels></>;
}

const seats: Seat[] = ['p1', 'p2'];
const refEqual = (a?: CardRef | null,b?: CardRef | null) => same(a,b) && a?.n===b?.n && a?.s===b?.s && a?.owner===b?.owner;
const ordered = (a:CardRef[],b:CardRef[]) => a.length===b.length && a.every((c,i)=>refEqual(c,b[i]));
const units = (cue:CardEffectCue,seat:Seat,after=false) => [...(cue.transition?.[after?'after':'before'].players[seat].ground??[]),...(cue.transition?.[after?'after':'before'].players[seat].space??[])];
function eventProof(cue:CardEffectCue) {
    const canonical=A08_DEFINITIONS.find(definition=>definition.id===cue.definition.id);
    if(!canonical||cue.definition.name!==canonical.name||cue.definition.setCode!==canonical.setCode)return false;
    const before=cue.transition?.before.players[cue.seat],after=cue.transition?.after.players[cue.seat],paid=paidEventIds(cue);
    let cost:number;try{if(!cue.transition||cue.playPayment?.kind!=='resources'||cue.playPayment.smuggle)return false;cost=previewPlayCost(cue.definition,cue.transition.before,cue.seat,cue.playPayment);}catch{return false;}
    return !cue.stage && !!before && !!after && !!cue.source?.id && cue.source.s===cue.definition.setCode && cue.source.n===cue.definition.name && cue.source.owner===cue.seat && !!paid && cue.playCost===cost && Number.isSafeInteger(cue.playCost) && cue.playCost!>=0 && paid.length===cue.playCost && new Set(paid).size===paid.length
        && before.hand.filter(c=>refEqual(c,cue.source)).length===1 && !after.hand.some(c=>same(c,cue.source)) && after.discard.filter(c=>refEqual(c,cue.source)).length===1
        && before.resources?.length===before.res.total && after.resources?.length===after.res.total && before.res.total===after.res.total && after.res.ready===before.res.ready-cue.playCost!
        && before.resources.filter(c=>!c.x).length===before.res.ready && after.resources.filter(c=>!c.x).length===after.res.ready
        && paid.every(id=>before.resources?.some(c=>c.id===id&&!c.x)) && before.resources.every(c=>after.resources?.some(r=>refEqual(c,r)&&!!r.x===(!!c.x||paid.includes(key(c)))));
}
function surpriseProof(cue:CardEffectCue,g:Geometry) {
    if(!eventProof(cue))return;
    const attack=g.outcomes.find(i=>i.outcome.kind==='attack'),o=attack?.outcome;
    if(!attack||!o||o.prevented||!o.attackId||o.combatOrder!=='simultaneous'||!fullUnit(o.sourceCard)||!fullUnit(o.card)||o.seat===cue.seat)return;
    const a=unitIn(cue,o.sourceCard,cue.seat),t=unitIn(cue,o.card,o.seat);
    if(!a||!t||!a.owner||!t.owner||!a.incarnation||!t.incarnation||a.x||!sameStats(a,o.sourceCard)||!sameStats(t,o.card)||a.u?.length||t.u?.length||a.cap?.length||t.cap?.length||!cue.transition?.before.players[cue.seat][o.zone==='space'?'space':'ground'].some(c=>same(c,a)))return;
    if(cue.transition.before.players[o.seat][o.zone==='space'?'space':'ground'].some(c=>c.sn)&&!t.sn)return;
    const linked=g.outcomes.filter(i=>i.outcome.attackId===o.attackId),buff=linked.find(i=>i.outcome.kind==='buff'),exhaust=linked.find(i=>i.outcome.kind==='exhaust'),forward=linked.find(i=>i.outcome.kind==='damage'&&same(i.outcome.card,t)),counter=linked.find(i=>i.outcome.kind==='damage'&&same(i.outcome.card,a)),ad=linked.find(i=>i.outcome.kind==='defeat'&&same(i.outcome.card,a)),td=linked.find(i=>i.outcome.kind==='defeat'&&same(i.outcome.card,t));
    if(linked.some(i=>i.outcome.prevented))return;
    if(linked.length!==7||!buff||!exhaust||!forward||!counter||!ad||!td||buff.outcome.amount!=='+3/+0'||buff.outcome.duration!=='attack'||buff.outcome.attackRole!=='attacker'||!same(buff.outcome.card,a)||!same(exhaust.outcome.card,a)||exhaust.outcome.seat!==cue.seat||g.outcomes.indexOf(buff)>=g.outcomes.indexOf(attack)||g.outcomes.indexOf(exhaust)<=g.outcomes.indexOf(attack)||g.outcomes.indexOf(exhaust)>=g.outcomes.indexOf(forward)||g.outcomes.indexOf(counter)<=g.outcomes.indexOf(forward)||forward.outcome.damageType!=='combat'||counter.outcome.damageType!=='combat'||forward.outcome.attackIndex!==1||counter.outcome.attackIndex!==2||!same(forward.outcome.sourceCard,a)||!same(counter.outcome.sourceCard,t)||num(forward.outcome)!==Math.max(0,a.p+3)||num(counter.outcome)!==Math.max(0,t.p)||t.d+num(forward.outcome)<t.h||a.d+num(counter.outcome)<a.h)return;
    for(const [death,old,hit,seat] of [[ad,a,counter,cue.seat],[td,t,forward,o.seat]] as const){if(death.outcome.prevented||death.outcome.ownerSeat!==old.owner||death.outcome.incarnation!==old.incarnation||g.outcomes.indexOf(death)<=g.outcomes.indexOf(hit)||units(cue,seat,true).some(c=>same(c,old))||!cue.transition.after.players[old.owner!].discard.some(c=>refEqual(c,old))||seats.some(s=>cue.transition?.before.players[s].leader?.id===old.id))return;}
    return {attack,a,t,forward,counter,ad,td,linked};
}
function evacuationProof(cue:CardEffectCue,g:Geometry) {
    if(!eventProof(cue)||!cue.transition)return;
    const before=cue.transition.before,after=cue.transition.after;
    const members=seats.flatMap(seat=>(['ground','space'] as const).flatMap(zone=>before.players[seat][zone].filter(c=>!seats.some(s=>before.players[s].leader?.id===c.id)).map(c=>({seat,zone,c}))));
    if(!members.length||g.outcomes.length!==members.length)return;
    const seen=new Set<string>(),group=g.outcomes[0].outcome.resolutionGroup;
    if(!group||group.mode!=='simultaneous')return;
    for(const {c,seat,zone} of members){const item=g.outcomes.find(i=>same(i.outcome.card,c)),o=item?.outcome;if(!item||!o||!c.owner||!c.incarnation||seen.has(key(c))||c.cap?.length||c.u?.some(u=>u.t)||o.kind!=='return'||o.prevented||o.fromSeat!==seat||o.fromZone!==zone||o.seat!==c.owner||o.ownerSeat!==c.owner||o.zone!=='hand'||o.incarnation!==c.incarnation||o.selection!=='all'||JSON.stringify(o.resolutionGroup)!==JSON.stringify(group)||!fullUnit(o.card)||!sameStats(o.card,c)||seats.some(s=>units(cue,s,true).some(u=>same(u,c)))||after.players[c.owner].hand.filter(u=>refEqual(u,c)).length!==1)return;seen.add(key(c));for(const u of c.u??[])if(!u.owner||after.players[u.owner].discard.filter(d=>refEqual(d,u)).length!==1)return;}
    for(const seat of seats){const p=before.players[seat],q=after.players[seat],arrivals=members.filter(m=>m.c.owner===seat).map(m=>m.c);if(!ordered(q.hand,[...p.hand.filter(c=>!same(c,cue.source)),...arrivals]))return;for(const old of units(cue,seat).filter(c=>!seen.has(key(c)))){const current=units(cue,seat,true).find(c=>same(c,old));if(!current||JSON.stringify(old)!==JSON.stringify(current))return;}if(units(cue,seat,true).length!==units(cue,seat).filter(c=>!seen.has(key(c))).length)return;}
    return {members,items:g.outcomes};
}
function bargainProof(cue:CardEffectCue,g:Geometry) {
    if(!eventProof(cue)||!cue.transition)return;
    const draw=g.outcomes.find(i=>i.outcome.kind==='draw'),discard=g.outcomes.find(i=>i.outcome.kind==='discard'),before=cue.transition.before.players[cue.seat],after=cue.transition.after.players[cue.seat],foe:Seat=cue.seat==='p1'?'p2':'p1',q=cue.transition.before.players[foe],end=cue.transition.after.players[foe],group=draw?.outcome.resolutionGroup,top=before.knownDeck?.[0];
    if(draw?.outcome.prevented)return;
    if(!draw||!top||num(draw.outcome)!==1||draw.outcome.seat!==cue.seat||draw.outcome.fromSeat!==cue.seat||draw.outcome.fromZone!=='deck'||!draw.outcome.cards||!ordered(draw.outcome.cards,[top])||draw.outcome.requiresDefeat||draw.outcome.requiresReturn||!group||group.mode!=='simultaneous'||after.deck!==before.deck-1||!ordered(after.knownDeck??[],before.knownDeck!.slice(1))||!ordered(after.hand,[...before.hand.filter(c=>!same(c,cue.source)),top]))return;
    if(discard){const o=discard.outcome,c=q.hand.find(c=>refEqual(c,o.card));if(!c||!c.owner||num(o)!==1||o.seat!==foe||o.fromSeat!==foe||o.fromZone!=='hand'||o.chooserSeat!==foe||o.selection!=='opponent'||o.ownerSeat!==c.owner||o.prevented||JSON.stringify(o.resolutionGroup)!==JSON.stringify(group)||!ordered(end.hand,q.hand.filter(x=>!same(x,c)))||!cue.transition.after.players[c.owner].discard.some(x=>refEqual(x,c)))return;}else if(q.hand.length)return;
    if(g.outcomes.length!==(discard?2:1))return;
    return {draw,discard,top,foe,after};
}
function wayProof(cue:CardEffectCue,g:Geometry) {
    if(!eventProof(cue)||!cue.transition)return;
    const search=g.outcomes.find(i=>i.outcome.kind==='search'),op=search?.outcome.deckOperation,draw=g.outcomes.find(i=>i.outcome.kind==='draw'),p=cue.transition.before.players[cue.seat],q=cue.transition.after.players[cue.seat],deck=p.knownDeck;
    if(search?.outcome.prevented||draw?.outcome.prevented)return;
    if(!search||!op||!deck||deck.length!==p.deck||new Set(deck.map(key)).size!==deck.length||op.scope!=='top'||op.visibility!=='private'||op.policy!=='top-search-bottom'||op.selectionLimit!==2||!ordered(op.looked,deck.slice(0,8))||num(search.outcome)!==op.looked.length||op.selectedIds.length>2||new Set(op.selectedIds).size!==op.selectedIds.length||!op.revealedIds||op.revealedIds.length!==op.selectedIds.length||op.revealedIds.some(id=>!op.selectedIds.includes(id))||op.remainingOrder.length!==deck.length||new Set(op.remainingOrder.map(key)).size!==deck.length||op.remainingOrder.some(c=>!deck.some(d=>refEqual(c,d))))return;
    const chosen=op.selectedIds.map(id=>op.looked.find(c=>c.id===id));if(chosen.some(c=>!c||!['SOR_142','SOR_070','HMW_096'].includes(c.s??'')))return;
    const cards=chosen as CardRef[],remaining=op.remainingOrder.filter(c=>!op.selectedIds.includes(key(c)));
    if(!ordered(remaining.slice(0,deck.length-op.looked.length),deck.slice(op.looked.length))||!ordered(q.knownDeck??[],remaining)||q.deck!==p.deck-cards.length||!ordered(q.hand,[...p.hand.filter(c=>!same(c,cue.source)),...cards]))return;
    if(cards.length){if(!draw||num(draw.outcome)!==cards.length||draw.outcome.seat!==cue.seat||draw.outcome.visibility!=='public'||!draw.outcome.cards||!ordered(draw.outcome.cards,cards)||g.outcomes.indexOf(draw)<=g.outcomes.indexOf(search)||g.outcomes.length!==2)return;}else if(draw||g.outcomes.length!==1)return;
    return {search,draw,op,cards,remaining,q};
}
function confiscateProof(cue:CardEffectCue,g:Geometry) {
    if(!eventProof(cue)||!cue.transition||g.outcomes.length!==1)return;
    const item=g.outcomes[0],o=item.outcome,host=unitIn(cue,o.sourceCard,o.seat),after=unitIn(cue,o.sourceCard,o.seat,true),up=host?.u?.find(u=>refEqual(u,o.card));
    if(o.kind!=='defeat'||o.prevented||!host||!after||!up||up.t||up.s!=='SOR_120'||up.p!==2||up.h!==2||!up.owner||o.ownerSeat!==up.owner||!fullUnit(o.sourceCard)||!sameStats(o.sourceCard,host)||after.p!==host.p-up.p||after.h!==host.h-up.h||after.d!==host.d||after.d>=after.h||after.incarnation!==host.incarnation||after.owner!==host.owner||!!after.x!==!!host.x||JSON.stringify(after.u??[])!==JSON.stringify((host.u??[]).filter(u=>!same(u,up)))||cue.transition.after.players[up.owner].discard.filter(c=>refEqual(c,up)).length!==1)return;
    return {item,host,after,up};
}
export function batchA08SecondaryCovers(cue:CardEffectCue,g:Geometry,item:PlacedOutcome):boolean {
    switch(cue.definition.id){
        case 'surprise-strike':return surpriseProof(cue,g)?.linked.includes(item)??false;
        case 'evacuate':return evacuationProof(cue,g)?.items.includes(item)??false;
        case 'no-bargain':{const p=bargainProof(cue,g);return !!p&&(item===p.draw||item===p.discard);}
        case 'this-is-the-way':{const p=wayProof(cue,g);return !!p&&(item===p.search||item===p.draw);}
        case 'confiscate':return item===confiscateProof(cue,g)?.item;
        default:return false;
    }
}
function Cleanup({cue,geometry:g,unit,p}:{cue:CardEffectCue;geometry:Geometry;unit:UnitRef;p:number}) {
    const side=seats.find(s=>units(cue,s).some(u=>same(u,unit)));if(!side)return null;
    return <>{(unit.u??[]).map(up=>{const at=g.cards?.[`${side}:${key(up)}`];if(!at||!up.owner)return null;return <g key={key(up)}><AttachmentMask at={at} p={p} start={.22}/><Receipt at={center(g)} rows={[up.n.toUpperCase(),`OWNER ${up.owner.toUpperCase()} DISCARD`]} p={p} start={.24} until={.48} color="#d8bea8"/></g>;})}</>;
}
function Surprise({cue,geometry:g,p}:Props) {
    const r=surpriseProof(cue,g);if(!r)return null;const a=r.attack.from,t=r.attack.box,flight=Math.sin(phase(p,.3,.53)*Math.PI),moving={...a,...mix(a,t,flight*.22)},power=r.a.p+3;
    return <><Payment cue={cue} geometry={g} p={p}/><Mask at={g.source} p={p} start={.04}/><Receipt at={center(g)} rows={['ONE ATTACK · POWER +3',`${r.a.p} → ${power} THIS ATTACK`]} p={p} start={.04} until={.29} color="#edbd92"/><Mask at={a} p={p} start={.3}/>{p<.63&&<UnitFace at={moving} unit={{...r.a,p:power,d:r.a.d+(p>=.57?num(r.counter.outcome):0)}} p={p} start={.3} rotation={10*phase(p,.43,.55)} instant/>}<Packet from={moving} to={t} count={num(r.forward.outcome)} p={p} start={.36} end={.46}/><Packet from={t} to={a} count={num(r.counter.outcome)} p={p} start={.46} end={.57} color="#b9d4f2"/><Stats at={t} unit={{...r.t,d:r.t.d+num(r.forward.outcome)}} p={p} start={.46}/><Mask at={t} p={p} start={.63}/><Travel from={a} to={g.zones[`${r.a.owner}:discard`]} card={r.a} p={p} start={.63} end={.84} hold={false}/><Travel from={t} to={g.zones[`${r.t.owner}:discard`]} card={r.t} p={p} start={.63} end={.84} hold={false}/><Receipt at={center(g)} rows={[`FORWARD ${num(r.forward.outcome)} · COUNTER ${num(r.counter.outcome)}`,'SIMULTANEOUS COMBAT · BOTH DEFEATED']} p={p} start={.66} color="#e3bdb3"/></>;
}
function Evacuate({cue,geometry:g,p}:Props) {
    const r=evacuationProof(cue,g);if(!r)return null;
    return <><Payment cue={cue} geometry={g} p={p}/><Mask at={g.source} p={p} start={.04}/><Receipt at={center(g)} rows={['ALL NON-LEADERS · BOTH ARENAS','DEPLOYED LEADER STAYS']} p={p} start={.04} until={.24} color="#c7d4eb"/>{r.items.map((item,i)=>{const u=item.outcome.card as UnitRef,to=g.endingCards?.[`${item.outcome.seat}:${key(u)}`]??item.to;return <g key={item.key}><Mask at={item.from} p={p} start={.25}/><Cleanup cue={cue} geometry={g} unit={u} p={p}/><Travel from={item.from} to={to} card={u} p={p} start={.27+i*.012} end={.67+i*.012} color={item.outcome.seat==='p1'?'#b9dfd0':'#d7c3e8'}/></g>;})}<Receipt at={center(g)} rows={seats.map(s=>`OWNER ${s.toUpperCase()} HAND +${r.members.filter(m=>m.c.owner===s).length}`)} p={p} start={.77} color="#c7d4eb"/></>;
}
function Bargain({cue,geometry:g,p}:Props) {
    const r=bargainProof(cue,g);if(!r)return null;const to=g.endingCards?.[`${cue.seat}:${key(r.top)}`]??r.draw.to;
    return <><Payment cue={cue} geometry={g} p={p}/><Mask at={g.source} p={p} start={.04}/><Receipt at={center(g)} rows={r.discard?[`${r.foe.toUpperCase()} CHOOSES OWN HAND DISCARD`,`${cue.seat.toUpperCase()} DRAWS 1 · SIMULTANEOUS`]:['OPPONENT HAND EMPTY',`${cue.seat.toUpperCase()} STILL DRAWS 1`]} p={p} start={.06} until={.49} color="#d6c4a6"/>{r.discard&&<><Mask at={r.discard.from} p={p} start={.29}/><Travel from={r.discard.from} to={r.discard.to} card={r.discard.outcome.card} p={p} start={.29} end={.65} hold={false}/></>}<Travel from={r.draw.from} to={to} card={r.top} p={p} start={.29} end={.65} initialSize={{w:24,h:34}}/><Receipt at={center(g)} rows={[`${cue.seat.toUpperCase()} HAND +1 · DECK ${r.after.deck}`,r.discard?`${r.foe.toUpperCase()} CHOSEN CARD DISCARDED`:'DRAW DOES NOT REQUIRE DISCARD']} p={p} start={.72} color="#d6c4a6"/></>;
}
function Way({cue,geometry:g,p}:Props) {
    const r=wayProof(cue,g);if(!r)return null;const at=center(g);
    return <><Payment cue={cue} geometry={g} p={p}/><Mask at={g.source} p={p} start={.04}/><ScreenPixels at={at} opacity={visible(p,.05)*(1-phase(p,.32,.38))} color="#cfdbbb"><rect x="-117" y="-33" width="234" height="66" rx="6" fill="#09121f"/><text y="-18" textAnchor="middle" fill="currentColor" stroke="none" style={{font:'700 9px sans-serif'}}>PRIVATE TOP {r.op.looked.length}</text>{r.op.looked.map((c,i)=><g key={key(c)} transform={`translate(${(i-(r.op.looked.length-1)/2)*27} 8)`}><CardGhost back box={{w:19,h:27}}/></g>)}</ScreenPixels>{r.cards.map((c,i)=>{const base=g.zones[`${cue.seat}:base`], ring=base?.stat, raw=shift(at,(i-(r.cards.length-1)/2)*64,0),from={...raw,y:ring?Math.min(raw.y,ring.y-ring.h/2-22/(raw.sy??1)):raw.y},to=g.endingCards?.[`${cue.seat}:${key(c)}`]??r.draw!.to;
        // Leave the reveal shelf above the measured HP ring, then use a clear side corridor.
        // A direct diagonal crossed the mobile base numeral in the independent natural review.
        const width=Math.max(34,sizeOf(to).w),right=Math.max(ring?ring.x+ring.w/2+(width/2+10)/(from.sx??1):0,1000-(width/2+10+i*(width+12))/(from.sx??1)),route=[{...from,x:right},{...to,x:right}];
        return <Travel key={key(c)} from={from} to={to} card={c} p={p} start={.4+i*.025} end={.73+i*.025} initialSize={{w:20,h:28}} route={route} growAt={.34}/>;})}<Receipt at={at} rows={[`REVEAL AND DRAW ${r.cards.length}`,`${r.op.looked.length-r.cards.length} UNCHOSEN → RANDOM BOTTOM`]} p={p} start={.79} color="#cfdbbb"/></>;
}
function Confiscate({cue,geometry:g,p}:Props) {
    const r=confiscateProof(cue,g);if(!r)return null;const at=g.cards?.[`${r.item.outcome.seat}:${key(r.host)}`]??r.item.box,chip=g.cards?.[`${r.item.outcome.seat}:${key(r.up)}`]??r.item.from;
    return <><Payment cue={cue} geometry={g} p={p}/><Mask at={g.source} p={p} start={.04}/><Receipt at={center(g)} rows={['SELECTED UPGRADE · ACADEMY',`OWNER ${r.up.owner!.toUpperCase()} DISCARD`]} p={p} start={.05} until={.39} color="#d7c2ad"/><AttachmentMask at={chip} p={p} start={.28}/><Travel from={chip} to={g.zones[`${r.up.owner}:discard`]} card={r.up} p={p} start={.3} end={.65} initialSize={{w:28,h:39.2}} hold={false}/><Stats at={at} unit={r.after} p={p} start={.46}/><Receipt at={center(g)} rows={['HOST −2 POWER / −2 MAX HP',`DAMAGE ${r.after.d} · ${(r.after.u??[]).some(u=>u.n==='Shield')?'SHIELD KEPT':'HOST SURVIVES'}`]} p={p} start={.72} color="#d7c2ad"/></>;
}
export function BatchA08SecondarySignature(props:Props) {
    switch(props.cue.definition.id){case 'surprise-strike':return <Surprise {...props}/>;case 'evacuate':return <Evacuate {...props}/>;case 'no-bargain':return <Bargain {...props}/>;case 'this-is-the-way':return <Way {...props}/>;case 'confiscate':return <Confiscate {...props}/>;default:return null;}
}
