"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {classifyArenaToken} = require("../pipeline/arena-token-probes");
const fs = require("node:fs");
const path = require("node:path");
const catalogue = JSON.parse(fs.readFileSync(process.env.SWU_PROBE_TEST_CATALOGUE ?? path.resolve(__dirname,"../../card-compiler/generated/catalog.json"))).cards;
const copy = value => JSON.parse(JSON.stringify(value));
const examples = ["ASH_064", "SEC_119", "SEC_252", "SOR_037"].map(code => catalogue.find(e => e.setCode === code));
test("four complete structural token families classify", () => {
    assert.deepEqual(examples.map(e => classifyArenaToken(e)?.mode), ["shielded", "other-friendly", "rebel-death", "damaged"]);
});
test("malformed ordinary metadata fails closed", () => {
    for (const original of examples) for (const change of [e => delete e.card.unique, e => e.card.unique = 1,
        e => e.card.traits = null, e => e.card.aspects = [null], e => e.baseClass = "EventCard",
        e => e.sourceHash = null, e => e.piloting = false, e => e.card.pilotText = false]) {
        const e = copy(original); change(e); assert.equal(classifyArenaToken(e), null);
    }
});
test("extra registrar and ability semantics reject", () => {
    for (const original of examples) for (const change of [e => e.abilities.card[0].optional = true,
        e => e.abilities.card[0].condition = {kind:"const", value:true},
        e => e.abilities.card[0].ifYouDo = {effect:{kind:"draw", amount:{kind:"const", value:1}}},
        e => e.abilities.leader.push({trigger:"action"}), e => e.abilities.card.push(copy(e.abilities.card[0])),
        e => e.abilities.card[0] = null]) {
        const e = copy(original); change(e); assert.equal(classifyArenaToken(e), null);
    }
});
test("amount, owner and predicate widening reject", () => {
    for (const original of examples) for (const change of [e => e.abilities.card[0].effect.amount.value = 2,
        e => e.abilities.card[0].effect.target.receiver.path = ["opponent"],
        e => e.abilities.card[0].effect.target.predicate = {kind:"const", value:true},
        e => e.card.keywords.push("ambush"), e => e.keywordValues.hidden = 1]) {
        const e = copy(original); change(e); assert.equal(classifyArenaToken(e), null);
    }
});

test("constructed source arenas and uniqueness fail closed", () => {
    for (const original of examples.slice(0,3)) {const e=copy(original);e.card.unique=false;assert.equal(classifyArenaToken(e),null);}
    const space=copy(examples[3]);space.card.arena="space";assert.equal(classifyArenaToken(space),null);
});
test("native Experience requires the exact reviewed outer contract", () => {
    const {nativeExperience}=require("../pipeline/arena-token-probes");
    const original=catalogue.find(e=>e.setCode==="TOKEN_EXPERIENCE");assert.equal(nativeExperience(original),true);
    for (const change of [e=>e.status="supported",e=>e.attachCondition={kind:"const",value:true},e=>e.piloting=false,
        e=>e.card.pilotText=false,e=>e.setCode="TOKEN_FAKE",e=>e.sourceHash="0".repeat(64),e=>e.card.upgradeHp=2]) {
        const e=copy(original);change(e);assert.equal(nativeExperience(e),false);
    }
});
test("quiet donor provenance and malformed metadata reject", () => {
    const {quietUnit}=require("../pipeline/arena-token-probes");
    const original=catalogue.find(e=>quietUnit(e));assert.ok(original);
    for (const change of [e=>e.card.unique=undefined,e=>e.card.cost=-1,e=>e.card.cost=NaN,e=>e.card.text=5,e=>e.abilities=null,
        e=>e.baseClass="EventCard",e=>e.sourcePath="",e=>e.card.pilotBox=false,e=>e.card.keywords.push("hidden")]) {
        const e=copy(original);change(e);assert.equal(quietUnit(e),false);
    }
});

test("source-derived entry title chooses renamed structural bulk correctly", () => {
    const {entryChoice}=require("../pipeline/arena-token-probe-fixture");
    const original=copy(examples[0]);original.abilities.card[0].title="Protect the qualifying units";
    const shape=classifyArenaToken(original);assert.ok(shape);
    const actions=[{kind:"button",label:"Shielded"},{kind:"button",label:"Protect the qualifying units"}];
    assert.equal(entryChoice(actions,{...shape,entryOrder:"bulk"}),actions[1]);
    assert.equal(entryChoice(actions,{...shape,entryOrder:"shielded"}),actions[0]);
});
test("all current plans roundtrip immutable library definitions and dependency closure", () => {
    const {planArenaTokenProbes}=require("../pipeline/arena-token-probes");
    const library=require("../reference/library");
    const core=require("../pipeline/probe-fixture");
    const all=examples.flatMap(e=>planArenaTokenProbes(e,{catalogue}).cases);
    assert.equal(all.length,68);
    for(const scenario of all) assert.deepEqual(library.definition(scenario.id,library.registry(),scenario),scenario);
    for(const dependency of ["bot/cards/pipeline/arena-token-probes.js","bot/cards/pipeline/arena-token-probe-fixture.js","bot/omni/rs/make-pool.js"])
        assert.ok(core.dependencies.includes(dependency),dependency);
});

test("ordinary upgrade holder compatibility and leader source class remain bounded", () => {
    const {ordinaryUpgrade,leaderDonor}=require("../pipeline/arena-token-probes");
    const upgrade=catalogue.find(ordinaryUpgrade),leader=catalogue.find(leaderDonor);
    assert.ok(upgrade);assert.ok(leader);
    for (const mutate of [e=>e.abilities.card.push({trigger:"whenPlayed"}),e=>e.card.unique=true,
        e=>e.attachCondition.right.right.value="4",e=>e.attachCondition.left.args=[{kind:"const",value:1}],e=>e.piloting=false]) {
        const e=copy(upgrade);mutate(e);assert.equal(ordinaryUpgrade(e),false);
    }
    for (const mutate of [e=>e.baseClass="EventCard",e=>e.card.hp="5",e=>e.card.power=2.5,e=>e.card.pilotText=false,
        e=>e.abilities.unit[0].optional=true,e=>e.abilities.leader[0].effect.amount.value=2]) {
        const e=copy(leader);mutate(e);assert.equal(leaderDonor(e),false);
    }
});

test("Rebel death uniqueness requires the source itself to be Rebel", () => {
    const e=copy(examples[2]);e.card.traits=e.card.traits.filter(t=>t!=="rebel");
    assert.equal(classifyArenaToken(e),null);
});
