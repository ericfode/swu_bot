'use strict';

/**
 * Import human games captured on karabast.net into the replay format.
 *
 *   node importer/import.js <capture file|dir>... --out replays/human [--names "Alice,Bob"] [--source karabuddy]
 *
 * Every input file becomes <out>/games/<id>.jsonl (spec/replay-format.md: header, steps, end) and <out>/index.json
 * is rewritten in the tournament format, so the viewer, analysis/ and bot/omni/lens.js read the folder unchanged.
 * Inputs: see importer/sources.js (KaraBuddy replay files, Karabast gamestate lists, socket.io dumps, capture.js).
 * <id> is the input file name without its extension.
 *
 * Privacy: usernames, user ids and player chat are never written; seats are p1/p2 and names default to them.
 */

const fs = require('fs');
const path = require('path');
const { readText } = require('./sources');
const { convertFrames } = require('./karabast');

function parseArgs(argv) {
    const a = { inputs: [], out: path.join('replays', 'human'), names: null, source: null };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--out') {
            a.out = argv[++i];
        } else if (k === '--names') {
            a.names = argv[++i].split(',');
        } else if (k === '--source') {
            a.source = argv[++i];
        } else {
            a.inputs.push(k);
        }
    }
    return a;
}

function expand(inputs) {
    const files = [];
    for (const p of inputs) {
        if (fs.statSync(p).isDirectory()) {
            files.push(...fs.readdirSync(p).filter((f) => /\.(json|jsonl|txt|log)$/.test(f) && !/\.truth\.jsonl$/.test(f)).sort().map((f) => path.join(p, f)));
        } else {
            files.push(p);
        }
    }
    return files;
}

const gameId = (file) => path.basename(file).replace(/\.(json|jsonl|txt|log)$/, '').replace(/[^A-Za-z0-9_.-]+/g, '-');

function importFile(file, { names, source }) {
    const cap = readText(fs.readFileSync(file, 'utf8'));
    const seats = cap.meta.capture?.seats;
    const { events, report } = convertFrames(cap.frames, {
        seats, names: names ?? undefined,
        source: { kind: source ?? cap.meta.reader, file: path.basename(file), ...(cap.meta.url ? { url: cap.meta.url } : {}), ...(cap.meta.startedAt ? { startedAt: cap.meta.startedAt } : {}) }
    });
    return { id: gameId(file), events, report, reader: cap.meta.reader };
}

function indexEntry(id, events) {
    const h = events[0];
    const end = events[events.length - 1];
    const bot = (seat) => h.players.find((p) => p.id === seat).bot;
    return {
        id, seed: h.seed, p1: bot('p1'), p2: bot('p2'),
        winner: end.winner === 'draw' ? 'draw' : end.winner ? bot(end.winner) : null, winnerSeat: end.winner,
        rounds: end.round, steps: end.steps, outcome: end.outcome, error: end.error, ms: 0,
        human: true, pov: h.source.pov
    };
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const files = expand(args.inputs);
    if (!files.length) {
        console.error('usage: node importer/import.js <capture file|dir>... --out <dir> [--names A,B] [--source name]');
        process.exit(2);
    }
    fs.mkdirSync(path.join(args.out, 'games'), { recursive: true });
    const indexFile = path.join(args.out, 'index.json');
    const index = fs.existsSync(indexFile)
        ? JSON.parse(fs.readFileSync(indexFile, 'utf8'))
        : { id: path.basename(args.out), createdAt: new Date().toISOString(), engine: null, bots: [], gamesPerPairing: 1, games: [], human: true };
    for (const file of files) {
        try {
            const { id, events, report, reader } = importFile(file, args);
            fs.writeFileSync(path.join(args.out, 'games', `${id}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
            const entry = indexEntry(id, events);
            index.games = index.games.filter((g) => g.id !== id).concat(entry);
            for (const b of [entry.p1, entry.p2]) {
                if (!index.bots.includes(b)) {
                    index.bots.push(b);
                }
            }
            console.log(`${id}: ${reader}, ${report.frames} frames -> ${report.steps} steps, pov ${report.pov}, winner ${entry.winnerSeat ?? '-'}, ${report.messages} log lines${report.chatDropped ? `, ${report.chatDropped} chat lines dropped` : ''}`);
        } catch (e) {
            console.error(`${file}: ${e.message}`);
            process.exitCode = 1;
        }
    }
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n');
}

if (require.main === module) {
    main();
}

module.exports = { importFile, indexEntry, gameId };
