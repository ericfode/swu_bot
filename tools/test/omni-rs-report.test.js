'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compare } = require('../omni-rs-report');

test('Rust proof measurements join by game and window even when output is reordered', () => {
    const positions = [
        { game: 'a', i: 0, fromEnd: 5, proven: 'p1', jsNodes: 10, jsMs: 20 },
        { game: 'a', i: 1, fromEnd: 4, proven: 'p2', jsNodes: 20, jsMs: 30 },
        { game: 'b', i: 0, fromEnd: 1, proven: null, jsNodes: 0, jsMs: 0 }
    ];
    const rust = [{ game: 'b', i: 0, result: null }, { game: 'a', i: 1, result: 'p1' }, { game: 'a', i: 0, result: 'p1' }];
    const r = compare(positions, rust);
    assert.equal(r.agreement.bothProved, 2);
    assert.deepEqual(r.agreement.disagreements, [{ game: 'a', i: 1, fromEnd: 4, js: 'p2', rust: 'p1' }]);
    assert.deepEqual(r.horizon.rust.perGame, { b: 0, a: 5 });
    assert.equal(r.horizon.rust.mean, 2.5); // games with no proof remain in the denominator
    assert.equal(r.speed.jsMsPerNode, 50 / 30);
});

test('Missing results stay visible and duplicate or unrecognized identities fail', () => {
    const p = [{ game: 'a', i: 0, fromEnd: 1, proven: null }];
    assert.equal(compare(p, []).agreement.missing.length, 1);
    assert.throws(() => compare(p, [{ game: 'x', i: 0, result: 'p1' }]), /no input position/);
    assert.throws(() => compare(p, [{ game: 'a', i: 0 }, { game: 'a', i: 0 }]), /Duplicate/);
    assert.throws(() => compare([{ game: 'a', fromEnd: 1 }], []), /integer i/);
});
