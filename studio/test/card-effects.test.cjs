const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createRequire } = require('node:module');
const ts = require('../../viewer/node_modules/typescript');

// Use the viewer's existing compiler to exercise the actual TS modules on Node 22, without a browser or new dependency.
const modules = new Map();
function loadTS(filename) {
    filename = path.resolve(filename);
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const requireFromFile = createRequire(filename);
    const requireLocal = (specifier) => {
        if (specifier.startsWith('.')) {
            const tsPath = path.resolve(path.dirname(filename), `${specifier}.ts`);
            if (fs.existsSync(tsPath)) return loadTS(tsPath);
        }
        return requireFromFile(specifier);
    };
    new Function('require', 'module', 'exports', compiled)(requireLocal, module, module.exports);
    return module.exports;
}

const { CARD_EFFECTS, findCardEffect } = loadTS(path.join(__dirname, '../src/effects/catalogue.ts'));
const { detectCardEffects } = loadTS(path.join(__dirname, '../src/effects/detect.ts'));
const { classifyGame } = loadTS(path.join(__dirname, '../src/data/actions.ts'));
const { ABILITY_LANGUAGE, cardAbilities, cardAbilityRules, showcaseAbilities, showcaseLabel } = loadTS(path.join(__dirname, '../src/effects/abilities.ts'));
const { observedOutcomes } = loadTS(path.join(__dirname, '../src/effects/outcomes.ts'));
const { showcaseGame } = loadTS(path.join(__dirname, '../src/effects/showcase.ts'));
const { previewCue } = loadTS(path.join(__dirname, '../src/effects/preview.ts'));
const { resolvePreviewState } = loadTS(path.join(__dirname, '../src/effects/previewState.ts'));
const { trackUnits } = loadTS(path.join(__dirname, '../src/data/derive.ts'));

const openFire = { n: 'Open Fire', s: 'SOR_172' };
const stormtrooper = { n: 'Stormtrooper', s: 'SOR_140', p: 3, h: 5, d: 0 };
const copy = (value) => structuredClone(value);
function player(name) {
    return {
        name, base: { n: 'Base', s: 'SOR_025', hp: 30, d: 0 }, leader: null,
        res: { ready: 5, total: 5 }, hand: [], deck: 20, discard: [], ground: [], space: []
    };
}
function fixture() {
    const before = { round: 2, phase: 'action', initiative: 'p1', players: { p1: player('Pilot'), p2: player('Rival') } };
    before.players.p1.hand = [copy(openFire)];
    before.players.p2.ground = [copy(stormtrooper)];
    const pending = copy(before);
    pending.players.p1.res.ready = 2;
    const after = copy(pending);
    after.players.p1.hand = [];
    after.players.p1.discard = [openFire];
    after.players.p2.ground[0].d = 4;
    return {
        header: { t: 'header', v: 1, seed: 12, engine: null, players: [{ id: 'p1', bot: 'Pilot', deck: '' }, { id: 'p2', bot: 'Rival', deck: '' }] },
        steps: [
            { t: 'step', n: 0, state: before },
            { t: 'step', n: 10, pid: 'p1', prompt: 'actionWindow', title: 'Choose an action', action: { kind: 'card', label: 'open-fire' }, state: pending },
            { t: 'step', n: 11, pid: 'p1', prompt: 'selectCard', title: 'Deal 4 damage to a unit', action: { kind: 'card', label: 'stormtrooper' }, state: after },
            { t: 'step', n: 12, pid: 'p2', prompt: 'actionWindow', title: 'Choose an action', action: { kind: 'button', label: 'Pass' }, state: copy(after) }
        ],
        end: null
    };
}

test('recorded effect handoff uses the exact pre-action and resolved snapshots without changing the recording', () => {
    const game = fixture();
    const original = copy(game);
    const cues = detectCardEffects(game, classifyGame(game));
    const cue = cues.get(2);
    assert.ok(cue);
    assert.equal(cue.transition.before, game.steps[0].state);
    assert.equal(cue.transition.after, game.steps[2].state);
    assert.equal(cue.transition.beforeStep, 0);
    assert.equal(cue.transition.afterStep, 2);
    assert.equal(cue.transition.before.players.p2.ground[0].d, 0);
    assert.equal(cue.transition.after.players.p2.ground[0].d, 4);
    assert.deepEqual(game, original);
});

test('Karabast records its selected damage source only when the exact prompt and instance support it', () => {
    const definition = CARD_EFFECTS.find(card => card.id === 'karabast');
    const game = showcaseGame(definition);
    const before = game.steps[0].state;
    const source = before.players.p1.ground[0], recipient = before.players.p2.ground[1];
    const event = before.players.p1.hand[0];
    const after = resolvePreviewState(before, previewCue({ definition, nonce: 1 }, before));
    const title = 'A friendly unit deals damage equal to its damage plus one to an enemy unit.';
    game.steps.push(
        { t: 'step', n: 1, pid: 'p1', prompt: 'actionWindow', title: 'Choose an action', action: { kind: 'card', label: 'karabast', id: event.id }, state: copy(before) },
        { t: 'step', n: 2, pid: 'p1', prompt: 'selectCard', title, action: { kind: 'card', label: 'battlefield-marine', id: source.id }, state: copy(before) },
        { t: 'step', n: 3, pid: 'p1', prompt: 'selectCard', title, action: { kind: 'card', label: 'wampa', id: recipient.id }, state: after },
        { t: 'step', n: 4, pid: 'p2', prompt: 'actionWindow', title: 'Choose an action', action: { kind: 'button', label: 'Pass' }, state: copy(after) }
    );
    const saved = copy(game);
    let cue = detectCardEffects(game, classifyGame(game)).get(3);
    const damage = cue.outcomes.find(outcome => outcome.kind === 'damage');
    assert.equal(damage.sourceCard.id, source.id);
    assert.deepEqual(damage.basis, { kind: 'source-damage-plus-one', sourceIds: [source.id], value: 1, increment: 1 });
    assert.deepEqual(game, saved, 'evidence extraction never enriches the recorded state');
    game.steps[2].action.id = 'unknown-recorded-instance';
    cue = detectCardEffects(game, classifyGame(game)).get(3);
    assert.equal(cue.outcomes.find(outcome => outcome.kind === 'damage').sourceCard, undefined, 'do not guess the source from label or matching damage');
});

test('Force Throw chooser attribution requires the recorded own-hand selection, not merely a discarded card', () => {
    const definition = CARD_EFFECTS.find(card => card.id === 'force-throw');
    const game = showcaseGame(definition), before = game.steps[0].state;
    const event = before.players.p1.hand[0], selected = before.players.p2.hand[0];
    const after = resolvePreviewState(before, previewCue({ definition, nonce: 1 }, before));
    game.steps.push(
        { t: 'step', n: 1, pid: 'p1', prompt: 'actionWindow', title: 'Choose an action', action: { kind: 'card', label: 'force-throw', id: event.id }, state: copy(before) },
        { t: 'step', n: 2, pid: 'p1', prompt: 'selectPlayer', title: 'Choose a player', action: { kind: 'button', label: 'Opponent discards' }, state: copy(before) },
        { t: 'step', n: 3, pid: 'p2', prompt: 'selectCard', title: "Choose a card to discard for Force Throw's effect", action: { kind: 'card', label: 'takedown', id: selected.id }, state: after },
        { t: 'step', n: 4, pid: 'p2', prompt: 'actionWindow', title: 'Choose an action', action: { kind: 'button', label: 'Pass' }, state: copy(after) }
    );
    let cue = detectCardEffects(game, classifyGame(game)).get(3);
    const discard = cue.outcomes.find(outcome => outcome.kind === 'discard');
    assert.equal(discard.card.id, selected.id);
    assert.equal(discard.chooserSeat, 'p2');
    assert.equal(discard.selection, 'opponent');
    assert.match(discard.label, /P2 CHOOSES/);
    game.steps[3].action.id = 'unknown-recorded-instance';
    cue = detectCardEffects(game, classifyGame(game)).get(3);
    assert.equal(cue.outcomes.find(outcome => outcome.kind === 'discard').chooserSeat, undefined);
});

test('instance keys stay with surviving copies when same-title units leave or reorder', () => {
    const game = fixture();
    game.steps = game.steps.slice(0, 3);
    const a = { ...stormtrooper, id: 'copy-a' };
    const b = { ...stormtrooper, id: 'copy-b' };
    game.steps[0].state.players.p2.ground = [a, b];
    game.steps[1].state.players.p2.ground = [b, a];
    game.steps[2].state.players.p2.ground = [b];
    const keys = trackUnits(game);
    assert.deepEqual(keys.map(k => k.p2.ground), [['#copy-a', '#copy-b'], ['#copy-b', '#copy-a'], ['#copy-b']]);
});

test('recorded upgrade returns retain their host and actual hand destination without moving the host or guessing vanished tokens', () => {
    const game = fixture();
    const before = game.steps[0].state;
    const host = before.players.p2.ground[0];
    host.id = 'host';
    host.u = [
        { id: 'owned-p1', n: 'Entrenched', s: 'SOR_072', t: 0 },
        { id: 'owned-p2', n: 'Academy Training', s: 'SOR_120', t: 0 },
        { id: 'shield', n: 'Shield', s: null, t: 1 }
    ];
    const after = copy(before);
    after.players.p2.ground[0].u = [];
    after.players.p1.hand.push(copy(host.u[0]));
    after.players.p2.hand.push(copy(host.u[1]));
    game.steps[2].state = after;
    const saved = copy(game);
    const outcomes = observedOutcomes(game, { index: 1, until: 2, seat: 'p1', card: openFire });
    const returned = outcomes.filter(o => o.kind === 'return');
    assert.deepEqual(returned.map(o => [o.card.id, o.sourceCard.id, o.fromSeat, o.ownerSeat, o.zone, o.destination]), [
        ['owned-p1', 'host', 'p2', 'p1', 'hand', 'hand'],
        ['owned-p2', 'host', 'p2', 'p2', 'hand', 'hand']
    ]);
    assert.equal(outcomes.some(o => o.card?.id === 'host' || o.card?.id === 'shield'), false);
    assert.deepEqual(game, saved);
    after.players.p1.hand.at(-1).id = 'different-copy';
    assert.equal(observedOutcomes(game, { index: 1, until: 2, seat: 'p1', card: openFire }).some(o => o.card?.id === 'owned-p1'), false,
        'matching titles without the same recorded instance do not establish a return');
});

test('recorded captive departures use the exact captured instance and actual arena without inferring owner or play semantics', () => {
    const game = fixture(), before = game.steps[0].state;
    const host = before.players.p2.ground[0]; host.id = 'captor'; host.x = 1;
    host.cap = [{ id: 'captive', n: 'Battlefield Marine', s: 'SOR_095' }, { id: 'stays', n: 'Battlefield Marine', s: 'SOR_095' }];
    const after = copy(before);
    after.players.p2.ground[0].cap = [copy(host.cap[1])];
    after.players.p1.ground = [{ ...host.cap[0], p: 3, h: 3, d: 0, x: 1 }];
    game.steps[2].state = after;
    const action = { index: 1, until: 2, seat: 'p1', card: openFire }, saved = copy(game);
    const outcomes = observedOutcomes(game, action), rescue = outcomes.find(o => o.kind === 'rescue');
    assert.ok(rescue);
    assert.deepEqual([rescue.card.id, rescue.sourceCard.id, rescue.fromSeat, rescue.fromZone, rescue.seat, rescue.zone],
        ['captive', 'captor', 'p2', 'ground', 'p1', 'ground']);
    assert.equal(rescue.unit, after.players.p1.ground[0]);
    assert.equal(rescue.label, 'Left captivity');
    for (const field of ['ownerSeat', 'entryType', 'entersReady', 'paid']) assert.equal(rescue[field], undefined);
    assert.equal(outcomes.some(o => o.kind === 'play' || o.kind === 'defeat' || o.kind === 'exhaust'), false);
    assert.deepEqual(game, saved);
    after.players.p1.ground[0].id = 'different-copy';
    assert.equal(observedOutcomes(game, action).some(o => o.kind === 'rescue'), false);
    delete host.cap[0].id; delete host.cap[1].id; delete after.players.p1.ground[0].id;
    assert.equal(observedOutcomes(game, action).some(o => o.kind === 'rescue'), false, 'duplicate print identities without instance IDs remain ambiguous');
});

test('a captured card arriving in discard is not labeled an in-play unit defeat', () => {
    const game = fixture(), before = game.steps[0].state;
    before.players.p2.ground[0].cap = [{ id: 'captive', n: 'Battlefield Marine', s: 'SOR_095' }];
    const after = copy(before);
    after.players.p1.discard.push(after.players.p2.ground[0].cap.pop());
    game.steps[2].state = after;
    const routes = observedOutcomes(game, { index: 1, until: 2, seat: 'p1', card: openFire }).filter(o => o.card?.id === 'captive');
    assert.equal(routes.length, 1);
    assert.deepEqual([routes[0].kind, routes[0].fromZone, routes[0].zone], ['discard', 'capture', 'discard']);
    assert.equal(routes[0].ownerSeat, undefined);
});

test('the catalogue contains distinct card identities and dedicated visuals', () => {
    assert.ok(CARD_EFFECTS.length >= 20, 'preserve the approved baseline');
    for (const field of ['id', 'name', 'setCode', 'visual']) {
        assert.equal(new Set(CARD_EFFECTS.map((effect) => effect[field])).size, CARD_EFFECTS.length, field);
    }
    for (const effect of CARD_EFFECTS) {
        assert.match(effect.setCode, /^[A-Z0-9]+_\d{3}$/);
        assert.equal(effect.visual, effect.id);
        assert.ok(effect.durationMs > 0 && effect.durationMs <= 8000, 'allow deliberate multi-attack/search sequences without an unbounded playback hold');
        assert.equal(findCardEffect({ n: effect.name, s: effect.setCode }), effect);
    }
});

test('print identity wins over a matching title; only known reprints match', () => {
    assert.equal(findCardEffect({ n: 'Open Fire', s: 'SOR_999' }), undefined);
    assert.equal(findCardEffect({ n: 'Repair', s: 'TWI_999' }), undefined);
    assert.equal(findCardEffect({ n: 'Repair', s: 'TWI_075' }).id, 'disruptive-burst', 'registered print wins over an unrelated title');
    assert.equal(findCardEffect({ n: 'Open Fire', s: 'TWI_174' }).id, 'open-fire');
    assert.equal(findCardEffect({ n: 'Repair', s: 'JTL_075' }).id, 'repair');
    assert.equal(findCardEffect({ n: 'Takedown', s: 'sor_77' }).id, 'takedown');
    assert.equal(findCardEffect({ n: 'Wrong title', s: 'SHD_128' }).id, 'outflank');
    assert.equal(findCardEffect({ n: 'Wrong title', s: 'SOR_124' }).id, 'tactical-advantage');
    assert.equal(findCardEffect({ n: 'Wrong title', s: 'SHD_131' }).id, 'take-captive');
    assert.equal(findCardEffect({ n: 'Wrong title', s: 'SHD_178' }).id, 'daring-raid');
});

test('older captures normalize engine names without substring matching', () => {
    assert.equal(findCardEffect({ n: 'force-lightning', s: null }).id, 'force-lightning');
    assert.equal(findCardEffect({ n: 'THE FORCE IS WITH ME', s: null }).id, 'the-force-is-with-me');
    assert.equal(findCardEffect({ n: 'open-fire#different-card', s: null }), undefined);
    assert.equal(findCardEffect({ n: 'Choose Open Fire', s: null }), undefined);
});

test('a real classified targeted play cues on resolution, carrying its source and target', () => {
    const game = fixture();
    const actions = classifyGame(game);
    assert.equal(actions[0].cls, 'play-event');
    assert.equal(actions[0].index, 1);
    assert.equal(actions[0].until, 2);
    const cues = detectCardEffects(game, actions);
    assert.deepEqual([...cues.keys()], [2]);
    const cue = cues.get(2);
    assert.equal(cue.definition.id, 'open-fire');
    assert.deepEqual(cue.source, openFire);
    assert.deepEqual(cue.target, stormtrooper);
    assert.equal(cue.targetSeat, 'p2');
    assert.equal(cue.seat, 'p1');
    assert.equal(cues.has(11), false, 'map keys are playback indices, not Step.n');
});

test('resource, target, attack, setup, cancelled play and ability actions do not trigger event animations', () => {
    const game = fixture();
    const action = classifyGame(game)[0];
    for (const cls of ['resource', 'choose', 'attack', 'attack-base', 'setup', 'cancel', 'ability', 'trigger']) {
        assert.equal(detectCardEffects(game, [{ ...action, cls }]).size, 0, cls);
    }
    // A supported card selected by some other event is a target, not the source.
    assert.equal(detectCardEffects(game, [{ ...action, card: { n: 'Other Event', s: null }, target: openFire }]).size, 0);
    assert.equal(detectCardEffects(game, [{ ...action, card: null, target: openFire }]).size, 0);
});

test('invalid resolution positions are ignored and repeat scans produce stable cue keys', () => {
    const game = fixture();
    const actions = classifyGame(game);
    const action = actions[0];
    for (const patch of [{ until: 99 }, { until: 0 }, { index: 0 }]) {
        assert.equal(detectCardEffects(game, [{ ...action, ...patch }]).size, 0);
    }
    assert.equal(detectCardEffects(game, actions).get(2).key, detectCardEffects(game, actions).get(2).key);
    game.end = { t: 'end', winner: 'p1', round: 2, steps: 3, outcome: 'win', error: null };
    const second = { ...action, index: 3, until: 3 };
    const cues = detectCardEffects(game, [action, second]);
    assert.equal(cues.size, 2);
    assert.notEqual(cues.get(2).key, cues.get(3).key);
});

test('Force Lightning recovers its exact recorded unit selection, including duplicate names', () => {
    const game = fixture();
    const lightning = { n: 'Force Lightning', s: 'SOR_138' };
    for (const step of game.steps) {
        step.state.players.p1.hand = [lightning];
        step.state.players.p2.ground = [{ ...stormtrooper, id: 'first' }, { ...stormtrooper, id: 'second' }];
    }
    game.steps[1].action.label = 'force-lightning';
    game.steps[2].title = 'Choose a unit. It loses all abilities for this phase.';
    game.steps[2].action.id = 'second';
    let actions = classifyGame(game);
    assert.equal(actions[0].target, null, 'generic classifier does not recognize this card-specific prompt');
    let cue = detectCardEffects(game, actions).get(2);
    assert.equal(cue.target.id, 'second');
    assert.equal(cue.targetSeat, 'p2');

    game.steps[2].action.id = 'missing';
    assert.equal(detectCardEffects(game, classifyGame(game)).get(2).target, null, 'unknown id must not guess by title');
    delete game.steps[2].action.id;
    assert.equal(detectCardEffects(game, classifyGame(game)).get(2).target, null, 'duplicate titles are ambiguous without ids');
    for (const step of game.steps) step.state.players.p2.ground.pop();
    cue = detectCardEffects(game, classifyGame(game)).get(2);
    assert.equal(cue.target.id, 'first', 'old captures can use an unambiguous exact engine name');
});

test('The Force Is With Me uses the friendly buff recipient rather than its later attack target', () => {
    const game = fixture();
    const event = { n: 'The Force Is With Me', s: 'SOR_055' };
    const friendly = { n: 'Yoda', s: 'SOR_045', id: 'yoda', p: 2, h: 4, d: 0 };
    for (const step of game.steps) {
        step.state.players.p1.hand = [event];
        step.state.players.p1.ground = [copy(friendly)];
        step.state.players.p2.ground = [{ ...stormtrooper, id: 'enemy' }];
    }
    game.steps[1].action.label = 'the-force-is-with-me';
    game.steps[2].title = 'Give 2 Experience, a Shield if you control a FORCE unit, and optionally attack';
    game.steps[2].action = { kind: 'card', label: 'yoda#old-master', id: 'yoda' };
    game.steps[2].state.players.p1.ground[0].h = 6;
    game.steps[2].state.players.p1.ground[0].p = 4;
    const attack = { t: 'step', n: 12, pid: 'p1', prompt: '-|single', title: 'Choose a target for attack', action: { kind: 'card', label: 'stormtrooper', id: 'enemy' }, state: copy(game.steps[2].state) };
    game.steps.splice(3, 0, attack);
    const actions = classifyGame(game);
    assert.equal(actions[0].target.id, 'enemy', 'generic action targets the optional attack');
    const cue = detectCardEffects(game, actions).get(3);
    assert.equal(cue.target.id, 'yoda');
    assert.equal(cue.targetSeat, 'p1');
    assert.equal(cue.target.h, 4, 'recipient is read from its pre-buff snapshot');
});

test('Overwhelming Barrage identifies the chosen friendly unit among identical copies', () => {
    const game = fixture();
    const event = { n: 'Overwhelming Barrage', s: 'SOR_092' };
    for (const step of game.steps) {
        step.state.players.p1.hand = [event];
        step.state.players.p1.ground = [{ ...stormtrooper, id: 'first' }, { ...stormtrooper, id: 'second' }];
    }
    game.steps[1].action.label = 'overwhelming-barrage';
    game.steps[2].title = 'Give a friendly unit +2/+2 for this phase';
    game.steps[2].action.id = 'second';
    const cue = detectCardEffects(game, classifyGame(game)).get(2);
    assert.equal(cue.target.id, 'second');
    assert.equal(cue.targetSeat, 'p1');
});

test('live tail actions wait for the next action or end record to confirm resolution', () => {
    const game = fixture();
    const complete = copy(game.steps);
    game.steps = complete.slice(0, 2);
    assert.equal(detectCardEffects(game, classifyGame(game)).size, 0, 'event play may still await a target');
    game.steps = complete.slice(0, 3);
    assert.equal(detectCardEffects(game, classifyGame(game)).size, 0, 'last answer might still await a follow-up');
    game.steps = complete;
    assert.equal(detectCardEffects(game, classifyGame(game)).get(2).definition.id, 'open-fire');
    game.steps = complete.slice(0, 3);
    game.end = { t: 'end', winner: 'p1', round: 2, steps: 2, outcome: 'win', error: null };
    assert.equal(detectCardEffects(game, classifyGame(game)).get(2).definition.id, 'open-fire');
});

test('modal card explanations retain the choose-two rule', () => {
    for (const id of ['command', 'vigilance', 'aggression', 'cunning']) {
        assert.match(CARD_EFFECTS.find((effect) => effect.id === id).description, /^Choose two:/);
    }
});

function evidence(id, change) {
    const game = fixture();
    const definition = CARD_EFFECTS.find(effect => effect.id === id);
    const card = { n: definition.name, s: definition.setCode, id: 'played-event' };
    const before = game.steps[0].state;
    before.players.p1.hand = [card];
    before.players.p1.ground = [{ n: 'Battlefield Marine', s: 'SOR_095', id: 'friend', p: 3, h: 3, d: 0 }];
    before.players.p2.ground[0].id = 'enemy';
    const after = copy(before);
    after.players.p1.hand = [];
    after.players.p1.discard = [card];
    change(before, after);
    game.steps[1].state = copy(before);
    game.steps[2].state = after;
    game.steps[3].state = copy(after);
    const action = { index: 1, until: 2, seat: 'p1', cls: 'play-event', card, target: before.players.p2.ground[0], targetSeat: 'p2', outcome: { baseDamage: 0, defeated: 0, entered: 0 }, swing: 0 };
    return { game, action, outcomes: observedOutcomes(game, action) };
}

test('observed damage, defeat and return describe different recorded transitions', () => {
    const hit = evidence('open-fire', (_, after) => { after.players.p2.ground[0].d = 4; });
    assert.deepEqual(hit.outcomes.map(o => [o.kind, o.amount, o.card.id]), [['damage', 4, 'enemy']]);
    assert.deepEqual(detectCardEffects(hit.game, [hit.action]).get(2).outcomes, hit.outcomes);
    const defeated = evidence('open-fire', (_, after) => {
        after.players.p2.ground = [];
        after.players.p2.discard = [{ n: 'Stormtrooper', s: 'SOR_140', id: 'enemy' }];
    });
    assert.deepEqual(defeated.outcomes.map(o => [o.kind, o.zone]), [['defeat', 'discard']]);
    assert.ok(!defeated.outcomes.some(o => o.kind === 'damage'), 'minimal discard refs cannot establish lethal damage amount');
    const returned = evidence('waylay', (_, after) => {
        after.players.p2.ground = [];
        after.players.p2.hand = [{ n: 'Stormtrooper', s: 'SOR_140', id: 'enemy' }];
    });
    assert.deepEqual(returned.outcomes.map(o => [o.kind, o.zone]), [['return', 'hand']]);
    const disappeared = evidence('vanquish', (_, after) => { after.players.p2.ground = []; });
    assert.deepEqual(disappeared.outcomes, [], 'absence alone is not a known destination or defeat receipt');
});

test('observed modal outcomes include only changed state, not every possible mode', () => {
    const { outcomes } = evidence('vigilance', (before, after) => {
        before.players.p1.base.d = 8;
        after.players.p1.base.d = 3;
        after.players.p1.ground[0].u = [{ n: 'Shield', s: null, id: 'shield', t: 1 }];
    });
    assert.deepEqual(outcomes.map(o => o.kind).sort(), ['heal', 'shield']);
    assert.equal(outcomes.find(o => o.kind === 'heal').amount, 5);
    assert.equal(outcomes.find(o => o.kind === 'shield').amount, 1);
    const unchanged = evidence('force-lightning', () => {});
    assert.deepEqual(unchanged.outcomes, [], 'snapshots do not expose suppression or prove conditional damage occurred');
});

test('stat loss is not damage, Experience is counted, and healing uses the actual removed damage', () => {
    const weakened = evidence('make-an-opening', (_, after) => {
        after.players.p2.ground[0].p -= 2;
        after.players.p2.ground[0].h -= 2;
    });
    assert.deepEqual(weakened.outcomes.map(o => [o.kind, o.amount]), [['debuff', '−2/−2']]);
    const strengthened = evidence('the-force-is-with-me', (_, after) => {
        after.players.p1.ground[0].p += 2;
        after.players.p1.ground[0].h += 2;
        after.players.p1.ground[0].u = [1, 2].map(n => ({ n: 'Experience', s: null, t: 1, id: `xp-${n}` }));
    });
    assert.deepEqual(strengthened.outcomes.map(o => [o.kind, o.amount, o.label]), [['buff', '+2/+2', '2 Experience · +2/+2']]);
    const healed = evidence('repair', (before, after) => { before.players.p1.base.d = 2; after.players.p1.base.d = 0; });
    assert.equal(healed.outcomes[0].amount, 2, 'Repair can remove at most the damage actually present');
});

test('ready and exhaust are state changes, while regroup readiness is not attributed to a card', () => {
    const readied = evidence('aggression', (before) => { before.players.p1.ground[0].x = 1; });
    assert.deepEqual(readied.outcomes.map(o => o.kind), ['ready']);
    const exhausted = evidence('cunning', (_, after) => { after.players.p2.ground[0].x = 1; });
    assert.deepEqual(exhausted.outcomes.map(o => o.kind), ['exhaust']);
    const regroup = evidence('aggression', (before, after) => { before.players.p1.ground[0].x = 1; after.phase = 'regroup'; });
    assert.deepEqual(regroup.outcomes, []);
});

test('zone receipts distinguish draw, mill, recover and aggregate resource gain', () => {
    const drawn = evidence('aggression', (_, after) => {
        after.players.p1.deck -= 1;
        after.players.p1.hand = [{ n: 'New Card', s: 'SOR_123', id: 'drawn' }];
    });
    assert.deepEqual(drawn.outcomes.map(o => [o.kind, o.amount, o.zone]), [['draw', 1, 'hand']]);
    const milled = evidence('vigilance', (_, after) => {
        after.players.p2.deck -= 6;
        after.players.p2.discard = Array.from({ length: 6 }, (_, n) => ({ n: `Milled ${n}`, s: null, id: `mill-${n}` }));
    });
    assert.deepEqual(milled.outcomes.map(o => [o.kind, o.amount, o.zone]), [['mill', 6, 'discard']]);
    const restocked = evidence('restock', (before, after) => {
        before.players.p1.discard = Array.from({ length: 4 }, (_, n) => ({ n: `Recovered ${n}`, s: null, id: `recover-${n}` }));
        after.players.p1.deck += 4;
    });
    assert.deepEqual(restocked.outcomes.map(o => [o.kind, o.amount, o.zone]), [['recover', 4, 'deck']]);
    const supplied = evidence('resupply', (_, after) => { after.players.p1.res.total += 1; after.players.p1.discard = []; });
    assert.deepEqual(supplied.outcomes.map(o => [o.kind, o.amount, o.zone]), [['resource', 1, 'resources']]);
    assert.equal(supplied.outcomes[0].card, null, 'an aggregate gain does not establish which card became a resource');
});

test('upgrade defeat leaves the attached unit intact and ambiguous copies stay unassigned', () => {
    const upgrade = { n: 'Jedi Lightsaber', s: 'SOR_054', id: 'upgrade', t: 0 };
    const stripped = evidence('aggression', (before, after) => {
        before.players.p2.ground[0].u = [upgrade];
        after.players.p2.ground[0].u = [];
        after.players.p2.discard = [upgrade];
    });
    assert.deepEqual(stripped.outcomes.map(o => [o.kind, o.card.id]), [['defeat', 'upgrade']]);
    const ambiguous = evidence('open-fire', (before, after) => {
        delete before.players.p2.ground[0].id;
        before.players.p2.ground.push(copy(before.players.p2.ground[0]));
        after.players.p2.ground = copy(before.players.p2.ground);
        after.players.p2.ground[1].d = 4;
    });
    assert.deepEqual(ambiguous.outcomes, []);
});

test('the ability grammar covers every card clause and each modal example chooses exactly two distinct modes', () => {
    const kinds = new Set(ABILITY_LANGUAGE.map(ability => ability.id));
    assert.equal(kinds.size, ABILITY_LANGUAGE.length, 'every primitive has a distinct identity');
    for (const definition of CARD_EFFECTS) {
        const all = cardAbilities(definition.id);
        assert.ok(all.length > 0, definition.id);
        for (const beat of all) assert.ok(kinds.has(beat.kind), `${definition.id}: ${beat.kind}`);
        const rules = cardAbilityRules(definition.id);
        if (rules.choose) {
            assert.equal(all.length, 4);
            assert.equal(new Set(all.map(beat => beat.mode)).size, 4);
            assert.equal(rules.order, 'any');
            const demo = showcaseAbilities(definition.id);
            assert.equal(demo.length, 2);
            assert.equal(new Set(demo.map(beat => beat.mode)).size, 2);
            assert.ok(demo.every(beat => all.some(candidate => candidate.mode === beat.mode)));
            assert.match(showcaseLabel(definition.id), /^Choose 2 example:/);
        }
    }
    // Shared language may arrive before its next batch is registered; every registered clause must still be defined.
    assert.deepEqual(cardAbilities('not-a-card'), []);
});

function preview(id) {
    const definition = CARD_EFFECTS.find(effect => effect.id === id);
    const game = showcaseGame(definition);
    return { game, cue: previewCue({ definition, nonce: 1, progress: 0.5 }, game.steps[0].state) };
}

test('all staged examples have finite amounts and remain separate from recorded outcomes', () => {
    for (const definition of CARD_EFFECTS) {
        const { game, cue } = preview(definition.id);
        assert.equal(game.header.engine, 'animation-showcase');
        assert.ok(cue.exampleLabel);
        assert.equal(cue.previewProgress, 0.5);
        assert.ok(cue.outcomes.length > 0, definition.id);
        for (const outcome of cue.outcomes) {
            assert.ok(ABILITY_LANGUAGE.some(ability => ability.id === outcome.kind));
            assert.ok(['p1', 'p2'].includes(outcome.seat));
            if (typeof outcome.amount === 'number') assert.ok(Number.isFinite(outcome.amount), `${definition.id}: ${outcome.kind}`);
            assert.ok(!String(outcome.amount).includes('NaN'));
        }
    }
});

test('Superlaser covers both arenas on both sides; Bombing Run covers only its chosen arena', () => {
    const superlaser = preview('superlaser-blast').cue.outcomes;
    assert.equal(superlaser.length, 6);
    assert.ok(superlaser.every(o => o.kind === 'defeat' && o.zone === 'discard'));
    assert.equal(superlaser.filter(o => o.seat === 'p1').length, 3);
    assert.equal(superlaser.filter(o => o.seat === 'p2').length, 3);
    assert.ok(!superlaser.some(o => o.zone === 'base'));
    const bombing = preview('bombing-run');
    const damage = bombing.cue.outcomes.filter(o => o.kind === 'damage');
    assert.equal(damage.length, 4);
    assert.ok(damage.every(o => o.amount === 3 && o.zone === 'ground'));
    assert.equal(damage.filter(o => o.seat === 'p1').length, 2);
    assert.equal(damage.filter(o => o.seat === 'p2').length, 2);
    assert.equal(bombing.cue.outcomes.filter(o => o.kind === 'defeat').length, 3);
    const spaces = ['p1', 'p2'].flatMap(seat => bombing.game.steps[0].state.players[seat].space.map(card => card.n));
    assert.ok(!bombing.cue.outcomes.some(o => spaces.includes(o.card?.n)));
});

test('conditional Force examples have an actual Force unit; the optional attack uses the enemy base', () => {
    for (const id of ['force-lightning', 'force-choke', 'the-force-is-with-me']) {
        const { game } = preview(id);
        assert.ok(game.steps[0].state.players.p1.ground.some(card => card.s === 'SOR_051'), 'Luke Skywalker, Jedi Knight is a Force unit');
    }
    const lightning = preview('force-lightning').cue.outcomes;
    assert.equal(lightning.find(o => o.kind === 'pay').amount, 2);
    assert.equal(lightning.find(o => o.kind === 'damage').amount, 4);
    const force = preview('the-force-is-with-me').cue.outcomes;
    const buff = force.find(o => o.kind === 'buff');
    assert.equal(buff.amount, '+2/+2');
    assert.equal(force.find(o => o.kind === 'shield').card.n, buff.card.n);
    assert.equal(force.find(o => o.kind === 'attack').card.n, buff.card.n);
    assert.deepEqual(force.filter(o => o.kind === 'damage').map(o => [o.seat, o.zone, o.amount]), [['p2', 'base', 5]]);
    assert.ok(force.some(o => o.kind === 'exhaust' && o.card.n === buff.card.n));
});

test('modal staging shows the chosen pair, and Restock moves four existing discard cards to deck bottom', () => {
    const chosen = {
        command: ['buff', 'damage', 'defeat'],
        vigilance: ['heal', 'shield'],
        aggression: ['ready', 'damage'],
        cunning: ['return', 'exhaust']
    };
    for (const [id, expected] of Object.entries(chosen)) {
        assert.deepEqual([...new Set(preview(id).cue.outcomes.map(o => o.kind))].sort(), [...expected].sort(), id);
    }
    const { game, cue } = preview('restock');
    assert.equal(cue.outcomes.length, 4);
    for (const outcome of cue.outcomes) {
        assert.equal(outcome.kind, 'recover');
        assert.equal(outcome.zone, 'deck');
        assert.equal(outcome.amount, 1);
        assert.ok(game.steps[0].state.players.p1.discard.some(card => card.n === outcome.card.n));
        assert.match(outcome.label, /BOTTOM.*RANDOM/);
    }
});

test('aggregate resource gains never identify the played event or invent readiness', () => {
    const { outcomes } = evidence('spark-of-hope', (_, after) => { after.players.p1.res.total += 1; });
    const added = outcomes.filter(o => o.kind === 'resource');
    assert.equal(added.length, 1);
    assert.equal(added[0].card, null);
    assert.equal(added[0].fromZone, undefined);
    assert.equal(added[0].entersReady, undefined);
});

test('exact resource manifests distinguish a discarded card arrival from resource-origin unit play without double counting', () => {
    const { outcomes } = evidence('spark-of-hope', (before, after) => {
        const marine = { n: 'Battlefield Marine', s: 'SOR_095', id: 'discarded-marine' };
        const xwing = { n: 'Alliance X-Wing', s: 'SOR_237', id: 'resource-xwing', x: 1 };
        const other = Array.from({ length: 4 }, (_, i) => ({ n: 'Hidden resource', s: null, id: `res-${i}` }));
        before.players.p1.discard = [marine];
        before.players.p1.resources = [xwing, ...other];
        before.players.p1.res = { ready: 4, total: 5 };
        after.players.p1.resources = [...other, { ...marine, x: 1 }];
        after.players.p1.res = { ready: 4, total: 5 };
        after.players.p1.space = [{ ...xwing, p: 2, h: 3, d: 0 }];
    });
    const added = outcomes.filter(o => o.kind === 'resource'), play = outcomes.find(o => o.kind === 'play');
    assert.equal(added.length, 1, 'known arrivals remain visible even when another resource departs');
    assert.deepEqual([added[0].card.id, added[0].fromZone, added[0].entersReady], ['discarded-marine', 'discard', false]);
    assert.deepEqual([play.card.id, play.fromZone, play.zone], ['resource-xwing', 'resources', 'space']);
    assert.equal(play.entryType, undefined, 'movement alone does not establish the intervening play mechanism');
    assert.equal(play.sequenceIndex, undefined);
    assert.equal(outcomes.some(o => o.kind === 'pay' || o.kind === 'inspect' || o.kind === 'cost'), false);
});

test('recorded attachment routes preserve host identity and leave unavailable owner/control claims unknown', () => {
    for (const explicit of [false, true]) {
        const { outcomes } = evidence('evidence-of-the-crime', (before, after) => {
            const upgrade = { n: 'Academy Training', s: 'SOR_120', id: 'attachment', p: 2, h: 2,
                ...(explicit ? { owner: 'p2', controller: 'p2' } : {}) };
            before.players.p2.ground[0].u = [upgrade];
            before.players.p2.ground[0].p += 2;
            before.players.p2.ground[0].h += 2;
            after.players.p1.ground[0].u = [{ ...upgrade, ...(explicit ? { controller: 'p1' } : {}) }];
            after.players.p1.ground[0].p += 2;
            after.players.p1.ground[0].h += 2;
        });
        const move = outcomes.find(o => o.kind === 'attach');
        assert.ok(move);
        assert.deepEqual([move.card.id, move.sourceCard.id, move.targetCard.id, move.fromSeat, move.seat], ['attachment', 'enemy', 'friend', 'p2', 'p1']);
        assert.equal(move.ownerSeat, explicit ? 'p2' : undefined);
        assert.equal(move.controllerSeat, explicit ? 'p1' : undefined);
        assert.equal(move.printedCost, undefined);
        assert.equal(outcomes.some(o => o.kind === 'defeat' || o.kind === 'return' || o.kind === 'play'), false);
    }
});

test('recorded capture establishes exact captive membership without inventing attack history', () => {
    const { outcomes } = evidence('rule-with-respect', (before, after) => {
        after.players.p2.ground = [];
        const enemy = before.players.p2.ground[0];
        after.players.p1.ground[0].cap = [{ n: enemy.n, s: enemy.s, id: enemy.id }];
    });
    const capture = outcomes.find(o => o.kind === 'capture');
    assert.ok(capture);
    assert.deepEqual([capture.card.id, capture.sourceCard.id, capture.fromSeat, capture.seat], ['enemy', 'friend', 'p2', 'p1']);
    assert.equal(capture.ownerSeat, undefined);
    assert.equal(capture.captureBasis, undefined);
    assert.equal(capture.incarnation, undefined);
    assert.equal(outcomes.some(o => o.kind === 'defeat' || o.kind === 'control'), false);
});

test('deployed leader summaries do not duplicate arena identity and actual undeployment never routes to discard', () => {
    const { outcomes } = evidence('rivals-fall', (before, after) => {
        const leader = { n: 'Darth Vader', s: 'SOR_010', id: 'deployed-vader', dep: 1, epic: 1 };
        before.players.p2.leader = leader;
        before.players.p2.ground.push({ ...leader, p: 5, h: 8, d: 2 });
        after.players.p2.leader = { ...leader, dep: 0, x: 1 };
    });
    const defeat = outcomes.find(o => o.kind === 'defeat');
    assert.ok(defeat, 'the deployed summary must not make the arena card appear ambiguously duplicated');
    assert.deepEqual([defeat.card.id, defeat.zone, defeat.leader.dep, defeat.leader.x, defeat.leader.epic], ['deployed-vader', 'leader', 0, 1, 1]);
    assert.equal(defeat.ownerSeat, 'p2');
    assert.equal(outcomes.some(o => o.zone === 'discard'), false);
});

test('discard-to-arena recorded movement preserves a known destination without claiming a discount or fresh play trigger', () => {
    const { outcomes } = evidence('palpatines-return', (before, after) => {
        const kylo = { n: 'Kylo Ren', s: 'SHD_141', id: 'kylo' };
        before.players.p1.discard = [kylo];
        after.players.p1.ground.push({ ...kylo, p: 6, h: 7, d: 0, x: 1 });
    });
    const play = outcomes.find(o => o.kind === 'play');
    assert.deepEqual([play.card.id, play.fromZone, play.zone, play.unit.x], ['kylo', 'discard', 'ground', 1]);
    assert.equal(play.entryType, undefined);
    assert.equal(play.ownerSeat, undefined);
    assert.equal(outcomes.some(o => o.kind === 'cost' || o.kind === 'pay' || o.kind === 'recover'), false);
});

test('a recorded captive discard uses its actual pocket and leaves guard and causal history intact', () => {
    for (const explicit of [false, true]) {
        const { outcomes } = evidence('rule-with-respect', (before, after) => {
            const captive = { n:'Wampa', s:'SOR_164', id:'guarded-card', ...(explicit ? {owner:'p2'} : {}) };
            before.players.p1.ground[0].cap = [captive];
            after.players.p1.ground[0].cap = [];
            after.players.p2.discard.push(captive);
        });
        const route = outcomes.find(o => o.kind === 'discard');
        assert.deepEqual([route.card.id,route.sourceCard.id,route.fromZone,route.fromSeat,route.seat,route.zone], ['guarded-card','friend','capture','p1','p2','discard']);
        assert.equal(route.ownerSeat, explicit ? 'p2' : undefined);
        assert.equal(route.incarnation, undefined);
        assert.equal(outcomes.some(o=>['rescue','capture','play','defeat'].includes(o.kind)), false);
    }
});
test('recorded opponent discard attachment keeps actual owner and controller separate without guessing permission or cost', () => {
    for (const explicit of [false, true]) {
        const { outcomes } = evidence('palpatines-return', (before, after) => {
            const armor = { n:"Boba Fett's Armor", s:'SHD_224', id:'armor', ...(explicit ? {owner:'p2'} : {}) };
            before.players.p2.discard = [armor];
            after.players.p1.ground[0].u = [{...armor,p:2,h:2,t:0,...(explicit?{controller:'p1'}:{})}];
            after.players.p1.ground[0].p += 2; after.players.p1.ground[0].h += 2;
        });
        const play = outcomes.find(o=>o.kind==='play');
        assert.deepEqual([play.card.id,play.playAs,play.targetCard.id,play.fromSeat,play.fromZone,play.seat], ['armor','upgrade','friend','p2','discard','p1']);
        assert.equal(play.ownerSeat,explicit?'p2':undefined);assert.equal(play.controllerSeat,explicit?'p1':undefined);
        assert.equal(play.unit,undefined);assert.equal(play.entersReady,undefined);assert.equal(play.entryType,undefined);
        assert.equal(play.upgradePlayPermission,undefined);assert.equal(play.printedCost,undefined);
        assert.equal(outcomes.some(o=>['pay','cost','attach'].includes(o.kind)),false);
    }
});
test('known resource departures and exact deck replacement remain physical routes without a Smuggle claim', () => {
    for (const knownDeck of [false,true]) {
        const { outcomes } = evidence('spark-of-hope', (before, after) => {
            const event={n:"Smuggler's Aid",s:'SHD_252',id:'resource-event',x:1},top={n:'Battlefield Marine',s:'SOR_095',id:'actual-top'};
            before.players.p1.resources=[event];before.players.p1.res={ready:0,total:1};
            after.players.p1.resources=[{...top,x:1}];after.players.p1.res={ready:0,total:1};after.players.p1.discard.push(event);
            before.players.p1.deck=1;after.players.p1.deck=0;
            if(knownDeck){before.players.p1.knownDeck=[top];after.players.p1.knownDeck=[];}
        });
        const departure=outcomes.find(o=>o.kind==='discard'),arrivals=outcomes.filter(o=>o.kind==='resource');
        assert.deepEqual([departure.card.id,departure.fromZone,departure.zone],['resource-event','resources','discard']);
        assert.equal(arrivals.length,knownDeck?1:0,'an unchanged total alone does not identify a replacement');
        if(knownDeck){assert.deepEqual([arrivals[0].card.id,arrivals[0].fromZone,arrivals[0].entersReady],['actual-top','deck',false]);assert.equal(arrivals[0].visibility,undefined);}
        assert.equal(outcomes.some(o=>['pay','cost','play','inspect','heal'].includes(o.kind)),false);
    }
});


test('recorded attachment-to-arena movement uses actual body and host without inferring Pilot or play history', () => {
    for (const explicitOwner of [false, true]) {
        const { outcomes, game } = evidence('eject', (before, after) => {
            const card = { n: 'Determined Recruit', s: 'JTL_159', id: 'observed-detach', p: 3, h: 1, ...(explicitOwner ? { owner: 'p2' } : {}) };
            before.players.p1.ground[0].u = [card, { n: 'Academy Training', s: 'SOR_120', id: 'kept-training', p: 2, h: 2 }];
            after.players.p1.ground[0].u = [before.players.p1.ground[0].u[1]];
            after.players.p1.ground.push({ ...card, p: 3, h: 1, d: 0, x: 1 });
        });
        const move = outcomes.find(o => o.kind === 'attach');
        assert.deepEqual([move.card.id, move.sourceCard.id, move.fromSeat, move.fromZone, move.seat, move.zone], ['observed-detach', 'friend', 'p1', 'ground', 'p1', 'ground']);
        assert.deepEqual(move.unit, game.steps[2].state.players.p1.ground.at(-1));
        assert.equal(move.ownerSeat, explicitOwner ? 'p2' : undefined);
        for (const property of ['targetCard', 'controllerSeat', 'pilotDetach', 'entryType', 'entersReady', 'incarnation', 'sequenceId', 'printedCost', 'trigger']) assert.equal(move[property], undefined, property);
        assert.equal(outcomes.some(o => ['play', 'rescue', 'defeat', 'return', 'pay'].includes(o.kind) && o.card?.id === move.card.id), false);
        assert.equal(game.steps[2].state.players.p1.ground[0].u[0].id, 'kept-training');
    }
});
test('attachment-to-arena matching preserves exact known identity and refuses ambiguous sparse recordings', () => {
    for (const variant of ['known-id', 'unique-no-id', 'duplicate-before', 'duplicate-after', 'unknown-id']) {
        const { outcomes } = evidence('eject', (before, after) => {
            const card = { n: 'Recorded attachment', s: null, ...(variant === 'known-id' || variant === 'unknown-id' ? { id: 'attached' } : {}), p: 1, h: 1 };
            before.players.p1.ground[0].u = [card];
            if (variant === 'duplicate-before') before.players.p2.ground[0].u = [{ ...card }];
            const body = { ...card, p: 2, h: 3, d: 1, x: 1, ...(variant === 'unknown-id' ? { id: 'unmatched' } : {}) };
            after.players.p1.ground.push(body);
            if (variant === 'duplicate-after') after.players.p2.ground.push({ ...body });
        });
        assert.equal(outcomes.some(o => o.kind === 'attach' && o.unit), ['known-id', 'unique-no-id'].includes(variant), variant);
    }
});
