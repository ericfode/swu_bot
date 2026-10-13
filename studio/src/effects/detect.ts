import type { Action } from '../data/actions';
import type { CardRef, Game, Seat } from '../data/types';
import { findCardEffect } from './catalogue';
import { observedOutcomes } from './outcomes';
import type { CardEffectCue } from './types';

interface Target { card: CardRef; seat: Seat }
const normalizeName = (name: string) => name.split('#')[0].toLowerCase().replace(/[^a-z0-9]/g, '');

/** Recover only the selected unit in a known card prompt, before damage or a later optional attack changes it. */
function selectedTarget(game: Game, action: Action, title: RegExp, friendly: boolean): Target | null {
    for (let i = action.index + 1; i <= action.until; i++) {
        const step = game.steps[i];
        if (step.pid !== action.seat || step.action?.kind !== 'card' || !title.test(step.title ?? '')) {
            continue;
        }
        const seats: Seat[] = friendly ? [action.seat] : ['p1', 'p2'];
        const candidates = seats.flatMap((seat) => {
            const player = game.steps[i - 1].state.players[seat];
            return [...player.ground, ...player.space].map((card) => ({ card, seat }));
        });
        const pick = step.action;
        const matches = candidates.filter(({ card }) => pick.id
            ? card.id === pick.id
            : normalizeName(card.n) === normalizeName(pick.label));
        // Duplicate titles in old captures are ambiguous. An unknown recorded id must not degrade to a guess by name.
        return matches.length === 1 ? matches[0] : null;
    }
    return null;
}

function effectTarget(game: Game, action: Action, id: string): Target | null {
    if (id === 'force-lightning') {
        return selectedTarget(game, action, /^Choose a unit\. It loses all abilities for this phase\./i, false);
    }
    if (id === 'the-force-is-with-me') {
        return selectedTarget(game, action, /^(Give 2 Experience\b|Choose a (?:friendly )?unit\b)/i, true);
    }
    if (id === 'overwhelming-barrage') {
        return selectedTarget(game, action, /^Give a friendly unit \+2\/\+2 for this phase\b/i, true);
    }
    if (id === 'power-failure') {
        return selectedTarget(game, action, /^Defeat any number of upgrades on a unit/i, false);
    }
    return action.target && action.targetSeat ? { card: action.target, seat: action.targetSeat } : null;
}

/**
 * Cue a supported event once, when its classified action resolves. Follow-up card picks, resource choices,
 * attacks and triggers are never interpreted as playing an event. Seeking/playback policy belongs to the viewer.
 */
export function detectCardEffects(game: Game, actions: Action[]): Map<number, CardEffectCue> {
    const cues = new Map<number, CardEffectCue>();
    for (const action of actions) {
        if (action.cls !== 'play-event' || !action.card || action.index < 1 || action.until < action.index || !game.steps[action.until]) {
            continue;
        }
        // The final observed prompt answer in a live file can still be waiting for a target or a mode choice.
        // A subsequent action (or the end record) confirms that this action actually finished.
        if (!game.end && action.until === game.steps.length - 1) {
            continue;
        }
        const definition = findCardEffect(action.card);
        if (!definition) {
            continue;
        }
        const target = effectTarget(game, action, definition.id);
        const outcomes = observedOutcomes(game, action);
        if (definition.id === 'strike-true' || definition.id === 'karabast') {
            const title = definition.id === 'strike-true' ? /^A friendly unit deals damage equal to its power to an enemy unit/i
                : /^A friendly unit deals damage equal to its damage plus one to an enemy unit/i;
            const origin = selectedTarget(game, action, title, true);
            if (origin) for (const outcome of outcomes) {
                if (outcome.kind === 'damage' && outcome.zone !== 'base') {
                    outcome.sourceCard = origin.card;
                    outcome.fromSeat = origin.seat;
                    if (definition.id === 'karabast' && origin.card.id && 'd' in origin.card
                        && typeof origin.card.d === 'number' && outcome.amount === origin.card.d + 1) {
                        outcome.damageType = 'ability';
                        outcome.basis = { kind: 'source-damage-plus-one', sourceIds: [origin.card.id], value: origin.card.d, increment: 1 };
                    }
                }
            }
        }
        if (definition.id === 'force-throw') {
            for (let i = action.index + 1; i <= action.until; i++) {
                const step = game.steps[i];
                if (!step.pid || step.action?.kind !== 'card' || !/^Choose a card to discard for Force Throw's effect$/i.test(step.title ?? '')) continue;
                const pick = step.action;
                const matches = game.steps[i - 1].state.players[step.pid].hand.filter(card => pick.id
                    ? card.id === pick.id : normalizeName(card.n) === normalizeName(pick.label));
                if (matches.length !== 1) continue;
                for (const outcome of outcomes) {
                    const selected = matches[0];
                    const exact = selected.id ? outcome.card?.id === selected.id
                        : outcome.card?.s === selected.s && outcome.card?.n === selected.n;
                    if (outcome.kind === 'discard' && exact && outcome.seat === step.pid) {
                        outcome.chooserSeat = step.pid;
                        outcome.selection = step.pid === action.seat ? 'chosen' : 'opponent';
                        outcome.label = `${step.pid.toUpperCase()} CHOOSES · DISCARD 1`;
                    }
                }
            }
        }
        const upgrade = definition.id === 'power-failure' ? outcomes.find(outcome => outcome.sourceCard) : undefined;
        cues.set(action.until, {
            definition,
            seat: action.seat,
            source: action.card,
            target: target?.card ?? upgrade?.sourceCard ?? null,
            ...(target ? { targetSeat: target.seat } : upgrade ? { targetSeat: upgrade.seat } : {}),
            outcomes,
            transition: { before: game.steps[action.index - 1].state, after: game.steps[action.until].state,
                beforeStep: action.index - 1, afterStep: action.until },
            key: `${game.header.seed}:${action.index}:${action.until}:${action.seat}:${definition.id}`
        });
    }
    return cues;
}
