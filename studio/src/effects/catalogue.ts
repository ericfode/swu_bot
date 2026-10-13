import type { CardRef } from '../data/types';
import type { CardEffectDefinition } from './types';
import { A01_DEFINITIONS } from './batchA01';
import { A02_DEFINITIONS } from './batchA02';
import { A03_DEFINITIONS } from './batchA03';
import { A04_DEFINITIONS } from './batchA04';
import { A05_DEFINITIONS } from './batchA05';
import { A06_DEFINITIONS } from './batchA06';
import { A07_DEFINITIONS } from './batchA07';
import { A08_DEFINITIONS } from './batchA08';
import { A09_DEFINITIONS } from './batchA09';
import { A10_DEFINITIONS } from './batchA10';
import { A11_DEFINITIONS } from './batchA11';
import { A12_DEFINITIONS } from './batchA12';
import { A13_DEFINITIONS } from './batchA13';
import { A14_DEFINITIONS } from './batchA14';
import { A15_DEFINITIONS } from './batchA15';
import { A16_DEFINITIONS } from './batchA16';

/** Card text and print identities checked against the pinned engine's card data. */
export const CARD_EFFECTS: CardEffectDefinition[] = [
    { id: 'open-fire', name: 'Open Fire', setCode: 'SOR_172', family: 'damage', color: '#ff9459', visual: 'open-fire', durationMs: 2200,
        description: 'Deal 4 damage to a unit.' },
    { id: 'force-lightning', name: 'Force Lightning', setCode: 'SOR_138', family: 'force', color: '#ae91ff', visual: 'force-lightning', durationMs: 2700,
        description: 'A unit loses all abilities this phase. With a friendly Force unit, pay resources to deal 2 damage per resource.' },
    { id: 'force-choke', name: 'Force Choke', setCode: 'SOR_139', family: 'force', color: '#ef758c', visual: 'force-choke', durationMs: 2700,
        description: 'Deal 5 damage to a non-Vehicle unit; its controller draws a card. Costs 1 less with a friendly Force unit.' },
    { id: 'takedown', name: 'Takedown', setCode: 'SOR_077', family: 'tactics', color: '#69c7f2', visual: 'takedown', durationMs: 2200,
        description: 'Defeat a unit with 5 or less remaining HP.' },
    { id: 'vanquish', name: 'Vanquish', setCode: 'SOR_078', family: 'tactics', color: '#aecaff', visual: 'vanquish', durationMs: 2500,
        description: 'Defeat a non-leader unit.' },
    { id: 'superlaser-blast', name: 'Superlaser Blast', setCode: 'SOR_043', family: 'damage', color: '#9dff77', visual: 'superlaser-blast', durationMs: 3400,
        description: 'Defeat all units in both arenas.' },
    { id: 'overwhelming-barrage', name: 'Overwhelming Barrage', setCode: 'SOR_092', family: 'damage', color: '#ffc16d', visual: 'overwhelming-barrage', durationMs: 2900,
        description: 'Give a friendly unit +2/+2 this phase, then divide damage equal to its power among other units.' },
    { id: 'bombing-run', name: 'Bombing Run', setCode: 'SOR_173', family: 'damage', color: '#f6ad56', visual: 'bombing-run', durationMs: 3000,
        description: 'Choose ground or space. Deal 3 damage to every unit in that arena.' },
    { id: 'make-an-opening', name: 'Make an Opening', setCode: 'SOR_076', family: 'tactics', color: '#84cafa', visual: 'make-an-opening', durationMs: 2700,
        description: 'Give a unit −2/−2 this phase and heal 2 damage from your base.' },
    { id: 'repair', name: 'Repair', setCode: 'SOR_074', family: 'support', color: '#6fe4bc', visual: 'repair', durationMs: 2400,
        description: 'Heal 3 damage from a unit or base.' },
    { id: 'restock', name: 'Restock', setCode: 'SOR_252', family: 'support', color: '#b2ddaa', visual: 'restock', durationMs: 2600,
        description: 'Return up to 4 cards from one discard pile to the bottom of their owner’s deck in a random order.' },
    { id: 'resupply', name: 'Resupply', setCode: 'SOR_126', family: 'support', color: '#8edc7d', visual: 'resupply', durationMs: 2300,
        description: 'Put this event into play as a resource.' },
    { id: 'command', name: 'Command', setCode: 'SOR_107', family: 'support', color: '#73d99a', visual: 'command', durationMs: 2900,
        description: 'Choose two: give 2 Experience; a friendly unit hits a non-unique enemy for its power; resource this event; or recover a unit from your discard pile.' },
    { id: 'vigilance', name: 'Vigilance', setCode: 'SOR_058', family: 'support', color: '#81c9ff', visual: 'vigilance', durationMs: 2900,
        description: 'Choose two: discard 6 from an opponent’s deck; heal 5 from a base; defeat a unit with 3 or less HP remaining; or give a Shield.' },
    { id: 'aggression', name: 'Aggression', setCode: 'SOR_155', family: 'damage', color: '#ff796f', visual: 'aggression', durationMs: 2900,
        description: 'Choose two: draw a card; defeat up to 2 upgrades; ready a unit with 3 or less power; or deal 4 damage to a unit.' },
    { id: 'cunning', name: 'Cunning', setCode: 'SOR_203', family: 'tactics', color: '#ead575', visual: 'cunning', durationMs: 2900,
        description: 'Choose two: return a non-leader with 4 or less power to hand; give +4/+0 this phase; exhaust up to 2 units; or an opponent discards at random.' },
    { id: 'power-of-the-dark-side', name: 'Power of the Dark Side', setCode: 'SOR_041', family: 'force', color: '#bd82ea', visual: 'power-of-the-dark-side', durationMs: 2900,
        description: 'An opponent chooses a unit they control, then defeats it.' },
    { id: 'the-force-is-with-me', name: 'The Force Is With Me', setCode: 'SOR_055', family: 'force', color: '#9deacb', visual: 'the-force-is-with-me', durationMs: 3000,
        description: 'Give a friendly unit 2 Experience and, with a friendly Force unit, a Shield. You may attack with the chosen unit.' },
    { id: 'waylay', name: 'Waylay', setCode: 'SOR_222', family: 'tactics', color: '#f0d189', visual: 'waylay', durationMs: 2400,
        description: 'Return a non-leader unit to its owner’s hand.' },
    { id: 'spark-of-rebellion', name: 'Spark of Rebellion', setCode: 'SOR_200', family: 'tactics', color: '#ffbb7e', visual: 'spark-of-rebellion', durationMs: 2700,
        description: 'Look at an opponent’s hand and choose a card to discard from it.' },
    ...A01_DEFINITIONS,
    ...A02_DEFINITIONS,
    ...A03_DEFINITIONS,
    ...A04_DEFINITIONS,
    ...A05_DEFINITIONS, ...A06_DEFINITIONS, ...A07_DEFINITIONS, ...A08_DEFINITIONS, ...A09_DEFINITIONS, ...A10_DEFINITIONS, ...A11_DEFINITIONS, ...A12_DEFINITIONS, ...A13_DEFINITIONS, ...A14_DEFINITIONS, ...A15_DEFINITIONS, ...A16_DEFINITIONS
];

const normalizeName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const normalizePrint = (code: string) => code.trim().toUpperCase().replace(/_(\d+)$/, (_, n: string) => `_${n.padStart(3, '0')}`);
const byName = new Map(CARD_EFFECTS.map((effect) => [normalizeName(effect.name), effect]));
const byPrint = new Map(CARD_EFFECTS.map((effect) => [effect.setCode, effect]));

// These alternate prints have identical rules. Do not guess identities from arbitrary set numbers.
const reprints: Record<string, string> = {
    SOR_125: 'prepare-for-takeoff',
    TWI_174: 'open-fire', TWI_077: 'vanquish', JTL_075: 'repair', TWI_127: 'resupply', TWI_226: 'waylay',
    SOR_220: 'surprise-strike', SOR_251: 'confiscate',
    SHD_128: 'outflank', SOR_124: 'tactical-advantage', SHD_131: 'take-captive', SHD_178: 'daring-raid'
};
for (const [print, id] of Object.entries(reprints)) {
    byPrint.set(print, CARD_EFFECTS.find((effect) => effect.id === id)!);
}

/** A recorded print is authoritative; title fallback is only for older captures without print ids. */
export function findCardEffect(card: CardRef): CardEffectDefinition | undefined {
    return card.s ? byPrint.get(normalizePrint(card.s)) : byName.get(normalizeName(card.n));
}
