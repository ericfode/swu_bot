import type { CardRef, Seat, UnitRef } from '../data/types';
import type { CardEffectCue, CardEffectOutcome } from './types';
import { easeInOut, envelope, phase } from './animationTimeline';
import { CardGhost, ScreenPixels, CountedMarks, ResourceBalance, ResourceSlot, mix, screenShift as shift, type EffectBox, type PlacedOutcome } from './primitives';

type Geometry = { source: EffectBox; target: EffectBox; friendlyBase: EffectBox; outcomes: PlacedOutcome[]; zones: Record<string, EffectBox>; cards?: Record<string, EffectBox>; endingCards?: Record<string, EffectBox>; pockets?: Record<string, EffectBox>; resourceCards?: Record<string, EffectBox> };
type Props = { cue: CardEffectCue; geometry: Geometry; p: number };
const ids = new Set(['bravado', 'let-the-wookiee-win', 'look-the-other-way', 'ma-klounkee', 'swoop-down']);
export const isBatchA07Secondary = (cue: CardEffectCue) => ids.has(cue.definition.id);
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
const atCard = (g: Geometry, card: CardRef, seat: Seat, zone = 'ground') => g.cards?.[`${seat}:${key(card)}`] ?? g.zones[`${seat}:${zone}`] ?? g.target;
function Receipt({ at, rows, p, start = .7, until, color = '#dbe6ff' }: { at: EffectBox; rows: string[]; p: number; start?: number; until?: number; color?: string }) {
    const w = Math.min(242, Math.max(70, ...rows.map(row => row.length * 4.8 + 18))), h = rows.length * 18 + 6;
    return <ScreenPixels at={bounded(at, w, h)} color={color} opacity={visible(p, start) * (until ? 1 - phase(p, until - .06, until) : 1)}><rect x={-w / 2} y={-h / 2} width={w} height={h} rx="4" fill="#08111e" fillOpacity=".97" strokeWidth="1" />{rows.map((row, i) => <text key={i} y={-h / 2 + 15 + i * 18} textAnchor="middle" fill="currentColor" stroke="none" style={{ font: '700 9px var(--font-display,sans-serif)' }}>{row}</text>)}</ScreenPixels>;
}
function Mask({ at, p, start }: { at: EffectBox; p: number; start: number }) {
    const s = sizeOf(at);
    return <ScreenPixels at={at} opacity={visible(p, start)}><rect x={-s.w / 2 - 5} y={-s.h / 2 - 5} width={s.w + 10} height={s.h + 10} rx="5" fill="#09121f" stroke="none" /></ScreenPixels>;
}
function Travel({ from, to, card, p, start, end, back = false, hold = true, exhausted = false, initialSize, color = '#d6e4ff' }: { from: EffectBox; to: EffectBox; card?: CardRef | null; p: number; start: number; end: number; back?: boolean; hold?: boolean; exhausted?: boolean; initialSize?: { w: number; h: number }; color?: string }) {
    if (p < start) return null;
    const t = easeInOut(phase(p, start, end)), mid = shift({ ...from, ...mix(from, to, .5) }, 20, -36);
    const at = { ...from, x: (1 - t) ** 2 * from.x + 2 * (1 - t) * t * mid.x + t * t * to.x, y: (1 - t) ** 2 * from.y + 2 * (1 - t) * t * mid.y + t * t * to.y };
    const a = initialSize ?? sizeOf(from), b = to.cardSize ?? { w: 38, h: 53.2 };
    return <><path d={`M${from.x} ${from.y} Q${mid.x} ${mid.y} ${to.x} ${to.y}`} pathLength="1" strokeDasharray="1" strokeDashoffset={1 - t} stroke={color} strokeWidth="2" opacity={envelope(p, start, start + .05, end + .12)} /><ScreenPixels at={at} opacity={visible(p, start) * (hold ? 1 : 1 - phase(p, end, end + .075))} color={color}><g transform={`rotate(${exhausted ? 10 * t : -7 * Math.sin(t * Math.PI)})`} opacity={exhausted ? 1 - .28 * t : 1}><CardGhost card={card} back={back} box={{ w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t }} /></g></ScreenPixels></>;
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
    return <>{(['power','hp'] as const).map((name,i)=>{const counter=at.counters?.[name], shape=sizeOf(at), pos=counter?{...at,...counter}:shift(at,(i?1:-1)*(shape.w/2-10),shape.h/2-12);return <ScreenPixels key={name} at={pos} opacity={visible(p,start)}><rect x="-11" y="-12" width="22" height="24" rx="3" fill={i?'#173f6f':'#8b2936'} stroke="#dce7f8" strokeWidth="1"/><text textAnchor="middle" y="4" fill="#fff" stroke="none" style={{font:'800 14px sans-serif'}}>{i?unit.h-unit.d:unit.p}</text></ScreenPixels>;})}</>;
}
function UnitFace({ at, unit, p, start, rotation=0, opacity=1, instant=false }: {at:EffectBox;unit:UnitRef;p:number;start:number;rotation?:number;opacity?:number;instant?:boolean}) {
    const shape=sizeOf(at); return <ScreenPixels at={at} opacity={(p<start?0:instant?1:visible(p,start))*opacity}><g transform={`rotate(${rotation}) scale(${rotation? .94:1})`} opacity={rotation ? .72 : 1}><CardGhost card={unit} box={shape}/>{[-1,1].map(side=><g key={side} transform={`translate(${side*(shape.w/2-10)} ${shape.h/2-11})`}><rect x="-10" y="-11" width="20" height="22" rx="3" fill={side<0?'#8b2936':'#173f6f'}/><text textAnchor="middle" y="4" fill="#fff" stroke="none" style={{font:'800 13px sans-serif'}}>{side<0?unit.p:Math.max(0,unit.h-unit.d)}</text></g>)}</g></ScreenPixels>;
}
function Packet({from,to,count,p,start,end,color='#efb994'}:{from:EffectBox;to:EffectBox;count:number;p:number;start:number;end:number;color?:string}) {
    const at={...from,...mix(from,to,easeInOut(phase(p,start,end)))};return <><path d={`M${from.x} ${from.y} L${to.x} ${to.y}`} stroke={color} strokeWidth="2" opacity={envelope(p,start,start+.04,end+.1)}/><ScreenPixels at={at} opacity={envelope(p,start,start+.04,end+.045)} color={color}><CountedMarks count={count} gap={12} radius={4}/></ScreenPixels></>;
}
const bravadoProof=(cue:CardEffectCue,g:Geometry)=>{
    const cost=g.outcomes.find(i=>i.outcome.kind==='cost'), ready=g.outcomes.find(i=>i.outcome.kind==='ready'), before=cue.transition?.before;
    if(!cost||!ready||!before||num(cost.outcome)!==-2||cue.playCost!==5||!cost.outcome.card?.id||!cost.outcome.incarnation||!cost.outcome.defeatPhase)return;
    const hist=before.defeatedThisPhase, witnessed=hist?.cards.find(c=>c.id===cost.outcome.card!.id&&c.incarnation===cost.outcome.incarnation);
    const old=unitIn(cue,ready.outcome.card,ready.outcome.seat),after=unitIn(cue,ready.outcome.card,ready.outcome.seat,true);
    if(!hist||hist.round!==before.round||hist.phase!==before.phase||cost.outcome.defeatPhase.round!==hist.round||cost.outcome.defeatPhase.phase!==hist.phase||!witnessed||witnessed.controller===cue.seat||!witnessed.controller||witnessed.defeatedBy!==cue.seat||!['unit','leader-unit'].includes(witnessed.lastKnownType??'')||!old||!after||!unchanged(old,after)||after.x||num(ready.outcome)!==1||g.outcomes.some(i=>i.outcome.kind==='defeat'||i.outcome.kind==='attack'))return;
    return {cost,ready,old,after,hist};
};
const lookProof=(cue:CardEffectCue,g:Geometry)=>{
    const pay=g.outcomes.find(i=>i.outcome.kind==='pay'), choice=pay?.outcome.choice;
    if(!pay||choice?.kind!=='controller-unless'||choice.decision!=='pay'||choice.amount!==2||num(pay.outcome)!==2||pay.outcome.chooserSeat!==choice.controller||pay.outcome.seat!==choice.controller||!cue.transition)return;
    const old=unitIn(cue,choice.subject,choice.controller), after=unitIn(cue,choice.subject,choice.controller,true),payer=cue.transition.before.players[choice.controller],end=cue.transition.after.players[choice.controller],cards=pay.outcome.cards,eventIds=paidEventIds(cue);
    if(!old||!after||!sameStats(old,after)||!cards||cards.length!==2||new Set(cards.map(key)).size!==2||!eventIds||cards.some(c=>!payer.resources?.some(r=>same(r,c)&&!r.x)||!end.resources?.some(r=>same(r,c)&&r.x===1)||choice.controller===cue.seat&&eventIds.includes(key(c)))||end.res.ready!==payer.res.ready-2-(choice.controller===cue.seat?cue.playCost??0:0)||end.res.total!==payer.res.total||g.outcomes.some(i=>['attack','ready','exhaust'].includes(i.outcome.kind)))return;
    return {pay,choice,old,after,payer,end,cards};
};
const maProof=(cue:CardEffectCue,g:Geometry)=>{
    const ret=g.outcomes.find(i=>i.outcome.kind==='return'),hit=g.outcomes.find(i=>i.outcome.kind==='damage'),before=ret&&unitIn(cue,ret.outcome.card,ret.outcome.fromSeat??cue.seat),req=hit?.outcome.requiresReturn;
    if(!ret||!hit||!before||!before.id||!before.incarnation||!before.owner||!['SOR_247','SHD_257'].includes(before.s??'')||!cue.transition||ret.outcome.fromSeat!==cue.seat||ret.outcome.seat!==before.owner||ret.outcome.ownerSeat!==before.owner||ret.outcome.zone!=='hand'||ret.outcome.incarnation!==before.incarnation||!req||req.id!==before.id||req.incarnation!==before.incarnation||req.ownerSeat!==before.owner||g.outcomes.indexOf(ret)>=g.outcomes.indexOf(hit)||ret.outcome.prevented||num(hit.outcome)!==3||hit.outcome.damageType!=='ability'||!cue.transition.after.players[before.owner].hand.some(c=>same(c,before))||unitIn(cue,before,cue.seat,true))return;
    const target=unitIn(cue,hit.outcome.card,hit.outcome.seat),after=unitIn(cue,hit.outcome.card,hit.outcome.seat,true);
    if(!target||!after||same(target,before)||after.d!==target.d+3||after.p!==target.p||after.h!==target.h||after.incarnation!==target.incarnation||after.owner!==target.owner||!!after.x!==!!target.x)return;
    for(const up of before.u??[])if(!up.t&&(!up.owner||!cue.transition.after.players[up.owner].discard.some(c=>same(c,up))))return;
    return {ret,hit,before,target,after};
};
const combatProof=(cue:CardEffectCue,g:Geometry,cross:boolean)=>{
    const attacks=g.outcomes.filter(i=>i.outcome.kind==='attack');if(attacks.length!==1||!cue.transition)return;
    const attack=attacks[0],o=attack.outcome;if(!o.attackId||!fullUnit(o.sourceCard)||!fullUnit(o.card)||o.seat===cue.seat||o.combatOrder!=='simultaneous')return;
    const before=unitIn(cue,o.sourceCard,cue.seat),defender=unitIn(cue,o.card,o.seat),after=unitIn(cue,o.sourceCard,cue.seat,true);if(!before||!defender||!after||!before.id||!before.incarnation||!defender.incarnation||o.sourceCard.incarnation!==before.incarnation||o.card.incarnation!==defender.incarnation||!unchanged(o.sourceCard,before)||!sameStats(o.card,defender)||o.sourceCard.x)return;
    const linked=g.outcomes.filter(i=>i.outcome.attackId===o.attackId),forward=linked.find(i=>i.outcome.kind==='damage'&&same(i.outcome.card,defender)),counter=linked.find(i=>i.outcome.kind==='damage'&&same(i.outcome.card,before)),exhaust=linked.find(i=>i.outcome.kind==='exhaust'&&same(i.outcome.card,before)),buff=linked.find(i=>i.outcome.kind==='buff'&&same(i.outcome.card,before)),debuff=linked.find(i=>i.outcome.kind==='debuff'&&same(i.outcome.card,defender)),death=linked.find(i=>i.outcome.kind==='defeat'&&same(i.outcome.card,defender));
    if(!forward||!counter||!exhaust||!buff||!death||death.outcome.prevented||buff.outcome.duration!=='attack'||buff.outcome.amount!=='+2/+0'||g.outcomes.indexOf(buff)>=g.outcomes.indexOf(attack)||g.outcomes.indexOf(exhaust)>=g.outcomes.indexOf(forward)||[forward,counter].some(i=>i.outcome.damageType!=='combat'||i.outcome.combatOrder!=='simultaneous'||g.outcomes.indexOf(i)<=g.outcomes.indexOf(attack))||num(forward.outcome)!==before.p+2||num(counter.outcome)!==Math.max(0,defender.p-(cross?2:0))||defender.d+num(forward.outcome)<defender.h||death.outcome.incarnation!==defender.incarnation||!death.outcome.ownerSeat||unitIn(cue,defender,o.seat,true)||!cue.transition.after.players[death.outcome.ownerSeat].discard.some(c=>same(c,defender))||after.incarnation!==before.incarnation||after.owner!==before.owner||after.p!==before.p||after.h!==before.h||after.d!==before.d+num(counter.outcome)||after.x!==1||after.status?.some(s=>s.duration==='attack'))return;
    const ready=g.outcomes.find(i=>i.outcome.kind==='ready'&&same(i.outcome.card,before));
    const keyword=linked.find(i=>i.outcome.kind==='keyword'&&i.outcome.keyword?.name==='Saboteur');
    const shields=linked.filter(i=>i.outcome.kind==='defeat'&&defender.u?.some(up=>up.t&&up.n==='Shield'&&same(up,i.outcome.card)));
    if(cross){if(before.x||!cue.transition.before.players[cue.seat].space.some(c=>same(c,before))||!cue.transition.before.players[o.seat].ground.some(c=>same(c,defender))||o.attackArenaPermission!=='space-to-ground'||buff.outcome.attackRole!=='attacker'||!debuff||debuff.outcome.attackRole!=='defender'||debuff.outcome.duration!=='attack'||!['-2/-0','-2/+0','-2/0'].includes(String(debuff.outcome.amount).replaceAll('−','-'))||!keyword||keyword.outcome.duration!=='attack'||keyword.outcome.keyword?.amount!==1||!same(keyword.outcome.card,before)||g.outcomes.indexOf(debuff)>=g.outcomes.indexOf(attack)||g.outcomes.indexOf(keyword)>=g.outcomes.indexOf(attack)||shields.length!==(defender.u??[]).filter(up=>up.t&&up.n==='Shield').length||shields.some(i=>g.outcomes.indexOf(i)<=g.outcomes.indexOf(attack)||g.outcomes.indexOf(i)>=g.outcomes.indexOf(forward)||i.outcome.prevented))return;
    }else{const choice=ready?.outcome.choice;if(!ready||num(ready.outcome)!==1||choice?.kind!=='opponent-mode'||choice.decision!=='unit'||choice.chooser===cue.seat||choice.actor!==cue.seat||ready.outcome.chooserSeat!==cue.seat||ready.outcome.seat!==cue.seat||before.s!=='SHD_200'||buff.outcome.attackBonusBasis?.kind!=='wookiee'||buff.outcome.attackBonusBasis.sourceId!==before.id||buff.outcome.attackBonusBasis.incarnation!==before.incarnation||g.outcomes.indexOf(ready)>=g.outcomes.indexOf(attack))return;}
    return {attack,before,defender,after,forward,counter,exhaust,buff,debuff,death,ready,keyword,shields,linked};
};
export function batchA07SecondaryCovers(cue:CardEffectCue,g:Geometry,item:PlacedOutcome):boolean{
    switch(cue.definition.id){
        case 'bravado':{const proof=bravadoProof(cue,g);return !!proof&&[proof.cost,proof.ready].includes(item);}
        case 'look-the-other-way':return item===lookProof(cue,g)?.pay;
        case 'ma-klounkee':{const proof=maProof(cue,g);return !!proof&&[proof.ret,proof.hit].includes(item);}
        case 'let-the-wookiee-win':case 'swoop-down':{const proof=combatProof(cue,g,cue.definition.id==='swoop-down');return !!proof&&(proof.linked.includes(item)||item===proof.ready);}
        default:return false;
    }
}
function Bravado({cue,geometry:g,p}:Props){
    const proof=bravadoProof(cue,g);if(!proof)return null;const{old,after,ready}=proof,at=ready.box,t=easeInOut(phase(p,.29,.59));return <><Payment cue={cue} geometry={g} p={p}/><Mask at={g.source} p={p} start={.05}/><Receipt at={center(g)} rows={[`EARLIER ENEMY DEFEAT · BY ${cue.seat.toUpperCase()}`,'COST 7 → 5']} p={p} start={.05} until={.37} color="#edcb93"/><Mask at={at} p={p} start={.29}/><UnitFace at={at} unit={after} p={p} start={.29} rotation={old.x?10*(1-t):0}/><ScreenPixels at={shift(at,0,-sizeOf(at).h/2-12)} color="#c8edae" opacity={envelope(p,.3,.5,.75)}><path d="M-16 0 A16 16 0 1 1 12 12 M12 12 V1 M12 12 H1" strokeWidth="2"/></ScreenPixels><Receipt at={center(g)} rows={['READY · SAME UNIT ENTRY',`DAMAGE ${after.d} UNCHANGED`]} p={p} start={.7} color="#cee4b0"/></>;
}
function Look({cue,geometry:g,p}:Props){const proof=lookProof(cue,g);if(!proof)return null;const{choice,payer,end,cards}=proof;return <><Payment cue={cue} geometry={g} p={p}/><Mask at={g.source} p={p} start={.05}/><Receipt at={center(g)} rows={[`CONTROLLER ${choice.controller.toUpperCase()} CHOOSES`,'PAY 2  /  EXHAUST']} p={p} start={.05} until={.37} color="#cabdeb"/>{payer.resources?.map((r,i)=>{const at=g.resourceCards?.[`${choice.controller}:${key(r)}`];return at&&cards.some(c=>same(c,r))?<ResourceSlot key={key(r)} at={at} index={i} spent p={p} start={.4+i*.035}/>:null;})}<ResourceBalance at={g.zones[`${choice.controller}:resources`]} countAt={g.zones[`${choice.controller}:resource-count`]} ready={end.res.ready} total={end.res.total} p={p} start={.46}/><Receipt at={center(g)} rows={[`${choice.controller.toUpperCase()} PAID 2`,proof.after.x?'UNIT STAYS EXHAUSTED':'UNIT STAYS READY']} p={p} start={.66} color="#d8c9e8"/></>;}
function Ma({cue,geometry:g,p}:Props){const proof=maProof(cue,g);if(!proof)return null;const{ret,hit,before,after}=proof,to=g.endingCards?.[`${ret.outcome.seat}:${key(before)}`]??ret.to;return <><Payment cue={cue} geometry={g} p={p}/><Mask at={g.source} p={p} start={.05}/><Receipt at={center(g)} rows={['UNDERWORLD UNIT','RETURN TO OWNER HAND']} p={p} start={.06} until={.25} color="#c8bbdf"/><Mask at={ret.from} p={p} start={.2}/><Travel from={ret.from} to={to} card={before} p={p} start={.21} end={.48} color="#c2b4df"/>{(before.u??[]).map(up=>{const at=g.cards?.[`${cue.seat}:${key(up)}`];return at?<Mask key={key(up)} at={at} p={p} start={.21}/>:null;})}<Receipt at={center(g)} rows={(before.u??[]).filter(up=>!up.t).length ? [(before.u??[]).filter(up=>!up.t).map(up=>up.n).join(' + ').toUpperCase(),...(['p1','p2'] as Seat[]).filter(seat=>(before.u??[]).some(up=>!up.t&&up.owner===seat)).map(seat=>`OWNER ${seat.toUpperCase()} DISCARD +${(before.u??[]).filter(up=>!up.t&&up.owner===seat).length}`)] : ['NO ATTACHED UPGRADES']} p={p} start={.27} until={.5} color="#e1c6a4"/><Receipt at={center(g)} rows={['RETURN SUCCEEDED','3 ABILITY DAMAGE']} p={p} start={.5} until={.73} color="#edbd95"/><Packet from={center(g)} to={hit.box} count={3} p={p} start={.53} end={.69}/><Stats at={hit.box} unit={after} p={p} start={.7}/><Receipt at={center(g)} rows={[`OWNER ${ret.outcome.seat.toUpperCase()} HAND +1`,`TARGET DAMAGE ${after.d} · POSE UNCHANGED`]} p={p} start={.8} color="#d9c5b0"/></>;}
function Combat({cue,geometry:g,p,cross}:Props&{cross:boolean}){const proof=combatProof(cue,g,cross);if(!proof)return null;const{before,defender,after,attack,forward,counter,death,shields}=proof,from=atCard(g,before,cue.seat),to=atCard(g,defender,attack.outcome.seat),start=cross ? .34 : .38,hit=.57,end=.76,t=phase(p,start,hit),at={...from,...mix(from,cross?{...to,x:from.x}:to,Math.sin(t*Math.PI)*.2)},pose=p<hit?{...before,p:before.p+2}:{...after},final=g.endingCards?.[`${cue.seat}:${key(before)}`]??from;
    return <><Payment cue={cue} geometry={g} p={p}/><Mask at={g.source} p={p} start={.05}/><Receipt at={center(g)} rows={cross?['SPACE → GROUND · SABOTEUR','ATTACKER +2 · DEFENDER −2']:[`${proof.ready?.outcome.choice?.kind==='opponent-mode'?proof.ready.outcome.choice.chooser.toUpperCase():''} CHOOSES UNIT · ${cue.seat.toUpperCase()} SELECTS`,'WOOKIEE READIES · ATTACK +2']} p={p} start={.06} until={.33} color="#e4c4a0"/>{!cross&&<><Mask at={from} p={p} start={.19}/><UnitFace at={from} unit={{...before,x:undefined}} p={p} start={.19} opacity={p<start?1:0}/></>}{cross&&<>{shields.map(shield=><g key={shield.key}><ScreenPixels at={to} opacity={envelope(p,.15,.24,.33)} color="#bfe8fb"><path d="M0 -30 L22 -17 V5 Q17 25 0 31 Q-17 25 -22 5 V-17 Z M-25 -9 L25 12" strokeWidth="3"/></ScreenPixels>{shield.box.exact&&<Mask at={shield.box} p={p} start={.25}/>}</g>)}<Stats at={to} unit={{...defender,p:Math.max(0,defender.p-2)}} p={p} start={.32}/></>}
        <Mask at={from} p={p} start={start}/><UnitFace at={p<.84 ? at : {...from,...mix(from,final,easeInOut(phase(p,.84,.93)))}} unit={pose} p={p} start={start} instant={!cross} rotation={10*phase(p,start,hit)}/><Packet from={from} to={to} count={num(forward.outcome)} p={p} start={hit-.09} end={hit}/><Packet from={to} to={from} count={num(counter.outcome)} p={p} start={hit-.09} end={hit} color="#bbd7ed"/><Mask at={to} p={p} start={hit+.015}/><Travel from={to} to={death.to} card={defender} p={p} start={hit+.025} end={end} hold={false} color="#efb799"/>
        <Receipt at={center(g)} rows={[`TARGET DEFEATED · COUNTER ${num(counter.outcome)}`,`RESTING POWER ${after.p} · DAMAGE ${after.d}`]} p={p} start={.79} color="#e5c7ae"/>
    </>;
}
export function BatchA07SecondarySignature(props:Props){switch(props.cue.definition.id){case 'bravado':return <Bravado {...props}/>;case 'look-the-other-way':return <Look {...props}/>;case 'ma-klounkee':return <Ma {...props}/>;case 'let-the-wookiee-win':return <Combat {...props} cross={false}/>;case 'swoop-down':return <Combat {...props} cross/>;default:return null;}}
