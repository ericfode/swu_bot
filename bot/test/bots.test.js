'use strict';
// Bot logic against mock game objects (needs forceteki/build for the require chain, but no card data).
const test = require('node:test');
const assert = require('node:assert');
const { evaluate } = require('../players/heuristic');
const { PROFILES } = require('../players/profiles');
const { createRushBot } = require('../players/rush');
const { makeBot, describeBot } = require('../players');

function unit(power, hp, { damage = 0, cost = 2, exhausted = false, controller = null } = {}) {
    return {
        getPower: () => power, getHp: () => hp, remainingHp: hp - damage, cost, exhausted, upgrades: [],
        hasSomeKeyword: () => false, isUnit: () => true, isBase: () => false, isLeader: () => false,
        zoneName: 'groundArena', controller
    };
}
function player({ baseHp = 30, baseDamage = 0, units = [], hand = 3, resources = 3, initiative = false } = {}) {
    const p = {
        base: { getHp: () => baseHp, damage: baseDamage, isBase: () => true, isUnit: () => false },
        getArenaUnits: () => units, hand: new Array(hand), resources: new Array(resources), hasInitiative: () => initiative
    };
    p.base.controller = p;
    units.forEach((u) => (u.controller = p));
    return p;
}
function game(me, opp) {
    me.opponent = opp;
    opp.opponent = me;
    return { over: false, player: (pid) => (pid === 'me' ? me : opp) };
}

// the evaluation as it was before profiles existed (5123bc4), to check the balanced profile is bit-identical
function originalEvaluate() {
    const Module = require('module');
    const path = require('path');
    const { execFileSync } = require('child_process');
    const src = execFileSync('git', ['show', '5123bc4:bot/players/heuristic.js'], { cwd: __dirname, encoding: 'utf8' });
    const m = new Module(path.join(__dirname, '..', 'players', 'heuristic-orig.js'), module);
    m.filename = m.id;
    m.paths = Module._nodeModulePaths(path.dirname(m.id));
    m._compile(src, m.id);
    return m.exports.evaluate;
}

test('balanced profile reproduces the original evaluation exactly', () => {
    const orig = originalEvaluate();
    const boards = [
        [player({ units: [unit(3, 4)], baseDamage: 20 }), player({ hand: 5 })],
        [player({ units: [unit(3, 4, { damage: 1, exhausted: true }), unit(1, 7, { cost: 5 })], initiative: true }), player({ units: [unit(6, 6)], baseDamage: 27, baseHp: 28 })],
        [player({ baseDamage: 25 }), player({ baseDamage: 29, units: [unit(2, 2), unit(4, 1), unit(0, 9)] })]
    ];
    for (const [me, opp] of boards) {
        const eg = game(me, opp);
        assert.strictEqual(evaluate(eg, 'me'), orig(eg, 'me'));
        assert.strictEqual(evaluate(eg, 'me', PROFILES.balanced), orig(eg, 'me'));
        assert.strictEqual(evaluate(eg, 'opp', PROFILES.balanced), orig(eg, 'opp'));
    }
});

test('aggro values damage to the enemy base more than balanced; control values its own base more', () => {
    const delta = (profile, hurtOpp) => {
        const before = evaluate(game(player(), player()), 'me', profile);
        const after = evaluate(hurtOpp ? game(player(), player({ baseDamage: 5 })) : game(player({ baseDamage: 5 }), player()), 'me', profile);
        return Math.abs(after - before);
    };
    assert.ok(delta(PROFILES.aggro, true) > delta(PROFILES.balanced, true));
    assert.ok(delta(PROFILES.control, false) > delta(PROFILES.balanced, false));
    assert.ok(delta(PROFILES.aggro, false) < delta(PROFILES.aggro, true));
});

test('control prizes removing an enemy unit more than aggro does', () => {
    const val = (profile) => evaluate(game(player(), player()), 'me', profile) - evaluate(game(player(), player({ units: [unit(4, 5)] })), 'me', profile);
    assert.ok(val(PROFILES.control) > val(PROFILES.aggro));
});

test('rush plays its most expensive card, then attacks, then passes', () => {
    const me = player({ units: [unit(2, 3)] });
    const opp = player({ units: [unit(5, 5)] });
    const eg = game(me, opp);
    eg.round = 1;
    eg.isActionWindow = () => true;
    me.readyResourceCount = 3;
    me.currentPrompt = () => ({});
    const card = (cost) => ({ ...unit(1, 1, { cost }), zoneName: 'hand', controller: me });
    const pass = { kind: 'button', label: 'Pass' };
    const cheap = { kind: 'card', card: card(1) };
    const big = { kind: 'card', card: card(4) };
    const attacker = { kind: 'card', card: me.getArenaUnits()[0] };
    const enemy = { kind: 'card', card: opp.getArenaUnits()[0] };
    const bot = createRushBot();
    assert.strictEqual(bot.choose({ game: eg, pid: 'me', actions: [pass, cheap, attacker, big, enemy] }), big);
    me.hand.length = 2;
    assert.strictEqual(bot.choose({ game: eg, pid: 'me', actions: [pass, attacker, enemy] }), attacker);
    me.hand.length = 1;
    assert.strictEqual(bot.choose({ game: eg, pid: 'me', actions: [pass, enemy] }), pass);
});

test('rush passes instead of retrying a click that keeps getting cancelled', () => {
    const me = player({ units: [unit(2, 3)] });
    const eg = game(me, player());
    eg.round = 1;
    eg.isActionWindow = () => true;
    const pass = { kind: 'button', label: 'Pass' };
    const attacker = { kind: 'card', card: me.getArenaUnits()[0] };
    const bot = createRushBot();
    const picks = [1, 2, 3].map(() => bot.choose({ game: eg, pid: 'me', actions: [pass, attacker] }));
    assert.deepStrictEqual(picks, [attacker, attacker, pass]);
});

test('rush attacks the enemy base when it can', () => {
    const me = player();
    const opp = player({ units: [unit(1, 1)] });
    const eg = game(me, opp);
    eg.isActionWindow = () => false;
    me.currentPrompt = () => ({ menuTitle: 'Choose a target for attack' });
    const unitTarget = { kind: 'card', card: opp.getArenaUnits()[0] };
    const baseTarget = { kind: 'card', card: opp.base };
    assert.strictEqual(createRushBot().choose({ game: eg, pid: 'me', actions: [unitTarget, baseTarget] }), baseTarget);
});

test('registry resolves names, depth and #suffix', () => {
    assert.deepStrictEqual(describeBot('control-d2#b'), { name: 'control-d2#b', kind: 'search', profile: 'control', depth: 2 });
    assert.strictEqual(describeBot('heuristic').profile, 'balanced');
    assert.strictEqual(describeBot('random-a').kind, 'random');
    assert.strictEqual(makeBot('aggro').profile, PROFILES.aggro);
    assert.strictEqual(makeBot('tempo-d3').depth, 3);
    assert.throws(() => makeBot('nope'));
});
