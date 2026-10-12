'use strict';
// Deliberately wrong, well-typed configurations test experiment sensitivity.
// These never alter card source, accepted configuration, or expected oracle data.
function mutants(entry) {
    const out = [];
    function add(path, label, change) {
        const clone = structuredClone(entry);
        let value = clone;
        for (const key of path.slice(0, -1)) value = value[key];
        value[path.at(-1)] = change(value[path.at(-1)]);
        out.push({ id: entry.setCode + ':' + path.join('.') + ':' + label, path: path.join('.'), label, entry: clone });
    }
    function walk(value, path) {
        if (!value || typeof value !== 'object') return;
        if (value.kind === 'const' && Number.isSafeInteger(value.value) && Math.abs(value.value) < 1000)
            add([...path, 'value'], 'amount-plus-one', (n) => n + 1);
        if (value.kind === 'arenaList' && value.receiver?.kind === 'ref' && value.receiver.path?.[0] === 'game')
            add([...path, 'receiver', 'path'], 'friendly-only-list', () => ['player']);
        if (value.kind === 'arenaList' && value.predicate?.kind === 'const' && value.predicate.value === true)
            add([...path, 'predicate', 'value'], 'empty-list', () => false);
        if (value.kind === 'arenaList' && value.receiver?.kind === 'ref' && ['player','opponent'].includes(value.receiver.path?.[0]))
            add([...path, 'receiver', 'path'], 'swap-owner', (p) => [p[0] === 'player' ? 'opponent' : 'player']);
        if (value.kind === 'arenaList' && value.predicate?.kind !== 'const')
            add([...path, 'predicate'], 'all-arenas', () => ({kind:'const',value:true}));
        if (value.trigger === 'onDefense') {
            add([...path, 'trigger'], 'attack-instead-of-defense', () => 'onAttack');
            if (value.optional !== true)
                add([...path, 'optional'], 'optional-instead-of-mandatory', () => true);
        }
        if (value.kind === 'ready' || value.kind === 'exhaust')
            add([...path, 'kind'], 'reverse-readiness', kind => kind === 'ready' ? 'exhaust' : 'ready');
        if (value.kind === 'giveExperience')
            add([...path, 'kind'], 'shield-instead-of-experience', () => 'giveShield');
        if (value.kind === 'createTokenUnit') {
            add([...path, 'entersReady'], 'reverse-token-readiness', ready => !ready);
            if (['cloneTrooper','battleDroid'].includes(value.tokenType))
                add([...path, 'tokenType'], 'wrong-token-type', kind => kind === 'cloneTrooper' ? 'battleDroid' : 'cloneTrooper');
        }
        if (value.kind && ['ownBase','enemyBase','ownPlayer','enemyPlayer'].includes(value.target))
            add([...path, 'target'], 'swap-effect-owner', target => ({ownBase:'enemyBase',enemyBase:'ownBase',ownPlayer:'enemyPlayer',enemyPlayer:'ownPlayer'})[target]);
        if (value.kind === 'returnToHand' && value.target === 'chosen')
            add([...path, 'kind'], 'defeat-instead-of-return', () => 'defeat');
        if (value.kind === 'query' && value.name === 'isUpgrade')
            add([...path, 'name'], 'unit-type-instead-of-upgrade', () => 'isUnit');
        if (value.kind === 'query' && value.name === 'hasSomeTrait' &&
            value.receiver?.kind === 'ref' && JSON.stringify(value.receiver.path) === '["player","base"]')
            add([...path, 'receiver', 'path'], 'opponent-base-trait', () => ['opponent', 'base']);
        if (value.kind === 'conditional') {
            add([...path, 'condition'], 'always-true-branch', () => ({kind:'const', value:true}));
            add([...path, 'condition'], 'always-false-branch', () => ({kind:'const', value:false}));
        }
        if (value.optional === true)
            add([...path, 'optional'], 'mandatory-instead-of-optional', () => false);
        if (path.at(-1) === 'targetResolver' && value.owner === 'self')
            add([...path, 'owner'], 'opponent-instead-of-self', () => 'opponent');
        if (path.at(-1) === 'targetResolver' && value.zone === 'discard')
            add([...path, 'zone'], 'arena-instead-of-discard', () => 'anyAttackable');
        if (value.kind === 'query' && value.name === 'hasCost') {
            add(path, 'no-cost-cards', () => ({kind:'const', value:false}));
            add(path, 'positive-cost-only', v => ({kind:'binary', op:'>', left:{kind:'query', name:'getPrintedCost', receiver:v.receiver, args:[]}, right:{kind:'const', value:0}}));
        }
        if (value.kind === 'query' && value.name === 'hasSomeArenaUnit' && value.receiver?.kind === 'ref' && ['player','opponent'].includes(value.receiver.path?.[0]))
            add([...path, 'receiver', 'path'], 'swap-arena-query-owner', p => [p[0] === 'player' ? 'opponent' : 'player']);
        if (value.kind === 'unary' && value.op === '!') add(path, 'remove-not', v => v.value);
        if (value.kind === 'unary' && value.op === '-') add(path, 'remove-negation', (v) => v.value);
        if (path.at(-1) === 'targetResolver' && value.owner === 'any')
            add([...path, 'owner'], 'friendly-only', () => 'self');
        if (path.at(-1) === 'targetResolver' && value.type === 'any')
            add([...path, 'type'], 'units-only', () => 'unit');
        for (const [key, child] of Object.entries(value)) walk(child, [...path, key]);
    }
    walk(entry.abilities, ['abilities']);
    walk(entry.attachCondition, ['attachCondition']);
    return out;
}
module.exports = { mutants };
