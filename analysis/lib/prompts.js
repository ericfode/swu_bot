'use strict';

/**
 * Prompts and output schemas for the three views. PROMPT_VERSION goes into every analysis file and into the
 * cache key, so bump it whenever the wording changes.
 */

const PROMPT_VERSION = 'pos-eval-2'; // 2: subjective logs also hide the opponent's picks from hidden zones

const RULES = `Star Wars: Unlimited (SWU), two players, quick reference:
- Each player has a base (usually 25-30 HP) and a leader. You win when the opponent's base has no HP left.
- A round is an action phase then a regroup phase. In the action phase players alternate taking ONE action at a time:
  play a card (paying its cost by exhausting resources), attack with a ready unit, use or deploy their leader,
  pass, or claim the initiative (which passes for the rest of the round and makes them act first next round).
  The phase ends when both players pass in a row.
- Units live in the ground or space arena and attack an enemy unit in the same arena or the enemy base. Combat is
  simultaneous: each deals its power to the other. A unit with damage >= HP is defeated. Units with Sentinel must be
  attacked first in their arena. Units enter play exhausted and ready again in the regroup phase.
- Regroup: each player draws 2 cards, may put 1 card from hand into resources (face down), then everything readies.
- Card advantage, resources (tempo), board control in both arenas, the base-damage race and initiative all matter.
  Leaders deploy as strong units once a player has enough resources.
Card names follow the real game; if you do not recognise a card, judge it from the stats shown.`;

const FACTORS = ['board', 'base_race', 'cards', 'resources', 'initiative'];

const CHECKPOINT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['p_win', 'confidence', 'factors', 'key_factor', 'why'],
    properties: {
        p_win: { type: 'number', description: 'Probability in [0,1] that the player named in the request wins.' },
        confidence: { type: 'number', description: 'How sure you are of p_win, in [0,1].' },
        factors: {
            type: 'object',
            additionalProperties: false,
            required: FACTORS,
            properties: Object.fromEntries(FACTORS.map((f) => [f, { type: 'number', description: 'Advantage in [-1,1] for the named player.' }]))
        },
        key_factor: { type: 'string', enum: FACTORS },
        why: { type: 'string', description: 'At most 40 words.' }
    }
};

const OMNISCIENT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['evals', 'turning_points', 'summary'],
    properties: {
        evals: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['i', 'p1', 'note'],
                properties: {
                    i: { type: 'integer' },
                    p1: { type: 'number', description: 'Hindsight probability in [0,1] that player 1 wins from this checkpoint.' },
                    note: { type: 'string', description: 'At most 12 words, empty if nothing notable.' }
                }
            }
        },
        turning_points: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['i', 'by', 'what'],
                properties: {
                    i: { type: 'integer' },
                    by: { type: 'string', enum: ['p1', 'p2', 'luck'] },
                    what: { type: 'string', description: 'At most 25 words.' }
                }
            }
        },
        summary: { type: 'string', description: 'At most 80 words: how the game was won and lost.' }
    }
};

const CHECKPOINT_SYSTEM = `You are an expert Star Wars: Unlimited analyst estimating who is winning a game in progress.

${RULES}

You will get a position and recent decisions. Estimate the probability that the named player wins, assuming both
players keep playing at the level their decisions so far suggest. Be calibrated: 0.5 means a coin flip, values near 0
or 1 only when the game is effectively decided. Use only the information given; do not invent hidden cards.
Score each factor from -1 (strongly favours the opponent) to +1 (strongly favours the named player).
Answer with the JSON object only.`;

const SUBJECTIVE_NOTE = `This is a SUBJECTIVE evaluation: you are advising one player and see only what they see.
The opponent's hand is hidden (you know its size, their discard pile and what they have played). Estimate the win
probability from that player's own point of view, taking into account what the opponent could plausibly hold.`;

const OBJECTIVE_NOTE = `This is an OBJECTIVE evaluation with perfect knowledge of the current state: both hands are shown.
You still do not know the order of either deck or what either player will do next.`;

const OMNISCIENT_SYSTEM = `You are an expert Star Wars: Unlimited analyst reviewing a finished game with complete hindsight.

${RULES}

You get the whole game as a list of checkpoints, with every hand visible, every draw that happened and the result.
For EVERY checkpoint, estimate the hindsight probability that player 1 wins: given everything you now know about
the cards each player was going to draw and how each player actually plays, how favoured was player 1 at that
moment? This is not just the final result: a position that was winning and later thrown should score high before
the mistake and drop at it. Values should reach the actual result at the final checkpoint.
Also list the few turning points (checkpoint index, who caused it, what happened) and a short summary.
Answer with the JSON object only.`;

module.exports = { PROMPT_VERSION, RULES, FACTORS, CHECKPOINT_SCHEMA, OMNISCIENT_SCHEMA, CHECKPOINT_SYSTEM, SUBJECTIVE_NOTE, OBJECTIVE_NOTE, OMNISCIENT_SYSTEM };
