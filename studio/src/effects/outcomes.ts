import type { Action } from '../data/actions';
import type { CardRef, Game, Seat, Snapshot, UnitRef, ResourceRef, UpgradeRef } from '../data/types';
import { cardAbilities } from './abilities';
import { findCardEffect } from './catalogue';
import type { CardEffectOutcome } from './types';

type Zone = NonNullable<CardEffectOutcome['zone']>;
interface Located { card: CardRef; seat: Seat; zone: Zone; upgrade?: boolean; captured?: boolean; host?: UnitRef }
const SEATS: Seat[] = ['p1', 'p2'];
const identity = (card: CardRef) => `${card.n.toLowerCase()}|${card.s ?? ''}`;
const name = (card: CardRef) => card.n.toLowerCase().replace(/[^a-z0-9]/g, '');
const isUnit = (card: CardRef): card is UnitRef => 'p' in card && 'h' in card && 'd' in card;
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n)}`;

function locate(state: Snapshot): Located[] {
    return SEATS.flatMap((seat) => {
        const player = state.players[seat];
        return [...(['ground', 'space', 'hand', 'discard'] as const).flatMap((zone) => player[zone].flatMap((card): Located[] => [
            { card, seat, zone },
            ...(isUnit(card) ? (card.u ?? []).map((upgrade) => ({ card: upgrade, seat, zone, upgrade: true, host: card })) : []),
            ...(isUnit(card) ? (card.cap ?? []).map((captive) => ({ card: captive, seat, zone, captured: true, host: card })) : [])
        ])), ...(player.resources ?? []).map(card => ({ card, seat, zone: 'resources' as const })),
            ...(player.leader && !player.leader.dep ? [{ card: player.leader, seat, zone: 'leader' as const }] : [])];
    });
}

/** Missing instance ids are usable only when that title/print occurs once in each snapshot being compared. */
function match(card: CardRef, cards: Located[]): Located | undefined {
    const matches = cards.filter((item) => card.id ? item.card.id === card.id : identity(item.card) === identity(card));
    return matches.length === 1 ? matches[0] : undefined;
}

function absent(card: CardRef, cards: Located[]): boolean {
    return !cards.some((item) => card.id ? item.card.id === card.id : identity(item.card) === identity(card));
}

function tokenCount(card: UnitRef, token: string): number {
    return (card.u ?? []).filter((upgrade) => name(upgrade) === token).length;
}

/**
 * Visible receipts from an action's before/after snapshots, not its list of possible rules modes.
 * Disappearing cards need a known destination; ambiguous copies and invisible ability text are left alone.
 */
export function observedOutcomes(game: Game, action: Action): CardEffectOutcome[] {
    const before = game.steps[action.index - 1]?.state;
    const after = game.steps[action.until]?.state;
    if (!before || !after) return [];
    const old = locate(before);
    const now = locate(after);
    const outcomes: CardEffectOutcome[] = [];
    const samePhase = before.round === after.round && before.phase === after.phase;
    const definition = action.card ? findCardEffect(action.card) : undefined;
    const kinds = new Set(cardAbilities(definition?.id ?? '').map((beat) => beat.kind));
    const source = (item: Located) => item.seat === action.seat && !!action.card && (action.card.id
        ? item.card.id === action.card.id
        : identity(item.card) === identity(action.card));
    const add = (kind: CardEffectOutcome['kind'], item: Located, amount?: number | string, label?: string, zone = item.zone) => {
        outcomes.push({ kind, card: item.card, seat: item.seat, zone, ...(amount != null ? { amount } : {}), ...(label ? { label } : {}) });
    };

    for (const previous of old) {
        // A title shared by several copies in an old recording does not identify a particular card.
        if (!match(previous.card, old)) continue;
        const current = match(previous.card, now);
        // A token absent from the ending snapshot has no recorded destination or resolution cause.
        // Its actual absence still renders at handoff; a card's possible defeat clause is not an event receipt.
        if (!current) continue;
        if (previous.captured) {
            if (!current.captured && !current.upgrade && isUnit(current.card)
                && (current.zone === 'ground' || current.zone === 'space')) {
                // These snapshots establish a captive's route and final unit, not its original owner,
                // entry type, play costs or intervening triggers. Keep those details unknown.
                outcomes.push({ kind: 'rescue', card: previous.card, sourceCard: previous.host,
                    fromSeat: previous.seat, fromZone: previous.zone, seat: current.seat, zone: current.zone,
                    unit: current.card, amount: 1, label: 'Left captivity' });
            }
            if (!current.captured && !current.upgrade && current.zone === 'discard') {
                outcomes.push({ kind: 'discard', card: current.card, sourceCard: previous.host,
                    fromSeat: previous.seat, fromZone: 'capture', seat: current.seat, zone: 'discard',
                    ...(current.card.owner ? { ownerSeat: current.card.owner } : {}),
                    amount: 1, label: 'Captive moved to discard' });
            }
            continue;
        }
        const onBoard = previous.zone === 'ground' || previous.zone === 'space';
        if (current.captured) {
            if (onBoard && !previous.upgrade && isUnit(previous.card) && current.host) {
                outcomes.push({ kind: 'capture', card: current.card, sourceCard: current.host,
                    fromSeat: previous.seat, fromZone: previous.zone, seat: current.seat, zone: current.zone,
                    ...(current.card.owner ? { ownerSeat: current.card.owner } : {}), amount: 1, label: 'Unit captured' });
            }
            continue;
        }
        if (previous.upgrade && !current.upgrade && isUnit(current.card)
            && (current.zone === 'ground' || current.zone === 'space')) {
            // The recording establishes attachment-to-arena movement and the final body,
            // not a Pilot ability, play cost, fresh-entry cause or intervening triggers.
            outcomes.push({ kind: 'attach', card: current.card, sourceCard: previous.host,
                fromSeat: previous.seat, fromZone: previous.zone, seat: current.seat, zone: current.zone,
                ...(current.card.owner ? { ownerSeat: current.card.owner } : {}),
                unit: current.card, amount: 1, label: 'Attachment entered arena' });
            continue;
        }
        if (previous.upgrade && current.upgrade) {
            const controlChanged = 'controller' in previous.card && 'controller' in current.card && previous.card.controller !== current.card.controller;
            if (previous.host?.id !== current.host?.id || previous.host && current.host && identity(previous.host) !== identity(current.host) || previous.seat !== current.seat || controlChanged) {
                outcomes.push({ kind: 'attach', card: current.card, sourceCard: previous.host, targetCard: current.host,
                    fromSeat: previous.seat, fromZone: previous.zone, seat: current.seat, zone: current.zone,
                    ...(current.card.owner ? { ownerSeat: current.card.owner } : {}),
                    ...('controller' in current.card && (current.card.controller === 'p1' || current.card.controller === 'p2') ? { controllerSeat: current.card.controller } : {}),
                    amount: 1, label: 'Upgrade attachment changed' });
            }
            continue;
        }
        if (current.upgrade && !previous.upgrade && ['hand', 'discard'].includes(previous.zone) && current.host) {
            outcomes.push({ kind: 'play', playAs: 'upgrade', card: current.card, sourceCard: previous.card,
                targetCard: current.host, upgrade: current.card as UpgradeRef,
                fromSeat: previous.seat, fromZone: previous.zone, seat: current.seat, zone: current.zone,
                ...(current.card.owner ? { ownerSeat: current.card.owner } : {}),
                ...('controller' in current.card && (current.card.controller === 'p1' || current.card.controller === 'p2') ? { controllerSeat: current.card.controller } : {}),
                amount: 1, label: `Upgrade attached from ${previous.zone}` });
            continue;
        }
        if (previous.zone === 'resources' && !current.upgrade && current.zone === 'discard') {
            outcomes.push({ kind: 'discard', card: current.card, fromSeat: previous.seat, fromZone: 'resources',
                seat: current.seat, zone: 'discard', ...(current.card.owner ? { ownerSeat: current.card.owner } : {}),
                amount: 1, label: 'Card moved from resources to discard' });
            continue;
        }
        if (onBoard && !previous.upgrade && isUnit(previous.card) && current.zone === 'leader') {
            outcomes.push({ kind: 'defeat', card: previous.card, fromSeat: previous.seat, fromZone: previous.zone,
                seat: previous.seat, ownerSeat: current.seat, zone: 'leader', leader: after.players[current.seat].leader!,
                amount: 1, label: 'Leader undeployed' });
            continue;
        }
        if (current.zone === 'resources' && previous.zone !== 'resources' && !previous.upgrade) {
            outcomes.push({ kind: 'resource', card: current.card, fromSeat: previous.seat, fromZone: previous.zone,
                seat: current.seat, zone: 'resources', entersReady: (current.card as ResourceRef).x !== 1,
                ...(current.card.owner ? { ownerSeat: current.card.owner } : {}), amount: 1, label: 'Card moved to resources' });
            continue;
        }
        if (['discard', 'resources'].includes(previous.zone) && !previous.upgrade && isUnit(current.card)
            && (current.zone === 'ground' || current.zone === 'space')) {
            outcomes.push({ kind: 'play', card: current.card, fromSeat: previous.seat, fromZone: previous.zone,
                seat: current.seat, zone: current.zone, unit: current.card, amount: 1, label: `Entered arena from ${previous.zone}` });
            continue;
        }
        if (onBoard && current.zone === 'discard') {
            if (previous.upgrade) outcomes.push({ kind: 'defeat', card: previous.card, sourceCard: previous.host,
                seat: previous.seat, ownerSeat: current.seat, zone: 'discard', amount: 1, label: 'Upgrade defeated' });
            else add('defeat', previous, 1, 'Unit defeated', 'discard');
            continue;
        }
        if (onBoard && current.zone === 'hand') {
            if (previous.upgrade) outcomes.push({ kind: 'return', card: previous.card, sourceCard: previous.host,
                seat: current.seat, ownerSeat: current.seat, fromSeat: previous.seat, fromZone: previous.zone,
                zone: 'hand', destination: 'hand', amount: 1, label: 'Upgrade returned to owner’s hand' });
            else add('return', { ...previous, seat: current.seat }, 1, 'Returned to owner’s hand', 'hand');
            continue;
        }
        if (previous.zone === 'discard' && current.zone === 'hand') {
            add('recover', current, 1, 'Recovered from discard', 'hand');
            continue;
        }
        if (previous.zone === 'hand' && current.zone === 'discard' && !source(previous)) {
            add('discard', current, 1, 'Discarded from hand', 'discard');
            continue;
        }
        if (previous.zone === 'hand' && !previous.upgrade && isUnit(current.card)
            && (current.zone === 'ground' || current.zone === 'space')) {
            outcomes.push({ kind: 'play', card: current.card, seat: current.seat, fromSeat: previous.seat,
                fromZone: 'hand', zone: current.zone, amount: 1, label: 'Played from hand' });
            continue;
        }
        if (!onBoard || previous.upgrade || !isUnit(previous.card) || !isUnit(current.card)
            || (current.zone !== 'ground' && current.zone !== 'space')) continue;
        if (previous.seat !== current.seat) outcomes.push({ kind: 'control', card: previous.card,
            seat: current.seat, fromSeat: previous.seat, fromZone: previous.zone, zone: current.zone,
            ...(current.card.owner ? { ownerSeat: current.card.owner } : {}), amount: 1, label: 'Controller changed' });

        const damage = current.card.d - previous.card.d;
        if (damage > 0) add('damage', current, damage, `${damage} damage`);
        if (damage < 0) add('heal', current, -damage, `${-damage} damage healed`);
        const shields = tokenCount(current.card, 'shield') - tokenCount(previous.card, 'shield');
        if (shields > 0) add('shield', current, shields, `${shields} Shield token${shields === 1 ? '' : 's'} added`);
        if (samePhase) {
            const dp = current.card.p - previous.card.p;
            const dh = current.card.h - previous.card.h;
            const experience = tokenCount(current.card, 'experience') - tokenCount(previous.card, 'experience');
            if (dp > 0 || dh > 0) {
                const change = `${signed(Math.max(0, dp))}/${signed(Math.max(0, dh))}`;
                add('buff', current, change, experience > 0 ? `${experience} Experience · ${change}` : change);
            }
            if (dp < 0 || dh < 0) {
                const change = `${signed(Math.min(0, dp))}/${signed(Math.min(0, dh))}`;
                add('debuff', current, change, change);
            }
            if (experience > 0 && dp <= 0 && dh <= 0) {
                add('buff', current, `${experience} Experience`, 'Experience tokens added; other changes offset the stat gain');
            }
            if (previous.card.x && !current.card.x) add('ready', current, 1, 'Unit readied');
            if (!previous.card.x && current.card.x) add('exhaust', current, 1, 'Unit exhausted');
        }
    }

    for (const seat of SEATS) {
        const was = before.players[seat];
        const is = after.players[seat];
        const damage = is.base.d - was.base.d;
        if (damage) outcomes.push({ kind: damage > 0 ? 'damage' : 'heal', card: is.base, seat, zone: 'base', amount: Math.abs(damage), label: damage > 0 ? `${damage} base damage` : `${-damage} base damage healed` });
        // A supplied exact deck manifest can establish a physical route that aggregate counts cannot.
        // It still supplies no public reveal, Smuggle mode, payment or trigger evidence.
        if (was.knownDeck && is.knownDeck) for (const resource of is.resources ?? []) {
            if (!resource.id || match(resource, now)?.zone !== 'resources' || !absent(resource, old)
                || was.knownDeck.filter(c => c.id === resource.id).length !== 1
                || is.knownDeck.some(c => c.id === resource.id)) continue;
            outcomes.push({ kind: 'resource', card: resource, fromSeat: seat, fromZone: 'deck',
                seat, zone: 'resources', entersReady: resource.x !== 1,
                ...(resource.owner ? { ownerSeat: resource.owner } : {}), amount: 1, label: 'Known deck card moved to resources' });
        }
        const knownResourceArrivals = outcomes.filter(outcome => outcome.kind === 'resource' && outcome.seat === seat).length;
        const resourceGain = is.res.total - was.res.total - knownResourceArrivals;
        // An aggregate gain identifies neither the source event nor a particular resourced card.
        if (resourceGain > 0) outcomes.push({ kind: 'resource', card: null, seat, zone: 'resources', amount: resourceGain, label: `${resourceGain} resource${resourceGain === 1 ? '' : 's'} added` });

        const newHand = now.filter((item) => item.seat === seat && item.zone === 'hand' && !item.upgrade && absent(item.card, old));
        const deckLoss = Math.max(0, was.deck - is.deck);
        const drawn = kinds.has('draw') ? Math.min(newHand.length, deckLoss) : 0;
        if (drawn) outcomes.push({ kind: 'draw', card: drawn === 1 && newHand.length === 1 ? newHand[0].card : null, seat, zone: 'hand', amount: drawn, label: `${drawn} card${drawn === 1 ? '' : 's'} drawn from deck` });
        const newDiscard = now.filter((item) => item.seat === seat && item.zone === 'discard' && !item.upgrade && !source(item) && absent(item.card, old));
        const milled = kinds.has('mill') ? Math.min(newDiscard.length, Math.max(0, deckLoss - drawn)) : 0;
        if (milled) outcomes.push({ kind: 'mill', card: null, seat, zone: 'discard', amount: milled, label: `${milled} card${milled === 1 ? '' : 's'} milled from deck` });

        // Deck contents are not exposed. Restock's exact discard departures plus the deck count corroborate its route.
        const leftDiscard = old.filter((item) => item.seat === seat && item.zone === 'discard' && !item.upgrade && absent(item.card, now));
        const recovered = definition?.id === 'restock' ? Math.min(leftDiscard.length, Math.max(0, is.deck - was.deck)) : 0;
        if (recovered) outcomes.push({ kind: 'recover', card: recovered === 1 && leftDiscard.length === 1 ? leftDiscard[0].card : null, seat, zone: 'deck', amount: recovered, label: `${recovered} card${recovered === 1 ? '' : 's'} recovered from discard to deck bottom` });
    }
    return outcomes;
}
