"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {classifyBaseZone,planBaseZoneProbes,blankBase}=require("../pipeline/base-zone-probes");
const catalogue=JSON.parse(fs.readFileSync(process.env.SWU_PROBE_TEST_CATALOGUE??path.resolve(__dirname,"../../card-compiler/generated/catalog.json")));
const copy=x=>JSON.parse(JSON.stringify(x));
const examples=["TWI_019","TWI_028","HMW_007"].map(id=>catalogue.cards.find(e=>e.setCode===id));
test("three complete initial-slot families classify with all36 definitions",()=>{
    assert.deepEqual(examples.map(e=>classifyBaseZone(e)?.mode),["leader-hp","leader-power","leader-raid"]);
    assert.deepEqual(examples.map(e=>planBaseZoneProbes(e,{catalogue}).cases.length),[10,10,16]);
});
test("base raw metadata and printed body are exact",()=>{
    for(const original of examples.slice(0,2))for(const mutate of [e=>e.card.hp=30,e=>e.card.hp=25,e=>e.card.text="Different effect",
        e=>e.card.unique=undefined,e=>e.card.unique=true,e=>e.card.deployBox="Action: Do something",e=>e.card.epicAction="Deploy",
        e=>e.card.epicAction=false,e=>e.card.rules="Deck text",e=>e.card.upgradeHp=1,e=>e.card.upgradePower=0,e=>e.card.cost=0,
        e=>e.card.pilotText=false,e=>e.piloting=false,e=>e.sourceHash=null,e=>e.baseClass="EventCard",e=>e.card.keywords=["raid"]]) {
        const e=copy(original);mutate(e);assert.equal(classifyBaseZone(e),null);
    }
});
test("base registrar/resolver/side widening rejects safely",()=>{
    for(const mutate of [e=>e.abilities.card[0]=null,e=>e.abilities.card[0].optional=true,e=>e.abilities.card[0].condition={kind:"const",value:true},
        e=>e.abilities.card[0].effect.hp.value=2,e=>e.abilities.card[0].targetResolver.type="unit",e=>e.abilities.card[0].targetResolver.owner="any",
        e=>e.abilities.card[0].targetResolver.zone="base",e=>e.abilities.leader.push(copy(e.abilities.card[0])),e=>e.abilities.extra=[]]) {
        const e=copy(examples[0]);mutate(e);assert.equal(classifyBaseZone(e),null);
    }
});
test("leader deployment and print metadata cannot omit extra semantics",()=>{
    for(const mutate of [e=>e.card.hp=6,e=>e.card.power=6,e=>e.card.cost=5,e=>e.card.unique=false,e=>delete e.card.unique,
        e=>e.card.text="Other friendly units gain Raid",e=>e.card.deployBox="Raid 2",e=>e.card.epicAction="Epic Action: Draw a card",
        e=>e.card.rules="Extra deck rules",e=>e.card.pilotBox=false,e=>e.keywordValues.raid=2,e=>e.baseClass="NonLeaderUnitCard"]) {
        const e=copy(examples[2]);mutate(e);assert.equal(classifyBaseZone(e),null);
    }
});
test("front/unit pair source exclusion and printed cost are exact",()=>{
    for(const mutate of [e=>e.abilities.leader[0].trigger="action",e=>e.abilities.unit[0].optional=true,e=>e.abilities.card.push({trigger:"whenPlayed"}),
        e=>e.abilities.leader[0].targetResolver.predicate.right.right.value=2,e=>e.abilities.unit[0].targetResolver.predicate=e.abilities.leader[0].targetResolver.predicate,
        e=>e.abilities.leader[0].effect.amount.value=2,e=>e.abilities.unit[0].targetResolver.owner="opponent",e=>e.abilities.unit[0]=null]) {
        const e=copy(examples[2]);mutate(e);assert.equal(classifyBaseZone(e),null);
    }
});
test("plain opposite base donor is genuine blank30 metadata",()=>{
    const original=catalogue.cards.find(blankBase);assert.ok(original);
    for(const mutate of [e=>e.card.hp=26,e=>e.card.hp="30",e=>e.card.text="Deck construction exception",e=>e.card.epicAction=false,
        e=>e.sourceHash="0".repeat(64),e=>e.sourcePath="",e=>e.baseClass="BaseCard",e=>e.abilities.card.push({trigger:"constant"}),e=>e.card.traits=null]) {
        const e=copy(original);mutate(e);assert.equal(blankBase(e),false);
    }
});
test("current definitions roundtrip and central dependency closure includes both helpers",()=>{
    const library=require("../reference/library"),core=require("../pipeline/probe-fixture");
    for(const e of examples)for(const scenario of planBaseZoneProbes(e,{catalogue}).cases)assert.deepEqual(library.definition(scenario.id,library.registry(),scenario),scenario);
    for(const dependency of ["bot/cards/pipeline/base-zone-probes.js","bot/cards/pipeline/base-zone-probe-fixture.js","bot/omni/rs/make-pool.js"])
        assert.ok(core.dependencies.includes(dependency));
});

test("optional enemy leader is passed only at genuine deck2 construction boundary",async()=>{
    const core=require("../pipeline/probe-fixture"),scenario=planBaseZoneProbes(examples[0],{catalogue}).cases[0];
    const probe={cardId:scenario.probe.fillerCode,leaderCode:scenario.probe.ordinaryLeaderCode,
        baseCode:scenario.probe.ordinaryBaseCode,targets:[]};
    const pool={cards:catalogue.cards.map(e=>({setCode:e.setCode,...e.card}))};
    async function capture(p) {
        let seen;
        await assert.rejects(core.constructProbeFixture({newGame(opts){seen=opts;throw new Error("capture-deck-boundary");}},pool,{probe:p},77),/capture-deck-boundary/);
        return seen;
    }
    const standard=await capture(probe);assert.deepEqual(standard.deck2,standard.deck1);
    const distinct=await capture({...probe,enemyLeaderCode:examples[2].setCode});
    assert.deepEqual(distinct.deck1,standard.deck1);assert.equal(distinct.deck2.leader.id,examples[2].setCode);
    assert.deepEqual({...distinct.deck2,leader:distinct.deck1.leader},distinct.deck1);
});

test("ordinary leader lifecycle donor matches the printed5HP2power4cost envelope",()=>{
    const {ordinaryLeader}=require("../pipeline/base-zone-probes");
    const original=catalogue.cards.find(ordinaryLeader);assert.ok(original);
    for(const mutate of [e=>e.card.hp=6,e=>e.card.power=3,e=>e.card.cost=5,
        e=>e.card.text="Action [exhaust]: Deal 2 damage to each base.",e=>e.card.deployBox="On Attack: Deal 2 damage to each enemy base.",
        e=>e.card.epicAction="Epic Action: If you control 5 or more resources, deploy this leader.",e=>e.card.rules="Extra rule",e=>e.card.upgradePower=1,e=>e.card.upgradeHp=0,
        e=>e.abilities.extra=[],e=>e.abilities.unit[0].effect.amount.value=2,e=>e.abilities.leader[0].optional=true]) {
        const e=copy(original);mutate(e);assert.equal(ordinaryLeader(e),false);
    }
});
