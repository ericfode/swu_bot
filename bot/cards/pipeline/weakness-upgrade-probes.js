"use strict";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (o, allowed) =>
  o &&
  typeof o === "object" &&
  !Array.isArray(o) &&
  Object.keys(o).every((k) => allowed.includes(k));
const reviewedWeaknessCard = {
  title: "Weakness",
  subtitle: "",
  cost: 0,
  hp: -1,
  power: -1,
  text: "",
  deployBox: null,
  epicAction: "",
  unique: false,
  rules: null,
  upgradePower: -1,
  upgradeHp: -1,
  id: "7816991190",
  aspects: [],
  traits: ["condition"],
  keywords: [],
  types: ["token", "upgrade"],
  setId: { set: "HMW" },
  internalName: "weakness",
};
function nativeWeakness(e) {
  return (
    e?.setCode === "TOKEN_WEAKNESS" &&
    e.status === "unsupported" &&
    e.baseClass === "TokenUpgradeCard" &&
    e.className === "Weakness" &&
    e.id === "7816991190" &&
    e.internalName === "weakness" &&
    e.sourcePath === "game/cards/09_HMW/tokens/Weakness.ts" &&
    e.sourceHash ===
      "dd546e4886757d77fffeb8be6e7381144fa7378b6493ce444aa87e4ba1202778" &&
    same(e.card, reviewedWeaknessCard) &&
    same(e.abilities, { leader: [], unit: [], card: [] }) &&
    same(e.keywordValues, {}) &&
    !e.attachCondition &&
    !e.piloting
  );
}
function classifyWeaknessUpgrade(e) {
  const a = e.abilities?.card?.[0];
  if (
    e.status !== "supported" ||
    e.baseClass !== "UpgradeCard" ||
    !same(e.card?.types, ["upgrade"]) ||
    typeof e.card.unique !== "boolean" ||
    e.card.unique ||
    e.card.upgradeHp !== 1 ||
    e.card.upgradePower !== 1 ||
    e.attachCondition ||
    e.piloting ||
    e.card.pilotText ||
    e.card.pilotBox ||
    e.card.pilotingBox ||
    !same(e.keywordValues ?? {}, {}) ||
    !same(e.card.keywords ?? [], []) ||
    Object.values(e.abilities ?? {}).flat().length !== 1 ||
    !keys(a, [
      "trigger",
      "title",
      "costs",
      "optional",
      "targetResolver",
      "effect",
    ]) ||
    a.trigger !== "whenPlayed" ||
    a.optional !== true ||
    typeof a.title !== "string" ||
    !same(a.costs, []) ||
    !same(a.targetResolver, {
      owner: "any",
      type: "unit",
      zone: "anyAttackable",
    }) ||
    !same(a.effect, {
      kind: "giveWeakness",
      target: "chosen",
      amount: { kind: "const", value: 1 },
    })
  )
    return null;
  return {
    family: "weakness-upgrade",
    trigger: "whenPlayed",
    power: e.card.upgradePower,
    hp: e.card.upgradeHp,
  };
}
function planWeaknessUpgrade(e, { catalogue } = {}) {
  const shape = classifyWeaknessUpgrade(e);
  if (!shape) return null;
  const defs = Array.isArray(catalogue) ? catalogue : catalogue?.cards ?? [];
  const quiet = (e) =>
    e.status === "supported" &&
    (e.baseClass === "NonLeaderUnitCard" ||
      (!e.baseClass &&
        e.sourcePath === null &&
        e.sourceHash === null &&
        !e.card.text)) &&
    same(e.card.types, ["unit"]) &&
    !e.card.unique &&
    !e.card.keywords?.length &&
    !Object.keys(e.keywordValues ?? {}).length &&
    !Object.values(e.abilities ?? {}).flat().length &&
    !e.attachCondition &&
    !e.piloting &&
    !e.card.pilotText &&
    !e.card.pilotBox &&
    !e.card.pilotingBox;
  const qs = defs
    .filter(quiet)
    .sort((a, b) => a.setCode.localeCompare(b.setCode));
  const ground = qs.find((e) => e.card.arena === "ground" && e.card.hp >= 4),
    space = qs.find((e) => e.card.arena === "space" && e.card.hp >= 4);
  const result = {
    schema: "swu-card-probes/v1",
    cardId: e.setCode,
    sourceHash: e.sourceHash,
    cases: [],
    obligations: [],
    uncovered: [],
  };
  const ob = (dimension, reason) => {
    const id = `${e.setCode}:weakness-upgrade:${dimension}`;
    result.obligations.push({ id, path: "weakness-upgrade", dimension });
    if (reason) result.uncovered.push({ id, path: "weakness-upgrade", reason });
    return id;
  };
  if (!defs.some(nativeWeakness)) {
    ob(
      "native-weakness-dependency",
      "Missing reviewed native Weakness definition",
    );
    return result;
  }
  if (!ground || !space) {
    ob("quiet-donors", "No bounded real quiet recipients");
    return result;
  }
  const row = (e, owner) => ({
    code: e.setCode,
    arena: e.card.arena,
    owner,
    exhausted: true,
  });
  const targets = [
    row(ground, "self"),
    row(ground, "opponent"),
    row(space, "self"),
    row(space, "opponent"),
  ];
  const add = (name, extra = {}, ts = targets) => {
    const id = ob(name);
    result.cases.push({
      id: `auto/${e.setCode}/weakness-upgrade-${name}`,
      name: `weakness-upgrade-${name}`,
      kind: "probe",
      focusCardIds: [e.setCode],
      setupCardIds: [
        ...new Set([
          ...ts.map((t) => t.code),
          ...ts.flatMap((t) => (t.attachments ?? []).map((a) => a.code)),
          "TOKEN_WEAKNESS",
        ]),
      ].sort(),
      behaviorIds: ["weakness", "when-played", "upgrade"],
      assertionStages: ["construction", "activation", "observation"],
      coverageObligationIds: [id],
      probe: {
        ...shape,
        cardId: e.setCode,
        sourceTypes: e.card.types,
        targets: ts,
        hostIndex: 0,
        selectedIndex: 1,
        resourceCount: 12,
        ...extra,
      },
    });
  };
  for (const hostIndex of [0, 1, 2, 3])
    add(`host-${hostIndex}`, { hostIndex, selectedIndex: (hostIndex + 1) % 4 });
  add("opposite-source-controller", { sourceSeat: 2, initiative: "opponent" });
  add("cancel-before-attachment", { cancel: true });
  add("own-host-net-stats", { selectedIndex: 0 });
  add("decline", { decline: true });
  add(
    "different-wounded-lethal",
    { lethal: true },
    targets.map((t, i) => (i === 1 ? { ...t, damage: ground.card.hp - 1 } : t)),
  );
  add(
    "stacked-weakness",
    {},
    targets.map((t, i) =>
      i === 1
        ? { ...t, attachments: [{ code: "TOKEN_WEAKNESS", token: "weakness" }] }
        : t,
    ),
  );
  add(
    "mixed-native-attachments",
    {},
    targets.map((t, i) =>
      i === 1
        ? {
            ...t,
            attachments: [
              { code: "TOKEN_EXPERIENCE", token: "experience" },
              { code: "TOKEN_SHIELD", token: "shield" },
            ],
          }
        : t,
    ),
  );
  const zero = qs.find((e) => e.card.hp >= 4 && e.card.power <= 1);
  if (zero)
    add("zero-power-clamp", {}, [
      targets[0],
      {
        ...row(zero, "opponent"),
        attachments: [{ code: "TOKEN_WEAKNESS", token: "weakness" }],
      },
    ]);
  const unitToken = defs.find(
    (e) =>
      e.status === "supported" &&
      same(e.card.types, ["token", "unit"]) &&
      e.baseClass === "TokenUnitCard" &&
      !e.card.keywords?.length &&
      !e.card.pilotText &&
      !e.card.pilotBox &&
      !e.card.pilotingBox &&
      !e.piloting &&
      !e.attachCondition &&
      e.card.hp === 1 &&
      !Object.values(e.abilities ?? {}).flat().length &&
      !Object.keys(e.keywordValues ?? {}).length,
  );
  if (unitToken)
    add("real-token-hp-one-lethal", { lethal: true }, [
      targets[0],
      { ...row(unitToken, "opponent"), token: unitToken.internalName },
    ]);
  else
    ob(
      "native-unit-token-recipient",
      "No bounded quiet native unit token donor",
    );
  const leader = defs.find(
    (e) =>
      e.status === "supported" &&
      same(e.card.types, ["leader"]) &&
      e.baseClass === "LeaderUnitCard" &&
      !e.card.keywords?.length &&
      !Object.keys(e.keywordValues ?? {}).length &&
      !e.card.pilotText &&
      !e.card.pilotBox &&
      !e.card.pilotingBox &&
      !e.piloting &&
      !e.attachCondition &&
      same(e.abilities.card, []) &&
      e.abilities.leader?.length === 1 &&
      e.abilities.unit?.length === 1 &&
      keys(e.abilities.leader[0], ["trigger", "title", "costs", "effect"]) &&
      keys(e.abilities.unit[0], ["trigger", "title", "costs", "effect"]) &&
      e.abilities.leader[0].trigger === "action" &&
      same(e.abilities.leader[0].costs, [{ kind: "exhaustSelf" }]) &&
      same(e.abilities.leader[0].effect, {
        kind: "damage",
        target: "bothBases",
        amount: { kind: "const", value: 1 },
      }) &&
      e.abilities.unit[0].trigger === "onAttack" &&
      same(e.abilities.unit[0].costs, []) &&
      same(e.abilities.unit[0].effect, {
        kind: "damage",
        target: "enemyBase",
        amount: { kind: "const", value: 1 },
      }),
  );
  if (leader)
    add("real-deployed-leader", { leaderCode: leader.setCode }, [
      targets[0],
      { ...row(leader, "opponent"), deployedLeader: true },
    ]);
  else
    ob("deployed-leader-recipient", "No bounded simple ordinary leader donor");
  for (const gap of [
    "mixed-attachments",
    "later-host-combat-cleanup",
    "source-departure",
    "replacement",
    "multiplayer",
  ])
    ob(
      gap,
      "No actual full-source construction for this dimension; primitive diagnostics are separate",
    );
  return result;
}
module.exports = {
  classifyWeaknessUpgrade,
  planWeaknessUpgrade,
  nativeWeakness,
};
