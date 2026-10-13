import type { CardRef, Seat, Snapshot, UnitRef } from '../data/types';
import type { AbilityBeat } from './abilities';
import type { PreviewCardCost } from './previewCosts';
import type { CardEffectDefinition, CardEffectOutcome, DeckOperation } from './types';

/** Verified rules and deliberate receipts: docs/card-animation-a02-spec.md. Never reconstructs replay truth. */
export const A02_DEFINITIONS: CardEffectDefinition[] = [
    { id: 'search-your-feelings', name: 'Search Your Feelings', setCode: 'SOR_042', family: 'support', color: '#d6be89', visual: 'search-your-feelings', durationMs: 4800,
        description: 'Privately search your whole deck for any card, draw it, then shuffle the rest.' },
    { id: 'it-binds-all-things', name: 'It Binds All Things', setCode: 'SOR_075', family: 'force', color: '#91eac2', visual: 'it-binds-all-things', durationMs: 4700,
        description: 'Heal up to 3 from a unit. With a friendly Force unit, optionally deal that much to another unit.' },
    { id: 'the-emperors-legion', name: "The Emperor's Legion", setCode: 'SOR_091', family: 'support', color: '#beceaa', visual: 'the-emperors-legion', durationMs: 4700,
        description: 'Return every unit in your discard that was defeated this phase to your hand.' },
    { id: 'rebel-assault', name: 'Rebel Assault', setCode: 'SOR_103', family: 'tactics', color: '#ffcd8d', visual: 'rebel-assault', durationMs: 5900,
        description: 'Attack with a Rebel, then another Rebel; each gets +1/+0 for its attack.' },
    { id: 'uwing-reinforcement', name: 'U-Wing Reinforcement', setCode: 'SOR_104', family: 'support', color: '#9cdce8', visual: 'uwing-reinforcement', durationMs: 6400,
        description: 'Search top 10; play up to 3 units with combined printed cost at most 7 for free. Other cards to random bottom.' },
    { id: 'heroic-sacrifice', name: 'Heroic Sacrifice', setCode: 'SOR_150', family: 'tactics', color: '#f6c394', visual: 'heroic-sacrifice', durationMs: 5600,
        description: 'Draw, then attack with +2/+0. Defeat the attacker when it deals combat damage during that attack.' },
    { id: 'karabast', name: 'Karabast', setCode: 'SOR_151', family: 'damage', color: '#ffb77c', visual: 'karabast', durationMs: 4300,
        description: 'A friendly unit deals its current damage plus 1 to an enemy unit; no attack.' },
    { id: 'for-a-cause-i-believe-in', name: 'For a Cause I Believe In', setCode: 'SOR_152', family: 'damage', color: '#f4dd86', visual: 'for-a-cause-i-believe-in', durationMs: 5600,
        description: 'Reveal top 4; each Heroism card damages an enemy base. Discard any revealed cards, return others to top in chosen order.' },
    { id: 'rallying-cry', name: 'Rallying Cry', setCode: 'SOR_154', family: 'tactics', color: '#eaca86', visual: 'rallying-cry', durationMs: 4200,
        description: 'Every current friendly unit gains Raid 2 this phase; resting power stays unchanged.' },
    { id: 'force-throw', name: 'Force Throw', setCode: 'SOR_167', family: 'force', color: '#c6b4eb', visual: 'force-throw', durationMs: 4900,
        description: 'Chosen player chooses their hand discard. With a friendly Force unit, optionally damage a unit by the discarded printed cost.' }
];

export const A02_COSTS: Record<string, PreviewCardCost> = {
    'search-your-feelings': { printed: 4, aspects: ['villainy', 'vigilance'] },
    'it-binds-all-things': { printed: 2, aspects: ['vigilance'] },
    'the-emperors-legion': { printed: 2, aspects: ['command', 'villainy'] },
    'rebel-assault': { printed: 1, aspects: ['heroism', 'command'] },
    'uwing-reinforcement': { printed: 7, aspects: ['heroism', 'command'] },
    'heroic-sacrifice': { printed: 1, aspects: ['aggression', 'heroism'] },
    karabast: { printed: 2, aspects: ['aggression', 'heroism'] },
    'for-a-cause-i-believe-in': { printed: 3, aspects: ['aggression', 'heroism'] },
    'rallying-cry': { printed: 3, aspects: ['aggression', 'aggression'] },
    'force-throw': { printed: 1, aspects: ['aggression'] }
};

export const A02_ABILITIES: Record<string, AbilityBeat[]> = {
    'search-your-feelings': [
        { kind: 'search', label: 'Privately search the whole deck for any card; then shuffle the remainder', scope: 'own-deck', amount: 'all', selection: 'chosen', optional: true,
            condition: 'Any card type; may take nothing; selected face is not publicly revealed; empty search does not attempt a blind draw' },
        { kind: 'draw', label: 'Draw the selected card', scope: 'own-hand', from: 'own-deck', amount: 1, condition: 'Only if a card was selected' }
    ],
    'it-binds-all-things': [
        { kind: 'heal', label: 'Heal up to 3 damage from one unit', scope: 'target', amount: 'up to 3', selection: 'chosen', optional: true,
            condition: 'Any controller or arena, including deployed leaders; not a base; heal only existing damage' },
        { kind: 'damage', label: 'You may deal the actual amount healed to another unit', scope: 'target', amount: 'actual healed', selection: 'chosen', optional: true,
            condition: 'Control an in-play Force unit; different unit from healed recipient, any controller or arena; zero-heal pinned-engine branch has a missing-event limitation' }
    ],
    'the-emperors-legion': [
        { kind: 'recover', label: 'Return each unit in your discard defeated this phase to hand', scope: 'own-hand', from: 'discard', amount: 'all eligible', selection: 'all',
            condition: 'Current own discard pile plus actual current-phase defeat history; no Imperial restriction; former controller irrelevant; ordinary discard or a prior-phase defeat is ineligible' }
    ],
    'rebel-assault': [
        { kind: 'attack', label: 'Attack with a ready Rebel unit', scope: 'friendly-unit', selection: 'chosen', condition: 'A legal attack if able; ordinary arena/Sentinel/attack restrictions apply' },
        { kind: 'buff', label: 'First Rebel gets +1/+0 for this attack', scope: 'friendly-unit', amount: '+1/+0', duration: 'attack' },
        { kind: 'attack', label: 'Then attack with another ready Rebel unit', scope: 'friendly-unit', selection: 'chosen', condition: 'Different from first; resolve first attack and triggers before second; never readies a unit' },
        { kind: 'buff', label: 'Second Rebel gets +1/+0 for this attack', scope: 'friendly-unit', amount: '+1/+0', duration: 'attack' }
    ],
    'uwing-reinforcement': [
        { kind: 'search', label: 'Search top 10 for up to 3 units, combined printed cost at most 7', scope: 'own-deck', amount: 10, selection: 'chosen', optional: true,
            condition: 'Short deck searches fewer; take nothing legal; unchosen searched cards to random bottom; selected order determines play order' },
        { kind: 'play', label: 'Play each selected unit from deck for free', scope: 'friendly-arena', from: 'own-deck', amount: 'up to 3',
            condition: 'Sequential normal plays and triggers; exhausted normal entry; resource costs including aspect penalties ignored, other additional costs still apply; Pilots only as units' }
    ],
    'heroic-sacrifice': [
        { kind: 'draw', label: 'Draw a card', scope: 'own-hand', from: 'own-deck', amount: 1 },
        { kind: 'attack', label: 'Then attack with a ready unit if able', scope: 'friendly-unit', selection: 'chosen', condition: 'Ordinary legal attack restrictions apply' },
        { kind: 'buff', label: 'It gets +2/+0 and a combat-damage self-defeat trigger for this attack', scope: 'friendly-unit', amount: '+2/+0', duration: 'attack' },
        { kind: 'defeat', label: 'When this attacker deals combat damage, defeat it', scope: 'friendly-unit', condition: 'Actual positive combat damage from this attacker during that attack; not prevented damage or ability damage; no regroup delay' }
    ],
    karabast: [
        { kind: 'damage', label: 'A friendly unit deals its current damage counters plus 1 to an enemy unit', scope: 'enemy-unit', from: 'friendly-unit', amount: 'damage + 1', selection: 'chosen',
            condition: 'Any arena, including deployed leaders; units only; exhausted source legal; no attack, exhaust payment, healing or power-based formula' }
    ],
    'for-a-cause-i-believe-in': [
        { kind: 'search', label: 'Publicly reveal the top 4', scope: 'own-deck', amount: 4, condition: 'Fewer with a short deck; reveal visibility only, no draw' },
        { kind: 'damage', label: 'Deal 1 to an enemy base for each revealed Heroism card', scope: 'enemy-base', amount: 'Heroism cards', condition: 'Count each original revealed Heroism card once, even if later discarded' },
        { kind: 'discard', label: 'You may discard any subset of the revealed deck cards', scope: 'discard', from: 'own-deck', amount: 'any subset', selection: 'chosen', optional: true },
        { kind: 'search', label: 'Put all other revealed cards back on top in any chosen order', scope: 'own-deck', selection: 'chosen', condition: 'No shuffle/random bottom; lethal base damage ends the game without a later choice prompt in pinned engine' }
    ],
    'rallying-cry': [
        { kind: 'keyword', label: 'Each current friendly unit gains Raid 2 this phase', scope: 'friendly-arena', amount: 2, duration: 'phase', selection: 'all',
            condition: 'Both arenas and deployed leaders; stacks with Raid; +2 power only while attacking; no attack/ready/resting power increase; later entrants are not current targets' }
    ],
    'force-throw': [
        { kind: 'discard', label: 'Choose a player; that player chooses one card from their own hand to discard', scope: 'chosen-player-hand', amount: 1, selection: 'chosen', condition: 'Either player; actual chooser is the selected player, not necessarily event controller' },
        { kind: 'damage', label: 'You may deal the discarded printed cost as damage to a unit', scope: 'target', amount: 'discarded printed cost', selection: 'chosen', optional: true,
            condition: 'Actual discard and friendly in-play Force unit; any unit in either arena/controller, not a base; printed cost ignores discounts/aspect penalties; no payment of that cost' }
    ]
};

const exampleLabels: Record<string, string> = {
    'search-your-feelings': 'Privately draw any card: Open Fire; shuffle the other 26',
    'it-binds-all-things': 'Force unit Luke heals 3; choose to deal those 3 to a different unit, Wampa',
    'the-emperors-legion': 'Recover Marine and X-Wing defeated this phase; older Defender stays in discard',
    'rebel-assault': 'Two Rebels attack the base in order: Marine 4, then X-Wing 3; attack bonuses expire',
    'uwing-reinforcement': 'Select 2 + 3 + 2 = 7; three units play free from deck, entering exhausted',
    'heroic-sacrifice': 'Draw Repair; Marine attacks base for 5, then is defeated for dealing combat damage',
    karabast: 'Exhausted Marine has 1 damage; it deals 1 + 1 = 2 to Wampa',
    'for-a-cause-i-believe-in': 'Reveal 4, count 2 Heroism; discard X-Wing/Open Fire, put Repair then Marine on top',
    'rallying-cry': 'All three friendly units gain Raid 2 this phase; resting power and readiness stay unchanged',
    'force-throw': 'P2 chooses Takedown to discard; friendly Force unit permits 4 damage to Wampa'
};
export const A02_EXAMPLES: Record<string, { label: string; beats: AbilityBeat[] }> = Object.fromEntries(
    Object.entries(exampleLabels).map(([id, label]) => [id, { label, beats: A02_ABILITIES[id] }])
);

const definitions = new Set(A02_DEFINITIONS.map(c => c.id));
const other = (seat: Seat): Seat => seat === 'p1' ? 'p2' : 'p1';
const card = (id: string, n: string, s: string | null, owner: Seat): CardRef => ({ id, n, s, owner });
const unit = (c: CardRef, p: number, h: number, d = 0, extra: Partial<UnitRef> = {}): UnitRef => ({ ...c, incarnation: `${c.id}:entry-1`, p, h, d, ...extra });
const unknownDeck = (seat: Seat, amount: number, id: string): CardRef[] => Array.from({ length: amount }, (_, i) => card(`a02:${id}:${seat}:unknown:${i}`, 'Unknown card', null, seat));
/** Only metadata used by these deliberate choices, independently checked against installed JSON. */
const selectedUnits: Record<string, { p: number; h: number; cost: number; arena: 'ground' | 'space'; sn?: 1 }> = {
    SOR_095: { p: 3, h: 3, cost: 2, arena: 'ground' }, SOR_098: { p: 4, h: 3, cost: 3, arena: 'ground', sn: 1 },
    SOR_237: { p: 2, h: 3, cost: 2, arena: 'space' }, SOR_164: { p: 4, h: 5, cost: 4, arena: 'ground' },
    SOR_225: { p: 2, h: 1, cost: 1, arena: 'space' }
};
const forcePrints = new Set(['SOR_051', 'SOR_005', 'SOR_010']);
const rebelPrints = new Set(['SOR_095', 'SOR_098', 'SOR_237', 'SOR_051']);
const heroPrints = new Set(['SOR_095', 'SOR_098', 'SOR_237', 'SOR_051']);
const requireId = (c: CardRef | undefined, label: string): CardRef => { if (!c?.id) throw new Error(`A02: missing ${label}`); return c; };

export function a02ShowcaseState(definition: CardEffectDefinition): Snapshot | undefined {
    if (!definitions.has(definition.id)) return undefined;
    const state: Snapshot = { round: 9, phase: 'action', initiative: 'p1', players: {
        p1: { name: 'Rebel Alliance', base: { ...card('a02:p1:base', 'Echo Base', 'SOR_024', 'p1'), hp: 30, d: 9 },
            leader: { ...card('a02:p1:leader', 'Luke Skywalker: Faithful Friend', 'SOR_005', 'p1'), dep: 0, x: 0 },
            res: { ready: 10, total: 10 }, hand: [card(`a02:${definition.id}:event`, definition.name, definition.setCode, 'p1')],
            deck: 27, knownDeck: unknownDeck('p1', 27, definition.id), discard: [],
            ground: [unit(card('a02:p1:marine', 'Battlefield Marine', 'SOR_095', 'p1'), 3, 3, 1), unit(card('a02:p1:defender', 'Echo Base Defender', 'SOR_098', 'p1'), 4, 3, 0, { sn: 1 })],
            space: [unit(card('a02:p1:xwing', 'Alliance X-Wing', 'SOR_237', 'p1'), 2, 3)] },
        p2: { name: 'Galactic Empire', base: { ...card('a02:p2:base', 'Capital City', 'SOR_020', 'p2'), hp: 30, d: 6 },
            leader: { ...card('a02:p2:leader', 'Darth Vader: Dark Lord of the Sith', 'SOR_010', 'p2'), dep: 0, x: 1 },
            res: { ready: 7, total: 10 }, hand: [card('a02:p2:takedown-hand', 'Takedown', 'SOR_077', 'p2')],
            deck: 29, knownDeck: unknownDeck('p2', 29, definition.id), discard: [],
            ground: [unit(card('a02:p2:trooper', 'Death Trooper', 'SOR_033', 'p2'), 3, 3), unit(card('a02:p2:wampa', 'Wampa', 'SOR_164', 'p2'), 4, 5, 1)],
            space: [unit(card('a02:p2:tie', 'TIE/ln Fighter', 'SOR_225', 'p2'), 2, 1)] }
    } };
    const p1 = state.players.p1;
    const face = (id: string, name: string, print: string) => card(id, name, print, 'p1');
    if (['it-binds-all-things', 'force-throw'].includes(definition.id)) {
        p1.ground[1] = unit(face('a02:p1:force', 'Luke Skywalker: Jedi Knight', 'SOR_051'), 6, 7, definition.id === 'it-binds-all-things' ? 3 : 0);
    }
    if (definition.id === 'search-your-feelings') p1.knownDeck![8] = face('a02:search-your-feelings:selected', 'Open Fire', 'SOR_172');
    if (definition.id === 'heroic-sacrifice') p1.knownDeck![0] = face('a02:heroic-sacrifice:draw', 'Repair', 'SOR_074');
    if (definition.id === 'karabast') p1.ground[0].x = 1;
    if (definition.id === 'force-throw') state.players.p2.ground[1].d = 0;
    if (definition.id === 'the-emperors-legion') {
        p1.discard = [face('a02:legion:marine', 'Battlefield Marine', 'SOR_095'), face('a02:legion:xwing', 'Alliance X-Wing', 'SOR_237'),
            face('a02:legion:old', 'Echo Base Defender', 'SOR_098'), face('a02:legion:event-old', 'Open Fire', 'SOR_172')];
        state.defeatedThisPhase = { round: 9, phase: 'action', cards: [{ id: 'a02:legion:marine', controller: 'p2' }, { id: 'a02:legion:xwing', controller: 'p1' }] };
    }
    if (definition.id === 'uwing-reinforcement') {
        const faces = [['Battlefield Marine', 'SOR_095'], ['Open Fire', 'SOR_172'], ['Repair', 'SOR_074'], ['Echo Base Defender', 'SOR_098'],
            ['Resupply', 'SOR_126'], ['Wampa', 'SOR_164'], ['Moment of Peace', 'SOR_073'], ['Alliance X-Wing', 'SOR_237'], ['Recruit', 'SOR_123'], ['TIE/ln Fighter', 'SOR_225']];
        p1.knownDeck!.splice(0, 10, ...faces.map(([n, s], i) => face(`a02:uwing:top:${i}`, n, s)));
    }
    if (definition.id === 'for-a-cause-i-believe-in') {
        p1.knownDeck!.splice(0, 4, ...[['Battlefield Marine', 'SOR_095'], ['Alliance X-Wing', 'SOR_237'], ['Open Fire', 'SOR_172'], ['Repair', 'SOR_074']]
            .map(([n, s], i) => face(`a02:cause:top:${i}`, n, s)));
    }
    return state;
}

export function a02PreviewOutcomes(definition: CardEffectDefinition, state: Snapshot, seat: Seat): CardEffectOutcome[] | undefined {
    if (!definitions.has(definition.id)) return undefined;
    const foe = other(seat), friend = state.players[seat], enemy = state.players[foe];
    requireId(friend.hand.find(c => c.s === definition.setCode), 'source event');
    const m = friend.ground.find(c => c.s === 'SOR_095'), x = friend.space.find(c => c.s === 'SOR_237'), w = enemy.ground.find(c => c.s === 'SOR_164');
    const outcomes: CardEffectOutcome[] = [];
    const add = (kind: CardEffectOutcome['kind'], c: CardRef | null | undefined, side: Seat, amount: number | string | undefined,
        zone: NonNullable<CardEffectOutcome['zone']>, label: string, extra: Partial<CardEffectOutcome> = {}) => outcomes.push({ kind, card: c, seat: side, amount, zone, label, ...extra });
    const deck = () => { if (!friend.knownDeck || friend.knownDeck.length !== friend.deck) throw new Error('A02: complete staged deck manifest required'); return friend.knownDeck; };
    const hasForce = () => [...friend.ground, ...friend.space].some(c => c.s && forcePrints.has(c.s));
    const target = (c: UnitRef | undefined, role: string): UnitRef => { requireId(c, role); if (!c!.incarnation) throw new Error(`A02: ${role} has no incarnation`); return c!; };
    const operation = (op: DeckOperation, label: string) => add('search', null, seat, op.looked.length, 'deck', label,
        { cards: op.looked, selection: 'chosen', chooserSeat: seat, deckOperation: op });
    const attack = (attacker: UnitRef, bonus: number, index: number) => {
        if (attacker.x || (definition.id === 'rebel-assault' && (!attacker.s || !rebelPrints.has(attacker.s)))) throw new Error('A02: attacker must be a ready eligible unit');
        const arena = friend.space.includes(attacker) ? 'space' : 'ground';
        if (enemy[arena].some(c => c.sn)) throw new Error('A02: staged base attack cannot bypass enemy Sentinel');
        const id = `a02:${definition.id}:attack:${index}`, evidence = { attackId: id, attackIndex: index, sourceCard: attacker };
        add('buff', attacker, seat, `+${bonus}/+0`, arena, `+${bonus} · THIS ATTACK`, { duration: 'attack', ...evidence });
        add('attack', enemy.base, foe, attacker.p + bonus, 'base', `ATTACK ${index} · BASE`, evidence);
        add('exhaust', attacker, seat, 1, arena, 'ATTACKER EXHAUSTED', evidence);
        add('damage', enemy.base, foe, attacker.p + bonus, 'base', `${attacker.p + bonus} COMBAT DAMAGE`, { ...evidence, damageType: 'combat' });
        return evidence;
    };
    switch (definition.id) {
        case 'search-your-feelings': {
            const manifest = deck(), chosen = manifest.find(c => c.id === 'a02:search-your-feelings:selected');
            if (!chosen) throw new Error('A02 Search: chosen card missing from whole deck');
            operation({ scope: 'whole', visibility: 'private', policy: 'whole-search-shuffle', looked: manifest,
                selectedIds: [chosen.id!], remainingOrder: [chosen, ...manifest.filter(c => c !== chosen).toReversed()], selectionLimit: 1 }, 'PRIVATE SEARCH · WHOLE DECK SHUFFLE');
            add('draw', chosen, seat, 1, 'hand', 'PRIVATE DRAW 1', { fromSeat: seat, fromZone: 'deck' });
            break;
        }
        case 'it-binds-all-things': {
            const healed = target(friend.ground.find(c => c.id === 'a02:p1:force'), 'healed Luke'), amount = Math.min(3, healed.d);
            if (amount > 0) add('heal', healed, seat, amount, 'ground', `HEALED ${amount}`);
            if (amount > 0 && hasForce()) add('damage', target(w, 'different Wampa'), foe, amount, 'ground', `ACTUAL HEAL → ${amount} DAMAGE`,
                { sourceCard: healed, damageType: 'ability', basis: { kind: 'healed', sourceIds: [healed.id!], value: amount } });
            break;
        }
        case 'the-emperors-legion': {
            const history = state.defeatedThisPhase;
            if (!history || history.round !== state.round || history.phase !== state.phase) break;
            for (const c of friend.discard) if (c.s && selectedUnits[c.s] && history.cards.some(h => h.id === c.id)) {
                add('recover', c, seat, 1, 'hand', 'DEFEATED THIS PHASE → HAND', { fromSeat: seat, fromZone: 'discard', ownerSeat: c.owner, defeatPhase: { round: history.round, phase: history.phase } });
            }
            break;
        }
        case 'rebel-assault': attack(target(m, 'first Rebel'), 1, 1); attack(target(x, 'different second Rebel'), 1, 2); break;
        case 'uwing-reinforcement': {
            const manifest = deck(), looked = manifest.slice(0, 10), selected = [0, 3, 7].map(i => requireId(looked[i], 'selected top-ten unit'));
            if (selected.some(c => !c.s || !selectedUnits[c.s]) || selected.reduce((total, c) => total + selectedUnits[c.s!].cost, 0) > 7) throw new Error('A02 U-Wing: select at most 3 actual units with printed cost sum at most 7');
            const chosenIds = selected.map(c => c.id!), unchosen = looked.filter(c => !chosenIds.includes(c.id!));
            operation({ scope: 'top', visibility: 'private', policy: 'top-search-bottom', looked, selectedIds: chosenIds,
                remainingOrder: [...selected, ...manifest.slice(looked.length), ...unchosen.toReversed()], selectionLimit: 3, printedCostLimit: 7,
                printedCosts: Object.fromEntries(selected.map(c => [c.id!, selectedUnits[c.s!].cost])) }, 'SEARCH 10 · 2 + 3 + 2 = 7');
            for (const c of selected) {
                const stats = selectedUnits[c.s!];
                add('play', c, seat, 1, stats.arena, 'FREE PLAY · EXHAUSTED', { fromSeat: seat, fromZone: 'deck', ownerSeat: c.owner, entersReady: false,
                    unit: unit(c, stats.p, stats.h, 0, { x: 1, ...(stats.sn ? { sn: stats.sn } : {}) }) });
            }
            break;
        }
        case 'heroic-sacrifice': {
            const drawn = requireId(deck()[0], 'actual draw');
            add('draw', drawn, seat, 1, 'hand', 'DRAW 1', { fromSeat: seat, fromZone: 'deck' });
            const attacker = target(m, 'Marine');
            const evidence = attack(attacker, 2, 1);
            if (attacker.p + 2 > 0) add('defeat', attacker, seat, 1, 'discard', 'COMBAT DAMAGE → SELF-DEFEAT', { ...evidence, fromSeat: seat, fromZone: 'ground', ownerSeat: attacker.owner, trigger: 'combat-damage' });
            break;
        }
        case 'karabast': {
            const source = target(m, 'damaged friendly unit'), amount = source.d + 1;
            add('damage', target(w, 'enemy unit'), foe, amount, 'ground', `${source.d} DAMAGE + 1 → ${amount}`, { sourceCard: source, damageType: 'ability',
                basis: { kind: 'source-damage-plus-one', sourceIds: [source.id!], value: source.d, increment: 1 } });
            break;
        }
        case 'for-a-cause-i-believe-in': {
            const manifest = deck(), looked = manifest.slice(0, 4);
            if (looked.length < 4) throw new Error('A02 Cause primary requires four staged revealed cards; short-deck branch is documented separately');
            const discarded = [looked[1], looked[2]], kept = [looked[3], looked[0]], heroism = looked.filter(c => c.s && heroPrints.has(c.s));
            operation({ scope: 'top', visibility: 'public', policy: 'reveal-top-choice', looked, selectedIds: discarded.map(c => c.id!),
                remainingOrder: [...kept, ...manifest.slice(4), ...discarded] }, 'REVEAL 4 · CHOOSE TOP / DISCARD');
            add('damage', enemy.base, foe, heroism.length, 'base', `${heroism.length} HEROISM → BASE DAMAGE`, { damageType: 'ability', basis: { kind: 'heroism-count', sourceIds: heroism.map(c => c.id!), value: heroism.length } });
            for (const c of discarded) add('discard', c, seat, 1, 'discard', 'CHOSEN REVEALED CARD → DISCARD', { fromSeat: seat, fromZone: 'deck', ownerSeat: c.owner, chooserSeat: seat, selection: 'chosen' });
            break;
        }
        case 'rallying-cry':
            for (const [zone, units] of [['ground', friend.ground], ['space', friend.space]] as const) for (const c of units) {
                add('keyword', c, seat, 2, zone, 'RAID 2 · THIS PHASE', { keyword: { name: 'Raid', amount: 2 }, duration: 'phase', selection: 'all' });
            }
            break;
        case 'force-throw': {
            const discarded = enemy.hand.find(c => c.id === 'a02:p2:takedown-hand');
            if (!discarded) break;
            if (discarded.s !== 'SOR_077') throw new Error('A02 Force Throw: staged discarded printed cost must be verified');
            add('discard', discarded, foe, 1, 'discard', 'P2 CHOOSES · DISCARD 1', { fromSeat: foe, fromZone: 'hand', ownerSeat: discarded.owner, chooserSeat: foe, selection: 'chosen' });
            if (hasForce()) add('damage', target(w, 'unit target'), foe, 4, 'ground', 'PRINTED COST 4 → DAMAGE', { sourceCard: discarded, damageType: 'ability',
                basis: { kind: 'printed-cost', sourceIds: [discarded.id!], value: 4 } });
            break;
        }
    }
    return outcomes;
}
