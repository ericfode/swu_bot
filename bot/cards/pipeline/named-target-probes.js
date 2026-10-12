"use strict";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (a, allowed) =>
  a && Object.keys(a).every((k) => allowed.includes(k));
function classifyNamedTarget(entry) {
  const mixed = classifyNamedMixed(entry);
  if (mixed) return mixed;
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
    const unitBase = classifyNamedUnitBaseDamage(entry);
    if (unitBase) return planNamedUnitBaseDamage(entry, unitBase, options);
    const damage = classifyNamedDamage(entry);
    if (damage) return planNamedDamageProbes(entry, damage, options);
  const shape = classifyNamedTarget(entry);
  if (!shape) return null;
  if (shape.mixedKind) return planMixedEvent(entry, shape, options);
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
module.exports = { classifyNamedTarget, classifyNamedDamage, classifyNamedUnitBaseDamage, planNamedTargetProbes };

function classifyNamedDamage(entry) {
    const abilities=Object.values(entry.abilities??{}).flat(),a=abilities[0],kw=entry.keywordValues??{};
    const ambush=same(kw,{ambush:1});
    if(entry.status!=='supported'||typeof entry.card?.unique!=='boolean'||entry.baseClass!=='NonLeaderUnitCard'||!same(entry.card?.types,['unit'])||abilities.length!==1||entry.abilities.card?.length!==1||!['ground','space'].includes(entry.card.arena)||entry.attachCondition||entry.card.pilotText||entry.card.pilotBox||entry.card.pilotingBox||entry.piloting||
        !keys(a,['trigger','title','costs','effect','targetResolvers'])||typeof a.title!=='string'||!['whenPlayed','onAttack'].includes(a.trigger)||!same(a.costs,[])||!same(a.effect,{kind:'noAction'})||a.targetResolvers?.length!==2||
        !(same(kw,{})||a.trigger==='onAttack'&&ambush)||!same(entry.card.keywords??[],ambush?['ambush']:[]))return null;
    const descriptors=[];
    for(const [i,d]of a.targetResolvers.entries()) {
        const r=d?.targetResolver,e=d?.effect;
        if(!keys(d,['name','chooser','targetResolver','effect'])||typeof d.name!=='string'||!d.name||!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(d.name)||['target','constructor','prototype','__proto__'].includes(d.name)||d.chooser!=='self'||
            !keys(r,['owner','type','zone','arena','optional'])||r.owner!==(i?'opponent':'self')||r.type!=='unit'||!['arena','anyAttackable'].includes(r.zone)||r.optional===true||r.optional!==undefined&&r.optional!==false||r.arena!==undefined&&!['ground','space'].includes(r.arena)||
            !keys(e,['kind','target','amount'])||e.kind!=='damage'||e.target!=='chosen'||!keys(e.amount,['kind','value'])||e.amount.kind!=='const'||![1,2].includes(e.amount.value))return null;
        descriptors.push({name:d.name,owner:r.owner,arena:r.arena,amount:e.amount.value});
    }
    if(a.trigger==='whenPlayed'&&entry.card.unique||(!Number.isInteger(entry.card.power)||entry.card.power<0||!Number.isInteger(entry.card.hp)||entry.card.hp<1))return null;
    if(descriptors[0].name===descriptors[1].name||entry.card.arena!=='ground'||descriptors.some(d=>a.trigger==='whenPlayed'?d.arena!=='ground':d.arena!==undefined))return null;
    return {family:'named-target',effectFamily:'damage',trigger:a.trigger,descriptors,ambush,defaultPromptTitle:a.title};
}
function planNamedDamageProbes(entry,shape,options={}) {
    const defs=(Array.isArray(options.catalogue)?options.catalogue:options.catalogue?.cards??[]).slice().sort((a,b)=>a.setCode.localeCompare(b.setCode));
    const result={schema:'swu-card-probes/v1',cardId:entry.setCode,sourceHash:entry.sourceHash,cases:[],obligations:[],uncovered:[]};
    const obligation=(dimension,reason)=>{const id=`${entry.setCode}:named-target-damage:${dimension}`;result.obligations.push({id,path:'named-target',dimension});if(reason)result.uncovered.push({id,path:'named-target',reason});return id;};
    const ordinary=e=>e.status==='supported'&&(!e.baseClass||e.baseClass==='NonLeaderUnitCard')&&same(e.card.types,['unit'])&&!e.card.unique&&!e.card.keywords?.length&&!Object.keys(e.keywordValues??{}).length&&!e.card.pilotText&&!e.card.pilotBox&&!e.card.pilotingBox&&!e.piloting&&!e.attachCondition;
    const quiet=defs.filter(e=>ordinary(e)&&!Object.values(e.abilities??{}).flat().length);
    const ground=quiet.find(e=>e.card.arena==='ground'&&e.card.hp>=6&&e.card.power<=2),space=quiet.find(e=>e.card.arena==='space'&&e.card.hp>=4&&e.card.power<=2);
    if(!ground||!space){obligation('quiet-donors','Missing bounded quiet real recipients in both arenas');return result;}
    const row=(e,owner,damage=0)=>({code:e.setCode,owner,arena:e.card.arena,exhausted:false,damage});
    const mixed=[row(ground,'self'),row(ground,'opponent'),row(space,'self'),row(space,'opponent')];
    const add=(name,extra={},targets=mixed)=>{const id=obligation(name);const setup=[...targets.map(t=>t.code),...targets.flatMap(t=>(t.attachments??[]).map(a=>a.code)),...(extra.preparationCode?[extra.preparationCode]:[]),...(extra.expectForce?['TOKEN_THE_FORCE']:[]),...(extra.expectClone?['TOKEN_CLONE_TROOPER']:[])];result.cases.push({id:`auto/${entry.setCode}/named-target-damage-${name}`,name:`named-target-damage-${name}`,kind:'probe',focusCardIds:[entry.setCode],setupCardIds:[...new Set(setup)].sort(),behaviorIds:['named-targets','damage',shape.trigger==='onAttack'?'on-attack':'when-played'],assertionStages:['construction','activation','observation'],coverageObligationIds:[id],probe:{...shape,cardId:entry.setCode,sourceTypes:entry.card.types,sourceArena:entry.card.arena,sourceUnique:!!entry.card.unique,sourceSeat:1,targets,choices:['index:0','index:1'],attackTarget:1,activationMode:'normal',initiative:'self',resourceCount:32,...extra}});};
    add('owner-arena-domain');add('opposite-source-controller',{sourceSeat:2,initiative:'opponent'});
    const tokens=(targets,n)=>targets.map((t,i)=>({...t,...(i<2?{attachments:Array.from({length:n},()=>({code:'TOKEN_SHIELD',token:'shield'}))}:{})}));
    for(const opponentFirst of [false,true])add('paired-shields-'+(opponentFirst?'opponent-first':'self-first'),{opponentFirst,attackBase:true},tokens(mixed,2));
    add('one-side-shield',{attackBase:true},mixed.map((t,i)=>({...t,...(i===0?{attachments:[{code:'TOKEN_SHIELD',token:'shield'}]}:{})})));
    const gain=defs.find(e=>ordinary(e)&&e.card.arena===entry.card.arena&&e.abilities.card?.length===2&&Object.values(e.abilities??{}).flat().length===2&&e.abilities.card.every(a=>keys(a,['trigger','title','costs','effect'])&&same(a.costs,[])&&same(a.effect,{kind:'gainForce',target:'ownPlayer'}))&&same(e.abilities.card.map(a=>a.trigger),['onAttack','whenDefeated']));
    if(gain){for(const opponentFirst of [false,true])add('paired-wounded-death-'+(opponentFirst?'opponent-first':'self-first'),{expectForce:true,forceDonorIndices:[0,1],opponentFirst,attackBase:true},[row(gain,'self',gain.card.hp-1),row(gain,'opponent',gain.card.hp-1)]);}else obligation('paired-captured-death','No complete scalar mandatory gainForce death donor');
    if(shape.trigger==='whenPlayed') {
        add('entering-source',{choices:['source','index:1']});
        add('empty-enemy',{choices:['source','absent']},[]);
        add('wrong-space-only',{choices:['source','absent']},[row(space,'self'),row(space,'opponent')]);
    }else {
        if(shape.ambush){add('actual-ambush-accept',{activationMode:'ambush'});add('actual-ambush-decline',{activationMode:'decline'});add('actual-ambush-empty-enemy',{activationMode:'empty'},[row(ground,'self')]);}
        add('source-recipient',{choices:['source','index:1']});add('defender-recipient',{choices:['index:0','defender']});
        if(gain)add('wounded-defender-captured-death',{choices:['index:0','defender'],expectForce:true,forceDonorIndices:[1],expectDefenderDeparture:true},[row(ground,'self'),row(gain,'opponent',gain.card.hp-1)]);
        const defense=defs.find(e=>ordinary(e)&&e.card.arena===entry.card.arena&&e.abilities.card?.length===1&&Object.values(e.abilities??{}).flat().length===1&&keys(e.abilities.card[0],['trigger','title','costs','effect'])&&e.abilities.card[0].trigger==='onDefense'&&same(e.abilities.card[0].costs,[])&&same(e.abilities.card[0].effect,{kind:'createTokenUnit',tokenType:'cloneTrooper',amount:{kind:'const',value:1},target:'ownPlayer',entersReady:false}));
        if(defense)for(const opponentFirst of [false,true])add('captured-defense-'+(opponentFirst?'defender-first':'attacker-first'),{choices:['index:0','defender'],expectClone:true,opponentFirst,expectDefenderDeparture:true},[row(ground,'self'),row(defense,'opponent',defense.card.hp-1)]);
        else obligation('captured-defense','No complete scalar mandatory Clone onDefense donor');
        const prep=defs.find(e=>!e.attachCondition&&!e.piloting&&!e.card.pilotText&&!e.card.pilotBox&&!e.card.pilotingBox&&Object.values(e.abilities??{}).flat().length===1&&e.status==='supported'&&e.baseClass==='EventCard'&&same(e.card.types,['event'])&&!e.card.keywords?.length&&!Object.keys(e.keywordValues??{}).length&&e.abilities.card?.length===1&&keys(e.abilities.card[0],['trigger','title','costs','effect','targetResolver'])&&e.abilities.card[0].trigger==='event'&&same(e.abilities.card[0].costs,[])&&same(e.abilities.card[0].effect,{kind:'damage',target:'chosen',amount:{kind:'const',value:entry.card.hp-1}})&&same(e.abilities.card[0].targetResolver,{owner:'any',type:'unit',zone:'anyAttackable'}));
        if(prep)add('attacker-self-lethal-real-damage',{choices:['source','index:1'],preparationCode:prep.setCode,attackBase:true,expectSourceDeparture:true});else obligation('attacker-self-lethal','No actual scalar damage event to prepare source at remainingHP1');
        if(entry.card.unique)for(const keepUnique of ['old','new'])add('unique-keep-'+keepUnique,{keepUnique,activationMode:keepUnique==='new'?'ambush':'unique-departed'},[...mixed,{...row(entry,'self'),exhausted:true}]);
    }
    for(const gap of ['ordinary-and-native-attachment-death-cleanup','repeated-nonunique-source-copies','token-deployed-leader-recipients','source-control-transfer','recipient-reentry','framework-aura-death','gained-overwhelm','multiplayer'])obligation(gap,'No full-card construction for this dimension; source and primitive diagnostics are separate');
    return result;
}

function classifyNamedMixed(entry) {
  const a = entry.abilities?.card?.[0];
  const all = Object.values(entry.abilities ?? {}).flat();
  if (
    entry.status !== "supported" ||
    entry.baseClass !== "EventCard" ||
    !same(entry.card?.types, ["event"]) ||
    all.length !== 1 ||
    entry.abilities.card?.length !== 1 ||
    entry.card.keywords?.length ||
    Object.keys(entry.keywordValues ?? {}).length ||
    entry.card.pilotText ||
    entry.card.pilotBox ||
    entry.card.pilotingBox ||
    entry.piloting ||
    entry.attachCondition ||
    !keys(a, ["trigger", "title", "costs", "effect", "targetResolvers"]) ||
    a.trigger !== "event" ||
    !same(a.costs, []) ||
    !same(a.effect, { kind: "noAction" }) ||
    !Array.isArray(a.targetResolvers) ||
    a.targetResolvers.length !== 2
  )
    return null;
  for (const d of a.targetResolvers) {
    if (
      !keys(d, ["name", "chooser", "targetResolver", "effect"]) ||
      typeof d.name !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(d.name) ||
      ["target", "constructor", "prototype", "__proto__"].includes(d.name) ||
      d.chooser !== "self"
    )
      return null;
  }
  if (a.targetResolvers[0].name === a.targetResolvers[1].name) return null;
  const [first, second] = a.targetResolvers;
  const any = (r) =>
    keys(r, ["owner", "type", "zone", "promptTitle"]) &&
    r.owner === "any" &&
    r.type === "unit" &&
    r.zone === "anyAttackable" &&
    typeof r.promptTitle === "string";
  const shield = {
    kind: "giveShield",
    target: "chosen",
    amount: { kind: "const", value: 1 },
  };
  let mixedKind;
  if (
    any(first.targetResolver) &&
    any(second.targetResolver) &&
    same(first.effect, { kind: "ready", target: "chosen" }) &&
    same(second.effect, {
      kind: "damage",
      target: "chosen",
      amount: { kind: "const", value: 3 },
    })
  )
    mixedKind = "ready-damage";
  if (
    any(first.targetResolver) &&
    any(second.targetResolver) &&
    same(first.effect, shield) &&
    same(second.effect, {
      kind: "modifyStats",
      target: "chosen",
      duration: "phase",
      power: { kind: "unary", op: "-", value: { kind: "const", value: 3 } },
      hp: { kind: "unary", op: "-", value: { kind: "const", value: 0 } },
    })
  )
    mixedKind = "shield-debuff";
  const cheap = {
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
      op: "<=",
      left: { kind: "ref", path: ["card", "cost"] },
      right: { kind: "const", value: 3 },
    },
  };
  if (
    same(first.targetResolver, {
      owner: "opponent",
      type: "any",
      zone: "arena",
    }) &&
    same(second.targetResolver, {
      owner: "self",
      type: "any",
      zone: "anyAttackable",
      predicate: cheap,
    }) &&
    same(first.effect, { kind: "exhaust", target: "chosen" }) &&
    same(second.effect, shield)
  )
    mixedKind = "exhaust-cheap-shield";
  if (!mixedKind) return null;
  return {
    family: "named-target",
    trigger: "event",
    mixedKind,
    descriptors: a.targetResolvers.map((d) => ({
      name: d.name,
      promptTitle: d.targetResolver.promptTitle,
      owner: d.targetResolver.owner,
      effect: d.effect,
    })),
  };
}
function planMixedEvent(entry, shape, options) {
  const defs = Array.isArray(options.catalogue)
    ? options.catalogue
    : options.catalogue?.cards ?? [];
  const quiet = defs
    .filter(
      (e) =>
        e.status === "supported" &&
        (!e.baseClass || e.baseClass === "NonLeaderUnitCard") &&
        same(e.card.types, ["unit"]) &&
        !e.card.unique &&
        !e.card.keywords?.length &&
        !e.card.pilotText &&
        !e.card.pilotBox &&
        !e.card.pilotingBox &&
        !e.piloting &&
        !e.attachCondition &&
        !Object.keys(e.keywordValues ?? {}).length &&
        !Object.values(e.abilities ?? {}).flat().length,
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
    (e) => e.card.arena === "ground" && e.card.hp > 3 && e.card.cost <= 3,
  );
  const space = quiet.find((e) => e.card.arena === "space" && e.card.hp > 3);
  const expensive = quiet.find((e) => e.card.cost === 4 && e.card.hp > 3);
  const cheapThree = quiet.find((e) => e.card.cost === 3 && e.card.hp > 3);
  if (!ground || !space || !expensive || !cheapThree) {
    obligation(
      "metadata-donors",
      "No bounded quiet donor for required arena/cost boundaries",
    );
    return result;
  }
  const row = (e, owner, exhausted = true, damage = 0) => ({
    code: e.setCode,
    owner,
    arena: e.card.arena,
    exhausted,
    damage,
  });
  const mixed = [
    row(ground, "self"),
    row(ground, "opponent", false),
    row(space, "self", false),
    row(space, "opponent"),
  ];
  function add(name, targets, choices, extra = {}) {
    const id = obligation(name);
    result.cases.push({
      id: `auto/${entry.setCode}/named-target-mixed-${name}`,
      name: "named-target-mixed-" + name,
      kind: "probe",
      focusCardIds: [entry.setCode],
      setupCardIds: [
        ...new Set([
          ...targets.map((t) => t.code),
          ...targets.flatMap((t) => (t.attachments ?? []).map((a) => a.code)),
          ...(shape.mixedKind.includes("shield") ? ["TOKEN_SHIELD"] : []),
          ...(extra.expectDeathForce || extra.leaderCode
            ? ["TOKEN_THE_FORCE"]
            : []),
        ]),
      ].sort(),
      behaviorIds: [
        "named-targets",
        "independent-systems",
        "prepayment-selection",
      ],
      assertionStages: ["construction", "activation", "observation"],
      coverageObligationIds: [id],
      probe: {
        ...shape,
        cardId: entry.setCode,
        sourceTypes: entry.card.types,
        sourceArena: entry.card.arena,
        targets,
        choices,
        resourceCount: 32,
        initiative: "self",
        ...extra,
      },
    });
  }
  add("different-recipients", mixed, ["index:3", "index:0"]);
  add("cancel-first", mixed, ["cancel", "index:0"]);
  add("cancel-second", mixed, ["index:3", "cancel"]);
  add("empty-play-anyway", [], [], { empty: true });
  add("empty-cancel", [], [], { empty: true, cancelEmpty: true });
  if (shape.mixedKind === "exhaust-cheap-shield") {
    add(
      "missing-enemy-second-after-payment",
      [row(ground, "self")],
      ["skip", "index:0"],
    );
    add(
      "missing-own-shield",
      [row(ground, "opponent", false)],
      ["index:0", "skip"],
    );
    const allExhausted = [row(ground, "opponent"), row(ground, "self")];
    add("all-enemy-exhausted-cancel-second", allExhausted, ["skip", "cancel"]);
    add("all-enemy-exhausted-continue", allExhausted, ["skip", "index:1"]);
    add(
      "all-enemy-exhausted-no-friendly-shield",
      [row(ground, "opponent")],
      ["skip", "skip"],
    );
    add("selected-ineffective-exhaust", mixed, ["index:3", "index:0"]);
    add("effective-exhaust", mixed, ["index:1", "index:0"]);
    add("created-shield-later-combat", mixed, ["index:1", "index:0"], {
      followAttack: { attacker: 1, defender: 0 },
    });
    add(
      "cost-three-four-domain",
      [
        row(ground, "opponent", false),
        row(cheapThree, "self"),
        row(expensive, "self"),
      ],
      ["index:0", "index:1"],
    );
    const beast = defs.find((e) => e.setCode === "TOKEN_BEAST");
    if (beast)
      add(
        "native-beast-zero-cost",
        [
          row(ground, "opponent", false),
          { ...row(beast, "self"), token: "beast" },
        ],
        ["index:0", "index:1"],
      );
    const leader = defs
      .filter(
        (e) =>
          e.status === "supported" &&
          e.baseClass === "LeaderUnitCard" &&
          same(e.card.types, ["leader"]) &&
          Number.isInteger(e.card.cost) &&
          e.card.cost > 3 &&
          ["ground", "space"].includes(e.card.arena) &&
          !e.card.keywords?.length &&
          !e.card.pilotText &&
          !e.card.pilotBox &&
          !e.card.pilotingBox &&
          !e.piloting &&
          !e.attachCondition &&
          !Object.keys(e.keywordValues ?? {}).length &&
          same(e.abilities.card, []) &&
          e.abilities.leader?.length === 1 &&
          e.abilities.unit?.length === 1 &&
          keys(e.abilities.leader[0], [
            "trigger",
            "title",
            "costs",
            "effect",
          ]) &&
          e.abilities.leader[0].trigger === "action" &&
          same(e.abilities.leader[0].costs, [{ kind: "exhaustSelf" }]) &&
          same(e.abilities.leader[0].effect, {
            kind: "damage",
            target: "bothBases",
            amount: { kind: "const", value: 1 },
          }) &&
          keys(e.abilities.unit[0], ["trigger", "title", "costs", "effect"]) &&
          e.abilities.unit[0].trigger === "onAttack" &&
          same(e.abilities.unit[0].costs, []) &&
          same(e.abilities.unit[0].effect, {
            kind: "damage",
            target: "enemyBase",
            amount: { kind: "const", value: 1 },
          }),
      )
      .sort((a, b) => a.setCode.localeCompare(b.setCode))[0];
    if (leader)
      add(
        "deployed-leader-cost-exclusion",
        [
          row(ground, "opponent", false),
          row(ground, "self"),
          { ...row(leader, "self"), leader: true },
        ],
        ["index:0", "index:1"],
        { leaderCode: leader.setCode },
      );
    else
      obligation(
        "deployed-leader-cost-exclusion",
        "No quiet unit-side leader metadata donor",
      );
  } else {
    add("same-own-recipient", mixed, ["index:0", "index:0"]);
    add("same-enemy-recipient", mixed, ["index:3", "index:3"]);
    add("enemy-first-own-second", mixed, ["index:3", "index:0"]);
    add("own-first-enemy-second", mixed, ["index:0", "index:1"]);
    if (shape.mixedKind === "ready-damage") {
      const allReady = mixed.map((t) => ({ ...t, exhausted: false }));
      add("all-ready-cancel-second", allReady, ["skip", "cancel"]);
      add("all-ready-continue", allReady, ["skip", "index:0"]);
      add("selected-ineffective-ready", mixed, ["index:1", "index:0"]);
      const hpThree = quiet.find((e) => e.card.hp === 3);
      if (hpThree)
        add(
          "same-recipient-lethal",
          [row(hpThree, "self")],
          ["index:0", "index:0"],
        );
      const shielded = [row(ground, "opponent")];
      shielded[0].attachments = [{ code: "TOKEN_SHIELD", token: "shield" }];
      add("existing-shield-prevents-damage", shielded, ["index:0", "index:0"]);
      const gain = defs.find(
        (e) =>
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
          !e.attachCondition &&
          same(e.abilities.leader, []) &&
          same(e.abilities.unit, []) &&
          e.abilities.card?.length === 2 &&
          same(
            e.abilities.card.map((a) => a.trigger),
            ["onAttack", "whenDefeated"],
          ) &&
          e.abilities.card.every(
            (a) =>
              keys(a, ["trigger", "title", "costs", "effect"]) &&
              same(a.costs, []) &&
              same(a.effect, { kind: "gainForce", target: "ownPlayer" }),
          ) &&
          e.card.hp === 3,
      );
      if (gain) {
        add(
          "same-recipient-captured-death",
          [row(gain, "opponent")],
          ["index:0", "index:0"],
          { expectDeathForce: true },
        );
        const attached = row(gain, "opponent", true, 1);
        attached.attachments = [
          { code: "TOKEN_EXPERIENCE", token: "experience" },
        ];
        add(
          "lethal-native-attachment-cleanup",
          [attached],
          ["index:0", "index:0"],
          { expectDeathForce: true },
        );
        const ordinary = defs.find(
          (e) =>
            e.status === "supported" &&
            e.baseClass === "UpgradeCard" &&
            same(e.card.types, ["upgrade"]) &&
            !e.card.unique &&
            !e.card.keywords?.length &&
            !Object.keys(e.keywordValues ?? {}).length &&
            !e.card.pilotText &&
            !e.card.pilotBox &&
            !e.card.pilotingBox &&
            !e.piloting &&
            !Object.values(e.abilities ?? {}).flat().length &&
            Number.isInteger(e.card.upgradePower) &&
            e.card.upgradePower >= 0 &&
            e.card.upgradeHp === 1 &&
            same(e.attachCondition, {
              kind: "binary",
              op: "&&",
              left: {
                kind: "query",
                name: "hasCost",
                receiver: { kind: "ref", path: ["card"] },
                args: [],
              },
              right: {
                kind: "binary",
                op: "<=",
                left: { kind: "ref", path: ["card", "cost"] },
                right: { kind: "const", value: 4 },
              },
            }) &&
            gain.card.cost <= 4,
        );
        if (ordinary) {
          const both = row(gain, "opponent", true, 2);
          both.attachments = [
            { code: ordinary.setCode, owner: "self" },
            { code: "TOKEN_EXPERIENCE", token: "experience" },
          ];
          add(
            "lethal-cross-owner-ordinary-native-cleanup",
            [both],
            ["index:0", "index:0"],
            { expectDeathForce: true, ordinaryCleanup: true },
          );
        }
      }
    } else {
      add("phase-expiry", mixed, ["index:0", "index:1"], {
        waitForExpiry: true,
      });
      add("created-shield-later-combat", mixed, ["index:0", "index:2"], {
        followAttack: { attacker: 1, defender: 0 },
      });
      const clamp = quiet.find(
        (e) => e.card.power > 0 && e.card.power < 3 && e.card.hp > 3,
      );
      if (clamp)
        add(
          "negative-power-clamp",
          [row(clamp, "opponent")],
          ["index:0", "index:0"],
        );
      const beast = defs.find((e) => e.setCode === "TOKEN_BEAST");
      if (beast)
        add(
          "native-unit-recipient",
          [{ ...row(beast, "opponent"), token: "beast" }],
          ["index:0", "index:0"],
        );
    }
  }
  for (const gap of [
    "source-semantic-review",
    "reversed-source-seats",
    "shield-later-combat-consumption",
    "ordinary-attachment-death-cleanup",
    "replacement-token-cancellation",
    "recipient-departure-during-selection",
    "multiplayer",
    "source-controller-transfer",
  ]) {
    if (
      (gap === "shield-later-combat-consumption" &&
        result.cases.some((c) => c.probe.followAttack)) ||
      (gap === "ordinary-attachment-death-cleanup" &&
        result.cases.some((c) => c.probe.ordinaryCleanup))
    )
      continue;
    obligation(
      gap,
      "No actual source-card construction for this dimension; primitive diagnostics are separate",
    );
  }
  return result;
}

function classifyNamedUnitBaseDamage(entry) {
  const a = entry.abilities?.card?.[0];
  if (entry.status !== 'supported' || entry.baseClass !== 'NonLeaderUnitCard' ||
      !same(entry.card?.types, ['unit']) || entry.card.arena !== 'space' ||
      typeof entry.card.unique !== 'boolean' || !Number.isInteger(entry.card.power) || entry.card.power < 1 ||
      !Number.isInteger(entry.card.hp) || entry.card.hp < 1 ||
      Object.values(entry.abilities ?? {}).flat().length !== 1 ||
      entry.attachCondition || entry.piloting || entry.card.pilotText || entry.card.pilotBox || entry.card.pilotingBox ||
      !same(entry.keywordValues ?? {}, {}) || !same(entry.card.keywords ?? [], []) ||
      !keys(a, ['trigger','title','costs','effect','targetResolvers']) || a.trigger !== 'onAttack' ||
      typeof a.title !== 'string' || !same(a.costs, []) || !same(a.effect, {kind:'noAction'}) || a.targetResolvers?.length !== 2) return null;
  const descriptors = [];
  for (const [i,d] of a.targetResolvers.entries()) {
    const r = d?.targetResolver;
    if (!keys(d,['name','chooser','targetResolver','effect']) || typeof d.name !== 'string' ||
        !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(d.name) || ['target','constructor','prototype','__proto__'].includes(d.name) || d.chooser !== 'self' ||
        !keys(r,['owner','type','zone','arena','promptTitle']) || typeof r.promptTitle !== 'string' || !r.promptTitle ||
        !same(d.effect,{kind:'damage',target:'chosen',amount:{kind:'const',value:2}}) ||
        (i === 0 ? r.owner !== 'opponent' || r.type !== 'any' || r.zone !== 'arena' || r.arena !== 'ground' :
          r.owner !== 'any' || r.type !== 'base' || r.zone !== 'anyAttackable' || r.arena !== undefined)) return null;
    descriptors.push({name:d.name,promptTitle:r.promptTitle,amount:2,domain:i?'bases':'enemy-ground'});
  }
  if (descriptors[0].name === descriptors[1].name || descriptors[0].promptTitle === descriptors[1].promptTitle) return null;
  return {family:'named-target',effectFamily:'unit-base-damage',trigger:'onAttack',descriptors};
}

function planNamedUnitBaseDamage(entry, shape, options = {}) {
  const defs = Array.isArray(options.catalogue) ? options.catalogue : options.catalogue?.cards ?? [];
  const quiet = e => e.status === 'supported' && (e.baseClass === 'NonLeaderUnitCard' || (!e.baseClass && e.sourcePath === null && e.sourceHash === null && !e.card.text)) && same(e.card?.types,['unit']) &&
    !e.card.unique && !e.card.keywords?.length && !Object.keys(e.keywordValues ?? {}).length &&
    !Object.values(e.abilities ?? {}).flat().length && !e.attachCondition && !e.piloting && !e.card.pilotText && !e.card.pilotBox && !e.card.pilotingBox;
  const ground = defs.filter(quiet).sort((a,b)=>a.setCode.localeCompare(b.setCode)).find(e=>e.card.arena==='ground' && e.card.hp>=4);
  const space = defs.filter(quiet).sort((a,b)=>a.setCode.localeCompare(b.setCode)).find(e=>e.card.arena==='space' && e.card.hp>=entry.card.power+1 && e.card.power<entry.card.hp);
  const result = {schema:'swu-card-probes/v1',cardId:entry.setCode,sourceHash:entry.sourceHash,cases:[],obligations:[],uncovered:[]};
  const obligation = (dimension, reason) => {
    const id = `${entry.setCode}:named-unit-base-damage:${dimension}`;
    result.obligations.push({id,path:'named-target',dimension});
    if(reason) result.uncovered.push({id,path:'named-target',reason});
    return id;
  };
  if (!ground || !space) { obligation('quiet-donors','Missing real quiet ground/space construction donors'); return result; }
  const row=(e,owner,extra={})=>({code:e.setCode,owner,arena:e.card.arena,exhausted:true,...extra});
  const mixed=[row(ground,'self'),row(ground,'opponent'),row(space,'self'),row(space,'opponent')];
  const add=(name,extra={},targets=mixed)=>{
    const id=obligation(name);
    result.cases.push({id:`auto/${entry.setCode}/named-unit-base-damage-${name}`,name:`named-unit-base-damage-${name}`,kind:'probe',focusCardIds:[entry.setCode],
      setupCardIds:[...new Set([...targets.map(t=>t.code),...targets.flatMap(t=>(t.attachments??[]).map(a=>a.code)),...(extra.forceDeath?['TOKEN_THE_FORCE']:[])])].sort(),
      behaviorIds:['named-targets','damage','on-attack'],assertionStages:['construction','activation','observation'],coverageObligationIds:[id],
      probe:{...shape,cardId:entry.setCode,sourceArena:'space',targets,resourceCount:16,initiative:'self',sourceSeat:1,unitChoice:1,baseChoice:'enemy',attackBase:true,...extra}});
  };
  add('enemy-base'); add('own-base',{baseChoice:'own'}); add('opposite-source-controller',{sourceSeat:2,initiative:'opponent'});
  add('space-unit-combat',{attackBase:false,attackTarget:3});
  add('missing-ground',{},mixed.filter(t=>t.arena==='space'));
  add('wrong-owner-ground-only',{},mixed.filter(t=>t.owner==='self'));
  for (const n of [1,2]) add(`shield-${n}`,{},mixed.map((t,i)=>i===1?{...t,attachments:Array.from({length:n},()=>({code:'TOKEN_SHIELD',token:'shield'}))}:t));
  add('lethal-ground',{},mixed.map((t,i)=>i===1?{...t,damage:ground.card.hp-1}:t));
  const gain=defs.find(e=>e.status==='supported'&&e.baseClass==='NonLeaderUnitCard'&&same(e.card?.types,['unit'])&&e.card.arena==='ground'&&!e.card.unique&&!e.card.keywords?.length&&!Object.keys(e.keywordValues??{}).length&&!e.attachCondition&&!e.piloting&&!e.card.pilotText&&!e.card.pilotBox&&!e.card.pilotingBox&&Object.values(e.abilities??{}).flat().length===2&&same(e.abilities.card?.map(a=>a.trigger),['onAttack','whenDefeated'])&&e.abilities.card.every(a=>keys(a,['trigger','title','costs','effect'])&&same(a.costs,[])&&same(a.effect,{kind:'gainForce',target:'ownPlayer'})));
  if(gain) for(const enemyBaseDamage of [0,27]) add(enemyBaseDamage?'both-bases-lethal-latch':'own-base-lethal-captured-death',{baseChoice:'own',ownBaseDamage:28,enemyBaseDamage,forceDeath:true},[row(ground,'self'),row(gain,'opponent',{damage:gain.card.hp-1}),row(space,'opponent')]);
  else obligation('fatal-captured-death','No bounded actual gainForce death donor');
  for(const gap of ['unique-source-replacement','source-departure','deployed-leader-token-recipients','attachment-cleanup','captured-defense','gained-overwhelm','controller-transfer','multiplayer']) obligation(gap,'No actual full-source construction for this interaction');
  return result;
}
