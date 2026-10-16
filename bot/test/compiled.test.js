'use strict';
// bot/compiled: the JS bundler and the pieces it swaps in (Javy's stdio, sha1), run under Node with a fake Javy.IO.
// No Javy, wasm runtime or card data needed; the real builds are checked by bot/compiled/compare.py.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const path = require('path');
const vm = require('vm');
const { bundle, build, sourcePositions, requires } = require('../compiled/js/bundle');
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
    const src = "// in process: require('./bot/test/fixtures/random-bot')\n * require('x')\nconst a = require('../rng');\nconst b = require(\"crypto\");\n";
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
async function runBundled(code, messages, onSim = () => ({ t: 'simulated', error: 'no sims here' }), { filename, log } = {}) {
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
    // `filename` names the script as Javy does (function.mjs); `log` gets what the bot writes to stderr
    const ctx = vm.createContext({ Javy: { IO }, TextEncoder, TextDecoder, console: log ? { ...console, error: log } : console });
    vm.runInContext(code, ctx, filename ? { filename } : undefined);
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
    const code = bundle(path.join(__dirname, 'fixtures', 'random-bot.js'), ['node-random']);
    const msgs = [hello, decide(1), decide(2), decide(3), { t: 'over', you: 'p1', winner: 'p2', outcome: 'won' }];
    const got = await runBundled(code, msgs);
    const node = require('./fixtures/random-bot').create('node-random');
    const want = [];
    for (const m of msgs) {
        want.push(m.t === 'hello' ? node.hello(m) : m.t === 'decide' ? node.decide(m) : { t: 'ok' });
    }
    assert.deepStrictEqual(got, want);
    assert.strictEqual(got[0].name, 'node-random'); // the build-time argument reached process.argv
});

test('bundled search bot searches through sims like the Node one (sha1 situation keys included)', async () => {
    const code = bundle(path.join(__dirname, 'fixtures', 'search-bot.js'), ['node-search']);
    // a toy simulator: acting on index i ends the game, won only for i = 3
    const onSim = (req) => (req.op === 'act' ? { t: 'simulated', op: 'act', over: { winner: req.i === 3 ? 'p1' : 'p2' } } : { t: 'simulated', op: req.op });
    const msgs = [hello, decide(1, true), decide(1, true), decide(2, false)];
    const got = await runBundled(code, msgs, onSim);
    const node = require('./fixtures/search-bot').create('node-search');
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

test('with a root, only files inside it are bundled: no path, link or ../ leads out', () => {
    const fs = require('fs');
    const os = require('os');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-root-'));
    try {
        fs.writeFileSync(path.join(root, 'bot.js'), "const s = require('./stdio');\nconst h = require('./lib/help');\n");
        fs.mkdirSync(path.join(root, 'lib'));
        fs.writeFileSync(path.join(root, 'lib', 'help.js'), "module.exports = require('../data.json');\n");
        fs.writeFileSync(path.join(root, 'data.json'), '{"x": 1}');
        fs.writeFileSync(path.join(root, 'stdio.js'), 'module.exports = {};\n');
        const out = bundle(path.join(root, 'bot.js'), ['me'], { root });
        assert.match(out, /from bot\.js; do not edit/);
        assert.match(out, /"lib\/help\.js"/);
        const outside = path.join(os.tmpdir(), `bundle-outside-${process.pid}.js`);
        fs.writeFileSync(outside, 'module.exports = "secret";\n');
        fs.symlinkSync(outside, path.join(root, 'link.js'));
        try {
            for (const spec of [outside, `../${path.basename(outside)}`, './link.js', '../../etc/hostname']) {
                fs.writeFileSync(path.join(root, 'bad.js'), `require('${spec}');\n`);
                assert.throws(() => bundle(path.join(root, 'bad.js'), [], { root }), /in the bot's folder/, spec);
            }
            assert.throws(() => bundle(outside, [], { root }), /must be inside/);
        } finally {
            fs.rmSync(outside, { force: true });
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('build() says which lines of the script hold which file, so an error names the bot\'s own file and line', async () => {
    const fs = require('fs');
    const os = require('os');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-lines-'));
    try {
        fs.writeFileSync(path.join(root, 'bot.js'), "const { serve } = require('./stdio');\nconst { pick } = require('./lib/pick');\nserve({ decide(msg) { return { t: 'act', i: pick(msg) }; } });\n");
        fs.mkdirSync(path.join(root, 'lib'));
        fs.writeFileSync(path.join(root, 'lib', 'pick.js'), "// picks the first action\nfunction pick(msg) {\n    if (msg.seq === 2) {\n        throw new Error('no pick for ' + msg.seq);\n    }\n    return 0;\n}\nmodule.exports = { pick };\n");
        // as intake.js pack puts the arena's serve() next to the entry
        fs.copyFileSync(path.join(ROOT, 'bot', 'compiled', 'js', 'serve.js'), path.join(root, 'stdio.js'));
        const { script, sources } = build(path.join(root, 'bot.js'), ['me'], { root });
        assert.strictEqual(script, bundle(path.join(root, 'bot.js'), ['me'], { root }));
        assert.deepStrictEqual(sources.map((x) => x[2]), ['bot.js', 'stdio.js', 'lib/pick.js']);
        const lines = script.split('\n');
        for (const [from, to, file] of sources) {
            const own = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
            assert.deepStrictEqual(lines.slice(from - 1, to), own, file);
        }
        const pickAt = sources[2][0];
        assert.strictEqual(sourcePositions(`x function.mjs:${pickAt + 3}:9 y function.mjs:${pickAt + 3} z function.mjs:1:1`, sources), 'x lib/pick.js:4:9 y lib/pick.js:4 z function.mjs:1:1');
        // run as Javy names the script: the reply says where the error was thrown, and stderr gets the stack
        const logged = [];
        const got = await runBundled(script, [hello, decide(1), decide(2)], undefined, { filename: 'function.mjs', log: (...a) => logged.push(a.join(' ')) });
        assert.deepStrictEqual(got.slice(0, 2), [{ t: 'ready', v: 2 }, { t: 'act', i: 0 }]);
        assert.match(got[2].error, /^no pick for 2 \(at lib\/pick\.js:4:\d+\)$/);
        assert.match(logged.join('\n'), /no pick for 2\n\s*at pick \(lib\/pick\.js:4:\d+\)\n\s*at (Object\.)?decide \(bot\.js:3:\d+\)/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
