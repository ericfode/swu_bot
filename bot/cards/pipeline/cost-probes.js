'use strict';
// Construction adapters for exact supported hasCost shapes. Source review and
// oracle observations remain separate from structural experiment planning.
const keys=(v,allowed)=>v&&Object.keys(v).every(k=>allowed.includes(k));
function costPredicate(p, root='card') {
    if (!keys(p,['kind','op','left','right'])||p?.kind!=='binary'||p.op!=='&&') return null;
    const a=p.left,b=p.right;
    if(!keys(a,['kind','name','receiver','args'])||!keys(a.receiver,['kind','path'])||a.receiver?.kind!=='ref'||!Array.isArray(a.args)||a?.kind!=='query'||a.name!=='hasCost'||a.args?.length||JSON.stringify(a.receiver?.path)!==JSON.stringify([root]))return null;
    if(!keys(b,['kind','op','left','right'])||!keys(b.left,['kind','path'])||!keys(b.right,['kind','value'])||b.left?.kind!=='ref'||b?.kind!=='binary'||b.op!=='<='||JSON.stringify(b.left?.path)!==JSON.stringify([root,'cost'])||b.right?.kind!=='const'||!Number.isInteger(b.right.value)||b.right.value<0)return null;
    return b.right.value;
}
function classifyCostShape(entry) {
    const all=Object.values(entry.abilities??{}).flat();
    if(all.length===0 && entry.card?.types.includes('upgrade') && !Object.keys(entry.keywordValues??{}).length) {const threshold=costPredicate(entry.attachCondition);return threshold===null?null:{kind:'attach',threshold};}
    if(all.length!==1||!entry.card?.types.includes('unit')||entry.card.types.includes('leader')||!(entry.abilities?.card??[]).length)return null;
    const a=all[0];if(!keys(a,['trigger','title','costs','optional','targetResolver','effect'])||a.costs?.length||a.then||a.ifYouDo||a.condition||a.coordinate||a.requiresConfirmation)return null;
    if(a.trigger==='whenPlayed'&&a.effect?.kind==='conditional'&&a.effect.onTrue?.kind==='discardOwnHand'&&a.effect.onTrue.target==='enemyPlayer'&&a.effect.onTrue.amount?.value===1&&a.effect.onFalse?.kind==='noAction') {
        if(!keys(a.effect,['kind','condition','onTrue','onFalse'])||!keys(a.effect.onTrue,['kind','amount','target'])||!keys(a.effect.onTrue.amount,['kind','value'])||!keys(a.effect.onFalse,['kind']))return null;
        const q=a.effect.condition;if(!keys(q,['kind','name','receiver','args'])||!keys(q.receiver,['kind','path'])||q.receiver?.kind!=='ref'||q?.kind!=='query'||q.name!=='hasSomeArenaUnit'||JSON.stringify(q.receiver?.path)!=='["player"]'||q.args?.length!==1)return null;
        const p=q.args[0];if(p?.kind==='binary'&&p.op==='&&'&&p.left?.kind==='const'&&p.left.value===true&&(!keys(p,['kind','op','left','right'])||!keys(p.left,['kind','value'])))return null;
        const threshold=costPredicate(p?.kind==='binary'&&p.op==='&&'&&p.left?.kind==='const'&&p.left.value===true?p.right:p);
        return threshold===null?null:{kind:'discard',threshold,ability:a};
    }
    if(!keys(a.effect,['kind','target']))return null;
    const r=a.targetResolver,threshold=costPredicate(r?.predicate);
    if(threshold===null||!keys(r,['owner','type','zone','predicate','optional'])||!r||!['any'].includes(r.owner??'any')||!['anyAttackable','arena',undefined].includes(r.zone)||r.mode||r.count||r.arena)return null;
    if(a.trigger==='whenPlayed'&&r.type==='upgrade'&&a.effect?.kind==='defeat'&&a.effect.target==='chosen'&&a.optional===true)return {kind:'upgrade-defeat',threshold,ability:a};
    if(a.trigger==='whenDefeated'&&r.type==='unit'&&a.effect?.kind==='ready'&&a.effect.target==='chosen'&&a.optional===true)return {kind:'death-ready',threshold,ability:a};
    return null;
}
function planCostProbes(entry,options={}) {
    const shape=classifyCostShape(entry);if(!shape||entry.status!=='supported')return null;
    const definitions=Array.isArray(options.catalogue)?options.catalogue:options.catalogue?.cards??[];
    const result={schema:'swu-card-probes/v1',cardId:entry.setCode,sourceHash:entry.sourceHash,cases:[],obligations:[],uncovered:[]};
    const obligation=(dimension,reason)=>{const id=`${entry.setCode}:cost-query:${dimension}`;result.obligations.push({id,path:'cost-query',dimension});if(reason)result.uncovered.push({id,path:'cost-query',reason});return id;};
    obligation('source-semantics','Structural IR experiments require independent printed/full-source completeness review');
    for(const keyword of Object.keys(entry.keywordValues??{}))obligation('intrinsic-'+keyword,'No intrinsic keyword combat lifecycle adapter');
    const quiet=definitions.filter(e=>e.status==='supported'&&e.card?.types.includes('unit')&&!e.card.types.includes('leader')&&!e.card.types.includes('token')&&!e.card.text&&!e.card.unique);
    const at=n=>quiet.find(e=>e.card.cost===n&&e.card.arena==='ground');
    const leader=definitions.find(e=>e.status==='supported'&&e.card?.types.includes('leader')&&e.card.cost<=shape.threshold&&!(e.abilities?.unit??[]).length);
    const token=definitions.find(e=>e.card?.types.includes('token')&&e.card.types.includes('unit')&&e.card.cost===0&&!e.card.text);
    const target=(e,owner='self',extra={})=>({code:e.setCode,owner,arena:e.card.arena,...(e.card.types.includes('token')?{token:e.internalName}:{}),...extra});
    function add(name,targets,extra={}) {const id=obligation(name);const spec={family:'cost-query',shape:shape.kind,threshold:shape.threshold,cardId:entry.setCode,sourceTypes:entry.card.types,sourceArena:entry.card.arena,targets,...extra};result.cases.push({id:`auto/${entry.setCode}/cost-${name}`,name:'cost-'+name,kind:'probe',focusCardIds:[entry.setCode],setupCardIds:[...new Set([...targets.map(t=>t.code),...targets.flatMap(t=>(t.attachments??[]).map(a=>a.code)),...(spec.activationCode?[spec.activationCode]:[]),...(spec.leaderCode?[spec.leaderCode]:[])])].sort(),behaviorIds:['cost-query',shape.kind],assertionStages:['construction','activation','observation'],coverageObligationIds:[id],probe:spec});}
    if(!at(shape.threshold)||!at(shape.threshold+1)||!at(0)||!token) {obligation('construction','Missing quiet threshold/threshold-plus-one/zero/token metadata');return result;}
    if(shape.kind==='discard') {
        for(const [name,e,owner] of [['zero',at(0),'self'],['threshold',at(shape.threshold),'self'],['token-zero',token,'self'],['above',at(shape.threshold+1),'self'],['opponent-only',at(0),'opponent']])add(name,[target(e,owner)],{expectedDiscard:owner==='self'&&e.card.cost<=shape.threshold});
        add('empty-arena',[],{expectedDiscard:false});
        const space=quiet.find(e=>e.card.arena==='space'&&e.card.cost<=shape.threshold);if(space)add('friendly-space',[target(space)],{expectedDiscard:true});else obligation('friendly-space','No cheap quiet space donor');
    } else if(shape.kind==='attach') {
        for(const [name,e]of [['zero',at(0)],['threshold',at(shape.threshold)],['token-zero',token]])for(const owner of ['self','opponent'])add(name+'-'+owner,[target(e,owner),target(at(shape.threshold+1),owner)],{chosenTarget:0,expectedAttach:true,upgradePower:entry.card.upgradePower,upgradeHp:entry.card.upgradeHp});
        add('above-only',[target(at(shape.threshold+1))],{negativeOnly:true,expectedAttach:false});
        add('cancel',[target(at(shape.threshold))],{decline:true,expectedAttach:false});
    } else if(shape.kind==='upgrade-defeat') {
        const upgrades=definitions.filter(e=>e.status==='supported'&&e.card?.types.includes('upgrade')&&!e.card.types.includes('token')&&!e.card.unique&&!Object.keys(e.keywordValues??{}).length&&Object.values(e.abilities??{}).flat().every(a=>a.trigger==='whenPlayed'));
        const attachEligible=(expr,card)=>{
            if(!expr)return true;if(expr.kind==='const')return expr.value;
            if(expr.kind==='unary'&&expr.op==='!'){const v=attachEligible(expr.value,card);return v===null?null:!v;}
            if(expr.kind==='binary'){const a=attachEligible(expr.left,card),b=attachEligible(expr.right,card);if(a===null||b===null)return null;if(expr.op==='&&')return a&&b;if(expr.op==='<=')return a<=b;}
            if(expr.kind==='query'&&JSON.stringify(expr.receiver?.path)==='["card"]') {if(expr.name==='isUnit'&&!expr.args.length)return card.types.includes('unit');if(expr.name==='getPower'&&!expr.args.length)return card.power;if(expr.name==='hasSomeTrait'&&expr.args.length===1&&expr.args[0].kind==='const')return card.traits.includes(expr.args[0].value);}return null;
        };
        const candidates=upgrades.filter(e=>e.card.cost<=shape.threshold).map(upgrade=>({upgrade,host:quiet.find(e=>e.card.hp>=4&&attachEligible(upgrade.attachCondition,e.card)===true)})).filter(x=>x.host);
        const high=upgrades.filter(e=>e.card.cost===shape.threshold+1).map(upgrade=>({upgrade,host:quiet.find(e=>e.card.hp>=4&&attachEligible(upgrade.attachCondition,e.card)===true)})).find(x=>x.host);
        const low=candidates.find(x=>x.upgrade.card.cost===shape.threshold)??candidates[0];
        const shields=definitions.find(e=>e.internalName==='shield'&&e.card?.types.includes('token')),exp=definitions.find(e=>e.internalName==='experience'&&e.card?.types.includes('token'));
        if(!low||!shields||!exp){obligation('attachments','Missing quiet legally-attached ordinary upgrade or actual token metadata');return result;}
        if(low.upgrade.card.cost!==shape.threshold)obligation('exact-upgrade-threshold','No quiet legally-attached upgrade at the printed threshold');
        if(!high)obligation('above-upgrade-threshold','No legally-attached threshold-plus-one upgrade without active attached registrations');
        for(const owner of ['self','opponent'])for(const [name,e]of [['ordinary',low.upgrade],['shield-zero',shields],['experience-zero',exp]])add(name+'-'+owner,[target(low.host,owner,{attachments:[{code:e.setCode,...(e.card.types.includes('token')?{token:e.internalName}:{})}]}),...(high?[target(high.host,owner,{attachments:[{code:high.upgrade.setCode}]})]:[])],{chosenAttachment:{target:0,index:0},expectedDefeat:true});
        add('decline',[target(low.host,'self',{attachments:[{code:low.upgrade.setCode}]})],{decline:true,expectedDefeat:false});
        add('empty-attachments',[target(low.host)],{expectedDefeat:false,noEligible:true});
        if(high)add('above-only',[target(high.host,'self',{attachments:[{code:high.upgrade.setCode}]})],{expectedDefeat:false,noEligible:true});
        const deathHost=definitions.find(e=>e.status==='supported'&&e.card?.types.includes('unit')&&!e.card.types.includes('leader')&&attachEligible(low.upgrade.attachCondition,e.card)===true&&Object.values(e.abilities??{}).flat().length===1&&e.abilities.card[0]?.trigger==='whenDefeated'&&!e.abilities.card[0].optional&&e.abilities.card[0].effect?.kind==='draw'&&e.abilities.card[0].effect.target==='ownPlayer'&&e.abilities.card[0].effect.amount?.value===1);
        if(deathHost&&low.upgrade.card.upgradeHp>0)add('host-hp-loss-death',[target(deathHost,'self',{damage:deathHost.card.hp+low.upgrade.card.upgradeHp-1,attachments:[{code:low.upgrade.setCode}]})],{chosenAttachment:{target:0,index:0},expectedDefeat:true,expectedHostDeath:true,expectedDeathDraw:1});else obligation('host-hp-loss-death','No legal mandatory-draw host with positive printed upgrade HP');
    } else {
        const activation=definitions.find(e=>e.status==='supported'&&e.card?.types.includes('event')&&e.abilities?.card?.length===1&&e.abilities.card[0].trigger==='event'&&e.abilities.card[0].effect?.kind==='defeat'&&e.abilities.card[0].effect.target==='chosen'&&e.abilities.card[0].targetResolver?.type==='unit'&&!e.abilities.card[0].targetResolver.predicate);
        if(!activation){obligation('death-activation','Missing simple unit-defeat event');return result;}
        const extras={sourceInPlay:true,activationCode:activation.setCode};
        for(const [name,e]of [['zero',at(0)],['threshold',at(shape.threshold)],['token-zero',token]])for(const owner of ['self','opponent'])add(name+'-'+owner,[target(e,owner,{exhausted:true}),target(at(shape.threshold+1),owner,{exhausted:true})],{...extras,chosenTarget:0,expectedReady:true});
        add('no-eligible',[target(at(shape.threshold+1),'self',{exhausted:true})],{...extras,noEligible:true,expectedReady:false});
        add('decline',[target(at(shape.threshold),'self',{exhausted:true})],{...extras,decline:true,expectedReady:false});
        add('ready-excluded',[target(at(shape.threshold),'self',{exhausted:false}),target(at(0),'self',{exhausted:true})],{...extras,chosenTarget:1,expectedReady:true});
    }
    if(leader&&['attach','death-ready'].includes(shape.kind)){const activationCode=result.cases.find(c=>c.probe.activationCode)?.probe.activationCode;add('deployed-leader',[{code:leader.setCode,owner:'self',arena:leader.card.arena??'ground',leader:true,exhausted:true}],{leaderCode:leader.setCode,chosenTarget:0,...(shape.kind==='attach'?{expectedAttach:true,upgradePower:entry.card.upgradePower,upgradeHp:entry.card.upgradeHp}:{sourceInPlay:true,activationCode,expectedReady:true})});}else if(shape.kind==='attach'){const highLeader=definitions.find(e=>e.status==='supported'&&e.card?.types.includes('leader')&&e.card.cost>shape.threshold&&!(e.abilities?.unit??[]).length);if(highLeader)add('deployed-leader-above',[{code:highLeader.setCode,owner:'self',arena:highLeader.card.arena??'ground',leader:true}],{leaderCode:highLeader.setCode,negativeOnly:true,expectedAttach:false});else obligation('leader-boundary','No applicable deployed-leader construction donor');}else obligation('leader-boundary','No applicable deployed-leader construction donor');
    obligation('interaction-timing','Only declared finite attachment/death scenarios are exercised');
    return result;
}
module.exports={planCostProbes,classifyCostShape,costPredicate};
