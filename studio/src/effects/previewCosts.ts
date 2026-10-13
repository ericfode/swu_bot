import { A16_COSTS } from './batchA16';
import { A15_COSTS } from './batchA15';
import { A14_COSTS } from './batchA14';
import { A13_COSTS } from './batchA13';
import { A12_COSTS } from './batchA12';
import { A11_COSTS } from './batchA11';
import { A10_COSTS } from './batchA10';
import { A09_COSTS } from './batchA09';
import { A08_COSTS } from './batchA08';
import { A07_COSTS } from './batchA07';
import { A06_COSTS } from './batchA06';
import type { CardRef, Seat, Snapshot } from '../data/types';
import { showcaseAbilities } from './abilities';
import type { CardEffectDefinition, PreviewPlayPayment } from './types';
import { A01_COSTS } from './batchA01';
import { A02_COSTS } from './batchA02';
import { A03_COSTS } from './batchA03';
import { A04_COSTS } from './batchA04';
import { A05_COSTS } from './batchA05';

export type PreviewAspect = 'vigilance' | 'command' | 'aggression' | 'cunning' | 'heroism' | 'villainy';
export interface PreviewCardCost { printed: number; aspects: readonly PreviewAspect[]; smuggle?: { printed: number; aspects: readonly PreviewAspect[] }; exploit?: 3 | 4 }

/** Verified against forceteki/test/json/Card/<id>.json. Duplicate aspect symbols are intentional. */
export const PREVIEW_CARD_COSTS: Readonly<Record<string, PreviewCardCost>> = {
    ...A01_COSTS,
    ...A02_COSTS,
    ...A03_COSTS,
    ...A04_COSTS,
    ...A05_COSTS,
    ...A06_COSTS,
    ...A07_COSTS,
    ...A08_COSTS,
    ...A09_COSTS, ...A10_COSTS, ...A11_COSTS, ...A12_COSTS, ...A13_COSTS, ...A14_COSTS, ...A15_COSTS, ...A16_COSTS,
    'open-fire': { printed: 3, aspects: ['aggression'] },
    'force-lightning': { printed: 1, aspects: ['aggression', 'villainy'] },
    'force-choke': { printed: 2, aspects: ['aggression', 'villainy'] },
    takedown: { printed: 4, aspects: ['vigilance'] },
    vanquish: { printed: 5, aspects: ['vigilance'] },
    'superlaser-blast': { printed: 8, aspects: ['villainy', 'vigilance'] },
    'overwhelming-barrage': { printed: 5, aspects: ['command', 'villainy'] },
    'bombing-run': { printed: 5, aspects: ['aggression'] },
    'make-an-opening': { printed: 3, aspects: ['vigilance'] },
    repair: { printed: 1, aspects: ['vigilance'] },
    restock: { printed: 1, aspects: [] },
    resupply: { printed: 3, aspects: ['command'] },
    command: { printed: 4, aspects: ['command', 'command'] },
    vigilance: { printed: 4, aspects: ['vigilance', 'vigilance'] },
    aggression: { printed: 4, aspects: ['aggression', 'aggression'] },
    cunning: { printed: 4, aspects: ['cunning', 'cunning'] },
    'power-of-the-dark-side': { printed: 3, aspects: ['vigilance', 'villainy'] },
    'the-force-is-with-me': { printed: 4, aspects: ['vigilance', 'heroism'] },
    waylay: { printed: 3, aspects: ['cunning'] },
    'spark-of-rebellion': { printed: 2, aspects: ['cunning', 'heroism'] }
};

// Only the explicitly supported showcase bases/leaders supply these aspects. Arena units do not supply aspects.
// Source JSON: echo-base, capital-city, luke-skywalker#faithful-friend, darth-vader#dark-lord-of-the-sith.
const PROVIDERS: Readonly<Record<string, readonly PreviewAspect[]>> = {
    SOR_024: ['command'], SOR_020: ['vigilance'],
    SOR_005: ['vigilance', 'heroism'], SOR_010: ['aggression', 'villainy']
};
// Read-only trait facts for units that can appear in these fixtures, including a deployed leader side.
const FORCE_UNITS = new Set(['SOR_051', 'SOR_005', 'SOR_010']);
const ALTERNATE_DISCARD_COSTS: Readonly<Record<string, 'cunning'>> = { bamboozle: 'cunning' };
function providedAspects(card: CardRef): readonly PreviewAspect[] {
    const aspects = card.s ? PROVIDERS[card.s] : undefined;
    if (!aspects) throw new Error(`No verified showcase aspect provider for ${card.s ?? card.n}`);
    return aspects;
}

/** Same multiset subtraction as Player.getPenaltyAspects: each supplied symbol pays for one required symbol. */
export function previewMissingAspects(required: readonly PreviewAspect[], provided: readonly PreviewAspect[]): PreviewAspect[] {
    const remaining = [...provided];
    return required.filter(aspect => {
        const index = remaining.indexOf(aspect);
        if (index < 0) return true;
        remaining.splice(index, 1);
        return false;
    });
}

/** Evaluate a declared known selected-card cost with the same verified aspect providers; never infer unknowns. */
export function previewGivenCost(metadata: PreviewCardCost, state: Snapshot, seat: Seat, discount=0): number {
    if(!Number.isSafeInteger(metadata.printed)||metadata.printed<0||!Number.isSafeInteger(discount)||discount<0)throw new Error('Selected-card price requires explicit nonnegative printed cost and discount');
    const p=state.players[seat],provided=[...providedAspects(p.base),...(p.leader?providedAspects(p.leader):[])];
    return Math.max(0,metadata.printed+2*previewMissingAspects(metadata.aspects,provided).length-discount);
}

/** Explicit showcase cost only; recorded games retain their engine-provided resource snapshots. */
export function previewPlayCost(definition: Pick<CardEffectDefinition, 'id'>, state: Snapshot, seat: Seat = 'p1', payment?: PreviewPlayPayment): number {
    let metadata = PREVIEW_CARD_COSTS[definition.id];
    if (!metadata) throw new Error(`No verified showcase play cost for ${definition.id}`);
    const player = state.players[seat];
    if (payment?.kind === 'alternate-discard') {
        // Only explicitly supported fixture facts; this does not inspect titles or infer a live game's payment.
        const cunningPrints = new Set(['SOR_186', 'SOR_187', 'SOR_199', 'SOR_207', 'SOR_216', 'SOR_217', 'SOR_218', 'SOR_223']);
        const paid = payment.cards[0];
        const source = player.hand.find(c => c.id === payment.sourceId);
        const actual = paid?.id ? player.hand.find(c => c.id === paid.id) : undefined;
        if (ALTERNATE_DISCARD_COSTS[definition.id] !== payment.requiredAspect || payment.replacesAllCosts !== true
            || payment.cards.length !== 1 || !source || !actual || actual.id === source.id
            || actual.s !== paid.s || actual.n !== paid.n || (actual.owner ?? seat) !== seat
            || !actual.s || !cunningPrints.has(actual.s)) {
            throw new Error(`Showcase ${definition.id}: alternate payment needs one actual other Cunning card from own hand`);
        }
        return 0;
    }
    if(payment?.kind==='resources' && payment.smuggle){
        const source=player.resources?.find(c=>c.id===payment.smuggle!.sourceId);
        if(!metadata.smuggle || !source || source.s!=='SHD_252' || source.n!=="Smuggler's Aid" || source.owner!==seat) throw new Error(`Showcase ${definition.id}: explicit Smuggle needs its actual owned resource source and verified alternate cost`);
        metadata=metadata.smuggle;
    }
    let exploitDiscount=0;
    if(payment?.kind==='resources' && payment.exploit){const x=payment.exploit,units=[...player.ground,...player.space];
        if(!metadata.exploit || payment.smuggle || !player.hand.some(c=>c.id===x.sourceId&&c.owner===seat&&(definition.id==='the-invasion-of-christophsis'&&c.s==='TWI_078'&&c.n==='The Invasion of Christophsis'||definition.id==='planetary-invasion'&&c.s==='TWI_178'&&c.n==='Planetary Invasion')) || x.units.length>metadata.exploit || new Set(x.units.map(c=>c.id)).size!==x.units.length
            || x.units.some(c=>!units.some(u=>u.id===c.id && u.incarnation===c.incarnation && u.h>u.d)))throw new Error(`Showcase ${definition.id}: Exploit needs its actual source and distinct live controlled unit entries within the printed limit`);
        exploitDiscount=x.units.length*2;
    }
    const provided = [...providedAspects(player.base), ...(player.leader ? providedAspects(player.leader) : [])];
    // ForceChoke.ts grants this reduction only while a Force UNIT is in play, not for an undeployed Force leader.
    const forceDiscount = definition.id === 'force-choke' && [...player.ground, ...player.space].some(card => card.s && FORCE_UNITS.has(card.s)) ? 1 : 0;
    const attributed = state.defeatedThisPhase;
    const bravadoDiscount = definition.id === 'bravado' && attributed?.round === state.round && attributed.phase === state.phase
        && attributed.cards.some(c=>['unit','leader-unit'].includes(c.lastKnownType??'') && c.controller && c.controller!==seat && c.defeatedBy===seat) ? 2 : 0;
    return Math.max(0, metadata.printed + previewMissingAspects(metadata.aspects, provided).length * 2 - forceDiscount - bravadoDiscount - exploitDiscount);
}

/** The chosen demonstration may pay resources after playing the event (Force Lightning's N=2). */
export function previewExtraPayment(definition: Pick<CardEffectDefinition, 'id'>): number {
    return showcaseAbilities(definition.id).filter(beat => beat.kind === 'pay' && beat.payer !== 'opponent').reduce((total, beat) => {
        if (typeof beat.amount !== 'number' || !Number.isSafeInteger(beat.amount) || beat.amount < 0) {
            throw new Error(`Showcase ${definition.id} needs an explicit nonnegative resource payment`);
        }
        return total + beat.amount;
    }, 0);
}
