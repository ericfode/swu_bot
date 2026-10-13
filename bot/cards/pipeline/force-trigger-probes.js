"use strict";
const { nativeForce } = require("./force-probes");
const stable = (v) =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === "object"
    ? Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, stable(v[k])]),
      )
    : v;
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const keys = (v, allowed) =>
  v && Object.keys(v).every((k) => allowed.includes(k));
function plain(entry) {
  return (
    entry?.status === "supported" &&
    !!entry.card &&
    Array.isArray(entry.card.types) &&
    !entry.card?.pilotText &&
    !entry.card?.pilotBox &&
    !entry.card?.pilotingBox &&
    !entry.piloting &&
    !entry.card?.deployBox &&
    !entry.card?.epicAction &&
    !Object.keys(entry.keywordValues ?? {}).length &&
    !entry.card?.keywords?.length
  );
}
function classifyForceTriggers(entry) {
  const all = Object.values(entry.abilities ?? {}).flat();
  if (!plain(entry) || all.length !== entry.abilities.card?.length) return null;
  if (
    same(entry.card.types, ["unit"]) &&
    entry.baseClass === "NonLeaderUnitCard" &&
    ["ground", "space"].includes(entry.card.arena) &&
    !entry.attachCondition &&
    all.length === 2 &&
    same(all.map((a) => a.trigger).sort(), ["onAttack", "whenDefeated"]) &&
    all.every(
      (a) =>
        keys(a, ["trigger", "title", "costs", "effect"]) &&
        typeof a.title === "string" &&
        same(a.costs, []) &&
        same(a.effect, { kind: "gainForce", target: "ownPlayer" }),
    )
  ) {
    return {
      family: "force-triggers",
      kind: "dual-gain",
      sourceArena: entry.card.arena,
    };
  }
  const a = all[0],
    condition = entry.attachCondition;
  if (
    same(entry.card.types, ["upgrade"]) &&
    entry.baseClass === "UpgradeCard" &&
    all.length === 1 &&
    typeof entry.card.unique === "boolean" &&
    Number.isInteger(entry.card.upgradePower) &&
    entry.card.upgradePower >= 0 &&
    entry.card.upgradePower <= 8 &&
    Number.isInteger(entry.card.upgradeHp) &&
    entry.card.upgradeHp >= 0 &&
    entry.card.upgradeHp <= 8 &&
    entry.card.power === entry.card.upgradePower &&
    entry.card.hp === entry.card.upgradeHp &&
    keys(condition, ["kind", "op", "value"]) &&
    condition.kind === "unary" &&
    condition.op === "!" &&
    keys(condition.value, ["kind", "name", "receiver", "args"]) &&
    condition.value.kind === "query" &&
    condition.value.name === "hasSomeTrait" &&
    same(condition.value.receiver, { kind: "ref", path: ["card"] }) &&
    condition.value.args?.length === 1 &&
    keys(condition.value.args[0], ["kind", "value"]) &&
    condition.value.args[0].kind === "const" &&
    typeof condition.value.args[0].value === "string" &&
    keys(a, ["trigger", "title", "costs", "optional", "effect", "ifYouDo"]) &&
    a.trigger === "whenPlayed" &&
    typeof a.title === "string" &&
    a.optional === true &&
    same(a.costs, []) &&
    same(a.effect, { kind: "useForce", target: "ownPlayer" }) &&
    keys(a.ifYouDo, ["title", "costs", "targetResolver", "effect"]) &&
    typeof a.ifYouDo.title === "string" &&
    same(a.ifYouDo.costs, []) &&
    same(a.ifYouDo.targetResolver, {
      owner: "any",
      type: "any",
      zone: "base",
    }) &&
    keys(a.ifYouDo.effect, ["kind", "target", "amount"]) &&
    a.ifYouDo.effect.kind === "heal" &&
    a.ifYouDo.effect.target === "chosen" &&
    keys(a.ifYouDo.effect.amount, ["kind", "value"]) &&
    a.ifYouDo.effect.amount.kind === "const" &&
    Number.isInteger(a.ifYouDo.effect.amount.value) &&
    a.ifYouDo.effect.amount.value > 0 &&
    a.ifYouDo.effect.amount.value <= 8
  ) {
    return {
      family: "force-triggers",
      kind: "upgrade-use-heal",
      amount: a.ifYouDo.effect.amount.value,
      excludedTrait: condition.value.args[0].value,
      upgradePower: entry.card.upgradePower,
      upgradeHp: entry.card.upgradeHp,
      unique: entry.card.unique,
    };
  }
  return null;
}
function planForceTriggerProbes(entry, options = {}) {
  const shape = classifyForceTriggers(entry);
  if (!shape) return null;
  const defs = Array.isArray(options.catalogue)
    ? options.catalogue
    : options.catalogue?.cards ?? [];
  const result = {
    schema: "swu-card-probes/v1",
    cardId: entry.setCode,
    sourceHash: entry.sourceHash,
    cases: [],
    obligations: [],
    uncovered: [],
  };
  function obligation(name, reason) {
    const id = entry.setCode + ":force-triggers:" + name;
    result.obligations.push({ id, path: "force-triggers", dimension: name });
    if (reason) result.uncovered.push({ id, path: "force-triggers", reason });
    return id;
  }
  const quiet = defs
    .filter(
      (e) =>
        plain(e) &&
        same(e.card.types, ["unit"]) &&
        !e.card.unique &&
        !Object.values(e.abilities ?? {}).flat().length &&
        (e.baseClass === "NonLeaderUnitCard" || (!e.baseClass && !e.card.text)),
    )
    .sort((a, b) => a.setCode.localeCompare(b.setCode));
  const token = defs.find(nativeForce);
  const row = (e, owner, extra = {}) => ({
    code: e.setCode,
    owner,
    arena: e.card.arena,
    exhausted: false,
    damage: 0,
    ...extra,
  });
  function add(name, targets, extra = {}) {
    const id = obligation(name);
    const probe = {
      ...shape,
      cardId: entry.setCode,
      targets,
      held: false,
      enemyHeld: false,
      initiative: "self",
      resourceCount: 32,
      ownBaseDamage: 5,
      enemyBaseDamage: 4,
      ...extra,
    };
    result.cases.push({
      id: `auto/${entry.setCode}/force-triggers-${name}`,
      name: "force-triggers-" + name,
      kind: "probe",
      focusCardIds: [entry.setCode],
      setupCardIds: [
        ...new Set([
          token.setCode,
          ...targets.map((t) => t.code),
          ...targets.flatMap((t) => (t.attachments ?? []).map((a) => a.code)),
          ...(probe.activationCode ? [probe.activationCode] : []),
        ]),
      ].sort(),
      behaviorIds: ["force-triggers", shape.kind],
      assertionStages: ["construction", "activation", "observation"],
      coverageObligationIds: [id],
      probe,
    });
  }
  if (!token) {
    obligation("reviewed-native", "Missing reviewed native Force");
    return result;
  }
  if (shape.kind === "dual-gain") {
    const survive = quiet.find(
      (e) =>
        e.card.arena === shape.sourceArena &&
        e.card.hp > entry.card.power &&
        e.card.power < entry.card.hp,
    );
    const lethal = quiet.find(
      (e) =>
        e.card.arena === shape.sourceArena &&
        e.card.hp > entry.card.power &&
        e.card.power >= entry.card.hp,
    );
    const defeat = defs.find(
      (e) =>
        plain(e) &&
        e.baseClass === "EventCard" &&
        same(e.card.types, ["event"]) &&
        Object.values(e.abilities ?? {}).flat().length === 1 &&
        e.abilities.card?.length === 1 &&
        keys(e.abilities.card[0], [
          "trigger",
          "title",
          "costs",
          "targetResolver",
          "effect",
        ]) &&
        e.abilities.card[0].trigger === "event" &&
        same(e.abilities.card[0].costs, []) &&
        same(e.abilities.card[0].effect, {
          kind: "defeat",
          target: "chosen",
        }) &&
        same(e.abilities.card[0].targetResolver, {
          owner: "any",
          type: "unit",
          zone: "anyAttackable",
        }),
    );
    if (!survive || !lethal || !defeat) {
      obligation(
        "metadata-donors",
        "Missing quiet surviving/lethal combat or direct defeat donor",
      );
      return result;
    }
    for (const actor of ["self", "opponent"]) {
      const other = actor === "self" ? "opponent" : "self";
      const enemyFocus =
        actor === "opponent" ? [row(entry, "opponent", { zone: "hand" })] : [];
      const offset = enemyFocus.length;
      for (const held of [false, true]) {
        const force =
          actor === "self"
            ? { held, enemyHeld: true }
            : { held: true, enemyHeld: held };
        add(
          actor + "-attack-" + (held ? "already-held" : "gain"),
          [...enemyFocus, row(survive, other)],
          {
            actor,
            ...force,
            defenderIndex: offset,
            enemyFocusIndex: actor === "opponent" ? 0 : undefined,
          },
        );
        add(
          actor + "-defeat-" + (held ? "already-held" : "gain"),
          [...enemyFocus],
          {
            actor,
            ...force,
            deathOnly: true,
            activationCode: defeat.setCode,
            enemyFocusIndex: actor === "opponent" ? 0 : undefined,
          },
        );
      }
      add(
        actor + "-lethal-attack-captured-defeat",
        [...enemyFocus, row(lethal, other)],
        {
          actor,
          held: actor === "opponent",
          enemyHeld: actor === "self",
          lethalAttack: true,
          defenderIndex: offset,
          enemyFocusIndex: actor === "opponent" ? 0 : undefined,
        },
      );
    }
  } else {
    const legal = (arena) =>
      quiet.find(
        (e) =>
          e.card.arena === arena &&
          !e.card.traits.includes(shape.excludedTrait) &&
          e.card.hp >= 4,
      );
    const forbidden = (arena) =>
      quiet.find(
        (e) =>
          e.card.arena === arena && e.card.traits.includes(shape.excludedTrait),
      );
    const ground = legal("ground"),
      space = legal("space"),
      badGround = forbidden("ground"),
      badSpace = forbidden("space");
    if (!ground || !space || !badGround || !badSpace) {
      obligation(
        "metadata-donors",
        "Missing both-arena legal and forbidden trait hosts",
      );
      return result;
    }
    const mixed = [
      row(ground, "self"),
      row(space, "self"),
      row(ground, "opponent"),
      row(space, "opponent"),
      row(badGround, "self"),
      row(badSpace, "opponent"),
    ];
    add("own-host-own-base-heal", mixed, { held: true });
    add("enemy-host-own-controller-force", mixed, {
      held: true,
      enemyHeld: true,
      hostIndex: 2,
    });
    add("space-host-own-base-heal", mixed, { held: true, hostIndex: 1 });
    add("enemy-space-host-enemy-base-heal", mixed, {
      held: true,
      hostIndex: 3,
      chooseEnemyBase: true,
    });
    add("partial-heal-leaves-one", mixed, {
      held: true,
      ownBaseDamage: shape.amount + 1,
    });
    add("capped-heal-one", mixed, { held: true, ownBaseDamage: 1 });
    add("absent-own-enemy-held", mixed, { enemyHeld: true });
    add("absent-both", mixed);
    add("optional-decline", mixed, { held: true, decline: true });
    add("held-both-bases-full", mixed, {
      held: true,
      ownBaseDamage: 0,
      enemyBaseDamage: 0,
    });
    add("cancel-attachment-before-payment", mixed, {
      held: true,
      cancel: true,
    });
    if (shape.unique) {
      for (const sameHost of [false, true])
        for (const keepOld of sameHost ? [false] : [false, true]) {
          const targets = structuredClone(mixed);
          targets[0].attachments = [{ code: entry.setCode, owner: "self" }];
          add(
            "unique-" +
              (sameHost ? "same" : "different") +
              "-host-keep-" +
              (keepOld ? "old" : "new"),
            targets,
            {
              held: true,
              uniqueReplacement: true,
              hostIndex: sameHost ? 0 : 2,
              oldHostIndex: 0,
              keepOld,
              autoUnique: sameHost,
            },
          );
        }
    }
  }
  for (const name of [
    "source-review",
    "pending-trigger-owner-order",
    "token-leader-hosts",
    "gain-replacement",
    "recipient-reentry",
    "control-transfer",
    "native-hook-reactions",
    "force-change-stat-death",
  ]) {
    obligation(
      name,
      "No actual source-card construction for this dimension; separate diagnostics are not full-card witnesses",
    );
  }
  return result;
}
module.exports = { classifyForceTriggers, planForceTriggerProbes };
