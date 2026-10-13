'use strict';
// A deliberately small experiment vocabulary. Unknown IR remains an obligation,
// never silently becomes a purportedly covered card.
function planCardProbes(entry, options = {}) {
    const arenaTokenPlan = require('./arena-token-probes').planArenaTokenProbes(entry, options);
    if (arenaTokenPlan) return arenaTokenPlan;
    const keywordInventoryPlan = require('./keyword-inventory-probes').planKeywordInventoryProbes(entry, options);
    if (keywordInventoryPlan) return keywordInventoryPlan;
    const parentUpgradePlan = require('./parent-upgrade-probes').planParentUpgradeProbes(entry, options);
    if (parentUpgradePlan) return parentUpgradePlan;
    const forceContinuationPlan = require('./force-continuation-probes').planForceContinuationProbes(entry, options);
    if (forceContinuationPlan) return forceContinuationPlan;
    const weaknessContinuationPlan = require('./weakness-continuation-probes').planWeaknessContinuationProbes(entry, options);
    if (weaknessContinuationPlan) return weaknessContinuationPlan;
    const arenaKeywordSetPlan = require('./arena-keyword-set-probes').planArenaKeywordSetProbes(entry, options);
    if (arenaKeywordSetPlan) return arenaKeywordSetPlan;
    const arenaDamagePlan = require('./arena-damage-probes').planArenaDamageProbes(entry, options);
    if (arenaDamagePlan) return arenaDamagePlan;
    const resourceSelfPlan = require('./resource-self-probes').planResourceSelfProbes(entry, options);
    if (resourceSelfPlan) return resourceSelfPlan;
    const forceTriggerPlan = require('./force-trigger-probes').planForceTriggerProbes(entry, options);
    if (forceTriggerPlan) return forceTriggerPlan;
    const forcePresencePlan = require('./force-presence-probes').planForcePresenceProbes(entry, options);
    if (forcePresencePlan) return forcePresencePlan;
    const forceFollowonPlan = require('./force-followon-probes').planForceFollowonProbes(entry, options);
    if (forceFollowonPlan) return forceFollowonPlan;
    const forcePlan = require('./force-probes').planForceProbes(entry, options);
    if (forcePlan) return forcePlan;
    const arenaStatFilterPlan = require('./arena-stat-filter-probes').planArenaStatFilterProbes(entry, options);
    if (arenaStatFilterPlan) return arenaStatFilterPlan;
    const weaknessUpgradePlan = require('./weakness-upgrade-probes').planWeaknessUpgrade(entry, options);
    if (weaknessUpgradePlan) return weaknessUpgradePlan;
    const weaknessPlan = require('./weakness-probes').planWeaknessProbes(entry, options);
    if (weaknessPlan) return weaknessPlan;
    const namedChooserPlan = require('./named-chooser-probes').planNamedChooserProbes(entry, options);
    if (namedChooserPlan) return namedChooserPlan;
    const namedTargetPlan = require('./named-target-probes').planNamedTargetProbes(entry, options);
    if (namedTargetPlan) return namedTargetPlan;
    const arenaKeywordPlan = require('./arena-keyword-probes').planArenaKeywordProbes(entry, options);
    if (arenaKeywordPlan) return arenaKeywordPlan;
    const hiddenPlan = require('./hidden-probes').planHiddenProbes(entry, options);
    if (hiddenPlan) return hiddenPlan;
    const hiddenKeywordPlan = require('./hidden-keyword-probes').planHiddenKeywordProbes(entry, options);
    if (hiddenKeywordPlan) return hiddenKeywordPlan;
    const defensePlan = require('./on-defense-probes').planOnDefenseProbes(entry, options);
    if (defensePlan) return defensePlan;
    const upgradeReturnPlan = require('./upgrade-return-probes').planUpgradeReturnProbes(entry, options);
    if (upgradeReturnPlan) return upgradeReturnPlan;
    const costPlan = require('./cost-probes').planCostProbes(entry, options);
    if (costPlan) return costPlan;
    const cardId = entry.setCode;
    const result = {
        schema: 'swu-card-probes/v1',
        cardId,
        sourceHash: entry.sourceHash,
        cases: [],
        obligations: [],
        uncovered: [],
    };
    const obligation = (path, dimension, reason) => {
        const id = `${cardId}:${path}:${dimension}`;
        result.obligations.push({ id, path, dimension });
        if (reason) result.uncovered.push({ id, path, reason });
        return id;
    };
    obligation(
        'source',
        'source-semantics',
        'IR-path probes cannot establish correctness or completeness of source lowering',
    );
    for (const keyword of Object.keys(entry.keywordValues ?? {}).sort())
        obligation(
            'keywordValues.' + keyword,
            'intrinsic-keyword',
            'No automatic intrinsic keyword lifecycle or combat experiment',
        );
    if (!Object.values(entry.abilities ?? {}).flat().length)
        obligation('abilities', 'vanilla-lifecycle', 'No automatic metadata-only play/combat/leave-play experiment');
    if (entry.status !== 'supported') {
        obligation('source', 'complete-conversion', 'Compiler rejected full card');
        return result;
    }
    const catalogue = Array.isArray(options.catalogue) ? options.catalogue : options.catalogue?.cards ?? [];
    const definitions = catalogue.length ? catalogue : [entry];
    // Metadata, not a particular printed card ID, selects quiet construction cards.
    const units = definitions
        .filter(
            (e) =>
                e.status === 'supported' &&
                e.card?.types?.includes('unit') &&
                !e.card.types.includes('leader') &&
                !e.card.text &&
                !e.card.keywords?.length &&
                !e.card.unique,
        )
        .sort((a, b) => a.setCode.localeCompare(b.setCode));
    const unit = (arena) => units.find((e) => e.card.arena === arena && e.card.hp >= 4);
    function add(ability, path, variant, spec, ids) {
        const name = `${path.replace(/[^a-z0-9]+/gi, '-')}-${variant}`;
        result.cases.push({
            id: `auto/${cardId}/${name}`,
            name,
            kind: 'probe',
            focusCardIds: [cardId],
            setupCardIds: [
                ...new Set([
                    ...(spec.targets?.map((t) => t.code) ?? []),
                    ...(spec.activationCode ? [spec.activationCode] : []),
                    ...(spec.targets?.flatMap(t => (t.attachments ?? []).map(a => a.code)) ?? []),
                    ...(spec.leaderCode ? [spec.leaderCode] : []),
                ]),
            ].sort(),
            behaviorIds: [
                ['damage', 'defeat'].includes(ability.effect.kind)
                    ? ability.effect.kind
                    : ability.effect.duration === 'phase'
                    ? 'phase-stats'
                    : 'live-stats',
            ],
            assertionStages: ['construction', 'activation', 'observation'],
            coverageObligationIds: ids,
            probe: {
                cardId,
                internalName: entry.internalName,
                sourceTypes: entry.card.types,
                sourceArena: entry.card.arena ?? null,
                abilityPath: path,
                trigger: ability.trigger,
                effectKind: ability.effect.kind,
                duration: ability.effect.duration ?? null,
                ...spec,
            },
        });
    }
    for (const side of ['card', 'leader', 'unit'])
        for (const [i, ability] of (entry.abilities?.[side] ?? []).entries()) {
            const path = `abilities.${side}.${i}`;
            const effect = ability.effect;
            const effectKeys =
                effect?.kind === 'defeat' ? ['kind', 'target'] : effect?.kind === 'damage'
                    ? ['kind', 'target', 'amount']
                    : ['kind', 'target', 'duration', 'power', 'hp'];
            const extraEffectKeys = Object.keys(effect ?? {}).filter((k) => !effectKeys.includes(k));
            const unsupported = Object.keys(ability).filter(
                (k) => !['trigger', 'title', 'costs', 'effect', 'targetResolver'].includes(k),
            );
            if (
                unsupported.length ||
                extraEffectKeys.length ||
                ability.costs?.length ||
                !effect ||
                !['damage', 'defeat', 'modifyStats'].includes(effect.kind)
            ) {
                obligation(
                    path,
                    'execution',
                    `Unsupported probe construction: ${
                        [...unsupported, ...extraEffectKeys].join(',') || effect?.kind || 'missing effect'
                    }${ability.costs?.length ? '; ability costs' : ''}`,
                );
                continue;
            }
            if (
                ability.trigger === 'constant' &&
                effect.kind === 'modifyStats' &&
                effect.target === 'self' &&
                side === 'card' &&
                entry.card.types.includes('unit')
            ) {
                const supportedExpr = (e) =>
                    e &&
                    ((e.kind === 'const' &&
                        Object.keys(e).every((k) => ['kind', 'value'].includes(k)) &&
                        Number.isSafeInteger(e.value) &&
                        Math.abs(e.value) <= 65535) ||
                        (e.kind === 'ref' &&
                            Object.keys(e).every((k) => ['kind', 'path'].includes(k)) &&
                            JSON.stringify(e.path) === '["modifierTarget","damage"]') ||
                        (e.kind === 'unary' &&
                            Object.keys(e).every((k) => ['kind', 'op', 'value'].includes(k)) &&
                            e.op === '-' &&
                            supportedExpr(e.value)));
                if (
                    !supportedExpr(effect.power) ||
                    !supportedExpr(effect.hp) ||
                    effect.hp.kind !== 'const' ||
                    effect.hp.value !== 0
                ) {
                    obligation(
                        path + '.effect',
                        'live-expression',
                        'Only power expressions using constants/modifierTarget.damage and unchanged constant0 HP constructible',
                    );
                    continue;
                }
                for (const damage of [0, 1, Math.max(1, entry.card.hp - 1)])
                    add(
                        ability,
                        path,
                        `damage-${damage}`,
                        { sourceInPlay: true, sourceDamage: damage, targets: [], observeOnly: true },
                        [obligation(path + '.effect', 'initial-damage-' + damage)],
                    );
                const damageEvent = definitions.find(
                    (e) =>
                        e.status === 'supported' &&
                        e.card.types.includes('event') &&
                        e.abilities.card.length === 1 &&
                        Object.values(e.abilities).flat().length === 1 &&
                        e.abilities.card[0].trigger === 'event' &&
                        !e.abilities.card[0].costs.length &&
                        Object.keys(e.abilities.card[0]).every((k) =>
                            ['trigger', 'title', 'costs', 'targetResolver', 'effect'].includes(k),
                        ) &&
                        e.abilities.card[0].effect.kind === 'damage' &&
                        e.abilities.card[0].effect.target === 'chosen' &&
                        e.abilities.card[0].effect.amount?.kind === 'const' &&
                        e.abilities.card[0].effect.amount.value > 0 &&
                        e.abilities.card[0].effect.amount.value < entry.card.hp &&
                        ['any', 'self'].includes(e.abilities.card[0].targetResolver?.owner) &&
                        ['any', 'unit'].includes(e.abilities.card[0].targetResolver?.type) &&
                        ['anyAttackable', 'anyArena', entry.card.arena + 'Arena'].includes(
                            e.abilities.card[0].targetResolver?.zone,
                        ) &&
                        Object.keys(e.abilities.card[0].targetResolver).every((k) =>
                            ['owner', 'type', 'zone'].includes(k),
                        ),
                );
                if (damageEvent && JSON.stringify(effect.power).includes('modifierTarget'))
                    add(
                        ability,
                        path,
                        'live-damage-mutation',
                        {
                            sourceInPlay: true,
                            sourceDamage: 0,
                            targets: [],
                            activationCode: damageEvent.setCode,
                            mutateSource: true,
                        },
                        [obligation(path + '.effect', 'live-mutation')],
                    );
                else
                    obligation(
                        path + '.effect',
                        'live-mutation',
                        'No simple targeted damage event in supplied catalogue',
                    );
                obligation(
                    path + '.effect',
                    'healing-refresh',
                    'No automatic healing action verifies power refresh after damage decreases',
                );
                obligation(
                    path + '.effect',
                    'additive-modifiers',
                    'No automatic combination with Grit, phase effects or upgrades yet',
                );
                obligation(
                    path + '.effect',
                    'lethal-boundary',
                    'No automatic constant-source lethal mutation probe yet',
                );
                obligation(
                    path + '.effect',
                    'lifecycle',
                    'No automatic control-change, leave/reenter or blanking experiment',
                );
                obligation(
                    path + '.effect',
                    'aura-death-timing',
                    'No automatic simultaneous lethal set or stat-dependency cycle experiment',
                );
                continue;
            }
            if (effect.kind === 'defeat' && effect.target?.kind === 'arenaList') {
                const target = effect.target;
                const receiver = target.receiver?.kind === 'ref' && target.receiver.path?.length === 1 ? target.receiver.path[0] : null;
                const zonePredicate = (zone) => ({kind:'binary',op:'&&',left:{kind:'const',value:true},right:{kind:'binary',op:'||',left:{kind:'unary',op:'!',value:{kind:'const',value:zone}},right:{kind:'binary',op:'||',left:{kind:'binary',op:'===',left:{kind:'const',value:zone},right:{kind:'const',value:'anyArena'}},right:{kind:'binary',op:'===',left:{kind:'ref',path:['card','zoneName']},right:{kind:'const',value:zone}}}}});
                const predicate = JSON.stringify(target.predicate);
                const notUpgraded = predicate === JSON.stringify({kind:'binary',op:'&&',left:{kind:'const',value:true},right:{kind:'binary',op:'&&',left:{kind:'query',name:'isUnit',receiver:{kind:'ref',path:['card']},args:[]},right:{kind:'unary',op:'!',value:{kind:'query',name:'isUpgraded',receiver:{kind:'ref',path:['card']},args:[]}}}});
                const arena = notUpgraded || predicate === JSON.stringify({kind:'const',value:true}) ? 'any'
                    : ['ground', 'space'].find(a => predicate === JSON.stringify(zonePredicate(a + 'Arena')));
                if (side !== 'card' || ability.trigger !== 'event' || ability.targetResolver || !['game','player','opponent'].includes(receiver) || !arena ||
                    Object.keys(target).some(k => !['kind','receiver','predicate'].includes(k)) || Object.keys(target.receiver).some(k => !['kind','path'].includes(k))) {
                    obligation(path,'execution','Only event arena-list defeat with owner/arena filters constructible');
                    continue;
                }
                const ground = unit('ground'), space = unit('space');
                if (!ground || !space) { obligation(path,'construction','Missing quiet arena units'); continue; }
                const selected = t => (receiver === 'game' || t.owner === (receiver === 'player' ? 'self' : 'opponent')) && (arena === 'any' || t.arena === arena) && (!notUpgraded || !t.attachments?.length);
                const specification = targets => ({targets,autoTargets:true,selectedTargetIndices:targets.map((t,i) => selected(t)?i:null).filter(i => i!==null),expectDefeated:true});
                // Interleave controllers within each arena, then reverse full entry order.
                const mixed = [ground,space].flatMap(e => ['opponent','self'].map(owner => ({code:e.setCode,owner,arena:e.card.arena,damage:1})));
                for (const [name,targets] of [['interleaved',mixed],['reversed',mixed.toReversed()]])
                    add(ability,path,name,specification(targets),[obligation(path+'.effect',name+'-global-entry-order')]);
                add(ability,path,'empty-set',specification([]),[obligation(path+'.effect','empty-set')]);
                const chosenUnit = arena === 'space' ? space : ground;
                const selectedOwner = receiver === 'opponent' ? 'opponent' : 'self';
                add(ability,path,'duplicate-units',specification([0,1].map(() => ({code:chosenUnit.setCode,owner:selectedOwner,arena:chosenUnit.card.arena,damage:1}))),[obligation(path+'.effect','duplicate-definition-defeats')]);
                const donors = definitions.filter(e => e.status === 'supported' && e.card.types.includes('unit') && !e.card.types.includes('leader') && !e.card.unique &&
                    Object.values(e.abilities ?? {}).flat().length === 1 && e.abilities.card?.[0]?.trigger === 'whenDefeated' &&
                    !e.abilities.card[0].costs?.length && Object.keys(e.abilities.card[0]).every(k => ['trigger','title','costs','effect','optional'].includes(k)) &&
                    JSON.stringify(e.abilities.card[0].effect) === JSON.stringify({kind:'draw',target:'ownPlayer',amount:{kind:'const',value:1}})).sort((a,b)=>a.setCode.localeCompare(b.setCode));
                const donor = donors.find(e => arena === 'any' || e.card.arena === arena);
                if (donor) {
                    const targets = ['self','opponent'].flatMap(owner => [0,1].map(() => ({code:donor.setCode,owner,arena:donor.card.arena,damage:0})));
                    const spec = specification(targets); spec.resolveDeathDraws = true; spec.expectDraws = ['self','opponent'].map(owner => targets.filter(t => t.owner===owner && selected(t)).length);
                    add(ability,path,'death-trigger-window',spec,[obligation(path+'.effect','both-side-death-trigger-window')]);
                } else obligation(path+'.effect','both-side-death-trigger-window','No mandatory simple draw-on-death donor in eligible arena');
                const upgrades = definitions.filter(e => e.status === 'supported' && e.card.types.includes('upgrade') && !e.card.types.includes('token') && !e.card.unique &&
                    !e.card.keywords?.length && Object.values(e.abilities ?? {}).flat().length === 0).sort((a,b)=>a.setCode.localeCompare(b.setCode));
                const tokenUpgrades = ['shield','experience'].map(name => definitions.find(e => e.card.types.includes('token') && e.card.types.includes('upgrade') && e.internalName===name));
                // Construction eligibility evaluates only a bounded metadata predicate vocabulary.
                // The oracle attachTo assertion independently checks the chosen real card.
                const attachEligible = (expr, card) => {
                    if (!expr) return true;
                    if (expr.kind==='const') return expr.value;
                    if (expr.kind==='unary' && expr.op==='!') { const v=attachEligible(expr.value,card); return v===null?null:!v; }
                    if (expr.kind==='binary') {
                        const left=attachEligible(expr.left,card),right=attachEligible(expr.right,card);
                        if (left===null || right===null) return null;
                        if (expr.op==='&&') return left&&right;
                        if (expr.op==='<=') return left<=right;
                    }
                    if (expr.kind==='query' && JSON.stringify(expr.receiver)==='{"kind":"ref","path":["card"]}') {
                        if (expr.name==='isUnit' && !expr.args.length) return card.types.includes('unit');
                        if (expr.name==='getPower' && !expr.args.length) return card.power;
                        if (expr.name==='hasSomeTrait' && expr.args.length===1 && expr.args[0].kind==='const') return card.traits.includes(expr.args[0].value);
                    }
                    return null;
                };
                let attachmentHost, ordinaryUpgrade;
                for (const upgrade of upgrades) {
                    attachmentHost=definitions.filter(e=>e.status==='supported' && e.card.types.includes('unit') && !e.card.types.includes('leader') && !e.card.unique &&
                        e.card.arena===chosenUnit.card.arena && Object.values(e.abilities ?? {}).flat().length===0 && attachEligible(upgrade.attachCondition,e.card)===true).sort((a,b)=>a.setCode.localeCompare(b.setCode))[0];
                    if (attachmentHost) { ordinaryUpgrade=upgrade; break; }
                }
                if (ordinaryUpgrade && tokenUpgrades.every(Boolean)) {
                    const attachments = [ordinaryUpgrade,tokenUpgrades[0],tokenUpgrades[1]].map(e => ({code:e.setCode,token:e.card.types.includes('token')?e.internalName:null}));
                    const targets = ['self','opponent'].map(owner => ({code:attachmentHost.setCode,owner,arena:attachmentHost.card.arena,damage:0,attachments}));
                    const attachmentTargets = notUpgraded ? targets.flatMap(t => [t,{code:t.code,owner:t.owner,arena:t.arena,damage:0}]) : targets;
                    for (const [name,ordered] of [['attachments',attachmentTargets],['attachments-reversed',attachmentTargets.toReversed()]])
                        add(ability,path,name,specification(ordered),[obligation(path+'.effect',name+(notUpgraded ? '-upgrade-eligibility' : '-combined-cleanup-order'))]);
                } else obligation(path+'.effect','attachment-cleanup','Missing quiet ordinary upgrade or Shield/Experience metadata');
                if (notUpgraded) obligation(path+'.effect','attachment-cleanup','Upgraded hosts are excluded by predicate; ordinary upgrade contingent cleanup is not exercised');
                const tokens = definitions.filter(e => e.status==='supported' && e.card.types.includes('token') && e.card.types.includes('unit') &&
                    Object.values(e.abilities ?? {}).flat().length === 0 && !e.card.keywords?.length).sort((a,b)=>a.setCode.localeCompare(b.setCode));
                const token = tokens.find(e => arena === 'any' || e.card.arena===arena);
                if (token) add(ability,path,'token-lifecycle',specification(['self','opponent'].map(owner => ({code:token.setCode,token:token.internalName,owner,arena:token.card.arena,damage:0}))),[obligation(path+'.effect','token-removal')]);
                else obligation(path+'.effect','token-removal','No quiet eligible token unit metadata');
                const leader = definitions.filter(e=>e.status==='supported' && e.card.types.includes('leader') && (arena==='any'||e.card.arena===arena) &&
                    Object.values(e.abilities ?? {}).flat().every(a=>['action','onAttack'].includes(a.trigger))).sort((a,b)=>a.setCode.localeCompare(b.setCode))[0];
                if (leader) add(ability,path,'deployed-leader',{...specification(['self','opponent'].map(owner=>({code:leader.setCode,owner,arena:leader.card.arena,deployedLeader:true,damage:0}))),leaderCode:leader.setCode},[obligation(path+'.effect','deployed-leader-undeployment')]);
                else obligation(path+'.effect','deployed-leader','No eligible leader without automatic enter/leave-play triggers');
                for (const dimension of ['aura-death-timing','sequential-sweep-sensitivity','cancel-before-payment','capacity-boundary'])
                    obligation(path+'.effect',dimension,'No automatic '+dimension+' defeat construction yet');
                continue;
            }
            if (effect.kind === 'modifyStats' && effect.target?.kind === 'arenaList') {
                const constant = (e) => e?.kind === 'const' && Object.keys(e).every(k => ['kind','value'].includes(k)) && Number.isSafeInteger(e.value) ? e.value
                    : e?.kind === 'unary' && Object.keys(e).every(k => ['kind','op','value'].includes(k)) && ['+', '-'].includes(e.op) && e.value?.kind === 'const' && Object.keys(e.value).every(k => ['kind','value'].includes(k)) && Number.isSafeInteger(e.value.value)
                    ? (e.op === '-' ? -1 : 1) * e.value.value : null;
                const power = constant(effect.power), hp = constant(effect.hp), target = effect.target;
                const receiver = target.receiver?.kind === 'ref' && target.receiver.path?.length === 1 ? target.receiver.path[0] : null;
                const zonePredicate = (zone) => ({kind:'binary',op:'&&',left:{kind:'const',value:true},right:{kind:'binary',op:'||',left:{kind:'unary',op:'!',value:{kind:'const',value:zone}},right:{kind:'binary',op:'||',left:{kind:'binary',op:'===',left:{kind:'const',value:zone},right:{kind:'const',value:'anyArena'}},right:{kind:'binary',op:'===',left:{kind:'ref',path:['card','zoneName']},right:{kind:'const',value:zone}}}}});
                const predicate = JSON.stringify(target.predicate);
                const arena = predicate === JSON.stringify({kind:'const',value:true}) ? 'any'
                    : ['ground', 'space'].find((a) => predicate === JSON.stringify(zonePredicate(a + 'Arena')));
                if (side !== 'card' || ability.trigger !== 'event' || ability.targetResolver || effect.duration !== 'phase' ||
                    !['player', 'opponent'].includes(receiver) || !arena || power === null || hp === null || Math.abs(power) > 65535 || Math.abs(hp) > 65535 ||
                    Object.keys(target).some((k) => !['kind','receiver','predicate'].includes(k)) || Object.keys(target.receiver).some((k) => !['kind','path'].includes(k))) {
                    obligation(path, 'execution', 'Only event arena-list phase stats with signed constants and owner/arena filters constructible');
                    continue;
                }
                const ground = unit('ground'), space = unit('space');
                if (!ground || !space) { obligation(path, 'construction', 'Missing quiet ground/space units'); continue; }
                const targets = ['self','opponent'].flatMap((owner) => [ground,space].map((e) => ({code:e.setCode,owner,arena:e.card.arena,damage:1})));
                const selected = (t) => t.owner === (receiver === 'player' ? 'self' : 'opponent') && (arena === 'any' || t.arena === arena);
                const spec = { targets, autoTargets:true, selectedTargetIndices:targets.map((t,i) => selected(t) ? i : null).filter((i) => i !== null) };
                add(ability,path,'mixed-membership',spec,[obligation(path+'.effect','mixed-owner-arena-membership')]);
                add(ability,path,'expiry',{...spec,waitForExpiry:true},[obligation(path+'.effect.duration','phase-expiry')]);
                add(ability,path,'empty-set',{targets:[],autoTargets:true,selectedTargetIndices:[],allowNoChange:true},[obligation(path+'.effect','empty-set')]);
                if (hp < 0 && -hp < ground.card.hp && arena !== 'space') {
                    const owner = receiver === 'opponent' ? 'opponent' : 'self';
                    const lethal = [0,1].map(() => ({code:ground.setCode,owner,arena:'ground',damage:ground.card.hp+hp}));
                    add(ability,path,'simultaneous-lethal',{targets:lethal,autoTargets:true,selectedTargetIndices:[0,1]},[obligation(path+'.effect','simultaneous-lethal-set')]);
                } else if (hp > 0) obligation(path+'.effect','expiry-lethal-set','No damage-during-buff followed by lethal expiry construction');
                for (const dimension of ['aura-death-timing','lethal-attachment-cleanup','shield-independence','deployed-leader','leave-and-reenter','stacking','cancel-before-payment','sequential-sweep-sensitivity'])
                    obligation(path+'.effect',dimension,'No automatic '+dimension+' construction for arena-list phase stats');
                continue;
            }
            const resolver = ability.targetResolver;
            const exprs = effect.kind === 'damage' ? [effect.amount] : [effect.power, effect.hp];
            if (
                side !== 'card' ||
                ability.trigger !== 'event' ||
                effect.target !== 'chosen' ||
                exprs.some(
                    (e) =>
                        e?.kind !== 'const' ||
                        !Number.isSafeInteger(e.value) ||
                        Math.abs(e.value) > 65535 ||
                        (effect.kind === 'damage' && e.value < 0) ||
                        Object.keys(e).some((k) => !['kind', 'value'].includes(k)),
                ) ||
                !resolver ||
                Object.keys(resolver).some((k) => !['owner', 'type', 'zone'].includes(k)) ||
                !['self', 'opponent', 'any'].includes(resolver.owner) ||
                !['unit', 'any', 'base'].includes(resolver.type) ||
                !['groundArena', 'spaceArena', 'anyArena', 'anyAttackable', 'base'].includes(resolver.zone)
            ) {
                obligation(
                    path,
                    'execution',
                    'Only event scalar-target const damage or phase stats and declarative owner/type/zone are constructible',
                );
                continue;
            }
            if (effect.kind === 'modifyStats' && effect.duration !== 'phase') {
                obligation(path + '.effect', 'duration', 'Non-phase event stat duration not constructible');
                continue;
            }
            obligation(path, 'cancel-before-payment', 'No automatic cancellation and unpaid-cost witness yet');
            if (effect.duration === 'phase') {
                obligation(
                    path + '.effect',
                    'stacking',
                    'No automatic repeated application and additive modifier witness yet',
                );
                obligation(
                    path + '.effect',
                    'leave-and-reenter',
                    'No automatic target departure and reentry lifetime witness yet',
                );
            }
            if (effect.kind === 'damage' && ['base', 'any'].includes(resolver.type))
                obligation(
                    path + '.effect',
                    'base-victory-boundary',
                    'No automatic exact-lethal base and terminal-resolution witness yet',
                );
            const owners = resolver.owner === 'any' ? ['self', 'opponent'] : [resolver.owner];
            const arenas =
                resolver.zone === 'base'
                    ? []
                    : resolver.zone === 'groundArena'
                    ? ['ground']
                    : resolver.zone === 'spaceArena'
                    ? ['space']
                    : ['ground', 'space'];
            if (resolver.type !== 'base')
                for (const owner of owners)
                    for (const arena of arenas) {
                        const target = unit(arena);
                        if (!target) {
                            obligation(
                                path + '.targetResolver',
                                `${owner}-${arena}`,
                                'No quiet unit metadata in supplied catalogue',
                            );
                            continue;
                        }
                        const positive = obligation(path + '.effect', `${owner}-${arena}-positive`);
                        const ownership = obligation(path + '.targetResolver', `${owner}-${arena}-candidate-validity`);
                        add(
                            ability,
                            path,
                            `${owner}-${arena}`,
                            { targets: [{ code: target.setCode, owner, arena, damage: 0 }], chosenTarget: 0 },
                            [positive, ownership],
                        );
                        add(
                            ability,
                            path,
                            `${owner}-${arena}-damaged`,
                            { targets: [{ code: target.setCode, owner, arena, damage: 1 }], chosenTarget: 0 },
                            [obligation(path + '.effect', `${owner}-${arena}-damaged`)],
                        );
                        if (
                            effect.kind === 'damage' &&
                            Number.isSafeInteger(effect.amount.value) &&
                            effect.amount.value > 0 &&
                            effect.amount.value < target.card.hp
                        )
                            add(
                                ability,
                                path,
                                `${owner}-${arena}-lethal`,
                                {
                                    targets: [
                                        {
                                            code: target.setCode,
                                            owner,
                                            arena,
                                            damage: target.card.hp - effect.amount.value,
                                        },
                                    ],
                                    chosenTarget: 0,
                                },
                                [obligation(path + '.effect', `${owner}-${arena}-lethal-boundary`)],
                            );
                        if (effect.duration === 'phase')
                            add(
                                ability,
                                path,
                                `${owner}-${arena}-expiry`,
                                {
                                    targets: [{ code: target.setCode, owner, arena, damage: 1 }],
                                    chosenTarget: 0,
                                    waitForExpiry: true,
                                },
                                [obligation(path + '.effect.duration', `${owner}-${arena}-expiry`)],
                            );
                    }
            if (resolver.type === 'any' || resolver.type === 'base')
                for (const owner of owners)
                    add(ability, path, `${owner}-base`, { targets: [], chosenBase: owner }, [
                        obligation(path + '.targetResolver', `${owner}-base-positive`),
                    ]);
            const quiet = unit('ground') ?? unit('space');
            if (quiet)
                add(
                    ability,
                    path,
                    'invalid-hand-target',
                    {
                        targets: [
                            { code: quiet.setCode, owner: 'self', arena: quiet.card.arena, zone: 'hand', damage: 0 },
                        ],
                        negativeOnly: true,
                    },
                    [obligation(path + '.targetResolver', 'hand-target-invalid')],
                );
            if (resolver.type === 'unit')
                add(ability, path, 'no-unit-target', { targets: [], negativeOnly: true, inspectBaseInvalid: true }, [
                    obligation(path + '.targetResolver', 'no-unit-target'),
                ]);
            if (resolver.owner !== 'any' && quiet)
                add(
                    ability,
                    path,
                    'wrong-owner',
                    {
                        targets: [
                            {
                                code: quiet.setCode,
                                owner: resolver.owner === 'self' ? 'opponent' : 'self',
                                arena: quiet.card.arena,
                                damage: 0,
                            },
                        ],
                        negativeOnly: true,
                    },
                    [obligation(path + '.targetResolver', 'wrong-owner-invalid')],
                );
            if (['groundArena', 'spaceArena'].includes(resolver.zone)) {
                const wrong = unit(resolver.zone === 'groundArena' ? 'space' : 'ground');
                if (wrong)
                    add(
                        ability,
                        path,
                        'wrong-arena',
                        {
                            targets: [{ code: wrong.setCode, owner: owners[0], arena: wrong.card.arena, damage: 0 }],
                            negativeOnly: true,
                        },
                        [obligation(path + '.targetResolver', 'wrong-arena-invalid')],
                    );
            }
            obligation(
                path + '.targetResolver',
                'deployed-leader',
                'Automatic target metadata selection excludes deployed leaders',
            );
            obligation(path + '.effect', 'shield-replacement', 'No automatic Shield replacement construction yet');
            obligation(path + '.effect', 'lethal-attachment-cleanup', 'No automatic attached upgrade construction yet');
            obligation(path + '.effect', 'aura-death-timing', 'No automatic simultaneous death/aura construction yet');
        }
    // Multiple abilities can change the experiment; do not pretend to isolate one.
    const total = Object.values(entry.abilities ?? {}).flat().length;
    if (total !== 1 && result.cases.length) {
        result.cases = [];
        obligation(
            'abilities',
            'isolation',
            'Only full cards with one ability have an automatic construction contract',
        );
    }
    return result;
}
module.exports = { planCardProbes };
