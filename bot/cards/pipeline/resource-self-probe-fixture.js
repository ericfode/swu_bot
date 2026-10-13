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
      p.enemyFocusIndex === undefined ? source : targets[p.enemyFocusIndex],
    actor = focus.controller,
    other = actor === own ? enemy : own;
  const force = forceObject(own),
    enemyForce = forceObject(enemy);
  if (p.held) force.moveTo("base");
  if (p.enemyHeld) enemyForce.moveTo("base");
  const attachments = [];
  if (p.transferStagedAttachments) {
    for (const u of [...targets[0].upgrades]) {
      u.attachTo(focus);
      attachments.push(u);
    }
    assert.equal(targets[0].upgrades.length, 0);
    assert.equal(focus.upgrades.length, 3);
  }
  eg.game.resolveGameState(true);
  eg.game.continue();
  const round = eg.round,
    initialCount = eg.game.state.allCards.length,
    ids = [eg.cardId(force.uuid), eg.cardId(enemyForce.uuid)];
  const resources = (player) => player.getCardsInZone("resource");
  const ready = (player) =>
    resources(player).filter((c) => !c.exhausted).length;
  function cost(c, player) {
    const aspects = [...player.getAspectsForCosts()];
    let n = c.cardData.cost;
    for (const a of c.cardData.aspects) {
      const i = aspects.indexOf(a);
      if (i < 0) n += 2;
      else aspects.splice(i, 1);
    }
    return n;
  }
  const initial = {
    actorResources: resources(actor).map((c) => eg.cardId(c.uuid)),
    otherResources: resources(other).map((c) => eg.cardId(c.uuid)),
    ownReady: ready(own),
    enemyReady: ready(enemy),
    ownHeld: own.hasTheForce,
    enemyHeld: enemy.hasTheForce,
    actorHeld: actor.hasTheForce,
    focusCost: p.sourceInPlay ? 0 : cost(focus, actor),
    deathCost: p.kind === "event" ? 0 : cost(activation, own),
  };
  const sequence = p.repeat ? [focus, ...targets] : [focus];
  const records = [
    {
      type: "meta",
      schema: "omni-rs-trace-v1",
      pool: pool.provenance,
      seed,
      bots: ["resource-self-probe", "resource-self-probe"],
      decks: [deck, deck],
      scenario: scenario.name,
      fixtureConstruction:
        "Stage disclosed native Force identities/resources and optional wounded source with ordinary/native attachments at initial action window. All focus/event/death plays, source trigger choices, natural phase and full terminal result are normal recorded inputs.",
      constructionParameters: p,
    },
  ];
  const witness = {
    observations: [],
    played: [],
    resourced: [],
    uses: [],
    coverageObligationIds: [],
  };
  let index = 0,
    started = !!p.sourceInPlay,
    played = !!p.sourceInPlay,
    dead = false,
    deathStarted = false,
    optional = false,
    resolved = false,
    settled = false,
    step = 0;
  let paid = 0,
    sourcePlayChecked = !!p.sourceInPlay,
    waitingExpiry = false;
  const removedAttachmentIds = attachments.map((c) => eg.cardId(c.uuid));
  eg.game.on("onCardPlayed", (e) => {
    if (
      !settled &&
      started &&
      !e.isCancelledOrReplaced &&
      e.card === sequence[index]
    ) {
      played = true;
      paid += cost(e.card, actor);
      witness.played.push({
        id: eg.cardId(e.card.uuid),
        zone: e.card.zoneName,
      });
      if (p.kind === "event")
        assert.equal(
          e.card.zoneName,
          "discard",
          "Event identity is physically discarded before its resource ability",
        );
    }
  });
  eg.game.on("onCardDefeated", (e) => {
    if (!settled && e.card === focus) dead = true;
  });
  eg.game.on("onCardResourced", (e) => {
    if (!settled && sequence.includes(e.card))
      witness.resourced.push({
        id: eg.cardId(e.card.uuid),
        actor: eg.seatOf(e.context.player.id),
        zone: e.card.zoneName,
        exhausted: e.card.exhausted,
      });
  });
  eg.game.on("onForceUsed", (e) => {
    if (!settled)
      witness.uses.push({
        owner: eg.seatOf(e.player.id),
        sourceZone: focus.zoneName,
      });
  });
  function identity() {
    assert.deepEqual([eg.cardId(force.uuid), eg.cardId(enemyForce.uuid)], ids);
    assert.equal(eg.game.state.allCards.length, initialCount);
    const state = fullState(eg);
    assert.equal(state.forceStateVersion, 1);
    assert.deepEqual(state.players.p1.forceToken, {
      id: ids[0],
      held: own.hasTheForce,
    });
    assert.deepEqual(state.players.p2.forceToken, {
      id: ids[1],
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
  function checkAttachments() {
    for (const u of attachments) {
      assert.equal(u.zoneName, u.isToken() ? "outsideTheGame" : "discard");
      assert.equal(u.isAttached(), false);
      if (u.isToken())
        assert.ok(u.owner.outsideTheGameZone.getCards().includes(u));
      else assert.ok(u.owner.getCardsInZone("discard").includes(u));
      const state = fullState(eg),
        id = eg.cardId(u.uuid);
      for (const player of Object.values(state.players)) {
        const liveRows = [
          ...player.resources,
          ...player.ground,
          ...player.space,
        ];
        assert.ok(
          !liveRows.some(
            (c) => c.id === id || c.upgrades?.some((a) => a.id === id),
          ),
          "Cleaned attachment ID is absent from all exported live rows",
        );
      }
    }
    for (const t of targets) {
      if (
        t === focus ||
        p.repeat ||
        (p.enemyFocusIndex !== undefined && t === targets[p.enemyFocusIndex])
      )
        continue;
      assert.ok(t.isInPlay(), "Unselected staged construction unit survives");
      assert.equal(t.damage, 0);
      assert.equal(t.upgrades.length, 0);
    }
    if (attachments.length) assert.equal(new Set(removedAttachmentIds).size, 3);
  }
  function outcome() {
    identity();
    const accepted =
      p.kind === "event" ||
      (!p.decline && (p.kind !== "force-continuation" || initial.actorHeld));
    assert.equal(focus.owner, actor);
    assert.equal(focus.controller, actor);
    if (p.kind !== "event") {
      assert.ok(dead);
      assert.equal(
        optional,
        p.kind === "force-continuation" ? initial.actorHeld : true,
      );
      const used = p.kind === "force-continuation" && accepted;
      assert.equal(actor.hasTheForce, initial.actorHeld && !used);
      assert.equal(
        other.hasTheForce,
        other === own ? initial.ownHeld : initial.enemyHeld,
      );
      assert.deepEqual(
        witness.uses,
        used ? [{ owner: eg.seatOf(actor.id), sourceZone: "discard" }] : [],
      );
      assert.equal(
        ready(own),
        initial.ownReady -
          (actor === own ? initial.focusCost : 0) -
          initial.deathCost,
      );
      assert.equal(
        ready(enemy),
        initial.enemyReady - (actor === enemy ? initial.focusCost : 0),
      );
      checkAttachments();
    } else {
      assert.equal(
        ready(actor),
        (actor === own ? initial.ownReady : initial.enemyReady) - paid,
      );
      assert.equal(
        ready(other),
        other === own ? initial.ownReady : initial.enemyReady,
      );
      assert.equal(actor.hasTheForce, initial.actorHeld);
    }
    const expected = [
      ...initial.actorResources,
      ...(accepted
        ? sequence.slice(0, index + 1).map((c) => eg.cardId(c.uuid))
        : []),
    ];
    assert.deepEqual(
      resources(actor).map((c) => eg.cardId(c.uuid)),
      expected,
      "Append same original source identities exactly once in normal entry order",
    );
    assert.deepEqual(
      resources(other).map((c) => eg.cardId(c.uuid)),
      initial.otherResources,
    );
    assert.equal(focus.zoneName, accepted ? "resource" : "discard");
    if (accepted) {
      for (const c of sequence.slice(0, index + 1)) {
        assert.equal(c.zoneName, "resource");
        assert.equal(c.exhausted, true);
        const state = fullState(eg),
          player = state.players[eg.seatOf(actor.id)];
        const row = player.resources.find((r) => r.id === eg.cardId(c.uuid));
        assert.ok(row);
        assert.ok(!Object.hasOwn(row, "damage"));
        assert.ok(!Object.hasOwn(row, "upgrades"));
        assert.ok(
          ![...player.ground, ...player.space].some((r) => r.id === row.id),
        );

        assert.ok(!actor.getCardsInZone("hand").includes(c));
        assert.ok(!actor.getCardsInZone("discard").includes(c));
      }
      assert.deepEqual(
        witness.resourced.map((e) => ({
          id: e.id,
          actor: e.actor,
          zone: e.zone,
          exhausted: e.exhausted,
        })),
        sequence.slice(0, index + 1).map((c) => ({
          id: eg.cardId(c.uuid),
          actor: eg.seatOf(actor.id),
          zone: "resource",
          exhausted: true,
        })),
      );
    } else assert.deepEqual(witness.resourced, []);
    observe("same-source-resource-resolution-" + index);
    resolved = true;
    if (p.repeat && index + 1 < sequence.length) {
      index++;
      started = false;
      played = false;
      resolved = false;
      return;
    }
    if (p.waitForExpiry) waitingExpiry = true;
    else settled = true;
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
        if (!settled && p.kind !== "event" && played && !sourcePlayChecked) {
          assert.equal(
            ready(actor),
            (actor === own ? initial.ownReady : initial.enemyReady) -
              initial.focusCost,
          );
          assert.ok(focus.isInPlay());
          assert.equal(focus.exhausted, true);
          assert.equal(witness.resourced.length, 0);
          sourcePlayChecked = true;
          observe("source-play-before-death");
        }
        if (!settled && !resolved && (p.kind === "event" ? played : dead))
          outcome();
        if (!settled && waitingExpiry && eg.round > round) {
          assert.equal(focus.zoneName, "resource");
          assert.equal(focus.exhausted, false);
          observe("natural-phase-readies-existing-resource");
          settled = true;
        }
        if (!settled && !waitingExpiry && !started && pid === actor.id) {
          chosen = actions.find((a) => a.cardUuid === sequence[index].uuid);
          assert.ok(chosen);
          started = true;
        } else if (
          !settled &&
          !waitingExpiry &&
          p.kind !== "event" &&
          played &&
          !deathStarted &&
          pid === own.id
        ) {
          chosen = actions.find((a) => a.cardUuid === activation.uuid);
          assert.ok(chosen);
          deathStarted = true;
        } else if (!settled) chosen = actions.find((a) => a.arg === "pass");
      } else if (!settled) {
        if (
          p.kind !== "event" &&
          deathStarted &&
          !dead &&
          actions.some((a) => a.cardUuid === focus.uuid)
        ) {
          assert.equal(pid, own.id);
          chosen = actions.find((a) => a.cardUuid === focus.uuid);
        } else if (
          !waitingExpiry &&
          dead &&
          actions.some((a) => a.label === "Pass")
        ) {
          assert.equal(pid, actor.id);
          assert.deepEqual(
            actions.map((a) => a.label),
            ["Trigger", "Pass"],
          );
          optional = true;
          observe("captured-source-optional-resource", pid, actions);
          chosen = actions.find(
            (a) => a.label === (p.decline ? "Pass" : "Trigger"),
          );
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
    "bot/cards/pipeline/resource-self-probes.js",
    "bot/cards/pipeline/resource-self-probe-fixture.js",
    "bot/cards/pipeline/force-probes.js",
    "bot/cards/pipeline/probe-fixture.js",
    "bot/env.js",
    "bot/omni/rs/state.js",
    "bot/players/index.js",
  ],
};
