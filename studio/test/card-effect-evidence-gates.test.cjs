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
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX
    } }).outputText;
    const requireFromFile = createRequire(filename);
    new Function('require', 'module', 'exports', code)(specifier => {
        if (specifier.startsWith('.')) {
            const candidate = ['.ts', '.tsx'].map(extension => path.resolve(path.dirname(filename), specifier + extension)).find(fs.existsSync);
            if (candidate) return loadTS(candidate);
        }
        return requireFromFile(specifier);
    }, module, module.exports);
    return module.exports;
}
const { CARD_EFFECTS } = loadTS(path.join(__dirname, '../src/effects/catalogue.ts'));
const { showcaseGame } = loadTS(path.join(__dirname, '../src/effects/showcase.ts'));
const { previewCue } = loadTS(path.join(__dirname, '../src/effects/preview.ts'));
const { resolvePreviewState } = loadTS(path.join(__dirname, '../src/effects/previewState.ts'));
const { observedOutcomes } = loadTS(path.join(__dirname, '../src/effects/outcomes.ts'));
const { batchA03Covers } = loadTS(path.join(__dirname, '../src/effects/batchA03Signatures.tsx'));
const { batchA04Covers } = loadTS(path.join(__dirname, '../src/effects/batchA04Signatures.tsx'));
const { batchA05SecondaryCovers } = loadTS(path.join(__dirname, '../src/effects/batchA05SecondarySignatures.tsx'));
const { batchA05Covers } = loadTS(path.join(__dirname, '../src/effects/batchA05Signatures.tsx'));
const { batchA06SecondaryCovers } = loadTS(path.join(__dirname, '../src/effects/batchA06SecondarySignatures.tsx'));
const { batchA07SecondaryCovers } = loadTS(path.join(__dirname, '../src/effects/batchA07SecondarySignatures.tsx'));
const { batchA07Covers } = loadTS(path.join(__dirname, '../src/effects/batchA07Signatures.tsx'));
const { batchA08SecondaryCovers } = loadTS(path.join(__dirname, '../src/effects/batchA08SecondarySignatures.tsx'));
const { batchA08Covers } = loadTS(path.join(__dirname, '../src/effects/batchA08Signatures.tsx'));
const { batchA09SecondaryCovers } = loadTS(path.join(__dirname, '../src/effects/batchA09SecondarySignatures.tsx'));
const { batchA09Covers } = loadTS(path.join(__dirname, '../src/effects/batchA09Signatures.tsx'));
const { BatchA02Signature } = loadTS(path.join(__dirname, '../src/effects/batchA02Signatures.tsx'));
const { batchA10SecondaryCovers } = loadTS(path.join(__dirname, '../src/effects/batchA10SecondarySignatures.tsx'));
const { batchA11SecondaryCovers } = loadTS(path.join(__dirname, '../src/effects/batchA11SecondarySignatures.tsx'));
const { batchA10Covers } = loadTS(path.join(__dirname, '../src/effects/batchA10Signatures.tsx'));
const box = { x: 500, y: 300, w: 80, h: 112, exact: true, sx: 1, sy: 1 };
const geometry = outcomes => ({ source: box, target: box, friendlyBase: box, zones: {},
    outcomes: outcomes.map((outcome, i) => ({ outcome, box, from: box, to: box, key: String(i), slot: i })) });
function staged(id) {
    const definition = CARD_EFFECTS.find(card => card.id === id);
    const game = showcaseGame(definition);
    const before = game.steps[0].state;
    const cue = previewCue({ definition, nonce: 1 }, before);
    return { ...cue, transition: { before, after: resolvePreviewState(before, cue) } };
}

test('sparse recorded Bamboozle returns remain generic when the host was already exhausted', () => {
    const cue = staged('bamboozle');
    const before = structuredClone(cue.transition.before);
    before.players.p2.ground.find(card => card.id === 'a03:p2:wampa').x = 1;
    const game = { steps: [{ state: before }, { state: cue.transition.after }] };
    const outcomes = observedOutcomes(game, { index: 1, until: 1, seat: 'p1', card: cue.source });
    const recorded = { ...cue, playPayment: undefined, outcomes, transition: { before, after: cue.transition.after } };
    const placed = geometry(outcomes);
    const returns = placed.outcomes.filter(item => item.outcome.kind === 'return');
    assert.equal(returns.length, 2, 'both known ordinary upgrades reached their actual owners');
    assert.equal(outcomes.some(outcome => outcome.kind === 'exhaust'), false);
    assert.equal(outcomes.some(outcome => outcome.card?.n === 'Shield' || outcome.card?.n === 'Experience'), false,
        'disappearance alone does not establish token cessation');
    for (const item of returns) assert.equal(batchA03Covers(recorded, placed, item), false,
        'the rich signature must not suppress a receipt it cannot render');
});

test('complete staged Bamboozle evidence covers its returns; incomplete evidence leaves the generic receipts intact', () => {
    const cue = staged('bamboozle'), placed = geometry(cue.outcomes);
    for (const item of placed.outcomes) assert.equal(batchA03Covers(cue, placed, item), true);
    for (const removedKind of ['exhaust', 'return']) {
        const index = cue.outcomes.findIndex(outcome => outcome.kind === removedKind);
        const incomplete = geometry(cue.outcomes.filter((_, i) => i !== index));
        for (const item of incomplete.outcomes) assert.equal(batchA03Covers(cue, incomplete, item), false,
            `missing ${removedKind} must not swallow remaining receipts`);
    }
});

test('snapshot-only Shoot First evidence does not claim first-strike combat choreography', () => {
    const cue = staged('shoot-first');
    const game = { steps: [{ state: cue.transition.before }, { state: cue.transition.after }] };
    const outcomes = observedOutcomes(game, { index: 1, until: 1, seat: 'p1', card: cue.source });
    assert.ok(outcomes.some(outcome => outcome.kind === 'defeat'));
    assert.ok(outcomes.some(outcome => outcome.kind === 'exhaust'));
    const recorded = { ...cue, outcomes }, placed = geometry(outcomes);
    for (const item of placed.outcomes) assert.equal(batchA03Covers(recorded, placed, item), false);
});

test('A04 snapshot-only movements retain generic receipts when choice, history, chronology or rescue ownership is unknown', () => {
    for (const id of ['i-am-your-father', 'maximum-firepower', 'galactic-ambition', 'medal-ceremony', 'youre-my-only-hope', 'calculated-lethality', 'midnight-repairs', 'covert-strength', 'unexpected-escape']) {
        const cue = staged(id), before = cue.transition.before, after = cue.transition.after;
        const outcomes = observedOutcomes({ steps: [{ state: before }, { state: after }] }, { index: 1, until: 1, seat: 'p1', card: cue.source });
        const recorded = { ...cue, outcomes }, placed = geometry(outcomes);
        for (const item of placed.outcomes) assert.equal(batchA04Covers(recorded, placed, item), false,
            `${id}/${item.outcome.kind}: snapshot deltas cannot supply missing causal evidence`);
    }
});

test('Hope cannot convert an absent nested payment receipt into a paid-zero claim', () => {
    const cue = staged('youre-my-only-hope');
    const complete = geometry(cue.outcomes);
    for (const item of complete.outcomes) assert.equal(batchA04Covers(cue, complete, item), true);
    const incomplete = geometry(cue.outcomes.filter(outcome => outcome.kind !== 'pay'));
    for (const item of incomplete.outcomes) assert.equal(batchA04Covers(cue, incomplete, item), false,
        'partial private-look and play evidence must not hide the known movement or invent its price');
});

test('Escape requires supported captor exhaustion as well as a known rescued arrival', () => {
    const cue = staged('unexpected-escape'), complete = geometry(cue.outcomes);
    for (const item of complete.outcomes) assert.equal(batchA04Covers(cue, complete, item), true);
    const partial = structuredClone(cue);
    partial.outcomes = partial.outcomes.filter(outcome => outcome.kind !== 'exhaust');
    delete partial.transition.after.players.p2.ground.find(card => card.id === 'a04:escape:captor').x;
    const incomplete = geometry(partial.outcomes);
    for (const item of incomplete.outcomes) assert.equal(batchA04Covers(partial, incomplete, item), false,
        'a rescue does not itself establish that the surviving captor exhausted');
});

test('Maximum Firepower rich chronology requires one consecutive sequence with distinct firing units', () => {
    const cue = staged('maximum-firepower'), complete = geometry(cue.outcomes);
    for (const item of complete.outcomes) assert.equal(batchA04Covers(cue, complete, item), true);
    for (const change of ['sequence', 'index', 'source']) {
        const partial = structuredClone(cue), hits = partial.outcomes.filter(outcome => outcome.kind === 'damage');
        if (change === 'sequence') hits[1].sequenceId = 'unrelated-sequence';
        if (change === 'index') hits[1].sequenceIndex = 1;
        if (change === 'source') {
            hits[1].sourceCard = hits[0].sourceCard;
            hits[1].basis = hits[0].basis;
            hits[1].amount = hits[0].amount;
        }
        const incomplete = geometry(partial.outcomes);
        for (const item of incomplete.outcomes) assert.equal(batchA04Covers(partial, incomplete, item), false,
            `${change}: separate hit facts do not establish this ordered two-source action`);
    }
});

test('Fell and Rival retain generic movement when a rich defeat destination lacks its required evidence', () => {
    for (const id of ['fell-the-dragon', 'rivals-fall']) {
        const cue = staged(id), complete = geometry(cue.outcomes);
        assert.ok(complete.outcomes.some(item => batchA05SecondaryCovers(cue, complete, item)), `${id}: complete primary proof`);
        const partial = structuredClone(cue);
        if (id === 'fell-the-dragon') delete partial.outcomes.find(o => o.kind === 'defeat').ownerSeat;
        else delete partial.outcomes.find(o => o.kind === 'defeat').leader;
        const incomplete = geometry(partial.outcomes);
        for (const item of incomplete.outcomes) assert.equal(batchA05SecondaryCovers(partial, incomplete, item), false,
            `${id}: a generic observed defeat must not be suppressed by unavailable rich routing`);
    }
});

test('private top searches cannot reveal faces from selection alone without explicit reveal evidence', () => {
    for (const id of ['remnant-reserves', 'commission']) {
        const cue = staged(id), complete = geometry(cue.outcomes);
        for (const item of complete.outcomes) assert.equal(batchA05SecondaryCovers(cue, complete, item), true);
        const partial = structuredClone(cue);
        delete partial.outcomes.find(o => o.kind === 'search').deckOperation.revealedIds;
        const incomplete = geometry(partial.outcomes);
        for (const item of incomplete.outcomes) assert.equal(batchA05SecondaryCovers(partial, incomplete, item), false,
            'selected movement remains generic when public face visibility is unknown');
    }
});

test('Loyalty draw choreography requires a matching successful prior defeat of the same incarnation', () => {
    const cue = staged('enforced-loyalty'), complete = geometry(cue.outcomes);
    for (const item of complete.outcomes) assert.equal(batchA05SecondaryCovers(cue, complete, item), true);
    for (const change of ['missing', 'incarnation', 'prevented', 'order']) {
        const partial = structuredClone(cue), draw = partial.outcomes.find(o => o.kind === 'draw'), defeat = partial.outcomes.find(o => o.kind === 'defeat');
        if (change === 'missing') delete draw.requiresDefeat;
        if (change === 'incarnation') draw.requiresDefeat.incarnation = 'a-later-entry';
        if (change === 'prevented') defeat.prevented = true;
        if (change === 'order') partial.outcomes.reverse();
        const incomplete = geometry(partial.outcomes);
        for (const item of incomplete.outcomes) assert.equal(batchA05SecondaryCovers(partial, incomplete, item), false,
            `${change}: supported draw/defeat deltas do not establish this causal sequence`);
    }
});

function assertRichA05Boundary(id, mutations) {
    const cue = staged(id), complete = geometry(cue.outcomes);
    for (const item of complete.outcomes) assert.equal(batchA05Covers(cue, complete, item), true, `${id}: complete primary evidence`);
    for (const [label, mutate] of mutations) {
        const partial = structuredClone(cue);
        mutate(partial);
        const incomplete = geometry(partial.outcomes);
        for (const item of incomplete.outcomes) assert.equal(batchA05Covers(partial, incomplete, item), false,
            `${id}/${label}: incomplete evidence must retain generic receipts`);
    }
}

test('upgrade transfer requires explicit ownership and controller evidence on both hosts', () => {
    assertRichA05Boundary('evidence-of-the-crime', [
        ['unknown owner', cue => { delete cue.outcomes[0].ownerSeat; }],
        ['unknown new controller', cue => { delete cue.outcomes[0].upgrade.controller; }],
        ['upgrade still on old host', cue => { cue.transition.after.players.p2.ground.find(c => c.n === 'Wampa').u = cue.transition.before.players.p2.ground.find(c => c.n === 'Wampa').u; }]
    ]);
});

test('discard play must establish nested payment identities separately from the event cost', () => {
    assertRichA05Boundary('palpatines-return', [
        ['missing nested pay', cue => { cue.outcomes = cue.outcomes.filter(o => o.kind !== 'pay'); }],
        ['unknown resources', cue => { delete cue.outcomes.find(o => o.kind === 'pay').cards; }],
        ['reused event payment', cue => { cue.outcomes.find(o => o.kind === 'pay').cards[0] = cue.transition.before.players.p1.resources.find(r => r.id === cue.playPayment.cardIds[0]); }],
        ['pay after play', cue => { cue.outcomes.reverse(); }]
    ]);
});

test('Spark does not infer current-phase eligibility from a discard-to-resource movement', () => {
    assertRichA05Boundary('spark-of-hope', [
        ['history missing', cue => { delete cue.transition.before.defeatedThisPhase; }],
        ['later incarnation', cue => { const o = cue.outcomes[0]; cue.transition.before.mostRecentIncarnations[o.card.id] = 'later-entry'; }],
        ['readiness unknown', cue => { delete cue.outcomes[0].entersReady; }]
    ]);
});

test('Respect captures require complete matching attack history and exact preserved owners', () => {
    assertRichA05Boundary('rule-with-respect', [
        ['history missing', cue => { delete cue.transition.before.attacksThisPhase; }],
        ['other base attacked', cue => { cue.outcomes[0].captureBasis.targetId = cue.transition.before.players.p2.base.id; }],
        ['unknown owner', cue => { delete cue.outcomes[0].ownerSeat; }],
        ['eligible unit omitted', cue => { cue.outcomes.pop(); }]
    ]);
});

test('Legions requires public resource identities and the actual ordered free plays', () => {
    assertRichA05Boundary('endless-legions', [
        ['private visibility', cue => { cue.outcomes.find(o => o.kind === 'inspect').visibility = 'private'; }],
        ['unknown reveal', cue => { delete cue.outcomes.find(o => o.kind === 'inspect').cards; }],
        ['different play order', cue => { cue.outcomes.find(o => o.kind === 'inspect').resourceReveal.playIds.reverse(); }],
        ['absent free payment', cue => { const i = cue.outcomes.findIndex(o => o.kind === 'pay'); cue.outcomes.splice(i, 1); }]
    ]);
});

function assertRichA06SecondaryBoundary(id, mutations) {
    const cue = staged(id), complete = geometry(cue.outcomes);
    for (const item of complete.outcomes) assert.equal(batchA06SecondaryCovers(cue, complete, item), true, `${id}: complete primary evidence`);
    for (const [label, mutate] of mutations) {
        const partial = structuredClone(cue);
        mutate(partial);
        const incomplete = geometry(partial.outcomes);
        for (const item of incomplete.outcomes) assert.equal(batchA06SecondaryCovers(partial, incomplete, item), false,
            `${id}/${label}: unsupported compound meaning must retain generic receipts`);
    }
}

test('Glory cannot turn a damage change or later incarnation into the advertised phase buff', () => {
    assertRichA06SecondaryBoundary('moment-of-glory', [
        ['damage healed', cue => { cue.transition.after.players.p1.ground.find(c => c.id === cue.outcomes[0].card.id).d = 0; }],
        ['different entry', cue => { cue.transition.after.players.p1.ground.find(c => c.id === cue.outcomes[0].card.id).incarnation = 'a-later-entry'; }],
        ['duration absent', cue => { delete cue.outcomes[0].duration; }]
    ]);
});

test('Cripple uses actual total resources and the opposing chooser in one shared window', () => {
    assertRichA06SecondaryBoundary('cripple-authority', [
        ['compares ready count', cue => { const o = cue.outcomes.find(o => o.kind === 'discard'); o.condition.total = cue.transition.before.players[o.seat].res.ready; }],
        ['equal totals', cue => { const o = cue.outcomes.find(o => o.kind === 'discard'); cue.transition.before.players[o.seat].res.total = o.condition.thanTotal; o.condition.total = o.condition.thanTotal; }],
        ['unrelated window', cue => { const o = cue.outcomes.find(o => o.kind === 'discard'); o.resolutionGroup = { ...o.resolutionGroup, id: 'different-window' }; }],
        ['unknown chooser', cue => { delete cue.outcomes.find(o => o.kind === 'discard').chooserSeat; }]
    ]);
});

test('Chaos counts each surviving hand after the source leaves and needs simultaneous evidence', () => {
    assertRichA06SecondaryBoundary('the-chaos-of-war', [
        ['source included', cue => { const o = cue.outcomes.find(o => o.seat === cue.seat); o.basis.sourceIds.push(cue.source.id); o.basis.value++; o.amount++; }],
        ['unknown identity basis', cue => { cue.outcomes[0].basis.sourceIds[0] = 'not-in-that-hand'; }],
        ['different resolution window', cue => { cue.outcomes[1].resolutionGroup = { ...cue.outcomes[1].resolutionGroup, id: 'unrelated-window' }; }],
        ['hand card consumed', cue => { cue.transition.after.players.p2.hand.pop(); }]
    ]);
});

test('Desperate requires the actual existing wound and a bonus linked before its identified attack', () => {
    assertRichA06SecondaryBoundary('desperate-attack', [
        ['unknown damage basis', cue => { delete cue.outcomes.find(o => o.kind === 'buff').attackBonusBasis; }],
        ['healthy attacker', cue => { cue.transition.before.players.p1.ground.find(c => c.id === cue.outcomes.find(o => o.kind === 'buff').card.id).d = 0; }],
        ['bonus from another attack', cue => { cue.outcomes.find(o => o.kind === 'buff').attackId = 'other-attack'; }],
        ['bonus after damage', cue => { cue.outcomes.push(cue.outcomes.shift()); }]
    ]);
});

test('Pillage must preserve both player choice and that player’s own hand selection', () => {
    assertRichA06SecondaryBoundary('pillage', [
        ['unknown player chooser', cue => { delete cue.outcomes[0].playerChoice; }],
        ['random is not player-chosen', cue => { for (const outcome of cue.outcomes) outcome.selection = 'random'; }],
        ['wrong hand chooser', cue => { cue.outcomes[0].chooserSeat = cue.seat; }],
        ['repeated selection', cue => { cue.outcomes[1].card = cue.outcomes[0].card; }],
        ['retained card missing', cue => { cue.transition.after.players.p2.hand = []; }]
    ]);
});

const { batchA06Covers } = loadTS(path.join(__dirname, '../src/effects/batchA06Signatures.tsx'));
const { preparePreviewCue } = loadTS(path.join(__dirname, '../src/effects/previewStages.ts'));
function assertRichA06Boundary(id, mutations, stage) {
    let cue = staged(id);
    if (stage) cue = preparePreviewCue({ definition: cue.definition, nonce: 1, stage }, cue.transition.before);
    const complete = geometry(cue.outcomes);
    for (const item of complete.outcomes) assert.equal(batchA06Covers(cue, complete, item), true, `${id}: complete primary evidence`);
    for (const [label, mutate] of mutations) {
        const partial = structuredClone(cue); mutate(partial); const incomplete = geometry(partial.outcomes);
        for (const item of incomplete.outcomes) assert.equal(batchA06Covers(partial, incomplete, item), false,
            `${id}/${label}: unsupported compound meaning must retain generic receipts`);
    }
}
test('A06 main Timely links separate paid resources to played entry and chosen Ambush', () => {
    assertRichA06Boundary('timely-intervention', [
        ['nested price missing', c => { c.outcomes = c.outcomes.filter(o => o.kind !== 'pay'); }],
        ['event resource spent twice', c => { c.outcomes.find(o => o.kind === 'pay').cards[0] = c.transition.before.players.p1.resources.find(r => r.id === c.playPayment.cardIds[0]); }],
        ['nested resource not spent', c => { delete c.transition.after.players.p1.resources.find(r => r.id === c.outcomes.find(o => o.kind === 'pay').cards[0].id).x; }],
        ['Ambush origin unknown', c => { delete c.outcomes.find(o => o.kind === 'attack').attackOrigin; }]
    ]);
});
test('A06 main exchange requires both continuing units and permanent preserved owners', () => {
    assertRichA06Boundary('choose-sides', [
        ['half exchange', c => { c.outcomes.pop(); }],
        ['unrelated pair', c => { c.outcomes[1].controlExchange = { ...c.outcomes[1].controlExchange, id: 'another-pair' }; }],
        ['temporary control', c => { c.outcomes[0].duration = 'regroup'; }],
        ['owner changed', c => { const o = c.outcomes[0]; c.transition.after.players[o.seat][o.zone].find(u => u.id === o.card.id).owner = o.seat; }]
    ]);
});
test('A06 main Anger keeps the same next-action obligation and does not invent an attack now', () => {
    assertRichA06Boundary('give-in-to-your-anger', [
        ['different after controller', c => { c.transition.after.nextActionConstraints[0].controller = c.seat; }],
        ['different causing event', c => { c.outcomes.find(o => o.nextAction).nextAction.constraint.sourceId = 'other:event'; c.transition.after.nextActionConstraints[0].sourceId = 'other:event'; }],
        ['changed incarnation', c => { c.outcomes.find(o => o.kind === 'restrict').nextAction.constraint.incarnation = 'later-entry'; }],
        ['missing persisted obligation', c => { c.transition.after.nextActionConstraints = []; }],
        ['invented immediate attack', c => { c.outcomes.push({ kind: 'attack', seat: 'p1', zone: 'base', card: c.transition.before.players.p1.base }); }]
    ]);
});
test('A06 main Anger boundary requires the actual obligated player and one completed attack', () => {
    assertRichA06Boundary('give-in-to-your-anger', [
        ['other player action', c => { c.outcomes.find(o => o.kind === 'restrict').nextAction.witness.player = 'p1'; }],
        ['other attack target', c => { c.outcomes.find(o => o.kind === 'restrict').nextAction.witness.targetId = c.transition.before.players.p1.base.id; }],
        ['counterdamage missing', c => { const attack = c.outcomes.find(o => o.kind === 'attack'); c.outcomes = c.outcomes.filter(o => !(o.kind === 'damage' && o.card.id === attack.sourceCard.id)); }]
    ], 'next-action');
});
test('A06 main Headhunting needs consecutive attacks and complete final combat results', () => {
    assertRichA06Boundary('headhunting', [
        ['unordered attack index', c => { c.outcomes.filter(o => o.kind === 'attack')[1].attackIndex = 3; }],
        ['unsupported bonus cause', c => { c.outcomes.find(o => o.kind === 'buff').attackBonusBasis.kind = 'damaged'; }],
        ['unsupported current attacker power', c => { const attack = c.outcomes.find(o => o.kind === 'attack'); attack.sourceCard.p = 9; c.outcomes.find(o => o.kind === 'damage' && o.attackId === attack.attackId).amount = 11; }],
        ['surviving wound absent', c => { c.transition.after.players.p1.ground.find(u => u.id === 'a06:head:hunter').d = 0; }],
        ['unspent survivor', c => { delete c.transition.after.players.p1.space.find(u => u.id === 'a06:p1:xwing').x; }]
    ]);
});
test('A06 main Detention rescue requires a complete departed pocket and new owner entry', () => {
    assertRichA06Boundary('detention-block-rescue', [
        ['cleanup absent', c => { delete c.outcomes.find(o => o.kind === 'defeat').captiveCleanup; }],
        ['actual rescued entry still ready', c => { delete c.transition.after.players.p1.ground.find(u => u.id === 'a06:p1:marine').x; }],
        ['wrong cleanup link', c => { c.outcomes.find(o => o.kind === 'rescue').captiveCleanupId = 'another-cleanup'; }],
        ['rescue before defeat', c => { const i = c.outcomes.findIndex(o => o.kind === 'rescue'); c.outcomes.unshift(c.outcomes.splice(i, 1)[0]); }],
        ['still exhausted unknown', c => { delete c.outcomes.find(o => o.kind === 'rescue').entersReady; }]
    ]);
});

function assertA07Rich(id, mutations) {
    const cue = staged(id), complete = geometry(cue.outcomes);
    for (const item of complete.outcomes) assert.equal(batchA07SecondaryCovers(cue, complete, item), true, `${id}: complete ${item.outcome.kind}`);
    for (const [label, mutate] of mutations) {
        const partial = structuredClone(cue); mutate(partial);
        const placed = geometry(partial.outcomes);
        for (const item of placed.outcomes) assert.equal(batchA07SecondaryCovers(partial, placed, item), false, `${id}: ${label} must keep generic ${item.outcome.kind}`);
    }
}
test('Bravado needs attributed enemy-unit defeat history and preserves ready-target wounds', () => {
    assertA07Rich('bravado', [
        ['unknown attribution', c => delete c.transition.before.defeatedThisPhase.cards[0].defeatedBy],
        ['friendly controller at defeat', c => c.transition.before.defeatedThisPhase.cards[0].controller = 'p1'],
        ['upgrade-only history', c => c.transition.before.defeatedThisPhase.cards[0].lastKnownType = 'upgrade'],
        ['wrong phase', c => c.transition.before.defeatedThisPhase.phase = 'regroup'],
        ['readying fabricated healing', c => c.transition.after.players.p1.space[0].d = 0],
    ]);
});
test('Wookiee choice distinguishes opponent mode from friendly target choice and actual combat result', () => {
    assertA07Rich('let-the-wookiee-win', [
        ['wrong mode chooser', c => c.outcomes.find(o => o.kind === 'ready').choice.chooser = 'p1'],
        ['wrong target chooser', c => c.outcomes.find(o => o.kind === 'ready').chooserSeat = 'p2'],
        ['missing ready', c => c.outcomes = c.outcomes.filter(o => o.kind !== 'ready')],
        ['missing Wookiee bonus basis', c => delete c.outcomes.find(o => o.kind === 'buff').attackBonusBasis],
        ['counterdamage not applied', c => c.transition.after.players.p1.ground.find(u => u.s === 'SHD_200').d = 1],
    ]);
});
test('Look uses actual target-controller payment without changing target readiness', () => {
    assertA07Rich('look-the-other-way', [
        ['wrong controller', c => c.outcomes[0].choice.controller = 'p1'],
        ['absent actual payment identities', c => delete c.outcomes[0].cards],
        ['duplicate payment identity', c => c.outcomes[0].cards = [c.outcomes[0].cards[0], c.outcomes[0].cards[0]]],
        ['resource not spent', c => delete c.transition.after.players.p2.resources[0].x],
        ['unwitnessed exhaustion', c => c.transition.after.players.p2.ground.find(u => u.s === 'SOR_164').x = 1],
    ]);
});
test('Ma Klounkee damage requires prior successful Underworld return and actual owner cleanup', () => {
    assertA07Rich('ma-klounkee', [
        ['missing return dependency', c => delete c.outcomes.find(o => o.kind === 'damage').requiresReturn],
        ['wrong returned incarnation', c => c.outcomes.find(o => o.kind === 'damage').requiresReturn.incarnation = 'a-new-entry'],
        ['damage before return', c => c.outcomes.reverse()],
        ['prevented return', c => c.outcomes.find(o => o.kind === 'return').prevented = true],
        ['attachment went to wrong owner', c => c.transition.after.players.p2.discard = c.transition.after.players.p2.discard.filter(u => u.s !== 'SOR_120')],
    ]);
});
test('Swoop keeps cross-arena permission, modifier roles, Shield removal and final wounds linked', () => {
    assertA07Rich('swoop-down', [
        ['no cross-arena permission', c => delete c.outcomes.find(o => o.kind === 'attack').attackArenaPermission],
        ['defender modifier assigned to attacker', c => c.outcomes.find(o => o.kind === 'debuff').attackRole = 'attacker'],
        ['Shield removal missing', c => c.outcomes = c.outcomes.filter(o => o.card?.n !== 'Shield')],
        ['Shield removed after combat', c => { const i=c.outcomes.findIndex(o => o.card?.n === 'Shield'); c.outcomes.push(c.outcomes.splice(i,1)[0]); }],
        ['counterdamage not applied', c => c.transition.after.players.p1.space[0].d = 0],
    ]);
});

function assertA07MainRich(id, mutations, stage) {
    let cue = staged(id);
    if (stage) cue = preparePreviewCue({ definition: cue.definition, nonce: 1, stage }, cue.transition.before);
    const complete = geometry(cue.outcomes);
    for (const item of complete.outcomes) assert.equal(batchA07Covers(cue, complete, item), true, `${id}/${stage ?? 'primary'}: complete ${item.outcome.kind}`);
    for (const [label, mutate] of mutations) {
        const partial = structuredClone(cue); mutate(partial);
        const placed = geometry(partial.outcomes);
        for (const item of placed.outcomes) assert.equal(batchA07Covers(partial, placed, item), false, `${id}/${stage ?? 'primary'}: ${label} must keep generic ${item.outcome.kind}`);
    }
}
test('Raid links the selected private Vehicle, ready entry, payment and eventual return obligation', () => {
    assertA07MainRich('triple-dark-raid', [
        ['resource summary contradicts cards', c => c.transition.after.players.p1.res.ready++],
        ['owner changed in matching receipt and ending', c => { c.outcomes.find(o => o.kind === 'play').unit.owner = 'p2'; c.transition.after.players.p1.space.find(u => u.id === c.outcomes.find(o => o.kind === 'play').card.id).owner = 'p2'; }],
        ['no explicit zero payment', c => c.outcomes = c.outcomes.filter(o => o.kind !== 'pay')],
        ['not the causing event', c => { c.outcomes.find(o => o.kind === 'delay').pending.sourceId = 'another-event'; c.transition.after.pending[0].sourceId = 'another-event'; }],
        ['private search exposes unchosen cards', c => c.outcomes.find(o => o.kind === 'search').deckOperation.revealedIds = ['a07:raid:other']],
    ]);
});
test('Raid phase-end return consumes only the actual pending entry and preserves owner arrival', () => {
    assertA07MainRich('triple-dark-raid', [
        ['pending still present', c => c.transition.after.pending = structuredClone(c.transition.before.pending)],
        ['different returned incarnation', c => c.outcomes.find(o => o.kind === 'return').incarnation = 'later-entry'],
        ['unknown pending source', c => { c.outcomes.find(o => o.kind === 'delay').pending.sourceId = 'another-event'; c.transition.before.pending[0].sourceId = 'another-event'; }],
    ], 'phase-end');
});
test('Spare collects only the actual granted Bounty with actual known-deck draws', () => {
    assertA07MainRich('spare-the-target', [
        ['missing actual grant', c => c.transition.before.players.p2.ground.find(u => u.s === 'SOR_164').u = []],
        ['wrong collector', c => c.outcomes.find(o => o.kind === 'draw').bountyResolution.collector = 'p2'],
        ['wrong host entry', c => c.outcomes.find(o => o.kind === 'draw').bountyResolution.incarnation = 'old-entry'],
        ['unsupported Bounty effect', c => c.outcomes.find(o => o.kind === 'draw').bountyResolution.amount = 3],
        ['wrong deck suffix', c => c.transition.after.players.p1.knownDeck.reverse()],
    ]);
});
test('Adventure free replay follows the owner choice and successful return into a fresh entry', () => {
    assertA07MainRich('a-new-adventure', [
        ['wrong owner chooser', c => c.outcomes.find(o => o.kind === 'return').choice.owner = 'p1'],
        ['unknown free payment', c => c.outcomes = c.outcomes.filter(o => o.kind !== 'pay')],
        ['missing return dependency', c => delete c.outcomes.find(o => o.kind === 'play').requiresReturn],
        ['same entry reused', c => { const old=c.outcomes.find(o => o.kind === 'return').incarnation; c.outcomes.find(o => o.kind === 'play').unit.incarnation=old; c.transition.after.players.p2.ground.find(u => u.s === 'SOR_164').incarnation=old; }],
        ['upgrade owner cleanup absent', c => c.transition.after.players.p1.discard = c.transition.after.players.p1.discard.filter(u => u.s !== 'SOR_120')],
    ]);
});
test('Final Showdown primary leaves the result pending and readies only actual friendly units', () => {
    assertA07MainRich('final-showdown', [
        ['immediate game result', c => c.transition.after.matchResult = { winner:'p2', loser:'p1', reason:'card-effect', sourceId:c.source.id }],
        ['missing pending obligation', c => c.transition.after.pendingPlayers = []],
        ['unrelated source', c => { c.outcomes.find(o => o.kind === 'delay').playerPending.sourceId = 'another-event'; c.transition.after.pendingPlayers[0].sourceId = 'another-event'; }],
        ['friendly still exhausted', c => c.transition.after.players.p1.ground[0].x = 1],
    ]);
});
test('Final Showdown regroup loss requires the actual boundary and leaves the entire board intact', () => {
    assertA07MainRich('final-showdown', [
        ['not regroup yet', c => c.transition.before.phase = 'action'],
        ['hand changed', c => c.transition.after.players.p1.hand.push({ id:'unexpected-draw', s:'SOR_074', n:'Repair', owner:'p1' })],
        ['resource total changed', c => c.transition.after.players.p2.res.total--],
        ['unit silently healed', c => c.transition.after.players.p1.ground[0].d++],
        ['source absent', c => c.transition.before.players.p1.discard = c.transition.before.players.p1.discard.filter(u => u.id !== c.outcomes.find(o => o.kind === 'delay').playerPending.sourceId)],
    ], 'regroup-start');
});
test('Bounty Posting links selected reveal, actual draw and separately paid ordinary attachment', () => {
    assertA07MainRich('bounty-posting', [
        ['not publicly revealed selection', c => c.outcomes.find(o => o.kind === 'search').deckOperation.revealedIds = []],
        ['draw missing', c => c.outcomes = c.outcomes.filter(o => o.kind !== 'draw')],
        ['pay before draw', c => { const i=c.outcomes.findIndex(o => o.kind === 'pay'); c.outcomes.unshift(c.outcomes.splice(i,1)[0]); }],
        ['wrong attachment controller', c => c.outcomes.find(o => o.kind === 'play').upgrade.controller = 'p2'],
        ['Shield invented on play', c => c.outcomes.push({ kind:'shield', seat:'p2', card:c.outcomes.find(o => o.kind === 'play').targetCard, amount:1 })],
    ]);
});

function assertA08Rich(id, mutations) {
    const cue = staged(id), complete = geometry(cue.outcomes);
    for (const item of complete.outcomes) assert.equal(batchA08SecondaryCovers(cue, complete, item), true, `${id}: complete ${item.outcome.kind}`);
    for (const [label, mutate] of mutations) {
        const partial = structuredClone(cue); mutate(partial);
        const placed = geometry(partial.outcomes);
        for (const item of placed.outcomes) assert.equal(batchA08SecondaryCovers(partial, placed, item), false, `${id}: ${label} must retain generic ${item.outcome.kind}`);
    }
}
test('Surprise Strike preserves the dying defender counterstroke and both owner destinations', () => {
    assertA08Rich('surprise-strike', [
        ['missing counterstroke', c => c.outcomes = c.outcomes.filter(o => !(o.kind === 'damage' && o.attackIndex === 2))],
        ['inflated current attacker power', c => c.outcomes.find(o => o.kind === 'attack').sourceCard = {...c.outcomes.find(o => o.kind === 'attack').sourceCard, p:9}],
        ['wrong attack linkage', c => c.outcomes.find(o => o.kind === 'damage').attackId = 'another-attack'],
        ['attacker not actually discarded', c => c.transition.after.players.p1.discard = c.transition.after.players.p1.discard.filter(o => o.id !== 'a08:p1:marine')],
        ['wrong defender destination owner', c => c.outcomes.find(o => o.kind === 'defeat').ownerSeat = 'p1'],
    ]);
});
test('Evacuate requires every eligible current non-leader and preserves the deployed leader', () => {
    assertA08Rich('evacuate', [
        ['missing one member', c => c.outcomes.pop()],
        ['not simultaneous', c => c.outcomes[0].resolutionGroup = {...c.outcomes[0].resolutionGroup, mode:'sequential'}],
        ['returned into wrong owner hand', c => { const target=c.transition.after.players.p1.hand.pop(); c.transition.after.players.p2.hand.push(target); }],
        ['deployed leader vanished', c => c.transition.after.players.p2.ground = []],
        ['attachment owner discard missing', c => c.transition.after.players.p1.discard = c.transition.after.players.p1.discard.filter(o => o.s !== 'SOR_120')],
    ]);
});
test('No Bargain shows the opponent choice and independent simultaneous actual draw', () => {
    assertA08Rich('no-bargain', [
        ['wrong chooser', c => c.outcomes.find(o => o.kind === 'discard').chooserSeat = 'p1'],
        ['random selection masquerades as chosen', c => c.outcomes.find(o => o.kind === 'discard').selection = 'random'],
        ['different simultaneous group', c => c.outcomes.find(o => o.kind === 'discard').resolutionGroup = {id:'unrelated',mode:'simultaneous'}],
        ['discard dependency incorrectly added', c => c.outcomes.find(o => o.kind === 'draw').requiresDefeat = {id:'a08:p2:hand:takedown',incarnation:'not-a-unit'}],
        ['wrong known top drawn', c => c.outcomes.find(o => o.kind === 'draw').cards = [c.transition.before.players.p1.knownDeck[1]]],
    ]);
});
test('This Is The Way reveals only qualifying selections and preserves the untouched deck suffix', () => {
    assertA08Rich('this-is-the-way', [
        ['all private faces revealed', c => c.outcomes.find(o => o.kind === 'search').deckOperation.revealedIds = c.outcomes.find(o => o.kind === 'search').deckOperation.looked.map(c=>c.id)],
        ['public whole-deck search substituted', c => c.outcomes.find(o => o.kind === 'search').deckOperation.visibility = 'public'],
        ['actual draw absent', c => c.outcomes = c.outcomes.filter(o => o.kind !== 'draw')],
        ['untouched suffix reordered', c => c.transition.after.players.p1.knownDeck.reverse()],
        ['selected duplicate', c => { const op=c.outcomes.find(o => o.kind === 'search').deckOperation; op.selectedIds=[op.selectedIds[0],op.selectedIds[0]]; }],
    ]);
});
test('Confiscate removes the actual upgrade while retaining host wounds and other attachments', () => {
    assertA08Rich('confiscate', [
        ['owner unknown', c => delete c.outcomes[0].ownerSeat],
        ['host power not rolled back', c => c.transition.after.players.p2.ground.find(o => o.id === 'a08:p2:wampa').p += 2],
        ['Shield silently removed', c => c.transition.after.players.p2.ground.find(o => o.id === 'a08:p2:wampa').u = []],
        ['host silently healed', c => c.transition.after.players.p2.ground.find(o => o.id === 'a08:p2:wampa').d = 0],
        ['upgrade still attached', c => c.transition.after.players.p2.ground.find(o => o.id === 'a08:p2:wampa').u.push(c.transition.before.players.p2.ground.find(o => o.id === 'a08:p2:wampa').u[0])],
    ]);
});

function assertA08MainRich(id, mutations) {
    const cue = staged(id), complete = geometry(cue.outcomes);
    for (const item of complete.outcomes) assert.equal(batchA08Covers(cue, complete, item), true, `${id}: complete ${item.outcome.kind}`);
    for (const [label, mutate] of mutations) {
        const partial = structuredClone(cue); mutate(partial);
        const placed = geometry(partial.outcomes);
        for (const item of placed.outcomes) assert.equal(batchA08Covers(partial, placed, item), false, `${id}: ${label} must retain generic ${item.outcome.kind}`);
    }
}
test('Pursuit independently proves printed-cost capture and its Bounty Hunter Shield', () => {
    const cue = staged('relentless-pursuit');
    const complete = geometry(cue.outcomes);
    for (const item of complete.outcomes) assert.equal(batchA08Covers(cue, complete, item), true);
    for (const [label, mutate] of [
        ['unsupported printed cost', c => c.outcomes.find(o => o.kind === 'capture').captureCost.targetPrintedCost = 2],
        ['prevented capture', c => c.outcomes.find(o => o.kind === 'capture').prevented = true],
        ['wrong captured entry', c => c.outcomes.find(o => o.kind === 'capture').incarnation = 'old-entry'],
        ['missing attachment disposal', c => c.transition.after.players.p1.discard = c.transition.after.players.p1.discard.filter(x => x.id !== 'a08:pursuit:academy')],
    ]) {
        const partial = structuredClone(cue); mutate(partial); const placed = geometry(partial.outcomes);
        assert.equal(batchA08Covers(partial, placed, placed.outcomes.find(i => i.outcome.kind === 'capture')), false, label);
        assert.equal(batchA08Covers(partial, placed, placed.outcomes.find(i => i.outcome.kind === 'shield')), true, `${label}: independent Shield stays supported`);
    }
    const noShield = structuredClone(cue); noShield.transition.after.players.p1.ground.find(x => x.id === 'a08:pursuit:toro').u = [];
    const placed = geometry(noShield.outcomes);
    assert.equal(batchA08Covers(noShield, placed, placed.outcomes.find(i => i.outcome.kind === 'shield')), false);
    assert.equal(batchA08Covers(noShield, placed, placed.outcomes.find(i => i.outcome.kind === 'capture')), true);
    assertA08MainRich('relentless-pursuit', [['unpaid event', c => c.transition.after.players.p1.res.ready++]]);
});
test('Altering the Deal moves the actual captive to its owner while preserving the guard', () => {
    assertA08MainRich('altering-the-deal', [
        ['wrong guard', c => c.outcomes[0].sourceCard.id = 'a08:p1:marine'],
        ['wrong owner', c => c.outcomes[0].ownerSeat = 'p1'],
        ['captive still in pocket', c => c.transition.after.players.p1.space[0].cap = structuredClone(c.transition.before.players.p1.space[0].cap)],
        ['guard damaged without evidence', c => c.transition.after.players.p1.space[0].d++],
        ['missing owner discard', c => c.transition.after.players.p2.discard = []],
    ]);
});
test('Smugglers Aid keeps actual resource payment, private replacement and healing linked', () => {
    assertA08MainRich('smugglers-aid', [
        ['wrong resource source', c => c.playPayment.smuggle.sourceId = 'other-source'],
        ['public replacement', c => c.outcomes.find(o => o.kind === 'resource').visibility = 'public'],
        ['replacement enters ready', c => c.outcomes.find(o => o.kind === 'resource').entersReady = true],
        ['wrong deck top', c => c.outcomes.find(o => o.kind === 'resource').card = structuredClone(c.transition.before.players.p1.knownDeck[1])],
        ['replacement count fabricated', c => c.transition.after.players.p1.res.total++],
        ['healing not applied', c => c.transition.after.players.p1.base.d = 9],
    ]);
});
test('A Fine Addition needs current enemy defeat history and separate paid owner-preserving upgrade play', () => {
    assertA08MainRich('a-fine-addition', [
        ['wrong phase', c => c.transition.before.defeatedThisPhase.phase = 'regroup'],
        ['friendly defeat only', c => c.transition.before.defeatedThisPhase.cards[0].controller = 'p1'],
        ['wrong causing event', c => c.outcomes.find(o => o.kind === 'play').upgradePlayPermission.sourceId = 'other-event'],
        ['unpaid nested play', c => c.outcomes.find(o => o.kind === 'pay').cards = []],
        ['prevented cost adjustment', c => c.outcomes.find(o => o.kind === 'cost').prevented = true],
        ['prevented nested payment', c => c.outcomes.find(o => o.kind === 'pay').prevented = true],
        ['ownership reassigned', c => c.transition.after.players.p1.ground[0].u[0].owner = 'p1'],
        ['upgrade still in discard', c => c.transition.after.players.p2.discard.push(structuredClone(c.outcomes.find(o => o.kind === 'play').card))],
    ]);
});
test('Lethal Crackdown seals actual power before defeat and requires that successful entry', () => {
    assertA08MainRich('lethal-crackdown', [
        ['prevented defeat', c => c.outcomes.find(o => o.kind === 'defeat').prevented = true],
        ['wrong departed entry', c => c.outcomes.find(o => o.kind === 'damage').requiresDefeat.incarnation = 'later-entry'],
        ['post-cleanup power substituted', c => { const d = c.outcomes.find(o => o.kind === 'damage'); d.amount = 5; d.basis.value = 5; c.transition.after.players.p1.base.d = 14; }],
        ['damage before defeat', c => c.outcomes.reverse()],
        ['wrong damaged base', c => c.outcomes.find(o => o.kind === 'damage').card = structuredClone(c.transition.before.players.p2.base)],
        ['missing attachment disposal', c => c.transition.after.players.p1.discard = c.transition.after.players.p1.discard.filter(x => x.id !== 'a08:crackdown:academy')],
    ]);
});

test('A08 secondary signatures reject internally consistent underpayment and a renamed physical source', () => {
    for (const id of ['surprise-strike', 'evacuate', 'no-bargain', 'this-is-the-way', 'confiscate']) {
        assertA08Rich(id, [
            ['one resource underpaid', c => {
                const released = c.playPayment.cardIds.pop();
                c.playCost--;
                delete c.transition.after.players.p1.resources.find(r => r.id === released).x;
                c.transition.after.players.p1.res.ready++;
            }],
            ['same invented source title throughout', c => {
                const source = c.source.id;
                c.source.n = 'Unrelated event';
                for (const state of [c.transition.before, c.transition.after]) {
                    for (const card of [...state.players.p1.hand, ...state.players.p1.discard]) if (card.id === source) card.n = 'Unrelated event';
                }
            }],
        ]);
    }
});
test('A08 successful combat, draw and search signatures reject explicitly prevented receipts', () => {
    assertA08Rich('surprise-strike', ['attack', 'buff', 'damage', 'exhaust'].map(kind => [`prevented ${kind}`, c => { c.outcomes.find(o => o.kind === kind).prevented = true; }]));
    assertA08Rich('no-bargain', [['prevented draw', c => { c.outcomes.find(o => o.kind === 'draw').prevented = true; }]]);
    assertA08Rich('this-is-the-way', ['search', 'draw'].map(kind => [`prevented ${kind}`, c => { c.outcomes.find(o => o.kind === kind).prevented = true; }]));
});
test('A08 secondary signatures compare coherently renamed evidence against the canonical registry',()=>{
    for(const id of ['surprise-strike','evacuate','no-bargain','this-is-the-way','confiscate'])assertA08Rich(id,[
        ['definition and every physical source coherently renamed',c=>{
            const eventId=c.source.id;c.definition.name='Unrelated event';
            const visit=x=>{if(!x||typeof x!=='object')return;if(x.id===eventId&&'n'in x)x.n='Unrelated event';for(const value of Object.values(x))visit(value);};visit(c);
        }],
    ]);
});
test('A07 main regressions reject a coherently underpaid source event', () => {
    for (const id of ['triple-dark-raid', 'spare-the-target', 'a-new-adventure', 'final-showdown', 'bounty-posting']) {
        assertA07MainRich(id, [['one resource underpaid', c => {
            const released = c.playPayment.cardIds.pop();
            c.playCost--;
            delete c.transition.after.players.p1.resources.find(r => r.id === released).x;
            c.transition.after.players.p1.res.ready++;
        }]]);
    }
});

function assertA09Secondary(id, mutations) {
    const cue = staged(id), complete = geometry(cue.outcomes);
    for (const item of complete.outcomes) assert.equal(batchA09SecondaryCovers(cue, complete, item), true, `${id}: complete ${item.outcome.kind}`);
    for (const [label, mutate] of mutations) {
        const partial = structuredClone(cue), original = JSON.stringify(partial); mutate(partial);
        assert.notEqual(JSON.stringify(partial), original, `${id}: mutation ${label} must actually alter evidence`);
        const placed = geometry(partial.outcomes);
        for (const item of placed.outcomes) assert.equal(batchA09SecondaryCovers(partial, placed, item), false, `${id}: ${label} must retain generic ${item.outcome.kind}`);
    }
}
test('A09 secondary signatures compute source cost and reject coherent underpayment and prevention', () => {
    for (const id of ['hello-there', 'equalize', 'i-have-the-high-ground', 'guarding-the-way', 'disruptive-burst']) {
        assertA09Secondary(id, [
            ['coherent one-resource underpayment', c => {
                const released = c.playPayment.cardIds.pop(); c.playCost--;
                delete c.transition.after.players.p1.resources.find(r => r.id === released).x;
                c.transition.after.players.p1.res.ready++;
            }],
            ['same renamed event in all snapshots', c => {
                const sourceId = c.source.id; c.source.n = 'Another event';
                for (const state of [c.transition.before, c.transition.after]) for (const ref of [...state.players.p1.hand, ...state.players.p1.discard]) if (ref.id === sourceId) ref.n = 'Another event';
            }],
            ['first declared effect explicitly prevented', c => { c.outcomes[0].prevented = true; }],
        ]);
    }
});
test('Hello There needs the current entered-phase witness and preserves wounds and exhausted pose', () => {
    assertA09Secondary('hello-there', [
        ['no entry history', c => delete c.transition.before.enteredThisPhase],
        ['previous phase', c => c.outcomes[0].enteredPhase.phase = 'regroup'],
        ['older incarnation', c => c.outcomes[0].enteredPhase.incarnation = 'old-entry'],
        ['actual entrant unrecorded', c => c.transition.before.enteredThisPhase.units = []],
        ['survivor silently readied', c => delete c.transition.after.players.p2.ground.find(u => u.id === c.outcomes[0].card.id).x],
        ['stat reduction invents Sentinel', c => c.transition.after.players.p2.ground.find(u => u.id === c.outcomes[0].card.id).sn = 1],
        ['survivor changes arena', c => { const p=c.transition.after.players.p2, i=p.ground.findIndex(u=>u.id===c.outcomes[0].card.id); p.space.push(p.ground.splice(i,1)[0]); }],
        ['debuff treated as wounds', c => c.transition.after.players.p2.ground.find(u => u.id === c.outcomes[0].card.id).d++],
    ]);
});
test('Equalize keeps first resolution, controller count and distinct second target in order', () => {
    assertA09Secondary('equalize', [
        ['wrong current count', c => c.outcomes.filter(o => o.kind === 'debuff')[1].unitCountCondition.otherCount++],
        ['condition uses owner instead of first controller', c => c.outcomes.filter(o => o.kind === 'debuff')[1].unitCountCondition.against = 'p1'],
        ['missing sequence identity', c => delete c.outcomes.filter(o => o.kind === 'debuff')[1].sequenceId],
        ['second precedes first', c => { const a=c.outcomes.findIndex(o=>o.kind==='debuff'), b=c.outcomes.findIndex((o,i)=>o.kind==='debuff'&&i>a); [c.outcomes[a],c.outcomes[b]]=[c.outcomes[b],c.outcomes[a]]; }],
        ['same target twice', c => { const d=c.outcomes.filter(o=>o.kind==='debuff'); d[1].card=structuredClone(d[0].card); }],
        ['defeated unit not actually discarded', c => { const d=c.outcomes.find(o=>o.kind==='defeat'); c.transition.after.players[d.ownerSeat].discard=c.transition.after.players[d.ownerSeat].discard.filter(x=>x.id!==d.card.id); }],
    ]);
});
test('High Ground binds a conditional defender status without changing resting stats', () => {
    assertA09Secondary('i-have-the-high-ground', [
        ['wrong causing source', c => c.outcomes[0].defenseModifier.sourceId = 'other-event'],
        ['stale continuing entry', c => c.outcomes[0].defenseModifier.incarnation = 'old-entry'],
        ['persistent status missing', c => c.transition.after.players.p1.ground.find(u=>u.id===c.outcomes[0].card.id).status = []],
        ['resting defender changed', c => c.transition.after.players.p1.ground.find(u=>u.id===c.outcomes[0].card.id).p--],
        ['unrelated enemy weakened', c => c.transition.after.players.p2.ground[0].p--],
    ]);
});
test('Guarding the Way needs actor initiative for the separate bonus and a visible Sentinel grant', () => {
    assertA09Secondary('guarding-the-way', [
        ['actor lacks initiative', c => c.transition.before.initiative = 'p2'],
        ['false initiative witness', c => c.outcomes.find(o=>o.kind==='buff').condition.initiative = 'p2'],
        ['missing granted keyword', c => delete [...c.transition.after.players.p1.ground,...c.transition.after.players.p1.space].find(u=>u.id===c.outcomes.find(o=>o.kind==='keyword').card.id).sn],
        ['missing persistent keyword', c => { const u=[...c.transition.after.players.p1.ground,...c.transition.after.players.p1.space].find(u=>u.id===c.outcomes.find(o=>o.kind==='keyword').card.id); u.status=u.status.filter(s=>s.kind!=='keyword'); }],
        ['wrong unit receives bonus', c => c.outcomes.find(o=>o.kind==='buff').card=structuredClone(c.transition.before.players.p2.ground[0])],
    ]);
});
test('Disruptive Burst accounts for every enemy in both arenas and token cessation', () => {
    assertA09Secondary('disruptive-burst', [
        ['one enemy receipt absent', c => c.outcomes.splice(c.outcomes.findIndex(o=>o.kind==='debuff'),1)],
        ['friendly target substituted', c => c.outcomes.find(o=>o.kind==='debuff').seat='p1'],
        ['existing wounds erased', c => c.transition.after.players.p2.ground.find(u=>u.d>0).d=0],
        ['token fabricated in discard', c => { const t=c.transition.before.players.p2.ground.find(u=>u.t===1); c.transition.after.players.p2.discard.push(structuredClone(t)); }],
        ['deployed leader omitted', c => { const id=c.transition.before.players.p2.leader.id; c.outcomes=c.outcomes.filter(o=>o.card?.id!==id); }],
    ]);
});

function assertA09Main(id, mutations, onlyKind) {
    const cue = staged(id), complete = geometry(cue.outcomes);
    for (const item of complete.outcomes) assert.equal(batchA09Covers(cue, complete, item), true, `${id}: complete ${item.outcome.kind}`);
    for (const [label, mutate] of mutations) {
        const partial = structuredClone(cue), original = JSON.stringify(partial); mutate(partial);
        assert.notEqual(JSON.stringify(partial), original, `${id}: mutation ${label} must change actual evidence`);
        const placed = geometry(partial.outcomes), affected=placed.outcomes.filter(i=>!onlyKind||i.outcome.kind===onlyKind);
        assert.ok(affected.length, `${id}: ${label} has a remaining affected receipt`);
        for (const item of affected) assert.equal(batchA09Covers(partial, placed, item), false, `${id}: ${label} must retain generic ${item.outcome.kind}`);
    }
}
test('A09 main signatures independently compare canonical event, source zone and exact legal resource payment', () => {
    for (const id of ['grievous-reassembly','death-by-droids','the-invasion-of-christophsis','reprocess','consolidation-of-power']) assertA09Main(id,[
        ['coherent underpayment',c=>{const released=c.playPayment.cardIds.pop();c.playCost--;delete c.transition.after.players.p1.resources.find(r=>r.id===released).x;c.transition.after.players.p1.res.ready++;}],
        ['coherent source rename',c=>{const id=c.source.id;c.source.n='Unrelated event';for(const state of [c.transition.before,c.transition.after])for(const ref of [...state.players.p1.hand,...state.players.p1.discard])if(ref.id===id)ref.n='Unrelated event';}],
        ['event remains in hand too',c=>c.transition.after.players.p1.hand.push(structuredClone(c.source))],
        ['resource payment borrowed from Smuggle',c=>c.playPayment.smuggle={resourceId:c.source.id}],
    ]);
});
test('A09 independent creations require actual new exhausted token entries without invented played origins',()=>{
    for(const id of ['grievous-reassembly','death-by-droids']) assertA09Main(id,[
        ['creation prevented',c=>c.outcomes.find(o=>o.kind==='create').prevented=true],
        ['creation claims played entry',c=>c.outcomes.find(o=>o.kind==='create').entryType='played'],
        ['token claims a hand source',c=>c.outcomes.find(o=>o.kind==='create').fromZone='hand'],
        ['token outcome owner wrong',c=>c.outcomes.find(o=>o.kind==='create').ownerSeat='p2'],
        ['token silently readied',c=>{const id=c.outcomes.find(o=>o.kind==='create').card.id;delete c.transition.after.players.p1.ground.find(u=>u.id===id).x;}],
        ['token is a previously existing object',c=>c.transition.before.players.p1.discard.push(structuredClone(c.outcomes.find(o=>o.kind==='create').card))],
        ['token falsely survives in discard too',c=>c.transition.after.players.p1.discard.push(structuredClone(c.outcomes.find(o=>o.kind==='create').card))],
    ],'create');
});
test('Reassembly and Death by Droids keep creation independent of unsupported healing or defeat',()=>{
    for(const [id,kind]of[['grievous-reassembly','heal'],['death-by-droids','defeat']]){
        const cue=staged(id);cue.outcomes.find(o=>o.kind===kind).prevented=true;const g=geometry(cue.outcomes);
        assert.equal(batchA09Covers(cue,g,g.outcomes.find(i=>i.outcome.kind===kind)),false);
        for(const item of g.outcomes.filter(i=>i.outcome.kind==='create'))assert.equal(batchA09Covers(cue,g,item),true,'separately witnessed creation is independent');
    }
    assertA09Main('grievous-reassembly',[
        ['healing changes power',c=>c.transition.after.players.p2.ground.find(u=>u.id===c.outcomes.find(o=>o.kind==='heal').card.id).p++],
        ['healing erases more wounds',c=>c.transition.after.players.p2.ground.find(u=>u.id===c.outcomes.find(o=>o.kind==='heal').card.id).d=0],
    ],'heal');
    assertA09Main('death-by-droids',[
        ['wrong printed cost witness',c=>c.outcomes.find(o=>o.kind==='defeat').printedCost=2],
        ['wrong actual owner destination',c=>{const id=c.outcomes.find(o=>o.kind==='defeat').card.id;const q=c.transition.after.players.p2,i=q.discard.findIndex(u=>u.id===id);c.transition.after.players.p1.discard.push(q.discard.splice(i,1)[0]);}],
    ],'defeat');
});
test('Invasion requires selected current controlled sacrifices before exact payment and all opponent units afterward',()=>{
    assertA09Main('the-invasion-of-christophsis',[
        ['prevented cost sacrifice',c=>c.outcomes[0].prevented=true],
        ['stale selected entry',c=>c.playPayment.exploit.units[0].incarnation='previous-entry'],
        ['cost before sacrifices',c=>{const i=c.outcomes.findIndex(o=>o.kind==='cost');c.outcomes.unshift(c.outcomes.splice(i,1)[0]);}],
        ['sacrifice role absent',c=>delete c.outcomes[0].paymentRole],
        ['discount receipt inflated',c=>c.outcomes.find(o=>o.kind==='cost').amount=-10],
        ['discount prevented',c=>c.outcomes.find(o=>o.kind==='cost').prevented=true],
        ['opponent space target omitted',c=>{const id=c.transition.before.players.p2.space[0].id;c.outcomes=c.outcomes.filter(o=>o.card?.id!==id);}],
        ['token invented in discard',c=>c.transition.after.players.p1.discard.push(structuredClone(c.transition.before.players.p1.ground.find(u=>u.t)))],
        ['leader fails to undeploy',c=>c.transition.after.players.p2.leader.dep=1],
        ['own survivor changed',c=>c.transition.after.players.p1.ground[0].d++],
    ]);
});
test('Reprocess counts chosen discard units and preserves exact bottom order and fresh creation',()=>{
    assertA09Main('reprocess',[
        ['chosen group contradicts one creation',c=>c.outcomes.find(o=>o.kind==='create').chosenUnitGroup='other-choice'],
        ['chosen event substituted for unit',c=>{const ev=c.transition.before.players.p1.discard.find(u=>u.s==='SOR_074');for(const o of c.outcomes)o.cards[0]=structuredClone(ev);}],
        ['one token absent',c=>c.outcomes.splice(c.outcomes.findIndex(o=>o.kind==='create'),1)],
        ['wrong bottom permutation',c=>{const a=c.transition.after.players.p1.knownDeck;[a[a.length-1],a[a.length-2]]=[a[a.length-2],a[a.length-1]];}],
        ['recovery still in discard',c=>c.transition.after.players.p1.discard.push(structuredClone(c.outcomes.find(o=>o.kind==='recover').card))],
        ['recovery marked prevented despite departure',c=>c.outcomes.find(o=>o.kind==='recover').prevented=true],
        ['one created token prevented',c=>c.outcomes.find(o=>o.kind==='create').prevented=true],
    ]);
});
test('Consolidation seals current chosen power, free payment and played arrival before original sacrifices',()=>{
    assertA09Main('consolidation-of-power',[
        ['printed instead of modified power',c=>{for(const o of c.outcomes)o.chosenUnits[0].power=3;}],
        ['stale chosen incarnation',c=>{for(const o of c.outcomes)o.chosenUnits[0].incarnation='previous-entry';}],
        ['unknown free payment',c=>delete c.outcomes.find(o=>o.kind==='pay').amount],
        ['free payment prevented',c=>c.outcomes.find(o=>o.kind==='pay').prevented=true],
        ['play prevented',c=>c.outcomes.find(o=>o.kind==='play').prevented=true],
        ['played entry is creation',c=>c.outcomes.find(o=>o.kind==='play').entryType='created'],
        ['new unit silently ready',c=>{const id=c.outcomes.find(o=>o.kind==='play').card.id;delete c.transition.after.players.p1.ground.find(u=>u.id===id).x;}],
        ['sacrifice before entry',c=>{const i=c.outcomes.findIndex(o=>o.kind==='defeat');c.outcomes.unshift(c.outcomes.splice(i,1)[0]);}],
        ['one selected sacrifice missing',c=>c.outcomes.splice(c.outcomes.findIndex(o=>o.kind==='defeat'),1)],
        ['sacrificed upgrade goes to controller',c=>{const id=c.transition.before.players.p1.ground[0].u[0].id,q=c.transition.after.players.p2,i=q.discard.findIndex(u=>u.id===id);c.transition.after.players.p1.discard.push(q.discard.splice(i,1)[0]);}],
    ]);
});

test('A09 secondary rich signatures reject an explicitly different causing event',()=>{
    for(const id of ['hello-there','equalize','i-have-the-high-ground','guarding-the-way','disruptive-burst'])assertA09Secondary(id,[
        ['opponent Takedown named as cause',c=>{const other=c.transition.before.players.p2.hand.find(u=>u.s==='SOR_077');for(const o of c.outcomes)o.sourceCard=structuredClone(other);}],
        ['cause absent from one required receipt',c=>delete c.outcomes[0].sourceCard],
    ]);
});

test('A09 secondary signatures bind canonical definitions and the continuing phase',()=>{
    for(const id of ['hello-there','equalize','i-have-the-high-ground','guarding-the-way','disruptive-burst'])assertA09Secondary(id,[
        ['definition and all source references coherently renamed',c=>{
            const eventId=c.source.id;c.definition.name='Unrelated event';
            const rename=x=>{if(!x||typeof x!=='object')return;if(x.id===eventId&&'n'in x)x.n='Unrelated event';for(const value of Object.values(x))rename(value);};
            rename(c);
        }],
        ['ending is another round',c=>c.transition.after.round++],
        ['ending is outside the granted phase',c=>c.transition.after.phase='regroup'],
    ]);
});

test('U-Wing shows the verified event payment during playback and leaves unknown payment unclaimed',()=>{
    const React=require('../node_modules/react'),{renderToStaticMarkup}=require('../node_modules/react-dom/server');
    const render=cue=>{const g=geometry(cue.outcomes);g.zones={'p1:resources':box,'p1:resource-count':box,'p1:discard':box};return renderToStaticMarkup(React.createElement(BatchA02Signature,{cue,geometry:g,p:.95}));};
    const cue=staged('uwing-reinforcement'),html=render(cue);
    assert.match(html,/>3\/10</,'the paid resource balance is visible before completion');
    assert.match(html,/EVENT 7 PAID/);
    for(const mutate of [c=>delete c.playCost,c=>delete c.transition,c=>c.playPayment={kind:'resources',cardIds:['unproved-resource']},c=>c.transition.after.players.p1.res.ready++,c=>c.transition.after.players.p1.hand.push(structuredClone(c.source)),c=>c.transition.after.players.p1.discard=[]]){
        const missing=structuredClone(cue);mutate(missing);const fallback=render(missing);
        assert.doesNotMatch(fallback,/EVENT 7 PAID/,'unsupported event payment is not claimed');
        assert.doesNotMatch(fallback,/>3\/10</,'unsupported resource result is not overlaid');
    }
});

function assertA10Secondary(id, mutations) {
    const cue=staged(id),complete=geometry(cue.outcomes);
    for(const item of complete.outcomes)assert.equal(batchA10SecondaryCovers(cue,complete,item),true,`${id}: primary ${item.outcome.kind}`);
    for(const [label,mutate] of mutations){
        const partial=structuredClone(cue),original=JSON.stringify(partial);mutate(partial);
        assert.notEqual(JSON.stringify(partial),original,`${id}: ${label} changes evidence`);
        const placed=geometry(partial.outcomes);assert.ok(placed.outcomes.length);
        for(const item of placed.outcomes)assert.equal(batchA10SecondaryCovers(partial,placed,item),false,`${id}: ${label} preserves generic ${item.outcome.kind}`);
    }
}
test('A10 secondary signatures bind canonical source, legal paid resources and continuing phase',()=>{
    for(const id of ['synchronized-strike','petition-the-senate','outflank','tactical-advantage','encouraging-leadership'])assertA10Secondary(id,[
        ['coherent underpayment',c=>{const paid=c.playPayment.cardIds.pop();c.playCost--;delete c.transition.after.players.p1.resources.find(r=>r.id===paid).x;c.transition.after.players.p1.res.ready++;}],
        ['coherent false canonical title',c=>{const eventId=c.source.id;c.definition.name='Unrelated event';const visit=x=>{if(!x||typeof x!=='object')return;if(x.id===eventId&&'n'in x)x.n='Unrelated event';for(const v of Object.values(x))visit(v);};visit(c);}],
        ['event still held after disposal',c=>c.transition.after.players.p1.hand.push(structuredClone(c.source))],
        ['another ending phase',c=>c.transition.after.phase='regroup'],
        ['another ending round',c=>c.transition.after.round++],
        ['unrelated opponent payment',c=>{c.transition.after.players.p2.res.ready--;c.transition.after.players.p2.resources.find(r=>!r.x).x=1;}],
        ['prevented effect',c=>c.outcomes[0].prevented=true],
    ]);
});
test('Synchronized Strike counts exact controlled entries in the recipient arena',()=>{
    assertA10Secondary('synchronized-strike',[
        ['count claims power',c=>c.outcomes[0].basis.kind='unit-power'],
        ['opponent contributors',c=>c.outcomes[0].basis.player='p2'],
        ['wrong arena count',c=>c.outcomes[0].basis.arena='space'],
        ['one repeated witness',c=>c.outcomes[0].basis.sourceIds[1]=c.outcomes[0].basis.sourceIds[0]],
        ['count inflated',c=>c.outcomes[0].basis.value++],
        ['wrong causing event',c=>c.outcomes[0].sourceCard=structuredClone(c.transition.before.players.p2.hand[0])],
        ['unrecorded extra wound',c=>c.transition.after.players.p2.ground.find(u=>u.id===c.outcomes[0].card.id).d++],
        ['friendly recipient',c=>c.outcomes[0].seat='p1'],
    ]);
});
test('Petition draws actual top cards only with three distinct current Official witnesses',()=>{
    assertA10Secondary('petition-the-senate',[
        ['only two witnesses',c=>c.outcomes[0].traitCondition.units.pop()],
        ['duplicate Official',c=>c.outcomes[0].traitCondition.units[1]=structuredClone(c.outcomes[0].traitCondition.units[0])],
        ['stale Official entry',c=>c.outcomes[0].traitCondition.units[0].incarnation='earlier-entry'],
        ['no actual Official trait',c=>{const id=c.outcomes[0].traitCondition.units[0].id;for(const state of [c.transition.before,c.transition.after])state.players.p1.ground.find(u=>u.id===id).traits=[];}],
        ['trait claim on wrong printed face',c=>{const id=c.outcomes[0].traitCondition.units[0].id;for(const state of [c.transition.before,c.transition.after])state.players.p1.ground.find(u=>u.id===id).s='SOR_095';}],
        ['Official title contradicts printed face',c=>{const id=c.outcomes[0].traitCondition.units[0].id;for(const state of [c.transition.before,c.transition.after])state.players.p1.ground.find(u=>u.id===id).n='Wampa';}],
        ['threshold weakened',c=>c.outcomes[0].traitCondition.minimum=2],
        ['third drawn card is not deck top',c=>c.outcomes[0].cards[2]=structuredClone(c.transition.before.players.p1.knownDeck[5])],
        ['remaining deck order changed',c=>{const d=c.transition.after.players.p1.knownDeck;[d[0],d[1]]=[d[1],d[0]];}],
        ['drawn card absent from actual hand',c=>c.transition.after.players.p1.hand.pop()],
    ]);
});
test('Outflank resolves first actual combat before a distinct legal second attacker',()=>{
    assertA10Secondary('outflank',[
        ['same attacker selected twice',c=>c.outcomes.filter(o=>o.kind==='attack')[1].sourceCard=structuredClone(c.outcomes.find(o=>o.kind==='attack').sourceCard)],
        ['first attacker already exhausted',c=>{const id=c.outcomes.find(o=>o.kind==='attack').sourceCard.id;c.transition.before.players.p1.ground.find(u=>u.id===id).x=1;}],
        ['second sequence number repeated',c=>c.outcomes.filter(o=>o.kind==='attack')[1].sequenceIndex=1],
        ['first defeat after second attack',c=>{const i=c.outcomes.findIndex(o=>o.kind==='defeat');c.outcomes.push(c.outcomes.splice(i,1)[0]);}],
        ['first counter missing',c=>{const i=c.outcomes.findIndex(o=>o.kind==='damage'&&o.attackIndex===2);c.outcomes.splice(i,1);}],
        ['second damage inflated',c=>c.outcomes.filter(o=>o.kind==='damage').at(-1).amount++],
        ['first defeat wrong owner',c=>{const o=c.outcomes.find(o=>o.kind==='defeat');o.ownerSeat=o.ownerSeat==='p1'?'p2':'p1';}],
        ['defeat cause is unrelated event',c=>c.outcomes.find(o=>o.kind==='defeat').sourceCard=structuredClone(c.transition.before.players.p2.hand[0])],
        ['exhaust cause is unrelated event',c=>c.outcomes.find(o=>o.kind==='exhaust').sourceCard=structuredClone(c.transition.before.players.p2.hand[0])],
        ['damage belongs to unrelated sequence',c=>c.outcomes.find(o=>o.kind==='damage').sequenceId='unrelated-sequence'],
        ['damage belongs to second sequence step',c=>c.outcomes.find(o=>o.kind==='damage').sequenceIndex=2],
        ['unit combat damage falsely identifies base zone',c=>c.outcomes.find(o=>o.kind==='damage').zone='base'],
        ['base damage falsely identifies ground arena',c=>c.outcomes.filter(o=>o.kind==='damage').at(-1).zone='ground'],
        ['ground combat defeat falsely identifies space arena',c=>c.outcomes.find(o=>o.kind==='defeat').zone='space'],
        ['defeat target title and print contradict combat',c=>{const o=c.outcomes.find(o=>o.kind==='defeat');o.card={...o.card,n:'Wampa',s:'SOR_164'};}],
        ['second attacker silently ready',c=>{const id=c.outcomes.filter(o=>o.kind==='attack')[1].sourceCard.id;delete c.transition.after.players.p1.space.find(u=>u.id===id).x;}],
        ['base falsely counterattacks',c=>{const o=structuredClone(c.outcomes.filter(o=>o.kind==='damage').at(-1));o.card=c.outcomes.filter(o=>o.kind==='attack')[1].sourceCard;c.outcomes.push(o);}],
    ]);
});
test('A10 stat grants preserve wounds, pose and exact current friendly scope',()=>{
    for(const id of ['tactical-advantage','encouraging-leadership'])assertA10Secondary(id,[
        ['wrong causing event',c=>c.outcomes[0].sourceCard=structuredClone(c.transition.before.players.p2.hand[0])],
        ['wrong continuing entry',c=>c.outcomes[0].incarnation='earlier-entry'],
        ['permanent instead of phase',c=>c.outcomes[0].duration='permanent'],
        ['wrong numeric bonus',c=>c.outcomes[0].amount='+3/+3'],
        ['unrecorded wound change',c=>{const o=c.outcomes[0],p=c.transition.after.players[o.seat];[...p.ground,...p.space].find(u=>u.id===o.card.id).d++;}],
        ['phase status absent',c=>{const o=c.outcomes[0],p=c.transition.after.players[o.seat];[...p.ground,...p.space].find(u=>u.id===o.card.id).status=[];}],
    ]);
    assertA10Secondary('encouraging-leadership',[
        ['one current friendly omitted',c=>c.outcomes.pop()],
        ['opponent substitutes a friendly',c=>c.outcomes[0].seat='p2'],
        ['future arrival falsely receives sweep',c=>c.transition.after.players.p1.ground.push({...c.transition.before.players.p1.ground[0],id:'later-entry'})],
    ]);
});

function a10Later(id) {
    const { preparePreviewCue } = loadTS(path.join(__dirname, '../src/effects/previewStages.ts'));
    const definition = CARD_EFFECTS.find(card => card.id === id);
    return preparePreviewCue({ definition, nonce: 1, stage: 'next-action' }, showcaseGame(definition).steps[0].state);
}
function assertA10Main(id, mutations, later = false) {
    const cue = later ? a10Later(id) : staged(id), complete = geometry(cue.outcomes);
    for (const item of complete.outcomes) assert.equal(batchA10Covers(cue, complete, item), true, `${id}: ${later ? 'later' : 'primary'} ${item.outcome.kind}`);
    for (const [label, mutate] of mutations) {
        const partial = structuredClone(cue), original = JSON.stringify(partial); mutate(partial);
        assert.notEqual(JSON.stringify(partial), original, `${id}: ${label} changes evidence`);
        const placed = geometry(partial.outcomes); assert.ok(placed.outcomes.length);
        for (const item of placed.outcomes) assert.equal(batchA10Covers(partial, placed, item), false, `${id}: ${label} preserves generic ${item.outcome.kind}`);
    }
}
test('A10 main signatures require canonical identity, legal cost and proved payment', () => {
    for (const id of ['manufactured-soldiers', 'pyrrhic-assault', 'the-clone-wars', 'take-captive', 'in-defense-of-kamino']) assertA10Main(id, [
        ['coherent underpayment', c => { const paid = c.playPayment.cardIds.pop(); c.playCost--; delete c.transition.after.players.p1.resources.find(r => r.id === paid).x; c.transition.after.players.p1.res.ready++; }],
        ['coherent wrong canonical title', c => { const eventId = c.source.id; c.definition.name = 'Another event'; const visit = x => { if (!x || typeof x !== 'object') return; if (x.id === eventId && 'n' in x) x.n = 'Another event'; for (const value of Object.values(x)) visit(value); }; visit(c); }],
        ['event still held', c => c.transition.after.players.p1.hand.push(structuredClone(c.source))],
        ['another ending phase', c => c.transition.after.phase = 'regroup'],
        ['another ending round', c => c.transition.after.round++],
        ['opponent pays event too', c => { c.transition.after.players.p2.res.ready--; c.transition.after.players.p2.resources.find(r => !r.x).x = 1; }],
        ['prevented required receipt', c => c.outcomes[0].prevented = true],
    ]);
});
test('Manufactured Soldiers requires a single exact creation mode and fresh exhausted tokens', () => {
    assertA10Main('manufactured-soldiers', [
        ['mixed mode', c => c.outcomes[0].tokenType = 'battle-droid'],
        ['one creation missing', c => c.outcomes.pop()],
        ['one token already existed', c => c.transition.before.players.p1.ground.push(structuredClone(c.outcomes[0].unit))],
        ['entry described as play', c => c.outcomes[0].entryType = 'played'],
        ['false hand origin', c => c.outcomes[0].fromZone = 'hand'],
        ['arrival claimed ready', c => c.outcomes[0].entersReady = true],
        ['actual token silently ready', c => { const id = c.outcomes[0].unit.id; delete c.transition.after.players.p1.ground.find(u => u.id === id).x; }],
        ['created token absent', c => { const id = c.outcomes[0].unit.id; c.transition.after.players.p1.ground = c.transition.after.players.p1.ground.filter(u => u.id !== id); }],
    ]);
});
test('The Clone Wars proves additional payment then own Clones before opposing Droids', () => {
    assertA10Main('the-clone-wars', [
        ['extra amount unknown', c => delete c.outcomes[0].amount],
        ['extra amount inflated', c => c.outcomes[0].amount++],
        ['extra payment reuses event resource', c => c.outcomes[0].cards[0] = structuredClone(c.transition.before.players.p1.resources.find(r => r.id === c.playPayment.cardIds[0]))],
        ['opponent creation before own group', c => { const i = c.outcomes.findIndex(o => o.kind === 'create' && o.seat === 'p2'); c.outcomes.splice(1, 0, c.outcomes.splice(i, 1)[0]); }],
        ['wrong enemy token type', c => c.outcomes.find(o => o.kind === 'create' && o.seat === 'p2').tokenType = 'clone-trooper'],
        ['enemy token belongs to player', c => c.outcomes.find(o => o.kind === 'create' && o.seat === 'p2').ownerSeat = 'p1'],
        ['one enemy creation absent', c => c.outcomes.pop()],
        ['creation before extra payment', c => c.outcomes.push(c.outcomes.shift())],
    ]);
});
test('Phase defeat grants affect exact current entries without immediate activation or resting changes', () => {
    for (const id of ['pyrrhic-assault', 'in-defense-of-kamino']) assertA10Main(id, [
        ['grant from unrelated event', c => c.outcomes.find(o => o.grantedAbility).grantedAbility.sourceId = 'other-event'],
        ['grant refers to previous entry', c => c.outcomes.find(o => o.grantedAbility).grantedAbility.incarnation = 'previous-entry'],
        ['grant belongs to another phase', c => c.outcomes.find(o => o.grantedAbility).grantedAbility.phase = 'regroup'],
        ['current friendly grant omitted', c => c.outcomes.splice(c.outcomes.findIndex(o => o.grantedAbility), 1)],
        ['duplicate grant identity', c => { const grants = c.outcomes.filter(o => o.grantedAbility); grants[1].grantedAbility.id = grants[0].grantedAbility.id; }],
        ['grant changes resting power', c => { const o = c.outcomes.find(o => o.grantedAbility); const p = c.transition.after.players[o.seat]; [...p.ground, ...p.space].find(u => u.id === o.card.id).p++; }],
        ['new arrival wrongly receives grant', c => c.transition.after.players.p1.ground.push({ ...structuredClone(c.transition.after.players.p1.ground[0]), id: 'later-arrival' })],
    ]);
    assertA10Main('in-defense-of-kamino', [
        ['Republic claim loses actual trait', c => { const o = c.outcomes.find(o => o.grantedAbility); c.transition.before.players.p1.ground.find(u => u.id === o.card.id).traits = ['trooper']; }],
        ['Restore magnitude wrong', c => c.outcomes.find(o => o.kind === 'keyword').keyword.amount = 3],
        ['base healed before any attack', c => c.transition.after.players.p1.base.d -= 2],
    ]);
});
test('Take Captive requires the actual same-arena captor and clean owner-preserving pocket', () => {
    assertA10Main('take-captive', [
        ['other arena asserted', c => c.outcomes[0].captureArena.arena = 'space'],
        ['stale captor entry', c => c.outcomes[0].captureArena.incarnation = 'previous-entry'],
        ['different physical captor', c => c.outcomes[0].captureArena.captorId = 'other-unit'],
        ['unsupported cost permission also asserted', c => c.outcomes[0].captureCost = { captorPrintedCost: 99, targetPrintedCost: 1 }],
        ['captive owner lost', c => { const o = c.outcomes[0]; c.transition.after.players.p1.ground.find(u => u.id === o.sourceCard.id).cap[0].owner = 'p1'; }],
        ['captive falsely discarded', c => c.transition.after.players.p2.discard.push(structuredClone(c.outcomes[0].card))],
        ['captured target still on board', c => c.transition.after.players.p2.ground.push(structuredClone(c.outcomes[0].card))],
        ['captor silently readied', c => { const o = c.outcomes[0]; delete c.transition.after.players.p1.ground.find(u => u.id === o.sourceCard.id).x; }],
    ]);
});
test('A10 later actions bind actual combat and current granted ability without paying again', () => {
    for (const id of ['pyrrhic-assault', 'in-defense-of-kamino']) assertA10Main(id, [
        ['event cost charged again', c => c.playCost = 0],
        ['event payment reintroduced', c => c.playPayment = { kind: 'resources', cardIds: [] }],
        ['grant removed before defeat', c => { const activated = c.outcomes.find(o => o.whenDefeatedOrigin), p = c.transition.before.players[activated.whenDefeatedOrigin.controller]; const u = [...p.ground, ...p.space].find(u => u.id === activated.whenDefeatedOrigin.subjectId); u.status = u.status.filter(s => !s.grantedAbility); }],
        ['retained grant has permanent status wrapper', c => { const origin = c.outcomes.find(o => o.whenDefeatedOrigin).whenDefeatedOrigin, p = c.transition.before.players[origin.controller]; [...p.ground, ...p.space].find(u => u.id === origin.subjectId).status.find(s => s.grantedAbility).duration = 'permanent'; }],
        ['retained grant has keyword status wrapper', c => { const origin = c.outcomes.find(o => o.whenDefeatedOrigin).whenDefeatedOrigin, p = c.transition.before.players[origin.controller]; [...p.ground, ...p.space].find(u => u.id === origin.subjectId).status.find(s => s.grantedAbility).kind = 'keyword'; }],
        ['activation bound to old entry', c => c.outcomes.find(o => o.whenDefeatedOrigin).whenDefeatedOrigin.incarnation = 'previous-entry'],
        ['activation claims other controller', c => { const o = c.outcomes.find(o => o.whenDefeatedOrigin); o.whenDefeatedOrigin.controller = o.whenDefeatedOrigin.controller === 'p1' ? 'p2' : 'p1'; }],
        ['required actual defeat prevented', c => { const id = c.outcomes.find(o => o.whenDefeatedOrigin).whenDefeatedOrigin.subjectId; c.outcomes.find(o => o.kind === 'defeat' && o.card.id === id).prevented = true; }],
        ['activation occurs before attack', c => { const i = c.outcomes.findIndex(o => o.whenDefeatedOrigin); c.outcomes.unshift(c.outcomes.splice(i, 1)[0]); }],
        ['combat counter source wrong', c => c.outcomes.find(o => o.kind === 'damage' && o.attackIndex === 2).sourceCard = structuredClone(c.source)],
        ['boundary silently changes resources', c => c.transition.after.players.p1.res.ready--],
        ['boundary advances phase', c => c.transition.after.phase = 'regroup'],
    ], true);
});
test('Kamino Restore resolves on declaration before combat and creates a fresh ungranted replacement', () => {
    assertA10Main('in-defense-of-kamino', [
        ['Restore after combat', c => { const i = c.outcomes.findIndex(o => o.kind === 'heal'); c.outcomes.push(c.outcomes.splice(i, 1)[0]); }],
        ['heals opposing base', c => c.outcomes.find(o => o.kind === 'heal').seat = 'p2'],
        ['Restore claims unrelated attack', c => c.outcomes.find(o => o.kind === 'heal').restoreOrigin.attackId = 'other-attack'],
        ['Restore amount too large', c => c.outcomes.find(o => o.kind === 'heal').amount = 3],
        ['new Clone inherits prior status', c => { const create = c.outcomes.find(o => o.kind === 'create'), old = c.transition.before.players.p1.ground.find(u => u.id === create.whenDefeatedOrigin.subjectId); c.transition.after.players.p1.ground.find(u => u.id === create.card.id).status = structuredClone(old.status); }],
        ['new Clone duplicates departed physical identity', c => { const create = c.outcomes.find(o => o.kind === 'create'); create.unit.id = create.whenDefeatedOrigin.subjectId; }],
        ['new Clone described as played', c => c.outcomes.find(o => o.kind === 'create').entryType = 'played'],
    ], true);
});

function assertA11Secondary(id, mutations) {
    const cue = staged(id), complete = geometry(cue.outcomes);
    for (const item of complete.outcomes) assert.equal(batchA11SecondaryCovers(cue, complete, item), true, `${id}: proved ${item.outcome.kind}`);
    for (const [label, mutate] of mutations) {
        const partial = structuredClone(cue), original = JSON.stringify(partial); mutate(partial);
        assert.notEqual(JSON.stringify(partial), original, `${id}: ${label} changes evidence`);
        const placed = geometry(partial.outcomes); assert.ok(placed.outcomes.length);
        for (const item of placed.outcomes) assert.equal(batchA11SecondaryCovers(partial, placed, item), false, `${id}: ${label} leaves generic ${item.outcome.kind}`);
    }
}
test('A11 secondary signatures require canonical paid event and complete phase-stable state',()=>{
    for(const id of ['bold-resistance','daring-raid','grenade-strike','blood-sport','strategic-analysis'])assertA11Secondary(id,[
        ['coherent underpayment',c=>{const paid=c.playPayment.cardIds.pop();c.playCost--;delete c.transition.after.players.p1.resources.find(r=>r.id===paid).x;c.transition.after.players.p1.res.ready++;}],
        ['canonical title coherently changed',c=>{c.definition.name='Another event';const event=c.source.id;const visit=x=>{if(!x||typeof x!=='object')return;if(x.id===event&&'n'in x)x.n='Another event';Object.values(x).forEach(visit);};visit(c);}],
        ['event retained in hand',c=>c.transition.after.players.p1.hand.push(structuredClone(c.source))],
        ['unrelated causing event',c=>c.outcomes[0].sourceCard=structuredClone(c.transition.before.players.p2.hand[0])],
        ['explicitly prevented receipt',c=>c.outcomes[0].prevented=true],
        ['ending phase changed',c=>c.transition.after.phase='regroup'],
        ['ending round changed',c=>c.transition.after.round++],
        ['initiative changed without receipt',c=>c.transition.after.initiative='p2'],
        ['opponent resources also spent',c=>c.transition.after.players.p2.res.ready--],
        ['unrelated space unit damaged',c=>c.transition.after.players.p2.space[0].d++],
    ]);
});
test('Bold Resistance seals one common actual trait across the complete distinct selected group',()=>{
    assertA11Secondary('bold-resistance',[
        ['pairwise trait does not cover group',c=>{c.transition.before.players.p2.ground[0].traits=['imperial'];c.outcomes[2].card.traits=['imperial'];c.transition.after.players.p2.ground[0].traits=['imperial'];}],
        ['selected witness repeated',c=>c.outcomes[0].sharedTrait.units[2]=structuredClone(c.outcomes[0].sharedTrait.units[0])],
        ['stale selection entry',c=>c.outcomes[0].sharedTrait.units[0].incarnation='old-entry'],
        ['selected boost omitted',c=>c.outcomes.pop()],
        ['boost changes health too',c=>c.transition.after.players.p1.ground[0].h+=2],
        ['phase status absent',c=>c.transition.after.players.p1.ground[0].status=[]],
        ['permanent bonus',c=>c.outcomes[0].duration='permanent'],
        ['wrong boost amount',c=>c.outcomes[0].amount='+2/+2'],
        ['phase buff tied to an unrelated attack',c=>c.outcomes[0].attackId='invented-attack'],
    ]);
});
test('Daring Raid binds exact chosen base and two ability damage without a combat story',()=>{
    assertA11Secondary('daring-raid',[
        ['wrong controller base',c=>c.outcomes[0].seat='p2'],
        ['false ground destination',c=>c.outcomes[0].zone='ground'],
        ['combat classification',c=>c.outcomes[0].damageType='combat'],
        ['invented attack link',c=>c.outcomes[0].attackId='fake-attack'],
        ['inflated damage',c=>c.outcomes[0].amount=3],
        ['unsatisfied defeat prerequisite',c=>c.outcomes[0].requiresDefeat={id:'a11:p1:marine',incarnation:'a11:p1:marine:entry-1'}],
        ['base healed instead',c=>c.transition.after.players.p1.base.d=7],
    ]);
});
test('Grenade and Blood Sport keep complete simultaneous exact hits before actual owner cleanup',()=>{
    for(const id of ['grenade-strike','blood-sport'])assertA11Secondary(id,[
        ['damage in wrong arena',c=>c.outcomes[0].zone='space'],
        ['stale damaged entry',c=>c.outcomes[0].incarnation='old-entry'],
        ['wrong damage quantity',c=>c.outcomes[0].amount++],
        ['wrong damage source',c=>c.outcomes[0].sourceCard=structuredClone(c.transition.before.players.p2.hand[0])],
        ['unrelated resolution window',c=>c.outcomes[0].resolutionGroup.id='other-window'],
        ['defeat before other hits',c=>{const i=c.outcomes.findIndex(o=>o.kind==='defeat');c.outcomes.unshift(c.outcomes.splice(i,1)[0]);}],
        ['defeat wrong owner',c=>c.outcomes.find(o=>o.kind==='defeat').ownerSeat='p2'],
        ['defeated card missing from owner discard',c=>c.transition.after.players.p2.discard.pop()],
    ].filter(([label])=>id==='blood-sport'||label!=='defeat wrong owner'));
    assertA11Secondary('grenade-strike',[
        ['fragment selects same unit',c=>{c.outcomes[1].card=structuredClone(c.outcomes[0].card);c.outcomes[1].seat='p2';c.outcomes[1].incarnation=c.outcomes[0].incarnation;}],
        ['fragment belongs to space',c=>c.outcomes[1].zone='space'],
        ['fragment inflated to first hit',c=>c.outcomes[1].amount=2],
    ]);
    assertA11Secondary('blood-sport',[
        ['one ground target omitted',c=>c.outcomes.splice(1,1)],
        ['token becomes discarded card',c=>c.transition.after.players.p1.discard.push(structuredClone(c.transition.before.players.p1.ground[2]))],
        ['surviving leader undeployed',c=>c.transition.after.players.p2.leader.dep=0],
    ]);
});
test('Strategic Analysis draws actual three top cards in order with exact hand and deck handoff',()=>{
    assertA11Secondary('strategic-analysis',[
        ['draw count false',c=>c.outcomes[0].amount=2],
        ['unsupported unsatisfied Official condition',c=>c.outcomes[0].traitCondition={player:'p1',trait:'official',minimum:3,units:[]}],
        ['reordered top cards',c=>c.outcomes[0].cards.reverse()],
        ['duplicate drawn card',c=>c.outcomes[0].cards[2]=structuredClone(c.outcomes[0].cards[0])],
        ['public source falsely discard',c=>c.outcomes[0].fromZone='discard'],
        ['draw placed in opponent hand',c=>c.outcomes[0].seat='p2'],
        ['draw card missing from hand',c=>c.transition.after.players.p1.hand.pop()],
        ['remaining deck reordered',c=>{const d=c.transition.after.players.p1.knownDeck;[d[0],d[1]]=[d[1],d[0]];}],
    ]);
});

test('A11 rich damage keeps surviving native-Grit changes generic when resting power is unsupported',()=>{
    for(const id of ['grenade-strike','blood-sport'])assertA11Secondary(id,[
        ['actual Scout wounds with stale resting power',c=>{
            const old=c.transition.before.players.p1.ground[1];
            const scout={id:old.id,n:'Scout Bike Pursuer',s:'SOR_032',owner:'p1',p:1,h:4,d:0,traits:['imperial','trooper'],incarnation:old.incarnation,
                status:[{kind:'keyword',label:'Grit (printed)',duration:'permanent',keyword:{name:'Grit',amount:1}}]};
            c.transition.before.players.p1.ground[1]=scout;
            const end=c.transition.after.players.p1.ground, index=end.findIndex(u=>u.id===old.id);
            assert.ok(index>=0,'Scout survives the supplied receipt');
            end[index]={...structuredClone(scout),d:id==='grenade-strike'?1:2};
            for(const o of c.outcomes)if(o.card?.id===old.id)o.card=structuredClone(scout);
        }],
    ]);
});

const { batchA11Covers } = loadTS(path.join(__dirname, '../src/effects/batchA11Signatures.tsx'));
function assertA11Main(id, mutations) {
    const cue = staged(id), complete = geometry(cue.outcomes);
    for (const item of complete.outcomes) assert.equal(batchA11Covers(cue, complete, item), true, `${id}: primary ${item.outcome.kind}`);
    for (const [label, mutate] of mutations) {
        const partial = structuredClone(cue), original = JSON.stringify(partial); mutate(partial);
        assert.notEqual(JSON.stringify(partial), original, `${id}: ${label} changes evidence`);
        const placed = geometry(partial.outcomes); assert.ok(placed.outcomes.length);
        for (const item of placed.outcomes) assert.equal(batchA11Covers(partial, placed, item), false, `${id}: ${label} preserves generic ${item.outcome.kind}`);
    }
}
const a11MainCommon = [
    ['coherent underpayment', c => { const paid = c.playPayment.cardIds.pop(); c.playCost--; delete c.transition.after.players.p1.resources.find(r => r.id === paid).x; c.transition.after.players.p1.res.ready++; }],
    ['canonical title coherently spoofed', c => { c.definition.name = 'Another event'; const id = c.source.id; const visit = x => { if (!x || typeof x !== 'object') return; if (x.id === id && 'n' in x) x.n = 'Another event'; Object.values(x).forEach(visit); }; visit(c); }],
    ['source kept in hand', c => c.transition.after.players.p1.hand.push(structuredClone(c.source))],
    ['unsupported Smuggle asserted', c => c.playPayment.smuggle = { sourceId: c.source.id, resourcesAfterPayment: c.transition.after.players.p1.resources }],
    ['prevented required receipt', c => c.outcomes[0].prevented = true],
    ['unrelated causing event', c => c.outcomes[0].sourceCard = structuredClone(c.transition.before.players.p2.hand[0])],
    ['ending phase changed', c => c.transition.after.phase = 'regroup'],
    ['ending round changed', c => c.transition.after.round++],
    ['opponent event payment invented', c => { c.transition.after.players.p2.res.ready--; c.transition.after.players.p2.resources.find(r => !r.x).x = 1; }],
    ['unaffected Defender power changed', c => c.transition.after.players.p1.ground.find(u => u.id === 'a11:p1:defender').p++],
    ['hidden deck reordered', c => c.transition.after.players.p1.knownDeck.reverse()],
    ['source owner contradicted', c => c.source.owner = 'p2'],
];
test('Corner the Prey seals defending-unit wounds at attack start and expires the attack bonus', () => {
    assertA11Main('corner-the-prey', [...a11MainCommon,
        ['starting wound witness inflated', c => c.outcomes[0].defenderDamageAtStart.damage++],
        ['witness refers to another target', c => c.outcomes[0].defenderDamageAtStart.defenderId = 'a11:p2:trooper'],
        ['defending entry stale', c => c.outcomes[0].defenderDamageAtStart.incarnation = 'old-entry'],
        ['witness wrong arena', c => c.outcomes[0].defenderDamageAtStart.zone = 'space'],
        ['coherent inflated temporary bonus', c => { c.outcomes[0].amount = '+3/+0'; c.outcomes.find(o => o.attackIndex === 1).amount = 7; }],
        ['attacker exhausted before attack', c => c.transition.before.players.p1.ground[0].x = 1],
        ['forward hit is ability damage', c => c.outcomes.find(o => o.attackIndex === 1).damageType = 'ability'],
        ['counter source is causing event', c => c.outcomes.find(o => o.attackIndex === 2).sourceCard = structuredClone(c.source)],
        ['attack bonus persists in resting power', c => c.transition.after.players.p1.ground[0].p = 6],
        ['survivor silently ready', c => delete c.transition.after.players.p1.ground[0].x],
        ['defeat names wrong owner', c => c.outcomes.find(o => o.kind === 'defeat').ownerSeat = 'p1'],
    ]);
});
test('Self-Destruct requires an actual prior friendly successful defeat before its four ability damage', () => {
    assertA11Main('selfdestruct', [...a11MainCommon,
        ['sacrifice absent', c => c.outcomes.shift()],
        ['hit before sacrifice', c => [c.outcomes[0], c.outcomes[1]] = [c.outcomes[1], c.outcomes[0]]],
        ['successful entry dependency absent', c => delete c.outcomes[1].requiresDefeat],
        ['dependency names another physical unit', c => c.outcomes[1].requiresDefeat.id = 'a11:p1:defender'],
        ['dependency refers to old entry', c => c.outcomes[1].requiresDefeat.incarnation = 'old-entry'],
        ['sacrifice controller enemy', c => c.outcomes[0].seat = 'p2'],
        ['sacrifice incorrectly called Exploit payment', c => c.outcomes[0].paymentRole = 'exploit'],
        ['target base role asserted', c => c.outcomes[1].zone = 'base'],
        ['wrong conditional damage amount', c => c.outcomes[1].amount = 3],
        ['conditional hit is combat', c => c.outcomes[1].damageType = 'combat'],
        ['sacrificed card remains on board', c => c.transition.after.players.p1.ground.push(structuredClone(c.outcomes[0].card))],
        ['owner destination missing', c => c.transition.after.players.p1.discard.pop()],
    ]);
});
test('Unlimited Power binds four distinct exact simultaneous assignments before owner departures', () => {
    assertA11Main('unlimited-power', [...a11MainCommon,
        ['one damage assignment absent', c => c.outcomes.splice(2, 1)],
        ['duplicate damage target', c => { c.outcomes[2].card = structuredClone(c.outcomes[0].card); c.outcomes[2].incarnation = c.outcomes[0].incarnation; c.outcomes[2].zone = 'ground'; }],
        ['wrong four-point amount with same lethal ending', c => c.outcomes[0].amount = 3],
        ['unrelated simultaneous window', c => c.outcomes[1].resolutionGroup.id = 'another-window'],
        ['damage window mode unsupported', c => c.outcomes[0].resolutionGroup.mode = 'sequential'],
        ['damage is combat', c => c.outcomes[0].damageType = 'combat'],
        ['invented attack identifier', c => c.outcomes[0].attackId = 'fake-attack'],
        ['wrong current damaged entry', c => c.outcomes[1].incarnation = 'old-entry'],
        ['target controller changed', c => c.outcomes[0].seat = 'p2'],
        ['cleanup before the fourth hit', c => c.outcomes.splice(3, 0, c.outcomes.splice(4, 1)[0])],
        ['surviving Wampa wound result false', c => c.transition.after.players.p2.ground.find(u => u.id === 'a11:p2:wampa').d--],
        ['defeated Marine still present', c => c.transition.after.players.p1.ground.push(structuredClone(c.outcomes[0].card))],
    ]);
});
test('Grim Resolve binds one nonleader attack to current own wounds and does not double-count or retain Grit', () => {
    assertA11Main('grim-resolve', [...a11MainCommon,
        ['Grit witness own wounds false', c => c.outcomes[0].gritBasis.damage++],
        ['native contribution falsely asserted', c => { c.outcomes[0].gritBasis.powerIncludesGrit = true; c.outcomes[1].gritBasis.powerIncludesGrit = true; }],
        ['different buff versus keyword witness', c => c.outcomes[1].gritBasis.incarnation = 'old-entry'],
        ['keyword lasts permanently', c => c.outcomes[0].duration = 'permanent'],
        ['keyword falsely counted twice', c => c.outcomes[0].keyword.amount = 2],
        ['coherent doubled own wounds', c => { c.outcomes[1].amount = '+4/+0'; c.outcomes.find(o => o.attackIndex === 1).amount = 7; c.transition.after.players.p2.base.d += 2; }],
        ['actor exhausted before attack', c => c.transition.before.players.p1.ground[0].x = 1],
        ['ready leader used as nonleader', c => { const u = c.transition.before.players.p1.ground[0]; c.transition.before.players.p1.leader = { id: u.id, n: u.n, s: u.s, owner: 'p1', dep: 1, x: 0 }; }],
        ['attack keyword left on completed board', c => c.transition.after.players.p1.ground[0].status = [{ kind: 'keyword', label: 'Grit', duration: 'attack', keyword: { name: 'Grit', amount: 1 } }]],
        ['resting attack power retained', c => c.transition.after.players.p1.ground[0].p = 5],
        ['base attack gains fabricated counterdamage', c => c.outcomes.push({ kind: 'damage', card: c.outcomes[0].card, sourceCard: c.transition.before.players.p2.base, seat: 'p1', zone: 'ground', amount: 1, damageType: 'combat', attackId: c.outcomes[2].attackId, attackIndex: 2 })],
    ]);
});
test('Caught in the Crossfire seals two enemy current powers and controllers before both reciprocal ability hits', () => {
    assertA11Main('caught-in-the-crossfire', [...a11MainCommon,
        ['second reciprocal hit absent', c => c.outcomes.splice(1, 1)],
        ['selected power seal false', c => c.outcomes[0].powerWindow.members[0].power++],
        ['power seal names old entry', c => c.outcomes[0].powerWindow.members[0].incarnation = 'old-entry'],
        ['power seal controller is event player', c => c.outcomes[0].powerWindow.members[0].controller = 'p1'],
        ['source is event instead of opposite selected unit', c => c.outcomes[0].sourceCard = structuredClone(c.source)],
        ['source is receiving unit', c => c.outcomes[0].sourceCard = structuredClone(c.outcomes[0].card)],
        ['basis names unrelated source', c => c.outcomes[0].basis.sourceIds = ['a11:p1:marine']],
        ['basis value disagrees with source power', c => c.outcomes[0].basis.value++],
        ['different arena claimed', c => c.outcomes[1].zone = 'space'],
        ['one recipient is friendly', c => c.outcomes[1].seat = 'p1'],
        ['damage is combat', c => c.outcomes[0].damageType = 'combat'],
        ['invented attack identifier', c => c.outcomes[0].attackId = 'fake-attack'],
        ['death occurs before both hits', c => c.outcomes.splice(1, 0, c.outcomes.pop())],
        ['surviving enemy silently exhausted', c => c.transition.after.players.p2.ground[0].x = 1],
        ['event incorrectly causes departure', c => c.outcomes.find(o => o.kind === 'defeat').sourceCard = structuredClone(c.source)],
    ]);
});

const { batchA12SecondaryCovers } = loadTS(path.join(__dirname, '../src/effects/batchA12SecondarySignatures.tsx'));
function assertA12Secondary(id, mutations) {
    const cue = staged(id), complete = geometry(cue.outcomes);
    for (const item of complete.outcomes) assert.equal(batchA12SecondaryCovers(cue, complete, item), true, `${id}: primary ${item.outcome.kind}`);
    for (const [label, mutate] of mutations) {
        const partial = structuredClone(cue), original = JSON.stringify(partial); mutate(partial);
        assert.notEqual(JSON.stringify(partial), original, `${id}: ${label} changes evidence`);
        const placed = geometry(partial.outcomes); assert.ok(placed.outcomes.length);
        for (const item of placed.outcomes) assert.equal(batchA12SecondaryCovers(partial, placed, item), false, `${id}: ${label} preserves generic ${item.outcome.kind}`);
    }
}
const a12SecondaryCommon = [
    ['ordinary event coherently played during regroup', c => { c.transition.before.phase = 'regroup'; c.transition.after.phase = 'regroup'; }],
    ['unreceipted discard play permission', c => c.transition.after.discardPlayPermissions = [{id:'invented-permission',sourceId:c.source.id,cardId:c.source.id,player:'p1',round:c.transition.before.round,phase:'action',fromZone:'discard',discount:2,cardType:'event',aspects:['heroism']}]],
    ['unreceipted future defeat', c => { const u=c.transition.after.players.p1.space[0]; c.transition.after.pending=[...(c.transition.after.pending??[]),{id:'invented-delay',sourceId:c.source.id,targetId:u.id,incarnation:u.incarnation,trigger:'regroup-start',kind:'defeat'}]; }],
    ['coherent underpayment', c => { const id = c.playPayment.cardIds.pop(); c.playCost--; delete c.transition.after.players.p1.resources.find(r => r.id === id).x; c.transition.after.players.p1.res.ready++; }],
    ['coherent false canonical title', c => { c.definition.name = 'Another event'; const id = c.source.id; const visit = x => { if (!x || typeof x !== 'object') return; if (x.id === id && 'n' in x) x.n = 'Another event'; Object.values(x).forEach(visit); }; visit(c); }],
    ['wrong causing event', c => c.outcomes[0].sourceCard = structuredClone(c.transition.before.players.p2.hand[0])],
    ['prevented outcome', c => c.outcomes[0].prevented = true],
    ['source retained in hand', c => c.transition.after.players.p1.hand.push(structuredClone(c.source))],
    ['ending phase changed', c => c.transition.after.phase = 'regroup'],
    ['ending round changed', c => c.transition.after.round++],
    ['initiative changed without receipt', c => c.transition.after.initiative = 'p2'],
    ['unsupported conditional Official witness', c => c.outcomes[0].traitCondition = {player:'p1',trait:'official',minimum:3,units:[]}],
    ['unrelated attack scope', c => c.outcomes[0].attackId = 'invented-attack'],
    ['resource ID duplicated', c => c.playPayment.cardIds[1] = c.playPayment.cardIds[0]],
    ['source owner contradicted', c => c.source.owner = 'p2'],
    ['unrelated survivor stats changed', c => c.transition.after.players.p1.ground.find(u => u.id === 'a12:p1:defender').h++],
    ['unrelated opponent payment', c => { c.transition.after.players.p2.res.ready--; c.transition.after.players.p2.resources.find(r => !r.x).x = 1; }],
];
test('Wartime seals typed phase entries, private look count and exact chosen draw', () => {
    assertA12Secondary('wartime-profiteering', [...a12SecondaryCommon,
        ['unsatisfied exhaustion prerequisite', c => c.outcomes.at(-1).requiresExhaust = {id:'a12:p1:marine',incarnation:'a12:p1:marine:entry-1'}],
        ['mixed upgrade defeat history behind coherent unit count', c => { const h={id:'prior-upgrade',incarnation:'prior-upgrade:entry-1',controller:'p1',lastKnownType:'upgrade'};c.transition.before.defeatedThisPhase.cards.push(h);c.transition.after.defeatedThisPhase.cards.push(structuredClone(h)); }],
        ['history absent', c => delete c.transition.before.defeatedThisPhase],
        ['history stale', c => c.transition.before.defeatedThisPhase.round--],
        ['false unit history witness', c => c.outcomes[0].unitDefeatCount.units[0].incarnation = 'old-entry'],
        ['upgrade defeat counted as unit', c => c.transition.before.defeatedThisPhase.cards[0].lastKnownType = 'upgrade'],
        ['ambiguous token classified as unit', c => c.transition.before.defeatedThisPhase.cards[2].lastKnownType = 'token'],
        ['look count inflated', c => c.outcomes[0].amount++],
        ['public look claimed', c => c.outcomes[0].deckOperation.visibility = 'public'],
        ['private face revealed', c => c.outcomes[0].deckOperation.revealedIds = [c.outcomes[0].deckOperation.looked[0].id]],
        ['draw actual identity wrong', c => c.outcomes[1].cards[0] = structuredClone(c.outcomes[0].deckOperation.looked[0])],
        ['draw from opponent deck', c => c.outcomes[1].fromSeat = 'p2'],
        ['draw publicly revealed', c => c.outcomes[1].visibility = 'public'],
        ['remaining order moves unseen cards', c => { const d = c.outcomes[0].deckOperation.remainingOrder; [d[1],d[2]] = [d[2],d[1]]; }],
        ['drawn card remains in deck', c => c.transition.after.players.p1.knownDeck.push(structuredClone(c.outcomes[1].cards[0]))],
    ]);
});
test('On the Doorstep requires three fresh ready created Droids without played origins', () => {
    assertA12Secondary('on-the-doorstep', [...a12SecondaryCommon,
        ['third creation missing', c => c.outcomes.pop()],
        ['created body is a play', c => c.outcomes[0].entryType = 'played'],
        ['created from hand', c => c.outcomes[0].fromZone = 'hand'],
        ['ready clause absent', c => delete c.outcomes[0].entersReady],
        ['coherent exhausted creation', c => { c.outcomes[0].entersReady = false; c.outcomes[0].unit.x = 1; c.transition.after.players.p1.ground.find(u => u.id === c.outcomes[0].unit.id).x = 1; }],
        ['wrong controller', c => c.outcomes[0].seat = 'p2'],
        ['wrong type label', c => c.outcomes[0].tokenType = 'clone-trooper'],
        ['wrong token name', c => c.outcomes[0].unit.n = 'Clone Trooper'],
        ['invented exhaustion dependency', c => c.outcomes[0].requiresExhaust = { id:'a12:p1:marine', incarnation:'a12:p1:marine:entry-1' }],
        ['token remains absent from board', c => c.transition.after.players.p1.ground.pop()],
    ]);
});
test('Clear the Field binds printed title across subtitles and complete owner-hand destinations', () => {
    assertA12Secondary('clear-the-field', [...a12SecondaryCommon,
        ['unsatisfied exhaustion prerequisite', c => c.outcomes.at(-1).requiresExhaust = {id:'a12:p1:marine',incarnation:'a12:p1:marine:entry-1'}],
        ['high-cost title sibling missing', c => c.outcomes.splice(c.outcomes.findIndex(o => o.card.id === 'a12:clear:enemy-high'),1)],
        ['chosen cost fabricated', c => c.outcomes[0].sameNameGroup.selectedPrintedCost = 3],
        ['subtitle used as shared title', c => c.outcomes.forEach(o => o.sameNameGroup.title = 'Bo-Katan Kryze: Fighting For Mandalore')],
        ['selected old incarnation', c => c.outcomes[0].sameNameGroup.selectedIncarnation = 'old-entry'],
        ['wrong actual print', c => c.outcomes[0].card.s = 'SOR_164'],
        ['wrong return owner', c => c.outcomes[0].ownerSeat = 'p1'],
        ['wrong departure arena', c => c.outcomes[0].fromZone = 'space'],
        ['discard destination asserted', c => c.outcomes[0].destination = 'discard'],
        ['unknown printed title', c => delete c.transition.before.players.p2.ground.find(u => u.id === 'a12:clear:enemy-high').printedTitle],
        ['leader status contradicted', c => c.transition.before.players.p1.ground.find(u => u.id === 'a12:clear:own').leaderUnit = true],
        ['lost owner hand arrival', c => c.transition.after.players.p2.hand.pop()],
    ]);
});
test('Creative Thinking keeps Clone creation independent while proving nonunique exhaustion', () => {
    assertA12Secondary('creative-thinking', [...a12SecondaryCommon,
        ['unique target asserted', c => c.transition.before.players.p2.space[0].unique = true],
        ['exhaust old entry', c => c.outcomes[0].incarnation = 'old-entry'],
        ['already-exhausted reported as success', c => c.transition.before.players.p2.space[0].x = 1],
        ['creation conditional on exhaust', c => c.outcomes[1].requiresExhaust = { id:c.outcomes[0].card.id, incarnation:c.outcomes[0].incarnation }],
        ['simultaneous window absent', c => delete c.outcomes[0].resolutionGroup],
        ['different simultaneous window', c => c.outcomes[1].resolutionGroup.id = 'another-window'],
        ['new Clone ready', c => { c.outcomes[1].entersReady = true; delete c.outcomes[1].unit.x; delete c.transition.after.players.p1.ground.find(u => u.id === c.outcomes[1].unit.id).x; }],
        ['wrong Clone stats', c => c.outcomes[1].unit.p = 1],
        ['enemy exhaustion lost at completion', c => delete c.transition.after.players.p2.space[0].x],
    ]);
});
test('In Pursuit binds enemy exhaustion to actual prior friendly success and exact entry', () => {
    assertA12Secondary('in-pursuit', [...a12SecondaryCommon,
        ['first success prevented', c => c.outcomes[0].prevented = true],
        ['dependency missing', c => delete c.outcomes[1].requiresExhaust],
        ['dependency wrong unit', c => c.outcomes[1].requiresExhaust.id = 'a12:p1:defender'],
        ['dependency stale entry', c => c.outcomes[1].requiresExhaust.incarnation = 'old-entry'],
        ['reversed chronology', c => c.outcomes.reverse()],
        ['already-exhausted friendly asserted successful', c => c.transition.before.players.p1.ground[0].x = 1],
        ['opponent claimed friendly', c => c.outcomes[0].seat = 'p2'],
        ['enemy arena contradicted', c => c.outcomes[1].zone = 'ground'],
        ['success count wrong', c => c.outcomes[1].amount = 0],
        ['ending friendly exhaustion lost', c => delete c.transition.after.players.p1.ground[0].x],
    ]);
});

test('Corner rejects unsupported native-Grit survivor power changes in factory and rich evidence',()=>{
    const card=JSON.parse(fs.readFileSync(path.join(__dirname,'../../forceteki/test/json/Card/scout-bike-pursuer.json')));
    assert.deepEqual([card.power,card.hp],[1,4]);assert.ok(card.keywords.includes('grit'));
    const api=loadTS(path.join(__dirname,'../src/effects/batchA11.ts'));
    const definition=api.A11_DEFINITIONS.find(d=>d.id==='corner-the-prey'),before=api.a11ShowcaseState(definition);
    const oldActor=before.players.p1.ground[0],oldDefender=before.players.p2.ground[1];
    const scout={id:oldActor.id,n:card.title,s:'SOR_032',owner:'p1',p:card.power,h:card.hp,d:0,traits:card.traits,incarnation:oldActor.incarnation,
        status:[{kind:'keyword',label:'Grit (printed)',duration:'permanent',keyword:{name:'Grit',amount:1}}]};
    const trooper={...structuredClone(before.players.p2.ground[0]),id:oldDefender.id,incarnation:oldDefender.incarnation};
    before.players.p1.ground[0]=scout;before.players.p2.ground[1]=trooper;
    assert.throws(()=>api.a11PreviewOutcomes(definition,before,'p1',{attackerId:scout.id,targetId:trooper.id}),/resting-power change/);
    const cue=staged('corner-the-prey');cue.transition.before=before;
    const [buff,attack,exhaust,forward,counter,defeat]=cue.outcomes;
    buff.card=structuredClone(scout);buff.amount='+1/+0';buff.defenderDamageAtStart.damage=1;
    attack.card=structuredClone(trooper);attack.sourceCard=structuredClone(scout);
    exhaust.card=structuredClone(scout);forward.card=structuredClone(trooper);forward.sourceCard=structuredClone(scout);forward.amount=2;
    counter.card=structuredClone(scout);counter.sourceCard=structuredClone(trooper);counter.amount=3;
    defeat.card=structuredClone(trooper);defeat.sourceCard=structuredClone(scout);
    cue.transition.after.players.p1.ground[0]={...structuredClone(scout),d:3,x:1};
    cue.transition.after.players.p2.discard=cue.transition.after.players.p2.discard.map(c=>c.id===trooper.id?{id:trooper.id,n:trooper.n,s:trooper.s,owner:trooper.owner}:c);
    const placed=geometry(cue.outcomes);
    for(const item of placed.outcomes)assert.equal(batchA11Covers(cue,placed,item),false,'stale power 1 after three new wounds remains generic');
    cue.transition.after.players.p1.ground[0].p=4;
    const supportedPower=geometry(cue.outcomes);for(const item of supportedPower.outcomes)assert.equal(batchA11Covers(cue,supportedPower,item),false,'unreceipted corrected Grit power also cannot borrow rich story');
});

const { batchA12Covers } = loadTS(path.join(__dirname, '../src/effects/batchA12Signatures.tsx'));
function a12MainScene(id, stage) {
    const base=staged(id);return stage?preparePreviewCue({definition:base.definition,nonce:1,stage},base.transition.before):base;
}
function assertA12Main(id, mutations, stage) {
    const cue=a12MainScene(id,stage),complete=geometry(cue.outcomes);
    assert.ok(complete.outcomes.length);
    for(const item of complete.outcomes)assert.equal(batchA12Covers(cue,complete,item),true,id+' '+(stage??'play')+' primary '+item.outcome.kind);
    for(const[label,mutate]of mutations){const c=structuredClone(cue),old=JSON.stringify(c);mutate(c);assert.notEqual(JSON.stringify(c),old,label+' must change evidence');const g=geometry(c.outcomes);assert.ok(g.outcomes.length);for(const item of g.outcomes)assert.equal(batchA12Covers(c,g,item),false,id+' '+label+' preserves generic '+item.outcome.kind);}
}
const a12MainCommon=[
    ['coherent event underpayment',c=>{const last=c.playPayment.cardIds.pop();c.playCost--;const p=c.transition.after.players.p1;p.res.ready++;delete p.resources.find(r=>r.id===last).x;}],
    ['canonical title spoof',c=>{const old=c.source.n;c.definition.name='Different Event';c.source.n='Different Event';for(const s of [c.transition.before,c.transition.after])for(const side of ['p1','p2'])for(const z of ['hand','discard'])for(const card of s.players[side][z])if(card.id===c.source.id)card.n='Different Event';for(const o of c.outcomes)if(o.sourceCard?.n===old)o.sourceCard.n='Different Event';}],
    ['initiative changed',c=>c.transition.after.initiative='p2'],
    ['phase changed',c=>c.transition.after.phase='regroup'],
    ['source owner changed',c=>c.source.owner='p2'],
    ['source retained in hand',c=>c.transition.after.players.p1.hand.push(structuredClone(c.source))],
    ['explicitly prevented receipt',c=>c.outcomes[0].prevented=true],
    ['unsupported dependency on first receipt',c=>c.outcomes[0].requiresDefeat={id:'unobserved',incarnation:'old'}],
    ['unrelated enemy base maximum HP',c=>c.transition.after.players.p2.base.hp++],
    ['unrelated enemy deck permutation',c=>c.transition.after.players.p2.knownDeck.reverse()],
];
test('Guerilla proves independent bilateral resources and hand choices plus complete ground-only simultaneous damage',()=>{
    assertA12Main('guerilla-insurgency',[...a12MainCommon,
        ['resource cost fabricated as unit defeat',c=>c.outcomes[0].incarnation='unit-entry'],
        ['resource ownership false',c=>c.outcomes[0].ownerSeat='p2'],
        ['enemy resource chooser attributed to caster',c=>c.outcomes[3].chooserSeat='p1'],
        ['chosen own hand card not owned',c=>c.outcomes[1].card.owner='p2'],
        ['hand cards claimed random',c=>c.outcomes[1].selection='random'],
        ['hand source event selected instead',c=>c.outcomes[1].card=structuredClone(c.source)],
        ['resource defeat dependent on ground casualty',c=>c.outcomes[0].requiresDefeat={id:'a12:p1:marine',incarnation:'a12:p1:marine:entry-1'}],
        ['one current ground omitted',c=>c.outcomes.splice(6,1)],
        ['space substituted for ground',c=>c.outcomes[6].card=structuredClone(c.transition.before.players.p1.space[0])],
        ['ground damage combat',c=>c.outcomes[6].damageType='combat'],
        ['damage receipt follows first cleanup',c=>{const o=c.outcomes.splice(6,1)[0];c.outcomes.push(o);}],
        ['simultaneous window inconsistent',c=>c.outcomes[6].resolutionGroup={...c.outcomes[6].resolutionGroup,id:'different'}],
        ['survivor wounds lost',c=>c.transition.after.players.p1.ground[0].d=0],
        ['ready resource loss counted as spent',c=>c.transition.after.players.p1.res.ready++],
    ]);
});
test('Planetary binds actual Exploit cost entries before exact payment and three distinct ready/power/Overwhelm phase grants',()=>{
    assertA12Main('planetary-invasion',[...a12MainCommon,
        ['Exploit source wrong',c=>c.playPayment.exploit.sourceId='wrong'],
        ['Exploit entry stale',c=>c.playPayment.exploit.units[0].incarnation='old'],
        ['Exploit duplicate unit',c=>c.playPayment.exploit.units[1]=structuredClone(c.playPayment.exploit.units[0])],
        ['cost sacrifice prevented',c=>c.outcomes[1].prevented=true],
        ['cost role lost',c=>delete c.outcomes[0].paymentRole],
        ['cost discount false',c=>c.outcomes[3].amount=-8],
        ['cost receipt before sacrifices',c=>{const o=c.outcomes.splice(3,1)[0];c.outcomes.unshift(o);}],
        ['ready targets dead sacrifice',c=>c.outcomes[4].card=structuredClone(c.transition.before.players.p1.ground[0])],
        ['phase power granted permanently',c=>c.outcomes[5].duration='permanent'],
        ['power raises HP instead',c=>c.outcomes[5].amount='+1/+1'],
        ['Overwhelm stacks as amount two',c=>c.outcomes[6].keyword.amount=2],
        ['Overwhelm different keyword',c=>c.outcomes[6].keyword.name='Raid'],
        ['ready wrong arena',c=>c.outcomes[7].zone='ground'],
        ['grant different source',c=>c.outcomes[8].sourceCard={...c.source,id:'different'}],
        ['grant false owner/controller',c=>c.outcomes[10].seat='p1'],
        ['ready completion still exhausted',c=>c.transition.after.players.p1.ground[0].x=1],
        ['held phase keyword permanent',c=>c.transition.after.players.p1.ground[0].status[1].duration='permanent'],
    ]);
});
test('Unnatural binds most-recent current-phase defeat to separate paid fresh ready discard entry and exact pending defeat',()=>{
    assertA12Main('unnatural-life',[...a12MainCommon,
        ['history from prior round',c=>c.transition.before.defeatedThisPhase.round--],
        ['most recent different entry',c=>c.transition.before.mostRecentIncarnations['a12:life:wampa']='another'],
        ['history resource not unit',c=>c.transition.before.defeatedThisPhase.cards[0].lastKnownType='resource'],
        ['cost defeated entry stale',c=>c.outcomes[0].defeatedEntry.incarnation='old'],
        ['discount claims minus four',c=>c.outcomes[0].amount=-4],
        ['nested payment prevented',c=>c.outcomes[1].prevented=true],
        ['coherent unit underpayment',c=>{const last=c.outcomes[1].cards.pop().id;c.outcomes[1].amount--;c.transition.after.players.p1.res.ready++;delete c.transition.after.players.p1.resources.find(r=>r.id===last).x;}],
        ['nested resource already charged for source',c=>c.outcomes[1].cards[0]=structuredClone(c.transition.before.players.p1.resources[0])],
        ['unit arrives exhausted',c=>c.outcomes[2].unit.x=1],
        ['arrival reuses dead incarnation',c=>c.outcomes[2].unit.incarnation='a12:life:wampa:entry-1'],
        ['discard route replaced by hand',c=>c.outcomes[2].fromZone='hand'],
        ['old wounds inherited',c=>c.outcomes[2].unit.d=1],
        ['pending wrong source',c=>c.outcomes[3].pending.sourceId='different'],
        ['pending kills prior entry',c=>c.outcomes[3].pending.incarnation='a12:life:wampa:entry-1'],
        ['pending time is phase end',c=>c.outcomes[3].pending.trigger='phase-end'],
        ['ordinary board lacks clock',c=>c.transition.after.players.p1.ground.at(-1).status.pop()],
    ]);
});
test('Aid proves private exact top-ten permutation, selected Heroism nonunits and retained per-copy permissions without play',()=>{
    assertA12Main('aid-from-the-innocent',[...a12MainCommon,
        ['look publicly reveals every card',c=>c.outcomes[0].deckOperation.visibility='public'],
        ['wrong top prefix',c=>c.outcomes[0].deckOperation.looked.reverse()],
        ['three permitted selections',c=>c.outcomes[0].deckOperation.selectedIds.push('a12:aid:look:8')],
        ['selected Heroism unit',c=>c.outcomes[0].deckOperation.selectedIds[0]='a12:aid:look:2'],
        ['selected non-Heroism event',c=>c.outcomes[0].deckOperation.selectedIds[0]='a12:aid:look:4'],
        ['unchosen face revealed',c=>c.outcomes[0].deckOperation.revealedIds.push('a12:aid:look:9')],
        ['deck permutation omits unchosen',c=>c.outcomes[0].deckOperation.remainingOrder.pop()],
        ['untouched deck shuffled',c=>{const a=c.outcomes[0].deckOperation.remainingOrder;[a[2],a[3]]=[a[3],a[2]];}],
        ['selected moved to hand',c=>c.outcomes[1].zone='hand'],
        ['discard prevented but permission kept',c=>c.outcomes[1].prevented=true],
        ['grant to another player',c=>c.outcomes[3].phasePlayPermission.player='p2'],
        ['permission source forged',c=>c.outcomes[3].phasePlayPermission.sourceId='different'],
        ['permission names other copy',c=>c.outcomes[3].phasePlayPermission.cardId='a12:aid:look:2'],
        ['permission permanently retained',c=>c.outcomes[3].duration='permanent'],
        ['permission false Heroism aspects',c=>c.outcomes[3].phasePlayPermission.aspects=['heroism']],
        ['grant before successful discard',c=>{const o=c.outcomes.splice(3,1)[0];c.outcomes.unshift(o);}],
        ['ending lost Drop permission',c=>c.transition.after.discardPlayPermissions.pop()],
        ['ending wrong deck count',c=>c.transition.after.players.p1.deck--],
    ]);
});
test('Impropriety proves complete opposite ready nonleader control exchange preserving owners and paired owner-return clocks',()=>{
    assertA12Main('impropriety-among-thieves',[...a12MainCommon,
        ['first unit exhausted',c=>c.transition.before.players.p1.ground[0].x=1],
        ['selected leader classification',c=>c.transition.before.players.p1.ground[0].leaderUnit=true],
        ['one-sided exchange',c=>c.outcomes.splice(1,1)],
        ['duplicate exchange member',c=>c.outcomes[0].controlExchange.memberIds[1]=c.outcomes[0].controlExchange.memberIds[0]],
        ['exchange changes arena',c=>c.outcomes[0].zone='space'],
        ['unit ownership changes',c=>c.outcomes[0].unit.owner='p2'],
        ['exchange grants readiness',c=>c.outcomes[0].unit.x=1],
        ['exchange loses wounds',c=>c.outcomes[0].unit.d=0],
        ['exchange permanent',c=>c.outcomes[0].duration='permanent'],
        ['different exchange pair',c=>c.outcomes[1].controlExchange={...c.outcomes[1].controlExchange,id:'different'}],
        ['pending returns original controller rather than owner',c=>c.outcomes[2].pending.returnController='p2'],
        ['pending wrong entry',c=>c.outcomes[2].pending.incarnation='old'],
        ['single clock retained',c=>c.outcomes.pop()],
        ['ending target in both players',c=>c.transition.after.players.p1.ground.push(structuredClone(c.transition.after.players.p2.ground.at(-1)))],
        ['held owner status lost',c=>c.transition.after.players.p2.ground.at(-1).status=[]],
    ]);
});
const a12BoundaryCommon=[
    ['source event repaid',c=>{c.playCost=0;c.playPayment={kind:'resources',cardIds:[]};}],
    ['canonical source lost',c=>c.source.n='Another Event'],
    ['initiative changed',c=>c.transition.after.initiative='p2'],
    ['round changed',c=>c.transition.after.round++],
    ['receipt prevented',c=>c.outcomes[0].prevented=true],
    ['causing source unknown',c=>delete c.outcomes[0].sourceCard],
    ['unrelated deck moved',c=>c.transition.after.players.p2.knownDeck.reverse()],
    ['ordinary readying invented',c=>delete c.transition.after.players.p2.leader.x],
];
test('Unnatural regroup consumes only its exact continuing pending entry without payment, draw or ordinary readying',()=>{
    assertA12Main('unnatural-life',[...a12BoundaryCommon,
        ['pending consumed without actual descriptor',c=>delete c.outcomes[0].pending],
        ['pending wrong source',c=>c.outcomes[0].pending.sourceId='different'],
        ['old entry attempted',c=>c.outcomes[0].incarnation='a12:life:wampa:entry-1'],
        ['trigger not witnessed',c=>c.outcomes[0].pending.trigger='phase-end'],
        ['consume declared schedule',c=>c.outcomes[0].pendingOperation='schedule'],
        ['before clock permanent',c=>c.transition.before.players.p1.ground.at(-1).status.at(-1).duration='permanent'],
        ['before clock kind keyword',c=>c.transition.before.players.p1.ground.at(-1).status.at(-1).kind='keyword'],
        ['departed entry resurrected',c=>c.transition.after.players.p1.ground.push(structuredClone(c.outcomes[0].card))],
        ['owner destination false',c=>c.outcomes[0].ownerSeat='p2'],
        ['pending remains after defeat',c=>c.transition.after.pending=structuredClone(c.transition.before.pending)],
    ],'regroup-start');
});
test('Impropriety regroup returns continuing selected units to owners with exact preserved entries and consumed pair',()=>{
    assertA12Main('impropriety-among-thieves',[...a12BoundaryCommon,
        ['return to former controller wrong',c=>c.outcomes[0].seat='p2'],
        ['return moves arena',c=>c.outcomes[0].zone='space'],
        ['return changes owner',c=>c.outcomes[0].card.owner='p2'],
        ['one return missing',c=>c.outcomes.pop()],
        ['pending absent',c=>delete c.outcomes[0].pending],
        ['pending unrelated',c=>c.outcomes[0].pending.targetId='unrelated'],
        ['entry replaced',c=>c.outcomes[0].incarnation='replacement'],
        ['control status permanent',c=>c.transition.before.players.p2.ground.at(-1).status[0].duration='permanent'],
        ['clock loses wrapper kind',c=>c.transition.before.players.p2.ground.at(-1).status.at(-1).kind='keyword'],
        ['continuing wound lost',c=>c.transition.after.players.p1.ground.at(-1).d=0],
        ['pending pair remains',c=>c.transition.after.pending=structuredClone(c.transition.before.pending)],
    ],'regroup-start');
});
test('Aid later play charges actual discounted upgrade cost and consumes only its exact retained phase permission',()=>{
    assertA12Main('aid-from-the-innocent',[...a12BoundaryCommon,
        ['permission expired round',c=>c.transition.before.discardPlayPermissions[0].round--],
        ['permission wrong phase',c=>c.transition.before.discardPlayPermissions[0].phase='regroup'],
        ['permission wrong source',c=>c.transition.before.discardPlayPermissions[0].sourceId='different'],
        ['permission stolen player',c=>c.transition.before.discardPlayPermissions[0].player='p2'],
        ['permission names another copy',c=>c.outcomes[0].phasePermissionId='a12:aid:permission:other'],
        ['cost receipt prevented',c=>c.outcomes[0].prevented=true],
        ['nested pay prevented',c=>c.outcomes[1].prevented=true],
        ['coherent free upgrade false',c=>{const id=c.outcomes[1].cards[0].id;c.outcomes[1].amount=0;c.outcomes[1].cards=[];c.transition.after.players.p1.res.ready++;delete c.transition.after.players.p1.resources.find(r=>r.id===id).x;}],
        ['pay wrong copy',c=>c.outcomes[1].sourceCard=structuredClone(c.source)],
        ['selected upgrade played from hand',c=>c.outcomes[2].fromZone='hand'],
        ['Vehicle host permitted',c=>c.outcomes[2].targetCard=structuredClone(c.transition.before.players.p1.space[0])],
        ['upgrade double stat contribution',c=>c.outcomes[2].upgrade.p=6],
        ['selected unit played instead',c=>c.outcomes[2].playAs='unit'],
        ['permission replayed permanently',c=>c.transition.after.discardPlayPermissions=structuredClone(c.transition.before.discardPlayPermissions)],
        ['other Drop permission also consumed',c=>c.transition.after.discardPlayPermissions=[]],
        ['host wounds reset',c=>c.transition.after.players.p1.ground[0].d=0],
    ],'next-action');
});

test('Unnatural rich fresh Defender entry retains JSON-native Sentinel, rejecting a coherent missing flag',()=>{
    const json=JSON.parse(fs.readFileSync(path.join(__dirname,'../../forceteki/test/json/Card/echo-base-defender.json')));
    assert.ok(json.keywords.includes('sentinel'));assert.deepEqual([json.power,json.hp],[4,3]);
    const api=loadTS(path.join(__dirname,'../src/effects/batchA12.ts')),{previewPlayCost}=loadTS(path.join(__dirname,'../src/effects/previewCosts.ts'));
    const definition=api.A12_DEFINITIONS.find(d=>d.id==='unnatural-life'),before=api.a12ShowcaseState(definition),id='a12:life:defender',old=id+':entry-1';
    before.players.p1.discard=[{id,n:json.title,s:'SOR_098',owner:'p1'}];
    before.defeatedThisPhase.cards=[{id,incarnation:old,controller:'p2',lastKnownType:'unit'}];before.mostRecentIncarnations={[id]:old};
    const cue={definition,seat:'p1',source:api.a12PreviewSource(definition,before,'p1'),target:null,key:'a12:sentinel',playPayment:api.a12PreviewPayment(definition,before,'p1'),outcomes:api.a12PreviewOutcomes(definition,before,'p1',{targetId:id})};
    cue.playCost=previewPlayCost(definition,before,'p1',cue.playPayment);cue.transition={before,after:resolvePreviewState(before,cue)};
    assert.equal(cue.outcomes[1].amount,1,'actual Defender cost3 minus2');assert.equal(cue.outcomes[2].unit.sn,1);assert.equal(cue.transition.after.players.p1.ground.at(-1).sn,1);
    const complete=geometry(cue.outcomes);for(const item of complete.outcomes)assert.equal(batchA12Covers(cue,complete,item),true,'native Sentinel fresh entry is supported');
    const wrong=structuredClone(cue);delete wrong.outcomes[2].unit.sn;delete wrong.transition.after.players.p1.ground.at(-1).sn;
    const generic=geometry(wrong.outcomes);for(const item of generic.outcomes)assert.equal(batchA12Covers(wrong,generic,item),false,'same ending with lost native Sentinel stays generic');
});


const { batchA13SecondaryCovers } = loadTS(path.join(__dirname, '../src/effects/batchA13SecondarySignatures.tsx'));
const a13SecondaryAPI = loadTS(path.join(__dirname, '../src/effects/batchA13.ts'));
function a13SecondaryCue(id, changeBefore, choices) {
    const definition=a13SecondaryAPI.A13_DEFINITIONS.find(d=>d.id===id),before=a13SecondaryAPI.a13ShowcaseState(definition);
    if(changeBefore)changeBefore(before);
    const cue={definition,seat:'p1',source:a13SecondaryAPI.a13PreviewSource(definition,before,'p1'),target:null,key:'a13:gate',playPayment:a13SecondaryAPI.a13PreviewPayment(definition,before,'p1',choices),outcomes:a13SecondaryAPI.a13PreviewOutcomes(definition,before,'p1',choices)};
    cue.playCost=loadTS(path.join(__dirname,'../src/effects/previewCosts.ts')).previewPlayCost(definition,before,'p1',cue.playPayment);
    cue.transition={before,after:resolvePreviewState(before,cue)};return cue;
}
function a13SecondaryCheck(cue, accepted, reason) {
    const g=geometry(cue.outcomes);assert.ok(g.outcomes.length,'test must exercise real receipts');
    for(const item of g.outcomes)assert.equal(batchA13SecondaryCovers(cue,g,item),accepted,reason);
}
function a13SecondaryCommon(id) {
    const cue=a13SecondaryCue(id);a13SecondaryCheck(cue,true,'complete primary evidence');
    for(const [reason,mutate]of [
        ['different causing source',c=>c.outcomes[0].sourceCard={...c.source,id:'other-event'}],
        ['coherent underpayment',c=>{c.playCost--;const id=c.playPayment.cardIds.pop();delete c.transition.after.players.p1.resources.find(r=>r.id===id).x;c.transition.after.players.p1.res.ready++;}],
        ['unreceipted initiative',c=>c.transition.after.initiative='p2'],
        ['prevented receipt',c=>c.outcomes[0].prevented=true],
        ['unestablished prerequisite',c=>c.outcomes[0].requiresDefeat={id:'unrelated',incarnation:'entry-1'}],
    ]){const wrong=structuredClone(cue);mutate(wrong);a13SecondaryCheck(wrong,false,reason);}
    return cue;
}
test('Political Pressure separates opponent mode choice from the random card and refuses an invented successful discard',()=>{
    const cue=a13SecondaryCommon('political-pressure');assert.equal(cue.outcomes[0].choice.chooserSeat,'p2');
    const random=a13SecondaryCue('political-pressure',undefined,{mode:'discard',randomId:'a13:p2:hand:0'});
    assert.equal(random.outcomes.length,1);assert.equal(random.outcomes[0].selection,'random');assert.equal(random.outcomes[0].chooserSeat,undefined);a13SecondaryCheck(random,true,'actual random result is supported');
    const wrong=structuredClone(random);wrong.outcomes[0].selection='chosen';wrong.outcomes[0].chooserSeat='p2';a13SecondaryCheck(wrong,false,'opponent chooses mode only');
    for(const result of [undefined,'unknown']){const contradictory=structuredClone(random);if(result===undefined)delete contradictory.outcomes[0].choice.result;else contradictory.outcomes[0].choice.result=result;a13SecondaryCheck(contradictory,false,'successful random discard requires explicit discarded result: '+result);}
    const invented=structuredClone(cue);for(const o of invented.outcomes)o.choice={...o.choice,decision:'discard',selectedId:'a13:p2:hand:0'};a13SecondaryCheck(invented,false,'nonempty hand failed attempt has no supporting prevention receipt');
    const empty=a13SecondaryCue('political-pressure',s=>s.players.p2.hand=[],{mode:'discard'});a13SecondaryCheck(empty,true,'empty hand yields two Droids without phantom hand loss');
});
test('Droid Deployment proves two fresh exhausted ground bodies and rejects coherent ready or foreign-owner entries',()=>{
    const cue=a13SecondaryCommon('droid-deployment');
    for(const [reason,mutate]of [
        ['created ready',c=>{const o=c.outcomes[0];delete o.card.x;delete o.unit.x;o.entersReady=true;delete c.transition.after.players.p1.ground.find(u=>u.id===o.card.id).x;}],
        ['stale body identity',c=>{const o=c.outcomes[0],old=c.transition.before.players.p1.ground[0];o.unit.id=old.id;o.card.id=old.id;}],
        ['foreign owner',c=>{const o=c.outcomes[0];o.ownerSeat='p2';o.card.owner='p2';o.unit.owner='p2';c.transition.after.players.p1.ground.find(u=>u.id===o.card.id).owner='p2';}],
    ]){const wrong=structuredClone(cue);mutate(wrong);a13SecondaryCheck(wrong,false,reason);}
});
test('Merciless Contest keeps independent controller choices, owner destinations and genuinely absent sides',()=>{
    const cue=a13SecondaryCommon('merciless-contest');
    const stolen=a13SecondaryCue('merciless-contest',s=>s.players.p1.ground[0].owner='p2');a13SecondaryCheck(stolen,true,'controller chooses and owner receives');
    assert.ok(stolen.transition.after.players.p2.discard.some(c=>c.id==='a13:p1:marine'));
    const one=a13SecondaryCue('merciless-contest',s=>{s.players.p2.ground=[];s.players.p2.space=[];});a13SecondaryCheck(one,true,'one eligible side has one departure');
    const wrong=structuredClone(cue);wrong.outcomes[1].chooserSeat='p1';a13SecondaryCheck(wrong,false,'P1 cannot choose P2 body');
    const missing=structuredClone(cue);missing.outcomes.pop();a13SecondaryCheck(missing,false,'eligible opponent cannot vanish from the choice evidence');
});
test('Heroes on Both Sides preserves both same-controller roles and phase-bound stats and Saboteur',()=>{
    const cue=a13SecondaryCommon('heroes-on-both-sides');assert.ok(cue.outcomes.every(o=>o.seat==='p1'));
    const enemy=a13SecondaryCue('heroes-on-both-sides',s=>{const p=s.players.p1;const u=p.ground.find(u=>u.id==='a13:heroes:republic');p.ground=p.ground.filter(x=>x!==u);s.players.p2.ground.push(u);});a13SecondaryCheck(enemy,true,'current Republic may be enemy-controlled');
    const one=a13SecondaryCue('heroes-on-both-sides',undefined,{republicId:null});a13SecondaryCheck(one,true,'one role is optional');
    for(const [reason,mutate]of [
        ['keyword wrong incarnation',c=>c.transition.after.players.p1.ground.find(u=>u.id==='a13:heroes:republic').status.find(s=>s.kind==='keyword').incarnation='later-entry'],
        ['keyword wrong phase',c=>c.transition.after.players.p1.ground.find(u=>u.id==='a13:heroes:republic').status.find(s=>s.kind==='keyword').phase='regroup'],
        ['keyword missing',c=>{const u=c.transition.after.players.p1.ground.find(u=>u.id==='a13:heroes:republic');u.status=u.status.filter(s=>s.kind!=='keyword');}],
        ['duplicated role',c=>{c.outcomes[2].traitGrant.trait='republic';c.outcomes[3].traitGrant.trait='republic';}],
    ]){const wrong=structuredClone(cue);mutate(wrong);a13SecondaryCheck(wrong,false,reason);}
});
test('Sword and Shield requires complete friendly trait sets and retains attack-only Raid and Boolean Sentinel',()=>{
    const cue=a13SecondaryCommon('sword-and-shield-maneuver');
    const after=cue.transition.after.players.p1,before=cue.transition.before.players.p1;
    for(const u of [...after.ground,...after.space]){const old=[...before.ground,...before.space].find(x=>x.id===u.id);assert.deepEqual([u.p,u.h,u.d],[old.p,old.h,old.d]);}
    const missing=structuredClone(cue);missing.outcomes.pop();a13SecondaryCheck(missing,false,'entire eligible set is required');
    const inflated=structuredClone(cue);inflated.transition.after.players.p1.ground.find(u=>u.id==='a13:p1:marine').p++;a13SecondaryCheck(inflated,false,'Raid is not resting power');
    const lost=structuredClone(cue);delete lost.transition.after.players.p1.space.find(u=>u.id==='a13:sword:cruiser').sn;a13SecondaryCheck(lost,false,'granted Sentinel must survive into the board');
    const stale=structuredClone(cue);stale.transition.after.players.p1.ground.find(u=>u.id==='a13:p1:marine').status[0].round--;a13SecondaryCheck(stale,false,'phase status belongs to the actual round');
});


const {batchA13Covers}=loadTS(path.join(__dirname,'../src/effects/batchA13Signatures.tsx'));
const a13MainAPI=loadTS(path.join(__dirname,'../src/effects/batchA13.ts'));
function a13MainCue(id,changeBefore,choices){
    const definition=a13MainAPI.A13_DEFINITIONS.find(d=>d.id===id),before=a13MainAPI.a13ShowcaseState(definition);if(changeBefore)changeBefore(before);
    const cue={definition,seat:'p1',source:a13MainAPI.a13PreviewSource(definition,before,'p1'),target:null,key:'a13:main:gate',playPayment:a13MainAPI.a13PreviewPayment(definition,before,'p1'),outcomes:a13MainAPI.a13PreviewOutcomes(definition,before,'p1',choices)};
    cue.playCost=loadTS(path.join(__dirname,'../src/effects/previewCosts.ts')).previewPlayCost(definition,before,'p1',cue.playPayment);cue.transition={before,after:resolvePreviewState(before,cue)};return cue;
}
function a13MainCheck(cue,accepted,reason){const g=geometry(cue.outcomes);assert.ok(g.outcomes.length,'must exercise actual receipts');for(const item of g.outcomes)assert.equal(batchA13Covers(cue,g,item),accepted,reason);}
function a13MainMutations(cue,mutations){for(const [reason,mutate]of mutations){const wrong=structuredClone(cue);mutate(wrong);a13MainCheck(wrong,false,reason);}}
function a13MainCommon(id){
    const cue=a13MainCue(id);a13MainCheck(cue,true,'complete primary receipts');
    a13MainMutations(cue,[
        ['coherent underpayment',c=>{const id=c.playPayment.cardIds.pop();c.playCost--;delete c.transition.after.players.p1.resources.find(r=>r.id===id).x;c.transition.after.players.p1.res.ready++;}],
        ['coherent spoofed canonical event title',c=>{const id=c.source.id;c.definition.name='Different Event';for(const s of [c.transition.before,c.transition.after])for(const p of Object.values(s.players))for(const card of [...p.hand,...p.discard])if(card.id===id)card.n='Different Event';c.source.n='Different Event';for(const o of c.outcomes)if(o.sourceCard?.id===id)o.sourceCard.n='Different Event';}],
        ['unreceipted phase',c=>c.transition.after.phase='regroup'],
        ['unreceipted round',c=>c.transition.after.round++],
        ['unreceipted initiative',c=>c.transition.after.initiative='p2'],
        ['invented requirement',c=>c.outcomes[0].requiresDefeat={id:'other',incarnation:'entry'}],
        ['invented payment mode',c=>c.playPayment.smuggle={sourceId:c.source.id,resourcesAfterPayment:c.transition.after.players.p1.resources}],
    ]);
    for(let i=0;i<cue.outcomes.length;i++)a13MainMutations(cue,[
        ['wrong causing source receipt '+i,c=>c.outcomes[i].sourceCard={...c.outcomes[i].sourceCard,id:'different-source'}],
        ['invented receipt kind '+i,c=>c.outcomes[i].kind='heal'],
        ['invented watcher '+i,c=>c.outcomes[i].requiresExhaust={id:'other',incarnation:'entry'}],
    ]);
    return cue;
}
test('A13 Unmask requires successful own discard, complete private opponent hand and the event player selection',()=>{
    const cue=a13MainCommon('unmasking-the-conspiracy');
    assert.equal(JSON.parse(fs.readFileSync(path.join(__dirname,'../../forceteki/test/json/Card/unmasking-the-conspiracy.json'))).id,'0959549331');
    a13MainMutations(cue,[
        ['prevented own loss cannot license look',c=>{c.outcomes[0].prevented=true;const card=c.transition.before.players.p1.hand[1];c.transition.after.players.p1.hand.push(card);c.transition.after.players.p1.discard=c.transition.after.players.p1.discard.filter(x=>x.id!==card.id);}],
        ['paid event is not the successful discard',c=>{c.outcomes[0].card=c.source;c.outcomes[1].requiresDiscard.id=c.source.id;c.outcomes[2].requiresDiscard.id=c.source.id;}],
        ['look changed to public',c=>c.outcomes[1].visibility='public'],
        ['only selected card is not whole hand',c=>{c.outcomes[1].cards.pop();c.outcomes[1].amount=1;}],
        ['inspected face spoof',c=>c.outcomes[1].cards[1]={...c.outcomes[1].cards[1],n:'Other Face'}],
        ['different prerequisite on chosen loss',c=>c.outcomes[2].requiresDiscard={id:'other',seat:'p1'}],
        ['opponent chooses the card',c=>c.outcomes[2].chooserSeat='p2'],
        ['random chosen result',c=>c.outcomes[2].selection='random'],
        ['look prevented',c=>c.outcomes[1].prevented=true],
        ['chosen loss prevented',c=>c.outcomes[2].prevented=true],
        ['selection sequence missing',c=>delete c.outcomes[2].sequenceId],
        ['selection sequence order inverted',c=>c.outcomes[2].sequenceIndex=1],
        ['chosen card differs from inspection',c=>c.outcomes[2].card=c.transition.before.players.p2.hand[1]],
        ['private source seat wrong',c=>c.outcomes[1].fromSeat='p1'],
        ['foreign discard destination',c=>c.outcomes[2].ownerSeat='p1'],
        ['look omitted but discard retained',c=>c.outcomes.splice(1,1)],
        ['selected discard omitted',c=>c.outcomes.pop()],
    ]);
    const empty=a13MainCue('unmasking-the-conspiracy',s=>s.players.p2.hand=[]);a13MainCheck(empty,true,'own loss with genuinely empty opponent has no phantom inspection');
});
test('A13 Breaking In seals ready same-arena Saboteur combat, every Shield and actual transient expiration',()=>{
    const cue=a13MainCommon('breaking-in');
    const x=cue.transition.after.players.p1.space[0];assert.deepEqual([x.p,x.h,x.d,x.x],[2,3,2,1]);assert.equal(cue.transition.after.players.p2.space.length,1);
    a13MainMutations(cue,[
        ['already exhausted attacker',c=>c.transition.before.players.p1.space[0].x=1],
        ['extra attack power',c=>c.outcomes[2].amount=5],
        ['wrong counterdamage',c=>c.outcomes[6].amount=0],
        ['missing counter receipt',c=>c.outcomes.splice(6,1)],
        ['missing Shield removal',c=>c.outcomes.splice(4,1)],
        ['Shield removal prevented',c=>c.outcomes[4].prevented=true],
        ['attack prevented',c=>c.outcomes[2].prevented=true],
        ['forward damage prevented',c=>c.outcomes[5].prevented=true],
        ['counter prevented',c=>c.outcomes[6].prevented=true],
        ['buff prevented',c=>c.outcomes[0].prevented=true],
        ['exhaust prevented',c=>c.outcomes[3].prevented=true],
        ['death prevented',c=>c.outcomes[7].prevented=true],
        ['buff lasts phase',c=>c.outcomes[0].duration='phase'],
        ['Saboteur absent',c=>c.outcomes[1].keyword.name='Raid'],
        ['split attack identity',c=>c.outcomes[6].attackId='other'],
        ['wrong current entry',c=>c.outcomes[5].incarnation='entry-old'],
        ['attacker-first fiction',c=>c.outcomes[2].combatOrder='attacker-first'],
        ['attack bonus retained',c=>c.transition.after.players.p1.space[0].p=4],
        ['Saboteur retained',c=>c.transition.after.players.p1.space[0].status=[{kind:'keyword',label:'Saboteur',duration:'permanent',keyword:{name:'Saboteur',amount:1}}]],
        ['survivor not exhausted',c=>delete c.transition.after.players.p1.space[0].x],
        ['removed unrelated Sentinel instead',c=>c.outcomes[7].card=c.transition.before.players.p2.space[1]],
    ]);
});
test('A13 Two of Them requires exactly one real controlled arena body, current shared trait and canonical nested payment',()=>{
    const cue=a13MainCommon('now-there-are-two-of-them');
    a13MainMutations(cue,[
        ['two own units across lanes',c=>{const u=structuredClone(c.transition.before.players.p2.space[0]);u.id='own-second';u.owner='p1';c.transition.before.players.p1.space.push(u);c.transition.after.players.p1.space.push(u);}],
        ['no continuing own body',c=>{c.transition.before.players.p1.ground=[];c.transition.after.players.p1.ground=c.transition.after.players.p1.ground.filter(u=>u.id!=='a13:p1:marine');}],
        ['enemy entry does not establish own one',c=>{for(const o of c.outcomes)o.singleUnitPlay.unitId='a13:p2:trooper';}],
        ['wrong current incarnation',c=>{for(const o of c.outcomes)o.singleUnitPlay.incarnation='other';}],
        ['trait not actually shared',c=>{for(const o of c.outcomes)o.singleUnitPlay.sharedTrait='jedi';}],
        ['fabricated selected printed cost',c=>{for(const o of c.outcomes)o.singleUnitPlay.printedCost=1;c.outcomes[2].printedCost=1;}],
        ['fabricated aspect price witness',c=>{for(const o of c.outcomes)o.singleUnitPlay.aspects=['cunning'];}],
        ['prevented cost',c=>c.outcomes[0].prevented=true],
        ['prevented nested pay',c=>c.outcomes[1].prevented=true],
        ['prevented play',c=>c.outcomes[2].prevented=true],
        ['discount changed',c=>c.outcomes[0].amount=-6],
        ['coherent free nested play',c=>{const o=c.outcomes[1],id=o.cards[0].id;o.cards=[];o.amount=0;delete c.transition.after.players.p1.resources.find(r=>r.id===id).x;c.transition.after.players.p1.res.ready++;}],
        ['paid event resource reused',c=>c.outcomes[1].cards[0]=c.transition.before.players.p1.resources[0]],
        ['normal entry made ready',c=>{const o=c.outcomes[2];o.entersReady=true;delete o.unit.x;delete c.transition.after.players.p1.ground.at(-1).x;}],
        ['inherited wounds',c=>{c.outcomes[2].unit.d=1;c.transition.after.players.p1.ground.at(-1).d=1;}],
        ['wrong native power',c=>{c.outcomes[2].unit.p=6;c.transition.after.players.p1.ground.at(-1).p=6;}],
        ['unknown When Played result',c=>c.outcomes.push({kind:'ready',card:c.outcomes[2].unit,seat:'p1',zone:'ground',sourceCard:c.outcomes[2].unit})],
    ]);
    const floor=a13MainCue('now-there-are-two-of-them',s=>{const p=s.players.p1;p.hand.push({id:'a13:two:free',n:'Echo Base Defender',s:'SOR_098',owner:'p1'});},{playId:'a13:two:free'});assert.equal(floor.outcomes[1].amount,0);a13MainCheck(floor,true,'actual lower-cost shared Trooper uses floor zero and retains native Sentinel');
});
test('A13 Prisoner captures any printed-cost relationship and keeps independent strict-cost Droid receipts',()=>{
    const cue=a13MainCommon('prisoner-of-war');
    const high=a13MainCue('prisoner-of-war',undefined,{captorId:'a13:p1:marine',targetId:'a13:p2:trooper'});assert.equal(high.outcomes.length,1);a13MainCheck(high,true,'greater enemy cost permits capture without Droids');
    const equal=a13MainCue('prisoner-of-war',undefined,{captorId:'a13:p1:defender',targetId:'a13:p2:trooper'});assert.equal(equal.outcomes.length,1);a13MainCheck(equal,true,'equal printed cost permits capture without Droids');
    const prevented=structuredClone(cue);prevented.outcomes[0].prevented=true;prevented.transition.after=resolvePreviewState(prevented.transition.before,prevented);a13MainCheck(prevented,true,'lower printed comparison creates Droids even though actual capture is prevented');
    a13MainMutations(cue,[
        ['false captured printed cost',c=>{for(const o of c.outcomes)o.captureSelection.target.printedCost=1;}],
        ['false captor printed cost',c=>{for(const o of c.outcomes)o.captureSelection.captor.printedCost=9;}],
        ['false causing event selection',c=>{for(const o of c.outcomes)o.captureSelection.sourceId='other-event';}],
        ['wrong target incarnation seal',c=>{for(const o of c.outcomes)o.captureSelection.target.incarnation='other-entry';}],
        ['invented capture success prerequisite',c=>c.outcomes[1].requiresDefeat={id:'a13:p2:wampa',incarnation:'a13:p2:wampa:entry-1'}],
        ['vehicle target',c=>c.transition.before.players.p2.ground[1].traits.push('vehicle')],
        ['leader target',c=>c.transition.before.players.p2.ground[1].leaderUnit=true],
        ['actual leader summary despite false nonleader flag',c=>{c.transition.before.players.p2.leader={...c.transition.before.players.p2.leader,id:'a13:p2:wampa',dep:1};c.transition.after.players.p2.leader={...c.transition.before.players.p2.leader};}],
        ['wrong originating arena',c=>c.outcomes[0].fromZone='space'],
        ['wrong captor controller',c=>c.outcomes[0].seat='p2'],
        ['foreign pocket owner',c=>c.transition.after.players.p1.space.at(-1).cap[0].owner='p1'],
        ['wounds inherited in pocket',c=>c.transition.after.players.p1.space.at(-1).cap[0].d=1],
        ['only one Droid for lower cost',c=>c.outcomes.pop()],
        ['duplicate Droid',c=>c.outcomes.push(structuredClone(c.outcomes[1]))],
        ['created token ready',c=>{const o=c.outcomes[1];o.entersReady=true;delete o.unit.x;delete c.transition.after.players.p1.ground.find(u=>u.id===o.unit.id).x;}],
        ['created token prevented',c=>c.outcomes[1].prevented=true],
        ['captor owner changes bonus beneficiary',c=>{c.outcomes[1].seat='p2';c.outcomes[2].seat='p2';}],
    ]);
});
test('A13 Order 66 requires the complete Jedi six-hit window and exactly one controller Clone per causal defeat',()=>{
    const cue=a13MainCommon('execute-order-66');
    a13MainMutations(cue,[
        ['one Jedi omitted',c=>c.outcomes.splice(1,1)],
        ['unknown current Jedi classifications',c=>delete c.transition.before.players.p1.ground[0].traits],
        ['one Jedi hit prevented',c=>c.outcomes[1].prevented=true],
        ['ability changed to combat',c=>c.outcomes[0].damageType='combat'],
        ['damage magnitude changed',c=>c.outcomes[0].amount=5],
        ['mixed damage window',c=>c.outcomes[1].resolutionGroup={id:'other-window',mode:'simultaneous'}],
        ['lethal removal before all hits',c=>{const d=c.outcomes.splice(3,1)[0];c.outcomes.splice(1,0,d);}],
        ['defeat prevented',c=>c.outcomes[3].prevented=true],
        ['Clone prevented',c=>c.outcomes[5].prevented=true],
        ['wrong damage source seal',c=>c.outcomes[5].damageDefeatOrigin.sourceId='other-event'],
        ['wrong causal damage amount',c=>c.outcomes[5].damageDefeatOrigin.amount=5],
        ['survivor licenses Clone',c=>{c.outcomes[5].requiresDefeat={id:'a13:order:cruiser',incarnation:'a13:order:cruiser:entry-1'};c.outcomes[5].damageDefeatOrigin.subjectId='a13:order:cruiser';c.outcomes[5].damageDefeatOrigin.incarnation='a13:order:cruiser:entry-1';}],
        ['stale defeated incarnation',c=>c.outcomes[5].requiresDefeat.incarnation='old'],
        ['Clone beneficiary is owner fiction',c=>c.outcomes[5].damageDefeatOrigin.controller='p2'],
        ['created Droid instead of Clone',c=>c.outcomes[5].tokenType='battle-droid'],
        ['false fresh token power',c=>{const o=c.outcomes[5];o.unit.p=1;c.transition.after.players.p1.ground.find(u=>u.id===o.unit.id).p=1;}],
        ['missing one causal Clone',c=>c.outcomes.pop()],
        ['duplicate causal Clone',c=>c.outcomes.push(structuredClone(c.outcomes[5]))],
        ['surviving Cruiser wounds omitted',c=>c.transition.after.players.p1.space.at(-1).d=0],
        ['unclaimed native Shield absorption',c=>c.transition.before.players.p1.space.at(-1).u=[{id:'shield',n:'Shield',s:null,t:1,p:0,h:0,owner:'p1'}]],
    ]);
    const stolen=a13MainCue('execute-order-66',s=>s.players.p1.ground.at(-1).owner='p2');a13MainCheck(stolen,true,'owner gets discarded Vernestra while its actual P1 controller creates Clone');assert.ok(stolen.transition.after.players.p2.discard.some(c=>c.id==='a13:order:vernestra'));assert.ok(stolen.transition.after.players.p1.ground.some(u=>u.n==='Clone Trooper'));
});

const { batchA14SecondaryCovers } = loadTS(path.join(__dirname, '../src/effects/batchA14SecondarySignatures.tsx'));
const a14SecondaryAPI = loadTS(path.join(__dirname, '../src/effects/batchA14.ts'));
function a14SecondaryCue(id, changeBefore, choices) {
    const definition=a14SecondaryAPI.A14_DEFINITIONS.find(d=>d.id===id),before=a14SecondaryAPI.a14ShowcaseState(definition);
    if(changeBefore)changeBefore(before);
    const cue={definition,seat:'p1',source:a14SecondaryAPI.a14PreviewSource(definition,before,'p1'),target:null,key:'a14:gate',playPayment:a14SecondaryAPI.a14PreviewPayment(definition,before,'p1',choices),outcomes:a14SecondaryAPI.a14PreviewOutcomes(definition,before,'p1',choices)};
    cue.playCost=loadTS(path.join(__dirname,'../src/effects/previewCosts.ts')).previewPlayCost(definition,before,'p1',cue.playPayment);
    cue.transition={before,after:resolvePreviewState(before,cue)};return cue;
}
function a14SecondaryCheck(cue, accepted, reason) {
    const g=geometry(cue.outcomes);assert.ok(g.outcomes.length,'test must exercise real receipts');
    for(const item of g.outcomes)assert.equal(batchA14SecondaryCovers(cue,g,item),accepted,reason);
}
function a14SecondaryMutations(cue, mutations) {
    for(const [reason,mutate]of mutations){const wrong=structuredClone(cue);mutate(wrong);a14SecondaryCheck(wrong,false,reason);}
}
function a14SecondaryCommon(id) {
    const cue=a14SecondaryCue(id);a14SecondaryCheck(cue,true,'complete primary evidence');
    a14SecondaryMutations(cue,[
        ['different causing source',c=>c.outcomes[0].sourceCard={...c.source,id:'other-event'}],
        ['coherent underpayment',c=>{c.playCost--;const id=c.playPayment.cardIds.pop();delete c.transition.after.players.p1.resources.find(r=>r.id===id).x;c.transition.after.players.p1.res.ready++;}],
        ['coherent illegal regroup play',c=>{c.transition.before.phase='regroup';c.transition.after.phase='regroup';}],
        ['unreceipted initiative',c=>c.transition.after.initiative='p2'],
        ['invented discard permission',c=>c.transition.after.discardPlayPermissions=[{id:'fiction',sourceId:c.source.id,cardId:c.source.id,player:'p1',round:c.transition.before.round,phase:'action',fromZone:'discard',discount:2,cardType:'event',aspects:[]}]],
        ['invented future defeat',c=>c.transition.after.pending=[{id:'fiction',sourceId:c.source.id,targetId:'a14:p1:marine',incarnation:'a14:p1:marine:entry-1',trigger:'regroup-start',kind:'defeat'}]],
        ['prevented receipt',c=>c.outcomes[0].prevented=true],
        ['unestablished exhaustion prerequisite',c=>c.outcomes[0].requiresExhaust={id:'unrelated',incarnation:'entry-1'}],
        ['coherent false canonical title',c=>{const id=c.source.id;c.definition.name='Other Event';c.source.n='Other Event';for(const s of [c.transition.before,c.transition.after])for(const p of Object.values(s.players))for(const card of [...p.hand,...p.discard])if(card.id===id)card.n='Other Event';for(const o of c.outcomes)if(o.sourceCard?.id===id)o.sourceCard.n='Other Event';}],
    ]);
    if(id !== 'drop-in') a14SecondaryMutations(cue,[['coherent printed unit misclassified as token',c=>{
        const targetId=c.outcomes[0].card.id;
        const visit=v=>{if(!v||typeof v!=='object')return;if(v.id===targetId&&'p' in v)v.t=1;for(const x of Object.values(v))visit(x);};visit(c);
        for(const player of Object.values(c.transition.after.players))player.discard=player.discard.filter(card=>card.id!==targetId);
    }]]);
    return cue;
}
test('A14 Drop In creates exactly two fresh exhausted Clone bodies with canonical source and full snapshot conservation',()=>{
    const cue=a14SecondaryCommon('drop-in');
    a14SecondaryMutations(cue,[
        ['one token only',c=>c.outcomes.pop()],
        ['recreated old token incarnation',c=>{const u=c.outcomes[0].unit;for(const state of [c.transition.before,c.transition.after])state.mostRecentIncarnations={...(state.mostRecentIncarnations??{}),[u.id]:u.incarnation};}],
        ['coherent ready entry',c=>{const o=c.outcomes[0];delete o.card.x;delete o.unit.x;o.entersReady=true;delete c.transition.after.players.p1.ground.find(u=>u.id===o.card.id).x;}],
        ['coherent foreign owner',c=>{const o=c.outcomes[0];o.ownerSeat='p2';o.unit.owner='p2';o.card.owner='p2';c.transition.after.players.p1.ground.find(u=>u.id===o.card.id).owner='p2';}],
        ['reused current card identity',c=>{const o=c.outcomes[0],old=c.transition.before.players.p1.ground[0];o.unit.id=old.id;o.card.id=old.id;}],
        ['ordinary play instead of creation',c=>{c.outcomes[0].kind='play';c.outcomes[0].entryType='played';}],
        ['coherent invented inherited status',c=>{const o=c.outcomes[0],status=[{kind:'keyword',duration:'permanent',label:'Saboteur',keyword:{name:'Saboteur',amount:1}}];o.unit.status=status;o.card.status=status;c.transition.after.players.p1.ground.find(u=>u.id===o.card.id).status=status;}],
    ]);
});
test('A14 Direct Hit requires an actual nonleader Vehicle departure and preserves unrelated metadata and owner destination',()=>{
    const cue=a14SecondaryCommon('direct-hit');
    a14SecondaryMutations(cue,[
        ['non-Vehicle classification',c=>c.transition.before.players.p2.space[0].traits=['trooper']],
        ['leader classification',c=>c.transition.before.players.p2.space[0].leaderUnit=true],
        ['wrong owner route',c=>{const dead=c.transition.after.players.p2.discard.pop();c.transition.after.players.p1.discard.push(dead);c.outcomes[0].ownerSeat='p1';}],
        ['combat fiction',c=>c.outcomes[0].attackId='invented-combat'],
        ['unreceipted wounds on survivor',c=>c.transition.after.players.p2.ground[0].d++],
        ['target retained',c=>c.transition.after.players.p2.space.push(c.transition.before.players.p2.space[0])],
    ]);
});
test('A14 Power from Pain fixes its power boost to actual application wounds while preserving HP and phase-bound status',()=>{
    const cue=a14SecondaryCommon('power-from-pain');
    const target=cue.transition.after.players.p2.ground.find(u=>u.id==='a14:p2:wampa');assert.deepEqual([target.p,target.h,target.d],[6,5,2]);
    a14SecondaryMutations(cue,[
        ['coherent amount exceeds actual wounds',c=>{c.outcomes[0].woundBoost.wounds=3;c.outcomes[0].amount='+3/+0';const u=c.transition.after.players.p2.ground[1];u.p=7;u.status.at(-1).label='+3/+0 · phase';}],
        ['old wound entry',c=>c.outcomes[0].woundBoost.incarnation='old-entry'],
        ['another unit supplies wounds',c=>c.outcomes[0].woundBoost.subjectId='a14:p1:marine'],
        ['extra maximum HP',c=>c.transition.after.players.p2.ground[1].h++],
        ['wounds healed',c=>c.transition.after.players.p2.ground[1].d=0],
        ['lasting status omitted',c=>c.transition.after.players.p2.ground[1].status.pop()],
        ['status tied to old phase',c=>c.transition.after.players.p2.ground[1].status.at(-1).phase='regroup'],
        ['Grit invented instead of fixed buff',c=>c.transition.after.players.p2.ground[1].status.at(-1).keyword={name:'Grit',amount:1}],
    ]);
    const zero=a14SecondaryCue('power-from-pain',s=>s.players.p2.ground[1].d=0);a14SecondaryCheck(zero,true,'zero actual wounds gives fixed +0 power without damage or healing');
    const own=a14SecondaryCue('power-from-pain',undefined,{targetId:'a14:p1:marine'});a14SecondaryCheck(own,true,'friendly target is legal too');
});
test('A14 All Clear seals actual last enemy-space defeat before its optional persistent Experience grant',()=>{
    const cue=a14SecondaryCommon('youre-all-clear-kid');
    a14SecondaryMutations(cue,[
        ['extra enemy space survivor',c=>{const u=structuredClone(c.transition.before.players.p2.space[0]);u.id='other-space';u.incarnation='other-space:entry-1';c.transition.before.players.p2.space.push(u);c.transition.after.players.p2.space.push(u);}],
        ['remaining HP four',c=>c.transition.before.players.p2.space[0].h=4],
        ['false clearance opponent',c=>{for(const o of c.outcomes)o.spaceClearance.opponent='p1';}],
        ['invented remaining clearance member',c=>{for(const o of c.outcomes)o.spaceClearance.remainingIdsAtDefeat=['other-space'];}],
        ['different moment of clearance',c=>c.outcomes[1].spaceClearance={...c.outcomes[1].spaceClearance,id:'other-moment'}],
        ['wrong defeated incarnation prerequisite',c=>c.outcomes[1].requiresDefeat.incarnation='old-entry'],
        ['prevented XP',c=>c.outcomes[1].prevented=true],
        ['coherent phase boost instead of token',c=>{c.outcomes[1].duration='phase';delete c.outcomes[1].cards;delete c.transition.after.players.p1.ground[0].u;}],
        ['coherent reused XP identity',c=>{const id=c.transition.before.players.p1.hand[0].id;c.outcomes[1].cards[0].id=id;c.transition.after.players.p1.ground[0].u[0].id=id;}],
        ['XP heals old wound',c=>c.transition.after.players.p1.ground[0].d=0],
        ['defeated enemy receives XP',c=>c.outcomes[1].card=c.transition.before.players.p2.space[0]],
    ]);
    const declined=a14SecondaryCue('youre-all-clear-kid',undefined,{experienceId:null});assert.equal(declined.outcomes.length,1);a14SecondaryCheck(declined,true,'optional XP can be declined');
    const other=a14SecondaryCue('youre-all-clear-kid',undefined,{experienceId:'a14:p2:wampa'});a14SecondaryCheck(other,true,'surviving enemy ground unit may receive XP');
    const notClear=a14SecondaryCue('youre-all-clear-kid',s=>{const u=structuredClone(s.players.p2.space[0]);u.id='second';u.incarnation='second:entry-1';s.players.p2.space.push(u);});assert.equal(notClear.outcomes.length,1);a14SecondaryCheck(notClear,true,'legal selected defeat without last-space clearance grants no XP');
});
test('A14 Airlock reduces stats with unchanged wounds and requires a distinct actual lethal departure',()=>{
    const cue=a14SecondaryCommon('out-the-airlock');
    const target=cue.transition.after.players.p2.ground.at(-1);assert.deepEqual([target.p,target.h,target.d],[1,2,1]);
    a14SecondaryMutations(cue,[
        ['damage instead of stat reduction',c=>{c.outcomes[0].kind='damage';c.outcomes[0].amount=5;}],
        ['coherent wrong reduction',c=>{c.outcomes[0].amount='-4/-4';const u=c.transition.after.players.p2.ground.at(-1);u.p=2;u.h=3;u.status.at(-1).label='-4/-4 · phase';}],
        ['wound marker erased',c=>c.transition.after.players.p2.ground.at(-1).d=0],
        ['native Overwhelm erased',c=>c.transition.after.players.p2.ground.at(-1).status.shift()],
        ['phase status omitted',c=>c.transition.after.players.p2.ground.at(-1).status.pop()],
        ['old status entry',c=>c.transition.after.players.p2.ground.at(-1).status.at(-1).incarnation='old-entry'],
        ['invented permanent duration',c=>c.outcomes[0].duration='permanent'],
    ]);
    const lethal=a14SecondaryCue('out-the-airlock',undefined,{targetId:'a14:p2:wampa'});assert.equal(lethal.outcomes.length,2);a14SecondaryCheck(lethal,true,'reduced zero HP causes actual owner-directed defeat');
    const missing=structuredClone(lethal);missing.outcomes.pop();a14SecondaryCheck(missing,false,'lethal reduction cannot erase its actual departure receipt');
});

const {batchA14Covers,batchA14IntermediateLayout}=loadTS(path.join(__dirname,'../src/effects/batchA14Signatures.tsx'));
const a14MainAPI=loadTS(path.join(__dirname,'../src/effects/batchA14.ts'));
function a14MainCue(id,changeBefore,choices){const definition=a14MainAPI.A14_DEFINITIONS.find(d=>d.id===id),before=a14MainAPI.a14ShowcaseState(definition);if(changeBefore)changeBefore(before);const cue={definition,seat:'p1',source:a14MainAPI.a14PreviewSource(definition,before,'p1'),target:null,key:'a14:main:gate',playPayment:a14MainAPI.a14PreviewPayment(definition,before,'p1'),outcomes:a14MainAPI.a14PreviewOutcomes(definition,before,'p1',choices)};cue.playCost=loadTS(path.join(__dirname,'../src/effects/previewCosts.ts')).previewPlayCost(definition,before,'p1',cue.playPayment);cue.transition={before,after:resolvePreviewState(before,cue)};return cue;}
function a14MainBoundary(id,stage,changeBefore){const play=a14MainCue(id),before=structuredClone(play.transition.after);if(changeBefore)changeBefore(before);const cue={definition:play.definition,seat:'p1',source:before.players.p1.discard.find(c=>c.id===play.source.id),target:null,key:'a14:boundary:gate',stage,outcomes:(stage==='next-action'?a14MainAPI.a14LaterActionOutcomes:a14MainAPI.a14PhaseEndOutcomes)(play.definition,before,'p1')};cue.transition={before,after:resolvePreviewState(before,cue)};return cue;}
function a14MainCheck(cue,accepted,reason){const g=geometry(cue.outcomes);assert.ok(g.outcomes.length,'exercise actual receipts');for(const item of g.outcomes)assert.equal(batchA14Covers(cue,g,item),accepted,reason);}
function a14MainMutations(cue,mutations){for(const [reason,mutate]of mutations){const wrong=structuredClone(cue);mutate(wrong);a14MainCheck(wrong,false,reason);}}
function a14MainCommon(id){const cue=a14MainCue(id);a14MainCheck(cue,true,'complete primary');a14MainMutations(cue,[
 ['coherent underpayment',c=>{const id=c.playPayment.cardIds.pop();c.playCost--;delete c.transition.after.players.p1.resources.find(r=>r.id===id).x;c.transition.after.players.p1.res.ready++;}],
 ['coherent event identity spoof',c=>{const id=c.source.id;c.definition.name='Different Event';c.source.n='Different Event';for(const state of [c.transition.before,c.transition.after])for(const p of Object.values(state.players))for(const card of [...p.hand,...p.discard])if(card.id===id)card.n='Different Event';for(const o of c.outcomes)if(o.sourceCard?.id===id)o.sourceCard.n='Different Event';}],
 ['coherent regroup play',c=>{c.transition.before.phase='regroup';c.transition.after.phase='regroup';}],
 ['initiative changed',c=>c.transition.after.initiative='p2'],['round changed',c=>c.transition.after.round++],['phase changed',c=>c.transition.after.phase='regroup'],
 ['foreign ending permission',c=>c.transition.after.discardPlayPermissions=[{id:'invented',sourceId:c.source.id,cardId:c.source.id,player:'p1',round:16,phase:'action',fromZone:'discard',discount:2,cardType:'event',aspects:[]}]],
 ['invented payment mode',c=>c.playPayment.smuggle={sourceId:c.source.id,resourcesAfterPayment:c.transition.after.players.p1.resources}],
 ]);for(let i=0;i<cue.outcomes.length;i++)a14MainMutations(cue,[['wrong causing source '+i,c=>c.outcomes[i].sourceCard={...c.outcomes[i].sourceCard,id:'other-source'}],['wrong receipt kind '+i,c=>c.outcomes[i].kind='heal'],['unsupported defeat prerequisite '+i,c=>c.outcomes[i].requiresDefeat={id:'other',incarnation:'entry'}],['unsupported exhaust prerequisite '+i,c=>c.outcomes[i].requiresExhaust={id:'other',incarnation:'entry'}]]);return cue;}
function a14BoundaryCommon(id,stage){const cue=a14MainBoundary(id,stage);a14MainCheck(cue,true,'complete boundary');a14MainMutations(cue,[['repayment invented',c=>c.playCost=0],['payment attached',c=>c.playPayment={kind:'resources',cardIds:[]}],['wrong boundary',c=>c.stage=stage==='next-action'?'phase-end':'next-action'],['coherent stale phase',c=>{c.transition.before.phase='regroup';c.transition.after.phase='regroup';}],['unreceipted initiative',c=>c.transition.after.initiative='p2'],['unreceipted resource use',c=>{c.transition.after.players.p1.resources[19].x=1;c.transition.after.players.p1.res.ready--;}],['resolved source absent',c=>c.transition.before.players.p1.discard=[]]]);for(let i=0;i<cue.outcomes.length;i++)a14MainMutations(cue,[['wrong boundary source '+i,c=>c.outcomes[i].sourceCard={...c.outcomes[i].sourceCard,id:'other-source'}],['prevented success '+i,c=>c.outcomes[i].prevented=true],['unsupported condition '+i,c=>c.outcomes[i].requiresDefeat={id:'other',incarnation:'entry'}]]);return cue;}
test('A14 Manufacturing seals actual draw2 then full current hand selection and exact chosen bottom order',()=>{
 const cue=a14MainCommon('private-manufacturing');assert.equal(JSON.parse(fs.readFileSync(path.join(__dirname,'../../forceteki/test/json/Card/private-manufacturing.json'))).id,'2483520485');assert.equal(batchA14IntermediateLayout(cue).players.p1.hand.length,4);
 a14MainMutations(cue,[['prevented draw',c=>c.outcomes[0].prevented=true],['wrong draw count',c=>c.outcomes[0].amount=1],['short supplied draws',c=>c.outcomes[0].cards.pop()],['drawn face spoof',c=>c.outcomes[0].cards[0].n='Other Face'],['wrong actual top order',c=>c.outcomes[0].cards.reverse()],['return before draws',c=>c.outcomes.unshift(c.outcomes.pop())],['prevented first bottom',c=>c.outcomes[1].prevented=true],['prevented second bottom',c=>c.outcomes[2].prevented=true],['opponent chooser',c=>c.outcomes[1].chooserSeat='p2'],['unknown selection order',c=>delete c.outcomes[1].handBottom],['bottom order differs between receipts',c=>{c.outcomes[2].handBottom=structuredClone(c.outcomes[2].handBottom);c.outcomes[2].handBottom.order.reverse();}],['not actual chronological bottom order',c=>c.outcomes[1].handBottom.order.reverse()],['duplicate selected card',c=>{for(const o of c.outcomes.slice(1))o.handBottom.selectedIds[1]=o.handBottom.selectedIds[0];}],['foreign selected card',c=>c.outcomes[1].card=c.transition.before.players.p2.hand[0]],['event source selected',c=>c.outcomes[1].card=c.source],['top destination instead of bottom',c=>c.outcomes[1].destination='deck-top'],['wrong witnessed draws',c=>c.outcomes[1].handBottom.drawnIds.reverse()],['owned rather than controlled token omission',c=>{const u={id:'controlled-token',n:'Battle Droid',s:null,owner:'p2',t:1,p:1,h:1,d:0,x:1,traits:['separatist','droid','trooper'],printedTitle:'Battle Droid',unique:false,leaderUnit:false,incarnation:'controlled-token:entry'};c.transition.before.players.p1.space.push(u);c.transition.after.players.p1.space.push(u);}],['no actual second bottom receipt',c=>c.outcomes.pop()],['deck permutation fiction',c=>c.transition.after.players.p1.knownDeck.reverse()]]);
 const spoof=structuredClone(cue);for(const state of [spoof.transition.before,spoof.transition.after])state.players.p1.ground[0].t=1;spoof.outcomes=[structuredClone(cue.outcomes[0])];const before=spoof.transition.before.players.p1,after=spoof.transition.after.players.p1;after.hand=before.hand.filter(c=>c.id!==spoof.source.id).concat(before.knownDeck.slice(0,2));after.knownDeck=before.knownDeck.slice(2);after.deck=before.deck-2;a14MainCheck(spoof,false,'printed SOR095 token marker cannot skip mandatory bottom2');
 const reversed=a14MainCue('private-manufacturing',undefined,{bottomIds:['a14:manufacture:draw:1','a14:manufacture:old:0'],bottomOrder:['a14:manufacture:draw:1','a14:manufacture:old:0']});a14MainCheck(reversed,true,'newly drawn selection in reversed real order');
 const token=a14MainCue('private-manufacturing',s=>s.players.p1.space.push({id:'own-token',n:'X-Wing',s:null,owner:'p2',t:1,p:2,h:2,d:0,x:1,traits:['vehicle','fighter'],printedTitle:'X-Wing',unique:false,leaderUnit:false,incarnation:'own-token:entry'}));assert.equal(token.outcomes.length,1);a14MainCheck(token,true,'controlled space token skips bottom clause despite other owner');assert.equal(token.transition.after.players.p1.deck,25);
});
test('A14 No Glory retains same-entry owner through controller waypoint and independent second defeat',()=>{
 const cue=a14MainCommon('no-glory-only-results'),layout=batchA14IntermediateLayout(cue);assert.equal(layout.players.p1.space[1].owner,'p2');assert.equal(layout.players.p2.space.length,0);
 a14MainMutations(cue,[['no transfer receipt',c=>c.outcomes.shift()],['wrong intermediate owner',c=>c.outcomes[0].unit.owner='p1'],['wrong intermediate power',c=>c.outcomes[0].unit.p=7],['wrong intermediate entry',c=>c.outcomes[0].unit.incarnation='new-entry'],['transferred to ground',c=>c.outcomes[0].zone='ground'],['wrong from-controller',c=>c.outcomes[0].fromSeat='p1'],['temporary duration fiction',c=>c.outcomes[0].duration='regroup'],['wrong sequence index',c=>c.outcomes[1].sequenceIndex=1],['different sequence',c=>c.outcomes[1].sequenceId='other'],['old controller defeat attribution',c=>c.outcomes[1].fromSeat='p2'],['controller owns discard fiction',c=>c.outcomes[1].ownerSeat='p1'],['declared prevented takeover with still new-controller defeat',c=>c.outcomes[0].prevented=true],['prevented defeat behind successful ending',c=>c.outcomes[1].prevented=true],['actual leader masquerading as nonleader',c=>{const u=c.transition.before.players.p2.space[0];c.transition.before.players.p2.leader={id:u.id,n:u.n,s:u.s,owner:u.owner,dep:1,x:0};}],['captor cleanup omitted',c=>c.transition.before.players.p2.space[0].cap=[c.transition.before.players.p2.hand[0]]],['attachment cleanup omitted',c=>c.transition.before.players.p2.space[0].u=[{id:'actual-shield',n:'Shield',s:null,owner:'p2',t:1}]]]);
 a14MainCheck(a14MainCue('no-glory-only-results',undefined,{targetId:'a14:p1:xwing'}),true,'already friendly control no-op then actual defeat');
 const blocked=a14MainCue('no-glory-only-results',undefined,{controlPrevented:true});assert.equal(blocked.outcomes[1].fromSeat,'p2');a14MainCheck(blocked,true,'prevented takeover does not cancel independent actual defeat');
});
test('A14 Gate grant is one selected base source-bound phase use without healing or Shield attachment',()=>{
 const cue=a14MainCommon('close-the-shield-gate');a14MainMutations(cue,[['prevented grant',c=>c.outcomes[0].prevented=true],['permanent immunity fiction',c=>c.outcomes[0].duration='permanent'],['wrong descriptor source',c=>c.outcomes[0].baseProtection.effect.sourceId='other'],['wrong base',c=>c.outcomes[0].baseProtection.effect.baseId='other'],['wrong seat',c=>c.outcomes[0].baseProtection.effect.seat='p2'],['wrong round',c=>c.outcomes[0].baseProtection.effect.round++],['wrong phase',c=>c.outcomes[0].baseProtection.effect.phase='regroup'],['reusable protection',c=>c.outcomes[0].baseProtection.effect.uses=2],['unknown use',c=>delete c.outcomes[0].baseProtection.effect.uses],['phantom heal',c=>c.transition.after.players.p1.base.d--],['Shield upgrade fiction',c=>c.outcomes[0].cards=[{id:'shield',n:'Shield',s:null,owner:'p1'}]],['ending protection missing',c=>delete c.transition.after.players.p1.base.damageProtection],['coherent wrong phase seal',c=>{c.outcomes[0].baseProtection.effect.phase='regroup';c.transition.after.players.p1.base.damageProtection[0].phase='regroup';}]]);a14MainCheck(a14MainCue('close-the-shield-gate',undefined,{baseSeat:'p2'}),true,'any base including opponent');
});
test('A14 Covering creates canonical exhausted space X-Wing and Shields only another actual continuing entry',()=>{
 const cue=a14MainCommon('covering-the-wing');assert.deepEqual(JSON.parse(fs.readFileSync(path.join(__dirname,'../../forceteki/test/json/Card/xwing.json'))).traits,['vehicle','fighter']);
 a14MainMutations(cue,[['prevented creation',c=>c.outcomes[0].prevented=true],['ready creation',c=>c.outcomes[0].entersReady=true],['normal play invented',c=>c.outcomes[0].entryType='played'],['wrong token type',c=>c.outcomes[0].tokenType='clone-trooper'],['ground arrival',c=>c.outcomes[0].zone='ground'],['fresh body gains Rebel fiction',c=>c.outcomes[0].unit.traits.push('rebel')],['fresh body gets normal X-Wing HP',c=>c.outcomes[0].unit.h=3],['fresh body reuses entry',c=>c.transition.before.mostRecentIncarnations={[c.outcomes[0].unit.id]:c.outcomes[0].unit.incarnation}],['own existing ID reused',c=>c.outcomes[0].unit.id='a14:p1:xwing'],['inherited phase status',c=>c.outcomes[0].unit.status=[{kind:'keyword',label:'Sentinel',duration:'phase',keyword:{name:'Sentinel',amount:1}}]],['prevented Shield',c=>c.outcomes[1].prevented=true],['created token Shields itself',c=>{c.outcomes[1].card=c.outcomes[0].unit;c.outcomes[1].incarnation=c.outcomes[0].incarnation;}],['wrong other entry',c=>c.outcomes[1].incarnation='old-entry'],['Shield owner guessed',c=>c.outcomes[1].cards[0].owner='p2'],['invented two Shields',c=>c.outcomes[1].amount=2],['missing actual chip',c=>c.outcomes[1].cards=[]],['ending original damaged',c=>c.transition.after.players.p1.space[0].d=1],['new token is shielded despite other target',c=>c.transition.after.players.p1.space[1].u=[{id:'fake',n:'Shield',s:null,owner:'p1',t:1,p:0,h:0}]]]);
 a14MainCheck(a14MainCue('covering-the-wing',undefined,{shieldId:null}),true,'optional Shield declined');a14MainCheck(a14MainCue('covering-the-wing',undefined,{shieldId:'a14:p2:wampa'}),true,'enemy ground other-unit Shield allowed');
});
test('A14 Heat seals every current arena entry, native Sentinel and phase Saboteur loss without altering bodies',()=>{
 const cue=a14MainCommon('in-the-heat-of-battle');a14MainMutations(cue,[['missing final arena',c=>c.outcomes.splice(-2)],['duplicate same unit',c=>{c.outcomes[12]=structuredClone(c.outcomes[0]);c.outcomes[13]=structuredClone(c.outcomes[1]);}],['phase instead of complete window',c=>delete c.outcomes[0].keywordWindow],['new source window',c=>c.outcomes[1].keywordWindow.id='other'],['wrong member current entry',c=>c.outcomes[0].keywordWindow.members[0].incarnation='new-entry'],['false native Sentinel',c=>c.outcomes[0].keywordWindow.members[0].nativeSentinel=true],['native Sentinel missing',c=>delete c.transition.before.players.p1.ground[1].sn],['protected recipient loss omitted',c=>c.outcomes.splice(1,1)],['loss changed to grant',c=>c.outcomes[1].keywordOperation='gain'],['wrong keyword loss',c=>c.outcomes[1].keyword.name='Raid'],['permanent loss',c=>c.outcomes[1].duration='permanent'],['prevented gain',c=>c.outcomes[0].prevented=true],['prevented loss',c=>c.outcomes[1].prevented=true],['stats changed',c=>c.transition.after.players.p1.ground[0].p++],['wounds erased',c=>c.transition.after.players.p1.ground[0].d=0],['unreceipted exhaustion',c=>c.transition.after.players.p1.space[0].x=1],['No Saboteur source missing',c=>c.transition.after.players.p1.ground[0].status[1].keywordWindow.sourceId='other'],['ending suppression permanent',c=>c.transition.after.players.p1.ground[0].status[1].duration='permanent'],['printed Saboteur erased',c=>c.transition.after.players.p1.ground[2].status.shift()],['invented later entrant',c=>c.transition.after.players.p1.space.push({...c.transition.before.players.p1.space[0],id:'later-unit'})]]);
});
test('A14 Gate later attack consumes exactly one actual direct damage protection with no repayment or counterattack',()=>{
 const cue=a14BoundaryCommon('close-the-shield-gate','next-action');a14MainMutations(cue,[['exhausted attacker',c=>c.transition.before.players.p2.space[0].x=1],['wrong current attacker entry',c=>c.outcomes[0].incarnation='new-entry'],['incoming exceeds current power',c=>{c.outcomes[0].amount=3;c.outcomes[2].baseProtection.incoming=3;c.outcomes[2].baseProtection.prevented=3;}],['ground Sentinel incorrectly constrains no source',c=>c.outcomes[0].sourceCard=c.transition.before.players.p2.ground[0]],['wrong protection source',c=>c.outcomes[2].baseProtection.sourceId='other'],['wrong protection ID',c=>c.outcomes[2].baseProtection.effectId='other'],['stale retained phase',c=>c.transition.before.players.p1.base.damageProtection[0].phase='regroup'],['unknown incoming',c=>delete c.outcomes[2].baseProtection.incoming],['zero incoming',c=>{c.outcomes[0].amount=0;c.outcomes[2].baseProtection.incoming=0;c.outcomes[2].baseProtection.prevented=0;}],['false indirect prevention',c=>c.outcomes[2].baseProtection.channel='indirect'],['protection not consumed',c=>c.transition.after.players.p1.base.damageProtection=c.transition.before.players.p1.base.damageProtection],['damage incorrectly applied',c=>c.transition.after.players.p1.base.d+=2],['attacker not exhausted',c=>delete c.transition.after.players.p2.space[0].x],['fake base counterattack',c=>c.outcomes.push({kind:'damage',card:c.transition.before.players.p2.space[0],seat:'p2',zone:'space',sourceCard:c.transition.before.players.p1.base,attackId:c.outcomes[0].attackId,attackIndex:1,damageType:'combat',amount:1})]]);
});
test('A14 Gate phase end removes only an unused current source use while preserving base counters',()=>{
 const cue=a14BoundaryCommon('close-the-shield-gate','phase-end');a14MainMutations(cue,[['missing current use',c=>c.transition.before.players.p1.base.damageProtection=[]],['stale round',c=>c.transition.before.players.p1.base.damageProtection[0].round--],['wrong expiry source',c=>c.outcomes[0].baseProtection.sourceId='other'],['different use expired',c=>c.outcomes[0].baseProtection.effectId='other'],['expiry heals',c=>c.transition.after.players.p1.base.d=0],['expiry readies',c=>c.transition.after.players.p2.resources[9].x=undefined],['expiry instead consumes fabricated damage',c=>c.outcomes[0].baseProtection={operation:'consume',effectId:'a14:gate:protection',sourceId:c.source.id,incoming:2,prevented:2,channel:'direct'}]]);
});
test('A14 Heat explicit phase end removes exact retained gain/loss wrappers and restores only native current-entry keywords',()=>{
 const cue=a14BoundaryCommon('in-the-heat-of-battle','phase-end');assert.equal(cue.transition.after.players.p1.ground[1].sn,1);assert.equal(cue.transition.after.players.p1.ground[2].status[0].keyword.name,'Saboteur');
 a14MainMutations(cue,[['expiry omits space member',c=>c.outcomes.pop()],['expiry duplicates member',c=>c.outcomes[1]=structuredClone(c.outcomes[0])],['retained wrapper permanent',c=>c.transition.before.players.p1.ground[0].status[0].duration='permanent'],['retained wrapper buff',c=>c.transition.before.players.p1.ground[0].status[1].kind='buff'],['retained window cause spoof',c=>c.transition.before.players.p1.ground[0].status[0].keywordWindow.sourceId='other'],['retained mark misses entry',c=>c.transition.before.players.p1.ground[0].status[0].keywordWindow.incarnation='new-entry'],['old entry target reincarnated',c=>c.transition.before.players.p1.ground[0].incarnation='new-entry'],['expiry witness source spoof',c=>c.outcomes[0].keywordWindow.sourceId='other'],['false native restore',c=>c.outcomes[0].keywordWindow.members[0].nativeSentinel=true],['native Sentinel lost',c=>{delete c.outcomes[1].unit.sn;delete c.transition.after.players.p1.ground[1].sn;}],['foreign Sentinel fabricated',c=>{c.outcomes[0].unit.sn=1;c.transition.after.players.p1.ground[0].sn=1;}],['native Saboteur erased',c=>{c.outcomes[2].unit.status=[];c.transition.after.players.p1.ground[2].status=[];}],['wounds erased',c=>{c.outcomes[0].unit.d=0;c.transition.after.players.p1.ground[0].d=0;}],['permanent suppression retained',c=>c.transition.after.players.p1.ground[0].status.push({kind:'keyword',label:'No Saboteur',duration:'permanent',lostKeyword:'Saboteur'})]]);
 const fresh=a14MainBoundary('in-the-heat-of-battle','phase-end',s=>s.players.p1.space.push({id:'later-fresh',n:'X-Wing',s:null,owner:'p1',t:1,p:2,h:2,d:0,x:1,traits:['vehicle','fighter'],printedTitle:'X-Wing',unique:false,leaderUnit:false,incarnation:'later-fresh:entry'}));a14MainCheck(fresh,true,'later entrant untouched and not resurrected or expired');assert.equal(fresh.outcomes.length,7);assert.equal(fresh.transition.after.players.p1.space[1].status,undefined);
});

const { batchA15SecondaryCovers } = loadTS(path.join(__dirname, '../src/effects/batchA15SecondarySignatures.tsx'));
const a15SecondaryAPI = loadTS(path.join(__dirname, '../src/effects/batchA15.ts'));
function a15SecondaryCue(id, changeBefore, choices) {
    const definition=a15SecondaryAPI.A15_DEFINITIONS.find(d=>d.id===id),before=a15SecondaryAPI.a15ShowcaseState(definition);
    if(changeBefore)changeBefore(before);
    const cue={definition,seat:'p1',source:a15SecondaryAPI.a15PreviewSource(definition,before,'p1'),target:null,key:'a15:gate',playPayment:a15SecondaryAPI.a15PreviewPayment(definition,before,'p1',choices),outcomes:a15SecondaryAPI.a15PreviewOutcomes(definition,before,'p1',choices)};
    cue.playCost=loadTS(path.join(__dirname,'../src/effects/previewCosts.ts')).previewPlayCost(definition,before,'p1',cue.playPayment);
    cue.transition={before,after:resolvePreviewState(before,cue)};return cue;
}
function a15SecondaryCheck(cue, accepted, reason) {
    const g=geometry(cue.outcomes);assert.ok(g.outcomes.length,'test must exercise real receipts');
    for(const item of g.outcomes)assert.equal(batchA15SecondaryCovers(cue,g,item),accepted,reason);
}
function a15SecondaryMutations(cue, mutations) {
    for(const [reason,mutate]of mutations){const wrong=structuredClone(cue);mutate(wrong);a15SecondaryCheck(wrong,false,reason);}
}
function a15SecondaryCommon(id) {
    const cue=a15SecondaryCue(id);a15SecondaryCheck(cue,true,'complete primary evidence');
    a15SecondaryMutations(cue,[
        ['different causing source',c=>c.outcomes[0].sourceCard={...c.source,id:'other-event'}],
        ['coherent printed unit misclassified as token',c=>{const targetId=c.outcomes[0].card.id;const visit=v=>{if(!v||typeof v!=='object')return;if(v.id===targetId&&'p' in v)v.t=1;for(const x of Object.values(v))visit(x);};visit(c);for(const p of Object.values(c.transition.after.players))p.discard=p.discard.filter(card=>card.id!==targetId);}],
        ['coherent underpayment',c=>{c.playCost--;const id=c.playPayment.cardIds.pop();delete c.transition.after.players.p1.resources.find(r=>r.id===id).x;c.transition.after.players.p1.res.ready++;}],
        ['coherent illegal regroup play',c=>{c.transition.before.phase='regroup';c.transition.after.phase='regroup';}],
        ['unreceipted initiative',c=>c.transition.after.initiative='p2'],
        ['invented discard permission',c=>c.transition.after.discardPlayPermissions=[{id:'fiction',sourceId:c.source.id,cardId:c.source.id,player:'p1',round:c.transition.before.round,phase:'action',fromZone:'discard',discount:2,cardType:'event',aspects:[]}]],
        ['invented future defeat',c=>c.transition.after.pending=[{id:'fiction',sourceId:c.source.id,targetId:'a15:p1:marine',incarnation:'a15:p1:marine:entry-1',trigger:'regroup-start',kind:'defeat'}]],
        ['prevented receipt',c=>c.outcomes[0].prevented=true],
        ['unestablished exhaustion prerequisite',c=>c.outcomes[0].requiresExhaust={id:'unrelated',incarnation:'entry-1'}],
        ['coherent false canonical title',c=>{const id=c.source.id;c.definition.name='Other Event';c.source.n='Other Event';for(const s of [c.transition.before,c.transition.after])for(const p of Object.values(s.players))for(const card of [...p.hand,...p.discard])if(card.id===id)card.n='Other Event';for(const o of c.outcomes)if(o.sourceCard?.id===id)o.sourceCard.n='Other Event';}],
    ]);
    return cue;
}
test('A15 Nebula proves the full unupgraded set across seats and arenas with real owner departures',()=>{
    const cue=a15SecondaryCommon('nebula-ignition');assert.equal(cue.outcomes.length,4);
    a15SecondaryMutations(cue,[
        ['partial declared battlefield',c=>{for(const o of c.outcomes)o.unupgradedSet.members.pop();}],
        ['old set phase',c=>{for(const o of c.outcomes)o.unupgradedSet.phase='regroup';}],
        ['upgraded unit falsely removed',c=>{const u=c.transition.before.players.p1.ground[0];u.u=[{id:'real-shield',n:'Shield',s:null,owner:'p1',t:1,p:0,h:0}];}],
        ['one arena casualty omitted',c=>c.outcomes.pop()],
        ['owner pile falsified',c=>{const u=c.transition.after.players.p2.discard.pop();c.transition.after.players.p1.discard.push(u);}],
        ['unknown native aura behind unchanged ending',c=>{for(const s of [c.transition.before,c.transition.after]){const u=s.players.p2.ground.find(u=>u.id==='a15:p2:wampa');u.n='Supreme Leader Snoke: Shadow Ruler';u.s='SHD_037';u.printedTitle='Supreme Leader Snoke';}}],
    ]);
});
test('A15 Apology preserves optional XP independent of a prevented first defeat',()=>{
    const cue=a15SecondaryCommon('apology-accepted');
    for(const choices of [{rewardId:null},{firstPrevented:true},{firstPrevented:true,rewardId:'a15:p1:marine'},{rewardId:'a15:p2:wampa'}])a15SecondaryCheck(a15SecondaryCue('apology-accepted',undefined,choices),true,'legal independent optional XP');
    a15SecondaryMutations(cue,[
        ['first is enemy selection',c=>c.outcomes[0].seat='p2'],
        ['unproven success dependency',c=>c.outcomes[1].requiresDefeat={id:c.outcomes[0].card.id,incarnation:c.outcomes[0].incarnation}],
        ['different sequence',c=>c.outcomes[1].sequenceId='unrelated'],
        ['reward reordered',c=>c.outcomes.reverse()],
        ['coherent false XP owner',c=>{for(const x of c.outcomes[1].cards)x.owner='p2';for(const x of c.transition.after.players.p1.ground.find(u=>u.id==='a15:p1:defender').u)x.owner='p2';}],
        ['coherent duplicate XP identity',c=>{c.outcomes[1].cards[1].id=c.outcomes[1].cards[0].id;c.transition.after.players.p1.ground.find(u=>u.id==='a15:p1:defender').u[1].id=c.outcomes[1].cards[0].id;}],
        ['XP wipes wounds',c=>c.transition.after.players.p1.ground.find(u=>u.id==='a15:p1:defender').d=1],
    ]);
});
test('A15 Unity counts printed titles once and grants a fixed phase amount to the complete current set',()=>{
    const cue=a15SecondaryCommon('unity-of-purpose');assert.equal(cue.outcomes[0].distinctTitleBoost.amount,2);assert.equal(cue.outcomes.length,3);
    a15SecondaryMutations(cue,[
        ['full display names counted as three titles',c=>{for(const o of c.outcomes){o.distinctTitleBoost.amount=3;o.amount='+3/+3';}for(const u of [...c.transition.after.players.p1.ground,...c.transition.after.players.p1.space]){u.p++;u.h++;u.status.at(-1).titleBoost.amount=3;u.status.at(-1).label='+3/+3 · phase';}}],
        ['one recipient omitted',c=>c.outcomes.pop()],
        ['witness bound to other entry',c=>{for(const o of c.outcomes)o.distinctTitleBoost.members[0].incarnation='old';}],
        ['canonical subtitle passed as printed title',c=>{const u=c.transition.before.players.p1.space[0];u.printedTitle=u.n;}],
        ['fixed phase status omitted',c=>c.transition.after.players.p1.ground[0].status.pop()],
        ['wounds healed by buff',c=>c.transition.after.players.p1.ground[0].d=0],
        ['permanent duration invented',c=>c.outcomes[0].duration='permanent'],
    ]);
    const before=structuredClone(cue.transition.after),outcomes=a15SecondaryAPI.a15PhaseEndOutcomes(cue.definition,before,'p1'),boundary={definition:cue.definition,source:cue.source,seat:'p1',key:'a15:unity:expiry',stage:'phase-end',outcomes};
    boundary.transition={before,after:resolvePreviewState(before,boundary)};a15SecondaryCheck(boundary,true,'explicit boundary removes only source-bound title grant');
    a15SecondaryMutations(boundary,[
        ['replayed event payment',c=>c.playCost=0],
        ['hidden extra resource readiness',c=>{c.transition.after.players.p1.resources[0].x=undefined;c.transition.after.players.p1.res.ready++;}],
        ['stale current entry',c=>c.outcomes[0].incarnation='old'],
        ['unremoved fixed bonus',c=>c.transition.after.players.p1.ground[0].p++],
        ['early draw',c=>c.transition.after.players.p1.deck--],
    ]);
});
test('A15 All Wings binds fresh X-Wings to distinct successful current friendly space exhaustions',()=>{
    const history=a15SecondaryCue('all-wings-report-in'),old=structuredClone(history);for(const state of [history.transition.before,history.transition.after])state.mostRecentIncarnations={unrelated:'prior-entry'};a15SecondaryCheck(history,true,'unrelated retained history remains legal');const made=old.outcomes.find(o=>o.kind==='create').unit;for(const state of [old.transition.before,old.transition.after])state.mostRecentIncarnations={[made.id]:'different-prior-entry'};a15SecondaryCheck(old,false,'new generated token must never reuse a previously known physical ID');
    const cue=a15SecondaryCommon('all-wings-report-in');assert.equal(cue.outcomes.length,4);
    a15SecondaryCheck(a15SecondaryCue('all-wings-report-in',s=>s.players.p1.space[0].x=1),true,'already exhausted selected unit creates no extra token');
    a15SecondaryCheck(a15SecondaryCue('all-wings-report-in',undefined,{preventedExhaustIds:['a15:p1:xwing']}),true,'prevented exhaustion creates no extra token');
    a15SecondaryMutations(cue,[
        ['recreated old token incarnation',c=>{const u=c.outcomes.find(o=>o.kind==='create').unit;for(const state of [c.transition.before,c.transition.after])state.mostRecentIncarnations={...(state.mostRecentIncarnations??{}),[u.id]:u.incarnation};}],
        ['coherent ready token',c=>{const o=c.outcomes.find(o=>o.kind==='create');o.entersReady=true;delete o.unit.x;delete o.card.x;delete c.transition.after.players.p1.space.find(u=>u.id===o.card.id).x;}],
        ['both creations claim one exhaustion',c=>{const o=c.outcomes.filter(o=>o.kind==='create');o[1].requiresExhaust=o[0].requiresExhaust;}],
        ['foreign selected space unit',c=>c.outcomes[0].seat='p2'],
        ['prevented create',c=>c.outcomes.find(o=>o.kind==='create').prevented=true],
        ['invented Rebel token trait',c=>{const o=c.outcomes.find(o=>o.kind==='create');o.unit.traits.push('rebel');o.card.traits=o.unit.traits;c.transition.after.players.p1.space.find(u=>u.id===o.card.id).traits=o.unit.traits;}],
        ['stale exhaustion entry',c=>c.outcomes.find(o=>o.kind==='create').requiresExhaust.incarnation='old'],
        ['foreign entry omitted from census',c=>{for(const o of c.outcomes)o.spaceExhaustion.members.pop();}],
    ]);
    const none=a15SecondaryCue('all-wings-report-in',undefined,{exhaustIds:[]});assert.equal(none.outcomes.length,0);assert.equal(none.transition.after.players.p1.space.length,2);
});
test('A15 Air Superiority uses a strict complete space census and four ground damage with separate lethal departure',()=>{
    const cue=a15SecondaryCommon('air-superiority');
    a15SecondaryMutations(cue,[
        ['equal current space count',c=>{const u=structuredClone(c.transition.before.players.p2.space[0]);u.id='extra-enemy';u.incarnation='extra:1';c.transition.before.players.p2.space.push(u);c.transition.after.players.p2.space.push(u);}],
        ['invented census member',c=>{for(const o of c.outcomes)o.spaceCensus.own.push({id:'fiction',incarnation:'fiction:1'});}],
        ['strict relation inverted',c=>{for(const o of c.outcomes){const w=o.spaceCensus;o.spaceCensus={...w,own:w.other,other:w.own};}}],
        ['space target',c=>c.outcomes[0].zone='space'],
        ['combat damage invented',c=>c.outcomes[0].damageType='combat'],
        ['coherent three damage',c=>{c.outcomes[0].amount=3;c.outcomes.pop();const before=c.transition.before.players.p2.ground.find(u=>u.id==='a15:p2:wampa');c.transition.after.players.p2.discard=c.transition.after.players.p2.discard.filter(u=>u.id!==before.id);c.transition.after.players.p2.ground.push({...before,d:before.d+3});}],
        ['base also hit',c=>c.transition.after.players.p2.base.d++],
    ]);
    const lethal=a15SecondaryCue('air-superiority',undefined,{targetId:'a15:p2:trooper'});a15SecondaryCheck(lethal,true,'lethal ground damage and actual owner departure');const missing=structuredClone(lethal);missing.outcomes.pop();a15SecondaryCheck(missing,false,'actual defeat cannot disappear from story');
});


test('generic attachment movement renders a recorded unit face and current counters without converting it into an upgrade chip',()=>{
    const React=require('../node_modules/react'),{renderToStaticMarkup}=require('../node_modules/react-dom/server');
    const {OutcomeVisual,outcomeLabel}=loadTS(path.join(__dirname,'../src/effects/primitives.tsx'));
    const body={id:'observed-detach',n:'Determined Recruit',s:'JTL_159',p:3,h:1,d:0,x:1};
    const receipt={kind:'attach',card:body,unit:body,seat:'p1',zone:'ground',fromSeat:'p1',fromZone:'space'};
    const render=outcome=>renderToStaticMarkup(React.createElement(OutcomeVisual,{placed:{outcome,box,from:{...box,w:50,h:14},to:box,key:'observed-detach',slot:0},p:.9}));
    const bodyMarkup=render(receipt);assert.match(bodyMarkup,/ce-card-ghost/);assert.match(bodyMarkup,/>3<\/text>/);assert.match(bodyMarkup,/>1<\/text>/);assert.equal(outcomeLabel(receipt),'ATTACHMENT TO ARENA');
    const transfer={...receipt,unit:undefined,targetCard:{id:'new-host',n:'Host',s:null}};assert.doesNotMatch(render(transfer),/ce-card-ghost/);assert.equal(outcomeLabel(transfer),'UPGRADE REATTACHED');
});

const {batchA15Covers,batchA15IntermediateLayout}=loadTS(path.join(__dirname,'../src/effects/batchA15Signatures.tsx'));
const a15MainAPI=loadTS(path.join(__dirname,'../src/effects/batchA15.ts'));
function a15MainCue(id,changeBefore,choices,changeReceipts){const definition=a15MainAPI.A15_DEFINITIONS.find(d=>d.id===id),before=a15MainAPI.a15ShowcaseState(definition);if(changeBefore)changeBefore(before);const cue={definition,seat:'p1',source:a15MainAPI.a15PreviewSource(definition,before,'p1'),target:null,key:'a15:main:gate',playPayment:a15MainAPI.a15PreviewPayment(definition,before,'p1'),outcomes:a15MainAPI.a15PreviewOutcomes(definition,before,'p1',choices??{})};cue.playCost=loadTS(path.join(__dirname,'../src/effects/previewCosts.ts')).previewPlayCost(definition,before,'p1',cue.playPayment);if(changeReceipts)changeReceipts(cue);cue.transition={before,after:resolvePreviewState(before,cue)};return cue;}
function a15MainBoundary(changeBefore){const play=a15MainCue('scramble-fighters'),before=structuredClone(play.transition.after);if(changeBefore)changeBefore(before);const cue={definition:play.definition,seat:'p1',source:before.players.p1.discard.find(c=>c.id===play.source.id),target:null,key:'a15:phase:gate',stage:'phase-end',outcomes:a15MainAPI.a15PhaseEndOutcomes(play.definition,before,'p1')};cue.transition={before,after:resolvePreviewState(before,cue)};return cue;}
function a15MainCheck(cue,accepted,reason){const g=geometry(cue.outcomes),old=structuredClone(cue);assert.ok(g.outcomes.length,'exercise actual receipts');for(const item of g.outcomes)assert.equal(batchA15Covers(cue,g,item),accepted,reason);assert.deepEqual(cue,old,'proof/coverage cannot alter supplied truth');}
function a15MainMutations(cue,mutations){for(const[reason,mutate]of mutations){const wrong=structuredClone(cue);mutate(wrong);a15MainCheck(wrong,false,reason);}}
function a15MainCommon(id){const cue=a15MainCue(id);a15MainCheck(cue,true,'complete primary');a15MainMutations(cue,[
 ['coherent underpayment',c=>{const paid=c.playPayment.cardIds.pop();if(paid){c.playCost--;delete c.transition.after.players.p1.resources.find(r=>r.id===paid).x;c.transition.after.players.p1.res.ready++;}else c.playCost=-1;}],
 ['missing full payment',c=>delete c.playPayment],['unknown source price',c=>delete c.playCost],['alternate fabricated mode',c=>c.playPayment.smuggle={sourceId:c.source.id,resourcesAfterPayment:c.transition.after.players.p1.resources}],
 ['coherent canonical event spoof',c=>{const id=c.source.id;c.definition.name='Other Event';c.source.n='Other Event';for(const state of[c.transition.before,c.transition.after])for(const p of Object.values(state.players))for(const r of[p.base,...p.hand,...p.discard])if(r.id===id)r.n='Other Event';for(const o of c.outcomes)if(o.sourceCard?.id===id)o.sourceCard.n='Other Event';}],
 ['unobserved new phase',c=>c.transition.after.phase='regroup'],['coherent wrong action phase',c=>{c.transition.before.phase='regroup';c.transition.after.phase='regroup';}],['round changed',c=>c.transition.after.round++],['initiative changed',c=>c.transition.after.initiative='p2'],['missing source hand',c=>c.transition.before.players.p1.hand=[]],['extra physical source',c=>c.transition.before.players.p2.discard.push(c.source)],
 ['coherent printed Marine spoofed as token',c=>{for(const state of[c.transition.before,c.transition.after]){const u=state.players.p1.ground.find(u=>u.s==='SOR_095');if(u)u.t=1;}for(const o of c.outcomes)for(const k of['card','sourceCard'])if(o[k]?.s==='SOR_095')o[k].t=1;}],
 ['foreign ending pending rule',c=>c.transition.after.pending=[{id:'fake',sourceId:c.source.id,targetId:'a15:p1:xwing',incarnation:'a15:p1:xwing:entry-1',trigger:'phase-end',kind:'defeat'}]],['unreceipted base healing',c=>c.transition.after.players.p1.base.d--],['ordinary pose fabricated',c=>c.transition.after.players.p2.ground.find(u=>u.s==='SOR_164').x=1]
 ]);for(let i=0;i<cue.outcomes.length;i++)a15MainMutations(cue,[['wrong cause '+i,c=>c.outcomes[i].sourceCard={...c.outcomes[i].sourceCard,id:'other-source'}],['wrong kind '+i,c=>c.outcomes[i].kind='heal'],['unrelated defeat watcher '+i,c=>c.outcomes[i].requiresDefeat={id:'other',incarnation:'entry'}],['unrelated exhaust watcher '+i,c=>c.outcomes[i].requiresExhaust={id:'other',incarnation:'entry'}]]);return cue;}
function a15MainBody(code,id,owner='p1',extra={}){const files={SOR_212:'strafing-gunship',SOR_237:'alliance-xwing',SOR_225:'tieln-fighter',SOR_032:'scout-bike-pursuer'},f=JSON.parse(fs.readFileSync(path.join(__dirname,'../../forceteki/test/json/Card/'+files[code]+'.json')));return{id,n:f.title,s:code,owner,p:f.power,h:f.hp,d:0,printedTitle:f.title,traits:f.traits,unique:f.unique,leaderUnit:false,incarnation:id+':entry',...extra};}

test('A15 Scramble proves eight canonical fresh ready TIE entries and generated-only source-bound phase restrictions',()=>{
 const oldIdentity=a15MainCue('scramble-fighters',s=>s.mostRecentIncarnations={'a15:scramble:tie:0':'departed-old-entry'});for(const o of oldIdentity.outcomes.filter(o=>o.kind==='create'))oldIdentity.transition.after.mostRecentIncarnations[o.unit.id]=o.unit.incarnation;a15MainCheck(oldIdentity,false,'newly generated token cannot reuse a departed physical identity even with a coherent current-entry ending');
 const unrelatedHistory=a15MainCue('scramble-fighters',s=>s.mostRecentIncarnations={'some-departed-unit':'prior-entry'});a15MainCheck(unrelatedHistory,true,'ordinary unrelated staged incarnation metadata stays unchanged on token creation');
 const cue=a15MainCommon('scramble-fighters'),printed=JSON.parse(fs.readFileSync(path.join(__dirname,'../../forceteki/test/json/Card/tie-fighter.json')));assert.deepEqual([printed.power,printed.hp,printed.traits,printed.types],[1,1,['vehicle','fighter'],['token','unit']]);
 a15MainMutations(cue,[['seven generated entries',c=>{c.outcomes.splice(7,1);c.outcomes.pop();}],['duplicated physical generated ID',c=>c.outcomes[1]=structuredClone(c.outcomes[0])],['pre-existing physical ID',c=>{const o=c.outcomes[0];o.unit.id='a15:p1:xwing';o.card.id=o.unit.id;}],['reused current incarnation',c=>c.transition.before.mostRecentIncarnations={[c.outcomes[0].unit.id]:c.outcomes[0].incarnation}],['stale generated round',c=>c.outcomes[0].generatedSet.round--],['wrong generated source',c=>c.outcomes[0].generatedSet.sourceId='other'],['wrong generated member entry',c=>c.outcomes[0].generatedSet.members[0].incarnation='old-entry'],['Imperial trait fiction',c=>c.outcomes[0].unit.traits.push('imperial')],['false normal printed fighter',c=>{c.outcomes[0].unit.s='SOR_225';c.outcomes[0].unit.n='TIE/ln Fighter';}],['ready flag contradicts exhausted body',c=>c.outcomes[0].unit.x=1],['false exhausted entry flag',c=>c.outcomes[0].entersReady=false],['played instead of generated',c=>c.outcomes[0].entryType='played'],['wrong arena',c=>c.outcomes[0].zone='ground'],['inherited wounds',c=>c.outcomes[0].unit.d=1],['inherited upgrade',c=>c.outcomes[0].unit.u=[{id:'fake',n:'Shield',s:null,t:1,owner:'p1'}]],['token body got 2 power',c=>c.outcomes[0].unit.p=2],['unknown ownership',c=>delete c.outcomes[0].unit.owner],['prevented create but successful ending',c=>c.outcomes[0].prevented=true],['prevented restriction but held mark',c=>c.outcomes[8].prevented=true],['restriction applied to old X-Wing',c=>{c.outcomes[8].card=c.transition.before.players.p1.space[0];c.outcomes[8].incarnation=c.outcomes[8].card.incarnation;}],['permanent restriction',c=>c.outcomes[8].duration='permanent'],['wrong source operation',c=>c.outcomes[8].restrictionOperation='expire'],['missing one restriction',c=>c.outcomes.pop()],['unreceipted original X-Wing restriction',c=>c.transition.after.players.p1.space[0].status=c.transition.after.players.p1.space[1].status],['restriction discarded before completion',c=>c.transition.after.players.p1.space[1].status=[]],['existing unit readied by mistake',c=>{c.transition.before.players.p1.space[0].x=1;delete c.transition.after.players.p1.space[0].x;}]]);
});
test('A15 Scramble explicit phase boundary expires only exact retained current-entry wrappers, preserving later units and pose',()=>{
 const cue=a15MainBoundary();a15MainCheck(cue,true,'exact phase boundary');a15MainMutations(cue,[['clock instead of boundary',c=>delete c.stage],['incorrect later-action stage',c=>c.stage='next-action'],['repaid event',c=>c.playCost=9],['attached even zero payment',c=>c.playPayment={kind:'resources',cardIds:[]}],['current source absent',c=>c.transition.before.players.p1.discard=[]],['different phase end',c=>c.transition.after.phase='regroup'],['one expired entry missing',c=>c.outcomes.pop()],['duplicate expired entry',c=>c.outcomes[1]=structuredClone(c.outcomes[0])],['retained wrapper permanent',c=>c.transition.before.players.p1.space[1].status[0].duration='permanent'],['retained wrapper keyword',c=>c.transition.before.players.p1.space[1].status[0].kind='keyword'],['stale original seal',c=>c.transition.before.players.p1.space[1].status[0].generatedRestriction.round--],['wrong source mark',c=>c.transition.before.players.p1.space[1].status[0].generatedRestriction.sourceId='other'],['wrong retained physical subject',c=>c.transition.before.players.p1.space[1].status[0].generatedRestriction.subjectId='other'],['wrong continuing entry',c=>c.outcomes[0].incarnation='new-entry'],['expire grant instead',c=>c.outcomes[0].restrictionOperation='grant'],['prevented expiry but cleared mark',c=>c.outcomes[0].prevented=true],['expiry changes power',c=>{c.outcomes[0].unit.p=2;c.transition.after.players.p1.space[1].p=2;}],['expiry exhausts ready token',c=>{c.outcomes[0].unit.x=1;c.transition.after.players.p1.space[1].x=1;}],['expiry changes owner',c=>{c.outcomes[0].unit.owner='p2';c.transition.after.players.p1.space[1].owner='p2';}],['expiry restores token into discard',c=>c.transition.after.players.p1.discard.push(c.outcomes[0].card)],['ordinary source changed',c=>c.outcomes[0].sourceCard={...c.source,id:'other'}],['mixed unrelated watcher',c=>c.outcomes[0].requiresDefeat={id:'x',incarnation:'entry'}]]);
 const moved=a15MainBoundary(s=>{const u=s.players.p1.space.splice(1,1)[0];u.x=1;s.players.p2.space.push(u);s.players.p1.space.push({id:'later-tie',n:'TIE Fighter',s:null,t:1,owner:'p1',p:1,h:1,d:0,printedTitle:'TIE Fighter',traits:['vehicle','fighter'],unique:false,leaderUnit:false,incarnation:'later-tie:entry'});});a15MainCheck(moved,true,'changed controller preserves actual owner, later fresh entrant untouched');assert.equal(moved.transition.after.players.p2.space.at(-1).x,1);assert.equal(moved.transition.after.players.p1.space.at(-1).status,undefined);
});
test('A15 Salvage validates separate full unit payment, fresh exhausted play and exact immediate wound before entry triggers',()=>{
 const cue=a15MainCommon('salvage');assert.equal(cue.playCost,0);const f=JSON.parse(fs.readFileSync(path.join(__dirname,'../../forceteki/test/json/Card/alliance-xwing.json')));assert.deepEqual([f.cost,f.aspects],[2,['heroism']]);assert.equal(batchA15IntermediateLayout(cue).players.p1.space.at(-1).d,0);
 a15MainMutations(cue,[['no separate pay',c=>c.outcomes.shift()],['coherent free nested payment',c=>{c.outcomes[0].amount=0;c.outcomes[0].cards=[];c.transition.after.players.p1.resources.forEach(r=>delete r.x);c.transition.after.players.p1.res.ready=20;}],['coherent declared printed cost zero',c=>{for(const o of c.outcomes)o.discardPlayDamage.printedCost=0;c.outcomes[1].printedCost=0;}],['coherent declared no unit aspects',c=>{for(const o of c.outcomes)o.discardPlayDamage.aspects=[];}],['paid duplicate resource',c=>c.outcomes[0].cards[1]=c.outcomes[0].cards[0]],['foreign resource payment',c=>c.outcomes[0].cards[0]=c.transition.before.players.p2.resources[0]],['prevented pay',c=>c.outcomes[0].prevented=true],['prevented play',c=>c.outcomes[1].prevented=true],['prevented wound',c=>c.outcomes[2].prevented=true],['not own discard',c=>c.outcomes[1].fromSeat='p2'],['coherent printed discard card spoofed token',c=>{for(const state of[c.transition.before,c.transition.after])for(const card of state.players.p1.discard)if(card.id==='a15:salvage:xwing')card.t=1;for(const o of c.outcomes)if(o.card?.id==='a15:salvage:xwing')o.card.t=1;}],['rescue fiction',c=>c.outcomes[1].entryType='rescued'],['played free ready',c=>c.outcomes[1].entersReady=true],['unit arrives ready',c=>delete c.outcomes[1].unit.x],['same ID as other existing unit',c=>c.outcomes[1].unit.id='a15:p1:xwing'],['reused old incarnation',c=>c.transition.before.mostRecentIncarnations={[c.outcomes[1].unit.id]:c.outcomes[1].unit.incarnation}],['play wound preapplied',c=>c.outcomes[1].unit.d=1],['wrong arena arrival',c=>c.outcomes[1].zone='ground'],['no actual damage',c=>c.outcomes[2].amount=0],['wrong new entry hit',c=>c.outcomes[2].incarnation='old-entry'],['combat instead of ability',c=>c.outcomes[2].damageType='combat'],['damage before actual play',c=>c.outcomes=[c.outcomes[0],c.outcomes[2],c.outcomes[1]]],['independent group replaced ordered sequence',c=>c.outcomes[1].sequenceIndex=1],['queued native trigger fiction',c=>c.outcomes[2].trigger='combat-damage'],['resting final power boosted',c=>c.transition.after.players.p1.space.at(-1).p++],['received zero wound',c=>c.transition.after.players.p1.space.at(-1).d=0]]);
 const lethal=a15MainCue('salvage',s=>s.players.p1.discard.push({id:'dead-tie',n:'TIE/ln Fighter',s:'SOR_225',owner:'p1'}),{playId:'dead-tie'});a15MainCheck(lethal,true,'paid TIE enters, wound actually defeats it');assert.equal(batchA15IntermediateLayout(lethal).players.p1.space.at(-1).h,1);assert.equal(lethal.outcomes[0].amount,3);assert.ok(!lethal.transition.after.players.p1.space.some(u=>u.id==='dead-tie'));
});
test('A15 Dogfight permits exact exhausted unit attack without readying or bases and retains legal native Gunship combat',()=>{
 const cue=a15MainCommon('dogfight');assert.equal(cue.outcomes[1].amount,0);a15MainMutations(cue,[['fake ready permission before attack',c=>delete c.outcomes[0].exhaustedAttackPermission],['permission wrong event',c=>c.outcomes[0].exhaustedAttackPermission.sourceId='other'],['permission wrong entry',c=>c.outcomes[0].exhaustedAttackPermission.incarnation='old'],['permission wrong attack',c=>c.outcomes[0].exhaustedAttackPermission.attackId='other'],['permission old phase',c=>c.outcomes[0].exhaustedAttackPermission.phase='regroup'],['permission base allowed',c=>c.outcomes[0].exhaustedAttackPermission.unitTargetOnly=false],['already exhausted readied',c=>c.outcomes[1].amount=1],['no forward combat hit',c=>c.outcomes.splice(2,1)],['counterattack omitted',c=>c.outcomes.splice(3,1)],['counterattack from event',c=>c.outcomes[3].sourceCard=c.source],['wrong combat counter',c=>c.outcomes[3].amount=3],['prevented forward hit',c=>c.outcomes[2].prevented=true],['prevented counter',c=>c.outcomes[3].prevented=true],['prevented death',c=>c.outcomes[4].prevented=true],['false base target',c=>{c.outcomes[0].card=c.transition.before.players.p2.base;c.outcomes[0].zone='base';}],['false cross-arena permission',c=>c.outcomes[0].attackArenaPermission='space-to-ground'],['wrong simultaneous order',c=>c.outcomes[0].combatOrder='attacker-first'],['damage own defender',c=>c.outcomes[0].seat='p1'],['defeated controller guessed owner',c=>c.outcomes[4].ownerSeat='p2'],['survivor wound lost',c=>c.transition.after.players.p2.ground.find(u=>u.s==='SOR_164').d=1]]);
 const grit=structuredClone(cue),scout=a15MainBody('SOR_032','native-scout','p2');grit.transition.before.players.p2.ground[1]=scout;grit.outcomes=grit.outcomes.slice(0,4);grit.outcomes[0].card=scout;grit.outcomes[2].card=scout;grit.outcomes[2].incarnation=scout.incarnation;grit.outcomes[3].sourceCard=scout;grit.outcomes[3].amount=1;grit.transition.after.players.p1.ground=[{...grit.transition.before.players.p1.ground[0],d:1},grit.transition.before.players.p1.ground[1]];grit.transition.after.players.p1.discard=[grit.source];grit.transition.after.players.p2.ground[1]={...scout,d:3};a15MainCheck(grit,false,'native Grit survivor cannot retain stale printed power despite internally consistent damage receipts');
 const ready=a15MainCue('dogfight',s=>delete s.players.p1.ground[0].x);a15MainCheck(ready,true,'ordinary ready attacker is legal too');
 const cross=a15MainCue('dogfight',s=>s.players.p1.space.push(a15MainBody('SOR_212','gunship','p1',{x:1})),{attackerId:'gunship'});a15MainCheck(cross,true,'native exhausted space Gunship attacks ground and defender counter is -2');assert.equal(cross.outcomes[0].amount,'-2/-0');a15MainMutations(cross,[['missing native defending reduction',c=>c.outcomes.shift()],['wrong defending modifier source',c=>c.outcomes[0].sourceCard=c.outcomes[1].sourceCard],['wrong native reduced counter',c=>c.outcomes.find(o=>o.kind==='damage'&&o.seat==='p1').amount=4]]);
});
test('A15 Tandem completes actual space combat before ground attack with second-only +2 and no resting bonus',()=>{
 const cue=a15MainCommon('tandem-assault');assert.equal(batchA15IntermediateLayout(cue).players.p1.space[0].d,2);assert.equal(batchA15IntermediateLayout(cue).players.p2.space.length,0);
 a15MainMutations(cue,[['first hit missing',c=>c.outcomes.splice(2,1)],['second before first complete',c=>c.outcomes=[...c.outcomes.filter(o=>o.sequenceIndex===2),...c.outcomes.filter(o=>o.sequenceIndex===1)]],['missing second attack',c=>c.outcomes=c.outcomes.filter(o=>o.sequenceIndex===1)],['first attack ground',c=>c.outcomes[0].sourceCard=c.transition.before.players.p1.ground[1]],['unearned second prerequisite',c=>c.outcomes[5].requiresAttack.attackId='other'],['first entry wrong',c=>c.outcomes[5].requiresAttack.incarnation='old'],['prerequisite requires ground',c=>c.outcomes[5].requiresAttack.arena='ground'],['second exact +2 not applied',c=>c.outcomes[5].amount='+1/+0'],['permanent second bonus',c=>c.outcomes[5].duration='permanent'],['second bonus on defender',c=>c.outcomes[5].attackRole='defender'],['bonus has different attack ID',c=>c.outcomes[5].attackId='other'],['prevented second buff',c=>c.outcomes[5].prevented=true],['shared attack ID',c=>c.outcomes.filter(o=>o.sequenceIndex===2).forEach(o=>o.attackId=c.outcomes[0].attackId)],['wrong second current entry',c=>c.outcomes[6].incarnation='old'],['first gets second amount',c=>c.outcomes[0].amount=4],['second damage not boosted',c=>c.outcomes[8].amount=4],['ground first ready flash',c=>c.outcomes[7].amount=0],['wrong controller counter',c=>c.outcomes[9].sourceCard=c.source],['different sequence cause',c=>c.outcomes[6].sequenceId='other'],['missing second discard',c=>c.transition.after.players.p1.discard.pop()]]);
 const base=a15MainCue('tandem-assault',null,{firstTargetId:'base',secondTargetId:'base'});a15MainCheck(base,true,'normal base attacks 2 then 6, resting Defender 4');assert.equal(base.transition.after.players.p2.base.d,14);assert.equal(base.transition.after.players.p1.ground[1].p,4);a15MainMutations(base,[['coherent permanent resting +2',c=>c.transition.after.players.p1.ground[1].p=6],['unsupported retained base protection ignored',c=>{for(const state of[c.transition.before,c.transition.after])state.players.p2.base.damageProtection=[{id:'actual-protection',sourceId:'another-event',baseId:state.players.p2.base.id,seat:'p2',round:17,phase:'action',uses:1}];}]]);
 const fallen=a15MainCue('tandem-assault',s=>s.players.p1.space[0].d=2);a15MainCheck(fallen,true,'actual first attacker may die before valid second attack');assert.ok(!batchA15IntermediateLayout(fallen).players.p1.space.length);
 const firstOnly=a15MainCue('tandem-assault',s=>s.players.p1.ground.forEach(u=>u.x=1));a15MainCheck(firstOnly,true,'no current ready ground attacker means actual first attack only');
});
test('A15 Eject proves exact actual Pilot detach, owner versus controller, retained Training and independent private draw',()=>{
 const cue=a15MainCommon('eject');a15MainMutations(cue,[['simultaneous group missing',c=>delete c.outcomes[0].resolutionGroup],['draw bound to another group',c=>c.outcomes[1].resolutionGroup={id:'other',mode:'simultaneous'}],['unknown grouping mode',c=>c.outcomes[1].resolutionGroup.mode='sequential'],['not actual current host',c=>c.outcomes[0].pilotDetach.hostId='other'],['stale host incarnation',c=>c.outcomes[0].pilotDetach.hostIncarnation='old'],['unknown attachment ID',c=>c.outcomes[0].pilotDetach.upgradeId='other'],['Pilot classification omitted',c=>delete c.transition.before.players.p1.space[0].u[0].unitUpgrade],['nonPilot spoofed as eligible',c=>c.transition.before.players.p1.space[0].u[1].unitUpgrade=true],['Pilot trait omitted',c=>c.transition.before.players.p1.space[0].u[0].traits=[]],['printed Pilot spoofed token',c=>c.transition.before.players.p1.space[0].u[0].t=1],['wrong actual contribution',c=>c.transition.before.players.p1.space[0].u[0].p=4],['controller guessed owner',c=>c.outcomes[0].controllerSeat='p2'],['owner guessed controller',c=>c.outcomes[0].ownerSeat='p2'],['normal play invented',c=>c.outcomes[0].entryType='played'],['whenplayed fictional extra',c=>c.outcomes[0].attackOrigin={kind:'ambush',playedId:c.outcomes[0].unit.id,incarnation:c.outcomes[0].unit.incarnation}],['fresh body is ready',c=>delete c.outcomes[0].unit.x],['ground changed to space',c=>c.outcomes[0].zone='space'],['fresh wounds inherited',c=>c.outcomes[0].unit.d=1],['fresh unit wrong physical ID',c=>c.outcomes[0].unit.id='different-card'],['Pilot body got attachment bonus',c=>c.outcomes[0].unit.p=5],['old unit entry reused',c=>c.transition.before.mostRecentIncarnations={[c.outcomes[0].unit.id]:c.outcomes[0].unit.incarnation}],['Training wrongly consumed',c=>c.transition.after.players.p1.space[0].u=[]],['host wounds reset',c=>c.transition.after.players.p1.space[0].d=0],['host readied illegally',c=>{c.transition.before.players.p1.space[0].x=1;delete c.transition.after.players.p1.space[0].x;}],['host wrong remaining power',c=>c.transition.after.players.p1.space[0].p=2],['Pilot sent to discard',c=>c.transition.after.players.p1.discard.push(c.outcomes[0].card)],['prevented draw behind hand ending',c=>c.outcomes[1].prevented=true],['two actual draws',c=>c.outcomes[1].amount=2],['draw wrong actual top',c=>c.transition.before.players.p1.knownDeck.reverse()],['coherent wrong top name',c=>{const id=c.outcomes[1].card.id;for(const s of[c.transition.before,c.transition.after])for(const c of[...s.players.p1.hand,...s.players.p1.knownDeck])if(c.id===id)c.n='Different Card';c.outcomes[1].card.n='Different Card';c.outcomes[1].cards[0].n='Different Card';}],['wrong draw owner',c=>c.outcomes[1].cards[0].owner='p2'],['required eligible Pilot silently skipped',c=>{c.outcomes.shift();c.transition.after.players.p1.ground.pop();c.transition.after.players.p1.space[0]=structuredClone(c.transition.before.players.p1.space[0]);}]]);
 a15MainCheck(a15MainCue('eject',s=>s.players.p1.space[0].u[0].owner='p2'),true,'stolen Pilot owner preserved under P1 controller');a15MainCheck(a15MainCue('eject',s=>{const h=s.players.p1.space.pop();h.u.forEach(u=>u.controller='p2');s.players.p2.space.push(h);}),true,'actual P2 controller keeps Pilot ground while P1 independently draws');
 const prevented=a15MainCue('eject',null,null,c=>c.outcomes[0].prevented=true);a15MainCheck(prevented,true,'proved prevented detach retains Pilot and host, draw independent');
 const noPilot=a15MainCue('eject',s=>{const h=s.players.p1.space[0],a=h.u.shift();h.p-=a.p;h.h-=a.h;s.players.p1.discard.push({id:a.id,n:a.n,s:a.s,owner:a.owner});},{pilotId:null});a15MainCheck(noPilot,true,'actual no eligible Pilot still draws');
 const raid=a15MainCue('eject',s=>{const h=s.players.p1.space[0],a=h.u[0];Object.assign(a,{n:'Independent Smuggler',s:'JTL_211',p:1,h:1,traits:['underworld','pilot']});h.p=5;h.status=[{kind:'keyword',label:'Raid 1 (Pilot)',duration:'permanent',keyword:{name:'Raid',amount:1},attachmentId:a.id}];});a15MainCheck(raid,true,'only host attachment Raid ends; Pilot printed Raid stays');assert.equal(raid.transition.after.players.p1.ground.at(-1).status[0].keyword.name,'Raid');
});


const { batchA16SecondaryCovers } = loadTS(path.join(__dirname, '../src/effects/batchA16SecondarySignatures.tsx'));
const a16SecondaryAPI = loadTS(path.join(__dirname, '../src/effects/batchA16.ts'));
function a16SecondaryCue(id, changeBefore, choices) {
    const definition=a16SecondaryAPI.A16_DEFINITIONS.find(d=>d.id===id),before=a16SecondaryAPI.a16ShowcaseState(definition);
    if(changeBefore)changeBefore(before);
    const cue={definition,seat:'p1',source:a16SecondaryAPI.a16PreviewSource(definition,before,'p1'),target:null,key:'a16:gate',playPayment:a16SecondaryAPI.a16PreviewPayment(definition,before,'p1',choices),outcomes:a16SecondaryAPI.a16PreviewOutcomes(definition,before,'p1',choices)};
    cue.playCost=loadTS(path.join(__dirname,'../src/effects/previewCosts.ts')).previewPlayCost(definition,before,'p1',cue.playPayment);
    cue.transition={before,after:resolvePreviewState(before,cue)};return cue;
}
function a16SecondaryCheck(cue, accepted, reason) {
    const g=geometry(cue.outcomes);assert.ok(g.outcomes.length,'test must exercise receipts');
    for(const item of g.outcomes)assert.equal(batchA16SecondaryCovers(cue,g,item),accepted,reason);
}
function a16SecondaryMutations(cue, mutations) {for(const[reason,mutate]of mutations){const wrong=structuredClone(cue);mutate(wrong);a16SecondaryCheck(wrong,false,reason);}}
function a16SecondaryCommon(id) {
    const cue=a16SecondaryCue(id);a16SecondaryCheck(cue,true,'complete primary evidence');
    a16SecondaryMutations(cue,[
        ['unrelated actual damage/search source',c=>c.outcomes[0].sourceCard={...c.outcomes[0].sourceCard,id:'other'}],
        ['coherent printed event source claimed as token',c=>{const id=c.source.id;const visit=v=>{if(!v||typeof v!=='object')return;if(v.id===id)v.t=1;for(const x of Object.values(v))visit(x);};visit(c);}],
        ['coherent underpayment',c=>{c.playCost--;const id=c.playPayment.cardIds.pop();delete c.transition.after.players.p1.resources.find(r=>r.id===id).x;c.transition.after.players.p1.res.ready++;}],
        ['coherent illegal regroup play',c=>{c.transition.before.phase='regroup';c.transition.after.phase='regroup';}],
        ['unreceipted initiative change',c=>c.transition.after.initiative='p2'],
        ['invented pending departure',c=>c.transition.after.pending=[{id:'fiction',sourceId:c.source.id,targetId:'a16:p1:marine',incarnation:'a16:p1:marine:entry-1',trigger:'regroup-start',kind:'defeat'}]],
        ['explicit prevention behind success',c=>c.outcomes[0].prevented=true],
        ['unsupported attack prerequisite',c=>c.outcomes[0].requiresExhaust={id:'unrelated',incarnation:'entry'}],
        ['coherent printed body claimed as token',c=>{const id='a16:p1:marine';const visit=v=>{if(!v||typeof v!=='object')return;if(v.id===id&&'p'in v)v.t=1;for(const x of Object.values(v))visit(x);};visit(c);}],
        ['unreceipted ready',c=>c.transition.after.players.p2.resources[9].x=undefined],
    ]);return cue;
}
test('A16 Takeoff proves private exact top-eight and canonical Vehicle selection before witnessed random bottom',()=>{
    const cue=a16SecondaryCommon('prepare-for-takeoff');
    a16SecondaryMutations(cue,[
        ['coherent selected printed card spoofed token',c=>{const id=c.outcomes[0].deckOperation.selectedIds[0];const visit=v=>{if(!v||typeof v!=='object')return;if(v.id===id)v.t=1;for(const x of Object.values(v))visit(x);};visit(c);}],
        ['coherent unselected deck card spoofed token',c=>{const id=c.outcomes[0].deckOperation.looked[1].id;const visit=v=>{if(!v||typeof v!=='object')return;if(v.id===id)v.t=1;for(const x of Object.values(v))visit(x);};visit(c);}],
        ['selected non-Vehicle with coherent draw/ending',c=>{const op=c.outcomes[0].deckOperation,marine=op.looked[1],old=op.selectedIds[0];op.selectedIds[0]=marine.id;op.revealedIds[0]=marine.id;const swap=xs=>xs.map(x=>x.id===old?marine:x.id===marine.id?op.looked[0]:x);op.remainingOrder=swap(op.remainingOrder);c.outcomes[1].cards=swap(c.outcomes[1].cards);c.transition.after.players.p1.hand=swap(c.transition.after.players.p1.hand);c.transition.after.players.p1.knownDeck=swap(c.transition.after.players.p1.knownDeck);}],
        ['public inspected fan',c=>c.outcomes[0].visibility='public'],['whole deck claim',c=>c.outcomes[0].deckOperation.scope='deck'],['invented random selection',c=>c.outcomes[0].selection='random'],
        ['unselected reveal',c=>c.outcomes[0].deckOperation.revealedIds.push(c.outcomes[0].cards[1].id)],['duplicate bottom identity',c=>{const a=c.outcomes[0].deckOperation.remainingOrder;a[a.length-1]=a[a.length-2];}],
        ['uninspected replacement',c=>c.outcomes[0].cards[0].id='outside'],['drop untouched deck suffix',c=>c.transition.after.players.p1.knownDeck.splice(2,1)],
    ]);
    const one=a16SecondaryCue('prepare-for-takeoff',null,{selectedIds:['a16:takeoff:look:0']});a16SecondaryCheck(one,true,'one Vehicle is legal');
    const zero=a16SecondaryCue('prepare-for-takeoff',null,{selectedIds:[]});a16SecondaryCheck(zero,true,'zero selection retains complete random bottom');
    const short=a16SecondaryCue('prepare-for-takeoff',s=>{s.players.p1.knownDeck=s.players.p1.knownDeck.slice(0,3);s.players.p1.deck=3;});a16SecondaryCheck(short,true,'short actual deck');
});
test('A16 Focus seals every current friendly Vehicle source including exhausted sources and distinguishes ability damage',()=>{
    const cue=a16SecondaryCommon('focus-fire');
    a16SecondaryMutations(cue,[
        ['coherent omitted exhausted Vehicle source',c=>{const gone=c.outcomes.splice(1,1)[0].sourceCard;c.outcomes[0].vehicleSources.members=c.outcomes[0].vehicleSources.members.filter(x=>x.id!==gone.id);c.outcomes=c.outcomes.filter(o=>o.kind!=='defeat');const u=structuredClone(c.transition.before.players.p2.space[0]);u.d=2;c.transition.after.players.p2.space=[u];c.transition.after.players.p2.discard=[];}],
        ['unit damage misattributed to event',c=>c.outcomes[0].sourceCard=c.source],['wrong causing event',c=>c.outcomes[0].causeCard={...c.source,id:'other'}],['combat substituted',c=>c.outcomes[0].damageType='combat'],['sequential window',c=>c.outcomes[0].resolutionGroup.mode='sequence'],
        ['source changed exhaustion',c=>c.transition.after.players.p1.space[0].x=1],['positive mark without real incoming',c=>c.outcomes[0].damageAttempt.incoming=0],['duplicate source census',c=>c.outcomes[0].vehicleSources.members[1]=c.outcomes[0].vehicleSources.members[0]],
    ]);
});
test('A16 Salvo seals selected opponent arena membership and one current own space damage source',()=>{
    const cue=a16SecondaryCommon('turbolaser-salvo');
    a16SecondaryMutations(cue,[
        ['coherent omitted surviving target',c=>{c.outcomes.splice(1,1);c.outcomes[0].arenaSalvo.members.pop();c.transition.after.players.p2.ground[0].d=1;}],
        ['wrong arena',c=>c.outcomes[0].arenaSalvo.arena='space'],['wrong opponent',c=>c.outcomes[0].arenaSalvo.opponent='p1'],['false current source power',c=>c.outcomes[0].arenaSalvo.power=3],['after readies source',c=>c.transition.after.players.p1.space[0].x=1],
        ['survivor HP debuffed rather than wounded',c=>{const u=c.transition.after.players.p2.ground[0];u.h-=2;u.d-=2;}],['actual target omitted from defeat',c=>c.outcomes.pop()],['defeat redirected owner',c=>c.outcomes[2].ownerSeat='p1'],
    ]);
});
test('A16 No Disintegrations derives damage from remaining HP and preserves maximum HP and native state',()=>{
    const cue=a16SecondaryCommon('no-disintegrations');
    a16SecondaryMutations(cue,[
        ['printed HP shortcut with coherent wounds',c=>{c.outcomes[0].amount=4;c.outcomes[0].damageAttempt.incoming=4;c.outcomes[0].remainingHpDamage.computed=4;c.transition.after.players.p2.ground[1].d=5;}],
        ['coherent maxHP reduction',c=>{const u=c.transition.after.players.p2.ground[1];u.d=1;u.h=2;}],['fabricated wounds basis',c=>c.outcomes[0].remainingHpDamage.wounds=0],['leader target claim',c=>c.outcomes[0].card.leaderUnit=true],['native keyword removed',c=>c.transition.after.players.p2.ground[1].status=[]],
    ]);
    const one=a16SecondaryCue('no-disintegrations',s=>s.players.p2.ground[1].d=4);a16SecondaryCheck(one,true,'one HP means zero actual damage');assert.equal(one.outcomes[0].amount,0);
    const friendly=a16SecondaryCue('no-disintegrations',null,{targetId:'a16:p1:marine'});a16SecondaryCheck(friendly,true,'friendly nonleader is legal');
});
test('A16 Fight requires actual opposing same-arena pair with independent simultaneous three-damage results',()=>{
    const cue=a16SecondaryCommon('fight-fire-with-fire');
    a16SecondaryMutations(cue,[
        ['one-sided pair with coherent untouched enemy',c=>{c.outcomes.splice(1,1);c.transition.after.players.p2.ground[1].d=1;}],['combat receipt',c=>c.outcomes[1].damageType='combat'],['counterdamage sequence',c=>c.outcomes[1].resolutionGroup={id:'later',mode:'simultaneous'}],
        ['cross-arena pair',c=>c.outcomes[0].pairedDamage.arena='space'],['copied target',c=>c.outcomes[1]=structuredClone(c.outcomes[0])],['false friendly controller',c=>c.outcomes[0].pairedDamage.friendly=c.outcomes[0].pairedDamage.enemy],['native power invented',c=>c.transition.after.players.p2.ground[1].p=7],['immediate survivor defeat',c=>c.transition.after.players.p2.ground.pop()],
    ]);
});

const {batchA16Covers,batchA16IntermediateLayout}=loadTS(path.join(__dirname,'../src/effects/batchA16Signatures.tsx'));
const a16MainAPI=loadTS(path.join(__dirname,'../src/effects/batchA16.ts'));
function a16MainCue(id,changeBefore,choices){const definition=a16MainAPI.A16_DEFINITIONS.find(d=>d.id===id),before=a16MainAPI.a16ShowcaseState(definition);if(changeBefore)changeBefore(before);const cue={definition,seat:'p1',source:a16MainAPI.a16PreviewSource(definition,before,'p1'),target:null,key:'a16:main:gate',playPayment:a16MainAPI.a16PreviewPayment(definition,before,'p1'),outcomes:a16MainAPI.a16PreviewOutcomes(definition,before,'p1',choices??{})};cue.playCost=loadTS(path.join(__dirname,'../src/effects/previewCosts.ts')).previewPlayCost(definition,before,'p1',cue.playPayment);cue.transition={before,after:resolvePreviewState(before,cue)};return cue;}
function a16MainBoundary(changeBefore){const play=a16MainCue('timely-reinforcements'),before=structuredClone(play.transition.after);if(changeBefore)changeBefore(before);const cue={definition:play.definition,seat:'p1',source:before.players.p1.discard.find(c=>c.id===play.source.id),target:null,key:'a16:phase:gate',stage:'phase-end',outcomes:a16MainAPI.a16PhaseEndOutcomes(play.definition,before,'p1')};cue.transition={before,after:resolvePreviewState(before,cue)};return cue;}
function a16MainCheck(cue,accepted,reason){const g=geometry(cue.outcomes),old=structuredClone(cue);assert.ok(g.outcomes.length,'exercise witnessed receipts');for(const item of g.outcomes)assert.equal(batchA16Covers(cue,g,item),accepted,reason);assert.deepEqual(cue,old,'rich proof cannot alter supplied before/after');}
function a16MainMutations(cue,mutations){for(const[reason,mutate]of mutations){const wrong=structuredClone(cue);mutate(wrong);a16MainCheck(wrong,false,reason);}}
function a16MainCommon(id){const cue=a16MainCue(id);a16MainCheck(cue,true,'complete canonical paid primary');a16MainMutations(cue,[
 ['coherent event underpayment',c=>{const removed=c.playPayment.cardIds.pop();c.playCost--;delete c.transition.after.players.p1.resources.find(r=>r.id===removed).x;c.transition.after.players.p1.res.ready++;}],['missing event payment',c=>delete c.playPayment],['unknown event price',c=>delete c.playCost],['duplicate paid resource',c=>c.playPayment.cardIds[1]=c.playPayment.cardIds[0]],['alternate fabricated Smuggle',c=>c.playPayment.smuggle={sourceId:c.source.id,resourcesAfterPayment:c.transition.after.players.p1.resources}],['coherent canonical event spoof',c=>{const id=c.source.id;c.definition.name='Other Event';c.source.n='Other Event';for(const state of[c.transition.before,c.transition.after])for(const p of Object.values(state.players))for(const r of[p.base,...p.hand,...p.discard])if(r.id===id)r.n='Other Event';for(const o of c.outcomes)for(const k of['sourceCard','causeCard'])if(o[k]?.id===id)o[k].n='Other Event';}],['printed event spoofed token',c=>c.source.t=1],['wrong print face',c=>c.source.s='JTL_128'],['coherent illegal regroup',c=>{c.transition.before.phase='regroup';c.transition.after.phase='regroup';}],['unobserved phase change',c=>c.transition.after.phase='regroup'],['round changed',c=>c.transition.after.round++],['initiative changed',c=>c.transition.after.initiative='p2'],['source absent',c=>c.transition.before.players.p1.hand=c.transition.before.players.p1.hand.filter(x=>x.id!==c.source.id)],['duplicate source physical ID',c=>c.transition.before.players.p2.discard.push(c.source)],['coherent printed Marine spoofed token',c=>{for(const state of[c.transition.before,c.transition.after]){const u=state.players.p1.ground.find(x=>x.s==='SOR_095');if(u)u.t=1;}for(const o of c.outcomes)for(const k of['card','sourceCard'])if(o[k]?.s==='SOR_095')o[k].t=1;}],['unreceipted base healing',c=>c.transition.after.players.p1.base.d--],['foreign pending rule',c=>c.transition.after.pending=[{id:'fake',sourceId:c.source.id,targetId:'a16:p1:xwing',incarnation:'a16:p1:xwing:entry-1',trigger:'phase-end',kind:'defeat'}]],['unreceipted ordinary readying',c=>c.transition.after.players.p2.ground[0].x=1]
 ]);for(let i=0;i<cue.outcomes.length;i++)a16MainMutations(cue,[['wrong source '+i,c=>c.outcomes[i].sourceCard={...c.outcomes[i].sourceCard,id:'foreign-source'}],['wrong kind '+i,c=>c.outcomes[i].kind='heal'],['unrelated defeat condition '+i,c=>c.outcomes[i].requiresDefeat={id:'other',incarnation:'entry'}],['unrelated exhaust condition '+i,c=>c.outcomes[i].requiresExhaust={id:'other',incarnation:'entry'}],['unsupported prevented success '+i,c=>c.outcomes[i].prevented=true]]);return cue;}
function a16MainBody(code,id,owner='p1',extra={}){const names={SOR_237:'alliance-xwing',SOR_225:'tieln-fighter',SOR_232:'atst',SHD_187:'lurking-tie-phantom'},f=JSON.parse(fs.readFileSync(path.join(__dirname,'../../forceteki/test/json/Card/'+names[code]+'.json')));return{id,n:f.title,s:code,owner,p:f.power,h:f.hp,d:0,printedTitle:f.title,traits:f.traits,unique:f.unique,leaderUnit:false,incarnation:id+':entry',onAttackAbilities:[],...(f.keywords.includes('overwhelm')?{status:[{kind:'keyword',label:'Overwhelm (printed)',duration:'permanent',keyword:{name:'Overwhelm',amount:1}}]}:{}),...extra};}
function a16MainShield(s,id){const u=[...s.players.p1.ground,...s.players.p1.space,...s.players.p2.ground,...s.players.p2.space].find(u=>u.id===id);u.u=[{id:id+':shield',n:'Shield',s:null,owner:u.owner,t:1}];}
function a16MainToken(s,id){return{id,n:'X-Wing',s:null,t:1,owner:'p1',p:2,h:2,d:0,x:1,printedTitle:'X-Wing',traits:['vehicle','fighter'],unique:false,leaderUnit:false,incarnation:id+':entry',onAttackAbilities:[]};}

test('A16 Lightspeed binds last powers, real sacrifice/direct attempt, distinct opponent-assigned unpreventable indirect after resolution',()=>{
 const cue=a16MainCommon('lightspeed-assault');const f=JSON.parse(fs.readFileSync(path.join(__dirname,'../../forceteki/test/json/Card/lightspeed-assault.json')));assert.deepEqual([f.id,f.cost,f.aspects],['8606123385',2,['command']]);
 a16MainMutations(cue,[['missing actual sacrifice',c=>c.outcomes.shift()],['direct before sacrifice',c=>[c.outcomes[0],c.outcomes[1]]=[c.outcomes[1],c.outcomes[0]]],['sealed friendly current power fiction',c=>c.outcomes[0].lightspeed.friendly.power=3],['sealed enemy incarnation old',c=>c.outcomes[1].lightspeed.enemy.incarnation='old'],['missing resolved-clause witness',c=>delete c.outcomes.at(-1).lightspeed.condition],['direct combat fiction',c=>c.outcomes[1].damageType='combat'],['incoming last power wrong',c=>c.outcomes[1].damageAttempt.incoming=3],['enemy defeat absent',c=>c.outcomes.splice(2,1)],['indirect before enemy cleanup',c=>[c.outcomes[2],c.outcomes[3]]=[c.outcomes[3],c.outcomes[2]]],['coherent retained active base protection needs actual consume evidence',c=>{for(const state of[c.transition.before,c.transition.after])state.players.p2.base.damageProtection=[{id:'actual-prior-gate',sourceId:'previous-close-gate',baseId:state.players.p2.base.id,seat:'p2',round:state.round,phase:state.phase,uses:1}];}],['controller choice lost',c=>c.outcomes.at(-1).chooserSeat='p1'],['indirect preventable',c=>delete c.outcomes.at(-1).unpreventable],['indirect total wrong',c=>c.outcomes.at(-1).indirectAllocation.total=3],['duplicate allocation members',c=>c.outcomes.at(-1).indirectAllocation.members.push(c.outcomes.at(-1).indirectAllocation.members[0])],['defeated enemy selected as surviving indirect recipient',c=>c.outcomes.at(-1).indirectAllocation.members=[{id:'a16:p2:tie',incarnation:'a16:p2:tie:entry-1',amount:2}]],['source exhausted by ability fiction',c=>c.outcomes[1].attackId='invented-attack'],['owner discard wrong',c=>c.outcomes[0].ownerSeat='p2'],['friendly removed but not discarded',c=>c.transition.after.players.p1.discard.pop()],['coherent changed current source power',c=>{c.transition.before.players.p1.space[0].p=3;c.outcomes[0].card.p=3;c.outcomes[0].lightspeed.friendly.power=3;}] ]);
 const shield=a16MainCue('lightspeed-assault',s=>a16MainShield(s,'a16:p2:tie'));a16MainCheck(shield,true,'real Shield prevention still permits indirect');assert.equal(shield.outcomes.find(o=>o.kind==='damage').amount,0);assert.equal(shield.transition.after.players.p2.base.d,8);assert.equal(shield.transition.after.players.p2.space[0].u.length,0);a16MainMutations(shield,[['prevented direct used to omit indirect',c=>c.outcomes.pop()],['Shield not actually consumed',c=>c.transition.after.players.p2.space[0].u=structuredClone(c.transition.before.players.p2.space[0].u)],['pretended positive shielded direct',c=>{const h=c.outcomes.find(o=>o.kind==='damage');h.amount=2;delete h.prevented;}]]);
 const immunity=a16MainCue('lightspeed-assault',s=>s.players.p2.space=[a16MainBody('SHD_187','a16:p2:tie','p2')],{indirect:[{id:'a16:p2:tie',amount:1},{id:'a16:p2:base',amount:1}]});a16MainCheck(immunity,true,'native prevention independent of resolved indirect');assert.equal(immunity.transition.after.players.p2.space[0].d,1);
 const split=a16MainCue('lightspeed-assault',null,{indirect:[{id:'a16:p2:trooper',amount:1},{id:'a16:p2:base',amount:1}]});a16MainCheck(split,true,'actual controller split across live unit/base');a16MainMutations(split,[['indirect remaining HP exceeded',c=>c.outcomes.find(o=>o.indirectAllocation).indirectAllocation.members[0].amount=3],['omitted actual split recipient',c=>c.outcomes.pop()]]);
 const sacrificeOnly=a16MainCue('lightspeed-assault',s=>s.players.p2.space=[]);a16MainCheck(sacrificeOnly,true,'no opposing space target means sacrifice only');
});
test('A16 Timely uses total resource pairs and exact fresh exhausted X-Wing set, granting only source-bound generated Sentinel',()=>{
 const cue=a16MainCommon('timely-reinforcements'),f=JSON.parse(fs.readFileSync(path.join(__dirname,'../../forceteki/test/json/Card/xwing.json')));assert.deepEqual([f.power,f.hp,f.traits,f.types],[2,2,['vehicle','fighter'],['token','unit']]);
 a16MainMutations(cue,[['ready count substituted for total',c=>c.outcomes[0].generatedSet.opponentResources.total=5],['wrong chosen opponent',c=>c.outcomes[0].generatedSet.opponentResources.seat='p1'],['mixed Scramble origin',c=>c.outcomes[0].generatedSet.mechanic='base-restriction'],['missing creation',c=>c.outcomes.splice(3,1)],['missing one Sentinel grant',c=>c.outcomes.pop()],['duplicate fresh ID',c=>c.outcomes[1]=structuredClone(c.outcomes[0])],['used prior physical identity with different incarnation',c=>{for(const state of[c.transition.before,c.transition.after])state.mostRecentIncarnations={[c.outcomes[0].unit.id]:'older-entry'};}],['generated printed-unit spoof',c=>c.outcomes[0].unit.s='SOR_237'],['ready token fiction',c=>delete c.outcomes[0].unit.x],['Rebel trait invention',c=>c.outcomes[0].unit.traits.unshift('rebel')],['wrong token HP',c=>c.outcomes[0].unit.h=3],['inherited old wounds',c=>c.outcomes[0].unit.d=1],['grant applied to old fighter',c=>c.outcomes[4].card=c.transition.before.players.p1.space[0]],['permanent Sentinel',c=>c.outcomes[4].duration='permanent'],['wrong generated source',c=>c.outcomes[4].generatedSet.sourceId='other'],['stale round',c=>c.outcomes[4].round--],['old-entry grant',c=>c.outcomes[4].incarnation='old'],['sn mark absent behind status',c=>delete c.transition.after.players.p1.space[1].sn],['ordinary chip missing',c=>c.transition.after.players.p1.space[1].status=[]],['old X-Wing granted fiction',c=>c.transition.after.players.p1.space[0].sn=1],['tokens changed resource readiness',c=>c.transition.after.players.p2.res.ready=9],['coherent handoff false ready count',c=>{c.transition.before.players.p2.res.ready=9;c.transition.after.players.p2.res.ready=9;}]]);
 const even=a16MainCue('timely-reinforcements',s=>{s.players.p2.resources.pop();s.players.p2.res.total=8;});a16MainCheck(even,true,'even total8 still yields four');
 const two=a16MainCue('timely-reinforcements',s=>{s.players.p2.resources=s.players.p2.resources.slice(0,5);s.players.p2.resources.forEach(r=>r.x=1);s.players.p2.res={ready:0,total:5};});a16MainCheck(two,true,'all five exhausted resources still yield two');
 const unrelated=a16MainCue('timely-reinforcements',s=>s.mostRecentIncarnations={'old-other':'old-entry'});a16MainCheck(unrelated,true,'actual create preserves unrelated optional history');
});
test('A16 Timely explicit phase-end removes only retained exact generated Sentinel, preserving pose/native and later entries',()=>{
 const cue=a16MainBoundary();a16MainCheck(cue,true,'explicit expiry');a16MainMutations(cue,[['missing boundary',c=>delete c.stage],['next action instead of phase end',c=>c.stage='next-action'],['repaid even zero event cost',c=>c.playCost=0],['empty payment invented',c=>c.playPayment={kind:'resources',cardIds:[]}],['discarded source missing',c=>c.transition.before.players.p1.discard=[]],['expired wrapper permanent',c=>c.transition.before.players.p1.space[1].status[0].duration='permanent'],['expired wrapper restrict kind',c=>c.transition.before.players.p1.space[1].status[0].kind='restrict'],['wrong source-bound subject',c=>c.transition.before.players.p1.space[1].status[0].generatedSentinel.subjectId='other'],['stale retained entry',c=>c.transition.before.players.p1.space[1].status[0].generatedSentinel.incarnation='old'],['wrong retained source',c=>c.transition.before.players.p1.space[1].status[0].generatedSentinel.sourceId='foreign'],['wrong round',c=>c.transition.before.players.p1.space[1].status[0].round--],['missing one expiry',c=>c.outcomes.pop()],['duplicate expiry',c=>c.outcomes[1]=structuredClone(c.outcomes[0])],['gain instead of expiry',c=>c.outcomes[0].keywordOperation='gain'],['prevented but cleared',c=>c.outcomes[0].prevented=true],['coherent unrelated readied token',c=>{delete c.outcomes[0].unit.x;delete c.transition.after.players.p1.space[1].x;}],['coherent wrong token power',c=>{c.outcomes[0].unit.p=3;c.transition.after.players.p1.space[1].p=3;}],['native ground Sentinel removed',c=>delete c.transition.after.players.p1.ground[1].sn],['current source replaced',c=>c.outcomes[0].sourceCard={...c.source,id:'other'}],['unrelated defeat watcher',c=>c.outcomes[0].requiresDefeat={id:'other',incarnation:'entry'}],['sn incorrectly retained',c=>c.transition.after.players.p1.space[1].sn=1]]);
 const moved=a16MainBoundary(s=>{const u=s.players.p1.space.splice(1,1)[0];s.players.p2.space.push(u);s.players.p1.space.push(a16MainToken(s,'later-xwing'));});a16MainCheck(moved,true,'actual changed controller, original owner and later token retained');assert.equal(moved.transition.after.players.p2.space.at(-1).x,1);assert.equal(moved.transition.after.players.p1.ground[1].sn,1);assert.equal(moved.transition.after.players.p1.space.at(-1).sn,undefined);
 const departed=a16MainBoundary(s=>s.players.p1.space.splice(1,1));a16MainCheck(departed,true,'departed generated token is not resurrected');
});
test('A16 They Hate creates opposing ready TIE pair before mandatory affordable Vehicle play with independent canonical discount/payment',()=>{
 const cue=a16MainCommon('they-hate-that-ship'),f=JSON.parse(fs.readFileSync(path.join(__dirname,'../../forceteki/test/json/Card/atst.json')));assert.deepEqual([f.cost,f.aspects,f.power,f.hp],[6,['villainy'],6,7]);const intermediate=batchA16IntermediateLayout(cue);assert.equal(intermediate.players.p2.space.length,3);assert.equal(intermediate.players.p1.ground.length,2);assert.equal(intermediate.players.p1.res.ready,17);assert.ok(intermediate.players.p1.hand.some(c=>c.s==='SOR_232'));
 a16MainMutations(cue,[['one enemy TIE missing',c=>c.outcomes.shift()],['wrong beneficiary',c=>c.outcomes[0].seat='p1'],['enemy token is exhausted',c=>c.outcomes[0].unit.x=1],['entersReady false',c=>c.outcomes[0].entersReady=false],['Imperial trait invented',c=>c.outcomes[0].unit.traits.unshift('imperial')],['recycled prior physical TIE',c=>{for(const state of[c.transition.before,c.transition.after])state.mostRecentIncarnations={[c.outcomes[0].unit.id]:'prior-entry'};c.transition.after.mostRecentIncarnations[c.outcomes[4].unit.id]=c.outcomes[4].unit.incarnation;}],['Scramble restriction invented',c=>c.outcomes[0].unit.status=[{kind:'restrict',label:'No base',duration:'phase',restriction:'cannot-attack-base'}]],['declined mandatory affordable play',c=>{c.outcomes=c.outcomes.slice(0,2);const before=c.transition.before.players.p1;const after=c.transition.after.players.p1;after.ground.pop();after.hand.push(before.hand.find(x=>x.s==='SOR_232'));after.resources.slice(3,8).forEach(r=>delete r.x);after.res.ready=17;}],['coherent nested payment underpaid',c=>{const removed=c.outcomes[3].cards.pop();c.outcomes[3].amount--;delete c.transition.after.players.p1.resources.find(r=>r.id===removed.id).x;c.transition.after.players.p1.res.ready++;}],['coherent cost penalty omitted',c=>{c.outcomes[3].amount=3;c.outcomes[3].cards=c.outcomes[3].cards.slice(0,3);c.transition.after.players.p1.resources.slice(6,8).forEach(r=>delete r.x);c.transition.after.players.p1.res.ready=14;}],['coherent printed unit cost spoof',c=>{for(const o of c.outcomes.filter(o=>o.discountedVehiclePlay))o.discountedVehiclePlay.printedCost=5;c.outcomes[4].printedCost=5;}],['coherent no Villainy requirement',c=>{for(const o of c.outcomes.filter(o=>o.discountedVehiclePlay))o.discountedVehiclePlay.aspects=[];}],['discount−4',c=>c.outcomes[2].amount=-4],['pay before discount',c=>[c.outcomes[2],c.outcomes[3]]=[c.outcomes[3],c.outcomes[2]]],['unit play before enemy creation',c=>c.outcomes=[...c.outcomes.slice(2),...c.outcomes.slice(0,2)]],['wrong payment cause',c=>c.outcomes[3].causeCard={...c.source,id:'other'}],['wrong hand owner',c=>c.outcomes[4].ownerSeat='p2'],['rescue instead of play',c=>c.outcomes[4].entryType='rescued'],['arrives ready',c=>delete c.outcomes[4].unit.x],['native Overwhelm omitted',c=>c.outcomes[4].unit.status=[]],['old wounds inherited',c=>c.outcomes[4].unit.d=1],['printed Vehicle spoofed token',c=>c.outcomes[4].unit.t=1],['entry reused from history',c=>c.transition.before.mostRecentIncarnations={[c.outcomes[4].unit.id]:c.outcomes[4].unit.incarnation}],['played from discard fiction',c=>c.outcomes[4].fromZone='discard'],['queued attack invented',c=>c.outcomes[4].attackId='early-attack'],['unreceipted old unit restriction',c=>c.transition.after.players.p2.space[0].status=[{kind:'restrict',label:'No base',duration:'phase',restriction:'cannot-attack-base'}]]]);
 const none=a16MainCue('they-hate-that-ship',s=>s.players.p1.hand=s.players.p1.hand.filter(c=>c.s!=='SOR_232'),{playId:null});a16MainCheck(none,true,'no playable Vehicle still creates both tokens');
 const unknownPlayable=structuredClone(none),wingJSON=JSON.parse(fs.readFileSync(path.join(__dirname,'../../forceteki/test/json/Card/green-squadron-awing.json')));assert.deepEqual([wingJSON.cost,wingJSON.aspects,wingJSON.traits],[2,['aggression','heroism'],['rebel','vehicle','fighter']]);for(const state of[unknownPlayable.transition.before,unknownPlayable.transition.after])state.players.p1.hand.push({id:'actual-green-squadron',n:wingJSON.title,s:'SOR_141',owner:'p1'});a16MainCheck(unknownPlayable,false,'unknown finite hand face cannot establish no playable Vehicle: actual A-Wing full4 minus3 costs1 with17 ready');
 a16MainMutations(none,[['known Vehicle body without established native play price cannot prove no playable Vehicle',c=>{for(const state of[c.transition.before,c.transition.after])state.players.p1.hand.push({id:'hand-firespray',n:"Fett's Firespray: Feared Silhouette",s:'JTL_240',owner:'p1'});}]]);
 const wing=a16MainCue('they-hate-that-ship',s=>s.players.p1.hand.push({id:'hand-wing',n:'Alliance X-Wing',s:'SOR_237',owner:'p1'}),{playId:'hand-wing'});a16MainCheck(wing,true,'floor0 own hand X-Wing costs0 after actual−3');assert.equal(wing.outcomes[3].amount,0);
});
test('A16 Trench establishes actual Fighter/+4 attack, top printed-cost mill and unpreventable self-hit before legal combat',()=>{
 const cue=a16MainCommon('trench-run');a16MainMutations(cue,[['missing attack buff',c=>c.outcomes.shift()],['permanent bonus',c=>c.outcomes[0].duration='permanent'],['bonus on wrong role',c=>c.outcomes[0].attackRole='defender'],['actual power wrong',c=>c.outcomes[1].amount=5],['attacker exhausted before declaration',c=>c.transition.before.players.p1.space[0].x=1],['wrong granted window source',c=>c.outcomes[1].onAttackWindow.sourceId='other'],['wrong granted ability origin',c=>c.outcomes[3].onAttackOrigin.ability.origin='native'],['wrong granted subject',c=>c.outcomes[3].onAttackOrigin.ability.subjectId='other'],['wrong grant round',c=>c.outcomes[3].onAttackOrigin.ability.round--],['old window',c=>c.outcomes[3].onAttackOrigin.windowId='other'],['wrong top cards',c=>c.transition.before.players.p2.knownDeck.reverse()],['unknown complete deck',c=>delete c.transition.before.players.p2.knownDeck],['public mill moved hand',c=>c.outcomes[3].fromZone='hand'],['one cost fake',c=>c.outcomes[4].millCostDifference.printedCosts=[6,4]],['coherent cost difference fake',c=>{c.outcomes[4].millCostDifference.printedCosts=[6,4];c.outcomes[4].millCostDifference.difference=2;c.outcomes[4].amount=2;c.outcomes[4].damageAttempt.incoming=2;c.transition.after.players.p1.space[0].d=2;}],['self damage preventable',c=>delete c.outcomes[4].unpreventable],['wrong self source',c=>c.outcomes[4].sourceCard=c.source],['self damage after combat',c=>[c.outcomes[4],c.outcomes[5]]=[c.outcomes[5],c.outcomes[4]]],['self wound not retained',c=>c.transition.after.players.p1.space[0].d=0],['resting +4 retained',c=>c.transition.after.players.p1.space[0].p=6],['resting granted trigger retained',c=>c.transition.after.players.p1.space[0].onAttackAbilities=[c.outcomes[3].onAttackOrigin.ability]],['unearned combat counter on base',c=>c.outcomes.push({...c.outcomes.at(-1),card:c.transition.before.players.p1.space[0],seat:'p1',zone:'space',amount:2})]]);
 const shield=a16MainCue('trench-run',s=>a16MainShield(s,'a16:p1:xwing'));a16MainCheck(shield,true,'unpreventable self hit retains actual Shield');assert.equal(shield.transition.after.players.p1.space[0].u.length,1);assert.equal(shield.transition.after.players.p1.space[0].d,1);
 const lethal=a16MainCue('trench-run',s=>s.players.p1.space=[a16MainBody('SOR_225','a16:p1:xwing')]);a16MainCheck(lethal,true,'lethal self-hit cancels combat');assert.equal(lethal.transition.after.players.p2.base.d,6);a16MainMutations(lethal,[['lethal self hit still forwarded combat',c=>c.outcomes.push({kind:'damage',card:c.transition.before.players.p2.base,seat:'p2',zone:'base',sourceCard:c.transition.before.players.p1.space[0],amount:6,damageType:'combat',attackId:c.outcomes[1].attackId,attackIndex:1})],['actual self defeat absent',c=>c.outcomes.pop()]]);
 const short=a16MainCue('trench-run',s=>{s.players.p2.knownDeck=s.players.p2.knownDeck.slice(0,1);s.players.p2.deck=1;});a16MainCheck(short,true,'one actual milled card means no cost self-hit');assert.equal(short.transition.after.players.p1.space[0].d,0);a16MainMutations(short,[['invented second card',c=>c.outcomes[3].cards.push({id:'fake',n:'Takedown',s:'SOR_077',owner:'p2'})]]);
});
test('A16 Hotshot counts one real active Firespray object, distinct initial2 hits, actual native indirect and combat in order',()=>{
 const cue=a16MainCommon('hotshot-maneuver'),f=JSON.parse(fs.readFileSync(path.join(__dirname,'../../forceteki/test/json/Card/fetts-firespray#feared-silhouette.json')));assert.deepEqual([f.id,f.power,f.hp,f.unique],['6648978613',4,4,true]);assert.match(f.text,/When Played\/On Attack:/);
 a16MainMutations(cue,[['combined trigger counted twice',c=>c.outcomes[0].onAttackCensus.abilities.push(c.outcomes[0].onAttackCensus.abilities[0])],['census source wrong',c=>c.outcomes[0].onAttackCensus.sourceId='other'],['census current entry wrong',c=>c.outcomes[0].onAttackCensus.incarnation='old'],['unsupported gained ability spoof',c=>{c.transition.before.players.p1.space[1].onAttackAbilities[0].origin='granted';c.outcomes[0].onAttackCensus.abilities[0].origin='granted';}],['conditional ability fiction',c=>c.outcomes[0].onAttackCensus.abilities[0].requiresTrait='jedi'],['distinct target count omitted',c=>c.outcomes[0].onAttackCensus.targets=[]],['repeated selected target',c=>c.outcomes[0].onAttackCensus.targets.push(c.outcomes[0].onAttackCensus.targets[0])],['two-point attempt wrong',c=>c.outcomes[0].damageAttempt.incoming=1],['initial hit treated as native trigger',c=>c.outcomes[0].attackId=c.outcomes[1].attackId],['initial hit omitted behind unchanged later attack',c=>c.outcomes.shift()],['attack before initial event hit',c=>[c.outcomes[0],c.outcomes[1]]=[c.outcomes[1],c.outcomes[0]]],['attack source exhaustion missing',c=>c.outcomes.splice(2,1)],['native trigger omitted',c=>c.outcomes.splice(3,1)],['Boba condition unknown',c=>delete c.outcomes[3].onAttackOrigin.controlsBobaFett],['native trigger gained',c=>c.outcomes[3].onAttackOrigin.ability.origin='granted'],['native trigger uses event damage source',c=>c.outcomes[3].sourceCard=c.source],['native window unrelated',c=>c.outcomes[3].onAttackOrigin.windowId='other'],['native recipient chooses P1',c=>c.outcomes[3].chooserSeat='p1'],['combat before actual native indirect',c=>[c.outcomes[3],c.outcomes[4]]=[c.outcomes[4],c.outcomes[3]]],['combat amount wrong',c=>c.outcomes[4].amount=5],['native grant retained at rest',c=>c.transition.after.players.p1.space[1].status=[{kind:'buff',label:'On Attack',duration:'attack'}]],['exhausted selected unit illegally attacks',c=>c.transition.before.players.p1.space[1].x=1],['actual Wampa wound lost',c=>c.transition.after.players.p2.ground[1].d=1]]);
 const exhausted=a16MainCue('hotshot-maneuver',s=>s.players.p1.space[1].x=1);a16MainCheck(exhausted,true,'selected exhausted native unit still deals initial2, no actual attack');assert.equal(exhausted.outcomes.length,1);assert.equal(exhausted.transition.after.players.p2.base.d,6);
 const zero=a16MainCue('hotshot-maneuver',null,{sourceId:'a16:p1:xwing'});a16MainCheck(zero,true,'known zero On Attack objects still perform normal attack');assert.equal(zero.outcomes.filter(o=>o.kind==='damage').length,1);
 const noEnemies=a16MainCue('hotshot-maneuver',s=>{s.players.p2.ground=[];s.players.p2.space=[];});a16MainCheck(noEnemies,true,'no enemies omits initial hit but preserves real native attack');
 const triggerKill=a16MainCue('hotshot-maneuver',null,{attackTargetId:'a16:p2:tie',indirect:[{id:'a16:p2:tie',amount:1}]});a16MainCheck(triggerKill,true,'native On Attack can actually defeat defender, ending combat without forward/counter');assert.equal(triggerKill.outcomes.filter(o=>o.damageType==='combat').length,0);
});

test('A16 decorative shots preserve unrelated measured HP and public token faces retain identity through creation and expiry',()=>{
 const React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),{BatchA16Signature}=loadTS(path.join(__dirname,'../src/effects/batchA16Signatures.tsx'));
 const visualGeometry=cue=>{const g=geometry(cue.outcomes);g.zones={};g.cards={};g.endingCards={};g.intermediateCards={};g.resourceCards={};for(const seat of ['p1','p2']){const y=seat==='p1'?410:120;for(const zone of ['ground','space','resources','resource-count','discard','deck','hand'])g.zones[seat+':'+zone]={...box,x:zone==='ground'?220:zone==='space'?730:500,y,w:zone==='ground'||zone==='space'?300:100,h:100};g.zones[seat+':base']={...box,x:500,y,w:100,h:70,stat:{x:545,y:y-30,w:48,h:48}};for(const state of [cue.transition.before,cue.transition.after])for(const zone of ['ground','space'])state.players[seat][zone].forEach((u,i)=>{const at={...box,x:(zone==='space'?720:210)+i*90,y,w:58,h:81,cardSize:{w:58,h:81}};g.cards[seat+':'+u.id]=at;g.endingCards[seat+':'+u.id]=at;g.intermediateCards[seat+':'+u.id]=at;});}return g;};
 const render=(cue,p)=>renderToStaticMarkup(React.createElement(BatchA16Signature,{cue,geometry:visualGeometry(cue),p}));
 for(const id of ['trench-run','hotshot-maneuver']){const html=render(a16MainCue(id),.70);assert.match(html,/data-effect-pulse-counter-mask="p1"/,'protect unrelated ownHP from both beam and travelling glow');assert.doesNotMatch(html,/data-effect-pulse-counter-mask="p2"/,'meaningful enemy-base endpoint remains visible');assert.match(html,/mask="url\(#/,'mask applies to decorative shot group');}
 const direct=render(a16MainCue('lightspeed-assault'),.46);assert.match(direct,/data-effect-pulse-counter-mask="p1"/);assert.match(direct,/data-effect-pulse-counter-mask="p2"/,'unit-target shot protects both unrelated bases');
 for(const cue of [a16MainCue('timely-reinforcements'),a16MainBoundary()]){const html=render(cue,.90);assert.equal((html.match(/data-effect-public-token-face="X-Wing"/g)||[]).length,4,'all actual named X-Wings retained during creation/keyword-only expiry');assert.match(html,/>X-WING<\/text>/);assert.match(html,/>TOKEN<\/text>/);}
 const ties=render(a16MainCue('they-hate-that-ship'),.90);assert.equal((ties.match(/data-effect-public-token-face="TIE Fighter"/g)||[]).length,2,'actual opposing public TIE identities retained before ordinary board');assert.match(ties,/>TIE FIGHTER<\/text>/);
 const wrong=a16MainCue('timely-reinforcements');wrong.outcomes[0].unit.t=0;assert.equal(render(wrong,.90),'','unsupported contradictory token receipt has no rich face');
});
