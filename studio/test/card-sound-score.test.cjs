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
const { scoreEffect } = loadTS(path.join(__dirname, '../src/effects/soundScore.ts'));
const { CARD_EFFECTS } = loadTS(path.join(__dirname, '../src/effects/catalogue.ts'));
const { ABILITY_LANGUAGE } = loadTS(path.join(__dirname, '../src/effects/abilities.ts'));
const { previewCue } = loadTS(path.join(__dirname, '../src/effects/preview.ts'));
const { showcaseGame } = loadTS(path.join(__dirname, '../src/effects/showcase.ts'));
const { boundedSoundEvents } = loadTS(path.join(__dirname, '../src/effects/audio.ts'));
// Visual catalogue expansion does not authorize additional sound design.
const SOUND_BASELINE_KINDS = new Set(['damage', 'defeat', 'heal', 'shield', 'buff', 'debuff', 'draw', 'discard', 'mill',
    'return', 'recover', 'resource', 'ready', 'exhaust', 'suppress', 'attack', 'cost', 'pay', 'inspect']);
const receipt = (kind, patch = {}) => ({ kind, seat: 'p2', amount: 1, ...patch });
function cue(id, outcomes = []) {
    return { definition: CARD_EFFECTS.find(effect => effect.id === id) ?? { id, durationMs: 2500 },
        key: `${id}:test`, seat: 'p1', source: null, target: null, outcomes };
}
function preview(definition) {
    return previewCue({ definition, nonce: 1 }, showcaseGame(definition).steps[0].state);
}
function validate(events) {
    assert.ok(events.length <= 48);
    for (const event of events) {
        for (const key of ['at', 'duration', 'pitch', 'pitchEnd', 'gain', 'pan', 'seed']) assert.ok(Number.isFinite(event[key]), `${event.voice}.${key}`);
        assert.ok(event.at >= 0 && event.at < 1);
        assert.ok(event.duration > 0 && event.at + event.duration <= 1.00000001);
        assert.ok(event.pitch >= 20 && event.pitchEnd >= 20);
        assert.ok(event.gain > 0 && event.gain <= 1);
        assert.ok(event.pan >= -1 && event.pan <= 1);
        assert.ok(events.filter(other => other.at <= event.at && other.at + other.duration > event.at).length <= 12);
    }
    assert.deepEqual(boundedSoundEvents(events), events, 'engine does not have to discard or repair score notes');
}
const voicing = events => events.map(({ voice, at, duration, pitch, pitchEnd, gain }) => ({ voice, at: +(at - events[0].at).toFixed(5), duration, pitch, pitchEnd, gain }));
const unseeded = ({ seed, ...event }) => event;
function mechanicsFor(id, outcomes) {
    const opening = scoreEffect(cue(id)).map(event => JSON.stringify(unseeded(event)));
    return scoreEffect(cue(id, outcomes)).filter(event => !opening.includes(JSON.stringify(unseeded(event))));
}

test('twenty deterministic and distinct scores fit the realtime engine without clipping voices', () => {
    const fingerprints = new Set();
    const launches = new Set();
    // This is the historical twenty-card sound-design baseline. A01 visual authoring has no sound acceptance.
    for (const definition of CARD_EFFECTS.slice(0, 20)) {
        const staged = preview(definition);
        const before = structuredClone(staged);
        const events = scoreEffect(staged);
        assert.ok(events.length >= 5, definition.id);
        validate(events);
        assert.deepEqual(scoreEffect(staged), events);
        assert.deepEqual(scoreEffect({ ...staged, key: 'different nonce' }), events);
        assert.deepEqual(staged, before, 'score creation must not mutate receipts');
        fingerprints.add(JSON.stringify(events.map(unseeded)));
        launches.add(JSON.stringify(scoreEffect(cue(definition.id)).map(unseeded)));
    }
    assert.equal(fingerprints.size, 20);
    assert.equal(launches.size, 20);
});

test('the nineteen original mechanic motifs retain distinct recognizable shapes', () => {
    const motifs = new Set();
    for (const { id } of ABILITY_LANGUAGE.filter(ability => SOUND_BASELINE_KINDS.has(ability.id))) {
        const events = scoreEffect(cue('grammar-only', [receipt(id)]));
        assert.ok(events.length > 0, id);
        validate(events);
        motifs.add(JSON.stringify(voicing(events)));
    }
    assert.equal(motifs.size, 19);
});

test('shared mechanics retain their spectral and rhythmic identity across card skins', () => {
    for (const [kind, a, b] of [['heal', 'repair', 'vigilance'], ['return', 'waylay', 'cunning'], ['buff', 'command', 'the-force-is-with-me']]) {
        assert.deepEqual(voicing(mechanicsFor(a, [receipt(kind)])), voicing(mechanicsFor(b, [receipt(kind)])), kind);
    }
});

test('missing receipts and zero outcomes never produce a damage, defeat or card-movement result', () => {
    for (const definition of CARD_EFFECTS) {
        const events = scoreEffect(cue(definition.id));
        assert.ok(events.every(event => event.at < .3), definition.id);
        assert.ok(!events.some(event => ['impact', 'shatter', 'laser', 'card', 'shield', 'chime'].includes(event.voice)), definition.id);
        assert.deepEqual(scoreEffect(cue(definition.id, [receipt('damage', { amount: 0 }), receipt('pay', { amount: 0 })])), events);
    }
});

test('modal sound follows only its selected pair, including alternatives to the staged examples', () => {
    const vigilant = scoreEffect(cue('vigilance', [receipt('heal'), receipt('shield')]));
    assert.ok(vigilant.some(event => event.voice === 'chime') && vigilant.some(event => event.voice === 'shield'));
    assert.ok(!vigilant.some(event => ['shatter', 'impact', 'card'].includes(event.voice)));
    const command = scoreEffect(cue('command', [receipt('resource'), receipt('recover', { zone: 'hand' })]));
    assert.ok(command.some(event => event.voice === 'card'));
    assert.ok(!command.some(event => ['laser', 'impact', 'shatter'].includes(event.voice)));
    const aggression = scoreEffect(cue('aggression', [receipt('draw'), receipt('ready')]));
    assert.ok(!aggression.some(event => ['laser', 'impact', 'shatter'].includes(event.voice)));
    const cunning = scoreEffect(cue('cunning', [receipt('return'), receipt('exhaust')]));
    assert.ok(!cunning.some(event => ['laser', 'impact', 'shatter', 'chime'].includes(event.voice)));
});

test('damage, defeat, attack and returning a card cannot masquerade as one another', () => {
    const only = kind => scoreEffect(cue('grammar-only', [receipt(kind)]));
    assert.ok(only('damage').some(event => event.voice === 'impact'));
    assert.ok(!only('damage').some(event => event.voice === 'shatter'));
    assert.ok(only('defeat').some(event => event.voice === 'shatter'));
    assert.ok(!only('defeat').some(event => event.voice === 'impact'));
    for (const kind of ['return', 'attack']) assert.ok(!only(kind).some(event => ['impact', 'shatter'].includes(event.voice)));
    const recall = only('return');
    assert.ok(recall.some(event => event.voice === 'whoosh' && event.pitchEnd > event.pitch));
    assert.ok(recall.some(event => event.voice === 'card'));
});

test('Superlaser removes six staged units with six snaps, and Lightning without payment has no hit', () => {
    const laser = scoreEffect(preview(CARD_EFFECTS.find(effect => effect.id === 'superlaser-blast')));
    assert.equal(laser.filter(event => event.voice === 'shatter').length, 6);
    assert.ok(laser.some(event => event.voice === 'rumble' && event.at > .3));
    const lightning = scoreEffect(cue('force-lightning', [receipt('suppress')]));
    assert.ok(!lightning.some(event => event.voice === 'impact'));
    const hit = scoreEffect(cue('force-lightning', [receipt('suppress'), receipt('pay', { amount: 2 }), receipt('damage', { amount: 4 })]));
    assert.equal(hit.filter(event => event.voice === 'impact').length, 1);
});

test('Force sequencing grants protection before optional attack and never invents its hit', () => {
    const force = scoreEffect(cue('the-force-is-with-me', [receipt('buff'), receipt('shield'), receipt('attack')]));
    assert.ok(!force.some(event => event.voice === 'impact'));
    const buff = force.find(event => event.voice === 'chime');
    const shield = force.find(event => event.voice === 'shield');
    const lunge = force.find(event => event.voice === 'whoosh' && event.at > .3);
    assert.ok(buff.at < shield.at && shield.at < lunge.at);
    const hit = scoreEffect(cue('the-force-is-with-me', [receipt('buff'), receipt('shield'), receipt('attack'), receipt('damage')]));
    assert.ok(hit.find(event => event.voice === 'impact').at > lunge.at);
    const choke = scoreEffect(cue('force-choke', [receipt('damage'), receipt('draw')]));
    assert.ok(choke.find(event => event.voice === 'card').at > choke.find(event => event.voice === 'impact').at);
});

test('aggregate milling is counted while large or malformed quantities stay bounded', () => {
    const mill = scoreEffect(cue('grammar-only', [receipt('mill', { amount: 6 })]));
    assert.equal(mill.filter(event => event.voice === 'card').length, 6);
    for (const amount of [NaN, Infinity, 100000]) validate(scoreEffect(cue('grammar-only', [receipt('mill', { amount })])));
    validate(scoreEffect(cue('superlaser-blast', Array.from({ length: 200 }, (_, index) => receipt('defeat', { seat: index % 2 ? 'p1' : 'p2' })))));
});
