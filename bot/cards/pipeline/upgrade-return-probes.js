'use strict';
const keys=(v,allowed)=>v&&Object.keys(v).every(k=>allowed.includes(k));
function classifyUpgradeReturn(entry){
    const all=Object.values(entry.abilities??{}).flat(),a=all[0];
    if(entry.status!=='supported'||all.length!==1||!entry.abilities?.card?.length||a.trigger!=='whenPlayed'||a.optional!==true||a.costs?.length||!keys(a,['trigger','title','costs','optional','targetResolver','effect']))return null;
    const r=a.targetResolver;if(!keys(r,['owner','type','zone','predicate'])||!['any','self'].includes(r.owner)||!['upgrade','any'].includes(r.type)||!['anyAttackable','discard'].includes(r.zone))return null;
    if(r.zone==='discard'&&(r.owner!=='self'||r.type!=='upgrade'||r.predicate))return null;
    if(r.zone!=='discard'&&r.owner!=='any')return null;
    if(!entry.card.types.some(t=>['unit','upgrade'].includes(t))||entry.card.types.includes('leader'))return null;
    let conditional=false,baseTrait=null,e=a.effect;
    if(e.kind==='conditional'){
        const trait=e.condition?.args?.[0];
        if(!keys(trait,['kind','value'])||trait.kind!=='const'||typeof trait.value!=='string'||!trait.value.length)return null;
        const condition={kind:'query',name:'hasSomeTrait',receiver:{kind:'ref',path:['player','base']},args:[{kind:'const',value:trait.value}]};
        if(!keys(e,['kind','condition','onTrue','onFalse'])||JSON.stringify(e.condition)!==JSON.stringify(condition)||JSON.stringify(e.onFalse)!=='{"kind":"noAction"}')return null;
        conditional=true;baseTrait=trait.value;e=e.onTrue;
    }
    if(JSON.stringify(e)!=='{"kind":"returnToHand","target":"chosen"}')return null;
    let threshold=null,nonUnique=false;
    if(r.predicate){
        const p=r.predicate;
        if(JSON.stringify(p)==='{"kind":"unary","op":"!","value":{"kind":"ref","path":["card","unique"]}}'){if(r.type!=='upgrade')return null;nonUnique=true;}
        else {
            if(!keys(p,['kind','op','left','right'])||p.kind!=='binary'||p.op!=='&&')return null;
            const q=p.left,b=p.right;
            if(!keys(q,['kind','name','receiver','args'])||q.kind!=='query'||!['hasCost','isUpgrade'].includes(q.name)||JSON.stringify(q.receiver)!=='{"kind":"ref","path":["card"]}'||q.args?.length)return null;
            if(!keys(b,['kind','op','left','right'])||b.kind!=='binary'||b.op!=='<='||JSON.stringify(b.left)!=='{"kind":"ref","path":["card","cost"]}'||!keys(b.right,['kind','value'])||b.right.kind!=='const'||!Number.isSafeInteger(b.right.value)||b.right.value<0)return null;
            threshold=b.right.value;
            if(r.type==='any'&&q.name!=='isUpgrade')return null;
        }
    }else if(r.type==='any')return null;
    return {threshold,nonUnique,conditional,baseTrait,discard:r.zone==='discard',sourceUpgrade:entry.card.types.includes('upgrade'),ability:a};
}
function metadataAttach(expr,card){
    if(!expr)return true;if(expr.kind==='const'&&keys(expr,['kind','value']))return expr.value;
    if(expr.kind==='unary'&&keys(expr,['kind','op','value'])&&expr.op==='!'){const v=metadataAttach(expr.value,card);return v===null?null:!v;}
    if(expr.kind==='binary'&&keys(expr,['kind','op','left','right'])){const l=metadataAttach(expr.left,card),r=metadataAttach(expr.right,card);if(l===null||r===null)return null;if(expr.op==='&&')return l&&r;if(expr.op==='<=')return l<=r;}
    if(expr.kind==='query'&&keys(expr,['kind','name','receiver','args'])&&keys(expr.receiver,['kind','path'])&&expr.receiver.kind==='ref'&&JSON.stringify(expr.receiver?.path)==='["card"]'){
        if(expr.name==='isUnit'&&!expr.args.length)return card.types.includes('unit');
        if(expr.name==='getPower'&&!expr.args.length)return card.power;
        if(expr.name==='hasSomeTrait'&&expr.args.length===1&&expr.args[0].kind==='const')return card.traits.includes(expr.args[0].value);
    }return null;
}
function planUpgradeReturnProbes(entry,options={}){
    const shape=classifyUpgradeReturn(entry);if(!shape)return null;
    const defs=Array.isArray(options.catalogue)?options.catalogue:options.catalogue?.cards??[];
    const result={schema:'swu-card-probes/v1',cardId:entry.setCode,sourceHash:entry.sourceHash,cases:[],obligations:[],uncovered:[]};
    const obligation=(d,reason)=>{const id=entry.setCode+':upgrade-return:'+d;result.obligations.push({id,path:'upgrade-return',dimension:d});if(reason)result.uncovered.push({id,path:'upgrade-return',reason});return id;};
    obligation('source-semantics','IR-derived construction needs independent full card/helper source review');
    for(const keyword of Object.keys(entry.keywordValues??{}))obligation('intrinsic-'+keyword,'No independent keyword combat lifecycle adapter');
    const quiet=defs.filter(e=>e.status==='supported'&&e.card.types.includes('unit')&&!e.card.types.includes('leader')&&!e.card.unique&&!Object.values(e.abilities??{}).flat().length).sort((a,b)=>a.setCode.localeCompare(b.setCode));
    const upgrades=defs.filter(e=>e.status==='supported'&&e.card.types.includes('upgrade')&&!e.card.types.includes('token')&&Object.values(e.abilities??{}).flat().every(a=>a.trigger==='whenPlayed')).sort((a,b)=>a.setCode.localeCompare(b.setCode));
    const pair=(predicate,hosts=quiet)=>upgrades.filter(predicate).map(upgrade=>({upgrade,host:hosts.find(h=>metadataAttach(upgrade.attachCondition,h.card)===true)})).find(x=>x.host);
    const low=pair(e=>!e.card.unique&&(shape.threshold===null||e.card.cost===shape.threshold));
    if(!low){obligation('construction','No legally attachable ordinary upgrade at exact printed threshold');return result;}
    const high=shape.threshold===null?null:pair(e=>!e.card.unique&&e.card.cost===shape.threshold+1);
    const unique=defs.filter(e=>e.status==='supported'&&e.card.types.includes('upgrade')&&e.card.unique&&Object.values(e.abilities??{}).flat().every(a=>a.trigger==='constant'&&a.effect?.kind==='gainKeyword'&&a.effect.target==='parent')).map(upgrade=>({upgrade,host:quiet.find(h=>metadataAttach(upgrade.attachCondition,h.card)===true)})).find(x=>x.host);
    const bases=defs.filter(e=>e.status==='supported'&&e.card.types.includes('base')&&!e.card.text),matchingBase=bases.find(e=>e.card.traits.includes(shape.baseTrait)),other=bases.find(e=>!e.card.traits.includes(shape.baseTrait));
    const target=(h,owner='self',attachments=[],extra={})=>({code:h.setCode,owner,arena:h.card.arena,attachments,...extra});
    const attached=(p,owner='self',upgradeOwner=owner)=>target(p.host,owner,[{code:p.upgrade.setCode,owner:upgradeOwner}]);
    const token=names=>defs.find(e=>e.card.types.includes('token')&&e.card.types.includes('upgrade')&&names.includes(e.internalName));
    function add(name,targets,extra={}){
        if(shape.sourceUpgrade){targets=[...targets,target(quiet.find(h=>metadataAttach(entry.attachCondition,h.card)===true))];extra={sourceAttachTarget:targets.length-1,...extra};}
        const oid=obligation(name),spec={family:'upgrade-return',...shape,ability:undefined,cardId:entry.setCode,sourceTypes:entry.card.types,sourceArena:entry.card.arena,targets,baseCode:shape.conditional?matchingBase?.setCode:undefined,...extra};
        result.cases.push({id:`auto/${entry.setCode}/upgrade-return-${name}`,name:'upgrade-return-'+name,kind:'probe',focusCardIds:[entry.setCode],setupCardIds:[...new Set([...targets.map(t=>t.code),...targets.flatMap(t=>(t.attachments??[]).map(a=>a.code)),...[spec.baseCode,spec.enemyBaseCode].filter(Boolean)])].sort(),behaviorIds:['upgrade-return'],assertionStages:['construction','activation','observation'],coverageObligationIds:[oid],probe:spec});
    }
    if(shape.conditional&&(!matchingBase||!other)){obligation('base-traits','Missing plain matching/nonmatching base trait metadata');return result;}
    if(shape.discard){
        add('own-discard',[{code:low.upgrade.setCode,owner:'self',zone:'discard'}, {code:low.upgrade.setCode,owner:'opponent',zone:'discard'},attached(low)],{chosenStandalone:0,expectedReturn:true});
        add('enemy-discard-excluded',[{code:low.upgrade.setCode,owner:'opponent',zone:'discard'},attached(low)],{noEligible:true,expectedReturn:false});
    }else{
        for(const owner of ['self','opponent'])add('ordinary-'+owner,[attached(low,owner),...(high?[attached(high,owner)]:[])],{chosenAttachment:{target:0,index:0},expectedReturn:true});
        const spaceHost=quiet.find(h=>h.card.arena==='space'&&metadataAttach(low.upgrade.attachCondition,h.card)===true);if(spaceHost)add('ordinary-space',[target(spaceHost,'self',[{code:low.upgrade.setCode}])],{chosenAttachment:{target:0,index:0},expectedReturn:true});else obligation('space-upgrade-target','No legal quiet space host');
        add('own-upgrade-enemy-host',[attached(low,'opponent','self')],{chosenAttachment:{target:0,index:0},expectedReturn:true});
        if(high)add('above-only',[attached(high)],shape.sourceUpgrade?{chosenSource:true,expectedReturn:true}:{noEligible:true,expectedReturn:false});else if(shape.threshold!==null)obligation('above-threshold','No legal upgrade at threshold+1');
        for(const name of ['shield','experience']){const t=token([name]);if(t)add(name,[target(low.host,'self',[{code:t.setCode,token:t.internalName},{code:low.upgrade.setCode}])],{chosenAttachment:{target:0,index:0},expectedReturn:true});else obligation(name,'Missing actual token metadata');}
        if(shape.nonUnique&&unique)add('unique-excluded',[attached(unique),attached(low)],{chosenAttachment:{target:1,index:0},expectedReturn:true});else if(shape.nonUnique)obligation('unique-excluded','No legal unique upgrade donor');
        const donors=defs.filter(e=>e.status==='supported'&&e.card.types.includes('unit')&&!e.card.types.includes('leader')&&Object.values(e.abilities??{}).flat().length===1&&e.abilities.card[0]?.trigger==='whenDefeated'&&!e.abilities.card[0].optional&&JSON.stringify(e.abilities.card[0].effect)==='{"kind":"draw","target":"ownPlayer","amount":{"kind":"const","value":1}}');
        const lethal=pair(e=>!e.card.unique&&e.card.upgradeHp>0&&(shape.threshold===null||e.card.cost<=shape.threshold),donors);
        if(lethal)add('hp-removal-host-death',[{...attached(lethal),attachments:[{code:lethal.upgrade.setCode},...['shield','experience'].map(name=>({code:token([name]).setCode,token:name}))],damage:lethal.host.card.hp+lethal.upgrade.card.upgradeHp}],{chosenAttachment:{target:0,index:0},sourceDamage:undefined,initialHostDamage:lethal.host.card.hp+lethal.upgrade.card.upgradeHp-1,expectedReturn:true,expectedHostDeath:true,expectedDeathDraw:1});else obligation('hp-removal-host-death','No legal positive-HP ordinary upgrade and mandatory death-draw host');
        if(shape.conditional){add('base-trait-false',[attached(low)],{baseCode:other.setCode,enemyBaseCode:matchingBase.setCode,expectedReturn:false});add('base-trait-true-enemy-false',[attached(low)],{baseCode:matchingBase.setCode,enemyBaseCode:other.setCode,chosenAttachment:{target:0,index:0},expectedReturn:true});}
        if(shape.sourceUpgrade)add('return-source-itself',[target(low.host)],{chosenSource:true,expectedReturn:true});
    }
    add('decline',[shape.discard?{code:low.upgrade.setCode,owner:'self',zone:'discard'}:attached(low)],{decline:true,expectedReturn:false});
    if(!shape.sourceUpgrade)add('no-eligible',[target(low.host)],{noEligible:true,expectedReturn:false});else obligation('no-eligible','Played source upgrade itself is eligible; no no-eligible construction for this family');
    for(const dimension of ['arbitrary-upgrade-control','departure-observers','keyword-aura-host-death','unique-source-attachment-replacement'])obligation(dimension,'No automatic '+dimension+' construction; foreign control and departure observer scope have baseline runtime guards; keyword/aura death and unique replacement are unexercised admitted interactions');
    return result;
}
module.exports={classifyUpgradeReturn,planUpgradeReturnProbes,metadataAttach};
