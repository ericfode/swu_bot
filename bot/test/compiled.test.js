'use strict';
// bot/compiled: the JS bundler and the pieces it swaps in (Javy's stdio, sha1), run under Node with a fake Javy.IO.
// No Javy, wasm runtime or card data needed; the real builds are checked by bot/compiled/compare.py.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const path = require('path');
const vm = require('vm');
const { bundle, requires } = require('../compiled/js/bundle');
const shim = require('../compiled/js/crypto');

const ROOT = path.join(__dirname, '..', '..');

test('sha1 shim matches Node crypto, across block boundaries and UTF-8', () => {
    const texts = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(119), 'Ünïcødé ✓ 🚀', JSON.stringify({ x: 'y'.repeat(5000) })];
    for (const t of texts) {
        assert.strictEqual(shim.createHash('sha1').update(t).digest('hex'), crypto.createHash('sha1').update(t).digest('hex'), `length ${t.length}`);
    }
    assert.throws(() => shim.createHash('md5'), /only sha1/);
    assert.throws(() => shim.createHmac('sha256', 'k'), /not available/);
});

test('requires() skips comment lines', () => {
    const src = "// in process: require('./bot/examples/random-bot')\n * require('x')\nconst a = require('../rng');\nconst b = require(\"crypto\");\n";
    assert.deepStrictEqual(requires(src), ['../rng', 'crypto']);
});

test('a Node-only module is a build error', () => {
    // the referee needs Node built-ins such as fs and child_process
    assert.throws(() => bundle(path.join(ROOT, 'bot', 'protocol.js')), /not available in a compiled bot/);
});

/**
 * Run a bundle as Javy would: messages arrive one at a time, the next only after the bot's reply, and each `sim`
 * request is answered by onSim. Resolves to everything the bot wrote.
 */
async function runBundled(code, messages, onSim = () => ({ t: 'simulated', error: 'no sims here' })) {
    const queue = [...messages];
    const out = [];
    let pending = Buffer.alloc(0);
    const IO = {
        readSync(fd, buf) {
            if (!pending.length) {
                const last = out[out.length - 1];
                const next = last?.t === 'sim' && !last.answered ? ((last.answered = true), onSim(last)) : queue.shift();
                if (next === undefined) {
                    return 0;
                }
                pending = Buffer.from(`${JSON.stringify(next)}\n`);
            }
            const n = Math.min(buf.length, pending.length);
            buf.set(pending.subarray(0, n));
            pending = pending.subarray(n);
            return n;
        },
        writeSync(fd, bytes) {
            assert.strictEqual(fd, 1);
            for (const line of Buffer.from(bytes).toString('utf8').split('\n').filter(Boolean)) {
                out.push(JSON.parse(line));
            }
            return bytes.length;
        }
    };
    const ctx = vm.createContext({ Javy: { IO }, TextEncoder, TextDecoder, console });
    vm.runInContext(code, ctx);
    for (let k = 0; k < 100 && (queue.length || pending.length); k++) {
        await new Promise(setImmediate);
    }
    await new Promise(setImmediate);
    return out.map(({ answered, ...m }) => m);
}

const hello = { t: 'hello', protocol: 'swu-bot-stdio', v: 1, versions: [1, 2], bot: 'b', you: 'p1', seed: 424242, ms: 30000, players: [] };
const decide = (n, sim = false) => ({
    t: 'decide', seq: n, you: 'p1', sim, ms: 10000, prompt: { actionWindow: true }, state: { n },
    actions: [0, 1, 2, 3, 4].map((i) => ({ i, kind: 'button', label: i ? `b${i}` : 'Pass', arg: String(i) }))
});

test('bundled random bot gives the same replies as the Node one', async () => {
    const code = bundle(path.join(ROOT, 'bot', 'examples', 'random-bot.js'), ['node-random']);
    const msgs = [hello, decide(1), decide(2), decide(3), { t: 'over', you: 'p1', winner: 'p2', outcome: 'won' }];
    const got = await runBundled(code, msgs);
    const node = require('../examples/random-bot').create('node-random');
    const want = [];
    for (const m of msgs) {
        want.push(m.t === 'hello' ? node.hello(m) : m.t === 'decide' ? node.decide(m) : { t: 'ok' });
    }
    assert.deepStrictEqual(got, want);
    assert.strictEqual(got[0].name, 'node-random'); // the build-time argument reached process.argv
});

test('bundled search bot searches through sims like the Node one (sha1 situation keys included)', async () => {
    const code = bundle(path.join(ROOT, 'bot', 'examples', 'search-bot.js'), ['node-search']);
    // a toy simulator: acting on index i ends the game, won only for i = 3
    const onSim = (req) => (req.op === 'act' ? { t: 'simulated', op: 'act', over: { winner: req.i === 3 ? 'p1' : 'p2' } } : { t: 'simulated', op: req.op });
    const msgs = [hello, decide(1, true), decide(1, true), decide(2, false)];
    const got = await runBundled(code, msgs, onSim);
    const node = require('../examples/search-bot').create('node-search');
    const want = [];
    for (const m of msgs) {
        if (m.t === 'hello') {
            want.push(node.hello(m));
        } else {
            want.push(await node.decide(m, async (req) => {
                want.push(req);
                return onSim(req);
            }));
        }
    }
    assert.deepStrictEqual(got, want);
    const acts = got.filter((m) => m.t === 'act').map((m) => m.i);
    assert.strictEqual(acts[0], 3); // the winning line
    assert.notStrictEqual(acts[1], 3); // never the same choice twice in the same situation
});
