"use strict";
const assert = require("node:assert/strict");
const same = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };
const keys = (value, allowed) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(k => allowed.includes(k));
const strings = value => Array.isArray(value) && value.every(v => typeof v === "string");
const ref = (...path) => ({kind:"ref", path});
const constant = value => ({kind:"const", value});
const query = (name, value) => ({kind:"query", name, receiver:ref("card"), args:[constant(value)]});
const sourceExcluded = {kind:"binary", op:"||", left:{kind:"unary", op:"!", value:ref("source")}, right:{kind:"binary", op:"!==", left:ref("card"), right:ref("source")}};
const damaged = {kind:"binary", op:">", left:ref("card", "damage"), right:constant(0)};
function noPilot(entry) {
    return entry.piloting == null && ["pilotText", "pilotBox", "pilotingBox"].every(k => entry.card?.[k] == null);
}
function ordinarySource(entry) {
    const c = entry?.card;
    return entry?.status === "supported" && entry.baseClass === "NonLeaderUnitCard"
        && typeof entry.sourcePath === "string" && entry.sourcePath.length > 0
        && typeof entry.sourceHash === "string" && /^[a-f0-9]{64}$/.test(entry.sourceHash)
        && c && same(c.types, ["unit"]) && typeof c.unique === "boolean"
        && ["ground", "space"].includes(c.arena) && Number.isInteger(c.cost) && c.cost >= 0 && c.cost <= 6
        && Number.isInteger(c.hp) && c.hp > 0 && c.hp <= 8 && Number.isInteger(c.power) && c.power >= 0
        && strings(c.traits) && strings(c.aspects) && c.aspects.length <= 2 && strings(c.keywords)
        && noPilot(entry) && entry.attachCondition == null && c.deployBox == null
        && !c.epicAction && c.upgradePower == null && c.upgradeHp == null;
}
function classifyArenaToken(entry) {
    if (!ordinarySource(entry) || !keys(entry.abilities,["leader","unit","card"]) || !same(entry.abilities?.leader, []) || !same(entry.abilities?.unit, [])
        || !Array.isArray(entry.abilities?.card)) return null;
    const abilities = entry.abilities.card;
    if (!abilities.length || abilities.some(a => !keys(a, ["trigger", "title", "costs", "effect"])
        || typeof a.title !== "string" || !same(a.costs, []))) return null;
    const intrinsic = entry.keywordValues ?? {};
    const body = abilities[0].effect;
    if (!keys(body, ["kind", "target", "amount"]) || !same(body.amount, constant(1))
        || !keys(body.target, ["kind", "receiver", "predicate"]) || body.target.kind !== "arenaList"
        || !same(body.target.receiver, ref("player"))) return null;
    const predicate = body.target.predicate;
    if (!keys(predicate, ["kind", "op", "left", "right"]) || predicate.kind !== "binary"
        || predicate.op !== "&&" || !same(predicate.left, constant(true))) return null;
    let mode;
    if (body.kind === "giveShield" && same(predicate.right, query("hasSomeKeyword", "shielded"))
        && same(intrinsic, {shielded:1}) && same(entry.card.keywords, ["shielded"])
        && abilities.length === 1 && abilities[0].trigger === "whenPlayed") mode = "shielded";
    else if (body.kind === "giveExperience" && same(predicate.right, sourceExcluded)
        && same(intrinsic, {}) && same(entry.card.keywords, []) && abilities.length === 2
        && abilities[0].trigger === "whenPlayed" && abilities[1].trigger === "whenDefeated"
        && same(abilities[1].effect, body)) mode = "other-friendly";
    else if (body.kind === "giveExperience" && same(predicate.right, query("hasSomeTrait", "rebel"))
        && same(intrinsic, {}) && same(entry.card.keywords, []) && abilities.length === 1
        && abilities[0].trigger === "whenDefeated") mode = "rebel-death";
    else if (body.kind === "giveExperience" && same(predicate.right, damaged)
        && same(intrinsic, {sentinel:1}) && same(entry.card.keywords, ["sentinel"])
        && abilities.length === 1 && abilities[0].trigger === "whenPlayed") mode = "damaged";
    if (!mode || mode !== "damaged" && entry.card.unique !== true || mode === "damaged" && entry.card.arena !== "ground"
        || mode === "rebel-death" && !entry.card.traits.includes("rebel")) return null;
    return {family:"arena-token", mode, token:body.kind === "giveShield" ? "shield" : "experience", amount:1,
        sourceArena:entry.card.arena, sourceUnique:entry.card.unique,
        registrations:abilities.map(a => ({trigger:a.trigger, title:a.title}))};
}
module.exports = {classifyArenaToken, ordinarySource, noPilot};

function quietUnit(entry, keywords = {}) {
    const c = entry?.card;
    if (entry?.status !== "supported" || !c || !same(c.types, ["unit"]) || c.unique !== false
        || !["ground", "space"].includes(c.arena) || !Number.isInteger(c.cost) || c.cost < 0
        || !Number.isInteger(c.hp) || c.hp <= 0 || !Number.isInteger(c.power) || c.power < 0
        || typeof c.text !== "string" || !strings(c.traits) || !strings(c.aspects) || !strings(c.keywords) || !noPilot(entry)
        || entry.attachCondition != null || c.deployBox != null || c.epicAction
        || c.upgradePower != null || c.upgradeHp != null
        || !same(entry.abilities, {leader:[], unit:[], card:[]})
        || !same(entry.keywordValues ?? {}, keywords)
        || !same([...c.keywords].sort(), Object.keys(keywords).sort())) return false;
    const provenance = entry.baseClass === "NonLeaderUnitCard" && typeof entry.sourcePath === "string" && entry.sourcePath.length > 0
        && /^[a-f0-9]{64}$/.test(entry.sourceHash ?? "");
    const dataOnly = entry.baseClass == null && entry.sourcePath === null && entry.sourceHash === null;
    if (!provenance && !dataOnly) return false;
    const {parseKeywords} = require("../../omni/rs/make-pool");
    return same(parseKeywords(c), keywords);
}
function nativeExperience(entry) {
    return entry?.setCode === "TOKEN_EXPERIENCE" && entry.status === "unsupported" && noPilot(entry) && entry.attachCondition == null
        && entry.baseClass === "TokenUpgradeCard"
        && entry.sourcePath === "game/cards/01_SOR/tokens/Experience.ts"
        && entry.sourceHash === "fccf00d13061bfc15447101a0dc82fc360f9b5d2e28a9da678684e8c93bc9d67"
        && same(entry.abilities, {leader:[], unit:[], card:[]}) && same(entry.keywordValues ?? {}, {})
        && same(entry.card, {title:"Experience", subtitle:null, cost:0, hp:1, power:1, text:null,
            deployBox:null, epicAction:null, unique:false, rules:null, upgradePower:1, upgradeHp:1,
            id:"2007868442", aspects:[], traits:["learned"], keywords:[], types:["token","upgrade"],
            setId:{set:"SOR"}, internalName:"experience"});
}
function ordinaryUpgrade(entry) {
    const c = entry?.card, condition = entry?.attachCondition;
    return entry?.status === "supported" && entry.baseClass === "UpgradeCard" && same(c?.types,["upgrade"])
        && c.unique === false && Number.isInteger(c.cost) && c.cost >= 0 && strings(c.aspects) && strings(c.traits)
        && typeof entry.sourcePath === "string" && /^[a-f0-9]{64}$/.test(entry.sourceHash ?? "")
        && noPilot(entry) && same(c.keywords,[]) && same(entry.keywordValues ?? {},{})
        && same(entry.abilities,{leader:[],unit:[],card:[]})
        && Number.isInteger(c.upgradePower) && c.upgradePower >= 0 && Number.isInteger(c.upgradeHp) && c.upgradeHp >= 0
        && keys(condition,["kind","op","left","right"]) && condition.kind === "binary" && condition.op === "&&"
        && same(condition.left,{kind:"query",name:"hasCost",receiver:ref("card"),args:[]})
        && keys(condition.right,["kind","op","left","right"]) && condition.right.kind === "binary" && condition.right.op === "<="
        && same(condition.right.left,ref("card","cost")) && keys(condition.right.right,["kind","value"])
        && condition.right.right.kind === "const" && Number.isInteger(condition.right.right.value) && condition.right.right.value >= 0;
}
function leaderDonor(entry) {
    const c = entry?.card;
    return entry?.status === "supported" && entry.baseClass === "LeaderUnitCard" && same(c?.types,["leader"])
        && c.unique === true && c.arena === "ground" && Number.isInteger(c.cost) && c.cost > 0
        && Number.isInteger(c.hp) && c.hp >= 4 && Number.isInteger(c.power) && c.power >= 0 && strings(c.traits) && strings(c.aspects) && same(c.keywords,[])
        && noPilot(entry) && entry.attachCondition == null && typeof entry.sourcePath === "string"
        && /^[a-f0-9]{64}$/.test(entry.sourceHash ?? "") && same(entry.keywordValues ?? {}, {})
        && same(entry.abilities?.card,[]) && entry.abilities?.leader?.length === 1 && entry.abilities?.unit?.length === 1
        && same(entry.abilities.leader[0].costs,[{kind:"exhaustSelf"}]) && entry.abilities.leader[0].trigger === "action"
        && keys(entry.abilities.leader[0],["trigger","title","costs","effect"])
        && same(entry.abilities.leader[0].effect,{kind:"damage",target:"bothBases",amount:constant(1)})
        && entry.abilities.unit[0].trigger === "onAttack" && same(entry.abilities.unit[0].costs,[])
        && keys(entry.abilities.unit[0],["trigger","title","costs","effect"])
        && same(entry.abilities.unit[0].effect,{kind:"damage",target:"enemyBase",amount:constant(1)});
}
function planArenaTokenProbes(entry, options = {}) {
    const shape = classifyArenaToken(entry);
    if (!shape) return null;
    const definitions = Array.isArray(options.catalogue) ? options.catalogue : options.catalogue?.cards ?? [];
    const sorted = [...definitions].sort((a, b) => a.setCode.localeCompare(b.setCode));
    const result = {schema:"swu-card-probes/v1", cardId:entry.setCode, sourceHash:entry.sourceHash,
        cases:[], obligations:[], uncovered:[]};
    const obligation = (dimension, reason) => {
        const id = `${entry.setCode}:arena-token:${dimension}`;
        result.obligations.push({id, path:"arena-token", dimension});
        if (reason) result.uncovered.push({id, path:"arena-token", reason});
        return id;
    };
    const ground = sorted.find(e => quietUnit(e) && e.card.arena === "ground" && e.card.hp >= 5 && e.card.power < 15);
    const space = sorted.find(e => quietUnit(e) && e.card.arena === "space" && e.card.hp >= 5);
    const rebelGround = sorted.find(e => quietUnit(e) && e.card.arena === "ground" && e.card.traits.includes("rebel") && e.card.hp >= 2);
    const rebelSpace = sorted.find(e => quietUnit(e) && e.card.arena === "space" && e.card.traits.includes("rebel") && e.card.hp >= 2);
    const nonRebel = sorted.find(e => quietUnit(e) && e.card.arena === "ground" && !e.card.traits.includes("rebel") && e.card.hp >= 2);
    const shieldGround = sorted.find(e => quietUnit(e, {shielded:1}) && e.card.arena === "ground");
    const shieldSpace = sorted.find(e => quietUnit(e, {shielded:1}) && e.card.arena === "space");
    const damageDonor = sorted.find(e => e.status === "supported" && e.baseClass === "EventCard"
        && typeof e.sourcePath === "string" && /^[a-f0-9]{64}$/.test(e.sourceHash ?? "")
        && same(e.card?.types, ["event"]) && e.card.unique === false && noPilot(e)
        && e.attachCondition == null && same(e.keywordValues ?? {}, {}) && same(e.card.keywords, [])
        && same(e.abilities?.leader, []) && same(e.abilities?.unit, []) && e.abilities?.card?.length === 1
        && keys(e.abilities.card[0], ["trigger", "title", "costs", "targetResolver", "effect"])
        && e.abilities.card[0].trigger === "event" && same(e.abilities.card[0].costs, [])
        && same(e.abilities.card[0].targetResolver, {owner:"any", type:"unit", zone:"anyAttackable"})
        && same(e.abilities.card[0].effect, {kind:"damage", target:"chosen", amount:constant(4)}));
    const smallDamage = sorted.find(e => e.status === "supported" && e.baseClass === "EventCard"
        && typeof e.sourcePath === "string" && /^[a-f0-9]{64}$/.test(e.sourceHash ?? "")
        && same(e.card?.types,["event"]) && e.card.unique === false && noPilot(e) && e.attachCondition == null
        && same(e.keywordValues ?? {},{}) && same(e.card.keywords,[]) && same(e.abilities?.leader,[]) && same(e.abilities?.unit,[])
        && e.abilities?.card?.length === 1 && keys(e.abilities.card[0],["trigger","title","costs","targetResolver","effect"])
        && e.abilities.card[0].trigger === "event" && same(e.abilities.card[0].costs,[])
        && same(e.abilities.card[0].targetResolver,{owner:"any",type:"any",zone:"anyAttackable"})
        && same(e.abilities.card[0].effect,{kind:"damage",target:"chosen",amount:constant(2)}));
    const shield = sorted.find(require("./arena-damage-probes").nativeShield);
    const experience = sorted.find(nativeExperience);
    const upgrade = sorted.find(e => ordinaryUpgrade(e) && ground && ground.card.cost <= e.attachCondition.right.right.value
        && (!shieldGround || shieldGround.card.cost <= e.attachCondition.right.right.value)
        && (!rebelGround || rebelGround.card.cost <= e.attachCondition.right.right.value));
    const beast = sorted.find(require("./weakness-continuation-probes").nativeBeast);
    const leader = sorted.find(leaderDonor);
    if (!shield || !experience || !damageDonor || !smallDamage) {
        obligation("reviewed-token-damage-dependencies", "Missing exact reviewed native tokens or bounded damage event donors");
        return result;
    }
    const target = (e, owner, extra = {}) => ({code:e.setCode, owner, arena:e.card.arena, damage:0, exhausted:false, ...extra});
    if (!ground || !space || shape.mode === "rebel-death" && (!rebelGround || !rebelSpace || !nonRebel)
        || shape.mode === "shielded" && (!shieldGround || !shieldSpace)) {
        obligation("quiet-metadata-donors", "No complete bounded donor set for this structural token family");
        return result;
    }
    const mixed = shape.mode === "shielded"
        ? [target(shieldGround,"self"), target(shieldSpace,"self"), target(ground,"self"), target(shieldGround,"opponent")]
        : shape.mode === "rebel-death"
        ? [target(rebelGround,"self"), target(rebelSpace,"self"), target(nonRebel,"self"), target(rebelGround,"opponent")]
        : [target(ground,"self"), target(space,"self"), target(ground,"opponent"), target(space,"opponent")];
    if (shape.mode === "damaged") for (const t of mixed) t.damage = 1;
    const add = (name, targets, extra = {}) => {
        if (extra.uniqueChoice && !entry.card.unique) {obligation(name,"Nonunique sources do not have a unique replacement window");return;}
        if (extra.lifecycleRecipients && (!beast || !leader) || extra.existingAttachments && !upgrade) {
            obligation(name, "Missing complete native/leader/ordinary-upgrade construction dependency"); return;
        }
        for (const sourceSeat of [1,2]) {
            const dimension = `${name}-seat${sourceSeat}`, id = obligation(dimension);
            const staged = targets.map(t => ({...t}));
            const probe = {...shape, cardId:entry.setCode, sourceSeat, targets:staged,
                resourceCount:36, ownBaseDamage:0, enemyBaseDamage:0, ...extra};
            if (extra.uniqueChoice) {
                probe.oldSourceIndex = staged.length;
                staged.push(target(entry,"self", shape.mode === "shielded" ? {zone:"hand"} : {}));
                probe.prepareOldSource = shape.mode === "shielded";
            }
            if (extra.existingAttachments) {
                staged[0].attachments = [{code:shape.token === "shield" ? shield.setCode : experience.setCode,token:shape.token},
                    {code:upgrade.setCode}];
                if (shape.mode === "shielded") staged[2].attachments = [{code:shield.setCode,token:"shield"}];
            }
            if (extra.consumePriorShield || extra.cleanupRecipient && shape.mode === "shielded")
                staged[0].attachments = Array.from({length:extra.consumePriorShield ? 1 : 2}, () => ({code:shield.setCode,token:"shield"}));
            if (extra.laterEntrant) {probe.laterEntrantIndex = staged.length; staged.push(target(space,"self",{zone:"hand"}));}
            if (extra.lifecycleRecipients) {
                probe.leaderCode = leader.setCode;
                staged.push(target(beast,"self",{token:"beast",damage:shape.mode === "damaged" ? 1 : 0}));
                staged.push(target(leader,"self",{deployedLeader:true,damage:shape.mode === "damaged" ? 1 : 0}));
                staged.push(target(beast,"opponent",{token:"beast",damage:shape.mode === "damaged" ? 1 : 0}));
            }
            probe.eventCards = [];
            const event = (donor, role, targetIndex, count) => {
                for (let i=0; i<count; i++) {
                    const index = staged.length; staged.push({code:donor.setCode,owner:"self",zone:"hand"});
                    probe.eventCards.push({index,role,targetIndex,amount:donor.abilities.card[0].effect.amount.value});
                }
            };
            if (extra.consumePriorShield) event(smallDamage,"before",0,1);
            if (extra.defeatSource) event(damageDonor,"source-death",null,Math.ceil(entry.card.hp/4));
            if (extra.cleanupRecipient) {
                if (shape.mode === "shielded") {event(smallDamage,"cleanup",0,3);event(damageDonor,"cleanup",0,1);}
                else event(damageDonor,"cleanup",0,Math.ceil((ground.card.hp+1)/4));
            }
            if (extra.recipientCombat || extra.sentinelMenu) probe.combatIndex = 0;
            const setupIds = [...staged.map(t => t.code),shield.setCode,experience.setCode];
            result.cases.push({id:`auto/${entry.setCode}/arena-token-${dimension}`, name:`arena-token-${dimension}`,
                kind:"probe", source:{module:"../pipeline/probe-fixture.js",scenario:`arena-token-${dimension}`},
                focusCardIds:[entry.setCode],setupCardIds:[...new Set(setupIds)].sort(),
                behaviorIds:["arena-list","token-batch",shape.token],assertionStages:["construction","activation","observation"],
                coverageObligationIds:[id],probe});
        }
    };
    if (shape.mode === "shielded") {
        add("mixed-shielded-first", mixed, {entryOrder:"shielded"});
        add("mixed-bulk-first", mixed, {entryOrder:"bulk"});
        add("consumed-shielded-presence", mixed, {consumePriorShield:true});
        add("additive-and-nonkeyword-negative", mixed, {existingAttachments:true});
        add("source-only-shielded-first", [], {entryOrder:"shielded"});
        add("source-only-bulk-first", [], {entryOrder:"bulk"});
        add("unique-keep-old", mixed, {uniqueChoice:"old"});
        add("unique-keep-new-shielded-first", mixed, {uniqueChoice:"new", entryOrder:"shielded"});
        add("unique-keep-new-bulk-first", mixed, {uniqueChoice:"new", entryOrder:"bulk"});
        add("later-shield-cleanup", mixed, {cleanupRecipient:true});
    } else if (shape.mode === "other-friendly") {
        add("normal-play-and-real-death", mixed, {defeatSource:true});
        add("empty-play-and-real-death", [], {defeatSource:true});
        add("existing-attachments", mixed, {existingAttachments:true});
        for (const uniqueChoice of ["old","new"]) {
            add(`unique-${uniqueChoice}-mixed`, mixed, {uniqueChoice});
            add(`unique-${uniqueChoice}-no-other-friendly`, [], {uniqueChoice});
        }
        add("later-entrant-death-only", mixed, {laterEntrant:true, defeatSource:true});
        add("native-and-deployed-recipients", mixed, {lifecycleRecipients:true});
        add("experience-combat", mixed, {recipientCombat:true});
    } else if (shape.mode === "rebel-death") {
        add("normal-play-and-rebel-death", mixed, {defeatSource:true});
        add("empty-rebel-death", [], {defeatSource:true});
        add("unique-keep-old", mixed, {uniqueChoice:"old"});
        add("unique-keep-new", mixed, {uniqueChoice:"new"});
        add("existing-experience", mixed, {existingAttachments:true, defeatSource:true});
        add("experience-combat", mixed, {recipientCombat:true, defeatSource:true});
    } else {
        add("mixed-damage-zero-one", [...mixed, target(ground,"self")]);
        add("empty-undamaged", mixed.map(t => ({...t, damage:0})));
        add("existing-attachments", mixed, {existingAttachments:true});
        add("native-and-deployed-recipients", mixed, {lifecycleRecipients:true});
        add("ground-sentinel-menu", mixed, {sentinelMenu:"ground"});
        add("space-menu-negative", mixed, {sentinelMenu:"space"});
        add("experience-combat", mixed, {recipientCombat:true});
        add("later-recipient-cleanup", mixed, {cleanupRecipient:true});
    }
    obligation("source-review", "Whole pinned sources and helper scheduling require independent review");
    for (const dimension of ["framework-aura-deaths", "exotic-replacements", "controller-changes", "multiplayer", "capacity-overflow", "arbitrary-competing-registrations", "native-and-leader-departure-cleanup", "phase-expiry-interactions"])
        obligation(dimension, `No actual source-card construction for ${dimension}; partial and primitive diagnostics are not full-card witnesses`);
    if (shape.mode === "shielded") obligation("true-empty-after-source-departure", "Source-only normal entry still qualifies; captured source departure or keyword loss is not constructed");
    if (shape.mode === "rebel-death") obligation("rebel-native-and-deployed-recipients", "Reviewed X-Wing has no Rebel trait; an independent Rebel leader construction is not modeled");
    return result;
}
module.exports = {classifyArenaToken, planArenaTokenProbes, ordinarySource, quietUnit, noPilot, nativeExperience, ordinaryUpgrade, leaderDonor};
