'use strict';
// The WebAssembly bot (bot/wasm) on hand-made stdio messages: no engine and no real card data needed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WasmBot, compile, loadCards } = require('../wasm/host');

const CARDS = [
    { internalName: 'marine', title: 'Marine', cost: 2, power: 3, hp: 3, types: ['unit'], arena: 'ground', aspects: ['command'], keywords: [], setId: { set: 'TST', number: 1 } },
    { internalName: 'walker', title: 'Walker', cost: 8, power: 8, hp: 8, types: ['unit'], arena: 'ground', aspects: ['villainy', 'villainy'], keywords: [], setId: { set: 'TST', number: 2 } },
    { internalName: 'trooper', title: 'Trooper', cost: 3, power: 3, hp: 2, types: ['unit'], arena: 'ground', aspects: ['command'], keywords: [], setId: { set: 'TST', number: 3 } },
    { internalName: 'brute', title: 'Brute', cost: 5, power: 4, hp: 4, types: ['unit'], arena: 'ground', aspects: ['command'], keywords: [], setId: { set: 'TST', number: 4 } },
    { internalName: 'leader', title: 'Leader', cost: 6, power: 4, hp: 6, types: ['leader'], aspects: ['command', 'heroism'], keywords: [], setId: { set: 'TST', number: 5 } },
    { internalName: 'echo', title: 'Echo', cost: 0, hp: 30, types: ['base'], aspects: ['command'], keywords: [], setId: { set: 'TST', number: 6 } }
];

let bot;
test.before(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasm-cards-'));
    for (const c of CARDS) {
        fs.writeFileSync(path.join(dir, `${c.internalName}.json`), JSON.stringify(c));
    }
    bot = new WasmBot(await compile(), loadCards(dir));
});
// each test is a fresh game: the module remembers its last pick and the positions it has seen
test.beforeEach(() => bot.newGame(12345));

const ref = (id, n, s) => ({ id, n, s });
function state({ myUnits = [], opUnits = [], myDmg = 0, opDmg = 0, hand = [], ready = 3, total = 3 } = {}) {
    const side = (name, base, units, dmg) => ({
        name, base: { ...ref(base, 'Echo', 'TST_006'), hp: 30, d: dmg }, leader: { ...ref(`${base}L`, 'Leader', 'TST_005'), dep: 0, x: 0 },
        res: { ready, total }, handCount: 0, deck: 30, discard: [], ground: units, space: []
    });
    const p1 = side('p1', 'B1', myUnits, myDmg);
    p1.hand = hand;
    p1.handCount = hand.length;
    p1.resources = [];
    return { round: 3, phase: 'action', initiative: 'p1', players: { p1, p2: side('p2', 'B2', opUnits, opDmg) } };
}
const unit = (id, n, s, p, h, extra = {}) => ({ ...ref(id, n, s), p, h, d: 0, ...extra });
const cardAct = (i, id, n, s, zone, ctl) => ({ i, kind: 'card', label: n.toLowerCase(), cardUuid: id, card: { id, n, s, zone, ctl } });
const button = (i, label, arg) => ({ i, kind: 'button', label, arg: arg ?? label.toLowerCase() });
let seq = 0;
const decide = (prompt, st, actions) => bot.decide({
    t: 'decide', seq: ++seq, you: 'p1',
    prompt: { type: null, signature: '-', title: '', promptTitle: '', selectCardMode: null, selected: [], actionWindow: false, ...prompt },
    state: st, actions
});
const window = (st, actions) => decide({ type: 'actionWindow', title: 'Choose an action', actionWindow: true }, st, actions);

test('goes for lethal before playing a card', () => {
    const st = state({ myUnits: [unit('C1', 'Marine', 'TST_001', 3, 3)], opDmg: 28, hand: [ref('C9', 'Brute', 'TST_004')], ready: 5, total: 5 });
    const acts = [button(0, 'Pass'), cardAct(1, 'C9', 'Brute', 'TST_004', 'hand', 'p1'), cardAct(2, 'C1', 'Marine', 'TST_001', 'groundArena', 'p1')];
    assert.strictEqual(window(st, acts).i, 2);
    const target = decide({ title: 'Choose a target for attack', promptTitle: 'Marine', selectCardMode: 'single' }, st,
        [button(0, 'Cancel'), cardAct(1, 'B2', 'Echo', 'TST_006', 'base', 'p2')]);
    assert.strictEqual(target.i, 1);
});

test('two units gang up on a big ready enemy that neither kills alone', () => {
    // 4 + 4 power against 7 hp: neither attack kills alone, both survive the 4 damage back
    const st = state({
        myUnits: [unit('C1', 'Brute', 'TST_004', 4, 6), unit('C2', 'Brute', 'TST_004', 4, 6)],
        opUnits: [unit('C5', 'Walker', 'TST_002', 4, 7)]
    });
    const acts = [button(0, 'Pass'), cardAct(1, 'C1', 'Brute', 'TST_004', 'groundArena', 'p1'), cardAct(2, 'C2', 'Brute', 'TST_004', 'groundArena', 'p1')];
    const pick = window(st, acts).i;
    assert.ok(pick === 1 || pick === 2);
    const target = decide({ title: 'Choose a target for attack', promptTitle: 'Brute', selectCardMode: 'single' }, st,
        [button(0, 'Cancel'), cardAct(1, 'C5', 'Walker', 'TST_002', 'groundArena', 'p2'), cardAct(2, 'B2', 'Echo', 'TST_006', 'base', 'p2')]);
    assert.strictEqual(target.i, 1, 'follows the plan onto the enemy unit');
});

test('does not trade two units for one', () => {
    // killing the 4/5 takes both attackers, and it hits back hard enough to kill each of them
    const st = state({
        myUnits: [unit('C1', 'Marine', 'TST_001', 3, 3), unit('C2', 'Trooper', 'TST_003', 3, 2)],
        opUnits: [unit('C5', 'Brute', 'TST_004', 4, 5)]
    });
    const acts = [button(0, 'Pass'), cardAct(1, 'C1', 'Marine', 'TST_001', 'groundArena', 'p1'), cardAct(2, 'C2', 'Trooper', 'TST_003', 'groundArena', 'p1')];
    const pick = window(st, acts).i;
    const target = decide({ title: 'Choose a target for attack', promptTitle: pick === 1 ? 'Marine' : 'Trooper', selectCardMode: 'single' }, st,
        [button(0, 'Cancel'), cardAct(1, 'C5', 'Brute', 'TST_004', 'groundArena', 'p2'), cardAct(2, 'B2', 'Echo', 'TST_006', 'base', 'p2')]);
    assert.strictEqual(target.i, 2);
});

test('kills a ready enemy unit rather than chipping the base', () => {
    const st = state({ myUnits: [unit('C1', 'Brute', 'TST_004', 4, 4)], opUnits: [unit('C5', 'Trooper', 'TST_003', 3, 2)] });
    const target = decide({ title: 'Choose a target for attack', promptTitle: 'Brute', selectCardMode: 'single' }, st,
        [button(0, 'Cancel'), cardAct(1, 'B2', 'Echo', 'TST_006', 'base', 'p2'), cardAct(2, 'C5', 'Trooper', 'TST_003', 'groundArena', 'p2')]);
    assert.strictEqual(target.i, 2);
});

test('damage prompts hit enemies and spare friendly units', () => {
    const st = state({ myUnits: [unit('C1', 'Marine', 'TST_001', 3, 3)], opUnits: [unit('C5', 'Trooper', 'TST_003', 3, 2)] });
    const pick = decide({ title: 'Deal 2 damage to a unit', promptTitle: 'Blast', selectCardMode: 'single' }, st,
        [cardAct(0, 'C1', 'Marine', 'TST_001', 'groundArena', 'p1'), cardAct(1, 'C5', 'Trooper', 'TST_003', 'groundArena', 'p2')]);
    assert.strictEqual(pick.i, 1);
    const cancel = decide({ title: 'Defeat a unit with 3 or less remaining HP', promptTitle: 'Takedown', selectCardMode: 'single' }, state({ myUnits: [unit('C1', 'Marine', 'TST_001', 3, 3)] }),
        [button(0, 'Cancel'), cardAct(1, 'C1', 'Marine', 'TST_001', 'groundArena', 'p1')]);
    assert.strictEqual(cancel.i, 0, 'cancels instead of defeating its own unit');
});

test('splits damage to kill what it can and sends the rest to the base', () => {
    const st = state({ opUnits: [unit('C5', 'Trooper', 'TST_003', 3, 2), unit('C6', 'Walker', 'TST_002', 8, 8)] });
    const reply = decide({ type: 'distributeAmongTargets', title: 'Distribute 3 damage among targets' }, st, [{
        i: 0, kind: 'distribute', label: 'distribute 3',
        distribute: { type: 'damage', amount: 3, canDistributeLess: false, canChooseNoTargets: false, maxTargets: null, tokenType: null,
            targets: [{ id: 'C6', cap: null }, { id: 'C5', cap: null }, { id: 'B2', cap: null }] }
    }]);
    assert.deepStrictEqual(reply.distribution, [{ id: 'C5', amount: 2 }, { id: 'B2', amount: 1 }]);
});

test('resources the expensive off-aspect card and keeps the cheap unit', () => {
    const st = state({ hand: [ref('C1', 'Marine', 'TST_001'), ref('C2', 'Walker', 'TST_002')], ready: 0, total: 0 });
    st.phase = 'setup';
    const pick = decide({ type: 'resource', title: 'Select 1 cards to resource', promptTitle: 'Resource Step', selectCardMode: 'multiple' }, st,
        [cardAct(0, 'C1', 'Marine', 'TST_001', 'hand', 'p1'), cardAct(1, 'C2', 'Walker', 'TST_002', 'hand', 'p1')]);
    assert.strictEqual(pick.i, 1);
});

test('search prompts: picks distinct cards up to the limit, then Done', () => {
    const st = state();
    const disp = (i, id, label) => ({ i, kind: 'displayCard', label, arg: id });
    const acts = [button(0, 'Done'), disp(1, 'C1', 'marine'), disp(2, 'C2', 'walker'), disp(3, 'C3', 'trooper')];
    const prompt = { type: 'displayCards', title: 'Select up to 2 cards', promptTitle: 'Search' };
    const a = decide(prompt, st, acts).i;
    const b = decide(prompt, st, acts).i;
    const c = decide(prompt, st, acts).i;
    assert.notStrictEqual(a, 0);
    assert.notStrictEqual(b, 0);
    assert.notStrictEqual(a, b);
    assert.strictEqual(c, 0);
});

test('does not repeat a click that changed nothing', () => {
    const st = state({ hand: [ref('C9', 'Brute', 'TST_004')], ready: 5, total: 5 });
    const acts = [button(0, 'Pass'), cardAct(1, 'C9', 'Brute', 'TST_004', 'hand', 'p1')];
    assert.strictEqual(window(st, acts).i, 1);
    assert.strictEqual(window(st, acts).i, 0, 'same position again: the play was cancelled, so pass');
});

test('multi-select: a click the prompt does not take is not repeated', () => {
    const st = state({ opUnits: [unit('C5', 'Trooper', 'TST_003', 3, 2), unit('C6', 'Marine', 'TST_001', 3, 3)] });
    const acts = [button(0, 'Done'), cardAct(1, 'C5', 'Trooper', 'TST_003', 'groundArena', 'p2'), cardAct(2, 'C6', 'Marine', 'TST_001', 'groundArena', 'p2')];
    const prompt = { title: 'Choose units to deal 1 damage to', promptTitle: 'Blast', selectCardMode: 'multiple' };
    const a = decide(prompt, st, acts).i;
    const b = decide(prompt, st, acts).i;
    assert.ok(a > 0 && b > 0 && a !== b);
    assert.strictEqual(decide(prompt, st, acts).i, 0);
});
