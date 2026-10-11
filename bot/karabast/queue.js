#!/usr/bin/env node
'use strict';
/**
 * Play quick-match games on a Karabast server as a bot: enter the queue with a deck list, play the match it gets
 * through bot/karabast/seat.js, then leave (no requeue, no rematch). One game at a time.
 *
 *   node bot/karabast/queue.js --bot c-clock --decks bot/decks/ash-meta-2026-09.json --deck <name> [--games 1]
 *        [--server http://127.0.0.1:9500] [--allow-host <host>] [--username "swu-bot (bot)"]
 *        [--format premier] [--card-pool current] [--wait-minutes 10] [--chat "<line>"] [--out <dir>]
 *        [--ledger <file> --max-people 10] [--stop-file <file>] [--allow-undos 2] [--seed 1] [--gap 60] [--max-errors 3]
 *
 * With --games above 1 it is a loop: after each game it waits --gap seconds (at least 25: a finished lobby keeps its
 * users ~20 s) and queues again, until the games, the people cap, the stop file or --max-errors failures in a row end
 * it. A wait with no match is no failure: it queues again.
 *
 * Safety:
 * - Only localhost unless --allow-host names the server's host (socket.js).
 * - A non-local run needs --ledger: before entering the queue the run reserves one place under --max-people, or stops
 *   (ledger.js). The opponent is counted in that place as soon as the match is made. A run that fails after entering
 *   the queue, a wait with no match included, keeps the place counted: only the server knows whether it matched us.
 * - It stops before the next game when --stop-file exists.
 * - The seat never sends undo, answers the opponent's undo requests by a fixed rule and concedes rather than time out
 *   when the bot keeps failing (seat.js).
 * - Decks with cards that are known to throw engine errors are refused, since Karabast logs each error and sends
 *   severe ones to its developers (KNOWN_ERRORS).
 *
 * Each game's frames as our seat saw them are saved scrubbed (frame.js makeScrubber) to <out>/frames/<hash>.jsonl,
 * for `node importer/import.js <out>/frames`, and a result line is appended to <out>/games.jsonl. <out>/status.json
 * says what the run is doing (queued, playing which file, between games, stopped and why), rewritten every 30 s, so
 * live-view.js can show it and open a game from its first board.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { KarabastSocket, post } = require('./socket');
const { KarabastSeat, loadClient } = require('./seat');
const { makeScrubber } = require('./frame');
const { PeopleLedger } = require('./ledger');

/** Cards whose abilities throw in our engine pin (CLAUDE.md, known engine bugs). */
const KNOWN_ERRORS = { ASH_044: 'Barriss Offee, Redeeming Herself' };

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const NO_MATCH = 'no match within';
/** A finished lobby keeps its users ~20 s; queueing again sooner can put us back with the same person. */
const MIN_GAP_S = 25;

/** Writes <out>/status.json whole (temp file, then rename), so a reader never sees half of it. */
function writeStatus(out, status) {
    if (!out) {
        return;
    }
    fs.mkdirSync(out, { recursive: true });
    const file = path.join(out, 'status.json');
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...status, at: new Date().toISOString() }) + '\n');
    fs.renameSync(`${file}.tmp`, file);
}

/** Refuses a deck holding a card from KNOWN_ERRORS. */
function checkDeck(deck) {
    const bad = [deck.leader, deck.base, ...(deck.deck ?? [])].map((c) => c?.id).filter((id) => Object.hasOwn(KNOWN_ERRORS, id));
    if (bad.length) {
        throw new Error(`deck ${deck.metadata?.name ?? '?'} holds ${bad.map((id) => `${KNOWN_ERRORS[id]} (${id})`).join(', ')}, which throws engine errors`);
    }
    return deck;
}

/**
 * Enters the queue and plays one match. onQueued() runs once the server took the queue entry. onMatched(opponentId)
 * runs when the opponent is known, before play starts; it may throw to leave. Resolves to a result row.
 */
async function queueOnce({ server, user, deck, bot, format, cardPool, waitMs, chat, allowHosts, allowUndos, seed, out, onQueued, onMatched, onGameFile, log }) {
    const opts = { allowHosts };
    const entered = await post(server, '/api/enter-queue', { user, format, cardPool, gamesToWinMode: 'bestOfOne', deck }, opts);
    if (!entered.body?.success) {
        throw new Error(`enter-queue refused: ${entered.body?.message ?? entered.status}`);
    }
    onQueued?.();
    const sock = new KarabastSocket(server, { user, allowHosts });
    const client = loadClient(bot);
    const scrub = makeScrubber([user.id, user.username]);
    let fd = null;
    let file = null;
    let timer = null;
    const t0 = Date.now();
    try {
        // the socket must be listening before the match frames arrive
        const matched = new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`no match within ${waitMs / 60000} minutes`)), waitMs);
            const onLobby = (ls) => {
                const others = (ls?.users ?? []).map((u) => u.id).filter((id) => id && id !== user.id);
                if (others.length) {
                    clearTimeout(timer);
                    sock.off('lobbystate', onLobby);
                    resolve({ lobbyId: ls.id, opponent: others[0] });
                }
            };
            sock.on('lobbystate', onLobby);
            sock.once('disconnect', (why) => reject(new Error(`socket closed while queued: ${why}`)));
        });
        sock.on('gamestate', (gs) => {
            if (!gs?.players || Object.keys(gs.players).length < 2) {
                return;
            }
            if (!fd && out) {
                fs.mkdirSync(path.join(out, 'frames'), { recursive: true });
                file = path.join(out, 'frames', `${hash(`${gs.id ?? ''}|${user.id}`)}.jsonl`);
                fd = fs.openSync(file, 'a');
                onGameFile?.(path.basename(file));
            }
            if (fd) {
                fs.writeSync(fd, JSON.stringify(scrub(gs)) + '\n');
            }
        });
        // if connect() throws, the wait still runs out later: that rejection must not be unhandled (it would end a loop)
        matched.catch(() => undefined);
        await sock.connect();
        log('queued; waiting for a match');
        const match = await matched;
        await onMatched(match.opponent);
        log(`matched in lobby ${hash(match.lobbyId)}`);
        const seat = new KarabastSeat(sock, user.id, client, { deck, seed, chat, allowUndos, log });
        const r = await seat.play();
        return {
            at: new Date().toISOString(), bot, deck: deck.metadata?.name ?? null, result: r.result, reason: r.reason,
            minutes: +((Date.now() - t0) / 60000).toFixed(2), round: seat.obs.round, file: file ? path.basename(file) : null,
            decisions: r.stats.decisions, botMsMax: Math.max(0, ...r.stats.botMs), rejected: r.stats.rejected, failures: r.stats.failures.length,
            fallbacks: r.stats.fallbacks, undoAllowed: r.stats.undoAllowed, undoDenied: r.stats.undoDenied, conceded: r.stats.conceded
        };
    } finally {
        clearTimeout(timer);
        if (fd) {
            fs.closeSync(fd);
        }
        sock.close();
        await Promise.resolve(client.close?.()).catch(() => undefined);
    }
}

async function main() {
    const server = arg('server', 'http://127.0.0.1:9500');
    const allowHosts = arg('allow-host') ? [arg('allow-host')] : [];
    const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(server).hostname);
    const ledgerFile = arg('ledger');
    if (!local && !ledgerFile) {
        throw new Error('a run against a non-local server needs --ledger <file> (the people cap)');
    }
    const ledger = ledgerFile ? new PeopleLedger(ledgerFile, Number(arg('max-people', 10))) : null;
    const decks = JSON.parse(fs.readFileSync(arg('decks', path.join(__dirname, '..', 'decks', 'ash-meta-2026-09.json')), 'utf8'));
    const name = arg('deck');
    const deck = checkDeck(decks.find((d) => d.metadata?.name === name) ?? (() => {
        throw new Error(`--deck: no deck named ${name}`);
    })());
    const stopFile = arg('stop-file');
    const games = Number(arg('games', 1));
    const out = arg('out');
    const seed = arg('seed', '1');
    const user = { id: `swu-bot-${crypto.randomUUID()}`, username: arg('username', 'swu-bot (bot)') };
    const log = (line) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
    const bot = arg('bot', 'c-clock');
    const gapS = Number(arg('gap', 60));
    const maxErrors = Number(arg('max-errors', 3));
    // NaN would pass every comparison below and loop without a stop
    if (!(gapS >= MIN_GAP_S)) {
        throw new Error(`--gap must be at least ${MIN_GAP_S} seconds: a finished lobby keeps its users ~20 s`);
    }
    if (!Number.isInteger(games) || games < 1 || !Number.isInteger(maxErrors) || maxErrors < 1) {
        throw new Error('--games and --max-errors must be whole numbers of 1 or more');
    }
    const end = await runLoop({
        games, gapS, maxErrors, stopFile, ledger, out, bot, deck: name, log,
        play: (g, hooks) => queueOnce({
            server, user, deck, bot, format: arg('format', 'premier'), cardPool: arg('card-pool', 'current'),
            waitMs: Number(arg('wait-minutes', 10)) * 60000, chat: arg('chat', null), allowHosts, allowUndos: Number(arg('allow-undos', 2)),
            seed: `${seed}-${g}`, out, log, ...hooks
        })
    });
    if (!end.ok) {
        process.exitCode = 1;
    }
}

/**
 * Plays up to `games` games one after another; play(g, hooks) plays one (queueOnce). Before each game it holds the
 * opponent's place in the ledger; it keeps <out>/status.json current and appends each game's row to games.jsonl.
 * It stops on the stop file, the people cap, a ledger error, or maxErrors failures in a row (a wait with no match is
 * no failure). Resolves to the status it ended on.
 */
async function runLoop({ games, gapS, maxErrors = 3, stopFile = null, ledger = null, out = null, bot, deck, play, log, wait = sleep }) {
    const tally = { played: 0, won: 0, lost: 0, errors: 0 };
    let status = { bot, deck, state: 'starting', since: new Date().toISOString(), file: null };
    const set = (patch) => {
        status = { ...status, ...patch, ...tally };
        writeStatus(out, status);
    };
    // a reader tells a run that died from one waiting in the queue by this heartbeat
    const beat = setInterval(() => writeStatus(out, status), 30000);
    beat.unref?.();
    let reason = `played the ${games} game(s) asked for`;
    let failures = 0;
    let ok = true;
    try {
        set({});
        for (let g = 0; g < games; g++) {
            if (stopFile && fs.existsSync(stopFile)) {
                reason = 'the stop file exists';
                break;
            }
            // the opponent's place is held before entering the queue, so another run sharing the ledger cannot take it
            const hold = ledger ? ledger.reserve(1) : null;
            if (ledger && !hold) {
                reason = `the people cap is reached (${ledger.count} counted, ${ledger.reserved()} reserved, of ${ledger.max})`;
                break;
            }
            let row;
            let queued = false;
            let matched = false;
            let ledgerError = null;
            try {
                row = await play(g, {
                    onQueued: () => {
                        queued = true;
                        set({ state: 'queued', since: new Date().toISOString(), file: null });
                    },
                    onMatched: async (opponent) => {
                        matched = true;
                        try {
                            ledger?.add([opponent], 'played', hold);
                        } catch (e) {
                            ledgerError = e;
                            throw e;
                        }
                    },
                    onGameFile: (file) => set({ state: 'playing', since: new Date().toISOString(), file })
                });
            } catch (e) {
                row = { at: new Date().toISOString(), bot, deck, result: e.message.startsWith(NO_MATCH) ? 'no match' : 'error', reason: e.message };
            } finally {
                // once queued, the server may have matched us before we heard of it, even as our wait ran out, or add()
                // failed: the place stays counted
                if (matched || queued) {
                    ledger?.spend(hold, 'played');
                } else {
                    ledger?.release(hold);
                }
            }
            console.log(JSON.stringify(row));
            if (out) {
                fs.appendFileSync(path.join(out, 'games.jsonl'), JSON.stringify(row) + '\n');
            }
            if (row.result === 'error') {
                tally.errors++;
                failures++;
                log(`game ${g + 1} failed: ${row.reason}`);
            } else {
                failures = 0;
                if (row.result !== 'no match') {
                    tally.played++;
                    tally.won += row.result === 'win' ? 1 : 0;
                    tally.lost += row.result === 'loss' ? 1 : 0;
                }
            }
            // a run that ends on a failed game reports it (exit code 1), even below maxErrors
            ok = row.result !== 'error';
            if (ledgerError) {
                reason = `the people ledger refused the opponent: ${ledgerError.message}`;
                ok = false;
                break;
            }
            if (failures >= maxErrors) {
                reason = `${failures} failures in a row (last: ${row.reason})`;
                break;
            }
            if (g + 1 < games) {
                set({ state: 'between games', since: new Date().toISOString(), file: null, last: row.result });
                await wait(gapS * 1000);
            }
        }
    } finally {
        clearInterval(beat);
    }
    log(`stopping: ${reason}`);
    set({ state: 'stopped', since: new Date().toISOString(), file: null, reason, ok });
    return status;
}

if (require.main === module) {
    main().then(() => process.exit(process.exitCode ?? 0), (e) => {
        console.error(e.message);
        process.exit(1);
    });
}

module.exports = { queueOnce, runLoop, checkDeck, KNOWN_ERRORS, MIN_GAP_S };
