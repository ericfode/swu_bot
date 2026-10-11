'use strict';

/**
 * Training-data generator for learned bots (JEPA, world/action models).
 *
 *   node bot/learned/gen.js --bots random,heuristic --games 40 --seed 1 --out /mnt/project-files/learned/data/run1
 *
 * Plays games through the normal match loop (same rng use as tournament.js, so a seed replays the same game)
 * and writes one gzipped JSON Lines file per game, <out>/<p1>-vs-<p2>-<seed>.jsonl.gz:
 *
 *   {"t":"d","seq":1,"you":"p1","prompt":{...},"state":{...},"actions":[...],"chosen":3,"after":{...}}
 *   ...
 *   {"t":"end","winner":"p2","outcome":"won","round":11,"steps":342,"bots":["random","heuristic"],"seed":3}
 *
 * `prompt`, `state`, `actions` are exactly the stdio `decide` fields (bot/observe.js), so a model trained on this sees
 * what a stdio bot sees at play time. `after` is observe() from the same seat right after the engine applied the
 * action. Card titles (`n`) are dropped from states to keep files small; set codes (`s`) stay.
 * Pairings are round-robin over --bots including self-play; seats alternate.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Env } = require('../env');
const { playGame } = require('../match');
const { observe, promptView, actionView } = require('../observe');
const { createRandomBot } = require('../players/random');
const { HeuristicBot } = require('../players/heuristic');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

function makeBot(name) {
    if (/^heuristic/.test(name)) {
        return new HeuristicBot(name, { depth: 1 });
    }
    if (/^random/.test(name)) {
        return createRandomBot(name);
    }
    // anything else must be a stdio bot from bot/external-bots.json
    const { ExternalBot } = require('../players/external');
    const reg = JSON.parse(fs.readFileSync(process.env.SWU_EXTERNAL_BOTS ?? path.join(__dirname, '..', 'external-bots.json'), 'utf8'));
    if (!reg[name]) {
        throw new Error(`unknown bot ${name}`);
    }
    return new ExternalBot(name, reg[name]);
}

function stripNames(o) {
    if (Array.isArray(o)) {
        return o.map(stripNames);
    }
    if (o && typeof o === 'object') {
        const r = {};
        for (const k in o) {
            if (k !== 'n' && k !== 'name') {
                r[k] = stripNames(o[k]);
            }
        }
        return r;
    }
    return o;
}

/** Wrap a bot so every decision is logged as a decide view; `after` is filled by the snapshot hook. */
function recording(bot, log) {
    return {
        name: bot.name,
        needsUndo: bot.needsUndo,
        get stats() {
            return bot.stats;
        },
        choose(ctx) {
            const { game: eg, pid, actions } = ctx;
            const seat = `p${eg.ids.indexOf(pid) + 1}`;
            const rec = {
                t: 'd', seq: log.length + 1, you: seat,
                prompt: promptView(eg, pid),
                state: stripNames(observe(eg, pid)),
                actions: actions.map((a, i) => actionView(eg, a, i))
            };
            const a = bot.choose(ctx);
            rec.chosen = actions.indexOf(a);
            rec._pid = pid;
            log.push(rec);
            return a;
        }
    };
}

async function main() {
    const names = arg('bots', 'random,heuristic').split(',');
    const games = Number(arg('games', 10));
    let seed = Number(arg('seed', 1));
    const out = arg('out', 'replays/learned-data');
    const maxSteps = Number(arg('maxSteps', 3000));
    fs.mkdirSync(out, { recursive: true });
    const env = new Env();
    const pairs = [];
    for (let i = 0; i < names.length; i++) {
        for (let j = i; j < names.length; j++) {
            pairs.push([names[i], names[j]]);
        }
    }
    let done = 0;
    for (let g = 0; g < games; g++, seed++) {
        const pair = pairs[g % pairs.length];
        const seats = Math.floor(g / pairs.length) % 2 ? [pair[1], pair[0]] : pair;
        const log = [];
        const bots = seats.map((n) => recording(makeBot(n), log));
        const snapshot = (eg) => {
            const last = log[log.length - 1];
            if (last && !last.after) {
                last.after = stripNames(observe(eg, last._pid));
            }
            return null;
        };
        const t0 = Date.now();
        const r = await playGame(env, { seed, bots, record: true, snapshot, maxSteps });
        const lines = log.map(({ _pid, ...rec }) => JSON.stringify(rec));
        lines.push(JSON.stringify({ t: 'end', winner: r.winner, outcome: r.outcome, error: r.error ?? null, round: r.round, steps: r.steps, bots: seats, seed }));
        const file = path.join(out, `${seats[0]}-vs-${seats[1]}-${seed}.jsonl.gz`);
        fs.writeFileSync(`${file}.tmp`, zlib.gzipSync(lines.join('\n') + '\n'));
        fs.renameSync(`${file}.tmp`, file);
        done++;
        console.log(`${path.basename(file)} ${r.outcome} winner=${r.winner} steps=${r.steps} ${Date.now() - t0}ms`);
    }
    console.log(`done ${done} games`);
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
