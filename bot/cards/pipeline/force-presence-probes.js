'use strict';
const { nativeForce } = require('./force-probes');
const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const keys = (v, allowed) => v && Object.keys(v).every(k => allowed.includes(k));
function ordinary(entry) {
    return entry.status === 'supported' && entry.baseClass === 'NonLeaderUnitCard' &&
        same(entry.card?.types, ['unit']) && ['ground', 'space'].includes(entry.card.arena) &&
        !entry.card.pilotText && !entry.card.pilotBox && !entry.card.pilotingBox && !entry.piloting;
}
function classifyForcePresence(entry) {
    const all = Object.values(entry.abilities ?? {}).flat(), a = all[0];
    if (!ordinary(entry) || all.length !== 1 || entry.abilities.card?.length !== 1 ||
        !keys(a, ['trigger', 'title', 'costs', 'condition', 'targetResolver', 'effect']) ||
        typeof a.title !== 'string' || a.trigger !== 'constant' || !same(a.costs, []) ||
        !same(a.condition, { kind: 'ref', path: ['player', 'hasTheForce'] })) return null;
    const e = a.effect, kw = entry.keywordValues ?? {};
    const mentions = [...(entry.card.keywords ?? [])].sort();
    if (keys(e, ['kind', 'target', 'duration', 'keyword', 'amount']) &&
        e.kind === 'gainKeyword' && e.target === 'self' && e.duration === 'persistent' &&
        ['grit', 'sentinel', 'ambush'].includes(e.keyword) &&
        (e.keyword === 'grit' || entry.card.arena === 'ground') && same(e.amount, { kind: 'const', value: 1 }) &&
        !a.targetResolver && same(mentions, [...new Set([e.keyword, ...Object.keys(kw)])].sort()) && (same(kw, {}) || e.keyword === 'ambush' && same(kw, { shielded: 1 }))) {
        return { family: 'force-presence', kind: 'keyword', keyword: e.keyword, keywords: { ...kw } };
    }
    if (keys(e, ['kind', 'target', 'duration', 'power', 'hp']) && e.kind === 'modifyStats' &&
        e.target === 'chosen' && e.duration === 'persistent' &&
        keys(e.power, ['kind', 'value']) && e.power.kind === 'const' && Number.isInteger(e.power.value) &&
        e.power.value > 0 && e.power.value <= 8 && same(e.hp, { kind: 'const', value: 0 }) && same(kw, {}) && same(mentions, []) &&
        same(a.targetResolver, { owner: 'self', type: 'unit', zone: 'arena',
            predicate: { kind: 'query', name: 'isUnit', receiver: { kind: 'ref', path: ['card'] }, args: [] } })) {
        return { family: 'force-presence', kind: 'aura', power: e.power.value, keywords: {} };
    }
    return null;
}
function planForcePresenceProbes(entry, options = {}) {
    const shape = classifyForcePresence(entry);
    if (!shape) return null;
    const defs = Array.isArray(options.catalogue) ? options.catalogue : options.catalogue?.cards ?? [];
    const result = { schema: 'swu-card-probes/v1', cardId: entry.setCode, sourceHash: entry.sourceHash,
        cases: [], obligations: [], uncovered: [] };
    function obligation(name, reason) {
        const id = entry.setCode + ':force-presence:' + name;
        result.obligations.push({ id, path: 'force-presence', dimension: name });
        if (reason) result.uncovered.push({ id, path: 'force-presence', reason });
        return id;
    }
    const quiet = defs.filter(e => e.status === 'supported' && same(e.card?.types, ['unit']) &&
        !e.card.unique && !Object.values(e.abilities ?? {}).flat().length && !Object.keys(e.keywordValues ?? {}).length &&
        !e.card.keywords?.length && !e.card.pilotText && !e.card.pilotBox && !e.card.pilotingBox && !e.piloting &&
        (e.baseClass === 'NonLeaderUnitCard' || !e.baseClass && !e.card.text))
        .sort((a, b) => a.setCode.localeCompare(b.setCode));
    const ground = quiet.find(e => e.card.arena === 'ground' && e.card.hp >= 6 && e.card.power <= 2);
    const space = quiet.find(e => e.card.arena === 'space' && e.card.hp >= 4);
    const donor = effect => defs.find(e => ordinary(e) && !e.card.unique && !e.card.keywords?.length && !Object.keys(e.keywordValues ?? {}).length &&
        Object.values(e.abilities ?? {}).flat().length === 1 && e.abilities.card?.length === 1 &&
        keys(e.abilities.card[0], ['trigger', 'title', 'costs', 'effect', ...(effect === 'useForce' ? ['optional', 'ifYouDo'] : [])]) &&
        e.abilities.card[0].trigger === 'whenPlayed' && same(e.abilities.card[0].costs, []) &&
        same(e.abilities.card[0].effect, { kind: effect, target: 'ownPlayer' }) &&
        (effect === 'gainForce' || e.abilities.card[0].optional === true &&
            same(e.abilities.card[0].ifYouDo?.effect, { kind: 'ready', target: 'self' })));
    const gain = donor('gainForce');
    // A unique use donor is also valid: only one copy is played in each lifecycle.
    const use = defs.find(e => ordinary(e) && !e.card.keywords?.length && !Object.keys(e.keywordValues ?? {}).length &&
        Object.values(e.abilities ?? {}).flat().length === 1 && e.abilities.card?.length === 1 &&
        keys(e.abilities.card[0], ['trigger', 'title', 'costs', 'effect', 'optional', 'ifYouDo']) &&
        e.abilities.card[0].trigger === 'whenPlayed' && e.abilities.card[0].optional === true &&
        same(e.abilities.card[0].costs, []) && same(e.abilities.card[0].effect, { kind: 'useForce', target: 'ownPlayer' }) &&
        keys(e.abilities.card[0].ifYouDo, ['title', 'costs', 'effect']) && same(e.abilities.card[0].ifYouDo.costs, []) &&
        same(e.abilities.card[0].ifYouDo.effect, { kind: 'ready', target: 'self' }));
    const token = defs.find(nativeForce);
    if (!ground || !space || !gain || !use || !token) {
        obligation('metadata-donors', 'Missing reviewed native Force or quiet/gain/use donors');
        return result;
    }
    const row = (e, owner, extra = {}) => ({ code: e.setCode, owner, arena: e.card.arena, exhausted: false, damage: 0, ...extra });
    const mixed = [row(ground, 'self'), row(space, 'self'), row(ground, 'opponent'), row(space, 'opponent')];
    function add(name, extra = {}) {
        const id = obligation(name);
        const probe = { ...shape, cardId: entry.setCode, sourceArena: entry.card.arena,
            targets: mixed, held: true, enemyHeld: false, initiative: 'self', resourceCount: 32, ...extra };
        result.cases.push({ id: `auto/${entry.setCode}/force-presence-${name}`, name: 'force-presence-' + name,
            kind: 'probe', focusCardIds: [entry.setCode],
            setupCardIds: [...new Set([token.setCode, ...probe.targets.map(t => t.code)])].sort(),
            behaviorIds: ['force-presence', shape.kind, ...(shape.keyword ? [shape.keyword] : []), ...Object.keys(shape.keywords)],
            assertionStages: ['construction', 'activation', 'observation'], coverageObligationIds: [id], probe });
    }
    add('own-held-entry');
    add('both-held-entry', { enemyHeld: true });
    add('absent-entry', { held: false });
    add('enemy-only-entry', { held: false, enemyHeld: true });
    add('phase-persistent-presence', { waitForExpiry: true });
    const lifecycle = [...mixed, row(gain, 'self', { zone: 'hand' }), row(use, 'self', { zone: 'hand' }),
        row(gain, 'self', { zone: 'hand' })];
    add('actual-gain-use-regain', { held: false, enemyHeld: true, lifecycle: true, targets: lifecycle,
        gainIndex: 4, useIndex: 5, regainIndex: 6, sourceInPlay: shape.keyword === 'grit', sourceDamage: shape.keyword === 'grit' ? 2 : 0 });
    if (shape.keyword === 'sentinel') {
        const hidden = defs.find(e => ordinary(e) && same(e.keywordValues, { hidden: 1 }) && same(e.card.keywords, ['hidden']) &&
            Object.values(e.abilities ?? {}).flat().length === 1 && e.abilities.card?.length === 1 &&
            keys(e.abilities.card[0], ['trigger', 'title', 'costs', 'effect', 'targetResolver']) &&
            e.abilities.card[0].trigger === 'constant' && same(e.abilities.card[0].costs, []) &&
            same(e.abilities.card[0].effect, { kind: 'gainKeyword', target: 'chosen', duration: 'persistent', keyword: 'hidden', amount: { kind: 'const', value: 1 } }) &&
            same(e.abilities.card[0].targetResolver, { owner: 'self', type: 'unit', zone: 'arena',
                predicate: { kind: 'binary', op: '!==', left: { kind: 'ref', path: ['card'] }, right: { kind: 'ref', path: ['source'] } } }));
        if (hidden) {
            const withHidden = [...mixed, row(hidden, 'self')];
            add('actual-hidden-sentinel-exception', { hiddenGrant: true, targets: withHidden });
            add('actual-hidden-without-sentinel', { held: false, hiddenGrant: true, targets: withHidden });
            add('actual-hidden-gain-use-regain-menus', { held: false, enemyHeld: true, hiddenGrant: true, lifecycle: true,
                targets: [...withHidden, row(gain, 'self', { zone: 'hand' }), row(use, 'self', { zone: 'hand' }), row(gain, 'self', { zone: 'hand' })],
                gainIndex: 5, useIndex: 6, regainIndex: 7 });
        } else obligation('hidden-sentinel-interaction', 'No exact other-friendly Hidden grant donor');
    }
    if (shape.keyword === 'grit') add('damaged-live-grit', { sourceInPlay: true, sourceDamage: 2 });
    if (shape.keyword === 'ambush') {
        add('shielded-first-ambush', { shieldFirst: true });
        add('ambush-decline', { decline: true });
        add('no-enemy-ambush', { targets: mixed.slice(0, 2) });
    }
    if (shape.kind === 'aura') {
        const defeat = defs.find(e => e.status === 'supported' && e.baseClass === 'EventCard' && same(e.card.types, ['event']) &&
            !e.card.keywords?.length && !Object.keys(e.keywordValues ?? {}).length && !e.card.pilotText && !e.card.pilotBox && !e.card.pilotingBox && !e.piloting &&
            Object.values(e.abilities ?? {}).flat().length === 1 && e.abilities.card?.length === 1 &&
            keys(e.abilities.card[0], ['trigger', 'title', 'costs', 'targetResolver', 'effect']) &&
            e.abilities.card[0].trigger === 'event' && same(e.abilities.card[0].costs, []) &&
            same(e.abilities.card[0].effect, { kind: 'defeat', target: 'chosen' }) &&
            same(e.abilities.card[0].targetResolver, { owner: 'any', type: 'unit', zone: 'anyAttackable' }));
        if (defeat) add('actual-source-departure', { sourceDeparture: true,
            targets: [...mixed, row(defeat, 'self', { zone: 'hand' })], defeatIndex: 4 });
        const beast = defs.find(e => e.setCode === 'TOKEN_BEAST' && same(e.card.types, ['token', 'unit']) &&
            e.card.arena === 'ground' && !Object.keys(e.keywordValues ?? {}).length);
        if (beast) add('actual-token-unit-member', { targets: [...mixed, row(beast, 'self', { token: 'beast' })] });
    }
    for (const name of ['source-review', 'pending-window-force-change', 'control-transfer', 'unique-reentry-replacement',
        'deployed-leader-domain', 'unique-source-departure', 'additional-later-entrant']) {
        obligation(name, 'No actual source-card construction for this dimension yet; separate diagnostics are not full-card witnesses');
    }
    return result;
}
module.exports = { classifyForcePresence, planForcePresenceProbes };
