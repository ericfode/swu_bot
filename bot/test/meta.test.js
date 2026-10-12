'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { canonical, view, fitLogistic, SITUATIONS, readReplay } = require('../../meta/analyze');
const { grade } = require('../../meta/grade');

test('canonical merges random seeds and moves pre-fix heuristic games to legacy', () => {
    assert.strictEqual(canonical('random-b', {}), 'random');
    assert.strictEqual(canonical('legacy', { fixedEra: true }), 'legacy');
    assert.strictEqual(canonical('heuristic', { fixedEra: true }), 'heuristic');
    assert.strictEqual(canonical('tempo', { fixedEra: true }), 'tempo');
    assert.strictEqual(canonical('heuristic', { fixedEra: false }), 'legacy');
    assert.strictEqual(canonical('tempo', { fixedEra: false }), 'legacy-tempo');
    assert.strictEqual(canonical('rush', { fixedEra: false }), 'rush');
});

test('view reads a snapshot from one player', () => {
    const side = (d, units, hand) => ({ base: { hp: 30, d }, ground: units, space: [], hand: new Array(hand).fill({}), res: { total: 4 } });
    const state = { round: 4, initiative: 'p2', players: { p1: side(10, [{ p: 3, h: 4, d: 1 }], 2), p2: side(2, [], 5) } };
    const x = view(state, 'p1');
    assert.deepStrictEqual([x.myBase, x.oppBase, x.baseLead, x.boardLead, x.hpLead, x.handLead, x.initiative], [20, 28, -8, 3, 3, -3, 0]);
    const behind = SITUATIONS.find((s) => s.id === 'base_behind');
    assert.ok(behind.test(x));
});

test('readReplay reads round starts and style from a recording', () => {
    const side = (d, units) => ({ base: { n: 'Base', hp: 30, d }, ground: units, space: [], hand: [], res: { total: 3 } });
    const step = (n, round, p2Units) => ({ t: 'step', n, state: { round, phase: 'action', initiative: 'p1', players: { p1: side(0, [{ p: 2, h: 3, d: 0 }]), p2: side(n, p2Units) } } });
    // p1 attacks: the step after its decision shows p2's unit gone and 1 more damage on p2's base.
    const attack = { ...step(2, 2, []), pid: 'p1', prompt: 'actionWindow', title: 'Choose a target for attack', action: { kind: 'card', label: 'Base' } };
    const lines = [{ t: 'header', v: 1 }, step(1, 1, [{ p: 1, h: 1, d: 0 }]), attack, { t: 'end', winner: 'p1', round: 2 }];
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'meta-')), 'g.jsonl');
    fs.writeFileSync(f, lines.map((x) => JSON.stringify(x)).join('\n'));
    const r = readReplay(f);
    assert.ok(r.end);
    assert.strictEqual(r.snaps.length, 4);
    assert.deepStrictEqual([r.style.p1.attacks, r.style.p1.baseAttacks, r.style.p1.kills, r.style.p1.baseDmg], [1, 1, 1, 1]);
});

test('fitLogistic learns that a base lead wins', () => {
    const rows = [];
    for (let i = -10; i <= 10; i++) for (let k = 0; k < 5; k++) {
        rows.push({ x: { baseLead: i, boardLead: 0, hpLead: 0, handLead: 0, resLead: 0, initiative: 0, rd: 0 }, y: i + (k - 2) > 0 ? 1 : 0 });
    }
    const m = fitLogistic(rows);
    const at = (lead) => m.predict({ baseLead: lead, boardLead: 0, hpLead: 0, handLead: 0, resLead: 0, initiative: 0, rd: 0 });
    assert.ok(at(8) > 0.8 && at(-8) < 0.2);
});

test('grade matches bot names as whole words', () => {
    const quiz = { questions: [{ id: 'q', kind: 'one-of', key: ['rush'] }, { id: 'c', kind: 'all-of', key: ['a-v0', 'b-v0'] }], essence: { Behind: ['omni'] } };
    const g = grade(quiz, { q: 'probably rushmore', c: 'a-v0 and b-v0', essence: 'omni wins from behind' });
    assert.strictEqual(g.rows[0].ok, 0);
    assert.strictEqual(g.rows[1].ok, 1);
    assert.strictEqual(g.essence, 1);
});
