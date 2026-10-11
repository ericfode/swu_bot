'use strict';

// Join measurements by position identity, never by line number or winner labels alone.
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');

function readJsonl(file) {
    return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

function positionKey(row) {
    if (typeof row.game !== 'string' || !Number.isInteger(row.i)) {
        throw new Error('Every position needs a game string and integer i');
    }
    return JSON.stringify([row.game, row.i]);
}

function uniqueRows(rows) {
    const map = new Map();
    for (const row of rows) {
        const key = positionKey(row);
        if (map.has(key)) throw new Error(`Duplicate position ${key}`);
        map.set(key, row);
    }
    return map;
}

function horizon(rows, field = 'result') {
    const games = new Map();
    for (const row of rows) {
        const current = games.get(row.game) ?? 0;
        const distance = row[field] === 'p1' || row[field] === 'p2' ? row.fromEnd : 0;
        if (!Number.isFinite(distance) || distance < 0) throw new Error('Missing or invalid fromEnd');
        games.set(row.game, Math.max(current, distance));
    }
    const values = [...games.values()];
    return { games: values.length, mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
        max: values.length ? Math.max(...values) : null, perGame: Object.fromEntries(games) };
}

function compare(positions, rustResults) {
    const pos = uniqueRows(positions);
    const rust = uniqueRows(rustResults);
    const agreements = [], disagreements = [], missing = [];
    for (const [key, p] of pos) {
        const r = rust.get(key);
        if (!r) { missing.push({ game: p.game, i: p.i }); continue; }
        if (p.proven && r.result) {
            const row = { game: p.game, i: p.i, fromEnd: p.fromEnd, js: p.proven, rust: r.result };
            (p.proven === r.result ? agreements : disagreements).push(row);
        }
    }
    for (const key of rust.keys()) if (!pos.has(key)) throw new Error(`Rust result has no input position: ${key}`);
    const enriched = rustResults.map((r) => ({ ...pos.get(positionKey(r)), ...r }));
    const jsNodes = positions.reduce((n, p) => n + (p.jsNodes ?? 0), 0);
    const jsMs = positions.reduce((n, p) => n + (p.jsMs ?? 0), 0);
    return { horizon: { js: horizon(positions, 'proven'), rust: horizon(enriched) },
        speed: { jsNodes, jsMs, jsMsPerNode: jsNodes ? jsMs / jsNodes : null },
        agreement: { bothProved: agreements.length + disagreements.length, agreements, disagreements, missing } };
}

function prepare(solveDir, positions) {
    const solves = new Map();
    for (const file of fs.readdirSync(solveDir).filter((f) => f.endsWith('.json'))) {
        const game = path.basename(file, '.json');
        const g = JSON.parse(fs.readFileSync(path.join(solveDir, file), 'utf8'));
        for (const s of g.solves ?? []) solves.set(positionKey({ game, i: s.i }), s);
    }
    return positions.filter((p) => solves.has(positionKey(p))).map((p) => {
        const s = solves.get(positionKey(p));
        if (!Number.isFinite(s.ms) || s.ms < 0) throw new Error('Invalid measured JS wall-clock budget');
        return { ...p, jsMs: s.ms, jsNodes: s.nodes, jsComplete: s.complete, proven: s.result, proofDepth: s.depth };
    });
}

function coverage(poolFile, traceDir) {
    const bytes = fs.readFileSync(poolFile);
    const pool = JSON.parse(bytes);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const cards = new Map(pool.cards.map((c) => [c.setCode, { setCode: c.setCode, name: c.internalName,
        types: c.types, played: 0, attacked: 0, defeated: 0, deployed: 0, attached: 0, gamesPresent: 0 }]));
    let games = 0, decisions = 0, windows = 0;
    const pairings = {}, winners = {}, sources = [];
    const eventFields = { onCardPlayed: 'played', onAttackDeclared: 'attacked', onCardDefeated: 'defeated', onLeaderDeployed: 'deployed', onUpgradeAttached: 'attached' };
    for (const file of fs.readdirSync(traceDir).filter((f) => /\.jsonl(?:\.gz)?$/.test(f)).sort()) {
        const raw = fs.readFileSync(path.join(traceDir, file));
        const text = (file.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8');
        const records = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
        const meta = records[0], result = records.at(-1);
        if (meta.type !== 'meta' || result.type !== 'result') throw new Error(`Incomplete trace ${file}`);
        if (meta.pool.hash !== hash && meta.pool.sha256 !== hash) throw new Error(`Pool hash mismatch: ${file}`);
        const present = new Set();
        for (const row of records) {
            if (row.type === 'state') windows++;
            if (row.type === 'decision') {
                decisions++;
                if (!Array.isArray(row.events)) throw new Error(`Trace has no coverage events: ${file}:${row.step}`);
                for (const event of row.events) {
                    const code = event.card.s || (event.card.n === 'Shield' ? 'TOKEN_SHIELD' : null);
                    const card = cards.get(code);
                    if (!card) throw new Error(`Event card outside pool: ${JSON.stringify(event.card)}`);
                    const field = eventFields[event.name];
                    if (field) card[field]++;
                    present.add(code);
                }
            }
            if (row.state) {
                for (const p of Object.values(row.state.players)) {
                    for (const c of [p.base, p.leader, ...p.hand, ...p.deck, ...p.resources, ...p.discard, ...p.ground, ...p.space]) {
                        if (!cards.has(c.setCode)) throw new Error(`State card outside pool: ${c.setCode}`);
                        present.add(c.setCode);
                        for (const u of c.upgrades ?? []) present.add(u.setCode);
                    }
                }
            }
        }
        for (const code of present) cards.get(code).gamesPresent++;
        games++;
        const pair = meta.bots.join(',');
        pairings[pair] = (pairings[pair] ?? 0) + 1;
        winners[result.winner] = (winners[result.winner] ?? 0) + 1;
        sources.push({ file, sha256: crypto.createHash('sha256').update(raw).digest('hex') });
    }
    const rows = [...cards.values()];
    return { schema: 'omni-rs-coverage/1', poolHash: hash, games, decisions, windows, pairings, winners,
        cards: rows, neverPresent: rows.filter((c) => !c.gamesPresent).map((c) => c.setCode),
        unitsNeverPlayed: rows.filter((c) => c.types.includes('unit') && !c.played).map((c) => c.setCode),
        unitsNeverAttacked: rows.filter((c) => c.types.includes('unit') && !c.attacked).map((c) => c.setCode),
        unitsNeverDefeated: rows.filter((c) => c.types.includes('unit') && !c.defeated).map((c) => c.setCode),
        sources };
}

function main(args) {
    if (args[0] === 'prepare' && args.length === 4) {
        const rows = prepare(args[1], readJsonl(args[2]));
        fs.writeFileSync(args[3], rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
        console.log(`Wrote ${rows.length} matched positions with measured JS time budgets`);
    } else if (args[0] === 'compare' && args.length === 4) {
        const report = { schema: 'omni-rs-measurements/1', measuredAt: new Date().toISOString(),
            machine: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length },
            ...compare(readJsonl(args[1]), readJsonl(args[2])) };
        fs.writeFileSync(args[3], JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify(report.horizon));
    } else if (args[0] === 'coverage' && args.length === 4) {
        const report = coverage(args[1], args[2]);
        fs.writeFileSync(args[3], JSON.stringify(report, null, 2) + '\n');
        console.log(`${report.games} games, ${report.decisions} decisions, ${report.cards.length} cards`);
    } else {
        throw new Error('Usage: node tools/omni-rs-report.js prepare <solve-dir> <positions.jsonl> <matched.jsonl> | compare <matched.jsonl> <rust-results.jsonl> <summary.json> | coverage <pool.json> <trace-dir> <coverage.json>');
    }
}

if (require.main === module) {
    try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { positionKey, horizon, compare, prepare, coverage };
