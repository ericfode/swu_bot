const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createRequire } = require('node:module');
const ts = require('../../viewer/node_modules/typescript');

function loader(overrides = {}) {
    const modules = new Map();
    function load(filename) {
        filename = path.resolve(filename);
        if (modules.has(filename)) return modules.get(filename).exports;
        const module = { exports: {} };
        modules.set(filename, module);
        const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
        }).outputText;
        const localRequire = createRequire(filename);
        const requireModule = specifier => {
            if (Object.hasOwn(overrides, specifier)) return overrides[specifier];
            if (specifier.startsWith('.')) return load(path.resolve(path.dirname(filename), `${specifier}.ts`));
            return localRequire(specifier);
        };
        new Function('require', 'module', 'exports', compiled)(requireModule, module, module.exports);
        return module.exports;
    }
    return load;
}

const audioPath = path.join(__dirname, '../src/effects/audio.ts');
const { synthesizeSound, boundedSoundEvents } = loader()(audioPath);
const voices = ['laser', 'impact', 'rumble', 'crackle', 'whoosh', 'chime', 'pulse', 'shatter', 'card', 'shield', 'servo'];
const note = { voice: 'laser', at: .1, duration: .2, gain: .7, seed: 7 };
const cue = { key: 'one', definition: { id: 'open-fire', durationMs: 2200 }, seat: 'p1', source: null, target: null };

class Param {
    value = 0;
    calls = [];
    cancelScheduledValues(...args) { this.calls.push(['cancel', ...args]); }
    setTargetAtTime(...args) { this.calls.push(['target', ...args]); }
}
class Node {
    connections = [];
    disconnects = 0;
    connect(node) { this.connections.push(node); return node; }
    disconnect() { this.disconnects++; }
}
class FakeContext {
    currentTime = 3;
    sampleRate = 8000;
    state = 'suspended';
    destination = new Node();
    sources = [];
    gains = [];
    panners = [];
    resumeCalls = 0;
    async resume() { this.resumeCalls++; this.state = 'running'; }
    createGain() { const node = Object.assign(new Node(), { gain: new Param() }); this.gains.push(node); return node; }
    createDynamicsCompressor() {
        return Object.assign(new Node(), Object.fromEntries(['threshold', 'knee', 'ratio', 'attack', 'release'].map(name => [name, new Param()])));
    }
    createStereoPanner() { const node = Object.assign(new Node(), { pan: new Param() }); this.panners.push(node); return node; }
    createBuffer(channels, length, rate) {
        return { numberOfChannels: channels, length, sampleRate: rate, data: null,
            copyToChannel(data) { this.data = data; } };
    }
    createBufferSource() {
        const node = Object.assign(new Node(), { starts: [], stops: [], buffer: null,
            start(time) { this.starts.push(time); }, stop(time) { this.stops.push(time); } });
        this.sources.push(node);
        return node;
    }
}

test('eleven deterministic voices have finite bounded samples, silent edges, and distinct timbres', () => {
    const signatures = new Set();
    for (const voice of voices) {
        const event = { ...note, voice };
        const data = synthesizeSound(event, .35, 22050);
        assert.deepEqual(data, synthesizeSound(event, .35, 22050), voice);
        assert.equal(data[0], 0, voice);
        assert.equal(data.at(-1), 0, voice);
        const energy = data.reduce((sum, value) => {
            assert.ok(Number.isFinite(value) && Math.abs(value) <= 1, voice);
            return sum + value * value;
        }, 0);
        assert.ok(Math.sqrt(energy / data.length) > .01, `${voice} must be audible`);
        assert.ok(Math.abs(data[1]) < .002 && Math.abs(data.at(-2)) < .002, `${voice} must fade smoothly`);
        signatures.add(Array.from(data.slice(100, 110)).join(','));
    }
    assert.equal(signatures.size, voices.length);
});

test('synthesis sanitizes hostile numeric inputs and applies event gain proportionally', () => {
    const data = synthesizeSound({ ...note, pitch: NaN, pitchEnd: Infinity, gain: NaN, seed: Infinity }, NaN, NaN);
    assert.ok(data.length > 0 && data.every(Number.isFinite));
    const half = synthesizeSound({ ...note, gain: .5 }, .1, 8000);
    const full = synthesizeSound({ ...note, gain: 1 }, .1, 8000);
    for (let i = 0; i < half.length; i++) assert.ok(Math.abs(half[i] * 2 - full[i]) < 1e-6);
});

test('score bounds reject invalid notes, clip tails, and limit total and simultaneous work', () => {
    const invalid = [
        { ...note, at: -1 }, { ...note, at: 1 }, { ...note, at: NaN }, { ...note, duration: Infinity },
        { ...note, duration: 0 }, { ...note, voice: 'unknown' }, { ...note, gain: 0 }
    ];
    assert.deepEqual(boundedSoundEvents(invalid), []);
    assert.equal(boundedSoundEvents(Array.from({ length: 100 }, () => ({ ...note }))).length, 12);
    const sequential = boundedSoundEvents(Array.from({ length: 100 }, (_, i) => ({ ...note, at: i / 100, duration: .001 })));
    assert.equal(sequential.length, 48);
    assert.equal(boundedSoundEvents([{ ...note, at: .95, duration: .3 }])[0].duration, 1 - .95);
    assert.deepEqual(boundedSoundEvents([{ ...note, at: .6 }, { ...note, at: .1 }]).map(e => e.at), [.1, .6]);
});

test('scheduler owns its graph, adjusts volume without new sources, and cancels future voices once', () => {
    const { scheduleEffectAudio } = loader({ './soundScore': { scoreEffect: () => [note, { ...note, at: .6 }] } })(audioPath);
    const context = new FakeContext();
    const first = scheduleEffectAudio(context, cue, { volume: .4 });
    const second = scheduleEffectAudio(context, { ...cue, key: 'two' }, { volume: .8 });
    assert.equal(context.sources.length, 4);
    assert.equal(context.sources[0].starts[0], 3 + .1 * 2.2);
    assert.equal(context.sources[1].starts[0], 3 + .6 * 2.2);
    first.setVolume(.9);
    assert.equal(context.sources.length, 4);
    assert.equal(context.gains[0].gain.calls.at(-1)[1], .3 * .9);
    assert.deepEqual(context.gains[1].gain.calls, []);
    first.stop();
    first.stop();
    first.setVolume(1);
    assert.deepEqual(context.sources.map(source => source.stops.length), [1, 1, 0, 0]);
    assert.ok(context.sources[1].stops[0] < context.sources[1].starts[0], 'future voice is cancelled before its start');
    assert.equal(context.gains[0].gain.calls.at(-1)[1], 0);
    second.stop();
    assert.deepEqual(context.sources.map(source => source.stops.length), [1, 1, 1, 1]);
});

test('high-rate output devices preserve each synthesized note duration', () => {
    const { scheduleEffectAudio } = loader({ './soundScore': { scoreEffect: () => [note] } })(audioPath);
    const context = new FakeContext();
    context.sampleRate = 192000;
    scheduleEffectAudio(context, cue);
    const buffer = context.sources[0].buffer;
    assert.equal(buffer.sampleRate, 96000);
    assert.ok(Math.abs(buffer.length / buffer.sampleRate - note.duration * cue.definition.durationMs / 1000) < 1 / 96000);
});

// A minimal effect lifecycle harness verifies our dependencies/cleanup without adding a DOM test dependency.
function hookHarness() {
    const slots = [];
    let index = 0, pending = [];
    return {
        react: {
            useRef(value) { const slot = index++; return slots[slot] ??= { current: value }; },
            useLayoutEffect(setup, deps) {
                const slot = index++;
                const previous = slots[slot];
                if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
                    pending.push({ slot, setup, deps, previous });
                }
            }
        },
        render(callback) {
            index = 0;
            pending = [];
            callback();
            for (const effect of pending) effect.previous?.cleanup?.();
            for (const effect of pending) slots[effect.slot] = { deps: effect.deps, cleanup: effect.setup() };
        },
        unmount() { for (const slot of slots) slot?.cleanup?.(); }
    };
}

test('hook is gesture-gated and silent when held; replacement, mute, hidden document and unmount cancel playback', async () => {
    const harness = hookHarness();
    const listeners = new Set();
    const previousWindow = global.window, previousDocument = global.document;
    const contexts = [];
    class BrowserContext extends FakeContext { constructor() { super(); contexts.push(this); } }
    global.window = { AudioContext: BrowserContext };
    global.document = {
        hidden: false,
        addEventListener(name, callback) { assert.equal(name, 'visibilitychange'); listeners.add(callback); },
        removeEventListener(name, callback) { assert.equal(name, 'visibilitychange'); listeners.delete(callback); }
    };
    const { unlockEffectAudio, useCardEffectAudio } = loader({ react: harness.react, './soundScore': { scoreEffect: () => [note] } })(audioPath);
    const render = (current, enabled = true, volume = .35) => harness.render(() => useCardEffectAudio(current, enabled, volume));
    try {
        render(cue, false);
        render(cue, true);
        assert.equal(contexts.length, 0, 'rendering never creates a live context');
        assert.equal(await unlockEffectAudio(), true);
        assert.equal(contexts.length, 1);
        const context = contexts[0];
        assert.equal(context.resumeCalls, 1);
        render({ ...cue, key: 'enabled' });
        assert.equal(context.sources.length, 1);
        render({ ...cue, key: 'enabled', outcomes: [] }, true, .8);
        assert.equal(context.sources.length, 1, 'same-key snapshots and volume changes never restart sound');
        assert.equal(context.gains[0].gain.calls.at(-1)[1], .3 * .8);
        render({ ...cue, key: 'enabled', previewProgress: .4 });
        assert.equal(context.sources[0].stops.length, 1);
        render({ ...cue, key: 'enabled', previewProgress: .7 });
        assert.equal(context.sources.length, 1, 'scrubbing does not synthesize held frames');
        render({ ...cue, key: 'new' });
        assert.equal(context.sources.length, 2);
        render({ ...cue, key: 'replacement' });
        assert.equal(context.sources[1].stops.length, 1);
        assert.equal(context.sources.length, 3);
        render({ ...cue, key: 'replacement' }, false);
        assert.equal(context.sources[2].stops.length, 1);
        render({ ...cue, key: 'hidden' });
        global.document.hidden = true;
        for (const callback of listeners) callback();
        assert.equal(context.sources[3].stops.length, 1);
        global.document.hidden = false;
        for (const callback of listeners) callback();
        render({ ...cue, key: 'hidden' }, true, .3);
        assert.equal(context.sources.length, 4, 'returning to visible document does not replay an old cue');
        render({ ...cue, key: 'removed' });
        render(null);
        assert.equal(context.sources[4].stops.length, 1);
        render({ ...cue, key: 'unmounted' });
        harness.unmount();
        assert.equal(context.sources[5].stops.length, 1);
        assert.equal(listeners.size, 0);
        assert.equal(context.resumeCalls, 1, 'only the explicit unlock gesture resumes the context');
    } finally {
        harness.unmount();
        global.window = previousWindow;
        global.document = previousDocument;
    }
});

test('unsupported and rejected audio unlocks return false without an unhandled rejection', async () => {
    const previousWindow = global.window;
    try {
        global.window = {};
        assert.equal(await loader()(audioPath).unlockEffectAudio(), false);
        global.window = { AudioContext: class extends FakeContext { async resume() { throw new Error('gesture denied'); } } };
        assert.equal(await loader()(audioPath).unlockEffectAudio(), false);
    } finally { global.window = previousWindow; }
});
