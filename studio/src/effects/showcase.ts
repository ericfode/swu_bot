import type { Game, Snapshot } from '../data/types';
import type { CardEffectDefinition } from './types';
import { previewExtraPayment, previewPlayCost } from './previewCosts';
import { a01ShowcaseState } from './batchA01';
import { a02ShowcaseState } from './batchA02';
import { a03ShowcaseState } from './batchA03';
import { a04ShowcaseState } from './batchA04';
import { a05ShowcaseState } from './batchA05';
import { a06ShowcaseState } from './batchA06';
import { a07ShowcaseState } from './batchA07';
import { a08ShowcaseState } from './batchA08';
import { a09ShowcaseState } from './batchA09';
import { a10ShowcaseState } from './batchA10';
import { a11ShowcaseState } from './batchA11';
import { a12ShowcaseState } from './batchA12';
import { a13ShowcaseState } from './batchA13';
import { a14ShowcaseState } from './batchA14';
import { a15ShowcaseState } from './batchA15';
import { a16ShowcaseState } from './batchA16';

/** A deliberately staged board, not an engine recording. Used by the shared gameplay renderer. */
export function showcaseGame(effect: CardEffectDefinition): Game {
    const authored = a01ShowcaseState(effect) ?? a02ShowcaseState(effect) ?? a03ShowcaseState(effect) ?? a04ShowcaseState(effect) ?? a05ShowcaseState(effect) ?? a06ShowcaseState(effect) ?? a07ShowcaseState(effect) ?? a08ShowcaseState(effect) ?? a09ShowcaseState(effect) ?? a10ShowcaseState(effect) ?? a11ShowcaseState(effect) ?? a12ShowcaseState(effect) ?? a13ShowcaseState(effect) ?? a14ShowcaseState(effect) ?? a15ShowcaseState(effect) ?? a16ShowcaseState(effect);
    const state: Snapshot = authored ?? {
        round: 5,
        phase: 'action',
        initiative: 'p1',
        players: {
            p1: {
                name: 'Rebel Alliance',
                base: { n: 'Echo Base', s: 'SOR_024', hp: 30, d: 9 },
                leader: { n: 'Luke Skywalker: Faithful Friend', s: 'SOR_005', dep: 0, x: 0 },
                res: { ready: 5, total: 7 },
                hand: [{ n: effect.name, s: effect.setCode }],
                deck: 27,
                discard: [{ n: 'Restock', s: 'SOR_252' }, { n: 'Rebel Pathfinder', s: 'SOR_239' }, { n: 'Resupply', s: 'SOR_126' }, { n: 'Open Fire', s: 'SOR_172' }],
                ground: [
                    { n: 'Battlefield Marine', s: 'SOR_095', p: 3, h: 3, d: 1, ...(effect.id === 'aggression' ? { x: 1 as const } : {}) },
                    { n: 'Echo Base Defender', s: 'SOR_098', p: 4, h: 3, d: 0, sn: 1 }
                ],
                space: [{ n: 'Alliance X-Wing', s: 'SOR_237', p: 2, h: 3, d: 0 }]
            },
            p2: {
                name: 'Galactic Empire',
                base: { n: 'Capital City', s: 'SOR_020', hp: 30, d: 6 },
                leader: { n: 'Darth Vader: Dark Lord of the Sith', s: 'SOR_010', dep: 0, x: 1 },
                res: { ready: 3, total: 7 },
                hand: [{ n: 'Takedown', s: 'SOR_077' }, { n: 'Vanquish', s: 'SOR_078' }, { n: 'Open Fire', s: 'SOR_172' }],
                deck: 29,
                discard: [],
                ground: [
                    { n: 'Death Trooper', s: 'SOR_033', p: 3, h: 3, d: 0 },
                    { n: 'Wampa', s: 'SOR_164', p: 4, h: 5, d: 0 }
                ],
                space: [{ n: 'TIE/ln Fighter', s: 'SOR_225', p: 2, h: 1, d: 0 }]
            }
        }
    };
    if (['force-lightning', 'force-choke', 'the-force-is-with-me'].includes(effect.id)) {
        state.players.p1.ground[1] = { n: 'Luke Skywalker: Jedi Knight', s: 'SOR_051', p: 6, h: 7, d: 0 };
    }
    // These are legal late-game examples: pay the event (including missing aspects) and any selected extra cost.
    if (!authored) {
        const ready = Math.max(5, previewPlayCost(effect, state) + previewExtraPayment(effect));
        state.players.p1.res = { ready, total: Math.max(7, ready) };
    }
    // Fixtures have instance identities too: an event in hand can share a title with a discarded copy.
    for (const seat of ['p1', 'p2'] as const) {
        const player = state.players[seat];
        player.base.id ??= `${seat}:base`;
        if (player.leader) player.leader.id ??= `${seat}:leader`;
        for (const zone of ['hand', 'discard', 'ground', 'space'] as const) {
            player[zone].forEach((card, i) => { card.id ??= `${seat}:${zone}:${i}`; });
        }
    }
    return {
        header: {
            t: 'header', v: 1, seed: 0, engine: 'animation-showcase',
            players: [
                { id: 'p1', bot: 'Rebel Alliance', deck: 'Luke Skywalker / Echo Base' },
                { id: 'p2', bot: 'Galactic Empire', deck: 'Darth Vader / Capital City' }
            ]
        },
        steps: [{ t: 'step', n: 0, pid: 'p1', state }],
        end: null
    };
}
