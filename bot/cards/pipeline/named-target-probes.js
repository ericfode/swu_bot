'use strict';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (a, allowed) => a && Object.keys(a).every(k => allowed.includes(k));
function classifyNamedTarget(entry) {
    const abilities = Object.values(entry.abilities ?? {}).flat();
    const a = abilities[0];
    const event = same(entry.card?.types, ['event']);
    const unit = same(entry.card?.types, ['unit']);
    if (entry.status !== 'supported' || !(event || unit) || entry.baseClass !== (event ? 'EventCard' : 'NonLeaderUnitCard') || abilities.length !== 1 ||
        entry.abilities.card?.length !== 1 || !keys(a, ['trigger', 'title', 'costs', 'effect', 'targetResolvers']) ||
        !same(a.costs, []) || !same(a.effect, { kind: 'noAction' }) ||
        a.trigger !== (event ? 'event' : 'whenPlayed') ||
        Object.keys(entry.keywordValues ?? {}).length || entry.card.keywords?.length ||
        entry.card.pilotText || entry.card.pilotBox || entry.card.pilotingBox || entry.piloting ||
        !Array.isArray(a.targetResolvers) || a.targetResolvers.length !== 2) return null;
    const descriptors = [];
    for (const d of a.targetResolvers) {
        const r = d?.targetResolver, e = d?.effect;
        if (!keys(d, ['name', 'chooser', 'targetResolver', 'effect']) ||
            typeof d.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(d.name) ||
            ['target', 'constructor', 'prototype', '__proto__'].includes(d.name) || d.chooser !== 'self' ||
            !keys(r, ['owner', 'type', 'zone', 'arena', 'optional', 'predicate', 'promptTitle']) ||
            r.owner !== 'any' || r.type !== 'unit' || r.optional !== true ||
            !['arena', 'anyAttackable'].includes(r.zone) || typeof r.promptTitle !== 'string' ||
            (r.arena !== undefined && !['ground', 'space'].includes(r.arena))) return null;
        let trait;
        if (r.predicate !== undefined) {
            const q = r.predicate;
            if (!keys(q, ['kind', 'name', 'receiver', 'args']) || q.kind !== 'query' ||
                q.name !== 'hasSomeTrait' || !same(q.receiver, { kind: 'ref', path: ['card'] }) ||
                !Array.isArray(q.args) || q.args.length !== 1 ||
                !keys(q.args[0], ['kind', 'value']) || q.args[0].kind !== 'const' ||
                typeof q.args[0].value !== 'string' || !q.args[0].value) return null;
            trait = q.args[0].value;
        }
        if (!keys(e, ['kind', 'target', 'duration', 'power', 'hp']) ||
            e.kind !== 'modifyStats' || e.target !== 'chosen' || e.duration !== 'phase') return null;
        for (const amount of [e.power, e.hp]) {
            if (!keys(amount, ['kind', 'value']) || amount.kind !== 'const' ||
                !Number.isInteger(amount.value) || amount.value < 1 || amount.value > 127) return null;
        }
        descriptors.push({ name: d.name, promptTitle: r.promptTitle, arena: r.arena,
            trait, power: e.power.value, hp: e.hp.value });
    }
    if (descriptors[0].name === descriptors[1].name) return null;
    return { family: 'named-target', trigger: a.trigger, descriptors };
}
function planNamedTargetProbes(entry, options = {}) {
    const shape = classifyNamedTarget(entry);
    if (!shape) return null;
    const defs = Array.isArray(options.catalogue) ? options.catalogue : options.catalogue?.cards ?? [];
    const result = { schema: 'swu-card-probes/v1', cardId: entry.setCode, sourceHash: entry.sourceHash,
        cases: [], obligations: [], uncovered: [] };
    const obligation = (dimension, reason) => {
        const id = entry.setCode + ':named-target:' + dimension;
        result.obligations.push({ id, path: 'named-target', dimension });
        if (reason) result.uncovered.push({ id, path: 'named-target', reason });
        return id;
    };
    const matches = (e, d) => (!d.arena || e.card.arena === d.arena) &&
        (!d.trait || e.card.traits?.includes(d.trait));
    const quiet = defs.filter(e => e.status === 'supported' && same(e.card.types, ['unit']) &&
        !e.card.unique && !Object.values(e.abilities ?? {}).flat().length &&
        !Object.keys(e.keywordValues ?? {}).length).sort((a, b) => a.setCode.localeCompare(b.setCode));
    const donors = [];
    for (const d of shape.descriptors) {
        donors.push(quiet.find(e => matches(e, d) && !donors.some(prior => prior?.setCode === e.setCode)));
    }
    if (donors.some(e => !e)) {
        obligation('metadata-donors', 'No quiet eligible unit for each descriptor');
        return result;
    }
    const row = (e, owner) => ({ code: e.setCode, owner, arena: e.card.arena, exhausted: false, damage: 0 });
    const mixed = donors.flatMap(e => [row(e, 'self'), row(e, 'opponent')]);
    const negative = quiet.find(e => shape.descriptors.every(d => !matches(e, d)));
    if (negative) mixed.push(row(negative, 'opponent'));
    function add(name, targets, choices, extra = {}) {
        const id = obligation(name);
        result.cases.push({ id: `auto/${entry.setCode}/named-target-${name}`, name: 'named-target-' + name,
            kind: 'probe', focusCardIds: [entry.setCode], setupCardIds: [...new Set(targets.map(t => t.code))].sort(),
            behaviorIds: ['named-targets', 'phase-stats', 'optional-selection'],
            assertionStages: ['construction', 'activation', 'observation'], coverageObligationIds: [id],
            probe: { ...shape, cardId: entry.setCode, sourceTypes: entry.card.types, sourceArena: entry.card.arena,
                targets, choices, initiative: 'self', resourceCount: 20, ...extra } });
    }
    add('both-enemy-selections', mixed, ['enemy', 'enemy']);
    add('both-own-selections', mixed, ['own', 'own']);
    add('decline-first', mixed, ['decline', 'enemy']);
    add('decline-second', mixed, ['enemy', 'decline']);
    add('decline-both', mixed, ['decline', 'decline']);
    add('phase-expiry', mixed, ['enemy', 'enemy'], { waitForExpiry: true });
    for (let missing = 0; missing < 2; missing++) {
        const targets = mixed.filter(t => !matches(defs.find(e => e.setCode === t.code), shape.descriptors[missing]));
        const sourceMatches = shape.trigger === 'whenPlayed' && matches(entry, shape.descriptors[missing]);
        add(sourceMatches ? 'missing-staged-' + (missing + 1) + '-entering-source' : 'missing-' + (missing + 1),
            targets, sourceMatches ? ['enemy', 'source'] : ['enemy', 'enemy']);
    }
    if (shape.trigger === 'event') {
        add('cancel-first', mixed, ['cancel', 'enemy']);
        add('cancel-second', mixed, ['enemy', 'cancel']);
        add('empty-play-anyway', [], ['decline', 'decline'], { empty: true });
        add('empty-cancel', [], ['decline', 'decline'], { empty: true, cancelEmpty: true });
    } else {
        add('entering-source-self-selection', [], ['decline', 'source']);
    }
    for (const dimension of ['source-review', 'unique-source-departure', 'recipient-reentry',
        'same-recipient-overlapping-traits', 'phase-expiry-lethal-window', 'token-and-deployed-leader']) {
        obligation(dimension, 'No actual source-card construction for this dimension; raw primitive diagnostics are not full-card witnesses');
    }
    return result;
}
module.exports = { classifyNamedTarget, planNamedTargetProbes };
