'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
    path = require('node:path'),
    os = require('node:os');
const { compileCatalog } = require('../build');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swu-provenance-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'server'),
        cards = path.join(root, 'data');
    fs.mkdirSync(path.join(source, 'game/cards'), { recursive: true });
    fs.mkdirSync(path.join(source, 'game/core'), { recursive: true });
    fs.mkdirSync(path.join(cards, 'Card'), { recursive: true });
    fs.writeFileSync(path.join(source, 'game/core/Constants.ts'), 'export enum WildcardCardType { Unit = "unit" }');
    fs.writeFileSync(
        path.join(source, 'game/cards/ProbeUnit.ts'),
        `export default class ProbeUnit extends NonLeaderUnitCard {
      getImplementationId(){ return {id:'probe',internalName:'probe-unit'}; }
      setupCardAbilities(registrar, AbilityHelper){ registrar.addWhenPlayedAbility({ title:'Draw a card', immediateEffect:AbilityHelper.immediateEffects.draw({amount:1}) }); }
    }`,
    );
    fs.writeFileSync(path.join(cards, '_mockCardNames.json'), '[]');
    fs.writeFileSync(
        path.join(cards, 'Card/probe-unit.json'),
        JSON.stringify({
            id: 'probe',
            internalName: 'probe-unit',
            types: ['unit'],
            keywords: [],
            aspects: [],
            traits: [],
            text: 'When Played: Draw a card.',
            hp: 3,
            power: 2,
            cost: 2,
            arena: 'ground',
            setId: { set: 'TST', number: 1 },
        }),
    );
    return { source, cards };
}
test('legacy server JavaScript helper changes alter provenance without altering card IR', (t) => {
    const f = fixture(t),
        helper = path.join(f.source, 'game/core/prompt.js');
    fs.writeFileSync(helper, 'module.exports = { optionalPrompt: true };\n');
    const before = compileCatalog(f);
    assert.equal(before.cards[0].status, 'supported');
    assert.ok(before.inputs.some((i) => i.file === 'server/game/core/prompt.js'));
    fs.writeFileSync(helper, 'module.exports = { optionalPrompt: false };\n');
    const after = compileCatalog(f);
    assert.notEqual(before.sourceTreeHash, after.sourceTreeHash);
    assert.notDeepEqual(before.inputs, after.inputs);
    assert.deepEqual(before.cards, after.cards, 'Helper provenance change must preserve emitted cards and IR');
    assert.deepEqual(compileCatalog(f), after, 'Identical inputs are deterministic');
});
test('JavaScript helper addition and removal enter and leave the sorted input inventory', (t) => {
    const f = fixture(t),
        before = compileCatalog(f),
        helper = path.join(f.source, 'socket.js');
    fs.writeFileSync(helper, 'module.exports = {};\n');
    const added = compileCatalog(f);
    assert.notEqual(before.sourceTreeHash, added.sourceTreeHash);
    assert.equal(added.inputs.length, before.inputs.length + 1);
    assert.deepEqual(
        added.inputs.map((i) => i.file),
        added.inputs.map((i) => i.file).sort((a, b) => a.localeCompare(b)),
    );
    fs.unlinkSync(helper);
    assert.deepEqual(compileCatalog(f), before);
});
