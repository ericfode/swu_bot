#!/usr/bin/env node
'use strict';
/**
 * Play quick-match games on a Karabast server as a bot: enter the queue with a deck list, play the match it gets
 * through bot/karabast/seat.js, then leave (no requeue, no rematch). One game at a time.
 *
 *   node bot/karabast/queue.js --bot c-clock --decks bot/decks/ash-meta-2026-09.json --deck <name> [--games 1]
 *        [--server http://127.0.0.1:9500] [--allow-host <host>] [--username "swu-bot (bot)"]
 *        [--format premier] [--card-pool current] [--wait-minutes 10] [--chat "<line>"] [--out <dir>]
 *        [--ledger <file> --max-people 10] [--stop-file <file>] [--allow-undos 2] [--seed 1]
 *
 * Safety:
 * - Only localhost unless --allow-host names the server's host (socket.js).
 * - A non-local run needs --ledger: before each game the run stops if one more person would pass --max-people
 *   (ledger.js). The opponent is counted as soon as the match is made.
 * - It stops before the next game when --stop-file exists.
 * - The seat never sends undo, answers the opponent's undo requests by a fixed rule and concedes rather than time out
 *   when the bot keeps failing (seat.js).
 * - Decks with cards that are known to throw engine errors are refused, since Karabast logs each error and sends
 *   severe ones to its developers (KNOWN_ERRORS).
 *
 * Each game's frames as our seat saw them are saved scrubbed (frame.js makeScrubber) to <out>/frames/<hash>.jsonl,
 * for `node importer/import.js <out>/frames`, and a result line is appended to <out>/games.jsonl.
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

/** Refuses a deck holding a card from KNOWN_ERRORS. */
function checkDeck(deck) {
    const bad = [deck.leader, deck.base, ...(deck.deck ?? [])].map((c) => c?.id).filter((id) => Object.hasOwn(KNOWN_ERRORS, id));
    if (bad.length) {
        throw new Error(`deck ${deck.metadata?.name ?? '?'} holds ${bad.map((id) => `${KNOWN_ERRORS[id]} (${id})`).join(', ')}, which throws engine errors`);
    }
    return deck;
}

/**
 * Enters the queue and plays one match. onMatched(opponentId) runs when the opponent is known, before play starts;
 * it may throw to leave. Resolves to a result row.
 */
async function queueOnce({ server, user, deck, bot, format, cardPool, waitMs, chat, allowHosts, allowUndos, seed, out, onMatched, log }) {
    const opts = { allowHosts };
    const entered = await post(server, '/api/enter-queue', { user, format, cardPool, gamesToWinMode: 'bestOfOne', deck }, opts);
    if (!entered.body?.success) {
        throw new Error(`enter-queue refused: ${entered.body?.message ?? entered.status}`);
    }
    const sock = new KarabastSocket(server, { user, allowHosts });
    const client = loadClient(bot);
    const scrub = makeScrubber([user.id, user.username]);
    let fd = null;
    let file = null;
    const t0 = Date.now();
    try {
        // the socket must be listening before the match frames arrive
        const matched = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`no match within ${waitMs / 60000} minutes`)), waitMs);
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
            }
            if (fd) {
                fs.writeSync(fd, JSON.stringify(scrub(gs)) + '\n');
            }
        });
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
    for (let g = 0; g < games; g++) {
        if (stopFile && fs.existsSync(stopFile)) {
            log(`stop file ${stopFile} exists; stopping`);
            break;
        }
        if (ledger && !ledger.room(1)) {
            log(`people cap reached (${ledger.count} of ${ledger.max}); stopping`);
            break;
        }
        const row = await queueOnce({
            server, user, deck, bot: arg('bot', 'c-clock'), format: arg('format', 'premier'), cardPool: arg('card-pool', 'current'),
            waitMs: Number(arg('wait-minutes', 10)) * 60000, chat: arg('chat', null), allowHosts, allowUndos: Number(arg('allow-undos', 2)),
            seed: `${seed}-${g}`, out, log,
            onMatched: async (opponent) => {
                if (ledger) {
                    ledger.add([opponent], 'played');
                }
            }
        });
        console.log(JSON.stringify(row));
        if (out) {
            fs.appendFileSync(path.join(out, 'games.jsonl'), JSON.stringify(row) + '\n');
        }
        if (g + 1 < games) {
            await sleep(Number(arg('gap', 60)) * 1000);
        }
    }
}

if (require.main === module) {
    main().then(() => process.exit(0), (e) => {
        console.error(e.message);
        process.exit(1);
    });
}

module.exports = { queueOnce, checkDeck, KNOWN_ERRORS };
