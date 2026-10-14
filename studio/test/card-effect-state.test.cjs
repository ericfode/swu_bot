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
const { CARD_EFFECTS } = loadTS(path.join(__dirname, '../src/effects/catalogue.ts'));
const { showcaseGame } = loadTS(path.join(__dirname, '../src/effects/showcase.ts'));
const { previewCue } = loadTS(path.join(__dirname, '../src/effects/preview.ts'));
const { resolvePreviewState } = loadTS(path.join(__dirname, '../src/effects/previewState.ts'));
const { preparePreviewCue, previewSceneKey } = loadTS(path.join(__dirname, '../src/effects/previewStages.ts'));
const { previewExampleStages } = loadTS(path.join(__dirname, '../src/effects/previewStages.ts'));
const { PREVIEW_CARD_COSTS, previewMissingAspects, previewPlayCost, previewExtraPayment } = loadTS(path.join(__dirname, '../src/effects/previewCosts.ts'));

function example(id) {
    const definition = CARD_EFFECTS.find(card => card.id === id);
    const before = showcaseGame(definition).steps[0].state;
    const cue = previewCue({ definition, nonce: 1 }, before);
    const after = resolvePreviewState(before, cue);
    return { before, cue, after, p1: after.players.p1, p2: after.players.p2 };
}
const named = (cards, name) => cards.find(card => card.n === name);
const tokens = (unit, name) => (unit.u ?? []).filter(card => card.n === name);
const arenaCount = player => player.ground.length + player.space.length;

test('Gate exposes both independent boundaries and each starts from the unused paid protection', () => {
    const definition = CARD_EFFECTS.find(card => card.id === 'close-the-shield-gate');
    assert.deepEqual(previewExampleStages(definition.id), ['play', 'next-action', 'phase-end']);
    const initial = showcaseGame(definition).steps[0].state, saved = structuredClone(initial);
    const primary = preparePreviewCue({ definition, nonce: 1 }, initial);
    for (const stage of ['next-action', 'phase-end']) {
        const boundary = preparePreviewCue({ definition, nonce: 2, stage }, initial);
        assert.deepEqual(boundary.transition.before, primary.transition.after);
        assert.deepEqual(boundary.source, primary.source);
        assert.equal(boundary.playCost, undefined); assert.equal(boundary.playPayment, undefined);
        assert.equal(boundary.transition.after.players.p1.base.d, 9);
        assert.deepEqual(boundary.transition.after.players.p1.base.damageProtection, []);
        for (const side of ['p1', 'p2']) {
            assert.deepEqual(boundary.transition.after.players[side].res, primary.transition.after.players[side].res);
            assert.deepEqual(boundary.transition.after.players[side].resources, primary.transition.after.players[side].resources);
            assert.deepEqual(boundary.transition.after.players[side].hand, primary.transition.after.players[side].hand);
            assert.equal(boundary.transition.after.players[side].deck, primary.transition.after.players[side].deck);
        }
        assert.equal(boundary.transition.after.players.p1.discard.filter(c => c.id === primary.source.id).length, 1);
        const tie = boundary.transition.after.players.p2.space.find(c => c.id === 'a14:p2:tie');
        assert.equal(!!tie.x, stage === 'next-action', 'expiry cannot fabricate the separately authored attack');
        assert.deepEqual(preparePreviewCue({ definition, nonce: 3, stage }, initial).transition, boundary.transition);
    }
    assert.deepEqual(initial, saved);
    assert.deepEqual(preparePreviewCue({ definition, nonce: 4 }, initial).transition, primary.transition);
});

test('Heat explicit phase-end restores only its continuing-entry keywords without ordinary regroup steps', () => {
    const definition = CARD_EFFECTS.find(card => card.id === 'in-the-heat-of-battle');
    assert.deepEqual(previewExampleStages(definition.id), ['play', 'phase-end']);
    const initial = showcaseGame(definition).steps[0].state, primary = preparePreviewCue({ definition, nonce: 1 }, initial);
    const boundary = preparePreviewCue({ definition, nonce: 2, stage: 'phase-end' }, initial);
    assert.deepEqual(boundary.transition.before, primary.transition.after); assert.deepEqual(boundary.source, primary.source);
    assert.equal(boundary.playCost, undefined); assert.equal(boundary.playPayment, undefined);
    const expected = structuredClone(primary.transition.after);
    for (const side of ['p1', 'p2']) for (const zone of ['ground', 'space']) {
        for (const unit of expected.players[side][zone]) {
            const original = initial.players[side][zone].find(c => c.id === unit.id);
            unit.status = structuredClone(original.status ?? []);
            if (original.sn === undefined) delete unit.sn; else unit.sn = original.sn;
        }
    }
    assert.deepEqual(boundary.transition.after, expected, 'no readying, draw, counter or unrelated status changes');
    assert.deepEqual(preparePreviewCue({ definition, nonce: 3, stage: 'phase-end' }, initial).transition, boundary.transition);
    assert.deepEqual(preparePreviewCue({ definition, nonce: 4 }, initial).transition, primary.transition);
});

test('the next-action showcase begins at the paid immediate ending and consumes only the witnessed later action', () => {
    const definition = CARD_EFFECTS.find(card => card.id === 'give-in-to-your-anger');
    const initial = showcaseGame(definition).steps[0].state;
    const primary = preparePreviewCue({ definition, nonce: 1 }, initial);
    const selected = { definition, nonce: 2, stage: 'next-action' };
    const boundary = preparePreviewCue(selected, initial);
    assert.deepEqual(boundary.transition.before, primary.transition.after);
    assert.equal(primary.transition.after.players.p2.ground.find(c => c.id === 'a06:p2:trooper').d, 1);
    assert.equal(primary.transition.after.nextActionConstraints.length, 1, 'ordinary event completion cannot consume a later action');
    assert.equal(boundary.playCost, undefined);
    assert.equal(boundary.playPayment, undefined);
    assert.equal(boundary.key, previewSceneKey(selected));
    assert.notEqual(boundary.key, primary.key);
    const after = boundary.transition.after;
    assert.deepEqual(after.players.p1.res, primary.transition.after.players.p1.res);
    assert.equal(after.players.p1.discard.filter(c => c.id === 'a06:give-in-to-your-anger:event').length, 1);
    assert.equal(after.players.p1.ground.some(c => c.id === 'a06:p1:defender'), false);
    assert.equal(after.players.p2.ground.some(c => c.id === 'a06:p2:trooper'), false);
    assert.equal(after.nextActionConstraints.length, 0);
    assert.deepEqual(preparePreviewCue({ ...selected, nonce: 9 }, initial).transition, boundary.transition, 'replaying the boundary has no accumulated payment or combat');
    assert.deepEqual(preparePreviewCue({ definition, nonce: 10 }, initial).transition, primary.transition, 'selecting the ordinary example restores its pending state');
    assert.throws(() => preparePreviewCue({ definition: CARD_EFFECTS[0], nonce: 1, stage: 'next-action' }, showcaseGame(CARD_EFFECTS[0]).steps[0].state), /no authored next-action/);
});

test('all examples settle into a fresh board and consume their source event exactly once', () => {
    for (const definition of CARD_EFFECTS) {
        const before = showcaseGame(definition).steps[0].state;
        const cue = previewCue({ definition, nonce: 1 }, before);
        const saved = structuredClone({ before, cue });
        const after = resolvePreviewState(before, cue);
        assert.deepEqual({ before, cue }, saved, `${definition.id}: input data stays immutable`);
        assert.notEqual(after, before);
        const sourceMatch = card => cue.source.id ? card.id === cue.source.id : card.n === cue.source.n && card.s === cue.source.s;
        assert.equal(after.players.p1.hand.some(sourceMatch), false, `${definition.id}: source leaves hand`);
        const existingCopies = definition.id === 'restock' ? 0 : before.players.p1.discard.filter(sourceMatch).length;
        assert.equal(after.players.p1.discard.filter(sourceMatch).length,
        existingCopies + (definition.id === 'resupply' ? 0 : 1),
        `${definition.id}: event resolves once; an older matching copy remains unless recovered`);
        assert.deepEqual(resolvePreviewState(before, cue), after, `${definition.id}: replay starts from the same original board`);
        const replay = previewCue({ definition, nonce: 2 }, before);
        assert.deepEqual(resolvePreviewState(before, replay), after, `${definition.id}: replay clock cannot change resulting card identities`);
        for (const player of Object.values(after.players)) {
            assert.ok(player.deck >= 0);
            assert.ok(player.res.ready >= 0 && player.res.ready <= player.res.total);
        }
    }
});

test('single damage, lethal damage, defeat and arena wipe leave the correct persistent units and piles', () => {
    for (const id of ['open-fire', 'force-lightning', 'aggression']) {
        const { p2 } = example(id);
        assert.equal(named(p2.ground, 'Wampa').d, 4, id);
        assert.equal(arenaCount(p2), 3, id);
    }
    assert.equal(example('force-lightning').p1.res.ready, 0, 'five resources play the event, then two pay for four damage');
    for (const id of ['takedown', 'vanquish', 'power-of-the-dark-side']) {
        const { p2 } = example(id);
        assert.equal(named(p2.ground, 'Death Trooper'), undefined, id);
        assert.equal(named(p2.discard, 'Death Trooper')?.s, 'SOR_033', id);
        assert.equal(arenaCount(p2), 2, id);
    }
    for (const id of ['force-choke', 'overwhelming-barrage', 'command']) {
        const { p2 } = example(id);
        assert.equal(named(p2.ground, 'Wampa'), undefined, id);
        assert.equal(named(p2.discard, 'Wampa')?.s, 'SOR_164', id);
        assert.equal(arenaCount(p2), 2, id);
    }
    const wipe = example('superlaser-blast');
    assert.equal(arenaCount(wipe.p1), 0);
    assert.equal(arenaCount(wipe.p2), 0);
    assert.equal(wipe.p1.discard.length, 8);
    assert.equal(wipe.p2.discard.length, 3);
    assert.deepEqual(wipe.p1.base, wipe.before.players.p1.base, 'the beam does not damage bases');
    assert.deepEqual(wipe.p2.base, wipe.before.players.p2.base);
    const bomb = example('bombing-run');
    assert.equal(bomb.p1.ground.length, 0);
    assert.equal(bomb.p1.space.length, 1);
    assert.equal(bomb.p2.ground.length, 1);
    assert.equal(bomb.p2.space.length, 1);
    assert.equal(bomb.p2.ground[0].n, 'Wampa');
    assert.equal(bomb.p2.ground[0].d, 3);
    assert.equal(bomb.p1.discard.length, 7);
    assert.equal(bomb.p2.discard.length, 1);
});

test('stat changes, healing, tokens and the optional attack persist after the overlay ends', () => {
    const opened = example('make-an-opening');
    assert.deepEqual([named(opened.p2.ground, 'Wampa').p, named(opened.p2.ground, 'Wampa').h, named(opened.p2.ground, 'Wampa').d], [2, 3, 0]);
    assert.equal(opened.p1.base.d, 7);
    assert.deepEqual(named(opened.p2.ground, 'Wampa').status?.map(({ kind, duration }) => ({ kind, duration })), [{ kind: 'debuff', duration: 'phase' }]);
    assert.equal(example('repair').p1.base.d, 6);
    const barrage = named(example('overwhelming-barrage').p1.ground, 'Battlefield Marine');
    assert.deepEqual([barrage.p, barrage.h, barrage.d, tokens(barrage, 'Experience').length], [5, 5, 1, 0]);
    assert.deepEqual(barrage.status?.map(({ kind, duration }) => ({ kind, duration })), [{ kind: 'buff', duration: 'phase' }]);
    const command = named(example('command').p1.ground, 'Battlefield Marine');
    assert.deepEqual([command.p, command.h, command.d, tokens(command, 'Experience').length], [5, 5, 1, 2]);
    assert.equal(command.status, undefined, 'Experience remains permanent counted tokens, not a phase buff');
    const vigilance = example('vigilance');
    assert.equal(vigilance.p1.base.d, 4);
    assert.equal(tokens(vigilance.p1.ground[0], 'Shield').length, 1);
    const aggression = example('aggression');
    assert.equal(aggression.p1.ground[0].x, undefined);
    const force = example('the-force-is-with-me');
    const marine = force.p1.ground[0];
    assert.deepEqual([marine.p, marine.h, marine.d, marine.x], [5, 5, 1, 1]);
    assert.equal(tokens(marine, 'Experience').length, 2);
    assert.equal(tokens(marine, 'Shield').length, 1);
    assert.equal(marine.status, undefined, 'the optional attack does not turn Experience into a phase bonus');
    assert.equal(force.p2.base.d, 11);
    assert.equal(new Set(marine.u.map(card => card.id)).size, 3);
    const suppressed = named(example('force-lightning').p2.ground, 'Wampa');
    assert.deepEqual(suppressed.status?.map(({ kind, duration }) => ({ kind, duration })), [{ kind: 'suppressed', duration: 'phase' }]);
});

test('zone routes update the underlying cards, deck counts, resources and readiness', () => {
    for (const id of ['waylay', 'cunning']) {
        const { p2 } = example(id);
        assert.equal(named(p2.ground, 'Wampa'), undefined, id);
        assert.equal(p2.hand.length, 4, id);
        assert.deepEqual(Object.keys(named(p2.hand, 'Wampa')).sort(), ['id', 'n', 's'].filter(key => key !== 'id' || named(p2.hand, 'Wampa').id).sort());
        assert.equal(p2.discard.length, 0, id);
    }
    const cunning = example('cunning');
    assert.equal(cunning.p2.ground[0].x, 1);
    assert.equal(cunning.p2.space[0].x, 1);
    const choke = example('force-choke');
    assert.equal(choke.p2.deck, 28);
    assert.equal(choke.p2.hand.length, 4);
    assert.equal(choke.p2.hand.at(-1).n, 'Unknown card');
    assert.equal(choke.p2.hand.at(-1).s, null);
    const restock = example('restock');
    assert.equal(restock.p1.deck, 31);
    assert.equal(restock.p1.discard.length, 1, 'played Restock remains in discard after the four earlier cards leave');
    assert.equal(restock.p1.discard[0].n, 'Restock');
    const supplied = example('resupply');
    assert.deepEqual(supplied.p1.res, { ready: 2, total: 8 });
    assert.equal(supplied.p1.discard.length, 4, 'the event itself becomes an exhausted resource');
    const spark = example('spark-of-rebellion');
    assert.equal(spark.p2.hand.length, 2);
    assert.equal(spark.p2.discard.length, 1);
    assert.equal(spark.p2.discard[0].n, 'Takedown');
});

test('instance ids identify copies and unknown ids or ambiguous names cannot remove the wrong unit', () => {
    const { before, cue } = example('vanquish');
    const target = before.players.p2.ground[0];
    target.id = 'first-copy';
    before.players.p2.ground.push({ ...target, id: 'second-copy' });
    cue.outcomes = [{ kind: 'defeat', card: { ...target, id: 'second-copy' }, seat: 'p2', zone: 'discard' }];
    const after = resolvePreviewState(before, cue);
    assert.ok(after.players.p2.ground.some(card => card.id === 'first-copy'));
    assert.ok(!after.players.p2.ground.some(card => card.id === 'second-copy'));
    assert.equal(after.players.p2.discard[0].id, 'second-copy');
    cue.outcomes[0].card.id = 'missing-id';
    assert.equal(resolvePreviewState(before, cue).players.p2.ground.length, 3);
    delete cue.outcomes[0].card.id;
    assert.equal(resolvePreviewState(before, cue).players.p2.ground.length, 3);
});

test('a no-id Restock is resolved by its original zone even when its played copy enters discard', () => {
    const { before, cue } = example('restock');
    for (const player of Object.values(before.players)) {
        for (const zone of ['hand', 'discard', 'ground', 'space']) for (const card of player[zone]) delete card.id;
    }
    const fresh = previewCue({ definition: cue.definition, nonce: 2 }, before);
    const after = resolvePreviewState(before, fresh);
    assert.equal(after.players.p1.discard.length, 1);
    assert.equal(after.players.p1.discard[0].n, 'Restock');
    assert.equal(after.players.p1.deck, before.players.p1.deck + 4);
});

test('recover-to-hand, hidden mill and bounded healing work without invented card faces or negative counts', () => {
    const { before, cue } = example('repair');
    before.players.p1.deck = 2;
    before.players.p1.base.d = 1;
    cue.outcomes = [
        { kind: 'recover', card: before.players.p1.discard[1], seat: 'p1', zone: 'hand', amount: 1 },
        { kind: 'mill', seat: 'p1', zone: 'discard', amount: 6 },
        { kind: 'heal', card: before.players.p1.base, seat: 'p1', zone: 'base', amount: 3 },
        { kind: 'pay', seat: 'p1', zone: 'resources', amount: 4 },
        { kind: 'cost', seat: 'p1', zone: 'resources', amount: -1 }
    ];
    const after = resolvePreviewState(before, cue);
    assert.equal(after.players.p1.hand[0].n, 'Rebel Pathfinder');
    assert.equal(after.players.p1.deck, 0);
    const hidden = after.players.p1.discard.filter(card => card.n === 'Unknown card');
    assert.equal(hidden.length, 2);
    assert.equal(new Set(hidden.map(card => card.id)).size, 2);
    assert.ok(hidden.every(card => card.s === null));
    assert.equal(after.players.p1.base.d, 0);
    assert.deepEqual(after.players.p1.res, { ready: 0, total: 7 });
});

test('upgrade removal preserves its unit; returning an upgraded unit strips attachments from the hand card', () => {
    const { before, cue } = example('waylay');
    const unit = before.players.p2.ground[1];
    unit.u = [{ n: 'Lightsaber', s: 'SOR_054', id: 'saber', t: 0 }, { n: 'Shield', s: null, id: 'shield', t: 1 }];
    cue.outcomes = [{ kind: 'defeat', card: unit.u[0], seat: 'p2', zone: 'discard' }];
    const stripped = resolvePreviewState(before, cue);
    assert.equal(stripped.players.p2.ground.length, 2);
    assert.equal(stripped.players.p2.ground[1].u.length, 1);
    assert.equal(stripped.players.p2.discard[0].id, 'saber');
    cue.outcomes = [{ kind: 'return', card: unit, seat: 'p2', zone: 'hand' }];
    const returned = resolvePreviewState(before, cue);
    assert.equal(returned.players.p2.ground.length, 1);
    assert.equal(returned.players.p2.hand.at(-1).u, undefined);
    assert.equal(returned.players.p2.discard.length, 1, 'the non-token upgrade is discarded; the Shield ceases to exist');
    assert.equal(returned.players.p2.discard[0].id, 'saber');
    cue.outcomes = [
        { kind: 'defeat', card: unit, seat: 'p2', zone: 'discard' },
        { kind: 'defeat', card: unit.u[0], seat: 'p2', zone: 'discard' }
    ];
    const defeated = resolvePreviewState(before, cue);
    assert.equal(defeated.players.p2.discard.length, 2, 'unit and upgrade departure receipts never discard the same attachment twice');
    assert.equal(defeated.players.p2.discard.filter(card => card.id === 'saber').length, 1);
});

test('every example pays its verified play cost or explicit alternate payment exactly once', () => {
    const expected = [
        ['open-fire', 5], ['force-lightning', 5], ['force-choke', 5], ['takedown', 4], ['vanquish', 5],
        ['superlaser-blast', 10], ['overwhelming-barrage', 7], ['bombing-run', 7], ['make-an-opening', 3], ['repair', 1],
        ['restock', 1], ['resupply', 3], ['command', 6], ['vigilance', 6], ['aggression', 8], ['cunning', 8],
        ['power-of-the-dark-side', 5], ['the-force-is-with-me', 4], ['waylay', 5], ['spark-of-rebellion', 4],
        ['moment-of-peace', 1], ['mission-briefing', 5], ['keep-fighting', 4], ['outmaneuver', 5], ['attack-pattern-delta', 5],
        ['power-failure', 4], ['change-of-heart', 8], ['sneak-attack', 4], ['recruit', 1], ['strike-true', 3],
        ['search-your-feelings', 6], ['it-binds-all-things', 2], ['the-emperors-legion', 4], ['rebel-assault', 1], ['uwing-reinforcement', 7],
        ['heroic-sacrifice', 3], ['karabast', 4], ['for-a-cause-i-believe-in', 5], ['rallying-cry', 7], ['force-throw', 3],
        ['precision-fire', 3], ['smoke-and-cinders', 7], ['forced-surrender', 8], ['no-good-to-me-dead', 6], ['i-had-no-choice', 11],
        ['bamboozle', 0], ['disarm', 3], ['shoot-first', 3], ['asteroid-sanctuary', 4], ['dont-get-cocky', 6],
        ['i-am-your-father', 5], ['maximum-firepower', 6], ['galactic-ambition', 9], ['medal-ceremony', 0], ['youre-my-only-hope', 3],
        ['calculated-lethality', 6], ['mystic-reflection', 1], ['midnight-repairs', 4], ['covert-strength', 1], ['unexpected-escape', 1],
        ['evidence-of-the-crime', 3], ['fell-the-dragon', 4], ['rivals-fall', 6], ['remnant-reserves', 6], ['palpatines-return', 8],
        ['spark-of-hope', 2], ['rule-with-respect', 4], ['enforced-loyalty', 4], ['endless-legions', 16], ['commission', 1],
        ['timely-intervention', 1], ['moment-of-glory', 3], ['choose-sides', 7], ['give-in-to-your-anger', 5], ['headhunting', 6],
        ['cripple-authority', 4], ['the-chaos-of-war', 7], ['desperate-attack', 3], ['detention-block-rescue', 5], ['pillage', 6],
        ['bravado', 5], ['triple-dark-raid', 7], ['let-the-wookiee-win', 4], ['spare-the-target', 5], ['a-new-adventure', 6],
        ['final-showdown', 10], ['look-the-other-way', 2], ['bounty-posting', 3], ['ma-klounkee', 3], ['swoop-down', 3],
        ['surprise-strike', 4], ['relentless-pursuit', 5], ['evacuate', 8], ['altering-the-deal', 3], ['no-bargain', 5],
        ['smugglers-aid', 3], ['this-is-the-way', 2], ['confiscate', 1], ['a-fine-addition', 2], ['lethal-crackdown', 6],
        ['hello-there', 3], ['equalize', 5], ['i-have-the-high-ground', 1], ['grievous-reassembly', 2], ['guarding-the-way', 2],
        ['disruptive-burst', 3], ['death-by-droids', 5], ['the-invasion-of-christophsis', 7], ['reprocess', 5], ['consolidation-of-power', 8],
        ['synchronized-strike', 2], ['petition-the-senate', 3], ['manufactured-soldiers', 5], ['pyrrhic-assault', 5], ['outflank', 1],
        ['tactical-advantage', 1], ['the-clone-wars', 2], ['encouraging-leadership', 3], ['take-captive', 3], ['in-defense-of-kamino', 4],
        ['corner-the-prey', 5], ['selfdestruct', 6], ['bold-resistance', 5], ['unlimited-power', 10], ['daring-raid', 3],
        ['grenade-strike', 4], ['grim-resolve', 4], ['blood-sport', 5], ['strategic-analysis', 7], ['caught-in-the-crossfire', 8],
        ['guerilla-insurgency', 10], ['planetary-invasion', 8], ['wartime-profiteering', 5], ['unnatural-life', 7], ['on-the-doorstep', 8],
        ['clear-the-field', 4], ['creative-thinking', 4], ['aid-from-the-innocent', 7], ['impropriety-among-thieves', 8], ['in-pursuit', 2],
        ['political-pressure', 3], ['unmasking-the-conspiracy', 3], ['breaking-in', 4], ['now-there-are-two-of-them', 5], ['prisoner-of-war', 6],
        ['droid-deployment', 4], ['merciless-contest', 5], ['execute-order-66', 6], ['heroes-on-both-sides', 2], ['sword-and-shield-maneuver', 2],
        ['drop-in', 4], ['private-manufacturing', 2], ['power-from-pain', 5], ['no-glory-only-results', 7], ['youre-all-clear-kid', 2],
        ['close-the-shield-gate', 1], ['covering-the-wing', 2], ['in-the-heat-of-battle', 2], ['direct-hit', 4], ['out-the-airlock', 5],
        ['nebula-ignition', 9], ['apology-accepted', 3], ['scramble-fighters', 9], ['unity-of-purpose', 8], ['salvage', 0],
        ['all-wings-report-in', 1], ['dogfight', 1], ['tandem-assault', 1], ['air-superiority', 2], ['eject', 2],
        ['lightspeed-assault',2], ['prepare-for-takeoff',2], ['focus-fire',4], ['timely-reinforcements',5], ['turbolaser-salvo',7],
        ['no-disintegrations',7], ['they-hate-that-ship',3], ['trench-run',3], ['fight-fire-with-fire',3], ['hotshot-maneuver',3]
    ];
    assert.equal(expected.length, CARD_EFFECTS.length, 'new scenes need a reviewed legal payment expectation');
    for (const [id, playCost] of expected) {
        const { before, cue, after } = example(id);
        const extra = id === 'they-hate-that-ship' ? 5 : id === 'force-lightning' || id === 'palpatines-return' || id === 'salvage' || id === 'timely-intervention' || id === 'a-fine-addition' || id === 'the-clone-wars' ? 2 : id === 'sneak-attack' ? 3 : id === 'youre-my-only-hope' ? 1 : id === 'unnatural-life' ? 4 : id === 'now-there-are-two-of-them' ? 1 : 0;
        const available = before.players.p1.res;
        assert.equal(previewPlayCost(cue.definition, before, 'p1', cue.playPayment), playCost, id);
        assert.equal(previewExtraPayment(cue.definition), extra, id);
        assert.ok(available.ready >= playCost + extra && available.total >= available.ready, id);
        assert.equal(after.players.p1.res.ready, available.ready - playCost - extra - (id === 'guerilla-insurgency' ? 1 : 0), id);
        assert.equal(after.players.p1.res.total, available.total + (id === 'resupply' || id === 'spark-of-hope' ? 1 : id === 'endless-legions' ? -3 : id === 'guerilla-insurgency' ? -1 : 0), id);
        assert.deepEqual(after.players.p2.res, { ...before.players.p2.res, ready: before.players.p2.res.ready - (id === 'look-the-other-way' ? 2 : 0), total: before.players.p2.res.total - (id === 'guerilla-insurgency' ? 1 : 0) }, `${id}: only explicit opponent payment or resource defeat changes P2 resources`);
        assert.deepEqual(resolvePreviewState(before, cue).players.p1.res, after.players.p1.res, `${id}: replay pays from the same initial resources`);
    }
});

test('duplicate aspect symbols each require their own provider and arena units do not supply aspects', () => {
    assert.deepEqual(previewMissingAspects(['command', 'command'], ['command', 'vigilance', 'heroism']), ['command']);
    assert.deepEqual(previewMissingAspects(['aggression', 'aggression'], ['command', 'vigilance', 'heroism']), ['aggression', 'aggression']);
    assert.deepEqual(previewMissingAspects(['vigilance', 'vigilance'], ['vigilance', 'vigilance']), []);
    const { before, cue } = example('open-fire');
    before.players.p1.ground.push({ n: 'Darth Vader', s: 'SOR_010', id: 'unit-vader', p: 5, h: 8, d: 0 });
    assert.equal(previewPlayCost(cue.definition, before), 5, 'an Aggression unit does not pay the event aspect requirement');
    before.players.p1.leader = { n: 'Darth Vader', s: 'SOR_010', dep: 0, x: 0 };
    assert.equal(previewPlayCost(cue.definition, before), 3, 'an Aggression leader supplies the matching aspect');
});

test('Force Choke discount needs a friendly Force unit and is not applied twice by its visual receipt', () => {
    const { before, cue, after } = example('force-choke');
    assert.equal(previewPlayCost(cue.definition, before), 5);
    cue.outcomes.push({ kind: 'cost', seat: 'p1', zone: 'resources', amount: -1 });
    assert.equal(resolvePreviewState(before, cue).players.p1.res.ready, after.players.p1.res.ready);
    before.players.p1.ground = before.players.p1.ground.filter(card => card.s !== 'SOR_051');
    assert.equal(previewPlayCost(cue.definition, before), 6, 'Luke as an undeployed leader is not a Force unit in play');
    before.players.p2.ground.push({ n: 'Luke Skywalker: Jedi Knight', s: 'SOR_051', id: 'opponent-force-unit', p: 6, h: 7, d: 0 });
    assert.equal(previewPlayCost(cue.definition, before), 6, 'the opponent controlling a Force unit grants no discount');
});

test('insufficient play or additional resources reject an invalid example instead of silently paying less', () => {
    const { before, cue } = example('force-lightning');
    assert.deepEqual(before.players.p1.res, { ready: 7, total: 7 });
    before.players.p1.res.ready = 4;
    const lowPlay = structuredClone(before);
    assert.throws(() => resolvePreviewState(before, cue), /play cost needs 5 ready resources; only 4 remain/);
    assert.deepEqual(before, lowPlay, 'failed simulation leaves its input board untouched');
    before.players.p1.res.ready = 6;
    const lowExtra = structuredClone(before);
    assert.throws(() => resolvePreviewState(before, cue), /additional payment needs 2 ready resources; only 1 remain/);
    assert.deepEqual(before, lowExtra);
    const laser = example('superlaser-blast');
    assert.deepEqual(laser.before.players.p1.res, { ready: 10, total: 10 });
    assert.deepEqual(laser.p1.res, { ready: 0, total: 10 });
});

const dataDirectory = path.resolve(__dirname, '../../forceteki/test/json/Card');
test('verified preview costs and fixture providers agree with installed read-only card data', { skip: !fs.existsSync(dataDirectory) }, () => {
    for (const definition of CARD_EFFECTS) {
        const card = JSON.parse(fs.readFileSync(path.join(dataDirectory, `${definition.id}.json`), 'utf8'));
        const cost = PREVIEW_CARD_COSTS[definition.id];
        assert.deepEqual({ printed: cost.printed, aspects: cost.aspects }, { printed: card.cost, aspects: card.aspects }, definition.id);
        assert.ok(card.setCodes.some(print => `${print.set}_${String(print.number).padStart(3, '0')}` === definition.setCode), `${definition.id}: source data includes its selected print`);
    }
    const read = id => JSON.parse(fs.readFileSync(path.join(dataDirectory, `${id}.json`), 'utf8'));
    assert.deepEqual(read('luke-skywalker#faithful-friend').aspects, ['vigilance', 'heroism']);
    assert.deepEqual(read('echo-base').aspects, ['command']);
    assert.deepEqual(read('darth-vader#dark-lord-of-the-sith').aspects, ['aggression', 'villainy']);
    assert.deepEqual(read('capital-city').aspects, ['vigilance']);
    assert.ok(read('luke-skywalker#jedi-knight').traits.includes('force'));
});


test('phase-end preview starts from Raid immediate ending and returns only the continuing entry', () => {
    const definition = CARD_EFFECTS.find(card => card.id === 'triple-dark-raid');
    const initial = showcaseGame(definition).steps[0].state;
    const primary = preparePreviewCue({ definition, nonce: 1 }, initial);
    const preview = { definition, nonce: 2, stage: 'phase-end' };
    const boundary = preparePreviewCue(preview, initial);
    assert.deepEqual(boundary.transition.before, primary.transition.after);
    assert.equal(boundary.playCost, undefined);
    assert.equal(boundary.playPayment, undefined);
    const entry = primary.transition.after.players.p1.space.find(card => card.id === 'a07:raid:top:2');
    assert.ok(entry && !entry.x);
    assert.equal(primary.transition.after.pending.length, 1);
    assert.equal(boundary.transition.after.pending.length, 0);
    assert.ok(boundary.transition.after.players.p1.hand.some(card => card.id === entry.id));
    assert.ok(!boundary.transition.after.players.p1.space.some(card => card.id === entry.id));
    assert.deepEqual(boundary.transition.after.players.p1.res, primary.transition.after.players.p1.res);
    assert.equal(boundary.transition.after.players.p1.deck, primary.transition.after.players.p1.deck);
    assert.deepEqual(preparePreviewCue({ ...preview, nonce: 3 }, initial).transition, boundary.transition);
    assert.deepEqual(preparePreviewCue({ definition, nonce: 4 }, initial).transition, primary.transition);
    assert.throws(() => preparePreviewCue({ definition: CARD_EFFECTS[0], nonce: 1, stage: 'phase-end' }, showcaseGame(CARD_EFFECTS[0]).steps[0].state), /no authored phase-end/);
});

test('Final Showdown preview ends ongoing and explicit regroup declares the player loss without changing the board', () => {
    const definition = CARD_EFFECTS.find(card => card.id === 'final-showdown');
    const initial = showcaseGame(definition).steps[0].state;
    const primary = preparePreviewCue({ definition, nonce: 1 }, initial);
    const boundary = preparePreviewCue({ definition, nonce: 2, stage: 'regroup-start' }, initial);
    assert.equal(primary.transition.after.matchResult, undefined);
    assert.equal(primary.transition.after.pendingPlayers.length, 1);
    assert.deepEqual(boundary.transition.before.players, primary.transition.after.players);
    assert.deepEqual(boundary.transition.after.players, primary.transition.after.players);
    assert.equal(boundary.transition.after.pendingPlayers.length, 0);
    assert.deepEqual(boundary.transition.after.matchResult, { winner: 'p2', loser: 'p1', reason: 'card-effect', sourceId: primary.source.id });
    assert.equal(boundary.playCost, undefined);
    assert.equal(boundary.playPayment, undefined);
    assert.deepEqual(preparePreviewCue({ definition, nonce: 3 }, initial).transition, primary.transition);
});

test('A10 Later action begins at the paid ending and preserves event provenance without replaying its cost',()=>{
    for(const id of ['pyrrhic-assault','in-defense-of-kamino']){
        const definition=CARD_EFFECTS.find(d=>d.id===id),initial=showcaseGame(definition).steps[0].state,saved=structuredClone(initial);
        const primary=preparePreviewCue({definition,nonce:1},initial),boundary=preparePreviewCue({definition,nonce:2,stage:'next-action'},initial);
        assert.deepEqual(initial,saved,`${id}: inputs stay immutable`);
        assert.deepEqual(boundary.transition.before,primary.transition.after,`${id}: actual paid immediate result`);
        assert.deepEqual(boundary.source,primary.source,`${id}: grant event remains the cause rather than becoming the attacker`);
        assert.equal(boundary.playCost,undefined);assert.equal(boundary.playPayment,undefined);
        for(const seat of ['p1','p2']){
            assert.deepEqual(boundary.transition.after.players[seat].res,primary.transition.after.players[seat].res);
            assert.deepEqual(boundary.transition.after.players[seat].resources,primary.transition.after.players[seat].resources);
        }
        assert.equal(boundary.transition.after.players.p1.discard.filter(c=>c.id===primary.source.id).length,1);
        assert.ok(boundary.outcomes.some(o=>o.whenDefeatedOrigin),'the declared actual later defeat has an explicit granted-ability cause');
        assert.deepEqual(preparePreviewCue({definition,nonce:7,stage:'next-action'},initial).transition,boundary.transition,'Replay starts from the same independent later-action state');
        assert.deepEqual(preparePreviewCue({definition,nonce:8},initial).transition,primary.transition,'returning to event play restores its untriggered grants');
        if(id==='pyrrhic-assault'){
            assert.equal(boundary.transition.after.players.p1.ground.some(u=>u.id==='a10:p1:defender'),false);
            assert.equal(boundary.transition.after.players.p2.ground.length,0,'the defender ability defeats Trooper after the Wampa fight');
            assert.equal(boundary.transition.after.players.p1.base.d,9);
        }else{
            assert.equal(boundary.transition.after.players.p1.base.d,7,'Restore resolves on the declared attack');
            const clone=boundary.transition.after.players.p1.ground.find(u=>u.t===1);
            assert.ok(clone);assert.equal(clone.x,1);assert.equal(clone.p,2);assert.equal(clone.h,2);
            assert.ok(!clone.status?.length,'fresh Republic token does not inherit the departed unit’s phase grants');
            assert.equal(boundary.transition.after.players.p2.ground.find(u=>u.id==='a10:p2:wampa').d,4);
        }
    }
});

test('A12 regroup scenes consume only continuing owner-bound entries without replaying costs or ordinary regroup steps',()=>{
    for(const id of ['unnatural-life','impropriety-among-thieves']){
        const definition=CARD_EFFECTS.find(d=>d.id===id),initial=showcaseGame(definition).steps[0].state,saved=structuredClone(initial);
        const primary=preparePreviewCue({definition,nonce:1},initial),boundary=preparePreviewCue({definition,nonce:2,stage:'regroup-start'},initial);
        assert.deepEqual(initial,saved);assert.deepEqual(boundary.source,primary.source,'original event remains the delayed cause');
        assert.equal(boundary.playCost,undefined);assert.equal(boundary.playPayment,undefined);
        assert.deepEqual(boundary.transition.before.players,primary.transition.after.players);
        assert.equal(boundary.transition.before.phase,'regroup');assert.equal(boundary.transition.after.phase,'regroup');
        assert.ok(primary.transition.after.pending.length);assert.equal(boundary.transition.after.pending.length,0);
        for(const seat of ['p1','p2']){
            const a=primary.transition.after.players[seat],b=boundary.transition.after.players[seat];
            assert.deepEqual(a.res,b.res);assert.deepEqual(a.resources,b.resources);assert.equal(a.deck,b.deck);assert.deepEqual(a.hand,b.hand);
        }
        assert.ok(boundary.outcomes.every(o=>o.sourceCard.id===primary.source.id&&o.pendingOperation==='consume'&&o.incarnation===o.pending.incarnation));
        assert.deepEqual(preparePreviewCue({definition,nonce:9,stage:'regroup-start'},initial).transition,boundary.transition);
        assert.deepEqual(preparePreviewCue({definition,nonce:10},initial).transition,primary.transition);
        if(id==='unnatural-life'){
            assert.equal(boundary.transition.after.players.p1.ground.some(u=>u.id==='a12:life:wampa'),false);
            assert.equal(boundary.transition.after.players.p1.discard.filter(c=>c.id==='a12:life:wampa').length,1);
        }else{
            const p1=boundary.transition.after.players.p1,p2=boundary.transition.after.players.p2;
            assert.equal(p1.ground.find(u=>u.id==='a12:p1:marine').d,1);assert.equal(p1.ground.find(u=>u.id==='a12:p1:marine').x,undefined);
            assert.equal(p2.space.find(u=>u.id==='a12:p2:tie').d,0);assert.equal(p2.space.find(u=>u.id==='a12:p2:tie').x,undefined);
        }
    }
});
test('Aid Later action spends only one real resource and consumes the selected upgrade permission once',()=>{
    const definition=CARD_EFFECTS.find(d=>d.id==='aid-from-the-innocent'),initial=showcaseGame(definition).steps[0].state;
    const primary=preparePreviewCue({definition,nonce:1},initial),later=preparePreviewCue({definition,nonce:2,stage:'next-action'},initial);
    assert.deepEqual(later.transition.before,primary.transition.after);assert.deepEqual(later.source,primary.source);
    assert.equal(later.playCost,undefined);assert.equal(later.playPayment,undefined);
    assert.equal(primary.transition.after.discardPlayPermissions.length,2);assert.equal(later.transition.after.discardPlayPermissions.length,1);
    assert.deepEqual(primary.transition.after.players.p1.res,{ready:13,total:20});assert.deepEqual(later.transition.after.players.p1.res,{ready:12,total:20});
    const old=primary.transition.after.players.p1.ground.find(u=>u.id==='a12:p1:marine'),now=later.transition.after.players.p1.ground.find(u=>u.id===old.id);
    assert.equal(now.p,6);assert.equal(now.h,6);assert.equal(now.d,old.d);assert.equal(now.incarnation,old.incarnation);
    assert.equal(now.u.find(u=>u.s==='SOR_054').id,'a12:aid:look:0');assert.equal(later.transition.after.players.p1.discard.some(c=>c.id==='a12:aid:look:0'),false);
    assert.equal(later.transition.after.players.p1.discard.filter(c=>c.id===primary.source.id).length,1);
    assert.deepEqual(preparePreviewCue({definition,nonce:9,stage:'next-action'},initial).transition,later.transition);
    assert.deepEqual(preparePreviewCue({definition,nonce:10},initial).transition,primary.transition);
});


test('A15 explicit phase boundaries remove only source-bound grants without paying or readying again',()=>{
    for(const id of ['scramble-fighters','unity-of-purpose']){
        const definition=CARD_EFFECTS.find(d=>d.id===id),initial=showcaseGame(definition).steps[0].state,primary=preparePreviewCue({definition,nonce:1},initial),boundary=preparePreviewCue({definition,nonce:2,stage:'phase-end'},initial);
        assert.deepEqual(boundary.transition.before,primary.transition.after);
        assert.deepEqual(boundary.source,primary.source);assert.equal(boundary.playPayment,undefined);assert.equal(boundary.playCost,undefined);
        assert.equal(boundary.transition.after.players.p1.discard.filter(c=>c.id===primary.source.id).length,1);
        for(const seat of ['p1','p2']){const a=boundary.transition.before.players[seat],b=boundary.transition.after.players[seat];assert.deepEqual(b.resources,a.resources);assert.deepEqual(b.hand,a.hand);assert.equal(b.deck,a.deck);for(const u of [...b.ground,...b.space]){const old=[...a.ground,...a.space].find(c=>c.id===u.id);assert.ok(old);assert.equal(u.x,old.x);assert.equal(u.d,old.d);assert.equal(!!u.status?.some(s=>s.generatedRestriction?.sourceId===primary.source.id||s.titleBoost?.sourceId===primary.source.id),false);}}
        assert.deepEqual(preparePreviewCue({definition,nonce:3,stage:'phase-end'},initial).transition,boundary.transition);
    }
});


test('Timely preview phase boundary removes only generated Sentinel while preserving the paid exhausted board',()=>{
 const definition=CARD_EFFECTS.find(d=>d.id==='timely-reinforcements'),initial=showcaseGame(definition).steps[0].state;
 const play=preparePreviewCue({definition,nonce:1},initial),expiry=preparePreviewCue({definition,nonce:2,stage:'phase-end'},initial);
 assert.deepEqual(expiry.transition.before,play.transition.after);
 assert.equal(expiry.playPayment,undefined);assert.equal(expiry.playCost,undefined);
 assert.deepEqual(expiry.source,play.source);
 const before=play.transition.after.players.p1,after=expiry.transition.after.players.p1;
 const fresh=before.space.filter(u=>u.status?.some(s=>s.generatedSentinel?.sourceId===play.source.id));
 assert.equal(fresh.length,4);assert.equal(expiry.outcomes.length,4);
 for(const old of fresh){const now=after.space.find(u=>u.id===old.id);assert.ok(now);assert.equal(old.sn,1);assert.equal(now.sn,undefined);assert.equal(now.x,1);assert.equal(now.incarnation,old.incarnation);assert.deepEqual([now.p,now.h,now.d],[old.p,old.h,old.d]);}
 for(const key of ['resources','res','hand','deck','discard'])assert.deepEqual(after[key],before[key]);
 assert.deepEqual(expiry.transition.after.players.p2,play.transition.after.players.p2);
 assert.deepEqual(preparePreviewCue({definition,nonce:3,stage:'phase-end'},initial).transition,expiry.transition);
 assert.deepEqual(preparePreviewCue({definition,nonce:4},initial).transition,play.transition);
});
