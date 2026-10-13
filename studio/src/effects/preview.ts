import type { CardRef, Seat, Snapshot, UnitRef } from '../data/types';
import { showcaseAbilities, showcaseLabel } from './abilities';
import type { CardEffectCue, CardEffectOutcome, EffectPreview } from './types';
import { a01PreviewOutcomes } from './batchA01';
import { a02PreviewOutcomes } from './batchA02';
import { a03PreviewOutcomes, a03PreviewPayment } from './batchA03';
import { a04PreviewOutcomes } from './batchA04';
import { a05PreviewOutcomes, a05PreviewPayment } from './batchA05';
import { a06PreviewOutcomes, a06PreviewPayment } from './batchA06';
import { a07PreviewOutcomes, a07PreviewPayment } from './batchA07';
import { a08PreviewOutcomes, a08PreviewPayment, a08PreviewSource } from './batchA08';
import { a09PreviewOutcomes, a09PreviewPayment, a09PreviewSource } from './batchA09';
import { a10PreviewOutcomes, a10PreviewPayment, a10PreviewSource } from './batchA10';
import { a11PreviewOutcomes, a11PreviewPayment, a11PreviewSource } from './batchA11';
import { a12PreviewOutcomes, a12PreviewPayment, a12PreviewSource } from './batchA12';
import { a13PreviewOutcomes, a13PreviewPayment, a13PreviewSource } from './batchA13';
import { a14PreviewOutcomes, a14PreviewPayment, a14PreviewSource } from './batchA14';
import { a15PreviewOutcomes, a15PreviewPayment, a15PreviewSource } from './batchA15';
import { a16PreviewOutcomes, a16PreviewPayment, a16PreviewSource } from './batchA16';
import { previewPlayCost } from './previewCosts';

/** Explicit theatre examples. Recorded games never call this function. */
export function previewCue(preview: EffectPreview, state: Snapshot): CardEffectCue {
    const { definition, nonce, seat = 'p1', progress } = preview;
    const foe: Seat = seat === 'p1' ? 'p2' : 'p1';
    const friend = state.players[seat];
    const enemy = state.players[foe];
    const marine = friend.ground[0];
    const wampa = enemy.ground[1];
    const trooper = enemy.ground[0];
    const source = a16PreviewSource(definition, state, seat) ?? a15PreviewSource(definition, state, seat) ?? a14PreviewSource(definition, state, seat) ?? a13PreviewSource(definition, state, seat) ?? a12PreviewSource(definition, state, seat) ?? a11PreviewSource(definition, state, seat) ?? a10PreviewSource(definition, state, seat) ?? a09PreviewSource(definition, state, seat) ?? a08PreviewSource(definition, state, seat) ?? friend.hand.find(c => c.s === definition.setCode) ?? { n: definition.name, s: definition.setCode };
    const authored = a01PreviewOutcomes(definition, state, seat) ?? a02PreviewOutcomes(definition, state, seat) ?? a03PreviewOutcomes(definition, state, seat) ?? a04PreviewOutcomes(definition, state, seat) ?? a05PreviewOutcomes(definition, state, seat) ?? a06PreviewOutcomes(definition, state, seat) ?? a07PreviewOutcomes(definition, state, seat) ?? a08PreviewOutcomes(definition, state, seat) ?? a09PreviewOutcomes(definition, state, seat) ?? a10PreviewOutcomes(definition, state, seat) ?? a11PreviewOutcomes(definition, state, seat) ?? a12PreviewOutcomes(definition, state, seat) ?? a13PreviewOutcomes(definition, state, seat) ?? a14PreviewOutcomes(definition, state, seat) ?? a15PreviewOutcomes(definition, state, seat) ?? a16PreviewOutcomes(definition, state, seat);
    if (authored) {
        const playPayment = a03PreviewPayment(definition, state, seat) ?? a05PreviewPayment(definition, state, seat) ?? a06PreviewPayment(definition, state, seat) ?? a07PreviewPayment(definition, state, seat) ?? a08PreviewPayment(definition, state, seat) ?? a09PreviewPayment(definition, state, seat) ?? a10PreviewPayment(definition, state, seat) ?? a11PreviewPayment(definition, state, seat) ?? a12PreviewPayment(definition, state, seat) ?? a13PreviewPayment(definition, state, seat) ?? a14PreviewPayment(definition, state, seat) ?? a15PreviewPayment(definition, state, seat) ?? a16PreviewPayment(definition, state, seat);
        const primary = definition.id === 'power-failure'
            ? authored.find(outcome => outcome.sourceCard)
            : authored.find(outcome => outcome.card && !['pay', 'cost', 'delay'].includes(outcome.kind));
        return { definition, seat, source, outcomes: authored, playPayment, playCost: previewPlayCost(definition, state, seat, playPayment),
            target: definition.id === 'power-failure' ? primary?.sourceCard ?? null : primary?.card ?? null,
            targetSeat: primary?.fromSeat ?? primary?.seat ?? seat,
            key: `preview:${definition.id}:${nonce}`, previewProgress: progress, exampleLabel: showcaseLabel(definition.id) };
    }
    const outcomes: CardEffectOutcome[] = [];
    const add = (kind: CardEffectOutcome['kind'], card: CardRef | null, side: Seat, amount?: number | string, zone: CardEffectOutcome['zone'] = 'ground', label?: string) => outcomes.push({ kind, card, seat: side, amount, zone, label });
    const damage = (unit: UnitRef, side: Seat, amount: number, zone: 'ground' | 'space' = 'ground') => {
        add('damage', unit, side, amount, zone);
        if (unit.h - unit.d <= amount) add('defeat', unit, side, undefined, 'discard');
    };
    for (const beat of showcaseAbilities(definition.id)) {
        switch (beat.kind) {
            case 'damage':
                if (definition.id === 'bombing-run') {
                    for (const side of [seat, foe]) for (const unit of state.players[side].ground) damage(unit, side, 3);
                } else damage(wampa, foe, Number(beat.amount));
                break;
            case 'defeat':
                if (beat.scope === 'all-units') {
                    for (const side of [seat, foe]) for (const zone of ['ground', 'space'] as const) for (const unit of state.players[side][zone]) add('defeat', unit, side, undefined, 'discard');
                } else {
                    add('defeat', trooper, foe, undefined, 'discard');
                    if (beat.selection === 'opponent') outcomes[outcomes.length - 1].selection = 'opponent';
                }
                break;
            case 'heal': add('heal', friend.base, seat, beat.amount, 'base'); break;
            case 'buff': add('buff', marine, seat, beat.amount, 'ground', beat.duration === 'token' ? '2 EXPERIENCE' : '+2/+2 · THIS PHASE'); break;
            case 'debuff': add('debuff', wampa, foe, beat.amount, 'ground', '−2/−2 · THIS PHASE'); break;
            case 'shield': add('shield', marine, seat, 1); break;
            case 'suppress': add('suppress', wampa, foe, undefined, 'ground', 'ABILITIES LOST · THIS PHASE'); break;
            case 'pay': add('pay', null, seat, beat.amount, 'resources'); break;
            case 'cost': add('cost', source, seat, beat.amount, 'resources'); break;
            case 'draw': add('draw', null, definition.id === 'force-choke' ? foe : seat, beat.amount, 'hand'); break;
            case 'return': add('return', wampa, foe, 1, 'hand'); break;
            case 'exhaust':
                add('exhaust', trooper, foe, 1);
                add('exhaust', enemy.space[0], foe, 1, 'space');
                break;
            case 'ready': add('ready', marine, seat, 1); break;
            case 'resource':
                outcomes.push({ kind: 'resource', card: source, seat, amount: 1, zone: 'resources',
                    fromSeat: seat, fromZone: 'hand', entersReady: false });
                break;
            case 'recover':
                for (const card of friend.discard.slice(0, Number(beat.amount))) add('recover', card, seat, 1, beat.scope === 'own-deck' ? 'deck' : 'hand', beat.scope === 'own-deck' ? 'DECK BOTTOM · RANDOM ORDER' : 'TO HAND');
                break;
            case 'inspect': add('inspect', null, foe, enemy.hand.length, 'hand'); break;
            case 'discard': add('discard', enemy.hand[0], foe, 1, 'discard', 'CHOSEN CARD'); break;
            case 'mill': add('mill', null, foe, beat.amount, 'deck'); break;
            case 'attack':
                // Bases do not counterattack, so the newly granted Shield remains intact.
                add('attack', marine, seat, 1, 'ground', 'ATTACK ENEMY BASE');
                add('damage', enemy.base, foe, marine.p + 2, 'base');
                add('exhaust', marine, seat, 1);
                break;
        }
    }
    const primary = outcomes.find(o => o.seat === foe && o.card && ['damage', 'defeat', 'debuff', 'return', 'suppress'].includes(o.kind))
        ?? outcomes.find(o => o.card && ['heal', 'buff', 'ready', 'shield'].includes(o.kind));
    return { definition, seat, source, playCost: previewPlayCost(definition, state, seat), target: primary?.card ?? null, targetSeat: primary?.seat ?? foe,
        key: `preview:${definition.id}:${nonce}`, outcomes, previewProgress: progress, exampleLabel: showcaseLabel(definition.id) };
}
