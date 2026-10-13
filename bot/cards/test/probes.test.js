'use strict';
const test = require('node:test'),
    assert = require('node:assert/strict');
const { planCardProbes } = require('../pipeline/probes');
const catalogue = require('../../card-compiler/generated/catalog.json');
const plan = (id) =>
    planCardProbes(
        catalogue.cards.find((c) => c.setCode === id),
        { catalogue },
    );
test('phase-stat automatic probes cover both owners, arenas, damage and expiry deterministically', () => {
    const a = plan('TWI_124');
    assert.deepEqual(a, plan('TWI_124'));
    assert.equal(a.cases.filter((c) => c.probe.waitForExpiry).length, 4);
    assert.equal(a.cases.filter((c) => !c.probe.negativeOnly && !c.probe.waitForExpiry).length, 8);
    assert.ok(a.cases.some((c) => c.probe.inspectBaseInvalid));
    assert.equal(new Set(a.cases.map((c) => c.id)).size, a.cases.length);
});
test('damage probes include both bases and exact lethal construction without computing expected outputs', () => {
    const a = plan('TWI_170');
    assert.equal(a.cases.filter((c) => c.probe.chosenBase).length, 2);
    assert.equal(a.cases.filter((c) => c.name.endsWith('-lethal')).length, 4);
    assert.ok(a.cases.every((c) => !('expected' in c)));
});
test('dynamic constant probes construct normal damage mutation and leave lethal interactions uncovered', () => {
    const a = plan('JTL_052');
    assert.deepEqual(
        a.cases.filter((c) => c.probe.observeOnly).map((c) => c.probe.sourceDamage),
        [0, 1, 6],
    );
    assert.ok(a.cases.some((c) => c.probe.mutateSource && c.probe.activationCode));
    assert.ok(a.uncovered.some((c) => c.id.endsWith(':lethal-boundary')));
});
test('unknown fields, predicates and partial cards fail closed rather than borrowing a simple family', () => {
    const raw = catalogue.cards.find((c) => c.setCode === 'TWI_124');
    const e = structuredClone(raw);
    e.abilities.card[0].targetResolver.condition = { kind: 'const', value: true };
    const p = planCardProbes(e, { catalogue });
    assert.equal(p.cases.length, 0);
    assert.ok(p.uncovered.length);
    e.status = 'unsupported';
    assert.equal(planCardProbes(e, { catalogue }).cases.length, 0);
});
test('same IR shape under another card identity uses the same automatic construction rules', () => {
    const e = structuredClone(catalogue.cards.find((c) => c.setCode === 'TWI_170'));
    e.setCode = 'SYN_999';
    const a = planCardProbes(e, { catalogue });
    assert.equal(a.cases.length, plan('TWI_170').cases.length);
    assert.ok(a.cases.every((c) => c.id.startsWith('auto/SYN_999/')));
});

test('unknown effect properties remain uncovered', () => {
    const e = structuredClone(catalogue.cards.find((c) => c.setCode === 'TWI_170'));
    e.abilities.card[0].effect.hiddenOperation = true;
    assert.equal(planCardProbes(e, { catalogue }).cases.length, 0);
});
test(
    'automatic fixtures execute real oracle experiments including expiry, lethal damage, invalid zone and live refresh',
    {
        skip: !require('node:fs').existsSync(
            require('node:path').resolve(__dirname, '../../../forceteki/build/server/game/core/Game.js'),
        ),
    },
    async () => {
        const { Env } = require('../../env'),
            { loadPool } = require('../../omni/rs/pool'),
            { fixture } = require('../pipeline/probe-fixture');
        const pool = loadPool(
                require('node:path').resolve(__dirname, '../../card-compiler/generated/runtime-pool.json'),
            ),
            env = new Env();
        const scenarios = [
            plan('TWI_124').cases.find((c) => c.probe.waitForExpiry),
            plan('TWI_170').cases.find((c) => c.name.endsWith('-lethal')),
            plan('TWI_170').cases.find((c) => c.probe.negativeOnly),
            plan('JTL_052').cases.find((c) => c.probe.mutateSource),
        ];
        for (const [i, scenario] of scenarios.entries()) {
            const { records, witness } = await fixture(env, pool, scenario, 84000 + i);
            assert.equal(records.at(-1).type, 'result');
            for (let j = 0; j < records.length; j++) {
                if (records[j].type === 'state') {
                    assert.equal(records[j + 1].type, 'decision');
                    assert.equal(
                        records[j].state.actor,
                        records[j + 1].actor,
                        'State actor must match next decision actor',
                    );
                }
            }
            assert.deepEqual(witness.coverageObligationIds, scenario.coverageObligationIds);
        }
    },
);

test('restricted selectors generate in-arena wrong owner and wrong arena negative constructions', () => {
    const e = structuredClone(catalogue.cards.find((c) => c.setCode === 'TWI_170'));
    e.abilities.card[0].targetResolver = { owner: 'self', type: 'unit', zone: 'groundArena' };
    const p = planCardProbes(e, { catalogue });
    assert.ok(p.cases.some((c) => c.name.endsWith('wrong-owner') && c.probe.targets[0].owner === 'opponent'));
    assert.ok(p.cases.some((c) => c.name.endsWith('wrong-arena') && c.probe.targets[0].arena === 'space'));
});

test('zero-ability, intrinsic keyword and source semantics never appear complete', () => {
    const e = structuredClone(catalogue.cards.find((c) => c.setCode === 'JTL_052'));
    e.abilities = { card: [], leader: [], unit: [] };
    e.keywordValues = { sentinel: 1 };
    const p = planCardProbes(e, { catalogue });
    assert.ok(p.uncovered.some((o) => o.path === 'source'));
    assert.ok(p.uncovered.some((o) => o.dimension === 'vanilla-lifecycle' || o.id.endsWith(':vanilla-lifecycle')));
    assert.ok(p.uncovered.some((o) => o.path === 'keywordValues.sentinel'));
});
test('base-only selector does not construct unit targets and HP-dependent constants reject', () => {
    const e = structuredClone(catalogue.cards.find((c) => c.setCode === 'TWI_170'));
    e.abilities.card[0].targetResolver.zone = 'base';
    const p = planCardProbes(e, { catalogue });
    assert.ok(!p.cases.some((c) => !c.probe.negativeOnly && c.probe.targets.length));
    const dynamic = structuredClone(catalogue.cards.find((c) => c.setCode === 'JTL_052'));
    dynamic.abilities.card[0].effect.hp = { kind: 'ref', path: ['modifierTarget', 'damage'] };
    assert.equal(planCardProbes(dynamic, { catalogue }).cases.length, 0);
});
