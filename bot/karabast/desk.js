'use strict';
/**
 * The Karabast desk (Eric, 2026-10-14: "make it its own thing just make the management interface accessible to me and
 * who ever I share a link with hosted from its sprite"): the two files through which Eric's own live view
 * (live-view.js --manage) steers the lobby loop (queue.js --desk), and the record that every view shows.
 *
 *   <dir>/bot    the bots for the next games: one name, or several separated by commas that take turns game by game.
 *                queue.js reads it before each game and uses it only when every name is one it allows (--allow-bots).
 *   <dir>/PAUSE  while it exists, queue.js waits between games instead of queueing again (state "paused").
 *
 * The web server only writes these two files; it never starts or stops a process. A change takes effect between
 * games, so no game is cut short.
 */
const fs = require('fs');
const path = require('path');

const NAME = /^[a-z0-9][\w.#-]{0,39}$/i;
/** At most this many bots take turns. */
const MAX_BOTS = 4;
/** Days the record keeps day by day. */
const DAYS = 30;

const parseBots = (text) => String(text).split(',').map((s) => s.trim()).filter(Boolean);

/** Whether `names` is a choice the loop takes: 1 to MAX_BOTS different names, each one in `allowed`. */
function checkChoice(names, allowed) {
    return Array.isArray(names) && names.length >= 1 && names.length <= MAX_BOTS && new Set(names).size === names.length
        && names.every((n) => typeof n === 'string' && NAME.test(n) && allowed.includes(n));
}

/** The bots picked at the desk, or null when there is no pick or it names a bot that is not allowed. */
function readChoice(dir, allowed) {
    let text;
    try {
        text = fs.readFileSync(path.join(dir, 'bot'), 'utf8');
    } catch {
        return null;
    }
    const names = parseBots(text);
    return checkChoice(names, allowed) ? names : null;
}

/** Writes the pick in one rename, so the loop never reads half of it. Throws on a choice the loop would not take. */
function writeChoice(dir, names, allowed) {
    if (!checkChoice(names, allowed)) {
        throw new Error(`pick 1 to ${MAX_BOTS} different bots from: ${allowed.join(', ')}`);
    }
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'bot');
    fs.writeFileSync(`${file}.tmp`, names.join(',') + '\n');
    fs.renameSync(`${file}.tmp`, file);
}

const isPaused = (dir) => fs.existsSync(path.join(dir, 'PAUSE'));

function setPaused(dir, on) {
    const file = path.join(dir, 'PAUSE');
    if (on) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, new Date().toISOString() + '\n');
    } else {
        fs.rmSync(file, { force: true });
    }
}

const PLAYED = { win: 1, loss: 0, draw: 0 };

/**
 * The record from games.jsonl rows (queue.js), oldest first or not: each bot's games and wins with its first and
 * last game, and the last DAYS UTC days, each with its games, wins and the bot that played most of them. Only played
 * games count (a failed game or a wait with no match does not). It reads only `at`, `bot` and `result`.
 */
function summarize(rows) {
    const played = rows.filter((r) => r && Object.hasOwn(PLAYED, r.result) && typeof r.bot === 'string' && !Number.isNaN(Date.parse(r.at)))
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const bots = new Map();
    const days = new Map();
    for (const r of played) {
        const won = PLAYED[r.result];
        const b = bots.get(r.bot) ?? { bot: r.bot, games: 0, won: 0, first: r.at, last: r.at };
        b.games++;
        b.won += won;
        b.last = r.at;
        bots.set(r.bot, b);
        const day = new Date(r.at).toISOString().slice(0, 10);
        const d = days.get(day) ?? { day, games: 0, won: 0, by: {} };
        d.games++;
        d.won += won;
        d.by[r.bot] = (d.by[r.bot] ?? 0) + 1;
        days.set(day, d);
    }
    const lastDays = [...days.values()].slice(-DAYS).map(({ by, ...d }) => ({ ...d, bot: Object.entries(by).sort((a, b) => b[1] - a[1])[0][0] }));
    return {
        games: played.length,
        won: played.reduce((n, r) => n + PLAYED[r.result], 0),
        bots: [...bots.values()].sort((a, b) => Date.parse(b.last) - Date.parse(a.last)),
        days: lastDays
    };
}

module.exports = { checkChoice, readChoice, writeChoice, isPaused, setPaused, summarize, parseBots, MAX_BOTS, DAYS };
