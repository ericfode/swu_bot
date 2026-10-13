"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  classifyWeaknessUpgrade,
  planWeaknessUpgrade,
} = require("../pipeline/weakness-upgrade-probes");
const catalogue = require("../../card-compiler/generated/catalog.json");
const entry = () =>
  structuredClone(catalogue.cards.find((e) => e.setCode === "HMW_097"));
test("ordinary optional scalar Weakness upgrade has bounded real constructions", () => {
  assert.ok(classifyWeaknessUpgrade(entry()));
  const p = planWeaknessUpgrade(entry(), { catalogue });
  assert.equal(p.cases.length, 14);
  for (const label of [
    "host-3",
    "opposite-source-controller",
    "cancel-before-attachment",
    "own-host-net-stats",
    "different-wounded-lethal",
    "stacked-weakness",
    "real-token-hp-one-lethal",
  ])
    assert.ok(p.cases.some((c) => c.name.endsWith(label)));
});
test("ordinary upgrade classifier fails closed on headers effects selectors and full metadata", () => {
  for (const f of [
    (e) => (e.card.unique = true),
    (e) => (e.baseClass = "TokenUpgradeCard"),
    (e) => (e.card.types = ["unit"]),
    (e) => (e.card.pilotText = "body"),
    (e) => (e.card.keywords = ["raid"]),
    (e) => (e.keywordValues = { raid: 1 }),
    (e) => (e.attachCondition = { kind: "const", value: true }),
    (e) => (e.abilities.card[0].trigger = "whenDefeated"),
    (e) => (e.abilities.card[0].optional = false),
    (e) => (e.abilities.card[0].then = { effect: { kind: "noAction" } }),
    (e) => (e.abilities.card[0].effect.amount.value = 2),
    (e) => (e.abilities.card[0].targetResolver.owner = "self"),
    (e) => e.abilities.unit.push(e.abilities.card[0]),
  ]) {
    const e = entry();
    f(e);
    assert.equal(classifyWeaknessUpgrade(e), null);
  }
});
test("actual native dependency cannot be missing or altered", () => {
  for (const mode of ["missing", "altered"]) {
    const c = structuredClone(catalogue);
    if (mode === "missing")
      c.cards = c.cards.filter((e) => e.setCode !== "TOKEN_WEAKNESS");
    else
      c.cards.find((e) => e.setCode === "TOKEN_WEAKNESS").card.title =
        "not reviewed";
    const p = planWeaknessUpgrade(entry(), { catalogue: c });
    assert.equal(p.cases.length, 0);
    assert.ok(
      p.uncovered.some((o) => o.id.endsWith("native-weakness-dependency")),
    );
  }
});

test("native unit and leader donors require exact class and no unmodeled mechanics", () => {
  for (const kind of ["leader", "unit-token"])
    for (const className of ["EventCard", "UnknownCard"]) {
      const c = structuredClone(catalogue);
      for (const e of c.cards)
        if (
          kind === "leader"
            ? e.card.types.includes("leader")
            : e.card.types.includes("token") && e.card.types.includes("unit")
        )
          e.baseClass = className;
      const p = planWeaknessUpgrade(entry(), { catalogue: c });
      assert.ok(
        !p.cases.some((x) =>
          x.name.endsWith(
            kind === "leader"
              ? "real-deployed-leader"
              : "real-token-hp-one-lethal",
          ),
        ),
      );
    }
  const c = structuredClone(catalogue);
  for (const e of c.cards)
    if (e.card.types.includes("token") && e.card.types.includes("unit"))
      e.card.pilotText = "unmodeled";
  assert.ok(
    !planWeaknessUpgrade(entry(), { catalogue: c }).cases.some((x) =>
      x.name.endsWith("real-token-hp-one-lethal"),
    ),
  );
});

test("every automatic Weakness upgrade case roundtrips through actual library definitions", () => {
  const library = require("../reference/library"),
    registry = library.registry();
  for (const scenario of planWeaknessUpgrade(entry(), { catalogue }).cases) {
    const recorded = {
      ...scenario,
      source: {
        module: "../pipeline/probe-fixture.js",
        scenario: scenario.name,
      },
    };
    assert.deepEqual(
      library.definition(scenario.id, registry, recorded),
      recorded,
    );
    assert.match(scenario.id, /^auto\/HMW_097\/weakness-upgrade-[a-z0-9-]+$/);
    const bad = {
      ...recorded,
      id: scenario.id.replace("/weakness-upgrade-", ":weakness-upgrade:"),
    };
    assert.throws(
      () => library.definition(bad.id, registry, bad),
      /Unknown reference case/,
    );
  }
});
