"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  classifyForceTriggers,
  planForceTriggerProbes,
} = require("../pipeline/force-trigger-probes");
const catalogue = require("../../card-compiler/generated/catalog.json");
const entry = (id) =>
  structuredClone(catalogue.cards.find((e) => e.setCode === id));
test("two full sources classify and construct both printed trigger and attachment contracts", () => {
  const acolyte = planForceTriggerProbes(entry("LOF_129"), { catalogue });
  assert.equal(acolyte.cases.length, 10);
  assert.ok(
    acolyte.cases.some(
      (c) => c.probe.actor === "opponent" && c.probe.lethalAttack,
    ),
  );
  const saber = planForceTriggerProbes(entry("LOF_102"), { catalogue });
  assert.ok(
    saber.cases.some((c) => c.probe.uniqueReplacement && c.probe.keepOld),
  );
  assert.equal(saber.cases.filter((c) => c.probe.autoUnique).length, 1);
  assert.ok(
    saber.cases.some(
      (c) =>
        c.name.endsWith("partial-heal-leaves-one") &&
        c.probe.ownBaseDamage === c.probe.amount + 1,
    ),
  );
  for (const p of [acolyte, saber])
    assert.ok(p.cases.every((c) => c.setupCardIds.includes("TOKEN_THE_FORCE")));
});
test("dual mandatory gain requires exactly both triggers and exact acting player", () => {
  for (const change of [
    (e) => e.abilities.card.pop(),
    (e) => e.abilities.card.push(structuredClone(e.abilities.card[0])),
    (e) => (e.abilities.card[0].trigger = "whenPlayed"),
    (e) => (e.abilities.card[0].optional = true),
    (e) => (e.abilities.card[0].condition = {}),
    (e) => (e.abilities.card[0].ifYouDo = {}),
    (e) => (e.abilities.card[0].targetResolver = {}),
    (e) => (e.abilities.card[0].effect.target = "enemyPlayer"),
    (e) => (e.abilities.card[0].effect.kind = "useForce"),
    (e) => e.abilities.card[0].costs.push({}),
    (e) => (e.baseClass = "UpgradeCard"),
    (e) => (e.keywordValues.hidden = 1),
  ]) {
    const e = entry("LOF_129");
    change(e);
    assert.equal(classifyForceTriggers(e), null);
  }
});
test("upgrade class, intrinsic, pilot and exact independent continuation fail closed", () => {
  for (const change of [
    (e) => e.card.types.push("token"),
    (e) => (e.baseClass = "NonLeaderUnitCard"),
    (e) => (e.card.pilotText = "Pilot"),
    (e) => (e.card.pilotBox = "Pilot"),
    (e) => (e.card.pilotingBox = "Pilot"),
    (e) => (e.piloting = {}),
    (e) => e.abilities.unit.push({}),
    (e) => (e.keywordValues.shielded = 1),
    (e) => e.card.keywords.push("ambush"),
    (e) => (e.abilities.card[0].optional = false),
    (e) => (e.abilities.card[0].effect.target = "enemyPlayer"),
    (e) => (e.abilities.card[0].ifYouDo.targetResolver.type = "unit"),
    (e) => (e.abilities.card[0].ifYouDo.targetResolver.owner = "self"),
    (e) => (e.abilities.card[0].ifYouDo.targetResolver.zone = "anyAttackable"),
    (e) => (e.abilities.card[0].ifYouDo.targetResolver.count = 2),
    (e) => (e.abilities.card[0].ifYouDo.ifYouDo = {}),
    (e) => (e.abilities.card[0].ifYouDo.effect.amount.value = 0),
    (e) => (e.abilities.card[0].ifYouDo.effect.amount.value = 9),
  ]) {
    const e = entry("LOF_102");
    change(e);
    assert.equal(classifyForceTriggers(e), null);
  }
});
test("whole attachment restriction and printed stat metadata are preserved", () => {
  for (const change of [
    (e) => (e.attachCondition = null),
    (e) => (e.attachCondition.op = "+"),
    (e) => (e.attachCondition.value.receiver.path[0] = "source"),
    (e) => e.attachCondition.value.args.push({ kind: "const", value: "jedi" }),
    (e) => (e.attachCondition.extra = true),
    (e) => (e.card.upgradePower = -1),
    (e) => (e.card.upgradeHp = 1.5),
    (e) => (e.card.hp = 9),
    (e) => (e.card.unique = "true"),
  ]) {
    const e = entry("LOF_102");
    change(e);
    assert.equal(classifyForceTriggers(e), null);
  }
});
test("native dependency and legal/forbidden metadata donors are finite requirements", () => {
  const cards = structuredClone(catalogue.cards);
  cards.find((e) => e.setCode === "TOKEN_THE_FORCE").card.title = "changed";
  for (const id of ["LOF_102", "LOF_129"]) {
    const p = planForceTriggerProbes(entry(id), { catalogue: cards });
    assert.equal(p.cases.length, 0);
    assert.ok(p.uncovered.length);
  }
  const p = planForceTriggerProbes(entry("LOF_102"), { catalogue });
  const c = p.cases.find((c) => c.probe.hostIndex === 1);
  const donor = catalogue.cards.find(
    (e) => e.setCode === c.probe.targets[1].code,
  );
  assert.equal(donor.card.arena, "space");
  assert.ok(!donor.card.traits.includes(c.probe.excludedTrait));
});
