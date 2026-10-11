'use strict';
// Explicit starting positions; every recorded action is a normal engine input.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { Env, seededRng } = require('../../env');
const { makeBot } = require('../../players');
const { loadPool } = require('./pool');
const { fullState, canonicalAction, expandActions } = require('./state');
const scenarios = [
    { name: 'zero-power-from-pain', plan: [['JTL_042', 'own']], required: 'zero' },
    { name: 'stack-and-negative-power', plan: [['TWI_124', 'own'], ['TWI_124', 'own'], ['SOR_216', 'enemy']], required: 'stack' },
    { name: 'expiry-lethal', plan: [['TWI_124', 'own'], ['TWI_174', 'own'], ['TWI_170', 'own']], required: 'expiry' },
    { name: 'bounce-cleanup', plan: [['TWI_124', 'own'], ['TWI_226', 'own']], required: 'bounce' },
    { name: 'defeat-cleanup', plan: [['SOR_216', 'enemy'], ['TWI_174', 'enemy'], ['TWI_170', 'enemy']], required: 'defeat' },
    { name: 'negative-hp', plan: [['LAW_131', 'enemy']], required: 'negativeHp' },
    { name: 'leader-expiry-cleanup', leader: true, plan: [['TWI_124', 'leader'], ['TWI_174', 'leader'], ['TWI_170', 'leader']], required: 'leaderExpiry' },
    { name: 'optional-decline', decline: true, plan: [['SEC_206', 'own']], required: 'decline' },
    { name: 'bounce-attached-token', plan: [['SOR_073', 'own'], ['TWI_124', 'own'], ['TWI_226', 'own']], required: 'tokenBounce' },
    { name: 'discard-unit-not-event', discard: true, plan: [['SOR_101', 'retrieved']], required: 'retrieve' },
    { name: 'conditional-no-action', plan: [['IBH_031', 'own']], required: 'noAction' },
    { name: 'conditional-ready', unequalBases: true, plan: [['IBH_031', 'own']], required: 'conditionalReady' },
];
function fixtureDeck(pool, scenario = {}) {
    const codes = [...new Set(['JTL_042', 'TWI_124', 'SOR_216', 'TWI_174', 'TWI_170', 'TWI_226', 'ASH_261', 'ASH_061', 'LAW_131', 'SEC_206', 'SOR_073', 'SOR_101', 'ASH_190', 'IBH_031', ...(scenario.extraCodes ?? [])])];
    assert.ok(codes.length <= 17, 'Fixture deck exceeds seventeen playsets');
    for (const code of [...codes, scenario.leaderCode ?? 'SOR_014', scenario.baseCode ?? 'SOR_023']) assert.ok(pool.cards.some((c) => c.setCode === code), `Missing admitted fixture card ${code}`);
    const filler = pool.cards.filter((c) => c.types.includes('unit') && !c.text && !codes.includes(c.setCode)).slice(0, 17 - codes.length).map((c) => c.setCode);
    assert.equal(filler.length, 17 - codes.length);
    return { metadata: { name: 'Phase stat semantics', author: 'omni-rs fixture' }, leader: { id: scenario.leaderCode ?? 'SOR_014', count: 1 },
        base: { id: scenario.baseCode ?? 'SOR_023', count: 1 }, deck: [...codes, ...filler].map((id, i) => ({ id, count: i === 16 ? 2 : 3 })), isPresentInDb: false };
}
async function fixture(env, pool, scenario, seed) {
    const deck = fixtureDeck(pool, scenario), eg = env.newGame({ seed, deck1: deck, deck2: deck });
    const rng = seededRng('phase-fixture-' + seed), bot = makeBot('random');
    await eg.start();
    while (!eg.ids.some((pid) => eg.isActionWindow(pid))) {
        const pid = eg.ids.find((id) => eg.legalActions(id).length), actions = expandActions(eg, eg.legalActions(pid));
        eg.apply(pid, bot.choose({ game: eg, pid, actions, rng }), rng);
    }
    const own = eg.player(eg.ids[0]), enemy = eg.player(eg.ids[1]);
    const all = (p) => [...p.drawDeck, ...p.getCardsInZone('hand'), ...p.getCardsInZone('resource')];
    const matches = (c, code) => [c.cardData.setId, ...(c.cardData.setCodes ?? [])].some((s) => s.set + '_' + String(s.number).padStart(3, '0') === code);
    const take = (p, code) => { const c = all(p).find((c) => matches(c, code)); assert.ok(c, `No ${code}`); return c; };
    const targets = { own: take(own, scenario.ownCode ?? (scenario.required === 'expiry' ? 'ASH_061' : 'ASH_261')), enemy: take(enemy, scenario.enemyCode ?? 'ASH_061') };
    for (const [name, c] of Object.entries(targets)) { if (name === 'enemy' && scenario.noEnemyUnits) continue; c.moveTo('groundArena'); c.exhausted = false; }
    targets.enemyBase = enemy.base;
    if (scenario.leader) { targets.leader = own.getAllDeckLeaders()[0]; targets.leader.deploy({ type: 'leaderUnit' }); targets.leader.deployEpicActionLimit.increment(own); targets.leader.exhausted = false; }
    if (scenario.constant) {
        const p = scenario.constant.owner === 'enemy' ? enemy : own;
        targets.constant = take(p, scenario.constant.code);
        targets.constant.moveTo(scenario.constantInHand ? 'hand' : targets.constant.cardData.arena === 'space' ? 'spaceArena' : 'groundArena');
        if (!scenario.constantInHand) targets.constant.exhausted = false;
    }
    for (const code of scenario.extraOwnUnits ?? []) {
        const c = take(own, code); c.moveTo(c.cardData.arena === 'space' ? 'spaceArena' : 'groundArena'); c.exhausted = false;
    }
    if (scenario.discard) {
        targets.retrieved = take(own, 'ASH_190'); targets.wrongType = take(own, 'TWI_170');
        targets.retrieved.moveTo('discard'); targets.wrongType.moveTo('discard');
    }
    for (const [code] of scenario.plan) if (code !== scenario.leaderCode) take(own, code).moveTo('hand');
    if (scenario.exhaustedOwn) targets.own.exhausted = true;
    // Resource cards are real deck cards; no inserted card instances or synthetic abilities.
    for (const p of [own, enemy]) {
        for (const c of p.drawDeck.slice(0, 12)) { c.moveTo('resource'); c.exhausted = false; }
        for (const c of p.getCardsInZone('resource')) c.exhausted = false;
        p.base.damage = scenario.unequalBases && p === own ? 25 : Math.min(24, p.base.cardData.hp - 6);
        if (scenario.terminalBase && p === enemy) p.base.damage = p.base.cardData.hp - 1;
    }
    eg.game.resolveGameState(true);
    if (scenario.initialOwnDamage) targets.own.damage = scenario.initialOwnDamage;
    if (scenario.initialConstantDamage) targets.constant.damage = scenario.initialConstantDamage;
    eg.game.continue(); // Refresh the engine's legal-card cache after the disclosed starting-position construction.
    const initialRound = eg.round;
    let enemyScriptPlayed = false;
    const records = [{ type: 'meta', schema: 'omni-rs-trace-v1', pool: pool.provenance, seed, bots: ['scripted-phase-fixture', 'scripted-phase-fixture'], decks: [deck, deck],
        fixtureConstruction: 'At first natural action window, move listed real deck units into ground arenas ready (missing-target scenario leaves enemy unit in its original zone), listed event copies into p1 hand, twelve remaining deck cards per player into ready resources, and set base damage tomin(24,printedHP-6) (conditional-ready uses p1 damage25; terminal-base uses p2 printedHP-1). Leader scenario starts p1 leader deployed ready with its epic action spent. Discard scenario puts ASH190 unit and TWI170 event into p1 discard. Optional constant source, extra own units and initial damage are specified in constructionParameters. No later state edits; recorded transitions use normal engine inputs.', constructionParameters: { constant: scenario.constant ?? null, constantInHand: !!scenario.constantInHand, enemyWaitForOwnPhase: !!scenario.enemyWaitForOwnPhase, initialOwnDamage: scenario.initialOwnDamage ?? 0, initialConstantDamage: scenario.initialConstantDamage ?? 0, extraOwnUnits: scenario.extraOwnUnits ?? [], ownCode: scenario.ownCode ?? null, enemyCode: scenario.enemyCode ?? null, noEnemyUnits: !!scenario.noEnemyUnits, terminalBase: !!scenario.terminalBase }, scenario: scenario.name }];
    let step = 0, index = 0, pending = null, pendingMode = null;
    const playedCodes = new Set();
    eg.game.on('onCardPlayed', (event) => {
        if (event.isCancelledOrReplaced || !event.card) return;
        for (const code of pool.cards.filter((c) => c.internalName === event.card.internalName).map((c) => c.setCode)) playedCodes.add(code);
    });
    const witness = { scenario: scenario.name, transitions: [], positivePower: false, positiveHp: false, negativePower: false, negativeHp: false, stacked: false, zeroPlayed: false, expired: false, expiryLethal: false, bounced: false, defeated: false, leaderExpired: false, declined: false, tokenAttached: false, tokenBounced: false, retrievedUnit: false, excludedEvent: false, noAction: false, conditionalReady: false, constantInitial: false, constantAfter: false, constantLater: false };
    let scriptedResolved = false, expirySurvivor = false, attachedToken = null;
    witness.uniqueWindows = [];
    try {
        while (!eg.over && step < 4000) {
            const pid = eg.ids.find((id) => eg.legalActions(id).length), atWindow = eg.isActionWindow(pid);
            const actions = expandActions(eg, eg.legalActions(pid));
            const state = atWindow ? fullState(eg, pid) : null;
            if (state) {
                records.push({ type: 'state', step, state });
                if (scenario.observeInitial && eg.round === initialRound) witness.constantInitial ||= scenario.observeInitial({ eg, own, enemy, targets, state });
                for (const p of Object.values(state.players)) for (const unit of [...p.ground, ...p.space]) {
                    const stats = unit.phaseStats;
                    if (stats && eg.round === initialRound) { witness.positivePower ||= stats.power > 0; witness.positiveHp ||= stats.hp > 0; witness.negativePower ||= stats.power < 0; witness.negativeHp ||= stats.hp < 0; witness.stacked ||= stats.power >= 4 && stats.hp >= 4; }
                }
                witness.expired ||= eg.round > initialRound && ![...state.players.p1.ground, ...state.players.p2.ground].some((c) => c.phaseStats);
                if (scenario.observeLater && eg.round > initialRound) witness.constantLater ||= scenario.observeLater({ eg, own, enemy, targets, state });
                if (scenario.required === 'tokenBounce' && eg.round === initialRound && targets.own.zoneName === 'groundArena') {
                    attachedToken ??= targets.own.upgrades.find((c) => c.internalName === 'shield');
                    witness.tokenAttached ||= !!attachedToken;
                }
                if (index === scenario.plan.length && eg.round === initialRound) {
                    scriptedResolved = true;
                    witness.zeroPlayed ||= scenario.required === 'zero' && targets.own.damage === 0 && !phaseStatsFor(targets.own) && own.getCardsInZone('discard').some((c) => c.internalName === 'power-from-pain');
                    witness.bounced ||= scenario.required === 'bounce' && targets.own.zoneName === 'hand' && !phaseStatsFor(targets.own);
                    witness.defeated ||= scenario.required === 'defeat' && targets.enemy.zoneName === 'discard';
                    witness.tokenBounced ||= scenario.required === 'tokenBounce' && witness.tokenAttached && targets.own.zoneName === 'hand' && attachedToken.zoneName === 'outsideTheGame' && !phaseStatsFor(targets.own);
                    witness.retrievedUnit ||= scenario.required === 'retrieve' && targets.retrieved.zoneName === 'hand' && targets.wrongType.zoneName === 'discard';
                    const falcon = own.getCardsInZone('spaceArena').find((c) => matches(c, 'IBH_031'));
                    witness.noAction ||= scenario.required === 'noAction' && !!falcon?.exhausted;
                    witness.conditionalReady ||= scenario.required === 'conditionalReady' && falcon?.exhausted === false;
                    if (scenario.observeAfter) witness.constantAfter ||= scenario.observeAfter({ eg, own, enemy, targets, state });
                    const expiryTarget = scenario.leader ? targets.leader : targets.own;
                    expirySurvivor ||= ['expiry', 'leaderExpiry'].includes(scenario.required) && expiryTarget.zoneName === 'groundArena' && expiryTarget.damage === 6 && !!phaseStatsFor(expiryTarget);
                }
                if (eg.round > initialRound && expirySurvivor) {
                    witness.expiryLethal ||= scenario.required === 'expiry' && targets.own.zoneName === 'discard';
                    witness.leaderExpired ||= scenario.required === 'leaderExpiry' && !targets.leader.deployed && !phaseStatsFor(targets.leader);
                }
            }
            let chosen;
            if (eg.round === initialRound && atWindow) {
                if (pid === own.id && index < scenario.plan.length) {
                    const [code, target, mode] = scenario.plan[index];
                    const c = code === scenario.leaderCode ? own.getAllDeckLeaders()[0] : mode === 'attack' && targets.constant && matches(targets.constant, code) ? targets.constant : own.getCardsInZone('hand').find((c) => matches(c, code));
                    assert.ok(c, `Script event ${code} not in hand`);
                    chosen = actions.find((a) => a.cardUuid === c.uuid);
                    assert.ok(chosen, `Event ${code} not legal at step${step}`);
                    pending = targets[target];
                    pendingMode = mode;
                    if (scenario.uniqueKeep || scenario.trackIncoming) { targets.incoming = c; targets.handBeforePlay = own.getCardsInZone('hand').length; }
                    witness.transitions.push({ step, played: code, target: eg.cardId(pending.uuid) });
                    index++;
                } else if (pid === enemy.id && scenario.constantInHand && !enemyScriptPlayed && (!scenario.enemyWaitForOwnPhase || phaseStatsFor(targets.own))) {
                    chosen = actions.find((a) => a.cardUuid === targets.constant.uuid);
                    assert.ok(chosen, 'Scripted opponent constant source is not playable');
                    enemyScriptPlayed = true;
                } else chosen = actions.find((a) => a.arg === 'pass');
            } else if (!atWindow && pid === own.id && pending) {
                if (scenario.discard && actions.some((a) => a.cardUuid === targets.retrieved.uuid)) {
                    assert.ok(!actions.some((a) => a.cardUuid === targets.wrongType.uuid), 'Unit retrieval incorrectly offered an event');
                    witness.excludedEvent = true;
                }
                if (pendingMode) {
                    chosen = actions.find((a) => pendingMode === 'deploy' ? /deploy/i.test(a.label ?? '') : pendingMode === 'attack' ? /^attack$/i.test(a.label ?? '') : /exhaust a unit|give a shield/i.test(a.label ?? ''));
                }
                if (scenario.decline) { chosen = actions.find((a) => /pass|no|decline/i.test(a.label ?? '')); if (chosen) witness.declined = true; }
                chosen ??= actions.find((a) => a.cardUuid === pending.uuid);
                chosen ??= actions.find((a) => a.kind === 'button' && /play|resolve|trigger|deal|give|return|draw|exhaust|heal/i.test(a.label ?? ''));
            }
            if (scenario.uniqueKeep && eg.round === initialRound && !atWindow && /Choose which copy/.test(own.currentPrompt().menuTitle ?? '')) {
                const existing = scenario.uniqueExistingOwn ? targets.own : targets.constant;
                if (scenario.uniqueExistingOwn) {
                    assert.equal(existing.zoneName, 'groundArena', 'Buffed existing unit died before unique choice');
                    assert.equal(targets.incoming.zoneName, 'groundArena', 'Incoming unit died before unique choice');
                    assert.ok(actions.some((a) => a.cardUuid === existing.uuid || a.arg === existing.uuid), 'Existing unique copy not offered');
                    assert.ok(actions.some((a) => a.cardUuid === targets.incoming.uuid || a.arg === targets.incoming.uuid), 'Incoming unique copy not offered');
                } else {
                    assert.equal(targets.enemy.zoneName, 'groundArena', 'Enemy died before the unique choice');
                    assert.equal(targets.enemy.cardData.hp, 4);
                    assert.equal(targets.enemy.getSummary(enemy, true).hp, 2, 'Only the existing Snoke aura applies during unique choice');
                }
                const drop = scenario.uniqueKeep === 'old' ? targets.incoming : existing;
                chosen = actions.find((a) => a.cardUuid === drop.uuid || a.arg === drop.uuid);
                assert.ok(chosen, 'Missing intended duplicate defeat choice');
                witness.uniqueWindows.push({ step, enemyPrintedHp: targets.enemy.cardData.hp, enemyHpDuringChoice: targets.enemy.getSummary(enemy, true).hp,
                    existingId: eg.cardId(existing.uuid), incomingId: eg.cardId(targets.incoming.uuid), defeatedId: eg.cardId(drop.uuid), keep: scenario.uniqueKeep,
                    bothCopiesOffered: actions.some((a) => a.cardUuid === existing.uuid || a.arg === existing.uuid) && actions.some((a) => a.cardUuid === targets.incoming.uuid || a.arg === targets.incoming.uuid) });
            }
            chosen ??= bot.choose({ game: eg, pid, actions, rng });
            assert.ok(chosen);
            const prompt = eg.player(pid).currentPrompt();
            records.push({ type: 'decision', step, actor: eg.seatOf(pid), prompt: { type: prompt.promptType ?? null, title: prompt.menuTitle ?? null,
                selected: (eg.player(pid).promptState.selectedCards ?? []).map((c) => eg.cardId(c.uuid)), actionWindow: atWindow },
                actions: actions.map((a) => canonicalAction(eg, a)), chosen: canonicalAction(eg, chosen).key, events: [] });
            eg.apply(pid, chosen, rng); step++;
        }
        assert.ok(eg.over, 'Fixture did not complete');
        records.push({ type: 'result', step, winner: eg.winner, state: fullState(eg) });
        if (scenario.observeAfter) witness.constantAfter ||= scenario.observeAfter({ eg, own, enemy, targets, state: records.at(-1).state });
        assert.equal(index, scenario.plan.length, 'Script did not execute');
        assert.ok(scriptedResolved || scenario.terminalBase, 'No post-script state witness');
        const required = { zero: 'zeroPlayed', stack: 'stacked', expiry: 'expiryLethal', bounce: 'bounced', defeat: 'defeated', negativeHp: 'negativeHp', leaderExpiry: 'leaderExpired', decline: 'declined', tokenBounce: 'tokenBounced', retrieve: 'retrievedUnit', noAction: 'noAction', conditionalReady: 'conditionalReady' }[scenario.required];
        if (required) assert.ok(witness[required], `Missing semantic witness ${required}`);
        if (scenario.observeInitial) assert.ok(witness.constantInitial, 'Missing initial constant witness');
        if (scenario.observeAfter) assert.ok(witness.constantAfter, 'Missing post-action constant witness');
        if (scenario.observeLater) assert.ok(witness.constantLater, 'Missing later-round semantic witness');
        if (scenario.discard) assert.ok(witness.excludedEvent, 'No exact retrieval target-set witness');
        witness.playedCodes = [...playedCodes].sort();
        if (scenario.expectedPlayed) assert.ok(playedCodes.has(scenario.expectedPlayed), `No engine onCardPlayed witness for ${scenario.expectedPlayed}`);
        if (scenario.uniqueKeep) assert.equal(witness.uniqueWindows.length, 1, 'Missing or repeated scripted unique choice');
        return { records, witness };
    } finally { bot.close?.(); }
}
const phaseStatsFor = (card) => require('./state').phaseStats(card).phaseStats;
async function main(args) {
    const [sourcePool, directory] = args;
    assert.ok(sourcePool && directory && args.length === 2, 'Usage: make-phase-fixtures.js POOL_JSON NEW_OUTPUT_DIRECTORY');
    assert.ok(!fs.existsSync(directory), 'Use a fresh output directory');
    fs.mkdirSync(directory, { recursive: true });
    const poolFile = path.join(directory, 'pool.json'); fs.copyFileSync(sourcePool, poolFile);
    const pool = loadPool(poolFile), env = new Env(), witnesses = [];
    for (const [i, scenario] of scenarios.entries()) {
        const { records, witness } = await fixture(env, pool, scenario, 9001 + i);
        const name = scenario.name + '.jsonl.gz';
        fs.writeFileSync(path.join(directory, name), zlib.gzipSync(records.map((r) => JSON.stringify(r)).join('\n') + '\n'));
        witnesses.push({ file: name, ...witness });
        console.log(`${name}: ${records.filter((r) => r.type === 'decision').length} decisions`);
    }
    fs.writeFileSync(path.join(directory, 'phase-witnesses.json'), JSON.stringify({ conformance: 'unassessed; run native and Wasm check', witnesses }, null, 2) + '\n');
}
if (require.main === module) main(process.argv.slice(2)).catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { fixtureDeck, fixture, scenarios };
