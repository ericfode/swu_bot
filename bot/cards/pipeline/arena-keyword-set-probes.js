'use strict';
const same=require('node:util').isDeepStrictEqual;
const keys=(o,allowed)=>o&&typeof o==='object'&&Object.keys(o).every(k=>allowed.includes(k));
const noPilot=e=>!e.card?.pilotText&&!e.card?.pilotBox&&!e.card?.pilotingBox&&!e.piloting&&!e.attachCondition;
const constant=v=>({kind:'const',value:v});
const ref=(...path)=>({kind:'ref',path});
const exclusion={kind:'binary',op:'||',left:{kind:'unary',op:'!',value:ref('source')},right:{kind:'binary',op:'!==',left:ref('card'),right:ref('source')}};
function parseList(target){
    if(!keys(target,['kind','receiver','predicate'])||target.kind!=='arenaList'||!keys(target.receiver,['kind','path'])||target.receiver.kind!=='ref'||target.receiver.path?.length!==1||!['game','player'].includes(target.receiver.path[0]))return null;
    let p=target.predicate,excludeSource=false;
    if(keys(p,['kind','op','left','right'])&&p.kind==='binary'&&p.op==='&&'&&same(p.right,exclusion)){excludeSource=true;p=p.left;}
    let trait=null;
    if(!same(p,constant(true))){
        if(!keys(p,['kind','op','left','right'])||p.kind!=='binary'||p.op!=='&&'||!same(p.left,constant(true)))return null;
        const q=p.right;
        if(!keys(q,['kind','name','receiver','args'])||q.kind!=='query'||q.name!=='hasSomeTrait'||!same(q.receiver,ref('card'))||q.args?.length!==1||!keys(q.args[0],['kind','value'])||q.args[0].kind!=='const'||typeof q.args[0].value!=='string'||!q.args[0].value)return null;
        trait=q.args[0].value;
    }
    return {receiver:target.receiver.path[0],trait,excludeSource};
}
function leaf(e){
    if(!e||e.duration!=='phase')return null;
    const scope=parseList(e.target);if(!scope)return null;
    if(e.kind==='gainKeyword'&&keys(e,['kind','target','duration','keyword','amount'])&&same(e.amount,constant(1))&&['raid','restore','sentinel','saboteur'].includes(e.keyword))return {...scope,kind:e.kind,keyword:e.keyword,amount:1};
    if(e.kind==='loseKeyword'&&keys(e,['kind','target','duration','keyword'])&&e.keyword==='saboteur')return {...scope,kind:e.kind,keyword:e.keyword};
    return null;
}
function classifyArenaKeywordSet(entry){
    const card=entry.card,a=entry.abilities?.card?.[0];
    if(entry.status!=='supported'||!card||!noPilot(entry)||!keys(entry.abilities,['card','leader','unit'])||entry.abilities.card?.length!==1||entry.abilities.leader?.length||entry.abilities.unit?.length||!keys(a,['trigger','title','costs','effect'])||typeof a.title!=='string'||!same(a.costs,[]))return null;
    const event=same(card.types,['event']),unit=same(card.types,['unit']);
    if(event){
        if(entry.baseClass!=='EventCard'||a.trigger!=='event'||!same(entry.keywordValues??{},{}))return null;
        const e=a.effect;
        if(!keys(e,['kind','effects'])||!['phaseModifiers','simultaneous'].includes(e.kind)||e.effects?.length!==2)return null;
        const l=e.effects.map(leaf);if(l.some(x=>!x))return null;
        if(e.kind==='phaseModifiers'){
            if(l[0].kind!=='gainKeyword'||l[0].keyword!=='sentinel'||l[1].kind!=='loseKeyword'||l[1].keyword!=='saboteur'||l.some(x=>x.receiver!=='game'||x.trait||x.excludeSource)||!same(e.effects[0].target,e.effects[1].target)||!same([...(card.keywords??[])].sort(),['saboteur','sentinel']))return null;
        }else{
            if(l.some(x=>x.kind!=='gainKeyword'||x.receiver!=='player'||!x.trait||x.excludeSource)||l[0].keyword!=='raid'||!['sentinel','saboteur'].includes(l[1].keyword)||!same([...(card.keywords??[])].sort(),['raid',l[1].keyword].sort()))return null;
        }
        return {family:'arena-keyword-set',trigger:'event',mode:e.kind,leaves:l,intrinsic:{}};
    }
    if(!unit||entry.baseClass!=='NonLeaderUnitCard'||card.arena!=='ground'||a.trigger!=='onAttack'||!same(entry.keywordValues,{restore:1})||!same(card.keywords,['restore']))return null;
    const l=leaf(a.effect);
    if(!l||l.kind!=='gainKeyword'||l.keyword!=='restore'||l.receiver!=='player'||!l.trait||!l.excludeSource)return null;
    return {family:'arena-keyword-set',trigger:'onAttack',mode:'single',leaves:[l],intrinsic:{restore:1}};
}
function quietUnit(e){
    return e.status==='supported'&&same(e.card?.types,['unit'])&&!e.card.unique&&!e.card.text&&!e.card.keywords?.length&&!Object.keys(e.keywordValues??{}).length&&!Object.values(e.abilities??{}).flat().length&&e.sourcePath===null&&e.sourceHash===null&&!e.baseClass&&noPilot(e)&&['ground','space'].includes(e.card.arena);
}
function sentinelHpDonor(e){
    const a=e.abilities?.card?.[0];
    return e.status==='supported'&&e.baseClass==='NonLeaderUnitCard'&&same(e.card.types,['unit'])&&noPilot(e)&&Object.values(e.abilities??{}).flat().length===1&&same(e.keywordValues,{})&&same(e.card.keywords,['sentinel'])&&
        keys(a,['trigger','title','costs','effect','targetResolver'])&&a.trigger==='constant'&&same(a.costs,[])&&same(a.effect,{kind:'modifyStats',target:'chosen',duration:'persistent',power:constant(0),hp:constant(2)})&&
        same(a.targetResolver,{owner:'self',type:'unit',zone:'arena',arena:'ground',predicate:{kind:'query',name:'hasSomeKeyword',receiver:ref('card'),args:[constant('sentinel')]}});
}
function damageDonor(e){
    const a=e.abilities?.card?.[0];
    return e.status==='supported'&&e.baseClass==='EventCard'&&same(e.card.types,['event'])&&noPilot(e)&&!e.card.keywords?.length&&!Object.keys(e.keywordValues??{}).length&&Object.values(e.abilities??{}).flat().length===1&&
        keys(a,['trigger','title','costs','targetResolver','effect'])&&a.trigger==='event'&&same(a.costs,[])&&keys(a.effect,['kind','target','amount'])&&a.effect.kind==='damage'&&a.effect.target==='chosen'&&keys(a.effect.amount,['kind','value'])&&a.effect.amount.kind==='const'&&Number.isInteger(a.effect.amount.value)&&a.effect.amount.value>=1&&a.effect.amount.value<=2&&
        keys(a.targetResolver,['owner','type','zone'])&&a.targetResolver.owner==='any'&&['any','unit'].includes(a.targetResolver.type)&&a.targetResolver.zone==='anyAttackable';
}
function keywordOnly(e){
    if(e.status!=='supported'||!same(e.card?.types,['unit'])||e.card.unique||!noPilot(e)||Object.values(e.abilities??{}).flat().length||!['ground','space'].includes(e.card.arena))return false;
    const values=e.keywordValues??{},names=Object.keys(values).sort();
    if(!names.length||names.some(k=>!['sentinel','saboteur'].includes(k)||values[k]!==1)||!same([...(e.card.keywords??[])].sort(),names))return false;
    if(e.baseClass==='NonLeaderUnitCard')return typeof e.sourcePath==='string'&&e.sourcePath.length>0&&/^[a-f0-9]{64}$/.test(e.sourceHash??'');
    return !e.baseClass&&e.sourcePath===null&&e.sourceHash===null&&same(require('../../omni/rs/make-pool').parseKeywords(e.card),values);
}
function planArenaKeywordSetProbes(entry,options={}){
    const shape=classifyArenaKeywordSet(entry);if(!shape)return null;
    const defs=Array.isArray(options.catalogue)?options.catalogue:options.catalogue?.cards??[],result={schema:'swu-card-probes/v1',cardId:entry.setCode,sourceHash:entry.sourceHash,cases:[],obligations:[],uncovered:[]};
    const quiet=defs.filter(quietUnit).sort((a,b)=>a.setCode.localeCompare(b.setCode));
    const row=(e,owner,extra={})=>({code:e.setCode,owner,arena:e.card.arena,exhausted:false,damage:0,...extra});
    const obligatory=(name,reason)=>{const id=entry.setCode+':arena-keyword-set:'+name;result.obligations.push({id,path:'arena-keyword-set',dimension:name});if(reason)result.uncovered.push({id,path:'arena-keyword-set',reason});return id;};
    const mixed=[];
    for(const arena of ['ground','space'])for(const owner of ['self','opponent']){
        const traits=[...new Set(shape.leaves.map(l=>l.trait).filter(Boolean))];
        for(const trait of traits){const donor=quiet.find(e=>e.card.arena===arena&&e.card.traits.includes(trait));if(donor)mixed.push(row(donor,owner));else obligatory('matching-'+trait+'-'+arena+'-'+owner,'No supported quiet matching donor; no printed trait or source mechanics invented');}
        const wrong=quiet.find(e=>e.card.arena===arena&&shape.leaves.every(l=>!l.trait||!e.card.traits.includes(l.trait)));
        if(wrong)mixed.push(row(wrong,owner));
        if(!traits.length){const donor=quiet.find(e=>e.card.arena===arena);if(donor)mixed.push(row(donor,owner));}
    }
    const unique=mixed.filter((t,i,a)=>a.findIndex(x=>x.code===t.code&&x.owner===t.owner)===i);
    function add(name,targets,extra={}){
        const id=obligatory(name),probe={...shape,cardId:entry.setCode,sourceArena:entry.card.arena,sourceSeat:1,resourceCount:24,initiative:'self',targets,ownBaseDamage:4,...extra};
        result.cases.push({id:`auto/${entry.setCode}/arena-keyword-set-${name}`,name:'arena-keyword-set-'+name,kind:'probe',source:{module:'../pipeline/probe-fixture.js',scenario:'arena-keyword-set-'+name},focusCardIds:[entry.setCode],setupCardIds:[...new Set([...targets.map(t=>t.code),...targets.flatMap(t=>(t.attachments??[]).map(a=>a.code)),...(probe.activationCode?[probe.activationCode]:[])])].sort(),behaviorIds:['arena-list','phase-keyword',shape.mode],assertionStages:['construction','normal-play','resolved-keyword-events'],coverageObligationIds:[id],probe});
    }
    for(const sourceSeat of [1,2]){
        add('mixed-seat-'+sourceSeat,unique,{sourceSeat});add('empty-seat-'+sourceSeat,[],{sourceSeat,empty:true});add('expiry-seat-'+sourceSeat,unique,{sourceSeat,waitForExpiry:true});
    }
    if(shape.trigger==='event'){
        add('empty-cancel',[],{empty:true,cancel:true});
        if(shape.mode==='simultaneous'&&shape.leaves[0].trait!==shape.leaves[1].trait)for(const omitted of [0,1]){
            const other=shape.leaves[1-omitted].trait,donor=quiet.find(e=>e.card.traits.includes(other)&&!e.card.traits.includes(shape.leaves[omitted].trait));
            if(donor)add('only-child-'+(1-omitted),[row(donor,'self')]);
        }
    }
    const shield=defs.find(require('./arena-damage-probes').nativeShield);
    const sentinel=defs.find(e=>keywordOnly(e)&&e.card.arena==='ground'&&same(e.keywordValues,{sentinel:1}));
    const saboteur=defs.find(e=>keywordOnly(e)&&e.card.arena==='ground'&&same(e.keywordValues,{saboteur:1})&&e.card.hp>=3);
    const safeDefender=quiet.find(e=>e.card.arena==='ground'&&e.card.power<=2&&e.card.hp>=6);
    const shields=shield?[{code:shield.setCode,token:'shield'},{code:shield.setCode,token:'shield'}]:[];
    if(shape.mode==='phaseModifiers'&&saboteur&&safeDefender&&shield)add('saboteur-loss-sentinel-shield-combat',[row(saboteur,'self'),row(safeDefender,'opponent',{attachments:shields})],{combat:{kind:'loss-saboteur',attackerIndex:0,defenderIndex:1}});
    if(shape.mode==='simultaneous'){
        const raidLeaf=shape.leaves[0],attacker=quiet.find(e=>e.card.arena==='ground'&&e.card.traits.includes(raidLeaf.trait)&&e.card.hp>=3&&e.card.power<10);
        if(attacker)add('raid-real-base-combat',[row(attacker,'self')],{combat:{kind:'raid',attackerIndex:0}});
        if(shape.leaves[1].keyword==='saboteur'&&attacker&&safeDefender&&sentinel&&shield)add('saboteur-gain-bypass-two-shields',[row(attacker,'self'),row(safeDefender,'opponent',{attachments:shields}),row(sentinel,'opponent')],{combat:{kind:'gain-saboteur',attackerIndex:0,defenderIndex:1}});
        if(shape.leaves[1].keyword==='sentinel')for(const arena of ['ground','space']){
            const friendly=quiet.find(e=>e.card.arena===arena&&e.card.traits.includes(shape.leaves[1].trait)),enemy=quiet.find(e=>e.card.arena===arena);
            if(friendly&&enemy)add('sentinel-real-menu-'+arena,[row(friendly,'self'),row(enemy,'opponent')],{combat:{kind:'sentinel-menu',attackerIndex:1}});
        }
    }
    if(shape.trigger==='onAttack'){
        const ally=quiet.find(e=>e.card.arena==='ground'&&e.card.traits.includes(shape.leaves[0].trait)&&e.card.power<10);
        if(ally)for(const ownBaseDamage of [4,1,0])add('later-recipient-restore-base-'+ownBaseDamage,[row(ally,'self')],{laterRestore:true,ownBaseDamage,restoreAttackerIndex:0});
    }
    const hpAura=defs.find(sentinelHpDonor), damage=defs.find(damageDonor);
    const sentinelLeaf=shape.leaves.find(l=>l.kind==='gainKeyword'&&l.keyword==='sentinel');
    if(shape.trigger==='event'&&sentinelLeaf&&hpAura&&damage){
        const recipient=quiet.find(e=>e.card.arena==='ground'&&e.card.hp>=2&&(!sentinelLeaf.trait||e.card.traits.includes(sentinelLeaf.trait)));
        if(recipient)add('sentinel-hp-damage-expiry',[row(recipient,'self',{damage:recipient.card.hp-1}),row(hpAura,'self',{zone:'hand'})],{hpDependency:true,prerequisiteIndex:1,activationCode:damage.setCode,damageAmount:damage.abilities.card[0].effect.amount.value,hpBonus:2});
    }
    for(const gap of ['source-review',...(result.cases.some(c=>c.probe.combat||c.probe.laterRestore)?[]:['actual-keyword-combat']),'already-present-keywords','numeric-stacking','new-entrant','source-departure','recipient-reentry','controller-transfer','selected-token-leader-membership',...(result.cases.some(c=>c.probe.hpDependency)?[]:['hp-keyword-dependency']),'large-capacity','printed-trait-overlap'])obligatory(gap,'No actual full-source construction yet; engine checkpoints and synthetic primitives do not prove this interaction');
    return result;
}
module.exports={classifyArenaKeywordSet,planArenaKeywordSetProbes,parseList,quietUnit,sentinelHpDonor,damageDonor,keywordOnly};
