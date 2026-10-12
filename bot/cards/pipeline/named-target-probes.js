"use strict";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (a, allowed) =>
  a && Object.keys(a).every((k) => allowed.includes(k));
function classifyNamedTarget(entry) {
  const abilities = Object.values(entry.abilities ?? {}).flat();
  const a = abilities[0];
  const event = same(entry.card?.types, ["event"]);
  const unit = same(entry.card?.types, ["unit"]);
  if (
    entry.status !== "supported" ||
    !(event || unit) ||
    entry.baseClass !== (event ? "EventCard" : "NonLeaderUnitCard") ||
    abilities.length !== 1 ||
    entry.abilities.card?.length !== 1 ||
    !keys(a, ["trigger", "title", "costs", "effect", "targetResolvers"]) ||
    !same(a.costs, []) ||
    !same(a.effect, { kind: "noAction" }) ||
    !(event
      ? a.trigger === "event"
      : ["whenPlayed", "onAttack"].includes(a.trigger)) ||
    Object.keys(entry.keywordValues ?? {}).length ||
    entry.card.keywords?.length ||
    entry.card.pilotText ||
    entry.card.pilotBox ||
    entry.card.pilotingBox ||
    entry.piloting ||
    !Array.isArray(a.targetResolvers) ||
    a.targetResolvers.length !== 2
  )
    return null;
  const descriptors = [];
  for (const d of a.targetResolvers) {
    const r = d?.targetResolver,
      e = d?.effect;
    if (
      !keys(d, ["name", "chooser", "targetResolver", "effect"]) ||
      typeof d.name !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(d.name) ||
      ["target", "constructor", "prototype", "__proto__"].includes(d.name) ||
      d.chooser !== "self" ||
      !keys(r, [
        "owner",
        "type",
        "zone",
        "arena",
        "optional",
        "predicate",
        "promptTitle",
      ]) ||
      r.owner !== "any" ||
      r.type !== "unit" ||
      !(
        r.optional === true ||
        (a.trigger === "onAttack" &&
          descriptors.length === 0 &&
          r.optional === undefined)
      ) ||
      !["arena", "anyAttackable"].includes(r.zone) ||
      typeof r.promptTitle !== "string" ||
      (r.arena !== undefined && !["ground", "space"].includes(r.arena))
    )
      return null;
    let trait;
    if (r.predicate !== undefined) {
      if (a.trigger === "onAttack") return null;
      const q = r.predicate;
      if (
        !keys(q, ["kind", "name", "receiver", "args"]) ||
        q.kind !== "query" ||
        q.name !== "hasSomeTrait" ||
        !same(q.receiver, { kind: "ref", path: ["card"] }) ||
        !Array.isArray(q.args) ||
        q.args.length !== 1 ||
        !keys(q.args[0], ["kind", "value"]) ||
        q.args[0].kind !== "const" ||
        typeof q.args[0].value !== "string" ||
        !q.args[0].value
      )
        return null;
      trait = q.args[0].value;
    }
    if (
      !keys(e, ["kind", "target", "duration", "power", "hp"]) ||
      e.kind !== "modifyStats" ||
      e.target !== "chosen" ||
      e.duration !== "phase"
    )
      return null;
    function literal(amount) {
      if (
        keys(amount, ["kind", "value"]) &&
        amount.kind === "const" &&
        Number.isInteger(amount.value)
      )
        return amount.value;
      if (
        a.trigger === "onAttack" &&
        keys(amount, ["kind", "op", "value"]) &&
        amount.kind === "unary" &&
        amount.op === "-" &&
        keys(amount.value, ["kind", "value"]) &&
        amount.value.kind === "const" &&
        Number.isInteger(amount.value.value) &&
        amount.value.value >= 0
      ) {
        return -amount.value.value;
      }
      return undefined;
    }
    const power = literal(e.power),
      hp = literal(e.hp);
    if (
      [power, hp].some(
        (n) =>
          n === undefined ||
          Math.abs(n) > 127 ||
          (a.trigger !== "onAttack" && n < 1),
      )
    )
      return null;
    const descriptor = {
      name: d.name,
      promptTitle: r.promptTitle,
      arena: r.arena,
      trait,
      power,
      hp,
    };
    if (a.trigger === "onAttack") descriptor.optional = r.optional === true;
    descriptors.push(descriptor);
  }
  if (descriptors[0].name === descriptors[1].name) return null;
  if (
    a.trigger === "onAttack" &&
    (!["ground", "space"].includes(entry.card.arena) || entry.attachCondition)
  )
    return null;
  if (a.trigger === "onAttack") {
    const [first, second] = descriptors;
    const opposing =
      !first.optional &&
      second.optional &&
      !first.arena &&
      !second.arena &&
      first.power > 0 &&
      first.hp > 0 &&
      second.power === -first.power &&
      second.hp === -first.hp;
    const arenaSplit =
      first.optional &&
      second.optional &&
      entry.card.arena === "space" &&
      first.arena === "space" &&
      second.arena === "ground" &&
      first.power < 0 &&
      first.hp === 0 &&
      second.power > 0 &&
      second.hp === 0;
    if (!(opposing || arenaSplit)) return null;
  }
  return { family: "named-target", trigger: a.trigger, descriptors };
}
function planNamedTargetProbes(entry, options = {}) {
  const shape = classifyNamedTarget(entry);
  if (!shape) return null;
  if (shape.trigger === "onAttack") return planAttack(entry, shape, options);
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
  const obligation = (dimension, reason) => {
    const id = entry.setCode + ":named-target:" + dimension;
    result.obligations.push({ id, path: "named-target", dimension });
    if (reason) result.uncovered.push({ id, path: "named-target", reason });
    return id;
  };
  const matches = (e, d) =>
    (!d.arena || e.card.arena === d.arena) &&
    (!d.trait || e.card.traits?.includes(d.trait));
  const quiet = defs
    .filter(
      (e) =>
        e.status === "supported" &&
        same(e.card.types, ["unit"]) &&
        !e.card.unique &&
        !Object.values(e.abilities ?? {}).flat().length &&
        !Object.keys(e.keywordValues ?? {}).length,
    )
    .sort((a, b) => a.setCode.localeCompare(b.setCode));
  const donors = [];
  for (const d of shape.descriptors) {
    donors.push(
      quiet.find(
        (e) =>
          matches(e, d) &&
          !donors.some((prior) => prior?.setCode === e.setCode),
      ),
    );
  }
  if (donors.some((e) => !e)) {
    obligation("metadata-donors", "No quiet eligible unit for each descriptor");
    return result;
  }
  const row = (e, owner) => ({
    code: e.setCode,
    owner,
    arena: e.card.arena,
    exhausted: false,
    damage: 0,
  });
  const mixed = donors.flatMap((e) => [row(e, "self"), row(e, "opponent")]);
  const negative = quiet.find((e) =>
    shape.descriptors.every((d) => !matches(e, d)),
  );
  if (negative) mixed.push(row(negative, "opponent"));
  function add(name, targets, choices, extra = {}) {
    const id = obligation(name);
    result.cases.push({
      id: `auto/${entry.setCode}/named-target-${name}`,
      name: "named-target-" + name,
      kind: "probe",
      focusCardIds: [entry.setCode],
      setupCardIds: [...new Set(targets.map((t) => t.code))].sort(),
      behaviorIds: ["named-targets", "phase-stats", "optional-selection"],
      assertionStages: ["construction", "activation", "observation"],
      coverageObligationIds: [id],
      probe: {
        ...shape,
        cardId: entry.setCode,
        sourceTypes: entry.card.types,
        sourceArena: entry.card.arena,
        targets,
        choices,
        initiative: "self",
        resourceCount: 20,
        ...extra,
      },
    });
  }
  add("both-enemy-selections", mixed, ["enemy", "enemy"]);
  add("both-own-selections", mixed, ["own", "own"]);
  add("decline-first", mixed, ["decline", "enemy"]);
  add("decline-second", mixed, ["enemy", "decline"]);
  add("decline-both", mixed, ["decline", "decline"]);
  add("phase-expiry", mixed, ["enemy", "enemy"], { waitForExpiry: true });
  for (let missing = 0; missing < 2; missing++) {
    const targets = mixed.filter(
      (t) =>
        !matches(
          defs.find((e) => e.setCode === t.code),
          shape.descriptors[missing],
        ),
    );
    const sourceMatches =
      shape.trigger === "whenPlayed" &&
      matches(entry, shape.descriptors[missing]);
    add(
      sourceMatches
        ? "missing-staged-" + (missing + 1) + "-entering-source"
        : "missing-" + (missing + 1),
      targets,
      sourceMatches ? ["enemy", "source"] : ["enemy", "enemy"],
    );
  }
  if (shape.trigger === "event") {
    add("cancel-first", mixed, ["cancel", "enemy"]);
    add("cancel-second", mixed, ["enemy", "cancel"]);
    add("empty-play-anyway", [], ["decline", "decline"], { empty: true });
    add("empty-cancel", [], ["decline", "decline"], {
      empty: true,
      cancelEmpty: true,
    });
  } else {
    add("entering-source-self-selection", [], ["decline", "source"]);
  }
  for (const dimension of [
    "source-review",
    "unique-source-departure",
    "recipient-reentry",
    "same-recipient-overlapping-traits",
    "phase-expiry-lethal-window",
    "token-and-deployed-leader",
  ]) {
    obligation(
      dimension,
      "No actual source-card construction for this dimension; raw primitive diagnostics are not full-card witnesses",
    );
  }
  return result;
}
function planAttack(entry, shape, options) {
  const defs = Array.isArray(options.catalogue)
    ? options.catalogue
    : options.catalogue?.cards ?? [];
  const quiet = defs
    .filter(
      (e) =>
        e.status === "supported" &&
        (!e.baseClass || e.baseClass === "NonLeaderUnitCard") &&
        same(e.card.types, ["unit"]) &&
        ["ground", "space"].includes(e.card.arena) &&
        !e.card.unique &&
        !e.card.keywords?.length &&
        !e.card.pilotText &&
        !e.card.pilotBox &&
        !e.card.pilotingBox &&
        !e.piloting &&
        !e.attachCondition &&
        !Object.values(e.abilities ?? {}).flat().length &&
        !Object.keys(e.keywordValues ?? {}).length,
    )
    .sort((a, b) => a.setCode.localeCompare(b.setCode));
  const result = {
    schema: "swu-card-probes/v1",
    cardId: entry.setCode,
    sourceHash: entry.sourceHash,
    cases: [],
    obligations: [],
    uncovered: [],
  };
  function obligation(name, reason) {
    const id = `${entry.setCode}:named-target:${name}`;
    result.obligations.push({ id, path: "named-target", dimension: name });
    if (reason) result.uncovered.push({ id, path: "named-target", reason });
    return id;
  }
  const ground = quiet.find(
    (e) => e.card.arena === "ground" && e.card.hp >= 4 && e.card.power <= 2,
  );
  const space = quiet.find(
    (e) => e.card.arena === "space" && e.card.hp >= 3 && e.card.power <= 2,
  );
  if (!ground || !space) {
    obligation("quiet-donors", "No bounded quiet real unit in both arenas");
    return result;
  }
  const row = (e, owner, damage = 0) => ({
    code: e.setCode,
    owner,
    arena: e.card.arena,
    exhausted: false,
    damage,
  });
  const mixed = [
    row(ground, "self"),
    row(ground, "opponent"),
    row(space, "self"),
    row(space, "opponent"),
  ];
  const defender = entry.card.arena === "ground" ? 1 : 3;
  function add(name, choices, extra = {}, targets = mixed) {
    const id = obligation(name);
    result.cases.push({
      id: `auto/${entry.setCode}/named-target-attack-${name}`,
      name: `named-target-attack-${name}`,
      kind: "probe",
      focusCardIds: [entry.setCode],
      setupCardIds: [
        ...new Set([
          ...targets.map((t) => t.code),
          ...(extra.expectDeathForce ? ["TOKEN_THE_FORCE"] : []),
          ...(extra.expectClone ? ["TOKEN_CLONE_TROOPER"] : []),
        ]),
      ].sort(),
      behaviorIds: ["named-targets", "on-attack", "phase-stats"],
      assertionStages: ["construction", "activation", "observation"],
      coverageObligationIds: [id],
      probe: {
        ...shape,
        cardId: entry.setCode,
        sourceTypes: entry.card.types,
        sourceArena: entry.card.arena,
        targets,
        choices,
        attackTarget: defender,
        initiative: "self",
        resourceCount: 32,
        ...extra,
      },
    });
  }
  add("both-own", ["own", "own"]);
  add("both-enemy", ["enemy", "enemy"]);
  add("decline-second", ["enemy", "decline"]);
  add("source-recipient", ["source", "decline"]);
  add("defender-recipient", ["defender", "decline"]);
  add("phase-expiry", ["enemy", "enemy"], { waitForExpiry: true });
  if (shape.descriptors[0].optional) {
    add("decline-first", ["decline", "own"]);
    add("decline-both", ["decline", "decline"]);
    const clamp = quiet.find(
      (e) =>
        e.card.arena === "space" &&
        e.card.power > 0 &&
        e.card.power < Math.abs(shape.descriptors[0].power) &&
        e.card.hp > entry.card.power,
    );
    if (clamp)
      add("negative-power-clamp", ["index:2", "decline"], {}, [
        row(ground, "self"),
        row(ground, "opponent"),
        row(clamp, "self"),
        row(space, "opponent"),
      ]);
    else
      obligation(
        "negative-power-clamp",
        "No bounded quiet low-power space donor",
      );
    add("no-ground-recipient", ["enemy", "decline"], { attackTarget: 1 }, [
      row(space, "self"),
      row(space, "opponent"),
    ]);
  } else {
    add("same-recipient-net-zero", ["index:0", "index:0"]);
    const hpOne = quiet.find(
      (e) => e.card.arena === entry.card.arena && e.card.hp === 1,
    );
    if (hpOne)
      add(
        "defender-departs-before-combat",
        ["index:0", "defender"],
        { attackTarget: 1, expectDefenderDeparture: true },
        [row(ground, "self"), row(hpOne, "opponent")],
      );
    else
      obligation(
        "defender-departs-before-combat",
        "No quiet HP1 donor in source arena",
      );
  }
  if (!shape.descriptors[0].optional && entry.card.arena === "ground") {
    const plainUnit = (e) =>
      e.status === "supported" &&
      e.baseClass === "NonLeaderUnitCard" &&
      same(e.card.types, ["unit"]) &&
      !e.card.unique &&
      !e.card.keywords?.length &&
      !Object.keys(e.keywordValues ?? {}).length &&
      !e.card.pilotText &&
      !e.card.pilotBox &&
      !e.card.pilotingBox &&
      !e.piloting &&
      !e.attachCondition;
    const gain = defs.find(
      (e) =>
        plainUnit(e) &&
        e.card.arena === entry.card.arena &&
        same(e.abilities.leader, []) &&
        same(e.abilities.unit, []) &&
        e.abilities.card?.length === 2 &&
        e.abilities.card.every(
          (a) =>
            keys(a, ["trigger", "title", "costs", "effect"]) &&
            same(a.costs, []) &&
            same(a.effect, { kind: "gainForce", target: "ownPlayer" }),
        ) &&
        same(
          e.abilities.card.map((a) => a.trigger),
          ["onAttack", "whenDefeated"],
        ) &&
        e.card.hp === entry.card.power &&
        e.card.power + shape.descriptors[0].power < entry.card.hp,
    );
    if (gain) {
      add(
        "wounded-defender-captured-death",
        ["index:0", "defender"],
        {
          attackTarget: 1,
          expectDefenderDeparture: true,
          expectDeathForce: true,
        },
        [row(ground, "self"), row(gain, "opponent", gain.card.hp - 1)],
      );
      add(
        "positive-hp-natural-expiry-lethal",
        ["defender", "decline"],
        {
          attackTarget: 1,
          waitForExpiry: true,
          expectExpiryDeath: true,
          expectDeathForce: true,
        },
        [row(ground, "self"), row(gain, "opponent")],
      );
    }
    const defense = defs.find(
      (e) =>
        plainUnit(e) &&
        e.card.arena === entry.card.arena &&
        same(e.abilities.leader, []) &&
        same(e.abilities.unit, []) &&
        e.abilities.card?.length === 1 &&
        keys(e.abilities.card[0], ["trigger", "title", "costs", "effect"]) &&
        e.abilities.card[0].trigger === "onDefense" &&
        same(e.abilities.card[0].costs, []) &&
        same(e.abilities.card[0].effect, {
          kind: "createTokenUnit",
          tokenType: "cloneTrooper",
          amount: { kind: "const", value: 1 },
          target: "ownPlayer",
          entersReady: false,
        }),
    );
    if (defense)
      for (const defenderFirst of [false, true]) {
        add(
          "captured-defense-" +
            (defenderFirst ? "defender-first" : "attacker-first"),
          ["index:0", "defender"],
          {
            attackTarget: 1,
            defenderFirst,
            expectDefenderDeparture: true,
            expectClone: true,
          },
          [row(ground, "self"), row(defense, "opponent", defense.card.hp - 1)],
        );
      }
  }
  if (!shape.descriptors[0].optional && entry.card.hp > 1) {
    const damage = defs.find(
      (e) =>
        e.status === "supported" &&
        e.baseClass === "EventCard" &&
        same(e.card.types, ["event"]) &&
        !e.card.keywords?.length &&
        !Object.keys(e.keywordValues ?? {}).length &&
        !e.card.pilotText &&
        !e.card.pilotBox &&
        !e.card.pilotingBox &&
        !e.piloting &&
        !e.attachCondition &&
        same(e.abilities.leader, []) &&
        same(e.abilities.unit, []) &&
        e.abilities.card?.length === 1 &&
        keys(e.abilities.card[0], [
          "trigger",
          "title",
          "costs",
          "effect",
          "targetResolver",
        ]) &&
        e.abilities.card[0].trigger === "event" &&
        same(e.abilities.card[0].costs, []) &&
        same(e.abilities.card[0].targetResolver, {
          owner: "any",
          type: "unit",
          zone: "anyAttackable",
        }) &&
        same(e.abilities.card[0].effect, {
          kind: "damage",
          target: "chosen",
          amount: { kind: "const", value: entry.card.hp - 1 },
        }),
    );
    if (damage) {
      const prep = [
        ...mixed,
        { code: damage.setCode, owner: "self", zone: "hand" },
      ];
      add(
        "attacker-self-departs-before-combat",
        ["index:0", "source"],
        { damagePreparation: prep.length - 1, expectAttackerDeparture: true },
        prep,
      );
      const overwhelm = defs.find(
        (e) =>
          e.status === "supported" &&
          e.baseClass === "UpgradeCard" &&
          same(e.card.types, ["upgrade"]) &&
          !e.card.unique &&
          same(e.card.keywords, ["overwhelm"]) &&
          !Object.keys(e.keywordValues ?? {}).length &&
          !e.card.pilotText &&
          !e.card.pilotBox &&
          !e.card.pilotingBox &&
          !e.piloting &&
          e.card.upgradeHp === 0 &&
          Number.isInteger(e.card.upgradePower) &&
          e.card.upgradePower >= 0 &&
          same(e.attachCondition, {
            kind: "binary",
            op: "&&",
            left: {
              kind: "query",
              name: "isUnit",
              receiver: { kind: "ref", path: ["card"] },
              args: [],
            },
            right: {
              kind: "binary",
              op: ">",
              left: { kind: "ref", path: ["card", "damage"] },
              right: { kind: "const", value: 0 },
            },
          }) &&
          same(e.abilities.leader, []) &&
          same(e.abilities.unit, []) &&
          e.abilities.card?.length === 1 &&
          keys(e.abilities.card[0], ["trigger", "title", "costs", "effect"]) &&
          e.abilities.card[0].trigger === "constant" &&
          same(e.abilities.card[0].costs, []) &&
          same(e.abilities.card[0].effect, {
            kind: "gainKeyword",
            target: "parent",
            duration: "persistent",
            keyword: "overwhelm",
            amount: { kind: "const", value: 1 },
          }),
      );
      const hpOne = quiet.find(
        (e) => e.card.arena === entry.card.arena && e.card.hp === 1,
      );
      if (overwhelm && hpOne) {
        add(
          "actual-overwhelm-departed-defender",
          ["index:0", "defender"],
          {
            attackTarget: 1,
            damagePreparation: 2,
            upgradePreparation: 3,
            expectDefenderDeparture: true,
            expectOverwhelm: true,
          },
          [
            row(ground, "self"),
            row(hpOne, "opponent"),
            { code: damage.setCode, owner: "self", zone: "hand" },
            { code: overwhelm.setCode, owner: "self", zone: "hand" },
          ],
        );
      }
    }
  }
  for (const gap of [
    "source-semantic-review",
    "captured-on-defense-after-stat-death",
    "captured-when-defeated",
    "phase-expiry-lethal",
    "attacker-departure",
    "actual-overwhelm-departure",
    "reversed-source-seats",
    "unique-source-replacement",
    "token-deployed-leader",
    "framework-stat-death-ordering",
    "recipient-reentry",
  ]) {
    if (
      (gap === "captured-on-defense-after-stat-death" &&
        result.cases.some((c) => c.probe.expectClone)) ||
      (gap === "captured-when-defeated" &&
        result.cases.some((c) => c.probe.expectDeathForce)) ||
      (gap === "phase-expiry-lethal" &&
        result.cases.some((c) => c.probe.expectExpiryDeath)) ||
      (gap === "attacker-departure" &&
        result.cases.some((c) => c.probe.expectAttackerDeparture)) ||
      (gap === "actual-overwhelm-departure" &&
        result.cases.some((c) => c.probe.expectOverwhelm))
    )
      continue;
    obligation(
      gap,
      "No actual source-card construction for this dimension; synthetic diagnostics are separate",
    );
  }
  return result;
}
module.exports = { classifyNamedTarget, planNamedTargetProbes };
