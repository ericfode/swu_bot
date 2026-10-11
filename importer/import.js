'use strict';

/**
 * Import human games captured on karabast.net into the replay format.
 *
 *   node importer/import.js <capture file|dir>... --out replays/human [--names "Alice,Bob"] [--source karabuddy] [--keep-file-names]
 *   node importer/import.js --pair <player 1's capture> <player 2's capture> --out replays/human
 *
 * --pair merges two captures of the same game, one recorded by each player, into one replay with both hands
 * (importer/merge.js). It can be given more than once.
 *
 * Every input file becomes <out>/games/<id>.jsonl (spec/replay-format.md: header, steps, end) and <out>/index.json
 * is rewritten in the tournament format, so the viewer, analysis/ and bot/omni/lens.js read the folder unchanged.
 * Inputs: see importer/sources.js (KaraBuddy replay files, Karabast gamestate lists, socket.io dumps, capture.js).
 * <id> is g-<hash> for a file and <hash>.both for a pair, the first 10 hex digits of the SHA-1 of the input bytes, so
 * file names (KaraBuddy names downloads after both players) are never written. --keep-file-names uses the file name
 * without its extension instead, and also writes source.file / source.pairedWith (for files you named yourself).
 *
 * Privacy: usernames, user ids and player chat are never written; seats are p1/p2 and names default to them.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readText } = require('./sources');
const { convertFrames } = require('./karabast');
const { mergeCaptures } = require('./merge');

function parseArgs(argv) {
    const a = { inputs: [], pairs: [], out: path.join('replays', 'human'), names: null, source: null, keepFileNames: false };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--out') {
            a.out = argv[++i];
        } else if (k === '--names') {
            a.names = argv[++i].split(',');
        } else if (k === '--source') {
            a.source = argv[++i];
        } else if (k === '--pair') {
            a.pairs.push([argv[++i], argv[++i]]);
        } else if (k === '--keep-file-names') {
            a.keepFileNames = true;
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
            files.push(...fs.readdirSync(p).filter((f) => /\.(json|jsonl|txt|log|karareplay)$/.test(f) && !/\.truth\.jsonl$/.test(f)).sort().map((f) => path.join(p, f)));
        } else {
            files.push(p);
        }
    }
    return files;
}

const contentHash = (...bufs) => bufs.reduce((h, b) => h.update(b), crypto.createHash('sha1')).digest('hex').slice(0, 10);
const nameId = (file) => path.basename(file, path.extname(file)).replace(/[^A-Za-z0-9_.-]+/g, '-');
const gameId = (file, bytes, keepFileNames) => (keepFileNames ? nameId(file) : `g-${contentHash(bytes)}`);

function importFile(file, { names, source, keepFileNames }) {
    const bytes = fs.readFileSync(file);
    const cap = readText(bytes.toString('utf8'));
    const seats = cap.meta.capture?.seats;
    const { events, report } = convertFrames(cap.frames, {
        seats, names: names ?? undefined, decks: cap.meta.decks,
        source: { kind: source ?? cap.meta.reader, ...(keepFileNames ? { file: path.basename(file) } : {}), ...(cap.meta.url ? { url: cap.meta.url } : {}), ...(cap.meta.startedAt ? { startedAt: cap.meta.startedAt } : {}) }
    });
    return { id: gameId(file, bytes, keepFileNames), events, report, reader: cap.meta.reader };
}

/** Two captures of one game, one from each player's seat, as one replay with both hands. */
function importPair(fileA, fileB, { names, source, keepFileNames }) {
    const bytesA = fs.readFileSync(fileA);
    const bytesB = fs.readFileSync(fileB);
    const a = readText(bytesA.toString('utf8'));
    const b = readText(bytesB.toString('utf8'));
    const m = mergeCaptures(a.frames, b.frames);
    // each player's file has their own full list; prefer it over the other file's leader-and-base entry
    const decks = { ...(b.meta.decks ?? {}), ...(a.meta.decks ?? {}) };
    for (const [id, d] of Object.entries(b.meta.decks ?? {})) {
        if (Array.isArray(d?.deck)) {
            decks[id] = d;
        }
    }
    const { events, report } = convertFrames(m.frames, {
        seats: a.meta.capture?.seats, names: names ?? undefined, decks,
        source: {
            kind: source ?? `${a.meta.reader}+${b.meta.reader}`, ...(keepFileNames ? { file: path.basename(fileA), pairedWith: path.basename(fileB) } : {}),
            merge: { frames: m.frames.length, matched: m.matched, unmatched: m.unmatched }
        }
    });
    report.merge = m;
    const id = keepFileNames ? `${nameId(fileA).replace(/\.(p1|p2)$/, '')}.both` : `${contentHash(bytesA, bytesB)}.both`;
    return { id, events, report, reader: `${a.meta.reader}+${b.meta.reader} (${m.matched}/${m.frames.length} frames paired)` };
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
    if (!files.length && !args.pairs.length) {
        console.error('usage: node importer/import.js <capture file|dir>... [--pair <p1 capture> <p2 capture>] --out <dir> [--names A,B] [--source name] [--keep-file-names]');
        process.exit(2);
    }
    fs.mkdirSync(path.join(args.out, 'games'), { recursive: true });
    const indexFile = path.join(args.out, 'index.json');
    const index = fs.existsSync(indexFile)
        ? JSON.parse(fs.readFileSync(indexFile, 'utf8'))
        : { id: path.basename(args.out), createdAt: new Date().toISOString(), engine: null, bots: [], gamesPerPairing: 1, games: [], human: true };
    const jobs = [...files.map((f) => ({ name: f, run: () => importFile(f, args) })), ...args.pairs.map(([x, y]) => ({ name: `${x} + ${y}`, run: () => importPair(x, y, args) }))];
    for (const job of jobs) {
        try {
            const { id, events, report, reader } = job.run();
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
            console.error(`${job.name}: ${e.message}`);
            process.exitCode = 1;
        }
    }
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n');
}

if (require.main === module) {
    main();
}

module.exports = { importFile, importPair, indexEntry, gameId };
