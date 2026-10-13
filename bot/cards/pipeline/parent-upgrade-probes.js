'use strict';
const same = require('node:util').isDeepStrictEqual;
const keys = (v, allowed) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => allowed.includes(k));
const c = value => ({ kind: 'const', value }), r = (...path) => ({ kind: 'ref', path });
const noPilot = e => e.card?.pilotText == null && e.card?.pilotBox == null && e.card?.pilotingBox == null && e.piloting == null && e.attachCondition == null;
const provenance = e => typeof e?.sourcePath === 'string' && e.sourcePath.length > 0 && /^[a-f0-9]{64}$/.test(e.sourceHash ?? '');
const sides = e => keys(e.abilities, ['card', 'leader', 'unit']) && ['card', 'leader', 'unit'].every(k => Array.isArray(e.abilities[k]));
const body = (a, allowed) => keys(a, allowed) && typeof a.title === 'string' && same(a.costs, []);
function classifyParentUpgrade(e) {
    if (e?.status !== 'supported' || e.baseClass !== 'UpgradeCard' || !same(e.card?.types, ['upgrade']) || e.card.unique !== false ||
        !provenance(e) || !noPilot(e) || !sides(e) || e.abilities.leader.length || e.abilities.unit.length || e.abilities.card.length !== 1 ||
        !same(e.card.keywords, []) || !same(e.keywordValues, {}) || !Number.isInteger(e.card.cost) || e.card.cost < 0 || e.card.cost > 8 || !Array.isArray(e.card.aspects) || e.card.aspects.length > 2 || !e.card.aspects.every(a => typeof a === 'string') ||
        e.card.hp !== 2 || e.card.upgradeHp !== 2 || !Number.isInteger(e.card.power) || e.card.power < 0 || e.card.power !== e.card.upgradePower)
        return null;
    const a = e.abilities.card[0], effect = a.effect;
    if (a.trigger !== 'whenPlayed' || !body(a, ['trigger', 'title', 'costs', 'contextTitle', 'effect']) ||
        !keys(effect, ['kind', 'condition', 'onTrue', 'onFalse']) || effect.kind !== 'conditional' || !same(effect.onFalse, { kind: 'noAction' }))
        return null;
    const traitCondition = { kind: 'binary', op: '&&', left: { kind: 'binary', op: '!=', left: r('source', 'parentCard'), right: c(null) },
        right: { kind: 'query', name: 'hasSomeTrait', receiver: r('source', 'parentCard'), args: [{ kind: 'array', items: [c('creature'), c('force')] }] } };
    if (same(effect.condition, traitCondition) && !Object.hasOwn(a, 'contextTitle') && same(effect.onTrue, { kind: 'createTokenUnit', tokenType: 'beast', amount: c(1), target: 'ownPlayer', entersReady: false }))
        return { family: 'parent-upgrade', mode: 'parent-trait-beast', traits: ['creature', 'force'] };
    const title = [c('Give a Shield token to '), { kind: 'binary', op: '??', left: r('source', 'parentUnit', 'title'), right: c('the attached unit') }, c('')];
    if (same(effect.condition, { kind: 'query', name: 'hasSomeAspect', receiver: r('source', 'parentUnit'), args: [c('heroism')] }) &&
        same(effect.onTrue, { kind: 'giveShield', target: r('source', 'parentUnit'), amount: c(1) }) && same(a.contextTitle, title))
        return { family: 'parent-upgrade', mode: 'parent-aspect-shield', aspect: 'heroism', titlePrefix: 'Give a Shield token to ' };
    return null;
}
function quietUnit(e) {
    return e?.status === 'supported' && same(e.card?.types, ['unit']) && e.card.unique === false && noPilot(e) && e.baseClass == null && e.sourcePath === null && e.sourceHash === null &&
        e.card.text === '' && same(e.card.keywords, []) && same(e.keywordValues, {}) && same(e.abilities, { leader: [], unit: [], card: [] }) &&
        ['ground', 'space'].includes(e.card.arena) && Number.isInteger(e.card.hp) && e.card.hp > 0 && Number.isInteger(e.card.power) && e.card.power >= 0 &&
        Number.isInteger(e.card.cost) && e.card.cost >= 0 && Array.isArray(e.card.traits) && e.card.traits.every(t => typeof t === 'string') && Array.isArray(e.card.aspects) && e.card.aspects.every(a => typeof a === 'string');
}
function blankNabooBase(e) {
    return e?.status === 'supported' && same(e.card?.types, ['base']) && e.baseClass == null && e.sourcePath === null && e.sourceHash === null && noPilot(e) &&
        e.card.text === '' && same(e.card.keywords, []) && same(e.keywordValues, {}) && same(e.abilities, { leader: [], unit: [], card: [] }) &&
        Number.isInteger(e.card.hp) && e.card.hp > 0 && Array.isArray(e.card.traits) && e.card.traits.every(t => typeof t === 'string') && e.card.traits.includes('naboo') &&
        Array.isArray(e.card.aspects) && e.card.aspects.every(a => typeof a === 'string');
}
function overlapHost(e) {
    if (!provenance(e) || !sides(e) || !Array.isArray(e.card?.traits) || !e.card.traits.every(t => typeof t === 'string') || typeof e.card.unique !== 'boolean' || !Number.isInteger(e.card.hp) || e.card.hp < 3 || !Number.isInteger(e.card.power) || e.card.power < 0)
        return false;
    const shape = require('./arena-damage-probes').classifyArenaDamage(e);
    return provenance(e) && shape?.trigger === 'onAttack' && shape.receiver === 'game' && shape.excludeSource && shape.amount === 3 &&
        shape.arena === null && shape.coordinateRaid === 0 && same(e.keywordValues, {}) && same(e.card.keywords, []) && e.card.traits.includes('creature') && e.card.traits.includes('force');
}
function leaderHost(e) {
    if (e?.status !== 'supported' || e.baseClass !== 'LeaderUnitCard' || !same(e.card?.types, ['leader']) || !provenance(e) || !noPilot(e) || !sides(e) || e.card.arena !== 'ground' ||
        e.card.unique !== true || !Number.isInteger(e.card.hp) || e.card.hp < 3 || !Number.isInteger(e.card.power) || e.card.power < 0 || !Number.isInteger(e.card.cost) || e.card.cost < 0 || e.abilities.card.length || e.abilities.unit.length || e.abilities.leader.length !== 1 || !same(e.card.keywords, ['restore']) ||
        !Number.isInteger(e.keywordValues?.restore) || e.keywordValues.restore < 1 || e.card.deployBox !== 'Restore ' + e.keywordValues.restore || Object.keys(e.keywordValues).length !== 1 || !Array.isArray(e.card.aspects) || !e.card.aspects.includes('heroism'))
        return false;
    const a = e.abilities.leader[0];
    return keys(a, ['trigger', 'title', 'costs', 'effect', 'ifYouDo']) && a.trigger === 'action' && same(a.costs, [{ kind: 'exhaustSelf' }]) &&
        same(a.effect, { kind: 'distributeHealing', amount: c(2), maxTargets: 1, canChooseNoTargets: true, canDistributeLess: true, targetResolver: { owner: 'any', type: 'unit', zone: 'anyAttackable' } }) &&
        body(a.ifYouDo, ['title', 'costs', 'effect']) && same(a.ifYouDo.effect, { kind: 'damage', target: 'ownBase', amount: r('event', 'totalDistributed') });
}
function returnDonor(e) {
    if (!e?.card || !sides(e) || !Number.isInteger(e.card.cost) || e.card.cost < 0 || e.card.cost > 4 || !Array.isArray(e.card.aspects) || e.card.aspects.length > 2)
        return false;
    const shape = require('./upgrade-return-probes').classifyUpgradeReturn(e);
    return e?.status === 'supported' && e.baseClass === 'NonLeaderUnitCard' && same(e.card?.types, ['unit']) && e.card.unique === false && provenance(e) && noPilot(e) &&
        sides(e) && e.abilities.card.length === 1 && e.abilities.leader.length === 0 && e.abilities.unit.length === 0 && same(e.keywordValues, {}) && same(e.card.keywords, []) &&
        shape?.nonUnique === true && !shape.sourceUpgrade && !shape.discard && !shape.conditional && shape.threshold === null;
}
function torrentDonor(e) {
    if (!e?.card || !sides(e) || !Number.isInteger(e.card.cost) || e.card.cost < 0 || e.card.cost > 4 || !Array.isArray(e.card.aspects) || e.card.aspects.length > 2)
        return false;
    const shape = require('./weakness-continuation-probes').classifyWeaknessContinuation(e);
    return e?.status === 'supported' && e.baseClass === 'EventCard' && same(e.card?.types, ['event']) && provenance(e) && noPilot(e) && sides(e) && e.card.unique === false && same(e.keywordValues, {}) && same(e.card.keywords, []) && shape?.mode === 'base-amount' && shape.baseTrait === 'naboo';
}
function planParentUpgradeProbes(entry, options = {}) {
    const shape = classifyParentUpgrade(entry);
    if (!shape)
        return null;
    const defs = Array.isArray(options.catalogue) ? options.catalogue : options.catalogue?.cards ?? [];
    const result = { schema: 'swu-card-probes/v1', cardId: entry.setCode, sourceHash: entry.sourceHash, cases: [], obligations: [], uncovered: [] };
    const obligation = (name, reason) => {
        const id = entry.setCode + ':parent-upgrade:' + name;
        result.obligations.push({ id, path: 'parent-upgrade', dimension: name });
        if (reason)
            result.uncovered.push({ id, path: 'parent-upgrade', reason });
        return id;
    };
    const beast = defs.find(require('./weakness-continuation-probes').nativeBeast), shield = defs.find(require('./arena-damage-probes').nativeShield);
    if (!beast || !shield) {
        obligation('native-dependencies', 'Missing exact reviewed Beast or Shield native definition');
        return result;
    }
    const plain = defs.filter(quietUnit).sort((a, b) => a.setCode.localeCompare(b.setCode));
    const ground = plain.filter(e => e.card.arena === 'ground' && e.card.hp >= 3), space = plain.filter(e => e.card.arena === 'space' && e.card.hp >= 3);
    const roles = shape.mode === 'parent-trait-beast' ? {
        'creature-ground': ground.find(e => e.card.traits.includes('creature') && !e.card.traits.includes('force')),
        'force-ground': ground.find(e => e.card.traits.includes('force') && !e.card.traits.includes('creature')),
        'both-ground': defs.find(overlapHost), 'neither-ground': ground.find(e => !e.card.traits.some(t => shape.traits.includes(t))),
        'creature-space': space.find(e => e.card.traits.includes('creature')), 'neither-space': space.find(e => !e.card.traits.some(t => shape.traits.includes(t)))
    } : {
        'heroism-ground': ground.find(e => e.card.aspects.includes(shape.aspect)), 'nonheroism-ground': ground.find(e => !e.card.aspects.includes(shape.aspect)),
        'heroism-space': space.find(e => e.card.aspects.includes(shape.aspect)), 'nonheroism-space': space.find(e => !e.card.aspects.includes(shape.aspect))
    };
    const base = defs.find(blankNabooBase);
    const torrent = defs.find(torrentDonor), returned = defs.find(returnDonor), weakness = defs.find(nativeWeakness), clone = defs.find(nativeCloneTrooper), leader = defs.find(leaderHost);
    function add(name, seat, owner, host, extra = {}) {
        const target = { code: host.setCode, owner, arena: host.card.arena, damage: Math.min(1, host.card.hp - 1), exhausted: true, ...extra.target };
        const targets = [target];
        if (extra.removal)
            targets.push({ code: torrent.setCode, owner: 'self', zone: 'hand' }, { code: returned.setCode, owner: 'self', zone: 'hand' });
        const otherArena = host.card.arena === 'ground' ? 'space' : 'ground';
        const unselected = plain.find(e => e.card.arena === otherArena && e.card.hp >= 3 && (shape.mode === 'parent-trait-beast' ? e.card.traits.some(t => shape.traits.includes(t)) : e.card.aspects.includes(shape.aspect)));
        if (!unselected) {
            obligation('missing-positive-unselected-' + otherArena, 'No actual guarded positive-predicate unselected recipient for identity isolation');
            return;
        }
        const unselectedIndex = targets.length;
        targets.push({ code: unselected.setCode, owner: 'self', arena: unselected.card.arena, exhausted: true, damage: 1 });
        const id = obligation(name + '-seat-' + seat + '-host-' + owner), scenario = 'parent-upgrade-' + name + '-seat-' + seat + '-host-' + owner;
        const positive = shape.mode === 'parent-trait-beast' ? host.card.traits.some(t => shape.traits.includes(t)) : host.card.aspects.includes(shape.aspect);
        const probe = { ...shape, cardId: entry.setCode, sourceSeat: seat, targets, hostIndex: 0, unselectedIndex, positive, resourceCount: 30, ...(extra.removal ? { baseCode: base.setCode, enemyBaseCode: base.setCode, torrentIndex: 1, returnIndex: 2 } : {}), ...extra };
        delete probe.target;
        result.cases.push({ id: 'auto/' + entry.setCode + '/' + scenario, name: scenario, kind: 'probe', source: { module: '../pipeline/probe-fixture.js', scenario }, focusCardIds: [entry.setCode],
            setupCardIds: [...new Set([beast.setCode, shield.setCode, ...targets.map(t => t.code), ...targets.flatMap(t => (t.attachments ?? []).map(a => a.code)), ...(extra.removal ? [weakness.setCode, base.setCode] : [])])].sort(),
            behaviorIds: ['parent-identity', 'ordinary-upgrade-stats', shape.mode], assertionStages: ['construction', 'normal-play', 'source-effects', 'terminal'], coverageObligationIds: [id], probe });
    }
    for (const seat of [1, 2]) {
        for (const owner of ['self', 'opponent']) {
            for (const [role, host] of Object.entries(roles)) {
                if (host)
                    add('attach-' + role, seat, owner, host);
                else
                    obligation('missing-' + role, 'No actual guarded metadata-selected host for this source predicate');
            }
            const positive = Object.values(roles).find(e => e && (shape.mode === 'parent-trait-beast' ? e.card.traits.some(t => shape.traits.includes(t)) : e.card.aspects.includes(shape.aspect)));
            if (shape.mode === 'parent-aspect-shield' && positive)
                add('existing-shield-additive', seat, owner, positive, { target: { attachments: [{ code: shield.setCode, token: 'shield' }] } });
            const woundHost = ground.find(e => e.card.hp === 3 && (shape.mode === 'parent-trait-beast' ? e.card.traits.some(t => shape.traits.includes(t)) : e.card.aspects.includes(shape.aspect)));
            if (base && torrent && returned && weakness && woundHost)
                add('actual-return-hp-death', seat, owner, woundHost, { removal: true, target: { damage: 2 } });
            else
                obligation('actual-return-hp-death', 'Missing complete real Naboo/Torrent/ordinary-return or HP3 recipient donor');
            if (shape.mode === 'parent-trait-beast')
                add('native-beast-host', seat, owner, beast, { target: { token: 'beast' } });
            else {
                if (clone)
                    add('native-clone-host', seat, owner, clone, { target: { token: 'cloneTrooper' } });
                else
                    obligation('native-clone-host', 'Missing reviewed exact Clone Trooper native dependency');
                if (leader)
                    add('deployed-leader-host', seat, owner, leader, { leaderCode: leader.setCode, target: { deployedLeader: true } });
                else
                    obligation('deployed-leader-host', 'No guarded real Heroism leader host');
            }
        }
        const host = Object.values(roles).find(Boolean);
        if (host)
            add('prepayment-cancel', seat, 'opponent', host, { cancel: true });
    }
    for (const gap of ['source-review', 'detached-source-captured-wp', 'reattachment-controller-transfer', 'space-force-both-host', 'competing-context-title-menu', 'parent-title-null-fallback', 'host-unique-reaction', 'no-unit-action-illegal', 'natural-phase-upgrade-persistence', 'ordinary-focus-upgrade-stacking', 'external-token-replacement', 'native-capacity'])
        obligation(gap, 'No actual full-source construction for this additional interaction; partial observations and native primitives are separate evidence');
    return result;
}
const reviewedCloneTrooper = { "setCode": "TOKEN_CLONE_TROOPER", "sourcePath": "game/cards/03_TWI/tokens/CloneTrooper.ts", "sourceHash": "b64ec46d8624c3db5bce94d160e4e25ac53caf83c5e3390cb290880f23c008f6", "abilities": { "leader": [], "unit": [], "card": [] }, "diagnostics": [], "className": "CloneTrooper", "baseClass": "TokenUnitCard", "id": "3941784506", "internalName": "clone-trooper", "status": "supported", "card": { "title": "Clone Trooper", "subtitle": "", "cost": 0, "hp": 2, "power": 2, "text": "", "deployBox": null, "epicAction": null, "unique": false, "rules": null, "upgradePower": null, "upgradeHp": null, "id": "3941784506", "aspects": ["heroism"], "traits": ["republic", "clone", "trooper"], "arena": "ground", "keywords": [], "types": ["token", "unit"], "setId": { "set": "TWI" }, "internalName": "clone-trooper" }, "dataHash": "8d141355e0b295cd856b3bd856e0f0ed8f969b875e303e8bd7f3cec0b10127c1", "keywordValues": {}, "requiredCapabilities": ["cardType:token", "cardType:unit"] };
function nativeCloneTrooper(e) { return same(e, reviewedCloneTrooper); }
const reviewedWeakness = { "setCode": "TOKEN_WEAKNESS", "sourcePath": "game/cards/09_HMW/tokens/Weakness.ts", "sourceHash": "dd546e4886757d77fffeb8be6e7381144fa7378b6493ce444aa87e4ba1202778", "abilities": { "leader": [], "unit": [], "card": [] }, "diagnostics": [{ "code": "UNSUPPORTED_SOURCE", "pattern": "method:isWeakness", "file": "game/cards/09_HMW/tokens/Weakness.ts", "line": 12, "column": 1, "message": "Additional class method requires conversion" }, { "code": "UNSUPPORTED_SOURCE", "pattern": "class-member:GetAccessor", "file": "game/cards/09_HMW/tokens/Weakness.ts", "line": 16, "column": 1, "message": "Additional class behavior requires conversion" }], "className": "Weakness", "baseClass": "TokenUpgradeCard", "id": "7816991190", "internalName": "weakness", "status": "unsupported", "card": { "title": "Weakness", "subtitle": "", "cost": 0, "hp": -1, "power": -1, "text": "", "deployBox": null, "epicAction": "", "unique": false, "rules": null, "upgradePower": -1, "upgradeHp": -1, "id": "7816991190", "aspects": [], "traits": ["condition"], "keywords": [], "types": ["token", "upgrade"], "setId": { "set": "HMW" }, "internalName": "weakness" }, "dataHash": "6a8e3afbc95ff1ddbceb2edf8aafdfd558a8ce5b148c375e45f250792ae96fd7", "keywordValues": {}, "requiredCapabilities": ["cardType:token", "cardType:upgrade"] };
function nativeWeakness(e) { return same(e, reviewedWeakness); }
module.exports = { classifyParentUpgrade, planParentUpgradeProbes, quietUnit, blankNabooBase, overlapHost, leaderHost, returnDonor, torrentDonor, nativeCloneTrooper, nativeWeakness };
