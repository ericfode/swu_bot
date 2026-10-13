#!/usr/bin/env node
'use strict';
/**
 * Our bot's games against people on Karabast, as replays: every finished game under the queue runs' frame folders
 * (bot/karabast/queue.js --out) goes through the importer, the way live-view.js shows it.
 *
 *   node analysis/karabast/games.js --runs <folder of q-* runs> --out <dir>
 *
 * Writes <dir>/games/<run>_<game>.jsonl (the replay format; our seat named "<bot> (ours)", the other "opponent") and
 * <dir>/index.json (one row per game: run, result, rounds, our seat, both decks, how it ended). Frames are already
 * scrubbed; opponents' names live in a separate file that this script never reads.
 */
const fs = require('fs');
const path = require('path');
const { Games } = require('../../bot/karabast/live-view');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
}

/** The queue's row for each game file: `<run>/frames/<hash>` -> games.jsonl row. */
function queueRows(runs) {
    const rows = new Map();
    for (const run of fs.readdirSync(runs)) {
        const file = path.join(runs, run, 'games.jsonl');
        if (!fs.existsSync(file)) {
            continue;
        }
        for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
            const r = JSON.parse(line);
            if (r.file) {
                rows.set(`${run}/frames/${r.file.replace(/\.jsonl$/, '')}`, { ...r, run });
            }
        }
    }
    return rows;
}

function main() {
    const runs = arg('runs');
    const out = arg('out');
    if (!runs || !out) {
        throw new Error('usage: games.js --runs <folder of queue runs> --out <dir>');
    }
    // every game counts as finished: none of them is followed live here
    const games = new Games(runs, { now: () => Infinity });
    const rows = queueRows(runs);
    fs.mkdirSync(path.join(out, 'games'), { recursive: true });
    const index = [];
    for (const e of games.list()) {
        const row = rows.get(e.id);
        if (!row || !['win', 'loss'].includes(row.result)) {
            continue;
        }
        const game = games.get(e.id);
        if (!game) {
            continue;
        }
        const id = e.id.replace(/\//g, '_').replace('_frames_', '_');
        const events = game.events;
        const h = events[0];
        const end = events[events.length - 1];
        const ours = h.ours?.seat ?? h.source?.pov ?? null;
        fs.writeFileSync(path.join(out, 'games', `${id}.jsonl`), events.map((x) => JSON.stringify(x)).join('\n') + '\n');
        index.push({
            id, run: row.run, at: row.at, bot: row.bot, result: row.result, ours,
            decks: Object.fromEntries(h.players.map((p) => [p.id, p.deck])),
            round: end.round ?? row.round, minutes: row.minutes, how: end.how ?? null, winner: end.winner ?? null
        });
    }
    index.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify(index, null, 1) + '\n');
    console.log(`${index.length} games -> ${out}`);
}

if (require.main === module) {
    main();
}
