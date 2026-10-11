'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseKeywords } = require('../omni/rs/make-pool');
const { loadPool, verifyPool } = require('../omni/rs/pool');
const { canonicalAction, expandActions, stateHash } = require('../omni/rs/state');
const eg = { game: { state: { allCards: ['uuid-one', 'uuid-two'] } }, cardId: (id) => ({ 'uuid-one': 'c0', 'uuid-two': 'c1' })[id] ?? id };

test('pool keywords parse numbers from rules text and reject additional effects', () => {
    assert.deepEqual(parseKeywords({ text: 'Raid 2 (While attacking, this unit gets +2/+0.)\nOverwhelm', keywords: ['raid', 'overwhelm'] }), { raid: 2, overwhelm: 1 });
    assert.deepEqual(parseKeywords({ text: null }), {});
    assert.equal(parseKeywords({ text: 'Raid 2. When Played: Draw a card.', keywords: ['raid'] }), null);
    assert.equal(parseKeywords({ text: 'Coordinate — Sentinel', keywords: ['coordinate', 'sentinel'] }), null);
    assert.equal(parseKeywords({ text: 'Raid' }), null);
    assert.equal(parseKeywords({ text: 'Sentinel 2' }), null);
    assert.equal(parseKeywords({ text: 'Sentinel', pilotText: 'Piloting [2]' }), null);
});

test('pool provenance checks exact bytes and permits relocation without changing content', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-pool-'));
    try {
        const a = path.join(dir, 'a.json');
        const b = path.join(dir, 'b.json');
        const body = JSON.stringify({ schema: 'omni-rs-pool-v1', cards: [{ setCode: 'SOR_014' }] });
        fs.writeFileSync(a, body); fs.writeFileSync(b, body);
        const pool = loadPool(a);
        assert.equal(verifyPool(pool.provenance, b).provenance.sha256, pool.provenance.sha256);
        fs.appendFileSync(b, '\n');
        assert.throws(() => verifyPool(pool.provenance, b), /hash mismatch/);
        assert.throws(() => verifyPool(null, b), /unrestricted deal/);
        fs.writeFileSync(b, JSON.stringify({ schema: 'omni-rs-pool-v1', cards: [{ setCode: 'SOR_014' }, { setCode: 'SOR_014' }] }));
        assert.throws(() => loadPool(b), /duplicate pool card/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('canonical keys distinguish cards, labels, methods and normalize engine card UUIDs', () => {
    const card = { kind: 'card', cardUuid: 'uuid-one', label: 'trooper' };
    const key = canonicalAction(eg, card).key;
    assert.equal(key, '["card","c0",null,null,"trooper"]');
    assert.notEqual(key, canonicalAction(eg, { ...card, cardUuid: 'uuid-two' }).key);
    assert.notEqual(key, canonicalAction(eg, { ...card, label: 'trooper|other' }).key);
    assert.notEqual(key, canonicalAction(eg, { ...card, method: 'menuButton' }).key);
    assert.equal(canonicalAction(eg, { kind: 'displayCard', arg: 'uuid-one', label: 'trooper' }).arg, 'c0');
    assert.throws(() => expandActions(eg, [card, card]), /collision/);
});

test('Satine distribution records all concrete choices including zero and refuses other effects', () => {
    const heal = { kind: 'distribute', label: 'distribute 2', spec: { type: 'distributeHealing', amount: 2, canDistributeLess: true, maxTargets: 1 }, targets: ['uuid-one', 'uuid-two'], caps: [Infinity, Infinity] };
    const actions = expandActions(eg, [heal]);
    assert.equal(actions.length, 5);
    assert.deepEqual(actions.map((a) => canonicalAction(eg, a).arg), [[], [['c0', 1]], [['c0', 2]], [['c1', 1]], [['c1', 2]]]);
    assert.throws(() => expandActions(eg, [{ ...heal, spec: { ...heal.spec, type: 'distributeDamage' } }]), /unsupported distribution/);
});

test('committed pool has exactly the reviewed cards and covers each supported keyword', () => {
    const pool = loadPool(path.join(__dirname, '../omni/rs/pool.json'));
    assert.equal(pool.cards.length, 100);
    assert.deepEqual(pool.cards.filter((c) => c.types.includes('leader')).map((c) => c.setCode), ['SOR_014', 'IBH_053', 'SEC_005']);
    for (const c of pool.cards.filter((c) => c.types.includes('unit'))) {
        assert.notEqual(parseKeywords(c), null, c.setCode);
        assert.deepEqual(parseKeywords(c), c.keywordValues, c.setCode);
    }
    for (const k of ['sentinel', 'raid', 'overwhelm', 'saboteur', 'restore', 'ambush', 'grit', 'shielded']) {
        assert(pool.cards.some((c) => c.keywordValues[k]), k);
    }
    for (const l of pool.cards.filter((c) => c.types.includes('leader'))) {
        for (const b of pool.cards.filter((c) => c.types.includes('base'))) {
            const aspects = new Set([...l.aspects, ...b.aspects]);
            const capacity = pool.cards.filter((c) => c.types.includes('unit') && c.aspects.every((a) => aspects.has(a))).reduce((n, c) => n + (c.unique ? 1 : 3), 0);
            assert(capacity >= 50, `${l.setCode}/${b.setCode}`);
        }
    }
});

test('state hashes preserve card order while ignoring object insertion order', () => {
    assert.equal(stateHash({ round: 1, hand: ['c1', 'c2'] }), stateHash({ hand: ['c1', 'c2'], round: 1 }));
    assert.notEqual(stateHash({ hand: ['c1', 'c2'] }), stateHash({ hand: ['c2', 'c1'] }));
    assert.notEqual(stateHash({ resources: [{ id: 'c1', exhausted: false }] }), stateHash({ resources: [{ id: 'c1', exhausted: true }] }));
});
