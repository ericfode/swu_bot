'use strict';
const same = require('node:util').isDeepStrictEqual;
const keys = (v, allowed) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => allowed.includes(k));
const c = value => ({ kind: 'const', value }), r = (...path) => ({ kind: 'ref', path });
const weak = { kind: 'giveWeakness', target: 'chosen', amount: c(1) };
const resolver = owner => ({ owner, type: 'unit', zone: 'anyAttackable' });
const noPilot = e => !e.card?.pilotText && !e.card?.pilotBox && !e.card?.pilotingBox && !e.piloting && e.attachCondition == null;
const provenance = e => typeof e.sourcePath === 'string' && e.sourcePath.length > 0 && /^[a-f0-9]{64}$/.test(e.sourceHash ?? '');
function body(a, allowed) { return keys(a, allowed) && typeof a.title === 'string' && same(a.costs, []); }
function classifyWeaknessContinuation(e) {
    if (e?.status !== 'supported' || !e.card || typeof e.card.unique !== 'boolean' || !Array.isArray(e.card.keywords) || !Number.isInteger(e.card.cost) || e.card.cost < 0 || !noPilot(e) || typeof e.sourcePath !== 'string' || !e.sourcePath || !/^[a-f0-9]{64}$/.test(e.sourceHash ?? '') || !same(e.keywordValues ?? {}, {}) || e.card.keywords?.length || !keys(e.abilities, ['card', 'unit', 'leader']) || !['card', 'unit', 'leader'].every(k => Array.isArray(e.abilities[k])) || e.abilities.unit?.length || e.abilities.leader?.length)
        return null;
    const all = e.abilities.card ?? [], a = all[0];
    if (e.baseClass === 'EventCard' && same(e.card.types, ['event']) && all.length === 1) {
        if (!body(a, ['trigger', 'title', 'costs', 'contextTitle', 'targetResolver', 'effect']) || a.trigger !== 'event' || !same(a.targetResolver, resolver('any')))
            return null;
        const amount = a.effect?.amount, q = amount?.condition;
        if (!keys(a.effect, ['kind', 'target', 'amount']) || a.effect.kind !== 'giveWeakness' || a.effect.target !== 'chosen' || !keys(amount, ['kind', 'condition', 'then', 'else']) || amount.kind !== 'conditional' || !keys(q, ['kind', 'name', 'receiver', 'args']) || q.kind !== 'query' || q.name !== 'hasSomeTrait' || !same(q.receiver, r('player', 'base')) || !Array.isArray(q.args) || q.args.length !== 1 || !keys(q.args[0], ['kind', 'value']) || q.args[0].kind !== 'const' || typeof q.args[0].value !== 'string' || !q.args[0].value || !same(amount.then, c(2)) || !same(amount.else, c(1)))
            return null;
        const expected = [c('Give '), { kind: 'conditional', condition: q, then: c('2 Weakness tokens'), else: c('a Weakness token') }, c(' to '), { kind: 'conditional', condition: r('target'), then: r('target', 'title'), else: c('a unit') }, c('')];
        if (!same(a.contextTitle, expected))
            return null;
        return { family: 'weakness-continuation', mode: 'base-amount', baseTrait: q.args[0].value, trigger: 'event' };
    }
    if (e.baseClass !== 'NonLeaderUnitCard' || !same(e.card.types, ['unit']) || !['ground', 'space'].includes(e.card.arena) || !Number.isInteger(e.card.hp) || e.card.hp < 2 || !Number.isInteger(e.card.power) || e.card.power < 0)
        return null;
    if (all.length === 1 && body(a, ['trigger', 'title', 'costs', 'effect', 'then']) && a.trigger === 'whenPlayed' && same(a.effect, { kind: 'createTokenUnit', tokenType: 'beast', amount: c(1), target: 'ownPlayer', entersReady: false }) && body(a.then, ['title', 'costs', 'targetResolver', 'effect']) && same(a.then.targetResolver, resolver('self')) && same(a.then.effect, weak))
        return { family: 'weakness-continuation', mode: 'beast-then', trigger: 'whenPlayed' };
    const pair = { kind: 'simultaneous', effects: [{ kind: 'damage', target: 'chosen', amount: c(1) }, weak] };
    if (all.length === 2 && all.every(x => body(x, ['trigger', 'title', 'costs', 'optional', 'targetResolver', 'effect']) && x.optional === true && same(x.targetResolver, resolver('any')) && same(x.effect, pair)) && all[0].trigger === 'whenPlayed' && all[1].trigger === 'whenDefeated')
        return { family: 'weakness-continuation', mode: 'damage-pair', trigger: 'whenPlayed' };
    const sequence = { kind: 'sequence', effects: [weak, { kind: 'conditional', condition: r('target', 'unique'), onTrue: { kind: 'exhaust', target: 'chosen' }, onFalse: { kind: 'noAction' } }] };
    if (all.length === 1 && body(a, ['trigger', 'title', 'costs', 'optional', 'targetResolver', 'effect']) && a.trigger === 'whenPlayed' && a.optional === true && same(a.targetResolver, resolver('any')) && same(a.effect, sequence))
        return { family: 'weakness-continuation', mode: 'weakness-exhaust', trigger: 'whenPlayed' };
    return null;
}
function quietUnit(e, unique = false) { return e.status === 'supported' && keys(e.abilities, ['card', 'unit', 'leader']) && ['card', 'unit', 'leader'].every(k => Array.isArray(e.abilities[k])) && typeof e.card?.text === 'string' && Number.isInteger(e.card.cost) && e.card.cost >= 0 && Number.isInteger(e.card.hp) && e.card.hp > 0 && Number.isInteger(e.card.power) && e.card.power >= 0 && same(e.card?.types, ['unit']) && e.card.unique === unique && !e.card.text && !e.card.keywords?.length && !Object.keys(e.keywordValues ?? {}).length && !Object.values(e.abilities ?? {}).flat().length && !e.baseClass && e.sourcePath === null && e.sourceHash === null && noPilot(e) && ['ground', 'space'].includes(e.card.arena); }
function defeatEvent(e) { const a = e.abilities?.card?.[0]; return e.status === 'supported' && provenance(e) && keys(e.abilities, ['card', 'unit', 'leader']) && ['card', 'unit', 'leader'].every(k => Array.isArray(e.abilities[k])) && e.baseClass === 'EventCard' && same(e.card?.types, ['event']) && noPilot(e) && !e.card.keywords?.length && !Object.keys(e.keywordValues ?? {}).length && Object.values(e.abilities ?? {}).flat().length === 1 && body(a, ['trigger', 'title', 'costs', 'targetResolver', 'effect']) && a.trigger === 'event' && same(a.targetResolver, resolver('any')) && same(a.effect, { kind: 'defeat', target: 'chosen' }); }
const reviewedBeast = { "title": "Beast", "subtitle": "", "cost": 0, "hp": 3, "power": 3, "text": "", "deployBox": null, "epicAction": "", "unique": false, "rules": null, "upgradePower": null, "upgradeHp": null, "id": "6445363199", "aspects": [], "traits": ["creature"], "arena": "ground", "keywords": [], "types": ["token", "unit"], "setId": { "set": "HMW" }, "internalName": "beast" };
function nativeBeast(e) { return e?.setCode === 'TOKEN_BEAST' && e.status === 'supported' && e.baseClass === 'TokenUnitCard' && e.className === 'Beast' && e.id === '6445363199' && e.internalName === 'beast' && e.sourcePath === 'game/cards/09_HMW/tokens/Beast.ts' && e.sourceHash === 'e9ce58041d8cb93f9a98e773c016dc56bad9271ee30b7954411a7d63357c2566' && same(e.card, reviewedBeast) && same(e.abilities, { leader: [], unit: [], card: [] }) && same(e.keywordValues, {}) && noPilot(e); }
function planWeaknessContinuationProbes(entry, options = {}) {
    const shape = classifyWeaknessContinuation(entry);
    if (!shape)
        return null;
    const defs = Array.isArray(options.catalogue) ? options.catalogue : options.catalogue?.cards ?? [];
    const result = { schema: 'swu-card-probes/v1', cardId: entry.setCode, sourceHash: entry.sourceHash, cases: [], obligations: [], uncovered: [] };
    const obligation = (name, reason) => {
        const id = entry.setCode + ':weakness-continuation:' + name;
        result.obligations.push({ id, path: 'weakness-continuation', dimension: name });
        if (reason)
            result.uncovered.push({ id, path: 'weakness-continuation', reason });
        return id;
    };
    const plain = defs.filter(e => quietUnit(e)).sort((a, b) => a.setCode.localeCompare(b.setCode)), durable = plain.find(e => e.card.hp >= 5 && e.card.power === 1), unique = defs.find(e => quietUnit(e, true) && e.card.hp >= 3), kill = defs.find(defeatEvent);
    const weakness = defs.find(require('./weakness-upgrade-probes').nativeWeakness), shield = defs.find(require('./arena-damage-probes').nativeShield);
    const plainBase = e => e.status === 'supported' && same(e.card.types, ['base']) && !e.card.text && e.sourcePath === null && e.sourceHash === null && !e.baseClass && !e.card.epicAction && e.card.hp === 30;
    const base = defs.find(e => plainBase(e) && !e.card.traits.includes(shape.baseTrait ?? 'naboo')), traitBase = defs.find(e => plainBase(e) && e.card.traits.includes(shape.baseTrait ?? 'naboo'));
    const beast = defs.find(nativeBeast);
    const aura = defs.find(e => provenance(e) && e.status === 'supported' && e.baseClass === 'NonLeaderUnitCard' && same(e.card.types, ['unit']) && noPilot(e) && same(e.keywordValues, {}) && !e.card.keywords.length && Object.values(e.abilities).flat().length === 1 && body(e.abilities.card[0], ['trigger', 'title', 'costs', 'effect', 'targetResolver']) && e.abilities.card[0].trigger === 'constant' && same(e.abilities.card[0].effect, { kind: 'modifyStats', target: 'chosen', duration: 'persistent', power: c(-2), hp: c(-2) }) && same(e.abilities.card[0].targetResolver, { owner: 'opponent', type: 'nonLeaderUnit', zone: 'arena' }));
    const deathDamage = defs.find(e => { const s = require('./arena-damage-probes').classifyArenaDamage(e); return provenance(e) && s?.trigger === 'whenDefeated' && s.receiver === 'opponent' && s.arena === 'ground' && !s.exhaustedOnly && s.amount === 1 && s.coordinateRaid === 2 && e.card.unique && e.card.hp >= 2; });
    const forceNative = defs.find(require('./force-probes').nativeForce);
    const forceDeath = forceNative && defs.find(e => provenance(e) && require('./force-trigger-probes').classifyForceTriggers(e)?.kind === 'dual-gain' && !e.card.unique);
    if (!durable || !weakness || !base || shape.mode === 'base-amount' && !traitBase || shape.mode === 'beast-then' && !beast) {
        obligation('construction-donors', 'Missing reviewed native or quiet source-bound construction metadata');
        return result;
    }
    const row = (e, owner, extra = {}) => ({ code: e.setCode, owner, arena: e.card.arena, exhausted: false, damage: 0, ...extra });
    function add(name, sourceSeat, targets, extra = {}) {
        const id = obligation(name + '-seat-' + sourceSeat), probe = { ...shape, cardId: entry.setCode, sourceSeat, resourceCount: 24, targets, selectedIndex: 0, variant: 'normal', trigger: 'play', baseCode: base.setCode, enemyBaseCode: base.setCode, ...extra };
        result.cases.push({ id: 'auto/' + entry.setCode + '/weakness-continuation-' + name + '-seat-' + sourceSeat, name: 'weakness-continuation-' + name + '-seat-' + sourceSeat, kind: 'probe', source: { module: '../pipeline/probe-fixture.js', scenario: 'weakness-continuation-' + name + '-seat-' + sourceSeat }, focusCardIds: [entry.setCode], setupCardIds: [...new Set([weakness.setCode, base.setCode, probe.baseCode, probe.enemyBaseCode, ...targets.map(t => t.code), ...targets.flatMap(t => (t.attachments ?? []).map(a => a.code)), ...(probe.activationCode ? [probe.activationCode] : []), ...(beast && shape.mode === 'beast-then' ? [beast.setCode] : []), ...(probe.forceDeath ? [forceNative.setCode] : [])])].sort(), behaviorIds: ['weakness-token', 'continuation', shape.mode], assertionStages: ['construction', 'normal-play', 'source-effects', 'terminal'], coverageObligationIds: [id], probe });
    }
    for (const seat of [1, 2]) {
        if (shape.mode === 'base-amount') {
            for (const match of ['own', 'enemy', 'neither'])
                for (const owner of ['self', 'opponent'])
                    add('base-' + match + '-' + owner, seat, [row(durable, owner)], { baseCode: match === 'own' ? traitBase.setCode : base.setCode, enemyBaseCode: match === 'enemy' ? traitBase.setCode : base.setCode, expectedWeak: match === 'own' ? 2 : 1 });
            for (const cancel of [false, true])
                add('empty-' + (cancel ? 'cancel' : 'confirm'), seat, [], { variant: cancel ? 'empty-cancel' : 'empty', empty: true, expectedWeak: 0 });
            add('cancel', seat, [row(durable, 'opponent')], { variant: 'cancel', expectedWeak: 0 });
            add('two-weakness-lethal', seat, [row(durable, 'opponent', { damage: durable.card.hp - 1 })], { baseCode: traitBase.setCode, expectedWeak: 2, variant: 'lethal' });
        }
        else if (shape.mode === 'beast-then') {
            for (const variant of ['created-beast', 'source', 'other'])
                add(variant, seat, [row(durable, 'self'), row(durable, 'opponent')], { variant, expectedWeak: 1 });
            if (aura && entry.card.hp === 2)
                add('captured-source-death-aura', seat, [row(aura, 'opponent', { zone: 'hand' })], { variant: 'created-beast', expectedWeak: 1, snokeEntry: true, prerequisiteIndex: 0 });
        }
        else if (shape.mode === 'damage-pair') {
            for (const trigger of ['play', 'death'])
                for (const variant of ['normal', 'shield', 'damage-lethal', 'hp-lethal', 'decline']) {
                    if (variant === 'shield' && !shield) {
                        obligation('shield-donor-seat-' + seat + '-' + trigger, 'No exact reviewed native Shield donor');
                        continue;
                    }
                    if (trigger === 'death' && !kill) {
                        obligation('death-donor', 'No exact actual defeat event');
                        continue;
                    }
                    const damage = variant === 'damage-lethal' ? durable.card.hp - 1 : variant === 'hp-lethal' ? durable.card.hp - 2 : 0;
                    add(trigger + '-' + variant, seat, [row(durable, 'opponent', { damage, ...(variant === 'shield' && shield ? { attachments: [{ code: shield.setCode, token: 'shield' }] } : {}) })], { trigger, variant, expectedWeak: variant === 'decline' ? 0 : 1, ...(trigger === 'death' ? { activationCode: kill.setCode } : {}) });
                }
            if (entry.card.unique)
                for (const keepOld of [false, true])
                    add('unique-' + (keepOld ? 'old' : 'new'), seat, [row(durable, 'opponent'), row(entry, 'self', { exhausted: true })], { uniqueReplacement: true, keepOld, variant: 'unique', expectedWeak: 2 });
        }
        else {
            for (const variant of ['unique-ready', 'nonunique-ready', 'unique-exhausted', 'unique-lethal', 'decline']) {
                const donor = variant.startsWith('unique') ? unique : durable;
                if (!donor) {
                    obligation('unique-donor', 'No exact quiet unique donor');
                    continue;
                }
                add(variant, seat, [row(donor, 'opponent', { exhausted: variant === 'unique-exhausted', damage: variant === 'unique-lethal' ? donor.card.hp - 1 : 0 })], { variant, expectedWeak: variant === 'decline' ? 0 : 1 });
            }
        }
        if (deathDamage && shape.mode !== 'beast-then') {
            const deathTargets = [row(deathDamage, 'opponent', { damage: deathDamage.card.hp - 1 }), row(durable, 'self')];
            add('captured-death-damage', seat, deathTargets, { variant: 'death-hevy', expectedWeak: shape.mode === 'base-amount' ? 2 : 1, baseCode: shape.mode === 'base-amount' ? traitBase.setCode : base.setCode, deathDamage: true });
            if (shape.mode === 'damage-pair' && kill)
                add('paid-death-captured-damage', seat, deathTargets, { trigger: 'death', activationCode: kill.setCode, variant: 'death-hevy', expectedWeak: 1, deathDamage: true });
        }
        if (forceDeath && shape.mode !== 'beast-then')
            add('captured-death-force', seat, [row(forceDeath, 'opponent', { damage: forceDeath.card.hp - 1 })], { variant: 'death-force', expectedWeak: shape.mode === 'base-amount' ? 2 : 1, baseCode: shape.mode === 'base-amount' ? traitBase.setCode : base.setCode, forceDeath: true });
    }
    for (const gap of ['source-review', 'controller-transfer', 'mixed-attachments', 'replacement-hooks', 'large-capacity', 'deployed-leader-target', 'optional-empty-after-source-departure', 'unique-death-choice-order', 'opposing-simultaneous-death-priority'])
        obligation(gap, 'No actual full-source construction for this interaction; partial engine checkpoints and synthetic primitives are separate evidence');
    return result;
}
module.exports = { classifyWeaknessContinuation, planWeaknessContinuationProbes, quietUnit, defeatEvent, nativeBeast };
