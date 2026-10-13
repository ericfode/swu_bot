"use strict";
const assert = require("node:assert/strict");
const { constructProbeFixture } = require("./probe-fixture");
const {
  fullState,
  canonicalAction,
  expandActions,
} = require("../../omni/rs/state");
function forceObject(player) {
  const rows = [
    ...player.baseZone.cards,
    ...player.outsideTheGameZone.getCards(),
  ].filter((c) => c.isForceToken());
  assert.equal(rows.length, 1);
  return rows[0];
}
async function fixture(env, pool, scenario, seed) {
  const p = scenario.probe;
  const { eg, rng, bot, deck, own, enemy, source, activation, targets } =
    await constructProbeFixture(env, pool, scenario, seed);
  const focus =
    p.enemyFocusIndex === undefined ? source : targets[p.enemyFocusIndex];
  const actor = focus.controller,
    other = actor === own ? enemy : own;
  const ownForce = forceObject(own),
    enemyForce = forceObject(enemy);
  if (p.held) ownForce.moveTo("base");
  if (p.enemyHeld) enemyForce.moveTo("base");
  own.base.damage = p.ownBaseDamage;
  enemy.base.damage = p.enemyBaseDamage;
  eg.game.resolveGameState(true);
  eg.game.continue();
  const forceIds = [eg.cardId(ownForce.uuid), eg.cardId(enemyForce.uuid)],
    round = eg.round;
  const initialCount = eg.game.state.allCards.length;
  const ready = (player) =>
    player.getCardsInZone("resource").filter((c) => !c.exhausted).length;
  function cost(card, player) {
    const available = [...player.getAspectsForCosts()];
    let n = card.cardData.cost;
    for (const a of card.cardData.aspects) {
      const i = available.indexOf(a);
      if (i < 0) n += 2;
      else available.splice(i, 1);
    }
    return n;
  }
  const initial = {
    ownReady: ready(own),
    enemyReady: ready(enemy),
    actorHeld: actor.hasTheForce,
    ownHeld: own.hasTheForce,
    enemyHeld: enemy.hasTheForce,
    actorCost: cost(focus, actor),
    deathCost: p.deathOnly ? cost(activation, own) : 0,
  };
  const oldUpgrade = p.uniqueReplacement
    ? targets[p.oldHostIndex].upgrades.find(
        (c) => c.cardData.id === focus.cardData.id,
      )
    : null;
  if (p.uniqueReplacement) assert.ok(oldUpgrade);
  const selectedBase = p.chooseEnemyBase ? enemy.base : own.base;
  const records = [
    {
      type: "meta",
      schema: "omni-rs-trace-v1",
      pool: pool.provenance,
      seed,
      bots: ["force-triggers-probe", "force-triggers-probe"],
      decks: [deck, deck],
      scenario: scenario.name,
      fixtureConstruction:
        "Stage disclosed real host/defender units, old unique upgrade if specified, native Force identities, resources and wounds. Focus play/attachment/uniqueness/optional use/healing or natural-ready attack/actual source defeat and full terminal result are normal recorded inputs.",
      constructionParameters: p,
    },
  ];
  const witness = {
    observations: [],
    gains: [],
    uses: [],
    heals: [],
    attacks: [],
    coverageObligationIds: [],
  };
  let started = false,
    played = false,
    settled = false,
    attackStarted = false,
    attackPicked = false;
  let deathStarted = false,
    dead = false,
    attached = false,
    cancelled = false,
    optional = false,
    selected = false;
  let sourcePlayChecked = false;
  let uniqueChosen = false,
    step = 0;
  eg.game.on("onCardPlayed", (e) => {
    if (!settled && started && !e.isCancelledOrReplaced && e.card === focus)
      played = true;
  });
  eg.game.on("onCardDefeated", (e) => {
    if (!settled && e.card === focus) dead = true;
  });
  eg.game.on("onTokensCreated", (e) => {
    if (!settled && e.tokenType === "the-force")
      witness.gains.push({
        owner: eg.seatOf(e.player.id),
        ids: e.generatedTokens.map((t) => eg.cardId(t.uuid)),
      });
  });
  eg.game.on("onForceUsed", (e) => {
    if (!settled) witness.uses.push({ owner: eg.seatOf(e.player.id) });
  });
  eg.game.on("onDamageHealed", (e) => {
    if (!settled && e.context?.source === focus)
      witness.heals.push({
        id: eg.cardId(e.card.uuid),
        amount: e.damageHealed,
      });
  });
  eg.game.on("onAttackDeclared", (e) => {
    if (!settled && e.attack.attacker === focus)
      witness.attacks.push({
        attacker: eg.cardId(focus.uuid),
        defender: eg.cardId(e.attack.getSingleTarget().uuid),
      });
  });
  eg.game.on("onDamageDealt", (e) => {
    if (!settled && attackStarted)
      assert.equal(
        actor.hasTheForce,
        true,
        "OnAttack gain precedes actual combat damage and lethal source movement",
      );
  });
  function identity() {
    assert.deepEqual(
      [eg.cardId(ownForce.uuid), eg.cardId(enemyForce.uuid)],
      forceIds,
    );
    assert.equal(
      eg.game.state.allCards.length,
      initialCount,
      "Force gain/use never allocates or replaces an identity",
    );
    const state = fullState(eg);
    assert.equal(state.forceStateVersion, 1);
    assert.deepEqual(state.players.p1.forceToken, {
      id: forceIds[0],
      held: own.hasTheForce,
    });
    assert.deepEqual(state.players.p2.forceToken, {
      id: forceIds[1],
      held: enemy.hasTheForce,
    });
  }
  function observe(stage, pid, actions) {
    identity();
    witness.observations.push({
      stage,
      actor: pid ? eg.seatOf(pid) : undefined,
      actions: actions?.map((a) => canonicalAction(eg, a)),
      state: fullState(eg),
    });
  }
  function assertGainOutcome() {
    identity();
    assert.ok(sourcePlayChecked);
    if (p.deathOnly) {
      assert.equal(
        ready(own),
        initial.ownReady -
          (actor === own ? initial.actorCost : 0) -
          initial.deathCost,
      );
    }
    assert.equal(own.base.damage, p.ownBaseDamage);
    assert.equal(enemy.base.damage, p.enemyBaseDamage);
    assert.equal(actor.hasTheForce, true);
    assert.equal(
      other.hasTheForce,
      other === own ? initial.ownHeld : initial.enemyHeld,
    );
    assert.deepEqual(
      witness.gains,
      initial.actorHeld
        ? []
        : [
            {
              owner: eg.seatOf(actor.id),
              ids: [forceIds[actor === own ? 0 : 1]],
            },
          ],
    );
    assert.equal(witness.uses.length, 0);
    if (p.deathOnly || p.lethalAttack) {
      assert.ok(dead);
      assert.equal(focus.zoneName, "discard");
    } else {
      assert.ok(focus.isInPlay());
      assert.equal(focus.damage, targets[p.defenderIndex].cardData.power);
    }
    if (!p.deathOnly) {
      assert.deepEqual(witness.attacks, [
        {
          attacker: eg.cardId(focus.uuid),
          defender: eg.cardId(targets[p.defenderIndex].uuid),
        },
      ]);
      assert.ok(targets[p.defenderIndex].isInPlay());
      assert.equal(targets[p.defenderIndex].damage, focus.cardData.power);
    }
    observe("actual-attack-or-defeat-gain-settled");
    settled = true;
  }
  function assertUpgradeOutcome() {
    identity();
    assert.equal(focus.owner, own);
    assert.equal(
      focus.controller,
      own,
      "Enemy host does not change upgrade ability actor",
    );
    const used = !!p.held && !p.decline && !cancelled;
    assert.equal(own.hasTheForce, !!p.held && !used);
    assert.equal(enemy.hasTheForce, !!p.enemyHeld);
    assert.equal(optional, !!p.held && !cancelled);
    assert.deepEqual(witness.uses, used ? [{ owner: "p1" }] : []);
    const effective = [own.base, enemy.base].filter(
      (b) => (b === own.base ? p.ownBaseDamage : p.enemyBaseDamage) > 0,
    );
    assert.equal(
      selected,
      used && effective.length > 0,
      "Actual healing selection iff primary succeeded and a wounded base exists",
    );
    assert.equal(
      own.base.damage,
      p.ownBaseDamage -
        (used && selected && selectedBase === own.base
          ? Math.min(p.amount, p.ownBaseDamage)
          : 0),
    );
    assert.equal(
      enemy.base.damage,
      p.enemyBaseDamage -
        (used && selected && selectedBase === enemy.base
          ? Math.min(p.amount, p.enemyBaseDamage)
          : 0),
    );
    assert.deepEqual(
      witness.heals,
      used && selected
        ? [
            {
              id: eg.cardId(selectedBase.uuid),
              amount: Math.min(
                p.amount,
                selectedBase === own.base ? p.ownBaseDamage : p.enemyBaseDamage,
              ),
            },
          ]
        : [],
    );
    assert.equal(
      ready(own),
      initial.ownReady - (cancelled ? 0 : initial.actorCost),
    );
    if (cancelled) {
      assert.equal(focus.zoneName, "hand");
      assert.equal(attached, false);
    } else {
      assert.ok(attached);
      if (p.uniqueReplacement) {
        assert.equal(uniqueChosen, !p.autoUnique);
        assert.equal(
          focus.zoneName,
          p.keepOld ? "discard" : targets[p.hostIndex ?? 0].zoneName,
        );
        assert.equal(
          oldUpgrade.zoneName,
          p.keepOld ? targets[p.oldHostIndex].zoneName : "discard",
        );
        assert.equal(focus.isAttached(), !p.keepOld);
        if (!p.keepOld)
          assert.equal(focus.parentCard, targets[p.hostIndex ?? 0]);
      } else {
        assert.equal(focus.zoneName, targets[p.hostIndex ?? 0].zoneName);
        assert.ok(focus.isAttached());
        assert.equal(focus.parentCard, targets[p.hostIndex ?? 0]);
      }
    }
    for (let i = 0; i < targets.length; i++) {
      const host = targets[i];
      assert.ok(
        host.isInPlay(),
        "Every staged host survives selected/cancelled upgrade play",
      );
      const ownsNew =
        !cancelled &&
        (!p.uniqueReplacement || !p.keepOld) &&
        i === (p.hostIndex ?? 0);
      const ownsOld =
        !!p.uniqueReplacement &&
        (cancelled || p.keepOld) &&
        i === p.oldHostIndex;
      const n = Number(ownsNew) + Number(ownsOld);
      assert.equal(host.getPower(), host.cardData.power + n * p.upgradePower);
      assert.equal(host.getHp(), host.cardData.hp + n * p.upgradeHp);
      assert.equal(host.damage, 0);
      assert.deepEqual(
        host.upgrades.map((c) => c.uuid),
        ownsNew ? [focus.uuid] : ownsOld ? [oldUpgrade.uuid] : [],
      );
    }
    observe("actual-upgrade-use-heal-settled");
    settled = true;
  }
  try {
    while (!eg.over && step < 5000) {
      const pid = eg.ids.find((id) => eg.legalActions(id).length);
      assert.ok(pid);
      const actions = expandActions(eg, eg.legalActions(pid)),
        window = eg.isActionWindow(pid),
        prompt = eg.player(pid).currentPrompt();
      let chosen;
      if (window) {
        records.push({ type: "state", step, state: fullState(eg, pid) });
        if (
          !settled &&
          p.kind === "dual-gain" &&
          played &&
          !sourcePlayChecked
        ) {
          assert.equal(
            ready(actor),
            (actor === own ? initial.ownReady : initial.enemyReady) -
              initial.actorCost,
          );
          assert.equal(focus.exhausted, true);
          assert.equal(
            actor.hasTheForce,
            initial.actorHeld,
            "Gain is OnAttack/WhenDefeated, never WhenPlayed",
          );
          assert.deepEqual(witness.gains, []);
          assert.equal(focus.getPower(), focus.cardData.power);
          assert.equal(focus.getHp(), focus.cardData.hp);
          observe("actual-dual-gain-source-play-before-trigger");
          sourcePlayChecked = true;
        }
        if (!settled && p.kind === "upgrade-use-heal" && (played || cancelled))
          assertUpgradeOutcome();
        if (
          !settled &&
          p.kind === "dual-gain" &&
          (p.deathOnly ? dead : attackPicked)
        )
          assertGainOutcome();
        if (!settled && !started && pid === actor.id) {
          chosen = actions.find((a) => a.cardUuid === focus.uuid);
          assert.ok(chosen, "Actual full source play");
          started = true;
        } else if (
          !settled &&
          played &&
          p.kind === "dual-gain" &&
          p.deathOnly &&
          !deathStarted &&
          pid === own.id
        ) {
          chosen = actions.find((a) => a.cardUuid === activation.uuid);
          assert.ok(chosen);
          deathStarted = true;
        } else if (
          !settled &&
          played &&
          p.kind === "dual-gain" &&
          !p.deathOnly &&
          !attackStarted &&
          eg.round > round &&
          pid === actor.id
        ) {
          chosen = actions.find((a) => a.cardUuid === focus.uuid);
          assert.ok(chosen);
          attackStarted = true;
        } else if (!settled) chosen = actions.find((a) => a.arg === "pass");
      } else if (!settled && started) {
        if (
          p.kind === "dual-gain" &&
          attackStarted &&
          /target for attack/i.test(prompt.menuTitle ?? "")
        ) {
          assert.equal(pid, actor.id);
          chosen = actions.find(
            (a) => a.cardUuid === targets[p.defenderIndex].uuid,
          );
          assert.ok(chosen);
          attackPicked = true;
          observe("actual-attack-target", pid, actions);
        } else if (
          p.kind === "dual-gain" &&
          deathStarted &&
          !dead &&
          actions.some((a) => a.cardUuid === focus.uuid)
        ) {
          assert.equal(pid, own.id);
          chosen = actions.find((a) => a.cardUuid === focus.uuid);
        } else if (
          p.kind === "upgrade-use-heal" &&
          p.uniqueReplacement &&
          actions.some((a) => a.cardUuid === focus.uuid) &&
          actions.some((a) => a.cardUuid === oldUpgrade.uuid)
        ) {
          assert.equal(pid, own.id);
          assert.match(prompt.menuTitle, /Choose which copy.*to defeat/);
          chosen = actions.find(
            (a) => a.cardUuid === (p.keepOld ? focus.uuid : oldUpgrade.uuid),
          );
          assert.ok(chosen);
          uniqueChosen = true;
          observe("actual-unique-upgrade-choice", pid, actions);
        } else if (
          p.kind === "upgrade-use-heal" &&
          !attached &&
          !played &&
          actions.some((a) => a.cardUuid === targets[p.hostIndex ?? 0].uuid)
        ) {
          assert.equal(pid, own.id);
          assert.equal(
            ready(own),
            initial.ownReady,
            "Attachment selection occurs before printed cost",
          );
          const legal = targets.filter((c) => !c.hasSomeTrait(p.excludedTrait));
          assert.deepEqual(
            actions
              .filter((a) => a.kind === "card")
              .map((a) => a.cardUuid)
              .sort(),
            legal.map((c) => c.uuid).sort(),
          );
          observe("actual-nontrait-attachment-domain", pid, actions);
          chosen = p.cancel
            ? actions.find((a) => a.arg === "cancel")
            : actions.find(
                (a) => a.cardUuid === targets[p.hostIndex ?? 0].uuid,
              );
          assert.ok(chosen);
          cancelled = !!p.cancel;
          attached = !cancelled;
        } else if (
          p.kind === "upgrade-use-heal" &&
          actions.some((a) => a.label === "Pass")
        ) {
          assert.equal(pid, own.id);
          assert.deepEqual(
            actions.map((a) => a.label),
            ["Trigger", "Pass"],
          );
          optional = true;
          chosen = actions.find(
            (a) => a.label === (p.decline ? "Pass" : "Trigger"),
          );
          observe("optional-upgrade-use-force", pid, actions);
        } else if (
          p.kind === "upgrade-use-heal" &&
          actions.some((a) => a.cardUuid === selectedBase.uuid)
        ) {
          assert.equal(pid, own.id);
          assert.equal(
            own.hasTheForce,
            false,
            "Force spent before continuation selector",
          );
          assert.ok(!actions.some((a) => a.arg === "cancel"));
          const bases = [own.base, enemy.base].filter(
            (b) => (b === own.base ? p.ownBaseDamage : p.enemyBaseDamage) > 0,
          );
          assert.deepEqual(
            actions
              .filter((a) => a.kind === "card")
              .map((a) => a.cardUuid)
              .sort(),
            bases.map((b) => b.uuid).sort(),
          );
          chosen = actions.find((a) => a.cardUuid === selectedBase.uuid);
          assert.ok(chosen);
          selected = true;
          observe("actual-any-base-heal-selector", pid, actions);
        }
        chosen ??= actions.find(
          (a) =>
            a.kind === "button" && /trigger|resolve|yes/i.test(a.label ?? ""),
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
    assert.ok(settled);
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
module.exports = {
  fixture,
  dependencies: [
    "bot/cards/pipeline/force-trigger-probes.js",
    "bot/cards/pipeline/force-trigger-probe-fixture.js",
    "bot/cards/pipeline/force-probes.js",
    "bot/cards/pipeline/probe-fixture.js",
    "bot/env.js",
    "bot/omni/rs/state.js",
    "bot/players/index.js",
  ],
};
