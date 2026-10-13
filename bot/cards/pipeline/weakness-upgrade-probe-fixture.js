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
  assert.equal(p.family, "weakness-upgrade");
  const reversed = p.sourceSeat === 2;
  const construction = reversed
    ? {
        ...scenario,
        probe: {
          ...p,
          targets: [
            ...p.targets.map((t) => ({
              ...t,
              owner: t.owner === "self" ? "opponent" : "self",
            })),
            { code: p.cardId, owner: "opponent", zone: "hand" },
          ],
        },
      }
    : scenario;
  const setup = await constructProbeFixture(env, pool, construction, seed);
  const { eg, rng, bot, deck } = setup;
  const own = reversed ? setup.enemy : setup.own,
    enemy = reversed ? setup.own : setup.enemy;
  const targets = setup.targets.slice(),
    source = reversed ? targets.pop() : setup.source;
  for (const player of [own, enemy]) {
    const resources = player.getCardsInZone("resource");
    for (const c of resources.slice(p.resourceCount)) c.moveTo("deckBottom");
    assert.equal(
      player.getCardsInZone("resource").length,
      p.resourceCount,
      "Disclosed exact resource boundary",
    );
  }
  eg.game.resolveGameState(true);
  eg.game.continue();
  const live = (c) => c.isUnit?.() && c.isInPlay?.();
  const target = targets[p.selectedIndex];
  let initial = target
    ? {
        power: live(target) ? target.getPower() : target.cardData.power,
        hp: live(target) ? target.getHp() : target.cardData.hp,
        upgrades: live(target) ? [...target.upgrades] : [],
      }
    : null;
  let before = targets.map((c) => ({
    card: c,
    hp: c.getHp(),
    power: c.getPower(),
    upgrades: [...c.upgrades],
  }));
  const witness = {
    coverageObligationIds: [],
    observations: [],
    created: [],
    attached: [],
    defeated: [],
  };
  const records = [
    {
      type: "meta",
      schema: "omni-rs-trace-v1",
      pool: pool.provenance,
      seed,
      bots: ["weakness-probe", "weakness-probe"],
      decks: [deck, deck],
      scenario: scenario.name,
      fixtureConstruction:
        "Stage disclosed real quiet/token/deployed-leader recipients and native preexisting Weakness attachments/resources at first action window; normally play and attach the actual upgrade focus, then resolve its optional Weakness creation/attachment and resulting HP-collapse cleanup. Record all later decisions and terminal result.",
      constructionParameters: p,
    },
  ];
  const originalState = fullState(eg),
    initialNext = originalState.nextCardId;
  const ready = () =>
    own.getCardsInZone("resource").filter((c) => !c.exhausted).length;
  const initialReady = ready(),
    aspects = [...own.getAspectsForCosts()];
  let cost = source.cardData.cost;
  for (const aspect of source.cardData.aspects) {
    const i = aspects.indexOf(aspect);
    if (i < 0) cost += 2;
    else aspects.splice(i, 1);
  }
  let cancelled = false;
  let started = false,
    played = false;
  let selected = false,
    declined = false,
    settled = false,
    step = 0,
    attachedSource = false;
  const host = targets[p.hostIndex];
  const hostBefore = {
    power: host.getPower(),
    hp: host.getHp(),
    upgrades: [...host.upgrades],
  };
  const snapshot = () => {
    assert.equal(host.getPower(), Math.max(0, hostBefore.power + p.power));
    assert.equal(host.getHp(), hostBefore.hp + p.hp);
    assert.deepEqual(
      host.upgrades,
      [...hostBefore.upgrades, source],
      "Actual printed source upgrade appends before token",
    );
    initial = {
      power: target.getPower(),
      hp: target.getHp(),
      upgrades: [...target.upgrades],
    };
    before = targets.map((c) => ({
      card: c,
      hp: c.getHp(),
      power: c.getPower(),
      upgrades: [...c.upgrades],
    }));
  };
  eg.game.on("onCardPlayed", (e) => {
    if (started && !settled && !e.isCancelledOrReplaced && e.card === source)
      played = true;
  });
  eg.game.on("onCardDefeated", (e) => {
    if (!settled) {
      if (e.card === source || e.card === target)
        witness.defeated.push({
          id: eg.cardId(e.card.uuid),
          zone: e.card.zoneName,
        });
    }
  });
  eg.game.on("onTokensCreated", (e) => {
    if (settled || !started || e.context?.source !== source) return;
    for (const token of e.generatedTokens ?? []) {
      assert.equal(token.isWeakness(), true, "Actual native Weakness factory");
      assert.equal(
        token.owner,
        target.controller,
        "Token owner is recipient controller, not source controller",
      );
      assert.equal(token.cardData.upgradePower, -1);
      assert.equal(token.cardData.upgradeHp, -1);
      witness.created.push({
        id: eg.cardId(token.uuid),
        owner: eg.seatOf(token.owner.id),
        token,
      });
    }
  });
  eg.game.on("onUpgradeAttached", (e) => {
    if (
      settled ||
      e.context?.source !== source ||
      !e.upgradeCard?.isWeakness?.()
    )
      return;
    assert.equal(e.parentCard, target);
    assert.equal(e.upgradeCard.parentCard, target);
    assert.equal(e.upgradeCard.controller, target.controller);
    assert.equal(e.upgradeCard.owner, target.controller);
    witness.attached.push({
      id: eg.cardId(e.upgradeCard.uuid),
      parent: eg.cardId(target.uuid),
      order: target.upgrades.map((c) => eg.cardId(c.uuid)),
      hp: target.getHp(),
      power: target.getPower(),
    });
  });
  function observe(stage, pid, actions) {
    witness.observations.push({
      stage,
      actor: pid ? eg.seatOf(pid) : undefined,
      actions: actions?.map((a) => canonicalAction(eg, a)),
      sourceZone: source.zoneName,
      target: target
        ? {
            id: eg.cardId(target.uuid),
            zone: target.zoneName,
            ...(live(target) ? phaseStats(target) : {}),
          }
        : null,
      state: fullState(eg),
    });
  }
  function assertOutcome() {
    const effective = !p.decline && !cancelled;
    assert.equal(
      ready(),
      initialReady - (cancelled ? 0 : cost),
      "Exact printed/aspect payment",
    );
    assert.equal(
      fullState(eg).nextCardId,
      initialNext + (effective ? 1 : 0),
      "One actual Weakness identity or none",
    );
    if (cancelled) {
      assert.deepEqual(
        fullState(eg),
        originalState,
        "Ordinary attachment cancellation restores entire board",
      );
      observe("cancelled");
      settled = true;
      return;
    }
    assert.ok(
      attachedSource && source.parentCard === host,
      "Source normally attached before optional trigger",
    );
    assert.equal(
      witness.created.length,
      effective ? 1 : 0,
      "Exactly one actual token or none on decline/ineligible",
    );
    assert.equal(witness.attached.length, effective ? 1 : 0);
    for (const row of before) {
      if (row.card === target && effective) continue;
      assert.ok(live(row.card), "All unselected recipients remain live");
      if (live(row.card)) {
        assert.equal(row.card.getHp(), row.hp);
        assert.equal(row.card.getPower(), row.power);
        assert.deepEqual(row.card.upgrades, row.upgrades);
      }
    }
    if (effective) {
      assert.equal(selected, true);
      const receipt = witness.created[0],
        attached = witness.attached[0];
      assert.equal(
        attached.id,
        receipt.id,
        "Created identity retained through attachment",
      );
      assert.deepEqual(
        attached.order,
        [...initial.upgrades.map((c) => eg.cardId(c.uuid)), receipt.id],
        "Native token appended after prior attachments",
      );
      assert.equal(attached.hp, initial.hp - 1);
      assert.equal(
        attached.power,
        Math.max(0, initial.power - 1),
        "Negative power clamps at zero",
      );
      if (p.lethal) {
        assert.equal(
          live(target),
          false,
          "HP-collapse recipient remains defeated after negative upgrade cleanup",
        );
        assert.equal(
          target.zoneName,
          target.isToken()
            ? "outsideTheGame"
            : target.isLeader()
            ? "base"
            : "discard",
        );
        assert.equal(receipt.token.zoneName, "outsideTheGame");
        assert.ok(
          witness.defeated.some((d) => d.id === eg.cardId(target.uuid)),
        );
      } else {
        assert.equal(target.getHp(), initial.hp - 1);
        assert.equal(target.getPower(), Math.max(0, initial.power - 1));
        assert.equal(receipt.token.parentCard, target);
      }
    }
    if (p.decline)
      assert.ok(declined, "Optional source trigger explicitly declined");
    observe("resolved");
    settled = true;
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
        if (!settled && (played || cancelled)) {
          if (!attachedSource && !cancelled) {
            assert.equal(source.parentCard, host);
            attachedSource = true;
            snapshot();
          }
          assertOutcome();
        }
        if (!settled && !started && pid === own.id) {
          chosen = actions.find((a) => a.cardUuid === source.uuid);
          assert.ok(chosen, "Normally play actual focus");
          started = true;
        } else if (!settled) chosen = actions.find((a) => a.arg === "pass");
      } else if (!settled && started) {
        if (
          !attachedSource &&
          !played &&
          actions.some((a) => a.cardUuid === host.uuid)
        ) {
          assert.equal(pid, own.id);
          chosen = p.cancel
            ? actions.find((a) => a.label === "Cancel")
            : actions.find((a) => a.cardUuid === host.uuid);
          assert.ok(chosen);
          cancelled = !!p.cancel;
        } else if (played && !attachedSource) {
          assert.equal(source.parentCard, host);
          attachedSource = true;
          snapshot();
        }
        if (
          !chosen &&
          attachedSource &&
          actions.some((a) => a.kind === "card")
        ) {
          const expected = eg.game.getArenaUnits();
          assert.equal(pid, own.id);
          assert.deepEqual(
            actions
              .filter((a) => a.kind === "card")
              .map((a) => a.cardUuid)
              .sort(),
            expected.map((c) => c.uuid).sort(),
            "Exact any-owner live unit domain",
          );
          assert.deepEqual(
            actions.filter((a) => a.kind === "button").map((a) => a.label),
            ["Pass"],
            "Optional printed source offers Pass without Cancel",
          );
          observe("weakness-selector", pid, actions);
          if (p.decline) {
            chosen = actions.find((a) => a.label === "Pass");
            declined = true;
          } else {
            chosen = actions.find((a) => a.cardUuid === target.uuid);
            selected = true;
          }
          assert.ok(chosen);
        } else if (
          !chosen &&
          attachedSource &&
          actions.some((a) => a.label === "Pass")
        ) {
          observe("optional-trigger", pid, actions);
          assert.equal(pid, own.id);
          chosen = p.decline
            ? actions.find((a) => a.label === "Pass")
            : actions.find((a) => a.kind === "button" && a.label !== "Pass");
          declined = !!p.decline;
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
    assert.ok(settled, "Actual weakness source behavior settled");
    assert.ok(eg.over);
    records.push({
      type: "result",
      step,
      winner: eg.winner,
      state: fullState(eg),
    });
    witness.created = witness.created.map(({ token, ...row }) => row);
    witness.coverageObligationIds = [...scenario.coverageObligationIds];
    return { records, witness };
  } finally {
    bot.close?.();
  }
}
module.exports = {
  fixture,
  dependencies: [
    "bot/cards/pipeline/weakness-upgrade-probes.js",
    "bot/cards/pipeline/weakness-upgrade-probe-fixture.js",
    "bot/cards/pipeline/probe-fixture.js",
    "bot/env.js",
    "bot/omni/rs/state.js",
    "bot/players/index.js",
  ],
};
