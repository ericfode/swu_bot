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
        if (value.kind === 'arenaList' && value.receiver?.kind === 'ref' && ['player','opponent'].includes(value.receiver.path?.[0]))
            add([...path, 'receiver', 'path'], 'swap-owner', (p) => [p[0] === 'player' ? 'opponent' : 'player']);
        if (value.kind === 'arenaList' && value.predicate?.kind !== 'const')
            add([...path, 'predicate'], 'all-arenas', () => ({kind:'const',value:true}));
        if (value.kind === 'unary' && value.op === '-') add(path, 'remove-negation', (v) => v.value);
        if (path.at(-1) === 'targetResolver' && value.owner === 'any')
            add([...path, 'owner'], 'friendly-only', () => 'self');
        if (path.at(-1) === 'targetResolver' && value.type === 'any')
            add([...path, 'type'], 'units-only', () => 'unit');
        for (const [key, child] of Object.entries(value)) walk(child, [...path, key]);
    }
    walk(entry.abilities, ['abilities']);
    return out;
}
module.exports = { mutants };
