'use strict';
const assert = require('node:assert/strict');
const { constructProbeFixture } = require('./probe-fixture');
const { fullState, expandActions, canonicalAction } = require('../../omni/rs/state');
function view(eg, card) {
    return { id: eg.cardId(card.uuid), zone: card.zoneName, owner: eg.seatOf(card.owner.id), controller: eg.seatOf(card.controller.id),
        ...(card.isUnit?.() && card.isInPlay?.() ? { hp: card.getHp(), power: card.getPower(), damage: card.damage, exhausted: card.exhausted,
            keywords: card.keywords.map(k => ({ name: k.name, value: k.value ?? null })), upgrades: card.upgrades.map(u => eg.cardId(u.uuid)) } : {}) };
}
function assertGainUseCheckpoint(host, card, extras, force) {
    const role = card === extras[1] || card === extras[3] ? 'gain' : card === extras[2] ? 'use' : null;
    if (role === 'gain') {
        assert.deepEqual(host.keywords.map(k => k.name).sort(), ['restore', 'sentinel']);
        assert.equal(host.getHp(), host.cardData.hp + 3);
        assert.equal(force.held, true);
    } else if (role === 'use') {
        assert.deepEqual(host.keywords.map(k => k.name).sort(), ['restore']);
        assert.equal(host.getHp(), host.cardData.hp + 1);
        assert.equal(force.held, false);
        assert.equal(card.exhausted, false);
    }
    return role;
}
async function fixture(env, pool, scenario, seed) {
    const p = scenario.probe;
    assert.equal(p.family, 'keyword-inventory');
    const reverse = p.sourceSeat === 2, relative = owner => reverse ? (owner === 'self' ? 'opponent' : 'self') : owner;
    const setup = await constructProbeFixture(env, pool, { ...scenario, probe: { ...p, initiative: reverse ? 'opponent' : 'self',
            targets: [...p.targets.map(t => ({ ...t, owner: relative(t.owner) })), ...(reverse ? [{ code: p.cardId, owner: 'opponent', zone: 'hand' }] : [])] } }, seed);
    const { eg, rng, bot, deck } = setup, targets = setup.targets.slice(), own = reverse ? setup.enemy : setup.own;
    const source = reverse ? targets.pop() : setup.source, before = targets.map(c => view(eg, c)), initial = fullState(eg);
    const host = p.macro ? (p.upgradeSource ? source : targets[p.hostIndex]) : null, extras = p.macro ? targets.slice(1) : [];
    const sequence = !p.macro ? [source] : p.oldIndex != null ? [targets[p.oldIndex], source] : p.hostLast ? [source, host] : p.hostFirst ? [host, source, ...extras] : p.gainFirst ? [extras[0], source, ...extras.slice(1)] : [source, ...extras];
    const initialRound = eg.round, forceId = fullState(eg).players[eg.seatOf(own.id)].forceToken.id;
    let index = 0, originalShield = null, uniqueChosen = false;
    const names = card => card.keywords.map(k => k.name).sort();
    const force = () => fullState(eg).players[eg.seatOf(own.id)].forceToken;
    const witness = { coverageObligationIds: [], observations: [], events: [] };
    const records = [{ type: 'meta', schema: 'omni-rs-trace-v1', pool: pool.provenance, seed, bots: ['keyword-inventory-probe', 'keyword-inventory-probe'],
            decks: [deck, deck], scenario: scenario.name, constructionParameters: p,
            fixtureConstruction: 'Disclosed actual printed recipients; source normally played from hand with normal optional selection. Full terminal continuation recorded; no fabricated keywords or card bodies.' }];
    let started = false, played = false, settled = false, selected = false, declined = false, step = 0, readyBefore;
    const ready = (player = own) => player.getCardsInZone('resource').filter(c => !c.exhausted).length;
    const cost = card => {
        const aspects = [...card.owner.getAspectsForCosts()];
        let n = card.cardData.cost;
        for (const a of card.cardData.aspects) {
            const i = aspects.indexOf(a);
            if (i < 0)
                n += 2;
            else
                aspects.splice(i, 1);
        }
        return n;
    };
    eg.game.on('onCardPlayed', event => { if (started && !settled && event.card === sequence[index] && !event.isCancelledOrReplaced)
        played = true; });
    eg.game.on('onCardExhausted', event => {
        if (started && !settled && !event.isCancelledOrReplaced)
            witness.events.push({ name: 'onCardExhausted', id: eg.cardId(event.card.uuid), mode: eg.game.currentEventWindow?.triggerHandlingMode });
    });
    for (const name of ['onTokensCreated', 'onForceUsed', 'onCardDefeated', 'onCardDamaged', 'onUpgradeAttached']) {
        eg.game.on(name, event => {
            if (!started || settled || event.isCancelledOrReplaced)
                return;
            witness.events.push({ name, index, id: event.card?.uuid ? eg.cardId(event.card.uuid) : null,
                host: host ? view(eg, host) : null, force: force(), mode: eg.game.currentEventWindow?.triggerHandlingMode,
                tokenIds: (event.generatedTokens ?? []).map(c => eg.cardId(c.uuid)) });
        });
    }
    function assertMacroStage(card) {
        assert.equal(ready(card.owner), readyBefore - cost(card), 'Exact normal macro card payment');
        assert.equal(force().id, forceId, 'Pre-created Force incarnation unchanged');
        const mode = p.macro;
        if (mode.startsWith('source-departure')) {
            if (index === sequence.length - 1) {
                assert.equal(source.zoneName, 'discard');
                if (p.lethal)
                    assert.equal(host.zoneName, 'discard');
                else {
                    assert.ok(host.isInPlay());
                    assert.equal(host.getHp(), host.cardData.hp);
                    assert.equal(host.getPower(), host.cardData.power);
                }
                const sourceDeath = witness.events.findIndex(e => e.name === 'onCardDefeated' && e.id === eg.cardId(source.uuid));
                assert.ok(sourceDeath >= 0);
                if (p.lethal)
                    assert.ok(witness.events.findIndex(e => e.name === 'onCardDefeated' && e.id === eg.cardId(host.uuid)) > sourceDeath);
            }
            else {
                assert.ok(host.isInPlay());
                assert.equal(host.getHp(), host.cardData.hp + 2);
                if (p.lethal && index === 1)
                    assert.equal(host.damage, host.cardData.hp + 1);
            }
        }
        else if (mode === 'unique-source') {
            assert.equal(targets[p.hostIndex].getHp(), before[p.hostIndex].hp + 2);
            assert.equal(targets[p.hostIndex].getPower(), before[p.hostIndex].power + 2);
            if (index === 1) {
                assert.ok(uniqueChosen);
                assert.equal(source.zoneName, p.keep === 'old' ? 'discard' : source.cardData.arena + 'Arena');
                assert.equal(targets[p.oldIndex].zoneName, p.keep === 'old' ? source.cardData.arena + 'Arena' : 'discard');
            }
        }
        else if (mode === 'source-two-keywords') {
            const upgrades = index;
            assert.equal(source.getHp(), source.cardData.hp + upgrades);
            assert.equal(source.getPower(), source.cardData.power + upgrades);
            assert.equal(targets[0].getHp(), before[0].hp + 2);
            assert.equal(targets[0].getPower(), before[0].power + 2);
            if (index === 2)
                assert.deepEqual(names(source), ['restore', 'saboteur']);
        }
        else if (mode === 'later-entrant') {
            if (index === 1) {
                assert.ok(host.isInPlay());
                assert.equal(host.getHp(), host.cardData.hp + 2);
                assert.equal(host.getPower(), host.cardData.power + 2);
            }
        }
        else if (mode === 'deployed-leader-gain' || mode === 'token-gain') {
            if (index === sequence.length - 1) {
                assert.deepEqual(names(host), ['raid', 'restore']);
                assert.equal(host.getHp(), before[p.hostIndex].hp + 2 + (mode === 'token-gain' ? 1 : 0));
                assert.equal(host.getPower(), before[p.hostIndex].power + 2 + (mode === 'token-gain' ? 1 : 0));
            }
        }
        else if (mode.startsWith('shielded')) {
            assert.ok(host.isInPlay());
            assert.deepEqual(names(host), ['shielded']);
            assert.equal(host.getHp(), host.cardData.hp);
            if (card === host) {
                originalShield = host.upgrades.find(u => u.internalName === 'shield');
                assert.ok(originalShield);
            }
            if (mode === 'shielded-consumed' && card === extras[0]) {
                assert.equal(host.damage, 0);
                assert.equal(host.upgrades.length, 0);
                assert.equal(originalShield.zoneName, 'outsideTheGame');
                assert.equal(originalShield.isAttached(), false);
            }
            else
                assert.ok(host.upgrades.includes(originalShield));
        }
        else if (mode === 'numeric-zero') {
            assert.ok(host.isInPlay());
            assert.equal(host.getHp(), host.cardData.hp);
            assert.deepEqual(names(host), ['raid']);
            if (p.waitBeforeSource && card === source) {
                assert.equal(host.keywords[0].value, 0);
                assert.equal(host.exhausted, true);
                assert.equal(witness.events.filter(e => e.name === 'onCardExhausted').length, 1);
            }
        }
        else if (mode === 'mention' || mode.startsWith('force-')) {
            const role = card === source ? 'focus' : card === host ? 'host' : card.cardData.types.includes('upgrade') ? 'upgrade' : card.internalName;
            if (mode === 'mention') {
                assert.deepEqual(names(host), role === 'upgrade' ? ['restore'] : []);
                assert.equal(host.getHp(), host.cardData.hp + (role === 'upgrade' ? 1 : 0));
            }
            if (mode === 'force-gain' && index === sequence.length - 1) {
                assert.deepEqual(names(host), ['restore', 'sentinel']);
                assert.equal(host.getHp(), host.cardData.hp + 3);
                assert.equal(force().held, true);
            }
            if (mode === 'force-gain-use-regain') assertGainUseCheckpoint(host, card, extras, force());
            if (mode === 'force-drain-lethal' && index === sequence.length - 1) {
                assert.equal(host.zoneName, 'discard');
                assert.equal(extras[0].zoneName, 'discard');
                assert.equal(force().held, true);
                const created = witness.events.filter(e => e.name === 'onTokensCreated');
                assert.equal(created.length, 1);
                assert.equal(created[0].host.hp, host.cardData.hp + 1);
                assert.equal(created[0].host.damage, host.cardData.hp + 1);
                assert.deepEqual(created[0].host.keywords.map(k => k.name), ['restore']);
                assert.equal(created[0].force.held, true);
            }
            if (mode === 'force-use-loss' && index === sequence.length - 1) {
                assert.equal(host.zoneName, 'discard');
                assert.equal(extras[1].zoneName, 'discard');
                assert.equal(force().held, false);
                assert.equal(card.exhausted, false);
                const used = witness.events.filter(e => e.name === 'onForceUsed');
                assert.equal(used.length, 1);
                assert.equal(used[0].host.hp, host.cardData.hp + 3);
                assert.equal(used[0].host.damage, host.cardData.hp + 1);
                assert.deepEqual(used[0].host.keywords.map(k => k.name).sort(), ['restore', 'sentinel']);
                const death = witness.events.findIndex(e => e.name === 'onCardDefeated' && e.id === eg.cardId(host.uuid));
                assert.ok(death > witness.events.findIndex(e => e.name === 'onForceUsed'));
            }
        }
        else if (mode.startsWith('loss-name')) {
            if (card === source) {
                assert.equal(host.getHp(), host.cardData.hp + 2);
                assert.equal(host.keywords.length, 2);
            }
            else if (index === sequence.length - 1) {
                if (p.lethal)
                    assert.equal(host.zoneName, 'discard');
                else {
                    assert.ok(host.isInPlay());
                    assert.equal(host.getHp(), host.cardData.hp);
                    assert.deepEqual(names(host), ['sentinel']);
                }
            }
            else {
                assert.ok(host.isInPlay());
                assert.equal(host.damage, host.cardData.hp + 1);
            }
        }
        else if (mode.startsWith('gain-stack-expire')) {
            if (card === source) {
                assert.equal(host.getHp(), host.cardData.hp);
                assert.equal(host.keywords.length, 0);
            }
            else if (card.cardData.types.includes('event') && index <= 2) {
                assert.equal(host.getHp(), host.cardData.hp + 2);
                assert.deepEqual(names(host), ['raid', 'saboteur']);
                assert.equal(host.keywords.find(k => k.name === 'raid').value, index);
            }
            else {
                assert.ok(host.isInPlay());
                assert.equal(host.damage, host.cardData.hp + 1);
            }
        }
        witness.observations.push({ stage: 'macro-' + index, card: view(eg, card), source: view(eg, source), host: view(eg, host), state: fullState(eg) });
    }
    function finishMacro() {
        if (p.waitPhase) {
            assert.ok(eg.round > initialRound);
            if (p.macro === 'numeric-zero') {
                assert.equal(own.exhaustedResourceCount, 0);
                assert.deepEqual(host.keywords.map(k => ({ name: k.name, value: k.value })), [{ name: 'raid', value: 0 }]);
                assert.equal(host.getHp(), host.cardData.hp);
            }
            else if (p.lethal)
                assert.equal(host.zoneName, 'discard');
            else {
                assert.ok(host.isInPlay());
                assert.equal(host.getHp(), host.cardData.hp);
                assert.deepEqual(names(host), []);
            }
        }
        if (p.macro?.startsWith('source-departure') || p.macro === 'unique-source' && p.keep === 'old')
            assert.equal(source.zoneName, 'discard');
        else {
            assert.ok(source.isInPlay());
            const attachmentBonus = p.macro === 'source-two-keywords' ? 2 : 0;
            assert.equal(source.getHp(), source.cardData.hp + attachmentBonus);
            assert.equal(source.getPower(), source.cardData.power + attachmentBonus);
        }
        witness.coverageObligationIds = [...scenario.coverageObligationIds];
        witness.observations.push({ stage: 'macro-settled', host: view(eg, host), state: fullState(eg) });
    }
    function assertSource() {
        assert.ok(source.isInPlay());
        assert.equal(source.controller, own);
        assert.equal(ready(), readyBefore - cost(source), 'Exact printed/aspect payment');
        assert.equal(source.getHp(), source.cardData.hp, 'Aura source excluded');
        assert.equal(source.getPower(), source.cardData.power);
        assert.equal(fullState(eg).nextCardId, initial.nextCardId, 'No token allocation');
        for (let i = 0; i < targets.length; i++) {
            const target = targets[i];
            assert.ok(target.isInPlay(), 'Every disclosed recipient survives');
            if (p.mode === 'other-friendly-aura') {
                const bonus = target.controller === own && target.keywords.length > 1 ? 2 : 0;
                assert.equal(target.getHp(), before[i].hp + bonus);
                assert.equal(target.getPower(), before[i].power + bonus);
                assert.equal(target.damage, before[i].damage);
                assert.equal(target.exhausted, before[i].exhausted);
                assert.deepEqual(target.keywords.map(k => ({ name: k.name, value: k.value ?? null })), before[i].keywords);
            }
            else {
                assert.equal(target.getHp(), before[i].hp);
                assert.equal(target.getPower(), before[i].power);
                assert.equal(target.damage, before[i].damage);
                assert.equal(target.exhausted, selected && i === p.selectedIndex ? true : before[i].exhausted);
                assert.deepEqual(view(eg, target).keywords, before[i].keywords);
            }
            assert.deepEqual(view(eg, target).upgrades, before[i].upgrades);
        }
        if (p.mode === 'optional-exhaust') {
            assert.equal(selected, !p.noSelector && !p.decline);
            assert.equal(declined, !!p.decline);
            assert.deepEqual(witness.events.map(e => e.id), selected && !p.ineffectiveSelected ? [eg.cardId(targets[p.selectedIndex].uuid)] : []);
            if (p.inactiveCoordinate)
                assert.deepEqual(targets[p.selectedIndex].keywords.map(k => k.name), ['coordinate']);
        }
        for (const seat of ['p1', 'p2']) {
            assert.equal(fullState(eg).players[seat].base.damage, initial.players[seat].base.damage);
            assert.deepEqual(fullState(eg).players[seat].forceToken, initial.players[seat].forceToken);
        }
        witness.observations.push({ stage: 'source-effects', source: view(eg, source), recipients: targets.map(c => view(eg, c)), state: fullState(eg) });
        witness.coverageObligationIds = [...scenario.coverageObligationIds];
    }
    try {
        while (!eg.over && step < 4000) {
            const pid = eg.ids.find(id => eg.legalActions(id).length);
            assert.ok(pid);
            const actions = expandActions(eg, eg.legalActions(pid)), window = eg.isActionWindow(pid), prompt = eg.player(pid).currentPrompt();
            let chosen;
            if (window) {
                records.push({ type: 'state', step, state: fullState(eg, pid) });
                if (!settled && played) {
                    if (p.macro) {
                        assertMacroStage(sequence[index]);
                        index++;
                        started = false;
                        played = false;
                        if (index === sequence.length && !p.waitPhase) {
                            finishMacro();
                            settled = true;
                        }
                    }
                    else {
                        assertSource();
                        settled = true;
                    }
                }
                if (!settled && p.macro && index === sequence.length && eg.round > initialRound) {
                    finishMacro();
                    settled = true;
                }
                if (!settled) {
                    chosen = index < sequence.length && pid === sequence[index].owner.id && !started && !(p.waitBeforeSource && index === 1 && eg.round === initialRound) ? actions.find(a => a.cardUuid === sequence[index].uuid) : actions.find(a => a.arg === 'pass');
                    assert.ok(chosen);
                    if (index < sequence.length && chosen.cardUuid === sequence[index].uuid) {
                        started = true;
                        readyBefore = ready(sequence[index].owner);
                    }
                }
            }
            else if (!settled && started) {
                if (p.oldIndex != null && actions.some(a => a.cardUuid === source.uuid) && actions.some(a => a.cardUuid === targets[p.oldIndex].uuid)) {
                    assert.equal(pid, own.id);
                    assert.equal(source.getHp(), source.cardData.hp);
                    assert.equal(source.getPower(), source.cardData.power);
                    assert.equal(targets[p.oldIndex].getHp(), source.cardData.hp);
                    assert.equal(targets[p.oldIndex].getPower(), source.cardData.power);
                    assert.equal(host.getHp(), before[p.hostIndex].hp + 2);
                    chosen = actions.find(a => a.cardUuid === (p.keep === 'old' ? source.uuid : targets[p.oldIndex].uuid));
                    uniqueChosen = true;
                }
                if (!chosen && p.sourceDamageFromIndex != null && index >= p.sourceDamageFromIndex)
                    chosen = actions.find(a => a.cardUuid === source.uuid);
                if (!chosen && p.macro && actions.some(a => a.cardUuid === host.uuid))
                    chosen = actions.find(a => a.cardUuid === host.uuid);
                if (p.decline) {
                    chosen = actions.find(a => a.kind === 'button' && (/pass|decline|choose nothing/i.test(a.label ?? '') || a.arg === 'passAbility'));
                    if (chosen)
                        declined = true;
                }
                if (!chosen && p.selectedIndex != null && actions.some(a => a.cardUuid === targets[p.selectedIndex].uuid)) {
                    assert.equal(pid, own.id, 'Source controller chooses either recipient owner');
                    assert.ok(!p.noSelector);
                    assert.ok(played, 'WhenPlayed selection follows payment and source play');
                    const eligible = eg.game.getArenaUnits().filter(c => c.keywords.length > 0);
                    assert.deepEqual(actions.filter(a => a.kind === 'card').map(a => a.cardUuid).sort(), eligible.map(c => c.uuid).sort(), 'Exact live keyword domain includes ineffective legal recipients');
                    chosen = actions.find(a => a.cardUuid === targets[p.selectedIndex].uuid);
                    selected = true;
                }
                chosen ??= actions.find(a => a.label === 'Trigger');
                chosen ??= actions.find(a => a.kind === 'button' && /trigger|resolve|play anyway/i.test(a.label ?? ''));
            }
            chosen ??= bot.choose({ game: eg, pid, actions, rng });
            assert.ok(chosen);
            records.push({ type: 'decision', step, actor: eg.seatOf(pid), prompt: { type: prompt.promptType ?? null, title: prompt.menuTitle ?? null,
                    selected: (eg.player(pid).promptState.selectedCards ?? []).map(c => eg.cardId(c.uuid)), actionWindow: window },
                actions: actions.map(a => canonicalAction(eg, a)), chosen: canonicalAction(eg, chosen).key, events: [] });
            eg.apply(pid, chosen, rng);
            step++;
        }
        assert.ok(settled);
        assert.ok(eg.over);
        records.push({ type: 'result', step, winner: eg.winner, state: fullState(eg) });
        return { records, witness };
    }
    finally {
        bot.close?.();
    }
}
module.exports = { fixture, assertGainUseCheckpoint, dependencies: ['bot/cards/pipeline/keyword-inventory-probes.js', 'bot/cards/pipeline/keyword-inventory-probe-fixture.js',
        'bot/cards/pipeline/probe-fixture.js', 'bot/omni/rs/make-pool.js', 'bot/cards/pipeline/force-probes.js', 'bot/cards/pipeline/arena-damage-probes.js',
        'bot/cards/pipeline/parent-upgrade-probes.js', 'bot/cards/pipeline/weakness-continuation-probes.js', 'bot/env.js', 'bot/omni/rs/state.js', 'bot/players/index.js'] };
