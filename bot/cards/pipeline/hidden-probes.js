'use strict';
const keys=(v,allowed)=>v&&Object.keys(v).every(k=>allowed.includes(k));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function classifyHidden(entry){
    if(entry.status!=='supported')return null;const all=Object.values(entry.abilities??{}).flat(),a=all[0];
    if(all.length!==1||!entry.abilities?.card?.length||!keys(a,['trigger','title','costs','effect','targetResolver','condition','optional','ifYouDo'])||a.costs?.length&&!(a.trigger==='action'&&same(a.costs,[{kind:'exhaustSelf'}]))||!a.effect||a.optional!==undefined&&typeof a.optional!=='boolean')return null;
    const e=a.effect,r=a.targetResolver;
    if(entry.card.types.includes('event')){if(a.ifYouDo)return null;
        if(a.trigger==='event'&&same(e,{kind:'giveExperience',target:'chosen',amount:{kind:'const',value:1}})&&same(r,{owner:'self',type:'any',zone:'anyAttackable',predicate:{kind:'query',name:'hasSomeKeyword',receiver:{kind:'ref',path:['card']},args:[{kind:'const',value:'hidden'}]},mode:'upTo',count:{kind:'const',value:3},optional:true})&&!a.condition&&!a.optional)return {kind:'query',intrinsic:false};return null;
    }
    if(entry.card.types.includes('unit')&&!entry.card.types.includes('leader')&&!entry.card.types.includes('token')&&a.trigger==='action'&&same(a.costs,[{kind:'exhaustSelf'}])&&same(e,{kind:'distributeHealing',amount:{kind:'const',value:2},maxTargets:1,canChooseNoTargets:true,canDistributeLess:true,targetResolver:{owner:'any',type:'unit',zone:'anyAttackable'}})&&keys(a.ifYouDo,['title','costs','targetResolver','effect'])&&same({...a.ifYouDo,title:undefined},{title:undefined,costs:[],targetResolver:{owner:'any',type:'unit',zone:'anyAttackable'},effect:{kind:'damage',target:'chosen',amount:{kind:'ref',path:['event','totalDistributed']}}})&&entry.keywordValues?.hidden===1&&!r&&!a.condition&&!a.optional)return {kind:'healing',intrinsic:true};
    if(a.ifYouDo||a.costs?.length)return null;
    const unit=entry.card.types.includes('unit')&&!entry.card.types.includes('leader')&&!entry.card.types.includes('token');
    const ref=path=>({kind:'ref',path}),gain=keyword=>({kind:'gainKeyword',target:'chosen',duration:'persistent',keyword,amount:{kind:'const',value:1}});
    if(unit&&a.trigger==='constant'&&r?.owner==='self'&&r.type==='unit'&&r.zone==='arena'&&keys(r,['owner','type','zone','predicate'])&&!a.optional){
        const flatten=p=>p?.kind==='binary'&&p.op==='&&'?[...flatten(p.left),...flatten(p.right)]:[p];
        const clauses=flatten(r.predicate),other={kind:'binary',op:'!==',left:ref(['card']),right:ref(['source'])};
        let trait=null,valid=true,exclude=false;
        for(const c of clauses){
            if(same(c,other))exclude=true;
            else if(same(c,{kind:'query',name:'isUnit',receiver:ref(['card']),args:[]})){}
            else if(same(c,{kind:'binary',op:'===',left:ref(['card','controller']),right:ref(['player'])})){}
            else if(c?.kind==='query'&&c.name==='hasSomeTrait'&&same(c.receiver,ref(['card']))&&c.args?.length===1&&c.args[0].kind==='const'&&typeof c.args[0].value==='string'&&!trait)trait=c.args[0].value;
            else valid=false;
        }
        if(valid&&exclude&&same(e,gain('hidden'))&&!a.condition)return {kind:'grant-aura',intrinsic:entry.keywordValues?.hidden===1,trait};
        if(same(r.predicate,{kind:'binary',op:'===',left:ref(['card']),right:ref(['source'])})&&same(e,{kind:'simultaneous',effects:[gain('hidden'),gain('saboteur')]})&&a.condition?.kind==='query'&&a.condition.name==='hasSomeTrait'&&same(a.condition.receiver,ref(['player','base']))&&a.condition.args?.length===1&&a.condition.args[0].kind==='const'&&typeof a.condition.args[0].value==='string')return entry.keywordValues?.hidden===1?null:{kind:'base-grant',intrinsic:false,baseTrait:a.condition.args[0].value};
    }
    // keywordValues is the compiler's pinned printed-keyword extraction, not raw keyword mentions.
    if(!entry.card.types.includes('unit')||entry.card.types.includes('leader')||entry.card.types.includes('token')||entry.keywordValues?.hidden!==1)return null;
    if(a.optional)return null;
    if(a.trigger==='constant'&&same(e,{kind:'modifyStats',target:'self',duration:'persistent',power:{kind:'const',value:2},hp:{kind:'const',value:0}})&&same(a.condition,{kind:'query',name:'hasInitiative',receiver:{kind:'ref',path:['player']},args:[]})&&!r)return {kind:'initiative',intrinsic:true};
    if(a.trigger==='whenPlayed'&&same(e,{kind:'giveShield',target:'chosen',amount:{kind:'const',value:1}})&&same(r,{owner:'self',type:'unit',zone:'anyAttackable',predicate:{kind:'binary',op:'!==',left:{kind:'ref',path:['card']},right:{kind:'ref',path:['source']}}})&&!a.condition)return {kind:'shield',intrinsic:true};
    if(a.trigger==='onDefense'&&same(e,{kind:'conditional',condition:{kind:'binary',op:'===',left:{kind:'ref',path:['source','zoneName']},right:{kind:'const',value:'groundArena'}},onTrue:{kind:'returnToHand',target:'self'},onFalse:{kind:'noAction'}})&&!r&&!a.condition)return {kind:'return',intrinsic:true};
    if(a.trigger==='whenDefeated'&&same(e,{kind:'exhaust',target:'chosen'})&&same(r,{owner:'opponent',type:'unit',zone:'anyAttackable'})&&!a.condition)return {kind:'death-exhaust',intrinsic:true};
    if(a.trigger==='onAttack'&&same(e,{kind:'readyResources',target:'ownPlayer',amount:{kind:'query',name:'arenaUnitCount',receiver:{kind:'ref',path:['player']},args:[{kind:'const',value:true}]}})&&!r&&!a.condition)return {kind:'resources',intrinsic:true};
    if(a.trigger==='constant'&&same(e,{kind:'modifyStats',target:'chosen',duration:'persistent',power:{kind:'const',value:-3},hp:{kind:'const',value:0}})&&r?.owner==='opponent'&&r.type==='unit'&&r.zone==='arena'&&keys(r,['owner','type','zone','predicate'])&&!a.condition){
        const p=r.predicate;
        const q=name=>({kind:'query',name,receiver:{kind:'ref',path:['card']},args:[]});
        const expected={kind:'binary',op:'&&',left:{kind:'binary',op:'&&',left:{kind:'binary',op:'&&',left:q('isUnit'),right:q('isInPlay')},right:q('isDefending')},right:{kind:'binary',op:'===',left:{kind:'ref',path:['card','activeAttack','attacker']},right:{kind:'ref',path:['source']}}};
        if(same(p,expected))return {kind:'attack-aura',intrinsic:true};
    }
    return {kind:'unsupported-intrinsic',intrinsic:true,effectKind:e.kind};
}
function planHiddenProbes(entry,options={}){
    const shape=classifyHidden(entry);if(!shape)return null;
    const defs=Array.isArray(options.catalogue)?options.catalogue:options.catalogue?.cards??[];
    const result={schema:'swu-card-probes/v1',cardId:entry.setCode,sourceHash:entry.sourceHash,cases:[],obligations:[],uncovered:[]};
    const obligation=(d,reason)=>{const id=entry.setCode+':hidden:'+d;result.obligations.push({id,path:'hidden',dimension:d});if(reason)result.uncovered.push({id,path:'hidden',reason});return id;};
    obligation('source-semantics','Finite Hidden experiments need independent complete source/helper review');
    if(shape.kind==='unsupported-intrinsic'){obligation('complete-source-ability','Hidden lifecycle cannot admit unsupported independent '+shape.effectKind+' source behavior');return result;}
    const quiet=defs.filter(e=>e.status==='supported'&&e.card.types.includes('unit')&&!e.card.types.includes('leader')&&!e.card.types.includes('token')&&!e.card.unique&&!Object.values(e.abilities??{}).flat().length&&!Object.keys(e.keywordValues??{}).length).sort((a,b)=>a.setCode.localeCompare(b.setCode));
    const target=(e,owner,extra={})=>({code:e.setCode,owner,arena:e.card.arena,damage:0,exhausted:owner==='self',...extra});
    function add(name,targets,extra={}){
        const oid=obligation(name),spec={family:'hidden',...shape,cardId:entry.setCode,sourceTypes:entry.card.types,sourceArena:entry.card.arena,targets,...extra};
        result.cases.push({id:`auto/${entry.setCode}/hidden-${name}`,name:'hidden-'+name,kind:'probe',focusCardIds:[entry.setCode],setupCardIds:[...new Set([...targets.map(t=>t.code),...targets.flatMap(t=>(t.attachments??[]).map(a=>a.code)),...(extra.activationCode?[extra.activationCode]:[])])].sort(),behaviorIds:['hidden',shape.kind],assertionStages:['construction','activation','observation'],coverageObligationIds:[oid],probe:spec});
    }
    if(shape.kind==='grant-aura'&&shape.intrinsic){
        const attacker=quiet.find(e=>e.card.arena===entry.card.arena);if(attacker)for(const staged of [false,true])add(staged?'intrinsic-staged':'intrinsic-played',[target(attacker,'opponent',{exhausted:false}),target(attacker,'self')],{sourceInPlay:staged,staged,sourceFamily:false,initiative:'self'});else obligation('intrinsic-attack-arena','No quiet same-arena attacker');
    }
    if(shape.kind==='grant-aura'&&entry.keywordValues?.raid){const attacker=quiet.find(e=>e.card.arena===entry.card.arena);if(attacker)add('intrinsic-raid-combat',[target(attacker,'opponent',{exhausted:false}),target(attacker,'self')],{activateRaid:true,raidAmount:entry.keywordValues.raid,sourceFamily:false,initiative:'self'});}
    if(shape.kind==='grant-aura'){
        const donor=defs.filter(e=>e.status==='supported'&&e.card.types.includes('unit')&&!e.card.types.includes('leader')&&!e.card.types.includes('token')&&!Object.keys(e.keywordValues??{}).length&&(!shape.trait||e.card.traits.includes(shape.trait))&&!Object.values(e.abilities??{}).flat().some(a=>a.trigger==='whenPlayed')).sort((a,b)=>a.setCode.localeCompare(b.setCode))[0];
        const attacker=quiet.find(e=>e.card.arena===donor?.card.arena),wrong=quiet.find(e=>!shape.trait||!e.card.traits.includes(shape.trait));
        if(!donor||!attacker||!wrong){obligation('aura-donors','Missing metadata bounded trait donor/attacker');return result;}
        const opposite=defs.filter(e=>e.status==='supported'&&e.card.types.includes('unit')&&!e.card.types.includes('leader')&&!e.card.types.includes('token')&&e.card.arena!==donor.card.arena&&!e.keywordValues?.hidden&&(!shape.trait||e.card.traits.includes(shape.trait))).sort((a,b)=>a.setCode.localeCompare(b.setCode))[0];
        const defeat=defs.find(e=>e.status==='supported'&&e.abilities.card?.length===1&&same(e.abilities.card[0].effect,{kind:'defeat',target:'chosen'})&&same(e.abilities.card[0].targetResolver,{owner:'any',type:'unit',zone:'anyAttackable'}));
        for(const donorPlayed of [false,true])add(donorPlayed?'aura-played-donor':'aura-staged-donor',[target(donor,'self',{zone:donorPlayed?'hand':undefined}),target(attacker,'opponent',{exhausted:false}),target(wrong,'self'),target(donor,'opponent'),...(opposite?[target(opposite,'self')]:[])],{sourceInPlay:false,donorPlayed,resourceCount:20,sourceFamily:true,initiative:'self'});
        if(defeat)add('aura-source-departure',[target(donor,'self',{zone:'hand'}),target(attacker,'opponent',{exhausted:false}),target(wrong,'self'),target(donor,'opponent')],{donorPlayed:true,resourceCount:28,sourceFamily:true,initiative:'self',activationCode:defeat.setCode,activateAuraDeparture:true});else obligation('actual-aura-departure','No supported real source defeat event');
    }else if(shape.kind==='base-grant'){
        const ally=quiet.find(e=>e.card.arena===entry.card.arena),bases=defs.filter(e=>e.card.types.includes('base')&&!e.card.text);
        for(const baseMatches of [false,true]){const base=bases.find(e=>e.card.traits.includes(shape.baseTrait)===baseMatches);if(base&&ally)add('base-'+(baseMatches?'matching':'nonmatching'),[target(ally,'opponent',{exhausted:false}),target(ally,'self')],{baseCode:base.setCode,enemyBaseCode:bases.find(e=>e.card.traits.includes(shape.baseTrait)!==baseMatches)?.setCode,baseMatches,sourceFamily:true,initiative:'self'});else obligation('base-metadata','No matching/nonmatching printed base trait');}
        const base=bases.find(e=>e.card.traits.includes(shape.baseTrait)),shield=defs.find(e=>e.card.types.includes('token')&&e.card.types.includes('upgrade')&&e.internalName==='shield');if(base&&ally&&shield)add('conditional-saboteur-combat',[target(ally,'opponent',{exhausted:false,attachments:[{code:shield.setCode,token:'shield'},{code:shield.setCode,token:'shield'}]}),target(ally,'self')],{baseCode:base.setCode,baseMatches:true,activateSaboteur:true,sourceFamily:false,initiative:'self'});
    }else if(shape.kind==='healing'){
        const ally=quiet.find(e=>e.card.arena===entry.card.arena);if(ally)for(const staged of [false,true])add(staged?'intrinsic-staged':'intrinsic-played',[target(ally,'opponent',{exhausted:false}),target(ally,'self')],{sourceInPlay:staged,staged,sourceFamily:false,initiative:'self'});if(ally)for(const damage of [0,1,2])add('healing-damage-'+damage,[target(ally,'self',{damage}),target(ally,'opponent',{exhausted:false})],{sourceFamily:true,healDamage:damage,initiative:'self'});else obligation('healing-donors','No quiet unit donor');
    }else if(shape.kind==='query'){
        const hidden=defs.find(e=>e.status==='supported'&&e.card.types.includes('unit')&&!e.card.types.includes('leader')&&!e.card.unique&&e.keywordValues?.hidden===1&&Object.values(e.abilities??{}).flat().length===1&&e.abilities.card[0].trigger==='constant'&&e.abilities.card[0].effect.target==='self');
        if(!hidden||!quiet.length){obligation('query-donors','No simple intrinsic Hidden or plain unit donor');return result;}
        add('query-after-expiry',[target(hidden,'self',{zone:'hand'}),target(hidden,'self'),target(hidden,'opponent'),target(quiet[0],'self')],{queryAfterExpiry:true,sourceFamily:true,initiative:'self'});
        add('query-decline',[target(hidden,'self'),target(hidden,'opponent')],{decline:true,sourceFamily:true,initiative:'self'});
        const otherHidden=defs.find(e=>e.setCode!==hidden.setCode&&e.status==='supported'&&e.card.types.includes('unit')&&!e.card.types.includes('leader')&&e.keywordValues?.hidden===1&&!Object.values(e.abilities??{}).flat().some(a=>a.trigger==='constant'&&a.effect?.kind==='gainKeyword'));if(otherHidden)add('query-limit',[...Array.from({length:3},()=>target(hidden,'self')),target(otherHidden,'self'),target(hidden,'opponent'),target(quiet[0],'self')],{sourceFamily:true,queryLimit:true,initiative:'self'});else obligation('query-fourth-donor','No distinct real Hidden unit for legal fourth eligible friendly copy');
        add('query-no-hidden',[target(quiet[0],'self')],{noEligible:true,sourceFamily:true,initiative:'self'});
    }else{
        const ally=quiet.find(e=>e.card.arena===entry.card.arena),saboteur=defs.filter(e=>e.status==='supported'&&e.card.types.includes('unit')&&!e.card.types.includes('leader')&&e.card.arena===entry.card.arena&&!Object.values(e.abilities??{}).flat().length&&e.keywordValues?.saboteur===1&&!e.keywordValues?.hidden).sort((a,b)=>a.setCode.localeCompare(b.setCode))[0];
        if(!ally){obligation('attacker','No plain same-arena attacker and Shield donor');return result;}
        const targets=attacker=>[target(attacker,'opponent',{exhausted:false}),target(ally,'self')];
        for(const staged of [false,true]){add(staged?'staged':'normal-play',targets(ally),{sourceInPlay:staged,staged});if(saboteur)add((staged?'staged':'played')+'-saboteur',targets(saboteur),{sourceInPlay:staged,staged});else obligation('saboteur','No supported matching-arena Saboteur attacker');}
        if(entry.keywordValues?.saboteur===1){const shield=defs.find(e=>e.card.types.includes('token')&&e.card.types.includes('upgrade')&&e.internalName==='shield');if(shield)add('focus-saboteur-combat',[target(ally,'opponent',{exhausted:false,attachments:[{code:shield.setCode,token:'shield'},{code:shield.setCode,token:'shield'}]}),target(ally,'self')],{activateSaboteur:true});else obligation('focus-saboteur','No real Shield token metadata');}
        if(shape.kind==='initiative')for(const initiative of ['self','opponent'])add('initiative-'+initiative,targets(ally),{initiative});
        if(shape.kind==='return')for(const overwhelm of [false,true]){
            const attacker=overwhelm?defs.find(e=>e.status==='supported'&&e.card.types.includes('unit')&&!e.card.types.includes('leader')&&e.card.arena===entry.card.arena&&!Object.values(e.abilities??{}).flat().length&&e.keywordValues?.overwhelm===1&&!e.keywordValues?.hidden):ally;
            if(attacker)add(overwhelm?'actual-return-overwhelm':'actual-return',targets(attacker),{activateReturn:true});else obligation('return-overwhelm','No supported same-arena Overwhelm attacker');
        }
        if(shape.kind==='death-exhaust'){
            const defeat=defs.find(e=>e.status==='supported'&&e.card.types.includes('event')&&Object.values(e.abilities??{}).flat().length===1&&e.abilities.card[0].trigger==='event'&&same(e.abilities.card[0].effect,{kind:'defeat',target:'chosen'})&&same(e.abilities.card[0].targetResolver,{owner:'any',type:'unit',zone:'anyAttackable'}));
            if(defeat)add('actual-death-exhaust',targets(ally),{activationCode:defeat.setCode,activateDeath:true});else obligation('death-activation','No simple real unit defeat event');
        }
        if(shape.kind==='attack-aura'){const defender=quiet.find(e=>e.card.arena===entry.card.arena&&e.card.power>=4);if(defender)add('actual-attack-aura',targets(defender),{activateAura:true});else obligation('attack-aura-positive-power','No quiet defender above signed power reduction floor');}
        if(shape.kind==='attack-aura'){
            const upgrade=defs.find(e=>e.status==='supported'&&same(e.card.types,['upgrade'])&&Object.values(e.abilities??{}).flat().length===1&&e.abilities.card?.length===1&&keys(e.abilities.card[0],['trigger','title','costs','effect'])&&same(e.abilities.card[0].costs,[])&&e.abilities.card[0].trigger==='constant'&&same(e.abilities.card[0].effect,{kind:'gainKeyword',target:'parent',duration:'persistent',keyword:'overwhelm',amount:{kind:'const',value:1}})&&same(e.attachCondition,{kind:'binary',op:'&&',left:{kind:'query',name:'isUnit',receiver:{kind:'ref',path:['card']},args:[]},right:{kind:'binary',op:'>',left:{kind:'ref',path:['card','damage']},right:{kind:'const',value:0}}})&&Number.isSafeInteger(e.card.upgradePower)&&e.card.upgradePower>0&&e.card.upgradeHp===0);
            const defender=upgrade&&quiet.find(e=>e.card.arena===entry.card.arena&&e.card.hp<entry.card.power+upgrade.card.upgradePower&&e.card.power>=4);
            if(upgrade&&defender)add('attack-aura-overwhelm-hp-boundary',[target(defender,'opponent',{exhausted:false}),target(ally,'self')],{activateAura:true,activateAuraUpgrade:true,activationCode:upgrade.setCode,sourceInPlay:true,staged:true,sourceDamage:1,upgradePower:upgrade.card.upgradePower});else obligation('aura-hp-boundary','No bounded actual damaged-unit Overwhelm upgrade and defender');
        }
        if(shape.kind==='resources'){
            const spender=defs.find(e=>e.status==='supported'&&e.card.types.includes('event')&&Object.values(e.abilities??{}).flat().length===1&&e.abilities.card[0].trigger==='event'&&e.abilities.card[0].effect?.kind==='draw'&&e.abilities.card[0].effect.target==='ownPlayer'&&e.card.cost>=1&&e.card.cost<=2);
            const opposite=quiet.find(e=>e.card.arena!==entry.card.arena);if(spender&&opposite)add('actual-resource-count',[...targets(ally),target(opposite,'self')],{activationCode:spender.setCode,activateResources:true});else obligation('resource-count','Missing simple paid draw event or opposite-arena own unit');
        }
    }
    for(const keyword of Object.keys(entry.keywordValues??{}).filter(k=>k!=='hidden'))if(keyword!=='saboteur'&&!(keyword==='raid'&&shape.kind==='grant-aura'))obligation('intrinsic-'+keyword,'Independent focused intrinsic '+keyword+' combat witness remains unconstructed');
    for(const dimension of ['live-gain-loss-regain','sentinel-gain-loss','ordinary-return-reentry','token-creation-history','leader-deployment-history','legacy-history-rejection','controller-change-history'])obligation(dimension,'No actual source-card construction for '+dimension+' in this adapter; separate synthetic/history diagnostics are not full-card witnesses');
    return result;
}
module.exports={classifyHidden,planHiddenProbes};
