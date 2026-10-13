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

test("three mixed independent mandatory source shapes receive actual menu and identity cases", () => {
  const expected = {
    SOR_218: "exhaust-cheap-shield",
    TS26_072: "ready-damage",
    TS26_081: "shield-debuff",
  };
  for (const [id, kind] of Object.entries(expected)) {
    assert.equal(classifyNamedTarget(entry(id)).mixedKind, kind);
    const p = planNamedTargetProbes(entry(id), { catalogue });
    for (const suffix of [
      "cancel-first",
      "cancel-second",
      "empty-play-anyway",
      "empty-cancel",
    ]) {
      assert.ok(p.cases.some((c) => c.name.endsWith(suffix)));
    }
    assert.ok(p.uncovered.some((o) => o.id.endsWith("reversed-source-seats")));
    for (const c of p.cases) {
      const counts = new Map([[id, 1]]);
      for (const t of c.probe.targets) {
        if (!t.token && !t.leader)
          counts.set(t.code, (counts.get(t.code) ?? 0) + 1);
        for (const a of t.attachments ?? [])
          if (!a.token) counts.set(a.code, (counts.get(a.code) ?? 0) + 1);
      }
      assert.ok([...counts.values()].every((n) => n <= 3));
    }
  }
  const asteroid = planNamedTargetProbes(entry("SOR_218"), { catalogue });
  for (const suffix of [
    "missing-enemy-second-after-payment",
    "all-enemy-exhausted-cancel-second",
    "all-enemy-exhausted-no-friendly-shield",
    "cost-three-four-domain",
    "native-beast-zero-cost",
    "deployed-leader-cost-exclusion",
    "created-shield-later-combat",
  ])
    assert.ok(asteroid.cases.some((c) => c.name.endsWith(suffix)));
  const fervor = planNamedTargetProbes(entry("TS26_072"), { catalogue });
  for (const suffix of [
    "all-ready-cancel-second",
    "selected-ineffective-ready",
    "existing-shield-prevents-damage",
    "same-recipient-captured-death",
    "lethal-cross-owner-ordinary-native-cleanup",
  ])
    assert.ok(fervor.cases.some((c) => c.name.endsWith(suffix)));
});
test("mixed metadata and root registrar scopes fail closed without throwing", () => {
  for (const id of ["SOR_218", "TS26_072", "TS26_081"])
    for (const change of [
      (e) => (e.baseClass = "NonLeaderUnitCard"),
      (e) => (e.card.types = ["unit"]),
      (e) => e.card.types.push("token"),
      (e) => (e.card.pilotText = "Piloting"),
      (e) => (e.card.pilotBox = "Piloting"),
      (e) => (e.card.pilotingBox = "Piloting"),
      (e) => (e.piloting = {}),
      (e) => (e.attachCondition = { kind: "const", value: true }),
      (e) => (e.keywordValues.saboteur = 1),
      (e) => e.card.keywords.push("saboteur"),
      (e) => e.abilities.unit.push({ trigger: "whenPlayed" }),
      (e) => (e.abilities.card[0].optional = true),
      (e) => e.abilities.card[0].costs.push({ kind: "exhaustSelf" }),
      (e) => (e.abilities.card[0].condition = { kind: "const", value: true }),
      (e) => (e.abilities.card[0].ifYouDo = { effect: { kind: "noAction" } }),
      (e) =>
        (e.abilities.card[0].effect = { kind: "simultaneous", effects: [] }),
    ]) {
      const e = entry(id);
      change(e);
      assert.equal(classifyNamedTarget(e), null);
    }
  const e = entry("TS26_072");
  e.abilities = { leader: [e.abilities.card[0]] };
  assert.equal(classifyNamedTarget(e), null);
});
test("mixed selectors reject optional, opponent chooser, reordered and dependent domains", () => {
  for (const id of ["SOR_218", "TS26_072", "TS26_081"])
    for (const change of [
      (e) => e.abilities.card[0].targetResolvers.reverse(),
      (e) => (e.abilities.card[0].targetResolvers[0].name = "target"),
      (e) =>
        (e.abilities.card[0].targetResolvers[0].name =
          e.abilities.card[0].targetResolvers[1].name),
      (e) => (e.abilities.card[0].targetResolvers[0].chooser = "opponent"),
      (e) =>
        (e.abilities.card[0].targetResolvers[0].targetResolver.optional = true),
      (e) => (e.abilities.card[0].targetResolvers[0].targetResolver.count = 2),
      (e) =>
        (e.abilities.card[0].targetResolvers[0].targetResolver.owner =
          "enemyPlayer"),
      (e) =>
        (e.abilities.card[0].targetResolvers[1].targetResolver.dependsOn =
          e.abilities.card[0].targetResolvers[0].name),
      (e) =>
        (e.abilities.card[0].targetResolvers[1].targetResolver.zone =
          "discard"),
      (e) => (e.abilities.card[0].targetResolvers[1].effect.extra = true),
    ]) {
      const e = entry(id);
      change(e);
      assert.equal(classifyNamedTarget(e), null);
    }
});
test("mixed numeric, predicate and operation grammar is bounded to constructed shapes", () => {
  for (const change of [
    (e) => (e.abilities.card[0].targetResolvers[1].effect.amount.value = 4),
    (e) => (e.abilities.card[0].targetResolvers[0].effect.kind = "exhaust"),
    (e) =>
      (e.abilities.card[0].targetResolvers[1].effect.amount = {
        kind: "ref",
        path: ["source", "power"],
      }),
  ]) {
    const e = entry("TS26_072");
    change(e);
    assert.equal(classifyNamedTarget(e), null);
  }
  for (const change of [
    (e) =>
      (e.abilities.card[0].targetResolvers[1].targetResolver.predicate.right.right.value = 4),
    (e) =>
      (e.abilities.card[0].targetResolvers[1].targetResolver.predicate.left.name =
        "hasCost"),
    (e) =>
      (e.abilities.card[0].targetResolvers[0].targetResolver.type = "unit"),
    (e) => (e.abilities.card[0].targetResolvers[1].effect.amount.value = 2),
  ]) {
    const e = entry("SOR_218");
    change(e);
    assert.equal(classifyNamedTarget(e), null);
  }
  for (const change of [
    (e) => (e.abilities.card[0].targetResolvers[1].effect.hp.value.value = 1),
    (e) => (e.abilities.card[0].targetResolvers[1].effect.power.op = "+"),
    (e) =>
      (e.abilities.card[0].targetResolvers[1].effect.duration = "persistent"),
    (e) => (e.abilities.card[0].targetResolvers[0].effect.amount.value = 2),
  ]) {
    const e = entry("TS26_081");
    change(e);
    assert.equal(classifyNamedTarget(e), null);
  }
});

test("staged deployed-leader donor fails closed to the inactive direct-action/OA shape", () => {
  for (const change of [
    (e) => (e.card.pilotText = "Piloting"),
    (e) => e.card.keywords.push("sentinel"),
    (e) => (e.keywordValues.sentinel = 1),
    (e) => (e.abilities.unit[0].condition = { kind: "const", value: true }),
    (e) => (e.abilities.unit[0].effect.extra = true),
    (e) => (e.abilities.leader[0].effect.extra = true),
    (e) =>
      e.abilities.unit.push({
        trigger: "constant",
        effect: { kind: "noAction" },
      }),
  ]) {
    const altered = structuredClone(catalogue);
    for (const e of altered.cards)
      if (
        e.card.types?.includes("leader") &&
        e.abilities.unit?.length &&
        e.abilities.leader?.length
      )
        change(e);
    const p = planNamedTargetProbes(entry("SOR_218"), { catalogue: altered });
    assert.ok(!p.cases.some((c) => c.probe.leaderCode));
    assert.ok(
      p.uncovered.some((o) => o.id.endsWith("deployed-leader-cost-exclusion")),
    );
  }
});

test('named enemy-ground and any-base damage retains bounded full-source plans',()=>{
 const {classifyNamedUnitBaseDamage}=require('../pipeline/named-target-probes');
 const e=entry('LAW_184');assert.ok(classifyNamedUnitBaseDamage(e));
 const p=planNamedTargetProbes(e,{catalogue});assert.equal(p.cases.length,11);
 for(const label of ['opposite-source-controller','space-unit-combat','missing-ground','shield-2','both-bases-lethal-latch'])assert.ok(p.cases.some(c=>c.name.endsWith(label)));
 assert.ok(p.uncovered.some(o=>o.id.endsWith('unique-source-replacement')));
});
test('named unit/base classifier rejects unmodeled headers domains metadata and effects',()=>{
 const {classifyNamedUnitBaseDamage}=require('../pipeline/named-target-probes');
 const mutate=[e=>e.abilities.card[0].targetResolvers[1].targetResolver.promptTitle=e.abilities.card[0].targetResolvers[0].targetResolver.promptTitle,e=>e.abilities.card[0].optional=true,e=>e.abilities.card[0].ifYouDo={effect:{kind:'noAction'}},e=>e.card.arena='ground',e=>e.card.pilotText='unmodeled',e=>e.keywordValues={raid:1},e=>e.card.keywords=['raid'],e=>e.baseClass='EventCard',e=>e.attachCondition={kind:'const',value:true},e=>e.abilities.unit.push(e.abilities.card[0]),e=>e.abilities.card[0].targetResolvers[0].chooser='opponent',e=>e.abilities.card[0].targetResolvers[0].targetResolver.owner='any',e=>e.abilities.card[0].targetResolvers[0].targetResolver.type='unit',e=>e.abilities.card[0].targetResolvers[0].targetResolver.arena='space',e=>e.abilities.card[0].targetResolvers[1].targetResolver.optional=true,e=>e.abilities.card[0].targetResolvers[1].effect.amount.value=3,e=>e.abilities.card[0].targetResolvers[1].name='target'];
 for(const f of mutate){const e=entry('LAW_184');f(e);assert.equal(classifyNamedUnitBaseDamage(e),null);}
});

test('named unit/base quiet donor guard rejects unmodeled source bodies',()=>{
 const altered=structuredClone(catalogue);
 for(const e of altered.cards)if(!e.baseClass){e.sourcePath='unmodeled.ts';e.card.text='Unmodeled body';}
 const p=planNamedTargetProbes(entry('LAW_184'),{catalogue:altered});assert.equal(p.cases.length,0);assert.ok(p.uncovered.some(o=>o.id.endsWith('quiet-donors')));
});
