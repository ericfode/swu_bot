import type { CardRef, Seat, Snapshot, UnitRef } from '../data/types';
import type { AbilityBeat } from './abilities';
import type { PreviewCardCost } from './previewCosts';
import type { CardEffectDefinition, CardEffectOutcome, PreviewPlayPayment } from './types';

/** Verified clauses and deliberately selected receipts; docs/card-animation-a03-spec.md. No replay reconstruction. */
export const A03_DEFINITIONS: CardEffectDefinition[] = [
    { id: 'precision-fire', name: 'Precision Fire', setCode: 'SOR_168', family: 'tactics', color: '#fac17c', visual: 'precision-fire', durationMs: 5600, description: 'Attack with Saboteur; a Trooper also gets +2/+0 for that attack. Ordinary simultaneous combat still applies.' },
    { id: 'smoke-and-cinders', name: 'Smoke and Cinders', setCode: 'SOR_174', family: 'tactics', color: '#d4b295', visual: 'smoke-and-cinders', durationMs: 5100, description: 'Each player chooses their own hand discards until they have at most two cards.' },
    { id: 'forced-surrender', name: 'Forced Surrender', setCode: 'SOR_175', family: 'tactics', color: '#e6c58e', visual: 'forced-surrender', durationMs: 5100, description: 'Draw two; each opponent whose base you actually damaged this phase chooses two discards.' },
    { id: 'no-good-to-me-dead', name: 'No Good to Me Dead', setCode: 'SOR_186', family: 'tactics', color: '#cea2dc', visual: 'no-good-to-me-dead', durationMs: 4200, description: 'Exhaust any unit and prevent it from readying for this round, including regroup.' },
    { id: 'i-had-no-choice', name: 'I Had No Choice', setCode: 'SOR_187', family: 'tactics', color: '#edcc91', visual: 'i-had-no-choice', durationMs: 5500, description: 'Choose up to two non-leader units; an opponent splits them between owner hand and owner deck bottom.' },
    { id: 'bamboozle', name: 'Bamboozle', setCode: 'SOR_199', family: 'tactics', color: '#c9b3ec', visual: 'bamboozle', durationMs: 5800, description: 'Optionally pay by discarding another Cunning card; exhaust a unit and return each upgrade to its owner.' },
    { id: 'disarm', name: 'Disarm', setCode: 'SOR_216', family: 'tactics', color: '#c6a5ed', visual: 'disarm', durationMs: 3900, description: 'An enemy unit gets −4/−0 this phase; effective power stops at zero.' },
    { id: 'shoot-first', name: 'Shoot First', setCode: 'SOR_217', family: 'tactics', color: '#f6c68c', visual: 'shoot-first', durationMs: 4900, description: 'Attack with +1/+0 and deal combat damage first; a defeated defender cannot deal counterdamage.' },
    { id: 'asteroid-sanctuary', name: 'Asteroid Sanctuary', setCode: 'SOR_218', family: 'support', color: '#99d6e8', visual: 'asteroid-sanctuary', durationMs: 4600, description: 'Exhaust an enemy unit; give a Shield to a friendly unit with printed cost at most three.' },
    { id: 'dont-get-cocky', name: "Don't Get Cocky", setCode: 'SOR_223', family: 'damage', color: '#f3ce7c', visual: 'dont-get-cocky', durationMs: 5700, description: 'Publicly reveal one at a time, up to seven; sum at most seven damages a chosen unit, then revealed cards go to random bottom.' }
];

export const A03_COSTS: Record<string, PreviewCardCost> = {
    'precision-fire': { printed: 1, aspects: ['aggression'] }, 'smoke-and-cinders': { printed: 5, aspects: ['aggression'] },
    'forced-surrender': { printed: 6, aspects: ['aggression'] }, 'no-good-to-me-dead': { printed: 2, aspects: ['cunning', 'villainy'] },
    'i-had-no-choice': { printed: 7, aspects: ['cunning', 'villainy'] },
    bamboozle: { printed: 2, aspects: ['cunning', 'heroism'] },
    disarm: { printed: 1, aspects: ['cunning'] }, 'shoot-first': { printed: 1, aspects: ['cunning'] },
    'asteroid-sanctuary': { printed: 2, aspects: ['cunning'] }, 'dont-get-cocky': { printed: 4, aspects: ['cunning'] }
};

export const A03_ABILITIES: Record<string, AbilityBeat[]> = {
    'precision-fire': [
        { kind: 'attack', label: 'Attack with a ready friendly unit if able', scope: 'friendly-unit', selection: 'chosen', condition: 'Ordinary arena and attack restrictions; attack-only Saboteur can ignore Sentinel' },
        { kind: 'keyword', label: 'It gains Saboteur for this attack', scope: 'friendly-unit', duration: 'attack', condition: 'Any selected attacker, not only Troopers; ignore Sentinel and defeat all defending unit Shields on attack declaration; no first strike or Overwhelm' },
        { kind: 'buff', label: 'If it is a Trooper, also give +2/+0 for this attack', scope: 'friendly-unit', amount: '+2/+0', duration: 'attack', condition: 'Actual Trooper trait; abilities blanked can prevent keyword effects' }
    ],
    'smoke-and-cinders': [{ kind: 'discard', label: 'Each player chooses their own discards until at most two hand cards remain', scope: 'chosen-player-hand', amount: 'all but 2', selection: 'chosen', condition: 'Source already leaves hand; no discard or draw for hands of 0, 1 or 2' }],
    'forced-surrender': [
        { kind: 'draw', label: 'Draw 2 cards', scope: 'own-hand', from: 'own-deck', amount: 2 },
        { kind: 'discard', label: 'Each opponent whose base you damaged this phase chooses 2 hand discards', scope: 'enemy-hand', amount: 2, selection: 'opponent', condition: 'Actual positive current-phase damage attributed to event controller; not existing counters/card ownership; simultaneous with draw, not draw-success dependent' }
    ],
    'no-good-to-me-dead': [
        { kind: 'exhaust', label: 'Exhaust a unit', scope: 'target', selection: 'chosen', condition: 'Any controller or arena, including deployed leader; already exhausted legal' },
        { kind: 'restrict', label: 'That unit cannot ready this round, including regroup', scope: 'target', duration: 'round', condition: 'Current arena incarnation; not suppression, phase-only, or delayed defeat' }
    ],
    'i-had-no-choice': [
        { kind: 'return', label: 'Choose up to 2 non-leader units; an opponent chooses one to return to its owner hand', scope: 'owner-hand', amount: 'up to 2', selection: 'opponent', optional: true, condition: 'P1 selects distinct eligible units, either controller/arena; with multiple opponents P1 chooses the chooser; choosing zero legal' },
        { kind: 'return', label: 'Put the other selected unit on the bottom of its owner deck', scope: 'owner-deck', condition: 'Only if two were selected; no shuffle/defeat/hand waypoint; attachments follow their own leave-play rules, tokens cease' }
    ],
    bamboozle: [
        { kind: 'discard', label: 'May discard another Cunning card from your own hand instead of all play costs', scope: 'own-hand', amount: 1, selection: 'chosen', optional: true, condition: 'Another actual Cunning card, not source; replaces all additional costs too; unavailable for Smuggle; normal play triggers remain' },
        { kind: 'exhaust', label: 'Exhaust any unit', scope: 'target', selection: 'chosen', condition: 'Either controller/arena, including deployed leader' },
        { kind: 'return', label: 'Return every ordinary upgrade on it to each upgrade owner hand', scope: 'owner-hand', amount: 'all upgrades', selection: 'all', condition: 'Not host owner; tokens cease, attached leaders follow leader leave-play rules; host remains unless separately supported lethal stat-removal consequence' }
    ],
    disarm: [{ kind: 'debuff', label: 'Give an enemy unit −4/−0 this phase', scope: 'enemy-unit', amount: '−4/−0', duration: 'phase', selection: 'chosen', condition: 'Either arena including deployed leaders; effective power floors at 0; no HP/damage/readiness/ability change' }],
    'shoot-first': [
        { kind: 'attack', label: 'Attack with a ready friendly unit if able', scope: 'friendly-unit', selection: 'chosen', condition: 'Ordinary arena/Sentinel/attack restrictions; base never counterattacks' },
        { kind: 'buff', label: 'Give +1/+0 for this attack', scope: 'friendly-unit', amount: '+1/+0', duration: 'attack' },
        { kind: 'attack', label: 'Attacker deals combat damage before defending unit', scope: 'enemy-unit', condition: 'Defeated defender deals no combat; surviving defender uses updated power, including Grit; not immunity to all counterdamage' }
    ],
    'asteroid-sanctuary': [
        { kind: 'exhaust', label: 'Exhaust an enemy unit', scope: 'enemy-unit', selection: 'chosen', condition: 'Either arena; already exhausted legal; independent from Shield clause' },
        { kind: 'shield', label: 'Give a Shield to a friendly unit with printed cost at most 3', scope: 'friendly-unit', amount: 1, duration: 'token', selection: 'chosen', condition: 'Printed cost ignores modifiers; either arena, independent target; no successful-exhaust prerequisite' }
    ],
    'dont-get-cocky': [
        { kind: 'search', label: 'Choose any unit and publicly reveal deck top one card at a time until choosing stop or revealing 7', scope: 'own-deck', amount: '1 to 7', selection: 'chosen', condition: 'Either controller/arena including leader; first reveal required for nonempty deck; short deck stops at end; can continue after bust' },
        { kind: 'damage', label: 'If combined revealed printed cost is at most 7, deal that sum to chosen unit', scope: 'target', amount: 'sum if ≤7', condition: 'Above 7 deals no damage, not capped 7; printed costs ignore modifiers; empty deck no damage' },
        { kind: 'search', label: 'Put every revealed card on deck bottom in random order', scope: 'own-deck', selection: 'random', condition: 'Same actual revealed prefix, even after bust; untouched remainder stays ordered; no draw/discard/deck-count change' }
    ]
};

const labels: Record<string, string> = {
    'precision-fire': 'Trooper Marine gains Saboteur/+2; bypass Sentinel, remove Shield, deal 5 and take 2 counterdamage',
    'smoke-and-cinders': 'Each player chooses two discards and keeps their own two; event already left P1 hand',
    'forced-surrender': 'P1 earlier dealt 2 to P2 base this phase; draw two, P2 chooses two discards',
    'no-good-to-me-dead': 'Exhaust Wampa; cannot ready during round 9, including regroup',
    'i-had-no-choice': 'Pay 11 from 12; P1 selects Marine/Wampa, P2 chooses Marine to owner hand, Wampa to owner deck bottom',
    bamboozle: 'Discard actual Cunning Disarm instead of all costs; exhaust Wampa, return upgrades to their owners, tokens cease',
    disarm: 'Wampa loses 4 power this phase, floored at zero; HP, damage and ready pose stay unchanged',
    'shoot-first': 'Marine attacks for 4 first; defeated Death Trooper cannot counter, Marine keeps its original 1 damage',
    'asteroid-sanctuary': 'Exhaust enemy ground Death Trooper; Shield friendly space X-Wing, printed cost 2',
    'dont-get-cocky': 'Reveal costs 1, 2, 1; choose STOP at 4, deal 4 to Wampa, put all three on random bottom'
};
export const A03_EXAMPLES: Record<string, { label: string; beats: AbilityBeat[] }> = Object.fromEntries(
    Object.entries(labels).map(([id, label]) => [id, { label, beats: A03_ABILITIES[id] }])
);

const supported = new Set(A03_DEFINITIONS.map(d => d.id));
const other = (seat: Seat): Seat => seat === 'p1' ? 'p2' : 'p1';
const card = (id: string, n: string, s: string | null, owner: Seat): CardRef => ({ id, n, s, owner });
const unit = (c: CardRef, p: number, h: number, d = 0, extra: Partial<UnitRef> = {}): UnitRef => ({ ...c, p, h, d, incarnation: `${c.id}:entry-1`, ...extra });
const unknownDeck = (seat: Seat, amount: number): CardRef[] => Array.from({ length: amount }, (_, i) => card(`a03:${seat}:deck:${i}`, 'Unknown card', null, seat));
const facts: Record<string, { cost: number; arena?: 'ground' | 'space'; trooper?: true }> = {
    SOR_095: { cost: 2, arena: 'ground', trooper: true }, SOR_098: { cost: 3, arena: 'ground', trooper: true },
    SOR_033: { cost: 3, arena: 'ground', trooper: true }, SOR_164: { cost: 4, arena: 'ground' }, SOR_207: { cost: 2, arena: 'ground' },
    SOR_237: { cost: 2, arena: 'space' }, SOR_225: { cost: 1, arena: 'space' }, SOR_074: { cost: 1 },
    SOR_123: { cost: 1 }, SOR_172: { cost: 3 }, SOR_077: { cost: 4 }, SOR_126: { cost: 3 }, SOR_245: { cost: 0 }
};
const fail = (message: string): never => { throw new Error(`A03: ${message}`); };
const requireUnit = (u: UnitRef | undefined, role: string): UnitRef => {
    if (!u?.id || !u.incarnation || !u.s || !facts[u.s]?.arena) fail(`missing verified ${role}`);
    return u!;
};

export function a03ShowcaseState(definition: CardEffectDefinition): Snapshot | undefined {
    if (!supported.has(definition.id)) return undefined;
    const state: Snapshot = { round: 9, phase: 'action', initiative: 'p1', players: {
        p1: { name: 'Rebel Alliance', base: { ...card('a03:p1:base', 'Echo Base', 'SOR_024', 'p1'), hp: 30, d: 9 },
            leader: { ...card('a03:p1:leader', 'Luke Skywalker: Faithful Friend', 'SOR_005', 'p1'), dep: 0, x: 0 }, res: { ready: 10, total: 10 },
            hand: [card(`a03:${definition.id}:event`, definition.name, definition.setCode, 'p1')], deck: 27, knownDeck: unknownDeck('p1', 27), discard: [],
            ground: [unit(card('a03:p1:marine', 'Battlefield Marine', 'SOR_095', 'p1'), 3, 3, 1), unit(card('a03:p1:defender', 'Echo Base Defender', 'SOR_098', 'p1'), 4, 3, 0, { sn: 1 })],
            space: [unit(card('a03:p1:xwing', 'Alliance X-Wing', 'SOR_237', 'p1'), 2, 3)] },
        p2: { name: 'Galactic Empire', base: { ...card('a03:p2:base', 'Capital City', 'SOR_020', 'p2'), hp: 30, d: 6 },
            leader: { ...card('a03:p2:leader', 'Darth Vader: Dark Lord of the Sith', 'SOR_010', 'p2'), dep: 0, x: 1 }, res: { ready: 7, total: 10 },
            hand: [card('a03:p2:takedown-hand', 'Takedown', 'SOR_077', 'p2')], deck: 29, knownDeck: unknownDeck('p2', 29), discard: [],
            ground: [unit(card('a03:p2:trooper', 'Death Trooper', 'SOR_033', 'p2'), 3, 3), unit(card('a03:p2:wampa', 'Wampa', 'SOR_164', 'p2'), 4, 5, 1)],
            space: [unit(card('a03:p2:tie', 'TIE/ln Fighter', 'SOR_225', 'p2'), 2, 1)] }
    } };
    const p1 = state.players.p1, p2 = state.players.p2;
    const face = (id: string, n: string, s: string, owner: Seat = 'p1') => card(id, n, s, owner);
    switch (definition.id) {
        case 'precision-fire':
            p1.ground[0].d = 0;
            p2.ground = [unit(face('a03:p2:sentinel', 'Echo Base Defender', 'SOR_098', 'p2'), 4, 3, 0, { sn: 1 }),
                unit(face('a03:p2:smuggler', 'Crafty Smuggler', 'SOR_207', 'p2'), 2, 2, 0, { u: [{ ...card('a03:precision:shield', 'Shield', null, 'p2'), t: 1, p: 0, h: 0 }] })];
            break;
        case 'smoke-and-cinders':
            p1.hand.push(face('a03:smoke:p1:keep:0', 'Battlefield Marine', 'SOR_095'), face('a03:smoke:p1:keep:1', 'Repair', 'SOR_074'),
                face('a03:smoke:p1:discard:0', 'Open Fire', 'SOR_172'), face('a03:smoke:p1:discard:1', 'Wampa', 'SOR_164'));
            p2.hand.push(face('a03:smoke:p2:keep:1', 'TIE/ln Fighter', 'SOR_225', 'p2'), face('a03:smoke:p2:discard:0', 'Resupply', 'SOR_126', 'p2'), face('a03:smoke:p2:discard:1', 'Recruit', 'SOR_123', 'p2'));
            break;
        case 'forced-surrender':
            p1.knownDeck!.splice(0, 2, face('a03:forced:draw:0', 'Battlefield Marine', 'SOR_095'), face('a03:forced:draw:1', 'Open Fire', 'SOR_172'));
            p1.space[0].x = 1;
            state.baseDamagedThisPhase = { round: 9, phase: 'action', damage: [{ player: 'p1', sourceId: p1.space[0].id!, targetId: p2.base.id!, amount: 2 }] };
            p2.hand.push(face('a03:forced:p2:discard:0', 'TIE/ln Fighter', 'SOR_225', 'p2'), face('a03:forced:p2:discard:1', 'Recruit', 'SOR_123', 'p2'));
            break;
        case 'i-had-no-choice': p1.res = { ready: 12, total: 12 }; break;
        case 'bamboozle': {
            p1.hand.push(face('a03:bamboozle:payment', 'Disarm', 'SOR_216'));
            const w = p2.ground[1];
            w.u = [{ ...face('a03:bamboozle:academy', 'Academy Training', 'SOR_120', 'p2'), t: 0, p: 2, h: 2 },
                { ...face('a03:bamboozle:entrenched', 'Entrenched', 'SOR_072'), t: 0, p: 3, h: 3 },
                { ...card('a03:bamboozle:shield', 'Shield', null, 'p2'), t: 1, p: 0, h: 0 },
                { ...card('a03:bamboozle:experience', 'Experience', null, 'p2'), t: 1, p: 1, h: 1 }];
            w.p = 10; w.h = 11;
            break;
        }
        case 'dont-get-cocky':
            p2.ground[1].d = 0;
            p1.knownDeck!.splice(0, 3, face('a03:cocky:top:0', 'Repair', 'SOR_074'), face('a03:cocky:top:1', 'Battlefield Marine', 'SOR_095'), face('a03:cocky:top:2', 'Recruit', 'SOR_123'));
            break;
    }
    return state;
}

/** The selected alternate payment is evidence, separate from ordinary metadata-derived cost. */
export function a03PreviewPayment(definition: CardEffectDefinition, state: Snapshot, seat: Seat): PreviewPlayPayment | undefined {
    if (!supported.has(definition.id)) return undefined;
    if (definition.id !== 'bamboozle') return { kind: 'resources' };
    const source = state.players[seat].hand.find(c => c.s === definition.setCode), payment = state.players[seat].hand.find(c => c.id === 'a03:bamboozle:payment');
    if (!source?.id || !payment) fail('alternate Bamboozle payment requires the source and actual selected hand card');
    return { kind: 'alternate-discard', sourceId: source!.id!, cards: [payment!], requiredAspect: 'cunning', replacesAllCosts: true };
}

export function a03PreviewOutcomes(definition: CardEffectDefinition, state: Snapshot, seat: Seat): CardEffectOutcome[] | undefined {
    if (!supported.has(definition.id)) return undefined;
    const foe = other(seat), friend = state.players[seat], enemy = state.players[foe];
    const source = friend.hand.find(c => c.s === definition.setCode);
    if (!source?.id) fail('missing source event');
    const m = friend.ground.find(c => c.id === 'a03:p1:marine'), x = friend.space.find(c => c.id === 'a03:p1:xwing');
    const w = enemy.ground.find(c => c.id === 'a03:p2:wampa'), t = enemy.ground.find(c => c.id === 'a03:p2:trooper');
    const outcomes: CardEffectOutcome[] = [];
    const add = (kind: CardEffectOutcome['kind'], c: CardRef | undefined | null, side: Seat, amount: number | string | undefined,
        zone: NonNullable<CardEffectOutcome['zone']>, label: string, extra: Partial<CardEffectOutcome> = {}) => outcomes.push({ kind, card: c, seat: side, amount, zone, label, ...extra });
    const deck = () => { if (!friend.knownDeck || friend.knownDeck.length !== friend.deck) fail('complete staged deck required'); return friend.knownDeck!; };
    const discard = (c: CardRef, side: Seat, extra: Partial<CardEffectOutcome> = {}) => add('discard', c, side, 1, 'discard', `${side.toUpperCase()} CHOOSES · DISCARD`, { fromSeat: side, fromZone: 'hand', ownerSeat: c.owner, chooserSeat: side, selection: 'chosen', ...extra });
    const removeUnit = (u: UnitRef, side: Seat, attackId: string) => add('defeat', u, side, 1, 'discard', 'COMBAT DEFEAT', { fromSeat: side, fromZone: 'ground', ownerSeat: u.owner, attackId });
    const combat = (precision: boolean) => {
        const attacker = requireUnit(m, 'ready attacker'), defender = requireUnit(precision ? enemy.ground.find(c => c.id === 'a03:p2:smuggler') : t, 'defender');
        if (attacker.x || facts[attacker.s!]!.arena !== 'ground' || facts[defender.s!]!.arena !== 'ground') fail('attack requires a ready legal ground attacker and defender');
        if (attacker.status?.some(status => status.kind === 'suppressed')) fail('blanked attacker cannot establish this staged keyword composition');
        if (!precision && enemy.ground.some(c => c.sn && c.id !== defender.id)) fail('attack cannot bypass enemy Sentinel');
        const bonus = precision ? (facts[attacker.s!].trooper ? 2 : 0) : 1;
        const id = `a03:${definition.id}:attack:1`, evidence = { attackId: id, attackIndex: 1, sourceCard: attacker };
        if (precision) add('keyword', attacker, seat, 1, 'ground', 'SABOTEUR · THIS ATTACK', { ...evidence, keyword: { name: 'Saboteur', amount: 1 }, duration: 'attack' });
        if (bonus) add('buff', attacker, seat, `+${bonus}/+0`, 'ground', `+${bonus} · THIS ATTACK`, { ...evidence, duration: 'attack' });
        add('attack', defender, foe, attacker.p + bonus, 'ground', precision ? 'SABOTEUR BYPASSES SENTINEL' : 'ATTACKER DEALS COMBAT FIRST', { ...evidence, combatOrder: precision ? 'simultaneous' : 'attacker-first' });
        add('exhaust', attacker, seat, 1, 'ground', 'ATTACKER EXHAUSTED', evidence);
        const shields = (defender.u ?? []).filter(c => c.t && c.n === 'Shield');
        if (precision) for (const shield of shields) add('defeat', shield, foe, 1, 'ground', 'SABOTEUR · SHIELD CEASES', { sourceCard: defender, attackId: id });
        const forward = !precision && shields.length ? 0 : attacker.p + bonus;
        if (!precision && shields[0]) add('defeat', shields[0], foe, 1, 'ground', 'SHIELD PREVENTS COMBAT', { sourceCard: defender, attackId: id });
        add('damage', defender, foe, forward, 'ground', `${forward} COMBAT DAMAGE`, { ...evidence, damageType: 'combat' });
        const defeated = defender.d + forward >= defender.h;
        if (!precision && defeated) removeUnit(defender, foe, id);
        if (precision || !defeated) {
            add('damage', attacker, seat, defender.p, 'ground', `${defender.p} COMBAT COUNTER`, { attackId: id, attackIndex: 1, sourceCard: defender, damageType: 'combat' });
            if (attacker.d + defender.p >= attacker.h) removeUnit(attacker, seat, id);
        }
        if (precision && defeated) removeUnit(defender, foe, id);
    };
    switch (definition.id) {
        case 'precision-fire': combat(true); break;
        case 'shoot-first': combat(false); break;
        case 'smoke-and-cinders':
            for (const side of [seat, foe]) {
                const hand = state.players[side].hand.filter(c => c.id !== source!.id), amount = Math.max(0, hand.length - 2);
                const selected = hand.filter(c => c.id?.includes(`:smoke:${side}:discard:`));
                if (selected.length !== amount) fail('each player must explicitly choose all but two actual hand cards');
                for (const c of selected) discard(c, side);
            }
            break;
        case 'forced-surrender': {
            if (friend.deck < 2) fail('primary Forced Surrender requires two actual deck cards; failed-draw base damage needs separate explicit receipts');
            const drawn = deck().slice(0, Math.min(2, friend.deck));
            add('draw', drawn.length === 1 ? drawn[0] : null, seat, 2, 'hand', 'DRAW 2', { fromSeat: seat, fromZone: 'deck', cards: drawn });
            const history = state.baseDamagedThisPhase;
            if (!history || history.round !== state.round || history.phase !== state.phase
                || !history.damage.some(d => d.player === seat && d.targetId === enemy.base.id && d.amount > 0 && !!d.sourceId)) break;
            const selected = enemy.hand.filter(c => c.id?.includes(':forced:p2:discard:')).slice(0, Math.min(2, enemy.hand.length));
            if (selected.length !== Math.min(2, enemy.hand.length)) fail('opponent must explicitly choose actual Forced Surrender discards');
            for (const c of selected) discard(c, foe, { baseDamagePhase: { round: state.round, phase: state.phase, player: seat, targetId: enemy.base.id! } });
            break;
        }
        case 'no-good-to-me-dead': {
            const target = requireUnit(w, 'Wampa');
            add('exhaust', target, foe, 1, 'ground', 'EXHAUST WAMPA');
            add('restrict', target, foe, undefined, 'ground', `CANNOT READY · ROUND ${state.round}`, { restriction: 'cannot-ready', duration: 'round', round: state.round, incarnation: target.incarnation });
            break;
        }
        case 'i-had-no-choice': {
            const marine = requireUnit(m, 'selected Marine'), wampa = requireUnit(w, 'selected Wampa');
            for (const [c, destination] of [[marine, 'hand'], [wampa, 'deck-bottom']] as const) {
                const owner = c.owner!;
                add('return', c, owner, 1, destination === 'hand' ? 'hand' : 'deck', destination === 'hand' ? 'P2 CHOOSES · OWNER HAND' : 'OTHER UNIT · OWNER DECK BOTTOM',
                    { fromSeat: c === marine ? seat : foe, fromZone: 'ground', ownerSeat: owner, chooserSeat: foe, selection: 'opponent', destination });
            }
            break;
        }
        case 'bamboozle': {
            const host = requireUnit(w, 'upgrade host');
            add('exhaust', host, foe, 1, 'ground', 'EXHAUST · HOST STAYS');
            for (const upgrade of host.u ?? []) {
                const owner = upgrade.owner;
                if (!owner || upgrade.p === undefined || upgrade.h === undefined) fail('attachment owner and stat contributions must be explicit');
                add('return', upgrade, owner!, 1, 'hand', upgrade.t ? 'TOKEN CEASES · HOST STAYS' : `${owner!.toUpperCase()} OWNER HAND`,
                    { sourceCard: host, fromSeat: foe, fromZone: 'ground', ownerSeat: owner, destination: 'hand', selection: 'all' });
            }
            break;
        }
        case 'disarm': add('debuff', requireUnit(w, 'enemy unit'), foe, '−4/−0', 'ground', '−4 POWER · THIS PHASE', { duration: 'phase' }); break;
        case 'asteroid-sanctuary': {
            if (t) add('exhaust', requireUnit(t, 'enemy exhaustion target'), foe, 1, 'ground', 'ENEMY EXHAUSTED');
            if (x && facts[x.s ?? '']?.cost <= 3) add('shield', requireUnit(x, 'friendly Shield target'), seat, 1, 'space', 'PRINTED COST 2 ≤ 3 · SHIELD',
                { sourceCard: x, printedCost: facts[x.s!].cost, cards: [card('a03:asteroid:shield', 'Shield', null, seat)] });
            break;
        }
        case 'dont-get-cocky': {
            const manifest = deck(), looked = manifest.filter((_, i) => i < 7 && manifest[i].id?.startsWith('a03:cocky:top:'));
            if (!manifest.length) break;
            if (!looked.length || looked.some((c, i) => manifest[i] !== c)) fail('one-at-a-time reveals require an actual nonempty deck prefix');
            const printedCosts: Record<string, number> = {};
            let value = 0;
            const runningTotals = looked.map(c => {
                const cost = facts[c.s ?? '']?.cost;
                if (cost === undefined) fail('revealed printed cost lacks verified metadata');
                printedCosts[c.id!] = cost!; return value += cost!;
            });
            const stop = looked.length === 7 ? 'limit' : looked.length === manifest.length ? 'deck-end' : 'chosen';
            add('search', null, seat, looked.length, 'deck', `PUBLIC REVEAL · ${stop === 'chosen' ? 'STOP' : stop.toUpperCase()} AT ${value}`, { cards: looked, chooserSeat: seat, selection: 'chosen',
                deckOperation: { scope: 'top', visibility: 'public', policy: 'top-search-bottom', looked, selectedIds: [], printedCosts,
                    remainingOrder: [...manifest.slice(looked.length), ...looked.toReversed()], reveal: { runningTotals, stop, limit: 7, damageThreshold: 7 } } });
            if (value <= 7) {
                const target = requireUnit(w, 'chosen damage target');
                add('damage', target, foe, value, 'ground', `REVEALED PRINTED SUM ${value} → DAMAGE`, { damageType: 'ability',
                    basis: { kind: 'printed-cost-sum', sourceIds: looked.map(c => c.id!), value, printedCosts, threshold: 7 } });
                if (target.d + value >= target.h) add('defeat', target, foe, 1, 'discard', 'LETHAL ABILITY DAMAGE', { fromSeat: foe, fromZone: 'ground', ownerSeat: target.owner });
            }
            break;
        }
    }
    return outcomes;
}
