'use strict';

const crypto = require('crypto');

/** Small seeded PRNG (mulberry32) for reproducible bot decisions. Its state is 32 bits: never use it to hide anything. */
function seededRng(seedStr) {
    let h = 1779033703 ^ String(seedStr).length;
    for (let i = 0; i < String(seedStr).length; i++) {
        h = Math.imul(h ^ String(seedStr).charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19);
    }
    let a = h >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const hmac = (key, text) => crypto.createHmac('sha256', String(key)).update(text).digest('hex');

/** Unpredictable without `key`: HMAC-SHA256 in counter mode. */
function keyedRng(key, label) {
    let n = 0;
    return () => parseInt(hmac(key, `${label}:${n++}`).slice(0, 8), 16) / 4294967296;
}

/**
 * Every random stream of one game, derived from the game seed. Without a key they are the original seeded streams,
 * which anyone who knows (or guesses) the seed can rebuild, hidden cards included: fine for development and the
 * determinism gate, not for bots that might try. With a secret key nothing follows from the seed alone.
 *   match    decks, actor order, native bots' choices, random splits
 *   engine   the engine RNG seed (deck order, shuffles)
 *   botSeed  the `seed` a seat gets in hello
 *   sim      the private stream of one deal of a seat's simulations, by label (decision and deal number)
 */
function gameStreams(seed, key = null) {
    if (key == null) {
        return {
            match: seededRng('bot' + seed), engine: String(seed),
            botSeed: (seat) => Math.floor(seededRng(`${seed}:${seat}`)() * 4294967296),
            sim: (seat, deal) => seededRng(`sim:${seed}:${seat}:${deal}`)
        };
    }
    return {
        match: keyedRng(key, `match:${seed}`), engine: hmac(key, `engine:${seed}`),
        botSeed: (seat) => parseInt(hmac(key, `bot:${seed}:${seat}`).slice(0, 8), 16),
        sim: (seat, deal) => keyedRng(key, `sim:${seed}:${seat}:${deal}`)
    };
}

/** The key of one game of a run: publishing it after the game reveals nothing about the run's other games. */
const gameKey = (key, seed) => hmac(key, `game:${seed}`);

/**
 * The run key for a `--key` argument: a fresh secret when none is given, null for `none` (the seed alone, as upstream
 * seeds games), else the key itself, to play a run again or to give two runs the same games. Bot programs can read
 * the referee's command line, so a key given there is no secret.
 */
const runKey = (arg) => (arg == null ? crypto.randomBytes(16).toString('hex') : arg === 'none' ? null : String(arg));

module.exports = { seededRng, keyedRng, gameStreams, gameKey, runKey };
