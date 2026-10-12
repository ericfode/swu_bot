'use strict';
const keys=(v,allowed)=>v&&Object.keys(v).every(k=>allowed.includes(k));
function classifyOnDefense(entry){
    const all=Object.values(entry.abilities??{}).flat(),a=all[0];
    if(entry.status!=='supported'||all.length!==1||!entry.abilities?.card?.length||!entry.card.types.includes('unit')||entry.card.types.includes('leader')||a.trigger!=='onDefense'||a.costs?.length||!keys(a,['trigger','title','costs','optional','targetResolver','effect']))return null;
    if(a.optional!==undefined&&typeof a.optional!=='boolean')return null;
    const e=a.effect,r=a.targetResolver;if(!e||typeof e!=='object')return null;
    if(e.kind==='giveExperience'&&keys(e,['kind','target','amount'])&&JSON.stringify(e.amount)==='{"kind":"const","value":1}'){
        if(e.target==='self'&&!r)return {kind:'self-experience',optional:a.optional===true};
        if(e.target==='chosen'&&JSON.stringify(r)==='{"owner":"any","type":"unit","zone":"anyAttackable"}')return {kind:'chosen-experience',optional:a.optional===true};
    }
    if(a.optional===true)return null;
    if(JSON.stringify(e)==='{"kind":"ready","target":"self"}'&&!r)return {kind:'ready',optional:a.optional===true};
    if(JSON.stringify(e)==='{"kind":"damage","target":"ownBase","amount":{"kind":"const","value":1}}'&&!r)return {kind:'base-damage',optional:a.optional===true};
    if(e.kind==='createTokenUnit'&&keys(e,['kind','tokenType','amount','target','entersReady'])&&e.target==='ownPlayer'&&e.entersReady===false&&JSON.stringify(e.amount)==='{"kind":"const","value":1}'&&['cloneTrooper','battleDroid'].includes(e.tokenType)&&!r)return {kind:'create-token',tokenType:e.tokenType,optional:a.optional===true};
    if(e.kind==='conditional'&&keys(e,['kind','condition','onTrue','onFalse'])&&JSON.stringify(e.onTrue)==='{"kind":"returnToHand","target":"self"}'&&JSON.stringify(e.onFalse)==='{"kind":"noAction"}'&&!r){
        const c=e.condition;if(keys(c,['kind','op','left','right'])&&c.kind==='binary'&&c.op==='==='&&JSON.stringify(c.left)==='{"kind":"ref","path":["source","zoneName"]}'&&keys(c.right,['kind','value'])&&c.right.kind==='const'&&['groundArena','spaceArena'].includes(c.right.value))return {kind:'conditional-return',sourceZone:c.right.value,optional:a.optional===true};
    }
    return null;
}
function planOnDefenseProbes(entry,options={}){
    const shape=classifyOnDefense(entry);if(!shape)return null;
    const defs=Array.isArray(options.catalogue)?options.catalogue:options.catalogue?.cards??[];
    const result={schema:'swu-card-probes/v1',cardId:entry.setCode,sourceHash:entry.sourceHash,cases:[],obligations:[],uncovered:[]};
    const obligation=(d,reason)=>{const id=entry.setCode+':on-defense:'+d;result.obligations.push({id,path:'on-defense',dimension:d});if(reason)result.uncovered.push({id,path:'on-defense',reason});return id;};
    obligation('source-semantics','Structural construction needs independent full-source/helper review');
    // Metadata includes intrinsic keywords not yet represented by keywordValues.
    if(entry.card.keywords?.includes('hidden'))obligation('hidden-lifecycle','Whole-card runtime Hidden rejection remains; staged engine observations do not establish actual play or Hidden expiry conformance');
    for(const keyword of Object.keys(entry.keywordValues??{}))obligation('intrinsic-'+keyword,'Defense attacks exercise declared keyword interactions only; full intrinsic lifecycle remains uncovered');
    const donors=defs.filter(e=>e.status==='supported'&&e.card.types.includes('unit')&&!e.card.types.includes('leader')&&!e.card.types.includes('token')&&e.card.arena===entry.card.arena&&Object.values(e.abilities??{}).flat().length===0&&!e.card.keywords?.includes('hidden')).sort((a,b)=>a.card.power-b.card.power||a.setCode.localeCompare(b.setCode));
    const quiet=donors.find(e=>!Object.keys(e.keywordValues??{}).length),restore=donors.find(e=>e.keywordValues?.restore>0),saboteur=donors.find(e=>e.keywordValues?.saboteur>0),ambush=donors.find(e=>e.keywordValues?.ambush>0),overwhelm=donors.find(e=>e.keywordValues?.overwhelm>0);
    const damagedUnitPredicate={kind:'binary',op:'&&',left:{kind:'query',name:'isUnit',receiver:{kind:'ref',path:['card']},args:[]},right:{kind:'binary',op:'>',left:{kind:'ref',path:['card','damage']},right:{kind:'const',value:0}}};
    const safeDamageDonor=e=>{const a=e.abilities?.card?.[0],r=a?.targetResolver;return a&&!a.costs?.length&&keys(a,['trigger','title','costs','optional','targetResolver','effect'])&&keys(a.effect,['kind','target','amount'])&&keys(a.effect.amount,['kind','value'])&&keys(r,['owner','type','zone','arena','predicate'])&&r.owner==='any'&&(!r.arena||r.arena===entry.card.arena)&&(!r.predicate||JSON.stringify(r.predicate)===JSON.stringify(damagedUnitPredicate))&&!e.card.keywords?.includes('hidden');};
    const damage=defs.filter(e=>safeDamageDonor(e)&&e.status==='supported'&&e.card.types.includes('unit')&&!e.card.types.includes('leader')&&e.card.arena===entry.card.arena&&Object.values(e.abilities??{}).flat().length===1&&e.abilities.card[0]?.trigger==='onAttack'&&e.abilities.card[0]?.effect?.kind==='damage'&&e.abilities.card[0]?.effect?.target==='chosen'&&e.abilities.card[0]?.effect?.amount?.kind==='const'&&e.abilities.card[0]?.effect?.amount?.value>=2&&['unit','any'].includes(e.abilities.card[0]?.targetResolver?.type)).sort((a,b)=>a.setCode.localeCompare(b.setCode))[0];
    if(!quiet){obligation('quiet-attacker','No supported quiet matching-arena attacker');return result;}
    const target=(e,owner='opponent',extra={})=>({code:e.setCode,owner,arena:e.card.arena,damage:0,exhausted:false,...extra});
    function add(name,attacker,extra={}){
        const oid=obligation(name),targets=[target(attacker,'opponent',extra.ambush?{zone:'hand'}:{}),...(extra.extraTargets??[])];
        const spec={family:'on-defense',...shape,cardId:entry.setCode,sourceTypes:entry.card.types,sourceArena:entry.card.arena,sourceInPlay:true,sourceDamage:extra.lethalOnAttack?entry.card.hp-1:0,attackerCode:attacker.setCode,attackerIndex:0,attackBaseDamage:1,defendingBaseDamage:0,targets,...extra};delete spec.extraTargets;
        result.cases.push({id:`auto/${entry.setCode}/on-defense-${name}`,name:'on-defense-'+name,kind:'probe',focusCardIds:[entry.setCode],setupCardIds:[...new Set(targets.map(t=>t.code))].sort(),behaviorIds:['on-defense',shape.kind],assertionStages:['construction','activation','observation'],coverageObligationIds:[oid],probe:spec});
    }
    add('quiet',quiet);add('damaged-defender',quiet,{sourceDamage:Math.max(0,entry.card.hp-2)});
    if(shape.optional)add('decline',quiet,{decline:true});
    if(shape.kind==='ready')add('already-ready',quiet,{readyDefender:true});
    if(shape.kind==='base-damage')add('base-victory',quiet,{defendingBaseDamage:29,terminalBaseBoundary:true});
    for(const [name,attacker,options]of [['restore',restore,{}],['saboteur',saboteur,{shields:2}],['onattack-lethal',damage,{lethalOnAttack:true}]]){
        if(attacker)for(const defenderFirst of [false,true])add(name+'-'+(defenderFirst?'defender-first':'attacker-first'),attacker,{...options,defenderFirst});else obligation(name,'No supported metadata/IR attacker donor');
    }
    if(ambush)add('actual-ambush',ambush,{ambush:true,defenderFirst:true});else obligation('ambush','No supported matching-arena Ambush donor');
    if(overwhelm)add('overwhelm',overwhelm);else obligation('overwhelm','No supported matching-arena Overwhelm donor');
    if(shape.kind==='ready'&&restore)add('already-ready-restore',restore,{readyDefender:true,defenderFirst:true});
    if(shape.kind==='chosen-experience'){
        add('experience-attacker',quiet,{chosenDefenseTarget:{target:0}});
        const otherArena=defs.find(e=>e.status==='supported'&&e.card.types.includes('unit')&&!e.card.types.includes('leader')&&e.card.arena!==entry.card.arena&&!e.card.unique&&!Object.values(e.abilities??{}).flat().length&&!Object.keys(e.keywordValues??{}).length);
        if(otherArena)for(const owner of ['self','opponent'])add('experience-other-arena-'+owner,quiet,{extraTargets:[target(otherArena,owner,{exhausted:true})],chosenDefenseTarget:{target:1}});else obligation('other-arena-selector','No quiet opposite-arena donor');
    }
    for(const dimension of ['initial-attack-stat-death-ordering','selected-ability-stat-death-ordering','attacker-death-before-defense','controller-change-during-attack','multi-target-attack','token-aura-entry-death','attack-lki-query','capacity-boundary','ambush-residual-onplay-triggers'])obligation(dimension,'No automatic '+dimension+' witness in this bounded defense family');
    return result;
}
module.exports={classifyOnDefense,planOnDefenseProbes};
