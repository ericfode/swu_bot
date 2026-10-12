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
