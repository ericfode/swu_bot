'use strict';
// Trusted data and a fake protocol client only: no engine or guest program is executed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const choice = require('../arena/deck-choice');
const { dealDecks, normalizeDeck } = require('../decklists');
const { checkChosenDecks, gameDecks } = require('../arena/play-seed');
const dev = require('../dev');
const deck = (name = 'chosen', leader = 'SOR_005') => ({ metadata: { name }, leader: { id: leader, count: 1 },
    base: { id: 'SOR_029', count: 1 }, deck: Array.from({ length: 17 }, (_, i) => ({ id: `SHD_${100 + i}`, count: i === 16 ? 2 : 3 })) });
const lookups = { known: (id) => /^(SOR_005|SOR_006|SOR_029|SHD_1\d\d)$/.test(id),
    implemented: (id) => id !== 'SHD_199', types: (id) => id.startsWith('SHD_') ? ['unit'] : id === 'SOR_029' ? ['base'] : ['leader'] };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chosen-deck-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const bundle = (extra = {}) => { const p = fs.mkdtempSync(path.join(root, 'bundle-')); fs.writeFileSync(path.join(p, 'arena.json'), JSON.stringify({ protocol: 2, ...extra }) + '\n'); return p; };
const bytes = (p) => fs.readFileSync(path.join(p, 'arena.json'));

test('catalog discovery resolves exact names and returns normalized complete lists', () => {
    const found = choice.describe().decks;
    assert.ok(found.length > 10);
    const selected = choice.describe({ name: found[0].name }).deck;
    assert.equal(selected.metadata.name, found[0].name);
    assert.equal(selected.deck.reduce((n, c) => n + c.count, 0), found[0].cards);
    assert.throws(() => choice.selection('unknown'), /unknown catalog/);
    assert.equal(choice.selection(undefined), null);
});

test('explicit decks reject invalid cards, types, copies, sizes and sideboards', () => {
    assert.equal(choice.validate(deck(), lookups).schema, choice.SCHEMA);
    for (const [d, why] of [
        [deck('unknown', 'SOR_999'), /not in the card data/],
        [{ ...deck(), leader: { id: 'SHD_100' } }, /not a leader/],
        [{ ...deck(), deck: [{ id: 'SHD_100', count: 50 }] }, /copies/],
        [{ ...deck(), deck: [{ id: 'SHD_100', count: 3 }] }, /main deck has 3/],
        [{ ...deck(), deck: [...deck().deck, { id: 'SHD_199', count: 1 }] }, /no implementation/],
        [{ ...deck(), sideboard: [{ id: 'SHD_100', count: 1 }] }, /sideboards/],
        [{ ...deck(), deck: [{ id: '../secret', count: 50 }] }, /invalid deck/]
    ]) assert.throws(() => choice.validate(d, lookups), why);
});

test('omission preserves exact manifest bytes; selection changes frozen identity before checking', () => {
    const p = bundle(); const before = bytes(p);
    assert.equal(choice.prepareBundle(p, undefined, { lookups }), null);
    assert.deepEqual(bytes(p), before);
    const selected = choice.prepareBundle(p, deck(), { lookups });
    assert.equal(selected.sha256, choice.digest(deck()));
    assert.notEqual(crypto.createHash('sha256').update(bytes(p)).digest('hex'), crypto.createHash('sha256').update(before).digest('hex'));
    const frozen = bytes(p);
    assert.deepEqual(choice.prepareBundle(p, undefined, { lookups }), selected);
    assert.deepEqual(bytes(p), frozen, 'an existing valid binding is not rewritten');
    assert.deepEqual(choice.verifyRequested(p, deck()), selected);
    assert.throws(() => choice.prepareBundle(p, deck('other', 'SOR_006'), { lookups }), /conflicts/);
    assert.throws(() => choice.verifyRequested(p, deck('other', 'SOR_006')), /requested deck/);
    assert.deepEqual(bytes(p), frozen, 'rejected choices do not alter a frozen bundle');
    assert.throws(() => choice.binding({ ...selected, sha256: '0'.repeat(64) }), /digest differs/);
});

const games = [0, 1, 2, 7].flatMap((seed) => [{ id: `a-b-${seed}`, seed, p1: 'a-v1', p2: 'b-v1' }, { id: `b-a-${seed}`, seed, p1: 'b-v1', p2: 'a-v1' }]);
const base = { file: 'decks.json', sha256: 'a'.repeat(64), names: ['default0', 'default1', 'default2'], lists: ['default0', 'default1', 'default2'].map((n) => normalizeDeck(deck(n))) };
test('selection stays with the version across seats and leaves the other seat default unchanged', () => {
    const frozen = choice.validate(deck('custom', 'SOR_006'), lookups);
    const d = choice.withChoices(base, { 'a-v1': frozen, 'b-v1': null });
    choice.checkChoices(d, ['a-v1', 'b-v1']);
    const original = dealDecks(games, base.lists.length, 0, { by: 'seat' });
    const selected = choice.applyChoices(dealDecks(games, d.poolSize, 0, { by: 'seat' }), d.choices);
    for (const [n, g] of selected.entries()) for (const [seat, bot] of [g.p1, g.p2].entries()) {
        if (bot === 'a-v1') assert.equal(choice.digest(d.lists[g.decks[seat]]), frozen.sha256);
        else assert.equal(g.decks[seat], original[n].decks[seat]);
    }
    assert.equal(choice.withChoices(base, { 'a-v1': null }), base);
    assert.throws(() => choice.checkChoices(d, ['b-v1']), /choice/);
});

test('runner rejects substituted selected decks before any bot or engine starts; hello uses actual job decks', async () => {
    const frozen = choice.validate(deck('custom', 'SOR_006'), lookups);
    const d = choice.withChoices(base, { 'a-v1': frozen });
    const selected = choice.applyChoices(dealDecks(games.slice(0, 2), d.poolSize, 0, { by: 'seat' }), d.choices);
    const job = { games: selected, decks: d.lists };
    assert.doesNotThrow(() => checkChosenDecks(job, { 'a-v1': frozen }));
    assert.throws(() => checkChosenDecks({ ...job, games: [{ ...selected[0], decks: [0, 1] }] }, { 'a-v1': frozen }), /deck/);
    // Load the real protocol module with engine-only dependencies stubbed; hello does not need a rules engine.
    const { Module, createRequire } = require('node:module');
    const protocolFile = require.resolve('../protocol');
    const nativeRequire = createRequire(protocolFile);
    const loaded = new Module(protocolFile, module);
    loaded.filename = protocolFile;
    loaded.require = (id) => id === './env' || id === './view' ? {} : id.endsWith('/game/core/Constants.js') ? { DeckZoneDestination: {} } : nativeRequire(id);
    loaded._compile(fs.readFileSync(protocolFile, 'utf8'), protocolFile);
    const { seatFor } = loaded.exports;
    for (const g of selected) {
        const decks = gameDecks(job, g);
        for (const seat of ['p1', 'p2']) {
            let hello;
            const client = { name: g[seat], hello: async (q) => { hello = q; return { t: 'ready', v: 2 }; }, decide: () => assert.fail('hello only'), close() {} };
            const s = seatFor(client, seat, { players: [], decks, cards: [], botSeed: 17, requiredProtocol: 2, deals: () => () => 0.5 });
            await s.hello();
            assert.equal(s.v, 2); assert.deepEqual(hello.versions, [2]);
            assert.deepEqual(hello.deck, decks[seat]);
            if (g[seat] === 'a-v1') assert.equal(choice.digest(hello.deck), frozen.sha256);
        }
    }
});

test('local harness accepts catalog names and SWUDB JSON, rejects unknown choices and keeps omission optional', () => {
    const args = ['mybot', '--owner', 'kim', '--games', '0'];
    const name = choice.catalog()[0].metadata.name;
    assert.equal(dev.parseArgs([...args, '--deck', name]).deck.metadata.name, name);
    const file = path.join(root, 'deck.json'); fs.writeFileSync(file, JSON.stringify(deck()));
    assert.deepEqual(dev.parseArgs([...args, '--deck', file]).deck, normalizeDeck(deck()));
    assert.equal(dev.parseArgs(args).deck, undefined);
    assert.throws(() => dev.parseArgs([...args, '--deck', 'missing']), /unknown catalog/);
    assert.throws(() => dev.parseArgs(['mybot', '--owner', 'kim', '--again', 'trace', '--deck', name]), /no --deck/);
});

test('stdio MCP advertises the same deck discovery and accepts the explicit WASM deck schema', () => {
    const { spawnSync } = require('node:child_process');
    const messages = [{ jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'arena_decks', arguments: {} } }];
    const r = spawnSync(process.execPath, [path.join(__dirname, '../arena/mcp.js')], {
        input: messages.map((m) => JSON.stringify(m)).join('\n') + '\n', encoding: 'utf8', timeout: 10000,
        env: { PATH: process.env.PATH, ARENA_ID: 'open', ARENA_HOME: path.join(root, 'arena'), ARENA_RESULTS: path.join(root, 'results'), ARENA_DASH: path.join(root, 'dash') }
    });
    assert.equal(r.status, 0, r.stderr);
    const replies = r.stdout.trim().split('\n').map((s) => JSON.parse(s));
    const tools = replies.find((m) => m.id === 1).result.tools;
    assert.ok(tools.find((t) => t.name === 'arena_decks').annotations.readOnlyHint);
    assert.deepEqual(tools.find((t) => t.name === 'arena_submit').inputSchema.properties.deck.anyOf, [{ type: 'string' }, { type: 'object' }]);
    const result = JSON.parse(replies.find((m) => m.id === 2).result.content[0].text);
    assert.deepEqual(result.decks, choice.describe().decks);
});
