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
function plain(e) {
  return (
    e?.status === "supported" &&
    !!e.card &&
    !e.card.pilotText &&
    !e.card.pilotBox &&
    !e.card.pilotingBox &&
    !e.piloting &&
    !e.card.deployBox &&
    !e.card.epicAction &&
    !Object.keys(e.keywordValues ?? {}).length &&
    !e.card.keywords?.length
  );
}
function classifyResourceSelf(entry) {
  const all = Object.values(entry.abilities ?? {}).flat(),
    a = all[0];
  if (
    !plain(entry) ||
    all.length !== 1 ||
    entry.abilities.card?.length !== 1 ||
    !same(a.costs, []) ||
    typeof a.title !== "string" ||
    !Number.isInteger(entry.card.cost) ||
    entry.card.cost < 0 ||
    entry.card.cost > 8
  )
    return null;
  const resource = { kind: "resourceCard", target: "self" };
  if (
    entry.baseClass === "EventCard" &&
    !entry.attachCondition &&
    same(entry.card.types, ["event"]) &&
    keys(a, ["trigger", "title", "costs", "effect"]) &&
    a.trigger === "event" &&
    same(a.effect, resource)
  ) {
    return { family: "resource-self", kind: "event" };
  }
  if (
    entry.baseClass !== "NonLeaderUnitCard" ||
    !same(entry.card.types, ["unit"]) ||
    !["ground", "space"].includes(entry.card.arena) ||
    !Number.isInteger(entry.card.hp) ||
    entry.card.hp < 1 ||
    !Number.isInteger(entry.card.power) ||
    entry.card.power < 0 ||
    entry.attachCondition ||
    a.trigger !== "whenDefeated" ||
    a.optional !== true
  )
    return null;
  if (
    keys(a, ["trigger", "title", "costs", "optional", "effect"]) &&
    same(a.effect, {
      kind: "conditional",
      condition: {
        kind: "binary",
        op: "===",
        left: { kind: "ref", path: ["source", "zoneName"] },
        right: { kind: "const", value: "discard" },
      },
      onTrue: resource,
      onFalse: { kind: "noAction" },
    })
  ) {
    return {
      family: "resource-self",
      kind: "discard-guard",
      sourceArena: entry.card.arena,
    };
  }
  if (
    keys(a, ["trigger", "title", "costs", "optional", "effect", "ifYouDo"]) &&
    same(a.effect, { kind: "useForce", target: "ownPlayer" }) &&
    keys(a.ifYouDo, ["title", "costs", "effect"]) &&
    typeof a.ifYouDo.title === "string" &&
    same(a.ifYouDo.costs, []) &&
    same(a.ifYouDo.effect, resource)
  ) {
    return {
      family: "resource-self",
      kind: "force-continuation",
      sourceArena: entry.card.arena,
    };
  }
  return null;
}
function planResourceSelfProbes(entry, options = {}) {
  const shape = classifyResourceSelf(entry);
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
    const id = entry.setCode + ":resource-self:" + name;
    result.obligations.push({ id, path: "resource-self", dimension: name });
    if (reason) result.uncovered.push({ id, path: "resource-self", reason });
    return id;
  }
  const token = defs.find(nativeForce);
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
  const filler = quiet.find((e) => e.card.arena === "ground" && e.card.hp >= 4);
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
        "effect",
        "targetResolver",
      ]) &&
      e.abilities.card[0].trigger === "event" &&
      same(e.abilities.card[0].costs, []) &&
      same(e.abilities.card[0].effect, { kind: "defeat", target: "chosen" }) &&
      same(e.abilities.card[0].targetResolver, {
        owner: "any",
        type: "unit",
        zone: "anyAttackable",
      }),
  );
  if (
    !filler ||
    (shape.kind !== "event" && !defeat) ||
    (shape.kind === "force-continuation" && !token)
  ) {
    obligation(
      "metadata-donors",
      "Missing quiet/normal-defeat/reviewed native Force construction dependency",
    );
    return result;
  }
  const row = (e, owner, extra = {}) => ({
    code: e.setCode,
    owner,
    arena: e.card.arena,
    exhausted: false,
    damage: 0,
    ...extra,
  });
  function add(name, targets = [], extra = {}) {
    const id = obligation(name);
    const probe = {
      ...shape,
      cardId: entry.setCode,
      targets,
      held: false,
      enemyHeld: false,
      initiative: "self",
      resourceCount: 32,
      ...(shape.kind !== "event" ? { activationCode: defeat.setCode } : {}),
      ...extra,
    };
    result.cases.push({
      id: `auto/${entry.setCode}/resource-self-${name}`,
      name: "resource-self-" + name,
      kind: "probe",
      focusCardIds: [entry.setCode],
      setupCardIds: [
        ...new Set([
          ...targets.map((t) => t.code),
          ...targets.flatMap((t) => (t.attachments ?? []).map((a) => a.code)),
          ...(probe.activationCode ? [probe.activationCode] : []),
          ...(shape.kind === "force-continuation" ? [token.setCode] : []),
        ]),
      ].sort(),
      behaviorIds: ["resource-self", shape.kind],
      assertionStages: ["construction", "activation", "observation"],
      coverageObligationIds: [id],
      probe,
    });
  }
  if (shape.kind === "event") {
    add("normal-paid-discard-to-exhausted-resource");
    add("natural-phase-readies-resource", [], { waitForExpiry: true });
    add(
      "repeat-three-existing-identities",
      [
        row(entry, "self", { zone: "hand" }),
        row(entry, "self", { zone: "hand" }),
      ],
      { repeat: true },
    );
    add("opponent-actual-play", [row(entry, "opponent", { zone: "hand" })], {
      enemyFocusIndex: 0,
      actor: "opponent",
    });
  } else {
    for (const actor of ["self", "opponent"]) {
      const enemyFocus =
        actor === "opponent" ? [row(entry, "opponent", { zone: "hand" })] : [];
      const actorFlags = {
        actor,
        enemyFocusIndex: actor === "opponent" ? 0 : undefined,
      };
      const held = {
        held: shape.kind === "force-continuation",
        enemyHeld: shape.kind === "force-continuation",
      };
      add(actor + "-accept-from-discard", enemyFocus, {
        ...actorFlags,
        ...held,
      });
      add(actor + "-optional-decline", enemyFocus, {
        ...actorFlags,
        ...held,
        decline: true,
      });
      if (shape.kind === "force-continuation") {
        add(actor + "-absent-own-other-held", enemyFocus, {
          ...actorFlags,
          held: actor === "opponent",
          enemyHeld: actor === "self",
        });
        add(actor + "-absent-both", enemyFocus, actorFlags);
      }
    }
    add("natural-phase-readies-resource", [], {
      held: shape.kind === "force-continuation",
      enemyHeld: shape.kind === "force-continuation",
      waitForExpiry: true,
    });
    const upgrade = defs.find(
      (e) =>
        plain(e) &&
        e.baseClass === "UpgradeCard" &&
        same(e.card.types, ["upgrade"]) &&
        !Object.values(e.abilities ?? {}).flat().length &&
        Number.isInteger(e.card.upgradePower) &&
        e.card.upgradePower >= 0 &&
        e.card.upgradePower <= 8 &&
        Number.isInteger(e.card.upgradeHp) &&
        e.card.upgradeHp >= 0 &&
        e.card.upgradeHp <= 8 &&
        e.card.power === e.card.upgradePower &&
        e.card.hp === e.card.upgradeHp &&
        keys(e.attachCondition, ["kind", "op", "left", "right"]) &&
        e.attachCondition.kind === "binary" &&
        e.attachCondition.op === "&&" &&
        same(e.attachCondition.left, {
          kind: "query",
          name: "hasCost",
          receiver: { kind: "ref", path: ["card"] },
          args: [],
        }) &&
        keys(e.attachCondition.right, ["kind", "op", "left", "right"]) &&
        e.attachCondition.right.kind === "binary" &&
        e.attachCondition.right.op === "<=" &&
        same(e.attachCondition.right.left, {
          kind: "ref",
          path: ["card", "cost"],
        }) &&
        keys(e.attachCondition.right.right, ["kind", "value"]) &&
        e.attachCondition.right.right.kind === "const" &&
        Number.isInteger(e.attachCondition.right.right.value) &&
        entry.card.cost <= e.attachCondition.right.right.value &&
        Number.isInteger(filler.card.cost) &&
        filler.card.cost <= e.attachCondition.right.right.value,
    );
    const nativeAttachments = ["TOKEN_SHIELD", "TOKEN_EXPERIENCE"].every(
      (code) =>
        defs.some(
          (e) =>
            e.setCode === code &&
            e.baseClass === "TokenUpgradeCard" &&
            same(e.card.types, ["token", "upgrade"]),
        ),
    );
    if (upgrade && nativeAttachments)
      add(
        "actual-defeat-ordinary-and-native-attachment-cleanup",
        [
          row(filler, "self", {
            attachments: [
              { code: upgrade.setCode, owner: "self" },
              { code: "TOKEN_SHIELD", token: "shield", owner: "self" },
              { code: "TOKEN_EXPERIENCE", token: "experience", owner: "self" },
            ],
          }),
        ],
        {
          held: shape.kind === "force-continuation",
          enemyHeld: shape.kind === "force-continuation",
          sourceInPlay: true,
          sourceDamage: Math.min(1, entry.card.hp - 1),
          transferStagedAttachments: true,
        },
      );
    else
      obligation(
        "ordinary-native-attachment-cleanup",
        "No bounded quiet printed-stat upgrade with compatible attach condition",
      );
  }
  for (const name of [
    "source-review",
    "earlier-death-return-to-hand",
    "live-discard-guard-negative",
    "competing-death-owner-window",
    "capture-rescue",
    "control-owner-divergence",
    "resource-capacity-boundary",
    "same-source-reentry",
    "force-regain-interaction",
  ]) {
    obligation(
      name,
      "No actual source-card construction for this dimension; synthetic capacity/history diagnostics are separate",
    );
  }
  return result;
}
module.exports = { classifyResourceSelf, planResourceSelfProbes };
