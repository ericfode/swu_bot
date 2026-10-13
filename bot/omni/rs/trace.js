'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Env, seededRng } = require('../../env');
const { makeBot } = require('../../players');
const { loadPool } = require('./pool');
const { fullState, canonicalAction, expandActions } = require('./state');
const { placedRef } = require('../../view');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const seedList = (spec) => spec.split(',').flatMap((part) => { const [a, b] = part.split('-').map(Number); return b === undefined ? [a] : Array.from({ length: b - a + 1 }, (_, i) => a + i); });

async function traceGame(env, pool, seed, names, maxSteps = 6000) {
    const rng = seededRng('bot' + seed);
    const decks = [env.randomDeck(rng, { pool }), env.randomDeck(rng, { pool })];
    const bots = names.map(makeBot);
    const eg = env.newGame({ selectionToggles: true, seed, deck1: decks[0], deck2: decks[1], undo: bots.some((b) => b.needsUndo) });
    let events = null;
    for (const name of ['onCardPlayed', 'onAttackDeclared', 'onCardDefeated', 'onLeaderDeployed', 'onUpgradeAttached', 'onDamageDealt', 'onDamageHealed', 'onCardReadied', 'onCardExhausted', 'onCardsDrawn']) {
        eg.game.on(name, (event) => {
            if (!events || event.isCancelledOrReplaced) return;
            const c = name === 'onAttackDeclared' ? event.attack.attacker : event.card;
            const receipt = { name };
            if (c) receipt.card = placedRef(eg, c);
            if (event.context?.source?.isCard?.()) receipt.source = placedRef(eg, event.context.source);
            if (event.player) receipt.player = eg.seatOf(event.player.id);
            for (const field of ['amount', 'damageDealt', 'damageHealed']) if (typeof event[field] === 'number') receipt[field] = event[field];
            events.push(receipt);
        });
    }
    const records = [{ type: 'meta', schema: 'omni-rs-trace-v1', pool: pool.provenance, seed, bots: names, decks }];
    let started = false;
    let step = 0;
    try {
        await eg.start();
        while (!eg.over && step < maxSteps) {
            const order = rng() < 0.5 ? eg.ids : [...eg.ids].reverse();
            const pid = order.find((id) => eg.legalActions(id).length);
            if (!pid) throw new Error(`No actor at step ${step}`);
            const raw = eg.legalActions(pid);
            let actions = expandActions(eg, raw);
            const atWindow = eg.isActionWindow(pid);
            started ||= atWindow;
            const before = started && atWindow ? fullState(eg, pid) : null;
            if (before) records.push({ type: 'state', step, state: before });
            const picked = bots[eg.ids.indexOf(pid)].choose({ game: eg, pid, actions, rng });
            const key = canonicalAction(eg, picked).key;
            actions = expandActions(eg, eg.legalActions(pid));
            const a = actions.find((candidate) => canonicalAction(eg, candidate).key === key);
            if (!a) throw new Error(`Bot ${names[eg.ids.indexOf(pid)]} returned an unknown action: ${key}`);
            if (before && JSON.stringify(before) !== JSON.stringify(fullState(eg, pid))) throw new Error(`Bot lookahead changed the live full state at step ${step}`);
            let decision = null;
            if (started) {
                const p = eg.player(pid).currentPrompt();
                decision = { type: 'decision', step, actor: eg.seatOf(pid), prompt: { type: p.promptType ?? null, title: p.menuTitle ?? null, selected: (eg.player(pid).promptState.selectedCards ?? []).map((c) => eg.cardId(c.uuid)), actionWindow: atWindow }, actions: actions.map((a) => canonicalAction(eg, a)), chosen: canonicalAction(eg, a).key, events: [] };
                records.push(decision);
            }
            events = decision?.events ?? null;
            eg.apply(pid, a, rng);
            events = null;
            step++;
        }
        if (!eg.over) throw new Error(`Step cap ${maxSteps} reached`);
        records.push({ type: 'result', step, winner: eg.winner, state: fullState(eg) });
        return records;
    } finally { for (const b of bots) b.close?.(); }
}
async function main() {
    const names = arg('bots', 'random,random').split(',');
    if (names.length !== 2) throw new Error('--bots needs exactly two names');
    const seeds = seedList(arg('seeds', '1-3'));
    const pool = loadPool(arg('pool', path.join(__dirname, 'pool.json')));
    const out = path.resolve(arg('out', 'replays/omni-rs'));
    fs.mkdirSync(out, { recursive: true });
    const env = new Env();
    let errors = 0;
    for (const seed of seeds) {
        const file = path.join(out, `${names.join('-vs-')}-${seed}.jsonl${process.argv.includes('--gzip') ? '.gz' : ''}`);
        try {
            const records = await traceGame(env, pool, seed, names, Number(arg('max-steps', 6000)));
            const jsonl = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
            fs.writeFileSync(file, file.endsWith('.gz') ? zlib.gzipSync(jsonl) : jsonl);
            console.log(`${path.basename(file)}: ${records.filter((r) => r.type === 'decision').length} decisions, winner ${records.at(-1).winner}`);
        } catch (e) {
            errors++;
            const error = { seed, bots: names, pool: pool.provenance, error: e.stack || String(e) };
            fs.writeFileSync(file + '.error.json', JSON.stringify(error, null, 2) + '\n');
            console.error(`seed ${seed}: ${e.message}`);
        }
    }
    if (errors) process.exitCode = 1;
}
if (require.main === module) main().catch((e) => { console.error(e); process.exitCode = 1; });
module.exports = { traceGame, seedList };
