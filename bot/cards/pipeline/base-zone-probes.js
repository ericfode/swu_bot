"use strict";
const same=require("node:util").isDeepStrictEqual;
const keys=(v,allowed)=>v && typeof v==="object" && !Array.isArray(v) && Object.keys(v).every(k=>allowed.includes(k));
const constant=value=>({kind:"const",value}),ref=(...path)=>({kind:"ref",path});
const strings=v=>Array.isArray(v) && v.every(x=>typeof x==="string");
const noPilot=e=>e?.piloting==null && ["pilotText","pilotBox","pilotingBox"].every(k=>e.card?.[k]==null);
const provenance=e=>e?.status==="supported" && typeof e.sourcePath==="string" && e.sourcePath.length>0 && /^[a-f0-9]{64}$/.test(e.sourceHash??"");
const frontPredicate={kind:"binary",op:"&&",left:{kind:"query",name:"isUnit",receiver:ref("card"),args:[]},
    right:{kind:"binary",op:">=",left:ref("card","cost"),right:constant(3)}};
const deployedPredicate={kind:"binary",op:"&&",left:frontPredicate,right:{kind:"binary",op:"!==",left:ref("card"),right:ref("source")}};
function header(a) {
    return keys(a,["trigger","title","costs","effect","targetResolver"]) && a.trigger==="constant"
        && typeof a.title==="string" && a.title.length>0 && Buffer.byteLength(a.title)<=1024 && same(a.costs,[]);
}
function classifyBaseZone(entry) {
    const c=entry?.card;
    if (!provenance(entry) || !c || !noPilot(entry) || entry.attachCondition!=null || !strings(c.traits)
        || !strings(c.aspects) || !strings(c.keywords) || typeof c.unique!=="boolean" || typeof c.text!=="string"
        || c.upgradePower!=null || c.upgradeHp!=null || !keys(entry.abilities,["leader","unit","card"])) return null;
    if (entry.baseClass==="BaseCard" && same(c.types,["base"])) {
        const a=entry.abilities.card?.[0];
        if (c.unique!==false || c.cost!=null || c.power!=null || c.hp!==26
            || c.deployBox!=null || c.rules!=null || !(c.epicAction==null || c.epicAction==="")
            || !same(c.keywords,[]) || !same(entry.keywordValues??{}, {})
            || !same(entry.abilities.leader,[]) || !same(entry.abilities.unit,[]) || entry.abilities.card?.length!==1
            || !header(a) || !same(a.targetResolver,{owner:"self",type:"leaderUnit",zone:"arena"})
            || !keys(a.effect,["kind","target","duration","power","hp"]) || a.effect.kind!=="modifyStats"
            || a.effect.target!=="chosen" || a.effect.duration!=="persistent") return null;
        const hp=same(a.effect.power,constant(0)) && same(a.effect.hp,constant(1));
        const power=same(a.effect.power,constant(1)) && same(a.effect.hp,constant(0));
        if (!hp && !power || c.text!==`Each leader unit you control gets +${power?1:0}/+${hp?1:0}.`) return null;
        return {family:"base-zone",mode:hp?"leader-hp":"leader-power",power:power?1:0,hp:hp?1:0,baseHp:c.hp};
    }
    if (entry.baseClass!=="LeaderUnitCard" || !same(c.types,["leader"]) || c.unique!==true || c.arena!=="ground"
        || c.cost!==6 || c.hp!==5 || c.power!==5
        || c.text!=="Friendly units that cost 3 or more gain Raid 1."
        || c.deployBox!=="Raid 1\nOther friendly units that cost 3 or more gain Raid 1."
        || c.epicAction!=="Epic Action: If you control 6 or more resources, deploy this leader."
        || c.rules!=="Abilities that refer to a card’s cost always refer to its printed cost, regardless of modifiers.\n"
        || !same(c.keywords,["raid"]) || !same(entry.keywordValues,{raid:1})
        || !same(entry.abilities.card,[]) || entry.abilities.leader?.length!==1 || entry.abilities.unit?.length!==1) return null;
    const pair=[entry.abilities.leader[0],entry.abilities.unit[0]];
    for (let i=0;i<pair.length;i++) {
        const a=pair[i];
        if (!header(a) || !same(a.effect,{kind:"gainKeyword",target:"chosen",duration:"persistent",keyword:"raid",amount:constant(1)})
            || !same(a.targetResolver,{owner:"self",type:"unit",zone:"arena",predicate:i===0?frontPredicate:deployedPredicate})) return null;
    }
    return {family:"base-zone",mode:"leader-raid",threshold:3,raid:1,sourceHp:c.hp,sourcePower:c.power};
}
function blankBase(entry) {
    const c=entry?.card;
    return entry?.status==="supported" && entry.baseClass==null && entry.sourcePath===null && entry.sourceHash===null
        && c && same(c.types,["base"]) && c.unique===false && c.hp===30
        && c.cost==null && c.power==null && c.text==="" && c.deployBox==null && c.rules==null
        && (c.epicAction==null || c.epicAction==="") && c.upgradePower==null && c.upgradeHp==null
        && noPilot(entry) && entry.attachCondition==null && strings(c.traits) && strings(c.aspects) && same(c.keywords,[])
        && same(entry.keywordValues??{}, {}) && same(entry.abilities,{leader:[],unit:[],card:[]});
}
function damageEvent(entry, amount) {
    const a=entry?.abilities?.card?.[0],c=entry?.card;
    return provenance(entry) && entry.baseClass==="EventCard" && same(c?.types,["event"]) && c.unique===false
        && noPilot(entry) && entry.attachCondition==null && same(c.keywords,[]) && same(entry.keywordValues??{}, {})
        && same(entry.abilities?.leader,[]) && same(entry.abilities?.unit,[]) && entry.abilities?.card?.length===1
        && keys(a,["trigger","title","costs","effect","targetResolver"]) && a.trigger==="event" && typeof a.title==="string"
        && same(a.costs,[]) && same(a.effect,{kind:"damage",target:"chosen",amount:constant(amount)})
        && same(a.targetResolver,{owner:"any",type:amount===4?"unit":"any",zone:"anyAttackable"});
}
function ordinaryLeader(entry) {
    return require("./arena-token-probes").leaderDonor(entry) && entry.card.cost===4 && entry.card.hp===5 && entry.card.power===2
        && entry.card.text==="Action [exhaust]: Deal 1 damage to each base."
        && entry.card.deployBox==="On Attack: Deal 1 damage to each enemy base."
        && entry.card.epicAction==="Epic Action: If you control 4 or more resources, deploy this leader."
        && entry.card.rules==null && entry.card.upgradePower==null && entry.card.upgradeHp==null && keys(entry.abilities,["leader","unit","card"]);
}
function planBaseZoneProbes(entry,options={}) {
    const shape=classifyBaseZone(entry);if(!shape)return null;
    const defs=(Array.isArray(options.catalogue)?options.catalogue:options.catalogue?.cards??[]).slice().sort((a,b)=>a.setCode.localeCompare(b.setCode));
    const {quietUnit,ordinaryUpgrade}=require("./arena-token-probes");
    const plain=defs.find(blankBase),leader=defs.find(ordinaryLeader),filler=defs.find(e=>quietUnit(e)&&e.card.arena==="ground");
    const fire=defs.find(e=>damageEvent(e,4)),smallFire=defs.find(e=>damageEvent(e,2));
    const one=defs.find(e=>quietUnit(e)&&e.card.arena==="ground"&&e.card.power===1&&e.card.hp===1);
    const quiet=(cost,arena)=>defs.find(e=>quietUnit(e)&&e.card.cost===cost&&e.card.arena===arena&&e.card.power>0&&e.card.power<10);
    const ground2=quiet(2,"ground"),ground3=quiet(3,"ground"),space2=quiet(2,"space"),space3=quiet(3,"space");
    const raid=defs.find(e=>(quietUnit(e,{raid:1})||quietUnit(e,{overwhelm:1,raid:1}))&&e.card.cost>=3&&e.card.arena==="space"&&e.card.power<10);
    const upgrade=defs.find(e=>ordinaryUpgrade(e)&&ground2&&ground2.card.cost<=e.attachCondition.right.right.value);
    const beast=defs.find(require("./weakness-continuation-probes").nativeBeast);
    const result={schema:"swu-card-probes/v1",cardId:entry.setCode,sourceHash:entry.sourceHash,cases:[],obligations:[],uncovered:[]};
    const obligation=(dimension,reason)=>{const id=`${entry.setCode}:base-zone:${dimension}`;result.obligations.push({id,path:"base-zone",dimension});if(reason)result.uncovered.push({id,path:"base-zone",reason});return id;};
    if(!plain||!leader||!filler||!fire||!smallFire||!one||!ground2||!ground3||!space2||!space3
        ||shape.mode==="leader-raid"&&(!raid||!upgrade||!beast)) {
        obligation("full-metadata-donors","No complete bounded initial-deck/lifecycle donor set");return result;
    }
    const target=(e,owner,extra={})=>({code:e.setCode,owner,...(e.card.arena?{arena:e.card.arena}:{}),exhausted:false,damage:0,...extra});
    const add=(name,extra={})=>{
        for(const sourceSeat of [1,2]) {
            const dimension=`${name}-seat${sourceSeat}`,id=obligation(dimension);
            const targets=[target(ground2,"self"),target(ground3,"self"),target(space2,"self"),target(space3,"self"),
                target(ground2,"opponent"),target(ground3,"opponent"),target(space2,"opponent"),target(space3,"opponent"),target(one,"opponent")];
            const p={...shape,cardId:entry.setCode,sourceSeat,fillerCode:filler.setCode,ordinaryBaseCode:plain.setCode,
                ordinaryLeaderCode:leader.setCode,ordinaryLeaderHp:leader.card.hp,ordinaryLeaderPower:leader.card.power,
                resourceCount:24,targets,damageCardIndices:[],...extra};
            const append=(e,owner,fields={})=>{const index=targets.length;targets.push(target(e,owner,fields));return index;};
            p.damageCardIndices=[append(fire,"self",{zone:"hand"}),append(smallFire,"self",{zone:"hand"})];
            p.quietOneIndex=append(one,"self",{zone:"hand"});
            if(shape.mode==="leader-raid") {
                p.raidIndex=append(raid,"self");p.enemyRaidIndex=append(raid,"opponent");
                p.nativeIndex=append(beast,"self",{token:"beast"});
                if(extra.upgrade) p.upgradeIndex=append(upgrade,"self",{zone:"hand"});
            }
            if(extra.laterEntry)p.entrantIndex=append(ground3,"self",{zone:"hand"});
            const setupIds=[filler.setCode,plain.setCode,leader.setCode,...targets.map(t=>t.code)];
            result.cases.push({id:`auto/${entry.setCode}/base-zone-${dimension}`,name:`base-zone-${dimension}`,kind:"probe",
                source:{module:"../pipeline/probe-fixture.js",scenario:`base-zone-${dimension}`},focusCardIds:[entry.setCode],setupCardIds:[...new Set(setupIds)].sort(),
                behaviorIds:["base-zone","persistent-ongoing","leader-lifecycle"],assertionStages:["construction","activation","observation"],coverageObligationIds:[id],probe:p});
        }
    };
    if(shape.mode!=="leader-raid") {
        add("asymmetric-leader-lifecycle",{lifecycle:true});
        add("opposing-deploy-own-offboard",{offboard:true});
        add("late-ordinary-unit-negative",{laterEntry:true});
        add("own-special-base-lethal",{lethal:"own"});
        add("enemy-ordinary-base-lethal",{lethal:"enemy"});
    } else {
        add("asymmetric-front-deployed-attack-death-front",{lifecycle:true});
        add("cost-threshold-ground-combat",{thresholdCombat:"ground"});
        add("cost-threshold-space-combat",{thresholdCombat:"space"});
        add("intrinsic-raid-stack-combat",{stackCombat:true});
        add("natural-phase-persistence",{phasePersistence:true});
        add("late-cost3-front-entry",{laterEntry:true});
        add("late-cost3-deployed-entry",{laterEntry:true,deployedEntry:true});
        add("printed-cost-upgrade-and-native-negative",{upgrade:true});
    }
    obligation("source-review","Whole pinned source registration/zone semantics require independent review");
    for(const dimension of ["simultaneous-different-special-bases","front-exhaustion-no-legal-action","blanking-control-pilot","printed-attribute-overrides","general-cached-aura-deaths","unique-entry-membership"])
        obligation(dimension,"No actual full-source construction for this boundary; source partials and primitive tests are separate evidence");
    return result;
}
module.exports={classifyBaseZone,planBaseZoneProbes,blankBase,damageEvent,ordinaryLeader};
