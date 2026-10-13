'use strict';
const same = require('node:util').isDeepStrictEqual;
const keys = (a, allowed) => a && typeof a === 'object' && Object.keys(a).every(k => allowed.includes(k));
const constant = value => ({ kind: 'const', value });
const ref = (...path) => ({ kind: 'ref', path });
const binary = (op, left, right) => ({ kind: 'binary', op, left, right });
const exclusion = binary('||', { kind: 'unary', op: '!', value: ref('source') }, binary('!==', ref('card'), ref('source')));
const arenaGuard = arena => binary('||', { kind: 'unary', op: '!', value: constant(arena) }, binary('||', binary('===', constant(arena), constant('anyArena')), binary('===', ref('card', 'zoneName'), constant(arena))));
const exhausted = binary('&&', { kind: 'query', name: 'isUnit', receiver: ref('card'), args: [] }, ref('card', 'exhausted'));
function parsePredicate(p) {
    for (const arena of [null, 'groundArena', 'spaceArena']) {
        const base = arena ? binary('&&', constant(true), arenaGuard(arena)) : constant(true);
        for (const mode of ['none', 'exclude', 'exhausted']) {
            const predicate = mode === 'none' ? base : binary('&&', base, mode === 'exclude' ? exclusion : exhausted);
            if (same(p, predicate))
                return { arena: arena?.replace('Arena', '') ?? null, excludeSource: mode === 'exclude', exhaustedOnly: mode === 'exhausted' };
        }
    }
    return null;
}
function ordinary(entry) {
    return entry.status === 'supported' && same(entry.card?.types, ['unit']) &&
        entry.baseClass === 'NonLeaderUnitCard' && ['ground', 'space'].includes(entry.card.arena) &&
        !entry.card.pilotText && !entry.card.pilotBox && !entry.card.pilotingBox && !entry.piloting && !entry.attachCondition;
}
function classifyArenaDamage(entry) {
    const conditional = classifyConditionalArenaDamage(entry);
    if (conditional)
        return conditional;
    if (!ordinary(entry) || !keys(entry.abilities, ['card', 'leader', 'unit']) || entry.abilities.leader?.length || entry.abilities.unit?.length)
        return null;
    const all = entry.abilities.card ?? [];
    const damages = all.filter(a => a.effect?.kind === 'damage');
    if (damages.length !== 1)
        return null;
    const a = damages[0], e = a.effect;
    if (typeof a.title !== 'string' || !keys(a, ['trigger', 'title', 'costs', 'effect']) || !same(a.costs, []) || !['whenPlayed', 'onAttack', 'whenDefeated'].includes(a.trigger) ||
        !keys(e, ['kind', 'target', 'amount']) || !same(Object.keys(e.amount ?? {}).sort(), ['kind', 'value']) || e.amount.kind !== 'const' || !Number.isInteger(e.amount.value) || e.amount.value < 1 || e.amount.value > 3 ||
        !keys(e.target, ['kind', 'receiver', 'predicate']) || e.target.kind !== 'arenaList' || !keys(e.target.receiver, ['kind', 'path']) ||
        e.target.receiver.kind !== 'ref' || e.target.receiver.path?.length !== 1 || !['game', 'player', 'opponent'].includes(e.target.receiver.path[0]))
        return null;
    const filters = parsePredicate(e.target.predicate);
    if (!filters)
        return null;
    if (a.trigger === 'whenDefeated') {
        if (e.target.receiver.path[0] !== 'opponent' || filters.arena !== 'ground' || filters.excludeSource)
            return null;
    }
    else if (e.target.receiver.path[0] !== 'game' || !filters.excludeSource || filters.exhaustedOnly)
        return null;
    if (a.trigger === 'onAttack' && (entry.card.arena !== 'ground' || filters.arena !== null))
        return null;
    let coordinateRaid = 0;
    for (const other of all.filter(b => b !== a)) {
        if (coordinateRaid || typeof other.title !== 'string' || !keys(other, ['trigger', 'title', 'costs', 'coordinate', 'effect']) || other.trigger !== 'constant' || other.coordinate !== true || !same(other.costs, []) ||
            !keys(other.effect, ['kind', 'target', 'duration', 'keyword', 'amount']) || other.effect.kind !== 'gainKeyword' || other.effect.target !== 'self' || other.effect.duration !== 'persistent' || other.effect.keyword !== 'raid' ||
            !keys(other.effect.amount, ['kind', 'value']) || other.effect.amount.kind !== 'const' || !Number.isInteger(other.effect.amount.value) || other.effect.amount.value < 1 || other.effect.amount.value > 127)
            return null;
        coordinateRaid = other.effect.amount.value;
    }
    if (coordinateRaid && a.trigger !== 'whenDefeated')
        return null;
    const intrinsic = entry.keywordValues ?? {};
    if (Object.entries(intrinsic).some(([k, v]) => !['overwhelm', 'coordinate'].includes(k) || v !== 1) || (!!intrinsic.coordinate !== !!coordinateRaid))
        return null;
    if (intrinsic.overwhelm && (a.trigger !== 'whenPlayed' || filters.arena !== entry.card.arena))
        return null;
    const mentions = [...new Set([...(intrinsic.overwhelm ? ['overwhelm'] : []), ...(coordinateRaid ? ['coordinate', 'raid'] : [])])].sort();
    if (!same([...(entry.card.keywords ?? [])].sort(), mentions))
        return null;
    return { family: 'arena-damage', trigger: a.trigger, amount: e.amount.value, receiver: e.target.receiver.path[0], ...filters, coordinateRaid, overwhelm: !!intrinsic.overwhelm };
}
function quietUnit(e) {
    return e.status === 'supported' && same(e.card?.types, ['unit']) && !e.card.unique && ['ground', 'space'].includes(e.card.arena) &&
        (e.baseClass === 'NonLeaderUnitCard' || (!e.baseClass && e.sourcePath === null && e.sourceHash === null && !e.card.text)) &&
        !Object.values(e.abilities ?? {}).flat().length && !Object.keys(e.keywordValues ?? {}).length && !e.card.keywords?.length &&
        !e.card.pilotText && !e.card.pilotBox && !e.card.pilotingBox && !e.piloting && !e.attachCondition;
}
function defeatEvent(e) {
    const a = e.abilities?.card?.[0];
    return e.status === 'supported' && e.baseClass === 'EventCard' && same(e.card.types, ['event']) && !e.attachCondition && !e.card.pilotText && !e.card.pilotBox && !e.card.pilotingBox && !e.piloting &&
        !e.card.keywords?.length && !Object.keys(e.keywordValues ?? {}).length && Object.values(e.abilities ?? {}).flat().length === 1 &&
        keys(a, ['trigger', 'title', 'costs', 'targetResolver', 'effect']) && a.trigger === 'event' && same(a.costs, []) &&
        same(a.targetResolver, { owner: 'any', type: 'unit', zone: 'anyAttackable' }) && same(a.effect, { kind: 'defeat', target: 'chosen' });
}
function nativeShield(e) {
    return e?.setCode === 'TOKEN_SHIELD' && e.baseClass === 'TokenUpgradeCard' && e.status === 'unsupported' &&
        e.sourcePath === 'game/cards/01_SOR/tokens/Shield.ts' && e.sourceHash === '39f1c6699c36ba309a8fe8e053f9b94ddbb8877991767b6664fcd88d447be91f' &&
        !e.attachCondition && same(e.abilities, { leader: [], unit: [], card: [] }) && same(e.keywordValues, {}) &&
        same(e.card, { title: 'Shield', subtitle: null, cost: 0, hp: 0, power: 0, text: 'If damage would be dealt to attached unit, prevent that damage. If you do, defeat a Shield token on it.', deployBox: null, epicAction: null, unique: false, rules: null, upgradePower: 0, upgradeHp: 0, id: '8752877738', aspects: [], traits: ['armor'], keywords: [], types: ['token', 'upgrade'], setId: { set: 'SOR' }, internalName: 'shield' });
}
function strictConditionalUnit(e) {
    return e?.status === 'supported' && e.baseClass === 'NonLeaderUnitCard' && same(e.card?.types, ['unit']) &&
        typeof e.sourcePath === 'string' && e.sourcePath.length > 0 && /^[a-f0-9]{64}$/.test(e.sourceHash ?? '') &&
        typeof e.card.unique === 'boolean' && e.card.arena === 'ground' && Number.isInteger(e.card.hp) && e.card.hp > 0 &&
        Number.isInteger(e.card.power) && e.card.power >= 0 && Number.isInteger(e.card.cost) && e.card.cost >= 0 && e.card.cost <= 6 &&
        Array.isArray(e.card.aspects) && e.card.aspects.length <= 2 && e.card.aspects.every(v => typeof v === 'string') &&
        Array.isArray(e.card.traits) && e.card.traits.every(v => typeof v === 'string') && e.card.pilotText == null && e.card.pilotBox == null &&
        e.card.pilotingBox == null && e.piloting == null && e.attachCondition == null && e.card.deployBox == null && e.card.upgradeHp == null && e.card.upgradePower == null && keys(e.abilities, ['leader', 'unit', 'card']) &&
        same(e.abilities.leader, []) && same(e.abilities.unit, []) && Array.isArray(e.abilities.card);
}
function classifyConditionalArenaDamage(e) {
    if (!strictConditionalUnit(e) || e.abilities.card.length !== 1)
        return null;
    const a = e.abilities.card[0];
    if (!keys(a, ['trigger', 'title', 'costs', 'effect'])) return null;
    const effect = a.effect;
    if (!keys(a, ['trigger', 'title', 'costs', 'effect']) || typeof a.title !== 'string' || !a.title.length || Buffer.byteLength(a.title, 'utf8') > 1024 || !same(a.costs, []) ||
        !keys(effect, ['kind', 'condition', 'onTrue', 'onFalse']) || effect.kind !== 'conditional' || !same(effect.onFalse, { kind: 'noAction' }))
        return null;
    const count = binary('>=', { kind: 'query', name: 'arenaUnitCount', receiver: ref('player'), args: [constant(true)] }, constant(4));
    const base = binary('>=', ref('player', 'base', 'damage'), constant(15));
    const leaf = (amount, predicate) => ({ kind: 'damage', target: { kind: 'arenaList', receiver: ref('opponent'), predicate }, amount: constant(amount) });
    if (a.trigger === 'whenPlayed' && same(effect.condition, count) && same(effect.onTrue, leaf(3, constant(true))) && same(e.keywordValues, { restore: 1 }) && same(e.card.keywords, ['restore']))
        return { family: 'arena-damage', trigger: 'whenPlayed', amount: 3, receiver: 'opponent', arena: null, excludeSource: false, exhaustedOnly: false, coordinateRaid: 0, overwhelm: false,
            condition: 'own-arena-count', threshold: 4, restore: 1, raid: 0 };
    if (a.trigger === 'onAttack' && same(effect.condition, base) && same(effect.onTrue, leaf(1, binary('&&', constant(true), arenaGuard('groundArena')))) && same(e.keywordValues, { raid: 2 }) && same(e.card.keywords, ['raid']))
        return { family: 'arena-damage', trigger: 'onAttack', amount: 1, receiver: 'opponent', arena: 'ground', excludeSource: false, exhaustedOnly: false, coordinateRaid: 0, overwhelm: false,
            condition: 'own-base-damage', threshold: 15, restore: 0, raid: 2 };
    return null;
}
function conditionalQuiet(e) {
    return require('./keyword-inventory-probes').literalUnit(e) && same(e.keywordValues, {});
}
function planConditionalArenaDamage(entry, shape, options = {}) {
    const defs = [...(Array.isArray(options.catalogue) ? options.catalogue : options.catalogue?.cards ?? [])].sort((a, b) => a.setCode.localeCompare(b.setCode));
    const result = { schema: 'swu-card-probes/v1', cardId: entry.setCode, sourceHash: entry.sourceHash, cases: [], obligations: [], uncovered: [] };
    const obligation = (name, reason) => { const id = entry.setCode + ':conditional-arena-damage:' + name; result.obligations.push({ id, path: 'abilities.card.0.effect', dimension: name }); if (reason)
        result.uncovered.push({ id, path: 'abilities.card.0.effect', reason }); return id; };
    const quiet = defs.filter(conditionalQuiet), ground = quiet.find(e => e.card.arena === 'ground' && e.card.hp >= shape.amount + 4), space = quiet.find(e => e.card.arena === 'space' && e.card.hp >= shape.amount + 4);
    if (!ground || !space) {
        obligation('donors', 'No complete quiet ground/space construction donors');
        return result;
    }
    const row = (e, owner, extra = {}) => ({ code: e.setCode, owner, arena: e.card.arena, exhausted: true, damage: 0, ...extra });
    const friends = count => Array.from({ length: count }, (_, i) => row(i % 2 ? space : ground, 'self'));
    const enemyMixed = () => [row(ground, 'opponent'), row(space, 'opponent')];
    const shield = defs.find(nativeShield), attachment = () => ({ code: shield.setCode, token: 'shield' });
    const add = (name, sourceSeat, targets, extra = {}) => {
        const id = obligation(name + '-seat-' + sourceSeat), probe = { ...shape, cardId: entry.setCode, sourceArena: entry.card.arena, conditionalTitle: entry.abilities.card[0].title, resourceCount: 30, sourceSeat, targets, ...extra };
        result.cases.push({ id: 'auto/' + entry.setCode + '/conditional-arena-' + name + '-seat-' + sourceSeat, name: 'conditional-arena-' + name + '-seat-' + sourceSeat, kind: 'probe', focusCardIds: [entry.setCode],
            setupCardIds: [...new Set([...targets.map(t => t.code), ...targets.flatMap(t => (t.attachments ?? []).map(a => a.code)), ...(probe.deathGain ? ['TOKEN_THE_FORCE'] : []), ...(probe.defenseToken ? ['TOKEN_CLONE_TROOPER'] : [])])].sort(),
            source: { module: '../pipeline/probe-fixture.js', scenario: 'conditional-arena-' + name + '-seat-' + sourceSeat }, behaviorIds: ['conditional', 'arena-list', 'damage', shape.trigger, ...(shape.restore ? ['restore'] : ['raid'])],
            assertionStages: ['construction', 'normal-play', 'resolved-list', 'terminal'], coverageObligationIds: [id], probe });
    };
    const gain = defs.find(e => strictConditionalUnit(e) && same(e.keywordValues, {}) && same(e.card.keywords, []) && e.abilities.card.length === 2 &&
        e.abilities.card.every(a => keys(a, ['trigger', 'title', 'costs', 'effect']) && typeof a.title === 'string' && same(a.costs, []) && ['onAttack', 'whenDefeated'].includes(a.trigger) && same(a.effect, { kind: 'gainForce', target: 'ownPlayer' })) && new Set(e.abilities.card.map(a => a.trigger)).size === 2);
    const hevy = defs.find(e => strictConditionalUnit(e) && classifyArenaDamage(e)?.trigger === 'whenDefeated' && classifyArenaDamage(e).amount === 1 && classifyArenaDamage(e).coordinateRaid === 2);
    const defense = defs.find(e => strictConditionalUnit(e) && e.card.unique === false && same(e.keywordValues, {}) && same(e.card.keywords, []) && e.abilities.card.length === 1 &&
        keys(e.abilities.card[0], ['trigger', 'title', 'costs', 'effect']) && e.abilities.card[0].trigger === 'onDefense' && same(e.abilities.card[0].costs, []) &&
        same(e.abilities.card[0].effect, { kind: 'createTokenUnit', target: 'ownPlayer', tokenType: 'cloneTrooper', amount: constant(1), entersReady: false }));
    const devotion = defs.find(e => require('./keyword-inventory-probes').roleDonor(e, 'restore-upgrade'));
    for (const seat of [1, 2]) {
        if (shape.trigger === 'whenPlayed') {
            for (const count of [3, 4])
                add('count-' + count, seat, [...enemyMixed(), ...friends(count - 1)], { friendlyCount: count });
            add('true-empty', seat, friends(3), { friendlyCount: 4 });
            if (entry.card.unique)
                for (const count of [3, 4])
                    for (const keep of ['old', 'new']) {
                        const targets = [...enemyMixed(), ...friends(count - 1), row(entry, 'self')];
                        add('unique-count-' + count + '-keep-' + keep, seat, targets, { friendlyCount: count, oldIndex: targets.length - 1, keep });
                    }
            else
                obligation('unique-copy-scope', 'Source is not unique; unique construction unavailable');
            const beast = defs.find(require('./weakness-continuation-probes').nativeBeast), leader = defs.find(require('./parent-upgrade-probes').leaderHost);
            if (beast)
                add('token-count', seat, [...enemyMixed(), ...friends(2), row(beast, 'self', { token: 'beast' })], { friendlyCount: 4 });
            else
                obligation('token-count', 'Reviewed Beast dependency absent');
            if (leader)
                add('leader-count', seat, [...enemyMixed(), ...friends(2), row(leader, 'self', { leader: true, arena: 'ground' })], { friendlyCount: 4, leaderCode: leader.setCode });
            else
                obligation('leader-count', 'Complete ordinary leader donor absent');
            const other = quiet.find(e => e.card.arena === 'ground' && e.card.hp >= shape.amount + 4 && e !== ground);
            if (shield && other)
                add('paired-shields', seat, [row(ground, 'opponent', { attachments: [attachment(), attachment()] }), row(other, 'opponent', { attachments: [attachment(), attachment()] }), ...friends(3)], { friendlyCount: 4, sameOwnerShields: true });
            else
                obligation('shield-identities', 'Reviewed Shield or second quiet recipient absent');
            if (gain && gain.card.hp >= 3 && defs.some(require('./force-probes').nativeForce))
                add('ordered-death-gains', seat, [row(gain, 'opponent', { damage: gain.card.hp - 3 }), row(space, 'opponent'), row(gain, 'opponent', { damage: gain.card.hp - 3 }), ...friends(3)], { friendlyCount: 4, deathGain: true });
            else
                obligation('captured-deaths', 'Complete mandatory Force-death donor absent');
            for (const damage of [0, 3])
                add('restore-base-' + damage, seat, [], { friendlyCount: 1, restoreCombat: true, initialBaseDamage: damage });
        }
        else {
            for (const damage of [14, 15])
                add('base-' + damage, seat, enemyMixed(), { initialBaseDamage: damage, initialEnemyBaseDamage: damage === 14 ? 15 : 14 });
            const survivor = quiet.find(e => e.card.arena === 'ground' && e.card.hp > shape.amount && e.card.power < entry.card.hp);
            if (survivor)
                add('surviving-unit-defender', seat, [row(survivor, 'opponent')], { initialBaseDamage: 15, attackTargetIndex: 0, conditionalUnitAttack: true });
            else
                obligation('surviving-defender', 'No quiet defender survives the wave and leaves source alive after retaliation');
            if (defense && defs.some(require('./parent-upgrade-probes').nativeCloneTrooper))
                add('captured-defense', seat, [row(defense, 'opponent', { damage: defense.card.hp - 1 })], { initialBaseDamage: 15, attackTargetIndex: 0, defenderLethal: true, defenseToken: true, ownerFirst: 'self' });
            else
                obligation('captured-defense', 'Complete ground OnDefense Clone donor absent');
            const other = quiet.find(e => e.card.arena === 'ground' && e.card.hp >= 5 && e !== ground);
            if (shield && other)
                add('paired-shields', seat, [row(ground, 'opponent', { attachments: [attachment(), attachment()] }), row(other, 'opponent', { attachments: [attachment(), attachment()] })], { initialBaseDamage: 15, sameOwnerShields: true });
            if (shield && ground.card.power < entry.card.hp)
                add('wave-then-combat-shields', seat, [row(ground, 'opponent', { attachments: [attachment(), attachment()] })], { initialBaseDamage: 15, attackTargetIndex: 0, shieldCombat: true, conditionalUnitAttack: true });
            if (hevy && entry.card.hp > 1)
                add('captured-hevy-death', seat, [row(hevy, 'opponent', { damage: hevy.card.hp - 1 }), row(space, 'opponent')], { initialBaseDamage: 15, deathDamage: true, deathDamageIndex: 0 });
            else
                obligation('captured-hevy', 'Complete mandatory ground-damage death donor absent');
            if (devotion)
                for (const order of ['saw-first', 'restore-first'])
                    add('devotion-' + order, seat, [...enemyMixed(), { code: devotion.setCode, owner: 'self', zone: 'hand' }], { initialBaseDamage: 15, devotionIndex: 2, restoreOrder: order });
            else
                obligation('restore-order', 'Complete printed Restore2 upgrade donor absent');
            add('no-enemy-ground', seat, [row(space, 'opponent')], { initialBaseDamage: 15 });
        }
    }
    for (const gap of ['independent-source-review', 'controller-transfer', 'late-entry-during-replacement', 'source-departure-during-shield', 'arbitrary-competing-death-order', 'capacity-overflow', 'gained-overwhelm', 'exotic-aura-cache', 'multi-player'])
        obligation(gap, 'No actual terminal full-source construction for this further interaction; existing primitive/source partials are separate evidence');
    return result;
}
function planArenaDamageProbes(entry, options = {}) {
    const shape = classifyArenaDamage(entry);
    if (!shape)
        return null;
    if (shape.condition)
        return planConditionalArenaDamage(entry, shape, options);
    const defs = Array.isArray(options.catalogue) ? options.catalogue : options.catalogue?.cards ?? [];
    const result = { schema: 'swu-card-probes/v1', cardId: entry.setCode, sourceHash: entry.sourceHash, cases: [], obligations: [], uncovered: [] };
    function obligation(name, reason) {
        const id = entry.setCode + ':arena-damage:' + name;
        result.obligations.push({ id, path: 'arena-damage', dimension: name });
        if (reason)
            result.uncovered.push({ id, path: 'arena-damage', reason });
        return id;
    }
    const quiet = defs.filter(quietUnit).sort((a, b) => a.setCode.localeCompare(b.setCode));
    const ground = quiet.find(e => e.card.arena === 'ground' && e.card.hp >= shape.amount + 4);
    const space = quiet.find(e => e.card.arena === 'space' && e.card.hp >= shape.amount + 4);
    const defeat = defs.find(defeatEvent);
    if (!ground || !space || (shape.trigger === 'whenDefeated' && !defeat)) {
        obligation('construction-donors', 'No bounded quiet ground/space or actual defeat donor');
        return result;
    }
    const row = (e, owner, extra = {}) => ({ code: e.setCode, owner, arena: e.card.arena, damage: 0, exhausted: false, ...extra });
    const mixed = [row(ground, 'self'), row(space, 'opponent'), row(ground, 'opponent', { exhausted: true }), row(space, 'self', { exhausted: true }), row(ground, 'self', { exhausted: true }), row(ground, 'opponent')];
    function add(name, targets, extra = {}) {
        const id = obligation(name);
        const probe = { ...shape, cardId: entry.setCode, sourceArena: entry.card.arena, targets, resourceCount: 24, sourceSeat: 1,
            ...(shape.trigger === 'whenDefeated' ? { activationCode: defeat.setCode } : {}), ...extra };
        result.cases.push({ id: `auto/${entry.setCode}/arena-damage-${name}`, name: 'arena-damage-' + name, kind: 'probe', focusCardIds: [entry.setCode],
            setupCardIds: [...new Set([...targets.map(t => t.code), ...targets.flatMap(t => (t.attachments ?? []).map(a => a.code)), ...(probe.activationCode ? [probe.activationCode] : []), ...(probe.deathGain ? ['TOKEN_THE_FORCE'] : []), ...(probe.defenseToken ? ['TOKEN_CLONE_TROOPER'] : [])])].sort(),
            source: { module: '../pipeline/probe-fixture.js', scenario: 'arena-damage-' + name }, behaviorIds: ['arena-list', 'damage', shape.trigger], assertionStages: ['construction', 'normal-play', 'resolved-list'], coverageObligationIds: [id], probe });
    }
    for (const sourceSeat of [1, 2]) {
        add('mixed-source-seat-' + sourceSeat, mixed, { sourceSeat });
        add('empty-source-seat-' + sourceSeat, [], { sourceSeat, empty: true });
    }
    const shield = defs.find(nativeShield);
    if (shield)
        for (const firstOwner of ['self', 'opponent'])
            add('paired-shields-' + firstOwner, [row(ground, 'self', { exhausted: true, attachments: [{ code: shield.setCode, token: 'shield' }, { code: shield.setCode, token: 'shield' }] }), row(ground, 'opponent', { exhausted: true, attachments: [{ code: shield.setCode, token: 'shield' }, { code: shield.setCode, token: 'shield' }] })], { ownerFirst: firstOwner, shieldCase: true });
    if (shield) {
        const otherGround = quiet.find(e => e.card.arena === 'ground' && e.card.hp >= shape.amount + 4 && e.setCode !== ground.setCode);
        if (otherGround)
            add('paired-shields-same-owner', [row(ground, 'opponent', { exhausted: true, attachments: [{ code: shield.setCode, token: 'shield' }, { code: shield.setCode, token: 'shield' }] }), row(otherGround, 'opponent', { exhausted: true, attachments: [{ code: shield.setCode, token: 'shield' }, { code: shield.setCode, token: 'shield' }] })], { shieldCase: true, sameOwnerShields: true });
    }
    else
        obligation('paired-shield-identities', 'Reviewed native Shield unavailable');
    const gains = defs.filter(e => ordinary(e) && !Object.keys(e.keywordValues ?? {}).length && !e.card.keywords?.length && Object.values(e.abilities ?? {}).flat().length === 2 &&
        e.abilities.card.every(a => keys(a, ['trigger', 'title', 'costs', 'effect']) && ['onAttack', 'whenDefeated'].includes(a.trigger) && same(a.costs, []) && same(a.effect, { kind: 'gainForce', target: 'ownPlayer' })) && new Set(e.abilities.card.map(a => a.trigger)).size === 2).sort((a, b) => a.setCode.localeCompare(b.setCode));
    const gain = gains.find(e => e.card.hp >= shape.amount);
    const nativeForce = defs.some(require('./force-probes').nativeForce);
    if (gain && nativeForce)
        for (const sourceSeat of [1, 2])
            add('lethal-death-gains-seat-' + sourceSeat, [row(gain, 'self', { damage: gain.card.hp - shape.amount, exhausted: true }), row(gain, 'opponent', { damage: gain.card.hp - shape.amount, exhausted: true })], { sourceSeat, deathGain: true });
    else
        obligation('captured-real-death-triggers', 'No bounded mandatory Force-death donor');
    if (shape.overwhelm) {
        const defender = quiet.find(e => e.card.arena === entry.card.arena && e.card.hp > shape.amount && e.card.hp < entry.card.power);
        if (defender)
            for (const shielded of [false, true])
                add('printed-overwhelm-' + (shielded ? 'shield' : 'excess'), [row(defender, 'opponent', { attachments: shielded && shield ? [{ code: shield.setCode, token: 'shield' }, { code: shield.setCode, token: 'shield' }] : [] })], { combatAfterPlay: true, attackTargetIndex: 0 });
        else
            obligation('printed-overwhelm-combat', 'No bounded quiet defender');
    }
    if (shape.coordinateRaid) {
        const plainBase = defs.filter(e => e.card.types.includes('base') && !e.card.text).sort((a, b) => a.setCode.localeCompare(b.setCode))[0];
        if (plainBase && entry.card.power + shape.coordinateRaid < plainBase.card.hp)
            for (const count of [2, 3])
                add('coordinate-friendly-count-' + count, [...Array.from({ length: count - 1 }, () => row(ground, 'self'))], { coordinateCombat: true, friendlyCount: count });
        else
            obligation('coordinate-combat-boundary', 'No nonterminal plain-base construction for this printed power/Raid total');
    }
    if (shape.trigger === 'onAttack') {
        const survivor = ground.card.power < entry.card.hp ? ground : quiet.find(e => e.card.arena === entry.card.arena && e.card.hp >= shape.amount + 4 && e.card.power < entry.card.hp);
        if (survivor)
            add('unit-defender-survives-wave-combat', [row(survivor, 'opponent')], { attackTargetIndex: 0, defenderSurvivesWave: true });
        else
            obligation('surviving-wave-combat', 'No bounded surviving-wave defender whose retaliation leaves the focus alive');
        add('unit-defender-departs-before-combat', [row(ground, 'opponent', { damage: ground.card.hp - shape.amount })], { attackTargetIndex: 0, defenderLethal: true });
        const defense = defs.find(e => ordinary(e) && e.card.arena === entry.card.arena && !e.card.unique && !e.card.keywords?.length && !Object.keys(e.keywordValues ?? {}).length && Object.values(e.abilities ?? {}).flat().length === 1 && e.abilities.card[0].trigger === 'onDefense' && keys(e.abilities.card[0], ['trigger', 'title', 'costs', 'effect']) && same(e.abilities.card[0].costs, []) && same(e.abilities.card[0].effect, { kind: 'createTokenUnit', target: 'ownPlayer', tokenType: 'cloneTrooper', amount: { kind: 'const', value: 1 }, entersReady: false }));
        if (defense && defense.card.hp >= shape.amount)
            add('captured-defense-after-source-death', [row(defense, 'opponent', { damage: defense.card.hp - shape.amount })], { attackTargetIndex: 0, defenderLethal: true, defenseToken: true, ownerFirst: 'self' });
        else
            obligation('captured-real-defense', 'No bounded real OnDefense Clone donor');
    }
    for (const gap of ['source-review', 'unique-source-replacement', 'recipient-reentry', 'controller-transfer', 'global-capacity-arithmetic', 'aura-dependent-death-membership', 'mixed-ordinary-attachment-cleanup', 'deployed-leader-token-domain', 'multi-player'])
        obligation(gap, 'No actual source-card construction for this dimension; separate primitive diagnostics are not full-card witnesses');
    return result;
}
module.exports = { classifyArenaDamage, planArenaDamageProbes, parsePredicate, quietUnit, defeatEvent, nativeShield, classifyConditionalArenaDamage, strictConditionalUnit, conditionalQuiet };
