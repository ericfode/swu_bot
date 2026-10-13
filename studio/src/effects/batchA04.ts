import type { CardRef, Seat, Snapshot, UnitRef, UpgradeRef } from '../data/types';
import type { AbilityBeat } from './abilities';
import type { PreviewAspect, PreviewCardCost } from './previewCosts';
import type { CardEffectDefinition, CardEffectOutcome } from './types';

/** Installed JSON and engine sources checked in docs/card-animation-a04-spec.md; receipts are staged, not replay truth. */
export const A04_DEFINITIONS: CardEffectDefinition[] = [
    { id: 'i-am-your-father', name: 'I Am Your Father', setCode: 'SOR_233', family: 'tactics', color: '#d6b4eb', visual: 'i-am-your-father', durationMs: 5200, description: 'Deal 7 damage to an enemy unit unless its controller says no; if they do, draw 3 instead.' },
    { id: 'maximum-firepower', name: 'Maximum Firepower', setCode: 'SOR_234', family: 'damage', color: '#ffc287', visual: 'maximum-firepower', durationMs: 5800, description: 'Two different friendly Imperials deal their current power as sequential ability damage to the same unit.' },
    { id: 'galactic-ambition', name: 'Galactic Ambition', setCode: 'SOR_235', family: 'support', color: '#d0b3e9', visual: 'galactic-ambition', durationMs: 5400, description: 'Play a non-Heroism hand unit for free; if played, its printed cost damages your own base.' },
    { id: 'medal-ceremony', name: 'Medal Ceremony', setCode: 'SOR_245', family: 'support', color: '#f4da87', visual: 'medal-ceremony', durationMs: 4800, description: 'One Experience each for up to three distinct Rebels that actually attacked this phase.' },
    { id: 'youre-my-only-hope', name: "You're My Only Hope", setCode: 'SOR_246', family: 'support', color: '#9bdce9', visual: 'youre-my-only-hope', durationMs: 5600, description: 'Privately look at deck top; optionally play for 5 less, or free at 5 or less remaining base HP.' },
    { id: 'calculated-lethality', name: 'Calculated Lethality', setCode: 'SHD_039', family: 'tactics', color: '#e5bba0', visual: 'calculated-lethality', durationMs: 6000, description: 'Defeat a non-leader costing at most 3; distribute Experience equal to its actual prior upgrade count.' },
    { id: 'mystic-reflection', name: 'Mystic Reflection', setCode: 'SHD_051', family: 'force', color: '#b8b7ef', visual: 'mystic-reflection', durationMs: 4400, description: 'Give an enemy unit −2/−0 this phase, or −2/−2 if a friendly Force unit is in play.' },
    { id: 'midnight-repairs', name: 'Midnight Repairs', setCode: 'SHD_054', family: 'support', color: '#86deba', visual: 'midnight-repairs', durationMs: 5400, description: 'Allocate up to 8 healing among units on either side and arena; only existing damage is removed.' },
    { id: 'covert-strength', name: 'Covert Strength', setCode: 'SHD_075', family: 'support', color: '#b8e6a7', visual: 'covert-strength', durationMs: 4200, description: 'Heal 2 existing damage and give an Experience to the same unit; normal hand example.' },
    { id: 'unexpected-escape', name: 'Unexpected Escape', setCode: 'SHD_076', family: 'support', color: '#a6d9e8', visual: 'unexpected-escape', durationMs: 5200, description: 'Exhaust any unit; optionally rescue one of its captured cards to the owner arena, without playing it.' }
];
export const A04_COSTS: Record<string, PreviewCardCost> = {
    'i-am-your-father': { printed: 3, aspects: ['villainy'] }, 'maximum-firepower': { printed: 4, aspects: ['villainy'] },
    'galactic-ambition': { printed: 7, aspects: ['villainy'] }, 'medal-ceremony': { printed: 0, aspects: ['heroism'] },
    'youre-my-only-hope': { printed: 3, aspects: ['heroism'] }, 'calculated-lethality': { printed: 4, aspects: ['vigilance', 'villainy'] },
    'mystic-reflection': { printed: 1, aspects: ['heroism', 'vigilance'] }, 'midnight-repairs': { printed: 2, aspects: ['vigilance', 'vigilance'] },
    'covert-strength': { printed: 1, aspects: ['vigilance'] }, 'unexpected-escape': { printed: 1, aspects: ['vigilance'] }
};
export const A04_ABILITIES: Record<string, AbilityBeat[]> = {
    'i-am-your-father': [
        { kind: 'damage', label: 'Choose an enemy unit; deal 7 unless its current controller says no', amount: 7, scope: 'enemy-unit', selection: 'chosen', condition: 'Any arena/deployed leader; select target before controller response; no legal target resolves neither branch' },
        { kind: 'draw', label: 'If that controller says no, you draw 3 instead', amount: 3, scope: 'own-hand', from: 'own-deck', condition: 'Explicit controller response, not owner; no damage branch alongside draw; equivalent clear indication allowed' }
    ],
    'maximum-firepower': [
        { kind: 'damage', label: 'A friendly Imperial deals its current power as ability damage to a unit', amount: 'current power', scope: 'target', from: 'friendly-unit', selection: 'chosen', condition: 'Either arena/target side; exhausted source legal; no attack, counterdamage or exhaustion payment' },
        { kind: 'damage', label: 'Then a different friendly Imperial deals its current power to that same unit', amount: 'current power', scope: 'target', from: 'friendly-unit', selection: 'chosen', condition: 'Distinct source; same target incarnation must still be in play; first lethal hit cannot target a replacement' }
    ],
    'galactic-ambition': [
        { kind: 'play', label: 'Play a non-Heroism unit from your hand for free', scope: 'friendly-arena', from: 'own-hand', selection: 'chosen', condition: 'Reject every Heroism symbol; resource/aspect costs ignored, other additional costs/restrictions and ordinary entry abilities remain' },
        { kind: 'damage', label: 'If successfully played, deal its printed cost to your own base', amount: 'played printed cost', scope: 'friendly-base', condition: 'Actual prior play required; no damage for failed play; printed cost ignores modifiers; zero cost deals zero' }
    ],
    'medal-ceremony': [{ kind: 'buff', label: 'Give one Experience to each of up to 3 distinct Rebel units that attacked this phase', amount: '+1/+1', scope: 'target', duration: 'token', selection: 'chosen', optional: true, condition: 'Either controller/arena and deployed leaders; actual current-phase attack history and same surviving incarnation; pose alone insufficient; zero/fewer targets legal' }],
    'youre-my-only-hope': [
        { kind: 'inspect', label: 'Privately look at deck top; may leave it or legally play it', scope: 'own-deck', amount: 1, optional: true, selection: 'chosen', condition: 'Private look, no reveal/draw/reorder; empty deck supplies no card; any legal card type/mode including Piloting requires its actual resolution' },
        { kind: 'cost', label: 'Selected top card costs 5 resources less', scope: 'resources', amount: -5, condition: 'Penalties included before flooring at zero; restrictions and additional costs still apply' },
        { kind: 'play', label: 'At 5 or less remaining base HP, may play it free instead', scope: 'friendly-arena', from: 'own-deck', optional: true, condition: 'Exactly 5 qualifies; source event still paid; free resource/aspect costs only; otherwise use discounted route' }
    ],
    'calculated-lethality': [
        { kind: 'defeat', label: 'Defeat any non-leader unit with printed cost at most 3', scope: 'target', selection: 'chosen', condition: 'Either controller/arena; attachments do not increase printed cost; direct defeat may be prevented' },
        { kind: 'buff', label: 'Distribute one Experience per actual prior upgrade among friendly units', amount: 'upgrade count', scope: 'friendly-arena', duration: 'token', selection: 'chosen', condition: 'Counts ordinary upgrades and tokens; repeated recipients allowed; departed last-known or surviving protected host upgrades; prevention does not cancel distribution; zero upgrades gives zero' }
    ],
    'mystic-reflection': [{ kind: 'debuff', label: 'Enemy unit gets −2/−0 this phase, or −2/−2 with a friendly Force unit', amount: '−2/−0 or −2/−2', scope: 'enemy-unit', duration: 'phase', selection: 'chosen', condition: 'Actual in-play Force unit, not undeployed leader/Force upgrade; power floor zero; unchanged damage and pose; reduced HP may cause actual defeat' }],
    'midnight-repairs': [{ kind: 'heal', label: 'Heal up to 8 total existing damage distributed among any number of units', amount: 'up to 8', scope: 'target', selection: 'chosen', optional: true, condition: 'Either side/arena including deployed leaders; no bases; allocation not above existing damage or total budget; no HP increase' }],
    'covert-strength': [
        { kind: 'heal', label: 'Heal 2 existing damage from any unit', amount: 2, scope: 'target', selection: 'chosen', condition: 'Any controller/arena/deployed leader; simultaneous with Experience; heal clamps to 0/1/2 existing damage' },
        { kind: 'buff', label: 'Give that same unit one Experience simultaneously', amount: '+1/+1', scope: 'target', duration: 'token', condition: 'Still receives token when undamaged; not healed 3' },
        { kind: 'play', label: 'Separate Smuggle route: play this resource for 3 and one Vigilance, replacing it with deck top', scope: 'resources', optional: true, condition: 'Alternate resource-source route, exhausted top replacement if available; empty deck no replacement; not an extra payment during the hand primary' }
    ],
    'unexpected-escape': [
        { kind: 'exhaust', label: 'Exhaust any unit', scope: 'target', selection: 'chosen', condition: 'Either controller/arena; already exhausted or no captives legal' },
        { kind: 'rescue', label: 'May rescue one captured non-leader card guarded by that selected unit', scope: 'owner-arena', optional: true, selection: 'chosen', condition: 'Actual captor pocket/owner; returns to owner arena with new incarnation, normally exhausted; Rescued entry never When Played or unit payment; ready-entry effects require explicit evidence' }
    ]
};
const exampleLabels: Record<string, string> = {
    'i-am-your-father': 'P2 controls targeted Wampa and says NO; P1 draws three actual deck cards, no damage',
    'maximum-firepower': 'Two distinct Imperials stay stationary: exhausted Trooper hits Luke for 3, ready TIE for 2',
    'galactic-ambition': 'Pay event 9; play non-Heroism Wampa from hand free/exhausted, then printed cost 4 hits own base',
    'medal-ceremony': 'Three Rebel incarnations have actual current-phase attacks; give one permanent Experience each',
    'youre-my-only-hope': 'Private top Wampa; choose discounted deck play, 4 + 2 missing Aggression − 5 = 1; enter exhausted',
    'calculated-lethality': 'Defeat printed-cost-3 Trooper with three upgrades; distribute three XP, two Marine and one X-Wing',
    'mystic-reflection': 'Friendly Force unit Luke qualifies: Wampa gets −2/−2 this phase, existing damage remains 1',
    'midnight-repairs': 'Allocate 8 healing across both sides: Marine 2, Defender 2, X-Wing 1, Wampa 3',
    'covert-strength': 'Normal hand play: same Marine heals 2 and gains one Experience simultaneously',
    'unexpected-escape': 'Exhaust Veteran; choose its captured Marine, rescue to owner P1 ground exhausted with new incarnation'
};
export const A04_EXAMPLES: Record<string, { label: string; beats: AbilityBeat[] }> = Object.fromEntries(Object.entries(exampleLabels).map(([id, label]) => [id, {
    label, beats: id === 'i-am-your-father' ? [A04_ABILITIES[id][1]]
        : id === 'youre-my-only-hope' ? [A04_ABILITIES[id][0], A04_ABILITIES[id][1],
            { ...A04_ABILITIES[id][2], label: 'Play the selected Wampa directly from deck for its discounted cost', condition: 'Base HP 21; discounted route selected, normal exhausted entry' },
            { kind: 'pay', label: 'Pay actual discounted Wampa cost', amount: 1, scope: 'resources' }]
        : id === 'covert-strength' ? A04_ABILITIES[id].slice(0, 2) : A04_ABILITIES[id]
}]));
const supported = new Set(A04_DEFINITIONS.map(d => d.id));
const card = (id: string, n: string, s: string | null, owner: Seat): CardRef => ({ id, n, s, owner });
const unit = (c: CardRef, p: number, h: number, d = 0, extra: Partial<UnitRef> = {}): UnitRef => ({ ...c, p, h, d, incarnation: `${c.id}:entry-1`, ...extra });
const token = (id: string, n: 'Experience' | 'Shield', owner: Seat): UpgradeRef => ({ ...card(id, n, null, owner), t: 1, p: n === 'Experience' ? 1 : 0, h: n === 'Experience' ? 1 : 0 });
const unknownDeck = (seat: Seat, amount: number) => Array.from({ length: amount }, (_, i) => card(`a04:${seat}:deck:${i}`, 'Unknown card', null, seat));
const facts: Record<string, { p: number; h: number; cost: number; arena: 'ground' | 'space'; aspects: PreviewAspect[]; rebel?: true; imperial?: true; force?: true; protected?: true }> = {
    SOR_095: { p: 3, h: 3, cost: 2, arena: 'ground', aspects: ['command', 'heroism'], rebel: true },
    SOR_098: { p: 4, h: 3, cost: 3, arena: 'ground', aspects: ['command', 'heroism'], rebel: true },
    SOR_237: { p: 2, h: 3, cost: 2, arena: 'space', aspects: ['heroism'], rebel: true },
    SOR_033: { p: 3, h: 3, cost: 3, arena: 'ground', aspects: ['vigilance', 'villainy'], imperial: true },
    SOR_225: { p: 2, h: 1, cost: 1, arena: 'space', aspects: ['villainy'], imperial: true },
    SOR_164: { p: 4, h: 5, cost: 4, arena: 'ground', aspects: ['aggression'] },
    SOR_051: { p: 6, h: 7, cost: 7, arena: 'ground', aspects: ['vigilance', 'heroism'], force: true, rebel: true },
    SOR_241: { p: 2, h: 1, cost: 3, arena: 'space', aspects: ['heroism'], rebel: true },
    SHD_120: { p: 3, h: 4, cost: 5, arena: 'ground', aspects: ['command'] },
    SHD_187: { p: 2, h: 2, cost: 3, arena: 'space', aspects: ['cunning', 'villainy'], imperial: true, protected: true }
};
function fail(message: string): never { throw new Error(`A04: ${message}`); }
const knownUnit = (c: UnitRef | undefined, role: string): UnitRef => { if (!c?.id || !c.incarnation || !c.s || !facts[c.s]) fail(`missing verified ${role}`); return c!; };
export interface A04Choices { fatherResponse?: 'no' | 'damage'; hopeDecision?: 'leave' | 'play-discount' | 'play-free'; preventDefeat?: boolean; rescue?: boolean; allocation?: Record<string, number> }

export function a04ShowcaseState(definition: CardEffectDefinition): Snapshot | undefined {
    if (!supported.has(definition.id)) return undefined;
    const state: Snapshot = { round: 9, phase: 'action', initiative: 'p1', players: {
        p1: { name: 'Rebel Alliance', base: { ...card('a04:p1:base', 'Echo Base', 'SOR_024', 'p1'), hp: 30, d: 9 }, leader: { ...card('a04:p1:leader', 'Luke Skywalker: Faithful Friend', 'SOR_005', 'p1'), dep: 0, x: 0 },
            res: { ready: 10, total: 10 }, hand: [card(`a04:${definition.id}:event`, definition.name, definition.setCode, 'p1')], deck: 27, knownDeck: unknownDeck('p1', 27), discard: [],
            ground: [unit(card('a04:p1:marine', 'Battlefield Marine', 'SOR_095', 'p1'), 3, 3, 1), unit(card('a04:p1:defender', 'Echo Base Defender', 'SOR_098', 'p1'), 4, 3, 0, { sn: 1 })], space: [unit(card('a04:p1:xwing', 'Alliance X-Wing', 'SOR_237', 'p1'), 2, 3)] },
        p2: { name: 'Galactic Empire', base: { ...card('a04:p2:base', 'Capital City', 'SOR_020', 'p2'), hp: 30, d: 6 }, leader: { ...card('a04:p2:leader', 'Darth Vader: Dark Lord of the Sith', 'SOR_010', 'p2'), dep: 0, x: 1 },
            res: { ready: 7, total: 10 }, hand: [card('a04:p2:hand:takedown', 'Takedown', 'SOR_077', 'p2')], deck: 29, knownDeck: unknownDeck('p2', 29), discard: [],
            ground: [unit(card('a04:p2:trooper', 'Death Trooper', 'SOR_033', 'p2'), 3, 3), unit(card('a04:p2:wampa', 'Wampa', 'SOR_164', 'p2'), 4, 5, 1)], space: [unit(card('a04:p2:tie', 'TIE/ln Fighter', 'SOR_225', 'p2'), 2, 1)] }
    } };
    const p1 = state.players.p1, p2 = state.players.p2;
    switch (definition.id) {
        case 'i-am-your-father': p1.knownDeck!.splice(0, 3, ...[['Battlefield Marine', 'SOR_095'], ['Repair', 'SOR_074'], ['Open Fire', 'SOR_172']].map(([n, s], i) => card(`a04:father:draw:${i}`, n, s, 'p1'))); break;
        case 'maximum-firepower':
            p1.ground[0] = unit(card('a04:maximum:trooper', 'Death Trooper', 'SOR_033', 'p1'), 3, 3, 0, { x: 1 });
            p1.space[0] = unit(card('a04:maximum:tie', 'TIE/ln Fighter', 'SOR_225', 'p1'), 2, 1);
            p2.ground[1] = unit(card('a04:maximum:target', 'Luke Skywalker: Jedi Knight', 'SOR_051', 'p2'), 6, 7); break;
        case 'galactic-ambition': p1.hand.push(card('a04:ambition:unit', 'Wampa', 'SOR_164', 'p1')); break;
        case 'medal-ceremony':
            p2.base.d = 12;
            state.attacksThisPhase = { round: 9, phase: 'action', attacks: [...p1.ground, ...p1.space].map((c, i) => ({ id: `a04:medal:attack:${i}`, attackerId: c.id!, incarnation: c.incarnation! })) };
            for (const c of [...p1.ground, ...p1.space]) c.x = 1;
            break;
        case 'youre-my-only-hope': p1.knownDeck![0] = card('a04:hope:top', 'Wampa', 'SOR_164', 'p1'); break;
        case 'calculated-lethality':
            p2.ground[0].u = [{ ...card('a04:lethality:academy', 'Academy Training', 'SOR_120', 'p2'), t: 0, p: 2, h: 2 }, token('a04:lethality:old-xp', 'Experience', 'p2'), token('a04:lethality:shield', 'Shield', 'p2')];
            p2.ground[0].p = 6; p2.ground[0].h = 6; break;
        case 'mystic-reflection': p1.ground[1] = unit(card('a04:mystic:force', 'Luke Skywalker: Jedi Knight', 'SOR_051', 'p1'), 6, 7); break;
        case 'midnight-repairs': p1.ground[0].d = 2; p1.ground[1].d = 2; p1.space[0].d = 2; p2.ground[1].d = 3; p2.ground[0].d = 1; break;
        case 'covert-strength': p1.ground[0].d = 2; break;
        case 'unexpected-escape':
            p1.ground.shift(); p2.ground[0] = unit(card('a04:escape:captor', 'Discerning Veteran', 'SHD_120', 'p2'), 3, 4, 0, { cap: [card('a04:escape:marine', 'Battlefield Marine', 'SOR_095', 'p1')] }); break;
    }
    return state;
}

export function a04PreviewOutcomes(definition: CardEffectDefinition, state: Snapshot, seat: Seat, choices: A04Choices = {}): CardEffectOutcome[] | undefined {
    if (!supported.has(definition.id)) return undefined;
    const foe: Seat = seat === 'p1' ? 'p2' : 'p1', friend = state.players[seat];
    const source = friend.hand.find(c => c.s === definition.setCode); if (!source?.id) fail('source event missing');
    const all = (side: Seat) => [...state.players[side].ground, ...state.players[side].space];
    const byId = (side: Seat, id: string) => all(side).find(c => c.id === id);
    const arena = (side: Seat, c: UnitRef): 'ground' | 'space' => state.players[side].space.includes(c) ? 'space' : 'ground';
    const m = byId(seat, 'a04:p1:marine'), x = byId(seat, 'a04:p1:xwing'), w = byId(foe, 'a04:p2:wampa');
    const outcomes: CardEffectOutcome[] = [];
    const add = (kind: CardEffectOutcome['kind'], c: CardRef | null | undefined, side: Seat, amount: number | string | undefined, zone: NonNullable<CardEffectOutcome['zone']>, label: string, extra: Partial<CardEffectOutcome> = {}) => outcomes.push({ kind, card: c, seat: side, amount, zone, label, ...extra });
    const deck = () => { if (!friend.knownDeck || friend.knownDeck.length !== friend.deck) fail('complete staged deck required'); return friend.knownDeck!; };
    let xpIndex = 0;
    const xp = (target: UnitRef, side: Seat, amount: number, extra: Partial<CardEffectOutcome> = {}) => {
        const tokens = Array.from({ length: amount }, () => token(`a04:${definition.id}:xp:${xpIndex++}`, 'Experience', side));
        add('buff', target, side, `+${amount}/+${amount}`, arena(side, target), `${amount} EXPERIENCE`, { duration: 'token', cards: tokens, ...extra });
    };
    const play = (c: CardRef, fromZone: 'hand' | 'deck', label: string) => {
        const info = c.s && facts[c.s]; if (!c.id || !info) fail('primary unit play requires verified unit face');
        add('play', c, seat, 1, info!.arena, label, { fromSeat: seat, fromZone, ownerSeat: c.owner, entersReady: false, entryType: 'played', printedCost: info!.cost, unit: unit(c, info!.p, info!.h, 0, { x: 1, incarnation: `${c.id}:entry-1` }) });
    };
    switch (definition.id) {
        case 'i-am-your-father': {
            if (!w) break;
            const target = knownUnit(w, 'enemy choice target'), decision = choices.fatherResponse ?? 'no';
            const choice = { kind: 'controller-response' as const, decision, subject: target, controller: foe };
            if (decision === 'no') {
                const drawn = deck().slice(0, 3); if (drawn.length !== 3) fail('Father primary needs three actual cards; failed draws require explicit separate outcomes');
                add('draw', null, seat, 3, 'hand', 'P2 SAYS NO · P1 DRAWS 3', { cards: drawn, sourceCard: target, fromSeat: seat, fromZone: 'deck', chooserSeat: foe, selection: 'opponent', choice });
            } else {
                add('damage', target, foe, 7, arena(foe, target), 'CONTROLLER ALLOWS 7 DAMAGE', { chooserSeat: foe, choice, damageType: 'ability' });
                if (target.d + 7 >= target.h) add('defeat', target, foe, 1, 'discard', 'LETHAL ABILITY DAMAGE', { ownerSeat: target.owner, fromSeat: foe, fromZone: arena(foe, target) });
            }
            break;
        }
        case 'maximum-firepower': {
            const first = byId(seat, 'a04:maximum:trooper'), second = byId(seat, 'a04:maximum:tie'), target = byId(foe, 'a04:maximum:target');
            if (!first) break;
            const recipient = knownUnit(target, 'same damage target'); let damage = recipient.d;
            for (const [i, c] of [first, second].entries()) {
                if (!c) continue; knownUnit(c, 'Imperial source'); if (!facts[c.s!].imperial) fail('damage source must be an actual Imperial');
                if (i && c.id === first.id) fail('second Imperial must be distinct');
                add('damage', recipient, foe, c.p, arena(foe, recipient), `IMPERIAL ${i + 1} · ${c.p} ABILITY DAMAGE`, { sourceCard: c, damageType: 'ability', sequenceId: 'a04:maximum:sequence', sequenceIndex: i + 1, targetIncarnation: recipient.incarnation, basis: { kind: 'source-power', sourceIds: [c.id!], value: c.p } });
                damage += c.p;
                if (damage >= recipient.h) { add('defeat', recipient, foe, 1, 'discard', 'LETHAL ABILITY DAMAGE', { ownerSeat: recipient.owner }); break; }
            }
            break;
        }
        case 'galactic-ambition': {
            const chosen = friend.hand.find(c => c.id === 'a04:ambition:unit'); if (!chosen) break;
            if (!chosen.s || !facts[chosen.s] || facts[chosen.s].aspects.includes('heroism')) fail('free hand play must be an actual non-Heroism unit');
            play(chosen, 'hand', 'FREE PLAY · EXHAUSTED');
            add('damage', friend.base, seat, facts[chosen.s].cost, 'base', `PRINTED COST ${facts[chosen.s].cost} → OWN BASE`, { sourceCard: chosen, damageType: 'ability', basis: { kind: 'played-printed-cost', sourceIds: [chosen.id!], value: facts[chosen.s].cost } });
            break;
        }
        case 'medal-ceremony': {
            const history = state.attacksThisPhase;
            if (!history || history.round !== state.round || history.phase !== state.phase) break;
            let selected = 0;
            for (const side of [seat, foe]) for (const c of all(side)) if (c.s && facts[c.s]?.rebel && history.attacks.some(a => a.attackerId === c.id && a.incarnation === c.incarnation) && selected < 3) {
                xp(c, side, 1, { attackPhase: { round: state.round, phase: state.phase, incarnation: c.incarnation! } }); selected++;
            }
            break;
        }
        case 'youre-my-only-hope': {
            const top = deck()[0]; if (!top) break;
            const remaining = friend.base.hp - friend.base.d, decision = choices.hopeDecision ?? (remaining <= 5 ? 'play-free' : 'play-discount');
            add('inspect', top, seat, 1, 'deck', 'PRIVATE TOP LOOK', { cards: [top], fromSeat: seat, fromZone: 'deck', chooserSeat: seat, choice: { kind: 'private-top', decision, discount: 5, freeAtRemainingHp: 5 } });
            if (decision === 'leave') break;
            if (decision === 'play-free' && remaining > 5 || decision === 'play-discount' && remaining <= 5) fail('selected Hope play route contradicts actual base HP threshold');
            if (top.s !== 'SOR_164') fail('primary Hope supports Wampa; other card types/modes require authored explicit targets and resolutions');
            const provided: PreviewAspect[] = friend.base.s === 'SOR_024' ? ['command'] : friend.base.s === 'SOR_020' ? ['vigilance'] : fail('unverified base aspect provider');
            if (friend.leader?.s === 'SOR_005') provided.push('vigilance', 'heroism'); else if (friend.leader?.s === 'SOR_010') provided.push('aggression', 'villainy');
            const cost = decision === 'play-free' ? 0 : Math.max(0, facts[top.s].cost + (provided.includes('aggression') ? 0 : 2) - 5);
            add('cost', top, seat, decision === 'play-free' ? 0 : -5, 'resources', decision === 'play-free' ? 'BASE HP ≤ 5 · FREE UNIT' : 'UNIT 4 + 2 − 5 = 1', { sourceCard: top, printedCost: 4 });
            add('pay', top, seat, cost, 'resources', `UNIT PAYMENT ${cost}`, { sourceCard: top, printedCost: 4 });
            play(top, 'deck', decision === 'play-free' ? 'FREE DECK PLAY · EXHAUSTED' : `DECK PLAY · PAID ${cost} · EXHAUSTED`);
            break;
        }
        case 'calculated-lethality': {
            const target = knownUnit(byId(foe, 'a04:p2:trooper'), 'defeat target');
            if (facts[target.s!].cost > 3) fail('defeat target printed cost exceeds three');
            if (choices.preventDefeat && !facts[target.s!].protected) fail('prevented branch needs actual ability protection');
            add('defeat', target, foe, 1, 'discard', choices.preventDefeat ? 'DEFEAT PREVENTED · HOST STAYS' : 'DIRECT DEFEAT · PRINTED COST 3', { ownerSeat: target.owner, printedCost: facts[target.s!].cost, prevented: choices.preventDefeat === true });
            const upgrades = target.u ?? [], basis = { sourceId: target.id!, incarnation: target.incarnation!, upgradeIds: upgrades.map(u => u.id!), count: upgrades.length, resolution: choices.preventDefeat ? 'prevented' as const : 'defeated' as const, distributionId: 'a04:lethality:distribution' };
            const firstRecipient = m ?? x ?? all(seat)[0], secondRecipient = m && x ? x : undefined;
            if (upgrades.length && firstRecipient) {
                xp(firstRecipient, seat, secondRecipient ? Math.max(1, upgrades.length - 1) : upgrades.length, { upgradeCountBasis: basis });
                if (secondRecipient && upgrades.length > 1) xp(secondRecipient, seat, 1, { upgradeCountBasis: basis });
            }
            break;
        }
        case 'mystic-reflection': {
            const target = knownUnit(w, 'enemy unit'), force = all(seat).some(c => c.s && facts[c.s]?.force);
            add('debuff', target, foe, force ? '−2/−2' : '−2/−0', arena(foe, target), force ? 'FORCE UNIT · −2/−2 PHASE' : '−2/−0 PHASE', { duration: 'phase', sourceCard: force ? all(seat).find(c => c.s && facts[c.s]?.force) : undefined });
            if (target.d >= Math.max(0, target.h - (force ? 2 : 0))) add('defeat', target, foe, 1, 'discard', 'LETHAL REDUCED HP · NO NEW DAMAGE', { ownerSeat: target.owner });
            break;
        }
        case 'midnight-repairs': {
            const allocation = choices.allocation ?? { 'a04:p1:marine': 2, 'a04:p1:defender': 2, 'a04:p1:xwing': 1, 'a04:p2:wampa': 3 };
            if (Object.values(allocation).some(n => !Number.isSafeInteger(n) || n < 0) || Object.values(allocation).reduce((sum, n) => sum + n, 0) > 8) fail('healing allocation exceeds eight or has invalid amounts');
            for (const [id, amount] of Object.entries(allocation)) {
                const side = all(seat).some(c => c.id === id) ? seat : foe, c = all(side).find(c => c.id === id);
                if (!c || amount > c.d) fail('healing requires an actual unit and at most its existing damage');
                if (amount) add('heal', c, side, amount, arena(side, c), `HEAL ${amount} · BUDGET 8`, { allocation: { id: 'a04:midnight:allocation', limit: 8 } });
            }
            break;
        }
        case 'covert-strength': {
            const target = knownUnit(m, 'same heal and XP recipient'), amount = Math.min(2, target.d);
            add('heal', target, seat, amount, arena(seat, target), `HEAL ${amount} · SAME HOST`); xp(target, seat, 1); break;
        }
        case 'unexpected-escape': {
            const captor = knownUnit(byId(foe, 'a04:escape:captor'), 'selected captor');
            add('exhaust', captor, foe, 1, arena(foe, captor), 'EXHAUST CAPTOR · HOST STAYS');
            if (choices.rescue === false || !captor.cap?.length) break;
            const captive = captor.cap[0], owner = captive.owner, info = captive.s && facts[captive.s];
            if (!captive.id || !owner || !info) fail('rescue needs actual captive owner and verified entering unit');
            add('rescue', captive, owner!, 1, info!.arena, `RESCUE · OWNER ${owner!.toUpperCase()} · EXHAUSTED`, { sourceCard: captor, fromSeat: foe, fromZone: arena(foe, captor), ownerSeat: owner, chooserSeat: seat, entryType: 'rescued', entersReady: false,
                unit: unit(captive, info!.p, info!.h, 0, { x: 1, incarnation: `${captive.id}:entry-2` }) }); break;
        }
    }
    return outcomes;
}
