import { A16_ABILITIES, A16_EXAMPLES } from './batchA16';
import { A15_ABILITIES, A15_EXAMPLES } from './batchA15';
import { A14_ABILITIES, A14_EXAMPLES } from './batchA14';
import { A13_ABILITIES, A13_EXAMPLES } from './batchA13';
import { A12_ABILITIES, A12_EXAMPLES } from './batchA12';
import { A11_ABILITIES, A11_EXAMPLES } from './batchA11';
import { A10_ABILITIES, A10_EXAMPLES } from './batchA10';
import { A09_ABILITIES, A09_EXAMPLES } from './batchA09';
import { A08_ABILITIES, A08_EXAMPLES } from './batchA08';
import { A07_ABILITIES, A07_EXAMPLES } from './batchA07';
import { A06_ABILITIES, A06_EXAMPLES } from './batchA06';
import { A01_ABILITIES, A01_EXAMPLES } from './batchA01';
import { A02_ABILITIES, A02_EXAMPLES } from './batchA02';
import { A03_ABILITIES, A03_EXAMPLES } from './batchA03';
import { A04_ABILITIES, A04_EXAMPLES } from './batchA04';
import { A05_ABILITIES, A05_EXAMPLES } from './batchA05';

/** Rules vocabulary shared by the renderer, showcase and replay evidence. Colors never carry meaning alone. */
export type AbilityKind = 'damage' | 'defeat' | 'heal' | 'shield' | 'buff' | 'debuff' | 'draw' | 'discard' | 'mill'
    | 'return' | 'recover' | 'resource' | 'ready' | 'exhaust' | 'suppress' | 'attack' | 'cost' | 'pay' | 'inspect'
    | 'play' | 'control' | 'search' | 'delay' | 'keyword' | 'restrict' | 'rescue' | 'attach' | 'capture' | 'create';

export type AbilityScope = 'target' | 'friendly-unit' | 'enemy-unit' | 'friendly-base' | 'all-units' | 'arena'
    | 'own-hand' | 'enemy-hand' | 'own-deck' | 'enemy-deck' | 'resources' | 'discard'
    | 'target-controller-hand' | 'owner-hand' | 'owner-deck' | 'chosen-player-hand' | 'friendly-arena' | 'enemy-base' | 'owner-arena';

export interface AbilityDefinition {
    id: AbilityKind;
    label: string;
    color: string;
    glyph: string;
    visualRule: string;
}

export interface AbilityBeat {
    kind: AbilityKind;
    label: string;
    amount?: number | string;
    scope: AbilityScope;
    condition?: string;
    /** Stable identifier of one selectable mode, not a claim that the mode was selected. */
    mode?: string;
    from?: AbilityScope;
    duration?: 'phase' | 'attack' | 'token' | 'regroup' | 'round' | 'permanent' | 'next-action';
    selection?: 'chosen' | 'random' | 'opponent' | 'all';
    optional?: boolean;
    payer?: 'event-controller' | 'opponent';
}

export interface CardAbilityRules { choose?: 2; order: 'listed' | 'any' }

export const ABILITY_LANGUAGE: AbilityDefinition[] = [
    {id:'create',label:'Create token unit',color:'#a7ceba',glyph:'▣',visualRule:'A new token unit assembles at its measured arena slot with explicit stable identity, owner, stats and actual entry pose. Creation has no prior hand/deck route or resource payment and is not a played entry or When Played trigger.'},
    { id: 'damage', label: 'Damage', color: '#ff815f', glyph: '−HP', visualRule: 'A directed strike lands on its actual recipient; a red damage number rises and damage markers increase. Damage never implies defeat.' },
    { id: 'defeat', label: 'Defeat', color: '#ff627e', glyph: '×', visualRule: 'The recipient leaves its arena for the supported destination: ordinary cards to owner discard, tokens cease, deployed leaders to an explicit exhausted leader summary. Never invent damage or a leader discard route.' },
    { id: 'heal', label: 'Heal', color: '#68efaf', glyph: '+HP', visualRule: 'Mending lines converge on the damaged unit or base; a green heal number removes damage. Healing never increases maximum HP.' },
    { id: 'shield', label: 'Shield', color: '#77d5ff', glyph: '⬡', visualRule: 'One closed blue hexagonal shell settles into a persistent Shield token on the recipient.' },
    { id: 'buff', label: 'Strengthen', color: '#f7ce65', glyph: '↑', visualRule: 'Only the declared power or HP changes. Experience lands as counted tokens; phase bonuses carry a phase marker and attack bonuses expire before the held ending.' },
    { id: 'debuff', label: 'Weaken', color: '#cda0ff', glyph: '↓', visualRule: 'Power and maximum HP contract together with explicit negative stat values and a phase marker; do not portray this as damage.' },
    { id: 'draw', label: 'Draw', color: '#95ddf5', glyph: '↗', visualRule: 'A counted card moves from that player’s deck to their hand. Preserve the replay’s visibility of its face.' },
    { id: 'discard', label: 'Discard', color: '#e8aa83', glyph: '↘', visualRule: 'A selected card exits its explicit hand, revealed-deck or captured-pocket origin into its owner’s discard pile; show who chooses and preserve random versus chosen selection.' },
    { id: 'mill', label: 'Mill', color: '#b99ae8', glyph: '⇣', visualRule: 'Count cards directly from the top of the opponent’s deck into discard. They never pass through a hand.' },
    { id: 'return', label: 'Return', color: '#f1d889', glyph: '↶', visualRule: 'An intact card leaves its explicit arena, attachment or hand for its owner’s stated hand or deck-bottom destination. A chosen hand-to-bottom sequence preserves actual order; tokens cease outside play. No fracture or fabricated discard route.' },
    { id: 'recover', label: 'Recover', color: '#b8e9b6', glyph: '↥', visualRule: 'Cards move out of discard to the stated hand or bottom of deck. Restock uses a bottom insertion and random-order marker.' },
    { id: 'resource', label: 'Resource', color: '#91e39a', glyph: '◆', visualRule: 'The exact card leaves its supported hand/discard/deck origin for a resource slot with explicit identity, readiness and visibility. Aggregate-only gains show counts without inventing a card, event route or exhaustion.' },
    { id: 'ready', label: 'Ready', color: '#ffc267', glyph: '⤴', visualRule: 'The actual exhausted unit or declared resource cards become ready. Unit stats/damage stay unchanged; resource identities and total stay unchanged, with exact ready-count changes.' },
    { id: 'exhaust', label: 'Exhaust', color: '#cba0ff', glyph: '⤵', visualRule: 'The selected existing unit rotates sideways and its action indicator dims; it stays in its arena.' },
    { id: 'suppress', label: 'Suppress abilities', color: '#b59aff', glyph: '⊘', visualRule: 'Ability marks are struck through inside a violet restraint until the phase ends; keep unit stats intact unless a separate damage beat follows.' },
    { id: 'attack', label: 'Attack', color: '#f8c080', glyph: '➜', visualRule: 'The chosen attacker lunges toward a legal target and exhausts; use separately observed damage or defeat receipts for the result.' },
    { id: 'cost', label: 'Cost reduction', color: '#a4cce1', glyph: '−◆', visualRule: 'Show an exact immediate discount before its verified payment. A named-card phase discard-play permission remains visible and does not itself play or pay. A discount is not a gained resource.' },
    { id: 'pay', label: 'Pay resources', color: '#d6d292', glyph: '◆→', visualRule: 'The exact number of ready resources rotates exhausted and channels into the next effect. Zero payment produces no damage beat.' },
    { id: 'inspect', label: 'Inspect', color: '#ffd391', glyph: '◉', visualRule: 'Inspect the declared hand or deck top with its actual visibility; a private deck look never publicly reveals or moves a card until a separate play receipt.' },
    { id: 'play', label: 'Play card', color: '#83dfbd', glyph: '↟', visualRule: 'An intact card leaves its explicit hand/deck/discard/resource origin for its supported arena or upgrade host; preserve its owner and actual playing controller. Entry pose and known paid/free cost remain explicit; unknowns do not become zero, and this is not draw or rescue.' },
    { id: 'control', label: 'Change controller', color: '#dcacef', glyph: '⇄', visualRule: 'The same intact unit crosses to its new controller’s side of the same arena. Ownership, damage and exhaustion remain distinct; permanent paired exchanges create no regroup return.' },
    { id: 'search', label: 'Search / reveal deck', color: '#91d9e6', glyph: '⌕', visualRule: 'A counted shelf preserves private versus public visibility. Explicit policy distinguishes whole-deck shuffle, unchosen random bottom, and chosen top order. Separate draw/play/discard receipts move the selected cards.' },
    { id: 'delay', label: 'Delayed consequence', color: '#efc88c', glyph: '◷', visualRule: 'A clock names the explicit phase-end or regroup consequence for its unit or player. It stays pending on the ordinary ending; a separately selected witnessed boundary resolves it without advancing from animation time.' },
    { id: 'keyword', label: 'Keyword change', color: '#eaca86', glyph: '⚑', visualRule: 'A pennant names the actual gain or loss and its duration. A source-bound loss can prevent that keyword on continuing entries; explicit phase expiry restores supplied ending truth. Raid changes no resting power; attack-only Saboteur/Grit expire. Restore/Ambush require actual attack/entry evidence.' },
    { id: 'restrict', label: 'Action restriction', color: '#cea2dc', glyph: '⊘⤴', visualRule: 'Show the explicit round readiness lock or next-controller-action attack obligation on its actual unit. A separate witnessed boundary consumes or expires an obligation; animation time never executes an action or suppresses other abilities.' },
    { id: 'rescue', label: 'Leave captivity', color: '#a6d9e8', glyph: '↟', visualRule: 'A captured card leaves its actual present pocket or verified departed-captor pocket for the observed arena. Only explicit owner and fresh rescued-entry evidence authorize rich rescue semantics; no inferred hand route, unit payment or When Played trigger.' },
    { id: 'attach', label: 'Move attachment', color: '#d8bc8a', glyph: '⇄', visualRule: 'An explicit transfer moves the same upgrade between measured host rows. A Pilot detachment removes only its known attachment contribution and moves that same card to its current controller’s ground arena as a fresh exhausted unit. Owner stays separate; detachment is not play, rescue or When Played.' },
    { id: 'capture', label: 'Enter captivity', color: '#b4d9de', glyph: '⊏', visualRule: 'The exact arena card moves intact into a measured captor pocket. Preserve known ownership, strip arena state, and do not infer defeat, control transfer or prerequisite attack history.' }
];

/** Full legal clauses, including unchosen modal branches and conditional/optional effects. Never play these wholesale. */
const CARD_ABILITIES: Record<string, AbilityBeat[]> = {
    ...A01_ABILITIES,
    ...A02_ABILITIES,
    ...A03_ABILITIES,
    ...A04_ABILITIES,
    ...A05_ABILITIES,
    ...A06_ABILITIES,
    ...A07_ABILITIES,
    ...A08_ABILITIES,
    ...A09_ABILITIES, ...A10_ABILITIES, ...A11_ABILITIES, ...A12_ABILITIES, ...A13_ABILITIES, ...A14_ABILITIES, ...A15_ABILITIES, ...A16_ABILITIES,
    'open-fire': [
        { kind: 'damage', label: 'Deal 4 damage to a unit', amount: 4, scope: 'target', selection: 'chosen' }
    ],
    'force-lightning': [
        { kind: 'suppress', label: 'Chosen unit loses all abilities this phase', scope: 'target', duration: 'phase', selection: 'chosen' },
        { kind: 'pay', label: 'Pay any number of resources', amount: 'N', scope: 'resources', condition: 'You control a Force unit; occurs after suppression' },
        { kind: 'damage', label: 'Deal 2 damage per resource paid to the same unit', amount: '2 × N', scope: 'target', condition: 'You control a Force unit and pay N resources' }
    ],
    'force-choke': [
        { kind: 'cost', label: 'This event costs 1 resource less', amount: -1, scope: 'resources', condition: 'You control a Force unit' },
        { kind: 'damage', label: 'Deal 5 damage to a non-Vehicle unit', amount: 5, scope: 'target', condition: 'Target is not a Vehicle', selection: 'chosen' },
        { kind: 'draw', label: 'That unit’s controller draws a card', amount: 1, scope: 'target-controller-hand' }
    ],
    takedown: [
        { kind: 'defeat', label: 'Defeat a unit with 5 or less remaining HP', amount: 1, scope: 'target', condition: 'Remaining HP ≤ 5', selection: 'chosen' }
    ],
    vanquish: [
        { kind: 'defeat', label: 'Defeat a non-leader unit', amount: 1, scope: 'target', condition: 'Target is not a leader', selection: 'chosen' }
    ],
    'superlaser-blast': [
        { kind: 'defeat', label: 'Defeat every unit on both sides, in both arenas', amount: 'all', scope: 'all-units', selection: 'all' }
    ],
    'overwhelming-barrage': [
        { kind: 'buff', label: 'Give a friendly unit +2/+2 this phase', amount: '+2/+2', scope: 'friendly-unit', duration: 'phase', selection: 'chosen' },
        { kind: 'damage', label: 'That unit divides damage equal to its power among other units', amount: 'buffed unit’s power', scope: 'target', from: 'friendly-unit', condition: 'Any number of other units, including friendly units; never the source unit', selection: 'chosen' }
    ],
    'bombing-run': [
        { kind: 'damage', label: 'Deal 3 damage to every unit in the chosen arena', amount: 3, scope: 'arena', condition: 'Choose ground or space; includes both players’ units', selection: 'all' }
    ],
    'make-an-opening': [
        { kind: 'debuff', label: 'Give a unit −2/−2 this phase', amount: '−2/−2', scope: 'target', duration: 'phase', selection: 'chosen' },
        { kind: 'heal', label: 'Heal 2 damage from your base', amount: 2, scope: 'friendly-base' }
    ],
    repair: [
        { kind: 'heal', label: 'Heal 3 damage from a unit or base', amount: 3, scope: 'target', condition: 'Any unit or base', selection: 'chosen' }
    ],
    restock: [
        { kind: 'recover', label: 'Put up to 4 cards from one discard pile on the bottom of their owner’s deck in random order', amount: 'up to 4', scope: 'owner-deck', from: 'discard', condition: 'Choose cards from one discard pile; may be either player’s', selection: 'chosen' }
    ],
    resupply: [
        { kind: 'resource', label: 'Put this event into play as one exhausted resource', amount: 1, scope: 'resources' }
    ],
    command: [
        { mode: 'experience', kind: 'buff', label: 'Give 2 Experience tokens to a unit', amount: '+2/+2', scope: 'target', duration: 'token', selection: 'chosen' },
        { mode: 'strike', kind: 'damage', label: 'A friendly unit deals its power as damage to a non-unique enemy unit', amount: 'friendly unit’s power', scope: 'enemy-unit', from: 'friendly-unit', condition: 'Damage recipient is non-unique', selection: 'chosen' },
        { mode: 'resource', kind: 'resource', label: 'Put this event into play as one exhausted resource', amount: 1, scope: 'resources' },
        { mode: 'recover', kind: 'recover', label: 'Return a unit from your discard pile to your hand', amount: 1, scope: 'own-hand', from: 'discard', condition: 'A unit card in your own discard pile', selection: 'chosen' }
    ],
    vigilance: [
        { mode: 'mill', kind: 'mill', label: 'Discard 6 cards from the top of an opponent’s deck', amount: 6, scope: 'enemy-deck' },
        { mode: 'heal', kind: 'heal', label: 'Heal 5 damage from a base', amount: 5, scope: 'target', condition: 'Any base', selection: 'chosen' },
        { mode: 'defeat', kind: 'defeat', label: 'Defeat a unit with 3 or less remaining HP', amount: 1, scope: 'target', condition: 'Remaining HP ≤ 3', selection: 'chosen' },
        { mode: 'shield', kind: 'shield', label: 'Give a Shield token to a unit', amount: 1, scope: 'target', selection: 'chosen' }
    ],
    aggression: [
        { mode: 'draw', kind: 'draw', label: 'Draw a card', amount: 1, scope: 'own-hand', from: 'own-deck' },
        { mode: 'defeat-upgrades', kind: 'defeat', label: 'Defeat up to 2 upgrades', amount: 'up to 2', scope: 'target', condition: 'Upgrade cards, not their attached units', selection: 'chosen' },
        { mode: 'ready', kind: 'ready', label: 'Ready a unit with 3 or less power', amount: 1, scope: 'target', condition: 'Current power ≤ 3', selection: 'chosen' },
        { mode: 'damage', kind: 'damage', label: 'Deal 4 damage to a unit', amount: 4, scope: 'target', selection: 'chosen' }
    ],
    cunning: [
        { mode: 'return', kind: 'return', label: 'Return a non-leader unit with 4 or less power to its owner’s hand', amount: 1, scope: 'owner-hand', from: 'target', condition: 'Not a leader; current power ≤ 4', selection: 'chosen' },
        { mode: 'buff', kind: 'buff', label: 'Give a unit +4/+0 this phase', amount: '+4/+0', scope: 'target', duration: 'phase', selection: 'chosen' },
        { mode: 'exhaust', kind: 'exhaust', label: 'Exhaust up to 2 units', amount: 'up to 2', scope: 'target', selection: 'chosen' },
        { mode: 'discard', kind: 'discard', label: 'An opponent discards a random card from their hand', amount: 1, scope: 'enemy-hand', selection: 'random' }
    ],
    'power-of-the-dark-side': [
        { kind: 'defeat', label: 'An opponent chooses one of their units; defeat it', amount: 1, scope: 'enemy-unit', selection: 'opponent' }
    ],
    'the-force-is-with-me': [
        { kind: 'buff', label: 'Give the chosen friendly unit 2 Experience tokens', amount: '+2/+2', scope: 'friendly-unit', duration: 'token', selection: 'chosen' },
        { kind: 'shield', label: 'Also give that unit a Shield token', amount: 1, scope: 'friendly-unit', condition: 'You control a Force unit' },
        { kind: 'attack', label: 'You may attack with that same unit', amount: 1, scope: 'friendly-unit', optional: true, condition: 'Chosen unit is ready and has a legal attack' }
    ],
    waylay: [
        { kind: 'return', label: 'Return a non-leader unit to its owner’s hand', amount: 1, scope: 'owner-hand', from: 'target', condition: 'Target is not a leader', selection: 'chosen' }
    ],
    'spark-of-rebellion': [
        { kind: 'inspect', label: 'Look at an opponent’s hand', scope: 'enemy-hand' },
        { kind: 'discard', label: 'Choose one card from that hand to discard', amount: 1, scope: 'enemy-hand', selection: 'chosen' }
    ]
};

const MODAL = new Set(['command', 'vigilance', 'aggression', 'cunning']);
const copy = (beats: AbilityBeat[]) => beats.map((beat) => ({ ...beat }));
export function cardAbilities(id: string): AbilityBeat[] { return copy(CARD_ABILITIES[id] ?? []); }
export function cardAbilityRules(id: string): CardAbilityRules { return MODAL.has(id) ? { choose: 2, order: 'any' } : { order: 'listed' }; }

const mode = (id: string, name: string, patch: Partial<AbilityBeat> = {}): AbilityBeat => ({ ...CARD_ABILITIES[id].find((beat) => beat.mode === name)!, ...patch });
const EXAMPLES: Record<string, { label: string; beats: AbilityBeat[] }> = {
    ...A01_EXAMPLES,
    ...A02_EXAMPLES,
    ...A03_EXAMPLES,
    ...A04_EXAMPLES,
    ...A05_EXAMPLES,
    ...A06_EXAMPLES,
    ...A07_EXAMPLES,
    ...A08_EXAMPLES,
    ...A09_EXAMPLES, ...A10_EXAMPLES, ...A11_EXAMPLES, ...A12_EXAMPLES, ...A13_EXAMPLES, ...A14_EXAMPLES, ...A15_EXAMPLES, ...A16_EXAMPLES,
    'power-of-the-dark-side': { label: 'Opponent chooses their Death Trooper; defeat that chosen unit', beats: CARD_ABILITIES['power-of-the-dark-side'] },
    'force-lightning': { label: 'Example: a friendly Force unit is present; pay 2 resources for 4 damage', beats: [
        CARD_ABILITIES['force-lightning'][0], { ...CARD_ABILITIES['force-lightning'][1], amount: 2 }, { ...CARD_ABILITIES['force-lightning'][2], amount: 4 }
    ] },
    'force-choke': { label: 'Example: Force discount; hit an enemy non-Vehicle for 5; its controller draws 1', beats: CARD_ABILITIES['force-choke'] },
    'overwhelming-barrage': { label: 'Example: a 3-power friendly unit gets +2/+2, then deals 5 to one other unit', beats: [
        CARD_ABILITIES['overwhelming-barrage'][0], { ...CARD_ABILITIES['overwhelming-barrage'][1], amount: 5, scope: 'enemy-unit', label: 'The strengthened unit deals 5 damage to one other unit' }
    ] },
    'bombing-run': { label: 'Example: ground arena; 3 damage to every ground unit on both sides', beats: [
        { ...CARD_ABILITIES['bombing-run'][0], label: 'Ground arena: 3 damage to every unit' }
    ] },
    repair: { label: 'Example: heal 3 damage from your base', beats: [{ ...CARD_ABILITIES.repair[0], scope: 'friendly-base' }] },
    restock: { label: 'Example: 4 cards return from your discard pile to the bottom of your deck, in random order', beats: [{ ...CARD_ABILITIES.restock[0], amount: 4, scope: 'own-deck' }] },
    command: { label: 'Choose 2 example: Experience + strike', beats: [
        mode('command', 'experience', { scope: 'friendly-unit' }), mode('command', 'strike', { amount: 5 })
    ] },
    vigilance: { label: 'Choose 2 example: heal a base + give a Shield', beats: [
        mode('vigilance', 'heal', { scope: 'friendly-base' }), mode('vigilance', 'shield', { scope: 'friendly-unit' })
    ] },
    aggression: { label: 'Choose 2 example: ready a unit + deal 4 damage', beats: [
        mode('aggression', 'ready', { scope: 'friendly-unit' }), mode('aggression', 'damage', { scope: 'enemy-unit' })
    ] },
    cunning: { label: 'Choose 2 example: return a unit + exhaust two other units', beats: [
        mode('cunning', 'return'), mode('cunning', 'exhaust', { amount: 2, scope: 'enemy-unit' })
    ] },
    'the-force-is-with-me': { label: 'Example: a friendly Force unit is present; 2 Experience, 1 Shield, then choose to attack the enemy base', beats: CARD_ABILITIES['the-force-is-with-me'] }
};

/** Explicit demonstration choices. These are example beats, never a reconstruction of a recorded match. */
export function showcaseAbilities(id: string): AbilityBeat[] { return copy(EXAMPLES[id]?.beats ?? CARD_ABILITIES[id] ?? []); }
export function showcaseLabel(id: string): string { return EXAMPLES[id]?.label ?? 'Staged example of this card’s effect'; }
