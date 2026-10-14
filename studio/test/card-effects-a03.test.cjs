const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createRequire } = require('node:module');
const ts = require('typescript5');
const modules = new Map();
function loadTS(filename) {
    filename = path.resolve(filename);
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} }; modules.set(filename, module);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const requireFromFile = createRequire(filename);
    new Function('require', 'module', 'exports', code)(specifier => {
        const candidate = path.resolve(path.dirname(filename), `${specifier}.ts`);
        return specifier.startsWith('.') && fs.existsSync(candidate) ? loadTS(candidate) : requireFromFile(specifier);
    }, module, module.exports);
    return module.exports;
}
const { A03_DEFINITIONS, A03_COSTS, a03ShowcaseState, a03PreviewOutcomes, a03PreviewPayment } = loadTS(path.join(__dirname, '../src/effects/batchA03.ts'));
const { resolvePreviewState } = loadTS(path.join(__dirname, '../src/effects/previewState.ts'));
const { previewPlayCost } = loadTS(path.join(__dirname, '../src/effects/previewCosts.ts'));
const { previewCue } = loadTS(path.join(__dirname, '../src/effects/preview.ts'));
const { showcaseGame } = loadTS(path.join(__dirname, '../src/effects/showcase.ts'));
const { findCardEffect } = loadTS(path.join(__dirname, '../src/effects/catalogue.ts'));
const { cardAbilities } = loadTS(path.join(__dirname, '../src/effects/abilities.ts'));
const { observedOutcomes } = loadTS(path.join(__dirname, '../src/effects/outcomes.ts'));
const clone = value => structuredClone(value);
const ids = cards => cards.map(c => c.id);
const allCards = state => Object.values(state.players).flatMap(p => [...p.hand, ...p.discard, ...(p.knownDeck ?? []), ...p.ground, ...p.space, ...[...p.ground, ...p.space].flatMap(c => c.u ?? [])]);
function staged(id, modify, modifyCue) {
    const definition = A03_DEFINITIONS.find(c => c.id === id); assert.ok(definition);
    const before = a03ShowcaseState(definition); if (modify) modify(before);
    const cue = { definition, source: before.players.p1.hand.find(c => c.s === definition.setCode), seat: 'p1', target: null, key: `test:${id}:1`,
        outcomes: a03PreviewOutcomes(definition, before, 'p1'), playPayment: a03PreviewPayment(definition, before, 'p1') };
    if (modifyCue) modifyCue(cue, before);
    const savedBefore = clone(before), savedCue = clone(cue), after = resolvePreviewState(before, cue);
    assert.deepEqual(before, savedBefore); assert.deepEqual(cue, savedCue);
    return { definition, before, cue, after, p1: after.players.p1, p2: after.players.p2 };
}
const cardDir = path.join(__dirname, '../../forceteki/test/json/Card');
const cards = fs.readdirSync(cardDir).filter(n => n.endsWith('.json')).map(n => JSON.parse(fs.readFileSync(path.join(cardDir, n))));
const printCode = p => `${p.set}_${String(p.number).padStart(3, '0')}`;
const byPrint = new Map(cards.flatMap(c => (c.setCodes ?? []).map(p => [printCode(p), c])));

test('A03 exact canonical identities, sole aliases, complete costs and real unit/attachment facts match installed source JSON', () => {
    assert.equal(A03_DEFINITIONS.length, 10);
    for (const d of A03_DEFINITIONS) {
        const json = JSON.parse(fs.readFileSync(path.join(cardDir, `${d.id}.json`)));
        assert.equal(d.name, json.title); assert.equal(d.setCode, printCode(json.setId)); assert.equal(json.unique, false);
        assert.equal(json.setCodes.length, 1); assert.deepEqual(A03_COSTS[d.id], { printed: json.cost, aspects: json.aspects });
        for (const alias of json.setCodes.map(printCode)) assert.equal(findCardEffect({ n: json.title, s: alias }).id, d.id);
        const before = a03ShowcaseState(d);
        for (const c of allCards(before)) {
            assert.ok(c.id); assert.ok(c.owner);
            if (!c.s) { assert.ok(c.n === 'Unknown card' || c.t === 1); continue; }
            const json = byPrint.get(c.s); assert.ok(json, c.s);
            assert.equal(c.n, json.subtitle ? `${json.title}: ${json.subtitle}` : json.title);
            if ('d' in c) {
                assert.equal(c.incarnation, `${c.id}:entry-1`); assert.ok(c.d < c.h);
                assert.equal(c.p, json.power + (c.u ?? []).reduce((n, u) => n + u.p, 0));
                assert.equal(c.h, json.hp + (c.u ?? []).reduce((n, u) => n + u.h, 0));
            } else if ('t' in c && !c.t) { assert.equal(c.p, json.upgradePower); assert.equal(c.h, json.upgradeHp); }
        }
    }
    assert.equal(findCardEffect({ n: 'Disarm', s: 'NOPE_216' }), undefined);
});

test('all A03 results pay once, preserve ownership and physical cards except declared token changes, and replay from immutable inputs', () => {
    const payments = [3, 7, 8, 6, 11, 0, 3, 3, 4, 6];
    for (const [i, d] of A03_DEFINITIONS.entries()) {
        const e = staged(d.id), beforeIDs = ids(allCards(e.before));
        assert.equal(previewPlayCost(d, e.before, 'p1', e.cue.playPayment), payments[i]);
        assert.equal(e.p1.res.ready, e.before.players.p1.res.ready - payments[i]); assert.equal(e.p2.res.ready, 7);
        assert.equal(e.p1.discard.filter(c => c.id === e.cue.source.id).length, 1);
        const ceased = d.id === 'precision-fire' ? ['a03:precision:shield'] : d.id === 'bamboozle' ? ['a03:bamboozle:shield', 'a03:bamboozle:experience'] : [];
        const created = d.id === 'asteroid-sanctuary' ? ['a03:asteroid:shield'] : [];
        assert.deepEqual(ids(allCards(e.after)).sort(), [...beforeIDs.filter(id => !ceased.includes(id)), ...created].sort(), d.id);
        assert.equal(new Set(ids(allCards(e.after))).size, allCards(e.after).length);
        const owners = new Map(allCards(e.before).map(c => [c.id, c.owner]));
        for (const c of allCards(e.after)) if (owners.has(c.id)) assert.equal(c.owner, owners.get(c.id));
        for (const p of Object.values(e.after.players)) assert.equal(p.knownDeck.length, p.deck);
        assert.deepEqual(resolvePreviewState(e.before, { ...e.cue, key: `second-clock:${d.id}` }), e.after);
        assert.deepEqual(showcaseGame(d).steps[0].state, e.before);
        assert.deepEqual(previewCue({ definition: d, nonce: 77 }, e.before).outcomes, e.cue.outcomes);
    }
    assert.throws(() => staged('i-had-no-choice', s => s.players.p1.res.ready = 10), /needs 11 ready resources/);
});

test('Precision grants Saboteur to any attacker, conditional Trooper power, all Shield removal before ordinary paired combat', () => {
    const e = staged('precision-fire');
    assert.deepEqual(e.p1.ground[0] && [e.p1.ground[0].p, e.p1.ground[0].h, e.p1.ground[0].d, e.p1.ground[0].x], [3, 3, 2, 1]);
    assert.deepEqual(ids(e.p2.ground), ['a03:p2:sentinel']); assert.equal(e.p2.ground[0].sn, 1);
    assert.deepEqual(ids(e.p2.discard), ['a03:p2:smuggler']); assert.equal(e.p2.base.d, 6);
    assert.equal(e.p1.ground[0].status, undefined);
    const receipts = e.cue.outcomes, shield = receipts.findIndex(o => o.card?.id === 'a03:precision:shield'), damage = receipts.findIndex(o => o.damageType === 'combat');
    assert.ok(shield < damage); assert.equal(receipts.find(o => o.kind === 'attack').combatOrder, 'simultaneous');
    const nonTrooper = staged('precision-fire', s => Object.assign(s.players.p1.ground[0], { n: 'Crafty Smuggler', s: 'SOR_207', p: 2, h: 2 }));
    assert.equal(nonTrooper.cue.outcomes.find(o => o.kind === 'attack').amount, 2);
    assert.equal(nonTrooper.cue.outcomes.some(o => o.kind === 'buff'), false);
    assert.equal(nonTrooper.cue.outcomes.find(o => o.kind === 'keyword').keyword.name, 'Saboteur');
    const twoShields = staged('precision-fire', s => s.players.p2.ground[1].u.push({ id: 'extra:shield', n: 'Shield', s: null, t: 1, owner: 'p2', p: 0, h: 0 }));
    assert.equal(twoShields.cue.outcomes.filter(o => o.kind === 'defeat' && o.card.n === 'Shield').length, 2);
    assert.throws(() => staged('precision-fire', s => s.players.p1.ground[0].x = 1), /ready legal ground/);
});

test('Smoke counts the hand after event departure and retains each player own chosen two with no deck/draw changes', () => {
    const e = staged('smoke-and-cinders');
    assert.deepEqual(ids(e.p1.hand), ['a03:smoke:p1:keep:0', 'a03:smoke:p1:keep:1']);
    assert.deepEqual(ids(e.p2.hand), ['a03:p2:takedown-hand', 'a03:smoke:p2:keep:1']);
    assert.deepEqual(e.cue.outcomes.map(o => [o.seat, o.chooserSeat]), [['p1', 'p1'], ['p1', 'p1'], ['p2', 'p2'], ['p2', 'p2']]);
    assert.deepEqual([e.p1.deck, e.p2.deck, e.p1.discard.length, e.p2.discard.length], [27, 29, 3, 2]);
    for (const n of [0, 1, 2]) {
        const short = staged('smoke-and-cinders', s => { s.players.p1.hand = s.players.p1.hand.slice(0, n + 1); s.players.p2.hand = s.players.p2.hand.slice(0, n); });
        assert.equal(short.cue.outcomes.length, 0); assert.equal(short.p1.hand.length, n); assert.equal(short.p2.hand.length, n);
    }
});

test('Forced Surrender needs explicit current-phase damage by P1, not base counters, card ownership or stale history', () => {
    const e = staged('forced-surrender');
    assert.deepEqual(ids(e.p1.hand), ['a03:forced:draw:0', 'a03:forced:draw:1']); assert.equal(e.p1.deck, 25);
    assert.deepEqual(ids(e.p2.hand), ['a03:p2:takedown-hand']); assert.equal(e.p2.discard.length, 2); assert.equal(e.p2.base.d, 6);
    assert.equal(e.p1.space[0].x, 1, 'earlier attack is not repeated');
    for (const edit of [s => delete s.baseDamagedThisPhase, s => s.baseDamagedThisPhase.round--, s => s.baseDamagedThisPhase.phase = 'regroup',
        s => s.baseDamagedThisPhase.damage[0].player = 'p2', s => s.baseDamagedThisPhase.damage[0].amount = 0]) {
        const onlyDraw = staged('forced-surrender', edit); assert.equal(onlyDraw.p2.hand.length, 3); assert.equal(onlyDraw.p1.hand.length, 2);
    }
    const missing = clone(e.before); delete missing.baseDamagedThisPhase;
    assert.throws(() => resolvePreviewState(missing, e.cue), /current-phase damage/);
    const oppositeOwnership = staged('forced-surrender', s => s.players.p1.space[0].owner = 'p2');
    assert.equal(oppositeOwnership.p2.discard.length, 2, 'actual damage player, not source owner, qualifies');
    const oneDiscard = staged('forced-surrender', s => s.players.p2.hand.splice(0, 2)); assert.equal(oneDiscard.p2.hand.length, 0);
    assert.throws(() => staged('forced-surrender', s => { s.players.p1.deck = 1; s.players.p1.knownDeck.splice(1); }), /failed-draw base damage needs separate explicit receipts/);
});

test('round cannot-ready status blocks declared action/regroup readiness but not a later round or a new incarnation', () => {
    const e = staged('no-good-to-me-dead'), w = e.p2.ground[1];
    assert.deepEqual([w.p, w.h, w.d, w.x], [4, 5, 1, 1]);
    assert.deepEqual(w.status, [{ kind: 'restrict', label: 'Cannot ready · round 9', duration: 'round', restriction: 'cannot-ready', round: 9, incarnation: w.incarnation }]);
    const ready = { kind: 'ready', card: w, seat: 'p2', amount: 1, zone: 'ground', round: 9, incarnation: w.incarnation };
    const receipt = { ...e.cue, source: null, playPayment: undefined, outcomes: [ready] };
    for (const phase of ['action', 'regroup']) {
        const before = clone(e.after); before.phase = phase;
        assert.equal(resolvePreviewState(before, receipt).players.p2.ground[1].x, 1);
    }
    const later = clone(e.after); later.round = 10;
    const expired = resolvePreviewState(later, { ...receipt, outcomes: [{ ...ready, round: 10 }] });
    assert.equal(expired.players.p2.ground[1].x, undefined); assert.deepEqual(expired.players.p2.ground[1].status, []);
    const returned = clone(e.after); returned.players.p2.ground[1].incarnation += ':new';
    const newEntry = resolvePreviewState(returned, { ...receipt, outcomes: [{ ...ready, incarnation: returned.players.p2.ground[1].incarnation }] });
    assert.equal(newEntry.players.p2.ground[1].x, undefined);
    assert.throws(() => resolvePreviewState(returned, receipt), /different unit incarnation/);
    const falseLock = clone(e.cue); falseLock.outcomes[1].round = 8;
    assert.throws(() => resolvePreviewState(e.before, falseLock), /current round and arena incarnation/);
    const departed = resolvePreviewState(e.after, { ...receipt, outcomes: [{ kind: 'return', card: w, seat: 'p2', ownerSeat: 'p2', destination: 'hand' }] });
    assert.equal(departed.players.p2.hand.at(-1).status, undefined);
});

test('I Had No Choice uses opponent selection and distinct owner hand/deck-bottom routes with exact deck order', () => {
    const e = staged('i-had-no-choice'); assert.equal(e.p1.res.ready, 1);
    assert.deepEqual(ids(e.p1.hand), ['a03:p1:marine']); assert.equal(e.p1.hand[0].d, undefined);
    assert.equal(e.p2.deck, 30); assert.deepEqual(ids(e.p2.knownDeck), [...ids(e.before.players.p2.knownDeck), 'a03:p2:wampa']);
    assert.equal(e.p1.ground.length, 1); assert.equal(e.p2.ground.length, 1); assert.equal(e.p2.discard.length, 0);
    assert.ok(e.cue.outcomes.every(o => o.chooserSeat === 'p2' && o.selection === 'opponent'));
    const borrowed = staged('i-had-no-choice', s => s.players.p1.ground[0].owner = 'p2');
    assert.equal(borrowed.p1.hand.length, 0); assert.equal(borrowed.p2.hand.at(-1).id, 'a03:p1:marine');
    const one = clone(e.cue); one.outcomes.pop(); const onlyHand = resolvePreviewState(e.before, one);
    assert.equal(onlyHand.players.p2.deck, 29); assert.equal(onlyHand.players.p2.ground.length, 2);
    const none = resolvePreviewState(e.before, { ...e.cue, outcomes: [] }); assert.equal(none.players.p1.ground.length, 2);
    const wrongOwner = clone(e.cue); wrongOwner.outcomes[1].ownerSeat = 'p1'; wrongOwner.outcomes[1].seat = 'p1';
    assert.throws(() => resolvePreviewState(e.before, wrongOwner), /actual ownership/);
});

test('Bamboozle primary discards the actual other Cunning card plus source once with zero resource charge; normal payment remains 4', () => {
    const e = staged('bamboozle'); assert.equal(e.p1.res.ready, 10);
    assert.deepEqual(ids(e.p1.discard), ['a03:bamboozle:payment', 'a03:bamboozle:event']);
    assert.equal(e.cue.playPayment.cards[0].s, 'SOR_216'); assert.equal(previewPlayCost(e.definition, e.before), 4);
    const normal = resolvePreviewState(e.before, { ...e.cue, playPayment: { kind: 'resources' } });
    assert.equal(normal.players.p1.res.ready, 6); assert.ok(normal.players.p1.hand.some(c => c.id === 'a03:bamboozle:payment'));
    for (const edit of [
        cue => cue.playPayment.cards = [cue.source],
        cue => cue.playPayment.cards.push(cue.playPayment.cards[0]),
        cue => cue.playPayment.sourceId = 'other-source',
        cue => cue.playPayment.cards[0] = { ...cue.playPayment.cards[0], s: 'SOR_074', n: 'Repair' },
        cue => cue.playPayment.cards[0].id = 'unknown'
    ]) { const cue = clone(e.cue); edit(cue); assert.throws(() => resolvePreviewState(e.before, cue), /alternate payment|Cunning/); }
    const notCunning = clone(e.before); notCunning.players.p1.hand[1] = { ...notCunning.players.p1.hand[1], n: 'Repair', s: 'SOR_074' };
    assert.throws(() => resolvePreviewState(notCunning, { ...e.cue, playPayment: a03PreviewPayment(e.definition, notCunning, 'p1') }), /other Cunning/);
    assert.throws(() => resolvePreviewState(e.before, { ...e.cue, outcomes: [...e.cue.outcomes, { kind: 'pay', seat: 'p1', amount: 1, zone: 'resources' }] }), /replaces additional/);
    const merelyDisplayZero = resolvePreviewState(e.before, { ...e.cue, playPayment: undefined, playCost: 0 });
    assert.equal(merelyDisplayZero.players.p1.res.ready, 6, 'display metadata cannot authorize an alternate payment');
});

test('Bamboozle returns selected attachments to each owner, ceases tokens and rolls back stats while retaining exhausted damaged host', () => {
    const e = staged('bamboozle'), w = e.p2.ground[1];
    assert.deepEqual([w.p, w.h, w.d, w.x, w.u.length], [4, 5, 1, 1, 0]);
    assert.deepEqual(ids(e.p1.hand), ['a03:bamboozle:entrenched']); assert.deepEqual(ids(e.p2.hand), ['a03:p2:takedown-hand', 'a03:bamboozle:academy']);
    assert.equal(e.p2.discard.length, 0); assert.equal(allCards(e.after).some(c => c.id === 'a03:bamboozle:shield' || c.id === 'a03:bamboozle:experience'), false);
    const returns = e.cue.outcomes.filter(o => o.kind === 'return');
    assert.ok(returns.every(o => o.sourceCard.id === w.id && o.fromSeat === 'p2' && o.fromZone === 'ground'));
    const wrongHost = clone(e.cue); wrongHost.outcomes[1].sourceCard = e.before.players.p2.ground[0];
    assert.throws(() => resolvePreviewState(e.before, wrongHost), /different host/);
    const wrongOwner = clone(e.cue); wrongOwner.outcomes[2].ownerSeat = 'p2'; wrongOwner.outcomes[2].seat = 'p2';
    assert.throws(() => resolvePreviewState(e.before, wrongOwner), /actual ownership/);
});

test('Disarm floors effective power at zero without HP/damage/pose changes and reset restores the original phase stats', () => {
    const e = staged('disarm'), w = e.p2.ground[1];
    assert.deepEqual([w.p, w.h, w.d, w.x], [0, 5, 1, undefined]);
    assert.deepEqual(w.status, [{ kind: 'debuff', label: '−4/−0 · phase', duration: 'phase' }]);
    const lower = staged('disarm', s => Object.assign(s.players.p2.ground[1], { n: 'Crafty Smuggler', s: 'SOR_207', p: 2, h: 2, d: 0 }));
    assert.equal(lower.p2.ground[1].p, 0, 'printed −4 applied to 2 does not yield effective −2');
    assert.deepEqual(a03ShowcaseState(e.definition), e.before, 'reset restores original stats, not a phase scheduler');
});

test('Shoot First defeats the defending unit before any counterdamage and rejects fabricated counter from that dead unit', () => {
    const e = staged('shoot-first'), m = e.p1.ground[0], t = e.before.players.p2.ground[0];
    assert.deepEqual([m.p, m.h, m.d, m.x], [3, 3, 1, 1]); assert.equal(m.status, undefined);
    assert.deepEqual(ids(e.p2.discard), ['a03:p2:trooper']); assert.equal(e.p2.base.d, 6);
    const attack = e.cue.outcomes.find(o => o.kind === 'attack'); assert.equal(attack.combatOrder, 'attacker-first');
    assert.equal(e.cue.outcomes.filter(o => o.damageType === 'combat').length, 1);
    const impossible = clone(e.cue); impossible.outcomes.push({ kind: 'damage', card: m, seat: 'p1', amount: 3, zone: 'ground', sourceCard: t, attackId: attack.attackId, damageType: 'combat' });
    assert.throws(() => resolvePreviewState(e.before, impossible), /defeated defending unit/);
    assert.throws(() => staged('shoot-first', s => s.players.p2.ground[1].sn = 1), /cannot bypass enemy Sentinel/);
    assert.throws(() => staged('shoot-first', s => s.players.p1.ground[0].x = 1), /ready legal ground/);
});

test('Shield-prevented or nonlethal Shoot First permits surviving defender counterdamage, unlike the defeated-defender primary', () => {
    const shielded = staged('shoot-first', s => {
        Object.assign(s.players.p1.ground[0], { p: 5, h: 5, u: [{ id: 'shoot:academy:marine', n: 'Academy Training', s: 'SOR_120', t: 0, owner: 'p1', p: 2, h: 2 }] });
        s.players.p2.ground[0].u = [{ id: 'shoot:shield', n: 'Shield', s: null, t: 1, owner: 'p2', p: 0, h: 0 }];
    });
    assert.equal(shielded.p2.ground[0].d, 0); assert.equal(shielded.p2.ground[0].u.length, 0);
    assert.deepEqual([shielded.p1.ground[0].d, shielded.p1.ground[0].x], [4, 1]);
    const survives = staged('shoot-first', s => Object.assign(s.players.p2.ground[0], { p: 5, h: 5,
        u: [{ id: 'shoot:academy:trooper', n: 'Academy Training', s: 'SOR_120', t: 0, owner: 'p2', p: 2, h: 2 }] }));
    assert.equal(survives.p2.ground[0].d, 4); assert.equal(survives.p1.ground.some(c => c.id === 'a03:p1:marine'), false);
    assert.ok(survives.p1.discard.some(c => c.id === 'a03:p1:marine'));
    assert.equal(survives.cue.outcomes.filter(o => o.damageType === 'combat').length, 2);
});

test('Asteroid has independent enemy exhaustion and cross-arena printed-cost Shield targets with one stable token', () => {
    const e = staged('asteroid-sanctuary'); assert.equal(e.p2.ground[0].x, 1); assert.equal(e.p1.space[0].x, undefined);
    assert.deepEqual(e.p1.space[0].u, [{ id: 'a03:asteroid:shield', n: 'Shield', s: null, owner: 'p1', t: 1, p: 0, h: 0 }]);
    assert.deepEqual([e.p1.space[0].p, e.p1.space[0].h, e.p1.space[0].d], [2, 3, 0]);
    assert.equal(e.cue.outcomes.find(o => o.kind === 'shield').printedCost, 2);
    const noEnemy = staged('asteroid-sanctuary', s => s.players.p2.ground = []);
    assert.deepEqual(noEnemy.cue.outcomes.map(o => o.kind), ['shield']);
    const noFriendly = staged('asteroid-sanctuary', s => s.players.p1.space = []);
    assert.deepEqual(noFriendly.cue.outcomes.map(o => o.kind), ['exhaust']);
    const expensive = staged('asteroid-sanctuary', s => s.players.p1.space[0].s = 'SOR_164'); // Invalid printed target evidence must not authorize a Shield.
    assert.deepEqual(expensive.cue.outcomes.map(o => o.kind), ['exhaust']);
    const invalidToken = clone(e.cue); invalidToken.outcomes[1].cards[0].id = e.before.players.p1.space[0].id;
    assert.throws(() => resolvePreviewState(e.before, invalidToken), /new stable token identity/);
});

test('Cocky public sequence sums actual printed costs, chooses STOP at four and moves only its revealed prefix to random bottom', () => {
    const e = staged('dont-get-cocky'), op = e.cue.outcomes[0].deckOperation;
    assert.equal(op.visibility, 'public'); assert.deepEqual(op.reveal, { runningTotals: [1, 3, 4], stop: 'chosen', limit: 7, damageThreshold: 7 });
    assert.deepEqual(ids(e.p1.knownDeck), [...ids(e.before.players.p1.knownDeck.slice(3)), 'a03:cocky:top:2', 'a03:cocky:top:1', 'a03:cocky:top:0']);
    assert.equal(e.p1.deck, 27); assert.equal(e.p1.hand.length, 0); assert.equal(e.p2.ground[1].d, 4);
    assert.deepEqual(op.selectedIds, []); assert.equal(e.cue.outcomes.some(o => o.kind === 'draw' || o.kind === 'discard'), false);
    for (const edit of [cue => cue.outcomes[0].deckOperation.reveal.runningTotals[1] = 4,
        cue => cue.outcomes[0].deckOperation.visibility = 'private', cue => cue.outcomes[0].deckOperation.reveal.stop = 'limit',
        cue => cue.outcomes[0].deckOperation.remainingOrder.reverse(), cue => cue.outcomes[1].amount = 7,
        cue => cue.outcomes[1].basis.printedCosts['a03:cocky:top:0'] = 2]) {
        const cue = clone(e.cue); edit(cue); assert.throws(() => resolvePreviewState(e.before, cue), /reveal|printed|search|threshold/);
    }
});

test('Cocky bust deals no damage, can continue up to seven, and short/empty decks do not invent cards or draws', () => {
    const bust = staged('dont-get-cocky', s => { s.players.p1.knownDeck[0].s = 'SOR_164'; s.players.p1.knownDeck[0].n = 'Wampa'; s.players.p1.knownDeck[2].s = 'SOR_172'; s.players.p1.knownDeck[2].n = 'Open Fire'; });
    assert.deepEqual(bust.cue.outcomes[0].deckOperation.reveal.runningTotals, [4, 6, 9]); assert.equal(bust.cue.outcomes.length, 1); assert.equal(bust.p2.ground[1].d, 0);
    const seven = staged('dont-get-cocky', s => { for (let i = 0; i < 7; i++) s.players.p1.knownDeck[i] = { id: `a03:cocky:top:${i}`, n: 'Recruit', s: 'SOR_123', owner: 'p1' }; });
    assert.equal(seven.cue.outcomes[0].deckOperation.reveal.stop, 'limit'); assert.equal(seven.cue.outcomes[1].amount, 7);
    assert.equal(seven.p2.ground.some(c => c.id === 'a03:p2:wampa'), false); assert.deepEqual(ids(seven.p2.discard), ['a03:p2:wampa']);
    const afterBust = staged('dont-get-cocky', s => { for (let i = 0; i < 7; i++) s.players.p1.knownDeck[i] = { id: `a03:cocky:top:${i}`, n: 'Wampa', s: 'SOR_164', owner: 'p1' }; });
    assert.equal(afterBust.cue.outcomes[0].deckOperation.reveal.runningTotals.at(-1), 28); assert.equal(afterBust.cue.outcomes.length, 1);
    const short = staged('dont-get-cocky', s => { s.players.p1.knownDeck.splice(3); s.players.p1.deck = 3; });
    assert.equal(short.cue.outcomes[0].deckOperation.reveal.stop, 'deck-end'); assert.equal(short.p1.deck, 3);
    const empty = staged('dont-get-cocky', s => { s.players.p1.knownDeck = []; s.players.p1.deck = 0; });
    assert.deepEqual(empty.cue.outcomes, []); assert.equal(empty.p2.ground[1].d, 0);
    const zero = staged('dont-get-cocky', s => { s.players.p1.knownDeck[0] = { id: 'a03:cocky:top:0', n: 'Medal Ceremony', s: 'SOR_245', owner: 'p1' };
        s.players.p1.knownDeck[1].id = 'a03:cocky:unrevealed:1'; s.players.p1.knownDeck[2].id = 'a03:cocky:unrevealed:2'; });
    assert.deepEqual(zero.cue.outcomes[0].deckOperation.reveal, { runningTotals: [0], stop: 'chosen', limit: 7, damageThreshold: 7 });
    assert.equal(zero.p2.ground[1].d, 0); assert.equal(zero.p1.deck, 27);
    const missingReveal = clone(bust.cue); missingReveal.outcomes.push({ ...staged('dont-get-cocky').cue.outcomes[1], amount: 7 });
    assert.throws(() => resolvePreviewState(bust.before, missingReveal), /actual sequential public reveal costs/);
});

test('ordinary recordings keep real after truth but never infer alternative payment, ready locks, combat order, history or reveal sequence', () => {
    for (const d of A03_DEFINITIONS) {
        const e = staged(d.id), before = clone(e.before), after = clone(e.after);
        for (const state of [before, after]) {
            delete state.baseDamagedThisPhase;
            for (const p of Object.values(state.players)) { delete p.knownDeck; for (const c of [...p.ground, ...p.space]) { delete c.status; delete c.owner; delete c.incarnation; } }
        }
        const game = { header: { t: 'header', v: 1, seed: 1, engine: null, players: [] }, end: null, steps: [{ t: 'step', n: 0, state: before }, { t: 'step', n: 1, state: after }] };
        const action = { index: 1, until: 1, seat: 'p1', kind: 'play-event', card: e.cue.source };
        const observed = observedOutcomes(game, action);
        assert.ok(observed.every(o => o.kind !== 'restrict' && o.kind !== 'attack' && !o.combatOrder && !o.deckOperation && !o.basis && !o.baseDamagePhase), d.id);
    }
    assert.ok(cardAbilities('no-good-to-me-dead').some(b => b.duration === 'round'));
    assert.ok(cardAbilities('bamboozle')[0].condition.includes('Smuggle'));
});
