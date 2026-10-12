"use strict";
const assert = require("node:assert/strict");
const { constructProbeFixture } = require("./probe-fixture");
const {
  fullState,
  canonicalAction,
  expandActions,
  phaseStats,
} = require("../../omni/rs/state");
async function fixture(env, pool, scenario, seed) {
  const p = scenario.probe;
  if (p.effectFamily === "damage") return unitDamageFixture(env, pool, scenario, seed);
  if (p.trigger === "onAttack") return attackFixture(env, pool, scenario, seed);
  assert.equal(p.family, "named-target");
  const { eg, rng, bot, deck, own, enemy, source, targets } =
    await constructProbeFixture(env, pool, scenario, seed);
  const round = eg.round;
  const availableAspects = [...own.getAspectsForCosts()];
  let expectedCost = source.cardData.cost;
  for (const aspect of source.cardData.aspects) {
    const index = availableAspects.indexOf(aspect);
    if (index < 0) expectedCost += 2;
    else availableAspects.splice(index, 1);
  }
  const ready = () =>
    own.getCardsInZone("resource").filter((c) => !c.exhausted).length;
  const live = (c) => c.isUnit?.() && c.isInPlay?.();
  const eligible = (c, d) =>
    live(c) &&
    (!d.arena || c.zoneName === d.arena + "Arena") &&
    (!d.trait || c.hasSomeTrait(d.trait));
  const baseline = new Map(
    [...targets, source]
      .filter((c) => c.isUnit?.())
      .map((c) => [
        c,
        {
          power: live(c) ? c.getPower() : c.cardData.power,
          hp: live(c) ? c.getHp() : c.cardData.hp,
        },
      ]),
  );
  const witness = { coverageObligationIds: [], observations: [] };
  const records = [
    {
      type: "meta",
      schema: "omni-rs-trace-v1",
      pool: pool.provenance,
      seed,
      bots: ["named-target-probe", "named-target-probe"],
      decks: [deck, deck],
      scenario: scenario.name,
      fixtureConstruction:
        "Stage disclosed quiet real units and resources at first natural action window; normally play focus, record every target/cancel/payment input and continue to terminal result.",
      constructionParameters: p,
    },
  ];
  let activated = false,
    settled = false,
    played = false,
    cancelled = false;
  let step = 0,
    initialReady = 0,
    descriptorIndex = 0,
    selections = [];
  const prompted = new Set();
  const expectedPrompts = p.descriptors
    .map((d, i) =>
      targets.some((c) => eligible(c, d)) ||
      (p.trigger === "whenPlayed" &&
        (!d.arena || p.sourceArena === d.arena) &&
        (!d.trait || source.cardData.traits.includes(d.trait)))
        ? i
        : -1,
    )
    .filter((i) => i >= 0);
  eg.game.on("onCardPlayed", (e) => {
    if (activated && !settled && !e.isCancelledOrReplaced && e.card === source)
      played = true;
  });
  function assertStats(expired = false) {
    for (const [c, initial] of baseline) {
      if (!live(c)) continue;
      const additions = expired ? [] : selections.filter((s) => s.card === c);
      assert.equal(
        c.getPower(),
        initial.power + additions.reduce((n, s) => n + s.descriptor.power, 0),
      );
      assert.equal(
        c.getHp(),
        initial.hp + additions.reduce((n, s) => n + s.descriptor.hp, 0),
      );
    }
  }
  function observe(stage, pid, actions) {
    witness.observations.push({
      stage,
      actor: pid ? eg.seatOf(pid) : undefined,
      actions: actions?.map((a) => canonicalAction(eg, a)),
      sourceZone: source.zoneName,
      readyResources: ready(),
      selections: selections.map((s) => ({
        card: eg.cardId(s.card.uuid),
        name: s.descriptor.name,
      })),
      targets: [...baseline.keys()]
        .filter(live)
        .map((c) => ({ id: eg.cardId(c.uuid), ...phaseStats(c) })),
      state: fullState(eg),
    });
  }
  try {
    while (!eg.over && step < 4000) {
      const pid = eg.ids.find((id) => eg.legalActions(id).length);
      assert.ok(pid);
      const actions = expandActions(eg, eg.legalActions(pid));
      const window = eg.isActionWindow(pid),
        prompt = eg.player(pid).currentPrompt();
      let chosen;
      if (window) {
        records.push({ type: "state", step, state: fullState(eg, pid) });
        if (activated && !settled && cancelled) {
          assert.equal(source.zoneName, "hand");
          assert.equal(ready(), initialReady);
          selections = [];
          assertStats();
          observe("cancelled");
          settled = true;
        } else if (activated && !settled && played) {
          if (eg.round === round)
            assert.equal(
              ready(),
              initialReady - expectedCost,
              "Exact printed cost plus absent-aspect penalties",
            );
          assert.deepEqual(
            [...prompted],
            expectedPrompts,
            "Missing descriptors skip individually; all eligible descriptors prompt",
          );
          assertStats(p.waitForExpiry && eg.round > round);
          if (!p.waitForExpiry) {
            observe("resolved");
            settled = true;
          } else if (eg.round > round) {
            assertStats(true);
            observe("phase-expired");
            settled = true;
          }
        }
        if (!settled && !activated && pid === own.id) {
          initialReady = ready();
          chosen = actions.find((a) => a.cardUuid === source.uuid);
          assert.ok(chosen, "Actual focus normal play");
          activated = true;
        } else if (!settled) {
          chosen = actions.find((a) => a.arg === "pass");
        }
      } else if (activated && !settled) {
        if (/no effect/i.test(prompt.menuTitle ?? "")) {
          assert.equal(pid, own.id);
          assert.deepEqual(
            actions.map((a) => a.label),
            ["Play anyway", "Cancel"],
          );
          assert.equal(source.zoneName, "hand");
          assert.equal(ready(), initialReady);
          observe("empty-confirmation", pid, actions);
          chosen = actions.find(
            (a) => a.label === (p.cancelEmpty ? "Cancel" : "Play anyway"),
          );
          cancelled = !!p.cancelEmpty;
        } else {
          const index = p.descriptors.findIndex(
            (d) => d.promptTitle === prompt.menuTitle,
          );
          if (index >= 0) {
            assert.ok(
              index >= descriptorIndex,
              "Ordered named descriptor prompts",
            );
            descriptorIndex = index + 1;
            prompted.add(index);
            const d = p.descriptors[index];
            assert.equal(pid, own.id);
            const candidates = eg.game
              .getArenaUnits()
              .filter((c) => eligible(c, d));
            const targetActions = actions.filter((a) => a.kind === "card");
            assert.deepEqual(
              targetActions.map((a) => a.cardUuid).sort(),
              candidates.map((c) => c.uuid).sort(),
              "Exact candidate domain includes both owners and excludes wrong trait/arena",
            );
            const prepaid = p.trigger === "event" && !played;
            assert.deepEqual(
              actions.filter((a) => a.kind === "button").map((a) => a.label),
              prepaid ? ["Choose nothing", "Cancel"] : ["Choose nothing"],
            );
            if (prepaid) {
              assert.equal(ready(), initialReady);
              for (const [c, initial] of baseline)
                if (live(c)) {
                  assert.equal(
                    c.getPower(),
                    initial.power,
                    "Selections wait until all descriptors complete",
                  );
                  assert.equal(c.getHp(), initial.hp);
                }
            } else {
              assert.equal(
                ready(),
                initialReady - expectedCost,
                "Exact focus payment precedes postcost targeting",
              );
              assert.equal(
                source.zoneName,
                p.trigger === "event" ? "discard" : p.sourceArena + "Arena",
              );
            }
            observe("descriptor-" + (index + 1), pid, actions);
            const choice = p.choices[index];
            if (choice === "cancel") {
              chosen = actions.find((a) => a.arg === "cancel");
              assert.ok(chosen);
              cancelled = true;
            } else if (choice === "decline") {
              chosen = actions.find((a) => a.arg === "done");
            } else {
              const card =
                choice === "source"
                  ? source
                  : candidates.find(
                      (c) =>
                        c.controller === (choice === "enemy" ? enemy : own),
                    );
              assert.ok(card, "Metadata-selected recipient exists");
              chosen = actions.find((a) => a.cardUuid === card.uuid);
              assert.ok(chosen);
              selections.push({ card, descriptor: d });
            }
          }
        }
        chosen ??= actions.find(
          (a) =>
            a.kind === "button" &&
            /trigger|resolve|play|yes/i.test(a.label ?? ""),
        );
        chosen ??= actions.find((a) => a.arg === "done");
      }
      chosen ??= bot.choose({ game: eg, pid, actions, rng });
      assert.ok(chosen);
      records.push({
        type: "decision",
        step,
        actor: eg.seatOf(pid),
        prompt: {
          type: prompt.promptType ?? null,
          title: prompt.menuTitle ?? null,
          selected: (eg.player(pid).promptState.selectedCards ?? []).map((c) =>
            eg.cardId(c.uuid),
          ),
          actionWindow: window,
        },
        actions: actions.map((a) => canonicalAction(eg, a)),
        chosen: canonicalAction(eg, chosen).key,
        events: [],
      });
      eg.apply(pid, chosen, rng);
      step++;
    }
    assert.ok(settled, "Focused named selection settled");
    assert.ok(eg.over);
    records.push({
      type: "result",
      step,
      winner: eg.winner,
      state: fullState(eg),
    });
    witness.coverageObligationIds = [...scenario.coverageObligationIds];
    return { records, witness };
  } finally {
    bot.close?.();
  }
}
async function attackFixture(env, pool, scenario, seed) {
  const p = scenario.probe;
  const { eg, rng, bot, deck, own, enemy, source, targets } =
    await constructProbeFixture(env, pool, scenario, seed);
  const initialRound = eg.round;
  let damagePrepared = p.damagePreparation === undefined,
    upgradePrepared = p.upgradePreparation === undefined;
  let prepStarted, prepReady;
  const initialEnemyBase = enemy.base.damage;
  const defender = targets[p.attackTarget];
  assert.ok(
    defender &&
      defender.controller === enemy &&
      defender.zoneName === p.sourceArena + "Arena",
  );
  const live = (c) => c.isUnit?.() && c.isInPlay?.();
  const eligible = (c, d) =>
    live(c) && (!d.arena || c.zoneName === d.arena + "Arena");
  const baseline = new Map();
  const witness = { coverageObligationIds: [], observations: [] };
  const records = [
    {
      type: "meta",
      schema: "omni-rs-trace-v1",
      pool: pool.provenance,
      seed,
      bots: ["named-target-probe", "named-target-probe"],
      decks: [deck, deck],
      scenario: scenario.name,
      fixtureConstruction:
        "Stage disclosed real units, normally play focus, naturally ready next phase, declare an actual attack and record all named choices before shared stat events and combat through terminal result.",
      constructionParameters: p,
    },
  ];
  let step = 0,
    activated = false,
    played = false,
    attackStarted = false,
    attackPicked = false;
  let settled = false,
    attackRound,
    initialReady,
    selections = [],
    prompted = new Set(),
    damageAtStart;
  let defenseTokens = [];
  const initialCardCount = eg.game.state.allCards.length;
  const force = [enemy.baseZone.cards, enemy.outsideTheGameZone.getCards()]
    .flat()
    .find((c) => c.isForceToken());
  const forceId = force && eg.cardId(force.uuid);
  eg.game.on("onTokensCreated", (e) => {
    if (!settled && attackPicked) defenseTokens.push(...(e.tokens ?? []));
  });
  const ready = () =>
    own.getCardsInZone("resource").filter((c) => !c.exhausted).length;
  function cardCost(card) {
    const available = [...own.getAspectsForCosts()];
    let n = card.cardData.cost;
    for (const a of card.cardData.aspects) {
      const i = available.indexOf(a);
      if (i < 0) n += 2;
      else available.splice(i, 1);
    }
    return n;
  }
  const aspects = [...own.getAspectsForCosts()];
  let cost = source.cardData.cost;
  for (const a of source.cardData.aspects) {
    const i = aspects.indexOf(a);
    if (i < 0) cost += 2;
    else aspects.splice(i, 1);
  }
  eg.game.on("onCardPlayed", (e) => {
    if (activated && !settled && !e.isCancelledOrReplaced && e.card === source)
      played = true;
  });
  function capture() {
    for (const c of eg.game.getArenaUnits())
      if (!baseline.has(c)) {
        baseline.set(c, {
          power: c.getPower(),
          hp: c.getHp(),
          damage: c.damage,
        });
      }
  }
  function observe(stage, pid, actions) {
    witness.observations.push({
      stage,
      actor: pid ? eg.seatOf(pid) : undefined,
      actions: actions?.map((a) => canonicalAction(eg, a)),
      sourceZone: source.zoneName,
      defenderZone: defender.zoneName,
      selections: selections.map((s) => ({
        id: eg.cardId(s.card.uuid),
        name: s.descriptor.name,
      })),
      state: fullState(eg),
    });
  }
  function stat(c, key, expired) {
    const b = baseline.get(c);
    const n =
      b[key] +
      (expired
        ? 0
        : selections
            .filter((s) => s.card === c)
            .reduce((sum, s) => sum + s.descriptor[key], 0));
    return key === "power" ? Math.max(0, n) : n;
  }
  function assertStats(expired) {
    const attackerStart = baseline.get(source),
      defenderStart = baseline.get(defender);
    const attackerGone = stat(source, "hp", false) <= attackerStart.damage;
    const defenderGone = stat(defender, "hp", false) <= defenderStart.damage;
    const combat = !attackerGone && !defenderGone;
    for (const [c, b] of baseline) {
      const damage =
        b.damage +
        (!combat
          ? 0
          : c === source
          ? stat(defender, "power", false)
          : c === defender
          ? stat(source, "power", false)
          : 0);
      const hp = stat(c, "hp", expired);
      const dead =
        (c === source && attackerGone) ||
        (c === defender && defenderGone) ||
        damage >= hp;
      if (dead) {
        assert.equal(
          c.zoneName,
          "discard",
          "Expected stat/combat/expiry defeat resolves before observation",
        );
      } else {
        assert.ok(
          live(c),
          "Every nonlethal selected and nonselected recipient remains in play",
        );
        assert.equal(c.getPower(), stat(c, "power", expired));
        assert.equal(c.getHp(), hp);
        assert.equal(
          c.damage,
          damage,
          "Only captured combatants receive combat damage",
        );
      }
    }
  }
  try {
    while (!eg.over && step < 4000) {
      const pid = eg.ids.find((id) => eg.legalActions(id).length);
      assert.ok(pid);
      const actions = expandActions(eg, eg.legalActions(pid));
      const window = eg.isActionWindow(pid),
        prompt = eg.player(pid).currentPrompt();
      let chosen;
      if (window) {
        records.push({ type: "state", step, state: fullState(eg, pid) });
        if (attackPicked && !settled) {
          const expected = p.descriptors
            .map((d, i) =>
              [...baseline.keys()].some(
                (c) =>
                  !d.arena ||
                  c.zoneName === d.arena + "Arena" ||
                  c.cardData.arena === d.arena,
              )
                ? i
                : -1,
            )
            .filter((i) => i >= 0);
          assert.deepEqual([...prompted], expected);
          assertStats(p.waitForExpiry && eg.round > attackRound);
          if (p.expectAttackerDeparture) {
            assert.equal(source.zoneName, "discard");
            assert.equal(
              defender.damage,
              baseline.get(defender).damage,
              "Departed attacker deals no combat damage",
            );
          }
          if (p.expectOverwhelm) {
            assert.equal(
              enemy.base.damage - initialEnemyBase,
              baseline.get(source).power,
              "Full live attacker power reaches captured defending player base",
            );
          }
          if (p.expectDefenderDeparture) {
            assert.equal(defender.zoneName, "discard");
            assert.equal(
              source.damage,
              damageAtStart,
              "Departed defender does not retaliate",
            );
          }
          if (p.expectClone) {
            const clones = eg.game
              .getArenaUnits()
              .filter(
                (c) =>
                  c.isToken() &&
                  c.controller === enemy &&
                  c.cardData.internalName === "clone-trooper",
              );
            assert.equal(
              clones.length,
              1,
              "Captured OnDefense creates exactly one enemy Clone after source departure",
            );
            assert.equal(eg.game.state.allCards.length, initialCardCount + 1);
          }
          if (p.expectExpiryDeath) {
            if (eg.round === attackRound) {
              assert.ok(live(defender));
              assert.equal(defender.damage, defender.cardData.hp);
              assert.equal(enemy.hasTheForce, false);
            } else assert.equal(defender.zoneName, "discard");
          }
          if (
            p.expectDeathForce &&
            (!p.expectExpiryDeath || eg.round > attackRound)
          ) {
            assert.equal(enemy.hasTheForce, true);
            assert.equal(eg.cardId(force.uuid), forceId);
            assert.equal(eg.game.state.allCards.length, initialCardCount);
          }
          if (!p.waitForExpiry || eg.round > attackRound) {
            observe(
              p.waitForExpiry ? "natural-phase-expiry" : "attack-resolved",
            );
            settled = true;
          }
        }
        if (!activated && !settled && pid === own.id) {
          initialReady = ready();
          chosen = actions.find((a) => a.cardUuid === source.uuid);
          assert.ok(chosen);
          activated = true;
        } else if (
          played &&
          !attackStarted &&
          !settled &&
          pid === own.id &&
          (!damagePrepared || !upgradePrepared)
        ) {
          if (prepStarted !== undefined) {
            const c = targets[prepStarted];
            assert.equal(
              ready(),
              prepReady - cardCost(c),
              "Exact real preparation printed/aspect payment",
            );
            if (prepStarted === p.damagePreparation) {
              assert.equal(c.zoneName, "discard");
              assert.equal(source.damage, source.cardData.hp - 1);
              damagePrepared = true;
            } else {
              assert.equal(c.parentCard, source);
              upgradePrepared = true;
            }
            prepStarted = undefined;
          }
          if (!damagePrepared || !upgradePrepared) {
            if (!damagePrepared)
              assert.equal(
                ready(),
                initialReady - cost,
                "Focus paid before actual preparation",
              );
            prepStarted = !damagePrepared
              ? p.damagePreparation
              : p.upgradePreparation;
            prepReady = ready();
            chosen = actions.find(
              (a) => a.cardUuid === targets[prepStarted].uuid,
            );
            assert.ok(chosen, "Normal real damage/upgrade preparation play");
          } else chosen = actions.find((a) => a.arg === "pass");
        } else if (
          played &&
          !attackStarted &&
          !settled &&
          eg.round > initialRound &&
          pid === own.id
        ) {
          assert.ok(
            live(source) && !source.exhausted,
            "Normal played source naturally readied",
          );
          capture();
          damageAtStart = source.damage;
          attackRound = eg.round;
          chosen = actions.find((a) => a.cardUuid === source.uuid);
          assert.ok(chosen);
          attackStarted = true;
        } else if (!settled) {
          if (
            played &&
            eg.round === initialRound &&
            p.damagePreparation === undefined
          )
            assert.equal(ready(), initialReady - cost);
          chosen = actions.find((a) => a.arg === "pass");
        }
      } else if (activated && !settled) {
        if (
          prepStarted !== undefined &&
          actions.some((a) => a.cardUuid === source.uuid)
        ) {
          chosen = actions.find((a) => a.cardUuid === source.uuid);
          assert.equal(pid, own.id);
          observe("actual-source-preparation", pid, actions);
        } else if (
          attackStarted &&
          /target for attack/i.test(prompt.menuTitle ?? "")
        ) {
          assert.equal(pid, own.id);
          chosen = actions.find((a) => a.cardUuid === defender.uuid);
          assert.ok(chosen);
          attackPicked = true;
          observe("actual-attack-target", pid, actions);
        } else if (
          attackPicked &&
          /Choose which player/i.test(prompt.menuTitle ?? "")
        ) {
          assert.equal(pid, own.id);
          chosen = actions.find(
            (a) => a.label === (p.defenderFirst ? "Opponent" : "You"),
          );
          assert.ok(chosen);
          observe("declaration-owner-priority", pid, actions);
        } else {
          const index = p.descriptors.findIndex(
            (d) => d.promptTitle === prompt.menuTitle,
          );
          if (index >= 0) {
            assert.ok(
              attackPicked,
              "Named selectors only after actual attack declaration",
            );
            assert.equal(pid, own.id);
            capture();
            const d = p.descriptors[index];
            const candidates = eg.game
              .getArenaUnits()
              .filter((c) => eligible(c, d));
            assert.deepEqual(
              actions
                .filter((a) => a.kind === "card")
                .map((a) => a.cardUuid)
                .sort(),
              candidates.map((c) => c.uuid).sort(),
            );
            assert.deepEqual(
              actions.filter((a) => a.kind === "button").map((a) => a.label),
              d.optional ? ["Choose nothing"] : [],
            );
            for (const [c, b] of baseline) {
              assert.ok(
                live(c),
                "No recipient departs while selectors unresolved",
              );
              assert.equal(
                c.getPower(),
                b.power,
                "All selections precede all stat effects",
              );
              assert.equal(c.getHp(), b.hp);
            }
            prompted.add(index);
            const choice = p.choices[index];
            if (choice === "decline") {
              assert.ok(d.optional);
              chosen = actions.find((a) => a.arg === "done");
            } else {
              const c =
                choice === "source"
                  ? source
                  : choice === "defender"
                  ? defender
                  : choice.startsWith("index:")
                  ? targets[Number(choice.slice(6))]
                  : candidates.find(
                      (c) =>
                        c.controller === (choice === "enemy" ? enemy : own) &&
                        c !== source &&
                        c !== defender,
                    ) ??
                    candidates.find(
                      (c) =>
                        c.controller === (choice === "enemy" ? enemy : own),
                    );
              assert.ok(c && candidates.includes(c));
              chosen = actions.find((a) => a.cardUuid === c.uuid);
              selections.push({ card: c, descriptor: d });
            }
            assert.ok(chosen);
            observe("descriptor-" + (index + 1), pid, actions);
          }
        }
        chosen ??= actions.find(
          (a) =>
            a.kind === "button" &&
            /trigger|resolve|play|yes/i.test(a.label ?? ""),
        );
        chosen ??= actions.find((a) => a.arg === "done");
      }
      chosen ??= bot.choose({ game: eg, pid, actions, rng });
      assert.ok(chosen);
      records.push({
        type: "decision",
        step,
        actor: eg.seatOf(pid),
        prompt: {
          type: prompt.promptType ?? null,
          title: prompt.menuTitle ?? null,
          selected: (eg.player(pid).promptState.selectedCards ?? []).map((c) =>
            eg.cardId(c.uuid),
          ),
          actionWindow: window,
        },
        actions: actions.map((a) => canonicalAction(eg, a)),
        chosen: canonicalAction(eg, chosen).key,
        events: [],
      });
      eg.apply(pid, chosen, rng);
      step++;
    }
    assert.ok(settled && eg.over);
    records.push({
      type: "result",
      step,
      winner: eg.winner,
      state: fullState(eg),
    });
    witness.coverageObligationIds = [...scenario.coverageObligationIds];
    return { records, witness };
  } finally {
    bot.close?.();
  }
}

module.exports = {
  fixture,
  dependencies: [
    "bot/cards/pipeline/named-target-probes.js",
    "bot/cards/pipeline/named-target-probe-fixture.js",
    "bot/cards/pipeline/probe-fixture.js",
    "bot/env.js",
    "bot/omni/rs/state.js",
    "bot/players/index.js",
  ],
};

async function unitDamageFixture(env,pool,scenario,seed) {
    const p=scenario.probe;
    let construction=scenario;
    if(p.sourceSeat===2)construction={...scenario,probe:{...p,targets:[...p.targets.map(t=>({...t,owner:t.owner==='self'?'opponent':'self'})),{code:p.cardId,owner:'opponent',zone:'hand',arena:p.sourceArena}]}};
    if(p.preparationCode)construction={...construction,probe:{...construction.probe,activationCode:p.preparationCode}};
    const setup=await constructProbeFixture(env,pool,construction,seed),{eg,rng,bot,deck}=setup;
    const own=p.sourceSeat===2?setup.enemy:setup.own,enemy=p.sourceSeat===2?setup.own:setup.enemy;
    const targets=setup.targets.slice(),source=p.sourceSeat===2?targets.pop():setup.source;
    const preparation=p.preparationCode?setup.activation:null;
    const defender=p.attackBase?enemy.base:targets[p.attackTarget];
    if(p.trigger==='onAttack'&&!['decline','empty','unique-departed'].includes(p.activationMode))assert.ok(defender&&defender.controller===enemy,'Actual attack defender exists');
    const live=c=>c.isUnit?.()&&c.isInPlay?.();
    const eligible=(c,d)=>live(c)&&c.controller===(d.owner==='self'?own:enemy)&&(!d.arena||c.zoneName===d.arena+'Arena');
    const cardId=c=>eg.cardId(c.uuid),ready=()=>own.getCardsInZone('resource').filter(c=>!c.exhausted).length;
    const initialRound=eg.round,initialCount=eg.game.state.allCards.length,initialBaseDamage=new Map([[own.base,own.base.damage],[enemy.base,enemy.base.damage]]);
    const initialForce=eg.game.getPlayers().map(player=>{const token=[player.baseZone.cards,player.outsideTheGameZone.getCards()].flat().find(c=>c.isForceToken());return{player,held:player.hasTheForce,token,id:token&&cardId(token)};});
    assert.ok(initialForce.every(f=>!f.held&&f.token),'Disclosed Force initially outside with exact stable identity');
    const costs=[...own.getAspectsForCosts()];let expectedCost=source.cardData.cost;
    for(const aspect of source.cardData.aspects){const i=costs.indexOf(aspect);if(i<0)expectedCost+=2;else costs.splice(i,1);}
    const records=[{type:'meta',schema:'omni-rs-trace-v1',pool:pool.provenance,seed,bots:['named-damage-probe','named-damage-probe'],decks:[deck,deck],scenario:scenario.name,
        fixtureConstruction:'Stage disclosed real recipients/tokens, reserve distinct physical cards, normally play focus and optional real damage preparation; actual Ambush or natural ready attack; record exact source-controller named menus/shared damage/replacement/death inputs through terminal result.',constructionParameters:p}];
    const witness={coverageObligationIds:[],observations:[]};
    let step=0,activated=false,played=false,settled=false,initialReady,ambushSeen=false,ambushPassed=false,attackStarted=false,attackPicked=false;
    let preparationStarted=false,preparationPlayed=false,prepared=!preparation,uniqueSeen=false,descriptorIndex=0;
    const selections=[],prompted=[],baseline=new Map(),focusedDamage=[],shieldDefeats=[];
    const capture=()=>{for(const c of eg.game.getArenaUnits())if(!baseline.has(c))baseline.set(c,{hp:c.getHp(),power:c.getPower(),damage:c.damage,shields:c.upgrades.filter(u=>u.isShield?.()).map(cardId)});};
    eg.game.on('onCardPlayed',e=>{if(activated&&!settled&&!e.isCancelledOrReplaced){if(e.card===source)played=true;if(e.card===preparation)preparationPlayed=true;}});
    eg.game.on('onDamageDealt',e=>{if(activated&&!settled&&e.damageSource?.type==='ability'&&e.damageSource.card===source){assert.equal(e.context.player,own);focusedDamage.push({card:e.card,amount:e.amount,dealt:e.damageDealt});}});
    eg.game.on('onCardDefeated',e=>{if(activated&&!settled&&e.card.isShield?.())shieldDefeats.push(cardId(e.card));});
    function observe(stage,pid,actions){witness.observations.push({stage,actor:pid?eg.seatOf(pid):undefined,actions:actions?.map(a=>canonicalAction(eg,a)),source:cardId(source),sourceZone:source.zoneName,
        selections:selections.map(s=>({id:cardId(s.card),name:s.descriptor.name})),focusedDamage:focusedDamage.map(e=>({id:cardId(e.card),amount:e.amount,dealt:e.dealt})),shieldDefeats:[...shieldDefeats],state:fullState(eg)});}
    function assertResolved(){
        assert.equal(played,true,'Focus was normally played, never staged as source');
        if(eg.round===initialRound&&!preparationPlayed)assert.equal(ready(),initialReady-expectedCost,'Exact printed and absent-aspect focus cost');
        for(const s of selections){const b=baseline.get(s.card);assert.ok(b);const dealt=focusedDamage.filter(e=>e.card===s.card).reduce((n,e)=>n+e.dealt,0);assert.equal(dealt,b.shields.length?0:Math.min(s.descriptor.amount,b.hp-b.damage),'Source-derived primary damage clips remainingHP and respects real Shield replacement');}
        assert.equal(focusedDamage.length,selections.filter(s=>!baseline.get(s.card).shields.length).length,'Each unprevented chosen primary produces exactly one damage event');
        const expected=p.descriptors.map((d,i)=>[...baseline.keys()].some(c=>c.controller===(d.owner==='self'?own:enemy)&&(!d.arena||c.cardData.arena===d.arena))?i:-1).filter(i=>i>=0);
        if(p.trigger==='whenPlayed'||attackPicked)assert.deepEqual(prompted,expected,'Every available mandatory descriptor was actually selected');
        const damage=new Map([...baseline].map(([c,b])=>[c,b.damage]));
        const shields=new Map([...baseline].map(([c,b])=>[c,b.shields.length]));
        const hit=(c,n)=>{const b=baseline.get(c);assert.ok(b);if(shields.get(c)>0)shields.set(c,shields.get(c)-1);else damage.set(c,Math.min(b.hp,damage.get(c)+n));};
        for(const selected of selections)hit(selected.card,selected.descriptor.amount);
        let baseCombat=0;
        if(attackPicked&&baseline.has(source)&&damage.get(source)<baseline.get(source).hp){
            if(defender.isUnit?.()&&baseline.has(defender)&&damage.get(defender)<baseline.get(defender).hp){hit(defender,baseline.get(source).power);hit(source,baseline.get(defender).power);}
            else if(defender===enemy.base)baseCombat=baseline.get(source).power;
        }
        for(const [c,b]of baseline){
            if(damage.get(c)>=b.hp)assert.equal(c.zoneName,'discard','Derived complete primary/combat lethal set must physically depart');
            else {assert.ok(live(c),'All unselected/nonlethal recipients remain live');assert.equal(c.damage,damage.get(c),'Exact primary plus combat damage, including untouched recipients');assert.equal(c.getPower(),b.power);assert.equal(c.getHp(),b.hp);const ids=c.upgrades.filter(u=>u.isShield?.()).map(cardId);assert.equal(ids.length,shields.get(c),'Exactly the primary/combat replacement count is consumed');assert.deepEqual(ids.slice().sort(),b.shields.filter(id=>!shieldDefeats.includes(id)).sort(),'Surviving Shield identities come from original attached tokens');}
        }
        assert.equal(own.base.damage,initialBaseDamage.get(own.base));
        assert.equal(enemy.base.damage,Math.min(enemy.base.cardData.hp,initialBaseDamage.get(enemy.base)+baseCombat),'Only retained live attacker base combat changes a base');
        if(p.expectSourceDeparture){assert.equal(source.zoneName,'discard');assert.equal(enemy.base.damage,0,'Dead attacker cannot deal combat damage');}
        if(p.expectDefenderDeparture){assert.equal(defender.zoneName,'discard');assert.equal(source.damage,baseline.get(source).damage,'Departed defender cannot retaliate');assert.equal(enemy.base.damage,0,'No printed Overwhelm on this source');}
        if(p.expectForce){for(const f of initialForce){const selectedDeath=selections.some(s=>s.card.controller===f.player&&(p.forceDonorIndices??[]).some(i=>targets[i]===s.card)&&damage.get(s.card)>=baseline.get(s.card).hp);assert.equal(f.player.hasTheForce,selectedDeath);const current=[f.player.baseZone.cards,f.player.outsideTheGameZone.getCards()].flat().filter(c=>c.isForceToken());assert.equal(current.length,1);assert.equal(cardId(current[0]),f.id);}}
        if(p.expectClone){const clones=eg.game.getArenaUnits().filter(c=>c.isToken()&&c.controller===enemy&&c.cardData.internalName==='clone-trooper');assert.equal(clones.length,1);assert.equal(eg.game.state.allCards.length,initialCount+1);}else assert.equal(eg.game.state.allCards.length,initialCount,'Focus damage and stable Force do not allocate cards');
        if(p.activationMode==='decline'){assert.ok(ambushSeen&&ambushPassed);assert.ok(source.exhausted);assert.equal(selections.length,0);}
        if(p.activationMode==='empty'){assert.equal(ambushSeen,false);assert.ok(source.exhausted);assert.equal(selections.length,0);}
        if(p.keepUnique){assert.ok(uniqueSeen);const old=targets.at(-1);assert.equal(p.keepUnique==='old'?source.zoneName:old.zoneName,'discard');if(p.keepUnique==='old'){assert.ok(live(old)&&old.exhausted);assert.equal(ambushSeen,false);assert.equal(attackPicked,false);}}
    }
    try{
        while(!eg.over&&step<4000){
            const pid=eg.ids.find(id=>eg.legalActions(id).length);assert.ok(pid);const actions=expandActions(eg,eg.legalActions(pid)),window=eg.isActionWindow(pid),prompt=eg.player(pid).currentPrompt();let chosen;
            if(window){records.push({type:'state',step,state:fullState(eg,pid)});
                const terminalActivation=played&&((p.trigger==='whenPlayed'&&prompted.length>0)||['decline','empty','unique-departed'].includes(p.activationMode)||attackPicked);
                if(activated&&!settled&&terminalActivation){assertResolved();observe('focused-damage-resolved');settled=true;}
                if(!activated&&!settled&&pid===own.id){initialReady=ready();chosen=actions.find(a=>a.cardUuid===source.uuid);assert.ok(chosen,'Actual focus play');activated=true;}
                else if(played&&!settled&&preparation&&!prepared&&pid===own.id&&!preparationStarted){chosen=actions.find(a=>a.cardUuid===preparation.uuid);assert.ok(chosen,'Actual normal damage preparation event');preparationStarted=true;}
                else if(preparationPlayed&&!prepared){assert.equal(source.damage,source.cardData.hp-1);prepared=true;observe('actual-damage-preparation-resolved');chosen=actions.find(a=>a.arg==='pass');}
                else if(played&&!settled&&p.trigger==='onAttack'&&p.activationMode==='normal'&&prepared&&!attackStarted&&eg.round>initialRound&&pid===own.id){assert.ok(live(source)&&!source.exhausted,'Normally played source naturally readied');capture();chosen=actions.find(a=>a.cardUuid===source.uuid);assert.ok(chosen);attackStarted=true;}
                else if(!settled)chosen=actions.find(a=>a.arg==='pass');
            }else if(activated&&!settled){
                if(p.keepUnique&&/Choose which copy/i.test(prompt.menuTitle??'')){assert.equal(pid,own.id);const old=targets.at(-1),defeat=p.keepUnique==='old'?source:old;chosen=actions.find(a=>a.cardUuid===defeat.uuid);assert.ok(chosen);uniqueSeen=true;observe('unique-source-choice',pid,actions);}
                else if(played&&p.ambush&&!attackStarted&&actions.some(a=>a.label==='Trigger')&&actions.some(a=>a.label==='Pass')){assert.equal(pid,own.id);ambushSeen=true;assert.ok(source.exhausted);assert.equal(ready(),initialReady-expectedCost);const accept=p.activationMode==='ambush';chosen=actions.find(a=>a.label===(accept?'Trigger':'Pass'));assert.ok(chosen);ambushPassed=!accept;if(accept)attackStarted=true;observe('actual-ambush-'+(accept?'accept':'decline'),pid,actions);}
                else if(attackStarted&&!attackPicked&&/target for attack/i.test(prompt.menuTitle??'')){assert.equal(pid,own.id);capture();chosen=actions.find(a=>a.cardUuid===defender.uuid);assert.ok(chosen);attackPicked=true;observe('actual-attack-target',pid,actions);}
                else if(preparationStarted&&!preparationPlayed&&actions.some(a=>a.kind==='card')){assert.equal(pid,own.id);chosen=actions.find(a=>a.cardUuid===source.uuid);assert.ok(chosen,'Actual damage targets focus identity');observe('actual-damage-preparation-target',pid,actions);}
                else if((attackPicked||p.trigger==='whenPlayed')&&prompt.menuTitle===p.defaultPromptTitle){const i=descriptorIndex++,d=p.descriptors[i];assert.ok(d,'No unmodeled named descriptor');assert.equal(pid,own.id,'Source controls both named choices, including enemy recipient');capture();
                    const candidates=eg.game.getArenaUnits().filter(c=>eligible(c,d));assert.deepEqual(actions.filter(a=>a.kind==='card').map(a=>a.cardUuid).sort(),candidates.map(c=>c.uuid).sort());assert.deepEqual(actions.filter(a=>a.kind==='button').map(a=>a.label),[],'Mandatory paid unit registration cannot Pass/Cancel');
                    for(const [c,b]of baseline){assert.ok(live(c),'No primary handler/death before remaining named selectors');assert.equal(c.damage,b.damage);assert.equal(c.getHp(),b.hp);assert.deepEqual(c.upgrades.filter(u=>u.isShield?.()).map(cardId),b.shields);}
                    const choice=p.choices[i],card=choice==='source'?source:choice==='defender'?defender:choice?.startsWith('index:')?targets[Number(choice.slice(6))]:null;assert.ok(card&&candidates.includes(card),'Source-derived chosen recipient exists');chosen=actions.find(a=>a.cardUuid===card.uuid);assert.ok(chosen);selections.push({card,descriptor:d});prompted.push(i);observe('descriptor-'+(i+1),pid,actions);
                }else if(/Choose which player/i.test(prompt.menuTitle??'')){assert.equal(pid,own.id,'Effect/declaration original actor chooses owner ordering');chosen=actions.find(a=>a.label===(p.opponentFirst?'Opponent':'You'));assert.ok(chosen);observe('owner-priority',pid,actions);}
                chosen??=actions.find(a=>a.kind==='button'&&/trigger|resolve|play|yes/i.test(a.label??''));chosen??=actions.find(a=>a.arg==='done');
            }
            chosen??=bot.choose({game:eg,pid,actions,rng});assert.ok(chosen);records.push({type:'decision',step,actor:eg.seatOf(pid),prompt:{type:prompt.promptType??null,title:prompt.menuTitle??null,selected:(eg.player(pid).promptState.selectedCards??[]).map(cardId),actionWindow:window},actions:actions.map(a=>canonicalAction(eg,a)),chosen:canonicalAction(eg,chosen).key,events:[]});eg.apply(pid,chosen,rng);step++;
        }
        assert.ok(settled&&eg.over,'Focused source witness and complete terminal game');records.push({type:'result',step,winner:eg.winner,state:fullState(eg)});witness.coverageObligationIds=[...scenario.coverageObligationIds];return{records,witness};
    }finally{bot.close?.();}
}
