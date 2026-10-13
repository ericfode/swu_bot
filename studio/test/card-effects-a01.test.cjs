const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createRequire } = require('node:module');
const ts = require('../../viewer/node_modules/typescript');

// Match the existing effect test harness: exercise the actual modules on Node 22.
const modules = new Map();
function loadTS(filename) {
    filename = path.resolve(filename);
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const requireFromFile = createRequire(filename);
    new Function('require', 'module', 'exports', code)((specifier) => {
        const candidate = path.resolve(path.dirname(filename), `${specifier}.ts`);
        return specifier.startsWith('.') && fs.existsSync(candidate) ? loadTS(candidate) : requireFromFile(specifier);
    }, module, module.exports);
    return module.exports;
}

const { A01_DEFINITIONS, A01_COSTS, a01ShowcaseState, a01PreviewOutcomes } = loadTS(path.join(__dirname, '../src/effects/batchA01.ts'));
const { resolvePreviewState } = loadTS(path.join(__dirname, '../src/effects/previewState.ts'));
const { previewPlayCost } = loadTS(path.join(__dirname, '../src/effects/previewCosts.ts'));
const { CARD_EFFECTS, findCardEffect } = loadTS(path.join(__dirname, '../src/effects/catalogue.ts'));
const { showcaseGame } = loadTS(path.join(__dirname, '../src/effects/showcase.ts'));
const { previewCue } = loadTS(path.join(__dirname, '../src/effects/preview.ts'));
const { observedOutcomes } = loadTS(path.join(__dirname, '../src/effects/outcomes.ts'));
const { preparePreviewCue, resolveStagedRegroup, previewSceneKey } = loadTS(path.join(__dirname, '../src/effects/previewStages.ts'));

const cloned = value => structuredClone(value);
const named = (cards, name) => cards.find(card => card.n === name);
const byId = (cards, id) => cards.find(card => card.id === id);
const ids = cards => cards.map(card => card.id);
function example(id, modify) {
    const definition = A01_DEFINITIONS.find(card => card.id === id);
    assert.ok(definition, id);
    const before = a01ShowcaseState(definition);
    if (modify) modify(before);
    const source = before.players.p1.hand.find(card => card.s === definition.setCode);
    const outcomes = a01PreviewOutcomes(definition, before, 'p1');
    const cue = { definition, source, seat: 'p1', target: null, key: `test:${id}:1`, outcomes };
    const after = resolvePreviewState(before, cue);
    return { before, cue, after, p1: after.players.p1, p2: after.players.p2 };
}

function physicalCards(state) {
    return ['p1', 'p2'].flatMap(seat => {
        const player = state.players[seat];
        return [...player.hand, ...player.discard, ...(player.knownDeck ?? []), ...player.ground, ...player.space,
            ...[...player.ground, ...player.space].flatMap(unit => unit.u ?? [])];
    });
}
function recordedState(state) {
    const copy = cloned(state);
    delete copy.pending;
    for (const player of Object.values(copy.players)) {
        delete player.knownDeck;
        for (const ref of [player.base, player.leader, ...player.hand, ...player.discard, ...player.ground, ...player.space]) {
            if (!ref) continue;
            delete ref.owner;
            delete ref.incarnation;
            delete ref.status;
            for (const upgrade of ref.u ?? []) { delete upgrade.owner; delete upgrade.p; delete upgrade.h; }
        }
    }
    return copy;
}
function recordedOutcomes(id) {
    const result = example(id);
    const game = { header: { seed: 1 }, end: { winner: 'draw' }, steps: [
        { state: recordedState(result.before) },
        { state: recordedState(result.after) }
    ] };
    const action = { index: 1, until: 1, seat: 'p1', card: cloned(result.cue.source) };
    delete action.card.owner;
    const saved = cloned(game);
    const outcomes = observedOutcomes(game, action);
    assert.deepEqual(game, saved, 'observing outcomes cannot enrich or mutate recorded truth');
    return outcomes;
}

test('explicit regroup follow-ups preserve payment and lifecycle while resolving only the delayed consequence', () => {
    for (const id of ['change-of-heart', 'sneak-attack']) {
        const definition = A01_DEFINITIONS.find(card => card.id === id);
        const initial = a01ShowcaseState(definition);
        const saved = cloned(initial);
        const immediate = preparePreviewCue({ definition, nonce: 1 }, initial);
        const preview = { definition, nonce: 2, stage: 'regroup-start' };
        const followup = preparePreviewCue(preview, initial);
        const { before, after } = followup.transition;
        assert.equal(followup.key, previewSceneKey(preview));
        assert.notEqual(followup.key, immediate.key);
        assert.deepEqual(initial, saved, 'neither scene mutates the fixture');
        assert.deepEqual(before, { ...immediate.transition.after, phase: 'regroup' });
        assert.equal(before.pending.length, 1);
        assert.equal(after.pending.length, 0);
        assert.equal(after.phase, 'regroup');
        for (const seat of ['p1', 'p2']) {
            assert.deepEqual(after.players[seat].res, before.players[seat].res, 'boundary cannot pay again or ready resources');
            assert.equal(after.players[seat].deck, before.players[seat].deck, 'no regroup draw yet');
            assert.deepEqual(after.players[seat].hand, before.players[seat].hand);
        }
        const obligation = before.pending[0];
        const entered = byId(before.players.p1.ground, obligation.targetId);
        assert.ok(entered);
        assert.equal(byId(after.players.p1.ground, obligation.targetId), undefined);
        if (id === 'change-of-heart') {
            const returned = byId(after.players.p2.ground, obligation.targetId);
            assert.ok(returned);
            assert.equal(returned.x, 1, 'changing controller does not ready it');
            assert.equal(returned.d, entered.d);
            assert.equal(returned.incarnation, entered.incarnation);
            assert.equal(returned.owner, 'p2');
            assert.equal(returned.status, undefined);
            assert.deepEqual(after.players.p2.discard, before.players.p2.discard);
            assert.equal(followup.outcomes[0].kind, 'control');
        } else {
            assert.ok(byId(after.players.p1.discard, obligation.targetId));
            assert.equal(after.players.p1.discard.length, before.players.p1.discard.length + 1);
            assert.equal(followup.outcomes[0].kind, 'defeat');
        }
        assert.deepEqual(resolveStagedRegroup(after).after, after, 'consumed boundary is idempotent');
        assert.deepEqual(preparePreviewCue({ ...preview, nonce: 99 }, initial).transition, followup.transition, 'replay begins from the same boundary');
    }
});

test('regroup cannot act on a departed card or a later entry with the same physical ID', () => {
    const { after } = example('sneak-attack');
    const obligation = after.pending[0];
    const unit = byId(after.players.p1.ground, obligation.targetId);
    unit.incarnation = `${unit.id}:entry-2`;
    delete unit.status;
    const result = resolveStagedRegroup(after);
    assert.ok(byId(result.after.players.p1.ground, obligation.targetId));
    assert.equal(result.after.players.p1.discard.length, after.players.p1.discard.length);
    assert.equal(result.outcomes.length, 0);
    assert.equal(result.after.pending.length, 0);
});

test('regroup defeat disposes attachments by owner and does not leave token cards in discard', () => {
    const { after } = example('sneak-attack');
    const unit = byId(after.players.p1.ground, after.pending[0].targetId);
    unit.u = [{ id: 'enemy-owned-upgrade', n: 'Academy Training', s: 'SOR_120', owner: 'p2', t: 0 },
        { id: 'shield-token', n: 'Shield', s: null, owner: 'p1', t: 1 }];
    const result = resolveStagedRegroup(after).after;
    assert.ok(byId(result.players.p2.discard, 'enemy-owned-upgrade'));
    assert.equal(byId(result.players.p1.discard, 'shield-token'), undefined);
    assert.equal(byId(result.players.p2.discard, 'shield-token'), undefined);
});

test('a later leader status at control-return boundary defeats that leader instead of transferring it', () => {
    const { after } = example('change-of-heart');
    const pending = after.pending[0];
    const target = byId(after.players.p1.ground, pending.targetId);
    // Explicit presentation evidence of changed card type; never inferred from a title.
    after.players.p2.leader = { id: target.id, n: target.n, s: target.s, owner: 'p2', dep: 1, x: 0 };
    const result = resolveStagedRegroup(after);
    assert.equal(byId(result.after.players.p1.ground, target.id), undefined);
    assert.equal(byId(result.after.players.p2.ground, target.id), undefined);
    assert.equal(result.after.players.p2.leader.dep, 0);
    assert.equal(result.after.players.p2.leader.x, 1);
    assert.equal(byId(result.after.players.p2.discard, target.id), undefined, 'leaders return to their leader zone');
    assert.equal(result.outcomes[0].kind, 'defeat');
});

test('A01 exact prints, complete costs and real fixture stats agree with installed read-only card data', () => {
    assert.equal(A01_DEFINITIONS.length, 10);
    const cardData = new Map(fs.readdirSync(path.join(__dirname, '../../forceteki/test/json/Card')).filter(file => file.endsWith('.json')).map(file => {
        const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../../forceteki/test/json/Card', file), 'utf8'));
        return [data.internalName, data];
    }));
    const prints = new Map();
    for (const data of cardData.values()) {
        for (const code of data.setCodes ?? []) prints.set(`${code.set}_${String(code.number).padStart(3, '0')}`, data);
    }
    for (const definition of A01_DEFINITIONS) {
        const data = cardData.get(definition.id);
        assert.ok(data, definition.id);
        assert.equal(definition.name, data.title);
        assert.deepEqual(A01_COSTS[definition.id], { printed: data.cost, aspects: data.aspects });
        const aliases = data.setCodes.map(code => `${code.set}_${String(code.number).padStart(3, '0')}`);
        assert.deepEqual(aliases, [definition.setCode], `${definition.id}: every currently imported alias is registered`);
        assert.equal(findCardEffect({ n: definition.name, s: definition.setCode })?.id, definition.id);
        assert.equal(findCardEffect({ n: definition.name, s: 'UNKNOWN_999' }), undefined);
        const before = a01ShowcaseState(definition);
        for (const player of Object.values(before.players)) {
            for (const unit of [...player.ground, ...player.space]) {
                const raw = prints.get(unit.s);
                assert.ok(raw, `${unit.n}: real print`);
                const upgrades = unit.u ?? [];
                assert.equal(unit.p, raw.power + upgrades.reduce((sum, upgrade) => sum + (upgrade.p ?? 0), 0));
                assert.equal(unit.h, raw.hp + upgrades.reduce((sum, upgrade) => sum + (upgrade.h ?? 0), 0));
                assert.ok(unit.d >= 0 && unit.d < unit.h, `${unit.n}: staged survivor has remaining HP`);
                assert.ok(unit.incarnation, `${unit.n}: entry identity exists`);
                for (const upgrade of upgrades) {
                    const rawUpgrade = upgrade.s ? prints.get(upgrade.s) : cardData.get(upgrade.n.toLowerCase());
                    assert.equal(upgrade.p, rawUpgrade.upgradePower);
                    assert.equal(upgrade.h, rawUpgrade.upgradeHp);
                }
            }
        }
    }
});

test('all A01 immediate results preserve original inputs, stable identities, physical-card conservation and exact payments', () => {
    const expectedReady = { 'moment-of-peace': 9, 'mission-briefing': 5, 'keep-fighting': 6, outmaneuver: 5,
        'attack-pattern-delta': 5, 'power-failure': 6, 'change-of-heart': 2, 'sneak-attack': 3, recruit: 9, 'strike-true': 7 };
    for (const definition of A01_DEFINITIONS) {
        const { before, cue, after } = example(definition.id);
        const input = cloned({ before, cue });
        assert.deepEqual(resolvePreviewState(before, cue), after);
        assert.deepEqual(resolvePreviewState(before, { ...cue, key: `test:${definition.id}:2` }), after, 'clock nonce cannot alter card/obligation IDs');
        assert.deepEqual({ before, cue }, input, 'resolution preserves immutable before/evidence');
        assert.equal(after.players.p1.res.ready, expectedReady[definition.id]);
        assert.equal(after.players.p1.res.total, 10);
        assert.deepEqual(after.players.p2.res, before.players.p2.res);
        assert.equal(after.phase, 'action', 'animation completion does not advance into regroup');
        assert.equal(after.players.p1.discard.filter(card => card.id === cue.source.id).length, 1, 'source is disposed exactly once');
        assert.equal(after.players.p1.hand.some(card => card.id === cue.source.id), false);
        const beforePhysical = physicalCards(before).filter(card => !card.t);
        const afterPhysical = physicalCards(after).filter(card => !card.t);
        assert.deepEqual(ids(afterPhysical).sort(), ids(beforePhysical).sort(), 'draw, control and upgrade removal conserve physical cards');
        assert.equal(new Set(ids(physicalCards(after))).size, physicalCards(after).length, 'one instance cannot occupy two zones');
        for (const player of Object.values(after.players)) {
            assert.equal(player.knownDeck.length, player.deck);
            assert.ok(player.res.ready >= 0 && player.res.ready <= player.res.total);
        }
    }
});

test('A01 is integrated through showcase/preview seams rather than an unrelated demonstration renderer', () => {
    for (const definition of A01_DEFINITIONS) {
        assert.ok(CARD_EFFECTS.some(card => card.id === definition.id));
        const before = showcaseGame(definition).steps[0].state;
        assert.deepEqual(before, a01ShowcaseState(definition));
        const cue = previewCue({ definition, nonce: 11 }, before);
        assert.equal(cue.source.id, `a01:${definition.id}:event`);
        assert.deepEqual(cue.outcomes, a01PreviewOutcomes(definition, before, 'p1'));
        const after = resolvePreviewState(before, cue);
        assert.deepEqual(resolvePreviewState(before, previewCue({ definition, nonce: 12 }, before)), after);
    }
});

test('shield, chosen-player draws and ready/exhaust poses persist with no unrelated changes', () => {
    const peace = example('moment-of-peace');
    const shielded = named(peace.p1.ground, 'Battlefield Marine');
    assert.deepEqual([shielded.p, shielded.h, shielded.d, shielded.x], [3, 3, 1, undefined]);
    assert.equal(shielded.u.filter(upgrade => upgrade.n === 'Shield').length, 1);
    const briefing = example('mission-briefing');
    assert.equal(briefing.p2.deck, 27);
    assert.deepEqual(ids(briefing.p2.hand), ['a01:p2:takedown-hand', 'a01:mission-briefing:p2:draw:0', 'a01:mission-briefing:p2:draw:1']);
    assert.deepEqual(briefing.p2.hand.map(card => [card.n, card.s]), [['Takedown', 'SOR_077'], ['Open Fire', 'SOR_172'], ['Wampa', 'SOR_164']]);
    assert.equal(briefing.p1.deck, 27);
    assert.equal(briefing.p1.hand.length, 0);
    assert.deepEqual(briefing.p2.base, briefing.before.players.p2.base);
    const fighting = example('keep-fighting');
    assert.equal(named(fighting.p1.ground, 'Battlefield Marine').x, undefined);
    assert.deepEqual(fighting.p2, fighting.before.players.p2);
    const outmaneuver = example('outmaneuver');
    for (const player of Object.values(outmaneuver.after.players)) assert.ok(player.ground.every(unit => unit.x === 1));
    assert.equal(outmaneuver.cue.outcomes.filter(outcome => outcome.kind === 'exhaust' && outcome.amount > 0).length, 3);
    assert.equal(outmaneuver.cue.outcomes.filter(outcome => outcome.kind === 'exhaust' && outcome.amount === 0).length, 1);
    for (const seat of ['p1', 'p2']) {
        assert.deepEqual(outmaneuver.after.players[seat].space, outmaneuver.before.players[seat].space);
        assert.deepEqual(outmaneuver.after.players[seat].leader, outmaneuver.before.players[seat].leader);
    }
});

test('Delta assigns three different units phase stats without healing or manufacturing Experience', () => {
    const delta = example('attack-pattern-delta');
    const units = [named(delta.p1.ground, 'Battlefield Marine'), named(delta.p1.ground, 'Echo Base Defender'), named(delta.p1.space, 'Alliance X-Wing')];
    assert.deepEqual(units.map(unit => [unit.p, unit.h, unit.d]), [[6, 6, 1], [6, 5, 0], [3, 4, 0]]);
    assert.equal(new Set(ids(units)).size, 3);
    assert.ok(units.every(unit => !unit.u?.length && !unit.x));
    assert.deepEqual(units.map(unit => unit.status.map(status => [status.kind, status.duration])),
        [[['buff', 'phase']], [['buff', 'phase']], [['buff', 'phase']]]);
    assert.equal(units[1].sn, 1);
    assert.deepEqual(delta.p2, delta.before.players.p2);
});

test('Power Failure removes only selected attachments, rolls back actual stat contributions and never discards the Shield token', () => {
    const failure = example('power-failure');
    const wampa = named(failure.p2.ground, 'Wampa');
    assert.deepEqual([wampa.p, wampa.h, wampa.d, wampa.x], [5, 6, 1, 1]);
    assert.deepEqual(ids(wampa.u), ['a01:power-failure:experience']);
    assert.deepEqual(ids(failure.p2.discard).sort(), ['a01:power-failure:academy', 'a01:power-failure:entrenched']);
    assert.equal(physicalCards(failure.after).some(card => card.id === 'a01:power-failure:shield'), false);
    assert.equal(failure.p2.ground.length, 2, 'host remains in its original arena');
    assert.equal(wampa.status, undefined, 'lost upgrade stats are not a new phase debuff');
    const zero = cloned(failure.cue);
    zero.outcomes = [];
    const declined = resolvePreviewState(failure.before, zero);
    assert.deepEqual(declined.players.p2, failure.before.players.p2, 'declining targets pays the event and changes no upgrades');
    const differentOwner = example('power-failure', before => { before.players.p2.ground[1].u[0].owner = 'p1'; });
    assert.ok(byId(differentOwner.p1.discard, 'a01:power-failure:academy'), 'an ordinary upgrade goes to its actual owner, not the host controller');
    assert.equal(byId(differentOwner.p2.discard, 'a01:power-failure:academy'), undefined);
});

test('control preserves one exhausted incarnation and ownership while registering a later obligation only', () => {
    const heart = example('change-of-heart');
    const original = named(heart.before.players.p2.ground, 'Wampa');
    const moved = named(heart.p1.ground, 'Wampa');
    assert.equal(named(heart.p2.ground, 'Wampa'), undefined);
    assert.deepEqual([moved.id, moved.incarnation, moved.owner, moved.p, moved.h, moved.d, moved.x],
        [original.id, original.incarnation, 'p2', 4, 5, 1, 1]);
    assert.deepEqual(heart.after.pending, [{ id: 'a01:change-of-heart:regroup:W', sourceId: heart.cue.source.id,
        targetId: original.id, incarnation: original.incarnation, trigger: 'regroup-start', kind: 'return-control', returnController: 'p2' }]);
    assert.ok(moved.status.some(status => status.kind === 'delay' && status.duration === 'regroup'));
    const ownCard = example('change-of-heart', before => { before.players.p2.ground[1].owner = 'p1'; });
    assert.equal(named(ownCard.p1.ground, 'Wampa').owner, 'p1');
    assert.equal(ownCard.after.pending[0].returnController, 'p1', 'future controller comes from owner, not former controller');
    const wrongEntry = cloned(heart.cue);
    wrongEntry.outcomes.find(outcome => outcome.kind === 'delay').pending.incarnation = 'a01:W:entry-never-recorded';
    assert.throws(() => resolvePreviewState(heart.before, wrongEntry), /current arena incarnation/);
    const departed = cloned(heart.cue);
    departed.outcomes.push({ kind: 'return', card: original, seat: 'p2', amount: 1, zone: 'hand' });
    const returned = resolvePreviewState(heart.before, departed);
    assert.equal(returned.pending.length, 0, 'leaving play invalidates the former entry’s delayed effect');
    assert.ok(byId(returned.players.p2.hand, original.id));
});

test('Sneak Attack pays the source plus a discounted real unit and leaves it ready with a pending defeat', () => {
    const sneak = example('sneak-attack');
    assert.equal(previewPlayCost(sneak.cue.definition, sneak.before), 4);
    assert.equal(sneak.cue.outcomes.find(outcome => outcome.kind === 'pay').amount, 3);
    const entered = byId(sneak.p1.ground, 'a01:sneak-attack:wampa-hand');
    assert.deepEqual([entered.p, entered.h, entered.d, entered.x, entered.owner], [4, 5, 0, undefined, 'p1']);
    assert.equal(sneak.p1.hand.length, 0);
    assert.equal(sneak.p1.deck, 27);
    assert.equal(sneak.p1.discard.length, 1);
    assert.equal(sneak.after.pending[0].kind, 'defeat');
    assert.equal(sneak.after.pending[0].incarnation, entered.incarnation);
    assert.ok(entered.status.some(status => status.kind === 'delay'));
    assert.equal(sneak.cue.outcomes.some(outcome => ['attack', 'defeat', 'damage', 'ready'].includes(outcome.kind)), false,
        'ready entry is not an invented later ready action or premature attack/defeat');
    const insufficient = cloned(sneak.before);
    insufficient.players.p1.res.ready = 6;
    assert.throws(() => resolvePreviewState(insufficient, sneak.cue), /additional payment needs 3 ready resources/);
});

test('Recruit draws exactly its selected top-five unit and reinserts only the other four at bottom', () => {
    const recruit = example('recruit');
    const initialDeck = recruit.before.players.p1.knownDeck;
    assert.equal(recruit.p1.hand.length, 1);
    assert.equal(recruit.p1.hand[0].id, 'a01:recruit:top:1');
    assert.equal(recruit.p1.hand[0].s, 'SOR_095');
    assert.equal(recruit.p1.deck, 26);
    assert.deepEqual(ids(recruit.p1.knownDeck.slice(0, 22)), ids(initialDeck.slice(5)));
    assert.deepEqual(ids(recruit.p1.knownDeck.slice(-4)).sort(), ['a01:recruit:top:0', 'a01:recruit:top:2', 'a01:recruit:top:3', 'a01:recruit:top:4']);
    assert.deepEqual(ids(recruit.p1.knownDeck.slice(-4)), ['a01:recruit:top:4', 'a01:recruit:top:3', 'a01:recruit:top:2', 'a01:recruit:top:0'], 'one stable possible random ordering');
    assert.deepEqual(recruit.p1.ground, recruit.before.players.p1.ground, 'drawn unit is not played');
    assert.equal(recruit.p1.discard.length, 1);
    const declinedCue = cloned(recruit.cue);
    declinedCue.outcomes = declinedCue.outcomes.filter(outcome => outcome.kind === 'search').map(outcome => ({ ...outcome, card: null }));
    const declined = resolvePreviewState(recruit.before, declinedCue);
    assert.equal(declined.players.p1.hand.length, 0);
    assert.equal(declined.players.p1.deck, 27);
    assert.deepEqual(ids(declined.players.p1.knownDeck.slice(-5)).sort(), ids(initialDeck.slice(0, 5)).sort());
    const badSearch = cloned(recruit.cue);
    badSearch.outcomes.find(outcome => outcome.kind === 'search').card = recruit.before.players.p1.ground[0];
    assert.throws(() => resolvePreviewState(recruit.before, badSearch), /outside the searched group/);
});

test('Strike True uses current source power without readying, exhausting, attacking or taking counterdamage', () => {
    const strike = example('strike-true');
    assert.deepEqual(named(strike.p1.ground, 'Battlefield Marine'), named(strike.before.players.p1.ground, 'Battlefield Marine'));
    assert.deepEqual([named(strike.p2.ground, 'Wampa').p, named(strike.p2.ground, 'Wampa').h, named(strike.p2.ground, 'Wampa').d], [4, 5, 4]);
    assert.equal(strike.cue.outcomes.length, 1);
    assert.equal(strike.cue.outcomes[0].sourceCard.id, 'a01:p1:marine');
    assert.equal(strike.cue.outcomes[0].card.id, 'a01:p2:wampa');
    const weakened = example('strike-true', before => {
        const marine = before.players.p1.ground[0];
        marine.p = 2; marine.h = 2;
        marine.status = [{ kind: 'debuff', label: '−1/−1 · phase', duration: 'phase' }];
    });
    assert.equal(weakened.cue.outcomes[0].amount, 2);
    assert.equal(named(weakened.p2.ground, 'Wampa').d, 3, 'source current power replaces its printed power');
});

test('snapshot-only recordings report observed changes without invented search, future obligations, attacks or costs', () => {
    const recruit = recordedOutcomes('recruit');
    assert.equal(recruit.filter(outcome => outcome.kind === 'draw').reduce((sum, outcome) => sum + outcome.amount, 0), 1);
    assert.equal(recruit.some(outcome => ['search', 'inspect', 'delay', 'cost', 'pay'].includes(outcome.kind)), false);
    const heart = recordedOutcomes('change-of-heart');
    const control = heart.find(outcome => outcome.kind === 'control');
    assert.ok(control, 'same instance changing recorded side establishes control movement');
    assert.equal(control.fromSeat, 'p2');
    assert.equal(control.seat, 'p1');
    assert.equal(control.ownerSeat, undefined, 'former side is not evidence of ownership');
    assert.equal(heart.some(outcome => outcome.kind === 'delay'), false);
    const sneak = recordedOutcomes('sneak-attack');
    assert.ok(sneak.some(outcome => outcome.kind === 'play'), 'observed hand departure and arena arrival establish play');
    assert.equal(sneak.some(outcome => ['delay', 'cost', 'pay', 'attack'].includes(outcome.kind)), false);
    const strike = recordedOutcomes('strike-true');
    assert.ok(strike.some(outcome => outcome.kind === 'damage' && outcome.amount === 3));
    assert.equal(strike.some(outcome => ['attack', 'ready', 'exhaust'].includes(outcome.kind)), false);
    const outmaneuver = recordedOutcomes('outmaneuver');
    assert.equal(outmaneuver.filter(outcome => outcome.kind === 'exhaust').length, 3, 'already exhausted Wampa is not a fourth state-change receipt');
});

test('a vanished token on a retained host is not an attributed defeat receipt without explicit resolution evidence', () => {
    const result = example('power-failure');
    assert.ok(result.cue.outcomes.some(outcome => outcome.kind === 'defeat' && outcome.card.id === 'a01:power-failure:shield'),
        'the deliberately staged selection contains explicit Shield defeat');
    const observed = recordedOutcomes('power-failure');
    assert.equal(observed.some(outcome => outcome.kind === 'defeat' && outcome.card?.id === 'a01:power-failure:shield'), false,
        'snapshots alone do not identify why a token disappeared during a multi-trigger action span');
    const upgrades = observed.filter(outcome => outcome.kind === 'defeat' && ['a01:power-failure:academy', 'a01:power-failure:entrenched'].includes(outcome.card?.id));
    assert.equal(upgrades.length, 2, 'known discard destinations still establish ordinary upgrade defeat');
    assert.ok(upgrades.every(outcome => outcome.sourceCard.id === 'a01:p2:wampa'));
    assert.equal(observed.some(outcome => outcome.kind === 'defeat' && outcome.card?.id === 'a01:p2:wampa'), false,
        'the retained host is not defeated with its upgrades');
    assert.equal(named(result.p2.ground, 'Wampa').u.some(upgrade => upgrade.id === 'a01:power-failure:shield'), false,
        'the actual ending board can accurately omit the token without a fabricated defeat animation');
});
