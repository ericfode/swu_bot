'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validatePool } = require('../inventory');
const lib = require('../reference/library');
const catalog = require('../catalog');
test('stale pools fail even when catalogue and admission agree', () => {
    const catalogue = { cards: [{ setCode: 'A', card: { internalName: 'a', power: 2 } }] };
    const admission = { runtimeAdmittedCards: [{ setCode: 'A' }] };
    const pool = { schema: 'omni-rs-pool-v1', cards: [{ setCode: 'A', internalName: 'a', power: 2 }] };
    validatePool(catalogue, admission, pool);
    assert.throws(() => validatePool(catalogue, admission, { ...pool, cards: [] }), /inventory mismatch/);
    assert.throws(() => validatePool(catalogue, admission, { ...pool, cards: [{ ...pool.cards[0], power: 3 }] }), /metadata mismatch/);
    assert.throws(() => validatePool(catalogue, admission, { ...pool, cards: [pool.cards[0], pool.cards[0]] }), /Duplicate/);
});

test('catalog joins current metadata, support and focused or setup reference cases', () => {
    const data = catalog.load(), c = catalog.card('TWI_124', data);
    assert.equal(c.setCode, 'TWI_124'); assert.equal(typeof c.runtime.admitted, 'boolean');
    assert.ok(c.tests.length); assert.ok(c.tests.every(t => ['setup','focus'].includes(t.relationship)));
    assert.ok(catalog.behaviors(data).testFamilies.length);
    const play = lib.definition('card-play/TS26_020'); assert.equal(play.kind, 'play');
    assert.ok(lib.selectCases({ card: 'TS26_020' }, data.cases, data.corpus.recordings).some(c => c.id === play.id));
});
test('reference corpus preserves all indexed bytes and links the actual engine metadata', () => {
    const result = lib.verify(); assert.ok(result.recordings > 0);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swu-reference-test-'));
    try {
        fs.symlinkSync(path.join(lib.defaultCorpus, 'pools'), path.join(temp, 'pools'));
        fs.symlinkSync(path.join(lib.defaultCorpus, 'traces'), path.join(temp, 'traces'));
        const manifest = lib.corpus(); manifest.recordings[0].seed++;
        fs.writeFileSync(path.join(temp, 'manifest.json'), JSON.stringify(manifest));
        assert.throws(() => lib.verify(temp), /seed differs/);
        const correct = lib.corpus(); correct.recordings[0].caseId = 'card-play/SOR_031';
        fs.writeFileSync(path.join(temp, 'manifest.json'), JSON.stringify(correct));
        assert.throws(() => lib.verify(temp), /Scenario differs|Reference case differs/);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
