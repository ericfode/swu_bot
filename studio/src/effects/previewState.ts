import type { CardRef, GrantedDefeatAbility, ResourceRef, Seat, Snapshot, UnitRef, UpgradeRef } from '../data/types';
import type { PreviewAspect } from './previewCosts';
import type { CardEffectCue } from './types';
import { previewGivenCost, previewPlayCost } from './previewCosts';
import { a16VerifiedPrintedFacts } from './batchA16';

type Zone = 'base' | 'leader' | 'ground' | 'space' | 'hand' | 'discard' | 'deck' | 'resources';
interface Entry { card: CardRef; seat: Seat; zone: Zone; parent?: UnitRef; captive?: true }
const seats: Seat[] = ['p1', 'p2'];
const isUnit = (card: CardRef): card is UnitRef => 'p' in card && 'h' in card && 'd' in card;
const ref = (card: CardRef): CardRef => ({ n: card.n, s: card.s, ...(card.id ? { id: card.id } : {}), ...(card.owner ? { owner: card.owner } : {}) });
const count = (amount: number | string | undefined, fallback = 0) => typeof amount === 'number' && Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : fallback;
const same = (card: CardRef, target: CardRef) => target.id ? card.id === target.id : card.n === target.n && card.s === target.s;

/**
 * Resolve explicit theatre receipts into the showcase's ending board. This is deliberately not a rules engine:
 * recorded games use their actual after snapshot. Play costs come from verified showcase metadata.
 * Lookups retain their original zone so a played Restock cannot be mistaken for a different copy in discard.
 */
export function resolvePreviewState(before: Snapshot, cue: CardEffectCue): Snapshot {
    const state = structuredClone(before);
    const entries: Entry[] = seats.flatMap(seat => {
        const player = state.players[seat];
        return [
            { card: player.base, seat, zone: 'base' as const },
            ...(player.leader?.dep === 0 ? [{ card: player.leader, seat, zone: 'leader' as const }] : []),
            ...(player.resources ?? []).map(card => ({ card, seat, zone: 'resources' as const })),
            ...(player.knownDeck ?? []).map(card => ({ card, seat, zone: 'deck' as const })),
            ...(['ground', 'space', 'hand', 'discard'] as const).flatMap(zone => player[zone].flatMap((card): Entry[] => [
                { card, seat, zone },
                ...(isUnit(card) ? (card.u ?? []).map(upgrade => ({ card: upgrade, seat, zone, parent: card })) : []),
                ...(isUnit(card) ? (card.cap ?? []).map(captive => ({ card: captive, seat, zone, parent: card, captive: true as const })) : [])
            ]))
        ];
    });
    const find = (card: CardRef | null | undefined, allowed: (entry: Entry) => boolean): Entry | undefined => {
        if (!card) return undefined;
        const matches = entries.filter(entry => allowed(entry) && same(entry.card, card));
        return matches.length === 1 ? matches[0] : undefined;
    };
    const arena = (entry: Entry) => entry.zone === 'ground' || entry.zone === 'space';
    const present = (entry: Entry) => entry.parent ? (entry.zone === 'ground' || entry.zone === 'space')
        && state.players[entry.seat][entry.zone].includes(entry.parent)
        && (entry.captive ? !!entry.parent.cap?.includes(entry.card) : !!entry.parent.u?.includes(entry.card as UpgradeRef))
        : entry.zone === 'base' || (entry.zone === 'leader' ? state.players[entry.seat].leader === entry.card
            : entry.zone === 'resources' ? !!state.players[entry.seat].resources?.includes(entry.card)
            : entry.zone === 'deck' ? !!state.players[entry.seat].knownDeck?.includes(entry.card)
            : state.players[entry.seat][entry.zone].includes(entry.card as UnitRef));
    const remove = (entry: Entry, leavesPlay = true) => {
        if(entry.zone==='discard'&&entry.card.id&&state.discardPlayPermissions)state.discardPlayPermissions=state.discardPlayPermissions.filter(p=>p.cardId!==entry.card.id);

        if (leavesPlay && !entry.parent && arena(entry) && entry.card.id && state.pending) {
            state.pending = state.pending.filter(effect => effect.targetId !== entry.card.id);
        }
        if (entry.parent) {
            if (entry.captive) entry.parent.cap = entry.parent.cap?.filter(card => card !== entry.card);
            else entry.parent.u = entry.parent.u?.filter(card => card !== entry.card);
        }
        else if (entry.zone === 'deck') {
            const player = state.players[entry.seat];
            const index = player.knownDeck?.indexOf(entry.card) ?? -1;
            if (index >= 0) { player.knownDeck!.splice(index, 1); player.deck -= 1; }
        } else if (entry.zone === 'resources') {
            const player = state.players[entry.seat], index = player.resources?.indexOf(entry.card) ?? -1;
            if (index >= 0) { if (!(entry.card as ResourceRef).x) player.res.ready -= 1; player.resources!.splice(index, 1); player.res.total -= 1; }
        } else if (entry.zone !== 'base' && entry.zone !== 'leader') {
            const cards = state.players[entry.seat][entry.zone];
            const index = cards.indexOf(entry.card as UnitRef);
            if (index >= 0) cards.splice(index, 1);
        }
    };
    const discardAttachments = (entry: Entry) => {
        if (isUnit(entry.card)) {
            for (const upgrade of entry.card.u ?? []) {
                if (!upgrade.t) state.players[upgrade.owner ?? entry.seat].discard.push(ref(upgrade));
            }
        }
    };
    const occupiedIds = new Set(entries.flatMap(entry => entry.card.id ? [entry.card.id] : []));
    const generatedId = (label: string) => {
        // A replay nonce changes the clock, not the identity of this staged result.
        const stem = `preview:${cue.definition.id}:${label}`;
        let id = stem;
        for (let suffix = 1; occupiedIds.has(id); suffix++) id = `${stem}:${suffix}`;
        occupiedIds.add(id);
        return id;
    };
    const smuggle=cue.playPayment?.kind==='resources'?cue.playPayment.smuggle:undefined;
    const source = find(cue.source, entry => entry.seat === cue.seat && entry.zone === (smuggle?'resources':'hand') && !entry.parent);
    if(smuggle && (!source || !source.card.id || source.card.id!==smuggle.sourceId || cue.source?.n!==source.card.n || cue.source?.s!==source.card.s || cue.source?.owner!==source.card.owner)) throw new Error(`Showcase ${cue.definition.id}: explicit Smuggle source is missing or mismatched`);
    if(!smuggle && find(cue.source,e=>e.seat===cue.seat && e.zone==='resources' && !e.parent)) throw new Error(`Showcase ${cue.definition.id}: resource-origin event needs explicit Smuggle mode`);
    if(smuggle && state.players[cue.seat].knownDeck?.length!==state.players[cue.seat].deck)throw new Error(`Showcase ${cue.definition.id}: Smuggle replacement requires a complete actual staged deck manifest`);
    let smuggleReplacement=false;
    const validateResources = (seat: Seat) => {
        const player = state.players[seat], cards = player.resources;
        if (cards && (cards.length !== player.res.total || cards.filter(card => !card.x).length !== player.res.ready
            || cards.some(card => !card.id) || new Set(cards.map(card => card.id)).size !== cards.length)) throw new Error(`Showcase ${cue.definition.id}: resource manifest contradicts exact identity/readiness counts`);
    };
    for (const seat of seats) validateResources(seat);
    const payResources = (seat: Seat, amount: number, purpose: string, cardIds?: string[]) => {
        const resources = state.players[seat].res;
        if (resources.ready < amount) {
            throw new Error(`Showcase ${cue.definition.id}: ${purpose} needs ${amount} ready resources; only ${resources.ready} remain`);
        }
        const manifest = state.players[seat].resources;
        if (manifest) {
            const ids = cardIds ?? (amount === 0 ? [] : undefined);
            if (!ids || ids.length !== amount || new Set(ids).size !== ids.length || ids.some(id => !manifest.some(card => card.id === id && !card.x))) throw new Error(`Showcase ${cue.definition.id}: ${purpose} needs exact distinct ready resource identities`);
            for (const card of manifest) if (ids.includes(card.id!)) card.x = 1;
        }
        resources.ready -= amount;
    };
    const sourceBecomesResource = !!source && (cue.outcomes ?? []).some(outcome => outcome.kind === 'resource'
        && outcome.seat === cue.seat && count(outcome.amount, 1) > 0 && !!outcome.card && same(source.card, outcome.card));
    const exploit=cue.playPayment?.kind==='resources'?cue.playPayment.exploit:undefined;
    const declaredOutcomes=cue.outcomes??[];
    const exploitPrefix=exploit?.units.length??0;
    if(exploitPrefix>declaredOutcomes.length)throw new Error(`Showcase ${cue.definition.id}: Exploit cost prefix is incomplete`);
    if(exploit){
        if(!source||source.card.id!==exploit.sourceId||cue.source?.n!==source.card.n||cue.source?.s!==source.card.s||cue.source?.owner!==source.card.owner)throw new Error(`Showcase ${cue.definition.id}: Exploit causing event mismatch`);
        // Validate against the untouched before state, including its printed maximum and controlled entries.
        previewPlayCost(cue.definition,before,cue.seat,cue.playPayment);
        if(declaredOutcomes.slice(0,exploitPrefix).some((o,i)=>o.kind!=='defeat'||o.paymentRole!=='exploit'||o.prevented||o.seat!==cue.seat||o.card?.id!==exploit.units[i].id||o.incarnation!==exploit.units[i].incarnation
            ||o.sourceCard?.id!==source.card.id||o.sourceCard?.n!==source.card.n||o.sourceCard?.s!==source.card.s))throw new Error(`Showcase ${cue.definition.id}: Exploit needs an exact ordinary cost-defeat prefix`);
    }
    if(declaredOutcomes.slice(exploitPrefix).some(o=>o.paymentRole))throw new Error(`Showcase ${cue.definition.id}: Exploit cost receipts cannot occur after payment`);
    let sourcePaid=false;
    const paySourceOnce=()=>{if(sourcePaid)return;sourcePaid=true;
    if (source) {
        // Pay once, before event resolution. A visual cost-reduction receipt never pays or discounts it again.
        if (cue.playPayment?.kind === 'alternate-discard' && cue.playPayment.sourceId !== source.card.id) {
            throw new Error(`Showcase ${cue.definition.id}: alternate payment names a different source event`);
        }
        payResources(cue.seat, previewPlayCost(cue.definition, before, cue.seat, cue.playPayment), 'play cost', cue.playPayment?.kind === 'resources' ? cue.playPayment.cardIds : undefined);
        if (cue.playPayment?.kind === 'alternate-discard') for (const paid of cue.playPayment.cards) {
            const payment = find(paid, entry => entry.seat === cue.seat && entry.zone === 'hand' && !entry.parent);
            if (!payment || !present(payment)) throw new Error(`Showcase ${cue.definition.id}: actual alternate discard payment is missing`);
            remove(payment);
            state.players[cue.seat].discard.push(ref(payment.card));
        }
        if(smuggle){
            const manifest=state.players[cue.seat].resources!,declared=smuggle.resourcesAfterPayment;
            if(!Array.isArray(declared))throw new Error(`Showcase ${cue.definition.id}: Smuggle resource rearrangement must be an explicit complete array`);
            const ids=declared.map(c=>c.id);
            if(declared.length!==manifest.length || ids.some(id=>!id) || new Set(ids).size!==ids.length
                || declared.some(c=>!manifest.some(a=>a.id===c.id && a.n===c.n && a.s===c.s && a.owner===c.owner) || c.x!==undefined && c.x!==1)
                || declared.filter(c=>c.x).length!==manifest.filter(c=>c.x).length || !declared.find(c=>c.id===source.card.id)?.x) throw new Error(`Showcase ${cue.definition.id}: Smuggle resource rearrangement needs exact permutation, flags, exhausted source and paid count`);
            state.players[cue.seat].resources=structuredClone(declared);
            for(const e of entries)if(e.seat===cue.seat && e.zone==='resources')e.card=state.players[cue.seat].resources!.find(c=>c.id===e.card.id)!;
        }
        remove(source);
        if (!sourceBecomesResource) state.players[cue.seat].discard.push(ref(source.card));
    }

    };
    if(!exploitPrefix)paySourceOnce();

    const deckSelections = new Map<Seat, Set<string>>();
    const healed = new Map<string, number>();
    const discardedIds = new Set<string>();
    const discardedDeckIds=new Set<string>();
    const successfulExhaustions=new Map<string,{incarnation:string;controller:Seat;sourceId:string}>();
    const nameGroups=new Map<string,{witness:NonNullable<NonNullable<CardEffectCue['outcomes']>[number]['sameNameGroup']>;returned:Set<string>}>();

    const returnedUnits=new Map<string,{incarnation:string;ownerSeat:Seat}>();
    const consumedPending=new Set<string>();
    const resolvedBounties=new Set<string>();
    const defenderBonuses=new Map<string,{id:string;power:number}>();
    const defenseOrigins=new Map<string,NonNullable<NonNullable<CardEffectCue['outcomes']>[number]['defenseOrigin']>>();
    const equalizeFirst=new Map<string,{id:string;incarnation:string;controller:Seat}>();
    const chosenGroups=new Map<string,{kind:'discard'|'arena';cards:CardRef[];units:{id:string;incarnation:string;power:number}[];created:number;attempted:Set<string>}>();
    const attackPowers=new Map<string,{attacker:number;defender?:number}>();
    type Outcome = NonNullable<CardEffectCue['outcomes']>[number];
    const sharedTraits=new Map<string,{witness:NonNullable<Outcome['sharedTrait']>;assigned:Set<string>}>();
    const defenderStarts=new Map<string,NonNullable<Outcome['defenderDamageAtStart']>>();
    const attackGrit=new Map<string,NonNullable<Outcome['gritBasis']>>();
    const gritModifiers=new Set<string>();
    const powerWindows=new Map<string,{witness:NonNullable<Outcome['powerWindow']>;hits:Set<string>}>();
    const attackBonuses = new Map<string, { id: string; power: number }>();
    const attacks = new Map<string, { attackerId: string; incarnation?: string; attackingSeat: Seat; defenderId: string; damage: number; counter: number; combatStarted: boolean; restoreAmount: number; order: 'simultaneous' | 'attacker-first' }>();
    const attackKeywords = new Map<string, { id: string; name: 'Saboteur' }>();
    const revealedCosts = new Map<string, number>();
    const playedCosts = new Map<string, number>();
    const privateChoices = new Map<string, 'leave' | 'play-discount' | 'play-free'>();
    const sequences = new Map<string, { targetId: string; incarnation: string; sourceIds: Set<string>; index: number }>();
    const healingAllocations = new Map<string, { limit: number; total: number }>();
    const defeatedAbilitySeals=new Map<string,{controller:Seat;source:CardRef;grants:GrantedDefeatAbility[]}>();
    const activatedGrants=new Set<string>(),restoredAttacks=new Set<string>();
    const defeatedIds = new Set<string>(), preventedIds = new Set<string>();
    const defeatedIncarnations = new Map<string,string>(), paidUnits = new Map<string,number>();
    const paidPlayers=new Map<string,Seat>(),defeatedPowers=new Map<string,number>();
    const defeatKey=(id:string,incarnation:string)=>`${id}\0${incarnation}`;
    const successfulHandDiscards=new Map<string,{seat:Seat;sourceId:string;owner?:Seat;destination:Seat}>();
    const privateHands=new Map<string,{selectedId:string;seat:Seat;sourceId:string}>();
    const singlePlays=new Map<string,NonNullable<Outcome['singleUnitPlay']>>();
    const captureSelections=new Map<string,NonNullable<Outcome['captureSelection']>>();
    const causalHits=new Map<string,{sourceId:string;amount:number;lethal:boolean}>(),clonedDefeats=new Set<string>();
    const focusGroups=new Map<string,{w:NonNullable<Outcome['vehicleSources']>;hits:Set<string>}>();
    const salvoGroups=new Map<string,{w:NonNullable<Outcome['arenaSalvo']>;hits:Set<string>}>();
    const pairGroups=new Map<string,{w:NonNullable<Outcome['pairedDamage']>;hits:Set<string>}>();
    const hotshotGroups=new Map<string,{w:NonNullable<Outcome['onAttackCensus']>;hits:Set<string>}>();
    const lightGroups=new Map<string,{w:NonNullable<Outcome['lightspeed']>;direct:boolean;indirect:boolean}>();
    const indirectGroups=new Map<string,{w:NonNullable<Outcome['indirectAllocation']>;hits:Set<string>}>();
    const attackWindows=new Map<string,{w:NonNullable<Outcome['onAttackWindow']>;mill?:CardRef[];selfHit:boolean;indirect:boolean}>();
    const usedShieldPreventions=new Set<string>();
    const vehiclePlays=new Map<string,{w:NonNullable<Outcome['discountedVehiclePlay']>;step:number}>();
    const generatedGroups=new Map<string,{w:NonNullable<Outcome['generatedSet']>;created:Set<string>;restricted:Set<string>}>();
    const titleGroups=new Map<string,{w:NonNullable<Outcome['distinctTitleBoost']>;assigned:Set<string>}>();
    const nebulaGroups=new Map<string,{w:NonNullable<Outcome['unupgradedSet']>;attempted:Set<string>}>();
    const wingsGroups=new Map<string,{w:NonNullable<Outcome['spaceExhaustion']>;attempted:Set<string>;created:Set<string>}>();
    const defeatAttempts=new Map<string,{id:string;incarnation:string;rewarded:boolean}>();
    const salvageSequences=new Map<string,{w:NonNullable<Outcome['discardPlayDamage']>;index:number}>();
    const originalIds=new Set(occupiedIds);
    const actualDraws=new Map<string,{seat:Seat;ids:string[]}>();
    const handBottoms=new Map<string,{w:NonNullable<Outcome['handBottom']>;moved:Set<string>}>();
    const clearances=new Map<string,{w:NonNullable<Outcome['spaceClearance']>;used:boolean}>();
    const controlSequences=new Map<string,{id:string;incarnation:string;controller:Seat;complete:boolean}>();
    const keywordWindows=new Map<string,{w:NonNullable<Outcome['keywordWindow']>;gained:Set<string>;lost:Set<string>}>();
    const traitGrants=new Map<string,{w:NonNullable<Outcome['traitGrant']>;buff:Set<string>;keyword:Set<string>}>();
    let randomDiscardBranch:{choice:Extract<NonNullable<Outcome['choice']>,{kind:'opponent-random-discard'}>;attempted:boolean;discarded:boolean;created:number}|undefined;
    const playedEntries = new Map<string,string>();
    const ambushReadied = new Set<string>();
    const captiveCleanups = new Map<string,{captor:Entry; incarnation:string; remaining:Map<string,Entry>}>();
    const revealedResources = new Map<Seat,{ ids:string[]; playIds:string[]; next:number }>();
    const xpDistributions = new Map<string, { sourceId: string; upgradeIds: string[]; count: number; assigned: number }>();
    function fail(message: string): never { throw new Error(`Showcase ${cue.definition.id}: ${message}`); }
    const stableIds = (cards: CardRef[], label: string): string[] => {
        const ids = cards.map(card => card.id);
        if (ids.some(id => !id) || new Set(ids).size !== cards.length) fail(`${label} requires unique stable card IDs`);
        return ids as string[];
    };
    const consumeDeckSelection = (seat: Seat, card: CardRef) => {
        const selected = deckSelections.get(seat);
        if (selected && (!card.id || !selected.delete(card.id))) fail('deck movement is outside the selected group or repeats a consumed selection');
    };

    const actualEvent=(o:Outcome)=>!!cue.source?.id && o.sourceCard?.id===cue.source.id && o.sourceCard.n===cue.source.n && o.sourceCard.s===cue.source.s && o.sourceCard.owner===cue.source.owner;
    const causeEvent=(o:Outcome)=>{const c=o.causeCard??o.sourceCard;return!!cue.source?.id&&c?.id===cue.source.id&&c.n===cue.source.n&&c.s===cue.source.s&&c.owner===cue.source.owner;};
    const originalUnit=(id:string,incarnation:string)=>{const all=seats.flatMap(seat=>['ground','space'].flatMap(zone=>before.players[seat][zone as 'ground'|'space'].map(u=>({u,seat,zone}))));const found=all.filter(x=>x.u.id===id&&x.u.incarnation===incarnation);return found.length===1?found[0]:undefined;};
    const exactRef=(a:CardRef,b:CardRef|undefined)=>!!b&&a.id===b.id&&a.n===b.n&&a.s===b.s&&a.owner===b.owner;
    const requireCause=(o:Outcome,code:string)=>{if(!causeEvent(o)||cue.source?.s!==code||state.phase!=='action')fail('new mechanic requires its exact canonical causing event in the actual action phase');};
    const currentAbilityObjects=(u:UnitRef)=>{
        if(!u.onAttackAbilities||new Set(u.onAttackAbilities.map(a=>a.id)).size!==u.onAttackAbilities.length)fail('active On Attack ability objects must be supplied as a complete distinct census');
        const list=u.onAttackAbilities!;
        if(u.s==='JTL_240'){
            if(list.length!==1||list[0].origin!=='native'||list[0].effect!=='firespray-indirect'||list[0].sourceId!==u.id||list[0].subjectId!==u.id||list[0].incarnation!==u.incarnation||list[0].requiresTrait||list[0].round!==undefined||list[0].phase!==undefined)fail('Firespray must retain its one actual combined native On Attack ability object');
        }else if(list.length||!['SOR_095','SOR_098','SOR_033','SOR_164','SOR_225','SOR_237','SOR_232','TWI_111'].includes(u.s??'')&&!u.t)fail('unknown or conditional native/gained On Attack census is unsupported');
        return list;
    };
    const currentGrit=(u:UnitRef)=>{
        const known=u.status?.filter(x=>x.keyword?.name==='Grit')??[];
        if(known.some(x=>x.keyword?.amount!==1||!['permanent','phase'].includes(x.duration)||x.duration==='phase'&&(x.round!==state.round||x.phase!==state.phase||x.incarnation!==u.incarnation)))fail('Grit requires actual current boolean keyword evidence');
        return known.length>0;
    };
    const validateGrit=(o:Outcome,e:Entry|undefined)=>{
        const b=o.gritBasis;
        if(!b||!e||!present(e)||!isUnit(e.card)||e.seat!==cue.seat||e.card.x||!e.card.id||e.card.id===state.players[e.card.owner??e.seat].leader?.id||!o.attackId||attacks.has(o.attackId)||!actualEvent(o)||o.incarnation!==e.card.incarnation||b.attackerId!==e.card.id||b.incarnation!==e.card.incarnation||b.damage!==e.card.d||b.powerIncludesGrit!==currentGrit(e.card)||o.duration!=='attack')fail('Grit needs ready friendly nonleader current wounds, exact entry and actual causing event');
        return b!;
    };
    // An explicit simultaneous damage group completes its declared hit window before a member leaves play.
    const damageGroups=new Map<string,{first:number;last:number;ids:Set<string>;hitKeys:Set<string>}>();
    for(const [i,o] of (cue.outcomes??[]).entries())if(o.kind==='damage'&&o.resolutionGroup){
        const id=o.resolutionGroup.id,g=damageGroups.get(id)??{first:i,last:i,ids:new Set<string>(),hitKeys:new Set<string>()};
        const hitKey=o.vehicleSources?`${o.card?.id}:${o.sourceCard?.id}`:o.card?.id;
        if(!id||o.resolutionGroup.mode!=='simultaneous'||!o.card?.id||!hitKey||g.hitKeys.has(hitKey)||g.ids.has(o.card.id)&&!o.vehicleSources||!Number.isSafeInteger(o.amount)||Number(o.amount)<0)fail('simultaneous damage requires distinct identified recipients or sealed distinct Vehicle sources');
        g.hitKeys.add(hitKey);g.ids.add(o.card.id);g.last=i;damageGroups.set(id,g);
    }
    for(const g of damageGroups.values())for(const o of (cue.outcomes??[]).slice(g.first,g.last+1))if(['defeat','return','capture','control'].includes(o.kind)&&o.card?.id&&g.ids.has(o.card.id))fail('simultaneous hit window must finish before a selected unit departure or control change');
    const exchanges=new Map<string,NonNullable<CardEffectCue['outcomes']>>();
    for(const o of cue.outcomes??[])if(o.controlExchange){const g=exchanges.get(o.controlExchange.id)??[];g.push(o);exchanges.set(o.controlExchange.id,g);}
    for(const group of exchanges.values()){
        const members=group[0].controlExchange!.memberIds;
        if(group.length!==2||new Set(members).size!==2||group.some(o=>o.kind!=='control'||!['permanent','regroup'].includes(o.duration??'')||o.duration!==group[0].duration||!o.card?.id
            ||!members.includes(o.card.id)||o.controlExchange?.memberIds.some((id,i)=>id!==members[i])))fail('exchange requires two exact opposite control receipts');
        const a=group[0],b=group[1];if(a.fromSeat!==b.seat||b.fromSeat!==a.seat||a.seat===b.seat||a.card!.id===b.card!.id)fail('exchange needs both opposite controllers');
        for(const o of group){const e=find(o.card,x=>arena(x)&&!x.parent&&present(x)&&x.seat===o.fromSeat),after=o.unit;
            if(!e||!isUnit(e.card)||!after||o.zone!==e.zone||o.fromZone!==e.zone||o.ownerSeat!==e.card.owner||o.incarnation!==e.card.incarnation
                || seats.some(side=>state.players[side].leader?.dep===1&&state.players[side].leader?.id===e.card.id))fail('exchange requires actual nonleader same-arena entries and preserved owner');
            if(o.duration==='regroup'){
                const p=(cue.outcomes??[]).filter(x=>x.kind==='delay'&&x.pending?.targetId===o.card?.id);
                if(!actualEvent(o)||(e!.card as UnitRef).x||(e!.card as UnitRef).leaderUnit!==false||p.length!==1||p[0].pending?.sourceId!==cue.source?.id||p[0].pending?.incarnation!==(e!.card as UnitRef).incarnation||p[0].pending?.kind!=='return-control'||p[0].pending?.trigger!=='regroup-start'||p[0].pending?.returnController!==e!.card.owner)fail('temporary exchange requires both ready nonleaders and exact owner-return obligations');
            }
            const expected=structuredClone(e.card);for(const u of expected.u??[])if(u.t){u.owner=o.seat;u.controller=o.seat;}
            const previous = e.card.status ?? [], statuses = after!.status;
            if (!statuses || statuses.length !== previous.length + 1
                || JSON.stringify(statuses.slice(0, previous.length)) !== JSON.stringify(previous)
                || statuses.at(-1)?.kind !== 'control' || statuses.at(-1)?.duration !== o.duration) fail('exchange must preserve previous statuses and add only its permanent control receipt');
            expected.status=after!.status;
            if(JSON.stringify(expected)!==JSON.stringify(after))fail('exchange final truth must preserve stats, damage, pose, entry and ordinary attachments/captives');
        }
    }
    function validateA16Outcome(outcome:Outcome,unit:Entry|undefined,recipient:Entry|undefined):void {
        if(outcome.lightspeed){const w=outcome.lightspeed;requireCause(outcome,'JTL_127');const a=originalUnit(w.friendly.id,w.friendly.incarnation),b=w.enemy?originalUnit(w.enemy.id,w.enemy.incarnation):undefined;
            if(!w.id||w.sourceId!==cue.source?.id||!a||a.seat!==cue.seat||a.zone!=='space'||a.u.p!==w.friendly.power||w.enemy&&(!b||b.seat===cue.seat||b.zone!=='space'||b.u.p!==w.enemy.power))fail('Lightspeed last powers require exact original friendly/enemy space entries');
            let g=lightGroups.get(w.id);
            const sealed={...w,stage:'defeat' as const,condition:undefined};
            if(g&&JSON.stringify({...g.w,condition:undefined})!==JSON.stringify(sealed))fail('Lightspeed sealed entries/powers changed');
            if(w.stage==='defeat'){if(g||outcome.kind!=='defeat'||outcome.card?.id!==a.u.id||outcome.incarnation!==a.u.incarnation)fail('Lightspeed must begin with its actual friendly defeat attempt');g={w:sealed,direct:false,indirect:false};lightGroups.set(w.id,g);}
            else if(w.stage==='direct'){if(!actualEvent(outcome)||outcome.attackId||!g||g.direct||!b||outcome.kind!=='damage'||outcome.card?.id!==b.u.id||outcome.damageAttempt?.incoming!==a.u.p||!defeatedIncarnations.has(a.u.id!))fail('Lightspeed direct hit needs its prior actual friendly departure and exact enemy last power');g.direct=true;}
            else {if(!g?.direct||w.condition!=='resolved-clauses'||!b||outcome.kind!=='damage'||outcome.indirectAllocation?.total!==b.u.p||outcome.indirectAllocation.player!==b.seat)fail('Lightspeed indirect requires both actual resolved clauses and enemy controller/last power');g.indirect=true;}
        }
        if(outcome.vehicleSources){const w=outcome.vehicleSources;requireCause(outcome,'JTL_129');const target=originalUnit(w.targetId,w.targetIncarnation),all=before.players[cue.seat][w.arena].filter(u=>u.traits?.includes('vehicle')),actual=all.find(u=>u.id===outcome.sourceCard?.id);
            if(outcome.kind!=='damage'||outcome.attackId||!outcome.resolutionGroup||!target||target.zone!==w.arena||!unit||!present(unit)||unit.card.id!==w.targetId||!isUnit(unit.card)||unit.card.incarnation!==w.targetIncarnation||outcome.incarnation!==w.targetIncarnation||!actual||!exactRef(actual,outcome.sourceCard)||w.sourceId!==cue.source?.id||w.members.length!==all.length||new Set(w.members.map(m=>m.id)).size!==all.length||w.members.some(m=>!all.some(u=>u.id===m.id&&u.incarnation===m.incarnation&&u.p===m.power))||outcome.damageAttempt?.incoming!==actual.p)fail('Vehicle focus needs complete original same-arena source census and actual independent current powers');
            let g=focusGroups.get(w.id);if(g&&JSON.stringify(g.w)!==JSON.stringify(w))fail('Vehicle focus census changed');if(!g){g={w:structuredClone(w),hits:new Set()};focusGroups.set(w.id,g);}if(g.hits.has(actual.id!))fail('Vehicle focus source repeats');g.hits.add(actual.id!);
        }
        if(outcome.arenaSalvo){const w=outcome.arenaSalvo;requireCause(outcome,'JTL_131');const a=originalUnit(w.unitId,w.incarnation),all=before.players[w.opponent][w.arena];
            if(outcome.kind!=='damage'||outcome.attackId||!outcome.resolutionGroup||!a||a.seat!==cue.seat||a.zone!=='space'||!exactRef(a.u,outcome.sourceCard)||a.u.p!==w.power||w.sourceId!==cue.source?.id||w.opponent===cue.seat||outcome.seat!==w.opponent||!unit||!present(unit)||!isUnit(unit.card)||unit.zone!==w.arena||outcome.incarnation!==unit.card.incarnation||w.members.length!==all.length||new Set(w.members.map(m=>m.id)).size!==all.length||w.members.some(m=>!all.some(u=>u.id===m.id&&u.incarnation===m.incarnation))||!w.members.some(m=>m.id===unit.card.id&&m.incarnation===(unit.card as UnitRef).incarnation)||outcome.damageAttempt?.incoming!==a.u.p)fail('arena Salvo needs current friendly space source power and complete enemy chosen-arena set');
            let g=salvoGroups.get(w.id);if(g&&JSON.stringify(g.w)!==JSON.stringify(w))fail('arena Salvo census changed');if(!g){g={w:structuredClone(w),hits:new Set()};salvoGroups.set(w.id,g);}if(g.hits.has(unit.card.id!))fail('arena Salvo target repeats');g.hits.add(unit.card.id!);
        }
        if(outcome.remainingHpDamage){const w=outcome.remainingHpDamage;requireCause(outcome,'JTL_144');if(outcome.kind!=='damage'||outcome.attackId||!actualEvent(outcome)||!unit||!present(unit)||!isUnit(unit.card)||unit.card.leaderUnit!==false||w.sourceId!==cue.source?.id||unit.card.id!==w.subjectId||unit.card.incarnation!==w.incarnation||outcome.incarnation!==w.incarnation||w.hp!==unit.card.h||w.wounds!==unit.card.d||w.computed!==Math.max(0,unit.card.h-unit.card.d-1)||outcome.damageAttempt?.incoming!==w.computed)fail('remaining-HP damage must use actual current nonleader health and wounds independently of claimed arithmetic');}
        if(outcome.pairedDamage){const w=outcome.pairedDamage;requireCause(outcome,'JTL_173');const a=originalUnit(w.friendly.id,w.friendly.incarnation),b=originalUnit(w.enemy.id,w.enemy.incarnation);if(outcome.kind!=='damage'||outcome.attackId||!actualEvent(outcome)||!outcome.resolutionGroup||w.sourceId!==cue.source?.id||!a||!b||a.seat!==cue.seat||b.seat===cue.seat||a.zone!==w.arena||b.zone!==w.arena||!unit||!present(unit)||!isUnit(unit.card)||![[a.u.id,a.u.incarnation],[b.u.id,b.u.incarnation]].some(([id,inc])=>id===unit.card.id&&inc===outcome.incarnation)||outcome.damageAttempt?.incoming!==3)fail('paired damage needs both exact actual opposite same-arena entries and simultaneous three-point attempts');let g=pairGroups.get(w.id);if(g&&JSON.stringify(g.w)!==JSON.stringify(w))fail('paired damage witness changed');if(!g){g={w:structuredClone(w),hits:new Set()};pairGroups.set(w.id,g);}if(g.hits.has(unit.card.id!))fail('paired damage target repeats');g.hits.add(unit.card.id!);}
        if(outcome.onAttackCensus){const w=outcome.onAttackCensus;requireCause(outcome,'JTL_174');const a=originalUnit(w.subjectId,w.incarnation),all=before.players[cue.seat==='p1'?'p2':'p1'].ground.concat(before.players[cue.seat==='p1'?'p2':'p1'].space);if(!a||a.seat!==cue.seat||w.sourceId!==cue.source?.id||JSON.stringify(currentAbilityObjects(a.u))!==JSON.stringify(w.abilities)||w.targets.length!==Math.min(w.abilities.length,all.length)||new Set(w.targets.map(t=>t.id)).size!==w.targets.length||w.targets.some(t=>!all.some(u=>u.id===t.id&&u.incarnation===t.incarnation))||outcome.kind!=='damage'||outcome.attackId||!actualEvent(outcome)||!outcome.resolutionGroup||!unit||!present(unit)||!isUnit(unit.card)||!w.targets.some(t=>t.id===unit.card.id&&t.incarnation===outcome.incarnation)||outcome.damageAttempt?.incoming!==2)fail('Hotshot needs actual active ability objects, distinct clamped opposing targets and two-point attempts');let g=hotshotGroups.get(w.subjectId);if(g&&JSON.stringify(g.w)!==JSON.stringify(w))fail('Hotshot ability census changed');if(!g){g={w:structuredClone(w),hits:new Set()};hotshotGroups.set(w.subjectId,g);}if(g.hits.has(unit.card.id!))fail('Hotshot initial target repeats');g.hits.add(unit.card.id!);}
        if(outcome.indirectAllocation){const w=outcome.indirectAllocation;requireCause(outcome,cue.source?.s==='JTL_127'?'JTL_127':'JTL_174');if(outcome.kind==='damage'){
            if(!w.id||w.sourceId!==cue.source?.id||w.player!==outcome.seat||outcome.chooserSeat!==w.player||!outcome.unpreventable||outcome.damageType!=='ability'||outcome.prevented||!recipient||!present(recipient)||new Set(w.members.map(m=>m.id)).size!==w.members.length||w.members.some(m=>!Number.isSafeInteger(m.amount)||m.amount<=0)||w.members.reduce((n,m)=>n+m.amount,0)!==w.total||!w.members.some(m=>m.id===recipient.card.id&&m.amount===outcome.amount&&(recipient!.zone==='base'?m.incarnation===undefined:isUnit(recipient!.card)&&m.incarnation===recipient!.card.incarnation)))fail('indirect assignment needs actual controller choice, exact positive allocation and unpreventable damage');
            let g=indirectGroups.get(w.id);if(g&&JSON.stringify(g.w)!==JSON.stringify(w))fail('indirect allocation changed');if(!g){for(const m of w.members){const e=entries.find(e=>!e.parent&&present(e)&&e.seat===w.player&&e.card.id===m.id&&(e.zone==='base'||arena(e)));if(!e||isUnit(e.card)&&(e.card.incarnation!==m.incarnation||m.amount>e.card.h-e.card.d))fail('indirect assignment exceeds actual current remaining HP or selects absent entry');}g={w:structuredClone(w),hits:new Set()};indirectGroups.set(w.id,g);}if(g.hits.has(recipient.card.id!))fail('indirect recipient repeats');g.hits.add(recipient.card.id!);
        }}
        if(outcome.onAttackWindow){const w=outcome.onAttackWindow;requireCause(outcome,w.effect==='trench-cost-difference'?'JTL_156':'JTL_174');const a=find(outcome.sourceCard,e=>!e.parent&&arena(e)&&present(e));if(!a||!isUnit(a.card)||a.seat!==cue.seat||a.card.id!==w.subjectId||a.card.incarnation!==w.incarnation||w.sourceId!==cue.source?.id||w.attackId!==outcome.attackId||w.round!==state.round||w.phase!==state.phase||!w.id||!['buff','attack'].includes(outcome.kind)||w.effect==='trench-cost-difference'&&(!a.card.traits?.includes('fighter')||outcome.kind==='buff'&&(outcome.amount!=='+4/+0'||outcome.duration!=='attack'))||w.effect==='firespray-indirect'&&(outcome.kind!=='attack'||a.card.s!=='JTL_240'||currentAbilityObjects(a.card).length!==1))fail('On Attack window needs actual current source entry, canonical origin and attack phase');let g=attackWindows.get(w.attackId);if(g&&JSON.stringify(g.w)!==JSON.stringify(w))fail('On Attack window changed');if(!g){g={w:structuredClone(w),selfHit:false,indirect:false};attackWindows.set(w.attackId,g);}}
        if(outcome.onAttackOrigin){const o=outcome.onAttackOrigin,g=attackWindows.get(o.attackId),a=attacks.get(o.attackId),u=a?entries.find(e=>!e.parent&&arena(e)&&present(e)&&e.card.id===a.attackerId):undefined;if(!g||!a||a.combatStarted||!u||!isUnit(u.card)||u.card.x!==1||g.w.id!==o.windowId||g.w.subjectId!==u.card.id||g.w.incarnation!==u.card.incarnation||o.round!==state.round||o.phase!==state.phase||outcome.attackId!==o.attackId||!exactRef(u.card,outcome.sourceCard)||!causeEvent(outcome)||o.ability.subjectId!==u.card.id||o.ability.incarnation!==u.card.incarnation||o.ability.effect!==g.w.effect)fail('actual On Attack ability must resolve from the declared attacking entry before combat');
            if(g.w.effect==='trench-cost-difference'){
                if(o.ability.origin!=='granted'||o.ability.sourceId!==cue.source?.id||o.ability.round!==state.round||o.ability.phase!==state.phase||o.ability.requiresTrait||!['mill','damage'].includes(outcome.kind))fail('Trench trigger requires the exact current gained ability source');
                if(outcome.kind==='mill'){const defending=entries.find(e=>!e.parent&&e.card.id===a.defenderId),deck=defending?state.players[defending.seat]:undefined;if(g.mill||!defending||!deck?.knownDeck||deck.knownDeck.length!==deck.deck||outcome.seat!==defending.seat||outcome.fromSeat!==defending.seat||outcome.fromZone!=='deck'||outcome.zone!=='discard'||outcome.amount!==Math.min(2,deck.deck)||outcome.cards?.length!==outcome.amount||outcome.cards.some((c,i)=>!exactRef(deck.knownDeck![i],c)))fail('Trench mill must move actual top up-to-two once from defending deck');g.mill=structuredClone(outcome.cards!);}
                else {const m=outcome.millCostDifference;if(!g.mill||g.mill.length!==2||g.selfHit||!m||m.windowId!==g.w.id||JSON.stringify(m.cards)!==JSON.stringify(g.mill)||m.printedCosts.length!==2||m.printedCosts.some((v,i)=>v!==a16VerifiedPrintedFacts(g.mill![i]).cost)||m.difference!==Math.abs(m.printedCosts[0]-m.printedCosts[1])||outcome.damageAttempt?.incoming!==m.difference||outcome.card?.id!==u.card.id||outcome.incarnation!==u.card.incarnation||outcome.unpreventable!==true)fail('Trench self-hit needs actual two milled printed costs and unpreventable difference before combat');g.selfHit=true;}
            }else {if(o.ability.origin!=='native'||JSON.stringify(o.ability)!==JSON.stringify(currentAbilityObjects(u.card)[0])||o.controlsBobaFett!==false||seats.some(side=>state.players[side].leader?.n.startsWith('Boba Fett')||state.players[side].ground.concat(state.players[side].space).some(x=>x.printedTitle==='Boba Fett'||x.u?.some(y=>y.n.split(':')[0]==='Boba Fett')))||outcome.kind!=='damage'||outcome.indirectAllocation?.total!==1)fail('Firespray native trigger needs its actual one-object ability and explicit absent Boba condition');g.indirect=true;}
        }
        if(outcome.discountedVehiclePlay){const w=outcome.discountedVehiclePlay;requireCause(outcome,'JTL_155');const original=before.players[cue.seat].hand.find(x=>x.id===w.cardId),fact=original?a16VerifiedPrintedFacts(original):undefined;let g=vehiclePlays.get(w.cardId);if(!original||!fact||!fact.traits.includes('vehicle')||!fact.types.includes('unit')||w.sourceId!==cue.source?.id||w.discount!==3||w.printedCost!==fact.cost||JSON.stringify(w.aspects)!==JSON.stringify(fact.aspects)||outcome.card?.id!==w.cardId||g&&JSON.stringify(g.w)!==JSON.stringify(w))fail('discounted Vehicle play requires actual own hand unit and verified printed cost/aspects');if(outcome.kind==='cost'){if(g||outcome.amount!==-3||!actualEvent(outcome))fail('Vehicle discount must begin once');g={w:structuredClone(w),step:1};vehiclePlays.set(w.cardId,g);}else if(outcome.kind==='pay'){if(!g||g.step!==1||!exactRef(original,outcome.sourceCard)||outcome.seat!==cue.seat||outcome.amount!==previewGivenCost({printed:fact.cost,aspects:fact.aspects},before,cue.seat,3))fail('Vehicle payment must follow exact discount and actual full aspect price');g.step=2;}else if(outcome.kind==='play'){if(!g||g.step!==2||!actualEvent(outcome)||outcome.fromZone!=='hand'||outcome.fromSeat!==cue.seat||outcome.entryType!=='played'||outcome.entersReady!==false||outcome.unit?.p!==fact.p||outcome.unit.h!==fact.h||outcome.unit.d!==0||outcome.unit.x!==1||outcome.unit.u?.length||outcome.unit.cap?.length||outcome.unit.status?.some(x=>x.duration!=='permanent'))fail('discounted hand Vehicle must be actually paid and normally enter exhausted');g.step=3;}else fail('discounted Vehicle witness belongs only to cost/payment/play');}
        if(outcome.kind==='damage'&&outcome.damageAttempt){const d=outcome.damageAttempt;
            if(!causeEvent(outcome)||!recipient||!present(recipient)||!isUnit(recipient.card)||outcome.incarnation!==recipient.card.incarnation||outcome.damageType!=='ability'||!Number.isSafeInteger(d.incoming)||d.incoming<0||!['none','shield','native-immunity'].includes(d.prevention))fail('damage attempt needs exact current unit, actual cause and nonnegative incoming');
            if(d.prevention==='none'){if(outcome.amount!==d.incoming||outcome.prevented||d.shieldId||!outcome.unpreventable&&d.incoming>0&&(recipient.card.u?.some(u=>u.t&&u.n==='Shield')||recipient.card.s==='SHD_187'&&recipient.seat!==cue.seat))fail('unprevented applied damage contradicts actual incoming, Shield or native immunity');}
            else if(outcome.unpreventable||outcome.amount!==0||outcome.prevented!==true||d.incoming===0)fail('prevented attempt must apply zero, while unpreventable ignores Shield/immunity');
            if(d.prevention==='native-immunity'&&(recipient.card.s!=='SHD_187'||recipient.seat===cue.seat||d.shieldId))fail('native immunity requires actual opposing Phantom');
            if(d.prevention==='shield'){const shield=entries.find(e=>e.parent===recipient.card&&!e.captive&&e.card.id===d.shieldId);if(!shield||shield.card.n!=='Shield'||!('t' in shield.card)||present(shield)||usedShieldPreventions.has(d.shieldId!)||recipient.card.s==='SHD_187'&&recipient.seat!==cue.seat)fail('Shield prevention requires exactly one actual prior removed Shield from this host');usedShieldPreventions.add(d.shieldId!);}
        }
    }
    for (const [index, outcome] of (cue.outcomes ?? []).entries()) {
        if(index===exploitPrefix && !sourcePaid){
            for(const chosen of exploit!.units)if(defeatedIncarnations.get(chosen.id)!==chosen.incarnation||entries.some(e=>arena(e)&&!e.parent&&present(e)&&e.card.id===chosen.id))fail('Exploit discount requires each actual ordinary cost departure');
            paySourceOnce();
        }
        const player = state.players[outcome.seat];
        const unit = find(outcome.card, entry => entry.seat === outcome.seat && arena(entry) && !entry.parent);
        const recipient = outcome.zone === 'base'
            ? find(outcome.card, entry => entry.seat === outcome.seat && entry.zone === 'base') : unit;
        if(outcome.generatedSet&&outcome.restrictionOperation!=='expire'&&outcome.keywordOperation!=='expire'){
            const w=outcome.generatedSet,sentinel=w.mechanic==='sentinel',expected=sentinel?Math.floor(before.players[w.opponentResources?.seat??cue.seat].res.total/2):8;
            if(!actualEvent(outcome)||outcome.prevented||w.sourceId!==cue.source?.id||w.round!==state.round||w.phase!==state.phase||!w.id||w.members.length!==expected||new Set(w.members.map(m=>m.id)).size!==expected||w.members.some(m=>!m.id||!m.incarnation||originalIds.has(m.id)))fail('generated set needs its distinct fresh actual entries and exact source/phase');
            if(sentinel&&(cue.source?.s!=='JTL_130'||!w.opponentResources||w.opponentResources.seat===cue.seat||w.opponentResources.total!==before.players[w.opponentResources.seat].res.total||before.players[w.opponentResources.seat].resources?.length!==w.opponentResources.total||outcome.seat!==cue.seat||outcome.restriction||outcome.restrictionOperation))fail('generated Sentinel requires actual opposing total-resource census and no Scramble restriction');
            if(!sentinel&&(w.mechanic&&w.mechanic!=='base-restriction'||w.opponentResources||outcome.keywordOperation))fail('Scramble generated restriction cannot mix with Sentinel resource origin');
            let g=generatedGroups.get(w.id);if(g&&JSON.stringify(g.w)!==JSON.stringify(w))fail('generated set changed');if(!g){g={w:structuredClone(w),created:new Set(),restricted:new Set()};generatedGroups.set(w.id,g);}
            const m=w.members.find(m=>m.id===outcome.card?.id&&m.incarnation===outcome.incarnation);if(!m)fail('receipt subject is outside exact generated entries');
            if(outcome.kind==='create'){if(outcome.tokenType!==(sentinel?'x-wing':'tie-fighter')||g.created.has(m.id))fail('generated entries require one exact fresh token creation each');g.created.add(m.id);}
            else if(sentinel&&outcome.kind==='keyword'){if(!g.created.has(m.id)||g.restricted.has(m.id)||!unit||!present(unit)||!isUnit(unit.card)||unit.card.incarnation!==m.incarnation||outcome.keyword?.name!=='Sentinel'||outcome.keyword.amount!==1||outcome.keywordOperation!=='gain'||outcome.duration!=='phase'||outcome.round!==state.round)fail('generated Sentinel needs this actually created continuing entry once');g.restricted.add(m.id);}
            else if(!sentinel&&outcome.kind==='restrict'){if(!g.created.has(m.id)||g.restricted.has(m.id)||!unit||!present(unit)||!isUnit(unit.card)||unit.card.incarnation!==m.incarnation||outcome.seat!==cue.seat||outcome.restriction!=='cannot-attack-base'||outcome.restrictionOperation!=='grant'||outcome.duration!=='phase'||outcome.round!==state.round)fail('base restriction needs this same actually generated continuing entry once');g.restricted.add(m.id);}
            else fail('generated entry witness belongs only to its exact creation and bound effect');
        }
        validateA16Outcome(outcome,unit,recipient);
        if(outcome.distinctTitleBoost&&outcome.phaseStatsOperation!=='expire'){
            const w=outcome.distinctTitleBoost,all=state.players[cue.seat].ground.concat(state.players[cue.seat].space),titles=[...new Set(all.map(u=>u.printedTitle))];
            if(!actualEvent(outcome)||outcome.prevented||outcome.kind!=='buff'||outcome.seat!==cue.seat||outcome.duration!=='phase'||outcome.phaseStatsOperation!=='grant'||w.sourceId!==cue.source?.id||w.round!==state.round||w.phase!==state.phase||outcome.round!==state.round||!unit||!present(unit)||!isUnit(unit.card)||outcome.incarnation!==unit.card.incarnation||unit.card.n!==outcome.card?.n||unit.card.s!==outcome.card?.s||outcome.amount!==`+${w.amount}/+${w.amount}`)fail('distinct-title boost needs exact actual friendly entry/source/phase/amount');
            let g=titleGroups.get(w.id);if(g&&JSON.stringify(g.w)!==JSON.stringify(w))fail('fixed title census changed');if(!g){if(all.some(u=>!u.printedTitle)||w.members.length!==all.length||new Set(w.members.map(m=>m.id)).size!==all.length||w.members.some(m=>!all.some(u=>u.id===m.id&&u.incarnation===m.incarnation&&u.printedTitle===m.title))||w.titles.length!==titles.length||new Set(w.titles).size!==w.titles.length||w.titles.some(t=>!titles.includes(t))||w.amount!==titles.length)fail('title census must seal complete friendly printed-title set and fixed distinct count');g={w:structuredClone(w),assigned:new Set()};titleGroups.set(w.id,g);}
            if(g.assigned.has(unit.card.id!)||!w.members.some(m=>m.id===unit.card.id&&m.incarnation===(unit.card as UnitRef).incarnation))fail('each sealed title member receives one boost');g.assigned.add(unit.card.id!);
        }
        if(outcome.unupgradedSet){const w=outcome.unupgradedSet,all=seats.flatMap(side=>before.players[side].ground.concat(before.players[side].space)).filter(u=>!u.u?.length);
            if(outcome.kind!=='defeat'||!actualEvent(outcome)||w.sourceId!==cue.source?.id||w.round!==state.round||w.phase!==state.phase||w.members.length!==all.length||new Set(w.members.map(m=>m.id)).size!==all.length||w.members.some(m=>!all.some(u=>u.id===m.id&&u.incarnation===m.incarnation))||!unit||!present(unit)||!isUnit(unit.card)||outcome.incarnation!==unit.card.incarnation||unit.card.u?.length||unit.card.n!==outcome.card?.n||unit.card.s!==outcome.card?.s)fail('unupgraded census requires complete current set and exact actual defeat attempts');
            const g=nebulaGroups.get(w.id)??{w:structuredClone(w),attempted:new Set<string>()};if(JSON.stringify(g.w)!==JSON.stringify(w)||g.attempted.has(unit.card.id!))fail('unupgraded set attempts must stay fixed and occur once');g.attempted.add(unit.card.id!);nebulaGroups.set(w.id,g);
        }
        if(outcome.spaceExhaustion){const w=outcome.spaceExhaustion,original=before.players[cue.seat].space;
            if(w.sourceId!==cue.source?.id||w.round!==state.round||w.phase!==state.phase||w.members.length>2||new Set(w.members.map(m=>m.id)).size!==w.members.length||w.members.some(m=>!original.some(u=>u.id===m.id&&u.incarnation===m.incarnation))||!actualEvent(outcome))fail('space exhaustion selection requires at most two actual distinct friendly space entries and source/phase');
            const g=wingsGroups.get(w.id)??{w:structuredClone(w),attempted:new Set<string>(),created:new Set<string>()};if(JSON.stringify(g.w)!==JSON.stringify(w))fail('space exhaustion selection changed');wingsGroups.set(w.id,g);
            if(outcome.kind==='exhaust'){if(!unit||!present(unit)||!isUnit(unit.card)||unit.zone!=='space'||unit.seat!==cue.seat||outcome.incarnation!==unit.card.incarnation||!w.members.some(m=>m.id===unit.card.id&&m.incarnation===(unit.card as UnitRef).incarnation)||g.attempted.has(unit.card.id!)||outcome.amount!==(unit.card.x?0:1))fail('space exhaustion attempt must name each exact selected entry and actual pose change once');g.attempted.add(unit.card.id!);}
            else if(outcome.kind==='create'){const e=outcome.requiresExhaust;if(!e||!w.members.some(m=>m.id===e.id&&m.incarnation===e.incarnation)||g.created.has(e.id)||outcome.tokenType!=='x-wing')fail('each created X-Wing needs one distinct actual selected successful exhaustion');g.created.add(e.id);}
            else fail('space exhaustion witness only permits exhaustion and its creation');
        }
        if(outcome.spaceCensus){const w=outcome.spaceCensus,match=(side:Seat,m:{id:string;incarnation:string}[])=>{const a=state.players[side].space;return m.length===a.length&&new Set(m.map(x=>x.id)).size===a.length&&m.every(x=>a.some(u=>u.id===x.id&&u.incarnation===x.incarnation));};
            if(!actualEvent(outcome)||w.sourceId!==cue.source?.id||w.round!==state.round||w.phase!==state.phase||w.player!==cue.seat||w.opponent===cue.seat||!match(w.player,w.own)||!match(w.opponent,w.other)||w.own.length<=w.other.length||outcome.seat!==w.opponent||!unit||!present(unit)||!isUnit(unit.card)||unit.zone!=='ground'||outcome.incarnation!==unit.card.incarnation||outcome.kind==='damage'&&(outcome.amount!==4||outcome.damageType!=='ability')||!['damage','defeat'].includes(outcome.kind))fail('space superiority needs complete actual strict controller census and opposing ground ability hit');
        }
        if(outcome.requiresAttack){const w=outcome.requiresAttack,a=attacks.get(w.attackId),e=entries.find(e=>arena(e)&&!e.parent&&e.card.id===w.attackerId);
            if(!a||!a.combatStarted||a.attackerId!==w.attackerId||a.incarnation!==w.incarnation||!e||!isUnit(e.card)||!e.card.x||e.zone!==w.arena||a.attackingSeat!==cue.seat||outcome.sequenceIndex!==2||!outcome.attackId||outcome.attackId===w.attackId)fail('second attack requires its actual prior space attack, even if first attacker departed');
        }
        if(outcome.baseProtection&&outcome.baseProtection.operation==='consume'&&(outcome.kind!=='damage'||outcome.zone!=='base'||!recipient||recipient.card!==player.base))fail('base protection consume needs its actual selected base damage route');
        if(outcome.woundBoost){const w=outcome.woundBoost;
            if(outcome.kind!=='buff'||outcome.prevented||!actualEvent(outcome)||!unit||!present(unit)||!isUnit(unit.card)||unit.card.id!==w.subjectId||unit.card.incarnation!==w.incarnation||outcome.incarnation!==w.incarnation||w.wounds!==unit.card.d||!Number.isSafeInteger(w.wounds)||w.wounds<0||outcome.amount!==`+${w.wounds}/+0`||outcome.duration!=='phase'||outcome.round!==state.round)fail('fixed wound boost needs actual current wounds, exact entry, event and phase amount');
        }
        if(outcome.spaceClearance&&outcome.kind!=='defeat'){
            const w=outcome.spaceClearance,seal=clearances.get(w.id);
            if(outcome.kind!=='buff'||outcome.prevented||!actualEvent(outcome)||!seal||JSON.stringify(seal.w)!==JSON.stringify(w)||seal.used||outcome.requiresDefeat?.id!==w.defeatedId||outcome.requiresDefeat?.incarnation!==w.incarnation||defeatedIncarnations.get(w.defeatedId)!==w.incarnation||!unit||!present(unit)||!isUnit(unit.card)||unit.card.n!==outcome.card?.n||unit.card.s!==outcome.card?.s||outcome.incarnation!==unit.card.incarnation||outcome.amount!=='+1/+1'||outcome.duration!=='token'||outcome.label!=='1 EXPERIENCE'||outcome.cards?.length!==1||outcome.cards[0].owner!==outcome.seat)fail('Experience requires its actual one-use moment of successful space clearance');seal.used=true;
        }
        if(outcome.keywordWindow&&outcome.keywordOperation!=='expire'){
            const w=outcome.keywordWindow,all=seats.flatMap(side=>state.players[side].ground.concat(state.players[side].space));
            if(outcome.kind!=='keyword'||outcome.prevented||!actualEvent(outcome)||w.sourceId!==cue.source?.id||!w.id||w.round!==state.round||w.phase!==state.phase||outcome.round!==state.round||outcome.duration!=='phase'||!unit||!present(unit)||!isUnit(unit.card)||outcome.incarnation!==unit.card.incarnation||unit.card.n!==outcome.card?.n||unit.card.s!==outcome.card?.s||outcome.keyword?.amount!==1||!['gain','lose'].includes(outcome.keywordOperation??''))fail('keyword window needs actual causing event, current entry, gain/loss and phase');
            let g=keywordWindows.get(w.id);
            if(!g){if(w.members.length!==all.length||new Set(w.members.map(m=>m.id)).size!==all.length||w.members.some(m=>typeof m.nativeSentinel!=='boolean'||!all.some(u=>u.id===m.id&&u.incarnation===m.incarnation&&(!m.nativeSentinel||u.sn===1))))fail('keyword window must seal every current arena entry exactly once');g={w:structuredClone(w),gained:new Set(),lost:new Set()};keywordWindows.set(w.id,g);}
            else if(JSON.stringify(g.w)!==JSON.stringify(w))fail('keyword window membership changed');
            const member=w.members.find(m=>m.id===unit!.card.id&&m.incarnation===(unit!.card as UnitRef).incarnation),set=outcome.keywordOperation==='gain'?g.gained:g.lost;
            if(!member||set.has(member.id)||outcome.keyword?.name!==(outcome.keywordOperation==='gain'?'Sentinel':'Saboteur'))fail('keyword window requires exactly one Sentinel gain and one Saboteur loss per entry');set.add(member.id);
        }
        if(outcome.kind==='keyword'&&outcome.keyword?.name==='Saboteur'&&outcome.keywordOperation!=='lose'&&unit&&isUnit(unit.card)&&unit.card.status?.some(x=>x.lostKeyword==='Saboteur'&&x.duration==='phase'&&x.round===state.round&&x.phase===state.phase&&x.incarnation===(unit.card as UnitRef).incarnation)){
            if(outcome.prevented)continue;fail('active current-entry Saboteur loss blocks a new gain');
        }
        if(outcome.choice?.kind==='opponent-random-discard'){
            const c=outcome.choice;
            if(!actualEvent(outcome)||c.chooserSeat===cue.seat||c.handSeat!==c.chooserSeat||!['discard','decline'].includes(c.decision)||!['discarded','not-discarded'].includes(c.result)||c.decision==='decline'&&(c.result!=='not-discarded'||c.selectedId)||c.result==='discarded'&&(!c.selectedId||c.decision!=='discard'))fail('random discard mode must preserve actual opponent decision and actual outcome');
            if(randomDiscardBranch){if(JSON.stringify(randomDiscardBranch.choice)!==JSON.stringify(c))fail('random discard mode changed between receipts');}else randomDiscardBranch={choice:structuredClone(c),attempted:false,discarded:false,created:0};
            if(outcome.kind==='discard'){
                if(outcome.fromZone!=='hand'||outcome.fromSeat!==c.handSeat||outcome.seat!==c.handSeat||outcome.selection!=='random'||outcome.chooserSeat!==undefined||c.selectedId!==outcome.card?.id||randomDiscardBranch.discarded||c.result==='not-discarded'&&!outcome.prevented)fail('random discard must use supplied actual hand result, not player card selection');
                const attempt=find(outcome.card,e=>!e.parent&&e.zone==='hand'&&e.seat===c.handSeat&&present(e));if(!attempt||attempt.card.n!==outcome.card?.n||attempt.card.s!==outcome.card?.s)fail('random discard attempt must be an actual current opponent hand card');randomDiscardBranch.attempted=true;
            }else if(outcome.kind==='create'){
                if(c.decision==='discard'&&before.players[c.handSeat].hand.length&&!randomDiscardBranch.attempted)fail('non-discard after chosen random discard needs an actual failed attempt or empty hand');
                if(c.result!=='not-discarded'||outcome.seat!==cue.seat||outcome.tokenType!=='battle-droid')fail('two own Droids require an actual non-discard result');randomDiscardBranch.created++;
            }else fail('random discard mode is attached to unsupported receipt');
        }
        if(outcome.requiresDiscard){const x=outcome.requiresDiscard,prior=successfulHandDiscards.get(x.id);
            if(outcome.kind==='inspect'&&outcome.prevented||!['inspect','discard'].includes(outcome.kind)||!actualEvent(outcome)||x.seat!==cue.seat||!prior||prior.seat!==x.seat||prior.sourceId!==cue.source?.id||!prior.owner||prior.destination!==prior.owner)fail('private hand clause requires its actual successful own-hand discard by this source');
        }
        if(outcome.singleUnitPlay){const w=outcome.singleUnitPlay,id=outcome.card?.id,current=[...state.players[w.player].ground,...state.players[w.player].space],one=current[0],selected=state.players[w.player].hand.find(c=>c.id===id),prior=id?singlePlays.get(id):undefined;
            if(outcome.prevented||!id||!['cost','pay','play'].includes(outcome.kind)||w.player!==cue.seat||current.length!==1||!one||one.id!==w.unitId||one.incarnation!==w.incarnation||!one.traits?.includes(w.sharedTrait)||!selected||selected.id===cue.source?.id||selected.n!==outcome.card?.n||selected.s!==outcome.card?.s||selected.owner!==w.player||outcome.seat!==w.player)fail('discounted hand play requires exact sole controlled entry, current trait and actual own hand card');
            if(prior&&JSON.stringify(prior)!==JSON.stringify(w))fail('sole-unit witness changed during nested play');
            if(outcome.kind==='cost'){if(prior||!actualEvent(outcome)||outcome.amount!==-5)fail('sole-unit play must begin with actual five-resource discount');singlePlays.set(id,structuredClone(w));}
            else if(!prior)fail('nested unit payment/play requires its prior sole-unit discount');
            const expectedPrice=previewGivenCost({printed:w.printedCost,aspects:w.aspects},state,w.player,5);
            if(outcome.kind==='pay'&&(outcome.amount!==expectedPrice||outcome.sourceCard?.id!==id||outcome.sourceCard?.n!==selected.n||outcome.sourceCard?.s!==selected.s)||outcome.kind==='play'&&(paidUnits.get(id)!==expectedPrice||outcome.printedCost!==w.printedCost))fail('sole-unit nested payment must match its explicit printed price, aspect penalties and five-resource discount');
            if(outcome.kind==='play'&&(!actualEvent(outcome)||outcome.fromZone!=='hand'||outcome.fromSeat!==w.player||!outcome.unit?.traits?.includes(w.sharedTrait)||outcome.unit.traits.includes('vehicle')||outcome.entryType!=='played'||outcome.entersReady!==false||outcome.unit.d!==0||outcome.unit.u?.length||outcome.unit.cap?.length||outcome.unit.status?.some(x=>x.duration!=='permanent')))fail('discounted shared-trait unit needs known non-Vehicle clean normal played entry');
        }
        if(outcome.captureSelection){const w=outcome.captureSelection,prior=captureSelections.get(w.id);
            if(!['capture','create'].includes(outcome.kind)||w.sourceId!==cue.source?.id||!w.id||!Number.isSafeInteger(w.captor.printedCost)||!Number.isSafeInteger(w.target.printedCost)||w.captor.printedCost<0||w.target.printedCost<0)fail('capture selection needs actual source and known nonnegative printed costs');
            if(outcome.kind==='capture'){
                const a=find(outcome.sourceCard,e=>arena(e)&&!e.parent&&present(e)&&e.seat===cue.seat),b=find(outcome.card,e=>arena(e)&&!e.parent&&present(e)&&e.seat!==cue.seat);
                if(prior||!a||!b||!isUnit(a.card)||!isUnit(b.card)||a.card.id!==w.captor.id||a.card.incarnation!==w.captor.incarnation||b.card.id!==w.target.id||b.card.incarnation!==w.target.incarnation||b.card.n!==outcome.card?.n||b.card.s!==outcome.card?.s||b.card.owner!==outcome.card?.owner||a.card.n!==outcome.sourceCard?.n||a.card.s!==outcome.sourceCard?.s||a.card.owner!==outcome.sourceCard?.owner||b.card.leaderUnit!==false||!b.card.traits||b.card.traits.includes('vehicle'))fail('capture selection requires actual friendly captor and enemy nonleader non-Vehicle entry');
                captureSelections.set(w.id,structuredClone(w));
            }else{
                const a=entries.find(e=>arena(e)&&!e.parent&&present(e)&&isUnit(e.card)&&e.card.id===w.captor.id&&e.card.incarnation===w.captor.incarnation);
                if(!prior||JSON.stringify(prior)!==JSON.stringify(w)||!a||outcome.seat!==a.seat||!actualEvent(outcome)||w.target.printedCost>=w.captor.printedCost||outcome.tokenType!=='battle-droid')fail('conditional Droids require actual lower printed selected cost and current captor controller, not assumed capture success');
            }
        }
        if(outcome.damageDefeatOrigin){const o=outcome.damageDefeatOrigin,key=defeatKey(o.subjectId,o.incarnation),hit=causalHits.get(key),seal=defeatedAbilitySeals.get(key);
            if(outcome.kind!=='create'||!actualEvent(outcome)||!outcome.requiresDefeat||outcome.requiresDefeat.id!==o.subjectId||outcome.requiresDefeat.incarnation!==o.incarnation||defeatedIncarnations.get(o.subjectId)!==o.incarnation||!seal||!hit||!hit.lethal||hit.sourceId!==o.sourceId||hit.amount!==o.amount||o.sourceId!==cue.source?.id||o.controller!==seal.controller||outcome.seat!==seal.controller||outcome.tokenType!=='clone-trooper'||clonedDefeats.has(key))fail('causal Clone requires actual exact-source lethal hit, successful defeat and its controller once');clonedDefeats.add(key);
        }
        if(outcome.traitGrant){const w=outcome.traitGrant,all=seats.flatMap(side=>before.players[side].ground.concat(before.players[side].space).map(u=>({u,side}))),eligible=all.filter(e=>(w.scope==='up-to-one-any'||e.side===cue.seat)&&e.u.traits?.includes(w.trait));
            if(outcome.prevented||!actualEvent(outcome)||!['buff','keyword'].includes(outcome.kind)||outcome.duration!=='phase'||!['republic','separatist','trooper','jedi'].includes(w.trait)||!['up-to-one-any','all-friendly'].includes(w.scope)||new Set(w.members.map(m=>m.id)).size!==w.members.length||w.members.some(m=>!eligible.some(e=>e.u.id===m.id&&e.u.incarnation===m.incarnation))||w.scope==='up-to-one-any'&&w.members.length>1||w.scope==='all-friendly'&&w.members.length!==eligible.length||!unit||!present(unit)||!isUnit(unit.card)||unit.card.incarnation!==outcome.incarnation||unit.card.n!==outcome.card?.n||unit.card.s!==outcome.card?.s||unit.card.owner!==outcome.card?.owner||!w.members.some(m=>m.id===unit.card.id&&m.incarnation===(unit.card as UnitRef).incarnation))fail('phase trait grant requires actual role membership/current entries and complete friendly or up-to-one set');
            const prior=traitGrants.get(w.id);if(prior&&JSON.stringify(prior.w)!==JSON.stringify(w))fail('trait role changed during grants');const g=prior??{w:structuredClone(w),buff:new Set<string>(),keyword:new Set<string>()};traitGrants.set(w.id,g);const seen=outcome.kind==='buff'?g.buff:g.keyword;
            if(seen.has(unit.card.id!))fail('a role cannot grant the same entry twice');seen.add(unit.card.id!);
            if(outcome.kind==='buff'&&(w.scope!=='up-to-one-any'||!['republic','separatist'].includes(w.trait)||outcome.amount!=='+2/+2')||outcome.kind==='keyword'&&(outcome.keyword?.amount!==1||outcome.keyword.name!==(w.scope==='up-to-one-any'?'Saboteur':w.trait==='trooper'?'Raid':'Sentinel')))fail('trait role must retain its concrete stats or keyword effect');
        }
        if (outcome.choice?.kind === 'controller-response') {
            const choice = outcome.choice, subject = find(choice.subject, entry => arena(entry) && !entry.parent && present(entry));
            if (!subject || subject.seat !== choice.controller || outcome.chooserSeat !== choice.controller
                || choice.decision === 'no' && (outcome.kind !== 'draw' || outcome.seat !== cue.seat)
                || choice.decision === 'damage' && (outcome.kind !== 'damage' || !outcome.card || !same(choice.subject, outcome.card))) fail('controller-response receipt contradicts actual target controller or selected branch');
        }
        if(outcome.requiresReturn){const x=outcome.requiresReturn,prior=returnedUnits.get(x.id);
            if(!prior||prior.incarnation!==x.incarnation||prior.ownerSeat!==x.ownerSeat)fail('conditional result requires actual prior owner-hand return of this exact entry');}
        if(outcome.choice?.kind==='opponent-mode'){const c=outcome.choice;
            if(c.actor!==cue.seat||c.chooser===c.actor||outcome.seat!==c.actor||outcome.kind!=='ready'
                ||c.decision==='resources'&&outcome.zone!=='resources'||c.decision==='unit'&&(outcome.zone==='resources'||outcome.chooserSeat!==c.actor))fail('opponent mode chooser and acting unit/resource player must remain distinct');}
        if(outcome.choice?.kind==='controller-unless'){const c=outcome.choice,t=find(c.subject,e=>arena(e)&&!e.parent&&present(e));
            if(!t||t.seat!==c.controller||outcome.seat!==c.controller||outcome.chooserSeat!==c.controller||c.amount!==2
                ||c.decision==='pay'&&(outcome.kind!=='pay'||count(outcome.amount)!==2)
                ||c.decision==='exhaust'&&(outcome.kind!=='exhaust'||!outcome.card||!same(t.card,outcome.card)))fail('unless choice requires actual target controller, exact payment or exhaustion branch');}
        if(outcome.choice?.kind==='owner-replay'){const c=outcome.choice;
            if(outcome.kind==='return'){const t=find(outcome.card,e=>arena(e)&&!e.parent&&present(e));if(!t||!isUnit(t.card)||t.card.id!==c.subjectId||t.card.incarnation!==c.returnedIncarnation||t.card.owner!==c.owner)fail('owner replay choice must identify actual returned unit owner and old entry');}
            else if(outcome.kind==='play'&&(c.decision!=='play-free'||outcome.seat!==c.owner||outcome.card?.id!==c.subjectId||!outcome.requiresReturn
                ||outcome.requiresReturn.incarnation!==c.returnedIncarnation||!paidUnits.has(c.subjectId)||paidUnits.get(c.subjectId)!==0))fail('owner free replay requires actual owner choice, prior return and explicit zero payment');}
        if(outcome.condition?.kind==='initiative'){const c=outcome.condition;if(outcome.kind!=='buff'||c.player!==cue.seat||state.initiative!==c.initiative||c.initiative!==cue.seat)fail('initiative bonus requires actual event-controller initiative');}
        if(outcome.condition?.kind==='resources-more'){const c=outcome.condition;if(c.kind!=='resources-more'||state.players[c.player].res.total!==c.total||state.players[c.than].res.total!==c.thanTotal
            ||c.total<=c.thanTotal||outcome.kind!=='discard'||outcome.seat!==c.player||outcome.chooserSeat!==c.player)fail('conditional discard requires actual strictly greater total resources and selected-player choice');}
        if(outcome.playerChoice && (outcome.kind!=='discard'||outcome.playerChoice.chooserSeat!==cue.seat||outcome.playerChoice.selectedSeat!==outcome.seat
            ||outcome.chooserSeat!==outcome.seat||outcome.fromZone!=='hand'))fail('player choice and selected-player hand choice must remain distinct');
        if((outcome.defenderDamageAtStart||outcome.gritBasis)&&(!unit||!present(unit)||!isUnit(unit.card)||unit.zone!==outcome.zone||outcome.prevented))fail('starting-wound or Grit witness requires an actual unprevented current arena receipt');
        if(outcome.unitDefeatCount&&outcome.kind!=='search'||outcome.defeatedEntry&&!['cost','play'].includes(outcome.kind)||outcome.sameNameGroup&&outcome.kind!=='return'||outcome.requiresExhaust&&outcome.kind!=='exhaust'&&!(outcome.kind==='create'&&outcome.spaceExhaustion)||outcome.phasePlayPermission&&outcome.kind!=='cost'||outcome.phasePermissionId&&!['cost','pay','play'].includes(outcome.kind))fail('history, title, exhaustion and permission witnesses must retain their concrete receipt kind');
        if(outcome.unitDefeatCount){const b=outcome.unitDefeatCount,h=state.defeatedThisPhase;
            if(!h||b.round!==state.round||b.phase!==state.phase||h.round!==b.round||h.phase!==b.phase||h.cards.some(c=>c.lastKnownType===undefined||c.lastKnownType==='token')||!actualEvent(outcome)||outcome.deckOperation?.scope!=='top'||outcome.deckOperation.visibility!=='private'||outcome.deckOperation.revealedIds?.length)fail('unit-defeat look needs current typed complete phase history and private deck evidence');
            const units=h.cards.filter(c=>['unit','leader-unit','token-unit'].includes(c.lastKnownType??'')),keys=units.map(c=>`${c.id}:${c.incarnation}`);
            if(units.some(c=>!c.incarnation)||new Set(keys).size!==keys.length||b.units.length!==units.length||new Set(b.units.map(c=>`${c.id}:${c.incarnation}`)).size!==b.units.length||b.units.some(c=>!keys.includes(`${c.id}:${c.incarnation}`))||outcome.amount!==Math.min(units.length,player.deck)||outcome.deckOperation!.looked.length!==outcome.amount||outcome.deckOperation!.selectionLimit!==1)fail('unit-defeat count must include every exact unit entry once, exclude upgrades and clamp only actual deck length');
        }
        if(outcome.defeatedEntry){const b=outcome.defeatedEntry,h=state.defeatedThisPhase,phase=outcome.defeatPhase,selected=player.discard.find(c=>c.id===b.id);
            if(!selected||outcome.card?.id!==b.id||selected.n!==outcome.card.n||selected.s!==outcome.card.s||selected.owner!==outcome.seat||outcome.seat!==cue.seat||!actualEvent(outcome)||!h||!phase||h.round!==state.round||h.phase!==state.phase||phase.round!==h.round||phase.phase!==h.phase||state.mostRecentIncarnations?.[b.id]!==b.incarnation||!h.cards.some(c=>c.id===b.id&&c.incarnation===b.incarnation&&['unit','leader-unit'].includes(c.lastKnownType??'')))fail('discard replay requires own actual card and most-recent current-phase defeated entry');
            if(outcome.kind==='cost'&&outcome.amount!==-2||outcome.kind==='play'&&(outcome.fromZone!=='discard'||outcome.fromSeat!==cue.seat||!outcome.unit||!outcome.unit.incarnation||outcome.unit.incarnation===b.incarnation||outcome.unit.x!==undefined||outcome.unit.d!==0||outcome.unit.u?.length||outcome.unit.cap?.length||outcome.unit.status?.some(s=>s.duration!=='permanent')||outcome.entersReady!==true||outcome.entryType!=='played'))fail('discounted corpse replay needs exact discount and a fresh clean ready played entry');
        }
        if(outcome.sameNameGroup){const w=outcome.sameNameGroup,prior=nameGroups.get(w.id),member=find(outcome.card,e=>!e.parent&&arena(e)&&present(e)&&e.seat===outcome.fromSeat);
            if(!w.id||!w.title||!Number.isSafeInteger(w.selectedPrintedCost)||w.selectedPrintedCost<0||w.selectedPrintedCost>3||!actualEvent(outcome)||outcome.prevented||!member||!present(member)||!isUnit(member.card)||outcome.incarnation!==member.card.incarnation||member.card.printedTitle!==w.title||member.card.leaderUnit!==false||outcome.fromSeat!==member.seat||outcome.fromZone!==member.zone||outcome.zone!=='hand'||outcome.destination&&outcome.destination!=='hand'||prior&&JSON.stringify(prior.witness)!==JSON.stringify(w))fail('same-title return needs exact current nonleader group, selected cost and owner-hand route');
            if(!prior){const selected=entries.find(e=>!e.parent&&arena(e)&&present(e)&&isUnit(e.card)&&e.card.id===w.selectedId&&e.card.incarnation===w.selectedIncarnation);
                const enemyEntries=entries.filter(e=>!e.parent&&arena(e)&&present(e)&&e.seat!==cue.seat&&isUnit(e.card));
                if(!selected||!isUnit(selected.card)||selected.card.leaderUnit!==false||selected.card.printedTitle!==w.title||enemyEntries.some(e=>(e.card as UnitRef).printedTitle===undefined||(e.card as UnitRef).leaderUnit===undefined))fail('same-title group requires known selected/current enemy title and leader facts');
                const actual=enemyEntries.filter(e=>(e.card as UnitRef).leaderUnit===false&&(e.card as UnitRef).printedTitle===w.title);if(selected!.seat===cue.seat)actual.push(selected!);
                if(w.members.length!==actual.length||new Set(w.members.map(m=>m.id)).size!==w.members.length||w.members.some(m=>!actual.some(e=>e.card.id===m.id&&(e.card as UnitRef).incarnation===m.incarnation)))fail('same-title group must include only selected plus every enemy title match, regardless of other costs or subtitles');
                nameGroups.set(w.id,{witness:structuredClone(w),returned:new Set()});
            }
            const g=nameGroups.get(w.id)!;if(!w.members.some(m=>m.id===member!.card.id&&m.incarnation===(member!.card as UnitRef).incarnation)||g.returned.has(member!.card.id!))fail('same-title member must return once');g.returned.add(member!.card.id!);
        }
        if(outcome.requiresExhaust&&outcome.kind==='create'){const b=outcome.requiresExhaust,e=successfulExhaustions.get(b.id);if(!outcome.spaceExhaustion||!e||e.incarnation!==b.incarnation||e.controller!==cue.seat||e.sourceId!==cue.source?.id||outcome.seat!==cue.seat||!actualEvent(outcome))fail('X-Wing creation requires exact successful same-source friendly space exhaustion');}
        if(outcome.requiresExhaust&&outcome.kind!=='create'){const b=outcome.requiresExhaust,x=successfulExhaustions.get(b.id);
            if(!x||x.incarnation!==b.incarnation||x.controller!==cue.seat||x.sourceId!==cue.source?.id||!actualEvent(outcome)||outcome.seat===cue.seat||!unit||!present(unit)||!isUnit(unit.card)||unit.card.id===b.id||outcome.incarnation!==unit.card.incarnation)fail('enemy exhaustion requires exact actual successful friendly exhaustion by the same event');
        }
        if(outcome.phasePlayPermission){const p=outcome.phasePlayPermission,card=player.discard.find(c=>c.id===p.cardId),allowed=['vigilance','command','aggression','cunning','heroism','villainy'];
            if(outcome.prevented||!actualEvent(outcome)||p.sourceId!==cue.source?.id||!p.id||p.player!==cue.seat||p.player!==outcome.seat||p.round!==state.round||p.phase!==state.phase||p.fromZone!=='discard'||p.discount!==2||!['event','upgrade'].includes(p.cardType)||!p.aspects.includes('heroism')||p.aspects.some(a=>!allowed.includes(a))||outcome.amount!==-2||outcome.duration!=='phase'||outcome.zone!=='discard'||outcome.fromZone!=='discard'||!card||card.owner!==p.player||!discardedDeckIds.has(p.cardId)||card.id!==outcome.card?.id||card.n!==outcome.card?.n||card.s!==outcome.card?.s||state.discardPlayPermissions?.some(x=>x.id===p.id||x.cardId===p.cardId))fail('phase discard permission requires actual selected own deck discard, Heroism nonunit facts, current phase and exact causing event');
            (state.discardPlayPermissions??=[]).push(structuredClone(p));
        }
        if(outcome.phasePermissionId){const p=state.discardPlayPermissions?.find(p=>p.id===outcome.phasePermissionId),actual=p?player.discard.find(c=>c.id===p.cardId):undefined;
            if(!p||p.round!==state.round||p.phase!==state.phase||p.player!==cue.seat||p.player!==outcome.seat||p.sourceId!==cue.source?.id||!actual||actual.owner!==p.player||actual.id!==outcome.card?.id||actual.n!==outcome.card?.n||actual.s!==outcome.card?.s||outcome.kind!=='pay'&&!actualEvent(outcome))fail('later play needs the exact still-current phase permission and actual discard card');
            if(outcome.kind==='cost'&&outcome.amount!==-2)fail('phase permission discount must remain exactly two');
            if(outcome.kind==='play'){
                if(p!.cardType!=='upgrade'||outcome.playAs!=='upgrade'||outcome.fromZone!=='discard'||outcome.fromSeat!==p!.player||outcome.printedCost===undefined||paidPlayers.get(p!.cardId)!==p!.player||paidUnits.get(p!.cardId)!==previewGivenCost({printed:outcome.printedCost!,aspects:p!.aspects as PreviewAspect[]},state,p!.player,p!.discount))fail('permitted upgrade play requires actual discounted cost/aspects, payer and discard origin');
            }
        }
        if(outcome.sharedTrait&&outcome.kind!=='buff'||outcome.defenderDamageAtStart&&outcome.kind!=='buff'||outcome.gritBasis&&!['buff','keyword'].includes(outcome.kind)||outcome.powerWindow&&outcome.kind!=='damage')fail('trait, starting-wound, Grit and power-window witnesses must retain their concrete receipt kind');
        if(outcome.sharedTrait){const w=outcome.sharedTrait,prior=sharedTraits.get(w.id),ids=w.units.map(u=>u.id);
            if(outcome.prevented||!w.id||!w.trait||!ids.length||ids.length>3||new Set(ids).size!==ids.length||!unit||!present(unit)||!isUnit(unit.card)||outcome.duration!=='phase'||outcome.amount!=='+2/+0'||!actualEvent(outcome)||outcome.incarnation!==unit.card.incarnation||outcome.zone!==unit.zone||!w.units.some(u=>u.id===unit.card.id&&u.incarnation===(unit.card as UnitRef).incarnation)||prior&&(JSON.stringify(prior.witness)!==JSON.stringify(w)||prior.assigned.has(unit.card.id!)))fail('shared trait requires one fixed distinct group of up to three current entries and exact phase power receipts');
            if(!prior){for(const member of w.units){const e=entries.find(e=>!e.parent&&arena(e)&&present(e)&&isUnit(e.card)&&e.card.id===member.id&&e.card.incarnation===member.incarnation);if(!e||!isUnit(e.card)||!e.card.traits?.includes(w.trait))fail('one actual current trait must intersect the entire selected group');}sharedTraits.set(w.id,{witness:structuredClone(w),assigned:new Set()});}
            sharedTraits.get(w.id)!.assigned.add(unit!.card.id!);
        }
        if(outcome.powerWindow){const w=outcome.powerWindow,prior=powerWindows.get(w.id);
            if(outcome.prevented||!w.id||w.members.length!==2||new Set(w.members.map(m=>m.id)).size!==2||outcome.resolutionGroup?.id!==w.id||outcome.resolutionGroup.mode!=='simultaneous'||outcome.damageType!=='ability'||outcome.attackId||!recipient||!present(recipient)||!isUnit(recipient.card)||outcome.incarnation!==recipient.card.incarnation||outcome.basis?.kind!=='source-power'||prior&&JSON.stringify(prior.witness)!==JSON.stringify(w))fail('reciprocal power window requires two fixed current entries and simultaneous ability receipts');
            if(!prior){const selected=w.members.map(m=>entries.find(e=>!e.parent&&arena(e)&&present(e)&&isUnit(e.card)&&e.card.id===m.id&&e.card.incarnation===m.incarnation));
                if(selected.some((e,i)=>!e||!isUnit(e.card)||e.seat===cue.seat||e.seat!==w.members[i].controller||e.card.p!==w.members[i].power||!Number.isSafeInteger(w.members[i].power)||w.members[i].power<0)||selected[0]!.zone!==selected[1]!.zone)fail('reciprocal powers must seal actual enemy controllers, same arena, entries and current powers');
                powerWindows.set(w.id,{witness:structuredClone(w),hits:new Set()});
            }
            const from=w.members.find(m=>m.id===outcome.sourceCard?.id),to=w.members.find(m=>m.id===recipient!.card.id),g=powerWindows.get(w.id)!;
            if(!from||!to||from.id===to.id||from.controller!==outcome.seat||to.controller!==outcome.seat||outcome.basis!.sourceIds.length!==1||outcome.basis!.sourceIds[0]!==from.id||outcome.basis!.value!==from.power||outcome.amount!==from.power||g.hits.has(to.id))fail('reciprocal receipt must use each opposite sealed unit source exactly once');
            const e=entries.find(e=>!e.parent&&arena(e)&&present(e)&&e.card.id===from.id);
            if(!e||!isUnit(e.card)||e.card.incarnation!==from.incarnation||e.card.n!==outcome.sourceCard?.n||e.card.s!==outcome.sourceCard?.s||e.card.owner!==outcome.sourceCard?.owner)fail('reciprocal hit source must remain present until all simultaneous hits resolve');
            g.hits.add(to.id);
        }
        if(outcome.grantedAbility&&outcome.kind!=='buff'||outcome.whenDefeatedOrigin&&!['damage','create'].includes(outcome.kind)||outcome.restoreOrigin&&outcome.kind!=='heal'||outcome.traitCondition&&outcome.kind!=='draw'||outcome.captureArena&&outcome.kind!=='capture')fail('grant, activation, Restore, trait and arena witnesses must retain their concrete receipt kind');
        if(outcome.traitCondition){const c=outcome.traitCondition,actual=[...state.players[c.player].ground,...state.players[c.player].space].filter(u=>u.traits?.includes(c.trait));
            if(!outcome.sourceCard?.id||outcome.sourceCard.id!==cue.source?.id||outcome.sourceCard.n!==cue.source?.n||outcome.sourceCard.s!==cue.source?.s||c.player!==cue.seat||c.trait!=='official'||c.minimum!==3||actual.length<3||c.units.length!==actual.length||new Set(c.units.map(u=>u.id)).size!==c.units.length||c.units.some(u=>!actual.some(a=>a.id===u.id&&a.incarnation===u.incarnation))||outcome.seat!==c.player||outcome.amount!==3||outcome.fromZone!=='deck')fail('Official draw requires exact qualifying controlled current trait entries and threshold three');
        }
        if(outcome.whenDefeatedOrigin){const o=outcome.whenDefeatedOrigin,key=defeatKey(o.subjectId,o.incarnation),seal=defeatedAbilitySeals.get(key),g=seal?.grants.find(g=>g.id===o.abilityId),activation=`${key}\u0000${o.abilityId}`;
            if(!outcome.requiresDefeat||outcome.requiresDefeat.id!==o.subjectId||outcome.requiresDefeat.incarnation!==o.incarnation||defeatedIncarnations.get(o.subjectId)!==o.incarnation||!seal||!g||o.controller!==seal.controller||o.round!==state.round||o.phase!==state.phase||g.round!==o.round||g.phase!==o.phase||g.sourceId!==o.sourceId||g.subjectId!==o.subjectId||g.incarnation!==o.incarnation||outcome.sourceCard?.id!==seal.source.id||outcome.sourceCard?.n!==seal.source.n||outcome.sourceCard?.s!==seal.source.s||outcome.sourceCard?.owner!==seal.source.owner||activatedGrants.has(activation))fail('granted activation requires exact successful current-phase defeat, retained descriptor and controller at defeat');
            if(!['damage-enemy-unit','create-clone'].includes(g.effect)||g.effect==='damage-enemy-unit'&&(outcome.kind!=='damage'||outcome.amount!==2||outcome.damageType!=='ability'||!recipient||!arena(recipient)||!present(recipient)||recipient.seat===seal.controller)||g.effect==='create-clone'&&(outcome.kind!=='create'||outcome.amount!==1||outcome.tokenType!=='clone-trooper'||outcome.seat!==seal.controller))fail('granted activation contradicts its concrete fixed effect or current enemy/creating controller');
            activatedGrants.add(activation);
        }
        if(outcome.restoreOrigin){const o=outcome.restoreOrigin,a=attacks.get(o.attackId),source=entries.find(e=>arena(e)&&!e.parent&&isUnit(e.card)&&e.card.id===o.attackerId&&e.card.incarnation===o.incarnation);
            if(!a||a.attackerId!==o.attackerId||a.incarnation!==o.incarnation||!source||o.round!==state.round||o.phase!==state.phase||a.restoreAmount<=0||o.amount!==a.restoreAmount||a.combatStarted||restoredAttacks.has(o.attackId)||outcome.sourceCard?.id!==source.card.id||outcome.sourceCard?.n!==source.card.n||outcome.sourceCard?.s!==source.card.s||outcome.sourceCard?.owner!==source.card.owner||outcome.seat!==a.attackingSeat||!recipient||recipient.zone!=='base'||recipient.card.id!==state.players[a.attackingSeat].base.id||outcome.amount!==Math.min(a.restoreAmount,(recipient.card as UnitRef).d))fail('Restore requires actual attack declaration, current keyword total, controller base and exact capped healing before combat');
            restoredAttacks.add(o.attackId);
        }
        if(outcome.defenseModifier&&outcome.kind!=='buff'||outcome.defenseOrigin&&!(outcome.kind==='debuff'&&outcome.duration==='attack')||outcome.enteredPhase&&outcome.kind!=='debuff'||outcome.unitCountCondition&&outcome.kind!=='debuff'||outcome.tokenType&&outcome.kind!=='create')fail('new entry, defense, count and creation evidence must retain its concrete receipt meaning');
        if(outcome.upgradePlayPermission && (outcome.kind!=='play' || outcome.playAs!=='upgrade'))fail('upgrade play permission cannot be attached to a different receipt kind');
        if(outcome.captureCost && outcome.kind!=='capture')fail('printed-cost capture evidence cannot be attached to a different receipt kind');
        if(outcome.kind==='damage'&&outcome.incarnation!==undefined&&(!recipient||!present(recipient)||!isUnit(recipient.card)||recipient.card.incarnation!==outcome.incarnation||recipient.zone!==outcome.zone))fail('declared damage entry must match actual current target incarnation and arena');
        if(outcome.kind==='damage' && outcome.basis?.kind==='defeated-power' && (!recipient || !present(recipient) || recipient.zone!=='base' || recipient.seat!==cue.seat || recipient.card.n!==outcome.card?.n || recipient.card.s!==outcome.card?.s))fail('sealed last-known power damage needs its actual own-base recipient');
        if(outcome.kind==='damage' && outcome.requiresDefeat && defeatedIncarnations.get(outcome.requiresDefeat.id)!==outcome.requiresDefeat.incarnation)fail('damage requires actual successful defeat of this exact incarnation');
        if(outcome.chosenUnitGroup){
            const id=outcome.chosenUnitGroup,prior=chosenGroups.get(id);
            if(outcome.chosenUnits){
                const units=outcome.chosenUnits;
                if(prior){if(prior.kind!=='arena'||JSON.stringify(prior.units)!==JSON.stringify(units))fail('chosen power group changed after its seal');}
                else{
                    if(new Set(units.map(u=>u.id)).size!==units.length||units.some(u=>!entries.some(e=>arena(e)&&!e.parent&&present(e)&&e.seat===cue.seat&&isUnit(e.card)&&e.card.id===u.id&&e.card.incarnation===u.incarnation&&e.card.p===u.power&&Number.isSafeInteger(u.power)&&u.power>=0)))fail('chosen power must seal distinct current controlled entries and actual power');
                    chosenGroups.set(id,{kind:'arena',cards:[],units:structuredClone(units),created:0,attempted:new Set()});
                }
                if(!['pay','play','defeat'].includes(outcome.kind))fail('chosen power evidence is attached to unsupported receipt');
                if(outcome.kind==='pay'&&outcome.amount!==0)fail('selected-power free play requires explicit zero unit payment');
                if(outcome.kind==='play'&&(outcome.fromZone!=='hand'||outcome.fromSeat!==cue.seat||outcome.seat!==cue.seat||outcome.printedCost===undefined||!Number.isSafeInteger(outcome.printedCost)||outcome.printedCost<0||outcome.printedCost>units.reduce((n,u)=>n+u.power,0)||paidUnits.get(outcome.card?.id??'')!==0||outcome.unit?.d!==0||outcome.unit.u?.length||outcome.unit.status?.length||outcome.unit.cap?.length))fail('free play requires actual chosen power, own hand, known zero payment and clean entry');
                if(outcome.kind==='defeat'){const group=chosenGroups.get(id)!;if(!outcome.card?.id||!units.some(u=>u.id===outcome.card!.id&&u.incarnation===outcome.incarnation)||group.attempted.has(outcome.card.id))fail('then sacrifice must name each original chosen entry exactly once');group.attempted.add(outcome.card.id);}
            }else{
                const cards=outcome.cards??fail('discard selection group requires actual chosen cards');
                if(prior){if(prior.kind!=='discard'||JSON.stringify(prior.cards)!==JSON.stringify(cards))fail('chosen discard group changed after selection');}
                else{
                    if(cards.length>4||stableIds(cards,'chosen discard units').some(id=>!state.players[cue.seat].discard.some(c=>c.id===id&&cards.some(x=>same(x,c)&&x.n===c.n&&x.s===c.s)))||cards.some(c=>c.id===source?.card.id))fail('chosen discard group requires at most four actual other own discard cards');
                    chosenGroups.set(id,{kind:'discard',cards:structuredClone(cards),units:[],created:0,attempted:new Set()});
                }
                const group=chosenGroups.get(id)!;
                if(outcome.kind==='recover'){if(outcome.seat!==cue.seat||outcome.zone!=='deck'||!cards.some(c=>same(c,outcome.card!))||group.attempted.has(outcome.card?.id??''))fail('random bottom movement requires its exact selected own discard subset');group.attempted.add(outcome.card!.id!);}
                else if(outcome.kind==='create')group.created++;
                else fail('discard selection group permits only recovery and creation');
            }
        }else if(outcome.chosenUnits)fail('chosen power evidence requires a stable selection group');
        if(outcome.discardPlayDamage){const w=outcome.discardPlayDamage,prior=salvageSequences.get(w.sequenceId),idx=outcome.sequenceIndex;
            if(w.sourceId!==cue.source?.id||!w.playedId||!w.incarnation||outcome.sequenceId!==w.sequenceId||outcome.card?.id!==w.playedId||outcome.prevented||!idx||prior&&JSON.stringify(prior.w)!==JSON.stringify(w)||idx!==(prior?.index??0)+1)fail('discard play damage requires an exact ordered source/current played entry sequence');
            if(idx===1){const e=find(outcome.card,e=>e.zone==='discard'&&!e.parent&&present(e)&&e.seat===cue.seat);if(outcome.kind!=='pay'||!e||e.card.owner!==cue.seat||e.card.n!==outcome.card?.n||e.card.s!==outcome.card?.s||outcome.sourceCard?.id!==e.card.id||outcome.seat!==cue.seat||outcome.amount!==previewGivenCost({printed:w.printedCost,aspects:w.aspects},before,cue.seat))fail('discard Vehicle full payment requires actual own selected instance');}
            else if(idx===2){if(outcome.kind!=='play'||!actualEvent(outcome)||outcome.fromZone!=='discard'||outcome.fromSeat!==cue.seat||outcome.seat!==cue.seat||outcome.entryType!=='played'||outcome.entersReady!==false||outcome.unit?.incarnation!==w.incarnation||outcome.unit.d!==0||outcome.unit.x!==1||outcome.unit.u?.length||outcome.unit.cap?.length||outcome.printedCost!==w.printedCost||!outcome.unit.traits?.includes('vehicle'))fail('paid discard Vehicle play requires clean normal exhausted fresh played entry');}
            else if(idx===3){if(outcome.kind!=='damage'||!actualEvent(outcome)||playedEntries.get(w.playedId)!==w.incarnation||!unit||!present(unit)||!isUnit(unit.card)||unit.card.incarnation!==w.incarnation||outcome.incarnation!==w.incarnation||outcome.amount!==1||outcome.damageType!=='ability')fail('one ability wound requires the actual paid newly played entry before aftermath');}
            else if(idx===4){if(outcome.kind!=='defeat'||!actualEvent(outcome)||!unit||!present(unit)||!isUnit(unit.card)||unit.card.incarnation!==w.incarnation||unit.card.d<unit.card.h)fail('post-entry defeat requires actual lethal one-wound result');}
            else fail('unsupported discard-play sequence index');salvageSequences.set(w.sequenceId,{w:structuredClone(w),index:idx});
        }
        switch (outcome.kind) {
            case 'damage':
            case 'heal':
                if (recipient && present(recipient) && 'd' in recipient.card) {
                    const card = recipient.card as { d: number };
                    if (outcome.kind === 'heal' && outcome.allocation) {
                        const allocation = outcome.allocation, prior = healingAllocations.get(allocation.id) ?? { limit: allocation.limit, total: 0 };
                        if (recipient.zone === 'base' || !isUnit(recipient.card) || !Number.isSafeInteger(allocation.limit) || allocation.limit < 0
                            || prior.limit !== allocation.limit || count(outcome.amount) > card.d || prior.total + count(outcome.amount) > allocation.limit) fail('unit healing allocation exceeds existing damage or shared budget');
                        prior.total += count(outcome.amount); healingAllocations.set(allocation.id, prior);
                    }
                    if (outcome.kind === 'damage' && outcome.basis) {
                        const basis = outcome.basis, ids = basis.sourceIds;
                        if ((!ids.length && !['hand-count','arena-unit-count'].includes(basis.kind)) || new Set(ids).size !== ids.length || !Number.isFinite(basis.value)) fail('derived damage requires an explicit finite, uniquely identified basis');
                        switch (basis.kind) {
                            case 'arena-unit-count': {
                                const actual=basis.player&&basis.arena?state.players[basis.player][basis.arena]:undefined;
                                if(!outcome.sourceCard?.id||outcome.sourceCard.id!==cue.source?.id||outcome.sourceCard.n!==cue.source?.n||outcome.sourceCard.s!==cue.source?.s||outcome.kind!=='damage'||outcome.damageType!=='ability'||!actual||basis.player!==cue.seat||recipient.seat===cue.seat||recipient.zone!==basis.arena||ids.length!==actual.length||ids.some(id=>!actual.some(u=>u.id===id))||basis.value!==actual.length||outcome.amount!==basis.value)fail('arena-count strike requires complete current controlled same-arena witnesses and actual enemy-unit damage');
                                break;
                            }
                            case 'hand-count': {
                                const hand = basis.player ? state.players[basis.player].hand : undefined;
                                if (recipient.zone !== 'base' || recipient.seat !== basis.player || !hand
                                    || hand.length !== basis.value || ids.length !== hand.length
                                    || hand.some(c => !c.id || !ids.includes(c.id)) || count(outcome.amount) !== basis.value) fail('hand-count damage requires the actual resolving hand after source departure');
                                break;
                            }
                            case 'captured-count': {
                                const rule=basis.countRule, actual=isUnit(recipient.card)?recipient.card.cap?.length??0:-1;
                                if (ids.length!==1 || ids[0]!==recipient.card.id || actual!==basis.value || !rule
                                    || !Number.isSafeInteger(rule.zero) || rule.zero<0 || !Number.isSafeInteger(rule.positive) || rule.positive<0
                                    || count(outcome.amount)!==(actual>0?rule.positive:rule.zero)) fail('captured-count damage contradicts the actual target pocket and declared two amounts');
                                break;
                            }
                            case 'healed':
                                if (ids.length !== 1 || (healed.get(ids[0]) ?? 0) !== basis.value || ids[0] === recipient.card.id
                                    || count(outcome.amount) !== basis.value) fail('damage must equal actual healing from a different unit');
                                break;
                            case 'source-damage-plus-one': {
                                const source = entries.find(entry => !entry.parent && arena(entry) && present(entry) && entry.card.id === ids[0]);
                                if (ids.length !== 1 || !source || !isUnit(source.card) || source.card.d !== basis.value
                                    || basis.increment !== 1 || count(outcome.amount) !== basis.value + 1) fail('damage-plus-one basis contradicts its current source');
                                break;
                            }
                            case 'printed-cost':
                                if (ids.length !== 1 || !discardedIds.has(ids[0]) || count(outcome.amount) !== basis.value) fail('printed-cost damage requires the actual prior discarded card');
                                break;
                            case 'heroism-count':
                                if (ids.length !== basis.value || count(outcome.amount) !== basis.value) fail('Heroism damage count contradicts the revealed basis');
                                break;
                            case 'printed-cost-sum': {
                                const costs = ids.map(id => basis.printedCosts?.[id]);
                                if (costs.some((cost, i) => cost === undefined || cost !== revealedCosts.get(ids[i]) || !Number.isSafeInteger(cost) || cost < 0)
                                    || costs.reduce<number>((sum, cost) => sum + cost!, 0) !== basis.value
                                    || basis.threshold === undefined || !Number.isSafeInteger(basis.threshold) || basis.threshold < 0
                                    || count(outcome.amount) !== (basis.value <= basis.threshold ? basis.value : 0)) fail('damage sum requires its actual sequential public reveal costs and threshold');
                                break;
                            }
                            case 'defeated-power': {
                                const prior=outcome.requiresDefeat;
                                if(!prior || ids.length!==1 || ids[0]!==prior.id || !defeatedPowers.has(defeatKey(prior.id,prior.incarnation))
                                    || defeatedPowers.get(defeatKey(prior.id,prior.incarnation))!==basis.value || count(outcome.amount)!==basis.value
                                    || outcome.damageType!=='ability' || recipient.zone!=='base' || recipient.seat!==cue.seat)fail('own-base damage needs exact successful defeat and sealed last-known power');
                                break;
                            }
                            case 'source-power': {
                                const source = find(outcome.sourceCard, entry => arena(entry) && !entry.parent && present(entry));
                                if (ids.length !== 1 || !source || !isUnit(source.card) || source.card.id !== ids[0]
                                    || !outcome.powerWindow && source.card.p !== basis.value || count(outcome.amount) !== basis.value) fail('ability damage requires actual current source power');
                                if (outcome.sequenceId) {
                                    const prior = sequences.get(outcome.sequenceId), incarnation = (recipient.card as UnitRef).incarnation;
                                    if (!recipient.card.id || !incarnation || outcome.targetIncarnation !== incarnation || !outcome.sequenceIndex
                                        || prior && (prior.targetId !== recipient.card.id || prior.incarnation !== incarnation
                                            || prior.sourceIds.has(ids[0]) || outcome.sequenceIndex !== prior.index + 1)
                                        || !prior && outcome.sequenceIndex !== 1) fail('sequential ability hits require distinct sources and the same current target incarnation');
                                    const sequence = prior ?? { targetId: recipient.card.id!, incarnation: incarnation!, sourceIds: new Set<string>(), index: 0 };
                                    sequence.sourceIds.add(ids[0]); sequence.index = outcome.sequenceIndex!; sequences.set(outcome.sequenceId, sequence);
                                }
                                break;
                            }
                            case 'played-printed-cost':
                                if (ids.length !== 1 || playedCosts.get(ids[0]) !== basis.value || count(outcome.amount) !== basis.value
                                    || recipient.zone !== 'base' || recipient.seat !== cue.seat) fail('own-base printed-cost damage requires the actual prior play');
                                break;
                        }
                    }
                    if(outcome.kind==='damage'&&recipient.zone==='base'&&player.base.damageProtection?.some(p=>p.round===state.round&&p.phase===state.phase)&&!outcome.baseProtection)fail('known active base protection requires explicit incoming/consume evidence');
                    if(outcome.baseProtection){const op=outcome.baseProtection,base=player.base;
                        if(outcome.kind!=='damage'||op.operation!=='consume'||recipient.card!==base||recipient.zone!=='base'||outcome.prevented||outcome.card?.n!==base.n||outcome.card?.s!==base.s||!outcome.sourceCard?.id||!['combat','ability'].includes(outcome.damageType??''))fail('base protection consumption requires declared actual incoming damage on its base');
                        const e=base.damageProtection?.find(p=>p.id===op.effectId),cause=find(cue.source,x=>x.zone==='discard'&&!x.parent&&present(x)&&x.seat===cue.seat),damageSource=find(outcome.sourceCard,x=>!x.parent&&present(x));
                        if(!cause||cause.card.n!==cue.source?.n||cause.card.s!==cue.source?.s||!damageSource||damageSource.card.n!==outcome.sourceCard?.n||damageSource.card.s!==outcome.sourceCard?.s||op.sourceId!==cue.source?.id||!e||e.sourceId!==op.sourceId||e.baseId!==base.id||e.seat!==outcome.seat||e.round!==state.round||e.phase!==state.phase||!Number.isSafeInteger(op.incoming)||op.incoming<=0||op.prevented!==(op.channel==='direct'?op.incoming:0)||!['direct','indirect'].includes(op.channel)||outcome.amount!==op.incoming-op.prevented)fail('base protection consume needs exact unused current-phase source descriptor and direct/indirect applied amount');
                        if(outcome.damageType==='combat'){const a=outcome.attackId?attacks.get(outcome.attackId):undefined,p=outcome.attackId?attackPowers.get(outcome.attackId):undefined,attacker=find(outcome.sourceCard,e=>arena(e)&&!e.parent&&present(e)),incoming=p?.attacker??(attacker&&isUnit(attacker.card)?Math.max(0,attacker.card.p+(attackBonuses.get(outcome.attackId??'')?.power??0)):undefined);if(op.channel!=='direct'||!a||a.attackerId!==outcome.sourceCard.id||a.defenderId!==base.id||incoming!==op.incoming)fail('protected combat incoming must equal actual forward attack power');}
                        base.damageProtection=base.damageProtection!.filter(p=>p!==e);
                    }
                    if(outcome.kind==='damage'&&outcome.damageType==='combat'&&outcome.attackId&&['JTL_156','JTL_174'].includes(cue.source?.s??'')){const a=attacks.get(outcome.attackId),attacker=a?entries.find(e=>!e.parent&&arena(e)&&present(e)&&e.card.id===a.attackerId):undefined,powers=attackPowers.get(outcome.attackId),forward=a?.attackerId===outcome.sourceCard?.id;if(!a||!attacker||!isUnit(attacker.card)||attacker.card.x!==1||attacker.card.incarnation!==a.incarnation||!powers||outcome.amount!==(forward?powers.attacker:powers.defender))fail('authored combat requires actual exhaustion and sealed current attack power');}
                    if(outcome.kind==='damage'&&outcome.damageType==='combat'&&outcome.attackId&&attackWindows.has(outcome.attackId)){
                        const g=attackWindows.get(outcome.attackId)!,a=attacks.get(outcome.attackId),e=entries.find(e=>!e.parent&&arena(e)&&present(e)&&e.card.id===g.w.subjectId);
                        if(!a||!e||!isUnit(e.card)||e.card.incarnation!==g.w.incarnation||e.card.d>=e.card.h||g.w.effect==='trench-cost-difference'&&(!g.mill||g.mill.length===2&&!g.selfHit)||g.w.effect==='firespray-indirect'&&!g.indirect)fail('combat requires living exact attacker after all actual mandatory On Attack effects');
                        const powers=attackPowers.get(outcome.attackId),forward=a.attackerId===outcome.sourceCard?.id;if(!powers||outcome.amount!==(forward?powers.attacker:powers.defender)||!forward&&a.defenderId!==outcome.sourceCard?.id||forward&&isUnit(recipient.card)&&recipient.card.u?.some(u=>u.t&&u.n==='Shield'))fail('On Attack combat must use actual sealed power and explicit supported damage/prevention');
                    }
                    if (outcome.kind === 'damage' && outcome.damageType === 'combat') {
                        const attack = outcome.attackId ? attacks.get(outcome.attackId) : undefined;
                        const forward = attack && attack.attackerId === outcome.sourceCard?.id && attack.defenderId === recipient.card.id;
                        const counter = attack && attack.defenderId === outcome.sourceCard?.id && attack.attackerId === recipient.card.id;
                        if (!forward && !counter) fail('combat damage requires its actual attack segment');
                        const counterSource = counter ? entries.find(entry => arena(entry) && !entry.parent && isUnit(entry.card) && entry.card.id === outcome.sourceCard?.id) : undefined;
                        if (counter && !counterSource) fail('a base cannot deal combat counter-damage');
                        if (counter && attack!.order === 'attacker-first' && (!present(counterSource!)
                            || (counterSource!.card as UnitRef).d >= (counterSource!.card as UnitRef).h)) fail('a defeated defending unit cannot deal attacker-first counter-damage');
                        const grit=outcome.attackId?attackGrit.get(outcome.attackId):undefined;
                        if(forward&&grit){const e=entries.find(e=>!e.parent&&arena(e)&&present(e)&&isUnit(e.card)&&e.card.id===grit.attackerId);if(!e||!isUnit(e.card)||e.card.d!==grit.damage)fail('changed Grit wounds before forward combat require separate actual power receipts');}
                        const powers=outcome.attackId?attackPowers.get(outcome.attackId):undefined;
                        if(powers && count(outcome.amount)>(forward?powers.attacker:powers.defender??0))fail('combat damage exceeds actual attack-scoped attacker/defending power');
                        if(forward&&outcome.attackId&&attackKeywords.has(outcome.attackId)&&isUnit(recipient.card)&&recipient.card.u?.some(u=>u.t&&u.n==='Shield'))fail('Saboteur must remove actual defender Shields before combat');
                        attack!.combatStarted=true;
                        if (forward) attack!.damage += count(outcome.amount); else attack!.counter += count(outcome.amount);
                    }
                    const previous = card.d;
                    card.d = Math.max(0, card.d + (outcome.kind === 'damage' ? 1 : -1) * count(outcome.amount));
                    if(outcome.kind==='damage'&&outcome.damageType==='ability'&&actualEvent(outcome)&&isUnit(recipient.card)&&recipient.card.id&&recipient.card.incarnation&&!outcome.prevented)causalHits.set(defeatKey(recipient.card.id,recipient.card.incarnation),{sourceId:cue.source!.id!,amount:count(outcome.amount),lethal:recipient.card.d>=recipient.card.h});
                    if (outcome.kind === 'heal' && recipient.card.id) healed.set(recipient.card.id, (healed.get(recipient.card.id) ?? 0) + previous - card.d);
                }
                break;
            case 'buff':
            case 'debuff': {
                if(outcome.phaseStatsOperation==='expire'){const w=outcome.distinctTitleBoost,u=outcome.unit;
                    if(cue.stage!=='phase-end'||!w||!actualEvent(outcome)||outcome.prevented||!unit||!present(unit)||!isUnit(unit.card)||!u||outcome.incarnation!==unit.card.incarnation||w.sourceId!==cue.source?.id||w.round!==state.round||w.phase!==state.phase||w.members.length!==1||w.members[0].id!==unit.card.id||w.members[0].incarnation!==unit.card.incarnation)fail('fixed title expiry requires exact explicit phase-end/current entry and ending truth');
                    const status=unit.card.status?.filter(x=>x.titleBoost?.id===w.id)??[],mark=status[0]?.titleBoost;
                    if(status.length!==1||!mark||mark.sourceId!==w.sourceId||mark.subjectId!==unit.card.id||mark.incarnation!==unit.card.incarnation||mark.round!==state.round||mark.phase!==state.phase||mark.amount!==w.amount)fail('title expiry needs exact retained fixed source-bound grant');
                    const expected=structuredClone(unit.card);expected.status=expected.status!.filter(x=>x.titleBoost?.id!==w.id);expected.p=Math.max(0,expected.p-mark.amount);expected.h=Math.max(0,expected.h-mark.amount);if(JSON.stringify(expected)!==JSON.stringify(u))fail('title expiry must preserve all unrelated state and remove only its fixed grant');Object.assign(unit.card,structuredClone(u));break;
                }
                if(outcome.baseProtection){const op=outcome.baseProtection,base=player.base;
                    if(outcome.kind!=='buff'||outcome.zone!=='base'||!recipient||recipient.card!==base||outcome.card?.n!==base.n||outcome.card?.s!==base.s||outcome.prevented||!actualEvent(outcome))fail('base protection requires actual selected base and causing event');
                    if(op.operation==='grant'){const e=op.effect;if(cue.stage||e.baseId!==base.id||e.seat!==outcome.seat||e.sourceId!==cue.source?.id||!e.id||e.round!==state.round||e.phase!==state.phase||e.uses!==1||outcome.duration!=='phase'||seats.some(side=>state.players[side].base.damageProtection?.some(p=>p.id===e.id)))fail('base protection grant needs unique selected base current-phase one-use descriptor');(base.damageProtection??=[]).push(structuredClone(e));}
                    else if(op.operation==='expire'){const e=base.damageProtection?.find(p=>p.id===op.effectId),cause=find(cue.source,x=>x.zone==='discard'&&!x.parent&&present(x)&&x.seat===cue.seat);if(!cause||cause.card.n!==cue.source?.n||cause.card.s!==cue.source?.s||cue.stage!=='phase-end'||!e||e.sourceId!==op.sourceId||op.sourceId!==cue.source?.id||e.baseId!==base.id||e.round!==state.round||e.phase!==state.phase)fail('base protection expiry needs actual unused source-bound descriptor and explicit phase end');base.damageProtection=base.damageProtection!.filter(p=>p!==e);}
                    else fail('base protection consume must accompany actual damage');break;
                }
                if (!unit || !present(unit) || !isUnit(unit.card)) break;
                if(outcome.grantedAbility){const g=outcome.grantedAbility;
                    if(outcome.prevented||outcome.kind!=='buff'||unit.seat!==cue.seat||outcome.duration!=='phase'||outcome.amount!==undefined||g.sourceId!==cue.source?.id||outcome.sourceCard?.id!==cue.source?.id||outcome.sourceCard?.n!==cue.source?.n||outcome.sourceCard?.s!==cue.source?.s||g.subjectId!==unit.card.id||g.incarnation!==unit.card.incarnation||g.round!==state.round||g.phase!==state.phase||!['damage-enemy-unit','create-clone'].includes(g.effect)||g.effect==='damage-enemy-unit'&&g.amount!==2||g.effect==='create-clone'&&g.amount!==1||!g.id||unit.card.status?.some(s=>s.grantedAbility?.id===g.id))fail('phase ability grant requires actual friendly current entry, causing event and unique exact descriptor');
                    (unit.card.status??=[]).push({kind:'buff',label:outcome.label??'When Defeated ability · phase',duration:'phase',grantedAbility:structuredClone(g)});break;
                }
                if(outcome.enteredPhase){const p=outcome.enteredPhase,h=state.enteredThisPhase;
                    if(outcome.kind!=='debuff'||!h||h.round!==state.round||h.phase!==state.phase||p.round!==h.round||p.phase!==h.phase||p.incarnation!==unit.card.incarnation||!h.units.some(u=>u.id===unit.card.id&&u.incarnation===p.incarnation&&['played','created','rescued','deployed'].includes(u.entryType)))fail('recent-entry reduction requires actual current phase and current entry history');
                }
                if(outcome.unitCountCondition){const c=outcome.unitCountCondition,first=outcome.sequenceId?equalizeFirst.get(outcome.sequenceId):undefined;
                    const own=[...state.players[c.player].ground,...state.players[c.player].space].length,other=[...state.players[c.against].ground,...state.players[c.against].space].length;
                    if(outcome.kind!=='debuff'||outcome.sequenceIndex!==2||!first||first.id!==c.firstId||first.incarnation!==c.incarnation||first.controller!==c.against||unit.card.id===first.id||c.player!==cue.seat||c.ownCount!==own||c.otherCount!==other||own>=other)fail('second reduction requires distinct target and actual post-first counts against first controller');
                }
                if(outcome.kind==='debuff'&&outcome.sequenceId&&outcome.sequenceIndex===1){if(!unit.card.id||!unit.card.incarnation||equalizeFirst.has(outcome.sequenceId))fail('first reduction requires unique continuing entry');equalizeFirst.set(outcome.sequenceId,{id:unit.card.id,incarnation:unit.card.incarnation,controller:unit.seat});}
                if(outcome.defenseModifier){const m=outcome.defenseModifier;
                    if(outcome.kind!=='buff'||unit.seat!==cue.seat||outcome.duration!=='phase'||m.attackerPower!==-4||m.sourceId!==cue.source?.id||m.round!==state.round||m.phase!==state.phase||m.incarnation!==unit.card.incarnation)fail('defensive status requires exact friendly current entry, event and phase');
                    (unit.card.status??=[]).push({kind:'buff',label:outcome.label??'Defending: attacker −4',duration:'phase',defenseModifier:structuredClone(m)});break;
                }
                if (outcome.attackPhase) {
                    const history = state.attacksThisPhase, phase = outcome.attackPhase;
                    if (!history || history.round !== state.round || history.phase !== state.phase || phase.round !== history.round || phase.phase !== history.phase
                        || phase.incarnation !== unit.card.incarnation || !history.attacks.some(attack => attack.attackerId === unit.card.id && attack.incarnation === phase.incarnation)) fail('Experience requires actual current-phase attack history of this incarnation');
                }
                if (outcome.upgradeCountBasis) {
                    const basis = outcome.upgradeCountBasis, source = entries.find(entry => !entry.parent && arena(entry) && entry.card.id === basis.sourceId);
                    const actualIds = source && isUnit(source.card) ? (source.card.u ?? []).map(c => c.id) : [];
                    const awarded = outcome.cards?.length ?? 0, prior = xpDistributions.get(basis.distributionId);
                    if (!source || !isUnit(source.card) || source.card.incarnation !== basis.incarnation || !Number.isSafeInteger(basis.count)
                        || actualIds.some(id => !id) || actualIds.length !== basis.count || basis.upgradeIds.length !== basis.count
                        || new Set(basis.upgradeIds).size !== basis.count || basis.upgradeIds.some(id => !actualIds.includes(id))
                        || basis.resolution === 'defeated' && (!defeatedIds.has(basis.sourceId) || present(source))
                        || basis.resolution === 'prevented' && (!preventedIds.has(basis.sourceId) || !present(source))
                        || unit.seat !== cue.seat || prior && (prior.sourceId !== basis.sourceId || prior.count !== basis.count
                            || prior.upgradeIds.some(id => !basis.upgradeIds.includes(id))) || (prior?.assigned ?? 0) + awarded > basis.count) fail('Experience distribution contradicts actual prior upgrade count or defeat result');
                    xpDistributions.set(basis.distributionId, { sourceId: basis.sourceId, upgradeIds: [...basis.upgradeIds], count: basis.count, assigned: (prior?.assigned ?? 0) + awarded });
                }
                const stats = String(outcome.amount ?? '').replaceAll('−', '-').match(/^([+-]?\d+)\/([+-]?\d+)$/);
                if (outcome.duration === 'attack') {
                    // A resolved event's ending board is at rest; the signature renders this only in its attack window.
                    if (!outcome.attackId || !unit.card.id || !stats) fail('attack-only modifier requires an identified unit, amount and attack segment');
                    if (outcome.attackBonusBasis) {
                        const basis=outcome.attackBonusBasis;
                        if (basis.sourceId!==unit.card.id || basis.incarnation!==unit.card.incarnation
                            || basis.kind==='damaged' && (unit.card.d<=0 || basis.damage!==unit.card.d)) fail('attack bonus requires its actual current prerequisite entry');
                    }
                    if(outcome.defenderDamageAtStart){const w=outcome.defenderDamageAtStart,target=entries.find(e=>!e.parent&&present(e)&&e.card.id===w.defenderId&&(arena(e)||e.zone==='base'));
                        if(!actualEvent(outcome)||outcome.kind!=='buff'||unit.seat!==cue.seat||unit.card.x||outcome.incarnation!==unit.card.incarnation||outcome.attackRole==='defender'||Number(stats[2])!==0||!target||target.seat===unit.seat||target.zone!==w.zone||defenderStarts.has(outcome.attackId)||attacks.has(outcome.attackId)||w.zone==='base'&&(w.damage!==0||w.incarnation!==undefined)||w.zone!=='base'&&(!isUnit(target.card)||w.incarnation!==target.card.incarnation||w.damage!==target.card.d||target.zone!==unit.zone)||Number(stats[1])!==w.damage)fail('defender start bonus requires exact opposing starting wounds or base zero, current entries and actual event');
                        defenderStarts.set(outcome.attackId,structuredClone(w));
                    }
                    if(outcome.gritBasis){const b=validateGrit(outcome,unit),prior=attackGrit.get(outcome.attackId);
                        if(!prior||JSON.stringify(prior)!==JSON.stringify(b)||outcome.kind!=='buff'||outcome.attackRole==='defender'||Number(stats[2])!==0||Number(stats[1])!==(b.powerIncludesGrit?0:b.damage)||gritModifiers.has(outcome.attackId))fail('Grit power modifier must follow its exact boolean grant and count current wounds only once');
                        gritModifiers.add(outcome.attackId);
                    }
                    if(outcome.defenseOrigin){const d=outcome.defenseOrigin,protectedEntry=entries.find(e=>arena(e)&&!e.parent&&present(e)&&isUnit(e.card)&&e.card.id===d.protectedId&&e.card.incarnation===d.incarnation);
                        if(outcome.kind!=='debuff'||outcome.attackRole==='defender'||Number(stats![1])!==-4||Number(stats![2])!==0||!protectedEntry||protectedEntry.seat===unit.seat||!isUnit(protectedEntry.card)||!protectedEntry.card.status?.some(s=>s.duration==='phase'&&s.defenseModifier?.attackerPower===-4&&s.defenseModifier.sourceId===d.sourceId&&s.defenseModifier.incarnation===d.incarnation&&s.defenseModifier.round===state.round&&s.defenseModifier.phase===state.phase))fail('conditional attacker reduction requires exact opposing protected entry and current defensive status');
                        defenseOrigins.set(outcome.attackId!,structuredClone(d));
                    }
                    const modifiers=outcome.attackRole==='defender'?defenderBonuses:attackBonuses;
                    if(modifiers.has(outcome.attackId!))fail('duplicate modifier for same attack role');
                    modifiers.set(outcome.attackId!, { id: unit.card.id!, power: Number(stats![1]) });
                    break;
                }
                if (stats) {
                    unit.card.p = Math.max(0, unit.card.p + Number(stats[1]));
                    unit.card.h = Math.max(0, unit.card.h + Number(stats[2]));
                }
                if(outcome.kind==='buff'&&outcome.sequenceId&&outcome.sequenceIndex===2&&!outcome.attackId){const first=defeatAttempts.get(outcome.sequenceId);if(!first||first.rewarded||!actualEvent(outcome)||outcome.prevented||outcome.kind!=='buff'||outcome.amount!=='+2/+2'||outcome.duration!=='token'||outcome.cards?.length!==2||outcome.cards.some(c=>c.owner!==outcome.seat)||outcome.label!=='2 EXPERIENCE'||outcome.incarnation!==unit.card.incarnation)fail('two Experience reward requires prior actual friendly defeat attempt, independent of success');first.rewarded=true;}
                const experience = outcome.label?.match(/(\d+)\s+EXPERIENCE/i);
                if (experience) {
                    if (!stats || Number(stats[1]) !== Number(experience[1]) || Number(stats[2]) !== Number(experience[1])) fail('Experience count must match actual +1/+1 per token');
                    if (outcome.cards && outcome.cards.length !== Number(experience[1])) fail('Experience token identities contradict declared count');
                    for (let n = 0; n < Number(experience[1]); n++) {
                        const declared = outcome.cards?.[n];
                        if (declared && (!declared.id || occupiedIds.has(declared.id) || declared.n !== 'Experience' || declared.s !== null)) fail('Experience token requires a new stable identity');
                        if (declared?.id) occupiedIds.add(declared.id);
                        (unit.card.u ??= []).push({ n: 'Experience', s: null, t: 1, id: declared?.id ?? generatedId(`${index}:experience:${n}`),
                            ...(declared?.owner ? { owner: declared.owner, p: 1, h: 1 } : {}) });
                    }
                } else if(outcome.distinctTitleBoost){const w=outcome.distinctTitleBoost;
                    (unit.card.status??=[]).push({kind:'buff',label:`${outcome.amount} · phase`,duration:'phase',round:state.round,phase:state.phase,incarnation:unit.card.incarnation,titleBoost:{id:w.id,sourceId:w.sourceId,subjectId:unit.card.id!,incarnation:unit.card.incarnation!,round:w.round,phase:w.phase,amount:w.amount}});
                } else if(outcome.duration==='phase'&&outcome.round!==undefined){
                    if(outcome.prevented||!actualEvent(outcome)||outcome.round!==state.round||outcome.incarnation!==unit.card.incarnation||!stats)fail('bound phase stats require actual causing event and current entry');
                    (unit.card.status??=[]).push({kind:outcome.kind,label:`${outcome.amount} · phase`,duration:'phase',round:state.round,phase:state.phase,incarnation:unit.card.incarnation});
                } else if(outcome.traitGrant){
                    (unit.card.status??=[]).push({kind:outcome.kind,label:`${outcome.amount} · phase`,duration:'phase',round:state.round,phase:state.phase,incarnation:unit.card.incarnation});
                } else if (outcome.label?.includes('PHASE')) {
                    (unit.card.status ??= []).push({ kind: outcome.kind, label: `${outcome.amount} · phase`, duration: 'phase' });
                }
                break;
            }
            case 'shield':
                if (unit && present(unit) && isUnit(unit.card)) {
                    for (let n = 0; n < count(outcome.amount, 1); n++) {
                        const declared = outcome.cards?.[n];
                        if (declared && (!declared.id || occupiedIds.has(declared.id) || declared.n !== 'Shield' || declared.s !== null)) fail('explicit Shield token requires a new stable token identity');
                        if (declared?.id) occupiedIds.add(declared.id);
                        (unit.card.u ??= []).push({ n: 'Shield', s: null, t: 1, id: declared?.id ?? generatedId(`${index}:shield:${n}`),
                            ...(declared?.owner ? { owner: declared.owner, p: 0, h: 0 } : {}) });
                    }
                }
                break;
            case 'ready':
            case 'exhaust':
                if(outcome.kind==='ready' && outcome.zone==='resources'){
                    const manifest=player.resources,ids=outcome.cards?stableIds(outcome.cards,'ready resources'):undefined;
                    if(!manifest||!ids||ids.length!==count(outcome.amount)||outcome.choice?.kind==='opponent-mode'&&ids.length>6||ids.some(id=>!manifest.some(c=>c.id===id&&c.x)))fail('resource ready requires exact available exhausted identities and declared cap');
                    for(const c of manifest)if(ids.includes(c.id!))delete c.x;player.res.ready+=ids.length;break;
                }
                if (unit && present(unit) && isUnit(unit.card)) {
                    if (outcome.kind === 'ready') {
                        if (outcome.round !== undefined && outcome.round !== state.round) fail('ready receipt round contradicts the staged snapshot');
                        if (outcome.incarnation !== undefined && outcome.incarnation !== unit.card.incarnation) fail('ready receipt names a different unit incarnation');
                        if (outcome.attackOrigin) {
                            const origin=outcome.attackOrigin;
                            if (origin.playedId!==unit.card.id || origin.incarnation!==unit.card.incarnation
                                || playedEntries.get(origin.playedId)!==origin.incarnation || !paidUnits.has(origin.playedId)
                                || !unit.card.status?.some(s=>s.kind==='keyword' && s.keyword?.name==='Ambush' && s.duration==='phase')) fail('Ambush ready needs the same actual paid played entry and phase keyword');
                            ambushReadied.add(origin.playedId);
                        }
                        const incarnation = unit.card.incarnation;
                        const locks = unit.card.status?.filter(status => status.restriction === 'cannot-ready'
                            && status.round === state.round && status.incarnation === incarnation);
                        if (!locks?.length) {
                            delete unit.card.x;
                            if (unit.card.status) unit.card.status = unit.card.status.filter(status => status.restriction !== 'cannot-ready');
                        }
                    }
                    else {
                        if(outcome.exhaustedAttackPermission){const w=outcome.exhaustedAttackPermission,a=attacks.get(w.attackId);if(!a||a.attackerId!==unit.card.id||a.incarnation!==unit.card.incarnation||w.sourceId!==cue.source?.id||w.round!==state.round||w.phase!==state.phase||outcome.amount!==(unit.card.x?0:1))fail('Dogfight exhaustion must follow its actual attack and preserve exact changed/already-exhausted pose');}
                        if(outcome.incarnation!==undefined&&outcome.incarnation!==unit.card.incarnation)fail('exhaust receipt names a different current incarnation');
                        if(outcome.prevented)break;
                        const changed=!unit.card.x;unit.card.x=1;
                        if(changed&&actualEvent(outcome)&&unit.card.id&&unit.card.incarnation)successfulExhaustions.set(unit.card.id,{incarnation:unit.card.incarnation,controller:unit.seat,sourceId:cue.source!.id!});
                    }
                }
                break;
            case 'defeat': {
                if(outcome.fromZone==='resources'){
                    const e=find(outcome.card,e=>!e.parent&&e.zone==='resources'&&e.seat===outcome.fromSeat&&present(e));
                    if(!e||!actualEvent(outcome)||outcome.seat!==e.seat||outcome.chooserSeat!==e.seat||outcome.zone!=='discard'||e.card.n!==outcome.card?.n||e.card.s!==outcome.card?.s||!e.card.owner||outcome.ownerSeat!==e.card.owner||outcome.incarnation||outcome.requiresDefeat||outcome.paymentRole)fail('resource defeat needs actual controlled resource, chooser, owner discard and no unit-defeat evidence');
                    if(outcome.prevented)break;remove(e);state.players[e.card.owner!].discard.push(ref(e.card));break;
                }

                if (outcome.trigger === 'combat-damage') {
                    const attack = outcome.attackId ? attacks.get(outcome.attackId) : undefined;
                    if (!attack || attack.attackerId !== outcome.card?.id) fail('combat-triggered defeat requires this attacker’s actual attack');
                    if (attack!.damage <= 0) break;
                }
                if(outcome.sequenceId&&outcome.sequenceIndex===2&&!outcome.attackId&&!controlSequences.has(outcome.sequenceId))fail('sequential defeat is missing its actual prior control attempt');
                if(outcome.sequenceId&&controlSequences.has(outcome.sequenceId)){const q=controlSequences.get(outcome.sequenceId)!,e=find(outcome.card,x=>arena(x)&&!x.parent&&present(x));
                    if(!e||!isUnit(e.card)||e.card.n!==outcome.card?.n||e.card.s!==outcome.card?.s||outcome.ownerSeat!==e.card.owner||outcome.fromZone!==e.zone||outcome.zone!=='discard'||q.complete||outcome.sequenceIndex!==2||!actualEvent(outcome)||outcome.card?.id!==q.id||outcome.incarnation!==q.incarnation||outcome.seat!==q.controller||outcome.fromSeat!==q.controller)fail('sequential defeat requires exact target, controller after control attempt and next index');q.complete=true;
                }
                if(outcome.sequenceId&&outcome.sequenceIndex===1&&!outcome.attackId){if(!actualEvent(outcome)||outcome.seat!==cue.seat||!unit||!present(unit)||!isUnit(unit.card)||!unit.card.incarnation||outcome.incarnation!==unit.card.incarnation||defeatAttempts.has(outcome.sequenceId))fail('friendly first defeat attempt requires exact source and current entry once');defeatAttempts.set(outcome.sequenceId,{id:unit.card.id!,incarnation:unit.card.incarnation,rewarded:false});}
                const defeated = find(outcome.card, entry => entry.seat === outcome.seat && arena(entry) && !entry.captive);
                if (defeated && present(defeated)) {
                    if (outcome.prevented) { if (defeated.card.id) preventedIds.add(defeated.card.id); break; }
                    if (outcome.incarnation !== undefined && (!isUnit(defeated.card) || outcome.incarnation !== defeated.card.incarnation)) fail('defeat receipt names a different arena incarnation');
                    if (isUnit(defeated.card) && defeated.card.cap?.length) {
                        const cleanup=outcome.captiveCleanup, caps=defeated.card.cap;
                        if (!cleanup || !defeated.card.id || cleanup.captorId!==defeated.card.id || cleanup.incarnation!==defeated.card.incarnation
                            || captiveCleanups.has(cleanup.id) || stableIds(cleanup.cards,'departed pocket').length!==caps.length
                            || cleanup.cards.some(c=>!caps.some(a=>same(a,c)&&a.n===c.n&&a.s===c.s&&a.owner===c.owner))) fail('departing captor requires exact separately supplied last-known pocket cleanup');
                        const remaining=new Map<string,Entry>();
                        for (const c of caps) {const e=entries.find(e=>e.captive && e.parent===defeated.card && e.card===c);if(!e||!c.id)fail('captured lookup must match actual before pocket');remaining.set(c.id!,e!);}
                        captiveCleanups.set(cleanup.id,{captor:defeated,incarnation:cleanup.incarnation,remaining});
                    } else if (outcome.captiveCleanup) fail('cleanup has no actual captured cards');
                    if(!defeated.parent && isUnit(defeated.card) && defeated.card.id && defeated.card.incarnation){const key=defeatKey(defeated.card.id,defeated.card.incarnation);defeatedPowers.set(key,defeated.card.p);defeatedAbilitySeals.set(key,{controller:defeated.seat,source:ref(defeated.card),grants:(defeated.card.status??[]).flatMap(s=>s.grantedAbility&&s.kind==='buff'&&s.duration==='phase'?[structuredClone(s.grantedAbility)]:[])});}
                    const owner = defeated.card.owner ?? outcome.ownerSeat ?? defeated.seat;
                    const summary = state.players[owner].leader;
                    const leaderUnit = !defeated.parent && summary?.dep === 1 && summary.id === defeated.card.id;
                    if (outcome.zone === 'leader' || leaderUnit) {
                        const after = outcome.leader;
                        if (!leaderUnit || !after || after.id !== summary.id || after.s !== summary.s || after.n !== summary.n
                            || after.owner !== summary.owner || after.dep !== 0 || after.x !== 1 || after.epic !== summary.epic
                            || outcome.ownerSeat !== owner) fail('leader defeat requires the exact exhausted undeployed owner summary with deployment spent preserved');
                        remove(defeated); discardAttachments(defeated); state.players[owner].leader = structuredClone(after);
                        if (defeated.card.id) { defeatedIds.add(defeated.card.id); if (isUnit(defeated.card) && defeated.card.incarnation) defeatedIncarnations.set(defeated.card.id, defeated.card.incarnation); }
                        break;
                    }
                    if (defeated.parent) {
                        const upgrade = defeated.card as UpgradeRef;
                        // Explicit fixture contributions only; printed names never stand in for known stats.
                        defeated.parent.p -= upgrade.p ?? 0;
                        defeated.parent.h -= upgrade.h ?? 0;
                    }
                    remove(defeated);
                    if(outcome.spaceClearance){const w=outcome.spaceClearance;
                        if(!actualEvent(outcome)||defeated.parent||!isUnit(defeated.card)||defeated.zone!=='space'||defeated.seat===cue.seat||w.opponent!==defeated.seat||w.defeatedId!==defeated.card.id||w.incarnation!==defeated.card.incarnation||outcome.incarnation!==w.incarnation||outcome.card?.n!==defeated.card.n||outcome.card?.s!==defeated.card.s||defeated.card.h-defeated.card.d>3||state.players[w.opponent].space.length!==0||w.remainingIdsAtDefeat.length!==0||!w.id||clearances.has(w.id))fail('space clearance must be exact successful last enemy space removal with remaining HP at most 3');clearances.set(w.id,{w:structuredClone(w),used:false});
                    }
                    if (!defeated.parent && defeated.card.id) defeatedIds.add(defeated.card.id);
                    if (!defeated.parent && defeated.card.id && isUnit(defeated.card) && defeated.card.incarnation) defeatedIncarnations.set(defeated.card.id, defeated.card.incarnation);
                    discardAttachments(defeated);
                    if (!('t' in defeated.card) || !defeated.card.t) state.players[defeated.card.owner ?? outcome.seat].discard.push(ref(defeated.card));
                }
                break;
            }
            case 'return': {
                if(outcome.fromZone==='hand'){
                    const w=outcome.handBottom,returned=find(outcome.card,e=>!e.parent&&e.zone==='hand'&&e.seat===outcome.fromSeat&&present(e));
                    if(!w||outcome.prevented||!actualEvent(outcome)||!returned||outcome.seat!==cue.seat||w.player!==cue.seat||outcome.fromSeat!==cue.seat||outcome.ownerSeat!==cue.seat||returned.card.owner!==cue.seat||outcome.zone!=='deck'||outcome.destination!=='deck-bottom'||outcome.selection!=='chosen'||outcome.chooserSeat!==cue.seat||returned.card.n!==outcome.card?.n||returned.card.s!==outcome.card?.s||!player.knownDeck||player.knownDeck.length!==player.deck)fail('hand bottom requires actual selected own hand card, source, owner and complete deck');
                    const draw=actualDraws.get(cue.source!.id!),prior=handBottoms.get(w.id),tokens=player.ground.concat(player.space).filter(u=>u.t===1);
                    if(!draw||draw.seat!==cue.seat||draw.ids.length!==2||JSON.stringify(draw.ids)!==JSON.stringify(w.drawnIds)||tokens.length||w.tokenUnitIdsAtResolution.length||w.selectedIds.length!==2||new Set(w.selectedIds).size!==2||w.order.length!==2||new Set(w.order).size!==2||w.order.some(id=>!w.selectedIds.includes(id))||prior&&JSON.stringify(prior.w)!==JSON.stringify(w))fail('hand bottom needs actual two draws, zero controlled token units and exact two-card chosen order');
                    const g=prior??{w:structuredClone(w),moved:new Set<string>()};if(!prior){if(w.selectedIds.some(id=>!player.hand.some(c=>c.id===id&&c.owner===cue.seat)))fail('bottom selection outside actual post-draw hand');handBottoms.set(w.id,g);}
                    if(w.order[g.moved.size]!==returned.card.id||g.moved.has(returned.card.id!))fail('hand bottom actual movement must follow chosen order exactly once');
                    remove(returned);const arrived=ref(returned.card);player.knownDeck.push(arrived);player.deck++;returned.card=arrived;returned.zone='deck';g.moved.add(arrived.id!);break;
                }
                // The receipt names an intact unit or attachment, not a host-wide defeat or search.
                const returned = find(outcome.card, entry => arena(entry) && !entry.captive
                    && (outcome.fromSeat === undefined || entry.seat === outcome.fromSeat)
                    && (outcome.fromZone === undefined || entry.zone === outcome.fromZone));
                if (returned && present(returned)) {
                    if(isUnit(returned.card)&&returned.card.cap?.length)fail('captor return requires separately supplied captive cleanup');
                    const owner = outcome.ownerSeat ?? returned.card.owner ?? outcome.seat;
                    if (returned.card.owner && owner !== returned.card.owner || outcome.seat !== owner) fail('return destination contradicts actual ownership');
                    if (returned.parent) {
                        if (outcome.sourceCard && !same(returned.parent, outcome.sourceCard)) fail('upgrade return names a different host');
                        const upgrade = returned.card as UpgradeRef;
                        returned.parent.p = Math.max(0, returned.parent.p - (upgrade.p ?? 0));
                        returned.parent.h = Math.max(0, returned.parent.h - (upgrade.h ?? 0));
                    }
                    remove(returned);
                    discardAttachments(returned);
                    if ('t' in returned.card && returned.card.t) break; // Tokens cease; they never become hand/deck cards.
                    const destination = state.players[owner];
                    if (outcome.destination === 'deck-bottom') {
                        if (!destination.knownDeck || destination.knownDeck.length !== destination.deck) fail('deck-bottom return needs a complete staged destination deck');
                        destination.knownDeck!.push(ref(returned.card));
                        destination.deck += 1;
                    } else {
                        const old=isUnit(returned.card)?returned.card.incarnation:undefined,id=returned.card.id,arrived=ref(returned.card);
                        destination.hand.push(arrived);
                        if(!returned.parent&&id&&old)returnedUnits.set(id,{incarnation:old,ownerSeat:owner});
                        returned.card=arrived;returned.parent=undefined;returned.captive=undefined;returned.seat=owner;returned.zone='hand';
                    }
                }
                break;
            }
            case 'discard': {
                if(outcome.fromZone==='capture'){
                    const guard=find(outcome.sourceCard,e=>arena(e)&&!e.parent&&present(e)&&e.seat===outcome.fromSeat);
                    const captive=find(outcome.card,e=>e.captive===true && e.parent===guard?.card && present(e));
                    if(!guard || guard.seat!==cue.seat || !captive || captive.card.n!==outcome.card?.n || captive.card.s!==outcome.card?.s || guard.card.n!==outcome.sourceCard?.n || guard.card.s!==outcome.sourceCard?.s || !captive.card.owner || outcome.ownerSeat!==captive.card.owner || outcome.seat!==captive.card.owner || outcome.zone!=='discard')fail('captured discard requires actual friendly guard, exact live pocket and owner discard');
                    const arriving=ref(captive.card);remove(captive);state.players[outcome.seat].discard.push(arriving);
                    captive.card=arriving;captive.parent=undefined;captive.captive=undefined;captive.zone='discard';captive.seat=outcome.seat;
                    if(arriving.id)discardedIds.add(arriving.id);break;
                }
                if (outcome.baseDamagePhase) {
                    const evidence = state.baseDamagedThisPhase, condition = outcome.baseDamagePhase;
                    if (!evidence || evidence.round !== state.round || evidence.phase !== state.phase
                        || condition.round !== evidence.round || condition.phase !== evidence.phase
                        || !evidence.damage.some(damage => damage.player === condition.player && damage.targetId === condition.targetId
                            && damage.amount > 0 && Number.isFinite(damage.amount) && !!damage.sourceId)
                        || state.players[outcome.seat].base.id !== condition.targetId || condition.player === outcome.seat) fail('conditional discard lacks actual current-phase damage by this player to the opponent base');
                }
                const origin = outcome.fromZone ?? 'hand';
                const fromSeat = outcome.fromSeat ?? outcome.seat;
                const discarded = find(outcome.card, entry => entry.seat === fromSeat && entry.zone === origin && !entry.parent);
                if (origin === 'deck' && (!discarded || !present(discarded))) fail('selected deck discard is missing or already moved');
                if(outcome.requiresDiscard){const h=outcome.sequenceId?privateHands.get(outcome.sequenceId):undefined;
                    if(!h||h.sourceId!==cue.source?.id||h.seat!==fromSeat||h.selectedId!==outcome.card?.id||outcome.sequenceIndex!==2||outcome.selection!=='chosen'||outcome.chooserSeat!==cue.seat||!discarded||!present(discarded))fail('selected opponent discard requires its actual prior private whole-hand inspection');privateHands.delete(outcome.sequenceId!);
                }
                if(outcome.prevented)break;
                if (discarded && present(discarded)) {
                    if(origin==='deck'&&discarded.card.id)discardedDeckIds.add(discarded.card.id);
                    if (origin === 'deck') consumeDeckSelection(fromSeat, discarded.card);
                    remove(discarded);
                    state.players[outcome.ownerSeat ?? discarded.card.owner ?? outcome.seat].discard.push(ref(discarded.card));
                    if (discarded.card.id) discardedIds.add(discarded.card.id);
                    if(origin==='hand'&&discarded.card.id&&actualEvent(outcome)&&discarded.card.id!==cue.source?.id)successfulHandDiscards.set(discarded.card.id,{seat:fromSeat,sourceId:cue.source!.id!,owner:discarded.card.owner,destination:outcome.ownerSeat??discarded.card.owner??outcome.seat});
                    if(outcome.choice?.kind==='opponent-random-discard'&&randomDiscardBranch)randomDiscardBranch.discarded=true;
                }
                break;
            }
            case 'recover': {
                const recovered = find(outcome.card, entry => entry.seat === outcome.seat && entry.zone === 'discard' && !entry.parent);
                if (outcome.prevented) break;
                if (recovered && present(recovered)) {
                    if (outcome.defeatPhase) {
                        const evidence = state.defeatedThisPhase;
                        if (!evidence || evidence.round !== state.round || evidence.phase !== state.phase
                            || outcome.defeatPhase.round !== evidence.round || outcome.defeatPhase.phase !== evidence.phase
                            || !evidence.cards.some(card => card.id === recovered.card.id)) fail('this-phase recovery lacks actual current-phase defeat evidence');
                    }
                    remove(recovered);
                    if (outcome.zone === 'deck') { player.deck += 1; player.knownDeck?.push(ref(recovered.card)); }
                    else player.hand.push(ref(recovered.card));
                }
                break;
            }
            case 'draw':
            case 'mill': {
                if(outcome.bountyResolution){const b=outcome.bountyResolution,host=entries.find(e=>!e.parent&&e.card.id===b.hostId&&arena(e)),original=before.players.p1.ground.concat(before.players.p1.space,before.players.p2.ground,before.players.p2.space).find(c=>c.id===b.hostId);
                    const grant=original?.u?.find(u=>u.id===b.abilitySourceId);
                    if(!original||original.incarnation!==b.incarnation||!host&& !returnedUnits.has(b.hostId)||!grant||grant.s!=='SHD_176'
                        ||b.collector!==outcome.seat||b.collector!==cue.seat||b.kind!=='draw'||b.amount!==2||count(outcome.amount)!==2||b.index!==1||resolvedBounties.has(b.id))fail('Bounty draw requires actual before-host Death Mark grant, collector and once-only amount');
                    resolvedBounties.add(b.id);
                }
                if (outcome.requiresDefeat && defeatedIncarnations.get(outcome.requiresDefeat.id) !== outcome.requiresDefeat.incarnation) fail('draw requires actual successful defeat of this exact incarnation');
                const amount = Math.min(player.deck, count(outcome.amount, 1));
                if (outcome.cards && outcome.cards.length !== amount) fail('declared moved deck cards contradict actual draw or mill count');
                const destination = outcome.kind === 'draw' ? player.hand : player.discard;
                player.deck -= amount;
                for (let n = 0; n < amount; n++) {
                    const known = player.knownDeck?.shift();
                    const declared = outcome.cards?.[n] ?? (amount === 1 ? outcome.card : undefined);
                    if (known && declared && (!same(known, declared)||cue.outcomes?.some(o=>o.handBottom)&&(known.n!==declared.n||known.s!==declared.s||known.owner!==declared.owner))) throw new Error(`Showcase ${cue.definition.id}: draw receipt contradicts known deck order`);
                    if (known && outcome.kind === 'draw') consumeDeckSelection(outcome.seat, known);
                    const arriving=known ? ref(known) : declared ? ref(declared) : {
                        n: 'Unknown card', s: null, id: generatedId(`${index}:${outcome.kind}:${n}`)
                    };
                    destination.push(arriving);
                    const moved=known?entries.find(e=>e.card===known&&!e.parent&&e.zone==='deck'&&e.seat===outcome.seat):undefined;
                    if(moved){moved.card=arriving;moved.zone=outcome.kind==='draw'?'hand':'discard';}
                    else entries.push({card:arriving,seat:outcome.seat,zone:outcome.kind==='draw'?'hand':'discard'});
                }
                if(outcome.kind==='draw'&&actualEvent(outcome)&&outcome.cards){const key=cue.source!.id!,prior=actualDraws.get(key);if(prior&&prior.seat!==outcome.seat)actualDraws.delete(key);else actualDraws.set(key,{seat:outcome.seat,ids:[...(prior?.ids??[]),...outcome.cards.map(c=>c.id!)]});}
                break;
            }
            case 'control': {
                if(outcome.sequenceId){const e=find(outcome.card,x=>arena(x)&&!x.parent&&present(x)&&x.seat===outcome.fromSeat),u=outcome.unit;
                    if(!e||!isUnit(e.card)||e.card.leaderUnit!==false||!e.card.incarnation||outcome.incarnation!==e.card.incarnation||!actualEvent(outcome)||outcome.sequenceIndex!==1||controlSequences.has(outcome.sequenceId)||outcome.duration!=='permanent'||outcome.zone!==e.zone||outcome.fromZone!==e.zone||outcome.ownerSeat!==e.card.owner||outcome.card?.n!==e.card.n||outcome.card?.s!==e.card.s||!u||JSON.stringify(u)!==JSON.stringify(e.card))fail('sequential control requires actual nonleader same-entry full unit truth, source, owner and first index');
                    const controller=outcome.prevented?e.seat:outcome.seat;controlSequences.set(outcome.sequenceId,{id:e.card.id!,incarnation:e.card.incarnation,controller,complete:false});if(outcome.prevented||e.seat===outcome.seat)break;
                    remove(e,false);player[e.zone as 'ground'|'space'].push(e.card);e.seat=outcome.seat;for(const child of entries)if(child.parent===e.card)child.seat=outcome.seat;break;
                }
                const controlled = find(outcome.card, entry => arena(entry) && !entry.parent && entry.seat === outcome.fromSeat);
                if (!controlled || !present(controlled) || !isUnit(controlled.card)) break;
                const zone = outcome.zone === 'space' ? 'space' : 'ground';
                if (controlled.zone !== zone) throw new Error(`Showcase ${cue.definition.id}: changing controller cannot change arena`);
                remove(controlled, false);
                if (outcome.controlExchange) {
                    const after=outcome.unit;
                    if(!outcome.controlExchange || !after || after.owner!==controlled.card.owner) fail('permanent control requires paired exact final unit truth');
                    for (const u of controlled.card.u??[]) if(u.t){const declared=after!.u?.find(c=>same(c,u));if(!declared)fail('missing final token');u.owner=declared!.owner;u.controller=declared!.controller;}
                    controlled.card.status=structuredClone(after!.status);
                } else {
                    if (outcome.ownerSeat && controlled.card.owner && controlled.card.owner!==outcome.ownerSeat) fail('control cannot change unit ownership');
                    if (outcome.ownerSeat) controlled.card.owner = outcome.ownerSeat;
                    (controlled.card.status ??= []).push({ kind: 'control', label: `Owner: ${controlled.card.owner ?? 'unknown'}`, duration: 'regroup' });
                }
                player[zone].push(controlled.card);
                controlled.seat = outcome.seat;
                for(const child of entries)if(child.parent===controlled.card)child.seat=outcome.seat;
                break;
            }
            case 'play': {
                if(outcome.entryType==='detached')fail('detached Pilot is not a played entry');
                if(outcome.entryType==='created')fail('created token entry cannot use existing-card play handler');
                if (outcome.entryType === 'rescued') fail('rescued entry cannot use the play handler');
                const fromSeat = outcome.fromSeat ?? outcome.seat, fromZone = outcome.fromZone ?? 'hand';
                const played = find(outcome.card, entry => entry.seat === fromSeat && entry.zone === fromZone && !entry.parent);
                if (fromZone === 'deck' && (!played || !present(played))) fail('selected deck play is missing or already moved');
                if(outcome.playAs==='upgrade'){
                    const host=find(outcome.targetCard,e=>arena(e)&&!e.parent&&present(e)&&e.seat===outcome.seat),upgrade=outcome.upgrade,permission=outcome.upgradePlayPermission;
                    if(permission){const h=state.defeatedThisPhase,p=outcome.defeatPhase;
                        if(permission.sourceId!==cue.source?.id || permission.player!==cue.seat || permission.player!==outcome.controllerSeat || permission.ignoreAspectPenalties!==true
                            || !p || !h || h.round!==state.round || h.phase!==state.phase || p.round!==h.round || p.phase!==h.phase
                            || !h.cards.some(c=>c.id===permission.defeated.id && c.incarnation===permission.defeated.incarnation && c.controller && c.controller!==permission.player && ['unit','leader-unit'].includes(c.lastKnownType??''))
                            || fromZone!=='discard' && !(fromZone==='hand' && fromSeat===permission.player) || !played?.card.id || paidPlayers.get(played.card.id)!==permission.player
                            || outcome.printedCost===undefined || !Number.isSafeInteger(outcome.printedCost) || outcome.printedCost<0 || (paidUnits.get(played.card.id)??-1)<outcome.printedCost)fail('upgrade play permission needs actual current-phase enemy-unit defeat, causing event, playing payer and allowed origin');
                    }
                    if(!played||!present(played)||!host||!isUnit(host.card)||!upgrade||!same(played.card,upgrade)||played.card.n!==upgrade.n||played.card.s!==upgrade.s
                        ||upgrade.t!==0||upgrade.owner!==played.card.owner||outcome.ownerSeat!==upgrade.owner||upgrade.controller!==outcome.controllerSeat
                        ||outcome.controllerSeat!==(permission?.player??fromSeat)||!played.card.id||!paidUnits.has(played.card.id)||outcome.unit||outcome.entersReady!==undefined
                        ||outcome.zone!==host.zone||upgrade.p===undefined||upgrade.h===undefined)fail('upgrade play requires actual paid source, legal host and complete owner/controller/contributions');
                    if(fromZone==='deck')consumeDeckSelection(fromSeat,played.card);
                    remove(played);const arriving=structuredClone(upgrade);(host.card.u??=[]).push(arriving);host.card.p+=arriving.p!;host.card.h+=arriving.h!;
                    played.card=arriving;played.parent=host.card;played.zone=host.zone;played.seat=host.seat;break;
                }
                if (!played || !present(played) || !outcome.unit || !same(played.card, outcome.unit)) break;
                if (played.card.s !== outcome.unit.s || played.card.n !== outcome.unit.n) fail('played unit contradicts the selected face');
                if(outcome.requiresReturn && (outcome.unit.d!==0||outcome.unit.u?.length||outcome.unit.status?.length||outcome.unit.cap?.length||outcome.unit.incarnation===outcome.requiresReturn.incarnation))fail('returned replay requires clean fresh arena entry');
                if (played.card.owner && played.card.owner !== outcome.unit.owner) fail('played card ownership must be preserved');
                if (fromZone === 'discard' || fromZone === 'resources' || outcome.requiresReturn) {
                    if (!played.card.id || !paidUnits.has(played.card.id)) fail('discard/resource play needs an explicit linked unit payment, including known zero');
                }
                if (played.card.id && privateChoices.get(played.card.id) === 'leave') fail('private top choice left this card in deck');
                if (outcome.entersReady === true && outcome.unit.x || outcome.entersReady === false && !outcome.unit.x) fail('played unit pose contradicts explicit entry readiness');
                const zone = outcome.zone === 'space' ? 'space' : 'ground';
                if (fromZone === 'deck') consumeDeckSelection(fromSeat, played.card);
                if (fromZone === 'resources') {
                    const revealed = revealedResources.get(fromSeat), swap = outcome.resourceReadySwap, resource = played.card as ResourceRef;
                    if (!revealed || revealed.playIds[revealed.next] !== resource.id || !revealed.ids.includes(resource.id!)) fail('resource play must follow its actual revealed chosen sequence');
                    if (swap) {
                        const replacement = state.players[fromSeat].resources?.find(c => c.id === swap.exhaustedId);
                        if (swap.readyId !== resource.id || resource.x || !replacement?.x || replacement === resource) fail('resource readiness swap contradicts actual ready/exhausted members');
                        resource.x = 1; delete replacement.x;
                    } else if (!resource.x && state.players[fromSeat].resources?.some(c => c !== resource && c.x)) fail('ready resource departure requires its explicit readiness swap');
                    revealed.next += 1;
                }
                remove(played);
                const entering = structuredClone(outcome.unit);
                player[zone].push(entering);
                // Subsequent receipts refer to the entered instance, not its former minimal hand reference.
                played.card = entering;
                if (entering.id && entering.incarnation) playedEntries.set(entering.id,entering.incarnation);
                played.seat = outcome.seat;
                played.zone = zone;
                if (played.card.id && state.mostRecentIncarnations && entering.incarnation) state.mostRecentIncarnations[played.card.id] = entering.incarnation;
                if (played.card.id && outcome.printedCost !== undefined) {
                    if (!Number.isSafeInteger(outcome.printedCost) || outcome.printedCost < 0) fail('played printed cost must be explicit and nonnegative');
                    playedCosts.set(played.card.id, outcome.printedCost);
                }
                break;
            }
            case 'create': {
                if(outcome.prevented)fail('prevented token creation is unsupported by this narrow staged receipt');
                if(['JTL_130','JTL_155'].includes(cue.source?.s??'')&&outcome.unit?.id&&outcome.unit.incarnation===state.mostRecentIncarnations?.[outcome.unit.id])fail('generated entry cannot reuse its previous incarnation');
                const u=outcome.unit,type=outcome.tokenType,clone=type==='clone-trooper',wing=type==='x-wing',tie=type==='tie-fighter',power=clone||wing?2:1;
                const cause=!!outcome.sourceCard?.id&&(outcome.whenDefeatedOrigin?outcome.sourceCard?.id===outcome.whenDefeatedOrigin.subjectId:outcome.sourceCard?.id===cue.source?.id&&outcome.sourceCard?.n===cue.source?.n&&outcome.sourceCard?.s===cue.source?.s&&!!cue.source?.id);
                if(!u||!u.id||occupiedIds.has(u.id)||!u.incarnation||JSON.stringify(outcome.card)!==JSON.stringify(u)||outcome.incarnation!==u.incarnation||!['battle-droid','clone-trooper','x-wing','tie-fighter'].includes(type??'')||outcome.entryType!=='created'||outcome.amount!==1||outcome.zone!==((wing||tie)?'space':'ground')||outcome.fromZone!==undefined||(outcome.entersReady===true?u.x!==undefined:outcome.entersReady!==false||u.x!==1)||u.t!==1||u.n!==(tie?'TIE Fighter':wing?'X-Wing':clone?'Clone Trooper':'Battle Droid')||u.s!==null||u.p!==power||u.h!==power||u.d!==0||u.u?.length||u.cap?.length||u.status?.length||u.owner!==outcome.seat||outcome.ownerSeat!==u.owner||!cause)fail('creation needs a distinct fresh exact token entry with explicit pose, owner and event or validated granted-ability cause');
                if(wing&&(u.printedTitle!=='X-Wing'||u.unique!==false||u.leaderUnit!==false||JSON.stringify(u.traits)!==JSON.stringify(['vehicle','fighter'])||outcome.entersReady!==false))fail('X-Wing creation requires exact exhausted space Vehicle/Fighter token body without Rebel');
                if(tie&&(u.printedTitle!=='TIE Fighter'||u.unique!==false||u.leaderUnit!==false||JSON.stringify(u.traits)!==JSON.stringify(['vehicle','fighter'])||outcome.entersReady!==true))fail('TIE creation requires exact ready space Vehicle/Fighter token with no Imperial trait');
                const entering=structuredClone(u),zone=wing||tie?'space':'ground';occupiedIds.add(u.id);player[zone].push(entering);entries.push({card:entering,seat:outcome.seat,zone});break;
            }
            case 'rescue': {
                const cleanup=outcome.captiveCleanupId?captiveCleanups.get(outcome.captiveCleanupId):undefined;
                const captor = cleanup?.captor ?? find(outcome.sourceCard, entry => arena(entry) && !entry.parent && present(entry)
                    && entry.seat === outcome.fromSeat && entry.zone === outcome.fromZone);
                const captive = cleanup ? cleanup.remaining.get(outcome.card?.id??'') : find(outcome.card, entry => entry.captive === true && entry.parent === captor?.card && present(entry));
                if (outcome.captiveCleanupId && (!cleanup || !captor || present(captor) || captor.seat!==outcome.fromSeat || captor.zone!==outcome.fromZone
                    || !outcome.sourceCard || !same(captor.card,outcome.sourceCard)
                    || defeatedIncarnations.get(captor.card.id!)!==cleanup.incarnation)) fail('departed-captor rescue requires its exact successful prior leave-play cleanup');
                const entering = outcome.unit, owner = captive?.card.owner;
                if (!captor || !captive || !entering || !owner || outcome.ownerSeat !== owner || outcome.seat !== owner
                    || outcome.entryType !== 'rescued' || !same(captive.card, entering) || entering.owner !== owner
                    || entering.n !== captive.card.n || entering.s !== captive.card.s || !entering.incarnation
                    || state.mostRecentIncarnations?.[entering.id!] === entering.incarnation
                    || entering.d !== 0 || entering.u?.length || entering.cap?.length || entering.status?.length
                    || state.attacksThisPhase?.attacks.some(attack => attack.attackerId === entering.id && attack.incarnation === entering.incarnation)
                    || outcome.entersReady === false && !entering.x || outcome.entersReady === true && entering.x
                    || entries.some(entry => !entry.parent && arena(entry) && present(entry) && entry.card.id === entering.id)) fail('rescue requires actual captor pocket, known owner and complete fresh rescued entry');
                const zone = outcome.zone === 'space' ? 'space' : outcome.zone === 'ground' ? 'ground' : fail('rescue destination must be an actual arena');
                remove(captive);
                if (cleanup) cleanup.remaining.delete(captive.card.id!);
                const arrived = structuredClone(entering);
                state.players[owner][zone].push(arrived);
                if (arrived.id && state.mostRecentIncarnations) state.mostRecentIncarnations[arrived.id] = arrived.incarnation!;
                captive.card = arrived; captive.parent = undefined; captive.captive = undefined; captive.zone = zone; captive.seat = owner;
                break;
            }
            case 'attach': {
                if(outcome.pilotDetach){const w=outcome.pilotDetach,moved=find(outcome.card,e=>arena(e)&&!!e.parent&&!e.captive&&present(e)),host=moved?.parent,pilot=moved?.card as UpgradeRef|undefined,u=outcome.unit;
                    if(!moved||!host||!pilot||!u||!actualEvent(outcome)||outcome.targetCard||outcome.upgrade||pilot.unitUpgrade!==true||!pilot.traits?.includes('pilot')||pilot.t!==0||w.hostId!==host.id||w.hostIncarnation!==host.incarnation||w.upgradeId!==pilot.id||outcome.card?.n!==pilot.n||outcome.card?.s!==pilot.s||outcome.fromSeat!==moved.seat||outcome.fromZone!==moved.zone||outcome.seat!==moved.seat||outcome.controllerSeat!==moved.seat||pilot.controller!==moved.seat||outcome.ownerSeat!==pilot.owner||u.owner!==pilot.owner||u.id!==pilot.id||u.n!==pilot.n||u.s!==pilot.s||outcome.zone!=='ground'||outcome.entryType!=='detached'||outcome.entersReady!==false||!u.incarnation||u.incarnation===state.mostRecentIncarnations?.[u.id!]||outcome.incarnation!==u.incarnation||u.x!==1||u.d!==0||u.u?.length||u.cap?.length||u.status?.some(x=>x.duration!=='permanent')||u.leaderUnit!==false||!u.traits?.includes('pilot')||pilot.p===undefined||pilot.h===undefined)fail('Pilot detach requires exact actual unit-upgrade, host entry, owner/current controller and fresh exhausted ground body, without transfer/play metadata');
                    if(outcome.prevented)break;
                    host.p=Math.max(0,host.p-pilot.p);host.h=Math.max(0,host.h-pilot.h);host.status=host.status?.filter(x=>x.attachmentId!==pilot.id);remove(moved);const arriving=structuredClone(u);player.ground.push(arriving);moved.card=arriving;moved.parent=undefined;moved.zone='ground';if(state.mostRecentIncarnations)state.mostRecentIncarnations[u.id!]=u.incarnation;break;
                }
                if(outcome.entryType==='detached')fail('detached entry requires explicit Pilot detach witness');
                const moved = find(outcome.card, entry => arena(entry) && !!entry.parent && !entry.captive && present(entry));
                const old = find(outcome.sourceCard, entry => arena(entry) && !entry.parent && present(entry));
                const target = find(outcome.targetCard, entry => arena(entry) && !entry.parent && present(entry) && entry.seat === outcome.seat);
                const upgrade = outcome.upgrade;
                if (!moved || !old || !target || moved.parent !== old.card || !isUnit(old.card) || !isUnit(target.card)
                    || moved.seat !== outcome.fromSeat || moved.zone !== outcome.fromZone || target.zone !== outcome.zone
                    || !upgrade || !same(moved.card,upgrade) || upgrade.owner !== moved.card.owner || upgrade.owner !== outcome.ownerSeat
                    || upgrade.controller !== outcome.controllerSeat || outcome.controllerSeat !== cue.seat || upgrade.t !== 0
                    || upgrade.n !== moved.card.n || upgrade.s !== moved.card.s || upgrade.p === undefined || upgrade.h === undefined
                    || upgrade.p !== (moved.card as UpgradeRef).p || upgrade.h !== (moved.card as UpgradeRef).h) fail('attachment transfer needs exact source/new host, contributions, unchanged owner and explicit controller');
                if (old.card !== target.card) {
                    old.card.p = Math.max(0,old.card.p-upgrade.p); old.card.h = Math.max(0,old.card.h-upgrade.h);
                    remove(moved); target.card.p += upgrade.p; target.card.h += upgrade.h;
                    (target.card.u ??= []).push(moved.card as UpgradeRef);
                }
                Object.assign(moved.card,upgrade); moved.parent=target.card; moved.seat=target.seat; moved.zone=target.zone;
                break;
            }
            case 'capture': {
                const target = find(outcome.card, entry => arena(entry) && !entry.parent && present(entry) && entry.seat === outcome.fromSeat && entry.zone === outcome.fromZone);
                const captor = find(outcome.sourceCard, entry => arena(entry) && !entry.parent && present(entry) && entry.seat === outcome.seat);
                const basis = outcome.captureBasis, history = state.attacksThisPhase,cost=outcome.captureCost,captureArena=outcome.captureArena,selection=outcome.captureSelection;
                if (!target || !captor || !isUnit(target.card) || !isUnit(captor.card) || target === captor || target.card.cap?.length
                    || !target.card.owner || outcome.ownerSeat !== target.card.owner || target.seat === captor.seat || captor.seat !== cue.seat
                    || target.card.id === state.players[target.card.owner].leader?.id || outcome.incarnation !== target.card.incarnation)fail('capture requires actual current enemy incarnation, friendly captor and owner');
                if([basis,cost,captureArena,selection].filter(Boolean).length!==1)fail('capture needs exactly one supported concrete cost, base-attack or same-arena witness');
                if(captureArena&&(captureArena.captorId!==captor.card.id||captureArena.incarnation!==captor.card.incarnation||captureArena.arena!==captor.zone||target.zone!==captor.zone))fail('same-arena capture requires exact current friendly captor entry and matching target arena');
                if(cost){if(target.card.n!==outcome.card?.n || target.card.s!==outcome.card?.s || captor.card.n!==outcome.sourceCard?.n || captor.card.s!==outcome.sourceCard?.s)fail('cost capture faces contradict actual target or captor');if(!Number.isSafeInteger(cost.captorPrintedCost)||!Number.isSafeInteger(cost.targetPrintedCost)||cost.captorPrintedCost<0||cost.targetPrintedCost<0||cost.targetPrintedCost>cost.captorPrintedCost)fail('capture printed-cost comparison is invalid');}
                else if(!captureArena&&!selection&&(!basis || !history || history.round !== state.round || history.phase !== state.phase || basis.round !== history.round || basis.phase !== history.phase
                    || basis.attackerId !== target.card.id || basis.incarnation !== target.card.incarnation || basis.attackingSeat === cue.seat || basis.defendingSeat !== cue.seat
                    || basis.targetId !== state.players[cue.seat].base.id || !history.attacks.some(attack=>attack.id===basis.attackId && attack.attackerId===basis.attackerId
                        && attack.incarnation===basis.incarnation && attack.attackingSeat===basis.attackingSeat && attack.defendingSeat===basis.defendingSeat && attack.targetIds?.includes(basis.targetId)))) fail('capture requires actual witnessed own-base attack');
                if(outcome.prevented)break;
                remove(target); discardAttachments(target);
                if(target.card.t)break; // Explicit unit tokens cease outside arenas, including capture.
                const captive = ref(target.card); (captor.card.cap ??= []).push(captive);
                target.card=captive; target.parent=captor.card; target.captive=true; target.seat=captor.seat; target.zone=captor.zone;
                break;
            }
            case 'search': {
                if (outcome.deckOperation) {
                    const operation = outcome.deckOperation, manifest = player.knownDeck;
                    if (!manifest || manifest.length !== player.deck) fail('deck operation requires a complete staged manifest');
                    const originalIds = stableIds(manifest!, 'deck manifest'), lookedIds = stableIds(operation.looked, 'looked group');
                    const orderedIds = stableIds(operation.remainingOrder, 'deck permutation'), chosen = operation.selectedIds;
                    const declaredFaces = [...operation.looked, ...operation.remainingOrder];
                    if (declaredFaces.some(card => !manifest!.some(original => original.id === card.id && original.n === card.n && original.s === card.s
                        && original.owner === card.owner))) fail('deck operation contradicts known faces or ownership');
                    if (orderedIds.length !== originalIds.length || orderedIds.some(id => !originalIds.includes(id))) fail('deck operation is not an exact permutation');
                    if (new Set(chosen).size !== chosen.length || chosen.some(id => !lookedIds.includes(id))) fail('selection is outside the looked group or repeats a card');
                    if (operation.revealedIds && (new Set(operation.revealedIds).size !== operation.revealedIds.length || operation.revealedIds.some(id=>!chosen.includes(id)))) fail('publicly revealed IDs must belong to the actual selected group');
                    if (operation.scope === 'whole' && lookedIds.length !== originalIds.length || lookedIds.some((id, i) => originalIds[i] !== id)) fail('looked group contradicts the declared scope or known deck top');
                    if (operation.selectionLimit !== undefined && chosen.length > operation.selectionLimit) fail('deck selection exceeds its count limit');
                    if (operation.printedCostLimit !== undefined) {
                        const costs = chosen.map(id => operation.printedCosts?.[id]);
                        if (costs.some(cost => cost === undefined || !Number.isSafeInteger(cost) || cost < 0)
                            || costs.reduce<number>((total, cost) => total + cost!, 0) > operation.printedCostLimit) fail('selected printed costs exceed or lack the declared budget');
                    }
                    if (operation.reveal) {
                        const sequence = operation.reveal;
                        if (operation.scope !== 'top' || operation.visibility !== 'public' || !lookedIds.length
                            || !Number.isSafeInteger(sequence.limit) || sequence.limit < 1 || lookedIds.length > sequence.limit
                            || !Number.isSafeInteger(sequence.damageThreshold) || sequence.damageThreshold < 0
                            || sequence.runningTotals.length !== lookedIds.length
                            || sequence.stop === 'limit' && lookedIds.length !== sequence.limit
                            || sequence.stop === 'deck-end' && lookedIds.length !== manifest!.length) fail('sequential reveal contradicts public prefix, limit or stop decision');
                        let total = 0;
                        for (const [i, id] of lookedIds.entries()) {
                            const cost = operation.printedCosts?.[id];
                            if (cost === undefined || !Number.isSafeInteger(cost) || cost < 0) fail('sequential reveal requires actual printed costs');
                            total += cost!;
                            if (sequence.runningTotals[i] !== total) fail('sequential reveal running total contradicts actual printed costs');
                            revealedCosts.set(id, cost!);
                        }
                    }
                    const untouched = originalIds.slice(lookedIds.length), unchosen = lookedIds.filter(id => !chosen.includes(id));
                    if (operation.policy === 'whole-search-shuffle') {
                        if (operation.scope !== 'whole' || chosen.some((id, i) => orderedIds[i] !== id)) fail('whole-deck search must preserve its selections for the following move');
                    } else if (operation.policy === 'top-search-bottom') {
                        const prefix = [...chosen, ...untouched];
                        if (operation.scope !== 'top' || prefix.some((id, i) => orderedIds[i] !== id)
                            || orderedIds.slice(prefix.length).some(id => !unchosen.includes(id))) fail('top search must preserve untouched cards and put only unchosen looked cards at bottom');
                    } else {
                        const kept = orderedIds.slice(0, unchosen.length);
                        if (operation.scope !== 'top' || operation.visibility !== 'public' || kept.some(id => !unchosen.includes(id))
                            || untouched.some((id, i) => orderedIds[kept.length + i] !== id)
                            || chosen.some((id, i) => orderedIds[kept.length + untouched.length + i] !== id)) fail('public top choice contradicts chosen top order, untouched remainder or selected discards');
                    }
                    const cardsById = new Map(manifest!.map(card => [card.id!, card]));
                    player.knownDeck = orderedIds.map(id => cardsById.get(id)!);
                    deckSelections.set(outcome.seat, new Set(chosen));
                    break;
                }
                if (!player.knownDeck || !outcome.cards) break;
                const looked = player.knownDeck.slice(0, outcome.cards.length);
                if (looked.length !== outcome.cards.length || looked.some((card, i) => !same(card, outcome.cards![i]))) {
                    throw new Error(`Showcase ${cue.definition.id}: searched group contradicts known deck top`);
                }
                const selected = outcome.card ? looked.find(card => same(card, outcome.card!)) : undefined;
                if (outcome.card && !selected) throw new Error(`Showcase ${cue.definition.id}: selection is outside the searched group`);
                // One deliberate possible random ordering, stable across replay. The selected card remains first
                // for the separate draw receipt; search alone does not add a card to hand or change deck count.
                const rest = looked.filter(card => card !== selected).reverse();
                player.knownDeck = [...(selected ? [selected] : []), ...player.knownDeck.slice(looked.length), ...rest];
                break;
            }
            case 'delay': {
                if(outcome.playerPending){const p=outcome.playerPending;
                    if(outcome.matchResult){const existing=state.pendingPlayers?.find(x=>x.id===p.id),result=outcome.matchResult;
                        if(cue.stage!=='regroup-start'||state.phase!=='regroup'||!existing||JSON.stringify(existing)!==JSON.stringify(p)||state.matchResult
                            ||result.sourceId!==p.sourceId||result.loser!==p.player||result.winner===(p.player)||result.winner==='draw'||p.player!==outcome.seat)fail('player loss requires its actual prior obligation and supplied regroup boundary');
                        state.matchResult=structuredClone(result);state.pendingPlayers=state.pendingPlayers!.filter(x=>x.id!==p.id);
                    }else{if(p.player!==cue.seat||p.sourceId!==cue.source?.id||state.matchResult||state.pendingPlayers?.some(x=>x.id===p.id))fail('player pending requires actual source player and no current result');(state.pendingPlayers??=[]).push(structuredClone(p));}
                    break;
                }
                if(outcome.pendingOperation==='consume'){
                    const p=outcome.pending,existing=p?state.pending?.find(x=>x.id===p.id):undefined;
                    if(!p||!existing||cue.stage!=='phase-end'||p.trigger!=='phase-end'||p.kind!=='return-to-hand'||JSON.stringify(existing)!==JSON.stringify(p)||consumedPending.has(p.id))fail('phase-end consumption requires exact actual pending and explicit boundary');
                    state.pending=state.pending!.filter(x=>x.id!==p.id);consumedPending.add(p.id);
                    for(const e of entries)if(isUnit(e.card)&&e.card.id===p.targetId&&e.card.incarnation===p.incarnation)e.card.status=e.card.status?.filter(x=>!(x.kind==='delay'&&x.duration==='phase'));
                    break;
                }
                if (!outcome.pending) break;
                const pending = outcome.pending;
                const subject = entries.find(entry => !entry.parent && arena(entry) && present(entry) && entry.card.id === pending.targetId);
                if (!subject || !isUnit(subject.card) || subject.card.incarnation !== pending.incarnation) {
                    throw new Error(`Showcase ${cue.definition.id}: delayed consequence must name the current arena incarnation`);
                }
                if (!(state.pending ??= []).some(effect => effect.id === pending.id)) state.pending.push(structuredClone(pending));
                (subject.card.status ??= []).push({ kind: 'delay', label: pending.kind === 'defeat' ? 'Defeat at regroup' : pending.trigger==='phase-end'?'Return to owner hand at phase end':'Return at regroup', duration: pending.trigger==='phase-end'?'phase':'regroup' });
                break;
            }
            case 'resource': {
                const amount = count(outcome.amount, 1);
                if (!amount) break;
                const supplied = find(outcome.card, entry => entry.seat === (outcome.fromSeat??outcome.seat) && entry.zone === (outcome.fromZone??'hand') && !entry.parent);
                if(outcome.fromZone==='deck'){
                    const top=player.knownDeck?.[0];
                    if(!smuggle || smuggleReplacement || !supplied || !present(supplied) || !top || !same(top,supplied.card) || amount!==1
                        || outcome.card?.n!==supplied.card.n || outcome.card?.s!==supplied.card.s || outcome.card?.owner!==supplied.card.owner
                        || outcome.fromSeat!==outcome.seat || outcome.seat!==cue.seat || outcome.ownerSeat!==outcome.seat || supplied.card.owner!==outcome.seat
                        || outcome.entersReady!==false || outcome.visibility!=='private' || !source || !outcome.sourceCard || !same(source.card,outcome.sourceCard))fail('Smuggle replacement needs its actual private deck top, exhausted entry and paid causing source');
                    smuggleReplacement=true;
                }
                if (outcome.fromZone === 'discard') {
                    const history = state.defeatedThisPhase, phase = outcome.defeatPhase;
                    if (!supplied || !present(supplied) || supplied.card.owner !== outcome.seat || !phase || !history || history.round !== state.round || history.phase !== state.phase
                        || phase.round !== history.round || phase.phase !== history.phase || !outcome.incarnation
                        || state.mostRecentIncarnations?.[supplied.card.id!] !== outcome.incarnation
                        || !history.cards.some(c=>c.id===supplied.card.id && c.incarnation===outcome.incarnation && c.lastKnownType==='unit')) fail('discard resourcing needs actual most-recent unit defeat this phase');
                }
                if (player.resources) {
                    if (amount !== 1 || !outcome.card?.id || player.resources.some(c=>same(c,outcome.card!))
                        || !supplied && !(source && same(source.card,outcome.card) && sourceBecomesResource)) fail('identified resource entry needs one actual origin card');
                    player.resources.push({...ref(supplied?.card??outcome.card),x:1});
                }
                if (supplied && present(supplied)) remove(supplied);
                player.res.total += amount;
                // These examples explicitly put the resource into play exhausted.
                break;
            }
            case 'pay':
                if (cue.playPayment?.kind === 'alternate-discard' && cue.playPayment.replacesAllCosts) fail('alternate payment replaces additional resource costs; no separate payment receipt is supported');
                payResources(outcome.seat, count(outcome.amount), 'additional payment', outcome.cards?.map(c=>c.id??fail('payment resource identity missing')));
                if (outcome.sourceCard?.id) {paidUnits.set(outcome.sourceCard.id,count(outcome.amount));paidPlayers.set(outcome.sourceCard.id,outcome.seat);}
                break;
            // These receipts describe presentation or a condition that Snapshot does not encode. An attack's
            // damage/exhaustion are separate receipts. A discount does not create or ready a resource.
            case 'suppress':
                if (unit && present(unit) && isUnit(unit.card)) {
                    delete unit.card.sn;
                    (unit.card.status ??= []).push({ kind: 'suppressed', label: 'Abilities off · phase', duration: 'phase' });
                }
                break;
            case 'keyword':
                if(outcome.generatedSet?.mechanic==='sentinel'){
                    const w=outcome.generatedSet;if(outcome.keywordOperation==='expire'){const u=outcome.unit,status=isUnit(unit?.card??{} as CardRef)?(unit!.card as UnitRef).status?.find(x=>x.generatedSentinel?.id===w.id):undefined,mark=status?.generatedSentinel;
                        if(cue.stage!=='phase-end'||!actualEvent(outcome)||cue.source?.s!=='JTL_130'||!unit||!present(unit)||!isUnit(unit.card)||!mark||!status||status.kind!=='keyword'||status.duration!=='phase'||status.keyword?.name!=='Sentinel'||status.keyword.amount!==1||status.round!==state.round||status.phase!==state.phase||status.incarnation!==unit.card.incarnation||unit.card.sn!==1||mark.subjectId!==unit.card.id||!u||outcome.prevented||outcome.incarnation!==unit.card.incarnation||w.sourceId!==cue.source?.id||w.round!==state.round||w.phase!==state.phase||w.members.length!==1||w.members[0].id!==unit.card.id||w.members[0].incarnation!==unit.card.incarnation||mark.sourceId!==w.sourceId||mark.round!==w.round||mark.phase!==w.phase||mark.incarnation!==unit.card.incarnation)fail('generated Sentinel expiry requires explicit original phase end and continuing bound entry');const expected=structuredClone(unit.card);expected.status=expected.status!.filter(x=>x.generatedSentinel?.id!==w.id);if(expected.status.some(x=>x.keyword?.name==='Sentinel'))fail('foreign Sentinel expiry needs actual ending truth');delete expected.sn;if(JSON.stringify(expected)!==JSON.stringify(u))fail('generated Sentinel expiry must preserve all other state');Object.assign(unit.card,structuredClone(u));delete unit.card.sn;
                    }else if(unit&&isUnit(unit.card)){unit.card.sn=1;(unit.card.status??=[]).push({kind:'keyword',label:'Sentinel · phase',duration:'phase',keyword:{name:'Sentinel',amount:1},round:state.round,phase:state.phase,incarnation:unit.card.incarnation,generatedSentinel:{id:w.id,sourceId:w.sourceId,subjectId:unit.card.id!,incarnation:unit.card.incarnation!,round:w.round,phase:w.phase}});}break;
                }

                if(outcome.keywordOperation==='expire'){
                    const w=outcome.keywordWindow,u=outcome.unit;
                    if(cue.stage!=='phase-end'||!w||!actualEvent(outcome)||outcome.prevented||!unit||!present(unit)||!isUnit(unit.card)||outcome.incarnation!==unit.card.incarnation||outcome.card?.n!==unit.card.n||outcome.card?.s!==unit.card.s||w.sourceId!==cue.source?.id||w.round!==state.round||w.phase!==state.phase||w.members.length!==1||w.members[0].id!==unit.card.id||w.members[0].incarnation!==unit.card.incarnation||!u)fail('keyword expiry requires explicit phase end, source-bound current entry and full ending truth');
                    const retained=unit.card.status?.filter(x=>x.keywordWindow?.id===w.id)??[],m=w.members[0];
                    if(retained.length!==2||retained.some(x=>x.keywordWindow?.sourceId!==w.sourceId||x.keywordWindow?.subjectId!==m.id||x.keywordWindow?.incarnation!==m.incarnation||x.keywordWindow?.nativeSentinel!==m.nativeSentinel||x.round!==state.round||x.phase!==state.phase||x.incarnation!==m.incarnation))fail('keyword expiry needs the exact retained gain/loss window');
                    const expected=structuredClone(unit.card);expected.status=expected.status!.filter(x=>x.keywordWindow?.id!==w.id);if(expected.status.some(x=>x.keyword?.name==='Sentinel'&&(!m.nativeSentinel||x.duration==='phase')||x.kind==='keyword'&&!x.keyword&&!x.lostKeyword))fail('foreign Sentinel gain/loss expiry requires authoritative ending truth');if(m.nativeSentinel)expected.sn=1;else delete expected.sn;
                    if(JSON.stringify(expected)!==JSON.stringify(u))fail('keyword expiry must preserve all other actual unit state and restore known native Sentinel only');Object.assign(unit.card,structuredClone(u));if(!u.sn)delete unit.card.sn;break;
                }
                if(outcome.keywordWindow){const w=outcome.keywordWindow,m=w.members.find(x=>x.id===unit?.card.id),u=unit!.card as UnitRef,mark={id:w.id,sourceId:w.sourceId,subjectId:m!.id,incarnation:m!.incarnation,round:w.round,phase:w.phase,nativeSentinel:m!.nativeSentinel};
                    if(outcome.keywordOperation==='gain'){u.sn=1;(u.status??=[]).push({kind:'keyword',label:'Sentinel · phase',duration:'phase',keyword:{name:'Sentinel',amount:1},keywordWindow:mark,round:state.round,phase:state.phase,incarnation:u.incarnation});}
                    else (u.status??=[]).push({kind:'keyword',label:'No Saboteur · phase',duration:'phase',lostKeyword:'Saboteur',keywordWindow:mark,round:state.round,phase:state.phase,incarnation:u.incarnation});break;
                }
                if(outcome.keywordOperation==='lose'){
                    if(!unit||!present(unit)||!isUnit(unit.card)||!actualEvent(outcome)||outcome.prevented||outcome.keyword?.name!=='Sentinel'||outcome.keyword.amount!==1||outcome.duration!=='phase'||outcome.incarnation!==unit.card.incarnation||outcome.round!==state.round)fail('standalone Sentinel loss needs actual current source/entry and phase');delete unit.card.sn;(unit.card.status??=[]).push({kind:'keyword',label:'No Sentinel · phase',duration:'phase',round:state.round,phase:state.phase,incarnation:unit.card.incarnation});break;
                }
                if (unit && present(unit) && isUnit(unit.card) && outcome.keyword) {
                    if(outcome.keyword.name==='Grit'){
                        const b=validateGrit(outcome,unit);
                        if(outcome.keyword.amount!==1||attackGrit.has(outcome.attackId!))fail('Grit is one attack-only boolean grant');
                        attackGrit.set(outcome.attackId!,structuredClone(b));break;
                    }
                    if(outcome.traitGrant){
                        const k=outcome.keyword;
                        if(k.name==='Sentinel')unit.card.sn=1;
                        (unit.card.status??=[]).push({kind:'keyword',label:`${k.name}${k.name==='Raid'?' 1':''} · phase`,duration:'phase',keyword:{...k},round:state.round,phase:state.phase,incarnation:unit.card.incarnation});break;
                    }
                    if (outcome.keyword.name === 'Saboteur') {
                        if (outcome.duration !== 'attack' || !outcome.attackId || !unit.card.id || outcome.keyword.amount !== 1) fail('Saboteur requires its actual attack-only grant');
                        attackKeywords.set(outcome.attackId!, { id: unit.card.id!, name: 'Saboteur' });
                        break;
                    }
                    if (outcome.duration !== 'phase' || !Number.isSafeInteger(outcome.keyword.amount) || outcome.keyword.amount < 0) fail('keyword grant requires its explicit amount and phase duration');
                    if(outcome.keyword.name==='Overwhelm'){
                        if(outcome.keyword.amount!==1||outcome.incarnation!==unit.card.incarnation||!actualEvent(outcome))fail('Overwhelm phase grant needs actual current entry, source and boolean amount');
                        (unit.card.status??=[]).push({kind:'keyword',label:'Overwhelm · phase',duration:'phase',keyword:{name:'Overwhelm',amount:1},round:state.round,phase:state.phase,incarnation:unit.card.incarnation});break;
                    }
                    if(outcome.keyword.name==='Restore'){
                        if(!outcome.sourceCard?.id||!cue.source?.id||!unit.card.incarnation||outcome.incarnation!==unit.card.incarnation||outcome.sourceCard?.id!==cue.source?.id||outcome.sourceCard?.n!==cue.source?.n||outcome.sourceCard?.s!==cue.source?.s)fail('Restore grant requires actual causing event and current unit entry');
                        (unit.card.status??=[]).push({kind:'keyword',label:`Restore ${outcome.keyword.amount} · phase`,duration:'phase',keyword:{...outcome.keyword},round:state.round,phase:state.phase,incarnation:unit.card.incarnation});break;
                    }
                    if(outcome.keyword.name==='Sentinel'){if(outcome.keyword.amount!==1)fail('Sentinel grant requires amount one');unit.card.sn=1;}
                    (unit.card.status ??= []).push({ kind: 'keyword', label: `${outcome.keyword.name}${outcome.keyword.name==='Ambush'?'':` ${outcome.keyword.amount}`} · phase`, duration: 'phase', keyword: { ...outcome.keyword } });
                }
                break;
            case 'restrict':
                if(outcome.generatedSet){const w=outcome.generatedSet;
                    if(!unit||!present(unit)||!isUnit(unit.card)||!actualEvent(outcome)||outcome.prevented||w.sourceId!==cue.source?.id||w.round!==state.round||w.phase!==state.phase||outcome.incarnation!==unit.card.incarnation||outcome.restriction!=='cannot-attack-base'||outcome.duration!=='phase')fail('generated restriction requires actual continuing source-bound entry');
                    if(outcome.restrictionOperation==='grant'){(unit.card.status??=[]).push({kind:'restrict',label:'Cannot attack bases · phase',duration:'phase',restriction:'cannot-attack-base',round:state.round,phase:state.phase,incarnation:unit.card.incarnation,generatedRestriction:{id:w.id,sourceId:w.sourceId,subjectId:unit.card.id!,incarnation:unit.card.incarnation!,round:w.round,phase:w.phase}});}
                    else if(outcome.restrictionOperation==='expire'){const u=outcome.unit,old=unit.card.status?.filter(x=>x.generatedRestriction?.id===w.id)??[],m=old[0]?.generatedRestriction;
                        if(cue.stage!=='phase-end'||!u||old.length!==1||!m||m.sourceId!==cue.source?.id||m.round!==state.round||m.phase!==state.phase||m.incarnation!==unit.card.incarnation||w.members.length!==1||w.members[0].id!==unit.card.id||w.members[0].incarnation!==unit.card.incarnation)fail('generated restriction expiry needs its retained exact current entry and explicit phase end');const expected=structuredClone(unit.card);expected.status=expected.status!.filter(x=>x.generatedRestriction?.id!==w.id);if(JSON.stringify(expected)!==JSON.stringify(u))fail('restriction expiry cannot change pose/stats/owner or unrelated status');Object.assign(unit.card,structuredClone(u));
                    }else fail('unsupported generated restriction operation');break;
                }
                if (outcome.nextAction) {
                    const action=outcome.nextAction;
                    if(action.operation==='add') {
                        const c=action.constraint;
                        if(!unit || !present(unit) || !isUnit(unit.card) || unit.card.d>=unit.card.h || c.subjectId!==unit.card.id
                            || c.incarnation!==unit.card.incarnation || c.controller!==unit.seat || c.round!==state.round || c.phase!==state.phase
                            || c.sourceId!==cue.source?.id || outcome.restriction!=='must-attack' || outcome.duration!=='next-action'
                            || state.nextActionConstraints?.some(x=>x.id===c.id)) fail('next-action constraint requires exact surviving current subject, controller and phase');
                        (state.nextActionConstraints??=[]).push(structuredClone(c));
                        (unit.card.status??=[]).push({kind:'restrict',label:outcome.label??'Next action: attack with this unit if able',duration:'next-action',restriction:'must-attack',actionConstraintId:c.id,incarnation:c.incarnation,round:c.round});
                    } else {
                        const c=state.nextActionConstraints?.find(c=>c.id===action.constraintId),w=action.witness;
                        if(!c || w.player!==c.controller || w.round!==c.round || w.phase!==c.phase) fail('next-action boundary must match the actual obligation player, round and phase');
                        const subject=entries.find(e=>arena(e)&&!e.parent&&present(e)&&e.card.id===c!.subjectId&&isUnit(e.card)&&e.card.incarnation===c!.incarnation);
                        if(w.action==='attack-with-unit' && w.result==='satisfied') {
                            const a=w.attackId?attacks.get(w.attackId):undefined;
                            if(state.round!==c!.round||state.phase!==c!.phase||!a||a.attackerId!==c!.subjectId||a.incarnation!==c!.incarnation
                                ||w.attackerId!==c!.subjectId||w.incarnation!==c!.incarnation||w.targetId!==a.defenderId)fail('satisfied constraint requires its actual ordinary attack by the bound entry');
                        } else if(w.action==='other' && w.result==='unable') {
                            if(state.round!==c!.round||state.phase!==c!.phase||w.unableReason==='exhausted'&&(!subject||!(subject.card as UnitRef).x)
                                ||w.unableReason==='departed'&&subject||!['exhausted','departed'].includes(w.unableReason??''))fail('unable boundary requires directly witnessed exhaustion or departure');
                        } else if(w.action==='phase-end' && w.result==='expired') {
                            if(state.phase===c!.phase && state.round===c!.round)fail('phase expiry requires explicitly supplied later phase truth');
                        } else fail('unsupported or wrong next-action boundary');
                        state.nextActionConstraints=state.nextActionConstraints!.filter(x=>x.id!==c!.id);
                        for(const e of entries)if(isUnit(e.card)&&e.card.status)e.card.status=e.card.status.filter(s=>s.actionConstraintId!==c!.id);
                    }
                    break;
                }
                if (unit && present(unit) && isUnit(unit.card)) {
                    if (outcome.restriction !== 'cannot-ready' || outcome.duration !== 'round' || outcome.round !== state.round
                        || !unit.card.incarnation || outcome.incarnation !== unit.card.incarnation) fail('round ready restriction requires the current round and arena incarnation');
                    (unit.card.status ??= []).push({ kind: 'restrict', label: `Cannot ready · round ${state.round}`, duration: 'round',
                        restriction: 'cannot-ready', round: state.round, incarnation: unit.card.incarnation });
                }
                break;
            case 'attack':
                if (outcome.attackId) {
                    const attacker = find(outcome.sourceCard, entry => arena(entry) && !entry.parent && present(entry));
                    const defender = find(outcome.card, entry => entry.seat === outcome.seat && (arena(entry) || entry.zone === 'base') && !entry.parent && present(entry));
                    if(attacker&&isUnit(attacker.card)&&['JTL_156','JTL_174'].includes(cue.source?.s??'')){
                        if(!causeEvent(outcome)||outcome.incarnation!==attacker.card.incarnation)fail('authored attack needs actual causing event and selected current entry');
                        if(cue.source?.s==='JTL_156'&&outcome.onAttackWindow?.effect!=='trench-cost-difference')fail('Trench attack must preserve its actual granted On Attack window');
                        if(cue.source?.s==='JTL_174'){const objects=currentAbilityObjects(attacker.card),enemy=before.players[attacker.seat==='p1'?'p2':'p1'],count=Math.min(objects.length,enemy.ground.length+enemy.space.length),g=hotshotGroups.get(attacker.card.id!);if(count&&(!g||g.hits.size!==count)||objects.length&&outcome.onAttackWindow?.effect!=='firespray-indirect'||!objects.length&&outcome.onAttackWindow)fail('Hotshot attack must follow every actual initial hit and preserve its native trigger window');}
                    }
                    const permission=outcome.exhaustedAttackPermission;
                    if(permission&&(!attacker||!isUnit(attacker.card)||!defender||!isUnit(defender.card)||permission.sourceId!==cue.source?.id||cue.source?.s!=='JTL_123'||cue.definition.setCode!=='JTL_123'||cue.definition.name!=='Dogfight'||permission.attackerId!==attacker.card.id||permission.incarnation!==attacker.card.incarnation||permission.attackId!==outcome.attackId||permission.round!==state.round||permission.phase!==state.phase||permission.unitTargetOnly!==true||attacker.seat!==cue.seat))fail('exhausted attack permission belongs only to this exact actual Dogfight unit-target attack');
                    if(attacker&&isUnit(attacker.card)&&defender?.zone==='base'&&attacker.card.status?.some(x=>x.restriction==='cannot-attack-base'&&x.duration==='phase'&&x.round===state.round&&x.phase===state.phase&&x.incarnation===(attacker.card as UnitRef).incarnation))fail('bound generated unit cannot attack a base this phase');
                    if (!attacker || !isUnit(attacker.card) || attacker.card.x&&!permission || !attacker.card.id || !defender?.card.id
                        || attacker.seat === defender.seat || attacks.has(outcome.attackId)) fail('attack segment needs a ready attacker, enemy defender and unique ID');
                    if(outcome.attackOrigin){const origin=outcome.attackOrigin;if(origin.playedId!==attacker!.card.id||origin.incarnation!==attacker!.card.incarnation
                        ||playedEntries.get(origin.playedId)!==origin.incarnation||!ambushReadied.delete(origin.playedId))fail('Ambush attack requires chosen ready of the same actually played entry');}
                    const bonus = attackBonuses.get(outcome.attackId);
                    if (bonus && bonus.id !== attacker!.card.id) fail('attack bonus belongs to a different attacker');
                    if(isUnit(defender!.card)&&attacker!.zone!==defender!.zone&&!outcome.attackArenaPermission)fail('cross-arena unit attack needs explicit permission');
                    const defending=defenderBonuses.get(outcome.attackId);
                    if(defending && defending.id!==defender!.card.id)fail('defending modifier belongs to a different target');
                    if(outcome.attackArenaPermission==='space-to-ground-native'&&(attacker!.card.s!=='SOR_212'||attacker!.zone!=='space'||defender!.zone!=='ground'||!permission||defending?.power!==-2))fail('native ground attack needs actual Strafing Gunship permission and its exact defending modifier');
                    if(outcome.attackArenaPermission && outcome.attackArenaPermission!=='space-to-ground-native' && (outcome.attackArenaPermission!=='space-to-ground'||attacker!.zone!=='space'||defender!.zone!=='ground'
                        ||attackKeywords.get(outcome.attackId)?.id!==attacker!.card.id))fail('cross-arena permission needs its actual space-to-ground Saboteur attack');
                    const defense=defenseOrigins.get(outcome.attackId);
                    if(defense&&(defense.protectedId!==defender!.card.id||!isUnit(defender!.card)||defense.incarnation!==defender!.card.incarnation||bonus?.power!==-4))fail('conditional power reduction belongs only to attack against its protected continuing entry');
                    const start=defenderStarts.get(outcome.attackId),grit=attackGrit.get(outcome.attackId);
                    if(start&&(outcome.incarnation!==attacker!.card.incarnation||start.defenderId!==defender!.card.id||start.zone!==defender!.zone||start.zone!=='base'&&(!isUnit(defender!.card)||start.incarnation!==defender!.card.incarnation||start.damage!==defender!.card.d)))fail('attack target must match sealed defender start before later damage');
                    if(grit&&(!gritModifiers.has(outcome.attackId)||grit.attackerId!==attacker!.card.id||grit.incarnation!==attacker!.card.incarnation||grit.damage!==attacker!.card.d||grit.powerIncludesGrit!==currentGrit(attacker!.card)))fail('Grit attack must use its exact current wound window and single contribution');
                    if(start||grit){const sentinels=state.players[defender!.seat][attacker!.zone as 'ground'|'space'].filter(u=>u.sn);if(sentinels.length&&(!isUnit(defender!.card)||!defender!.card.sn))fail('wound-powered attack must respect actual same-arena Sentinel');}
                    if(outcome.onAttackWindow&&(outcome.combatOrder!=='simultaneous'||outcome.amount!==Math.max(0,attacker!.card.p+(bonus?.power??0))||outcome.onAttackWindow.effect==='trench-cost-difference'&&bonus?.power!==4))fail('On Attack segment must use actual current attack power and exact temporary bonus');
                    if(defending||defense||start||grit||outcome.onAttackWindow||['JTL_156','JTL_174'].includes(cue.source?.s??''))attackPowers.set(outcome.attackId,{attacker:Math.max(0,attacker!.card.p+(bonus?.power??0)),defender:isUnit(defender!.card)?Math.max(0,defender!.card.p+(defending?.power??0)):undefined});
                    const keyword = attackKeywords.get(outcome.attackId);
                    if (keyword && keyword.id !== attacker!.card.id) fail('attack keyword belongs to a different attacker');
                    const restoreStatuses=attacker!.card.status?.filter(s=>s.keyword?.name==='Restore')??[];
                    if(restoreStatuses.some(s=>s.duration==='phase'&&(s.round!==state.round||s.phase!==state.phase||s.incarnation!==(attacker!.card as UnitRef).incarnation)||!Number.isSafeInteger(s.keyword!.amount)||s.keyword!.amount<0))fail('attack Restore requires current bound keyword facts');
                    const restoreAmount=restoreStatuses.reduce((n,s)=>n+s.keyword!.amount,0);
                    attacks.set(outcome.attackId, { attackingSeat:attacker!.seat,counter:0,combatStarted:false,restoreAmount,attackerId: attacker!.card.id!, incarnation: attacker!.card.incarnation, defenderId: defender!.card.id!, damage: 0, order: outcome.combatOrder ?? 'simultaneous' });
                }
                break;
            case 'inspect': {
                if(outcome.requiresDiscard){const hand=state.players[outcome.fromSeat??outcome.seat].hand,ids=outcome.cards?stableIds(outcome.cards,'private whole hand'):undefined;
                    if(!outcome.sequenceId||privateHands.has(outcome.sequenceId)||outcome.sequenceIndex!==1||outcome.fromSeat===cue.seat||outcome.fromSeat!==outcome.seat||outcome.fromZone!=='hand'||outcome.zone!=='hand'||outcome.visibility!=='private'||outcome.chooserSeat!==cue.seat||!ids||ids.length!==hand.length||outcome.amount!==hand.length||!outcome.card?.id||!ids.includes(outcome.card.id)||!hand.some(x=>x.id===outcome.card!.id&&x.n===outcome.card!.n&&x.s===outcome.card!.s&&x.owner===outcome.card!.owner)||outcome.cards!.some(c=>!hand.some(x=>x.id===c.id&&x.n===c.n&&x.s===c.s&&x.owner===c.owner)))fail('private hand inspection requires complete actual opponent hand and event-player selection');
                    privateHands.set(outcome.sequenceId,{selectedId:outcome.card.id,seat:outcome.seat,sourceId:cue.source!.id!});
                }
                if (outcome.resourceReveal) {
                    const manifest = player.resources, ids = outcome.cards?.map(c=>c.id), playIds=outcome.resourceReveal.playIds;
                    if (!manifest || !ids || ids.some(id=>!id) || new Set(ids).size!==ids.length || outcome.visibility!=='public'
                        || outcome.fromZone!=='resources' || ids.some(id=>!manifest.some(c=>c.id===id))
                        || new Set(playIds).size!==playIds.length || playIds.some(id=>!ids.includes(id))) fail('public resource reveal needs exact own resource membership and selected sequence');
                    revealedResources.set(outcome.seat,{ids:ids as string[],playIds:[...playIds],next:0});
                }
                if (outcome.choice?.kind === 'private-top') {
                    const choice = outcome.choice, top = player.knownDeck?.[0], declared = outcome.cards?.[0];
                    if (!top?.id || !declared || outcome.cards?.length !== 1 || !same(top, declared) || top.n !== declared.n || top.s !== declared.s
                        || outcome.fromZone !== 'deck' || outcome.chooserSeat !== outcome.seat || choice.discount !== 5 || choice.freeAtRemainingHp !== 5
                        || choice.decision === 'play-free' && player.base.hp - player.base.d > choice.freeAtRemainingHp
                        || choice.decision === 'play-discount' && player.base.hp - player.base.d <= choice.freeAtRemainingHp) fail('private top inspection contradicts actual top, chooser or play threshold');
                    privateChoices.set(top.id, choice.decision);
                }
                break;
            }
            case 'cost':
                if(exploit&&(outcome.amount!==-2*exploit.units.length||outcome.card?.id!==source?.card.id||outcome.sourceCard?.id!==source?.card.id))fail('Exploit discount receipt must match actual selected cost sacrifices and causing event');
                if(outcome.defeatPhase&&!outcome.defeatedEntry){const h=before.defeatedThisPhase,p=outcome.defeatPhase;
                    if(outcome.amount!==-2||!h||h.round!==before.round||h.phase!==before.phase||p.round!==h.round||p.phase!==h.phase
                        ||!h.cards.some(x=>x.id===outcome.card?.id&&x.incarnation===outcome.incarnation&&x.controller&&x.controller!==cue.seat&&x.defeatedBy===cue.seat&&['unit','leader-unit'].includes(x.lastKnownType??'')))fail('discount needs actual current-phase enemy-unit defeat attribution');}
                break;
        }
    }
    for(const g of generatedGroups.values())if(g.created.size!==g.w.members.length||g.restricted.size!==g.w.members.length)fail('generated set needs every actual creation and its bound effect');
    for(const g of focusGroups.values())if(g.hits.size!==g.w.members.length)fail('Vehicle focus requires every original source hit');
    for(const g of salvoGroups.values())if(g.hits.size!==g.w.members.length)fail('arena Salvo requires every selected-arena enemy hit');
    for(const g of pairGroups.values())if(g.hits.size!==2)fail('paired simultaneous damage requires both original attempts');
    for(const g of hotshotGroups.values())if(g.hits.size!==g.w.targets.length)fail('Hotshot requires every original distinct ability-count target');
    for(const g of lightGroups.values())if(g.w.enemy&&(!g.direct||!g.indirect))fail('Lightspeed resolved sequence must include direct and conditional indirect clauses');
    for(const g of indirectGroups.values())if(g.hits.size!==g.w.members.length)fail('indirect assignment must account for every supplied member');
    for(const g of vehiclePlays.values())if(g.step!==3)fail('discounted Vehicle sequence must reach actual paid play');
    for(const [id,g]of attackWindows){const a=attacks.get(id);if(!a||g.w.effect==='trench-cost-difference'&&(!g.mill||g.mill.length===2&&!g.selfHit)||g.w.effect==='firespray-indirect'&&!g.indirect)fail('actual On Attack window requires all mandatory declared effects');if(!a.combatStarted&&!defeatedIncarnations.has(g.w.subjectId)&&!defeatedIncarnations.has(a.defenderId))fail('living attacker must complete actual combat after On Attack');}
    for(const g of titleGroups.values())if(g.assigned.size!==g.w.members.length)fail('fixed title grant must cover every original friendly entry');
    for(const g of nebulaGroups.values())if(g.attempted.size!==g.w.members.length)fail('every original unupgraded member needs its actual attempt');
    for(const g of wingsGroups.values()){const success=g.w.members.filter(m=>successfulExhaustions.get(m.id)?.sourceId===cue.source?.id&&successfulExhaustions.get(m.id)?.incarnation===m.incarnation);if(g.attempted.size!==g.w.members.length||g.created.size!==success.length||success.some(m=>!g.created.has(m.id)))fail('space selection must account for every attempt and exactly its actual successful creations');}
    for(const g of salvageSequences.values())if(g.index<3)fail('paid discard Vehicle sequence must reach its exact actual one-wound result');
    for(const g of handBottoms.values())if(g.moved.size!==2)fail('hand bottom must account for both selected cards');
    for(const q of controlSequences.values())if(!q.complete)fail('sequential control must include its next actual defeat attempt');
    for(const g of keywordWindows.values())if(g.gained.size!==g.w.members.length||g.lost.size!==g.w.members.length)fail('whole-arena keyword window requires both declared effects for every entry');
    if(privateHands.size)fail('selected private hand inspection requires its actual following discard attempt');
    if(randomDiscardBranch&&(randomDiscardBranch.choice.result==='discarded'?(!randomDiscardBranch.discarded||randomDiscardBranch.created!==0):(randomDiscardBranch.discarded||randomDiscardBranch.created!==2)))fail('random discard result must produce exactly one actual discard or two own Droids');
    for(const g of traitGrants.values())if(g.keyword.size!==g.w.members.length||g.w.scope==='up-to-one-any'&&g.buff.size!==g.w.members.length)fail('every sealed trait-role member needs its complete grants');
    for(const g of nameGroups.values())if(g.returned.size!==g.witness.members.length)fail('same-title return must account for every original selected/enemy member');
    for(const g of sharedTraits.values())if(g.assigned.size!==g.witness.units.length)fail('every sealed shared-trait member requires exactly one phase boost');
    for(const g of powerWindows.values())if(g.hits.size!==2)fail('reciprocal simultaneous power window requires both hits before completion');
    for(const id of [...defenderStarts.keys(),...attackGrit.keys()])if(!attacks.has(id))fail('temporary starting-wound or Grit grant requires its actual attack');
    if(!sourcePaid){for(const chosen of exploit?.units??[])if(defeatedIncarnations.get(chosen.id)!==chosen.incarnation)fail('all Exploit cost sacrifices must resolve before payment');paySourceOnce();}
    for(const g of chosenGroups.values())if(g.kind==='discard'&&(g.created!==g.cards.length||g.attempted.size!==g.cards.length)||g.kind==='arena'&&g.attempted.size!==g.units.length)fail('chosen group must account for all selected-count creations and then-sacrifices');
    if(smuggle && before.players[cue.seat].deck>0 && !smuggleReplacement)fail('Smuggle needs its explicit actual top-card replacement');
    for(const cleanup of captiveCleanups.values())if(cleanup.remaining.size)fail('all departed captor captives need explicit rescue cleanup');
    if(ambushReadied.size)fail('chosen Ambush ready requires its actual attack');
    for (const distribution of xpDistributions.values()) if (distribution.assigned !== distribution.count) fail('Experience distribution must account for the full declared upgrade count');
    for (const reveal of revealedResources.values()) if (reveal.next!==reveal.playIds.length) fail('all declared revealed unit plays must be consumed in sequence');
    for (const seat of seats) validateResources(seat);
    return state;
}
