#!/usr/bin/env node
'use strict';
// everything this file and what it loads logs goes to stderr: stdout carries only the one result line
console.log = console.error;
/**
 * What the games machine's Elixir coordinator (coord/, coord/README.md) asks Node to do. Elixir decides when; this
 * decides what, with the same code games.js uses:
 *
 *   node bot/arena/gamesctl.js setup                                                   (root)
 *   node bot/arena/gamesctl.js warm                                                    (as arena)
 *   node bot/arena/gamesctl.js plan --arena open --settled-since <ms> [--replay-hours 24]   (as arena)
 *   node bot/arena/gamesctl.js referee-cmd --arena open --round K [--games 2] [--workers 2]   (root)
 *   node bot/arena/gamesctl.js intake --state <file> --boot <id>                       (root)
 *   node bot/arena/gamesctl.js push --arena open --state <file> --boot <id>            (as arena)
 *
 * Each prints exactly one JSON line on stdout and exits 0; 1 is a failure (the reason on stderr), 2 a usage error,
 * 143 a stop by SIGTERM. intake and push reach the window through the coordinator's loopback proxy (SWU_WINDOW), which
 * adds the token: no Node process on the games machine holds it.
 *
 *     setup        folders, the round-seed secret, the residents in the roster: {"ok":true,"residents":[..],"toolchain":null|"no .."}
 *     warm         the resident bundles compiled into the cache: {"ok":true,"warmed":[..],"failed":[{"name","error"}]}
 *     plan         games.js planRound: {"round":K,"resume":bool,"why":".."} or {"round":null,"why":".."}
 *     referee-cmd  the command that plays round K, run by the coordinator: {"cmd":[..],"env":{..},"cwd":".."}
 *     intake       one pass over the window's submissions: {"open":N|null,"accepted":N,"done":N[,"error":".."]}
 *     push         the arena's state and round replays to the window: {"ok":bool}
 *
 * --state files keep what one pass learned for the next (intake: submissions finished and results the window did not
 * take; push: what was sent). They hold the --boot they were written in: a new boot pushes everything again and reads
 * every submission again, but keeps the results still to send.
 */
const fs = require('fs');
// first: games.js points the arena's folders (ARENA_HOME and the rest) at GAMES_DATA before anything reads them
const games = require('./games');

const ARENAS = ['open']; // the No-sims arena comes later (coord/README.md)

class Usage extends Error {}

function opts(argv) {
    const o = {};
    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith('--')) {
            throw new Usage(`unexpected argument ${argv[i]}`);
        }
        o[argv[i].slice(2)] = argv[i + 1];
        i++;
    }
    return o;
}

function need(o, name, test = (v) => v !== undefined && v !== '') {
    if (!test(o[name])) {
        throw new Usage(`--${name} is missing or wrong`);
    }
    return o[name];
}

const arena = (o) => need(o, 'arena', (v) => ARENAS.includes(v));
const int = (v) => /^\d+$/.test(String(v ?? ''));

/** A --state file's contents when it was written in this boot, else {}. Never fails: a broken file starts over. */
function readState(file, boot) {
    try {
        const s = JSON.parse(fs.readFileSync(file, 'utf8'));
        return s?.boot === boot ? s : { boot: null, carry: s };
    } catch {
        return {};
    }
}

function writeState(file, state) {
    require('./home').writeAtomic(file, JSON.stringify(state));
}

const commands = {
    setup() {
        const { residents } = games.setup();
        return { ok: true, residents, toolchain: require('./intake').toolchainMissing() };
    },

    warm() {
        return { ok: true, ...games.warm() };
    },

    plan(o) {
        arena(o);
        const settledSince = Number(need(o, 'settled-since', int));
        const replayMs = Number(o['replay-hours'] ?? 24) * 3600000;
        const p = games.planRound({ replayMs, settledSince });
        return p.round === null ? { round: null, why: p.why } : { round: p.round, resume: p.resume, why: p.why };
    },

    'referee-cmd'(o) {
        arena(o);
        const k = Number(need(o, 'round', int));
        const n = Number(o.games ?? 2);
        const workers = Number(o.workers ?? 2);
        return games.refereeCommand(k, { games: n, workers });
    },

    async intake(o) {
        const file = need(o, 'state');
        const boot = need(o, 'boot');
        const intake = require('./intake');
        const s = readState(file, boot);
        // results the window did not take are kept across boots; what was finished is read again
        const unsent = new Map(s.unsent ?? s.carry?.unsent ?? []);
        const finished = new Set(s.boot === boot ? s.finished ?? [] : []);
        const stats = {};
        const current = {};
        const save = () => writeState(file, { boot, finished: [...finished], unsent: [...unsent] });
        // a stop ends the pass early; the submission being checked goes back to pending, then this exits 143
        let stopped = null;
        process.on('SIGTERM', () => {
            intake.stopCheckers();
            setTimeout(() => process.exit(143), 5000).unref();
            stopped = intake.release(current).catch((e) => console.error(`gamesctl intake: ${e.message}`)).finally(() => {
                save();
                process.exit(143);
            });
        });
        let error;
        let done = 0;
        try {
            done = await intake.intakeOnce({ finished, unsent, stats, current });
        } catch (e) {
            error = e.message;
            stats.open = null;
        }
        save();
        if (stopped) {
            await stopped; // ends in process.exit(143)
        }
        if (stats.open === null && error === undefined) {
            error = intake.toolchainMissing() ?? 'unknown';
        }
        return { open: stats.open ?? null, accepted: stats.accepted ?? 0, done, ...(error !== undefined ? { error } : {}) };
    },

    async push(o) {
        arena(o);
        const file = need(o, 'state');
        const boot = need(o, 'boot');
        const s = readState(file, boot);
        const docs = new Map(Object.entries(s.docs ?? {}));
        const runs = new Map(Object.entries(s.runs ?? {}).map(([id, r]) => [id, {
            docs: new Map(Object.entries(r.docs ?? {})),
            replays: new Map(Object.entries(r.replays ?? {})),
            ...(r.known ? { known: new Map(r.known) } : {})
        }]));
        const pusher = require('./push').arenaPusher({ docs, runs });
        const ok = await pusher.once();
        writeState(file, {
            boot,
            docs: Object.fromEntries(pusher.docs),
            runs: Object.fromEntries([...pusher.runs].map(([id, r]) => [id, {
                docs: Object.fromEntries(r.docs), replays: Object.fromEntries(r.replays), known: r.known ? [...r.known] : null
            }]))
        });
        return { ok };
    }
};

async function main(argv) {
    const cmd = commands[argv[0]];
    if (!cmd) {
        throw new Usage(`no command ${argv[0] ?? ''}; one of ${Object.keys(commands).join(', ')}`);
    }
    const r = await cmd(opts(argv.slice(1)));
    process.stdout.write(`${JSON.stringify(r)}\n`);
}

if (require.main === module) {
    main(process.argv.slice(2)).then(() => process.exit(0), (e) => {
        console.error(e instanceof Usage ? `gamesctl: ${e.message}` : (e.stack ?? e.message));
        process.exit(e instanceof Usage ? 2 : 1);
    });
}

module.exports = { commands, readState };
