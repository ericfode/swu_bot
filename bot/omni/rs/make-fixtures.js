'use strict';

/** Real-engine fixtures for rules the in-aspect random dealer cannot cover reliably. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Env, seededRng } = require('../../env');
const { makeBot } = require('../../players');
const { loadPool } = require('./pool');
const { traceGame } = require('./trace');
const { fullState, canonicalAction, expandActions } = require('./state');

function keywordDeck(pool) {
    const priorities = ['HMW_055', 'HMW_254', 'HMW_175', 'ASH_192', 'ASH_193', 'ASH_048', 'HMW_213', 'ASH_256'];
    const units = priorities.map((code) => pool.cards.find((c) => c.setCode === code));
    for (const c of pool.cards.filter((c) => c.types.includes('unit') && c.cost <= 3)) {
        if (!units.includes(c) && units.length < 17) units.push(c);
    }
    if (units.length !== 17 || units.some((c) => !c)) throw new Error('Target fixture cards missing');
    return {
        metadata: { name: 'Targeted legal duplicate-unique and keyword interactions', author: 'omni-rs fixture' },
        leader: { id: 'IBH_053', count: 1 },
        base: { id: pool.cards.find((c) => c.types.includes('base') && c.aspects[0] === 'cunning').setCode, count: 1 },
        deck: units.map((c, i) => ({ id: c.setCode, count: i === 16 ? 2 : 3 })),
        isPresentInDb: false
    };
}

function save(dir, name, records) {
    const file = path.join(dir, `${name}.jsonl.gz`);
    fs.writeFileSync(file, zlib.gzipSync(records.map((r) => JSON.stringify(r)).join('\n') + '\n'));
    console.log(`${file}: ${records.filter((r) => r.type === 'decision').length} decisions, ${fs.statSync(file).size} bytes`);
}

async function dualLethal(env, pool, deck) {
    const seed = 2001;
    const rng = seededRng('bot' + seed);
    const bots = [makeBot('random'), makeBot('random')];
    const eg = env.newGame({ seed, deck1: deck, deck2: deck });
    await eg.start();
    let step = 0;
    try {
        for (; step < 3000 && !eg.over; step++) {
            const order = rng() < 0.5 ? eg.ids : [...eg.ids].reverse();
            const pid = order.find((id) => eg.legalActions(id).length);
            if (!pid) throw new Error('Fixture game stopped without a choice');
            const player = eg.player(pid);
            const leader = player.getAllDeckLeaders()[0];
            const opponent = player.opponent;
            const sentinel = opponent.getCardsInZone('groundArena').some((c) => c.isUnit() && c.getSummary(opponent, true).sentinel);
            if (eg.isActionWindow(pid) && leader.deployed && !leader.exhausted && !sentinel) {
                // Construct a valid late-game starting position. All following choices
                // and transitions run through the unmodified authoritative engine.
                player.base.damage = 28;
                opponent.base.damage = 29;
                const records = [{ type: 'meta', schema: 'omni-rs-trace-v1', pool: pool.provenance, seed,
                    bots: ['scripted-fixture', 'scripted-fixture'], decks: [deck, deck],
                    fixtureConstruction: 'Naturally reached ready deployed Vader window; set initial attacking base damage to 28 and defending base damage to 29. Vader targets enemy base, then chooses own base for his lethal On Attack trigger. Combat still resolves, but the first declared winner remains.' }];
                records.push({ type: 'state', step, state: fullState(eg, pid) });
                for (const target of [leader, opponent.base, player.base]) {
                    const actions = expandActions(eg, eg.legalActions(pid));
                    const action = actions.find((a) => a.cardUuid === target.uuid);
                    if (!action) throw new Error(`Targeted lethal fixture missing ${target.internalName}`);
                    const prompt = player.currentPrompt();
                    records.push({ type: 'decision', step, actor: eg.seatOf(pid), prompt: {
                        type: prompt.promptType ?? null, title: prompt.menuTitle ?? null,
                        selected: (player.promptState.selectedCards ?? []).map((c) => eg.cardId(c.uuid)), actionWindow: eg.isActionWindow(pid)
                    }, actions: actions.map((a) => canonicalAction(eg, a)), chosen: canonicalAction(eg, action).key, events: [] });
                    eg.apply(pid, action, rng);
                    step++;
                }
                if (!eg.over || eg.winner !== eg.seatOf(opponent.id) || player.base.damage !== 30 || opponent.base.damage !== 30) {
                    throw new Error('Engine lethal-trigger semantics changed; inspect fixture');
                }
                records.push({ type: 'result', step, winner: eg.winner, state: fullState(eg) });
                return records;
            }
            const actions = expandActions(eg, eg.legalActions(pid));
            eg.apply(pid, bots[eg.ids.indexOf(pid)].choose({ game: eg, pid, actions, rng }), rng);
        }
        throw new Error('Could not reach a ready deployed Vader window');
    } finally { for (const bot of bots) bot.close?.(); }
}

async function main() {
    const dir = process.argv[2] || path.resolve(__dirname, '../../omni-rs/tests/fixtures');
    fs.mkdirSync(dir, { recursive: true });
    const pool = loadPool(path.join(__dirname, 'pool.json'));
    const env = new Env();
    const deck = keywordDeck(pool);
    env.randomDeck = () => structuredClone(deck);
    const records = await traceGame(env, pool, 2001, ['random', 'random']);
    const decisions = records.filter((r) => r.type === 'decision');
    if (!decisions.some((r) => /Choose which copy/.test(r.prompt.title ?? '')) ||
        !decisions.some((r) => r.actions.some((a) => a.label === 'Ambush') && r.actions.some((a) => a.label === 'Shielded'))) {
        throw new Error('Targeted keyword fixture lost required coverage');
    }
    records[0].fixtureConstruction = 'Ordinary seeded game using the metadata decks with legal three-copy unique cards and off-aspect cards whose penalties are paid normally.';
    save(dir, 'keywords-and-unique-2001', records);
    const alternate = await traceGame(env, pool, 2012, ['random', 'random']);
    alternate[0].fixtureConstruction = 'Ordinary seeded legal-deck game: choosing the older unique copy to defeat, and Mae dying during Ambush before Shielded resolves.';
    save(dir, 'keywords-and-unique-2012', alternate);
    save(dir, 'vader-dual-lethal-2001', await dualLethal(env, pool, deck));
}
if (require.main === module) main().catch((e) => { console.error(e); process.exitCode = 1; });
module.exports = { keywordDeck, dualLethal };
