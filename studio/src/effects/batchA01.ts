import type { CardRef, PendingEffect, Seat, Snapshot, UnitRef, UpgradeRef } from '../data/types';
import type { AbilityBeat } from './abilities';
import type { PreviewCardCost } from './previewCosts';
import type { CardEffectDefinition, CardEffectOutcome } from './types';

/** A01 rules and deliberate examples: docs/card-animation-a01-spec.md. Engine/card data stay read-only. */
export const A01_DEFINITIONS: CardEffectDefinition[] = [
    { id: 'moment-of-peace', name: 'Moment of Peace', setCode: 'SOR_073', family: 'support', color: '#85dfff', visual: 'moment-of-peace', durationMs: 2200,
        description: 'Give a Shield token to a unit.' },
    { id: 'mission-briefing', name: 'Mission Briefing', setCode: 'SOR_171', family: 'support', color: '#a0dbea', visual: 'mission-briefing', durationMs: 2500,
        description: 'Choose a player. They draw 2 cards.' },
    { id: 'keep-fighting', name: 'Keep Fighting', setCode: 'SOR_169', family: 'tactics', color: '#73e2cc', visual: 'keep-fighting', durationMs: 2200,
        description: 'Ready a unit with 3 or less current power.' },
    { id: 'outmaneuver', name: 'Outmaneuver', setCode: 'SOR_221', family: 'tactics', color: '#e5be73', visual: 'outmaneuver', durationMs: 2700,
        description: 'Choose ground or space. Exhaust every unit in that arena on both sides.' },
    { id: 'attack-pattern-delta', name: 'Attack Pattern Delta', setCode: 'SOR_106', family: 'tactics', color: '#a6e495', visual: 'attack-pattern-delta', durationMs: 2900,
        description: 'Give three distinct friendly units +3/+3, +2/+2 and +1/+1, in that order, for this phase.' },
    { id: 'power-failure', name: 'Power Failure', setCode: 'SOR_170', family: 'tactics', color: '#efb474', visual: 'power-failure', durationMs: 2800,
        description: 'Defeat any number of upgrades attached to one unit.' },
    { id: 'change-of-heart', name: 'Change of Heart', setCode: 'SOR_224', family: 'tactics', color: '#edbaee', visual: 'change-of-heart', durationMs: 3000,
        description: 'Take control of a non-leader unit. At regroup start, its owner takes control of it.' },
    { id: 'sneak-attack', name: 'Sneak Attack', setCode: 'SOR_219', family: 'tactics', color: '#eace79', visual: 'sneak-attack', durationMs: 3100,
        description: 'Play a unit from your hand for 3 less, entering ready. Defeat that unit at regroup start.' },
    { id: 'recruit', name: 'Recruit', setCode: 'SOR_123', family: 'support', color: '#95d9bb', visual: 'recruit', durationMs: 3200,
        description: 'Search your top 5 for a unit, reveal and draw it. Put unchosen cards on the bottom in random order.' },
    { id: 'strike-true', name: 'Strike True', setCode: 'SOR_127', family: 'damage', color: '#ffae80', visual: 'strike-true', durationMs: 2400,
        description: 'A friendly unit deals its current power as damage to an enemy unit. This is not an attack.' }
];

export const A01_COSTS: Record<string, PreviewCardCost> = {
    'moment-of-peace': { printed: 1, aspects: ['vigilance'] },
    'mission-briefing': { printed: 3, aspects: ['aggression'] },
    'keep-fighting': { printed: 2, aspects: ['aggression'] },
    outmaneuver: { printed: 3, aspects: ['cunning'] },
    'attack-pattern-delta': { printed: 3, aspects: ['command', 'command'] },
    'power-failure': { printed: 2, aspects: ['aggression'] },
    'change-of-heart': { printed: 6, aspects: ['cunning'] },
    'sneak-attack': { printed: 2, aspects: ['cunning'] },
    recruit: { printed: 1, aspects: ['command'] },
    'strike-true': { printed: 3, aspects: ['command'] }
};

/** Complete clauses. Example choices and observed outcomes are separate data. */
export const A01_ABILITIES: Record<string, AbilityBeat[]> = {
    'moment-of-peace': [
        { kind: 'shield', label: 'Give a Shield token to a unit', amount: 1, scope: 'target', selection: 'chosen', duration: 'token',
            condition: 'Either side or arena; deployed leaders and already shielded units are legal' }
    ],
    'mission-briefing': [
        { kind: 'draw', label: 'Choose a player; they draw 2 cards', amount: 2, scope: 'chosen-player-hand', selection: 'chosen',
            condition: 'The chosen player draws from their own deck; each unavailable draw causes 3 base damage under the ordinary draw rules' }
    ],
    'keep-fighting': [
        { kind: 'ready', label: 'Ready a unit with current power 3 or less', amount: 1, scope: 'target', selection: 'chosen',
            condition: 'Either player, either arena, including deployed leaders; current power includes all modifiers; no attack follows' }
    ],
    outmaneuver: [
        { kind: 'exhaust', label: 'Choose ground or space; exhaust every unit there on both sides', amount: 'all', scope: 'arena', selection: 'all',
            condition: 'Includes deployed leaders and already exhausted units; other arena and undeployed leaders unaffected' }
    ],
    'attack-pattern-delta': [
        { kind: 'buff', label: 'Give a friendly unit +3/+3 this phase', amount: '+3/+3', scope: 'friendly-unit', selection: 'chosen', duration: 'phase' },
        { kind: 'buff', label: 'Then give another friendly unit +2/+2 this phase', amount: '+2/+2', scope: 'friendly-unit', selection: 'chosen', duration: 'phase',
            condition: 'Different unit from the first; if another legal friendly unit exists' },
        { kind: 'buff', label: 'Then give a third distinct friendly unit +1/+1 this phase', amount: '+1/+1', scope: 'friendly-unit', selection: 'chosen', duration: 'phase',
            condition: 'Different unit from both prior selections; if a third legal friendly unit exists' }
    ],
    'power-failure': [
        { kind: 'defeat', label: 'Defeat any number of upgrades attached to one chosen unit', amount: 'any number', scope: 'target', selection: 'chosen', optional: true,
            condition: 'Any side or arena, including deployed leaders; every chosen upgrade must be on this one host; choosing no host or no upgrades is legal; tokens cease, ordinary upgrades go to their owners’ discard' }
    ],
    'change-of-heart': [
        { kind: 'control', label: 'Take control of a non-leader unit', amount: 1, scope: 'target', selection: 'chosen',
            condition: 'Either side or arena; preserves owner, arena, exhaustion, damage and attachments; no unit currently classed as a leader' },
        { kind: 'delay', label: 'At regroup start, its owner takes control of it', amount: 1, scope: 'target', duration: 'regroup',
            condition: 'Applies to this same entry in play; owner may differ from former controller; does not restore a departed unit; later leader status can cause defeat instead of control change' }
    ],
    'sneak-attack': [
        { kind: 'cost', label: 'The chosen unit costs 3 less to play', amount: -3, scope: 'own-hand', selection: 'chosen',
            condition: 'Pay the source event too; ordinary unit play cost and aspect penalties still apply; cost cannot become negative' },
        { kind: 'play', label: 'Play a unit from your hand; it enters ready', amount: 1, scope: 'friendly-arena', from: 'own-hand', selection: 'chosen',
            condition: 'Play as a unit, not a pilot upgrade; it is a normal play with entry and uniqueness consequences; no attack follows' },
        { kind: 'delay', label: 'At regroup start, defeat that unit', amount: 1, scope: 'target', duration: 'regroup',
            condition: 'Install only if the played unit remains in play; leaving play cancels this entry’s obligation, even if the same card is replayed' }
    ],
    recruit: [
        { kind: 'search', label: 'Search your top 5 for up to one unit; reveal the selection; put all unchosen searched cards at deck bottom in random order', amount: 5, scope: 'own-deck', selection: 'chosen', optional: true,
            condition: 'Take nothing is legal; fewer cards searched with a short deck; other search modifiers require explicit evidence; only the selected face is public' },
        { kind: 'draw', label: 'Draw that selected unit', amount: 1, scope: 'own-hand', from: 'own-deck',
            condition: 'Only if a unit was selected; do not draw or play the other searched cards' }
    ],
    'strike-true': [
        { kind: 'damage', label: 'A friendly unit deals its current power as damage to an enemy unit', amount: 'source unit’s power', scope: 'enemy-unit', from: 'friendly-unit', selection: 'chosen',
            condition: 'Source and target may be in different arenas or be deployed leaders; no readiness, uniqueness or attack-targeting restriction; ability damage, no attack or counterdamage' }
    ]
};

export const A01_EXAMPLES: Record<string, { label: string; beats: AbilityBeat[] }> = {
    'moment-of-peace': { label: 'Shield the damaged Marine; no damage is healed', beats: A01_ABILITIES['moment-of-peace'] },
    'mission-briefing': { label: 'Opponent draws 2 from their own deck', beats: A01_ABILITIES['mission-briefing'] },
    'keep-fighting': { label: 'Ready the exhausted 3-power Marine; no attack', beats: A01_ABILITIES['keep-fighting'] },
    outmaneuver: { label: 'Ground: all 4 units on both sides exhaust; Wampa was already exhausted', beats: A01_ABILITIES.outmaneuver },
    'attack-pattern-delta': { label: 'Marine +3/+3; Defender +2/+2; X-Wing +1/+1 · this phase', beats: A01_ABILITIES['attack-pattern-delta'] },
    'power-failure': { label: 'Remove 3 Wampa upgrades; keep Experience and the host', beats: A01_ABILITIES['power-failure'] },
    'change-of-heart': { label: 'Take the exhausted Wampa; owner P2 regains it at regroup start', beats: A01_ABILITIES['change-of-heart'] },
    'sneak-attack': { label: 'Event costs 4; Wampa 6 → 3, enters ready; defeat at regroup start', beats: [
        ...A01_ABILITIES['sneak-attack'],
        { kind: 'pay', label: 'Pay the selected unit’s discounted cost', amount: 3, scope: 'resources' }
    ] },
    recruit: { label: 'Search 5; reveal and draw Marine; other 4 to bottom in random order', beats: A01_ABILITIES.recruit },
    'strike-true': { label: 'Exhausted Marine deals its 3 power to Wampa; no attack', beats: A01_ABILITIES['strike-true'] }
};

const known = new Set(A01_DEFINITIONS.map(definition => definition.id));
const other = (seat: Seat): Seat => seat === 'p1' ? 'p2' : 'p1';
const card = (id: string, n: string, s: string | null, owner: Seat): CardRef => ({ id, n, s, owner });
const unit = (id: string, n: string, s: string, owner: Seat, p: number, h: number, d: number, extra: Partial<UnitRef> = {}): UnitRef =>
    ({ ...card(id, n, s, owner), incarnation: `${id}:entry-1`, p, h, d, ...extra });
const unknownDeck = (seat: Seat, count: number): CardRef[] => Array.from({ length: count }, (_, i) =>
    card(`a01:${seat}:deck:${i}`, 'Unknown card', null, seat));

/** A complete, deliberate before state. No recording is reconstructed with these fixtures. */
export function a01ShowcaseState(definition: CardEffectDefinition): Snapshot | undefined {
    if (!known.has(definition.id)) return undefined;
    const state: Snapshot = {
        round: 9, phase: 'action', initiative: 'p1',
        players: {
            p1: {
                name: 'Rebel Alliance',
                base: { ...card('a01:p1:base', 'Echo Base', 'SOR_024', 'p1'), hp: 30, d: 9 },
                leader: { ...card('a01:p1:leader', 'Luke Skywalker: Faithful Friend', 'SOR_005', 'p1'), dep: 0, x: 0 },
                res: { ready: 10, total: 10 },
                hand: [card(`a01:${definition.id}:event`, definition.name, definition.setCode, 'p1')],
                deck: 27, knownDeck: unknownDeck('p1', 27), discard: [],
                ground: [
                    unit('a01:p1:marine', 'Battlefield Marine', 'SOR_095', 'p1', 3, 3, 1),
                    unit('a01:p1:defender', 'Echo Base Defender', 'SOR_098', 'p1', 4, 3, 0, { sn: 1 })
                ],
                space: [unit('a01:p1:xwing', 'Alliance X-Wing', 'SOR_237', 'p1', 2, 3, 0)]
            },
            p2: {
                name: 'Galactic Empire',
                base: { ...card('a01:p2:base', 'Capital City', 'SOR_020', 'p2'), hp: 30, d: 6 },
                leader: { ...card('a01:p2:leader', 'Darth Vader: Dark Lord of the Sith', 'SOR_010', 'p2'), dep: 0, x: 1 },
                res: { ready: 7, total: 10 },
                hand: [card('a01:p2:takedown-hand', 'Takedown', 'SOR_077', 'p2')],
                deck: 29, knownDeck: unknownDeck('p2', 29), discard: [],
                ground: [
                    unit('a01:p2:trooper', 'Death Trooper', 'SOR_033', 'p2', 3, 3, 0),
                    unit('a01:p2:wampa', 'Wampa', 'SOR_164', 'p2', 4, 5, 1)
                ],
                space: [unit('a01:p2:tie', 'TIE/ln Fighter', 'SOR_225', 'p2', 2, 1, 0)]
            }
        }
    };
    const marine = state.players.p1.ground[0];
    const wampa = state.players.p2.ground[1];
    if (['keep-fighting', 'strike-true'].includes(definition.id)) marine.x = 1;
    if (['outmaneuver', 'power-failure', 'change-of-heart'].includes(definition.id)) wampa.x = 1;
    if (definition.id === 'mission-briefing') {
        state.players.p2.knownDeck!.splice(0, 2,
            card('a01:mission-briefing:p2:draw:0', 'Open Fire', 'SOR_172', 'p2'),
            card('a01:mission-briefing:p2:draw:1', 'Wampa', 'SOR_164', 'p2'));
    }
    if (definition.id === 'power-failure') {
        const upgrades: UpgradeRef[] = [
            { ...card('a01:power-failure:academy', 'Academy Training', 'SOR_120', 'p2'), t: 0, p: 2, h: 2 },
            { ...card('a01:power-failure:entrenched', 'Entrenched', 'SOR_072', 'p2'), t: 0, p: 3, h: 3 },
            { ...card('a01:power-failure:shield', 'Shield', null, 'p2'), t: 1, p: 0, h: 0 },
            { ...card('a01:power-failure:experience', 'Experience', null, 'p2'), t: 1, p: 1, h: 1 }
        ];
        wampa.u = upgrades;
        wampa.p = 10;
        wampa.h = 11;
    }
    if (definition.id === 'sneak-attack') {
        state.players.p1.hand.push(card('a01:sneak-attack:wampa-hand', 'Wampa', 'SOR_164', 'p1'));
    }
    if (definition.id === 'recruit') {
        state.players.p1.knownDeck!.splice(0, 5,
            card('a01:recruit:top:0', 'Open Fire', 'SOR_172', 'p1'),
            card('a01:recruit:top:1', 'Battlefield Marine', 'SOR_095', 'p1'),
            card('a01:recruit:top:2', 'Repair', 'SOR_074', 'p1'),
            card('a01:recruit:top:3', 'Alliance X-Wing', 'SOR_237', 'p1'),
            card('a01:recruit:top:4', 'Resupply', 'SOR_126', 'p1'));
    }
    return state;
}

/** Explicit staged receipts, never a substitute for a recorded action's resolved snapshot. */
export function a01PreviewOutcomes(definition: CardEffectDefinition, state: Snapshot, seat: Seat): CardEffectOutcome[] | undefined {
    if (!known.has(definition.id)) return undefined;
    const foe = other(seat);
    const friend = state.players[seat];
    const enemy = state.players[foe];
    const source = friend.hand.find(c => c.s === definition.setCode);
    if (!source?.id) throw new Error(`A01 ${definition.id}: staged source event is missing`);
    const marine = friend.ground.find(c => c.n === 'Battlefield Marine');
    const defender = friend.ground.find(c => c.n === 'Echo Base Defender');
    const xwing = friend.space.find(c => c.n === 'Alliance X-Wing');
    const wampa = enemy.ground.find(c => c.n === 'Wampa');
    const outcomes: CardEffectOutcome[] = [];
    const add = (kind: CardEffectOutcome['kind'], recipient: CardRef | null | undefined, side: Seat, amount: number | string | undefined,
        zone: NonNullable<CardEffectOutcome['zone']>, label: string, extra: Partial<CardEffectOutcome> = {}) => {
        outcomes.push({ kind, card: recipient, seat: side, amount, zone, label, ...extra });
    };
    const requireUnit = (selected: UnitRef | undefined, role: string): UnitRef => {
        if (!selected?.id || !selected.incarnation) throw new Error(`A01 ${definition.id}: staged ${role} is missing`);
        return selected;
    };
    switch (definition.id) {
        case 'moment-of-peace':
            add('shield', requireUnit(marine, 'Marine'), seat, 1, 'ground', '1 SHIELD');
            break;
        case 'mission-briefing': {
            const drawn = enemy.knownDeck?.slice(0, 2);
            if (!drawn || drawn.length !== 2) throw new Error('A01 Mission Briefing: two actual staged deck cards are required');
            for (const selected of drawn) add('draw', selected, foe, 1, 'hand', 'DRAW 1');
            break;
        }
        case 'keep-fighting':
            add('ready', requireUnit(marine, 'Marine'), seat, 1, 'ground', '3 POWER · READY');
            break;
        case 'outmaneuver':
            for (const side of [seat, foe]) {
                for (const selected of state.players[side].ground) {
                    add('exhaust', selected, side, selected.x ? 0 : 1, 'ground', selected.x ? 'ALREADY EXHAUSTED' : 'EXHAUSTED · GROUND');
                }
            }
            break;
        case 'attack-pattern-delta':
            add('buff', requireUnit(marine, 'Marine'), seat, '+3/+3', 'ground', '+3/+3 · THIS PHASE', { duration: 'phase' });
            add('buff', requireUnit(defender, 'Defender'), seat, '+2/+2', 'ground', '+2/+2 · THIS PHASE', { duration: 'phase' });
            add('buff', requireUnit(xwing, 'X-Wing'), seat, '+1/+1', 'space', '+1/+1 · THIS PHASE', { duration: 'phase' });
            break;
        case 'power-failure': {
            const host = requireUnit(wampa, 'upgraded Wampa');
            const selected = (host.u ?? []).filter(upgrade => upgrade.id !== 'a01:power-failure:experience');
            if (selected.length !== 3) throw new Error('A01 Power Failure: three selected upgrades on one host are required');
            for (const upgrade of selected) add('defeat', upgrade, foe, 1, upgrade.t ? 'ground' : 'discard', upgrade.t ? 'SHIELD DEFEATED · TOKEN REMOVED' : 'UPGRADE → DISCARD',
                { sourceCard: host, fromSeat: foe, fromZone: 'ground', ownerSeat: upgrade.owner ?? foe });
            break;
        }
        case 'change-of-heart': {
            const selected = requireUnit(wampa, 'Wampa');
            const owner = selected.owner;
            if (!owner) throw new Error('A01 Change of Heart: explicitly staged owner is required');
            const pending: PendingEffect = {
                id: 'a01:change-of-heart:regroup:W', sourceId: source.id, targetId: selected.id!, incarnation: selected.incarnation!,
                trigger: 'regroup-start', kind: 'return-control', returnController: owner
            };
            add('control', selected, seat, 1, 'ground', 'P1 CONTROLS · OWNER P2', { fromSeat: foe, fromZone: 'ground', ownerSeat: owner });
            add('delay', selected, seat, 1, 'ground', 'OWNER REGAINS CONTROL · REGROUP START', { duration: 'regroup', pending, ownerSeat: owner });
            break;
        }
        case 'sneak-attack': {
            const selected = friend.hand.find(c => c.id === 'a01:sneak-attack:wampa-hand');
            if (!selected?.id) throw new Error('A01 Sneak Attack: the actual hand Wampa is required');
            const played: UnitRef = { ...selected, incarnation: `${selected.id}:entry-1`, p: 4, h: 5, d: 0 };
            const pending: PendingEffect = {
                id: 'a01:sneak-attack:regroup:wampa:entry-1', sourceId: source.id, targetId: selected.id, incarnation: played.incarnation!,
                trigger: 'regroup-start', kind: 'defeat'
            };
            add('cost', selected, seat, -3, 'hand', 'UNIT 6 → 3 · COST −3', { sourceCard: selected });
            add('pay', selected, seat, 3, 'resources', 'UNIT 6 → 3 · PAID 3');
            add('play', selected, seat, 1, 'ground', 'PLAYED READY', { unit: played, entersReady: true, fromSeat: seat, fromZone: 'hand', ownerSeat: seat });
            add('delay', selected, seat, 1, 'ground', 'DEFEAT · REGROUP START', { duration: 'regroup', pending, ownerSeat: seat });
            break;
        }
        case 'recruit': {
            const searched = friend.knownDeck?.slice(0, 5);
            const selected = searched?.find(c => c.id === 'a01:recruit:top:1');
            if (!searched || searched.length !== 5 || !selected) throw new Error('A01 Recruit: a complete five-card staged search and selected unit are required');
            add('search', selected, seat, 5, 'deck', 'SEARCH 5 · REVEAL 1 · OTHER 4 TO BOTTOM, RANDOM ORDER', { cards: searched });
            add('draw', selected, seat, 1, 'hand', 'REVEALED UNIT → HAND');
            break;
        }
        case 'strike-true': {
            const attacker = requireUnit(marine, 'damage source Marine');
            const target = requireUnit(wampa, 'damage recipient Wampa');
            add('damage', target, foe, attacker.p, 'ground', `${attacker.p} DAMAGE · NO ATTACK`, { sourceCard: attacker, fromSeat: seat, fromZone: 'ground' });
            break;
        }
    }
    return outcomes;
}
