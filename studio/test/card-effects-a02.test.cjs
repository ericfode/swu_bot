const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createRequire } = require('node:module');
const ts = require('../../viewer/node_modules/typescript');
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
const { A02_DEFINITIONS, A02_COSTS, a02ShowcaseState, a02PreviewOutcomes } = loadTS(path.join(__dirname, '../src/effects/batchA02.ts'));
const { resolvePreviewState } = loadTS(path.join(__dirname, '../src/effects/previewState.ts'));
const { previewPlayCost, previewExtraPayment } = loadTS(path.join(__dirname, '../src/effects/previewCosts.ts'));
const { previewCue } = loadTS(path.join(__dirname, '../src/effects/preview.ts'));
const { showcaseGame } = loadTS(path.join(__dirname, '../src/effects/showcase.ts'));
const { findCardEffect } = loadTS(path.join(__dirname, '../src/effects/catalogue.ts'));
const { cardAbilities } = loadTS(path.join(__dirname, '../src/effects/abilities.ts'));
const { observedOutcomes } = loadTS(path.join(__dirname, '../src/effects/outcomes.ts'));
const clone = value => structuredClone(value);
const ids = cards => cards.map(c => c.id);
const named = (cards, name) => cards.find(c => c.n === name);
function staged(id, modify, modifyOutcomes) {
    const definition = A02_DEFINITIONS.find(c => c.id === id);
    assert.ok(definition);
    const before = a02ShowcaseState(definition);
    if (modify) modify(before);
    const outcomes = a02PreviewOutcomes(definition, before, 'p1');
    if (modifyOutcomes) modifyOutcomes(outcomes, before);
    const cue = { definition, source: before.players.p1.hand.find(c => c.s === definition.setCode), seat: 'p1', target: null, key: `test:${id}:1`, outcomes };
    const savedBefore = clone(before), savedCue = clone(cue);
    const after = resolvePreviewState(before, cue);
    assert.deepEqual(before, savedBefore, 'receipt application must not mutate before');
    assert.deepEqual(cue, savedCue, 'receipt application must not mutate cue');
    return { definition, before, cue, after, p1: after.players.p1, p2: after.players.p2 };
}
function allCards(state) {
    return Object.values(state.players).flatMap(p => [...p.hand, ...p.discard, ...(p.knownDeck ?? []), ...p.ground, ...p.space,
        ...[...p.ground, ...p.space].flatMap(c => c.u ?? [])]);
}

test('A02 canonical identities, aliases, costs and every real staged face agree with authoritative JSON', () => {
    // Read installed authoritative inputs directly; ignored review artifacts are not test prerequisites.
    const cardDir = path.join(__dirname, '../../forceteki/test/json/Card');
    const cards = fs.readdirSync(cardDir).filter(name => name.endsWith('.json')).map(name => JSON.parse(fs.readFileSync(path.join(cardDir, name))));
    const byPrint = new Map();
    const printCode = print => `${print.set}_${String(print.number).padStart(3, '0')}`;
    for (const c of cards) for (const print of c.setCodes ?? []) byPrint.set(printCode(print), c);
    for (const definition of A02_DEFINITIONS) {
        const actual = cards.find(c => c.internalName === definition.id);
        const json = JSON.parse(fs.readFileSync(path.join(__dirname, '../../forceteki/test/json/Card', `${definition.id}.json`)));
        assert.equal(actual.id, json.id);
        assert.equal(definition.name, json.title);
        assert.equal(definition.setCode, printCode(actual.setId));
        assert.equal(A02_COSTS[definition.id].printed, json.cost);
        assert.deepEqual(A02_COSTS[definition.id].aspects, json.aspects);
        for (const alias of actual.setCodes.map(printCode)) assert.equal(findCardEffect({ n: json.title, s: alias }).id, definition.id);
        const before = a02ShowcaseState(definition);
        for (const c of allCards(before)) {
            assert.ok(c.id);
            if (!c.s) { assert.equal(c.n, 'Unknown card'); continue; }
            const metadata = byPrint.get(c.s);
            assert.ok(metadata, c.s);
            assert.equal(c.n, metadata.subtitle ? `${metadata.title}: ${metadata.subtitle}` : metadata.title);
            if ('p' in c) { assert.equal(c.p, metadata.power); assert.equal(c.h, metadata.hp); assert.ok(c.d < c.h); assert.equal(c.incarnation, `${c.id}:entry-1`); }
        }
    }
    assert.deepEqual(findCardEffect({ n: 'Search Your Feelings', s: 'NOPE_042' }), undefined);
});

test('all ten pay legal event costs once and conserve exact physical cards/owners with stable repeated endings', () => {
    const payments = [6, 2, 4, 1, 7, 3, 4, 5, 7, 3];
    for (const [i, d] of A02_DEFINITIONS.entries()) {
        const e = staged(d.id);
        assert.equal(previewPlayCost(d, e.before), payments[i], d.id);
        assert.equal(previewExtraPayment(d), 0);
        assert.equal(e.p1.res.ready, 10 - payments[i]);
        assert.equal(e.p2.res.ready, 7);
        assert.equal(e.p1.discard.filter(c => c.id === e.cue.source.id).length, 1);
        assert.deepEqual(ids(allCards(e.after)).sort(), ids(allCards(e.before)).sort(), d.id);
        assert.equal(new Set(ids(allCards(e.after))).size, allCards(e.after).length, d.id);
        const originalOwners = new Map(allCards(e.before).map(c => [c.id, c.owner]));
        for (const c of allCards(e.after)) assert.equal(c.owner, originalOwners.get(c.id));
        for (const p of Object.values(e.after.players)) assert.equal(p.knownDeck.length, p.deck);
        assert.deepEqual(resolvePreviewState(e.before, { ...e.cue, key: `other-clock:${d.id}` }), e.after);
        assert.deepEqual(showcaseGame(d).steps[0].state, e.before);
        assert.deepEqual(previewCue({ definition: d, nonce: 77 }, e.before).outcomes, e.cue.outcomes);
    }
    assert.throws(() => staged('rallying-cry', s => s.players.p1.res.ready = 6), /needs 7 ready resources/);
});

test('Search privately draws a non-unit from the whole deck and shuffles every remaining ID', () => {
    const e = staged('search-your-feelings');
    const op = e.cue.outcomes[0].deckOperation;
    assert.equal(op.visibility, 'private'); assert.equal(op.scope, 'whole'); assert.equal(op.looked.length, 27);
    assert.equal(op.policy, 'whole-search-shuffle');
    assert.deepEqual(ids(e.p1.hand), ['a02:search-your-feelings:selected']);
    assert.equal(e.p1.hand[0].s, 'SOR_172'); assert.equal(e.p1.deck, 26);
    assert.deepEqual(ids(e.p1.knownDeck), ids(e.before.players.p1.knownDeck.filter(c => c.id !== op.selectedIds[0])).reverse());
    const takeNothing = clone(e.cue);
    takeNothing.outcomes.splice(1, 1); takeNothing.outcomes[0].deckOperation.selectedIds = [];
    takeNothing.outcomes[0].deckOperation.remainingOrder = e.before.players.p1.knownDeck.toReversed();
    const after = resolvePreviewState(e.before, takeNothing);
    assert.equal(after.players.p1.deck, 27); assert.equal(after.players.p1.hand.length, 0);
    assert.deepEqual(ids(after.players.p1.knownDeck), ids(e.before.players.p1.knownDeck).reverse());
});

test('deck operations reject incomplete/duplicate/foreign permutations, invented faces and selections outside the looked group', () => {
    const e = staged('uwing-reinforcement');
    for (const mutate of [
        op => op.remainingOrder.pop(),
        op => op.remainingOrder[1] = op.remainingOrder[0],
        op => op.selectedIds.push('not-searched'),
        op => op.looked[0] = { ...op.looked[0], s: 'SOR_051' },
        op => op.remainingOrder[3] = { ...op.remainingOrder[3], id: 'foreign' },
        op => op.remainingOrder.reverse(),
        op => op.selectedIds.push(op.looked[9].id),
        op => op.printedCosts[op.selectedIds[0]] = 8
    ]) {
        const cue = clone(e.cue); mutate(cue.outcomes[0].deckOperation);
        assert.throws(() => resolvePreviewState(e.before, cue), /deck|selection|selected|looked|printed/i);
    }
    const partial = clone(e.before); partial.players.p1.knownDeck.pop();
    assert.throws(() => resolvePreviewState(partial, e.cue), /complete staged manifest/);
});

test('U-Wing consumes three deck cards into exhausted real arena units, preserves untouched prefix and moves only seven others to bottom', () => {
    const e = staged('uwing-reinforcement');
    assert.equal(e.p1.deck, 24); assert.equal(e.p1.hand.length, 0); assert.equal(e.p1.ground.length, 4); assert.equal(e.p1.space.length, 2);
    const entered = [...e.p1.ground, ...e.p1.space].filter(c => c.id.startsWith('a02:uwing:top:'));
    assert.deepEqual(entered.map(c => [c.id, c.p, c.h, c.d, c.x]).sort(), [
        ['a02:uwing:top:0', 3, 3, 0, 1], ['a02:uwing:top:3', 4, 3, 0, 1], ['a02:uwing:top:7', 2, 3, 0, 1]
    ]);
    assert.equal(named(e.p1.ground, 'Echo Base Defender').sn, 1);
    assert.deepEqual(ids(e.p1.knownDeck.slice(0, 17)), ids(e.before.players.p1.knownDeck.slice(10)));
    assert.deepEqual(ids(e.p1.knownDeck.slice(-7)), [9, 8, 6, 5, 4, 2, 1].map(i => `a02:uwing:top:${i}`));
    assert.ok(e.cue.outcomes.filter(c => c.kind === 'play').every(c => c.fromZone === 'deck' && c.entersReady === false));
    assert.equal(e.cue.outcomes.some(c => c.kind === 'draw' || c.kind === 'pay'), false);
    const duplicate = clone(e.cue); duplicate.outcomes.push(clone(duplicate.outcomes[1]));
    assert.throws(() => resolvePreviewState(e.before, duplicate), /missing or already moved/);
    const wrongOrigin = clone(e.cue); wrongOrigin.outcomes[1].fromZone = 'hand';
    assert.equal(resolvePreviewState(e.before, wrongOrigin).players.p1.ground.length, 3, 'hand origin cannot consume an actual deck card');
    const invalidUnit = clone(e.before); invalidUnit.players.p1.knownDeck[0] = { ...invalidUnit.players.p1.knownDeck[0], n: 'Open Fire', s: 'SOR_172' };
    assert.throws(() => a02PreviewOutcomes(e.definition, invalidUnit, 'p1'), /actual units/);
    const overBudget = clone(e.before); overBudget.players.p1.knownDeck[0] = { ...overBudget.players.p1.knownDeck[0], n: 'Wampa', s: 'SOR_164' };
    assert.throws(() => a02PreviewOutcomes(e.definition, overBudget, 'p1'), /printed cost sum/);
    const otherAspects = clone(e.before); otherAspects.players.p1.knownDeck[3] = { ...otherAspects.players.p1.knownDeck[3], n: 'TIE/ln Fighter', s: 'SOR_225' };
    const outcomes = a02PreviewOutcomes(e.definition, otherAspects, 'p1');
    const free = resolvePreviewState(otherAspects, { ...e.cue, outcomes });
    assert.equal(free.players.p1.res.ready, 3, 'free deck plays ignore even the missing villainy aspect');
});

test('It Binds actual removed damage becomes damage to a different unit and never increases HP', () => {
    const e = staged('it-binds-all-things');
    assert.equal(named(e.p1.ground, 'Luke Skywalker: Jedi Knight').d, 0);
    assert.equal(named(e.p1.ground, 'Luke Skywalker: Jedi Knight').h, 7);
    assert.equal(named(e.p2.ground, 'Wampa').d, 4);
    const one = staged('it-binds-all-things', s => s.players.p1.ground[1].d = 1);
    assert.equal(named(one.p2.ground, 'Wampa').d, 2);
    assert.equal(one.cue.outcomes[1].amount, 1);
    const sameUnit = clone(e.cue); sameUnit.outcomes[1].card = sameUnit.outcomes[0].card; sameUnit.outcomes[1].seat = 'p1';
    assert.throws(() => resolvePreviewState(e.before, sameUnit), /different unit/);
    const falseAmount = clone(one.cue); falseAmount.outcomes[1].amount = 3;
    assert.throws(() => resolvePreviewState(one.before, falseAmount), /actual healing/);
    const noForce = staged('it-binds-all-things', s => Object.assign(s.players.p1.ground[1], { n: 'Echo Base Defender', s: 'SOR_098', p: 4, h: 3, d: 2 }));
    assert.deepEqual(noForce.cue.outcomes.map(c => c.kind), ['heal']);
    assert.equal(named(noForce.p2.ground, 'Wampa').d, 1);
    const zero = staged('it-binds-all-things', s => s.players.p1.ground[1].d = 0);
    assert.deepEqual(zero.cue.outcomes, [], 'staged zero branch skips damage; this is not a claim the pinned engine bug is repaired');
});

test('Legion recovers all current-phase units by own discard membership, not former controller or trait', () => {
    const e = staged('the-emperors-legion');
    assert.deepEqual(ids(e.p1.hand), ['a02:legion:marine', 'a02:legion:xwing']);
    assert.deepEqual(ids(e.p1.discard), ['a02:legion:old', 'a02:legion:event-old', e.cue.source.id]);
    assert.equal(e.before.defeatedThisPhase.cards[0].controller, 'p2');
    assert.equal(e.p1.ground.length, 2); assert.equal(e.p1.space.length, 1); assert.equal(e.p1.deck, 27);
    const noHistory = staged('the-emperors-legion', s => delete s.defeatedThisPhase);
    assert.equal(noHistory.p1.hand.length, 0);
    const wrongPhase = clone(e.before); wrongPhase.defeatedThisPhase.round--;
    assert.throws(() => resolvePreviewState(wrongPhase, e.cue), /actual current-phase defeat evidence/);
    const falseRecovery = clone(e.cue); falseRecovery.outcomes[0].card = e.before.players.p1.discard[2];
    assert.throws(() => resolvePreviewState(e.before, falseRecovery), /actual current-phase defeat evidence/);
});

test('Rebel Assault has two distinct legal ready Rebels with attack-only bonuses and sequential actual combat receipts', () => {
    const e = staged('rebel-assault');
    assert.equal(e.p2.base.d, 13);
    const m = named(e.p1.ground, 'Battlefield Marine'), x = named(e.p1.space, 'Alliance X-Wing');
    assert.deepEqual([m.p, m.h, m.d, m.x], [3, 3, 1, 1]); assert.deepEqual([x.p, x.h, x.d, x.x], [2, 3, 0, 1]);
    assert.equal(m.status, undefined); assert.equal(x.status, undefined); assert.equal(e.p1.base.d, 9);
    const attack = e.cue.outcomes.filter(c => c.kind === 'attack');
    assert.deepEqual(attack.map(c => [c.attackIndex, c.amount, c.sourceCard.id, c.card.id]), [
        [1, 4, 'a02:p1:marine', 'a02:p2:base'], [2, 3, 'a02:p1:xwing', 'a02:p2:base']
    ]);
    assert.notEqual(attack[0].attackId, attack[1].attackId);
    assert.throws(() => staged('rebel-assault', s => s.players.p1.ground[0].x = 1), /ready eligible/);
    assert.throws(() => staged('rebel-assault', s => s.players.p2.ground[0].sn = 1), /cannot bypass enemy Sentinel/);
    assert.throws(() => staged('rebel-assault', s => s.players.p1.space[0].s = 'SOR_225'), /different second Rebel/);
    const unlinked = clone(e.cue); delete unlinked.outcomes.find(c => c.damageType === 'combat').attackId;
    assert.throws(() => resolvePreviewState(e.before, unlinked), /actual attack segment/);
    const baseCounter = clone(e.cue); baseCounter.outcomes.push({ kind: 'damage', card: e.before.players.p1.ground[0], sourceCard: e.before.players.p2.base, seat: 'p1', amount: 1, zone: 'ground', attackId: attack[0].attackId, damageType: 'combat' });
    assert.throws(() => resolvePreviewState(e.before, baseCounter), /base cannot deal combat counter/);
});

test('Heroic draws first, resolves attack-only power, and defeats the actual positive-combat attacker without a future obligation', () => {
    const e = staged('heroic-sacrifice');
    assert.equal(e.cue.outcomes[0].kind, 'draw'); assert.equal(e.p1.deck, 26);
    assert.deepEqual(ids(e.p1.hand), ['a02:heroic-sacrifice:draw']);
    assert.equal(e.p2.base.d, 11); assert.equal(e.p1.ground.length, 1);
    assert.deepEqual(ids(e.p1.discard), [e.cue.source.id, 'a02:p1:marine']);
    assert.equal(e.after.pending, undefined);
    const fake = clone(e.cue); fake.outcomes = fake.outcomes.filter(c => c.kind !== 'attack');
    assert.throws(() => resolvePreviewState(e.before, fake), /actual attack segment/);
});

test('fully Shield-prevented Heroic combat leaves the attacker alive after real unit counter-damage', () => {
    const e = staged('heroic-sacrifice', s => {
        Object.assign(s.players.p1.ground[0], { p: 6, h: 6, status: [{ kind: 'buff', label: '+3/+3 · phase', duration: 'phase' }] });
        s.players.p2.ground[1].u = [{ id: 'test:shield', n: 'Shield', s: null, owner: 'p2', t: 1 }];
    }, (outcomes, before) => {
        const w = before.players.p2.ground[1], m = before.players.p1.ground[0];
        const attack = outcomes.find(c => c.kind === 'attack'), damage = outcomes.find(c => c.damageType === 'combat');
        attack.card = w; attack.zone = 'ground'; damage.card = w; damage.zone = 'ground'; damage.amount = 0;
        const defeatIndex = outcomes.findIndex(c => c.trigger === 'combat-damage');
        outcomes.splice(defeatIndex, 0,
            { kind: 'defeat', card: w.u[0], sourceCard: w, seat: 'p2', amount: 1, zone: 'ground', label: 'SHIELD PREVENTS COMBAT' },
            { kind: 'damage', card: m, sourceCard: w, seat: 'p1', amount: 4, zone: 'ground', damageType: 'combat', attackId: attack.attackId });
    });
    const m = named(e.p1.ground, 'Battlefield Marine'), w = named(e.p2.ground, 'Wampa');
    assert.ok(m); assert.deepEqual([m.p, m.h, m.d, m.x], [6, 6, 5, 1]);
    assert.equal(m.status.length, 1, 'preexisting phase bonus remains; attack bonus does not');
    assert.equal(w.d, 1); assert.equal(w.u.length, 0); assert.equal(e.p2.base.d, 6);
    assert.equal(e.p1.discard.some(c => c.id === m.id), false);
});

test('Karabast uses exhausted source damage counters plus one, with no attack, healing or readiness change', () => {
    const e = staged('karabast');
    assert.deepEqual([e.p1.ground[0].p, e.p1.ground[0].d, e.p1.ground[0].x], [3, 1, 1]);
    assert.equal(named(e.p2.ground, 'Wampa').d, 3);
    assert.deepEqual(e.cue.outcomes.map(c => c.kind), ['damage']);
    const zero = staged('karabast', s => s.players.p1.ground[0].d = 0);
    assert.equal(zero.cue.outcomes[0].amount, 1);
    const power = staged('karabast', s => s.players.p1.ground[0].p = 7);
    assert.equal(power.cue.outcomes[0].amount, 2);
    const bad = clone(e.cue); bad.outcomes[0].amount = 3;
    assert.throws(() => resolvePreviewState(e.before, bad), /damage-plus-one basis/);
});

test('Cause publicly reveals four, counts original Heroism despite discarding one, and keeps an exact chosen top order', () => {
    const e = staged('for-a-cause-i-believe-in');
    assert.equal(e.cue.outcomes[0].deckOperation.visibility, 'public'); assert.equal(e.p2.base.d, 8);
    assert.equal(e.p1.deck, 25); assert.equal(e.p1.hand.length, 0);
    assert.deepEqual(ids(e.p1.knownDeck.slice(0, 2)), ['a02:cause:top:3', 'a02:cause:top:0']);
    assert.deepEqual(ids(e.p1.knownDeck.slice(2)), ids(e.before.players.p1.knownDeck.slice(4)));
    assert.deepEqual(ids(e.p1.discard), [e.cue.source.id, 'a02:cause:top:1', 'a02:cause:top:2']);
    assert.equal(e.p1.space[0].id, 'a02:p1:xwing', 'revealed/discarded X-Wing is a different physical copy');
    assert.ok(e.cue.outcomes.filter(c => c.kind === 'discard').every(c => c.fromZone === 'deck' && c.chooserSeat === 'p1'));
    const wrongTarget = clone(e.cue); wrongTarget.outcomes.find(c => c.kind === 'discard').card = e.before.players.p1.knownDeck[9];
    assert.throws(() => resolvePreviewState(e.before, wrongTarget), /outside the selected group/);
    const repeated = clone(e.cue); repeated.outcomes.push(clone(repeated.outcomes.find(c => c.kind === 'discard')));
    assert.throws(() => resolvePreviewState(e.before, repeated), /missing or already moved/);
});

test('Rallying Cry grants persistent Raid to all current friendly units without inflating resting stats or attacking', () => {
    const e = staged('rallying-cry');
    for (const c of [...e.p1.ground, ...e.p1.space]) {
        const prior = [...e.before.players.p1.ground, ...e.before.players.p1.space].find(p => p.id === c.id);
        assert.deepEqual([c.p, c.h, c.d, c.x], [prior.p, prior.h, prior.d, prior.x]);
        assert.deepEqual(c.status, [{ kind: 'keyword', label: 'Raid 2 · phase', duration: 'phase', keyword: { name: 'Raid', amount: 2 } }]);
    }
    assert.ok([...e.p2.ground, ...e.p2.space].every(c => !c.status)); assert.equal(e.p2.base.d, 6);
    assert.ok(e.cue.outcomes.every(c => c.kind === 'keyword'));
    const stacked = staged('rallying-cry', s => s.players.p1.ground[0].status = [{ kind: 'keyword', label: 'Raid 1', duration: 'phase', keyword: { name: 'Raid', amount: 1 } }]);
    assert.equal(stacked.p1.ground[0].status.reduce((total, s) => total + s.keyword.amount, 0), 3);
    assert.equal(stacked.p1.ground[0].p, 3);
    assert.ok(cardAbilities('rallying-cry')[0].condition.includes('later entrants'));
});

test('Force Throw preserves the selected player as chooser and uses actual discarded printed cost only with a Force unit', () => {
    const e = staged('force-throw');
    assert.equal(e.cue.outcomes[0].chooserSeat, 'p2'); assert.equal(e.cue.outcomes[0].fromZone, 'hand');
    assert.equal(e.p2.hand.length, 0); assert.deepEqual(ids(e.p2.discard), ['a02:p2:takedown-hand']);
    assert.equal(named(e.p2.ground, 'Wampa').d, 4); assert.equal(e.p2.res.ready, 7);
    const missingForce = staged('force-throw', s => Object.assign(s.players.p1.ground[1], { n: 'Echo Base Defender', s: 'SOR_098', p: 4, h: 3 }));
    assert.deepEqual(missingForce.cue.outcomes.map(c => c.kind), ['discard']);
    assert.equal(named(missingForce.p2.ground, 'Wampa').d, 0);
    const empty = staged('force-throw', s => s.players.p2.hand = []);
    assert.deepEqual(empty.cue.outcomes, []);
    const missingDiscard = clone(e.cue); missingDiscard.outcomes.shift();
    assert.throws(() => resolvePreviewState(e.before, missingDiscard), /actual prior discarded card/);
    const falseCost = clone(e.cue); falseCost.outcomes[1].amount = 6;
    assert.throws(() => resolvePreviewState(e.before, falseCost), /printed-cost damage/);
});

test('ordinary replay snapshots do not fabricate attacks, Raid, deck choices, history, formula basis or hidden faces', () => {
    for (const id of ['rebel-assault', 'rallying-cry', 'for-a-cause-i-believe-in', 'the-emperors-legion', 'force-throw']) {
        const e = staged(id), before = clone(e.before), after = clone(e.after);
        for (const state of [before, after]) {
            delete state.defeatedThisPhase;
            for (const p of Object.values(state.players)) { delete p.knownDeck; for (const c of allCards(state)) { delete c.owner; delete c.incarnation; delete c.status; } }
        }
        const game = { header: { t: 'header', v: 1, seed: 1, engine: null, players: [] }, end: null,
            steps: [{ t: 'step', n: 0, state: before }, { t: 'step', n: 1, state: after }] };
        const action = { index: 1, until: 1, seat: 'p1', kind: 'play-event', card: e.cue.source };
        const observed = observedOutcomes(game, action);
        assert.ok(observed.every(c => c.kind !== 'attack' && c.kind !== 'keyword' && !c.deckOperation && !c.basis && !c.defeatPhase && !c.chooserSeat), id);
        assert.ok(observed.every(c => !c.cards), id);
        if (id === 'rallying-cry') assert.deepEqual(observed, []);
    }
});
