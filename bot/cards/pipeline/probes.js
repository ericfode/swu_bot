'use strict';
// A deliberately small experiment vocabulary. Unknown IR remains an obligation,
// never silently becomes a purportedly covered card.
function planCardProbes(entry, options = {}) {
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
                ]),
            ].sort(),
            behaviorIds: [
                ability.effect.kind === 'damage'
                    ? 'damage'
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
                effect?.kind === 'damage'
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
                !['damage', 'modifyStats'].includes(effect.kind)
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
