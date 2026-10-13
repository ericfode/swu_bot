'use strict';
const same = require('node:util').isDeepStrictEqual;
const keys = (v, allowed) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => allowed.includes(k));
const c = value => ({ kind: 'const', value }), r = (...path) => ({ kind: 'ref', path });
const noPilot = e => !e.card?.pilotText && !e.card?.pilotBox && !e.card?.pilotingBox && !e.piloting && e.attachCondition == null;
const provenance = e => typeof e.sourcePath === 'string' && e.sourcePath.length > 0 && /^[a-f0-9]{64}$/.test(e.sourceHash ?? '');
const body = (a, allowed) => keys(a, allowed) && typeof a.title === 'string' && same(a.costs, []);
function classifyForceContinuation(e) {
    const all = e?.abilities?.card, a = all?.[0];
    if (e?.status !== 'supported' || !e.card || !provenance(e) || !noPilot(e) || !keys(e.abilities, ['card', 'leader', 'unit']) || !['card', 'leader', 'unit'].every(k => Array.isArray(e.abilities[k])) || all.length !== 1 || e.abilities.leader.length || e.abilities.unit.length || typeof e.card.unique !== 'boolean' || !Number.isInteger(e.card.cost) || e.card.cost < 0 || !Array.isArray(e.card.keywords))
        return null;
    if (e.baseClass === 'EventCard' && same(e.card.types, ['event'])) {
        if (!same(e.keywordValues, {}) || e.card.keywords.length || !body(a, ['trigger', 'title', 'costs', 'effect']) || a.trigger !== 'event' || !keys(a.effect, ['kind', 'effects']) || a.effect.kind !== 'simultaneous' || a.effect.effects?.length !== 2)
            return null;
        const [select, gain] = a.effect.effects, resolve = select?.targetResolver;
        if (!keys(select, ['kind', 'targetResolver', 'effect']) || select.kind !== 'select' || !keys(resolve, ['owner', 'type', 'zone', 'promptTitle']) || resolve.owner !== 'any' || resolve.type !== 'unit' || resolve.zone !== 'anyAttackable' || typeof resolve.promptTitle !== 'string' || !resolve.promptTitle || Buffer.byteLength(resolve.promptTitle, 'utf8') > 1024 || !same(select.effect, { kind: 'damage', target: 'chosen', amount: c(2) }) || !same(gain, { kind: 'gainForce', target: 'ownPlayer' }))
            return null;
        return { family: 'force-continuation', mode: 'inline-damage-gain', inlineTitle: resolve.promptTitle, amount: 2 };
    }
    if (e.baseClass !== 'NonLeaderUnitCard' || !same(e.card.types, ['unit']) || !['ground', 'space'].includes(e.card.arena) || !Number.isInteger(e.card.hp) || e.card.hp < 4 || !Number.isInteger(e.card.power) || e.card.power < 0 || !body(a, ['trigger', 'title', 'costs', 'optional', 'effect', 'ifYouDo']) || a.trigger !== 'whenPlayed' || a.optional !== true || !same(a.effect, { kind: 'useForce', target: 'ownPlayer' }))
        return null;
    const child = a.ifYouDo;
    if (body(child, ['title', 'costs', 'targetResolver', 'effect']) && same(e.keywordValues, {}) && !e.card.keywords.length && same(child.targetResolver, { owner: 'any', type: 'unit', zone: 'anyAttackable', mode: 'upTo', count: c(5), optional: true }) && same(child.effect, { kind: 'giveShield', target: 'chosen', amount: c(1) }))
        return { family: 'force-continuation', mode: 'five-shields-after-use', count: 5 };
    if (!body(child, ['title', 'costs', 'effect']) || !same(e.keywordValues, { restore: 2 }) || !same(e.card.keywords, ['restore']) || !keys(child.effect, ['kind', 'target']) || child.effect.kind !== 'defeat')
        return null;
    const t = child.effect.target, p = t?.predicate, q = p?.right?.left?.right?.value, trait = q?.args?.[0]?.value;
    if (typeof trait !== 'string' || !trait || !Array.isArray(e.card.traits) || !e.card.traits.every(t => typeof t === 'string') || !e.card.traits.includes(trait))
        return null;
    const predicate = { kind: 'binary', op: '&&', left: c(true), right: { kind: 'binary', op: '&&', left: { kind: 'binary', op: '&&', left: { kind: 'query', name: 'isUnit', receiver: r('card'), args: [] }, right: { kind: 'unary', op: '!', value: { kind: 'query', name: 'hasSomeTrait', receiver: r('card'), args: [c(trait)] } } }, right: { kind: 'binary', op: '<=', left: r('card', 'remainingHp'), right: c(3) } } };
    if (!same(t, { kind: 'arenaList', receiver: r('game'), predicate }))
        return null;
    return { family: 'force-continuation', mode: 'wave-after-use', excludedTrait: trait, threshold: 3, restore: 2 };
}
function quietUnit(e) { return e.status === 'supported' && same(e.card?.types, ['unit']) && e.card.unique === false && Number.isInteger(e.card.cost) && e.card.cost >= 0 && e.sourcePath === null && e.sourceHash === null && !e.baseClass && noPilot(e) && e.card.text === '' && same(e.card.keywords, []) && same(e.keywordValues, {}) && same(e.abilities, { leader: [], unit: [], card: [] }) && ['ground', 'space'].includes(e.card.arena) && Number.isInteger(e.card.hp) && e.card.hp > 0 && Number.isInteger(e.card.power) && e.card.power >= 0; }
function gainDonor(e) { const a = e.abilities?.card?.[0]; return e.status === 'supported' && e.baseClass === 'NonLeaderUnitCard' && same(e.card?.types, ['unit']) && provenance(e) && noPilot(e) && !e.card.unique && same(e.card.keywords, []) && same(e.keywordValues, {}) && Object.values(e.abilities).flat().length === 1 && body(a, ['trigger', 'title', 'costs', 'effect']) && a.trigger === 'whenPlayed' && same(a.effect, { kind: 'gainForce', target: 'ownPlayer' }); }
function forceSentinel(e) { const a = e.abilities?.card?.[0]; return e.status === 'supported' && e.baseClass === 'NonLeaderUnitCard' && same(e.card?.types, ['unit']) && provenance(e) && noPilot(e) && same(e.keywordValues, {}) && same(e.card.keywords, ['sentinel']) && Object.values(e.abilities).flat().length === 1 && body(a, ['trigger', 'title', 'costs', 'condition', 'effect']) && a.trigger === 'constant' && same(a.condition, r('player', 'hasTheForce')) && same(a.effect, { kind: 'gainKeyword', target: 'self', duration: 'persistent', keyword: 'sentinel', amount: c(1) }); }
function planForceContinuationProbes(entry, options = {}) {
    const shape = classifyForceContinuation(entry);
    if (!shape)
        return null;
    const defs = Array.isArray(options.catalogue) ? options.catalogue : options.catalogue?.cards ?? [];
    const result = { schema: 'swu-card-probes/v1', cardId: entry.setCode, sourceHash: entry.sourceHash, cases: [], obligations: [], uncovered: [] };
    const obligation = (name, reason) => { const id = entry.setCode + ':force-continuation:' + name; result.obligations.push({ id, path: 'force-continuation', dimension: name }); if (reason)
        result.uncovered.push({ id, path: 'force-continuation', reason }); return id; };
    const force = defs.find(require('./force-probes').nativeForce), shield = defs.find(require('./arena-damage-probes').nativeShield), plain = defs.filter(quietUnit).sort((a, b) => a.setCode.localeCompare(b.setCode));
    const ground = plain.find(e => e.card.arena === 'ground' && e.card.hp >= 5), space = plain.find(e => e.card.arena === 'space' && e.card.hp >= 4), sith = plain.find(e => e.card.traits.includes(shape.excludedTrait ?? 'sith') && e.card.hp >= 3), hp3 = plain.find(e => e.card.arena === 'ground' && e.card.hp === 3), gain = defs.find(gainDonor);
    const use = defs.find(e => provenance(e) && require('./force-probes').classifyForce(e)?.kind === 'ready');
    const hpAura = defs.find(require('./arena-keyword-set-probes').sentinelHpDonor), sentinel = defs.find(forceSentinel);
    const hevy = defs.find(e => { const s = require('./arena-damage-probes').classifyArenaDamage(e); return provenance(e) && s?.trigger === 'whenDefeated' && s.receiver === 'opponent' && s.arena === 'ground' && s.amount === 1 && s.coordinateRaid === 2; });
    const acolyte = defs.find(e => provenance(e) && require('./force-trigger-probes').classifyForceTriggers(e)?.kind === 'dual-gain');
    if (!force || !ground || !space || shape.mode === 'five-shields-after-use' && !shield) {
        obligation('metadata-donors', 'Missing exact reviewed native token or quiet printed recipient');
        return result;
    }
    const row = (e, owner, extra = {}) => ({ code: e.setCode, owner, arena: e.card.arena, exhausted: false, damage: 0, ...extra });
    function add(name, seat, targets, extra = {}) {
        const id = obligation(name + '-seat-' + seat), probe = { ...shape, cardId: entry.setCode, sourceSeat: seat, sourceArena: entry.card.arena, targets, resourceCount: 24, held: shape.mode !== 'inline-damage-gain', enemyHeld: false, selectedIndex: 0, pickCount: 1, ...extra };
        const scenario = 'force-continuation-' + name + '-seat-' + seat;
        result.cases.push({ id: 'auto/' + entry.setCode + '/' + scenario, name: scenario, kind: 'probe', source: { module: '../pipeline/probe-fixture.js', scenario }, focusCardIds: [entry.setCode], setupCardIds: [...new Set([force.setCode, ...targets.map(t => t.code), ...targets.flatMap(t => (t.attachments ?? []).map(a => a.code)), ...(shape.mode === 'five-shields-after-use' ? [shield.setCode] : [])])].sort(), behaviorIds: ['force-native-identity', 'continuation', shape.mode], assertionStages: ['construction', 'normal-play', 'source-effects', 'terminal'], coverageObligationIds: [id], probe });
    }
    for (const seat of [1, 2]) {
        if (shape.mode === 'wave-after-use') {
            if (!sith || !hp3) {
                obligation('trait-threshold-donors', 'No quiet actual excluded-trait or exact threshold donor');
                continue;
            }
            const mixed = [row(hp3, 'self'), row(hp3, 'opponent'), row(ground, 'self', { damage: ground.card.hp - 4 }), row(space, 'opponent', { damage: space.card.hp >= 4 ? space.card.hp - 4 : 0 }), row(sith, 'opponent', { damage: sith.card.hp - 3 })];
            add('mixed-thresholds', seat, mixed);
            add('enemy-only-held', seat, mixed, { held: false, enemyHeld: true });
            add('absent-both', seat, mixed, { held: false });
            add('optional-decline', seat, mixed, { decline: true });
            add('held-empty-wave', seat, [row(ground, 'opponent', { damage: ground.card.hp - 4 })]);
            if (entry.card.unique)
                for (const keepOld of [false, true])
                    add('unique-' + (keepOld ? 'old' : 'new'), seat, [...mixed, row(entry, 'self', { exhausted: true, damage: entry.card.hp - 3 })], { uniqueReplacement: true, oldIndex: mixed.length, keepOld });
            for (const baseDamage of [3, 1, 0])
                add('restore-base-' + baseDamage, seat, [], { held: false, restoreCombat: true, baseDamage });
            if (hevy)
                for (const enemyFirst of [false, true])
                    add('two-real-death-owners-' + (enemyFirst ? 'enemy' : 'self'), seat, [row(hevy, 'self', { damage: hevy.card.hp - 3 }), row(hevy, 'opponent', { damage: hevy.card.hp - 3 }), row(sith, 'opponent', { damage: sith.card.hp - 3 })], { hevyDeaths: true, enemyFirst });
        }
        else if (shape.mode === 'inline-damage-gain') {
            for (const owner of ['self', 'opponent'])
                add('nonlethal-' + owner, seat, [row(ground, owner)]);
            add('already-held', seat, [row(ground, 'opponent')], { held: true });
            add('empty-absent', seat, [], { empty: true });
            add('empty-held', seat, [], { empty: true, held: true });
            add('damage-lethal', seat, [row(ground, 'opponent', { damage: ground.card.hp - 1 })], { lethal: true });
            if (shield)
                for (const count of [1, 2])
                    add('shield-count-' + count, seat, [row(ground, 'opponent', { attachments: Array.from({ length: count }, () => ({ code: shield.setCode, token: 'shield' })) })], { shielded: true });
            if (acolyte)
                for (const owner of ['self', 'opponent'])
                    add('actual-death-force-' + owner, seat, [row(acolyte, owner, { damage: acolyte.card.hp - 1 })], { lethal: true, acolyteDeath: true });
            if (hevy)
                add('actual-death-damage', seat, [row(hevy, 'opponent', { damage: hevy.card.hp - 1 }), row(ground, 'self')], { lethal: true, hevyDeath: true });
        }
        else {
            const five = [row(ground, 'self'), row(space, 'opponent'), row(ground, 'opponent'), row(space, 'self'), row(ground, 'self')];
            add('enemy-only-held', seat, five, { held: false, enemyHeld: true });
            add('optional-decline', seat, five, { decline: true });
            for (const count of [0, 1, 3, 4, 5])
                add('choose-' + count, seat, five, { pickCount: count });
            add('toggle-reselect-five', seat, five, { pickCount: 5, clickIndices: [0, 1, 0, 2, 0, 3, 4] });
            add('entering-source', seat, five, { pickCount: 1, selectSource: true });
            add('existing-shield-additive', seat, [row(ground, 'opponent', { attachments: [{ code: shield.setCode, token: 'shield' }] }), ...five.slice(1)], { pickCount: 1 });
            if (entry.card.unique)
                for (const keepOld of [false, true])
                    add('unique-' + (keepOld ? 'old' : 'new'), seat, [...five, row(entry, 'self', { exhausted: true })], { uniqueReplacement: true, oldIndex: five.length, keepOld, pickCount: 1, selectedIndex: five.length, selectSource: !keepOld });
        }
        if (gain && (shape.mode !== 'inline-damage-gain' || use)) {
            const secondIndex = shape.mode === 'inline-damage-gain' ? 2 : 1;
            const targets = shape.mode === 'inline-damage-gain' ? [row(ground, 'opponent'), row(gain, 'self', { zone: 'hand' }), row(use, 'self', { zone: 'hand' })] : [row(gain, 'self', { zone: 'hand' }), row(gain, 'self', { zone: 'hand' })];
            add('actual-gain-use-regain', seat, targets, { held: false, actualGain: true, gainIndex: shape.mode === 'inline-damage-gain' ? 1 : 0, regainIndex: shape.mode === 'inline-damage-gain' ? undefined : secondIndex, useIndex: shape.mode === 'inline-damage-gain' ? 2 : undefined, pickCount: 0 });
        }
        if (hpAura && sentinel && shape.mode !== 'five-shields-after-use')
            add('cached-sentinel-hp-stage', seat, [row(hpAura, 'self', { zone: 'hand' }), row(sentinel, 'self', { zone: 'hand' }), ...(shape.mode === 'wave-after-use' ? [row(hp3, 'opponent', { damage: 2 })] : [])], { stageBoundary: true, preludeIndices: [0, 1], boundaryRecipientIndex: 1, held: shape.mode === 'wave-after-use', boundaryDamage: shape.mode === 'wave-after-use' ? 4 : 3, selectedIndex: 1 });
    }
    const modeGaps = shape.mode === 'wave-after-use' ? ['actual-beast-token-wave'] :
        shape.mode === 'inline-damage-gain' ? ['repeat-drain-gain', 'nonlethal-sentinel-hp-refresh'] : ['natural-phase-shield-persistence'];
    for (const gap of [...modeGaps, 'source-review', 'true-empty-captured-shield-domain', 'cached-wd-predicate-generalization', 'controller-transfer', 'protection-reentry', 'token-creation-replacement', 'deployed-leader-membership', 'native-capacity-synthetic', 'old-inline-title-branch-coverage'])
        obligation(gap, 'No actual full-source construction for this additional interaction; partial engine stages and native primitives are distinct evidence');
    return result;
}
module.exports = { classifyForceContinuation, planForceContinuationProbes, quietUnit, gainDonor, forceSentinel };
