"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  classifyResourceSelf,
  planResourceSelfProbes,
} = require("../pipeline/resource-self-probes");
const catalogue = require("../../card-compiler/generated/catalog.json");
const entry = (id) =>
  structuredClone(catalogue.cards.find((e) => e.setCode === id));
test("three exact printed resource source shapes carry finite interaction gaps", () => {
  for (const id of ["LAW_159", "LOF_097", "TWI_127"]) {
    const p = planResourceSelfProbes(entry(id), { catalogue });
    assert.ok(p.cases.length >= 4);
    assert.ok(
      p.uncovered.some((g) => g.id.endsWith("earlier-death-return-to-hand")),
    );
    assert.ok(
      p.uncovered.some((g) => g.id.endsWith("resource-capacity-boundary")),
    );
  }
  assert.equal(classifyResourceSelf(entry("SHD_107")), null);
  const eeth = planResourceSelfProbes(entry("LOF_097"), { catalogue });
  assert.ok(
    eeth.cases.every((c) => c.setupCardIds.includes("TOKEN_THE_FORCE")),
  );
});
test("no extra registrar costs selectors bodies or source domain are modeled", () => {
  for (const mutate of [
    (e) => (e.baseClass = "UpgradeCard"),
    (e) => e.card.types.push("token"),
    (e) => (e.card.pilotText = "Pilot"),
    (e) => (e.piloting = {}),
    (e) => e.abilities.unit.push({}),
    (e) => (e.keywordValues.hidden = 1),
    (e) => e.card.keywords.push("hidden"),
    (e) => (e.abilities.card[0].targetResolver = {}),
    (e) => (e.abilities.card[0].condition = {}),
    (e) => e.abilities.card[0].costs.push({ kind: "exhaustSelf" }),
    (e) => (e.abilities.card[0].then = {}),
    (e) => (e.abilities.card[0].optional = false),
    (e) => (e.abilities.card[0].trigger = "whenPlayed"),
  ]) {
    const e = entry("LAW_159");
    mutate(e);
    assert.equal(classifyResourceSelf(e), null);
  }
});
test("Mercenary live discard guard is exact and not silently replaced with another zone", () => {
  for (const mutate of [
    (a) => (a.effect.condition.right.value = "hand"),
    (a) => (a.effect.condition.left.path[0] = "card"),
    (a) => (a.effect.condition.op = "!=="),
    (a) => (a.effect.onFalse = { kind: "resourceCard", target: "self" }),
    (a) => (a.effect.onTrue.target = "chosen"),
    (a) => (a.effect.onTrue.readyResource = true),
    (a) => (a.effect.onTrue.targetPlayer = "opponent"),
  ]) {
    const e = entry("LAW_159");
    mutate(e.abilities.card[0]);
    assert.equal(classifyResourceSelf(e), null);
  }
});
test("Eeth successful resource continuation has no source-zone guard or extra branches", () => {
  for (const mutate of [
    (a) => (a.effect.target = "enemyPlayer"),
    (a) => (a.ifYouDo.targetResolver = {}),
    (a) => (a.ifYouDo.optional = true),
    (a) => (a.ifYouDo.condition = {}),
    (a) => (a.ifYouDo.ifYouDo = {}),
    (a) => (a.ifYouDo.effect.target = "chosen"),
    (a) => (a.ifYouDo.effect.readyResource = true),
    (a) =>
      (a.ifYouDo.effect = {
        kind: "conditional",
        condition: { kind: "const", value: true },
        onTrue: a.ifYouDo.effect,
      }),
  ]) {
    const e = entry("LOF_097");
    mutate(e.abilities.card[0]);
    assert.equal(classifyResourceSelf(e), null);
  }
});
test("event is mandatory standalone self resource without amount target or readiness options", () => {
  for (const mutate of [
    (a) => (a.optional = true),
    (a) => (a.optional = false),
    (a) => (a.ifYouDo = {}),
    (a) => (a.effect.target = "ownPlayer"),
    (a) => (a.effect.amount = { kind: "const", value: 1 }),
    (a) => (a.effect.readyResource = true),
    (a) => (a.effect.targetPlayer = "self"),
  ]) {
    const e = entry("TWI_127");
    mutate(e.abilities.card[0]);
    assert.equal(classifyResourceSelf(e), null);
  }
});
test("native dependency and complete ordinary attachment donor restrictions are checked", () => {
  const bad = structuredClone(catalogue.cards);
  bad.find((e) => e.setCode === "TOKEN_THE_FORCE").card.title = "changed";
  assert.equal(
    planResourceSelfProbes(entry("LOF_097"), { catalogue: bad }).cases.length,
    0,
  );
  const p = planResourceSelfProbes(entry("LOF_097"), { catalogue });
  const donor = p.cases.find((c) => c.probe.transferStagedAttachments).probe
    .targets[0].attachments[0].code;
  for (const mutate of [
    (e) => (e.card.pilotText = "Pilot"),
    (e) => (e.card.pilotBox = "Pilot"),
    (e) => (e.card.pilotingBox = "Pilot"),
    (e) => (e.piloting = {}),
    (e) => e.abilities.card.push({ trigger: "whenPlayed" }),
    (e) => (e.attachCondition.right.right.extra = true),
  ]) {
    const cards = structuredClone(catalogue.cards);
    mutate(cards.find((e) => e.setCode === donor));
    assert.ok(
      !planResourceSelfProbes(entry("LOF_097"), {
        catalogue: cards,
      }).cases.some((c) => c.probe.transferStagedAttachments),
    );
  }
});
test("source printed costs and ordinary unit stats are bounded construction inputs", () => {
  for (const mutate of [
    (e) => (e.card.cost = -1),
    (e) => (e.card.cost = 9),
    (e) => (e.card.cost = 1.5),
    (e) => (e.card.hp = 0),
    (e) => (e.card.power = -1),
  ]) {
    const e = entry("LOF_097");
    mutate(e);
    assert.equal(classifyResourceSelf(e), null);
  }
});
test("staged native attachment witnesses require both native definitions", () => {
  const cards = catalogue.cards.filter((e) => e.setCode !== "TOKEN_SHIELD");
  assert.ok(
    !planResourceSelfProbes(entry("LAW_159"), { catalogue: cards }).cases.some(
      (c) => c.probe.transferStagedAttachments,
    ),
  );
});
test("event rejects an outer attachment restriction", () => {
  const e = entry("TWI_127");
  e.attachCondition = { kind: "const", value: true };
  assert.equal(classifyResourceSelf(e), null);
});
test("ordinary upgrade staging holder must satisfy its cost predicate too", () => {
  const original = planResourceSelfProbes(entry("LOF_097"), { catalogue });
  const c = original.cases.find((c) => c.probe.transferStagedAttachments);
  const code = c.probe.targets[0].code,
    upgrade = c.probe.targets[0].attachments[0].code;
  const cards = structuredClone(catalogue.cards),
    u = cards.find((e) => e.setCode === upgrade);
  cards.find((e) => e.setCode === code).card.cost =
    u.attachCondition.right.right.value + 1;
  const p = planResourceSelfProbes(entry("LOF_097"), { catalogue: cards });
  assert.ok(
    p.cases.every(
      (c) =>
        !c.probe.transferStagedAttachments ||
        c.probe.targets[0].attachments[0].code !== upgrade,
    ),
  );
});
test("pure resource cards keep irrelevant Force inert rather than require an undeclared native dependency", () => {
  for (const id of ["LAW_159", "TWI_127"]) {
    const p = planResourceSelfProbes(entry(id), { catalogue });
    assert.ok(p.cases.every((c) => !c.probe.held && !c.probe.enemyHeld));
  }
});
