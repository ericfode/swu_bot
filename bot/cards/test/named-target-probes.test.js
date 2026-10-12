"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyNamedTarget,
  planNamedTargetProbes,
} = require("../pipeline/named-target-probes");
const catalogue = require("../../card-compiler/generated/catalog.json");
const entry = (id) =>
  structuredClone(catalogue.cards.find((e) => e.setCode === id));
test("two complete printed sources get bounded essential timing constructions", () => {
  for (const id of ["HMW_255", "JTL_253"]) {
    const p = planNamedTargetProbes(entry(id), { catalogue });
    assert.ok(p.cases.some((c) => c.name.endsWith("both-enemy-selections")));
    assert.ok(p.cases.some((c) => c.name.endsWith("decline-both")));
    assert.ok(
      p.uncovered.some((o) => o.id.endsWith("unique-source-departure")),
    );
  }
  const p = planNamedTargetProbes(entry("HMW_255"), { catalogue });
  assert.ok(
    p.cases.some((c) => c.name.endsWith("missing-staged-2-entering-source")),
  );
  assert.ok(!p.cases.some((c) => c.name.endsWith("missing-2")));
  const q = planNamedTargetProbes(entry("JTL_253"), { catalogue });
  for (const name of [
    "cancel-first",
    "cancel-second",
    "empty-play-anyway",
    "empty-cancel",
  ]) {
    assert.ok(q.cases.some((c) => c.name.endsWith(name)));
  }
});
test("registrar, source domain, side abilities and intrinsic effects fail closed", () => {
  for (const change of [
    (e) => (e.baseClass = "LeaderUnitCard"),
    (e) => e.card.types.push("token"),
    (e) => (e.card.pilotText = "Piloting 1"),
    (e) => (e.keywordValues.hidden = 1),
    (e) => e.card.keywords.push("hidden"),
    (e) => e.abilities.unit.push({ trigger: "onAttack" }),
    (e) => e.abilities.card[0].costs.push({ kind: "exhaustSelf" }),
    (e) => (e.abilities.card[0].condition = { kind: "const", value: true }),
    (e) => (e.abilities.card[0].ifYouDo = { effect: { kind: "noAction" } }),
    (e) => (e.abilities.card[0].optional = true),
  ]) {
    const e = entry("HMW_255");
    change(e);
    assert.equal(classifyNamedTarget(e), null);
  }
});
test("descriptor identities, chooser, cardinality and predicate domains fail closed", () => {
  for (const change of [
    (d) => (d.name = "target"),
    (d) => (d.name = "__proto__"),
    (d) => (d.name = "rebelUnit"),
    (d) => (d.chooser = "opponent"),
    (d) => (d.targetResolver.optional = false),
    (d) => (d.targetResolver.count = 2),
    (d) => (d.targetResolver.owner = "self"),
    (d) => (d.targetResolver.type = "any"),
    (d) => (d.targetResolver.zone = "discard"),
    (d) => (d.targetResolver.arena = "all"),
    (d) => (d.targetResolver.predicate.receiver.path = ["source"]),
    (d) =>
      (d.targetResolver.predicate.args[0] = { kind: "ref", path: ["target"] }),
    (d) => (d.targetResolver.predicate.extra = true),
  ]) {
    const e = entry("HMW_255");
    change(e.abilities.card[0].targetResolvers[0]);
    assert.equal(classifyNamedTarget(e), null);
  }
});
test("unconstructed signed, grouped, lasting or malformed effects reject", () => {
  for (const change of [
    (d) => (d.effect.hp.value = -1),
    (d) => (d.effect.power.value = 0),
    (d) => (d.effect.power.value = 128),
    (d) => (d.effect.hp.value = 1.5),
    (d) => (d.effect.duration = "persistent"),
    (d) => (d.effect.target = "source"),
    (d) => (d.effect.extra = true),
    (d) => (d.effect = { kind: "simultaneous", effects: [d.effect] }),
    (d) => (d.effect = undefined),
  ]) {
    const e = entry("JTL_253");
    change(e.abilities.card[0].targetResolvers[0]);
    assert.equal(classifyNamedTarget(e), null);
  }
});

test("malformed descriptors and nonboolean optional values reject without throwing", () => {
  for (const d of [null, undefined, {}, { name: "valid" }]) {
    const e = entry("JTL_253");
    e.abilities.card[0].targetResolvers[0] = d;
    assert.equal(classifyNamedTarget(e), null);
  }
  for (const value of [0, 1, "true", null]) {
    const e = entry("JTL_253");
    e.abilities.card[0].targetResolvers[0].targetResolver.optional = value;
    assert.equal(classifyNamedTarget(e), null);
  }
  const e = entry("JTL_253");
  e.baseClass = "NonLeaderUnitCard";
  assert.equal(classifyNamedTarget(e), null);
});

test("overlapping future descriptors never construct more than three copies", () => {
  const e = entry("JTL_253");
  e.abilities.card[0].targetResolvers[1].targetResolver.arena = "ground";
  const p = planNamedTargetProbes(e, { catalogue });
  for (const scenario of p.cases) {
    const counts = new Map();
    for (const t of scenario.probe.targets)
      counts.set(t.code, (counts.get(t.code) ?? 0) + 1);
    assert.ok([...counts.values()].every((n) => n <= 3));
  }
});

test("actual OnAttack forms add normal-play combat, capture and expiry witnesses", () => {
  const bossk = planNamedTargetProbes(entry("LAW_031"), { catalogue });
  const falcon = planNamedTargetProbes(entry("LAW_068"), { catalogue });
  assert.equal(bossk.cases.length, 14);
  assert.equal(falcon.cases.length, 10);
  for (const name of [
    "same-recipient-net-zero",
    "wounded-defender-captured-death",
    "positive-hp-natural-expiry-lethal",
    "captured-defense-attacker-first",
    "captured-defense-defender-first",
    "attacker-self-departs-before-combat",
    "actual-overwhelm-departed-defender",
  ])
    assert.ok(bossk.cases.some((c) => c.name.endsWith(name)));
  assert.ok(
    bossk.uncovered.some((o) => o.id.endsWith("reversed-source-seats")),
  );
  assert.ok(falcon.cases.some((c) => c.name.endsWith("negative-power-clamp")));
  for (const p of [bossk, falcon])
    for (const c of p.cases) {
      const counts = new Map([[c.probe.cardId, 1]]);
      for (const t of c.probe.targets)
        counts.set(t.code, (counts.get(t.code) ?? 0) + 1);
      assert.ok([...counts.values()].every((n) => n <= 3));
      for (const t of c.probe.targets) {
        if (entry(t.code).card.types[0] !== "unit")
          assert.equal(t.zone, "hand");
      }
    }
});
test("OnAttack domain and opposing-stat construction grammar fails closed", () => {
  for (const change of [
    (e) =>
      (e.abilities.card[0].targetResolvers[0].targetResolver.arena = "ground"),
    (e) =>
      (e.abilities.card[0].targetResolvers[1].targetResolver.arena = "space"),
    (e) =>
      (e.abilities.card[0].targetResolvers[0].targetResolver.optional = true),
    (e) => (e.abilities.card[0].targetResolvers[1].effect.hp.value.value = 2),
    (e) => (e.abilities.card[0].targetResolvers[1].effect.power.op = "+"),
    (e) => (e.abilities.card[0].targetResolvers[1].effect.hp.value.value = -1),
    (e) =>
      (e.abilities.card[0].targetResolvers[1].effect.power.value.extra = true),
    (e) => (e.card.arena = undefined),
    (e) => (e.attachCondition = { kind: "const", value: true }),
  ]) {
    const e = entry("LAW_031");
    change(e);
    assert.equal(classifyNamedTarget(e), null);
  }
  for (const change of [
    (e) => (e.card.arena = "ground"),
    (e) => delete e.abilities.card[0].targetResolvers[0].targetResolver.arena,
    (e) =>
      (e.abilities.card[0].targetResolvers[1].targetResolver.arena = "space"),
    (e) => (e.abilities.card[0].targetResolvers[0].effect.hp.value.value = 1),
    (e) => (e.abilities.card[0].targetResolvers[1].effect.power.value = -2),
  ]) {
    const e = entry("LAW_068");
    change(e);
    assert.equal(classifyNamedTarget(e), null);
  }
});
test("unmodeled attack registrars and selector/header additions reject", () => {
  for (const change of [
    (e) => (e.abilities.card[0].condition = { kind: "const", value: true }),
    (e) =>
      (e.abilities.card[0].targetResolvers[0].targetResolver.predicate = {
        kind: "const",
        value: true,
      }),
    (e) =>
      (e.abilities.card[0].targetResolvers[1].targetResolver.optional = false),
    (e) => (e.abilities.card[0].trigger = "onDefense"),
    (e) => (e.card.pilotBox = "Piloting"),
    (e) => e.abilities.leader.push({ trigger: "action" }),
    (e) => (e.keywordValues.raid = 1),
  ]) {
    const e = entry("LAW_031");
    change(e);
    assert.equal(classifyNamedTarget(e), null);
  }
});
test("attack preparation donors must have exact modeled effects and registrar", () => {
  for (const field of ["effectExtra", "condition", "pilot"]) {
    const altered = structuredClone(catalogue);
    for (const e of altered.cards) {
      if (e.abilities?.card?.[0]?.effect?.kind !== "damage") continue;
      if (field === "effectExtra") e.abilities.card[0].effect.extra = true;
      if (field === "condition")
        e.abilities.card[0].condition = { kind: "const", value: true };
      if (field === "pilot") e.card.pilotBox = "unmodeled";
    }
    const p = planNamedTargetProbes(entry("LAW_031"), { catalogue: altered });
    assert.ok(!p.cases.some((c) => c.probe.damagePreparation !== undefined));
    assert.ok(p.uncovered.some((o) => o.id.endsWith("attacker-departure")));
  }
});

test("named damage complete source plans carry actual Ambush, chooser and identity boundaries",()=>{
 const {classifyNamedDamage}=require("../pipeline/named-target-probes");
 for(const id of ["SEC_030","TS26_029"]){const e=entry(id),p=planNamedTargetProbes(e,{catalogue});assert.ok(classifyNamedDamage(e));assert.ok(p.cases.some(c=>c.probe.sourceSeat===2));for(const suffix of ["paired-shields-self-first","paired-shields-opponent-first","paired-wounded-death-self-first","paired-wounded-death-opponent-first"])assert.ok(p.cases.some(c=>c.name.endsWith(suffix)));assert.ok(p.uncovered.some(c=>c.id.endsWith(":repeated-nonunique-source-copies")));for(const c of p.cases.filter(c=>c.probe.expectForce))assert.ok(c.probe.forceDonorIndices.length);}
 const p=planNamedTargetProbes(entry("TS26_029"),{catalogue});for(const name of ["actual-ambush-accept","actual-ambush-decline","actual-ambush-empty-enemy","attacker-self-lethal-real-damage","unique-keep-old","unique-keep-new"])assert.ok(p.cases.some(c=>c.name.endsWith(name)));
});
test("named damage source metadata and unmodeled domains fail closed",()=>{
 const {classifyNamedDamage}=require("../pipeline/named-target-probes");
 for(const change of [e=>e.card.types.push("leader"),e=>e.card.unique="yes",e=>e.card.arena="space",e=>e.abilities.unit.push({trigger:"whenPlayed"}),e=>e.abilities.card[0].targetResolvers[0].name={},e=>e.abilities.card[0].targetResolvers[1].chooser="opponent",e=>e.abilities.card[0].targetResolvers[0].effect.amount.value=3,e=>e.abilities.card[0].targetResolvers[1].targetResolver.arena="space",e=>e.card.unique=true]){const e=entry("SEC_030");change(e);assert.equal(classifyNamedDamage(e),null);}
 const e=entry("TS26_029");e.card.power=0.5;assert.equal(classifyNamedDamage(e),null);
});
test("named damage preparation requires complete event donor without hidden mechanics",()=>{
 for(const change of [e=>e.abilities.unit.push({trigger:"whenPlayed"}),e=>e.card.pilotText="Piloting 1",e=>e.attachCondition={kind:"const",value:true},e=>e.card.keywords.push("plot")]){const c=structuredClone(catalogue),d=c.cards.find(e=>e.setCode==="IBH_061");change(d);const p=planNamedTargetProbes(entry("TS26_029"),{catalogue:c});assert.ok(!p.cases.some(c=>c.probe.preparationCode));assert.ok(p.uncovered.some(c=>c.id.endsWith(":attacker-self-lethal")));}
});
