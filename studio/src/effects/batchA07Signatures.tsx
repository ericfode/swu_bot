import type { CardRef, Seat, UnitRef } from '../data/types';
import type { CardEffectCue, CardEffectOutcome } from './types';
import { previewPlayCost } from './previewCosts';
import { easeInOut, easeOut, envelope, phase } from './animationTimeline';
import { AbilityGlyph, AttachmentMask, CardGhost, CountedMarks, ResourceBalance, ResourceSlot, ScreenPixels, UpgradePlay, mix, screenShift as shift, type EffectBox, type PlacedOutcome } from './primitives';

type Geometry = { source: EffectBox; target: EffectBox; friendlyBase: EffectBox; outcomes: PlacedOutcome[]; zones: Record<string, EffectBox>; cards?: Record<string, EffectBox>; endingCards?: Record<string, EffectBox>; pockets?: Record<string, EffectBox>; endingPockets?: Record<string, EffectBox>; endingCaptured?: Record<string, EffectBox>; resourceCards?: Record<string, EffectBox>; endingResources?: Record<string, EffectBox> };
type Props = { cue: CardEffectCue; geometry: Geometry; p: number };
const ids = new Set(['triple-dark-raid', 'spare-the-target', 'a-new-adventure', 'final-showdown', 'bounty-posting']);
export const isBatchA07 = (cue: CardEffectCue) => ids.has(cue.definition.id);
const key = (card?: CardRef | null) => card?.id ?? `${card?.s ?? ''}:${card?.n ?? ''}`;
const same = (a?: CardRef | null, b?: CardRef | null) => !!a && !!b && key(a) === key(b);
const number = (o: CardEffectOutcome) => typeof o.amount === 'number' ? o.amount : NaN;
const size = (at: EffectBox) => at.cardSize ?? { w: at.w * (at.sx ?? 1), h: at.h * (at.sy ?? 1) };
const visible = (p: number, start: number) => phase(p, start, start + .055);
const unitIn = (cue: CardEffectCue, card: CardRef | null | undefined, seat: Seat, after = false) => {
    const player = cue.transition?.[after ? 'after' : 'before'].players[seat];
    return [...(player?.ground ?? []), ...(player?.space ?? [])].find(unit => same(unit, card));
};
const bounded = (at: EffectBox, w = 120, h = 24): EffectBox => ({ ...at,
    x: Math.max((w / 2 + 8) / (at.sx ?? 1), Math.min(1000 - (w / 2 + 8) / (at.sx ?? 1), at.x)),
    y: Math.max((h / 2 + 40) / (at.sy ?? 1), Math.min(600 - (h / 2 + 122) / (at.sy ?? 1), at.y)) });
const center = (g: Geometry) => {
    const upper = g.zones['p2:ground'], base = g.zones['p1:base'];
    const lower = base?.stat ? Math.min(base.y - base.h / 2, base.stat.y - base.stat.h / 2) : base?.y - (base?.h ?? 0) / 2;
    return bounded({ ...g.source, x: 500, y: upper && base ? (upper.y + upper.h / 2 + lower) / 2 : 300 });
};
function Receipt({ at, rows, p, start = .7, until, color = '#dbe6ff' }: { at: EffectBox; rows: string[]; p: number; start?: number; until?: number; color?: string }) {
    const w = Math.min(242, Math.max(54, ...rows.map(row => row.length * 4.8 + 18))), h = rows.length * 16 + 6;
    return <ScreenPixels at={bounded(at, w, h)} color={color} opacity={visible(p, start) * (until ? 1 - phase(p, until - .07, until) : 1)}><rect x={-w / 2} y={-h / 2} width={w} height={h} rx="4" fill="#08111e" fillOpacity=".97" strokeWidth="1" />{rows.map((row, i) => <text key={i} y={-h / 2 + 14 + i * 16} textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '700 9px var(--font-display,sans-serif)' }}>{row}</text>)}</ScreenPixels>;
}
function Mask({ at, p, start, immediate = false }: { at: EffectBox; p: number; start: number; immediate?: boolean }) {
    const s = size(at);
    return <ScreenPixels at={at} opacity={immediate ? p >= start ? 1 : 0 : visible(p, start)}><rect x={-s.w / 2 - 5} y={-s.h / 2 - 5} width={s.w + 10} height={s.h + 10} rx="5" fill="#09121f" stroke="none" /></ScreenPixels>;
}
function Travel({ from, to, card, unit, p, start, end, back = false, initialSize, until, preservePose = false, continuing = false, color = '#cce5da' }: { from: EffectBox; to: EffectBox; card: CardRef; unit?: UnitRef; p: number; start: number; end: number; back?: boolean; initialSize?: { w: number; h: number }; until?: number; preservePose?: boolean; continuing?: boolean; color?: string }) {
    if (p < start) return null;
    const t = easeInOut(phase(p, start, end)), c = shift({ ...from, ...mix(from, to, .5) }, 20, -40);
    const at = { ...from, x: (1 - t) ** 2 * from.x + 2 * (1 - t) * t * c.x + t * t * to.x, y: (1 - t) ** 2 * from.y + 2 * (1 - t) * t * c.y + t * t * to.y };
    const a = initialSize ?? from.cardSize ?? { w: 42, h: 58.8 }, b = size(to), w = a.w + (b.w - a.w) * t, h = a.h + (b.h - a.h) * t, exhausted = unit?.x === 1;
    return <><path d={`M${from.x} ${from.y} Q${c.x} ${c.y} ${to.x} ${to.y}`} pathLength="1" strokeDasharray="1" strokeDashoffset={1 - t} stroke={color} strokeWidth="2" opacity={envelope(p, start, start + .05, end + .09)} /><ScreenPixels at={at} color={color} opacity={(continuing ? 1 : visible(p, start)) * (until ? 1 - phase(p, until - .035, until) : 1)}><g transform={`rotate(${preservePose ? exhausted ? 10 : 0 : exhausted ? 10 * t : -7 * Math.sin(t * Math.PI)}) scale(${exhausted ? preservePose ? .94 : 1 - .06 * t : 1})`} opacity={exhausted ? preservePose ? .72 : 1 - .28 * t : 1}><CardGhost card={card} back={back} box={{ w, h }} />{unit && [-1, 1].map(side => <g key={side} transform={`translate(${side * (w / 2 - 10)} ${h / 2 - 11})`}><rect x="-9" y="-10" width="18" height="20" rx="3" fill={side < 0 ? '#8b2936' : '#173f6f'} /><text textAnchor="middle" y="4" fill="#fff" stroke="none" style={{ font: '800 12px sans-serif' }}>{side < 0 ? unit.p : unit.h - unit.d}</text></g>)}</g></ScreenPixels></>;
}
function EventPayment({ cue, geometry: g, p }: Props) {
    const before = cue.transition?.before.players[cue.seat], ids = cue.playPayment?.kind === 'resources' ? cue.playPayment.cardIds : undefined;
    if (cue.stage || !before?.resources || !ids || ids.length !== cue.playCost) return null;
    return <><Mask at={g.source} p={p} start={.04} /><ResourceBalance at={g.zones[`${cue.seat}:resources`]} countAt={g.zones[`${cue.seat}:resource-count`]} ready={before.res.ready - cue.playCost!} total={before.res.total} p={p} start={.04} />{before.resources.map((resource, i) => {
        const at = g.resourceCards?.[`${cue.seat}:${key(resource)}`];
        return at && ids.includes(key(resource)) ? <ResourceSlot key={key(resource)} at={at} index={i} spent p={p} start={.04} /> : null;
    })}</>;
}

const seats: Seat[] = ['p1', 'p2'];
const fullUnit = (card?: CardRef | null): card is UnitRef => !!card && 'p' in card && typeof card.p==='number' && 'h' in card && typeof card.h==='number' && 'd' in card && typeof card.d==='number';
const refEqual = (a?: CardRef | null, b?: CardRef | null) => same(a,b) && a?.n === b?.n && a?.s === b?.s && a?.owner === b?.owner;
const restEqual = (a: UnitRef,b: UnitRef) => refEqual(a,b) && a.p===b.p && a.h===b.h && a.d===b.d && !!a.x===!!b.x && a.incarnation===b.incarnation;
const ordered = (a: CardRef[],b: CardRef[]) => a.length===b.length && a.every((card,i)=>refEqual(card,b[i]));
const allUnits = (cue:CardEffectCue,seat:Seat,after=false) => [...(cue.transition?.[after?'after':'before'].players[seat].ground??[]),...(cue.transition?.[after?'after':'before'].players[seat].space??[])];
const eventIds = (cue:CardEffectCue)=>cue.playPayment?.kind==='resources'?cue.playPayment.cardIds:undefined;
function eventProof(cue:CardEffectCue) {
    const before=cue.transition?.before.players[cue.seat],after=cue.transition?.after.players[cue.seat],ids=eventIds(cue);
    let cost:number;try{if(!cue.transition||cue.playPayment?.kind!=='resources'||cue.playPayment.smuggle)return false;cost=previewPlayCost(cue.definition,cue.transition.before,cue.seat,cue.playPayment);}catch{return false;}
    return !cue.stage && !!before && !!after && !!cue.source?.id && cue.source.s===cue.definition.setCode && cue.source.n===cue.definition.name && cue.source.owner===cue.seat && cue.playCost===cost && Number.isSafeInteger(cue.playCost) && cue.playCost!>=0 && !!ids && ids.length===cue.playCost && new Set(ids).size===ids.length
        && before.hand.filter(c=>refEqual(c,cue.source)).length===1 && !after.hand.some(c=>same(c,cue.source)) && after.discard.filter(c=>refEqual(c,cue.source)).length===1
        && ids.every(id=>before.resources?.some(c=>c.id===id&&!c.x)&&after.resources?.some(c=>c.id===id&&c.x===1)) && after.res.total===before.res.total && after.res.ready===before.res.ready-cue.playCost!
        && before.resources?.length===before.res.total && after.resources?.length===after.res.total && before.resources.filter(c=>!c.x).length===before.res.ready && after.resources.filter(c=>!c.x).length===after.res.ready
        && before.resources.every(c=>after.resources?.some(r=>refEqual(c,r)&&!!r.x===(ids.includes(key(c))||!!c.x)));
}
function deckProof(cue:CardEffectCue,item:PlacedOutcome|undefined,whole:boolean) {
    const o=item?.outcome,op=o?.deckOperation,before=cue.transition?.before.players[cue.seat],after=cue.transition?.after.players[cue.seat],manifest=before?.knownDeck;
    if(!o||o.kind!=='search'||!op||!manifest||!after?.knownDeck||manifest.length!==before.deck||new Set(manifest.map(key)).size!==manifest.length
        ||o.seat!==cue.seat||op.visibility!=='private'||op.scope!==(whole?'whole':'top')||op.policy!==(whole?'whole-search-shuffle':'top-search-bottom')||op.selectionLimit!==1||o.selection&&o.selection!=='chosen'
        ||!ordered(op.looked,manifest.slice(0,whole?manifest.length:Math.min(7,manifest.length)))||number(o)!==op.looked.length||op.selectedIds.length>1||new Set(op.selectedIds).size!==op.selectedIds.length||op.selectedIds.some(id=>!op.looked.some(c=>c.id===id))
        ||op.remainingOrder.length!==manifest.length||new Set(op.remainingOrder.map(key)).size!==manifest.length||op.remainingOrder.some(c=>!manifest.some(m=>refEqual(m,c))))return;
    const remaining=op.remainingOrder.filter(c=>!op.selectedIds.includes(key(c)));
    if(after.deck!==before.deck-op.selectedIds.length||!ordered(after.knownDeck,remaining))return;
    if(whole ? !op.revealedIds||op.revealedIds.length!==op.selectedIds.length||op.revealedIds.some(id=>!op.selectedIds.includes(id)) : !!op.revealedIds?.length)return;
    if(!whole){const untouched=manifest.slice(op.looked.length);if(!ordered(remaining.slice(0,untouched.length),untouched))return;}
    return {item:item!,op,before,after,chosen:op.looked.find(c=>c.id===op.selectedIds[0]),remaining};
}
function nestedPay(cue:CardEffectCue,g:Geometry,card:CardRef,seat:Seat,amount:number) {
    const pay=g.outcomes.find(i=>i.outcome.kind==='pay'&&i.outcome.seat===seat&&same(i.outcome.sourceCard,card)),before=cue.transition?.before.players[seat],after=cue.transition?.after.players[seat];
    const cards=pay?.outcome.cards;
    if(!pay||number(pay.outcome)!==amount||!cards||cards.length!==amount||new Set(cards.map(key)).size!==amount||!before||!after||after.res.ready!==before.res.ready-amount-(seat===cue.seat?cue.playCost??0:0)||cards.some(c=>!before.resources?.some(r=>refEqual(r,c)&&!r.x)||!after.resources?.some(r=>same(r,c)&&r.x===1)||seat===cue.seat&&eventIds(cue)?.includes(key(c))))return;
    return pay;
}
function returnProof(cue:CardEffectCue,item:PlacedOutcome|undefined,allowReplay=false) {
    const o=item?.outcome,old=o&&unitIn(cue,o.card,o.fromSeat??o.seat);
    if(!o||o.kind!=='return'||!old?.id||!old.incarnation||!old.owner||!fullUnit(o.card)||!restEqual(o.card,old)||o.prevented||o.destination!=='hand'||o.zone!=='hand'||o.ownerSeat!==old.owner||o.seat!==old.owner||o.incarnation!==old.incarnation||!refEqual(o.card,old)||old.cap?.length||old.u?.some(up=>up.t)
        ||seats.some(seat=>cue.transition?.before.players[seat].leader?.id===old.id)||(!allowReplay&&seats.some(seat=>unitIn(cue,old,seat,true)))||!allowReplay&&!cue.transition?.after.players[old.owner].hand.some(c=>refEqual(c,old)))return;
    if((old.u??[]).some(up=>!up.owner||!cue.transition?.after.players[up.owner].discard.some(c=>refEqual(c,up))))return;
    return {item:item!,old,owner:old.owner,upgrades:old.u??[]};
}
function raidProof(cue:CardEffectCue,g:Geometry) {
    if(!eventProof(cue))return;
    const search=deckProof(cue,g.outcomes.find(i=>i.outcome.kind==='search'),false);if(!search)return;
    if(!search.chosen)return g.outcomes.length===1?{search,entry:undefined}:undefined;
    const card=search.chosen,play=g.outcomes.find(i=>i.outcome.kind==='play'&&same(i.outcome.card,card)),unit=play?.outcome.unit,cost=g.outcomes.find(i=>i.outcome.kind==='cost'&&same(i.outcome.card,card)),pay=nestedPay(cue,g,card,cue.seat,0),delay=g.outcomes.find(i=>i.outcome.kind==='delay'&&same(i.outcome.card,card)),pending=delay?.outcome.pending,after=unitIn(cue,card,cue.seat,true);
    if(card.s!=='SOR_237'||card.owner!==cue.seat||!play||!unit||!refEqual(unit,card)||!unit.incarnation||!cost||number(cost.outcome)!==-5||!pay||!delay||!pending||!after||play.outcome.fromZone!=='deck'||play.outcome.fromSeat!==cue.seat||play.outcome.seat!==cue.seat||play.outcome.ownerSeat!==card.owner||play.outcome.entersReady!==true||play.outcome.entryType!=='played'||play.outcome.printedCost!==2||unit.x||unit.d!==0||unit.p!==2||unit.h!==3||!restEqual(unit,after)
        ||pending.sourceId!==cue.source?.id||pending.targetId!==card.id||pending.incarnation!==unit.incarnation||pending.trigger!=='phase-end'||pending.kind!=='return-to-hand'||delay.outcome.duration!=='phase'||delay.outcome.pendingOperation==='consume'||!cue.transition?.after.pending?.some(p=>JSON.stringify(p)===JSON.stringify(pending))||!after.status?.some(s=>s.kind==='delay'&&s.duration==='phase')
        ||g.outcomes.indexOf(cost)<=g.outcomes.indexOf(search.item)||g.outcomes.indexOf(pay)<=g.outcomes.indexOf(cost)||g.outcomes.indexOf(play)<=g.outcomes.indexOf(pay)||g.outcomes.indexOf(delay)<=g.outcomes.indexOf(play))return;
    return {search,entry:{play,unit,cost,pay,delay,pending,after}};
}
function raidBoundaryProof(cue:CardEffectCue,g:Geometry) {
    if(cue.stage!=='phase-end'||!cue.transition||cue.playCost!=null)return;
    const consume=g.outcomes.find(i=>i.outcome.kind==='delay'&&i.outcome.pendingOperation==='consume'),p=consume?.outcome.pending,prior=cue.transition.before.pending?.find(q=>q.id===p?.id);
    if(!consume||!p||!prior||JSON.stringify(p)!==JSON.stringify(prior)||p.trigger!=='phase-end'||p.kind!=='return-to-hand'||consume.outcome.seat!==cue.seat||cue.transition.before.phase!=='action'||cue.transition.after.phase!==cue.transition.before.phase||cue.transition.after.round!==cue.transition.before.round||!cue.transition.before.players[cue.seat].discard.some(c=>c.id===p.sourceId&&c.s===cue.definition.setCode&&c.n===cue.definition.name)||cue.transition.after.pending?.some(q=>q.id===p.id))return;
    const current=seats.flatMap(seat=>allUnits(cue,seat).filter(u=>u.id===p.targetId&&u.incarnation===p.incarnation)),ret=g.outcomes.find(i=>i.outcome.kind==='return'&&i.outcome.card?.id===p.targetId);
    if(!current.length)return !ret&&g.outcomes.length===1?{consume,p,returned:undefined}:undefined;
    const returned=returnProof(cue,ret);if(current.length!==1||!returned||returned.old.incarnation!==p.incarnation||g.outcomes.indexOf(returned.item)<=g.outcomes.indexOf(consume))return;
    return {consume,p,returned};
}
function bountyProof(cue:CardEffectCue,g:Geometry) {
    if(!eventProof(cue))return;
    const draw=g.outcomes.find(i=>i.outcome.kind==='draw'&&i.outcome.bountyResolution),r=draw?.outcome.bountyResolution,before=cue.transition?.before.players[cue.seat],after=cue.transition?.after.players[cue.seat];
    if(!draw||!r||!before?.knownDeck||!after||r.kind!=='draw'||r.amount!==2||r.collector!==cue.seat||draw.outcome.seat!==r.collector||number(draw.outcome)!==2||r.index!==1||draw.outcome.requiresReturn)return;
    const old=seats.flatMap(seat=>allUnits(cue,seat)).find(u=>u.id===r.hostId&&u.incarnation===r.incarnation),grant=old?.u?.find(up=>up.id===r.abilitySourceId&&up.s==='SHD_176'&&up.n==='Death Mark'&&!up.t),cards=draw.outcome.cards;
    if(!old||allUnits(cue,cue.seat).some(u=>same(u,old))||seats.some(seat=>cue.transition?.before.players[seat].leader?.id===old.id)||!grant||!cards||cards.length!==2||!ordered(cards,before.knownDeck.slice(0,2))||cards.some(c=>!after.hand.some(h=>refEqual(c,h)))||after.deck!==before.deck-2||!after.knownDeck||!ordered(after.knownDeck,before.knownDeck.slice(2)))return;
    return {draw,r,old,grant,cards,returned:returnProof(cue,g.outcomes.find(i=>i.outcome.kind==='return'&&same(i.outcome.card,old)))};
}
function adventureProof(cue:CardEffectCue,g:Geometry) {
    if(!eventProof(cue))return;
    const ret=g.outcomes.find(i=>i.outcome.kind==='return'),choice=ret?.outcome.choice;
    if(choice?.kind!=='owner-replay')return;
    const returned=returnProof(cue,ret,choice.decision==='play-free');if(!returned||choice.owner!==returned.owner||choice.subjectId!==returned.old.id||choice.returnedIncarnation!==returned.old.incarnation||returned.old.s!=='SOR_164')return;
    if(choice.decision==='decline')return !g.outcomes.some(i=>i.outcome.kind==='play'||i.outcome.kind==='pay')?{returned,choice,replay:undefined}:undefined;
    const play=g.outcomes.find(i=>i.outcome.kind==='play'&&same(i.outcome.card,returned.old)),pay=nestedPay(cue,g,returned.old,returned.owner,0),unit=play?.outcome.unit,after=unitIn(cue,returned.old,returned.owner,true),req=play?.outcome.requiresReturn;
    if(!play||!pay||!unit||!after||!req||req.id!==returned.old.id||req.incarnation!==returned.old.incarnation||req.ownerSeat!==returned.owner||JSON.stringify(req)!==JSON.stringify(pay.outcome.requiresReturn)||play.outcome.choice?.kind!=='owner-replay'||JSON.stringify(play.outcome.choice)!==JSON.stringify(choice)||play.outcome.fromSeat!==returned.owner||play.outcome.seat!==returned.owner||play.outcome.ownerSeat!==returned.owner||play.outcome.fromZone!=='hand'||play.outcome.entryType!=='played'||play.outcome.entersReady!==false||play.outcome.printedCost!==4||unit.x!==1||unit.d!==0||unit.p!==4||unit.h!==5||unit.owner!==returned.owner||!unit.incarnation||unit.incarnation===returned.old.incarnation||unit.u?.length||unit.status?.length||unit.cap?.length||!restEqual(unit,after)||after.u?.length||after.status?.length||after.cap?.length||cue.transition?.after.players[returned.owner].hand.some(c=>same(c,unit))||g.outcomes.indexOf(pay)<=g.outcomes.indexOf(returned.item)||g.outcomes.indexOf(play)<=g.outcomes.indexOf(pay))return;
    return {returned,choice,replay:{play,pay,unit,after}};
}
function finalProof(cue:CardEffectCue,g:Geometry) {
    const item=g.outcomes.find(i=>i.outcome.kind==='delay'&&i.outcome.playerPending),pending=item?.outcome.playerPending,before=cue.transition?.before,after=cue.transition?.after;
    if(!item||!pending||!before||!after||pending.kind!=='lose-game'||pending.trigger!=='regroup-start'||pending.player!==item.outcome.seat||g.outcomes.some(i=>!['delay','ready'].includes(i.outcome.kind))||seats.some(s=>before.players[s].base.d!==after.players[s].base.d||before.players[s].base.hp!==after.players[s].base.hp))return;
    if(cue.stage==='regroup-start'){
        const result=item.outcome.matchResult,prior=before.pendingPlayers?.find(p=>p.id===pending.id);
        if(before.phase!=='regroup'||after.phase!=='regroup'||before.round!==after.round||before.matchResult||!prior||JSON.stringify(prior)!==JSON.stringify(pending)||!result||result.reason!=='card-effect'||result.sourceId!==pending.sourceId||result.loser!==pending.player||result.winner===(pending.player)||result.winner==='draw'||JSON.stringify(after.matchResult)!==JSON.stringify(result)||JSON.stringify(after.pendingPlayers??[])!==JSON.stringify((before.pendingPlayers??[]).filter(p=>p.id!==pending.id))||cue.playCost!=null||g.outcomes.length!==1||JSON.stringify(before.players)!==JSON.stringify(after.players)||!before.players[pending.player].discard.some(c=>c.id===pending.sourceId&&c.s===cue.definition.setCode&&c.n===cue.definition.name))return;
        return {item,pending,result,ready:[] as PlacedOutcome[]};
    }
    if(!eventProof(cue)||pending.sourceId!==cue.source?.id||pending.player!==cue.seat||before.matchResult||after.matchResult||!after.pendingPlayers?.some(p=>JSON.stringify(p)===JSON.stringify(pending)))return;
    const ready=g.outcomes.filter(i=>i.outcome.kind==='ready'),own=allUnits(cue,cue.seat),foe:Seat=cue.seat==='p1'?'p2':'p1';
    if(ready.length!==own.length||own.length!==allUnits(cue,cue.seat,true).length||allUnits(cue,foe).length!==allUnits(cue,foe,true).length||new Set(ready.map(i=>key(i.outcome.card))).size!==own.length||own.some(u=>!ready.some(i=>i.outcome.seat===cue.seat&&refEqual(i.outcome.card,u)&&i.outcome.incarnation===u.incarnation&&number(i.outcome)===1)||!allUnits(cue,cue.seat,true).some(v=>!v.x&&restEqual({...u,x:undefined},v)))||allUnits(cue,foe).some(u=>!allUnits(cue,foe,true).some(v=>restEqual(u,v))))return;
    return {item,pending,result:undefined,ready};
}
function postingProof(cue:CardEffectCue,g:Geometry) {
    if(!eventProof(cue))return;
    const search=deckProof(cue,g.outcomes.find(i=>i.outcome.kind==='search'),true);if(!search)return;
    if(!search.chosen)return g.outcomes.length===1?{search,draw:undefined,play:undefined}:undefined;
    const card=search.chosen,draw=g.outcomes.find(i=>i.outcome.kind==='draw'&&same(i.outcome.card,card)),play=g.outcomes.find(i=>i.outcome.kind==='play'&&same(i.outcome.card,card));
    if(card.s!=='SHD_068'||card.n!=='Public Enemy'||card.owner!==cue.seat||!draw||number(draw.outcome)!==1||draw.outcome.seat!==cue.seat||!draw.outcome.cards||!ordered(draw.outcome.cards,[card])||g.outcomes.indexOf(draw)<=g.outcomes.indexOf(search.item))return;
    if(!play)return cue.transition?.after.players[cue.seat].hand.some(c=>refEqual(c,card))?{search,draw,play:undefined}:undefined;
    const o=play.outcome,pay=nestedPay(cue,g,card,cue.seat,0),host=unitIn(cue,o.targetCard,o.seat),after=unitIn(cue,o.targetCard,o.seat,true),up=o.upgrade,attached=after?.u?.find(u=>same(u,card));
    if(!pay||o.playAs!=='upgrade'||o.entryType!=='played'||o.fromZone!=='hand'||o.fromSeat!==cue.seat||o.ownerSeat!==cue.seat||o.controllerSeat!==cue.seat||o.unit||o.entersReady!=null||!host||!after||!restEqual(host,after)||!up||!attached||!refEqual(up,card)||up.t||up.p!==0||up.h!==0||up.owner!==cue.seat||up.controller!==cue.seat||!refEqual(attached,up)||attached.p!==0||attached.h!==0||attached.controller!==cue.seat||after.u?.filter(u=>same(u,card)).length!==1||(after.u?.length??0)!==(host.u?.length??0)+1||cue.transition?.after.players[cue.seat].hand.some(c=>same(c,card))||g.outcomes.some(i=>i.outcome.kind==='shield'||i.outcome.bountyResolution)||g.outcomes.indexOf(pay)<=g.outcomes.indexOf(draw)||g.outcomes.indexOf(play)<=g.outcomes.indexOf(pay))return;
    return {search,draw,play:{item:play,pay,host,after,up}};
}
export function batchA07Covers(cue:CardEffectCue,g:Geometry,item:PlacedOutcome):boolean {
    switch(cue.definition.id){
        case 'triple-dark-raid':{const b=raidBoundaryProof(cue,g);if(b)return item===b.consume||item===b.returned?.item;const p=raidProof(cue,g);return !!p&&(item===p.search.item||!!p.entry&&[p.entry.cost,p.entry.pay,p.entry.play,p.entry.delay].includes(item));}
        case 'spare-the-target':{const p=bountyProof(cue,g);return !!p&&(item===p.draw||item===p.returned?.item);}
        case 'a-new-adventure':{const p=adventureProof(cue,g);return !!p&&(item===p.returned.item||!!p.replay&&[p.replay.pay,p.replay.play].includes(item));}
        case 'final-showdown':{const p=finalProof(cue,g);return !!p&&(item===p.item||p.ready.includes(item));}
        case 'bounty-posting':{const p=postingProof(cue,g);return !!p&&(item===p.search.item||item===p.draw||!!p.play&&[p.play.item,p.play.pay].includes(item));}
        default:return false;
    }
}
function Shelf({at,count,whole,p}:{at:EffectBox;count:number;whole:boolean;p:number}) {
    const n=whole?count:Math.min(7,count),gap=whole?4.3:20;
    return <ScreenPixels at={at} opacity={envelope(p,.07,.14,.34)} color="#d7c8ad">{Array.from({length:n},(_,i)=><g key={i} transform={`translate(${(i-(n-1)/2)*gap} ${whole?Math.abs(i-(n-1)/2)*.35:0})`}><CardGhost back box={{w:whole?18:16,h:whole?25:22}}/><path d="M-7 -9 H7" strokeWidth={i===Math.floor(phase(p,.1,.3)*n)?2:0} stroke="#f0d5a6"/></g>)}<text y="-23" textAnchor="middle" fill="currentColor" stroke="none" style={{font:'700 8px sans-serif'}}>{whole?`PRIVATE WHOLE DECK · ${count}`:`PRIVATE TOP ${count} · VEHICLE`}</text></ScreenPixels>;
}
function Cleanup({cue,geometry:g,old,p}:{cue:CardEffectCue;geometry:Geometry;old:UnitRef;p:number}) {
    const seat=seats.find(s=>unitIn(cue,old,s)),chips=old.u??[];if(!seat)return null;
    return <>{chips.map(up=>{const from=g.cards?.[`${seat}:${key(up)}`],to=g.zones[`${up.owner}:discard`];if(!from||!to)return null;const t=easeInOut(phase(p,.22,.5)),at={...from,...mix(from,to,t)},w=Math.max(36,Math.min(100,from.w*(from.sx??1))),h=Math.max(12,from.h*(from.sy??1));return <g key={key(up)}><AttachmentMask at={from} p={p} start={.14}/><path d={`M${from.x} ${from.y} L${to.x} ${to.y}`} stroke="#d6b69d" opacity={envelope(p,.22,.26,.54)}/><ScreenPixels at={at} color="#dbc1aa" opacity={envelope(p,.22,.26,.53)}><rect x={-w/2} y={-h/2} width={w} height={h} rx="3" fill="#261c19"/><text textAnchor="middle" y="2" fill="currentColor" stroke="none" style={{font:'700 7px sans-serif'}}>{up.n}</text></ScreenPixels></g>;})}</>;
}
function DeckCount({at,count,p,start}:{at:EffectBox;count:number;p:number;start:number}) {
    return <ScreenPixels at={at} opacity={visible(p,start)} color="#dbe3ed"><rect x="-18" y="-8" width="36" height="16" rx="3" fill="#101c2a" stroke="none"/><text textAnchor="middle" y="3" fill="currentColor" stroke="none" style={{font:'700 8px sans-serif'}}>DECK {count}</text></ScreenPixels>;
}
function DrawnCards({g,cards,seat,p,start,end}:{g:Geometry;cards:CardRef[];seat:Seat;p:number;start:number;end:number}) {
    return <>{cards.map((card,i)=>{const to=g.endingCards?.[`${seat}:${key(card)}`];return to?<Travel key={key(card)} from={shift(g.zones[`${seat}:deck`],i*2,0)} to={to} card={card} p={p} start={start+i*.025} end={end+i*.025} initialSize={{w:22,h:31}}/>:null;})}</>;
}
function Raid({cue,geometry:g,p}:Props) {
    const boundary=raidBoundaryProof(cue,g);
    if(boundary)return <>{boundary.returned&&<><Mask at={boundary.returned.item.from} p={p} start={.23} immediate/><Cleanup cue={cue} geometry={g} old={boundary.returned.old} p={p}/><Travel from={boundary.returned.item.from} to={boundary.returned.item.to} card={boundary.returned.old} p={p} start={.23} end={.67} continuing initialSize={size(boundary.returned.item.from)}/></>}<Receipt at={center(g)} rows={['ACTUAL PHASE END',boundary.returned?`OWNER ${boundary.returned.owner.toUpperCase()} HAND · SAME ENTRY`:'OLD ENTRY ABSENT · NO RETURN']} p={p} start={.05} until={.5}/><Receipt at={center(g)} rows={['RETURN OBLIGATION CONSUMED',boundary.returned?'INTACT OWNER-HAND ARRIVAL':'DEPARTED ENTRY NOT REPLACED']} p={p} start={.72}/></>;
    const proof=raidProof(cue,g);if(!proof)return null;
    const {search,entry}=proof,backCount=search.op.looked.length-(entry?1:0);
    return <><EventPayment cue={cue} geometry={g} p={p}/><Shelf at={center(g)} count={search.op.looked.length} whole={false} p={p}/>
        {Array.from({length:backCount},(_,i)=><Travel key={i} from={shift(center(g),(i-(backCount-1)/2)*8,0)} to={g.zones[`${cue.seat}:deck`]} card={search.op.looked[i]} back p={p} start={.28+i*.008} end={.47+i*.008} until={.55} initialSize={{w:16,h:22}}/>)}
        {entry&&<Travel from={entry.play.from} to={entry.play.to} card={entry.unit} unit={entry.unit} p={p} start={.39} end={.67} initialSize={{w:28,h:39}}/>}
        <Receipt at={center(g)} rows={entry?['COST 2 − 5 = 0 · PAID 0','DIRECT DECK PLAY · ENTERS READY']:['NO VEHICLE SELECTED',`${backCount} SEARCHED → RANDOM BOTTOM`]} p={p} start={.35} until={.63} color="#dfd2b2"/>
        <DeckCount at={g.zones[`${cue.seat}:deck`]} count={search.after.deck} p={p} start={.65}/>
        <Receipt at={center(g)} rows={entry?['READY ENTRY · PHASE-END RETURN',`${backCount} UNCHOSEN → RANDOM BOTTOM`]:['PRIVATE SEARCH RESOLVED','DECK COUNT UNCHANGED']} p={p} start={.72} color="#ddd1b2"/>
    </>;
}
function Spare({cue,geometry:g,p}:Props) {
    const proof=bountyProof(cue,g);if(!proof)return null;const {returned,grant}=proof;
    return <><EventPayment cue={cue} geometry={g} p={p}/><Receipt at={center(g)} rows={['BOUNTY WITNESS · DEATH MARK',`COLLECTOR ${proof.r.collector.toUpperCase()} · DRAW 2`]} p={p} start={.05} until={.35} color="#ddc9a1"/>
        {returned&&<><Cleanup cue={cue} geometry={g} old={returned.old} p={p}/><Mask at={returned.item.from} p={p} start={.24} immediate/><Travel from={returned.item.from} to={returned.item.to} card={returned.old} p={p} start={.24} end={.68} continuing initialSize={size(returned.item.from)}/></>}
        <ScreenPixels at={center(g)} opacity={envelope(p,.34,.4,.56)} color="#dcc99e"><circle r="15" fill="#242014" strokeWidth="2"/><AbilityGlyph kind="draw" size={18}/><CountedMarks count={2} gap={11} radius={3} color="#e7d8b5"/></ScreenPixels>
        <DrawnCards g={g} cards={proof.cards} seat={proof.r.collector} p={p} start={.29} end={.72}/><DeckCount at={g.zones[`${proof.r.collector}:deck`]} count={cue.transition!.after.players[proof.r.collector].deck} p={p} start={.75}/>
        <Receipt at={center(g)} rows={returned?[`INTACT RETURN → OWNER ${returned.owner.toUpperCase()}`,`BOUNTY COLLECTED · ${grant.n} DRAW 2`]:['BOUNTY COLLECTED · DRAW 2','SEPARATELY WITNESSED RESOLUTION']} p={p} start={.76} color="#decda6"/>
    </>;
}
function Adventure({cue,geometry:g,p}:Props) {
    const proof=adventureProof(cue,g);if(!proof)return null;const {returned,replay}=proof;
    return <><EventPayment cue={cue} geometry={g} p={p}/><Cleanup cue={cue} geometry={g} old={returned.old} p={p}/><Mask at={returned.item.from} p={p} start={.2} immediate/>{(!replay||p<.58)&&<Travel from={returned.item.from} to={returned.item.to} card={returned.old} p={p} start={.2} end={.42} continuing initialSize={size(returned.item.from)}/>}
        <Receipt at={center(g)} rows={['RETURN INTACT · CLEAN UP UPGRADE',`OWNER ${returned.owner.toUpperCase()} DECIDES REPLAY`]} p={p} start={.05} until={.4} color="#cdd9e2"/>
        <Receipt at={center(g)} rows={replay?[`OWNER ${returned.owner.toUpperCase()} CHOOSES FREE PLAY`,'EXPLICIT NORMAL PAYMENT 0']:['OWNER DECLINES REPLAY','STAYS IN OWNER HAND']} p={p} start={.44} until={replay?.play?.outcome ? .71:undefined} color="#cbdbe5"/>
        {replay&&<Travel from={replay.play.from} to={replay.play.to} card={replay.unit} unit={replay.unit} p={p} start={.58} end={.83} continuing/>}
        {replay&&<Receipt at={center(g)} rows={[`OWNER ${returned.owner.toUpperCase()} · FRESH EXHAUSTED ENTRY`,'4/5 · DAMAGE 0 · OLD UPGRADE GONE']} p={p} start={.85} color="#cbdbe5"/>}
    </>;
}
function ReadyFace({at,unit,p}:{at:EffectBox;unit:UnitRef;p:number}) {
    if(p<.24)return null;const t=easeOut(phase(p,.24,.52)),exhaustion=unit.x?1-t:0,s=size(at);
    return <><Mask at={at} p={p} start={.24} immediate/><ScreenPixels at={at}><g transform={`rotate(${10*exhaustion}) scale(${1-.06*exhaustion})`} opacity={1-.28*exhaustion}><CardGhost card={unit} box={s}/>{[-1,1].map(side=><g key={side} transform={`translate(${side*(s.w/2-10)} ${s.h/2-11})`}><rect x="-10" y="-11" width="20" height="22" rx="3" fill={side<0?'#8b2936':'#173f6f'}/><text textAnchor="middle" y="4" fill="#fff" stroke="none" style={{font:'800 13px sans-serif'}}>{side<0?unit.p:unit.h-unit.d}</text></g>)}</g></ScreenPixels></>;
}
function PlayerPlate({at,rows,p,start,color}:{at:EffectBox;rows:string[];p:number;start:number;color:string}) {
    const w=Math.min(330,at.w*(at.sx??1)-16),h=40;return <ScreenPixels at={at} opacity={visible(p,start)} color={color}><rect x={-w/2} y={-h/2} width={w} height={h} rx="6" fill="#09111d" strokeWidth="1.5"/>{rows.map((row,i)=><text key={i} y={-5+i*16} textAnchor="middle" fill="currentColor" stroke="none" style={{font:'800 10px sans-serif'}}>{row}</text>)}</ScreenPixels>;
}
function Final({cue,geometry:g,p}:Props) {
    const proof=finalProof(cue,g);if(!proof)return null;const at=g.zones['player-effect']??center(g);
    if(proof.result)return <PlayerPlate at={at} rows={[`${String(proof.result.winner).toUpperCase()} WINS · ${proof.pending.player.toUpperCase()} LOSES`,'ACTUAL REGROUP · FINAL SHOWDOWN']} p={p} start={.24} color="#e7b0c1"/>;
    return <><EventPayment cue={cue} geometry={g} p={p}/>{proof.ready.map(item=>{const unit=unitIn(cue,item.outcome.card,cue.seat)!;return <g key={item.key}><ScreenPixels at={shift(item.from,0,-size(item.from).h/2-9)} opacity={envelope(p,.13,.2,.55)} color="#ddd0a6"><path d="M-10 6 V-6 H10 V6 M-5 -2 L0 -7 L5 -2" strokeWidth="2"/></ScreenPixels><ReadyFace at={item.from} unit={unit} p={p}/></g>;})}<PlayerPlate at={at} rows={[`${proof.pending.player.toUpperCase()} LOSES AT REGROUP`,'ONGOING ACTION PHASE · READY NOW']} p={p} start={.57} color="#d7b7c4"/></>;
}
function Posting({cue,geometry:g,p}:Props) {
    const proof=postingProof(cue,g);if(!proof)return null;const {search,draw,play}=proof;
    return <><EventPayment cue={cue} geometry={g} p={p}/><Shelf at={center(g)} count={search.op.looked.length} whole p={p}/>
        {draw&&(!play||p<.64)&&<Travel from={draw.from} to={draw.to} card={search.chosen!} p={p} start={.34} end={.57} initialSize={{w:24,h:34}}/>}
        <Receipt at={center(g)} rows={draw?['SELECTED PUBLIC ENEMY · REVEALED','DRAW 1 · REMAINDER SHUFFLED']:['NO BOUNTY UPGRADE SELECTED','WHOLE DECK SHUFFLED']} p={p} start={.35} until={play?.item ? .58:undefined} color="#ddcea8"/>
        {play&&<><Receipt at={center(g)} rows={['NORMAL UPGRADE PAYMENT 0','HAND → ACTUAL WAMPA ATTACHMENT']} p={p} start={.59} until={.84} color="#ddcda7"/><UpgradePlay from={play.item.from} to={play.item.to} card={play.up} p={p} start={.64} end={.84}/><Receipt at={center(g)} rows={['PUBLIC ENEMY ATTACHED · BOUNTY GRANTED','NO SHIELD OR COLLECTION NOW']} p={p} start={.85} color="#d7c79e"/></>}
        <DeckCount at={g.zones[`${cue.seat}:deck`]} count={search.after.deck} p={p} start={.62}/>
    </>;
}
export function BatchA07Signature(props:Props) {
    switch(props.cue.definition.id){
        case 'triple-dark-raid':return <Raid {...props}/>;
        case 'spare-the-target':return <Spare {...props}/>;
        case 'a-new-adventure':return <Adventure {...props}/>;
        case 'final-showdown':return <Final {...props}/>;
        case 'bounty-posting':return <Posting {...props}/>;
        default:return null;
    }
}
