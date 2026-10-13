import type { CardRef, Seat, Snapshot } from '../data/types';
import type { CardEffectCue, CardEffectOutcome, EffectPreview } from './types';
import { previewCue } from './preview';
import { resolvePreviewState } from './previewState';
import { a06NextActionOutcomes } from './batchA06';
import { a07PhaseEndOutcomes, a07RegroupOutcomes } from './batchA07';
import { a10LaterActionOutcomes } from './batchA10';
import { a12LaterActionOutcomes } from './batchA12';
import { a14LaterActionOutcomes, a14PhaseEndOutcomes } from './batchA14';
import { a15PhaseEndOutcomes } from './batchA15';
import { a16PhaseEndOutcomes } from './batchA16';

const seats: Seat[] = ['p1', 'p2'];
const zones = ['ground', 'space'] as const;
export const hasRegroupExample = (id: string) => ['change-of-heart', 'sneak-attack', 'final-showdown', 'unnatural-life', 'impropriety-among-thieves'].includes(id);
export const hasPhaseEndExample = (id: string) => ['triple-dark-raid', 'close-the-shield-gate', 'in-the-heat-of-battle', 'scramble-fighters', 'unity-of-purpose', 'timely-reinforcements'].includes(id);
export const phaseEndExampleLabel = 'Action phase ends: return the same continuing X-Wing to its owner hand; no regroup readying or draw';
export const hasNextActionExample = (id: string) => ['give-in-to-your-anger', 'pyrrhic-assault', 'in-defense-of-kamino', 'aid-from-the-innocent', 'close-the-shield-gate'].includes(id);
export const previewExampleStages = (id: string): Array<'play' | 'next-action' | 'phase-end' | 'regroup-start'> => [
    'play', ...(hasNextActionExample(id) ? ['next-action' as const] : []),
    ...(hasPhaseEndExample(id) ? ['phase-end' as const] : []), ...(hasRegroupExample(id) ? ['regroup-start' as const] : [])
];
export const phaseEndExampleLabelFor = (id: string) => id === 'timely-reinforcements'
    ? 'Action phase ends: remove only this event’s Sentinel grant from its continuing generated X-Wings; no readying, draw or new token creation'
    : id === 'scramble-fighters'
    ? 'Action phase ends: remove only this event’s base-attack restriction from its continuing generated TIEs; no readying or draw'
    : id === 'unity-of-purpose'
    ? 'Action phase ends: remove only this event’s fixed title bonus from continuing recipients; wounds, poses and other effects remain'
    : id === 'close-the-shield-gate'
    ? 'Action phase ends: unused protection expires from the selected base; no damage, attack, readying or draw'
    : id === 'in-the-heat-of-battle'
    ? 'Action phase ends: remove this event’s Sentinel and Saboteur-loss effects from continuing units; preserve printed keywords and all counters'
    : phaseEndExampleLabel;
export const nextActionButtonLabel = (id: string) => id === 'give-in-to-your-anger' ? 'Next P2 action' : 'Later action';
export const nextActionExampleLabelFor = (id: string) => id === 'close-the-shield-gate'
    ? 'Later P2 action: TIE attacks the protected P1 base for 2; prevent all 2, take 0 damage, and consume the one use'
    : id === 'pyrrhic-assault'
    ? 'Later P2 action: Wampa attacks Sentinel Defender; both are defeated, then Defender’s granted ability deals 2 to Trooper'
    : id === 'in-defense-of-kamino'
    ? 'After P2 passes: Phase I attacks Wampa, Restore heals 2 from the P1 base, then its defeat creates a fresh exhausted Clone with no old grant'
    : id === 'aid-from-the-innocent'
    ? 'After P2 passes: pay 1 for the selected Jedi Lightsaber from discard, attach it to Marine for +3/+3, and consume only that copy’s phase permission'
    : nextActionExampleLabel;
export const nextActionExampleLabel = 'Next P2 action: the same Trooper attacks Sentinel Defender; both are defeated and the obligation is consumed';
export const previewSceneKey = (preview: EffectPreview) => `preview:${preview.definition.id}:${preview.nonce}${preview.stage ? `:${preview.stage}` : ''}`;
export const regroupExampleLabel = (id: string) => id === 'final-showdown'
    ? 'Regroup begins: P1 loses by Final Showdown; P2 wins, with the actual board intact'
    : id === 'unnatural-life'
    ? 'Regroup begins: defeat the same ready Wampa played from discard by Unnatural Life; no readying, draw or repeated payment'
    : id === 'impropriety-among-thieves'
    ? 'Regroup begins: each continuing exchanged unit returns to its owner, keeping wounds and readiness; no draw or event payment'
    : id === 'change-of-heart'
    ? 'Regroup begins: owner P2 regains the same exhausted Wampa; no readying or draw yet'
    : 'Regroup begins: defeat the Wampa played by Sneak Attack; no readying or draw yet';

const discardRef = (card: CardRef): CardRef => ({ n: card.n, s: card.s, id: card.id, owner: card.owner });

/** Resolve only explicit staged start-of-regroup obligations, before the ordinary draw/ready steps.
 * No replay calls this function; it does not advance an engine or invent intervening actions.
 */
export function resolveStagedRegroup(before: Snapshot): { after: Snapshot; outcomes: CardEffectOutcome[] } {
    const after = structuredClone(before);
    after.phase = 'regroup';
    const outcomes: CardEffectOutcome[] = [];
    for (const pending of after.pending ?? []) {
        if (pending.trigger !== 'regroup-start') continue;
        const matches = seats.flatMap(seat => zones.flatMap(zone => after.players[seat][zone]
            .filter(unit => unit.id === pending.targetId && unit.incarnation === pending.incarnation)
            .map(unit => ({ seat, zone, unit }))));
        // An obligation belongs to this entry in play, even if a later entry reuses the physical card ID.
        if (!matches.length) continue;
        if (matches.length !== 1) throw new Error('Staged regroup target is ambiguous');
        const { seat, zone, unit } = matches[0];
        const isLeader = seats.some(side => after.players[side].leader?.dep === 1 && after.players[side].leader?.id === unit.id);
        if (pending.kind === 'return-control' && (!unit.owner || unit.owner !== pending.returnController)) {
            throw new Error('Staged regroup control return must identify the current unit owner');
        }
        unit.status = unit.status?.filter(status => !(['delay', 'control'].includes(status.kind) && status.duration === 'regroup'));
        if (!unit.status?.length) delete unit.status;
        if (pending.kind === 'defeat' || isLeader) {
            after.players[seat][zone] = after.players[seat][zone].filter(candidate => candidate !== unit);
            const owner = unit.owner ?? seat;
            for (const upgrade of unit.u ?? []) if (!upgrade.t) after.players[upgrade.owner ?? owner].discard.push(discardRef(upgrade));
            if (isLeader) {
                const leader = after.players[owner].leader;
                if (!leader || leader.id !== unit.id) throw new Error('Staged leader defeat requires its owner leader reference');
                leader.dep = 0;
                leader.x = 1;
            } else after.players[owner].discard.push(discardRef(unit));
            outcomes.push({ kind: 'defeat', card: structuredClone(unit), seat, zone: 'discard', ownerSeat: owner, label: 'REGROUP · DEFEATED' });
        } else if (pending.returnController !== seat) {
            const owner = pending.returnController!;
            after.players[seat][zone] = after.players[seat][zone].filter(candidate => candidate !== unit);
            after.players[owner][zone].push(unit);
            outcomes.push({ kind: 'control', card: structuredClone(unit), seat: owner, fromSeat: seat, fromZone: zone,
                zone, ownerSeat: owner, label: `REGROUP · OWNER ${owner.toUpperCase()} REGAINS CONTROL` });
        }
    }
    after.pending = after.pending?.filter(pending => pending.trigger !== 'regroup-start');
    return { after, outcomes };
}

/** Build a complete presentation scene; choosing its boundary always starts from the same legal example. */
export function preparePreviewCue(preview: EffectPreview, initial: Snapshot): CardEffectCue {
    const primary = previewCue({ ...preview, stage: undefined }, initial);
    const immediate = resolvePreviewState(initial, primary);
    if (!preview.stage) return { ...primary, transition: { before: initial, after: immediate } };
    if (preview.stage === 'next-action') {
        if (!hasNextActionExample(preview.definition.id)) throw new Error('This card has no authored next-action example');
        const before = structuredClone(immediate), later = a14LaterActionOutcomes(preview.definition, before, preview.seat ?? 'p1') ?? a12LaterActionOutcomes(preview.definition, before, preview.seat ?? 'p1') ?? a10LaterActionOutcomes(preview.definition, before, preview.seat ?? 'p1');
        const outcomes = later ?? a06NextActionOutcomes(preview.definition, before, preview.seat ?? 'p1');
        if (!outcomes) throw new Error('Missing authored next-action outcomes');
        const attack = outcomes.find(outcome => outcome.kind === 'attack');
        const boundary: CardEffectCue = { ...primary, key: previewSceneKey(preview), stage: preview.stage,
            playCost: undefined, playPayment: undefined, source: later ? primary.source : attack?.sourceCard ?? null,
            target: attack?.card ?? null, targetSeat: attack?.seat, outcomes, exampleLabel: nextActionExampleLabelFor(preview.definition.id) };
        return { ...boundary, transition: { before, after: resolvePreviewState(before, boundary) } };
    }
    if (preview.stage === 'phase-end' || preview.stage === 'regroup-start' && preview.definition.id === 'final-showdown') {
        if (preview.stage === 'phase-end' && !hasPhaseEndExample(preview.definition.id)) throw new Error('This card has no authored phase-end example');
        const before = structuredClone(immediate);
        if (preview.stage === 'regroup-start') before.phase = 'regroup';
        const outcomes = preview.stage === 'phase-end'
            ? a16PhaseEndOutcomes(preview.definition, before, preview.seat ?? 'p1') ?? a15PhaseEndOutcomes(preview.definition, before, preview.seat ?? 'p1') ?? a14PhaseEndOutcomes(preview.definition, before, preview.seat ?? 'p1') ?? a07PhaseEndOutcomes(preview.definition, before, preview.seat ?? 'p1')
            : a07RegroupOutcomes(preview.definition, before, preview.seat ?? 'p1');
        if (!outcomes) throw new Error('Missing authored boundary outcomes');
        const target = outcomes.find(outcome => outcome.kind === 'return');
        const keepEvent = ['close-the-shield-gate', 'in-the-heat-of-battle', 'scramble-fighters', 'unity-of-purpose', 'timely-reinforcements'].includes(preview.definition.id);
        const boundary: CardEffectCue = { ...primary, key: previewSceneKey(preview), stage: preview.stage,
            playCost: undefined, playPayment: undefined, source: keepEvent ? primary.source : target?.card ?? null,
            target: target?.card ?? null, targetSeat: target?.fromSeat ?? target?.seat,
            outcomes, exampleLabel: preview.stage === 'phase-end' ? phaseEndExampleLabelFor(preview.definition.id) : regroupExampleLabel(preview.definition.id) };
        return { ...boundary, transition: { before, after: resolvePreviewState(before, boundary) } };
    }
    if (!hasRegroupExample(preview.definition.id)) throw new Error('This card has no authored regroup example');
    const before = structuredClone(immediate);
    before.phase = 'regroup';
    const { after, outcomes: rawOutcomes } = resolveStagedRegroup(before);
    const keepEvent = ['unnatural-life', 'impropriety-among-thieves'].includes(preview.definition.id);
    const outcomes = keepEvent ? rawOutcomes.map(outcome => {
        const pending = before.pending?.find(p => p.trigger === 'regroup-start' && p.targetId === outcome.card?.id);
        if (!pending || !outcome.card || !('incarnation' in outcome.card) || pending.incarnation !== outcome.card.incarnation) throw new Error('A12 regroup needs the exact continuing pending entry');
        return { ...outcome, sourceCard: primary.source ?? undefined, incarnation: pending.incarnation, pending, pendingOperation: 'consume' as const };
    }) : rawOutcomes;
    const target = outcomes[0];
    return { ...primary, key: previewSceneKey(preview), stage: preview.stage, playCost: undefined, playPayment: undefined,
        source: keepEvent ? primary.source : target?.card ?? null, target: target?.card ?? null, targetSeat: target?.fromSeat ?? target?.seat,
        outcomes, exampleLabel: regroupExampleLabel(preview.definition.id), transition: { before, after } };
}
