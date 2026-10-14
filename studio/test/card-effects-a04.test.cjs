const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createRequire } = require('node:module');
const ts = require('typescript5');
const modules = new Map();
function loadTS(filename) {
    filename = path.resolve(filename); if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} }; modules.set(filename, module);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const local = createRequire(filename);
    new Function('require', 'module', 'exports', code)(specifier => {
        const candidate = path.resolve(path.dirname(filename), `${specifier}.ts`);
        return specifier.startsWith('.') && fs.existsSync(candidate) ? loadTS(candidate) : local(specifier);
    }, module, module.exports); return module.exports;
}
const { A04_DEFINITIONS, A04_COSTS, a04ShowcaseState, a04PreviewOutcomes } = loadTS(path.join(__dirname, '../src/effects/batchA04.ts'));
const { resolvePreviewState } = loadTS(path.join(__dirname, '../src/effects/previewState.ts'));
const { previewPlayCost, previewExtraPayment } = loadTS(path.join(__dirname, '../src/effects/previewCosts.ts'));
const { cardAbilities } = loadTS(path.join(__dirname, '../src/effects/abilities.ts'));
const { observedOutcomes } = loadTS(path.join(__dirname, '../src/effects/outcomes.ts'));
const clone = structuredClone;
const ids = cards => cards.map(c => c.id);
const allCards = state => Object.values(state.players).flatMap(p => [...p.hand, ...p.discard, ...(p.knownDeck ?? []), ...p.ground, ...p.space,
    ...[...p.ground, ...p.space].flatMap(c => [...(c.u ?? []), ...(c.cap ?? [])])]);
function staged(id, modify, choices, modifyCue) {
    const definition = A04_DEFINITIONS.find(c => c.id === id); assert.ok(definition);
    const before = a04ShowcaseState(definition); if (modify) modify(before);
    const cue = { definition, source: before.players.p1.hand.find(c => c.s === definition.setCode), seat: 'p1', target: null,
        key: `test:${id}:1`, outcomes: a04PreviewOutcomes(definition, before, 'p1', choices) };
    if (modifyCue) modifyCue(cue, before);
    const original = clone(before), savedCue = clone(cue), after = resolvePreviewState(before, cue);
    assert.deepEqual(before, original); assert.deepEqual(cue, savedCue);
    return { definition, before, cue, after, p1: after.players.p1, p2: after.players.p2 };
}
const cardDir = path.join(__dirname, '../../forceteki/test/json/Card');
const jsonCards = fs.readdirSync(cardDir).filter(n => n.endsWith('.json')).map(n => JSON.parse(fs.readFileSync(path.join(cardDir, n))));
const printCode = p => `${p.set}_${String(p.number).padStart(3, '0')}`;
const byPrint = new Map(jsonCards.flatMap(c => (c.setCodes ?? []).map(p => [printCode(p), c])));

test('A04 exact identities/sole prints/aspects and complete before unit/attachment/captive facts match installed JSON', () => {
    const canonicalIDs = ['0523973552','2758597010','5494760041','4536594859','3509161777','0302968596','9999079491','8818201543','8645125292','1973545191'];
    for (const [i, definition] of A04_DEFINITIONS.entries()) {
        const json = JSON.parse(fs.readFileSync(path.join(cardDir, `${definition.id}.json`)));
        assert.equal(json.id, canonicalIDs[i]); assert.equal(definition.name, json.title); assert.equal(definition.setCode, printCode(json.setId));
        assert.equal(json.setCodes.length, 1); assert.equal(json.unique, false); assert.deepEqual(A04_COSTS[definition.id], { printed: json.cost, aspects: json.aspects });
        const before = a04ShowcaseState(definition);
        for (const c of allCards(before)) {
            assert.ok(c.id && c.owner); if (!c.s) { assert.ok(c.n === 'Unknown card' || c.t === 1); continue; }
            const source = byPrint.get(c.s); assert.ok(source, c.s); assert.equal(c.n, source.subtitle ? `${source.title}: ${source.subtitle}` : source.title);
            if ('d' in c) { assert.equal(c.incarnation, `${c.id}:entry-1`); assert.ok(c.d < c.h);
                assert.equal(c.p, source.power + (c.u ?? []).reduce((sum, u) => sum + u.p, 0)); assert.equal(c.h, source.hp + (c.u ?? []).reduce((sum, u) => sum + u.h, 0));
            } else if ('t' in c && !c.t) { assert.equal(c.p, source.upgradePower); assert.equal(c.h, source.upgradeHp); }
        }
    }
    assert.equal(A04_DEFINITIONS.length, 10);
});

test('all ten primary results pay source/nested costs exactly once and conserve stable physical identities/owners except explicit token changes', () => {
    const eventCosts = [5,6,9,0,3,6,1,4,1,1];
    for (const [i, definition] of A04_DEFINITIONS.entries()) {
        const e = staged(definition.id), nested = definition.id === 'youre-my-only-hope' ? 1 : 0;
        assert.equal(previewPlayCost(definition, e.before), eventCosts[i]); assert.equal(previewExtraPayment(definition), nested);
        assert.equal(e.p1.res.ready, 10 - eventCosts[i] - nested); assert.equal(e.p2.res.ready, 7);
        assert.equal(e.p1.discard.filter(c => c.id === e.cue.source.id).length, 1);
        const created = e.cue.outcomes.flatMap(o => o.kind === 'buff' && o.duration === 'token' ? ids(o.cards) : []);
        const ceased = definition.id === 'calculated-lethality' ? ['a04:lethality:old-xp', 'a04:lethality:shield'] : [];
        assert.deepEqual(ids(allCards(e.after)).sort(), [...ids(allCards(e.before)).filter(id => !ceased.includes(id)), ...created].sort(), definition.id);
        assert.equal(new Set(ids(allCards(e.after))).size, allCards(e.after).length);
        const owners = new Map(allCards(e.before).map(c => [c.id, c.owner])); for (const c of allCards(e.after)) if (owners.has(c.id)) assert.equal(c.owner, owners.get(c.id));
        for (const p of Object.values(e.after.players)) assert.equal(p.knownDeck.length, p.deck);
        assert.deepEqual(resolvePreviewState(e.before, { ...e.cue, key: `second-clock:${definition.id}` }), e.after);
        assert.deepEqual(a04ShowcaseState(definition), e.before);
    }
    assert.throws(() => staged('galactic-ambition', s => s.players.p1.res.ready = 8), /needs 9 ready resources/);
    assert.throws(() => staged('youre-my-only-hope', s => s.players.p1.res.ready = 3), /additional payment needs 1/);
});

test('Father NO belongs to target controller and draws actual three for P1, while explicit damage/no-target branches stay distinct', () => {
    const e = staged('i-am-your-father'); assert.deepEqual(ids(e.p1.hand), [0,1,2].map(i => `a04:father:draw:${i}`)); assert.equal(e.p1.deck, 24);
    assert.deepEqual([e.p2.ground[1].p, e.p2.ground[1].h, e.p2.ground[1].d, e.p2.ground[1].x], [4,5,1,undefined]);
    assert.equal(e.cue.outcomes[0].choice.controller, 'p2'); assert.equal(e.cue.outcomes[0].choice.decision, 'no'); assert.equal(e.cue.outcomes.some(o => o.kind === 'damage'), false);
    const borrowed = staged('i-am-your-father', s => s.players.p2.ground[1].owner = 'p1'); assert.equal(borrowed.cue.outcomes[0].chooserSeat, 'p2');
    const accepted = staged('i-am-your-father', undefined, { fatherResponse: 'damage' }); assert.equal(accepted.p1.hand.length, 0); assert.equal(accepted.p1.deck, 27);
    assert.equal(accepted.p2.ground.some(c => c.id === 'a04:p2:wampa'), false); assert.deepEqual(ids(accepted.p2.discard), ['a04:p2:wampa']);
    const none = staged('i-am-your-father', s => s.players.p2.ground = []); assert.deepEqual(none.cue.outcomes, []); assert.equal(none.p1.res.ready, 5);
    const wrong = clone(e.cue); wrong.outcomes[0].choice.controller = 'p1'; wrong.outcomes[0].chooserSeat = 'p1'; assert.throws(() => resolvePreviewState(e.before, wrong), /actual target controller/);
    assert.throws(() => staged('i-am-your-father', s => { s.players.p1.knownDeck.splice(2); s.players.p1.deck = 2; }), /failed draws require explicit/);
});

test('Maximum uses distinct stationary current-power Imperials and one surviving target incarnation; first lethal hit stops second', () => {
    const e = staged('maximum-firepower'); assert.equal(e.p2.ground[1].d, 5); assert.equal(e.p1.ground[0].x, 1); assert.equal(e.p1.space[0].x, undefined);
    assert.deepEqual(e.cue.outcomes.map(o => [o.amount, o.sequenceIndex, o.sourceCard.id, o.damageType]), [[3,1,'a04:maximum:trooper','ability'],[2,2,'a04:maximum:tie','ability']]);
    assert.equal(e.cue.outcomes.some(o => ['attack','exhaust'].includes(o.kind)), false);
    const firstLethal = staged('maximum-firepower', s => s.players.p2.ground[1].d = 4); assert.equal(firstLethal.cue.outcomes.filter(o => o.kind === 'damage').length, 1); assert.equal(firstLethal.p2.ground.length, 1);
    const one = staged('maximum-firepower', s => s.players.p1.space = []); assert.equal(one.p2.ground[1].d, 3);
    const none = staged('maximum-firepower', s => { s.players.p1.ground.shift(); s.players.p1.space = []; }); assert.deepEqual(none.cue.outcomes, []);
    const modified = staged('maximum-firepower', s => Object.assign(s.players.p1.ground[0], { p: 5, h: 5, u: [{ id: 'maximum:academy', n: 'Academy Training', s: 'SOR_120', t: 0, p: 2, h: 2, owner: 'p1' }] }));
    assert.equal(modified.cue.outcomes[0].amount, 5); assert.equal(modified.p2.ground.some(c => c.id === 'a04:maximum:target'), false);
    for (const mutate of [cue => cue.outcomes[1].sourceCard = cue.outcomes[0].sourceCard, cue => cue.outcomes[1].targetIncarnation = 'later-entry', cue => cue.outcomes[0].amount = 4]) {
        const cue = clone(e.cue); mutate(cue); assert.throws(() => resolvePreviewState(e.before, cue), /current source power|distinct sources|target incarnation/);
    }
});

test('Ambition plays actual non-Heroism hand card free/exhausted and only successful play printed cost damages own base', () => {
    const e = staged('galactic-ambition'), arrival = e.p1.ground.at(-1); assert.deepEqual([arrival.id,arrival.p,arrival.h,arrival.d,arrival.x], ['a04:ambition:unit',4,5,0,1]);
    assert.equal(e.p1.hand.length, 0); assert.equal(e.p1.base.d, 13); assert.equal(e.p2.base.d, 6); assert.equal(e.p1.res.ready, 1); assert.equal(e.cue.outcomes.some(o => o.kind === 'pay'), false);
    const failed = clone(e.cue); failed.outcomes.shift(); assert.throws(() => resolvePreviewState(e.before, failed), /actual prior play/);
    const none = staged('galactic-ambition', s => s.players.p1.hand.pop()); assert.deepEqual(none.cue.outcomes, []); assert.equal(none.p1.base.d, 9);
    assert.throws(() => staged('galactic-ambition', s => Object.assign(s.players.p1.hand[1], { n: 'Battlefield Marine', s: 'SOR_095' })), /actual non-Heroism/);
});

test('Medal needs actual current-phase Rebel attack history of surviving incarnations, not exhausted pose; tokens stay permanent', () => {
    const e = staged('medal-ceremony'); assert.equal(e.p2.base.d, 12); assert.equal(e.p1.res.ready, 10);
    assert.deepEqual([...e.p1.ground, ...e.p1.space].map(c => [c.p,c.h,c.d,c.x,c.u.length]), [[4,4,1,1,1],[5,4,0,1,1],[3,4,0,1,1]]);
    assert.ok([...e.p1.ground, ...e.p1.space].every(c => c.u[0].t === 1 && c.u[0].p === 1 && !c.status));
    const ready = staged('medal-ceremony', s => delete s.players.p1.ground[0].x); assert.equal(ready.p1.ground[0].u.length, 1);
    for (const edit of [s => delete s.attacksThisPhase, s => s.attacksThisPhase.phase = 'regroup', s => s.attacksThisPhase.round--]) assert.deepEqual(staged('medal-ceremony', edit).cue.outcomes, []);
    const newInc = staged('medal-ceremony', s => s.players.p1.ground[0].incarnation = 'marine:replayed'); assert.equal(newInc.p1.ground[0].u, undefined); assert.equal(newInc.cue.outcomes.length, 2);
    const opposite = staged('medal-ceremony', s => { const c = s.players.p1.space.pop(); s.players.p2.space.push(c); }); assert.equal(opposite.p2.space.at(-1).u.length, 1);
    const missing = clone(e.before); delete missing.attacksThisPhase; assert.throws(() => resolvePreviewState(missing, e.cue), /current-phase attack history/);
});

test('Hope privately inspects actual top then plays directly from deck for 4+2−5=1 without reveal/hand waypoint', () => {
    const e = staged('youre-my-only-hope'); assert.equal(e.p1.res.ready, 6); assert.equal(e.p1.deck, 26); assert.equal(e.p1.hand.length, 0);
    assert.equal(e.p1.ground.at(-1).id, 'a04:hope:top'); assert.equal(e.p1.ground.at(-1).x, 1);
    assert.equal(e.cue.outcomes[0].choice.kind, 'private-top'); assert.equal(e.cue.outcomes[0].choice.decision, 'play-discount');
    assert.equal(e.cue.outcomes.find(o => o.kind === 'play').fromZone, 'deck'); assert.equal(e.cue.outcomes.find(o => o.kind === 'pay').amount, Math.max(0, byPrint.get('SOR_164').cost + 2 - 5));
    assert.equal(e.cue.outcomes.some(o => o.deckOperation || o.kind === 'draw'), false);
    const leave = staged('youre-my-only-hope', undefined, { hopeDecision: 'leave' }); assert.equal(leave.p1.res.ready, 7); assert.equal(leave.p1.deck, 27); assert.deepEqual(leave.p1.knownDeck, leave.before.players.p1.knownDeck);
    const empty = staged('youre-my-only-hope', s => { s.players.p1.knownDeck = []; s.players.p1.deck = 0; }); assert.deepEqual(empty.cue.outcomes, []);
    const free = staged('youre-my-only-hope', s => s.players.p1.base.d = 25); assert.equal(free.p1.res.ready, 7); assert.equal(free.cue.outcomes[0].choice.decision, 'play-free');
    assert.throws(() => staged('youre-my-only-hope', undefined, { hopeDecision: 'play-free' }), /HP threshold/);
    const contradiction = clone(e.cue); contradiction.outcomes[0].choice.decision = 'leave'; assert.throws(() => resolvePreviewState(e.before, contradiction), /left this card in deck/);
    const wrongTop = clone(e.cue); wrongTop.outcomes[0].cards[0].id = 'other-top'; assert.throws(() => resolvePreviewState(e.before, wrongTop), /actual top/);
});

test('Lethality counts three prior upgrades including tokens, directly defeats printed-cost-three host and distributes actual 2+1 XP', () => {
    const e = staged('calculated-lethality'); assert.equal(e.p2.ground.length, 1); assert.deepEqual(ids(e.p2.discard), ['a04:lethality:academy','a04:p2:trooper']);
    assert.deepEqual([e.p1.ground[0].p,e.p1.ground[0].h,e.p1.ground[0].d,e.p1.ground[0].u.length], [5,5,1,2]); assert.deepEqual([e.p1.space[0].p,e.p1.space[0].h,e.p1.space[0].u.length], [3,4,1]);
    assert.ok(e.cue.outcomes.filter(o => o.kind === 'buff').every(o => o.upgradeCountBasis.count === 3 && o.upgradeCountBasis.resolution === 'defeated'));
    assert.equal(allCards(e.after).some(c => c.id === 'a04:lethality:old-xp' || c.id === 'a04:lethality:shield'), false);
    const none = staged('calculated-lethality', s => Object.assign(s.players.p2.ground[0], { p: 3,h: 3,u: [] })); assert.equal(none.cue.outcomes.length, 1); assert.equal(none.p1.ground[0].u, undefined);
    const sameHost = staged('calculated-lethality', s => s.players.p1.space = []); assert.equal(sameHost.p1.ground[0].u.length, 3); assert.equal(sameHost.p1.ground[0].p, 6);
    const noRecipient = staged('calculated-lethality', s => { s.players.p1.ground = []; s.players.p1.space = []; }); assert.equal(noRecipient.cue.outcomes.length, 1);
    const falseCount = clone(e.cue); falseCount.outcomes[1].upgradeCountBasis.count = 2; assert.throws(() => resolvePreviewState(e.before, falseCount), /prior upgrade count/);
    const excess = clone(e.cue); excess.outcomes.push(clone(excess.outcomes[2])); assert.throws(() => resolvePreviewState(e.before, excess), /prior upgrade count/);
    const missing = clone(e.cue); missing.outcomes.shift(); assert.throws(() => resolvePreviewState(e.before, missing), /defeat result/);
    const partial = clone(e.cue); partial.outcomes.pop(); assert.throws(() => resolvePreviewState(e.before, partial), /full declared upgrade count/);
});

test('explicit protected Lethality attempt retains target and every attachment but still awards count-based Experience', () => {
    const e = staged('calculated-lethality', s => {
        const target = s.players.p2.ground.shift(); Object.assign(target, { n: 'Lurking TIE Phantom', s: 'SHD_187', p: 5,h: 5 }); s.players.p2.space.push(target);
    }, { preventDefeat: true });
    const target = e.p2.space.at(-1); assert.equal(target.u.length, 3); assert.equal(e.p2.discard.length, 0); assert.equal(e.cue.outcomes[0].prevented, true);
    assert.equal(e.p1.ground[0].u.length, 2); assert.equal(e.p1.space[0].u.length, 1);
    assert.match(byPrint.get('SHD_187').text, /can't be captured, damaged, or defeated by enemy card abilities/);
    assert.throws(() => staged('calculated-lethality', undefined, { preventDefeat: true }), /actual ability protection/);
});

test('Mystic Force prerequisite changes capacity instead of existing damage, and lethal reduced HP explicitly removes target', () => {
    const e = staged('mystic-reflection'); assert.deepEqual([e.p2.ground[1].p,e.p2.ground[1].h,e.p2.ground[1].d,e.p2.ground[1].x], [2,3,1,undefined]);
    assert.deepEqual(e.p2.ground[1].status, [{ kind: 'debuff', label: '−2/−2 · phase', duration: 'phase' }]); assert.equal(e.cue.outcomes[0].sourceCard.id, 'a04:mystic:force');
    const noForce = staged('mystic-reflection', s => s.players.p1.ground.pop()); assert.deepEqual([noForce.p2.ground[1].p,noForce.p2.ground[1].h,noForce.p2.ground[1].d], [2,5,1]);
    const lethal = staged('mystic-reflection', s => s.players.p2.ground[1].d = 3); assert.equal(lethal.p2.ground.some(c => c.id === 'a04:p2:wampa'), false); assert.equal(lethal.cue.outcomes.some(o => o.kind === 'damage'), false);
    assert.deepEqual(a04ShowcaseState(e.definition), e.before);
});

test('Midnight spends a shared eight-healing budget across four units on both sides while bases, HP and unallocated damage remain', () => {
    const e = staged('midnight-repairs'); assert.deepEqual([...e.p1.ground,...e.p1.space,...e.p2.ground].map(c => c.d), [0,0,1,1,0]);
    assert.equal(e.cue.outcomes.reduce((sum,o) => sum + o.amount, 0), 8); assert.equal(e.p1.base.d, 9); assert.equal(e.p2.base.d, 6); assert.equal(e.p1.res.ready, 6);
    assert.deepEqual(staged('midnight-repairs', undefined, { allocation: {} }).cue.outcomes, []);
    assert.throws(() => staged('midnight-repairs', undefined, { allocation: { 'a04:p2:base': 1 } }), /actual unit/);
    assert.throws(() => staged('midnight-repairs', undefined, { allocation: { 'a04:p1:marine': 3 } }), /existing damage/);
    assert.throws(() => staged('midnight-repairs', undefined, { allocation: { 'a04:p1:marine': 9 } }), /exceeds eight/);
    const bad = clone(e.cue); bad.outcomes.push(clone(bad.outcomes[0])); assert.throws(() => resolvePreviewState(e.before, bad), /existing damage or shared budget/);
});

test('Covert normal hand heal clamps to 0/1/2 but same-host XP always increases actual capacity by one', () => {
    for (const damage of [0,1,2]) {
        const e = staged('covert-strength', s => s.players.p1.ground[0].d = damage), m = e.p1.ground[0];
        assert.deepEqual([m.p,m.h,m.d,m.x,m.u.length], [4,4,0,undefined,1]); assert.equal(e.cue.outcomes[0].amount, damage);
        assert.equal(e.cue.outcomes[0].card.id, e.cue.outcomes[1].card.id); assert.equal(e.p1.deck, 27); assert.equal(e.p1.res.ready, 9);
    }
    assert.ok(cardAbilities('covert-strength').some(b => b.condition.includes('Alternate resource-source')));
});

test('Escape removes only actual captive pocket card and enters true owner arena exhausted with fresh incarnation, not play', () => {
    const e = staged('unexpected-escape'), captor = e.p2.ground[0], rescued = e.p1.ground.at(-1);
    assert.deepEqual(captor.cap, []); assert.equal(captor.x, 1); assert.deepEqual([rescued.id,rescued.p,rescued.h,rescued.d,rescued.x,rescued.incarnation], ['a04:escape:marine',3,3,0,1,'a04:escape:marine:entry-2']);
    assert.equal(rescued.owner, 'p1'); assert.equal(e.p1.res.ready, 9); assert.equal(e.p1.hand.length, 0); assert.equal(e.p2.discard.length, 0);
    assert.equal(e.cue.outcomes[1].entryType, 'rescued'); assert.equal(e.cue.outcomes.some(o => ['play','pay','draw','buff'].includes(o.kind)), false);
    const decline = staged('unexpected-escape', undefined, { rescue: false }); assert.equal(decline.p2.ground[0].cap.length, 1); assert.equal(decline.p1.ground.length, 1);
    const noCaptive = staged('unexpected-escape', s => s.players.p2.ground[0].cap = []); assert.equal(noCaptive.cue.outcomes.length, 1);
    const several = staged('unexpected-escape', s => s.players.p2.ground[0].cap.push({ id: 'other:captive',n: 'Wampa',s: 'SOR_164',owner: 'p1' })); assert.deepEqual(ids(several.p2.ground[0].cap), ['other:captive']);
    for (const mutate of [cue => cue.outcomes[1].ownerSeat = 'p2', cue => delete cue.outcomes[1].ownerSeat, cue => cue.outcomes[1].card.id = 'other:captive',
        cue => cue.outcomes[1].unit.d = 1, cue => cue.outcomes[1].entryType = 'played', cue => cue.outcomes[1].sourceCard.id = 'other:captor']) {
        const cue = clone(e.cue); mutate(cue); assert.throws(() => resolvePreviewState(e.before, cue), /actual captor pocket, known owner/);
    }
    const missingOwner = clone(e.before); delete missingOwner.players.p2.ground[0].cap[0].owner; assert.throws(() => resolvePreviewState(missingOwner, e.cue), /known owner/);
    const repeated = clone(e.cue); repeated.outcomes.push(clone(repeated.outcomes[1])); assert.throws(() => resolvePreviewState(e.before, repeated), /actual captor pocket/);
});

test('rescued Wing Leader enters space without When Played XP, and stale attack incarnation cannot become its new entry', () => {
    // Veteran cost5 can have captured space Wing Leader cost3 via prior Relentless Pursuit; this is not its ground-only When Played capture.
    const e = staged('unexpected-escape', s => Object.assign(s.players.p2.ground[0].cap[0], { n: 'Wing Leader',s: 'SOR_241' }));
    const arrived = e.p1.space.at(-1); assert.deepEqual([arrived.p,arrived.h,arrived.d,arrived.x], [2,1,0,1]); assert.equal(arrived.owner, 'p1');
    assert.equal(e.p1.ground[0].u, undefined); assert.equal(e.p1.space[0].u, undefined); assert.equal(e.cue.outcomes.some(o => o.kind === 'buff'), false);
    const stale = clone(e.before); stale.attacksThisPhase = { round: 9,phase: 'action',attacks: [{ id:'old-attack',attackerId: arrived.id,incarnation: 'old-entry' }] };
    const cue = clone(e.cue); cue.outcomes[1].unit.incarnation = 'old-entry'; assert.throws(() => resolvePreviewState(stale, cue), /fresh rescued entry/);
    assert.match(byPrint.get('SOR_241').text, /When Played/); assert.match(JSON.parse(fs.readFileSync(path.join(cardDir, 'relentless-pursuit.json'))).text, /captures an enemy non-leader unit/);
});

test('snapshot-only recordings do not invent response/peek/history/source formulas/distribution or rescued owner and entry semantics', () => {
    for (const definition of A04_DEFINITIONS) {
        const e = staged(definition.id), before = clone(e.before), after = clone(e.after);
        for (const state of [before,after]) {
            delete state.attacksThisPhase;
            for (const p of Object.values(state.players)) { delete p.knownDeck; for (const c of allCards(state)) { delete c.owner; delete c.incarnation; delete c.status; } }
        }
        const game = { header: { t:'header',v:1,seed:1,engine:null,players:[] },end:null,steps:[{ t:'step',n:0,state:before },{ t:'step',n:1,state:after }] };
        const observed = observedOutcomes(game, { index:1,until:1,seat:'p1',kind:'play-event',card:e.cue.source });
        assert.ok(observed.every(o => !o.choice && !o.attackPhase && !o.basis && !o.upgradeCountBasis && !o.allocation), definition.id);
        for (const receipt of observed.filter(o => o.kind === 'rescue')) { assert.equal(receipt.ownerSeat, undefined); assert.equal(receipt.entryType, undefined); }
    }
});
